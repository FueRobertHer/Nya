// lib/holdings-history.ts
//
// Holdings history: what each investment account held, day by day (each
// position's security, quantity, price, value and cost basis), recorded from
// the holdings every fetch already gets. Plaid serves current holdings and two
// years of investment transactions, never past holdings, and the transactions
// carry no prices, so allocation over time can only start on the day this
// starts saving, and a day it misses can never be filled in.
//
// RECORDED by recordFetch (lib/networth.ts), so by the nightly snapshot and by
// every live fetch, from what an institution's holdings call answered in that
// same fetch: fetchHoldings sets `holdings_observed` only when the call
// answered, and only with a whole answer (observeHoldings), so a failed call or
// a partial answer is never recorded as what accounts held. Never from
// recovered or stale data (lib/last-known.ts recovers balances, and only for
// an institution whose fetch failed), and never for an institution whose fetch
// failed. An institution short an account (`unconfirmed_missing`) is recorded
// for the accounts it did return, as their balances are (measuredBalanceMap):
// a missing account is a question for the total, not for what the others hold.
//
// Keyed by UTC day, as the real net-worth layer is (lib/history.ts): an
// observation belongs to the UTC date of the moment it is recorded, and each
// account's latest observation of a day wins, whichever write lands last.
// Hidden accounts are recorded like every other: hiding is applied on read
// (lib/hidden.ts).
//
// Recording never throws and never holds up the net-worth snapshot it runs
// beside: a failed write is logged and counted (recordFetch returns the count,
// the snapshot job keeps it with the day's outcome, and the catch-up run tries
// that day again), and is never part of whether the snapshot was recorded.
//
// STORED through the storage seam (lib/repo.ts), in two map stores:
//
//   holdings:history        one compressed, encrypted value per month: each
//                           recorded day's positions per account, and the
//                           securities they name, each described once for the
//                           month (ticker, name, type, cash flag, as last seen
//                           in it) rather than once per position per day.
//   holdings:history:index  one small value, under the id "index": the id each
//                           month is stored under, and the first and last day
//                           (and moment) each account was recorded on.
//
// Month ids are random, never the month: a map store's ids are plaintext field
// names, and a date is content (lib/repo.ts, "Ids are plaintext"). The month
// lives inside the encrypted value and the index. A month's id is claimed in
// the index with a compare-and-set, so two recorders starting a month together
// agree on one id, and every change to a month or to the index goes through
// update(): the cron, a load on another device and a forget can write at once.
// A month's place in the index is claimed and never released, so an id the
// index names always belongs to that month.
//
// THE INDEX IS BOOKKEEPING: each month names itself, so it can always be
// derived from the months. If it is ever missing while months remain, the next
// recording derives it before claiming anything, so no month is stored twice
// and every recorded day stays readable (not around a month this version does
// not recognise, which could be any month: recording then fails, counted). If
// its bytes are damaged, recording stops (it is read strictly) and every read
// answers that it can't be read; the person is offered a repair
// (repairHoldingsIndex), which, once confirmed, puts a derived index in place
// of the damaged bytes in one step (MapStore.replaceUnreadable). Nothing that
// can be read is ever removed for it.
//
// READ strictly (readHoldingsHistory, and readHoldingsMonth, readHoldingsRange
// and readHoldingsSpan on it): nothing recorded is an empty answer, and
// anything the seam cannot use throws. Account links are followed on read, as
// balance history follows them (getAccountHistory in lib/history.ts): what an
// account held under an earlier id continues under its current one.
//
// THE STORED SHAPE IS CLOSED: a field this code does not know, at any level,
// makes the value unrecognised (a later version wrote it), so an older version
// never drops what a newer one added when it next writes the month. The price
// is paid on a rollback: rolled back past a release that added a field, this
// version stops recording into the months that release wrote until it is
// back, and stops recording altogether if the field is in the index. So a new
// field ships in two releases, the reader one release before the writer, and
// a rollback always lands on a release that can read what was written.
//
// SIZE. Within a month a position names its security by number (its place in
// the month's list of securities), not by Plaid's 37-character id: a day of a
// large portfolio is longer than gzip's 32 KB window, so each day's ids would
// otherwise be stored again, uncompressed. Measured with prices that move
// every day (test/holdings-history.test.ts), a 31-day month of a realistic
// portfolio (4 accounts, 60 positions) is about 264,000 characters of JSON,
// stored as about 48,000 (gzip, base64 and encryption): about 0.6% of the
// 8 MiB ceiling (MAX_TXN_BLOB_CHARS, lib/blob.ts). 1,000 positions store about
// 1,330,000 (16%), and a month would reach the ceiling at about 6,000
// positions held every day; the seam warns in the log past 60% of it. A write
// that would cross it is refused whole by the seam, loudly, and nothing is
// trimmed: the day goes unrecorded (logged and counted), as a transaction blob
// at the ceiling stops syncing (lib/transactions.ts).
//
// FORGETTING an earlier account (lib/links.ts forgetEarlierAccount) walks the
// store's own entries, so it also reaches a month the index does not name,
// and removes the account's positions from each month that holds them, one
// month at a time (a forget that stops part way is finished by running it
// again), and its days from the index (forgetAccountHoldings). Damaged
// entries, the index's included, hold nothing anyone can read: they are left
// as they are and reported. An entry this version does not recognise stops the
// forget, before anything is changed, but only for an account that could be
// in it: what can't be read never holds back forgetting a checking account.
// Deleting the person's account deletes both stores with the rest of the
// container (lib/account-deletion.ts).

import {
  defineMapStore,
  UnreadableEntriesError,
  StoredDataUnreadableError,
  StoreRefusedError,
  describeUnreadable,
} from './repo';
import type { Ctx } from './containers';
import { resolveId, sameAccountIds, type Link } from './link-core';
import { isInvestmentType } from './balance';

/** A security as described when its position was recorded. The field names
 *  are lib/cash.ts's, so a recorded position is told from cash by the same
 *  rule as a live one. */
export type HeldSecurity = {
  ticker: string | null;
  name: string | null;
  security_type: string | null;
  is_cash_equivalent: boolean | null;
};

