import {
  ClipboardList,
  ClipboardCheck,
  House,
  MapPin,
  Package,
  Search,
  Siren,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

/**
 * Organization workspace sidebar — only pages that are actually built and connected. A role that
 * cannot use a page never sees its link (see `src/lib/roles.ts`).
 */
export const ORG_NAV: NavItem[] = [
  { id: 'overview', label: 'Overview', href: '/app', icon: House },
  { id: 'inventory', label: 'Inventory', href: '/app/inventory', icon: Package },
  { id: 'requests', label: 'Requests', href: '/app/requests', icon: ClipboardList },
  { id: 'recommendations', label: 'Recommendations', href: '/app/recommendations', icon: ClipboardCheck },
  { id: 'donors', label: 'Donors', href: '/app/donors', icon: Users },
];

/**
 * Public website navigation. Hospitals/Blood Centres/Donors go straight to sign-in — the same
 * Supabase authentication for every audience; the backend resolves the role after sign-in and the
 * right workspace is chosen from that (never from which link was clicked).
 */
export const SITE_NAV = [
  { label: 'Hospitals', href: '/login' },
  { label: 'Blood Centres', href: '/login' },
  { label: 'Emergency Request', href: '/emergency' },
  { label: 'Donors', href: '/login' },
  { label: 'About', href: '/#about' },
];

/** Emergency mode — mobile-first bottom navigation. */
export const EMERGENCY_NAV: NavItem[] = [
  { id: 'emergency', label: 'Emergency', href: '/emergency', icon: Siren },
  { id: 'find', label: 'Find Blood', href: '/emergency/find', icon: Search },
  { id: 'nearby', label: 'Nearby', href: '/emergency/nearby', icon: MapPin },
  { id: 'my-requests', label: 'My Requests', href: '/emergency/requests', icon: ClipboardList },
  { id: 'profile', label: 'Profile', href: '/emergency/profile', icon: User },
];
