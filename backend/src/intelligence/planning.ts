import type { Parsed, RiskBands } from '../inventory/parameters.js';
import { riskFromDaysOfCover, type RiskLevel } from '../inventory/status.js';

/**
 * Deterministic baseline for demand and procurement (no machine learning, no invented values).
 *
 *   daily demand        = units ISSUED in the look-back window ÷ window days      (trailing average)
 *   predicted quantity  = daily demand × horizon days
 *   projected supply    = usable + incoming                                        (pending requests: see below)
 *   days of cover       = projected supply ÷ daily demand
 *   target stock        = coverage.target_days × daily demand
 *   procurement deficit = ceil(target stock − projected supply)   → recommended only when > 0
 *
 * Every threshold and window comes from planning parameters; a missing one skips the series with a
 * reason. `pending_request_units` is deliberately not subtracted: a request is bound to a stocking
 * facility only when a hold is placed, and held units are already excluded from `usable`.
 * Redistribution and donor activation are not considered here.
 */
export const MODEL_NAME = 'trailing-average-baseline';
export const MODEL_VERSION = '1';

export type SkipReason = 'HISTORY_NOT_CONFIGURED' | 'HORIZON_NOT_CONFIGURED' | 'INVALID_PARAMETER';

/** A real forecasting model's output, when the AI service was reachable and answered validly. */
export interface ForecastOverride {
  dailyDemand: number;
  modelName: string;
  modelVersion: string;
  confidenceScore: number;
  confidenceMethod: string;
  historyDaysUsed: number;
}

export interface SeriesInput {
  usable: number;
  reserved: number;
  incoming: number;
  expiring: number | null;
  issuedInWindow: number;
  historyDays: Parsed<number>;
  horizonDays: Parsed<number>;
  targetDays: Parsed<number>;
  bands: Parsed<RiskBands>;
  /**
   * When present, its `dailyDemand` is used instead of `issuedInWindow / historyDays` — the AI
   * service's demand forecast. `historyDays` and `horizonDays` are still required: they size the
   * look-back window reported alongside the figure and the forecast horizon. Omitted (or the AI
   * service was unreachable / answered invalidly) falls back to the trailing-average baseline,
   * unchanged.
   */
  forecast?: ForecastOverride;
}

export interface DemandResult {
  historyDays: number;
  horizonDays: number;
  issuedInWindow: number;
  dailyDemand: number;
  predictedQuantity: number;
  modelName: string;
  modelVersion: string;
  method: 'AI_SERVICE' | 'BASELINE';
  confidenceScore: number | null;
  confidenceMethod: string | null;
}

export interface CoverResult {
  projectedSupply: number;
  daysOfCover: number | null;
  /** null when the cover exceeds what the column can store (9999.99 days) */
  storableDaysOfCover: number | null;
  /** whole days from today until the cover runs out, when that happens inside the horizon */
  shortageInDays: number | null;
  risk: RiskLevel | null;
}

export type SeriesPlan =
  | { status: 'SKIPPED'; reason: SkipReason }
  | { status: 'PLANNED'; demand: DemandResult; cover: CoverResult | null; procurement: ProcurementPlan | null; procurementSkipped: string | null };

export interface ProcurementPlan {
  quantity: number;
  targetDays: number;
  targetStock: number;
  deficit: number;
  priority: RiskLevel;
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const MAX_STORABLE_COVER = 9999.99;

export function planSeries(input: SeriesInput): SeriesPlan {
  const { historyDays, horizonDays } = input;
  if (!historyDays.ok) return { status: 'SKIPPED', reason: historyDays.reason === 'INVALID_PARAMETER' ? 'INVALID_PARAMETER' : 'HISTORY_NOT_CONFIGURED' };
  if (!horizonDays.ok) return { status: 'SKIPPED', reason: horizonDays.reason === 'INVALID_PARAMETER' ? 'INVALID_PARAMETER' : 'HORIZON_NOT_CONFIGURED' };

  const baselineDailyDemand = input.issuedInWindow / historyDays.value;
  const dailyDemand = input.forecast ? Math.max(input.forecast.dailyDemand, 0) : baselineDailyDemand;
  const demand: DemandResult = {
    historyDays: historyDays.value,
    horizonDays: horizonDays.value,
    issuedInWindow: input.issuedInWindow,
    dailyDemand: round(dailyDemand, 3),
    predictedQuantity: round(dailyDemand * horizonDays.value, 3),
    modelName: input.forecast?.modelName ?? MODEL_NAME,
    modelVersion: input.forecast?.modelVersion ?? MODEL_VERSION,
    method: input.forecast ? 'AI_SERVICE' : 'BASELINE',
    confidenceScore: input.forecast?.confidenceScore ?? null,
    confidenceMethod: input.forecast?.confidenceMethod ?? null,
  };
  // Without any consumption there is nothing to divide by: cover, risk and procurement stay undefined.
  if (dailyDemand <= 0) return { status: 'PLANNED', demand, cover: null, procurement: null, procurementSkipped: 'NO_CONSUMPTION_HISTORY' };

  const projectedSupply = input.usable + input.incoming;
  const rawCover = projectedSupply / dailyDemand;
  const daysOfCover = round(rawCover, 2);
  const cover: CoverResult = {
    projectedSupply,
    daysOfCover,
    storableDaysOfCover: daysOfCover <= MAX_STORABLE_COVER ? daysOfCover : null,
    shortageInDays: rawCover <= horizonDays.value ? Math.floor(rawCover) : null,
    risk: input.bands.ok ? riskFromDaysOfCover(daysOfCover, input.bands.value) : null,
  };

  if (!input.targetDays.ok) return { status: 'PLANNED', demand, cover, procurement: null, procurementSkipped: `TARGET_${input.targetDays.reason}` };
  if (!input.bands.ok) return { status: 'PLANNED', demand, cover, procurement: null, procurementSkipped: `BANDS_${input.bands.reason}` };

  const targetStock = input.targetDays.value * dailyDemand;
  const deficit = Math.ceil(round(targetStock - projectedSupply, 6));
  if (deficit <= 0) return { status: 'PLANNED', demand, cover, procurement: null, procurementSkipped: 'TARGET_MET' };
  return {
    status: 'PLANNED',
    demand,
    cover,
    procurement: {
      quantity: deficit,
      targetDays: input.targetDays.value,
      targetStock: round(targetStock, 3),
      deficit,
      priority: riskFromDaysOfCover(daysOfCover, input.bands.value),
    },
    procurementSkipped: null,
  };
}

/** Calendar date (YYYY-MM-DD) in India Standard Time — the same day boundary as v_daily_consumption. */
export function istDate(at: Date, plusDays = 0): string {
  const shifted = new Date(at.getTime() + 330 * 60_000 + plusDays * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/** The instant at which the given IST calendar day begins. */
export const istStartOfDay = (date: string): Date => new Date(new Date(`${date}T00:00:00Z`).getTime() - 330 * 60_000);
