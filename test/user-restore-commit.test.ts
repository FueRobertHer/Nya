import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld } from './restore-fixture';

// Writing a restore's batches (lib/user-restore/commit.ts): what the finish
// works out that the download leaves out (the imports' summaries, the
// holdings index), equal to what the old copy had; a piece of a large entry
// written twice written once, and one out of its place refused; and each
// store's bound checked against what is stored before anything is written.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_ENABLED = '1';

mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({ data: { added: [], modified: [], removed: [], accounts: [], next_cursor: 'c-next', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' } }),
  },
}));
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { writeBatch, finishWrites, BatchNotWritten } = await import('@/lib/user-restore/commit');
const { restoreRecord } = await import('./restore-fixture');
const { importSummaryStore, importStore } = await import('@/lib/import/store');
const { historyImportSummaryStore } = await import('@/lib/history-import/store');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { groupStore } = await import('@/lib/groups');
const { saveManualAccount } = await import('@/lib/manual');
const { recordHoldings, observeHoldings, readHoldingsSpan, readHoldingsRange } = await import('@/lib/holdings-history');
const { forgetEpochs } = await import('@/lib/sessions');
const imports = await import('@/app/api/import/route');
const historyImport = await import('@/app/api/history-import/route');
const { EXPORTED, downloadText, restoreAll } = await import('./restore-run');

const ctx = TEST_CTX;
const RECORD = restoreRecord() as never;

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
});

const ofx = (rows: { fitid: string; day: string; amount: string; name: string }[], acct: string) =>
  [
    '<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF>',
    `<BANKACCTFROM><BANKID>325081403</BANKID><ACCTID>${acct}</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20250101</DTSTART><DTEND>20250630</DTEND>`,
    ...rows.map((r) => `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${r.day}120000[-5:EST]</DTPOSTED><TRNAMT>${r.amount}</TRNAMT><FITID>${r.fitid}</FITID><NAME>${r.name}</NAME></STMTTRN>`),
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
  ].join('\n');
const form = (file: string, meta: Record<string, unknown>) => {
  const f = new FormData();
  f.set('file', new Blob([new TextEncoder().encode(file) as Uint8Array<ArrayBuffer>]), 'statement.ofx');
  f.set('meta', JSON.stringify({ file_name: 'statement.ofx', ...meta }));
  return f;
};

describe('the finish', () => {
  test('works out the imports’ summaries and the holdings index, as the old copy had them', async () => {
    await seedOld(fake, ctx);
    // An import into the manual account, and one into the bank's.
    const manual = await imports.POST(
      new Request('http://localhost/api/import', {
        method: 'POST',
        body: form(ofx([{ fitid: 'M1', day: '20250301', amount: '-15.00', name: 'HARDWARE' }, { fitid: 'M2', day: '20250302', amount: '-7.50', name: 'PAINT' }], '0001'), { action: 'import', account_id: 'manual_house', options: {} }),
      })
    );
    expect(manual.status).toBe(200);
    const statement = ofx([{ fitid: 'H1', day: '20250405', amount: '-30.00', name: 'OLD BOOKSHOP' }], '0009991111');
    const preview = await (await historyImport.POST(new Request('http://localhost/api/history-import', { method: 'POST', body: form(statement, { action: 'preview', account_id: 'acc_chk' }) }))).json();
    const history = await historyImport.POST(
      new Request('http://localhost/api/history-import', { method: 'POST', body: form(statement, { action: 'import', account_id: 'acc_chk', review: preview.preview.review }) })
    );
    expect(history.status).toBe(200);
    // Holdings on two days of two months.
    const broker = (day: string) => {
      const accounts = [{ account_id: 'acct_brk', type: 'investment', balance: 1000 }];
      const holdings = [{ account_id: 'acct_brk', security_id: 'vti', quantity: 10, institution_price: 100, institution_price_as_of: day, institution_value: 1000, cost_basis: 800, iso_currency_code: 'USD', unofficial_currency_code: null }];
      const securities = [{ security_id: 'vti', ticker_symbol: 'VTI', name: 'vti fund', type: 'etf', is_cash_equivalent: false }];
      return { institution_name: 'Broker', item_id: 'item_b', accounts, holdings: [], holdings_observed: observeHoldings({ accounts, holdings, securities }) ?? undefined, error: null, needs_reauth: false, liabilities: 'unavailable' } as never;
    };
    await recordHoldings(ctx, [broker('2026-08-31')], Date.parse('2026-08-31T13:00:00.000Z'));
    await recordHoldings(ctx, [broker('2026-09-01')], Date.parse('2026-09-01T13:00:00.000Z'));
    const old = {
      summaries: await importSummaryStore.getAll(ctx),
      history: await historyImportSummaryStore.getAll(ctx),
      span: await readHoldingsSpan(ctx),
      days: await readHoldingsRange(ctx, '2026-08-01', '2026-09-30'),
    };
    expect(old.summaries.size).toBe(1);
    expect(old.history.size).toBe(1);
    const text = await downloadText(EXPORTED);

    fake.reset();
    forgetEpochs();
    await registerTestContainer(fake);
    await restoreAll(text);
    expect(await importSummaryStore.getAll(ctx)).toEqual(old.summaries);
    expect(await historyImportSummaryStore.getAll(ctx)).toEqual(old.history);
    expect(await readHoldingsSpan(ctx)).toEqual(old.span);
    expect(await readHoldingsRange(ctx, '2026-08-01', '2026-09-30')).toEqual(old.days);
    // Run again, it writes the same.
    await finishWrites(ctx);
    expect(await importSummaryStore.getAll(ctx)).toEqual(old.summaries);
    expect([...(await importStore.getAll(ctx)).keys()]).toEqual([...old.summaries.keys()]);
  });
});

