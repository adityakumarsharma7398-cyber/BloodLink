import type { Parsed, RiskBands } from './parameters.js';

export type RiskLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Maps days of cover to a risk level with the configured bands (below critical → CRITICAL, … otherwise LOW). */
export function riskFromDaysOfCover(daysOfCover: number, bands: RiskBands): RiskLevel {
  if (daysOfCover < bands.criticalBelowDays) return 'CRITICAL';
  if (daysOfCover < bands.highBelowDays) return 'HIGH';
  if (daysOfCover < bands.mediumBelowDays) return 'MEDIUM';
  return 'LOW';
}

export type UnknownReason = 'NOT_CONFIGURED' | 'INVALID_PARAMETER' | 'NO_CONSUMPTION_HISTORY';

export type ShortageStatus =
  | { status: 'SHORTAGE'; riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM'; daysOfCover: number }
  | { status: 'HEALTHY'; riskLevel: 'LOW'; daysOfCover: number }
  | { status: 'UNKNOWN'; riskLevel: null; daysOfCover: null; reason: UnknownReason };

/**
 * Shortage classification from days of cover = available usable units / average daily consumption,
 * where consumption is the trailing average of units actually ISSUED (from the transaction ledger).
 * This describes recent history; it is not a forecast. Nothing is guessed: when a threshold, the
 * window or any consumption history is missing, the status is UNKNOWN with the reason.
 */
export function classifyShortage(input: {
  available: number;
  issuedInWindow: number;
  historyDays: Parsed<number>;
  bands: Parsed<RiskBands>;
}): ShortageStatus {
  const { bands, historyDays } = input;
  if (!bands.ok) return { status: 'UNKNOWN', riskLevel: null, daysOfCover: null, reason: bands.reason };
  if (!historyDays.ok) return { status: 'UNKNOWN', riskLevel: null, daysOfCover: null, reason: historyDays.reason };
  if (input.issuedInWindow <= 0) return { status: 'UNKNOWN', riskLevel: null, daysOfCover: null, reason: 'NO_CONSUMPTION_HISTORY' };

  const dailyConsumption = input.issuedInWindow / historyDays.value;
  const daysOfCover = Math.round((input.available / dailyConsumption) * 100) / 100;
  const { criticalBelowDays, highBelowDays, mediumBelowDays } = bands.value;
  if (daysOfCover < criticalBelowDays) return { status: 'SHORTAGE', riskLevel: 'CRITICAL', daysOfCover };
  if (daysOfCover < highBelowDays) return { status: 'SHORTAGE', riskLevel: 'HIGH', daysOfCover };
  if (daysOfCover < mediumBelowDays) return { status: 'SHORTAGE', riskLevel: 'MEDIUM', daysOfCover };
  return { status: 'HEALTHY', riskLevel: 'LOW', daysOfCover };
}

export type ExpiryStatus =
  | { status: 'AT_RISK' | 'OK'; warningDays: number; expiringUnits: number }
  | { status: 'UNKNOWN'; warningDays: null; expiringUnits: null; reason: 'NOT_CONFIGURED' | 'INVALID_PARAMETER' };

/** Expiry risk: usable units that expire within the configured warning window. */
export function classifyExpiry(input: { warningDays: Parsed<number>; expiringUnits: number }): ExpiryStatus {
  if (!input.warningDays.ok) return { status: 'UNKNOWN', warningDays: null, expiringUnits: null, reason: input.warningDays.reason };
  return {
    status: input.expiringUnits > 0 ? 'AT_RISK' : 'OK',
    warningDays: input.warningDays.value,
    expiringUnits: input.expiringUnits,
  };
}
