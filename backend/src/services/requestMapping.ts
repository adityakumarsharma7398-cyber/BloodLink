import type { Database } from '../db/client.js';
import { emergencyRepository } from '../repositories/emergencyRepository.js';
import { referenceRepository } from '../repositories/referenceRepository.js';

export type RequestRow = NonNullable<Awaited<ReturnType<typeof emergencyRepository.findRequest>>>;

/**
 * Shared request → DTO mapping, used for both emergency and routine requests (they are rows of the
 * same `requests`/`request_items`/`request_allocations` tables — only `request_type` differs).
 * Never includes unit identifiers, storage locations, donor information, or a source's private
 * decline/cancel text — holds are surfaced as status + count per source only (§9.4, §6.5 privacy rule).
 */
export async function toRequestDtos(db: Database, rows: RequestRow[]) {
  const items = rows.flatMap((row) => row.request_items);
  const [allocations, groups, components, ...pendings] = await Promise.all([
    emergencyRepository.allocationsForItems(db.prisma, items.map((i) => i.id)),
    referenceRepository.bloodGroups(db.prisma),
    referenceRepository.components(db.prisma),
    ...rows.map((row) => emergencyRepository.findPendingSelection(db.prisma, row.id)),
  ]);
  const facilityIds = [...new Set([...rows.map((r) => r.patient_facility_id), ...allocations.map((a) => a.source_facility_id)])];
  const facilities = await emergencyRepository.facilities(db.prisma, facilityIds);
  const group = new Map(groups.map((g) => [g.id, g.code]));
  const component = new Map(components.map((c) => [c.id, c.code]));

  return rows.map((row, index) => {
    const pending = pendings[index];
    return {
      id: row.id,
      requestNumber: row.request_number,
      type: row.request_type,
      urgency: row.urgency,
      requiredBy: row.required_by.toISOString(),
      status: row.status,
      verification: { status: row.verification_status, method: row.verification_method, verifiedAt: row.verified_at?.toISOString() ?? null },
      facility: { id: row.patient_facility_id, name: facilities.get(row.patient_facility_id)?.name ?? '' },
      createdAt: row.created_at.toISOString(),
      items: row.request_items.map((item) => {
        const mine = allocations.filter((a) => a.request_item_id === item.id);
        const active = mine.filter((a) => ['RESERVED', 'CONFIRMED', 'DISPATCHED'].includes(a.status));
        const bySource = new Map<string, { status: string; quantity: number; holdExpiresAt: Date | null; sourceId: string }>();
        for (const a of active) {
          const key = `${a.source_facility_id}|${a.status}`;
          const entry = bySource.get(key) ?? { status: a.status, quantity: 0, holdExpiresAt: null, sourceId: a.source_facility_id };
          entry.quantity += 1;
          if (a.hold_expires_at && (!entry.holdExpiresAt || a.hold_expires_at > entry.holdExpiresAt)) entry.holdExpiresAt = a.hold_expires_at;
          bySource.set(key, entry);
        }
        return {
          id: item.id,
          bloodGroup: group.get(item.blood_group_id) ?? '',
          component: component.get(item.component_id) ?? '',
          quantityRequested: item.quantity_requested,
          quantityFulfilled: item.quantity_fulfilled,
          quantityRemaining: item.quantity_requested - item.quantity_fulfilled - active.length,
          allowCompatibleSubstitutes: item.allow_compatible_substitutes,
          // Holds by source: status and count only — never unit identifiers or codes.
          holds: [...bySource.values()].map((h) => ({
            source: { id: h.sourceId, name: facilities.get(h.sourceId)?.name ?? '' },
            status: h.status,
            quantity: h.quantity,
            holdExpiresAt: h.status === 'RESERVED' ? (h.holdExpiresAt?.toISOString() ?? null) : null,
          })),
        };
      }),
      sourceSelection: pending
        ? { recommendationId: pending.id, validUntil: pending.valid_until.toISOString(), priority: pending.priority, payload: pending.payload }
        : null,
    };
  });
}
