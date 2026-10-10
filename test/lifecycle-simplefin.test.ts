import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount, type FakeTxn } from './simplefin-fake';

// An account's end (#50) on the accounts a SimpleFIN connection keeps up to
// date (lib/connectors/): closing one through the route the app uses, the
// dashboard and net worth from its day, its rows left out from it, and the
// bank SimpleFIN reaches never held for an account that ended.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const plaidCalls: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get: (_target, name) => async () => {
        plaidCalls.push(String(name));
        throw new Error('Plaid must not be called');
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { setTransportForTests } = await import('@/lib/connectors/http');
const { connect, trackAccounts } = await import('@/lib/connectors/manage');
const { connectorAccountsStore } = await import('@/lib/connectors/store');
const { lifecycleStore } = await import('@/lib/lifecycle');
const { readSpending } = await import('@/lib/api-read');
const { forgetEpochs } = await import('@/lib/sessions');
const lifecycleRoute = await import('@/app/api/account-lifecycle/route');
const netWorthRoute = await import('@/app/api/net-worth/route');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const NOW = Date.now();
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Noon UTC, n days ago, as a Unix time. */
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
beforeEach(async () => {
  fake.reset();
  server.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  setTransportForTests(server.transport());
  plaidCalls.length = 0;
});
afterEach(() => expect(plaidCalls).toEqual([]));

const CHECKING = () => fakeAccount({ id: 'CHK', name: 'Checking', balance: '1500.25', 'balance-date': ago(1), transactions: [txn('c1', 3, '-12.50', 'COFFEE')] });
const CARD = () =>
  fakeAccount({ id: 'CARD', name: 'Visa', balance: '-432.10', 'balance-date': ago(1), transactions: [txn('v1', 9, '-20.00', 'BOOKS'), txn('v2', 2, '-45.67', 'DINER')] });

/** A SimpleFIN connection tracking a checking account and a card at My Bank. */
async function trackBoth(): Promise<{ connection_id: string; checking: string; card: string }> {
  server.accounts = [CHECKING(), CARD()];
  const { connection_id } = await connect(ctx, 'simplefin', server.setupToken(`t${Math.random()}`));
  await trackAccounts(ctx, connection_id, [
    { remote_id: 'CHK', type: 'depository' },
    { remote_id: 'CARD', type: 'credit' },
  ]);
  const byName = new Map([...(await connectorAccountsStore.getAll(ctx)).values()].map((a) => [a.name, a.account_id]));
  return { connection_id, checking: byName.get('Checking')!, card: byName.get('Visa')! };
}

/** A change through the route the app uses. */
async function post(body: unknown) {
  const res = await lifecycleRoute.POST(new Request('http://x/api/account-lifecycle', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }));
  return { status: res.status, body: await res.json() };
}

/** The dashboard's live load. */
async function load() {
  const res = await netWorthRoute.GET(new Request('http://x/api/net-worth?refresh=1'));
  return { status: res.status, body: await res.json() };
}

const accountIds = (body: any) => body.institutions.flatMap((i: any) => i.accounts.map((a: any) => a.account_id));

describe('closing an account SimpleFIN keeps up to date', () => {
  test('is an end like any other: from its day it counts in nothing, its rows from then are left out, and reopening puts it back', async () => {
    const { card, checking } = await trackBoth();
    const before = await load();
    expect(accountIds(before.body)).toEqual(expect.arrayContaining([checking, card]));
    // Closed at the bank a week ago; SimpleFIN still returns it.
    const { status, body } = await post({ account_id: card, state: 'closed', on: dayOf(NOW - 7 * DAY), balance: 432.1 });
    expect(status).toBe(200);
    expect(body).toEqual({ account_id: card, lifecycle: { state: 'closed', on: dayOf(NOW - 7 * DAY) } });
    // What its end keeps: from its SimpleFIN entry, with no Plaid connection.
    expect(await lifecycleStore.get(ctx, card)).toMatchObject({
      type: 'credit',
      label: { name: 'Visa', institution: 'My Bank', mask: null },
      item_id: null,
      currency: 'USD',
      seen: { balance: 432.1 },
    });
    const after = await load();
    expect(accountIds(after.body)).toEqual([checking]);
    expect(after.body.netWorth).toBeCloseTo(1500.25, 6);
    expect(after.body.lifecycle).toEqual([expect.objectContaining({ account_id: card, lifecycle: { state: 'closed', on: dayOf(NOW - 7 * DAY) }, item_id: null })]);
    // Its row from before the end stays; the one after is left out.
    const spent = await readSpending(ctx, { from: dayOf(NOW - 30 * DAY), to: dayOf(NOW) });
    expect(spent.money_out).toBeCloseTo(12.5 + 20, 6);
    // Reopened: back exactly.
    expect((await post({ account_id: card, state: 'active' })).body).toMatchObject({ reopened: true });
    expect((await readSpending(ctx, { from: dayOf(NOW - 30 * DAY), to: dayOf(NOW) })).money_out).toBeCloseTo(12.5 + 20 + 45.67, 6);
    expect(accountIds((await load()).body)).toEqual(expect.arrayContaining([checking, card]));
  });

  test('an id no account has is still refused', async () => {
    await trackBoth();
    expect((await post({ account_id: 'manual_6a3c1f0e-1111-4222-8333-944455556666', state: 'closed', on: dayOf(NOW) })).status).toBe(404);
  });
});
