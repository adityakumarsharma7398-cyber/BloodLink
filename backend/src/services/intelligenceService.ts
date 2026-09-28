import { randomUUID } from 'node:crypto';
import type { AuditService } from '../audit/auditService.js';
import type { AppRole, AuthContext } from '../auth/types.js';
import { assertFacilityAccess, hasAnyRole } from '../authz/permissions.js';
import type { Database } from '../db/client.js';
import type { $Enums } from '../generated/prisma/client.js';
import { pageMeta, toPageWindow } from '../http/schemas.js';
import { istDate, istStartOfDay, MODEL_NAME, MODEL_VERSION, planSeries, type ForecastOverride, type SkipReason } from '../intelligence/planning.js';
import {
  PARAMETER_KEYS, parseHistoryDays, parseHorizonDays, parseRiskBands, parseTargetDays, parseWarningDays, resolveParameter,
} from '../inventory/parameters.js';
import { inventoryRepository } from '../repositories/inventoryRepository.js';
import { intelligenceRepository, type PredictionInsert } from '../repositories/intelligenceRepository.js';
import { referenceRepository } from '../repositories/referenceRepository.js';
import { HttpError, notFound } from '../utils/httpError.js';
import { INVENTORY_READ_ROLES } from './inventoryService.js';
import type { TransferService } from './transferService.js';
import type { DonorActivationService } from './donorActivationService.js';
import { redistributionRepository } from '../repositories/redistributionRepository.js';
import { redistributionPayloadSchema, donorActivationPayloadSchema } from '../intelligence/payloads.js';
import type { AiServiceClient } from './ai/aiServiceClient.js';
import { forecastDemand } from './ai/demandForecastClient.js';

/** Read: same people who read the facility's stock. Run: those who manage stock. Decide: the approved procurement deciders (§9.2). */
export const INTELLIGENCE_READ_ROLES: readonly AppRole[] = INVENTORY_READ_ROLES;
export const INTELLIGENCE_RUN_ROLES: readonly AppRole[] = ['ORG_ADMIN', 'BLOOD_BANK_ADMIN', 'INVENTORY_MANAGER'];
export const INTELLIGENCE_DECIDE_ROLES: readonly AppRole[] = ['ORG_ADMIN', 'BLOOD_BANK_ADMIN'];

export interface CallContext {
  readonly correlationId: string;
  readonly ip: string | null;
}

export type Decision = 'APPROVE' | 'MODIFY' | 'REJECT';
const RISK_TO_URGENCY = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'NORMAL', LOW: 'NORMAL' } as const;
const DECISION_STATUS = { APPROVE: 'APPROVED', MODIFY: 'MODIFIED', REJECT: 'REJECTED' } as const;
const DECISION_ACTION = { APPROVE: 'recommendation.approve', MODIFY: 'recommendation.modify', REJECT: 'recommendation.reject' } as const;

const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()));
const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

const readableFacilityIds = (auth: AuthContext) =>
  auth.facilities.filter((facility) => hasAnyRole(auth, INTELLIGENCE_READ_ROLES, { facilityId: facility.id })).map((facility) => facility.id);

