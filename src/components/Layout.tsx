import { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2">
      <span className="grid h-7 w-7 place-items-center rounded-lg bg-accent font-bold text-white">R</span>
      <span className="font-semibold tracking-tight">Rubric</span>
    </Link>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const loc = useLocation();
  const nav = [
    { to: '/', label: 'Pipelines' },
    { to: '/keys', label: 'Ingest keys' },
  ];
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-ink-800 bg-ink-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-8">
            <Logo />
            <nav className="flex items-center gap-1">
              {nav.map((n) => {
                const active = n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to);
                return (
                  <Link key={n.to} to={n.to}
                    className={`rounded-lg px-3 py-1.5 text-sm ${active ? 'bg-ink-800 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
                    {n.label}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-400">
            <span className="hidden sm:inline">{user?.email}</span>
            <button onClick={() => signOut()} className="btn-ghost py-1.5">Sign out</button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-7">{children}</main>
    </div>
  );
}
