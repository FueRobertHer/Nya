import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, ctxKey, testKey, TEST_CONTAINER, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// Reports, through the routes and the real read layer: the report a person's
// stored data gives (app/api/reports, lib/report/read.ts), its totals held to
// the read-only API's for the same period, a gap from stored data for every
// kind, the empty period, the bounds, the CSV, other people's data never in
// it, and Plaid never called; and the marked categories' setting on the
// storage seam (app/api/report-settings, lib/report/store.ts): validation,
// the seam's errors, each person's own, and in the data download.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Plaid must never be reached: a report reads only what is stored.
const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
        return async () => {
          throw new Error('Plaid must not be called by a report');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, OTHER, daysAgo, txn, seedPerson, seedOther, connectWithoutTransactions } = await import('./api-fixture');
const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { saveManualAccount } = await import('@/lib/manual');
const { setAccountHidden } = await import('@/lib/hidden');
const { setExcluded } = await import('@/lib/txn-annotations');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { syncsStore, noticesStore } = await import('@/lib/connection-records');
const { readSpending } = await import('@/lib/api-read');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const { gapSentences, statusHeadline } = await import('@/lib/report/words');
const { reportSettingsStore } = await import('@/lib/report/store');
const { StoredDataUnreadableError, UnreadableValueError } = await import('@/lib/repo');
const { declaredStore } = await import('@/lib/stores');
const { classify } = await import('@/lib/reencrypt');
const { collectUserData, buildUserExport, declaredSections } = await import('@/lib/user-export');
const { forgetEpochs } = await import('@/lib/sessions');
const reports = await import('@/app/api/reports/route');
const settingsRoute = await import('@/app/api/report-settings/route');

const SETTINGS_KEY = ctxKey('report-settings');
const env = { ...process.env };

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  clerk.signedIn = null;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  plaidTouched.length = 0;
});
afterEach(() => {
  process.env = { ...env };
  expect(plaidTouched).toEqual([]);
});

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await f();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};
const getReport = (query: string) => reports.GET(new Request(`https://nya.test/api/reports?${query}`));
const put = (body: unknown) => settingsRoute.PUT(new Request('https://nya.test/api/report-settings', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));

const NY = 'America/New_York';
/** 2026-10-10, mid-morning in New York: when these reports are made. */
const NOW = Date.parse('2026-10-10T14:00:00.000Z');
const RECENT = '2026-10-10T12:00:00.000Z';
const year2025 = () => {
  const p = resolvePeriod({ kind: 'year', year: 2025 }, NY, NOW);
  if ('error' in p) throw new Error(p.error);
  return p;
};
const store = (txns: ReturnType<typeof txn>[], over: Record<string, unknown> = {}) =>
  encodeJsonBlob({
    schema_version: 2,
    cursor: 'c',
    accounts: { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } },
    txns: Object.fromEntries(txns.map((t) => [t.transaction_id, t])),
    synced_at: RECENT,
    ...over,
  });
const on = (date: string, id: string, account: string, amount: number, over: Record<string, unknown> = {}) => txn(id, account, 0, amount, { date, ...over });
/** A connected account, as the directory keeps it, first seen on `first_seen`. */
const seenFrom = (item_id: string, institution_name: string, first_seen: string) =>
  encrypt(JSON.stringify({ provider: 'plaid', item_id, institution_id: null, institution_name, name: 'Checking', official_name: null, mask: '3', type: 'depository', subtype: null, persistent_account_id: null, first_seen, last_seen: '2026-10-09' }));

/**
 * A year with every kind of gap, from stored data: Chase is fine; Citi
 * stopped syncing in September and needs reconnecting; Ally is still
 * importing; Amex's history begins in May; Acme CU's bank account Plaid won't
 * give transactions for; Vanguard holds investments only; Wells Fargo was
 * removed in June; a manual account's book can't be read. And a hidden
 * account, an exclusion, rows entered by hand and imported, and two marked
 * categories.
 */
const CITI = { institution_name: 'Citi', account_name: 'Double Cash' };

