import { ArrowRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { RiskBadge } from '@/components/status/RiskBadge';
import { Button } from '@/components/ui/button';
import type { RiskLevel } from '@/design/risk';
import { cn } from '@/lib/utils';

export interface InsightFigure {
  label: string;
  value: ReactNode;
}

interface InsightPanelProps {
  /** The prediction, stated plainly, e.g. "O− PRBC shortage predicted in 2.8 days". */
  prediction: string;
  risk: RiskLevel;
  /** Why the prediction was made. */
  reason: ReactNode;
  /** The key figures behind it. */
  figures: InsightFigure[];
  /** The recommended next step, e.g. "Transfer 24 units from Centre North". */
  recommendedAction: ReactNode;
  onReview?: () => void;
  reviewHref?: string;
  className?: string;
}

/**
 * Decision-support panel for the dashboard: prediction → reason → figures → recommended action.
 * Deliberately plain: it should read like a clinical report, not a marketing widget.
 */
export function InsightPanel({ prediction, risk, reason, figures, recommendedAction, onReview, reviewHref, className }: InsightPanelProps) {
  return (
    <article className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-base">{prediction}</h3>
        <RiskBadge level={risk} label={`${risk === 'critical' ? 'Critical' : risk === 'high' ? 'High' : risk === 'medium' ? 'Medium' : 'Low'} risk`} />
      </div>

      <div>
        <p className="text-grey-500 text-xs font-semibold tracking-wide uppercase">Why</p>
        <p className="text-grey-600 mt-1 text-sm">{reason}</p>
      </div>

      <dl className="bg-grey-50 grid grid-cols-3 divide-x rounded-md border">
        {figures.map((figure) => (
          <div key={figure.label} className="px-3 py-2.5">
            <dt className="text-grey-500 text-xs">{figure.label}</dt>
            <dd className="text-data text-grey-900 mt-0.5 text-sm font-semibold">{figure.value}</dd>
          </div>
        ))}
      </dl>

      <div>
        <p className="text-grey-500 text-xs font-semibold tracking-wide uppercase">Recommended action</p>
        <p className="text-grey-900 mt-1 text-sm font-medium">{recommendedAction}</p>
      </div>

      {(onReview || reviewHref) && (
        <div>
          {reviewHref ? (
            <Button asChild>
              <a href={reviewHref}>
                Review recommendation <ArrowRight aria-hidden="true" />
              </a>
            </Button>
          ) : (
            <Button onClick={onReview}>
              Review recommendation <ArrowRight aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
