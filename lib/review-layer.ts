// lib/review-layer.ts
//
// The review queue and merchants' default categories, applied on read: one
// function (applyReview) that lib/txn-layers.ts calls for each row, after the
// rules and before the row is filed, in the read layer every reader shares
// (lib/activity.ts finishActivity: the app, the read-only API and its MCP
// server, reports, recurring detection, budgets and the Plan; the download
// applies the same layers, lib/export-layers.ts). Pure, safe in the browser,
// which reads the marks it leaves (needsReview, approvalOf) and builds what it
// approves from the rows it shows (approvalInputOf).
//
// WHAT IT DOES TO A ROW, in this order:
//   1. A MERCHANT'S DEFAULT (lib/vendor-defaults.ts) files the row when
//      nothing more specific does: not the person's own category, not a
//      rule's; and only a row dated on or after the day the default was set,
//      in the category it had on the row's day (a default that moved keeps
//      filing what came before the move as it did: defaultOn). It goes in
//      the layers' slot of resolveCategory (rule_category), with its words,
//      as a rule's category does, marked `filed_by_default` with the
//      merchant's entry and how many of its last three categorizations
//      agree, for "Filed by your default for Costco (two of your last three)".
//   2. AN APPROVAL (lib/review-store.ts) under the row's id, or, for a posted
//      row, under the pending one it replaced (`pending_from`, until the sync
//      that removes the pending one moves it) or under a row imported from a
//      file that it stands for (`stands_for`): the same transaction, so the
//      same approval (`review_via` names where it is kept).
//        - While there is one, the row is never moved to another category by
//          what isn't the person: when a rule, a default or the bank would
//          now file it elsewhere, it stays where it was approved and the
//          other is offered (`review_suggestion`, "Your rule would file it
//          under Household"), never applied unasked. Approved with no
//          category (the uncategorized one), it takes what a rule or a
//          default gives it later, which fills an empty place. The person's
//          own category always shows, approved or not.
//        - It holds while the amount and currency are what was approved, in
//          the currency's minor units: then the row is approved
//          (`reviewed_at`). A name that changed since (a rule's, the bank's,
//          the person's rename) shows, with the name it was approved under
//          beside it (`approved_name`): a name never changes a total, and the
//          merchant's rows stay named alike.
//        - A bank that changed the amount since (a tip added, part refunded)
//          puts it back in the queue, saying from what (`review_changed`),
//          still filed where it was approved, so the category the person
//          chose never goes with the amount. A split transaction's parts then
//          show the difference as a part of its own (lib/split-rows.ts),
//          filed as the transaction is, so nothing is spread silently over
//          what was approved.
//   3. NEEDS REVIEW (`needs_review`): with the queue on, a row from the bank,
//      SimpleFIN or a file (never one entered by hand), dated on or after the
//      day the queue starts, without an approval that holds. An approval
//      that can't be read leaves the row's review not known
//      (`review_unknown`), never "needs review": that would put an approved
//      transaction back in the queue. So do settings that can't be read.
// Only the rows of the year the Activity tab lists carry the marks; the rows
// before it, which only recurring detection reads, are filed by the same
// defaults and approvals and carry none.

import type { OlderTxn, Txn } from './transactions';
import type { Approval, ApprovalInput } from './review-store';
import { defaultOn, defaultsByVendor, type DefaultFor, type VendorDefaults } from './vendor-defaults';
import { categoryById, choiceText, isProvisionalId, resolveCategory, type Category, type CategoryIndex } from './categories';
import { toUnits, unitScale } from './split-rows';
import { currencyOf } from './spending';
import { isConnectorKind } from './connectors/types';

/** Transactions one request approves or puts back (app/api/review): a bulk
 *  approval of more is sent in batches of this many. */
export const MAX_PER_REQUEST = 500;
/** How many days before today the queue may start: the last month, never
 *  years of history. */
