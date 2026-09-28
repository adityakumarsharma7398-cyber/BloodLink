import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RiskBadge } from '@/components/status/RiskBadge';
import { RISK_LEVELS } from '@/design/risk';

describe('RiskBadge', () => {
  it.each(RISK_LEVELS)('conveys "%s" with text and an icon, not colour alone', (level) => {
    const { container } = render(<RiskBadge level={level} />);
    const badge = container.querySelector(`[data-risk="${level}"]`);
    expect(badge).not.toBeNull();
    expect(badge?.textContent?.trim()).not.toBe('');
    expect(badge?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });

  it('accepts a custom label while keeping the level', () => {
    render(<RiskBadge level="medium" label="Expiry risk" />);
    expect(screen.getByText('Expiry risk').closest('[data-risk]')).toHaveAttribute('data-risk', 'medium');
  });
});
