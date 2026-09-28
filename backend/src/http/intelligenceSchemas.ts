import { z } from 'zod';
import { paginationQuerySchema, uuidSchema } from './schemas.js';

const smallId = z.coerce.number().int().min(1).max(32_767);
const bool = z.enum(['true', 'false']).transform((value) => value === 'true');

export const runBodySchema = z.strictObject({ facilityId: uuidSchema });

export const predictionsQuerySchema = paginationQuerySchema.extend({
  facilityId: uuidSchema.optional(),
  predictionType: z.enum(['DEMAND', 'SHORTAGE']).optional(),
  bloodGroupId: smallId.optional(),
  componentId: smallId.optional(),
  /** default: only the current (non-superseded) predictions */
  currentOnly: bool.default(true),
});

export const recommendationsQuerySchema = paginationQuerySchema.extend({
  facilityId: uuidSchema.optional(),
  status: z.enum(['PENDING', 'APPROVED', 'MODIFIED', 'REJECTED', 'EXPIRED', 'EXECUTED']).optional(),
  type: z.enum(['PROCUREMENT', 'REDISTRIBUTION', 'DONOR_ACTIVATION']).optional(),
});

export const recommendationParamsSchema = z.strictObject({ id: uuidSchema });

/** MODIFY needs the new quantity; MODIFY and REJECT need a note (the database requires one too). */
export const decisionBodySchema = z
  .strictObject({
    decision: z.enum(['APPROVE', 'MODIFY', 'REJECT']),
    modifiedQuantity: z.number().int().min(1).max(1_000_000).optional(),
    note: z.string().trim().min(1).max(1_000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'MODIFY' && value.modifiedQuantity === undefined) {
      ctx.addIssue({ code: 'custom', path: ['modifiedQuantity'], message: 'required when modifying' });
    }
    if (value.decision !== 'MODIFY' && value.modifiedQuantity !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['modifiedQuantity'], message: 'only allowed when modifying' });
    }
    if (value.decision !== 'APPROVE' && value.note === undefined) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'required when modifying or rejecting' });
    }
  });
