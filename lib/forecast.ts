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
// balance the dashboard shows. One currency at a time, as every total: the one
// most of them are in, and an account that names none is taken to be in it
// (as lib/spending.ts takes a row). Those in another currency are left out and
// named, and so is an account without a balance.
//
// WHAT MOVES IT. Each detected bill (out) and income (in) on the dates its
// schedule names from today, one that is late within its tolerance counting
// today; each planned item on its days; nothing dismissed, nothing in another
// currency (named instead). Not everyday spending, and not a card's payment
// unless it repeats at a steady amount (then it is a detected bill): the
// forecast says so. Money is counted in whole cents, so a day's balance is the
// one before it plus that day's amounts, exactly. The lowest point counts the
// balance now too: what is expected today may not have happened yet.

import { type Cadence, type RecurringSeries, expectedDates, addDays } from './recurring';
import { plannedDates, type PlannedCadence, type PlannedItem } from './planned';
import { inCurrency, leftOutText, type LeftOut } from './spending';
import { dominantCurrency } from './format';

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
  /** A card's or loan's payment terms, where Plaid serves them: the calendar
   *  marks the payment due (lib/calendar.ts duePayments). */
  liability?: { minimum_payment: number | null; next_due_date: string | null };
};

/** What the forecast reads of an institution (/api/net-worth). */
export type ForecastInstitution = {
  institution_name: string;
  item_id?: string;
  manual?: boolean;
  error?: string | null;
  needs_reauth?: boolean;
  /** The day its balances are from, when they were recovered. */
  stale_as_of?: string;
  stale_as_of_at?: string;
  /** Its connection's health (lib/connection-state.ts). */
  health?: { state: string; last_ok_at: string | null };
  accounts: ForecastAccount[];
};

export type CashAccount = {
  account_id: string;
  name: string;
  institution: string;
  balance: number;
  manual: boolean;
  updated_at?: string;
};

export type CashPosition = {
  /** The forecast's currency, or null when no account names one. */
  currency: string | null;
  /** The included accounts' balances added up, to the cent. */
  start: number;
  included: CashAccount[];
  /** Cash accounts in another currency, by currency, most first. */
  leftOut: LeftOut;
  /** Cash accounts with no balance to start from. */
  noBalance: { name: string; institution: string }[];
};

const toCents = (n: number) => Math.round(n * 100);

/** Where a forecast starts: the cash accounts, their currency and balance. */
export function cashPosition(institutions: readonly ForecastInstitution[]): CashPosition {
  const cash = institutions.flatMap((i) =>
    i.accounts.filter((a) => a.type === 'depository' && !a.hidden).map((a) => ({ a, institution: i.institution_name, manual: !!i.manual }))
  );
  const currency = dominantCurrency(cash.map(({ a }) => ({ iso_currency_code: a.currency })));
  const included: CashAccount[] = [];
  const noBalance: CashPosition['noBalance'] = [];
  const others = new Map<string, number>();
  let cents = 0;
  for (const { a, institution, manual } of cash) {
    if (a.currency && currency && a.currency !== currency) {
      others.set(a.currency, (others.get(a.currency) ?? 0) + 1);
      continue;
    }
    if (a.balance === null || !Number.isFinite(a.balance)) {
      noBalance.push({ name: a.name, institution });
      continue;
    }
    cents += toCents(a.balance);
    included.push({ account_id: a.account_id, name: a.name, institution, balance: a.balance, manual, ...(a.updated_at ? { updated_at: a.updated_at } : {}) });
  }
  const leftOut = [...others].map(([c, count]) => ({ currency: c, count })).sort((x, y) => y.count - x.count || (x.currency < y.currency ? -1 : 1));
  return { currency, start: cents / 100, included, leftOut, noBalance };
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
};

/**
 * What moves the forecast from `today` through `until`: each series' expected
 * dates and each planned item's days, in the forecast's `currency`, soonest
 * first (money in before money out on a day). Dismissed series are left out,
 * and so is anything in another currency, counted by currency in `leftOut`.
 */
export function forecastEvents(opts: {
  series: readonly RecurringSeries[];
  planned: readonly PlannedItem[];
  dismissed?: ReadonlySet<string>;
  currency: string | null;
  today: string;
  until: string;
}): { events: ForecastEvent[]; leftOut: LeftOut } {
  const { currency, today, until } = opts;
  const events: ForecastEvent[] = [];
  const others = new Map<string, number>();
  const leaveOut = (c: string) => others.set(c, (others.get(c) ?? 0) + 1);

  for (const s of opts.series) {
    if (opts.dismissed?.has(s.id)) continue;
    const { dates } = expectedDates(s, today, until);
    if (dates.length === 0) continue;
    if (!inCurrency({ iso_currency_code: s.currency }, currency)) {
      leaveOut(s.currency!);
      continue;
    }
    for (const d of dates)
      events.push({
        date: d.date,
        amount: s.kind === 'income' ? s.amount : -s.amount,
        name: s.name,
        source: s.kind,
        ref: s.id,
        cadence: s.cadence,
        ...(d.late ? { late: true, due: d.due } : {}),
      });
  }
  for (const item of opts.planned) {
    const days = plannedDates(item, today, until);
    if (days.length === 0) continue;
    if (!inCurrency({ iso_currency_code: item.currency }, currency)) {
      leaveOut(item.currency);
      continue;
    }
    for (const date of days)
      events.push({ date, amount: item.kind === 'income' ? item.amount : -item.amount, name: item.name, source: 'planned', ref: item.id, cadence: item.cadence });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.amount - a.amount));
  const leftOut = [...others].map(([c, count]) => ({ currency: c, count })).sort((x, y) => y.count - x.count || (x.currency < y.currency ? -1 : 1));
  return { events, leftOut };
}

