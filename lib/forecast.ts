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
// taken to be in it (as lib/spending.ts takes a row). Those in another
// currency are left out and named, and so is an account without a balance.
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
   *  marks the payment due (lib/calendar.ts duePayments), and the forecast
   *  names a card whose payment it doesn't hold (forecastNotes). */
  liability?: { minimum_payment: number | null; next_due_date: string | null; last_statement_balance?: number | null };
};

/** An account an institution's card can't show (lib/last-known.ts). */
export type UnshownAccount = { name: string; type?: string; currency?: string | null };

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
  manual: boolean;
  updated_at?: string;
};

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
};

/** Minor units in one unit of a currency: 100 for USD, 1 for JPY, 1000 for
 *  KWD (lib/manual-txn-input.ts minorDigits); 100 when none is named. */
export function minorScale(currency: string | null): number {
  return 10 ** minorDigits(currency ?? 'USD');
}

const toMinor = (n: number, scale: number) => Math.round(n * scale);

/** Where a forecast starts: the cash accounts, their currency and balance,
 *  less the charges pending on them (see the header). */
export function cashPosition(institutions: readonly ForecastInstitution[], txns: readonly PendingRow[] = []): CashPosition {
  const cash = institutions.flatMap((i) =>
    i.accounts.filter((a) => a.type === 'depository' && !a.hidden).map((a) => ({ a, institution: i.institution_name, manual: !!i.manual }))
  );
  const currency = dominantCurrency(cash.map(({ a }) => ({ iso_currency_code: a.currency })));
  const scale = minorScale(currency);
  const included: CashAccount[] = [];
  const noBalance: CashPosition['noBalance'] = [];
  const others = new Map<string, number>();
  let balances = 0;
  for (const { a, institution, manual } of cash) {
    if (a.currency && currency && a.currency !== currency) {
      others.set(a.currency, (others.get(a.currency) ?? 0) + 1);
      continue;
    }
    if (a.balance === null || !Number.isFinite(a.balance)) {
      noBalance.push({ name: a.name, institution });
      continue;
    }
    balances += toMinor(a.balance, scale);
    included.push({ account_id: a.account_id, name: a.name, institution, balance: a.balance, manual, ...(a.updated_at ? { updated_at: a.updated_at } : {}) });
  }
  const leftOut = [...others].map(([c, count]) => ({ currency: c, count })).sort((x, y) => y.count - x.count || (x.currency < y.currency ? -1 : 1));

  // Pending on an included account (a row names its account by name and
  // institution, and its type when known).
  const accounts = new Set(included.map((a) => `${a.institution}|${a.name}`));
  const onCash = txns.filter(
    (t) =>
      t.pending &&
      accounts.has(`${t.institution_name}|${t.account_name}`) &&
      (t.account_type === undefined || t.account_type === null || t.account_type === 'depository') &&
      inCurrency(t, currency)
  );
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
   *  joined by "|"), and whether it holds one for a card it can't tell. */
  cardsPaid: { known: Set<string>; unknown: boolean };
};

/**
 * What moves the forecast from `today` through `until`: each series' expected
 * dates on a cash account and each planned item's days, in the forecast's
 * `currency`, soonest first (on a day, money in before money out). Dismissed
 * series (the ids lib/recurring.ts dismissedSeries gives) are left out, and so
 * is anything in another currency, counted by currency in `leftOut`.
 */
export function forecastEvents(opts: {
  series: readonly RecurringSeries[];
  planned: readonly PlannedItem[];
  dismissed?: ReadonlySet<string>;
  currency: string | null;
  today: string;
  until: string;
}): { events: ForecastEvent[]; leftOut: LeftOut } & LeftOutSeries {
  const { currency, today, until } = opts;
  const events: ForecastEvent[] = [];
  const others = new Map<string, number>();
  const leaveOut = (c: string) => others.set(c, (others.get(c) ?? 0) + 1);
  const named: LeftOutSeries = { varied: [], lapsed: [], unplaced: [], cardsPaid: { known: new Set(), unknown: false } };

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
    if (!inCurrency({ iso_currency_code: s.currency }, currency)) {
      leaveOut(s.currency!);
      continue;
    }
    if (s.paysCardOf) named.cardsPaid.known.add(`${s.paysCardOf.institution}|${s.paysCardOf.account}`);
    else if (s.paysCard) named.cardsPaid.unknown = true;
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
  return { events, leftOut, ...named };
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
/** An institution whose rows are not all in this load (/api/transactions). */
export type IncompleteConnection = { institution_name: string; coverage: 'missing' | 'importing' };

/** How old a typed balance may be before the forecast says when it is from. */
export const MANUAL_STALE_DAYS = 7;

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
  /** Series left out and named, and the cards whose payment is held
   *  (forecastEvents). */
  series?: Partial<LeftOutSeries>;
  /** The forecast's last day, for the card payments due within it. */
  until?: string;
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

  // Balances recovered from an earlier day, on an account the forecast starts from.
  for (const i of institutions) {
    if (!i.stale_as_of || !i.accounts.some((a) => included.has(a.account_id))) continue;
    const why = i.needs_reauth ? 'needs reconnecting' : "couldn't refresh";
    notes.push(`${i.institution_name} ${why}, so this starts from its balances on ${days.snapshot(i.stale_as_of, i.stale_as_of_at)}.`);
  }
  // Couldn't be reached, with nothing recovered: its cash is missing, named
  // when its accounts are known.
  const unreached = institutions.filter((i) => !i.manual && (i.error || i.needs_reauth) && !i.stale_as_of && i.accounts.length === 0);
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
    if ((i.unconfirmed_missing ?? 0) > 0)
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
  // with its statement balance, from Plaid's payment details. Not said when
  // a payment held pays a card it can't tell: it may be that one.
  const paid = opts.series?.cardsPaid;
  if (opts.until && !paid?.unknown)
    for (const i of institutions)
      for (const a of i.accounts) {
        const due = a.liability?.next_due_date;
        const owed = a.liability?.last_statement_balance ?? null;
        if (a.type !== 'credit' || a.hidden || !due || due < today || due > opts.until || (a.currency && position.currency && a.currency !== position.currency)) continue;
        if (paid?.known.has(`${i.institution_name}|${a.name}`) || owed === 0) continue;
        const amount = owed !== null ? `, statement balance ${formatMoney(owed, a.currency ?? position.currency)},` : '';
        notes.push(`${a.name}'s payment${amount} is due ${days.day(due)} and isn't in this forecast, since it changes each month. Add it as a planned expense if you'll pay it from checking.`);
      }

  // Pay left out, named.
  for (const s of opts.series?.lapsed ?? [])
    notes.push(`${s.name} hasn't come since ${days.day(s.lastDate)}, so it isn't in this forecast. If it still comes, add it as planned income.`);
  for (const s of opts.series?.varied ?? [])
    notes.push(`${s.name} comes on a schedule, but its amount varies too much to forecast, so it isn't in this. Add what you expect as planned income.`);

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
  const unplaced = opts.series?.unplaced ?? [];
  if (unplaced.length > 0)
    notes.push(
      `${join(unique(unplaced.map((s) => s.name)))} ${unplaced.length === 1 ? 'is' : 'are'} on an account whose type isn't known, so ${unplaced.length === 1 ? "it isn't" : "they aren't"} in this forecast.`
    );
  return notes;
}
