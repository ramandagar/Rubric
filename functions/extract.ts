// extract — grounded frame extraction (passive capture, ARCHITECTURE.md §5).
// Reads unextracted raw_traces for a context object and distills each into one Frame
// via the AI gateway. The model is constrained to ground every epistemic item in an
// actual span event; anything it infers is flagged grounded:false with a confidence.
import { createClient, createAdminClient } from 'npm:@insforge/sdk';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-rubric-key',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const MODEL = Deno.env.get('RUBRIC_EXTRACT_MODEL') ?? 'openai/gpt-4o-mini';

const SYSTEM = `You convert a raw agent execution trace into a structured EPISTEMIC FRAME.
The frame captures what this agent KNEW, TRIED, DOUBTED, and DECIDED so the next agent in the
pipeline is not blind to its reasoning.

HARD RULES:
- Ground every item in the actual trace. For each item set "trace_span" to the span/event it came from.
- If an item is your inference (not directly in the trace), set "grounded": false and a "confidence" 0..1.
  Items clearly present in the trace get "grounded": true.
- Never invent decisions, tools, or sources that are not in the trace.
- "attempts" must include approaches the agent tried AND DROPPED (kept:false) when the trace shows them.
- "handoff_note" is the compact briefing for the NEXT agent: what to watch for, open threads.
- Output STRICT JSON only, matching the requested schema. No prose.`;

function buildUserPrompt(task: unknown, source: string, payload: unknown) {
  return `TASK (the overall goal this pipeline serves):
${JSON.stringify(task)}

TRACE SOURCE: ${source}
RAW TRACE (this agent's execution):
${JSON.stringify(payload).slice(0, 24000)}

Return JSON with this exact shape:
{
  "agent": { "id": string, "role": string, "model": string|null },
  "interpretation": { "restated_goal": string, "scope_in": string[], "scope_out": string[] },
  "attempts": [ { "approach": string, "outcome": string, "kept": boolean, "reason_dropped": string|null, "trace_span": string, "grounded": boolean, "confidence": number } ],
  "decisions": [ { "decision": string, "rationale": string, "alternatives_rejected": [ { "option": string, "why_not": string } ], "trace_span": string, "grounded": boolean, "confidence": number } ],
  "assumptions": [ { "statement": string, "basis": string, "confidence": number, "grounded": boolean, "trace_span": string } ],
  "uncertainties": [ { "question": string, "impact": "high"|"med"|"low", "confidence": number, "blocking": boolean, "trace_span": string } ],
  "evidence": [ { "claim": string, "source": string, "strength": "strong"|"weak", "trace_span": string } ],
  "excluded": [ { "what": string, "why": string, "trace_span": string } ],
  "handoff_note": { "for_next_agent": string, "watch_out_for": string[], "open_threads": string[] },
  "output": { "summary": string, "format": string }
}`;
}

