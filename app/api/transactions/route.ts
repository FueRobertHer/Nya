import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { readCache, writeCache, CacheKey } from '@/lib/cache';
import { getHiddenAccounts } from '@/lib/hidden';
import { assembleBankRows, finishActivity, isPlaidPayload, type PlaidPayload } from '@/lib/activity';
import { storeFailure } from '@/lib/store-failure';
import { withImportedFiles } from '@/lib/history-import/without-files';

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
//
// TAGS AND NOTES are applied after the cache too (lib/txn-layers.ts), with
// the tags that exist sent beside the rows (`tags`): a tag put on, a note
// written or a tag renamed shows on the next load with nothing dropped.

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

    const [{ transactions, notes, unread_notes, tags_note, incomplete, history, taxonomy, tags, review, review_note }, without_transactions] = await Promise.all([
      finishActivity(ctx, plaid, hidden, { grow: true }),
      // With what the files imported into each one's accounts cover, for one
      // whose transactions don't come in: a month they cover isn't said to be
      // missing them (lib/history-import/without-files.ts). Read on every
      // load, never cached: the cached part is Plaid's alone.
      withImportedFiles(ctx, plaid.without_transactions ?? []),
    ]);
    // The connections without transactions are Plaid's part too: a manual
    // account is not a connection. The views that count spending weigh them
    // against these rows, manual ones included (lib/no-transactions.ts).
    return NextResponse.json({
      transactions,
      // What the load couldn't read, or couldn't apply as it says: each bears
      // on what is listed and counted, the cash flow chart's figures among
      // them (lib/cash-flow.ts cashFlowNotes).
      notes,
      // Of those, the ones that say transactions couldn't all be read, which
      // the Plan weighs its figures by (never a rule's, a category's, a
      // split's or a group's, which mean nothing is missing).
      unread_notes,
      // What only the list says, apart: tags that couldn't be read, and the
      // review queue's settings, which no figure reads, so nothing that
      // counts (the cash flow chart) says them among what may be missing.
      aside_notes: [...(tags_note ? [tags_note] : []), ...(review_note ? [review_note] : [])],
      incomplete,
      without_transactions,
      ...(plaid.connections === undefined ? {} : { connections: plaid.connections }),
      recurring_history: history,
      categories: taxonomy,
      // The tags that exist (lib/tags.ts): each row's `tags` are their ids.
      tags: tags?.tags ?? [],
      // The review queue (lib/review-store.ts): on from a day, or off; what
      // needs review is marked on each row (lib/review-layer.ts).
      review,
      as_of: plaid.as_of,
      from_cache: fromCache,
    });
  } catch (err: any) {
    // Account closures that can't be read (lib/lifecycle.ts) are a 409 with
    // their ids, never rows of a closed account counted (lib/store-failure.ts).
    return storeFailure(err, 'Failed to fetch transactions');
  }
}
