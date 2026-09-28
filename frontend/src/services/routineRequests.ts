import { apiGet, apiPost, query } from './api';
import type { Page } from './inventory';
import type { EmergencyRequest } from './emergency';

/** Same request/DTO shape as an emergency request (`type: 'ROUTINE'` is what distinguishes it). */
export type RoutineRequest = EmergencyRequest;

export const listRoutineRequests = (params: { facilityId?: string; status?: string; page?: number; pageSize?: number } = {}) =>
  apiGet<Page<RoutineRequest>>(`/requests${query(params)}`);

export const getRoutineRequest = (id: string) => apiGet<{ data: RoutineRequest }>(`/requests/${id}`);

export const createRoutineRequest = (input: {
  facilityId: string;
  bloodGroupId: number;
  componentId: number;
  quantity: number;
  urgency: 'CRITICAL' | 'HIGH' | 'NORMAL';
  requiredBy: string;
  allowCompatibleSubstitutes?: boolean;
}) => apiPost<{ data: RoutineRequest }>('/requests', input);
