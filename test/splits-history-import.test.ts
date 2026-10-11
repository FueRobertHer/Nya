import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// Splits and groups (#39) on the rows imported into a linked account from its
// bank's files (#52): split and grouped through the routes by their ids, as a
// bank's are, their parts and nets counted where every total counts; kept
// past what prunes the bank's (a sync, a disconnect, an earlier account
// forgotten), and gone with their rows when the import is undone or the
// account they were imported into is forgotten; carried to the bank's row
// that comes to stand for one, as what was said about it is, so the
// transaction counts once, as its parts or in its group, never as both its
// parts and its twin, edited where it is kept, and back on the imported row
// when the bank's goes; in the download as the app has them (the
// transactions CSV's parts and nets, an OFX statement's memo); in a report,
// the read-only API and its MCP server, and a category's usage, as the
// Activity tab counts them, while what the files cover is the same split or
// not; and a month's note on imported transactions counts transactions,
// never parts.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// The real ceiling on a stored value: a file run before this one may have
// lowered it for its own tests (lib/blob.ts reads it on every write).
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
const { assembleBankRows, finishActivity } = await import('@/lib/activity');
const { splitStore } = await import('@/lib/splits');
const { groupStore } = await import('@/lib/groups');
const { pruneSplitsAndGroups } = await import('@/lib/split-gone');
const { storedTransactionIds } = await import('@/lib/transactions');
const { importedTxnStore } = await import('@/lib/history-import/store');
const { forgetImportedHistory } = await import('@/lib/history-import/commit');
const { importedRowsNote } = await import('@/lib/history-import/view');
const { summarize, spendingByCategory } = await import('@/lib/totals');
const { filedId, indexTaxonomy } = await import('@/lib/categories');
const { PART_PREFIX, bankRows } = await import('@/lib/split-rows');
const { collectUserData, buildUserExport, exportFile, TRANSACTION_COLUMNS } = await import('@/lib/user-export');
const { ofxFile } = await import('@/lib/ofx-export');
const { parseOfx, ofxRecords } = await import('@/lib/import/ofx');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const { readMonthActivity } = await import('@/lib/budget-month');
const { queryTransactions, readSpending } = await import('@/lib/api-read');
const { categoryUsage } = await import('@/lib/category-usage');
const { readTaxonomy } = await import('@/lib/category-store');
const { createToken } = await import('@/lib/api-tokens');
const { markEnded } = await import('@/lib/lifecycle');
const mcp = await import('@/app/api/mcp/route');
const routes = await import('@/app/api/history-import/route');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const compact = (d: string) => d.replace(/-/g, '');

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
  bankTxn('b_rent', 'acc_chk', 55, 1850, { name: 'ZELLE PAYMENT TO LANDLORD', category: 'rent and utilities' }),
  bankTxn('b_tip', 'acc_chk', 49, 5, { name: 'TIP JAR', category: 'food and drink' }),
  bankTxn('b_payback', 'acc_chk', 48, -20, { name: 'ZELLE FROM SAM', category: 'transfer in' }),
  bankTxn('b_grocer', 'acc_chk', 3, 20, { name: 'GROCER', category: 'food and drink' }),
];

// Two years of the checking account, as its bank's OFX file gives them: the
// rent is the bank's own (kept as its duplicate), the rest the file's alone.
const STATEMENT = (() => {
  const trns = [
    { fitid: 'F_domain2', days: 750, amount: -120, name: 'DOMAIN RENEWAL' },
    { fitid: 'F_domain1', days: 385, amount: -120, name: 'DOMAIN RENEWAL' },
    { fitid: 'F_old', days: 300, amount: -100, name: 'OLD STORE' },
    { fitid: 'F_dep', days: 200, amount: 500, name: 'OLD DEPOSIT' },
    { fitid: 'F_rent', days: 55, amount: -1850, name: 'Online Transfer to Landlord' },
    { fitid: 'F_mid', days: 50, amount: -60, name: 'CORNER SHOP' },
  ]
    .map(
      (t) =>
        `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${compact(daysAgo(t.days))}</DTPOSTED><TRNAMT>${t.amount.toFixed(2)}</TRNAMT><FITID>${t.fitid}</FITID><NAME>${t.name}</NAME></STMTTRN>`
    )
    .join('\n');
  return `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>325081403</BANKID><ACCTID>0009991111</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>${compact(daysAgo(760))}</DTSTART><DTEND>${compact(daysAgo(35))}</DTEND>\n${trns}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
})();

async function storeBank(rows: ReturnType<typeof bankTxn>[]) {
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob({
      schema_version: 2,
      cursor: 'c1',
      accounts: { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } },
      txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])),
      synced_at: new Date().toISOString(),
    })
  );
}

const route = async (path: string, method: string, body?: unknown) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}`, { method, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, body: await res.json() };
};
const upload = (meta: Record<string, unknown>) => {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(STATEMENT) as Uint8Array<ArrayBuffer>]), 'statement.ofx');
  form.set('meta', JSON.stringify({ file_name: 'statement.ofx', ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
};
/** Reviews the statement, imports it as reviewed, and returns the import's
 *  id and each counted row's id by its name. */
async function importStatement(): Promise<{ import_id: string; ids: Record<string, string> }> {
  const review = (await (await routes.POST(upload({ action: 'preview', account_id: 'acc_chk' }))).json()).preview.review;
  const res = await routes.POST(upload({ action: 'import', account_id: 'acc_chk', review }));
  const body = await res.json();
  expect(body).toMatchObject({ imported: 5, duplicates: 1 });
  const book = (await importedTxnStore.get(ctx, 'acc_chk'))!;
  return { import_id: body.import_id, ids: Object.fromEntries(book.rows.filter((r) => !r.same_as).map((r) => [r.name, r.id])) };
}
const undoImport = (import_id: string) =>
  routes.DELETE(
    new Request('http://localhost/api/history-import', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 'acc_chk', import_id, confirm: true }) })
  );
