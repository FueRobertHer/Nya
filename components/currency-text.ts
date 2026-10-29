// components/currency-text.ts
//
// What the page says of figures converted into the person's home currency
// (lib/fx/): the hero's note (each currency's part and what it came to, the
// rates' day, what was left out and why, rates older than they should be),
// the chart's (the days it couldn't convert), the change's share from
// exchange rates, and an institution's converted total. Every amount is
// written by lib/format.ts as it is drawn, so hiding amounts covers it; a
// rate (formatRate) stays, as it is no amount of the person's.
//
// SAID AS IT IS: a converted figure says it is converted, into what, at whose
// rates and from what day; a currency with no rate is left out and named,
// with why, never guessed (docs/architecture.md, "Exchange rates").

import { formatDay, formatMoney, formatRate, onDay } from '@/lib/format';
import type { BalancePart, BalancesIn, HistoryGaps } from '@/lib/fx/net-worth';
import type { NoRate, OwnRate } from '@/lib/fx/rates';
import { homeUnrated, reasonText } from '@/lib/fx/words';

/** A day as the notes write it, mid sentence: "today", "Sep 14", "Sep 14,
 *  2025" in this locale (lib/format.ts formatDay). */
export function rateDay(iso: string): string {
  return formatDay(iso, { sentence: true });
}

/** Why a currency has no rate of its own, in words (lib/fx/words.ts). */
export function noRateText(currency: string, why: NoRate | string): string {
  return reasonText(currency, why, currency, '', 'now');
}

/** A line of a note, and the currency a rate of the person's own would mend
 *  it for, if one would. */
export type NoteLine = { text: string; rateFor: string | null };

const accounts = (n: number) => (n === 1 ? '1 account' : `${n} accounts`);

/** An amount with its currency's code before it ("USD $1,000.00"), so a "$"
 *  is never read as another dollar, unless the amount already says it
 *  ("BTC 0.50"). */
export function codedMoney(amount: number, currency: string): string {
  const text = formatMoney(amount, currency);
  return text.includes(currency) ? text : `${currency} ${text}`;
}

/** One currency's part, as the note lists it: "USD $1,000.00 is €865.73
 *  (1 USD = 0.86573 EUR)", or "at your rate" for the person's own, through
 *  the ECB's rate for its quote when that is neither the euro nor the home
 *  currency. */
export function partText(p: BalancePart, home: string, own: readonly OwnRate[]): string {
  const rate = p.rate ? ` (${formatRate(p.rate.value, p.currency, home)})` : '';
  let whose = '';
  if (p.rate?.source === 'own') {
    const mine = own.find((o) => o.currency === p.currency);
    whose = mine && mine.quote !== 'EUR' && mine.quote !== home ? ` at your rate, through the ECB’s ${mine.quote} rate` : ' at your rate';
  }
  return `${codedMoney(p.amount, p.currency)} is ${formatMoney(p.converted ?? 0, home)}${whose}${rate}`;
}

/** The converted parts, as one sentence's list: "USD $1,000.00 is €865.73
 *  (…); GBP £500.00 is €584.12 (…)". Empty when nothing was converted (all
 *  in the home currency). */
export function convertedText(b: Pick<BalancesIn, 'currency' | 'parts'>, own: readonly OwnRate[]): string {
  return b.parts
    .filter((p) => p.currency !== b.currency && p.converted !== null)
    .map((p) => partText(p, b.currency, own))
    .join('; ');
}

/**
 * What was left out of a total, one sentence a currency: "1 account in BTC
 * isn't in this total: there is no rate for BTC." When it is the home
 * currency that has no rate (the ECB doesn't publish it, and the person set
 * none for it), one sentence naming it, as a rate for any other currency
 * would change nothing: "Nothing can be converted into ARS yet: the ECB
 * doesn't publish ARS, so 2 accounts in other currencies aren't in this
 * total" (one: "1 account in another currency isn't"). Each with the
 * currency a rate of the person's own would mend it
 * for, and none when the rates simply haven't been fetched yet.
 */
