// lib/forecast.ts
//
// The cash forecast: today's balance of the person's cash accounts, carried
// forward day by day over the next 30, 60 or 90 days by the bills and income
// detected (lib/recurring.ts) and the items they planned (lib/planned.ts),
// with its lowest point, and a what-if for one purchase. Pure; the browser
// works it out from what it has already loaded (components/ForecastCard.tsx).
//
// AN ESTIMATE, AND NEVER HISTORY. Nothing here is stored or sent anywhere:
// not as a snapshot, not into the history layer (lib/history.ts), not even as
// a cache. It is shown labelled as an estimate, beside what it leaves out.
//
// WHAT IT STARTS FROM. The cash accounts: checking, savings and the like
// (Plaid's depository type, cash on hand among them), not hidden, each at the
// balance the dashboard shows, less the charges still pending on them: a
// bank's current balance leaves those out, but the money is spent. A pending
// deposit isn't added (it isn't money to spend yet, and a paycheck still
// pending stays expected, lib/recurring.ts), and a transfer between two of
// them, pending on both sides, moves nothing. One currency at a time, as
// every total: the one most of them are in, and an account that names none is
// taken to be in it (as lib/spending.ts takes a row). Without a home currency,
// those in another currency are left out and named, and so is an account
// without a balance.
//
// WITH A HOME CURRENCY (lib/fx/), the forecast keeps its currency (the
// warning the person typed is in it, lib/planned.ts thresholdOf) and what is
// in another is converted into it at the newest rates, a day to come having
// no rate of its own: a cash account's balance and what is pending on it, and
// each bill, income or planned item's amount, each rounded once. Each is
// still listed in its own currency (ForecastEvent.own); what has no rate is
// left out and named, with why.
//
// WHAT MOVES IT. Only money that leaves or reaches those accounts: each
// detected bill and income ON A CASH ACCOUNT (rent, a mortgage, a card's
// payment when it repeats at a steady amount, payroll), on the dates its
// schedule names from today, one that is late within its tolerance counting
// today; each planned item on its days; nothing dismissed, nothing in another
// currency (named instead). Never a card's own charges: a subscription billed
// to a card leaves cash only inside the card's payment, so counting both
// would take it out twice. The card's payment counts when detection finds it
// (a steady autopay); one that changes every month isn't in the forecast, and
// the card says so. Not everyday spending either, nor money moved between
// accounts (detection leaves transfers out: between two cash accounts they
// net out, but one to a brokerage would lower the balance). Pay that varies
// too much to forecast, and pay that stopped coming, are named in the notes,
// never dropped unseen.
//
// THE ARITHMETIC. In whole minor units of the forecast's currency (cents,
// yen, fils), so a day's balance is the one before it plus that day's amounts,
// exactly. On a day with money both out and in, the money out is counted
// first: which comes first isn't known, and the dip is the one to plan for.
// The lowest point counts the balance now too: what is expected today may not
// have happened yet.

import { type Cadence, type RecurringSeries, expectedDates, addDays, dayNumber } from './recurring';
import { plannedDates, type PlannedCadence, type PlannedItem } from './planned';
import { inCurrency, isMoneyMovement, leftOutText, type LeftOut } from './spending';
import { dominantCurrency, formatMoney } from './format';
import { minorDigits } from './manual-txn-input';
import { currencyOf } from './spending';
import { convert, type FxTable, type NoRate } from './fx/rates';
import { reasonText } from './fx/words';

/** The ranges a forecast is shown for, in days from today. */
export const FORECAST_RANGES = [30, 60, 90] as const;
export type ForecastRange = (typeof FORECAST_RANGES)[number];

/** What the forecast reads of an account (components/Dashboard.tsx). */
export type ForecastAccount = {
  account_id: string;
  name: string;
  type: string;
  subtype?: string | null;
  balance: number | null;
  currency: string | null;
  hidden?: boolean;
  /** Manual accounts: when the balance was last typed or pushed. */
  updated_at?: string;
  /** Recovered from a past snapshot rather than fetched (lib/last-known.ts). */
  stale?: boolean;
  /** Missing from its bank's answer, held at its last known balance until the
   *  person says whether it closed (lib/lifecycle-questions.ts). */
  held?: { as_of: string | null; too_old?: string };
  /** A card's or loan's payment terms, where Plaid serves them: the calendar
   *  marks the payment due (lib/calendar.ts duePayments), and the forecast
   *  names a card whose payment it doesn't hold (forecastNotes). */
  liability?: {
    minimum_payment: number | null;
    next_due_date: string | null;
    last_statement_balance?: number | null;
    /** The last payment and when the statement was issued: a payment on or
     *  after it is toward that statement (as lib/payoff.ts reads them). */
    last_payment_amount?: number | null;
    last_payment_date?: string | null;
    last_statement_issue_date?: string | null;
  };
};

