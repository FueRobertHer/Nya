// lib/format.ts
//
// Shared money formatting. Amounts carry a currency (Plaid's iso_currency_code,
// its unofficial code for a cryptocurrency, or a manual row's own), so format
// in that currency rather than assuming USD: a EUR or GBP charge should not
// render with a "$". A code Intl doesn't take (Plaid's unofficial codes can be
// longer than three letters) is written after the number, "12.50 DOGE", never
// as dollars. Only with no currency at all does it fall back to a plain "$":
// the common single-currency case, and account-level figures (net worth,
// balances) that don't yet surface a currency code.
//
// HIDING AMOUNTS (components/hide-amounts.ts). A person can hide every amount
// on their screen, to use Nya in public, on a shared screen or in a
// screenshot: each formatter here then writes the amount's figures as MASK,
// keeping its sign and its currency where they would be ("-$•••", "••• €"),
// so the page keeps its shape and nothing of the size. Only the page in the
// browser ever turns it on (the switch in the header, remembered on the
// device). Where there is no browser it can't be turned on at all
// (setAmountsHidden), since there the flag would be the whole server
// process's: the read-only API, the downloads, emails and every route's
// answer always carry the figures. A page that must show them whatever the
// switch says (a report being printed) turns it off meanwhile.

/** What a hidden amount's figures are written as. */
export const MASK = '•••';

let hidden = false;

/** Turns hiding amounts on or off for this page. Only the browser's switch
 *  (components/hide-amounts.ts) calls it, and only a browser's page can turn
 *  it on: on the server it stays off, whatever calls it. */
export function setAmountsHidden(on: boolean): void {
  if (on && typeof window === 'undefined') return;
  hidden = on;
}

/** Whether this page hides amounts now. */
export function amountsHidden(): boolean {
  return hidden;
}

type Sign = 'auto' | 'always' | 'exceptZero';

const signOf = (n: number, sign: Sign) => (n < 0 ? '-' : (n > 0 && sign !== 'auto') || (n === 0 && sign === 'always') ? '+' : '');

// The parts of a formatted number that tell its size, written once as MASK.
const FIGURES: ReadonlySet<string> = new Set(['integer', 'group', 'decimal', 'fraction', 'compact', 'exponentSeparator', 'exponentMinusSign', 'exponentInteger', 'nan', 'infinity', 'unknown']);

/**
 * An amount as it shows while amounts are hidden: the sign and the currency
 * where the formatters below write them, in this locale, and MASK for the
 * figures, the same whatever the size (a compact "K" or "M" says a size too).
 * The sign stays, as the color of money in and out already says it.
 */
export function hiddenMoney(amount: number, currency?: string | null, sign: Sign = 'auto'): string {
  const n = amount === 0 ? 0 : amount; // never "-0"
  if (currency) {
    try {
      let out = '';
      let masked = false;
      for (const p of new Intl.NumberFormat(undefined, { style: 'currency', currency, signDisplay: sign }).formatToParts(n)) {
        if (!FIGURES.has(p.type)) out += p.value;
        else if (!masked) {
          out += MASK;
          masked = true;
        }
      }
      return out;
    } catch {
      return `${signOf(n, sign)}${MASK} ${currency}`;
    }
  }
  return `${signOf(n, sign)}$${MASK}`;
}

/** A figure written some other way than the formatters below (a holding's
 *  quantity, a rule's amount), as MASK while amounts are hidden. */
export function hiddenFigure(text: string): string {
  return hidden ? MASK : text;
}

// An amount in text written elsewhere (an answer from the server): a
// currency's symbol before the figures (with a code's letters, "CA$12.00",
// or an ISO code and a no-break space, "XAU 12.00"), a symbol after them
// ("12,50 €"), or a code after figures with a fraction ("12.50 DOGE", as
// formatMoney writes a code Intl refuses), never after a bare number
// ("12:00 UTC", "2026 IRS"). The figures end on a digit, so a full stop
// after an amount stays.
const AMOUNT_IN_TEXT =
  /[+\-\u2212]?(?:(?:[A-Z]{0,3}\p{Sc}|\b[A-Z]{3}\u00a0)[\s\u00a0\u202f]?\d(?:[\d,.\u00a0\u202f]*\d)?|\d(?:[\d,.\u00a0\u202f]*\d)?[\s\u00a0\u202f]?\p{Sc}|\d(?:[\d,.\u00a0\u202f]*\d)?[.,]\d+[\s\u00a0\u202f]?[A-Z]{3,10}\b)/gu;
