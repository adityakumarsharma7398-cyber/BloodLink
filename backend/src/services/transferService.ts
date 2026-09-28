import type { AuditService } from '../audit/auditService.js';
import type { AppRole, AuthContext } from '../auth/types.js';
import { assertFacilityAccess, hasAnyRole } from '../authz/permissions.js';
import type { Database, Tx } from '../db/client.js';
import { callPrivate } from '../db/privateFunctions.js';
import type { $Enums } from '../generated/prisma/client.js';
import { pageMeta, toPageWindow } from '../http/schemas.js';
import { redistributionRepository } from '../repositories/redistributionRepository.js';
import { referenceRepository } from '../repositories/referenceRepository.js';
import { notFound } from '../utils/httpError.js';
import { INVENTORY_READ_ROLES } from './inventoryService.js';

/** The database function allows only the source BLOOD_BANK_ADMIN; the API mirrors it so callers get a clean 403. */
export const TRANSFER_DECIDE_ROLES: readonly AppRole[] = ['BLOOD_BANK_ADMIN'];

/**
 * What the destination learns about a rejection: a fixed code, never free text. The database copies the reason it is
 * given into the transfer row the destination reads and into the audit rows of BOTH organizations, so only the code
 * is ever passed to it. The source's own free-text note is written by the backend to the SOURCE organization's audit
 * log alone (same principle as the approved hold-reason rule: each side's text stays inside its own organization).
 */
export const TRANSFER_REJECTION_CODES = ['INSUFFICIENT_STOCK', 'RESERVE_REQUIRED', 'NOT_NEEDED', 'OTHER'] as const;
export type TransferRejectionCode = (typeof TRANSFER_REJECTION_CODES)[number];

interface CallContext {
  readonly correlationId: string;
  readonly ip: string | null;
}

const canRead = (auth: AuthContext, facilityId: string) => hasAnyRole(auth, INVENTORY_READ_ROLES, { facilityId });