async function seedYear() {
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', institution_id: 'ins_3', encrypted_access_token: await encrypt('a1') });
  await fake.set(
    ctxKey('txns:item_chase'),
    await store([
      on('2023-05-01', 'c_old', 'acc_chk', 9),
      on('2025-01-15', 'c_pay', 'acc_chk', -4000, { category: 'income' }),
      on('2025-02-03', 'c_doc', 'acc_chk', 150, { category: 'medical' }),
      on('2025-03-09', 'c_tv', 'acc_chk', 900, { category: 'general merchandise' }),
      on('2025-04-10', 'c_transfer', 'acc_chk', 500, { category: 'transfer out', transaction_code: 'transfer' }),
      on('2025-06-20', 'c_hidden', 'acc_save', 777, { name: 'HIDDEN-ACCOUNT-ROW', category: 'medical' }),
      on('2026-01-05', 'c_next_year', 'acc_chk', 66, { category: 'medical' }),
    ])
  );
  await setAccountHidden(ctx, 'acc_save', 'depository', true);
  await setExcluded(ctx, 'c_tv', true);

  await saveItem(ctx, { item_id: 'item_citi', institution_name: 'Citi', encrypted_access_token: await encrypt('a2') });
  await fake.set(ctxKey('txns:item_citi'), await store([on('2024-02-02', 'ci_1', 'acc_ci', 20, CITI), on('2025-08-30', 'ci_2', 'acc_ci', 45, { ...CITI, category: 'medical' })], { synced_at: '2025-09-12T15:00:00.000Z' }));
  await syncsStore.set(ctx, 'item_citi', { at: '2025-09-12T15:00:00.000Z' });
  await noticesStore.set(ctx, 'item_citi', { episode: 'e1', since: '2025-09-13T13:00:00.000Z', state: 'needs_reauth', notified_at: null, reminded_at: null });

  await saveItem(ctx, { item_id: 'item_ally', institution_name: 'Ally', encrypted_access_token: await encrypt('a3') });
  await fake.set(ctxKey('txns:item_ally'), await store([on('2025-07-01', 'al_1', 'acc_al', 30, { institution_name: 'Ally' })], { importing: true }));

  await saveItem(ctx, { item_id: 'item_amex', institution_name: 'Amex', encrypted_access_token: await encrypt('a4') });
  await fake.set(ctxKey('txns:item_amex'), await store([on('2025-05-05', 'am_1', 'acc_am', 12.5, { institution_name: 'Amex', category: 'food and drink' })]));

  await connectWithoutTransactions(fake, { item_id: 'item_acme', name: 'Acme CU', accounts: [{ account_id: 'acc_acme', type: 'depository' }], refused: { code: 'PRODUCTS_NOT_SUPPORTED' } });
  await connectWithoutTransactions(fake, { item_id: 'item_vg', name: 'Vanguard', accounts: [{ account_id: 'acc_vg', type: 'investment' }] });

  const entry = (item_id: string, institution_name: string, first_seen: string, last_seen: string) =>
    encrypt(JSON.stringify({ provider: 'plaid', item_id, institution_id: null, institution_name, name: 'Checking', official_name: null, mask: '9', type: 'depository', subtype: null, persistent_account_id: null, first_seen, last_seen }));
  await fake.hset(ctxKey('accounts:directory'), {
    acc_wells: await entry('item_wells', 'Wells Fargo', '2024-01-10', '2025-06-30'),
    // A live connection's account: not removed.
    acc_chk: await entry('item_chase', 'Chase', '2023-05-01', '2026-10-10'),
  });

  const now = new Date(NOW).toISOString();
  await saveManualAccount(ctx, { account_id: 'manual_wallet', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 40, updated_at: '2026-09-30T18:00:00.000Z' });
  await saveManualAccount(ctx, { account_id: 'manual_safe', name: 'Safe', institution_name: 'Home', type: 'depository', subtype: null, balance: 500, updated_at: '2026-01-02T18:00:00.000Z' });
  const manual = (id: string, date: string, amount: number, source: string, over: Record<string, unknown> = {}) => ({
    id: `manual-txn:${id}`,
    account_id: 'manual_wallet',
    date,
    amount,
    currency: 'USD',
    name: id,
    category: 'medical',
    note: null,
    source,
    source_id: source === 'manual' ? null : `fitid-${id}`,
    created_at: now,
    updated_at: now,
    ...over,
  });
  await manualTxnStore.set(ctx, 'manual_wallet', {
    version: 1,
    rows: [
      manual('5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', '2025-03-03', 25, 'manual', { note: 'co-pay' }),
      manual('6b1d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e', '2025-11-11', 60, 'import:ofx'),
    ],
  });
  await fake.hset(ctxKey('manual-transactions'), { manual_safe: 'damaged-bytes-not-ciphertext-at-all' });
  await reportSettingsStore.set(ctx, { v: 1, marked: ['medical', 'charity'] });
}

