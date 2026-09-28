import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Landing } from '@/pages/Landing/Landing';
import { EmergencyPreview } from '@/pages/Preview/EmergencyPreview';

describe('Landing page', () => {
  it('leads with the headline and the two primary calls to action', () => {
    render(<Landing />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Smarter Blood Supply.Faster Response.');
    const hero = screen.getByRole('heading', { level: 1 }).closest('section')!;
    expect(within(hero).getByRole('link', { name: 'Request Blood' })).toHaveAttribute('href', '/emergency');
    expect(within(hero).getByRole('link', { name: /for hospitals & blood centres/i })).toBeInTheDocument();
  });

  it('explains the human-approval workflow in order', () => {
    render(<Landing />);
    const steps = within(screen.getByRole('region', { name: 'How it works' })).getAllByRole('listitem');
    expect(steps.map((step) => within(step).getByRole('heading').textContent)).toEqual([
      'Data',
      'Prediction',
      'Recommendation',
      'Human approval',
      'Action',
    ]);
  });

  it('has anchors for every audience linked from the navigation', () => {
    const { container } = render(<Landing />);
    for (const id of ['hospitals', 'blood-centres', 'donors', 'about']) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }
  });
});

describe('Emergency request form', () => {
  it('asks for every required field with an accessible label', () => {
    render(<EmergencyPreview />);
    for (const label of [/blood group/i, /component/i, /quantity/i, /required by/i, /patient \/ case reference/i, /contact phone/i]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole('radiogroup', { name: 'Urgency' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit Emergency Request' })).toBeInTheDocument();
    expect(screen.getByText('Pending verification')).toBeInTheDocument();
  });
});
