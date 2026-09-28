import { randomUUID } from 'node:crypto';
import type { AuditService } from '../audit/auditService.js';
import type { AuthContext } from '../auth/types.js';
import { assertFacilityAccess } from '../authz/permissions.js';
import type { Database } from '../db/client.js';
import {
  haversineKm, planRedistribution, shareableUnits, type DestinationSeries, type RedistributionSkip, type SourceCandidate,
} from '../intelligence/redistribution.js';
import { istDate, istStartOfDay, MODEL_NAME, MODEL_VERSION } from '../intelligence/planning.js';
import {
  PARAMETER_KEYS, parsePositiveNumber, parseReserveFloorDays, parseTargetDays, parseUnits, resolveParameter, type ParameterRow,
} from '../inventory/parameters.js';
import { inventoryRepository } from '../repositories/inventoryRepository.js';
import { intelligenceRepository } from '../repositories/intelligenceRepository.js';
import { redistributionRepository } from '../repositories/redistributionRepository.js';
import { referenceRepository } from '../repositories/referenceRepository.js';
import { HttpError } from '../utils/httpError.js';
import { INTELLIGENCE_RUN_ROLES, type CallContext } from './intelligenceService.js';

export const REDISTRIBUTION_MODEL = `${MODEL_NAME}@${MODEL_VERSION}`;

const num = (value: { toString(): string } | null) => (value === null ? null : Number(value.toString()));

