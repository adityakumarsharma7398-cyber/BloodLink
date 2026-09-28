import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { visibleNavItems } from '@/lib/roles';
import { PageHeader } from '@/components/layout/PageHeader';
import { StateBoundary } from '@/components/data/StateBoundary';
import { StatusBadge } from '@/components/status/StatusBadge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth';
import { useResource } from '@/hooks/useResource';
import { cancelDonorActivation, listDonorActivations, notifyDonorActivation, runDonorActivation } from '@/services/donorActivations';

/** Live donor activation / mobilization: run, review counts, notify and cancel. Never lists a donor before they say WILLING. */
export function Donors() {
  const { me, singleFacility } = useAuth();
  const facilityId = singleFacility?.id;
  const activations = useResource(() => listDonorActivations({ facilityId, pageSize: 25 }), [facilityId], { isEmpty: (r) => r.data.length === 0 });
  const [busy, setBusy] = useState<string | null>(null);

  const withBusy = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await action();
      activations.refetch();
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell activeId="donors" organization={me?.organization?.name ?? '—'} user={{ name: me?.user.fullName ?? '—', role: me?.roles[0]?.role ?? '—' }} navItems={visibleNavItems(me)}>
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <PageHeader
          title="Donor activation"
          description="Targets consenting, currently-eligible donors near a shortage. Screening at donation remains blood-centre staff's decision."
          actions={
            facilityId && (
              <Button size="sm" disabled={busy === 'run'} onClick={() => withBusy('run', () => runDonorActivation(facilityId))}>
                {busy === 'run' ? 'Checking…' : 'Check for shortages'}
              </Button>
            )
          }
        />

        <StateBoundary state={activations} onRetry={activations.refetch}>
          {(page) => (
            <div className="flex flex-col gap-4">
              {page.data.map((activation) => (
                <article key={activation.id} className="rounded-lg border bg-white shadow-card">
                  <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
                    <div>
                      <p className="text-grey-900 font-medium">
                        {activation.bloodGroup} {activation.component} — {activation.unitsNeeded} unit(s) needed
                      </p>
                      <p className="text-grey-500 text-xs">
                        Targeting {activation.targetDonorCount} donor(s) within {activation.radiusKm} km · expires {new Date(activation.expiresAt).toLocaleString()}
                      </p>
                    </div>
                    <StatusBadge tone={activation.status === 'ACTIVE' ? 'warning' : activation.status === 'CANCELLED' ? 'neutral' : 'ok'} label={activation.status} />
                  </header>
                  <div className="flex flex-col gap-3 p-5">
                    <div className="grid grid-cols-3 gap-3 text-sm sm:grid-cols-5">
                      <Stat label="No response" value={activation.recipients.byResponse.NO_RESPONSE} />
                      <Stat label="Willing" value={activation.recipients.byResponse.WILLING} />
                      <Stat label="Declined" value={activation.recipients.byResponse.DECLINED} />
                      <Stat label="Notified" value={activation.recipients.byNotificationStatus.SENT + activation.recipients.byNotificationStatus.DELIVERED} />
                      <Stat label="Not reachable" value={activation.recipients.byNotificationStatus.FAILED} />
                    </div>

                    {activation.willingDonors.length > 0 && (
                      <div className="bg-grey-25 rounded-md border p-3">
                        <p className="text-grey-500 text-xs font-semibold tracking-wide uppercase">Willing donors</p>
                        <ul className="mt-1 flex flex-col gap-1 text-sm">
                          {activation.willingDonors.map((w) => (
                            <li key={w.recipientId}>
                              {w.donor.fullName} · {w.distanceKm} km · {w.donor.phone ?? w.donor.email ?? 'no contact on file'}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {activation.status === 'ACTIVE' && (
                      <div className="flex gap-2">
                        <Button size="sm" disabled={busy === activation.id} onClick={() => withBusy(activation.id, () => notifyDonorActivation(activation.id))}>
                          Notify donors
                        </Button>
                        <Button size="sm" variant="destructive" disabled={busy === activation.id} onClick={() => withBusy(activation.id, () => cancelDonorActivation(activation.id))}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </StateBoundary>
      </div>
    </AppShell>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-grey-500 text-xs">{label}</p>
      <p className="text-grey-900 text-data font-semibold">{value}</p>
    </div>
  );
}
