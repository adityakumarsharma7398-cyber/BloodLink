import { useState } from 'react';
import { ConnectedRecommendationCard } from '@/components/ai/ConnectedRecommendationCard';
import { AppShell } from '@/components/layout/AppShell';
import { visibleNavItems } from '@/lib/roles';
import { PageHeader } from '@/components/layout/PageHeader';
import { StateBoundary } from '@/components/data/StateBoundary';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/lib/auth';
import { useResource } from '@/hooks/useResource';
import { getRecommendations, type RecommendationStatus, type RecommendationType } from '@/services/intelligence';

const STATUSES: RecommendationStatus[] = ['PENDING', 'APPROVED', 'MODIFIED', 'REJECTED', 'EXPIRED', 'EXECUTED'];
const TYPES: RecommendationType[] = ['PROCUREMENT', 'REDISTRIBUTION', 'DONOR_ACTIVATION', 'EMERGENCY_SOURCE'];

/** Every recommendation the caller's facilities have received, of any type, with the same decision flow. */
export function Recommendations() {
  const { me } = useAuth();
  const [status, setStatus] = useState<RecommendationStatus>('PENDING');
  const [type, setType] = useState<RecommendationType | 'ALL'>('ALL');

  const recommendations = useResource(
    () => getRecommendations({ status, type: type === 'ALL' ? undefined : type, pageSize: 50 }),
    [status, type],
    { isEmpty: (r) => r.data.length === 0 },
  );

  return (
    <AppShell activeId="recommendations" organization={me?.organization?.name ?? '—'} user={{ name: me?.user.fullName ?? '—', role: me?.roles[0]?.role ?? '—' }} navItems={visibleNavItems(me)}>
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <PageHeader
          title="Recommendations"
          description="Every recommendation states what it proposes, why, the figures behind it, and what approving does."
          actions={
            <div className="flex gap-2">
              <Select value={status} onValueChange={(v) => setStatus(v as RecommendationStatus)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={type} onValueChange={(v) => setType(v as RecommendationType | 'ALL')}>
                <SelectTrigger className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All types</SelectItem>
                  {TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t.replace('_', ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        />

        <StateBoundary state={recommendations} onRetry={recommendations.refetch}>
          {(page) => (
            <div className="flex flex-col gap-4">
              {page.data.map((rec) => (
                <ConnectedRecommendationCard key={rec.id} recommendation={rec} onDecided={recommendations.refetch} />
              ))}
            </div>
          )}
        </StateBoundary>
      </div>
    </AppShell>
  );
}
