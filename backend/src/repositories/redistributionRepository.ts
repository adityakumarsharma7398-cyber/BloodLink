import type { DbClient, Tx } from '../db/client.js';
import { Prisma, type $Enums } from '../generated/prisma/client.js';

export interface CandidateFacility {
  id: string;
  name: string;
  organizationId: string;
  latitude: number;
  longitude: number;
}

export interface SourceFigure {
  facilityId: string;
  bloodGroupId: number;
  componentId: number;
  usable: number;
  pending: number;
  demand: number | null;
  sourcePredictionId: string | null;
}

export interface TransferFilter {
  facilityIds: readonly string[];
  status?: $Enums.transfer_status;
}

/** Queries for redistribution. Source-side figures stay inside the backend; only derived shared outputs go out. */
export const redistributionRepository = {
  /** Facilities that may act as a source: inventory-holding, operational, in a verified organization that shares availability. */
  async candidateFacilities(db: DbClient, excludeFacilityId: string): Promise<CandidateFacility[]> {
    const rows = await db.$queryRaw<{ id: string; name: string; organization_id: string; latitude: number; longitude: number }[]>(Prisma.sql`
      select f.id, f.name, f.organization_id, f.latitude, f.longitude
      from public.facilities f join public.organizations o on o.id = f.organization_id
      where f.holds_inventory and f.operating_status = 'OPERATIONAL'
        and o.shares_network_availability and o.status in ('VERIFIED', 'ACTIVE')
        and f.id <> ${excludeFacilityId}::uuid
      order by f.name, f.id`);
    return rows.map((row) => ({ id: row.id, name: row.name, organizationId: row.organization_id, latitude: row.latitude, longitude: row.longitude }));
  },

  /** Is this facility still a valid source (same conditions as candidateFacilities)? */
  async isEligibleSource(db: DbClient, facilityId: string): Promise<boolean> {
    const rows = await db.$queryRaw<{ ok: boolean }[]>(Prisma.sql`
      select true as ok from public.facilities f join public.organizations o on o.id = f.organization_id
      where f.id = ${facilityId}::uuid and f.holds_inventory and f.operating_status = 'OPERATIONAL'
        and o.shares_network_availability and o.status in ('VERIFIED', 'ACTIVE')`);
    return rows.length > 0;
  },

  /**
   * Source-side inputs for §7.2a, per (facility, blood group, component). Usable and pending use the same
   * definitions as the approved network aggregate (§10.3); demand is the source's own current prediction.
   */
  async sourceFigures(db: DbClient, pairs: readonly { facilityId: string; bloodGroupId: number; componentId: number }[]): Promise<SourceFigure[]> {
    if (pairs.length === 0) return [];
    const rows = await db.$queryRaw<
      { facility_id: string; blood_group_id: number; component_id: number; usable: number; pending: number; demand: string | null; source_prediction_id: string | null }[]
    >(Prisma.sql`
      with p as (
        select * from unnest(${pairs.map((x) => x.facilityId)}::uuid[], ${pairs.map((x) => x.bloodGroupId)}::int2[],
                             ${pairs.map((x) => x.componentId)}::int2[]) as t(facility_id, blood_group_id, component_id)
      )
      select p.facility_id, p.blood_group_id, p.component_id,
        (select count(*) from public.inventory_units u
          where u.facility_id = p.facility_id and u.blood_group_id = p.blood_group_id and u.component_id = p.component_id
            and u.status = 'AVAILABLE' and u.expiry_date > now())::int as usable,
        (select coalesce(sum(i.quantity_requested - i.quantity_fulfilled
                  - (select count(*) from public.request_allocations a
                     where a.request_item_id = i.id and a.status in ('RESERVED', 'CONFIRMED', 'DISPATCHED'))), 0)
           from public.request_items i
           join public.requests rq on rq.id = i.request_id
           join public.facilities pf on pf.id = rq.patient_facility_id
           where pf.organization_id = (select sf.organization_id from public.facilities sf where sf.id = p.facility_id)
             and rq.verification_status = 'VERIFIED' and rq.status in ('OPEN', 'ALLOCATED', 'PARTIALLY_FULFILLED')
             and i.blood_group_id = p.blood_group_id and i.component_id = p.component_id)::int as pending,
        pred.daily as demand, pred.id as source_prediction_id
      from p
      left join lateral (
        select pr.id, pr.predicted_daily_demand as daily from public.predictions pr
        where pr.facility_id = p.facility_id and pr.blood_group_id = p.blood_group_id and pr.component_id = p.component_id
          and pr.prediction_type in ('DEMAND', 'SHORTAGE') and pr.superseded_at is null and pr.predicted_daily_demand is not null
        order by (pr.prediction_type = 'DEMAND') desc, pr.generated_at desc limit 1
      ) pred on true`);
    return rows.map((row) => ({
      facilityId: row.facility_id,
      bloodGroupId: row.blood_group_id,
      componentId: row.component_id,
      usable: row.usable,
      pending: row.pending,
      demand: row.demand === null ? null : Number(row.demand),
      sourcePredictionId: row.source_prediction_id,
    }));
  },

  /** The destination's own current SHORTAGE predictions. */
  currentShortagePredictions(db: DbClient, facilityId: string) {
    return db.predictions.findMany({
      where: { facility_id: facilityId, prediction_type: 'SHORTAGE', superseded_at: null },
      select: {
        id: true, blood_group_id: true, component_id: true, predicted_daily_demand: true, usable_units: true, incoming_units: true,
        days_of_cover: true, shortage_risk: true, period_end: true,
      },
      orderBy: [{ blood_group_id: 'asc' }, { component_id: 'asc' }],
    });
  },

  async expirePendingRedistribution(tx: Tx, facilityId: string): Promise<number> {
    const result = await tx.recommendations.updateMany({
      where: { facility_id: facilityId, recommendation_type: 'REDISTRIBUTION', status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  },

  async createRecommendation(
    tx: Tx,
    row: {
      organizationId: string; facilityId: string; relatedPredictionId: string; priority: $Enums.risk_level; payload: Prisma.InputJsonValue;
      whatExplanation: string; whyExplanation: string; dataExplanation: Prisma.InputJsonValue; actionExplanation: string;
      modelVersion: string; dedupeKey: string; validUntil: Date;
    },
  ): Promise<string> {
    const created = await tx.recommendations.create({
      data: {
        recommendation_type: 'REDISTRIBUTION',
        organization_id: row.organizationId,
        facility_id: row.facilityId,
        related_prediction_id: row.relatedPredictionId,
        status: 'PENDING',
        priority: row.priority,
        payload: row.payload,
        what_explanation: row.whatExplanation,
        why_explanation: row.whyExplanation,
        data_explanation: row.dataExplanation,
        action_explanation: row.actionExplanation,
        source: 'SYSTEM_RULE',
        model_version: row.modelVersion,
        dedupe_key: row.dedupeKey,
        valid_until: row.validUntil,
      },
      select: { id: true },
    });
    return created.id;
  },

  /** A PROPOSED transfer from an approved recommendation. The database trigger re-checks the initiator's role. */
  async createTransfer(
    tx: Tx,
    row: {
      sourceFacilityId: string; destinationFacilityId: string; bloodGroupId: number; componentId: number; quantity: number;
      recommendationId: string; initiatedBy: string; estimatedTransitMinutes: number | null;
    },
  ) {
    return tx.transfers.create({
      data: {
        source_facility_id: row.sourceFacilityId,
        destination_facility_id: row.destinationFacilityId,
        blood_group_id: row.bloodGroupId,
        component_id: row.componentId,
        requested_quantity: row.quantity,
        recommendation_id: row.recommendationId,
        status: 'PROPOSED',
        reason: 'Redistribution recommendation',
        initiated_by: row.initiatedBy,
        estimated_transit_minutes: row.estimatedTransitMinutes,
      },
    });
  },

  async facilityNames(db: DbClient, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db.facilities.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, row.name]));
  },

  async transfers(db: DbClient, filter: TransferFilter, skip: number, take: number) {
    const facilities = [...filter.facilityIds];
    const where: Prisma.transfersWhereInput = {
      OR: [{ source_facility_id: { in: facilities } }, { destination_facility_id: { in: facilities } }],
      ...(filter.status ? { status: filter.status } : {}),
    };
    const [total, rows] = await Promise.all([
      db.transfers.count({ where }),
      db.transfers.findMany({ where, orderBy: [{ requested_at: 'desc' }, { id: 'asc' }], skip, take }),
    ]);
    return { total, rows };
  },

  findTransfer(db: DbClient, id: string) {
    return db.transfers.findUnique({ where: { id } });
  },
};
