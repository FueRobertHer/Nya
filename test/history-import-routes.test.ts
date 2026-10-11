import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Importing history into a linked account, as the app calls it:
// app/api/history-import (review, import, list, undo), the stores it keeps
// (lib/history-import/store.ts), the merge of the rows into the shared read
// layer (lib/activity.ts) with a later sync's supersede, a re-link, and what
// is said about the rows; and the route's validation and its answers to what
// the storage seam refuses.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// What a later sync brings: rows the bank sends after the import, rows it
// takes back, how far its pull of the history has got, and how long it takes
// to answer (Plaid is over the network).
const plaid = { later: [] as unknown[], removed: [] as string[], status: 'HISTORICAL_UPDATE_COMPLETE', delay: 0 };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => {
      if (plaid.delay > 0) await new Promise((r) => setTimeout(r, plaid.delay));
      return {
        data: {
          added: plaid.later.splice(0),
          modified: [],
          removed: plaid.removed.splice(0).map((transaction_id) => ({ transaction_id })),
          accounts: [],
          next_cursor: 'c-next',
          has_more: false,
          transactions_update_status: plaid.status,
        },
      };
    },
  },
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem, removeItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { linkAccounts, unlinkAccount, forgetEarlierAccount, recordDirectory } = await import('@/lib/links');
const { setExcluded, txnAnnotationStore } = await import('@/lib/txn-annotations');
const { getOverrides } = await import('@/lib/overrides');
const { assembleBankRows, finishActivity } = await import('@/lib/activity');
const { importedTxnStore, historyImportStore, historyImportSummaryStore } = await import('@/lib/history-import/store');
const routes = await import('@/app/api/history-import/route');
const transactions = await import('@/app/api/transactions/route');
const recategorize = await import('@/app/api/recategorize/route');

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const compact = (d: string) => d.replace(/-/g, '');

/** A bank's row as Plaid's store keeps it (lib/transactions.ts StoredTxn). */
function bankTxn(id: string, account_id: string, days: number, amount: number, over: Record<string, unknown> = {}) {
  return {
    transaction_id: id,
    pending_transaction_id: null,
    account_id,
    amount,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date: daysAgo(days),
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
    payment_channel: 'in store',
    transaction_code: null,
    transaction_type: null,
    check_number: null,
    account_owner: null,
    location: null,
    payment_meta: null,
    counterparties: [],
    category: 'general merchandise',
    account_name: 'Checking',
    institution_name: 'Chase',
    ...over,
  };
}

const BANK = [
  bankTxn('b_first', 'acc_chk', 60, 10, { name: 'FIRST ROW' }),
  bankTxn('b_rent', 'acc_chk', 55, 1850, { name: 'ZELLE PAYMENT TO LANDLORD' }),
  bankTxn('b_pay', 'acc_chk', 45, -2500, { name: 'ACME PAYROLL', category: 'income' }),
  bankTxn('b_coffee1', 'acc_chk', 40, 4.5, { name: 'SQ *BLUE BOTTLE', merchant_name: 'Blue Bottle Coffee' }),
  bankTxn('b_coffee2', 'acc_chk', 37, 4.5, { name: 'SQ *BLUE BOTTLE', merchant_name: 'Blue Bottle Coffee' }),
  bankTxn('b_recent', 'acc_chk', 3, 20, { name: 'GROCER' }),
  bankTxn('b_pending', 'acc_chk', 1, 15, { name: 'LUNCH', pending: true }),
  bankTxn('b_card', 'acc_card', 20, 80, { name: 'CARD SHOP', account_name: 'Visa' }),
];

/** An OFX 2.x checking statement with these transactions (Plaid's sign
 *  reversed: an OFX debit is negative), covering `start` to `end`. */
