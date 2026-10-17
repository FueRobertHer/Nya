// lib/history-import/view.ts
//
// What the net-worth chart says about the estimated history drawn back
// through imported transactions (#52, lib/history-import/extend.ts): which
// stretch of which account's estimate follows imported rows rather than the
// bank's own, and what imported history isn't drawn, and why. Pure, safe to
// import from client code: the net-worth route sends the view
// (importedHistoryView), and the chart's note puts it in words with the
// accounts' names (importedHistoryLines).

import type { ExcludedImport, WalkState, WalkWhy } from './store';

/** The prefix of a row's id imported into a linked account
 *  (lib/history-import/store.ts), here so client code can tell one apart:
 *  never edited as a manual row is, and named under a month's totals. */
export const IMPORTED_TXN_PREFIX = 'imported-txn:';

/** A month's row as importedRowsNote reads it: a transaction's, a part of a
 *  split one's (#39, lib/split-rows.ts: `split_of`, the transaction's id), or
 *  a group's, its transactions inside it. */
export type NotedRow = { transaction_id: string; split_of?: string; group_members?: readonly NotedRow[] };

/** Under a month's totals on the Activity tab: how many of its transactions
 *  came from files imported into linked accounts rather than from the bank,
 *  or null. Transactions, not rows: a split one is one, its parts said by
 *  their transaction's id, and a group's are each one. `period` names the
 *  days the rows are of, for totals over others (the cash flow's,
 *  lib/cash-flow.ts: "October", "this period"). */
export function importedRowsNote(rows: readonly NotedRow[], period = 'this month'): string | null {
  const imported = new Set<string>();
  for (const t of rows) {
    for (const m of t.group_members ?? [t]) {
      const id = m.split_of ?? m.transaction_id;
      if (id.startsWith(IMPORTED_TXN_PREFIX)) imported.add(id);
    }
  }
  const n = imported.size;
  if (n === 0) return null;
  return `${n.toLocaleString('en-US')} of ${period}’s transactions ${n === 1 ? 'was' : 'were'} imported from your bank’s files, not sent by the bank.`;
}

/**
 * Beside a bank row that stands for a row imported from the bank's file at
 * another amount (the bank changed its own after the two were paired, and
 * the pair was kept: lib/history-import/match.ts KEPT ONCE MADE), what
 * happened, in words, or null. `money` formats an amount in the row's
 * currency.
 */
export function importedChangedNote(t: { imported_amount?: number }, money: (n: number) => string): string | null {
  if (t.imported_amount === undefined) return null;
  return `This is the transaction you imported from your bank’s file at ${money(Math.abs(t.imported_amount))}. The bank has changed its amount since, so it counts once, at the bank’s amount.`;
}

export type ImportedHistoryView = {
  /** The chart's earliest point before the drawing: what it joins. */
  until: string;
  /** The oldest day drawn, or null when nothing was. */
  from: string | null;
  /** The accounts whose estimate follows imported transactions: back to
   *  `reach`, and from `bank_from` on (where the bank's own begin) the bank's. */
  accounts: { account_id: string; reach: string; bank_from: string | null }[];
  /** Imported stretches not drawn, and the uncovered days that cut each off. */
  gaps: { account_id: string; imported: { from: string; to: string }; uncovered: { from: string; to: string } }[];
  /** Accounts with imported history that isn't drawn at all, and why. */
  unwalked: { account_id: string; why: WalkWhy }[];
  /** Imports whose period isn't used to draw, and why. */
  excluded: (ExcludedImport & { account_id: string })[];
  /** Accounts whose covered days reach past thirty years, which aren't drawn. */
  capped: string[];
  /** It is being drawn again (an import, an undo or a link since). */
  redrawing: boolean;
  /** It couldn't be drawn again: what it needs can't be read (these accounts'
   *  imported transactions, when it is theirs). What was drawn is kept. */
  problem: { accounts: string[] } | null;
};

/** Accounts that ended (#50, lib/lifecycle.ts EndedAccounts): every id of
 *  each, with the day it stops counting. */
export type EndedDays = ReadonlyMap<string, { from: string }>;

/** Whether an account counts on a day: before its end, if it has one. */
const countsOn = (ended: EndedDays, account_id: string, day: string) => {
  const end = ended.get(account_id)?.from;
  return end === undefined || day < end;
};

/** The view of what was drawn, or null when there is nothing to say.
 *  `hidden` are the hidden accounts' ids, which the chart leaves out, so it
 *  says nothing of them either. `ended` are the accounts that ended
 *  (lib/lifecycle.ts), which the chart leaves out from their end day on, the
 *  days drawn included: an account's imported history drawn only from its
 *  end on, or an import not drawn from then, says nothing of the chart, so
 *  it isn't said either, and one that ended before its bank's own
 *  transactions begin counts in the chart only where its estimate follows
 *  imported ones (the chart marks its end). */
