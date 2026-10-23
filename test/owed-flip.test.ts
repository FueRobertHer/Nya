import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';
import { ecbHash } from './fx-fixture';

// A manual account never changes between money held and money owed
// (lib/manual-account-writes.ts OWED_FLIP): history keeps its past balances
// unsigned beside totals signed when they were recorded, so every reader
// that takes it back out of a total, or splits one, would read each earlier
// day the other way. Refused in the app and through the API alike; what the
// form offers instead, closing it and adding a new one of the other kind,
// keeps every reader right to the cent. Through the dashboard's own load
// (app/api/net-worth), with Plaid stubbed: a checking account in dollars, a
// manual savings account in euros, a day recorded on Friday the 11th, the
// ECB's rates, dollars as the home currency.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const CHK = {
  account_id: 'chk',
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask: '1111',
  balances: { available: 1000, current: 1000, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null },
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async () => ({ data: { item: { institution_id: 'ins_1' }, accounts: [CHK] } }),
    investmentsHoldingsGet: async () => ({ data: { accounts: [], holdings: [], securities: [] } }),
    liabilitiesGet: async () => ({ data: { liabilities: {} } }),
    itemRemove: async () => ({ data: {} }),
    transactionsSync: async (req: any) => ({
      data: {
        added: req.cursor
          ? []
          : [{ transaction_id: 't1', account_id: 'chk', amount: 50, iso_currency_code: 'USD', date: daysAgo(10), name: 'GROCER', merchant_name: 'Grocer', pending: false, counterparties: [], personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' } }],
        modified: [],
        removed: [],
        accounts: [CHK],
        next_cursor: 'c1',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

const { encrypt, decrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
const { saveManualAccount, getManualAccount } = await import('@/lib/manual');
const netWorthRoute = await import('@/app/api/net-worth/route');
const backfillRoute = await import('@/app/api/backfill/route');
const manualRoute = await import('@/app/api/manual-accounts/route');
const lifecycleRoute = await import('@/app/api/account-lifecycle/route');
const { readNetWorthAndHistory } = await import('@/lib/api-read');
const { getHistory, foldHiddenAccount } = await import('@/lib/history');
const { getHiddenAccounts, markForgetting, setAccountHidden } = await import('@/lib/hidden');
const { OWED_FLIP, saveAccountEdit, AccountEditRefused } = await import('@/lib/manual-account-writes');
const { projectViews } = await import('@/lib/share-views');
const { collectUserData, buildUserExport } = await import('@/lib/user-export');

const ctx = TEST_CTX;
const NOW = Date.parse('2026-09-14T17:00:00Z');

async function home() {
  const res = await netWorthRoute.GET(new Request('http://x/api/net-worth?refresh=1'));
  return (await res.json()) as any;
}

beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_bank', institution_name: 'Bank', encrypted_access_token: await encrypt(ctx, 'tok') });
  await fake.hset(testKey('fx:ecb'), ecbHash());
  await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'USD' });
  await saveManualAccount(ctx, { account_id: 'manual_eur', name: 'Euro savings', institution_name: 'Sparkasse', type: 'depository', subtype: null, balance: 5000, currency: 'EUR', updated_at: new Date(NOW - 30 * 86_400_000).toISOString() });
  await fake.hset(ctxKey('history:accounts'), { '2026-09-11': await encrypt(ctx, JSON.stringify({ chk: 1000, manual_eur: 5000 })) });
  await fake.hset(ctxKey('history:net-worth'), { '2026-09-11': await encrypt(ctx, '6000') });
});
afterEach(() => setSystemTime());


const call = async (route: any, method: string, body: unknown) => {
  const res: Response = await route[method](new Request('http://x/api', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};
const estimate = async () => expect((await backfillRoute.POST()).status).toBe(200);
const pts = (list: any[]) => list.map((p: any) => [p.date, p.value, !!p.estimated]);
/** The backfill's own points, before the first recorded day (those between
 *  two recorded days are the chart's bridges across them). */
const estimated = (chart: any[][]) => chart.filter(([d, , est]) => est && d < '2026-09-11');
const EUR = { account_id: 'manual_eur', name: 'Euro savings', institution_name: 'Sparkasse', type: 'depository', subtype: null, balance: 5000, currency: 'EUR' };
const DAY = '2026-09-14';

/**
 * What every reader of net worth says now, to the cent: Home's total, chart
 * and converted chart (app/api/net-worth, which also records today's point),
 * the chart with `hide` hidden, as each hidden entry signs it, the API's net
 * worth and its history (lib/api-read.ts), a share of net worth with its
 * history (lib/share-views.ts), and the download's history, as stored.
 */
async function readers(hide: { id: string; type: string }[] = []) {
  const h = await home();
  const hidden = new Map(hide.map((x) => [x.id, { type: x.type, hidden_at: new Date(NOW).toISOString() }]));
  const api = await readNetWorthAndHistory(ctx, { includeEstimated: true, interval: 'day' } as any, { base: 'private' } as any);
  const share = (await projectViews(ctx, { net_worth: { detail: 'history', accounts: false } } as any, NOW))!.views.net_worth as any;
  const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date()) as any;
  return {
    total: h.netWorth,
    converted_total: h.base.net_worth,
    chart: pts(h.history),
    converted_chart: pts(h.base.history),
    hidden_chart: hide.length > 0 ? pts(await getHistory(ctx, hidden)) : null,
    api_total: api.now.base!.net_worth,
    api_history: api.history.points.map((p: any) => [p.date, p.value, p.to_base, p.estimated]),
    share_total: share.total,
    share_history: pts(share.history),
    download: doc.net_worth_history.points.map((p: any) => [p.date, p.total, p.kind]),
  };
}

describe('a change between money held and money owed', () => {
  test('is refused in the app and through the API, and every reader reads as before, to the cent', async () => {
    await home();
    await estimate();
    const before = await readers([{ id: 'manual_eur', type: 'depository' }]);
    // The figures themselves: 5,000 euros at 1.1592 on the 11th and 1.1551 on the 14th.
    expect([before.total, before.converted_total]).toEqual([6000, 6775.5]);
    expect(before.converted_chart.filter(([, , est]) => !est)).toEqual([
      ['2026-09-11', 6796, false],
      ['2026-09-14', 6775.5, false],
    ]);
    expect(before.hidden_chart!.filter(([, , est]) => !est)).toEqual([
      ['2026-09-11', 1000, false],
      ['2026-09-14', 1000, false],
    ]);

    // The Update form, as a card.
    const app = await call(manualRoute, 'PATCH', { ...EUR, type: 'credit' });
    expect([app.status, app.body.error]).toEqual([409, OWED_FLIP]);
    // The API's write calls the same function, with only what it changes.
    await expect(saveAccountEdit(ctx, 'manual_eur', { fields: { type: 'loan' } })).rejects.toBeInstanceOf(AccountEditRefused);
    await expect(saveAccountEdit(ctx, 'manual_eur', { fields: { type: 'loan' } })).rejects.toMatchObject({ status: 409, message: OWED_FLIP });
    expect((await getManualAccount(ctx, 'manual_eur'))!.type).toBe('depository');
    expect(await readers([{ id: 'manual_eur', type: 'depository' }])).toEqual(before);

    // Within one side, as ever: savings to other, and back.
    expect((await call(manualRoute, 'PATCH', { ...EUR, type: 'other' })).status).toBe(200);
    expect((await call(manualRoute, 'PATCH', { ...EUR, type: 'depository' })).status).toBe(200);
    await estimate();
    expect(await readers([{ id: 'manual_eur', type: 'depository' }])).toEqual(before);
  });

  test('a card becomes a loan, and a loan a card, but neither money held', async () => {
    await saveManualAccount(ctx, { account_id: 'manual_card', name: 'Card', institution_name: 'Sparkasse', type: 'credit', subtype: null, balance: 300, currency: 'EUR', updated_at: new Date(NOW).toISOString() });
    const card = { account_id: 'manual_card', name: 'Card', institution_name: 'Sparkasse', subtype: null, balance: 300, currency: 'EUR' };
    expect((await call(manualRoute, 'PATCH', { ...card, type: 'loan' })).status).toBe(200);
    expect((await call(manualRoute, 'PATCH', { ...card, type: 'credit' })).status).toBe(200);
    for (const type of ['depository', 'investment', 'other']) {
      const r = await call(manualRoute, 'PATCH', { ...card, type });
      expect([type, r.status, r.body.error]).toEqual([type, 409, OWED_FLIP]);
    }
    expect((await getManualAccount(ctx, 'manual_card'))!.type).toBe('credit');
  });

  test('to owed and back the way the form offers: each closed and a new one added, every reader right to the cent', async () => {
    await home();
    await estimate();
    // To owed: the savings closed today, a card of 300 euros owed added.
    expect((await call(lifecycleRoute, 'POST', { account_id: 'manual_eur', state: 'closed', on: DAY, balance: 5000 })).status).toBe(200);
    const added = await call(manualRoute, 'POST', { name: 'Euro card', institution_name: 'Sparkasse', type: 'credit', subtype: null, balance: 300, currency: 'EUR' });
    expect(added.status).toBe(200);
    const card = added.body.account.account_id as string;
    await estimate();
    const owed = await readers([{ id: 'manual_eur', type: 'depository' }]);
    // Now: 1,000 dollars less 300 euros owed (346.53 dollars at 1.1551).
    expect([owed.total, owed.converted_total, owed.api_total, owed.share_total]).toEqual([700, 653.47, 653.47, 653.47]);
    // Friday counts the savings as it was recorded; today counts it no more.
    // The estimate holds today's accounts flat behind it, the card too, as
    // it does any account added.
    expect(owed.chart.filter(([, , est]) => !est)).toEqual([
      ['2026-09-11', 6000, false],
      [DAY, 700, false],
    ]);
    expect(owed.converted_chart.filter(([, , est]) => !est)).toEqual([
      ['2026-09-11', 6796, false],
      [DAY, 653.47, false],
    ]);
    expect(estimated(owed.chart).length).toBe(7);
    expect(estimated(owed.chart).every(([, v]) => v === 5700)).toBe(true);
    // Hidden, the savings leave every day by what they put in: plus 5,000.
    expect(owed.hidden_chart!.filter(([, , est]) => !est)).toEqual([
      ['2026-09-11', 1000, false],
      [DAY, 700, false],
    ]);
    expect(estimated(owed.hidden_chart!).every(([, v]) => v === 700)).toBe(true);
    // The download holds what was recorded: today's total with every account, the closed one too.
    expect(owed.download.filter(([, , kind]: unknown[]) => kind === 'recorded')).toEqual([
      ['2026-09-11', 6000, 'recorded'],
      [DAY, 5700, 'recorded'],
    ]);
    // The API's and the share's history are the chart's.
    expect(owed.api_history.filter(([, , , est]) => !est).map(([d, v, b]) => [d, v, b])).toEqual([
      ['2026-09-11', 6000, 6796],
      [DAY, 700, 653.47],
    ]);
    expect(owed.share_history.at(-1)).toEqual([DAY, 653.47, false]);

    // And back: the card closed today too, a savings account of 4,000 euros added.
    expect((await call(lifecycleRoute, 'POST', { account_id: card, state: 'closed', on: DAY, balance: 300 })).status).toBe(200);
    const again = await call(manualRoute, 'POST', { name: 'Euro savings', institution_name: 'Sparkasse', type: 'depository', subtype: null, balance: 4000, currency: 'EUR' });
    expect(again.status).toBe(200);
    await estimate();
    const held = await readers([
      { id: 'manual_eur', type: 'depository' },
      { id: card, type: 'credit' },
    ]);
    // 1,000 dollars and 4,000 euros (4,620.40 dollars).
    expect([held.total, held.converted_total, held.api_total, held.share_total]).toEqual([5000, 5620.4, 5620.4, 5620.4]);
    expect(held.chart.filter(([, , est]) => !est)).toEqual([
      ['2026-09-11', 6000, false],
      [DAY, 5000, false],
    ]);
    expect(held.converted_chart.filter(([, , est]) => !est)).toEqual([
      ['2026-09-11', 6796, false],
      [DAY, 5620.4, false],
    ]);
    // Both hidden: the savings by plus 5,000, the card by minus 300.
    expect(held.hidden_chart!.filter(([, , est]) => !est)).toEqual([
      ['2026-09-11', 1000, false],
      [DAY, 5000, false],
    ]);
    expect(estimated(held.hidden_chart!).every(([, v]) => v === 5000)).toBe(true);
    expect(held.download.filter(([, , kind]: unknown[]) => kind === 'recorded')).toEqual([
      ['2026-09-11', 6000, 'recorded'],
      [DAY, 9700, 'recorded'],
    ]);

    // Forgetting the hidden savings folds out of the stored totals exactly
    // what it put in, every day, signed as its hidden entry says.
    await setAccountHidden(ctx, 'manual_eur', 'depository', true);
    const entry = (await getHiddenAccounts(ctx)).get('manual_eur')!;
    await markForgetting(ctx, 'manual_eur', entry, 'tag-1');
    await foldHiddenAccount(ctx, 'manual_eur', 'depository', 'tag-1');
    const stored = async (key: string, day: string) => Number(await decrypt(ctx, (await fake.hget<string>(ctxKey(key), day))!));
    expect([await stored('history:net-worth', '2026-09-11'), await stored('history:net-worth', DAY)]).toEqual([1000, 4700]);
    const estDays = Object.keys((await fake.hgetall<Record<string, string>>(ctxKey('history:net-worth:est'))) ?? {});
    expect(estDays.length).toBeGreaterThan(0);
    // The estimate held all four accounts flat at 9,700: the savings' 5,000 go.
    for (const d of estDays) expect([d, await stored('history:net-worth:est', d)]).toEqual([d, 4700]);
  });

  test('an account that crossed under the release before is read as that release reads it, and can be renamed but not crossed again', async () => {
    // Stored as a card now, with Friday recorded while it was money held.
    await saveManualAccount(ctx, { ...EUR, type: 'credit', updated_at: new Date(NOW).toISOString() });
    const hidden = new Map([['manual_eur', { type: 'credit', hidden_at: new Date(NOW).toISOString() }]]);
    // Its type now signs it, as before: hidden, Friday loses minus 5,000.
    expect((await getHistory(ctx, hidden)).map((p) => [p.date, p.value])).toEqual([['2026-09-11', 11000]]);
    expect((await getHistory(ctx)).map((p) => [p.date, p.value])).toEqual([['2026-09-11', 6000]]);
    expect((await call(manualRoute, 'PATCH', { ...EUR, type: 'credit', name: 'Old card' })).status).toBe(200);
    const back = await call(manualRoute, 'PATCH', { ...EUR, type: 'depository', name: 'Old card' });
    expect([back.status, back.body.error]).toEqual([409, OWED_FLIP]);
    expect((await getHistory(ctx, hidden)).map((p) => [p.date, p.value])).toEqual([['2026-09-11', 11000]]);
  });
});