/** One position on one day, as the institution reported it. */
export type Position = {
  /** Plaid's security_id. */
  security_id: string;
  quantity: number | null;
  /** institution_price. */
  price: number | null;
  /** institution_price_as_of: the day that price was current, when the
   *  institution says. */
  price_as_of: string | null;
  /** institution_value. */
  value: number | null;
  cost_basis: number | null;
  /** iso_currency_code. */
  currency: string | null;
  /** unofficial_currency_code (a cryptocurrency, say), only when Plaid gives
   *  one; Plaid then leaves the ISO code null. */
  unofficial_currency?: string;
};

/** One account's positions on one day: the latest observation of that day. */
export type AccountDay = { observed_at: string; positions: Position[] };

/** A position as stored: its security by number, its place in the month's
 *  `securities`. */
export type StoredPosition = Omit<Position, 'security_id'> & { security: number };

/** A security a month's positions name, with its description. */
export type MonthSecurity = { security_id: string } & HeldSecurity;

/** One month as stored. */
export type HoldingsMonth = {
  v: 1;
  /** YYYY-MM. */
  month: string;
  /** Every security the month's positions name, once each, described as last
   *  seen this month (all null where Plaid never described it). */
  securities: MonthSecurity[];
  /** UTC date (YYYY-MM-DD, within the month) -> account id -> its positions. */
  days: Record<string, Record<string, { observed_at: string; positions: StoredPosition[] }>>;
};

/** When an account was recorded: the first and last UTC days, and, when
 *  known, the moments behind them, so a person sees their own day. */
export type RecordedSpan = { first: string; last: string; first_at?: string; last_at?: string };

/** Where the months are, and when each account was recorded. */
export type HoldingsIndex = {
  v: 1;
  /** YYYY-MM -> the id the month is stored under. */
  months: Record<string, string>;
  /** Account id (as recorded) -> when it was recorded. */
  accounts: Record<string, RecordedSpan>;
};

/** What one fetch's holdings call answered, in the shape it is recorded in
 *  (set by fetchHoldings in lib/networth.ts). */
export type HoldingsObservation = {
  /** Account id -> its positions: every investment account the answer lists
   *  (an empty list is an account it listed no positions for), and no other. */
  accounts: Record<string, Position[]>;
  /** Security id -> its description, for those Plaid described. */
  securities: Record<string, HeldSecurity>;
};

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
/** The seam's rule for an id (lib/repo.ts), for the month ids the index
 *  holds: one it would refuse is a shape this code does not recognise. */
const ENTRY_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAmount = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));
const isText = (v: unknown) => v === null || typeof v === 'string';
const isInstant = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
/** Whether every key of `v` is one this code knows: one it doesn't was written
 *  by a later version, and is never dropped by rewriting the value. */
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
/** A key from stored or provider data, looked up without reaching the
 *  prototype: a plain object answers "constructor" for a key never set. */
const own = <T>(o: Record<string, T>, key: string): T | undefined => (Object.hasOwn(o, key) ? o[key] : undefined);

const MONTH_KEYS = ['v', 'month', 'securities', 'days'] as const;
const SECURITY_KEYS = ['security_id', 'ticker', 'name', 'security_type', 'is_cash_equivalent'] as const;
const DAY_KEYS = ['observed_at', 'positions'] as const;
const POSITION_KEYS = ['security', 'quantity', 'price', 'price_as_of', 'value', 'cost_basis', 'currency', 'unofficial_currency'] as const;
const INDEX_KEYS = ['v', 'months', 'accounts'] as const;
const SPAN_KEYS = ['first', 'last', 'first_at', 'last_at'] as const;

function isMonthSecurity(v: unknown): v is MonthSecurity {
  return (
    isRecord(v) &&
    onlyKeys(v, SECURITY_KEYS) &&
    typeof v.security_id === 'string' &&
    v.security_id !== '' &&
    isText(v.ticker) &&
    isText(v.name) &&
    isText(v.security_type) &&
    (v.is_cash_equivalent === null || typeof v.is_cash_equivalent === 'boolean')
  );
}

/** A stored position naming one of the month's `count` securities. */
function isStoredPosition(v: unknown, count: number): v is StoredPosition {
  return (
    isRecord(v) &&
    onlyKeys(v, POSITION_KEYS) &&
    Number.isInteger(v.security) &&
    (v.security as number) >= 0 &&
    (v.security as number) < count &&
    isAmount(v.quantity) &&
    isAmount(v.price) &&
    isText(v.price_as_of) &&
    isAmount(v.value) &&
    isAmount(v.cost_basis) &&
    isText(v.currency) &&
    (v.unofficial_currency === undefined || typeof v.unofficial_currency === 'string')
  );
}

/** The shape a month is stored in (the seam checks it on every read and before
 *  every write). */
export function isHoldingsMonth(v: unknown): v is HoldingsMonth {
  if (!isRecord(v) || !onlyKeys(v, MONTH_KEYS) || v.v !== 1 || typeof v.month !== 'string' || !MONTH.test(v.month)) return false;
  if (!Array.isArray(v.securities) || !isRecord(v.days)) return false;
  const ids = new Set<string>();
  for (const s of v.securities) {
    if (!isMonthSecurity(s) || ids.has(s.security_id)) return false;
    ids.add(s.security_id);
  }
  const count = v.securities.length;
  for (const [date, accounts] of Object.entries(v.days)) {
    if (!DAY.test(date) || !date.startsWith(`${v.month}-`) || !isRecord(accounts)) return false;
    for (const day of Object.values(accounts)) {
      if (!isRecord(day) || !onlyKeys(day, DAY_KEYS) || !isInstant(day.observed_at) || !Array.isArray(day.positions)) return false;
      if (!day.positions.every((p) => isStoredPosition(p, count))) return false;
    }
  }
  return true;
}

function isSpan(v: unknown): v is RecordedSpan {
  return (
    isRecord(v) &&
    onlyKeys(v, SPAN_KEYS) &&
    typeof v.first === 'string' &&
    typeof v.last === 'string' &&
    DAY.test(v.first) &&
    DAY.test(v.last) &&
    v.first <= v.last &&
    (v.first_at === undefined || isInstant(v.first_at)) &&
    (v.last_at === undefined || isInstant(v.last_at))
  );
}

