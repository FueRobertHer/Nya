'use client';

// The review queue on the Activity tab, while it is on (lib/review-store.ts):
// how many transactions need review, counted as transactions (a split one
// once, each of a group's on its own: lib/review-layer.ts countToReview), a
// way into Card Mode (components/CardMode.tsx), the Needs review filter (one
// more filter of the list, beside the search and the tag filter:
// components/txn-search.ts), and approving everything listed that needs it,
// with how many and an undo. On a desktop, single keys do the same
// (components/review-keys.ts): never with Ctrl, Alt or the Command key, never
// while typing, never while a sheet or Card Mode is open.

import { useEffect, useRef, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import type { ApprovalTicket, ReviewControls } from './review-state';
import { countToReview } from '@/lib/review-layer';
import { bankRows } from '@/lib/split-rows';
import { activityKey, ACTIVITY_KEYS } from './review-keys';
import { toReviewWords } from './review-text';

/** The whole transactions among listed rows that need review: a split one
 *  once, whole, and each of a group's on its own (lib/split-rows.ts bankRows). */
export function listedToReview(rows: readonly Txn[]): Txn[] {
  return bankRows(rows, { groups: 'members' }).filter((t) => t.needs_review === true);
}

export default function ReviewBar({
  review,
  all,
  listed,
  filtering,
  onFilter,
  onReview,
}: {
  review: ReviewControls;
  /** Every row loaded, for the count. */
  all: readonly Txn[];
  /** The rows the list shows now (the month or the cash flow's pick, through
   *  the search and the filters): what "approve what's listed" approves. */
  listed: readonly Txn[];
  filtering: boolean;
  onFilter: (on: boolean) => void;
  /** Opens Card Mode. */
  onReview: () => void;
}) {
  const [undoable, setUndoable] = useState<{ ticket: ApprovalTicket; n: number } | null>(null);
  const [help, setHelp] = useState(false);
  const total = countToReview(all);
  const waiting = listedToReview(listed);

  const approveListed = async () => {
    if (waiting.length === 0) return;
    const ticket = await review.approve(waiting);
    if (ticket) setUndoable({ ticket, n: ticket.items.length });
  };
  const undo = async () => {
    if (!undoable) return;
    const u = undoable;
    setUndoable(null);
    await review.undo(u.ticket);
  };

  // The shortcuts, read through a ref so the listener isn't added again each render.
  const on = !!review.view?.on;
  const act = useRef({ on, approveListed, undo, onReview, onFilter, filtering, total });
  act.current = { on, approveListed, undo, onReview, onFilter, filtering, total };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only while the queue is on, and not while a sheet or Card Mode is
      // open: their keys are theirs.
      if (!act.current.on || document.querySelector('[aria-modal="true"]')) return;
      const k = activityKey(e);
      if (!k) return;
      e.preventDefault();
      const a = act.current;
      if (k === 'help') setHelp((h) => !h);
      else if (k === 'filter') a.onFilter(!a.filtering);
      else if (k === 'review' && a.total > 0) a.onReview();
      else if (k === 'approve-listed') void a.approveListed();
      else if (k === 'undo') void a.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!on) return null;
  return (
    <div className="review-bar">
      <div className="review-bar-row">
        <span className="review-count" aria-live="polite">
          {toReviewWords(total)}
        </span>
        <button className="secondary" onClick={onReview} disabled={total === 0}>
          Review one at a time
        </button>
        <button className="secondary" aria-pressed={filtering} onClick={() => onFilter(!filtering)}>
          Needs review
        </button>
      </div>
      {waiting.length > 0 && (
        <div className="review-bar-row">
          <button onClick={() => void approveListed()}>{waiting.length === 1 ? 'Approve the 1 listed' : `Approve the ${waiting.length} listed`}</button>
        </div>
      )}
      {undoable && (
        <div className="review-bar-row" role="status">
          <span className="panel-note">{undoable.n === 1 ? 'Approved 1 transaction.' : `Approved ${undoable.n} transactions.`}</span>
          <button className="secondary" onClick={() => void undo()}>
            Undo
          </button>
        </div>
      )}
      {review.error && <div className="error">{review.error}</div>}
      <button className="review-keys-toggle" aria-expanded={help} onClick={() => setHelp((h) => !h)}>
        Keyboard shortcuts
      </button>
      {help && (
        <dl className="review-keys">
          {ACTIVITY_KEYS.map(([keys, does]) => (
            <div key={keys}>
              <dt>{keys}</dt>
              <dd>{does}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
