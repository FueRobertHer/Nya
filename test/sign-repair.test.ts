import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime, spyOn } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';
import { ecbHash } from './fx-fixture';

// The operator's repair of an account flipped between money held and money
// owed under a release before the app refused it (lib/sign-repair.ts,
// app/api/ops/sign-repair): found from the recorded totals, its days counted
// the other way turned over, every total as recorded, and every reader right
// afterwards; refused when the day it flipped can't be found exactly; twice
// is once; cut off part way, finished; a history with no flip untouched.
//
// A checking account at Plaid in dollars, and a manual savings account in
// euros (5,000), recorded on Friday the 11th while it was money held, then
// flipped to a card under the release before, so today's point (the 14th)
// counted it owed; an estimate built before the flip. Dollars are the home
// currency, at the ECB's rates (1.1592 on the 11th, 1.1551 on the 14th).

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

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
  },
}));

const { encrypt, decrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
const { saveManualAccount } = await import('@/lib/manual');
const netWorthRoute = await import('@/app/api/net-worth/route');
const hiddenRoute = await import('@/app/api/hidden-accounts/route');
const opsRoute = await import('@/app/api/ops/sign-repair/route');
const { readNetWorthAndHistory } = await import('@/lib/api-read');
const { getHistory, getAccountHistory } = await import('@/lib/history');
const history = await import('@/lib/history');
const { getHiddenAccounts } = await import('@/lib/hidden');
const { projectViews } = await import('@/lib/share-views');
const { collectUserData, buildUserExport } = await import('@/lib/user-export');
const { signJobStore, finishSignJobs, runSignJob } = await import('@/lib/sign-repair');
const { forgetEarlierAccount } = await import('@/lib/links');
const { SIGN_JOB_PENDING } = await import('@/lib/sign-repair-store');

const ctx = TEST_CTX;
const NOW = Date.parse('2026-09-14T17:00:00Z');
const FRI = '2026-09-11';
const DAY = '2026-09-14';
const EST = ['2026-09-08', '2026-09-09', '2026-09-10'];

const put = async (key: string, entries: Record<string, unknown>) => {
  for (const [field, value] of Object.entries(entries)) await fake.hset(ctxKey(key), { [field]: await encrypt(ctx, typeof value === 'string' ? value : JSON.stringify(value)) });
};
const stored = async (key: string, field: string) => JSON.parse(await decrypt(ctx, (await fake.hget<string>(ctxKey(key), field))!));
const call = async (route: any, method: string, body: unknown) => {
  const res: Response = await route[method](new Request('http://x/api', { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};
const ops = async (body: unknown) => {
  const res: Response = await opsRoute.POST(new Request('http://x/api/ops/sign-repair', { method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};
const home = async () => (await (await netWorthRoute.GET(new Request('http://x/api/net-worth?refresh=1'))).json()) as any;
const pts = (list: any[]) => list.map((p: any) => [p.date, p.value, !!p.estimated]);
/** Every day's stored balances and totals (a job's own progress aside). */
const historyNow = () => new Map([...fake.hashes].filter(([k]) => k.includes('history:') && !k.includes('history:forgetting:')).map(([k, h]) => [k, new Map(h)]));
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error] = [console.error];
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
  }
};
/** Runs `fn` with the `n`th turning over (and, with `every`, each after it) failing. */
const cutAt = async <T>(n: number, fn: () => Promise<T>, every = false): Promise<T> => {
  const real = history.negateAccountOn;
  let calls = 0;
  const cut = spyOn(history, 'negateAccountOn').mockImplementation(async (...args) => {
    if (++calls === n || (every && calls > n)) throw new Error('the function was stopped');
    return real(...args);
  });
  try {
    return await quiet(fn);
  } finally {
    cut.mockRestore();
  }
};

/** Every reader of net worth, to the cent (as test/owed-flip.test.ts reads
 *  them), with `hide` hidden through the app's route and shown again. */
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
    api_history: api.history.points.map((p: any) => [p.date, p.value, p.to_base, p.estimated]),
    share_history: pts(share.history),
    account: (await getAccountHistory(ctx, 'manual_eur')).map((p) => [p.date, p.value, !!p.estimated]),
    download: doc.net_worth_history.points.map((p: any) => [p.date, p.total, p.kind]),
  };
}

const saved = { ...process.env };
beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  forgetEpochs();
  process.env.OPS_ENABLED = '1';
  process.env.OPS_SECRET = 's3cret';
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_bank', institution_name: 'Bank', encrypted_access_token: await encrypt(ctx, 'tok') });
  await fake.hset(testKey('fx:ecb'), ecbHash());
  await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'USD' });
  // A card now; its type was changed under the release before.
  await saveManualAccount(ctx, { account_id: 'manual_eur', name: 'Euro savings', institution_name: 'Sparkasse', type: 'credit', subtype: null, balance: 5000, currency: 'EUR', updated_at: new Date(NOW - 30 * 86_400_000).toISOString() });
  // Friday, while it was money held: 1,000 + 5,000.
  await put('history:accounts', { [FRI]: { chk: 1000, manual_eur: 5000 } });
  await put('history:net-worth', { [FRI]: '6000' });
  // An estimate built while it was money held, walking the checking account
  // and holding the savings flat.
  for (const d of EST) {
    await put('history:net-worth:est', { [d]: '6000' });
    await put('history:accounts:est', { [d]: { chk: 1000 } });
    await put('history:accounts:est:flatd', { [d]: { manual_eur: 5000 } });
  }
  // Today, recorded as it is now, a card: 1,000 - 5,000.
  await home();
});
afterEach(() => {
  process.env = { ...saved };
  setSystemTime();
});