function ofx(trns: { fitid: string; days: number; amount: number; name: string }[], period: { start: number; end: number }, acct = '0009991111') {
  const list = trns
    .map((t) => `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${compact(daysAgo(t.days))}120000[-5:EST]</DTPOSTED><TRNAMT>${t.amount.toFixed(2)}</TRNAMT><FITID>${t.fitid}</FITID><NAME>${t.name}</NAME></STMTTRN>`)
    .join('\n');
  return `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>325081403</BANKID><ACCTID>${acct}</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>${compact(daysAgo(period.start))}</DTSTART><DTEND>${compact(daysAgo(period.end))}</DTEND>\n${list}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

const FILE_ROWS = [
  { fitid: 'F_old1', days: 300, amount: -100, name: 'OLD STORE' },
  { fitid: 'F_old2', days: 200, amount: 500, name: 'OLD DEPOSIT' },
  { fitid: 'F_rent', days: 55, amount: -1850, name: 'Online Transfer to Landlord' },
  { fitid: 'F_mid', days: 50, amount: -60, name: 'CORNER SHOP' },
  { fitid: 'F_pay', days: 45, amount: 2500, name: 'PAYROLL ACME CORP' },
  { fitid: 'F_coffee1', days: 41, amount: -4.5, name: 'BLUE BOTTLE COFFEE' },
  { fitid: 'F_coffee2', days: 37, amount: -4.5, name: 'BLUE BOTTLE COFFEE' },
];
const STATEMENT = ofx(FILE_ROWS, { start: 365, end: 35 });

async function seed(c = ctx) {
  await saveItem(c, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-chase') });
  await fake.hset(ctxKey('accounts:meta', c), {
    item_chase: await encrypt(
      JSON.stringify([
        { account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' },
        { account_id: 'acc_card', name: 'Visa', official_name: null, mask: '2222', type: 'credit', subtype: 'credit card', limit: 5000, currency: 'USD' },
      ])
    ),
  });
  const accounts = {
    acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
    acc_card: { name: 'Visa', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: null },
  };
  await fake.set(
    ctxKey('txns:item_chase', c),
    await encodeJsonBlob({ schema_version: 2, cursor: 'c1', accounts, txns: Object.fromEntries(BANK.map((t) => [t.transaction_id, t])), synced_at: new Date().toISOString() })
  );
}

type Res = { status: number; body: any };
const asRes = async (res: Response): Promise<Res> => ({ status: res.status, body: await res.json() });

function upload(meta: Record<string, unknown>, file: string, name = 'statement.ofx'): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(file) as Uint8Array<ArrayBuffer>]), name);
  form.set('meta', JSON.stringify({ file_name: name, ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
}
const post = async (meta: Record<string, unknown>, file: string, name?: string) => asRes(await routes.POST(upload(meta, file, name)));
const preview = (account_id: string, file: string, extra: Record<string, unknown> = {}) => post({ action: 'preview', account_id, ...extra }, file);
/** Reviews the file, then imports it with that review and these choices. */
async function importReviewed(account_id: string, file: string, extra: Record<string, unknown> = {}) {
  const p = await preview(account_id, file, extra);
  expect(p.status).toBe(200);
  return post({ action: 'import', account_id, review: p.body.preview.review, ...extra }, file);
}
const list = async (account_id: string) => asRes(await routes.GET(new Request(`http://localhost/api/history-import?account_id=${account_id}`)));
const undo = async (body: object) =>
  asRes(await routes.DELETE(new Request('http://localhost/api/history-import', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })));
const activity = async (c = ctx) => {
  const bank = await assembleBankRows(c, { sync: false, readOnly: true, withAccountIds: true });
  return finishActivity(c, bank.payload, bank.hidden);
};
const book = async (account_id = 'acc_chk') => (await importedTxnStore.get(ctx, account_id))?.rows ?? [];

/** Every key the fake holds, with its value(s) as stored. */
function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of (fake as any).strings as Map<string, string>) out[k] = v;
  for (const [k, h] of (fake as any).hashes as Map<string, Map<string, string>>) out[k] = Object.fromEntries(h);
  return out;
}
const changedKeys = (before: Record<string, unknown>, after: Record<string, unknown>) =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = saved;
  }
}

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  plaid.later = [];
  plaid.removed = [];
  plaid.status = 'HISTORICAL_UPDATE_COMPLETE';
  plaid.delay = 0;
  await registerTestContainer(fake);
  delete process.env.MAX_TXN_BLOB_CHARS;
  await seed();
});

describe('the review', () => {
  test('a statement overlapping the bank’s window: likely duplicates beside the bank’s rows, the new rows, and how much is older than the bank’s own; nothing written', async () => {
    const before = snapshot();
    const { status, body } = await preview('acc_chk', STATEMENT);
    expect(status).toBe(200);
    const p = body.preview;
    expect(p.counts).toMatchObject({ new: 3, duplicates: 4, present: 0, unanswered: 0 });
    expect(p.proposals.map((x: any) => [x.file.name, x.twin.id, x.days, x.confidence, x.choice])).toEqual([
      ['Online Transfer to Landlord', 'b_rent', 0, 'high', 'same'],
      ['PAYROLL ACME CORP', 'b_pay', 0, 'high', 'same'],
      ['BLUE BOTTLE COFFEE', 'b_coffee1', 1, 'high', 'same'],
      ['BLUE BOTTLE COFFEE', 'b_coffee2', 0, 'high', 'same'],
    ]);
    expect(p.proposals[2].twin).toMatchObject({ name: 'Blue Bottle Coffee', descriptor: 'SQ *BLUE BOTTLE', amount: 4.5 });
    expect([p.bank_from, p.before_bank, p.within_bank]).toEqual([daysAgo(60), 2, 1]);
    // The statement's own period, from its DTSTART and DTEND.
    expect(p.covers).toEqual({ from: daysAgo(365), to: daysAgo(35), stated: false });
    expect(p.review).toMatch(/^[0-9a-f]{32}$/);
    expect(changedKeys(before, snapshot())).toEqual([ctxKey('import-requests')]);
  });

  test('a CSV overlapping the bank’s window, read by its columns: proposals beside the bank’s rows, nothing merged or written until the import', async () => {
    const csv = [
      'Date,Description,Amount',
      `${daysAgo(55)},Online Transfer to Landlord,-1850.00`,
      // The bank posted the pay a day later than the bank's own export dates it.
      `${daysAgo(46)},PAYROLL ACME CORP,2500.00`,
      `${daysAgo(250)},OLD SHOP,-42.10`,
    ].join('\n');
    const options = { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } };
    const before = snapshot();
    const p = await post({ action: 'preview', account_id: 'acc_chk', options }, csv, 'export.csv');
    expect(p.status).toBe(200);
    expect(p.body.preview.format).toBe('csv');
    expect(p.body.preview.counts).toMatchObject({ new: 1, duplicates: 1, unanswered: 1 });
    // The pay posted the day after the file's last day: the same only through
    // that lag, so possibly the same, with why, and waiting for an answer.
    expect(p.body.preview.proposals.map((x: any) => [x.file.name, x.file.amount, x.twin.id, x.days, x.confidence, x.choice, x.edge?.kind ?? null]).sort()).toEqual([
      ['Online Transfer to Landlord', 1850, 'b_rent', 0, 'high', 'same', null],
      ['PAYROLL ACME CORP', -2500, 'b_pay', 1, 'low', null, 'outside-file'],
    ]);
    expect(changedKeys(before, snapshot())).toEqual([ctxKey('import-requests')]);
    // Answered for the pay (its own), and imported as reviewed.
    const choices = { proposals: { each: { [p.body.preview.proposals.find((x: any) => x.twin.id === 'b_pay').index]: 'new' } } };
    const done = await post({ action: 'import', account_id: 'acc_chk', options, choices, review: p.body.preview.review }, csv, 'export.csv');
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ imported: 2, duplicates: 1 });
    const rows = await book();
    expect(rows.map((r) => [r.name, r.amount, r.source, !!r.same_as]).sort()).toEqual([
      ['OLD SHOP', 42.1, 'import:csv', false],
      ['Online Transfer to Landlord', 1850, 'import:csv', true],
      ['PAYROLL ACME CORP', -2500, 'import:csv', false],
    ]);
    // Its own, so counted beside the bank's, which nothing else can claim now.
    expect((await activity()).transactions.filter((t) => t.amount === -2500).length).toBe(2);
  });

  test('a period the person says the file covers widens it, and never leaves a row out', async () => {
    const wider = await preview('acc_chk', STATEMENT, { covers: { from: daysAgo(400), to: daysAgo(30) } });
    expect(wider.body.preview.covers).toEqual({ from: daysAgo(400), to: daysAgo(30), stated: true });
    const narrower = await preview('acc_chk', STATEMENT, { covers: { from: daysAgo(250), to: daysAgo(30) } });
    expect(narrower.status).toBe(400);
    expect(narrower.body.error).toContain('must hold every row');
  });
});

