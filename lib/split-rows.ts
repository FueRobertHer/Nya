// lib/split-rows.ts
//
// Splits and groups (#39) applied on read, and undone for what reads each
// transaction once, as the bank has it. Pure, safe in the browser; what is
// stored is lib/splits.ts and lib/groups.ts.
//
// WHERE THEY APPLY. In the read layer every reader shares (lib/activity.ts
// finishActivity), last: after the person's own layers and the rules
// (lib/txn-layers.ts), once every row is filed into their categories
// (lib/category-store.ts fileRows). So the app, the read-only API and its MCP
// server, reports, the Plan and every total read the same rows, and none of
// them changes: they count what they are given, which is each part and each
// group's net, never the transactions those stand for.
//
// A SPLIT TRANSACTION is replaced by its parts, in its place. Each part has
// its transaction's date, merchant as shown (after renames and rules),
// account, currency, source, tags and the rules that match it, its own
// amount, category and note, and:
//   - split_of (the transaction's id), split_index (its place, from 0) and
//     split_count (how many parts there are);
//   - split_parent: what differs between a part and its whole transaction
//     (the amount, category, note and exclusion), from which bankRows puts the
//     whole transaction back for what reads it whole.
// How the transaction's own layers reach its parts:
//   - excluded (by the person, carried across a re-link, or a rule's hide):
//     every part is out, marked as the transaction is; not known (its record
//     couldn't be read): every part counts, marked so. A part can also be
//     left out on its own (split_excluded), the rest still counting;
//   - tags: on every part, so spending by tag counts each part once and the
//     whole transaction in all;
//   - its note: on the transaction (split_parent), shown on its row, not on
//     each part, which has a note of its own;
//   - a rule's category: never on a part, whose category the person chose,
//     but on the remainder (below), which is the transaction's own;
//   - a rule's name: the parts show the name the transaction shows.
// A part's category is its id, followed through a merge to where it went;
// one no category has (deleted on another device, say) is uncategorized,
// with a note.
//
// THE REMAINDER. A split is saved only when its parts add up to its
// transaction's amount, in the currency's minor units. When the bank changes
// the amount later (a tip added, part of it refunded), the difference is a
// part of its own, last (split_remainder, with the amount the parts were
// split from), filed as the transaction would be (its own category, a rule's,
// the bank's), never spread silently over the others: every total stays
// right, and the Activity tab says the bank changed the amount until the
// split is edited.
//
// A GROUP's transactions are replaced by one row, its net, in the group's
// category: dated on the group's day (its earliest transaction's when it was
// saved), its amount the sum of its transactions that are here (a $120
// dinner and $60 paid back are $60 out; a trip and its reimbursement can be
// nothing), on its first transaction's account, with the tags its
// transactions carry. Its transactions ride inside it (group_members), each
// as it is, for the Activity tab to list under it. How a group meets the
// rest:
//   - what was said about one of its transactions (an exclusion, a rule's
//     hide or category) doesn't change the net: grouping says how they count;
//   - one that isn't here (the bank removed it, its account is hidden, its
//     institution couldn't be read this time) is left out of the net, and the
//     group says how many (group_missing, and group_removed for those taken
//     out of it when they went), and why, where that is known (group_away):
//     it counts in another group (one made before it holds it, two devices
//     at once, or the bank row standing for it is in one in its own right),
//     or it is a row imported from a file that a bank row still pending
//     stands in for, counted on its own until it posts;
//   - transactions now in more than one currency count on their own, with a
//     note: a net of two currencies is no amount;
//   - one that is split as well (only two devices at once can do that: the
//     routes refuse it) counts whole in the group, its split unused, with a
//     note;
//   - a group dated before the first day read (`from`) counts on a day
//     outside what was read, so its transactions that are here are listed on
//     their own, each saying which group and on which day it counts
//     (group_outside), and count in no total (lib/spending.ts
//     countsInTotals): never a part of its net answered as the whole.
//
// A ROW IMPORTED FROM A FILE (#52) that a bank row now stands for (the bank
// sent the same transaction since, or the person said in a review that it is
// the bank's: lib/history-import/match.ts) doesn't count, and neither does
// what was made on it. Instead, as what was said about it carries to that
// bank row (lib/txn-layers.ts), so do its split and its place in a group
// (SplitInputs.stands): the bank row is answered as its parts, or counts in
// its group in its place, each part or its row in the group naming the
// imported row (split_carried_from, group_carried_from), where an edit of
// the split or the group is made, as that is where it is kept. The bank
// row's own split, or its own place in a group, comes first (the routes
// refuse to make one while it shows the imported row's: lib/txn-lookup.ts
// importedStoodFor); a pending one takes neither until it posts, as it takes
// nothing said about the row, and the group says it is pending. So
// the transaction counts once, as its parts or in its group, never as its
// parts and its twin; and the bank removing its row (or a re-link whose
// window starts later) puts the imported row back, split and grouped as it
// was.
//
// WHERE A TRANSACTION STAYS ONE ROW (bankRows): recurring detection
// (lib/recurring.ts) looks for a monthly bill in the bank's transactions,
// not in a bill's parts or a dinner's net; the read-only API lists each
// transaction once, with its parts and its group beside it; a rule's preview
// counts transactions. The stored rows never change: unsplitting or
// ungrouping shows them exactly as before.

