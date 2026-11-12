// lib/demo-seed/imports.ts
//
// The transactions a scenario imports from its brokerage's own download
// (lib/investment-imports.ts), made up: each import the profile's own rows
// for its accounts over its days, as Vanguard's file writes them and its
// reader reads them (lib/import/vanguard-transactions.ts for the CSV,
// lib/import/vanguard-qfx.ts for the QFX), written through the store the
// import route writes (lib/investment-imports-store.ts addImport), oldest
// first. So each says what Plaid's rows say, in the file's own words:
//
// - A CSV names each row's kind. A buy is a Buy and a sell a Sell; a cash
//   row is the Transaction Type `kinds` gives for the profile's name for it.
//   A conversion's money says it is one, which Plaid's row doesn't, so the
//   Plan never counts it as new savings. It covers its first row's day to
//   its last's.
// - A QFX says only that cash came in or went out (subtype `unlabeled`, never
//   new savings), and gives units to three places. It covers the days it
//   states: from its start to the day before it was made.
//
// Each day's deposits and withdrawals stay Plaid's, to the cent, so the
// months imported from the Performance page (lib/demo-seed/past-months.ts)
// still meet the activity. checkTransactionImports runs the imports through
// the app's own merge (withImportedRows) over the profile's rows, as Plaid's,
// before anything is emptied: each must be an import the store keeps, used,
// deciding days of its own, with no row of Plaid's taken for one of its own.

import { KINDS } from '../import/vanguard-transactions';
import { addImport, importKeys, importsFingerprint } from '../investment-imports-store';
import { dayBefore, isInvestmentImport, MAX_ACCOUNTS_PER_IMPORT, withImportedRows, type AccountImport, type ImportedRow, type InvestmentImport } from '../investment-imports';
import { dailyFlows, type InvestmentTxn } from '../investments';
import { isVanguard } from '../investment-months';
import type { InvSync } from '../invstore';
import { addDays, type DemoProfile, type SeedAccount, type SeedInvTxn } from './profiles';
import type { SeedImport } from './extras';
import type { SeedRun } from './fill';

const USD = 'USD';
/** Cents, as the readers give them: never -0. */
const money = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
};

/** The cash kinds a seeded CSV writes: the name its reader gives the row,
 *  from Vanguard's description, and whether its money comes in. */
const CSV_CASH: Record<string, { name: (day: string) => string; in: boolean }> = {
  'Funds Received': { name: () => 'Funds Received via electronic transfer', in: true },
  Contribution: { name: (day) => `Contribution for ${day.slice(0, 4)}`, in: true },
  'Conversion (incoming)': { name: () => 'Conversion (incoming): Roth conversion', in: true },
};

/** How the CSV's reader types a row of a Transaction Type. */
const kindOf = (kind: string, shares: number) => {
  const rule = KINDS[kind];
  return typeof rule === 'function' ? rule({ shares }) : rule;
};

/** A fund's name, as a file names it: the account's holding's. */
const fundName = (a: SeedAccount, ticker: string) => a.holdings?.find((h) => h.ticker === ticker)?.name ?? ticker;

/** A cash row's amount, in Plaid's sign: a cash row's quantity is -1 for money in. */
const cashAmount = (t: SeedInvTxn) => money(t.quantity < 0 ? -t.price : t.price);

/** The profile's row as the CSV's reader reads it. */
function csvRow(a: SeedAccount, spec: SeedImport, t: SeedInvTxn): ImportedRow {
  const base = { date: t.date, fees: 0, currency: USD };
  if (t.type !== 'cash') {
    const kind = t.type === 'buy' ? 'Buy' : 'Sell';
    const { type, subtype } = kindOf(kind, t.quantity);
    return { ...base, name: kind, type, subtype, quantity: t.quantity, price: t.price, amount: money(t.quantity * t.price), security: fundName(a, t.ticker) };
  }
  const kind = spec.kinds?.[t.name];
  const cash = kind !== undefined && Object.hasOwn(CSV_CASH, kind) ? CSV_CASH[kind] : undefined;
  if (!kind || !cash) throw new Error(`${spec.file_name} names no kind the seed writes for ${t.name} on the account ending ${a.mask}`);
  if (cash.in !== t.quantity < 0) throw new Error(`${spec.file_name}'s ${kind} on ${t.date} goes the other way on the account ending ${a.mask}`);
  const { type, subtype } = kindOf(kind, 0);
  return { ...base, name: cash.name(t.date), type, subtype, quantity: 0, price: 0, amount: cashAmount(t), security: null };
}

