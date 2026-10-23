import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';
import { ecbHash } from './fx-fixture';

// What the page converts its transactions' totals with (app/api/transactions
// `fx`, lib/fx/read.ts readFlowFx): absent without a home currency, so every
// total is today's; with one, the table for the rows' currencies and years,
// read after the cache on every load, so no cached payload holds it.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('Plaid must not be called');
      },
    }
  ),
}));
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount } = await import('@/lib/manual');
const { addManualTxn, newManualTxn } = await import('@/lib/manual-txns');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
const { asFxTable } = await import('@/lib/fx/fields');
const { totalsIn } = await import('@/lib/fx/totals');
const { CacheKey, readCache } = await import('@/lib/cache');
const route = await import('@/app/api/transactions/route');

const ctx = TEST_CTX;
const load = async () => (await (await route.GET(new Request('http://localhost/api/transactions'))).json()) as any;

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await fake.hset(testKey('fx:ecb'), ecbHash());
  await saveManualAccount(ctx, { account_id: 'manual_cash', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: null, balance: 100, updated_at: '2026-09-01T00:00:00.000Z' });
  const fields = { amount: 12.34, currency: 'USD', name: 'Blue Bottle', category: 'food and drink', note: null };
  await addManualTxn(ctx, newManualTxn('manual_cash', { ...fields, date: '2026-09-11' }));
  await addManualTxn(ctx, newManualTxn('manual_cash', { ...fields, date: '2026-09-14', amount: 100 }));
});

describe('the transactions’ exchange rates', () => {
  test('none without a home currency: every total is today’s', async () => {
    const body = await load();
    expect(body.transactions).toHaveLength(2);
    expect(body.fx).toBeUndefined();
  });

  test('with one: the table for the rows’ currencies, which the page converts them by, to the cent', async () => {
    await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'EUR' });
    const body = await load();
    const fx = asFxTable(body.fx);
    expect(fx).not.toBeNull();
    expect(fx!.home).toBe('EUR');
    expect(Object.keys(fx!.series).filter((id) => id.startsWith('USD:'))).toContain('USD:2026');
    // 12.34 / 1.1592 on the 11th and 100 / 1.1551 on the 14th.
    expect(totalsIn(body.transactions, fx).rows.map((r: any) => r.amount).sort()).toEqual([10.65, 86.57]);
    // Never in a cached payload.
    expect(JSON.stringify(await readCache(ctx, CacheKey.Transactions))).not.toContain('"home"');
  });

  test('rates that can’t be read just now: the rows still come, and what is in another currency is left out and named', async () => {
    await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'EUR' });
    const hmget = fake.hmget.bind(fake);
    fake.hmget = (async (key: string, ...fields: string[]) => {
      if (key.includes('fx:ecb')) throw new Error('storage out of reach');
      return hmget(key, ...fields);
    }) as typeof fake.hmget;
    const [error] = [console.error];
    console.error = () => {};
    try {
      const res = await route.GET(new Request('http://localhost/api/transactions'));
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.transactions).toHaveLength(2);
      const t = totalsIn(body.transactions, asFxTable(body.fx));
      // No rate on any day: the dollars stay in their own currency, named, and why.
      expect(t.rows.map((r: any) => r.iso_currency_code)).toEqual(['USD', 'USD']);
      expect(t.conversion?.unrated).toEqual([{ currency: 'USD', why: 'not-fetched', unrated: 'USD' }]);
    } finally {
      fake.hmget = hmget;
      console.error = error;
    }
  });

  test('a row that says no currency: its account’s, from what Nya keeps of the accounts', async () => {
    await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'EUR' });
    await saveManualAccount(ctx, { account_id: 'manual_gbp', name: 'Pounds', institution_name: 'Bank', type: 'depository', subtype: null, balance: 1, currency: 'GBP', updated_at: '2026-09-01T00:00:00.000Z' });
    const { readFlowFx } = await import('@/lib/fx/read');
    const fx = await readFlowFx(ctx, [{ date: '2026-09-14', iso_currency_code: null, account_id: 'manual_gbp' }]);
    expect(fx?.accounts).toEqual({ manual_gbp: 'GBP' });
    expect(Object.keys(fx!.series)).toContain('GBP:2026');
    // 10 GBP on the 14th, at 0.85598: 11.68 EUR.
    const t = totalsIn([{ transaction_id: 'x', date: '2026-09-14', amount: 10, iso_currency_code: null, transaction_code: null, category: 'groceries', account_id: 'manual_gbp' }], fx);
    expect(t.rows[0]).toMatchObject({ amount: 11.68, iso_currency_code: 'EUR', converted: { amount: 10, currency: 'GBP' } });
    expect(t.conversion?.assumed).toBe(0);
  });

  test('with the rates of the accounts’ currencies too, which no row is in: the Plan converts into its accounts’ currency', async () => {
    await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'EUR' });
    await saveManualAccount(ctx, { account_id: 'manual_isa', name: 'ISA', institution_name: 'Broker', type: 'investment', subtype: null, balance: 5_000, currency: 'GBP', updated_at: '2026-09-01T00:00:00.000Z' });
    const fx = asFxTable((await load()).fx)!;
    expect(Object.keys(fx.series).filter((id) => id.startsWith('GBP:'))).toContain('GBP:2026');
  });
});
