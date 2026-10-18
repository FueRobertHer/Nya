import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const settingsModule = await import('@/lib/fx/settings');
const { currencySettingsStore, isCurrencySettings, rateTextError, withHome, withOwnRate, withoutOwnRate, readSettingsForDisplay, NO_SETTINGS, MAX_OWN_RATES } = settingsModule;
const { declaredStore } = await import('@/lib/stores');
const { classify } = await import('@/lib/reencrypt');
const { readFx } = await import('@/lib/fx/read');
const home = await import('@/app/api/currency/route');
const rates = await import('@/app/api/currency/rates/route');
const { forgetEpochs } = await import('@/lib/sessions');

const KEY = ctxKey('currency-settings');
const OTHER = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const LATEST = { date: '2026-09-14', rates: { USD: '1.1551', GBP: '0.85598', JPY: '178.52' } };
const env = { ...process.env };

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  clerk.signedIn = null;
  await registerTestContainer(fake);
});
afterEach(() => {
  process.env = { ...env };
});

const json = (r: Response) => r.json() as Promise<any>;
const putHome = (body: unknown) => home.PUT(new Request('http://x/api/currency', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
const putRate = (body: unknown) => rates.PUT(new Request('http://x/api/currency/rates', { method: 'PUT', body: JSON.stringify(body) }));
const delRate = (currency: string) => rates.DELETE(new Request(`http://x/api/currency/rates?currency=${encodeURIComponent(currency)}`, { method: 'DELETE' }));
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.error = orig;
  }
};
const seedLatest = () => fake.hset(testKey('fx:ecb'), { latest: JSON.stringify(LATEST) });

describe('the store', () => {
  test('is declared on the seam, exportable, one encrypted string inside a container', async () => {
    expect(declaredStore('currency-settings')).toMatchObject({ kind: 'value', exportable: true });
    expect(classify(`c:${TEST_CTX.container}:currency-settings`)).toBe('string');
    expect(classify('currency-settings')).toBeNull();
    await currencySettingsStore.set(TEST_CTX, { ...NO_SETTINGS, home: 'EUR' });
    expect(String(fake.strings.get(KEY))).not.toContain('EUR');
  });

  test('its shape is closed: a field this release doesn’t know is unrecognised, never read without it', () => {
    expect(isCurrencySettings(NO_SETTINGS)).toBe(true);
    expect(isCurrencySettings({ ...NO_SETTINGS, home: 'EUR' })).toBe(true);
    expect(isCurrencySettings({ ...NO_SETTINGS, extra: 1 })).toBe(false);
    expect(isCurrencySettings({ ...NO_SETTINGS, home: 'eur' })).toBe(false);
    expect(isCurrencySettings({ ...NO_SETTINGS, home: 'BTC' })).toBe(false);
    expect(isCurrencySettings({ ...NO_SETTINGS, v: 2 })).toBe(false);
    const rate = { currency: 'BTC', rate: '61000', quote: 'USD', from: null, set_at: '2026-09-01T00:00:00.000Z' };
    expect(isCurrencySettings({ ...NO_SETTINGS, own: [rate] })).toBe(true);
    expect(isCurrencySettings({ ...NO_SETTINGS, own: [rate, rate] })).toBe(false); // one per currency
    expect(isCurrencySettings({ ...NO_SETTINGS, own: [{ ...rate, quote: 'BTC' }] })).toBe(false);
    expect(isCurrencySettings({ ...NO_SETTINGS, own: [{ ...rate, note: 'x' }] })).toBe(false);
  });

  test('a rate is checked as typed', () => {
    expect(rateTextError('0.92')).toBeNull();
    expect(rateTextError('61000')).toBeNull();
    expect(rateTextError('0.00071')).toBeNull();
    expect(rateTextError('0,00071')).toBe('Use a full stop for decimals: 0.00071.');
    expect(rateTextError('0')).toMatch(/more than zero/);
    expect(rateTextError('-1')).toMatch(/a number/);
    expect(rateTextError('1e5')).toMatch(/a number/);
    expect(rateTextError('1.2345678901234')).toMatch(/12 significant/);
    expect(rateTextError('5000000000000')).toMatch(/too large/);
    expect(rateTextError('')).toMatch(/a number/);
  });

  test('a change is recorded once, with its day and what it was before; the same choice writes nothing', () => {
    const first = withHome(null, 'EUR', '2026-10-17')!;
    expect(first).toMatchObject({ home: 'EUR', changes: [{ on: '2026-10-17', from: null, to: 'EUR' }] });
    expect(withHome(first, 'EUR', '2026-10-18')).toBe(first);
    expect(withHome(null, null, '2026-10-17')).toBeNull();
    const back = withHome(first, null, '2026-10-19')!;
    expect(back.changes).toEqual([
      { on: '2026-10-17', from: null, to: 'EUR' },
      { on: '2026-10-19', from: 'EUR', to: null },
    ]);
  });

  test('own rates: one per currency, at most 50, removed by currency', () => {
    const r = (currency: string) => ({ currency, rate: '1', quote: 'EUR', from: null, set_at: '2026-09-01T00:00:00.000Z' });
    let s = withOwnRate(null, r('BTC'));
    s = withOwnRate(s, { ...r('BTC'), rate: '2' });
    expect(s.own.map((o) => [o.currency, o.rate])).toEqual([['BTC', '2']]);
    expect(withoutOwnRate(s, 'ARS')).toBe(s);
    expect(withoutOwnRate(s, 'BTC')!.own).toEqual([]);
    let many = NO_SETTINGS;
    for (let i = 0; i < MAX_OWN_RATES; i++) many = withOwnRate(many, r(`X${String(i).padStart(2, '0')}`));
    expect(() => withOwnRate(many, r('BTC'))).toThrow(/50/);
    expect(withOwnRate(many, { ...r('X00'), rate: '3' }).own.length).toBe(MAX_OWN_RATES);
  });

  test('shown figures read settings that can’t be used as none, and say why', async () => {
    expect(await readSettingsForDisplay(TEST_CTX)).toEqual({ settings: NO_SETTINGS, problem: null });
    await fake.set(KEY, 'not-ciphertext-but-long-enough-to-be-tried');
    expect(await readSettingsForDisplay(TEST_CTX)).toEqual({ settings: NO_SETTINGS, problem: 'unreadable' });
    await fake.set(KEY, await encrypt(TEST_CTX, '{"v":2}'));
    expect(await readSettingsForDisplay(TEST_CTX)).toEqual({ settings: NO_SETTINGS, problem: 'unrecognised' });
  });
});

