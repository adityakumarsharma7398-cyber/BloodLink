import { useState } from 'react';
import { SiteHeader } from '@/components/site/SiteHeader';
import { StateBoundary } from '@/components/data/StateBoundary';
import { RiskBadge } from '@/components/status/RiskBadge';
import { StatusBadge } from '@/components/status/StatusBadge';
import { Button } from '@/components/ui/button';
import { PRIORITY_TO_RISK } from '@/lib/recommendationView';
import { useAuth } from '@/lib/auth';
import { useResource } from '@/hooks/useResource';
import { getMyDonorActivations, respondToDonorActivation } from '@/services/donorSelf';

const URGENCY_TO_PRIORITY = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', NORMAL: 'MEDIUM' } as const;

/**
 * The donor's own workspace: only what `GET /api/donor-activations/mine` and
 * `POST /api/donor-activations/recipients/:id/respond` already support — no inventory,
 * procurement, transfer or emergency-source controls exist here, because a DONOR-only identity
 * cannot reach those endpoints on the backend either.
 */
export function DonorWorkspace() {
  const { me, signOut } = useAuth();
  const activations = useResource(() => getMyDonorActivations(), [], { isEmpty: (r) => r.data.length === 0 });
  const [busy, setBusy] = useState<string | null>(null);

  const respond = async (recipientId: string, response: 'WILLING' | 'DECLINED') => {
    setBusy(recipientId);
    try {
      await respondToDonorActivation(recipientId, response);
      activations.refetch();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-grey-50 flex min-h-svh flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl">Donor invitations</h1>
            <p className="text-grey-600 mt-1 text-sm">
              {me ? `Signed in as ${me.user.fullName}.` : ''} A blood centre confirms your eligibility when you donate — this only
              records whether you're willing to be contacted.
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => signOut()}>
            Sign out
          </Button>
        </div>

        <div className="mt-6 flex flex-col gap-4">
          <StateBoundary state={activations} onRetry={activations.refetch} empty={<p className="text-grey-500 py-8 text-center text-sm">No invitations right now.</p>}>
            {(page) => (
              <>
                {page.data.map((item) => (
                  <article key={item.recipientId} className="rounded-lg border bg-white p-5 shadow-card">
                    <header className="flex flex-wrap items-center justify-between gap-2">
                      <RiskBadge level={PRIORITY_TO_RISK[URGENCY_TO_PRIORITY[item.activation.urgency]]} />
                      <StatusBadge
                        tone={item.response === 'WILLING' ? 'ok' : item.response === 'DECLINED' ? 'neutral' : 'warning'}
                        label={item.response === 'NO_RESPONSE' ? 'Awaiting your response' : item.response}
                      />
                    </header>
                    <p className="text-grey-900 mt-3 text-sm">{item.activation.donorMessage}</p>
                    <p className="text-grey-500 mt-1 text-xs">
                      {item.activation.bloodGroup} {item.activation.component} · about {item.distanceKm} km away
                    </p>
                    {item.activation.status === 'ACTIVE' && item.response === 'NO_RESPONSE' && (
                      <div className="mt-4 flex gap-2">
                        <Button size="sm" disabled={busy === item.recipientId} onClick={() => respond(item.recipientId, 'WILLING')}>
                          I'm willing
                        </Button>
                        <Button size="sm" variant="secondary" disabled={busy === item.recipientId} onClick={() => respond(item.recipientId, 'DECLINED')}>
                          Not this time
                        </Button>
                      </div>
                    )}
                    {item.activation.status !== 'ACTIVE' && item.response === 'NO_RESPONSE' && (
                      <p className="text-grey-500 mt-3 text-xs">This invitation is no longer active.</p>
                    )}
                  </article>
                ))}
              </>
            )}
          </StateBoundary>
        </div>
      </main>
    </div>
  );
}
