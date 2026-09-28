import type { ErrorRequestHandler, RequestHandler } from 'express';
import { mapError } from '../http/errorMapper.js';
import type { Logger } from '../lib/logger.js';
import { HttpError } from '../utils/httpError.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, 'Route not found', 'NOT_FOUND'));
};

/**
 * The single place where errors become responses. Express 5 forwards rejected promises from async
 * handlers here. Response bodies contain only the mapped, safe fields plus the request id; the full
 * error (scrubbed of secrets) goes to the server log.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, _next) => {
    const mapped = mapError(error);
    const requestId = req.context?.correlationId;
    const fields = { requestId, status: mapped.status, code: mapped.code, method: req.method, userId: req.auth?.userId };

    if (mapped.serverFault) logger.error('request failed', { ...fields, error });
    else logger.debug('request rejected', fields);

    if (res.headersSent) {
      res.end();
      return;
    }
    if (mapped.headers) for (const [name, value] of Object.entries(mapped.headers)) res.setHeader(name, value);
    res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, details: mapped.details, requestId },
    });
  };
}