const FIGURES_IN_TEXT = /\d(?:[\d,.\u00a0\u202f]*\d)?/u;

/** Text written elsewhere (an error a route answers with, which names a
 *  balance) with each amount in it MASK'd while amounts are hidden, and as
 *  it is otherwise. For text the formatters here didn't write. */
export function hideAmountsIn(text: string): string {
  return hidden ? text.replace(AMOUNT_IN_TEXT, (m) => m.replace(FIGURES_IN_TEXT, MASK)) : text;
}

// Figures as a file writes them: digits with the separators a bank's export
// uses ("1,234.56", "1.234,56", "1'234.56", "1 234,56"), and a date's, so
// "2026-09-01" is one mask, said as one "hidden".
const FIGURES_ANYWHERE = /\d(?:[\d,.'\/\-\u00a0\u202f]*\d)?/gu;

/** Text read from a file (a CSV line's cells), whose amounts carry no
 *  currency to tell them by, with every figure in it MASK'd while amounts
 *  are hidden (a date's too), and as it is otherwise. */
export function hideFiguresIn(text: string): string {
  return hidden ? text.replace(FIGURES_ANYWHERE, MASK) : text;
}

// A hidden amount as the formatters write it: its sign, and its symbol
// before MASK (with a code's letters, "CA$") or an ISO code and a no-break
// space; or MASK with its symbol or code after it ("••• €", "••• DOGE").
// Never a word's letters before it, nor a word after one with a symbol
// before it ("$••• IRA contribution" keeps its IRA).
const HIDDEN_IN_TEXT = /[+\-\u2212]?(?:(?:[A-Z]{0,3}\p{Sc}[\s\u00a0\u202f]?|\b[A-Z]{3}\u00a0)•••|•••(?:[\s\u00a0\u202f]?(?:\p{Sc}|[A-Z]{2,10}\b))?)/gu;

/** Text that may hold hidden amounts, as a screen reader is to say it: each
 *  one as "hidden" ("Groceries hidden of hidden"), never a row of bullets. */
export function spoken(text: string): string {
  return text.includes(MASK) ? text.replace(HIDDEN_IN_TEXT, 'hidden') : text;
}

const plain = (abs: number) =>
  abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** The amount in a code Intl refused, the code after it: "-12.50 DOGE". */
function withCode(amount: number, currency: string, sign: string): string {
  return `${sign}${plain(Math.abs(amount))} ${currency}`;
}

export function formatMoney(amount: number, currency?: string | null): string {
  return hidden ? hiddenMoney(amount, currency) : fullMoney(amount, currency);
}

/** formatMoney's figures, whatever the switch says: only for what is
 *  measured here, never drawn (amountSamples). */
function fullMoney(amount: number, currency?: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
      }).format(amount);
    } catch {
      return withCode(amount, currency, amount < 0 ? '-' : '');
    }
  }
  return (amount < 0 ? '-$' : '$') + plain(Math.abs(amount));
}

/** With its sign shown: "+$12.00", "-¥3,200". `always` signs zero too
 *  ("+$0.00"); otherwise zero has none. */
export function signedMoney(amount: number, currency: string | null, opts: { always?: boolean } = {}): string {
  const n = amount === 0 ? 0 : amount; // never "-0"
  if (hidden) return hiddenMoney(n, currency, opts.always ? 'always' : 'exceptZero');
  const sign = n > 0 || (n === 0 && opts.always) ? '+' : n < 0 ? '-' : '';
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        signDisplay: opts.always ? 'always' : 'exceptZero',
      }).format(n);
    } catch {
      return withCode(n, currency, sign);
    }
  }
  return `${sign}$${plain(Math.abs(n))}`;
}

