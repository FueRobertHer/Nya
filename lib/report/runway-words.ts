// lib/report/runway-words.ts
//
// What the runway says (lib/report/runway.ts), in plain words, once: what it
// can't see and the what-if it was worked out with, for the report page
// (components/RunwayReport.tsx, its days on the reader's calendar, its
// amounts through the switch to hide them, since each is written when the
// page is drawn) and for the read-only API's notes (lib/api-reports.ts, days
// as YYYY-MM-DD). Pure and client-safe.

import { formatMoney } from '../format';
import { tidy } from '../totals';
import { convertedText, leftOutWhy } from '../fx/totals';
import { forecastConvertedText } from '../forecast';
import { joinNames } from '../month-coverage';
import { shownName } from '../merchant-name';
import { noSpending, type RunwayProjection, type RunwayWhatIf, type WindowSpending } from './runway';
import type { RunwayNote, RunwayReport } from './runway-read';
import { gapItems, type DayFormat } from './words';
import type { Gap } from './build';

/** How a calendar day, an instant and a month (YYYY-MM) are written. */
export type RunwayFormats = { day: DayFormat; time: (iso: string) => string; month: (month: string) => string };

/** Whether a window has one-offs to leave out, and money moved out to count. */
export const hasOneOffs = (w: WindowSpending) => w.one_offs.length + w.one_offs_in.length > 0;
export const hasMovedOut = (w: WindowSpending) => w.transfers_out + w.cash_out > 0;

/** One thing the runway can't see: its words, its level and its kind in a
 *  few words (never an amount) for the line that gathers them on the page. */
export type RunwayCaveat = { text: string; level: 'caution'; kind: string };

/** Each kind of gap in a transaction history, in a few words. */
const GAP_KINDS: Record<Gap['kind'], string> = {
  missing: 'transactions not loaded',
  stale: 'a bank not syncing',
  partial: 'an account that stopped appearing',
  importing: 'older transactions still importing',
  begins_late: 'a bank’s history starting later',
  refused: 'accounts Plaid doesn’t cover',
  no_consent: 'transactions not allowed',
  removed: 'a removed connection',
  disconnected: 'a disconnected bank',
  removed_unknown: 'records that couldn’t be read',
  own_categories: 'records that couldn’t be read',
  own_exclusions: 'exclusions that couldn’t be read',
  unreadable: 'records that couldn’t be read',
  assumed_closed: 'an account taken as closed',
  missed: 'an account that was missing',
  untracked: 'an account not followed',
};

type CaveatInput = Pick<RunwayReport, 'currency' | 'has_cash' | 'gaps' | 'notes' | 'stale_balances' | 'owed_on_cards'> & Partial<Pick<RunwayReport, 'shared_bills' | 'note_items'>>;

/**
 * What the runway can't see, as plain sentences: no spending to go by, the
 * window's months that may be short and its own gaps, another currency,
 * payments to cards Nya doesn't see, money moved out of cash, and the read's
 * own notes (lib/report/runway-read.ts), with the balances typed long ago and
 * what the cards owe. The read-only API's notes, word for word.
 */
export function runwayCaveats(runway: CaveatInput, projection: Pick<RunwayProjection, 'window' | 'what_if'>, f: RunwayFormats): string[] {
  return runwayCaveatItems(runway, projection, f).map((c) => c.text);
}

/**
 * The same sentences, in the same order, each with its level and kind, for
 * the page (components/RunwayReport.tsx), which says one in full under the
 * months and gathers two or more on one line that opens to each. Every one
 * is a caution: the page's one amber box said them all at that level, as the
 * cash forecast says its notes on where it starts (design-system.md "Status
 * and honesty", rule 1).
 */
