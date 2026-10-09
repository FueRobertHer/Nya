// lib/allocation/allocation.ts
//
// Current allocation: the investment accounts the dashboard last loaded
// (hidden ones left out), by asset class and by tax bucket, in one currency,
// with what can't be classified shown as its own share and what can't be
// counted named. Then drift against the person's target, and the stock, bond
// and cash mix the Plan's simulation can take from it.
//
// BY ASSET CLASS, from positions. Each position the institution lists is
// classified (lib/allocation/classes.ts) and its value spread over its split.
// An account's balance can hold money no position explains: cash an
// institution doesn't list as a position, often. That difference is
// unclassified ("not in a position it lists"), never assumed to be cash. An
// account with no position at all (a manual investment account, or an
// institution whose holdings didn't come) is unclassified whole, and so is
// one whose institution couldn't be reached: its balance may be recovered
// (lib/last-known.ts), but what it holds isn't known. The person can give an
// account a split for its money no position explains (a manual investment
// account, a brokerage that doesn't list its cash), which then classifies
// it; never an unreachable one's, whose holdings may have changed since it
// last answered. Positions worth more
// than the balance (a margin loan the institution nets out of the balance,
// or prices taken at another time) are counted as listed, and named.
//
// BY TAX BUCKET, from the same money per account, so both views add up to
// the same total (lib/allocation/buckets.ts).
//
// SIGNS. Plaid reports a short position, or cash borrowed on margin, as a
// negative value (lib/cash.ts). They are counted as they are: a margin loan
// is negative cash, so a leveraged account shows stocks above 100% and cash
// below 0, which is what it holds. Shares are of the whole; when the whole is
// zero or below there are no shares, only amounts.
//
// ONE CURRENCY. Nothing is converted. The allocation is in the currency it is
// asked for (the Plan's display currency); an account in another one, or a
// position priced in another one, is left out and named, by currency, as the
// Plan names what it can't add up. A figure with no currency is taken to be
// in it, as the rest of the dashboard takes one.
//
// Pure, and imports nothing that touches storage: the Plan tab runs it.

import { isInvestmentType } from '@/lib/balance';
import { accountBucket, BUCKET_SLOTS, type AccountBucket, type BucketSlot } from './buckets';
import {
  ASSET_CLASSES,
  classify,
  nameKey,
  securityKey,
  SLOTS,
  spread,
  STOCK_CLASSES,
  type AssetClass,
  isCompleteSplit,
  type Classified,
  type Slot,
  type Split,
} from './classes';
import { overridesOf, targetByRegion, type AllocationSettings } from './settings';

/** An account as the dashboard has it (lib/fire/inputs.ts AssetAccount). */
export type AllocAccount = {
  account_id: string;
  name: string;
  type: string;
  subtype?: string | null;
  balance: number | null;
  currency: string | null;
  hidden?: boolean;
};

/** An institution as the dashboard last loaded it, with what went wrong
 *  (lib/fire/inputs.ts AssetInstitution). */
export type AllocInstitution = {
  name: string;
  error: boolean;
  staleAsOf: string | null;
  staleAsOfAt?: string | null;
  missing: number;
  accounts: AllocAccount[];
};

/** A position as /api/net-worth sends it (lib/networth.ts fetchHoldings). */
export type AllocHolding = {
  account_id?: string;
  name?: string | null;
  ticker?: string | null;
  security_type?: string | null;
  is_cash_equivalent?: boolean | null;
  value?: number | null;
  /** The position's own currency. Absent on payloads cached before it was
   *  sent: the account's is used then. */
  currency?: string | null;
};

/** A difference under this, in the currency's units, between an account's
 *  balance and its positions is rounding, not money. */
export const ROUNDING = 1;

/** One security across the accounts that hold it. */
export type SecurityRow = {
  /** "ticker:VTI", "name:<name>", or a key of its own for a holding with
   *  neither, which can't be classified by hand. */
  key: string;
  ticker: string | null;
  name: string | null;
  amount: number;
  classified: Classified;
  /** The accounts holding it, by name. */
  accounts: string[];
};

/** Account money no position explains: unclassified, unless the person
 *  gave the account a split for it. */
