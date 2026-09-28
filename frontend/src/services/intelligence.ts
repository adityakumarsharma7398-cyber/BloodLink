import { apiGet, apiPost, query } from './api';
import type { Page } from './inventory';

export interface Prediction {
  id: string;
  facilityId: string;
  bloodGroup: string;
  component: string;
  type: 'DEMAND' | 'SHORTAGE';
  horizonDays: number;
  predictedDailyDemand: number | null;
  predictedQuantity: number | null;
  daysOfCover: number | null;
  predictedShortageDate: string | null;
  shortageRisk: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | null;
  generatedAt: string;
}

export type RecommendationType = 'PROCUREMENT' | 'REDISTRIBUTION' | 'DONOR_ACTIVATION' | 'EMERGENCY_SOURCE';
export type RecommendationStatus = 'PENDING' | 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'EXPIRED' | 'EXECUTED';

export interface Recommendation {
  id: string;
  type: RecommendationType;
  facilityId: string;
  relatedPredictionId: string | null;
  status: RecommendationStatus;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  payload: Record<string, unknown>;
  modifiedPayload: Record<string, unknown> | null;
  explanation: { what: string; why: string; data: Record<string, unknown>; action: string };
  source: string;
  validUntil: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export const getPredictions = (params: { facilityId?: string; predictionType?: 'DEMAND' | 'SHORTAGE'; page?: number; pageSize?: number } = {}) =>
  apiGet<Page<Prediction>>(`/intelligence/predictions${query(params)}`);

export const getRecommendations = (
  params: { facilityId?: string; status?: RecommendationStatus; type?: RecommendationType; page?: number; pageSize?: number } = {},
) => apiGet<Page<Recommendation>>(`/intelligence/recommendations${query(params)}`);

export const runDemandForecast = (facilityId: string) => apiPost(`/intelligence/runs`, { facilityId });
export const runRedistribution = (facilityId: string) => apiPost(`/intelligence/redistribution/runs`, { facilityId });

/** Shared by procurement, redistribution and donor-activation recommendations. */
export const decideRecommendation = (
  id: string,
  input: { decision: 'APPROVE' | 'MODIFY' | 'REJECT'; modifiedQuantity?: number; note?: string },
) => apiPost<{ data: Recommendation & { transferId?: string | null; donorActivationId?: string | null } }>(`/intelligence/recommendations/${id}/decision`, input);