/** An account an institution's card can't show (lib/last-known.ts). */
export type UnshownAccount = { name: string; type?: string; currency?: string | null };

/** What the forecast reads of an institution (/api/net-worth). */
export type ForecastInstitution = {
  institution_name: string;
  item_id?: string;
  manual?: boolean;
  /** Set on a bank whose accounts a connector the person brought feeds
   *  (SimpleFIN's, lib/connectors/institutions.ts), `manual` too: its
   *  balances are the bank's, not typed, and its `error` says why it is held
   *  in its card's own words. */
  connector?: string;
  error?: string | null;
  needs_reauth?: boolean;
  /** The day its balances are from, when they were recovered. */
  stale_as_of?: string;
  stale_as_of_at?: string;
  /** Accounts it couldn't recover with the rest, and accounts missing from an
   *  otherwise good fetch, by count (lib/networth.ts). */
  stale_missing?: number;
  unconfirmed_missing?: number;
  /** The accounts its card can't show, by name and kind. */
  unshown_accounts?: UnshownAccount[];
  /** Its connection's health (lib/connection-state.ts). */
  health?: { state: string; last_ok_at: string | null };
  accounts: ForecastAccount[];
};

export type CashAccount = {
  account_id: string;
  name: string;
  institution: string;
  balance: number;
  /** Typed by hand: a manual account's, never one a connector feeds. */
  manual: boolean;
  updated_at?: string;
  /** Its own currency, when it is converted into the forecast's (`balance`
   *  is then in it, as the account shows it). */
  currency?: string;
};

/** What a forecast converted into its currency, with a home currency: each
 *  currency and how many accounts or amounts in it, those a rate of the
 *  person's own priced, and each left out for having no rate, with why. */
export type ForecastConversion = {
  into: string;
  from: { currency: string; count: number }[];
  own: string[];
  unrated: { currency: string; why: NoRate; unrated: string }[];
};

/** Converts amounts into `into` at the newest rates on `today` (a day to
 *  come has none of its own), counting what it did for the notes. */
function converter(fx: FxTable | null | undefined, into: string | null, today: string) {
  const from = new Map<string, number>();
  const own = new Set<string>();
  const unrated = new Map<string, ForecastConversion['unrated'][number]>();
  const day = fx?.latest && fx.latest.date > today ? fx.latest.date : today;
  const on = !!fx?.home && into !== null;
  return {
    on,
    /** The amount in `into`, or null with no rate (named). `count`: one more
     *  of it for the notes. */
    to(amount: number, currency: string, count = true): number | null {
      if (!on) return null;
      const r = convert(fx!, amount, currency, into!, day);
      if (!r.ok) {
        if (!unrated.has(currency)) unrated.set(currency, { currency, why: r.why, unrated: r.currency });
        return null;
      }
      if (count) from.set(currency, (from.get(currency) ?? 0) + 1);
      if (r.from.source === 'own') own.add(currency);
      if (r.to.source === 'own') own.add(into!);
      return r.amount;
    },
    done(): ForecastConversion | null {
      if (!on) return null;
      return {
        into: into!,
        from: [...from].map(([currency, count]) => ({ currency, count })).sort((a, b) => b.count - a.count || (a.currency < b.currency ? -1 : 1)),
        own: [...own].sort(),
        unrated: [...unrated.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1)),
      };
    },
  };
}

/** What the forecast reads of a transaction, for the charges still pending
 *  (the Activity tab's Txn). */
export type PendingRow = {
  date: string;
  name: string;
  amount: number;
  pending: boolean;
  account_name: string;
  account_type?: string | null;
  institution_name: string;
  iso_currency_code: string | null;
  unofficial_currency_code?: string | null;
  transaction_code: string | null;
  category: string | null;
};

export type CashPosition = {
  /** The forecast's currency, or null when no account names one. */
  currency: string | null;
  /** The included accounts' balances added up, to the minor unit. */
  balances: number;
  /** The charges still pending on them, taken off where it starts. */
  pending: { amount: number; count: number };
  /** Where it starts: the balances less what is pending. */
  start: number;
  included: CashAccount[];
  /** Cash accounts in another currency, by currency, most first. */
  leftOut: LeftOut;
  /** Cash accounts with no balance to start from. */
  noBalance: { name: string; institution: string }[];
  /** With a home currency: the accounts converted into `currency`, and why
   *  those left out have no rate; null (or absent) without one. */
  conversion?: ForecastConversion | null;
};

