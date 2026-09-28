import type { RequestHandler } from 'express';
import {
  confirmBodySchema, createRequestBodySchema, declineBodySchema, idParamsSchema, incomingQuerySchema, requestsQuerySchema, selectionDecisionBodySchema,
} from '../http/emergencySchemas.js';
import { sendData, sendPage } from '../http/respond.js';
import { validated } from '../http/validate.js';
import type { EmergencyService } from '../services/emergencyService.js';

export function createEmergencyController(service: EmergencyService) {
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
  const selectSources: RequestHandler = async (req, res) => {
    const { params } = validated(req, { params: idParamsSchema });
    sendData(res, await service.selectSources(req.auth!, req.context, params.id), 201);
  };
  const decide: RequestHandler = async (req, res) => {
    const { params, body } = validated(req, { params: idParamsSchema, body: selectionDecisionBodySchema });
    sendData(res, await service.decideSelection(req.auth!, req.context, params.id, body));
  };
  const incoming: RequestHandler = async (req, res) => {
    const { query } = validated(req, { query: incomingQuerySchema });
    sendData(res, await service.incoming(req.auth!, query));
  };
  const confirm: RequestHandler = async (req, res) => {
    const { body } = validated(req, { body: confirmBodySchema });
    sendData(res, await service.confirmHolds(req.auth!, req.context, body.allocationIds));
  };
  const decline: RequestHandler = async (req, res) => {
    const { body } = validated(req, { body: declineBodySchema });
    sendData(res, await service.declineHolds(req.auth!, req.context, body.allocationIds, body.note));
  };
  return { create, list, get, selectSources, decide, incoming, confirm, decline };
}
