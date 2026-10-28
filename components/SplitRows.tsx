'use client';

// Splits and groups on the Activity tab's list (#39): a split transaction is
// listed once, as the bank has it, with its parts nested under it, each with
// its category and amount; a group's row says what its transactions come to,
// with them nested under it. Grouping is how they are shown, keyed on
// split_of and group_id (lib/split-rows.ts): the totals above the list count
// the parts and the nets, as every total does. This file holds the nested
// rows, which open the transaction's sheet (components/TransactionSheet.tsx),
// and the actions that sheet gains (Split, Group with others, Edit split,
// Edit group); the sheets that make them are components/SplitSheet.tsx and
// components/GroupSheet.tsx.

import type { Txn } from './MonthBreakdown';
import type { SheetTarget } from './TransactionSheet';
import type { SheetAction } from './ActionRows';
import { Masked } from './HideAmounts';
import { signedMoney } from '@/lib/format';
import { currencyOf } from '@/lib/spending';
import { displayName, type Taxonomy } from '@/lib/categories';
import { bankRows } from '@/lib/split-rows';
import { isConnectorKind } from '@/lib/connectors/types';
import { isFileImportedId } from '@/lib/history-import/view';
import { shownName } from '@/lib/merchant-name';

/** What a row of the list says in place of its category: a split
 *  transaction's parts, a group's size; null for any other. */
export function entryLabel(t: Pick<Txn, 'split_parts' | 'group_members' | 'group_missing' | 'group_removed'>): string | null {
  // The parts the person made: the difference the bank made since is not one.
  if (t.split_parts) return `Split into ${t.split_parts.filter((p) => !p.split_remainder).length}`;
  if (t.group_members) {
    const n = t.group_members.length;
    return `Group of ${n}`;
  }
  return null;
}

/** Each split transaction among the rows put back whole, every part of it
 *  (lib/split-rows.ts bankRows), by its id: what a list showing only some of
 *  its parts (a pick from the cash flow lists those in its node, #41) says
 *  it is split into, and edits its split from. */
export function wholeSplits(rows: readonly Txn[]): Map<string, Txn> {
  return new Map(bankRows(rows.filter((t) => t.split_of !== undefined)).map((t) => [t.transaction_id, t]));
}

/** Whether the bank (through Plaid or SimpleFIN) keeps a row's amount: a
 *  row entered by hand or imported changes only when it is edited or
 *  imported again. */
export const bankKept = (t: Pick<Txn, 'source'>): boolean => !t.source || isConnectorKind(t.source);

/** Whether a row is one imported into a linked account from its bank's file
 *  (#52), whose amount is the file's and never changes: a split of it that
 *  adds up to another amount was saved while a bank row at that amount stood
 *  for it (an edit then adds up to the bank's), and none does now (the bank
 *  removed it), so it counts at the file's amount again. */
export const splitAtBanksAmount = (t: Pick<Txn, 'transaction_id'>): boolean => isFileImportedId(t.transaction_id);

/** Where a split transaction's split is kept, which an edit of it names: the
 *  transaction itself, or the row imported from a file that a bank row stands
 *  for, whose split it shows (lib/split-rows.ts split_carried_from). `t` is
 *  the transaction put back whole, its parts beside it. */
export const splitKeptUnder = (t: Pick<Txn, 'transaction_id' | 'split_parts'>): string => t.split_parts?.[0]?.split_carried_from ?? t.transaction_id;

/** The id a group holds one of its transactions by, which taking it out
 *  names: its own, or that of the row imported from a file that it stands
 *  for, whose place in the group it takes (lib/split-rows.ts
 *  group_carried_from). */
export const heldInGroupAs = (m: Pick<Txn, 'transaction_id' | 'group_carried_from'>): string => m.group_carried_from ?? m.transaction_id;

