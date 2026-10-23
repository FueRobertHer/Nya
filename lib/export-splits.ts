// lib/export-splits.ts
//
// Splits and groups (#39) in the download of your data (lib/user-export.ts,
// lib/ofx-export.ts), by the read layer's own function (lib/split-rows.ts
// expandSplitsAndGroups), from the file's own parts: `transaction-splits`,
// `transaction-groups`, and what `problems` says couldn't be read. So the
// file and the app never disagree about what a split or a group comes to.
//
// THE TRANSACTIONS CSV CAN'T COUNT ANYTHING TWICE. Every transaction is a row,
// as the bank (or the person, entering it) has it, with its own amount in
// `amount`; beside them, a split transaction's parts and a group's net are
// rows of their own, with nothing in `amount`. `nya_amount` is what the app
// counts: a transaction's amount, a part's, a group's net, and nothing on a
// split transaction or on one in a group, which count through their parts and
// their group, nor on a pending one its posted one replaced, which the app
// doesn't list. So adding up `amount` (without those pending ones) gives the
// money as it moved, adding up `nya_amount` gives the app's totals (by
// `nya_category`, its categories'), and neither counts a transaction twice. A part says whose it is
// (`split_of`, the transaction's id, and `split_index`); a transaction in a
// group and the group's row both say which (`group_id`, `group_name`).
//
// THE FILE HOLDS EVERY ROW, of every date and on hidden accounts too, so a
// group's net here is of all its transactions in the file, as `amount` adds
// them (the app leaves a hidden account's out, as it leaves the account out).
//
// A BANK ROW STANDING FOR ROWS IMPORTED FROM FILES (#52, `stands`: the
// file's imported rows as lib/user-export.ts importedTransactionsIn settles
// them) is split and grouped as they were, as the app does it
// (lib/split-rows.ts): its parts name it (`split_of`), and the split itself
// is in `transaction-splits` under the imported row's id.
//
// SHARED EXPENSES (#49) apply after them, as in the app (lib/shared-
// expenses/rows.ts applyShares), from the file's own parts and its setting:
// a shared transaction's row keeps its `amount`, and its `nya_amount` is your
// part; each other person's part and each part a payment paid back is a row
// of its own, `amount` empty, `nya_amount` its amount, `excluded` true; an
// IOU you owe for something is a row of its own, `amount` empty. They carry
// `shared_of` (the transaction), `shared_kind` (`theirs`, `repaid`, `iou`)
// and `shared_person`, the person's random id: never a name, which only the
// JSON download's `expense-people` holds. Adding up `amount` still gives the
// money as it moved, and `nya_amount` of the rows not excluded the app's
// totals.
//
// AN OFX STATEMENT lists each transaction once, whole, as a bank's statement
// does (its amounts add up to the balance), and says in its memo how it is
// split ("Split in Nya: Food and drink 100.00; Home improvement 50.00") or
// which group it is in, when that fits OFX's 255 characters with the rest;
// when it doesn't, it is left out of the memo and a note says how many were.

import type { Txn } from './transactions';
import { categoryById, displayName, groupOf, isProvisionalId, type CategoryIndex } from './categories';
import { isSplitRecord, splitStore, type SplitRecord } from './splits';
import { groupStore, isTxnGroup, type TxnGroup } from './groups';
import { expandSplitsAndGroups, unitScale, toUnits, type SplitInputs } from './split-rows';
import { applyShares, type ShareInputs } from './shared-expenses/rows';
import { DEFAULT_COUNTING, isExpenseSettings, isIou, isPayment, isShare, type Iou, type Payment, type Share } from './shared-expenses/model';
import { expenseIousStore, expensePaymentsStore, expenseSettingsStore, expenseSharesStore } from './shared-expenses/store';

/** What `problems` names (lib/user-export.ts ExportProblem), as read here. */
type Problem = { section: string; ids?: string[]; count?: number };