describe('an account flipped between money held and owed under the release before', () => {
  test('is found, repaired, and every reader is right afterwards, to the cent', async () => {
    const before = await readers(['manual_eur']);
    // Wrong before: Friday's 5,000 euros of savings read as owed.
    expect(before.converted_chart.find(([d]) => d === FRI)).toEqual([FRI, 5204, false]);
    expect(before.hidden_chart.find(([d]) => d === FRI)).toEqual([FRI, 11000, false]);
    // What is recorded is right, and stays so.
    expect(before.chart.filter(([, , e]) => !e)).toEqual([
      [FRI, 6000, false],
      [DAY, -4000, false],
    ]);

    const found = await ops({ container: ctx.container });
    expect(found.status).toBe(200);
    expect(found.body.accounts).toEqual([{ account_id: 'manual_eur', source: 'manual', type: 'credit', days: { r: 1, f: 3 }, first: '2026-09-08', last: FRI }]);
    // The dry run wrote nothing.
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_eur: 5000 });

    const repaired = await ops({ container: ctx.container, account_id: 'manual_eur', repair: true });
    expect([repaired.status, repaired.body.negated]).toEqual([200, 4]);
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_eur: -5000 });
    expect(await stored('history:accounts:est:flatd', EST[0])).toEqual({ manual_eur: -5000 });
    expect(await signJobStore.ids(ctx)).toEqual([]);

    const after = await readers(['manual_eur']);
    // Every total as recorded: Home's chart and the download are as they were.
    expect([after.total, after.chart, after.download]).toEqual([before.total, before.chart, before.download]);
    // Friday converted as recorded: 1,000 + 5,000 euros at 1.1592; today owed at 1.1551.
    expect(after.converted_chart.filter(([, , e]) => !e)).toEqual([
      [FRI, 6796, false],
      [DAY, -4775.5, false],
    ]);
    expect(after.api_history.filter(([, , , e]) => !e)).toEqual([
      [FRI, 6000, 6796, false],
      [DAY, -4000, -4775.5, false],
    ]);
    // Hidden, it leaves every day by what it put in: the checking account alone.
    expect(after.hidden_chart.every(([, v]) => v === 1000)).toBe(true);
    // The estimate, held flat while it was savings, reads as built: 6,000.
    expect(after.chart.filter(([d, , e]) => e && d < FRI).every(([, v]) => v === 6000)).toBe(true);
    // Converted, each day at its own rate (the ECB's 1.1614, 1.1652, 1.1616).
    expect(after.converted_chart.filter(([d, , e]) => e && d < FRI)).toEqual([
      ['2026-09-08', 6807, true],
      ['2026-09-09', 6826, true],
      ['2026-09-10', 6808, true],
    ]);
    // Its own chart, in its kind now: the amount owed on every day.
    expect(after.account.filter(([, , e]) => !e)).toEqual([
      [FRI, -5000, false],
      [DAY, 5000, false],
    ]);
    expect(after.share_history.at(-1)).toEqual([DAY, -4775.5, false]);
  });

  test('is refused, naming the days, when the day it flipped can’t be found exactly: nothing is written', async () => {
    // A day measured without a total, between the last counted held and the first counted owed.
    await put('history:accounts:partial', { '2026-09-12': { manual_eur: 5000 } });
    const raw = new Map(fake.hashes.get(ctxKey('history:accounts')));
    const found = await ops({ container: ctx.container });
    expect(found.body.accounts).toEqual([
      expect.objectContaining({ account_id: 'manual_eur', days: {}, first: null, refused: { days: ['2026-09-12'], reason: expect.stringContaining("can't be told exactly") } }),
    ]);
    const repaired = await ops({ container: ctx.container, account_id: 'manual_eur', repair: true });
    expect([repaired.status, repaired.body.days]).toEqual([409, ['2026-09-12']]);
    expect(repaired.body.error).toBe("The days manual_eur was counted the other way can't be told exactly: nothing says how it was counted on 2026-09-12.");
    expect(new Map(fake.hashes.get(ctxKey('history:accounts')))).toEqual(raw);
    expect(await stored('history:accounts:est:flatd', EST[0])).toEqual({ manual_eur: 5000 });
    expect(await signJobStore.ids(ctx)).toEqual([]);
  });

  test('a day measured without a total inside a run of days counted the other way is turned over with them', async () => {
    await put('history:accounts', { '2026-09-10': { chk: 1000, manual_eur: 5000 } });
    await put('history:net-worth', { '2026-09-10': '6000' });
    await put('history:accounts:partial', { '2026-09-10': { manual_eur: 5000 } });
    // Its partial value sits beside a recorded one; one more, alone, between two held days.
    await put('history:accounts:partial', { '2026-09-09': { manual_eur: 5000 } });
    await put('history:accounts', { '2026-09-08': { chk: 1000, manual_eur: 5000 } });
    await put('history:net-worth', { '2026-09-08': '6000' });
    expect((await ops({ container: ctx.container, account_id: 'manual_eur', repair: true })).body.negated).toBe(8);
    expect(await stored('history:accounts:partial', '2026-09-09')).toEqual({ manual_eur: -5000 });
    expect((await getAccountHistory(ctx, 'manual_eur')).filter((p) => !p.estimated).map((p) => [p.date, p.value])).toEqual([
      ['2026-09-08', -5000],
      ['2026-09-09', -5000],
      ['2026-09-10', -5000],
      [FRI, -5000],
      [DAY, 5000],
    ]);
  });

  test('run twice, the second changes nothing', async () => {
    expect((await ops({ container: ctx.container, account_id: 'manual_eur', repair: true })).body.negated).toBe(4);
    const once = new Map([...fake.hashes].filter(([k]) => k.includes('history:')).map(([k, h]) => [k, new Map(h)]));
    const twice = await ops({ container: ctx.container, account_id: 'manual_eur', repair: true });
    expect([twice.status, twice.body.negated]).toEqual([200, 0]);
    expect(new Map([...fake.hashes].filter(([k]) => k.includes('history:')).map(([k, h]) => [k, new Map(h)]))).toEqual(once);
    expect((await ops({ container: ctx.container })).body.accounts).toEqual([]);
  });

  test('cut off part way, it is finished by the next run, never turning a day over twice', async () => {
    const real = history.negateAccountOn;
    let calls = 0;
    const cut = spyOn(history, 'negateAccountOn').mockImplementation(async (...args) => {
      if (++calls === 3) throw new Error('the function was stopped');
      return real(...args);
    });
    const [error] = [console.error];
    console.error = () => {};
    let first: { status: number; body: any };
    try {
      first = await ops({ container: ctx.container, account_id: 'manual_eur', repair: true });
    } finally {
      cut.mockRestore();
      console.error = error;
    }
    expect(first.status).toBe(500);
    // Two of four done, the job kept with its plan.
    expect((await signJobStore.get(ctx, 'manual_eur'))!).toMatchObject({ kind: 'repair', from: 'credit', to: 'credit' });
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_eur: -5000 });
    // The dry run says so.
    expect((await ops({ container: ctx.container })).body.accounts).toEqual([expect.objectContaining({ account_id: 'manual_eur', pending: { kind: 'repair', failures: 0, error: null, stopped: false } })]);
    // The nightly job finishes it.
    await finishSignJobs(ctx);
    expect(await signJobStore.ids(ctx)).toEqual([]);
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_eur: -5000 });
    for (const d of EST) expect([d, await stored('history:accounts:est:flatd', d)]).toEqual([d, { manual_eur: -5000 }]);
    expect((await readers()).converted_chart.find(([d]) => d === FRI)).toEqual([FRI, 6796, false]);
  });

  test('history with no flip in it is left exactly as it is', async () => {
    // The same account had it never been flipped: money held on every day.
    fake.reset();
    await registerTestContainer(fake);
    await saveItem(ctx, { item_id: 'item_bank', institution_name: 'Bank', encrypted_access_token: await encrypt(ctx, 'tok') });
    await saveManualAccount(ctx, { account_id: 'manual_eur', name: 'Euro savings', institution_name: 'Sparkasse', type: 'depository', subtype: null, balance: 5000, currency: 'EUR', updated_at: new Date(NOW).toISOString() });
    await put('history:accounts', { [FRI]: { chk: 1000, manual_eur: 5000 } });
    await put('history:net-worth', { [FRI]: '6000' });
    await home();
    const raw = new Map([...fake.hashes].filter(([k]) => k.includes('history:')).map(([k, h]) => [k, new Map(h)]));
    expect((await ops({ container: ctx.container })).body.accounts).toEqual([]);
    expect((await ops({ container: ctx.container, account_id: 'manual_eur', repair: true })).body.negated).toBe(0);
    expect(new Map([...fake.hashes].filter(([k]) => k.includes('history:')).map(([k, h]) => [k, new Map(h)]))).toEqual(raw);
  });

  test('the operator’s route: locked, strict about what it is asked, and only for accounts a person could retype', async () => {
    expect((await ops({})).status).toBe(400);
    expect((await ops({ container: ctx.container, account_id: 'manual_eur' })).status).toBe(400);
    expect((await ops({ container: 'not-a-container' })).status).toBe(400);
    expect((await ops({ container: '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70' })).status).toBe(404);
    const plaid = await ops({ container: ctx.container, account_id: 'chk', repair: true });
    expect([plaid.status, plaid.body.error]).toEqual([409, 'chk is neither a manual account nor one SimpleFIN or Lunch Flow keeps up to date: only those are repaired here.']);
    delete process.env.OPS_ENABLED;
    expect((await ops({ container: ctx.container })).status).toBe(404);
  });
});

