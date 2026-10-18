import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, testKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld, TXNS } from './restore-fixture';
import { clerk } from './clerk-mock';

// Bringing a download back through the routes (app/api/user-restore and its
// batch route), as the page does it (lib/user-restore/file.ts collect and
// previewOf, lib/user-restore/send.ts): a real download of a seeded container
// (test/restore-fixture.ts), read, planned and checked, started, sent in
// batches and finished into an empty container, then downloaded again and
// compared part by part; Activity before and after the bank is connected
// again; and each route's refusals, an interrupted restore and its resume,
// undo, emptying, and what stays in the container.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_UNDO_PAUSE_MS = '0';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { collect, previewOf } = await import('@/lib/user-restore/file');
const { startBody, startRestore, sendBatches, finishRestore, RestoreStopped } = await import('@/lib/user-restore/send');
const { newUserRestoreId, restoredId, MAX_BATCH_BODY } = await import('@/lib/user-restore/ids');
const { userRestoreStore, restoredTxnStore, startsCount, STARTS_PER_DAY } = await import('@/lib/user-restore/store');
const { scanAccount } = await import('@/lib/user-restore/empty');
const { restoreUnfinished } = await import('@/lib/user-restore/restored');
const { forgetEpochs } = await import('@/lib/sessions');
const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { saveManualAccount } = await import('@/lib/manual');
const { linkAccounts } = await import('@/lib/links');
const { reportSettingsStore } = await import('@/lib/report/store');
const lifecycleRoute = await import('@/app/api/account-lifecycle/route');
const { EXPORTED, sent, fetcher, call, downloadText, sourceOf, planned, restoreAll, activity, rowsOf, hold, connectAgain } = await import('./restore-run');
type Source = import('./restore-run').Source;

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;

/** Every key the fake holds, with its value(s) as stored. */
function snapshot(prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of (fake as any).strings as Map<string, string>) if (k.startsWith(prefix)) out[k] = v;
  for (const [k, h] of (fake as any).hashes as Map<string, Map<string, string>>) if (k.startsWith(prefix)) out[k] = Object.fromEntries(h);
  return out;
}

// The old copy: its download, and what Activity showed there.
fake.reset();
await registerTestContainer(fake);
await seedOld(fake, ctx);
const OLD = { text: await downloadText(EXPORTED), activity: rowsOf(await activity()) };

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  process.env.RESTORE_ENABLED = '1';
  sent.batches = 0;
  sent.failAfter = Infinity;
});

const differing = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();

