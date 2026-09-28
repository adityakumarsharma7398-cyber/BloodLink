import type { RiskLevel } from '@/design/risk';

/**
 * EXAMPLE DATA for reviewing the visual language only — not predictions, not database values.
 * Product screens receive real, computed values from the backend (docs/DECISIONS.md, rule 1).
 *
 * Everything the preview shows is derived from these rows, so the tiles, chart, insight and
 * recommendation agree with each other. Risk levels are set by hand here; the thresholds that
 * assign them in the product are AI-service logic to be reviewed in a later phase.
 */

export const TARGET_COVER_DAYS = 7;

export interface GroupStock {
  group: string;
  available: number;
  reserved: number;
  expiringIn7Days: number;
  demandPerDay: number;
  risk: RiskLevel;
}

/** PRBC stock at ABC Hospital's blood centre, by blood group. */
export const PRBC_STOCK: GroupStock[] = [
  { group: 'O+', available: 96, reserved: 12, expiringIn7Days: 5, demandPerDay: 14.1, risk: 'healthy' },
  { group: 'O−', available: 16, reserved: 4, expiringIn7Days: 2, demandPerDay: 5.7, risk: 'critical' },
  { group: 'A+', available: 72, reserved: 8, expiringIn7Days: 3, demandPerDay: 9.6, risk: 'healthy' },
  { group: 'A−', available: 14, reserved: 2, expiringIn7Days: 1, demandPerDay: 2.9, risk: 'high' },
  { group: 'B+', available: 81, reserved: 9, expiringIn7Days: 4, demandPerDay: 10.2, risk: 'healthy' },
  { group: 'B−', available: 11, reserved: 1, expiringIn7Days: 0, demandPerDay: 1.6, risk: 'healthy' },
  { group: 'AB+', available: 29, reserved: 3, expiringIn7Days: 2, demandPerDay: 3.1, risk: 'healthy' },
  { group: 'AB−', available: 6, reserved: 0, expiringIn7Days: 1, demandPerDay: 0.8, risk: 'healthy' },
];

export const coverageDays = (row: Pick<GroupStock, 'available' | 'demandPerDay'>) => row.available / row.demandPerDay;
export const targetUnits = (row: Pick<GroupStock, 'demandPerDay'>) => Math.ceil(row.demandPerDay * TARGET_COVER_DAYS);

export const TOTALS = {
  units: PRBC_STOCK.reduce((sum, row) => sum + row.available + row.reserved, 0),
  available: PRBC_STOCK.reduce((sum, row) => sum + row.available, 0),
  expiring: PRBC_STOCK.reduce((sum, row) => sum + row.expiringIn7Days, 0),
  shortageRisks: PRBC_STOCK.filter((row) => row.risk === 'critical' || row.risk === 'high').length,
  pendingRequests: 5,
  urgentRequests: 2,
};

const oNeg = PRBC_STOCK.find((row) => row.group === 'O−')!;
const centreNorth = { name: 'Centre North', available: 58, demandPerDay: 2.1, transitMinutes: 24 };
const transferUnits = targetUnits(oNeg) - oNeg.available;

/** The single example recommendation, computed from the rows above. */
export const O_NEG_RECOMMENDATION = {
  group: oNeg.group,
  available: oNeg.available,
  demandPerDay: oNeg.demandPerDay,
  coverage: coverageDays(oNeg),
  transferUnits,
  coverageAfter: coverageDays({ available: oNeg.available + transferUnits, demandPerDay: oNeg.demandPerDay }),
  source: centreNorth.name,
  sourceCoverage: coverageDays(centreNorth),
  sourceCoverageAfter: coverageDays({ available: centreNorth.available - transferUnits, demandPerDay: centreNorth.demandPerDay }),
  transitMinutes: centreNorth.transitMinutes,
};

export type UnitStatus = 'Available' | 'Reserved' | 'Quarantined';

export interface InventoryUnitRow {
  unitCode: string;
  group: string;
  component: string;
  collected: string;
  expires: string;
  daysToExpiry: number;
  status: UnitStatus;
  location: string;
}

/** Most recent PRBC unit movements (42-day shelf life). */
export const RECENT_UNITS: InventoryUnitRow[] = [
  { unitCode: 'BLK-260924-011', group: 'O−', component: 'PRBC', collected: '24 Sep 2026', expires: '05 Nov 2026', daysToExpiry: 42, status: 'Quarantined', location: 'Refrigerator R2' },
  { unitCode: 'BLK-260922-037', group: 'O+', component: 'PRBC', collected: '22 Sep 2026', expires: '03 Nov 2026', daysToExpiry: 40, status: 'Available', location: 'Refrigerator R1' },
  { unitCode: 'BLK-260919-004', group: 'A−', component: 'PRBC', collected: '19 Sep 2026', expires: '31 Oct 2026', daysToExpiry: 37, status: 'Reserved', location: 'Refrigerator R1' },
  { unitCode: 'BLK-260914-018', group: 'O−', component: 'PRBC', collected: '14 Sep 2026', expires: '26 Oct 2026', daysToExpiry: 32, status: 'Available', location: 'Refrigerator R1' },
  { unitCode: 'BLK-260905-052', group: 'B+', component: 'PRBC', collected: '05 Sep 2026', expires: '17 Oct 2026', daysToExpiry: 23, status: 'Available', location: 'Refrigerator R3' },
  { unitCode: 'BLK-260821-009', group: 'AB+', component: 'PRBC', collected: '21 Aug 2026', expires: '02 Oct 2026', daysToExpiry: 8, status: 'Available', location: 'Refrigerator R3' },
  { unitCode: 'BLK-260818-026', group: 'O−', component: 'PRBC', collected: '18 Aug 2026', expires: '29 Sep 2026', daysToExpiry: 5, status: 'Available', location: 'Refrigerator R1' },
  { unitCode: 'BLK-260816-013', group: 'AB−', component: 'PRBC', collected: '16 Aug 2026', expires: '27 Sep 2026', daysToExpiry: 3, status: 'Reserved', location: 'Refrigerator R2' },
];