describe('the legacy estimate record, held flat for every estimated day', () => {
  beforeEach(async () => {
    // Built by an older release: one record for every estimated day.
    fake.hashes.delete(ctxKey('history:accounts:est:flatd'));
    await fake.set(ctxKey('history:accounts:est:flat'), await encrypt(ctx, JSON.stringify({ manual_eur: 5000 })));
  });

  test('read for the dry run, which writes nothing, and turned over day by day by the repair', async () => {
    const raw = historyNow();
    expect((await ops({ container: ctx.container })).body.accounts).toEqual([{ account_id: 'manual_eur', source: 'manual', type: 'credit', days: { r: 1, f: 3 }, first: EST[0], last: FRI }]);
    expect(historyNow()).toEqual(raw);
    expect(await fake.get(ctxKey('history:accounts:est:flatd'))).toBeNull();
    expect((await ops({ container: ctx.container, account_id: 'manual_eur', repair: true })).body.negated).toBe(4);
    for (const d of EST) expect([d, await stored('history:accounts:est:flatd', d)]).toEqual([d, { manual_eur: -5000 }]);
    expect((await readers()).converted_chart.filter(([d, , e]) => e && d < FRI)).toEqual([
      ['2026-09-08', 6807, true],
      ['2026-09-09', 6826, true],
      ['2026-09-10', 6808, true],
    ]);
  });

  test('a repair refused writes nothing, not even the record split by day', async () => {
    await put('history:accounts:partial', { '2026-09-12': { manual_eur: 5000 } });
    const raw = historyNow();
    expect((await ops({ container: ctx.container, account_id: 'manual_eur', repair: true })).status).toBe(409);
    expect(historyNow()).toEqual(raw);
    expect(fake.hashes.has(ctxKey('history:accounts:est:flatd'))).toBe(false);
  });
});

