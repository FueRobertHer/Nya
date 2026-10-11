// lib/goal-allocation.ts
//
// How the goals on one account share its balance (#42), so that what they
// show together is never more money than the account holds. Pure, safe to
// import from client code: the Goals card runs it on the balances it shows,
// the server on the balances it last measured (the route's checks, the API).
//
// THE RULES, per account:
//   - An allocation is a claim on part of the balance, set by the person, in
//     the account's currency. It is not a separate pot: the money stays in
//     the account.
//   - Allocations that fit (they add up to no more than the balance) are
//     shown as set. What they leave is the account's unallocated remainder.
//   - A goal without an allocation claims that remainder: the whole balance
//     when nothing on the account is allocated, which is exactly what every
//     goal did before allocations existed. Two such goals on one account each
//     show the same remainder, as two goals did before; each says so
//     (`sharedWith`), so the double count is never silent.
//   - Allocations that no longer fit (the balance fell after they were set)
//     are shown scaled down to fit, in proportion, and flagged (`scaled`),
//     never as money that isn't there. They stay stored as set, and the
//     remainder is then nothing.
//   - A balance at or below zero (an overdrawn account) leaves every goal on
//     it at zero.
//
// Archived goals claim nothing: archiving releases the money they held.
//
// Amounts are worked in the currency's minor units (cents; whole yen), and a
// scaled split hands out the last units by largest remainder, so the shown
// amounts add up to the balance exactly, never a cent over.

import { minorDigits } from './manual-txn-input';

/** What allocation needs to know of a goal. `account_id` is the account it
 *  counts now (following links). */
export type AllocGoal = { id: string; account_id: string | null; allocation?: number; archived?: boolean };

/** One account's balance, in its own currency. */
export type AllocAccount = { balance: number; currency: string | null };

/** What a goal counts as saved, and how it got it. */
export type Claim = {
  amount: number;
  /** 'allocation': its own allocation (scaled when they don't fit);
   *  'remainder': what the allocations leave. */
  kind: 'allocation' | 'remainder';
  /** Its allocation was scaled down: the allocations add up to more than the
   *  balance. */
  scaled: boolean;
  /** Other goals without an allocation that count the same remainder. */
  sharedWith: string[];
};

/** How one account's balance is split among its goals. */
export type AccountSplit = {
  account_id: string;
  currency: string | null;
  balance: number;
  /** The allocations as set, added up. */
  allocated: number;
  /** What the allocated goals are shown with: never more than the balance. */
  counted: number;
  /** What no allocation claims: the balance less what is counted, never
   *  below zero. */
  unallocated: number;
  /** How far the allocations as set are over the balance; 0 when they fit. */
  over: number;
  /** The active goals on the account, in the order given. */
  goals: string[];
  /** Whether any of them has an allocation. */
  hasAllocations: boolean;
};

const digitsOf = (currency: string | null) => minorDigits(currency || 'USD');
/** An amount in minor units, as an integer. */
export const toUnits = (amount: number, digits: number) => Math.round(amount * 10 ** digits);
const fromUnits = (units: number, digits: number) => units / 10 ** digits;

/**
 * Integer amounts scaled to fit `total`, in proportion: each rounded down,
 * then the units left over handed out one each by largest remainder (the
 * first among equals), so they add up to exactly `total` and none is more
 * than it was. Given amounts that already fit, they come back as they are.
 */
export function apportion(units: readonly number[], total: number): number[] {
  const sum = units.reduce((s, u) => s + u, 0);
  if (sum <= total) return [...units];
  if (total <= 0) return units.map(() => 0);
  const raw = units.map((u) => (u * total) / sum);
  const out = raw.map((r) => Math.floor(r));
  let left = total - out.reduce((s, u) => s + u, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (out[i] < units[i]) {
      out[i]++;
      left--;
    }
  }
  return out;
}

/**
 * Every active goal's claim on the account it tracks, and how each account
 * is split (see THE RULES). Only goals on an account in `accounts` are
 * claimed: whether an account can be tracked at all (hidden, owed, without a
 * balance) is decided before, by the caller.
 */
