import { LockKeyhole, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import type { ResourceState } from '@/hooks/useResource';
import { cn } from '@/lib/utils';

/**
 * Renders the four states every data-backed section must show (loading, empty, error, unauthorized),
 * or the content once the resource is ready. Kept deliberately plain, in the same voice as the rest
 * of the design (icon + text, never colour alone).
 */
export function StateBoundary<T>({
  state,
  onRetry,
  empty,
  skeletonClassName,
  children,
}: {
  state: ResourceState<T>;
  onRetry?: () => void;
  empty?: ReactNode;
  skeletonClassName?: string;
  children: (data: T) => ReactNode;
}) {
  if (state.status === 'loading') {
    return (
      <div className={cn('flex flex-col gap-2', skeletonClassName)} role="status" aria-label="Loading">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (state.status === 'unauthorized') {
    return (
      <div className="text-grey-500 flex flex-col items-center gap-2 py-8 text-center text-sm">
        <LockKeyhole className="text-grey-300 size-6" aria-hidden="true" />
        <p>You don't have permission to see this.</p>
        <p className="text-grey-400 text-xs">{state.message}</p>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="text-grey-500 flex flex-col items-center gap-2 py-8 text-center text-sm">
        <TriangleAlert className="text-status-critical size-6" aria-hidden="true" />
        <p>{state.message}</p>
        {onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  if (state.status === 'empty') {
    return <>{empty ?? <p className="text-grey-500 py-8 text-center text-sm">Nothing here yet.</p>}</>;
  }
  return <>{children(state.data)}</>;
}
