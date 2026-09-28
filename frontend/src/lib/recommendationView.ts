import type { DataPoint } from '@/components/data/DataList';
import type { RiskLevel } from '@/design/risk';
import type { Recommendation } from '@/services/intelligence';

export const PRIORITY_TO_RISK: Record<Recommendation['priority'], RiskLevel> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'healthy',
};

const LABEL = (key: string) =>
  key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** Turns the backend's `explanation.data` object (already the exact figures a recommendation was computed from) into DataList rows. */
export function dataPointsFrom(data: Record<string, unknown>): DataPoint[] {
  return Object.entries(data)
    .filter(([, value]) => value !== null && typeof value !== 'object')
    .map(([label, value]) => ({ label: LABEL(label), value: String(value) }));
}

const TITLE: Record<Recommendation['type'], string> = {
  PROCUREMENT: 'Procurement',
  REDISTRIBUTION: 'Redistribution',
  DONOR_ACTIVATION: 'Donor activation',
  EMERGENCY_SOURCE: 'Emergency source',
};

export const recommendationTypeLabel = (type: Recommendation['type']) => TITLE[type];
