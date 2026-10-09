// lib/allocation/settings.ts
//
// The person's allocation settings, as stored (lib/allocation-settings.ts,
// one encrypted value per container) and as the Plan tab edits them:
//
//   buckets  the tax bucket they set for an account, by account id, over
//            what its subtype says (lib/allocation/buckets.ts);
//   funds    the split they set for a security, by its ticker, or by its
//            name for one with no ticker (a 401(k)'s collective trust, say),
//            over Nya's list and Plaid's type (lib/allocation/classes.ts);
//   accounts the split they set for an account's money that no position it
//            lists explains, by account id: a manual investment account, or
//            cash a brokerage doesn't list as a position;
//   target   the allocation they aim for, by asset class, or null.
//
// Only what the person chose: nothing Nya measures or works out is stored.
//
// Two checks, on purpose, as lib/fire/plan.ts has. parseSettings is what a
// save must meet: the route runs every PUT through it, and the forms run
// every edit through it. Every field present and of its type, ids and
// tickers in their formats, every split adding up to 100% in tenths, no
// account, ticker or name twice, and the counts within limits.
// isAllocationSettings is what a stored value must be to read back: the same
// shape and types, closed (a field this code doesn't know makes it
// unrecognised, so an older release never drops what a later one added when
// it saves), but none of the formats, sums or limits, which a later release
// may change. A stored split that doesn't add up to 100% is used for nothing
// (lib/allocation/classes.ts classify, and drift); it never stops the tab.
//
// Imports no data and no storage, so the route and the browser both use it.

import { TAX_BUCKETS, type TaxBucket } from './buckets';
import { ASSET_CLASSES, STOCK_CLASSES, nameKey, splitProblem, tickerKey, type FundSplits, type Split } from './classes';

/** A fund split, by ticker or (for a security with no ticker) by name. */
export type FundOverride = { ticker: string; split: Split } | { name: string; split: Split };

export type AllocationSettings = {
  v: 1;
  buckets: { account_id: string; bucket: TaxBucket }[];
  funds: FundOverride[];
  accounts: { account_id: string; split: Split }[];
  target: Split | null;
};

export const EMPTY_SETTINGS: AllocationSettings = { v: 1, buckets: [], funds: [], accounts: [], target: null };

export const SETTINGS_LIMITS = {
  /** Accounts with a bucket set. */
  buckets: 200,
  /** Securities with a split set. */
  funds: 300,
  /** Accounts with a split set for their unlisted money. */
  accounts: 200,
  /** A security's name, when it has no ticker. */
  name: 120,
} as const;

/** Plaid's ticker symbols: "VTI", "BRK.B", "BRK/B", "CUR:USD", "BTC-USD",
 *  and an option's 21-character OCC symbol. Upper case, as compared. */
export const TICKER = /^[A-Z0-9][A-Z0-9.:/-]{0,23}$/;
/** Account ids as Plaid and manual accounts make them (lib/fire/plan.ts). */
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

class Invalid extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function exactKeys(v: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Invalid(`${field} must be an object`);
  for (const k of Object.keys(v)) if (!keys.includes(k)) throw new Invalid(`${field} has an unknown field "${k.slice(0, 40)}"`);
  for (const k of keys) if (!Object.hasOwn(v, k)) throw new Invalid(`${field} is missing "${k}"`);
  return v;
}

function list(v: unknown, field: string, max: number | null): unknown[] {
  if (!Array.isArray(v) || (max !== null && v.length > max)) throw new Invalid(`${field} must be a list${max !== null ? ` of at most ${max}` : ''}`);
  return v;
}

/** A split's shape: an object of known classes to finite numbers. */
function splitShape(v: unknown, field: string): Split {
  if (!isRecord(v)) throw new Invalid(`${field} must be an object`);
  const out: Split = {};
  for (const [k, n] of Object.entries(v)) {
    if (!(ASSET_CLASSES as readonly string[]).includes(k)) throw new Invalid(`${field} has an unknown class "${k.slice(0, 40)}"`);
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new Invalid(`${field}.${k} must be a number`);
    out[k as keyof Split] = n;
  }
  return out;
}