const row = (i: number) => ({
  id: `manual-txn:00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  account_id: 'manual_house',
  date: '2026-02-01',
  amount: i,
  currency: 'USD',
  name: `Row ${i}`,
  category: null,
  note: null,
  source: 'manual',
  source_id: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
});
const piece = (from: number, rows: number[], head: Record<string, unknown> = {}) => [{ id: 'manual_house', from, value: { version: 1, ...head, rows: rows.map(row) } }];

describe('a batch', () => {
  test('a piece of a large entry written twice is written once; one that would leave a gap, or says another head, is refused', async () => {
    await writeBatch(ctx, 'store:manual-transactions', piece(0, [1, 2, 3]), RECORD);
    await writeBatch(ctx, 'store:manual-transactions', piece(3, [4, 5]), RECORD);
    await writeBatch(ctx, 'store:manual-transactions', piece(3, [4, 5]), RECORD);
    await writeBatch(ctx, 'store:manual-transactions', piece(0, [1, 2, 3]), RECORD);
    expect((await manualTxnStore.get(ctx, 'manual_house'))!.rows.map((r) => r.amount)).toEqual([1, 2, 3, 4, 5]);
    expect(await writeBatch(ctx, 'store:manual-transactions', piece(7, [8]), RECORD).catch((err) => err)).toBeInstanceOf(BatchNotWritten);
    expect(await writeBatch(ctx, 'store:manual-transactions', piece(5, [6], { version: 2 }), RECORD).catch((err) => err)).toBeInstanceOf(BatchNotWritten);
    expect((await manualTxnStore.get(ctx, 'manual_house'))!.rows.length).toBe(5);
  });

  test('a store’s bound is checked against what is stored: past it, nothing of the batch is written', async () => {
    const group = (members: string[]) => ({ version: 1, name: 'G', category_id: 'cat1', members, date: '2026-01-02', currency: 'USD', created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' });
    for (let i = 0; i < 2000; i++) await groupStore.set(ctx, `g${i}`, group([`t${i}a`, `t${i}b`]) as never);
    // One already there is written again; one more is past the bound.
    await writeBatch(ctx, 'store:transaction-groups', [{ id: 'g1', value: group(['t1a', 't1b']) }], RECORD);
    const past = await writeBatch(ctx, 'store:transaction-groups', [{ id: 'g1', value: group(['x', 'y']) }, { id: 'g_more', value: group(['u', 'v']) }], RECORD).catch((err) => err);
    expect(past).toBeInstanceOf(BatchNotWritten);
    expect(past.status).toBe(413);
    expect((await groupStore.get(ctx, 'g1'))!.members).toEqual(['t1a', 't1b']);
    expect(await groupStore.get(ctx, 'g_more')).toBeNull();

    for (let i = 0; i < 150; i++) await saveManualAccount(ctx, { account_id: `manual_${i}`, name: `A${i}`, institution_name: 'Manual', type: 'other', subtype: null, balance: 1, updated_at: '2026-10-01T00:00:00.000Z' } as never);
    const more = await writeBatch(ctx, 'manual-accounts', [{ id: 'manual_more', value: { account_id: 'manual_more', name: 'More', institution_name: 'Manual', type: 'other', subtype: null, balance: 1, updated_at: '2026-10-01T00:00:00.000Z' } }], RECORD).catch((err) => err);
    expect(more).toBeInstanceOf(BatchNotWritten);
    expect(more.status).toBe(413);
  });

  test('a part this version doesn’t write is refused', async () => {
    expect(await writeBatch(ctx, 'store:connection-syncs', [{ id: 'x', value: {} }], RECORD).catch((err) => err)).toBeInstanceOf(BatchNotWritten);
    expect(await writeBatch(ctx, 'history:somewhere', [{ date: '2026-01-01', value: 1 }], RECORD).catch((err) => err)).toBeInstanceOf(TypeError);
  });
});
