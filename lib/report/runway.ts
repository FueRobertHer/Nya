// lib/report/runway.ts
//
// The runway: how long the person's cash would last at their recent spending,
// with their income and without it, the day it would run out, and the cash
// balance going forward, built on the forecast (lib/forecast.ts). Pure and
// client-safe: the server reads what it is made of (lib/report/runway-read.ts)
// and the report page works a what-if out from the same inputs, in the
// browser, sending and storing nothing (components/RunwayReport.tsx).
//
// AN ESTIMATE, AND NEVER HISTORY. Nothing here is stored: not as a snapshot,
// not into the history layer (lib/history.ts), not as a cache. Every figure
// past the balance now is an estimate, shown as one beside its inputs and
// what it can't see.
//
// WHAT CASH IS. The forecast's own starting point (cashPosition): checking,
// savings and cash on hand (Plaid's depository accounts, and a manual account
// of that kind), not hidden and not ended, at their newest balance, less the
// charges still pending on them, in one currency, those in another left out
// and named. Never an investment account, the cash inside one included (a
// brokerage's settlement or money market fund, lib/cash.ts): that is money
// waiting to be invested, days from being spent. Never a card or a loan: what
// a card owes is said beside the cash, since paying it off comes out of it.
//
// WHAT SPENDING IS. The shared rule (lib/spending.ts countsInTotals, through
// lib/totals.ts summarize): money out that counts in the Activity tab's
// totals, over the last 3, 6 or 12 full calendar months before this one (this
// month is never whole yet). So money moved between the person's accounts,
// cash taken out, loan and card payments, what they excluded and rows in
// another currency are left out, the last named. A day's spending is the
// window's money out over its days; a month is an average month, 365.25 / 12
// days. Income is the window's money in by the same rule (pay, and a refund
// among it). ONE-OFFS are said, never hidden: an outflow of at least half the
// window's average month at a merchant with nothing of a similar size in the
// window (a car repair, a laptop, a yearly premium in a short window) is
// listed, and stays in the average unless the person leaves it out in the
// what-if.
//
// WHAT THE FORECAST CHANGES. Bills Nya detected that the spending already
// counts (rent, utilities, subscriptions) are in the average, so they aren't
// added again, and their dates don't move the estimate. A bill it holds on a
// cash account that the spending rule leaves out is added on its expected
// dates, as the forecast adds it: a loan's payment (a mortgage, a car loan),
// a transfer to every total and yet money that leaves cash each month
// (paymentsOutsideSpending). A card's payment never is: the card's charges
// are in the spending already. The person's planned items are added on their
// days, an expense always and income only while income comes, and can be
// left out in the what-if, since one that repeats something already in the
// spending counts twice.
//
// THE ARITHMETIC. In whole minor units of the runway's currency, as the
// forecast's. Day 0 is today: the balance now, with what is expected today.
// From tomorrow each day takes one day's spending, adds one day's income
// while it comes, and what is expected that day; through day d the spending
// taken is a day's times d, rounded once, so no rounding builds up. The cash
// runs out on the first day the balance is below zero, and lasts the whole
// days before it; its months are those days over an average month. It looks
// HORIZON_DAYS ahead at most: a balance that hasn't run out by then lasts
// "more than ten years" if it is lower than it started, and is covered by
// income if it isn't.
//
// WHAT-IF (RunwayWhatIf). The window, spending lower by an amount a month
// (never below nothing), the day income stops, planned items in or out, and
// one-offs in or out: worked out from the inputs alone. A scenario the person
// saves keeps these settings and nothing else (lib/report/runway-scenarios.ts).

import { detectRecurring, dismissedSeries, expectedDates, seriesGroupOf, type Cadence, type RecurringRow, type RecurringSeries } from '../recurring';
import { forecastEvents, minorScale, type CashPosition, type ForecastEvent } from '../forecast';
import { nextPlannedDate, type PlannedCadence, type PlannedItem, type PlannedKind } from '../planned';
import { countsInTotals, inCurrency, isTransfer, totalsCurrency, type Countable, type LeftOut } from '../spending';
import { summarize, tidy, type TotalsRow } from '../totals';
import { addDays, daysFrom } from './period';

