import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Splits and groups (#39) on the rows imported into a linked account from its
// bank's files (#52): split and grouped through the routes by their ids, as a
// bank's are, their parts and nets counted where every total counts; kept
// past what prunes the bank's (a sync, a disconnect, an earlier account
// forgotten), and gone with their rows when the import is undone or the
// account they were imported into is forgotten; and a month's note on
// imported transactions counts transactions, never parts.

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
const { PART_PREFIX } = await import('@/lib/split-rows');
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