import type { Txn } from './transactions';
import { categoryById, choiceText, groupOf, uncategorizedOf, type Category, type CategoryIndex } from './categories';
import { isCurrencyCode, knownCurrency, minorDigits } from './manual-txn-input';
import { currencyOf } from './spending';
import type { SplitRecord } from './splits';
import type { TxnGroup } from './groups';

/** The start of a part's id, of a remainder's, and of a group's row's: never
 *  a transaction's (Plaid's have no colon, a manual row's start
 *  "manual-txn:"). */
export const PART_PREFIX = 'split:';
export const REMAINDER_PREFIX = 'split-rest:';
export const GROUP_PREFIX = 'group:';
/** The rows shared expenses add (lib/shared-expenses/rows.ts): another
 *  person's part of a transaction, a part of a payment that paid something
 *  back, an IOU's row. Never a transaction's either. */
export const SHARE_PREFIX = 'share:';
export const SETTLED_PREFIX = 'settled:';
export const IOU_PREFIX = 'iou:';

// ---- Limits (lib/splits.ts, lib/groups.ts), here so the views can read them ----

/** Parts one transaction can be split into, and the fewest: one part is a
 *  category, not a split. */
export const MAX_PARTS = 20;
export const MIN_PARTS = 2;
/** Transactions in one group, and the fewest. */
export const MAX_MEMBERS = 50;
export const MIN_MEMBERS = 2;
/** A group's name: as long as a category's (lib/categories.ts NAME_MAX). */
export const GROUP_NAME_MAX = 60;

/** Whether an id is a row the read layer made, not a transaction's: a
 *  part's, a remainder's, a group's row's, or one shared expenses add.
 *  Every write made by a transaction's id refuses one. */
export const isSplitOrGroupId = (id: string): boolean =>
  id.startsWith(PART_PREFIX) || id.startsWith(REMAINDER_PREFIX) || id.startsWith(GROUP_PREFIX) || id.startsWith(SHARE_PREFIX) || id.startsWith(SETTLED_PREFIX) || id.startsWith(IOU_PREFIX);

// ---- Money ----

const scales = new Map<string, number>();

/**
 * How many of a currency's smallest units make one (100 cents to the dollar,
 * 1 yen to the yen), which splits and nets are counted in: whole units, so a
 * sum is exact. A row that says no currency is taken to be in dollars, as the
 * oldest stored history is; one without an ISO code (a cryptocurrency) is
 * counted to eight places, as Plaid gives it.
 */
