/** Mirrors the `recommendations.status` values approved in docs/DECISIONS.md (F). */
export type RecommendationStatus = 'PENDING' | 'APPROVED' | 'MODIFIED' | 'REJECTED' | 'EXPIRED' | 'EXECUTED';

export type RecommendationDecision = 'approve' | 'modify' | 'reject';
