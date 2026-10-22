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
// CATEGORIES are the person's own (lib/categories.ts): each transaction is
// filed into one as the app files it (lib/activity.ts), its name is the
// category's, and totals are by category id, each with its group. The ids
// are the app's: a category the app hasn't stored yet (the set is made the
// first time the app is opened after categories arrived, and grows as the app
// reads new ones) is grown here in memory, never stored, and its id and its
// group's are null until the app has stored it.
//
// THE APP'S OWN RULES. Transactions come from the Activity tab's own assembly
// (lib/activity.ts): the person's categories and merchant names applied,
// categories and exclusions carried across a re-link, the rows entered on
// manual accounts merged in, the last LOOKBACK_DAYS of them (budgets read
// further back, by the Budgets tab's own read, lib/budget-month.ts: to the
// month asked about, and the first month a carry or the income pool
// counts, from what is stored). Every total of
// spending or income goes through countsInTotals (lib/spending.ts, by way of
// lib/totals.ts): one currency per total, what the person excluded left out,
// transfers, cash withdrawals and loan payments left out (a bank's fees count),
// and what was left out named. Recurring bills are detected as the app
// detects them, with the rows before the window a yearly bill needs, never
// one the person marked not recurring, and their monthly total is added up as
// the Budgets tab adds it (lib/totals.ts recurringMonthly).
//
// CONNECTIONS WITHOUT TRANSACTIONS (lib/item-products.ts: investment accounts
// only, no bank account or card, or a bank account or card whose transactions
// Plaid doesn't provide or the person didn't allow) are named in each answer
// built on transactions (sources[].no_transactions), and its notes say what
// they leave out, in the words the app's views use (lib/no-transactions.ts),
// so an empty list or a zero is never passed off as no spending.
//
// NEVER SHORT WITHOUT SAYING SO. What can't be read is named, and the rest
// answered: accounts and net worth list the connections, manual accounts and
// accounts SimpleFIN feeds they couldn't include (missing_accounts) and say
// complete: false; a per-account history reads only that account's records;
// an account_id no account has is a 404 (NotFound), never an empty series.
//
// SIMPLEFIN. The accounts a SimpleFIN connection keeps up to date
// (lib/connectors/) are served beside the rest with source 'simplefin': the
// balance SimpleFIN last reported, in Nya's sign, as of the time the bank
// gave it, and none to count while a card's or a loan's positive balance
// waits for the person to say how to read it (an answer built on it says
// complete: false), with each bank's health as Connection health shows it.
// Their rows come from the same assembly as the rest, and each bank is among
// the sources, with whether its older history is all in. A Lunch Flow
// connection's accounts are served the same way with source 'lunchflow', as
// of when Nya received their balances (Lunch Flow gives no time with them).
//
// A HOME CURRENCY (lib/fx/settings.ts), once the person has chosen one, is
// base_currency on the answers that carry balances, and conversion into it
// arrives only in fields of its own (lib/fx/api-base.ts): each account's
// to_base, net worth's base, each history point's to_base. Every field version
// 1 had keeps its meaning: one total per currency, nothing converted. Read
// only for the answers that ask (`base`), so the readers built on these
// (goals, shares) read no rates.
//
// HIDDEN ACCOUNTS are left out unless asked for (`includeHidden`), everywhere:
// accounts, balances, transactions, totals, history (subtracted from net
// worth, as the chart subtracts them) and holdings.
//
// ACCOUNTS THAT ENDED (closed, left, or no longer followed: lib/lifecycle.ts)
// are listed with when (`lifecycle`, a field version 1 gained), even once
// their bank stops returning them, with the newest balance measured before,
// and count in nothing from that day on, as in the app: net worth now leaves
// them out, its history subtracts them from their end day, and their
// transactions from it are left out (lib/activity.ts). An investment one's
// holdings say so too. Read strictly: one that can't be read is a 409, never
// an account counted that the person closed.
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
import { getEffectiveHidden, resolveId, sameAccountIds, directoryCurrencies, type Link } from './links';
import { getEffectiveLifecycle, lifecycleOf, endOf, endedNowIds, lastEndDay, shortDays, type LifecycleView } from './lifecycle';
import type { HiddenMap } from './hidden';
import { couldNotRead, rememberedAccountsReport, type RememberedAccount } from './last-known';
import { latestMeasuredBalances, snapshotTakenAt, getHistory, getHistoryWithSplit, getAccountHistory, type HistoryPoint } from './history';
import { getManualAccountsReport, isManualId, toInstitutions, MANUAL_CURRENCY } from './manual';
import { connectorBanksReport, type ConnectorBanksReport } from './connectors/institutions';
import { connectorHealthText } from './connectors/health';
import { connectorAccountsStore, endedAccountsStore } from './connectors/store';
import { ANY_CONNECTOR, connectorLabel, isConnectorKind, type ConnectorKind } from './connectors/types';
import type { InstitutionResult } from './networth';
import { bankCurrencies } from './sharing';
import { readHealthForDisplay } from './connection-health';
import { noticesStore } from './connection-records';
import { warningLapsed, type HealthState } from './connection-state';
import { assembleBankRows, finishActivity, type BankSource } from './activity';
import type { NoTransactionsReason } from './item-products';
import { missingEmptyNotes, missingFigureNotes, noSpending, withoutNote, noTransactionsView, coveredOutOf, coveredOutOfDays, type NoTransactionsView } from './no-transactions';
import { withImportedFiles } from './history-import/without-files';
import { budgetsForReading } from './budget-store';
import { budgetMeters, placeBudgets, type GroupMeter } from './budget-set';
import { readBudgetMonth, windowStart, type BudgetMonthRead } from './budget-month';
import { availableMeters, gapText, monthName, type Carry, type CarryFrom } from './rollover';
import { categoryById, groupOf, indexTaxonomy, isProvisionalId, sortedGroups, categoriesIn, type CategoryGroup, type CategoryIndex, type CategoryKind } from './categories';
import { addDays, dismissedSeries, detectRecurring, expectedDates, upcomingBills, type Cadence } from './recurring';
import { plannedStore } from './planned-store';
import { countsInTotals, countTransactions, currencyOf, isTransfer, leftOutByCurrency, leftOutText, totalsCurrency, transactionCounter, type LeftOut } from './spending';
import { spendingByCategory, summarize, tidy, bucketOf, recurringMonthly, type Described, type Summary } from './totals';
import { readHoldingsSpan, readHoldingsRange } from './holdings-history';
import { isInvestmentType, isOwedType } from './balance';
import { dominantCurrency } from './format';
import { LOOKBACK_DAYS, type OlderTxn, type Txn } from './transactions';
import { API_VERSION, RATE_WINDOW_SECONDS, REQUESTS_PER_MINUTE, TOKEN_PREFIX } from './api-limits';
import { readTagSet, tagNameKey, type TagSet } from './tags';
import { spendingByTag } from './tag-totals';
import type { Authenticated } from './api-tokens';
import { NotFound } from './api-spec';
import { bankRows, PART_PREFIX, type WithParts } from './split-rows';
import { readDrawState } from './history-import/extend';
import { importedRowsNote, importedStretch } from './history-import/view';
import { lastDayOf } from './cash-flow';
import type { WalkState } from './history-import/store';
import { readSettingsForDisplay, type CurrencySettings } from './fx/settings';
import { readFx } from './fx/read';
import { foreignFor, lifecycleAccounts } from './fx/net-worth-read';
import type { SplitPoint } from './fx/net-worth';
import type { FxTable } from './fx/rates';
import { apiBase, apiOwnRates, baseNotes, historyInBase, historyNotes, pointNotes, toBase, SETTINGS_UNREADABLE_NOTE, type ApiBase, type ApiOwnRate } from './fx/api-base';
import { unusableText } from './fx/words';

/** What the rates an answer converted with couldn't use, in words: none or
 *  one note (lib/fx/words.ts unusableText). */
const ratesNotes = (fx: FxTable | null): string[] => {
  const said = fx ? unusableText(fx.unusable ?? []) : null;
  return said ? [said] : [];
};

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
  /** The home currency the person chose, or null: none chosen (nothing is
   *  converted), or settings that couldn't be read. Added in version 1. */
  base_currency: string | null;
  /** The person's own rates (lib/fx/settings.ts). Added in version 1. */
  own_rates: ApiOwnRate[];
};

/** Container-level facts only: never a sign-in id or an email address. */
export async function readMe(auth: Authenticated): Promise<ApiMe> {
  const [record, { settings }] = await Promise.all([getContainer(auth.ctx.container), readSettingsForDisplay(auth.ctx)]);
  return {
    api_version: API_VERSION,
    token: { label: auth.token.label, hint: `${TOKEN_PREFIX}${auth.id.slice(0, 8)}`, created_at: auth.token.created_at, last_used_at: auth.token.last_used_at },
    data_since: record?.created_at ?? null,
    rate_limit: { requests: REQUESTS_PER_MINUTE, per_seconds: RATE_WINDOW_SECONDS },
    base_currency: settings.home,
    own_rates: apiOwnRates(settings.own),
  };
}

// ---- A home currency ----

/** What an answer asked to convert reads first: the person's settings, if
 *  they chose a home currency, and a note when they couldn't be read (then
 *  nothing is converted). LENIENT, for this display only, as every read of
 *  them for figures is (lib/fx/settings.ts). */
type HomeRead = { settings: CurrencySettings | null; note: string | null };

async function readHome(ctx: Ctx): Promise<HomeRead> {
  const { settings, problem } = await readSettingsForDisplay(ctx);
  return { settings: settings.home ? settings : null, note: problem ? SETTINGS_UNREADABLE_NOTE : null };
}

/** The rates an answer converts with, read once: for the currencies given,
 *  from `from` to today. Null without a home currency. */
async function ratesFor(ctx: Ctx, home: HomeRead, currencies: Iterable<string | null>, from: string, now: number): Promise<FxTable | null> {
  if (!home.settings) return null;
  const today = utcDay(now);
  const need = [...currencies].filter((c): c is string => typeof c === 'string');
  const { fx } = await readFx(ctx, { currencies: need, from: from < today ? from : today, to: today }, { settings: home.settings, problem: null });
  return fx;
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
  /** 'plaid' for a linked account, 'simplefin' or 'lunchflow' for one a
   *  SimpleFIN or Lunch Flow connection keeps up to date, 'manual' for one
   *  tracked by hand. Version 1 may add values (another way to connect):
   *  treat one you don't know as none of these. */
  source: string;
  name: string;
  official_name: string | null;
  institution: string;
  type: string;
  subtype: string | null;
  mask: string | null;
  /** Plaid's sign: what a credit card or a loan owes is positive. Null when
   *  no balance was ever measured, or the newest can't be read (named in
   *  `missing`, as unavailable: never an older one in its place). */
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
  /** Null for a manual account. For one SimpleFIN feeds, its bank's link
   *  through SimpleFIN, as Connection health shows it. */
  connection: ApiConnection | null;
  /** When it ended, as the person said (or Nya assumed, `assumed`, when
   *  nobody answered about an account its bank stopped returning), or null
   *  while it is open. From `date` on it counts in no total. Version 1 may
   *  add states. */
  lifecycle: ApiLifecycle | null;
  /** The balance in base_currency at the newest rates (an account saying no
   *  currency counts in the main one), or null: no home currency, no
   *  balance, or no rate. Only on the answers that convert (`base`). Added in
   *  version 1. */
  to_base?: number | null;
};