/** Minor units in one unit of a currency: 100 for USD, 1 for JPY, 1000 for
 *  KWD (lib/manual-txn-input.ts minorDigits); 100 when none is named. */
export function minorScale(currency: string | null): number {
  return 10 ** minorDigits(currency ?? 'USD');
}

const toMinor = (n: number, scale: number) => Math.round(n * scale);

/** Where a forecast starts: the cash accounts, their currency and balance,
 *  less the charges pending on them (see the header). `fx` and `today`: with
 *  a home currency, what converts an account in another currency, and the
 *  viewer's day. */
export function cashPosition(
  institutions: readonly ForecastInstitution[],
  txns: readonly PendingRow[] = [],
  opts: { fx?: FxTable | null; today?: string } = {}
): CashPosition {
  const cash = institutions.flatMap((i) =>
    i.accounts.filter((a) => a.type === 'depository' && !a.hidden).map((a) => ({ a, institution: i.institution_name, manual: !!i.manual && !i.connector }))
  );
  const currency = dominantCurrency(cash.map(({ a }) => ({ iso_currency_code: a.currency })));
  const scale = minorScale(currency);
  const conv = converter(opts.fx, currency, opts.today ?? new Date().toISOString().slice(0, 10));
  const included: CashAccount[] = [];
  const noBalance: CashPosition['noBalance'] = [];
  const others = new Map<string, number>();
  let balances = 0;
  for (const { a, institution, manual } of cash) {
    const foreign = !!a.currency && !!currency && a.currency !== currency;
    if (foreign && !conv.on) {
      others.set(a.currency!, (others.get(a.currency!) ?? 0) + 1);
      continue;
    }
    if (a.balance === null || !Number.isFinite(a.balance)) {
      noBalance.push({ name: a.name, institution });
      continue;
    }
    const balance = foreign ? conv.to(a.balance, a.currency!) : a.balance;
    if (balance === null) {
      others.set(a.currency!, (others.get(a.currency!) ?? 0) + 1);
      continue;
    }
    balances += toMinor(balance, scale);
    included.push({
      account_id: a.account_id,
      name: a.name,
      institution,
      balance: a.balance,
      manual,
      ...(a.updated_at ? { updated_at: a.updated_at } : {}),
      ...(foreign ? { currency: a.currency! } : {}),
    });
  }
  const leftOut = [...others].map(([c, count]) => ({ currency: c, count })).sort((x, y) => y.count - x.count || (x.currency < y.currency ? -1 : 1));

  // Pending on an included account (a row names its account by name and
  // institution, and its type when known); in another currency, converted as
  // its account is, with a home currency.
  const accounts = new Set(included.map((a) => `${a.institution}|${a.name}`));
  const onCash = txns
    .filter((t) => t.pending && accounts.has(`${t.institution_name}|${t.account_name}`) && (t.account_type === undefined || t.account_type === null || t.account_type === 'depository'))
    .flatMap((t) => {
      if (inCurrency(t, currency)) return [t];
      const c = currencyOf(t);
      const amount = c && conv.on ? conv.to(t.amount, c, false) : null;
      return amount === null ? [] : [{ ...t, amount, iso_currency_code: currency, unofficial_currency_code: null }];
    });
  const deposits = onCash.filter((t) => t.amount < 0 && isMoneyMovement(t));
  const paired = new Set<PendingRow>();
  let pending = 0;
  let count = 0;
  for (const t of onCash) {
    if (t.amount <= 0) continue;
    if (isMoneyMovement(t)) {
      // A transfer to another of these accounts, pending on both sides.
      const other = deposits.find(
        (d) =>
          !paired.has(d) &&
          `${d.institution_name}|${d.account_name}` !== `${t.institution_name}|${t.account_name}` &&
          toMinor(-d.amount, scale) === toMinor(t.amount, scale) &&
          Math.abs(dayNumber(d.date) - dayNumber(t.date)) <= 3
      );
      if (other) {
        paired.add(other);
        continue;
      }
    }
    pending += toMinor(t.amount, scale);
    count++;
  }
  return {
    currency,
    balances: balances / scale,
    pending: { amount: pending / scale, count },
    start: (balances - pending) / scale,
    included,
    leftOut,
    noBalance,
    ...(conv.on ? { conversion: conv.done() } : {}),
  };
}

