import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { visibleNavItems } from '@/lib/roles';
import { PageHeader } from '@/components/layout/PageHeader';
import { StateBoundary } from '@/components/data/StateBoundary';
import { StatusBadge } from '@/components/status/StatusBadge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { StatusTone } from '@/design/risk';
import { useAuth } from '@/lib/auth';
import { useResource } from '@/hooks/useResource';
import { getInventorySummary, getInventoryUnits } from '@/services/inventory';

const UNIT_TONE: Record<string, StatusTone> = {
  AVAILABLE: 'ok',
  RESERVED: 'neutral',
  QUARANTINED: 'warning',
  DISPATCHED: 'neutral',
  IN_TRANSIT: 'neutral',
  RECEIVED: 'neutral',
  ISSUED: 'neutral',
  RETURNED: 'warning',
  WASTED: 'critical',
  EXPIRED: 'critical',
};

/** Live inventory: per-facility summary by blood group/component, and the unit-level list. */
export function Inventory() {
  const { me, singleFacility } = useAuth();
  const [page, setPage] = useState(1);
  const facilityId = singleFacility?.id;

  const summary = useResource(() => getInventorySummary(facilityId), [facilityId], { isEmpty: (r) => r.data.length === 0 });
  const units = useResource(
    () => getInventoryUnits(facilityId!, { page, pageSize: 20 }),
    [facilityId, page],
    { isEmpty: (r) => r.data.length === 0, enabled: Boolean(facilityId) },
  );

  return (
    <AppShell activeId="inventory" organization={me?.organization?.name ?? '—'} user={{ name: me?.user.fullName ?? '—', role: me?.roles[0]?.role ?? '—' }} navItems={visibleNavItems(me)}>
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <PageHeader title="Inventory" description="Stock by blood group and component, and the units behind it." />

        {!facilityId && (
          <p className="bg-info-bg text-info rounded-md px-3 py-2 text-xs font-medium">
            Unit-level detail needs one facility. {me && me.facilities.length > 1 ? 'You hold roles at more than one; a facility picker is not built in this phase.' : 'No facility is linked to your account.'}
          </p>
        )}

        <section className="rounded-lg border bg-white shadow-card" aria-label="Summary">
          <header className="border-b px-5 py-3">
            <h2 className="text-base">Summary</h2>
          </header>
          <div className="[&>div]:p-0">
            <StateBoundary state={summary} onRetry={summary.refetch}>
              {(result) => (
                <Table>
                  <TableHeader className="bg-grey-25">
                    <TableRow>
                      {['Facility', 'Group', 'Component', 'On hand', 'Available', 'Reserved', 'Expiring soon', 'Cover'].map((h) => (
                        <TableHead key={h} className="text-grey-500 h-10 px-5 text-xs font-semibold">
                          {h}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody className="text-data">
                    {result.data.map((row) => (
                      <TableRow key={`${row.facility.id}-${row.bloodGroup.id}-${row.component.id}`}>
                        <TableCell className="px-5">{row.facility.name}</TableCell>
                        <TableCell className="px-5">{row.bloodGroup.code}</TableCell>
                        <TableCell className="px-5">{row.component.code}</TableCell>
                        <TableCell className="px-5">{row.quantities.onHand}</TableCell>
                        <TableCell className="px-5">{row.quantities.available}</TableCell>
                        <TableCell className="px-5">{row.quantities.reserved}</TableCell>
                        <TableCell className="px-5">{row.quantities.expiringSoon ?? '—'}</TableCell>
                        <TableCell className="px-5">
                          {row.shortage.status === 'UNKNOWN' ? (
                            <StatusBadge tone="neutral" label="Unknown" />
                          ) : (
                            <StatusBadge
                              tone={row.shortage.status === 'SHORTAGE' ? 'critical' : 'ok'}
                              label={`${row.shortage.daysOfCover.toFixed(1)} days`}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </StateBoundary>
          </div>
        </section>

        <section className="rounded-lg border bg-white shadow-card" aria-label="Units">
          <header className="flex items-center justify-between gap-2 border-b px-5 py-3">
            <h2 className="text-base">Units</h2>
            {units.status === 'ready' && (
              <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span className="text-grey-500 text-xs">
                  Page {units.data.pagination.page} of {units.data.pagination.totalPages}
                </span>
                <Button size="sm" variant="secondary" disabled={page >= units.data.pagination.totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            )}
          </header>
          <div className="[&>div]:p-0">
            {!facilityId ? (
              <p className="text-grey-500 p-5 text-sm">Select a facility to see individual units.</p>
            ) : (
              <StateBoundary state={units} onRetry={units.refetch}>
                {(pageData) => (
                  <Table>
                    <TableHeader className="bg-grey-25">
                      <TableRow>
                        {['Unit ID', 'Blood group', 'Component', 'Status', 'Expiry'].map((h) => (
                          <TableHead key={h} className="text-grey-500 h-10 px-5 text-xs font-semibold">
                            {h}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody className="text-data">
                      {pageData.data.map((unit) => (
                        <TableRow key={unit.id}>
                          <TableCell className="text-grey-900 px-5 font-medium">{unit.unitCode}</TableCell>
                          <TableCell className="px-5">{unit.bloodGroup.code}</TableCell>
                          <TableCell className="px-5">{unit.component.code}</TableCell>
                          <TableCell className="px-5">
                            <StatusBadge tone={UNIT_TONE[unit.status] ?? 'neutral'} label={unit.status} />
                          </TableCell>
                          <TableCell className="px-5">
                            {new Date(unit.expiryDate).toLocaleDateString()}
                            {unit.isExpired && <span className="text-status-critical ml-2 text-xs font-medium">Expired</span>}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </StateBoundary>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}
