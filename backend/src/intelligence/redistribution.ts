import type { Parsed } from '../inventory/parameters.js';
import type { RiskLevel } from '../inventory/status.js';

/**
 * Redistribution planning (proposal §7.2a), deterministic and parameter-driven:
 *
 *   deficit_D    = ceil(target_days x demand_D - projected_supply_D)          (destination)
 *   shareable_S  = usable_S - pending_request_units_S - ceil(reserve_floor_days x demand_S)   (source)
 *   quantity     = min(deficit_D, shareable_S, transfer.max_units)
 *   recommend if   quantity >= transfer.min_units  and  destination cover < target
 *
 * The destination side comes from the destination's own current SHORTAGE prediction, so the
 * recommendation is reproducible from stored rows. Source-side internals (demand, reserve floor,
 * exact cover, expiry dates) never leave this module's caller: only the shared outputs
 * (can fulfil, spare units, ETA) are returned.
 */

export interface DestinationSeries {
  predictionId: string;
  bloodGroupId: number;
  componentId: number;
  dailyDemand: number;
  projectedSupply: number;
  daysOfCover: number;
  risk: RiskLevel;
  targetDays: Parsed<number>;
  minUnits: Parsed<number>;
  maxUnits: Parsed<number>;
}

export interface SourceCandidate {
  facilityId: string;
  name: string;
  /** shareable units, or null when the source cannot compute it (no demand or no reserve floor) */
  spare: number | null;
  sourcePredictionId: string | null;
  distanceKm: number | null;
}

export interface EtaParameters {
  roadFactor: Parsed<number>;
  speedKmh: Parsed<number>;
}

export type RedistributionSkip =
  | 'TARGET_NOT_CONFIGURED' | 'TRANSFER_LIMITS_NOT_CONFIGURED' | 'INVALID_PARAMETER' | 'TARGET_MET'
  | 'NO_SOURCE_AVAILABLE' | 'BELOW_MINIMUM_TRANSFER';

export type RedistributionPlan =
  | { status: 'SKIPPED'; reason: RedistributionSkip }
  | {
      status: 'RECOMMENDED';
      source: SourceCandidate;
      quantity: number;
      deficit: number;
      targetDays: number;
      minUnits: number;
      maxUnits: number;
      coverBefore: number;
      coverAfter: number;
      sourceCanFulfil: boolean;
      etaMinutes: number | null;
    };

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Great-circle distance in km (the mock Maps adapter's Haversine distance). */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** ETA = distance x road factor / speed; empty unless both parameters are configured. */
export function etaMinutes(distanceKm: number | null, eta: EtaParameters): number | null {
  if (distanceKm === null || !eta.roadFactor.ok || !eta.speedKmh.ok) return null;
  return Math.ceil(((distanceKm * eta.roadFactor.value) / eta.speedKmh.value) * 60);
}

/** Units a source can share, or null if it cannot be computed from configured values. */
export function shareableUnits(input: { usable: number; pending: number; demand: number | null; reserveFloorDays: Parsed<number> }): number | null {
  if (input.demand === null || !input.reserveFloorDays.ok) return null;
  return Math.max(input.usable - input.pending - Math.ceil(Math.round(input.reserveFloorDays.value * input.demand * 1e6) / 1e6), 0);
}

export function planRedistribution(series: DestinationSeries, candidates: readonly SourceCandidate[], eta: EtaParameters): RedistributionPlan {
  const { targetDays, minUnits, maxUnits } = series;
  if (!targetDays.ok) return { status: 'SKIPPED', reason: targetDays.reason === 'INVALID_PARAMETER' ? 'INVALID_PARAMETER' : 'TARGET_NOT_CONFIGURED' };
  if (!minUnits.ok || !maxUnits.ok) {
    const invalid = (!minUnits.ok && minUnits.reason === 'INVALID_PARAMETER') || (!maxUnits.ok && maxUnits.reason === 'INVALID_PARAMETER');
    return { status: 'SKIPPED', reason: invalid ? 'INVALID_PARAMETER' : 'TRANSFER_LIMITS_NOT_CONFIGURED' };
  }
  if (minUnits.value > maxUnits.value) return { status: 'SKIPPED', reason: 'INVALID_PARAMETER' };

  const deficit = Math.ceil(Math.round((targetDays.value * series.dailyDemand - series.projectedSupply) * 1e6) / 1e6);
  if (deficit <= 0 || series.daysOfCover >= targetDays.value) return { status: 'SKIPPED', reason: 'TARGET_MET' };

  const shareable = candidates.filter((candidate) => candidate.spare !== null && candidate.spare > 0);
  if (shareable.length === 0) return { status: 'SKIPPED', reason: 'NO_SOURCE_AVAILABLE' };

  const options = shareable
    .map((source) => ({ source, quantity: Math.min(deficit, source.spare as number, maxUnits.value), eta: etaMinutes(source.distanceKm, eta) }))
    .filter((option) => option.quantity >= minUnits.value);
  if (options.length === 0) return { status: 'SKIPPED', reason: 'BELOW_MINIMUM_TRANSFER' };

  // Largest transferable quantity, then the shortest known ETA, then name and id (stable, explainable).
  options.sort(
    (a, b) =>
      b.quantity - a.quantity ||
      (a.eta ?? Number.POSITIVE_INFINITY) - (b.eta ?? Number.POSITIVE_INFINITY) ||
      a.source.name.localeCompare(b.source.name) ||
      a.source.facilityId.localeCompare(b.source.facilityId),
  );
  const best = options[0]!;
  return {
    status: 'RECOMMENDED',
    source: best.source,
    quantity: best.quantity,
    deficit,
    targetDays: targetDays.value,
    minUnits: minUnits.value,
    maxUnits: maxUnits.value,
    coverBefore: series.daysOfCover,
    coverAfter: round2((series.projectedSupply + best.quantity) / series.dailyDemand),
    sourceCanFulfil: (best.source.spare as number) >= deficit,
    etaMinutes: best.eta,
  };
}