export function unitScale(currency: string | null | undefined): number {
  const c = currency ?? 'USD';
  let scale = scales.get(c);
  if (scale === undefined) {
    scale = isCurrencyCode(c) && knownCurrency(c) ? 10 ** minorDigits(c) : 1e8;
    scales.set(c, scale);
  }
  return scale;
}

/** An amount in whole units of a scale (unitScale). */
export const toUnits = (amount: number, scale: number): number => Math.round(amount * scale);

// ---- The rows ----

/** What differs between a part and its whole transaction: the transaction's
 *  own values, those it has (see the header). */
export type SplitParent = Partial<
  Pick<Txn, 'category' | 'category_id' | 'category_name' | 'category_kind' | 'category_by_rule' | 'category_confidence' | 'note' | 'excluded' | 'excluded_by_rule' | 'paired'>
> & {
  /** The whole transaction's amount now: its parts, any remainder among
   *  them, add up to it. */
  amount: number;
};

/** The fields split_parent keeps, which a part has values of its own for. */
const PARENT_KEYS = [
  'amount',
  'category',
  'category_id',
  'category_name',
  'category_kind',
  'category_by_rule',
  'category_confidence',
  'note',
  'excluded',
  'excluded_by_rule',
  'paired',
] as const;
/** The fields only a part has: a split's, and those shared expenses put on
 *  the part a share comes from (lib/shared-expenses/rows.ts). */
const PART_KEYS = [
  'split_of',
  'split_index',
  'split_count',
  'split_excluded',
  'split_remainder',
  'split_parent',
  'split_updated_at',
  'split_carried_from',
  'shared',
  'shared_was',
  'shared_part',
  'shared_carried_from',
  'shared_unapplied',
] as const;

/** A whole transaction's own values (SplitParent). */
function parentFacts(t: Txn): SplitParent {
  const facts: Record<string, unknown> = {};
  for (const k of PARENT_KEYS) if (t[k] !== undefined) facts[k] = t[k];
  return facts as SplitParent;
}

/** The fields filing a row into a category gives it (lib/category-store.ts
 *  fileRows), for a category chosen by id: a part's, a group's, an IOU's
 *  (lib/shared-expenses/rows.ts). One no category has is the uncategorized
 *  one, shown with no name. */
export function filedUnder(ix: CategoryIndex | null, c: Category | null): Pick<Txn, 'category' | 'category_id' | 'category_name' | 'category_kind'> {
  if (!ix) return { category: null };
  if (c) return { category: choiceText(c), category_id: c.id, category_name: c.name, category_kind: groupOf(ix, c).kind };
  const u = uncategorizedOf(ix);
  return { category: null, category_id: u.id, category_name: null, category_kind: groupOf(ix, u).kind };
}

/** A part's exclusion: its own, else its transaction's (see the header). */
function partExcluded(parent: Txn, own: boolean): Pick<Txn, 'excluded' | 'excluded_by_rule'> {
  if (own) return { excluded: true };
  if (parent.excluded === true) return parent.excluded_by_rule ? { excluded: true, excluded_by_rule: true } : { excluded: true };
  if (parent.excluded === null) return { excluded: null };
  return {};
}

/** A split transaction's parts, in its place, and how many name a category
 *  none has. `from`, for a bank row's split carried from a row imported from
 *  a file that it stands for: that row's id, where the split is kept. */
