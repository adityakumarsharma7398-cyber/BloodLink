import type { AiServiceClient } from './aiServiceClient.js';

export interface DailyConsumptionPoint {
  date: string;
  unitsIssued: number;
}

export interface DemandForecast {
  dailyDemand: number;
  predictedQuantity: number;
  confidenceScore: number;
  confidenceMethod: string;
  modelName: string;
  modelVersion: string;
  historyDaysUsed: number;
}

interface DemandForecastResponseBody {
  predicted_daily_demand: unknown;
  predicted_quantity: unknown;
  confidence_score: unknown;
  confidence_method: unknown;
  model_name: unknown;
  model_version: unknown;
  history_days_used: unknown;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Validates the AI service's response shape; a malformed body is treated the same as an unreachable service. */
function parse(body: DemandForecastResponseBody): DemandForecast | null {
  if (
    !isFiniteNumber(body.predicted_daily_demand) ||
    !isFiniteNumber(body.predicted_quantity) ||
    !isFiniteNumber(body.confidence_score) ||
    typeof body.confidence_method !== 'string' ||
    typeof body.model_name !== 'string' ||
    typeof body.model_version !== 'string' ||
    !isFiniteNumber(body.history_days_used) ||
    body.predicted_daily_demand < 0 ||
    body.confidence_score < 0 ||
    body.confidence_score > 1
  ) {
    return null;
  }
  return {
    dailyDemand: body.predicted_daily_demand,
    predictedQuantity: body.predicted_quantity,
    confidenceScore: body.confidence_score,
    confidenceMethod: body.confidence_method,
    modelName: body.model_name,
    modelVersion: body.model_version,
    historyDaysUsed: body.history_days_used,
  };
}

/**
 * Calls the AI service's demand-forecasting model with the facility's own ledger history. Returns
 * `null` on ANY failure — unreachable service, a non-2xx response, a timeout, or a malformed body —
 * so the caller always has a safe, well-defined fallback: the existing trailing-average baseline.
 * Never throws.
 */
export async function forecastDemand(
  client: AiServiceClient,
  input: { facilityId: string; bloodGroupCode: string; componentCode: string; horizonDays: number; history: readonly DailyConsumptionPoint[] },
): Promise<DemandForecast | null> {
  try {
    const body = await client.call<DemandForecastResponseBody>('/predict/demand', {
      method: 'POST',
      timeoutMs: 5_000,
      body: {
        facility_id: input.facilityId,
        blood_group_code: input.bloodGroupCode,
        component_code: input.componentCode,
        horizon_days: input.horizonDays,
        history: input.history.map((day) => ({ date: day.date, units_issued: day.unitsIssued })),
      },
    });
    return parse(body);
  } catch {
    return null;
  }
}