const activity = async () => {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true });
  return finishActivity(ctx, bank.payload, bank.hidden);
};
const rowsOf = async () => (await activity()).transactions;
const splitPut = (transaction_id: string, parts: unknown, more: Record<string, unknown> = {}) => route('transaction-splits', 'PUT', { transaction_id, parts, ...more });
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};
/** Each category's spending on a day, as the Activity tab totals it. */
const spentOn = async (day: string) => {
  const done = await activity();
  const ix = indexTaxonomy(done.taxonomy);
  const name = new Map(done.taxonomy.categories.map((c) => [c.id, c.name]));
  const by = spendingByCategory(done.transactions, (d) => d === day, 'USD', (r) => filedId(ix, r));
  return Object.fromEntries(Object.entries(by).map(([id, amount]) => [name.get(id) ?? id, amount]));
};

const download = async () => buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
/** transactions.csv's rows, each by its column names. */
const csvOf = (doc: Awaited<ReturnType<typeof download>>) => {
  const [, ...rows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
  return rows.map((r) => Object.fromEntries(TRANSACTION_COLUMNS.map((c, i) => [c, r[i]])));
};
/** The checking account's OFX statement, read back: its records by FITID. */
const statement = async () => {
  const data = await collectUserData({ ctx, userId: null });
  const made = ofxFile(data, buildUserExport(data, new Date()), 'acc_chk', new Date());
  if (!('file' in made)) throw new Error(made.refused);
  const parsed = parseOfx([...made.file.pieces()].join(''));
  expect(parsed.error).toBeNull();
  return new Map(parsed.statements.flatMap((st) => ofxRecords(st).records).map((r) => [r.source_id ?? '', r]));
};

const DAMAGED = 'not-ciphertext-but-long-enough-to-be-tried';

let categories: any;
const catId = (name: string) => categories.categories.find((c: any) => c.name === name).id;

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-chase') });
  await rememberAccounts(ctx, [
    {
      item_id: 'item_chase',
      institution_name: 'Chase',
      institution_id: null,
      error: null,
      accounts: [{ account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', balance: 900, currency: 'USD' }],
    } as any,
  ]);
  await storeBank(BANK);
  categories = (await route('categories', 'GET')).body.categories;
});

describe('an imported row splits and groups as the bank’s do', () => {
  test('split through the route by its id: its parts count in its place, one changes on its own, and unsplit puts it back whole', async () => {
    const { ids } = await importStatement();
    const old = ids['OLD STORE'];
    const [food, home] = [catId('food and drink'), catId('home improvement')];
    const put = await splitPut(old, [
      { amount: 60, category_id: food, note: 'Snacks' },
      { amount: 40, category_id: home },
    ]);
    expect(put.status).toBe(200);
    expect(put.body.split).toMatchObject({ amount: 100, currency: 'USD' });

    const rows = await rowsOf();
    expect(rows.some((t) => t.transaction_id === old)).toBe(false);
    const parts = rows.filter((t) => t.split_of === old);
    expect(parts.map((p) => [p.amount, p.category_id, p.note ?? null, p.source])).toEqual([
      [60, food, 'Snacks', 'import:ofx'],
      [40, home, null, 'import:ofx'],
    ]);
    // The month's totals count the parts, never the transaction as well.
    expect(summarize(rows, (d) => d === daysAgo(300), 'USD')).toMatchObject({ money_out: 100 });
    expect(await spentOn(daysAgo(300))).toEqual({ 'food and drink': 60, 'home improvement': 40 });

    // One part changes on its own.
    const homePart = parts[1].transaction_id.slice(PART_PREFIX.length);
    expect((await route('transaction-splits', 'PATCH', { transaction_id: old, part_id: homePart, category_id: food })).status).toBe(200);
    expect(await spentOn(daysAgo(300))).toEqual({ 'food and drink': 100 });

    // Parts that don't add up to the row's amount are refused.
    const off = await splitPut(old, [
      { amount: 60, category_id: food },
      { amount: 30, category_id: home },
    ]);
    expect(off.status).toBe(400);
    expect(off.body.error).toContain('not the transaction’s 100.00');

    expect((await route('transaction-splits', 'DELETE', { transaction_id: old })).body).toEqual({ transaction_id: old, removed: true });
    const back = (await rowsOf()).find((t) => t.transaction_id === old)!;
    expect([back.amount, back.split_of]).toEqual([100, undefined]);
  });

  test('grouped with a bank’s transaction: the group nets them in its category; split, it can’t join one', async () => {
    const { ids } = await importStatement();
    const corner = ids['CORNER SHOP'];
    const food = catId('food and drink');
    const made = await route('transaction-groups', 'POST', { name: 'Lunch with Sam', category_id: food, members: [corner, 'b_payback'] });
    expect(made.status).toBe(200);
    expect(made.body.group).toMatchObject({ members: [corner, 'b_payback'], date: daysAgo(50), currency: 'USD' });

    const rows = await rowsOf();
    const group = rows.find((t) => t.group_id === made.body.id && t.group_members)!;
    expect([group.amount, group.category_id, group.date]).toEqual([40, food, daysAgo(50)]);
    expect(group.group_members!.map((m) => m.transaction_id)).toEqual([corner, 'b_payback']);
    expect(rows.some((t) => t.transaction_id === corner || t.transaction_id === 'b_payback')).toBe(false);

    // A split imported row joins no group: its parts count on their own.
    const old = ids['OLD STORE'];
    expect(
      (
        await splitPut(old, [
          { amount: 60, category_id: food },
          { amount: 40, category_id: food },
        ])
      ).status
    ).toBe(200);
    const refused = await route('transaction-groups', 'PATCH', { id: made.body.id, add: [old] });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('is split, and its parts count on their own');
    // And a grouped one isn't split.
    const grouped = await splitPut(corner, [
      { amount: 30, category_id: food },
      { amount: 30, category_id: food },
    ]);
    expect(grouped.status).toBe(409);
    expect(grouped.body.error).toContain('is in a group (“Lunch with Sam”)');
  });

  test('when the imported rows can’t be read, an edit naming one is refused, never answered as not stored', async () => {
    const { ids } = await importStatement();
    await fake.hset(ctxKey('imported-transactions'), { acc_chk: DAMAGED });
    const refused = await quietly(() =>
      splitPut(ids['OLD STORE'], [
        { amount: 60, category_id: catId('food and drink') },
        { amount: 40, category_id: catId('home improvement') },
      ])
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ unreadable: true });
    expect(refused.body.error).toContain('(transactions imported from your bank’s files)');
    // Reconnecting a bank brings back nothing of a file's rows: not offered.
    expect(refused.body.error).not.toContain('reconnecting');
    expect(await splitStore.getAll(ctx)).toEqual(new Map());
  });
});

