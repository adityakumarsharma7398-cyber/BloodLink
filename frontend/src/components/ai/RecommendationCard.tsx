import { Check, Clock, Loader2, PencilLine, ShieldCheck, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { ExplanationSection } from '@/components/ai/ExplanationSection';
import { DataList, type DataPoint } from '@/components/data/DataList';
import { RiskBadge } from '@/components/status/RiskBadge';
import { StatusBadge } from '@/components/status/StatusBadge';
import { Button } from '@/components/ui/button';
import type { RiskLevel, StatusTone } from '@/design/risk';
import { cn } from '@/lib/utils';
import type { RecommendationDecision, RecommendationStatus } from '@/types/ai';

export interface RecommendationCardProps {
  /** WHAT — the recommended action, e.g. "Transfer 24 O− PRBC units". */
  title: string;
  /** Scope line under the title, e.g. "Centre North → ABC Hospital". */
  subtitle?: ReactNode;
  /** WHY — reasons, each derived from data. */
  why: ReactNode[];
  /** WHAT DATA — the figures the recommendation was computed from. */
  data: DataPoint[];
  /** WHAT ACTION — what happens if an authorized user approves. */
  action: ReactNode;
  status: RecommendationStatus;
  risk?: RiskLevel;
  /** Decision in flight, to show progress on the pressed button. */
  pendingDecision?: RecommendationDecision | null;
  onDecision?: (decision: RecommendationDecision) => void;
  /** Shown once decided, e.g. "by R. Mehta · 14:02". */
  decisionNote?: ReactNode;
  className?: string;
}

const STATUS: Record<RecommendationStatus, { label: string; tone: StatusTone }> = {
  PENDING: { label: 'Pending review', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'ok' },
  MODIFIED: { label: 'Approved with changes', tone: 'ok' },
  REJECTED: { label: 'Rejected', tone: 'neutral' },
  EXPIRED: { label: 'Expired', tone: 'neutral' },
  EXECUTED: { label: 'Executed', tone: 'ok' },
};

/**
 * A recommendation for human review. BloodLink recommends; only an authorized person can
 * approve, modify or reject.
 */
export function RecommendationCard({
  title,
  subtitle,
  why,
  data,
  action,
  status,
  risk,
  pendingDecision = null,
  onDecision,
  decisionNote,
  className,
}: RecommendationCardProps) {
  const isPending = status === 'PENDING';
  const busy = pendingDecision !== null;

  const decisionButton = (decision: RecommendationDecision, label: string, icon: ReactNode, variant: 'default' | 'secondary' | 'destructive') => (
    <Button
      variant={variant}
      disabled={!isPending || busy || !onDecision}
      onClick={() => onDecision?.(decision)}
      aria-busy={pendingDecision === decision}
    >
      {pendingDecision === decision ? <Loader2 className="animate-spin" aria-hidden="true" /> : icon}
      {label}
    </Button>
  );

  return (
    <article className={cn('rounded-lg border bg-white shadow-card', risk === 'critical' && isPending && 'border-l-4 border-l-red-600', className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {risk && <RiskBadge level={risk} />}
          <StatusBadge tone={STATUS[status].tone} label={STATUS[status].label} icon={isPending ? Clock : undefined} />
        </div>
        {decisionNote && !isPending && <p className="text-grey-500 text-xs">{decisionNote}</p>}
      </header>

      <div className="grid gap-5 px-5 py-4 md:grid-cols-2 xl:grid-cols-[1fr_1.2fr_1.35fr_1fr]">
        <ExplanationSection kind="what">
          <h3 className="text-base leading-snug">{title}</h3>
          {subtitle && <p className="text-grey-500 mt-0.5">{subtitle}</p>}
        </ExplanationSection>
        <ExplanationSection kind="why">
          <ul className="flex list-disc flex-col gap-1 pl-4 marker:text-grey-300">
            {why.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </ExplanationSection>
        <ExplanationSection kind="data">
          <DataList items={data} className="-my-1" />
        </ExplanationSection>
        <ExplanationSection kind="action">{action}</ExplanationSection>
      </div>

      {isPending && (
        <footer className="bg-grey-25 flex flex-col gap-3 rounded-b-lg border-t px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-grey-500 flex items-center gap-1.5 text-xs">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Requires approval by an authorized user.
          </p>
          <div className="flex flex-wrap gap-2">
            {decisionButton('reject', 'Reject', <X aria-hidden="true" />, 'destructive')}
            {decisionButton('modify', 'Modify', <PencilLine aria-hidden="true" />, 'secondary')}
            {decisionButton('approve', 'Approve', <Check aria-hidden="true" />, 'default')}
          </div>
        </footer>
      )}
    </article>
  );
}
