import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, ctxKey, testKey, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The rest of the download's promise (app/api/my-data): one account's OFX
// statement (lib/ofx-export.ts), a passphrase that protects any format
// (lib/protected-download.ts), and an email to the owner each time
// (lib/download-notice.ts), with the fresh sign-in and the hourly limit as
// before. What the OFX writer and the age format do on their own is
// test/ofx-export.test.ts and test/age.test.ts.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Deserializing like Upstash: what production reads back.
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveManualAccount } = await import('@/lib/manual');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { setExcluded, carriedAnnotationStore } = await import('@/lib/txn-annotations');
const { ofxAccountId } = await import('@/lib/ofx-export');
const { ownerContainer } = await import('@/lib/owners');
const { DOWNLOADS_PER_WINDOW, LOGIN_MAX_FAILURES } = await import('@/lib/rate-limit');
const { decryptWithPassphrase, parseHeader } = await import('@/lib/age/age');
const { nativeScrypt } = await import('@/lib/protected-download');
const { backgroundSettled } = await import('@/lib/background');
const { sendAccessNotice, composeAccessNotice, noticeTime } = await import('@/lib/download-notice');
const { noticeRecipients } = await import('@/lib/notice-recipients');
const { forgetMailOffLogged } = await import('@/lib/mail');
const { decodeFile } = await import('@/lib/import/text');
const { parseOfx, ofxRecords } = await import('@/lib/import/ofx');
const { PASSPHRASE_MIN, passphraseProblem } = await import('@/lib/download-options');
const route = await import('@/app/api/my-data/route');
const imports = await import('@/app/api/import/route');
const tokens = await import('@/app/api/api-tokens/route');
type ManualTxn = import('@/lib/manual-txns').ManualTxn;

const ctx = TEST_CTX;
const IP = '203.0.113.9';
const PASSWORD = 'hunter2';
const PASSPHRASE = 'piano orbit lantern harvest';

const post = (body: unknown) =>
  route.POST(
    new Request('http://x/api/my-data', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );

/** Console output collected while `fn` runs, and while what it started in
 *  the background (the email) finishes. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; said: string[] }> {
  const said: string[] = [];
  const saved = [console.log, console.error, console.warn];
  const keep = (...a: unknown[]) => void said.push(a.map(String).join(' '));
  console.log = console.error = console.warn = keep;
  try {
    const result = await fn();
    await backgroundSettled();
    return { result, said };
  } finally {
    [console.log, console.error, console.warn] = saved;
  }
}

/** A download, read to its end: status, headers and bytes, and the log. */
async function download(body: Record<string, unknown>) {
  const { result: res, said } = await quietly(async () => {
    const r = await post({ password: PASSWORD, ...body });
    return { status: r.status, headers: r.headers, bytes: new Uint8Array(await r.arrayBuffer()) };
  });
  return { ...res, said };
}

const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const notesOf = (headers: Headers) => JSON.parse(decodeURIComponent(headers.get('x-nya-export-notes') ?? '%5B%5D')) as string[];

/** An OFX download read back by Nya's own parser. */
function statementsOf(bytes: Uint8Array) {
  const decoded = decodeFile(bytes);
  const file = parseOfx(decoded.text);
  expect(file.error).toBeNull();
  return { encoding: decoded.encoding, text: decoded.text, statements: file.statements.map((s) => ({ s, ...ofxRecords(s) })) };
}

// ---- A container with a bank, a card, a loan, an investment account and manual accounts ----

const txn = (over: Record<string, unknown>) => ({
  transaction_id: 't',
  pending_transaction_id: null,
  account_id: 'acc_chk',
  amount: 4.5,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  date: '2026-09-01',
  authorized_date: null,
  authorized_datetime: null,
  datetime: null,
  name: 'COFFEE',
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
  category: null,
  account_name: 'Checking',
  institution_name: 'Chase',
  ...over,
});

const TXNS = {
  t_coffee: txn({ transaction_id: 't_coffee', amount: 4.5, authorized_date: '2026-08-31', name: 'BLUE BOTTLE #12 OAKLAND', merchant_name: 'Blue Bottle', merchant_entity_id: 'ent_bb' }),
  t_pay: txn({ transaction_id: 't_pay', amount: -2450, date: '2026-09-02', name: 'ACME CORP PAYROLL' }),
  t_pending: txn({ transaction_id: 't_pending', amount: 20, date: '2026-09-03', name: 'SHELL', pending: true }),
  t_trip: txn({ transaction_id: 't_trip', amount: 1234.56, date: '2026-09-04', name: 'AIRLINE TICKETS' }),
  t_amp: txn({ transaction_id: 't_amp', amount: 89.99, date: '2026-09-05', name: 'AT&T <WIRELESS>' }),
  t_card_buy: txn({ transaction_id: 't_card_buy', account_id: 'acc_card', amount: 30, date: '2026-09-06', name: 'GREEN APPLE BOOKS', account_name: 'Sapphire' }),
  t_card_pay: txn({ transaction_id: 't_card_pay', account_id: 'acc_card', amount: -500, date: '2026-09-07', name: 'PAYMENT THANK YOU', account_name: 'Sapphire' }),
};

const MANUAL_CASH = { account_id: 'manual_cash', name: 'Cash', institution_name: 'By hand', type: 'depository', subtype: 'checking', balance: 200, updated_at: '2026-10-01T09:00:00.000Z' } as const;
const MANUAL_LOAN = { account_id: 'manual_car', name: 'Car loan', institution_name: 'Dealer', type: 'loan', subtype: null, balance: 9000, updated_at: '2026-10-01T09:00:00.000Z' } as const;
const TARGET = { account_id: 'manual_target', name: 'Imported', institution_name: 'Elsewhere', type: 'depository', subtype: 'checking', balance: 0, updated_at: '2026-10-01T09:00:00.000Z' } as const;

const at = '2026-09-20T10:00:00.000Z';
const manualRow = (id: string, over: Partial<ManualTxn>): ManualTxn => ({
  id: `manual-txn:${id}`,
  account_id: 'manual_cash',
  date: '2026-09-10',
  amount: 12.5,
  currency: 'USD',
  name: 'Farmers market',
  category: null,
  note: null,
  source: 'manual',
  source_id: null,
  created_at: at,
  updated_at: at,
  ...over,
});
const CASH_ROWS: ManualTxn[] = [
  manualRow('00000000-0000-4000-8000-000000000001', { note: 'peaches' }),
  manualRow('00000000-0000-4000-8000-000000000002', { date: '2026-09-11', amount: 60, name: 'ATM', source: 'import:ofx', source_id: 'BANKFIT1', transaction_code: 'atm', import_id: 'import:x' }),
  manualRow('00000000-0000-4000-8000-000000000003', { date: '2026-09-12', amount: 15, currency: 'EUR', name: 'Bäckerei' }),
  manualRow('00000000-0000-4000-8000-000000000004', { date: '2026-09-13', amount: 100, name: 'Gift' }),
];

async function seed() {
  await fake.hset(ctxKey('plaid:items'), {
    item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', institution_id: 'ins_3', encrypted_access_token: await encrypt('access-sandbox-SECRET') }),
  });
  await fake.hset(ctxKey('accounts:meta'), {
    item_a: await encrypt(
      JSON.stringify([
        { account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' },
        { account_id: 'acc_card', name: 'Sapphire', official_name: null, mask: '2222', type: 'credit', subtype: 'credit card', limit: 5000, currency: 'USD' },
        { account_id: 'acc_mortgage', name: 'Mortgage', official_name: null, mask: '3333', type: 'loan', subtype: 'mortgage', limit: null, currency: 'USD' },
        { account_id: 'acc_brk', name: 'Brokerage', official_name: null, mask: '9999', type: 'investment', subtype: 'brokerage', limit: null, currency: 'USD' },
      ])
    ),
  });
  await fake.set(
    ctxKey('txns:item_a'),
    await encodeJsonBlob({
      schema_version: 2,
      cursor: '',
      accounts: {
        acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: { available: null, current: 1550.25, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null } },
        acc_card: { name: 'Sapphire', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: { available: null, current: 500, limit: 5000, iso_currency_code: 'USD', unofficial_currency_code: null } },
      },
      txns: TXNS,
    })
  );
  await fake.hset(ctxKey('txn-vendor-renames'), { 'mid:ent_bb': await encrypt('BB Coffee') });
  await fake.hset(ctxKey('history:accounts'), {
    '2026-10-07': await encrypt(JSON.stringify({ acc_chk: 1500, acc_card: 480 })),
    '2026-10-08': await encrypt(JSON.stringify({ acc_chk: 1550.25, acc_card: 500, acc_mortgage: 250000 })),
  });
  for (const a of [MANUAL_CASH, MANUAL_LOAN, TARGET]) await saveManualAccount(ctx, a as any);
  await manualTxnStore.set(ctx, 'manual_cash', { version: 1, rows: CASH_ROWS });
  await setExcluded(ctx, 't_trip', true);
  await setExcluded(ctx, CASH_ROWS[3].id, true);
}

const saved = { ...process.env };
const realFetch = globalThis.fetch;
beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  (await import('@/lib/auth-mode')).forgetEmails();
  forgetMailOffLogged();
  await registerTestContainer(fake);
  clerk.signedIn = null;
  clerk.reverified = true;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  for (const k of ['RESEND_API_KEY', 'MAIL_FROM', 'NOTIFY_EMAIL', 'APP_URL']) delete process.env[k];
  process.env.APP_PASSWORD = PASSWORD;
  process.env.SESSION_SECRET = 'test-session-secret';
  await seed();
});
afterEach(async () => {
  await backgroundSettled();
  globalThis.fetch = realFetch;
  process.env = { ...saved };
  clerk.signedIn = null;
  clerk.reverified = true;
});