export const MAX_SINCE_DAYS = 31;
/** A merchant's name as an approval takes it. */
export const MAX_NAME_CHARS = 300;

/** What the read layer reads for the review queue and the defaults. */
export type ReviewLayer = {
  /** The approvals of the rows read (lib/review-store.ts readApprovalsForDisplay). */
  approvals: ReadonlyMap<string, Approval>;
  /** The ids whose approval couldn't be read or isn't recognised. */
  approvalsUnknown: ReadonlySet<string>;
  /** Each merchant's default, by vendor key (lib/vendor-defaults.ts defaultsByVendor). */
  defaults: ReadonlyMap<string, DefaultFor>;
  /** The queue: on from a day, off (null), or not known (its settings
   *  couldn't be read). */
  queue: { since: string } | null | 'unknown';
};

/** What would file an approved row elsewhere now, offered rather than
 *  applied: the category, and whose it is (a rule's, with its id; a
 *  merchant's default; or the bank's own, or the row's words). */
export type ReviewSuggestion = { category_id: string; by: 'rule' | 'default' | 'bank'; rule_id?: string };

/** The marks this layer leaves on a listed row (see the header). */
export type ReviewMarks = {
  needs_review?: true;
  reviewed_at?: string;
  review_unknown?: true;
  review_changed?: { amount: number; currency: string | null };
  review_via?: string;
  review_suggestion?: ReviewSuggestion;
  approved_name?: string;
  /** Filed by the merchant's default: its entry, how many of the last three
   *  agree with it now, and `earlier` when the category it filed the row
   *  under is one it had before it moved. */
  filed_by_default?: { id: string; agree: number; earlier?: true };
};

const MARKS = ['needs_review', 'reviewed_at', 'review_unknown', 'review_changed', 'review_via', 'review_suggestion', 'approved_name', 'filed_by_default'] as const;

/** What applyReview needs to know of the row from the layers before it. */
export type ReviewFacts = {
  ix: CategoryIndex | null;
  /** The person's own category, as it was before any rule (lib/categories.ts
   *  ownCategory): what nothing here ever replaces. */
  own: Category | null;
  /** The rule whose category the row was just given, or null. */
  ruleId: string | null;
  /** A row the Activity tab lists (one of the year's), which carries marks. */
  listed: boolean;
  /** One side of a pair worked out between two SimpleFIN accounts, whose
   *  category is the pair's (lib/manual-txns.ts). */
  paired: boolean;
};

type Row = Txn | OlderTxn;

/** Whether a row is one the queue reviews: from the bank (no source), a
 *  connector (SimpleFIN) or a file, never one entered by hand, nor a group's
 *  row (its transactions are reviewed each). */
export function reviewable(t: { source?: string; group_members?: unknown }): boolean {
  if (t.group_members) return false;
  return t.source === undefined || isConnectorKind(t.source) || t.source.startsWith('import:');
}

/** Whether an approval's amount and currency are still the row's, in the
 *  currency's minor units (cents, whole yen). */
export function sameAmount(a: Pick<Approval, 'amount' | 'currency'>, t: Pick<Txn, 'amount' | 'iso_currency_code' | 'unofficial_currency_code'>): boolean {
  const currency = currencyOf(t);
  if (a.currency !== currency) return false;
  const scale = unitScale(currency);
  return toUnits(a.amount, scale) === toUnits(t.amount, scale);
}

/** The approval that applies to a row: its own, else, for a posted row, the
 *  pending one's it replaced or that of a row imported from a file it stands
 *  for (`via`); `unknown` when the one that would apply couldn't be read. */