export type AccountGap = {
  /** "no-positions": none listed. "not-in-position": its balance is more than
   *  its positions. "unreachable": its institution couldn't be reached, so its
   *  balance may be recovered but what it holds isn't known. */
  kind: 'no-positions' | 'not-in-position' | 'unreachable';
  account_id: string;
  account: string;
  institution: string;
  amount: number;
  /** For "unreachable": the day its balance is from, if recovered. */
  asOf: string | null;
  asOfAt: string | null;
  /** The person's split for it, which classifies it; null leaves it
   *  unclassified. Never set for "unreachable". */
  split: Split | null;
};

export type AccountRow = {
  account_id: string;
  name: string;
  institution: string;
  subtype: string | null;
  bucket: AccountBucket;
  /** What the account adds to the allocation, or null when it adds nothing
   *  (no balance and no position, or another currency). */
  amount: number | null;
  /** Its currency, when it is left out for being in another. */
  otherCurrency: string | null;
};

/** Why the allocation may be short. */
export type AllocCaveat =
  /** It failed with nothing recovered: what it holds isn't counted at all. */
  | { kind: 'unreachable'; institution: string }
  /** Accounts it is known to have couldn't be shown. */
  | { kind: 'missing'; institution: string; count: number };

export type Allocation = {
  currency: string | null;
  /** Everything counted: what the classes, and the buckets, add up to. */
  total: number;
  classes: Record<Slot, number>;
  buckets: Record<BucketSlot, number>;
  accounts: AccountRow[];
  /** Every security counted, largest first. */
  securities: SecurityRow[];
  gaps: AccountGap[];
  /** Positions worth more than the account's balance, by how much. */
  over: { account: string; institution: string; amount: number }[];
  /** Left out for being in another currency, by currency. */
  otherCurrencies: { currency: string; amount: number }[];
  /** Positions with no value: evidence of nothing, so not counted. */
  unpriced: number;
  /** Accounts with no balance and no position to count. */
  noBalance: number;
  /** Positions with a value that name no account the dashboard has (a
   *  payload cached before positions carried their account): not counted. */
  unattributed: number;
  caveats: AllocCaveat[];
};

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** The allocation of the investment accounts shown (see the top of this file). */
export function allocate(input: {
  institutions: readonly AllocInstitution[];
  holdings: readonly AllocHolding[];
  settings: AllocationSettings | null;
  currency: string | null;
}): Allocation {
  const { buckets: chosen, splits, accounts: accountSplits } = overridesOf(input.settings);
  const display = input.currency;
  const inCurrency = (c: string | null | undefined) => !c || !display || c === display;
  const classes = zeros(SLOTS);
  const buckets = zeros(BUCKET_SLOTS);
  const accounts: AccountRow[] = [];
  const gaps: AccountGap[] = [];
  const over: Allocation['over'] = [];
  const other = new Map<string, number>();
  const rows = new Map<string, SecurityRow>();
  const caveats: AllocCaveat[] = [];
  let unpriced = 0;
  let noBalance = 0;
  let anonymous = 0;

  const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
  // Positions by account. One naming no account the dashboard has can't be
  // placed: counted, never added. A hidden account's are left out with it.
  const known = new Set(input.institutions.flatMap((i) => i.accounts.map((a) => a.account_id)));
  const held = new Map<string, AllocHolding[]>();
  let unattributed = 0;
  for (const h of input.holdings) {
    if (!h.account_id || !known.has(h.account_id)) {
      if (finite(h.value) && h.value !== 0) unattributed++;
      continue;
    }
    let list = held.get(h.account_id);
    if (!list) held.set(h.account_id, (list = []));
    list.push(h);
  }
  const leaveOut = (currency: string, amount: number) => other.set(currency, (other.get(currency) ?? 0) + amount);

  for (const inst of input.institutions) {
    const shown = inst.accounts.filter((a) => !a.hidden && isInvestmentType(a.type));
    const mightHold = shown.length > 0 || inst.accounts.length === 0;
    if (inst.error && !inst.staleAsOf && mightHold) caveats.push({ kind: 'unreachable', institution: inst.name });
    if (inst.missing > 0 && mightHold) caveats.push({ kind: 'missing', institution: inst.name, count: inst.missing });

    for (const a of shown) {
      const bucket = accountBucket(a.subtype, chosen.get(a.account_id));
      const row: AccountRow = { account_id: a.account_id, name: a.name, institution: inst.name, subtype: a.subtype ?? null, bucket, amount: null, otherCurrency: null };
      accounts.push(row);
      const positions = held.get(a.account_id) ?? [];
      if (!inCurrency(a.currency)) {
        // In another currency, positions and all: left out, and named.
        const priced = positions.filter((h) => finite(h.value));
        const amount = finite(a.balance) ? a.balance : priced.reduce((s, h) => s + (h.value as number), 0);
        leaveOut(a.currency as string, amount);
        row.otherCurrency = a.currency;
        continue;
      }
      /** Money no position explains: classified by the account's split, if
       *  the person set one (and it adds up), else unclassified. */
      const gap = (kind: AccountGap['kind'], amount: number) => {
        const own = kind === 'unreachable' ? undefined : accountSplits.get(a.account_id);
        const split = own && isCompleteSplit(own) ? own : null;
        if (split) for (const [c, part] of spread(amount, split)) classes[c] += part;
        else classes.unclassified += amount;
        gaps.push({
          kind,
          account_id: a.account_id,
          account: a.name,
          institution: inst.name,
          amount,
          asOf: kind === 'unreachable' ? inst.staleAsOf : null,
          asOfAt: kind === 'unreachable' ? (inst.staleAsOfAt ?? null) : null,
          split,
        });
      };

      // Couldn't be reached: whatever balance was recovered, what it holds
      // isn't known.
      if (inst.error) {
        if (finite(a.balance)) {
          gap('unreachable', a.balance);
          row.amount = a.balance;
        } else noBalance++;
        if (row.amount !== null) buckets[bucket.bucket] += row.amount;
        continue;
      }

      let sum = 0;
      let counted = 0;
      let foreign = false;
      for (const h of positions) {
        if (!finite(h.value)) {
          unpriced++;
          continue;
        }
        const currency = h.currency ?? a.currency;
        if (!inCurrency(currency)) {
          leaveOut(currency as string, h.value);
          foreign = true;
          continue;
        }
        counted++;
        sum += h.value;
        const k = classify(h, splits);
        if (k.split) for (const [c, part] of spread(h.value, k.split)) classes[c] += part;
        else classes.unclassified += h.value;
        const id = securityKey(h);
        const key = id === null ? `none:${anonymous++}` : 'ticker' in id ? `ticker:${id.ticker}` : `name:${nameKey(id.name)}`;
        const r = rows.get(key);
        if (r) {
          r.amount += h.value;
          if (!r.accounts.includes(a.name)) r.accounts.push(a.name);
        } else {
          rows.set(key, {
            key,
            ticker: id !== null && 'ticker' in id ? id.ticker : null,
            name: h.name?.trim() || null,
            amount: h.value,
            classified: k,
            accounts: [a.name],
          });
        }
      }

      if (counted === 0) {
        // Nothing listed to classify it by: unclassified whole, unless the
        // positions are all in another currency (named there, with the
        // balance that converts them unknown here).
        if (foreign) continue;
        if (finite(a.balance)) {
          gap('no-positions', a.balance);
          row.amount = a.balance;
          buckets[bucket.bucket] += a.balance;
        } else noBalance++;
        continue;
      }
      row.amount = sum;
      // The balance against the positions, where the two can be compared: not
      // when some positions are in another currency, which the balance holds
      // converted.
      if (finite(a.balance) && !foreign) {
        const diff = a.balance - sum;
        if (diff > ROUNDING) {
          gap('not-in-position', diff);
          row.amount = a.balance;
        } else if (diff < -ROUNDING) {
          over.push({ account: a.name, institution: inst.name, amount: -diff });
        }
      }
      buckets[bucket.bucket] += row.amount;
    }
  }

  // Exactly: spread() and the sums carry values as they are, so the classes
  // and the buckets add up to the same whole.
  const total = SLOTS.reduce((s, k) => s + classes[k], 0);
  return {
    currency: display,
    total,
    classes,
    buckets,
    accounts,
    securities: [...rows.values()].sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount) || (x.key < y.key ? -1 : 1)),
    gaps,
    over,
    otherCurrencies: [...other].map(([currency, amount]) => ({ currency, amount })).sort((x, y) => (x.currency < y.currency ? -1 : 1)),
    unpriced,
    noBalance,
    unattributed,
    caveats,
  };
}

