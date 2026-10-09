'use client';

// What the Activity tab and the Accounts tab can change about transactions,
// kept here so the dashboard only mounts it: the quick-add form for a manual
// account (components/ManualTxnSheet.tsx), open on a new transaction or on one
// to edit, the category of any transaction (app/api/recategorize), and the
// exclude flag on any transaction (app/api/transaction-annotations).
//
// A change shows at once. A saved row comes back from the server as the list
// shows it and goes straight in (no spinner, nothing waits on Plaid: the
// server's cache of Plaid's rows stays), and the list is then read again
// quietly in the background, kept only if nothing else changed meanwhile. A
// change that fails puts the list back as the server has it, and says why.

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Txn } from './MonthBreakdown';
import type { ManualTxnTarget } from './ManualTxnSheet';

/** Newest first, as /api/transactions orders them; the sort is stable. */
function newestFirst(a: Txn, b: Txn): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const at = a.datetime ?? '';
  const bt = b.datetime ?? '';
  return at < bt ? 1 : at > bt ? -1 : 0;
}

/** What a save or delete in the quick-add form did. */
export type TxnSaved = {
  /** The balance moved too. */
  balanceChanged: boolean;
  /** The row as saved, as the list shows it. */
  transaction?: Txn;
  /** The id of a row deleted. */
  removed?: string;
};

export function useTransactionEdits({
  txns,
  setTxns,
  setTxnNotes,
  loadTransactions,
  loadNetWorth,
  requestBackfill,
}: {
  txns: Txn[] | null;
  setTxns: Dispatch<SetStateAction<Txn[] | null>>;
  setTxnNotes: Dispatch<SetStateAction<string[]>>;
  loadTransactions: () => unknown;
  loadNetWorth: (force?: boolean) => Promise<unknown>;
  requestBackfill: (reload: () => void) => void;
}) {
  const [sheet, setSheet] = useState<ManualTxnTarget | null>(null);
  // Why the last change didn't save, shown on the Activity tab until the next
  // one does.
  const [error, setError] = useState<string | null>(null);
  // Counts every change made here, so a background read that started before
  // one isn't kept over it.
  const changes = useRef(0);
  // The list as last rendered, for the account a manual row is on.
  const current = useRef(txns);
  useEffect(() => {
    current.current = txns;
  }, [txns]);

  /** The form on a new transaction, on `account_id` when it is opened from an
   *  account's card. */
  const openAdd = useCallback((account_id: string | null = null) => setSheet({ mode: 'add', account_id }), []);
  const openEdit = useCallback((txn: Txn) => setSheet({ mode: 'edit', txn }), []);
  const closeSheet = useCallback(() => setSheet(null), []);

  /** The list read again without a spinner, kept only if nothing changed here
   *  meanwhile (else the newer change, already shown, stands). */
  const refreshQuietly = useCallback(async () => {
    const at = changes.current;
    try {
      const res = await fetch('/api/transactions');
      if (!res.ok) return;
      const data = await res.json();
      if (changes.current !== at || !Array.isArray(data?.transactions)) return;
      setTxns(data.transactions);
      setTxnNotes(Array.isArray(data.notes) ? data.notes : []);
    } catch {
      // The list shown is the server's answer to the save; the next load reads it again.
    }
  }, [setTxns, setTxnNotes]);

  /** After a save or delete: the row in the list, or out of it, at once, and
   *  when the balance moved too, net worth as after the account's Update form:
   *  a forced load records today's balance in the real history, then the
   *  estimate the save marked stale is rebuilt. */
  const onSaved = useCallback(
    async ({ balanceChanged, transaction, removed }: TxnSaved) => {
      changes.current++;
      if (transaction) {
        setTxns((prev) => {
          if (!prev) return prev;
          const i = prev.findIndex((x) => x.transaction_id === transaction.transaction_id);
          // What was said about the row (its exclusion) is the list's: the
          // form's answer doesn't carry it.
          const row = i >= 0 ? { ...transaction, excluded: prev[i].excluded } : transaction;
          const next = i >= 0 ? prev.map((x, j) => (j === i ? row : x)) : [...prev, row];
          return next.sort(newestFirst);
        });
      }
      if (removed) setTxns((prev) => (prev ? prev.filter((x) => x.transaction_id !== removed) : prev));
      if (!transaction && !removed) loadTransactions();
      else void refreshQuietly();
      if (balanceChanged) {
        await loadNetWorth(true);
        requestBackfill(() => loadNetWorth());
      }
    },
    [setTxns, loadTransactions, refreshQuietly, loadNetWorth, requestBackfill]
  );

  /** A change shown at once that the server refused or never got: the list as
   *  the server has it, and why. */
  const undo = useCallback(
    async (res: Response | null, fallback: string) => {
      const data = res ? await res.json().catch(() => null) : null;
      setError(res ? (data?.error ?? fallback) : 'Could not reach the server.');
      loadTransactions();
    },
    [loadTransactions]
  );

  /** A new category for one transaction: Plaid's is overridden, a manual
   *  row's is changed on the row (sent with its account, so the server reads
   *  only that book). */
  const recategorize = useCallback(
    async (transaction_id: string, category: string) => {
      setError(null);
      changes.current++;
      const t = current.current?.find((x) => x.transaction_id === transaction_id);
      setTxns((prev) => (prev ? prev.map((x) => (x.transaction_id === transaction_id ? { ...x, category } : x)) : prev));
      let res: Response | null = null;
      try {
        res = await fetch('/api/recategorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction_id, category, ...(t?.source && t.account_id ? { account_id: t.account_id } : {}) }),
        });
        if (res.ok) return;
      } catch {
        res = null;
      }
      await undo(res, 'Could not change the category. Please try again.');
    },
    [setTxns, undo]
  );

  /** Leaves a transaction out of budgets and reports, or puts it back: shown at
   *  once, so every total follows (lib/spending.ts). */
  const toggleExcluded = useCallback(
    async (t: Txn, excluded: boolean) => {
      setError(null);
      changes.current++;
      setTxns((prev) =>
        prev ? prev.map((x) => (x.transaction_id === t.transaction_id ? { ...x, excluded: excluded ? true : undefined } : x)) : prev
      );
      let res: Response | null = null;
      try {
        res = await fetch('/api/transaction-annotations', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction_id: t.transaction_id, excluded }),
        });
        if (res.ok) return;
      } catch {
        res = null;
      }
      await undo(res, 'Could not save that. Please try again.');
    },
    [setTxns, undo]
  );

  return { sheet, openAdd, openEdit, closeSheet, onSaved, recategorize, toggleExcluded, error };
}