/** Every key the fake holds, with its value(s) as stored. */
function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of (fake as any).strings as Map<string, string>) out[k] = v;
  for (const [k, h] of (fake as any).hashes as Map<string, Map<string, string>>) out[k] = Object.fromEntries(h);
  return out;
}

describe('one account as an OFX statement', () => {
  test('a bank account: its posted transactions, in OFX’s sign, with the names the app shows, a pending one left out and said', async () => {
    const res = await download({ format: 'ofx', account_id: 'acc_chk' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ofx');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="nya-chase-checking-1111-\d{4}-\d{2}-\d{2}\.ofx"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-nya-export-bytes')).toBe(String(res.bytes.length));
    expect(res.headers.get('x-nya-export-incomplete')).toBeNull();
    expect(res.said).toEqual(['Data download: ofx']);
    const read = statementsOf(res.bytes);
    expect(read.encoding).toBe('windows-1252');
    expect(read.statements).toHaveLength(1);
    const [{ s, records, problems }] = read.statements;
    expect(problems).toEqual([]);
    expect([s.kind, s.currency, s.account.account_type, s.ledger]).toEqual(['bank', 'USD', 'CHECKING', { amount: 1550.25, as_of: '2026-10-08' }]);
    // Its own rows, posted, oldest first; never the card's, never the pending one.
    expect(records.map((r) => [r.source_id, r.date, r.amount])).toEqual([
      ['t_coffee', '2026-09-01', 4.5],
      ['t_pay', '2026-09-02', -2450],
      ['t_trip', '2026-09-04', 1234.56],
      ['t_amp', '2026-09-05', 89.99],
    ]);
    const by = new Map(records.map((r) => [r.source_id, r]));
    // Your name for the merchant, with the bank's own words beside it.
    expect(by.get('t_coffee')).toMatchObject({ description: 'BB Coffee', note: 'BLUE BOTTLE #12 OAKLAND' });
    expect(by.get('t_amp')!.description).toBe('AT&T <WIRELESS>');
    expect(read.text).toContain('<NAME>AT&amp;T &lt;WIRELESS&gt;');
    // Excluded from budgets and reports: still listed, and marked.
    expect(by.get('t_trip')!.note).toBe('Excluded from budgets and reports in Nya');
    expect(read.text).toContain('<DTPOSTED>20260901105900\r\n<DTUSER>20260831105900\r\n<TRNAMT>-4.50\r\n<FITID>t_coffee');
    expect(notesOf(res.headers)).toEqual([
      '1 pending transaction is left out: the bank gives a transaction a new id when it posts, so an app that imported it now would count it twice. Download again once it has posted.',
    ]);
  });

  test('a card: a card statement, purchases negative, payments positive, the balance owed negative', async () => {
    const res = await download({ format: 'ofx', account_id: 'acc_card' });
    expect(res.status).toBe(200);
    const [{ s, records }] = statementsOf(res.bytes).statements;
    expect([s.kind, s.ledger]).toEqual(['creditcard', { amount: -500, as_of: '2026-10-08' }]);
    expect(records.map((r) => [r.source_id, r.amount])).toEqual([
      ['t_card_buy', 30],
      ['t_card_pay', -500],
    ]);
    expect(new TextDecoder('latin1').decode(res.bytes)).toContain('<TRNAMT>-30.00\r\n<FITID>t_card_buy');
  });

  test('a manual account: hand-entered and imported rows, its notes, an excluded one marked, a statement per currency, its balance as set', async () => {
    const res = await download({ format: 'ofx', account_id: 'manual_cash' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/filename="nya-by-hand-cash-\d{4}-\d{2}-\d{2}\.ofx"/);
    const read = statementsOf(res.bytes);
    expect(read.statements.map((x) => [x.s.currency, x.records.map((r) => r.source_id), x.s.ledger])).toEqual([
      ['USD', [CASH_ROWS[0].id, CASH_ROWS[1].id, CASH_ROWS[3].id], { amount: 200, as_of: '2026-10-01' }],
      ['EUR', [CASH_ROWS[2].id], null],
    ]);
    const records = read.statements.flatMap((x) => x.records);
    const by = new Map(records.map((r) => [r.source_id, r]));
    expect(by.get(CASH_ROWS[0].id)).toMatchObject({ description: 'Farmers market', note: 'peaches', amount: 12.5 });
    expect(by.get(CASH_ROWS[1].id)).toMatchObject({ description: 'ATM', transaction_code: 'atm', amount: 60 });
    expect(by.get(CASH_ROWS[2].id)).toMatchObject({ description: 'Bäckerei', currency: 'EUR', amount: 15 });
    expect(by.get(CASH_ROWS[3].id)!.note).toBe('Excluded from budgets and reports in Nya');
    expect(notesOf(res.headers)).toContain(
      'This account’s transactions are in more than one currency (USD, EUR), and an OFX statement has one, so the file has a statement for each, in that order. Nothing is converted.'
    );
  });

  test('imported into a manual account through Nya’s own import, then imported again: the second adds nothing', async () => {
    const res = await download({ format: 'ofx', account_id: 'acc_chk' });
    const send = async () => {
      const form = new FormData();
      form.set('file', new Blob([res.bytes]), 'statement.ofx');
      form.set('meta', JSON.stringify({ action: 'import', account_id: TARGET.account_id, options: {}, file_name: 'statement.ofx' }));
      const r = await imports.POST(new Request('http://localhost/api/import', { method: 'POST', body: form }));
      return { status: r.status, body: await r.json() };
    };
    const first = await quietly(send);
    expect(first.result.status).toBe(200);
    expect(first.result.body).toMatchObject({ imported: 4, present: 0, repeated: 0, unreadable: 0 });
    const book = (await manualTxnStore.get(ctx, TARGET.account_id))!.rows;
    expect(book.map((r) => [r.source_id, r.date, r.amount, r.currency])).toEqual([
      ['t_coffee', '2026-09-01', 4.5, 'USD'],
      ['t_pay', '2026-09-02', -2450, 'USD'],
      ['t_trip', '2026-09-04', 1234.56, 'USD'],
      ['t_amp', '2026-09-05', 89.99, 'USD'],
    ]);
    const again = await quietly(send);
    expect(again.result.status).toBe(200);
    expect(again.result.body).toMatchObject({ imported: 0, present: 4 });
    expect((await manualTxnStore.get(ctx, TARGET.account_id))!.rows).toHaveLength(4);
  });

  test('a loan, an investment account, someone else’s or no account: refused, saying why', async () => {
    for (const [account_id, status, words] of [
      ['acc_mortgage', 400, 'A loan has no statement in the version of OFX money apps read'],
      ['manual_car', 400, 'A loan has no statement'],
      ['acc_brk', 400, 'An investment account’s OFX statement lists holdings'],
      ['acc_nobody', 404, 'That account isn’t among yours'],
    ] as const) {
      const res = await download({ format: 'ofx', account_id });
      expect([account_id, res.status]).toEqual([account_id, status]);
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(json(res.bytes).error).toContain(words);
    }
  });

  test('a manual account whose record can’t be read can’t be one: a 409 that says why', async () => {
    await fake.hset(ctxKey('manual:accounts'), { manual_broken: 'garbage-ciphertext' });
    const res = await download({ format: 'ofx', account_id: 'manual_broken' });
    expect(res.status).toBe(409);
    expect(json(res.bytes).error).toStartWith('This manual account couldn’t be read');
  });

  test('what couldn’t be read is said, and the file is called incomplete: an exclusion, a manual account’s transactions', async () => {
    await fake.hset(ctxKey('transaction-annotations'), { t_amp: 'not-ciphertext-but-long-enough-to-be-tried' });
    let res = await download({ format: 'ofx', account_id: 'acc_chk' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-nya-export-incomplete')).toBe('transaction-annotations');
    expect(notesOf(res.headers)[0]).toStartWith('Whether 1 of these transactions is excluded from budgets and reports could not be read');
    expect(res.said).toEqual(['Data download: ofx, incomplete: transaction-annotations']);
    // Another account's transactions are whole: nothing of theirs is unknown.
    res = await download({ format: 'ofx', account_id: 'acc_card' });
    expect(res.headers.get('x-nya-export-incomplete')).toBeNull();

    await fake.hset(ctxKey('manual-transactions'), { manual_cash: 'not-ciphertext-but-long-enough-to-be-tried' });
    res = await download({ format: 'ofx', account_id: 'manual_cash' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-nya-export-incomplete')).toBe('manual-transactions');
    expect(notesOf(res.headers)[0]).toStartWith('This account’s transactions could not be read, so the statement has none of them.');
    expect(statementsOf(res.bytes).statements.flatMap((x) => x.records)).toEqual([]);
  });
  // The balance's day, where the person is (lib/ofx-export.ts header).
  const ledgerOf = async (body: Record<string, unknown>) => {
    await fake.del(ctxKey('download-count')); // several downloads: the hour's limit is not what this is about
    const res = await download({ format: 'ofx', ...body });
    expect(res.status).toBe(200);
    return statementsOf(res.bytes).statements[0].s.ledger;
  };

  test('the balance’s day is the person’s own: when Nya recorded it, in the time zone their device sent', async () => {
    // Recorded at 02:30 UTC on the 8th: the evening of the 7th in Los Angeles.
    await fake.hset(ctxKey('snapshot:taken'), { '2026-10-08': '2026-10-08T02:30:00.000Z' });
    expect(await ledgerOf({ account_id: 'acc_chk', time_zone: 'America/Los_Angeles' })).toEqual({ amount: 1550.25, as_of: '2026-10-07' });
    expect(await ledgerOf({ account_id: 'acc_chk', time_zone: 'Asia/Tokyo' })).toEqual({ amount: 1550.25, as_of: '2026-10-08' });
    // Without a time zone, or with one the server doesn't know: the UTC day.
    expect(await ledgerOf({ account_id: 'acc_chk' })).toEqual({ amount: 1550.25, as_of: '2026-10-08' });
    expect(await ledgerOf({ account_id: 'acc_chk', time_zone: 'Mars/Olympus_Mons' })).toEqual({ amount: 1550.25, as_of: '2026-10-08' });
    // A card's the same way, and a manual account's from when its balance
    // was set: 8 pm on the 1st in Los Angeles is the 2nd in UTC.
    expect(await ledgerOf({ account_id: 'acc_card', time_zone: 'America/Los_Angeles' })).toEqual({ amount: -500, as_of: '2026-10-07' });
    await saveManualAccount(ctx, { ...MANUAL_CASH, updated_at: '2026-10-02T03:00:00.000Z' } as any);
    expect(await ledgerOf({ account_id: 'manual_cash', time_zone: 'America/Los_Angeles' })).toEqual({ amount: 200, as_of: '2026-10-01' });
    expect(await ledgerOf({ account_id: 'manual_cash' })).toEqual({ amount: 200, as_of: '2026-10-02' });
  });

  test('the file is named for the person’s own day too', async () => {
    const zone = 'Pacific/Kiritimati';
    const day = () => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const before = day();
    const res = await download({ format: 'ofx', account_id: 'acc_chk', time_zone: zone });
    const name = /filename="nya-chase-checking-1111-(\d{4}-\d{2}-\d{2})\.ofx"/.exec(res.headers.get('content-disposition') ?? '')![1];
    expect([before, day()]).toContain(name);
  });

  test('a balance measured later on a partial day, or a moment kept for another day: the UTC day it is kept under', async () => {
    await fake.hset(ctxKey('snapshot:taken'), { '2026-10-08': '2026-10-08T02:30:00.000Z' });
    // Measured again later that day, while another bank failed: the moment
    // above is that day's snapshot's, not this balance's.
    await fake.hset(ctxKey('history:accounts:partial'), { '2026-10-08': await encrypt(JSON.stringify({ acc_chk: 1600 })) });
    expect(await ledgerOf({ account_id: 'acc_chk', time_zone: 'America/Los_Angeles' })).toEqual({ amount: 1600, as_of: '2026-10-08' });
    // A restored copy keeps this deployment's own moments: one from another
    // day isn't the balance's.
    await fake.del(ctxKey('history:accounts:partial'));
    await fake.hset(ctxKey('snapshot:taken'), { '2026-10-08': '2026-10-09T01:00:00.000Z' });
    expect(await ledgerOf({ account_id: 'acc_chk', time_zone: 'America/Los_Angeles' })).toEqual({ amount: 1550.25, as_of: '2026-10-08' });
  });

  // A bank reconnected: the account's earlier id linked to the one it has now.
  const linkEarlier = async () =>
    fake.hset(ctxKey('account-links'), { acc_old: await encrypt(JSON.stringify({ to: 'acc_chk', linked_at: '2026-09-15T00:00:00.000Z', evidence: {} })) });

  test('after a re-link: the ACCTID the earlier account’s files had, and its exclusions marked, the account’s own record first', async () => {
    let read = statementsOf((await download({ format: 'ofx', account_id: 'acc_chk' })).bytes);
    expect(read.statements[0].s.account.account_id).toBe(ofxAccountId('acc_chk', '1111'));
    await linkEarlier();
    // AT&T, excluded under the earlier account, carried by its content.
    await carriedAnnotationStore.set(ctx, 'acc_old', { version: 1, rows: { 'acc_old|2026-09-05|8999|at&t <wireless>': { excluded: true } } });
    const res = await download({ format: 'ofx', account_id: 'acc_chk' });
    expect(res.headers.get('x-nya-export-incomplete')).toBeNull();
    read = statementsOf(res.bytes);
    expect(read.statements[0].s.account.account_id).toBe(ofxAccountId('acc_old', '1111'));
    let by = new Map(read.statements[0].records.map((r) => [r.source_id, r]));
    expect(by.get('t_amp')!.note).toBe('Excluded from budgets and reports in Nya');
    expect(by.get('t_coffee')!.note).not.toContain('Excluded');
    // Said again about the transaction itself, the account's own record wins.
    await setExcluded(ctx, 't_amp', false);
    read = statementsOf((await download({ format: 'ofx', account_id: 'acc_chk' })).bytes);
    by = new Map(read.statements[0].records.map((r) => [r.source_id, r]));
    expect(by.get('t_amp')!.note ?? '').not.toContain('Excluded');
  });

  test('exclusions carried from an earlier account that can’t be read: said, and the file called incomplete', async () => {
    await linkEarlier();
    await fake.hset(ctxKey('carried-annotations'), { acc_old: 'not-ciphertext-but-long-enough-to-be-tried' });
    const res = await download({ format: 'ofx', account_id: 'acc_chk' });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-nya-export-incomplete')).toBe('carried-annotations');
    expect(notesOf(res.headers)).toContain(
      'Exclusions carried to this account from an earlier one linked to it could not be read, so the transactions they apply to aren’t marked as excluded. The JSON download lists them under problems. Nothing was changed: what could not be read is still stored as it was.'
    );
    expect(res.said).toEqual(['Data download: ofx, incomplete: carried-annotations']);
    // The card was never linked to it: nothing of its is missing.
    const card = await download({ format: 'ofx', account_id: 'acc_card' });
    expect(card.headers.get('x-nya-export-incomplete')).toBeNull();
  });
});

describe('a passphrase', () => {
  const opened = async (bytes: Uint8Array, passphrase = PASSPHRASE) => Buffer.concat(await decryptWithPassphrase(bytes, passphrase, { scrypt: nativeScrypt }));

  test('protects the JSON file: the same document, in the age format, named .age, its size announced first', async () => {
    const plain = await download({ format: 'json' });
    const res = await download({ format: 'json', passphrase: PASSPHRASE });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="nya-data-\d{4}-\d{2}-\d{2}\.json\.age"$/);
    expect(res.headers.get('x-nya-export-bytes')).toBe(String(res.bytes.length));
    expect(res.headers.get('content-length')).toBe(String(res.bytes.length));
    expect(new TextDecoder().decode(res.bytes.subarray(0, 32))).toStartWith('age-encryption.org/v1\n-> scrypt ');
    expect(parseHeader(res.bytes).stanzas[0].args[1]).toBe('18');
    const doc = json(await opened(res.bytes));
    const before = json(plain.bytes);
    expect({ ...doc, exported_at: null }).toEqual({ ...before, exported_at: null });
    expect(res.said).toEqual(['Data download: json, protected']);
    // A wrong passphrase opens nothing.
    await expect(decryptWithPassphrase(res.bytes, 'piano orbit lantern harvesT', { scrypt: nativeScrypt })).rejects.toThrow('That passphrase doesn’t open this file.');
  }, 30_000);

  test('protects a CSV and an OFX statement alike', async () => {
    for (const body of [{ format: 'transactions-csv' }, { format: 'balances-csv' }, { format: 'ofx', account_id: 'acc_chk' }]) {
      await fake.del(ctxKey('download-count')); // two downloads each: the hour's limit is not what this is about
      const plain = await download(body);
      const res = await download({ ...body, passphrase: PASSPHRASE });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toMatch(/\.(csv|ofx)\.age"$/);
      const bytes = await opened(res.bytes);
      if (body.format === 'ofx') {
        // The same statement, made a moment later.
        const strip = (b: Uint8Array) => new TextDecoder('latin1').decode(b).replace(/<DTSERVER>[^\r]*/, '');
        expect(strip(bytes)).toBe(strip(plain.bytes));
      } else expect(Buffer.from(bytes).equals(Buffer.from(plain.bytes))).toBe(true);
      // The notes travel as before, unencrypted, in the headers.
      expect(notesOf(res.headers)).toEqual(notesOf(plain.headers));
    }
  }, 30_000);

  test('is never stored, logged, or sent back', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.MAIL_FROM = 'Nya <alerts@example.com>';
    process.env.NOTIFY_EMAIL = 'owner@example.com';
    const sent: string[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(String(init.body));
      return Response.json({ id: 'email_1' });
    }) as unknown as typeof fetch;
    const secret = 'a very particular passphrase 7f3a';
    const before = snapshot();
    const res = await download({ format: 'json', passphrase: secret });
    expect(res.status).toBe(200);
    const after = snapshot();
    // Only the download's own count changed.
    expect(Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]))).toEqual([ctxKey('download-count')]);
    expect(JSON.stringify(after)).not.toContain(secret);
    expect(res.said.join('\n')).not.toContain(secret);
    expect([...res.headers.values()].join('\n')).not.toContain(secret);
    expect(new TextDecoder('latin1').decode(res.bytes)).not.toContain(secret);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain(secret);
  }, 30_000);

  test('of at least the minimum length, checked before the limit or the sign-in, never repeated in the answer', async () => {
    expect(PASSPHRASE_MIN).toBe(12);
    for (const passphrase of ['too short!!', ' '.repeat(20), 42, '', 'x'.repeat(1025)]) {
      const res = await post({ format: 'json', password: PASSWORD, passphrase });
      expect(res.status).toBe(400);
      const { error } = await res.json();
      expect(error).toMatch(/passphrase/i);
      if (typeof passphrase === 'string' && passphrase.trim()) expect(error).not.toContain(passphrase);
    }
    expect(await fake.get(ctxKey('download-count'))).toBeNull();
    expect(await fake.get(testKey(`ratelimit:login:${IP}`))).toBeNull();
    // Characters as a person counts them: eleven letters and an emoji are twelve.
    expect(passphraseProblem('elevenchars🙂')).toBeNull();
    expect(passphraseProblem('elevenchars')).toBe('Use a passphrase of at least 12 characters.');
  });

  const CLI = Bun.spawnSync(['sh', '-c', 'command -v age && command -v script']).exitCode === 0;
  test.skipIf(!CLI)('a protected download opens with the age command', async () => {
    const res = await download({ format: 'transactions-csv', passphrase: PASSPHRASE });
    const plain = await download({ format: 'transactions-csv' });
    const dir = mkdtempSync(join(tmpdir(), 'nya-my-data-'));
    try {
      writeFileSync(join(dir, 'file.csv.age'), res.bytes);
      const run = Bun.spawnSync(['script', '-q', '-e', '-c', 'age -d -o file.csv file.csv.age', '/dev/null'], { cwd: dir, stdin: new TextEncoder().encode(`${PASSPHRASE}\n`) });
      expect(run.exitCode).toBe(0);
      expect(readFileSync(join(dir, 'file.csv')).equals(Buffer.from(plain.bytes))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('every field is checked', () => {
  test('format, account_id and time_zone with OFX and only with OFX, and the passphrase, before anything is counted', async () => {
    for (const body of [
      { format: 'ofx' },
      { format: 'ofx', account_id: 'acc_chk', time_zone: 5 },
      { format: 'json', time_zone: 'Europe/Paris' },
      { format: 'ofx', account_id: '' },
      { format: 'ofx', account_id: 'a b' },
      { format: 'ofx', account_id: 'x'.repeat(201) },
      { format: 'ofx', account_id: 42 },
      { format: 'json', account_id: 'acc_chk' },
      { format: 'qfx', account_id: 'acc_chk' },
      { format: 'json', passphrase: 'short' },
    ]) {
      const res = await post({ password: PASSWORD, ...body });
      expect([JSON.stringify(body), res.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect(await fake.get(ctxKey('download-count'))).toBeNull();
  });
});

describe('the fresh sign-in and the hourly limit', () => {
  test('with the shared password: the password again, for OFX and a protected file too', async () => {
    for (const body of [{ format: 'ofx', account_id: 'acc_chk' }, { format: 'json', passphrase: PASSPHRASE }]) {
      const res = await post({ ...body, password: 'nope' });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ wrong_password: true });
    }
    expect(await fake.get(ctxKey('download-count'))).toBeNull();
    expect(Number(await fake.get(testKey(`ratelimit:login:${IP}`)))).toBe(2);
  }, 30_000);

  test(`${DOWNLOADS_PER_WINDOW} an hour, whatever the format, protected or not, then a 429`, async () => {
    const bodies = [
      { format: 'ofx', account_id: 'acc_chk' },
      { format: 'json', passphrase: PASSPHRASE },
      { format: 'ofx', account_id: 'manual_cash', passphrase: PASSPHRASE },
      { format: 'balances-csv' },
      { format: 'ofx', account_id: 'acc_brk' }, // refused, but everything was read to know: counted
    ];
    for (const body of bodies) await download(body);
    expect(Number(await fake.get(ctxKey('download-count')))).toBe(DOWNLOADS_PER_WINDOW);
    const res = await post({ format: 'ofx', account_id: 'acc_chk', password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
  }, 30_000);

  test('wrong passwords past the login’s limit wait, even with the right one', async () => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await post({ format: 'ofx', account_id: 'acc_chk', password: 'nope' });
    expect((await post({ format: 'ofx', account_id: 'acc_chk', password: PASSWORD })).status).toBe(429);
  });

  test('with Clerk: a sign-in that isn’t recent gets the reverification hint, for OFX and a protected file, and counts nothing', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a';
    await ownerContainer('user_a');
    clerk.signedIn = 'user_a';
    clerk.reverified = false;
    for (const body of [{ format: 'ofx', account_id: 'acc_chk' }, { format: 'json', passphrase: PASSPHRASE }]) {
      const res = await post(body);
      expect(res.status).toBe(403);
      expect((await res.json()).clerk_error.reason).toBe('reverification-error');
    }
    expect(await fake.get(ctxKey('download-count'))).toBeNull();
    clerk.reverified = true;
    const { result } = await quietly(() => post({ format: 'ofx', account_id: 'acc_chk' }));
    expect(result.status).toBe(200);
  });
});

describe('only the person’s own data', () => {
  test('with Clerk, an account of someone else’s is no account of theirs, and their statement holds only their rows', async () => {
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a,user_b';
    await ownerContainer('user_a'); // claims the test container, seeded above
    const other = { container: await ownerContainer('user_b') };
    await saveManualAccount(other as any, { ...MANUAL_CASH, account_id: 'manual_bea', name: 'Bea cash' } as any);
    await manualTxnStore.set(other as any, 'manual_bea', { version: 1, rows: [manualRow('00000000-0000-4000-8000-0000000000b1', { account_id: 'manual_bea', name: 'Bea lunch' })] });

    clerk.signedIn = 'user_b';
    for (const account_id of ['manual_cash', 'acc_chk']) {
      const { result } = await quietly(() => post({ format: 'ofx', account_id }));
      expect([account_id, result.status]).toEqual([account_id, 404]);
    }
    const { result } = await quietly(async () => {
      const r = await post({ format: 'ofx', account_id: 'manual_bea' });
      return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
    });
    expect(result.status).toBe(200);
    const records = statementsOf(result.bytes).statements.flatMap((x) => x.records);
    expect(records.map((r) => r.description)).toEqual(['Bea lunch']);
    expect(new TextDecoder('latin1').decode(result.bytes)).not.toMatch(/Farmers|peaches|BLUE BOTTLE|Chase/);
  });
});

describe('an email each time', () => {
  /** Mail set up, the shared password's NOTIFY_EMAIL to write to, and
   *  Resend's API answered here: each message as it was sent. */
  function mailOn(answer: () => Response | Promise<Response> = () => Response.json({ id: 'email_1' })) {
    process.env.RESEND_API_KEY = 're_test';
    process.env.MAIL_FROM = 'Nya <alerts@example.com>';
    process.env.NOTIFY_EMAIL = 'owner@example.com';
    process.env.APP_URL = 'https://nya.example';
    const sent: { to: string[]; subject: string; text: string; key: string | null }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.resend.com/emails');
      const body = JSON.parse(String(init.body));
      sent.push({ to: body.to, subject: body.subject, text: body.text, key: (init.headers as Record<string, string>)['Idempotency-Key'] ?? null });
      return answer();
    }) as unknown as typeof fetch;
    return sent;
  }

  test('to the owner: when, which format, whether it is protected, and what to do if it wasn’t them', async () => {
    const sent = mailOn();
    const res = await download({ format: 'json', passphrase: PASSPHRASE });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail.to).toEqual(['owner@example.com']);
    expect(mail.subject).toBe('Your Nya data was downloaded');
    expect(mail.text).toMatch(/^Your Nya data was downloaded on \w+day, \w+ \d{1,2}, \d{4}, at \d{2}:\d{2} UTC: everything, as one JSON file, protected with a passphrase\.\n\n/);
    expect(mail.text).toContain("If it wasn't you, someone else has signed in as you: use Sign out everywhere in Nya (beside Log out) to end every session");
    expect(mail.text).toContain('Open Nya: https://nya.example/');
    expect(mail.text).toContain('Its emails never include balances, amounts or account numbers.');
    expect(res.said).toEqual(['Data download: json, protected', 'Download notice: emailed.']);
  }, 30_000);

  test('an idempotency key per download', async () => {
    const sent = mailOn();
    await download({ format: 'balances-csv' });
    await download({ format: 'balances-csv' });
    expect(sent.map((m) => m.text.split(':')[2]?.trim().split('.')[0])).toEqual(['your balance history, as a CSV file', 'your balance history, as a CSV file']);
    expect(sent.every((m) => /^nya-download-[0-9a-f-]{36}$/.test(m.key ?? ''))).toBe(true);
    expect(new Set(sent.map((m) => m.key)).size).toBe(2);
  });

  test('never an amount, an account number, a name or anything from the file, whatever the format', async () => {
    const sent = mailOn();
    for (const body of [
      { format: 'json' },
      { format: 'transactions-csv' },
      { format: 'balances-csv' },
      { format: 'ofx', account_id: 'acc_chk' },
      { format: 'ofx', account_id: 'manual_cash', passphrase: PASSPHRASE },
    ]) {
      expect((await download(body)).status).toBe(200);
    }
    expect(sent).toHaveLength(5);
    const amounts = ['4.5', '2450', '2,450', '1234.56', '1,234.56', '89.99', '1550.25', '1,550.25', '500', '200', '12.5', '60', '15', '100', '250000', '250,000'];
    const masks = ['1111', '2222', '3333', '9999'];
    const names = ['Chase', 'Checking', 'Sapphire', 'BB Coffee', 'Blue Bottle', 'Farmers', 'peaches', 'Cash', 'By hand', 'owner@example.com', PASSPHRASE];
    for (const mail of sent) {
      const all = `${mail.subject}\n${mail.text}`;
      // The time is the only number in it, so it is taken out first: the
      // rest is checked whatever the clock says (15:15 on the 15th has "15").
      const time = /on (\w+day, \w+ \d{1,2}, \d{4}, at \d{2}:\d{2} UTC)/.exec(all)![1];
      const rest = all.replace(time, '');
      expect(rest).not.toMatch(/\d/);
      for (const s of [...amounts, ...masks, ...names]) expect([s, rest.includes(s)]).toEqual([s, false]);
      expect(rest).not.toMatch(/\$|€|USD|EUR/);
    }
  }, 30_000);

  test('mail off: nothing sent, nothing said, and the download goes ahead', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    const res = await download({ format: 'ofx', account_id: 'acc_chk' });
    expect(res.status).toBe(200);
    expect(statementsOf(res.bytes).statements[0].records).toHaveLength(4);
    expect(called).toBe(false);
    expect(res.said).toEqual(['Data download: ofx']);
  });

  test('mail failing: the whole file all the same, and a log line with the status alone', async () => {
    const sent = mailOn(() => new Response('{"name":"internal_server_error","message":"owner@example.com"}', { status: 500 }));
    const plain = await download({ format: 'json' });
    expect(plain.status).toBe(200);
    expect(plain.headers.get('x-nya-export-bytes')).toBe(String(plain.bytes.length));
    expect(json(plain.bytes).format).toBe('nya-export');
    // Tried twice, with one key: delivered at most once.
    expect(sent).toHaveLength(2);
    expect(sent[0].key).toBe(sent[1].key);
    expect(plain.said).toEqual(['Data download: json', 'Download notice: not sent (email service status 500).']);
    expect(plain.said.join('\n')).not.toMatch(/owner@example|downloaded on|Your Nya data/);
  });

  test('a slow email service: the download doesn’t wait for it', async () => {
    let release!: () => void;
    let asked = false;
    process.env.RESEND_API_KEY = 're_test';
    process.env.MAIL_FROM = 'alerts@example.com';
    process.env.NOTIFY_EMAIL = 'owner@example.com';
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      asked = true;
      return new Promise<Response>((resolve, reject) => {
        release = () => resolve(Response.json({ id: 'late' }));
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }) as unknown as typeof fetch;
    const saved = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = () => {};
    try {
      const res = await post({ format: 'json', password: PASSWORD });
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(res.status).toBe(200);
      expect(bytes.length).toBe(Number(res.headers.get('x-nya-export-bytes')));
      // The whole file arrived while the email was still waiting on Resend.
      expect(asked).toBe(true);
      release();
      await backgroundSettled();
    } finally {
      [console.log, console.error, console.warn] = saved;
    }
  });

  test('making an API token sends one too: when, and how to revoke it, never the token or its name', async () => {
    const sent = mailOn();
    const { result, said } = await quietly(async () => {
      const r = await tokens.POST(
        new Request('http://x/api/api-tokens', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
          body: JSON.stringify({ label: 'Home Assistant 4321', password: PASSWORD }),
        })
      );
      return { status: r.status, body: await r.json() };
    });
    expect(result.status).toBe(200);
    expect(result.body.token).toStartWith('nya_');
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail.to).toEqual(['owner@example.com']);
    expect(mail.subject).toBe('An API token was made for your Nya data');
    expect(mail.text).toMatch(/^An API token that can read your Nya data was made on \w+day, \w+ \d{1,2}, \d{4}, at \d{2}:\d{2} UTC\.\n\n/);
    expect(mail.text).toContain('revoke it under API tokens');
    expect(mail.key).toMatch(/^nya-api-token-[0-9a-f-]{36}$/);
    for (const secret of [result.body.token, 'Home Assistant', '4321']) expect(`${mail.subject}\n${mail.text}`).not.toContain(secret);
    expect(said).toEqual(['API token made', 'API token notice: emailed.']);
  });

  test('with Clerk, a lookup that fails is logged, and the download goes ahead', async () => {
    mailOn();
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a';
    await ownerContainer('user_a');
    clerk.signedIn = 'user_a';
    const { result, said } = await quietly(async () => {
      const r = await post({ format: 'json' });
      return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
    });
    expect(result.status).toBe(200);
    expect(json(result.bytes).format).toBe('nya-export');
    // Clerk's API isn't reachable here: the email can't find its address.
    expect(said).toEqual(['Data download: json', 'Download notice: not sent, whom to email could not be found (TypeError).']);
  });
});

describe('the email, on its own', () => {
  const AT = new Date('2026-10-10T14:32:59.000Z');

  test('says when in UTC, and what to do with either kind of sign-in', () => {
    expect(noticeTime(AT)).toBe('Saturday, October 10, 2026, at 14:32 UTC');
    const clerkMail = composeAccessNotice({ kind: 'download', format: 'ofx', protected: false }, AT, { clerk: true, link: null });
    expect(clerkMail.text).toStartWith("Your Nya data was downloaded on Saturday, October 10, 2026, at 14:32 UTC: one account's transactions, as an OFX statement.\n\n");
    expect(clerkMail.text).toContain("open your account window in Nya (your picture or initial at the top right, then Manage account), sign out every device you don't recognize, and change your password.");
    expect(clerkMail.text).toContain('Open Nya to do it.');
    expect(clerkMail.text).not.toContain('protected');
  });

  test('a new API token: revoke it, since signing out doesn’t end it', () => {
    const mail = composeAccessNotice({ kind: 'api-token' }, AT, { clerk: false, link: 'https://nya.example' });
    expect(mail.subject).toBe('An API token was made for your Nya data');
    expect(mail.text).toStartWith('An API token that can read your Nya data was made on Saturday, October 10, 2026, at 14:32 UTC.\n\n');
    expect(mail.text).toContain('revoke it now: in Nya, open Manage on the Accounts tab, and revoke it under API tokens. A token keeps working after every session ends');
    expect(mail.text).toContain('Open Nya: https://nya.example/');
  });

  test('to the owners of the container it is about, and nobody else', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.MAIL_FROM = 'alerts@example.com';
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    process.env.CLERK_ALLOWED_USER_IDS = 'user_a,user_b';
    await ownerContainer('user_a');
    const other = { container: await ownerContainer('user_b') };
    const emails: Record<string, string> = { user_a: 'a@example.com', user_b: 'b@example.com' };
    const to: string[][] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      to.push(JSON.parse(String(init.body)).to);
      return Response.json({ id: 'x' });
    }) as unknown as typeof fetch;
    const recipients = (c: typeof ctx) => noticeRecipients(c, { primaryEmail: async (id) => emails[id] ?? null });
    const quiet = console.log;
    console.log = () => {};
    try {
      expect(await sendAccessNotice(other as any, { kind: 'download', format: 'json', protected: false }, AT, { recipients, fetch: fetcher })).toBe('sent');
      expect(await sendAccessNotice(ctx, { kind: 'api-token' }, AT, { recipients, fetch: fetcher })).toBe('sent');
    } finally {
      console.log = quiet;
    }
    expect(to).toEqual([['b@example.com'], ['a@example.com']]);
  });

  test('a rate limit or no answer is tried once more, with the same key; a refusal is not', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.MAIL_FROM = 'alerts@example.com';
    const answers = [new Response('{}', { status: 429, headers: { 'retry-after': '1' } }), Response.json({ id: 'ok' })];
    const keys: string[] = [];
    const waits: number[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)['Idempotency-Key']);
      return answers.shift()!;
    }) as unknown as typeof fetch;
    const deps = { recipients: async () => ['me@example.com'], fetch: fetcher, sleep: async (ms: number) => void waits.push(ms) };
    const logs: string[] = [];
    const [log, error, warn] = [console.log, console.error, console.warn];
    console.log = console.error = console.warn = (...a: unknown[]) => void logs.push(a.join(' '));
    try {
      expect(await sendAccessNotice(ctx, { kind: 'download', format: 'json', protected: false }, AT, deps)).toBe('sent');
      expect([keys.length, keys[0] === keys[1], waits]).toEqual([2, true, [1000]]);
      const refused = [new Response('{"name":"validation_error"}', { status: 422 })];
      const once = (async () => refused.shift() ?? Response.json({ id: 'never' })) as unknown as typeof fetch;
      expect(await sendAccessNotice(ctx, { kind: 'download', format: 'json', protected: false }, AT, { ...deps, fetch: once })).toBe('failed');
      expect(refused).toEqual([]);
      expect(logs.at(-1)).toBe('Download notice: not sent (email service status 422).');
      // Nobody to write to: said, and nothing sent.
      expect(await sendAccessNotice(ctx, { kind: 'api-token' }, AT, { ...deps, recipients: async () => [] })).toBe('no-recipient');
      expect(logs.at(-1)).toBe('API token notice: not sent, nobody to email (see NOTIFY_EMAIL in docs/deployment.md).');
    } finally {
      console.log = log;
      console.error = error;
      console.warn = warn;
    }
  });

  test('mail off: nothing at all', async () => {
    let looked = false;
    expect(await sendAccessNotice(ctx, { kind: 'api-token' }, AT, { recipients: async () => ((looked = true), ['me@example.com']) })).toBe('off');
    expect(looked).toBe(false);
  });
});
