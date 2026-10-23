import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime, spyOn } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';
import { ecbHash } from './fx-fixture';

// A download made while an account's balance history was being turned over
// to match its kind (lib/sign-repair.ts: a job still pending, said in the
// file's notes, lib/sign-turning.ts), brought back (lib/sign-repair.ts,
// BROUGHT BACK): the finish plans the repair from the restored totals and
// finishes it, and every reader reads as the other copy would once its own
// job was done, to the cent; one a day can't be told for is left exactly as
// it came, named on the card with the days, waiting for the operator's
// repair; and the stores' classes.
//
// The fixture is test/sign-repair.test.ts's: a checking account at Plaid in
// dollars, and a manual savings account in euros (5,000) recorded on Friday
// the 11th while it was money held, then flipped to a card under the release
// before; an estimate built before the flip. Dollars are the home currency.

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
    transactionsSync: async () => ({ data: { added: [], modified: [], removed: [], accounts: [CHK], next_cursor: 'c1', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' } }),
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
const { signJobStore, runSignJob, repairSignFlip, finishSignJobs, restoredRepairsView } = await import('@/lib/sign-repair');
const { restoredSignRepairsStore, MAX_FAILED_NIGHTS } = await import('@/lib/sign-repair-store');
const { turningOverWords, turningOverIds } = await import('@/lib/sign-turning');
const { classOfKey, keptWhenEmptied } = await import('@/lib/user-restore/classes');
const { SEAM } = await import('@/lib/user-restore/parts');
const { turningLines, signRepairLines } = await import('@/components/restore-state');
const { downloadText, restoreAll, planned, fetcher, call: restoreCall } = await import('./restore-run');
const { startBody, startRestore, sendBatches } = await import('@/lib/user-restore/send');
const { newUserRestoreId } = await import('@/lib/user-restore/ids');

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
const home = async () => (await (await netWorthRoute.GET(new Request('http://x/api/net-worth?refresh=1'))).json()) as any;
const pts = (list: any[]) => list.map((p: any) => [p.date, p.value, !!p.estimated]);
/** Jobs under way, a finished job's settle record aside. */
const pendingIds = async () => {
  const out: string[] = [];
  for (const id of await signJobStore.ids(ctx)) if ((await signJobStore.get(ctx, id))?.kind !== 'settle') out.push(id);
  return out;
};
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error] = [console.error];
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
  }
};

/** Every reader of the balance history, to the cent, with the savings
 *  account hidden through the app's route and shown again (as
 *  test/sign-repair.test.ts reads them): what is recorded and what each
 *  day converts to, hidden, through the API, a share, the account's own
 *  chart and the download. Home's live total is the copy's own (the bank
 *  isn't connected in the restored one), so only its chart is read. */
async function readers() {
  const h = await home();
  expect((await call(hiddenRoute, 'POST', { account_id: 'manual_eur', hidden: true })).status).toBe(200);
  const hidden_chart = pts(await getHistory(ctx, await getHiddenAccounts(ctx)));
  expect((await call(hiddenRoute, 'POST', { account_id: 'manual_eur', hidden: false })).status).toBe(200);
  const api = await readNetWorthAndHistory(ctx, { includeEstimated: true, interval: 'day' } as any, { base: 'private' } as any);
  const share = (await projectViews(ctx, { net_worth: { detail: 'history', accounts: false } } as any, NOW))!.views.net_worth as any;
  const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date()) as any;
  const upTo = (list: any[]) => list.filter((p) => p[0] <= DAY);
  return {
    chart: upTo(pts(h.history)),
    converted_chart: upTo(pts(h.base.history)),
    hidden_chart: upTo(hidden_chart),
    api_history: upTo(api.history.points.map((p: any) => [p.date, p.value, p.to_base, p.estimated])),
    share_history: upTo(pts(share.history)),
    account: (await getAccountHistory(ctx, 'manual_eur')).map((p) => [p.date, p.value, !!p.estimated]),
    download: doc.net_worth_history.points.map((p: any) => [p.date, p.total, p.kind]),
    account_download: doc.account_history.find((a: any) => a.account_id === 'manual_eur').points.map((p: any) => [p.date, p.balance, p.kind]),
  };
}

/** A fresh, empty account, as one a download is brought back into. */
async function emptyHere() {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await fake.hset(testKey('fx:ecb'), ecbHash());
}

