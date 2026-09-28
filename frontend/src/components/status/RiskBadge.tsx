import { StatusBadge } from '@/components/status/StatusBadge';
import { RISK, type RiskLevel } from '@/design/risk';

interface RiskBadgeProps {
  level: RiskLevel;
  /** Override the default label, e.g. "High risk" or "Expiry risk". The icon still encodes the level. */
  label?: string;
  className?: string;
}

/** Risk chip: icon + text + colour — never colour alone. */
export function RiskBadge({ level, label, className }: RiskBadgeProps) {
  const risk = RISK[level];
  return (
    <span data-risk={level} className="contents">
      <StatusBadge tone={risk.tone} icon={risk.icon} label={label ?? risk.label} className={className} />
    </span>
  );
}