export type ApiLifecycle = {
  /** closed, left (no longer yours: sold, transferred, divided), or
   *  untracked (no longer followed). */
  state: 'closed' | 'left' | 'untracked';
  /** The day it stopped counting, YYYY-MM-DD. */
  date: string;
  /** What the person wrote about it, or null. */
  note: string | null;
  /** Nya assumed it closed: nobody answered whether it had, after its bank
   *  stopped returning it. */
  assumed: boolean;
};

/** An account's end, for the API, or null while it is open. */
function apiLifecycle(view: LifecycleView, id: string): ApiLifecycle | null {
  const entry = lifecycleOf(view, id);
  const l = entry?.lifecycle;
  const date = l ? endOf(l) : null;
  if (!entry || !l || l.state === 'active' || date === null) return null;
  return { state: l.state, date, note: (l.state === 'closed' || l.state === 'left') && l.note ? l.note : null, assumed: entry.assumed === true };
}

/** An account, or a connection's accounts, that an answer couldn't include
 *  (see AccountsRead). */
export type ApiMissing = {
  /** The connection's institution; null for a manual account, whose name is
   *  in what couldn't be read. */
  institution: string | null;
  /** A manual account's id, one SimpleFIN feeds, or a linked account's whose
   *  newest balance can't be read (listed with none); null for a connection,
   *  whose accounts can't be told apart until they are read. */
  account_id: string | null;
  /** Where it comes from, as ApiAccount.source: 'plaid' for a connection's
   *  accounts, 'manual', 'simplefin' or 'lunchflow'. */
  source: string;
  /** 'unreadable': stored, and couldn't be read. 'unrecognised': a manual
   *  account stored intact in a form this version doesn't know (a later
   *  version's), kept as it is. 'unavailable': sealed under an encryption
   *  key this deployment doesn't have (lib/crypto.ts sealedAway): a manual
   *  account (lib/manual.ts ManualAccountsReport), a connection's record of
   *  its accounts (lib/last-known.ts), or the day's balances that may hold a
   *  linked account's newest (lib/history.ts latestMeasuredBalances): the
   *  deployment's problem, not damage.
   *  'not_loaded': a connection whose accounts the app hasn't loaded yet.
   *  Version 1 may add reasons. */
  reason: 'unreadable' | 'unrecognised' | 'unavailable' | 'not_loaded';
};

/** The accounts, and what couldn't be included, named (`missing`): never a
 *  shorter list passed off as whole (an answer built on it says complete:
 *  false). */
type AccountsRead = { accounts: ApiAccount[]; missing: ApiMissing[]; notes: string[]; hidden: HiddenMap; links: Map<string, Link>; lifecycle: LifecycleView };

/** The connection facts for each Item, from the records health keeps. Also
 *  what a report says of each connection (lib/report/read.ts), so the two
 *  read them alike. */
export async function connectionFacts(ctx: Ctx): Promise<{ of: (item_id: string) => ApiConnection; note: string | null }> {
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
  // Strict: a hidden account must never show for a read that failed.
  const hiddenRead = getEffectiveHidden(ctx, { readOnly: true });
  // Strict, through the same links: an end that can't be read throws.
  const lifecycleRead = hiddenRead.then((effective) => getEffectiveLifecycle(ctx, effective.links));
  const [items, remembered, effective, manual, facts, fed, lifecycle] = await Promise.all([
    getItems(ctx),
    rememberedAccountsReport(ctx),
    hiddenRead,
    // LENIENT, for this display only: an account that can't be read is named
    // in `missing`, and the others listed; recording a snapshot reads them all
    // strictly (lib/networth.ts). One sealed under a key this deployment
    // doesn't have is named too, with a reason of its own: one such account
    // must not take every answer built on this one down. Storage out of
    // reach, or a master key that can't open the data keys, still throws.
    getManualAccountsReport(ctx),
    connectionFacts(ctx),
    // LENIENT, for this display only, as the manual accounts are: an account
    // entry that can't be read is named in `missing`. One that ended holds
    // no bank (lib/connectors/institutions.ts); the strict read is below.
    connectorBanksReport(
      ctx,
      Date.now(),
      lifecycleRead.then(
        (view) => endedNowIds(view),
        () => new Set<string>()
      )
    ),
    lifecycleRead,
  ]);
  const notes: string[] = [];
  const missing: ApiMissing[] = [];
  const { hidden } = effective;
  const links = effective.links ?? new Map<string, Link>();
  const unreadable = new Set(remembered.unreadable);
  // Sealed under a key this deployment can't use: named with a reason of its
  // own, as a manual account's is, never as damaged (lib/last-known.ts).
  const unavailable = new Set(remembered.unavailable);

  // Each stored Item's accounts, as its last good load recorded them.
  const linked: { item: StoredItem; account: RememberedAccount }[] = [];
  for (const item of items) {
    if (unreadable.has(item.item_id) || unavailable.has(item.item_id)) {
      notes.push(`${item.institution_name}: its accounts couldn’t be read, so they aren’t listed`);
      missing.push({ institution: item.institution_name, account_id: null, reason: unavailable.has(item.item_id) ? 'unavailable' : 'unreadable', source: 'plaid' });
      continue;
    }
    const accounts = remembered.byItem[item.item_id];
    if (!accounts) {
      notes.push(`${item.institution_name}: its accounts haven’t been loaded yet; open the app to load them`);
      missing.push({ institution: item.institution_name, account_id: null, reason: 'not_loaded', source: 'plaid' });
      continue;
    }
    for (const account of accounts) {
      if (includeHidden || !hidden.has(account.account_id)) linked.push({ item, account });
    }
  }
  // Accounts that ended and that no live list names any more (a bank stops
  // returning a closed account): listed from what their end keeps, so the
  // end, and whether it was assumed, can be seen. A SimpleFIN card names
  // one while it shows it (one that ended and isn't in SimpleFIN's latest
  // answer is left off it), and one that can't be read is named below.
  const listedIds = new Set([
    ...linked.map(({ account }) => account.account_id),
    ...manual.accounts.map((a) => a.account_id),
    ...fed.cards.flatMap((card) => card.accounts.map((a) => a.account_id)),
    ...fed.unreadable.map((u) => u.account_id),
  ]);
  const endedOnly = [...lifecycle.accounts].filter(
    ([root, { entry }]) =>
      endOf(entry.lifecycle) !== null &&
      !sameAccountIds(root, links).some((id) => listedIds.has(id)) &&
      (includeHidden || !hidden.has(root)) &&
      !(isManualId(root) && (manual.unreadable.includes(root) || manual.unrecognised.includes(root) || manual.unavailable.includes(root)))
  );
  const ids = new Map([...linked.map(({ account }) => account.account_id), ...endedOnly.map(([root]) => root)].map((id) => [id, sameAccountIds(id, links)]));
  const [{ balances, unavailable: sealed }, currencies] = await Promise.all([
    latestMeasuredBalances(ctx, ids),
    bankCurrencies(ctx, linked.map(({ account }) => account.account_id), remembered.byItem),
  ]);
  // Accounts whose newest balance is sealed under a key this deployment
  // can't use: listed with none, and named, never answered with an older one,
  // under the account's own source (ApiAccount.source).
  const sealedOf = (account_id: string, institution: string, source: string) => {
    if (sealed.has(account_id)) missing.push({ institution, account_id, reason: 'unavailable', source });
  };
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
    sealedOf(account.account_id, item.institution_name, 'plaid');
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
      lifecycle: apiLifecycle(lifecycle, account.account_id),
    };
  });

  // A hidden one is left out either way: nothing missing from what was asked.
  // Damaged, saved by a version this one doesn't know, or sealed under a key
  // this deployment doesn't have (lib/manual.ts ManualAccountsReport), each is
  // named, and none is listed.
  const asked = (id: string) => includeHidden || !hidden.has(id);
  const unlisted = [
    ...manual.unreadable.filter(asked).map((id) => ({ id, reason: 'unreadable' as const })),
    ...manual.unrecognised.filter(asked).map((id) => ({ id, reason: 'unrecognised' as const })),
    ...manual.unavailable.filter(asked).map((id) => ({ id, reason: 'unavailable' as const })),
  ];
  for (const { id, reason } of unlisted) missing.push({ institution: null, account_id: id, reason, source: 'manual' });
  if (unlisted.length > 0) {
    const one = unlisted.length === 1;
    notes.push(`${one ? 'A manual account' : `${unlisted.length} manual accounts`} couldn’t be read, so ${one ? 'it isn’t' : 'they aren’t'} listed`);
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
        lifecycle: apiLifecycle(lifecycle, a.account_id),
      });
    }
  }
  const stored = new Set(items.map((i) => i.item_id));
  // One a connector fed is that connector's: still tracked, or let go and
  // removed (lib/connectors/store.ts connector-ended remembers it, and which
  // connector). LENIENT: one that can't be read is said as a manual account;
  // one whose record can't say which connector is read as SimpleFIN's, the
  // value readers before Lunch Flow know.
  const fedKinds: Map<string, ConnectorKind | null> = endedOnly.some(([root]) => isManualId(root) && !fed.accounts.has(root))
    ? await endedAccountsStore.getAllReport(ctx).then(
        (r) => new Map([...[...r.entries].map(([id, e]) => [id, e.connector] as const), ...[...r.unreadable, ...r.unrecognised].map((id) => [id, null] as const)]),
        () => new Map<string, ConnectorKind | null>()
      )
    : new Map<string, ConnectorKind | null>();
  for (const [id, a] of fed.accounts) fedKinds.set(id, a.connector);
  for (const [root, { entry }] of endedOnly) {
    const b = balances.get(root) ?? null;
    const source = isManualId(root) ? (fedKinds.has(root) ? (fedKinds.get(root) ?? 'simplefin') : 'manual') : 'plaid';
    sealedOf(root, entry.label.institution, source);
    const type = entry.type ?? 'other';
    accounts.push({
      id: root,
      source,
      name: entry.label.name,
      official_name: null,
      institution: entry.label.institution,
      type,
      subtype: null,
      mask: entry.label.mask,
      balance: b?.value ?? null,
      // As its end recorded it, where the write knew it.
      currency: entry.currency ?? null,
      credit_limit: null,
      is_debt: isOwedType(type),
      hidden: hidden.has(root),
      as_of: b?.date ?? null,
      as_of_time: b?.layer === 'recorded' ? (takenAt.get(b.date) ?? null) : null,
      connection: entry.item_id && stored.has(entry.item_id) ? facts.of(entry.item_id) : null,
      lifecycle: apiLifecycle(lifecycle, root),
    });
  }
  // The accounts a SimpleFIN or Lunch Flow connection keeps up to date (see
  // SIMPLEFIN above). One kept as a manual account on a disconnect that
  // stopped part way is in both stores: the manual one, listed above, is it.
  const own = new Set([...manual.accounts.map((a) => a.account_id), ...manual.unreadable, ...manual.unrecognised, ...manual.unavailable]);
  for (const card of fed.cards) {
    const shown = card.accounts.filter((a) => !own.has(a.account_id) && asked(a.account_id));
    if (shown.length === 0) continue;
    const connection = fedConnection(card, fed);
    const kind = card.connector ?? 'simplefin';
    for (const a of shown) {
      const at = realTime(a.updated_at);
      accounts.push({
        id: a.account_id,
        source: kind,
        name: a.name,
        official_name: null,
        institution: card.institution_name,
        type: a.type,
        subtype: a.subtype,
        mask: null,
        // Nya's sign; null while there is none to count (see SIMPLEFIN).
        balance: a.balance,
        currency: a.currency,
        credit_limit: null,
        is_debt: isOwedType(a.type),
        hidden: hidden.has(a.account_id),
        // The time the bank gave the balance (its balance-date), else when
        // Nya received it (Lunch Flow gives none).
        as_of: at ? at.slice(0, 10) : null,
        as_of_time: at,
        connection,
        lifecycle: apiLifecycle(lifecycle, a.account_id),
      });
    }
    const said = card.health ? connectorHealthText(card.institution_name, card.health) : null;
    if (said) notes.push(`${card.institution_name}, through ${connectorLabel(kind)}: ${said}`);
  }
  if (sealed.size > 0) {
    const one = sealed.size === 1;
    notes.push(`${one ? 'An account’s newest balance' : `${sealed.size} accounts’ newest balances`} couldn’t be read, so ${one ? 'it has' : 'they have'} none here`);
  }
  const unread = fed.unreadable.filter((u) => asked(u.account_id) && !own.has(u.account_id));
  // Which connector one that can't be read came through: the connection that
  // lists it says, when it can be read (else read as SimpleFIN's, as above).
  const trackedBy = (id: string): ConnectorKind | null => [...fed.connections.values()].find((c) => c.tracked.some((t) => t.account_id === id))?.connector ?? null;
  const unreadKinds = unread.map((u) => trackedBy(u.account_id));
  unread.forEach((u, i) => missing.push({ institution: null, account_id: u.account_id, reason: u.reason, source: unreadKinds[i] ?? 'simplefin' }));
  if (unread.length > 0) {
    const one = unread.length === 1;
    const kinds = new Set(unreadKinds);
    const label = kinds.size === 1 && !kinds.has(null) ? connectorLabel(unreadKinds[0]!) : ANY_CONNECTOR;
    notes.push(`${one ? `An account ${label} keeps` : `${unread.length} accounts ${label} keeps`} up to date couldn’t be read, so ${one ? 'it isn’t' : 'they aren’t'} listed`);
  }
  const byText = (a: string, b: string) => a.localeCompare(b);
  accounts.sort((a, b) => byText(a.institution, b.institution) || byText(a.name, b.name) || byText(a.id, b.id));
  return { accounts, missing, notes, hidden, links, lifecycle };
}

