import { describe, expect, it } from 'vitest';
import {
  parseHistoryDays, parseRiskBands, parseWarningDays, resolveParameter, type ParameterRow,
} from '../../src/inventory/parameters.js';
import { classifyExpiry, classifyShortage } from '../../src/inventory/status.js';

const scope = { facilityId: 'f1', organizationId: 'o1', bloodGroupId: 1, componentId: 2 };
const row = (over: Partial<ParameterRow>): ParameterRow => ({
  key: 'k', organizationId: null, facilityId: null, bloodGroupId: null, componentId: null, value: 0, ...over,
});

describe('resolveParameter (most specific wins)', () => {
  it('returns undefined when nothing is configured — never a default', () => {
    expect(resolveParameter([], 'k', scope)).toBeUndefined();
    expect(resolveParameter([row({ key: 'other', value: 1 })], 'k', scope)).toBeUndefined();
  });

  it('ignores rows that belong to another scope', () => {
    const rows = [
      row({ value: 'other-facility', organizationId: 'o1', facilityId: 'f2' }),
      row({ value: 'other-org', organizationId: 'o2' }),
      row({ value: 'other-group', bloodGroupId: 9 }),
      row({ value: 'other-component', componentId: 9 }),
    ];
    expect(resolveParameter(rows, 'k', scope)).toBeUndefined();
  });

  it('prefers facility over organization over network', () => {
    const rows = [
      row({ value: 'network' }),
      row({ value: 'org', organizationId: 'o1' }),
      row({ value: 'facility', organizationId: 'o1', facilityId: 'f1' }),
    ];
    expect(resolveParameter(rows, 'k', scope)).toBe('facility');
    expect(resolveParameter(rows.slice(0, 2), 'k', scope)).toBe('org');
    expect(resolveParameter(rows.slice(0, 1), 'k', scope)).toBe('network');
  });

  it('within a level prefers blood group over component, and both over neither', () => {
    const rows = [row({ value: 'none' }), row({ value: 'component', componentId: 2 }), row({ value: 'group', bloodGroupId: 1 })];
    expect(resolveParameter(rows, 'k', scope)).toBe('group');
    expect(resolveParameter([rows[0]!, rows[1]!], 'k', scope)).toBe('component');
  });

  it('is independent of row order', () => {
    const rows = [row({ value: 'org', organizationId: 'o1' }), row({ value: 'network' }), row({ value: 'facility', organizationId: 'o1', facilityId: 'f1' })];
    for (const order of [rows, [...rows].reverse(), [rows[1]!, rows[2]!, rows[0]!]]) {
      expect(resolveParameter(order, 'k', scope)).toBe('facility');
    }
  });
});

describe('parameter parsing', () => {
  it('warning days: positive numbers only; missing is NOT_CONFIGURED', () => {
    expect(parseWarningDays(7)).toEqual({ ok: true, value: 7 });
    expect(parseWarningDays(undefined)).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    for (const bad of [0, -1, '7', null, NaN, {}]) expect(parseWarningDays(bad)).toEqual({ ok: false, reason: 'INVALID_PARAMETER' });
  });

  it('history days: positive integers only', () => {
    expect(parseHistoryDays(30)).toEqual({ ok: true, value: 30 });
    for (const bad of [0, 1.5, -3, '30']) expect(parseHistoryDays(bad)).toEqual({ ok: false, reason: 'INVALID_PARAMETER' });
    expect(parseHistoryDays(undefined)).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
  });

  it('risk bands: exact shape, positive and strictly increasing', () => {
    const good = { criticalBelowDays: 2, highBelowDays: 4, mediumBelowDays: 7 };
    expect(parseRiskBands(good)).toEqual({ ok: true, value: good });
    expect(parseRiskBands(undefined)).toEqual({ ok: false, reason: 'NOT_CONFIGURED' });
    const invalid = [
      { ...good, extra: 1 }, { criticalBelowDays: 2, highBelowDays: 4 }, { ...good, criticalBelowDays: 4 },
      { ...good, criticalBelowDays: 0 }, { ...good, highBelowDays: '4' }, [], 5, null,
    ];
    for (const bad of invalid) expect(parseRiskBands(bad)).toEqual({ ok: false, reason: 'INVALID_PARAMETER' });
  });
});

describe('classifyShortage', () => {
  const bands = { ok: true, value: { criticalBelowDays: 2, highBelowDays: 4, mediumBelowDays: 7 } } as const;
  const history = { ok: true, value: 10 } as const; // 10-day window
  const at = (available: number, issuedInWindow: number) => classifyShortage({ available, issuedInWindow, historyDays: history, bands });

  it('computes days of cover from units issued in the window', () => {
    // 20 issued in 10 days = 2/day
    expect(at(3, 20)).toEqual({ status: 'SHORTAGE', riskLevel: 'CRITICAL', daysOfCover: 1.5 });
    expect(at(6, 20)).toEqual({ status: 'SHORTAGE', riskLevel: 'HIGH', daysOfCover: 3 });
    expect(at(12, 20)).toEqual({ status: 'SHORTAGE', riskLevel: 'MEDIUM', daysOfCover: 6 });
    expect(at(14, 20)).toEqual({ status: 'HEALTHY', riskLevel: 'LOW', daysOfCover: 7 });
    expect(at(100, 20)).toMatchObject({ status: 'HEALTHY' });
  });

  it('band edges are exclusive lower bounds of the next band', () => {
    expect(at(4, 20)).toMatchObject({ riskLevel: 'HIGH', daysOfCover: 2 }); // exactly critical threshold → HIGH
  });

  it('zero stock with real consumption is a CRITICAL shortage', () => {
    expect(at(0, 5)).toEqual({ status: 'SHORTAGE', riskLevel: 'CRITICAL', daysOfCover: 0 });
  });

  it('is UNKNOWN — with a reason — when configuration or history is missing', () => {
    const missing = { ok: false, reason: 'NOT_CONFIGURED' } as const;
    const invalid = { ok: false, reason: 'INVALID_PARAMETER' } as const;
    expect(classifyShortage({ available: 5, issuedInWindow: 9, historyDays: history, bands: missing })).toMatchObject({ status: 'UNKNOWN', reason: 'NOT_CONFIGURED' });
    expect(classifyShortage({ available: 5, issuedInWindow: 9, historyDays: history, bands: invalid })).toMatchObject({ reason: 'INVALID_PARAMETER' });
    expect(classifyShortage({ available: 5, issuedInWindow: 9, historyDays: missing, bands })).toMatchObject({ reason: 'NOT_CONFIGURED' });
    expect(at(5, 0)).toEqual({ status: 'UNKNOWN', riskLevel: null, daysOfCover: null, reason: 'NO_CONSUMPTION_HISTORY' });
  });
});

describe('classifyExpiry', () => {
  it('flags units inside the configured window', () => {
    expect(classifyExpiry({ warningDays: { ok: true, value: 7 }, expiringUnits: 2 })).toEqual({ status: 'AT_RISK', warningDays: 7, expiringUnits: 2 });
    expect(classifyExpiry({ warningDays: { ok: true, value: 7 }, expiringUnits: 0 })).toEqual({ status: 'OK', warningDays: 7, expiringUnits: 0 });
  });

  it('is UNKNOWN when the window is not configured', () => {
    expect(classifyExpiry({ warningDays: { ok: false, reason: 'NOT_CONFIGURED' }, expiringUnits: 3 })).toEqual({
      status: 'UNKNOWN', warningDays: null, expiringUnits: null, reason: 'NOT_CONFIGURED',
    });
  });
});