describe('the import', () => {
  test('keeps the new rows counted and the bank’s duplicates uncounted, with each record’s raw form; Activity shows the new rows beside the bank’s', async () => {
    const { status, body } = await importReviewed('acc_chk', STATEMENT);
    expect(status).toBe(200);
    expect(body).toMatchObject({ imported: 3, duplicates: 4, present: 0, before_bank: 2 });
    const rows = await book();
    expect(rows.length).toBe(7);
    expect(rows.filter((r) => r.same_as).length).toBe(4);
    for (const r of rows) {
      expect(r.source).toBe('import:ofx');
      expect(r.source_id).toMatch(/^F_/);
      expect(r.import_id).toBe(body.import_id);
    }
    const entry = (await historyImportStore.get(ctx, body.import_id))!;
    expect(entry.records.length).toBe(7);
    for (const r of entry.records) {
      expect(r.raw).toBeTruthy();
      expect(rows.some((row) => row.id === r.row_id)).toBe(true);
    }
    expect(entry.covers).toEqual({ from: daysAgo(365), to: daysAgo(35), stated: false });

    const { transactions: shown } = await activity();
    const imported = shown.filter((t) => t.source === 'import:ofx');
    expect(imported.map((t) => t.name).sort()).toEqual(['CORNER SHOP', 'OLD DEPOSIT', 'OLD STORE']);
    expect(imported[0]).toMatchObject({ account_id: 'acc_chk', account_name: 'Checking', institution_name: 'Chase', pending: false });
    // The bank's own rows are all still there, the duplicates' twins among them.
    expect(shown.filter((t) => !t.source).map((t) => t.transaction_id)).toContain('b_rent');
    // Plaid's sign: the old deposit is money in.
    expect(imported.find((t) => t.name === 'OLD DEPOSIT')!.amount).toBe(-500);
  });

  test('importing the same OFX file again changes nothing: every row is found by its FITID', async () => {
    await importReviewed('acc_chk', STATEMENT);
    const before = snapshot();
    const { status, body } = await importReviewed('acc_chk', STATEMENT);
    expect(status).toBe(200);
    expect(body).toMatchObject({ import_id: null, imported: 0, duplicates: 0, present: 7 });
    expect(changedKeys(before, snapshot()).filter((k) => !k.endsWith('import-requests') && !k.endsWith('import-settings'))).toEqual([]);
  });

  test('refused, with nothing written, when the bank sent a row since the review that changes it', async () => {
    const p = await preview('acc_chk', STATEMENT);
    plaid.later.push(bankTxn('b_mid', 'acc_chk', 50, 60, { name: 'CORNER SHOP #12' }));
    await transactions.GET(new Request('http://localhost/api/transactions'));
    const before = snapshot();
    const { status, body } = await post({ action: 'import', account_id: 'acc_chk', review: p.body.preview.review }, STATEMENT);
    expect(status).toBe(409);
    expect(body.needs).toBe('review');
    expect(changedKeys(before, snapshot()).filter((k) => !k.endsWith('import-requests'))).toEqual([]);
    // Reviewed again, the new bank row is a proposal.
    const again = await preview('acc_chk', STATEMENT);
    expect(again.body.preview.proposals.some((x: any) => x.twin.id === 'b_mid')).toBe(true);
  });

  test('refused while a low-confidence proposal has no answer; imported once it has one', async () => {
    const file = ofx([{ fitid: 'L1', days: 55 - 4, amount: -1850, name: 'SOMETHING ELSE' }], { start: 60, end: 50 });
    const p = await preview('acc_chk', file);
    expect(p.body.preview.proposals).toEqual([expect.objectContaining({ confidence: 'low', choice: null })]);
    const refused = await post({ action: 'import', account_id: 'acc_chk', review: p.body.preview.review }, file);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ needs: 'answers', count: 1 });
    expect(await book()).toEqual([]);
    const answered = await post({ action: 'import', account_id: 'acc_chk', review: p.body.preview.review, choices: { proposals: { each: { [p.body.preview.proposals[0].index]: 'new' } } } }, file);
    expect(answered.body).toMatchObject({ imported: 1, duplicates: 0 });
    // Kept apart from the bank's row the person said it isn't.
    expect((await book())[0].distinct_from?.length).toBe(1);
  });

  test('refused whole past the size ceiling, never trimmed, and the person is told', async () => {
    process.env.MAX_TXN_BLOB_CHARS = '600';
    const before = snapshot();
    const { status, body } = await quietly(() => importReviewed('acc_chk', STATEMENT));
    expect(status).toBe(413);
    expect(body.error).toMatch(/too large/);
    expect(changedKeys(before, snapshot()).filter((k) => !k.endsWith('import-requests'))).toEqual([]);
  });
});