export function createTransferService(db: Database, audit: AuditService) {
  type TransferRow = NonNullable<Awaited<ReturnType<typeof redistributionRepository.findTransfer>>>;

  async function toDtos(rows: TransferRow[]) {
    const [names, groups, components] = await Promise.all([
      redistributionRepository.facilityNames(db.prisma, [...new Set(rows.flatMap((r) => [r.source_facility_id, r.destination_facility_id]))]),
      referenceRepository.bloodGroups(db.prisma),
      referenceRepository.components(db.prisma),
    ]);
    const group = new Map(groups.map((g) => [g.id, g.code]));
    const component = new Map(components.map((c) => [c.id, c.code]));
    // Deliberately minimal and identical for both sides: no unit ids or codes, no stock figures.
    return rows.map((row) => ({
      id: row.id,
      transferNumber: row.transfer_number,
      status: row.status,
      source: { id: row.source_facility_id, name: names.get(row.source_facility_id) ?? '' },
      destination: { id: row.destination_facility_id, name: names.get(row.destination_facility_id) ?? '' },
      bloodGroup: group.get(row.blood_group_id) ?? '',
      component: component.get(row.component_id) ?? '',
      requestedQuantity: row.requested_quantity,
      approvedQuantity: row.approved_quantity,
      recommendationId: row.recommendation_id,
      estimatedTransitMinutes: row.estimated_transit_minutes,
      rejectionReason: row.rejection_reason,
      requestedAt: row.requested_at.toISOString(),
      approvedAt: row.approved_at?.toISOString() ?? null,
      dispatchedAt: row.dispatched_at?.toISOString() ?? null,
      receivedAt: row.received_at?.toISOString() ?? null,
      cancelledAt: row.cancelled_at?.toISOString() ?? null,
    }));
  }

  /** A transfer is visible to the people who can read either of its two facilities; everyone else gets 404. */
  async function loadVisible(auth: AuthContext, id: string, client: Tx | Database['prisma'] = db.prisma) {
    const row = await redistributionRepository.findTransfer(client, id);
    if (!row || !(canRead(auth, row.source_facility_id) || canRead(auth, row.destination_facility_id))) throw notFound();
    return row;
  }

  const get = async (auth: AuthContext, id: string) => {
    const [dto] = await toDtos([await loadVisible(auth, id)]);
    return dto!;
  };

  return {
    async list(auth: AuthContext, query: { facilityId?: string; status?: $Enums.transfer_status; page: number; pageSize: number }) {
      let facilityIds: string[];
      if (query.facilityId) {
        assertFacilityAccess(auth, query.facilityId, { roles: INVENTORY_READ_ROLES, hide: true });
        facilityIds = [query.facilityId];
      } else {
        facilityIds = auth.facilities.filter((f) => canRead(auth, f.id)).map((f) => f.id);
      }
      const window = toPageWindow(query);
      const { total, rows } = await redistributionRepository.transfers(db.prisma, { facilityIds, status: query.status }, window.skip, window.take);
      return { data: await toDtos(rows), pagination: pageMeta(query, total) };
    },

    get,

    /**
     * Source-side approval through `private.approve_transfer`: the database picks first-expiry-first units,
     * reserves them and writes the audit rows for both organizations itself.
     */
    async approve(auth: AuthContext, ctx: CallContext, id: string, approvedQuantity?: number) {
      await db.withTransaction(async (tx) => {
        const row = await loadVisible(auth, id, tx);
        assertFacilityAccess(auth, row.source_facility_id, { roles: TRANSFER_DECIDE_ROLES });
        await callPrivate(tx, 'approve_transfer', {
          p_transfer: id,
          p_actor: auth.userId,
          p_approved_quantity: approvedQuantity ?? row.requested_quantity,
          p_correlation: ctx.correlationId,
        });
      });
      return get(auth, id);
    },

    async reject(auth: AuthContext, ctx: CallContext, id: string, reasonCode: TransferRejectionCode, note?: string) {
      await db.withTransaction(async (tx) => {
        const row = await loadVisible(auth, id, tx);
        assertFacilityAccess(auth, row.source_facility_id, { roles: TRANSFER_DECIDE_ROLES });
        await callPrivate(tx, 'reject_transfer', { p_transfer: id, p_actor: auth.userId, p_reason: reasonCode, p_correlation: ctx.correlationId });
        if (note) {
          const source = await tx.facilities.findUnique({ where: { id: row.source_facility_id }, select: { organization_id: true } });
          await audit.record(tx, {
            actorId: auth.userId,
            organizationId: source!.organization_id, // the source organization only
            facilityId: row.source_facility_id,
            action: 'transfer.reject_note',
            entityType: 'transfer',
            entityId: id,
            oldValue: null,
            newValue: { note },
            correlationId: ctx.correlationId,
            ip: ctx.ip,
          });
        }
      });
      return get(auth, id);
    },

    /** Called inside the recommendation-decision transaction: creates the PROPOSED transfer and audits it for both organizations. */
    async proposeFromRecommendation(
      tx: Tx,
      auth: AuthContext,
      ctx: CallContext,
      input: {
        recommendationId: string; sourceFacilityId: string; destinationFacilityId: string; bloodGroupId: number; componentId: number;
        quantity: number; etaMinutes: number | null;
      },
    ) {
      const transfer = await redistributionRepository.createTransfer(tx, {
        sourceFacilityId: input.sourceFacilityId,
        destinationFacilityId: input.destinationFacilityId,
        bloodGroupId: input.bloodGroupId,
        componentId: input.componentId,
        quantity: input.quantity,
        recommendationId: input.recommendationId,
        initiatedBy: auth.userId,
        estimatedTransitMinutes: input.etaMinutes,
      });
      const facilities = await tx.facilities.findMany({
        where: { id: { in: [input.sourceFacilityId, input.destinationFacilityId] } },
        select: { id: true, organization_id: true },
      });
      const orgOf = new Map(facilities.map((f) => [f.id, f.organization_id]));
      // Same convention as the database's own transfer audit: one row for each organization involved.
      for (const facilityId of [input.destinationFacilityId, input.sourceFacilityId]) {
        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: orgOf.get(facilityId)!,
          facilityId,
          action: 'transfer.propose',
          entityType: 'transfer',
          entityId: transfer.id,
          oldValue: null,
          newValue: { status: 'PROPOSED', requested_quantity: input.quantity },
          correlationId: ctx.correlationId,
          ip: ctx.ip,
        });
      }
      return transfer;
    },
  };
}

export type TransferService = ReturnType<typeof createTransferService>;
