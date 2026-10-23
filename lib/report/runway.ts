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
// (The read leaves out a health savings account too, and says so.)
//
// WHAT SPENDING IS. The shared rule first (lib/spending.ts countsInTotals,
// through lib/totals.ts summarize): money out that counts in the Activity
// tab's totals, over the last 3, 6 or 12 full calendar months before this one
// (this month is never whole yet). Then what a runway must see that the
// Activity tab rightly doesn't, each named in its inputs:
//   - REFUNDS (money in filed under a spending category) lower the spending,
//     in both lines: they don't stop when pay does. Money in under an income
//     category, under none, or in a detected series of pay is income;
//   - CARD PAYMENTS TO CARDS NYA DOESN'T SEE are spending: a payment from cash
//     with Plaid's card-payment detail that no card in Nya shows arriving
//     (within CARD_PAYMENT_DAYS, at its amount, each receipt one payment's)
//     pays for charges Nya never counted. A payment that lands on a card in
//     Nya stays out: that card's charges are in the spending already
//     (movesOut says when one has landed, its receipt pending or not in yet
//     included);
//   - BILLS LESS OFTEN THAN MONTHLY (every two months, quarterly, twice a
//     year, yearly) are taken out of the average and added on their dates
//     instead, as the forecast adds them: averaged, a yearly bill would weigh
//     nothing in a short window, or four times its weight in a three-month
//     window it fell in.
// The rest of what the Activity tab leaves out stays out: money moved between
// the person's cash accounts, what they excluded, and rows in another
// currency (named). Money that left cash as a transfer to an account outside
// it (rent by Zelle, a move to an account Nya doesn't hold, or to one of the
// person's that isn't cash here, such as a health savings account) and cash
// taken out are neither spending nor nothing: they are added up and named,
// with what may have arrived where Nya can't see, and the what-if can count
// them.
// A day's spending is the window's spending over its days; a month is an
// average month, 365.25 / 12 days. ONE-OFFS are said, never hidden: an
// outflow of at least half the window's average month, at a merchant with
// nothing of a similar size in the window, and not a detected bill (a car
// repair, a laptop), is listed; so is money in of at least half its average
// month from a payer with nothing like it (a bonus, a car sold). They stay in
// unless the person leaves the one-offs out in the what-if.
//
// WHAT THE FORECAST CHANGES. Bills Nya detected that come monthly or more
// often and that the spending counts (rent, utilities, subscriptions) are in
// the average, so they aren't added again. A bill it holds on a cash account
// that the spending rule leaves out is added on its expected dates, as the
// forecast adds it: a loan's payment (a mortgage, a car loan), a transfer to
// every total and yet money that leaves cash each month
// (paymentsOutsideSpending). So are the bills less often than monthly
// (infrequentBills). The person's planned items are added on their days, an
// expense always and income only while income comes, and can be left out in
// the what-if, since one that repeats something already in the spending
// counts twice.
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
// income if it isn't. With no cash to start from, or no spending in the
// window to go by, there is no runway to give, and the line says which.
//
// WHAT-IF (RunwayWhatIf). The window, spending lower by an amount a month
// (never below nothing), the day income stops, planned items in or out,
// one-offs in or out, and money moved out counted or not: worked out from the
// inputs alone. A scenario the person saves keeps these settings and nothing
// else (lib/report/runway-scenarios.ts).

import {
  CARD_PAYMENT,
  CARD_PAYMENT_DAYS,
  detectRecurring,
  dismissedSeries,
  expectedDates,
  seriesGroupOf,
  type Cadence,
  type RecurringRow,
  type RecurringSeries,
} from '../recurring';
import { forecastEvents, minorScale, type CashPosition, type ForecastEvent } from '../forecast';
import { nextPlannedDate, type PlannedCadence, type PlannedItem, type PlannedKind } from '../planned';
import { countsInTotals, inCurrency, isExcluded, isMoneyMovement, isTransfer, totalsCurrency, type Countable, type LeftOut } from '../spending';
import { summarize, tidy, type TotalsRow } from '../totals';
import { legacyKind } from '../categories';
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
/** The cadences less often than monthly: a bill on one is added on its
 *  dates, never averaged (see WHAT SPENDING IS). */
