import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type ExplanationKind = 'what' | 'why' | 'data' | 'action';

const HEADINGS: Record<ExplanationKind, string> = {
  what: 'What',
  why: 'Why',
  data: 'Data',
  action: 'Action',
};

/** One of the four questions every recommendation answers: WHAT, WHY, WHAT DATA, WHAT ACTION. */
export function ExplanationSection({ kind, children, className }: { kind: ExplanationKind; children: ReactNode; className?: string }) {
  return (
    <section aria-label={HEADINGS[kind]} className={cn('min-w-0', className)}>
      <h4 className="text-grey-500 text-xs font-semibold tracking-wide uppercase">{HEADINGS[kind]}</h4>
      <div className="text-grey-900 mt-1.5 text-sm leading-relaxed">{children}</div>
    </section>
  );
}