export function approvalFor(t: Row, layer: Pick<ReviewLayer, 'approvals' | 'approvalsUnknown'>): { approval: Approval | null; via?: string; unknown: boolean } {
  const own = layer.approvals.get(t.transaction_id);
  if (own) return { approval: own, unknown: false };
  if (layer.approvalsUnknown.has(t.transaction_id)) return { approval: null, unknown: true };
  const pending = 'pending' in t && t.pending;
  const from = [...('pending_from' in t && t.pending_from ? [t.pending_from] : []), ...(!pending ? (t.stands_for ?? []) : [])];
  for (const id of from) {
    const a = layer.approvals.get(id);
    if (a) return { approval: a, via: id, unknown: false };
    if (layer.approvalsUnknown.has(id)) return { approval: null, unknown: true };
  }
  return { approval: null, unknown: false };
}

/** Applies the defaults and the approvals to one row, in place (see the
 *  header). */
export function applyReview(t: Row, layer: ReviewLayer, f: ReviewFacts): void {
  const marks = t as Row & ReviewMarks;
  if (f.listed) for (const k of MARKS) delete marks[k];

  // 1. A merchant's default, below the person's own and a rule's, in the
  //    category it had on the row's day.
  let byDefault: DefaultFor | null = null;
  if (f.ix && !f.own && !f.paired && f.ruleId === null && t.vendor_key) {
    const d = layer.defaults.get(t.vendor_key);
    const on = d ? defaultOn(d, t.date) : null;
    const c = on ? categoryById(f.ix, on.category_id) : null;
    if (d && on && c) {
      t.rule_category = c.id;
      t.category = choiceText(c);
      byDefault = d;
      if (f.listed) marks.filed_by_default = { id: d.id, agree: d.agree, ...(on.earlier ? { earlier: true as const } : {}) };
    }
  }

  // 2. An approval keeps the row filed where it was approved for as long as
  //    there is one; whether it holds (the amount still the approved one)
  //    decides only whether the row is approved or back in the queue.
  const { approval, via, unknown } = approvalFor(t, layer);
  if (approval) {
    const pinned = f.ix && !f.own && !f.paired && approval.category_id !== null ? categoryById(f.ix, approval.category_id) : null;
    // Approved with no category, it takes one a rule or a default gives it
    // later: that fills an empty place, it overwrites nothing.
    if (pinned && pinned.id !== f.ix!.taxonomy.uncategorized) {
      const now = resolveCategory(f.ix!, t).category;
      if (now.id !== pinned.id) {
        t.rule_category = pinned.id;
        t.category = choiceText(pinned);
        if (f.listed) {
          delete (t as Txn).category_by_rule;
          delete marks.filed_by_default;
          marks.review_suggestion = { category_id: now.id, by: f.ruleId ? 'rule' : byDefault ? 'default' : 'bank', ...(f.ruleId ? { rule_id: f.ruleId } : {}) };
        }
      }
    }
    if (f.listed && via) marks.review_via = via;
    if (sameAmount(approval, t)) {
      if (f.listed) {
        marks.reviewed_at = approval.approved_at;
        if (approval.name !== t.name) marks.approved_name = approval.name;
      }
      return;
    }
  }

  // 3. Whether it needs review: only the year's rows say.
  if (!f.listed) return;
  if (approval) marks.review_changed = { amount: approval.amount, currency: approval.currency };
  if (unknown || layer.queue === 'unknown') {
    if (reviewable(t)) marks.review_unknown = true;
    return;
  }
  if (layer.queue && reviewable(t) && t.date >= layer.queue.since) marks.needs_review = true;
}

// ---- From what was read ----

/** What the layer is built from, as read (lib/review-read.ts) or as a
 *  download holds it (lib/export-layers.ts). */
export type ReviewParts = {
  settings: { on: boolean; since: string } | null;
  /** The settings couldn't be read (damaged, or a later release's). */
  settingsUnread: boolean;
  defaults: VendorDefaults | null;
  defaultsUnread: boolean;
  approvals: ReadonlyMap<string, Approval>;
  approvalsUnknown: ReadonlySet<string>;
};