/** The shape the index is stored in. */
export function isHoldingsIndex(v: unknown): v is HoldingsIndex {
  if (!isRecord(v) || !onlyKeys(v, INDEX_KEYS) || v.v !== 1 || !isRecord(v.months) || !isRecord(v.accounts)) return false;
  for (const [month, id] of Object.entries(v.months)) {
    if (!MONTH.test(month) || typeof id !== 'string' || !ENTRY_ID.test(id)) return false;
  }
  return Object.values(v.accounts).every(isSpan);
}

const historyStore = defineMapStore<HoldingsMonth>('holdings:history', {
  what: 'holdings records',
  isValid: isHoldingsMonth,
  // What the person's accounts held: theirs, for their own data download.
  exportable: true,
  // A month repeats the same securities and accounts every day, and runs to
  // megabytes of JSON for a large portfolio (see SIZE above).
  compress: true,
});

const indexStore = defineMapStore<HoldingsIndex>('holdings:history:index', {
  what: 'holdings records',
  isValid: isHoldingsIndex,
  // Bookkeeping: where each month is stored, and dates the months themselves
  // hold. Each month names itself, so the months alone are the whole history.
  exportable: false,
});

/** The one id the index is stored under: a constant, not content. */
const INDEX_ID = 'index';

const emptyIndex = (): HoldingsIndex => ({ v: 1, months: {}, accounts: {} });

// Reading what the holdings call answered

