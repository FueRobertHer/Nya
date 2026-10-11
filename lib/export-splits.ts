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
// their group. So adding up `amount` gives the money as it moved, adding up
// `nya_amount` gives the app's totals (by `nya_category`, its categories'),
// and neither counts a transaction twice. A part says whose it is
// (`split_of`, the transaction's id, and `split_index`); a transaction in a
// group and the group's row both say which (`group_id`, `group_name`).
//
// THE FILE HOLDS EVERY ROW, of every date and on hidden accounts too, so a
// group's net here is of all its transactions in the file, as `amount` adds
// them (the app leaves a hidden account's out, as it leaves the account out).
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
 *  the read layer takes them, filed against `ix`. */
export function splitInputsOf(part: (key: string) => unknown, problems: readonly Problem[], ix: CategoryIndex): SplitInputs {
  const unread = (section: string) => problems.filter((p) => p.section === section);
  return {
    splits: entriesOf<SplitRecord>(part(splitStore.name), isSplitRecord),
    splitsUnknown: new Set(unread(splitStore.name).flatMap((p) => p.ids ?? [])),
    groups: entriesOf<TxnGroup>(part(groupStore.name), isTxnGroup),
    groupsUnknown: unread(groupStore.name).reduce((n, p) => n + (p.ids?.length ?? p.count ?? 0), 0),
    ix,
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
  split_of: unknown;
  split_index: unknown;
  group_id: unknown;
  group_name: unknown;
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
  blank: () => C
): CsvLine<C>[] {
  const counted = (line: CsvLine<C>): CsvLine<C> => ({ ...line, cells: () => ({ ...line.cells(), nya_amount: line.txn.amount }) });
  if (!anySplitsOrGroups(inputs) || !inputs.ix) return lines.map(counted);
  const ix = inputs.ix;
  const byId = new Map(lines.map((l) => [l.id, l]));
  const { rows } = expandSplitsAndGroups(
    lines.map((l) => l.txn),
    inputs
  );
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
              category: part.category,
              ...(part.split_remainder ? {} : nyaCategory(part, ix)),
              note: part.note ?? null,
              excluded: excludedCell(part),
              split_of: part.split_of,
              split_index: part.split_index,
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

/** "100.00" in the currency's own places. */
function amountText(amount: number, currency: string | null): string {
  const scale = unitScale(currency);
  const places = Math.round(Math.log10(scale));
  return (Math.abs(toUnits(amount, scale)) / scale).toFixed(places);
}

/**
 * What an OFX statement's memo says of a transaction's split or group, or
 * null: its parts as the app files them ("Split in Nya: Food and drink
 * 100.00; Home improvement 50.00", what the bank changed since among them),
 * or the group it is in ("In the group Dinner with Sam in Nya, net 60.00").
 * Only a split the app applies: a transaction pending, or in another
 * currency now than when it was split, shows whole there.
 */
export function splitMemoOf(row: { id: string; amount: number; currency: string | null; pending?: boolean }, inputs: SplitInputs): string | null {
  const group = [...inputs.groups].find(([, g]) => g.members.includes(row.id));
  const ix = inputs.ix;
  if (group) return `In the group ${group[1].name} in Nya`;
  const record = inputs.splits.get(row.id);
  if (!record || row.pending || record.currency !== row.currency || !ix) return null;
  const scale = unitScale(row.currency);
  const parts = record.parts.map((p) => {
    const c = categoryById(ix, p.category_id);
    return `${c ? displayName(c.name) : 'Uncategorized'} ${amountText(p.amount, row.currency)}`;
  });
  const left = toUnits(row.amount, scale) - record.parts.reduce((n, p) => n + toUnits(p.amount, scale), 0);
  if (left !== 0) parts.push(`changed by the bank since ${amountText(left, row.currency)}`);
  return `Split in Nya: ${parts.join('; ')}`;
}
