import { apiGet, apiPost } from './api';

export interface MyDonorActivation {
  recipientId: string;
  distanceKm: number;
  notificationStatus: 'PENDING' | 'SENT' | 'DELIVERED' | 'FAILED';
  response: 'NO_RESPONSE' | 'WILLING' | 'DECLINED';
  respondedAt: string | null;
  activation: {
    id: string;
    status: 'ACTIVE' | 'FULFILLED' | 'CANCELLED' | 'EXPIRED';
    urgency: 'CRITICAL' | 'HIGH' | 'NORMAL';
    bloodGroup: string;
    component: string;
    donorMessage: string;
    expiresAt: string;
  };
}

/** The signed-in donor's own activation invitations — never another donor's (enforced server-side by their own donor profile). */
export const getMyDonorActivations = () => apiGet<{ data: MyDonorActivation[] }>('/donor-activations/mine');

export const respondToDonorActivation = (recipientId: string, response: 'WILLING' | 'DECLINED') =>
  apiPost<{ data: { recipientId: string; response: string; respondedAt: string } }>(`/donor-activations/recipients/${recipientId}/respond`, { response });
