import { BloodLinkMark } from '@/components/brand/BloodLinkMark';

const COLUMNS = [
  {
    title: 'Platform',
    links: [
      { label: 'Hospitals', href: '/login' },
      { label: 'Blood Centres', href: '/login' },
      { label: 'Donors', href: '/login' },
      { label: 'How it works', href: '/#how-it-works' },
    ],
  },
  {
    title: 'Access',
    links: [
      { label: 'Emergency Request', href: '/emergency' },
      { label: 'Login', href: '/login' },
    ],
  },
];

/** Public website footer. */
export function SiteFooter() {
  return (
    <footer className="bg-grey-50 border-t">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div id="about" className="max-w-sm scroll-mt-24">
          <BloodLinkMark />
          <p className="text-grey-600 mt-4 text-sm">
            BloodLink is a coordination platform for hospitals, blood centres and donors. It forecasts demand, flags shortage and
            expiry risk, and recommends actions that authorized staff review and approve.
          </p>
        </div>
        {COLUMNS.map((column) => (
          <div key={column.title}>
            <h2 className="text-grey-900 text-sm font-semibold">{column.title}</h2>
            <ul className="mt-3 flex flex-col gap-2">
              {column.links.map((link) => (
                <li key={link.label}>
                  <a href={link.href} className="text-grey-600 hover:text-grey-900 text-sm">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t">
        <div className="text-grey-500 mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 text-xs sm:flex-row sm:justify-between sm:px-6">
          <p>© {new Date().getFullYear()} BloodLink</p>
          <p>Clinical decisions, blood release and donor eligibility remain with authorized clinicians and blood centres.</p>
        </div>
      </div>
    </footer>
  );
}
