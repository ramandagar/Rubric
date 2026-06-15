import { ReactNode } from 'react';

export function healthColor(score: number | null): string {
  if (score == null) return 'text-gray-500';
  if (score >= 85) return 'text-emerald-400';
  if (score >= 70) return 'text-amber-400';
  return 'text-rose-400';
}
export function healthBg(score: number | null): string {
  if (score == null) return 'bg-gray-700';
  if (score >= 85) return 'bg-emerald-500';
  if (score >= 70) return 'bg-amber-500';
  return 'bg-rose-500';
}

export function HealthBadge({ score, size = 'md' }: { score: number | null; size?: 'sm' | 'md' | 'lg' }) {
  const cls = size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-sm' : 'text-lg';
  return (
    <span className={`font-mono font-semibold ${cls} ${healthColor(score)}`}>
      {score == null ? '—' : score.toFixed(0)}
      {score != null && <span className="text-gray-600 text-xs font-normal">/100</span>}
    </span>
  );
}

export function SeverityPill({ severity }: { severity?: string }) {
  const s = (severity ?? 'med').toLowerCase();
  const cls = s === 'high'
    ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
    : s === 'low'
      ? 'bg-sky-500/15 text-sky-300 border-sky-500/30'
      : 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  return <span className={`pill border ${cls}`}>{s}</span>;
}

export function GroundedPill({ grounded }: { grounded?: boolean }) {
  if (grounded === false) {
    return <span className="pill border border-amber-500/30 bg-amber-500/10 text-amber-300" title="Inferred — not directly in the trace">inferred</span>;
  }
  return <span className="pill border border-emerald-500/30 bg-emerald-500/10 text-emerald-300" title="Grounded in a trace span">grounded</span>;
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-gray-400 text-sm">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-ink-600 border-t-accent" />
      {label}
    </div>
  );
}

export function ScoreBars({ dimensions }: { dimensions: Record<string, number | null> }) {
  const labels: Record<string, string> = {
    completeness: 'Completeness',
    faithfulness: 'Faithfulness',
    continuity: 'Continuity',
    information_loss: 'Info retention',
    grounding: 'Grounding',
  };
  return (
    <div className="space-y-2">
      {Object.entries(labels).map(([k, label]) => {
        const v = dimensions[k];
        return (
          <div key={k} className="flex items-center gap-3">
            <div className="w-28 text-xs text-gray-400">{label}</div>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-800">
              <div className={`h-full ${healthBg(v)}`} style={{ width: `${v ?? 0}%` }} />
            </div>
            <div className={`w-9 text-right font-mono text-xs ${healthColor(v)}`}>{v == null ? 'n/a' : v}</div>
          </div>
        );
      })}
    </div>
  );
}
