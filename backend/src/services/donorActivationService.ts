import type { AuditService } from '../audit/auditService.js';
import type { AppRole, AuthContext } from '../auth/types.js';
import { assertFacilityAccess, hasAnyRole } from '../authz/permissions.js';
import type { Database, Tx } from '../db/client.js';
import type { $Enums } from '../generated/prisma/client.js';
import { pageMeta, toPageWindow } from '../http/schemas.js';
import { istDate, istStartOfDay, MODEL_NAME, MODEL_VERSION } from '../intelligence/planning.js';
import { PARAMETER_KEYS, parseNonNegativeInteger, parsePositiveNumber, parseTargetDays, resolveParameter } from '../inventory/parameters.js';
import { donorActivationRepository, type EligibleDonor } from '../repositories/donorActivationRepository.js';
import { intelligenceRepository } from '../repositories/intelligenceRepository.js';
import { inventoryRepository } from '../repositories/inventoryRepository.js';
import { redistributionRepository } from '../repositories/redistributionRepository.js';
import { referenceRepository } from '../repositories/referenceRepository.js';
import type { NotificationAdapter } from './notifications/notificationAdapter.js';
import { HttpError, notFound } from '../utils/httpError.js';
import { INVENTORY_READ_ROLES } from './inventoryService.js';
import type { CallContext } from './intelligenceService.js';

/** Read: same people who read the facility's stock (§9.2). Run/decide/notify/cancel: the same roles as procurement. */
export const DONOR_ACTIVATION_READ_ROLES: readonly AppRole[] = INVENTORY_READ_ROLES;
export const DONOR_ACTIVATION_RUN_ROLES: readonly AppRole[] = ['ORG_ADMIN', 'BLOOD_BANK_ADMIN', 'INVENTORY_MANAGER'];
export const DONOR_ACTIVATION_MANAGE_ROLES: readonly AppRole[] = ['ORG_ADMIN', 'BLOOD_BANK_ADMIN'];

const MODEL = `${MODEL_NAME}@${MODEL_VERSION}`;
const MAX_CANDIDATES = 200;
const donorMessageFor = (unitsNeeded: number, bloodGroup: string, component: string) =>
  `${component} donors of blood group ${bloodGroup} are needed — please consider donating. Blood-centre staff will confirm your eligibility.`;

export type ActivationSkip = 'TARGET_MET' | 'TARGET_NOT_CONFIGURED' | 'RADIUS_NOT_CONFIGURED' | 'MIN_INTERVAL_NOT_CONFIGURED' | 'INVALID_PARAMETER' | 'NO_COMPATIBLE_DONOR_GROUP' | 'NO_ELIGIBLE_DONORS';

