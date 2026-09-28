import type { RequestHandler } from 'express';
import { sendData } from '../http/respond.js';
import type { ReferenceService } from '../services/referenceService.js';

// Reference data changes rarely; let browsers and CDNs reuse it briefly.
const CACHE = 'public, max-age=300';

export function createReferenceController(service: ReferenceService) {
  const bloodGroups: RequestHandler = async (_req, res) => {
    const data = await service.listBloodGroups();
    res.setHeader('Cache-Control', CACHE);
    sendData(res, data);
  };
  const components: RequestHandler = async (_req, res) => {
    const data = await service.listComponents();
    res.setHeader('Cache-Control', CACHE);
    sendData(res, data);
  };
  return { bloodGroups, components };
}