/** The profile's row as the QFX's reader reads it. */
function qfxRow(a: SeedAccount, t: SeedInvTxn): ImportedRow {
  const base = { date: t.date, fees: 0, currency: USD };
  if (t.type === 'cash') return { ...base, name: t.quantity < 0 ? 'Money in' : 'Money out', type: 'cash', subtype: 'unlabeled', quantity: 0, price: 0, amount: cashAmount(t), security: null };
  const name = t.type === 'buy' ? 'Buy' : 'Sell';
  return { ...base, name, type: t.type, subtype: t.type, quantity: Number(t.quantity.toFixed(3)), price: t.price, amount: money(t.quantity * t.price), security: fundName(a, t.ticker) };
}

/** The investment accounts at Vanguard, by mask. */
function vanguardAccounts(profile: DemoProfile): Map<string, SeedAccount> {
  const out = new Map<string, SeedAccount>();
  for (const inst of profile.institutions) for (const a of inst.accounts) if (isVanguard(inst.institution_id) && a.type === 'investment') out.set(a.mask, a);
  return out;
}

/** The import's entry for each account it takes, by mask, as the route
 *  stores them: refused where the route wouldn't take it. */
export function importEntries(profile: DemoProfile, spec: SeedImport, today: string): { mask: string; value: InvestmentImport }[] {
  const at = vanguardAccounts(profile);
  // Made before today, so it was imported before the reset that seeds it.
  if (spec.made >= today) throw new Error(`${spec.file_name} is made today or after: make it a day back at least`);
  if (spec.masks.length === 0 || spec.masks.length > MAX_ACCOUNTS_PER_IMPORT || new Set(spec.masks).size !== spec.masks.length) {
    throw new Error(`${spec.file_name} takes 1 to ${MAX_ACCOUNTS_PER_IMPORT} accounts, each once`);
  }
  const last = dayBefore(spec.made);
  const rows = spec.masks.map((mask) => {
    const a = at.get(mask);
    if (!a) throw new Error(`${spec.file_name} is Vanguard's: the account ending ${mask} isn't an investment account at Vanguard`);
    const own = (a.investment_transactions ?? []).filter((t) => t.date >= spec.from && t.date <= last);
    // An account with nothing in the file's days isn't taken (its days stay Plaid's).
    if (own.length === 0) throw new Error(`${spec.file_name} has no rows for the account ending ${mask}`);
    return { mask, rows: own.map((t) => (spec.source === 'vanguard-csv' ? csvRow(a, spec, t) : qfxRow(a, t))) };
  });
  // A CSV's days are its first row's to its last's, across its accounts; a
  // QFX's those it states, to the day before the day it was made.
  const days = rows.flatMap((r) => r.rows.map((t) => t.date)).sort();
  const covers = spec.source === 'vanguard-csv' ? { from: days[0], to: days[days.length - 1] } : { from: spec.from, to: last };
  const imported_at = `${spec.made}T17:00:00.000Z`;
  return rows.map(({ mask, rows }) => {
    const value: InvestmentImport = { source: spec.source, file_name: spec.file_name, imported_at, covers, currency: USD, rows };
    if (!isInvestmentImport(value)) throw new Error(`${spec.file_name} for the account ending ${mask} isn't an import the store keeps`);
    return { mask, value };
  });
}

/** The profile's rows for an account, as Plaid's (cash in a deposit, out a
 *  withdrawal), over the two years its sync asks for. */