/** A split to save: its shape, and adding up to 100%. */
function splitInput(v: unknown, field: string): Split {
  const s = splitShape(v, field);
  const problem = splitProblem(s);
  if (problem) throw new Invalid(`${field} ${problem}`);
  return s;
}

/** A clean copy of settings, or why they aren't settings. `input` checks
 *  everything a save must meet; otherwise only the shape and types. */
function readSettings(raw: unknown, input: boolean): { settings: AllocationSettings } | { error: string } {
  try {
    const o = exactKeys(raw, ['v', 'buckets', 'funds', 'accounts', 'target'], 'settings');
    if (o.v !== 1) throw new Invalid('v must be 1');

    const seenAccounts = new Set<string>();
    const buckets = list(o.buckets, 'buckets', input ? SETTINGS_LIMITS.buckets : null).map((x, i) => {
      const e = exactKeys(x, ['account_id', 'bucket'], `buckets[${i}]`);
      if (typeof e.account_id !== 'string' || (input && !ACCOUNT_ID.test(e.account_id))) throw new Invalid(`buckets[${i}].account_id must be an account id`);
      if (typeof e.bucket !== 'string' || !(TAX_BUCKETS as readonly string[]).includes(e.bucket)) {
        throw new Invalid(`buckets[${i}].bucket must be one of ${TAX_BUCKETS.join(', ')}`);
      }
      if (input && seenAccounts.has(e.account_id)) throw new Invalid(`buckets[${i}] names an account already given a bucket`);
      seenAccounts.add(e.account_id);
      return { account_id: e.account_id, bucket: e.bucket as TaxBucket };
    });

    const seenTickers = new Set<string>();
    const seenNames = new Set<string>();
    const funds = list(o.funds, 'funds', input ? SETTINGS_LIMITS.funds : null).map((x, i): FundOverride => {
      const field = `funds[${i}]`;
      if (!isRecord(x)) throw new Invalid(`${field} must be an object`);
      const byTicker = Object.hasOwn(x, 'ticker');
      const e = exactKeys(x, [byTicker ? 'ticker' : 'name', 'split'], field);
      const split = input ? splitInput(e.split, `${field}.split`) : splitShape(e.split, `${field}.split`);
      if (byTicker) {
        if (typeof e.ticker !== 'string') throw new Invalid(`${field}.ticker must be text`);
        const ticker = input ? tickerKey(e.ticker) : e.ticker;
        if (input && !TICKER.test(ticker)) throw new Invalid(`${field}.ticker must be a ticker symbol: letters, digits and . : / -, at most 24`);
        if (input && seenTickers.has(ticker)) throw new Invalid(`${field} names a ticker already given a split`);
        seenTickers.add(ticker);
        return { ticker, split };
      }
      if (typeof e.name !== 'string') throw new Invalid(`${field}.name must be text`);
      const name = input ? e.name.trim().replace(/\s+/g, ' ') : e.name;
      if (input && (!name || name.length > SETTINGS_LIMITS.name || CONTROL.test(name))) {
        throw new Invalid(`${field}.name must be 1 to ${SETTINGS_LIMITS.name} characters`);
      }
      if (input && seenNames.has(nameKey(name))) throw new Invalid(`${field} names a security already given a split`);
      seenNames.add(nameKey(name));
      return { name, split };
    });

    const seenSplitAccounts = new Set<string>();
    const accounts = list(o.accounts, 'accounts', input ? SETTINGS_LIMITS.accounts : null).map((x, i) => {
      const e = exactKeys(x, ['account_id', 'split'], `accounts[${i}]`);
      if (typeof e.account_id !== 'string' || (input && !ACCOUNT_ID.test(e.account_id))) throw new Invalid(`accounts[${i}].account_id must be an account id`);
      const split = input ? splitInput(e.split, `accounts[${i}].split`) : splitShape(e.split, `accounts[${i}].split`);
      if (input && seenSplitAccounts.has(e.account_id)) throw new Invalid(`accounts[${i}] names an account already given a split`);
      seenSplitAccounts.add(e.account_id);
      return { account_id: e.account_id, split };
    });

    let target: Split | null = null;
    if (o.target !== null) {
      target = input ? splitInput(o.target, 'target') : splitShape(o.target, 'target');
      // A target either splits stocks by region or doesn't: stocks of an
      // unknown region beside US or international ones would count twice.
      const regional = (['us-stocks', 'intl-stocks'] as const).some((c) => (target![c] ?? 0) > 0);
      if (input && regional && (target.stocks ?? 0) > 0) {
        throw new Invalid('target gives stocks of any region and US or international stocks too: use one or the other');
      }
    }
    return { settings: { v: 1, buckets, funds, accounts, target } };
  } catch (err) {
    if (err instanceof Invalid) return { error: err.message };
    throw err;
  }
}

