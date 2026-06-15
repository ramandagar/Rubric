import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { insforge } from './insforge';

interface User { id: string; email?: string }
interface AuthCtx {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<{ needsVerification: boolean }>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      const { data } = await insforge.auth.getCurrentUser();
      setUser(data?.user ? { id: data.user.id, email: (data.user as any).email } : null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  const signIn: AuthCtx['signIn'] = async (email, password) => {
    const { error } = await insforge.auth.signInWithPassword({ email, password });
    if (error) throw new Error((error as any).message ?? 'Sign in failed');
    await refresh();
  };

  const signUp: AuthCtx['signUp'] = async (email, password) => {
    const { data, error } = await insforge.auth.signUp({ email, password });
    if (error) throw new Error((error as any).message ?? 'Sign up failed');
    // If a session came back, we're in; otherwise verification is required.
    const hasSession = !!(data as any)?.accessToken || !!(data as any)?.session;
    await refresh();
    return { needsVerification: !hasSession && !user };
  };

  const signOut: AuthCtx['signOut'] = async () => {
    await insforge.auth.signOut();
    setUser(null);
  };

  return <Ctx.Provider value={{ user, loading, signIn, signUp, signOut }}>{children}</Ctx.Provider>;
}
