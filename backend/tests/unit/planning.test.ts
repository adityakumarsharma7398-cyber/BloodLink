import { describe, expect, it } from 'vitest';
import { istDate, istStartOfDay, planSeries, type SeriesInput } from '../../src/intelligence/planning.js';
import { parseHorizonDays, parseTargetDays } from '../../src/inventory/parameters.js';

const ok = <T>(value: T) => ({ ok: true, value }) as const;
const missing = { ok: false, reason: 'NOT_CONFIGURED' } as const;
const bands = ok({ criticalBelowDays: 2, highBelowDays: 4, mediumBelowDays: 7 });

const input = (over: Partial<SeriesInput> = {}): SeriesInput => ({
  usable: 6, reserved: 0, incoming: 2, expiring: null, issuedInWindow: 20,
  historyDays: ok(10), horizonDays: ok(14), targetDays: ok(10), bands, ...over,
});

describe('planSeries', () => {
  it('skips a series when the look-back window or the horizon is not configured — no default is applied', () => {
    expect(planSeries(input({ historyDays: missing }))).toEqual({ status: 'SKIPPED', reason: 'HISTORY_NOT_CONFIGURED' });
    expect(planSeries(input({ horizonDays: missing }))).toEqual({ status: 'SKIPPED', reason: 'HORIZON_NOT_CONFIGURED' });
    expect(planSeries(input({ historyDays: { ok: false, reason: 'INVALID_PARAMETER' } }))).toEqual({ status: 'SKIPPED', reason: 'INVALID_PARAMETER' });
  });

  it('forecasts demand as the trailing average and scales it by the horizon', () => {
    const plan = planSeries(input());
    expect(plan).toMatchObject({ status: 'PLANNED', demand: { dailyDemand: 2, predictedQuantity: 28, issuedInWindow: 20, historyDays: 10, horizonDays: 14 } });
  });

  it('computes cover from usable + incoming, the risk from the configured bands, and the shortage day', () => {
    const plan = planSeries(input());
    // supply 8 / 2 per day = 4 days; 4 is not below 4 → MEDIUM (< 7); runs out inside the 14-day horizon in 4 days
    expect(plan).toMatchObject({ cover: { projectedSupply: 8, daysOfCover: 4, storableDaysOfCover: 4, shortageInDays: 4, risk: 'MEDIUM' } });
  });

  it('recommends procurement of exactly the deficit against the target cover', () => {
    const plan = planSeries(input());
    // target 10 days × 2 = 20 units, supply 8 → deficit 12
    expect(plan).toMatchObject({ procurement: { quantity: 12, deficit: 12, targetDays: 10, targetStock: 20, priority: 'MEDIUM' }, procurementSkipped: null });
  });

  it('rounds the deficit up to whole units', () => {
    // 0.3/day × 10 days = 3 units target, supply 1 → 2; and fractional: 7 issued / 10 days = 0.7 × 10 = 7, supply 3.5? use ints
    const plan = planSeries(input({ issuedInWindow: 3, usable: 0, incoming: 0, targetDays: ok(15) }));
    // 0.3 × 15 = 4.5 → deficit ceil(4.5) = 5
    expect(plan).toMatchObject({ procurement: { quantity: 5 } });
  });

  it('recommends nothing when the target is met', () => {
    expect(planSeries(input({ targetDays: ok(4) }))).toMatchObject({ procurement: null, procurementSkipped: 'TARGET_MET' });
  });

  it('never divides by zero: no consumption means no cover, no risk and no recommendation', () => {
    const plan = planSeries(input({ issuedInWindow: 0 }));
    expect(plan).toMatchObject({ status: 'PLANNED', demand: { dailyDemand: 0, predictedQuantity: 0 }, cover: null, procurement: null, procurementSkipped: 'NO_CONSUMPTION_HISTORY' });
  });

  it('computes cover but recommends nothing when the target or the bands are missing', () => {
    expect(planSeries(input({ targetDays: missing }))).toMatchObject({ cover: { daysOfCover: 4 }, procurement: null, procurementSkipped: 'TARGET_NOT_CONFIGURED' });
    expect(planSeries(input({ bands: missing }))).toMatchObject({ cover: { risk: null }, procurement: null, procurementSkipped: 'BANDS_NOT_CONFIGURED' });
  });

  it('reports no shortage date when the stock outlasts the horizon', () => {
    expect(planSeries(input({ usable: 100 }))).toMatchObject({ cover: { daysOfCover: 51, shortageInDays: null } });
  });

  it('leaves cover empty rather than overflowing the column', () => {
    const plan = planSeries(input({ issuedInWindow: 1, historyDays: ok(1), usable: 20_000, incoming: 0 }));
    expect(plan).toMatchObject({ cover: { daysOfCover: 20_000, storableDaysOfCover: null } });
  });

  it('a zero-stock series with consumption is a CRITICAL shortage today', () => {
    const plan = planSeries(input({ usable: 0, incoming: 0 }));
    expect(plan).toMatchObject({ cover: { daysOfCover: 0, shortageInDays: 0, risk: 'CRITICAL' }, procurement: { quantity: 20, priority: 'CRITICAL' } });
  });

  describe('without an AI forecast (the default)', () => {
    it('labels its own demand as the trailing-average baseline, with no confidence figure', () => {
      const plan = planSeries(input());
      expect(plan).toMatchObject({
        demand: { method: 'BASELINE', modelName: 'trailing-average-baseline', modelVersion: '1', confidenceScore: null, confidenceMethod: null },
      });
    });
  });

  describe('with an AI demand forecast', () => {
    const forecast = { dailyDemand: 5, modelName: 'demand-forecast-linear-trend', modelVersion: '1', confidenceScore: 0.87, confidenceMethod: 'linear_trend_r_squared', historyDaysUsed: 30 };

    it('uses the forecast’s daily demand instead of issued_in_window / history_days, and reports its model, version and confidence', () => {
      const plan = planSeries(input({ forecast }));
      // issuedInWindow (20) / historyDays (10) would have given 2/day; the forecast overrides it to 5/day.
      expect(plan).toMatchObject({
        demand: { dailyDemand: 5, predictedQuantity: 70, method: 'AI_SERVICE', modelName: 'demand-forecast-linear-trend', modelVersion: '1', confidenceScore: 0.87, confidenceMethod: 'linear_trend_r_squared' },
      });
    });

    it('still needs history/horizon configured — the window and horizon are reported alongside the forecast, and a missing one still skips the series', () => {
      expect(planSeries(input({ forecast, historyDays: missing }))).toEqual({ status: 'SKIPPED', reason: 'HISTORY_NOT_CONFIGURED' });
      const plan = planSeries(input({ forecast }));
      expect(plan).toMatchObject({ demand: { historyDays: 10, horizonDays: 14 } });
    });

    it('the forecast changes cover, risk and the procurement deficit exactly as a higher baseline demand would', () => {
      const plan = planSeries(input({ forecast: { ...forecast, dailyDemand: 2 } })); // matches the baseline case exactly
      const baseline = planSeries(input());
      expect(plan).toMatchObject({ cover: baseline.status === 'PLANNED' ? baseline.cover : undefined, procurement: baseline.status === 'PLANNED' ? baseline.procurement : undefined });
    });

    it('never forecasts negative demand even if the AI service ever returned one', () => {
      const plan = planSeries(input({ forecast: { ...forecast, dailyDemand: -3 } }));
      expect(plan).toMatchObject({ demand: { dailyDemand: 0, predictedQuantity: 0 }, procurementSkipped: 'NO_CONSUMPTION_HISTORY' });
    });
  });
});

