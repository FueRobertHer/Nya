// lib/shared-expenses/rows.ts
//
// Shared expenses (#49) applied on read, last in the read layer every reader
// shares (lib/activity.ts finishActivity), after splits and groups
// (lib/split-rows.ts expandSplitsAndGroups). Pure, safe in the browser; what
// is kept is lib/shared-expenses/model.ts.
//
// THE RULE. Your part counts, on the day it was bought, in what it was for;
// money moving between you and another person counts as neither spending nor
// income. So, with `counting: 'part'`:
//   - A SHARED TRANSACTION (or the split part a share names) keeps its row,
//     its id and everything on it, at your part (`shared`, `shared_was` the
//     amount before), and beside it, for each other person, a row of their
//     part (`share:<entry id>`), excluded, so no total counts it.
//   - A PAYMENT the person confirmed keeps its row at what is left of it
//     (`settles`), and beside it, for each item it pays back, a row of that
//     much (`settled:<row id>:<item id>`), excluded: money back to you is no
//     income, your payment to them no spending.
//   - AN IOU you owe, naming the category of what your part was for, is a
//     row of its own on its day (`iou:<id>`), on no account, in that
//     category: your part of something someone else paid counts once,
//     however it is settled (a payment, cash, netted against what they owe
//     you). Its row says how much of it was settled outside your accounts
//     (`shared_iou.cash`), which the Plan counts with the cash spending
//     entered by hand, so an ATM withdrawal handed over isn't counted twice.
// With `counting: 'bank'` (or a setting that can't be read) the rows only
// carry the marks, at their own amounts: every total is what it is without
// this feature.
//
// EACH BANK ROW'S ROWS ADD UP TO IT, in its currency's minor units, so what
// moved on an account stays what it was (goals, the download's `amount`), and
// lib/split-rows.ts bankRows puts it back whole: an unsplit one's rows share
// `shared_of` (its id); a split one's keep their `split_of`. The rows this
// layer adds are excluded where they don't count, carry no review marks (so
// a shared transaction is reviewed once), and are told apart by their marks
// (`shared_part`, `shared_iou`), never by their ids: they never vote on the
// totals' currency (lib/spending.ts totalsCurrency) and are never evidence of
// what an account holds (lib/spending.ts isHistoryRow).
//
// WHAT DOESN'T APPLY, AND SAYS SO. A share or a payment whose row isn't here
// isn't applied (a hidden account, a row outside what was read, a row not
// read this time); one whose row this read can tell is gone (its account is
// here, not hidden, with rows on both sides of its day) is named in `gone`
// and noted, never pruned: what someone owes doesn't change on its own. A
// share on a transaction now grouped, split without naming a part, of
// another currency, or smaller than its entries now, counts the transaction
// whole (`shared_unapplied`); a payment on a row now split, grouped, shared
// (the share wins: it is the person's word about spending), of another
// currency, or that can't hold what it pays back now, counts the row as the
// bank shows it (`settles_unapplied`). An allocation to an item that no
// longer exists is left out: that much of the row counts as it says.
//
// ROWS IMPORTED FROM FILES (#52). A bank row standing for rows imported into
// its account takes their share and payment, as it takes their split, unless
// it has its own (`shared_carried_from` names where an edit goes); one with
// its own whose imported row has one too is marked `shared_twice`.

import type { Txn } from '../transactions';
import { categoryById, type CategoryIndex } from '../categories';
import { currencyOf, isExcluded, isTransfer } from '../spending';
import { isCurrencyCode } from '../manual-txn-input';
import { filedUnder, IOU_PREFIX, PART_PREFIX, SETTLED_PREFIX, SHARE_PREFIX, toUnits, unitScale } from '../split-rows';
import { itemState, itemsOf, paidOf, closedUnits, type Item } from './balances';
import type { Counting, Iou, Payment, Share } from './model';
import { appOf } from './match';

// ---- The marks ----

/** On a shared transaction's own row (or the split part's): who owes which
 *  part, by person and item (ids only), your part, and whether this read
 *  counts it so (false under `bank`). */
export type SharedMark = { part?: string; your_part: number; people: { person: string; item: string; amount: number }[]; counted: boolean };
/** On a payment's own row: what it pays back, each item with its direction,
 *  what is left of the row, and whether this read counts it so. */
