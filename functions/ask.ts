// ask — semantic search over epistemic items (ARCHITECTURE.md §6, the real moat).
// Agent B (or a human) asks natural-language questions against the ledger:
// "Did anyone assume the user is US-based?" / "What did research decide NOT to include?"
// Hybrid search: pgvector semantic (when available) + GIN JSONB structured fallback.
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

const EMBED_MODEL = Deno.env.get('RUBRIC_EMBED_MODEL') ?? 'openai/text-embedding-3-small';

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

async function embed(text: string): Promise<number[]> {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RUBRIC_OPENROUTER_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`embed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.data?.[0]?.embedding ?? [];
}

// Hybrid search: pgvector similarity + GIN-structured JSONB filter.
async function searchSemantic(
  admin: any,
  coId: string,
  questionEmbedding: number[],
  itemTypes: string[] | null,
  seqs: number[] | null,
  limit: number,
) {
  const vectorParam = `[${questionEmbedding.join(',')}]`;
  let query = `
    select e.id, e.frame_id, e.seq, e.item_type, e.text, e.metadata,
           1 - (e.embedding <=> $1::vector) as similarity
    from public.epistemic_items e
    where e.co_id = $2
  `;
  const params: any[] = [vectorParam, coId];
  let pi = 3;
  if (itemTypes && itemTypes.length) {
    query += ` and e.item_type = any($${pi++}::text[])`;
    params.push(itemTypes);
  }
  if (seqs && seqs.length) {
    query += ` and e.seq = any($${pi++}::int[])`;
    params.push(seqs);
  }
  query += ` order by e.embedding <=> $1::vector limit $${pi++}`;
  params.push(limit);

  try {
    const { data, error } = await admin.database.raw(query, params);
    if (error) throw error;
    return data ?? [];
  } catch {
    return null; // pgvector might not be ready — fall through to structured search
  }
}

// Structured fallback: GIN JSONB text match when embeddings aren't available.
async function searchStructured(admin: any, coId: string, keywords: string[], itemTypes: string[] | null, limit: number) {
  const allKeywords = keywords.filter((k) => k.length > 2);
  let query = `select e.id, e.frame_id, e.seq, e.item_type, e.text, e.metadata, 0 as similarity
    from public.epistemic_items e where e.co_id = $1`;
  const params: any[] = [coId];
  let pi = 2;

  const clauses: string[] = [];
  for (const kw of allKeywords.slice(0, 6)) {
    clauses.push(`e.text ilike $${pi++}`);
    params.push(`%${kw}%`);
  }
  if (clauses.length) query += ` and (${clauses.join(' or ')})`;

  if (itemTypes && itemTypes.length) {
    query += ` and e.item_type = any($${pi++}::text[])`;
    params.push(itemTypes);
  }
  query += ` order by e.seq limit $${pi++}`;
  params.push(limit);

  const { data } = await admin.database.raw(query, params);
  return data ?? [];
}

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createAdminClient({ baseUrl: Deno.env.get('RUBRIC_BASE_URL'), apiKey: Deno.env.get('RUBRIC_ADMIN_KEY') });
  const owner = await resolveOwner(req, admin);
  if (!owner) return json({ error: 'unauthorized' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { return json({ error: 'invalid_json' }, 400); }

  const coId = body.context_object_id;
  const question = body.question?.trim();
  if (!coId || !question) return json({ error: 'missing context_object_id or question' }, 400);

  // Verify ownership
  const { data: cos } = await admin.database
    .from('context_objects').select('id').eq('id', coId).eq('owner_id', owner).limit(1);
  if (!cos?.[0]) return json({ error: 'context_object_not_found' }, 404);

  const limit = Math.min(body.limit ?? 10, 25);
  const itemTypes: string[] | null = body.item_types?.length ? body.item_types : null;
  const seqs: number[] | null = body.seq?.length ? body.seq : null;

  let results: any[] = [];
  let mode: 'semantic' | 'structured' = 'structured';

  // Try semantic search first (pgvector).
  try {
    const embedding = await embed(question);
    if (embedding.length) {
      const semantic = await searchSemantic(admin, coId, embedding, itemTypes, seqs, limit);
      if (semantic) {
        results = semantic;
        mode = 'semantic';
      }
    }
  } catch {
    // Embedding failed — fall through to structured.
  }

  // Fallback: GIN-structured keyword search.
  if (!results.length) {
    const keywords = question.split(/\s+/).filter((w: string) => w.length > 2);
    if (keywords.length) {
      results = await searchStructured(admin, coId, keywords, itemTypes, limit);
    }
  }

  // Group results by relevance with source frame context.
  const grouped = results.map((r: any) => ({
    id: r.id,
    frame_id: r.frame_id,
    seq: r.seq,
    item_type: r.item_type,
    text: r.text,
    metadata: r.metadata,
    similarity: typeof r.similarity === 'number' ? Math.round(r.similarity * 1000) / 1000 : null,
  }));

  return json({
    question,
    mode,
    context_object_id: coId,
    total: grouped.length,
    results: grouped,
    tip: mode === 'semantic' ? null : 'Semantic search unavailable — showing keyword matches. Ensure pgvector is configured and embeddings are generated.',
  }, 200);
}
