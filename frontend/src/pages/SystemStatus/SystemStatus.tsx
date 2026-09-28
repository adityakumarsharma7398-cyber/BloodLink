import { useCallback, useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, CircleDashed, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { supabase } from '@/lib/supabase';
import { ApiError } from '@/services/api';
import {
  getBackendHealth,
  getDependencyHealth,
  type BackendHealth,
  type DependencyHealth,
  type DependencyStatus,
} from '@/services/health';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; backend: BackendHealth; deps: DependencyHealth };

// Icon + label, never colour alone (Step 5 §31).
const STATUS_DISPLAY: Record<DependencyStatus, { label: string; Icon: typeof CircleCheck; className: string }> = {
  up: { label: 'Online', Icon: CircleCheck, className: 'text-emerald-400' },
  down: { label: 'Offline', Icon: CircleAlert, className: 'text-primary' },
  not_configured: { label: 'Not configured', Icon: CircleDashed, className: 'text-muted-foreground' },
};

function StatusRow({ name, status, detail }: { name: string; status: DependencyStatus; detail?: string }) {
  const { label, Icon, className } = STATUS_DISPLAY[status];
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <div>
        <p className="font-medium">{name}</p>
        {detail && <p className="text-muted-foreground mt-0.5 text-xs">{detail}</p>}
      </div>
      <span className={`flex shrink-0 items-center gap-1.5 text-sm ${className}`}>
        <Icon className="size-4" aria-hidden="true" />
        {label}
      </span>
    </li>
  );
}

export function SystemStatus() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const [backend, deps] = await Promise.all([getBackendHealth(), getDependencyHealth()]);
      setState({ kind: 'ready', backend, deps });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'Unexpected error while contacting the backend',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-6 px-4 py-12">
      <header>
        <p className="text-primary text-xs font-semibold tracking-[0.2em] uppercase">BloodLink AI</p>
        <h1 className="mt-2 text-3xl font-semibold">System foundation</h1>
        <p className="text-muted-foreground mt-2 text-sm">
          Connectivity check across the frontend, Express backend, Python AI service and Supabase.
        </p>
      </header>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Services</CardTitle>
            <CardDescription>Frontend → Backend → AI service / Supabase</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={state.kind === 'loading'}>
            <RefreshCw className={state.kind === 'loading' ? 'animate-spin' : undefined} aria-hidden="true" />
            Recheck
          </Button>
        </CardHeader>
        <CardContent aria-live="polite">
          {state.kind === 'loading' && <p className="text-muted-foreground py-3 text-sm">Checking services…</p>}

          {state.kind === 'error' && (
            <ul className="divide-border divide-y">
              <StatusRow name="Backend (Express)" status="down" detail={state.message} />
            </ul>
          )}

          {state.kind === 'ready' && (
            <ul className="divide-border divide-y">
              <StatusRow
                name="Backend (Express)"
                status="up"
                detail={`v${state.backend.version} · up ${state.backend.uptimeSeconds}s`}
              />
              <StatusRow
                name="AI service (FastAPI)"
                status={state.deps.dependencies.aiService.status}
                detail={state.deps.dependencies.aiService.detail}
              />
              <StatusRow
                name="Supabase"
                status={state.deps.dependencies.supabase.status}
                detail={state.deps.dependencies.supabase.detail}
              />
              <StatusRow
                name="Supabase browser client"
                status={supabase ? 'up' : 'not_configured'}
                detail={supabase ? 'Anon key loaded' : 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY'}
              />
            </ul>
          )}
        </CardContent>
      </Card>

      {state.kind === 'ready' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Adapters:</span>
          <Badge variant="secondary">maps: {state.deps.adapters.maps}</Badge>
          <Badge variant="secondary">notifications: {state.deps.adapters.notifications}</Badge>
          <Badge variant="secondary">e-RaktKosh: {state.deps.adapters.eraktkosh}</Badge>
        </div>
      )}
    </main>
  );
}
