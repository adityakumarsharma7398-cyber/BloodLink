import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import { BloodLinkMark } from '@/components/brand/BloodLinkMark';
import { RiskBadge } from '@/components/status/RiskBadge';
import { StatusBadge } from '@/components/status/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RISK_LEVELS } from '@/design/risk';

const COLORS = [
  { name: 'BloodLink red', hex: '#C8102E', use: 'Brand, primary action, emergency, critical' },
  { name: 'Red hover', hex: '#A50D24', use: 'Pressed / hover state of red actions' },
  { name: 'Red tint', hex: '#FFF5F6', use: 'Active navigation, selected option' },
  { name: 'White', hex: '#FFFFFF', use: 'Page and card surfaces' },
  { name: 'Grey 50', hex: '#F6F7F9', use: 'Section backgrounds, app canvas' },
  { name: 'Grey 200', hex: '#E3E6EA', use: 'Borders and dividers' },
  { name: 'Grey 500', hex: '#6B7280', use: 'Secondary text, labels' },
  { name: 'Grey 900', hex: '#111827', use: 'Primary text' },
];

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t py-10" aria-label={title}>
      <h2 className="text-lg">{title}</h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** Reference sheet for the BloodLink design system. */
export function DesignReference() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-4 pb-8">
        <BloodLinkMark />
        <nav className="text-grey-600 flex gap-5 text-sm" aria-label="Previews">
          <a href="/" className="hover:text-grey-900">Landing</a>
          <a href="/app" className="hover:text-grey-900">Dashboard</a>
          <a href="/emergency" className="hover:text-grey-900">Emergency</a>
        </nav>
      </div>
      <h1 className="text-3xl">Design system</h1>
      <p className="text-grey-600 mt-2 max-w-2xl">
        White and neutral surfaces, with red used only where it means something: the brand, the main action, emergencies and
        critical status.
      </p>

      <Block title="Colour">
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {COLORS.map((color) => (
            <li key={color.hex}>
              <div className="h-14 rounded-md border" style={{ background: color.hex }} />
              <p className="text-grey-900 mt-2 text-sm font-medium">{color.name}</p>
              <p className="text-data text-grey-500 text-xs">{color.hex}</p>
              <p className="text-grey-500 mt-1 text-xs">{color.use}</p>
            </li>
          ))}
        </ul>
      </Block>

      <Block title="Typography — Inter">
        <div className="flex flex-col gap-3">
          <p className="text-4xl font-semibold tracking-tight">Page title · 36/40</p>
          <p className="text-2xl font-semibold tracking-tight">Section heading · 24</p>
          <p className="text-base font-semibold">Card title · 16 semibold</p>
          <p className="text-grey-600 text-[15px]">Body text · 15 regular, grey 600 for supporting copy.</p>
          <p className="text-grey-500 text-xs font-semibold tracking-wide uppercase">Label · 12 semibold</p>
          <p className="text-data text-[28px] font-semibold">364 · tabular figures</p>
        </div>
      </Block>

      <Block title="Buttons">
        <div className="flex flex-wrap items-center gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="destructive">Reject</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Text link</Button>
          <Button disabled>Disabled</Button>
          <Button size="sm">Small</Button>
          <Button size="lg">Large</Button>
        </div>
      </Block>

      <Block title="Form controls">
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ref-a">Patient / case reference</Label>
            <Input id="ref-a" placeholder="e.g. CASE-2026-0418" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ref-b">Quantity (units)</Label>
            <Input id="ref-b" type="number" defaultValue={2} aria-invalid="true" />
            <p className="text-status-critical text-xs">Enter at least 1 unit.</p>
          </div>
        </div>
      </Block>

      <Block title="Status">
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            {RISK_LEVELS.map((level) => (
              <RiskBadge key={level} level={level} />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <StatusBadge tone="ok" label="Available" />
            <StatusBadge tone="neutral" label="Reserved" />
            <StatusBadge tone="warning" label="Quarantined" />
            <StatusBadge tone="warning" icon={Clock} label="Pending review" />
            <StatusBadge tone="critical" label="Expired" />
            <StatusBadge tone="info" label="In transit" />
          </div>
          <p className="text-grey-500 text-sm">Every status carries a text label; colour is never the only signal.</p>
        </div>
      </Block>
    </div>
  );
}
