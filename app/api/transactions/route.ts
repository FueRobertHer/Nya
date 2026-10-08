import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { getItems } from '@/lib/storage';
import { readCache, writeCache, CacheKey } from '@/lib/cache';
import { getOverrides, getCarried, carriedCategories } from '@/lib/overrides';
import { getRenames } from '@/lib/renames';
import { syncItemTransactions, LOOKBACK_DAYS, type Txn } from '@/lib/transactions';
import { getEffectiveHidden, type Link } from '@/lib/links';
import { readManualTxnsForDisplay } from '@/lib/manual-txns';
import { readExclusions } from '@/lib/txn-annotations';
import { loggable } from '@/lib/log-safe';

type TransactionsPayload = {
  transactions: Txn[];
  notes: string[]; // per-institution problems, shown to the user
  as_of: string;
};

/**
 * Categories carried across a re-link (lib/overrides.ts), by the key of the
 * row they apply to. Follows the ACTIVE links the hidden check already read,
 * and reads only the linked earlier accounts' records. Carries nothing when
 * the links or the live accounts couldn't be read: a paused link must not
 * carry, and without the live set a paused link looks active. Best effort
 * throughout: a failure shows Plaid's categories, never an error.
 */
async function carriedFor(ctx: Awaited<ReturnType<typeof dataCtx>>, links: Map<string, Link> | null, liveOk: boolean) {
  if (!links || links.size === 0 || !liveOk) return new Map<string, string>();
  return carriedCategories(await getCarried(ctx, [...links.keys()]), links);
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

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    const refresh = new URL(req.url).searchParams.get('refresh') === '1';
    if (!refresh) {
      const cached = await readCache<TransactionsPayload>(ctx, CacheKey.Transactions);
      if (cached) return NextResponse.json({ ...cached, from_cache: true });
    }

    const items = await getItems(ctx);
    // Read the hidden set first: rows from hidden accounts are filtered out
    // inside the sync (the only place account_id still exists), so they're
    // never shipped to the client. A read failure throws to the catch below
    // rather than silently surfacing transactions the user hid. Manual rows of
    // a hidden manual account are left out the same way.
    const { hidden, links, liveOk } = await getEffectiveHidden(ctx);
    const hiddenIds = new Set(hidden.keys());
    // Read alongside the syncs: each one waits for it only once Plaid answered.
    const carried = carriedFor(ctx, links, liveOk);
    const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const [results, overrides, renames, manual, exclusions] = await Promise.all([
      Promise.all(items.map((item) => syncItemTransactions(ctx, item, hiddenIds, carried))),
      getOverrides(ctx),
      getRenames(ctx),
      // Transactions on manual accounts (lib/manual-txns.ts): an account whose
      // rows can't be read gets a note, like an institution that failed.
      readManualTxnsForDisplay(ctx, { hidden: hiddenIds, cutoff }),
      readExclusions(ctx),
    ]);

    // Manual overrides win over Plaid's data: recategorization by transaction,
    // vendor rename by vendor key (so it covers every row from that merchant).
    // Not on manual rows: their category and payee are their own, changed by
    // editing the row (app/api/recategorize does that for a manual row).
    const plaid = results.flatMap((r) => r.txns);
    for (const t of plaid) {
      const manual = overrides[t.transaction_id];
      if (manual) t.category = manual;
      const renamed = renames[t.vendor_key];
      if (renamed) t.name = renamed;
    }
    // Manual rows come in newest entered first, so within a day without times
    // they follow Plaid's in that order.
    const transactions = [...plaid, ...manual.txns].sort(newestFirst);

    // Left out of budgets and reports (lib/spending.ts), still listed. A row
    // whose exclusion couldn't be read is marked as not known: it counts, and
    // the Activity tab says a total may include one the person excluded.
    let unknownExclusions = false;
    for (const t of transactions) {
      if (exclusions.excluded.has(t.transaction_id)) t.excluded = true;
      else if (exclusions.unknown.has(t.transaction_id)) {
        t.excluded = null;
        unknownExclusions = true;
      }
    }
    const notes = [...results.map((r) => r.note).filter((n): n is string => n !== null), ...manual.notes];

    const payload: TransactionsPayload = { transactions, notes, as_of: new Date().toISOString() };

    // Same rule as net-worth: only cache clean payloads, so syncing/reauth
    // institutions get re-checked on the next load instead of hiding for
    // the TTL. An exclusion that couldn't be read is checked again too.
    if (notes.length === 0 && !unknownExclusions) {
      await writeCache(ctx, CacheKey.Transactions, payload);
    }

    return NextResponse.json({ ...payload, from_cache: false });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
  }
}