function partRows(parent: Txn, record: SplitRecord, ix: CategoryIndex | null, from?: string): { rows: Txn[]; unknownCategory: number } {
  const scale = unitScale(currencyOf(parent));
  const facts = parentFacts(parent);
  const base: Txn = { ...parent };
  for (const k of PARENT_KEYS) delete base[k];
  const left = toUnits(parent.amount, scale) - record.parts.reduce((n, p) => n + toUnits(p.amount, scale), 0);
  const count = record.parts.length + (left !== 0 ? 1 : 0);
  // When the split was saved, so an edit made from it can say what it saw.
  const of = { split_of: parent.transaction_id, split_count: count, split_parent: facts, split_updated_at: record.updated_at, ...(from ? { split_carried_from: from } : {}) };
  let unknownCategory = 0;
  const rows = record.parts.map((p, i): Txn => {
    const c = ix ? categoryById(ix, p.category_id) : null;
    if (ix && !c) unknownCategory++;
    return {
      ...base,
      transaction_id: `${PART_PREFIX}${p.id}`,
      amount: toUnits(p.amount, scale) / scale,
      ...filedUnder(ix, c),
      category_confidence: null,
      ...(p.note ? { note: p.note } : {}),
      ...partExcluded(parent, p.excluded === true),
      ...of,
      split_index: i,
      ...(p.excluded ? { split_excluded: true as const } : {}),
    };
  });
  if (left !== 0) {
    // The transaction's own category, as it would be filed whole. Not
    // Plaid's confidence in it: the row has no category of its own to
    // answer "Check category" with (it is the transaction's, which is shown
    // as its parts), and the person split it, so has looked at it.
    const own: Partial<Txn> = {};
    for (const k of ['category', 'category_id', 'category_name', 'category_kind', 'category_by_rule'] as const) {
      if (facts[k] !== undefined) (own as Record<string, unknown>)[k] = facts[k];
    }
    rows.push({
      ...base,
      transaction_id: `${REMAINDER_PREFIX}${parent.transaction_id}`,
      amount: left / scale,
      category: facts.category ?? null,
      ...own,
      category_confidence: null,
      ...partExcluded(parent, false),
      ...of,
      split_index: record.parts.length,
      split_remainder: { was: record.amount },
    });
  }
  return { rows, unknownCategory };
}

/** Newest first, as the read layer orders rows (lib/activity.ts
 *  newestFirst); the sort is stable. */
function newestFirst(a: Txn, b: Txn): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  const at = a.datetime ?? '';
  const bt = b.datetime ?? '';
  return at < bt ? 1 : at > bt ? -1 : 0;
}

/** Why one of a group's transactions isn't counted in it, where the read
 *  layer knows: a row imported from a file that a bank row still pending
 *  stands in for (it counts on its own until it posts, and in the group
 *  then), or one that counts in another group, by that group's name. */
export type GroupAway = { why: 'pending' } | { why: 'grouped'; group: string };

/** A group's row: its net, in its category, with its transactions inside,
 *  and why those that aren't there aren't, where that is known (`away`). */