describe('the home currency route', () => {
  test('nothing chosen: no home, no rates, and the ECB’s newest beside them', async () => {
    await seedLatest();
    const body = await json(await home.GET());
    expect(body).toMatchObject({ home: null, own: [], problem: null, removable: false, ecb: { date: '2026-09-14', rates: LATEST.rates, stale: true } });
  });

  test('the person chooses, changes and clears it, each recorded', async () => {
    expect(await json(await putHome({ home: 'EUR' }))).toMatchObject({ home: 'EUR' });
    expect(await json(await putHome({ home: 'USD' }))).toMatchObject({ home: 'USD' });
    const cleared = await json(await putHome({ home: null }));
    expect(cleared.home).toBeNull();
    expect(cleared.changes.map((c: any) => [c.from, c.to])).toEqual([
      [null, 'EUR'],
      ['EUR', 'USD'],
      ['USD', null],
    ]);
    expect((await currencySettingsStore.get(TEST_CTX))?.home).toBeNull();
  });

  test.each([
    ['not JSON', '{'],
    ['an array', '[]'],
    ['no home', '{}'],
    ['an unknown field', '{"home":"EUR","since":"2026-01-01"}'],
    ['lower case', '{"home":"eur"}'],
    ['a code nobody uses', '{"home":"USX"}'],
    ['a cryptocurrency', '{"home":"BTC"}'],
    ['a number', '{"home":978}'],
  ])('refuses %s', async (_, body) => {
    const r = await putHome(body);
    expect(r.status).toBe(400);
    expect(fake.strings.has(KEY)).toBe(false);
  });

  test('never writes over settings it can’t read, and offers removal only for damaged bytes', async () => {
    await fake.set(KEY, 'not-ciphertext-but-long-enough-to-be-tried');
    const r = await quiet(() => putHome({ home: 'EUR' }));
    expect(r.status).toBe(409);
    expect(await json(r)).toMatchObject({ unreadable: true });
    expect(await json(await home.GET())).toMatchObject({ problem: 'unreadable', removable: true, home: null });
    expect((await home.DELETE()).status).toBe(200);
    expect(fake.strings.has(KEY)).toBe(false);

    await fake.set(KEY, await encrypt(TEST_CTX, '{"v":2}'));
    expect(await json(await home.GET())).toMatchObject({ problem: 'unrecognised', removable: false });
    expect((await home.DELETE()).status).toBe(409);
    expect(fake.strings.has(KEY)).toBe(true);
  });

  test('another container’s settings are never read or written', async () => {
    await currencySettingsStore.set(OTHER, { ...NO_SETTINGS, home: 'JPY' });
    expect((await json(await home.GET())).home).toBeNull();
    await putHome({ home: 'EUR' });
    expect((await currencySettingsStore.get(OTHER))?.home).toBe('JPY');
    expect((await currencySettingsStore.get(TEST_CTX))?.home).toBe('EUR');
  });

  test('no container: 503', async () => {
    fake.reset();
    forgetEpochs();
    const r = await quiet(() => putHome({ home: 'EUR' }));
    expect(r.status).toBe(503);
  });
});

