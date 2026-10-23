// lib/api-reports.ts
//
// The read-only API's runway and year over year: what /api/v1/runway and
// /api/v1/year-over-year answer, and the MCP server's get_runway and
// get_year_over_year. Read by the report page's own reads
// (lib/report/runway-read.ts, lib/report/year-over-year-read.ts), so the API
// and the page agree to the cent and to the day, on UTC days as every answer
// of the API is ("today" is today in UTC), in the API's shape: plain fields,
// what may be missing as sentences in `notes`.
//
// AN ESTIMATE. The runway past the cash now is worked out (lib/report/
// runway.ts), never measured; its what-if arguments change only this answer,
// and nothing is stored, as on the page.
//
// STORED DATA ONLY, as every answer here: Plaid is never called, nothing is
// written. Hidden accounts are left out, their balances and transactions, as
// the reports leave them out (there is no include_hidden).

import type { Ctx } from './containers';
import type { Cadence } from './recurring';
import type { PlannedCadence, PlannedKind } from './planned';
import type { LeftOut } from './spending';
import { tidy } from './totals';
import { formatMoney } from './format';
import { readRunway } from './report/runway-read';
import { readYearOverYear } from './report/year-over-year-read';
import { DEFAULT_WHAT_IF, projectRunway, type OneOff, type MonthShort, type RunwayLine, type RunwayWindow } from './report/runway';
import type { YearOverYear } from './report/year-over-year';
import { gapSentences, scopeLine } from './report/words';

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A day as an answer writes it: as it is. */
const iso = (day: string) => day;

/** One line of the runway, in the API's shape. */
export type ApiRunwayLine = {
  /** 'none', 'ongoing', or 'until' income_until. */
  income: 'none' | 'ongoing' | 'until';
  income_until: string | null;
  spending_per_month: number;
  income_per_month: number;
  runs_out: string | null;
  days: number | null;
  months: number | null;
  outcome: 'runs_out' | 'beyond' | 'covered';
  lowest: { date: string; balance: number };
};

export type ApiRunway = {
  today: string;
  currency: string | null;
  cash: {
    start: number;
    balances: number;
    pending: number;
    pending_count: number;
    accounts: { name: string; institution: string; balance: number; as_of: string | null }[];
    owed_on_cards: number;
  };
  spending: {
    months: RunwayWindow;
    from: string;
    to: string;
    days: number;
    money_out: number;
    money_in: number;
    transactions: number;
    one_offs: OneOff[];
    left_out: LeftOut;
    left_out_text: string | null;
    months_short: MonthShort[];
  };
  what_if: { spending_lower_by: number; income_until: string | null; include_planned: boolean; leave_out_one_offs: boolean };
  payments_outside_spending: { name: string; institution: string; account: string; amount: number; cadence: Cadence; next_date: string | null }[];
  planned: { name: string; kind: PlannedKind; amount: number; cadence: PlannedCadence; next_date: string }[];
  without_income: ApiRunwayLine;
  with_income: ApiRunwayLine;
  notes: string[];
};

const apiLine = (l: RunwayLine): ApiRunwayLine => ({
  income: l.income.kind,
  income_until: l.income.kind === 'until' ? l.income.date : null,
  spending_per_month: l.spending_per_month,
  income_per_month: l.income_per_month,
  runs_out: l.runs_out,
  days: l.days,
  months: l.months === null ? null : Math.round(l.months * 100) / 100,
  outcome: l.outcome,
  lowest: { date: l.lowest.date, balance: tidy(l.lowest.balance) },
});

/** The runway on today's UTC day, under the what-if asked for (none, by default). */
export async function readApiRunway(
  ctx: Ctx,
  opts: { months?: RunwayWindow; lowerBy?: number; incomeUntil?: string | null; planned?: boolean; leaveOutOneOffs?: boolean; now?: number } = {}
): Promise<ApiRunway> {
  const now = opts.now ?? Date.now();
  const today = utcDay(now);
  const r = await readRunway(ctx, { today, timeZone: 'UTC', now });
  const whatIf = {
    ...DEFAULT_WHAT_IF,
    months: opts.months ?? DEFAULT_WHAT_IF.months,
    lower_by: opts.lowerBy ?? 0,
    income_until: opts.incomeUntil ?? null,
    planned: opts.planned ?? true,
    leave_out_one_offs: opts.leaveOutOneOffs ?? false,
  };
  const p = projectRunway(r, whatIf);
  const w = p.window;
  const notes = [
    ...gapSentences(r.gaps, iso),
    ...r.notes,
    ...r.stale_balances.map((s) => `${s.name} at ${s.institution} is a balance you typed, last updated ${s.updated_at.slice(0, 10)}.`),
  ];
  if (r.owed_on_cards > 0)
    notes.push(`Your cards owe ${formatMoney(r.owed_on_cards, r.currency)}: their charges are in the spending as they are made, but paying them off comes out of this cash.`);
  return {
    today,
    currency: r.currency,
    cash: {
      start: tidy(r.start),
      balances: tidy(r.position.balances),
      pending: tidy(r.position.pending.amount),
      pending_count: r.position.pending.count,
      accounts: r.cash_accounts.map((a) => ({ name: a.name, institution: a.institution, balance: a.balance, as_of: a.as_of })),
      owed_on_cards: r.owed_on_cards,
    },
    spending: {
      months: w.months,
      from: w.start,
      to: w.end,
      days: w.days,
      money_out: w.money_out,
      money_in: w.money_in,
      transactions: w.transactions,
      one_offs: w.one_offs,
      left_out: w.left_out,
      left_out_text: w.left_out_text,
      months_short: w.short,
    },
    what_if: { spending_lower_by: whatIf.lower_by, income_until: whatIf.income_until, include_planned: whatIf.planned, leave_out_one_offs: whatIf.leave_out_one_offs },
    payments_outside_spending: r.outside.map((o) => ({ name: o.name, institution: o.institution, account: o.account, amount: o.amount, cadence: o.cadence, next_date: o.next })),
    planned: whatIf.planned ? r.planned.map((x) => ({ name: x.name, kind: x.kind, amount: x.amount, cadence: x.cadence, next_date: x.next })) : [],
    without_income: apiLine(p.without_income),
    with_income: apiLine(p.with_income),
    notes,
  };
}

export type ApiYearOverYear = YearOverYear & { today: string; notes: string[] };

/** Year over year on today's UTC day, in `currency` (else the one most of the
 *  two years' transactions are in). */
export async function readApiYearOverYear(ctx: Ctx, opts: { currency?: string; now?: number } = {}): Promise<ApiYearOverYear> {
  const now = opts.now ?? Date.now();
  const today = utcDay(now);
  const r = await readYearOverYear(ctx, { today, timeZone: 'UTC', currency: opts.currency ?? null, now });
  const { version: _v, time_zone: _tz, generated_at: _at, gaps, data_as_of: _asOf, caveats, ...yoy } = r;
  const scope = scopeLine(caveats.scope);
  const notes = [
    ...gapSentences(gaps, iso),
    ...(yoy.left_out_text.this ? [`This year: ${yoy.left_out_text.this}`] : []),
    ...(yoy.left_out_text.last ? [`Last year: ${yoy.left_out_text.last}`] : []),
    ...(caveats.hidden ? ['Hidden accounts are left out.'] : []),
    ...(caveats.names_unread ? ['Your names for merchants couldn’t be read, so the bank’s are used.'] : []),
    ...caveats.notes,
    ...(scope ? [scope] : []),
  ];
  return { ...yoy, today, notes };
}

