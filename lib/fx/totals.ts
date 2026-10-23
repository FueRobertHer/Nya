// lib/fx/totals.ts
//
// THE ONE SEAM for totals of flows (step 2 of currency conversion): every
// reader that adds up transactions asks totalsIn for the rows it adds up and
// the currency its totals are in, then counts them by lib/spending.ts's rules
// exactly as before (countsInTotals, leftOutByCurrency, leftOutText). Pure,
// and safe to import from client code.
//
// WITHOUT A HOME CURRENCY nothing changes: the totals' currency is the one
// most of the rows are in (lib/spending.ts totalsCurrency), and what is in
// another is left out and named, never added.
//
// WITH ONE, each row in another currency than the totals' becomes a copy at
// the rate of its own day (lib/fx/rates.ts convert: one rounding, to the
// totals' minor unit), in the totals' currency, saying what it was
// (`converted`). A row with no rate stays as it is, in its own currency, so
// the rules leave it out and name it as they always have, and the notes say
// why. A row that says no currency is in its account's currency where the
// reader knows it, else in the totals'. A split transaction's parts convert
// one by one, and their copies' whole (split_parent.amount) is what they came
// to. Nothing else on a row changes, so transfers, exclusions, splits, groups
// and counts work as before. The copies are for adding up only: every reader
// lists the rows as they are, each in its own currency. Nothing converted is
// ever stored.

import { currencyOf, totalsCurrency, transactionCounter, type Countable } from '../spending';
import { convert, isStale, type FxTable, type NoRate } from './rates';
import { reasonText } from './words';

/** What a row needs to be converted: its currency, how it is counted as a
 *  transaction (a split's parts, a group's members), its day and amount. */
export type Convertible = Pick<Countable, 'iso_currency_code' | 'unofficial_currency_code' | 'split_of' | 'group_members'> & {
  date: string;
  amount: number;
  account_id?: string | null;
};

/** What a converted copy says it was. */
export type WasIn = { amount: number; currency: string };

/** What was converted for a set of totals, for its notes. */
export type Conversion = {
  /** The currency the totals are in. */
  into: string;
  /** Each currency converted, and how many transactions in it. */
  from: { currency: string; count: number }[];
  /** The first and last day of the ECB's rates used, or null with none. */
  days: { first: string; last: string } | null;
  /** The currencies an own rate of the person's priced. */
  own: string[];
  /** Each currency left in its own for having no rate, and why. */
  unrated: { currency: string; why: NoRate; unrated: string }[];
  /** Rows that said no currency, in an account whose currency isn't known:
   *  counted in the totals' currency. */
  assumed: number;
  /** Whether the newest rates are older than they should be. */
  stale: boolean;
};

export type TotalsIn<T> = {
  /** The currency the totals are in. */
  currency: string | null;
  /** The rows as the totals count them (see the header): never listed. */
  rows: T[];
  /** What was converted; null without a home currency. */
  conversion: Conversion | null;
};

export type TotalsInOptions<T> = {
  /** Into what: the home currency (the default); `'most'`, the currency
   *  most of `over` is in (the budgets', which keep the currency they are
   *  typed in), converting the rest into it; or a currency named (the
   *  Plan's, which its typed figures are in). */
  into?: 'home' | 'most' | { currency: string };
  /** The rows the totals' currency is decided over today, when they are not
   *  all of `rows` (a window): without a home currency, and for `'most'`. */
  over?: readonly T[];
  /** A row's account's currency, for a row that says none. */
  accountCurrency?: (t: T) => string | null;
  now?: number;
};

const ONE = (n: number) => Math.round(n * 1e8) / 1e8;

