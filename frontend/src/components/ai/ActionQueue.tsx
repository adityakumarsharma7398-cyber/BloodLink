import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { RISK, TONE_TEXT, type RiskLevel } from '@/design/risk';
import { cn } from '@/lib/utils';

export interface ActionQueueItem {
  id: string;
  level: RiskLevel;
  title: string;
  detail?: ReactNode;
  href?: string;
}

/** "Needs your attention" list. Each item links to the reasoning behind it. */
export function ActionQueue({ items, className }: { items: ActionQueueItem[]; className?: string }) {
  if (items.length === 0) {
    return <p className={cn('text-grey-500 py-2 text-sm', className)}>Nothing needs your attention right now.</p>;
  }
  return (
    <ul className={cn('divide-y', className)}>
      {items.map((item) => {
        const risk = RISK[item.level];
        const Icon = risk.icon;
        return (
          <li key={item.id}>
            <a href={item.href ?? '#'} className="group hover:bg-grey-25 -mx-2 flex items-center gap-3 rounded-md px-2 py-3">
              <Icon className={cn('size-[18px] shrink-0', TONE_TEXT[risk.tone])} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="text-grey-900 block text-sm font-medium">{item.title}</span>
                {item.detail && <span className="text-grey-500 block text-xs">{item.detail}</span>}
              </span>
              <span className="sr-only">{risk.label}</span>
              <ChevronRight className="text-grey-300 group-hover:text-grey-500 size-4 shrink-0" aria-hidden="true" />
            </a>
          </li>
        );
      })}
    </ul>
  );
}