describe('a later sync', () => {
  test('that returns an imported period supersedes the imported rows instead of counting them twice', async () => {
    const { body } = await importReviewed('acc_chk', STATEMENT);
    plaid.later.push(bankTxn('b_mid', 'acc_chk', 49, 60, { name: 'CORNER SHOP #12' }), bankTxn('b_old1', 'acc_chk', 301, 100, { name: 'OLD STORE 44' }));
    await transactions.GET(new Request('http://localhost/api/transactions'));
    const { transactions: shown } = await activity();
    expect(shown.filter((t) => t.source === 'import:ofx').map((t) => t.name)).toEqual(['OLD DEPOSIT']);
    expect(shown.map((t) => t.transaction_id)).toEqual(expect.arrayContaining(['b_mid', 'b_old1']));
    // Kept, and said so in the list of imports.
    expect((await book()).length).toBe(7);
    const listed = await list('acc_chk');
    expect(listed.body.imports[0]).toMatchObject({ id: body.import_id, rows_now: 1, duplicates_now: 4, superseded_now: 2, returned_now: 0 });
  });

  test('a pending row stands in for its look-alike while it is pending, so the month never counts it twice; once posted, the posted row supersedes', async () => {
    const { body } = await importReviewed('acc_chk', ofx([{ fitid: 'P1', days: 1, amount: -15, name: 'LUNCH SPOT' }], { start: 2, end: 1 }));
    expect(body.imported).toBe(1);
    const pending = (await activity()).transactions;
    expect(pending.filter((t) => t.source === 'import:ofx')).toEqual([]);
    expect(pending.filter((t) => t.amount === 15).map((t) => t.transaction_id)).toEqual(['b_pending']);
    plaid.later.push(bankTxn('b_lunch_posted', 'acc_chk', 0, 15, { name: 'LUNCH', pending_transaction_id: 'b_pending' }));
    await transactions.GET(new Request('http://localhost/api/transactions'));
    expect((await activity()).transactions.filter((t) => t.source === 'import:ofx').length).toBe(0);
    // The estimated history walks posted rows only: the imported lunch counts there.
    const { countedRows } = await import('@/lib/history-import/read');
    const settled = countedRows(await book(), [{ transaction_id: 'b_pending', account_id: 'acc_chk', date: daysAgo(1), amount: 15, currency: 'USD', name: 'LUNCH', merchant_name: null, pending: true }], [], { bankFrom: daysAgo(60) });
    expect(settled.counted.length).toBe(1);
  });

  test('after a re-link the imported rows follow the account, and the new connection’s rows supersede them', async () => {
    await importReviewed('acc_chk', STATEMENT);
    // The institution is disconnected and added again: a new Item, a new id for
    // the same account, history further back.
    await removeItem(ctx, 'item_chase');
    await fake.del(ctxKey('txns:item_chase'));
    await saveItem(ctx, { item_id: 'item_chase2', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-chase-2') });
    await fake.hset(ctxKey('accounts:meta'), {
      item_chase2: await encrypt(JSON.stringify([{ account_id: 'acc_chk_new', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }])),
    });
    await fake.hdel(ctxKey('accounts:meta'), 'item_chase');
    await fake.set(
      ctxKey('txns:item_chase2'),
      await encodeJsonBlob({
        schema_version: 2,
        cursor: 'c1',
        accounts: { acc_chk_new: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } },
        txns: Object.fromEntries([bankTxn('n_old1', 'acc_chk_new', 300, 100, { name: 'OLD STORE' }), bankTxn('n_rent', 'acc_chk_new', 55, 1850, { name: 'ZELLE PAYMENT TO LANDLORD' })].map((t) => [t.transaction_id, t])),
        synced_at: new Date().toISOString(),
      })
    );
    // Before the person links them, the earlier account's imported rows show
    // nowhere: it isn't live.
    expect((await activity()).transactions.filter((t) => t.source === 'import:ofx')).toEqual([]);
    await linkAccounts(ctx, 'acc_chk', 'acc_chk_new', { basis: 'by_hand' });
    const shown = (await activity()).transactions.filter((t) => t.source === 'import:ofx');
    // OLD STORE is the new connection's own now; CORNER SHOP and OLD DEPOSIT
    // the bank never had. The rent duplicate stands for the bank's rent by its
    // key, which survives the re-link. The pay and the two coffees were kept as
    // the old connection's rows, which the new one doesn't have: they count
    // again, never lost with the old connection's store.
    expect(shown.map((t) => [t.name, t.account_id]).sort()).toEqual([
      ['BLUE BOTTLE COFFEE', 'acc_chk_new'],
      ['BLUE BOTTLE COFFEE', 'acc_chk_new'],
      ['CORNER SHOP', 'acc_chk_new'],
      ['OLD DEPOSIT', 'acc_chk_new'],
      ['PAYROLL ACME CORP', 'acc_chk_new'],
    ]);
    // Listed, and undone, from the account's current id.
    const listed = await list('acc_chk_new');
    expect(listed.body.imports.length).toBe(1);
    const undone = await undo({ account_id: 'acc_chk_new', import_id: listed.body.imports[0].id, confirm: true });
    expect(undone.body).toMatchObject({ removed: 3, duplicates: 4 });
    expect((await activity()).transactions.filter((t) => t.source === 'import:ofx')).toEqual([]);
  });
});

describe('as the bank’s rows change after the review', () => {
  test('a duplicate counts again once the bank no longer has its row: one the bank takes back, and the list says so', async () => {
    const { body } = await importReviewed('acc_chk', STATEMENT);
    expect((await activity()).transactions.some((t) => t.name === 'Online Transfer to Landlord')).toBe(false);
    plaid.removed.push('b_rent');
    await transactions.GET(new Request('http://localhost/api/transactions'));
    const shown = (await activity()).transactions;
    expect(shown.some((t) => t.transaction_id === 'b_rent')).toBe(false);
    expect(shown.filter((t) => t.name === 'Online Transfer to Landlord').map((t) => [t.amount, t.date, t.source])).toEqual([[1850, daysAgo(55), 'import:ofx']]);
    const listed = await list('acc_chk');
    expect(listed.body.imports[0]).toMatchObject({ id: body.import_id, rows_now: 4, duplicates_now: 3, superseded_now: 0, returned_now: 1 });
  });

  test('the load whose sync brings the bank’s row shows it in place of the imported one, in its own answer and in the one it caches', async () => {
    const { body } = await importReviewed('acc_chk', ofx([{ fitid: 'R', days: 20, amount: -1850, name: 'RENT' }], { start: 40, end: 4 }));
    expect(body.imported).toBe(1);
    // Plaid answers over the network, after the imported rows could be read.
    plaid.delay = 50;
    plaid.later.push(bankTxn('b_rent2', 'acc_chk', 20, 1850, { name: 'RENT PAYMENT' }));
    const rents = (answer: any) => answer.transactions.filter((t: any) => t.amount === 1850 && t.date === daysAgo(20)).map((t: any) => t.transaction_id);
    const first = await (await transactions.GET(new Request('http://localhost/api/transactions'))).json();
    expect(first.from_cache).toBe(false);
    expect(rents(first)).toEqual(['b_rent2']);
    const second = await (await transactions.GET(new Request('http://localhost/api/transactions'))).json();
    expect(second.from_cache).toBe(true);
    expect(rents(second)).toEqual(['b_rent2']);
  });

  test('each connection’s rows are read once for a load: the imported rows are matched against what the bank part read', async () => {
    await importReviewed('acc_chk', STATEMENT);
    const get = fake.get.bind(fake);
    let reads = 0;
    (fake as any).get = async (key: string) => {
      if (key === ctxKey('txns:item_chase')) reads++;
      return get(key);
    };
    try {
      await activity();
      expect(reads).toBe(1);
      reads = 0;
      await transactions.GET(new Request('http://localhost/api/transactions?refresh=1'));
      expect(reads).toBe(1);
    } finally {
      (fake as any).get = get;
    }
  });

  test('what the person said about an imported row carries to the bank’s row that takes its place, unless they say otherwise on that row', async () => {
    await importReviewed('acc_chk', STATEMENT);
    const shop = (await activity()).transactions.find((t) => t.name === 'CORNER SHOP')!;
    await setExcluded(ctx, shop.transaction_id, true);
    const recategorized = (transaction_id: string, category: string) =>
      recategorize.POST(new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id, category }) }));
    await recategorized(shop.transaction_id, 'groceries');
    // The bank sends the same purchase: its row takes the imported one's place,
    // excluded and in groceries, as the person left it.
    plaid.later.push(bankTxn('b_mid', 'acc_chk', 49, 60, { name: 'CORNER SHOP #12' }));
    await transactions.GET(new Request('http://localhost/api/transactions'));
    const shown = (await activity()).transactions;
    expect(shown.some((t) => t.transaction_id === shop.transaction_id)).toBe(false);
    expect(shown.find((t) => t.transaction_id === 'b_mid')).toMatchObject({ category: 'groceries', excluded: true });
    // The bank row's own category and exclusion win.
    await recategorized('b_mid', 'household');
    await setExcluded(ctx, 'b_mid', false);
    const own = (await activity()).transactions.find((t) => t.transaction_id === 'b_mid')!;
    expect(own.category).toBe('household');
    expect(own.excluded).toBeUndefined();
  });

  test('while the bank’s pull of the connection’s history is still arriving, the review and the list say so; once it is done, they don’t', async () => {
    plaid.status = 'INITIAL_UPDATE_COMPLETE';
    await transactions.GET(new Request('http://localhost/api/transactions?refresh=1'));
    expect((await list('acc_chk')).body.history_pending).toBe(true);
    expect((await preview('acc_chk', STATEMENT)).body.preview.history_pending).toBe(true);
    plaid.status = 'HISTORICAL_UPDATE_COMPLETE';
    await transactions.GET(new Request('http://localhost/api/transactions?refresh=1'));
    expect((await list('acc_chk')).body.history_pending).toBe(false);
    expect((await preview('acc_chk', STATEMENT)).body.preview.history_pending).toBe(false);
  });

  test('a CSV and then the OFX of the same days: each OFX row is proposed as the CSV’s, named by its file, and the same keeps it once', async () => {
    const csv = ['Date,Description,Amount', `${daysAgo(300)},OLD STORE PURCHASE 0042,-100.00`, `${daysAgo(200)},DEPOSIT FROM EMPLOYER,500.00`].join('\n');
    const options = { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } };
    const p1 = await post({ action: 'preview', account_id: 'acc_chk', options }, csv, 'export.csv');
    const first = await post({ action: 'import', account_id: 'acc_chk', options, review: p1.body.preview.review }, csv, 'export.csv');
    expect(first.body).toMatchObject({ imported: 2 });

    const file = ofx(
      [
        { fitid: 'X1', days: 300, amount: -100, name: 'OLD STORE' },
        { fitid: 'X2', days: 200, amount: 500, name: 'OLD DEPOSIT' },
        { fitid: 'X3', days: 250, amount: -7, name: 'NEWSSTAND' },
      ],
      { start: 330, end: 150 }
    );
    const p = await preview('acc_chk', file);
    expect(p.body.preview.counts).toMatchObject({ new: 1, already: 2, duplicates: 0, unanswered: 0 });
    expect(p.body.preview.proposals.map((x: any) => [x.file.name, x.twin.kind, x.twin.name, x.twin.file_name, x.choice]).sort()).toEqual([
      ['OLD DEPOSIT', 'imported', 'DEPOSIT FROM EMPLOYER', 'export.csv', 'same'],
      ['OLD STORE', 'imported', 'OLD STORE PURCHASE 0042', 'export.csv', 'same'],
    ]);
    const second = await post({ action: 'import', account_id: 'acc_chk', review: p.body.preview.review }, file);
    expect(second.body).toMatchObject({ imported: 1, already: 2 });
    const imported = async () =>
      (await activity()).transactions
        .filter((t) => t.source)
        .map((t) => [t.name, t.source])
        .sort();
    expect(await imported()).toEqual([
      ['DEPOSIT FROM EMPLOYER', 'import:csv'],
      ['NEWSSTAND', 'import:ofx'],
      ['OLD STORE PURCHASE 0042', 'import:csv'],
    ]);
    // The OFX's rows are kept as the CSV's: undone, the CSV leaves them counted.
    expect((await book()).filter((r) => r.same_as_row).length).toBe(2);
    await undo({ account_id: 'acc_chk', import_id: first.body.import_id, confirm: true });
    expect(await imported()).toEqual([
      ['NEWSSTAND', 'import:ofx'],
      ['OLD DEPOSIT', 'import:ofx'],
      ['OLD STORE', 'import:ofx'],
    ]);
  });

  test('the first OFX file of an account is checked against its number as the bank gives it: another account’s waits for the person to say it is right', async () => {
    const other = ofx([{ fitid: 'Z1', days: 300, amount: -10, name: 'ELSEWHERE' }], { start: 330, end: 290 }, '0009992222');
    const p = await preview('acc_chk', other);
    expect(p.body.preview.account_mismatch).toMatchObject({ basis: 'mask', expected: 'an account ending 1111' });
    const refused = await post({ action: 'import', account_id: 'acc_chk', review: p.body.preview.review }, other);
    expect(refused.status).toBe(409);
    expect(refused.body.account_mismatch.basis).toBe('mask');
    expect(await book()).toEqual([]);
    const done = await post({ action: 'import', account_id: 'acc_chk', review: p.body.preview.review, acknowledge_account: true }, other);
    expect(done.body.imported).toBe(1);
    // Its own number matches: nothing to ask.
    expect((await preview('acc_card', ofx([], { start: 330, end: 290 }, '4111000000002222'))).body.preview.account_mismatch).toBeNull();
  });
});

