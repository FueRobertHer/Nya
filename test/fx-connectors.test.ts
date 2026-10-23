import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';
import { FakeSimplefin, fakeAccount } from './simplefin-fake';
import { FakeLunchFlow, lfAccount } from './lunchflow-fake';
import { ecbHash } from './fx-fixture';

// Accounts SimpleFIN and Lunch Flow keep up to date are converted from the
// currency each service gives, like any other account: a Lunch Flow account
// in euros and a SimpleFIN one in pounds beside two manual accounts in
// dollars, with the home currency in euros and then in dollars, through the
// dashboard's load (app/api/net-worth) and the read-only API (accounts and
// net worth). The ECB's rates of 14 Sep 2026 (test/fx-fixture.ts): 1 EUR =
// 1.1551 USD = 0.85598 GBP.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// Connecting Lunch Flow is off unless the deployment turns it on
// (lib/connectors/switch.ts). Turned on before each test: test/preload.ts
// clears it before and after each one.
beforeEach(() => {
  process.env.LUNCHFLOW_ENABLED = '1';
});

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
const { setLunchFlowApiForTests } = await import('@/lib/connectors/lunchflow');
const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount } = await import('@/lib/manual');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
const { createToken } = await import('@/lib/api-tokens');
const { computeNetWorth, recordFetch } = await import('@/lib/networth');
const connectRoute = await import('@/app/api/connectors/connect/route');
const accountsRoute = await import('@/app/api/connectors/accounts/route');
const netWorth = await import('@/app/api/net-worth/route');

const ctx = TEST_CTX;
let simplefin: FakeSimplefin;
let lunchflow: FakeLunchFlow;
beforeAll(async () => {
  simplefin = await FakeSimplefin.start();
  lunchflow = await FakeLunchFlow.start();
});
afterAll(() => {
  setTransportForTests(null);
  setLunchFlowApiForTests(null);
  simplefin.stop();
  lunchflow.stop();
});

