// lib/api-read.ts
//
// The read-only API's read layer: what /api/v1 (app/api/v1) and the MCP server
// (lib/mcp.ts) answer with. Both call these functions and add nothing of
// their own, so a REST endpoint and an MCP tool asked the same question answer
// it alike. The shapes are the API's, documented on the developer page
// (app/developers) field by field; version 1 only ever gains fields.
//
// STORED DATA ONLY. Nothing here calls Plaid: no cost per call and no pressure
// on Plaid's rate limits, the rule sharing keeps too (lib/sharing.ts). A
// linked account's balance is its newest measured one, as the person's own
// loads and the nightly snapshot recorded it (latestMeasuredBalances in
// lib/history.ts), never an estimate; transactions are what the last sync
// stored (lib/transactions.ts storedItemTransactions). Each says what it is as
// of: a balance its day (and moment, when known), an institution's
// transactions when they were last synced, a connection when it last answered.
//
// THE APP'S OWN RULES. Transactions come from the Activity tab's own assembly
// (lib/activity.ts): the person's categories and merchant names applied,
// categories and exclusions carried across a re-link, the rows entered on
// manual accounts merged in, the last LOOKBACK_DAYS of them. Every total of
// spending or income goes through countsInTotals (lib/spending.ts, by way of
// lib/totals.ts): one currency per total, what the person excluded left out,
// transfers, cash withdrawals and loan payments left out (a bank's fees count),
// and what was left out named.
//
// CONNECTIONS WITHOUT TRANSACTIONS (lib/item-products.ts: investment accounts
// only, no bank account or card, or a bank account or card whose transactions
// Plaid doesn't provide or the person didn't allow) are named in each answer
// built on transactions (sources[].no_transactions), and its notes say what
// they leave out, in the words the app's views use (lib/no-transactions.ts),
// so an empty list or a zero is never passed off as no spending.
//
// NEVER SHORT WITHOUT SAYING SO. What can't be read is named, and the rest
// answered: accounts and net worth list the connections and manual accounts
// they couldn't include (missing_accounts) and say complete: false; a
// per-account history reads only that account's records; an account_id no
// account has is a 404 (NotFound), never an empty series.
//
// HIDDEN ACCOUNTS are left out unless asked for (`includeHidden`), everywhere:
// accounts, balances, transactions, totals, history (subtracted from net
// worth, as the chart subtracts them) and holdings.
//
// READ ONLY. Nothing here writes: each read that could tidy as it goes is
// asked not to (readOnly).
//
// SIGNS are Plaid's, as everywhere in Nya: a transaction's positive amount is
// money leaving the account; a credit card's or a loan's balance is the
// positive amount owed.

import type { Ctx } from './containers';
import { getContainer } from './containers';
import { getItems, type StoredItem } from './storage';
import { getEffectiveHidden, sameAccountIds, type Link } from './links';
import type { HiddenMap } from './hidden';
import { rememberedAccountsReport, type RememberedAccount } from './last-known';
import { latestMeasuredBalances, snapshotTakenAt, getHistory, getAccountHistory, type HistoryPoint } from './history';
import { getManualAccountsReport, manualAccountExists, isManualId, toInstitutions, MANUAL_CURRENCY } from './manual';
import { bankCurrencies } from './sharing';
import { readHealthForDisplay } from './connection-health';
import { noticesStore } from './connection-records';
import { warningLapsed, type HealthState } from './connection-state';
import { assembleBankRows, finishActivity, type BankSource } from './activity';
import type { NoTransactionsReason } from './item-products';
import { missingEmptyNotes, missingFigureNotes, noSpending, withoutNote, noTransactionsView, type NoTransactionsView } from './no-transactions';
import { getBudgets } from './budgets';
import { detectRecurring, upcomingBills, type RecurringBill } from './recurring';
import { currencyOf, isTransfer, leftOutByCurrency, leftOutText, totalsCurrency, type LeftOut } from './spending';
import { spendingByCategory, summarize, tidy, categoryOf, type Summary } from './totals';
import { readHoldingsSpan, readHoldingsRange } from './holdings-history';
import { isInvestmentType, isOwedType } from './balance';
import { dominantCurrency } from './format';
import { LOOKBACK_DAYS, type Txn } from './transactions';
import { API_VERSION, RATE_WINDOW_SECONDS, REQUESTS_PER_MINUTE, TOKEN_PREFIX } from './api-limits';
import type { Authenticated } from './api-tokens';
import { NotFound } from './api-spec';

const DAY_MS = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The first day the transactions read here cover: the app's own window. */
export const firstDay = (now: number = Date.now()) => utcDay(now - LOOKBACK_DAYS * DAY_MS);

/** An instant a record holds, unless it is the stand-in a reader puts where a
 *  record had none (lib/manual.ts writes 1970-01-01). */
const realTime = (iso: string | null | undefined): string | null => (iso && Date.parse(iso) > 0 ? iso : null);

// ---- Me ----

export type ApiMe = {
  api_version: string;
  /** The token this request was made with, as the API tokens card lists it. */
  token: { label: string; hint: string; created_at: string; last_used_at: string | null };
  /** When this person's data in Nya began (their container was made). */
  data_since: string | null;
  rate_limit: { requests: number; per_seconds: number };
};

