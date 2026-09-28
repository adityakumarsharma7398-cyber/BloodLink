import type { DbClient, Tx } from '../db/client.js';
import { Prisma, type $Enums } from '../generated/prisma/client.js';

export interface EligibleDonor {
  donorId: string;
  distanceKm: number;
}

export interface EligibilityFilter {
  bloodGroupIds: readonly number[];
  facilityLat: number;
  facilityLon: number;
  radiusKm: number;
  minIntervalDays: number;
  /** donors already targeted by an ACTIVE activation for this facility/group/component are never targeted twice */
  excludeFacilityId: string;
  excludeBloodGroupId: number;
  excludeComponentId: number;
  limit: number;
}

export interface DonorActivationInsert {
  organizationId: string;
  facilityId: string;
  predictionId: string | null;
  recommendationId: string | null;
  bloodGroupId: number;
  componentId: number;
  unitsNeeded: number;
  targetDonorCount: number;
  urgency: $Enums.urgency_level;
  radiusKm: number;
  donorMessage: string;
  activatedBy: string;
  expiresAt: Date;
}

export interface RecipientSummary {
  total: number;
  byResponse: Record<$Enums.donor_response, number>;
  byNotificationStatus: Record<$Enums.notification_status, number>;
}

const ZERO_RESPONSE: Record<$Enums.donor_response, number> = { NO_RESPONSE: 0, WILLING: 0, DECLINED: 0 };
const ZERO_NOTIFICATION: Record<$Enums.notification_status, number> = { PENDING: 0, SENT: 0, DELIVERED: 0, FAILED: 0 };

/**
 * Donor targeting and activation queries. Targeting criteria (consent, current status/availability, distance,
 * time since last donation, compatible blood group) are never medical eligibility — screening is blood-centre
 * staff's job at the donation itself (§8). Donor identity is returned only where the caller explicitly asks for
 * one donor's own row (respond) or for donors who have already said WILLING (matches the database's own RLS rule).
 */
