import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys, ctxKey } from './fake-redis';

// Tags and notes are private (#40), and so are rules (#36): what someone is
// shown of an account shared with them at the transactions level is the
// bank's or the manual row's date, name, amount and currency, never a tag, a
// note, or anything a rule says about the row (its name, its category, that
// it is hidden), whatever the owner has put on it.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// The real ceiling on a stored value: a file run before this one may have
// lowered it for its own tests (lib/blob.ts reads it on every write).
delete process.env.MAX_TXN_BLOB_CHARS;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const plaidTxns: Record<string, any[]> = {};
const plaidAccounts: Record<string, any[]> = {};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async (req: any) => ({
      data: {
        added: req.cursor ? [] : (plaidTxns[req.access_token] ?? []),
        modified: [],
        removed: [],
        accounts: plaidAccounts[req.access_token] ?? [],
        next_cursor: 'c1',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { rememberAccounts } = await import('@/lib/last-known');
const links = await import('@/lib/links');
const { saveManualAccount } = await import('@/lib/manual');
const { recordSnapshot } = await import('@/lib/history');
const { newManualTxn, addManualTxn } = await import('@/lib/manual-txns');

const account = (id: string) => ({
  account_id: id,
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask: '1111',
  balances: { available: 100, current: 100, limit: null, iso_currency_code: 'USD' },
});

const route = async (path: string, method: string, body?: unknown) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}${method === 'GET' ? '?refresh=1' : ''}`, { method, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, body: await res.json() };
};
const as = async <T>(user: string, fn: () => Promise<T>) => {
  clerk.signedIn = user;
  return fn();
};

const saved = { ...process.env };
let pair = '';
let ownerCtx: any;
beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_ALLOWED_USER_IDS = 'user_owner,user_partner';
  // The owner's bank: a joint checking account, and a manual one.
  const token = 'token-item_a';
  plaidAccounts[token] = [account('acct_joint')];
  plaidTxns[token] = [
    { transaction_id: 't_recent', account_id: 'acct_joint', amount: 12, iso_currency_code: 'USD', date: daysAgo(3), name: 'BLUE BOTTLE 123', merchant_name: 'Blue Bottle', pending: false, counterparties: [] },
  ];
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt(token) }) });
  const inst = { item_id: 'item_a', institution_name: 'Chase', institution_id: 'ins_3', error: null, accounts: [{ ...account('acct_joint'), balance: 500, currency: 'USD' }] };
  await rememberAccounts(TEST_CTX, [inst as any]);
  await links.recordDirectory(TEST_CTX, [inst as any]);
  await recordSnapshot(TEST_CTX, 500, { acct_joint: 500 });
  await saveManualAccount(TEST_CTX, { account_id: 'manual_house', name: 'House', institution_name: 'Manual', type: 'other', subtype: null, balance: 1, updated_at: new Date().toISOString() } as any);
  await as('user_owner', () => route('transactions', 'GET'));
  await as('user_partner', () => route('shared', 'GET'));
  const invite = await as('user_owner', () => route('connections/invite', 'POST', {}));
  const token2 = invite.body.url.split('/connect/')[1];
  pair = (await as('user_partner', () => route('connections/accept', 'POST', { token: token2, label: '' }))).body.id;
  ownerCtx = { container: await (await import('@/lib/owners')).ownerContainer('user_owner') };
});
afterEach(() => {
  process.env = { ...saved };
});

describe('what a share shows of a transaction', () => {
  test('never its tags, its note or what a rule does, on a bank’s row or a manual one', async () => {
    const { row } = await addManualTxn(ownerCtx, newManualTxn('manual_house', { date: daysAgo(2), amount: 40, currency: 'USD', name: 'Hardware store', category: null, note: null }));
    for (const [transaction_id, extra] of [
      ['t_recent', {}],
      [row.id, { account_id: 'manual_house' }],
    ] as const) {
      const r = await as('user_owner', () => route('transaction-annotations', 'PATCH', { transaction_id, ...extra, new_tag: 'SECRET-TAG', note: 'SECRET-NOTE' }));
      expect(r.status).toBe(200);
    }
    // And a rule that renames, refiles, tags and hides both.
    const categories = (await as('user_owner', () => route('categories', 'GET'))).body.categories;
    const travel = categories.categories.find((c: any) => c.name === 'travel').id;
    const madeRule = await as('user_owner', () =>
      route('rules', 'POST', { action: 'add', rule: { conditions: [{ field: 'amount', op: 'gt', value: 1 }], actions: { set_category: travel, set_name: 'SECRET-RULE-NAME', hide: true } } })
    );
    expect(madeRule.status).toBe(200);
    // The owner sees them.
    const mine = (await as('user_owner', () => route('transactions', 'GET'))).body;
    expect(mine.transactions.find((t: any) => t.transaction_id === 't_recent')).toMatchObject({ note: 'SECRET-NOTE', tags: [expect.any(String)], name: 'SECRET-RULE-NAME', excluded: true });

    await as('user_owner', () => route('connections', 'PUT', { id: pair, accounts: { acct_joint: 'transactions', manual_house: 'transactions' } }));
    const shown = (await as('user_partner', () => route('shared', 'GET'))).body.shared;
    const preview = (await as('user_owner', async () => {
      const { GET } = await import('@/app/api/connections/preview/route');
      const res = await GET(new Request(`http://x/api/connections/preview?id=${encodeURIComponent(pair)}`));
      return res.json();
    })) as any;
    for (const view of [shown[0], preview.view]) {
      const txns = view.accounts.flatMap((a: any) => a.transactions ?? []);
      expect(txns.map((t: any) => t.name).sort()).toEqual(['Blue Bottle', 'Hardware store']);
      for (const t of txns) expect(Object.keys(t).sort()).toEqual(['amount', 'currency', 'date', 'name', 'pending']);
      expect(JSON.stringify(view)).not.toMatch(/SECRET|tags|note|rule|excluded|travel/i);
    }
  });
});