/** Container-level facts only: never a sign-in id or an email address. */
export async function readMe(auth: Authenticated): Promise<ApiMe> {
  const record = await getContainer(auth.ctx.container);
  return {
    api_version: API_VERSION,
    token: { label: auth.token.label, hint: `${TOKEN_PREFIX}${auth.id.slice(0, 8)}`, created_at: auth.token.created_at, last_used_at: auth.token.last_used_at },
    data_since: record?.created_at ?? null,
    rate_limit: { requests: REQUESTS_PER_MINUTE, per_seconds: RATE_WINDOW_SECONDS },
  };
}

// ---- Accounts ----

/** What is known of a linked account's bank connection, from what Nya
 *  recorded (lib/connection-health.ts), never a fresh check. */
export type ApiConnection = {
  /** When Nya last reached the bank for it without an error (the app's own
   *  loads, and the nightly snapshot, which tries every connection once a
   *  day), or null if never recorded. */
  last_ok_at: string | null;
  /** What the daily check last found wrong with it, while that lasts, or
   *  null for nothing recorded. A connection that hasn't answered in a day or
   *  more may not be working even with none. */
  problem: { state: HealthState; since: string } | null;
  /** When Plaid has warned the connection will end (reconnect before then),
   *  or null. */
  ends_at: string | null;
  /** Some of what Nya keeps about this connection couldn't be read, so a
   *  problem or a warning may be missing from this. */
  records_unreadable?: true;
};

export type ApiAccount = {
  id: string;
  /** 'plaid' for a linked account, 'manual' for one tracked by hand. Version
   *  1 may add values (another way to connect): treat one you don't know as
   *  neither. */
  source: string;
  name: string;
  official_name: string | null;
  institution: string;
  type: string;
  subtype: string | null;
  mask: string | null;
  /** Plaid's sign: what a credit card or a loan owes is positive. Null when
   *  no balance was ever measured. */
  balance: number | null;
  currency: string | null;
  credit_limit: number | null;
  /** A credit card or a loan: its balance is owed, and subtracts from net worth. */
  is_debt: boolean;
  hidden: boolean;
  /** The UTC day the balance was measured, or null with no balance. */
  as_of: string | null;
  /** The moment, where it is known. */
  as_of_time: string | null;
  /** Null for a manual account. */
  connection: ApiConnection | null;
};

/** An account, or a connection's accounts, that an answer couldn't include
 *  (see AccountsRead). */
export type ApiMissing = {
  /** The connection's institution; null for a manual account, whose name is
   *  in what couldn't be read. */
  institution: string | null;
  /** A manual account's id; null for a connection, whose accounts can't be
   *  told apart until they are read. */
  account_id: string | null;
  /** 'unreadable': stored, and couldn't be read. 'not_loaded': a connection
   *  whose accounts the app hasn't loaded yet. Version 1 may add reasons. */
  reason: 'unreadable' | 'not_loaded';
};

/** The accounts, and what couldn't be included, named (`missing`): never a
 *  shorter list passed off as whole (an answer built on it says complete:
 *  false). */
type AccountsRead = { accounts: ApiAccount[]; missing: ApiMissing[]; notes: string[]; hidden: HiddenMap; links: Map<string, Link> };

/** The connection facts for each Item, from the records health keeps. */
async function connectionFacts(ctx: Ctx): Promise<{ of: (item_id: string) => ApiConnection; note: string | null }> {
  const [health, notices] = await Promise.all([
    readHealthForDisplay(ctx),
    // A display read that nothing writes, deletes or records on: what can't be
    // used is left out, and the connection says its records couldn't be read.
    noticesStore.getAllReport(ctx).catch(() => null),
  ]);
  const unread = new Set([...(health?.unread ?? []), ...(notices?.unreadable ?? []), ...(notices?.unrecognised ?? [])]);
  return {
    note: health === null || notices === null ? 'How each bank connection is doing couldn’t be read, so what is said of each may be missing something' : null,
    of: (item_id) => {
      const last = health?.syncs.get(item_id)?.at ?? null;
      const warning = health?.warnings.get(item_id) ?? null;
      const notice = notices?.entries.get(item_id) ?? null;
      return {
        last_ok_at: last,
        problem: notice && notice.state !== 'healthy' ? { state: notice.state, since: notice.since } : null,
        ends_at: warning && !warningLapsed(warning, last, null) ? warning.ends_at : null,
        ...(health === null || notices === null || unread.has(item_id) ? { records_unreadable: true as const } : {}),
      };
    },
  };
}

