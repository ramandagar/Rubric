// process — full pipeline orchestration: ingest → extract → score in a single call.
// Powers the "Load demo pipeline" flow and SDK convenience method.
// Each stage is idempotent — reprocessing just rescans for unprocessed items.
import { createClient, createAdminClient } from 'npm:@insforge/sdk';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-rubric-key',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const sha256 = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

async function resolveOwner(req: Request, admin: any): Promise<string | null> {
  const key = req.headers.get('x-rubric-key');
  if (key) {
    const { data } = await admin.database.from('api_keys').select('owner_id, revoked')
      .eq('key_hash', await sha256(key)).limit(1);
    return data?.[0] && !data[0].revoked ? data[0].owner_id : null;
  }
  const token = req.headers.get('Authorization')?.replace('Bearer ', '') ?? null;
  if (token) {
    const c = createClient({ baseUrl: Deno.env.get('RUBRIC_BASE_URL'), edgeFunctionToken: token });
    const { data } = await c.auth.getCurrentUser();
    return data?.user?.id ?? null;
  }
  return null;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createAdminClient({ baseUrl: Deno.env.get('RUBRIC_BASE_URL'), apiKey: Deno.env.get('RUBRIC_ADMIN_KEY') });
  const owner = await resolveOwner(req, admin);
  if (!owner) return json({ error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* */ }
  const coId = body.context_object_id;
  if (!coId) return json({ error: 'missing_context_object_id' }, 400);

  // Verify ownership
  const { data: cos } = await admin.database
    .from('context_objects').select('id, task').eq('id', coId).eq('owner_id', owner).limit(1);
  if (!cos?.[0]) return json({ error: 'context_object_not_found' }, 404);

  const stages: { stage: string; status: string; detail?: string }[] = [];
  const EMBED_MODEL = Deno.env.get('RUBRIC_EMBED_MODEL') ?? 'openai/text-embedding-3-small';

  // Stage 1: Extract — process unextracted raw traces.
  const { data: traces } = await admin.database
    .from('raw_traces').select('id, source, payload')
    .eq('context_object_id', coId).eq('extracted', false)
    .order('ingested_at', { ascending: true });

  let extracted = 0;
  let frames: any[] = [];

  if (traces?.length) {
    const EXTRACT_MODEL = Deno.env.get('RUBRIC_EXTRACT_MODEL') ?? 'openai/gpt-4o-mini';

    const { data: maxRow } = await admin.database
      .from('frames').select('seq').eq('context_object_id', coId).order('seq', { ascending: false }).limit(1);
    let seq = (maxRow?.[0]?.seq ?? -1) + 1;

    for (const t of traces) {
      const prompt = buildExtractPrompt(cos[0].task, t.source, t.payload);
      let frame: any, usage: any;
      try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${Deno.env.get('RUBRIC_OPENROUTER_KEY')}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: EXTRACT_MODEL, temperature: 0.1, response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: SYSTEM_EXTRACT },
              { role: 'user', content: prompt },
            ],
          }),
        });
        if (!res.ok) throw new Error(`extract ${res.status}`);
        const data = await res.json();
        frame = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
        usage = data.usage ?? {};
      } catch (e) {
        stages.push({ stage: 'extract', status: 'failed', detail: String(e) });
        return json({ stages, error: 'extraction_failed', detail: String(e) }, 502);
      }

      const fromFrame = frames.length ? frames[frames.length - 1].id
        : (cos[0].lineage?.length ? cos[0].lineage[cos[0].lineage.length - 1] : null);

      const { data: inserted, error: insErr } = await admin.database.from('frames').insert([{
        owner_id: owner,
        context_object_id: coId,
        seq: seq++,
        agent: frame.agent ?? {},
        received: { from_frame: fromFrame },
        interpretation: frame.interpretation ?? {},
        attempts: frame.attempts ?? [],
        decisions: frame.decisions ?? [],
        assumptions: frame.assumptions ?? [],
        uncertainties: frame.uncertainties ?? [],
        evidence: frame.evidence ?? [],
        excluded: frame.excluded ?? [],
        output: frame.output ?? {},
        handoff_note: frame.handoff_note ?? {},
        provenance: { capture_mode: 'passive', source: t.source, extractor_model: EXTRACT_MODEL, raw_trace_id: t.id },
        meta: { tokens: usage?.total_tokens ?? null, timestamp: new Date().toISOString() },
      }]).select('id');
      if (insErr || !inserted?.[0]) {
        stages.push({ stage: 'extract', status: 'failed', detail: String(insErr) });
        return json({ stages, error: 'frame_insert_failed' }, 500);
      }

      const frameId = inserted[0].id;
      frames.push({ id: frameId, ...frame });
      extracted++;

      // Generate embeddings for epistemic items
      await embedAndInsertItems(admin, owner, frameId, coId, seq - 1, frame, EMBED_MODEL);

      await admin.database.from('raw_traces').update({ extracted: true }).eq('id', t.id);
    }

    const newLineage = [...(cos[0].lineage ?? []), ...frames.map((f: any) => f.id)];
    await admin.database.from('context_objects').update({ lineage: newLineage }).eq('id', coId);
    stages.push({ stage: 'extract', status: 'ok', detail: `${extracted} frames` });
  } else {
    // Reload existing frames for scoring
    const { data: existing } = await admin.database
      .from('frames').select('*').eq('context_object_id', coId).order('seq', { ascending: true });
    frames = existing ?? [];
    stages.push({ stage: 'extract', status: 'skipped', detail: 'nothing to extract' });
  }

  if (!frames.length) return json({ stages, context_object_id: coId, pipeline_health: null }, 200);

  // Stage 2: Score every frame
  const SCORE_MODEL = Deno.env.get('RUBRIC_SCORE_MODEL') ?? 'openai/gpt-4o-mini';
  let scored = 0;
  const allHealths: number[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const prior = i > 0 ? frames[i - 1] : null;

    const g = groundingScore(frame);
    let judgeResult: any = {};
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${Deno.env.get('RUBRIC_OPENROUTER_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: SCORE_MODEL, temperature: 0.1, response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_JUDGE },
            { role: 'user', content: buildJudgePrompt(cos[0].task, prior, frame) },
          ],
        }),
      });
      if (!res.ok) throw new Error(`judge ${res.status}`);
      const data = await res.json();
      judgeResult = JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
    } catch (e) {
      stages.push({ stage: 'score', status: 'failed', detail: String(e) });
      return json({ stages, error: 'scoring_failed' }, 502);
    }

    const dims = {
      completeness: judgeResult.completeness?.score ?? null,
      faithfulness: judgeResult.faithfulness?.score ?? null,
      continuity: judgeResult.continuity?.score ?? null,
      information_loss: judgeResult.information_loss?.score ?? null,
      grounding: g.score,
    };
    const health = composite(dims);
    allHealths.push(health);

    await admin.database.from('scores').delete().eq('frame_id', frame.id);
    await admin.database.from('scores').insert([{
      owner_id: owner,
      frame_id: frame.id,
      dimensions: dims,
      health_score: health,
      details: {
        seq: i,
        role: frame.agent?.role,
        grounding: g,
        dropped: judgeResult.dropped ?? [],
        reasons: {
          completeness: judgeResult.completeness?.reason,
          faithfulness: judgeResult.faithfulness?.reason,
          continuity: judgeResult.continuity?.reason,
          information_loss: judgeResult.information_loss?.reason,
        },
      },
    }]);

    scored++;
  }

  stages.push({ stage: 'score', status: 'ok', detail: `${scored} frames scored` });

  const pipelineHealth = allHealths.length
    ? Math.round((allHealths.reduce((a, b) => a + b, 0) / allHealths.length) * 100) / 100
    : null;

  return json({ stages, context_object_id: coId, pipeline_health: pipelineHealth, frames_processed: frames.length }, 200);
}

