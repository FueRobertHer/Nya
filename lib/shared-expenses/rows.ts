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
// read this time). One whose row this read can tell is gone is named in
// `gone` and noted, never pruned: what someone owes doesn't change on its
// own. It is gone when its account is here, not hidden, with rows on both
// sides of its day; when its account was linked to a re-added one and it
// didn't carry (ACROSS A RE-LINK); and when it was on a manual account that
// no longer has it (deleted with its row or its account), unless that
// account's book couldn't be read. One on an account disconnected and not
// linked to anything yet waits (`away`), and is noted too. A share on a
// transaction now grouped, split without naming a part, of another
// currency, or smaller than its entries now, counts the transaction whole
// (`shared_unapplied`); a payment on a row now split, grouped, shared (the
// share wins: it is the person's word about spending), of another
// currency, or that can't hold what it pays back now, counts the row as the
// bank shows it (`settles_unapplied`). An allocation to an item that no
// longer exists is left out: that much of the row counts as it says. A row
// whose amount changed since it was shared or confirmed, and still holds
// what it was given, applies, its mark saying what it was (`was`), noted.
//
// ACROSS A RE-LINK, as what was said about a transaction carries
// (lib/txn-annotations.ts). A disconnect records each shared or paying
// transaction's content key on its share or payment (`carry_key`,
// lib/shared-expenses/edits.ts retireShares), before the transaction's id
// dies with the connection. Once the person links the old account to the
// re-added one (lib/links.ts), the share or payment applies to the row there
// with the same key under the new account's id, one to one: a key two old
// ones share, or two rows share, carries nothing, and those are gone
// (decided by the link, never by what rows the old account still has). One
// whose key no row has yet, or that has no key, waits (`coming`) while the
// new account's connection is still bringing its history (`loading`) or its
// rows don't reach that day (none yet, or all from before it), since the
// bank sends its last month or so first; it is gone once they do (its words
// changed) or once all of the history is there and begins after it. The row
// says where it is kept (`shared_carried_from`, the payment's `kept_under`),
// so an edit there moves it onto the row. When the links can't be read,
// nothing carries and nothing is said to be gone or waiting, and a note
// says so (`accountsUnread`).
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

/** A manual account's id begins so (lib/manual.ts MANUAL_ID_PREFIX, which
 *  reaches storage, so it is said again here: a test holds them equal). */
export const MANUAL_ACCOUNT_PREFIX = 'manual_';

// ---- The marks ----

/** On a shared transaction's own row (or the split part's): who owes which
 *  part, by person and item (ids only), your part, and whether this read
 *  counts it so (false under `bank`). */
export type SharedMark = {
  part?: string;
  your_part: number;
  people: { person: string; item: string; amount: number }[];
  counted: boolean;
  /** The amount when it was shared, where the row's differs now (your part
   *  takes the difference). */
  was?: number;
};
/** On a payment's own row: what it pays back, each item with its direction,
 *  what is left of the row, and whether this read counts it so. */
export type SettlesMark = {
  rest: number;
  people: { person: string; item: string; amount: number; direction: 'to_you' | 'by_you' }[];
  counted: boolean;
  /** The row's amount when it was confirmed, where it differs now. */
  was?: number;
  /** The id the payment is kept under, where it isn't the row's: a row
   *  imported from a file it stands for, or the transaction it was before a
   *  re-link (see ACROSS A RE-LINK). */
  kept_under?: string;
};
/** On a row this layer added beside a transaction: another person's part of
 *  it, or a part of a payment that paid an item back. */
export type SharedPart = { kind: 'theirs' | 'repaid'; person: string; item: string };
/** On an IOU's row: whose, which, and how much of it was settled outside
 *  your accounts. */
export type SharedIou = { person: string; item: string; cash: number };

/** A row a gone share or payment could be moved to. */
export type MoveTo = { transaction_id: string; account_id: string };

/** A share or payment kept under another id that applies to a row, applied
 *  or not: which, and the id it is kept under. */
