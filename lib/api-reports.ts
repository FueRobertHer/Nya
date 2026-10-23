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
//
// A HOME CURRENCY. Version 1's fields keep their meaning: one currency, what
// is in another left out and named, never converted. Once the person has
// chosen a home currency, `base_currency` names it and `base` gives the same
// figures as the report page shows them, what is in another currency
// converted: the runway still in its cash accounts' currency (its what-if is
// in it), each transaction at its day's rate and the cash and expected
// amounts at the newest (lib/report/runway.ts); year over year in the home
// currency, each transaction at its day's rate. Null without one.

import type { Ctx } from './containers';
import type { Cadence } from './recurring';
import type { PlannedCadence, PlannedKind } from './planned';
import type { LeftOut } from './spending';
import { tidy } from './totals';
import { readRunway, type RunwayReport } from './report/runway-read';
import { readYearOverYear } from './report/year-over-year-read';
import { apiNoRate, apiOwnRates, flowsConverted, flowsNotes, type ApiFlowsConverted, type ApiNoRate, type ApiOwnRate } from './fx/api-base';
import { forecastConvertedText } from './forecast';
import { readSettingsForDisplay } from './fx/settings';
import {
  DEFAULT_WHAT_IF,
  projectRunway,
  type CardPayments,
  type OneOff,
  type MonthShort,
  type OwnAmount,
  type RunwayLine,
  type RunwayOutcome,
  type RunwayPayment,
  type RunwayProjection,
  type RunwayWhatIf,
  type RunwayWindow,
} from './report/runway';
import { runwayCaveats } from './report/runway-words';
import type { YearOverYear } from './report/year-over-year';
import { gapSentences, scopeLine } from './report/words';

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** A day as an answer writes it: as it is. */
const iso = (day: string) => day;

/** A detected bill added on its dates, in the API's shape. */
type ApiPayment = { name: string; institution: string; account: string; amount: number; cadence: Cadence; next_date: string | null };
const apiPayment = (o: RunwayPayment): ApiPayment => ({ name: o.name, institution: o.institution, account: o.account, amount: o.amount, cadence: o.cadence, next_date: o.next });
/** An amount as it was written, when base converted it; null when it was in
 *  the runway's currency. */
type ApiOwn = { amount: number; currency: string } | null;
const apiOwn = (own: OwnAmount | undefined): ApiOwn => (own ? { amount: tidy(own.amount), currency: own.currency } : null);

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
  outcome: RunwayOutcome;
  lowest: { date: string; balance: number };
};

/** The runway's figures, in its currency (version 1's, or base's). */
type ApiRunwayFigures = {
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
    refunds: number;
    infrequent_bills: number;
    card_payments: CardPayments[];
    card_payments_total: number;
    transfers_out: number;
    transfers_out_own: number;
    transfers_out_unsure: number;
    cash_out: number;
    spending: number;
    income: number;
    one_offs: OneOff[];
    one_offs_in: OneOff[];
    left_out: LeftOut;
    left_out_text: string | null;
    months_short: MonthShort[];
  };
  payments_outside_spending: ApiPayment[];
  bills_less_often_than_monthly: ApiPayment[];
  planned: { name: string; kind: PlannedKind; amount: number; cadence: PlannedCadence; next_date: string }[];
  without_income: ApiRunwayLine;
  with_income: ApiRunwayLine;
};

/** What base converted at the newest rates: the cash accounts and the
 *  expected amounts (payments, bills and planned items) in each currency,
 *  the person's own rates used, and each currency left out with why. */
export type ApiNewestRates = {
  cash_accounts: { currency: string; accounts: number }[];
  expected: { currency: string; amounts: number }[];
  own_rates: ApiOwnRate[];
  left_out: { currency: string; why: ApiNoRate }[];
};

/** The runway with what is in another currency converted (see A HOME
 *  CURRENCY): its figures, each converted amount beside the one it was
 *  written in (`own`), the transactions' conversion (ApiFlowsConverted) and
 *  the newest rates'. */
export type ApiRunwayBase = Omit<ApiRunwayFigures, 'cash' | 'spending' | 'payments_outside_spending' | 'bills_less_often_than_monthly' | 'planned'> & {
  cash: Omit<ApiRunwayFigures['cash'], 'accounts'> & { accounts: (ApiRunwayFigures['cash']['accounts'][number] & { own: { balance: number; currency: string } | null })[] };
  spending: Omit<ApiRunwayFigures['spending'], 'left_out' | 'left_out_text'> & ApiFlowsConverted;
  payments_outside_spending: (ApiPayment & { own: ApiOwn })[];
  bills_less_often_than_monthly: (ApiPayment & { own: ApiOwn })[];
  planned: (ApiRunwayFigures['planned'][number] & { own: ApiOwn })[];
  newest_rates: ApiNewestRates;
};