/** The layer, and what to say of what couldn't be read: `notes`, which
 *  change what a total counts (a default that files nothing, an approval
 *  that holds nothing), and `queueNote`, which only changes what is marked
 *  to review, for a reader that shows those marks (the app). */
export function reviewLayerOf(parts: ReviewParts, ix: CategoryIndex | null): { layer: ReviewLayer; notes: string[]; queueNote: string | null } {
  const resolve = (id: string) => (ix ? (categoryById(ix, id)?.id ?? null) : null);
  const queue = parts.settingsUnread ? 'unknown' : parts.settings?.on ? { since: parts.settings.since } : null;
  const n = parts.approvalsUnknown.size;
  const notes = [
    ...(parts.defaultsUnread ? ["Your merchants’ default categories couldn’t be read, so none files a transaction until they can be."] : []),
    ...(n > 0
      ? [`Your approval of ${n === 1 ? '1 transaction' : `${n} transactions`} couldn’t be read, so ${n === 1 ? 'it shows' : 'they show'} as the bank, your rules and your defaults file ${n === 1 ? 'it' : 'them'} now, and whether ${n === 1 ? 'it needs' : 'they need'} review isn’t known, until ${n === 1 ? 'it' : 'they'} can be.`]
      : []),
  ];
  return {
    layer: {
      approvals: parts.approvals,
      approvalsUnknown: parts.approvalsUnknown,
      defaults: parts.defaultsUnread ? new Map() : defaultsByVendor(parts.defaults, resolve),
      queue,
    },
    notes,
    queueNote: parts.settingsUnread ? "Your review queue’s settings couldn’t be read, so nothing is marked to review until they can be." : null,
  };
}

/** The ids whose approvals a read needs for these rows: each row's own, and
 *  a posted row's pending one and the imported rows it stands for. */
export function approvalIdsOf(rows: Iterable<Row>): string[] {
  const ids = new Set<string>();
  for (const t of rows) {
    ids.add(t.transaction_id);
    if ('pending_from' in t && t.pending_from) ids.add(t.pending_from);
    if (!('pending' in t && t.pending)) for (const id of t.stands_for ?? []) ids.add(id);
  }
  return [...ids];
}

// ---- For the views ----

/** What the views read of a row's review. */
export type Reviewed = ReviewMarks & { split_of?: string; group_members?: readonly ReviewMarks[] };

/** Whether a row as the Activity tab lists it needs review: a transaction (or
 *  a part of one) that does, or a group's row with one that does. */
export function needsReview(t: Reviewed): boolean {
  return t.needs_review === true || !!t.group_members?.some((m) => m.needs_review === true);
}

/** How many transactions the rows hold that need review, counted as
 *  transactions are (lib/spending.ts transactionCounter): a split one once,
 *  however many parts, and each of a group's on its own. */
export function countToReview(rows: Iterable<Reviewed>): number {
  const splits = new Set<string>();
  let n = 0;
  for (const t of rows) {
    if (t.group_members) n += t.group_members.filter((m) => m.needs_review === true).length;
    else if (t.split_of !== undefined) {
      if (t.needs_review) splits.add(t.split_of);
    } else if (t.needs_review) n++;
  }
  return n + splits.size;
}

/** What an approval of a whole transaction (a split one put back whole, one
 *  of a group's on its own: lib/split-rows.ts bankRows) says it was: as the
 *  row shows it. A provisional category id (categories that couldn't be
 *  read, lib/categories.ts) is never kept. */
export function approvalInputOf(t: Pick<Txn, 'transaction_id' | 'amount' | 'iso_currency_code' | 'unofficial_currency_code' | 'category_id' | 'name' | 'pending'>): ApprovalInput {
  return {
    transaction_id: t.transaction_id,
    amount: t.amount,
    currency: currencyOf(t),
    category_id: t.category_id && !isProvisionalId(t.category_id) ? t.category_id : null,
    name: t.name,
    pending: t.pending,
  };
}
