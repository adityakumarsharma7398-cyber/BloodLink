import type { RequestHandler } from 'express';
import { createRequestBodySchema, idParamsSchema, requestsQuerySchema } from '../http/emergencySchemas.js';
import { sendData, sendPage } from '../http/respond.js';
import { validated } from '../http/validate.js';
import type { RoutineRequestService } from '../services/routineRequestService.js';

export function createRoutineRequestController(service: RoutineRequestService) {
  const create: RequestHandler = async (req, res) => {
    const { body } = validated(req, { body: createRequestBodySchema });
    sendData(res, await service.createRequest(req.auth!, req.context, body), 201);
  };
  const list: RequestHandler = async (req, res) => {
    const { query } = validated(req, { query: requestsQuerySchema });
    const result = await service.listRequests(req.auth!, query);
    sendPage(res, result.data, result.pagination);
  };
  const get: RequestHandler = async (req, res) => {
    const { params } = validated(req, { params: idParamsSchema });
    sendData(res, await service.getRequest(req.auth!, params.id));
  };
  return { create, list, get };
}