export type ForecastEvent = {
  date: string;
  /** Positive is money in, as the forecast shows it. */
  amount: number;
  name: string;
  source: 'bill' | 'income' | 'planned' | 'what-if';
  /** The series or planned item it comes from. */
  ref: string;
  cadence?: Cadence | PlannedCadence;
  /** A bill or income due before today and not in yet, counted today. */
  late?: boolean;
  /** Its scheduled date, when that isn't `date` (a late one). */
  due?: string;
  /** Its amount in its own currency, when it is converted into the
   *  forecast's (with a home currency): what the forecast lists. */
  own?: { amount: number; currency: string };
};

/** Whether the forecast counts a series at all: one on a cash account whose
 *  amount it can use (see WHAT MOVES IT). */
export function countsInForecast(s: Pick<RecurringSeries, 'accountType' | 'agreement'>): boolean {
  return s.accountType === 'depository' && s.agreement !== 'varies';
}

/** What forecastEvents leaves out but the notes name. */
export type LeftOutSeries = {
  /** Pay on a cash account that keeps its schedule at amounts too varied to
   *  forecast. */
  varied: RecurringSeries[];
  /** Pay on a cash account that stopped coming. */
  lapsed: RecurringSeries[];
  /** Bills and income on an account whose type isn't known. */
  unplaced: RecurringSeries[];
  /** The cards whose payment from cash it holds (institution, then account,
   *  joined by "|"), and the amounts of those it holds for a card it can't
   *  tell. */
  cardsPaid: { known: Set<string>; unknown: number[] };
};

/**
 * What moves the forecast from `today` through `until`: each series' expected
 * dates on a cash account and each planned item's days, in the forecast's
 * `currency`, soonest first (on a day, money in before money out). Dismissed
 * series (the ids lib/recurring.ts dismissedSeries gives) are left out, and so
 * is anything in another currency, counted by currency in `leftOut`, unless
 * `fx` (a home currency) converts it at the newest rates (see the header).
 */
export function forecastEvents(opts: {
  series: readonly RecurringSeries[];
  planned: readonly PlannedItem[];
  dismissed?: ReadonlySet<string>;
  currency: string | null;
  today: string;
  until: string;
  fx?: FxTable | null;
}): { events: ForecastEvent[]; leftOut: LeftOut; conversion: ForecastConversion | null } & LeftOutSeries {
  const { currency, today, until } = opts;
  const events: ForecastEvent[] = [];
  const others = new Map<string, number>();
  const leaveOut = (c: string) => others.set(c, (others.get(c) ?? 0) + 1);
  const conv = converter(opts.fx, currency, today);
  /** An amount in the forecast's currency: itself, or converted (null with
   *  no rate, or without a home currency, when it is left out). */
  const inForecast = (amount: number, c: string | null): { amount: number; own?: ForecastEvent['own'] } | null => {
    if (inCurrency({ iso_currency_code: c }, currency)) return { amount };
    const converted = conv.to(amount, c!);
    return converted === null ? null : { amount: converted, own: { amount, currency: c! } };
  };
  const named: LeftOutSeries = { varied: [], lapsed: [], unplaced: [], cardsPaid: { known: new Set(), unknown: [] } };

  for (const s of opts.series) {
    if (opts.dismissed?.has(s.id)) continue;
    const { status, dates } = expectedDates(s, today, until);
    if (s.accountType === null) {
      if (status !== 'ended' && s.agreement !== 'varies') named.unplaced.push(s);
      continue;
    }
    // A card's, a loan's or an investment account's own: not cash.
    if (s.accountType !== 'depository') continue;
    if (s.kind === 'income' && status === 'ended') {
      named.lapsed.push(s);
      continue;
    }
    if (s.agreement === 'varies') {
      if (status !== 'ended') named.varied.push(s);
      continue;
    }
    if (dates.length === 0) continue;
    const at = inForecast(s.amount, s.currency);
    if (at === null) {
      leaveOut(s.currency!);
      continue;
    }
    if (s.paysCardOf) named.cardsPaid.known.add(`${s.paysCardOf.institution}|${s.paysCardOf.account}`);
    else if (s.paysCard) named.cardsPaid.unknown.push(s.amount);
    const sign = s.kind === 'income' ? 1 : -1;
    for (const d of dates)
      events.push({
        date: d.date,
        amount: sign * at.amount,
        name: s.name,
        source: s.kind,
        ref: s.id,
        cadence: s.cadence,
        ...(d.late ? { late: true, due: d.due } : {}),
        ...(at.own ? { own: { amount: sign * at.own.amount, currency: at.own.currency } } : {}),
      });
  }
  for (const item of opts.planned) {
    const days = plannedDates(item, today, until);
    if (days.length === 0) continue;
    const at = inForecast(item.amount, item.currency);
    if (at === null) {
      leaveOut(item.currency);
      continue;
    }
    const sign = item.kind === 'income' ? 1 : -1;
    for (const date of days)
      events.push({
        date,
        amount: sign * at.amount,
        name: item.name,
        source: 'planned',
        ref: item.id,
        cadence: item.cadence,
        ...(at.own ? { own: { amount: sign * at.own.amount, currency: at.own.currency } } : {}),
      });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));
  const leftOut = [...others].map(([c, count]) => ({ currency: c, count })).sort((x, y) => y.count - x.count || (x.currency < y.currency ? -1 : 1));
  return { events, leftOut, conversion: conv.done(), ...named };
}