async function callModel(task: unknown, source: string, payload: unknown) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RUBRIC_OPENROUTER_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildUserPrompt(task, source, payload) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content ?? '{}';
  return { frame: JSON.parse(content), usage: data.usage ?? {} };
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createAdminClient({ baseUrl: Deno.env.get('RUBRIC_BASE_URL'), apiKey: Deno.env.get('RUBRIC_ADMIN_KEY') });

  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty */ }

  // Auth: ingest key (x-rubric-key) OR user JWT. Owner is always enforced on the context object.
  let ownerFilter: string | null = null;
  const presentedKey = req.headers.get('x-rubric-key');
  if (presentedKey) {
    const keyHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(presentedKey)))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    const { data: keys } = await admin.database.from('api_keys').select('owner_id, revoked').eq('key_hash', keyHash).limit(1);
    if (!keys?.[0] || keys[0].revoked) return json({ error: 'invalid_key' }, 401);
    ownerFilter = keys[0].owner_id;
  } else {
    const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? null;
    if (token) {
      const c = createClient({ baseUrl: Deno.env.get('RUBRIC_BASE_URL'), edgeFunctionToken: token });
      const { data } = await c.auth.getCurrentUser();
      ownerFilter = data?.user?.id ?? null;
    }
  }
  if (!ownerFilter) return json({ error: 'unauthorized' }, 401);

  const contextObjectId = body.context_object_id;
  if (!contextObjectId) return json({ error: 'missing_context_object_id' }, 400);

  // Load the context object (its task drives extraction). Ownership always enforced.
  const { data: cos } = await admin.database
    .from('context_objects').select('id, owner_id, task, lineage')
    .eq('id', contextObjectId).eq('owner_id', ownerFilter).limit(1);
  const co = cos?.[0];
  if (!co) return json({ error: 'context_object_not_found' }, 404);

  // Pending traces, in arrival order.
  const { data: traces } = await admin.database
    .from('raw_traces').select('id, source, payload')
    .eq('context_object_id', contextObjectId).eq('extracted', false)
    .order('ingested_at', { ascending: true });
  if (!traces?.length) return json({ status: 'nothing_to_extract', frames_created: 0 }, 200);

  // Determine starting seq.
  const { data: maxRow } = await admin.database
    .from('frames').select('seq').eq('context_object_id', contextObjectId).order('seq', { ascending: false }).limit(1);
  let seq = (maxRow?.[0]?.seq ?? -1) + 1;

  const createdFrameIds: string[] = [];
  for (const t of traces) {
    let extracted, usage;
    try {
      ({ frame: extracted, usage } = await callModel(co.task, t.source, t.payload));
    } catch (e) {
      return json({ error: 'extraction_failed', detail: String(e), frames_created: createdFrameIds.length }, 502);
    }

    const fromFrame = createdFrameIds.length ? createdFrameIds[createdFrameIds.length - 1]
      : (co.lineage?.length ? co.lineage[co.lineage.length - 1] : null);

    const { data: inserted, error: insErr } = await admin.database.from('frames').insert([{
      owner_id: co.owner_id,
      context_object_id: contextObjectId,
      seq: seq++,
      agent: extracted.agent ?? {},
      received: { from_frame: fromFrame },
      interpretation: extracted.interpretation ?? {},
      attempts: extracted.attempts ?? [],
      decisions: extracted.decisions ?? [],
      assumptions: extracted.assumptions ?? [],
      uncertainties: extracted.uncertainties ?? [],
      evidence: extracted.evidence ?? [],
      excluded: extracted.excluded ?? [],
      output: extracted.output ?? {},
      handoff_note: extracted.handoff_note ?? {},
      provenance: { capture_mode: 'passive', source: t.source, extractor_model: MODEL, raw_trace_id: t.id },
      meta: { tokens: usage?.total_tokens ?? null, timestamp: new Date().toISOString() },
    }]).select('id');

    if (insErr || !inserted?.[0]) {
      return json({ error: 'frame_insert_failed', detail: insErr, frames_created: createdFrameIds.length }, 500);
    }
    createdFrameIds.push(inserted[0].id);
    await admin.database.from('raw_traces').update({ extracted: true }).eq('id', t.id);

    // Generate embeddings for epistemic items (best-effort).
    await embedFrameItems(admin, co.owner_id, inserted[0].id, contextObjectId, seq - 1, extracted);
  }

  // Update the context object's lineage chain and current holder.
  const newLineage = [...(co.lineage ?? []), ...createdFrameIds];
  const lastFrameId = createdFrameIds[createdFrameIds.length - 1];
  const lastAgent = createdFrameIds.length ? traces[traces.length - 1]?.payload?.[0]?.role ?? null : null;
  await admin.database.from('context_objects').update({
    lineage: newLineage,
    current_holder: lastAgent,
    updated_at: new Date().toISOString(),
  }).eq('id', contextObjectId);

  return json({ status: 'extracted', frames_created: createdFrameIds.length, frame_ids: createdFrameIds }, 200);
}

async function embedFrameItems(
  admin: any, owner: string, frameId: string, coId: string, seq: number, frame: any,
) {
  const EMBED_MODEL = Deno.env.get('RUBRIC_EMBED_MODEL') ?? 'openai/text-embedding-3-small';
  const items: { type: string; text: string; metadata: any }[] = [];
  for (const a of (frame.assumptions ?? [])) items.push({ type: 'assumption', text: a.statement, metadata: a });
  for (const u of (frame.uncertainties ?? [])) items.push({ type: 'uncertainty', text: u.question, metadata: u });
  for (const d of (frame.decisions ?? [])) items.push({ type: 'decision', text: d.decision, metadata: d });
  for (const e of (frame.excluded ?? [])) items.push({ type: 'excluded', text: e.what, metadata: e });
  for (const ev of (frame.evidence ?? [])) items.push({ type: 'evidence', text: ev.claim, metadata: ev });
  for (const at of (frame.attempts ?? [])) items.push({ type: 'attempt', text: at.approach, metadata: at });

  if (!items.length) return;

  try {
    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${Deno.env.get('RUBRIC_OPENROUTER_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: items.map((i) => i.text) }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const embeddings: number[][] = data.data?.map((d: any) => d.embedding) ?? [];
    if (!embeddings.length) return;

    const rows = items.map((item, idx) => ({
      owner_id: owner, frame_id: frameId, co_id: coId, seq,
      item_type: item.type, text: item.text, metadata: item.metadata,
      embedding: `[${embeddings[idx]?.join(',') ?? ''}]`,
    }));

    for (const row of rows) {
      if (!row.embedding || row.embedding === '[]') continue;
      await admin.database.raw(
        `insert into public.epistemic_items (owner_id, frame_id, co_id, seq, item_type, text, metadata, embedding) values ($1,$2,$3,$4,$5,$6,$7,$8::vector)`,
        [row.owner_id, row.frame_id, row.co_id, row.seq, row.item_type, row.text, JSON.stringify(row.metadata), row.embedding],
      );
    }

    const avgEmbedding = embeddings[0].map((_, dim) => {
      const sum = embeddings.reduce((a, e) => a + (e[dim] ?? 0), 0);
      return sum / embeddings.length;
    });
    await admin.database.raw(
      `update public.frames set embedding = $1::vector where id = $2`,
      [`[${avgEmbedding.join(',')}]`, frameId],
    );
  } catch { /* best-effort */ }
}
