// lib/transactions.ts
//
// Per-Item transaction store backed by Plaid's cursor-based /transactions/sync.
//
// Each Item's sync cursor and its transactions are persisted in Redis
// (encrypted, like every other financial payload — see lib/crypto.ts). Every
// call resumes from the stored cursor and applies only the deltas Plaid
// returns, so after the one-time initial pull we transfer next to nothing.
//
// This replaces /transactions/get offset pagination, which could silently
// *skip* rows when the underlying data shifted between page requests (a large
// recurring transaction like rent was a classic casualty). Sync pages are
// internally consistent, and the reconciliation is idempotent — added/modified
// upsert by transaction_id, removed deletes by id — so a replayed page (after
// a failed persist) or a mid-pagination restart can't corrupt the set.
//
// The stored set is bounded to a rolling RETENTION window so it can't grow
// without limit as the Item ages: /transactions/sync only reports `removed`
// when a bank deletes a transaction, never when one simply ages out, so
// without a bound the set would grow forever. We retain everything Plaid gives
// us on the initial pull (RETENTION matches the Link days_requested) rather
// than the shorter window we display, so nothing fetched is thrown away —
// callers slice to the window they need at read time. Pruning is safe because
// the deltas are idempotent: if Plaid later modifies a pruned row we re-add it
// (and prune it again if still out of window), and a removal of one is a no-op.

import { TransactionsUpdateStatus, type Transaction } from 'plaid';
import { plaidClient } from './plaid';
import { encrypt, decrypt } from './crypto';
import { redis, k, type StoredItem } from './storage';

export type Txn = {
  transaction_id: string;
  date: string; // YYYY-MM-DD
  name: string;
  amount: number; // Plaid convention: positive = money leaving the account
  pending: boolean;
  account_name: string;
  institution_name: string;
  category: string | null;
};

// Persisted form keeps account_id so display names can be re-resolved from the
// merged name map at read time (an account name can arrive on a later page
// than a transaction that references it).
export type StoredTxn = Txn & { account_id: string };

type ItemState = {
  cursor: string; // '' = never synced → pull full history
  accountNames: Record<string, string>; // account_id → display name, merged over time
  txns: Record<string, StoredTxn>; // keyed by transaction_id
};

// Trailing window callers display / reconstruct by default.
export const LOOKBACK_DAYS = 365;
// How much history we retain in the store. Matches the Link token's
// `transactions.days_requested` (app/api/create-link-token) so the full
// initial pull is kept, and bounds lifetime growth to a rolling ~2 years.
const RETENTION_DAYS = 730;
// Runaway guard for a single call: 50 * 500 = 25k updates. The initial pull of
// a very large Item can exceed this; we persist progress and finish on the
// next call (see the partial-history note).
const MAX_PAGES = 50;
const MAX_MUTATION_RETRIES = 3;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function stateKey(item_id: string): string {
  return k(`txns:${item_id}`);
}

function emptyState(): ItemState {
  return { cursor: '', accountNames: {}, txns: {} };
}

async function readState(item_id: string): Promise<ItemState> {
  try {
    const blob = await redis().get<string>(stateKey(item_id));
    if (!blob) return emptyState();
    const parsed = JSON.parse(await decrypt(blob)) as Partial<ItemState>;
    return {
      cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '',
      accountNames: parsed.accountNames ?? {},
      txns: parsed.txns ?? {},
    };
  } catch {
    // Rotated key / corrupted value: start clean and re-sync from scratch.
    return emptyState();
  }
}

async function writeState(item_id: string, state: ItemState): Promise<void> {
  try {
    await redis().set(stateKey(item_id), await encrypt(JSON.stringify(state)));
  } catch (err) {
    // Persist failures are non-fatal for the current request (the in-memory
    // state is still returned), and the deltas are idempotent so the next call
    // resumes safely. But a *persistent* failure — e.g. the blob outgrowing
    // Upstash's max value size — silently degrades into re-pulling the item's
    // full history from Plaid on every sync, so log it rather than swallow it.
    console.warn(
      `transactions: failed to persist sync state for ${item_id} (${Object.keys(state.txns).length} txns); will re-sync next call`,
      err
    );
  }
}

/** Delete an Item's stored transactions. Call when the Item is disconnected. */
export async function clearItemTransactions(item_id: string): Promise<void> {
  try {
    await redis().del(stateKey(item_id));
  } catch {
    // Best effort; a stale key is harmless once the Item is gone.
  }
}

function toStored(
  t: Transaction,
  accountNames: Record<string, string>,
  institution_name: string
): StoredTxn {
  return {
    transaction_id: t.transaction_id,
    date: t.date,
    name: t.merchant_name || t.name,
    amount: t.amount,
    pending: t.pending,
    account_id: t.account_id,
    account_name: accountNames[t.account_id] || '',
    institution_name,
    category: t.personal_finance_category?.primary?.replace(/_/g, ' ').toLowerCase() ?? null,
  };
}

/**
 * Sync one Item from Plaid and persist the reconciled set + cursor. Returns the
 * full retained `state` (callers slice to the window they need), plus a `note`
 * when something is off. `state` is null only on a hard stop (reauth, fresh
 * Item still syncing, unrecoverable error); a non-null `state` with a `note`
 * means usable-but-partial (e.g. the initial pull hit the page cap). Prior
 * stored state is left untouched on a hard stop.
 */
