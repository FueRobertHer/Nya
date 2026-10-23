// lib/report/runway-words.ts
//
// What the runway says (lib/report/runway.ts), in plain words, once: what it
// can't see and the what-if it was worked out with, for the report page
// (components/RunwayReport.tsx, its days on the reader's calendar, its
// amounts through the switch to hide them, since each is written when the
// page is drawn) and for the read-only API's notes (lib/api-reports.ts, days
// as YYYY-MM-DD). Pure and client-safe.

import { formatMoney } from '../format';
import { joinNames } from '../month-coverage';
import { noSpending, type RunwayProjection, type RunwayWhatIf, type WindowSpending } from './runway';
import type { RunwayReport } from './runway-read';
import { gapSentences, type DayFormat } from './words';

/** How a calendar day, an instant and a month (YYYY-MM) are written. */
export type RunwayFormats = { day: DayFormat; time: (iso: string) => string; month: (month: string) => string };

/** Whether a window has one-offs to leave out, and money moved out to count. */
export const hasOneOffs = (w: WindowSpending) => w.one_offs.length + w.one_offs_in.length > 0;
export const hasMovedOut = (w: WindowSpending) => w.transfers_out + w.cash_out > 0;

/**
 * What the runway can't see, as plain sentences: no spending to go by, the
 * window's months that may be short and its own gaps, another currency,
 * payments to cards Nya doesn't see, money moved out of cash, and the read's
 * own notes (lib/report/runway-read.ts), with the balances typed long ago and
 * what the cards owe.
 */
export function runwayCaveats(
  runway: Pick<RunwayReport, 'currency' | 'has_cash' | 'gaps' | 'notes' | 'stale_balances' | 'owed_on_cards'>,
  projection: Pick<RunwayProjection, 'window' | 'what_if'>,
  f: RunwayFormats
): string[] {
  const money = (n: number) => formatMoney(n, runway.currency);
  const w = projection.window;
  const lines: string[] = [];
  if (runway.has_cash && noSpending(w)) lines.push('There are no transactions in these months to go by, so no runway is given: link the accounts you spend from, or add their transactions.');
  if (w.short.length > 0) {
    const names = joinNames([...new Set(w.short.flatMap((m) => m.institutions))]);
    lines.push(`${joinNames(w.short.map((m) => f.month(m.month)))} may be missing transactions${names ? ` from ${names}` : ''}, so the spending, and the income, may be low.`);
  }
  lines.push(...gapSentences(runway.gaps.find((g) => g.months === w.months)?.gaps ?? [], f.day));
  if (w.left_out_text) lines.push(w.left_out_text);
  for (const c of w.card_payments) {
    lines.push(
      `${c.name}${c.account ? ` from ${c.account}` : ''} looks like a card’s payment, and no card in Nya shows it arriving, so its ${money(c.amount)} over these months counts as spending here: what you charge on that card isn’t in Nya. If the card is in Nya, it is counted twice.`
    );
  }
  if (hasMovedOut(w)) {
    const parts = [
      w.transfers_out > 0 ? `${money(w.transfers_out)} as transfers to accounts outside them (a payment by Zelle or Venmo, a move to an account Nya doesn’t hold)` : null,
      w.cash_out > 0 ? `${money(w.cash_out)} as cash taken out` : null,
    ].filter((p): p is string => p !== null);
    lines.push(
      `Over these months, ${joinNames(parts)} left your checking and savings. ${
        projection.what_if.count_moved_out ? 'This what-if counts it as spending.' : 'It isn’t in the spending: categorize what was spending as such, or count it in the what-if.'
      }`
    );
  }
  lines.push(...runway.notes);
  for (const s of runway.stale_balances) lines.push(`${s.name} at ${s.institution} is a balance you typed, last updated ${f.time(s.updated_at)}.`);
  if (runway.owed_on_cards > 0) lines.push(`Your cards owe ${money(runway.owed_on_cards)}: their charges are in the spending as they are made, but paying them off comes out of this cash, which this doesn’t take off.`);
  return lines;
}

/** The what-if in words, for the page and the printout: a one-off or a move
 *  out is said only where the window has one. */
export function whatIfWords(whatIf: RunwayWhatIf, currency: string | null, day: DayFormat, w?: WindowSpending): string {
  const parts = [`spending over the last ${whatIf.months} full months`];
  if (whatIf.lower_by > 0) parts.push(`spending lower by ${formatMoney(whatIf.lower_by, currency)} a month`);
  if (whatIf.income_until) parts.push(`income stopping after ${day(whatIf.income_until)}`);
  parts.push(whatIf.planned ? 'what you planned in' : 'what you planned left out');
  if (whatIf.leave_out_one_offs && (!w || hasOneOffs(w))) parts.push('one-offs left out');
  if (whatIf.count_moved_out && (!w || hasMovedOut(w))) parts.push('transfers out and cash taken out counted');
  return `Worked out with ${joinNames(parts)}.`;
}