/** Non-empty text, or null. */
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
/** A finite number, or null: what a value is when it is not a number. */
const amount = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** An id fit to be a key of a stored object ("__proto__" would set the
 *  object's prototype instead of a key). */
const isKeyId = (v: unknown): v is string => typeof v === 'string' && v !== '' && v !== '__proto__';

/**
 * What one answer of /investments/holdings/get says, in the shape it is
 * recorded in, or null when it is not a whole answer. Pure, and total: it
 * never throws, whatever the answer holds.
 *
 * Plaid's schema gives every answer a list of holdings, and every holding its
 * account and security. These are the guards for an answer that breaks it, and
 * each takes the side that never records a partial list as a whole one, since
 * a recorded day is never corrected:
 *   - no list of holdings: no answer about any account (null);
 *   - a holding naming no account: it could be any account's, so no account's
 *     list can be trusted (null);
 *   - a holding naming its account but no security: that account is left out
 *     of the day, and the others are recorded.
 *
 * Only the accounts the answer lists (its own `accounts`, not the balance
 * call's) as investment accounts are recorded. A holding naming any other
 * account, of another type or not listed, is left out with that account:
 * Plaid lists holdings for investment accounts only, and forgetting an
 * account of another type relies on its never having positions recorded
 * (lib/links.ts forgetEarlierAccount). An investment account the answer lists
 * is recorded with no positions when none names it: the answer spoke for it
 * and listed nothing. That says nothing about its balance: money an
 * institution does not list as a position (cash, often) has no position, and
 * the balance recorded beside it (lib/history.ts) is what it was worth.
 */
export function observeHoldings(answer: unknown): HoldingsObservation | null {
  if (!isRecord(answer) || !Array.isArray(answer.holdings)) return null;
  const described = new Map<string, HeldSecurity>();
  for (const s of Array.isArray(answer.securities) ? answer.securities : []) {
    if (!isRecord(s) || !isKeyId(s.security_id)) continue;
    described.set(s.security_id, {
      ticker: text(s.ticker_symbol),
      name: text(s.name),
      security_type: text(s.type),
      is_cash_equivalent: typeof s.is_cash_equivalent === 'boolean' ? s.is_cash_equivalent : null,
    });
  }
  const held = new Map<string, Position[]>();
  for (const a of Array.isArray(answer.accounts) ? answer.accounts : []) {
    if (isRecord(a) && isKeyId(a.account_id) && typeof a.type === 'string' && isInvestmentType(a.type) && !held.has(a.account_id)) {
      held.set(a.account_id, []);
    }
  }
  const short = new Set<string>();
  for (const h of answer.holdings) {
    if (!isRecord(h) || !isKeyId(h.account_id)) return null;
    const list = held.get(h.account_id);
    // Not an investment account the answer lists: never recorded.
    if (!list) continue;
    if (!isKeyId(h.security_id)) {
      short.add(h.account_id);
      continue;
    }
    const unofficial = text(h.unofficial_currency_code);
    const position: Position = {
      security_id: h.security_id,
      quantity: amount(h.quantity),
      price: amount(h.institution_price),
      price_as_of: text(h.institution_price_as_of),
      value: amount(h.institution_value),
      cost_basis: amount(h.cost_basis),
      currency: text(h.iso_currency_code),
      ...(unofficial ? { unofficial_currency: unofficial } : {}),
    };
    list.push(position);
  }
  for (const id of short) held.delete(id);
  // Described only where a position kept names it.
  const securities = new Map<string, HeldSecurity>();
  for (const positions of held.values()) {
    for (const p of positions) {
      const s = described.get(p.security_id);
      if (s) securities.set(p.security_id, s);
    }
  }
  return { accounts: Object.fromEntries(held), securities: Object.fromEntries(securities) };
}

/** The part of a fetched institution that recording reads (InstitutionResult
 *  in lib/networth.ts). */
export type ObservedInstitution = {
  error: string | null;
  manual?: boolean;
  accounts: readonly { account_id: string; type?: string | null; stale?: boolean }[];
  holdings_observed?: HoldingsObservation;
};

/**
 * Everything a fetch measured, across its institutions: only those whose
 * holdings call answered in this fetch, never one with an error (its accounts
 * are empty or recovered), and never an account marked stale (recovered by
 * lib/last-known.ts), which no institution that answered should have. Nor an
 * account the balance call gives another type than investment: that is the
 * type the directory keeps, which forgetting goes by (observeHoldings).
 */
export function measuredHoldings(institutions: readonly ObservedInstitution[]): HoldingsObservation {
  const accounts = new Map<string, Position[]>();
  const securities = new Map<string, HeldSecurity>();
  for (const inst of institutions) {
    const seen = inst.holdings_observed;
    if (!seen || inst.error || inst.manual) continue;
    const stale = new Set(inst.accounts.filter((a) => a.stale).map((a) => a.account_id));
    const otherType = new Set(inst.accounts.filter((a) => typeof a.type === 'string' && !isInvestmentType(a.type)).map((a) => a.account_id));
    for (const [id, positions] of Object.entries(seen.accounts)) {
      if (stale.has(id) || otherType.has(id) || !isKeyId(id)) continue;
      accounts.set(id, positions);
      for (const p of positions) {
        const s = own(seen.securities, p.security_id);
        if (s) securities.set(p.security_id, s);
      }
    }
  }
  return { accounts: Object.fromEntries(accounts), securities: Object.fromEntries(securities) };
}

// Changing a month. Done on an open form, keyed by ids, and numbered again
// when it is closed, so the numbering never has to be patched in place.

type OpenMonth = {
  month: string;
  /** Security id -> its latest description this month. */
  described: Map<string, HeldSecurity>;
  /** Date -> account id -> its positions that day. */
  days: Map<string, Map<string, AccountDay>>;
};

const UNDESCRIBED: HeldSecurity = { ticker: null, name: null, security_type: null, is_cash_equivalent: null };

function open(month: HoldingsMonth): OpenMonth {
  const ids = month.securities.map((s) => s.security_id);
  const described = new Map(month.securities.map(({ security_id, ...description }) => [security_id, description] as const));
  const days = new Map<string, Map<string, AccountDay>>();
  for (const [date, accounts] of Object.entries(month.days)) {
    const day = new Map<string, AccountDay>();
    for (const [account, { observed_at, positions }] of Object.entries(accounts)) {
      day.set(account, { observed_at, positions: positions.map(({ security, ...rest }) => ({ security_id: ids[security], ...rest })) });
    }
    days.set(date, day);
  }
  return { month: month.month, described, days };
}

/** The stored form: days in date order, accounts in id order, and securities
 *  numbered in the order positions first name them. A security no position
 *  names any more (replaced later in its day, or forgotten with its account)
 *  is left out, and so is a day with no account. Null when nothing is left. */
function close(o: OpenMonth): HoldingsMonth | null {
  const numbers = new Map<string, number>();
  const securities: MonthSecurity[] = [];
  const numbered = (id: string) => {
    let n = numbers.get(id);
    if (n === undefined) {
      n = securities.length;
      numbers.set(id, n);
      securities.push({ security_id: id, ...(o.described.get(id) ?? UNDESCRIBED) });
    }
    return n;
  };
  const days: [string, HoldingsMonth['days'][string]][] = [];
  for (const date of [...o.days.keys()].sort()) {
    const accounts = o.days.get(date)!;
    if (accounts.size === 0) continue;
    const stored = [...accounts.keys()].sort().map((account) => {
      const { observed_at, positions } = accounts.get(account)!;
      return [account, { observed_at, positions: positions.map(({ security_id, ...rest }) => ({ security: numbered(security_id), ...rest })) }] as const;
    });
    days.push([date, Object.fromEntries(stored)]);
  }
  if (days.length === 0) return null;
  return { v: 1, month: o.month, securities, days: Object.fromEntries(days) };
}

/**
 * `current` with an observation recorded on `date`. Pure. For each account,
 * the latest observation of the day wins: one observed earlier than what is
 * already stored for that day (a slow write of an earlier fetch) changes
 * nothing for that account. A security's description is the one its latest
 * recorded position came with. Null only for an empty observation of an
 * empty month: nothing to store.
 */
export function withObservation(
  current: HoldingsMonth | null,
  month: string,
  date: string,
  observedAt: string,
  seen: HoldingsObservation
): HoldingsMonth | null {
  // The index named this entry for another month: refused rather than mixing
  // two months in one value.
  if (current && current.month !== month) throw new Error('holdings-history: the entry for one month holds another');
  const o: OpenMonth = current ? open(current) : { month, described: new Map(), days: new Map() };
  const day = o.days.get(date) ?? new Map<string, AccountDay>();
  for (const [account, positions] of Object.entries(seen.accounts)) {
    const earlier = day.get(account);
    if (earlier && Date.parse(earlier.observed_at) > Date.parse(observedAt)) continue;
    day.set(account, { observed_at: observedAt, positions });
    for (const p of positions) {
      const s = own(seen.securities, p.security_id);
      if (s) o.described.set(p.security_id, s);
    }
  }
  o.days.set(date, day);
  return close(o);
}

/** Whether any day of the month holds the account. */
export function holdsAccount(month: HoldingsMonth, accountId: string): boolean {
  return Object.values(month.days).some((accounts) => Object.hasOwn(accounts, accountId));
}

/** The month without the account: its days, and the securities only it held.
 *  Null when nothing is left, which deletes the entry. Pure. */
export function withoutAccount(month: HoldingsMonth, accountId: string): HoldingsMonth | null {
  const o = open(month);
  for (const day of o.days.values()) day.delete(accountId);
  return close(o);
}

// The index

/** The first day a month holds the account, with the moment observed then. */
function firstDayIn(month: HoldingsMonth, account: string): { day: string; at: string } | null {
  const day = Object.keys(month.days)
    .sort()
    .find((d) => Object.hasOwn(month.days[d], account));
  return day ? { day, at: month.days[day][account].observed_at } : null;
}

/** A span, with its moments where known. */
function span(first: string, firstAt: string | undefined, last: string, lastAt: string | undefined): RecordedSpan {
  return { first, last, ...(firstAt ? { first_at: firstAt } : {}), ...(lastAt ? { last_at: lastAt } : {}) };
}

/** The index with the month claimed for `id`, unless it is claimed already
 *  (then that claim stands). */
function withMonth(index: HoldingsIndex, month: string, id: string): HoldingsIndex {
  return own(index.months, month) ? index : { ...index, months: { ...index.months, [month]: id } };
}

/**
 * The index with these accounts' days moved to take in `date`, observed at
 * `observedAt`, read from the month as written. An account's first day is the
 * earliest known: the index's, one an earlier month holds (`earlier`, found
 * for an account the index had no days for), or the earliest this month
 * holds. So a first day whose own note in the index was lost is still found.
 */
function withDays(
  index: HoldingsIndex,
  month: string,
  id: string,
  written: HoldingsMonth,
  accounts: string[],
  date: string,
  observedAt: string,
  earlier: Map<string, { day: string; at: string }>
): HoldingsIndex {
  const next = withMonth(index, month, id);
  const spans = new Map(Object.entries(next.accounts));
  for (const account of accounts) {
    const prev = spans.get(account);
    let first = prev ? { day: prev.first, at: prev.first_at } : null;
    for (const found of [earlier.get(account), firstDayIn(written, account)]) {
      if (found && (!first || found.day < first.day)) first = found;
    }
    const last = prev && prev.last >= date ? { day: prev.last, at: prev.last_at } : { day: date, at: observedAt };
    spans.set(account, span(first?.day ?? date, first?.at, last.day, last.at));
  }
  return { ...next, accounts: Object.fromEntries(spans) };
}

/**
 * An index derived from months alone: each month under its id, and each
 * account's days from the days the months hold. A month stored twice (only
 * possible if an index was once lost and a month claimed again before this
 * existed) is named once: the entry holding more days, then the first by id.
 * The other stays where it is, which forgetting and the data download still
 * reach.
 */
function deriveIndex(entries: Map<string, HoldingsMonth>): { index: HoldingsIndex; doubled: number } {
  const chosen = new Map<string, [string, HoldingsMonth]>();
  let doubled = 0;
  for (const [id, value] of entries) {
    const prev = chosen.get(value.month);
    if (prev) doubled++;
    if (!prev || Object.keys(value.days).length > Object.keys(prev[1].days).length) chosen.set(value.month, [id, value]);
  }
  const months: Record<string, string> = {};
  const spans = new Map<string, RecordedSpan>();
  for (const [month, [id, value]] of [...chosen].sort(([a], [b]) => (a < b ? -1 : 1))) {
    months[month] = id;
    for (const date of Object.keys(value.days).sort()) {
      for (const [account, day] of Object.entries(value.days[date])) {
        const s = spans.get(account);
        if (!s) spans.set(account, span(date, day.observed_at, date, day.observed_at));
        else if (date > s.last) spans.set(account, span(s.first, s.first_at, date, day.observed_at));
      }
    }
  }
  return { index: { v: 1, months, accounts: Object.fromEntries(spans) }, doubled };
}

/** `derived` folded into the index there now: its months claimed where none
 *  is, and each account's days widened to take in both. A claim already made
 *  stands, since recordings write to it. */
function mergeIndexes(current: HoldingsIndex | null, derived: HoldingsIndex): HoldingsIndex {
  if (!current) return derived;
  const spans = new Map(Object.entries(current.accounts));
  for (const [account, d] of Object.entries(derived.accounts)) {
    const c = spans.get(account);
    if (!c) {
      spans.set(account, d);
      continue;
    }
    const first = d.first < c.first ? d : c;
    const last = d.last > c.last ? d : c;
    spans.set(account, span(first.first, first.first_at, last.last, last.last_at));
  }
  return { v: 1, months: { ...derived.months, ...current.months }, accounts: Object.fromEntries(spans) };
}

/** The index without the account's days. */
function withoutDays(index: HoldingsIndex | null, account: string): HoldingsIndex | null {
  if (!index || !own(index.accounts, account)) return index;
  return { ...index, accounts: Object.fromEntries(Object.entries(index.accounts).filter(([id]) => id !== account)) };
}

// Recording

export type HoldingsRecorded = {
  /** Accounts whose positions were recorded. */
  recorded: number;
  /** Accounts whose positions could not be written (logged). */
  failed: number;
};

/** A short reason safe to log: no stored values, no ids. Upstash ends its
 *  errors with the command and its arguments, which can hold stored values. */
function reasonOf(err: unknown): string {
  if (err instanceof StoredDataUnreadableError) return `${err.name}: ${describeUnreadable(err)}`;
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message.split(', command was')[0].slice(0, 160) : '';
  return message ? `${name}: ${message}` : name;
}

/** Claims an id for the month in the index, or learns the one already
 *  claimed, and returns the index as written. */
async function claimMonth(ctx: Ctx, month: string): Promise<HoldingsIndex> {
  const fresh = crypto.randomUUID();
  const written = await indexStore.update(ctx, INDEX_ID, (current) => withMonth(current ?? emptyIndex(), month, fresh));
  // withMonth never returns null, so update always writes an index.
  return written as HoldingsIndex;
}

/** The index derived from the months there are, folded into whatever index is
 *  there now, and written. For an index missing while months remain. Not
 *  around a month this version does not recognise: it could be any month, so
 *  claiming one again could store it twice. A damaged month holds nothing
 *  anyone can read, so it is left where it is. */
async function indexFromMonths(ctx: Ctx): Promise<HoldingsIndex> {
  const { entries, unrecognised } = await historyStore.getAllReport(ctx);
  if (unrecognised.length > 0) throw new UnreadableEntriesError(historyStore.what, [], unrecognised);
  const { index, doubled } = deriveIndex(entries);
  if (doubled > 0) console.warn(`holdings-history: ${doubled} month(s) stored twice in container ${ctx.container}; each is named once`);
  return (await indexStore.update(ctx, INDEX_ID, (current) => mergeIndexes(current, index))) as HoldingsIndex;
}

/**
 * For accounts the index has no days for, the earliest day earlier months
 * hold them, looking back month by month while each month holds the account.
 * Only dates the "since" line, so a month that can't be read ends the look
 * rather than the recording: the line may then start later than the truth,
 * never earlier.
 */
async function earlierFirsts(ctx: Ctx, index: HoldingsIndex, month: string, accounts: string[]): Promise<Map<string, { day: string; at: string }>> {
  const found = new Map<string, { day: string; at: string }>();
  let looking = accounts.filter((a) => !own(index.accounts, a));
  const earlier = Object.keys(index.months)
    .filter((m) => m < month)
    .sort()
    .reverse();
  for (const m of earlier) {
    if (looking.length === 0) break;
    let value: HoldingsMonth | null;
    try {
      value = await historyStore.get(ctx, index.months[m]);
    } catch (err) {
      if (err instanceof StoredDataUnreadableError) break;
      throw err;
    }
    if (!value) break;
    looking = looking.filter((a) => {
      const first = firstDayIn(value, a);
      if (first) found.set(a, first);
      return first !== null;
    });
  }
  return found;
}

/** Records one day's observation: the month first, then the accounts' days in
 *  the index, which so describe only what landed. */
async function recordDay(ctx: Ctx, date: string, observedAt: string, seen: HoldingsObservation): Promise<void> {
  const month = date.slice(0, 7);
  let index = await indexStore.get(ctx, INDEX_ID);
  // Missing while months remain (no code removes it; a copy made by hand
  // might): derived from them before anything is claimed, so no month is
  // stored twice and every recorded day stays readable.
  if (!index && (await historyStore.count(ctx)) > 0) index = await indexFromMonths(ctx);
  if (!index || !own(index.months, month)) index = await claimMonth(ctx, month);
  const id = index.months[month];
  const written = await historyStore.update(ctx, id, (current) => withObservation(current, month, date, observedAt, seen));
  const accounts = Object.keys(seen.accounts);
  // Once a day for each account, not on every fetch.
  if (!written || accounts.every((a) => (own(index.accounts, a)?.last ?? '') >= date)) return;
  try {
    const earlier = await earlierFirsts(ctx, index, month, accounts);
    await indexStore.update(ctx, INDEX_ID, (current) => withDays(current ?? emptyIndex(), month, id, written, accounts, date, observedAt, earlier));
  } catch (err) {
    // The positions are recorded. Only "recorded since" lags, until the next
    // recording moves the days.
    console.warn(
      `holdings-history: the recorded days of ${accounts.length} account(s) could not be noted in container ${ctx.container}:`,
      reasonOf(err)
    );
  }
}

/**
 * Records what this fetch's holdings calls answered, under the UTC date of
 * `now`. Never throws: a failure is logged (counts, never ids) and counted in
 * `failed`, and touches nothing else. A fetch with no investment account
 * answering touches no storage at all.
 */
export async function recordHoldings(
  ctx: Ctx,
  institutions: readonly ObservedInstitution[],
  now: number = Date.now()
): Promise<HoldingsRecorded> {
  let accounts = 0;
  try {
    const seen = measuredHoldings(institutions);
    accounts = Object.keys(seen.accounts).length;
    if (accounts === 0) return { recorded: 0, failed: 0 };
    const at = new Date(now).toISOString();
    await recordDay(ctx, at.slice(0, 10), at, seen);
    return { recorded: accounts, failed: 0 };
  } catch (err) {
    console.error(
      `holdings-history: the positions of ${accounts} account(s) could not be recorded in container ${ctx.container}:`,
      reasonOf(err)
    );
    return { recorded: 0, failed: accounts };
  }
}

// Reading

/** A recorded position with its security's description. */
export type RecordedPosition = Position & HeldSecurity;

/** What one account held on one day. */
export type RecordedAccount = {
  /** The id the account is known by now (following links), or the one asked
   *  for. */
  account_id: string;
  /** The id the positions were recorded under: an earlier id of the same
   *  account (lib/links.ts) when it is not account_id. */
  recorded_as: string;
  observed_at: string;
  positions: RecordedPosition[];
};

export type HoldingsDay = { date: string; accounts: RecordedAccount[] };

export type HoldingsSpan = {
  /** The first and last UTC dates anything (or the account asked for) was
   *  recorded on, or null when nothing was. */
  first: string | null;
  last: string | null;
  /** The moments behind them, when known (an ISO time), so a person can be
   *  shown their own day. */
  first_at: string | null;
  last_at: string | null;
};

export type ReadOptions = {
  /** The account links in effect (lib/links.ts, effectiveLinks), followed so
   *  an earlier id's positions continue under the account's current id. */
  links?: Map<string, Link>;
  /** Only this account, under this id, with every id linked to it. */
  accountId?: string;
  /** Ids to leave out: every id of every hidden account, as getEffectiveHidden
   *  gives them. Omitted, nothing is left out. */
  hidden?: { has(id: string): boolean };
};

/**
 * Where a recorded id goes in a view: under which account, and how it ranks
 * there when two of that account's ids were recorded on one day. The order is
 * balance history's (getAccountHistory): the id asked for or the current one
 * first, then the earlier ids, the one that reported most recently first.
 * Null for an id the view leaves out.
 */
function placer(opts: ReadOptions): (recordedAs: string) => { account: string; rank: number } | null {
  const links = opts.links ?? new Map<string, Link>();
  const hidden = opts.hidden;
  const left = (recordedAs: string, account: string) => !!hidden && (hidden.has(recordedAs) || hidden.has(account));
  if (opts.accountId !== undefined) {
    const account = opts.accountId;
    const ids = [account, ...sameAccountIds(account, links).filter((id) => id !== account)];
    return (recordedAs) => {
      const rank = ids.indexOf(recordedAs);
      return rank < 0 || left(recordedAs, account) ? null : { account, rank };
    };
  }
  const orders = new Map<string, string[]>();
  return (recordedAs) => {
    const account = resolveId(recordedAs, links);
    if (left(recordedAs, account)) return null;
    let order = orders.get(account);
    if (!order) orders.set(account, (order = sameAccountIds(account, links)));
    const rank = order.indexOf(recordedAs);
    return { account, rank: rank < 0 ? order.length : rank };
  };
}

/** The month's days within [from, to], oldest first, each with its accounts in
 *  id order and its positions in the order the institution listed them. */
function viewOf(month: HoldingsMonth, from: string, to: string, place: ReturnType<typeof placer>): HoldingsDay[] {
  const out: HoldingsDay[] = [];
  for (const date of Object.keys(month.days).sort()) {
    if (date < from || date > to) continue;
    const chosen = new Map<string, { rank: number; recordedAs: string; day: HoldingsMonth['days'][string][string] }>();
    for (const [recordedAs, day] of Object.entries(month.days[date])) {
      const placed = place(recordedAs);
      if (!placed) continue;
      const prev = chosen.get(placed.account);
      if (!prev || placed.rank < prev.rank) chosen.set(placed.account, { rank: placed.rank, recordedAs, day });
    }
    if (chosen.size === 0) continue;
    const accounts = [...chosen]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([account_id, c]) => ({
        account_id,
        recorded_as: c.recordedAs,
        observed_at: c.day.observed_at,
        positions: c.day.positions.map(({ security, ...rest }): RecordedPosition => {
          const { security_id, ...description } = month.securities[security];
          return { security_id, ...description, ...rest };
        }),
      }));
    out.push({ date, accounts });
  }
  return out;
}

