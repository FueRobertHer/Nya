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
//     what is stored, and never calls Plaid. With them, the rows imported into
//     linked accounts from files (#52, lib/history-import/read.ts), counted
//     only where no bank row stands for them, matched against the rows each
//     sync has just written; and a category the person chose for an imported
//     row carried to the bank row that stands for it, which also names the
//     rows it stands for (`stands_for`, never sent), so what else they said
//     about them (an exclusion, tags, a note) carries to it as it is read on
//     each request (lib/txn-layers.ts).
//   - the rest (finishActivity): the rows entered on manual accounts, and what
//     the person said about each row (lib/txn-annotations.ts), read on every
//     request and merged after the banks' part. So entering, editing or
//     excluding a transaction never drops the cache or waits on Plaid, a row
//     added while a load was running can't be cached away, and a record that
//     can't be read is only marked on its row, never a reason to stop caching.
//
// The banks' part also says which connections bring in no transactions, and
// why (without_transactions, lib/item-products.ts), with how many connections
// there are, so the app's views and the API say the same of them
// (lib/no-transactions.ts).
//
// CATEGORIES. Every row the assembly answers is filed into the person's
// categories (lib/categories.ts, lib/category-store.ts) in finishActivity,
// after the cached part: the banks' part keeps only what files a row (the
// category words it carries, whether the person chose them, and Plaid's own
// values), so renaming, moving, archiving or merging a category never drops
// the cache. The app grows the stored categories by whatever its rows carry;
// the read-only API grows a copy in memory and writes nothing.
//
// BEFORE THE YEAR. Beside the year's rows, each part gives the rows before it
// that recurring detection may need, as it sees a yearly charge twice only in
// two years: compact (OlderTxn), with the same categories, names and
// exclusions, narrowed to those detection can use (lib/recurring.ts
// olderRowsForDetection). The banks' part keeps a wider set (CACHED_HISTORY),
// chosen before the person's own exclusions are applied, and finishActivity
// narrows it after them (`history`), so an excluded row never keeps another
// from being used.
//
// THE REVIEW QUEUE AND MERCHANTS' DEFAULTS are applied with the rules in
// finishActivity (lib/review-layer.ts, through lib/txn-layers.ts), from the
// queue's settings and the defaults, read beside the rest, and the approvals
// of the rows read, by id (lib/review-read.ts): a default files what nothing
// more specific does, an approved transaction stays where it was approved,
// and what needs review is marked; never written into a stored row, so
// nothing about them is cached.
//
// SPLITS AND GROUPS (#39) are applied last in finishActivity, after the
// cache, the person's layers and the rules, once the rows are filed
// (lib/split-rows.ts): a split transaction is answered as its parts and a
// group's transactions as its net, so every reader's totals count those and
// nothing twice. A bank row standing for rows imported from files takes
// their split and their place in a group (`stands_for`, read before the
// layers take it off), as it takes what was said about them. The rows before
// the year stay as the bank has them: only recurring detection reads them,
// and it reads whole transactions.

import { getItems } from './storage';
import type { Ctx } from './containers';
import { readOverridesReport, getCarriedReport, carriedCategories } from './overrides';
import { readRenamesReport } from './renames';
import { syncItemTransactions, storedItemTransactions, LOOKBACK_DAYS, type OlderTxn, type Txn, type TxnCoverage } from './transactions';
import { olderRowsForDetection, RECURRING_LOOKBACK_DAYS } from './recurring';
import type { NoTransactionsReason } from './item-products';
import type { WithoutTransactions } from './no-transactions';
import { getEffectiveHidden, liveAccountIds, type Link } from './links';
import { getEffectiveLifecycle, endDays, type LifecycleView } from './lifecycle';
import { readManualTxnsForDisplay } from './manual-txns';
import { readAnnotations, getCarriedAnnotations, carriedAnnotations, type CarriedAnnotation } from './txn-annotations';
import { importedForActivity } from './history-import/read';
import type { StoredTxn } from './transactions';
import { filingSet, fileRows } from './category-store';
import { indexTaxonomy, type Taxonomy } from './categories';
import { liveTagIds, orderTagIds, tagsForDisplay, type TagSet } from './tags';
import { applyLayers } from './txn-layers';
import { readSplitsForDisplay } from './splits';
import { readGroupsForDisplay } from './groups';
import { expandSplitsAndGroups } from './split-rows';
import { applyShares, type ShareResult } from './shared-expenses/rows';
import { layerInputs } from './shared-expenses/read';
import { compileRules, ruleCategories, rulesForDisplay, type RuleSet, type RuleSubject } from './rules';
import { effectiveLinks, getLinks, resolveId } from './link-core';
import { readReviewBasics, readReviewParts } from './review-read';
import { reviewLayerOf } from './review-layer';
import type { Incomplete } from './month-coverage';