export type ForecastDay = {
  date: string;
  /** The balance once the day's money out is counted, before its money in
   *  (see THE ARITHMETIC): the day's lowest. */
  low: number;
  /** The balance at the end of the day, after its events. */
  balance: number;
  events: ForecastEvent[];
};

export type Forecast = {
  /** The balance now, before anything expected today: the one figure in it
   *  that isn't an estimate. */
  start: number;
  /** Each day, today first, through the range. */
  days: ForecastDay[];
  /** The lowest balance, now or on a day (its low), and the first day it is
   *  reached: today when it is now (a paycheck expected today hasn't come). */
  lowest: { date: string; balance: number };
  /** The balance at the end of the last day. */
  end: number;
  /** The first day the balance is expected below zero (today when it is now),
   *  or null. */
  belowZero: string | null;
  /** The first day it is expected below the warning (when that is above
   *  zero), or null. */
  belowThreshold: string | null;
};

/** The forecast from `start` now, on `today`, through `range` days on, day by
 *  day, in whole minor units of `currency` (see THE ARITHMETIC). Events
 *  outside those days are ignored. */
export function buildForecast(
  start: number,
  events: readonly ForecastEvent[],
  today: string,
  range: number,
  threshold = 0,
  currency: string | null = null
): Forecast {
  const scale = minorScale(currency);
  const byDay = new Map<string, ForecastEvent[]>();
  for (const e of events) {
    const list = byDay.get(e.date);
    if (list) list.push(e);
    else byDay.set(e.date, [e]);
  }
  const startUnits = toMinor(start, scale);
  const thresholdUnits = toMinor(threshold, scale);
  let units = startUnits;
  const days: ForecastDay[] = [];
  // Now counts: what is expected today may not have happened yet.
  let lowest = { date: today, units: startUnits };
  let belowZero: string | null = startUnits < 0 ? today : null;
  let belowThreshold: string | null = thresholdUnits > 0 && startUnits < thresholdUnits ? today : null;
  for (let i = 0; i <= range; i++) {
    const date = addDays(today, i);
    const todays = byDay.get(date) ?? [];
    for (const e of todays) if (e.amount < 0) units += toMinor(e.amount, scale);
    const low = units;
    for (const e of todays) if (e.amount > 0) units += toMinor(e.amount, scale);
    days.push({ date, low: low / scale, balance: units / scale, events: todays });
    if (low < lowest.units) lowest = { date, units: low };
    if (low < 0 && belowZero === null) belowZero = date;
    if (thresholdUnits > 0 && low < thresholdUnits && belowThreshold === null) belowThreshold = date;
  }
  return {
    start: startUnits / scale,
    days,
    lowest: { date: lowest.date, balance: lowest.units / scale },
    end: units / scale,
    belowZero,
    belowThreshold,
  };
}

/** The same forecast with one more purchase: `amount` (positive) going out on
 *  `date`. */
export function withPurchase(events: readonly ForecastEvent[], purchase: { amount: number; date: string }): ForecastEvent[] {
  return [...events, { date: purchase.date, amount: -Math.abs(purchase.amount), name: 'What if', source: 'what-if', ref: 'what-if' }];
}

/** How the notes name a day: a recovered balance's snapshot day (with the
 *  instant it was taken, when known), and an instant's local day. */
export type NoteDays = {
  snapshot: (date: string, at?: string) => string;
  instant: (iso: string) => string;
  /** A calendar day, as a short date. */
  day: (date: string) => string;
};

