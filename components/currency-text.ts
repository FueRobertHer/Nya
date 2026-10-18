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

import { formatMoney, formatRate } from '@/lib/format';
import type { BalancePart, BalancesIn } from '@/lib/fx/net-worth';
import type { NoRate, OwnRate } from '@/lib/fx/rates';

/** A day as the notes write it: "Sep 14, 2026" in this locale. */
export function rateDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Why a currency has no rate, in words. */
export function noRateText(currency: string, why: NoRate | string): string {
  switch (why) {
    case 'not-fetched':
      return 'Nya doesn’t have the ECB’s rates for those days yet';
    case 'quote':
      return `your rate for ${currency} is in a currency the ECB has no rate for`;
    case 'before':
      return `there is no rate for ${currency} that far back`;
    default:
      return `there is no rate for ${currency}`;
  }
}

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

/** What was left out of a total, one sentence a currency: "1 account in BTC
 *  isn't in this total: there is no rate for BTC." */
export function leftOutLines(b: Pick<BalancesIn, 'left_out'>, where = 'this total'): string[] {
  return b.left_out.map((l) => `${accounts(l.accounts)} in ${l.currency} ${l.accounts === 1 ? 'isn’t' : 'aren’t'} in ${where}: ${noRateText(l.currency, l.why)}.`);
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

/** Accounts saying no currency, counted in the main one. */
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
export type ChartGaps = {
  unsplit: number;
  main_unrated: number;
  left_out: { currency: string; from: string; to: string; days: number }[];
  unknown_currency: number;
};

/** The chart's note, a sentence a gap. */
export function chartGapLines(g: ChartGaps, home: string, main: string | null): string[] {
  const out: string[] = [];
  const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);
  if (g.unsplit > 0) out.push(`${days(g.unsplit)} couldn’t be converted: Nya didn’t keep ${g.unsplit === 1 ? 'its balances' : 'their balances'} by account, so ${g.unsplit === 1 ? 'it isn’t' : 'they aren’t'} drawn.`);
  if (g.main_unrated > 0) out.push(`${days(g.main_unrated)} ${g.main_unrated === 1 ? 'isn’t' : 'aren’t'} drawn: there is no rate into ${home} for ${main ?? 'the main currency'} on ${g.main_unrated === 1 ? 'it' : 'them'}.`);
  for (const l of g.left_out) {
    const span = l.from === l.to ? `on ${rateDay(l.from)}` : `from ${rateDay(l.from)} to ${rateDay(l.to)}`;
    out.push(`What is in ${l.currency} isn’t in the chart ${span}: there is no rate for ${l.currency} on ${l.days === 1 ? 'that day' : 'those days'}.`);
  }
  if (g.unknown_currency > 0) out.push(`${accounts(g.unknown_currency)} Nya knows of ${g.unknown_currency === 1 ? 'has' : 'have'} no currency recorded, so ${g.unknown_currency === 1 ? 'it is' : 'they are'} counted in ${main ?? 'the main currency'} on the days ${g.unknown_currency === 1 ? 'it' : 'they'} held a balance.`);
  return out;
}

/** An institution's total on the Accounts tab, converted, in words for its
 *  note: into what, and what it left out. */
export function institutionNote(b: Pick<BalancesIn, 'currency' | 'left_out'>): string {
  const out = b.left_out.map((l) => `${l.currency} isn’t in it (no rate)`);
  return `Mixed currencies, converted into ${b.currency} at the ECB’s newest rates${out.length > 0 ? `; ${out.join('; ')}` : ''}.`;
}