/** A map store's part of the file: its readable entries, by id. */
function entriesOf<T>(part: unknown, valid: (v: unknown) => v is T): Map<string, T> {
  const out = new Map<string, T>();
  if (!Array.isArray(part)) return out;
  for (const e of part) {
    const entry = e as { id?: unknown; value?: unknown } | null;
    if (entry && typeof entry.id === 'string' && valid(entry.value)) out.set(entry.id, entry.value);
  }
  return out;
}

/** The splits and groups in the file, and what of them couldn't be read, as
 *  the read layer takes them, filed against `ix`; `stands`, each bank row's
 *  imported rows it stands for (see the header). */
export function splitInputsOf(part: (key: string) => unknown, problems: readonly Problem[], ix: CategoryIndex, stands?: ReadonlyMap<string, readonly string[]>): SplitInputs {
  const unread = (section: string) => problems.filter((p) => p.section === section);
  return {
    splits: entriesOf<SplitRecord>(part(splitStore.name), isSplitRecord),
    splitsUnknown: new Set(unread(splitStore.name).flatMap((p) => p.ids ?? [])),
    groups: entriesOf<TxnGroup>(part(groupStore.name), isTxnGroup),
    groupsUnknown: unread(groupStore.name).reduce((n, p) => n + (p.ids?.length ?? p.count ?? 0), 0),
    ix,
    ...(stands && stands.size > 0 ? { stands } : {}),
  };
}

/** The file's shared expenses as the read layer applies them, from its own
 *  parts and setting (see SHARED EXPENSES), or null when it holds none. */
export function shareInputsOf(part: (key: string) => unknown, problems: readonly Problem[], ix: CategoryIndex, stands?: ReadonlyMap<string, readonly string[]>): ShareInputs | null {
  const unread = (section: string) => problems.filter((p) => p.section === section);
  const shares = entriesOf<Share>(part(expenseSharesStore.name), isShare);
  const payments = entriesOf<Payment>(part(expensePaymentsStore.name), isPayment);
  const ious = entriesOf<Iou>(part(expenseIousStore.name), isIou);
  const sharesUnknown = new Set(unread(expenseSharesStore.name).flatMap((p) => p.ids ?? []));
  const paymentsUnknown = new Set(unread(expensePaymentsStore.name).flatMap((p) => p.ids ?? []));
  const iousUnread = unread(expenseIousStore.name).reduce((n, p) => n + (p.ids?.length ?? p.count ?? 0), 0);
  if (shares.size + payments.size + ious.size + sharesUnknown.size + paymentsUnknown.size + iousUnread === 0) return null;
  const settings = part(expenseSettingsStore.name);
  const settingsUnread = unread(expenseSettingsStore.name).length > 0 || (settings !== undefined && settings !== null && !isExpenseSettings(settings));
  return {
    counting: isExpenseSettings(settings) ? settings.counting : DEFAULT_COUNTING,
    settingsUnread,
    shares,
    sharesUnknown,
    payments,
    paymentsUnknown,
    ious,
    iousUnread,
    ix,
    ...(stands && stands.size > 0 ? { stands } : {}),
  };
}

/** Whether the file holds any split or group at all: nothing to do if not. */
export const anySplitsOrGroups = (inputs: SplitInputs): boolean => inputs.splits.size > 0 || inputs.groups.size > 0;

// ---- The transactions CSV ----

/** A row of the transactions CSV, before it is written: when it is, and its
 *  cells by column; `txn`, what the read layer's function reads of it. */
export type CsvLine<C extends Record<string, unknown>> = { date: string; time: string; id: string; txn: Txn; cells: () => C };

/** The columns this file adds, and the ones a part's or a group's row fills
 *  from the read layer's answer. */
type Filled = {
  amount: unknown;
  nya_amount: unknown;
  superseded_by_posted: unknown;
  split_of: unknown;
  split_index: unknown;
  group_id: unknown;
  group_name: unknown;
  shared_of: unknown;
  shared_kind: unknown;
  shared_person: unknown;
  transaction_id: unknown;
  category: unknown;
  nya_category: unknown;
  nya_category_id: unknown;
  nya_group: unknown;
  note: unknown;
  excluded: unknown;
  name: unknown;
  nya_name: unknown;
  tags: unknown;
};

