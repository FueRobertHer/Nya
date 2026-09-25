import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

// A balance call that is rate limited `limited` times before it answers.
const plaid = { limited: 0, calls: 0 };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsBalanceGet: async () => {
      plaid.calls++;
      if (plaid.limited-- > 0) throw { response: { status: 429, data: { error_type: 'RATE_LIMIT_EXCEEDED' } } };
      return {
        data: {
          item: { institution_id: 'ins_1' },
          accounts: [{ account_id: 'a1', name: 'Checking', type: 'depository', subtype: 'checking', balances: { current: 100 } }],
        },
      };
    },
  },
}));

const { computeNetWorth } = await import('@/lib/networth');
const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');

beforeEach(async () => {
  fake.reset();
  plaid.calls = 0;
  await saveItem({ item_id: 'item1', institution_name: 'Bank', encrypted_access_token: await encrypt('tok') } as any);
});

describe('a rate-limited balance call', () => {
  test('is waited out rather than failing the institution', async () => {
    plaid.limited = 1;
    const { institutions } = await computeNetWorth();
    expect(plaid.calls).toBe(2);
    expect(institutions[0].error).toBeNull();
    expect(institutions[0].accounts.map((a) => a.account_id)).toEqual(['a1']);
  });
});