describe('a round trip', () => {
  test('everything comes back as the download had it, but the bank connection, whose posted rows come back held under their own ids', async () => {
    const record = await restoreAll(OLD.text);
    expect(record).toMatchObject({ status: 'finished', done: record.plan.batches, earlier: [], without: {} });
    expect(Date.parse(record.undo_until!) - Date.parse(record.finished_at!)).toBe(7 * 86_400_000);
    expect(record.left_out).toEqual({ pending_transactions: 1, 'category_overrides:pending': 1, 'transaction-annotations:pending': 1, 'transaction-groups:pending': 1 });

    const a = JSON.parse(OLD.text);
    const b = JSON.parse(await downloadText(new Date()));
    expect(differing(a, b)).toEqual(
      [
        'exported_at',
        'institutions',
        'accounts',
        'transactions',
        'category_overrides',
        'restored-accounts',
        'restored-transactions',
        'transaction-annotations',
        'transaction-approvals',
        'transaction-groups',
        'transaction-splits',
        'user-restore',
      ].sort()
    );
    // No connection: its accounts are earlier ones, each as the download had
    // it but what only the bank's own store held (the currency, the limit);
    // the card, which the old copy hadn't listed yet, is listed from its days.
    expect(b.institutions).toEqual([]);
    const accounts = new Map<string, any>(b.accounts.map((x: any) => [x.account_id, x]));
    for (const x of a.accounts) {
      const y = accounts.get(x.account_id);
      const restored = x.account_id === 'acc_chk' || x.account_id === 'acc_card';
      expect(y).toEqual(
        restored
          ? { ...x, connected: false, currency: null, credit_limit: null, ...(x.account_id === 'acc_card' ? { first_seen: '2025-12-30', last_seen: '2026-10-06' } : {}) }
          : x
      );
    }
    // The bank's posted rows, whole, under their restored ids; the pending
    // one and what was said only about it left out.
    expect(b.transactions).toEqual([]);
    const posted = a.transactions.filter((t: any) => !t.pending);
    const restored = b['restored-transactions'].flatMap((e: any) => e.value.rows);
    expect(restored.map((r: any) => r.id).sort()).toEqual(posted.map((t: any) => restoredId(t.transaction_id)).sort());
    for (const r of restored) expect(r.bank).toEqual(TXNS[r.bank.transaction_id as keyof typeof TXNS]);
    expect(b['restored-accounts'].map((e: any) => [e.id, e.value.institution_name, e.value.rows])).toEqual([
      ['acc_card', 'Chase', { first: '2026-01-03', last: '2026-01-03', count: 1, books: 1 }],
      ['acc_chk', 'Chase', { first: '2025-11-20', last: '2026-01-04', count: 3, books: 1 }],
    ]);
    const rekeyed = (list: any[], key = 'id') => list.filter((x) => x[key] !== 't_pending').map((x) => ({ ...x, [key]: restoredId(x[key]) }));
    expect(b.category_overrides).toEqual(rekeyed(a.category_overrides, 'transaction_id'));
    expect(b['transaction-annotations']).toEqual(rekeyed(a['transaction-annotations']));
    expect(b['transaction-splits']).toEqual(rekeyed(a['transaction-splits']));
    // The pending row's approval stays, under its restored id: the posted row
    // that replaced it is approved by it (lib/review-store.ts).
    expect(b['transaction-approvals']).toEqual(a['transaction-approvals'].map((x: any) => ({ ...x, id: restoredId(x.id) })));
    // A group left with one member is no group.
    expect(b['transaction-groups']).toEqual([{ ...a['transaction-groups'][0], value: { ...a['transaction-groups'][0].value, members: ['t_card', 't_coffee'].map(restoredId) } }]);
    expect(b['user-restore']).toMatchObject({ id: record.id, status: 'finished', source: { exported_at: EXPORTED.toISOString(), version: 2, protected: false } });
  });

  test('the restored copy’s own download brings it all back again, with the restore before it recorded', async () => {
    const first = await restoreAll(OLD.text);
    const second = await downloadText(new Date());
    fake.reset();
    forgetEpochs();
    await registerTestContainer(fake);
    const again = await restoreAll(second);
    expect(again.earlier).toEqual([{ exported_at: EXPORTED.toISOString(), restored_at: first.started_at }]);
    const b = JSON.parse(second);
    const c = JSON.parse(await downloadText(new Date()));
    expect(differing(b, c)).toEqual(['exported_at', 'user-restore']);
  });

  test('Activity: the bank’s rows held until their account is linked, and said so; no total recorded meanwhile', async () => {
    await restoreAll(OLD.text);
    const held = await activity();
    expect(rowsOf(held)).toEqual([['manual-txn:00000000-0000-4000-8000-000000000001', '2026-02-01', 120, 'Home', null, null]]);
    expect((held as any).incomplete).toEqual([{ institution_name: 'Chase', coverage: 'held', from: '2025-11-20', to: '2026-01-04' }]);
    expect(await hold()).toEqual({ unfinished: false, waiting: [{ institution_name: 'Chase', last: '2026-01-04' }], unreadable: false, history_last: '2026-01-04' });
  });

  test('connected again and linked: each restored row counts once, the bank’s own taking its place where its window reaches, with what was said', async () => {
    await restoreAll(OLD.text);
    await connectAgain(fake);
    // Not linked yet: the new connection's rows alone.
    expect(rowsOf(await activity()).map((r) => r[0])).toEqual(['n_new', 'manual-txn:00000000-0000-4000-8000-000000000001', 'n_gas', 'n_card', 'n_coffee']);
    await linkAccounts(ctx, 'acc_chk', 'new_chk', {});
    await linkAccounts(ctx, 'acc_card', 'new_card', {});
    const linked = await activity();
    // As the old copy showed them: the group of the coffee and the (hidden)
    // card's books, the split of the old grocery, now older than the bank's
    // window, and the gas, whose bank row is sent again; with one new row.
    expect(rowsOf(linked)).toEqual([['n_new', '2026-02-01', 9.99, 'food and drink', null, null], ...OLD.activity.map((r) => (r[0] === 't_posted' ? ['n_gas', ...r.slice(1)] : r))]);
    expect((linked as any).incomplete).toEqual([]);
    expect((await hold()).waiting).toEqual([]);
  });

  test('the transactions CSV and a linked account’s statement say the rows brought back are in the JSON download only', async () => {
    await restoreAll(OLD.text);
    const { collectUserData, buildUserExport, exportFile } = await import('@/lib/user-export');
    const { ofxFile } = await import('@/lib/ofx-export');
    const note = (what: string) => `The transactions a download brought back from Chase are in the JSON download only (restored-transactions): ${what} doesn’t list them yet.`;
    const doc = buildUserExport(await collectUserData({ ctx, userId: 'user_me' }), new Date());
    expect(exportFile(doc, 'transactions-csv').notes).toContain(note('this CSV'));
    expect(exportFile(doc, 'balances-csv').notes.join(' ')).not.toContain('restored-transactions');
    await connectAgain(fake);
    await linkAccounts(ctx, 'acc_chk', 'new_chk', {});
    const data = await collectUserData({ ctx, userId: 'user_me' });
    const statement = ofxFile(data, buildUserExport(data, new Date()), 'new_chk', new Date());
    expect('file' in statement ? statement.file.notes : []).toContain(note('this statement'));
    const card = ofxFile(data, buildUserExport(data, new Date()), 'new_card', new Date());
    expect('file' in card ? card.file.notes.join(' ') : '').not.toContain('restored-transactions');
  });

  test('or not connected again: stopping following each restored account lets the totals go on', async () => {
    await restoreAll(OLD.text);
    for (const account_id of ['acc_chk', 'acc_card']) {
      const res = await lifecycleRoute.POST(new Request('http://localhost/api/account-lifecycle', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account_id, state: 'untracked', from: '2026-01-05' }) }));
      expect(res.status).toBe(200);
    }
    expect((await hold()).waiting).toEqual([]);
  });
});

