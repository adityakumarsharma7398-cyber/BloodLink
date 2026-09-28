import { useEffect } from 'react';
import { Dashboard } from '@/pages/Dashboard/Dashboard';
import { Donors } from '@/pages/Donors/Donors';
import { DonorWorkspace } from '@/pages/DonorWorkspace/DonorWorkspace';
import { Inventory } from '@/pages/Inventory/Inventory';
import { Landing } from '@/pages/Landing/Landing';
import { Placeholder } from '@/pages/Placeholder/Placeholder';
import { DashboardPreview } from '@/pages/Preview/DashboardPreview';
import { DesignReference } from '@/pages/Preview/DesignReference';
import { EmergencyPreview } from '@/pages/Preview/EmergencyPreview';
import { Recommendations } from '@/pages/Recommendations/Recommendations';
import { Requests } from '@/pages/Requests/Requests';
import { SignIn } from '@/pages/SignIn/SignIn';
import { SystemStatus } from '@/pages/SystemStatus/SystemStatus';
import { AuthProvider, useAuth } from '@/lib/auth';
import { workspaceFor } from '@/lib/roles';

/** `/login`: signed out → the sign-in form; already signed in → straight to their workspace. */
function Login() {
  const { session } = useAuth();
  useEffect(() => {
    if (session) window.location.replace('/app');
  }, [session]);
  if (session) return null;
  return <SignIn />;
}

/**
 * `/app`: the one post-login entry point for every audience. The workspace shown comes only from
 * the backend-resolved identity (`GET /api/auth/me`) — never from which link the person clicked to
 * get here, and never from a role guessed on the client.
 */
function Workspace() {
  const { me, meError, loadingMe } = useAuth();
  if (loadingMe) {
    return (
      <div className="flex min-h-svh items-center justify-center" role="status" aria-label="Loading your account">
        <p className="text-grey-500 text-sm">Loading your account…</p>
      </div>
    );
  }
  if (meError) {
    return (
      <div className="flex min-h-svh items-center justify-center px-4 text-center">
        <p className="text-grey-600 text-sm">Could not load your account. {meError}</p>
      </div>
    );
  }
  const kind = workspaceFor(me);
  if (kind === 'donor') return <DonorWorkspace />;
  if (kind === 'staff') return <Dashboard />;
  return (
    <div className="flex min-h-svh items-center justify-center px-4 text-center">
      <p className="text-grey-600 text-sm">Your account isn't set up with an application workspace yet.</p>
    </div>
  );
}

/** Guards the staff-only pages so a donor-only identity never even renders their controls. */
function RequireStaff({ children }: { children: React.JSX.Element }) {
  const { me, loadingMe } = useAuth();
  if (loadingMe) return null;
  if (workspaceFor(me) !== 'staff') {
    return (
      <div className="flex min-h-svh items-center justify-center px-4 text-center">
        <p className="text-grey-600 text-sm">This page isn't part of your account's workspace.</p>
      </div>
    );
  }
  return children;
}

/** Pages under /app need a signed-in, authorized BloodLink user. */
function RequireAuth({ children }: { children: React.JSX.Element }) {
  const { session } = useAuth();
  if (session === undefined) {
    return (
      <div className="flex min-h-svh items-center justify-center" role="status" aria-label="Loading">
        <p className="text-grey-500 text-sm">Loading…</p>
      </div>
    );
  }
  if (session === null) return <SignIn />;
  return children;
}

// Temporary path switch; the real router arrives with the remaining screens in a later phase.
const PUBLIC_ROUTES: Record<string, () => React.JSX.Element> = {
  '/': Landing,
  '/emergency': EmergencyPreview,
  '/design': DesignReference,
  '/design/dashboard': DashboardPreview,
  '/status': SystemStatus,
};

// Staff-only pages: a donor-only identity never reaches these (Workspace renders DonorWorkspace
// instead of Dashboard, and these pages are only linked from the staff sidebar), and each page's
// own data requests are authorized again by the backend regardless.
const APP_ROUTES: Record<string, () => React.JSX.Element> = {
  '/app': Workspace,
  '/app/inventory': () => <RequireStaff><Inventory /></RequireStaff>,
  '/app/requests': () => <RequireStaff><Requests /></RequireStaff>,
  '/app/recommendations': () => <RequireStaff><Recommendations /></RequireStaff>,
  '/app/donors': () => <RequireStaff><Donors /></RequireStaff>,
};

export default function App() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';

  if (PUBLIC_ROUTES[path]) {
    const Page = PUBLIC_ROUTES[path];
    return <Page />;
  }

  return (
    <AuthProvider>
      {path === '/login' ? (
        <Login />
      ) : (
        <RequireAuth>
          {(() => {
            const Page = APP_ROUTES[path] ?? Placeholder;
            return <Page />;
          })()}
        </RequireAuth>
      )}
    </AuthProvider>
  );
}
