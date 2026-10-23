import { describe, expect, test } from 'bun:test';
import { allocationRefusals, allocationRoom, apportion, splitBalances, type AllocGoal } from '@/lib/goal-allocation';

// How goals on one account share its balance (#42): what they show together
// is never more money than the account holds, whatever the allocations as set
// and whatever the balance did since.

const usd = (balance: number) => new Map([['sav', { balance, currency: 'USD' }]]);
const goal = (id: string, allocation?: number, over: Partial<AllocGoal> = {}): AllocGoal => ({ id, account_id: 'sav', ...(allocation !== undefined ? { allocation } : {}), ...over });

/** What every goal on the account shows, added up, in cents. */
const shownCents = (claims: Map<string, { amount: number }>) => Math.round([...claims.values()].reduce((s, c) => s + c.amount, 0) * 100);

describe('splitting a balance', () => {
  test('a goal without an allocation claims the whole balance, exactly as before allocations existed', () => {
    const { claims, accounts } = splitBalances([goal('a')], usd(10_000));
    expect(claims.get('a')).toEqual({ amount: 10_000, kind: 'remainder', scaled: false, sharedWith: [] });
    expect(accounts.get('sav')).toMatchObject({ allocated: 0, counted: 0, unallocated: 10_000, over: 0, hasAllocations: false });
  });

  test('two goals on one account: each its allocation, and the remainder unallocated', () => {
    const { claims, accounts } = splitBalances([goal('a', 4000), goal('b', 3500.5)], usd(10_000));
    expect(claims.get('a')!.amount).toBe(4000);
    expect(claims.get('b')!.amount).toBe(3500.5);
    expect(accounts.get('sav')).toMatchObject({ allocated: 7500.5, counted: 7500.5, unallocated: 2499.5, over: 0, hasAllocations: true });
  });

  test('a goal without an allocation beside allocated ones claims only what they leave, so together they are the balance', () => {
    const { claims } = splitBalances([goal('a', 4000), goal('b', 3500.5), goal('c')], usd(10_000));
    expect(claims.get('c')).toEqual({ amount: 2499.5, kind: 'remainder', scaled: false, sharedWith: [] });
    expect(shownCents(claims)).toBe(1_000_000);
  });

  test('two goals without allocations each show the remainder, as before, and each says who else counts it', () => {
    const { claims } = splitBalances([goal('a'), goal('b')], usd(800));
    expect(claims.get('a')).toEqual({ amount: 800, kind: 'remainder', scaled: false, sharedWith: ['b'] });
    expect(claims.get('b')!.sharedWith).toEqual(['a']);
  });

  test('a balance that fell below the allocations scales them to fit, by largest remainder, to the cent', () => {
    // 4000.00 and 3500.50 on 6000.00: 3199.786... and 2800.213..., rounded down
    // to 3199.78 and 2800.21, then the last cent to the larger remainder.
    const { claims, accounts } = splitBalances([goal('a', 4000), goal('b', 3500.5), goal('c')], usd(6000));
    expect(claims.get('a')).toEqual({ amount: 3199.79, kind: 'allocation', scaled: true, sharedWith: [] });
    expect(claims.get('b')).toEqual({ amount: 2800.21, kind: 'allocation', scaled: true, sharedWith: [] });
    expect(claims.get('c')!.amount).toBe(0);
    expect(shownCents(claims)).toBe(600_000);
    expect(accounts.get('sav')).toMatchObject({ allocated: 7500.5, counted: 6000, unallocated: 0, over: 1500.5 });
  });

  test('never a cent more than the balance, for any split', () => {
    for (let i = 0; i < 200; i++) {
      const allocations = Array.from({ length: 1 + (i % 5) }, (_, j) => Math.round(((i * 7919 + j * 104729) % 100_000) + 1) / 100);
      const balance = Math.round(((i * 15485863) % 50_000) + 1) / 100;
      const { claims } = splitBalances(allocations.map((a, j) => goal(`g${j}`, a)), usd(balance));
      expect(shownCents(claims)).toBeLessThanOrEqual(Math.round(balance * 100));
      for (const [id, c] of claims) expect(c.amount).toBeLessThanOrEqual(allocations[Number(id.slice(1))]);
    }
  });

  test('an overdrawn or empty account leaves every goal on it at zero', () => {
    const { claims, accounts } = splitBalances([goal('a', 100), goal('b')], usd(-50.25));
    expect(claims.get('a')!.amount).toBe(0);
    expect(claims.get('b')!.amount).toBe(0);
    expect(accounts.get('sav')).toMatchObject({ unallocated: 0, over: 100 });
  });

  test('an archived goal claims nothing, and a goal on an account not given claims nothing', () => {
    const { claims } = splitBalances([goal('a', 9000, { archived: true }), goal('b'), goal('x', 5, { account_id: 'elsewhere' })], usd(1000));
    expect(claims.has('a')).toBe(false);
    expect(claims.get('b')!.amount).toBe(1000);
    expect(claims.has('x')).toBe(false);
  });

  test('a currency without cents splits in whole units', () => {
    const yen = new Map([['sav', { balance: 100_000, currency: 'JPY' }]]);
    const { claims } = splitBalances([goal('a', 70_000), goal('b', 50_000)], yen);
    expect(claims.get('a')!.amount).toBe(58_333);
    expect(claims.get('b')!.amount).toBe(41_667);
  });

  test('apportion hands the last units to the largest remainders, the first among equals', () => {
    expect(apportion([1, 1, 1], 2)).toEqual([1, 1, 0]);
    expect(apportion([300, 300], 1000)).toEqual([300, 300]);
    expect(apportion([5, 5], 0)).toEqual([0, 0]);
  });
});

