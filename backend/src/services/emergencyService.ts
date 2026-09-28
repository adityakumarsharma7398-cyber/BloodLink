import type { AuditService } from '../audit/auditService.js';
import type { AppRole, AuthContext } from '../auth/types.js';
import { assertFacilityAccess, hasAnyRole } from '../authz/permissions.js';
import type { Database } from '../db/client.js';
import { callPrivate } from '../db/privateFunctions.js';
import type { $Enums } from '../generated/prisma/client.js';
import { PRIORITY_BY_URGENCY, rankSources, type RankedSource, type SourceOption } from '../emergency/ranking.js';
import { pageMeta, toPageWindow } from '../http/schemas.js';
import { haversineKm } from '../intelligence/redistribution.js';
import { MODEL_NAME, MODEL_VERSION } from '../intelligence/planning.js';
import { PARAMETER_KEYS, parsePositiveNumber, resolveParameter } from '../inventory/parameters.js';
import { emergencyRepository } from '../repositories/emergencyRepository.js';
import { intelligenceRepository } from '../repositories/intelligenceRepository.js';
import { inventoryRepository } from '../repositories/inventoryRepository.js';
import { referenceRepository } from '../repositories/referenceRepository.js';
import { toRequestDtos, type RequestRow } from './requestMapping.js';
import { HttpError, notFound } from '../utils/httpError.js';
import type { CallContext } from './intelligenceService.js';

/**
 * The approved role matrix (§9.2) names only EMERGENCY_STAFF for emergency requests and holds. The database's own
 * triggers (`requests_rules`, `can_act_for_request`) are broader — they also accept HOSPITAL_STAFF and DOCTOR, so
 * that a routine (non-emergency) request can be created by ordinary ward staff through a later workflow — but this
 * backend narrows the *emergency* endpoints to EMERGENCY_STAFF only, per that matrix.
 */
export const EMERGENCY_REQUEST_ROLES: readonly AppRole[] = ['EMERGENCY_STAFF'];
/** The database's `is_source_staff`: only blood-bank staff of the source confirm or decline a hold. */
export const HOLD_SOURCE_ROLES: readonly AppRole[] = ['BLOOD_BANK_ADMIN', 'BLOOD_BANK_STAFF'];

const OPEN_STATUSES: readonly $Enums.request_status[] = ['OPEN', 'ALLOCATED', 'PARTIALLY_FULFILLED'];
const MODEL = `${MODEL_NAME}@${MODEL_VERSION}`;

export interface CreateRequestInput {
  facilityId: string;
  bloodGroupId: number;
  componentId: number;
  quantity: number;
  urgency: $Enums.urgency_level;
  requiredBy: Date;
  allowCompatibleSubstitutes: boolean;
}

export type SelectionDecision = 'APPROVE' | 'MODIFY' | 'REJECT';

