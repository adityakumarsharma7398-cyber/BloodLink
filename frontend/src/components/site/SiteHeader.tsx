import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { BloodLinkMark } from '@/components/brand/BloodLinkMark';
import { SITE_NAV } from '@/components/layout/navigation';
import { Button } from '@/components/ui/button';

/** Public website navigation bar. */
export function SiteHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/90">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-4 sm:px-6">
        <a href="/" aria-label="BloodLink home">
          <BloodLinkMark />
        </a>

        <nav aria-label="Main" className="hidden flex-1 justify-center lg:flex">
          <ul className="flex items-center gap-7">
            {SITE_NAV.map((item) => (
              <li key={item.label}>
                <a href={item.href} className="text-grey-600 hover:text-grey-900 text-sm font-medium transition-colors">
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto hidden items-center gap-2 lg:ml-0 lg:flex">
          <Button asChild>
            <a href="/login">Login</a>
          </Button>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="ml-auto lg:hidden"
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X /> : <Menu />}
        </Button>
      </div>

      {open && (
        <nav id="mobile-nav" aria-label="Main" className="border-t bg-white px-4 pt-2 pb-4 lg:hidden">
          <ul className="flex flex-col">
            {SITE_NAV.map((item) => (
              <li key={item.label}>
                <a
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className="text-grey-900 block border-b py-3 text-[15px] font-medium"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <Button asChild className="w-full">
              <a href="/login">Login</a>
            </Button>
          </div>
        </nav>
      )}
    </header>
  );
}