export function runwayCaveatItems(runway: CaveatInput, projection: Pick<RunwayProjection, 'window' | 'what_if'>, f: RunwayFormats): RunwayCaveat[] {
  const money = (n: number) => formatMoney(n, runway.currency);
  const w = projection.window;
  const lines: RunwayCaveat[] = [];
  const add = (kind: string, text: string) => lines.push({ text, level: 'caution', kind });
  if (runway.has_cash && noSpending(w)) add('no spending to go by', 'There are no transactions in these months to go by, so no runway is given: link the accounts you spend from, or add their transactions.');
  if (w.short.length > 0) {
    const names = joinNames([...new Set(w.short.flatMap((m) => m.institutions))]);
    add('months that may be short', `${joinNames(w.short.map((m) => f.month(m.month)))} may be missing transactions${names ? ` from ${names}` : ''}, so the spending, and the income, may be low.`);
  }
  for (const g of gapItems(runway.gaps.find((g) => g.months === w.months)?.gaps ?? [], f.day)) add(GAP_KINDS[g.kind], g.text);
  // With a home currency, why each left out has no rate.
  const left = leftOutWhy(w.left_out_text, w.conversion ?? null);
  if (left) add('another currency left out', left);
  for (const c of w.card_payments) {
    add(
      'a card Nya doesn’t see',
      `${shownName(c)}${c.account ? ` from ${c.account}` : ''} looks like a card’s payment, and no card in Nya shows it arriving, so its ${money(c.amount)} over these months counts as spending here: what you charge on that card isn’t in Nya. If the card is in Nya, it is counted twice.`
    );
  }
  if (hasMovedOut(w)) add('money moved out', movedOutWords(w, money, projection.what_if.count_moved_out));
  // Shared expenses (lib/shared-expenses/rows.ts): a shared bill adds your
  // part on its dates, as the spending counts your part of it.
  const shared = runway.shared_bills ?? 0;
  if (shared > 0) add('shared bills', `${shared === 1 ? '1 bill is' : `${shared} bills are`} shared with others: only your part of ${shared === 1 ? 'it' : 'each'} is added on ${shared === 1 ? 'its' : 'their'} dates, as your spending counts your part.`);
  // The read's own notes, with their kinds when it sent them (a runway read
  // before it did has only the words).
  const notes: readonly RunwayNote[] =
    runway.note_items && runway.note_items.length === runway.notes.length ? runway.note_items : runway.notes.map((text) => ({ text, level: 'caution', kind: 'what Nya can’t see' }));
  for (const n of notes) add(n.kind, n.text);
  for (const s of runway.stale_balances) add('a balance you typed', `${s.name} at ${s.institution} is a balance you typed, last updated ${f.time(s.updated_at)}.`);
  if (runway.owed_on_cards > 0) add('what your cards owe', `Your cards owe ${money(runway.owed_on_cards)}: their charges are in the spending as they are made, but paying them off comes out of this cash, which this doesn’t take off.`);
  return lines;
}

/** What the runway converted into its currency, with a home currency, in
 *  sentences, or null when nothing was: the window's transactions at each
 *  day's rate, and the cash accounts and expected amounts at today's. Never
 *  an amount. */
export function runwayConvertedText(runway: Pick<RunwayReport, 'conversion' | 'position'>, w: Pick<WindowSpending, 'conversion'>): string | null {
  if (!runway.conversion) return null;
  const parts = [convertedText(w.conversion ?? null), forecastConvertedText(runway.position.conversion, runway.conversion.expected)].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** What went out of the cash that isn't in the spending, in words: the
 *  transfers no account in Nya shows arriving, those to the person's own
 *  accounts that aren't cash here, those that may have arrived where Nya
 *  can't see, and the cash taken out. */
export function movedOutWords(w: WindowSpending, money: (n: number) => string, counted: boolean): string {
  const unseen = Math.max(0, tidy(w.transfers_out - w.transfers_out_own - w.transfers_out_unsure));
  const parts = [
    unseen > 0 ? `${money(unseen)} in transfers no account in Nya shows arriving (a payment by Zelle or Venmo, a move to an account Nya doesn’t hold)` : null,
    w.transfers_out_own > 0 ? `${money(w.transfers_out_own)} in transfers to your accounts in Nya that aren’t counted as cash here (a health savings account, an investment account)` : null,
    w.transfers_out_unsure > 0
      ? `${money(w.transfers_out_unsure)} in transfers that may have arrived in your own checking or savings where Nya can’t see them (an account typed by hand with no transactions, a bank whose transactions may be missing, or a transfer whose other side isn’t in yet)`
      : null,
    w.cash_out > 0 ? `${money(w.cash_out)} in cash taken out` : null,
  ].filter((p): p is string => p !== null);
  const list = parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join('; ')}; and ${parts[parts.length - 1]}`;
  return `Over these months, money went out of your checking and savings that isn’t in the spending: ${list}. ${
    counted ? 'This what-if counts all of it as spending.' : 'Categorize what was spending as such, or count it in the what-if.'
  }`;
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