/** The days the index notes for the accounts a view keeps. */
function spanOf(index: HoldingsIndex | null, place: ReturnType<typeof placer>): HoldingsSpan {
  let first: { day: string; at?: string } | null = null;
  let last: { day: string; at?: string } | null = null;
  for (const [recordedAs, s] of Object.entries(index?.accounts ?? {})) {
    if (!place(recordedAs)) continue;
    if (!first || s.first < first.day) first = { day: s.first, at: s.first_at };
    if (!last || s.last > last.day) last = { day: s.last, at: s.last_at };
  }
  return { first: first?.day ?? null, last: last?.day ?? null, first_at: first?.at ?? null, last_at: last?.at ?? null };
}

/** The days the index notes for each account a view keeps, under the id it
 *  is known by now: an account recorded under several ids (linked) spans
 *  from the first of them to the last. */
function accountSpansOf(index: HoldingsIndex | null, place: ReturnType<typeof placer>): Map<string, { first: string; last: string }> {
  const out = new Map<string, { first: string; last: string }>();
  for (const [recordedAs, s] of Object.entries(index?.accounts ?? {})) {
    const placed = place(recordedAs);
    if (!placed) continue;
    const prev = out.get(placed.account);
    out.set(placed.account, prev ? { first: s.first < prev.first ? s.first : prev.first, last: s.last > prev.last ? s.last : prev.last } : { first: s.first, last: s.last });
  }
  return out;
}