async function accountsRead(ctx: Ctx, includeHidden: boolean): Promise<AccountsRead> {
  const [items, remembered, effective, manual, facts] = await Promise.all([
    getItems(ctx),
    rememberedAccountsReport(ctx),
    // Strict: a hidden account must never show for a read that failed.
    getEffectiveHidden(ctx, { readOnly: true }),
    // LENIENT, for this display only: an account that can't be read is named
    // in `missing`, and the others listed; recording a snapshot reads them all
    // strictly (lib/networth.ts). Storage out of reach still throws.
    getManualAccountsReport(ctx),
    connectionFacts(ctx),
  ]);
  const notes: string[] = [];
  const missing: ApiMissing[] = [];
  const { hidden } = effective;
  const links = effective.links ?? new Map<string, Link>();
  const unreadable = new Set(remembered.unreadable);

  // Each stored Item's accounts, as its last good load recorded them.
  const linked: { item: StoredItem; account: RememberedAccount }[] = [];
  for (const item of items) {
    if (unreadable.has(item.item_id)) {
      notes.push(`${item.institution_name}: its accounts couldn’t be read, so they aren’t listed`);
      missing.push({ institution: item.institution_name, account_id: null, reason: 'unreadable' });
      continue;
    }
    const accounts = remembered.byItem[item.item_id];
    if (!accounts) {
      notes.push(`${item.institution_name}: its accounts haven’t been loaded yet; open the app to load them`);
      missing.push({ institution: item.institution_name, account_id: null, reason: 'not_loaded' });
      continue;
    }
    for (const account of accounts) {
      if (includeHidden || !hidden.has(account.account_id)) linked.push({ item, account });
    }
  }
  const ids = new Map(linked.map(({ account }) => [account.account_id, sameAccountIds(account.account_id, links)]));
  const [balances, currencies] = await Promise.all([latestMeasuredBalances(ctx, ids), bankCurrencies(ctx, [...ids.keys()], remembered.byItem)]);
  // The moment behind each recorded day, where the snapshot kept it; only an
  // instant inside that UTC day is that snapshot's (lib/last-known.ts).
  const takenAt = new Map<string, string | null>();
  await Promise.all(
    [...new Set([...balances.values()].filter((b) => b.layer === 'recorded').map((b) => b.date))].map(async (date) => {
      const at = await snapshotTakenAt(ctx, date);
      takenAt.set(date, at && at.slice(0, 10) === date ? at : null);
    })
  );
  if (facts.note) notes.push(facts.note);

  const accounts: ApiAccount[] = linked.map(({ item, account }) => {
    const b = balances.get(account.account_id) ?? null;
    return {
      id: account.account_id,
      source: 'plaid',
      name: account.name,
      official_name: account.official_name,
      institution: item.institution_name,
      type: account.type,
      subtype: account.subtype,
      mask: account.mask,
      balance: b?.value ?? null,
      currency: currencies.get(account.account_id) ?? null,
      credit_limit: account.limit,
      is_debt: isOwedType(account.type),
      hidden: hidden.has(account.account_id),
      as_of: b?.date ?? null,
      as_of_time: b?.layer === 'recorded' ? (takenAt.get(b.date) ?? null) : null,
      connection: facts.of(item.item_id),
    };
  });

  // A hidden one is left out either way: nothing missing from what was asked.
  const unreadableManual = manual.unreadable.filter((id) => includeHidden || !hidden.has(id));
  for (const id of unreadableManual) missing.push({ institution: null, account_id: id, reason: 'unreadable' });
  if (unreadableManual.length > 0) {
    const one = unreadableManual.length === 1;
    notes.push(`${one ? 'A manual account' : `${unreadableManual.length} manual accounts`} couldn’t be read, so ${one ? 'it isn’t' : 'they aren’t'} listed`);
  }
  for (const inst of toInstitutions(manual.accounts)) {
    for (const a of inst.accounts) {
      if (!includeHidden && hidden.has(a.account_id)) continue;
      const at = realTime(a.updated_at);
      accounts.push({
        id: a.account_id,
        source: 'manual',
        name: a.name,
        official_name: null,
        institution: inst.institution_name,
        type: a.type,
        subtype: a.subtype,
        mask: null,
        balance: a.balance,
        // The only currency a manual balance is kept in (lib/manual.ts).
        currency: a.currency,
        credit_limit: null,
        is_debt: isOwedType(a.type),
        hidden: hidden.has(a.account_id),
        as_of: at ? at.slice(0, 10) : null,
        as_of_time: at,
        connection: null,
      });
    }
  }
  const byText = (a: string, b: string) => a.localeCompare(b);
  accounts.sort((a, b) => byText(a.institution, b.institution) || byText(a.name, b.name) || byText(a.id, b.id));
  return { accounts, missing, notes, hidden, links };
}

export type ApiAccounts = {
  accounts: ApiAccount[];
  /** False when accounts are missing from the list (missing_accounts). */
  complete: boolean;
  missing_accounts: ApiMissing[];
  notes: string[];
};

/** Every account: linked and manual, with its newest measured balance and as
 *  of when. Hidden ones only with `includeHidden`. */
export async function readAccounts(ctx: Ctx, opts: { includeHidden?: boolean } = {}): Promise<ApiAccounts> {
  const { accounts, missing, notes } = await accountsRead(ctx, !!opts.includeHidden);
  return { accounts, complete: missing.length === 0, missing_accounts: missing, notes };
}

// ---- Net worth ----

export type ApiNetWorth = {
  /** One total per currency, most accounts first: nothing is converted. An
   *  account whose currency isn't known is counted in the main one, as the
   *  app shows it. */
  totals: { currency: string | null; net_worth: number; assets: number; debts: number; accounts: number }[];
  /** The oldest and newest day among the balances counted: they are each an
   *  account's newest measured balance, and can be from different days. */
  balances_from: string | null;
  balances_to: string | null;
  /** Accounts left out of the totals for having no measured balance. */
  accounts_without_balance: number;
  /** False when the totals leave accounts out: ones that couldn't be read or
   *  haven't been loaded (missing_accounts), or have no measured balance
   *  (accounts_without_balance). A total is never passed off as whole. */
  complete: boolean;
  missing_accounts: ApiMissing[];
  /** The newest net worth recorded in history (what the chart's last recorded
   *  point is), which adds every account's balance whatever its currency, as
   *  the chart does: see mixed_currencies. */
  recorded: { date: string; value: number; currency: string | null; mixed_currencies: boolean } | null;
  notes: string[];
};

