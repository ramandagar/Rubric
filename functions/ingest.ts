// ingest — passive trace ingestion. Authenticated by a Rubric SDK key (x-rubric-key header).
// Accepts raw trace spans, attaches them to a context object (creating one if needed),
// and stores them for the extractor to process. Capture is out-of-band: no agent latency.
// Includes per-key rate limiting (configurable via env, defaults to 60 req/min per key).
import { createAdminClient } from 'npm:@insforge/sdk';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-rubric-key',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SOURCES = ['otel', 'langsmith', 'langgraph', 'crewai', 'custom'];
const RATE_LIMIT_WINDOW_MS = parseInt(Deno.env.get('RUBRIC_RATE_LIMIT_WINDOW_MS') ?? '60000');
const RATE_LIMIT_MAX = parseInt(Deno.env.get('RUBRIC_RATE_LIMIT_MAX') ?? '60');

// In-memory rate limiter (per-key, per-window). Resets on cold start.
const rateWindow = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(keyId: string): boolean {
  const now = Date.now();
  const entry = rateWindow.get(keyId);
  if (!entry || now > entry.resetAt) {
    rateWindow.set(keyId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createAdminClient({ baseUrl: Deno.env.get('RUBRIC_BASE_URL'), apiKey: Deno.env.get('RUBRIC_ADMIN_KEY') });

  // --- Authenticate via Rubric ingest key ---
  const presentedKey = req.headers.get('x-rubric-key');
  if (!presentedKey) return json({ error: 'missing_key' }, 401);
  const keyHash = await sha256(presentedKey);
  const { data: keys } = await admin.database
    .from('api_keys')
    .select('id, owner_id, revoked')
    .eq('key_hash', keyHash)
    .limit(1);
  const key = keys?.[0];
  if (!key || key.revoked) return json({ error: 'invalid_key' }, 401);
  const ownerId = key.owner_id;

  // --- Rate limit ---
  if (!checkRateLimit(key.id)) {
    return json({ error: 'rate_limited', retry_after_ms: RATE_LIMIT_WINDOW_MS }, 429);
  }

  // --- Parse body ---
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const source = SOURCES.includes(body.source) ? body.source : 'custom';
  const spans = body.spans ?? body.payload;
  if (!spans) return json({ error: 'missing_spans' }, 400);

  // --- Resolve or create the context object ---
  let contextObjectId: string | undefined = body.context_object_id;

  if (!contextObjectId) {
    // Optionally resolve/create a named pipeline.
    let pipelineId: string | null = null;
    if (body.pipeline_name) {
      const { data: pls } = await admin.database
        .from('pipelines').select('id').eq('owner_id', ownerId).eq('name', body.pipeline_name).limit(1);
      if (pls?.[0]) pipelineId = pls[0].id;
      else {
        const { data: np } = await admin.database
          .from('pipelines').insert([{ owner_id: ownerId, name: String(body.pipeline_name).slice(0, 120) }]).select('id');
        pipelineId = np?.[0]?.id ?? null;
      }
    }
    const { data: co, error: coErr } = await admin.database
      .from('context_objects')
      .insert([{ owner_id: ownerId, pipeline_id: pipelineId, task: body.task ?? {}, status: 'active' }])
      .select('id');
    if (coErr || !co?.[0]) return json({ error: 'co_create_failed', detail: coErr }, 500);
    contextObjectId = co[0].id;
  } else {
    // Verify ownership of an existing context object.
    const { data: existing } = await admin.database
      .from('context_objects').select('id').eq('id', contextObjectId).eq('owner_id', ownerId).limit(1);
    if (!existing?.[0]) return json({ error: 'context_object_not_found' }, 404);
  }

  // --- Store the raw trace (awaiting extraction) ---
  const { data: trace, error: trErr } = await admin.database
    .from('raw_traces')
    .insert([{ owner_id: ownerId, context_object_id: contextObjectId, source, payload: spans }])
    .select('id');
  if (trErr) return json({ error: 'trace_store_failed', detail: trErr }, 500);

  // Touch last_used_at on the key (best effort).
  await admin.database.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id);

  return json({ context_object_id: contextObjectId, raw_trace_id: trace?.[0]?.id, status: 'accepted' }, 202);
}