/**
 * STRICT. When anything (or the account asked for, following its links) was
 * recorded, and, given a range of UTC dates, every day recorded within it
 * (inclusive), oldest first, with each account's positions under the id it is
 * known by now. `accounts` is when each account the view keeps was recorded,
 * first and last day, so a reader can tell a day an account wasn't recorded
 * on from one before or after it was. The index is read once for all of it,
 * so they agree. Nothing recorded is an empty answer; anything stored that
 * cannot be used throws (UnreadableEntriesError naming the entries, or the
 * deployment's own error), and never reads as empty.
 */
export async function readHoldingsHistory(
  ctx: Ctx,
  range: { from: string; to: string } | null,
  opts: ReadOptions = {}
): Promise<{ span: HoldingsSpan; accounts: Map<string, { first: string; last: string }>; days: HoldingsDay[] }> {
  if (range && (!DAY.test(range.from) || !DAY.test(range.to))) throw new TypeError('holdings-history: from and to are YYYY-MM-DD dates');
  const index = await indexStore.get(ctx, INDEX_ID);
  const place = placer(opts);
  const span = spanOf(index, place);
  const accounts = accountSpansOf(index, place);
  if (!range || !index || range.from > range.to) return { span, accounts, days: [] };
  const { from, to } = range;
  const months = Object.keys(index.months)
    .filter((m) => m >= from.slice(0, 7) && m <= to.slice(0, 7))
    .sort();
  const stored = await historyStore.getMany(
    ctx,
    months.map((m) => index.months[m])
  );
  const days: HoldingsDay[] = [];
  for (const month of months) {
    const id = index.months[month];
    const value = stored.get(id);
    // Claimed, but its first write never landed: nothing was recorded.
    if (!value) continue;
    if (value.month !== month) {
      // Intact, but not the month the index says: a fault to look into, not
      // something to offer for removal.
      throw new UnreadableEntriesError(historyStore.what, [], [id], new Error('a month is stored under another month\'s id'));
    }
    days.push(...viewOf(value, from, to, place));
  }
  return { span, accounts, days };
}

