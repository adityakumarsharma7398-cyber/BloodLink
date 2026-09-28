import { apiGet, apiPost, query } from './api';
import type { Page } from './inventory';

export interface EmergencyRequestItem {
  id: string;
  bloodGroup: string;
  component: string;
  quantityRequested: number;
  quantityFulfilled: number;
  quantityRemaining: number;
  allowCompatibleSubstitutes: boolean;
  holds: { source: { id: string; name: string }; status: string; quantity: number; holdExpiresAt: string | null }[];
}

export interface EmergencyRequest {
  id: string;
  requestNumber: string;
  /** Distinguishes this request from a routine one — same underlying table, same DTO shape. */
  type: 'EMERGENCY' | 'ROUTINE';
  urgency: 'CRITICAL' | 'HIGH' | 'NORMAL';
  requiredBy: string;
  status: string;
  verification: { status: string; method: string | null; verifiedAt: string | null };
  facility: { id: string; name: string };
  createdAt: string;
  items: EmergencyRequestItem[];
  sourceSelection: { recommendationId: string; validUntil: string; priority: string; payload: unknown } | null;
}

export interface RankedSource {
  facility_id: string;
  facility_name: string;
  can_fulfil: boolean;
  spare_units_above_reserve: number;
  distance_km: number;
  eta_minutes: number | null;
  rank: number | null;
  excluded_reason?: string;
}

export interface SourceSelectionResult {
  requestId: string;
  quantityNeeded: number;
  ranked: RankedSource[];
  recommendationId: string | null;
  validUntil: string | null;
  compatibility: { rulesFound: boolean; notice: string | null };
}

export interface IncomingHold {
  sourceFacility: { id: string; name: string };
  requestNumber: string;
  requestItemId: string;
  destinationFacility: { id: string; name: string };
  bloodGroup: string;
  component: string;
  quantity: number;
  urgency: string;
  requiredBy: string;
  status: string;
  holdExpiresAt: string | null;
  allocationIds: string[];
}

export const listEmergencyRequests = (params: { facilityId?: string; status?: string; page?: number; pageSize?: number } = {}) =>
  apiGet<Page<EmergencyRequest>>(`/emergency/requests${query(params)}`);

export const getEmergencyRequest = (id: string) => apiGet<{ data: EmergencyRequest }>(`/emergency/requests/${id}`);

export const createEmergencyRequest = (input: {
  facilityId: string;
  bloodGroupId: number;
  componentId: number;
  quantity: number;
  urgency: 'CRITICAL' | 'HIGH' | 'NORMAL';
  requiredBy: string;
  allowCompatibleSubstitutes?: boolean;
}) => apiPost<{ data: EmergencyRequest }>('/emergency/requests', input);

export const selectSources = (requestId: string) =>
  apiPost<{ data: SourceSelectionResult }>(`/emergency/requests/${requestId}/source-selection`, {});

export const decideSourceSelection = (
  recommendationId: string,
  input: { decision: 'APPROVE' | 'MODIFY' | 'REJECT'; sourceFacilityId?: string; modifiedQuantity?: number; note?: string },
) => apiPost<{ data: { decision: string; request: EmergencyRequest } }>(`/emergency/source-selections/${recommendationId}/decision`, input);

export const getIncomingHolds = (facilityId?: string) => apiGet<{ data: IncomingHold[] }>(`/emergency/incoming${query({ facilityId })}`);

export const confirmHolds = (allocationIds: string[]) => apiPost('/emergency/holds/confirm', { allocationIds });
export const declineHolds = (allocationIds: string[], note: string) => apiPost('/emergency/holds/decline', { allocationIds, note });
