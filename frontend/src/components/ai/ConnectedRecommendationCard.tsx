import { RecommendationCard } from '@/components/ai/RecommendationCard';
import { useRecommendationDecision } from '@/components/ai/RecommendationDecision';
import { dataPointsFrom, PRIORITY_TO_RISK, recommendationTypeLabel } from '@/lib/recommendationView';
import { decideRecommendation, type Recommendation } from '@/services/intelligence';

/** Renders one recommendation (of any type) with its WHAT/WHY/DATA/ACTION and wires approve/modify/reject to the backend. */
export function ConnectedRecommendationCard({ recommendation, onDecided }: { recommendation: Recommendation; onDecided: () => void }) {
  const quantity = typeof recommendation.payload.quantity === 'number' ? recommendation.payload.quantity : null;
  const { onDecision, pending, dialog } = useRecommendationDecision(async (input) => {
    await decideRecommendation(recommendation.id, input);
    onDecided();
  });

  return (
    <>
      <RecommendationCard
        title={recommendation.explanation.what}
        subtitle={recommendationTypeLabel(recommendation.type)}
        risk={PRIORITY_TO_RISK[recommendation.priority]}
        why={[recommendation.explanation.why]}
        data={dataPointsFrom(recommendation.explanation.data)}
        action={recommendation.explanation.action}
        status={recommendation.status}
        pendingDecision={pending}
        onDecision={(decision) => onDecision(decision, quantity)}
        decisionNote={recommendation.decidedAt ? `Decided ${new Date(recommendation.decidedAt).toLocaleString()}` : undefined}
      />
      {dialog}
    </>
  );
}
