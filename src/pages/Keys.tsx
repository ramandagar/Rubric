import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Spinner } from '../components/ui';

const BASE = import.meta.env.VITE_INSFORGE_URL as string;
const FN_BASE = BASE.replace('.insforge.app', '.functions.insforge.app');

export function Keys() {
  const [keys, setKeys] = useState<Awaited<ReturnType<typeof api.listKeys>> | null>(null);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() { try { setKeys(await api.listKeys()); } catch (e: any) { setError(e.message); } }
  useEffect(() => { load(); }, []);

  async function create() {
    if (!name.trim()) return;
    setBusy(true); setError(null);
    try { const { key } = await api.createKey(name.trim()); setCreated(key); setName(''); await load(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  async function revoke(id: string) { await api.revokeKey(id); await load(); }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Ingest keys</h1>
      <p className="mt-1 text-sm text-gray-500">Send traces from your own multi-agent pipeline. Keys are shown once and stored only as a hash.</p>

      <div className="card mt-6 flex items-center gap-3 px-4 py-4">
        <input className="input flex-1" placeholder="Key name (e.g. prod-pipeline)" value={name}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        <button className="btn-primary" onClick={create} disabled={busy || !name.trim()}>Create key</button>
      </div>

      {error && <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div>}

      {created && (
        <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] px-4 py-3">
          <div className="text-sm text-emerald-300">Copy your key now — it won't be shown again.</div>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 break-all rounded-lg bg-ink-950 px-3 py-2 font-mono text-xs text-gray-200">{created}</code>
            <button className="btn-ghost" onClick={() => navigator.clipboard?.writeText(created)}>Copy</button>
            <button className="btn-ghost" onClick={() => setCreated(null)}>Done</button>
          </div>
        </div>
      )}

      {keys == null ? <div className="mt-8"><Spinner label="Loading…" /></div> : (
        <div className="mt-6 overflow-hidden rounded-xl border border-ink-700">
          <table className="w-full text-sm">
            <thead className="bg-ink-900 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr><th className="px-4 py-3 font-medium">Name</th><th className="px-4 py-3 font-medium">Prefix</th><th className="px-4 py-3 font-medium">Last used</th><th className="px-4 py-3"></th></tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {keys.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No keys yet.</td></tr>}
              {keys.map((k) => (
                <tr key={k.id} className={`bg-ink-950 ${k.revoked ? 'opacity-40' : ''}`}>
                  <td className="px-4 py-3 text-gray-200">{k.name}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">{k.key_prefix}…</td>
                  <td className="px-4 py-3 text-xs text-gray-500">{k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'}</td>
                  <td className="px-4 py-3 text-right">
                    {k.revoked ? <span className="text-xs text-gray-600">revoked</span>
                      : <button className="text-xs text-rose-400 hover:text-rose-300" onClick={() => revoke(k.id)}>Revoke</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Ingestion snippet */}
      <h2 className="mt-10 text-sm font-medium text-gray-300">Send a trace</h2>
      <pre className="mt-2 overflow-x-auto rounded-xl border border-ink-700 bg-ink-950 px-4 py-3 text-xs text-gray-300">
{`curl -X POST ${FN_BASE}/ingest \\
  -H "x-rubric-key: rbk_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "pipeline_name": "my-pipeline",
    "task": { "goal": "..." },
    "source": "langgraph",
    "spans": [ { "span": "agent_a", "role": "researcher", "events": [ ... ] } ]
  }'

# then extract + score (or call from your app with the same key):
curl -X POST ${FN_BASE}/extract -H "x-rubric-key: rbk_..." -d '{"context_object_id":"..."}'
curl -X POST ${FN_BASE}/score   -H "x-rubric-key: rbk_..." -d '{"context_object_id":"..."}'`}
      </pre>
    </div>
  );
}