export function createDonorActivationService(db: Database, audit: AuditService, notifications: NotificationAdapter, options: { allowDemoRules: boolean }) {
  const readableFacilityIds = (auth: AuthContext, roles: readonly AppRole[]) =>
    auth.facilities.filter((facility) => hasAnyRole(auth, roles, { facilityId: facility.id })).map((facility) => facility.id);

  async function facilityScope(auth: AuthContext, roles: readonly AppRole[], facilityId?: string): Promise<string[]> {
    if (facilityId) {
      assertFacilityAccess(auth, facilityId, { roles, hide: true });
      return [facilityId];
    }
    return readableFacilityIds(auth, roles);
  }

  async function activationDto(row: NonNullable<Awaited<ReturnType<typeof donorActivationRepository.findActivation>>>) {
    const [groups, components, summary] = await Promise.all([
      referenceRepository.bloodGroups(db.prisma),
      referenceRepository.components(db.prisma),
      donorActivationRepository.recipientSummary(db.prisma, row.id),
    ]);
    const willing = row.status !== 'CANCELLED' ? await donorActivationRepository.willingRecipients(db.prisma, row.id) : [];
    return {
      id: row.id,
      facilityId: row.facility_id,
      bloodGroup: groups.find((g) => g.id === row.blood_group_id)?.code ?? '',
      component: components.find((c) => c.id === row.component_id)?.code ?? '',
      unitsNeeded: row.units_needed,
      targetDonorCount: row.target_donor_count,
      urgency: row.urgency,
      radiusKm: Number(row.radius_km),
      donorMessage: row.donor_message,
      status: row.status,
      expiresAt: row.expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      recipients: { total: summary.total, byResponse: summary.byResponse, byNotificationStatus: summary.byNotificationStatus },
      // Donor identities are exposed ONLY for those who have already said WILLING (matches the database's own RLS rule).
      willingDonors: willing.map((w) => ({
        recipientId: w.id,
        distanceKm: Number(w.distance_km),
        respondedAt: w.responded_at?.toISOString() ?? null,
        donor: { id: w.donors.id, fullName: w.donors.full_name, phone: w.donors.phone, email: w.donors.email },
      })),
    };
  }

  return {
    /**
     * Identifies whether donor activation is appropriate for this facility, from its own CURRENT SHORTAGE
     * predictions: still short of `coverage.target_days` after stock and incoming supply (the same deficit rule
     * procurement and redistribution use). Nothing here decides eligibility — it only estimates how many units
     * are needed and how many consenting, currently-eligible donors could be asked; a human still approves.
     */
    async run(auth: AuthContext, ctx: CallContext, facilityId: string) {
      assertFacilityAccess(auth, facilityId, { roles: DONOR_ACTIVATION_RUN_ROLES, hide: true });

      return db.withTransaction(async (tx) => {
        await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`donor-activation-run:${facilityId}`}, 0))`;
        const [facility] = await inventoryRepository.holdingFacilities(tx, [facilityId]);
        if (!facility) throw new HttpError(422, 'This facility does not hold inventory', 'FACILITY_HOLDS_NO_INVENTORY');
        const location = await donorActivationRepository.facilityLocation(tx, facilityId);
        if (!location || location.latitude === null || location.longitude === null) {
          throw new HttpError(422, 'The facility has no location on file', 'FACILITY_LOCATION_MISSING');
        }

        const [groups, components, predictions, parameterRows] = await Promise.all([
          referenceRepository.bloodGroups(tx),
          referenceRepository.components(tx),
          redistributionRepository.currentShortagePredictions(tx, facilityId),
          inventoryRepository.parameterRows(tx, [facility.organizationId]),
        ]);
        const groupCode = new Map(groups.map((g) => [g.id, g.code]));
        const componentCode = new Map(components.map((c) => [c.id, c.code]));

        const expired = await donorActivationRepository.expirePendingRecommendations(tx, facilityId);
        const created: { id: string; bloodGroup: string; component: string; unitsNeeded: number; targetDonorCount: number; eligibleDonorCount: number; priority: string }[] = [];
        const skipped = new Map<ActivationSkip, number>();
        const bump = (reason: ActivationSkip) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
        const now = await intelligenceRepository.databaseNow(tx);

        for (const p of predictions) {
          const demand = p.predicted_daily_demand === null ? null : Number(p.predicted_daily_demand);
          if (demand === null || demand <= 0 || p.usable_units === null || p.incoming_units === null || p.shortage_risk === null) {
            bump('TARGET_MET');
            continue;
          }
          const scope = { facilityId, organizationId: facility.organizationId, bloodGroupId: p.blood_group_id, componentId: p.component_id };
          const target = parseTargetDays(resolveParameter(parameterRows, PARAMETER_KEYS.targetDays, scope));
          if (!target.ok) {
            bump(target.reason === 'INVALID_PARAMETER' ? 'INVALID_PARAMETER' : 'TARGET_NOT_CONFIGURED');
            continue;
          }
          const projectedSupply = p.usable_units + p.incoming_units;
          const deficit = Math.ceil(Math.round((target.value * demand - projectedSupply) * 1e6) / 1e6);
          if (deficit <= 0) {
            bump('TARGET_MET');
            continue;
          }

          const radius = parsePositiveNumber(resolveParameter(parameterRows, PARAMETER_KEYS.donorSearchRadiusKm, scope));
          if (!radius.ok) {
            bump(radius.reason === 'INVALID_PARAMETER' ? 'INVALID_PARAMETER' : 'RADIUS_NOT_CONFIGURED');
            continue;
          }
          const minInterval = parseNonNegativeInteger(resolveParameter(parameterRows, PARAMETER_KEYS.donorMinIntervalDays, scope));
          if (!minInterval.ok) {
            bump(minInterval.reason === 'INVALID_PARAMETER' ? 'INVALID_PARAMETER' : 'MIN_INTERVAL_NOT_CONFIGURED');
            continue;
          }
          const groupIds = await donorActivationRepository.compatibleDonorGroups(tx, p.blood_group_id, p.component_id, options.allowDemoRules);
          if (groupIds.length === 0) {
            bump('NO_COMPATIBLE_DONOR_GROUP');
            continue;
          }
          const donors = await donorActivationRepository.eligibleDonors(tx, {
            bloodGroupIds: groupIds, facilityLat: location.latitude, facilityLon: location.longitude, radiusKm: radius.value,
            minIntervalDays: minInterval.value, excludeFacilityId: facilityId, excludeBloodGroupId: p.blood_group_id,
            excludeComponentId: p.component_id, limit: MAX_CANDIDATES,
          });
          if (donors.length === 0) {
            bump('NO_ELIGIBLE_DONORS');
            continue;
          }

          // One donor per unit needed is a targeting assumption (not a clinical yield rule), capped at what exists;
          // a human may lower it further when deciding.
          const suggestedDonorCount = Math.min(deficit, donors.length);
          const label = `${groupCode.get(p.blood_group_id)} ${componentCode.get(p.component_id)}`;
          const id = await donorActivationRepository.createRecommendation(tx, {
            organizationId: facility.organizationId,
            facilityId,
            relatedPredictionId: p.id,
            priority: p.shortage_risk,
            // §7.3: counts only — no donor identity is ever placed in a recommendation.
            payload: {
              facility_id: facilityId, blood_group_id: p.blood_group_id, component_id: p.component_id,
              units_needed: deficit, eligible_donor_count: donors.length, radius_km: radius.value, quantity: suggestedDonorCount,
            },
            whatExplanation: `Activate ${suggestedDonorCount} donor(s) for ${label} at ${facility.name}.`,
            whyExplanation: `${facility.name} needs about ${deficit} more unit(s) of ${label} to reach its target cover; ${donors.length} consenting donor(s) are within ${radius.value} km.`,
            dataExplanation: {
              method: 'rule-based baseline; not AI', units_needed: deficit, eligible_donor_count: donors.length, radius_km: radius.value,
              suggested_donor_count: suggestedDonorCount, assumption: 'one donor targeted per unit still needed, capped at the number of eligible donors',
              model: { name: MODEL_NAME, version: MODEL_VERSION },
            },
            actionExplanation: 'Blood-centre staff review and approve, lower the donor count, or reject. Approving selects and notifies donors; it never releases blood, and screening at donation remains staff’s decision.',
            modelVersion: MODEL,
            dedupeKey: `donor_activation:${facilityId}:${p.blood_group_id}:${p.component_id}`,
            validUntil: istStartOfDay(istDate(now, 1)),
          });
          created.push({ id, bloodGroup: groupCode.get(p.blood_group_id) ?? '', component: componentCode.get(p.component_id) ?? '', unitsNeeded: deficit, targetDonorCount: suggestedDonorCount, eligibleDonorCount: donors.length, priority: p.shortage_risk });
        }

        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: facility.organizationId,
          facilityId,
          action: 'donor_activation.recommend',
          entityType: 'recommendation_run',
          entityId: facilityId,
          newValue: { recommendations_created: created.length, recommendations_expired: expired, model: MODEL },
          correlationId: ctx.correlationId,
          ip: ctx.ip,
        });

        return {
          generatedAt: now.toISOString(),
          facility: { id: facility.id, name: facility.name },
          model: { name: MODEL_NAME, version: MODEL_VERSION, kind: 'RULE_BASED' as const },
          basedOnPredictions: predictions.length,
          donorActivationRecommendations: created,
          donorActivationRecommendationsExpired: expired,
          notRecommended: [...skipped].map(([reason, count]) => ({ reason, count })),
        };
      });
    },

    async list(auth: AuthContext, query: { facilityId?: string; status?: $Enums.donor_activation_status; page: number; pageSize: number }) {
      const facilityIds = await facilityScope(auth, DONOR_ACTIVATION_READ_ROLES, query.facilityId);
      const window = toPageWindow(query);
      const { total, rows } = await donorActivationRepository.listActivations(db.prisma, { facilityIds, status: query.status }, window.skip, window.take);
      return { data: await Promise.all(rows.map((row) => activationDto(row))), pagination: pageMeta(query, total) };
    },

    async get(auth: AuthContext, id: string) {
      const row = await donorActivationRepository.findActivation(db.prisma, id);
      if (!row) throw notFound();
      assertFacilityAccess(auth, row.facility_id, { roles: DONOR_ACTIVATION_READ_ROLES, hide: true });
      return activationDto(row);
    },

    /**
     * Creates the activation and its recipients from an approved/modified DONOR_ACTIVATION recommendation.
     * Called inside the recommendation-decision transaction (see IntelligenceService.decide). Donor identities are
     * chosen here, inside the transaction, and never appear in the recommendation itself or in the audit trail —
     * only counts and the radius do (proposal §11.2 / Phase 3 decision).
     */
    async activateFromRecommendation(
      tx: Tx,
      auth: AuthContext,
      ctx: CallContext,
      input: { recommendationId: string; predictionId: string | null; facilityId: string; bloodGroupId: number; componentId: number; unitsNeeded: number; radiusKm: number; targetDonorCount: number; urgency: $Enums.urgency_level },
    ) {
      const facility = await donorActivationRepository.facilityLocation(tx, input.facilityId);
      if (!facility || facility.latitude === null || facility.longitude === null) {
        throw new HttpError(422, 'The facility has no location on file', 'FACILITY_LOCATION_MISSING');
      }
      const parameterRows = await inventoryRepository.parameterRows(tx, [facility.organization_id]);
      const scope = { facilityId: input.facilityId, organizationId: facility.organization_id, bloodGroupId: input.bloodGroupId, componentId: input.componentId };
      const minIntervalDays = parseNonNegativeInteger(resolveParameter(parameterRows, PARAMETER_KEYS.donorMinIntervalDays, scope));
      if (!minIntervalDays.ok) throw new HttpError(422, 'donor.min_interval_days is not configured for this facility', 'PLANNING_PARAMETER_MISSING');

      const groupIds = await donorActivationRepository.compatibleDonorGroups(tx, input.bloodGroupId, input.componentId, options.allowDemoRules);
      const donors = await donorActivationRepository.eligibleDonors(tx, {
        bloodGroupIds: groupIds,
        facilityLat: facility.latitude,
        facilityLon: facility.longitude,
        radiusKm: input.radiusKm,
        minIntervalDays: minIntervalDays.value,
        excludeFacilityId: input.facilityId,
        excludeBloodGroupId: input.bloodGroupId,
        excludeComponentId: input.componentId,
        limit: MAX_CANDIDATES,
      });
      if (donors.length === 0) throw new HttpError(409, 'No eligible donors remain for this activation', 'NO_ELIGIBLE_DONORS');

      const targeted: EligibleDonor[] = donors.slice(0, Math.min(input.targetDonorCount, donors.length));
      const [groups, components] = await Promise.all([referenceRepository.bloodGroups(tx), referenceRepository.components(tx)]);
      const bloodGroup = groups.find((g) => g.id === input.bloodGroupId)?.code ?? '';
      const component = components.find((c) => c.id === input.componentId)?.code ?? '';

      const activation = await donorActivationRepository.createActivation(tx, {
        organizationId: facility.organization_id,
        facilityId: input.facilityId,
        predictionId: input.predictionId,
        recommendationId: input.recommendationId,
        bloodGroupId: input.bloodGroupId,
        componentId: input.componentId,
        unitsNeeded: input.unitsNeeded,
        targetDonorCount: targeted.length,
        urgency: input.urgency,
        radiusKm: input.radiusKm,
        donorMessage: donorMessageFor(input.unitsNeeded, bloodGroup, component),
        activatedBy: auth.userId,
        expiresAt: istStartOfDay(istDate(new Date(), 3)),
      });
      const created = await donorActivationRepository.createRecipients(tx, activation.id, targeted);

      // Counts and radius only — never which donors (proposal §11.2: "donor_activation.create … counts, radius — not donor lists").
      await audit.record(tx, {
        actorId: auth.userId,
        organizationId: facility.organization_id,
        facilityId: input.facilityId,
        action: 'donor_activation.create',
        entityType: 'donor_activation',
        entityId: activation.id,
        newValue: {
          blood_group_id: input.bloodGroupId, component_id: input.componentId, units_needed: input.unitsNeeded,
          radius_km: input.radiusKm, target_donor_count: targeted.length, recipients_created: created,
        },
        correlationId: ctx.correlationId,
        ip: ctx.ip,
      });
      return activation;
    },

    /** Sends the (in-app / Realtime) notification to every PENDING recipient. No external push integration yet. */
    async notify(auth: AuthContext, ctx: CallContext, id: string) {
      return db.withTransaction(async (tx) => {
        const row = await donorActivationRepository.findActivation(tx, id);
        if (!row) throw notFound();
        assertFacilityAccess(auth, row.facility_id, { roles: DONOR_ACTIVATION_READ_ROLES, hide: true });
        assertFacilityAccess(auth, row.facility_id, { roles: DONOR_ACTIVATION_MANAGE_ROLES });
        if (row.status !== 'ACTIVE') throw new HttpError(409, 'This activation is not active', 'ACTIVATION_NOT_ACTIVE');

        const pending = await donorActivationRepository.pendingRecipients(tx, id);
        if (pending.length === 0) return { notified: 0, delivered: 0, failed: 0 };
        const now = new Date();
        const outcomes = await notifications.send(row.donor_message, pending.map((p) => ({ recipientId: p.id, userId: p.donors.user_id })));
        await donorActivationRepository.markNotified(tx, outcomes, now);
        const delivered = outcomes.filter((o) => o.delivered).length;

        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: row.organization_id,
          facilityId: row.facility_id,
          action: 'donor_activation.notify',
          entityType: 'donor_activation',
          entityId: id,
          newValue: { attempted: outcomes.length, delivered, failed: outcomes.length - delivered, provider: notifications.provider },
          correlationId: ctx.correlationId,
          ip: ctx.ip,
        });
        return { notified: outcomes.length, delivered, failed: outcomes.length - delivered };
      });
    },

    async cancel(auth: AuthContext, ctx: CallContext, id: string) {
      return db.withTransaction(async (tx) => {
        const row = await donorActivationRepository.findActivation(tx, id);
        if (!row) throw notFound();
        assertFacilityAccess(auth, row.facility_id, { roles: DONOR_ACTIVATION_READ_ROLES, hide: true });
        assertFacilityAccess(auth, row.facility_id, { roles: DONOR_ACTIVATION_MANAGE_ROLES });
        if (row.status !== 'ACTIVE') throw new HttpError(409, 'This activation is not active', 'ACTIVATION_NOT_ACTIVE');
        await donorActivationRepository.setActivationStatus(tx, id, 'CANCELLED');
        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: row.organization_id,
          facilityId: row.facility_id,
          action: 'donor_activation.cancel',
          entityType: 'donor_activation',
          entityId: id,
          oldValue: { status: 'ACTIVE' },
          newValue: { status: 'CANCELLED' },
          correlationId: ctx.correlationId,
          ip: ctx.ip,
        });
        return activationDto({ ...row, status: 'CANCELLED' });
      });
    },

    // ---- Donor self-service --------------------------------------------------------------------------------
    async mine(auth: AuthContext) {
      const donor = await donorActivationRepository.findDonorByUserId(db.prisma, auth.userId);
      if (!donor) return [];
      const rows = await donorActivationRepository.mine(db.prisma, donor.id);
      return rows.map((row) => ({
        recipientId: row.id,
        distanceKm: Number(row.distance_km),
        notificationStatus: row.notification_status,
        response: row.response,
        respondedAt: row.responded_at?.toISOString() ?? null,
        activation: {
          id: row.donor_activations.id,
          status: row.donor_activations.status,
          urgency: row.donor_activations.urgency,
          bloodGroup: row.donor_activations.blood_groups.code,
          component: row.donor_activations.components.code,
          donorMessage: row.donor_activations.donor_message,
          expiresAt: row.donor_activations.expires_at.toISOString(),
        },
      }));
    },

    /** The donor's own decision — WILLING or DECLINED — recorded exactly once. */
    async respond(auth: AuthContext, ctx: CallContext, recipientId: string, response: 'WILLING' | 'DECLINED') {
      return db.withTransaction(async (tx) => {
        const donor = await donorActivationRepository.findDonorByUserId(tx, auth.userId);
        if (!donor) throw notFound();
        const row = await donorActivationRepository.lockRecipientForDonor(tx, recipientId, donor.id);
        if (!row) throw notFound();
        if (row.response !== 'NO_RESPONSE') throw new HttpError(409, 'A response has already been recorded', 'RESPONSE_ALREADY_RECORDED');
        if (row.donor_activations.status !== 'ACTIVE') throw new HttpError(409, 'This activation is no longer active', 'ACTIVATION_NOT_ACTIVE');
        const now = new Date();
        const updated = await donorActivationRepository.respond(tx, recipientId, response, now);
        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: row.donor_activations.organization_id,
          facilityId: row.donor_activations.facility_id,
          action: 'donor_activation.recipient_respond',
          entityType: 'donor_activation_recipient',
          entityId: recipientId,
          oldValue: { response: 'NO_RESPONSE' },
          newValue: { response },
          correlationId: ctx.correlationId,
          ip: ctx.ip,
        });
        return { recipientId: updated.id, response: updated.response, respondedAt: updated.responded_at!.toISOString() };
      });
    },
  };
}

export type DonorActivationService = ReturnType<typeof createDonorActivationService>;