describe('the routes', () => {
  test('off unless RESTORE_ENABLED=1: what is recorded is still said, and still undone; the rest refused', async () => {
    const record = await restoreAll(OLD.text);
    delete process.env.RESTORE_ENABLED;
    const state = await call('GET', '/api/user-restore');
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ enabled: false, demo: false, unreadable: false, record: { id: record.id, status: 'finished' } });
    // What the card's next steps name: each restored account still waiting.
    expect(state.body.waiting).toEqual([
      { account_id: 'acc_chk', institution_name: 'Chase', name: 'Checking', mask: '1111', last: '2026-01-04' },
      { account_id: 'acc_card', institution_name: 'Chase', name: 'Sapphire', mask: '2222', last: '2026-01-03' },
    ]);
    expect((await call('POST', '/api/user-restore', { action: 'empty', confirm: 'empty my account', password: 'hunter2' })).status).toBe(403);
    expect((await call('POST', `/api/user-restore/batch?restore_id=${record.id}&finish=1`)).status).toBe(403);
    expect((await call('POST', '/api/user-restore/batch?check=1&exported=2026-10-06', '{"part":"store:tags","records":[]}')).status).toBe(403);
    expect((await call('DELETE', '/api/user-restore', { restore_id: record.id, confirm: true, password: 'hunter2' })).status).toBe(200);
    expect((await call('GET', '/api/user-restore')).body.record).toBeNull();
  });

  test('refused into an account in use, saying what was found, and nothing kept; settings alone are replaced', async () => {
    await saveManualAccount(ctx, { account_id: 'manual_car', name: 'Car', institution_name: 'Manual', type: 'other', subtype: null, balance: 9000, updated_at: '2026-10-01T00:00:00.000Z' } as never);
    const scan = await call('GET', '/api/user-restore?scan=1');
    expect(scan.body.scan).toMatchObject({ empty: false, found: ['manual accounts'], unseen: false });
    expect(scan.body.scan.message).toContain('This account already has manual accounts.');
    const { source, p, plan } = await planned(OLD.text);
    const start = await call('POST', '/api/user-restore', startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
    expect(start.status).toBe(409);
    expect(start.body.error).toContain('manual accounts');
    expect(await userRestoreStore.get(ctx)).toBeNull();

    fake.reset();
    forgetEpochs();
    await registerTestContainer(fake);
    await reportSettingsStore.set(ctx, { v: 1, marked: ['travel'] });
    expect((await call('GET', '/api/user-restore?scan=1')).body.scan).toMatchObject({ empty: true, settings: ['report-settings'] });
    await restoreAll(OLD.text);
    expect(await reportSettingsStore.get(ctx)).toEqual({ v: 1, marked: ['food and drink'] });
  });

  test('two starts at once: one claims the record; the same start sent again answers it', async () => {
    const { source, p, plan } = await planned(OLD.text);
    const one = startBody(p, plan, source, newUserRestoreId(), 'hunter2');
    const two = startBody(p, plan, source, newUserRestoreId(), 'hunter2');
    const answers = await Promise.all([call('POST', '/api/user-restore', one), call('POST', '/api/user-restore', two)]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
    expect(answers.find((a) => a.status === 409)!.body.error).toContain('A restore is already under way here');
    const winner = answers.find((a) => a.status === 200)!.body.record;
    const again = await call('POST', '/api/user-restore', winner.id === one.restore_id ? one : two);
    expect(again).toEqual({ status: 200, body: { record: winner } });
  });

  test('a wrong password, a plan whose digest isn’t its batches, a field it doesn’t take: refused, nothing claimed', async () => {
    const { source, p, plan } = await planned(OLD.text);
    const body = startBody(p, plan, source, newUserRestoreId(), 'hunter2');
    expect((await call('POST', '/api/user-restore', { ...body, password: 'nope' })).body).toMatchObject({ wrong_password: true });
    expect((await call('POST', '/api/user-restore', { ...body, plan: { ...plan, digest: '0'.repeat(64) } })).status).toBe(400);
    expect((await call('POST', '/api/user-restore', { ...body, later: 1 })).status).toBe(400);
    expect((await call('POST', '/api/user-restore', { ...body, source: { ...(body.source as object), name: 'my file.json' } })).status).toBe(400);
    expect(await userRestoreStore.get(ctx)).toBeNull();
  });

  test('starts, undos and emptyings are counted together', async () => {
    for (let i = 0; i < STARTS_PER_DAY; i++) await startsCount.take(ctx);
    const { source, p, plan } = await planned(OLD.text);
    const start = await call('POST', '/api/user-restore', startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
    expect(start.status).toBe(429);
    expect(await userRestoreStore.get(ctx)).toBeNull();
  });

  test('batches go in order; one sent again is answered as written; a finish waits for every batch', async () => {
    const { source, c, p, plan } = await planned(OLD.text);
    const record = await startRestore(fetcher, startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
    const bodies: string[] = [];
    const { buildBatches } = await import('@/lib/user-restore/file');
    await buildBatches(source, c, async (b) => void bodies.push(b.body));
    const post = (i: number, body = bodies[i]) => call('POST', `/api/user-restore/batch?restore_id=${record.id}&index=${i}`, body);
    expect(await post(1)).toMatchObject({ status: 409, body: { done: 0 } });
    expect(await post(0)).toEqual({ status: 200, body: { done: 1 } });
    expect(await post(0)).toEqual({ status: 200, body: { done: 1 } });
    expect((await call('POST', `/api/user-restore/batch?restore_id=${record.id}&finish=1`)).body).toMatchObject({ done: 1 });
    const rows = plan.batches.findIndex((b) => b.part === 'restored-rows');
    for (let i = 1; i <= rows; i++) expect((await post(i)).status).toBe(200);
    expect((await post(rows)).body).toEqual({ done: rows + 1 });
    const books = await restoredTxnStore.getAll(ctx);
    expect([...books.values()].flatMap((b) => b.rows).length).toBe(4);
    // Another restore's batch, or one past the plan.
    expect((await call('POST', `/api/user-restore/batch?restore_id=${newUserRestoreId()}&index=0`, bodies[0])).status).toBe(409);
    expect((await call('POST', `/api/user-restore/batch?restore_id=${record.id}&index=${plan.batches.length}`, bodies[0])).status).toBe(400);
  });

  test('a batch cut short, or changed since the plan, or larger than taken, is refused with nothing written', async () => {
    const { source, c, p, plan } = await planned(OLD.text);
    const record = await startRestore(fetcher, startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
    const { buildBatches } = await import('@/lib/user-restore/file');
    const bodies: string[] = [];
    await buildBatches(source, c, async (b) => void bodies.push(b.body));
    const before = snapshot();
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetcher(`/api/user-restore/batch?restore_id=${record.id}&index=0`, { method: 'POST', headers, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
    expect(await post(bodies[0].slice(0, -5))).toMatchObject({ status: 409, body: { mismatch: true, done: 0 } });
    expect(await post(bodies[0].replace('"', ' "'))).toMatchObject({ status: 409, body: { mismatch: true } });
    expect((await post('x'.repeat(MAX_BATCH_BODY + 1))).status).toBe(413);
    expect((await post(bodies[0], { 'content-length': String(MAX_BATCH_BODY + 1) })).status).toBe(413);
    expect(differing(before, snapshot())).toEqual([]);
  });

  test('a bank connected in another tab while it runs stops the next batch', async () => {
    const { source, c, p, plan } = await planned(OLD.text);
    const record = await startRestore(fetcher, startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
    sent.failAfter = 1;
    await expect(sendBatches(source, c, record, { fetcher, plan })).rejects.toThrow(RestoreStopped);
    await saveItem(ctx, { item_id: 'item_new', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'access-sandbox-b') } as never);
    sent.failAfter = Infinity;
    const stopped = await sendBatches(source, c, { ...record, done: 1 }, { fetcher, plan }).catch((err) => err);
    expect(stopped).toBeInstanceOf(RestoreStopped);
    expect(stopped.status).toBe(409);
    expect(stopped.answer).toMatchObject({ connected: true, done: 1 });
  });

  test('the server checks every batch itself: a record changed to one the store refuses is refused', async () => {
    const { source, p, plan } = await planned(OLD.text);
    await startRestore(fetcher, startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
    const bad = await call('POST', '/api/user-restore/batch?check=1&exported=2026-10-06', '{"part":"store:tags","records":[{"value":{"version":1,"tags":[{"id":"t","name":"x","color":"blue","created_at":"2026-01-01T00:00:00.000Z","later":1}]}}]}');
    expect(bad.status).toBe(400);
    expect(bad.body.problem).toContain('later');
    const day = await call('POST', '/api/user-restore/batch?check=1&exported=2026-10-06', '{"part":"history:net-worth","records":[{"date":"2026-10-07","value":1}]}');
    expect(day.status).toBe(400);
    expect(day.body.problem).toContain('after the download');
  });
});

describe('who may', () => {
  test('a demo account is refused, and told why before being asked to confirm it’s them', async () => {
    const saved = { ...process.env };
    try {
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_placeholder';
      process.env.CLERK_SECRET_KEY = 'sk_test_placeholder';
      process.env.CLERK_ALLOWED_USER_IDS = '';
      process.env.VERCEL_ENV = 'preview';
      process.env.DEMO_USER_IDS = 'user_demo:Alex';
      await fake.hset(testKey('owners'), { user_demo: TEST_CTX.container });
      clerk.signedIn = 'user_demo';
      clerk.reverified = false;
      expect((await call('GET', '/api/user-restore')).body).toMatchObject({ enabled: true, demo: true });
      const { source, p, plan } = await planned(OLD.text);
      for (const [method, body] of [
        ['POST', startBody(p, plan, source, newUserRestoreId(), null)],
        ['POST', { action: 'empty', confirm: 'empty my account' }],
        ['DELETE', { restore_id: newUserRestoreId(), confirm: true }],
      ] as const) {
        const res = await call(method, '/api/user-restore', body);
        expect(res.status).toBe(403);
        expect(res.body.error).toContain('demo account');
      }
      expect(await userRestoreStore.get(ctx)).toBeNull();
    } finally {
      process.env = saved;
      clerk.signedIn = null;
      clerk.reverified = true;
    }
  });

  test('with Clerk, a sign-in that isn’t fresh is asked to confirm it’s them first', async () => {
    const saved = { ...process.env };
    try {
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_placeholder';
      process.env.CLERK_SECRET_KEY = 'sk_test_placeholder';
      process.env.CLERK_ALLOWED_USER_IDS = 'user_me';
      await fake.hset(testKey('owners'), { user_me: TEST_CTX.container });
      clerk.signedIn = 'user_me';
      clerk.reverified = false;
      const { source, p, plan } = await planned(OLD.text);
      const body = startBody(p, plan, source, newUserRestoreId(), null);
      const stale = await call('POST', '/api/user-restore', body);
      expect(stale.status).toBe(403);
      expect(stale.body.clerk_error).toMatchObject({ type: 'forbidden', reason: 'reverification-error' });
      clerk.reverified = true;
      expect((await call('POST', '/api/user-restore', body)).status).toBe(200);
    } finally {
      process.env = saved;
      clerk.signedIn = null;
      clerk.reverified = true;
    }
  });

  test('the scan says whom the account shares with already, and what: they would see what comes back', async () => {
    const saved = { ...process.env };
    try {
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_placeholder';
      process.env.CLERK_SECRET_KEY = 'sk_test_placeholder';
      process.env.CLERK_ALLOWED_USER_IDS = 'user_me,user_pat';
      await fake.hset(testKey('owners'), { user_me: TEST_CTX.container, user_pat: OTHER.container });
      await fake.hset(testKey('containers'), { [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-01-01T00:00:00.000Z' }) });
      const { createInvite, acceptInvite, saveConnection } = await import('@/lib/sharing');
      const { token } = await createInvite('user_me', { theirLabel: 'Pat' });
      const { id } = await acceptInvite('user_pat', token, 'Me');
      await saveConnection(ctx, 'user_me', id, { views: { net_worth: { detail: 'total', accounts: false } } });
      clerk.signedIn = 'user_me';
      const scan = await call('GET', '/api/user-restore?scan=1');
      expect(scan.status).toBe(200);
      expect(scan.body.sharing).toEqual([{ label: 'Pat', kinds: ['net_worth'], accounts: 0 }]);
      expect(scan.body.scan).toMatchObject({ empty: true });
    } finally {
      process.env = saved;
      clerk.signedIn = null;
    }
  });

  test('a protected file, opened in the page with its passphrase, is brought back; a wrong passphrase opens nothing', async () => {
    const { protectFile } = await import('@/lib/protected-download');
    const { openFile } = await import('@/components/OpenProtectedDownload');
    const { blobSource } = await import('@/lib/user-restore/file');
    const plain = new TextEncoder().encode(OLD.text);
    const file = await protectFile({ filename: 'nya.json', chunks: () => [plain] }, plain.length, 'correct horse battery', { workFactor: 10 });
    const sealed = new Blob([...file.chunks()] as BlobPart[]);
    expect(await openFile(sealed, 'wrong horse', () => {}).catch((err) => err)).toBeInstanceOf(Error);
    const opened = await openFile(sealed, 'correct horse battery', () => {});
    const record = await restoreAll(blobSource(opened, true) as Source);
    expect(record.source).toEqual({ exported_at: EXPORTED.toISOString(), version: 2, bytes: plain.length, protected: true });
  });
});

describe('interrupted', () => {
  test('stopped part way: unfinished, totals held, nothing sent out; resumed with the same file, only what is left is sent; another file is refused', async () => {
    const { source, c, p, plan } = await planned(OLD.text);
    const record = await startRestore(fetcher, startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
    sent.failAfter = 5;
    const stopped = await sendBatches(source, c, record, { fetcher, plan }).catch((err) => err);
    expect(stopped).toBeInstanceOf(RestoreStopped);
    expect(stopped.status).toBeNull();
    const state = (await call('GET', '/api/user-restore')).body.record;
    expect(state).toMatchObject({ status: 'writing', done: 5 });
    expect(await restoreUnfinished(ctx)).toBe(true);
    expect((await hold()).unfinished).toBe(true);
    expect((await call('POST', `/api/user-restore/batch?restore_id=${record.id}&finish=1`)).status).toBe(409);

    // Another file: what it has as the plan has it is written; the first
    // batch that isn't the plan's is refused.
    const changed = OLD.text.replace('"Plumber"', '"Electrician"');
    const other = sourceOf(changed);
    sent.failAfter = Infinity;
    const differs = plan.batches.findIndex((b) => b.part === 'store:manual-transactions');
    expect(differs).toBeGreaterThan(5);
    const refused = await sendBatches(other, await collect(other), state, { fetcher }).catch((err) => err);
    expect(refused).toBeInstanceOf(RestoreStopped);
    expect(refused.answer).toMatchObject({ mismatch: true, done: differs });

    // The same file, read again from the start, as a resume does.
    sent.batches = 0;
    const again = sourceOf(OLD.text, 999);
    await sendBatches(again, await collect(again), { ...state, done: differs }, { fetcher });
    expect(sent.batches).toBe(plan.batches.length - differs);
    const finished = await finishRestore(fetcher, record.id);
    expect(finished.status).toBe('finished');
    expect(await restoreUnfinished(ctx)).toBe(false);
    expect(differing(JSON.parse(OLD.text), JSON.parse(await downloadText(new Date())))).toContain('restored-transactions');
  });
});

describe('undo and emptying', () => {
  test('undo empties the account again, keeping the machinery; refused while a bank is connected, and past its days', async () => {
    const record = await restoreAll(OLD.text);
    await saveItem(ctx, { item_id: 'item_new', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'access-sandbox-b') } as never);
    const refused = await call('DELETE', '/api/user-restore', { restore_id: record.id, confirm: true, password: 'hunter2' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('Disconnect Chase first');
    await fake.hdel(ctxKey('plaid:items'), 'item_new');

    const full = await userRestoreStore.get(ctx);
    await userRestoreStore.set(ctx, { ...full!, undo_until: new Date(Date.now() - 1000).toISOString() });
    expect((await call('DELETE', '/api/user-restore', { restore_id: record.id, confirm: true, password: 'hunter2' })).body.error).toContain('can no longer be undone');
    await userRestoreStore.set(ctx, full!);

    expect((await call('DELETE', '/api/user-restore', { restore_id: record.id, confirm: true, password: 'nope' })).status).toBe(403);
    const undone = await call('DELETE', '/api/user-restore', { restore_id: record.id, confirm: true, password: 'hunter2' });
    expect(undone).toEqual({ status: 200, body: { undone: true } });
    const scan = await scanAccount(ctx);
    expect(scan).toMatchObject({ empty: true, record: false, found: [] });
    // The counters stay (machinery): the start and each undo past the
    // sign-in counted.
    expect((await startsCount.read(ctx)).count).toBe(4);
    expect(await restoreUnfinished(ctx)).toBe(false);
  });

  test('an undo stopped part way stays undoing, refusing batches and holding totals, and running it again finishes it', async () => {
    const { source, c, p, plan } = await planned(OLD.text);
    const record = await startRestore(fetcher, startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
    sent.failAfter = 3;
    await sendBatches(source, c, record, { fetcher, plan }).catch(() => null);
    const { undoRestore } = await import('@/lib/user-restore/undo');
    // A batch that passed its last look at the record as the undo began lands
    // during the pause: the second sweep takes it.
    const landed = await undoRestore(ctx, record.id, {
      userId: null,
      sleep: async () => {
        await fake.hset(ctxKey('txn-vendor-renames'), { late: 'x' });
        throw new Error('stopped');
      },
    }).catch((err) => err);
    expect(landed).toBeInstanceOf(Error);
    expect((await userRestoreStore.get(ctx))!.status).toBe('undoing');
    expect(await restoreUnfinished(ctx)).toBe(true);
    sent.failAfter = Infinity;
    const refused = await sendBatches(source, c, { ...record, done: 3 }, { fetcher, plan }).catch((err) => err);
    expect(refused.status).toBe(409);
    expect(refused.problem).toBe('This restore is being undone.');
    await undoRestore(ctx, record.id, { userId: null, sleep: async () => {} });
    expect(await scanAccount(ctx)).toMatchObject({ empty: true, found: [] });
  });

  test('emptying: the typed words, after a fresh sign-in, refused while a restore is unfinished; everything but the machinery goes', async () => {
    const { source, c, p, plan } = await planned(OLD.text);
    const record = await startRestore(fetcher, startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
    sent.failAfter = 3;
    await sendBatches(source, c, record, { fetcher, plan }).catch(() => null);
    expect((await call('POST', '/api/user-restore', { action: 'empty', confirm: 'empty it', password: 'hunter2' })).status).toBe(400);
    const unfinished = await call('POST', '/api/user-restore', { action: 'empty', confirm: 'empty my account', password: 'hunter2' });
    expect(unfinished.status).toBe(409);
    expect(unfinished.body.error).toContain('undo it instead');

    fake.reset();
    forgetEpochs();
    await registerTestContainer(fake);
    await seedOld(fake, ctx);
    await fake.hdel(ctxKey('plaid:items'), 'item_chase');
    expect((await call('POST', '/api/user-restore', { action: 'empty', confirm: 'empty my account', password: 'nope' })).status).toBe(403);
    expect(await call('POST', '/api/user-restore', { action: 'empty', confirm: 'empty my account', password: 'hunter2' })).toEqual({ status: 200, body: { emptied: true } });
    expect(await scanAccount(ctx)).toMatchObject({ empty: true, found: [], settings: [] });
  });
});

describe('isolation', () => {
  test('everything is written in the account’s own container: another one is untouched, and nothing lands outside', async () => {
    await seedOld(fake, OTHER);
    const before = snapshot(ctxKey('', OTHER));
    await restoreAll(OLD.text);
    expect(snapshot(ctxKey('', OTHER))).toEqual(before);
    expect(unscopedDataKeys(fake)).toEqual([]);
  });
});