/** The windows recent spending is read over, in full calendar months. */
export const RUNWAY_WINDOWS = [3, 6, 12] as const;
export type RunwayWindow = (typeof RUNWAY_WINDOWS)[number];
export const DEFAULT_WINDOW: RunwayWindow = 6;
/** An average month, in days. */
export const MONTH_DAYS = 365.25 / 12;
/** How far ahead the runway looks: ten years of days, leap days and all. */
export const HORIZON_DAYS = 3653;
/** A one-off is at least this share of the window's average month. */
export const ONE_OFF_SHARE = 0.5;
/** Two outflows at one merchant this close (a share of the larger, or this
 *  many units of the currency) are of a similar size: neither is a one-off. */
const SIMILAR_SHARE = 0.25;
const SIMILAR_FLOOR = 5;
/** The most points the chart is given. */
const CHART_POINTS = 120;

const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthOf = (i: number) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;

/** A window: its months (YYYY-MM, oldest first), first and last day, and how
 *  many days it has. */
export type RunwaySpan = { months: RunwayWindow; start: string; end: string; days: number; list: string[] };

/** The `months` full calendar months before today's month. */
export function runwayWindow(today: string, months: RunwayWindow): RunwaySpan {
  const now = monthIndex(today.slice(0, 7));
  const list = Array.from({ length: months }, (_, i) => monthOf(now - months + i));
  const start = `${list[0]}-01`;
  const end = addDays(`${today.slice(0, 7)}-01`, -1);
  return { months, start, end, days: daysFrom(start, end) + 1, list };
}

/** What the runway reads of a transaction: the Activity tab's row. */
export type RunwayRow = TotalsRow & { name: string; transaction_id?: string; vendor_key?: string | null };

/** A single large outflow, listed (see ONE-OFFS). */
export type OneOff = { date: string; name: string; amount: number };

/** A month of a window that may be short of transactions: a gap of the
 *  report's reaches into it (lib/report/build.ts), with the institutions it
 *  names. */
export type MonthShort = { month: string; institutions: string[] };

/** A window's spending and income by the shared rule (see WHAT SPENDING IS). */
export type WindowSpending = {
  months: RunwayWindow;
  start: string;
  end: string;
  days: number;
  money_out: number;
  money_in: number;
  /** Transactions counted (a split one is one: lib/spending.ts transactionCounter). */
  transactions: number;
  /** The one-offs among money_out, largest first, and what they add up to. */
  one_offs: OneOff[];
  one_offs_total: number;
  /** Transactions left out for another currency, and as a sentence. */
  left_out: LeftOut;
  left_out_text: string | null;
  /** Its months that may be short, oldest first. */
  short: MonthShort[];
};

/** The merchant a row is from, for telling a one-off: its vendor key, else its
 *  name as written, without case or spacing. */