/** A connection whose transactions stopped arriving (lib/month-coverage.ts). */
export type StoppedConnection = { institution_name: string; last_ok_at: string | null };
/** An institution whose rows are not all in this load (/api/transactions):
 *  missing, or importing older rows. A bank a restore brought back that waits
 *  to be linked (`held`) is past rows only, which a forecast's months never
 *  reach, so it says nothing of one. */
export type IncompleteConnection = { institution_name: string; coverage: 'missing' | 'importing' | 'held' };

/** How old a typed balance may be before the forecast says when it is from. */
export const MANUAL_STALE_DAYS = 7;
/** A payment near a card's statement or minimum, within this share of it, is
 *  taken for that card's (forecastNotes). */
const CARD_NEAR = 0.25;
/** How many days from a card's due date a planned expense is taken for its
 *  payment. */
const CARD_PLANNED_DAYS = 5;

const join = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const unique = (names: string[]) => [...new Set(names)];
const accountsWord = (n: number) => (n === 1 ? '1 account' : `${n} accounts`);

/**
 * What the forecast may be missing or starting from old figures, as plain
 * sentences, most important first; empty when nothing is known to be wrong.
 * Each names its institution, as the Home total's notes do: a balance
 * recovered from an earlier day, an institution that couldn't be reached, a
 * checking or savings account a bank couldn't show or that stopped reporting
 * (its cash is not counted), a connection that stopped syncing or whose
 * transactions couldn't be loaded or are still arriving (its bills and income
 * may be missing), one whose transactions don't come in at all, pay that
 * stopped coming or varies too much to forecast, a typed balance not updated
 * for a week, and what was left out for its currency, for having no balance,
 * or for being on an account whose type isn't known.
 */
