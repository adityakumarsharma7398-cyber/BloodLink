import { describe, expect, it } from 'vitest';
import { forecastDemand } from '../../src/services/ai/demandForecastClient.js';
import type { AiServiceClient } from '../../src/services/ai/aiServiceClient.js';

const VALID_BODY = {
  predicted_daily_demand: 4.2,
  predicted_quantity: 58.8,
  confidence_score: 0.81,
  confidence_method: 'linear_trend_r_squared',
  model_name: 'demand-forecast-linear-trend',
  model_version: '1',
  history_days_used: 30,
};

const clientReturning = (body: unknown): AiServiceClient => ({ call: async <T>() => body as T });
const clientThrowing = (error: unknown): AiServiceClient => ({
  call: async () => {
    throw error;
  },
});

const input = { facilityId: 'f1', bloodGroupCode: 'O-', componentCode: 'PRBC', horizonDays: 14, history: [{ date: '2026-09-01', unitsIssued: 3 }] };

describe('forecastDemand', () => {
  it('returns the parsed forecast on a valid response', async () => {
    const result = await forecastDemand(clientReturning(VALID_BODY), input);
    expect(result).toEqual({
      dailyDemand: 4.2, predictedQuantity: 58.8, confidenceScore: 0.81, confidenceMethod: 'linear_trend_r_squared',
      modelName: 'demand-forecast-linear-trend', modelVersion: '1', historyDaysUsed: 30,
    });
  });

  it('sends the facility, product codes, horizon and the given ledger history — never patient or donor data', async () => {
    let sentPath = '';
    let sentBody: unknown;
    const client: AiServiceClient = {
      call: async <T>(path: string, init?: { body?: unknown }) => {
        sentPath = path;
        sentBody = init?.body;
        return VALID_BODY as T;
      },
    };
    await forecastDemand(client, input);
    expect(sentPath).toBe('/predict/demand');
    expect(sentBody).toEqual({
      facility_id: 'f1', blood_group_code: 'O-', component_code: 'PRBC', horizon_days: 14,
      history: [{ date: '2026-09-01', units_issued: 3 }],
    });
  });

  it('falls back to null (the caller uses the trailing-average baseline) when the service is unreachable or errors', async () => {
    expect(await forecastDemand(clientThrowing(new Error('ECONNREFUSED')), input)).toBeNull();
    expect(await forecastDemand(clientThrowing({ status: 503 }), input)).toBeNull();
  });

  it.each([
    ['a negative daily demand', { ...VALID_BODY, predicted_daily_demand: -1 }],
    ['a non-numeric daily demand', { ...VALID_BODY, predicted_daily_demand: 'a lot' }],
    ['a confidence score above 1', { ...VALID_BODY, confidence_score: 1.5 }],
    ['a confidence score below 0', { ...VALID_BODY, confidence_score: -0.1 }],
    ['a missing model name', { ...VALID_BODY, model_name: undefined }],
    ['a missing confidence method', { ...VALID_BODY, confidence_method: undefined }],
    ['a non-finite quantity', { ...VALID_BODY, predicted_quantity: Number.POSITIVE_INFINITY }],
  ])('treats %s the same as an unreachable service (null, never thrown)', async (_label, body) => {
    expect(await forecastDemand(clientReturning(body), input)).toBeNull();
  });

  it('never throws, even when the client itself throws something unusual', async () => {
    await expect(forecastDemand(clientThrowing('a plain string'), input)).resolves.toBeNull();
    await expect(forecastDemand(clientThrowing(undefined), input)).resolves.toBeNull();
  });
});
