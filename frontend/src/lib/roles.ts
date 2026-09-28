import type { NavItem } from '@/components/layout/navigation';
import { ORG_NAV } from '@/components/layout/navigation';
import type { Me } from '@/lib/auth';

/**
 * Mirrors the backend's own role groups exactly (never invents a new authorization model —
 * `docs/BACKEND.md`, `src/services/inventoryService.ts` `INVENTORY_READ_ROLES`,
 * `src/services/emergencyService.ts` `EMERGENCY_REQUEST_ROLES` / `HOLD_SOURCE_ROLES`,
 * `src/services/routineRequestService.ts` `ROUTINE_REQUEST_ROLES`). These are used only to decide
 * what to SHOW; every request is still authorized again by the backend, which remains the only
 * source of truth.
 */
export const INVENTORY_READ_ROLES = ['ORG_ADMIN', 'BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF', 'INVENTORY_MANAGER'];
export const EMERGENCY_REQUEST_ROLES = ['EMERGENCY_STAFF'];
export const HOLD_SOURCE_ROLES = ['BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF'];
export const ROUTINE_REQUEST_ROLES = ['HOSPITAL_STAFF', 'DOCTOR'];

const hasAny = (me: Me | null, roles: readonly string[]) => (me?.roles ?? []).some((grant) => roles.includes(grant.role));
const isDonorOnly = (me: Me | null) => (me?.roles ?? []).length > 0 && me!.roles.every((grant) => grant.role === 'DONOR');

export type WorkspaceKind = 'staff' | 'donor' | 'none';

/** Which workspace a signed-in, server-resolved identity gets. Never guessed from the JWT. */
export function workspaceFor(me: Me | null): WorkspaceKind {
  if (!me) return 'none';
  if (hasAny(me, [...INVENTORY_READ_ROLES, ...EMERGENCY_REQUEST_ROLES, ...HOLD_SOURCE_ROLES, 'HOSPITAL_STAFF', 'DOCTOR', 'SUPER_ADMIN'])) return 'staff';
  if (isDonorOnly(me)) return 'donor';
  return 'none';
}

/** The sidebar links this identity's role(s) actually permit — never a link to a workflow the backend would reject. */
export function visibleNavItems(me: Me | null): NavItem[] {
  const canInventory = hasAny(me, INVENTORY_READ_ROLES);
  const canRequests = hasAny(me, [...EMERGENCY_REQUEST_ROLES, ...HOLD_SOURCE_ROLES, ...ROUTINE_REQUEST_ROLES]);
  const allowed: Record<string, boolean> = {
    overview: true,
    inventory: canInventory,
    requests: canRequests,
    recommendations: canInventory,
    donors: canInventory,
  };
  return ORG_NAV.filter((item) => allowed[item.id]);
}