describe('gone with their row, and only with it', () => {
  /** OLD STORE split, and the corner shop grouped with Sam's payback. */
  async function splitAndGroup(ids: Record<string, string>) {
    const food = catId('food and drink');
    expect(
      (
        await splitPut(ids['OLD STORE'], [
          { amount: 60, category_id: food },
          { amount: 40, category_id: catId('home improvement') },
        ])
      ).status
    ).toBe(200);
    const made = await route('transaction-groups', 'POST', { name: 'Lunch with Sam', category_id: food, members: [ids['CORNER SHOP'], 'b_payback'] });
    expect(made.status).toBe(200);
    return made.body.id as string;
  }

  test('what prunes the bank’s (a sync saving a removal, a disconnect, a forget) keeps an imported row’s split and its place in a group', async () => {
    const { ids } = await importStatement();
    const group = await splitAndGroup(ids);
    // A bank's row split too, which the bank then takes back.
    expect(
      (
        await splitPut('b_grocer', [
          { amount: 15, category_id: catId('food and drink') },
          { amount: 5, category_id: catId('home improvement') },
        ])
      ).status
    ).toBe(200);
    await storeBank(BANK.filter((t) => t.transaction_id !== 'b_grocer' && t.transaction_id !== 'b_payback'));
    // As a disconnect and a forget prune: against every row the Items hold.
    await pruneSplitsAndGroups(ctx, () => storedTransactionIds(ctx));
    expect(await splitStore.get(ctx, 'b_grocer')).toBeNull();
    expect(await splitStore.get(ctx, ids['OLD STORE'])).not.toBeNull();
    expect(await groupStore.get(ctx, group)).toMatchObject({ members: [ids['CORNER SHOP']], removed: 1 });
    // And as a sync prunes what it saw the bank remove: the imported row is
    // never among them.
    await pruneSplitsAndGroups(ctx, async () => new Set(), { among: new Set([ids['OLD STORE'], ids['CORNER SHOP']]) });
    expect(await splitStore.get(ctx, ids['OLD STORE'])).not.toBeNull();
    expect((await groupStore.get(ctx, group))!.members).toEqual([ids['CORNER SHOP']]);
  });

  test('undoing the import takes its rows’ splits and their places in groups with them', async () => {
    const { import_id, ids } = await importStatement();
    const group = await splitAndGroup(ids);
    const res = await undoImport(import_id);
    expect(res.status).toBe(200);
    expect(await splitStore.get(ctx, ids['OLD STORE'])).toBeNull();
    // The group keeps the bank's transaction, and says one went.
    expect(await groupStore.get(ctx, group)).toMatchObject({ members: ['b_payback'], removed: 1 });
    const row = (await rowsOf()).find((t) => t.group_id === group)!;
    expect([row.amount, row.group_removed, row.group_members!.map((m) => m.transaction_id)]).toEqual([-20, 1, ['b_payback']]);
  });

  test('forgetting the account they were imported into takes them too', async () => {
    const { ids } = await importStatement();
    const group = await splitAndGroup(ids);
    await forgetImportedHistory(ctx, 'acc_chk');
    expect(await splitStore.get(ctx, ids['OLD STORE'])).toBeNull();
    expect(await groupStore.get(ctx, group)).toMatchObject({ members: ['b_payback'], removed: 1 });
  });
});