/** A clean copy of settings to save, or why they can't be saved. Tickers are
 *  upper-cased and names trimmed, as they are compared. */
export function parseSettings(raw: unknown): { settings: AllocationSettings } | { error: string } {
  return readSettings(raw, true);
}

/** Whether a value is settings as stored: the current shape and types,
 *  whatever formats and limits applied when it was saved. */
export function isAllocationSettings(v: unknown): v is AllocationSettings {
  return 'settings' in readSettings(v, false);
}

/** The settings as lookups: buckets and unlisted-money splits by account
 *  id, fund splits by ticker and by name (lib/allocation/classes.ts
 *  FundSplits). */
export function overridesOf(settings: AllocationSettings | null): {
  buckets: Map<string, TaxBucket>;
  splits: FundSplits;
  accounts: Map<string, Split>;
} {
  const buckets = new Map<string, TaxBucket>();
  const byTicker = new Map<string, Split>();
  const byName = new Map<string, Split>();
  const accounts = new Map<string, Split>();
  for (const b of settings?.buckets ?? []) buckets.set(b.account_id, b.bucket);
  for (const f of settings?.funds ?? []) {
    if ('ticker' in f) byTicker.set(tickerKey(f.ticker), f.split);
    else byName.set(nameKey(f.name), f.split);
  }
  for (const a of settings?.accounts ?? []) accounts.set(a.account_id, a.split);
  return { buckets, splits: { byTicker, byName }, accounts };
}

/** Settings with one account's bucket set, or cleared with null. */
export function withBucket(settings: AllocationSettings, account_id: string, bucket: TaxBucket | null): AllocationSettings {
  const rest = settings.buckets.filter((b) => b.account_id !== account_id);
  return { ...settings, buckets: bucket === null ? rest : [...rest, { account_id, bucket }] };
}

/** Settings with one account's split for its unlisted money set, or
 *  cleared with null. */
export function withAccountSplit(settings: AllocationSettings, account_id: string, split: Split | null): AllocationSettings {
  const rest = settings.accounts.filter((a) => a.account_id !== account_id);
  return { ...settings, accounts: split === null ? rest : [...rest, { account_id, split }] };
}

/** Settings with one security's split set, or cleared with null. */
export function withFund(settings: AllocationSettings, key: { ticker: string } | { name: string }, split: Split | null): AllocationSettings {
  const same = (f: FundOverride) =>
    'ticker' in key ? 'ticker' in f && tickerKey(f.ticker) === tickerKey(key.ticker) : 'name' in f && nameKey(f.name) === nameKey(key.name);
  const rest = settings.funds.filter((f) => !same(f));
  if (split === null) return { ...settings, funds: rest };
  const entry: FundOverride = 'ticker' in key ? { ticker: tickerKey(key.ticker), split } : { name: key.name.trim().replace(/\s+/g, ' '), split };
  return { ...settings, funds: [...rest, entry] };
}

/** Whether a target names stocks by region (US and international) rather
 *  than as stocks of any region. A target with no stocks at all does
 *  neither: every stock, whatever its region, is held against 0%. */
export function targetByRegion(target: Split): boolean {
  return STOCK_CLASSES.some((c) => c !== 'stocks' && (target[c] ?? 0) > 0);
}