/**
 * A SimpleFIN bank's link, as Connection health shows it, in the API's shape:
 * when it last synced cleanly, and what is wrong with it while that lasts,
 * with the state Connection health gives it and, as `since`, when Nya's
 * latest request found it (when it began isn't kept), or, with no answer in
 * over a day, when the last one came.
 */
function fedConnection(card: InstitutionResult, fed: ConnectorBanksReport, now: number = Date.now()): ApiConnection {
  const health = card.health;
  const conn = card.connection_id ? fed.connections.get(card.connection_id) : undefined;
  const found = (health?.detail?.issue === 'stale' ? conn?.last_answer_at : fed.askedAt.get(card.item_id)) ?? conn?.created_at ?? new Date(now).toISOString();
  return {
    last_ok_at: health?.last_ok_at ?? null,
    problem: !health || health.state === 'healthy' ? null : { state: health.state, since: found },
    ends_at: null,
    ...(card.connection_id && fed.unreadableConnections.has(card.connection_id) ? { records_unreadable: true as const } : {}),
  };
}

export type ApiAccounts = {
  accounts: ApiAccount[];
  /** The home currency the accounts' to_base is in, or null (see ApiMe).
   *  Only when asked (`base`). */
  base_currency?: string | null;
  /** False when accounts are missing from the list (missing_accounts). */
  complete: boolean;
  missing_accounts: ApiMissing[];
  notes: string[];
};

/**
 * Each account's name as the app labels it where a rule names one
 * (components/Dashboard.tsx: the institution, the account and its mask), by
 * id, hidden ones too, following links from an earlier account to the one
 * it became; null for one no longer here. For saying a rule in words.
 */
export async function accountLabels(ctx: Ctx): Promise<(id: string) => string | null> {
  const { accounts, links } = await accountsRead(ctx, true);
  const byId = new Map(accounts.map((a) => [a.id, `${a.institution} ${a.name}${a.mask ? ` ••${a.mask}` : ''}`]));
  return (id) => byId.get(id) ?? byId.get(resolveId(id, links)) ?? null;
}

/** Every account: linked and manual, with its newest measured balance and as
 *  of when. Hidden ones only with `includeHidden`. With `base`, each one's
 *  to_base, in the home currency the person chose. */
export async function readAccounts(ctx: Ctx, opts: { includeHidden?: boolean; base?: boolean } = {}): Promise<ApiAccounts> {
  const [{ accounts, missing, notes }, home] = await Promise.all([accountsRead(ctx, !!opts.includeHidden), opts.base ? readHome(ctx) : null]);
  if (!home) return { accounts, complete: missing.length === 0, missing_accounts: missing, notes };
  const now = Date.now();
  const { currency: main } = netWorthCurrency(accounts.filter(countsNow));
  const fx = await ratesFor(ctx, home, [...accounts.map((a) => a.currency), main], utcDay(now), now);
  return {
    accounts: accounts.map((a) => ({ ...a, to_base: fx ? toBase(fx, a.balance, a.currency ?? main, utcDay(now)) : null })),
    base_currency: home.settings?.home ?? null,
    complete: missing.length === 0,
    missing_accounts: missing,
    notes: [...notes, ...(home.note ? [home.note] : []), ...ratesNotes(fx)],
  };
}

// ---- Net worth ----

export type ApiNetWorth = {
  /** One total per currency, most accounts first, as version 1 always gave
   *  them: nothing is converted here (`base` converts them, once the person
   *  chose a home currency). An account whose currency isn't known is
   *  counted in the main one, as the app shows it. */
  totals: { currency: string | null; net_worth: number; assets: number; debts: number; accounts: number }[];
  /** The oldest and newest day among the balances counted: they are each an
   *  account's newest measured balance, and can be from different days. */
  balances_from: string | null;
  balances_to: string | null;
  /** Accounts left out of the totals for having no balance to count: none
   *  ever measured, or a card's or a loan's SimpleFIN reports as money held,
   *  until the person says how to read it. */
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
  /** The home currency base is in, or null (see ApiMe). Only when asked
   *  (`base`). Added in version 1. */
  base_currency?: string | null;
  /** Net worth converted into base_currency (lib/fx/api-base.ts), or null
   *  without one. Only when asked. Added in version 1. */
  base?: ApiBase | null;
  notes: string[];
};

/** What net worth, now and over time, is built from, read once: the
 *  accounts, and the recorded history with hidden accounts subtracted (as the
 *  chart subtracts them) unless they are asked for; and, asked to convert,
 *  the home currency and, for a history to convert, its split by currency. */
type NetWorthRead = {
  read: AccountsRead;
  history: HistoryPoint[];
  home: HomeRead | null;
  split: { points: SplitPoint[]; breaks: string[]; main: string | null } | null;
};

async function netWorthRead(ctx: Ctx, includeHidden: boolean, opts: { base?: boolean; split?: boolean } = {}): Promise<NetWorthRead> {
  const [read, home] = await Promise.all([accountsRead(ctx, includeHidden), opts.base ? readHome(ctx) : null]);
  // Accounts that ended are subtracted from their end day either way: they
  // are no longer the person's to count, hidden or not.
  const hidden = includeHidden ? undefined : read.hidden;
  const short = shortDays(read.lifecycle, includeHidden ? new Map() : read.hidden);
  if (!home?.settings || !opts.split) return { read, history: await getHistory(ctx, hidden, read.lifecycle.ended, short), home, split: null };
  // Split by currency (lib/history.ts getHistoryWithSplit): each account in
  // another currency than the main one, by every id it has had, known from
  // the accounts listed, those that ended and the directory.
  const main = netWorthCurrency(read.accounts.filter(countsNow)).currency;
  const listed = read.accounts.map((a) => ({ account_id: a.id, currency: a.currency, type: a.type }));
  const { foreign } = foreignFor([listed, lifecycleAccounts(read.lifecycle), await directoryCurrencies(ctx)], read.links, main);
  const { points, breaks, raw } = await getHistoryWithSplit(ctx, hidden, read.lifecycle.ended, short, foreign);
  return { read, history: points, home, split: { points: raw, breaks, main } };
}

/** The rates a net worth answer converts with: for the accounts counted now
 *  and, with a split, every currency and day of the history. */
async function netWorthRates(ctx: Ctx, nw: NetWorthRead, now: number): Promise<FxTable | null> {
  if (!nw.home) return null;
  const counted = nw.read.accounts.filter(countsNow);
  const currencies = new Set<string | null>([...counted.map((a) => a.currency), netWorthCurrency(counted).currency]);
  if (nw.split) {
    currencies.add(nw.split.main);
    for (const p of nw.split.points) for (const c of Object.keys(p.parts ?? {})) currencies.add(c);
  }
  return ratesFor(ctx, nw.home, currencies, nw.split?.points[0]?.date ?? utcDay(now), now);
}