/**
 * Whole percents of `amounts` that add up to exactly 100, by the largest
 * remainder: each rounded down, then the units left go to the largest
 * fractions. Signed amounts work the same way (a margin loan's negative cash).
 * Null when the whole is zero or below: shares of it mean nothing.
 */
export function wholePercents(amounts: readonly number[]): number[] | null {
  const total = amounts.reduce((s, a) => s + a, 0);
  if (!(total > 0) || !Number.isFinite(total)) return null;
  const exact = amounts.map((a) => (a / total) * 100);
  const out = exact.map((e) => Math.floor(e + 1e-9));
  let left = 100 - out.reduce((s, n) => s + n, 0);
  const order = exact.map((e, i) => [e - out[i], i] as const).sort((x, y) => y[0] - x[0] || x[1] - y[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i]++;
    left--;
  }
  return out;
}

/**
 * A share as shown beside its amount: the whole percent, except that money
 * that is there never reads 0% ("<1%"), and a share short of the whole never
 * reads 100% (">99%"), so no line contradicts another.
 */
export function shareLabel(amount: number, rounded: number, total: number): string {
  if (amount > 0 && rounded <= 0) return '<1%';
  if (amount < 0 && rounded >= 0) return '>-1%';
  if (rounded >= 100 && amount < total) return '>99%';
  return `${rounded}%`;
}

