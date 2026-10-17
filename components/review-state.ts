'use client';

// The review queue in the app (lib/review-store.ts, app/api/review): whether
// it is on, approving what the Activity tab shows (one, what is listed, or a
// card at a time in Card Mode), undoing that, and Card Mode's recategorize,
// which gives the transaction a category of the person's (app/api/recategorize,
// which counts it toward the merchant's default) and approves it as it is
// then. Kept here so the dashboard only mounts it.
//
// A change shows at once: an approved transaction leaves the queue before the
// server answers (withApproved), and the list is read again quietly once a
// run of changes settles, or at once when one fails, which puts the list back
// as the server has it and says why. What is approved is the transaction as
// the page showed it (lib/review-layer.ts approvalInputOf): if the bank
// changed it meanwhile, the next read puts it back in the queue, saying so.

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { Txn } from './MonthBreakdown';
import { approvalInputOf, MAX_PER_REQUEST } from '@/lib/review-layer';
import type { Approval } from '@/lib/review-store';
import type { VendorEntry } from '@/lib/vendor-defaults';
import { approvalViaOf, merchantOf, recategorizedRow } from './transaction-edits';
import { localDate } from '@/lib/local-date';
import type { Taxonomy } from '@/lib/categories';

/** The queue as /api/transactions sends it: on from a day or off, whether
 *  its settings couldn't be read, and how many approvals of the rows read
 *  couldn't be (`unknown`). */
export type ReviewView = { on: boolean; since: string | null; unread: boolean; unknown: number };

export function reviewViewOf(v: unknown): ReviewView | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.on !== 'boolean' || typeof r.unread !== 'boolean' || !(r.since === null || typeof r.since === 'string')) return null;
  return { on: r.on, since: r.since, unread: r.unread, unknown: typeof r.unknown === 'number' && r.unknown > 0 ? r.unknown : 0 };
}

/** What undoes an approval request: each transaction, when it was approved,
 *  and what it had before (app/api/review undo). */
export type ApprovalTicket = { items: { transaction_id: string; approved_at: string; previous: Approval | null }[] };

/** What undoes Card Mode's recategorize: the approval, the category it had
 *  (the words chosen for it before, or none), and the merchant's
 *  categorizations as they were. */
export type CardUndo = {
  transaction_id: string;
  account_id?: string;
  ticket: ApprovalTicket | null;
  previous?: { category: string | null };
  vendor?: { entry: VendorEntry; previous: VendorEntry | null };
};

/** A row, and each of a group's transactions inside one, through `fn`. */
function mapRows(txns: Txn[], fn: (t: Txn) => Txn): Txn[] {
  return txns.map((t) => {
    const next = fn(t);
    return next.group_members ? { ...next, group_members: next.group_members.map(fn) } : next;
  });
}

/** The list with these transactions approved at `at`, as the next read will
 *  show them: out of the queue, a split one's parts with it. */
export function withApproved(txns: Txn[], ids: ReadonlySet<string>, at: string): Txn[] {
  return mapRows(txns, (t) =>
    ids.has(t.transaction_id) || (t.split_of !== undefined && ids.has(t.split_of))
      ? { ...t, needs_review: undefined, review_changed: undefined, review_unknown: undefined, reviewed_at: at }
      : t
  );
}

/** The list with an approval undone: a transaction that had none before
 *  needs review again, one that had one is approved as it was. */