/** Whether an account counts in net worth now: not once it has ended. */
const countsNow = (a: ApiAccount) => a.lifecycle === null || a.lifecycle.date > lastEndDay();

/** The currency net worth is labelled with, and whether the accounts mix
 *  several (the recorded totals add them unconverted, as the chart does). */
function netWorthCurrency(accounts: readonly ApiAccount[]): { currency: string | null; mixed: boolean } {
  return {
    currency: dominantCurrency(accounts.map((a) => ({ iso_currency_code: a.currency }))),
    mixed: new Set(accounts.map((a) => a.currency).filter(Boolean)).size > 1,
  };
}

function netWorthOf({ read, history, home }: NetWorthRead, fx: FxTable | null, now: number = Date.now()): ApiNetWorth {
  const counted = read.accounts.filter(countsNow);
  const { currency: main, mixed } = netWorthCurrency(counted);
  const totals = new Map<string | null, { currency: string | null; net_worth: number; assets: number; debts: number; accounts: number }>();
  let without = 0;
  const days: string[] = [];
  for (const a of counted) {
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
  const conv = home ? converted(home, fx, counted, main, now) : null;
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
    ...(conv ?? {}),
    notes: [...read.notes, ...(home?.note ? [home.note] : []), ...(conv?.base ? [...baseNotes(conv.base, conv.base_currency!), ...ratesNotes(fx)] : [])],
  };
}

/** Net worth's base_currency and base: the accounts counted now that have a
 *  balance, converted as the app converts them. */
function converted(home: HomeRead, fx: FxTable | null, counted: readonly ApiAccount[], main: string | null, now: number): Pick<ApiNetWorth, 'base_currency' | 'base'> {
  if (!home.settings || !fx) return { base_currency: null, base: null };
  const balances = counted.flatMap((a) => (a.balance === null ? [] : [{ balance: a.balance, currency: a.currency, is_debt: a.is_debt }]));
  return { base_currency: home.settings.home, base: apiBase(balances, fx, main, now) };
}

/** Net worth now, from each account's newest measured balance, per currency,
 *  and the newest recorded point of its history. With `base`, converted into
 *  the home currency the person chose. */
export async function readNetWorth(ctx: Ctx, opts: { includeHidden?: boolean; base?: boolean } = {}): Promise<ApiNetWorth> {
  const now = Date.now();
  const nw = await netWorthRead(ctx, !!opts.includeHidden, { base: opts.base });
  return netWorthOf(nw, await netWorthRates(ctx, nw, now), now);
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
  /** The home currency points' to_base is in, or null (see ApiMe). Added in
   *  version 1. */
  base_currency: string | null;
  /** Net worth's recorded totals add balances in every currency, as the chart
   *  does: true when the accounts counted are in more than one. */
  mixed_currencies: boolean;
  interval: Interval;
  /** Oldest first. `estimated` is true for a point reconstructed from
   *  transactions rather than recorded (only with include_estimated). */
  points: { date: string; value: number; estimated: boolean; to_base: number | null }[];
  /** With include_estimated: the estimated points dated `from` up to (not
   *  including) `until` follow, at least for one account, transactions
   *  imported from files rather than the bank's own (#52,
   *  lib/history-import/extend.ts); null when none do. Added in version 1,
   *  as its promise allows. */
  from_imports: { from: string; until: string } | null;
  notes: string[];
};

export type HistoryQuery = { accountId?: string; from?: string; to?: string; includeEstimated?: boolean; includeHidden?: boolean; interval?: Interval };

/** The stretch of estimated points that follows imported transactions
 *  (ApiHistory.from_imports): net worth's, or one account's (any of its ids).
 *  `hidden`, the accounts net worth leaves out (every id each has had), are
 *  left out of it too, as the chart's note leaves them out, and so is an
 *  account that ended from its end day on (`ended`, lib/lifecycle.ts). */
function fromImports(
  drawn: WalkState | null,
  ids: readonly string[] | null,
  hidden: ReadonlySet<string> = new Set(),
  ended: ReadonlyMap<string, { from: string }> = new Map()
): ApiHistory['from_imports'] {
  return importedStretch(drawn, ids, hidden, ended);
}

/** A series as answered: recorded points only unless estimated ones are
 *  asked for, in [from, to], one point per interval. */
function seriesOf(
  points: readonly HistoryPoint[],
  q: HistoryQuery,
  head: { account_id: string | null; currency: string | null; mixed: boolean },
  notes: string[],
  imported: ApiHistory['from_imports'] = null,
  base: { currency: string | null; of: ((p: HistoryPoint) => number | null) | null } = { currency: null, of: null }
): ApiHistory {
  const interval = q.interval ?? 'day';
  const kept = points.filter(
    (p) => (q.includeEstimated || !p.estimated) && (q.from === undefined || p.date >= q.from) && (q.to === undefined || p.date <= q.to)
  );
  return {
    account_id: head.account_id,
    currency: head.currency,
    base_currency: base.currency,
    mixed_currencies: head.mixed,
    interval,
    points: sampleSeries(kept, interval).map((p) => ({ date: p.date, value: tidy(p.value), estimated: !!p.estimated, to_base: base.of ? base.of(p) : null })),
    from_imports: q.includeEstimated ? imported : null,
    notes,
  };
}

/** Net worth's history from a read already made, each point with its
 *  to_base when the read was asked to convert, from its split. */
function netWorthHistoryOf(nw: NetWorthRead, q: HistoryQuery, drawn: WalkState | null, fx: FxTable | null): ApiHistory {
  const { currency, mixed } = netWorthCurrency(nw.read.accounts.filter(countsNow));
  const notes: string[] = nw.home?.note ? [nw.home.note] : [];
  let base: { currency: string | null; of: ((p: HistoryPoint) => number | null) | null } = { currency: null, of: null };
  if (fx?.home && nw.split) {
    const { byDay, gaps } = historyInBase(
      nw.split,
      fx,
      (p) => (q.includeEstimated || !p.estimated) && (q.from === undefined || p.date >= q.from) && (q.to === undefined || p.date <= q.to)
    );
    base = { currency: fx.home, of: (p) => byDay.get(p.date) ?? null };
    notes.push(...historyNotes(gaps, fx.home, nw.split.main), ...ratesNotes(fx));
  }
  return seriesOf(
    nw.history,
    q,
    { account_id: null, currency, mixed },
    notes,
    fromImports(drawn, null, q.includeHidden ? new Set() : new Set(nw.read.hidden.keys()), nw.read.lifecycle.ended),
    base
  );
}

/**
 * One account's history (linked or manual, by its current id or an earlier
 * one), reading only what that account needs: a damaged record of another
 * account never fails it. Null for a hidden account when hidden ones aren't
 * asked for; NotFound for an id that names no account Nya has or had.
 */
async function accountHistory(ctx: Ctx, id: string, q: HistoryQuery): Promise<ApiHistory | null> {
  const [effective, home] = await Promise.all([getEffectiveHidden(ctx, { readOnly: true }), readHome(ctx)]);
  if (!q.includeHidden && effective.hidden.has(id)) return null;
  const links = effective.links ?? new Map<string, Link>();
  const older = sameAccountIds(id, links).filter((other) => other !== id);
  const points = await getAccountHistory(ctx, id, older);
  const notes: string[] = [];
  let known = links.has(id) || [...links.values()].some((l) => l.to === id);
  let currency: string | null = null;
  if (isManualId(id)) {
    // Its currency is its own: a manual account's (chosen for it, or kept
    // from a connector on a disconnect; US dollars when it names none), or
    // the one SimpleFIN or Lunch Flow gives an account it feeds. LENIENT, for this display only: a
    // record that can't be read leaves the currency unknown, said in a note,
    // rather than failing a history kept apart from it. Storage out of reach
    // still throws.
    const [manual, fed] = await Promise.all([getManualAccountsReport(ctx), connectorAccountsStore.getAllReport(ctx)]);
    const own = manual.accounts.find((a) => a.account_id === id);
    const feeds = fed.entries.get(id);
    if (own) currency = own.currency ?? MANUAL_CURRENCY;
    else if (feeds) currency = feeds.currency;
    const damaged = [...manual.unreadable, ...manual.unrecognised, ...manual.unavailable, ...fed.unreadable, ...fed.unrecognised].includes(id);
    if (!own && !feeds && damaged) notes.push('This account’s record couldn’t be read, so its currency isn’t known');
    known ||= !!own || !!feeds || damaged;
  } else {
    // LENIENT, for this display only: an Item's record that can't be read
    // leaves this account's currency unknown, said in a note, rather than
    // failing a history kept apart from it. Storage out of reach still throws.
    const remembered = await rememberedAccountsReport(ctx);
    known ||= Object.values(remembered.byItem).some((accounts) => accounts.some((a) => a.account_id === id));
    currency = (await bankCurrencies(ctx, [id], remembered.byItem)).get(id) ?? null;
    if (currency === null && couldNotRead(remembered).length > 0) {
      notes.push('Some accounts’ records couldn’t be read, so this account’s currency isn’t known');
      // It may be one of theirs: not said to be unknown.
      known = true;
    }
  }
  if (!known && points.length === 0) throw new NotFound('No account has that id. The ids are in /api/v1/accounts.');
  // In base_currency, each point at its own day's rate, from the account's
  // own currency.
  if (home.note) notes.push(home.note);
  const now = Date.now();
  const fx = home.settings && currency !== null ? await ratesFor(ctx, home, [currency], points[0]?.date ?? utcDay(now), now) : null;
  if (home.settings && currency === null && !notes.some((n) => n.includes('currency isn’t known'))) notes.push('This account’s currency isn’t known, so its points have no to_base');
  const series = seriesOf(points, q, { account_id: id, currency, mixed: false }, notes, fromImports(await readDrawState(ctx), [id, ...older]), {
    currency: home.settings?.home ?? null,
    of: fx ? (p) => toBase(fx, p.value, currency, p.date) : null,
  });
  if (fx && currency !== null) series.notes.push(...pointNotes(fx, series.points, currency), ...ratesNotes(fx));
  return series;
}

/**
 * Net worth's history (hidden accounts subtracted, as the chart subtracts
 * them), or one account's, recorded points only unless `includeEstimated`, in
 * [from, to], one point per `interval`. Null for an account that is hidden
 * when hidden ones aren't asked for.
 */
export async function readBalanceHistory(ctx: Ctx, q: HistoryQuery): Promise<ApiHistory | null> {
  if (q.accountId !== undefined) return accountHistory(ctx, q.accountId, q);
  const now = Date.now();
  const [nw, drawn] = await Promise.all([netWorthRead(ctx, !!q.includeHidden, { base: true, split: true }), readDrawState(ctx)]);
  return netWorthHistoryOf(nw, q, drawn, await netWorthRates(ctx, nw, now));
}

