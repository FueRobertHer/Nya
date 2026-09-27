import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { getItems } from '@/lib/storage';
import { readCache, writeCache, CacheKey } from '@/lib/cache';
import { getOverrides, getCarried, carriedCategories } from '@/lib/overrides';
import { getRenames } from '@/lib/renames';
import { syncItemTransactions, type Txn } from '@/lib/transactions';
import { getEffectiveHidden, type Link } from '@/lib/links';

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
async function carriedFor(ctx: Awaited<ReturnType<typeof dataCtx>>, links: Map<string, Link> | null, live: Set<string>) {
  if (!links || links.size === 0 || live.size === 0) return new Map<string, string>();
  return carriedCategories(await getCarried(ctx, [...links.keys()]), links);
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
    // rather than silently surfacing transactions the user hid.
    const { hidden, links, live } = await getEffectiveHidden(ctx);
    const hiddenIds = new Set(hidden.keys());
    const carried = await carriedFor(ctx, links, live);
    const [results, overrides, renames] = await Promise.all([
      Promise.all(items.map((item) => syncItemTransactions(ctx, item, hiddenIds, carried))),
      getOverrides(ctx),
      getRenames(ctx),
    ]);

    // Newest first. Within a day the posting `date` is equal, so fall back to
    // the true event `datetime` when Plaid provides it for a precise order.
    const transactions = results
      .flatMap((r) => r.txns)
      .sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        const at = a.datetime ?? '';
        const bt = b.datetime ?? '';
        return at < bt ? 1 : at > bt ? -1 : 0;
      });

    // Manual overrides win over Plaid's data: recategorization by transaction,
    // vendor rename by vendor key (so it covers every row from that merchant).
    for (const t of transactions) {
      const manual = overrides[t.transaction_id];
      if (manual) t.category = manual;
      const renamed = renames[t.vendor_key];
      if (renamed) t.name = renamed;
    }
    const notes = results.map((r) => r.note).filter((n): n is string => n !== null);

    const payload: TransactionsPayload = { transactions, notes, as_of: new Date().toISOString() };

    // Same rule as net-worth: only cache clean payloads, so syncing/reauth
    // institutions get re-checked on the next load instead of hiding for
    // the TTL.
    if (notes.length === 0) {
      await writeCache(ctx, CacheKey.Transactions, payload);
    }

    return NextResponse.json({ ...payload, from_cache: false });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(err?.response?.data || err);
    return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
  }
}
