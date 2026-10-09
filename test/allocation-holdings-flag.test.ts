import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, unscopedDataKeys } from './fake-redis';

// The flag /api/net-worth sends when an investment account's positions didn't
// come (lib/networth.ts markUnanswered): the holdings call failed this time,
// or its answer left the account out. The allocation counts such an account's
// balance as unclassified whole, never spread by the split meant for its
// unlisted money (lib/allocation/allocation.ts). A connection with no
// positions to give at all is not flagged: its accounts list none, as a
// manual one does.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const accounts = [
  { account_id: 'brk', name: 'Brokerage', type: 'investment', subtype: 'brokerage', balances: { current: 100_000, iso_currency_code: 'USD' } },
  { account_id: 'ira', name: 'IRA', type: 'investment', subtype: 'ira', balances: { current: 50_000, iso_currency_code: 'USD' } },
  { account_id: 'chk', name: 'Checking', type: 'depository', subtype: 'checking', balances: { current: 2_000, iso_currency_code: 'USD' } },
];
// What the holdings call does: answer for these accounts, or fail this way.
// mock.module is process-wide in Bun, so every Plaid call fetchInstitution
// can make is stubbed.
const plaid: { answerFor: string[]; fail: unknown } = { answerFor: [], fail: null };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async () => ({ data: { item: { institution_id: 'ins_1' }, accounts } }),
    investmentsHoldingsGet: async () => {
      if (plaid.fail) throw plaid.fail;
      return {
        data: {
          accounts: accounts.filter((a) => plaid.answerFor.includes(a.account_id)),
          holdings: plaid.answerFor.map((account_id) => ({ account_id, security_id: 'vti', quantity: 1, institution_price: 1, institution_value: 1, iso_currency_code: 'USD' })),
          securities: [{ security_id: 'vti', ticker_symbol: 'VTI', name: 'VTI', type: 'etf', is_cash_equivalent: false }],
        },
      };
    },
    liabilitiesGet: async () => ({ data: { liabilities: {} } }),
  },
}));

const { fetchInstitution } = await import('@/lib/networth');
const { encrypt } = await import('@/lib/crypto');
const { allocate } = await import('@/lib/allocation/allocation');

beforeEach(() => {
  fake.reset();
  plaid.answerFor = [];
  plaid.fail = null;
});

const fetchIt = async () => fetchInstitution({ item_id: 'item_v', institution_name: 'Vanguard', encrypted_access_token: await encrypt('tok') } as any);
const flags = (inst: Awaited<ReturnType<typeof fetchIt>>) => inst.accounts.map((a: any) => [a.account_id, a.holdings_unanswered === true]);

describe('the holdings call’s flag on each account', () => {
  test('an answer for every investment account flags none', async () => {
    plaid.answerFor = ['brk', 'ira'];
    expect(flags(await fetchIt())).toEqual([
      ['brk', false],
      ['ira', false],
      ['chk', false],
    ]);
  });

  test('an answer that leaves an account out flags that one', async () => {
    plaid.answerFor = ['ira'];
    expect(flags(await fetchIt())).toEqual([
      ['brk', true],
      ['ira', false],
      ['chk', false],
    ]);
  });

  test('a call that failed this time flags every investment account, never the others', async () => {
    for (const fail of [
      { response: { status: 500, data: { error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_DOWN' } } },
      { response: { status: 400, data: { error_type: 'ITEM_ERROR', error_code: 'PRODUCT_NOT_READY' } } },
      new Error('socket hang up'),
    ]) {
      plaid.fail = fail;
      expect(flags(await fetchIt())).toEqual([
        ['brk', true],
        ['ira', true],
        ['chk', false],
      ]);
    }
  });

  test('a connection with no positions to give flags none: its accounts list none, as a manual one does', async () => {
    for (const code of ['PRODUCTS_NOT_SUPPORTED', 'ADDITIONAL_CONSENT_REQUIRED', 'NO_INVESTMENT_ACCOUNTS', 'INVALID_PRODUCT']) {
      plaid.fail = { response: { status: 400, data: { error_type: 'ITEM_ERROR', error_code: code } } };
      expect(flags(await fetchIt()).every(([, flagged]) => !flagged)).toBe(true);
    }
  });

  test('a flagged account is unclassified whole in the allocation, whatever split was set for its unlisted money', async () => {
    plaid.fail = { response: { status: 500, data: { error_code: 'INSTITUTION_DOWN' } } };
    const inst = await fetchIt();
    // As components/Dashboard.tsx planInstitutions passes it.
    const alloc = allocate({
      institutions: [
        {
          name: inst.institution_name,
          item_id: inst.item_id,
          error: false,
          staleAsOf: null,
          missing: 0,
          accounts: inst.accounts.map((a: any) => ({ account_id: a.account_id, name: a.name, type: a.type, subtype: a.subtype, balance: a.balance, currency: a.currency, positionsFailed: a.holdings_unanswered === true })),
        },
      ],
      holdings: inst.holdings,
      settings: { v: 1, buckets: [], funds: [], accounts: [{ account_id: 'brk', split: { cash: 100 } }], target: null },
      currency: 'USD',
    });
    expect(alloc.classes).toMatchObject({ cash: 0, unclassified: 150_000 });
    expect(alloc.gaps.map((g) => [g.account_id, g.kind, g.split])).toEqual([
      ['brk', 'no-answer', null],
      ['ira', 'no-answer', null],
    ]);
  });
});
