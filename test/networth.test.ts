import { describe, expect, test, mock } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';
import type { InstitutionResult } from '@/lib/networth';

// Mock storage BEFORE lib/networth loads, even though nothing here touches
// Redis. lib/networth imports lib/vanished, which pulls in lib/storage,
// lib/last-known and lib/history. Bun shares one module cache across test
// files, so if this file loaded them against the real storage first, a later
// file's mock.module('@/lib/storage') would never reach the copies already
// loaded, and its reads would silently come back empty. Which file loads first
// depends on Bun's file order, so this passed locally and failed in CI.
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/storage', () => storageMock(new FakeRedis()));

const { accountBalanceMap, isRecordable } = await import('@/lib/networth');

// accountBalanceMap feeds recordSnapshot, which writes the REAL history layer.
// Nothing ever rewrites a real point for a past date, so anything wrong that
// reaches it is permanent.

describe('accountBalanceMap', () => {
  const inst = (accounts: any[]) => ({ accounts }) as any;

  test('collects balances across institutions', () => {
    expect(
      accountBalanceMap([
        inst([{ account_id: 'a', balance: 100 }]),
        inst([{ account_id: 'b', balance: 200 }]),
      ])
    ).toEqual({ a: 100, b: 200 });
  });

  test('skips accounts with no balance', () => {
    expect(accountBalanceMap([inst([{ account_id: 'a', balance: null }])])).toEqual({});
  });

  // THE structural guard. The route builds this map before lib/last-known.ts
  // recovers anything, so today the filter never fires -- it exists so that
  // reordering the route can't quietly start recording recovered balances as
  // though they had been measured. Without it, the whole display-only rule
  // rests on statement order and a comment.
  test('never records a balance recovered from a past snapshot', () => {
    expect(
      accountBalanceMap([
        inst([
          { account_id: 'live', balance: 100 },
          { account_id: 'recovered', balance: 5544.35, stale: true },
        ]),
      ])
    ).toEqual({ live: 100 });
  });
});

// The gate every write to the permanent history layer passes through. Three
// routes used to inline `every(i => !i.error)` by hand, so a new reason to
// withhold had to be remembered in three places or it silently was not applied
// in the third. This is that definition, in one place.
describe('isRecordable', () => {
  const inst = (over: Partial<InstitutionResult> = {}) =>
    ({ institution_name: 'Bank', item_id: 'item_a', accounts: [], holdings: [],
       error: null, needs_reauth: false, liabilities: 'unavailable', ...over }) as InstitutionResult;

  test('a healthy institution is recordable', () => {
    expect(isRecordable(inst())).toBe(true);
  });

  test('a failed fetch is not', () => {
    expect(isRecordable(inst({ error: 'Could not fetch balances' }))).toBe(false);
  });

  test('an unconfirmed missing account is not', () => {
    // The whole point of this change: the fetch SUCCEEDED, so `error` is null
    // and the old gate would have waved it through and written a total silently
    // short by that account into a layer nothing rewrites.
    expect(isRecordable(inst({ unconfirmed_missing: 1 }))).toBe(false);
  });

  test('a zero count does not withhold', () => {
    // Accepted closures leave the field unset, but a zero must not read as
    // "something is wrong" if one ever arrives.
    expect(isRecordable(inst({ unconfirmed_missing: 0 }))).toBe(true);
  });
});