describe('what a save may do', () => {
  const balances = (balance: number | null) => new Map([['sav', { balance, currency: 'USD' }]]);

  test('allocations that fit the balance are taken', () => {
    expect(allocationRefusals([goal('a', 4000), goal('b', 6000)], [], balances(10_000))).toEqual([]);
  });

  test('allocations over the balance are refused, with the total and the balance', () => {
    expect(allocationRefusals([goal('a', 4000), goal('b', 6000.01)], [goal('a', 4000)], balances(10_000))).toEqual([
      { account_id: 'sav', reason: 'over', total: 10_000.01, balance: 10_000, currency: 'USD' },
    ]);
  });

  test('after the balance fell, a save that leaves the total where it was, or lowers it, still goes through', () => {
    const stored = [goal('a', 4000), goal('b', 3500.5)];
    expect(allocationRefusals([goal('a', 4000), goal('b', 3500.5)], stored, balances(6000))).toEqual([]);
    expect(allocationRefusals([goal('a', 4000), goal('b', 3000)], stored, balances(6000))).toEqual([]);
    // Moving money between them is not raising the total.
    expect(allocationRefusals([goal('a', 4500.5), goal('b', 3000)], stored, balances(6000))).toEqual([]);
    expect(allocationRefusals([goal('a', 4000), goal('b', 3600)], stored, balances(6000))).toEqual([
      { account_id: 'sav', reason: 'over', total: 7600, balance: 6000, currency: 'USD' },
    ]);
  });

  test('on an account whose balance isn’t known, nothing new can be allocated, and what is there is kept', () => {
    expect(allocationRefusals([goal('a', 100)], [], balances(null))).toEqual([{ account_id: 'sav', reason: 'no_balance', total: 100, balance: null, currency: 'USD' }]);
    expect(allocationRefusals([goal('a', 100)], [], new Map())).toEqual([{ account_id: 'sav', reason: 'no_balance', total: 100, balance: null, currency: null }]);
    expect(allocationRefusals([goal('a', 100)], [goal('a', 100)], balances(null))).toEqual([]);
  });

  test('archived goals’ allocations are not counted, and restoring one counts it again', () => {
    expect(allocationRefusals([goal('a', 9000), goal('b', 5000, { archived: true })], [], balances(10_000))).toEqual([]);
    expect(allocationRefusals([goal('a', 9000), goal('b', 5000)], [goal('a', 9000), goal('b', 5000, { archived: true })], balances(10_000))).toHaveLength(1);
  });

  test('the room the editor offers is the same rule', () => {
    const goals = [goal('a', 4000), goal('b', 3500.5)];
    expect(allocationRoom('c', 'sav', goals, 10_000, 'USD')).toBe(2499.5);
    expect(allocationRoom('b', 'sav', goals, 10_000, 'USD')).toBe(6000);
    // The balance fell: b may stay at what it has, or go lower.
    expect(allocationRoom('b', 'sav', goals, 6000, 'USD')).toBe(3500.5);
    expect(allocationRoom('c', 'sav', goals, 6000, 'USD')).toBe(0);
  });
});
