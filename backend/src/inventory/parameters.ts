/**
 * Planning parameters used by inventory intelligence. BloodLink ships NO default values (decision A /
 * U5): a parameter that is not configured makes the dependent status UNKNOWN with a reason code.
 *
 * `resolveParameter` mirrors `private.resolve_parameter` (migration 002, "most specific wins"):
 * facility > organization > network, then blood group, then component. A test compares both
 * implementations against the live database function so they cannot drift apart.
 */
export const PARAMETER_KEYS = {
  expiryWarningDays: 'expiry.warning_days',
  riskBands: 'coverage.risk_bands',
  historyDays: 'forecast.history_days',
  horizonDays: 'forecast.horizon_days',
  targetDays: 'coverage.target_days',
  transferMinUnits: 'transfer.min_units',
  transferMaxUnits: 'transfer.max_units',
  reserveFloorDays: 'reserve.floor_days',
  etaRoadFactor: 'eta.road_factor',
  etaSpeedKmh: 'eta.urban_speed_kmh',
  holdTimeoutMinutes: 'allocation.hold_timeout_minutes',
  donorSearchRadiusKm: 'donor.search_radius_km',
  donorMinIntervalDays: 'donor.min_interval_days',
} as const;

export interface ParameterRow {
  readonly key: string;
  readonly organizationId: string | null;
  readonly facilityId: string | null;
  readonly bloodGroupId: number | null;
  readonly componentId: number | null;
  readonly value: unknown;
}

export interface SeriesScope {
  readonly facilityId: string;
  readonly organizationId: string;
  readonly bloodGroupId: number;
  readonly componentId: number;
}

const matches = (row: ParameterRow, scope: SeriesScope) =>
  (row.facilityId === null || row.facilityId === scope.facilityId) &&
  (row.organizationId === null || row.organizationId === scope.organizationId) &&
  (row.bloodGroupId === null || row.bloodGroupId === scope.bloodGroupId) &&
  (row.componentId === null || row.componentId === scope.componentId);

const specificity = (row: ParameterRow): number[] => [
  row.facilityId === null ? 0 : 1,
  row.organizationId === null ? 0 : 1,
  row.bloodGroupId === null ? 0 : 1,
  row.componentId === null ? 0 : 1,
];

/** The value of the most specific matching row, or `undefined` when the key is not configured. */
export function resolveParameter(rows: readonly ParameterRow[], key: string, scope: SeriesScope): unknown {
  let best: ParameterRow | undefined;
  for (const row of rows) {
    if (row.key !== key || !matches(row, scope)) continue;
    if (!best) {
      best = row;
      continue;
    }
    const a = specificity(row);
    const b = specificity(best);
    for (let i = 0; i < 4; i += 1) {
      if (a[i] !== b[i]) {
        if ((a[i] as number) > (b[i] as number)) best = row;
        break;
      }
    }
  }
  return best?.value;
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'NOT_CONFIGURED' | 'INVALID_PARAMETER' };

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Days before expiry that count as "expiring soon". */
export function parseWarningDays(value: unknown): Parsed<number> {
  if (value === undefined) return { ok: false, reason: 'NOT_CONFIGURED' };
  return positive(value) ? { ok: true, value } : { ok: false, reason: 'INVALID_PARAMETER' };
}

/** Length of the consumption look-back window, in whole days. */
export function parseHistoryDays(value: unknown): Parsed<number> {
  if (value === undefined) return { ok: false, reason: 'NOT_CONFIGURED' };
  return positive(value) && Number.isInteger(value) ? { ok: true, value } : { ok: false, reason: 'INVALID_PARAMETER' };
}

/**
 * Days-of-cover thresholds: `{ "criticalBelowDays": n, "highBelowDays": n, "mediumBelowDays": n }`
 * with 0 < critical < high < medium. Cover below `critical` is CRITICAL, below `high` is HIGH,
 * below `medium` is MEDIUM, otherwise LOW (healthy).
 */
export interface RiskBands {
  readonly criticalBelowDays: number;
  readonly highBelowDays: number;
  readonly mediumBelowDays: number;
}

export function parseRiskBands(value: unknown): Parsed<RiskBands> {
  if (value === undefined) return { ok: false, reason: 'NOT_CONFIGURED' };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'INVALID_PARAMETER' };
  const { criticalBelowDays, highBelowDays, mediumBelowDays, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return { ok: false, reason: 'INVALID_PARAMETER' };
  if (!positive(criticalBelowDays) || !positive(highBelowDays) || !positive(mediumBelowDays)) return { ok: false, reason: 'INVALID_PARAMETER' };
  if (!(criticalBelowDays < highBelowDays && highBelowDays < mediumBelowDays)) return { ok: false, reason: 'INVALID_PARAMETER' };
  return { ok: true, value: { criticalBelowDays, highBelowDays, mediumBelowDays } };
}

/** Days of cover a facility aims to hold. */
export function parseTargetDays(value: unknown): Parsed<number> {
  if (value === undefined) return { ok: false, reason: 'NOT_CONFIGURED' };
  return positive(value) ? { ok: true, value } : { ok: false, reason: 'INVALID_PARAMETER' };
}

/** Forecast horizon in whole days; the predictions table accepts 1..90. */
export function parseHorizonDays(value: unknown): Parsed<number> {
  if (value === undefined) return { ok: false, reason: 'NOT_CONFIGURED' };
  return positive(value) && Number.isInteger(value) && value <= 90 ? { ok: true, value } : { ok: false, reason: 'INVALID_PARAMETER' };
}

/** Whole units (transfer.min_units / transfer.max_units). */
export function parseUnits(value: unknown): Parsed<number> {
  if (value === undefined) return { ok: false, reason: 'NOT_CONFIGURED' };
  return positive(value) && Number.isInteger(value) ? { ok: true, value } : { ok: false, reason: 'INVALID_PARAMETER' };
}

/** Days of cover a source keeps after giving units away. Zero is a valid choice (no reserve). */
export function parseReserveFloorDays(value: unknown): Parsed<number> {
  if (value === undefined) return { ok: false, reason: 'NOT_CONFIGURED' };
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? { ok: true, value } : { ok: false, reason: 'INVALID_PARAMETER' };
}

/** eta.road_factor and eta.urban_speed_kmh: positive numbers. */
export const parsePositiveNumber = (value: unknown): Parsed<number> =>
  value === undefined ? { ok: false, reason: 'NOT_CONFIGURED' } : positive(value) ? { ok: true, value } : { ok: false, reason: 'INVALID_PARAMETER' };

/** donor.min_interval_days: whole days, zero allowed (no minimum interval configured as a deliberate choice). */
export function parseNonNegativeInteger(value: unknown): Parsed<number> {
  if (value === undefined) return { ok: false, reason: 'NOT_CONFIGURED' };
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? { ok: true, value } : { ok: false, reason: 'INVALID_PARAMETER' };
}