function plaidOf(a: SeedAccount, account_id: string, today: string): InvSync {
  const rows: InvestmentTxn[] = (a.investment_transactions ?? []).map((t, i) => ({
    investment_transaction_id: `plaid-${i}`,
    account_id,
    date: t.date,
    name: t.name,
    type: t.type,
    subtype: t.type === 'cash' ? (t.quantity < 0 ? 'deposit' : 'withdrawal') : t.type,
    quantity: t.quantity,
    price: t.price,
    amount: t.type === 'cash' ? cashAmount(t) : money(t.quantity * t.price),
    fees: 0,
    currency: USD,
    security: t.ticker,
  }));
  return { rows, coverage: { [account_id]: { from: addDays(today, -730), through: today } }, note: null, pending: false, storeNote: null, unconfirmed: {}, unconfirmedIds: [], busy: false };
}

const flowsText = (rows: InvestmentTxn[], counted?: ReadonlySet<InvestmentTxn>) => JSON.stringify(dailyFlows(rows, counted).map((f) => [f.date, Math.round(f.amount * 100)]));

/**
 * Refuses imports the app wouldn't use as the scenario means them: each
 * entry one the route would store, at an investment account at Vanguard,
 * and, merged as the app merges them over the profile's rows (as Plaid's,
 * with stand-in ids), used, deciding days of its own, its deposits and
 * withdrawals Plaid's day by day, no row of Plaid's left out as one of its
 * own. Changes nothing.
 */
export function checkTransactionImports(profile: DemoProfile, today: string): void {
  const specs = profile.extras?.transactionImports ?? [];
  if (specs.length === 0) return;
  const byAccount = new Map<string, AccountImport[]>();
  const names = new Map<string, string>();
  specs.forEach((spec, n) => {
    // Each made after the one before, so no two were imported at once and
    // the order they decide in never turns on their ids.
    if (n > 0 && spec.made <= specs[n - 1].made) throw new Error(`${spec.file_name} is made no later than the import listed ahead of it: list them oldest first, a day apart at least`);
    names.set(`seed-import-${n}`, spec.file_name);
    for (const { mask, value } of importEntries(profile, spec, today)) {
      const list = byAccount.get(mask) ?? byAccount.set(mask, []).get(mask)!;
      list.push({ ...value, account_id: `seed-${mask}`, import_id: `seed-import-${n}` });
    }
  });
  const name = (import_id: string) => names.get(import_id)!;
  const at = vanguardAccounts(profile);
  for (const [mask, imports] of byAccount) {
    const id = `seed-${mask}`;
    const sync = plaidOf(at.get(mask)!, id, today);
    const merged = withImportedRows(sync, id, imports);
    if (merged.unused.length > 0) throw new Error(`${merged.unused.map(name).join(', ')} wouldn't be used for the account ending ${mask}`);
    for (const i of imports) if (!merged.decided.some((d) => d.import_id === i.import_id)) throw new Error(`${name(i.import_id)} decides no day of its own for the account ending ${mask}`);
    if (merged.twins.length > 0) throw new Error(`An import for the account ending ${mask} would leave out Plaid's ${merged.twins.map((t) => `${t.name} on ${t.date}`).join(', ')} as one of its own`);
    const rows = merged.sync.rows.filter((t) => t.account_id === id);
    if (flowsText(rows, merged.counted) !== flowsText(sync.rows)) throw new Error(`The imports for the account ending ${mask} change its deposits and withdrawals`);
  }
}

/**
 * Imports each, oldest first, as the route imports a file: one entry for
 * each account it takes, under the id Plaid gave it today, against the
 * imports there were before it (checked from the profile's own before
 * anything was emptied).
 */
export async function writeTransactionImports(run: SeedRun): Promise<void> {
  for (const spec of run.profile.extras?.transactionImports ?? []) {
    const entries = importEntries(run.profile, spec, run.today).map(({ mask, value }) => ({ account_id: run.accountIds.get(mask)!, value }));
    await addImport(run.ctx, crypto.randomUUID(), entries, importsFingerprint(await importKeys(run.ctx)));
  }
}
