import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';
import { FakeSimplefin, fakeAccount } from './simplefin-fake';
import { ecbHash } from './fx-fixture';

// SimpleFIN's "what kind of account is this", changed between money held and
// money owed once its history exists (lib/connectors/manage.ts
// retypeAccounts, lib/sign-repair.ts): a tracked account's recorded value
// follows its kind, so its past is re-signed in the same step, and every
// reader reads every day as before, to the cent, the account's own chart
// in its new kind. A card in euros reported at -300, tracked first as
// checking, beside a checking account at Plaid in dollars; Friday the 11th
// recorded, today (the 14th) recorded by the dashboard's load, an estimate
// built; dollars the home currency, at the ECB's rates.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const NOW = Date.parse('2026-09-14T17:00:00Z');
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

const { setTransportForTests } = await import('@/lib/connectors/http');
const { encrypt, decrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
const { connectorAccountsStore } = await import('@/lib/connectors/store');
const connectRoute = await import('@/app/api/connectors/connect/route');
const accountsRoute = await import('@/app/api/connectors/accounts/route');
const netWorthRoute = await import('@/app/api/net-worth/route');
const backfillRoute = await import('@/app/api/backfill/route');
const hiddenRoute = await import('@/app/api/hidden-accounts/route');
const { readNetWorthAndHistory } = await import('@/lib/api-read');
const { getHistory, getAccountHistory, foldHiddenAccount } = await import('@/lib/history');
const history = await import('@/lib/history');
const { getHiddenAccounts, markForgetting } = await import('@/lib/hidden');
const { projectViews } = await import('@/lib/share-views');
const { collectUserData, buildUserExport } = await import('@/lib/user-export');
const { signJobStore } = await import('@/lib/sign-repair');
const { snapshotData } = await import('@/lib/snapshot-job');

const ctx = TEST_CTX;
const FRI = '2026-09-11';
const DAY = '2026-09-14';
let simplefin: FakeSimplefin;
beforeAll(async () => {
  simplefin = await FakeSimplefin.start();
});
afterAll(() => {
  setTransportForTests(null);
  simplefin.stop();
});

const call = async (route: any, method: string, body: unknown) => {
  const res: Response = await route[method](new Request('http://localhost/api/test', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};
const home = async () => (await (await netWorthRoute.GET(new Request('http://x/api/net-worth?refresh=1'))).json()) as any;
const estimate = async () => expect((await backfillRoute.POST()).status).toBe(200);
const pts = (list: any[]) => list.map((p: any) => [p.date, p.value, !!p.estimated]);
const stored = async (key: string, field: string) => JSON.parse(await decrypt(ctx, (await fake.hget<string>(ctxKey(key), field))!));

let connection = '';
let card = '';
const retype = async (type: string) => {
  const r = await call(accountsRoute, 'PUT', { connection_id: connection, retype: [{ account_id: card, type }] });
  expect([r.status, r.body.retyped]).toEqual([200, 1]);
};

/** Every reader of net worth, to the cent, with `hide` hidden through the
 *  app's route and shown again (as test/owed-flip.test.ts reads them). */
async function readers(hide: string[] = []) {
  const h = await home();
  for (const id of hide) expect((await call(hiddenRoute, 'POST', { account_id: id, hidden: true })).status).toBe(200);
  const hidden = await getHiddenAccounts(ctx);
  const hidden_chart = pts(await getHistory(ctx, hidden));
  for (const id of hide) expect((await call(hiddenRoute, 'POST', { account_id: id, hidden: false })).status).toBe(200);
  const api = await readNetWorthAndHistory(ctx, { includeEstimated: true, interval: 'day' } as any, { base: 'private' } as any);
  const share = (await projectViews(ctx, { net_worth: { detail: 'history', accounts: false } } as any, NOW))!.views.net_worth as any;
  const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date()) as any;
  return {
    total: h.netWorth,
    converted_total: h.base.net_worth,
    chart: pts(h.history),
    converted_chart: pts(h.base.history),
    hidden_chart,
    api_total: api.now.base!.net_worth,
    api_history: api.history.points.map((p: any) => [p.date, p.value, p.to_base, p.estimated]),
    share_history: pts(share.history),
    download: doc.net_worth_history.points.map((p: any) => [p.date, p.total, p.kind]),
  };
}
const accountChart = async () => (await getAccountHistory(ctx, card)).map((p) => [p.date, p.value, !!p.estimated]);

beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  simplefin.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  setTransportForTests(simplefin.transport());
  await saveItem(ctx, { item_id: 'item_bank', institution_name: 'Bank', encrypted_access_token: await encrypt(ctx, 'tok') });
  await fake.hset(testKey('fx:ecb'), ecbHash());
  await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'USD' });
  simplefin.accounts = [fakeAccount({ id: 'EUR-1', name: 'Euro card', currency: 'EUR', balance: '-300.00', 'available-balance': '-300.00' })];
  connection = (await call(connectRoute, 'POST', { connector: 'simplefin', token: simplefin.setupToken('sign') })).body.connection_id;
  // Tracked as checking, by mistake: its -300 counts as money held, -300.
  expect((await call(accountsRoute, 'PUT', { connection_id: connection, track: [{ remote_id: 'EUR-1', type: 'depository' }] })).status).toBe(200);
  card = [...(await connectorAccountsStore.getAll(ctx)).keys()][0];
  // Friday, recorded so: 1,000 - 300.
  await fake.hset(ctxKey('history:accounts'), { [FRI]: await encrypt(ctx, JSON.stringify({ chk: 1000, [card]: -300 })) });
  await fake.hset(ctxKey('history:net-worth'), { [FRI]: await encrypt(ctx, '700') });
  await home();
  await estimate();
});
afterEach(() => setSystemTime());

