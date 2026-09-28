import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { apiGet } from '@/services/api';

export interface FacilityRef {
  id: string;
  name: string;
  organizationId: string;
  facilityType: string;
}
export interface RoleGrant {
  role: string;
  scope: string;
  organizationId: string | null;
  facilityId: string | null;
}
export interface Me {
  user: { id: string; email: string; fullName: string };
  organization: { id: string; name: string; type: string } | null;
  primaryFacilityId: string | null;
  roles: RoleGrant[];
  facilities: FacilityRef[];
}

interface AuthState {
  /** undefined = still resolving the initial session. */
  session: Session | null | undefined;
  /** The server-resolved identity — the only source of roles/facilities (never trust the JWT alone). */
  me: Me | null;
  meError: string | null;
  loadingMe: boolean;
  signInWithPassword: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  /** Convenience: the caller's own facility when they have exactly one, for run/create actions. */
  singleFacility: FacilityRef | null;
  hasRole: (role: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string | null>(null);
  const [loadingMe, setLoadingMe] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setSession(null);
      return;
    }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setMe(null);
      return;
    }
    let cancelled = false;
    setLoadingMe(true);
    setMeError(null);
    apiGet<{ data: Me }>('/auth/me')
      .then((res) => !cancelled && setMe(res.data))
      .catch((error: unknown) => !cancelled && setMeError(error instanceof Error ? error.message : 'Could not load your account'))
      .finally(() => !cancelled && setLoadingMe(false));
    return () => {
      cancelled = true;
    };
  }, [session]);

  const value: AuthState = {
    session,
    me,
    meError,
    loadingMe,
    async signInWithPassword(email, password) {
      if (!supabase) return 'Sign-in is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing).';
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return error ? error.message : null;
    },
    async signOut() {
      await supabase?.auth.signOut();
    },
    singleFacility: me?.facilities.length === 1 ? me.facilities[0]! : null,
    hasRole: (role) => me?.roles.some((grant) => grant.role === role) ?? false,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