const merchantOf = (t: RunwayRow) => t.vendor_key || t.name.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The spending and income over a window, kept in `currency`, by the shared
 * rule (summarize, so the Activity tab's totals for the same months), with its
 * one-offs and its months `short` lists that may be short.
 */
export function windowSpending(rows: readonly RunwayRow[], span: RunwaySpan, currency: string | null, short: readonly MonthShort[] = []): WindowSpending {
  const inSpan = (d: string) => d >= span.start && d <= span.end;
  const s = summarize(rows, inSpan, currency);
  // Each merchant's counted outflows, by transaction: a split one's parts
  // are one transaction, added up.
  const byMerchant = new Map<string, Map<string, OneOff>>();
  for (const t of rows) {
    if (!inSpan(t.date) || t.amount <= 0 || !countsInTotals(t, currency)) continue;
    const merchant = merchantOf(t);
    const id = t.split_of ?? t.transaction_id ?? `${t.date}|${t.name}|${t.amount}`;
    const of = byMerchant.get(merchant) ?? new Map<string, OneOff>();
    const cur = of.get(id);
    of.set(id, cur ? { ...cur, amount: cur.amount + t.amount } : { date: t.date, name: t.name, amount: t.amount });
    byMerchant.set(merchant, of);
  }
  const floor = (s.money_out / span.days) * MONTH_DAYS * ONE_OFF_SHARE;
  const similar = (a: number, b: number) => Math.abs(a - b) <= Math.max(SIMILAR_SHARE * Math.max(a, b), SIMILAR_FLOOR);
  const one_offs: OneOff[] = [];
  for (const of of byMerchant.values()) {
    const all = [...of.values()];
    for (const o of all) {
      if (o.amount < floor || floor <= 0) continue;
      if (all.some((x) => x !== o && similar(x.amount, o.amount))) continue;
      one_offs.push({ ...o, amount: tidy(o.amount) });
    }
  }
  one_offs.sort((a, b) => b.amount - a.amount || (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
  const inWindow = new Set(span.list);
  return {
    months: span.months,
    start: span.start,
    end: span.end,
    days: span.days,
    money_out: s.money_out,
    money_in: s.money_in,
    transactions: s.counted,
    one_offs,
    one_offs_total: tidy(one_offs.reduce((n, o) => n + o.amount, 0)),
    left_out: s.left_out,
    left_out_text: s.left_out_text,
    short: short.filter((m) => inWindow.has(m.month)).sort((a, b) => (a.month < b.month ? -1 : 1)),
  };
}

/**
 * The bills detection holds on a cash account that the spending rule leaves
 * out (see WHAT THE FORECAST CHANGES): a bill (never pay) on a depository
 * account, at an amount the forecast can use, not a card's payment, not one
 * the person said isn't recurring (`dismissed`, the ids lib/recurring.ts
 * dismissedSeries gives), whose latest row is a transfer to every total (a
 * loan's payment, lib/spending.ts isTransfer). A loan payment the person
 * filed under a spending category counts in the spending, and isn't one.
 */
export function paymentsOutsideSpending(
  series: readonly RecurringSeries[],
  rows: readonly (RecurringRow & Countable)[],
  dismissed: ReadonlySet<string> = new Set()
): RecurringSeries[] {
  const latest = new Map<string, RecurringRow & Countable>();
  for (const t of rows) {
    const group = seriesGroupOf(t);
    if (group === null) continue;
    const cur = latest.get(group);
    if (!cur || t.date > cur.date) latest.set(group, t);
  }
  return series.filter((s) => {
    if (s.kind !== 'bill' || s.accountType !== 'depository' || s.paysCard || s.agreement === 'varies' || dismissed.has(s.id)) return false;
    const t = latest.get(s.group);
    return !!t && isTransfer(t);
  });
}

/** A what-if (see WHAT-IF): never stored but as a scenario the person saves. */
export type RunwayWhatIf = {
  months: RunwayWindow;
  /** Spending lower by this much a month, in the runway's currency; 0 for none. */
  lower_by: number;
  /** The last day income comes, in the line with income; null while it keeps coming. */
  income_until: string | null;
  /** Whether the planned items are in it. */
  planned: boolean;
  /** Whether the one-offs are left out of the spending. */
  leave_out_one_offs: boolean;
};

export const DEFAULT_WHAT_IF: RunwayWhatIf = { months: DEFAULT_WINDOW, lower_by: 0, income_until: null, planned: true, leave_out_one_offs: false };

/** What a projection is worked out from (lib/report/runway-read.ts reads it). */
export type RunwayInputs = {
  today: string;
  currency: string | null;
  /** Where it starts: the cash now, less what is pending (CashPosition.start). */
  start: number;
  /** One for each of RUNWAY_WINDOWS. */
  windows: readonly WindowSpending[];
  /** The payments outside the spending and the planned items, on their days
   *  from today on, in the runway's currency (lib/forecast.ts forecastEvents):
   *  positive is money in. */
  events: readonly ForecastEvent[];
};

/** Income in a line: none, all along, or through a day. */
export type LineIncome = { kind: 'none' } | { kind: 'ongoing' } | { kind: 'until'; date: string };

/** One line of the runway: the cash with or without income. */
export type RunwayLine = {
  income: LineIncome;
  /** Spending and income in an average month, as this line takes them. */
  spending_per_month: number;
  income_per_month: number;
  /** The first day the balance is expected below zero (today when it is
   *  now), or null when it isn't within HORIZON_DAYS. */
  runs_out: string | null;
  /** The whole days the cash lasts, before runs_out, and as months; null
   *  when it doesn't run out. */
  days: number | null;
  months: number | null;
  /** runs_out; lasts past the horizon, lower than it started ('beyond');
   *  or never below zero and no lower at the horizon than now ('covered'). */
  outcome: 'runs_out' | 'beyond' | 'covered';
  /** The lowest balance within the horizon, and the first day it is reached. */
  lowest: { date: string; balance: number };
};

export type RunwayProjection = {
  what_if: RunwayWhatIf;
  window: WindowSpending;
  without_income: RunwayLine;
  with_income: RunwayLine;
  /** The chart's points, today first: both lines on the same days. */
  chart: { date: string; without: number; with: number }[];
};

/** The window a what-if reads, else the default's, else the first. */
export function windowOf(inputs: Pick<RunwayInputs, 'windows'>, months: RunwayWindow): WindowSpending {
  return inputs.windows.find((w) => w.months === months) ?? inputs.windows.find((w) => w.months === DEFAULT_WINDOW) ?? inputs.windows[0];
}

/** The runway under a what-if: both lines, day by day, in whole minor units
 *  (see THE ARITHMETIC). */
export function projectRunway(inputs: RunwayInputs, whatIf: RunwayWhatIf): RunwayProjection {
  const scale = minorScale(inputs.currency);
  const units = (n: number) => Math.round(n * scale);
  const w = windowOf(inputs, whatIf.months);
  const out = Math.max(0, units(w.money_out) - (whatIf.leave_out_one_offs ? units(w.one_offs_total) : 0));
  const spendRate = Math.max(0, out / w.days - units(Math.max(0, whatIf.lower_by)) / MONTH_DAYS);
  const incomeRate = units(w.money_in) / w.days;
  const start = units(inputs.start);

  // What is expected on each day from today, as day numbers.
  const bills = new Map<number, number>();
  const plannedOut = new Map<number, number>();
  const plannedIn = new Map<number, number>();
  for (const e of inputs.events) {
    const d = daysFrom(inputs.today, e.date);
    if (d < 0 || d > HORIZON_DAYS) continue;
    const into = e.source === 'planned' ? (e.amount > 0 ? plannedIn : plannedOut) : bills;
    if (e.source === 'planned' && !whatIf.planned) continue;
    into.set(d, (into.get(d) ?? 0) + units(e.amount));
  }

  /** A line with income through day `through` (-1: none; Infinity: all along). */
  const run = (income: LineIncome, through: number) => {
    const balances = new Array<number>(HORIZON_DAYS + 1);
    let expected = 0;
    let runsOut: number | null = null;
    let low = { day: 0, units: start };
    for (let d = 0; d <= HORIZON_DAYS; d++) {
      expected += (bills.get(d) ?? 0) + (plannedOut.get(d) ?? 0) + (d <= through ? (plannedIn.get(d) ?? 0) : 0);
      const earning = Math.max(0, Math.min(d, through));
      const b = start - Math.round(spendRate * d) + Math.round(incomeRate * earning) + expected;
      balances[d] = b;
      if (b < low.units) low = { day: d, units: b };
      if (runsOut === null && b < 0) runsOut = d;
    }
    const days = runsOut === null ? null : Math.max(0, runsOut - 1);
    const line: RunwayLine = {
      income,
      spending_per_month: tidy((spendRate * MONTH_DAYS) / scale),
      income_per_month: through < 0 ? 0 : tidy((incomeRate * MONTH_DAYS) / scale),
      runs_out: runsOut === null ? null : addDays(inputs.today, runsOut),
      days,
      months: days === null ? null : days / MONTH_DAYS,
      outcome: runsOut !== null ? 'runs_out' : balances[HORIZON_DAYS] < start ? 'beyond' : 'covered',
      lowest: { date: addDays(inputs.today, low.day), balance: low.units / scale },
    };
    return { line, balances, runsOut };
  };

  const none = run({ kind: 'none' }, -1);
  const until = whatIf.income_until;
  const ongoing =
    until === null
      ? run({ kind: 'ongoing' }, Infinity)
      : until < inputs.today
        ? run({ kind: 'none' }, -1)
        : run({ kind: 'until', date: until }, daysFrom(inputs.today, until));

  // The chart: through a little past the later day either runs out, at least
  // two months, or a year when neither does; at most CHART_POINTS points,
  // each day either runs out among them.
  const ends = [none.runsOut, ongoing.runsOut].filter((d): d is number => d !== null);
  const span = ends.length > 0 ? Math.min(HORIZON_DAYS, Math.max(60, Math.ceil(Math.max(...ends) * 1.2))) : 365;
  const n = Math.min(span, CHART_POINTS);
  const days = new Set<number>();
  for (let k = 0; k <= n; k++) days.add(Math.round((k * span) / n));
  for (const d of ends) if (d <= span) days.add(d);
  const chart = [...days]
    .sort((a, b) => a - b)
    .map((d) => ({ date: addDays(inputs.today, d), without: none.balances[d] / scale, with: ongoing.balances[d] / scale }));

  return { what_if: whatIf, window: w, without_income: none.line, with_income: ongoing.line, chart };
}

/** Months to one decimal, for saying: "7.2". */
export function monthsText(months: number): string {
  return (Math.floor(months * 10) / 10).toFixed(1);
}

/** A payment outside the spending that the runway adds (paymentsOutsideSpending). */
export type RunwayPayment = { name: string; institution: string; account: string; amount: number; cadence: Cadence; next: string | null };
/** A planned item the runway adds, in its currency, with its next day. */
export type RunwayPlanned = { name: string; kind: PlannedKind; amount: number; cadence: PlannedCadence; next: string };

/** What the runway is worked out from, and what it lists of it. */
export type RunwayBuilt = RunwayInputs & {
  /** The cash it starts from (lib/forecast.ts cashPosition). */
  position: CashPosition;
  outside: RunwayPayment[];
  planned: RunwayPlanned[];
  /** Expected amounts (payments and planned items) left out for their
   *  currency, by currency. */
  events_left_out: LeftOut;
};

/**
 * The runway's inputs from what was read: the cash (`position`), the
 * Activity tab's rows from the longest window's first day on, as a report
 * counts them (lib/report/build.ts periodRows), the rows before them that
 * recurring detection needs (`history`), the planned items and the series
 * marked not recurring (null when they couldn't be read: then none are in
 * it), and the months that may be short. In the cash's currency; with no
 * cash naming one, the one most of the rows are in.
 */
export function buildRunwayInputs(opts: {
  today: string;
  position: CashPosition;
  rows: readonly (RunwayRow & RecurringRow)[];
  history?: readonly RecurringRow[];
  planned: readonly PlannedItem[] | null;
  dismissed: readonly string[] | null;
  short?: readonly MonthShort[];
}): RunwayBuilt {
  const { today, position } = opts;
  const currency = position.currency ?? totalsCurrency(opts.rows);
  const windows = RUNWAY_WINDOWS.map((m) => windowSpending(opts.rows, runwayWindow(today, m), currency, opts.short ?? []));
  const series = detectRecurring([...opts.rows, ...(opts.history ?? [])]);
  const dismissed = new Set(dismissedSeries(series, opts.dismissed ?? []).keys());
  const outside = paymentsOutsideSpending(series, opts.rows, dismissed);
  const until = addDays(today, HORIZON_DAYS);
  const planned = opts.planned ?? [];
  const { events, leftOut } = forecastEvents({ series: outside, planned, currency, today, until });
  return {
    today,
    currency,
    start: position.start,
    windows,
    events,
    position,
    outside: outside
      .filter((s) => inCurrency({ iso_currency_code: s.currency }, currency))
      .map((s) => ({ name: s.name, institution: s.institution, account: s.account, amount: tidy(s.amount), cadence: s.cadence, next: expectedDates(s, today, until).dates[0]?.date ?? null }))
      .filter((p) => p.next !== null),
    planned: planned
      .filter((p) => inCurrency({ iso_currency_code: p.currency }, currency))
      .flatMap((p) => {
        const next = nextPlannedDate(p, today);
        return next !== null && next <= until ? [{ name: p.name, kind: p.kind, amount: p.amount, cadence: p.cadence, next }] : [];
      })
      .sort((a, b) => (a.next < b.next ? -1 : a.next > b.next ? 1 : a.name.localeCompare(b.name))),
    events_left_out: leftOut,
  };
}