/**
 * How a rule's account condition knows an account now (lib/rules.ts): through
 * the links that apply, as every reader follows them (lib/link-core.ts
 * effectiveLinks: a link whose old id is live again is passed over, or two
 * live accounts would be folded into one). Read only when a rule reads an
 * account (`needed`). When the links or the live accounts can't be read, a
 * rule matches only the account it names, and a note says so.
 */
async function ruleAccounts(ctx: Ctx, needed: boolean): Promise<{ account?: (id: string) => string; note: string | null }> {
  if (!needed) return { note: null };
  try {
    const [links, live] = await Promise.all([getLinks(ctx), liveAccountIds(ctx, { strict: true, readOnly: true })]);
    const applied = effectiveLinks(links, live);
    return applied.size ? { account: (id: string) => resolveId(id, applied), note: null } : { note: null };
  } catch (err) {
    console.error('activity: account links could not be read for rules', err instanceof Error ? err.name : 'error');
    return { note: "Your account links couldn't be read, so a rule on an account applies only to that account's own transactions until they can be, not to an earlier account's linked to it." };
  }
}

/** Whether any rule that is on is one `what` picks out (one that names an
 *  account, say). */
const rulesRead = (set: RuleSet | null, what: (r: RuleSet['rules'][number]) => boolean) => !!set?.rules.some((r) => r.enabled && what(r));

/** What the banks' part keeps of the rows before the year: wider than
 *  finishActivity uses (lib/recurring.ts olderRowsForDetection), since the
 *  person's exclusions, applied after, may change which merchants qualify. */
const CACHED_HISTORY = { recent: 4, older: 6 };

/** The banks' part as assembled (and, by the app, cached). `plaid_only`
 *  tells it from the payload cached before, which held the manual rows too
 *  and must not be merged with them again, `account_types` from one cached
 *  before rows carried their account's type (account_type, which the cash
 *  forecast reads), `category_facts` from one cached before rows carried
 *  what files them into the person's categories, and `layer_facts` from one
 *  cached before rows carried what rules and what was carried across a
 *  re-link are applied by (lib/txn-layers.ts), and `content_keys` from one
 *  cached before posted rows carried the key a share carries across a
 *  re-link by (lib/shared-expenses/rows.ts): any is a miss. */
export type PlaidPayload = {
  plaid_only: true;
  account_types: true;
  category_facts: true;
  layer_facts: true;
  content_keys: true;
  transactions: Txn[];
  notes: string[]; // per-institution problems, shown to the user
  // The institutions whose rows are not all here, by name: none at all this
  // time (`missing`), or older ones still arriving (`importing`). Activity
  // says so under every month it totals (#51). Empty on any payload that is
  // cached, since only a payload without notes is.
  incomplete?: Incomplete[];
  // The connections that bring in no transactions, and why (lib/item-products.ts):
  // investment accounts only, no bank account or card, or a bank account Plaid
  // doesn't provide transactions for. Not problems, so outside `notes`, and the
  // payload stays cacheable. With `connections` (how many there are), the views
  // that count spending say what is true rather than "no transactions" or a
  // figure that looks complete (lib/no-transactions.ts).
  without_transactions?: WithoutTransactions[];
  connections?: number;
  // The banks' rows from before the lookback that recurring detection can use
  // (see BEFORE THE YEAR). Absent on a payload cached before they were kept.
  older?: OlderTxn[];
  as_of: string;
};