describe('when the bank sends the same transaction', () => {
  /** The bank's own row for the corner shop: the imported one's twin, which
   *  supersedes it from now on. */
  const corner = (over: Record<string, unknown> = {}) => bankTxn('b_corner', 'acc_chk', 50, 60, { name: 'CORNER SHOP 0042', ...over });
  const splitCorner = async (id: string) => {
    const res = await splitPut(id, [
      { amount: 45, category_id: catId('food and drink'), note: 'Sandwiches' },
      { amount: 15, category_id: catId('home improvement') },
    ]);
    expect(res.status).toBe(200);
  };

  test('its split carries to the bank’s row: counted once, as the parts, never as the parts and the bank’s row, nor the imported row too', async () => {
    const { ids } = await importStatement();
    await splitCorner(ids['CORNER SHOP']);
    await storeBank([...BANK, corner()]);

    const rows = await rowsOf();
    expect(rows.some((t) => t.transaction_id === ids['CORNER SHOP'] || t.split_of === ids['CORNER SHOP'])).toBe(false);
    expect(rows.some((t) => t.transaction_id === 'b_corner')).toBe(false);
    const parts = rows.filter((t) => t.split_of === 'b_corner');
    expect(parts.map((p) => [p.amount, p.category_id, p.note ?? null, p.split_carried_from, p.source])).toEqual([
      [45, catId('food and drink'), 'Sandwiches', ids['CORNER SHOP'], undefined],
      [15, catId('home improvement'), null, ids['CORNER SHOP'], undefined],
    ]);
    expect(summarize(rows, (d) => d === daysAgo(50), 'USD')).toMatchObject({ money_out: 60 });
    expect(await spentOn(daysAgo(50))).toEqual({ 'food and drink': 45, 'home improvement': 15 });
    // Put back whole for the list, the bank's row is the transaction, its
    // parts beneath it.
    const whole = bankRows(rows).find((t) => t.transaction_id === 'b_corner')!;
    expect([whole.amount, whole.split_carried_from, whole.split_parts?.length]).toEqual([60, undefined, 2]);

    // The bank taking its row back puts the imported row back, split as it was.
    await storeBank(BANK);
    const back = await rowsOf();
    expect(back.filter((t) => t.split_of === ids['CORNER SHOP']).map((p) => [p.amount, p.split_carried_from])).toEqual([
      [45, undefined],
      [15, undefined],
    ]);
  });

  test('an edit made from the bank’s row changes the split where it is kept, and unsplit puts the bank’s row back whole', async () => {
    const { ids } = await importStatement();
    await splitCorner(ids['CORNER SHOP']);
    await storeBank([...BANK, corner()]);
    const parts = (await rowsOf()).filter((t) => t.split_of === 'b_corner');
    const kept = parts[0].split_carried_from!;
    expect(kept).toBe(ids['CORNER SHOP']);

    // A part, as the list changes one.
    const home = parts[1].transaction_id.slice(PART_PREFIX.length);
    expect((await route('transaction-splits', 'PATCH', { transaction_id: kept, part_id: home, category_id: catId('food and drink') })).status).toBe(200);
    expect(await spentOn(daysAgo(50))).toEqual({ 'food and drink': 60 });
    // The whole split, as the sheet saves it, from the split it opened on.
    const seen = (await rowsOf()).find((t) => t.split_of === 'b_corner')!.split_updated_at;
    const put = await splitPut(
      kept,
      [
        { amount: 50, category_id: catId('food and drink') },
        { amount: 10, category_id: catId('travel') },
      ],
      { updated_at: seen }
    );
    expect(put.status).toBe(200);
    expect(await spentOn(daysAgo(50))).toEqual({ 'food and drink': 50, travel: 10 });
    expect(await splitStore.get(ctx, 'b_corner')).toBeNull();

    // Unsplit: the bank's row counts whole again.
    expect((await route('transaction-splits', 'DELETE', { transaction_id: kept })).body).toEqual({ transaction_id: kept, removed: true });
    const row = (await rowsOf()).find((t) => t.transaction_id === 'b_corner')!;
    expect([row.amount, row.split_of]).toEqual([60, undefined]);
  });

  test('the bank’s row split in its own right keeps its own parts; one still pending takes none', async () => {
    const { ids } = await importStatement();
    await splitCorner(ids['CORNER SHOP']);
    // Pending: shown whole in the imported row's place until it posts.
    await storeBank([...BANK, corner({ pending: true })]);
    let rows = await rowsOf();
    expect(rows.some((t) => t.split_of !== undefined)).toBe(false);
    expect(rows.find((t) => t.transaction_id === 'b_corner')).toMatchObject({ amount: 60, pending: true });
    expect(rows.some((t) => t.transaction_id === ids['CORNER SHOP'])).toBe(false);

    // Posted, and split on its own: its own split wins.
    await storeBank([...BANK, corner()]);
    const own = await splitPut('b_corner', [
      { amount: 30, category_id: catId('travel') },
      { amount: 30, category_id: catId('travel') },
    ]);
    expect(own.status).toBe(200);
    rows = await rowsOf();
    expect(rows.filter((t) => t.split_of === 'b_corner').map((p) => [p.amount, p.category_id, p.split_carried_from])).toEqual([
      [30, catId('travel'), undefined],
      [30, catId('travel'), undefined],
    ]);
    expect(summarize(rows, (d) => d === daysAgo(50), 'USD')).toMatchObject({ money_out: 60 });
    // The imported row's is kept, as it is, for the day the bank's row goes.
    expect(await splitStore.get(ctx, ids['CORNER SHOP'])).not.toBeNull();
  });

  test('its place in a group carries: the group nets the bank’s row, and taking that out takes the imported row out', async () => {
    const { ids } = await importStatement();
    const food = catId('food and drink');
    const made = await route('transaction-groups', 'POST', { name: 'Lunch with Sam', category_id: food, members: [ids['CORNER SHOP'], 'b_payback', 'b_tip'] });
    expect(made.status).toBe(200);
    await storeBank([...BANK, corner()]);

    let rows = await rowsOf();
    const group = rows.find((t) => t.group_members && t.group_id === made.body.id)!;
    expect([group.amount, group.group_missing]).toEqual([45, undefined]);
    expect(group.group_members!.map((m) => [m.transaction_id, m.group_carried_from])).toEqual([
      ['b_corner', ids['CORNER SHOP']],
      ['b_tip', undefined],
      ['b_payback', undefined],
    ]);
    expect(rows.some((t) => t.transaction_id === 'b_corner' || t.transaction_id === ids['CORNER SHOP'])).toBe(false);
    // The rent, the lunch's net and the grocer's: nothing else.
    expect(summarize(rows, (d) => d >= daysAgo(55), 'USD')).toMatchObject({ money_out: 1850 + 45 + 20, money_in: 0 });

    // Taken out from its row in the group, as the list does: by the id the
    // group holds.
    const kept = group.group_members!.find((m) => m.transaction_id === 'b_corner')!.group_carried_from!;
    expect((await route('transaction-groups', 'PATCH', { id: made.body.id, remove: [kept] })).status).toBe(200);
    expect((await groupStore.get(ctx, made.body.id))!.members).toEqual(['b_payback', 'b_tip']);
    rows = await rowsOf();
    expect(rows.find((t) => t.group_id === made.body.id && t.group_members)!.amount).toBe(-15);
    expect(rows.find((t) => t.transaction_id === 'b_corner')!.amount).toBe(60);
  });

  test('the bank’s row in a group in its own right stays there: the imported row’s group says it isn’t here, and nothing counts twice', async () => {
    const { ids } = await importStatement();
    const food = catId('food and drink');
    const lunch = await route('transaction-groups', 'POST', { name: 'Lunch with Sam', category_id: food, members: [ids['CORNER SHOP'], 'b_payback'] });
    await storeBank([...BANK, corner()]);
    const errand = await route('transaction-groups', 'POST', { name: 'Errand', category_id: food, members: ['b_corner', 'b_tip'] });
    expect(errand.status).toBe(200);

    const rows = await rowsOf();
    const of = (id: string) => rows.find((t) => t.group_members && t.group_id === id)!;
    expect([of(lunch.body.id).amount, of(lunch.body.id).group_missing, of(lunch.body.id).group_members!.map((m) => m.transaction_id)]).toEqual([-20, 1, ['b_payback']]);
    expect([of(errand.body.id).amount, of(errand.body.id).group_members!.map((m) => [m.transaction_id, m.group_carried_from])]).toEqual([
      65,
      [
        ['b_corner', undefined],
        ['b_tip', undefined],
      ],
    ]);
    // The rent, the errand's net and the grocer's out; Sam's payback, all
    // that is left of the lunch, in.
    expect(summarize(rows, (d) => d >= daysAgo(55), 'USD')).toMatchObject({ money_out: 1850 + 65 + 20, money_in: 20 });
  });
});

