import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';
import { ecbHash } from './fx-fixture';

// Net worth in a home currency, through the dashboard's own load
// (app/api/net-worth), with Plaid stubbed: a bank with an account in dollars,
// one in euros and one in bitcoin (Plaid's unofficial code), the ECB's rates
// of 11 and 14 Sep 2026, a point recorded on Friday the 11th and today's.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const plaid = { accounts: [] as any[] };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async () => ({ data: { item: { institution_id: 'ins_1' }, accounts: plaid.accounts } }),
    investmentsHoldingsGet: async () => ({ data: { accounts: [], holdings: [], securities: [] } }),
    liabilitiesGet: async () => ({ data: { liabilities: {} } }),
    itemRemove: async () => ({ data: {} }),
  },
}));

const { encrypt, decrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
const { clearNetWorthCache } = await import('@/lib/cache');
const route = await import('@/app/api/net-worth/route');

const account = (account_id: string, type: string, current: number, currency: { iso?: string; unofficial?: string }) => ({
  account_id,
  name: account_id,
  official_name: null,
  type,
  subtype: null,
  mask: null,
  balances: { available: null, current, limit: null, iso_currency_code: currency.iso ?? null, unofficial_currency_code: currency.unofficial ?? null },
});
const USD = account('chk', 'depository', 1000, { iso: 'USD' });
const EUR = account('eur', 'depository', 2000, { iso: 'EUR' });
const BTC = account('btc', 'investment', 0.5, { unofficial: 'BTC' });

async function load(query = '?refresh=1') {
  const res = await route.GET(new Request(`http://x/api/net-worth${query}`));
  return { status: res.status, body: (await res.json()) as any };
}
const chooseHome = (home: string | null) => currencySettingsStore.set(TEST_CTX, { ...NO_SETTINGS, home });
const storedTotal = async (day: string) => Number(await decrypt(TEST_CTX, (await fake.hget<string>(ctxKey('history:net-worth'), day))!));

beforeEach(async () => {
  setSystemTime(new Date('2026-09-14T17:00:00Z'));
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(TEST_CTX, { item_id: 'item_bank', institution_name: 'Bank', encrypted_access_token: await encrypt(TEST_CTX, 'tok') });
  plaid.accounts = [USD, EUR, BTC];
  await fake.hset(testKey('fx:ecb'), ecbHash());
  // Friday: the same balances.
  await fake.hset(ctxKey('history:accounts'), { '2026-09-11': await encrypt(TEST_CTX, JSON.stringify({ chk: 1000, eur: 2000, btc: 0.5 })) });
  await fake.hset(ctxKey('history:net-worth'), { '2026-09-11': await encrypt(TEST_CTX, '3000.5') });
});
afterEach(() => setSystemTime());

describe('without a home currency', () => {
  test('every figure is today’s, nothing more is read, and no base is answered', async () => {
    const { status, body } = await load();
    expect(status).toBe(200);
    expect(body.base).toBeUndefined();
    expect(body.history_split).toBeUndefined();
    // The unconverted sum, as always: 1000 + 2000 + 0.5.
    expect(body.netWorth).toBe(3000.5);
    expect(body.history.map((p: any) => [p.date, p.value])).toEqual([
      ['2026-09-11', 3000.5],
      ['2026-09-14', 3000.5],
    ]);
  });

  test('a bitcoin account says its currency now', async () => {
    const { body } = await load();
    const btc = body.institutions[0].accounts.find((a: any) => a.account_id === 'btc');
    expect(btc.currency).toBe('BTC');
  });
});

describe('with a home currency', () => {
  test('net worth now, each currency’s part, and what was left out', async () => {
    await chooseHome('EUR');
    const { body } = await load();
    expect(body.netWorth).toBe(3000.5); // what it has always meant
    expect(body.base).toMatchObject({ currency: 'EUR', net_worth: 2865.73, unknown: 0 });
    expect(body.base.parts.map((p: any) => [p.currency, p.amount, p.converted])).toEqual([
      ['EUR', 2000, 2000],
      ['USD', 1000, 865.73], // 1,000 / 1.1551
      ['BTC', 0.5, null],
    ]);
    expect(body.base.left_out).toEqual([{ currency: 'BTC', accounts: 1, why: 'not-published' }]);
    expect(body.base.rates).toMatchObject({ day: '2026-09-14', own: [] });
    expect(body.base.fx.latest.rates).toEqual({ USD: '1.1551' });
  });

  test('the chart, each day at its own rate, today’s point the hero’s', async () => {
    await chooseHome('EUR');
    const { body } = await load();
    expect(body.base.history.map((p: any) => [p.date, p.value])).toEqual([
      ['2026-09-11', 2862.66], // 2,000 + 1,000 / 1.1592
      ['2026-09-14', 2865.73],
    ]);
    // Today's stored point is read too, its total recorded before the
    // history is (with a home currency the read waits for the accounts).
    expect(body.base.gaps.left_out).toEqual([{ currency: 'BTC', from: '2026-09-11', to: '2026-09-14', days: 2 }]);
    // The change is all exchange rates: the balances held still.
    expect(body.base.delta).toMatchObject({ value: 3.07, from: '2026-09-11', to: '2026-09-14', from_rates: 3.07 });
  });

  test('a cached load converts the same, and never sends the split', async () => {
    await chooseHome('EUR');
    const fresh = await load();
    const cached = await load('');
    expect(cached.body.from_cache).toBe(true);
    expect(cached.body.history_split).toBeUndefined();
    expect(cached.body.base).toEqual(fresh.body.base);
  });

  test('a payload cached before the choice is loaded afresh once', async () => {
    await load(); // cached, with no split
    await chooseHome('EUR');
    const after = await load('');
    expect(after.body.from_cache).toBe(false);
    expect(after.body.base.currency).toBe('EUR');
  });

  test('a change of home currency needs no cache cleared', async () => {
    await chooseHome('EUR');
    await load();
    await chooseHome('USD');
    const { body } = await load('');
    expect(body.from_cache).toBe(true);
    expect(body.base.currency).toBe('USD');
    // 2,000 EUR × 1.1551 + 1,000.
    expect(body.base.net_worth).toBe(3310.2);
  });

  test('a hidden account is in no part of it', async () => {
    await chooseHome('EUR');
    await fake.hset(ctxKey('hidden:accounts'), { eur: await encrypt(TEST_CTX, JSON.stringify({ type: 'depository', hidden_at: '2026-09-01T00:00:00.000Z' })) });
    await clearNetWorthCache(TEST_CTX);
    const { body } = await load();
    expect(body.base.parts.map((p: any) => p.currency)).toEqual(['USD', 'BTC']);
    expect(body.base.history.map((p: any) => p.value)).toEqual([862.66, 865.73]);
  });

  test('nothing converted is ever stored', async () => {
    await chooseHome('EUR');
    await load();
    // Today's recorded total is the unconverted sum, as it always was.
    expect(await storedTotal('2026-09-14')).toBe(3000.5);
    const map = JSON.parse(await decrypt(TEST_CTX, (await fake.hget<string>(ctxKey('history:accounts'), '2026-09-14'))!));
    expect(map).toEqual({ chk: 1000, eur: 2000, btc: 0.5 });
  });

  test('everything in the home currency: nothing converted, no rate read, none said to be old', async () => {
    await chooseHome('EUR');
    plaid.accounts = [EUR];
    await fake.hset(ctxKey('history:accounts'), { '2026-09-11': await encrypt(TEST_CTX, JSON.stringify({ eur: 2000 })) });
    await fake.hset(ctxKey('history:net-worth'), { '2026-09-11': await encrypt(TEST_CTX, '2000') });
    const hmget = fake.hmget.bind(fake);
    const asked: string[] = [];
    fake.hmget = (async (key: string, ...fields: string[]) => {
      asked.push(key);
      return hmget(key, ...fields);
    }) as typeof fake.hmget;
    try {
      const { body } = await load();
      expect(body.base).toMatchObject({ currency: 'EUR', net_worth: 2000, left_out: [], rates: { day: null, stale: false } });
      expect(body.base.history.map((p: any) => p.value)).toEqual([2000, 2000]);
      expect(asked.filter((k) => k.includes('fx:'))).toEqual([]);
    } finally {
      fake.hmget = hmget;
    }
  });

  test('settings that can’t be read convert nothing, and say so', async () => {
    await fake.set(ctxKey('currency-settings'), 'not-ciphertext-but-long-enough-to-be-tried');
    const { status, body } = await load();
    expect(status).toBe(200);
    expect(body.base).toBeUndefined();
    expect(body.currency_problem).toBe('unreadable');
    expect(body.netWorth).toBe(3000.5);
    // A cached load says it too.
    expect((await load('')).body).toMatchObject({ from_cache: true, currency_problem: 'unreadable' });
  });
});
