import type { NavItem } from '@/components/layout/navigation';
import { cn } from '@/lib/utils';

/** Bottom navigation for the mobile-first emergency and donor interfaces. */
export function MobileTabBar({ items, activeId, className }: { items: NavItem[]; activeId: string; className?: string }) {
  return (
    <nav aria-label="Primary" className={cn('border-t bg-white pb-[env(safe-area-inset-bottom)]', className)}>
      <ul className="mx-auto flex max-w-md">
        {items.map((item) => {
          const Icon = item.icon;
          const active = item.id === activeId;
          return (
            <li key={item.id} className="flex-1">
              <a
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex flex-col items-center gap-1 px-1 py-2.5 text-[11px] font-medium',
                  active ? 'text-red-600' : 'text-grey-500 hover:text-grey-900',
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
