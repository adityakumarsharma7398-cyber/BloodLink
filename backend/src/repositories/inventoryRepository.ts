import type { DbClient } from '../db/client.js';
import { Prisma, type $Enums } from '../generated/prisma/client.js';
import { PARAMETER_KEYS, type ParameterRow } from '../inventory/parameters.js';

export interface FacilityRow {
  id: string;
  name: string;
  organizationId: string;
  facilityType: string;
}

export interface SeriesInput {
  facilityId: string;
  bloodGroupId: number;
  componentId: number;
  /** 0 = not configured */
  warningDays: number;
  /** 0 = not configured */
  historyDays: number;
}

export interface SeriesCounts {
  facilityId: string;
  bloodGroupId: number;
  componentId: number;
  onHand: number;
  available: number;
  reserved: number;
  pendingAcceptance: number;
  inTransit: number;
  expiring: number;
  expiredNotMarked: number;
  nearestExpiry: Date | null;
  issuedInWindow: number;
}

export interface UnitFilter {
  facilityId: string;
  status?: $Enums.inventory_unit_status;
  bloodGroupId?: number;
  componentId?: number;
  /** only units expiring on or before now + N days */
  expiringWithinDays?: number;
}

interface CountRow {
  facility_id: string;
  blood_group_id: number;
  component_id: number;
  on_hand: number;
  available: number;
  reserved: number;
  pending_acceptance: number;
  in_transit: number;
  expiring: number;
  expired_not_marked: number;
  nearest_expiry: Date | null;
  issued_in_window: number;
}

/** Read-only queries. Every query is scoped by facility ids the service has already authorized. */
export const inventoryRepository = {
  /** Inventory-holding facilities among the ones the caller may read. */
  async holdingFacilities(db: DbClient, facilityIds: readonly string[]): Promise<FacilityRow[]> {
    if (facilityIds.length === 0) return [];
    const rows = await db.facilities.findMany({
      where: { id: { in: [...facilityIds] }, holds_inventory: true },
      select: { id: true, name: true, organization_id: true, facility_type: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => ({ id: row.id, name: row.name, organizationId: row.organization_id, facilityType: row.facility_type }));
  },

  /** Configured rows for the inventory keys that could apply to these organizations (plus network defaults). */
  async parameterRows(db: DbClient, organizationIds: readonly string[]): Promise<ParameterRow[]> {
    const rows = await db.planning_parameters.findMany({
      where: {
        key: { in: Object.values(PARAMETER_KEYS) },
        OR: [{ organization_id: null }, { organization_id: { in: [...organizationIds] } }],
      },
      select: { key: true, organization_id: true, facility_id: true, blood_group_id: true, component_id: true, value: true },
    });
    return rows.map((row) => ({
      key: row.key,
      organizationId: row.organization_id,
      facilityId: row.facility_id,
      bloodGroupId: row.blood_group_id,
      componentId: row.component_id,
      value: row.value,
    }));
  },

  /** One row per requested series, with zero counts where no unit exists. */
  async seriesCounts(db: DbClient, series: readonly SeriesInput[]): Promise<SeriesCounts[]> {
    if (series.length === 0) return [];
    const rows = await db.$queryRaw<CountRow[]>(Prisma.sql`
      with s as (
        select * from unnest(
          ${series.map((x) => x.facilityId)}::uuid[], ${series.map((x) => x.bloodGroupId)}::int2[],
          ${series.map((x) => x.componentId)}::int2[], ${series.map((x) => x.warningDays)}::float8[],
          ${series.map((x) => x.historyDays)}::int4[]
        ) as t(facility_id, blood_group_id, component_id, warning_days, history_days)
      )
      select s.facility_id, s.blood_group_id, s.component_id,
        (count(u.id) filter (where u.status not in ('ISSUED', 'WASTED', 'EXPIRED', 'DISPATCHED')))::int as on_hand,
        (count(u.id) filter (where u.status = 'AVAILABLE' and u.expiry_date > now()))::int as available,
        (count(u.id) filter (where u.status = 'RESERVED'))::int as reserved,
        (count(u.id) filter (where u.status in ('QUARANTINED', 'RECEIVED')))::int as pending_acceptance,
        (count(u.id) filter (where u.status = 'IN_TRANSIT'))::int as in_transit,
        (count(u.id) filter (where s.warning_days > 0 and u.status = 'AVAILABLE' and u.expiry_date > now()
           and u.expiry_date <= now() + make_interval(secs => s.warning_days * 86400)))::int as expiring,
        (count(u.id) filter (where u.status in ('AVAILABLE', 'RESERVED', 'QUARANTINED', 'RECEIVED') and u.expiry_date <= now()))::int as expired_not_marked,
        min(u.expiry_date) filter (where u.status = 'AVAILABLE' and u.expiry_date > now()) as nearest_expiry,
        (select count(*)::int from public.transactions t
          where s.history_days > 0 and t.facility_id = s.facility_id and t.blood_group_id = s.blood_group_id
            and t.component_id = s.component_id and t.transaction_type = 'INVENTORY_ISSUED'
            and t.occurred_at > now() - make_interval(days => s.history_days)) as issued_in_window
      from s
      left join public.inventory_units u
        on u.facility_id = s.facility_id and u.blood_group_id = s.blood_group_id and u.component_id = s.component_id
      group by s.facility_id, s.blood_group_id, s.component_id, s.warning_days, s.history_days`);
    return rows.map((row) => ({
      facilityId: row.facility_id,
      bloodGroupId: row.blood_group_id,
      componentId: row.component_id,
      onHand: row.on_hand,
      available: row.available,
      reserved: row.reserved,
      pendingAcceptance: row.pending_acceptance,
      inTransit: row.in_transit,
      expiring: row.expiring,
      expiredNotMarked: row.expired_not_marked,
      nearestExpiry: row.nearest_expiry,
      issuedInWindow: row.issued_in_window,
    }));
  },

  async units(db: DbClient, filter: UnitFilter, skip: number, take: number) {
    const where: Prisma.inventory_unitsWhereInput = {
      facility_id: filter.facilityId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.bloodGroupId ? { blood_group_id: filter.bloodGroupId } : {}),
      ...(filter.componentId ? { component_id: filter.componentId } : {}),
      ...(filter.expiringWithinDays ? { expiry_date: { lte: new Date(Date.now() + filter.expiringWithinDays * 86_400_000) } } : {}),
    };
    const [total, rows] = await Promise.all([
      db.inventory_units.count({ where }),
      db.inventory_units.findMany({
        where,
        // first-expiry-first, with the id as a stable tiebreaker for paging
        orderBy: [{ expiry_date: 'asc' }, { id: 'asc' }],
        skip,
        take,
        select: {
          id: true, unit_code: true, status: true, collection_date: true, processing_date: true, expiry_date: true, volume_ml: true,
          status_changed_at: true, received_at: true, storage_location_id: true, reserved_for_request_id: true,
          blood_groups: { select: { id: true, code: true } },
          components: { select: { id: true, code: true } },
        },
      }),
    ]);
    return { total, rows };
  },
};
