import { apiGet, apiPost, query } from './api';
import type { Page } from './inventory';

export interface DonorActivation {
  id: string;
  facilityId: string;
  bloodGroup: string;
  component: string;
  unitsNeeded: number;
  targetDonorCount: number;
  urgency: 'CRITICAL' | 'HIGH' | 'NORMAL';
  radiusKm: number;
  donorMessage: string;
  status: 'ACTIVE' | 'FULFILLED' | 'CANCELLED' | 'EXPIRED';
  expiresAt: string;
  createdAt: string;
  recipients: {
    total: number;
    byResponse: { NO_RESPONSE: number; WILLING: number; DECLINED: number };
    byNotificationStatus: { PENDING: number; SENT: number; DELIVERED: number; FAILED: number };
  };
  /** Donor identity is present only for donors who have already responded WILLING (matches the database's own privacy rule). */
  willingDonors: { recipientId: string; distanceKm: number; respondedAt: string | null; donor: { id: string; fullName: string; phone: string | null; email: string | null } }[];
}

export const listDonorActivations = (params: { facilityId?: string; status?: string; page?: number; pageSize?: number } = {}) =>
  apiGet<Page<DonorActivation>>(`/donor-activations${query(params)}`);

export const getDonorActivation = (id: string) => apiGet<{ data: DonorActivation }>(`/donor-activations/${id}`);

export const runDonorActivation = (facilityId: string) => apiPost(`/donor-activations/runs`, { facilityId });

export const notifyDonorActivation = (id: string) => apiPost<{ data: { notified: number; delivered: number; failed: number } }>(`/donor-activations/${id}/notify`, {});

export const cancelDonorActivation = (id: string) => apiPost<{ data: DonorActivation }>(`/donor-activations/${id}/cancel`, {});
