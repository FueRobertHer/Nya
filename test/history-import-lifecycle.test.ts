import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// Rows imported into a linked account from its bank's files (#52) on an
// account that ended (#50, lib/lifecycle.ts): left out from its end day on
// wherever the bank's own are (the Activity tab, the API, spending, a report,
// which counts them as not counted), through every id the account has had,
// and counted before it; kept in the download and its OFX statement. An
// account its bank stopped returning once it closed keeps its imported rows
// before its end, and takes a file all the same, the review saying what of
// it counts in nothing.
//
// The lifecycle's questions reading the bank's own are in
// test/lifecycle-detection.test.ts.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.MAX_TXN_BLOB_CHARS;

mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({
      data: { added: [], modified: [], removed: [], accounts: [], next_cursor: 'c-next', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
    }),
  },
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { rememberAccounts } = await import('@/lib/last-known');
const { markEnded } = await import('@/lib/lifecycle');
const { linkAccounts } = await import('@/lib/links');
const { assembleBankRows, finishActivity } = await import('@/lib/activity');
const { queryTransactions, readSpending } = await import('@/lib/api-read');
const { collectUserData, buildUserExport, exportFile, TRANSACTION_COLUMNS } = await import('@/lib/user-export');
const { ofxFile } = await import('@/lib/ofx-export');
const { importedTxnStore } = await import('@/lib/history-import/store');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const routes = await import('@/app/api/history-import/route');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const compact = (d: string) => d.replace(/-/g, '');
const shownDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

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
    category: 'general services',
    account_name: 'Checking',
    institution_name: 'Chase',
    ...over,
  };
}

const BANK = [
  bankTxn('b_rent', 'acc_chk', 55, 1850, { name: 'ZELLE PAYMENT TO LANDLORD' }),
  bankTxn('b_domain', 'acc_chk', 20, 120, { name: 'DOMAIN RENEWAL' }),
  bankTxn('b_grocer', 'acc_chk', 3, 20, { name: 'GROCER' }),
  bankTxn('b_card', 'acc_card', 10, 80, { name: 'CARD SHOP', account_name: 'Visa' }),
];