export type SettlesMark = { rest: number; people: { person: string; item: string; amount: number; direction: 'to_you' | 'by_you' }[]; counted: boolean };
/** On a row this layer added beside a transaction: another person's part of
 *  it, or a part of a payment that paid an item back. */
export type SharedPart = { kind: 'theirs' | 'repaid'; person: string; item: string };
/** On an IOU's row: whose, which, and how much of it was settled outside
 *  your accounts. */
export type SharedIou = { person: string; item: string; cash: number };

export type SharedUnapplied = 'group' | 'split' | 'part' | 'currency' | 'amount';
export type SettlesUnapplied = 'shared' | 'split' | 'group' | 'currency' | 'amount';

/** Whether a row was added by this layer (another's part, a paid-back part,
 *  an IOU): by its marks. */
export const isLayerRow = (t: { shared_part?: unknown; shared_iou?: unknown }): boolean => t.shared_part !== undefined || t.shared_iou !== undefined;

// ---- Inputs ----

export type ShareInputs = {
  counting: Counting;
  /** The setting couldn't be read: counted as `bank`, with a note. */
  settingsUnread?: boolean;
  /** Every share, by transaction id, and the ids of those that couldn't be
   *  read or aren't recognised. */
  shares: ReadonlyMap<string, Share>;
  sharesUnknown: ReadonlySet<string>;
  /** Every payment, by its row's id, and those that couldn't be read. */
  payments: ReadonlyMap<string, Payment>;
  paymentsUnknown: ReadonlySet<string>;
  /** Every IOU, and how many couldn't be read (then none makes a row). */
  ious: ReadonlyMap<string, Iou>;
  iousUnread: number;
  /** The categories the rows were filed by: an IOU's row is filed by id. */
  ix: CategoryIndex | null;
  /** The first day read: an IOU dated before it has no row here. */
  from?: string;
  /** Hidden accounts: a share on one is never called gone. */
  hidden?: ReadonlySet<string>;
  /** As lib/split-rows.ts SplitInputs.stands. */
  stands?: ReadonlyMap<string, readonly string[]>;
  /** As SplitInputs.ended: those rows are left as they are. */
  ended?: ReadonlyMap<string, string>;
  /** Rows said to be no repayment, for the note on money in. */
  dismissed?: ReadonlySet<string>;
};

export type ShareResult = {
  rows: Txn[];
  notes: string[];
  /** Of `notes`, those that mean spending may be missing (IOUs unread). */
  unread_notes: string[];
  /** Shares and payments this read can tell their row is gone from, by id. */
  gone: { shares: string[]; payments: string[] };
  /** Transactions shared twice through an imported twin: the bank row's id,
   *  with the imported rows' (lib/shared-expenses/edits.ts removes one). */
  twice: { bank: string; imported: string[] }[];
  /** How many shared transactions and IOUs counted at your part. */
  counted: { shared: number; ious: number };
};

/** Review marks a row this layer adds never carries: a shared transaction
 *  is reviewed once, on its own row. */
const REVIEW_KEYS = ['needs_review', 'reviewed_at', 'review_unknown', 'review_changed', 'review_via', 'review_suggestion', 'approved_name', 'excluded_by_rule'] as const;

