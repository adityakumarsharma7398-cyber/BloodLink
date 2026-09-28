import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RecommendationCard, type RecommendationCardProps } from '@/components/ai/RecommendationCard';

const base: RecommendationCardProps = {
  title: 'Transfer 5 O− PRBC units',
  subtitle: 'Centre B → Centre A',
  why: ['Destination coverage is below target.'],
  data: [{ label: 'Coverage', value: '3.1 days', emphasis: true }],
  action: 'Create a transfer for approval.',
  status: 'PENDING',
};

describe('RecommendationCard', () => {
  it('answers WHAT, WHY, DATA and ACTION', () => {
    render(<RecommendationCard {...base} />);
    for (const section of ['What', 'Why', 'Data', 'Action']) {
      expect(screen.getByRole('region', { name: section })).toBeInTheDocument();
    }
    expect(screen.getByText('Transfer 5 O− PRBC units')).toBeInTheDocument();
    expect(screen.getByText('3.1 days')).toBeInTheDocument();
  });

  it('routes each human decision to the handler', async () => {
    const onDecision = vi.fn();
    render(<RecommendationCard {...base} onDecision={onDecision} />);
    await userEvent.click(screen.getByRole('button', { name: /approve/i }));
    await userEvent.click(screen.getByRole('button', { name: /reject/i }));
    expect(onDecision.mock.calls).toEqual([['approve'], ['reject']]);
  });

  it('locks all decisions while one is in flight', () => {
    render(<RecommendationCard {...base} onDecision={vi.fn()} pendingDecision="approve" />);
    for (const name of [/approve/i, /modify/i, /reject/i]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
  });

  it('shows the outcome instead of controls once decided', () => {
    render(<RecommendationCard {...base} status="APPROVED" decisionNote="by R. Mehta" />);
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('by R. Mehta')).toBeInTheDocument();
  });

  it('marks a pending recommendation as awaiting review', () => {
    render(<RecommendationCard {...base} />);
    expect(screen.getByText('Pending review')).toBeInTheDocument();
    expect(screen.getByText(/requires approval by an authorized user/i)).toBeInTheDocument();
  });

  it('cannot be approved without a decision handler', () => {
    render(<RecommendationCard {...base} />);
    expect(screen.getByRole('button', { name: /approve/i })).toBeDisabled();
  });
});
