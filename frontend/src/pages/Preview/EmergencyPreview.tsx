import { Info, Phone, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { SiteHeader } from '@/components/site/SiteHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

const BLOOD_GROUPS = ['O−', 'O+', 'A−', 'A+', 'B−', 'B+', 'AB−', 'AB+', 'Unknown'];
const COMPONENTS = ['Whole blood', 'PRBC', 'Plasma / FFP', 'Platelets'];
const URGENCY = [
  { value: 'normal', label: 'Normal', hint: 'Within 24 hours' },
  { value: 'high', label: 'High', hint: 'Within a few hours' },
  { value: 'critical', label: 'Critical', hint: 'Immediately' },
];

// Request lifecycle for public/emergency requesters (docs/DECISIONS.md, L).
const STEPS = [
  { title: 'Request submitted', text: 'Your request is recorded as pending verification.' },
  { title: 'Verified by staff', text: 'Hospital or blood-centre staff confirm the request.' },
  { title: 'Source matched', text: 'BloodLink ranks compatible sources by availability and travel time.' },
  { title: 'Confirmed by blood centre', text: 'The blood centre authorizes release.' },
  { title: 'Dispatched', text: 'Track the request until it is fulfilled.' },
];

function Field({ id, label, required, children, hint }: { id: string; label: string; required?: boolean; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-grey-900 text-sm font-medium">
        {label}
        {required && (
          <span className="text-red-600" aria-hidden="true">
            *
          </span>
        )}
      </Label>
      {children}
      {hint && <p className="text-grey-500 text-xs">{hint}</p>}
    </div>
  );
}

/** Emergency request form (visual preview; submission is connected in a later phase). */
export function EmergencyPreview() {
  const [urgency, setUrgency] = useState('high');
  const [submitted, setSubmitted] = useState(false);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
  };

  return (
    <div className="bg-grey-50 flex min-h-svh flex-col">
      <SiteHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <div className="max-w-2xl">
          <h1 className="text-2xl sm:text-3xl">Emergency blood request</h1>
          <p className="text-grey-600 mt-2">
            Submit the requirement below. Staff at a hospital or blood centre verify every request before blood is released.
          </p>
        </div>

        <div className="mt-8 grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
          <form onSubmit={onSubmit} className="rounded-lg border bg-white shadow-card" noValidate>
            <fieldset className="grid gap-5 border-b p-5 sm:grid-cols-3 sm:p-6">
              <legend className="text-grey-900 mb-1 text-base font-semibold sm:col-span-3">Blood requirement</legend>
              <Field id="blood-group" label="Blood group" required>
                <Select defaultValue="O−" name="bloodGroup">
                  <SelectTrigger id="blood-group" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BLOOD_GROUPS.map((group) => (
                      <SelectItem key={group} value={group}>
                        {group}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id="component" label="Component" required>
                <Select defaultValue="PRBC" name="component">
                  <SelectTrigger id="component" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COMPONENTS.map((component) => (
                      <SelectItem key={component} value={component}>
                        {component}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id="quantity" label="Quantity (units)" required>
                <Input id="quantity" name="quantity" type="number" inputMode="numeric" min={1} defaultValue={2} />
              </Field>
            </fieldset>

            <fieldset className="grid gap-5 border-b p-5 sm:grid-cols-[1fr_14rem] sm:p-6">
              <legend className="text-grey-900 mb-1 text-base font-semibold sm:col-span-2">Urgency</legend>
              <div role="radiogroup" aria-label="Urgency" className="grid grid-cols-3 gap-2">
                {URGENCY.map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer flex-col rounded-md border px-3 py-2.5 text-sm transition-colors',
                      urgency === option.value ? 'border-red-600 bg-red-50' : 'hover:border-grey-300',
                    )}
                  >
                    <input
                      type="radio"
                      name="urgency"
                      value={option.value}
                      checked={urgency === option.value}
                      onChange={() => setUrgency(option.value)}
                      className="sr-only"
                    />
                    <span className={cn('font-semibold', urgency === option.value ? 'text-red-600' : 'text-grey-900')}>{option.label}</span>
                    <span className="text-grey-500 text-xs">{option.hint}</span>
                  </label>
                ))}
              </div>
              <Field id="required-by" label="Required by" required>
                <Input id="required-by" name="requiredBy" type="datetime-local" />
              </Field>
            </fieldset>

            <fieldset className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
              <legend className="text-grey-900 mb-1 text-base font-semibold sm:col-span-2">Patient and requester</legend>
              <Field id="patient-ref" label="Patient / case reference" required hint="Hospital case number. Do not enter the patient's full name.">
                <Input id="patient-ref" name="patientReference" placeholder="e.g. CASE-2026-0418" />
              </Field>
              <Field id="facility" label="Treating hospital / facility" required>
                <Input id="facility" name="facility" placeholder="Where the patient is being treated" />
              </Field>
              <Field id="contact" label="Contact phone" required>
                <Input id="contact" name="contact" type="tel" inputMode="tel" placeholder="Reachable number" />
              </Field>
              <Field id="notes" label="Notes">
                <Input id="notes" name="notes" placeholder="Optional clinical or logistics notes" />
              </Field>
            </fieldset>

            <div className="bg-grey-25 flex flex-col gap-3 rounded-b-lg border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <p className="text-grey-500 flex items-center gap-1.5 text-xs">
                <ShieldCheck className="size-4 shrink-0" aria-hidden="true" />
                Verification status after submitting: <strong className="text-grey-900 font-semibold">Pending verification</strong>
              </p>
              <Button type="submit" size="lg">
                Submit Emergency Request
              </Button>
            </div>
            {submitted && (
              <p role="status" className="bg-info-bg text-info mx-5 mb-5 flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium sm:mx-6">
                <Info className="size-4 shrink-0" aria-hidden="true" />
                Design preview — submission is connected to the backend in a later phase.
              </p>
            )}
          </form>

          <aside className="flex flex-col gap-4">
            <section className="rounded-lg border bg-white p-5 shadow-card" aria-labelledby="next-heading">
              <h2 id="next-heading" className="text-base">
                What happens next
              </h2>
              <ol className="mt-4 flex flex-col">
                {STEPS.map((step, index) => (
                  <li key={step.title} className="relative flex gap-3 pb-4 last:pb-0">
                    {index < STEPS.length - 1 && <span aria-hidden="true" className="bg-grey-200 absolute top-6 left-3 h-[calc(100%-1.5rem)] w-px" />}
                    <span className="text-grey-600 relative flex size-6 shrink-0 items-center justify-center rounded-full border bg-white text-xs font-semibold">
                      {index + 1}
                    </span>
                    <div>
                      <p className="text-grey-900 text-sm font-medium">{step.title}</p>
                      <p className="text-grey-500 text-xs">{step.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
            <section className="rounded-lg border border-red-100 bg-red-50 p-5" aria-labelledby="direct-heading">
              <h2 id="direct-heading" className="flex items-center gap-2 text-base text-red-700">
                <Phone className="size-4" aria-hidden="true" />
                Life-threatening emergency?
              </h2>
              <p className="text-grey-600 mt-1 text-sm">Also contact the nearest hospital's blood bank directly while your request is verified.</p>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
