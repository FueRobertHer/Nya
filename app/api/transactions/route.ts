import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import { readCache, writeCache, CacheKey } from '@/lib/cache';
import { getHiddenAccounts } from '@/lib/hidden';
import { assembleBankRows, finishActivity, isPlaidPayload, type PlaidPayload } from '@/lib/activity';
import { loggable } from '@/lib/log-safe';

// The Activity tab's transactions: every linked institution's, synced with
// Plaid, and the rows entered on manual accounts, with what the person said
// about each (lib/txn-annotations.ts). Assembled by lib/activity.ts, which the
// read-only API shares, reading stored rows instead of syncing.
//
// ONLY PLAID'S PART IS CACHED. Syncing every Item is the slow part, so its
// result (categories, renames and exclusions carried across a re-link
// applied) is cached; the manual rows and what the person said about each row
// are read on every request and merged after it. So entering a transaction,
// editing one or excluding one never drops the cache or waits on Plaid, a row
// added while a load was running can't be cached away, and a record that
// can't be read is only marked on its row, never a reason to stop caching.

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
      // in the assembly, rather than showing rows the person hid.
      hidden = new Set((await getHiddenAccounts(ctx)).keys());
    } else {
      const assembled = await assembleBankRows(ctx, { sync: true });
      plaid = assembled.payload;
      hidden = assembled.hidden;
      if (assembled.cacheable) await writeCache(ctx, CacheKey.Transactions, plaid);
    }

    const { transactions, notes, incomplete } = await finishActivity(ctx, plaid, hidden);
    return NextResponse.json({ transactions, notes, incomplete, as_of: plaid.as_of, from_cache: fromCache });
  } catch (err: any) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to fetch transactions' }, { status: 500 });
  }
}