export const INFREQUENT: ReadonlySet<Cadence> = new Set<Cadence>(['bimonthly', 'quarterly', 'semiannual', 'yearly']);
/** Two amounts this close (a share of the larger, or this many units of the
 *  currency) are of a similar size: two outflows at one merchant so close are
 *  neither a one-off, and a row so close to a series' amount is that series'. */
const SIMILAR_SHARE = 0.25;
const SIMILAR_FLOOR = 5;
/** How many days apart the two sides of a move between two of the person's
 *  accounts may post: a week, so an ACH that takes five business days, a
 *  Friday to the next Friday, is still one move. */
export const TRANSFER_DAYS = 7;
/** How many days before the longest window the rows are read from, so a
 *  payment or a move on its first day finds the other side posted before. */
export const MOVE_DAYS = Math.max(TRANSFER_DAYS, CARD_PAYMENT_DAYS);
/** The most points the chart is given. */
const CHART_POINTS = 120;

const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthOf = (i: number) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
const similar = (a: number, b: number) => Math.abs(a - b) <= Math.max(SIMILAR_SHARE * Math.max(a, b), SIMILAR_FLOOR);

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
export type RunwayRow = TotalsRow & RecurringRow & { transaction_id?: string; vendor_key?: string | null };

/** A single large outflow or inflow, listed (see ONE-OFFS). */
export type OneOff = { date: string; name: string; amount: number };

/** Payments from cash to a card Nya doesn't see, by payment and account. */
export type CardPayments = { name: string; account: string; amount: number; count: number };

/** A month of a window that may be short of transactions: a gap of the
 *  report's reaches into it (lib/report/build.ts), with the institutions it
 *  names. */
export type MonthShort = { month: string; institutions: string[] };

/** A window's spending and income (see WHAT SPENDING IS). */
export type WindowSpending = {
  months: RunwayWindow;
  start: string;
  end: string;
  days: number;
  /** The Activity tab's money out and in over the window (summarize). */
  money_out: number;
  money_in: number;
  /** Transactions counted there (a split one is one: lib/spending.ts transactionCounter). */
  transactions: number;
  /** Money in under a spending category: lowers the spending. */
  refunds: number;
  /** Money out in bills less often than monthly, taken out of the average:
   *  they are added on their dates (infrequentBills). */
  infrequent: number;
  /** Payments to cards Nya doesn't see, added to the spending, and what they
   *  add up to. */
  card_payments: CardPayments[];
  card_payments_total: number;
  /** What left cash as transfers to accounts outside it, and as cash taken
   *  out: named, and counted only when the what-if says. Of the transfers,
   *  what arrived on the person's accounts in Nya that aren't cash here (a
   *  health savings account, an investment account), and what Nya can't see
   *  arrive where it may have (a manual account with no transactions, a bank
   *  whose transactions may be missing that month). */
  transfers_out: number;
  transfers_out_own: number;
  transfers_out_unsure: number;
  cash_out: number;
  /** What the runway takes as spending, and as income, over the window:
   *  money_out less refunds and infrequent bills, plus the card payments
   *  (never below nothing); money_in less refunds. */
  spending: number;
  income: number;
  /** The one-offs out among the spending and in among the income, largest
   *  first, and what each list adds up to. */
  one_offs: OneOff[];
  one_offs_total: number;
  one_offs_in: OneOff[];
  one_offs_in_total: number;
  /** Transactions left out for another currency, and as a sentence. */
  left_out: LeftOut;
  left_out_text: string | null;
  /** Its months that may be short, oldest first. */
  short: MonthShort[];
};

/** The merchant or payer a row is from, for telling a one-off: its vendor
 *  key, else its name as written, without case or spacing. */
const merchantOf = (t: RunwayRow) => t.vendor_key || t.name.toLowerCase().replace(/\s+/g, ' ').trim();

/** Whether a row is one of a detected series': posted in its group (kind,
 *  account, merchant and currency), at an amount near the series' now or
 *  before its price changed. */