export function leftOutLines(b: Pick<BalancesIn, 'currency' | 'left_out'>, where = 'this total'): NoteLine[] {
  const home = b.currency;
  const lines: NoteLine[] = [];
  const homeOut = b.left_out.filter((l) => homeUnrated(l.currency, l.why, l.unrated, home));
  if (homeOut.length > 0) {
    const n = homeOut.reduce((s, l) => s + l.accounts, 0);
    const why = homeOut[0].why === 'quote' ? `your rate for ${home} is in a currency the ECB has no rate for` : `the ECB doesn’t publish ${home}`;
    lines.push({ text: `Nothing can be converted into ${home} yet: ${why}, so ${accounts(n)} in ${n === 1 ? 'another currency isn’t' : 'other currencies aren’t'} in ${where}.`, rateFor: home });
  }
  for (const l of b.left_out) {
    if (homeOut.includes(l)) continue;
    lines.push({
      text: `${accounts(l.accounts)} in ${l.currency} ${l.accounts === 1 ? 'isn’t' : 'aren’t'} in ${where}: ${reasonText(l.currency, l.why, l.unrated, home)}.`,
      rateFor: l.why === 'not-fetched' ? null : l.unrated,
    });
  }
  return lines;
}

/** The heading of the hero's note: into what, at whose rates, from when. */
export function convertedHeading(home: string, day: string | null, own: boolean): string {
  const whose = day ? `the ECB’s rates of ${rateDay(day)}` : 'the ECB’s rates';
  return `Converted into ${home} at ${whose}${own ? ', and your own' : ''}`;
}

/** Rates older than they should be (lib/fx/rates.ts isStale). */
export function staleText(day: string | null): string {
  return day
    ? `The newest rates Nya has are from ${rateDay(day)}: it couldn’t fetch newer ones, so converted figures may be out of date.`
    : 'Nya has no exchange rates yet, so nothing in another currency can be converted.';
}

/** Accounts saying no currency, counted in the main one (with a balance
 *  now: these are the hero's). */
export function unknownText(n: number, main: string | null): string {
  return `${accounts(n)} ${n === 1 ? 'says' : 'say'} no currency, so ${n === 1 ? 'it is' : 'they are'} counted in ${main ?? 'the main one'}.`;
}

/**
 * How much of the change came from exchange rates (decision 4): "€310.22 of
 * it from exchange rates" when they moved it the same way, "after €50.00
 * lost to exchange rates" or "after €50.00 gained from exchange rates" when
 * the other way. Empty when they moved it by no more than rounding (null).
 */
export function rateEffectText(change: number, fromRates: number | null, home: string): string {
  if (fromRates === null || fromRates === 0) return '';
  const amount = formatMoney(Math.abs(fromRates), home);
  if (change === 0 || Math.sign(change) === Math.sign(fromRates)) return `${amount} of it from exchange rates`;
  return fromRates < 0 ? `after ${amount} lost to exchange rates` : `after ${amount} gained from exchange rates`;
}

/** What the converted chart couldn't draw or count, for its note. */
export type ChartGaps = HistoryGaps & { unknown_currency: number };