describe('forgetting an earlier account', () => {
  test('hands the rows a later import into the account it was linked to found already there to that import, with what was said about them', async () => {
    await importReviewed('acc_chk', ofx(FILE_ROWS.slice(0, 2), { start: 365, end: 150 }));
    await recordDirectory(ctx, [
      { item_id: 'item_chase', institution_name: 'Chase', error: null, accounts: [{ account_id: 'acc_chk', type: 'depository', subtype: 'checking', name: 'Checking', mask: '1111' }] },
    ] as any);
    // Re-linked as a new connection, and the same statement imported into it:
    // its rows are found already there, under the earlier account.
    await removeItem(ctx, 'item_chase');
    await fake.del(ctxKey('txns:item_chase'));
    await fake.hdel(ctxKey('accounts:meta'), 'item_chase');
    await saveItem(ctx, { item_id: 'item_chase2', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-chase-2') });
    await fake.hset(ctxKey('accounts:meta'), {
      item_chase2: await encrypt(JSON.stringify([{ account_id: 'acc_chk_new', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }])),
    });
    await fake.set(
      ctxKey('txns:item_chase2'),
      await encodeJsonBlob({
        schema_version: 2,
        cursor: 'c1',
        accounts: { acc_chk_new: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } },
        txns: { n_rent: bankTxn('n_rent', 'acc_chk_new', 55, 1850, { name: 'ZELLE PAYMENT TO LANDLORD' }) },
        synced_at: new Date().toISOString(),
      })
    );
    await linkAccounts(ctx, 'acc_chk', 'acc_chk_new', { basis: 'by_hand' });
    const later = await importReviewed('acc_chk_new', ofx([...FILE_ROWS.slice(0, 2), { fitid: 'F_more', days: 120, amount: -9, name: 'MORE' }], { start: 365, end: 100 }));
    expect(later.body).toMatchObject({ imported: 1, present: 2 });
    const deposit = (await activity()).transactions.find((t) => t.name === 'OLD DEPOSIT')!;
    await setExcluded(ctx, deposit.transaction_id, true);

    // Unlinked, then forgotten: the later import keeps its transactions.
    await unlinkAccount(ctx, 'acc_chk');
    await forgetEarlierAccount(ctx, 'acc_chk');
    expect(await book('acc_chk')).toEqual([]);
    const kept = await book('acc_chk_new');
    expect(kept.map((r) => [r.name, r.account_id, r.import_id]).sort()).toEqual([
      ['MORE', 'acc_chk_new', later.body.import_id],
      ['OLD DEPOSIT', 'acc_chk_new', later.body.import_id],
      ['OLD STORE', 'acc_chk_new', later.body.import_id],
    ]);
    const shown = (await activity()).transactions.filter((t) => t.source === 'import:ofx');
    expect(shown.map((t) => [t.name, t.account_id]).sort()).toEqual([
      ['MORE', 'acc_chk_new'],
      ['OLD DEPOSIT', 'acc_chk_new'],
      ['OLD STORE', 'acc_chk_new'],
    ]);
    expect(shown.find((t) => t.name === 'OLD DEPOSIT')!.excluded).toBe(true);
    // And undone with it.
    const undone = await undo({ account_id: 'acc_chk_new', import_id: later.body.import_id, confirm: true });
    expect(undone.body).toMatchObject({ removed: 3 });
    expect(await book('acc_chk_new')).toEqual([]);
  });
});

describe('undo', () => {
  test('restores the account exactly as it was before the import, what was said about its rows included', async () => {
    const before = snapshot();
    const { body } = await importReviewed('acc_chk', STATEMENT);
    const shown = (await activity()).transactions.find((t) => t.name === 'CORNER SHOP')!;
    await setExcluded(ctx, shown.transaction_id, true);
    expect((await asRes(await recategorize.POST(new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id: shown.transaction_id, category: 'groceries' }) })))).status).toBe(200);
    // The category and the exclusion work on it as on any row.
    const again = (await activity()).transactions.find((t) => t.transaction_id === shown.transaction_id)!;
    expect(again).toMatchObject({ category: 'groceries', excluded: true });

    const planned = asRes(await routes.GET(new Request(`http://localhost/api/history-import?account_id=acc_chk&undo=${body.import_id}`)));
    expect((await planned).body.undo).toMatchObject({ remove: 3, duplicates: 4, kept: [] });
    const undone = await undo({ account_id: 'acc_chk', import_id: body.import_id, confirm: true });
    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({ removed: 3, duplicates: 4, kept: 0 });
    expect(await getOverrides(ctx)).toEqual({});
    expect((await txnAnnotationStore.getAll(ctx)).size).toBe(0);
    // Everything but the request counters, how the file was read (remembered
    // for the next file), the walk's own bookkeeping and the caches is as it was.
    const bookkeeping = (k: string) => /import-(requests|reads|settings)$|imported-history-walk$|:cache:/.test(k);
    expect(changedKeys(before, snapshot()).filter((k) => !bookkeeping(k))).toEqual([]);
    expect((await undo({ account_id: 'acc_chk', import_id: body.import_id, confirm: true })).status).toBe(404);
  });

  test('a row a later import found already there is kept for it, and goes with that one’s undo', async () => {
    const first = await importReviewed('acc_chk', ofx(FILE_ROWS.slice(0, 2), { start: 365, end: 150 }));
    const second = await importReviewed('acc_chk', ofx(FILE_ROWS.slice(0, 3), { start: 365, end: 50 }));
    expect(second.body).toMatchObject({ present: 2, duplicates: 1 });
    const undone = await undo({ account_id: 'acc_chk', import_id: first.body.import_id, confirm: true });
    expect(undone.body).toMatchObject({ removed: 0, kept: 2 });
    expect((await book()).every((r) => r.import_id === second.body.import_id)).toBe(true);
    const last = await undo({ account_id: 'acc_chk', import_id: second.body.import_id, confirm: true });
    expect(last.body).toMatchObject({ removed: 2, duplicates: 1 });
    expect(await book()).toEqual([]);
  });

  test('needs its confirmation, and an import of this account', async () => {
    const { body } = await importReviewed('acc_chk', STATEMENT);
    expect((await undo({ account_id: 'acc_chk', import_id: body.import_id })).status).toBe(400);
    expect((await undo({ account_id: 'acc_card', import_id: body.import_id, confirm: true })).status).toBe(404);
    expect((await undo({ account_id: 'acc_chk', import_id: 'nope', confirm: true })).status).toBe(400);
  });
});