describe('a report from stored data', () => {
  test('the year’s totals by the app’s rules, the rows entered by hand and imported among them, hidden and excluded ones left out', async () => {
    await seedYear();
    const r = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(r.currency).toBe('USD');
    // In: Chase's pay. Out: Chase's doctor, Citi's August row, Ally's July
    // row, Amex's May row, and the wallet's two. Not the transfer, the
    // excluded TV, the hidden account's row, or a row from 2023 or 2026.
    expect(r.totals.money_in).toBe(4000);
    expect(r.totals.money_out).toBe(150 + 45 + 30 + 12.5 + 25 + 60);
    expect(r.totals).toMatchObject({ excluded: 1, transfers: 1, exclusion_unknown: 0 });
    expect(JSON.stringify(r)).not.toContain('HIDDEN-ACCOUNT-ROW');
    expect(r.money_out.find((c) => c.category === 'medical')).toEqual({ category: 'medical', amount: 280, transactions: 4 });
    expect(r.caveats).toMatchObject({ hidden: true, marked: 'set', not_over: false, health_unread: false });
    // The marked group and its appendix: where each row came from.
    expect(r.marked!.categories).toEqual([
      { category: 'medical', key: 'medical', money_in: 0, money_out: 280, transactions: 4 },
      { category: 'charity', key: 'charity', money_in: 0, money_out: 0, transactions: 0 },
    ]);
    expect(r.appendix!.rows.map((x) => [x.date, x.institution, x.source])).toEqual([
      ['2025-02-03', 'Chase', 'plaid'],
      ['2025-03-03', 'Cash', 'manual'],
      ['2025-08-30', 'Citi', 'plaid'],
      ['2025-11-11', 'Cash', 'import:ofx'],
    ]);
    expect(r.appendix!.rows[1].note).toBe('co-pay');
    // Manual accounts with their last update, every institution listed.
    // Each with its transactions in the period; never "none" for one whose rows couldn't be read.
    expect(r.manual).toEqual([
      { account_id: 'manual_wallet', name: 'Wallet', institution: 'Cash', type: 'depository', updated_at: '2026-09-30T18:00:00.000Z', transactions: 2 },
      { account_id: 'manual_safe', name: 'Safe', institution: 'Home', type: 'depository', updated_at: '2026-01-02T18:00:00.000Z', transactions: null },
    ]);
    expect(r.institutions.map((i) => i.institution_name)).toEqual(['Acme CU', 'Ally', 'Amex', 'Chase', 'Citi', 'Vanguard']);
    expect(r.institutions.find((i) => i.institution_name === 'Citi')).toMatchObject({
      synced_at: '2025-09-12T15:00:00.000Z',
      last_ok_at: '2025-09-12T15:00:00.000Z',
      first_date: '2024-02-02',
      problem: { state: 'needs_reauth', since: '2025-09-13T13:00:00.000Z' },
    });
    expect(r.institutions.find((i) => i.institution_name === 'Chase')!.first_date).toBe('2023-05-01');
    expect(r.data_as_of).toBe('2025-09-12T15:00:00.000Z');
  });

  test('a gap for every kind, read from what is stored, in the app’s words', async () => {
    await seedYear();
    const r = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(r.gaps.map((g) => [g.kind, g.institution])).toEqual([
      ['removed', 'Wells Fargo'],
      ['refused', 'Acme CU'],
      ['stale', 'Citi'],
      ['importing', 'Ally'],
      ['begins_late', 'Amex'],
      ['unreadable', null],
    ]);
    expect(gapSentences(r.gaps, (d) => d)).toEqual([
      'Wells Fargo (Checking ••9) was removed on or after 2025-06-30, and the transactions it brought in went with it, so this report may be missing some of them.',
      'Doesn’t include the bank or card accounts at Acme CU: Plaid doesn’t provide their transactions, so this report may be incomplete.',
      'Citi hasn’t synced since 2025-09-12, so this report may be missing some of its transactions.',
      'Ally is still importing older transactions, so this report may be incomplete.',
      'Amex’s transactions in Nya begin on 2025-05-05: if its accounts were open before then, this report is missing their earlier transactions.',
      "Home: transactions entered for Safe couldn't be read.",
    ]);
    // Vanguard holds investments only: listed, never a gap.
    expect(r.institutions.find((i) => i.institution_name === 'Vanguard')!.no_transactions).toBe('investment_accounts');
    expect(r.removed).toEqual([{ institution: 'Wells Fargo', first_seen: '2024-01-10', last_seen: '2025-06-30', connected_again: false, not_back: ['Checking ••9'] }]);
    // Each month names what it may be missing.
    expect(r.months.find((m) => m.month === '2025-01')!.gaps).toEqual(['Acme CU', 'Ally', 'Amex', 'Wells Fargo']);
    expect(r.months.find((m) => m.month === '2025-12')!.gaps).toEqual(['Acme CU', 'Ally', 'Citi']);
  });

  test('a missing store, and a connection never synced, are said as couldn’t be loaded', async () => {
    await saveItem(ctx, { item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt('a') });
    await fake.set(ctxKey('txns:item_a'), 'damaged-not-a-blob');
    await saveItem(ctx, { item_id: 'item_b', institution_name: 'NewBank', encrypted_access_token: await encrypt('b') });
    const r = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(r.gaps.map((g) => [g.kind, g.institution])).toEqual([
      ['missing', 'Chase'],
      ['missing', 'NewBank'],
    ]);
    expect(r.institutions.map((i) => i.note)).toEqual(['Chase: stored transactions could not be read', 'NewBank: no transactions stored yet; open the app to load them']);
    expect(r.empty).toBe(true);
  });

  test('whether a row was excluded that couldn’t be read counts it, and says so', async () => {
    await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('a1') });
    await fake.set(ctxKey('txns:item_chase'), await store([on('2023-01-01', 'old', 'acc_chk', 1), on('2025-04-04', 'q', 'acc_chk', 70)]));
    await fake.hset(ctxKey('transaction-annotations'), { q: 'damaged-not-ciphertext' });
    const r = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(r.totals).toMatchObject({ money_out: 70, exclusion_unknown: 1 });
  });

  test('the same totals as the read-only API’s /spending for the same period and currency', async () => {
    await seedPerson(fake);
    const from = daysAgo(60);
    const to = daysAgo(0);
    const now = Date.now();
    const p = resolvePeriod({ kind: 'range', start: from, end: to }, 'UTC', now);
    if ('error' in p) throw new Error(p.error);
    const [report, api] = await quiet(() => Promise.all([readReport(ctx, p, { currency: 'USD', now }), readSpending(ctx, { from, to, currency: 'USD' })]));
    expect(report.totals).toEqual({
      money_in: api.money_in,
      money_out: api.money_out,
      net: api.net,
      transactions: api.transactions,
      counted: api.counted,
      transfers: api.transfers,
      excluded: api.excluded,
      exclusion_unknown: api.exclusion_unknown,
      left_out: api.left_out,
      left_out_text: api.left_out_text,
    });
    // By category, named as the API names them (which adds the ids and groups).
    expect(report.money_out.map((c) => ({ category: c.category, spent: c.amount, transactions: c.transactions }))).toEqual(
      api.categories.map((c) => ({ category: c.category, spent: c.spent, transactions: c.transactions }))
    );
    // The fixture's own: pay in, its rename and override applied, the excluded and hidden rows out.
    expect(report.money_in).toEqual([{ category: 'income', amount: 3000, transactions: 1 }]);
    // Filed into the person's categories without writing any: a report never
    // grows the stored set, as the API doesn't.
    expect(fake.strings.has(ctxKey('categories'))).toBe(false);
    expect(report.money_out.map((c) => c.category)).toContain('housing');
  });

  test('a mark saved as words keeps working as the categories change: renamed, it is the same category; merged, its marks and rows go with it', async () => {
    const { ensureTaxonomy, changeTaxonomy } = await import('@/lib/category-store');
    const { renameCategory, mergeCategories, textKeys } = await import('@/lib/categories');
    await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('a1') });
    await fake.set(
      ctxKey('txns:item_chase'),
      await store([
        txn('g1', 'acc_chk', 10, 40, { category: 'groceries' }),
        txn('g2', 'acc_chk', 9, 60, { category: 'groceries' }),
        txn('f1', 'acc_chk', 8, 25, { category: 'food and drink' }),
        txn('x1', 'acc_chk', 7, 10),
      ])
    );
    const t = await ensureTaxonomy(ctx, { observed: textKeys(['groceries']) });
    const groceries = t.categories.find((c) => c.name === 'groceries')!;
    const food = t.categories.find((c) => c.name === 'food and drink')!;
    // Saved before any of it, as the release before saves a mark: words.
    const saved = { v: 1 as const, marked: ['groceries'] };
    await reportSettingsStore.set(ctx, saved);
    const [from, to] = [daysAgo(30), daysAgo(0)];
    const period = resolvePeriod({ kind: 'range', start: from, end: to }, 'UTC', Date.now());
    if ('error' in period) throw new Error(period.error);
    const report = () => quiet(() => readReport(ctx, period, { currency: 'USD' }));
    const spending = async () => (await quiet(() => readSpending(ctx, { from, to, currency: 'USD' }))).categories.map((c) => ({ category: c.category, spent: c.spent, transactions: c.transactions }));
    const totals = (r: Awaited<ReturnType<typeof report>>) => r.money_out.map((c) => ({ category: c.category, spent: c.amount, transactions: c.transactions }));

    // Renamed: still marked, under its new name, its rows with it.
    await changeTaxonomy(ctx, (cur) => renameCategory(cur, groceries.id, 'Supermarket'));
    let r = await report();
    expect(r.marked!.categories).toEqual([{ category: 'Supermarket', key: 'groceries', money_in: 0, money_out: 100, transactions: 2 }]);
    expect(r.appendix!.rows.map((x) => [x.name, x.category])).toEqual([
      ['G1', 'Supermarket'],
      ['G2', 'Supermarket'],
    ]);
    expect(r.categories).toContainEqual({ key: 'groceries', name: 'Supermarket' });
    expect(totals(r)).toEqual(await spending());
    expect(totals(r).find((c) => c.category === 'Supermarket')).toEqual({ category: 'Supermarket', spent: 100, transactions: 2 });

    // Merged into food and drink: the mark goes there, and the rows of both
    // are one category, never split between two lines.
    await changeTaxonomy(ctx, (cur) => mergeCategories(cur, groceries.id, food.id));
    r = await report();
    expect(r.marked!.categories).toEqual([{ category: 'food and drink', key: 'food and drink', money_in: 0, money_out: 125, transactions: 3 }]);
    expect(r.appendix!.rows.map((x) => x.name)).toEqual(['G1', 'G2', 'F1']);
    expect(r.categories.filter((c) => c.name === 'food and drink' || c.name === 'Supermarket')).toEqual([{ key: 'food and drink', name: 'food and drink' }]);
    expect(totals(r)).toEqual(await spending());
    expect(totals(r).find((c) => c.category === 'food and drink')).toEqual({ category: 'food and drink', spent: 125, transactions: 3 });
    // The setting itself is as it was saved: words, until the person saves the
    // sheet again, which saves each category's own (its key here).
    expect(await reportSettingsStore.get(ctx)).toEqual(saved);
  });

  test('an empty period says so, and what it is missing', async () => {
    await seedYear();
    const p = resolvePeriod({ kind: 'year', year: 2010 }, NY, NOW);
    if ('error' in p) throw new Error(p.error);
    const r = await quiet(() => readReport(ctx, p, { now: NOW }));
    expect(r.empty).toBe(true);
    expect(r.totals.transactions).toBe(0);
    // Every connection's history begins after it.
    expect(r.gaps.filter((g) => g.kind === 'begins_late').map((g) => g.institution)).toEqual(['Amex', 'Chase', 'Citi']);
  });
});

