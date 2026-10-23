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
  unrated === home && currency !== home && why !== 'not-fetched' && why !== 'unread';

/** Said when the rates couldn't be read just now (NoRate 'unread'). */
export const UNREAD_RATES = 'the exchange rates couldn’t be read just now; try again in a moment';

/**
 * Why `currency` couldn't be converted into `home`, as the end of a
 * sentence: "there is no rate for BTC", "Nya doesn't have the ECB's rates for
 * those days yet", "nothing can be converted into ARS, as the ECB doesn't
 * publish it" (no colon of its own, as it often follows one). `days`: said
 * of several days (a chart's), or one moment.
 */
export function reasonText(currency: string, why: NoRate | string, unrated: string, home: string, days: 'now' | 'one' | 'many' = 'now'): string {
  if (why === 'not-fetched') return days === 'now' ? 'Nya doesn’t have the ECB’s rates yet' : `Nya doesn’t have the ECB’s rates for ${days === 'one' ? 'that day' : 'those days'} yet`;
  if (why === 'unread') return UNREAD_RATES;
  if (homeUnrated(currency, why, unrated, home)) {
    return why === 'quote' ? `nothing can be converted into ${home}, as your rate for it is in a currency the ECB has no rate for` : `nothing can be converted into ${home}, as the ECB doesn’t publish it`;
  }
  if (why === 'quote') return `your rate for ${unrated} is in a currency the ECB has no rate for`;
  if (why === 'before') return `there is no rate for ${unrated} that far back`;
  return `there is no rate for ${unrated}${days === 'now' ? '' : days === 'one' ? ' on that day' : ' on those days'}`;
}

const list = (parts: readonly string[]) => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/**
 * The fields of the ECB's rates Nya keeps that couldn't be read
 * (lib/fx/ecb-store.ts readEcbFields), in words, or null for none that
 * matters to a conversion: "Some of the ECB's rates Nya keeps couldn't be
 * read (the USD rates of 2025), so those days have no rate until the nightly
 * fetch writes them again." The fetch's own record is no rate, and left out.
 */
export function unusableText(ids: readonly string[]): string | null {
  const parts = ids.flatMap((id) => {
    if (id === 'fetch') return [];
    if (id === 'latest') return ['the newest rates'];
    if (id.startsWith('days:')) return [`the ECB’s calendar of ${id.slice(5)}`];
    const [code, year] = id.split(':');
    return year ? [`the ${code} rates of ${year}`] : [];
  });
  if (parts.length === 0) return null;
  return `Some of the ECB’s rates Nya keeps couldn’t be read (${list(parts)}), so those days have no rate until the nightly fetch writes them again.`;
}
