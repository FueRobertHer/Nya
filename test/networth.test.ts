import { describe, expect, test } from 'bun:test';
import { accountBalanceMap } from '@/lib/networth';

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
