import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { TONE_TEXT, type StatusTone } from '@/design/risk';
import { cn } from '@/lib/utils';

interface MetricTileProps {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  /** Supporting line, e.g. "2 urgent" or "within 7 days". */
  hint?: ReactNode;
  /** Colours the hint only; the number itself stays neutral. */
  hintTone?: StatusTone;
  href?: string;
  className?: string;
}

/** Compact operational metric: one number, one label, one supporting line. */
export function MetricTile({ label, value, icon: Icon, hint, hintTone, href, className }: MetricTileProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-grey-600 text-sm font-medium">{label}</p>
        {Icon && <Icon className="text-grey-500 size-5 shrink-0" aria-hidden="true" />}
      </div>
      <p className="text-data text-grey-900 mt-2 text-[28px] leading-none font-semibold">{value}</p>
      {hint && <p className={cn('mt-2 text-xs font-medium', hintTone ? TONE_TEXT[hintTone] : 'text-grey-500')}>{hint}</p>}
    </>
  );
  const classes = cn('block rounded-lg border bg-white p-4 shadow-card', href && 'transition-colors hover:border-grey-300', className);
  return href ? (
    <a href={href} className={classes}>
      {body}
    </a>
  ) : (
    <div className={classes}>{body}</div>
  );
}
