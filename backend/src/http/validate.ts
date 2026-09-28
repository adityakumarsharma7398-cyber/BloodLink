import type { Request, RequestHandler } from 'express';
import { ZodError, z, type ZodType } from 'zod';
import { HttpError } from '../utils/httpError.js';

export interface RequestSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

type Output<S extends RequestSchemas, K extends keyof RequestSchemas> = S[K] extends ZodType ? z.output<S[K]> : undefined;

/**
 * Validates body / query / params with Zod. Parsed (typed, coerced) values are stored on `req.valid`
 * because Express 5 makes `req.query` read-only. On failure the client gets a 400 naming the source
 * and the offending fields — never the submitted values.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    try {
      const valid: NonNullable<Request['valid']> = { ...req.valid };
      for (const source of ['params', 'query', 'body'] as const) {
        const schema = schemas[source];
        if (!schema) continue;
        try {
          valid[source] = schema.parse(source === 'body' ? (req.body ?? {}) : req[source]);
        } catch (error) {
          if (error instanceof ZodError) {
            throw new HttpError(400, 'Invalid request', 'VALIDATION_ERROR', { source, ...z.flattenError(error) });
          }
          throw error;
        }
      }
      req.valid = valid;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/** Typed accessor for what `validate(schemas)` produced. */
export function validated<S extends RequestSchemas>(req: Request, _schemas?: S) {
  return (req.valid ?? {}) as { body: Output<S, 'body'>; query: Output<S, 'query'>; params: Output<S, 'params'> };
}
