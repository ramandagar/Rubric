import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { ContextObjectSummary } from '../lib/types';
import { HealthBadge, Spinner } from '../components/ui';

export function Dashboard() {
  const [rows, setRows] = useState<ContextObjectSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try { setRows(await api.listContextObjects()); }
    catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, []);

  async function loadDemo() {
    setBusy('Seeding a regulated credit-underwriting pipeline…'); setError(null);
    try {
      const { context_object_id } = await api.seedDemo();
      setBusy('Extracting grounded epistemic frames…');
      await api.extract(context_object_id);
      setBusy('Scoring handoffs & detecting dropped context…');
      await api.score(context_object_id);
      setBusy(null);
      await load();
    } catch (e: any) { setError(e.message); setBusy(null); }
  }

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Pipelines</h1>
          <p className="mt-1 text-sm text-gray-500">Multi-agent runs, scored for reasoning continuity and context loss.</p>
        </div>
        <button className="btn-primary" onClick={loadDemo} disabled={!!busy}>＋ Load demo pipeline</button>
      </div>

      {busy && <div className="card mt-5 px-4 py-3"><Spinner label={busy} /></div>}
      {error && <div className="mt-5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div>}

      {rows == null && !busy && <div className="mt-8"><Spinner label="Loading…" /></div>}

      {rows && rows.length === 0 && !busy && (
        <div className="card mt-8 grid place-items-center px-6 py-16 text-center">
          <div className="text-gray-300">No pipelines yet.</div>
          <p className="mt-1 max-w-md text-sm text-gray-500">
            Load the demo to watch Rubric reconstruct each agent's reasoning and flag the assumptions one agent dropped before the next acted on them — or send traces from your own pipeline using an ingest key.
          </p>
          <button className="btn-primary mt-5" onClick={loadDemo}>Load demo pipeline</button>
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-xl border border-ink-700">
          <table className="w-full text-sm">
            <thead className="bg-ink-900 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Task</th>
                <th className="px-4 py-3 font-medium">Chain</th>
                <th className="px-4 py-3 font-medium text-center">Dropped</th>
                <th className="px-4 py-3 font-medium text-right">Health</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-800">
              {rows.map((r) => (
                <tr key={r.id} className="bg-ink-950 hover:bg-ink-900">
                  <td className="px-4 py-3">
                    <Link to={`/co/${r.id}`} className="block">
                      <div className="font-medium text-gray-100">{r.pipeline_name ?? 'Untitled pipeline'}</div>
                      <div className="mt-0.5 line-clamp-1 text-xs text-gray-500">{r.task?.goal}</div>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 font-mono text-xs text-gray-400">
                      {r.roles.length
                        ? r.roles.map((role, i) => (
                            <span key={i} className="flex items-center gap-1">
                              <span className="rounded bg-ink-800 px-1.5 py-0.5">{role}</span>
                              {i < r.roles.length - 1 && <span className="text-gray-600">→</span>}
                            </span>
                          ))
                        : <span className="text-gray-600">not processed</span>}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center">
                    {r.dropped_count > 0
                      ? <span className="pill border border-rose-500/30 bg-rose-500/10 text-rose-300">{r.dropped_count} dropped</span>
                      : <span className="text-gray-600">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right"><HealthBadge score={r.health} size="sm" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