// ---- Shared helpers (same logic as extract.ts and score.ts) ----

const SYSTEM_EXTRACT = `You convert a raw agent execution trace into a structured EPISTEMIC FRAME.
The frame captures what this agent KNEW, TRIED, DOUBTED, and DECIDED so the next agent in the
pipeline is not blind to its reasoning.

HARD RULES:
- Ground every item in the actual trace. For each item set "trace_span" to the span/event it came from.
- If an item is your inference (not directly in the trace), set "grounded": false and a "confidence" 0..1.
- Never invent decisions, tools, or sources that are not in the trace.
- "attempts" must include approaches the agent tried AND DROPPED (kept:false) when the trace shows them.
- "handoff_note" is the compact briefing for the NEXT agent.
- Output STRICT JSON only.`;

function buildExtractPrompt(task: any, source: string, payload: any) {
  return `TASK:\n${JSON.stringify(task)}\n\nSOURCE: ${source}\nRAW TRACE:\n${JSON.stringify(payload).slice(0, 24000)}\n\nReturn JSON with this shape:\n{"agent":{"id":string,"role":string,"model":string|null},"interpretation":{"restated_goal":string,"scope_in":[],"scope_out":[]},"attempts":[{"approach":string,"outcome":string,"kept":boolean,"reason_dropped":string|null,"trace_span":string,"grounded":boolean,"confidence":number}],"decisions":[{"decision":string,"rationale":string,"alternatives_rejected":[{"option":string,"why_not":string}],"trace_span":string,"grounded":boolean,"confidence":number}],"assumptions":[{"statement":string,"basis":string,"confidence":number,"grounded":boolean,"trace_span":string}],"uncertainties":[{"question":string,"impact":"high"|"med"|"low","confidence":number,"blocking":boolean,"trace_span":string}],"evidence":[{"claim":string,"source":string,"strength":"strong"|"weak","trace_span":string}],"excluded":[{"what":string,"why":string,"trace_span":string}],"handoff_note":{"for_next_agent":string,"watch_out_for":[],"open_threads":[]},"output":{"summary":string,"format":string}}`;
}

