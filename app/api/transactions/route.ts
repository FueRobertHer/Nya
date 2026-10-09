import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { getItems } from '@/lib/storage';
import { readCache, writeCache, CacheKey } from '@/lib/cache';
import { getOverrides, getCarried, carriedCategories } from '@/lib/overrides';
import { getRenames } from '@/lib/renames';
import { syncItemTransactions, LOOKBACK_DAYS, type Txn } from '@/lib/transactions';
import type { WithoutTransactions } from '@/lib/no-transactions';
import { getEffectiveHidden, type Link } from '@/lib/links';
import { getHiddenAccounts } from '@/lib/hidden';
import { readManualTxnsForDisplay } from '@/lib/manual-txns';
import { readExclusions, getCarriedAnnotations, carriedExclusions } from '@/lib/txn-annotations';
import { loggable } from '@/lib/log-safe';

// The Activity tab's transactions: every linked institution's, synced with
// Plaid, and the rows entered on manual accounts, with what the person said
// about each (lib/txn-annotations.ts).
//
// ONLY PLAID'S PART IS CACHED. Syncing every Item is the slow part, so its
// result (categories, renames and exclusions carried across a re-link
// applied) is cached; the manual rows and what the person said about each row
// are read on every request and merged after it. So entering a transaction,
// editing one or excluding one never drops the cache or waits on Plaid, a row
// added while a load was running can't be cached away, and a record that
// can't be read is only marked on its row, never a reason to stop caching.

/** What is cached: Plaid's rows as assembled. `plaid_only` tells it from the
 *  payload cached before, which held the manual rows too and must not be
 *  merged with them again: that one is a miss. */
type PlaidPayload = {
  plaid_only: true;
  transactions: Txn[];
  notes: string[]; // per-institution problems, shown to the user
  // The institutions whose rows are not all here, by name: none at all this
  // time (`missing`), or older ones still arriving (`importing`). Activity
  // says so under every month it totals (#51). Empty on any payload that is
  // cached, since only a payload without notes is.
  incomplete?: { institution_name: string; coverage: 'missing' | 'importing' }[];
  // The connections that bring in no transactions, and why (lib/item-products.ts):
  // investment accounts only, no bank account or card, or a bank account Plaid
  // doesn't provide transactions for. Not problems, so outside `notes`, and the
  // payload stays cacheable. With `connections` (how many there are), the views
  // that count spending say what is true rather than "no transactions" or a
  // figure that looks complete (lib/no-transactions.ts).
  without_transactions?: WithoutTransactions[];
  connections?: number;
  as_of: string;
};

type Ctx = Awaited<ReturnType<typeof dataCtx>>;

function isPlaidPayload(v: unknown): v is PlaidPayload {
  const p = v as Partial<PlaidPayload> | null;
  return !!p && p.plaid_only === true && Array.isArray(p.transactions) && Array.isArray(p.notes) && typeof p.as_of === 'string';
}

/**
 * Categories and exclusions carried across a re-link (lib/overrides.ts,
 * lib/txn-annotations.ts), by the key of the row they apply to. Follows the
 * ACTIVE links the hidden check already read, and reads only the linked
 * earlier accounts' records. Carries nothing when the links or the live
 * accounts couldn't be read: a paused link must not carry, and without the
 * live set a paused link looks active. Best effort throughout: a failure
 * shows Plaid's categories and counts the rows, never an error; `ok` false
 * says the exclusions couldn't be read, so that answer isn't cached.
 */
async function carriedFor(ctx: Ctx, links: Map<string, Link> | null, liveOk: boolean) {
  if (!links || links.size === 0 || !liveOk) return { categories: new Map<string, string>(), excluded: new Set<string>(), ok: true };
  const earlier = [...links.keys()];
  const [categories, annotations] = await Promise.all([getCarried(ctx, earlier), getCarriedAnnotations(ctx, earlier)]);
  return { categories: carriedCategories(categories, links), excluded: carriedExclusions(annotations.carried, links), ok: annotations.ok };
}

/** Newest first. Within a day the posting `date` is equal, so fall back to the
 *  true event `datetime` when Plaid provides it for a precise order; rows
 *  without one keep the order they came in (the sort is stable). */
function newestFirst(a: Txn, b: Txn): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const at = a.datetime ?? '';
  const bt = b.datetime ?? '';
  return at < bt ? 1 : at > bt ? -1 : 0;
}

/** Syncs every Item: Plaid's rows, with the hidden accounts' left out, and
 *  whether the answer may be cached. */