export function splitBalances(
  goals: readonly AllocGoal[],
  accounts: ReadonlyMap<string, AllocAccount>
): { claims: Map<string, Claim>; accounts: Map<string, AccountSplit> } {
  const claims = new Map<string, Claim>();
  const splits = new Map<string, AccountSplit>();
  const byAccount = new Map<string, AllocGoal[]>();
  for (const g of goals) {
    if (g.archived || !g.account_id || !accounts.has(g.account_id)) continue;
    const list = byAccount.get(g.account_id) ?? [];
    list.push(g);
    byAccount.set(g.account_id, list);
  }
  for (const [account_id, list] of byAccount) {
    const { balance, currency } = accounts.get(account_id)!;
    const d = digitsOf(currency);
    const have = Math.max(0, toUnits(balance, d));
    const allocated = list.filter((g) => g.allocation !== undefined);
    const rest = list.filter((g) => g.allocation === undefined);
    const asSet = allocated.map((g) => Math.max(0, toUnits(g.allocation!, d)));
    const setSum = asSet.reduce((s, u) => s + u, 0);
    const shown = apportion(asSet, have);
    const counted = shown.reduce((s, u) => s + u, 0);
    const scaled = setSum > have;
    allocated.forEach((g, i) => claims.set(g.id, { amount: fromUnits(shown[i], d), kind: 'allocation', scaled, sharedWith: [] }));
    const remainder = have - counted;
    for (const g of rest) {
      claims.set(g.id, { amount: fromUnits(remainder, d), kind: 'remainder', scaled: false, sharedWith: rest.filter((o) => o.id !== g.id).map((o) => o.id) });
    }
    splits.set(account_id, {
      account_id,
      currency,
      balance,
      allocated: fromUnits(setSum, d),
      counted: fromUnits(counted, d),
      unallocated: fromUnits(remainder, d),
      over: fromUnits(Math.max(0, setSum - Math.max(0, toUnits(balance, d))), d),
      goals: list.map((g) => g.id),
      hasAllocations: allocated.length > 0,
    });
  }
  return { claims, accounts: splits };
}

/** An account's allocations a save would leave above its balance, or on an
 *  account whose balance isn't known. */
export type AllocationRefusal = {
  account_id: string;
  /** 'over': more than the balance; 'no_balance': the balance isn't known. */
  reason: 'over' | 'no_balance';
  /** The allocations the save would leave, added up. */
  total: number;
  balance: number | null;
  currency: string | null;
};

/**
 * What a save of `next` would do to allocations that the balances don't
 * allow, given what is stored (`before`). The rule: a save may never raise an
 * account's allocations above its balance, nor raise them at all on an
 * account whose balance isn't known. Allocations set while the balance
 * allowed them, which it no longer does, are kept: a save that leaves an
 * account's total where it was, or lowers it, goes through (the goals show
 * them scaled to fit, see THE RULES), so an unrelated edit is never refused
 * for a balance that fell. Totals are compared in minor units.
 */
export function allocationRefusals(
  next: readonly AllocGoal[],
  before: readonly AllocGoal[],
  balances: ReadonlyMap<string, { balance: number | null; currency: string | null }>
): AllocationRefusal[] {
  const totals = (goals: readonly AllocGoal[]) => {
    const out = new Map<string, number[]>();
    for (const g of goals) {
      if (g.archived || !g.account_id || g.allocation === undefined) continue;
      out.set(g.account_id, [...(out.get(g.account_id) ?? []), g.allocation]);
    }
    return out;
  };
  const after = totals(next);
  const stored = totals(before);
  const refusals: AllocationRefusal[] = [];
  for (const [account_id, amounts] of after) {
    const known = balances.get(account_id);
    const currency = known?.currency ?? null;
    const d = digitsOf(currency);
    const total = amounts.reduce((s, a) => s + toUnits(a, d), 0);
    const was = (stored.get(account_id) ?? []).reduce((s, a) => s + toUnits(a, d), 0);
    if (!known || known.balance === null) {
      if (total > was) refusals.push({ account_id, reason: 'no_balance', total: fromUnits(total, d), balance: null, currency });
      continue;
    }
    if (total > Math.max(toUnits(known.balance, d), was)) {
      refusals.push({ account_id, reason: 'over', total: fromUnits(total, d), balance: known.balance, currency });
    }
  }
  return refusals;
}

/**
 * The most one goal may be given on an account, by the same rule as
 * allocationRefusals: what the balance leaves after the other active goals'
 * allocations, or, when that is less, what the goal has there now (so a
 * goal on an account whose balance fell can still be saved as it is, or
 * lowered). Never below zero.
 */
export function allocationRoom(
  goalId: string,
  accountId: string,
  goals: readonly AllocGoal[],
  balance: number,
  currency: string | null
): number {
  const d = digitsOf(currency);
  let others = 0;
  let own = 0;
  for (const g of goals) {
    if (g.archived || g.account_id !== accountId || g.allocation === undefined) continue;
    if (g.id === goalId) own = toUnits(g.allocation, d);
    else others += toUnits(g.allocation, d);
  }
  return fromUnits(Math.max(0, toUnits(balance, d) - others, own), d);
}
