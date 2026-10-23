// lib/fx/read.ts
//
// What a request converts with, read once (lib/fx/rates.ts FxTable): the
// person's settings, and, only when something is in a currency other than
// their home one, the ECB's fields for the currencies and days involved. Never
// a fetch: rates come only from the store the nightly fetch fills
// (lib/fx/ecb-fetch.ts). Server only.
//
// LENIENT, for showing figures (see lib/fx/settings.ts and
// lib/fx/ecb-store.ts): settings that can't be read convert nothing, and a
// field of rates that can't be used gives no rate on its days, each said in
// `problem` and `unusable`; nothing writes, deletes or records on a
// conversion. A deployment problem (storage out of reach) still throws.

import type { Ctx } from '../containers';
import { readSettingsForDisplay, type CurrencySettings } from './settings';
import { readEcbFields } from './ecb-store';
import { fieldsFor, tableFromFields, yearsFor, LATEST_FIELD, FETCH_FIELD } from './fields';
import { NO_FX, type FxTable } from './rates';
import { directoryCurrencies } from '../links';
import { getManualAccountsReport, MANUAL_CURRENCY } from '../manual';
import { rememberedAccountsReport } from '../last-known';

/** What a reader will convert: the currencies its amounts are in, and the
 *  days they fall on (the newest publication is always read). */
export type FxNeed = { currencies: Iterable<string>; from: string; to: string };

export type FxRead = {
  fx: FxTable;
  /** The settings couldn't be used, so nothing converts: say so. */
  problem: 'unreadable' | 'unrecognised' | null;
  /** Fields of rates that couldn't be used, by id (their days have no rate). */
  unusable: string[];
};

/** The currencies whose rates converting these amounts into `home` needs:
 *  each one other than home, home itself, and the quotes of the own rates
 *  that price them. The euro has no series of its own (its rate is 1), but a
 *  rate of the person's for it goes through its quote's, which is read. */
export function currenciesFor(given: Iterable<string>, fx: Pick<FxTable, 'home' | 'own'>): Set<string> {
  const out = new Set<string>();
  const home = fx.home!;
  const add = (c: string) => {
    if (c !== 'EUR') out.add(c);
    for (const o of fx.own) if (o.currency === c && o.quote !== 'EUR') out.add(o.quote);
  };
  let foreign = false;
  for (const c of given) {
    if (c === home) continue;
    foreign = true;
    add(c);
  }
  if (foreign) add(home);
  return out;
}

/** `known`: the settings as this request already read them, so they are
 *  read once. */
export async function readFx(ctx: Ctx, need: FxNeed, known?: { settings: CurrencySettings; problem: FxRead['problem'] }): Promise<FxRead> {
  const { settings, problem } = known ?? (await readSettingsForDisplay(ctx));
  if (!settings.home) return { fx: { ...NO_FX, own: settings.own }, problem, unusable: [] };
  const base = { home: settings.home, own: settings.own };
  const given = [...need.currencies];
  // Nothing in another currency: nothing to read, nothing to convert.
  if (!given.some((c) => c !== settings.home)) return { fx: { ...NO_FX, ...base }, problem, unusable: [] };
  const years = yearsFor(need.from <= need.to ? need.from : need.to, need.to >= need.from ? need.to : need.from);
  const ids = fieldsFor(currenciesFor(given, base), years);
  const { fields, unusable } = await readEcbFields(ids);
  return { fx: tableFromFields(fields, years, settings.home, settings.own, unusable), problem, unusable };
}

/** The newest publication and the last fetch alone, for the Currency card. */
export async function readLatestRates(): Promise<Pick<FxTable, 'latest' | 'fetch'> & { unusable: string[] }> {
  const { fields, unusable } = await readEcbFields([LATEST_FIELD, FETCH_FIELD]);
  const t = tableFromFields(fields, [], null, []);
  return { latest: t.latest, fetch: t.fetch, unusable };
}

/** A row of flows as readFlowFx reads it: its day, currency and account. */
type FlowRow = { date: string; iso_currency_code: string | null; unofficial_currency_code?: string | null; account_id?: string | null };

/** The currency of each of the person's accounts, as far as is known without
 *  asking a bank: the manual accounts', the remembered accounts' (linked ones
 *  as last loaded) and the account directory's, the first that knows one
 *  winning. LENIENT, for showing figures: an entry that can't be read is left
 *  out (its rows still bring their own currency). */
export async function accountCurrencies(ctx: Ctx): Promise<Map<string, string>> {
  const [manual, remembered, linked] = await Promise.all([getManualAccountsReport(ctx), rememberedAccountsReport(ctx), directoryCurrencies(ctx)]);
  const out = new Map<string, string>();
  const add = (id: string, c: string | null | undefined) => {
    if (c && !out.has(id)) out.set(id, c);
  };
  for (const a of manual.accounts) add(a.account_id, a.currency ?? MANUAL_CURRENCY);
  for (const accounts of Object.values(remembered.byItem)) for (const a of accounts) add(a.account_id, a.currency);
  for (const a of linked) add(a.account_id, a.currency);
  return out;
}

/** What a flow rates read needs of the person, read as early as the caller
 *  can (flowFxReader): the settings, and, once they say a home currency, the
 *  accounts' currencies. */