describe('review: a report from stored data never claims more than it has', () => {
  /** A Chase login with history from 2023, and what its last load remembered. */
  async function chaseLogin(item_id: string, accounts: { account_id: string; mask: string; type: string; name?: string }[]) {
    await saveItem(ctx, { item_id, institution_name: 'Chase', institution_id: 'ins_3', encrypted_access_token: await encrypt(`t-${item_id}`) });
    await fake.set(ctxKey(`txns:${item_id}`), await store([on('2023-05-01', `${item_id}-0`, accounts[0].account_id, 9), on('2025-02-02', `${item_id}-1`, accounts[0].account_id, 50)]));
    const meta = accounts.map((a) => ({ name: a.name ?? 'Account', official_name: null, subtype: null, limit: null, currency: 'USD', ...a }));
    await fake.hset(ctxKey('accounts:meta'), { [item_id]: await encrypt(JSON.stringify(meta)) });
  }
  /** An account of a connection removed in March 2026, as the directory keeps it. */
  const removedEntry = (account: { name: string; mask: string; type: string }) =>
    encrypt(JSON.stringify({ provider: 'plaid', item_id: 'item_personal', institution_id: 'ins_3', institution_name: 'Chase', official_name: null, subtype: null, persistent_account_id: null, first_seen: '2022-01-10', last_seen: '2026-03-01', ...account }));
  const snapshot = () => JSON.stringify({ s: [...fake.strings].sort(), h: [...fake.hashes].map(([k, v]) => [k, [...v].sort()]).sort() });

  test('making a report writes nothing', async () => {
    await seedYear();
    const before = snapshot();
    await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(snapshot()).toBe(before);
  });

  test('two logins at one bank: the one removed is a gap, though the other is still connected', async () => {
    await chaseLogin('item_biz', [{ account_id: 'acc_biz', mask: '9999', type: 'depository' }]);
    await fake.hset(ctxKey('accounts:directory'), { acc_personal_card: await removedEntry({ name: 'Sapphire', mask: '1234', type: 'credit' }) });
    const r = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(r.removed).toEqual([{ institution: 'Chase', first_seen: '2022-01-10', last_seen: '2026-03-01', connected_again: false, not_back: ['Sapphire ••1234'] }]);
    expect(r.gaps.map((g) => g.kind)).toEqual(['removed']);
    expect(statusHeadline(r)).toBe('This report may be incomplete:');
  });

  test('a removed account is back when the person linked it to one connected now, or the same card was connected again', async () => {
    await chaseLogin('item_new', [{ account_id: 'acc_new_card', mask: '1234', type: 'credit' }]);
    await fake.hset(ctxKey('accounts:directory'), { acc_personal_card: await removedEntry({ name: 'Sapphire', mask: '1234', type: 'credit' }) });
    // Matched: the same last four digits and type at the same bank.
    const matched = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(matched.removed[0]).toMatchObject({ connected_again: true, not_back: [] });
    expect(matched.gaps).toEqual([]);
    // Linked by the person, whatever the digits say.
    await fake.hset(ctxKey('accounts:directory'), { acc_personal_card: await removedEntry({ name: 'Sapphire', mask: '0000', type: 'credit' }) });
    expect((await quiet(() => readReport(ctx, year2025(), { now: NOW }))).gaps.map((g) => g.kind)).toEqual(['removed']);
    await fake.hset(ctxKey('account-links'), { acc_personal_card: await encrypt(JSON.stringify({ to: 'acc_new_card', linked_at: '2026-03-02T00:00:00.000Z', evidence: {} })) });
    expect((await quiet(() => readReport(ctx, year2025(), { now: NOW }))).gaps).toEqual([]);
  });

  test('a directory entry that can’t be read makes the report say it may be missing a removed connection’s transactions', async () => {
    await chaseLogin('item_a', [{ account_id: 'acc_a', mask: '1111', type: 'depository' }]);
    await fake.hset(ctxKey('accounts:directory'), { acc_gone: 'damaged-not-ciphertext' });
    const r = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(r.gaps.map((g) => g.kind)).toEqual(['removed_unknown']);
    expect(statusHeadline(r)).toBe('This report may be incomplete:');
  });

  test('a manual account with nothing in the period says none, and one older than the recurring history’s two years keeps its rows', async () => {
    await saveManualAccount(ctx, { account_id: 'manual_cu', name: 'Credit union checking', institution_name: 'Local CU', type: 'depository', subtype: 'checking', balance: 4000, updated_at: '2026-09-30T18:00:00.000Z' });
    await saveManualAccount(ctx, { account_id: 'manual_w', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 40, updated_at: '2026-09-30T18:00:00.000Z' });
    const now = new Date(NOW).toISOString();
    await manualTxnStore.set(ctx, 'manual_w', {
      version: 1,
      rows: [{ id: 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d', account_id: 'manual_w', date: '2023-06-01', amount: 25, currency: 'USD', name: 'old', category: 'medical', note: null, source: 'manual', source_id: null, created_at: now, updated_at: now }],
    });
    const p2023 = resolvePeriod({ kind: 'year', year: 2023 }, NY, NOW);
    if ('error' in p2023) throw new Error(p2023.error);
    const r = await quiet(() => readReport(ctx, p2023, { now: NOW }));
    expect(r.totals.money_out).toBe(25);
    expect(r.manual.map((m) => [m.name, m.transactions])).toEqual([
      ['Wallet', 1],
      ['Credit union checking', 0],
    ]);
  });

  test('the person’s own categories that can’t be read are a gap, and their names for merchants a caveat; the rows read as the app reads them', async () => {
    await chaseLogin('item_a', [{ account_id: 'acc_a', mask: '1111', type: 'depository' }]);
    await fake.hset(ctxKey('txn-category-overrides'), { 'item_a-1': 'damaged-not-ciphertext' });
    await fake.hset(ctxKey('txn-vendor-renames'), { 'mid:x': 'damaged-not-ciphertext' });
    const r = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(r.gaps.map((g) => g.kind)).toEqual(['own_categories']);
    expect(r.caveats.names_unread).toBe(true);
    // The bank's category, as the Activity tab shows it then.
    expect(r.money_out).toEqual([{ category: 'general merchandise', amount: 50, transactions: 1 }]);
  });

  test('an account that stopped appearing, and a bank connection holding investments, are said', async () => {
    await chaseLogin('item_a', [
      { account_id: 'acc_a', mask: '1111', type: 'depository' },
      { account_id: 'acc_brk', mask: '2222', type: 'investment' },
    ]);
    await noticesStore.set(ctx, 'item_a', { episode: 'e1', since: '2025-08-01T13:00:00.000Z', state: 'partial', notified_at: null, reminded_at: null });
    const r = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(r.gaps).toEqual([{ kind: 'partial', item_id: 'item_a', institution: 'Chase', since: '2025-08-01' }]);
    expect(r.caveats.scope).toEqual({ investment: true, loans: false });
  });

  test('a connection never synced is missing only from periods its history could reach; before that, it can go back only so far', async () => {
    await saveItem(ctx, { item_id: 'item_new', institution_name: 'NewBank', encrypted_access_token: await encrypt('n') });
    await fake.hset(ctxKey('accounts:directory'), { acc_n: await seenFrom('item_new', 'NewBank', '2026-09-01') });
    const p2023 = resolvePeriod({ kind: 'year', year: 2023 }, NY, NOW);
    if ('error' in p2023) throw new Error(p2023.error);
    expect((await quiet(() => readReport(ctx, p2023, { now: NOW }))).gaps).toEqual([{ kind: 'begins_late', item_id: 'item_new', institution: 'NewBank', first: '2024-09-01', from: 'reach' }]);
    expect((await quiet(() => readReport(ctx, year2025(), { now: NOW }))).gaps.map((g) => g.kind)).toEqual(['missing']);
  });
});

describe('verification: a report from stored data says what may be missing, and only that', () => {
  test('with no account links, nothing could be carried across a re-link, so a remembered-accounts record that can’t be read is no gap', async () => {
    await saveItem(ctx, { item_id: 'item_a', institution_name: 'Chase', institution_id: 'ins_3', encrypted_access_token: await encrypt('t-a') });
    await fake.set(ctxKey('txns:item_a'), await store([on('2023-05-01', 'a-0', 'acc_chk', 9), on('2025-02-02', 'a-1', 'acc_chk', 50)]));
    // Of a connection no longer stored, as a disconnect can leave behind.
    await fake.hset(ctxKey('accounts:meta'), { item_gone: 'damaged-not-ciphertext' });
    const r = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(r.gaps).toEqual([]);
    expect(statusHeadline(r)).toBe('Nothing is known to be missing from this period.');
    expect(r.money_out).toEqual([{ category: 'general merchandise', amount: 50, transactions: 1 }]);

    // With a link, what it carries can't be told from a paused one without
    // the live accounts: both are said, as before.
    await fake.hset(ctxKey('account-links'), { acc_old: await encrypt(JSON.stringify({ to: 'acc_chk', linked_at: '2025-01-02T00:00:00.000Z', evidence: {} })) });
    const linked = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect(linked.gaps.map((g) => g.kind)).toEqual(['own_categories', 'own_exclusions']);
  });

  const p2015 = () => {
    const p = resolvePeriod({ kind: 'year', year: 2015 }, NY, NOW);
    if ('error' in p) throw new Error(p.error);
    return p;
  };

  test('a connection synced with nothing stored, linked in 2026: a 2015 report says how far back its history can go, never only that the period is empty', async () => {
    await saveItem(ctx, { item_id: 'item_a', institution_name: 'Chase', institution_id: 'ins_3', encrypted_access_token: await encrypt('t-a') });
    await fake.set(ctxKey('txns:item_a'), await store([]));
    await fake.hset(ctxKey('accounts:directory'), { acc_chk: await seenFrom('item_a', 'Chase', '2026-03-02') });
    const r = await quiet(() => readReport(ctx, p2015(), { now: NOW }));
    expect(r.gaps).toEqual([{ kind: 'begins_late', item_id: 'item_a', institution: 'Chase', first: '2024-03-02', from: 'reach' }]);
    expect(statusHeadline(r)).toBe('There are no transactions in this period, and some may be missing:');
    expect(gapSentences(r.gaps, (d) => d)).toEqual([
      'Chase’s transactions in Nya can go back only to 2024-03-02: if its accounts were open before then, this report is missing their earlier transactions.',
    ]);
    // 2025 is within its reach: nothing in it, and nothing missing.
    expect((await quiet(() => readReport(ctx, year2025(), { now: NOW }))).gaps).toEqual([]);
  });

  test('a store that can’t be read stays missing from a period before its connection was first seen', async () => {
    await saveItem(ctx, { item_id: 'item_a', institution_name: 'Chase', institution_id: 'ins_3', encrypted_access_token: await encrypt('t-a') });
    await fake.set(ctxKey('txns:item_a'), 'damaged-not-a-blob');
    // First seen in 2026 (balance history began then), though it may hold far older rows.
    await fake.hset(ctxKey('accounts:directory'), { acc_chk: await seenFrom('item_a', 'Chase', '2026-09-01') });
    const r = await quiet(() => readReport(ctx, p2015(), { now: NOW }));
    expect(r.gaps).toEqual([{ kind: 'missing', item_id: 'item_a', institution: 'Chase', reach: null }]);
    expect(r.months.every((m) => m.uncertain)).toBe(true);
    expect(r.data_as_of).toBeNull();
    expect(r.institutions[0].note).toBe('Chase: stored transactions could not be read');
  });
});

describe('GET /api/reports', () => {
  test('answers the report as JSON, from storage, in the person’s time zone', async () => {
    await seedYear();
    const res = await quiet(() => getReport('kind=year&year=2025&tz=America/New_York'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { report } = await res.json();
    expect(report.period).toMatchObject({ kind: 'year', start: '2025-01-01', end: '2025-12-31', through: '2025-12-31', time_zone: NY });
    expect(report.totals.money_in).toBe(4000);
    expect(report.gaps.length).toBe(6);
  });

  test('a CSV of the same totals, as a file', async () => {
    await seedYear();
    const res = await quiet(() => getReport('kind=year&year=2025&tz=America/New_York&format=csv'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="nya-report-2025.csv"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const rows = parseCsv(await res.text());
    expect(rows.find((x) => x[0] === 'total')!.slice(2, 4)).toEqual(['4000', String(150 + 45 + 30 + 12.5 + 25 + 60)]);
    expect(rows.filter((x) => x[0] === 'gap').length).toBe(7); // six gaps and the remedy
  });

  test('a request it can’t answer is a 400 with the reason, before anything is read', async () => {
    // No container at all: still the reason, not a 503, so nothing was read first.
    fake.reset();
    for (const [query, reason] of [
      ['kind=year&year=1999', 'Choose a year from 2000 to'],
      ['kind=year&year=2999', 'Choose a year from 2000 to'],
      ['kind=range&start=2026-03-01&end=2026-02-01', 'ends before it starts'],
      ['kind=range&start=2020-01-01&end=2024-01-01', 'at most two years long'],
      [`kind=range&start=2026-01-01&end=2999-01-01`, 'can’t end after today'],
      ['kind=range&start=nope&end=2026-01-01', 'YYYY-MM-DD'],
      ['year=2025&tz=Not/AZone', 'tz must be a time zone'],
      ['year=2025&format=xlsx', 'format must be'],
      ['year=2025&year=2024', 'more than once'],
      ['year=2025&secret=1', 'Unknown parameter'],
    ] as const) {
      const res = await getReport(query);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(reason);
    }
  });

  test('with no container to reach, a 503 with the reason', async () => {
    fake.reset();
    forgetEpochs();
    const res = await quiet(() => getReport('year=2025'));
    expect(res.status).toBe(503);
  });

  test('a database failure is a 500 that says nothing more', async () => {
    await seedYear();
    fake.failNext('hgetall');
    const res = await quiet(() => getReport('year=2025'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to make the report' });
  });

  test('each person’s report is their own: nobody else’s data is ever in it', async () => {
    await seedYear();
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    clerk.signedIn = 'user_owner';
    const query = 'kind=range&start=2025-01-01&end=2025-12-31&tz=UTC';
    expect((await (await quiet(() => getReport(query))).json()).report.totals.money_in).toBe(4000);
    // Someone else's container, with data of its own: never in the owner's.
    await seedOther(fake);
    const mine = await (await quiet(() => getReport(query))).json();
    expect(mine.report.totals.money_in).toBe(4000);
    expect(JSON.stringify(mine)).not.toContain('OTHER-SECRET');
    expect(JSON.stringify(mine)).not.toContain('OtherBank');
    clerk.signedIn = 'user_partner';
    const res = await quiet(() => getReport('kind=range&start=2025-01-01&end=2025-12-31&tz=UTC'));
    expect(res.status).toBe(200);
    const theirs = (await res.json()).report;
    expect(theirs.totals.transactions).toBe(0);
    expect(theirs.institutions).toEqual([]);
    expect(theirs.marked).toBeNull();
    const text = JSON.stringify(theirs);
    for (const s of ['Chase', 'Citi', 'Wallet', 'medical', 'OTHER-SECRET']) expect(text).not.toContain(s);
    clerk.signedIn = null;
    expect((await quiet(() => getReport('year=2025'))).status).toBe(503);
  });
});

describe('the marked categories, a setting on the storage seam', () => {
  const saved = { v: 1 as const, marked: ['medical', 'charitable giving'] };

  test('declared on the seam, exportable, on the key inventory, and in the data download', async () => {
    expect(declaredStore('report-settings')).toMatchObject({ kind: 'value', exportable: true, what: 'report settings' });
    expect(classify(SETTINGS_KEY.replace(/^[^:]+:(?=c:)/, ''))).toBe('string');
    expect(declaredSections().map((s) => s.key)).toContain('report-settings');
    const download = async () => buildUserExport(await quiet(() => collectUserData({ ctx, userId: null })), new Date(NOW));
    expect((await download())['report-settings']).toBeNull();
    await reportSettingsStore.set(ctx, saved);
    await reportSettingsStore.set(OTHER, { v: 1, marked: ['other-persons-category'] });
    const doc = await download();
    expect(doc['report-settings']).toEqual(saved);
    expect(JSON.stringify(doc)).not.toContain('other-persons-category');
  });

  test('kept encrypted, as saved; never saved reads as null', async () => {
    expect(await reportSettingsStore.get(ctx)).toBeNull();
    await reportSettingsStore.set(ctx, saved);
    const raw = await fake.get<string>(SETTINGS_KEY);
    expect(raw).not.toContain('medical');
    expect(await reportSettingsStore.get(ctx)).toEqual(saved);
  });

  test('damaged bytes are unreadable, a later release’s settings unrecognised, and neither reads as none', async () => {
    await fake.set(SETTINGS_KEY, 'not-ciphertext-at-all-but-long-enough');
    const damaged = await reportSettingsStore.get(ctx).catch((e: unknown) => e);
    expect(damaged).toBeInstanceOf(UnreadableValueError);
    expect((damaged as InstanceType<typeof UnreadableValueError>).unrecognised).toBe(false);
    for (const later of [{ ...saved, v: 2 }, { ...saved, groups: [] }]) {
      await fake.set(SETTINGS_KEY, await encrypt(JSON.stringify(later)));
      const e = await reportSettingsStore.get(ctx).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(StoredDataUnreadableError);
      expect((e as InstanceType<typeof UnreadableValueError>).unrecognised).toBe(true);
    }
  });

  test('a report whose marked categories can’t be read leaves the group out and says why, never “none marked”', async () => {
    await seedYear();
    await fake.set(SETTINGS_KEY, 'not-ciphertext-at-all-but-long-enough');
    const r = await quiet(() => readReport(ctx, year2025(), { now: NOW }));
    expect([r.marked, r.appendix, r.caveats.marked]).toEqual([null, null, 'unreadable']);
    expect(r.totals.money_in).toBe(4000);
  });

  test('the route: null before anything is saved, then the clean copy of what was', async () => {
    expect(await (await settingsRoute.GET()).json()).toEqual({ settings: null });
    const res = await put({ settings: { v: 1, marked: ['  Medical', 'Charitable  Giving '] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: saved });
    expect(await (await settingsRoute.GET()).json()).toEqual({ settings: saved });
  });

  test('invalid settings are refused with the reason, and nothing is stored', async () => {
    const cases: [unknown, string][] = [
      [{ settings: { v: 1, marked: ['a', 'A'] } }, 'already marked'],
      [{ settings: { v: 1, marked: ['x'.repeat(61)] } }, '1 to 60 characters'],
      [{ settings: { v: 1, marked: Array.from({ length: 101 }, (_, i) => `c${i}`) } }, 'at most 100'],
      [{ settings: { v: 1, marked: [], extra: true } }, 'unknown field'],
      [{ settings: { v: 2, marked: [] } }, 'v must be 1'],
      [{}, 'must be an object'],
      [{ settings: null }, 'must be an object'],
    ];
    for (const [body, reason] of cases) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain(reason);
    }
    expect((await put('{not json')).status).toBe(400);
    expect((await put(null)).status).toBe(400);
    expect(await fake.get(SETTINGS_KEY)).toBeNull();
  });

  test('unreadable or unrecognised settings are a flagged 409 on load and on save, and are left alone', async () => {
    for (const stored of ['unreadable', await encrypt(JSON.stringify({ ...saved, v: 2 }))]) {
      await fake.set(SETTINGS_KEY, stored);
      const loaded = await quiet(() => settingsRoute.GET());
      expect(loaded.status).toBe(409);
      expect(await loaded.json()).toMatchObject({ unreadable: true, error: expect.stringContaining('report settings') });
      const saving = await quiet(() => put({ settings: saved }));
      expect(saving.status).toBe(409);
      expect(await saving.json()).toMatchObject({ unreadable: true });
      expect(await fake.get<string>(SETTINGS_KEY)).toBe(stored);
    }
  });

  test('a database failure is a 500 without the flag; too large to store is a 413 with the seam’s reason', async () => {
    fake.failNext('get');
    const res = await quiet(() => settingsRoute.GET());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to load report settings' });
    fake.failNext('set');
    expect(await (await quiet(() => put({ settings: saved }))).json()).toEqual({ error: 'Failed to save report settings' });
    const before = process.env.MAX_TXN_BLOB_CHARS;
    process.env.MAX_TXN_BLOB_CHARS = '40';
    try {
      const big = await quiet(() => put({ settings: saved }));
      expect(big.status).toBe(413);
      expect((await big.json()).error).toContain('too large to save');
      expect(await fake.get(SETTINGS_KEY)).toBeNull();
    } finally {
      if (before === undefined) delete process.env.MAX_TXN_BLOB_CHARS;
      else process.env.MAX_TXN_BLOB_CHARS = before;
    }
  });

  test('with no container to reach, a 503, and nothing read or written', async () => {
    fake.reset();
    forgetEpochs();
    expect((await quiet(() => settingsRoute.GET())).status).toBe(503);
    expect((await quiet(() => put({ settings: saved }))).status).toBe(503);
    expect([...fake.strings.keys()].filter((k) => k.includes('report-settings'))).toEqual([]);
  });

  test('each person reads and saves their own', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    clerk.signedIn = 'user_owner';
    expect((await put({ settings: saved })).status).toBe(200);
    clerk.signedIn = 'user_partner';
    expect(await (await settingsRoute.GET()).json()).toEqual({ settings: null });
    expect((await put({ settings: { v: 1, marked: ['travel'] } })).status).toBe(200);
    clerk.signedIn = 'user_owner';
    expect(await (await settingsRoute.GET()).json()).toEqual({ settings: saved });
    const keys = [...fake.strings.keys()].filter((k) => k.endsWith(':report-settings')).sort();
    expect(keys.length).toBe(2);
    expect(keys).toContain(testKey(`c:${TEST_CONTAINER}:report-settings`));
    clerk.signedIn = null;
    expect((await quiet(() => settingsRoute.GET())).status).toBe(503);
  });
});