const SYSTEM_JUDGE = `You are a rigorous auditor of multi-agent AI handoffs. Score how well one agent's reasoning was captured and carried forward. Be strict and evidence-based. Output STRICT JSON only.`;

function buildJudgePrompt(task: any, prior: any, current: any) {
  const priorBlock = prior ? `PRIOR AGENT FRAME:\n${JSON.stringify({
    role: prior.agent?.role, decisions: prior.decisions, assumptions: prior.assumptions,
    uncertainties: prior.uncertainties, handoff_note: prior.handoff_note,
  }).slice(0, 8000)}` : 'PRIOR: none (first agent).';

  return `TASK: ${JSON.stringify(task).slice(0, 1500)}\n\n${priorBlock}\n\nCURRENT FRAME:\n${JSON.stringify({
    role: current.agent?.role, interpretation: current.interpretation, attempts: current.attempts,
    decisions: current.decisions, assumptions: current.assumptions, uncertainties: current.uncertainties,
    excluded: current.excluded, output: current.output, handoff_note: current.handoff_note,
  }).slice(0, 9000)}\n\nScore 0-100 each. Higher = better for all. No prior? Set continuity and information_loss to null. List every dropped assumption/uncertainty/open_thread.\n\nReturn: {"completeness":{"score":number,"reason":string},"faithfulness":{"score":number,"reason":string},"continuity":{"score":number|null,"reason":string},"information_loss":{"score":number|null,"reason":string},"dropped":[{"type":"assumption"|"uncertainty"|"open_thread","item":string,"severity":"high"|"med"|"low"}]}`;
}

function groundingScore(frame: any) {
  const items = [
    ...(frame.assumptions ?? []), ...(frame.decisions ?? []),
    ...(frame.attempts ?? []), ...(frame.evidence ?? []),
  ];
  if (!items.length) return { score: 100, total: 0, grounded: 0 };
  const grounded = items.filter((i: any) => i.grounded === true || (i.trace_span && i.grounded !== false)).length;
  return { score: Math.round((grounded / items.length) * 100), total: items.length, grounded };
}

function composite(d: Record<string, number | null>): number {
  const w: Record<string, number> = { completeness: 0.2, faithfulness: 0.25, continuity: 0.2, information_loss: 0.2, grounding: 0.15 };
  let num = 0, den = 0;
  for (const k of Object.keys(w)) {
    if (typeof d[k] === 'number') { num += d[k] * w[k]; den += w[k]; }
  }
  return den ? Math.round((num / den) * 100) / 100 : 0;
}

async function embedAndInsertItems(
  admin: any, owner: string, frameId: string, coId: string, seq: number,
  frame: any, model: string,
) {
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
      body: JSON.stringify({ model, input: items.map((i) => i.text) }),
    });
    if (!res.ok) return;
    const data = await res.json();
    const embeddings: number[][] = data.data?.map((d: any) => d.embedding) ?? [];
    if (!embeddings.length) return;

    const rows = items.map((item, idx) => ({
      owner_id: owner,
      frame_id: frameId,
      co_id: coId,
      seq,
      item_type: item.type,
      text: item.text,
      metadata: item.metadata,
      embedding: `[${embeddings[idx]?.join(',') ?? ''}]`,
    }));

    for (const row of rows) {
      if (!row.embedding || row.embedding === '[]') continue;
      const vectorParam = row.embedding;
      await admin.database.raw(
        `insert into public.epistemic_items (owner_id, frame_id, co_id, seq, item_type, text, metadata, embedding) values ($1,$2,$3,$4,$5,$6,$7,$8::vector)`,
        [row.owner_id, row.frame_id, row.co_id, row.seq, row.item_type, row.text, JSON.stringify(row.metadata), vectorParam],
      );
    }

    // Generate frame-level embedding (average of item embeddings).
    const avgEmbedding = embeddings[0].map((_, dim) => {
      const sum = embeddings.reduce((a, e) => a + (e[dim] ?? 0), 0);
      return sum / embeddings.length;
    });
    const avgVec = `[${avgEmbedding.join(',')}]`;
    await admin.database.raw(
      `update public.frames set embedding = $1::vector where id = $2`,
      [avgVec, frameId],
    );
  } catch {
    // Embedding generation is best-effort — frames are still valid without embeddings.
  }
}
