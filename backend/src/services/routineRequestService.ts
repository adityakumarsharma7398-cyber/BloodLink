import type { AuditService } from '../audit/auditService.js';
import type { AppRole, AuthContext } from '../auth/types.js';
import { assertFacilityAccess, hasAnyRole } from '../authz/permissions.js';
import type { Database } from '../db/client.js';
import type { $Enums } from '../generated/prisma/client.js';
import { pageMeta, toPageWindow } from '../http/schemas.js';
import { emergencyRepository } from '../repositories/emergencyRepository.js';
import { intelligenceRepository } from '../repositories/intelligenceRepository.js';
import { referenceRepository } from '../repositories/referenceRepository.js';
import { HttpError, notFound } from '../utils/httpError.js';
import type { CreateRequestInput } from './emergencyService.js';
import { toRequestDtos, type RequestRow } from './requestMapping.js';
import type { CallContext } from './intelligenceService.js';

/**
 * Routine (non-emergency) blood requests, created by ordinary hospital staff for their own facility.
 * These are rows of the same `requests`/`request_items` tables as the emergency workflow — only
 * `request_type = 'ROUTINE'` and the role gate differ. No network source-selection, hold, dispatch,
 * transfer or issue endpoint is exposed here: those remain staff-only actions taken by the source
 * blood centre through the existing emergency/transfer workflows, unchanged.
 */
export const ROUTINE_REQUEST_ROLES: readonly AppRole[] = ['HOSPITAL_STAFF', 'DOCTOR'];

export function createRoutineRequestService(db: Database, audit: AuditService) {
  const canAct = (auth: AuthContext, facilityIds: readonly (string | null)[]) =>
    facilityIds.some((facilityId) => facilityId !== null && hasAnyRole(auth, ROUTINE_REQUEST_ROLES, { facilityId }));

  const toDtos = (rows: RequestRow[]) => toRequestDtos(db, rows);

  async function loadActable(auth: AuthContext, id: string) {
    const row = await emergencyRepository.findRequest(db.prisma, id);
    // A routine-request id that turns out to be an EMERGENCY request is treated as not found here —
    // each workflow only ever sees its own requests, even for a user who could act on both.
    if (!row || row.request_type !== 'ROUTINE' || !canAct(auth, [row.patient_facility_id, row.requester_facility_id])) throw notFound();
    return row;
  }

  return {
    /** A staff-created routine request: verified at creation (same rule as emergency, decision 2), one item. */
    async createRequest(auth: AuthContext, ctx: CallContext, input: CreateRequestInput) {
      assertFacilityAccess(auth, input.facilityId, { roles: ROUTINE_REQUEST_ROLES, hide: true });
      const [groups, components] = await Promise.all([referenceRepository.bloodGroups(db.prisma), referenceRepository.components(db.prisma)]);
      if (!groups.some((g) => g.id === input.bloodGroupId) || !components.some((c) => c.id === input.componentId && c.active)) {
        throw new HttpError(422, 'Unknown blood group or component', 'UNKNOWN_PRODUCT');
      }

      const created = await db.withTransaction(async (tx) => {
        const now = await intelligenceRepository.databaseNow(tx);
        if (input.requiredBy <= now) throw new HttpError(422, 'The required-by time must be in the future', 'REQUIRED_BY_IN_PAST');
        const facility = (await emergencyRepository.facilities(tx, [input.facilityId])).get(input.facilityId);
        if (!facility) throw notFound();
        const request = await emergencyRepository.createRequest(tx, { ...input, requesterUserId: auth.userId }, now, 'ROUTINE');
        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: facility.organizationId,
          facilityId: input.facilityId,
          action: 'request.create',
          entityType: 'request',
          entityId: request.id,
          newValue: {
            request_number: request.request_number, request_type: 'ROUTINE', urgency: input.urgency, blood_group_id: input.bloodGroupId,
            component_id: input.componentId, quantity: input.quantity, verification_method: 'STAFF_AT_CREATION',
          },
          correlationId: ctx.correlationId,
          ip: ctx.ip,
        });
        return request.id;
      });
      return this.getRequest(auth, created);
    },

    async listRequests(auth: AuthContext, query: { facilityId?: string; status?: $Enums.request_status; page: number; pageSize: number }) {
      let facilityIds: string[];
      if (query.facilityId) {
        assertFacilityAccess(auth, query.facilityId, { roles: ROUTINE_REQUEST_ROLES, hide: true });
        facilityIds = [query.facilityId];
      } else {
        facilityIds = auth.facilities.filter((f) => hasAnyRole(auth, ROUTINE_REQUEST_ROLES, { facilityId: f.id })).map((f) => f.id);
      }
      const window = toPageWindow(query);
      const { total, rows } = await emergencyRepository.listRequests(db.prisma, { facilityIds, status: query.status, requestType: 'ROUTINE' }, window.skip, window.take);
      return { data: await toDtos(rows), pagination: pageMeta(query, total) };
    },

    async getRequest(auth: AuthContext, id: string) {
      const [dto] = await toDtos([await loadActable(auth, id)]);
      return dto!;
    },
  };
}

export type RoutineRequestService = ReturnType<typeof createRoutineRequestService>;