export function isPlaidPayload(v: unknown): v is PlaidPayload {
  const p = v as Partial<PlaidPayload> | null;
  return (
    !!p &&
    p.plaid_only === true &&
    p.account_types === true &&
    p.category_facts === true &&
    p.layer_facts === true &&
    p.content_keys === true &&
    Array.isArray(p.transactions) &&
    Array.isArray(p.notes) &&
    typeof p.as_of === 'string'
  );
}

/** One institution's part in an assembly: how much of it is here, and, read
 *  from storage, as of when (null when not known, or synced just now), and
 *  why it brings in no transactions, when it doesn't (lib/item-products.ts).
 *  Read from storage, also the oldest day of its stored rows (`first_date`,
 *  lib/transactions.ts storedItemTransactions); null when synced, or with
 *  none. And whether it is `missing` because nothing was ever stored for it
 *  (`never_synced`), not because what is stored couldn't be read; false when
 *  synced. */
export type BankSource = {
  item_id: string;
  institution_name: string;
  coverage: TxnCoverage;
  synced_at: string | null;
  first_date: string | null;
  no_transactions: NoTransactionsReason | null;
  never_synced: boolean;
};

/**
 * Categories and exclusions carried across a re-link (lib/overrides.ts,
 * lib/txn-annotations.ts), by the key of the row they apply to. Follows the
 * ACTIVE links the hidden check already read, and reads only the linked
 * earlier accounts' records. Carries nothing when the links or the live
 * accounts couldn't be read: a paused link must not carry, and without the
 * live set a paused link looks active. Best effort throughout: a failure
 * shows Plaid's categories and counts the rows, never an error; `ok` false
 * says the exclusions couldn't be read, so that answer isn't cached. `read`
 * says, for a report, whether the carried categories and exclusions were all
 * read (the links too, and the live accounts when there are links to follow);
 * the app goes on without them.
 */
async function carriedFor(ctx: Ctx, links: Map<string, Link> | null, liveOk: boolean) {
  const nothing = { categories: new Map<string, string>(), excluded: new Set<string>(), annotations: new Map<string, CarriedAnnotation>(), ok: true };
  // No links, read as none: nothing could be carried, so nothing is missing,
  // whatever the live accounts' read said (a damaged record of a connection
  // long gone must not put a gap on every report).
  if (links && links.size === 0) return { ...nothing, read: { categories: true, exclusions: true } };
  if (!links || !liveOk) return { ...nothing, read: { categories: false, exclusions: false } };
  const earlier = [...links.keys()];
  const [categories, annotations] = await Promise.all([getCarriedReport(ctx, earlier), getCarriedAnnotations(ctx, earlier)]);
  // What carries, by row: the exclusions are marked on the cached rows, and
  // the rest (an include, tags, a note) rides beside them for
  // lib/txn-layers.ts.
  const carried = carriedAnnotations(annotations.carried, links);
  return {
    categories: carriedCategories(categories.carried, links),
    excluded: new Set([...carried].filter(([, a]) => a.excluded === true).map(([k]) => k)),
    annotations: carried,
    ok: annotations.ok,
    read: { categories: categories.ok, exclusions: annotations.ok },
  };
}

/**
 * The category the person chose for an imported row a bank row now stands
 * for (lib/history-import/read.ts importedForActivity's `represents`, earlier
 * imports first), by the bank row: the earliest import's first. What else
 * was said about those rows (an exclusion, tags, a note) is read with every
 * record on each request, and laid on by lib/txn-layers.ts.
 */
