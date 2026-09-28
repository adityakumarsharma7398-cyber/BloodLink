import { z } from 'zod';
import { paginationQuerySchema, uuidSchema } from './schemas.js';

const smallId = z.coerce.number().int().min(1).max(32_767);
const bool = z.enum(['true', 'false']).transform((value) => value === 'true');

export const summaryQuerySchema = z.strictObject({
  facilityId: uuidSchema.optional(),
  bloodGroupId: smallId.optional(),
  componentId: smallId.optional(),
  /** include blood group × component combinations that hold no units (so zero stock is visible) */
  includeEmpty: bool.default(true),
});

export const unitsQuerySchema = paginationQuerySchema.extend({
  facilityId: uuidSchema,
  status: z
    .enum(['AVAILABLE', 'RESERVED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIVED', 'ISSUED', 'RETURNED', 'WASTED', 'EXPIRED', 'QUARANTINED'])
    .optional(),
  bloodGroupId: smallId.optional(),
  componentId: smallId.optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(3_650).optional(),
});
