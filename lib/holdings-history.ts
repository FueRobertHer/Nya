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
// answered, so a failed call is never recorded as accounts holding nothing.
// Never from recovered or stale data (lib/last-known.ts recovers balances, and
// only for an institution whose fetch failed), and never for an institution
// whose fetch failed. An institution short an account (`unconfirmed_missing`)
// is recorded for the accounts it did return, as their balances are
// (measuredBalanceMap): a missing account is a question for the total, not for
// what the others hold.
//
// Keyed by UTC day, as the real net-worth layer is (lib/history.ts): an
// observation belongs to the UTC date of the moment it is recorded, and each
// account's latest observation of a day wins, whichever write lands last.
// Hidden accounts are recorded like every other: hiding is applied on read
// (lib/hidden.ts).
//
// Recording never throws and never holds up the net-worth snapshot it runs
// beside: a failed write is logged and counted (recordFetch returns the count,
// and the snapshot job keeps it with the day's outcome), and is never part of
// whether the snapshot was recorded.
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
//                           each account was recorded on.
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
// READ strictly (readHoldingsMonth, readHoldingsRange, readHoldingsSpan):
// nothing recorded is an empty answer, and anything the seam cannot use
// throws. Account links are followed on read, as balance history follows them
// (getAccountHistory in lib/history.ts): what an account held under an earlier
// id continues under its current one.
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
// FORGETTING an earlier account (lib/links.ts forgetEarlierAccount) removes its
// positions from every month and its days from the index
// (forgetAccountHoldings), one month at a time, so a forget that stops part way
// is finished by running it again. Deleting the person's account deletes both
// stores with the rest of the container (lib/account-deletion.ts).

