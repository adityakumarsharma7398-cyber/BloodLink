import { Bell, Building2, Menu, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { BloodLinkMark } from '@/components/brand/BloodLinkMark';
import { ORG_NAV, type NavItem } from '@/components/layout/navigation';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AppShellProps {
  activeId: string;
  organization: string;
  unreadAlerts?: number;
  user: { name: string; role: string };
  /** Which sidebar links to show — the caller filters these by role (see `src/lib/roles.ts`). Defaults to all of them. */
  navItems?: NavItem[];
  children: ReactNode;
}

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate?: () => void }) {
  const Icon = item.icon;
  return (
    <a
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        active ? 'bg-red-50 text-red-600' : 'text-grey-600 hover:bg-grey-50 hover:text-grey-900',
      )}
    >
      <Icon className="size-[18px] shrink-0" aria-hidden="true" />
      {item.label}
    </a>
  );
}

function initials(name: string) {
  return name
    .replace(/^(Dr|Mr|Ms|Mrs)\.?\s+/i, '')
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/**
 * Organization workspace frame: top bar (logo, organization, notifications, profile),
 * left sidebar, and the content area. Desktop-first; the sidebar becomes a drawer below 1024px.
 */
export function AppShell({ activeId, organization, unreadAlerts = 0, user, navItems = ORG_NAV, children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const navList = (
    <nav aria-label="Main" className="flex h-full flex-col p-3">
      <ul className="flex flex-col gap-0.5">
        {navItems.map((item) => (
          <li key={item.id}>
            <NavLink item={item} active={item.id === activeId} onNavigate={() => setDrawerOpen(false)} />
          </li>
        ))}
      </ul>
    </nav>
  );

  return (
    <div className="bg-grey-50 flex min-h-svh flex-col">
      <a href="#main-content" className="sr-only z-50 rounded-md bg-white px-3 py-2 focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
        Skip to content
      </a>

      <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-white px-4 lg:px-0">
        <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setDrawerOpen(true)} aria-label="Open navigation">
          <Menu />
        </Button>
        <a href="/" className="flex items-center lg:w-60 lg:px-5" aria-label="BloodLink home">
          <BloodLinkMark />
        </a>
        <div className="text-grey-900 hidden items-center gap-2 border-l pl-4 text-sm font-medium md:flex lg:pl-5">
          <Building2 className="text-grey-500 size-4" aria-hidden="true" />
          {organization}
        </div>
        <div className="ml-auto flex items-center gap-1 sm:gap-3 lg:pr-6">
          <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications, ${unreadAlerts} unread`}>
            <Bell />
            {unreadAlerts > 0 && (
              <span className="text-data absolute top-1.5 right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
                {unreadAlerts}
              </span>
            )}
          </Button>
          <div className="flex items-center gap-2.5 sm:border-l sm:pl-4">
            <span className="bg-grey-100 text-grey-600 flex size-8 items-center justify-center rounded-full text-xs font-semibold" aria-hidden="true">
              {initials(user.name)}
            </span>
            <span className="hidden text-sm leading-tight sm:block">
              <span className="text-grey-900 block font-medium">{user.name}</span>
              <span className="text-grey-500 block text-xs">{user.role}</span>
            </span>
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        <aside className="sticky top-16 hidden h-[calc(100svh-4rem)] w-60 shrink-0 border-r bg-white lg:block">{navList}</aside>

        {drawerOpen && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
            <button className="absolute inset-0 bg-grey-900/30" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} />
            <aside className="relative flex h-full w-72 flex-col bg-white shadow-raised">
              <div className="flex h-16 items-center justify-between border-b px-4">
                <BloodLinkMark />
                <Button variant="ghost" size="icon" onClick={() => setDrawerOpen(false)} aria-label="Close navigation">
                  <X />
                </Button>
              </div>
              <div className="text-grey-900 mx-3 mt-3 flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium md:hidden">
                <Building2 className="text-grey-500 size-4" aria-hidden="true" />
                {organization}
              </div>
              <div className="flex-1">{navList}</div>
            </aside>
          </div>
        )}

        <main id="main-content" className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