export function createEmergencyService(db: Database, audit: AuditService, options: { allowDemoRules: boolean }) {
  const canAct = (auth: AuthContext, facilityIds: readonly (string | null)[]) =>
    facilityIds.some((facilityId) => facilityId !== null && hasAnyRole(auth, EMERGENCY_REQUEST_ROLES, { facilityId }));

  const toDtos = (rows: RequestRow[]) => toRequestDtos(db, rows);

  async function loadActable(auth: AuthContext, id: string, client: Parameters<typeof emergencyRepository.findRequest>[0] = db.prisma) {
    const row = await emergencyRepository.findRequest(client, id);
    if (!row || !canAct(auth, [row.patient_facility_id, row.requester_facility_id])) throw notFound();
    return row;
  }

  const remainingNeed = async (client: Parameters<typeof emergencyRepository.findRequest>[0], row: RequestRow) => {
    const item = row.request_items[0];
    if (!item) throw new HttpError(422, 'The request has no item', 'REQUEST_HAS_NO_ITEM');
    const active = await emergencyRepository.activeAllocationCount(client, item.id);
    return { item, remaining: item.quantity_requested - item.quantity_fulfilled - active };
  };

  const assertOpen = (row: RequestRow) => {
    if (row.verification_status !== 'VERIFIED') throw new HttpError(422, 'The request must be verified first', 'REQUEST_NOT_VERIFIED');
    if (!OPEN_STATUSES.includes(row.status)) throw new HttpError(409, 'The request is closed', 'REQUEST_NOT_OPEN');
  };

  /** Fresh source ranking for a request, from the approved network aggregate. */
  async function computeRanking(auth: AuthContext, client: Parameters<typeof emergencyRepository.findRequest>[0], row: RequestRow, quantity: number) {
    const item = row.request_items[0]!;
    const availability = await callPrivate(client as never, 'network_availability', {
      p_actor: auth.userId,
      p_recipient_group: item.blood_group_id,
      p_component: item.component_id,
      p_quantity: quantity,
      p_allow_substitutes: item.allow_compatible_substitutes,
      p_allow_demo_rules: options.allowDemoRules,
    });
    const candidates = availability.filter((r) => r.facility_id !== row.patient_facility_id);
    const facilities = await emergencyRepository.facilities(client, [row.patient_facility_id, ...candidates.map((r) => r.facility_id as string)]);
    const destination = facilities.get(row.patient_facility_id)!;
    const parameterRows = await inventoryRepository.parameterRows(client, [destination.organizationId, ...new Set([...facilities.values()].map((f) => f.organizationId))]);
    const scopeOf = (facility: { id: string; organizationId: string }) => ({
      facilityId: facility.id, organizationId: facility.organizationId, bloodGroupId: item.blood_group_id, componentId: item.component_id,
    });
    const eta = {
      roadFactor: parsePositiveNumber(resolveParameter(parameterRows, PARAMETER_KEYS.etaRoadFactor, scopeOf(destination))),
      speedKmh: parsePositiveNumber(resolveParameter(parameterRows, PARAMETER_KEYS.etaSpeedKmh, scopeOf(destination))),
    };
    const sources: SourceOption[] = candidates.flatMap((r) => {
      const facility = facilities.get(r.facility_id as string);
      if (!facility) return [];
      return [{
        facilityId: facility.id,
        name: facility.name,
        canFulfil: (r.can_fulfil as boolean | null) ?? null,
        spare: (r.spare_units_above_reserve as number | null) ?? null,
        nearExpiry: (r.near_expiry_opportunity as boolean | null) ?? null,
        distanceKm: haversineKm(destination.latitude, destination.longitude, facility.latitude, facility.longitude),
        acceptsHolds: facility.acceptsTemporaryHolds,
        holdTimeoutConfigured: parsePositiveNumber(resolveParameter(parameterRows, PARAMETER_KEYS.holdTimeoutMinutes, scopeOf(facility))).ok,
      }];
    });
    return rankSources(sources, quantity, eta);
  }

  return {
    /** A staff-created emergency request: verified at creation (decision 2), one item. */
    async createRequest(auth: AuthContext, ctx: CallContext, input: CreateRequestInput) {
      assertFacilityAccess(auth, input.facilityId, { roles: EMERGENCY_REQUEST_ROLES, hide: true });
      const [groups, components] = await Promise.all([referenceRepository.bloodGroups(db.prisma), referenceRepository.components(db.prisma)]);
      if (!groups.some((g) => g.id === input.bloodGroupId) || !components.some((c) => c.id === input.componentId && c.active)) {
        throw new HttpError(422, 'Unknown blood group or component', 'UNKNOWN_PRODUCT');
      }

      const created = await db.withTransaction(async (tx) => {
        const now = await intelligenceRepository.databaseNow(tx);
        if (input.requiredBy <= now) throw new HttpError(422, 'The required-by time must be in the future', 'REQUIRED_BY_IN_PAST');
        const facility = (await emergencyRepository.facilities(tx, [input.facilityId])).get(input.facilityId);
        if (!facility) throw notFound();
        const request = await emergencyRepository.createRequest(tx, { ...input, requesterUserId: auth.userId }, now, 'EMERGENCY');
        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: facility.organizationId,
          facilityId: input.facilityId,
          action: 'request.create',
          entityType: 'request',
          entityId: request.id,
          newValue: {
            request_number: request.request_number, request_type: 'EMERGENCY', urgency: input.urgency, blood_group_id: input.bloodGroupId,
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
        assertFacilityAccess(auth, query.facilityId, { roles: EMERGENCY_REQUEST_ROLES, hide: true });
        facilityIds = [query.facilityId];
      } else {
        facilityIds = auth.facilities.filter((f) => hasAnyRole(auth, EMERGENCY_REQUEST_ROLES, { facilityId: f.id })).map((f) => f.id);
      }
      const window = toPageWindow(query);
      const { total, rows } = await emergencyRepository.listRequests(db.prisma, { facilityIds, status: query.status, requestType: 'EMERGENCY' }, window.skip, window.take);
      return { data: await toDtos(rows), pagination: pageMeta(query, total) };
    },

    async getRequest(auth: AuthContext, id: string) {
      const [dto] = await toDtos([await loadActable(auth, id)]);
      return dto!;
    },

    /**
     * Ranks the network sources for the request and stores the result as a PENDING EMERGENCY_SOURCE recommendation
     * for a human to act on. Nothing is reserved or released here.
     */
    async selectSources(auth: AuthContext, ctx: CallContext, requestId: string) {
      return db.withTransaction(async (tx) => {
        const row = await loadActable(auth, requestId, tx);
        assertOpen(row);
        const { item, remaining } = await remainingNeed(tx, row);
        if (remaining <= 0) throw new HttpError(409, 'The request has no remaining need', 'NO_REMAINING_NEED');
        const now = await intelligenceRepository.databaseNow(tx);
        if (row.required_by <= now) throw new HttpError(409, 'The required-by time has passed', 'REQUEST_DEADLINE_PASSED');

        const { ranked, omitted } = await computeRanking(auth, tx, row, remaining);
        const ruleStatuses = await emergencyRepository.applicableRuleStatuses(tx, item.blood_group_id, item.component_id, item.allow_compatible_substitutes, options.allowDemoRules);
        const compatibility = {
          rulesFound: ruleStatuses.length > 0,
          notice: ruleStatuses.includes('DEMO_ONLY') ? 'COMPATIBILITY_RULES_NOT_CLINICALLY_VALIDATED' : null,
        };
        const selectable = ranked.filter((r) => r.rank !== null);
        const base = { requestId, quantityNeeded: remaining, ranked, omitted, compatibility, generatedAt: now.toISOString() };
        if (selectable.length === 0) return { ...base, recommendationId: null, validUntil: null };

        const facility = (await emergencyRepository.facilities(tx, [row.patient_facility_id])).get(row.patient_facility_id)!;
        await emergencyRepository.expirePendingSelections(tx, requestId);
        const top = selectable[0]!;
        const recommendationId = await emergencyRepository.createSelection(tx, {
          organizationId: facility.organizationId,
          facilityId: row.patient_facility_id,
          requestId,
          priority: PRIORITY_BY_URGENCY[row.urgency],
          // §7.3: per-source shared outputs only; a source's own demand, reserve and exact cover never appear.
          payload: { request_item_id: item.id, ranked: ranked as unknown as never },
          what: `Reserve ${remaining} unit(s) for request ${row.request_number} at ${top.facility_name}, the top-ranked source.`,
          why: `${selectable.length} source(s) can supply this need without going below their own reserve; ${top.facility_name} ranks first` +
            (top.can_fulfil ? ' and can supply the whole quantity.' : ' but can supply only part of the quantity.'),
          data: {
            method: 'rule-based ordering; not AI',
            ordering: 'can supply the whole quantity, then shortest ETA, then most spare units above reserve, then name',
            quantity_needed: remaining,
            compatibility: { ...compatibility, note: 'matching is done by the database from the compatibility rules; nothing is decided here' },
            omitted_sources: omitted,
            model: { name: MODEL_NAME, version: MODEL_VERSION },
          },
          action:
            'A staff member confirms a source. That places a temporary hold only; the source must confirm it and no blood is released without that confirmation.',
          modelVersion: MODEL,
          dedupeKey: `emergency:${item.id}`,
          validUntil: row.required_by,
        });
        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: facility.organizationId,
          facilityId: row.patient_facility_id,
          action: 'request.select_sources',
          entityType: 'request',
          entityId: requestId,
          newValue: { recommendation_id: recommendationId, selectable_sources: selectable.length, quantity_needed: remaining },
          correlationId: ctx.correlationId,
          ip: ctx.ip,
        });
        return { ...base, recommendationId, validUntil: row.required_by.toISOString() };
      });
    },

    /**
     * The human decision on a source selection. APPROVE reserves the whole remaining need at the chosen source
     * (default: rank 1); MODIFY reserves a lower quantity; REJECT reserves nothing. A reservation is only a temporary
     * hold: the source must still confirm it, and nothing is dispatched or issued here.
     */
    async decideSelection(
      auth: AuthContext,
      ctx: CallContext,
      recommendationId: string,
      input: { decision: SelectionDecision; sourceFacilityId?: string; modifiedQuantity?: number; note?: string },
    ) {
      const outcome = await db.withTransaction(async (tx) => {
        const rec = await intelligenceRepository.lockRecommendation(tx, recommendationId);
        if (!rec || rec.recommendation_type !== 'EMERGENCY_SOURCE' || !rec.related_request_id) throw notFound();
        const row = await loadActable(auth, rec.related_request_id, tx);
        if (rec.status !== 'PENDING') throw new HttpError(409, 'This selection has already been decided or has expired', 'RECOMMENDATION_NOT_PENDING');
        const now = await intelligenceRepository.databaseNow(tx);
        if (rec.valid_until <= now) throw new HttpError(409, 'This selection is no longer valid', 'RECOMMENDATION_EXPIRED');

        const payload = rec.payload as unknown as { request_item_id: string; ranked: RankedSource[] };
        let quantity: number | null = null;
        let sourceId: string | null = null;

        if (input.decision !== 'REJECT') {
          assertOpen(row);
          const { item, remaining } = await remainingNeed(tx, row);
          if (item.id !== payload.request_item_id) throw new HttpError(409, 'The request changed; select sources again', 'SELECTION_STALE');
          const target = input.sourceFacilityId ?? payload.ranked.find((r) => r.rank === 1)?.facility_id;
          const chosen = payload.ranked.find((r) => r.facility_id === target && r.rank !== null);
          if (!chosen) throw new HttpError(422, 'That source is not one of the selectable sources', 'SOURCE_NOT_IN_SELECTION');
          quantity = input.decision === 'MODIFY' ? (input.modifiedQuantity as number) : remaining;
          if (quantity > remaining) throw new HttpError(422, 'The quantity exceeds what the request still needs', 'QUANTITY_EXCEEDS_NEED');
          if (quantity < 1) throw new HttpError(422, 'Nothing is left to reserve', 'NO_REMAINING_NEED');
          sourceId = chosen.facility_id;

          // The stock, the reserve floor and the source's eligibility are re-checked now, not trusted from the ranking.
          const fresh = (await computeRanking(auth, tx, row, quantity)).ranked.find((r) => r.facility_id === sourceId && r.rank !== null);
          if (!fresh || fresh.spare_units_above_reserve < quantity) {
            throw new HttpError(409, 'The source can no longer supply this quantity without going below its reserve', 'SOURCE_NO_LONGER_AVAILABLE');
          }
          await callPrivate(tx, 'place_source_hold', {
            p_request_item: item.id,
            p_source_facility: sourceId,
            p_quantity: quantity,
            p_actor: auth.userId,
            p_allow_demo_rules: options.allowDemoRules,
            p_recommendation: rec.id,
            p_correlation: ctx.correlationId,
          });
        }

        const status = input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'MODIFY' ? 'MODIFIED' : 'REJECTED';
        await intelligenceRepository.decideRecommendation(tx, rec.id, {
          status,
          decidedBy: auth.userId,
          decisionNote: input.note ?? null,
          ...(input.decision === 'MODIFY' ? { modifiedPayload: { ...payload, chosen_source_facility_id: sourceId, quantity } as never } : {}),
        });
        await audit.record(tx, {
          actorId: auth.userId,
          organizationId: rec.organization_id,
          facilityId: rec.facility_id,
          action: input.decision === 'APPROVE' ? 'recommendation.approve' : input.decision === 'MODIFY' ? 'recommendation.modify' : 'recommendation.reject',
          entityType: 'recommendation',
          entityId: rec.id,
          oldValue: { status: 'PENDING' },
          newValue: { status, ...(sourceId ? { source_facility_id: sourceId, quantity } : {}) },
          correlationId: ctx.correlationId,
          ip: ctx.ip,
        });
        return { requestId: row.id, status };
      });
      return { decision: outcome.status, request: await this.getRequest(auth, outcome.requestId) };
    },

    /** Source side: holds waiting for confirmation, as minimum delivery data (no patient, contact, notes or requester). */
    async incoming(auth: AuthContext, query: { facilityId?: string }) {
      let facilityIds: string[];
      if (query.facilityId) {
        assertFacilityAccess(auth, query.facilityId, { roles: HOLD_SOURCE_ROLES, hide: true });
        facilityIds = [query.facilityId];
      } else {
        facilityIds = auth.facilities.filter((f) => hasAnyRole(auth, HOLD_SOURCE_ROLES, { facilityId: f.id })).map((f) => f.id);
      }
      const [rows, groups, components] = await Promise.all([
        emergencyRepository.incomingHolds(db.prisma, facilityIds),
        referenceRepository.bloodGroups(db.prisma),
        referenceRepository.components(db.prisma),
      ]);
      const facilities = await emergencyRepository.facilities(db.prisma, [...new Set(rows.flatMap((r) => [r.source_facility_id, r.destination_facility_id]))]);
      const group = new Map(groups.map((g) => [g.id, g.code]));
      const component = new Map(components.map((c) => [c.id, c.code]));
      return rows.map((r) => ({
        sourceFacility: { id: r.source_facility_id, name: facilities.get(r.source_facility_id)?.name ?? '' },
        requestNumber: r.request_number,
        requestItemId: r.request_item_id,
        destinationFacility: { id: r.destination_facility_id, name: facilities.get(r.destination_facility_id)?.name ?? '' },
        bloodGroup: group.get(r.blood_group_id) ?? '',
        component: component.get(r.component_id) ?? '',
        quantity: r.quantity,
        urgency: r.urgency,
        requiredBy: r.required_by.toISOString(),
        status: r.status,
        holdExpiresAt: r.status === 'RESERVED' ? (r.hold_expires_at?.toISOString() ?? null) : null,
        allocationIds: r.allocation_ids,
      }));
    },

    /** Confirming keeps the units reserved for the request. It does not dispatch or issue anything. */
    async confirmHolds(auth: AuthContext, ctx: CallContext, allocationIds: string[]) {
      return db.withTransaction(async (tx) => {
        await this.assertSourceOf(auth, allocationIds, tx);
        const [row] = await callPrivate(tx, 'confirm_hold', { p_allocations: allocationIds, p_actor: auth.userId, p_correlation: ctx.correlationId });
        return { confirmed: Number(Object.values(row ?? {})[0] ?? 0) };
      });
    },

    /**
     * The source's decline. The database keeps this text inside the source's own allocation row and ledger note; the
     * requesting organization receives only the structured code SOURCE_DECLINED.
     */
    async declineHolds(auth: AuthContext, ctx: CallContext, allocationIds: string[], note: string) {
      return db.withTransaction(async (tx) => {
        await this.assertSourceOf(auth, allocationIds, tx);
        const [row] = await callPrivate(tx, 'decline_hold', { p_allocations: allocationIds, p_actor: auth.userId, p_reason: note, p_correlation: ctx.correlationId });
        return { declined: Number(Object.values(row ?? {})[0] ?? 0) };
      });
    },

    /** All allocations must exist, share one source facility, and that facility must be the caller's (else 404 / 403). */
    async assertSourceOf(auth: AuthContext, allocationIds: readonly string[], client: Parameters<typeof emergencyRepository.allocationsByIds>[0]) {
      const rows = await emergencyRepository.allocationsByIds(client, allocationIds);
      const unique = new Set(allocationIds);
      if (rows.length !== unique.size) throw notFound();
      const sources = new Set(rows.map((r) => r.source_facility_id));
      if (sources.size !== 1) throw new HttpError(400, 'All holds must belong to one source facility', 'VALIDATION_ERROR');
      const source = [...sources][0]!;
      assertFacilityAccess(auth, source, { hide: true }); // any access to the facility, else 404
      assertFacilityAccess(auth, source, { roles: HOLD_SOURCE_ROLES }); // then the blood-bank role, else 403
    },
  };
}

export type EmergencyService = ReturnType<typeof createEmergencyService>;
