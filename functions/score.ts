// score — the Rubric scoring engine (the differentiator, ARCHITECTURE.md §7).
// Scores every frame in a context object across five dimensions and computes a
// Handoff Health Score. The headline feature is DROP-DETECTION: for each handoff it
// lists which assumptions / uncertainties / open-threads from the prior agent were
// silently dropped by the next one — the thing general observability tools don't show.
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

const MODEL = Deno.env.get('RUBRIC_SCORE_MODEL') ?? 'openai/gpt-4o-mini';

async function resolveOwner(req: Request, admin: any): Promise<string | null> {
  const key = req.headers.get('x-rubric-key');
  if (key) {
    const { data } = await admin.database.from('api_keys').select('owner_id, revoked').eq('key_hash', await sha256(key)).limit(1);
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

// Deterministic grounding score: fraction of epistemic items provably grounded in a trace span.
function groundingScore(frame: any): { score: number; total: number; grounded: number } {
  const items = [
    ...(frame.assumptions ?? []),
    ...(frame.decisions ?? []),
    ...(frame.attempts ?? []),
    ...(frame.evidence ?? []),
  ];
  const total = items.length;
  if (!total) return { score: 100, total: 0, grounded: 0 };
  const grounded = items.filter((i: any) => i.grounded === true || (i.trace_span && i.grounded !== false)).length;
  return { score: Math.round((grounded / total) * 100), total, grounded };
}

const JUDGE_SYSTEM = `You are a rigorous auditor of multi-agent AI handoffs. You score how well one agent's
reasoning was captured and carried forward. Be strict and evidence-based. Output STRICT JSON only.`;

function judgePrompt(task: any, prior: any, current: any) {
  const priorBlock = prior ? `PRIOR AGENT FRAME (what it knew/assumed/decided/flagged):
${JSON.stringify({
    role: prior.agent?.role, decisions: prior.decisions, assumptions: prior.assumptions,
    uncertainties: prior.uncertainties, handoff_note: prior.handoff_note,
  }).slice(0, 8000)}` : 'PRIOR AGENT FRAME: none (this is the first agent).';

  return `TASK: ${JSON.stringify(task).slice(0, 1500)}

${priorBlock}

CURRENT AGENT FRAME (being scored):
${JSON.stringify({
    role: current.agent?.role, interpretation: current.interpretation, attempts: current.attempts,
    decisions: current.decisions, assumptions: current.assumptions, uncertainties: current.uncertainties,
    excluded: current.excluded, output: current.output, handoff_note: current.handoff_note,
  }).slice(0, 9000)}

Score 0-100 (100 = best). For continuity & information_loss, higher = LESS was lost.
If there is no prior frame, set continuity and information_loss to null.

DROP-DETECTION is the priority: list every assumption, blocking uncertainty, or open_thread the PRIOR agent
surfaced that the CURRENT agent did NOT address, carry forward, or resolve. These are silent context drops.

Return JSON:
{
  "completeness":     { "score": number, "reason": string },
  "faithfulness":     { "score": number, "reason": string },
  "continuity":       { "score": number|null, "reason": string },
  "information_loss": { "score": number|null, "reason": string },
  "dropped": [ { "type": "assumption"|"uncertainty"|"open_thread", "item": string, "severity": "high"|"med"|"low" } ]
}`;
}

async function judge(task: any, prior: any, current: any) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${Deno.env.get('RUBRIC_OPENROUTER_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, temperature: 0.1, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: JUDGE_SYSTEM }, { role: 'user', content: judgePrompt(task, prior, current) }],
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
}

// Weighted composite. Dimensions that don't apply (first frame) are dropped and weights renormalized.
function composite(d: Record<string, number | null>): number {
  const w: Record<string, number> = { completeness: 0.2, faithfulness: 0.25, continuity: 0.2, information_loss: 0.2, grounding: 0.15 };
  let num = 0, den = 0;
  for (const k of Object.keys(w)) {
    const v = d[k];
    if (typeof v === 'number') { num += v * w[k]; den += w[k]; }
  }
  return den ? Math.round((num / den) * 100) / 100 : 0;
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

  const { data: cos } = await admin.database
    .from('context_objects').select('id, owner_id, task').eq('id', coId).eq('owner_id', owner).limit(1);
  const co = cos?.[0];
  if (!co) return json({ error: 'context_object_not_found' }, 404);

  const { data: frames } = await admin.database
    .from('frames').select('*').eq('context_object_id', coId).order('seq', { ascending: true });
  if (!frames?.length) return json({ status: 'no_frames', scored: 0 }, 200);

  const results: any[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const prior = i > 0 ? frames[i - 1] : null;
    const g = groundingScore(frame);

    let j: any = {};
    try { j = await judge(co.task, prior, frame); } catch (e) {
      return json({ error: 'judge_failed', detail: String(e), scored: results.length }, 502);
    }

    const dims = {
      completeness: j.completeness?.score ?? null,
      faithfulness: j.faithfulness?.score ?? null,
      continuity: j.continuity?.score ?? null,
      information_loss: j.information_loss?.score ?? null,
      grounding: g.score,
    };
    const health = composite(dims);

    // Re-scoring is idempotent: clear prior scores for this frame.
    await admin.database.from('scores').delete().eq('frame_id', frame.id);
    const { data: ins } = await admin.database.from('scores').insert([{
      owner_id: owner,
      frame_id: frame.id,
      dimensions: dims,
      health_score: health,
      details: {
        seq: frame.seq,
        role: frame.agent?.role,
        grounding: g,
        dropped: j.dropped ?? [],
        reasons: {
          completeness: j.completeness?.reason,
          faithfulness: j.faithfulness?.reason,
          continuity: j.continuity?.reason,
          information_loss: j.information_loss?.reason,
        },
      },
    }]).select('id');

    results.push({ frame_id: frame.id, seq: frame.seq, health_score: health, dropped: (j.dropped ?? []).length, score_id: ins?.[0]?.id });
  }

  const avg = Math.round((results.reduce((a, r) => a + r.health_score, 0) / results.length) * 100) / 100;
  const totalDropped = results.reduce((a, r) => a + r.dropped, 0);
  return json({ status: 'scored', scored: results.length, pipeline_health: avg, total_dropped_items: totalDropped, frames: results }, 200);
}