function added(base: Txn, over: Partial<Txn>): Txn {
  const row: Txn = { ...base, ...over };
  for (const k of REVIEW_KEYS) delete (row as Record<string, unknown>)[k];
  delete row.shared;
  delete row.shared_was;
  delete row.settles;
  delete row.shared_carried_from;
  delete row.shared_twice;
  return row;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The id a part row's share is kept under (its split's, or the imported
 *  row's it was carried from) and the part's own id. */
function partOf(t: Txn): { key: string; part: string } | null {
  if (t.split_of === undefined || !t.transaction_id.startsWith(PART_PREFIX)) return null;
  return { key: t.split_carried_from ?? t.split_of, part: t.transaction_id.slice(PART_PREFIX.length) };
}

/**
 * The rows with each shared transaction at your part beside the others'
 * parts, each payment at its rest beside what it paid back, and each IOU you
 * owe for something as a row of its own (see the header). `rows` are the
 * read layer's, after splits and groups; nothing given is changed.
 */
export function applyShares(rows: readonly Txn[], inputs: ShareInputs): ShareResult {
  const empty = inputs.shares.size === 0 && inputs.payments.size === 0 && inputs.ious.size === 0 && inputs.sharesUnknown.size === 0 && inputs.paymentsUnknown.size === 0 && inputs.iousUnread === 0;
  const settingNote = inputs.settingsUnread ? ['Your setting for shared expenses couldn’t be read, so every transaction counts as your bank shows it until it can be.'] : [];
  if (empty) return { rows: [...rows], notes: settingNote, unread_notes: [], gone: { shares: [], payments: [] }, twice: [], counted: { shared: 0, ious: 0 } };
  const part = inputs.counting === 'part' && !inputs.settingsUnread;
  const items = itemsOf(inputs.shares, inputs.ious);
  const paid = paidOf(inputs.payments, items);

  // What is here, every transaction once: rows, a split's transaction, a
  // group's transactions, and the imported rows a posted bank row here
  // stands for (their share and payment are its own: SplitInputs.stands).
  const present = new Set<string>();
  const accountDays = new Map<string, { first: string; last: string }>();
  const seen = (t: Txn) => {
    present.add(t.transaction_id);
    if (t.split_of !== undefined) present.add(t.split_of);
    if (t.split_carried_from !== undefined) present.add(t.split_carried_from);
    if (t.group_carried_from !== undefined) present.add(t.group_carried_from);
    if (t.account_id !== undefined) {
      const d = accountDays.get(t.account_id);
      if (!d) accountDays.set(t.account_id, { first: t.date, last: t.date });
      else {
        if (t.date < d.first) d.first = t.date;
        if (t.date > d.last) d.last = t.date;
      }
    }
  };
  const inGroup = new Set<string>();
  for (const t of rows) {
    seen(t);
    for (const m of t.group_members ?? []) {
      seen(m);
      inGroup.add(m.transaction_id);
      if (m.group_carried_from) inGroup.add(m.group_carried_from);
    }
    if (t.group_outside) inGroup.add(t.transaction_id);
  }
  const standsFor = new Map<string, string[]>();
  for (const [bankId, ids] of inputs.stands ?? []) {
    if (!present.has(bankId)) continue;
    const away = ids.filter((id) => !present.has(id));
    standsFor.set(bankId, away);
    for (const id of away) present.add(id);
  }

  const endedRow = (t: Txn): boolean => {
    const end = t.account_id === undefined ? undefined : inputs.ended?.get(t.account_id);
    return end !== undefined && t.date >= end;
  };

  let unknownShares = 0;
  let unknownPayments = 0;
  let unappliedShares = 0;
  let unappliedPayments = 0;
  let toNothing = 0;
  let sharedCounted = 0;
  const twice: ShareResult['twice'] = [];
  const out: Txn[] = [];

  // Shares on transactions now inside a group's row count there (the group
  // says how they count): noted.
  for (const id of inGroup) {
    if (inputs.shares.has(id)) unappliedShares++;
    if (inputs.payments.has(id)) unappliedPayments++;
  }
  // A share made without naming a part on a transaction since split shows
  // on none of its parts: noted once per transaction.
  const splitUnnamed = new Set<string>();

  for (const t of rows) {
    if (t.group_members || t.group_outside || t.pending || endedRow(t)) {
      out.push(t);
      continue;
    }
    const scale = unitScale(currencyOf(t));
    const rowUnits = toUnits(t.amount, scale);

    // ---- Which share applies ----
    let share: Share | null = null;
    let shareFrom: string | undefined;
    let twiceWith: string[] = [];
    let shareWhy: SharedUnapplied | null = null;
    const ofPart = partOf(t);
    if (ofPart) {
      const s = inputs.shares.get(ofPart.key);
      if (s) {
        if (s.part === ofPart.part) share = s;
        else if (s.part === undefined && !splitUnnamed.has(ofPart.key)) {
          splitUnnamed.add(ofPart.key);
          shareWhy = 'split';
        }
        if (share && ofPart.key !== t.split_of) shareFrom = ofPart.key;
      } else if (inputs.sharesUnknown.has(ofPart.key)) unknownShares++;
    } else if (t.split_of === undefined) {
      const own = inputs.shares.get(t.transaction_id);
      const carried = (standsFor.get(t.transaction_id) ?? []).filter((id) => inputs.shares.has(id));
      if (own) {
        share = own;
        if (carried.length > 0) {
          twice.push({ bank: t.transaction_id, imported: carried });
          twiceWith = carried;
        }
      } else if (carried.length > 0) {
        share = inputs.shares.get(carried[0])!;
        shareFrom = carried[0];
      } else if (inputs.sharesUnknown.has(t.transaction_id)) unknownShares++;
      if (share?.part !== undefined) {
        shareWhy = 'part';
        share = null;
      }
    }
    if (share && share.currency !== currencyOf(t)) shareWhy = 'currency';
    // The entries, less what was let go of each, in minor units.
    const lent = share
      ? share.entries.map((e) => {
          const item = items.get(e.id);
          const forgiven = item ? closedUnits(item).forgiven : 0;
          return { entry: e, units: Math.max(0, toUnits(e.amount, scale) - forgiven) };
        })
      : [];
    const lentUnits = lent.reduce((n, l) => n + l.units, 0);
    if (share && !shareWhy && (rowUnits <= 0 || lentUnits > rowUnits)) shareWhy = 'amount';
    if (shareWhy) {
      unappliedShares++;
      // Who owes what still shows, counted as unshared.
      const mark: SharedMark | undefined = share
        ? { ...(share.part ? { part: share.part } : {}), your_part: t.amount, people: lent.map((l) => ({ person: l.entry.person, item: l.entry.id, amount: l.units / scale })), counted: false }
        : undefined;
      out.push({ ...t, shared_unapplied: shareWhy, ...(mark ? { shared: mark } : {}) });
      continue;
    }

    // ---- Which payment applies ----
    const paymentKey = t.split_of === undefined ? t.transaction_id : null;
    // Its own, or that of a row imported from a file it stands for, as a
    // share is; both, and the imported row's isn't applied (noted).
    const carriedPayments = paymentKey ? (standsFor.get(paymentKey) ?? []).filter((id) => inputs.payments.has(id)) : [];
    const own = paymentKey ? inputs.payments.get(paymentKey) : undefined;
    const payment = own ?? (carriedPayments.length > 0 ? inputs.payments.get(carriedPayments[0])! : null);
    if (own && carriedPayments.length > 0) unappliedPayments += carriedPayments.length;
    if (!payment && paymentKey && [paymentKey, ...(standsFor.get(paymentKey) ?? [])].some((id) => inputs.paymentsUnknown.has(id))) unknownPayments++;
    if (t.split_of !== undefined && inputs.payments.has(t.split_of) && t.split_index === 0) {
      unappliedPayments++;
      out.push({ ...t, settles_unapplied: 'split' });
      continue;
    }

    if (share) {
      if (payment) unappliedPayments++;
      const yourUnits = rowUnits - lentUnits;
      const mark: SharedMark = {
        ...(share.part ? { part: share.part } : {}),
        your_part: yourUnits / scale,
        people: lent.map((l) => ({ person: l.entry.person, item: l.entry.id, amount: l.units / scale })),
        counted: part,
      };
      const facts: Partial<Txn> = {
        shared: mark,
        ...(shareFrom ? { shared_carried_from: shareFrom } : {}),
        ...(twiceWith.length > 0 ? { shared_twice: twiceWith } : {}),
        ...(payment ? { settles_unapplied: 'shared' as const } : {}),
      };
      if (!part) {
        out.push({ ...t, ...facts });
        continue;
      }
      sharedCounted++;
      const of = t.split_of === undefined ? { shared_of: t.transaction_id } : {};
      out.push({ ...t, ...facts, ...of, amount: yourUnits / scale, shared_was: t.amount });
      for (const l of lent) {
        if (l.units === 0) continue;
        out.push(added(t, { ...of, transaction_id: `${SHARE_PREFIX}${l.entry.id}`, amount: l.units / scale, excluded: true, shared_part: { kind: 'theirs', person: l.entry.person, item: l.entry.id } }));
      }
      continue;
    }

    if (payment) {
      const why: SettlesUnapplied | null = payment.row.currency !== currencyOf(t) ? 'currency' : null;
      // What each allocation is, from your side of the row: money back to
      // you is money in (Plaid's minus), your payment money out.
      const parts: { item: Item; units: number }[] = [];
      for (const a of payment.allocations) {
        const item = items.get(a.item);
        if (!item || item.currency !== payment.row.currency) {
          toNothing++;
          continue;
        }
        const units = toUnits(a.amount, scale);
        parts.push({ item, units: item.direction === 'to_you' ? -units : units });
      }
      const sum = parts.reduce((n, p) => n + p.units, 0);
      const fits = sum !== 0 && Math.sign(sum) === Math.sign(rowUnits) && Math.abs(sum) <= Math.abs(rowUnits);
      if (why || (parts.length > 0 && !fits)) {
        unappliedPayments++;
        out.push({ ...t, settles_unapplied: why ?? 'amount' });
        continue;
      }
      if (parts.length === 0) {
        out.push(t);
        continue;
      }
      const mark: SettlesMark = {
        rest: (rowUnits - sum) / scale,
        people: parts.map((p) => ({ person: p.item.person, item: p.item.id, amount: Math.abs(p.units) / scale, direction: p.item.direction })),
        counted: part,
      };
      if (!part) {
        out.push({ ...t, settles: mark });
        continue;
      }
      out.push({ ...t, settles: mark, shared_of: t.transaction_id, amount: (rowUnits - sum) / scale, shared_was: t.amount });
      for (const p of parts) {
        out.push(
          added(t, {
            shared_of: t.transaction_id,
            transaction_id: `${SETTLED_PREFIX}${t.transaction_id}:${p.item.id}`,
            amount: p.units / scale,
            excluded: true,
            shared_part: { kind: 'repaid', person: p.item.person, item: p.item.id },
          })
        );
      }
      continue;
    }
    out.push(t);
  }

  // ---- IOU rows: your part of what someone else paid ----
  const iouRows: Txn[] = [];
  let iousCounted = 0;
  if (part && inputs.iousUnread === 0) {
    for (const [id, iou] of inputs.ious) {
      if (iou.direction !== 'by_you' || !iou.category_id) continue;
      if (inputs.from !== undefined && iou.date < inputs.from) continue;
      const item = items.get(id);
      if (!item || item.kind !== 'iou') continue;
      const scale = unitScale(iou.currency);
      const { outside, forgiven } = closedUnits(item);
      const units = toUnits(iou.amount, scale) - forgiven;
      if (units <= 0) continue;
      iousCounted++;
      iouRows.push(iouRow(id, iou, units / scale, Math.min(units, outside) / scale, inputs.ix));
    }
  }

  // ---- What this read can tell is gone ----
  const covers = (account: string, day: string): boolean => {
    const d = accountDays.get(account);
    return !!d && d.first <= day && d.last >= day && !inputs.hidden?.has(account);
  };
  const gone = { shares: [] as string[], payments: [] as string[] };
  for (const [id, s] of inputs.shares) {
    if (present.has(id) || s.kept_gone || (inputs.from !== undefined && s.date < inputs.from)) continue;
    if (covers(s.account_id, s.date)) gone.shares.push(id);
  }
  for (const [id, p] of inputs.payments) {
    if (present.has(id) || p.kept_gone || (inputs.from !== undefined && p.row.date < inputs.from)) continue;
    if (covers(p.account_id, p.row.date)) gone.payments.push(id);
  }

  // ---- Money in from a payment app, counted, while someone owes you ----
  const owedToYou = [...items.values()].some((i) => i.direction === 'to_you' && itemState(i, paid).open > 0);
  let moneyIn = 0;
  if (owedToYou) {
    for (const t of out) {
      if (t.amount >= 0 || t.pending || isLayerRow(t) || t.settles || t.settles_unapplied || t.split_of !== undefined || t.group_members) continue;
      if (isExcluded(t) || isTransfer(t) || inputs.dismissed?.has(t.transaction_id) || inputs.payments.has(t.transaction_id)) continue;
      if (appOf(t) !== null) moneyIn++;
    }
  }

  const notes = [
    ...settingNote,
    ...(unknownShares > 0 ? [`How you shared ${plural(unknownShares, 'transaction', 'transactions')} couldn’t be read, so ${unknownShares === 1 ? 'it counts' : 'they count'} whole until ${unknownShares === 1 ? 'it' : 'they'} can be.`] : []),
    ...(unknownPayments > 0 ? [`What ${plural(unknownPayments, 'payment', 'payments')} paid back couldn’t be read, so ${unknownPayments === 1 ? 'it counts' : 'they count'} as your bank shows ${unknownPayments === 1 ? 'it' : 'them'} until ${unknownPayments === 1 ? 'it' : 'they'} can be.`] : []),
    ...(unappliedShares > 0
      ? [`${plural(unappliedShares, 'shared transaction has', 'shared transactions have')} changed since you shared ${unappliedShares === 1 ? 'it' : 'them'} (split, grouped, smaller, or in another currency), so ${unappliedShares === 1 ? 'it counts' : 'they count'} whole until you change what you shared under Shared expenses.`]
      : []),
    ...(unappliedPayments > 0
      ? [`${plural(unappliedPayments, 'payment you confirmed no longer fits', 'payments you confirmed no longer fit')} what ${unappliedPayments === 1 ? 'it' : 'they'} paid back, so ${unappliedPayments === 1 ? 'it counts' : 'they count'} as your bank shows ${unappliedPayments === 1 ? 'it' : 'them'} until you look at ${unappliedPayments === 1 ? 'it' : 'them'} under Shared expenses.`]
      : []),
    ...(toNothing > 0 ? [`${plural(toNothing, 'payment pays', 'payments pay')} back something you’ve since removed, so that much counts as your bank shows it.`] : []),
    ...(gone.shares.length + gone.payments.length > 0
      ? [
          `${[gone.shares.length > 0 ? plural(gone.shares.length, 'shared transaction', 'shared transactions') : null, gone.payments.length > 0 ? plural(gone.payments.length, 'payment you confirmed', 'payments you confirmed') : null].filter(Boolean).join(' and ')} ${gone.shares.length + gone.payments.length === 1 ? 'isn’t' : 'aren’t'} in your accounts any more: see Shared expenses.`,
        ]
      : []),
    ...(twice.length > 0 ? [`${plural(twice.length, 'transaction is', 'transactions are')} shared twice, once as imported from a file and once as your bank’s: remove one under Shared expenses.`] : []),
    ...(moneyIn > 0
      ? [`${plural(moneyIn, 'payment in from a payment app counts', 'payments in from a payment app count')} as money in: if one paid back what someone owed you, confirm it under Shared expenses so it isn’t counted twice.`]
      : []),
  ];
  const unread_notes = inputs.iousUnread > 0 && part ? ['Some of your IOUs couldn’t be read, so your part of what others paid may be missing from these totals.'] : [];
  return { rows: mergeNewestFirst(out, iouRows), notes: [...notes, ...unread_notes], unread_notes, gone, twice, counted: { shared: sharedCounted, ious: iousCounted } };
}

/** An IOU's row: on its day, filed under its category, on no account. */
function iouRow(id: string, iou: Iou, amount: number, cash: number, ix: CategoryIndex | null): Txn {
  const c = ix && iou.category_id ? categoryById(ix, iou.category_id) : null;
  const iso = isCurrencyCode(iou.currency);
  return {
    transaction_id: `${IOU_PREFIX}${id}`,
    date: iou.date,
    name: iou.what,
    amount,
    pending: false,
    account_name: '',
    account_type: null,
    institution_name: '',
    ...filedUnder(ix, c),
    iso_currency_code: iso ? iou.currency : null,
    unofficial_currency_code: iso ? null : iou.currency,
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
    source: 'shared',
    shared_iou: { person: iou.person, item: id, cash },
  };
}

/** The rows, newest first as given, with the IOU rows put in by day. */
function mergeNewestFirst(rows: Txn[], ious: Txn[]): Txn[] {
  if (ious.length === 0) return rows;
  const sorted = [...ious].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.transaction_id < b.transaction_id ? -1 : 1));
  const out: Txn[] = [];
  let i = 0;
  for (const t of rows) {
    while (i < sorted.length && sorted[i].date > t.date) out.push(sorted[i++]);
    out.push(t);
  }
  while (i < sorted.length) out.push(sorted[i++]);
  return out;
}