export function inSeries(t: RecurringRow, s: RecurringSeries): boolean {
  if (seriesGroupOf(t) !== s.group) return false;
  const a = Math.abs(t.amount);
  return similar(a, s.amount) || (s.previousAmount !== undefined && similar(a, s.previousAmount));
}

/** The kind of the category a row is filed under, by the category or its
 *  words; null under no category or the uncategorized one, which may be
 *  anything. */
function filedKind(t: RunwayRow): string | null {
  const words = t.category;
  if (!words || words === 'other') return null;
  return t.category_kind ?? legacyKind(words);
}

/** Money in filed under a spending category (a refund, a return). */
const filedAsSpending = (t: RunwayRow) => filedKind(t) === 'expense';

/** A cash account as the window reads it: its name and institution, as a row
 *  names its account, whether it is typed by hand, and its subtype. */
export type WindowCash = { name: string; institution: string; manual: boolean; subtype?: string | null };

/** The detected series a window reads beside its rows: the bills less often
 *  than monthly it takes out of the average, and every series whose rows are
 *  never a one-off. And the cash the runway counts (CashPosition.included):
 *  only money that leaves it leaves cash; with none given, every checking,
 *  savings or cash account is cash. */
export type WindowSeries = { infrequent?: readonly RecurringSeries[]; series?: readonly RecurringSeries[]; cash?: readonly WindowCash[] };

/** What became of a payment or a move out of cash (see movesOut). */
type MoveFate = 'card' | 'unseen_card' | 'cash' | 'own' | 'unsure' | 'out' | 'atm';

const accountKey = (t: { institution_name: string; account_name?: string | null }) => `${t.institution_name}|${t.account_name ?? ''}`;

/**
 * What became of each payment and move out of cash that the Activity tab
 * leaves out, read over every row (the days around a window too, so each
 * fate is the same in every window):
 *   - a payment with Plaid's card-payment detail lands on a card in Nya
 *     ('card') when its receipt is seen within CARD_PAYMENT_DAYS at its
 *     amount; or, its receipt not seen, when it is in a detected series that
 *     pays a card in Nya (paysCardOf) whose payments have been seen landing
 *     there, or when payments like it (its series group) have been and its
 *     receipt may not be in yet (fewer than CARD_PAYMENT_DAYS before the
 *     newest row read). Else it pays a card Nya doesn't see ('unseen_card');
 *   - any other move lands on a card in Nya ('card'), on another of the
 *     runway's cash accounts ('cash'), or on another account of the person's
 *     in Nya that isn't cash here, such as a health savings account or an
 *     investment account ('own'), within TRANSFER_DAYS at its amount. Else it
 *     may have arrived where Nya can't see ('unsure': its other side may not
 *     be in yet, or there is a cash account typed by hand with no
 *     transactions, never cash on hand, or a cash account at a bank whose
 *     transactions may be missing that month, `short`), or it left ('out');
 *     cash taken out is 'atm'.
 * Each receipt is the other side of one payment or move at most, pending
 * ones too, the nearest in days first; never one filed under a spending or
 * an income category (a refund, pay), which is no move.
 */
