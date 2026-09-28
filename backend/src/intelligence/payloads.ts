import { z } from 'zod';

/** Stored REDISTRIBUTION payload (proposal §7.3). Re-validated on read: a stored row is data, not trusted input. */
export const redistributionPayloadSchema = z.object({
  source_facility_id: z.uuid(),
  destination_facility_id: z.uuid(),
  blood_group_id: z.number().int().min(1),
  component_id: z.number().int().min(1),
  quantity: z.number().int().min(1).max(32_767),
  eta_minutes: z.number().int().min(0).nullable(),
});

/**
 * Stored DONOR_ACTIVATION payload (proposal §7.3, `{facility_id, blood_group_id, component_id, units_needed,
 * eligible_donor_count, radius_km}`), plus `quantity`: the suggested number of donors to target, reusing the same
 * generic "quantity a human may lower" field the other two recommendation types use. No donor identity is ever here.
 */
export const donorActivationPayloadSchema = z.object({
  facility_id: z.uuid(),
  blood_group_id: z.number().int().min(1),
  component_id: z.number().int().min(1),
  units_needed: z.number().int().min(1),
  eligible_donor_count: z.number().int().min(0),
  radius_km: z.number().positive(),
  quantity: z.number().int().min(1).max(32_767),
});