export function forecastNotes(opts: {
  institutions: readonly ForecastInstitution[];
  position: CashPosition;
  /** Expected amounts left out for their currency (forecastEvents). */
  eventsLeftOut: LeftOut;
  /** With a home currency, why those have no rate (forecastEvents). */
  eventsConversion?: ForecastConversion | null;
  /** Series left out and named, and the cards whose payment is held
   *  (forecastEvents). */
  series?: Partial<LeftOutSeries>;
  /** The forecast's last day, for the card payments due within it. */
  until?: string;
  /** The planned items: a card's payment already planned isn't named. */
  planned?: readonly PlannedItem[];
  stopped?: readonly StoppedConnection[];
  incomplete?: readonly IncompleteConnection[];
  /** Institutions whose bank accounts or cards bring in no transactions:
   *  Plaid doesn't provide them (`refused`), or the person didn't allow them. */
  refused?: readonly string[];
  unallowed?: readonly string[];
  today: string;
  days: NoteDays;
}): string[] {
  const { institutions, position, today, days } = opts;
  const notes: string[] = [];
  const included = new Set(position.included.map((a) => a.account_id));
  /** The unshown accounts that may hold cash: checking and savings, and any
   *  whose kind wasn't remembered. */
  const unshownCash = (i: ForecastInstitution) => (i.unshown_accounts ?? []).filter((a) => a.type === undefined || a.type === 'depository').map((a) => a.name);

  // Balances recovered from an earlier day, on an account the forecast starts
  // from; or a connector's bank held, which its card says why in its own
  // words (it may have answered today, held only for a card's question).
  for (const i of institutions) {
    if (!i.stale_as_of || !i.accounts.some((a) => included.has(a.account_id))) continue;
    const on = days.snapshot(i.stale_as_of, i.stale_as_of_at);
    if (i.connector && i.error) {
      notes.push(`${i.error.replace(/[.\s]+$/, '')}, so this starts from ${i.institution_name}'s balances on ${on}.`);
      continue;
    }
    const why = i.needs_reauth ? 'needs reconnecting' : "couldn't refresh";
    notes.push(`${i.institution_name} ${why}, so this starts from its balances on ${on}.`);
  }
  // Couldn't be reached, with nothing recovered: its cash is missing, named
  // when its accounts are known. A manual account is never reached for; a
  // connector's accounts that couldn't be read are.
  const unreached = institutions.filter((i) => (!i.manual || !!i.connector) && (i.error || i.needs_reauth) && !i.stale_as_of && i.accounts.length === 0);
  const unknownCash = unique(unreached.filter((i) => !i.unshown_accounts).map((i) => i.institution_name));
  if (unknownCash.length > 0)
    notes.push(`${join(unknownCash)} couldn't be reached, so any checking or savings there ${unknownCash.length === 1 ? "isn't" : "aren't"} in this forecast.`);
  for (const i of unreached) {
    const names = i.unshown_accounts ? unshownCash(i) : [];
    if (names.length > 0) notes.push(`${i.institution_name} couldn't be reached, so ${join(names)} there ${names.length === 1 ? "isn't" : "aren't"} in this forecast.`);
  }
  // Reached, or recovered, without some of its accounts.
  for (const i of institutions) {
    if (i.manual || unreached.includes(i)) continue;
    const names = unshownCash(i);
    if (names.length > 0) notes.push(`${join(names)} at ${i.institution_name} couldn't be shown, so ${names.length === 1 ? "its balance isn't" : "their balances aren't"} in this forecast.`);
    else if (!i.unshown_accounts && (i.stale_missing ?? 0) > 0)
      notes.push(`${accountsWord(i.stale_missing!)} at ${i.institution_name} couldn't be shown, so any cash in ${i.stale_missing === 1 ? 'it' : 'them'} isn't in this forecast.`);
    // Held at their last known balances until answered, so in the forecast
    // from those; a payload from before holds says only how many.
    const held = i.accounts.filter((a) => a.held);
    const heldCash = held.filter((a) => included.has(a.account_id)).map((a) => a.name);
    if (heldCash.length > 0)
      notes.push(`${join(heldCash)} at ${i.institution_name} stopped reporting, so this starts from ${heldCash.length === 1 ? 'its last known balance' : 'their last known balances'}.`);
    else if (held.length === 0 && (i.unconfirmed_missing ?? 0) > 0)
      notes.push(
        `${accountsWord(i.unconfirmed_missing!)} at ${i.institution_name} stopped reporting, so any cash in ${i.unconfirmed_missing === 1 ? 'it' : 'them'} isn't in this forecast.`
      );
  }

  const missing = unique((opts.incomplete ?? []).filter((i) => i.coverage === 'missing').map((i) => i.institution_name));
  if (missing.length > 0)
    notes.push(`Transactions from ${join(missing)} couldn't be loaded, so bills and income there may be missing.`);
  const stopped = (opts.stopped ?? []).filter((s) => !missing.includes(s.institution_name));
  if (stopped.length > 0) {
    const parts = stopped.map((s) => (s.last_ok_at ? `${s.institution_name} hasn't synced since ${days.instant(s.last_ok_at)}` : `${s.institution_name} isn't syncing`));
    notes.push(`${join(parts)}, so bills and income there may be missing or out of date.`);
  }
  const importing = unique((opts.incomplete ?? []).filter((i) => i.coverage === 'importing').map((i) => i.institution_name)).filter((n) => !missing.includes(n));
  if (importing.length > 0)
    notes.push(`${join(importing)} ${importing.length === 1 ? 'is' : 'are'} still importing older transactions, so some bills may not be found yet.`);
  if (opts.refused && opts.refused.length > 0)
    notes.push(`Plaid doesn't provide transactions for the bank or card accounts at ${join(unique([...opts.refused]))}, so their bills and income aren't in this forecast.`);
  if (opts.unallowed && opts.unallowed.length > 0)
    notes.push(`You didn't allow Nya to see transactions from the bank or card accounts at ${join(unique([...opts.unallowed]))}, so their bills and income aren't in this forecast.`);

  // A card's payment due within the forecast that it doesn't hold (none was
  // detected paying that card, as one that changes every month isn't), named
  // with what is owed of its statement, from Plaid's payment details. Not said
  // when that statement is paid already (a payment on or after its issue
  // date covers it), when a planned expense near the due date is that
  // payment, or when a payment held for a card it can't tell is near what this
  // one owes: it may be that one.
  const paid = opts.series?.cardsPaid;
  const close = (a: number, b: number | null | undefined) => b !== null && b !== undefined && b > 0 && Math.abs(a - b) <= b * CARD_NEAR;
  if (opts.until)
    for (const i of institutions)
      for (const a of i.accounts) {
        const l = a.liability;
        const due = l?.next_due_date;
        if (!l || a.type !== 'credit' || a.hidden || !due || due < today || due > opts.until || (a.currency && position.currency && a.currency !== position.currency)) continue;
        if (paid?.known.has(`${i.institution_name}|${a.name}`)) continue;
        const statement = l.last_statement_balance ?? null;
        const since = !!l.last_payment_date && !!l.last_statement_issue_date && l.last_payment_date >= l.last_statement_issue_date ? (l.last_payment_amount ?? 0) : 0;
        const owed = statement === null ? null : Math.max(0, Math.round((statement - since) * 100) / 100);
        if (owed === 0) continue;
        const figure = owed ?? l.minimum_payment;
        if (paid?.unknown.some((x) => close(x, figure) || close(x, l.minimum_payment))) continue;
        const planned = (opts.planned ?? []).some(
          (p) =>
            p.kind === 'expense' &&
            inCurrency({ iso_currency_code: p.currency }, position.currency) &&
            plannedDates(p, addDays(due, -CARD_PLANNED_DAYS), addDays(due, CARD_PLANNED_DAYS), 1).length > 0 &&
            (close(p.amount, figure) || close(p.amount, l.minimum_payment))
        );
        if (planned) continue;
        const money = (n: number) => formatMoney(n, a.currency ?? position.currency);
        const amount =
          owed === null
            ? l.minimum_payment
              ? `, minimum ${money(l.minimum_payment)},`
              : ''
            : since > 0
              ? `, ${money(owed)} left of its statement,`
              : `, statement balance ${money(owed)},`;
        notes.push(`${a.name}'s payment${amount} is due ${days.day(due)} and isn't in this forecast, since it changes each month. Add it as a planned expense if you'll pay it from checking.`);
      }

  // Pay left out, named.
  for (const s of opts.series?.lapsed ?? [])
    notes.push(`${s.name} hasn't come since ${days.day(s.lastDate)}, so it isn't in this forecast. If it still comes, add it as planned income.`);
  for (const s of opts.series?.varied ?? [])
    notes.push(`${s.name} comes on a schedule, but its amount varies too much to forecast, so it isn't in this. Add what you expect as planned income.`);

  // A typed balance holds until it is updated. (A connector's is the bank's,
  // held with its own date when it is old: said above.)
  for (const a of position.included) {
    if (!a.manual || !a.updated_at) continue;
    const at = new Date(a.updated_at);
    if (Number.isNaN(at.getTime())) continue;
    const local = days.instant(a.updated_at);
    const age = (Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10))) - Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())) / 86_400_000;
    if (age > MANUAL_STALE_DAYS) notes.push(`${a.name}'s balance was last updated on ${local}.`);
  }

  for (const n of position.noBalance) notes.push(`${n.name} at ${n.institution} has no balance to start from, so it isn't in this forecast.`);
  const accounts = withWhy(leftOutText(position.leftOut, position.currency, { noun: 'cash account', where: 'this forecast', plural: false }), position.conversion);
  if (accounts) notes.push(accounts);
  const amounts = withWhy(leftOutText(opts.eventsLeftOut, position.currency, { noun: 'expected amount', where: 'this forecast', plural: false }), opts.eventsConversion);
  if (amounts) notes.push(amounts);
  const unplaced = opts.series?.unplaced ?? [];
  if (unplaced.length > 0)
    notes.push(
      `${join(unique(unplaced.map((s) => s.name)))} ${unplaced.length === 1 ? 'is' : 'are'} on an account whose type isn't known, so ${unplaced.length === 1 ? "it isn't" : "they aren't"} in this forecast.`
    );
  return notes;
}

