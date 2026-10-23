import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, testKey, registerTestContainer, unscopedDataKeys, TEST_CTX } from './fake-redis';
import { ecbHash } from './fx-fixture';

// The read-only API's flows once the person has chosen a home currency
// (lib/fx/api-base.ts flowsConverted): base beside /spending and /cash-flow,
// each transaction's and part's to_base, the recurring bills' base, and how
// /budgets counts spending in other currencies; version 1's own fields keep
// their meaning. Every converted total is its rows converted, to the cent.
// The ECB's rates of 10 to 14 Sep 2026 (test/fx-fixture.ts): 1 EUR = 1.1616
// USD on the 10th; the ECB publishes no rate for AED.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('Plaid must not be called by the API');
      },
    }
  ),
}));
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { createToken } = await import('@/lib/api-tokens');
const { OPERATIONS } = await import('@/lib/api-ops');
const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount } = await import('@/lib/manual');
const { addManualTxn, newManualTxn } = await import('@/lib/manual-txns');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
const { setGoals } = await import('@/lib/goals');
const mcp = await import('@/app/api/mcp/route');
const routes: Record<string, any> = {};
for (const op of OPERATIONS) routes[op.name] = await import(`@/app/api/v1/${op.name}/route`);

const ctx = TEST_CTX;
const cents = (n: number) => Math.round(n * 100) / 100;
let token = '';