/** What net worth, now and over time, is built from, read once: the
 *  accounts, and the recorded history with hidden accounts subtracted (as the
 *  chart subtracts them) unless they are asked for. */
type NetWorthRead = { read: AccountsRead; history: HistoryPoint[] };

async function netWorthRead(ctx: Ctx, includeHidden: boolean): Promise<NetWorthRead> {
  const read = await accountsRead(ctx, includeHidden);
  const history = await getHistory(ctx, includeHidden ? undefined : read.hidden);
  return { read, history };
}

/** The currency net worth is labelled with, and whether the accounts mix
 *  several (the recorded totals add them unconverted, as the chart does). */
function netWorthCurrency(accounts: readonly ApiAccount[]): { currency: string | null; mixed: boolean } {
  return {
    currency: dominantCurrency(accounts.map((a) => ({ iso_currency_code: a.currency }))),
    mixed: new Set(accounts.map((a) => a.currency).filter(Boolean)).size > 1,
  };
}

function netWorthOf({ read, history }: NetWorthRead): ApiNetWorth {
  const { currency: main, mixed } = netWorthCurrency(read.accounts);
  const totals = new Map<string | null, { currency: string | null; net_worth: number; assets: number; debts: number; accounts: number }>();
  let without = 0;
  const days: string[] = [];
  for (const a of read.accounts) {
    if (a.balance === null) {
      without++;
      continue;
    }
    const c = a.currency ?? main;
    const t = totals.get(c) ?? { currency: c, net_worth: 0, assets: 0, debts: 0, accounts: 0 };
    if (a.is_debt) t.debts += a.balance;
    else t.assets += a.balance;
    t.accounts++;
    totals.set(c, t);
    if (a.as_of) days.push(a.as_of);
  }
  days.sort();
  const last = [...history].reverse().find((p) => !p.estimated) ?? null;
  return {
    totals: [...totals.values()]
      .map((t) => ({ ...t, assets: tidy(t.assets), debts: tidy(t.debts), net_worth: tidy(t.assets - t.debts) }))
      .sort((a, b) => b.accounts - a.accounts || String(a.currency).localeCompare(String(b.currency))),
    balances_from: days[0] ?? null,
    balances_to: days[days.length - 1] ?? null,
    accounts_without_balance: without,
    complete: read.missing.length === 0 && without === 0,
    missing_accounts: read.missing,
    recorded: last ? { date: last.date, value: tidy(last.value), currency: main, mixed_currencies: mixed } : null,
    notes: read.notes,
  };
}

/** Net worth now, from each account's newest measured balance, per currency,
 *  and the newest recorded point of its history. */
export async function readNetWorth(ctx: Ctx, opts: { includeHidden?: boolean } = {}): Promise<ApiNetWorth> {
  return netWorthOf(await netWorthRead(ctx, !!opts.includeHidden));
}

// ---- Balance history ----

export type Interval = 'day' | 'week' | 'month';

/** The Monday of the UTC week a day falls in. */
function weekOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return utcDay(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS);
}

/** One point per period, the last of each (points oldest first), so a long
 *  history fits a page or a model's context; 'day' is every point. */
export function sampleSeries<T extends { date: string }>(points: readonly T[], interval: Interval): T[] {
  if (interval === 'day') return [...points];
  const period = interval === 'month' ? (d: string) => d.slice(0, 7) : weekOf;
  const out: T[] = [];
  for (let i = 0; i < points.length; i++) {
    const next = points[i + 1];
    if (!next || period(next.date) !== period(points[i].date)) out.push(points[i]);
  }
  return out;
}

export type ApiHistory = {
  /** The account asked for, or null for net worth. */
  account_id: string | null;
  currency: string | null;
  /** Net worth's recorded totals add balances in every currency, as the chart
   *  does: true when the accounts counted are in more than one. */
  mixed_currencies: boolean;
  interval: Interval;
  /** Oldest first. `estimated` is true for a point reconstructed from
   *  transactions rather than recorded (only with include_estimated). */
  points: { date: string; value: number; estimated: boolean }[];
  notes: string[];
};

export type HistoryQuery = { accountId?: string; from?: string; to?: string; includeEstimated?: boolean; includeHidden?: boolean; interval?: Interval };

/** A series as answered: recorded points only unless estimated ones are
 *  asked for, in [from, to], one point per interval. */
function seriesOf(points: readonly HistoryPoint[], q: HistoryQuery, head: { account_id: string | null; currency: string | null; mixed: boolean }, notes: string[]): ApiHistory {
  const interval = q.interval ?? 'day';
  const kept = points.filter(
    (p) => (q.includeEstimated || !p.estimated) && (q.from === undefined || p.date >= q.from) && (q.to === undefined || p.date <= q.to)
  );
  return {
    account_id: head.account_id,
    currency: head.currency,
    mixed_currencies: head.mixed,
    interval,
    points: sampleSeries(kept, interval).map((p) => ({ date: p.date, value: tidy(p.value), estimated: !!p.estimated })),
    notes,
  };
}

/** Net worth's history from a read already made. */
function netWorthHistoryOf(nw: NetWorthRead, q: HistoryQuery): ApiHistory {
  const { currency, mixed } = netWorthCurrency(nw.read.accounts);
  return seriesOf(nw.history, q, { account_id: null, currency, mixed }, []);
}

/**
 * One account's history (linked or manual, by its current id or an earlier
 * one), reading only what that account needs: a damaged record of another
 * account never fails it. Null for a hidden account when hidden ones aren't
 * asked for; NotFound for an id that names no account Nya has or had.
 */