export function createRedistributionService(db: Database, audit: AuditService) {
  return {
    /**
     * Recommends, per blood group and component in shortage at this facility, one source facility and a
     * quantity. Uses the destination's current SHORTAGE predictions (run the intelligence run first).
     * Only shared outputs about a source are stored: can-fulfil, spare units and ETA. Nothing is approved.
     */
    async run(auth: AuthContext, ctx: CallContext, facilityId: string) {
      assertFacilityAccess(auth, facilityId, { roles: INTELLIGENCE_RUN_ROLES, hide: true });

      return db.withTransaction(async (tx) => {
        await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`redistribution-run:${facilityId}`}, 0))`;
        const [destination] = await inventoryRepository.holdingFacilities(tx, [facilityId]);
        if (!destination) throw new HttpError(422, 'This facility does not hold inventory', 'FACILITY_HOLDS_NO_INVENTORY');
        const destinationRow = (await tx.facilities.findUnique({ where: { id: facilityId }, select: { latitude: true, longitude: true } }))!;

        const now = await intelligenceRepository.databaseNow(tx);
        const runId = randomUUID();
        const [groups, components, predictions, candidates] = await Promise.all([
          referenceRepository.bloodGroups(tx),
          referenceRepository.components(tx),
          redistributionRepository.currentShortagePredictions(tx, facilityId),
          redistributionRepository.candidateFacilities(tx, facilityId),
        ]);
        const groupCode = new Map(groups.map((g) => [g.id, g.code]));
        const componentCode = new Map(components.map((c) => [c.id, c.code]));
        const parameterRows: ParameterRow[] = await inventoryRepository.parameterRows(tx, [
          destination.organizationId,
          ...new Set(candidates.map((c) => c.organizationId)),
        ]);

        // Destination-side series that are short and fully described by their prediction.
        const skipped = new Map<RedistributionSkip | 'PREDICTION_INCOMPLETE', number>();
        const bump = (reason: RedistributionSkip | 'PREDICTION_INCOMPLETE') => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
        const series: (DestinationSeries & { periodEnd: string })[] = [];
        for (const p of predictions) {
          const demand = num(p.predicted_daily_demand);
          const cover = num(p.days_of_cover);
          if (demand === null || demand <= 0 || cover === null || p.shortage_risk === null || p.usable_units === null || p.incoming_units === null) {
            bump('PREDICTION_INCOMPLETE');
            continue;
          }
          const scope = { facilityId, organizationId: destination.organizationId, bloodGroupId: p.blood_group_id, componentId: p.component_id };
          const at = (key: string) => resolveParameter(parameterRows, key, scope);
          series.push({
            predictionId: p.id,
            bloodGroupId: p.blood_group_id,
            componentId: p.component_id,
            dailyDemand: demand,
            projectedSupply: p.usable_units + p.incoming_units,
            daysOfCover: cover,
            risk: p.shortage_risk,
            targetDays: parseTargetDays(at(PARAMETER_KEYS.targetDays)),
            minUnits: parseUnits(at(PARAMETER_KEYS.transferMinUnits)),
            maxUnits: parseUnits(at(PARAMETER_KEYS.transferMaxUnits)),
            periodEnd: p.period_end.toISOString().slice(0, 10),
          });
        }

        const figures = await redistributionRepository.sourceFigures(
          tx,
          series.flatMap((s) => candidates.map((c) => ({ facilityId: c.id, bloodGroupId: s.bloodGroupId, componentId: s.componentId }))),
        );
        const figureOf = new Map(figures.map((f) => [`${f.facilityId}|${f.bloodGroupId}|${f.componentId}`, f]));

        const expired = await redistributionRepository.expirePendingRedistribution(tx, facilityId);
        const created: { id: string; bloodGroup: string; component: string; quantity: number; priority: string; source: { id: string; name: string } }[] = [];

        for (const s of series) {
          const destScope = { facilityId, organizationId: destination.organizationId, bloodGroupId: s.bloodGroupId, componentId: s.componentId };
          const eta = {
            roadFactor: parsePositiveNumber(resolveParameter(parameterRows, PARAMETER_KEYS.etaRoadFactor, destScope)),
            speedKmh: parsePositiveNumber(resolveParameter(parameterRows, PARAMETER_KEYS.etaSpeedKmh, destScope)),
          };
          const sources: SourceCandidate[] = candidates.map((c) => {
            const figure = figureOf.get(`${c.id}|${s.bloodGroupId}|${s.componentId}`);
            const scope = { facilityId: c.id, organizationId: c.organizationId, bloodGroupId: s.bloodGroupId, componentId: s.componentId };
            return {
              facilityId: c.id,
              name: c.name,
              spare: figure
                ? shareableUnits({
                    usable: figure.usable,
                    pending: figure.pending,
                    demand: figure.demand,
                    reserveFloorDays: parseReserveFloorDays(resolveParameter(parameterRows, PARAMETER_KEYS.reserveFloorDays, scope)),
                  })
                : null,
              sourcePredictionId: figure?.sourcePredictionId ?? null,
              distanceKm: haversineKm(destinationRow.latitude, destinationRow.longitude, c.latitude, c.longitude),
            };
          });

          const plan = planRedistribution(s, sources, eta);
          if (plan.status === 'SKIPPED') {
            bump(plan.reason);
            continue;
          }
          const label = `${groupCode.get(s.bloodGroupId)} ${componentCode.get(s.componentId)}`;
          const parametersUsed = {
            'coverage.target_days': plan.targetDays,
            'transfer.min_units': plan.minUnits,
            'transfer.max_units': plan.maxUnits,
            ...(eta.roadFactor.ok && eta.speedKmh.ok ? { 'eta.road_factor': eta.roadFactor.value, 'eta.urban_speed_kmh': eta.speedKmh.value } : {}),
          };
          const id = await redistributionRepository.createRecommendation(tx, {
            organizationId: destination.organizationId,
            facilityId,
            relatedPredictionId: s.predictionId,
            priority: s.risk,
            // §7.3: destination-side terms and the source's shared outputs only. No source demand, reserve floor,
            // exact cover or expiry dates.
            payload: {
              source_facility_id: plan.source.facilityId,
              destination_facility_id: facilityId,
              blood_group_id: s.bloodGroupId,
              component_id: s.componentId,
              quantity: plan.quantity,
              destination_cover_before_days: plan.coverBefore,
              destination_cover_after_days: plan.coverAfter,
              destination_prediction_id: s.predictionId,
              source_prediction_id: plan.source.sourcePredictionId,
              source_can_fulfil: plan.sourceCanFulfil,
              source_spare_units: plan.source.spare,
              near_expiry_opportunity: null,
              eta_minutes: plan.etaMinutes,
              parameters_used: parametersUsed,
            },
            whatExplanation: `Transfer ${plan.quantity} unit(s) of ${label} from ${plan.source.name} to ${destination.name}.`,
            whyExplanation:
              `${destination.name} has ${plan.coverBefore} day(s) of cover against a target of ${plan.targetDays}. ` +
              `${plan.source.name} can spare ${plan.source.spare} unit(s) above its own reserve.`,
            dataExplanation: {
              method: 'rule-based baseline; not AI',
              destination: {
                usable_and_incoming_units: s.projectedSupply,
                daily_demand: s.dailyDemand,
                days_of_cover_before: plan.coverBefore,
                days_of_cover_after: plan.coverAfter,
                target_days: plan.targetDays,
                deficit: plan.deficit,
              },
              shared_source_outputs: { source_can_fulfil: plan.sourceCanFulfil, source_spare_units: plan.source.spare, eta_minutes: plan.etaMinutes },
              quantity_rule: 'min(deficit, source spare units, transfer.max_units); at least transfer.min_units',
              source_selection: 'largest transferable quantity, then shortest ETA, then name',
              parameters_used: parametersUsed,
              model: { name: MODEL_NAME, version: MODEL_VERSION },
            },
            actionExplanation:
              'A blood-bank administrator reviews this and approves, lowers or rejects it. Approval proposes a transfer; the source facility must still approve it before any unit is reserved.',
            modelVersion: REDISTRIBUTION_MODEL,
            dedupeKey: `redistribution:${facilityId}:${s.bloodGroupId}:${s.componentId}`,
            validUntil: istStartOfDay(istDate(new Date(`${s.periodEnd}T00:00:00Z`), 1)),
          });
          created.push({
            id,
            bloodGroup: groupCode.get(s.bloodGroupId) ?? '',
            component: componentCode.get(s.componentId) ?? '',
            quantity: plan.quantity,
            priority: s.risk,
            source: { id: plan.source.facilityId, name: plan.source.name },
          });
        }

        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: destination.organizationId,
          facilityId,
          action: 'redistribution.generate',
          entityType: 'recommendation_run',
          entityId: runId,
          newValue: { recommendations_created: created.length, recommendations_expired: expired, model: REDISTRIBUTION_MODEL },
          correlationId: ctx.correlationId,
          ip: ctx.ip,
        });

        return {
          runId,
          generatedAt: now.toISOString(),
          facility: { id: destination.id, name: destination.name },
          model: { name: MODEL_NAME, version: MODEL_VERSION, kind: 'RULE_BASED' as const },
          basedOnPredictions: predictions.length,
          redistributionRecommendations: created,
          redistributionRecommendationsExpired: expired,
          notRecommended: [...skipped].map(([reason, count]) => ({ reason, count })),
        };
      });
    },
  };
}

export type RedistributionService = ReturnType<typeof createRedistributionService>;