/** STRICT. Every day recorded within [from, to], as readHoldingsHistory. */
export async function readHoldingsRange(ctx: Ctx, from: string, to: string, opts: ReadOptions = {}): Promise<HoldingsDay[]> {
  return (await readHoldingsHistory(ctx, { from, to }, opts)).days;
}

/** STRICT. One month's recorded days (YYYY-MM), as readHoldingsHistory. */
export async function readHoldingsMonth(ctx: Ctx, month: string, opts: ReadOptions = {}): Promise<HoldingsDay[]> {
  if (!MONTH.test(month)) throw new TypeError('holdings-history: a month is YYYY-MM');
  // Bounds, not dates: no month has a day after its 31st.
  return readHoldingsRange(ctx, `${month}-01`, `${month}-31`, opts);
}

/** STRICT. When anything (or the account asked for) was recorded, from the
 *  index alone: no month is read. */
export async function readHoldingsSpan(ctx: Ctx, opts: ReadOptions = {}): Promise<HoldingsSpan> {
  return (await readHoldingsHistory(ctx, null, opts)).span;
}

// Forgetting an earlier account

const DAY_MS = 24 * 60 * 60 * 1000;

export type ForgotHoldings = {
  /** Months the account's positions were taken out of. */
  changed: number;
  /** Damaged holdings records (a month, or the index) were left as they were:
   *  no one can read them. Said only for an account that could be in them. */
  damaged: boolean;
};

