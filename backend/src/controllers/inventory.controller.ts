import type { RequestHandler } from 'express';
import { summaryQuerySchema, unitsQuerySchema } from '../http/inventorySchemas.js';
import { sendData, sendPage } from '../http/respond.js';
import { validated } from '../http/validate.js';
import type { InventoryService } from '../services/inventoryService.js';

/** Read-only inventory endpoints. Authorization is enforced by the route policy and the service. */
export function createInventoryController(service: InventoryService) {
  const summary: RequestHandler = async (req, res) => {
    const { query } = validated(req, { query: summaryQuerySchema });
    sendData(res, await service.summary(req.auth!, query));
  };
  const units: RequestHandler = async (req, res) => {
    const { query } = validated(req, { query: unitsQuerySchema });
    const result = await service.units(req.auth!, query);
    sendPage(res, result.data, result.pagination);
  };
  return { summary, units };
}
