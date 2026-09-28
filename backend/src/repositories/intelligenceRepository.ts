import type { DbClient, Tx } from '../db/client.js';
import { Prisma, type $Enums } from '../generated/prisma/client.js';

export interface IncomingRow {
  bloodGroupId: number;
  componentId: number;
  units: number;
}

export interface PredictionInsert {
  id: string;
  runId: string;
  organizationId: string;
  facilityId: string;
  bloodGroupId: number;
  componentId: number;
  predictionType: 'DEMAND' | 'SHORTAGE';
  horizonDays: number;
  periodStart: string;
  periodEnd: string;
  predictedDailyDemand: number | null;
  predictedQuantity: number | null;
  usableUnits: number;
  reservedUnits: number;
  incomingUnits: number;
  expiringUnits: number | null;
  daysOfCover: number | null;
  predictedShortageDate: string | null;
  shortageRisk: $Enums.risk_level | null;
  explanation: Prisma.InputJsonValue;
  modelName: string;
  modelVersion: string;
  /** Present only when a real forecasting model (not the trailing-average baseline) produced the demand figure. */
  confidenceScore: number | null;
  confidenceMethod: string | null;
}

export interface RecommendationInsert {
  organizationId: string;
  facilityId: string;
  relatedPredictionId: string;
  priority: $Enums.risk_level;
  payload: Prisma.InputJsonValue;
  whatExplanation: string;
  whyExplanation: string;
  dataExplanation: Prisma.InputJsonValue;
  actionExplanation: string;
  modelVersion: string;
  dedupeKey: string;
  validUntil: Date;
}

const asDate = (value: string) => new Date(`${value}T00:00:00.000Z`);

