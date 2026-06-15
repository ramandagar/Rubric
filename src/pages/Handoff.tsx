import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { AskResultItem, Frame, HandoffView } from '../lib/types';
import { GroundedPill, HealthBadge, ScoreBars, SeverityPill, Spinner, Stat, healthColor } from '../components/ui';

export function Handoff() {
  const { id = '' } = useParams();
  const [view, setView] = useState<HandoffView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setView(await api.getHandoff(id)); } catch (e: any) { setError(e.message); }
  }
  useEffect(() => { load(); }, [id]);

  async function reprocess() {
    setBusy(true);
    try { await api.processFull(id); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }

  if (error) return <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div>;
  if (!view) return <Spinner label="Loading handoff…" />;

  const frame: Frame | undefined = view.frames[sel];
  const drops = view.dropped_context ?? [];

  return (
    <div>
      <Link to="/" className="text-sm text-gray-500 hover:text-gray-300">← Pipelines</Link>

      {/* Header */}
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-xl font-semibold tracking-tight">{view.context_object.task?.goal ?? 'Context object'}</h1>
          <p className="mt-1 text-sm text-gray-500">{view.context_object.task?.original_prompt}</p>
        </div>
        <div className="flex items-center gap-6">
          <Stat label="Pipeline health"><HealthBadge score={view.pipeline_health} size="lg" /></Stat>
          <Stat label="Dropped">
            <span className={`font-mono text-3xl font-semibold ${drops.length ? 'text-rose-400' : 'text-emerald-400'}`}>{drops.length}</span>
          </Stat>
          <button className="btn-ghost" onClick={reprocess} disabled={busy}>{busy ? 'Processing…' : '↻ Re-process'}</button>
        </div>
      </div>

      {view.frames.length === 0 && (
        <div className="card mt-6 px-4 py-8 text-center text-sm text-gray-400">
          No frames yet — this run hasn't been processed. <button className="text-accent-soft" onClick={reprocess}>Extract & score now</button>.
        </div>
      )}

      {view.frames.length > 0 && (
        <>
          {/* Semantic search — ask the ledger */}
          <AskPanel contextObjectId={view.context_object.id} />

          {/* Handoff graph */}
          <div className="card mt-6 px-5 py-5">
            <div className="mb-4 text-xs uppercase tracking-wider text-gray-500">Reasoning handoff chain</div>
            <div className="flex items-stretch gap-2 overflow-x-auto pb-1">
              {view.frames.map((f, i) => {
                const dInto = drops.filter((d) => d.at_seq === f.seq).length;
                const active = i === sel;
                return (
                  <div key={f.id} className="flex items-center gap-2">
                    <button onClick={() => setSel(i)}
                      className={`min-w-[150px] rounded-xl border px-4 py-3 text-left transition-colors ${active ? 'border-accent bg-ink-800' : 'border-ink-700 bg-ink-950 hover:bg-ink-900'}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-xs text-gray-400">seq {f.seq}</span>
                        <HealthBadge score={f.score?.health_score ?? null} size="sm" />
                      </div>
                      <div className="mt-1 font-medium text-gray-100">{f.agent?.role ?? 'agent'}</div>
                      {dInto > 0 && (
                        <div className="mt-1.5 inline-flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] text-rose-300">
                          ▼ {dInto} dropped
                        </div>
                      )}
                    </button>
                    {i < view.frames.length - 1 && <span className="text-lg text-gray-600">→</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Drop-detection audit panel — the headline */}
          {drops.length > 0 && (
            <div className="mt-6 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] px-5 py-4">
              <div className="flex items-center gap-2 text-sm font-medium text-rose-300">
                ⚠ Dropped context — reasoning that one agent surfaced and the next never carried forward
              </div>
              <ul className="mt-3 space-y-2">
                {drops.map((d, i) => (
                  <li key={i} className="flex items-start gap-3 text-sm">
                    <SeverityPill severity={d.severity} />
                    <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-xs text-gray-400">{d.type}</span>
                    <span className="text-gray-200">{d.item}</span>
                    <span className="ml-auto whitespace-nowrap text-xs text-gray-500">→ {d.into_role}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Frame inspector + score */}
          {frame && (
            <div className="mt-6 grid gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2"><FrameInspector frame={frame} /></div>
              <div className="space-y-6">
                <ScoreCard frame={frame} />
                <CompactHandoff view={view} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AskPanel({ contextObjectId }: { contextObjectId: string }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<AskResultItem[] | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [tip, setTip] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setSearching(true); setSearchErr(null);
    try {
      const res = await api.ask(contextObjectId, q.trim());
      setResults(res.results);
      setMode(res.mode);
      setTip(res.tip);
    } catch (err: any) {
      setSearchErr(err.message);
      setResults(null);
    } finally {
      setSearching(false);
    }
  }

  const typePills: Record<string, string> = {
    assumption: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    uncertainty: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    decision: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    excluded: 'bg-gray-500/15 text-gray-300 border-gray-500/30',
    evidence: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    attempt: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
  };

  return (
    <div className="card mt-6 px-4 py-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-200">Ask the ledger</h3>
        <span className="text-xs text-gray-500">query reasoning across the full pipeline</span>
      </div>
      <form onSubmit={search} className="mt-3 flex gap-2">
        <input
          className="input flex-1"
          placeholder='"Did anyone assume the applicant is US-based?"'
          value={q} onChange={(e) => setQ(e.target.value)}
        />
        <button className="btn-primary" disabled={searching}>{searching ? '…' : 'Ask'}</button>
      </form>
      {searchErr && <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{searchErr}</div>}
      {results && (
        <div className="mt-3">
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>{results.length} results</span>
            {mode && <span className="pill border border-ink-600 bg-ink-800">{mode}</span>}
            {tip && <span className="text-amber-400">{tip}</span>}
          </div>
          <div className="mt-2 max-h-96 space-y-2 overflow-y-auto">
            {results.map((r, i) => (
              <div key={i} className="rounded-lg bg-ink-950 px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className={`pill border text-[11px] ${typePills[r.item_type] ?? 'border-ink-600 bg-ink-800 text-gray-400'}`}>{r.item_type}</span>
                    <span className="font-mono text-[11px] text-gray-500">seq {r.seq}</span>
                  </div>
                  {r.similarity != null && (
                    <span className="font-mono text-[11px] text-gray-500">{(r.similarity * 100).toFixed(0)}%</span>
                  )}
                </div>
                <div className="mt-1 text-gray-200">{r.text}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <div className="card px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-200">{title}</h3>
        <span className="font-mono text-xs text-gray-500">{count}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Cite({ span }: { span?: string }) {
  if (!span) return null;
  return <span className="ml-2 rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">{span}</span>;
}

function FrameInspector({ frame }: { frame: Frame }) {
  return (
    <div className="space-y-4">
      <div className="card px-4 py-3">
        <div className="text-xs uppercase tracking-wider text-gray-500">Interpretation</div>
        <div className="mt-1 text-sm text-gray-200">{frame.interpretation?.restated_goal ?? '—'}</div>
      </div>

      <Section title="Assumptions" count={frame.assumptions?.length ?? 0}>
        {frame.assumptions?.map((a, i) => (
          <div key={i} className="rounded-lg bg-ink-950 px-3 py-2 text-sm">
            <div className="flex items-start justify-between gap-2">
              <span className="text-gray-200">{a.statement}</span>
              <GroundedPill grounded={a.grounded} />
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {a.basis && <span>{a.basis} · </span>}
              {a.confidence != null && <span>confidence {Math.round((a.confidence) * 100)}%</span>}
              <Cite span={a.trace_span} />
            </div>
          </div>
        ))}
      </Section>

      <Section title="Uncertainties" count={frame.uncertainties?.length ?? 0}>
        {frame.uncertainties?.map((u, i) => (
          <div key={i} className="rounded-lg bg-ink-950 px-3 py-2 text-sm">
            <div className="flex items-start justify-between gap-2">
              <span className="text-gray-200">{u.question}</span>
              <div className="flex items-center gap-1">
                {u.blocking && <span className="pill border border-rose-500/30 bg-rose-500/10 text-rose-300">blocking</span>}
                <SeverityPill severity={u.impact} />
              </div>
            </div>
            <div className="mt-1 text-xs text-gray-500"><Cite span={u.trace_span} /></div>
          </div>
        ))}
      </Section>

      <Section title="Decisions" count={frame.decisions?.length ?? 0}>
        {frame.decisions?.map((d, i) => (
          <div key={i} className="rounded-lg bg-ink-950 px-3 py-2 text-sm">
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium text-gray-100">{d.decision}</span>
              <GroundedPill grounded={d.grounded} />
            </div>
            {d.rationale && <div className="mt-1 text-xs text-gray-400">{d.rationale}</div>}
            {d.alternatives_rejected?.map((alt, j) => (
              <div key={j} className="mt-1 text-xs text-gray-500">✗ {alt.option} — {alt.why_not}</div>
            ))}
            <div className="mt-1"><Cite span={d.trace_span} /></div>
          </div>
        ))}
      </Section>

      <Section title="Attempts (incl. rejected paths)" count={frame.attempts?.length ?? 0}>
        {frame.attempts?.map((a, i) => (
          <div key={i} className="rounded-lg bg-ink-950 px-3 py-2 text-sm">
            <div className="flex items-center gap-2">
              <span className={a.kept === false ? 'text-gray-400 line-through' : 'text-gray-200'}>{a.approach}</span>
              {a.kept === false && <span className="pill border border-ink-600 bg-ink-800 text-gray-400">dropped</span>}
            </div>
            {a.outcome && <div className="mt-1 text-xs text-gray-500">{a.outcome}{a.reason_dropped ? ` — ${a.reason_dropped}` : ''}</div>}
          </div>
        ))}
      </Section>

      <Section title="Deliberately excluded" count={frame.excluded?.length ?? 0}>
        {frame.excluded?.map((e, i) => (
          <div key={i} className="rounded-lg bg-ink-950 px-3 py-2 text-sm">
            <span className="text-gray-200">{e.what}</span>
            <div className="mt-1 text-xs text-gray-500">{e.why}<Cite span={e.trace_span} /></div>
          </div>
        ))}
      </Section>

      {frame.output?.summary && (
        <div className="card px-4 py-3">
          <div className="text-xs uppercase tracking-wider text-gray-500">Output</div>
          <div className="mt-1 text-sm text-gray-300">{frame.output.summary}</div>
        </div>
      )}
    </div>
  );
}

function ScoreCard({ frame }: { frame: Frame }) {
  const s = frame.score;
  if (!s) return null;
  const reasons = s.details?.reasons ?? {};
  return (
    <div className="card px-4 py-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-200">Handoff health</h3>
        <HealthBadge score={s.health_score} />
      </div>
      <div className="mt-4"><ScoreBars dimensions={s.dimensions} /></div>
      {s.details?.grounding && (
        <div className="mt-3 text-xs text-gray-500">
          Grounding: {s.details.grounding.grounded}/{s.details.grounding.total} items tied to a trace span
        </div>
      )}
      {Object.entries(reasons).filter(([, v]) => v).length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300">Why these scores?</summary>
          <div className="mt-2 space-y-1.5">
            {Object.entries(reasons).filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="text-xs text-gray-400"><span className={`font-medium ${healthColor(s.dimensions[k])}`}>{k}:</span> {v as string}</div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function CompactHandoff({ view }: { view: HandoffView }) {
  const h = view.handoff;
  if (!h) return null;
  return (
    <div className="card px-4 py-4">
      <h3 className="text-sm font-medium text-gray-200">Compact handoff payload</h3>
      <p className="mt-0.5 text-xs text-gray-500">What the next agent should actually inject — not the raw ledger.</p>
      {h.note?.for_next_agent && <div className="mt-3 rounded-lg bg-ink-950 px-3 py-2 text-sm text-gray-300">{h.note.for_next_agent}</div>}
      {!!h.open_questions?.length && (
        <div className="mt-3">
          <div className="text-[11px] uppercase tracking-wider text-gray-500">Open questions</div>
          <ul className="mt-1 space-y-1">
            {h.open_questions.slice(0, 5).map((q, i) => (
              <li key={i} className="text-xs text-gray-400">• {q.question}</li>
            ))}
          </ul>
        </div>
      )}
      {!!h.key_assumptions?.length && (
        <div className="mt-3">
          <div className="text-[11px] uppercase tracking-wider text-gray-500">Key assumptions to verify</div>
          <ul className="mt-1 space-y-1">
            {h.key_assumptions.slice(0, 5).map((a, i) => (
              <li key={i} className="text-xs text-gray-400">• {a.statement}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