async function accountHistory(ctx: Ctx, id: string, q: HistoryQuery): Promise<ApiHistory | null> {
  const effective = await getEffectiveHidden(ctx, { readOnly: true });
  if (!q.includeHidden && effective.hidden.has(id)) return null;
  const links = effective.links ?? new Map<string, Link>();
  const older = sameAccountIds(id, links).filter((other) => other !== id);
  const points = await getAccountHistory(ctx, id, older);
  const notes: string[] = [];
  let known = links.has(id) || [...links.values()].some((l) => l.to === id);
  let currency: string | null = null;
  if (isManualId(id)) {
    // Whether it is there, without reading it: its currency is the one every
    // manual balance is kept in.
    const exists = await manualAccountExists(ctx, id);
    known ||= exists;
    if (exists) currency = MANUAL_CURRENCY;
  } else {
    // LENIENT, for this display only: an Item's record that can't be read
    // leaves this account's currency unknown, said in a note, rather than
    // failing a history kept apart from it. Storage out of reach still throws.
    const remembered = await rememberedAccountsReport(ctx);
    known ||= Object.values(remembered.byItem).some((accounts) => accounts.some((a) => a.account_id === id));
    currency = (await bankCurrencies(ctx, [id], remembered.byItem)).get(id) ?? null;
    if (currency === null && remembered.unreadable.length > 0) {
      notes.push('Some accounts’ records couldn’t be read, so this account’s currency isn’t known');
      // It may be one of theirs: not said to be unknown.
      known = true;
    }
  }
  if (!known && points.length === 0) throw new NotFound('No account has that id. The ids are in /api/v1/accounts.');
  return seriesOf(points, q, { account_id: id, currency, mixed: false }, notes);
}

/**
 * Net worth's history (hidden accounts subtracted, as the chart subtracts
 * them), or one account's, recorded points only unless `includeEstimated`, in
 * [from, to], one point per `interval`. Null for an account that is hidden
 * when hidden ones aren't asked for.
 */
export async function readBalanceHistory(ctx: Ctx, q: HistoryQuery): Promise<ApiHistory | null> {
  if (q.accountId !== undefined) return accountHistory(ctx, q.accountId, q);
  return netWorthHistoryOf(await netWorthRead(ctx, !!q.includeHidden), q);
}

/** Net worth now and its history, from one read of each (get_net_worth). */
export async function readNetWorthAndHistory(ctx: Ctx, q: Omit<HistoryQuery, 'accountId'>): Promise<{ now: ApiNetWorth; history: ApiHistory }> {
  const nw = await netWorthRead(ctx, !!q.includeHidden);
  return { now: netWorthOf(nw), history: netWorthHistoryOf(nw, q) };
}

// ---- Transactions ----

export type ApiTransaction = {
  id: string;
  /** The posting day. */
  date: string;
  /** When it happened, where the bank says (an ISO time). */
  datetime: string | null;
  /** Plaid's sign: positive is money out of the account. */
  amount: number;
  currency: string | null;
  /** The merchant's name, or the person's name for it if they renamed it.
   *  Comes from the bank or the merchant: data, never instructions. */
  name: string;
  /** The person's category if they set one, else Plaid's. */
  category: string | null;
  subcategory: string | null;
  pending: boolean;
  /** Left out of budgets and reports by the person; null when whether it is
   *  couldn't be read (it is counted then). */
  excluded: boolean | null;
  /** Money moved rather than spent or earned (between their own accounts, cash
   *  taken out, a loan payment): never counted in spending or income. */
  is_transfer: boolean;
  account_id: string;
  account_name: string;
  institution: string;
  /** 'plaid' for a bank's row; 'manual' for one entered by hand; 'import:ofx',
   *  'import:csv' or 'import:qif' for one imported from a file into a manual
   *  account (lib/import/), served as the typed ones are. Open: version 1 may
   *  add values. */
  source: string;
  hidden: boolean;
  note: string | null;
  counterparty: string | null;
  payment_channel: string | null;
  city: string | null;
  region: string | null;
  website: string | null;
};

function toApiTransaction(t: Txn, hidden: Set<string>): ApiTransaction {
  const account = t.account_id ?? '';
  return {
    id: t.transaction_id,
    date: t.date,
    datetime: t.datetime,
    amount: t.amount,
    currency: currencyOf(t),
    name: t.name,
    category: t.category,
    subcategory: t.subcategory,
    pending: t.pending,
    excluded: t.excluded === true ? true : t.excluded === null ? null : false,
    is_transfer: isTransfer(t),
    account_id: account,
    account_name: t.account_name,
    institution: t.institution_name,
    source: t.source ?? 'plaid',
    hidden: hidden.has(account),
    note: t.note ?? null,
    counterparty: t.counterparty,
    payment_channel: t.payment_channel,
    city: t.city,
    region: t.region,
    website: t.website,
  };
}

/** Where an institution's transactions come from, and as of when; or why it
 *  brings in none (lib/item-products.ts). */
export type ApiSource = { institution: string; synced_at: string | null; complete: boolean; no_transactions: NoTransactionsReason | null };

type ActivityRead = { rows: Txn[]; notes: string[]; sources: ApiSource[]; hidden: Set<string>; view: NoTransactionsView };

/** The Activity tab's rows, as stored (lib/activity.ts), never syncing, with
 *  the connections that bring in none, as the app's views weigh them
 *  (lib/no-transactions.ts). */
