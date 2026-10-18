'use client';

// What the Activity tab and the Accounts tab can change about transactions,
// kept here so the dashboard only mounts it: the quick-add form for a manual
// account (components/ManualTxnSheet.tsx), open on a new transaction or on one
// to edit, the category of any transaction (app/api/recategorize), and the
// exclude flag, the tags and the note on any transaction
// (app/api/transaction-annotations).
//
// A change shows at once. A saved row comes back from the server as the list
// shows it and goes straight in (no spinner, nothing waits on Plaid: the
// server's cache of Plaid's rows stays), and the list is then read again
// quietly in the background, kept only if nothing else changed meanwhile. A
// change that fails puts the list back as the server has it, and says why.

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Txn } from './MonthBreakdown';
import type { ManualTxnTarget } from './ManualTxnSheet';
import type { Incomplete } from '@/lib/month-coverage';
import { noTransactionsView, type NoTransactionsView } from '@/lib/no-transactions';
import { unreadNotesOf } from '@/lib/fire/inputs';
import { categoryById, choiceText, groupOf, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import type { Tag } from '@/lib/tags';
import type { TagChange } from './TxnTagsNote';
import { isVendorKey, MAX_VENDOR_NAME } from '@/lib/vendor-defaults';
import { localDate } from '@/lib/local-date';

/** A category chosen for a transaction: one of the person's, by id, or, with
 *  no categories loaded, words (as before categories had ids). */
export type CategoryChoice = { category_id: string } | { category: string };

/**
 * What a row shows at once when a category is chosen for it, as it will be
 * filed: the category's id, name and kind, and the words it is stored as
 * (lib/categories.ts). One side of a pair Nya worked out between two SimpleFIN
 * accounts (`paired`) is a pair no more once it has a category of the
 * person's: its mark goes, with the detail the pair gave it, and its other
 * side is read again from the server (lib/manual-txns.ts).
 */
export function recategorizedRow(t: Pick<Txn, 'paired'> | undefined, choice: CategoryChoice, taxonomy: Taxonomy | null): Partial<Txn> {
  let shown: Partial<Txn> = 'category' in choice ? { category: choice.category, category_id: undefined, category_name: choice.category, category_kind: undefined } : {};
  if ('category_id' in choice && taxonomy) {
    const ix = indexTaxonomy(taxonomy);
    const c = categoryById(ix, choice.category_id);
    if (c) shown = { category: choiceText(c), category_id: c.id, category_name: c.name, category_kind: groupOf(ix, c).kind };
  }
  // The person's own now: a rule's category no longer shows (category_by_rule),
  // so the row's edit form starts from it (components/ManualTxnSheet.tsx); nor
  // does a merchant's default, nor a category offered an approved row
  // (lib/review-layer.ts), which the person's own always beats.
  const own = { ...shown, category_by_rule: undefined, filed_by_default: undefined, review_suggestion: undefined };
  return t?.paired ? { ...own, paired: undefined, subcategory: null } : own;
}

/** What a recategorization says of the merchant, for its default
 *  (lib/vendor-defaults.ts, app/api/recategorize): its vendor key and its
 *  name as shown, when the row has a merchant (a bank's row, or one imported
 *  into a linked account), and today, the day a new default files from. */
export function merchantOf(t: Pick<Txn, 'vendor_key' | 'name'> | undefined): { vendor_key?: string; name?: string; today?: string } {
  if (!t || !isVendorKey(t.vendor_key)) return {};
  return { vendor_key: t.vendor_key, name: t.name.slice(0, MAX_VENDOR_NAME), today: localDate() };
}

/** Where the approval a row holds is kept when it isn't under the row's own
 *  id (`review_via`: the pending transaction it replaced, or the row imported
 *  from a file it stands for), so the category chosen is the one it holds. */
export function approvalViaOf(t: Pick<Txn, 'review_via'> | undefined): { review_via?: string } {
  return t?.review_via ? { review_via: t.review_via } : {};
}

/** Newest first, as /api/transactions orders them; the sort is stable. */
function newestFirst(a: Txn, b: Txn): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const at = a.datetime ?? '';
  const bt = b.datetime ?? '';
  return at < bt ? 1 : at > bt ? -1 : 0;
}

/**
 * A manual row as the form's save answered it, shown until the list is read
 * again: the answer is the row as stored, without what the read layer puts on
 * it (lib/txn-layers.ts), so that is kept from the row it replaces: its tags,
 * the rules that match it, its exclusion, and a rule's category or name where
 * the save left the row without one of its own.
 */