/** The chart's note, a sentence a gap, each with why. */
export function chartGapLines(g: ChartGaps, home: string, main: string | null): string[] {
  const out: string[] = [];
  const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);
  const span = (s: { from: string; to: string }) => (s.from === s.to ? onDay(rateDay(s.from)) : `from ${rateDay(s.from)} to ${rateDay(s.to)}`);
  const many = (n: number) => (n === 1 ? 'one' : 'many');
  if (g.unsplit > 0) out.push(`${days(g.unsplit)} couldn’t be converted: Nya didn’t keep ${g.unsplit === 1 ? 'its balances' : 'their balances'} by account, so ${g.unsplit === 1 ? 'it isn’t' : 'they aren’t'} drawn.`);
  for (const m of g.main_unrated) {
    out.push(`${days(m.days)} ${m.days === 1 ? 'isn’t' : 'aren’t'} drawn, ${span(m)}: ${reasonText(main ?? home, m.why, m.unrated, home, many(m.days))}.`);
  }
  for (const l of g.left_out) {
    out.push(`What is in ${l.currency} isn’t in the chart ${span(l)}: ${reasonText(l.currency, l.why, l.unrated, home, many(l.days))}.`);
  }
  // Counted in the main currency wherever they held a balance: these are
  // every account Nya knows of with no currency recorded, whether or not one
  // held a balance on a day drawn.
  if (g.unknown_currency > 0) {
    out.push(`Nya knows of ${accounts(g.unknown_currency)} with no currency recorded: any balance ${g.unknown_currency === 1 ? 'it' : 'they'} held is counted in ${main ?? 'the main currency'}.`);
  }
  return out;
}

/** An institution's total on the Accounts tab, converted, in words for its
 *  note: into what, and what it left out. */
export function institutionNote(b: Pick<BalancesIn, 'currency' | 'left_out'>): string {
  if (b.left_out.some((l) => homeUnrated(l.currency, l.why, l.unrated, b.currency))) {
    return `Mixed currencies: nothing can be converted into ${b.currency} yet, as the ECB doesn’t publish it.`;
  }
  const out = b.left_out.map((l) => `${l.currency} isn’t in it (${l.why === 'not-fetched' ? 'no rates yet' : 'no rate'})`);
  return `Mixed currencies, converted into ${b.currency} at the ECB’s newest rates${out.length > 0 ? `; ${out.join('; ')}` : ''}.`;
}

/** What correcting a manual account's currency doesn't change, said on its
 *  form and in the choice of a home currency, unless the person also moves
 *  the transactions they typed on it (relabelText). */
export const CORRECTION_KEEPS =
  'The transactions already on it keep the currency they were entered in, so budgets and Activity, which add up one currency, may name them rather than count them.';

/** The offer to move the transactions typed on a manual account with its
 *  currency, on the person's confirmation: `n` is the server's count, every
 *  row the move would take (GET /api/manual-accounts `relabel`). */
export const relabelText = (n: number, to: string) => `Also move the ${n === 1 ? 'transaction' : `${n} transactions`} you entered on it to ${to}`;

/** Said beside the offer, before it is ticked: a move has no undo, and which
 *  rows it moved isn't kept (lib/manual-relabel.ts). */
export const relabelUndoText = (from: string, to: string) =>
  `There is no undo. Changing it back to ${from} later would offer to move every transaction you entered on it in ${to}, not only these.`;

/** The rows typed in `from` that would stay in it, beside the offer (`more`:
 *  beside some that would move). */
export const relabelKeptText = (kept: number, from: string, to: string, more = true) =>
  `${kept === 1 ? '1' : kept}${more ? ' more' : ''} you entered on it ${kept === 1 ? 'stays' : 'stay'} in ${from}: split, in a group, or more precise than ${to} allows.`;

/** What a move did, once saved (the answer's `relabelled`). */
export function relabelledText(r: { moved: number; kept: number }, from: string, to: string): string {
  const moved = r.moved === 0 ? `None of the transactions you entered on it moved to ${to}.` : `${r.moved === 1 ? '1 transaction' : `${r.moved} transactions`} you entered on it moved to ${to}.`;
  const kept = r.kept === 0 ? '' : ` ${r.kept === 1 ? '1 stays' : `${r.kept} stay`} in ${from}: split, in a group, or more precise than ${to} allows.`;
  return moved + kept;
}

/** What moving them does, and what it leaves. */
export const RELABEL_KEEPS = 'Their numbers stay as you typed them: only the currency they are in changes. Transactions imported from a file, split or in a group keep theirs.';
