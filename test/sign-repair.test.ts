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
const { SIGN_JOB_PENDING, SIGN_JOB_STOPPED } = await import('@/lib/sign-repair-store');
const { snapshotData, SIGN_BUDGET_MS } = await import('@/lib/snapshot-job');
const signRepair = await import('@/lib/sign-repair');

const ctx = TEST_CTX;
/** Jobs under way, a finished job's settle record aside. */
const pendingIds = async () => {
  const out: string[] = [];
  for (const id of await signJobStore.ids(ctx)) if ((await signJobStore.get(ctx, id))?.kind !== 'settle') out.push(id);
  return out;
};
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
    expect(await pendingIds()).toEqual([]);

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
    expect(await pendingIds()).toEqual([]);
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
    expect(await pendingIds()).toEqual([]);
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
    expect(await runSignJob(ctx, 'manual_eur', Date.now() - 1)).toEqual({ negated: 0, left: [], pending: true, stalled: true });
    expect(await signJobStore.has(ctx, 'manual_eur')).toBe(true);
    expect(await runSignJob(ctx, 'manual_eur')).toEqual({ negated: 3, left: [] });
    expect(await pendingIds()).toEqual([]);
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
      // A download failing to finish it counts no night.
      await quiet(() => finishSignJobs(ctx));
      expect(await signJobStore.get(ctx, 'manual_eur')).not.toHaveProperty('failures');
      const nightly = spyOn(signRepair, 'finishSignJobs');
      try {
        for (let night = 1; night <= 4; night++) await quiet(() => snapshotData(ctx, []));
        // Within its own budget, off the snapshot's start budget.
        expect(nightly).toHaveBeenCalledWith(ctx, { budgetMs: SIGN_BUDGET_MS, nightly: true });
      } finally {
        nightly.mockRestore();
      }
    } finally {
      failing.mockRestore();
    }
    // Three nights tried, the fourth not (the download's try aside).
    expect(tried).toBe(4);
    expect(await signJobStore.get(ctx, 'manual_eur')).toMatchObject({ failures: 3, error: 'TypeError' });
    // A forget meanwhile says who finishes it now.
    await expect(forgetEarlierAccount(ctx, 'manual_eur')).rejects.toThrow(SIGN_JOB_STOPPED);
    expect((await ops({ container: ctx.container })).body.accounts).toEqual([
      expect.objectContaining({ account_id: 'manual_eur', pending: { kind: 'repair', failures: 3, error: 'TypeError', stopped: true } }),
    ]);
    // A download meanwhile says so in its notes.
    expect((await collectUserData({ ctx, userId: null })).notes).toContain(
      'The history of one account (manual_eur) is being turned over to match what it is: until that finishes, some of its earlier days in account_history are in the other sign. Nya’s daily update tries again, and whoever runs your Nya can finish it: download again once it is done.'
    );
    // The operator finishes it.
    expect(real).toBe(history.negateAccountOn);
    expect((await ops({ container: ctx.container, account_id: 'manual_eur', repair: true })).body.negated).toBe(3);
    expect(await pendingIds()).toEqual([]);
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
    expect(await pendingIds()).toEqual([]);
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
    expect(await pendingIds()).toEqual([]);
    expect(historyNow()).toEqual(raw);
  });
});

describe('a repair cut off, then the history rewritten', () => {
  test('the estimate rebuilt under its kind now: those days are left as rebuilt, in the right sign', async () => {
    await cutAt(2, () => ops({ container: ctx.container, account_id: 'manual_eur', repair: true }));
    // Rebuilt meanwhile (a backfill after anything cleared its flag): the
    // savings, a card now, held flat at 5,000 owed; each total 1,000 - 5,000.
    for (const d of EST) {
      await put('history:net-worth:est', { [d]: '-4000' });
      await put('history:accounts:est', { [d]: { chk: 1000 } });
      await put('history:accounts:est:flatd', { [d]: { manual_eur: 5000 } });
    }
    const rebuilt = await readers(['manual_eur']);
    await quiet(() => finishSignJobs(ctx, { nightly: true }));
    expect(await pendingIds()).toEqual([]);
    for (const d of EST) expect([d, await stored('history:accounts:est:flatd', d)]).toEqual([d, { manual_eur: 5000 }]);
    const after = await readers(['manual_eur']);
    // Hidden, each estimated day is the checking account alone.
    expect(after.hidden_chart.filter(([d]) => EST.includes(d))).toEqual(EST.map((d) => [d, 1000, true]));
    expect(after.converted_chart).toEqual(rebuilt.converted_chart);
    // Friday, turned over before the cut, stays so.
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_eur: -5000 });
  });

  test('rebuilt beside a balance that cancels it out: still left as rebuilt', async () => {
    await saveManualAccount(ctx, { account_id: 'manual_jar', name: 'Jar', institution_name: 'Home', type: 'depository', subtype: null, balance: 5000, currency: 'EUR', updated_at: new Date(NOW).toISOString() });
    await cutAt(2, () => ops({ container: ctx.container, account_id: 'manual_eur', repair: true }));
    // Rebuilt with a jar of 5,000 held beside it: the card owing 5,000 and the
    // jar could both have been counted the other way, or neither.
    for (const d of EST) {
      await put('history:net-worth:est', { [d]: '1000' });
      await put('history:accounts:est', { [d]: { chk: 1000 } });
      await put('history:accounts:est:flatd', { [d]: { manual_eur: 5000, manual_jar: 5000 } });
    }
    await quiet(() => finishSignJobs(ctx, { nightly: true }));
    for (const d of EST) expect([d, await stored('history:accounts:est:flatd', d)]).toEqual([d, { manual_eur: 5000, manual_jar: 5000 }]);
  });
});

