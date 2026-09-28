import { CircleAlert, CircleCheck, OctagonAlert, TriangleAlert, type LucideIcon } from 'lucide-react';

/**
 * Risk scale presentation. Every level is shown as icon + text + colour — never colour alone.
 * The *thresholds* that assign a level (e.g. days of coverage) are AI-service logic,
 * documented for review in a later phase; this file only defines presentation.
 */
export type RiskLevel = 'critical' | 'high' | 'medium' | 'healthy';

export type StatusTone = 'critical' | 'warning' | 'ok' | 'neutral' | 'info';

export const TONE_CLASSES: Record<StatusTone, string> = {
  critical: 'bg-status-critical-bg text-status-critical',
  warning: 'bg-status-warning-bg text-status-warning',
  ok: 'bg-status-ok-bg text-status-ok',
  neutral: 'bg-status-neutral-bg text-status-neutral',
  info: 'bg-info-bg text-info',
};

export const TONE_TEXT: Record<StatusTone, string> = {
  critical: 'text-status-critical',
  warning: 'text-status-warning',
  ok: 'text-status-ok',
  neutral: 'text-status-neutral',
  info: 'text-info',
};

export interface RiskStyle {
  label: string;
  icon: LucideIcon;
  tone: StatusTone;
}

export const RISK: Record<RiskLevel, RiskStyle> = {
  critical: { label: 'Critical', icon: OctagonAlert, tone: 'critical' },
  high: { label: 'High', icon: TriangleAlert, tone: 'warning' },
  medium: { label: 'Medium', icon: CircleAlert, tone: 'neutral' },
  healthy: { label: 'Healthy', icon: CircleCheck, tone: 'ok' },
};

export const RISK_LEVELS = Object.keys(RISK) as RiskLevel[];