type Early = { settings: ReturnType<typeof readSettingsForDisplay>; accounts: Promise<Map<string, string> | null> };

/**
 * What the page converts its loaded transactions with (lib/fx/totals.ts):
 * the table for the rows' currencies, over the days from the oldest of them
 * to today; null without a home currency, or with settings that can't be
 * used, so every total is today's. Read after the transactions' cache, on
 * every load, never cached: a change of home currency or of a rate needs no
 * cache cleared.
 *
 * `accounts`: the currencies of the person's accounts too, so the Plan can
 * convert a year of spending into its accounts' currency when no row is in
 * it (lib/fire/inputs.ts trailingFlows), read only with a home currency
 * chosen. `also`: currencies the reader converts into (a report's asked
 * for). A row that says no currency takes its account's, where known
 * (FxTable.accounts), so it converts from it.
 *
 * Started early (flowFxReader returns the reading function at once): the
 * settings and the accounts' currencies are read beside the caller's own
 * reads, then the ECB's fields once the rows are known. LENIENT: what can't
 * be read of the rates (storage failing on them, a field damaged) leaves the
 * rows of other currencies without a rate, so every total leaves them out
 * and names them, never fails the load; settings that can't be read convert
 * nothing, as before.
 *
 * `publicRates` (a share, lib/share-views.ts): the ECB's rates alone, never
 * the person's own, so what only an own rate converts is left out and
 * named; and nothing converted when the home currency has no public rate.
 */
/** What a flows read is asked for (readFlowFx). */
type FlowOpts = { accounts?: boolean; also?: readonly string[]; publicRates?: boolean };

/** Whether the home currency can be converted into at the ECB's rates alone:
 *  the euro, or one its newest publication has. */
const publicHome = (fx: FxTable): boolean => fx.home === 'EUR' || (fx.latest !== null && fx.home !== null && Object.hasOwn(fx.latest.rates, fx.home));

export function flowFxReader(ctx: Ctx, opts: FlowOpts = {}): (rows: readonly FlowRow[], now?: number) => Promise<FxTable | null> {
  const settings = readSettingsForDisplay(ctx);
  const early: Early = {
    settings,
    accounts: settings.then(
      (s) => (s.settings.home && opts.accounts ? accountCurrencies(ctx).catch(() => new Map<string, string>()) : null),
      () => null
    ),
  };
  // Awaited below, or not at all when the caller fails first: never an
  // unhandled rejection.
  settings.catch(() => {});
  return (rows, now = Date.now()) => readWith(ctx, early, rows, now, opts);
}

/** readFlowFx, all at once. */
export async function readFlowFx(
  ctx: Ctx,
  rows: readonly FlowRow[],
  now: number = Date.now(),
  opts: FlowOpts = {}
): Promise<FxTable | null> {
  return flowFxReader(ctx, opts)(rows, now);
}

async function readWith(ctx: Ctx, early: Early, rows: readonly FlowRow[], now: number, opts: FlowOpts): Promise<FxTable | null> {
  const today = new Date(now).toISOString().slice(0, 10);
  let from = today;
  const currencies = new Set<string>();
  // The accounts of rows that say no currency, whose own is looked up.
  const unlabelled = new Set<string>();
  for (const r of rows) {
    const c = r.iso_currency_code || r.unofficial_currency_code;
    if (c) currencies.add(c);
    else if (r.account_id) unlabelled.add(r.account_id);
    if (r.date < from) from = r.date;
  }
  const read = await early.settings;
  if (!read.settings.home) return null;
  // A share's: the ECB's rates alone, never the person's own.
  const known = opts.publicRates ? { ...read, settings: { ...read.settings, own: [] } } : read;
  const home = known.settings.home!;
  // The accounts' currencies: all of them when asked, else only for rows
  // that say none (rare: the oldest stored history).
  const byAccount = (await early.accounts) ?? (unlabelled.size > 0 ? await accountCurrencies(ctx).catch(() => new Map<string, string>()) : null);
  if (opts.accounts && byAccount) for (const c of byAccount.values()) currencies.add(c);
  const accounts: Record<string, string> = {};
  for (const id of unlabelled) {
    const c = byAccount?.get(id);
    if (c) {
      accounts[id] = c;
      currencies.add(c);
    }
  }
  for (const c of opts.also ?? []) currencies.add(c);
  const labelled = Object.keys(accounts).length > 0 ? { accounts } : {};
  try {
    const { fx } = await readFx(ctx, { currencies, from, to: today }, known);
    if (!fx.home) return null;
    // A share converts nothing when the home currency has no public rate, or
    // nothing in another currency needed one: as before a home currency.
    if (opts.publicRates && !publicHome(fx)) return null;
    return { ...fx, ...labelled };
  } catch (err) {
    // The rates couldn't be read just now: none on any day, so what is in
    // another currency is left out and named, with that reason (`unread`).
    console.error('Exchange rates could not be read for the transactions', err instanceof Error ? err.name : err);
    const years = yearsFor(from <= today ? from : today, today);
    return { ...NO_FX, home, own: known.settings.own, missing_years: years, unread: true, ...labelled };
  }
}