/** Net worth now and its history, from one read of each (get_net_worth).
 *  With `base`, converted into the home currency the person chose. */
export async function readNetWorthAndHistory(ctx: Ctx, q: Omit<HistoryQuery, 'accountId'>, opts: { base?: boolean } = {}): Promise<{ now: ApiNetWorth; history: ApiHistory }> {
  const now = Date.now();
  const [nw, drawn] = await Promise.all([netWorthRead(ctx, !!q.includeHidden, { base: opts.base, split: opts.base }), readDrawState(ctx)]);
  const fx = await netWorthRates(ctx, nw, now);
  return { now: netWorthOf(nw, fx, now), history: netWorthHistoryOf(nw, q, drawn, fx) };
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
  /** The name of the person's category it is filed under (lib/categories.ts:
   *  the one they chose for it, else the one Plaid's category files into),
   *  null when nothing says one. */
  category: string | null;
  /** That category's id (the uncategorized one's for a row that says
   *  nothing), and its group's id and name. The ids are null for a category
   *  the app hasn't stored yet. */
  category_id: string | null;
  group_id: string | null;
  group: string | null;
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
   *  'import:csv' or 'import:qif' for one imported from a file, into a manual
   *  account (lib/import/), served as the typed ones are, or into a linked
   *  account (lib/history-import/), served beside the bank's where no bank row
   *  supersedes it. Open: version 1 may add values. */
  source: string;
  hidden: boolean;
  /** The person's note on it: one written with a row they entered or
   *  imported, or put on a bank's row. */
  note: string | null;
  counterparty: string | null;
  payment_channel: string | null;
  city: string | null;
  region: string | null;
  website: string | null;
  /** The tags it carries (lib/tags.ts), in the order they were made: put
   *  on by the person, carried from an earlier account, or added by a rule. */
  tags: { id: string; name: string }[];
  /** The person's rules that match it (lib/rules.ts), in the order they run. */
  rule_ids: string[];
  /** It is excluded because a rule hides it, not by the person's own hand. */
  excluded_by_rule: boolean;
  /** Split into parts (#39, lib/split-rows.ts): each part, in order, and
   *  null when it isn't split. The transaction is listed once, whole, as the
   *  bank has it (its own category stays, as it was before splits existed);
   *  its parts are what spending, budgets and categories count. */
  splits: ApiSplitPart[] | null;
  /** In a group of transactions that count as one net amount (a dinner and
   *  what a friend paid back): the group, and null when it isn't in one. Each
   *  of a group's transactions is listed on its own; the group's net is what
   *  spending, budgets and categories count. */
  transaction_group: ApiTransactionGroup | null;
  /** The review queue (lib/review-layer.ts): true when it waits for the
   *  person to approve it (the queue is on, and it came from the bank,
   *  SimpleFIN or a file since the queue's first day, with no approval that
   *  still holds), false when it doesn't, null when that couldn't be read. */
  needs_review: boolean | null;
  /** When the person approved it, as it is now (null when they haven't, or
   *  the bank changed its amount since). An approved transaction stays in
   *  the category it was approved under, whatever a later rule says. */
  reviewed_at: string | null;
};

/** One part of a split transaction. */
export type ApiSplitPart = {
  /** The part's id, which stays while the part does; null for the part that
   *  holds what the bank changed since the split (`remainder`). */
  id: string | null;
  /** Plaid's sign, as the transaction's. */
  amount: number;
  /** Its category's name, id, and group's id and name, as a transaction's. */
  category: string | null;
  category_id: string | null;
  group_id: string | null;
  group: string | null;
  note: string | null;
  /** Left out of budgets and reports: the whole transaction excluded, or
   *  this part on its own; null when that couldn't be read (it counts). */
  excluded: boolean | null;
  /** The part that holds what the bank changed the amount by since the
   *  split, filed as the whole transaction is, until the split is edited. */
  remainder: boolean;
};

/** A group of transactions that count as one net amount. */
export type ApiTransactionGroup = {
  id: string;
  name: string;
  /** The day its net counts on: its earliest transaction's when it was saved. */
  date: string;
  /** Its transactions here, added up (Plaid's sign): what is counted. Null
   *  when the group's day is before the window read, so its net counts there
   *  and isn't known here: its transactions here count in no total. */
  net: number | null;
  currency: string | null;
  /** The category its net is filed under: name, id, and its group's id and
   *  name (a category group, as transactions[].group is). */
  category: string | null;
  category_id: string | null;
  category_group_id: string | null;
  category_group: string | null;
  /** How many of its transactions are here, and how many aren't (removed by
   *  the bank, on a hidden account, or not read this time): the net is of
   *  those here. */
  transactions: number;
  missing: number;
};

/** An id as the API shows it: null for a provisional one (see CATEGORIES). */
const shownId = (id: string | null | undefined): string | null => (id && !isProvisionalId(id) ? id : null);

/** A category's and its group's names and ids, as answers show them, from
 *  its id (a bucket of lib/totals.ts). */
function describer(ix: CategoryIndex): (bucket: string) => Described {
  return (bucket) => {
    const c = categoryById(ix, bucket);
    if (!c) return { category: bucket, category_id: null, group_id: null, group: null };
    const g = groupOf(ix, c);
    return { category: c.name, category_id: shownId(c.id), group_id: shownId(g.id), group: g.name };
  };
}

/** A category's name, id and group, as an answer shows them, from a filed
 *  row. */
function filedAs(t: Pick<Txn, 'category' | 'category_id' | 'category_name'>, ix: CategoryIndex): { category: string | null; category_id: string | null; group_id: string | null; group: string | null } {
  const filed = t.category_id ? categoryById(ix, t.category_id) : null;
  const group = filed ? groupOf(ix, filed) : null;
  return { category: t.category_name !== undefined ? t.category_name : t.category, category_id: shownId(t.category_id), group_id: shownId(group?.id), group: group?.name ?? null };
}

/** A split transaction's parts as the API shows them. */
function splitsOf(parts: readonly Txn[], ix: CategoryIndex): ApiSplitPart[] {
  return parts.map((p) => ({
    id: p.transaction_id.startsWith(PART_PREFIX) ? p.transaction_id.slice(PART_PREFIX.length) : null,
    amount: p.amount,
    ...filedAs(p, ix),
    note: p.note ?? null,
    excluded: p.excluded === true ? true : p.excluded === null ? null : false,
    remainder: p.split_remainder !== undefined,
  }));
}

/** The group of a transaction whose group counts on a day before the window
 *  read (lib/split-rows.ts group_outside): as a group is shown, its net null. */
function outsideGroupOf(t: Txn, ix: CategoryIndex): ApiTransactionGroup {
  const o = t.group_outside!;
  const c = categoryById(ix, o.category_id);
  const g = c ? groupOf(ix, c) : null;
  return {
    id: o.id,
    name: o.name,
    date: o.date,
    net: null,
    currency: currencyOf(t),
    category: c?.name ?? null,
    category_id: shownId(c?.id),
    category_group_id: shownId(g?.id),
    category_group: g?.name ?? null,
    transactions: o.here,
    missing: o.missing,
  };
}

/** A group's row as the API shows the group (lib/split-rows.ts). */
function groupOfRow(row: Txn, ix: CategoryIndex): ApiTransactionGroup {
  const filed = filedAs(row, ix);
  return {
    id: row.group_id!,
    name: row.name,
    date: row.date,
    net: row.amount,
    currency: currencyOf(row),
    category: filed.category,
    category_id: filed.category_id,
    category_group_id: filed.group_id,
    category_group: filed.group,
    transactions: row.group_members?.length ?? 0,
    missing: (row.group_missing ?? 0) + (row.group_removed ?? 0),
  };
}

function toApiTransaction(
  t: WithParts<Txn>,
  hidden: Set<string>,
  ix: CategoryIndex,
  tagNames: ReadonlyMap<string, string>,
  groups: ReadonlyMap<string, ApiTransactionGroup> = new Map()
): ApiTransaction {
  const account = t.account_id ?? '';
  const filed = t.category_id ? categoryById(ix, t.category_id) : null;
  const group = filed ? groupOf(ix, filed) : null;
  return {
    id: t.transaction_id,
    date: t.date,
    datetime: t.datetime,
    amount: t.amount,
    currency: currencyOf(t),
    name: t.name,
    category: t.category_name !== undefined ? t.category_name : t.category,
    category_id: shownId(t.category_id),
    group_id: shownId(group?.id),
    group: group?.name ?? null,
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
    tags: (t.tags ?? []).filter((id) => tagNames.has(id)).map((id) => ({ id, name: tagNames.get(id)! })),
    rule_ids: t.rule_ids ?? [],
    excluded_by_rule: t.excluded_by_rule === true,
    splits: t.split_parts ? splitsOf(t.split_parts, ix) : null,
    transaction_group: t.group_outside ? outsideGroupOf(t, ix) : (t.group_id !== undefined && groups.get(t.group_id)) || null,
    needs_review: t.needs_review === true ? true : t.review_unknown ? null : false,
    reviewed_at: t.reviewed_at ?? null,
  };
}

/** Each tag's name, by id: the tags that exist. */
const namesOf = (set: TagSet | null): Map<string, string> => new Map((set?.tags ?? []).map((t) => [t.id, t.name]));

/** Where an institution's transactions come from, and as of when; or why it
 *  brings in none (lib/item-products.ts). */
export type ApiSource = { institution: string; synced_at: string | null; complete: boolean; no_transactions: NoTransactionsReason | null };

export type ActivityRead = {
  rows: Txn[];
  history: OlderTxn[];
  /** The read layer's notes, the tags' among them (`tags_note`, also apart,
   *  for an answer that shows no tags: lib/api-cash-flow.ts). */
  notes: string[];
  tags_note: string | null;
  sources: ApiSource[];
  hidden: Set<string>;
  view: NoTransactionsView;
  ix: CategoryIndex;
  /** The tags that exist (lib/tags.ts), or null: none saved, or unreadable (said in notes). */
  tags: TagSet | null;
};

/** A linked institution as a source of transactions. */
const apiSourceOf = (s: BankSource): ApiSource => ({
  institution: s.institution_name,
  synced_at: s.synced_at,
  complete: s.coverage === 'complete',
  no_transactions: s.no_transactions,
});

