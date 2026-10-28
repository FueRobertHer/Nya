import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys, ctxKey } from './fake-redis';

// Splits and groups are the owner's own, as their notes and tags are (#39,
// #40): what someone is shown of an account shared with them at the
// transactions level is each transaction once, as the bank (or the owner,
// entering it) has it: its date, name, amount and currency. Never its parts,
// a part's note or category, a group, or a group's name.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
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
  const token = 'token-item_a';
  plaidAccounts[token] = [account('acct_joint')];
  plaidTxns[token] = [
    { transaction_id: 't_costco', account_id: 'acct_joint', amount: 150, iso_currency_code: 'USD', date: daysAgo(3), name: 'COSTCO WHSE', merchant_name: 'Costco', pending: false, counterparties: [] },
    { transaction_id: 't_dinner', account_id: 'acct_joint', amount: 120, iso_currency_code: 'USD', date: daysAgo(4), name: 'BISTRO', merchant_name: 'Bistro', pending: false, counterparties: [] },
    { transaction_id: 't_venmo', account_id: 'acct_joint', amount: -60, iso_currency_code: 'USD', date: daysAgo(2), name: 'VENMO CASHOUT', merchant_name: null, pending: false, counterparties: [] },
  ];
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt(TEST_CTX, token) }) });
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

describe('what a share shows of a split or grouped transaction', () => {
  test('each transaction once, as the bank has it: never a part, its note or category, nor a group or its name', async () => {
    const { row } = await addManualTxn(ownerCtx, newManualTxn('manual_house', { date: daysAgo(2), amount: 40, currency: 'USD', name: 'Hardware store', category: null, note: null }));
    const categories = (await as('user_owner', () => route('categories', 'GET'))).body.categories;
    const id = (name: string) => categories.categories.find((c: any) => c.name === name).id;
    const split = (transaction_id: string, parts: unknown) => as('user_owner', () => route('transaction-splits', 'PUT', { transaction_id, parts }));
    expect(
      (await split('t_costco', [
        { amount: 100, category_id: id('food and drink'), note: 'SECRET-PART-NOTE' },
        { amount: 50, category_id: id('travel') },
      ])).status
    ).toBe(200);
    expect((await split(row.id, [{ amount: 30, category_id: id('home improvement'), note: 'SECRET-MANUAL-PART' }, { amount: 10, category_id: id('travel') }])).status).toBe(200);
    const grouped = await as('user_owner', () => route('transaction-groups', 'POST', { name: 'SECRET-GROUP-NAME', category_id: id('food and drink'), members: ['t_dinner', 't_venmo'] }));
    expect(grouped.status).toBe(200);
    // The owner sees the parts and the group.
    const mine = (await as('user_owner', () => route('transactions', 'GET'))).body.transactions;
    expect(mine.filter((t: any) => t.split_of === 't_costco')).toHaveLength(2);
    expect(mine.find((t: any) => t.group_members)).toMatchObject({ name: 'SECRET-GROUP-NAME', amount: 60 });

    await as('user_owner', () => route('connections', 'PUT', { id: pair, accounts: { acct_joint: 'transactions', manual_house: 'transactions' } }));
    const shown = (await as('user_partner', () => route('shared', 'GET'))).body.shared;
    const preview = (await as('user_owner', async () => {
      const { GET } = await import('@/app/api/connections/preview/route');
      const res = await GET(new Request(`http://x/api/connections/preview?id=${encodeURIComponent(pair)}`));
      return res.json();
    })) as any;
    for (const view of [shown[0], preview.view]) {
      const txns = view.accounts.flatMap((a: any) => a.transactions ?? []);
      expect(txns.map((t: any) => [t.name, t.amount]).sort()).toEqual([
        ['Bistro', 120],
        ['Costco', 150],
        ['Hardware store', 40],
        ['VENMO CASHOUT', -60],
      ]);
      // Those five, and for a bank's own text (no merchant name) the flag
      // that has the card show it readably: never anything else.
      for (const t of txns) {
        expect(Object.keys(t).filter((k) => k !== 'name_from_bank').sort()).toEqual(['amount', 'currency', 'date', 'name', 'pending']);
        if ('name_from_bank' in t) expect(t.name_from_bank).toBe(true);
      }
      expect(JSON.stringify(view)).not.toMatch(/SECRET|split|group|travel|food/i);
    }
  });
});