beforeEach(async () => {
  setSystemTime(new Date('2026-09-14T18:00:00Z'));
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  await fake.hset(testKey('fx:ecb'), {
    ...ecbHash(),
    fetch: JSON.stringify({ at: '2026-09-14T16:30:00.000Z', ok: true, newest: '2026-09-14', last_ok: '2026-09-14T16:30:00.000Z' }),
  });
  const account = { institution_name: 'Wallets', type: 'depository' as const, subtype: null, balance: 100, updated_at: '2026-09-01T00:00:00.000Z' };
  await saveManualAccount(ctx, { ...account, account_id: 'manual_usd', name: 'Dollars' });
  await saveManualAccount(ctx, { ...account, account_id: 'manual_eur', name: 'Euros', currency: 'EUR' });
  await saveManualAccount(ctx, { ...account, account_id: 'manual_aed', name: 'Dirhams', currency: 'AED' });
  const row = (account_id: string, date: string, amount: number, currency: string, category = 'food and drink') =>
    addManualTxn(ctx, newManualTxn(account_id, { amount, currency, date, name: `Row ${amount}`, category, note: null }));
  await row('manual_usd', '2026-09-10', 116.16, 'USD');
  await row('manual_usd', '2026-09-10', -2000, 'USD', 'income');
  await row('manual_eur', '2026-09-11', 20, 'EUR');
  await row('manual_aed', '2026-09-14', 10, 'AED');
  token = (await createToken(ctx, 'Tests')).token;
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
const SEPTEMBER = 'from=2026-09-01&to=2026-09-30';

describe('without a home currency', () => {
  test('every new field is null, and version 1’s as ever', async () => {
    const spending = await call('spending', SEPTEMBER);
    expect([spending.base_currency, spending.base]).toEqual([null, null]);
    expect(spending.currency).toBe('USD');
    expect(spending.money_out).toBe(116.16);
    const flow = await call('cash-flow', SEPTEMBER);
    expect([flow.base_currency, flow.base]).toEqual([null, null]);
    const page = await call('transactions', SEPTEMBER);
    expect(page.base_currency).toBeNull();
    expect(page.transactions.every((t: any) => t.to_base === null)).toBe(true);
    const budgets = await call('budgets', 'month=2026-09');
    expect([budgets.base_currency, budgets.converted]).toEqual([null, null]);
    const bills = await call('recurring');
    expect([bills.base_currency, bills.base]).toEqual([null, null]);
  });
});

describe('with one', () => {
  beforeEach(() => currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'EUR' }));

  test('spending’s base: each transaction at its own day’s rate, to the cent; version 1’s fields unchanged', async () => {
    const r = await call('spending', SEPTEMBER);
    // Version 1: in USD, the euros and dirhams named.
    expect([r.currency, r.money_out, r.money_in]).toEqual(['USD', 116.16, 2000]);
    expect(r.left_out.map((l: any) => l.currency).sort()).toEqual(['AED', 'EUR']);
    expect(r.base_currency).toBe('EUR');
    // 116.16 / 1.1616 = 100.00, and the euros' 20; 2,000 / 1.1616 = 1,721.76.
    expect(r.base.money_out).toBe(cents(100 + 20));
    expect(r.base.money_in).toBe(1721.76);
    expect(r.base.converted).toEqual([{ currency: 'USD', transactions: 2 }]);
    expect(r.base.rate_days).toEqual({ from: '2026-09-10', to: '2026-09-10' });
    expect(r.base.left_out).toEqual([{ currency: 'AED', transactions: 1, why: 'no_rate' }]);
    expect(r.base.categories.find((c: any) => c.category === 'food and drink').spent).toBe(120);
    expect(r.notes).toContain('1 transaction in AED isn’t in base, which is in EUR: there is no rate for AED on those days; you can set your own in the app');
  });

  test('cash flow’s base agrees with spending’s', async () => {
    const r = await call('cash-flow', SEPTEMBER);
    expect([r.base.money_out, r.base.money_in, r.base.net]).toEqual([120, 1721.76, cents(1721.76 - 120)]);
    expect(r.base.left_out).toEqual([{ currency: 'AED', transactions: 1, why: 'no_rate' }]);
  });

  test('each transaction’s to_base at its day’s rate; none for one with no rate', async () => {
    const page = await call('transactions', SEPTEMBER);
    expect(page.base_currency).toBe('EUR');
    const by = Object.fromEntries(page.transactions.map((t: any) => [`${t.currency} ${t.amount}`, t.to_base]));
    expect(by).toEqual({ 'USD 116.16': 100, 'USD -2000': -1721.76, 'EUR 20': 20, 'AED 10': null });
  });

  test('budgets count spending in other currencies converted into theirs, as the Budgets tab does, and say so', async () => {
    const r = await call('budgets', 'month=2026-09');
    expect(r.currency).toBe('USD');
    expect(r.base_currency).toBe('EUR');
    // 20 EUR on the 11th: 23.18 USD.
    expect(r.converted.converted).toEqual([{ currency: 'EUR', transactions: 1 }]);
    expect(r.left_out).toEqual([{ currency: 'AED', count: 1 }]);
    expect(r.converted.left_out).toEqual([{ currency: 'AED', transactions: 1, why: 'no_rate' }]);
    expect(r.left_out_text).toBe("1 transaction in AED isn't in these budgets, which are in USD: there is no rate for AED on those days.");
  });

  test('a recurring bill’s to_base, and their month, at today’s rates', async () => {
    for (const date of ['2026-06-03', '2026-07-03', '2026-08-03', '2026-09-03'])
      await addManualTxn(ctx, newManualTxn('manual_usd', { amount: 11.62, currency: 'USD', date, name: 'Gym', category: 'personal care', note: null }));
    const r = await call('recurring');
    const gym = r.bills.find((b: any) => b.name === 'Gym');
    // 11.62 / 1.1551, the newest rate.
    expect(gym.to_base).toBe(10.06);
    expect(r.base_currency).toBe('EUR');
    expect(r.base).toEqual({ monthly_total: 10.06, rate_day: '2026-09-14', rates_stale: false, left_out: [] });
    const said = await tool('list_recurring_bills');
    expect(said.content[0].text).toBe('1 recurring bill, about 10.06 EUR a month, converted into EUR at today’s rates.');
  });

  test('a goal stays in its account’s currency; to_base gives it in the home currency, at the newest rates', async () => {
    await setGoals(ctx, [
      { id: '00000000-0000-4000-8000-000000000001', name: 'Trip', target: 1155.1, account_id: 'manual_usd' },
      { id: '00000000-0000-4000-8000-000000000002', name: 'Someday', target: 500, account_id: null },
    ]);
    const r = await call('goals');
    expect(r.base_currency).toBe('EUR');
    const trip = r.goals.find((g: any) => g.name === 'Trip');
    expect([trip.currency, trip.target]).toEqual(['USD', 1155.1]);
    // 1,155.10 / 1.1551 = 1,000.00; the balance it counts, 100 / 1.1551 = 86.57.
    expect(trip.to_base).toEqual({ target: 1000, saved: 86.57 });
    // One with no account says no currency, as before: nothing is relabelled.
    const someday = r.goals.find((g: any) => g.name === 'Someday');
    expect([someday.currency, someday.to_base]).toEqual([null, null]);
  });

  test('the MCP sentence says the converted totals, at what, and what was left out', async () => {
    const result = await tool('spending_by_category', { from: '2026-09-01', to: '2026-09-30' });
    expect(result.content[0].text).toBe(
      'From 2026-09-01 to 2026-09-30: money out 120.00 EUR, money in 1721.76 EUR, over 3 transactions, converted into EUR at the ECB’s rates of 2026-09-10 (1 transaction in AED not counted: no rate).'
    );
    const flow = await tool('get_cash_flow', { from: '2026-09-01', to: '2026-09-30' });
    expect(flow.content[0].text).toContain('money out 120.00 EUR');
  });
});
