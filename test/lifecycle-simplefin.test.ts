import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount, type FakeTxn } from './simplefin-fake';

// An account's end (#50) on the accounts a SimpleFIN connection keeps up to
// date (lib/connectors/): closing one through the route the app uses, the
// dashboard and net worth from its day, its rows left out from it, and the
// bank SimpleFIN reaches never held for an account that ended (the day's
// total, and its history, go on without it). Nya asks no question about one
// SimpleFIN stops returning, or holds at zero: its bank's card says what to
// do.

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
const { connectorAccountsStore, connectionsStore } = await import('@/lib/connectors/store');
const { syncConnection } = await import('@/lib/connectors/sync');
const { lifecycleStore } = await import('@/lib/lifecycle');
const { readSpending } = await import('@/lib/api-read');
const { computeNetWorth, recordFetch, isRecordable } = await import('@/lib/networth');
const { getAccountHistory } = await import('@/lib/history');
const { encrypt } = await import('@/lib/crypto');
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
async function trackBoth(accounts = [CHECKING(), CARD()]): Promise<{ connection_id: string; checking: string; card: string }> {
  server.accounts = accounts;
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
const myBank = <T extends { institution_name: string }>(list: T[]) => list.find((i) => i.institution_name === 'My Bank')!;

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

describe('an account that ended holds nothing at its SimpleFIN bank', () => {
  test('a card SimpleFIN stops returning holds its bank until it is closed in Nya; then the day is recorded without it, and history moves on', async () => {
    const { connection_id, card, checking } = await trackBoth();
    const history = (await connectionsStore.get(ctx, connection_id))!.history!;
    // Closed at the bank: SimpleFIN stops returning it.
    server.accounts = [CHECKING()];
    await syncConnection(ctx, connection_id, { purpose: 'refresh', now: NOW + 3 * DAY });
    let nw = await computeNetWorth(ctx);
    expect(myBank(nw.institutions).health?.detail).toMatchObject({ issue: 'missing', accounts: ['Visa'] });
    expect(isRecordable(myBank(nw.institutions))).toBe(false);
    expect((await connectionsStore.get(ctx, connection_id))!.history).toEqual(history);

    expect((await post({ account_id: card, state: 'closed', on: dayOf(NOW - 2 * DAY), balance: 432.1 })).status).toBe(200);
    nw = await computeNetWorth(ctx);
    const bank = myBank(nw.institutions);
    expect(bank.error).toBeNull();
    expect(bank.health).toMatchObject({ state: 'healthy', detail: { issue: 'ok' } });
    // Left off its card: its last balance is no measurement of today.
    expect(bank.accounts.map((a) => a.account_id)).toEqual([checking]);
    expect(nw.netWorth).toBeCloseTo(1500.25, 6);
    const { date } = await recordFetch(ctx, nw.institutions, nw.netWorth);
    expect(date).toBe(dayOf(Date.now()));
    expect((await getAccountHistory(ctx, checking)).map((p) => p.date)).toEqual([date!]);
    expect(await getAccountHistory(ctx, card)).toEqual([]);
    // The dashboard says nothing is wrong with the bank.
    const { body } = await load();
    expect(myBank<any>(body.institutions).error).toBeNull();
    expect(body.netWorth).toBeCloseTo(1500.25, 6);

    // An answer whole but for it moves history on.
    await syncConnection(ctx, connection_id, { purpose: 'refresh', now: NOW + 3 * DAY });
    expect((await connectionsStore.get(ctx, connection_id))!.history).toEqual({ ...history, to: dayOf(NOW + 3 * DAY) });
  });

  test('a window of older history without it is whole, and the recent days aren’t asked for again', async () => {
    const { connection_id, card } = await trackBoth();
    server.accounts = [CHECKING()];
    const first = await syncConnection(ctx, connection_id, { purpose: 'daily', now: NOW });
    expect(first.backfilled.windows).toBe(1);
    const held = (await connectionsStore.get(ctx, connection_id))!.history!;
    expect(held.failed).toBeTruthy();

    await post({ account_id: card, state: 'closed', on: dayOf(NOW - 2 * DAY), balance: 432.1 });
    const second = await syncConnection(ctx, connection_id, { purpose: 'daily', now: NOW });
    // The last answer was whole for every account that counts.
    expect(second.skipped).toBe('fresh');
    expect(second.backfilled.windows).toBeGreaterThan(0);
    const moved = (await connectionsStore.get(ctx, connection_id))!.history!;
    expect(moved.failed).toBeNull();
    expect(moved.from < held.from).toBe(true);
  });

  test('a bank whose every account ended holds nothing, even a request that failed; balances it didn’t measure are recorded nowhere', async () => {
    const { connection_id, card, checking } = await trackBoth();
    for (const id of [card, checking]) await post({ account_id: id, state: 'closed', on: dayOf(NOW - 2 * DAY), balance: null });
    // Measured: on its card, recorded with the day's total, which the
    // history subtracts from their end on.
    let nw = await computeNetWorth(ctx);
    expect(myBank(nw.institutions).accounts.map((a) => a.account_id).sort()).toEqual([card, checking].sort());
    expect(nw.netWorth).toBeCloseTo(1500.25 - 432.1, 6);
    server.behaviour = { on: 'accounts', status: 503, body: JSON.stringify({ errors: ['Bridge maintenance until 5pm'] }) };
    await syncConnection(ctx, connection_id, { purpose: 'refresh', now: NOW });
    // Not measured: off the card, and the bank with them.
    nw = await computeNetWorth(ctx);
    expect(nw.institutions.find((i) => i.institution_name === 'My Bank')).toBeUndefined();
    expect(nw.institutions.every(isRecordable)).toBe(true);
    expect(nw.netWorth).toBe(0);
  });
});

describe('no question about an account SimpleFIN keeps up to date', () => {
  test('one SimpleFIN stops returning: its card says what to do, nothing is held for an answer, and nothing is ever assumed closed', async () => {
    const { connection_id, card } = await trackBoth();
    server.accounts = [CHECKING()];
    await syncConnection(ctx, connection_id, { purpose: 'refresh' });
    const { body } = await load();
    const row = body.institutions.flatMap((i: any) => i.accounts).find((a: any) => a.account_id === card);
    expect(row).toMatchObject({ stale: true });
    expect(row.question).toBeUndefined();
    expect(row.held).toBeUndefined();
    expect(myBank<any>(body.institutions).health.detail).toMatchObject({ issue: 'missing', accounts: ['Visa'] });
    expect(body.lifecycle).toEqual([]);
    expect(await lifecycleStore.getAll(ctx)).toEqual(new Map());
  });

  test('one at zero for weeks: asked about only at a Plaid connection', async () => {
    const { checking } = await trackBoth([fakeAccount({ id: 'CHK', name: 'Checking', balance: '0.00', 'balance-date': ago(1) }), CARD()]);
    // Measured at zero every day for six weeks, as the snapshot records it.
    for (let i = 42; i >= 1; i--) {
      const date = dayOf(NOW - i * DAY);
      await fake.hset(ctxKey('history:accounts'), { [date]: await encrypt(JSON.stringify({ [checking]: 0 })) });
      await fake.hset(ctxKey('history:net-worth'), { [date]: await encrypt('0') });
    }
    const { body } = await load();
    const row = body.institutions.flatMap((i: any) => i.accounts).find((a: any) => a.account_id === checking);
    expect(row.balance).toBe(0);
    expect(row.question).toBeUndefined();
    expect(await lifecycleStore.getAll(ctx)).toEqual(new Map());
  });
});
