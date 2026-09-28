import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, isUnauthorized } from '@/services/api';

export type ResourceState<T> =
  | { status: 'loading' }
  | { status: 'unauthorized'; message: string }
  | { status: 'error'; message: string }
  | { status: 'empty' }
  | { status: 'ready'; data: T };

/**
 * Fetches `fetcher()` whenever `deps` change, and reports one of the four states every page must
 * show: loading, error, unauthorized (signed in but not permitted — a 401/403 from the backend), or
 * ready. `isEmpty` decides whether a "ready" result with no rows should render as the empty state
 * instead. `enabled: false` holds off the request (e.g. until we know which facility to ask for).
 */
export function useResource<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[],
  options: { isEmpty?: (data: T) => boolean; enabled?: boolean } = {},
): ResourceState<T> & { refetch: () => void } {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const enabled = options.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ status: 'loading' });
    fetcherRef
      .current()
      .then((data) => {
        if (cancelled) return;
        setState(options.isEmpty?.(data) ? { status: 'empty' } : { status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(error)) {
          setState({ status: 'unauthorized', message: (error as ApiError).message });
        } else {
          setState({ status: 'error', message: error instanceof Error ? error.message : 'Something went wrong' });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tick, ...deps]);

  return { ...state, refetch: useCallback(() => setTick((n) => n + 1), []) } as ResourceState<T> & { refetch: () => void };
}
