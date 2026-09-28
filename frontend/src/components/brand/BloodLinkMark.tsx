import { cn } from '@/lib/utils';

/** BloodLink logo: a red drop with a simple wordmark. */
export function BloodLinkMark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <svg viewBox="0 0 32 32" className="size-7 shrink-0" aria-hidden="true">
        <path d="M16 3c5 6.6 8.5 11.3 8.5 15.8a8.5 8.5 0 0 1-17 0C7.5 14.3 11 9.6 16 3z" fill="#C8102E" />
        <path d="M12.2 19.5a4 4 0 0 0 3.8 3.3" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" fill="none" opacity=".9" />
      </svg>
      {!compact && (
        <span className="text-[19px] font-bold tracking-tight">
          <span className="text-grey-900">Blood</span>
          <span className="text-red-600">Link</span>
        </span>
      )}
    </span>
  );
}
