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
const { signJobStore, finishSignJobs, runSignJob, retypeWithHistory } = await import('@/lib/sign-repair');
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
const put = async (key: string, entries: Record<string, unknown>) => {
  for (const [field, value] of Object.entries(entries)) await fake.hset(ctxKey(key), { [field]: await encrypt(ctx, typeof value === 'string' ? value : JSON.stringify(value)) });
};
/** Every day's stored balances and totals (a job's own progress aside). */
const historyNow = () => new Map([...fake.hashes].filter(([k]) => k.includes('history:') && !k.includes('history:forgetting:')).map(([k, h]) => [k, new Map(h)]));
const quiet = async <T>(fn: () => Promise<T>, said: string[] = []): Promise<T> => {
  const [error] = [console.error];
  console.error = (...args: unknown[]) => void said.push(args.map(String).join(' '));
  try {
    return await fn();
  } finally {
    console.error = error;
  }
};
/** Runs `fn` with the `n`th turning over failing. */
const cutAt = async <T>(n: number, fn: () => Promise<T>): Promise<T> => {
  const real = history.negateAccountOn;
  let calls = 0;
  const cut = spyOn(history, 'negateAccountOn').mockImplementation(async (...args) => {
    if (++calls === n) throw new Error('the function was stopped');
    return real(...args);
  });
  try {
    return await quiet(fn);
  } finally {
    cut.mockRestore();
  }
};
const toCard = () => call(accountsRoute, 'PUT', { connection_id: connection, retype: [{ account_id: card, type: 'credit' }] });
const TURNING = 'Euro card was changed, but not every earlier day of its history could be turned over to match yet: Nya’s next daily update finishes it, and until then some of those days may count the other way.';
const LEFT_ONE = 'Nothing says how one of Euro card’s earlier days was counted (a day recorded without a total, say), so it was left as it was, and may count the other way.';
const estDates = async () => Object.keys((await fake.hgetall<Record<string, string>>(ctxKey('history:net-worth:est'))) ?? {}).sort();

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
      expect([r.status, r.body.retyped, r.body.retype_note]).toEqual([
        200,
        1,
        'Euro card was changed, but not every earlier day of its history could be turned over to match yet: Nya’s next daily update finishes it, and until then some of those days may count the other way.',
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

  test('while another change to accounts holds the lock, not changed, said so, and nothing changes', async () => {
    fake.strings.set(ctxKey('account-links:lock'), 'someone-else');
    const r = await call(accountsRoute, 'PUT', { connection_id: connection, retype: [{ account_id: card, type: 'credit' }] });
    fake.strings.delete(ctxKey('account-links:lock'));
    expect([r.status, r.body.retyped, r.body.retype_note]).toEqual([200, 0, 'Euro card wasn’t changed: another change to your accounts was in progress. Try again in a moment.']);
    expect((await connectorAccountsStore.get(ctx, card))!.type).toBe('depository');
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, [card]: -300 });
  });

  test('two changes to the same kind at once turn its history over once', async () => {
    const { retypeWithHistory } = await import('@/lib/sign-repair');
    // Both read checking before either held the lock; the second finds a card.
    const [a, b] = await Promise.all([retypeWithHistory(ctx, card, 'credit'), retypeWithHistory(ctx, card, 'credit')].map((p) => p.then((r) => r.changed, (e: Error) => e.message)));
    expect([a, b].map(String).sort()).toEqual(['Another change to your accounts is in progress. Try again in a moment.', 'true']);
    expect((await retypeWithHistory(ctx, card, 'credit')).changed).toBe(false);
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, [card]: 300 });
    // Within its side, after: a loan, nothing turned over again.
    expect(await retypeWithHistory(ctx, card, 'loan')).toEqual({ changed: true, job: null });
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, [card]: 300 });
  });

  test('within one side nothing is re-signed', async () => {
    const raw = new Map(fake.hashes.get(ctxKey('history:accounts')));
    await retype('investment');
    expect(new Map(fake.hashes.get(ctxKey('history:accounts')))).toEqual(raw);
    expect(await signJobStore.ids(ctx)).toEqual([]);
  });
});

