import type { RequestHandler } from 'express';
import { activationsQuerySchema, idParamsSchema, recipientParamsSchema, respondBodySchema } from '../http/donorActivationSchemas.js';
import { runBodySchema } from '../http/intelligenceSchemas.js';
import { sendData, sendPage } from '../http/respond.js';
import { validated } from '../http/validate.js';
import type { DonorActivationService } from '../services/donorActivationService.js';

export function createDonorActivationController(service: DonorActivationService) {
  const run: RequestHandler = async (req, res) => {
    const { body } = validated(req, { body: runBodySchema });
    sendData(res, await service.run(req.auth!, req.context, body.facilityId), 201);
  };
  const list: RequestHandler = async (req, res) => {
    const { query } = validated(req, { query: activationsQuerySchema });
    const result = await service.list(req.auth!, query);
    sendPage(res, result.data, result.pagination);
  };
  const get: RequestHandler = async (req, res) => {
    const { params } = validated(req, { params: idParamsSchema });
    sendData(res, await service.get(req.auth!, params.id));
  };
  const notify: RequestHandler = async (req, res) => {
    const { params } = validated(req, { params: idParamsSchema });
    sendData(res, await service.notify(req.auth!, req.context, params.id));
  };
  const cancel: RequestHandler = async (req, res) => {
    const { params } = validated(req, { params: idParamsSchema });
    sendData(res, await service.cancel(req.auth!, req.context, params.id));
  };
  const mine: RequestHandler = async (req, res) => {
    sendData(res, await service.mine(req.auth!));
  };
  const respond: RequestHandler = async (req, res) => {
    const { params, body } = validated(req, { params: recipientParamsSchema, body: respondBodySchema });
    sendData(res, await service.respond(req.auth!, req.context, params.recipientId, body.response));
  };
  return { run, list, get, notify, cancel, mine, respond };
}
