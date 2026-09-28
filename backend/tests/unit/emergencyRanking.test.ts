import { describe, expect, it } from 'vitest';
import { PRIORITY_BY_URGENCY, rankSources, type SourceOption } from '../../src/emergency/ranking.js';

const ok = <T>(value: T) => ({ ok: true, value }) as const;
const missing = { ok: false, reason: 'NOT_CONFIGURED' } as const;
const eta = { roadFactor: ok(1.5), speedKmh: ok(30) };
const noEta = { roadFactor: missing, speedKmh: missing };

const option = (id: string, spare: number | null, distanceKm = 10, over: Partial<SourceOption> = {}): SourceOption => ({
  facilityId: id, name: id, canFulfil: spare === null ? null : spare > 0, spare, nearExpiry: null, distanceKm,
  acceptsHolds: true, holdTimeoutConfigured: true, ...over,
});

describe('rankSources', () => {
  it('puts sources that can supply the whole quantity first, then nearer ones, then more spare units', () => {
    const { ranked } = rankSources([option('far-big', 50, 40), option('near-small', 3, 2), option('near-big', 9, 5), option('mid-big', 9, 20)], 5, eta);
    expect(ranked.map((r) => [r.facility_id, r.rank, r.can_fulfil])).toEqual([
      ['near-big', 1, true], ['mid-big', 2, true], ['far-big', 3, true], ['near-small', 4, false],
    ]);
  });

  it('breaks an ETA tie by spare units, then name, then id; unknown ETAs rank behind known ones', () => {
    expect(rankSources([option('a', 6, 10), option('b', 9, 10)], 5, eta).ranked.map((r) => r.facility_id)).toEqual(['b', 'a']);
    expect(rankSources([option('b', 9, 10), option('a', 9, 10)], 5, eta).ranked.map((r) => r.facility_id)).toEqual(['a', 'b']);
    // without ETA parameters no ETA is known for anyone: order falls to spare units
    const result = rankSources([option('near', 6, 1), option('far', 9, 90)], 5, noEta).ranked;
    expect(result.map((r) => r.facility_id)).toEqual(['far', 'near']);
    expect(result.every((r) => r.eta_minutes === null)).toBe(true);
  });

  it('computes ETA from distance, road factor and speed', () => {
    const [first] = rankSources([option('s', 9, 30)], 5, eta).ranked;
    expect(first).toMatchObject({ distance_km: 30, eta_minutes: 90 });
  });

  it('is independent of input order', () => {
    const list = [option('a', 6, 5), option('b', 9, 50), option('c', 9, 20), option('d', 2, 1)];
    const orders = [list, [...list].reverse(), [list[2]!, list[0]!, list[3]!, list[1]!]];
    const results = orders.map((order) => rankSources(order, 5, eta).ranked.map((r) => r.facility_id).join());
    expect(new Set(results).size).toBe(1);
  });

  it('respects reserve floors: a source with nothing above its reserve is never listed, and is only counted', () => {
    const result = rankSources([option('ok', 4), option('at-floor', 0), option('no-config', null)], 2, eta);
    expect(result.ranked.map((r) => r.facility_id)).toEqual(['ok']);
    expect(result.omitted).toEqual({ noStockAboveReserve: 1, reserveNotConfigured: 1 });
  });

  it('lists ineligible sources after the ranked ones with a reason and no rank', () => {
    const { ranked } = rankSources(
      [option('no-holds', 9, 1, { acceptsHolds: false }), option('no-timeout', 9, 2, { holdTimeoutConfigured: false }), option('good', 3, 50)], 2, eta);
    expect(ranked.map((r) => [r.facility_id, r.rank, r.excluded_reason])).toEqual([
      ['good', 1, undefined], ['no-holds', null, 'NOT_ACCEPTING_HOLDS'], ['no-timeout', null, 'HOLD_TIMEOUT_NOT_CONFIGURED'],
    ]);
  });

  it('exposes only the approved shared outputs per source', () => {
    const [entry] = rankSources([option('s', 7, 12)], 2, eta).ranked;
    expect(Object.keys(entry!).sort()).toEqual(
      ['can_fulfil', 'distance_km', 'eta_minutes', 'facility_id', 'facility_name', 'near_expiry_opportunity', 'rank', 'spare_units_above_reserve'].sort(),
    );
  });

  it('returns an empty ranking when nobody can supply anything', () => {
    expect(rankSources([], 3, eta)).toEqual({ ranked: [], omitted: { noStockAboveReserve: 0, reserveNotConfigured: 0 } });
  });
});

describe('priority', () => {
  it('maps the request urgency to the recommendation priority', () => {
    expect(PRIORITY_BY_URGENCY).toEqual({ CRITICAL: 'CRITICAL', HIGH: 'HIGH', NORMAL: 'MEDIUM' });
  });
});
