// lib/report/year-over-year.ts
//
// Year over year: this year so far against the same days of last year, this
// month so far against the same days of the same month last year, each month
// of the year against the same month last year, and money in and money out by
// category group and category, each with the change in amount and percent.
// Pure and client-safe: the server reads the rows (lib/report/
// year-over-year-read.ts), as a report reads them, and the report page draws
// what this gives (components/YearOverYearReport.tsx).
//
// THE APP'S RULES, NONE OF ITS OWN. Every figure is summarize's
// (lib/totals.ts), so the shared spending rule's (lib/spending.ts
// countsInTotals): a month here is the Activity tab's month to the cent, and
// a year's figures are its months added up. Transfers, cash withdrawals and
// loan payments are never money in or out, what the person excluded is left
// out, and one currency is kept for both years, the rows in another named,
// never converted. Categories are the person's own (lib/categories.ts), each
// row filed under the category the Activity tab files it under (filedId, so
// the uncategorized one for a row no category files), named as it is named
// now and grouped as it is grouped now: a category moved to another group
// since last year is compared within the group it is in today.
//
// LIKE WITH LIKE. A year still running is compared with the same days of the
// last: January 1 through today against January 1 through the same day a
// year ago (February 29 is the 28th a year before or after). A month is
// compared with the same month a year ago, whole, but this one, which is
// compared through the same day.
//
// NEVER COMPLETE WITHOUT SAYING SO. Each month of either year that may be
// short of transactions (a gap of the report's own reaches into it,
// lib/report/build.ts) is marked, with the institutions it names, and so is
// a total that adds one up.
//
// PERCENT. The change over last year's figure, to one decimal; none (null)
// when last year's is zero, said as new rather than as an infinite rise.

import { categoryById, filedId, groupOf, indexTaxonomy, isProvisionalId, type CategoryKind, type Taxonomy } from '../categories';
import { countsInTotals, currencyOf, leftOutByCurrency, leftOutText, totalsCurrency, transactionCounter, type LeftOut } from '../spending';
import { categoryOf, summarize, tidy, type TotalsRow } from '../totals';
import { addDays } from './period';

/** A stretch of days, both included. */
export type YoySpan = { start: string; end: string };

/** The same day a year before (February 29 is the 28th). */
export function yearBefore(day: string): string {
  const year = String(Number(day.slice(0, 4)) - 1).padStart(4, '0');
  return day.slice(5) === '02-29' ? `${year}-02-28` : `${year}${day.slice(4)}`;
}

const lastDayOf = (month: string) => {
  const next = addDays(`${month}-01`, 32).slice(0, 7);
  return addDays(`${next}-01`, -1);
};
const minDay = (a: string, b: string) => (a < b ? a : b);

/** The stretches compared on `today` (see LIKE WITH LIKE). */
export function yoySpans(today: string): { year: { this: YoySpan; last: YoySpan }; month: { this: YoySpan; last: YoySpan }; months: { month: string; this: YoySpan; last: YoySpan }[] } {
  const y = today.slice(0, 4);
  const ago = yearBefore(today);
  const months = Array.from({ length: Number(today.slice(5, 7)) }, (_, i) => {
    const m = String(i + 1).padStart(2, '0');
    const now = `${y}-${m}`;
    const before = `${ago.slice(0, 4)}-${m}`;
    return { month: now, this: { start: `${now}-01`, end: minDay(lastDayOf(now), today) }, last: { start: `${before}-01`, end: minDay(lastDayOf(before), ago) } };
  });
  return {
    year: { this: { start: `${y}-01-01`, end: today }, last: { start: `${ago.slice(0, 4)}-01-01`, end: ago } },
    month: { this: months[months.length - 1].this, last: months[months.length - 1].last },
    months,
  };
}

/** A figure this year and last, and the change: in amount, and in percent of
 *  last year's (null when that is zero). */
export type Change = { this: number; last: number; change: number; pct: number | null };

export function change(now: number, before: number): Change {
  return { this: tidy(now), last: tidy(before), change: tidy(now - before), pct: before === 0 ? null : Math.round(((now - before) / Math.abs(before)) * 1000) / 10 };
}

