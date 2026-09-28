import type { RequestHandler } from 'express';
import { sendData, sendPage } from '../http/respond.js';
import { approveBodySchema, rejectBodySchema, transferParamsSchema, transfersQuerySchema } from '../http/transferSchemas.js';
import { validated } from '../http/validate.js';
import type { TransferService } from '../services/transferService.js';

export function createTransferController(service: TransferService) {
  const list: RequestHandler = async (req, res) => {
    const { query } = validated(req, { query: transfersQuerySchema });
    const result = await service.list(req.auth!, query);
    sendPage(res, result.data, result.pagination);
  };
  const get: RequestHandler = async (req, res) => {
    const { params } = validated(req, { params: transferParamsSchema });
    sendData(res, await service.get(req.auth!, params.id));
  };
  const approve: RequestHandler = async (req, res) => {
    const { params, body } = validated(req, { params: transferParamsSchema, body: approveBodySchema });
    sendData(res, await service.approve(req.auth!, req.context, params.id, body.approvedQuantity));
  };
  const reject: RequestHandler = async (req, res) => {
    const { params, body } = validated(req, { params: transferParamsSchema, body: rejectBodySchema });
    sendData(res, await service.reject(req.auth!, req.context, params.id, body.reasonCode, body.note));
  };
  return { list, get, approve, reject };
}
