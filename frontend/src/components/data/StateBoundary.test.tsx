import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StateBoundary } from '@/components/data/StateBoundary';

describe('StateBoundary', () => {
  it('shows a loading indicator while the request is in flight', () => {
    render(<StateBoundary state={{ status: 'loading' }}>{() => <p>content</p>}</StateBoundary>);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('explains an unauthorized result without exposing internals beyond the backend message', () => {
    render(<StateBoundary state={{ status: 'unauthorized', message: 'You do not have permission to do this' }}>{() => <p>content</p>}</StateBoundary>);
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
  });

  it('offers a retry on error', () => {
    const onRetry = vi.fn();
    render(
      <StateBoundary state={{ status: 'error', message: 'Backend is unreachable' }} onRetry={onRetry}>
        {() => <p>content</p>}
      </StateBoundary>,
    );
    expect(screen.getByText('Backend is unreachable')).toBeInTheDocument();
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows a calm empty state, or a caller-supplied one', () => {
    const { rerender } = render(<StateBoundary state={{ status: 'empty' }}>{() => <p>content</p>}</StateBoundary>);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
    rerender(
      <StateBoundary state={{ status: 'empty' }} empty={<p>No shortages today.</p>}>
        {() => <p>content</p>}
      </StateBoundary>,
    );
    expect(screen.getByText('No shortages today.')).toBeInTheDocument();
  });

  it('renders the children with the data once ready', () => {
    render(<StateBoundary state={{ status: 'ready', data: { count: 3 } }}>{(data) => <p>Count: {data.count}</p>}</StateBoundary>);
    expect(screen.getByText('Count: 3')).toBeInTheDocument();
  });
});
