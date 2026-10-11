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
//     out of it when they went);
//   - transactions now in more than one currency count on their own, with a
//     note: a net of two currencies is no amount;
//   - one that is split as well (only two devices at once can do that: the
//     routes refuse it) counts whole in the group, its split unused, with a
//     note.
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

/** Whether an id is a part's, a remainder's or a group's row's, not a
 *  transaction's. */
export const isSplitOrGroupId = (id: string): boolean => id.startsWith(PART_PREFIX) || id.startsWith(REMAINDER_PREFIX) || id.startsWith(GROUP_PREFIX);

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
/** The fields only a part has. */
const PART_KEYS = ['split_of', 'split_index', 'split_count', 'split_excluded', 'split_remainder', 'split_parent', 'split_updated_at'] as const;

/** A whole transaction's own values (SplitParent). */
function parentFacts(t: Txn): SplitParent {
  const facts: Record<string, unknown> = {};
  for (const k of PARENT_KEYS) if (t[k] !== undefined) facts[k] = t[k];
  return facts as SplitParent;
}

/** The fields filing a row into a category gives it (lib/category-store.ts
 *  fileRows), for a category chosen by id: a part's, a group's. One no
 *  category has is the uncategorized one, shown with no name. */
function filedUnder(ix: CategoryIndex | null, c: Category | null): Pick<Txn, 'category' | 'category_id' | 'category_name' | 'category_kind'> {
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
 *  none has. */
function partRows(parent: Txn, record: SplitRecord, ix: CategoryIndex | null): { rows: Txn[]; unknownCategory: number } {
  const scale = unitScale(currencyOf(parent));
  const facts = parentFacts(parent);
  const base: Txn = { ...parent };
  for (const k of PARENT_KEYS) delete base[k];
  const left = toUnits(parent.amount, scale) - record.parts.reduce((n, p) => n + toUnits(p.amount, scale), 0);
  const count = record.parts.length + (left !== 0 ? 1 : 0);
  // When the split was saved, so an edit made from it can say what it saw.
  const of = { split_of: parent.transaction_id, split_count: count, split_parent: facts, split_updated_at: record.updated_at };
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
    // The transaction's own category, as it would be filed whole.
    const own: Partial<Txn> = {};
    for (const k of ['category', 'category_id', 'category_name', 'category_kind', 'category_by_rule', 'category_confidence'] as const) {
      if (facts[k] !== undefined) (own as Record<string, unknown>)[k] = facts[k];
    }
    rows.push({
      ...base,
      transaction_id: `${REMAINDER_PREFIX}${parent.transaction_id}`,
      amount: left / scale,
      category: facts.category ?? null,
      ...own,
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

/** A group's row: its net, in its category, with its transactions inside. */
function groupRow(id: string, g: TxnGroup, members: Txn[], missing: number, inputs: SplitInputs): Txn {
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
   *  before it counts on that day, outside what was read, so it is left out
   *  with its transactions here, as a report for a later period leaves it
   *  out; never answered at a part of its net. */
  from?: string;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The rows with each group's transactions replaced by its row, and each
 * split transaction by its parts, newest first, and what to say of what
 * couldn't be applied (see the header). `rows` are filed, as the read layer
 * files them; nothing given is changed.
 */
export function expandSplitsAndGroups(rows: readonly Txn[], inputs: SplitInputs): { rows: Txn[]; notes: string[] } {
  if (inputs.splits.size === 0 && inputs.splitsUnknown.size === 0 && inputs.groups.size === 0 && inputs.groupsUnknown === 0) return { rows: [...rows], notes: [] };
  const byId = new Map(rows.map((t) => [t.transaction_id, t]));

  // Groups first, oldest made first: a transaction in two (two devices at
  // once) counts in the first, and the other says it isn't there.
  const inGroup = new Set<string>();
  const groupRows: Txn[] = [];
  // Transactions of a group that no longer applies (their currencies differ
  // now): on their own, saying which group, so it can be ungrouped.
  const unapplied = new Map<string, { id: string; name: string }>();
  let mixed = 0;
  let splitAndGrouped = 0;
  const ordered = [...inputs.groups].sort(([a, x], [b, y]) => (x.created_at !== y.created_at ? (x.created_at < y.created_at ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0));
  for (const [id, g] of ordered) {
    const here = g.members.filter((m) => byId.has(m) && !inGroup.has(m)).map((m) => byId.get(m)!);
    if (here.length === 0) continue;
    if (new Set(here.map((t) => currencyOf(t))).size > 1) {
      mixed++;
      for (const t of here) unapplied.set(t.transaction_id, { id, name: g.name });
      continue;
    }
    if (inputs.from !== undefined && g.date < inputs.from) {
      // Counted on its day, before what was read: not here, nor its transactions.
      for (const t of here) inGroup.add(t.transaction_id);
      continue;
    }
    for (const t of here) {
      inGroup.add(t.transaction_id);
      if (inputs.splits.has(t.transaction_id)) splitAndGrouped++;
    }
    groupRows.push(groupRow(id, g, here, g.members.length - here.length, inputs));
  }

  // Then each split transaction, as its parts, in its place.
  const out: Txn[] = [];
  let unread = 0;
  let otherCurrency = 0;
  let unknownCategory = 0;
  for (const given of rows) {
    if (inGroup.has(given.transaction_id)) continue;
    const stale = unapplied.get(given.transaction_id);
    const t = stale ? { ...given, group_unapplied: stale } : given;
    const record = inputs.splits.get(t.transaction_id);
    if (record && !t.pending) {
      if (record.currency !== currencyOf(t)) {
        otherCurrency++;
        out.push({ ...t, split_unapplied: 'currency' });
        continue;
      }
      const parts = partRows(t, record, inputs.ix);
      unknownCategory += parts.unknownCategory;
      out.push(...parts.rows);
      continue;
    }
    if (inputs.splitsUnknown.has(t.transaction_id)) {
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

/** A row as bankRows answers it: a split transaction whole, with its parts. */
export type WithParts<T> = T & { split_parts?: T[] };

/**
 * Each transaction once, as the bank (or the person, entering it) has it, in
 * the order given: a split one whole again, where its first part is, with its
 * parts beside it (`split_parts`); a group's transactions each on its own, in
 * place of its net, each with its group_id. With `groups: 'keep'`, a group's
 * row stays as it is (the Activity tab lists its transactions under it).
 * Rows of any shape that carries these fields: the read layer's, the app's,
 * recurring detection's.
 */
export function bankRows<T extends object>(rows: readonly T[], opts: { groups?: 'members' | 'keep' } = {}): WithParts<T>[] {
  const out: WithParts<T>[] = [];
  const parents = new Map<string, T & { split_parts: T[] }>();
  for (const row of rows) {
    const r = row as { split_of?: unknown; split_parent?: unknown; group_members?: unknown };
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