export function withLayersOf(saved: Txn, prev: Txn): Txn {
  const row: Txn = { ...saved, excluded: prev.excluded, excluded_by_rule: prev.excluded_by_rule, tags: prev.tags, rule_ids: prev.rule_ids };
  if (prev.category_by_rule && (saved.category ?? null) === null) {
    Object.assign(row, {
      category: prev.category,
      category_id: prev.category_id,
      category_name: prev.category_name,
      category_kind: prev.category_kind,
      category_by_rule: true,
    });
  }
  if (prev.name_before_rules !== undefined && saved.name === prev.name_before_rules) {
    row.name = prev.name;
    row.name_before_rules = prev.name_before_rules;
  }
  for (const k of ['excluded', 'excluded_by_rule', 'tags', 'rule_ids'] as const) if (row[k] === undefined) delete row[k];
  return row;
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
  setTxnAside,
  setTxnUnread,
  setTxnIncomplete,
  setTxnWithout,
  loadTransactions,
  loadNetWorth,
  requestBackfill,
  taxonomy = null,
  onTagMade,
}: {
  txns: Txn[] | null;
  setTxns: Dispatch<SetStateAction<Txn[] | null>>;
  setTxnNotes: Dispatch<SetStateAction<string[]>>;
  /** What only the list says, beside the notes (the answer's `aside_notes`). */
  setTxnAside?: Dispatch<SetStateAction<string[]>>;
  /** Of the notes, those that say transactions couldn't all be read (the
   *  answer's `unread_notes`, lib/fire/inputs.ts unreadNotesOf). */
  setTxnUnread?: Dispatch<SetStateAction<string[]>>;
  /** The institutions whose rows aren't all in the list (/api/transactions). */
  setTxnIncomplete: Dispatch<SetStateAction<Incomplete[]>>;
  /** The connections that bring in no transactions, as the same answer says
   *  (lib/no-transactions.ts). */
  setTxnWithout?: (view: NoTransactionsView) => void;
  loadTransactions: () => unknown;
  loadNetWorth: (force?: boolean) => Promise<unknown>;
  requestBackfill: (reload: () => void) => void;
  /** The person's categories, for a choice to show at once as it will be
   *  filed (components/categories-state.ts). */
  taxonomy?: Taxonomy | null;
  /** A tag made on a transaction as it was typed, for the list of tags
   *  (components/tags-state.ts). */
  onTagMade?: (tag: Tag) => void;
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
      setTxnAside?.(Array.isArray(data.aside_notes) ? data.aside_notes : []);
      setTxnUnread?.(unreadNotesOf(data));
      setTxnIncomplete(Array.isArray(data.incomplete) ? data.incomplete : []);
      setTxnWithout?.(noTransactionsView(data));
    } catch {
      // The list shown is the server's answer to the save; the next load reads it again.
    }
  }, [setTxns, setTxnNotes, setTxnAside, setTxnUnread, setTxnIncomplete, setTxnWithout]);

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
          // What the read layer put on the row is the list's: the form's
          // answer doesn't carry it (withLayersOf).
          const row = i >= 0 ? withLayersOf(transaction, prev[i]) : transaction;
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
   *  only that book). Shown at once as it will be filed: the category's id,
   *  name and kind, and the words it is stored as (lib/categories.ts). */
  const recategorize = useCallback(
    async (transaction_id: string, choice: CategoryChoice) => {
      setError(null);
      changes.current++;
      const t = current.current?.find((x) => x.transaction_id === transaction_id);
      const shown = recategorizedRow(t, choice, taxonomy);
      setTxns((prev) => (prev ? prev.map((x) => (x.transaction_id === transaction_id ? { ...x, ...shown } : x)) : prev));
      let res: Response | null = null;
      try {
        res = await fetch('/api/recategorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // With its merchant, a category chosen by id counts toward the merchant's default.
          body: JSON.stringify({
            transaction_id,
            ...choice,
            ...(t?.source && t.account_id ? { account_id: t.account_id } : {}),
            ...('category_id' in choice ? { ...merchantOf(t), ...approvalViaOf(t) } : {}),
          }),
        });
        if (res.ok) {
          // Its other side, a pair no more, as the server now shows it.
          if (t?.paired) void refreshQuietly();
          return;
        }
      } catch {
        res = null;
      }
      await undo(res, 'Could not change the category. Please try again.');
    },
    [setTxns, undo, taxonomy, refreshQuietly]
  );

  /** Leaves a transaction out of budgets and reports, or puts it back: shown at
   *  once, so every total follows (lib/spending.ts). */
  const toggleExcluded = useCallback(
    async (t: Txn, excluded: boolean) => {
      setError(null);
      changes.current++;
      // The person's choice now decides, over a rule's hide either way; on a
      // split transaction, every part (one left out on its own stays out).
      setTxns((prev) =>
        prev
          ? prev.map((x) =>
              x.transaction_id === t.transaction_id
                ? { ...x, excluded: excluded ? true : undefined, excluded_by_rule: undefined }
                : x.split_of === t.transaction_id && x.split_parent
                  ? {
                      ...x,
                      excluded: excluded || x.split_excluded ? true : undefined,
                      excluded_by_rule: undefined,
                      split_parent: { ...x.split_parent, excluded: excluded ? true : undefined, excluded_by_rule: undefined },
                    }
                  : x
            )
          : prev
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

  /** What a change to a row's record sends: a manual row's account, so the
   *  server reads only that book when the note is the row's own. */
  const target = (t: Txn) => ({ transaction_id: t.transaction_id, ...(t.source && t.account_id ? { account_id: t.account_id } : {}) });

  /** Puts tags on a transaction or takes them off (by id), or one typed by
   *  name, made if no tag has it: shown at once, a new tag once the server
   *  has made it. */
  const changeTags = useCallback(
    async (t: Txn, change: TagChange) => {
      setError(null);
      changes.current++;
      const add = change.add ?? [];
      const remove = change.remove ?? [];
      setTxns((prev) =>
        prev
          ? prev.map((x) => {
              // A split transaction's parts carry its tags.
              if (x.transaction_id !== t.transaction_id && x.split_of !== t.transaction_id) return x;
              const tags = [...(x.tags ?? []).filter((id) => !remove.includes(id)), ...add.filter((id) => !(x.tags ?? []).includes(id))];
              return { ...x, tags: tags.length > 0 ? tags : undefined };
            })
          : prev
      );
      let res: Response | null = null;
      try {
        res = await fetch('/api/transaction-annotations', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...target(t),
            ...(add.length ? { add_tags: add } : {}),
            ...(remove.length ? { remove_tags: remove } : {}),
            ...(change.newTag ? { new_tag: change.newTag } : {}),
          }),
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          const made: Tag | undefined = data?.created_tag;
          // The tag typed: made now, or found under that name in any case.
          const put = change.newTag && Array.isArray(data?.tags) ? (data.tags as string[]).filter((id) => !add.includes(id)) : [];
          if (made) onTagMade?.(made);
          if (put.length > 0) {
            setTxns((prev) =>
              prev
                ? prev.map((x) =>
                    x.transaction_id === t.transaction_id || x.split_of === t.transaction_id ? { ...x, tags: [...new Set([...(x.tags ?? []), ...put])] } : x
                  )
                : prev
            );
          }
          return;
        }
      } catch {
        res = null;
      }
      await undo(res, 'Could not change its tags. Please try again.');
    },
    [setTxns, undo, onTagMade]
  );

  /** Saves a transaction's note, or clears it: one entered by hand or
   *  imported into a manual account, on the row itself; any other (a bank's,
   *  one SimpleFIN brought, one imported into a linked account), beside it.
   *  Shown at once. */
  const saveNote = useCallback(
    async (t: Txn, note: string) => {
      setError(null);
      changes.current++;
      // A split transaction's note is its own, kept beside its parts' (split_parent).
      setTxns((prev) =>
        prev
          ? prev.map((x) =>
              x.transaction_id === t.transaction_id
                ? { ...x, note: note || (x.source ? null : undefined) }
                : x.split_of === t.transaction_id && x.split_parent
                  ? { ...x, split_parent: { ...x.split_parent, note: note || (x.source ? null : undefined) } }
                  : x
            )
          : prev
      );
      let res: Response | null = null;
      try {
        res = await fetch('/api/transaction-annotations', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...target(t), note }),
        });
        if (res.ok) return;
      } catch {
        res = null;
      }
      await undo(res, 'Could not save the note. Please try again.');
    },
    [setTxns, undo]
  );

  return { sheet, openAdd, openEdit, closeSheet, onSaved, recategorize, toggleExcluded, changeTags, saveNote, error, refresh: refreshQuietly };
}