export function createIntelligenceService(
  db: Database,
  audit: AuditService,
  transfers: TransferService,
  donorActivation: DonorActivationService,
  aiClient: AiServiceClient,
) {
  async function scopedFacilityIds(auth: AuthContext, facilityId?: string): Promise<string[]> {
    if (facilityId) {
      assertFacilityAccess(auth, facilityId, { roles: INTELLIGENCE_READ_ROLES, hide: true });
      return [facilityId];
    }
    return readableFacilityIds(auth);
  }

  const recommendationDto = (row: NonNullable<Awaited<ReturnType<typeof intelligenceRepository.lockRecommendation>>>) => ({
    id: row.id,
    type: row.recommendation_type,
    facilityId: row.facility_id,
    relatedPredictionId: row.related_prediction_id,
    status: row.status,
    priority: row.priority,
    payload: row.payload,
    modifiedPayload: row.modified_payload,
    explanation: {
      what: row.what_explanation,
      why: row.why_explanation,
      data: row.data_explanation,
      action: row.action_explanation,
    },
    source: row.source,
    modelVersion: row.model_version,
    validUntil: row.valid_until.toISOString(),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionNote: row.decision_note,
    createdAt: row.created_at.toISOString(),
  });

  return {
    /**
     * Recomputes demand, cover and procurement recommendations for one facility, in one transaction:
     * previous "current" predictions are superseded, previous PENDING procurement recommendations expire,
     * new rows are written and the run is audited. Nothing is approved or executed automatically.
     */
    async run(auth: AuthContext, ctx: CallContext, facilityId: string) {
      assertFacilityAccess(auth, facilityId, { roles: INTELLIGENCE_RUN_ROLES, hide: true });

      return db.withTransaction(async (tx) => {
        await intelligenceRepository.lockFacilityRun(tx, facilityId);
        const [facility] = await inventoryRepository.holdingFacilities(tx, [facilityId]);
        if (!facility) throw new HttpError(422, 'This facility does not hold inventory', 'FACILITY_HOLDS_NO_INVENTORY');

        const now = await intelligenceRepository.databaseNow(tx);
        const today = istDate(now);
        const runId = randomUUID();
        const [groups, components, parameterRows, incoming] = await Promise.all([
          referenceRepository.bloodGroups(tx),
          referenceRepository.components(tx),
          inventoryRepository.parameterRows(tx, [facility.organizationId]),
          intelligenceRepository.incomingInTransit(tx, facilityId),
        ]);
        const inTransitTo = new Map(incoming.map((row) => [`${row.bloodGroupId}|${row.componentId}`, row.units]));

        const series = groups
          .filter((group) => group.is_known)
          .flatMap((group) =>
            components
              .filter((component) => component.active)
              .map((component) => {
                const scope = { facilityId, organizationId: facility.organizationId, bloodGroupId: group.id, componentId: component.id };
                const at = (key: string) => resolveParameter(parameterRows, key, scope);
                return {
                  group,
                  component,
                  warning: parseWarningDays(at(PARAMETER_KEYS.expiryWarningDays)),
                  history: parseHistoryDays(at(PARAMETER_KEYS.historyDays)),
                  horizon: parseHorizonDays(at(PARAMETER_KEYS.horizonDays)),
                  target: parseTargetDays(at(PARAMETER_KEYS.targetDays)),
                  bands: parseRiskBands(at(PARAMETER_KEYS.riskBands)),
                };
              }),
          );

        const counts = await inventoryRepository.seriesCounts(
          tx,
          series.map((s) => ({
            facilityId,
            bloodGroupId: s.group.id,
            componentId: s.component.id,
            warningDays: s.warning.ok ? s.warning.value : 0,
            historyDays: s.history.ok ? s.history.value : 0,
          })),
        );
        const countOf = new Map(counts.map((c) => [`${c.bloodGroupId}|${c.componentId}`, c]));

        const predictions: PredictionInsert[] = [];
        const pending: { prediction: string; series: (typeof series)[number]; plan: Extract<ReturnType<typeof planSeries>, { status: 'PLANNED' }> & { procurement: NonNullable<Extract<ReturnType<typeof planSeries>, { status: 'PLANNED' }>['procurement']> }; periodEnd: string; horizonDays: number; usable: number; incoming: number; issued: number }[] = [];
        const skipped = new Map<SkipReason, number>();
        const notRecommended = new Map<string, number>();
        const demandForecastMethods = { AI_SERVICE: 0, BASELINE: 0 };

        for (const s of series) {
          const key = `${s.group.id}|${s.component.id}`;
          const c = countOf.get(key)!;
          const incomingUnits = c.pendingAcceptance + (inTransitTo.get(key) ?? 0);

          // Ask the AI service for a demand forecast built from this series' own ledger history. Any
          // failure (unreachable, an error response, a malformed body) leaves `forecast` undefined,
          // and planSeries falls back to the trailing-average baseline unchanged.
          let forecast: ForecastOverride | undefined;
          let history: Awaited<ReturnType<typeof intelligenceRepository.dailyConsumption>> = [];
          if (s.history.ok && s.horizon.ok) {
            history = await intelligenceRepository.dailyConsumption(tx, facilityId, s.group.id, s.component.id, s.history.value);
            const result = await forecastDemand(aiClient, {
              facilityId,
              bloodGroupCode: s.group.code,
              componentCode: s.component.code,
              horizonDays: s.horizon.value,
              history,
            });
            if (result) forecast = { dailyDemand: result.dailyDemand, modelName: result.modelName, modelVersion: result.modelVersion, confidenceScore: result.confidenceScore, confidenceMethod: result.confidenceMethod, historyDaysUsed: result.historyDaysUsed };
          }

          const plan = planSeries({
            usable: c.available,
            reserved: c.reserved,
            incoming: incomingUnits,
            expiring: s.warning.ok ? c.expiring : null,
            issuedInWindow: c.issuedInWindow,
            historyDays: s.history,
            horizonDays: s.horizon,
            targetDays: s.target,
            bands: s.bands,
            forecast: forecast ?? undefined,
          });
          if (plan.status === 'SKIPPED') {
            skipped.set(plan.reason, (skipped.get(plan.reason) ?? 0) + 1);
            continue;
          }
          if (plan.procurementSkipped) notRecommended.set(plan.procurementSkipped, (notRecommended.get(plan.procurementSkipped) ?? 0) + 1);
          demandForecastMethods[plan.demand.method] += 1;

          const horizonDays = plan.demand.horizonDays;
          const periodEnd = istDate(now, horizonDays - 1);
          const parameters = {
            'forecast.history_days': plan.demand.historyDays,
            'forecast.horizon_days': horizonDays,
            'coverage.target_days': s.target.ok ? s.target.value : null,
            'coverage.risk_bands': s.bands.ok ? { ...s.bands.value } : null,
            'expiry.warning_days': s.warning.ok ? s.warning.value : null,
          };
          const explanation = {
            method:
              plan.demand.method === 'AI_SERVICE'
                ? `AI service demand forecast (${plan.demand.modelName}@${plan.demand.modelVersion}), from this series' own ledger history`
                : 'trailing average of units issued (ledger INVENTORY_ISSUED); not a machine-learning model',
            inputs: {
              issued_in_window: plan.demand.issuedInWindow,
              history_days_sent: history.length,
              usable_units: c.available,
              reserved_units: c.reserved,
              incoming_units: incomingUnits,
              incoming_breakdown: { pending_acceptance: c.pendingAcceptance, in_transit_to_facility: inTransitTo.get(key) ?? 0 },
            },
            parameters_used: parameters,
            model: { name: plan.demand.modelName, version: plan.demand.modelVersion },
            ...(plan.demand.confidenceScore !== null
              ? { confidence: { score: plan.demand.confidenceScore, method: plan.demand.confidenceMethod } }
              : {}),
            assumptions: [
              'pending_request_units is not subtracted: reserved units are already excluded from usable units',
              'redistribution and donor activation are not considered',
              ...(plan.demand.method === 'BASELINE' ? ['the AI service was unreachable or unavailable; the trailing-average baseline was used instead'] : []),
            ],
          };
          const common = {
            runId,
            organizationId: facility.organizationId,
            facilityId,
            bloodGroupId: s.group.id,
            componentId: s.component.id,
            horizonDays,
            periodStart: today,
            periodEnd,
            usableUnits: c.available,
            reservedUnits: c.reserved,
            incomingUnits,
            expiringUnits: s.warning.ok ? c.expiring : null,
          };
          predictions.push({
            ...common,
            id: randomUUID(),
            predictionType: 'DEMAND',
            predictedDailyDemand: plan.demand.dailyDemand,
            predictedQuantity: plan.demand.predictedQuantity,
            daysOfCover: null,
            predictedShortageDate: null,
            shortageRisk: null,
            modelName: plan.demand.modelName,
            modelVersion: plan.demand.modelVersion,
            confidenceScore: plan.demand.confidenceScore,
            confidenceMethod: plan.demand.confidenceMethod,
            explanation: {
              ...explanation,
              formula:
                plan.demand.method === 'AI_SERVICE'
                  ? 'daily_demand = AI service forecast; quantity = daily_demand × horizon_days'
                  : 'daily_demand = issued_in_window / history_days; quantity = daily_demand × horizon_days',
            },
          });
          if (plan.cover) {
            const shortageId = randomUUID();
            predictions.push({
              ...common,
              id: shortageId,
              predictionType: 'SHORTAGE',
              predictedDailyDemand: plan.demand.dailyDemand,
              predictedQuantity: plan.demand.predictedQuantity,
              daysOfCover: plan.cover.storableDaysOfCover,
              predictedShortageDate: plan.cover.shortageInDays === null ? null : istDate(now, plan.cover.shortageInDays),
              shortageRisk: plan.cover.risk,
              modelName: plan.demand.modelName,
              modelVersion: plan.demand.modelVersion,
              confidenceScore: plan.demand.confidenceScore,
              confidenceMethod: plan.demand.confidenceMethod,
              explanation: {
                ...explanation,
                formula: 'days_of_cover = (usable + incoming) / daily_demand',
                projected_supply: plan.cover.projectedSupply,
                ...(plan.cover.storableDaysOfCover === null ? { days_of_cover_note: 'above the storable maximum; left empty' } : {}),
              },
            });
            if (plan.procurement) {
              pending.push({ prediction: shortageId, series: s, plan: plan as never, periodEnd, horizonDays, usable: c.available, incoming: incomingUnits, issued: c.issuedInWindow });
            }
          }
        }

        await intelligenceRepository.supersedeCurrentPredictions(tx, facilityId, now);
        const expired = await intelligenceRepository.expirePendingProcurement(tx, facilityId);
        await intelligenceRepository.createPredictions(tx, predictions, now);

        const created: { id: string; bloodGroup: string; component: string; quantity: number; priority: $Enums.risk_level }[] = [];
        for (const item of pending) {
          const { procurement, demand, cover } = item.plan;
          const label = `${item.series.group.code} ${item.series.component.code}`;
          const id = await intelligenceRepository.createRecommendation(tx, {
            organizationId: facility.organizationId,
            facilityId,
            relatedPredictionId: item.prediction,
            priority: procurement.priority,
            payload: {
              facility_id: facilityId,
              blood_group_id: item.series.group.id,
              component_id: item.series.component.id,
              quantity: procurement.quantity,
              target_cover_days: procurement.targetDays,
            },
            whatExplanation: `Procure ${procurement.quantity} unit(s) of ${label} for ${facility.name}.`,
            whyExplanation:
              `Projected supply of ${cover!.projectedSupply} unit(s) covers ${cover!.daysOfCover} day(s) at the recent average demand of ` +
              `${demand.dailyDemand} unit(s)/day, below the target of ${procurement.targetDays} day(s).`,
            dataExplanation: {
              method: 'rule-based baseline (trailing average); not AI',
              usable_units: item.usable,
              incoming_units: item.incoming,
              issued_in_window: item.issued,
              history_days: demand.historyDays,
              daily_demand: demand.dailyDemand,
              days_of_cover: cover!.daysOfCover,
              target_cover_days: procurement.targetDays,
              target_stock: procurement.targetStock,
              deficit: procurement.deficit,
              redistribution_considered: false,
              model: { name: MODEL_NAME, version: MODEL_VERSION },
              demand_model: { name: demand.modelName, version: demand.modelVersion },
            },
            actionExplanation: 'A blood-bank administrator reviews this and approves, modifies or rejects it. Approval records the decision only; no order is placed by BloodLink.',
            modelVersion: `${MODEL_NAME}@${MODEL_VERSION}`,
            dedupeKey: `procurement:${facilityId}:${item.series.group.id}:${item.series.component.id}`,
            validUntil: istStartOfDay(istDate(new Date(`${item.periodEnd}T00:00:00Z`), 1)),
          });
          created.push({ id, bloodGroup: item.series.group.code, component: item.series.component.code, quantity: procurement.quantity, priority: procurement.priority });
        }

        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: facility.organizationId,
          facilityId,
          action: 'prediction.generate',
          entityType: 'prediction_run',
          entityId: runId,
          newValue: {
            predictions: predictions.length,
            procurement_recommendations_created: created.length,
            procurement_recommendations_expired: expired,
            model: `${MODEL_NAME}@${MODEL_VERSION}`,
          },
          correlationId: ctx.correlationId,
          ip: ctx.ip,
        });

        return {
          runId,
          generatedAt: now.toISOString(),
          facility: { id: facility.id, name: facility.name },
          model: { name: MODEL_NAME, version: MODEL_VERSION, kind: 'RULE_BASED' as const },
          predictionsWritten: predictions.length,
          demandForecastMethods,
          procurementRecommendations: created,
          procurementRecommendationsExpired: expired,
          seriesSkipped: [...skipped].map(([reason, count]) => ({ reason, count })),
          procurementNotRecommended: [...notRecommended].map(([reason, count]) => ({ reason, count })),
        };
      });
    },

    async listPredictions(
      auth: AuthContext,
      query: { facilityId?: string; predictionType?: 'DEMAND' | 'SHORTAGE'; currentOnly: boolean; bloodGroupId?: number; componentId?: number; page: number; pageSize: number },
    ) {
      const facilityIds = await scopedFacilityIds(auth, query.facilityId);
      const window = toPageWindow(query);
      const { total, rows } = await intelligenceRepository.predictions(
        db.prisma,
        { facilityIds, predictionType: query.predictionType, currentOnly: query.currentOnly, bloodGroupId: query.bloodGroupId, componentId: query.componentId },
        window.skip,
        window.take,
      );
      const data = rows.map((row) => ({
        id: row.id,
        runId: row.run_id,
        facilityId: row.facility_id,
        bloodGroup: row.blood_groups.code,
        component: row.components.code,
        type: row.prediction_type,
        horizonDays: row.horizon_days,
        periodStart: day(row.period_start),
        periodEnd: day(row.period_end),
        predictedDailyDemand: num(row.predicted_daily_demand),
        predictedQuantity: num(row.predicted_quantity),
        usableUnits: row.usable_units,
        reservedUnits: row.reserved_units,
        pendingRequestUnits: row.pending_request_units,
        incomingUnits: row.incoming_units,
        expiringUnits: row.expiring_units,
        daysOfCover: num(row.days_of_cover),
        predictedShortageDate: day(row.predicted_shortage_date),
        shortageRisk: row.shortage_risk,
        confidenceScore: num(row.confidence_score),
        confidenceMethod: row.confidence_method,
        explanation: row.explanation,
        model: { name: row.model_name, version: row.model_version },
        generatedAt: row.generated_at.toISOString(),
        supersededAt: row.superseded_at?.toISOString() ?? null,
      }));
      return { data, pagination: pageMeta(query, total) };
    },

    async listRecommendations(
      auth: AuthContext,
      query: { facilityId?: string; status?: $Enums.recommendation_status; type?: 'PROCUREMENT' | 'REDISTRIBUTION' | 'DONOR_ACTIVATION'; page: number; pageSize: number },
    ) {
      const facilityIds = await scopedFacilityIds(auth, query.facilityId);
      const window = toPageWindow(query);
      const { total, rows } = await intelligenceRepository.recommendations(
        db.prisma,
        { facilityIds, status: query.status, recommendationType: query.type },
        window.skip,
        window.take,
      );
      return { data: rows.map(recommendationDto), pagination: pageMeta(query, total) };
    },

    /**
     * Human decision on a recommendation. PROCUREMENT: records the decision only, nothing is ordered.
     * REDISTRIBUTION: approving or lowering it proposes a transfer (PROPOSED); the source must still approve it.
     */
    async decide(auth: AuthContext, ctx: CallContext, id: string, input: { decision: Decision; modifiedQuantity?: number; note?: string }) {
      return db.withTransaction(async (tx) => {
        const row = await intelligenceRepository.lockRecommendation(tx, id);
        if (!row || !row.facility_id) throw notFound();
        // Not readable → 404 (existence hidden). Readable but not a decider → 403.
        assertFacilityAccess(auth, row.facility_id, { roles: INTELLIGENCE_READ_ROLES, hide: true });
        assertFacilityAccess(auth, row.facility_id, { roles: INTELLIGENCE_DECIDE_ROLES });

        if (row.recommendation_type !== 'PROCUREMENT' && row.recommendation_type !== 'REDISTRIBUTION' && row.recommendation_type !== 'DONOR_ACTIVATION') {
          throw new HttpError(422, 'This recommendation type cannot be decided here', 'UNSUPPORTED_RECOMMENDATION_TYPE');
        }
        if (row.status !== 'PENDING') throw new HttpError(409, 'This recommendation has already been decided or has expired', 'RECOMMENDATION_NOT_PENDING');
        const now = await intelligenceRepository.databaseNow(tx);
        if (row.valid_until <= now) throw new HttpError(409, 'This recommendation is no longer valid', 'RECOMMENDATION_EXPIRED');

        const payload = row.payload as Record<string, unknown>;
        const status = DECISION_STATUS[input.decision];
        const quantity = typeof payload.quantity === 'number' ? payload.quantity : null;
        // A redistribution or donor-activation quantity may be lowered, never raised above the recommendation
        // (what the source can spare, or how many eligible donors exist).
        const capped = row.recommendation_type === 'REDISTRIBUTION' || row.recommendation_type === 'DONOR_ACTIVATION';
        if (capped && input.decision === 'MODIFY' && (quantity === null || (input.modifiedQuantity as number) > quantity)) {
          throw new HttpError(422, 'The quantity cannot be raised above the recommendation', 'QUANTITY_ABOVE_RECOMMENDATION');
        }
        const modifiedPayload = input.decision === 'MODIFY' ? { ...payload, quantity: input.modifiedQuantity } : undefined;
        let transferId: string | null = null;
        let donorActivationId: string | null = null;
        if (row.recommendation_type === 'REDISTRIBUTION' && input.decision !== 'REJECT') {
          const plan = redistributionPayloadSchema.parse(row.payload);
          if (!(await redistributionRepository.isEligibleSource(tx, plan.source_facility_id))) {
            throw new HttpError(409, 'The source facility is no longer available for redistribution', 'SOURCE_NO_LONGER_AVAILABLE');
          }
          const transfer = await transfers.proposeFromRecommendation(tx, auth, ctx, {
            recommendationId: id,
            sourceFacilityId: plan.source_facility_id,
            destinationFacilityId: plan.destination_facility_id,
            bloodGroupId: plan.blood_group_id,
            componentId: plan.component_id,
            quantity: input.decision === 'MODIFY' ? (input.modifiedQuantity as number) : plan.quantity,
            etaMinutes: plan.eta_minutes,
          });
          transferId = transfer.id;
        }
        if (row.recommendation_type === 'DONOR_ACTIVATION' && input.decision !== 'REJECT') {
          const plan = donorActivationPayloadSchema.parse(row.payload);
          const activation = await donorActivation.activateFromRecommendation(tx, auth, ctx, {
            recommendationId: id,
            predictionId: row.related_prediction_id,
            facilityId: plan.facility_id,
            bloodGroupId: plan.blood_group_id,
            componentId: plan.component_id,
            unitsNeeded: plan.units_needed,
            radiusKm: plan.radius_km,
            targetDonorCount: input.decision === 'MODIFY' ? (input.modifiedQuantity as number) : plan.quantity,
            // donor_activations.urgency (CRITICAL/HIGH/NORMAL) is coarser than a recommendation's risk_level (…/MEDIUM/LOW).
            urgency: RISK_TO_URGENCY[row.priority],
          });
          donorActivationId = activation.id;
        }
        const updated = await intelligenceRepository.decideRecommendation(tx, id, {
          status,
          decidedBy: auth.userId,
          decisionNote: input.note ?? null,
          modifiedPayload,
        });

        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: row.organization_id,
          facilityId: row.facility_id,
          action: DECISION_ACTION[input.decision],
          entityType: 'recommendation',
          entityId: id,
          oldValue: { status: 'PENDING', quantity: payload.quantity ?? null },
          newValue: {
            status,
            quantity: modifiedPayload ? (input.modifiedQuantity ?? null) : (payload.quantity ?? null),
            ...(transferId ? { transfer_id: transferId } : {}),
            ...(donorActivationId ? { donor_activation_id: donorActivationId } : {}),
          },
          correlationId: ctx.correlationId,
          ip: ctx.ip,
        });
        return { ...recommendationDto(updated), transferId, donorActivationId };
      });
    },
  };
}

export type IntelligenceService = ReturnType<typeof createIntelligenceService>;
