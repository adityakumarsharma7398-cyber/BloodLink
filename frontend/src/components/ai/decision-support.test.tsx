import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActionQueue } from '@/components/ai/ActionQueue';
import { ConfidenceIndicator } from '@/components/ai/ConfidenceIndicator';
import { InsightPanel } from '@/components/ai/InsightPanel';

describe('InsightPanel', () => {
  it('reads as prediction → reason → figures → recommended action', () => {
    render(
      <InsightPanel
        prediction="O− PRBC shortage predicted in 2.8 days"
        risk="critical"
        reason="Demand exceeds available stock."
        figures={[{ label: 'Coverage', value: '2.8 days' }]}
        recommendedAction="Transfer 24 units from Centre North"
        reviewHref="#rec"
      />,
    );
    expect(screen.getByRole('heading', { name: 'O− PRBC shortage predicted in 2.8 days' })).toBeInTheDocument();
    expect(screen.getByText('Demand exceeds available stock.')).toBeInTheDocument();
    expect(screen.getByText('Transfer 24 units from Centre North')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /review recommendation/i })).toHaveAttribute('href', '#rec');
    expect(screen.queryByText(/ai[- ]powered/i)).not.toBeInTheDocument();
  });
});

describe('ConfidenceIndicator', () => {
  it('reports the given model confidence as a meter, clamped to 0–100', () => {
    const { rerender } = render(<ConfidenceIndicator value={0.734} basis={['90 days consumption']} />);
    expect(screen.getByRole('meter', { name: 'Model confidence' })).toHaveAttribute('aria-valuenow', '73');
    rerender(<ConfidenceIndicator value={1.4} basis={[]} />);
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
  });
});

describe('ActionQueue', () => {
  it('names each item and its risk level in text', () => {
    render(<ActionQueue items={[{ id: '1', level: 'critical', title: 'O− shortage predicted', href: '#x' }]} />);
    expect(screen.getByRole('link', { name: /O− shortage predicted/ })).toHaveTextContent('Critical');
  });

  it('has a calm empty state', () => {
    render(<ActionQueue items={[]} />);
    expect(screen.getByText('Nothing needs your attention right now.')).toBeInTheDocument();
  });
});