describe('a long repair, a little each night', () => {
  /** Runs `fn` with the clock moving on `ms` at every turning over. */
  const slow = async <T>(ms: number, fn: () => Promise<T>): Promise<{ out: T; calls: string[] }> => {
    const real = history.negateAccountOn;
    const calls: string[] = [];
    const ticking = spyOn(history, 'negateAccountOn').mockImplementation(async (...args) => {
      calls.push(`${args[1]}:${args[2]}`);
      setSystemTime(new Date(Date.now() + ms));
      return real(...args);
    });
    try {
      return { out: await fn(), calls };
    } finally {
      ticking.mockRestore();
    }
  };

  test('each night starts where the last stopped, never going over a day twice', async () => {
    // Forty more days counted as savings, before Friday.
    for (let i = 0; i < 40; i++) {
      const d = new Date(Date.parse('2026-07-01T00:00:00Z') + i * 86_400_000).toISOString().slice(0, 10);
      await put('history:accounts', { [d]: { chk: 1000, manual_eur: 5000 } });
      await put('history:net-worth', { [d]: '6000' });
    }
    // Cut off after ten.
    await cutAt(11, () => ops({ container: ctx.container, account_id: 'manual_eur', repair: true }));
    const job = (await signJobStore.get(ctx, 'manual_eur'))!;
    // What it went through is out of the plan: 41 recorded days and 3 estimated, less ten.
    expect([job.plan!.r!.length, job.plan!.f!.length]).toEqual([31, 3]);
    const seen: string[] = [];
    for (let night = 1; night <= 6 && (await pendingIds()).length > 0; night++) {
      // A second of time a night, a tenth of one for each day.
      const { calls } = await slow(100, () => quiet(() => finishSignJobs(ctx, { budgetMs: 1000, nightly: true })));
      expect(calls.length).toBeGreaterThan(0);
      seen.push(...calls);
      expect((await signJobStore.get(ctx, 'manual_eur'))?.failures ?? 0).toBe(0);
    }
    expect(await pendingIds()).toEqual([]);
    expect(seen.length).toBe(34);
    expect(new Set(seen).size).toBe(34);
    for (const [d] of job.plan!.r!) expect([d, (await stored('history:accounts', d)).manual_eur]).toEqual([d, -5000]);
  });

  test('a night that runs out of time before a single day counts as failing, and three stop it', async () => {
    await cutAt(2, () => ops({ container: ctx.container, account_id: 'manual_eur', repair: true }));
    // Something slow before its first day, each night.
    const slowStart = spyOn(history, 'splitLegacyFlat').mockImplementation(async () => {
      setSystemTime(new Date(Date.now() + 2000));
    });
    try {
      for (let night = 1; night <= 4; night++) await quiet(() => finishSignJobs(ctx, { budgetMs: 1000, nightly: true }));
    } finally {
      slowStart.mockRestore();
    }
    expect(await signJobStore.get(ctx, 'manual_eur')).toMatchObject({ failures: 3, error: 'Stalled' });
    expect((await ops({ container: ctx.container })).body.accounts).toEqual([
      expect.objectContaining({ account_id: 'manual_eur', pending: { kind: 'repair', failures: 3, error: 'Stalled', stopped: true } }),
    ]);
    await expect(forgetEarlierAccount(ctx, 'manual_eur')).rejects.toThrow(SIGN_JOB_STOPPED);
  });
});