function movesOut(
  rows: readonly RunwayRow[],
  currency: string | null,
  cash: readonly WindowCash[] | undefined,
  series: readonly RecurringSeries[],
  short: readonly MonthShort[]
): Map<RunwayRow, MoveFate> {
  const scale = minorScale(currency);
  const units = (n: number) => Math.round(n * scale);
  const keys = cash ? new Set(cash.map((a) => `${a.institution}|${a.name}`)) : null;
  const fromCash = (t: RunwayRow) => (keys ? t.account_type !== 'credit' && keys.has(accountKey(t)) : t.account_type === 'depository');
  const isCardPayment = (t: RunwayRow) => t.subcategory === CARD_PAYMENT;

  const outs: RunwayRow[] = [];
  const receipts: { t: RunwayRow; kind: 'card' | 'cash' | 'own' }[] = [];
  for (const t of rows) {
    if (isExcluded(t) || !inCurrency(t, currency)) continue;
    if (t.amount > 0) {
      if (t.pending || !fromCash(t) || !isTransfer(t) || countsInTotals(t, currency)) continue;
      if (isCardPayment(t) || isMoneyMovement(t)) outs.push(t);
    } else if (t.amount < 0) {
      const kind = filedKind(t);
      if (kind === 'expense' || kind === 'income') continue;
      receipts.push({ t, kind: t.account_type === 'credit' ? 'card' : fromCash(t) ? 'cash' : 'own' });
    }
  }

  const fate = new Map<RunwayRow, MoveFate>();
  for (const t of outs) if (!isCardPayment(t) && t.transaction_code === 'atm') fate.set(t, 'atm');
  // Every possible pairing, nearest in days first; then each payment and
  // each receipt is taken once.
  const byAmount = new Map<number, number[]>();
  receipts.forEach((r, i) => {
    const list = byAmount.get(units(-r.t.amount)) ?? [];
    list.push(i);
    byAmount.set(units(-r.t.amount), list);
  });
  const prefer = { card: 0, cash: 1, own: 2 } as const;
  const pairs: { o: number; r: number; days: number }[] = [];
  outs.forEach((t, o) => {
    if (fate.has(t)) return;
    for (const r of byAmount.get(units(t.amount)) ?? []) {
      const { t: x, kind } = receipts[r];
      if (accountKey(x) === accountKey(t)) continue;
      if (isCardPayment(t) && kind !== 'card') continue;
      const days = Math.abs(daysFrom(t.date, x.date));
      if (days <= (kind === 'card' ? CARD_PAYMENT_DAYS : TRANSFER_DAYS)) pairs.push({ o, r, days });
    }
  });
  const order = (a: RunwayRow, b: RunwayRow) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.transaction_id ?? '').localeCompare(b.transaction_id ?? ''));
  pairs.sort((a, b) => a.days - b.days || prefer[receipts[a.r].kind] - prefer[receipts[b.r].kind] || order(outs[a.o], outs[b.o]) || order(receipts[a.r].t, receipts[b.r].t));
  const taken = new Set<number>();
  for (const p of pairs) {
    const t = outs[p.o];
    if (fate.has(t) || taken.has(p.r)) continue;
    taken.add(p.r);
    fate.set(t, receipts[p.r].kind);
  }

  // A series that pays a card in Nya, its payments seen landing there; and
  // the groups whose payments have landed on one.
  const landed = outs.filter((t) => fate.get(t) === 'card' && isCardPayment(t));
  const landing = series.filter((x) => x.paysCardOf && landed.some((t) => inSeries(t, x)));
  const landedGroups = new Set(landed.map((t) => seriesGroupOf(t)).filter((g) => g !== null));
  const newest = rows.reduce((d, t) => (t.date > d ? t.date : d), '');
  const notInYet = (t: RunwayRow, days: number) => daysFrom(t.date, newest) < days;
  // Where a move may have arrived unseen.
  const blind = (cash ?? []).filter((a) => a.manual && (a.subtype ?? '').toLowerCase() !== 'cash' && !rows.some((t) => accountKey(t) === `${a.institution}|${a.name}`));
  const shortAt = (a: WindowCash, month: string) => short.some((m) => m.month === month && m.institutions.includes(a.institution));
  const mayHaveArrived = (t: RunwayRow) => {
    const months = new Set([t.date.slice(0, 7), addDays(t.date, TRANSFER_DAYS).slice(0, 7)]);
    const own = accountKey(t);
    return (
      notInYet(t, TRANSFER_DAYS) ||
      blind.some((a) => `${a.institution}|${a.name}` !== own) ||
      (cash ?? []).some((a) => `${a.institution}|${a.name}` !== own && [...months].some((m) => shortAt(a, m)))
    );
  };
  for (const t of outs) {
    if (fate.has(t)) continue;
    if (isCardPayment(t)) {
      const group = seriesGroupOf(t);
      const arriving = landing.some((x) => inSeries(t, x)) || (group !== null && landedGroups.has(group) && notInYet(t, CARD_PAYMENT_DAYS));
      fate.set(t, arriving ? 'card' : 'unseen_card');
    } else fate.set(t, mayHaveArrived(t) ? 'unsure' : 'out');
  }
  return fate;
}

