import type { AppRole, AuthContext } from '../auth/types.js';
import { assertFacilityAccess, hasAnyRole } from '../authz/permissions.js';
import type { Database } from '../db/client.js';
import type { $Enums } from '../generated/prisma/client.js';
import { pageMeta, toPageWindow } from '../http/schemas.js';
import {
  PARAMETER_KEYS, parseHistoryDays, parseRiskBands, parseWarningDays, resolveParameter,
} from '../inventory/parameters.js';
import { classifyExpiry, classifyShortage } from '../inventory/status.js';
import { inventoryRepository } from '../repositories/inventoryRepository.js';
import { referenceRepository } from '../repositories/referenceRepository.js';

/**
 * Who may read a facility's stock. Matches the approved role matrix (§9.2): inventory managers and
 * blood-bank staff work with the stock; ORG_ADMIN reads all own-organization data. Hospital roles,
 * DONOR, PUBLIC_REQUESTER and SUPER_ADMIN get no unit-level or per-facility stock (cross-organization
 * availability is a separate, aggregate-only backend function).
 */
export const INVENTORY_READ_ROLES: readonly AppRole[] = ['ORG_ADMIN', 'BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF', 'INVENTORY_MANAGER'];

export interface SummaryQuery {
  facilityId?: string;
  bloodGroupId?: number;
  componentId?: number;
  includeEmpty: boolean;
}

export interface UnitsQuery {
  facilityId: string;
  status?: $Enums.inventory_unit_status;
  bloodGroupId?: number;
  componentId?: number;
  expiringWithinDays?: number;
  page: number;
  pageSize: number;
}

/** Facilities where the caller holds an inventory-reading role (org-wide for ORG_ADMIN of that organization). */
const readableFacilities = (auth: AuthContext) =>
  auth.facilities.filter((facility) => hasAnyRole(auth, INVENTORY_READ_ROLES, { facilityId: facility.id }));

export function createInventoryService(db: Database) {
  return {
    async summary(auth: AuthContext, query: SummaryQuery) {
      let facilityIds: string[];
      if (query.facilityId) {
        // A facility the caller cannot read is answered "not found" so other tenants' ids are not revealed.
        assertFacilityAccess(auth, query.facilityId, { roles: INVENTORY_READ_ROLES, hide: true });
        facilityIds = [query.facilityId];
      } else {
        facilityIds = readableFacilities(auth).map((facility) => facility.id);
      }

      const facilities = await inventoryRepository.holdingFacilities(db.prisma, facilityIds);
      const [groups, components] = await Promise.all([
        referenceRepository.bloodGroups(db.prisma),
        referenceRepository.components(db.prisma),
      ]);
      const selectedGroups = groups.filter((group) => !query.bloodGroupId || group.id === query.bloodGroupId);
      const selectedComponents = components.filter((component) => component.active && (!query.componentId || component.id === query.componentId));
      const parameterRows = await inventoryRepository.parameterRows(db.prisma, [...new Set(facilities.map((f) => f.organizationId))]);

      // One series per facility × blood group × component, with the parameters that apply to it.
      const series = facilities.flatMap((facility) =>
        selectedGroups.flatMap((group) =>
          selectedComponents.map((component) => {
            const scope = { facilityId: facility.id, organizationId: facility.organizationId, bloodGroupId: group.id, componentId: component.id };
            return {
              facility,
              group,
              component,
              warning: parseWarningDays(resolveParameter(parameterRows, PARAMETER_KEYS.expiryWarningDays, scope)),
              history: parseHistoryDays(resolveParameter(parameterRows, PARAMETER_KEYS.historyDays, scope)),
              bands: parseRiskBands(resolveParameter(parameterRows, PARAMETER_KEYS.riskBands, scope)),
            };
          }),
        ),
      );

      const counts = await inventoryRepository.seriesCounts(
        db.prisma,
        series.map((s) => ({
          facilityId: s.facility.id,
          bloodGroupId: s.group.id,
          componentId: s.component.id,
          warningDays: s.warning.ok ? s.warning.value : 0,
          historyDays: s.history.ok ? s.history.value : 0,
        })),
      );
      const countOf = new Map(counts.map((c) => [`${c.facilityId}|${c.bloodGroupId}|${c.componentId}`, c]));

      return series.flatMap((s) => {
        const c = countOf.get(`${s.facility.id}|${s.group.id}|${s.component.id}`);
        if (!c) return [];
        const hasUnits = c.onHand + c.expiredNotMarked > 0;
        // Empty rows make zero stock visible; the UNKNOWN blood group only appears when units carry it.
        if (!hasUnits && (!query.includeEmpty || !s.group.is_known)) return [];
        return [
          {
            facility: { id: s.facility.id, name: s.facility.name },
            bloodGroup: { id: s.group.id, code: s.group.code },
            component: { id: s.component.id, code: s.component.code },
            quantities: {
              onHand: c.onHand,
              available: c.available,
              reserved: c.reserved,
              pendingAcceptance: c.pendingAcceptance,
              inTransit: c.inTransit,
              expiringSoon: s.warning.ok ? c.expiring : null,
              expiredNotYetMarked: c.expiredNotMarked,
              nearestExpiry: c.nearestExpiry ? c.nearestExpiry.toISOString() : null,
            },
            shortage: classifyShortage({ available: c.available, issuedInWindow: c.issuedInWindow, historyDays: s.history, bands: s.bands }),
            expiry: classifyExpiry({ warningDays: s.warning, expiringUnits: c.expiring }),
            // Transparency: the exact configuration behind each status (no defaults exist in code).
            parameters: {
              expiryWarningDays: s.warning.ok ? s.warning.value : null,
              consumptionWindowDays: s.history.ok ? s.history.value : null,
              riskBands: s.bands.ok ? s.bands.value : null,
              issuedInWindow: s.history.ok ? c.issuedInWindow : null,
            },
          },
        ];
      });
    },

    async units(auth: AuthContext, query: UnitsQuery) {
      assertFacilityAccess(auth, query.facilityId, { roles: INVENTORY_READ_ROLES, hide: true });
      const window = toPageWindow(query);
      const { total, rows } = await inventoryRepository.units(
        db.prisma,
        {
          facilityId: query.facilityId,
          status: query.status,
          bloodGroupId: query.bloodGroupId,
          componentId: query.componentId,
          expiringWithinDays: query.expiringWithinDays,
        },
        window.skip,
        window.take,
      );
      const now = Date.now();
      const data = rows.map((row) => ({
        id: row.id,
        unitCode: row.unit_code,
        bloodGroup: row.blood_groups,
        component: row.components,
        status: row.status,
        collectionDate: row.collection_date.toISOString(),
        processingDate: row.processing_date?.toISOString() ?? null,
        expiryDate: row.expiry_date.toISOString(),
        isExpired: row.expiry_date.getTime() <= now,
        volumeMl: row.volume_ml,
        statusChangedAt: row.status_changed_at.toISOString(),
        receivedAt: row.received_at.toISOString(),
        storageLocationId: row.storage_location_id,
        reservedForRequestId: row.reserved_for_request_id,
      }));
      return { data, pagination: pageMeta(query, total) };
    },
  };
}

export type InventoryService = ReturnType<typeof createInventoryService>;
