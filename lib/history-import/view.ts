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

/** Under a month's totals on the Activity tab: how many of its rows came from
 *  files imported into linked accounts rather than from the bank, or null. */
export function importedRowsNote(rows: readonly { transaction_id: string }[]): string | null {
  const n = rows.filter((t) => t.transaction_id.startsWith(IMPORTED_TXN_PREFIX)).length;
  if (n === 0) return null;
  return `${n.toLocaleString('en-US')} of this month’s transactions ${n === 1 ? 'was' : 'were'} imported from your bank’s files, not sent by the bank.`;
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

/** The view of what was drawn, or null when there is nothing to say.
 *  `hidden` are the hidden accounts' ids, which the chart leaves out, so it
 *  says nothing of them either. */
export function importedHistoryView(state: WalkState | null, hidden: ReadonlySet<string> = new Set()): ImportedHistoryView | null {
  if (!state) return null;
  const shown = state.accounts.filter((a) => !hidden.has(a.account_id));
  const problem = state.problem ? { accounts: state.problem.accounts.filter((id) => !hidden.has(id)) } : null;
  if (!state.anchor && !problem) return null;
  const accounts = shown.flatMap((a) => (a.reach ? [{ account_id: a.account_id, reach: a.reach, bank_from: a.bank_from }] : []));
  const gaps = shown.flatMap((a) => a.gaps.map((g) => ({ account_id: a.account_id, ...g })));
  const unwalked = shown.flatMap((a) => (a.why ? [{ account_id: a.account_id, why: a.why }] : []));
  const excluded = shown.flatMap((a) => a.excluded.map((x) => ({ account_id: a.account_id, ...x })));
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
 * last day any account's does, where its bank's own begin; or of one account
 * (any of its ids). Null when none does.
 */
export function importedStretch(state: WalkState | null, ids: readonly string[] | null, hidden: ReadonlySet<string> = new Set()): { from: string; until: string } | null {
  if (!state?.anchor) return null;
  const anchor = state.anchor;
  const following = state.accounts.filter((a) => a.reach && !hidden.has(a.account_id) && (ids === null || ids.includes(a.account_id)));
  if (following.length === 0) return null;
  const from = following.map((a) => a.reach!).sort()[0];
  const until = following.map((a) => (a.bank_from && a.bank_from > a.reach! ? a.bank_from : anchor)).sort().pop()!;
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
