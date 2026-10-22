import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, ctxKey, testKey, registerTestContainer, unscopedDataKeys, TEST_CTX } from './fake-redis';
import { ecbHash } from './fx-fixture';

// The read-only API and the MCP server once the person has chosen a home
// currency (lib/fx/api-base.ts): base_currency, each account's to_base, net
// worth's base and each history point's to_base, beside version 1's fields,
// which keep their meaning. Over the API fixture's person, with three
// accounts more: one in euros (in the recorded history too), one in
// Argentine pesos priced at the person's own rate, and one in dirhams, which
// the ECB doesn't publish. The ECB's rates of 11 and 14 Sep 2026.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid must not be called by the API');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, seedPerson } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { OPERATIONS } = await import('@/lib/api-ops');
const { forgetEpochs } = await import('@/lib/sessions');
const { encrypt, decrypt } = await import('@/lib/crypto');
const { saveManualAccount } = await import('@/lib/manual');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
const mcp = await import('@/app/api/mcp/route');

const routes: Record<string, any> = {};
for (const op of OPERATIONS) routes[op.name] = await import(`@/app/api/v1/${op.name}/route`);

const ARS_RATE = { currency: 'ARS', rate: '0.00071', quote: 'USD', from: null, set_at: '2026-09-01T10:00:00.000Z' };
const chooseHome = (home: string | null, own = [ARS_RATE]) => currencySettingsStore.set(TEST_CTX, { ...NO_SETTINGS, home, own });

let token = '';
beforeEach(async () => {
  setSystemTime(new Date('2026-09-14T18:00:00Z'));
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  await seedPerson(fake);
  token = (await createToken(ctx, 'Tests')).token;
  const updated_at = '2026-09-14T13:00:00.000Z';
  const manual = { institution_name: 'Abroad', type: 'depository' as const, subtype: null, updated_at };
  await saveManualAccount(ctx, { ...manual, account_id: 'manual_eur', name: 'Euros', balance: 2000, currency: 'EUR' });
  await saveManualAccount(ctx, { ...manual, account_id: 'manual_ars', name: 'Pesos', balance: 1_000_000, currency: 'ARS' });
  await saveManualAccount(ctx, { ...manual, account_id: 'manual_aed', name: 'Dirhams', balance: 500, currency: 'AED' });
  // The euro account in the recorded days (11 and 12 Sep), as a snapshot
  // adds it: unconverted, into the total.
  for (const day of ['2026-09-11', '2026-09-12']) {
    const map = JSON.parse(await decrypt(TEST_CTX, (await fake.hget<string>(ctxKey('history:accounts'), day))!));
    const total = Number(await decrypt(TEST_CTX, (await fake.hget<string>(ctxKey('history:net-worth'), day))!));
    await fake.hset(ctxKey('history:accounts'), { [day]: await encrypt(TEST_CTX, JSON.stringify({ ...map, manual_eur: 2000 })) });
    await fake.hset(ctxKey('history:net-worth'), { [day]: await encrypt(TEST_CTX, String(total + 2000)) });
  }
  await fake.hset(testKey('fx:ecb'), {
    ...ecbHash(),
    fetch: JSON.stringify({ at: '2026-09-14T16:30:00.000Z', ok: true, newest: '2026-09-14', last_ok: '2026-09-14T16:30:00.000Z' }),
  });
});
afterEach(() => setSystemTime());

const call = async (name: string, query = '') => {
  const res: Response = await routes[name].GET(new Request(`https://nya.test/api/v1/${name}${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${token}` } }));
  expect([name, res.status]).toEqual([name, 200]);
  return (await res.json()) as any;
};
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const res: Response = await mcp.POST(
    new Request('https://nya.test/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
  );
  return ((await res.json()) as any).result;
};
/** Every key the fake holds, with its value(s) as stored. */
function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of (fake as any).strings as Map<string, string>) out[k] = v;
  for (const [k, h] of (fake as any).hashes as Map<string, Map<string, string>>) out[k] = Object.fromEntries(h);
  return out;
}
const changedKeys = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();