/**
 * Removes one account's positions from every month, and its days from the
 * index, for a person forgetting an earlier account (lib/links.ts
 * forgetEarlierAccount, which checks it may be forgotten).
 *
 * It walks the store's own entries, so a month the index does not name is
 * reached too. Each month holding the account is changed in its own step, and
 * only if it still holds what was read (update), so a forget that stops part
 * way is finished by running it again, and positions recorded meanwhile for
 * other accounts are kept. Securities only it held go with it. A month left
 * with nothing is deleted; its place in the index stays, so a later recording
 * of that month finds it.
 *
 * What can't be used never blocks forgetting an account that isn't in it:
 *   - a damaged entry (a month, or the index) holds nothing anyone can read.
 *     It is left as it is, and reported (`damaged`) when the account could be
 *     in it, as a damaged balance map is (forgetAccountBalances in
 *     lib/history.ts);
 *   - an unrecognised entry is intact, and may hold the account. For an account
 *     that could be in it (found in a month, noted in the index, or any
 *     account while the index can't be used: damaged, unrecognised, or
 *     missing beside a month that can't be read, since it could note any) it
 *     stops the forget, changing nothing, to be run again once it can be read:
 *     removing it would lose the rest, and leaving it would keep the account.
 *     For an account the readable index never recorded, it is no reason to
 *     stop.
 *
 * An account known not to be an investment account never had positions, so
 * forgetEarlierAccount does not call this for it at all: nothing in holdings
 * records, not even one no one can read, holds its forget back.
 */
export async function forgetAccountHoldings(ctx: Ctx, account_id: string): Promise<ForgotHoldings> {
  const [months, index] = await Promise.all([historyStore.getAllReport(ctx), indexStore.getAllReport(ctx)]);
  const current = index.entries.get(INDEX_ID) ?? null;
  const holding = [...months.entries].filter(([, m]) => holdsAccount(m, account_id)).map(([id]) => id);
  const noted = !!current && !!own(current.accounts, account_id);
  // Whether the index can't say which accounts were ever recorded: it can't
  // be read, or it is missing beside a month that can't be (which it would
  // have named, with that month's accounts).
  const indexUnusable =
    index.unreadable.length > 0 || index.unrecognised.length > 0 || (!current && months.unreadable.length + months.unrecognised.length > 0);
  if (holding.length === 0 && !noted && !indexUnusable) return { changed: 0, damaged: false };
  const unrecognised = [...months.unrecognised, ...index.unrecognised];
  if (unrecognised.length > 0) {
    throw new UnreadableEntriesError(historyStore.what, [], unrecognised, new Error('holdings records this version does not recognise may hold the account'));
  }
  let changed = 0;
  for (const id of holding) {
    await historyStore.update(ctx, id, (m) => (m && holdsAccount(m, account_id) ? withoutAccount(m, account_id) : m));
    changed++;
  }
  if (noted) await indexStore.update(ctx, INDEX_ID, (i) => withoutDays(i, account_id));
  return { changed, damaged: months.unreadable.length > 0 || index.unreadable.length > 0 };
}

/**
 * The forget's second pass, at its end: the recent months again (those of
 * `now` and of a day before it), for a recording already under way when the
 * first pass began. Recordings write only months the index names, and only
 * while it can be read, so with no readable index nothing can have landed
 * since. What can't be used here was reported by the first pass.
 */
export async function forgetRecentHoldings(ctx: Ctx, account_id: string, now: number = Date.now()): Promise<{ changed: number }> {
  const index = (await indexStore.getAllReport(ctx)).entries.get(INDEX_ID);
  if (!index) return { changed: 0 };
  const recent = new Set([new Date(now).toISOString().slice(0, 7), new Date(now - DAY_MS).toISOString().slice(0, 7)]);
  let changed = 0;
  for (const [month, id] of Object.entries(index.months)) {
    if (!recent.has(month)) continue;
    let stored: HoldingsMonth | null;
    try {
      stored = await historyStore.get(ctx, id);
    } catch (err) {
      if (err instanceof StoredDataUnreadableError) continue;
      throw err;
    }
    if (!stored || !holdsAccount(stored, account_id)) continue;
    await historyStore.update(ctx, id, (m) => (m && holdsAccount(m, account_id) ? withoutAccount(m, account_id) : m));
    changed++;
  }
  if (own(index.accounts, account_id)) await indexStore.update(ctx, INDEX_ID, (i) => withoutDays(i, account_id));
  return { changed };
}

// Repairing the index

/** Whether a read failed because the index's own bytes are damaged: what
 *  repairHoldingsIndex mends, once the person confirms. */
export function indexIsDamaged(err: unknown): boolean {
  return err instanceof UnreadableEntriesError && err.unreadable.includes(INDEX_ID);
}

/**
 * Puts an index derived from the months in place of a damaged one, for a
 * person who has confirmed it: the damaged bytes hold nothing anyone can read,
 * and everything the index says is in the months, so nothing readable is lost.
 * Done in one step (MapStore.replaceUnreadable), only while the index still
 * holds the damaged bytes read, so it never replaces one that reads. Also
 * mends an index that is missing while months remain.
 *
 * Refused (StoreRefusedError, 409) when the index reads, or nothing is stored.
 * An unrecognised entry, the index or a month, is never replaced and never
 * repaired around (UnreadableEntriesError): the index derived without it could
 * leave it unreachable. A damaged month is left as it is (`damaged_months`).
 */
export async function repairHoldingsIndex(ctx: Ctx): Promise<{ months: number; damaged_months: number }> {
  const [index, months] = await Promise.all([indexStore.getAllReport(ctx), historyStore.getAllReport(ctx)]);
  const unrecognised = [...months.unrecognised, ...index.unrecognised];
  if (unrecognised.length > 0) throw new UnreadableEntriesError(historyStore.what, [], unrecognised);
  const damaged = index.unreadable.includes(INDEX_ID);
  if (index.entries.has(INDEX_ID) || (!damaged && months.entries.size === 0)) {
    throw new StoreRefusedError('Your holdings records need no repair.', 409);
  }
  const { index: derived, doubled } = deriveIndex(months.entries);
  if (doubled > 0) console.warn(`holdings-history: ${doubled} month(s) stored twice in container ${ctx.container}; each is named once`);
  // Replaced in one step; if it changed since it was read (another repair, and
  // a recording after it), what is there now is folded into instead, strictly:
  // damaged again, it is not touched.
  if (!(damaged && (await indexStore.replaceUnreadable(ctx, INDEX_ID, derived)))) {
    await indexStore.update(ctx, INDEX_ID, (current) => mergeIndexes(current, derived));
  }
  return { months: Object.keys(derived.months).length, damaged_months: months.unreadable.length };
}
