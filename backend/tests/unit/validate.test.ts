import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { idParamsSchema, pageMeta, paginationQuerySchema, toPageWindow, uuidSchema } from '../../src/http/schemas.js';
import { requestContext } from '../../src/http/requestContext.js';
import { validate, validated } from '../../src/http/validate.js';
import { silentLogger } from '../../src/lib/logger.js';
import { createErrorHandler } from '../../src/middleware/errorHandler.js';

const schemas = {
  params: idParamsSchema,
  query: paginationQuerySchema,
  body: z.strictObject({ name: z.string().min(2).max(20), quantity: z.number().int().positive() }),
};

function app() {
  const server = express();
  server.use(requestContext);
  server.use(express.json());
  server.post('/things/:id', validate(schemas), (req, res) => {
    res.json(validated(req, schemas));
  });
  server.use(createErrorHandler(silentLogger));
  return server;
}

const ID = '3f6f9c3e-5b0a-4f6e-9d1a-0e6b1c2d3e4f';

describe('validate()', () => {
  it('parses params, query and body, applying coercion and defaults', async () => {
    const res = await request(app()).post(`/things/${ID}?page=2`).send({ name: 'Bag', quantity: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ params: { id: ID }, query: { page: 2, pageSize: 25 }, body: { name: 'Bag', quantity: 3 } });
  });

  it('rejects an invalid path id, naming the source', async () => {
    const res = await request(app()).post('/things/not-a-uuid').send({ name: 'Bag', quantity: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', details: { source: 'params' } });
    expect(res.body.error.details.fieldErrors).toHaveProperty('id');
  });

  it('rejects bad query values and out-of-range pagination', async () => {
    for (const query of ['page=0', 'page=abc', 'pageSize=101', 'pageSize=0', 'unknown=1']) {
      const res = await request(app()).post(`/things/${ID}?${query}`).send({ name: 'Bag', quantity: 3 });
      expect(res.status, query).toBe(400);
      expect(res.body.error.details.source).toBe('query');
    }
  });

  it('rejects wrong types, missing fields and unknown fields in the body without echoing values', async () => {
    for (const body of [{ name: 'B', quantity: 3 }, { name: 'Bag' }, { name: 'Bag', quantity: 'zz-SECRET' }, { name: 'Bag', quantity: 3, isAdmin: true }, {}]) {
      const res = await request(app()).post(`/things/${ID}`).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.details.source).toBe('body');
      expect(JSON.stringify(res.body)).not.toContain('zz-SECRET');
    }
  });
});

describe('shared schemas', () => {
  it('uuidSchema accepts UUIDs only', () => {
    expect(uuidSchema.safeParse(ID).success).toBe(true);
    for (const bad of ['', 'abc', '3f6f9c3e5b0a4f6e9d1a0e6b1c2d3e4f', `${ID}x`, 123, null]) expect(uuidSchema.safeParse(bad).success).toBe(false);
  });

  it('pagination helpers compute the window and metadata', () => {
    const query = paginationQuerySchema.parse({ page: '3', pageSize: '10' });
    expect(toPageWindow(query)).toEqual({ skip: 20, take: 10 });
    expect(pageMeta(query, 45)).toEqual({ page: 3, pageSize: 10, total: 45, totalPages: 5 });
    expect(pageMeta(query, 0).totalPages).toBe(1);
  });
});