/** What may make a month short (see NEVER COMPLETE). */
export type YoyShort = { uncertain: boolean; institutions: string[] };

/** One stretch's totals, by summarize, and whether any month of it may be short. */
export type YoyPeriod = YoySpan & YoyShort & { money_in: number; money_out: number; net: number; transactions: number };

export type YoyCompare = { this: YoyPeriod; last: YoyPeriod; money_in: Change; money_out: Change; net: Change };

/** A category's or a group's money in and out, both years. Ids are the
 *  person's (null for one the app hasn't stored yet). */
export type YoyCategory = { id: string | null; name: string; money_in: Change; money_out: Change; transactions: { this: number; last: number } };
export type YoyGroup = YoyCategory & { kind: CategoryKind | null; categories: YoyCategory[] };

export type YearOverYear = {
  /** The currency every figure is in, or null when no row says one. */
  currency: string | null;
  /** The currencies either year's transactions are in, most first. */
  currencies: { currency: string; transactions: number }[];
  year: YoyCompare;
  month: YoyCompare & { month: string };
  /** January through this month, each against the same month last year. */
  months: (YoyCompare & { month: string })[];
  /** This year so far against the same days last year, by group (in the
   *  person's order), each with its categories. */
  groups: YoyGroup[];
  /** Left out of each year for another currency. */
  left_out: { this: LeftOut; last: LeftOut };
  left_out_text: { this: string | null; last: string | null };
  /** No transaction counted in either year. */
  empty: boolean;
};

/** The currency both years are kept in: the one asked for, when either year
 *  has a transaction in it, else the one most of their transactions are in. */
export function yoyCurrency(rows: readonly TotalsRow[], today: string, asked: string | null): string | null {
  const { year } = yoySpans(today);
  const within = rows.filter((t) => (t.date >= year.last.start && t.date <= year.last.end) || (t.date >= year.this.start && t.date <= year.this.end));
  if (asked !== null && within.some((t) => currencyOf(t) === asked)) return asked;
  return totalsCurrency(within);
}

const NOT_SHORT: YoyShort = { uncertain: false, institutions: [] };

/**
 * Year over year on `today`, from the Activity tab's rows of both years (as a
 * report counts them: lib/report/build.ts periodRows), the person's
 * categories they were filed by (null: their own words name them, under one
 * group), in `currency`, with the months that may be short (`short`, by
 * YYYY-MM, for either year).
 */