// Compact form for dense labels (chart axes): $1.2K, €3.4M.
export function compactMoney(amount: number, currency?: string | null): string {
  return hidden ? hiddenMoney(amount, currency) : fullCompact(amount, currency);
}

/** compactMoney's figures, whatever the switch says: only for what is
 *  measured here, never drawn (amountSamples). */
function fullCompact(amount: number, currency?: string | null): string {
  if (currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(amount);
    } catch {
      // A code Intl refuses: the compact number, the code after it.
      const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(amount));
      return `${amount < 0 ? '-' : ''}${compact} ${currency}`;
    }
  }
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${Math.round(abs)}`;
}

/**
 * An exchange rate as a person reads it: "1 USD = 0.86573 EUR", to five
 * significant figures, for showing only (lib/fx/rates.ts converts with the
 * exact rate, never this). A rate is not an amount of the person's money (the
 * ECB's are public, and a rate of their own is a price), so it shows while
 * amounts are hidden: it is not one of the hide-amounts scan's formatters
 * (test/amount-sources.ts FORMATTERS), and test/hide-amounts.test.tsx holds
 * it to that.
 */
export function formatRate(rate: number, from: string, to: string): string {
  return `1 ${from} = ${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 5 }).format(rate)} ${to}`;
}

/**
 * Amounts as wide as the widest each short form writes in `currency` in this
 * locale (formatMoney's under ten, compactMoney's at each size), with 8s for
 * figures: nobody's amount, the same whatever the switch says. For a layout
 * that must not move with an amount's size, nor with whether amounts are
 * hidden (a chart's labels, cut to fit beside the room their amounts take,
 * would otherwise say how long a hidden figure is). Measured, never drawn.
 */
export function amountSamples(currency?: string | null): string[] {
  return [fullMoney(8.88, currency), ...[888, 888_888, 888_888_888, 888_888_888_888].map((n) => fullCompact(n, currency))];
}

// The most common currency across a set of amounts, used to label summed
// figures (totals, budgets) with a single symbol. Null when nothing carries a
// currency. A total adds up only the amounts in this one and says what it
// left out (lib/spending.ts); only net worth converts, once the person has
// chosen a home currency (lib/fx/net-worth.ts), and every other caller over
// balances is listed in test/currency-callers.test.ts with its reason.
export function dominantCurrency(
  items: { iso_currency_code: string | null }[]
): string | null {
  const counts: Record<string, number> = {};
  for (const it of items) {
    const c = it.iso_currency_code;
    if (c) counts[c] = (counts[c] ?? 0) + 1;
  }
  let best: string | null = null;
  for (const [c, n] of Object.entries(counts)) {
    if (best === null || n > counts[best]) best = c;
  }
  return best;
}

/**
 * A number that is nobody's amount, grouped as the locale groups it
 * ("1,470"): a count of things, or a bound the app sets on what a field
 * takes. The same whatever the switch says. The scan of the source
 * (test/amount-sources.ts) takes a number written by toLocaleString, with
 * nothing beside it to say what it is, for an amount written past the
 * formatters, so one that is none is written through this instead.
 */
export function plainNumber(n: number): string {
  return n.toLocaleString();
}

/**
 * An amount as a form's field holds it to be edited: its figures alone, to
 * `places` decimals ("1234.50"), with no symbol or grouping. Written whatever
 * the switch says, as the person's own figure in their own field, which the
 * CSS hook covers with one mask while amounts are hidden (app/globals.css,
 * "Hide amounts"). Never for text drawn on a page, where it would show: the
 * scan of the source reports any that is.
 */
export function fieldAmount(amount: number, places = 2): string {
  return amount.toFixed(places);
}

/**
 * An empty amount field's example: zero, to the currency's own `places`
 * ("0.00", "0" for yen, "0.000" for dinars). No figure of anyone's, the same
 * whatever the switch says, so it is written as text, never as an amount nor
 * as a field's figures (test/amount-sources.ts), as a placeholder may be.
 */
export function zeroExample(places: number): string {
  return places > 0 ? `0.${'0'.repeat(places)}` : '0';
}