describe('what the route takes and how it answers', () => {
  test('only a linked account on a connection still stored', async () => {
    expect((await preview('manual_checking-1', STATEMENT)).status).toBe(400);
    expect((await preview('acc_gone', STATEMENT)).status).toBe(404);
    expect((await preview('bad id with spaces', STATEMENT)).status).toBe(400);
  });

  test('every field checked: unknown fields, choices, periods, a missing review', async () => {
    const bad = async (meta: Record<string, unknown>) => (await post({ action: 'preview', account_id: 'acc_chk', ...meta }, STATEMENT)).status;
    expect(await bad({ extra: true })).toBe(400);
    expect(await bad({ choices: { proposals: { all: 'maybe' } } })).toBe(400);
    expect(await bad({ choices: { proposals: { each: { '-1': 'same' } } } })).toBe(400);
    expect(await bad({ choices: { other: {} } })).toBe(400);
    expect(await bad({ covers: { from: '2026-02-30', to: '2026-03-01' } })).toBe(400);
    expect(await bad({ covers: { from: '2026-03-02', to: '2026-03-01' } })).toBe(400);
    expect(await bad({ options: { currency: 'XXQ' } })).toBe(400);
    expect((await post({ action: 'import', account_id: 'acc_chk' }, STATEMENT)).status).toBe(400);
    expect((await post({ action: 'import', account_id: 'acc_chk', review: 'not-a-digest' }, STATEMENT)).status).toBe(400);
  });

  test('a book of the account that can’t be read: 409, flagged unreadable with its id, and nothing written', async () => {
    await importReviewed('acc_chk', STATEMENT);
    await fake.hset(ctxKey('imported-transactions'), { acc_chk: 'not ciphertext' });
    const before = snapshot();
    const { status, body } = await quietly(() => preview('acc_chk', STATEMENT));
    expect(status).toBe(409);
    expect(body).toMatchObject({ unreadable: true, unreadable_ids: ['acc_chk'] });
    expect(changedKeys(before, snapshot()).filter((k) => !k.endsWith('import-requests'))).toEqual([]);
    // Activity says so, and shows the bank's rows.
    const shown = await activity();
    expect(shown.notes).toContain("Chase: transactions imported for Checking couldn't be read");
    expect(shown.transactions.some((t) => t.transaction_id === 'b_rent')).toBe(true);
  });

  test('a connection whose accounts can’t be read: its accounts’ imported rows aren’t shown, and Activity says so', async () => {
    await importReviewed('acc_chk', STATEMENT);
    await fake.hset(ctxKey('accounts:meta'), { item_chase: 'damaged' });
    const shown = await quietly(() => activity());
    expect(shown.transactions.some((t) => t.source === 'import:ofx')).toBe(false);
    expect(shown.notes).toContain("Chase: transactions imported for its accounts aren't shown while its accounts can't be read");
  });

  test('the bank’s store can’t be read: 409, and no file is matched against nothing', async () => {
    await fake.set(ctxKey('txns:item_chase'), 'damaged');
    const { status, body } = await quietly(() => preview('acc_chk', STATEMENT));
    expect(status).toBe(409);
    expect(body.error).toContain('can’t be read just now');
  });

  test('storage failing is a 500 that says nothing of the file; no container is a 503', async () => {
    fake.failNext('hgetall', 50);
    const failed = await quietly(() => preview('acc_chk', STATEMENT));
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain('LANDLORD');
    fake.reset();
    forgetEpochs();
    const none = await quietly(() => preview('acc_chk', STATEMENT));
    expect(none.status).toBe(503);
  });
});

describe('containers', () => {
  test('an import is the container’s own: another person’s reads see none of it', async () => {
    await seed(OTHER);
    await importReviewed('acc_chk', STATEMENT);
    const theirs = await activity(OTHER);
    expect(theirs.transactions.filter((t) => t.source)).toEqual([]);
    expect((await importedTxnStore.getAll(OTHER)).size).toBe(0);
    expect((await historyImportSummaryStore.getAll(OTHER)).size).toBe(0);
  });
});
