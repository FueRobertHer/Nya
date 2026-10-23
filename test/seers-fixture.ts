// What test/inventory-seers.test.ts adds to the API's fixture
// (test/api-fixture.ts seedPerson), so that every kind Nya keeps has
// something stored before the reads are recorded: a read that sits behind a
// branch only data opens (an account link, a restored bank, a file imported
// into a linked account, an account let go from SimpleFIN) is then taken, and
// the kinds' lists of who else can see them are held to it. Written through
// the app's routes and the stores' own writes, so every value is one the app
// keeps. Callers mock lib/storage and lib/plaid first, sign the owner in
// (`asOwner`), and pass a SimpleFIN double's transport.

import { ctxKey, type FakeRedis } from './fake-redis';
import { FakeSimplefin, fakeAccount } from './simplefin-fake';
import { bankTxn } from './restore-fixture';
import type { Ctx } from '@/lib/containers';

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const compact = (day: string) => day.replaceAll('-', '');

/** One file's rows as OFX, a checking statement over `from`..`to`. */
function ofx(rows: { fitid: string; day: string; amount: number; name: string }[], from: string, to: string, acct: string) {
  const list = rows
    .map((t) => `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${compact(t.day)}120000[-5:EST]</DTPOSTED><TRNAMT>${t.amount.toFixed(2)}</TRNAMT><FITID>${t.fitid}</FITID><NAME>${t.name}</NAME></STMTTRN>`)
    .join('\n');
  return `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>325081403</BANKID><ACCTID>${acct}</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>${compact(from)}</DTSTART><DTEND>${compact(to)}</DTEND>\n${list}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

function upload(path: string, meta: Record<string, unknown>, file: string, name: string): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(file) as Uint8Array<ArrayBuffer>]), name);
  form.set('meta', JSON.stringify({ file_name: name, ...meta }));
  return new Request(`http://localhost/api/${path}`, { method: 'POST', body: form });
}

async function posted(path: string, meta: Record<string, unknown>, file: string, name: string): Promise<{ status: number; body: any }> {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res: Response = await mod.POST(upload(path, meta, file, name));
  return { status: res.status, body: await res.json() };
}

