import { describe, expect, test, mock } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { bankTxn, OLD_ITEM } from './restore-fixture';

// A large download brought back (lib/user-restore/file.ts, send.ts, the
// routes): years of a bank's rows and a long manual book, in batches each
// under the request limit, the bank's rows in books of BOOK_ROWS, a book of
// the seam sent in pieces and put back whole, every row read back.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_ENABLED = '1';

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { collectUserData, buildUserExport, exportFile, fileChunks } = await import('@/lib/user-export');
const { collect, previewOf, buildBatches } = await import('@/lib/user-restore/file');
const { makePlan, startBody, startRestore, sendBatches, finishRestore } = await import('@/lib/user-restore/send');
const { newUserRestoreId, restoredId, BATCH_BYTES, BOOK_ROWS } = await import('@/lib/user-restore/ids');
const { restoredTxnStore, restoredAccountsStore } = await import('@/lib/user-restore/store');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { utf8Bytes } = await import('@/lib/user-restore/plan');
const { forgetEpochs } = await import('@/lib/sessions');
const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const restoreRoute = await import('@/app/api/user-restore/route');
const batchRoute = await import('@/app/api/user-restore/batch/route');

const ctx = TEST_CTX;
const BANK_ROWS = 12_000;
const MANUAL_ROWS = 14_000;
const day = (n: number) => new Date(Date.UTC(2023, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

const fetcher = async (input: string, init?: RequestInit) => {
  const url = new URL(input, 'http://localhost');
  const req = new Request(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'x-forwarded-for': '203.0.113.9' } });
  if (url.pathname === '/api/user-restore') return (restoreRoute as unknown as Record<string, (r: Request) => Promise<Response>>)[init?.method ?? 'GET'](req);
  return batchRoute.POST(req);
};

async function seedLarge() {
  const enc = (v: unknown) => encrypt(ctx, JSON.stringify(v));
  await fake.hset(ctxKey('plaid:items'), { [OLD_ITEM]: JSON.stringify({ item_id: OLD_ITEM, institution_name: 'Chase', institution_id: 'ins_3', encrypted_access_token: await encrypt(ctx, 'access-sandbox-a') }) });
  await fake.hset(ctxKey('accounts:meta'), { [OLD_ITEM]: await enc([{ account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }]) });
  const txns: Record<string, unknown> = {};
  for (let i = 0; i < BANK_ROWS; i++) {
    const id = `t${String(i).padStart(6, '0')}`;
    txns[id] = bankTxn({ transaction_id: id, amount: ((i * 37) % 9000) / 100 + 1, date: day(Math.floor(i / 12)), name: `SHOP ${i % 400}`, merchant_name: `Shop ${i % 400}`, merchant_entity_id: null });
  }
  await fake.set(
    ctxKey(`txns:${OLD_ITEM}`),
    await encodeJsonBlob(ctx, {
      schema_version: 2,
      cursor: 'cursor-a',
      accounts: { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: { available: 100, current: 100, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null } } },
      txns,
    })
  );
  await fake.hset(ctxKey('manual:accounts'), {
    manual_cash: await enc({ account_id: 'manual_cash', name: 'Cash', institution_name: 'Wallet', type: 'depository', subtype: null, balance: 50, updated_at: '2026-09-30T10:00:00.000Z' }),
  });
  const at = '2026-10-01T00:00:00.000Z';
  const rows = Array.from({ length: MANUAL_ROWS }, (_, i) => ({
    id: `manual-txn:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    account_id: 'manual_cash',
    date: day(Math.floor(i / 14)),
    amount: (i % 50) + 0.25,
    currency: 'USD',
    name: `Cash spend ${i}`,
    category: 'Shopping',
    note: i % 7 === 0 ? 'with receipt' : null,
    source: 'manual',
    source_id: null,
    created_at: at,
    updated_at: at,
  }));
  await manualTxnStore.set(ctx, 'manual_cash', { version: 1, rows } as never);
}

describe('a large file', () => {
  test(`${BANK_ROWS} bank rows and a book of ${MANUAL_ROWS}: every batch under the limit, books of ${BOOK_ROWS}, every row back`, async () => {
    fake.reset();
    await registerTestContainer(fake);
    await seedLarge();
    const doc = buildUserExport(await collectUserData({ ctx, userId: 'user_me' }), new Date('2026-10-06T12:00:00.000Z'));
    const bytes = new Uint8Array(Buffer.concat([...fileChunks(exportFile(doc, 'json'))]));
    expect(bytes.length).toBeGreaterThan(4 * BATCH_BYTES);
    const source = {
      size: bytes.length,
      protected: false,
      async *bytes() {
        for (let i = 0; i < bytes.length; i += 1 << 20) yield bytes.slice(i, i + (1 << 20));
      },
    };

    fake.reset();
    forgetEpochs();
    await registerTestContainer(fake);
    const c = await collect(source);
    const p = previewOf(c);
    expect(p.refuse).toBeNull();
    expect(p.brought).toMatchObject({ 'restored-rows': BANK_ROWS, 'store:manual-transactions': 1 });
    const sizes = new Map<string, number[]>();
    await buildBatches(source, c, async (b) => {
      sizes.set(b.part, [...(sizes.get(b.part) ?? []), utf8Bytes(b.body)]);
    });
    for (const list of sizes.values()) for (const n of list) expect(n).toBeLessThanOrEqual(BATCH_BYTES);
    expect(sizes.get('restored-rows')!.length).toBeGreaterThan(2);
    expect(sizes.get('store:manual-transactions')!.length).toBeGreaterThan(1);

    const plan = await makePlan(source, c, { fetcher });
    const record = await startRestore(fetcher, startBody(p, plan, source, newUserRestoreId(), 'hunter2'));
    await sendBatches(source, c, record, { fetcher, plan });
    expect((await finishRestore(fetcher, record.id)).status).toBe('finished');

    const books = await restoredTxnStore.getAll(ctx);
    const parts = Math.ceil(BANK_ROWS / BOOK_ROWS);
    expect([...books.keys()].sort()).toEqual(Array.from({ length: parts }, (_, i) => `acc_chk.${i + 1}`));
    const rows = [...books.values()].sort((a, b) => a.part - b.part).flatMap((b) => b.rows);
    expect(rows.length).toBe(BANK_ROWS);
    expect(new Set(rows.map((r) => r.id)).size).toBe(BANK_ROWS);
    expect(rows.every((r) => r.id === restoredId(r.bank.transaction_id) && r.import_id === record.id)).toBe(true);
    expect((await restoredAccountsStore.get(ctx, 'acc_chk'))!.rows).toMatchObject({ count: BANK_ROWS, books: parts });
    const book = await manualTxnStore.get(ctx, 'manual_cash');
    expect(book!.rows.length).toBe(MANUAL_ROWS);
    expect(book!.rows.map((r) => r.id)).toEqual(Array.from({ length: MANUAL_ROWS }, (_, i) => `manual-txn:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
    expect(unscopedDataKeys(fake)).toEqual([]);
  }, 120_000);
});