export type ForecastDay = {
  date: string;
  /** The balance at the end of the day, after its events. */
  balance: number;
  events: ForecastEvent[];
};

export type Forecast = {
  /** The balance now, before anything expected today: the one figure in it
   *  that isn't an estimate. */
  start: number;
  /** The end of each day: today first (after today's events), then each day
   *  through the range. */
  days: ForecastDay[];
  /** The lowest balance, now or at a day's end, and the first day it is
   *  reached: today when it is now (a paycheck expected today hasn't come). */
  lowest: { date: string; balance: number };
  /** The balance on the last day. */
  end: number;
  /** The first day the balance is below zero (today when it is now), or null. */
  belowZero: string | null;
  /** The first day it is below the warning (when that is above zero), or null. */
  belowThreshold: string | null;
};

/** The forecast from `start` now, on `today`, through `range` days on, day by
 *  day, in whole cents. Events outside those days are ignored. */
export function buildForecast(start: number, events: readonly ForecastEvent[], today: string, range: number, threshold = 0): Forecast {
  const byDay = new Map<string, ForecastEvent[]>();
  for (const e of events) {
    const list = byDay.get(e.date);
    if (list) list.push(e);
    else byDay.set(e.date, [e]);
  }
  const startCents = toCents(start);
  const thresholdCents = toCents(threshold);
  let cents = startCents;
  const days: ForecastDay[] = [];
  // Now counts: what is expected today may not have happened yet.
  let lowest = { date: today, cents: startCents };
  let belowZero: string | null = startCents < 0 ? today : null;
  let belowThreshold: string | null = thresholdCents > 0 && startCents < thresholdCents ? today : null;
  for (let i = 0; i <= range; i++) {
    const date = addDays(today, i);
    const todays = byDay.get(date) ?? [];
    for (const e of todays) cents += toCents(e.amount);
    days.push({ date, balance: cents / 100, events: todays });
    if (cents < lowest.cents) lowest = { date, cents };
    if (cents < 0 && belowZero === null) belowZero = date;
    if (thresholdCents > 0 && cents < thresholdCents && belowThreshold === null) belowThreshold = date;
  }
  return {
    start: startCents / 100,
    days,
    lowest: { date: lowest.date, balance: lowest.cents / 100 },
    end: cents / 100,
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
};

/** A connection whose transactions stopped arriving (lib/month-coverage.ts). */
export type StoppedConnection = { institution_name: string; last_ok_at: string | null };
/** An institution whose rows are not all in this load (/api/transactions). */
export type IncompleteConnection = { institution_name: string; coverage: 'missing' | 'importing' };

/** How old a typed balance may be before the forecast says when it is from. */
export const MANUAL_STALE_DAYS = 7;

const join = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const unique = (names: string[]) => [...new Set(names)];

/**
 * What the forecast may be missing or starting from old figures, as plain
 * sentences, most important first; empty when nothing is known to be wrong.
 * Each names its institution, as the Home total's notes do: a balance
 * recovered from an earlier day, an institution that couldn't be reached (any
 * cash there is not counted), a connection that stopped syncing or whose
 * transactions couldn't be loaded or are still arriving (its bills and income
 * may be missing), one whose transactions don't come in at all, a typed
 * balance not updated for a week, and what was left out for its currency or
 * for having no balance.
 */
export function forecastNotes(opts: {
  institutions: readonly ForecastInstitution[];
  position: CashPosition;
  /** Expected amounts left out for their currency (forecastEvents). */
  eventsLeftOut: LeftOut;
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

  // Balances recovered from an earlier day, on an account the forecast starts from.
  for (const i of institutions) {
    if (!i.stale_as_of || !i.accounts.some((a) => included.has(a.account_id))) continue;
    const why = i.needs_reauth ? 'needs reconnecting' : "couldn't refresh";
    notes.push(`${i.institution_name} ${why}, so this starts from its balances on ${days.snapshot(i.stale_as_of, i.stale_as_of_at)}.`);
  }
  // Couldn't be reached, with nothing recovered: whatever cash it holds is missing.
  const unreached = unique(institutions.filter((i) => !i.manual && (i.error || i.needs_reauth) && !i.stale_as_of && i.accounts.length === 0).map((i) => i.institution_name));
  if (unreached.length > 0)
    notes.push(`${join(unreached)} couldn't be reached, so any checking or savings there ${unreached.length === 1 ? "isn't" : "aren't"} in this forecast.`);

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

  // A typed balance holds until it is updated.
  for (const a of position.included) {
    if (!a.manual || !a.updated_at) continue;
    const at = new Date(a.updated_at);
    if (Number.isNaN(at.getTime())) continue;
    const local = days.instant(a.updated_at);
    const age = (Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10))) - Date.UTC(at.getFullYear(), at.getMonth(), at.getDate())) / 86_400_000;
    if (age > MANUAL_STALE_DAYS) notes.push(`${a.name}'s balance was last updated on ${local}.`);
  }

  for (const n of position.noBalance) notes.push(`${n.name} at ${n.institution} has no balance to start from, so it isn't in this forecast.`);
  const accounts = leftOutText(position.leftOut, position.currency, { noun: 'cash account', where: 'this forecast', plural: false });
  if (accounts) notes.push(accounts);
  const amounts = leftOutText(opts.eventsLeftOut, position.currency, { noun: 'expected amount', where: 'this forecast', plural: false });
  if (amounts) notes.push(amounts);
  return notes;
}
