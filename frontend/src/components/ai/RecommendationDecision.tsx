import { useState } from 'react';
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { RecommendationDecision as Decision } from '@/types/ai';

export interface DecisionInput {
  decision: 'APPROVE' | 'MODIFY' | 'REJECT';
  modifiedQuantity?: number;
  note?: string;
}

/**
 * Collects what MODIFY (a lower quantity) and REJECT (a reason) need before calling the backend
 * decision endpoint — approve needs nothing extra and is sent immediately. Reused by the dashboard
 * and recommendations feed so every recommendation type (procurement, redistribution, donor
 * activation) decides the same way.
 */
export function useRecommendationDecision(onDecide: (input: DecisionInput) => Promise<void>) {
  const [dialogFor, setDialogFor] = useState<{ decision: 'MODIFY' | 'REJECT'; suggestedQuantity: number | null } | null>(null);
  const [pending, setPending] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (input: DecisionInput, uiDecision: Decision) => {
    setPending(uiDecision);
    setError(null);
    try {
      await onDecide(input);
      setDialogFor(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the decision');
    } finally {
      setPending(null);
    }
  };

  const onDecision = (decision: Decision, suggestedQuantity: number | null) => {
    if (decision === 'approve') void submit({ decision: 'APPROVE' }, 'approve');
    else setDialogFor({ decision: decision === 'modify' ? 'MODIFY' : 'REJECT', suggestedQuantity });
  };

  const dialog = dialogFor && (
    <DecisionDialog
      decision={dialogFor.decision}
      suggestedQuantity={dialogFor.suggestedQuantity}
      busy={pending !== null}
      error={error}
      onCancel={() => setDialogFor(null)}
      onSubmit={(quantity, note) =>
        submit(
          dialogFor.decision === 'MODIFY' ? { decision: 'MODIFY', modifiedQuantity: quantity!, note } : { decision: 'REJECT', note },
          dialogFor.decision === 'MODIFY' ? 'modify' : 'reject',
        )
      }
    />
  );

  return { onDecision, pending, dialog };
}

function DecisionDialog({
  decision,
  suggestedQuantity,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  decision: 'MODIFY' | 'REJECT';
  suggestedQuantity: number | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (quantity: number | null, note: string) => void;
}) {
  const [quantity, setQuantity] = useState(suggestedQuantity ?? 1);
  const [note, setNote] = useState('');

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{decision === 'MODIFY' ? 'Modify and approve' : 'Reject recommendation'}</DialogTitle>
          <DialogDescription>
            {decision === 'MODIFY'
              ? 'Lower the quantity if only part of it should go ahead. This never raises the recommended amount.'
              : 'A short reason is kept with this decision.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {decision === 'MODIFY' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="decision-quantity">Quantity</Label>
              <Input
                id="decision-quantity"
                type="number"
                min={1}
                max={suggestedQuantity ?? undefined}
                value={quantity}
                onChange={(event) => setQuantity(Number(event.target.value))}
              />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="decision-note">Note{decision === 'REJECT' ? ' (required)' : ''}</Label>
            <Input id="decision-note" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why?" />
          </div>
          {error && <p className="text-status-critical text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            disabled={busy || note.trim().length === 0 || (decision === 'MODIFY' && (!quantity || quantity < 1))}
            onClick={() => onSubmit(decision === 'MODIFY' ? quantity : null, note.trim())}
          >
            {busy ? 'Saving…' : decision === 'MODIFY' ? 'Approve modified' : 'Reject'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