describe('a kind changed between money held and owed, with history', () => {
  test('to owed and back: every reader reads every day as before, to the cent, and its own chart in its kind', async () => {
    const before = await readers([card]);
    expect([before.total, before.converted_total]).toEqual([700, 653.47]);
    expect(before.converted_chart.filter(([, , e]) => !e)).toEqual([
      [FRI, 652.24, false], // 1,000 - 300 euros at 1.1592
      [DAY, 653.47, false],
    ]);
    expect(before.hidden_chart.filter(([, , e]) => !e)).toEqual([
      [FRI, 1000, false],
      [DAY, 1000, false],
    ]);
    expect((await accountChart()).filter(([, , e]) => !e)).toEqual([
      [FRI, -300, false],
      [DAY, -300, false],
    ]);

    // A card, as it is.
    await retype('credit');
    expect((await connectorAccountsStore.get(ctx, card))!.type).toBe('credit');
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, [card]: 300 });
    expect(await signJobStore.ids(ctx)).toEqual([]);
    expect(await readers([card])).toEqual(before);
    await estimate(); // rebuilt, as a change of kind asks
    expect(await readers([card])).toEqual(before);
    // Its own chart: the amount owed, every day.
    expect((await accountChart()).every(([, v]) => v === 300)).toBe(true);
    const download = buildUserExport(await collectUserData({ ctx, userId: null }), new Date()) as any;
    expect(download.account_history.find((a: any) => a.account_id === card).points.filter((p: any) => p.kind === 'recorded').map((p: any) => [p.date, p.balance])).toEqual([
      [FRI, 300],
      [DAY, 300],
    ]);

    // And back to checking.
    await retype('depository');
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, [card]: -300 });
    expect(await readers([card])).toEqual(before);
    expect((await accountChart()).every(([, v]) => v === -300)).toBe(true);
  });

  test('hidden through it: its entry takes the new kind, and forgetting it folds out what it put in', async () => {
    expect((await call(hiddenRoute, 'POST', { account_id: card, hidden: true })).status).toBe(200);
    const before = pts(await getHistory(ctx, await getHiddenAccounts(ctx)));
    await retype('credit');
    const entry = (await getHiddenAccounts(ctx)).get(card)!;
    expect(entry.type).toBe('credit');
    expect(pts(await getHistory(ctx, await getHiddenAccounts(ctx)))).toEqual(before);
    // Forgotten: every total loses its -300, Friday's and today's alike.
    await markForgetting(ctx, card, entry, 'tag-1');
    await foldHiddenAccount(ctx, card, entry.type, 'tag-1');
    for (const d of [FRI, DAY]) expect([d, Number(await decrypt(ctx, (await fake.hget<string>(ctxKey('history:net-worth'), d))!))]).toEqual([d, 1000]);
    const est = (await fake.hgetall<Record<string, string>>(ctxKey('history:net-worth:est'))) ?? {};
    expect(Object.keys(est).length).toBeGreaterThan(0);
    for (const [d, blob] of Object.entries(est)) expect([d, Number(await decrypt(ctx, blob))]).toEqual([d, 1000]);
  });

  test('cut off part way, the nightly snapshot finishes it, never turning a day over twice', async () => {
    const before = await readers([card]);
    const real = history.negateAccountOn;
    let calls = 0;
    const cut = spyOn(history, 'negateAccountOn').mockImplementation(async (...args) => {
      if (++calls === 2) throw new Error('the function was stopped');
      return real(...args);
    });
    const [error] = [console.error];
    console.error = () => {};
    try {
      const r = await call(accountsRoute, 'PUT', { connection_id: connection, retype: [{ account_id: card, type: 'credit' }] });
      expect([r.status, r.body.error]).toEqual([
        503,
        'The kind of Euro card was changed, but not every earlier day of its history could be turned over to match yet: that is finished by Nya’s next daily update, and until then some of those days may count the other way.',
      ]);
    } finally {
      cut.mockRestore();
      console.error = error;
    }
    // The kind changed, part of its past re-signed, the job kept.
    expect((await connectorAccountsStore.get(ctx, card))!.type).toBe('credit');
    expect((await signJobStore.get(ctx, card))!).toMatchObject({ kind: 'retype', from: 'depository', to: 'credit' });
    console.error = () => {};
    try {
      await snapshotData(ctx, []);
    } finally {
      console.error = error;
    }
    expect(await signJobStore.ids(ctx)).toEqual([]);
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, [card]: 300 });
    expect(await readers([card])).toEqual(before);
  });

  test('while another change to accounts holds the lock, refused and nothing changes', async () => {
    fake.strings.set(ctxKey('account-links:lock'), 'someone-else');
    const r = await call(accountsRoute, 'PUT', { connection_id: connection, retype: [{ account_id: card, type: 'credit' }] });
    fake.strings.delete(ctxKey('account-links:lock'));
    expect([r.status, r.body.error]).toEqual([409, 'Another change to your accounts is in progress. Try again in a moment.']);
    expect((await connectorAccountsStore.get(ctx, card))!.type).toBe('depository');
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, [card]: -300 });
  });

  test('within one side nothing is re-signed', async () => {
    const raw = new Map(fake.hashes.get(ctxKey('history:accounts')));
    await retype('investment');
    expect(new Map(fake.hashes.get(ctxKey('history:accounts')))).toEqual(raw);
    expect(await signJobStore.ids(ctx)).toEqual([]);
  });
});
