import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount, type FakeTxn } from './simplefin-fake';

// Splits and groups (#39) on the rows SimpleFIN brings, through the routes
// as a bank's: a row split into parts that keep its source, account and day;
// two grouped at their net; one split refused for a group; and what happens
// to them when an account is let go: kept with its rows when the account is
// kept as a manual one, gone with them when it is removed.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.MAX_TXN_BLOB_CHARS;

mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { setTransportForTests } = await import('@/lib/connectors/http');
const { connect, trackAccounts, releaseAccounts } = await import('@/lib/connectors/manage');
const { connectorAccountsStore } = await import('@/lib/connectors/store');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { forgetEpochs } = await import('@/lib/sessions');
const { ensureTaxonomy } = await import('@/lib/category-store');
const { splitStore } = await import('@/lib/splits');
const { groupStore } = await import('@/lib/groups');
const { summarize } = await import('@/lib/totals');
const { PART_PREFIX } = await import('@/lib/split-rows');
const transactionsRoute = await import('@/app/api/transactions/route');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const NOW = Date.now();
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ago = (n: number) => Math.floor(Date.parse(`${dayOf(NOW - n * DAY)}T12:00:00Z`) / 1000);
const txn = (id: string, daysAgo: number, amount: string, description: string): FakeTxn => ({ id, posted: ago(daysAgo), amount, description });

let server: FakeSimplefin;
beforeAll(async () => {
  server = await FakeSimplefin.start();
});
afterAll(() => {
  setTransportForTests(null);
  server.stop();
});
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  server.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  setTransportForTests(server.transport());
});
afterEach(() => {
  process.env = { ...saved };
});

/** Checking and a card at My Bank through SimpleFIN: a coffee and what a
 *  friend paid back for it on checking, a dinner on the card. */
async function track(): Promise<void> {
  server.accounts = [
    fakeAccount({
      id: 'CHK',
      name: 'Checking',
      balance: '5000.00',
      'balance-date': ago(1),
      transactions: [txn('coffee', 3, '-12.50', 'COFFEE'), txn('venmo', 2, '6.25', 'VENMO FROM SAM')],
    }),
    fakeAccount({ id: 'CARD', name: 'Visa', balance: '-45.67', 'balance-date': ago(1), transactions: [txn('dinner', 2, '-45.67', 'DINER')] }),
  ];
  const { connection_id } = await connect(ctx, 'simplefin', server.setupToken(`t${Math.random()}`), NOW);
  await trackAccounts(
    ctx,
    connection_id,
    [
      { remote_id: 'CHK', type: 'depository' },
      { remote_id: 'CARD', type: 'credit' },
    ],
    NOW
  );
}

const idOf = async (name: string) => [...(await connectorAccountsStore.getAll(ctx)).values()].find((a) => a.name === name)!.account_id;
const rowId = async (account: string, source_id: string) => (await manualTxnStore.get(ctx, await idOf(account)))!.rows.find((r) => r.source_id === source_id)!.id;
const catId = async (name: string) => (await ensureTaxonomy(ctx)).categories.find((c) => c.name === name)!.id;

/** The Activity tab's rows. */
async function activity(): Promise<any[]> {
  const res = await transactionsRoute.GET(new Request('http://localhost/api/transactions'));
  expect(res.status).toBe(200);
  return (await res.json()).transactions;
}
const route = async (path: string, method: string, body: unknown) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res: Response = await mod[method](new Request(`http://localhost/api/${path}`, { method, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const everything = (rows: any[]) => summarize(rows, () => true, 'USD');

describe('splits and groups on the rows SimpleFIN brings', () => {
  test('a row split into parts that keep its source, account and day; two grouped at their net; the totals the same', async () => {
    await track();
    const before = await activity();
    const dinner = await rowId('Visa', 'dinner');
    const split = await route('transaction-splits', 'PUT', {
      transaction_id: dinner,
      parts: [
        { amount: 40, category_id: await catId('food and drink') },
        { amount: 5.67, category_id: await catId('travel') },
      ],
    });
    expect(split.status).toBe(200);
    const coffee = await rowId('Checking', 'coffee');
    const venmo = await rowId('Checking', 'venmo');
    const group = await route('transaction-groups', 'POST', { name: 'Coffee with Sam', category_id: await catId('food and drink'), members: [coffee, venmo] });
    expect(group.status).toBe(200);
    // The split row can't join a group: its parts count on their own.
    expect((await route('transaction-groups', 'PATCH', { id: group.body.id, add: [dinner] })).status).toBe(409);

    const rows = await activity();
    const parts = rows.filter((t) => t.split_of === dinner);
    expect(parts.map((t) => [t.transaction_id.startsWith(PART_PREFIX), t.amount, t.source, t.account_name, t.date, t.name])).toEqual([
      [true, 40, 'simplefin', 'Visa', dayOf(NOW - 2 * DAY), 'DINER'],
      [true, 5.67, 'simplefin', 'Visa', dayOf(NOW - 2 * DAY), 'DINER'],
    ]);
    expect(rows.some((t) => t.transaction_id === dinner)).toBe(false);
    const net = rows.find((t) => t.group_id === group.body.id && t.group_members);
    expect(net).toMatchObject({ name: 'Coffee with Sam', amount: 6.25, source: 'simplefin', account_name: 'Checking' });
    expect(net.group_members.map((m: any) => m.transaction_id).sort()).toEqual([coffee, venmo].sort());
    // Money out falls by what was paid back, as the group nets it; the split moves nothing.
    expect(everything(rows).money_out).toBeCloseTo(everything(before).money_out - 12.5 + 6.25, 8);
    expect(everything(rows).money_in).toBeCloseTo(everything(before).money_in - 6.25, 8);
  });

  test('an account let go and kept as a manual one keeps its splits and groups; one removed takes them with its rows', async () => {
    await track();
    const dinner = await rowId('Visa', 'dinner');
    const coffee = await rowId('Checking', 'coffee');
    const venmo = await rowId('Checking', 'venmo');
    expect(
      (
        await route('transaction-splits', 'PUT', {
          transaction_id: dinner,
          parts: [
            { amount: 40, category_id: await catId('food and drink') },
            { amount: 5.67, category_id: await catId('travel') },
          ],
        })
      ).status
    ).toBe(200);
    const group = await route('transaction-groups', 'POST', { name: 'Coffee with Sam', category_id: await catId('food and drink'), members: [coffee, venmo] });
    expect(group.status).toBe(200);

    // Kept: its rows stay, as they were, and so does the group on them.
    await releaseAccounts(ctx, [await idOf('Checking')], true, NOW);
    expect((await groupStore.getAll(ctx)).get(group.body.id)?.members).toEqual([coffee, venmo]);
    expect((await activity()).find((t) => t.group_id === group.body.id && t.group_members)).toMatchObject({ amount: 6.25 });

    // Removed: its rows go, and the split with them.
    await releaseAccounts(ctx, [await idOf('Visa')], false, NOW);
    expect((await splitStore.getAll(ctx)).has(dinner)).toBe(false);
    expect((await activity()).some((t) => t.split_of === dinner)).toBe(false);
  });
});
