import {
  ArrowRight,
  Building2,
  Check,
  ClipboardCheck,
  Database,
  HeartHandshake,
  Hospital,
  Network,
  Package,
  Siren,
  TrendingUp,
  UserCheck,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { SiteFooter } from '@/components/site/SiteFooter';
import { SiteHeader } from '@/components/site/SiteHeader';
import { RiskBadge } from '@/components/status/RiskBadge';
import { Button } from '@/components/ui/button';

const CAPABILITIES: { icon: LucideIcon; title: string; text: string }[] = [
  {
    icon: TrendingUp,
    title: 'Predict shortages',
    text: 'Forecast demand by blood group and component, and see how many days of stock remain before a shortage.',
  },
  {
    icon: Package,
    title: 'Manage inventory',
    text: 'Track every unit — reserved, available or expiring — so stock is used before it is wasted.',
  },
  {
    icon: Network,
    title: 'Coordinate supply',
    text: 'Get transfer recommendations between connected centres and hospitals when one has surplus and another is short.',
  },
  {
    icon: Siren,
    title: 'Respond to emergencies',
    text: 'Find the nearest suitable source for an urgent request, ranked by compatibility, availability and travel time.',
  },
];

const STEPS: { icon: LucideIcon; title: string; text: string; human?: boolean }[] = [
  { icon: Database, title: 'Data', text: 'Inventory, consumption, requests and expiry' },
  { icon: TrendingUp, title: 'Prediction', text: 'Future demand and shortage risk' },
  { icon: ClipboardCheck, title: 'Recommendation', text: 'A suggested action, with its reasons' },
  { icon: UserCheck, title: 'Human approval', text: 'Authorized staff approve, modify or reject', human: true },
  { icon: Zap, title: 'Action', text: 'Transfer, procurement, dispatch or donor outreach' },
];

const AUDIENCES: { id: string; icon: LucideIcon; title: string; text: string; points: string[] }[] = [
  {
    id: 'hospitals',
    icon: Hospital,
    title: 'Hospitals',
    text: 'Plan blood requirements and act before stock runs short.',
    points: ['Demand forecasts and days of coverage', 'Procurement recommendations', 'Emergency and routine requests'],
  },
  {
    id: 'blood-centres',
    icon: Building2,
    title: 'Blood Centres',
    text: 'Keep inventory balanced across the network and reduce wastage.',
    points: ['Unit-level inventory and expiry tracking', 'Redistribution recommendations', 'Request verification and fulfilment'],
  },
  {
    id: 'donors',
    icon: HeartHandshake,
    title: 'Donors',
    text: 'Be contacted when your blood group is actually needed nearby.',
    points: ['Availability and donation history', 'Targeted shortage alerts', 'Eligibility is always confirmed by the blood centre'],
  },
];

/**
 * Illustrative product preview for the hero. Figures are an internally consistent example
 * (16 units ÷ 5.7 units/day = 2.8 days; 24 more units bring coverage to 7.0 days), not live data.
 */
function ShortageAlertPreview() {
  return (
    <figure className="w-full max-w-md">
      <div className="rounded-lg border bg-white shadow-raised">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <p className="text-grey-900 text-sm font-semibold">Shortage prediction</p>
          <RiskBadge level="critical" />
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          <div>
            <p className="text-grey-500 text-xs">O− PRBC · City Hospital</p>
            <p className="text-grey-900 mt-1 text-lg font-semibold">Stock-out expected in 2.8 days</p>
          </div>
          <dl className="bg-grey-50 grid grid-cols-3 divide-x rounded-md border text-sm">
            {[
              ['Usable stock', '16 units'],
              ['Demand', '5.7 / day'],
              ['Target cover', '7 days'],
            ].map(([label, value]) => (
              <div key={label} className="px-3 py-2">
                <dt className="text-grey-500 text-xs">{label}</dt>
                <dd className="text-data text-grey-900 font-semibold">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="border-l-2 border-red-600 pl-3">
            <p className="text-grey-500 text-xs font-semibold tracking-wide uppercase">Recommended action</p>
            <p className="text-grey-900 text-sm font-medium">Transfer 24 units from Centre North</p>
            <p className="text-grey-500 text-xs">Restores 7.0 days of coverage · awaiting approval</p>
          </div>
        </div>
      </div>
      <figcaption className="text-grey-500 mt-3 text-center text-xs">Example of a shortage alert in BloodLink</figcaption>
    </figure>
  );
}

export function Landing() {
  return (
    <div className="flex min-h-svh flex-col bg-white">
      <SiteHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="bg-grey-50 border-b">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1.15fr_1fr] lg:py-24">
            <div>
              <p className="text-grey-600 text-sm font-medium">For hospitals, blood centres and donors</p>
              <h1 className="mt-3 text-4xl leading-[1.1] sm:text-5xl">
                Smarter Blood Supply.
                <br />
                <span className="text-red-600">Faster Response.</span>
              </h1>
              <p className="text-grey-600 mt-5 max-w-xl text-lg">
                BloodLink helps hospitals and blood centres predict shortages, manage inventory, coordinate supply, and respond to
                emergency blood requests.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Button size="lg" asChild>
                  <a href="/emergency">Request Blood</a>
                </Button>
                <Button size="lg" variant="outline" asChild>
                  <a href="#hospitals">
                    For Hospitals &amp; Blood Centres <ArrowRight aria-hidden="true" />
                  </a>
                </Button>
              </div>
              <ul className="text-grey-600 mt-8 flex flex-col gap-2 text-sm sm:flex-row sm:flex-wrap sm:gap-x-6">
                {['Verified emergency requests', 'Unit-level traceability', 'Every action approved by staff'].map((item) => (
                  <li key={item} className="flex items-center gap-2 whitespace-nowrap">
                    <Check className="text-grey-500 size-4" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex justify-center lg:justify-end">
              <ShortageAlertPreview />
            </div>
          </div>
        </section>

        {/* What BloodLink does */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20" aria-labelledby="what-heading">
          <div className="mx-auto max-w-2xl text-center">
            <h2 id="what-heading" className="text-2xl sm:text-3xl">
              What BloodLink does
            </h2>
            <p className="text-grey-600 mt-3">
              Beyond showing what is in stock today, BloodLink tells you what is likely to happen next and what to do about it.
            </p>
          </div>
          <ul className="mt-12 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
            {CAPABILITIES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="border-t pt-6">
                <span className="flex size-10 items-center justify-center rounded-md bg-red-50 text-red-600">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-lg">{title}</h3>
                <p className="text-grey-600 mt-2 text-sm">{text}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* How it works */}
        <section id="how-it-works" className="bg-grey-50 scroll-mt-16 border-y" aria-labelledby="how-heading">
          <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
            <div className="mx-auto max-w-2xl text-center">
              <h2 id="how-heading" className="text-2xl sm:text-3xl">
                How it works
              </h2>
              <p className="text-grey-600 mt-3">
                BloodLink recommends. People decide. Nothing is released, transferred or ordered without approval from authorized staff.
              </p>
            </div>
            <ol className="mt-12 grid gap-4 md:grid-cols-5 md:gap-0">
              {STEPS.map(({ icon: Icon, title, text, human }, index) => (
                <li key={title} className="relative flex gap-4 md:flex-col md:items-center md:px-3 md:text-center">
                  {index < STEPS.length - 1 && (
                    <span aria-hidden="true" className="bg-grey-300 absolute top-12 left-6 h-[calc(100%-2rem)] w-px md:top-6 md:left-[calc(50%+2rem)] md:h-px md:w-[calc(100%-4rem)]" />
                  )}
                  <span
                    className={
                      human
                        ? 'relative flex size-12 shrink-0 items-center justify-center rounded-full border-2 border-red-600 bg-white text-red-600'
                        : 'text-grey-600 relative flex size-12 shrink-0 items-center justify-center rounded-full border bg-white'
                    }
                  >
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <div className="pb-4 md:mt-4 md:pb-0">
                    <p className="text-grey-500 text-xs font-medium">Step {index + 1}</p>
                    <h3 className="text-base">{title}</h3>
                    <p className="text-grey-600 mt-1 text-sm">{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Who it is for */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20" aria-labelledby="who-heading">
          <h2 id="who-heading" className="text-center text-2xl sm:text-3xl">
            Who uses BloodLink
          </h2>
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {AUDIENCES.map(({ id, icon: Icon, title, text, points }) => (
              <article key={id} id={id} className="scroll-mt-24 rounded-lg border bg-white p-6 shadow-card">
                <Icon className="size-7 text-red-600" aria-hidden="true" />
                <h3 className="mt-4 text-lg">{title}</h3>
                <p className="text-grey-600 mt-1 text-sm">{text}</p>
                <ul className="mt-4 flex flex-col gap-2 border-t pt-4">
                  {points.map((point) => (
                    <li key={point} className="text-grey-600 flex gap-2 text-sm">
                      <Check className="text-grey-500 mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      {point}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </section>

        {/* Emergency CTA */}
        <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6 sm:pb-20" aria-labelledby="emergency-heading">
          <div className="flex flex-col items-start gap-6 rounded-lg bg-red-600 px-6 py-10 text-white sm:px-10 md:flex-row md:items-center md:justify-between">
            <div className="max-w-xl">
              <h2 id="emergency-heading" className="text-2xl text-white sm:text-3xl">
                Need blood urgently?
              </h2>
              <p className="mt-2 text-white/90">
                Submit a verified emergency request and connect with an authorized blood centre.
              </p>
            </div>
            <Button size="lg" variant="secondary" className="border-white text-red-600 hover:bg-red-50" asChild>
              <a href="/emergency">
                Request Blood <ArrowRight aria-hidden="true" />
              </a>
            </Button>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