/** The other copy's repair, cut off after its first day: a job pending, the
 *  history partly in each sign. */
async function cutOff() {
  const real = history.negateAccountOn;
  let calls = 0;
  const cut = spyOn(history, 'negateAccountOn').mockImplementation(async (...args) => {
    if (++calls === 2) throw new Error('the function was stopped');
    return real(...args);
  });
  try {
    await quiet(() => repairSignFlip(ctx, 'manual_eur').catch(() => null));
  } finally {
    cut.mockRestore();
  }
}

const saved = { ...process.env };
beforeEach(async () => {
  setSystemTime(new Date(NOW));
  process.env.APP_PASSWORD = 'hunter2';
  process.env.RESTORE_ENABLED = '1';
  process.env.OPS_ENABLED = '1';
  process.env.OPS_SECRET = 's3cret';
  await emptyHere();
  await saveItem(ctx, { item_id: 'item_bank', institution_name: 'Bank', encrypted_access_token: await encrypt(ctx, 'tok') });
  await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'USD' });
  await saveManualAccount(ctx, { account_id: 'manual_eur', name: 'Euro savings', institution_name: 'Sparkasse', type: 'credit', subtype: null, balance: 5000, currency: 'EUR', updated_at: new Date(NOW - 30 * 86_400_000).toISOString() });
  await put('history:accounts', { [FRI]: { chk: 1000, manual_eur: 5000 } });
  await put('history:net-worth', { [FRI]: '6000' });
  for (const d of EST) {
    await put('history:net-worth:est', { [d]: '6000' });
    await put('history:accounts:est', { [d]: { chk: 1000 } });
    await put('history:accounts:est:flatd', { [d]: { manual_eur: 5000 } });
  }
  await home();
});
afterEach(() => {
  process.env = { ...saved };
  setSystemTime();
});

