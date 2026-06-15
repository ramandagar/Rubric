import { useState } from 'react';
import { useAuth } from '../lib/auth';

export function Login() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setInfo(null);
    try {
      if (mode === 'in') {
        await signIn(email, password);
      } else {
        const { needsVerification } = await signUp(email, password);
        if (needsVerification) setInfo('Account created. Check your email to verify, then sign in.');
      }
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left: pitch */}
      <div className="hidden flex-col justify-between border-r border-ink-800 bg-ink-950 p-12 lg:flex">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent font-bold text-white">R</span>
          <span className="text-lg font-semibold">Rubric</span>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">
            See — and prove — what your agents <span className="text-accent-soft">knew, assumed, and dropped</span> at every handoff.
          </h1>
          <p className="mt-5 text-gray-400">
            Observability tools show you spans. A2A passes prose. Memory tools store facts.
            None of them catch the moment a critical assumption or uncertainty is silently dropped
            between agents — the exact failure that corrupts downstream output and breaks audit trails.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-gray-300">
            <li>▹ Grounded epistemic frames — every claim tied to its source span.</li>
            <li>▹ Drop-detection — what Agent A flagged that Agent B ignored.</li>
            <li>▹ Handoff Health Score + audit-ready provenance.</li>
          </ul>
        </div>
        <div className="text-xs text-gray-600">Audit-grade reasoning provenance for multi-agent AI.</div>
      </div>

      {/* Right: form */}
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm">
          <h2 className="text-xl font-semibold">{mode === 'in' ? 'Sign in' : 'Create account'}</h2>
          <p className="mt-1 text-sm text-gray-500">to your Rubric workspace</p>

          <div className="mt-6 space-y-3">
            <input className="input" type="email" placeholder="you@company.com" value={email}
              onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            <input className="input" type="password" placeholder="Password" value={password}
              onChange={(e) => setPassword(e.target.value)} required minLength={6}
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'} />
          </div>

          {error && <div className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{error}</div>}
          {info && <div className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{info}</div>}

          <button className="btn-primary mt-5 w-full" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Create account'}
          </button>

          <button type="button" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null); setInfo(null); }}
            className="mt-4 w-full text-center text-sm text-gray-400 hover:text-gray-200">
            {mode === 'in' ? "No account? Create one" : 'Have an account? Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