describe('a repair under way', () => {
  test('stopped at its time, it says so, and the next run finishes it', async () => {
    await cutAt(2, () => ops({ container: ctx.container, account_id: 'manual_eur', repair: true }));
    expect(await runSignJob(ctx, 'manual_eur', Date.now() - 1)).toEqual({ negated: 0, left: [], pending: true });
    expect(await signJobStore.has(ctx, 'manual_eur')).toBe(true);
    expect(await runSignJob(ctx, 'manual_eur')).toEqual({ negated: 3, left: [] });
    expect(await signJobStore.ids(ctx)).toEqual([]);
    for (const d of EST) expect([d, await stored('history:accounts:est:flatd', d)]).toEqual([d, { manual_eur: -5000 }]);
  });

  test('failing night after night, it is left to the operator after three, and the dry run says so', async () => {
    await cutAt(2, () => ops({ container: ctx.container, account_id: 'manual_eur', repair: true }));
    let tried = 0;
    const real = history.negateAccountOn;
    const failing = spyOn(history, 'negateAccountOn').mockImplementation(async () => {
      tried++;
      throw new TypeError('the function was stopped');
    });
    try {
      for (let night = 1; night <= 4; night++) await quiet(() => finishSignJobs(ctx));
    } finally {
      failing.mockRestore();
    }
    // Three nights tried, the fourth not.
    expect(tried).toBe(3);
    expect(await signJobStore.get(ctx, 'manual_eur')).toMatchObject({ failures: 3, error: 'TypeError' });
    expect((await ops({ container: ctx.container })).body.accounts).toEqual([
      expect.objectContaining({ account_id: 'manual_eur', pending: { kind: 'repair', failures: 3, error: 'TypeError', stopped: true } }),
    ]);
    // The operator finishes it.
    expect(real).toBe(history.negateAccountOn);
    expect((await ops({ container: ctx.container, account_id: 'manual_eur', repair: true })).body.negated).toBe(3);
    expect(await signJobStore.ids(ctx)).toEqual([]);
    expect((await readers()).converted_chart.find(([d]) => d === FRI)).toEqual([FRI, 6796, false]);
  });

  test('planned for a kind the account no longer has, it is dropped with words, and nothing more is turned over', async () => {
    await cutAt(2, () => ops({ container: ctx.container, account_id: 'manual_eur', repair: true }));
    // Changed back to savings under the release before.
    await saveManualAccount(ctx, { account_id: 'manual_eur', name: 'Euro savings', institution_name: 'Sparkasse', type: 'depository', subtype: null, balance: 5000, currency: 'EUR', updated_at: new Date(NOW).toISOString() });
    const raw = historyNow();
    const r = await quiet(() => ops({ container: ctx.container, account_id: 'manual_eur', repair: true }));
    expect([r.status, r.body.negated, r.body.abandoned]).toEqual([
      200,
      0,
      'The repair under way for manual_eur was planned for it as money owed, and it is money held now, so it was dropped and nothing more was turned over.',
    ]);
    expect(historyNow()).toEqual(raw);
    expect(await signJobStore.ids(ctx)).toEqual([]);
  });

  test('its account isn’t forgotten, and an account being forgotten isn’t repaired', async () => {
    await cutAt(2, () => ops({ container: ctx.container, account_id: 'manual_eur', repair: true }));
    const raw = historyNow();
    await expect(forgetEarlierAccount(ctx, 'manual_eur')).rejects.toThrow(SIGN_JOB_PENDING);
    await expect(history.forgetAccountBalances(ctx, 'manual_eur')).rejects.toThrow('being turned over');
    await expect(history.foldHiddenAccount(ctx, 'manual_eur', 'credit', 'tag-1')).rejects.toThrow('being turned over');
    expect(historyNow()).toEqual(raw);
    // A forget under way already (begun before the job): the job waits for it.
    expect((await call(hiddenRoute, 'POST', { account_id: 'manual_eur', hidden: true })).status).toBe(200);
    const { markForgetting } = await import('@/lib/hidden');
    await markForgetting(ctx, 'manual_eur', (await getHiddenAccounts(ctx)).get('manual_eur')!, 'tag-1');
    const r = await ops({ container: ctx.container, account_id: 'manual_eur', repair: true });
    expect([r.status, r.body.error]).toEqual([409, 'manual_eur is being forgotten: finish that first.']);
    expect(historyNow()).toEqual(raw);
    // Without a job before it, none is written.
    await signJobStore.remove(ctx, 'manual_eur');
    expect((await ops({ container: ctx.container, account_id: 'manual_eur', repair: true })).status).toBe(409);
    expect(await signJobStore.ids(ctx)).toEqual([]);
    expect(historyNow()).toEqual(raw);
  });
});