function ofx(trns: { fitid: string; days: number; amount: number; name: string }[], start: number, end: number) {
  const list = trns
    .map((t) => `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${compact(daysAgo(t.days))}</DTPOSTED><TRNAMT>${t.amount.toFixed(2)}</TRNAMT><FITID>${t.fitid}</FITID><NAME>${t.name}</NAME></STMTTRN>`)
    .join('\n');
  return `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>325081403</BANKID><ACCTID>0009991111</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>${compact(daysAgo(start))}</DTSTART><DTEND>${compact(daysAgo(end))}</DTEND>\n${list}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

const STATEMENT = ofx(
  [
    { fitid: 'F_old', days: 300, amount: -100, name: 'OLD STORE' },
    { fitid: 'F_dep', days: 200, amount: 500, name: 'OLD DEPOSIT' },
    { fitid: 'F_rent', days: 55, amount: -1850, name: 'Online Transfer to Landlord' },
    { fitid: 'F_mid', days: 50, amount: -60, name: 'CORNER SHOP' },
  ],
  320,
  35
);

const CHECKING = { type: 'depository', label: { name: 'Checking', institution: 'Chase', mask: '1111' }, item_id: 'item_chase', currency: 'USD' };

async function remember(accounts: string[]) {
  const all: Record<string, unknown> = {
    acc_chk: { account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', balance: 900, currency: 'USD' },
    acc_card: { account_id: 'acc_card', name: 'Visa', official_name: null, mask: '2222', type: 'credit', subtype: 'credit card', balance: 80, currency: 'USD' },
  };
  await rememberAccounts(ctx, [{ item_id: 'item_chase', institution_name: 'Chase', institution_id: null, error: null, accounts: accounts.map((id) => all[id]) } as any]);
}

const upload = (meta: Record<string, unknown>, file: string) => {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(file) as Uint8Array<ArrayBuffer>]), 'statement.ofx');
  form.set('meta', JSON.stringify({ file_name: 'statement.ofx', ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
};
/** Reviews a file, imports it as reviewed, and returns the review. */
async function importFile(file: string, account_id = 'acc_chk') {
  const preview = (await (await routes.POST(upload({ action: 'preview', account_id }, file))).json()).preview;
  const res = await routes.POST(upload({ action: 'import', account_id, review: preview.review }, file));
  expect(res.status).toBe(200);
  return preview;
}
const ids = async () => Object.fromEntries(((await importedTxnStore.get(ctx, 'acc_chk'))?.rows ?? []).map((r) => [r.name, r.id]));
const listed = async () => {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true });
  return (await finishActivity(ctx, bank.payload, bank.hidden)).transactions.map((t) => t.transaction_id);
};

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-chase') });
  await remember(['acc_chk', 'acc_card']);
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob({
      schema_version: 2,
      cursor: 'c1',
      accounts: {
        acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
        acc_card: { name: 'Visa', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: null },
      },
      txns: Object.fromEntries(BANK.map((t) => [t.transaction_id, t])),
      synced_at: new Date().toISOString(),
    })
  );
});

describe('rows imported into an account that ended', () => {
  test('are left out from its end day on wherever the bank’s are, count before it, and stay in the download', async () => {
    await importFile(STATEMENT);
    const id = await ids();
    const window = { from: daysAgo(52), to: daysAgo(45) };
    expect((await readSpending(ctx, window)).money_out).toBe(60);

    await markEnded(ctx, 'acc_chk', { state: 'closed', on: daysAgo(100), note: 'Moved to Ally' }, CHECKING);
    const shown = await listed();
    // Before its end: the imported rows, as the bank's would be.
    expect(shown).toEqual(expect.arrayContaining([id['OLD STORE'], id['OLD DEPOSIT']]));
    // From it: neither the imported row nor the bank's own.
    for (const gone of [id['CORNER SHOP'], 'b_rent', 'b_domain', 'b_grocer']) expect(shown).not.toContain(gone);
    expect(shown).toContain('b_card');
    // The API and spending read the same.
    const api = await queryTransactions(ctx, { from: daysAgo(400), to: daysAgo(0), limit: 100 });
    expect(api.transactions.map((t) => t.id)).toEqual(expect.arrayContaining([id['OLD STORE'], id['OLD DEPOSIT']]));
    expect(api.transactions.map((t) => t.id)).not.toContain(id['CORNER SHOP']);
    expect((await readSpending(ctx, window)).money_out).toBe(0);

    // A report leaves it out by the same rule, and counts it among what it
    // didn't count of the account.
    const period = resolvePeriod({ kind: 'range', start: daysAgo(330), end: daysAgo(0) }, 'UTC', Date.now());
    if ('error' in period) throw new Error(period.error);
    const report = await readReport(ctx, period);
    expect(report.ended).toEqual([expect.objectContaining({ account: expect.stringContaining('Checking'), state: 'closed', end: daysAgo(100), not_counted: 4 })]);
    expect(report.appendix?.rows.some((r) => r.name === 'CORNER SHOP') ?? false).toBe(false);

    // The download keeps it, as it keeps the bank's.
    const data = await collectUserData({ ctx, userId: null });
    const doc = buildUserExport(data, new Date());
    const [, ...rows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
    expect(rows.map((r) => r[TRANSACTION_COLUMNS.indexOf('transaction_id')])).toEqual(expect.arrayContaining([id['CORNER SHOP'], 'b_rent']));
    // So does its statement, which counts it with the bank's among those
    // dated from its end.
    const statement = ofxFile(data, doc, 'acc_chk', new Date());
    if (!('file' in statement)) throw new Error(statement.refused);
    expect([...statement.file.pieces()].join('')).toContain(`<FITID>${id['CORNER SHOP']}`);
    expect(statement.file.notes[0]).toStartWith(
      `This account was closed in Nya on ${shownDay(daysAgo(100))}: the statement still lists every transaction Nya stored for it, 4 of them dated from then, which Nya leaves out of every total`
    );
  });

  test('through every id it has had: an end set on its earlier id leaves them out from its day', async () => {
    await importFile(STATEMENT);
    const id = await ids();
    await markEnded(ctx, 'acc_old', { state: 'untracked', from: daysAgo(100) }, { ...CHECKING, item_id: null });
    await linkAccounts(ctx, 'acc_old', 'acc_chk', { old_type: 'depository' });
    const shown = await listed();
    expect(shown).toContain(id['OLD STORE']);
    expect(shown).not.toContain(id['CORNER SHOP']);
  });

  test('its bank no longer returning it, those before its end still count, and it takes a file, the review saying what of it counts in nothing', async () => {
    await importFile(STATEMENT);
    const id = await ids();
    await markEnded(ctx, 'acc_chk', { state: 'closed', on: daysAgo(100) }, CHECKING);
    // The bank stops returning it: the loads remember only the card.
    await remember(['acc_card']);
    const shown = await listed();
    expect(shown).toEqual(expect.arrayContaining([id['OLD STORE'], id['OLD DEPOSIT']]));
    expect(shown).not.toContain(id['CORNER SHOP']);
    // The sheet, opened from the Accounts that ended card, learns its currency
    // from its end's record.
    const past = await (await routes.GET(new Request('http://localhost/api/history-import?account_id=acc_chk'))).json();
    expect(past.currency).toBe('USD');

    // A file reaching past its end: imported, the later row counting in nothing.
    const later = ofx(
      [
        { fitid: 'G_before', days: 150, amount: -40, name: 'BOOK SHOP' },
        { fitid: 'G_after', days: 80, amount: -30, name: 'LATE FEE' },
      ],
      160,
      70
    );
    const review = await importFile(later);
    expect(review.warnings).toContain(
      `Checking closed on ${shownDay(daysAgo(100))}: one of the transactions this file adds is dated from then, and counts in nothing, as its bank’s own from then don’t. It is kept, and counts again if you reopen it.`
    );
    const now = await ids();
    const after = await listed();
    expect(after).toContain(now['BOOK SHOP']);
    expect(after).not.toContain(now['LATE FEE']);
    expect(now['LATE FEE']).toBeDefined();
  });
});