async function readActivity(ctx: Ctx, includeHidden: boolean): Promise<ActivityRead> {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, includeHidden, withAccountIds: true });
  const { transactions, notes } = await finishActivity(ctx, bank.payload, includeHidden ? new Set() : bank.hidden);
  return {
    rows: transactions,
    notes,
    sources: bank.sources.map((s: BankSource) => ({
      institution: s.institution_name,
      synced_at: s.synced_at,
      complete: s.coverage === 'complete',
      no_transactions: s.no_transactions,
    })),
    hidden: bank.hidden,
    view: noTransactionsView(bank.payload),
  };
}

/**
 * What an answer built on transactions says of the connections that bring in
 * none, in the words the app's views use (lib/no-transactions.ts), so an empty
 * list or a zero is never passed off as no spending: when none brings any in
 * and no row came from anywhere else, what is true of them and what would
 * bring some in; when only rows entered by hand came in, the connections that
 * hold no bank account or card; and each bank account or card whose
 * transactions don't come in (Plaid doesn't provide them, or the person
 * didn't allow them), as missing from a `list` or not counted in `totals`.
 */
function withoutTransactionsNotes(view: NoTransactionsView, rows: number, kind: 'list' | 'totals'): string[] {
  const none = noSpending(view, rows);
  if (none) return [`${none.lead}, so no bank or card transactions come in. To see spending, ${none.remedy}.`];
  const named = withoutNote(view, rows);
  return [...(named ? [named] : []), ...(kind === 'list' ? missingEmptyNotes(view) : missingFigureNotes(view, 'uncounted'))];
}

/** Where a page ends: the order is the newest day first, then the latest
 *  moment, then the id, so it is total and a page never repeats or skips a
 *  row when another is added. */
export type PageKey = { date: string; datetime: string; id: string };

const keyOf = (t: ApiTransaction): PageKey => ({ date: t.date, datetime: t.datetime ?? '', id: t.id });
/** Negative when `a` comes first. */
export function comparePageKeys(a: PageKey, b: PageKey): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  if (a.datetime !== b.datetime) return a.datetime < b.datetime ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export type TransactionQuery = {
  /** Inclusive UTC days. */
  from: string;
  to: string;
  accountIds?: ReadonlySet<string>;
  includeHidden?: boolean;
  /** Matched, in any case, against the name, the merchant behind it, the
   *  category and the note. */
  text?: string;
  /** A category as listed (categories), 'other' for none. */
  category?: string;
  /** On the signed amount, Plaid's sign: inclusive. */
  minAmount?: number;
  maxAmount?: number;
  limit: number;
  /** The last row of the page before. */
  after?: PageKey | null;
};

export type ApiTransactionPage = {
  from: string;
  to: string;
  transactions: ApiTransaction[];
  /** The key the next page starts after, or null for the last page. */
  next: PageKey | null;
  sources: ApiSource[];
  notes: string[];
};

/** One page of transactions, newest first, matching the query. */
export async function queryTransactions(ctx: Ctx, q: TransactionQuery): Promise<ApiTransactionPage> {
  const activity = await readActivity(ctx, !!q.includeHidden);
  const text = q.text?.toLowerCase();
  const category = q.category?.toLowerCase();
  const matching = activity.rows
    .filter((t) => t.date >= q.from && t.date <= q.to)
    .filter((t) => !q.accountIds || q.accountIds.has(t.account_id ?? ''))
    .filter((t) => category === undefined || categoryOf(t).toLowerCase() === category)
    .filter((t) => (q.minAmount === undefined || t.amount >= q.minAmount) && (q.maxAmount === undefined || t.amount <= q.maxAmount))
    .filter((t) => !text || [t.name, t.counterparty, t.category, t.subcategory, t.note].some((f) => typeof f === 'string' && f.toLowerCase().includes(text)))
    .map((t) => toApiTransaction(t, activity.hidden))
    .sort((a, b) => comparePageKeys(keyOf(a), keyOf(b)));
  const start = q.after ? matching.findIndex((t) => comparePageKeys(keyOf(t), q.after!) > 0) : 0;
  const rest = start < 0 ? [] : matching.slice(start);
  const page = rest.slice(0, q.limit);
  return {
    from: q.from,
    to: q.to,
    transactions: page,
    next: rest.length > q.limit ? keyOf(page[page.length - 1]) : null,
    sources: activity.sources,
    notes: [...activity.notes, ...withoutTransactionsNotes(activity.view, activity.rows.length, 'list')],
  };
}

// ---- Categories ----

export type ApiCategory = {
  name: string;
  /** Transactions in it, in the window the API reads. */
  transactions: number;
  last_date: string | null;
  /** A monthly budget is set for it. */
  budgeted: boolean;
  /** Its transactions are transfers (or loan payments): never counted in
   *  spending or income. */
  transfer: boolean;
};