export const donorActivationRepository = {
  /** Distinct compatible donor blood groups for this recipient group/component, from the existing compatibility rules only. */
  async compatibleDonorGroups(db: DbClient, recipientGroupId: number, componentId: number, allowDemoRules: boolean): Promise<number[]> {
    const rows = await db.$queryRaw<{ id: number }[]>(Prisma.sql`
      select distinct r.donor_blood_group_id as id from public.compatibility_rules r
      where r.recipient_blood_group_id = ${recipientGroupId}::int2 and r.component_id = ${componentId}::int2 and r.compatible
        and (r.validation_status = 'VALIDATED' or (r.validation_status = 'DEMO_ONLY' and ${allowDemoRules}::boolean))`);
    return rows.map((row) => row.id);
  },

  /** Consenting, currently-available donors within range who have not recently donated and are not already targeted. Nearest first. */
  async eligibleDonors(db: DbClient, filter: EligibilityFilter): Promise<EligibleDonor[]> {
    if (filter.bloodGroupIds.length === 0) return [];
    const rows = await db.$queryRaw<{ id: string; distance_km: number }[]>(Prisma.sql`
      with candidates as (
        select d.id,
          round((2 * 6371 * asin(sqrt(
            power(sin(radians(d.latitude - ${filter.facilityLat}::float8) / 2), 2) +
            cos(radians(${filter.facilityLat}::float8)) * cos(radians(d.latitude)) *
            power(sin(radians(d.longitude - ${filter.facilityLon}::float8) / 2), 2)
          )))::numeric, 1) as distance_km
        from public.donors d
        where d.consent_to_contact and d.status = 'ACTIVE' and d.availability_status = 'AVAILABLE'
          and d.blood_group_id = any(${[...filter.bloodGroupIds]}::int2[])
          and d.latitude is not null and d.longitude is not null
          and (d.last_donation_date is null or d.last_donation_date <= (now()::date - ${filter.minIntervalDays}::int))
          and not exists (
            select 1 from public.donor_activation_recipients rc join public.donor_activations da on da.id = rc.activation_id
            where rc.donor_id = d.id and da.status = 'ACTIVE' and da.facility_id = ${filter.excludeFacilityId}::uuid
              and da.blood_group_id = ${filter.excludeBloodGroupId}::int2 and da.component_id = ${filter.excludeComponentId}::int2)
      )
      select id, distance_km from candidates where distance_km <= ${filter.radiusKm}::numeric
      order by distance_km, id
      limit ${filter.limit}`);
    return rows.map((row) => ({ donorId: row.id, distanceKm: Number(row.distance_km) }));
  },

  async createActivation(tx: Tx, row: DonorActivationInsert) {
    return tx.donor_activations.create({
      data: {
        organization_id: row.organizationId,
        facility_id: row.facilityId,
        prediction_id: row.predictionId,
        recommendation_id: row.recommendationId,
        blood_group_id: row.bloodGroupId,
        component_id: row.componentId,
        units_needed: row.unitsNeeded,
        target_donor_count: row.targetDonorCount,
        urgency: row.urgency,
        radius_km: row.radiusKm,
        donor_message: row.donorMessage,
        status: 'ACTIVE',
        activated_by: row.activatedBy,
        expires_at: row.expiresAt,
      },
    });
  },

  /** `skipDuplicates` is the second guard (with the unique index) against ever targeting one donor twice in one activation. */
  async createRecipients(tx: Tx, activationId: string, donors: readonly EligibleDonor[]) {
    if (donors.length === 0) return 0;
    const result = await tx.donor_activation_recipients.createMany({
      data: donors.map((donor) => ({ activation_id: activationId, donor_id: donor.donorId, distance_km: donor.distanceKm })),
      skipDuplicates: true,
    });
    return result.count;
  },

  findActivation(db: DbClient, id: string) {
    return db.donor_activations.findUnique({ where: { id } });
  },

  async listActivations(db: DbClient, filter: { facilityIds: readonly string[]; status?: $Enums.donor_activation_status }, skip: number, take: number) {
    const where: Prisma.donor_activationsWhereInput = { facility_id: { in: [...filter.facilityIds] }, ...(filter.status ? { status: filter.status } : {}) };
    const [total, rows] = await Promise.all([
      db.donor_activations.count({ where }),
      db.donor_activations.findMany({ where, orderBy: [{ created_at: 'desc' }, { id: 'asc' }], skip, take }),
    ]);
    return { total, rows };
  },

  /** Counts only — never donor identities (matches the RLS comment "others as counts via backend"). */
  async recipientSummary(db: DbClient, activationId: string): Promise<RecipientSummary> {
    const rows = await db.donor_activation_recipients.groupBy({
      by: ['response', 'notification_status'],
      where: { activation_id: activationId },
      _count: { _all: true },
    });
    const byResponse = { ...ZERO_RESPONSE };
    const byNotificationStatus = { ...ZERO_NOTIFICATION };
    let total = 0;
    for (const row of rows) {
      byResponse[row.response] += row._count._all;
      byNotificationStatus[row.notification_status] += row._count._all;
      total += row._count._all;
    }
    return { total, byResponse, byNotificationStatus };
  },

  /** Donors who said WILLING: the only donor identities the activation's own staff may read (matches donors RLS). */
  async willingRecipients(db: DbClient, activationId: string) {
    return db.donor_activation_recipients.findMany({
      where: { activation_id: activationId, response: 'WILLING' },
      orderBy: [{ responded_at: 'asc' }],
      select: {
        id: true, distance_km: true, responded_at: true,
        donors: { select: { id: true, full_name: true, phone: true, email: true, blood_group_id: true } },
      },
    });
  },

  async pendingRecipients(tx: Tx, activationId: string) {
    return tx.donor_activation_recipients.findMany({
      where: { activation_id: activationId, notification_status: 'PENDING' },
      select: { id: true, donors: { select: { user_id: true } } },
    });
  },

  async markNotified(tx: Tx, outcomes: readonly { recipientId: string; delivered: boolean }[], at: Date) {
    for (const outcome of outcomes) {
      await tx.donor_activation_recipients.update({
        where: { id: outcome.recipientId },
        data: { notification_status: outcome.delivered ? 'SENT' : 'FAILED', notified_at: outcome.delivered ? at : null },
      });
    }
  },

  async setActivationStatus(tx: Tx, id: string, status: $Enums.donor_activation_status) {
    return tx.donor_activations.update({ where: { id }, data: { status } });
  },

  async expirePendingRecommendations(tx: Tx, facilityId: string): Promise<number> {
    const result = await tx.recommendations.updateMany({
      where: { facility_id: facilityId, recommendation_type: 'DONOR_ACTIVATION', status: 'PENDING' },
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
        recommendation_type: 'DONOR_ACTIVATION',
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

  /** The caller's own donor profile (by their user id), for the donor self-service endpoints only. */
  findDonorByUserId(db: DbClient, userId: string) {
    return db.donors.findUnique({ where: { user_id: userId }, select: { id: true } });
  },

  /** One recipient row, locked, together with the parent activation's status — for the donor's own response. */
  async lockRecipientForDonor(tx: Tx, recipientId: string, donorId: string) {
    await tx.$queryRaw(Prisma.sql`select id from public.donor_activation_recipients where id = ${recipientId}::uuid for update`);
    return tx.donor_activation_recipients.findFirst({
      where: { id: recipientId, donor_id: donorId },
      include: { donor_activations: true },
    });
  },

  async respond(tx: Tx, recipientId: string, response: 'WILLING' | 'DECLINED', at: Date) {
    return tx.donor_activation_recipients.update({ where: { id: recipientId }, data: { response, responded_at: at } });
  },

  /** The donor's own activations (their recipient rows), most recent first — never another donor's. */
  async mine(db: DbClient, donorId: string) {
    return db.donor_activation_recipients.findMany({
      where: { donor_id: donorId },
      orderBy: [{ created_at: 'desc' }],
      include: { donor_activations: { include: { blood_groups: { select: { code: true } }, components: { select: { code: true } } } } },
    });
  },

  async facilityLocation(db: DbClient, facilityId: string) {
    return db.facilities.findUnique({ where: { id: facilityId }, select: { latitude: true, longitude: true, name: true, organization_id: true } });
  },
};