export function buildYearOverYear(opts: {
  rows: readonly TotalsRow[];
  taxonomy: Taxonomy | null;
  currency: string | null;
  today: string;
  short?: ReadonlyMap<string, YoyShort>;
}): YearOverYear {
  const { rows, currency, today } = opts;
  const spans = yoySpans(today);
  const shortOf = (span: YoySpan): YoyShort => {
    const marks: YoyShort[] = [];
    for (let m = span.start.slice(0, 7); m <= span.end.slice(0, 7); m = addDays(`${m}-01`, 32).slice(0, 7)) marks.push(opts.short?.get(m) ?? NOT_SHORT);
    return { uncertain: marks.some((s) => s.uncertain), institutions: [...new Set(marks.flatMap((s) => s.institutions))].sort((a, b) => a.localeCompare(b)) };
  };
  const period = (span: YoySpan): YoyPeriod => {
    const s = summarize(rows, (d) => d >= span.start && d <= span.end, currency);
    return { ...span, ...shortOf(span), money_in: s.money_in, money_out: s.money_out, net: s.net, transactions: s.counted };
  };
  const compare = (pair: { this: YoySpan; last: YoySpan }): YoyCompare => {
    const now = period(pair.this);
    const before = period(pair.last);
    return { this: now, last: before, money_in: change(now.money_in, before.money_in), money_out: change(now.money_out, before.money_out), net: change(now.net, before.net) };
  };

  // By group and category, over the two years so far.
  const ix = opts.taxonomy ? indexTaxonomy(opts.taxonomy) : null;
  // Transactions counted as the totals count them (a split one is one, a
  // group's net as many as it holds: lib/spending.ts transactionCounter).
  type Counter = ReturnType<typeof transactionCounter>;
  type Sums = { in: [number, number]; out: [number, number]; n: [Counter, Counter] };
  const blank = (): Sums => ({ in: [0, 0], out: [0, 0], n: [transactionCounter(), transactionCounter()] });
  const groups = new Map<string, { name: string; kind: CategoryKind | null; order: number; sums: Sums; categories: Map<string, { name: string; sums: Sums }> }>();
  const inYear = (d: string) => (d >= spans.year.this.start && d <= spans.year.this.end ? 0 : d >= spans.year.last.start && d <= spans.year.last.end ? 1 : -1);
  for (const t of rows) {
    const y = inYear(t.date);
    if (y < 0 || t.amount === 0 || !countsInTotals(t, currency)) continue;
    let gid: string, gname: string, kind: CategoryKind | null, order: number, cid: string, cname: string;
    if (ix) {
      const c = categoryById(ix, filedId(ix, t))!;
      const g = groupOf(ix, c);
      [gid, gname, kind, order, cid, cname] = [g.id, g.name, g.kind, g.order, c.id, c.name];
    } else {
      // No categories: each row's words name it, all under one group.
      [gid, gname, kind, order, cid, cname] = ['', 'All categories', null, 0, `words:${categoryOf(t)}`, categoryOf(t)];
    }
    const g = groups.get(gid) ?? { name: gname, kind, order, sums: blank(), categories: new Map() };
    const c = g.categories.get(cid) ?? { name: cname, sums: blank() };
    for (const sums of [g.sums, c.sums]) {
      if (t.amount < 0) sums.in[y] += -t.amount;
      else sums.out[y] += t.amount;
      sums.n[y].add(t);
    }
    g.categories.set(cid, c);
    groups.set(gid, g);
  }
  const shownId = (id: string) => (id === '' || id.startsWith('words:') || isProvisionalId(id) ? null : id);
  const entry = (id: string, name: string, s: Sums): YoyCategory => ({
    id: shownId(id),
    name,
    money_in: change(s.in[0], s.in[1]),
    money_out: change(s.out[0], s.out[1]),
    transactions: { this: s.n[0].n, last: s.n[1].n },
  });
  const size = (s: Sums) => s.out[0] + s.out[1] + s.in[0] + s.in[1];

  const yearSpans = { this: spans.year.this, last: spans.year.last };
  const year = compare(yearSpans);
  const months = spans.months.map((m) => ({ month: m.month, ...compare(m) }));
  const inSpan = (span: YoySpan) => rows.filter((t) => t.date >= span.start && t.date <= span.end);
  const leftThis = leftOutByCurrency(inSpan(yearSpans.this), currency);
  const leftLast = leftOutByCurrency(inSpan(yearSpans.last), currency);
  const counts = new Map<string, number>();
  for (const t of [...inSpan(yearSpans.this), ...inSpan(yearSpans.last)]) {
    const c = currencyOf(t);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return {
    currency,
    currencies: [...counts]
      .map(([c, transactions]) => ({ currency: c, transactions }))
      .sort((a, b) => b.transactions - a.transactions || (a.currency === currency ? -1 : b.currency === currency ? 1 : a.currency < b.currency ? -1 : 1)),
    year,
    month: { month: spans.months[spans.months.length - 1].month, ...compare(spans.month) },
    months,
    groups: [...groups]
      .sort(([, a], [, b]) => a.order - b.order || size(b.sums) - size(a.sums) || a.name.localeCompare(b.name))
      .map(([id, g]) => ({
        ...entry(id, g.name, g.sums),
        kind: g.kind,
        categories: [...g.categories]
          .sort(([, a], [, b]) => size(b.sums) - size(a.sums) || a.name.localeCompare(b.name))
          .map(([cid, c]) => entry(cid, c.name, c.sums)),
      })),
    left_out: { this: leftThis, last: leftLast },
    left_out_text: { this: leftOutText(leftThis, currency), last: leftOutText(leftLast, currency) },
    empty: year.this.transactions + year.last.transactions === 0,
  };
}
