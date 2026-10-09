'use client';

// What the Activity tab and the Accounts tab can change about transactions,
// kept here so the dashboard only mounts it: the quick-add form for a manual
// account (components/ManualTxnSheet.tsx), open on a new transaction or on one
// to edit, and the exclude flag on any transaction
// (app/api/transaction-annotations).

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react';
import type { Txn } from './MonthBreakdown';
import type { ManualTxnTarget } from './ManualTxnSheet';

export function useTransactionEdits({
  setTxns,
  loadTransactions,
  loadNetWorth,
  requestBackfill,
}: {
  setTxns: Dispatch<SetStateAction<Txn[] | null>>;
  loadTransactions: () => unknown;
  loadNetWorth: (force?: boolean) => Promise<unknown>;
  requestBackfill: (reload: () => void) => void;
}) {
  const [sheet, setSheet] = useState<ManualTxnTarget | null>(null);
  // Why the last exclude didn't save, shown on the Activity tab until the next
  // one does.
  const [error, setError] = useState<string | null>(null);

  /** The form on a new transaction, on `account_id` when it is opened from an
   *  account's card. */
  const openAdd = useCallback((account_id: string | null = null) => setSheet({ mode: 'add', account_id }), []);
  const openEdit = useCallback((txn: Txn) => setSheet({ mode: 'edit', txn }), []);
  const closeSheet = useCallback(() => setSheet(null), []);

  /** After a save: the transactions again (the server dropped its cached
   *  copy), and when the balance moved too, net worth as after the account's
   *  Update form: a forced load records today's balance in the real history,
   *  then the estimate the save marked stale is rebuilt. */
  const onSaved = useCallback(
    async ({ balanceChanged }: { balanceChanged: boolean }) => {
      loadTransactions();
      if (balanceChanged) {
        await loadNetWorth(true);
        requestBackfill(() => loadNetWorth());
      }
    },
    [loadTransactions, loadNetWorth, requestBackfill]
  );

  /** Leaves a transaction out of budgets and reports, or puts it back: shown at
   *  once, so every total follows (lib/spending.ts). A save that fails reloads
   *  the transactions, so a flag that wasn't saved never stays on screen, and
   *  says why. */
  const toggleExcluded = useCallback(
    async (t: Txn, excluded: boolean) => {
      setError(null);
      setTxns((prev) =>
        prev ? prev.map((x) => (x.transaction_id === t.transaction_id ? { ...x, excluded: excluded ? true : undefined } : x)) : prev
      );
      try {
        const res = await fetch('/api/transaction-annotations', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction_id: t.transaction_id, excluded }),
        });
        if (res.ok) return;
        const data = await res.json().catch(() => null);
        setError(data?.error ?? 'Could not save that. Please try again.');
      } catch {
        setError('Could not reach the server.');
      }
      loadTransactions();
    },
    [setTxns, loadTransactions]
  );

  return { sheet, openAdd, openEdit, closeSheet, onSaved, toggleExcluded, error };
}
