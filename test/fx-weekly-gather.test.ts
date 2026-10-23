import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, testKey, registerTestContainer, unscopedDataKeys, TEST_CTX } from './fake-redis';
import { ecbHash } from './fx-fixture';
import { addDays } from '@/lib/recurring';

// The weekly summary's gathering with a home currency, from what is stored
// (lib/weekly-summary/gather.ts): the week compared over the rows converted
// as the app counts them, never an amount. Nine usual weeks of 100 USD, and
// this week 100 USD and 100 EUR (115.51 USD at the newest rate): about the
// same as a usual week without a home currency, much higher with one.

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
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { gatherWeekly } = await import('@/lib/weekly-summary/gather');
const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount } = await import('@/lib/manual');
const { addManualTxn, newManualTxn } = await import('@/lib/manual-txns');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');

const ctx = TEST_CTX;
const NOW = Date.parse('2026-10-12T13:00:00Z');

beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await fake.hset(testKey('fx:ecb'), ecbHash());
  const account = { institution_name: 'Wallets', type: 'depository' as const, subtype: null, balance: 100, updated_at: '2026-10-11T00:00:00.000Z' };
  await saveManualAccount(ctx, { ...account, account_id: 'manual_usd', name: 'Dollars' });
  await saveManualAccount(ctx, { ...account, account_id: 'manual_eur', name: 'Euros', currency: 'EUR' });
  const row = (account_id: string, date: string, amount: number, currency: string) =>
    addManualTxn(ctx, newManualTxn(account_id, { amount, currency, date, name: 'Market', category: 'groceries', note: null }));
  for (let i = 1; i <= 9; i++) await row('manual_usd', addDays('2026-10-05', -7 * i), 100, 'USD');
  await row('manual_usd', '2026-10-07', 100, 'USD');
  await row('manual_eur', '2026-10-08', 100, 'EUR');
});
afterEach(() => setSystemTime());

const gather = () => gatherWeekly(ctx, { now: NOW, timeZone: 'UTC', weekday: 1 });

describe('the week against a usual one, gathered', () => {
  test('without a home currency: the euros left out and named', async () => {
    expect((await gather()).spending).toEqual({ kind: 'compared', level: 'same', left_out: ['EUR'] });
  });

  test('with one: the euros counted, converted, so the week reads as it does in the app', async () => {
    await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'USD' });
    expect((await gather()).spending).toEqual({ kind: 'compared', level: 'much_higher', left_out: [] });
  });
});