describe('the download', () => {
  test('transactions.csv lists an imported row whole with its parts, and a group’s net beside its transactions: nothing counted twice', async () => {
    const { ids } = await importStatement();
    const [food, home] = [catId('food and drink'), catId('home improvement')];
    await splitPut(ids['OLD STORE'], [
      { amount: 60, category_id: food },
      { amount: 40, category_id: home },
    ]);
    const made = await route('transaction-groups', 'POST', { name: 'Lunch with Sam', category_id: food, members: [ids['CORNER SHOP'], 'b_payback'] });
    const csv = csvOf(await download());
    const cells = (r: Record<string, string>) => [r.transaction_id, r.amount, r.nya_amount, r.split_of, r.group_id, r.nya_category];
    expect(csv.filter((r) => r.transaction_id === ids['OLD STORE'] || r.split_of === ids['OLD STORE']).map(cells)).toEqual([
      [ids['OLD STORE'], '100', '', '', '', expect.any(String)],
      [expect.stringMatching(/^split:/), '', '60', ids['OLD STORE'], '', 'food and drink'],
      [expect.stringMatching(/^split:/), '', '40', ids['OLD STORE'], '', 'home improvement'],
    ]);
    // Newest first: Sam's payback, then the group's row on its day.
    expect(csv.filter((r) => r.group_id === made.body.id).map(cells)).toEqual([
      ['b_payback', '-20', '', '', made.body.id, 'transfer in'],
      [`group:${made.body.id}`, '', '40', '', made.body.id, 'food and drink'],
      [ids['CORNER SHOP'], '60', '', '', made.body.id, expect.any(String)],
    ]);
    // What the app counts, and only that, adds up: every row counted once.
    const counted = csv.filter((r) => r.nya_amount !== '').reduce((n, r) => n + Number(r.nya_amount), 0);
    const moved = csv.filter((r) => r.amount !== '' && r.superseded_by_posted !== 'true').reduce((n, r) => n + Number(r.amount), 0);
    expect(Math.round(counted * 100)).toBe(Math.round(moved * 100));
  });

  test('a bank row standing for a split imported row is split as it was there too; its memo in an OFX statement says so, and the imported row’s own', async () => {
    const { ids } = await importStatement();
    const [food, home] = [catId('food and drink'), catId('home improvement')];
    await splitPut(ids['CORNER SHOP'], [
      { amount: 45, category_id: food },
      { amount: 15, category_id: home },
    ]);
    await splitPut(ids['OLD STORE'], [
      { amount: 60, category_id: food },
      { amount: 40, category_id: home },
    ]);
    let records = await statement();
    expect(records.get(ids['OLD STORE'])!.note).toContain('Split in Nya: Food and drink 60.00; Home improvement 40.00');
    expect(records.get(ids['CORNER SHOP'])!.note).toContain('Split in Nya: Food and drink 45.00; Home improvement 15.00');

    await storeBank([...BANK, bankTxn('b_corner', 'acc_chk', 50, 60, { name: 'CORNER SHOP 0042' })]);
    const csv = csvOf(await download());
    expect(csv.some((r) => r.transaction_id === ids['CORNER SHOP'])).toBe(false);
    expect(csv.filter((r) => r.transaction_id === 'b_corner' || r.split_of === 'b_corner').map((r) => [r.transaction_id, r.amount, r.nya_amount, r.split_of, r.nya_category])).toEqual([
      ['b_corner', '60', '', '', expect.any(String)],
      [expect.stringMatching(/^split:/), '', '45', 'b_corner', 'food and drink'],
      [expect.stringMatching(/^split:/), '', '15', 'b_corner', 'home improvement'],
    ]);
    records = await statement();
    expect(records.has(ids['CORNER SHOP'])).toBe(false);
    expect(records.get('b_corner')!.note).toContain('Split in Nya: Food and drink 45.00; Home improvement 15.00');
  });

  test('an OFX statement names the group an imported row is in, and the bank’s row that takes its place', async () => {
    const { ids } = await importStatement();
    await route('transaction-groups', 'POST', { name: 'Lunch with Sam', category_id: catId('food and drink'), members: [ids['CORNER SHOP'], 'b_payback'] });
    let records = await statement();
    for (const id of [ids['CORNER SHOP'], 'b_payback']) expect(records.get(id)!.note).toContain('In the group Lunch with Sam in Nya');
    await storeBank([...BANK, bankTxn('b_corner', 'acc_chk', 50, 60, { name: 'CORNER SHOP 0042' })]);
    records = await statement();
    for (const id of ['b_corner', 'b_payback']) expect(records.get(id)!.note).toContain('In the group Lunch with Sam in Nya');
  });
});

