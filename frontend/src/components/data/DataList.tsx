import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface DataPoint {
  label: string;
  value: ReactNode;
  /** Emphasise the figure that drives the conclusion (e.g. Coverage). */
  emphasis?: boolean;
}

/** Label/value rows for operational figures. */
export function DataList({ items, className }: { items: DataPoint[]; className?: string }) {
  return (
    <dl className={cn('text-sm', className)}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline justify-between gap-4 py-1">
          <dt className="text-grey-500">{item.label}</dt>
          <dd className={cn('text-data text-right whitespace-nowrap', item.emphasis ? 'text-grey-900 font-semibold' : 'text-grey-900')}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