export function withUndone(txns: Txn[], ticket: ApprovalTicket): Txn[] {
  const before = new Map(ticket.items.map((i) => [i.transaction_id, i.previous]));
  return mapRows(txns, (t) => {
    const id = before.has(t.transaction_id) ? t.transaction_id : t.split_of !== undefined && before.has(t.split_of) ? t.split_of : null;
    if (id === null) return t;
    const previous = before.get(id)!;
    return previous ? { ...t, reviewed_at: previous.approved_at } : { ...t, needs_review: true, reviewed_at: undefined };
  });
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** The server's words for a refusal, else `fallback`. */
async function refusal(res: Response | null, fallback: string): Promise<string> {
  if (!res) return 'Could not reach the server.';
  const data = await res.json().catch(() => null);
  return typeof data?.error === 'string' ? data.error : fallback;
}

export function useReview({
  setTxns,
  refresh,
  reload,
}: {
  setTxns: Dispatch<SetStateAction<Txn[] | null>>;
  /** Reads the list again without a spinner (components/transaction-edits.ts). */
  refresh: () => unknown;
  /** Reads it again, with the queue's new marks (after turning it on or off). */
  reload: () => unknown;
}) {
  const [view, setView] = useState<ReviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** The queue as each transactions load sends it. */
  const accept = useCallback((v: unknown) => setView(reviewViewOf(v)), []);

  /** Turns the queue on, from `since` (today when null), or off. */
  const turn = useCallback(
    async (on: boolean, since: string | null = null): Promise<boolean> => {
      setError(null);
      setSaving(true);
      try {
        const res = await post('/api/review', on ? { action: 'start', today: localDate(), ...(since ? { since } : {}) } : { action: 'stop' }).catch(() => null);
        if (!res?.ok) {
          setError(await refusal(res, 'Could not change the review queue. Please try again.'));
          return false;
        }
        const data = await res.json().catch(() => null);
        setView((v) => ({ on: !!data?.review?.on, since: data?.review?.since ?? null, unread: false, unknown: v?.unknown ?? 0 }));
        reload();
        return true;
      } finally {
        setSaving(false);
      }
    },
    [reload]
  );

  /**
   * Approves these transactions, each whole as the list shows it (a split one
   * put back whole, each of a group's on its own: lib/split-rows.ts
   * bankRows), in requests of MAX_PER_REQUEST: shown at once, and answered
   * with what undoes it, or null when nothing was approved. A request that
   * fails stops the rest, says why, and reads the list again.
   */
  const approve = useCallback(
    async (rows: readonly Txn[]): Promise<ApprovalTicket | null> => {
      if (rows.length === 0) return null;
      setError(null);
      const at = new Date().toISOString();
      setTxns((prev) => (prev ? withApproved(prev, new Set(rows.map((r) => r.transaction_id)), at) : prev));
      const ticket: ApprovalTicket = { items: [] };
      for (let i = 0; i < rows.length; i += MAX_PER_REQUEST) {
        const batch = rows.slice(i, i + MAX_PER_REQUEST);
        const res = await post('/api/review', { action: 'approve', items: batch.map(approvalInputOf) }).catch(() => null);
        const data = res?.ok ? await res.json().catch(() => null) : null;
        if (!data || !Array.isArray(data.previous)) {
          const why = await refusal(res, 'Could not approve them. Please try again.');
          setError(ticket.items.length > 0 ? `${why} ${ticket.items.length} of ${rows.length} were approved.` : why);
          refresh();
          return ticket.items.length > 0 ? ticket : null;
        }
        for (const p of data.previous) ticket.items.push({ transaction_id: p.transaction_id, approved_at: data.approved_at, previous: p.previous ?? null });
      }
      return ticket;
    },
    [setTxns, refresh]
  );

  /** Undoes an approval request: shown at once, then read again. */
  const undo = useCallback(
    async (ticket: ApprovalTicket): Promise<boolean> => {
      setError(null);
      setTxns((prev) => (prev ? withUndone(prev, ticket) : prev));
      let ok = true;
      for (let i = 0; i < ticket.items.length; i += MAX_PER_REQUEST) {
        const res = await post('/api/review', { action: 'undo', items: ticket.items.slice(i, i + MAX_PER_REQUEST) }).catch(() => null);
        if (!res?.ok) {
          setError(await refusal(res, 'Could not undo that. Please try again.'));
          ok = false;
          break;
        }
      }
      refresh();
      return ok;
    },
    [setTxns, refresh]
  );

  /** One approved transaction back in the queue, from its detail: its
   *  approval, wherever it is kept (review_via), taken away. */
  const unapprove = useCallback(
    (t: Txn) => (t.reviewed_at ? undo({ items: [{ transaction_id: t.review_via ?? t.transaction_id, approved_at: t.reviewed_at, previous: null }] }) : Promise.resolve(false)),
    [undo]
  );

  /**
   * Card Mode's recategorize: a category of the person's for the transaction
   * (counted toward the merchant's default), and then it is approved as it
   * is filed now. Answers what undoes both, or null when the category
   * couldn't be saved (nothing was approved then).
   */
  const recategorizeAndApprove = useCallback(
    async (t: Txn, category_id: string, taxonomy: Taxonomy | null): Promise<CardUndo | null> => {
      setError(null);
      const shown = recategorizedRow(t, { category_id }, taxonomy);
      setTxns((prev) => (prev ? mapRows(prev, (x) => (x.transaction_id === t.transaction_id ? { ...x, ...shown, review_suggestion: undefined, filed_by_default: undefined } : x)) : prev));
      const account = t.source && t.account_id ? { account_id: t.account_id } : {};
      const res = await post('/api/recategorize', { transaction_id: t.transaction_id, category_id, ...account, ...merchantOf(t), ...approvalViaOf(t) }).catch(() => null);
      const data = res?.ok ? await res.json().catch(() => null) : null;
      if (!data) {
        setError(await refusal(res, 'Could not change the category. Please try again.'));
        refresh();
        return null;
      }
      const ticket = await approve([{ ...t, ...shown }]);
      return {
        transaction_id: t.transaction_id,
        ...account,
        ticket,
        ...(data.previous ? { previous: data.previous } : {}),
        ...(data.vendor ? { vendor: { entry: data.vendor.entry, previous: data.vendor.previous ?? null } } : {}),
      };
    },
    [setTxns, refresh, approve]
  );

  /** Undoes Card Mode's recategorize: the approval, the category it had, and
   *  the merchant's categorizations. Answers whether all of it went back. */
  const undoRecategorize = useCallback(
    async (u: CardUndo): Promise<boolean> => {
      let ok = u.ticket ? await undo(u.ticket) : true;
      if (u.previous) {
        const res = await post('/api/recategorize', { transaction_id: u.transaction_id, ...(u.account_id ? { account_id: u.account_id } : {}), restore: u.previous }).catch(() => null);
        if (!res?.ok) {
          setError(await refusal(res, 'Could not put its category back.'));
          ok = false;
        }
      } else {
        setError('Its category couldn’t be put back: what it was before couldn’t be read. Choose it again from its detail.');
        ok = false;
      }
      if (u.vendor) {
        // The merchant's categorizations go back only as they were left: one
        // made since (another device) keeps them, which is said.
        const res = await post('/api/vendor-defaults', { action: 'restore', after: u.vendor.entry, previous: u.vendor.previous }).catch(() => null);
        const data = res?.ok ? await res.json().catch(() => null) : null;
        if (data?.restored !== true) {
          setError(
            data
              ? 'The merchant’s categorizations weren’t put back: another came since. Its default, if it has one, is under Manage, Defaults.'
              : await refusal(res, 'Could not put the merchant’s categorizations back.')
          );
          ok = false;
        }
      }
      refresh();
      return ok;
    },
    [undo, refresh]
  );

  return { view, accept, turn, approve, undo, unapprove, recategorizeAndApprove, undoRecategorize, error, setError, saving, refresh };
}

export type ReviewControls = ReturnType<typeof useReview>;
