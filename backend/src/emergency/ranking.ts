import { etaMinutes, type EtaParameters } from '../intelligence/redistribution.js';

/**
 * Emergency source ranking (proposal §7.3 EMERGENCY_SOURCE). Inputs are the OUTPUTS of the approved network
 * aggregate (`private.network_availability`: can-fulfil and spare units above the source's reserve floor) plus each
 * source's hold eligibility. Compatibility is decided inside that database function from the compatibility rules; nothing
 * clinical is decided here.
 *
 * No scoring weights are used (the `ranking.weights` parameter has no defined shape and no values). Order is a plain,
 * explainable sequence: can fulfil the whole need, then shortest ETA, then most spare units, then name.
 */

export type ExclusionReason = 'NOT_ACCEPTING_HOLDS' | 'HOLD_TIMEOUT_NOT_CONFIGURED';

export interface SourceOption {
  facilityId: string;
  name: string;
  canFulfil: boolean | null;
  /** units above the source's reserve floor; null = the source's reserve could not be computed */
  spare: number | null;
  nearExpiry: boolean | null;
  distanceKm: number;
  acceptsHolds: boolean;
  holdTimeoutConfigured: boolean;
}

export interface RankedSource {
  facility_id: string;
  facility_name: string;
  can_fulfil: boolean;
  spare_units_above_reserve: number;
  near_expiry_opportunity: boolean | null;
  distance_km: number;
  eta_minutes: number | null;
  rank: number | null;
  excluded_reason?: ExclusionReason;
}

export interface RankingResult {
  ranked: RankedSource[];
  /** aggregate counts of sources left out without naming them */
  omitted: { noStockAboveReserve: number; reserveNotConfigured: number };
}

const km = (value: number) => Math.round(value * 10) / 10;

export function rankSources(options: readonly SourceOption[], quantity: number, eta: EtaParameters): RankingResult {
  const omitted = { noStockAboveReserve: 0, reserveNotConfigured: 0 };
  const usable: (SourceOption & { spare: number; eta: number | null })[] = [];
  for (const option of options) {
    if (option.spare === null) omitted.reserveNotConfigured += 1;
    else if (option.spare <= 0) omitted.noStockAboveReserve += 1;
    else usable.push({ ...option, spare: option.spare, eta: etaMinutes(option.distanceKm, eta) });
  }

  const toEntry = (option: (typeof usable)[number], rank: number | null, excluded?: ExclusionReason): RankedSource => ({
    facility_id: option.facilityId,
    facility_name: option.name,
    can_fulfil: option.spare >= quantity,
    spare_units_above_reserve: option.spare,
    near_expiry_opportunity: option.nearExpiry,
    distance_km: km(option.distanceKm),
    eta_minutes: option.eta,
    rank,
    ...(excluded ? { excluded_reason: excluded } : {}),
  });

  const exclusionOf = (option: SourceOption): ExclusionReason | null =>
    !option.acceptsHolds ? 'NOT_ACCEPTING_HOLDS' : !option.holdTimeoutConfigured ? 'HOLD_TIMEOUT_NOT_CONFIGURED' : null;

  const selectable = usable
    .filter((option) => exclusionOf(option) === null)
    .sort(
      (a, b) =>
        Number(b.spare >= quantity) - Number(a.spare >= quantity) ||
        (a.eta ?? Number.POSITIVE_INFINITY) - (b.eta ?? Number.POSITIVE_INFINITY) ||
        b.spare - a.spare ||
        a.name.localeCompare(b.name) ||
        a.facilityId.localeCompare(b.facilityId),
    );
  const excluded = usable
    .filter((option) => exclusionOf(option) !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.facilityId.localeCompare(b.facilityId));

  return {
    ranked: [
      ...selectable.map((option, index) => toEntry(option, index + 1)),
      ...excluded.map((option) => toEntry(option, null, exclusionOf(option)!)),
    ],
    omitted,
  };
}

/** Urgency of the request maps to the priority of its source-selection recommendation. */
export const PRIORITY_BY_URGENCY = { CRITICAL: 'CRITICAL', HIGH: 'HIGH', NORMAL: 'MEDIUM' } as const;