export const intelligenceRepository = {
  async databaseNow(db: DbClient): Promise<Date> {
    const [row] = await db.$queryRaw<{ now: Date }[]>(Prisma.sql`select now() as now`);
    return row!.now;
  },

  /** Serialises intelligence runs for one facility so two runs cannot both write "current" rows. */
  async lockFacilityRun(tx: Tx, facilityId: string): Promise<void> {
    await tx.$executeRaw(Prisma.sql`select pg_advisory_xact_lock(hashtextextended(${`intelligence-run:${facilityId}`}, 0))`);
  },

  /**
   * The trailing `historyDays` of `public.v_daily_consumption` (already zero-filled, IST calendar days,
   * one row per day with no gaps) for one series, oldest first — exactly the ledger history a demand
   * forecast is built from. Only as many days as actually exist are returned; a series with a shorter
   * history is not padded with invented zeros before its first-ever issue.
   */
  async dailyConsumption(db: DbClient, facilityId: string, bloodGroupId: number, componentId: number, historyDays: number) {
    const rows = await db.$queryRaw<{ day: Date; units_issued: number }[]>(Prisma.sql`
      select day, units_issued from public.v_daily_consumption
      where facility_id = ${facilityId}::uuid and blood_group_id = ${bloodGroupId}::int2 and component_id = ${componentId}::int2
      order by day desc limit ${historyDays}`);
    return rows.reverse().map((row) => ({ date: row.day.toISOString().slice(0, 10), unitsIssued: row.units_issued }));
  },

  /** Units IN_TRANSIT on transfers headed for this facility, per blood group and component. */
  async incomingInTransit(db: DbClient, facilityId: string): Promise<IncomingRow[]> {
    const rows = await db.$queryRaw<{ blood_group_id: number; component_id: number; units: number }[]>(Prisma.sql`
      select t.blood_group_id, t.component_id, count(*)::int as units
      from public.transfers t
      join public.transfer_items ti on ti.transfer_id = t.id
      join public.inventory_units u on u.id = ti.inventory_unit_id
      where t.destination_facility_id = ${facilityId}::uuid and t.status = 'IN_TRANSIT' and u.status = 'IN_TRANSIT'
      group by t.blood_group_id, t.component_id`);
    return rows.map((row) => ({ bloodGroupId: row.blood_group_id, componentId: row.component_id, units: row.units }));
  },

  async supersedeCurrentPredictions(tx: Tx, facilityId: string, at: Date): Promise<number> {
    const result = await tx.predictions.updateMany({
      where: { facility_id: facilityId, superseded_at: null, prediction_type: { in: ['DEMAND', 'SHORTAGE'] } },
      data: { superseded_at: at },
    });
    return result.count;
  },

  async createPredictions(tx: Tx, rows: readonly PredictionInsert[], generatedAt: Date): Promise<void> {
    if (rows.length === 0) return;
    await tx.predictions.createMany({
      data: rows.map((row) => ({
        id: row.id,
        run_id: row.runId,
        organization_id: row.organizationId,
        facility_id: row.facilityId,
        blood_group_id: row.bloodGroupId,
        component_id: row.componentId,
        prediction_type: row.predictionType,
        horizon_days: row.horizonDays,
        period_start: asDate(row.periodStart),
        period_end: asDate(row.periodEnd),
        predicted_daily_demand: row.predictedDailyDemand,
        predicted_quantity: row.predictedQuantity,
        usable_units: row.usableUnits,
        reserved_units: row.reservedUnits,
        incoming_units: row.incomingUnits,
        expiring_units: row.expiringUnits,
        days_of_cover: row.daysOfCover,
        predicted_shortage_date: row.predictedShortageDate ? asDate(row.predictedShortageDate) : null,
        shortage_risk: row.shortageRisk,
        explanation: row.explanation,
        model_name: row.modelName,
        model_version: row.modelVersion,
        confidence_score: row.confidenceScore,
        confidence_method: row.confidenceMethod,
        generated_at: generatedAt,
      })),
    });
  },

  /** Pending procurement recommendations of a facility become EXPIRED: the new run replaces them. */
  async expirePendingProcurement(tx: Tx, facilityId: string): Promise<number> {
    const result = await tx.recommendations.updateMany({
      where: { facility_id: facilityId, recommendation_type: 'PROCUREMENT', status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  },

  async createRecommendation(tx: Tx, row: RecommendationInsert): Promise<string> {
    const created = await tx.recommendations.create({
      data: {
        recommendation_type: 'PROCUREMENT',
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

  async predictions(
    db: DbClient,
    filter: { facilityIds: readonly string[]; predictionType?: 'DEMAND' | 'SHORTAGE'; currentOnly: boolean; bloodGroupId?: number; componentId?: number },
    skip: number,
    take: number,
  ) {
    const where: Prisma.predictionsWhereInput = {
      facility_id: { in: [...filter.facilityIds] },
      ...(filter.predictionType ? { prediction_type: filter.predictionType } : {}),
      ...(filter.currentOnly ? { superseded_at: null } : {}),
      ...(filter.bloodGroupId ? { blood_group_id: filter.bloodGroupId } : {}),
      ...(filter.componentId ? { component_id: filter.componentId } : {}),
    };
    const [total, rows] = await Promise.all([
      db.predictions.count({ where }),
      db.predictions.findMany({
        where,
        orderBy: [{ generated_at: 'desc' }, { blood_group_id: 'asc' }, { component_id: 'asc' }, { prediction_type: 'asc' }, { id: 'asc' }],
        skip,
        take,
        include: { blood_groups: { select: { code: true } }, components: { select: { code: true } } },
      }),
    ]);
    return { total, rows };
  },

  async recommendations(
    db: DbClient,
    filter: { facilityIds: readonly string[]; status?: $Enums.recommendation_status; recommendationType?: $Enums.recommendation_type },
    skip: number,
    take: number,
  ) {
    const where: Prisma.recommendationsWhereInput = {
      facility_id: { in: [...filter.facilityIds] },
      ...(filter.status ? { status: filter.status } : {}),
      recommendation_type: filter.recommendationType ?? { in: ['PROCUREMENT', 'REDISTRIBUTION', 'DONOR_ACTIVATION'] },
    };
    const [total, rows] = await Promise.all([
      db.recommendations.count({ where }),
      db.recommendations.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'asc' }], skip, take }),
    ]);
    return { total, rows };
  },

  /** Row-locks and returns the recommendation so concurrent decisions serialise. */
  async lockRecommendation(tx: Tx, id: string) {
    await tx.$queryRaw(Prisma.sql`select id from public.recommendations where id = ${id}::uuid for update`);
    return tx.recommendations.findUnique({ where: { id } });
  },

  async decideRecommendation(
    tx: Tx,
    id: string,
    data: { status: 'APPROVED' | 'MODIFIED' | 'REJECTED'; decidedBy: string; decisionNote: string | null; modifiedPayload?: Prisma.InputJsonValue },
  ) {
    return tx.recommendations.update({
      where: { id },
      data: {
        status: data.status,
        decided_by: data.decidedBy,
        decided_at: new Date(),
        decision_note: data.decisionNote,
        ...(data.modifiedPayload !== undefined ? { modified_payload: data.modifiedPayload } : {}),
      },
    });
  },
};