describe('a download made while a job was pending', () => {
  test('says so in its notes, by the account’s id, in words a restore reads back', async () => {
    await cutOff();
    expect(await pendingIds()).toEqual(['manual_eur']);
    const doc = JSON.parse(await downloadText(new Date()));
    expect(doc.notes).toContain(turningOverWords(['manual_eur']));
    expect(turningOverIds(turningOverWords(['manual_eur', 'manual_b']))).toEqual(['manual_eur', 'manual_b']);
    expect(turningOverIds(turningOverWords(['manual_eur'], true))).toEqual(['manual_eur']);
    expect(turningOverIds('Some other note (manual_eur).')).toBeNull();
    // Never a Plaid account's id, which nothing turns over.
    expect(turningOverIds(turningOverWords(['acc_chk']))).toEqual([]);
    // And no job goes into the file: it is bookkeeping about this copy.
    expect(doc['sign-repairs']).toBeUndefined();
  });

  test('brought back, its repair is planned from the restored totals and finished: every reader as the other copy’s once done, to the cent', async () => {
    await cutOff();
    // Part turned over: Friday is, the estimate's days aren't yet.
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_eur: -5000 });
    expect(await stored('history:accounts:est:flatd', EST[0])).toEqual({ manual_eur: 5000 });
    const text = await downloadText(new Date());
    // Half turned, the estimate's days read the savings as owed: converted,
    // and hidden, they are wrong.
    const half = await readers();
    // What the other copy reads once its own job is done.
    await runSignJob(ctx, 'manual_eur');
    expect(await pendingIds()).toEqual([]);
    const expected = await readers();
    expect(half.converted_chart).not.toEqual(expected.converted_chart);
    expect(half.hidden_chart).not.toEqual(expected.hidden_chart);
    // Every total as recorded, either way.
    expect(half.chart).toEqual(expected.chart);
    expect(half.download).toEqual(expected.download);

    await emptyHere();
    const { p } = await planned(text);
    expect(turningLines(p.turning)).toEqual([
      'Euro savings’s balance history was being turned over to match its kind in your other copy: Nya finishes it here where your totals prove every day, and if some day can’t be told, turns nothing over and says so',
    ]);
    await restoreAll(text);
    expect(await restoredSignRepairsStore.get(ctx, 'manual_eur')).toMatchObject({ state: 'planned', days: [] });
    expect(await pendingIds()).toEqual([]);
    // Each day turned over once: Friday as it came, the estimate's now too.
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_eur: -5000 });
    for (const d of EST) expect(await stored('history:accounts:est:flatd', d)).toEqual({ manual_eur: -5000 });
    const after = await readers();
    expect(after).toEqual(expected);
    // The estimate held flat while it was savings reads as built; its own
    // chart is in its kind now, the amount owed.
    expect(after.chart.filter(([d, , e]) => e && d < FRI).every(([, v]) => v === 6000)).toBe(true);
    expect(after.account.filter(([, , e]) => !e)).toEqual([
      [FRI, -5000, false],
      [DAY, 5000, false],
    ]);
    // Finished, the card says nothing more of it.
    const state = await restoreCall('GET', '/api/user-restore');
    expect(state.body.sign_repairs).toEqual([]);
  });

  test('one a day can’t be told for is left exactly as it came, named on the card with the days, until the operator’s repair', async () => {
    // A day measured without a total between the last counted held and the
    // first counted owed: the day it flipped can't be found exactly.
    await put('history:accounts:partial', { '2026-09-12': { manual_eur: 5000 } });
    // A job the other copy had under way (its plan made before that day was
    // measured, say): said in the file all the same.
    await signJobStore.set(ctx, 'manual_eur', { v: 1, kind: 'repair', from: 'credit', to: 'credit', at: new Date(NOW).toISOString(), tag: 'sign-test', plan: { f: EST.map((d) => [d, 5000] as [string, number]) } });
    const text = await downloadText(new Date());
    await emptyHere();
    // Brought back as the page does it, the finish's own answer read: it
    // names the account and the days.
    const { source, c, p, plan } = await planned(text);
    const record = await startRestore(fetcher, startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
    await sendBatches(source, c, record, { fetcher, plan });
    const finished = await quiet(() => restoreCall('POST', `/api/user-restore/batch?restore_id=${encodeURIComponent(record.id)}&finish=1`));
    expect(finished.status).toBe(200);
    expect(finished.body.sign_repairs).toEqual([{ account_id: 'manual_eur', name: 'Euro savings', state: 'waiting', days: ['2026-09-12'], pending: false, stopped: false }]);
    expect(await restoredSignRepairsStore.get(ctx, 'manual_eur')).toMatchObject({ state: 'waiting', days: ['2026-09-12'] });
    expect(await pendingIds()).toEqual([]);
    // Nothing turned over: every value as the file had it.
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_eur: 5000 });
    for (const d of EST) expect(await stored('history:accounts:est:flatd', d)).toEqual({ manual_eur: 5000 });
    const state = await restoreCall('GET', '/api/user-restore');
    expect(state.body.sign_repairs).toEqual([{ account_id: 'manual_eur', name: 'Euro savings', state: 'waiting', days: ['2026-09-12'], pending: false, stopped: false }]);
    expect(signRepairLines(state.body.sign_repairs)).toEqual([
      {
        text: 'Euro savings’s balance history was being turned over to match its kind in your other copy, and nothing says how it was counted on Sep 12, 2026: so nothing was turned over, and some of its earlier days may count the other way. Whoever runs your Nya can repair it, after looking at what it would change.',
        warn: true,
      },
    ]);
    // The nightly finishing of jobs plans nothing for it either.
    await quiet(() => finishSignJobs(ctx));
    expect(await pendingIds()).toEqual([]);

    // The operator's repair, once the day can be told (here: the stray
    // measurement taken out), answers it: the card no longer names it.
    await fake.hdel(ctxKey('history:accounts:partial'), '2026-09-12');
    const res: Response = await opsRoute.POST(new Request('http://x/api/ops/sign-repair', { method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: JSON.stringify({ container: ctx.container, account_id: 'manual_eur', repair: true }) }));
    expect(res.status).toBe(200);
    expect(await restoredSignRepairsStore.get(ctx, 'manual_eur')).toBeNull();
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_eur: -5000 });
  });

  test('one the finish didn’t get to is planned and finished by the next run that finishes jobs', async () => {
    await cutOff();
    const text = await downloadText(new Date());
    await emptyHere();
    // The finish finds the lock held (another change to accounts), and leaves it named.
    const { withLinksLock } = await import('@/lib/links');
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const holding = withLinksLock(ctx, () => held);
    await restoreAll(text);
    release();
    await holding;
    expect(await restoredSignRepairsStore.get(ctx, 'manual_eur')).toMatchObject({ state: 'named' });
    expect(signRepairLines((await restoreCall('GET', '/api/user-restore')).body.sign_repairs)[0].text).toBe(
      'Euro savings’s balance history was being turned over to match its kind in your other copy: Nya looks at it with its next daily update.'
    );
    await finishSignJobs(ctx);
    expect(await restoredSignRepairsStore.get(ctx, 'manual_eur')).toMatchObject({ state: 'planned' });
    expect(await pendingIds()).toEqual([]);
    for (const d of EST) expect(await stored('history:accounts:est:flatd', d)).toEqual({ manual_eur: -5000 });
  });

  test('one planned that the nightly job has stopped trying is said so: whoever runs the copy has to finish it', async () => {
    // A restored repair is an ordinary job: planned, then failing on
    // MAX_FAILED_NIGHTS nights in a row without getting through any of it.
    const at = new Date(NOW).toISOString();
    await restoredSignRepairsStore.set(ctx, 'manual_eur', { v: 1, state: 'planned', days: [], set_at: at });
    const job = { v: 1, kind: 'repair', from: 'credit', to: 'credit', at, tag: 'sign-x', plan: { f: EST.map((d) => [d, 5000] as [string, number]) } } as const;
    await signJobStore.set(ctx, 'manual_eur', { ...job, failures: MAX_FAILED_NIGHTS - 1, error: 'Stalled' });
    // Still tried: the next daily update finishes it.
    expect(await restoredRepairsView(ctx)).toEqual([{ account_id: 'manual_eur', name: 'Euro savings', state: 'planned', days: [], pending: true, stopped: false }]);
    expect(signRepairLines(await restoredRepairsView(ctx))).toEqual([
      { text: 'Euro savings’s balance history is being turned over to match its kind, as your other copy had begun: Nya’s next daily update finishes it.', warn: false },
    ]);
    // Stopped: the nightly job leaves it as it is, and the card says so, as
    // the download's note says of a job stopped (lib/sign-turning.ts).
    await signJobStore.set(ctx, 'manual_eur', { ...job, failures: MAX_FAILED_NIGHTS, error: 'Stalled' });
    await finishSignJobs(ctx);
    expect(await signJobStore.get(ctx, 'manual_eur')).toEqual({ ...job, failures: MAX_FAILED_NIGHTS, error: 'Stalled' });
    for (const d of EST) expect(await stored('history:accounts:est:flatd', d)).toEqual({ manual_eur: 5000 });
    const state = await restoreCall('GET', '/api/user-restore');
    expect(state.body.sign_repairs).toEqual([{ account_id: 'manual_eur', name: 'Euro savings', state: 'planned', days: [], pending: true, stopped: true }]);
    expect(signRepairLines(state.body.sign_repairs)).toEqual([
      {
        text: 'Euro savings’s balance history is being turned over to match its kind, as your other copy had begun, and Nya’s daily update has stopped trying, so whoever runs your Nya has to finish it.',
        warn: true,
      },
    ]);
    // The operator's repair, once the cause is fixed, finishes it, and the
    // card no longer names it.
    const res: Response = await opsRoute.POST(new Request('http://x/api/ops/sign-repair', { method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: JSON.stringify({ container: ctx.container, account_id: 'manual_eur', repair: true }) }));
    expect(res.status).toBe(200);
    expect(await pendingIds()).toEqual([]);
    expect(await restoredRepairsView(ctx)).toEqual([]);
  });

  test('a file with nothing being turned over names nothing, and its finish writes nothing of it', async () => {
    const text = await downloadText(new Date());
    await emptyHere();
    const { p } = await planned(text);
    expect(p.turning).toEqual([]);
    await restoreAll(text);
    expect(await restoredSignRepairsStore.count(ctx)).toBe(0);
  });
});

describe('the stores’ classes', () => {
  test('the jobs and what a restore found of one are machinery: never in the download, never brought back, gone with the history when the account is emptied', () => {
    for (const name of ['sign-repairs', 'restored-sign-repairs']) {
      expect([name, classOfKey(`c:${ctx.container}:${name}`).cls]).toEqual([name, 'machinery']);
      expect([name, keptWhenEmptied(`c:${ctx.container}:${name}`)]).toEqual([name, false]);
      expect([name, Object.hasOwn(SEAM, name)]).toEqual([name, false]);
    }
  });
});
