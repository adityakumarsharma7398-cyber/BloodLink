import type { Response } from 'express';
import type { PageMeta } from './schemas.js';

/**
 * API conventions:
 *   success   → { data: <payload> }            (lists may add { pagination })
 *   failure   → { error: { code, message, details?, requestId } }
 * Health endpoints keep their plain, probe-friendly shapes.
 */
export const sendData = <T>(res: Response, data: T, status = 200) => res.status(status).json({ data });

export const sendPage = <T>(res: Response, data: T[], pagination: PageMeta) => res.status(200).json({ data, pagination });