describe('everywhere else transactions are counted', () => {
  /** OLD STORE split into a shelf and snacks, and the corner shop grouped
   *  with Sam's payback under `category` (food and drink by default). */
  async function splitAndGroup(ids: Record<string, string>, category = catId('food and drink')) {
    expect(
      (
        await splitPut(ids['OLD STORE'], [
          { amount: 60, category_id: catId('food and drink') },
          { amount: 40, category_id: catId('home improvement') },
        ])
      ).status
    ).toBe(200);
    const made = await route('transaction-groups', 'POST', { name: 'Lunch with Sam', category_id: category, members: [ids['CORNER SHOP'], 'b_payback'] });
    expect(made.status).toBe(200);
    return made.body.id as string;
  }
  const spentBy = (categories: { category: string; spent?: number; amount?: number }[]) => Object.fromEntries(categories.map((c) => [c.category, c.spent ?? c.amount]));

  test('a report counts an imported row’s parts and its group’s net as the Activity tab does, and what the files cover is the same either way', async () => {
    const { ids } = await importStatement();
    const period = resolvePeriod({ kind: 'range', start: daysAgo(330), end: daysAgo(0) }, 'UTC', Date.now());
    if ('error' in period) throw new Error(period.error);
    const before = await readReport(ctx, period);
    const monthsBefore = await readMonthActivity(ctx, { since: daysAgo(400) });
    // The file covers the months before the bank's own rows begin, so the
    // report has no gap, and rollover counts those months whole.
    expect(before.gaps).toEqual([]);
    expect(monthsBefore.facts.first).toEqual([{ institution: 'Chase', day: daysAgo(55), files: [{ id: 'acc_chk', name: 'Checking', covers: [{ from: daysAgo(760), to: daysAgo(35) }], end: null }] }]);

    await splitAndGroup(ids);
    const report = await readReport(ctx, period);
    const app = summarize(await rowsOf(), (d) => d >= period.start && d <= period.end, report.currency);
    expect([report.totals.money_in, report.totals.money_out]).toEqual([app.money_in, app.money_out]);
    expect([report.totals.money_in, report.totals.money_out]).toEqual([500, 100 + 1850 + 40 + 5 + 20]);
    // The shelf on its own; the snacks, the lunch's net, the tip and the grocer's in food.
    expect(spentBy(report.money_out)).toMatchObject({ 'home improvement': 40, 'food and drink': 60 + 40 + 5 + 20 });
    expect(report.totals.transactions).toBe(app.transactions);
    // Which days the files cover, and so which months are whole, is the
    // files' and the bank's, never how a row is split or grouped.
    expect(report.gaps).toEqual(before.gaps);
    const monthsAfter = await readMonthActivity(ctx, { since: daysAgo(400) });
    expect([monthsAfter.facts, monthsAfter.earliest]).toEqual([monthsBefore.facts, monthsBefore.earliest]);
  });

  test('the read-only API and its MCP server list an imported row once, its parts and its group beside it, and spend by its parts', async () => {
    const saved = { ...process.env };
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CONTAINER_ID;
    try {
      const { ids } = await importStatement();
      const group = await splitAndGroup(ids);
      const from = daysAgo(330);
      const to = daysAgo(0);
      const page = await queryTransactions(ctx, { from, to, limit: 50 });
      const listed = (list: any[]) => list.filter((t) => [ids['OLD STORE'], ids['CORNER SHOP']].includes(t.id));
      const check = (list: any[]) => {
        const [shop, store] = listed(list);
        expect([shop.id, shop.amount, shop.source, shop.transaction_group?.id, shop.transaction_group?.net, shop.splits]).toEqual([ids['CORNER SHOP'], 60, 'import:ofx', group, 40, null]);
        expect([store.id, store.amount, store.splits?.map((p: any) => [p.amount, p.category])]).toEqual([
          ids['OLD STORE'],
          100,
          [
            [60, 'food and drink'],
            [40, 'home improvement'],
          ],
        ]);
      };
      check(page.transactions);
      const spending = await readSpending(ctx, { from, to });
      expect(spentBy(spending.categories)).toMatchObject({ 'home improvement': 40, 'food and drink': 125 });

      // The MCP server, as an assistant calls it, answers the same.
      const token = (await createToken(ctx, 'Tests')).token;
      let id = 1;
      const tool = async (name: string, args: Record<string, unknown>) => {
        const res: Response = await mcp.POST(
          new Request('https://nya.test/api/mcp', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
          })
        );
        const result = (await res.json()).result;
        expect(result.isError).not.toBe(true);
        return result.structuredContent;
      };
      check((await tool('search_transactions', { from, to, limit: 50 })).transactions);
      expect(spentBy((await tool('spending_by_category', { from, to })).categories)).toMatchObject({ 'home improvement': 40, 'food and drink': 125 });
    } finally {
      process.env = { ...saved };
    }
  });

  test('on an account that ended, an imported row dated from its end is left out, parts and all, and out of its group’s net; a report counts it once', async () => {
    const { ids } = await importStatement();
    const food = catId('food and drink');
    // OLD STORE, dated before the end, grouped with the tip, dated after it;
    // the corner shop, after it too, split.
    const old = await route('transaction-groups', 'POST', { name: 'Old errand', category_id: food, members: [ids['OLD STORE'], 'b_tip'] });
    expect(old.status).toBe(200);
    await splitPut(ids['CORNER SHOP'], [
      { amount: 45, category_id: food },
      { amount: 15, category_id: catId('home improvement') },
    ]);
    await markEnded(ctx, 'acc_chk', { state: 'closed', on: daysAgo(280) }, { type: 'depository', label: { name: 'Checking', institution: 'Chase', mask: '1111' }, item_id: 'item_chase' });

    const rows = await rowsOf();
    expect(rows.some((t) => t.transaction_id === ids['CORNER SHOP'] || t.split_of === ids['CORNER SHOP'])).toBe(false);
    const errand = rows.find((t) => t.group_id === old.body.id && t.group_members)!;
    expect([errand.amount, errand.group_missing, errand.group_members!.map((m) => m.transaction_id)]).toEqual([100, 1, [ids['OLD STORE']]]);

    const period = resolvePeriod({ kind: 'range', start: daysAgo(60), end: daysAgo(40) }, 'UTC', Date.now());
    if ('error' in period) throw new Error(period.error);
    const report = await readReport(ctx, period);
    // The rent, the corner shop (split, still one), the tip and the payback.
    expect(report.ended.find((e) => e.account.includes('Checking'))).toMatchObject({ not_counted: 4 });
    expect([report.totals.money_in, report.totals.money_out]).toEqual([0, 0]);
  });

  test('a category a part of an imported row, or its group, is filed under is in use', async () => {
    const { ids } = await importStatement();
    const usage = async (name: string) => (await categoryUsage(ctx, (await readTaxonomy(ctx))!, catId(name))).transactions;
    expect([await usage('home improvement'), await usage('entertainment')]).toEqual([0, 0]);
    await splitAndGroup(ids, catId('entertainment'));
    expect([await usage('home improvement'), await usage('entertainment')]).toEqual([1, 1]);
  });
});

describe('the month’s note on imported transactions', () => {
  test('counts transactions: a split one once, and each of a group’s imported ones', () => {
    const a = 'imported-txn:0b9c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
    const b = 'imported-txn:1c0d2e3f-4051-4b6c-9d7e-8f9a0b1c2d3e';
    const rows = [
      { transaction_id: `${PART_PREFIX}p1`, split_of: a },
      { transaction_id: `${PART_PREFIX}p2`, split_of: a },
      { transaction_id: 'group:g1', group_members: [{ transaction_id: b }, { transaction_id: 'b_payback' }] },
      { transaction_id: 'b_grocer' },
    ];
    expect(importedRowsNote(rows)).toBe('2 of this month’s transactions were imported from your bank’s files, not sent by the bank.');
    expect(importedRowsNote(rows.slice(3))).toBeNull();
  });
});
