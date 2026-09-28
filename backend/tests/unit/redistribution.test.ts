import { describe, expect, it } from 'vitest';
import {
  etaMinutes, haversineKm, planRedistribution, shareableUnits, type DestinationSeries, type SourceCandidate,
} from '../../src/intelligence/redistribution.js';

const ok = <T>(value: T) => ({ ok: true, value }) as const;
const missing = { ok: false, reason: 'NOT_CONFIGURED' } as const;
const invalid = { ok: false, reason: 'INVALID_PARAMETER' } as const;
const eta = { roadFactor: ok(1.5), speedKmh: ok(30) };
const noEta = { roadFactor: missing, speedKmh: missing };

// demand 2/day, supply 8 → cover 4 days; target 10 days → deficit 12
const destination = (over: Partial<DestinationSeries> = {}): DestinationSeries => ({
  predictionId: 'p1', bloodGroupId: 1, componentId: 2, dailyDemand: 2, projectedSupply: 8, daysOfCover: 4, risk: 'HIGH',
  targetDays: ok(10), minUnits: ok(3), maxUnits: ok(20), ...over,
});
const source = (id: string, spare: number | null, distanceKm: number | null = 10, name = id): SourceCandidate => ({
  facilityId: id, name, spare, sourcePredictionId: `pred-${id}`, distanceKm,
});

describe('shareableUnits (§7.2a)', () => {
  it('= usable − pending − ceil(reserve floor days × demand), never below zero', () => {
    expect(shareableUnits({ usable: 20, pending: 2, demand: 0.5, reserveFloorDays: ok(10) })).toBe(13); // ceil(5) = 5
    expect(shareableUnits({ usable: 20, pending: 0, demand: 0.3, reserveFloorDays: ok(10) })).toBe(17); // ceil(3) = 3
  });
  it('rounds the reserve up to whole units', () => {
    expect(shareableUnits({ usable: 10, pending: 0, demand: 0.35, reserveFloorDays: ok(10) })).toBe(6); // ceil(3.5) = 4
  });
  it('is zero when the reserve and pending demand exceed the stock', () => {
    expect(shareableUnits({ usable: 3, pending: 2, demand: 1, reserveFloorDays: ok(5) })).toBe(0);
  });
  it('is unknown — not zero, not a default — without demand or a configured reserve', () => {
    expect(shareableUnits({ usable: 20, pending: 0, demand: null, reserveFloorDays: ok(5) })).toBeNull();
    expect(shareableUnits({ usable: 20, pending: 0, demand: 1, reserveFloorDays: missing })).toBeNull();
    expect(shareableUnits({ usable: 20, pending: 0, demand: 1, reserveFloorDays: invalid })).toBeNull();
  });
  it('accepts a zero reserve floor (no reserve)', () => {
    expect(shareableUnits({ usable: 9, pending: 1, demand: 2, reserveFloorDays: ok(0) })).toBe(8);
  });
});

describe('distance and ETA', () => {
  it('haversine: zero for the same point, ~111 km per degree of latitude', () => {
    expect(haversineKm(26.85, 80.95, 26.85, 80.95)).toBe(0);
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.19, 1);
  });
  it('ETA = distance × road factor ÷ speed, in whole minutes rounded up; empty unless both are configured', () => {
    expect(etaMinutes(30, eta)).toBe(90); // 30 × 1.5 / 30 h
    expect(etaMinutes(10, eta)).toBe(30);
    expect(etaMinutes(10.1, eta)).toBe(31);
    expect(etaMinutes(10, noEta)).toBeNull();
    expect(etaMinutes(10, { roadFactor: ok(1.5), speedKmh: missing })).toBeNull();
    expect(etaMinutes(null, eta)).toBeNull();
  });
});

