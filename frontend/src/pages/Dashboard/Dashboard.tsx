import { ClipboardList, Droplet, TimerReset, TriangleAlert } from 'lucide-react';
import { useMemo } from 'react';
import { ActionQueue, type ActionQueueItem } from '@/components/ai/ActionQueue';
import { ConnectedRecommendationCard } from '@/components/ai/ConnectedRecommendationCard';
import { InsightPanel } from '@/components/ai/InsightPanel';
import { AppShell } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { MetricTile } from '@/components/data/MetricTile';
import { StateBoundary } from '@/components/data/StateBoundary';
import { PRIORITY_TO_RISK } from '@/lib/recommendationView';
import { useAuth } from '@/lib/auth';
import { INVENTORY_READ_ROLES, visibleNavItems } from '@/lib/roles';
import { useResource } from '@/hooks/useResource';
import { getInventorySummary } from '@/services/inventory';
import { getPredictions, getRecommendations } from '@/services/intelligence';

function Panel({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border bg-white shadow-card" aria-label={title}>
      <header className="flex items-center justify-between gap-2 border-b px-5 py-3">
        <h2 className="text-base">{title}</h2>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

/** Live organization overview: inventory, the top shortage prediction, and recommendations awaiting a decision. */
export function Dashboard() {
  const { me, loadingMe, singleFacility } = useAuth();
  const facilityId = singleFacility?.id;
  // Inventory, predictions and recommendations are blood-centre-side data (backend-enforced); a
  // hospital-only identity can never read them, so those widgets are not even requested for one —
  // showing a page of "you don't have permission" boxes on first login is not a useful overview.
  const canSeeInventory = (me?.roles ?? []).some((grant) => (INVENTORY_READ_ROLES as readonly string[]).includes(grant.role));

  const summary = useResource(() => getInventorySummary(facilityId), [facilityId], { isEmpty: (r) => r.data.length === 0, enabled: canSeeInventory });
  const shortages = useResource(
    () => getPredictions({ facilityId, predictionType: 'SHORTAGE', pageSize: 25 }),
    [facilityId],
    { isEmpty: (r) => r.data.length === 0, enabled: canSeeInventory },
  );
  const recommendations = useResource(
    () => getRecommendations({ facilityId, status: 'PENDING', pageSize: 10 }),
    [facilityId],
    { isEmpty: (r) => r.data.length === 0, enabled: canSeeInventory },
  );

  const totals = useMemo(() => {
    if (summary.status !== 'ready') return null;
    const rows = summary.data.data;
    return {
      units: rows.reduce((sum, r) => sum + r.quantities.onHand, 0),
      available: rows.reduce((sum, r) => sum + r.quantities.available, 0),
      shortageRisks: rows.filter((r) => r.shortage.status === 'SHORTAGE').length,
      expiring: rows.reduce((sum, r) => sum + (r.quantities.expiringSoon ?? 0), 0),
    };
  }, [summary]);

  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <AppShell
      activeId="overview"
      organization={me?.organization?.name ?? '—'}
      user={{ name: me?.user.fullName ?? '—', role: me?.roles[0]?.role ?? '—' }}
      navItems={visibleNavItems(me)}
    >
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <PageHeader
          title={`Good morning, ${me?.organization?.name ?? ''}`}
          description="Blood supply overview and items that need a decision."
          actions={<span className="text-grey-500 text-sm">{today}</span>}
        />

        {!loadingMe && !singleFacility && (
          <p className="bg-info-bg text-info rounded-md px-3 py-2 text-xs font-medium">
            {me && me.facilities.length > 1
              ? 'You hold roles at more than one facility; showing the network view. A facility picker is not built in this phase.'
              : 'No facility is linked to your account, so network-wide figures are shown where the backend allows it.'}
          </p>
        )}

        {canSeeInventory ? (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <MetricTile label="Blood inventory" icon={Droplet} value={totals ? totals.units : '—'} hint={totals ? `${totals.available} available` : undefined} />
              <MetricTile
                label="Shortage risks"
                icon={TriangleAlert}
                value={totals ? totals.shortageRisks : '—'}
                hint="Blood groups below target"
                hintTone="critical"
              />
              <MetricTile label="Expiring units" icon={TimerReset} value={totals ? totals.expiring : '—'} hint="Within the configured window" hintTone="warning" />
              <MetricTile
                label="Pending recommendations"
                icon={ClipboardList}
                value={recommendations.status === 'ready' ? recommendations.data.pagination.total : recommendations.status === 'empty' ? 0 : '—'}
              />
            </div>

            <Panel title="Shortage prediction">
              <StateBoundary state={shortages} onRetry={shortages.refetch} empty={<p className="text-grey-500 text-sm">No current shortage predictions.</p>}>
                {(page) => {
                  const top = [...page.data].sort((a, b) => (a.daysOfCover ?? Infinity) - (b.daysOfCover ?? Infinity))[0];
                  if (!top) return <p className="text-grey-500 text-sm">No current shortage predictions.</p>;
                  return (
                    <InsightPanel
                      prediction={`${top.bloodGroup} ${top.component} shortage predicted${top.daysOfCover !== null ? ` in ${top.daysOfCover.toFixed(1)} days` : ''}`}
                      risk={top.shortageRisk ? PRIORITY_TO_RISK[top.shortageRisk] : 'medium'}
                      reason={`Predicted daily demand of ${top.predictedDailyDemand ?? '—'} unit(s), horizon ${top.horizonDays} day(s).`}
                      figures={[
                        { label: 'Daily demand', value: top.predictedDailyDemand ?? '—' },
                        { label: 'Coverage', value: top.daysOfCover !== null ? `${top.daysOfCover.toFixed(1)} days` : 'Unknown' },
                        { label: 'Predicted qty', value: top.predictedQuantity ?? '—' },
                      ]}
                      recommendedAction="See recommendations below for the proposed action."
                      reviewHref="#recommendations"
                    />
                  );
                }}
              </StateBoundary>
            </Panel>

            <div className="grid gap-6 2xl:grid-cols-[2fr_1fr]">
              <section id="recommendations" className="scroll-mt-20 flex flex-col gap-4" aria-labelledby="recommendations-heading">
                <h2 id="recommendations-heading" className="text-base">
                  Needs your decision
                </h2>
                <StateBoundary state={recommendations} onRetry={recommendations.refetch}>
                  {(page) => (
                    <div className="flex flex-col gap-4">
                      {page.data.map((rec) => (
                        <ConnectedRecommendationCard key={rec.id} recommendation={rec} onDecided={() => { recommendations.refetch(); summary.refetch(); }} />
                      ))}
                    </div>
                  )}
                </StateBoundary>
              </section>

              <Panel title="Needs your attention">
                <StateBoundary state={summary} onRetry={summary.refetch}>
                  {(page) => {
                    const items: ActionQueueItem[] = page.data
                      .filter((row) => row.shortage.status === 'SHORTAGE' || row.expiry.status === 'AT_RISK')
                      .slice(0, 6)
                      .map((row) => ({
                        id: `${row.facility.id}-${row.bloodGroup.id}-${row.component.id}`,
                        level: row.shortage.status === 'SHORTAGE' ? PRIORITY_TO_RISK[row.shortage.riskLevel] : 'medium',
                        title: `${row.bloodGroup.code} ${row.component.code}${row.shortage.status === 'SHORTAGE' ? ' shortage' : ' expiring soon'}`,
                        detail:
                          row.shortage.status === 'SHORTAGE'
                            ? `${row.shortage.daysOfCover.toFixed(1)} days of coverage`
                            : `${row.expiry.expiringUnits} unit(s) within ${row.expiry.warningDays} days`,
                        href: '#recommendations',
                      }));
                    return <ActionQueue items={items} />;
                  }}
                </StateBoundary>
              </Panel>
            </div>
          </>
        ) : (
          <Panel title="Your requests">
            <p className="text-grey-600 text-sm">
              Blood inventory and recommendations belong to blood-centre staff. Use{' '}
              <a href="/app/requests" className="text-red-600 underline">
                Requests
              </a>{' '}
              to create and track blood requests for your facility.
            </p>
          </Panel>
        )}
      </div>
    </AppShell>
  );
}