describe('without a home currency', () => {
  test('every new field is null, nothing is converted, and no rate is read', async () => {
    await chooseHome(null, []);
    fake.ops = 0;
    const hmget = fake.hmget.bind(fake);
    const asked: string[] = [];
    fake.hmget = (async (key: string, ...fields: string[]) => {
      asked.push(key);
      return hmget(key, ...fields);
    }) as typeof fake.hmget;
    try {
      expect(await call('me')).toMatchObject({ base_currency: null, own_rates: [] });
      const accounts = await call('accounts');
      expect(accounts.base_currency).toBeNull();
      expect(accounts.accounts.every((a: any) => a.to_base === null)).toBe(true);
      const worth = await call('net-worth');
      expect([worth.base_currency, worth.base]).toEqual([null, null]);
      // Version 1's totals, one per currency, as ever.
      expect(worth.totals.map((t: any) => [t.currency, t.net_worth])).toEqual([
        ['USD', 321480],
        ['AED', 500],
        ['ARS', 1_000_000],
        ['EUR', 2000],
      ]);
      const history = await call('balance-history');
      expect(history.base_currency).toBeNull();
      expect(history.points.every((p: any) => p.to_base === null)).toBe(true);
      expect(asked.filter((k) => k.includes('fx:'))).toEqual([]);
    } finally {
      fake.hmget = hmget;
    }
  });
});

describe('with a home currency', () => {
  beforeEach(() => chooseHome('EUR'));

  test('me says it, and the person’s own rates', async () => {
    expect(await call('me')).toMatchObject({ base_currency: 'EUR', own_rates: [{ currency: 'ARS', rate: 0.00071, quote: 'USD', from: null }] });
  });

  test('net worth’s base: each currency’s balances converted once, at the newest rates; version 1’s fields unchanged', async () => {
    const worth = await call('net-worth');
    expect(worth.totals.find((t: any) => t.currency === 'USD')).toEqual({ currency: 'USD', net_worth: 321480, assets: 321790, debts: 310, accounts: 5 });
    expect(worth.base_currency).toBe('EUR');
    expect(worth.base).toEqual({
      // 2,000 + 321,480 / 1.1551 + 1,000,000 × 0.00071 / 1.1551
      net_worth: 2000 + 278313.57 + 614.67,
      assets: 2000 + 278581.94 + 614.67,
      debts: 268.38,
      accounts: 7,
      parts: [
        { currency: 'EUR', net_worth: 2000, converted: 2000, rate: null, rate_source: null, accounts: 1 },
        { currency: 'USD', net_worth: 321480, converted: 278313.57, rate: 0.865725911177, rate_source: 'ecb', accounts: 5 },
        { currency: 'ARS', net_worth: 1_000_000, converted: 614.67, rate: 0.000614665397, rate_source: 'own', accounts: 1 },
        { currency: 'AED', net_worth: 500, converted: null, rate: null, rate_source: null, accounts: 1 },
      ],
      left_out: [{ currency: 'AED', accounts: 1, why: 'no_rate' }],
      rate_day: '2026-09-14',
      rates_stale: false,
      own_rates: [{ currency: 'ARS', rate: 0.00071, quote: 'USD', from: null }],
    });
    // Each converted on its own: a cent per currency apart, as documented.
    expect(Math.round((worth.base.assets - worth.base.debts) * 100) / 100).toBe(280928.23);
    expect(worth.notes).toContain('1 account in AED isn’t in base, which is in EUR: there is no rate for AED; you can set your own in the app');
  });

  test('each account’s to_base, at the newest rates, in its own sign', async () => {
    const { accounts, base_currency } = await call('accounts');
    expect(base_currency).toBe('EUR');
    const to = Object.fromEntries(accounts.map((a: any) => [a.id, a.to_base]));
    expect(to).toEqual({ acc_chk: 1082.16, acc_card: 268.38, acc_ira: 17747.38, manual_house: 259717.77, manual_wallet: 34.63, manual_eur: 2000, manual_ars: 614.67, manual_aed: null });
  });

  test('net worth’s history: each day at its own rate, from its split by currency', async () => {
    const history = await call('balance-history');
    expect(history.base_currency).toBe('EUR');
    expect(history.points.map((p: any) => [p.date, p.value, p.to_base])).toEqual([
      // 320,750 USD (the hidden savings subtracted) / 1.1592 + 2,000 EUR
      ['2026-09-11', 322750, 278699.45],
      // Saturday: Friday's rate
      ['2026-09-12', 323400, 279260.18],
    ]);
  });

  test('one account’s history from its own currency, each point at its day’s rate', async () => {
    const history = await call('balance-history', 'account_id=acc_chk&include_estimated=true');
    expect(history.points.map((p: any) => [p.date, p.value, p.to_base])).toEqual([
      ['2026-09-04', 900, 774.39],
      ['2026-09-11', 1000, 862.66],
      ['2026-09-12', 1200, 1035.2],
      ['2026-09-13', 1250, 1078.33],
    ]);
    // A currency with no rate on any day: none, said once.
    const aed = await call('balance-history', 'account_id=manual_aed');
    expect(aed.points.every((p: any) => p.to_base === null)).toBe(true);
  });

  test('get_net_worth says it converted, at what, and what it left out', async () => {
    const result = await tool('get_net_worth');
    expect(result.content[0].text).toBe(
      'Net worth 280928.24 EUR, converted into EUR at the ECB’s rates of 2026-09-14 and the person’s own rates (1 account in AED not counted: no rate), from balances dated 2026-09-12 to 2026-09-14. Incomplete: 1 connection hasn’t been loaded yet. See missing_accounts and notes. 1 history point.'
    );
    // A point a month: September's last.
    expect(result.structuredContent.history.points.map((p: any) => p.to_base)).toEqual([279260.18]);
  });

  test('stale rates are said', async () => {
    await fake.hset(testKey('fx:ecb'), { fetch: JSON.stringify({ at: '2026-09-14T16:30:00.000Z', ok: false, reason: 'timeout', newest: null, last_ok: '2026-09-12T16:30:00.000Z' }) });
    const worth = await call('net-worth');
    expect(worth.base.rates_stale).toBe(true);
    expect(worth.notes).toContain('The newest exchange rates Nya has are from 2026-09-14, so base may be out of date');
  });

  test('rates Nya keeps that can’t be read: no rate on their days, said as rates it doesn’t have, and named', async () => {
    await fake.hset(testKey('fx:ecb'), { 'USD:2026': 'damaged' });
    const named = 'Some of the ECB’s rates Nya keeps couldn’t be read (the USD rates of 2026), so those days have no rate until the nightly fetch writes them again.';
    const history = await call('balance-history');
    expect(history.points.map((p: any) => p.to_base)).toEqual([null, null]);
    expect(history.notes).toEqual(['2 points have no to_base, from 2026-09-11 to 2026-09-12: Nya doesn’t have the ECB’s rates for those days yet', named]);
    const account = await call('balance-history', 'account_id=acc_chk&include_estimated=true');
    expect(account.points.map((p: any) => p.to_base)).toEqual([null, null, null, null]);
    expect(account.notes).toEqual(['4 points have no to_base: Nya doesn’t have the ECB’s rates for those days yet', named]);
    // Today's figures take the newest publication, which reads: only named.
    const worth = await call('net-worth');
    expect(worth.base.left_out).toEqual([{ currency: 'AED', accounts: 1, why: 'no_rate' }]);
    expect(worth.notes).toContain(named);
  });

  test('settings that can’t be read convert nothing, and say so', async () => {
    await fake.set(ctxKey('currency-settings'), 'not-ciphertext-but-long-enough-to-be-tried');
    const worth = await call('net-worth');
    expect([worth.base_currency, worth.base]).toEqual([null, null]);
    expect(worth.notes).toContain('Your currency settings couldn’t be read, so nothing is converted into your home currency');
    expect((await call('me')).base_currency).toBeNull();
  });

  test('nothing is written by a converted read', async () => {
    const before = snapshot();
    for (const name of ['me', 'accounts', 'net-worth', 'balance-history']) await call(name);
    await tool('get_net_worth');
    // Only what every API request writes: the token's last use and its count.
    expect(changedKeys(before, snapshot()).filter((k) => !/:api-(requests|tokens)$/.test(k))).toEqual([]);
  });
});

