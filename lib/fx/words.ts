// lib/fx/words.ts
//
// Why an amount couldn't be converted into the home currency, in words, for
// the page's notes (components/currency-text.ts) and the API's
// (lib/fx/api-base.ts) alike: the currency whose rate is missing is named,
// its own or the home currency's (lib/fx/net-worth.ts `unrated`), never one
// that has a rate, and rates Nya simply hasn't fetched yet are said as that,
// never as "no rate". Pure, and safe in the browser.

import type { NoRate } from './rates';

/** Whether the home currency's own rate is what is missing (the ECB doesn't
 *  publish it, and there is no rate of the person's for it), rather than
 *  `currency`'s: then a rate for the home currency is the remedy. */
export const homeUnrated = (currency: string, why: NoRate | string, unrated: string, home: string): boolean =>
  unrated === home && currency !== home && why !== 'not-fetched';

/**
 * Why `currency` couldn't be converted into `home`, as the end of a
 * sentence: "there is no rate for BTC", "Nya doesn't have the ECB's rates for
 * those days yet", "nothing can be converted into ARS: the ECB doesn't
 * publish ARS". `days`: said of several days (a chart's), or one moment.
 */
export function reasonText(currency: string, why: NoRate | string, unrated: string, home: string, days: 'now' | 'one' | 'many' = 'now'): string {
  if (why === 'not-fetched') return days === 'now' ? 'Nya doesn’t have the ECB’s rates yet' : `Nya doesn’t have the ECB’s rates for ${days === 'one' ? 'that day' : 'those days'} yet`;
  if (homeUnrated(currency, why, unrated, home)) {
    return why === 'quote' ? `nothing can be converted into ${home}: your rate for ${home} is in a currency the ECB has no rate for` : `nothing can be converted into ${home}: the ECB doesn’t publish ${home}`;
  }
  if (why === 'quote') return `your rate for ${unrated} is in a currency the ECB has no rate for`;
  if (why === 'before') return `there is no rate for ${unrated} that far back`;
  return `there is no rate for ${unrated}${days === 'now' ? '' : days === 'one' ? ' on that day' : ' on those days'}`;
}