function groupRow(id: string, g: TxnGroup, members: Txn[], missing: number, inputs: SplitInputs, away: GroupAway[] = []): Txn {
  // Oldest first, as they happened; the first is the one the group counts on.
  const sorted = [...members].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const anchor = sorted[0];
  const scale = unitScale(currencyOf(anchor));
  const net = sorted.reduce((n, t) => n + toUnits(t.amount, scale), 0) / scale;
  const c = inputs.ix ? categoryById(inputs.ix, g.category_id) : null;
  const tagIds = new Set(sorted.flatMap((t) => t.tags ?? []));
  const tags = inputs.orderTags ? inputs.orderTags(tagIds) : [...tagIds];
  return {
    transaction_id: `${GROUP_PREFIX}${id}`,
    date: g.date,
    name: g.name,
    amount: net || 0,
    pending: false,
    account_name: anchor.account_name,
    account_type: anchor.account_type ?? null,
    institution_name: anchor.institution_name,
    ...filedUnder(inputs.ix, c),
    iso_currency_code: anchor.iso_currency_code,
    unofficial_currency_code: anchor.unofficial_currency_code ?? null,
    vendor_key: '',
    logo_url: null,
    category_icon_url: null,
    subcategory: null,
    category_confidence: null,
    transaction_code: null,
    payment_channel: null,
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: null,
    region: null,
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
    ...(anchor.source !== undefined ? { source: anchor.source } : {}),
    ...(anchor.account_id !== undefined ? { account_id: anchor.account_id } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    group_id: id,
    group_members: sorted.map((t) => ({ ...t, group_id: id })),
    ...(missing > 0 ? { group_missing: missing } : {}),
    ...(g.removed ? { group_removed: g.removed } : {}),
    ...(away.length > 0 ? { group_away: away } : {}),
  };
}

/** What the rows are expanded with. */
export type SplitInputs = {
  /** The splits, by transaction id (lib/splits.ts readSplitsForDisplay). */
  splits: ReadonlyMap<string, SplitRecord>;
  /** The transactions whose split couldn't be read or isn't recognised. */
  splitsUnknown: ReadonlySet<string>;
  /** The groups, by id (lib/groups.ts readGroupsForDisplay). */
  groups: ReadonlyMap<string, TxnGroup>;
  /** How many groups couldn't be read or aren't recognised. */
  groupsUnknown: number;
  /** The categories the rows were filed by: a part's and a group's by id. */
  ix: CategoryIndex | null;
  /** Orders tag ids as the tags were made (lib/tags.ts orderTagIds). */
  orderTags?: (ids: ReadonlySet<string>) => string[];
  /** The first day the rows were read from (lib/activity.ts): a group dated
   *  before it counts on that day, outside what was read, so its
   *  transactions here are listed, marked (group_outside), and counted in no
   *  total, as a report for a later period counts none of it; never a part
   *  of its net answered as the whole. */
  from?: string;
  /** For a reader that keeps the rows of accounts that ended and leaves
   *  them out itself (lib/activity.ts keepEnded, as a report does), each
   *  account's end day (lib/lifecycle.ts endDays). A row on one, dated from
   *  it, is left as it is, never split nor in a group, so the reader leaves
   *  it out whole, and a group nets only its transactions still counting,
   *  as everywhere else (where those rows were never read). */
  ended?: ReadonlyMap<string, string>;
  /** For each bank row standing for rows imported into its account from
   *  files (#52: lib/history-import/read.ts importedForActivity's
   *  `represents`, which the read layer carries on the row as `stands_for`),
   *  those rows' ids, earlier imports first. A split made on one of them, or
   *  its place in a group, is the bank row's while it stands for it, if the
   *  bank row is posted and has none of its own (see the header); a group
   *  one of them is in, whose bank row is still pending, says so. */
  stands?: ReadonlyMap<string, readonly string[]>;
};

/** What a transaction of a group counted outside what was read carries
 *  (SplitInputs.from): the group, its day and category, how many of its
 *  transactions are here, and how many aren't. */
export type GroupOutside = { id: string; name: string; date: string; category_id: string; here: number; missing: number };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The split that applies to a transaction: its own, else the first of those
 * of the rows imported from files it stands for (`stands`, earlier imports
 * first), with that row's id (`from`); 'unread' when the one that would apply
 * couldn't be read, so it shows whole; null for none. For a posted row (a
 * pending one is never split), by the read layer's own rule
 * (expandSplitsAndGroups), which a download's note counts by too.
 */
export function splitFor(
  inputs: Pick<SplitInputs, 'splits' | 'splitsUnknown'>,
  id: string,
  stands: readonly string[] = []
): { record: SplitRecord; from?: string } | 'unread' | null {
  const own = inputs.splits.get(id);
  if (own) return { record: own };
  if (inputs.splitsUnknown.has(id)) return 'unread';
  for (const from of stands) {
    const record = inputs.splits.get(from);
    if (record) return { record, from };
    if (inputs.splitsUnknown.has(from)) return 'unread';
  }
  return null;
}

/**
 * The rows with each group's transactions replaced by its row, and each
 * split transaction by its parts, newest first, and what to say of what
 * couldn't be applied (see the header). `rows` are filed, as the read layer
 * files them; nothing given is changed.
 */
