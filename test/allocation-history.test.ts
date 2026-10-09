import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { InstitutionResult } from '@/lib/networth';

// Allocation over time: the route that reads holdings history and classifies
// each recorded day (lib/allocation/series.ts). Only recorded days, from the
// first one; a day missing an account says so; hidden accounts left out;
// one currency; what can't be read is a 409, never an empty series.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { observeHoldings, recordHoldings, readHoldingsHistory } = await import('@/lib/holdings-history');
const { allocationSettingsStore } = await import('@/lib/allocation-settings');
const { setAccountHidden } = await import('@/lib/hidden');
const { forgetEpochs } = await import('@/lib/sessions');
const route = await import('@/app/api/allocation-history/route');

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
});

const sec = (id: string, over: Record<string, unknown> = {}) => ({ security_id: id, ticker_symbol: id.toUpperCase(), name: `${id} fund`, type: 'etf', is_cash_equivalent: false, ...over });
const hold = (account_id: string, security_id: string, value: number, over: Record<string, unknown> = {}) => ({
  account_id,
  security_id,
  quantity: 1,
  institution_price: value,
  institution_price_as_of: null,
  institution_value: value,
  cost_basis: null,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  ...over,
});
const SECURITIES = [sec('vti'), sec('bnd'), sec('vfifx', { type: 'mutual fund' }), sec('xeqt')];

/** One fetch's holdings, as fetchInstitution leaves them. */
function broker(accountIds: string[], holdings: any[]): InstitutionResult {
  const accounts = accountIds.map((account_id) => ({ account_id, type: 'investment', balance: 0 }));
  return {
    institution_name: 'Broker',
    item_id: 'item_b',
    accounts,
    holdings: [],
    holdings_observed: observeHoldings({ accounts, holdings, securities: SECURITIES }) ?? undefined,
    error: null,
    needs_reauth: false,
    liabilities: 'unavailable',
  };
}
const record = (iso: string, accountIds: string[], holdings: any[]) => recordHoldings(ctx, [broker(accountIds, holdings)], Date.parse(iso));

const read = async (query: string) => {
  const res = await route.GET(new Request(`http://x/api/allocation-history?${query}`));
  return { status: res.status, body: await res.json() };
};
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.error = orig;
  }
};

