// get-handoff — consumption endpoint (ARCHITECTURE.md §6).
// Returns the compact, ready-to-inject handoff context for the NEXT agent, plus the full
// audit view for the dashboard: lineage, latest handoff_note, a relevance-ranked epistemic
// digest, scores, and the dropped-context warnings. One call renders the whole picture.
import { createClient, createAdminClient } from 'npm:@insforge/sdk';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// Rank epistemic items by importance: high-impact + low-confidence + still-open float to the top.
function rankUncertainties(frames: any[]): any[] {
  const wImpact: Record<string, number> = { high: 3, med: 2, low: 1 };
  const all: any[] = [];
  for (const f of frames) for (const u of (f.uncertainties ?? []))
    all.push({ ...u, from_role: f.agent?.role, seq: f.seq, _w: (wImpact[u.impact] ?? 1) * (1 - (u.confidence ?? 0.5)) + (u.blocking ? 1 : 0) });
  return all.sort((a, b) => b._w - a._w).slice(0, 8).map(({ _w, ...rest }) => rest);
}
function topAssumptions(frames: any[]): any[] {
  const all: any[] = [];
  for (const f of frames) for (const a of (f.assumptions ?? []))
    all.push({ ...a, from_role: f.agent?.role, seq: f.seq, _w: (1 - (a.confidence ?? 0.5)) + (a.grounded === false ? 0.5 : 0) });
  return all.sort((a, b) => b._w - a._w).slice(0, 8).map(({ _w, ...rest }) => rest);
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const admin = createAdminClient({ baseUrl: Deno.env.get('RUBRIC_BASE_URL'), apiKey: Deno.env.get('RUBRIC_ADMIN_KEY') });
  const owner = await resolveOwner(req, admin);
  if (!owner) return json({ error: 'unauthorized' }, 401);

  // Accept context_object_id from query (GET) or body (POST).
  let coId: string | undefined;
  if (req.method === 'POST') { try { coId = (await req.json())?.context_object_id; } catch { /* */ } }
  if (!coId) coId = new URL(req.url).searchParams.get('context_object_id') ?? undefined;
  if (!coId) return json({ error: 'missing_context_object_id' }, 400);

  const { data: cos } = await admin.database
    .from('context_objects').select('*').eq('id', coId).eq('owner_id', owner).limit(1);
  const co = cos?.[0];
  if (!co) return json({ error: 'context_object_not_found' }, 404);

  const { data: frames } = await admin.database
    .from('frames').select('*').eq('context_object_id', coId).order('seq', { ascending: true });
  const { data: scores } = await admin.database
    .from('scores').select('*').eq('owner_id', owner).in('frame_id', (frames ?? []).map((f: any) => f.id));

  const scoreByFrame: Record<string, any> = {};
  for (const s of (scores ?? [])) scoreByFrame[s.frame_id] = s;

  const latest = frames?.length ? frames[frames.length - 1] : null;

  // All dropped-context warnings across the pipeline (the audit headline).
  const droppedWarnings: any[] = [];
  for (const f of (frames ?? [])) {
    const s = scoreByFrame[f.id];
    for (const d of (s?.details?.dropped ?? [])) droppedWarnings.push({ at_seq: f.seq, into_role: f.agent?.role, ...d });
  }

  const pipelineHealth = scores?.length
    ? Math.round((scores.reduce((a: number, s: any) => a + Number(s.health_score ?? 0), 0) / scores.length) * 100) / 100
    : null;

  return json({
    context_object: { id: co.id, task: co.task, status: co.status, spec_version: co.spec_version, created_at: co.created_at },
    pipeline_health: pipelineHealth,
    // COMPACT payload — what the next agent should actually inject:
    handoff: latest ? {
      from_role: latest.agent?.role,
      note: latest.handoff_note,
      open_questions: rankUncertainties(frames ?? []),
      key_assumptions: topAssumptions(frames ?? []),
    } : null,
    // AUDIT view — the differentiator:
    dropped_context: droppedWarnings,
    // FULL lineage for the dashboard:
    frames: (frames ?? []).map((f: any) => ({
      id: f.id, seq: f.seq, agent: f.agent, interpretation: f.interpretation,
      attempts: f.attempts, decisions: f.decisions, assumptions: f.assumptions,
      uncertainties: f.uncertainties, evidence: f.evidence, excluded: f.excluded,
      output: f.output, handoff_note: f.handoff_note, provenance: f.provenance,
      score: scoreByFrame[f.id] ? {
        health_score: scoreByFrame[f.id].health_score,
        dimensions: scoreByFrame[f.id].dimensions,
        details: scoreByFrame[f.id].details,
      } : null,
    })),
  }, 200);
}
