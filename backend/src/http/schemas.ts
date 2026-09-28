import { z } from 'zod';

/** Shared request-validation building blocks. Prefer strict objects so unknown fields are rejected. */
export const uuidSchema = z.uuid();

export const idParamsSchema = z.strictObject({ id: uuidSchema });

export const paginationQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export interface PageWindow {
  readonly skip: number;
  readonly take: number;
}

export const toPageWindow = (query: { page: number; pageSize: number }): PageWindow => ({
  skip: (query.page - 1) * query.pageSize,
  take: query.pageSize,
});

export interface PageMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export const pageMeta = (query: { page: number; pageSize: number }, total: number): PageMeta => ({
  page: query.page,
  pageSize: query.pageSize,
  total,
  totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
});