/** The Activity tab's rows, as stored (lib/activity.ts), never syncing, with
 *  the connections that bring in none, as the app's views weigh them
 *  (lib/no-transactions.ts), each that doesn't bring its transactions in with
 *  what the files imported into its accounts cover, as the app's are sent
 *  (lib/history-import/without-files.ts, lenient), the rows before them that
 *  recurring detection needs (`history`), and the categories they were filed
 *  by (`ix`), grown in memory where the app hasn't yet (see CATEGORIES). */
export async function readActivity(ctx: Ctx, includeHidden: boolean): Promise<ActivityRead> {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, includeHidden, withAccountIds: true });
  const view = noTransactionsView(bank.payload);
  const [{ transactions, notes, tags_note, history, taxonomy, tags }, fed, without] = await Promise.all([
    finishActivity(ctx, bank.payload, includeHidden ? new Set() : bank.hidden),
    // LENIENT, for this display only: what can't be read is said by the
    // assembly's own notes. One that ended holds no bank.
    connectorBanksReport(ctx, Date.now(), endedNowIds(bank.lifecycle)),
    withImportedFiles(ctx, view.without),
  ]);
  const fedSources = connectorSources(fed, includeHidden ? new Set() : bank.hidden);
  return {
    rows: transactions,
    history,
    notes: [...notes, ...(tags_note ? [tags_note] : []), ...fedSources.notes],
    tags_note,
    ix: indexTaxonomy(taxonomy),
    tags,
    sources: [...bank.sources.map(apiSourceOf), ...fedSources.sources],
    hidden: bank.hidden,
    view: { ...view, without },
  };
}

/**
 * Each bank a SimpleFIN connection reaches, as a source of transactions: when
 * it last synced cleanly, and whether its older history is all in (fetched a
 * window a night, lib/connectors/sync.ts), with a note when it isn't. A bank
 * whose every account is `hidden` isn't one.
 */
