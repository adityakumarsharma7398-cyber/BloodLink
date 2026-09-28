import { apiGet, query } from './api';

export interface InventorySummaryRow {
  facility: { id: string; name: string };
  bloodGroup: { id: number; code: string };
  component: { id: number; code: string };
  quantities: {
    onHand: number;
    available: number;
    reserved: number;
    pendingAcceptance: number;
    inTransit: number;
    expiringSoon: number | null;
    expiredNotYetMarked: number;
    nearestExpiry: string | null;
  };
  shortage:
    | { status: 'SHORTAGE'; riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM'; daysOfCover: number }
    | { status: 'HEALTHY'; riskLevel: 'LOW'; daysOfCover: number }
    | { status: 'UNKNOWN'; riskLevel: null; daysOfCover: null; reason: string };
  expiry:
    | { status: 'AT_RISK' | 'OK'; warningDays: number; expiringUnits: number }
    | { status: 'UNKNOWN'; warningDays: null; expiringUnits: null; reason: string };
}

export interface InventoryUnit {
  id: string;
  unitCode: string;
  bloodGroup: { id: number; code: string };
  component: { id: number; code: string };
  status: string;
  expiryDate: string;
  isExpired: boolean;
  statusChangedAt: string;
  receivedAt: string;
}

export interface Page<T> {
  data: T[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export const getInventorySummary = (facilityId?: string) =>
  apiGet<{ data: InventorySummaryRow[] }>(`/inventory/summary${query({ facilityId })}`);

export const getInventoryUnits = (facilityId: string, params: { page?: number; pageSize?: number; status?: string } = {}) =>
  apiGet<Page<InventoryUnit>>(`/inventory/units${query({ facilityId, ...params })}`);