/** Throws with what the route said, so a seeding that went wrong is loud. */
function ok(what: string, res: { status: number; body: any }) {
  if (res.status !== 200) throw new Error(`Seeding ${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * Everything seedPerson leaves empty (see the header). `route` calls an app
 * route as the signed-in owner; `server` is a SimpleFIN double already
 * serving this process's transport.
 */
export async function seedEveryKind(
  fake: FakeRedis,
  ctx: Ctx,
  route: (path: string, method: string, body?: unknown, query?: string) => Promise<{ status: number; body: any }>,
  server: FakeSimplefin,
  now: number
): Promise<void> {
  const { encrypt } = await import('@/lib/crypto');
  const { encodeJsonBlob } = await import('@/lib/blob');
  const enc = (v: unknown) => encrypt(ctx, typeof v === 'string' ? v : JSON.stringify(v));
  const k = (name: string) => ctxKey(name, ctx);
  const at = new Date(now).toISOString();
  const today = dayOf(now);
  const ago = (n: number) => dayOf(now - n * DAY);

  // ---- An earlier checking account at Chase, linked to today's: what it
  // carries across (categories, notes and tags, imported pairs), and a
  // suggestion declined.
  await fake.hset(k('accounts:directory'), {
    acc_old_chk: await enc({ item_id: 'item_gone', institution_id: 'ins_3', institution_name: 'Chase', name: 'Old Checking', official_name: null, mask: '0000', type: 'depository', subtype: 'checking', persistent_account_id: null, first_seen: ago(700), last_seen: ago(400) }),
  });
  const { linkAccounts } = await import('@/lib/links');
  await linkAccounts(ctx, 'acc_old_chk', 'acc_chk', {});
  await fake.hset(k('account-links:dismissed'), { 'acc_x>acc_chk': at });
  await fake.hset(k('txn-category-carry'), { acc_old_chk: await enc({ [`acc_old_chk|${ago(450)}|725|bakery 12`]: 'Bread' }) });
  const { carriedAnnotationStore } = await import('@/lib/txn-annotations');
  await carriedAnnotationStore.set(ctx, 'acc_old_chk', { version: 1, rows: { [`acc_old_chk|${ago(450)}|725|bakery 12`]: { note: 'carried note' } } } as never);
  const { carriedTwinsStore, importedTwinsStore, importedTxnStore } = await import('@/lib/history-import/store');
  await carriedTwinsStore.set(ctx, 'acc_old_chk', { version: 1, twins: { 'imported-txn:00000000-0000-4000-8000-0000000000c1': `acc_old_chk|${ago(450)}|725|bakery 12` } });

  // ---- The older stores' other layers and markers.
  await fake.hset(k('history:accounts:est:ext'), { [ago(400)]: await enc({ acc_ira: 15000 }) });
  await fake.hset(k('history:accounts:est:flatd'), { [ago(399)]: await enc({ manual_house: 300000 }) });
  await fake.set(k('history:accounts:est:flat'), await enc({ manual_house: 300000 }));
  await fake.hset(k('plaid:new-accounts'), { item_chase: at });
  await fake.hset(k('accounts:vanished'), { acc_save: await enc({ item_id: 'item_chase', since: ago(2) }) });
  await fake.set(k('txns-blocked:item_chase'), JSON.stringify({ at, chars: 9_000_000 }));
  await fake.set(k('txns-unsaved:item_chase'), JSON.stringify({ at }));
  await fake.set(
    k('invtxns:item_broker'),
    await encodeJsonBlob(ctx, { schema_version: 1, txns: {}, securities: {}, accounts: {}, coverage: {}, synced_at: at, verified_at: at })
  );
  await fake.set(k('sessions:epoch'), '1');

  // ---- Categories, budgets by month and the rest of the budgets.
  const budgets = ok('budgets', await route('budgets', 'GET'));
  ok('a budget save', await route('budgets', 'PUT', { budget_set: budgets.budget_set, month: today.slice(0, 7) }));
  const { taxonomyStore } = await import('@/lib/category-store');
  const taxonomy = (await taxonomyStore.get(ctx))!;
  const food = taxonomy.categories.find((c) => c.provider_keys.some((p) => p.key === 'FOOD_AND_DRINK'))!;
  const { incomeCarryoverStore } = await import('@/lib/budget-months-store');
  await incomeCarryoverStore.set(ctx, { version: 1, enabled: true, start: today.slice(0, 7) });
  ok('a runway scenario', await route('runway-scenarios', 'POST', { scenario: { name: 'Leaner months', months: 6, lower_by: 0, currency: null, income_until: null, planned: true, leave_out_one_offs: false } }));

  // ---- Settings, each as the app keeps it.
  const { allocationSettingsStore } = await import('@/lib/allocation-settings');
  await allocationSettingsStore.set(ctx, { v: 1, buckets: [], funds: [{ ticker: 'VFIFX', split: { 'us-stocks': 60, bonds: 40 } }], accounts: [], target: null } as never);
  const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
  await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'USD', changes: [{ on: ago(10), from: null, to: 'USD' }] } as never);
  const { firePlanStore } = await import('@/lib/fire-plan');
  const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
  await firePlanStore.set(ctx, DEFAULT_PLAN);
  const { plannedStore } = await import('@/lib/planned-store');
  const { EMPTY_PLANNED } = await import('@/lib/planned');
  await plannedStore.set(ctx, EMPTY_PLANNED);
  const { reportSettingsStore } = await import('@/lib/report/store');
  await reportSettingsStore.set(ctx, { v: 1, marked: ['food and drink'] });
  const { reviewSettingsStore, approvalStore } = await import('@/lib/review-store');
  await reviewSettingsStore.set(ctx, { version: 1, on: true, since: ago(30), updated_at: at });
  const { vendorDefaultsStore } = await import('@/lib/vendor-default-store');
  const { VENDOR_DEFAULTS_VERSION } = await import('@/lib/vendor-defaults');
  await vendorDefaultsStore.set(ctx, { version: VENDOR_DEFAULTS_VERSION, vendors: [] } as never);
  const { weeklySettingStore, weeklyStateStore } = await import('@/lib/weekly-summary/store');
  await weeklySettingStore.set(ctx, { v: 1, enabled: true, weekday: 1, time_zone: 'UTC', updated_at: at });
  await weeklyStateStore.set(ctx, { v: 1, key: Buffer.alloc(32, 1).toString('base64url'), sent: null, sent_at: null } as never);

  // ---- Rules, tags, and what was said about transactions.
  const { tagStore } = await import('@/lib/tags');
  await tagStore.set(ctx, { version: 1, tags: [{ id: 'tag1', name: 'Trip', color: 'blue', created_at: at }] });
  const { rulesStore } = await import('@/lib/rules');
  await rulesStore.set(ctx, {
    version: 1,
    rules: [{ id: 'rule1', enabled: true, priority: 1, conditions: [{ field: 'name', op: 'contains', value: 'coffee' }], actions: { set_category: food.id }, created_at: at, updated_at: at }],
  } as never);
  const { groupStore } = await import('@/lib/groups');
  await groupStore.set(ctx, 'g1', { version: 1, name: 'Weekend', category_id: food.id, members: ['t_card', 't_coffee'], date: today, currency: 'USD', created_at: at, updated_at: at } as never);
  const { splitStore } = await import('@/lib/splits');
  await splitStore.set(ctx, 't_rent', {
    version: 1,
    amount: 1200,
    currency: 'USD',
    parts: [
      { id: 'p1', amount: 1000, category_id: food.id },
      { id: 'p2', amount: 200, category_id: food.id, note: 'parking' },
    ],
    updated_at: at,
  } as never);
  await approvalStore.set(ctx, 't_coffee', { version: 1, approved_at: at, amount: 5.5, currency: 'USD', category_id: food.id, name: 'Blue Bottle' } as never);
  const { timelineNotesStore } = await import('@/lib/timeline-notes');
  await timelineNotesStore.set(ctx, 'note1', { date: ago(20), text: 'Moved house', kind: 'user', created_at: at });
  const { lifecycleStore } = await import('@/lib/lifecycle');
  await lifecycleStore.set(ctx, 'acc_save', { lifecycle: { state: 'active' }, type: null, label: { name: '', institution: '', mask: null }, item_id: null, set_at: at } as never);

  // ---- A bank brought back from a download, its account linked to today's
  // checking, so its rows count as the account's own.
  const { restoredAccountsStore, restoredTxnStore, restoredInvestmentsStore, userRestoreStore } = await import('@/lib/user-restore/store');
  const { restoredId } = await import('@/lib/user-restore/ids');
  const restore_id = 'user-restore:7f0c2a1e-4b3d-4c5e-8f6a-9b0c1d2e3f4a';
  await userRestoreStore.set(ctx, {
    version: 1,
    id: restore_id,
    status: 'finished',
    started_at: ago(5) + 'T09:00:00.000Z',
    finished_at: ago(5) + 'T09:05:00.000Z',
    undo_until: dayOf(now + 2 * DAY) + 'T09:05:00.000Z',
    last_batch_at: ago(5) + 'T09:04:00.000Z',
    source: { exported_at: ago(6) + 'T12:00:00.000Z', version: 2, bytes: 20_000, protected: false },
    plan: { digest: 'a'.repeat(64), batches: [{ part: 'store:tags', count: 1, digest: 'b'.repeat(64) }] },
    done: 1,
    brought: { 'store:tags': 1 },
    left_out: {},
    without: {},
    history: null,
    earlier: [],
  } as never);
  const bankRow = bankTxn({ transaction_id: 'rt_1', account_id: 'acc_restored', amount: 30, date: ago(500), authorized_date: null, datetime: null, name: 'OLD BAKERY', merchant_name: null, merchant_entity_id: null });
  await restoredAccountsStore.set(ctx, 'acc_restored', {
    version: 1,
    restore_id,
    item_id: 'item_restored',
    institution_id: 'ins_3',
    institution_name: 'Chase',
    name: 'Restored Checking',
    mask: '7777',
    type: 'depository',
    subtype: 'checking',
    currency: 'USD',
    rows: { first: ago(500), last: ago(500), count: 1, books: 1 },
    downloaded: ago(6),
    restored_at: ago(5) + 'T09:05:00.000Z',
  });
  await restoredTxnStore.set(ctx, 'acc_restored.1', { version: 1, account_id: 'acc_restored', part: 1, rows: [{ id: restoredId('rt_1'), account_id: 'acc_restored', import_id: restore_id, bank: bankRow, created_at: ago(5) + 'T09:05:00.000Z' }] } as never);
  await restoredInvestmentsStore.set(ctx, 'item_restored.coverage', { version: 1, kind: 'coverage', item_id: 'item_restored', coverage: [{ account_id: 'acc_restored_ira', from: ago(600), through: ago(500) }] });
  // Listed in the directory, as a restore lists what it brought back
  // (lib/user-restore/restored.ts), and linked to today's checking.
  await fake.hset(k('accounts:directory'), {
    acc_restored: await enc({ item_id: 'item_restored', institution_id: 'ins_3', institution_name: 'Chase', name: 'Restored Checking', official_name: null, mask: '7777', type: 'depository', subtype: 'checking', persistent_account_id: null, first_seen: ago(500), last_seen: ago(6) }),
  });
  await linkAccounts(ctx, 'acc_restored', 'acc_chk', {});

  // ---- A file imported into a manual account, and one into the linked
  // checking account (its own store of imported rows, with the bank row that
  // stands for one of them), and another app's export.
  ok('a manual import', await posted('import', { action: 'import', account_id: 'manual_wallet', options: {} }, ofx([{ fitid: 'W1', day: ago(9), amount: -12, name: 'FARMERS MARKET' }], ago(30), ago(1), '0000000001'), 'wallet.ofx'));
  const file = ofx([{ fitid: 'H_old', day: ago(300), amount: -100, name: 'OLD STORE' }, { fitid: 'H_older', day: ago(310), amount: 50, name: 'OLD DEPOSIT' }], ago(330), ago(290), '0009991111');
  const review = ok('a history preview', await posted('history-import', { action: 'preview', account_id: 'acc_chk' }, file, 'chase.ofx'));
  ok('a history import', await posted('history-import', { action: 'import', account_id: 'acc_chk', review: review.preview.review }, file, 'chase.ofx'));
  const book = (await importedTxnStore.get(ctx, 'acc_chk'))!;
  await importedTwinsStore.set(ctx, 'item_chase', { version: 1, twins: { [book.rows[0].id]: 't_coffee' } });
  const { markDrawStale } = await import('@/lib/history-import/extend');
  await markDrawStale(ctx);
  const monarch = ['Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags', `${ago(320)},Corner Shop,Groceries,Checking,CORNER SHOP,,-7.25,`].join('\n');
  const migrationId = `app-import:${crypto.randomUUID()}`;
  const answers = { accounts: { Checking: { to: 'linked', id: 'acc_chk' } } };
  const appReview = ok('an app preview', await posted('migration', { action: 'preview', ...answers }, monarch, 'export.csv'));
  ok('an app import', await posted('migration', { action: 'import', review: appReview.preview.review, migration_id: migrationId, ...answers }, monarch, 'export.csv'));

  // ---- A SimpleFIN connection keeping a checking account up to date, and an
  // account let go from it.
  const { connect, trackAccounts, releaseAccounts } = await import('@/lib/connectors/manage');
  const { connectorAccountsStore } = await import('@/lib/connectors/store');
  const posted_at = Math.floor((now - 2 * DAY) / 1000);
  server.accounts = [
    fakeAccount({ id: 'SF_CHK', name: 'Credit Union Checking', balance: '800.00', 'balance-date': posted_at, transactions: [{ id: 's1', posted: posted_at, amount: '-9.99', description: 'STREAMING' }] }),
    fakeAccount({ id: 'SF_SAV', name: 'Credit Union Savings', balance: '50.00', 'balance-date': posted_at, transactions: [] }),
  ];
  const { connection_id } = await connect(ctx, 'simplefin', server.setupToken(`t${Math.random()}`), now);
  await trackAccounts(ctx, connection_id, [
    { remote_id: 'SF_CHK', type: 'depository' },
    { remote_id: 'SF_SAV', type: 'depository' },
  ], now);
  const savings = [...(await connectorAccountsStore.getAll(ctx)).values()].find((a) => a.remote_id === 'SF_SAV')!;
  // Let go and removed, and no longer followed: an account the API still
  // lists from its history, as that connector's.
  await releaseAccounts(ctx, [savings.account_id], false, now);
  const { markEnded } = await import('@/lib/lifecycle');
  await markEnded(ctx, savings.account_id, { state: 'untracked', from: ago(1) }, { type: 'depository', label: { name: 'Credit Union Savings', institution: 'Credit Union', mask: null }, item_id: null }, now);

  // Last, since the steps above clear them: the estimate's own records, and
  // a copy of what the dashboard shows.
  await fake.set(k('history:backfill-done'), '7');
  await fake.set(k('history:backfill-pending'), '1');
  const { writeCache, CacheKey } = await import('@/lib/cache');
  await writeCache(ctx, Object.values(CacheKey)[0], { cached: true });
}
