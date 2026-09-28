import { z } from 'zod';
import { paginationQuerySchema, uuidSchema } from './schemas.js';

const smallId = z.coerce.number().int().min(1).max(32_767);

/**
 * Only what an emergency request needs: product, quantity, urgency and deadline. Patient details, contact numbers and
 * free-text notes are deliberately not accepted (the source organization must never receive them).
 */
export const createRequestBodySchema = z.strictObject({
  facilityId: uuidSchema,
  bloodGroupId: z.number().int().min(1).max(32_767),
  componentId: z.number().int().min(1).max(32_767),
  quantity: z.number().int().min(1).max(100),
  urgency: z.enum(['CRITICAL', 'HIGH', 'NORMAL']),
  requiredBy: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  allowCompatibleSubstitutes: z.boolean().default(true),
});

export const requestsQuerySchema = paginationQuerySchema.extend({
  facilityId: uuidSchema.optional(),
  status: z.enum(['OPEN', 'ALLOCATED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED', 'EXPIRED', 'REJECTED']).optional(),
});

export const idParamsSchema = z.strictObject({ id: uuidSchema });

/** APPROVE: hold the whole remaining need at the chosen source (default rank 1). MODIFY: a lower quantity. REJECT: nothing. */
export const selectionDecisionBodySchema = z
  .strictObject({
    decision: z.enum(['APPROVE', 'MODIFY', 'REJECT']),
    sourceFacilityId: uuidSchema.optional(),
    modifiedQuantity: z.number().int().min(1).max(100).optional(),
    note: z.string().trim().min(1).max(1_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'MODIFY' && value.modifiedQuantity === undefined) {
      ctx.addIssue({ code: 'custom', path: ['modifiedQuantity'], message: 'required when modifying' });
    }
    if (value.decision !== 'MODIFY' && value.modifiedQuantity !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['modifiedQuantity'], message: 'only allowed when modifying' });
    }
    if (value.decision === 'REJECT' && value.sourceFacilityId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['sourceFacilityId'], message: 'not allowed when rejecting' });
    }
    if (value.decision !== 'APPROVE' && value.note === undefined) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'required when modifying or rejecting' });
    }
  });

export const incomingQuerySchema = z.strictObject({ facilityId: uuidSchema.optional() });

const allocationIds = z.array(uuidSchema).min(1).max(100);
export const confirmBodySchema = z.strictObject({ allocationIds });
/** The note is the source's own text; it is stored only on the source's side (see EmergencyService.declineHolds). */
export const declineBodySchema = z.strictObject({ allocationIds, note: z.string().trim().min(1).max(1_000) });

export { smallId };