export type Carried = { kind: 'share' | 'payment'; from: string };

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
  /** Each bank row's account and content key, by id, as the read layer had
   *  them before taking them off (lib/activity.ts): a row without
   *  `account_id` is found on its account by them, and a share carried
   *  across a re-link by the key. */
  rowFacts?: ReadonlyMap<string, { account?: string; key?: string }>;
  /** The manual accounts whose book couldn't be read ('all': none could):
   *  a share on one is never called gone. */
  manualUnread?: readonly string[] | 'all';
  /** The live bank accounts, and each account id as the active links
   *  resolve it (lib/link-core.ts), when they could be read: what a share
   *  carries across a re-link by, and what says it is gone or waits. */
  accounts?: { live: ReadonlySet<string>; resolve: (account_id: string) => string };
  /** The links or the live accounts couldn't be read: nothing carries, with
   *  a note. */
  accountsUnread?: boolean;
  /** The accounts whose connection is still bringing its history
   *  (lib/transactions.ts loadingOf): a share whose row may be in what is
   *  still to come waits for it. */
  loading?: ReadonlySet<string>;
};

export type ShareResult = {
  rows: Txn[];
  notes: string[];
  /** Of `notes`, those that mean spending may be missing (IOUs unread). */
  unread_notes: string[];
  /** Shares and payments this read can tell their row is gone from, by id. */
  gone: { shares: string[]; payments: string[] };
  /** Shares and payments on an account disconnected and not linked to a
   *  re-added one yet: they carry once it is (ACROSS A RE-LINK). */
  away: { shares: string[]; payments: string[] };
  /** Shares and payments from before a re-link whose row hasn't come in yet
   *  on the account linked on (ACROSS A RE-LINK): never gone while they wait. */
  coming: { shares: string[]; payments: string[] };
  /** For each gone one, the rows here it could be moved to, with the
   *  account each is on (what a move sends, and the server checks): posted,
   *  whole, free, at the same amount and currency, within a week, those on
   *  its account (or the one linked to it) first. Absent: none. */
  moves?: { shares: Record<string, MoveTo[]>; payments: Record<string, MoveTo[]> };
  /** Transactions shared twice through an imported twin: the bank row's id,
   *  with the imported rows' (lib/shared-expenses/edits.ts removes one). */
  twice: { bank: string; imported: string[] }[];
  /** By row id, the share or payment kept under another id that applies to
   *  it, applied or not: carried across a re-link, or a file's row's it
   *  stands for. What every write onto a transaction checks
   *  (lib/shared-expenses/edits.ts carriedOnto); never sent. */
  onto: Map<string, Carried>;
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
  if (empty) return { rows: [...rows], notes: settingNote, unread_notes: [], gone: { shares: [], payments: [] }, away: { shares: [], payments: [] }, coming: { shares: [], payments: [] }, twice: [], onto: new Map() };
  const part = inputs.counting === 'part' && !inputs.settingsUnread;
  const items = itemsOf(inputs.shares, inputs.ious);
  const paid = paidOf(inputs.payments, items);

  // What is here, every transaction once: rows, a split's transaction, a
  // group's transactions, and the imported rows a posted bank row here
  // stands for (their share and payment are its own: SplitInputs.stands).
  const present = new Set<string>();
  const accountDays = new Map<string, { first: string; last: string }>();
  // A row's account: its own, or as the read layer had it (rowFacts).
  const accountOf = (t: Txn): string | undefined => t.account_id ?? inputs.rowFacts?.get(t.split_of ?? t.transaction_id)?.account;
  const seen = (t: Txn) => {
    present.add(t.transaction_id);
    if (t.split_of !== undefined) present.add(t.split_of);
    if (t.split_carried_from !== undefined) present.add(t.split_carried_from);
    if (t.group_carried_from !== undefined) present.add(t.group_carried_from);
    const account = t.shared_iou ? undefined : accountOf(t);
    if (account !== undefined) {
      const d = accountDays.get(account);
      if (!d) accountDays.set(account, { first: t.date, last: t.date });
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
    const account = accountOf(t);
    const end = account === undefined ? undefined : inputs.ended?.get(account);
    return end !== undefined && t.date >= end;
  };

  // ---- Carried across a re-link (see ACROSS A RE-LINK) ----
  // The rows that can take one, by content key: posted, whole (not a part,
  // not a group's), with no share or payment of their own.
  const relinkedShare = new Map<string, string>();
  const relinkedPayment = new Map<string, string>();
  // Why one didn't carry: two wanting one key, or two rows having it (gone
  // at once), or no row with it here yet (where it waits, on that account).
  const missed = {
    shares: { twins: new Set<string>(), unarrived: new Map<string, string>() },
    payments: { twins: new Set<string>(), unarrived: new Map<string, string>() },
  };
  const resolve = inputs.accounts?.resolve;
  if (resolve) {
    const byKey = new Map<string, string[]>();
    for (const t of rows) {
      if (t.pending || t.split_of !== undefined || t.group_members || t.group_outside) continue;
      const key = inputs.rowFacts?.get(t.transaction_id)?.key;
      if (!key || inputs.shares.has(t.transaction_id) || inputs.payments.has(t.transaction_id)) continue;
      // One standing for an imported row with a share or payment has it.
      if ((inputs.stands?.get(t.transaction_id) ?? []).some((id) => inputs.shares.has(id) || inputs.payments.has(id))) continue;
      byKey.set(key, [...(byKey.get(key) ?? []), t.transaction_id]);
    }
    const carry = (kept: ReadonlyMap<string, Share | Payment>, to: Map<string, string>, misses: (typeof missed)['shares'], taken: ReadonlySet<string>) => {
      const wanted = new Map<string, { id: string; now: string }[]>();
      for (const [id, v] of kept) {
        if (present.has(id)) continue;
        const now = resolve(v.account_id);
        // Not linked to another account: nothing to carry to.
        if (now === v.account_id) continue;
        const key = v.carry_key && v.carry_key.startsWith(`${v.account_id}|`) && !(v as Share).part ? now + v.carry_key.slice(v.account_id.length) : null;
        // Nothing to carry it by: it waits for the rows, to be moved by hand.
        if (!key) {
          misses.unarrived.set(id, now);
          continue;
        }
        wanted.set(key, [...(wanted.get(key) ?? []), { id, now }]);
      }
      for (const [key, ids] of wanted) {
        const all = byKey.get(key) ?? [];
        const targets = all.filter((t) => !taken.has(t));
        if (ids.length === 1 && targets.length === 1) to.set(targets[0], ids[0].id);
        else if (ids.length === 1 && all.length === 0) misses.unarrived.set(ids[0].id, ids[0].now);
        else for (const { id } of ids) misses.twins.add(id);
      }
    };
    carry(inputs.shares, relinkedShare, missed.shares, new Set());
    // A row a share carried to takes no payment besides: the share wins.
    carry(inputs.payments, relinkedPayment, missed.payments, new Set(relinkedShare.keys()));
    for (const id of [...relinkedShare.values(), ...relinkedPayment.values()]) present.add(id);
  }

  let unknownShares = 0;
  let unknownPayments = 0;
  let unappliedShares = 0;
  let unappliedPayments = 0;
  let toNothing = 0;
  let changedShares = 0;
  let changedPayments = 0;
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

  const onto = new Map<string, Carried>();
  for (const t of rows) {
    if (t.group_members || t.group_outside || t.pending || endedRow(t)) {
      out.push(t);
      continue;
    }
    // What applies to it from elsewhere, though it may not apply as it is.
    if (t.split_of === undefined) {
      const id = t.transaction_id;
      const elsewhere = (kept: ReadonlyMap<string, unknown>, relinked: ReadonlyMap<string, string>) =>
        kept.has(id) ? undefined : ((standsFor.get(id) ?? []).find((x) => kept.has(x)) ?? relinked.get(id));
      const shareFrom = elsewhere(inputs.shares, relinkedShare);
      const paymentFrom = elsewhere(inputs.payments, relinkedPayment);
      if (shareFrom !== undefined) onto.set(id, { kind: 'share', from: shareFrom });
      else if (paymentFrom !== undefined) onto.set(id, { kind: 'payment', from: paymentFrom });
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
      } else if (relinkedShare.has(t.transaction_id)) {
        shareFrom = relinkedShare.get(t.transaction_id)!;
        share = inputs.shares.get(shareFrom)!;
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
      // Where it is kept, as when it applies, so it is changed from there.
      out.push({ ...t, shared_unapplied: shareWhy, ...(mark ? { shared: mark } : {}), ...(share && shareFrom ? { shared_carried_from: shareFrom } : {}) });
      continue;
    }

    // ---- Which payment applies ----
    const paymentKey = t.split_of === undefined ? t.transaction_id : null;
    // Its own, or that of a row imported from a file it stands for, as a
    // share is; both, and the imported row's isn't applied (noted).
    const carriedPayments = paymentKey ? (standsFor.get(paymentKey) ?? []).filter((id) => inputs.payments.has(id)) : [];
    const own = paymentKey ? inputs.payments.get(paymentKey) : undefined;
    const keptUnder = own ? undefined : carriedPayments.length > 0 ? carriedPayments[0] : paymentKey ? relinkedPayment.get(paymentKey) : undefined;
    const payment = own ?? (keptUnder !== undefined ? inputs.payments.get(keptUnder)! : null);
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
      // The amount it had when shared, said where the row's changed since.
      const changed = toUnits(share.amount_was, scale) !== rowUnits;
      if (changed) changedShares++;
      const mark: SharedMark = {
        ...(share.part ? { part: share.part } : {}),
        your_part: yourUnits / scale,
        people: lent.map((l) => ({ person: l.entry.person, item: l.entry.id, amount: l.units / scale })),
        counted: part,
        ...(changed ? { was: share.amount_was } : {}),
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
      const changed = toUnits(payment.row.amount, scale) !== rowUnits;
      if (changed) changedPayments++;
      const mark: SettlesMark = {
        rest: (rowUnits - sum) / scale,
        people: parts.map((p) => ({ person: p.item.person, item: p.item.id, amount: Math.abs(p.units) / scale, direction: p.item.direction })),
        counted: part,
        ...(changed ? { was: payment.row.amount } : {}),
        ...(keptUnder !== undefined ? { kept_under: keptUnder } : {}),
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
      iouRows.push(iouRow(id, iou, units / scale, Math.min(units, outside) / scale, inputs.ix));
    }
  }

  // ---- What this read can tell is gone ----
  const covers = (account: string, day: string): boolean => {
    const d = accountDays.get(account);
    return !!d && d.first <= day && d.last >= day && !inputs.hidden?.has(account);
  };
  const gone = { shares: [] as string[], payments: [] as string[] };
  const away = { shares: [] as string[], payments: [] as string[] };
  const coming = { shares: [] as string[], payments: [] as string[] };
  const manualUnread = (account: string) => inputs.manualUnread === 'all' || !!inputs.manualUnread?.includes(account);
  // One whose row isn't on the account linked on (`now`): gone once that
  // account's rows reach its day (its words changed) or all of its history
  // is there and begins after it; until then it waits (ACROSS A RE-LINK).
  const arrival = (now: string, day: string): 'gone' | 'coming' | null => {
    if (inputs.hidden?.has(now)) return null;
    const end = inputs.ended?.get(now);
    if (end !== undefined && day >= end) return null;
    if (inputs.loading?.has(now)) return 'coming';
    const d = accountDays.get(now);
    return !d || day > d.last ? 'coming' : 'gone';
  };
  // Gone, waiting on a link or on its row, or neither (see WHAT DOESN'T APPLY).
  const where = (id: string, account: string, day: string, misses: (typeof missed)['shares']): 'gone' | 'away' | 'coming' | null => {
    if (misses.twins.has(id)) return 'gone';
    const now = misses.unarrived.get(id);
    if (now !== undefined) return arrival(now, day);
    if (covers(account, day)) return 'gone';
    if (accountDays.has(account) || inputs.hidden?.has(account) || inputs.ended?.has(account)) return null;
    if (account.startsWith(MANUAL_ACCOUNT_PREFIX)) return manualUnread(account) ? null : 'gone';
    const live = inputs.accounts?.live;
    if (!live || live.has(account)) return null;
    // A bank account no stored connection has, linked to nothing yet.
    return inputs.accounts!.resolve(account) === account ? 'away' : null;
  };
  for (const [id, s] of inputs.shares) {
    if (present.has(id) || s.kept_gone || (inputs.from !== undefined && s.date < inputs.from)) continue;
    const w = where(id, s.account_id, s.date, missed.shares);
    if (w) ({ gone, away, coming })[w].shares.push(id);
  }
  for (const [id, p] of inputs.payments) {
    if (present.has(id) || p.kept_gone || (inputs.from !== undefined && p.row.date < inputs.from)) continue;
    const w = where(id, p.account_id, p.row.date, missed.payments);
    if (w) ({ gone, away, coming })[w].payments.push(id);
  }

  // ---- Where a gone one could go ----
  let moves: ShareResult['moves'];
  if (gone.shares.length + gone.payments.length > 0) {
    const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
    const free = out.filter(
      (t) =>
        !t.pending &&
        t.split_of === undefined &&
        !t.group_members &&
        !t.group_outside &&
        !isLayerRow(t) &&
        !t.shared &&
        !t.settles &&
        !t.shared_unapplied &&
        !t.settles_unapplied &&
        !inputs.shares.has(t.transaction_id) &&
        !inputs.payments.has(t.transaction_id) &&
        accountOf(t) !== undefined
    );
    const candidates = (account: string, amount: number, currency: string, on: string): MoveTo[] => {
      const scale = unitScale(currency);
      const near = free.filter((t) => currencyOf(t) === currency && toUnits(t.amount, scale) === toUnits(amount, scale) && Math.abs(day(t.date) - day(on)) <= 7);
      const mine = new Set([account, resolve ? resolve(account) : account]);
      const first = near.filter((t) => mine.has(accountOf(t)!));
      return [...first, ...near.filter((t) => !mine.has(accountOf(t)!))].slice(0, 3).map((t) => ({ transaction_id: t.transaction_id, account_id: accountOf(t)! }));
    };
    moves = { shares: {}, payments: {} };
    for (const id of gone.shares) {
      const s = inputs.shares.get(id)!;
      const c = candidates(s.account_id, s.amount_was, s.currency, s.date);
      if (c.length > 0) moves.shares[id] = c;
    }
    for (const id of gone.payments) {
      const p = inputs.payments.get(id)!;
      const c = candidates(p.account_id, p.row.amount, p.row.currency, p.row.date);
      if (c.length > 0) moves.payments[id] = c;
    }
  }

  // ---- Money from or to a payment app, counted, while something is open ----
  // Under `part` only (under `bank`, confirming changes no total), and only
  // a row dated on or after the oldest item open its way, as matching reads
  // them: money in while someone owes you counts as income, money out while
  // you owe someone as a purchase, beside what is already counted of it.
  const oldestOpen = (direction: 'to_you' | 'by_you'): string | null => {
    let oldest: string | null = null;
    for (const i of items.values()) if (i.direction === direction && itemState(i, paid).open > 0 && (oldest === null || i.date < oldest)) oldest = i.date;
    return oldest;
  };
  const owedFrom = part ? oldestOpen('to_you') : null;
  const owingFrom = part ? oldestOpen('by_you') : null;
  let moneyIn = 0;
  let moneyOut = 0;
  if (owedFrom !== null || owingFrom !== null) {
    for (const t of out) {
      if (t.amount === 0 || t.pending || isLayerRow(t) || t.settles || t.settles_unapplied || t.shared || t.split_of !== undefined || t.group_members) continue;
      if (isExcluded(t) || isTransfer(t) || inputs.dismissed?.has(t.transaction_id) || inputs.payments.has(t.transaction_id)) continue;
      if (appOf(t) === null) continue;
      if (t.amount < 0 && owedFrom !== null && t.date >= owedFrom) moneyIn++;
      if (t.amount > 0 && owingFrom !== null && t.date >= owingFrom) moneyOut++;
    }
  }

  const count = (x: { shares: string[]; payments: string[] }) => x.shares.length + x.payments.length;
  const kinds = (x: { shares: string[]; payments: string[] }) =>
    [x.shares.length > 0 ? plural(x.shares.length, 'shared transaction', 'shared transactions') : null, x.payments.length > 0 ? plural(x.payments.length, 'payment you confirmed', 'payments you confirmed') : null]
      .filter(Boolean)
      .join(' and ');
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
    ...(changedShares > 0
      ? [`${plural(changedShares, 'shared transaction’s amount has', 'shared transactions’ amounts have')} changed since you shared ${changedShares === 1 ? 'it' : 'them'}: your part takes the difference, and what the others owe stays as you said until you change it under Shared expenses.`]
      : []),
    ...(changedPayments > 0
      ? [`${plural(changedPayments, 'payment you confirmed has', 'payments you confirmed have')} changed amount since: what ${changedPayments === 1 ? 'it' : 'they'} paid back stays as you confirmed, and the rest counts as your bank shows it.`]
      : []),
    ...(gone.shares.length + gone.payments.length > 0
      ? [
          `${[gone.shares.length > 0 ? plural(gone.shares.length, 'shared transaction', 'shared transactions') : null, gone.payments.length > 0 ? plural(gone.payments.length, 'payment you confirmed', 'payments you confirmed') : null].filter(Boolean).join(' and ')} ${gone.shares.length + gone.payments.length === 1 ? 'isn’t' : 'aren’t'} in your accounts any more: see Shared expenses.`,
        ]
      : []),
    ...(away.shares.length + away.payments.length > 0
      ? [
          `${kinds(away)} ${count(away) === 1 ? 'is' : 'are'} on an account you disconnected: once you add the bank back and link the account, ${count(away) === 1 ? 'it carries' : 'they carry'} to ${count(away) === 1 ? 'its transaction' : 'their transactions'} there. What is owed stays as it is meanwhile; if you won’t add it back, keep ${count(away) === 1 ? 'it' : 'them'} under Shared expenses.`,
        ]
      : []),
    ...(count(coming) > 0
      ? [
          `${kinds(coming)} from before you re-linked ${count(coming) === 1 ? 'waits for its transaction' : 'wait for their transactions'} to come in from your bank: ${count(coming) === 1 ? 'it carries' : 'they carry'} across once ${count(coming) === 1 ? 'it does' : 'they do'}. What is owed stays as it is meanwhile.`,
        ]
      : []),
    ...(inputs.accountsUnread && [...inputs.shares.keys(), ...inputs.payments.keys()].some((id) => !present.has(id))
      ? ['Your account links couldn’t be read, so shared transactions and payments from before a re-link aren’t carried to their transactions, nor said to be gone, until they can be.']
      : []),
    ...(twice.length > 0 ? [`${plural(twice.length, 'transaction is', 'transactions are')} shared twice, once as imported from a file and once as your bank’s: remove one under Shared expenses.`] : []),
    ...(moneyIn > 0
      ? [`${plural(moneyIn, 'payment in from a payment app counts', 'payments in from a payment app count')} as money in: if one paid back what someone owed you, confirm it under Shared expenses so it isn’t counted twice.`]
      : []),
    ...(moneyOut > 0
      ? [`${plural(moneyOut, 'payment to a payment app counts', 'payments to a payment app count')} as spending: if one paid what you owed someone, confirm it under Shared expenses so it isn’t counted twice.`]
      : []),
  ];
  const unread_notes = inputs.iousUnread > 0 && part ? ['Some of your IOUs couldn’t be read, so your part of what others paid may be missing from these totals.'] : [];
  return { rows: mergeNewestFirst(out, iouRows), notes: [...notes, ...unread_notes], unread_notes, gone, away, coming, twice, onto, ...(moves ? { moves } : {}) };
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
