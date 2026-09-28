import { ClipboardList, Droplet, Info, TimerReset, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ActionQueue } from '@/components/ai/ActionQueue';
import { InsightPanel } from '@/components/ai/InsightPanel';
import { RecommendationCard } from '@/components/ai/RecommendationCard';
import { AppShell } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { MetricTile } from '@/components/data/MetricTile';
import { StatusBadge } from '@/components/status/StatusBadge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { StatusTone } from '@/design/risk';
import type { RecommendationDecision, RecommendationStatus } from '@/types/ai';
import { O_NEG_RECOMMENDATION as rec, PRBC_STOCK, RECENT_UNITS, TARGET_COVER_DAYS, TOTALS, coverageDays, targetUnits, type UnitStatus } from './exampleData';

const UNIT_STATUS_TONE: Record<UnitStatus, StatusTone> = { Available: 'ok', Reserved: 'neutral', Quarantined: 'warning' };

const fmt = (value: number) => value.toFixed(1);
const aNeg = PRBC_STOCK.find((row) => row.group === 'A−')!;

function Panel({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`min-w-0 rounded-lg border bg-white shadow-card ${className ?? ''}`} aria-label={title}>
      <header className="flex items-center justify-between gap-2 border-b px-5 py-3">
        <h2 className="text-base">{title}</h2>
        {action}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

/** Style preview of the organization overview. All values come from ./exampleData. */
export function DashboardPreview() {
  const [status, setStatus] = useState<RecommendationStatus>('PENDING');
  const [pending, setPending] = useState<RecommendationDecision | null>(null);

  // Preview only: simulates the decision round-trip so the card's states can be reviewed.
  const decide = (decision: RecommendationDecision) => {
    setPending(decision);
    window.setTimeout(() => {
      setPending(null);
      setStatus(decision === 'approve' ? 'APPROVED' : decision === 'modify' ? 'MODIFIED' : 'REJECTED');
    }, 600);
  };

  const chartData = PRBC_STOCK.map((row) => ({ group: row.group, Available: row.available, Target: targetUnits(row) }));
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <AppShell activeId="overview" organization="ABC Hospital" user={{ name: 'Dr. Sharma', role: 'Hospital Admin' }} unreadAlerts={3}>
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <p className="bg-info-bg text-info flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium">
          <Info className="size-4 shrink-0" aria-hidden="true" />
          Design preview with example data. Live figures are connected in a later phase.
        </p>

        <PageHeader
          title="Good morning, ABC Hospital"
          description="Blood supply overview and items that need a decision."
          actions={<span className="text-grey-500 text-sm">{today}</span>}
        />

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <MetricTile label="Blood inventory" icon={Droplet} value={TOTALS.units} hint={`${TOTALS.available} available · PRBC`} />
          <MetricTile label="Pending requests" icon={ClipboardList} value={TOTALS.pendingRequests} hint={`${TOTALS.urgentRequests} urgent`} hintTone="critical" />
          <MetricTile label="Shortage risks" icon={TriangleAlert} value={TOTALS.shortageRisks} hint="Blood groups below target" hintTone="critical" />
          <MetricTile label="Expiring units" icon={TimerReset} value={TOTALS.expiring} hint="Within 7 days" hintTone="warning" />
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
          <Panel title="Shortage prediction" action={<a href="#recommendation" className="text-sm font-medium text-red-600 hover:underline">View all</a>}>
            <InsightPanel
              prediction={`${rec.group} PRBC shortage predicted in ${fmt(rec.coverage)} days`}
              risk="critical"
              reason={`Demand of ${fmt(rec.demandPerDay)} units/day will use the ${rec.available} available units before the ${TARGET_COVER_DAYS}-day cover target.`}
              figures={[
                { label: 'Available', value: `${rec.available} units` },
                { label: 'Predicted demand', value: `${fmt(rec.demandPerDay)} / day` },
                { label: 'Coverage', value: `${fmt(rec.coverage)} days` },
              ]}
              recommendedAction={`Transfer ${rec.transferUnits} ${rec.group} PRBC units from ${rec.source}`}
              reviewHref="#recommendation"
            />
          </Panel>

          <Panel title="PRBC stock vs. 7-day target" action={<span className="text-grey-500 text-xs">Units</span>}>
            <div className="h-64" role="img" aria-label={`Available PRBC units compared with the ${TARGET_COVER_DAYS}-day target for each blood group`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} barGap={2} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#eef0f3" />
                  <XAxis dataKey="group" tickLine={false} axisLine={{ stroke: '#e3e6ea' }} tick={{ fill: '#6b7280', fontSize: 12 }} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fill: '#6b7280', fontSize: 12 }} />
                  <Tooltip cursor={{ fill: '#f6f7f9' }} contentStyle={{ borderRadius: 6, borderColor: '#e3e6ea', fontSize: 12 }} />
                  <Legend iconType="square" iconSize={10} wrapperStyle={{ fontSize: 12, color: '#4b5563' }} />
                  <Bar dataKey="Available" fill="#c8102e" radius={[2, 2, 0, 0]} maxBarSize={18} isAnimationActive={false} />
                  <Bar dataKey="Target" fill="#cfd4db" radius={[2, 2, 0, 0]} maxBarSize={18} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        </div>

        <div className="grid gap-6 2xl:grid-cols-[2fr_1fr]">
          <Panel
            title="Recent inventory units"
            action={
              <Button variant="secondary" size="sm" asChild>
                <a href="/app/inventory">View inventory</a>
              </Button>
            }
            className="[&>div]:p-0"
          >
            <Table>
              <TableHeader className="bg-grey-25">
                <TableRow>
                  {['Unit ID', 'Blood group', 'Component', 'Status', 'Expiry', 'Location'].map((heading) => (
                    <TableHead key={heading} className="text-grey-500 h-10 px-5 text-xs font-semibold">
                      {heading}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody className="text-data">
                {RECENT_UNITS.map((unit) => (
                  <TableRow key={unit.unitCode}>
                    <TableCell className="text-grey-900 px-5 font-medium">{unit.unitCode}</TableCell>
                    <TableCell className="px-5">{unit.group}</TableCell>
                    <TableCell className="px-5">{unit.component}</TableCell>
                    <TableCell className="px-5">
                      <StatusBadge tone={UNIT_STATUS_TONE[unit.status]} label={unit.status} />
                    </TableCell>
                    <TableCell className="px-5">
                      {unit.expires}
                      {unit.daysToExpiry <= 7 && (
                        <span className="text-status-warning ml-2 text-xs font-medium">{unit.daysToExpiry} days</span>
                      )}
                    </TableCell>
                    <TableCell className="text-grey-600 px-5">{unit.location}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>

          <Panel title="Needs your attention">
            <ActionQueue
              className="-my-3"
              items={[
                { id: 'a1', level: 'critical', title: `${rec.group} PRBC shortage predicted`, detail: `${fmt(rec.coverage)} days of coverage`, href: '#recommendation' },
                { id: 'a2', level: aNeg.risk, title: `${aNeg.group} PRBC below target`, detail: `${fmt(coverageDays(aNeg))} days of coverage` },
                { id: 'a3', level: 'medium', title: `${TOTALS.expiring} units expiring within 7 days`, detail: 'Use first-expiring units first' },
              ]}
            />
          </Panel>
        </div>

        <section id="recommendation" className="scroll-mt-20" aria-labelledby="recommendation-heading">
          <h2 id="recommendation-heading" className="mb-3 text-base">
            Recommendation for review
          </h2>
          <RecommendationCard
            title={`Transfer ${rec.transferUnits} ${rec.group} PRBC units`}
            subtitle={`${rec.source} → ABC Hospital`}
            risk="critical"
            why={[
              `ABC Hospital has ${fmt(rec.coverage)} days of ${rec.group} coverage against a ${TARGET_COVER_DAYS}-day target.`,
              `${rec.source} holds ${fmt(rec.sourceCoverage)} days at its own demand.`,
            ]}
            data={[
              { label: 'Available here', value: `${rec.available} units` },
              { label: 'Predicted demand', value: `${fmt(rec.demandPerDay)} / day` },
              { label: 'Coverage after', value: `${fmt(rec.coverageAfter)} days`, emphasis: true },
              { label: 'Source after transfer', value: `${fmt(rec.sourceCoverageAfter)} days` },
              { label: 'Estimated transit', value: `${rec.transitMinutes} min` },
            ]}
            action={`Send a transfer request to ${rec.source} for confirmation and dispatch by its blood bank staff.`}
            status={status}
            pendingDecision={pending}
            onDecision={decide}
            decisionNote="Preview decision"
          />
          {status !== 'PENDING' && (
            <Button variant="link" size="sm" className="mt-2" onClick={() => setStatus('PENDING')}>
              Reset preview
            </Button>
          )}
        </section>
      </div>
    </AppShell>
  );
}