export type ApiRunway = ApiRunwayFigures & {
  today: string;
  what_if: { spending_lower_by: number; income_until: string | null; include_planned: boolean; leave_out_one_offs: boolean; count_moved_out: boolean };
  notes: string[];
  /** The home currency base is worked out for, or null without one. */
  base_currency: string | null;
  base: ApiRunwayBase | null;
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

/** A runway's figures under a what-if, in the API's shape. */
function runwayFigures(r: RunwayReport, p: RunwayProjection, whatIf: RunwayWhatIf): ApiRunwayFigures {
  const w = p.window;
  return {
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
      refunds: w.refunds,
      infrequent_bills: w.infrequent,
      card_payments: w.card_payments,
      card_payments_total: w.card_payments_total,
      transfers_out: w.transfers_out,
      transfers_out_own: w.transfers_out_own,
      transfers_out_unsure: w.transfers_out_unsure,
      cash_out: w.cash_out,
      spending: w.spending,
      income: w.income,
      one_offs: w.one_offs,
      one_offs_in: w.one_offs_in,
      left_out: w.left_out,
      left_out_text: w.left_out_text,
      months_short: w.short,
    },
    payments_outside_spending: r.outside.map(apiPayment),
    bills_less_often_than_monthly: r.infrequent.map(apiPayment),
    planned: whatIf.planned ? r.planned.map((x) => ({ name: x.name, kind: x.kind, amount: x.amount, cadence: x.cadence, next_date: x.next })) : [],
    without_income: apiLine(p.without_income),
    with_income: apiLine(p.with_income),
  };
}

/** The converted runway as base gives it (see A HOME CURRENCY), with its notes. */
function runwayBase(r: RunwayReport, p: RunwayProjection, whatIf: RunwayWhatIf): { base: ApiRunwayBase; notes: string[] } {
  const c = r.conversion!;
  const f = runwayFigures(r, p, whatIf);
  const w = p.window;
  const { left_out: _l, left_out_text: _t, ...spending } = f.spending;
  const rows = flowsConverted(w.conversion ?? { into: r.currency ?? c.home, from: [], days: null, own: [], unrated: [], stale: false }, { own: c.own_rates }, w.left_out);
  const cash = r.position.conversion;
  const expected = c.expected;
  const ownUsed = new Set([...(cash?.own ?? []), ...(expected?.own ?? [])]);
  const unrated = new Map([...(cash?.unrated ?? []), ...(expected?.unrated ?? [])].map((u) => [u.currency, u] as const));
  const into = r.currency ?? c.home;
  const newest: ApiNewestRates = {
    cash_accounts: (cash?.from ?? []).map((x) => ({ currency: x.currency, accounts: x.count })),
    expected: (expected?.from ?? []).map((x) => ({ currency: x.currency, amounts: x.count })),
    own_rates: apiOwnRates(c.own_rates.filter((o) => ownUsed.has(o.currency))),
    left_out: [...unrated.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1)).map((u) => ({ currency: u.currency, why: apiNoRate(u.currency, u.why, u.unrated, into) })),
  };
  const withOwn = <T extends { own?: OwnAmount }, A>(list: readonly T[], apiOf: (x: T) => A) => list.map((x) => ({ ...apiOf(x), own: apiOwn(x.own) }));
  const base: ApiRunwayBase = {
    ...f,
    cash: {
      ...f.cash,
      accounts: r.cash_accounts.map((a) => ({
        name: a.name,
        institution: a.institution,
        balance: a.converted ?? a.balance,
        as_of: a.as_of,
        own: a.currency && a.converted !== undefined ? { balance: a.balance, currency: a.currency } : null,
      })),
    },
    spending: { ...spending, ...rows },
    payments_outside_spending: withOwn(r.outside, apiPayment),
    bills_less_often_than_monthly: withOwn(r.infrequent, apiPayment),
    planned: whatIf.planned ? r.planned.map((x) => ({ name: x.name, kind: x.kind, amount: x.amount, cadence: x.cadence, next_date: x.next, own: apiOwn(x.own) })) : [],
    newest_rates: newest,
  };
  const said = forecastConvertedText(cash, expected);
  const notes = [...flowsNotes(rows, into), ...(said ? [said.replace(/^Converted into/, 'In base, converted into')] : [])];
  return { base, notes };
}