import {
  defineMapStore,
  UnreadableEntriesError,
  StoredDataUnreadableError,
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

/** Where the months are, and when each account was recorded. */
export type HoldingsIndex = {
  v: 1;
  /** YYYY-MM -> the id the month is stored under. */
  months: Record<string, string>;
  /** Account id (as recorded) -> the first and last UTC dates it was
   *  recorded on. */
  accounts: Record<string, { first: string; last: string }>;
};

/** What one fetch's holdings call answered, in the shape it is recorded in
 *  (set by fetchHoldings in lib/networth.ts). */
export type HoldingsObservation = {
  /** Account id -> its positions: every investment account the balances
   *  listed (an empty list is an account seen holding nothing), and any other
   *  account a position names. */
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
/** A key from stored or provider data, looked up without reaching the
 *  prototype: a plain object answers "constructor" for a key never set. */
const own = <T>(o: Record<string, T>, key: string): T | undefined => (Object.hasOwn(o, key) ? o[key] : undefined);

function isMonthSecurity(v: unknown): v is MonthSecurity {
  return (
    isRecord(v) &&
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
  if (!isRecord(v) || v.v !== 1 || typeof v.month !== 'string' || !MONTH.test(v.month)) return false;
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
      if (!isRecord(day) || !isInstant(day.observed_at) || !Array.isArray(day.positions)) return false;
      if (!day.positions.every((p) => isStoredPosition(p, count))) return false;
    }
  }
  return true;
}

/** The shape the index is stored in. */
export function isHoldingsIndex(v: unknown): v is HoldingsIndex {
  if (!isRecord(v) || v.v !== 1 || !isRecord(v.months) || !isRecord(v.accounts)) return false;
  for (const [month, id] of Object.entries(v.months)) {
    if (!MONTH.test(month) || typeof id !== 'string' || !ENTRY_ID.test(id)) return false;
  }
  for (const span of Object.values(v.accounts)) {
    if (!isRecord(span) || typeof span.first !== 'string' || typeof span.last !== 'string') return false;
    if (!DAY.test(span.first) || !DAY.test(span.last) || span.first > span.last) return false;
  }
  return true;
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
 * recorded in. Pure, and total: it never throws, whatever the answer holds. An
 * investment account the balances listed is recorded holding nothing when no
 * position names it, so a day it held nothing reads as that and not as a day
 * it went unrecorded. A position naming no account or no security is left out:
 * it could not be put anywhere.
 */
export function observeHoldings(
  answer: { holdings?: unknown; securities?: unknown },
  accounts: readonly { account_id?: unknown; type?: unknown }[]
): HoldingsObservation {
  const described = new Map<string, HeldSecurity>();
  for (const s of Array.isArray(answer?.securities) ? answer.securities : []) {
    if (!isRecord(s) || !isKeyId(s.security_id)) continue;
    described.set(s.security_id, {
      ticker: text(s.ticker_symbol),
      name: text(s.name),
      security_type: text(s.type),
      is_cash_equivalent: typeof s.is_cash_equivalent === 'boolean' ? s.is_cash_equivalent : null,
    });
  }
  const held = new Map<string, Position[]>();
  for (const a of accounts) {
    if (isKeyId(a?.account_id) && typeof a.type === 'string' && isInvestmentType(a.type) && !held.has(a.account_id)) {
      held.set(a.account_id, []);
    }
  }
  const securities = new Map<string, HeldSecurity>();
  for (const h of Array.isArray(answer?.holdings) ? answer.holdings : []) {
    if (!isRecord(h) || !isKeyId(h.account_id) || !isKeyId(h.security_id)) continue;
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
    const list = held.get(h.account_id);
    if (list) list.push(position);
    else held.set(h.account_id, [position]);
    const s = described.get(h.security_id);
    if (s) securities.set(h.security_id, s);
  }
  return { accounts: Object.fromEntries(held), securities: Object.fromEntries(securities) };
}

/** The part of a fetched institution that recording reads (InstitutionResult
 *  in lib/networth.ts). */
export type ObservedInstitution = {
  error: string | null;
  manual?: boolean;
  accounts: readonly { account_id: string; stale?: boolean }[];
  holdings_observed?: HoldingsObservation;
};

/**
 * Everything a fetch measured, across its institutions: only those whose
 * holdings call answered in this fetch, never one with an error (its accounts
 * are empty or recovered), and never an account marked stale (recovered by
 * lib/last-known.ts), which no institution that answered should have.
 */
export function measuredHoldings(institutions: readonly ObservedInstitution[]): HoldingsObservation {
  const accounts = new Map<string, Position[]>();
  const securities = new Map<string, HeldSecurity>();
  for (const inst of institutions) {
    const seen = inst.holdings_observed;
    if (!seen || inst.error || inst.manual) continue;
    const stale = new Set(inst.accounts.filter((a) => a.stale).map((a) => a.account_id));
    for (const [id, positions] of Object.entries(seen.accounts)) {
      if (stale.has(id) || !isKeyId(id)) continue;
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

/** The index with the month claimed for `id`, unless it is claimed already
 *  (then that claim stands). */
function withMonth(index: HoldingsIndex, month: string, id: string): HoldingsIndex {
  return own(index.months, month) ? index : { ...index, months: { ...index.months, [month]: id } };
}

/**
 * The index with these accounts' first and last days moved to take in `date`,
 * read from the month as written: an account's first day is the earliest this
 * month holds it, unless an earlier one is known, so a first day whose own
 * update of the index was lost is still found while its month is the latest.
 */
function withDays(index: HoldingsIndex, month: string, id: string, written: HoldingsMonth, accounts: string[], date: string): HoldingsIndex {
  const next = withMonth(index, month, id);
  const spans = new Map(Object.entries(next.accounts));
  const dates = Object.keys(written.days).sort();
  for (const account of accounts) {
    const prev = spans.get(account);
    const firstHere = dates.find((d) => Object.hasOwn(written.days[d], account)) ?? date;
    spans.set(account, {
      first: prev && prev.first < firstHere ? prev.first : firstHere,
      last: prev && prev.last > date ? prev.last : date,
    });
  }
  return { ...next, accounts: Object.fromEntries(spans) };
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

/** Records one day's observation: the month first, then the accounts' days in
 *  the index, which so describe only what landed. */
async function recordDay(ctx: Ctx, date: string, observedAt: string, seen: HoldingsObservation): Promise<void> {
  const month = date.slice(0, 7);
  let index = await indexStore.get(ctx, INDEX_ID);
  if (!index || !own(index.months, month)) index = await claimMonth(ctx, month);
  const id = index.months[month];
  const written = await historyStore.update(ctx, id, (current) => withObservation(current, month, date, observedAt, seen));
  const accounts = Object.keys(seen.accounts);
  // Once a day for each account, not on every fetch.
  if (!written || accounts.every((a) => (own(index.accounts, a)?.last ?? '') >= date)) return;
  try {
    await indexStore.update(ctx, INDEX_ID, (current) => withDays(current ?? emptyIndex(), month, id, written, accounts, date));
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

/**
 * STRICT. Every day recorded within [from, to] (UTC dates, inclusive), oldest
 * first, with each account's positions under the id it is known by now. Empty
 * when nothing was recorded; anything stored that cannot be used throws
 * (UnreadableEntriesError naming the month ids, or the deployment's own
 * error), and never reads as empty.
 */
export async function readHoldingsRange(ctx: Ctx, from: string, to: string, opts: ReadOptions = {}): Promise<HoldingsDay[]> {
  if (!DAY.test(from) || !DAY.test(to)) throw new TypeError('holdings-history: from and to are YYYY-MM-DD dates');
  const index = await indexStore.get(ctx, INDEX_ID);
  if (!index || from > to) return [];
  const months = Object.keys(index.months)
    .filter((m) => m >= from.slice(0, 7) && m <= to.slice(0, 7))
    .sort();
  const stored = await historyStore.getMany(
    ctx,
    months.map((m) => index.months[m])
  );
  const place = placer(opts);
  const out: HoldingsDay[] = [];
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
    out.push(...viewOf(value, from, to, place));
  }
  return out;
}

/** STRICT. One month's recorded days (YYYY-MM), as readHoldingsRange. */
export async function readHoldingsMonth(ctx: Ctx, month: string, opts: ReadOptions = {}): Promise<HoldingsDay[]> {
  if (!MONTH.test(month)) throw new TypeError('holdings-history: a month is YYYY-MM');
  return readHoldingsRange(ctx, `${month}-01`, `${month}-31`, opts);
}

/**
 * STRICT. The first and last UTC dates anything was recorded on (or the
 * account asked for, following its links), from the index alone: no month is
 * read. Hidden accounts are left out as in the other readers.
 */
export async function readHoldingsSpan(ctx: Ctx, opts: ReadOptions = {}): Promise<HoldingsSpan> {
  const index = await indexStore.get(ctx, INDEX_ID);
  if (!index) return { first: null, last: null };
  const place = placer(opts);
  let first: string | null = null;
  let last: string | null = null;
  for (const [recordedAs, span] of Object.entries(index.accounts)) {
    if (!place(recordedAs)) continue;
    if (first === null || span.first < first) first = span.first;
    if (last === null || span.last > last) last = span.last;
  }
  return { first, last };
}

// Forgetting an earlier account

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes one account's positions from every month, and its days from the
 * index, for a person forgetting an earlier account (lib/links.ts
 * forgetEarlierAccount, which checks it may be forgotten). Months are changed
 * one at a time, each only if it still holds what was read (update), so a
 * forget that stops part way is finished by running it again, and positions
 * recorded meanwhile for other accounts are kept. Securities only it held go
 * with it. A month left with nothing is deleted; its place in the index stays,
 * so a later recording of that month finds it.
 *
 * A month whose bytes are damaged holds nothing anyone can read: it is left as
 * it is, and named in `unreadableMonths`, as a balance map is
 * (forgetAccountBalances in lib/history.ts). Anything else that cannot be read
 * (an intact month this code does not understand, the index, or a deployment
 * that cannot read the data) stops it, to be run again: leaving such a month
 * would keep the account, and removing it would lose the rest.
 *
 * `recent` changes only the months of `now` and of a day before it: the second
 * pass a forget makes at the end, for a recording already under way when it
 * began.
 */
export async function forgetAccountHoldings(
  ctx: Ctx,
  account_id: string,
  opts: { recent?: boolean; now?: number } = {}
): Promise<{ changed: number; unreadableMonths: string[] }> {
  const index = await indexStore.get(ctx, INDEX_ID);
  if (!index) return { changed: 0, unreadableMonths: [] };
  const now = opts.now ?? Date.now();
  const recent = new Set([new Date(now).toISOString().slice(0, 7), new Date(now - DAY_MS).toISOString().slice(0, 7)]);
  const months = Object.keys(index.months)
    .filter((m) => !opts.recent || recent.has(m))
    .sort();
  let changed = 0;
  const unreadableMonths: string[] = [];
  for (const month of months) {
    const id = index.months[month];
    let stored: HoldingsMonth | null;
    try {
      stored = await historyStore.get(ctx, id);
    } catch (err) {
      if (err instanceof UnreadableEntriesError && err.unreadable.includes(id)) {
        unreadableMonths.push(month);
        continue;
      }
      throw err;
    }
    if (!stored || !holdsAccount(stored, account_id)) continue;
    await historyStore.update(ctx, id, (current) =>
      current && holdsAccount(current, account_id) ? withoutAccount(current, account_id) : current
    );
    changed++;
  }
  if (own(index.accounts, account_id)) {
    await indexStore.update(ctx, INDEX_ID, (current) => {
      if (!current || !own(current.accounts, account_id)) return current;
      const accounts = Object.fromEntries(Object.entries(current.accounts).filter(([id]) => id !== account_id));
      return { ...current, accounts };
    });
  }
  return { changed, unreadableMonths };
}