async function assemblePlaid(ctx: Ctx): Promise<{ payload: PlaidPayload; hidden: Set<string>; cacheable: boolean }> {
  const items = await getItems(ctx);
  // Read the hidden set first: rows from hidden accounts are filtered out
  // inside the sync (the only place account_id still exists), so they're
  // never shipped to the client. A read failure throws to the catch below
  // rather than silently surfacing transactions the user hid.
  const { hidden, links, liveOk } = await getEffectiveHidden(ctx);
  const hiddenIds = new Set(hidden.keys());
  // Read alongside the syncs: each one waits for it only once Plaid answered.
  const carried = carriedFor(ctx, links, liveOk);
  const [results, overrides, renames, carry] = await Promise.all([
    Promise.all(
      items.map((item) =>
        syncItemTransactions(
          ctx,
          item,
          hiddenIds,
          carried.then((c) => c.categories),
          carried.then((c) => c.excluded)
        )
      )
    ),
    getOverrides(ctx),
    getRenames(ctx),
    carried,
  ]);

  // Manual overrides win over Plaid's data: recategorization by transaction,
  // vendor rename by vendor key (so it covers every row from that merchant).
  const transactions = results.flatMap((r) => r.txns);
  for (const t of transactions) {
    const manual = overrides[t.transaction_id];
    if (manual) t.category = manual;
    const renamed = renames[t.vendor_key];
    if (renamed) t.name = renamed;
  }
  const notes = results.map((r) => r.note).filter((n): n is string => n !== null);
  // Every one of these comes with a note, so a payload holding any is never cached.
  const incomplete = results.flatMap((r, i) =>
    r.coverage === 'complete' ? [] : [{ institution_name: items[i].institution_name, coverage: r.coverage }]
  );
  // Not problems, so not notes, and they don't keep the answer from the cache.
  const without_transactions = results.flatMap((r, i) =>
    r.noTransactions ? [{ institution_name: items[i].institution_name, reason: r.noTransactions }] : []
  );
  return {
    payload: {
      plaid_only: true,
      transactions,
      notes,
      incomplete,
      without_transactions,
      connections: items.length,
      as_of: new Date().toISOString(),
    },
    hidden: hiddenIds,
    // Same rule as net-worth: only clean payloads, so syncing or reauth
    // institutions get re-checked on the next load instead of hiding for the
    // TTL; and not when the carried exclusions couldn't be read.
    cacheable: notes.length === 0 && carry.ok,
  };
}

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';
    const cached = refresh ? null : await readCache<unknown>(ctx, CacheKey.Transactions);

    let plaid: PlaidPayload;
    let hidden: Set<string>;
    const fromCache = isPlaidPayload(cached);
    if (isPlaidPayload(cached)) {
      plaid = cached;
      // Only the manual accounts' part of the hidden set is needed now (they
      // are never linked, lib/links.ts): one read, and a failure throws, as
      // above, rather than showing rows the person hid.
      hidden = new Set((await getHiddenAccounts(ctx)).keys());
    } else {
      const assembled = await assemblePlaid(ctx);
      plaid = assembled.payload;
      hidden = assembled.hidden;
      if (assembled.cacheable) await writeCache(ctx, CacheKey.Transactions, plaid);
    }

    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const [manual, exclusions] = await Promise.all([
      // Transactions on manual accounts (lib/manual-txns.ts): an account whose
      // rows can't be read gets a note, like an institution that failed.
      // Their category and payee are their own, changed by editing the row
      // (app/api/recategorize does that for a manual row), so no override or
      // rename applies.
      readManualTxnsForDisplay(ctx, { hidden, cutoff }),
      readExclusions(ctx),
    ]);

    // Manual rows come in newest entered first, so within a day without times
    // they follow Plaid's in that order.
    const transactions = [...plaid.transactions, ...manual.txns].sort(newestFirst);

    // Left out of budgets and reports (lib/spending.ts), still listed: what the
    // person said on the row itself, else an exclusion carried across a
    // re-link (already on the row). A row whose record couldn't be read is
    // marked as not known: it counts, and the Activity tab says a total may
    // include one the person excluded.
    for (const t of transactions) {
      const own = exclusions.records.get(t.transaction_id);
      if (own === true) t.excluded = true;
      else if (own === false) delete t.excluded;
      else if (exclusions.unknown.has(t.transaction_id)) t.excluded = null;
    }
    const notes = [...plaid.notes, ...manual.notes];
    // The institutions whose rows aren't all here (Plaid's part: a manual
    // account has no connection, so it is never incomplete).
    const incomplete = plaid.incomplete ?? [];

    // The connections without transactions are Plaid's part too: a manual
    // account is not a connection. The views that count spending weigh them
    // against these rows, manual ones included (lib/no-transactions.ts).
    return NextResponse.json({
      transactions,
      notes,
      incomplete,
      without_transactions: plaid.without_transactions ?? [],
      ...(plaid.connections === undefined ? {} : { connections: plaid.connections }),
      as_of: plaid.as_of,
      from_cache: fromCache,
    });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
  }
}
