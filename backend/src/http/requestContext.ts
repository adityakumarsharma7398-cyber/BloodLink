import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { normalizeIp } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { HttpError } from '../utils/httpError.js';

/** Must be the first middleware: everything after it (logging, errors, audit) relies on req.context. */
export const requestContext: RequestHandler = (req, res, next) => {
  const correlationId = randomUUID();
  req.context = { correlationId, ip: normalizeIp(req.ip), startedAt: process.hrtime.bigint() };
  res.setHeader('X-Request-Id', correlationId);
  next();
};

/** One structured line per request. Never logs headers, query strings, bodies or tokens. */
export function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - req.context.startedAt) / 1e6;
      const path = req.originalUrl.split('?')[0];
      const quiet = path === '/api/health' || path === '/api/health/ready';
      (quiet ? logger.debug : logger.info).call(logger, 'request', {
        requestId: req.context.correlationId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        ip: req.context.ip,
        userId: req.auth?.userId,
      });
    });
    next();
  };
}

/**
 * Answers 503 if a handler has not responded in time. It cannot cancel work already started
 * (e.g. a running database statement — those have their own timeouts), but it frees the client.
 */
export function requestTimeout(timeoutMs: number): RequestHandler {
  return (_req, res, next) => {
    const timer = setTimeout(() => {
      if (res.headersSent) return;
      const error = new HttpError(503, 'The request took too long', 'REQUEST_TIMEOUT');
      res.status(error.status).json({ error: { code: error.code, message: error.message, requestId: res.getHeader('X-Request-Id') } });
    }, timeoutMs);
    timer.unref();
    res.on('close', () => clearTimeout(timer));
    next();
  };
}
