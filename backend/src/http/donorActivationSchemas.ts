import { z } from 'zod';
import { paginationQuerySchema, uuidSchema } from './schemas.js';

export const activationsQuerySchema = paginationQuerySchema.extend({
  facilityId: uuidSchema.optional(),
  status: z.enum(['ACTIVE', 'FULFILLED', 'CANCELLED', 'EXPIRED']).optional(),
});

export const idParamsSchema = z.strictObject({ id: uuidSchema });
export const recipientParamsSchema = z.strictObject({ recipientId: uuidSchema });

export const respondBodySchema = z.strictObject({ response: z.enum(['WILLING', 'DECLINED']) });
