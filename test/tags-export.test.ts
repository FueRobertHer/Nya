import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, ctxKey, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// Tags and notes in the download of your data (#40): the tags and what was
// said about each transaction as parts of their own, and each transaction's
// tags and note in the JSON and the CSV, as the app shows them, carried
// across a re-link too.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const ctx = TEST_CTX;
const NOW = new Date('2026-10-06T12:00:00.000Z');
const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { contentKey } = await import('@/lib/transactions');
const { rememberAccounts } = await import('@/lib/last-known');
const { linkAccounts } = await import('@/lib/links');
const { saveManualAccount } = await import('@/lib/manual');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { ensureTag } = await import('@/lib/tags');
const { changeAnnotation, carriedAnnotationStore } = await import('@/lib/txn-annotations');
const { collectUserData, buildUserExport, exportFile, TRANSACTION_COLUMNS } = await import('@/lib/user-export');

const stored = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  pending_transaction_id: null,
  account_id: 'acc_new',
  amount: 12,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  date: '2026-09-02',
  authorized_date: null,
  authorized_datetime: null,
  datetime: null,
  name: id.toUpperCase(),
  merchant_name: null,
  merchant_entity_id: null,
  website: null,
  logo_url: null,
  personal_finance_category: null,
  personal_finance_category_icon_url: null,
  pending: false,
  payment_channel: null,
  transaction_code: null,
  transaction_type: null,
  check_number: null,
  account_owner: null,
  location: null,
  payment_meta: null,
  counterparties: [],
  category: 'travel',
  account_name: 'Checking',
  institution_name: 'Chase',
  ...over,
});
const MANUAL_ID = 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

let work = '';
let trip = '';
beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt('t') }) });
  const txns = { t_hotel: stored('t_hotel'), t_taxi: stored('t_taxi', { amount: 30 }), t_carried: stored('t_carried', { amount: 99, date: '2026-09-01' }) };
  await fake.set(ctxKey('txns:item_a'), await encodeJsonBlob({ schema_version: 2, cursor: 'c', accounts: {}, txns }));
  await rememberAccounts(ctx, [{ item_id: 'item_a', institution_name: 'Chase', institution_id: null, error: null, accounts: [{ account_id: 'acc_new', name: 'Checking', type: 'depository', subtype: 'checking', mask: '1', balance: 1 }] } as any]);
  await saveManualAccount(ctx, { account_id: 'manual_wallet', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 40, updated_at: NOW.toISOString() } as any);
  await manualTxnStore.set(ctx, 'manual_wallet', {
    version: 1,
    rows: [{ id: MANUAL_ID, account_id: 'manual_wallet', date: '2026-09-03', amount: 25, currency: 'USD', name: 'Farmers market', category: null, note: 'apples', source: 'manual', source_id: null, created_at: NOW.toISOString(), updated_at: NOW.toISOString() }],
  });
  work = (await ensureTag(ctx, { name: 'Work' })).tag.id;
  trip = (await ensureTag(ctx, { name: 'Vacation 2026' })).tag.id;
  await changeAnnotation(ctx, 't_hotel', { add: [trip, work], note: 'Paid back in October' });
  await changeAnnotation(ctx, MANUAL_ID, { add: [trip] });
  // An earlier account's row, re-linked: its tag carries to the row with the same content.
  await carriedAnnotationStore.set(ctx, 'acc_old', { version: 1, rows: { [contentKey('acc_old', stored('x', { amount: 99, date: '2026-09-01', name: 'T_CARRIED' }))]: { tags: [work], note: 'carried note' } } });
  await linkAccounts(ctx, 'acc_old', 'acc_new', {});
});

const download = async () => buildUserExport(await collectUserData({ ctx, userId: 'user_me' }), NOW);

describe('in the download', () => {
  test('each transaction’s tags by name and its note, as the app shows them, carried ones too', async () => {
    const doc = await download();
    const by = Object.fromEntries(doc.transactions.map((t) => [t.transaction_id, t]));
    expect([by.t_hotel.tags, by.t_hotel.your_note]).toEqual([['Work', 'Vacation 2026'], 'Paid back in October']);
    expect([by.t_carried.tags, by.t_carried.your_note]).toEqual([['Work'], 'carried note']);
    expect([by.t_taxi.tags, by.t_taxi.your_note]).toEqual([[], null]);
    // The tags and the records themselves, as parts of their own.
    expect((doc.tags as any).tags.map((t: any) => t.name)).toEqual(['Work', 'Vacation 2026']);
    expect((doc['transaction-annotations'] as any[]).map((e) => e.id).sort()).toEqual([MANUAL_ID, 't_hotel']);
  });

  test('the CSV gives every row’s tags, a manual row’s too, and a bank row’s note', async () => {
    const [header, ...rows] = parseCsv([...exportFile(await download(), 'transactions-csv').pieces()].join(''));
    expect(header.at(-1)).toBe('tags');
    const col = (r: string[], name: (typeof TRANSACTION_COLUMNS)[number]) => r[header.indexOf(name)];
    const by = Object.fromEntries(rows.map((r) => [col(r, 'transaction_id'), r]));
    expect([col(by.t_hotel, 'tags'), col(by.t_hotel, 'note')]).toEqual(['Work; Vacation 2026', 'Paid back in October']);
    expect([col(by[MANUAL_ID], 'tags'), col(by[MANUAL_ID], 'note')]).toEqual(['Vacation 2026', 'apples']);
    expect([col(by.t_taxi, 'tags'), col(by.t_taxi, 'note')]).toEqual(['', '']);
  });

  test('a tag deleted is in no transaction’s list, whatever a record still holds', async () => {
    const { deleteTag } = await import('@/lib/tag-delete');
    // Stopped part way: the record still names it; nothing shows it.
    const { changeTagSet, markDeleted } = await import('@/lib/tags');
    await changeTagSet(ctx, (s) => markDeleted(s, work));
    const doc = await download();
    expect(doc.transactions.find((t) => t.transaction_id === 't_hotel')!.tags).toEqual(['Vacation 2026']);
    await deleteTag(ctx, trip);
    expect((await download()).transactions.find((t) => t.transaction_id === 't_hotel')!.tags).toEqual([]);
  });
});