/**
 * The spending and income over a window, kept in `currency` (see WHAT
 * SPENDING IS): the Activity tab's totals for the same months (summarize),
 * then what a runway adds and takes away, with its one-offs and its months
 * `short` lists that may be short. `rows` are every row read, the days around
 * the window too: a card's or another cash account's side of a payment may
 * post just after it.
 */
export function windowSpending(
  rows: readonly RunwayRow[],
  span: RunwaySpan,
  currency: string | null,
  short: readonly MonthShort[] = [],
  known: WindowSeries = {}
): WindowSpending {
  const inSpan = (d: string) => d >= span.start && d <= span.end;
  const s = summarize(rows, inSpan, currency);
  const infrequent = known.infrequent ?? [];
  const series = known.series ?? [];
  const pay = series.filter((x) => x.kind === 'income');
  const bills = series.filter((x) => x.kind === 'bill');

  const fates = movesOut(rows, currency, known.cash, series, short);

  let refunds = 0;
  let infrequentOut = 0;
  let transfersOut = 0;
  let transfersOwn = 0;
  let transfersUnsure = 0;
  let cashOut = 0;
  const cards = new Map<string, CardPayments>();
  // Each merchant's counted outflows and each payer's income, by
  // transaction: a split one's parts are one transaction, added up.
  const outs = new Map<string, Map<string, OneOff>>();
  const ins = new Map<string, Map<string, OneOff>>();
  const add = (into: Map<string, Map<string, OneOff>>, t: RunwayRow, amount: number) => {
    const key = merchantOf(t);
    const id = t.split_of ?? t.transaction_id ?? `${t.date}|${t.name}|${t.amount}`;
    const of = into.get(key) ?? new Map<string, OneOff>();
    const cur = of.get(id);
    of.set(id, cur ? { ...cur, amount: cur.amount + amount } : { date: t.date, name: t.name, amount });
    into.set(key, of);
  };

  for (const t of rows) {
    if (!inSpan(t.date)) continue;
    if (countsInTotals(t, currency)) {
      if (t.amount < 0) {
        const isPay = pay.some((p) => inSeries(t, p));
        if (filedAsSpending(t) && !isPay) refunds += -t.amount;
        else if (!isPay) add(ins, t, -t.amount);
      } else if (t.amount > 0) {
        if (infrequent.some((b) => inSeries(t, b))) infrequentOut += t.amount;
        else if (!bills.some((b) => inSeries(t, b))) add(outs, t, t.amount);
      }
      continue;
    }
    // What leaves cash that the Activity tab leaves out (movesOut). A move to
    // a card in Nya, or to another cash account, takes nothing out of what is
    // counted; a loan's payment is a detected bill, or named.
    const f = fates.get(t);
    if (f === 'unseen_card') {
      const key = `${t.name}\n${t.account_name ?? ''}`;
      const c = cards.get(key) ?? { name: t.name, account: t.account_name ?? '', amount: 0, count: 0 };
      c.amount += t.amount;
      c.count++;
      cards.set(key, c);
    } else if (f === 'atm') cashOut += t.amount;
    else if (f === 'out' || f === 'own' || f === 'unsure') {
      transfersOut += t.amount;
      if (f === 'own') transfersOwn += t.amount;
      if (f === 'unsure') transfersUnsure += t.amount;
    }
  }

  const card_payments = [...cards.values()].map((c) => ({ ...c, amount: tidy(c.amount) })).sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
  const cardTotal = card_payments.reduce((n, c) => n + c.amount, 0);
  const spending = Math.max(0, s.money_out - refunds - infrequentOut + cardTotal);
  const income = Math.max(0, s.money_in - refunds);
  const oneOffs = (from: Map<string, Map<string, OneOff>>, total: number) => {
    const floor = (total / span.days) * MONTH_DAYS * ONE_OFF_SHARE;
    const out: OneOff[] = [];
    if (floor <= 0) return out;
    for (const of of from.values()) {
      const all = [...of.values()];
      for (const o of all) {
        if (o.amount < floor || all.some((x) => x !== o && similar(x.amount, o.amount))) continue;
        out.push({ ...o, amount: tidy(o.amount) });
      }
    }
    return out.sort((a, b) => b.amount - a.amount || (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name)));
  };
  const one_offs = oneOffs(outs, spending);
  const one_offs_in = oneOffs(ins, income);
  const inWindow = new Set(span.list);
  return {
    months: span.months,
    start: span.start,
    end: span.end,
    days: span.days,
    money_out: s.money_out,
    money_in: s.money_in,
    transactions: s.counted,
    refunds: tidy(refunds),
    infrequent: tidy(infrequentOut),
    card_payments,
    card_payments_total: tidy(cardTotal),
    transfers_out: tidy(transfersOut),
    transfers_out_own: tidy(transfersOwn),
    transfers_out_unsure: tidy(transfersUnsure),
    cash_out: tidy(cashOut),
    spending: tidy(spending),
    income: tidy(income),
    one_offs,
    one_offs_total: tidy(one_offs.reduce((n, o) => n + o.amount, 0)),
    one_offs_in,
    one_offs_in_total: tidy(one_offs_in.reduce((n, o) => n + o.amount, 0)),
    left_out: s.left_out,
    left_out_text: s.left_out_text,
    short: short.filter((m) => inWindow.has(m.month)).sort((a, b) => (a.month < b.month ? -1 : 1)),
  };
}

