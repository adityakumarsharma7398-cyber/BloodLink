import type { RequestHandler } from 'express';
import {
  decisionBodySchema, predictionsQuerySchema, recommendationParamsSchema, recommendationsQuerySchema, runBodySchema,
} from '../http/intelligenceSchemas.js';
import { sendData, sendPage } from '../http/respond.js';
import { validated } from '../http/validate.js';
import type { IntelligenceService } from '../services/intelligenceService.js';
import type { RedistributionService } from '../services/redistributionService.js';

export function createIntelligenceController(service: IntelligenceService, redistribution: RedistributionService) {
  const run: RequestHandler = async (req, res) => {
    const { body } = validated(req, { body: runBodySchema });
    sendData(res, await service.run(req.auth!, req.context, body.facilityId), 201);
  };
  const predictions: RequestHandler = async (req, res) => {
    const { query } = validated(req, { query: predictionsQuerySchema });
    const result = await service.listPredictions(req.auth!, query);
    sendPage(res, result.data, result.pagination);
  };
  const recommendations: RequestHandler = async (req, res) => {
    const { query } = validated(req, { query: recommendationsQuerySchema });
    const result = await service.listRecommendations(req.auth!, query);
    sendPage(res, result.data, result.pagination);
  };
  const decide: RequestHandler = async (req, res) => {
    const { params, body } = validated(req, { params: recommendationParamsSchema, body: decisionBodySchema });
    sendData(res, await service.decide(req.auth!, req.context, params.id, body));
  };
  const redistributionRun: RequestHandler = async (req, res) => {
    const { body } = validated(req, { body: runBodySchema });
    sendData(res, await redistribution.run(req.auth!, req.context, body.facilityId), 201);
  };
  return { run, redistributionRun, predictions, recommendations, decide };
}
