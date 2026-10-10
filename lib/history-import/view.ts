// lib/history-import/view.ts
//
// What the net-worth chart says about the estimated history drawn back
// through imported transactions (#52, lib/history-import/extend.ts): which
// stretch comes from imported rows rather than the bank, and what imported
// history isn't drawn, and why. Pure, safe to import from client code: the
// net-worth route sends the view (importedHistoryView), and the chart's note
// puts it in words with the accounts' names (importedHistoryLines).

import type { WalkState } from './store';

export type ImportedHistoryView = {
  /** Estimated points before this day are built from imported transactions:
   *  the chart's earliest point before them, which they join. */
  until: string;
  /** The oldest day drawn, or null when nothing was. */
  from: string | null;
  /** The accounts whose imported transactions the stretch is built from. */
  accounts: string[];
  /** Imported stretches not drawn, and the uncovered days that cut each off. */
  gaps: { account_id: string; imported: { from: string; to: string }; uncovered: { from: string; to: string } }[];
  /** Accounts with imported history that isn't drawn at all, and why: the
   *  earliest point doesn't count the account, or nothing covers its day. */
  unwalked: { account_id: string; why: 'not-counted' | 'anchor-not-covered' }[];
  /** Accounts whose covered days reach past thirty years, which aren't drawn. */
  capped: string[];
  /** It is being drawn again (an import, an undo or a link since). */
  redrawing: boolean;
};

/** The view of what was drawn, or null when there is nothing to say. */
export function importedHistoryView(state: WalkState | null): ImportedHistoryView | null {
  if (!state || !state.anchor) return null;
  const walked = state.accounts.filter((a) => a.reach !== null && a.reach < state.anchor!);
  const gaps = state.accounts.flatMap((a) => a.gaps.map((g) => ({ account_id: a.account_id, ...g })));
  const unwalked = state.accounts.flatMap((a) => (a.why ? [{ account_id: a.account_id, why: a.why }] : []));
  if (walked.length === 0 && gaps.length === 0 && unwalked.length === 0) return null;
  return {
    until: state.anchor,
    from: state.from,
    accounts: walked.map((a) => a.account_id),
    gaps,
    unwalked,
    capped: state.accounts.filter((a) => a.capped).map((a) => a.account_id),
    redrawing: state.built !== state.generation,
  };
}

const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The view in words, one sentence a line: `name` gives an account's name as
 * the dashboard shows it ("Chase Checking"), `day` a calendar day as the
 * viewer reads one.
 */
export function importedHistoryLines(view: ImportedHistoryView, name: (account_id: string) => string, day: (d: string) => string): string[] {
  const lines: string[] = [];
  if (view.accounts.length > 0 && view.from) {
    lines.push(
      `Before ${day(view.until)}, the estimate reaches back through transactions you imported for ${list(view.accounts.map(name))}, rather than through your bank’s own; every other account is held at its balance on that day.`
    );
  }
  for (const g of view.gaps) {
    lines.push(
      `Not drawn: ${name(g.account_id)}’s import from ${day(g.imported.from)} to ${day(g.imported.to)}, since nothing covers ${day(g.uncovered.from)}${g.uncovered.from === g.uncovered.to ? '' : ` to ${day(g.uncovered.to)}`}. Import that period to join it up.`
    );
  }
  for (const u of view.unwalked) {
    if (view.gaps.some((g) => g.account_id === u.account_id)) continue;
    lines.push(
      u.why === 'not-counted'
        ? `${name(u.account_id)}’s imported history isn’t drawn: the chart’s earliest point, on ${day(view.until)}, doesn’t count that account.`
        : `${name(u.account_id)}’s imported history isn’t drawn: nothing covers ${day(view.until)}, the chart’s earliest day, for it. Import a file that reaches up to then.`
    );
  }
  if (view.capped.length > 0) lines.push(`Only the last thirty years are drawn for ${list(view.capped.map(name))}.`);
  if (view.redrawing) lines.push('It is being drawn again for a change you made, and shows here on a later load.');
  return lines;
}