function connectorSources(fed: ConnectorBanksReport, hidden: ReadonlySet<string>): { sources: ApiSource[]; notes: string[] } {
  const sources: ApiSource[] = [];
  const notes: string[] = [];
  for (const card of fed.cards) {
    if (card.accounts.every((a) => hidden.has(a.account_id))) continue;
    const kind = card.connector ?? 'simplefin';
    const label = connectorLabel(kind);
    const conn = card.connection_id ? fed.connections.get(card.connection_id) : undefined;
    const unread = !!card.connection_id && fed.unreadableConnections.has(card.connection_id);
    const history = conn?.history ?? null;
    const complete = !unread && history !== null && history.complete;
    sources.push({ institution: card.institution_name, synced_at: card.health?.last_ok_at ?? null, complete, no_transactions: null });
    if (complete) continue;
    if (unread) notes.push(`${card.institution_name}: what Nya keeps about its ${label} connection couldn’t be read, so whether its transactions are all here isn’t known`);
    else if (history === null) notes.push(`${card.institution_name}: no transactions have come from ${label} yet`);
    // SimpleFIN's come 90 days a window; Lunch Flow's two years at once, and
    // what is older in one more (lib/connectors/lunchflow.ts).
    else notes.push(`${card.institution_name}: older transactions are still arriving from ${label}, ${kind === 'lunchflow' ? 'with its next daily update' : 'a few months each night'}`);
  }
  return { sources, notes };
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
export function withoutTransactionsNotes(view: NoTransactionsView, rows: number, kind: 'list' | 'totals'): string[] {
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
   *  category, the note and the names of its tags. */
  text?: string;
  /** A category's name as listed (categories), in any case: "other" for
   *  none, while the uncategorized category is named so. */
  category?: string;
  /** A category's id (categories): rows filed under it, or under one merged
   *  into it. An id no category has is a 404 (NotFound). */
  categoryId?: string;
  /** A tag's name as listed (tags), in any case: rows carrying it. */
  tag?: string;
  /** A tag's id (tags): rows carrying it. An id no tag has is a 404
   *  (NotFound). */
  tagId?: string;
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
  // Asked by tag: tags that can't be read are a 409 (unreadable), never "no
  // tag has that id" or no transactions.
  const [activity] = await Promise.all([readActivity(ctx, !!q.includeHidden), q.tagId !== undefined || q.tag !== undefined ? readTagSet(ctx) : null]);
  const text = q.text?.toLowerCase();
  const category = q.category?.toLowerCase();
  const describe = describer(activity.ix);
  const wanted = q.categoryId === undefined ? undefined : categoryById(activity.ix, q.categoryId);
  if (wanted === null || (wanted && isProvisionalId(wanted.id))) throw new NotFound('No category has that id: list them with categories.');
  const tagNames = namesOf(activity.tags);
  if (q.tagId !== undefined && !tagNames.has(q.tagId)) throw new NotFound('No tag has that id: list them with tags.');
  // A name no tag has matches nothing, as a category's does.
  const byName = q.tag === undefined ? undefined : (activity.tags?.tags.find((t) => tagNameKey(t.name) === tagNameKey(q.tag!))?.id ?? null);
  const tagged = (t: Txn) => (q.tagId === undefined || !!t.tags?.includes(q.tagId)) && (byName === undefined || (byName !== null && !!t.tags?.includes(byName)));
  const tagText = (t: Txn) => (t.tags ?? []).map((id) => tagNames.get(id));
  // Each transaction once, as the bank has it (lib/split-rows.ts): a split
  // one whole with its parts, a group's each on its own beside its group.
  // A category, or text, finds one by its parts and its group too.
  const groups = new Map(activity.rows.filter((t) => t.group_members).map((t) => [t.group_id!, t] as const));
  const shownGroups = new Map([...groups].map(([id, row]) => [id, groupOfRow(row, activity.ix)] as const));
  const filedUnder = (t: WithParts<Txn>): Txn[] => [t, ...(t.split_parts ?? []), ...(t.group_id !== undefined && groups.has(t.group_id) ? [groups.get(t.group_id)!] : [])];
  const matching = bankRows(activity.rows)
    .filter((t) => t.date >= q.from && t.date <= q.to)
    .filter((t) => !q.accountIds || q.accountIds.has(t.account_id ?? ''))
    .filter((t) => category === undefined || filedUnder(t).some((f) => describe(bucketOf(f)).category.toLowerCase() === category))
    .filter((t) => wanted === undefined || filedUnder(t).some((f) => categoryById(activity.ix, bucketOf(f))?.id === wanted.id))
    .filter((t) => (q.minAmount === undefined || t.amount >= q.minAmount) && (q.maxAmount === undefined || t.amount <= q.maxAmount))
    .filter(tagged)
    .filter(
      (t) =>
        !text ||
        [t.name, t.counterparty, t.category_name, t.subcategory, t.note, ...tagText(t), ...filedUnder(t).slice(1).flatMap((f) => [f.category_name, f.note, f.group_members ? f.name : null])].some(
          (f) => typeof f === 'string' && f.toLowerCase().includes(text)
        )
    )
    .map((t) => toApiTransaction(t, activity.hidden, activity.ix, tagNames, shownGroups))
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
    // A bank whose files cover the range in its place has its rows here.
    notes: [...activity.notes, ...withoutTransactionsNotes(coveredOutOfDays(activity.view, q.from, q.to), activity.rows.length, 'list')],
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
  /** Its id, and its group's id and name (the ids null for a category the
   *  app hasn't stored yet); the kind it counts as (its group's); archived:
   *  hidden from the app's lists to choose from. */
  id: string | null;
  group_id: string | null;
  group: string | null;
  kind: CategoryKind;
  archived: boolean;
};

/** A group and every category in it, used or not, in the app's order. */
export type ApiCategoryGroup = {
  id: string | null;
  name: string;
  kind: CategoryKind;
  categories: { id: string | null; name: string; archived: boolean }[];
};

/** Budgets as an answer reads them. */
type BudgetsRead = { ix: CategoryIndex; placed: ReturnType<typeof placeBudgets> };

/** The budgets (lib/budget-store.ts budgetsForReading, strict) against the
 *  categories the transactions were filed by, grown in memory by any name a
 *  budget was saved under that they lack. */
async function readBudgetSet(ctx: Ctx, ix: CategoryIndex): Promise<BudgetsRead> {
  const { budgets, taxonomy } = await budgetsForReading(ctx, ix.taxonomy);
  const bix = indexTaxonomy(taxonomy);
  return { ix: bix, placed: placeBudgets(budgets, bix) };
}

/** The categories in use, on transactions in the window or with a budget,
 *  and every group with every category in it. */
export async function readCategories(
  ctx: Ctx,
  opts: { includeHidden?: boolean } = {}
): Promise<{ from: string; categories: ApiCategory[]; groups: ApiCategoryGroup[]; sources: ApiSource[]; notes: string[] }> {
  const activity = await readActivity(ctx, !!opts.includeHidden);
  // Which categories have a budget is a detail here: budgets that can't be
  // read are said, not a reason to answer nothing.
  const budgets = await readBudgetSet(ctx, activity.ix).then(
    (b) => ({ ok: true as const, ...b }),
    () => ({ ok: false as const })
  );
  const ix = budgets.ok ? budgets.ix : activity.ix;
  // Transactions, not rows: a split one's parts in one category are one
  // there (lib/spending.ts transactionCounter).
  const seen = new Map<string, { counter: ReturnType<typeof transactionCounter>; last_date: string | null }>();
  for (const t of activity.rows) {
    const c = seen.get(bucketOf(t)) ?? { counter: transactionCounter(), last_date: null };
    c.counter.add(t);
    if (!c.last_date || t.date > c.last_date) c.last_date = t.date;
    seen.set(bucketOf(t), c);
  }
  const budgeted = new Set(budgets.ok ? budgets.placed.categories.keys() : []);
  for (const id of budgeted) if (!seen.has(id)) seen.set(id, { counter: transactionCounter(), last_date: null });
  const notes = [
    ...activity.notes,
    ...(budgets.ok ? [] : ['Budgets: couldn’t be read, so which categories have one isn’t said']),
    ...withoutTransactionsNotes(activity.view, activity.rows.length, 'list'),
  ];
  const describe = describer(ix);
  const categories = [...seen].map(([bucket, c]): ApiCategory => {
    const filed = categoryById(ix, bucket);
    const kind = filed ? groupOf(ix, filed).kind : isTransfer({ category: bucket, transaction_code: null }) ? 'transfer' : 'expense';
    const d = describe(bucket);
    return {
      name: d.category,
      transactions: c.counter.n,
      last_date: c.last_date,
      budgeted: budgeted.has(bucket),
      transfer: kind === 'transfer',
      id: d.category_id,
      group_id: d.group_id,
      group: d.group,
      kind,
      archived: !!filed?.archived,
    };
  });
  return {
    from: firstDay(),
    categories: categories.sort((a, b) => a.name.localeCompare(b.name)),
    groups: sortedGroups(ix.taxonomy).map((g) => ({
      id: shownId(g.id),
      name: g.name,
      kind: g.kind,
      categories: categoriesIn(ix.taxonomy, g.id).map((c) => ({ id: shownId(c.id), name: c.name, archived: !!c.archived })),
    })),
    sources: activity.sources,
    notes,
  };
}

// ---- Budgets ----

/** A budget's rollover in the month asked about (lib/rollover.ts Carry): the
 *  month its carry counts from and why, the month its rollover began, the
 *  carry, and the months it counts whose transactions may be incomplete. */
export type ApiRollover = { from: string; why: CarryFrom; start: string; carry: number; uncertain_months: string[] };

/** The income pool when income carryover is on (lib/rollover.ts IncomePool). */
export type ApiIncomePool = {
  start: string;
  from: string;
  carried_in: number;
  income: number;
  spending: number;
  available: number;
  uncertain_months: string[];
  months: { month: string; carried_in: number; income: number; spending: number; carried_out: number; uncertain: boolean }[];
};

export type ApiBudgets = {
  month: string;
  /** The currency the budgets count, and are in: the one most transactions
   *  are in, as the app's. */
  currency: string | null;
  /** Each category's budget that month (what it was then), with its id and
   *  its group's (null for one the app hasn't stored yet), and, beside it
   *  (#37), what is available with what rolled over. */
  budgets: {
    category: string;
    budget: number;
    spent: number;
    remaining: number;
    spent_share: number;
    category_id: string | null;
    group_id: string | null;
    group: string | null;
    available: number;
    available_remaining: number;
    rollover: ApiRollover | null;
    assumed: boolean;
  }[];
  /** Each group with a budget of its own or budgeted categories, in the
   *  app's order: its limit by the reconcile rule (lib/budget-set.ts), its own
   *  amount and its categories' added up, and what counts against the limit
   *  (everything in it under a budget of its own, else its budgeted
   *  categories' spending). `reconcile` says which side binds when the two
   *  differ. The same over what is available, with carries (#37), beside it. */
  groups: {
    id: string | null;
    name: string;
    kind: CategoryKind;
    budget: number;
    own: number | null;
    categories_budget: number;
    spent: number;
    remaining: number;
    spent_share: number;
    reconcile: { binds: 'group' | 'categories'; group: number; categories: number } | null;
    available: number;
    available_remaining: number;
    available_reconcile: { binds: 'group' | 'categories'; group: number; categories: number } | null;
    rollover: ApiRollover | null;
    assumed: boolean;
  }[];
  /** Every limit added up (each group's, so nothing counts twice), and what
   *  counts against them; `available` the same with what rolled over. */
  total: { budget: number; spent: number; available: number };
  /** This month's spending left out for being in another currency. */
  left_out: LeftOut;
  left_out_text: string | null;
  /** This month's transactions the person excluded (left out), and those
   *  whether they did couldn't be read (counted). */
  excluded: number;
  exclusion_unknown: number;
  /** The month budgets began to be kept by month: an amount before it is
   *  assumed (`assumed`). */
  recorded_since: string;
  /** The first month with any transactions: no carry or pool counts before it. */
  earliest_month: string | null;
  /** Months read for this answer whose transactions may be incomplete, and why. */
  incomplete_months: { month: string; reasons: string[] }[];
  /** The income pool, when income carryover is on; null when it is off. */
  income: ApiIncomePool | null;
  /** What the earlier months a carry or the income pool counts left out for
   *  being in another currency, and the same in words. */
  rollover_left_out: LeftOut;
  rollover_left_out_text: string | null;
  sources: ApiSource[];
  notes: string[];
};

const share = (spent: number, budget: number) => (budget > 0 ? Math.round((spent / budget) * 1000) / 1000 : 0);

/** A carry as the API answers it. */
const apiRollover = (c: Carry | undefined): ApiRollover | null =>
  c ? { from: c.from, why: c.why, start: c.start, carry: tidy(c.carry), uncertain_months: c.uncertain } : null;

/** A sentence's first letter in capitals. */
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Months (YYYY-MM, oldest first) for a note: up to three named, else how
 *  many since the first, never implying they run on. */
const monthList = (ms: readonly string[]): string =>
  ms.length <= 3 ? (ms.length <= 1 ? (ms[0] ?? '') : `${ms.slice(0, -1).join(', ')} and ${ms[ms.length - 1]}`) : `${ms.length} months since ${ms[0]}`;

/**
 * Monthly budgets with the month's spending against each, as the Budgets tab
 * works it out (lib/budget-month.ts: the same read and the same math,
 * lib/rollover.ts): each budget's amount that month, what it carries into it
 * when it rolls over, what is available, and the income pool when income
 * carryover is on. Spending is read from the stored history, back to the
 * month asked about, or the first month a carry counts. Writes nothing.
 */
export async function readBudgets(ctx: Ctx, opts: { month: string; includeHidden?: boolean }): Promise<ApiBudgets> {
  const today = new Date().toISOString().slice(0, 7);
  return budgetsAnswer(await readBudgetMonth(ctx, { month: opts.month, today, includeHidden: !!opts.includeHidden }), opts);
}

/** readBudgets' answer from a month already read: no reads, no writes. For a
 *  reader that looks at the read first (a budgets share, lib/share-views.ts,
 *  asks whether its transactions could all be read). */
export function budgetsAnswer(read: BudgetMonthRead, opts: { month: string; includeHidden?: boolean }): ApiBudgets {
  const today = read.today;
  const { ix, view, currency, activity } = read;
  const spent = new Map(Object.entries(read.spent));
  const describe = describer(ix);
  const placed = placeBudgets(view.budgets, ix);
  const assumed = { categories: new Set(view.assumed.categories), groups: new Set(view.assumed.groups) };
  const flat = budgetMeters(ix, placed, spent);
  const withCarries = availableMeters(ix, view.budgets, view.carries, spent);
  const availableOf = new Map<string, GroupMeter>(withCarries.groups.map((g) => [g.group.id, g]));
  const rows = [...placed.categories]
    .map(([id, budget]) => {
      const s = spent.get(id) ?? 0;
      const available = tidy(budget + (view.carries.categories[id]?.carry ?? 0));
      const { category, category_id, group_id, group } = describe(id);
      return {
        category,
        budget: tidy(budget),
        spent: tidy(s),
        remaining: tidy(budget - s),
        spent_share: share(s, budget),
        category_id,
        group_id,
        group,
        available,
        available_remaining: tidy(available - s),
        rollover: apiRollover(view.carries.categories[id]),
        assumed: assumed.categories.has(id),
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category));
  const fed = connectorSources(activity.fed, opts.includeHidden ? new Set() : activity.hidden);
  const windowRows = activity.rows.filter((t) => t.date >= windowStart()).length;
  // A bank whose files cover the month in its place is counted, as the
  // Budgets tab counts it (lib/no-transactions.ts coveredOutOf).
  const notes = [...activity.notes, ...fed.notes, ...withoutTransactionsNotes(coveredOutOf(activity.view, opts.month), windowRows, 'totals')];
  const orphans = placeBudgets(read.budgetsNow, ix).orphans;
  if (orphans.length > 0) {
    notes.push(`${orphans.length} budget${orphans.length === 1 ? ' is' : 's are'} on a category or group that no longer exists, and left out here`);
  }
  // Nothing is counted past this month (lib/rollover.ts budgetsInMonth).
  if (opts.month > today) notes.push(`${opts.month} hasn’t begun, so nothing has rolled into it yet, and no income pool is worked out for it`);
  // The month's own spending, and what the carries and the pool count, when
  // a month may be incomplete: said here as well as in incomplete_months,
  // which a client may not read, so no figure looks complete when it isn't.
  // A connection that brings in no transactions is said by its own note.
  const day = (d: string) => d.slice(0, 10);
  const own = (read.gaps.find((g) => g.month === opts.month)?.gaps ?? []).filter((g) => g.kind !== 'without');
  if (read.earliest !== null && opts.month < read.earliest) {
    notes.push(`No transactions are stored from before ${read.earliest}, so nothing is counted as spent in ${opts.month}`);
  } else if (own.length > 0) {
    notes.push(`${opts.month} may be incomplete, so what is spent may be off: ${own.map((g) => gapText(g, day)).join('; ')}`);
  }
  const counted = [...new Set([...Object.values(view.carries.categories), ...Object.values(view.carries.groups)].flatMap((c) => c.uncertain))].sort();
  const pooled = read.pool?.uncertain ?? [];
  if (counted.length > 0 || pooled.length > 0) {
    const what = counted.length > 0 && pooled.length > 0 ? 'What rolled over and the income pool count' : counted.length > 0 ? 'What rolled over counts' : 'The income pool counts';
    notes.push(`${what} months that may be incomplete (${monthList([...new Set([...counted, ...pooled])].sort())}), so ${counted.length > 0 && pooled.length > 0 ? 'they' : 'it'} may be off: see incomplete_months`);
  }
  const reconcileOf = (r: GroupMeter['reconcile']) => r && { binds: r.binds, group: tidy(r.group), categories: tidy(r.categories) };
  const leftOut = leftOutByCurrency(read.monthRows.filter((t) => t.amount > 0), currency);
  return {
    month: opts.month,
    currency,
    budgets: rows,
    groups: flat.groups
      .filter((m) => m.limit !== null)
      .map((m) => {
        const a = availableOf.get(m.group.id)!;
        return {
          id: shownId(m.group.id),
          name: m.group.name,
          kind: m.group.kind,
          budget: tidy(m.limit!),
          own: m.own === null ? null : tidy(m.own),
          categories_budget: tidy(m.categories_total),
          spent: tidy(m.spent),
          remaining: tidy(m.limit! - m.spent),
          spent_share: share(m.spent, m.limit!),
          reconcile: reconcileOf(m.reconcile),
          available: tidy(a.limit!),
          available_remaining: tidy(a.limit! - a.spent),
          available_reconcile: reconcileOf(a.reconcile),
          rollover: apiRollover(view.carries.groups[m.group.id]),
          assumed: assumed.groups.has(m.group.id),
        };
      }),
    total: { budget: tidy(flat.total.budget), spent: tidy(flat.total.spent), available: tidy(withCarries.total.budget) },
    left_out: leftOut,
    left_out_text: leftOutText(leftOut, currency, { where: 'these budgets' }),
    // Transactions, not rows: a split one is one (transactionCounter).
    excluded: countTransactions(read.monthRows.filter((t) => t.excluded === true)),
    exclusion_unknown: countTransactions(read.monthRows.filter((t) => t.excluded === null)),
    recorded_since: view.recorded_since,
    earliest_month: read.earliest,
    // Days as UTC days, as every other date here.
    incomplete_months: read.gaps.map((g) => ({ month: g.month, reasons: g.gaps.map((x) => capital(gapText(x, (d) => d.slice(0, 10)))) })),
    income: read.pool && {
      start: read.pool.start,
      from: read.pool.from,
      carried_in: read.pool.carried_in,
      income: read.pool.income,
      spending: read.pool.spending,
      available: read.pool.available,
      uncertain_months: read.pool.uncertain,
      months: read.pool.months,
    },
    rollover_left_out: read.countedLeftOut,
    rollover_left_out_text: leftOutText(read.countedLeftOut, currency, { where: 'what rolled over from earlier months', plural: false }),
    sources: [...activity.bank.sources.map(apiSourceOf), ...fed.sources],
    notes,
  };
}

// ---- Spending ----

export type ApiSpending = Summary & {
  from: string;
  to: string;
  /** Money out by group, most first, with how many rows each sums: the
   *  categories' rolled up (ids null for one the app hasn't stored yet). */
  groups: { id: string | null; name: string; kind: CategoryKind; spent: number; transactions: number }[];
  /** Money out by tag, most first (lib/tag-totals.ts): each counted outflow
   *  under every tag its row carries, so a tag is exactly what its rows add
   *  to the categories, and a row with two tags is in both. */
  tags: { id: string; name: string; spent: number; transactions: number }[];
  sources: ApiSource[];
  notes: string[];
};

/**
 * How many of the transactions of [from, to] were imported into linked
 * accounts from files (the bank's, or another app's export: lib/migration)
 * rather than sent by the bank (#52), in the
 * words under the month's totals and beside the chart (lib/history-import/
 * view.ts importedRowsNote): a whole month named as the chart names one
 * ("September 2026"), any other range as this period. Null with none. The
 * last of spending's notes, and of the cash flow's (lib/api-cash-flow.ts).
 */
export function importedNote(rows: readonly Txn[], range: { from: string; to: string }): string | null {
  const { from, to } = range;
  const whole = from.endsWith('-01') && to === lastDayOf(from.slice(0, 7));
  return importedRowsNote(
    rows.filter((t) => t.date >= from && t.date <= to),
    whole ? monthName(from.slice(0, 7)) : 'this period'
  );
}

/** Money in and out over [from, to], and spending by category and by group,
 *  in one currency: by default the one most transactions are in, as the
 *  app's totals. */
export async function readSpending(ctx: Ctx, opts: { from: string; to: string; currency?: string; includeHidden?: boolean }): Promise<ApiSpending> {
  const activity = await readActivity(ctx, !!opts.includeHidden);
  const currency = opts.currency ?? totalsCurrency(activity.rows);
  // The tags' note stays: spending by tag is in the answer. A bank whose
  // files cover the range in its place is counted, as in the app.
  const notes = [...activity.notes, ...withoutTransactionsNotes(coveredOutOfDays(activity.view, opts.from, opts.to), activity.rows.length, 'totals')];
  if (opts.from < firstDay()) notes.push(`Only transactions from ${firstDay()} on are read`);
  // Last, as under the month's totals: how many of the range's transactions
  // came from files rather than the bank.
  const imported = importedNote(activity.rows, opts);
  if (imported) notes.push(imported);
  const inRange = (d: string) => d >= opts.from && d <= opts.to;
  // Groups add up what the categories do: money out that counts.
  const groups = new Map<string, { group: CategoryGroup; spent: number; transactions: ReturnType<typeof transactionCounter> }>();
  for (const t of activity.rows) {
    if (!inRange(t.date) || t.amount <= 0 || !countsInTotals(t, currency)) continue;
    const c = categoryById(activity.ix, bucketOf(t));
    if (!c) continue;
    const g = groupOf(activity.ix, c);
    const e = groups.get(g.id) ?? { group: g, spent: 0, transactions: transactionCounter() };
    e.spent += t.amount;
    e.transactions.add(t);
    groups.set(g.id, e);
  }
  return {
    from: opts.from,
    to: opts.to,
    ...summarize(activity.rows, inRange, currency, describer(activity.ix)),
    groups: [...groups.values()]
      .sort((a, b) => b.spent - a.spent || a.group.name.localeCompare(b.group.name))
      .map((e) => ({ id: shownId(e.group.id), name: e.group.name, kind: e.group.kind, spent: tidy(e.spent), transactions: e.transactions.n })),
    tags: spendingByTag(activity.rows, inRange, currency).flatMap((s) => {
      const name = namesOf(activity.tags).get(s.tag);
      return name === undefined ? [] : [{ id: s.tag, name, spent: s.spent, transactions: s.transactions }];
    }),
    sources: activity.sources,
    notes,
  };
}

// ---- Recurring bills ----
//
// The one place the API reads lib/recurring.ts: what it detects becomes the
// API's shape here and nowhere else, so a change to the detection changes
// this section alone. Detected as the app detects them (components/Dashboard.tsx):
// from the window's rows and the rows before it a yearly bill needs
// (lib/activity.ts), each on its own account and cadence. Bills only, never
// income; never one the person marked not recurring (lib/planned.ts, matched
// to a series by dismissedSeries, as the app matches it); and their monthly
// total added up as the Budgets tab adds it (lib/totals.ts recurringMonthly).

export type ApiRecurring = {
  /** Detected from the transactions (charged on a schedule, weekly to yearly,
   *  at a steady or similar amount): an estimate, as is each next date. */
  bills: {
    name: string;
    institution: string;
    /** The account it is charged to; null when the rows didn't say. */
    account: string | null;
    amount: number;
    currency: string | null;
    cadence: Cadence;
    last_date: string;
    next_date: string;
    due_soon: boolean;
    /** Its expected dates went by with nothing arriving: it may have ended,
     *  and isn't in monthly_total. */
    ended: boolean;
    /** It pays a card off: the card's own charges are counted where they are
     *  charged, so it isn't in monthly_total. */
    pays_card: boolean;
  }[];
  /** What the bills come to in a month, in the budgets' currency, and the
   *  bills left out of it for being in another. */
  monthly_total: { currency: string | null; amount: number; left_out: LeftOut };
  /** due_soon means the next date is within this many days of today (UTC). */
  due_soon_days: number;
  sources: ApiSource[];
  notes: string[];
};

const DUE_SOON_DAYS = 7;
/** How far ahead next_date looks: past a yearly bill's next date. */
const NEXT_WITHIN_DAYS = 400;

/** The detected series the person marked not recurring, as saved
 *  (lib/planned.ts); null when they couldn't be read. */
async function readDismissed(ctx: Ctx): Promise<readonly string[] | null> {
  try {
    return (await plannedStore.get(ctx))?.dismissed ?? [];
  } catch {
    return null;
  }
}

export async function readRecurring(ctx: Ctx, opts: { includeHidden?: boolean; today?: string } = {}): Promise<ApiRecurring> {
  const [activity, dismissed] = await Promise.all([readActivity(ctx, !!opts.includeHidden), readDismissed(ctx)]);
  const today = opts.today ?? utcDay(Date.now());
  const series = detectRecurring([...activity.rows, ...activity.history]);
  const gone = dismissedSeries(series, dismissed ?? []);
  const bills = series.filter((s) => s.kind === 'bill' && !gone.has(s.id));
  const currency = totalsCurrency(activity.rows);
  const soon = new Set(upcomingBills(bills, DUE_SOON_DAYS, today).map((u) => u.series.id));
  const { total, leftOut } = recurringMonthly(bills, today, currency);
  const until = addDays(today, NEXT_WITHIN_DAYS);
  const notes = [...activity.notes, ...withoutTransactionsNotes(activity.view, activity.rows.length, 'totals')];
  if (dismissed === null) notes.push('Bills marked not recurring: couldn’t be read, so any you marked are listed and counted in monthly_total');
  return {
    bills: bills.map((b) => {
      const expected = expectedDates(b, today, until);
      return {
        name: b.name,
        institution: b.institution,
        account: b.account || null,
        amount: tidy(b.amount),
        currency: b.currency,
        cadence: b.cadence,
        last_date: b.lastDate,
        // Today for one that is late; for one that may have ended, the date
        // it was expected on.
        next_date: expected.dates[0]?.date ?? b.nextDate,
        due_soon: soon.has(b.id),
        ended: expected.status === 'ended',
        pays_card: b.paysCard === true,
      };
    }),
    monthly_total: { currency, amount: tidy(total), left_out: leftOut },
    due_soon_days: DUE_SOON_DAYS,
    sources: activity.sources,
    notes,
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
  /** When it ended, as on /accounts, or null while it is open: an account
   *  that ended counts in nothing from its day, and its positions are the
   *  last recorded before it. Version 1 gained it. */
  lifecycle: ApiLifecycle | null;
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
 * one account's; an id no account has is NotFound, and so is one known not to
 * be an investment account (listed as another kind, or kept by hand), but one
 * that may be at a connection whose accounts couldn't be read, or haven't
 * been loaded, is said to be so (complete: false, with the connections
 * named), never "no such account".
 */
export async function readHoldings(ctx: Ctx, opts: { includeHidden?: boolean; accountId?: string } = {}): Promise<ApiHoldings> {
  const read = await accountsRead(ctx, !!opts.includeHidden);
  const base = { links: read.links, ...(opts.includeHidden ? {} : { hidden: read.hidden }) };
  // Manual accounts hold no positions: only a connection missing can hide some.
  const missing = read.missing.filter((m) => m.account_id === null);
  const investment = read.accounts.filter((a) => a.source === 'plaid' && isInvestmentType(a.type) && (opts.accountId === undefined || a.id === opts.accountId));
  if (opts.accountId !== undefined && investment.length === 0) {
    if (read.hidden.has(opts.accountId) && !opts.includeHidden) throw new NotFound('That account is hidden: ask with include_hidden=true to see it.');
    const known = read.accounts.find((a) => a.id === opts.accountId);
    if (known && isConnectorKind(known.source)) {
      // Lunch Flow serves positions for some brokerages, which Nya doesn't
      // read yet (lib/connectors/lunchflow.ts HOLDINGS): its words say so.
      const why = known.source === 'lunchflow' ? 'and Nya reads its balance, not its positions' : 'which reports balances, not positions';
      throw new NotFound(`That account is kept up to date through ${connectorLabel(known.source)}, ${why}: it has no holdings.`);
    }
    // Known not to be an investment account (listed as another kind, or one
    // kept by hand, which no connection holds): whatever connection can't be
    // read, it has no holdings to be missing.
    if (known || isManualId(opts.accountId)) throw new NotFound('That account isn’t an investment account linked through Plaid, so it has no holdings.');
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
        lifecycle: a.lifecycle,
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