export function importedHistoryView(state: WalkState | null, hidden: ReadonlySet<string> = new Set(), ended: EndedDays = new Map()): ImportedHistoryView | null {
  if (!state) return null;
  const shown = state.accounts.filter((a) => !hidden.has(a.account_id));
  const problem = state.problem ? { accounts: state.problem.accounts.filter((id) => !hidden.has(id)) } : null;
  if (!state.anchor && !problem) return null;
  const accounts = shown.flatMap((a) => {
    if (!a.reach || !countsOn(ended, a.account_id, a.reach)) return [];
    const end = ended.get(a.account_id)?.from;
    return [{ account_id: a.account_id, reach: a.reach, bank_from: a.bank_from && end !== undefined && end <= a.bank_from ? null : a.bank_from }];
  });
  const gaps = shown.flatMap((a) => a.gaps.filter((g) => countsOn(ended, a.account_id, g.imported.from)).map((g) => ({ account_id: a.account_id, ...g })));
  const unwalked = shown.flatMap((a) => (a.why ? [{ account_id: a.account_id, why: a.why }] : []));
  const excluded = shown.flatMap((a) => a.excluded.filter((x) => countsOn(ended, a.account_id, x.from)).map((x) => ({ account_id: a.account_id, ...x })));
  if (accounts.length === 0 && gaps.length === 0 && unwalked.length === 0 && excluded.length === 0 && !problem) return null;
  return {
    until: state.anchor ?? state.from ?? '',
    from: state.from,
    accounts,
    gaps,
    unwalked,
    excluded,
    capped: shown.filter((a) => a.capped).map((a) => a.account_id),
    redrawing: state.built !== state.generation && !problem,
    problem,
  };
}

/**
 * The stretch of estimated points that follows imported transactions, for
 * the read-only API (`from_imports`): of net worth (`ids` null), from the
 * oldest day an account's estimate follows them up to (not including) the
 * last day any account's does, where its bank's own begin, or where it ended
 * (`ended`: net worth leaves it out from then, lib/lifecycle.ts); or of one
 * account (any of its ids), whose own history keeps every day. Null when none
 * does.
 */
export function importedStretch(
  state: WalkState | null,
  ids: readonly string[] | null,
  hidden: ReadonlySet<string> = new Set(),
  ended: EndedDays = new Map()
): { from: string; until: string } | null {
  if (!state?.anchor) return null;
  const anchor = state.anchor;
  const following = state.accounts.flatMap((a) => {
    if (!a.reach || hidden.has(a.account_id) || (ids !== null && !ids.includes(a.account_id))) return [];
    const own = a.bank_from && a.bank_from > a.reach ? a.bank_from : anchor;
    const end = ids === null ? ended.get(a.account_id)?.from : undefined;
    const until = end !== undefined && end < own ? end : own;
    return until > a.reach ? [{ from: a.reach, until }] : [];
  });
  if (following.length === 0) return null;
  const from = following.map((a) => a.from).sort()[0];
  const until = following.map((a) => a.until).sort().pop()!;
  return until > from ? { from, until } : null;
}

const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The view in words, one sentence a line: `name` gives an account's name as
 * the dashboard shows it ("Chase Checking"), `day` a calendar day as the
 * viewer reads one.
 */
export function importedHistoryLines(view: ImportedHistoryView, name: (account_id: string) => string, day: (d: string) => string): string[] {
  const lines: string[] = [];
  for (const a of view.accounts) {
    lines.push(
      a.bank_from && a.bank_from > a.reach
        ? `${name(a.account_id)}: the estimate follows its bank’s own transactions back to ${day(a.bank_from)}, and those you imported before that, back to ${day(a.reach)}.`
        : `${name(a.account_id)}: the estimate follows the transactions you imported, back to ${day(a.reach)}.`
    );
  }
  if (view.accounts.length > 0 && view.from) lines.push(`Before ${day(view.until)}, every other account is held at its balance on that day.`);
  for (const g of view.gaps) {
    lines.push(
      `Not drawn: ${name(g.account_id)}’s import from ${day(g.imported.from)} to ${day(g.imported.to)}, since nothing covers ${day(g.uncovered.from)}${g.uncovered.from === g.uncovered.to ? '' : ` to ${day(g.uncovered.to)}`}. Import that period to join it up.`
    );
  }
  for (const x of view.excluded) {
    const what = `${name(x.account_id)}’s import from ${day(x.from)} to ${day(x.to)} isn’t used for the chart`;
    lines.push(
      x.why === 'unreadable'
        ? `${what}: ${x.lines === 1 ? 'one of its lines' : `${(x.lines ?? 0).toLocaleString('en-US')} of its lines`} couldn’t be read, so it may lack their transactions.`
        : `${what}: some of its transactions are in ${x.currency ?? 'another currency'}, not the account’s currency.`
    );
  }
  for (const u of view.unwalked) {
    if (view.gaps.some((g) => g.account_id === u.account_id) || view.excluded.some((x) => x.account_id === u.account_id)) continue;
    lines.push(
      u.why === 'not-counted'
        ? `${name(u.account_id)}’s imported history isn’t drawn: the chart’s earliest point, on ${day(view.until)}, doesn’t count that account.`
        : u.why === 'held-flat'
          ? `${name(u.account_id)}’s imported history isn’t drawn: the estimate holds it at one balance up to ${day(view.until)}, though it has transactions since, so what it held then isn’t known.`
          : `${name(u.account_id)}’s imported history isn’t drawn: nothing covers ${day(view.until)}, the chart’s earliest day, for it. Import a file that reaches up to then.`
    );
  }
  if (view.capped.length > 0) lines.push(`Only the last thirty years are drawn for ${list(view.capped.map(name))}.`);
  if (view.problem) {
    lines.push(
      view.problem.accounts.length > 0
        ? `The estimate from imported transactions couldn’t be drawn again: ${list(view.problem.accounts.map(name))}’s imported transactions can’t be read just now. What it showed before is kept.`
        : 'The estimate from imported transactions couldn’t be drawn again: what it needs can’t be read just now. What it showed before is kept.'
    );
  }
  if (view.redrawing) lines.push('It is being drawn again for a change you made, and shows here on a later load.');
  return lines;
}