/** The categories in use: on transactions in the window, or with a budget. */
export async function readCategories(ctx: Ctx, opts: { includeHidden?: boolean } = {}): Promise<{ from: string; categories: ApiCategory[]; sources: ApiSource[]; notes: string[] }> {
  const [activity, budgets] = await Promise.all([
    readActivity(ctx, !!opts.includeHidden),
    getBudgets(ctx).then(
      (b) => ({ ok: true as const, b }),
      () => ({ ok: false as const })
    ),
  ]);
  const seen = new Map<string, { transactions: number; last_date: string | null }>();
  for (const t of activity.rows) {
    const c = seen.get(categoryOf(t)) ?? { transactions: 0, last_date: null };
    c.transactions++;
    if (!c.last_date || t.date > c.last_date) c.last_date = t.date;
    seen.set(categoryOf(t), c);
  }
  const budgeted = new Set(budgets.ok ? Object.keys(budgets.b) : []);
  for (const name of budgeted) if (!seen.has(name)) seen.set(name, { transactions: 0, last_date: null });
  const notes = [
    ...activity.notes,
    ...(budgets.ok ? [] : ['Budgets: couldn’t be read, so which categories have one isn’t said']),
    ...withoutTransactionsNotes(activity.view, activity.rows.length, 'list'),
  ];
  return {
    from: firstDay(),
    categories: [...seen]
      .map(([name, c]) => ({ name, ...c, budgeted: budgeted.has(name), transfer: isTransfer({ category: name, transaction_code: null }) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    sources: activity.sources,
    notes,
  };
}

// ---- Budgets ----

export type ApiBudgets = {
  month: string;
  /** The currency the budgets count, and are in: the one most transactions
   *  are in, as the app's. */
  currency: string | null;
  budgets: { category: string; budget: number; spent: number; remaining: number; spent_share: number }[];
  total: { budget: number; spent: number };
  /** This month's spending left out for being in another currency. */
  left_out: LeftOut;
  left_out_text: string | null;
  /** This month's transactions the person excluded (left out), and those
   *  whether they did couldn't be read (counted). */
  excluded: number;
  exclusion_unknown: number;
  sources: ApiSource[];
  notes: string[];
};

/** Monthly budgets with the month's spending against each, as the Budgets
 *  tab works it out (lib/totals.ts spendingByCategory). */
export async function readBudgets(ctx: Ctx, opts: { month: string; includeHidden?: boolean }): Promise<ApiBudgets> {
  const [budgets, activity] = await Promise.all([getBudgets(ctx), readActivity(ctx, !!opts.includeHidden)]);
  const currency = totalsCurrency(activity.rows);
  const inMonth = (date: string) => date.slice(0, 7) === opts.month;
  const spent = spendingByCategory(activity.rows, inMonth, currency);
  const monthRows = activity.rows.filter((t) => inMonth(t.date));
  const leftOut = leftOutByCurrency(monthRows.filter((t) => t.amount > 0), currency);
  const rows = Object.entries(budgets)
    .map(([category, budget]) => {
      const s = spent[category] ?? 0;
      return { category, budget, spent: tidy(s), remaining: tidy(budget - s), spent_share: budget > 0 ? Math.round((s / budget) * 1000) / 1000 : 0 };
    })
    .sort((a, b) => a.category.localeCompare(b.category));
  const notes = [...activity.notes, ...withoutTransactionsNotes(activity.view, activity.rows.length, 'totals')];
  const cutoff = firstDay();
  if (`${opts.month}-01` < cutoff) notes.push(`Only transactions from ${cutoff} on are read, so this month's spending may be short`);
  return {
    month: opts.month,
    currency,
    budgets: rows,
    total: { budget: tidy(rows.reduce((n, r) => n + r.budget, 0)), spent: tidy(rows.reduce((n, r) => n + (spent[r.category] ?? 0), 0)) },
    left_out: leftOut,
    left_out_text: leftOutText(leftOut, currency, { where: 'these budgets' }),
    excluded: monthRows.filter((t) => t.excluded === true).length,
    exclusion_unknown: monthRows.filter((t) => t.excluded === null).length,
    sources: activity.sources,
    notes,
  };
}

// ---- Spending ----

export type ApiSpending = Summary & { from: string; to: string; sources: ApiSource[]; notes: string[] };

/** Money in and out over [from, to], and spending by category, in one
 *  currency: by default the one most transactions are in, as the app's
 *  totals. */
export async function readSpending(ctx: Ctx, opts: { from: string; to: string; currency?: string; includeHidden?: boolean }): Promise<ApiSpending> {
  const activity = await readActivity(ctx, !!opts.includeHidden);
  const currency = opts.currency ?? totalsCurrency(activity.rows);
  const notes = [...activity.notes, ...withoutTransactionsNotes(activity.view, activity.rows.length, 'totals')];
  if (opts.from < firstDay()) notes.push(`Only transactions from ${firstDay()} on are read`);
  return {
    from: opts.from,
    to: opts.to,
    ...summarize(activity.rows, (d) => d >= opts.from && d <= opts.to, currency),
    sources: activity.sources,
    notes,
  };
}

// ---- Recurring bills ----
//
// The one place the API reads lib/recurring.ts: what it detects becomes the
// API's shape here and nowhere else, so a change to the detection changes
// this section alone.

export type ApiRecurring = {
  /** Detected from the transactions (a merchant charging about monthly at a
   *  steady amount): an estimate, as is each next date. */
  bills: { name: string; institution: string; amount: number; currency: string | null; last_date: string; next_date: string; due_soon: boolean }[];
  /** What the bills come to in a month, in the budgets' currency, and the
   *  bills left out of it for being in another. */
  monthly_total: { currency: string | null; amount: number; left_out: LeftOut };
  /** due_soon means the next date is within this many days of today (UTC). */
  due_soon_days: number;
  sources: ApiSource[];
  notes: string[];
};

const DUE_SOON_DAYS = 7;

/** The bills' monthly total in `currency`, added up as the Budgets tab adds
 *  it (components/BudgetsTab.tsx): a bill that says no currency counts in
 *  this one, and the bills in others are left out, counted by currency. */
function billsTotal(bills: readonly RecurringBill[], currency: string | null): { total: number; leftOut: LeftOut } {
  let total = 0;
  const others = new Map<string, number>();
  for (const b of bills) {
    const c = b.currency ?? currency;
    if (c === currency || currency === null) total += b.amount;
    else if (c) others.set(c, (others.get(c) ?? 0) + 1);
  }
  return { total, leftOut: [...others].map(([c, count]) => ({ currency: c, count })).sort((a, b) => b.count - a.count) };
}

export async function readRecurring(ctx: Ctx, opts: { includeHidden?: boolean; today?: string } = {}): Promise<ApiRecurring> {
  const activity = await readActivity(ctx, !!opts.includeHidden);
  const bills = detectRecurring(activity.rows);
  const currency = totalsCurrency(activity.rows);
  const soon = new Set(upcomingBills(bills, DUE_SOON_DAYS, opts.today ?? utcDay(Date.now())));
  const { total, leftOut } = billsTotal(bills, currency);
  return {
    bills: bills.map((b) => ({
      name: b.name,
      institution: b.institution,
      amount: tidy(b.amount),
      currency: b.currency,
      last_date: b.lastDate,
      next_date: b.nextDate,
      due_soon: soon.has(b),
    })),
    monthly_total: { currency, amount: tidy(total), left_out: leftOut },
    due_soon_days: DUE_SOON_DAYS,
    sources: activity.sources,
    notes: [...activity.notes, ...withoutTransactionsNotes(activity.view, activity.rows.length, 'totals')],
  };
}

// ---- Holdings ----

export type ApiHoldingsAccount = {
  account_id: string;
  name: string;
  institution: string;
  /** The UTC day these positions were recorded, or null if never. */
  as_of: string | null;
  observed_at: string | null;
  /** The first day anything was recorded for it. */
  recorded_since: string | null;
  positions: {
    security_id: string;
    ticker: string | null;
    name: string | null;
    type: string | null;
    cash_equivalent: boolean | null;
    quantity: number | null;
    price: number | null;
    price_as_of: string | null;
    value: number | null;
    cost_basis: number | null;
    currency: string | null;
  }[];
};

export type ApiHoldings = {
  accounts: ApiHoldingsAccount[];
  /** False when connections are missing (missing_accounts): their accounts,
   *  and their positions, couldn't be read or haven't been loaded. */
  complete: boolean;
  missing_accounts: ApiMissing[];
  notes: string[];
};

/**
 * Each investment account's latest RECORDED positions (lib/holdings-history.ts),
 * with the day they were recorded: what the nightly snapshot and the person's
 * loads kept, never a fresh fetch. Plaid keeps no history of holdings, so an
 * account is known only from the day recording began. With `accountId`, that
 * one account's; an id no account has is NotFound, but one that may be at a
 * connection whose accounts couldn't be read, or haven't been loaded, is said
 * to be so (complete: false, with the connections named), never "no such
 * account".
 */
export async function readHoldings(ctx: Ctx, opts: { includeHidden?: boolean; accountId?: string } = {}): Promise<ApiHoldings> {
  const read = await accountsRead(ctx, !!opts.includeHidden);
  const base = { links: read.links, ...(opts.includeHidden ? {} : { hidden: read.hidden }) };
  // Manual accounts hold no positions: only a connection missing can hide some.
  const missing = read.missing.filter((m) => m.account_id === null);
  const investment = read.accounts.filter((a) => a.source === 'plaid' && isInvestmentType(a.type) && (opts.accountId === undefined || a.id === opts.accountId));
  if (opts.accountId !== undefined && investment.length === 0) {
    if (read.hidden.has(opts.accountId) && !opts.includeHidden) throw new NotFound('That account is hidden: ask with include_hidden=true to see it.');
    if (missing.length === 0) throw new NotFound('No linked investment account has that id. The ids are in /api/v1/accounts.');
    return {
      accounts: [],
      complete: false,
      missing_accounts: missing,
      notes: [
        ...read.notes,
        'That account isn’t among the accounts that could be read: it may be at a connection whose accounts couldn’t be read or haven’t been loaded yet, so its holdings can’t be given',
      ],
    };
  }
  const accounts = await Promise.all(
    investment.map(async (a): Promise<ApiHoldingsAccount> => {
      const span = await readHoldingsSpan(ctx, { ...base, accountId: a.id });
      const day = span.last ? (await readHoldingsRange(ctx, span.last, span.last, { ...base, accountId: a.id }))[0] : undefined;
      const held = day?.accounts[0];
      return {
        account_id: a.id,
        name: a.name,
        institution: a.institution,
        as_of: held ? day!.date : null,
        observed_at: held?.observed_at ?? null,
        recorded_since: span.first,
        positions: (held?.positions ?? []).map((p) => ({
          security_id: p.security_id,
          ticker: p.ticker,
          name: p.name,
          type: p.security_type,
          cash_equivalent: p.is_cash_equivalent,
          quantity: p.quantity,
          price: p.price,
          price_as_of: p.price_as_of,
          value: p.value,
          cost_basis: p.cost_basis,
          currency: p.currency ?? p.unofficial_currency ?? null,
        })),
      };
    })
  );
  // One account asked for and found: nothing of it is missing.
  const short = opts.accountId === undefined ? missing : [];
  return { accounts, complete: short.length === 0, missing_accounts: short, notes: read.notes };
}