function categoriesFromImports(represents: ReadonlyMap<string, readonly string[]>, overrides: Readonly<Record<string, string>>): Map<string, string> {
  const categories = new Map<string, string>();
  for (const [bankId, rows] of represents) {
    const category = rows.map((id) => overrides[id]).find((c) => !!c);
    if (category) categories.set(bankId, category);
  }
  return categories;
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
 * `since` reads the rows from that day on instead of the last LOOKBACK_DAYS:
 * a report on an earlier period (lib/report/read.ts), the same rows by the
 * same rules, further back. `keepEnded` keeps the rows of accounts that ended
 * (lib/lifecycle.ts) from their end day on, which are otherwise left out: for
 * a reader that leaves them out by the same rule itself and must say what it
 * didn't count (a report, with `lifecycle`, the ends as read here), or that
 * counts what is stored (a category's uses).
 *
 * `own_read` says whether the person's own changes were all read: their
 * categories (set on a transaction, or carried across a re-link), their names
 * for merchants, and their exclusions carried across a re-link. Each is a
 * convenience the app goes on without when it can't be read, showing the
 * bank's; a report says so (lib/report/build.ts).
 *
 * The hidden set is read first and strictly: rows from hidden accounts are
 * filtered out inside each Item's read (the only place account_id still
 * exists), so they're never shipped, and a read failure throws rather than
 * surfacing transactions the person hid. So is when each account ended
 * (lib/lifecycle.ts), through the same links: an ended account's rows from
 * its end day on are left out the same way, from the list, budgets and
 * spending, and one that can't be read throws rather than count them.
 */
export async function assembleBankRows(
  ctx: Ctx,
  opts: { sync: boolean; readOnly?: boolean; includeHidden?: boolean; withAccountIds?: boolean; since?: string; keepEnded?: boolean }
): Promise<{
  payload: PlaidPayload;
  hidden: Set<string>;
  cacheable: boolean;
  sources: BankSource[];
  own_read: { categories: boolean; names: boolean; exclusions: boolean };
  /** When each account ended, through the links the hidden set was read by:
   *  what the rows were filtered by, or with keepEnded would have been. */
  lifecycle: LifecycleView;
  /** The day of the earliest row imported into a linked account from its
   *  bank's files that counts (#52), of any date, or null with none: where
   *  its transactions in Nya begin, beside each bank's `first_date`. */
  imported_first: string | null;
}> {
  const items = await getItems(ctx);
  const { hidden, links, liveOk } = await getEffectiveHidden(ctx, { readOnly: opts.readOnly });
  const lifecycle = await getEffectiveLifecycle(ctx, links);
  const endedFrom = opts.keepEnded ? undefined : endDays(lifecycle);
  const hiddenIds = new Set(hidden.keys());
  const leftOut = opts.includeHidden ? new Set<string>() : hiddenIds;
  // Read alongside the Items: each one waits for it only once it has its rows.
  const carried = carriedFor(ctx, links, liveOk);
  const inputs = {
    hiddenAccountIds: leftOut,
    carriedIn: carried.then((c) => c.categories),
    carriedExclusionsIn: carried.then((c) => c.excluded),
    carriedAnnotationsIn: carried.then((c) => c.annotations),
    withAccountIds: opts.withAccountIds,
    endedFrom,
    since: opts.since,
  };
  const at = new Date().toISOString();
  const banks = Promise.all(
    items.map(async (item) =>
      opts.sync
        ? {
            ...(await syncItemTransactions(ctx, item, inputs.hiddenAccountIds, inputs.carriedIn, inputs.carriedExclusionsIn, { ...inputs, withStored: true })),
            synced_at: null,
            first_date: null,
            never_synced: false,
          }
        : storedItemTransactions(ctx, item, inputs, { withStored: true })
    )
  );
  const [results, overrides, renames, carry, imported] = await Promise.all([
    banks,
    readOverridesReport(ctx),
    readRenamesReport(ctx),
    carried,
    // The rows imported into linked accounts (#52), each counted only where
    // no bank row stands for it: part of the banks' part, so a category or a
    // rename applies to them as to the bank's own. Matched once the syncs
    // are done, against the rows they wrote (never read twice), so a row the
    // sync just brought supersedes in this very answer.
    Promise.all([banks, carried]).then(([done, c]) => {
      const bankStates = new Map<string, Record<string, StoredTxn> | null>();
      done.forEach((r, i) => {
        if (r.stored !== undefined) bankStates.set(items[i].item_id, r.stored);
      });
      // What was carried across a re-link applies to a bank row a restore
      // brought back as to the bank's own (lib/user-restore/restored.ts).
      const carry = { categories: c.categories, excluded: c.excluded, annotations: c.annotations };
      return importedForActivity(ctx, { items, links, leftOut, withAccountIds: opts.withAccountIds, bankStates, since: opts.since, endedFrom, carry });
    }),
  ]);

  // The person's own changes win over Plaid's data: recategorization by
  // transaction (a category's words, filed by finishActivity, which marks
  // them as the person's), vendor rename by vendor key (so it covers every row
  // from that merchant). A renamed row keeps the bank's name beside it
  // (renamed_from, never sent): a rule's name condition reads it too, and a
  // rule's name never replaces the person's (lib/txn-layers.ts).
  const transactions = [...results.flatMap((r) => r.txns), ...imported.txns];
  const older = [...results.flatMap((r) => r.older), ...imported.older];
  // A bank row standing for imported rows the person chose a category for
  // takes it, unless they chose one for the bank row itself. It names those
  // rows (`stands_for`), so, once it has posted, what else was said about
  // them (an exclusion or an include, tags, a note) carries to it in
  // finishActivity, read with every record on each request: under what is
  // said on the bank row itself (lib/txn-layers.ts); and so do their splits
  // and places in groups, of which a pending one takes none, a group saying
  // it is pending (lib/split-rows.ts).
  const fromImports = categoriesFromImports(imported.represents, overrides.overrides);
  for (const t of [...transactions, ...older]) {
    const manual = overrides.overrides[t.transaction_id] ?? fromImports.get(t.transaction_id);
    if (manual) {
      t.category = manual;
      t.category_set = true;
    }
    const renamed = renames.renames[t.vendor_key];
    if (renamed) {
      t.renamed_from = t.name;
      t.name = renamed;
    }
    const stands = imported.represents.get(t.transaction_id);
    if (stands) t.stands_for = stands;
  }
  // A posted bank row standing for an imported row whose amount it no longer
  // says (the bank changed its own since the two were paired): the imported
  // row's amount, which the Activity tab says beside it.
  for (const t of transactions) {
    const was = imported.changed.get(t.transaction_id);
    if (was !== undefined && !t.pending) t.imported_amount = was;
  }
  const notes = [...results.map((r) => r.note).filter((n): n is string => n !== null), ...imported.notes];
  // Every one of these comes with a note, so a payload holding any is never cached.
  const incomplete: Incomplete[] = [
    ...results.flatMap((r, i): Incomplete[] => (r.coverage === 'complete' ? [] : [{ institution_name: items[i].institution_name, coverage: r.coverage }])),
    // A bank a restore brought back, waiting to be linked: its months say so
    // (lib/month-coverage.ts `held`).
    ...imported.held.map((h): Incomplete => ({ institution_name: h.institution_name, coverage: 'held', from: h.from, to: h.to })),
  ];
  // Not problems, so not notes, and they don't keep the answer from the cache.
  // By id as well as name: the dashboard matches them to connection health by
  // id, since two connections can share a name.
  const without_transactions = results.flatMap((r, i) =>
    r.noTransactions ? [{ item_id: items[i].item_id, institution_name: items[i].institution_name, reason: r.noTransactions }] : []
  );
  return {
    payload: {
      plaid_only: true,
      account_types: true,
      category_facts: true,
      layer_facts: true,
      content_keys: true,
      transactions,
      notes,
      incomplete,
      without_transactions,
      connections: items.length,
      older: olderRowsForDetection(transactions, older, CACHED_HISTORY),
      as_of: at,
    },
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
      first_date: results[i].first_date,
      no_transactions: results[i].noTransactions ?? null,
      never_synced: results[i].never_synced === true,
    })),
    own_read: { categories: overrides.ok && carry.read.categories, names: renames.ok, exclusions: carry.read.exclusions },
    lifecycle,
    imported_first: imported.first,
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
 * What the person said about each row (lib/txn-annotations.ts: an
 * exclusion, tags, a bank row's note), what was carried across a re-link,
 * and the rules are applied in one place, lib/txn-layers.ts, the person's own
 * on top. Left out of budgets and reports (lib/spending.ts), still listed:
 * what the person said on the row itself, else what was carried (an
 * exclusion already on the row, or an include). A row whose record couldn't
 * be read is marked as not known (`excluded: null`): it counts, and the
 * Activity tab says a total may include one the person excluded.
 *
 * `since` is the first day of rows to read, as assembleBankRows's: by default
 * the same trailing window as the banks' rows. The manual rows are read back
 * to the earlier of it and the history's first day (RECURRING_LOOKBACK_DAYS),
 * so a report on a period older than that keeps every row entered by hand or
 * imported into it.
 *
 * `history` is the rows before the year that recurring detection can use
 * (see BEFORE THE YEAR): the banks', as kept, and the manual accounts',
 * chosen once the exclusions are on them.
 *
 * A manual account that ended (lib/lifecycle.ts) has its rows from its end
 * day on left out, as the banks' part leaves out a linked one's. Read
 * strictly here, on every request: a manual account is never linked, so no
 * links are needed, and the cached banks' part says nothing of it.
 *
 * Every row, the history's too, is filed into the person's categories (see
 * CATEGORIES), and `taxonomy` is the set it was filed by. `grow` is the app:
 * it seeds and grows the stored set; without it nothing is written.
 * `keepEnded` keeps an ended manual account's rows from its end day on, as
 * assembleBankRows's does a bank's.
 */
export async function finishActivity(
  ctx: Ctx,
  plaid: PlaidPayload,
  hidden: Set<string>,
  /** `subjects`, with `followLinks` for a rule being made that reads an
   *  account: for a rule's preview (app/api/rules/preview). */
  opts: {
    since?: string;
    grow?: boolean;
    keepEnded?: boolean;
    /** With keepEnded, each ended account's end day (lib/lifecycle.ts
     *  endDays), for a reader that leaves those rows out itself (a report):
     *  splits and groups leave them whole and out of every net, as the
     *  Activity tab, which never reads them, does. */
    endedFrom?: ReadonlyMap<string, string>;
    subjects?: Map<string, RuleSubject>;
    followLinks?: boolean;
  } = {}
): Promise<{
  transactions: Txn[];
  notes: string[];
  /** Of `notes`, those that say transactions couldn't all be read or aren't
   *  all in: an institution's (one that failed to sync, needs reconnecting,
   *  or is still bringing its history in), the rows imported into a linked
   *  account that can't be shown, a manual account's that can't be read.
   *  What the Plan weighs its figures by; the others (how rules, categories,
   *  splits and groups apply when something of theirs can't be read) never
   *  mean a transaction is missing. */
  unread_notes: string[];
  /** When the tags couldn't be read, the note that says so: for a reader that
   *  shows tags (the app, the read-only API), not one that doesn't (reports). */
  tags_note: string | null;
  /** How an account is known now, as the rules followed it (ruleAccounts). */
  accountOf?: (id: string) => string;
  incomplete: NonNullable<PlaidPayload['incomplete']>;
  history: OlderTxn[];
  /** The manual accounts whose rows couldn't be read (lib/manual-txns.ts
   *  readManualTxnsForDisplay), or 'all'. */
  manual_unread: string[] | 'all';
  taxonomy: Taxonomy;
  /** The tags that exist (lib/tags.ts), each row's among them; null when
   *  none were ever saved or they couldn't be read (a note says which). */
  tags: TagSet | null;
  /** The review queue (lib/review-store.ts): on from a day, or off, or its
   *  settings unread, and how many of the rows' approvals couldn't be read
   *  (`unknown`); and, when the settings couldn't be read, the note that says
   *  so, for a reader that shows what needs review (the app), not reports. */
  review: { on: boolean; since: string | null; unread: boolean; unknown: number };
  review_note: string | null;
  /** The merchants' default categories couldn't be read, so none filed a
   *  row (the notes say so): for a reader that says its totals may be filed
   *  otherwise than the person files them (a share, lib/share-views.ts). */
  defaults_unread: boolean;
  /** Shared expenses (lib/shared-expenses/rows.ts): what this read can tell
   *  is gone, what waits on a re-link, and what is shared twice. */
  shared_expenses: Pick<ShareResult, 'gone' | 'away' | 'twice' | 'moves'>;
}> {
  const cutoff = opts.since ?? new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const since = new Date(Date.now() - RECURRING_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  // The manual rows back to the earlier of the two: the history's first day,
  // and the transactions' own (a report's period can start before it).
  const readFrom = cutoff < since ? cutoff : since;
  // With them, the review queue's settings and the merchants' defaults; the
  // approvals once the rows are known (lib/review-read.ts).
  const [read, annotations, tagRead, ruleRead, splitRead, groupRead, lifecycle, reviewBasics, shared] = await Promise.all([
    readManualTxnsForDisplay(ctx, { hidden, cutoff: readFrom }),
    readAnnotations(ctx),
    tagsForDisplay(ctx),
    rulesForDisplay(ctx),
    readSplitsForDisplay(ctx),
    readGroupsForDisplay(ctx),
    opts.keepEnded ? null : getEffectiveLifecycle(ctx, new Map()),
    readReviewBasics(ctx),
    layerInputs(ctx),
  ]);
  const ended = lifecycle ? endDays(lifecycle) : new Map<string, string>();
  const manual = { ...read, txns: read.txns.filter((t) => !(t.account_id && ended.has(t.account_id) && t.date >= ended.get(t.account_id)!)) };
  // Manual rows come in newest entered first, so within a day without times
  // they follow Plaid's in that order.
  const transactions = [...plaid.transactions, ...manual.txns.filter((t) => t.date >= cutoff)].sort(newestFirst);
  // The rows before the year that could be used: the banks', as kept, and the
  // manual accounts', compact.
  const candidates: OlderTxn[] = [
    ...(plaid.older ?? []),
    ...manual.txns
      .filter((t) => t.date < cutoff && !t.pending)
      .map((t) => ({
        transaction_id: t.transaction_id,
        date: t.date,
        name: t.name,
        amount: t.amount,
        account_name: t.account_name,
        account_type: t.account_type ?? null,
        institution_name: t.institution_name,
        category: t.category,
        subcategory: t.subcategory,
        iso_currency_code: t.iso_currency_code,
        unofficial_currency_code: t.unofficial_currency_code ?? null,
        transaction_code: t.transaction_code,
        vendor_key: t.vendor_key,
        logo_url: t.logo_url,
        source: t.source,
        account_ref: t.account_id,
        ...(t.own_name ? { own_name: true as const } : {}),
      })),
  ];
  // What each bank row standing for rows imported from files stands for
  // (#52), which the layers take off the row once they have laid what was
  // said about those rows on it: their splits and their places in groups are
  // a posted one's too, and a pending one's group says why it isn't counted
  // there yet (lib/split-rows.ts).
  const stands = new Map<string, readonly string[]>();
  for (const t of transactions) if (t.stands_for?.length) stands.set(t.transaction_id, t.stands_for);
  // Each row's account and content key, which the layers take off the row
  // (never sent): what a share is found by across a re-link, and what says
  // its transaction is gone (lib/shared-expenses/rows.ts).
  const rowFacts = new Map<string, { account?: string; key?: string }>();
  for (const t of transactions) rowFacts.set(t.transaction_id, { account: t.account_id ?? t.account_ref, key: t.content_key });
  // The categories first, which the rules read; then the rules, what was
  // carried across a re-link and what the person said about each row, over
  // the bank's data (lib/txn-layers.ts); then every row filed.
  const rows = [...transactions, ...candidates];
  // The approvals of these rows only (lib/review-read.ts), beside the categories.
  const [filed, reviewParts] = await Promise.all([filingSet(ctx, rows, { grow: !!opts.grow }), readReviewParts(ctx, rows, reviewBasics)]);
  const ix = indexTaxonomy(filed.taxonomy);
  const review = reviewLayerOf(reviewParts, ix);
  const onAccount = rulesRead(ruleRead.set, (r) => r.conditions.some((c) => c.field === 'account'));
  const links = await ruleAccounts(ctx, onAccount || !!opts.followLinks);
  const account = links.account;
  const rules = compileRules(ruleRead.set, { ix, liveTags: liveTagIds(tagRead.set), account });
  applyLayers(rows, { records: annotations.records, unknown: annotations.unknown, tags: tagRead.set, rules, ix, account, subjects: opts.subjects, review: review.layer });
  fileRows(ix, rows);
  // Last, splits and groups (lib/split-rows.ts): each split transaction of
  // the year in its parts' place, each group's transactions in its net's, so
  // every total counts those and nothing twice; a bank row standing for
  // imported rows split or grouped as they were. Not the rows before the
  // year, which only recurring detection reads, and it reads transactions
  // whole.
  const expanded = expandSplitsAndGroups(transactions, {
    splits: splitRead.records,
    splitsUnknown: splitRead.unknown,
    groups: groupRead.groups,
    groupsUnknown: groupRead.unknown,
    ix,
    orderTags: (ids) => orderTagIds(tagRead.set, ids),
    from: cutoff,
    ...(opts.keepEnded && opts.endedFrom ? { ended: opts.endedFrom } : {}),
    ...(stands.size > 0 ? { stands } : {}),
  });
  // After them, shared expenses (lib/shared-expenses/rows.ts): a shared
  // transaction at your part beside the others' parts, a payment that paid
  // something back beside what it paid, and an IOU you owe for something as
  // a row of its own; every row the bank's adds up to it.
  const withShares = applyShares(expanded.rows, {
    ...shared,
    ix,
    from: cutoff,
    hidden,
    rowFacts,
    manualUnread: manual.unread,
    ...(opts.keepEnded && opts.endedFrom ? { ended: opts.endedFrom } : {}),
    ...(stands.size > 0 ? { stands } : {}),
  });
  // What keeps rules from applying as they say, beside the rules' own note:
  // links that couldn't be read for a rule on an account, and categories that
  // couldn't be read for a rule naming one (left out whole until they can be).
  const ruleNotes = [
    ...(onAccount && links.note ? [links.note] : []),
    ...(filed.unreadable && rulesRead(ruleRead.set, (r) => ruleCategories(r).length > 0)
      ? ["Rules that name a category aren't applied until your categories can be read."]
      : []),
  ];
  // The institutions whose rows aren't all here: Plaid's, and the banks of a
  // SimpleFIN connection whose older history is still arriving (a manual
  // account has no connection, so it is never incomplete).
  return {
    transactions: withShares.rows,
    notes: [...plaid.notes, ...manual.notes, ...(ruleRead.note ? [ruleRead.note] : []), ...ruleNotes, ...filed.notes, ...review.notes, ...expanded.notes, ...withShares.notes],
    unread_notes: [...plaid.notes, ...manual.notes, ...withShares.unread_notes],
    shared_expenses: { gone: withShares.gone, away: withShares.away, twice: withShares.twice, ...(withShares.moves ? { moves: withShares.moves } : {}) },
    tags_note: tagRead.note,
    review: {
      on: !reviewParts.settingsUnread && !!reviewParts.settings?.on,
      since: reviewParts.settings?.since ?? null,
      unread: reviewParts.settingsUnread,
      unknown: reviewParts.approvalsUnknown.size,
    },
    review_note: review.queueNote,
    defaults_unread: reviewParts.defaultsUnread,
    ...(account ? { accountOf: account } : {}),
    incomplete: [...(plaid.incomplete ?? []), ...manual.incomplete],
    // Chosen once the exclusions are on the rows, so an excluded row neither
    // counts toward a merchant's limit nor is used; from the transactions as
    // the bank has them, never a split's parts or a group's net.
    history: olderRowsForDetection(transactions, candidates),
    taxonomy: filed.taxonomy,
    tags: tagRead.set,
    manual_unread: manual.unread,
  };
}
