import type { DbClient, Tx } from '../db/client.js';
import { Prisma, type $Enums } from '../generated/prisma/client.js';

export interface FacilityInfo {
  id: string;
  name: string;
  organizationId: string;
  latitude: number;
  longitude: number;
  acceptsTemporaryHolds: boolean;
}

export interface NewRequest {
  requesterUserId: string;
  facilityId: string;
  urgency: $Enums.urgency_level;
  requiredBy: Date;
  bloodGroupId: number;
  componentId: number;
  quantity: number;
  allowCompatibleSubstitutes: boolean;
}

const ACTIVE_ALLOCATIONS: $Enums.allocation_status[] = ['RESERVED', 'CONFIRMED', 'DISPATCHED'];

/** Emergency request, source-selection and hold queries. Every call is scoped by facilities the service has authorized. */
export const emergencyRepository = {
  async facilities(db: DbClient, ids: readonly string[]): Promise<Map<string, FacilityInfo>> {
    if (ids.length === 0) return new Map();
    const rows = await db.facilities.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, name: true, organization_id: true, latitude: true, longitude: true, accepts_temporary_holds: true },
    });
    return new Map(rows.map((row) => [row.id, {
      id: row.id, name: row.name, organizationId: row.organization_id, latitude: row.latitude, longitude: row.longitude,
      acceptsTemporaryHolds: row.accepts_temporary_holds,
    }]));
  },

  /** A verified-at-creation request (EMERGENCY or ROUTINE) with one item. The database trigger re-checks the creator's role. */
  async createRequest(tx: Tx, input: NewRequest, now: Date, requestType: $Enums.request_type) {
    return tx.requests.create({
      data: {
        requester_user_id: input.requesterUserId,
        requester_facility_id: input.facilityId,
        patient_facility_id: input.facilityId,
        verifying_facility_id: input.facilityId,
        request_type: requestType,
        urgency: input.urgency,
        required_by: input.requiredBy,
        verification_status: 'VERIFIED',
        verification_method: 'STAFF_AT_CREATION',
        verified_by: input.requesterUserId,
        verified_at: now,
        request_items: {
          create: [{
            blood_group_id: input.bloodGroupId,
            component_id: input.componentId,
            quantity_requested: input.quantity,
            allow_compatible_substitutes: input.allowCompatibleSubstitutes,
          }],
        },
      },
      include: { request_items: true },
    });
  },

  findRequest(db: DbClient, id: string) {
    return db.requests.findUnique({ where: { id }, include: { request_items: true } });
  },

  async listRequests(
    db: DbClient,
    filter: { facilityIds: readonly string[]; status?: $Enums.request_status; requestType: $Enums.request_type },
    skip: number,
    take: number,
  ) {
    const facilities = [...filter.facilityIds];
    const where: Prisma.requestsWhereInput = {
      request_type: filter.requestType,
      OR: [{ patient_facility_id: { in: facilities } }, { requester_facility_id: { in: facilities } }],
      ...(filter.status ? { status: filter.status } : {}),
    };
    const [total, rows] = await Promise.all([
      db.requests.count({ where }),
      db.requests.findMany({ where, include: { request_items: true }, orderBy: [{ created_at: 'desc' }, { id: 'asc' }], skip, take }),
    ]);
    return { total, rows };
  },

  /** Holds/allocations of these items, without unit identifiers. */
  allocationsForItems(db: DbClient, itemIds: readonly string[]) {
    return db.request_allocations.findMany({
      where: { request_item_id: { in: [...itemIds] } },
      select: { request_item_id: true, source_facility_id: true, status: true, hold_expires_at: true, confirmed_at: true },
    });
  },

  async activeAllocationCount(db: DbClient, itemId: string): Promise<number> {
    return db.request_allocations.count({ where: { request_item_id: itemId, status: { in: ACTIVE_ALLOCATIONS } } });
  },

  /**
   * Validation statuses of the compatibility rules that would apply to this need (same conditions as the database
   * functions). Empty = no usable rule exists. Used only to explain an empty or demo-based result.
   */
  async applicableRuleStatuses(db: DbClient, recipientGroupId: number, componentId: number, allowSubstitutes: boolean, allowDemo: boolean): Promise<string[]> {
    const rows = await db.$queryRaw<{ status: string }[]>(Prisma.sql`
      select distinct r.validation_status::text as status from public.compatibility_rules r
      where r.recipient_blood_group_id = ${recipientGroupId}::int2 and r.component_id = ${componentId}::int2 and r.compatible
        and (r.validation_status = 'VALIDATED' or (r.validation_status = 'DEMO_ONLY' and ${allowDemo}::boolean))
        and (${allowSubstitutes}::boolean or r.donor_blood_group_id = r.recipient_blood_group_id)`);
    return rows.map((row) => row.status);
  },

  /** The newest pending source-selection recommendation of a request. */
  findPendingSelection(db: DbClient, requestId: string) {
    return db.recommendations.findFirst({
      where: { related_request_id: requestId, recommendation_type: 'EMERGENCY_SOURCE', status: 'PENDING' },
      orderBy: { created_at: 'desc' },
    });
  },

  async expirePendingSelections(tx: Tx, requestId: string): Promise<number> {
    const result = await tx.recommendations.updateMany({
      where: { related_request_id: requestId, recommendation_type: 'EMERGENCY_SOURCE', status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  },

  async createSelection(
    tx: Tx,
    row: {
      organizationId: string; facilityId: string; requestId: string; priority: $Enums.risk_level; payload: Prisma.InputJsonValue;
      what: string; why: string; data: Prisma.InputJsonValue; action: string; modelVersion: string; dedupeKey: string; validUntil: Date;
    },
  ): Promise<string> {
    const created = await tx.recommendations.create({
      data: {
        recommendation_type: 'EMERGENCY_SOURCE',
        organization_id: row.organizationId,
        facility_id: row.facilityId,
        related_request_id: row.requestId,
        status: 'PENDING',
        priority: row.priority,
        payload: row.payload,
        what_explanation: row.what,
        why_explanation: row.why,
        data_explanation: row.data,
        action_explanation: row.action,
        source: 'SYSTEM_RULE',
        model_version: row.modelVersion,
        dedupe_key: row.dedupeKey,
        valid_until: row.validUntil,
      },
      select: { id: true },
    });
    return created.id;
  },

  /** Holds waiting at (or confirmed by) these source facilities: the minimum delivery data only. */
  async incomingHolds(db: DbClient, sourceFacilityIds: readonly string[]) {
    if (sourceFacilityIds.length === 0) return [];
    return db.$queryRaw<
      {
        source_facility_id: string; request_id: string; request_number: string; request_item_id: string; blood_group_id: number;
        component_id: number; urgency: string; required_by: Date; destination_facility_id: string; status: string;
        hold_expires_at: Date | null; quantity: number; allocation_ids: string[];
      }[]
    >(Prisma.sql`
      select a.source_facility_id, r.id as request_id, r.request_number, i.id as request_item_id, i.blood_group_id, i.component_id,
             coalesce(i.urgency, r.urgency)::text as urgency, coalesce(i.required_by, r.required_by) as required_by,
             r.patient_facility_id as destination_facility_id, a.status::text as status, a.hold_expires_at,
             count(*)::int as quantity, array_agg(a.id order by a.id) as allocation_ids
      from public.request_allocations a
      join public.request_items i on i.id = a.request_item_id
      join public.requests r on r.id = i.request_id
      where a.source_facility_id = any(${[...sourceFacilityIds]}::uuid[]) and a.status in ('RESERVED', 'CONFIRMED')
      group by a.source_facility_id, r.id, r.request_number, i.id, i.blood_group_id, i.component_id, i.urgency, r.urgency,
               i.required_by, r.required_by, r.patient_facility_id, a.status, a.hold_expires_at
      order by required_by, r.request_number, a.status`);
  },

  allocationsByIds(db: DbClient, ids: readonly string[]) {
    return db.request_allocations.findMany({ where: { id: { in: [...ids] } }, select: { id: true, source_facility_id: true } });
  },
};