async function syncItem(
  item: StoredItem
): Promise<{ state: ItemState | null; note: string | null }> {
  let access_token: string;
  try {
    access_token = await decrypt(item.encrypted_access_token);
  } catch {
    return { state: null, note: `${item.institution_name}: could not decrypt stored credentials` };
  }

  const cutoff = daysAgoIso(RETENTION_DAYS);
  const stored = await readState(item.item_id);

  for (let attempt = 0; attempt < MAX_MUTATION_RETRIES; attempt++) {
    // Fresh working copy per attempt so a mid-pagination restart can't apply a
    // page's deltas onto an already-mutated set.
    const state: ItemState = JSON.parse(JSON.stringify(stored));
    let cursor: string | undefined = state.cursor || undefined;
    let hasMore = true;
    let pages = 0;
    let lastStatus: TransactionsUpdateStatus | undefined;

    try {
      while (hasMore && pages < MAX_PAGES) {
        const res = await plaidClient.transactionsSync({ access_token, cursor, count: 500 });
        pages++;
        lastStatus = res.data.transactions_update_status;
        res.data.accounts.forEach((a) => (state.accountNames[a.account_id] = a.name));
        for (const t of res.data.added) {
          state.txns[t.transaction_id] = toStored(t, state.accountNames, item.institution_name);
        }
        for (const t of res.data.modified) {
          state.txns[t.transaction_id] = toStored(t, state.accountNames, item.institution_name);
        }
        for (const r of res.data.removed) {
          if (r.transaction_id) delete state.txns[r.transaction_id];
        }
        hasMore = res.data.has_more;
        cursor = res.data.next_cursor;
      }
    } catch (err: any) {
      const code = err?.response?.data?.error_code;
      // Data changed under us mid-pagination: discard this attempt's work and
      // restart from the stored cursor. Once retries are exhausted, report it
      // specifically rather than as a generic fetch failure.
      if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') {
        if (attempt < MAX_MUTATION_RETRIES - 1) continue;
        return {
          state: null,
          note: `${item.institution_name}: could not fetch transactions (data kept changing — try again)`,
        };
      }
      if (code === 'ITEM_LOGIN_REQUIRED') {
        return { state: null, note: `${item.institution_name}: needs to be reconnected` };
      }
      if (code === 'PRODUCT_NOT_READY') {
        return {
          state: null,
          note: `${item.institution_name}: transactions are still syncing — try again in a minute`,
        };
      }
      console.error(err?.response?.data || err);
      return { state: null, note: `${item.institution_name}: could not fetch transactions` };
    }

    // Fresh Item whose initial pull hasn't produced anything yet: report the
    // syncing state and DON'T persist, so the next call re-pulls from scratch.
    if (
      stored.cursor === '' &&
      Object.keys(state.txns).length === 0 &&
      lastStatus === TransactionsUpdateStatus.NotReady
    ) {
      return {
        state: null,
        note: `${item.institution_name}: transactions are still syncing — try again in a minute`,
      };
    }

    // Advance the cursor and bound the stored set to the retention window.
    if (cursor) state.cursor = cursor;
    for (const id of Object.keys(state.txns)) {
      if (state.txns[id].date < cutoff) delete state.txns[id];
    }
    await writeState(item.item_id, state);

    // Hit the page cap mid-history: intermediate cursors are valid, so we
    // persisted progress and will finish next call. Surface it rather than
    // silently returning a short list.
    if (hasMore) {
      return {
        state,
        note: `${item.institution_name}: still importing older transactions — refresh again shortly`,
      };
    }
    return { state, note: null };
  }

  // Unreachable: every attempt either returns or (on the non-final mutation
  // race) `continue`s, and the final attempt's catch returns. Here only to
  // satisfy the compiler's exhaustiveness check.
  return { state: null, note: `${item.institution_name}: could not fetch transactions` };
}

/**
 * Sync + return the display-shaped transactions for the Activity tab, sliced to
 * the trailing LOOKBACK window. Account names are re-resolved from the merged
 * map (an account can arrive on a later page than a transaction referencing it).
 */
export async function syncItemTransactions(
  item: StoredItem
): Promise<{ txns: Txn[]; note: string | null }> {
  const { state, note } = await syncItem(item);
  if (!state) return { txns: [], note };
  const cutoff = daysAgoIso(LOOKBACK_DAYS);
  const txns = Object.values(state.txns)
    .filter((t) => t.date >= cutoff)
    .map(({ account_id, ...t }) => ({
      ...t,
      account_name: state.accountNames[account_id] || t.account_name || '',
    }));
  return { txns, note };
}

/**
 * Sync + return the detailed transactions (with `account_id`) for a trailing
 * window, defaulting to LOOKBACK days. Used by the estimated-history backfill,
 * which walks balances per account. Reads straight from the same persisted
 * store, so the two features share one Plaid pull.
 */
export async function readItemTransactions(
  item: StoredItem,
  sinceDays: number = LOOKBACK_DAYS
): Promise<{ txns: StoredTxn[]; note: string | null }> {
  const { state, note } = await syncItem(item);
  if (!state) return { txns: [], note };
  const cutoff = daysAgoIso(sinceDays);
  return { txns: Object.values(state.txns).filter((t) => t.date >= cutoff), note };
}
