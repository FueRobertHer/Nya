'use client';

// The review queue on the Activity tab, while it is on (lib/review-store.ts):
// how many transactions need review, counted as transactions (a split one
// once, each of a group's on its own: lib/review-layer.ts countToReview), as
// a heading, a way into Card Mode (components/CardMode.tsx), and approving
// everything listed that needs it, with how many and an undo. Its filter is
// the list's To review chip (components/MonthBreakdown.tsx, one more filter
// beside the search and the tag: components/txn-search.ts), which the N key
// turns on and off from here. On a desktop, single keys do the same
// (components/review-keys.ts): never with Ctrl, Alt or the Command key, never
// while typing, never while a sheet or Card Mode is open; they can be turned
// off in their help (components/activity-keys.ts, WCAG 2.1.4), and Shift+A
// asks before it approves everything listed.

import { useEffect, useRef, useState } from 'react';
import type { Txn } from './MonthBreakdown';
import type { ApprovalTicket, ReviewControls } from './review-state';
import { countToReview } from '@/lib/review-layer';
import { bankRows } from '@/lib/split-rows';
import { activityKey, ACTIVITY_KEYS, type ActivityKey } from './review-keys';
import { setActivityKeys, useActivityKeys } from './activity-keys';
import { toReviewWords } from './review-text';

/** The whole transactions among listed rows that need review: a split one
 *  once, whole, and each of a group's on its own (lib/split-rows.ts bankRows). */
export function listedToReview(rows: readonly Txn[]): Txn[] {
  return bankRows(rows, { groups: 'members' }).filter((t) => t.needs_review === true);
}

/** What a key on the Activity tab does, given the bar now: nothing while its
 *  keys are off; Card Mode only with something to review; and approving what
 *  is listed only ever asks first (`confirm`), never approves at once. */
export function barAction(
  k: ActivityKey,
  s: { keysOn: boolean; total: number; waiting: number; filtering: boolean }
): 'help' | 'filter-on' | 'filter-off' | 'review' | 'confirm' | 'undo' | null {
  if (!s.keysOn) return null;
  if (k === 'help') return 'help';
  if (k === 'filter') return s.filtering ? 'filter-off' : 'filter-on';
  if (k === 'review') return s.total > 0 ? 'review' : null;
  if (k === 'approve-listed') return s.waiting > 0 ? 'confirm' : null;
  return 'undo';
}

/** The Activity tab's keys, in words, with the switch that turns them off. */
export function ActivityKeysHelp({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="review-keys">
      <dl>
        {ACTIVITY_KEYS.map(([keys, does]) => (
          <div key={keys}>
            <dt>{keys}</dt>
            <dd>{does}</dd>
          </div>
        ))}
      </dl>
      <label className="review-keys-switch">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
        Use these keys on this device
      </label>
    </div>
  );
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
  /** The To review chip's state, for the N key, which turns it on and off. */
  filtering: boolean;
  onFilter: (on: boolean) => void;
  /** Opens Card Mode. */
  onReview: () => void;
}) {
  const [undoable, setUndoable] = useState<{ ticket: ApprovalTicket; n: number } | null>(null);
  const [help, setHelp] = useState(false);
  // The keys, on until this device says otherwise: one value for the page,
  // which the Review queue card's switch shows too (components/activity-keys.ts).
  const keysOn = useActivityKeys();
  // Shift+A asks first: everything listed is approved only once confirmed.
  const [confirming, setConfirming] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  // Once the question is answered, or the listed approved by the button,
  // those buttons go, so focus moves to the count at once (never left to fall
  // to the page), then to Undo when the approval is saved.
  const countRef = useRef<HTMLHeadingElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const [focusUndo, setFocusUndo] = useState(false);
  useEffect(() => {
    if (!focusUndo || !undoable) return;
    undoRef.current?.focus();
    setFocusUndo(false);
  }, [focusUndo, undoable]);
  const total = countToReview(all);
  const waiting = listedToReview(listed);

  const approveListed = async () => {
    setConfirming(false);
    countRef.current?.focus();
    if (waiting.length === 0) return;
    const ticket = await review.approve(waiting);
    if (ticket) {
      setUndoable({ ticket, n: ticket.items.length });
      setFocusUndo(true);
    }
  };
  const cancelConfirm = () => {
    setConfirming(false);
    countRef.current?.focus();
  };
  const undo = async () => {
    if (!undoable) return;
    const u = undoable;
    setUndoable(null);
    await review.undo(u.ticket);
  };

  // The shortcuts, read through a ref so the listener isn't added again each render.
  const on = !!review.view?.on;
  const act = useRef({ on, keysOn, undo, onReview, onFilter, filtering, total, waiting: waiting.length });
  act.current = { on, keysOn, undo, onReview, onFilter, filtering, total, waiting: waiting.length };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only while the queue is on and its keys are, and not while a sheet or
      // Card Mode is open: their keys are theirs.
      if (!act.current.on || document.querySelector('[aria-modal="true"]')) return;
      const k = activityKey(e);
      const a = act.current;
      const does = k ? barAction(k, a) : null;
      if (!does) return;
      e.preventDefault();
      if (does === 'help') setHelp((h) => !h);
      else if (does === 'filter-on' || does === 'filter-off') a.onFilter(does === 'filter-on');
      else if (does === 'review') a.onReview();
      else if (does === 'confirm') setConfirming(true);
      else void a.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!on) return null;
  return (
    <div className="review-bar">
      <div className="review-bar-row">
        {/* Where focus comes back to when Card Mode closes and its way in is
            gone (nothing left to review). */}
        {/* Also where Home's "Transactions to review" lands (components/NeedsAttention.tsx). */}
        <h3 className="review-count" aria-live="polite" tabIndex={-1} data-review-return="" ref={countRef} id="review-count">
          {toReviewWords(total)}
        </h3>
        <button className="btn secondary" onClick={onReview} disabled={total === 0}>
          Review one at a time
        </button>
      </div>
      {confirming && waiting.length > 0 ? (
        <div
          className="review-bar-row"
          role="group"
          aria-label="Approve what is listed"
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancelConfirm();
          }}
        >
          <span className="panel-note">{waiting.length === 1 ? 'Approve the 1 transaction listed?' : `Approve the ${waiting.length} transactions listed?`}</span>
          <button className="btn" ref={confirmRef} onClick={() => void approveListed()}>
            Approve
          </button>
          <button className="btn secondary" onClick={cancelConfirm}>
            Cancel
          </button>
        </div>
      ) : (
        waiting.length > 0 && (
          <div className="review-bar-row">
            <button className="btn" onClick={() => void approveListed()}>{waiting.length === 1 ? 'Approve the 1 listed' : `Approve the ${waiting.length} listed`}</button>
          </div>
        )
      )}
      {undoable && (
        <div className="review-bar-row" role="status">
          <span className="panel-note">{undoable.n === 1 ? 'Approved 1 transaction.' : `Approved ${undoable.n} transactions.`}</span>
          <button className="btn secondary" ref={undoRef} onClick={() => void undo()}>
            Undo
          </button>
        </div>
      )}
      {review.error && <div className="error">{review.error}</div>}
      <button className="review-keys-toggle" aria-expanded={help} onClick={() => setHelp((h) => !h)}>
        Keyboard shortcuts
      </button>
      {help && <ActivityKeysHelp on={keysOn} onChange={setActivityKeys} />}
    </div>
  );
}