export function expandSplitsAndGroups(rows: readonly Txn[], inputs: SplitInputs): { rows: Txn[]; notes: string[] } {
  if (inputs.splits.size === 0 && inputs.splitsUnknown.size === 0 && inputs.groups.size === 0 && inputs.groupsUnknown === 0) return { rows: [...rows], notes: [] };
  // A row of an account that ended, from its end day: as it is, for the
  // reader to leave out (SplitInputs.ended).
  const endedRow = (t: Txn): boolean => {
    const end = t.account_id === undefined ? undefined : inputs.ended?.get(t.account_id);
    return end !== undefined && t.date >= end;
  };
  const byId = new Map(rows.filter((t) => !endedRow(t)).map((t) => [t.transaction_id, t]));
  // The rows imported from files that a posted bank row here stands for
  // (SplitInputs.stands): by each bank row, those of them not here
  // themselves, earlier imports first, and by each of them, the bank row.
  // And those a pending one stands in for, until it posts.
  const standsFor = new Map<string, string[]>();
  const standIn = new Map<string, Txn>();
  const pendingFor = new Set<string>();
  for (const [bankId, ids] of inputs.stands ?? []) {
    const bank = byId.get(bankId);
    if (!bank) continue;
    const away = ids.filter((id) => !byId.has(id));
    if (away.length === 0) continue;
    if (bank.pending) {
      for (const id of away) pendingFor.add(id);
      continue;
    }
    standsFor.set(bankId, away);
    for (const id of away) if (!standIn.has(id)) standIn.set(id, bank);
  }
  // The split that applies to a row (splitFor), over the imported rows a
  // posted one here stands for.
  const splitOf = (t: Txn) => splitFor(inputs, t.transaction_id, standsFor.get(t.transaction_id));
  const isSplit = (t: Txn) => {
    const split = splitOf(t);
    return split !== null && split !== 'unread';
  };
  // Groups first, oldest made first: a transaction in two (two devices at
  // once) counts in the first, and the other says it isn't there.
  const ordered = [...inputs.groups].sort(([a, x], [b, y]) => (x.created_at !== y.created_at ? (x.created_at < y.created_at ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0));
  // Every transaction in a group in its own right, with that group's name
  // (the first made): that place comes before one a bank row takes from an
  // imported row it stands for.
  const ownGroup = new Map<string, string>();
  for (const [, g] of ordered) for (const m of g.members) if (!ownGroup.has(m)) ownGroup.set(m, g.name);
  // Taken by a group made earlier (a transaction counts in one), with its
  // name, and of those, the ones in a group's row rather than on their own.
  const claimed = new Map<string, string>();
  const inGroup = new Set<string>();
  // Those of a group counted on a day before what was read.
  const outside = new Map<string, GroupOutside>();
  const groupRows: Txn[] = [];
  // Transactions of a group that no longer applies (their currencies differ
  // now): on their own, saying which group, so it can be ungrouped.
  const unapplied = new Map<string, { id: string; name: string }>();
  let mixed = 0;
  let splitAndGrouped = 0;
  for (const [id, g] of ordered) {
    // Each of its transactions here, or the bank row standing for it, and
    // why one that isn't counted here isn't, where that is known.
    const here: Txn[] = [];
    const away: GroupAway[] = [];
    for (const m of g.members) {
      const own = byId.get(m);
      const t = own ?? standIn.get(m);
      if (!t) {
        if (pendingFor.has(m)) away.push({ why: 'pending' });
        continue;
      }
      if (here.some((x) => x.transaction_id === t.transaction_id)) continue;
      const taken = claimed.get(t.transaction_id);
      if (taken !== undefined) {
        away.push({ why: 'grouped', group: taken });
        continue;
      }
      if (!own && ownGroup.has(t.transaction_id)) {
        // Its own place: here too, when it is this group's own.
        if (!g.members.includes(t.transaction_id)) away.push({ why: 'grouped', group: ownGroup.get(t.transaction_id)! });
        continue;
      }
      here.push(own ?? { ...t, group_carried_from: m });
    }
    if (here.length === 0) continue;
    if (new Set(here.map((t) => currencyOf(t))).size > 1) {
      mixed++;
      for (const t of here) unapplied.set(t.transaction_id, { id, name: g.name });
      continue;
    }
    if (inputs.from !== undefined && g.date < inputs.from) {
      // Counted on its day, before what was read: its transactions here are
      // listed, marked, and counted nowhere in what was read.
      const marked: GroupOutside = { id, name: g.name, date: g.date, category_id: g.category_id, here: here.length, missing: g.members.length - here.length + (g.removed ?? 0) };
      for (const t of here) {
        claimed.set(t.transaction_id, g.name);
        outside.set(t.transaction_id, marked);
        if (isSplit(t)) splitAndGrouped++;
      }
      continue;
    }
    for (const t of here) {
      claimed.set(t.transaction_id, g.name);
      inGroup.add(t.transaction_id);
      if (isSplit(t)) splitAndGrouped++;
    }
    groupRows.push(groupRow(id, g, here, g.members.length - here.length, inputs, away));
  }

  // Then each split transaction, as its parts, in its place.
  const out: Txn[] = [];
  let unread = 0;
  let otherCurrency = 0;
  let unknownCategory = 0;
  for (const given of rows) {
    if (inGroup.has(given.transaction_id)) continue;
    if (endedRow(given)) {
      out.push(given);
      continue;
    }
    const before = outside.get(given.transaction_id);
    if (before) {
      // As it is, its split unused as in any group, counted in no total.
      out.push({ ...given, group_id: before.id, group_outside: before });
      continue;
    }
    const stale = unapplied.get(given.transaction_id);
    const t = stale ? { ...given, group_unapplied: stale } : given;
    const split = splitOf(t);
    if (split && split !== 'unread' && !t.pending) {
      if (split.record.currency !== currencyOf(t)) {
        otherCurrency++;
        out.push({ ...t, split_unapplied: 'currency' });
        continue;
      }
      const parts = partRows(t, split.record, inputs.ix, split.from);
      unknownCategory += parts.unknownCategory;
      out.push(...parts.rows);
      continue;
    }
    if (split === 'unread') {
      unread++;
      out.push({ ...t, split_unread: true });
      continue;
    }
    out.push(t);
  }

  const notes = [
    ...(unread > 0
      ? [`How you split ${plural(unread, 'transaction', 'transactions')} couldn’t be read, so ${unread === 1 ? 'it shows' : 'they show'} whole until ${unread === 1 ? 'it' : 'they'} can be.`]
      : []),
    ...(otherCurrency > 0
      ? [
          `${plural(otherCurrency, 'split transaction is', 'split transactions are')} in another currency now than when ${otherCurrency === 1 ? 'it was' : 'they were'} split, so ${otherCurrency === 1 ? 'it shows' : 'they show'} whole until you split ${otherCurrency === 1 ? 'it' : 'them'} again.`,
        ]
      : []),
    ...(unknownCategory > 0
      ? [`${plural(unknownCategory, 'part of your split transactions is', 'parts of your split transactions are')} under a category that no longer exists, so ${unknownCategory === 1 ? 'it is' : 'they are'} uncategorized until you edit the split.`]
      : []),
    ...(inputs.groupsUnknown > 0
      ? [`${plural(inputs.groupsUnknown, 'of your groups', 'of your groups')} couldn’t be read, so ${inputs.groupsUnknown === 1 ? 'its transactions count' : 'their transactions count'} on their own until ${inputs.groupsUnknown === 1 ? 'it' : 'they'} can be.`]
      : []),
    ...(mixed > 0
      ? [`The transactions in ${plural(mixed, 'of your groups are', 'of your groups are')} in more than one currency now, so they count on their own, since a group nets one currency. Ungroup ${mixed === 1 ? 'it' : 'them'} from one of ${mixed === 1 ? 'its' : 'their'} transactions.`]
      : []),
    ...(splitAndGrouped > 0
      ? [
          `${plural(splitAndGrouped, 'transaction in a group is', 'transactions in groups are')} split too, so ${splitAndGrouped === 1 ? 'its parts aren’t' : 'their parts aren’t'} used and the group counts ${splitAndGrouped === 1 ? 'it' : 'them'} whole.`,
        ]
      : []),
  ];
  return { rows: [...out, ...groupRows].sort(newestFirst), notes };
}

// ---- Each transaction once ----

/** The whole transaction a part is of, as it would be unsplit: the part with
 *  its transaction's own values back (split_parent) and its own taken off. */
export function parentOf<T extends object>(part: T): T {
  const row = { ...part } as Record<string, unknown>;
  const facts = row.split_parent as SplitParent;
  for (const k of [...PARENT_KEYS, ...PART_KEYS]) delete row[k];
  Object.assign(row, facts);
  row.transaction_id = (part as { split_of?: string }).split_of;
  return row as T;
}

/** A row as bankRows answers it: a split transaction whole, with its parts;
 *  a shared transaction or a payment whole, with the rows shared expenses
 *  made of it. */
export type WithParts<T> = T & { split_parts?: T[]; shared_parts?: T[] };

/**
 * Each transaction once, as the bank (or the person, entering it) has it, in
 * the order given: a split one whole again, where its first part is, with its
 * parts beside it (`split_parts`); a group's transactions each on its own, in
 * place of its net, each with its group_id. With `groups: 'keep'`, a group's
 * row stays as it is (the Activity tab lists its transactions under it).
 * Shared expenses (lib/shared-expenses/rows.ts): an unsplit shared
 * transaction, or a payment, is its own row at the amount it had
 * (`shared_was`), with the rows made of it beside it (`shared_parts`); a split
 * one's are among its `split_parts`; an IOU's row, which is no transaction,
 * is left out unless `ious: 'keep'` (the Activity tab lists it).
 * Rows of any shape that carries these fields: the read layer's, the app's,
 * recurring detection's.
 */
export function bankRows<T extends object>(rows: readonly T[], opts: { groups?: 'members' | 'keep'; ious?: 'keep' } = {}): WithParts<T>[] {
  const out: WithParts<T>[] = [];
  const parents = new Map<string, T & { split_parts: T[] }>();
  // A shared transaction's or a payment's own row, by its id, so it is the
  // whole one whichever of its rows comes first.
  const owners = new Map<string, T>();
  for (const row of rows) {
    const r = row as { transaction_id?: unknown; shared_of?: unknown; split_of?: unknown };
    if (typeof r.shared_of === 'string' && r.split_of === undefined && r.transaction_id === r.shared_of) owners.set(r.shared_of, row);
  }
  const shared = new Map<string, T & { shared_parts: T[] }>();
  for (const row of rows) {
    const r = row as { split_of?: unknown; split_parent?: unknown; group_members?: unknown; shared_of?: unknown; shared_iou?: unknown; shared_was?: unknown };
    if (r.shared_iou !== undefined) {
      if (opts.ious === 'keep') out.push(row);
      continue;
    }
    if (typeof r.shared_of === 'string' && r.split_of === undefined) {
      let p = shared.get(r.shared_of);
      if (!p) {
        const owner = (owners.get(r.shared_of) ?? row) as T & { shared_was?: number; shared_of?: string; amount?: number };
        const whole = { ...owner, shared_parts: [] as T[] } as T & { shared_parts: T[]; shared_was?: number; shared_of?: string; amount?: number };
        if (typeof owner.shared_was === 'number') whole.amount = owner.shared_was;
        delete whole.shared_was;
        delete whole.shared_of;
        p = whole;
        shared.set(r.shared_of, p);
        out.push(p);
      }
      p.shared_parts.push(row);
      continue;
    }
    if (Array.isArray(r.group_members) && opts.groups !== 'keep') {
      out.push(...(r.group_members as T[]));
      continue;
    }
    if (typeof r.split_of === 'string' && r.split_parent) {
      let p = parents.get(r.split_of);
      if (!p) {
        p = { ...parentOf(row), split_parts: [] };
        parents.set(r.split_of, p);
        out.push(p);
      }
      p.split_parts.push(row);
      continue;
    }
    out.push(row);
  }
  return out;
}