/** The slots that hold anything, in display order, with their whole
 *  percents (null when the whole is zero or below). */
export function shares<K extends string>(totals: Record<K, number>, order: readonly K[]): { slot: K; amount: number; pct: number | null; label: string | null }[] {
  const held = order.filter((k) => totals[k] !== 0);
  const pcts = wholePercents(held.map((k) => totals[k]));
  const total = held.reduce((s, k) => s + totals[k], 0);
  return held.map((slot, i) => ({
    slot,
    amount: totals[slot],
    pct: pcts ? pcts[i] : null,
    label: pcts ? shareLabel(totals[slot], pcts[i], total) : null,
  }));
}

// Drift

/** "all-stocks" is stocks of every region together, for a target that
 *  doesn't split them by region. */
export type DriftSlot = AssetClass | 'all-stocks';

export type DriftRow = {
  slot: DriftSlot;
  /** Percents of `basis`. `target` is null for stocks of an unknown region
   *  under a target split by region: they can't be compared with either. */
  target: number | null;
  actual: number;
  /** actual - target, in percentage points. */
  diff: number | null;
  /** What it would take to reach the target: positive to add, negative to
   *  take away, in the allocation's currency. */
  toTarget: number | null;
};

export type Drift = {
  /** What the shares are of: everything classified, unclassified left out. */
  basis: number;
  rows: DriftRow[];
  /** Unclassified money, left out of the comparison. */
  unclassified: number;
  byRegion: boolean;
};

/**
 * The allocation against a target. Unclassified money is left out of both
 * sides (it could be anything), and said; under a target that splits stocks
 * by region, stocks of an unknown region have a row of their own with no
 * target. Null with nothing classified to compare, or no usable target.
 */
export function drift(alloc: Allocation, target: Split): Drift | null {
  const basis = alloc.total - alloc.classes.unclassified;
  if (!(basis > 0)) return null;
  const sum = ASSET_CLASSES.reduce((s, c) => s + (target[c] ?? 0), 0);
  if (Math.abs(sum - 100) > 1e-6) return null; // a stored target this release can't use
  const byRegion = targetByRegion(target);
  const amountOf = (slot: DriftSlot) =>
    slot === 'all-stocks' ? STOCK_CLASSES.reduce((s, c) => s + alloc.classes[c], 0) : alloc.classes[slot];
  const targetOf = (slot: DriftSlot) => (slot === 'all-stocks' ? (target.stocks ?? 0) : (target[slot] ?? 0));
  const slots: DriftSlot[] = byRegion
    ? [...ASSET_CLASSES]
    : ['all-stocks', ...ASSET_CLASSES.filter((c) => !STOCK_CLASSES.includes(c))];
  const rows: DriftRow[] = [];
  for (const slot of slots) {
    const amount = amountOf(slot);
    const t = targetOf(slot);
    if (amount === 0 && t === 0) continue;
    const actual = (amount * 100) / basis;
    if (byRegion && slot === 'stocks') {
      rows.push({ slot, target: null, actual, diff: null, toTarget: null });
      continue;
    }
    rows.push({ slot, target: t, actual, diff: actual - t, toTarget: (t * basis) / 100 - amount });
  }
  return { basis, rows, unclassified: alloc.classes.unclassified, byRegion };
}