/** A row's notice under its name about its split or group, if any. */
export function entryNotice(t: Txn): string | null {
  if (t.group_outside) {
    const day = new Date(`${t.group_outside.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    return `It is in the group “${t.group_outside.name}”, which counts on ${day}, before the transactions shown here begin, so it isn’t counted here.`;
  }
  if (t.group_unapplied) {
    return `It is in the group “${t.group_unapplied.name}”, whose transactions are in more than one currency now, so it counts on its own. Ungroup it to split this or group it again.`;
  }
  if (t.split_unread) return 'How you split this couldn’t be read, so it shows whole.';
  if (t.split_unapplied) return 'Its split no longer fits (its currency changed), so it shows whole: split it again.';
  if (t.split_parts?.some((p) => p.split_remainder)) {
    if (splitAtBanksAmount(t)) {
      return 'You split this at the amount of the bank’s transaction that stood for it. None does now, so it counts at your file’s amount, with the difference as a part of its own until you edit the split.';
    }
    return bankKept(t) ? 'The bank changed this amount since you split it.' : 'This amount changed since you split it.';
  }
  return t.group_members ? groupGoneText(t, 'row') : null;
}

/**
 * What is said of a group's transactions that aren't counted in it: first
 * those whose reason the read layer knows (lib/split-rows.ts group_away:
 * pending at the bank, or counted in another group), then the rest, which
 * the bank removed, are on an account hidden or ended, or couldn't be
 * loaded. On the group's row in the list (`row`), or in its sheet, which
 * lists the ones counted (`sheet`). Null when every one is counted.
 */
export function groupGoneText(t: Pick<Txn, 'group_missing' | 'group_removed' | 'group_away'>, where: 'row' | 'sheet'): string | null {
  const gone = (t.group_missing ?? 0) + (t.group_removed ?? 0);
  if (gone === 0) return null;
  const away = t.group_away ?? [];
  const pending = away.filter((a) => a.why === 'pending').length;
  const elsewhere = new Map<string, number>();
  for (const a of away) if (a.why === 'grouped') elsewhere.set(a.group, (elsewhere.get(a.group) ?? 0) + 1);
  const rest = gone - pending - [...elsewhere.values()].reduce((n, c) => n + c, 0);
  const one = (n: number) => n === 1;
  // "1 of its transactions is" on the row; "1 more transaction is in it" in the sheet.
  const lead = (n: number, verb: [string, string]) =>
    where === 'row' ? `${n} of its transactions ${one(n) ? verb[0] : verb[1]}` : `${n} more ${one(n) ? 'transaction is' : 'transactions are'} in it, and ${one(n) ? verb[0] : verb[1]}`;
  const said: string[] = [];
  if (pending > 0) {
    said.push(`${lead(pending, ['is', 'are'])} pending at the bank, so ${one(pending) ? 'it counts on its own until it posts' : 'they count on their own until they post'}.`);
  }
  for (const [group, n] of elsewhere) said.push(`${lead(n, ['counts', 'count'])} in the group “${group}” instead.`);
  if (rest > 0) {
    const why = `the bank removed ${one(rest) ? 'it' : 'them'}, ${one(rest) ? 'its' : 'their'} account is hidden or ended, or ${one(rest) ? 'it' : 'they'} couldn’t be loaded`;
    if (where === 'sheet') said.push(`${rest} more ${one(rest) ? 'transaction was' : 'transactions were'} in it and ${one(rest) ? 'isn’t' : 'aren’t'} here: ${why}.`);
    else said.push(`${said.length > 0 ? `${rest} more` : `${rest} of its transactions`} ${one(rest) ? 'isn’t' : 'aren’t'} here (${why}), so ${one(rest) ? 'it isn’t' : 'they aren’t'} counted.`);
  }
  return said.join(' ');
}

/** The actions a transaction's detail gains: Split and Group with others on
 *  one counted on its own, Edit split on a split one, Edit group on a
 *  group's row, and Ungroup on one of a group that no longer applies (the
 *  list has no row for it). Not on a pending one, which gets a new id when it
 *  posts, nor on one shared whole or paying something back: for those,
 *  `said` is why, shown in their place. Rows of the sheet's one list of
 *  actions (components/ActionRows.tsx). */
export function splitActions(
  t: Txn,
  { onSplit, onGroup, onUngroup }: { onSplit: (t: Txn) => void; onGroup: (t: Txn) => void; /** Ungroups the group by its id. */ onUngroup: (id: string) => void }
): { rows: SheetAction[]; said: string | null } {
  const none = (said: string | null = null) => ({ rows: [], said });
  // In a group the list has no row for: one that no longer applies, or one
  // counted on a day before what is shown. Ungrouping acts at once.
  const listless = t.group_unapplied ?? t.group_outside;
  if (listless) return { rows: [{ key: 'ungroup', title: `Ungroup “${listless.name}”`, onSelect: () => onUngroup(listless.id) }], said: null };
  if (t.group_members) return { rows: [{ key: 'group', title: 'Edit group', opens: true, onSelect: () => onGroup(t) }], said: null };
  if (t.split_unread) return none();
  if (t.pending) return none('Once it posts, it can be split or grouped with others.');
  // Shared whole, or paying something back, under Shared expenses (its own
  // or carried to it across a re-link): that says how it counts, so it is
  // changed there first, as the server asks (lib/shared-expenses/edits.ts
  // sharesBlock).
  if (!t.split_parts && (t.shared || t.shared_unapplied)) {
    return none('It is shared under Shared expenses, which says how it counts: stop sharing it to split it or group it.');
  }
  if (!t.split_parts && (t.settles || t.settles_unapplied)) {
    return none('It pays something back under Shared expenses: reopen that payment to split it or group it.');
  }
  return {
    rows: [
      { key: 'split', title: t.split_parts ? 'Edit split' : 'Split', opens: true, onSelect: () => onSplit(t) },
      ...(t.split_parts ? [] : [{ key: 'group', title: 'Group with others', opens: true, onSelect: () => onGroup(t) }]),
    ],
    said: null,
  };
}

/** Sends a change to a split or a group: null when it was made, else what
 *  went wrong, in the server's words when it gave some. */
export async function sendChange(url: string, method: string, body: unknown): Promise<string | null> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return null;
    const data = await res.json().catch(() => null);
    return data?.error ?? 'Could not save that. Please try again.';
  } catch {
    return 'Could not reach the server.';
  }
}

/**
 * A split transaction's parts, each a row of its own under it: its category
 * and amount, its note, and one left out of budgets on its own said so. A
 * tap opens it in the transaction's sheet (components/TransactionSheet.tsx):
 * its category, whether it counts, and the whole split.
 */
export function PartRows({ parent, onOpen }: { parent: Txn; onOpen: (target: SheetTarget) => void }) {
  const currency = currencyOf(parent);
  return (
    <>
      {(parent.split_parts ?? []).map((p) => {
        const label = p.category_name !== undefined ? p.category_name : p.category;
        return (
          <li key={p.transaction_id}>
            <button
              type="button"
              className="list-row txn-row txn-part-row"
              aria-haspopup="dialog"
              onClick={() => onOpen({ kind: 'part', parent: parent.transaction_id, id: p.transaction_id })}
            >
              <span className="list-row-text">
                <span className="list-row-title">{label ? displayName(label) : 'No category'}</span>
                {p.note && <span className="list-row-sub">{p.note}</span>}
                {p.split_remainder && (
                  <span className="txn-row-note">
                    {bankKept(parent) ? 'What the bank changed the amount by' : 'What the amount changed by'} since you split it: edit the split to place it.
                  </span>
                )}
                {p.split_excluded && <span className="txn-row-note">Left out of budgets and reports on its own</span>}
              </span>
              <span className={`list-row-value money txn-amount${p.amount < 0 ? ' inflow' : ''}${p.excluded === true ? ' excluded' : ''}`}>
                <Masked>{signedMoney(-p.amount, currency, { always: true })}</Masked>
              </span>
            </button>
          </li>
        );
      })}
    </>
  );
}

/**
 * A group's transactions, each a row of its own under the group's: as it is,
 * its own amount and day. A tap opens it in the transaction's sheet, where
 * it can be taken out of the group.
 */
export function MemberRows({
  group,
  onOpen,
  accountName = (t) => t.account_name,
}: {
  group: Txn;
  onOpen: (target: SheetTarget) => void;
  /** Each account's name on a row, as the list gives it (txn-words.ts rowAccountNames). */
  accountName?: (t: Pick<Txn, 'institution_name' | 'account_name'>) => string;
}) {
  const members = group.group_members ?? [];
  const currency = currencyOf(group);
  return (
    <>
      {members.map((m) => (
        <li key={m.transaction_id}>
          <button
            type="button"
            className="list-row txn-row txn-part-row"
            aria-haspopup="dialog"
            onClick={() => onOpen({ kind: 'member', group: group.transaction_id, id: m.transaction_id })}
          >
            <span className="list-row-text">
              <span className="list-row-title">{shownName(m)}</span>
              <span className="list-row-sub">
                {new Date(`${m.date}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {accountName(m)}
              </span>
              {/* What was said of it on its own doesn't change the group's net. */}
              {m.excluded === true && <span className="txn-row-note">{m.excluded_by_rule ? 'A rule hides it' : 'You excluded it'}: in the group, it counts through the group.</span>}
            </span>
            <span className={`list-row-value money txn-amount${m.amount < 0 ? ' inflow' : ''} excluded`}>
              <Masked>{signedMoney(-m.amount, currency, { always: true })}</Masked>
            </span>
          </button>
        </li>
      ))}
    </>
  );
}
