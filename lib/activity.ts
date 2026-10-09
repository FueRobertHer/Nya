// lib/activity.ts
//
// The Activity tab's transactions, assembled: for the app (app/api/transactions)
// and for the read-only API and MCP server (lib/api-read.ts). One assembly, so
// a row reads the same wherever it is read: the same rows, with the same
// categories, names and exclusions, the hidden accounts' left out.
//
// In two parts, because the app caches the first:
//   - the BANKS' rows (assembleBankRows): every linked institution's, with
//     categories and exclusions carried across a re-link, and the person's own
//     category (by transaction) and vendor name (by vendor) applied. The app
//     syncs each institution with Plaid first (`sync`); the API reads only
//     what is stored, and never calls Plaid.
//   - the rest (finishActivity): the rows entered on manual accounts, and what
//     the person said about each row (lib/txn-annotations.ts), read on every
//     request and merged after the banks' part. So entering, editing or
//     excluding a transaction never drops the cache or waits on Plaid, a row
//     added while a load was running can't be cached away, and a record that
//     can't be read is only marked on its row, never a reason to stop caching.

import { getItems } from './storage';
import type { Ctx } from './containers';
import { getOverrides, getCarried, carriedCategories } from './overrides';
import { getRenames } from './renames';
import { syncItemTransactions, storedItemTransactions, LOOKBACK_DAYS, type Txn, type TxnCoverage } from './transactions';
import { getEffectiveHidden, type Link } from './links';
import { readManualTxnsForDisplay } from './manual-txns';
import { readExclusions, getCarriedAnnotations, carriedExclusions } from './txn-annotations';

/** The banks' part as assembled (and, by the app, cached). `plaid_only`
 *  tells it from the payload cached before, which held the manual rows too
 *  and must not be merged with them again: that one is a miss. */
export type PlaidPayload = {
  plaid_only: true;
  transactions: Txn[];
  notes: string[]; // per-institution problems, shown to the user
  // The institutions whose rows are not all here, by name: none at all this
  // time (`missing`), or older ones still arriving (`importing`). Activity
  // says so under every month it totals (#51). Empty on any payload that is
  // cached, since only a payload without notes is.
  incomplete?: { institution_name: string; coverage: 'missing' | 'importing' }[];
  as_of: string;
};

export function isPlaidPayload(v: unknown): v is PlaidPayload {
  const p = v as Partial<PlaidPayload> | null;
  return !!p && p.plaid_only === true && Array.isArray(p.transactions) && Array.isArray(p.notes) && typeof p.as_of === 'string';
}

/** One institution's part in an assembly: how much of it is here, and, read
 *  from storage, as of when (null when not known, or synced just now). */
export type BankSource = { item_id: string; institution_name: string; coverage: TxnCoverage; synced_at: string | null };

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
export function newestFirst(a: Txn, b: Txn): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const at = a.datetime ?? '';
  const bt = b.datetime ?? '';
  return at < bt ? 1 : at > bt ? -1 : 0;
}

/**
 * Every Item's rows, with the hidden accounts' left out, and whether the
 * answer may be cached.
 *
 * `sync` (the app) syncs each Item with Plaid first; without it (the API) each
 * Item's stored rows are read and Plaid is never called. `readOnly` changes
 * nothing while reading (lib/links.ts), for a reader that must not write.
 * `includeHidden` keeps the hidden accounts' rows (the API's include_hidden);
 * `hidden` is every id of every hidden account either way. `withAccountIds`
 * puts each bank row's account_id on it (lib/transactions.ts displayRows).
 *
 * The hidden set is read first and strictly: rows from hidden accounts are
 * filtered out inside each Item's read (the only place account_id still
 * exists), so they're never shipped, and a read failure throws rather than
 * surfacing transactions the person hid.
 */
export async function assembleBankRows(
  ctx: Ctx,
  opts: { sync: boolean; readOnly?: boolean; includeHidden?: boolean; withAccountIds?: boolean }
): Promise<{ payload: PlaidPayload; hidden: Set<string>; cacheable: boolean; sources: BankSource[] }> {
  const items = await getItems(ctx);
  const { hidden, links, liveOk } = await getEffectiveHidden(ctx, { readOnly: opts.readOnly });
  const hiddenIds = new Set(hidden.keys());
  const leftOut = opts.includeHidden ? new Set<string>() : hiddenIds;
  // Read alongside the Items: each one waits for it only once it has its rows.
  const carried = carriedFor(ctx, links, liveOk);
  const inputs = {
    hiddenAccountIds: leftOut,
    carriedIn: carried.then((c) => c.categories),
    carriedExclusionsIn: carried.then((c) => c.excluded),
    withAccountIds: opts.withAccountIds,
  };
  const at = new Date().toISOString();
  const [results, overrides, renames, carry] = await Promise.all([
    Promise.all(
      items.map(async (item) =>
        opts.sync
          ? { ...(await syncItemTransactions(ctx, item, inputs.hiddenAccountIds, inputs.carriedIn, inputs.carriedExclusionsIn, inputs)), synced_at: null }
          : storedItemTransactions(ctx, item, inputs)
      )
    ),
    getOverrides(ctx),
    getRenames(ctx),
    carried,
  ]);

  // The person's own changes win over Plaid's data: recategorization by
  // transaction, vendor rename by vendor key (so it covers every row from that
  // merchant).
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
  return {
    payload: { plaid_only: true, transactions, notes, incomplete, as_of: at },
    hidden: hiddenIds,
    // Same rule as net-worth: only clean payloads, so syncing or reauth
    // institutions get re-checked on the next load instead of hiding for the
    // TTL; and not when the carried exclusions couldn't be read.
    cacheable: notes.length === 0 && carry.ok,
    sources: items.map((item, i) => ({
      item_id: item.item_id,
      institution_name: item.institution_name,
      coverage: results[i].coverage,
      synced_at: results[i].synced_at,
    })),
  };
}

/**
 * The banks' rows with everything read on every request merged in: the rows
 * entered on manual accounts (an account whose rows can't be read gets a
 * note, like an institution that failed; `hidden` accounts' are left out),
 * newest first, and what the person said about each row. Their category and
 * payee are the manual row's own, changed by editing it, so no override or
 * rename applies to one.
 *
 * Left out of budgets and reports (lib/spending.ts), still listed: what the
 * person said on the row itself, else an exclusion carried across a re-link
 * (already on the row). A row whose record couldn't be read is marked as not
 * known (`excluded: null`): it counts, and the Activity tab says a total may
 * include one the person excluded.
 */
export async function finishActivity(
  ctx: Ctx,
  plaid: PlaidPayload,
  hidden: Set<string>
): Promise<{ transactions: Txn[]; notes: string[]; incomplete: NonNullable<PlaidPayload['incomplete']> }> {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [manual, exclusions] = await Promise.all([readManualTxnsForDisplay(ctx, { hidden, cutoff }), readExclusions(ctx)]);
  // Manual rows come in newest entered first, so within a day without times
  // they follow Plaid's in that order.
  const transactions = [...plaid.transactions, ...manual.txns].sort(newestFirst);
  for (const t of transactions) {
    const own = exclusions.records.get(t.transaction_id);
    if (own === true) t.excluded = true;
    else if (own === false) delete t.excluded;
    else if (exclusions.unknown.has(t.transaction_id)) t.excluded = null;
  }
  // The institutions whose rows aren't all here (the banks' part: a manual
  // account has no connection, so it is never incomplete).
  return { transactions, notes: [...plaid.notes, ...manual.notes], incomplete: plaid.incomplete ?? [] };
}