// The Plan's mix

/** What the Plan's mix can't take: money its stocks, bonds and cash can't
 *  stand for, by class. */
export const LEFT_OUT_OF_MIX: readonly Slot[] = ['unclassified', 'real-estate', 'crypto', 'other'];

export type PlanMix = {
  stocks: number;
  bonds: number;
  cash: number;
  /** Checking and savings counted as cash, because the plan counts them as
   *  invested assets (its includeCash). */
  bank: number;
  /** What was left out, by class, and in other currencies. */
  leftOut: { slot: Slot; amount: number }[];
  otherCurrencies: { currency: string; amount: number }[];
} & (
  | { ok: true; stocksPct: number; bondsPct: number; cashPct: number }
  /** "nothing": no stocks, bonds or cash to take a mix from. "negative": one
   *  of them is below zero (cash borrowed on margin, say), which a mix of
   *  shares can't hold. */
  | { ok: false; why: 'nothing' | 'negative' }
);

/**
 * The stock, bond and cash mix for the Plan's simulation, from the
 * allocation: stocks of every region together, and `bank` added to cash.
 * Unclassified money is never counted as stocks or bonds: it is left out,
 * with real estate, crypto and anything else the simulation has no history
 * for, and each is named. Whole percents that add up to 100.
 */
export function planMix(alloc: Allocation, bank = 0, bankOtherCurrencies: { currency: string; amount: number }[] = []): PlanMix {
  const stocks = STOCK_CLASSES.reduce((s, c) => s + alloc.classes[c], 0);
  const bonds = alloc.classes.bonds;
  const cash = alloc.classes.cash + bank;
  const leftOut = LEFT_OUT_OF_MIX.filter((s) => alloc.classes[s] !== 0).map((slot) => ({ slot, amount: alloc.classes[slot] }));
  const merged = new Map<string, number>();
  for (const o of [...alloc.otherCurrencies, ...bankOtherCurrencies]) merged.set(o.currency, (merged.get(o.currency) ?? 0) + o.amount);
  const otherCurrencies = [...merged].map(([currency, amount]) => ({ currency, amount })).sort((x, y) => (x.currency < y.currency ? -1 : 1));
  const base = { stocks, bonds, cash, bank, leftOut, otherCurrencies };
  if (stocks < 0 || bonds < 0 || cash < 0) return { ...base, ok: false, why: 'negative' };
  const pcts = wholePercents([stocks, bonds, cash]);
  if (!pcts) return { ...base, ok: false, why: 'nothing' };
  return { ...base, ok: true, stocksPct: pcts[0], bondsPct: pcts[1], cashPct: pcts[2] };
}

/** Checking and savings, not hidden, as the plan counts them with
 *  includeCash (lib/fire/inputs.ts investedAssets), in one currency: the
 *  amount, and what is in others. */
export function bankCash(
  institutions: readonly AllocInstitution[],
  currency: string | null
): { amount: number; otherCurrencies: { currency: string; amount: number }[] } {
  let amount = 0;
  const other = new Map<string, number>();
  for (const inst of institutions) {
    for (const a of inst.accounts) {
      if (a.hidden || a.type !== 'depository' || typeof a.balance !== 'number' || !Number.isFinite(a.balance)) continue;
      if (!a.currency || !currency || a.currency === currency) amount += a.balance;
      else other.set(a.currency, (other.get(a.currency) ?? 0) + a.balance);
    }
  }
  return { amount, otherCurrencies: [...other].map(([c, n]) => ({ currency: c, amount: n })) };
}