describe('the own rates route', () => {
  test('sets one, replaces it, and removes it', async () => {
    await seedLatest();
    expect((await putRate({ currency: 'BTC', rate: '61000', quote: 'USD', from: null })).status).toBe(200);
    const again = await json(await putRate({ currency: 'BTC', rate: '62000', quote: 'USD', from: '2026-09-01' }));
    expect(again.own).toMatchObject([{ currency: 'BTC', rate: '62000', quote: 'USD', from: '2026-09-01' }]);
    expect((await json(await delRate('BTC'))).own).toEqual([]);
    // Removing one there isn't changes nothing.
    expect((await delRate('ARS')).status).toBe(200);
  });

  test('a rate in euros needs no ECB rates', async () => {
    expect((await putRate({ currency: 'USD', rate: '0.90', quote: 'EUR', from: null })).status).toBe(200);
  });

  test.each([
    ['an unknown field', { currency: 'BTC', rate: '1', quote: 'EUR', from: null, note: 'x' }, /Unknown field/],
    ['a decimal comma', { currency: 'ARS', rate: '0,00071', quote: 'EUR', from: null }, /full stop/],
    ['a number for the rate', { currency: 'ARS', rate: 0.00071, quote: 'EUR', from: null }, /as text/],
    ['a zero rate', { currency: 'ARS', rate: '0', quote: 'EUR', from: null }, /more than zero/],
    ['a lower-case currency', { currency: 'btc', rate: '1', quote: 'EUR', from: null }, /code/],
    ['a quote the ECB doesn’t publish', { currency: 'BTC', rate: '1', quote: 'ARS', from: null }, /doesn’t publish/],
    ['the currency as its own quote', { currency: 'USD', rate: '1', quote: 'USD', from: null }, /another currency/],
    ['a day that isn’t one', { currency: 'BTC', rate: '1', quote: 'EUR', from: '2026-02-30' }, /date/],
    ['a day after tomorrow', { currency: 'BTC', rate: '1', quote: 'EUR', from: '2999-01-01' }, /tomorrow/],
  ])('refuses %s', async (_, body, message) => {
    await seedLatest();
    const r = await putRate(body);
    expect(r.status).toBe(400);
    expect((await json(r)).error).toMatch(message);
    expect(fake.strings.has(KEY)).toBe(false);
  });

  test('never over settings it can’t read', async () => {
    await fake.set(KEY, 'not-ciphertext-but-long-enough-to-be-tried');
    expect((await quiet(() => putRate({ currency: 'USD', rate: '0.9', quote: 'EUR', from: null }))).status).toBe(409);
    expect((await quiet(() => delRate('USD'))).status).toBe(409);
  });
});

describe('reading what a request converts with', () => {
  test('no home currency: nothing is read beyond the settings, and nothing converts', async () => {
    await seedLatest();
    const { fx } = await readFx(TEST_CTX, { currencies: ['USD', 'EUR'], from: '2026-09-01', to: '2026-09-14' });
    expect(fx.home).toBeNull();
    expect(fx.latest).toBeNull();
  });

  test('everything in the home currency: no rates read', async () => {
    await seedLatest();
    await currencySettingsStore.set(TEST_CTX, { ...NO_SETTINGS, home: 'USD' });
    const sent = fake.commandLog?.length ?? 0;
    const { fx } = await readFx(TEST_CTX, { currencies: ['USD'], from: '2026-09-01', to: '2026-09-14' });
    expect(fx.home).toBe('USD');
    expect(fx.latest).toBeNull();
    void sent;
  });

  test('another currency: the newest rates and the series it needs, once', async () => {
    await fake.hset(testKey('fx:ecb'), {
      latest: JSON.stringify(LATEST),
      'days:2026': JSON.stringify(['2026-09-14']),
      'USD:2026': JSON.stringify({ '2026-09-14': '1.1551' }),
      'GBP:2026': 'damaged',
    });
    await currencySettingsStore.set(TEST_CTX, { ...NO_SETTINGS, home: 'GBP' });
    const { fx, unusable } = await readFx(TEST_CTX, { currencies: ['USD', 'GBP'], from: '2026-09-14', to: '2026-09-14' });
    expect(fx.home).toBe('GBP');
    expect(fx.latest?.date).toBe('2026-09-14');
    expect(Object.keys(fx.series)).toEqual(['USD:2026']);
    expect(unusable).toEqual(['GBP:2026']);
  });
});
