import { useState, type FormEvent } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { visibleNavItems } from '@/lib/roles';
import { PageHeader } from '@/components/layout/PageHeader';
import { StateBoundary } from '@/components/data/StateBoundary';
import { StatusBadge } from '@/components/status/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/lib/auth';
import { useResource } from '@/hooks/useResource';
import type { EmergencyRequest } from '@/services/emergency';
import {
  confirmHolds, createEmergencyRequest, declineHolds, decideSourceSelection, getIncomingHolds, listEmergencyRequests, selectSources,
} from '@/services/emergency';
import { createRoutineRequest, listRoutineRequests } from '@/services/routineRequests';
import { getBloodGroups, getComponents } from '@/services/reference';

const URGENCY = ['CRITICAL', 'HIGH', 'NORMAL'] as const;

interface NewInput {
  facilityId: string;
  bloodGroupId: number;
  componentId: number;
  quantity: number;
  urgency: (typeof URGENCY)[number];
  requiredBy: string;
}

/** A request-creation form; `create` and `submitLabel` decide whether it posts a routine or an emergency request. */
function RequestForm({
  facilityId, onCreated, create, submitLabel, defaultUrgency, defaultQuantity,
}: {
  facilityId: string;
  onCreated: () => void;
  create: (input: NewInput) => Promise<unknown>;
  submitLabel: string;
  defaultUrgency: (typeof URGENCY)[number];
  defaultQuantity: number;
}) {
  const groups = useResource(() => getBloodGroups(), []);
  const components = useResource(() => getComponents(), []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formEl = event.currentTarget; // captured now — React nulls the synthetic event's fields once this handler yields on the await below
    const form = new FormData(formEl);
    setSubmitting(true);
    setError(null);
    try {
      await create({
        facilityId,
        bloodGroupId: Number(form.get('bloodGroupId')),
        componentId: Number(form.get('componentId')),
        quantity: Number(form.get('quantity')),
        urgency: form.get('urgency') as (typeof URGENCY)[number],
        requiredBy: new Date(String(form.get('requiredBy'))).toISOString(),
      });
      formEl.reset();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the request');
    } finally {
      setSubmitting(false);
    }
  };

  if (groups.status !== 'ready' || components.status !== 'ready') {
    return (
      <StateBoundary state={groups.status === 'ready' ? components : groups} onRetry={groups.refetch}>
        {() => null}
      </StateBoundary>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4 rounded-lg border bg-white p-5 shadow-card sm:grid-cols-2 lg:grid-cols-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="bloodGroupId">Blood group</Label>
        <Select name="bloodGroupId" defaultValue={String(groups.data.data[0]?.id)}>
          <SelectTrigger id="bloodGroupId" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groups.data.data.map((g) => (
              <SelectItem key={g.id} value={String(g.id)}>
                {g.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="componentId">Component</Label>
        <Select name="componentId" defaultValue={String(components.data.data[0]?.id)}>
          <SelectTrigger id="componentId" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {components.data.data.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="quantity">Quantity</Label>
        <Input id="quantity" name="quantity" type="number" min={1} defaultValue={defaultQuantity} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="urgency">Urgency</Label>
        <Select name="urgency" defaultValue={defaultUrgency}>
          <SelectTrigger id="urgency" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {URGENCY.map((u) => (
              <SelectItem key={u} value={u}>
                {u}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="requiredBy">Required by</Label>
        <Input id="requiredBy" name="requiredBy" type="datetime-local" required />
      </div>
      <div className="lg:col-span-5">
        {error && <p className="text-status-critical mb-2 text-sm">{error}</p>}
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Submitting…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** A request list shared by the routine and emergency sections; only emergency requests carry a source-selection action. */
function RequestList({
  requests, busy, onFindSources, onDecide,
}: {
  requests: ReturnType<typeof useResource<{ data: EmergencyRequest[]; pagination: unknown }>>;
  busy: string | null;
  onFindSources?: (requestId: string) => void;
  onDecide?: (recommendationId: string, decision: 'APPROVE' | 'REJECT') => void;
}) {
  return (
    <StateBoundary state={requests} onRetry={requests.refetch}>
      {(page) => (
        <div className="flex flex-col gap-4">
          {page.data.map((req) => (
            <article key={req.id} className="rounded-lg border bg-white shadow-card">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
                <div>
                  <p className="text-grey-900 font-medium">
                    {req.requestNumber}{' '}
                    <span className="text-grey-500 text-xs font-normal">{req.type === 'EMERGENCY' ? 'Emergency' : 'Routine'}</span>
                  </p>
                  <p className="text-grey-500 text-xs">Required by {new Date(req.requiredBy).toLocaleString()}</p>
                </div>
                <StatusBadge tone={req.urgency === 'CRITICAL' ? 'critical' : req.urgency === 'HIGH' ? 'warning' : 'neutral'} label={req.status} />
              </header>
              <div className="p-5">
                {req.items.map((item) => (
                  <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-1 text-sm">
                    <span>
                      {item.bloodGroup} {item.component} — {item.quantityRemaining} of {item.quantityRequested} remaining
                    </span>
                    {item.holds.length > 0 && (
                      <span className="text-grey-500 text-xs">
                        {item.holds.map((h) => `${h.source.name}: ${h.status} (${h.quantity})`).join(', ')}
                      </span>
                    )}
                  </div>
                ))}
                {onFindSources && onDecide && (
                  req.sourceSelection ? (
                    <div className="bg-grey-25 mt-3 rounded-md border p-3 text-sm">
                      <p className="text-grey-500 text-xs">A source selection is pending your decision.</p>
                      <div className="mt-2 flex gap-2">
                        <Button size="sm" disabled={busy === req.sourceSelection.recommendationId} onClick={() => onDecide(req.sourceSelection!.recommendationId, 'APPROVE')}>
                          Approve top source
                        </Button>
                        <Button size="sm" variant="destructive" disabled={busy === req.sourceSelection.recommendationId} onClick={() => onDecide(req.sourceSelection!.recommendationId, 'REJECT')}>
                          Reject
                        </Button>
                      </div>
                    </div>
                  ) : (
                    req.status === 'OPEN' && (
                      <Button size="sm" variant="secondary" className="mt-3" disabled={busy === req.id} onClick={() => onFindSources(req.id)}>
                        {busy === req.id ? 'Finding sources…' : 'Find sources'}
                      </Button>
                    )
                  )
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </StateBoundary>
  );
}

/**
 * Requests: hospital staff/doctors create and track their own routine requests; emergency staff run
 * the emergency workflow (find sources, decide a hold); blood-bank staff see incoming holds. Each
 * section is shown only to the roles the backend actually authorizes for that action.
 */
export function Requests() {
  const { me, hasRole, singleFacility } = useAuth();
  const facilityId = singleFacility?.id;
  const isRoutineRequester = hasRole('HOSPITAL_STAFF') || hasRole('DOCTOR');
  const isEmergencyRequester = hasRole('EMERGENCY_STAFF');
  const isSource = hasRole('BLOOD_BANK_ADMIN') || hasRole('BLOOD_BANK_STAFF');

  const routineRequests = useResource(
    () => listRoutineRequests({ facilityId, pageSize: 25 }),
    [facilityId],
    { isEmpty: (r) => r.data.length === 0, enabled: isRoutineRequester },
  );
  const emergencyRequests = useResource(
    () => listEmergencyRequests({ facilityId, pageSize: 25 }),
    [facilityId],
    { isEmpty: (r) => r.data.length === 0, enabled: isEmergencyRequester },
  );
  const incoming = useResource(() => getIncomingHolds(facilityId), [facilityId], { isEmpty: (r) => r.data.length === 0, enabled: isSource });
  const [busy, setBusy] = useState<string | null>(null);

  const runSelection = async (requestId: string) => {
    setBusy(requestId);
    try {
      await selectSources(requestId);
      emergencyRequests.refetch();
    } finally {
      setBusy(null);
    }
  };
  const decide = async (recommendationId: string, decision: 'APPROVE' | 'REJECT') => {
    setBusy(recommendationId);
    try {
      await decideSourceSelection(recommendationId, decision === 'REJECT' ? { decision, note: 'Not proceeding' } : { decision });
      emergencyRequests.refetch();
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppShell activeId="requests" organization={me?.organization?.name ?? '—'} user={{ name: me?.user.fullName ?? '—', role: me?.roles[0]?.role ?? '—' }} navItems={visibleNavItems(me)}>
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <PageHeader title="Requests" description="Create and track blood requests for your facility." />

        {isRoutineRequester && (
          <section className="flex flex-col gap-4" aria-label="Routine blood requests">
            <h2 className="text-base">Create blood request</h2>
            {facilityId ? (
              <RequestForm
                facilityId={facilityId}
                onCreated={routineRequests.refetch}
                create={createRoutineRequest}
                submitLabel="Submit request"
                defaultUrgency="NORMAL"
                defaultQuantity={1}
              />
            ) : (
              <p className="bg-info-bg text-info rounded-md px-3 py-2 text-xs font-medium">Creating a request needs one linked facility.</p>
            )}
            <h2 className="text-base">Your requests</h2>
            <RequestList requests={routineRequests} busy={busy} />
          </section>
        )}

        {isEmergencyRequester && (
          <section className="flex flex-col gap-4" aria-label="Emergency requests">
            <h2 className="text-base">Emergency requests</h2>
            <p className="text-grey-500 -mt-2 text-xs">Request, find sources, and place a temporary hold — nothing is released automatically.</p>
            {facilityId ? (
              <RequestForm
                facilityId={facilityId}
                onCreated={emergencyRequests.refetch}
                create={createEmergencyRequest}
                submitLabel="Submit emergency request"
                defaultUrgency="CRITICAL"
                defaultQuantity={2}
              />
            ) : (
              <p className="bg-info-bg text-info rounded-md px-3 py-2 text-xs font-medium">Creating a request needs one linked facility.</p>
            )}
            <RequestList requests={emergencyRequests} busy={busy} onFindSources={runSelection} onDecide={decide} />
          </section>
        )}

        {isSource && (
          <section className="flex flex-col gap-4" aria-label="Incoming holds">
            <h2 className="text-base">Incoming holds</h2>
            <StateBoundary state={incoming} onRetry={incoming.refetch}>
              {(page) => (
                <div className="overflow-hidden rounded-lg border bg-white shadow-card">
                  <Table>
                    <TableHeader className="bg-grey-25">
                      <TableRow>
                        {['Request', 'Destination', 'Blood group', 'Component', 'Qty', 'Status', ''].map((h) => (
                          <TableHead key={h} className="text-grey-500 h-10 px-5 text-xs font-semibold">
                            {h}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {page.data.map((hold) => (
                        <TableRow key={hold.allocationIds.join(',')}>
                          <TableCell className="px-5">{hold.requestNumber}</TableCell>
                          <TableCell className="px-5">{hold.destinationFacility.name}</TableCell>
                          <TableCell className="px-5">{hold.bloodGroup}</TableCell>
                          <TableCell className="px-5">{hold.component}</TableCell>
                          <TableCell className="px-5">{hold.quantity}</TableCell>
                          <TableCell className="px-5">
                            <StatusBadge tone={hold.status === 'RESERVED' ? 'warning' : 'ok'} label={hold.status} />
                          </TableCell>
                          <TableCell className="px-5">
                            {hold.status === 'RESERVED' && (
                              <div className="flex gap-2">
                                <Button size="sm" onClick={() => confirmHolds(hold.allocationIds).then(incoming.refetch)}>
                                  Confirm
                                </Button>
                                <Button size="sm" variant="destructive" onClick={() => declineHolds(hold.allocationIds, 'Not available').then(incoming.refetch)}>
                                  Decline
                                </Button>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </StateBoundary>
          </section>
        )}
      </div>
    </AppShell>
  );
}