describe('extra parameter parsers', () => {
  it('horizon: whole days within the table limit (1..90)', () => {
    expect(parseHorizonDays(14)).toEqual({ ok: true, value: 14 });
    for (const bad of [0, 91, 1.5, '7']) expect(parseHorizonDays(bad)).toEqual({ ok: false, reason: 'INVALID_PARAMETER' });
    expect(parseHorizonDays(undefined)).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
  });
  it('target days: positive number', () => {
    expect(parseTargetDays(7.5)).toEqual({ ok: true, value: 7.5 });
    expect(parseTargetDays(0)).toEqual({ ok: false, reason: 'INVALID_PARAMETER' });
  });
});

describe('India Standard Time helpers', () => {
  it('uses the IST calendar day (UTC+5:30), matching v_daily_consumption', () => {
    expect(istDate(new Date('2026-09-26T18:29:59Z'))).toBe('2026-09-26');
    expect(istDate(new Date('2026-09-26T18:30:00Z'))).toBe('2026-09-27');
    expect(istDate(new Date('2026-09-26T10:00:00Z'), 13)).toBe('2026-10-09');
  });
  it('the start of an IST day is 18:30 UTC of the previous day', () => {
    expect(istStartOfDay('2026-09-27').toISOString()).toBe('2026-09-26T18:30:00.000Z');
  });
});
