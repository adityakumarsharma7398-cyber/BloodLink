import { z } from 'zod';
import { TRANSFER_REJECTION_CODES } from '../services/transferService.js';
import { paginationQuerySchema, uuidSchema } from './schemas.js';

export const transfersQuerySchema = paginationQuerySchema.extend({
  facilityId: uuidSchema.optional(),
  status: z.enum(['PROPOSED', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'REJECTED', 'CANCELLED']).optional(),
});

export const transferParamsSchema = z.strictObject({ id: uuidSchema });

/** Omitted = approve the requested quantity; a lower number approves less (the database rejects more). */
export const approveBodySchema = z.strictObject({ approvedQuantity: z.number().int().min(1).max(32_767).optional() });

/**
 * `reasonCode` is the only reason the destination ever sees (fixed list, see TRANSFER_REJECTION_CODES).
 * `note` is the source's own free text: it is kept only in the source organization's audit log.
 */
export const rejectBodySchema = z.strictObject({
  reasonCode: z.enum(TRANSFER_REJECTION_CODES),
  note: z.string().trim().min(1).max(1_000).optional(),
});