type Handler = (req: Request) => Promise<Response>;
async function call(handler: Handler, body: unknown): Promise<any> {
  const method = handler === accountsRoute.PUT ? 'PUT' : 'POST';
  const res = await handler(new Request('http://localhost/api/test', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  expect(res.status).toBe(200);
  return res.json();
}

let token = '';
beforeEach(async () => {
  fake.reset();
  simplefin.reset();
  lunchflow.reset();
  forgetEpochs();
  plaidCalls.length = 0;
  await registerTestContainer(fake);
  // Both fakes answer as bridge.test on 127.0.0.1, under one certificate.
  setTransportForTests(simplefin.transport());
  setLunchFlowApiForTests(lunchflow.base());
  simplefin.accounts = [fakeAccount({ id: 'GBP-1', name: 'Pounds', currency: 'GBP', balance: '500.00', 'available-balance': '500.00' })];
  lunchflow.accounts = [lfAccount({ id: 2001, name: 'Euros', institution_name: 'N26', balance: { amount: 1520.4, currency: 'EUR' } })];
  const typed = { institution_name: 'Credit Union', type: 'depository' as const, subtype: null, updated_at: new Date().toISOString() };
  await saveManualAccount(ctx, { ...typed, account_id: 'manual_checking', name: 'Checking', balance: 1000 });
  await saveManualAccount(ctx, { ...typed, account_id: 'manual_wallet', name: 'Wallet', balance: 200 });
  await fake.hset(testKey('fx:ecb'), ecbHash());
  // Connected and tracked through the routes the app calls.
  const sf = await call(connectRoute.POST, { connector: 'simplefin', token: simplefin.setupToken('fx') });
  await call(accountsRoute.PUT, { connection_id: sf.connection_id, track: [{ remote_id: 'GBP-1', type: 'depository' }] });
  const lf = await call(connectRoute.POST, { connector: 'lunchflow', token: lunchflow.key });
  await call(accountsRoute.PUT, { connection_id: lf.connection_id, track: [{ remote_id: '2001', type: 'depository' }] });
  token = (await createToken(ctx, 'Tests')).token;
});
afterEach(() => expect(plaidCalls).toEqual([]));

const chooseHome = (home: string) => currencySettingsStore.set(ctx, { ...NO_SETTINGS, home });
const load = async () => (await (await netWorth.GET(new Request('http://localhost/api/net-worth?refresh=1'))).json()) as any;
async function rest(name: string): Promise<any> {
  const route = await import(`@/app/api/v1/${name}/route`);
  const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${name}`, { headers: { authorization: `Bearer ${token}` } }));
  expect(res.status).toBe(200);
  return res.json();
}
const partsOf = (base: any) => Object.fromEntries(base.parts.map((p: any) => [p.currency, [p.amount ?? p.net_worth, p.converted]]));
const toBaseOf = (accounts: any[]) => Object.fromEntries(accounts.map((a: any) => [a.name, [a.currency, a.to_base]]));

describe('accounts kept up to date by SimpleFIN and Lunch Flow, in their own currencies', () => {
  test('reach net worth in the currency each service gives', async () => {
    const body = await load();
    const accounts = body.institutions.flatMap((i: any) => i.accounts.map((a: any) => [a.name, i.connector ?? 'typed', a.currency]));
    expect(accounts.sort()).toEqual([
      ['Checking', 'typed', 'USD'],
      ['Euros', 'lunchflow', 'EUR'],
      ['Pounds', 'simplefin', 'GBP'],
      ['Wallet', 'typed', 'USD'],
    ]);
    // No home currency: the sum as it always was, and nothing converted.
    expect(body.base).toBeUndefined();
  });

  test('converted into euros: the Lunch Flow account as it is, the others at the ECB’s rates', async () => {
    await chooseHome('EUR');
    const { base } = await load();
    expect(partsOf(base)).toEqual({
      EUR: [1520.4, 1520.4],
      GBP: [500, 584.13], // 500 / 0.85598
      USD: [1200, 1038.87], // 1,200 / 1.1551, once for the currency
    });
    expect(base.net_worth).toBe(3143.4);
    expect(base.left_out).toEqual([]);
    const api = await rest('accounts');
    expect(api.base_currency).toBe('EUR');
    expect(toBaseOf(api.accounts)).toEqual({
      Checking: ['USD', 865.73],
      Euros: ['EUR', 1520.4],
      Pounds: ['GBP', 584.13],
      Wallet: ['USD', 173.15],
    });
    expect((await rest('net-worth')).base).toMatchObject({ net_worth: 3143.4, left_out: [] });
  });

  test('converted into dollars: the Lunch Flow account at the ECB’s rate the other way', async () => {
    await chooseHome('USD');
    const { base } = await load();
    expect(partsOf(base)).toEqual({
      EUR: [1520.4, 1756.21], // 1,520.40 × 1.1551
      GBP: [500, 674.72], // 500 × 1.1551 / 0.85598
      USD: [1200, 1200],
    });
    expect(base.net_worth).toBe(3630.93);
    const api = await rest('accounts');
    expect(toBaseOf(api.accounts)).toEqual({
      Checking: ['USD', 1000],
      Euros: ['EUR', 1756.21],
      Pounds: ['GBP', 674.72],
      Wallet: ['USD', 200],
    });
    expect((await rest('net-worth')).base).toMatchObject({ net_worth: 3630.93, left_out: [] });
  });

  test('a day recorded with them converts each from its currency too', async () => {
    await chooseHome('USD');
    // Two days ago, as the snapshot records it: by account, unconverted.
    const DAY = 86_400_000;
    const then = new Date(Date.now() - 2 * DAY);
    setSystemTime(then);
    try {
      const nw = await computeNetWorth(ctx);
      expect(await recordFetch(ctx, nw.institutions, nw.netWorth)).toMatchObject({ date: then.toISOString().slice(0, 10) });
    } finally {
      setSystemTime();
    }
    const { base, history } = await load();
    const day = then.toISOString().slice(0, 10);
    // The sum as recorded, 1,200 + 500 + 1,520.40, adds up three currencies.
    expect(history.find((p: any) => p.date === day)?.value).toBe(3220.4);
    // Converted, each from its own: the same as today's, at the newest rates.
    expect(base.history.find((p: any) => p.date === day)?.value).toBe(3630.93);
  });
});