describe('planRedistribution', () => {
  it('quantity = min(deficit, source spare, transfer.max_units) and cover after the transfer', () => {
    const plan = planRedistribution(destination(), [source('S', 50)], eta);
    expect(plan).toMatchObject({ status: 'RECOMMENDED', quantity: 12, deficit: 12, sourceCanFulfil: true, coverBefore: 4, coverAfter: 10 });
    expect(planRedistribution(destination(), [source('S', 7)], eta)).toMatchObject({ quantity: 7, sourceCanFulfil: false, coverAfter: 7.5 });
    expect(planRedistribution(destination({ maxUnits: ok(5) }), [source('S', 50)], eta)).toMatchObject({ quantity: 5 });
  });

  it('skips with a reason instead of guessing when parameters are missing or invalid', () => {
    expect(planRedistribution(destination({ targetDays: missing }), [source('S', 9)], eta)).toEqual({ status: 'SKIPPED', reason: 'TARGET_NOT_CONFIGURED' });
    expect(planRedistribution(destination({ minUnits: missing }), [source('S', 9)], eta)).toEqual({ status: 'SKIPPED', reason: 'TRANSFER_LIMITS_NOT_CONFIGURED' });
    expect(planRedistribution(destination({ maxUnits: missing }), [source('S', 9)], eta)).toEqual({ status: 'SKIPPED', reason: 'TRANSFER_LIMITS_NOT_CONFIGURED' });
    expect(planRedistribution(destination({ maxUnits: invalid }), [source('S', 9)], eta)).toEqual({ status: 'SKIPPED', reason: 'INVALID_PARAMETER' });
    expect(planRedistribution(destination({ minUnits: ok(9), maxUnits: ok(4) }), [source('S', 9)], eta)).toEqual({ status: 'SKIPPED', reason: 'INVALID_PARAMETER' });
  });

  it('recommends nothing when the destination already meets its target', () => {
    expect(planRedistribution(destination({ projectedSupply: 20, daysOfCover: 10 }), [source('S', 9)], eta)).toEqual({ status: 'SKIPPED', reason: 'TARGET_MET' });
  });

  it('needs a source that can actually share: unknown or zero spare is not a source', () => {
    expect(planRedistribution(destination(), [], eta)).toEqual({ status: 'SKIPPED', reason: 'NO_SOURCE_AVAILABLE' });
    expect(planRedistribution(destination(), [source('S', null), source('T', 0)], eta)).toEqual({ status: 'SKIPPED', reason: 'NO_SOURCE_AVAILABLE' });
  });

  it('does not recommend a transfer smaller than transfer.min_units', () => {
    expect(planRedistribution(destination(), [source('S', 2)], eta)).toEqual({ status: 'SKIPPED', reason: 'BELOW_MINIMUM_TRANSFER' });
    // a smaller source is ignored when a bigger one qualifies
    expect(planRedistribution(destination(), [source('S', 2), source('T', 5)], eta)).toMatchObject({ source: { facilityId: 'T' }, quantity: 5 });
  });

  it('picks the source that can send the most, then the nearest, then by name and id', () => {
    expect(planRedistribution(destination(), [source('A', 6, 5), source('B', 9, 50)], eta)).toMatchObject({ source: { facilityId: 'B' }, quantity: 9 });
    // same quantity → nearer wins (ETA known)
    expect(planRedistribution(destination(), [source('A', 9, 40), source('B', 9, 5)], eta)).toMatchObject({ source: { facilityId: 'B' } });
    // ETA unknown → a source with a known ETA is preferred only when ETA parameters exist; otherwise names decide
    expect(planRedistribution(destination(), [source('Z', 9, 5, 'Zeta'), source('A', 9, 40, 'Alpha')], noEta)).toMatchObject({ source: { facilityId: 'A' } });
    expect(planRedistribution(destination(), [source('B', 9, 5, 'Same'), source('A', 9, 5, 'Same')], eta)).toMatchObject({ source: { facilityId: 'A' } });
  });

  it('is independent of candidate order', () => {
    const list = [source('A', 6, 5), source('B', 9, 50), source('C', 9, 20)];
    const winners = [list, [...list].reverse(), [list[1]!, list[2]!, list[0]!]].map((order) => {
      const plan = planRedistribution(destination(), order, eta);
      return plan.status === 'RECOMMENDED' ? plan.source.facilityId : null;
    });
    expect(new Set(winners)).toEqual(new Set(['C']));
  });

  it('never returns source demand, reserve, cover or expiry: only shared outputs', () => {
    const plan = planRedistribution(destination(), [source('S', 50, 10)], eta);
    expect(plan.status).toBe('RECOMMENDED');
    expect(Object.keys(plan).sort()).toEqual(
      ['coverAfter', 'coverBefore', 'deficit', 'etaMinutes', 'maxUnits', 'minUnits', 'quantity', 'source', 'sourceCanFulfil', 'status', 'targetDays'].sort(),
    );
  });
});