/** A sentence of what was left out for its currency, with why each has no
 *  rate after it when a home currency converts the rest (lib/fx/words.ts). */
function withWhy(text: string | null, c: ForecastConversion | null | undefined): string | null {
  if (text === null || !c || c.unrated.length === 0) return text;
  return `${text.replace(/\.$/, '')}: ${c.unrated.map((u) => reasonText(u.currency, u.why, u.unrated, c.into)).join('; ')}.`;
}

/** What the forecast converted into its currency, with a home currency, in
 *  a sentence, or null when nothing was: "Converted into USD at today's ECB
 *  rates: 1 cash account in EUR and 2 expected amounts in EUR." Never an
 *  amount. */
export function forecastConvertedText(accounts: ForecastConversion | null | undefined, amounts: ForecastConversion | null | undefined): string | null {
  const listed = (from: ForecastConversion['from'], noun: string) => from.map((f, i) => (i === 0 ? `${f.count} ${noun}${f.count === 1 ? '' : 's'} in ${f.currency}` : `${f.count} in ${f.currency}`));
  const parts = [...listed(accounts?.from ?? [], 'cash account'), ...listed(amounts?.from ?? [], 'expected amount')];
  const into = accounts?.into ?? amounts?.into;
  if (!into || parts.length === 0) return null;
  const own = [...new Set([...(accounts?.own ?? []), ...(amounts?.own ?? [])])].sort();
  return `Converted into ${into} at today’s ECB rates${own.length > 0 ? `, and your own rate for ${join(own)}` : ''}: ${join(parts)}.`;
}
