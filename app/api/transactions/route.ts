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
//
// BEFORE THE YEAR. A yearly charge is seen twice only in two years, so the
// rows from before the lookback that recurring detection can use go beside
// the year's, as `recurring_history` (lib/activity.ts, lib/recurring.ts
// olderRowsForDetection): compact, from merchants charged this year only once
// or twice, at an amount charged this year too, with the same categories,
// renames and exclusions. The cache keeps a wider set, chosen before the
// person's own exclusions are applied, and each answer narrows it after them,
// so an excluded row never keeps another from being sent. Only recurring
// detection reads them, here and in the read-only API (lib/api-read.ts).
//
// ACCOUNT TYPES. Every row carries its account's name and type (depository,
// credit, loan, investment), so the cash forecast counts only what leaves or
// reaches checking and savings, never a card's own charges beside the card's
// payment (lib/forecast.ts).
//
// CATEGORIES. Every row is filed into the person's categories after the
// cache (lib/activity.ts finishActivity): this route seeds them on the first
// load and grows them by any category a row carries that none has yet, and
// sends the set it filed by (`categories`), which the pickers and the group
// rollups read, so renaming or regrouping a category needs no cache dropped.

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

    const { transactions, notes, incomplete, history, taxonomy } = await finishActivity(ctx, plaid, hidden, { grow: true });
    // The connections without transactions are Plaid's part too: a manual
    // account is not a connection. The views that count spending weigh them
    // against these rows, manual ones included (lib/no-transactions.ts).
    return NextResponse.json({
      transactions,
      notes,
      incomplete,
      without_transactions: plaid.without_transactions ?? [],
      ...(plaid.connections === undefined ? {} : { connections: plaid.connections }),
      recurring_history: history,
      categories: taxonomy,
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