describe('allocation over time', () => {
  async function threeDays() {
    await record('2026-09-30T13:00:00Z', ['a', 'b'], [hold('a', 'vti', 600), hold('b', 'bnd', 400)]);
    // b isn't recorded on Oct 1: its institution answered for a alone.
    await record('2026-10-01T13:00:00Z', ['a'], [hold('a', 'vti', 610)]);
    await record('2026-10-03T13:00:00Z', ['a', 'b'], [hold('a', 'vti', 620), hold('b', 'bnd', 380), hold('b', 'vfifx', 100)]);
  }

  test('only recorded days, from the first one, across months, each classified', async () => {
    await threeDays();
    const { status, body } = await read('from=2026-09-01&to=2026-10-09&currency=USD');
    expect(status).toBe(200);
    expect(body).toMatchObject({ from: '2026-09-01', to: '2026-10-09', currency: 'USD', first_recorded: '2026-09-30', last_recorded: '2026-10-03' });
    expect(body.days.map((d: any) => d.date)).toEqual(['2026-09-30', '2026-10-01', '2026-10-03']);
    expect(body.days[0]).toEqual({ date: '2026-09-30', classes: { 'us-stocks': 600, bonds: 400 }, total: 1000, accounts: 2, empty: 0, missing: [], otherCurrencies: {}, unpriced: 0 });
    // The target-date fund is unclassified, as it is today.
    expect(body.days[2].classes).toEqual({ 'us-stocks': 620, bonds: 380, unclassified: 100 });
  });

  test('a day missing an account recorded before and after it names that account', async () => {
    await threeDays();
    const { body } = await read('from=2026-09-01&to=2026-10-09&currency=USD');
    expect(body.days.map((d: any) => [d.date, d.missing])).toEqual([
      ['2026-09-30', []],
      ['2026-10-01', ['b']],
      ['2026-10-03', []],
    ]);
  });

  test('a range that starts after the first recorded day still knows an account recorded before it', async () => {
    await threeDays();
    const { body } = await read('from=2026-10-01&to=2026-10-02&currency=USD');
    expect(body.first_recorded).toBe('2026-09-30');
    expect(body.days).toEqual([expect.objectContaining({ date: '2026-10-01', missing: ['b'] })]);
  });

  test('the person’s splits classify the days too', async () => {
    await threeDays();
    await allocationSettingsStore.set(ctx, { v: 1, buckets: [], funds: [{ ticker: 'VFIFX', split: { 'us-stocks': 60, bonds: 40 } }], accounts: [], target: null });
    const { body } = await read('from=2026-10-03&to=2026-10-03&currency=USD');
    expect(body.days[0].classes).toEqual({ 'us-stocks': 680, bonds: 420 });
  });

  test('hidden accounts are left out, and are never missing', async () => {
    await threeDays();
    await setAccountHidden(ctx, 'b', 'investment', true);
    const { body } = await read('from=2026-09-01&to=2026-10-09&currency=USD');
    expect(body.days.map((d: any) => [d.date, d.total, d.missing])).toEqual([
      ['2026-09-30', 600, []],
      ['2026-10-01', 610, []],
      ['2026-10-03', 620, []],
    ]);
  });

  test('positions in another currency are left out and summed by currency; with none asked, the common one', async () => {
    await record('2026-10-01T13:00:00Z', ['a'], [hold('a', 'vti', 600), hold('a', 'bnd', 100), hold('a', 'xeqt', 50, { iso_currency_code: 'CAD' })]);
    const usd = await read('from=2026-10-01&to=2026-10-01&currency=USD');
    expect(usd.body.days[0]).toMatchObject({ total: 700, otherCurrencies: { CAD: 50 } });
    const cad = await read('from=2026-10-01&to=2026-10-01&currency=CAD');
    expect(cad.body.days[0]).toMatchObject({ total: 50, classes: { unclassified: 50 }, otherCurrencies: { USD: 700 } });
    const common = await read('from=2026-10-01&to=2026-10-01');
    expect(common.body.currency).toBe('USD');
  });

  test('nothing recorded is an empty series, with no first day', async () => {
    const { status, body } = await read('from=2026-09-01&to=2026-10-09&currency=USD');
    expect(status).toBe(200);
    expect(body).toMatchObject({ first_recorded: null, last_recorded: null, days: [] });
  });

  test('a month that can’t be read is a flagged 409, never an empty series', async () => {
    await threeDays();
    const key = ctxKey('holdings:history');
    const [id] = [...(fake as any).hashes.get(key).keys()] as string[];
    await fake.hset(key, { [id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const { status, body } = await quiet(() => read('from=2026-09-01&to=2026-10-09&currency=USD'));
    expect(status).toBe(409);
    expect(body).toMatchObject({ unreadable: true, unreadable_ids: [id] });
  });

  test('settings that can’t be read are a flagged 409 too', async () => {
    await threeDays();
    await fake.set(ctxKey('allocation-settings'), 'damaged');
    const { status, body } = await quiet(() => read('from=2026-09-01&to=2026-10-09&currency=USD'));
    expect(status).toBe(409);
    expect(body.unreadable).toBe(true);
  });

  test('storage that can’t be reached is a 500, without the flag', async () => {
    await threeDays();
    fake.failNext('eval');
    const { status, body } = await quiet(() => read('from=2026-09-01&to=2026-10-09&currency=USD'));
    expect(status).toBe(500);
    expect(body.unreadable).toBeUndefined();
  });

  test('refuses what isn’t a question it answers', async () => {
    for (const q of [
      'from=2026-13-01',
      'from=2026-02-30',
      'to=yesterday',
      'from=2026-10-09&to=2026-10-01',
      'from=2025-01-01&to=2026-10-09',
      'currency=usd',
      'currency=DOLLARS',
      'from=2026-10-01&from=2026-10-02',
    ]) {
      expect((await read(q)).status).toBe(400);
    }
  });
});

describe('when each account was recorded', () => {
  test('an account recorded under an earlier id spans both, under its current id; a hidden one isn’t there', async () => {
    await record('2026-10-05T13:00:00Z', ['acct_old'], [hold('acct_old', 'vti', 1)]);
    await record('2026-10-07T13:00:00Z', ['acct_new', 'other'], [hold('acct_new', 'vti', 1), hold('other', 'bnd', 1)]);
    const links = new Map([['acct_old', { to: 'acct_new', linked_at: '2026-10-08T00:00:00.000Z', evidence: {} }]]);
    const { accounts } = await readHoldingsHistory(ctx, null, { links, hidden: new Set(['other']) });
    expect([...accounts]).toEqual([['acct_new', { first: '2026-10-05', last: '2026-10-07' }]]);
  });
});