/** The latest posted row of each series group, for asking how a total counts
 *  a series' rows. */
function latestByGroup(rows: readonly (RecurringRow & Countable)[]): Map<string, RecurringRow & Countable> {
  const latest = new Map<string, RecurringRow & Countable>();
  for (const t of rows) {
    const group = seriesGroupOf(t);
    if (group === null) continue;
    const cur = latest.get(group);
    if (!cur || t.date > cur.date) latest.set(group, t);
  }
  return latest;
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
  const latest = latestByGroup(rows);
  return series.filter((s) => {
    if (s.kind !== 'bill' || s.accountType !== 'depository' || s.paysCard || s.agreement === 'varies' || dismissed.has(s.id)) return false;
    const t = latest.get(s.group);
    return !!t && isTransfer(t);
  });
}

/**
 * The bills the spending counts that come less often than monthly (INFREQUENT):
 * on a cash account or a card, at an amount the forecast can use, not a
 * card's payment, not dismissed, whose latest row counts in totals. Taken out
 * of the average and added on their dates (see WHAT SPENDING IS).
 */
export function infrequentBills(
  series: readonly RecurringSeries[],
  rows: readonly (RecurringRow & Countable)[],
  dismissed: ReadonlySet<string> = new Set()
): RecurringSeries[] {
  const latest = latestByGroup(rows);
  return series.filter((s) => {
    if (s.kind !== 'bill' || !INFREQUENT.has(s.cadence) || (s.accountType !== 'depository' && s.accountType !== 'credit')) return false;
    if (s.paysCard || s.agreement === 'varies' || dismissed.has(s.id)) return false;
    const t = latest.get(s.group);
    return !!t && !isTransfer(t);
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
  /** Whether the one-offs, out and in, are left out. */
  leave_out_one_offs: boolean;
  /** Whether what left cash as transfers out and cash taken out counts as
   *  spending. */
  count_moved_out: boolean;
};

export const DEFAULT_WHAT_IF: RunwayWhatIf = { months: DEFAULT_WINDOW, lower_by: 0, income_until: null, planned: true, leave_out_one_offs: false, count_moved_out: false };

/** What a projection is worked out from (lib/report/runway-read.ts reads it). */
export type RunwayInputs = {
  today: string;
  currency: string | null;
  /** Where it starts: the cash now, less what is pending (CashPosition.start). */
  start: number;
  /** Whether any cash account is in it: with none, there is nothing to start from. */
  has_cash: boolean;
  /** One for each of RUNWAY_WINDOWS. */
  windows: readonly WindowSpending[];
  /** The payments outside the spending, the bills less often than monthly
   *  and the planned items, on their days from today on, in the runway's
   *  currency: positive is money in. */
  events: readonly ForecastEvent[];
};

/** Income in a line: none, all along, or through a day (one past, too). */
export type LineIncome = { kind: 'none' } | { kind: 'ongoing' } | { kind: 'until'; date: string };

/** How a line ends: it runs out; it lasts past the horizon, lower than it
 *  started ('beyond'); it never goes below zero and is no lower at the
 *  horizon than now ('covered'); or there is no runway to give, for want of
 *  cash to start from ('no_cash') or of spending to go by ('no_spending'). */
export type RunwayOutcome = 'runs_out' | 'beyond' | 'covered' | 'no_cash' | 'no_spending';

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
  outcome: RunwayOutcome;
  /** The lowest balance expected, and the first day it is reached: through
   *  the day it runs out for a line that does, else within the horizon. */
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

/** Whether a window has nothing to go by: no transaction counted, and no
 *  payment to a card Nya doesn't see. */
export const noSpending = (w: Pick<WindowSpending, 'transactions' | 'card_payments'>) => w.transactions === 0 && w.card_payments.length === 0;

/** The runway under a what-if: both lines, day by day, in whole minor units
 *  (see THE ARITHMETIC). */
export function projectRunway(inputs: RunwayInputs, whatIf: RunwayWhatIf): RunwayProjection {
  const scale = minorScale(inputs.currency);
  const units = (n: number) => Math.round(n * scale);
  const w = windowOf(inputs, whatIf.months);
  const out = Math.max(
    0,
    units(w.spending) - (whatIf.leave_out_one_offs ? units(w.one_offs_total) : 0) + (whatIf.count_moved_out ? units(w.transfers_out) + units(w.cash_out) : 0)
  );
  const spendRate = Math.max(0, out / w.days - units(Math.max(0, whatIf.lower_by)) / MONTH_DAYS);
  const incomeRate = Math.max(0, units(w.income) - (whatIf.leave_out_one_offs ? units(w.one_offs_in_total) : 0)) / w.days;
  const start = units(inputs.start);
  const unknown: RunwayOutcome | null = !inputs.has_cash ? 'no_cash' : noSpending(w) ? 'no_spending' : null;

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

  /** A line with income through day `through` (below 0: none; Infinity: all along). */
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
      // The lowest while it lasts, through the day it runs out.
      if (runsOut === null && b < low.units) low = { day: d, units: b };
      if (runsOut === null && b < 0) runsOut = d;
    }
    const counted = unknown === null ? runsOut : null;
    const days = counted === null ? null : Math.max(0, counted - 1);
    const line: RunwayLine = {
      income,
      spending_per_month: tidy((spendRate * MONTH_DAYS) / scale),
      income_per_month: through < 0 ? 0 : tidy((incomeRate * MONTH_DAYS) / scale),
      runs_out: counted === null ? null : addDays(inputs.today, counted),
      days,
      months: days === null ? null : days / MONTH_DAYS,
      outcome: unknown ?? (runsOut !== null ? 'runs_out' : balances[HORIZON_DAYS] < start ? 'beyond' : 'covered'),
      lowest: { date: addDays(inputs.today, low.day), balance: low.units / scale },
    };
    return { line, balances, runsOut: counted };
  };

  const none = run({ kind: 'none' }, -1);
  const until = whatIf.income_until;
  // A day already gone keeps its date on the line: income stopped then.
  const ongoing = until === null ? run({ kind: 'ongoing' }, Infinity) : run({ kind: 'until', date: until }, daysFrom(inputs.today, until));

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

/** A count of months to one decimal, rounded down so the runway never says
 *  more than it worked out: "7.3" for 7.39. A count, never an amount. */
export function monthsText(months: number): string {
  const tenths = Math.floor(months * 10);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** A detected bill the runway adds on its dates (paymentsOutsideSpending,
 *  infrequentBills). */
export type RunwayPayment = { name: string; institution: string; account: string; amount: number; cadence: Cadence; next: string | null };
/** A planned item the runway adds, in its currency, with its next day. */
export type RunwayPlanned = { name: string; kind: PlannedKind; amount: number; cadence: PlannedCadence; next: string };

/** What the runway is worked out from, and what it lists of it. */
export type RunwayBuilt = RunwayInputs & {
  /** The cash it starts from (lib/forecast.ts cashPosition). */
  position: CashPosition;
  /** Loans' payments from cash, outside the spending. */
  outside: RunwayPayment[];
  /** Bills less often than monthly, out of the average. */
  infrequent: RunwayPayment[];
  planned: RunwayPlanned[];
  /** Expected amounts (payments, bills and planned items) left out for their
   *  currency, by currency. */
  events_left_out: LeftOut;
};

/** A detected bill as the runway lists it, with its next expected date. */
const asPayment = (s: RecurringSeries, today: string, until: string): RunwayPayment => ({
  name: s.name,
  institution: s.institution,
  account: s.account,
  amount: tidy(s.amount),
  cadence: s.cadence,
  next: expectedDates(s, today, until).dates[0]?.date ?? null,
});

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
  rows: readonly RunwayRow[];
  history?: readonly RecurringRow[];
  planned: readonly PlannedItem[] | null;
  dismissed: readonly string[] | null;
  short?: readonly MonthShort[];
}): RunwayBuilt {
  const { today, position } = opts;
  const currency = position.currency ?? totalsCurrency(opts.rows);
  const series = detectRecurring([...opts.rows, ...(opts.history ?? [])]);
  const dismissed = new Set(dismissedSeries(series, opts.dismissed ?? []).keys());
  const live = series.filter((s) => !dismissed.has(s.id));
  const outside = paymentsOutsideSpending(series, opts.rows, dismissed);
  const infrequent = infrequentBills(series, opts.rows, dismissed);
  const cash = position.included.map((a) => ({ name: a.name, institution: a.institution, manual: a.manual, subtype: a.subtype ?? null }));
  const windows = RUNWAY_WINDOWS.map((m) => windowSpending(opts.rows, runwayWindow(today, m), currency, opts.short ?? [], { infrequent, series: live, cash }));
  const until = addDays(today, HORIZON_DAYS);
  const planned = opts.planned ?? [];
  const fromForecast = forecastEvents({ series: outside, planned, currency, today, until });
  // The bills less often than monthly, on their dates: on a card too, whose
  // charge leaves cash with the card's payment, as the spending counts it.
  const ownCurrency = (s: RecurringSeries) => inCurrency({ iso_currency_code: s.currency }, currency);
  const billEvents: ForecastEvent[] = infrequent.filter(ownCurrency).flatMap((s) =>
    expectedDates(s, today, until).dates.map((d) => ({
      date: d.date,
      amount: -s.amount,
      name: s.name,
      source: 'bill' as const,
      ref: s.id,
      cadence: s.cadence,
      ...(d.late ? { late: true, due: d.due } : {}),
    }))
  );
  const others = new Map(fromForecast.leftOut.map((l) => [l.currency, l.count] as const));
  for (const s of infrequent) if (!ownCurrency(s)) others.set(s.currency!, (others.get(s.currency!) ?? 0) + 1);
  const listed = (list: RecurringSeries[]) =>
    list
      .filter(ownCurrency)
      .map((s) => asPayment(s, today, until))
      .filter((p) => p.next !== null);
  return {
    today,
    currency,
    start: position.start,
    has_cash: position.included.length > 0,
    windows,
    events: [...fromForecast.events, ...billEvents].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount)),
    position,
    outside: listed(outside),
    infrequent: listed(infrequent),
    planned: planned
      .filter((p) => inCurrency({ iso_currency_code: p.currency }, currency))
      .flatMap((p) => {
        const next = nextPlannedDate(p, today);
        return next !== null && next <= until ? [{ name: p.name, kind: p.kind, amount: p.amount, cadence: p.cadence, next }] : [];
      })
      .sort((a, b) => (a.next < b.next ? -1 : a.next > b.next ? 1 : a.name.localeCompare(b.name))),
    events_left_out: [...others].map(([c, count]) => ({ currency: c, count })).sort((a, b) => b.count - a.count || (a.currency < b.currency ? -1 : 1)),
  };
}