/** A filed row's category as the file names it (lib/user-export.ts filedAs). */
function nyaCategory(t: Txn, ix: CategoryIndex): { nya_category: string | null; nya_category_id: string | null; nya_group: string | null } {
  const c = t.category_id ? categoryById(ix, t.category_id) : null;
  if (!c) return { nya_category: null, nya_category_id: null, nya_group: null };
  return { nya_category: t.category_name ?? null, nya_category_id: isProvisionalId(c.id) ? null : c.id, nya_group: groupOf(ix, c).name };
}

const excludedCell = (t: Txn) => (t.excluded === true ? true : t.excluded === null ? null : false);

/**
 * The CSV's rows with splits and groups applied (see the header), in the
 * file's order: newest first, a split transaction's parts right after it,
 * a group's row on the group's day. `blank` is a row with every column
 * empty, for a group's own row.
 */
export function csvLinesWithSplits<C extends Record<string, unknown> & Filled>(
  lines: readonly CsvLine<C>[],
  inputs: SplitInputs,
  blank: () => C,
  shares: ShareInputs | null = null
): CsvLine<C>[] {
  // A row counts as itself, but a pending one its posted one replaced: the
  // app doesn't list it, so nothing counts it twice.
  const counted = (line: CsvLine<C>): CsvLine<C> => ({
    ...line,
    cells: () => {
      const cells = line.cells();
      return { ...cells, nya_amount: cells.superseded_by_posted === true ? null : line.txn.amount };
    },
  });
  if ((!anySplitsOrGroups(inputs) && !shares) || !inputs.ix) return lines.map(counted);
  const ix = inputs.ix;
  const byId = new Map(lines.map((l) => [l.id, l]));
  const expanded = expandSplitsAndGroups(
    lines.map((l) => l.txn),
    inputs
  ).rows;
  // Shared expenses after them, as the app applies them (see SHARED EXPENSES).
  const rows = shares ? applyShares(expanded, shares).rows : expanded;
  // The columns a row the shared layer added fills.
  const sharedCells = (t: Txn) =>
    t.shared_part
      ? { shared_of: t.split_of ?? t.shared_of ?? null, shared_kind: t.shared_part.kind, shared_person: t.shared_part.person }
      : t.shared_iou
        ? { shared_of: null, shared_kind: 'iou', shared_person: t.shared_iou.person }
        : {};
  const out: (CsvLine<C> & { order: [string, string, string, number] })[] = [];
  const at = (line: CsvLine<C>, key: string, n: number) => ({ ...line, order: [line.date, line.time, key, n] as [string, string, string, number] });
  const parentsListed = new Set<string>();
  for (const t of rows) {
    if (t.split_of !== undefined) {
      const parent = byId.get(t.split_of)!;
      if (!parentsListed.has(t.split_of)) {
        parentsListed.add(t.split_of);
        // The transaction itself: its own amount, counted through its parts.
        out.push(at({ ...parent, cells: () => ({ ...parent.cells(), nya_amount: null }) }, parent.id, 0));
      }
      const part = t;
      out.push(
        at(
          {
            ...parent,
            id: part.transaction_id,
            cells: () => ({
              ...parent.cells(),
              transaction_id: part.transaction_id,
              amount: null,
              nya_amount: part.amount,
              // Its own category; the difference the bank made since is
              // filed as the transaction is, as the app files it.
              ...(part.split_remainder ? {} : { category: part.category, ...nyaCategory(part, ix) }),
              note: part.note ?? null,
              excluded: excludedCell(part),
              split_of: part.split_of,
              split_index: part.split_index,
              ...sharedCells(part),
            }),
          },
          parent.id,
          1 + (part.split_index ?? 0)
        )
      );
      continue;
    }
    if (t.group_members) {
      const group = t;
      const anchor = byId.get(group.group_members![0].transaction_id)!;
      out.push(
        at(
          {
            date: group.date,
            time: '',
            id: group.transaction_id,
            txn: group,
            cells: () => {
              const a = anchor.cells();
              return {
                ...blank(),
                date: group.date,
                account_name: a.account_name,
                institution_name: a.institution_name,
                account_hidden: a.account_hidden,
                iso_currency_code: a.iso_currency_code,
                unofficial_currency_code: a.unofficial_currency_code,
                account_id: a.account_id,
                item_id: a.item_id,
                source: a.source,
                transaction_id: group.transaction_id,
                name: group.name,
                nya_name: group.name,
                amount: null,
                nya_amount: group.amount,
                category: group.category,
                ...nyaCategory(group, ix),
                tags: (group.tags ?? []).join('; '),
                excluded: false,
                pending: false,
                superseded_by_posted: false,
                group_id: group.group_id,
                group_name: group.name,
              };
            },
          },
          group.transaction_id,
          0
        )
      );
      for (const m of group.group_members!) {
        const member = byId.get(m.transaction_id)!;
        out.push(at({ ...member, cells: () => ({ ...member.cells(), nya_amount: null, group_id: group.group_id, group_name: group.name }) }, member.id, 0));
      }
      continue;
    }
    if (t.shared_iou) {
      // An IOU you owe for something: a row of its own on its day, on no
      // account, `amount` empty (no money moved on an account).
      const iou = t;
      out.push(
        at(
          {
            date: iou.date,
            time: '',
            id: iou.transaction_id,
            txn: iou,
            cells: () => ({
              ...blank(),
              date: iou.date,
              iso_currency_code: iou.iso_currency_code,
              unofficial_currency_code: iou.unofficial_currency_code ?? null,
              source: 'shared',
              transaction_id: iou.transaction_id,
              name: iou.name,
              nya_name: iou.name,
              amount: null,
              nya_amount: iou.amount,
              category: iou.category,
              ...nyaCategory(iou, ix),
              excluded: false,
              pending: false,
              superseded_by_posted: false,
              ...sharedCells(iou),
            }),
          },
          iou.transaction_id,
          0
        )
      );
      continue;
    }
    if (t.shared_of !== undefined) {
      const owner = byId.get(t.shared_of)!;
      if (t.transaction_id === t.shared_of) {
        // The transaction itself: its own amount, and what the app counts of
        // it, your part (or what is left of a payment).
        out.push(at({ ...owner, cells: () => ({ ...owner.cells(), nya_amount: t.amount }) }, owner.id, 0));
        continue;
      }
      const added = t;
      out.push(
        at(
          {
            ...owner,
            id: added.transaction_id,
            cells: () => ({ ...owner.cells(), transaction_id: added.transaction_id, amount: null, nya_amount: added.amount, excluded: excludedCell(added), ...sharedCells(added) }),
          },
          owner.id,
          1
        )
      );
      continue;
    }
    const line = byId.get(t.transaction_id)!;
    out.push(at(counted(line), line.id, 0));
  }
  // Newest first, then by the event time, then the transaction a row is of,
  // each split transaction's parts right after it.
  out.sort((a, b) => cmp(b.order[0], a.order[0]) || cmp(b.order[1], a.order[1]) || cmp(a.order[2], b.order[2]) || a.order[3] - b.order[3]);
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---- An OFX statement's memo ----

/** How the file's splits and groups apply, as the app applies them: the
 *  group each transaction counts in, by name, and the transactions whose
 *  split applies (one pending, in another currency now, or in a group shows
 *  whole), each with the id the split is kept under (its own, or that of the
 *  row imported from a file a bank row stands for). From the read layer's
 *  own function, once for the file. */
export type AppliedSplits = { groupOf: ReadonlyMap<string, string>; split: ReadonlyMap<string, string> };

/** The file's splits and groups as they apply (AppliedSplits), from every row
 *  of the file (lib/user-export.ts splitFactRows). */
export function appliedSplitsOf(rows: readonly Txn[], inputs: SplitInputs): AppliedSplits {
  const groupOf = new Map<string, string>();
  const split = new Map<string, string>();
  if (!anySplitsOrGroups(inputs)) return { groupOf, split };
  for (const t of expandSplitsAndGroups(rows, inputs).rows) {
    if (t.group_members) for (const m of t.group_members) groupOf.set(m.transaction_id, t.name);
    else if (t.split_of !== undefined) split.set(t.split_of, t.split_carried_from ?? t.split_of);
  }
  return { groupOf, split };
}

/** "100.00" in the currency's own places. */
function amountText(amount: number, currency: string | null): string {
  const scale = unitScale(currency);
  const places = Math.round(Math.log10(scale));
  return (Math.abs(toUnits(amount, scale)) / scale).toFixed(places);
}

/**
 * What an OFX statement's memo says of a transaction's split or group, or
 * null: its parts as the app files them ("Split in Nya: Food and drink
 * 100.00; Home improvement 50.00", and "the bank added 10.00 since" or "the
 * bank took 10.00 off since" when it changed the amount, "10.00 added since"
 * on a row entered by hand or imported), or the group it is in ("In the
 * group Dinner with Sam in Nya").
 * Only a split the app applies: a transaction pending, or in another
 * currency now than when it was split, shows whole there.
 */
export function splitMemoOf(
  row: { id: string; amount: number; currency: string | null; /** The bank keeps its amount (false: entered by hand or imported). */ bank?: boolean },
  inputs: SplitInputs,
  applied: AppliedSplits
): string | null {
  const group = applied.groupOf.get(row.id);
  if (group !== undefined) return `In the group ${group} in Nya`;
  const kept = applied.split.get(row.id);
  const record = kept === undefined ? undefined : inputs.splits.get(kept);
  const ix = inputs.ix;
  if (!record || !ix) return null;
  const scale = unitScale(row.currency);
  const parts = record.parts.map((p) => {
    const c = categoryById(ix, p.category_id);
    return `${c ? displayName(c.name) : 'Uncategorized'} ${amountText(p.amount, row.currency)}`;
  });
  const left = toUnits(row.amount, scale) - record.parts.reduce((n, p) => n + toUnits(p.amount, scale), 0);
  // In minor units: what was added to the transaction since, or taken off
  // it, by the bank (a row entered by hand or imported changes when it is
  // edited or imported again).
  const added = Math.sign(left) === Math.sign(row.amount);
  const by = amountText(left / scale, row.currency);
  if (left !== 0) parts.push(row.bank === false ? `${by} ${added ? 'added' : 'taken off'} since` : `the bank ${added ? `added ${by}` : `took ${by} off`} since`);
  return `Split in Nya: ${parts.join('; ')}`;
}

/** What an OFX statement's memo says of a shared transaction or a payment
 *  that paid something back, by transaction id, as the app applies them
 *  (see SHARED EXPENSES): "Shared in Nya: your part 60.00; others 60.00",
 *  "Paid back in Nya: 35.00". Never a name. */
export function appliedSharesOf(rows: readonly Txn[], inputs: SplitInputs, shares: ShareInputs): Map<string, string> {
  const sums = new Map<string, { yours: number; others: number; paid: number; currency: string | null }>();
  const at = (id: string, currency: string | null) => {
    const cur = sums.get(id) ?? { yours: 0, others: 0, paid: 0, currency };
    sums.set(id, cur);
    return cur;
  };
  for (const t of applyShares(expandSplitsAndGroups(rows, inputs).rows, shares).rows) {
    const currency = t.iso_currency_code ?? t.unofficial_currency_code ?? null;
    if (t.shared) {
      const s = at(t.split_of ?? t.transaction_id, currency);
      s.yours += t.shared.your_part;
      s.others += t.shared.people.reduce((n, p) => n + p.amount, 0);
    }
    if (t.settles) at(t.transaction_id, currency).paid += t.settles.people.reduce((n, p) => n + p.amount, 0);
  }
  const out = new Map<string, string>();
  for (const [id, s] of sums) {
    const words: string[] = [];
    if (s.others > 0) words.push(`Shared in Nya: your part ${amountText(s.yours, s.currency)}; others ${amountText(s.others, s.currency)}`);
    if (s.paid > 0) words.push(`Paid back in Nya: ${amountText(s.paid, s.currency)}`);
    if (words.length > 0) out.set(id, words.join('. '));
  }
  return out;
}
