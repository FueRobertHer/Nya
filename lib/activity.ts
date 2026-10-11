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
//     sync has just written; and what the person said about an imported row
//     (its category, an exclusion) carried to the bank row that stands for it.
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

import { getItems } from './storage';
import type { Ctx } from './containers';
import { readOverridesReport, getCarriedReport, carriedCategories } from './overrides';
import { readRenamesReport } from './renames';
import { syncItemTransactions, storedItemTransactions, LOOKBACK_DAYS, type OlderTxn, type Txn, type TxnCoverage } from './transactions';
import { olderRowsForDetection, RECURRING_LOOKBACK_DAYS } from './recurring';
import type { NoTransactionsReason } from './item-products';
import type { WithoutTransactions } from './no-transactions';
import { getEffectiveHidden, liveAccountIds, type Link } from './links';
import { readManualTxnsForDisplay } from './manual-txns';
import { readAnnotations, readExclusions, getCarriedAnnotations, carriedAnnotations, type CarriedAnnotation } from './txn-annotations';
import { importedForActivity } from './history-import/read';
import type { StoredTxn } from './transactions';
import { filingSet, fileRows } from './category-store';
import { indexTaxonomy, type Taxonomy } from './categories';
import { liveTagIds, tagsForDisplay, type TagSet } from './tags';
import { applyLayers } from './txn-layers';
import { compileRules, ruleCategories, rulesForDisplay, type RuleSet, type RuleSubject } from './rules';
import { effectiveLinks, getLinks, resolveId } from './link-core';

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
 *  re-link are applied by (lib/txn-layers.ts): any is a miss. */
export type PlaidPayload = {
  plaid_only: true;
  account_types: true;
  category_facts: true;
  layer_facts: true;
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
 * What the person said about imported rows a bank row now stands for
 * (lib/history-import/read.ts importedForActivity's `represents`), by the
 * bank row: a category set on any of them (the earliest import's first), and
 * whether one was excluded (true), or whether that couldn't be read (null).
 */
async function carriedFromImports(
  ctx: Ctx,
  represents: ReadonlyMap<string, readonly string[]>,
  overrides: Readonly<Record<string, string>>
): Promise<{ categories: Map<string, string>; excluded: Map<string, true | null> }> {
  const categories = new Map<string, string>();
  const excluded = new Map<string, true | null>();
  const exclusions = await readExclusions(ctx);
  for (const [bankId, rows] of represents) {
    const category = rows.map((id) => overrides[id]).find((c) => !!c);
    if (category) categories.set(bankId, category);
    if (rows.some((id) => exclusions.records.get(id) === true)) excluded.set(bankId, true);
    else if (rows.some((id) => exclusions.unknown.has(id))) excluded.set(bankId, null);
  }
  return { categories, excluded };
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
 * same rules, further back.
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
 * surfacing transactions the person hid.
 */
export async function assembleBankRows(
  ctx: Ctx,
  opts: { sync: boolean; readOnly?: boolean; includeHidden?: boolean; withAccountIds?: boolean; since?: string }
): Promise<{
  payload: PlaidPayload;
  hidden: Set<string>;
  cacheable: boolean;
  sources: BankSource[];
  own_read: { categories: boolean; names: boolean; exclusions: boolean };
}> {
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
    carriedAnnotationsIn: carried.then((c) => c.annotations),
    withAccountIds: opts.withAccountIds,
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
    banks.then((done) => {
      const bankStates = new Map<string, Record<string, StoredTxn> | null>();
      done.forEach((r, i) => {
        if (r.stored !== undefined) bankStates.set(items[i].item_id, r.stored);
      });
      return importedForActivity(ctx, { items, links, leftOut, withAccountIds: opts.withAccountIds, bankStates, since: opts.since });
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
  // A bank row standing for imported rows the person said something about
  // takes that, unless they said otherwise on it: its own category wins, and
  // its own exclusion (finishActivity).
  const said = imported.represents.size > 0 ? await carriedFromImports(ctx, imported.represents, overrides.overrides) : null;
  for (const t of [...transactions, ...older]) {
    const manual = overrides.overrides[t.transaction_id] ?? said?.categories.get(t.transaction_id);
    if (manual) {
      t.category = manual;
      t.category_set = true;
    }
    const renamed = renames.renames[t.vendor_key];
    if (renamed) {
      t.renamed_from = t.name;
      t.name = renamed;
    }
    const excluded = said?.excluded.get(t.transaction_id);
    if (excluded !== undefined && !('pending' in t && t.pending) && t.excluded !== true) t.excluded = excluded;
  }
  const notes = [...results.map((r) => r.note).filter((n): n is string => n !== null), ...imported.notes];
  // Every one of these comes with a note, so a payload holding any is never cached.
  const incomplete = results.flatMap((r, i) =>
    r.coverage === 'complete' ? [] : [{ institution_name: items[i].institution_name, coverage: r.coverage }]
  );
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
 * Every row, the history's too, is filed into the person's categories (see
 * CATEGORIES), and `taxonomy` is the set it was filed by. `grow` is the app:
 * it seeds and grows the stored set; without it nothing is written.
 */
export async function finishActivity(
  ctx: Ctx,
  plaid: PlaidPayload,
  hidden: Set<string>,
  /** `subjects`, with `followLinks` for a rule being made that reads an
   *  account: for a rule's preview (app/api/rules/preview). */
  opts: { since?: string; grow?: boolean; subjects?: Map<string, RuleSubject>; followLinks?: boolean } = {}
): Promise<{
  transactions: Txn[];
  notes: string[];
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
}> {
  const cutoff = opts.since ?? new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  const since = new Date(Date.now() - RECURRING_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  // The manual rows back to the earlier of the two: the history's first day,
  // and the transactions' own (a report's period can start before it).
  const readFrom = cutoff < since ? cutoff : since;
  const [manual, annotations, tagRead, ruleRead] = await Promise.all([
    readManualTxnsForDisplay(ctx, { hidden, cutoff: readFrom }),
    readAnnotations(ctx),
    tagsForDisplay(ctx),
    rulesForDisplay(ctx),
  ]);
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
  // The categories first, which the rules read; then the rules, what was
  // carried across a re-link and what the person said about each row, over
  // the bank's data (lib/txn-layers.ts); then every row filed.
  const rows = [...transactions, ...candidates];
  const filed = await filingSet(ctx, rows, { grow: !!opts.grow });
  const ix = indexTaxonomy(filed.taxonomy);
  const onAccount = rulesRead(ruleRead.set, (r) => r.conditions.some((c) => c.field === 'account'));
  const links = await ruleAccounts(ctx, onAccount || !!opts.followLinks);
  const account = links.account;
  const rules = compileRules(ruleRead.set, { ix, liveTags: liveTagIds(tagRead.set), account });
  applyLayers(rows, { records: annotations.records, unknown: annotations.unknown, tags: tagRead.set, rules, ix, account, subjects: opts.subjects });
  fileRows(ix, rows);
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
    transactions,
    notes: [...plaid.notes, ...manual.notes, ...(ruleRead.note ? [ruleRead.note] : []), ...ruleNotes, ...filed.notes],
    tags_note: tagRead.note,
    ...(account ? { accountOf: account } : {}),
    incomplete: [...(plaid.incomplete ?? []), ...manual.incomplete],
    // Chosen once the exclusions are on the rows, so an excluded row neither
    // counts toward a merchant's limit nor is used.
    history: olderRowsForDetection(transactions, candidates),
    taxonomy: filed.taxonomy,
    tags: tagRead.set,
    manual_unread: manual.unread,
  };
}