/** The runway on today's UTC day, under the what-if asked for (none, by default). */
export async function readApiRunway(
  ctx: Ctx,
  opts: { months?: RunwayWindow; lowerBy?: number; incomeUntil?: string | null; planned?: boolean; leaveOutOneOffs?: boolean; countMovedOut?: boolean; now?: number } = {}
): Promise<ApiRunway> {
  const now = opts.now ?? Date.now();
  const today = utcDay(now);
  const r = await readRunway(ctx, { today, timeZone: 'UTC', now, plain: true });
  const whatIf = {
    ...DEFAULT_WHAT_IF,
    months: opts.months ?? DEFAULT_WHAT_IF.months,
    lower_by: opts.lowerBy ?? 0,
    income_until: opts.incomeUntil ?? null,
    planned: opts.planned ?? true,
    leave_out_one_offs: opts.leaveOutOneOffs ?? false,
    count_moved_out: opts.countMovedOut ?? false,
  };
  // Version 1's fields as before a home currency; base converted.
  const v1 = r.plain ?? r;
  const p = projectRunway(v1, whatIf);
  // What the page says first, in the same words, its days as they are.
  const notes = runwayCaveats(v1, p, { day: iso, time: iso, month: iso });
  const converted = r.conversion ? runwayBase(r, projectRunway(r, whatIf), whatIf) : null;
  return {
    today,
    ...runwayFigures(v1, p, whatIf),
    what_if: {
      spending_lower_by: whatIf.lower_by,
      income_until: whatIf.income_until,
      include_planned: whatIf.planned,
      leave_out_one_offs: whatIf.leave_out_one_offs,
      count_moved_out: whatIf.count_moved_out,
    },
    notes: [...notes, ...(converted?.notes ?? [])],
    base_currency: r.conversion?.home ?? null,
    base: converted?.base ?? null,
  };
}

/** Year over year's figures, as version 1 gives them. */
type ApiYoyFigures = Omit<YearOverYear, 'conversion'>;

/** Year over year in the home currency, what is in another converted (see
 *  A HOME CURRENCY), with what was converted (ApiFlowsConverted, over both
 *  years). */
export type ApiYoyBase = Pick<YearOverYear, 'currency' | 'year' | 'month' | 'months' | 'groups' | 'empty'> & ApiFlowsConverted;

export type ApiYearOverYear = ApiYoyFigures & {
  today: string;
  notes: string[];
  /** The home currency base is in, or null without one. */
  base_currency: string | null;
  base: ApiYoyBase | null;
};

/** Year over year on today's UTC day, in `currency` (else the one most of the
 *  two years' transactions are in); base in the home currency. */
export async function readApiYearOverYear(ctx: Ctx, opts: { currency?: string; now?: number } = {}): Promise<ApiYearOverYear> {
  const now = opts.now ?? Date.now();
  const today = utcDay(now);
  const r = await readYearOverYear(ctx, { today, timeZone: 'UTC', currency: opts.currency ?? null, now, plain: true, baseInHome: true });
  const { version: _v, time_zone: _tz, generated_at: _at, gaps, data_as_of: _asOf, caveats, plain, today: _today, ...main } = r;
  // Version 1's fields as before a home currency; base converted.
  const { conversion: _c, ...yoy } = plain ?? main;
  const scope = scopeLine(caveats.scope);
  const c = plain ? main.conversion : null;
  const home = c && main.currency ? main.currency : null;
  // The person's own rates, as /me gives them, for those base used.
  const own = home ? (await readSettingsForDisplay(ctx)).settings.own : [];
  const base: ApiYoyBase | null =
    c && home
      ? {
          currency: home,
          year: main.year,
          month: main.month,
          months: main.months,
          groups: main.groups,
          empty: main.empty,
          ...flowsConverted(c, { own }, [...main.left_out.this, ...main.left_out.last].reduce<LeftOut>((out, l) => {
            const at = out.find((x) => x.currency === l.currency);
            if (at) at.count += l.count;
            else out.push({ ...l });
            return out;
          }, [])),
        }
      : null;
  const notes = [
    ...gapSentences(gaps, iso),
    ...(yoy.left_out_text.this ? [`This year: ${yoy.left_out_text.this}`] : []),
    ...(yoy.left_out_text.last ? [`Last year: ${yoy.left_out_text.last}`] : []),
    ...(caveats.hidden ? ['Hidden accounts are left out.'] : []),
    ...(caveats.names_unread ? ['Your names for merchants couldn’t be read, so the bank’s are used.'] : []),
    ...caveats.notes,
    ...(scope ? [scope] : []),
    ...(base && home ? flowsNotes(base, home) : []),
  ];
  return { ...yoy, today, notes, base_currency: home, base };
}