describe('with a home currency the ECB doesn’t publish', () => {
  beforeEach(() => chooseHome('ARS', []));

  test('the home currency is named as the one with no rate, never the accounts’ own', async () => {
    const worth = await call('net-worth');
    expect(worth.base.net_worth).toBe(1_000_000);
    expect(worth.base.left_out).toEqual([
      { currency: 'USD', accounts: 5, why: 'base_has_no_rate' },
      { currency: 'AED', accounts: 1, why: 'no_rate' },
      { currency: 'EUR', accounts: 1, why: 'base_has_no_rate' },
    ]);
    expect(worth.notes).toContain(
      'Nothing can be converted into ARS yet: the ECB doesn’t publish ARS, so 6 accounts in other currencies aren’t in base. You can set a rate of your own for ARS in the app'
    );
    expect(worth.notes.some((n: string) => n.includes('no rate for USD') || n.includes('no rate for EUR'))).toBe(false);
    const result = await tool('get_net_worth', { include_history: false });
    expect(result.content[0].text).toContain('Nothing could be converted into ARS, the home currency: it has no rate.');
  });

  test('the history says it too', async () => {
    const history = await call('balance-history');
    expect(history.points.every((p: any) => p.to_base === null)).toBe(true);
    expect(history.notes).toContain('2 points have no to_base, from 2026-09-11 to 2026-09-12: nothing can be converted into ARS: the ECB doesn’t publish ARS');
    // One account's: the home currency named, never the account's own.
    const account = await call('balance-history', 'account_id=acc_chk&include_estimated=true');
    expect(account.notes).toEqual(['4 points have no to_base: nothing can be converted into ARS: the ECB doesn’t publish ARS']);
  });
});
