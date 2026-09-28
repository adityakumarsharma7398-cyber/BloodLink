import { cn } from '@/lib/utils';

interface ConfidenceIndicatorProps {
  /**
   * Model confidence in [0, 1]. Must come from the prediction engine's output
   * (docs/DECISIONS.md: no displayed confidence unless the implemented logic produced it).
   */
  value: number;
  /** The inputs the prediction was based on, e.g. "90 days of consumption". */
  basis: string[];
  className?: string;
}

/** Model confidence with the evidence behind it. */
export function ConfidenceIndicator({ value, basis, className }: ConfidenceIndicatorProps) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-grey-600">Model confidence</span>
        <span className="text-data text-grey-900 font-semibold">{percent}%</span>
      </div>
      <div
        className="bg-grey-100 h-1.5 overflow-hidden rounded-full"
        role="meter"
        aria-label="Model confidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="bg-grey-600 h-full rounded-full" style={{ width: `${percent}%` }} />
      </div>
      {basis.length > 0 && <p className="text-grey-500 text-xs">Based on: {basis.join(' · ')}</p>}
    </div>
  );
}
