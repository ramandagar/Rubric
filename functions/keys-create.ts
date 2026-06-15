// keys-create — mint a Rubric SDK ingestion key (rbk_...) for the authenticated user.
// The plaintext key is returned exactly once; only its SHA-256 hash is stored.
import { createClient, createAdminClient } from 'npm:@insforge/sdk';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // Identify the caller from their user JWT.
  const userToken = req.headers.get('Authorization')?.replace('Bearer ', '') ?? null;
  const userClient = createClient({ baseUrl: Deno.env.get('RUBRIC_BASE_URL'), edgeFunctionToken: userToken });
  const { data: userData } = await userClient.auth.getCurrentUser();
  const ownerId = userData?.user?.id;
  if (!ownerId) return json({ error: 'unauthorized' }, 401);

  let body: { name?: string } = {};
  try { body = await req.json(); } catch { /* optional body */ }
  const name = (body.name ?? 'default').toString().slice(0, 80);

  // Generate rbk_<32 hex> and store only its hash.
  const raw = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const fullKey = `rbk_${raw}`;
  const keyHash = await sha256(fullKey);
  const keyPrefix = fullKey.slice(0, 12);

  const admin = createAdminClient({ baseUrl: Deno.env.get('RUBRIC_BASE_URL'), apiKey: Deno.env.get('RUBRIC_ADMIN_KEY') });
  const { data, error } = await admin.database
    .from('api_keys')
    .insert([{ owner_id: ownerId, name, key_prefix: keyPrefix, key_hash: keyHash }])
    .select('id, name, key_prefix, created_at');

  if (error) return json({ error: 'insert_failed', detail: error }, 500);

  // Return the plaintext key ONCE — it is never retrievable again.
  return json({ key: fullKey, record: data?.[0] }, 201);
}
