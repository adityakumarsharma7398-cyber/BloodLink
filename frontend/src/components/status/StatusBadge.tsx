import type { LucideIcon } from 'lucide-react';
import { TONE_CLASSES, type StatusTone } from '@/design/risk';
import { cn } from '@/lib/utils';

interface StatusBadgeProps {
  tone: StatusTone;
  label: string;
  icon?: LucideIcon;
  className?: string;
}

/**
 * Small status chip for tables and lists (Available, Reserved, Expiring, Pending...).
 * The text label is always present, so status never depends on colour alone.
 */
export function StatusBadge({ tone, label, icon: Icon, className }: StatusBadgeProps) {
  return (
    <span
      data-tone={tone}
      className={cn(
        'inline-flex w-fit shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {Icon && <Icon className="size-3.5" aria-hidden="true" />}
      {label}
    </span>
  );
}