/** The rows as totals in a home currency count them (see the header). */
export function totalsIn<T extends Convertible>(rows: readonly T[], fx: FxTable | null | undefined, opts: TotalsInOptions<T> = {}): TotalsIn<T> {
  const today = totalsCurrency(opts.over ?? rows);
  if (!fx || !fx.home) return { currency: today, rows: [...rows], conversion: null };
  const into = opts.into === 'most' ? today : typeof opts.into === 'object' ? opts.into.currency : fx.home;
  if (into === null) return { currency: null, rows: [...rows], conversion: null };

  const counters = new Map<string, ReturnType<typeof transactionCounter>>();
  const unrated = new Map<string, { currency: string; why: NoRate; unrated: string }>();
  const own = new Set<string>();
  let first: string | null = null;
  let last: string | null = null;
  let assumed = 0;
  const seen = (day: string) => {
    if (first === null || day < first) first = day;
    if (last === null || day > last) last = day;
  };
  // Each split's parts as converted, to give their copies the whole they make.
  const wholes = new Map<string, { sum: number; parts: number; converted: number }>();

  const out = rows.map((t) => {
    const said = currencyOf(t);
    const c = said ?? opts.accountCurrency?.(t) ?? null;
    if (c === null) {
      if (said === null) assumed++;
      return t;
    }
    if (c === into) return said === null ? ({ ...t, iso_currency_code: into } as T) : t;
    const r = convert(fx, t.amount, c, into, t.date);
    if (!r.ok) {
      if (!unrated.has(c)) unrated.set(c, { currency: c, why: r.why, unrated: r.currency });
      // In its own currency, said, so the rules name it.
      return said === null ? ({ ...t, iso_currency_code: c } as T) : t;
    }
    const counter = counters.get(c) ?? transactionCounter();
    counter.add(t);
    counters.set(c, counter);
    for (const side of [r.from, r.to]) {
      if (side.source === 'own') own.add(side === r.from ? c : into);
      else if (side.source === 'ecb') seen(side.day);
    }
    const copy = { ...t, amount: r.amount, iso_currency_code: into, unofficial_currency_code: null, converted: { amount: t.amount, currency: c } satisfies WasIn } as T;
    const of = (t as { split_of?: string }).split_of;
    if (of !== undefined) {
      const w = wholes.get(of) ?? { sum: 0, parts: 0, converted: 0 };
      w.sum = ONE(w.sum + r.amount);
      w.converted++;
      wholes.set(of, w);
    }
    return copy;
  });
  // A whole is the sum of its parts' converted amounts (never converted on
  // its own, which could differ by a cent), where every part converted.
  if (wholes.size > 0) {
    const parts = new Map<string, number>();
    for (const t of rows) {
      const of = (t as { split_of?: string }).split_of;
      if (of !== undefined) parts.set(of, (parts.get(of) ?? 0) + 1);
    }
    for (let i = 0; i < out.length; i++) {
      const t = out[i] as T & { split_of?: string; split_parent?: Record<string, unknown>; converted?: WasIn };
      if (t.split_of === undefined || !t.converted || !t.split_parent) continue;
      const w = wholes.get(t.split_of)!;
      if (w.converted !== parts.get(t.split_of)) continue;
      out[i] = { ...t, split_parent: { ...t.split_parent, amount: w.sum } } as T;
    }
  }
  const from = [...counters].map(([currency, n]) => ({ currency, count: n.n })).sort((a, b) => b.count - a.count || (a.currency < b.currency ? -1 : 1));
  return {
    currency: into,
    rows: out,
    conversion: {
      into,
      from,
      days: first !== null && last !== null ? { first, last } : null,
      own: [...own].sort(),
      unrated: [...unrated.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1)),
      assumed,
      stale: from.length > 0 && isStale(fx, opts.now ?? Date.now()),
    },
  };
}

/** A conversion narrowed to some of its rows (a month of the year
 *  converted): what of them was converted, and why what wasn't has no rate. */
export function conversionIn(rows: readonly Convertible[], c: Conversion | null): Conversion | null {
  if (!c) return null;
  const counters = new Map<string, ReturnType<typeof transactionCounter>>();
  const left = new Set<string>();
  for (const t of rows) {
    const was = (t as { converted?: WasIn }).converted;
    if (was) {
      const counter = counters.get(was.currency) ?? transactionCounter();
      counter.add(t);
      counters.set(was.currency, counter);
    } else {
      const cur = currencyOf(t);
      if (cur !== null && cur !== c.into) left.add(cur);
    }
  }
  const from = [...counters].map(([currency, n]) => ({ currency, count: n.n })).sort((a, b) => b.count - a.count || (a.currency < b.currency ? -1 : 1));
  const own = c.own.filter((o) => counters.has(o) || o === c.into);
  return { ...c, from, own, unrated: c.unrated.filter((u) => left.has(u.currency)), stale: c.stale && from.length > 0 };
}

/** The sum of rows' amounts as the totals add them: a float sum of amounts
 *  each to its minor unit, tidied to 8 places so 0.1 + 0.2 is 0.3. */
export const sumOf = (amounts: Iterable<number>): number => {
  let s = 0;
  for (const a of amounts) s += a;
  return ONE(s);
};

const join = (parts: readonly string[]) => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** What a set of totals converted, in words, or null when nothing was:
 *  "Converted into EUR at each day's ECB rate: 12 transactions in USD and 3
 *  in GBP." Never an amount. */
export function convertedText(c: Conversion | null, opts: { noun?: string; budgets?: boolean } = {}): string | null {
  if (!c || c.from.length === 0) return null;
  const noun = opts.noun ?? 'transaction';
  const parts = c.from.map((f, i) => (i === 0 ? `${f.count} ${noun}${f.count === 1 ? '' : 's'} in ${f.currency}` : `${f.count} in ${f.currency}`));
  const own = c.own.length > 0 ? `, and your own rate for ${join(c.own)}` : '';
  // Budgets keep the currency they are typed in: what is converted is the
  // spending against them.
  const lead = opts.budgets ? `Spending in other currencies counts converted into ${c.into}, the currency your budgets are in,` : `Converted into ${c.into}`;
  return `${lead} at each day’s ECB rate${own}: ${join(parts)}.`;
}

/** A total's sentence of what it left out for its currency (lib/spending.ts
 *  leftOutText) with why each had no rate after it, or as it is without a
 *  conversion: "1 transaction in ARS isn't in these totals, which are in
 *  EUR: there is no rate for ARS on those days." */
export function leftOutWhy(text: string | null, c: Pick<Conversion, 'into' | 'unrated'> | null): string | null {
  if (text === null || !c || c.unrated.length === 0) return text;
  const why = c.unrated.map((u) => reasonText(u.currency, u.why, u.unrated, c.into, 'many')).join('; ');
  return `${text.replace(/\.$/, '')}: ${why}.`;
}