describe('a retype’s re-sign, day by day', () => {
  test('cut off, then another account folded out of every day: finished, its days still turned over', async () => {
    const r = await cutAt(1, toCard);
    expect([r.status, r.body.retyped, r.body.retype_note]).toEqual([200, 1, TURNING]);
    expect((await signJobStore.get(ctx, card))!.plan).toBeDefined();
    // A forget of another account rewrites every map that names it.
    await foldHiddenAccount(ctx, 'chk', 'depository', 'tag-other');
    await quiet(() => finishSignJobs(ctx));
    expect(await signJobStore.ids(ctx)).toEqual([]);
    for (const d of [FRI, DAY]) expect([d, (await stored('history:accounts', d))[card]]).toEqual([d, 300]);
    for (const d of await estDates()) expect([d, (await stored('history:accounts:est:flatd', d))[card]]).toEqual([d, 300]);
    // 300 euros owed at 1.1592, the checking account folded out.
    expect((await readers()).converted_chart.find(([d]) => d === FRI)).toEqual([FRI, -347.76, false]);
  });

  test('cut off, then a day rewritten with a new balance in the new kind: that day is left as written', async () => {
    await cutAt(1, toCard);
    // Recorded since, as a card owing 350.
    await put('history:accounts', { [DAY]: { chk: 1000, [card]: 350 } });
    await quiet(() => finishSignJobs(ctx));
    expect(await signJobStore.ids(ctx)).toEqual([]);
    expect((await stored('history:accounts', DAY))[card]).toBe(350);
    expect((await stored('history:accounts', FRI))[card]).toBe(300);
  });

  test('cut off, then changed back by the release before: dropped with words, nothing more turned over', async () => {
    expect((await call(hiddenRoute, 'POST', { account_id: card, hidden: true })).status).toBe(200);
    await cutAt(2, toCard);
    // The release before's own change of kind, with no re-sign.
    await connectorAccountsStore.update(ctx, card, (a) => (a ? { ...a, type: 'depository', subtype: null } : a));
    const raw = historyNow();
    const said: string[] = [];
    await quiet(() => finishSignJobs(ctx), said);
    expect(said).toEqual([`Balance signs: The repair under way for ${card} was planned for it as money owed, and it is money held now, so it was dropped and nothing more was turned over.`]);
    expect(historyNow()).toEqual(raw);
    expect(await signJobStore.ids(ctx)).toEqual([]);
    expect((await getHiddenAccounts(ctx)).get(card)!.type).toBe('depository');
    expect((await connectorAccountsStore.get(ctx, card))!.type).toBe('depository');
  });

  test('written but cut off before its kind changed, then changed within the old side: dropped, the kind left alone', async () => {
    expect((await call(hiddenRoute, 'POST', { account_id: card, hidden: true })).status).toBe(200);
    await signJobStore.set(ctx, card, { v: 1, kind: 'retype', from: 'depository', to: 'credit', at: new Date(NOW).toISOString(), tag: 'sign-test' });
    await connectorAccountsStore.update(ctx, card, (a) => (a ? { ...a, type: 'investment', subtype: null } : a));
    const raw = historyNow();
    expect(await quiet(() => runSignJob(ctx, card))).toEqual({
      negated: 0,
      left: [],
      abandoned: `The repair under way for ${card} was planned for it as money owed, and it is money held now, so it was dropped and nothing more was turned over.`,
    });
    expect((await connectorAccountsStore.get(ctx, card))!.type).toBe('investment');
    expect((await getHiddenAccounts(ctx)).get(card)!.type).toBe('depository');
    expect(historyNow()).toEqual(raw);
    expect(await signJobStore.ids(ctx)).toEqual([]);
  });

  test('back to the kind of an older era: that era’s days are kept, and a day between the eras is left and said', async () => {
    // First a card owing 300: recorded on the 8th, measured without a total on the 9th.
    await connectorAccountsStore.update(ctx, card, (a) => (a ? { ...a, type: 'credit', subtype: null } : a));
    await put('history:accounts', { '2026-09-08': { chk: 1000, [card]: 300 } });
    await put('history:net-worth', { '2026-09-08': '700' });
    await put('history:accounts:partial', { '2026-09-09': { [card]: 300 } });
    // Then checking under the release before, no re-sign: Friday and today as set up (-300).
    await connectorAccountsStore.update(ctx, card, (a) => (a ? { ...a, type: 'depository', subtype: null } : a));
    const r = await toCard();
    expect([r.status, r.body.retyped, r.body.retype_note]).toEqual([200, 1, LEFT_ONE]);
    expect((await stored('history:accounts', '2026-09-08'))[card]).toBe(300);
    expect(await stored('history:accounts:partial', '2026-09-09')).toEqual({ [card]: 300 });
    for (const d of [FRI, DAY]) expect([d, (await stored('history:accounts', d))[card]]).toEqual([d, 300]);
  });

  test('a day measured without a total between two days turned over is turned over with them', async () => {
    await put('history:accounts:partial', { '2026-09-12': { [card]: -300 } });
    const r = await toCard();
    expect([r.status, r.body.retype_note]).toEqual([200, null]);
    expect(await stored('history:accounts:partial', '2026-09-12')).toEqual({ [card]: 300 });
  });

  test('its own day measured without a total: turned over when it is its balance under the old kind', async () => {
    fake.hashes.get(ctxKey('history:net-worth'))!.delete(DAY);
    fake.hashes.get(ctxKey('history:accounts'))!.delete(DAY);
    await put('history:accounts:partial', { [DAY]: { chk: 1000, [card]: -300 } });
    const r = await toCard();
    expect([r.status, r.body.retype_note]).toEqual([200, null]);
    expect(await stored('history:accounts:partial', DAY)).toEqual({ chk: 1000, [card]: 300 });
  });

  test('its own day measured without a total, at a balance it doesn’t have now: left and said', async () => {
    fake.hashes.get(ctxKey('history:net-worth'))!.delete(DAY);
    fake.hashes.get(ctxKey('history:accounts'))!.delete(DAY);
    await put('history:accounts:partial', { [DAY]: { chk: 1000, [card]: -250 } });
    const r = await toCard();
    expect([r.status, r.body.retype_note]).toEqual([200, LEFT_ONE]);
    expect(await stored('history:accounts:partial', DAY)).toEqual({ chk: 1000, [card]: -250 });
  });

  test('an estimated day nothing tells, at the end of the estimate: left and said', async () => {
    const [first, ...rest] = await estDates();
    expect(rest.length).toBeGreaterThan(0);
    fake.hashes.get(ctxKey('history:net-worth:est'))!.delete(first);
    const r = await toCard();
    expect([r.status, r.body.retype_note]).toEqual([200, LEFT_ONE]);
    expect((await stored('history:accounts:est:flatd', first))[card]).toBe(-300);
    for (const d of rest) expect([d, (await stored('history:accounts:est:flatd', d))[card]]).toEqual([d, 300]);
  });

  test('read as within one side by another device, but crossing now: re-signed, as a change across', async () => {
    const before = await readers([card]);
    await retype('credit');
    // The other device still shows checking, and saves an investment.
    const real = connectorAccountsStore.getMany.bind(connectorAccountsStore);
    const stale = spyOn(connectorAccountsStore, 'getMany').mockImplementation(async (c: any, ids: any) => {
      const m = await real(c, ids);
      return new Map([...m].map(([k, v]) => [k, { ...v, type: 'depository' }])) as any;
    });
    let r: { status: number; body: any };
    try {
      r = await call(accountsRoute, 'PUT', { connection_id: connection, retype: [{ account_id: card, type: 'investment' }] });
    } finally {
      stale.mockRestore();
    }
    expect([r.status, r.body.retyped, r.body.retype_note]).toEqual([200, 1, null]);
    expect((await connectorAccountsStore.get(ctx, card))!.type).toBe('investment');
    expect((await stored('history:accounts', FRI))[card]).toBe(-300);
    expect(await readers([card])).toEqual(before);
  });

  test('stopped at its time, its kind changed, and the nightly snapshot finishes it', async () => {
    const before = await readers([card]);
    expect(await retypeWithHistory(ctx, card, 'credit', { until: 0 })).toEqual({ changed: true, job: { negated: 0, left: [], pending: true } });
    expect(await signJobStore.has(ctx, card)).toBe(true);
    await quiet(() => snapshotData(ctx, []));
    expect(await signJobStore.ids(ctx)).toEqual([]);
    expect(await readers([card])).toEqual(before);
  });

  test('failing before its kind changed: not changed, said so, and nothing changes it later', async () => {
    const real = connectorAccountsStore.update.bind(connectorAccountsStore);
    let calls = 0;
    const failing = spyOn(connectorAccountsStore, 'update').mockImplementation(async (...args: any[]) => {
      if (++calls === 1) throw new Error('storage went away');
      return (real as any)(...args);
    });
    let r: { status: number; body: any };
    try {
      r = await quiet(() => toCard());
    } finally {
      failing.mockRestore();
    }
    expect([r.status, r.body.retyped, r.body.retype_note]).toEqual([200, 0, 'Euro card couldn’t be changed. Try again.']);
    expect(await signJobStore.ids(ctx)).toEqual([]);
    await quiet(() => finishSignJobs(ctx));
    expect((await connectorAccountsStore.get(ctx, card))!.type).toBe('depository');
    expect((await stored('history:accounts', FRI))[card]).toBe(-300);
  });

  test('while it is being forgotten: not changed, said so, and no job left behind', async () => {
    expect((await call(hiddenRoute, 'POST', { account_id: card, hidden: true })).status).toBe(200);
    await markForgetting(ctx, card, (await getHiddenAccounts(ctx)).get(card)!, 'tag-1');
    const r = await toCard();
    expect([r.status, r.body.retyped, r.body.retype_note]).toEqual([
      200,
      0,
      'Euro card wasn’t changed: an earlier change to it is still being finished, or it is being forgotten. Try again after Nya’s next daily update.',
    ]);
    expect(await signJobStore.ids(ctx)).toEqual([]);
    expect((await connectorAccountsStore.get(ctx, card))!.type).toBe('depository');
  });

  test('one of two refused for the lock: the other changed, each said by name, and the caches cleared', async () => {
    simplefin.accounts.push(fakeAccount({ id: 'USD-2', name: 'Savings', currency: 'USD', balance: '200.00', 'available-balance': '200.00' }));
    const refreshRoute = await import('@/app/api/connectors/refresh/route');
    expect((await call(refreshRoute, 'POST', { connection_id: connection })).status).toBe(200);
    expect((await call(accountsRoute, 'PUT', { connection_id: connection, track: [{ remote_id: 'USD-2', type: 'depository' }] })).status).toBe(200);
    const savings = [...(await connectorAccountsStore.getAll(ctx)).keys()].find((id) => id !== card)!;
    // The estimate built, as the setup did: a change of kind asks it built again.
    await fake.set(ctxKey('history:backfill-done'), '1');
    fake.strings.set(ctxKey('account-links:lock'), 'someone-else');
    let r: { status: number; body: any };
    try {
      r = await call(accountsRoute, 'PUT', { connection_id: connection, retype: [{ account_id: card, type: 'credit' }, { account_id: savings, type: 'investment' }] });
    } finally {
      fake.strings.delete(ctxKey('account-links:lock'));
    }
    expect([r.status, r.body.retyped, r.body.retype_note]).toEqual([200, 1, 'Changed: Savings. Euro card wasn’t changed: another change to your accounts was in progress. Try again in a moment.']);
    expect(await fake.get(ctxKey('history:backfill-done'))).toBeNull();
    expect((await connectorAccountsStore.get(ctx, savings))!.type).toBe('investment');
    expect((await connectorAccountsStore.get(ctx, card))!.type).toBe('depository');
  });
});
