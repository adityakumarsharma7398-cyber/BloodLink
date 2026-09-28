import { describe, expect, it } from 'vitest';
import { O_NEG_RECOMMENDATION as rec, PRBC_STOCK, TARGET_COVER_DAYS, TOTALS, coverageDays } from './exampleData';

// The design preview must obey the same rule as the product: every figure agrees with every other.
describe('preview example data is internally consistent', () => {
  it('derives O− coverage from stock and demand', () => {
    expect(rec.coverage).toBeCloseTo(rec.available / rec.demandPerDay, 5);
    expect(rec.coverage.toFixed(1)).toBe('2.8');
  });

  it('recommends exactly the units needed to reach the cover target', () => {
    expect(rec.coverageAfter).toBeGreaterThanOrEqual(TARGET_COVER_DAYS);
    expect(coverageDays({ available: rec.available + rec.transferUnits - 1, demandPerDay: rec.demandPerDay })).toBeLessThan(TARGET_COVER_DAYS);
  });

  it('never takes the source below the cover target', () => {
    expect(rec.sourceCoverageAfter).toBeGreaterThanOrEqual(TARGET_COVER_DAYS);
  });

  it('sums the dashboard tiles from the same rows', () => {
    expect(TOTALS.units).toBe(PRBC_STOCK.reduce((sum, row) => sum + row.available + row.reserved, 0));
    expect(TOTALS.shortageRisks).toBe(PRBC_STOCK.filter((row) => coverageDays(row) < TARGET_COVER_DAYS - 2).length);
  });
});
