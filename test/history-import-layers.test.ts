import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// Tags, notes and rules (#40, #36) on the rows imported into a linked account
// from its bank's files (#52): a tag or a note put on one through the
// annotations route by its id, the note kept beside it, over the file's own;
// what was said about one carried to the bank row that later takes its place,
// under what is said on that row; rules matching, naming, tagging, hiding and
// filing it as they do a bank's row (source "imported from a file", its
// account), counted by a rule's preview; undone with its import; and in the
// download (transactions.csv, the JSON, an OFX statement), a report and a
// category's usage, as the app shows it. Sharing, which shows none of it, is
// in test/sharing.test.ts.

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
const { txnAnnotationStore } = await import('@/lib/txn-annotations');
const { assembleBankRows, finishActivity } = await import('@/lib/activity');
const { queryTransactions } = await import('@/lib/api-read');
const { collectUserData, buildUserExport, exportFile, TRANSACTION_COLUMNS } = await import('@/lib/user-export');
const { ofxFile } = await import('@/lib/ofx-export');
const { parseOfx, ofxRecords } = await import('@/lib/import/ofx');
const { importedTxnStore } = await import('@/lib/history-import/store');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const { categoryUsage } = await import('@/lib/category-usage');
const { readTaxonomy } = await import('@/lib/category-store');
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
  bankTxn('b_domain', 'acc_chk', 20, 120, { name: 'DOMAIN RENEWAL' }),
  bankTxn('b_grocer', 'acc_chk', 3, 20, { name: 'GROCER', category: 'food and drink' }),
];

// Two years of the checking account, as its bank's OFX file gives them: the
// old store's with a memo, which becomes the row's own note.
const STATEMENT = (() => {
  const trns = [
    { fitid: 'F_domain2', days: 750, amount: -120, name: 'DOMAIN RENEWAL' },
    { fitid: 'F_domain1', days: 385, amount: -120, name: 'DOMAIN RENEWAL' },
    { fitid: 'F_old', days: 300, amount: -100, name: 'OLD STORE', memo: 'Paid by check 102' },
    { fitid: 'F_dep', days: 200, amount: 500, name: 'OLD DEPOSIT' },
    { fitid: 'F_rent', days: 55, amount: -1850, name: 'Online Transfer to Landlord' },
    { fitid: 'F_mid', days: 50, amount: -60, name: 'CORNER SHOP' },
  ]
    .map(
      (t) =>
        `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${compact(daysAgo(t.days))}</DTPOSTED><TRNAMT>${t.amount.toFixed(2)}</TRNAMT><FITID>${t.fitid}</FITID><NAME>${t.name}</NAME>${'memo' in t ? `<MEMO>${t.memo}</MEMO>` : ''}</STMTTRN>`
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
const activity = async () => {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true });
  return finishActivity(ctx, bank.payload, bank.hidden);
};
const rowOf = async (id: string) => (await activity()).transactions.find((t) => t.transaction_id === id);
const say = (body: Record<string, unknown>) => route('transaction-annotations', 'PATCH', body);
const addRule = async (rule: Record<string, unknown>) => {
  const r = await route('rules', 'POST', { action: 'add', rule });
  expect(r.status).toBe(200);
  return r.body.created as string;
};
const download = async () => buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
const csvOf = (doc: Awaited<ReturnType<typeof download>>) => {
  const [, ...rows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
  return new Map(rows.map((r) => [r[TRANSACTION_COLUMNS.indexOf('transaction_id')], Object.fromEntries(TRANSACTION_COLUMNS.map((c, i) => [c, r[i]]))]));
};
const statement = async () => {
  const data = await collectUserData({ ctx, userId: null });
  const made = ofxFile(data, buildUserExport(data, new Date()), 'acc_chk', new Date());
  if (!('file' in made)) throw new Error(made.refused);
  const parsed = parseOfx([...made.file.pieces()].join(''));
  expect(parsed.error).toBeNull();
  return { notes: made.file.notes, incomplete: made.file.incomplete, records: new Map(parsed.statements.flatMap((st) => ofxRecords(st).records).map((r) => [r.source_id ?? '', r])) };
};

let categories: any;
const catId = (name: string) => categories.categories.find((c: any) => c.name === name).id;
let work = '';

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
  work = (await route('tags', 'POST', { action: 'add', name: 'Work' })).body.created;
});

describe('tags and notes on an imported row', () => {
  test('put on by its id through the annotations route; the note is kept beside the row, over the file’s own, and an empty one clears it', async () => {
    const { ids } = await importStatement();
    const old = ids['OLD STORE'];
    // The file's memo is the row's own note until the person writes one.
    expect((await rowOf(old))!.note).toBe('Paid by check 102');

    const res = await say({ transaction_id: old, add_tags: [work], note: 'Birthday present for Sam' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tags: [work], note: 'Birthday present for Sam' });
    expect(await rowOf(old)).toMatchObject({ tags: [work], note: 'Birthday present for Sam' });
    // Beside the row, which stays as its file gave it.
    expect((await importedTxnStore.get(ctx, 'acc_chk'))!.rows.find((r) => r.id === old)!.note).toBe('Paid by check 102');
    expect(await txnAnnotationStore.get(ctx, old)).toMatchObject({ tags: [work], note: 'Birthday present for Sam' });
    // The read-only API reads the same, and finds it by its tag.
    const api = await queryTransactions(ctx, { from: daysAgo(400), to: daysAgo(0), tagId: work, limit: 50 });
    expect(api.transactions.map((t) => [t.id, t.note])).toEqual([[old, 'Birthday present for Sam']]);

    // Cleared, it has no note at all: not the file's either.
    await say({ transaction_id: old, note: '' });
    expect((await rowOf(old))!.note).toBeNull();
    // Taken off, a tag a rule adds stays off.
    await addRule({ conditions: [{ field: 'name', op: 'contains', value: 'old store' }], actions: { add_tags: [work] } });
    expect((await rowOf(old))!.tags).toEqual([work]);
    await say({ transaction_id: old, remove_tags: [work] });
    expect((await rowOf(old))!.tags).toBeUndefined();
  });

  test('undoing the import takes what was said about its rows with them, tags and notes too', async () => {
    const { import_id, ids } = await importStatement();
    await say({ transaction_id: ids['OLD STORE'], add_tags: [work], note: 'Birthday present for Sam' });
    const undone = await routes.DELETE(
      new Request('http://localhost/api/history-import', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 'acc_chk', import_id, confirm: true }) })
    );
    expect(undone.status).toBe(200);
    expect(await txnAnnotationStore.get(ctx, ids['OLD STORE'])).toBeNull();
  });
});

describe('what was said about an imported row the bank later sends', () => {
  test('carries to the bank’s row that takes its place: its tags, its note, and an include over a rule’s hide; what is said on that row wins', async () => {
    const { ids } = await importStatement();
    const shop = ids['CORNER SHOP'];
    // A rule hides the shop's rows; the person puts this one back, and tags
    // and notes it.
    await addRule({ conditions: [{ field: 'name', op: 'contains', value: 'corner' }], actions: { hide: true } });
    expect(await rowOf(shop)).toMatchObject({ excluded: true, excluded_by_rule: true });
    await say({ transaction_id: shop, excluded: false, add_tags: [work], note: 'Milk for the office' });

    await storeBank([...BANK, bankTxn('b_corner', 'acc_chk', 50, 60, { name: 'CORNER SHOP 0042' })]);
    const rows = (await activity()).transactions;
    expect(rows.some((t) => t.transaction_id === shop)).toBe(false);
    const bank = rows.find((t) => t.transaction_id === 'b_corner')!;
    expect(bank).toMatchObject({ tags: [work], note: 'Milk for the office' });
    // Put back, so the rule's hide doesn't hide the bank's either.
    expect(bank.excluded).toBeUndefined();
    expect(bank.rule_ids).toHaveLength(1);

    // Said otherwise on the bank's row: that wins, field by field.
    await say({ transaction_id: 'b_corner', excluded: true, remove_tags: [work], note: '' });
    const after = (await rowOf('b_corner'))!;
    expect([after.excluded, after.excluded_by_rule, after.tags, after.note]).toEqual([true, undefined, undefined, undefined]);
  });

  test('an exclusion carries, and a record that can’t be read leaves it unknown, as the row’s own would', async () => {
    const { ids } = await importStatement();
    await say({ transaction_id: ids['CORNER SHOP'], excluded: true });
    await storeBank([...BANK, bankTxn('b_corner', 'acc_chk', 50, 60, { name: 'CORNER SHOP 0042' })]);
    expect((await rowOf('b_corner'))!.excluded).toBe(true);
    await fake.hset(ctxKey('transaction-annotations'), { [ids['CORNER SHOP']]: 'not-ciphertext-but-long-enough-to-be-tried' });
    expect((await rowOf('b_corner'))!.excluded).toBeNull();
  });
});

describe('rules', () => {
  test('match an imported row as a bank’s: from a file and on its account; they name, tag, hide and file it, a category only where it has none of its own', async () => {
    const { ids } = await importStatement();
    const travel = catId('travel');
    const fromFiles = await addRule({
      conditions: [
        { field: 'source', op: 'equals', value: 'import' },
        { field: 'account', op: 'equals', value: 'acc_chk' },
      ],
      actions: { set_category: travel, add_tags: [work] },
    });
    const corner = await addRule({ conditions: [{ field: 'name', op: 'contains', value: 'corner' }], actions: { set_name: 'Corner Shop', hide: true } });
    const rows = (await activity()).transactions;
    const imported = rows.filter((t) => t.transaction_id.startsWith('imported-txn:'));
    expect(imported.map((t) => t.transaction_id).sort()).toEqual([ids['CORNER SHOP'], ids['OLD DEPOSIT'], ids['OLD STORE']].sort());
    for (const t of imported) expect(t).toMatchObject({ category_id: travel, category_by_rule: true, tags: [work] });
    expect(rows.find((t) => t.transaction_id === ids['CORNER SHOP'])).toMatchObject({
      name: 'Corner Shop',
      name_before_rules: 'CORNER SHOP',
      excluded: true,
      excluded_by_rule: true,
      rule_ids: [corner, fromFiles],
    });
    // The bank's own rows aren't from a file.
    expect(rows.find((t) => t.transaction_id === 'b_grocer')!.rule_ids).toBeUndefined();

    // Your category for one, and your name for its merchant: no rule's
    // replaces either.
    const groceries = catId('food and drink');
    expect((await route('recategorize', 'POST', { transaction_id: ids['OLD STORE'], category_id: groceries })).status).toBe(200);
    const vendor = rows.find((t) => t.transaction_id === ids['CORNER SHOP'])!.vendor_key;
    expect((await route('rename', 'POST', { vendor_key: vendor, name: 'My corner shop' })).status).toBe(200);
    const store = (await rowOf(ids['OLD STORE']))!;
    expect([store.category_id, store.category_by_rule]).toEqual([groceries, undefined]);
    const shop = (await rowOf(ids['CORNER SHOP']))!;
    expect([shop.name, shop.rule_ids]).toEqual(['My corner shop', [corner, fromFiles]]);
  });

  test('a rule’s preview counts the imported rows that count, of any date, on their account too', async () => {
    await importStatement();
    const preview = async (conditions: unknown[]) => (await route('rules/preview', 'POST', { rule: { conditions, actions: { hide: true } } })).body;
    // The renewals before the loaded year among them; never the rent, which
    // stands for the bank's.
    expect((await preview([{ field: 'source', op: 'equals', value: 'import' }])).matches).toBe(5);
    const renewals = await preview([
      { field: 'account', op: 'equals', value: 'acc_chk' },
      { field: 'name', op: 'equals', value: 'domain renewal' },
    ]);
    expect(renewals.matches).toBe(3);
    expect(renewals.samples.map((s: any) => s.account_name)).toEqual(['Checking', 'Checking', 'Checking']);
  });
});

describe('the download', () => {
  test('transactions.csv has each imported row as the app shows it: your note over the file’s, its tags, the name a rule or your rename gives it, a rule’s hide and category', async () => {
    const { ids } = await importStatement();
    const travel = catId('travel');
    await addRule({ conditions: [{ field: 'source', op: 'equals', value: 'import' }], actions: { set_category: travel } });
    await addRule({ conditions: [{ field: 'name', op: 'contains', value: 'corner' }], actions: { set_name: 'Corner Shop', hide: true, add_tags: [work] } });
    await say({ transaction_id: ids['OLD STORE'], note: 'Birthday present for Sam' });
    const deposit = (await rowOf(ids['OLD DEPOSIT']))!;
    await route('rename', 'POST', { vendor_key: deposit.vendor_key, name: 'Mum' });

    const csv = csvOf(await download());
    expect(csv.get(ids['CORNER SHOP'])).toMatchObject({ name: 'CORNER SHOP', nya_name: 'Corner Shop', excluded: 'true', tags: 'Work', nya_category: 'travel' });
    expect(csv.get(ids['OLD STORE'])).toMatchObject({ note: 'Birthday present for Sam', excluded: 'false', nya_category: 'travel' });
    expect(csv.get(ids['OLD DEPOSIT'])).toMatchObject({ name: 'OLD DEPOSIT', your_merchant_name: 'Mum', nya_name: 'Mum' });
    // Before the loaded year too, as the app files them.
    const renewals = [...csv.values()].filter((r) => r.source === 'import:ofx' && r.name === 'DOMAIN RENEWAL');
    expect(renewals.map((r) => r.nya_category)).toEqual(['travel', 'travel']);
    // Every one the app lists reads the same in the file.
    for (const t of (await activity()).transactions.filter((x) => x.transaction_id.startsWith('imported-txn:'))) {
      const r = csv.get(t.transaction_id)!;
      expect([r.nya_name, r.excluded, r.note, r.tags, r.nya_category]).toEqual([t.name, String(t.excluded === true), t.note ?? '', t.tags ? 'Work' : '', t.category_name ?? '']);
    }
  });

  test('the bank’s row standing for an imported one has what was said about it, in the JSON, transactions.csv and an OFX statement', async () => {
    const { ids } = await importStatement();
    await say({ transaction_id: ids['CORNER SHOP'], excluded: true, add_tags: [work], note: 'Milk for the office' });
    await storeBank([...BANK, bankTxn('b_corner', 'acc_chk', 50, 60, { name: 'CORNER SHOP 0042' })]);
    const doc = await download();
    expect(doc.transactions.find((t) => t.transaction_id === 'b_corner')).toMatchObject({ tags: ['Work'], your_note: 'Milk for the office', excluded: true, excluded_by_rule: false });
    expect(csvOf(doc).get('b_corner')).toMatchObject({ tags: 'Work', note: 'Milk for the office', excluded: 'true' });
    const ofx = await statement();
    const memo = ofx.records.get('b_corner')!.note!;
    for (const said of ['Excluded from budgets and reports in Nya', 'Milk for the office', 'Tags: Work']) expect(memo).toContain(said);
  });

  test('an OFX statement writes an imported row as the app shows it: a rule’s name and hide, the file’s name beside it, your note and its tags', async () => {
    const { ids } = await importStatement();
    await addRule({ conditions: [{ field: 'name', op: 'contains', value: 'corner' }], actions: { set_name: 'The Corner Shop', hide: true, add_tags: [work] } });
    await say({ transaction_id: ids['CORNER SHOP'], note: 'Milk for the office' });
    await say({ transaction_id: ids['OLD STORE'], excluded: true });
    const ofx = await statement();
    const shop = ofx.records.get(ids['CORNER SHOP'])!;
    expect(shop.description).toBe('The Corner Shop');
    for (const said of ['Hidden from budgets and reports by a rule in Nya', 'CORNER SHOP', 'Milk for the office', 'Tags: Work']) expect(shop.note).toContain(said);
    // The file's own memo, where nothing was said; excluded by the person.
    const old = ofx.records.get(ids['OLD STORE'])!;
    expect(old.note).toContain('Excluded from budgets and reports in Nya');
    expect(old.note).toContain('Paid by check 102');
  });

  test('what was said about an imported row that can’t be read: the files are called incomplete, and the bank’s row standing for it isn’t marked either way', async () => {
    const { ids } = await importStatement();
    await say({ transaction_id: ids['CORNER SHOP'], excluded: true });
    await storeBank([...BANK, bankTxn('b_corner', 'acc_chk', 50, 60, { name: 'CORNER SHOP 0042' })]);
    await fake.hset(ctxKey('transaction-annotations'), { [ids['CORNER SHOP']]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const doc = await download();
    expect(doc.transactions.find((t) => t.transaction_id === 'b_corner')!.excluded).toBeNull();
    const csv = exportFile(doc, 'transactions-csv');
    expect(csv.incomplete).toEqual(['transaction-annotations']);
    expect(csv.notes.some((n) => n.startsWith('Not all of your notes, tags and exclusions could be read: 1 entry whose stored data is damaged.'))).toBe(true);
    expect(csvOf(doc).get('b_corner')!.excluded).toBe('');
    const ofx = await statement();
    expect(ofx.incomplete).toContain('transaction-annotations');
    expect(ofx.notes).toContain(
      'What you said about 1 of these transactions could not be read, so it isn’t marked as excluded from budgets and reports or not, and its memo may be missing your note and tags. The JSON download lists them under problems. Nothing was changed: what could not be read is still stored as it was.'
    );
  });
});

describe('parts the files are made from that can’t be read', () => {
  test('rules or tags: transactions.csv and an OFX statement apply none and say so, and are called incomplete', async () => {
    const { ids } = await importStatement();
    await addRule({ conditions: [{ field: 'name', op: 'contains', value: 'corner' }], actions: { set_name: 'The Corner Shop', add_tags: [work] } });
    await fake.set(ctxKey('rules'), 'not-ciphertext-but-long-enough-to-be-tried');
    let doc = await download();
    let csv = exportFile(doc, 'transactions-csv');
    expect(csv.incomplete).toEqual(['rules']);
    expect(csv.notes).toContain(
      'Your rules could not be read (the stored data is damaged), so none is applied in this file, as the app applies none until they can be read: its names, categories, tags and exclusions are as they are without your rules. Nothing was changed: what could not be read is still stored as it was.'
    );
    expect(csvOf(doc).get(ids['CORNER SHOP'])).toMatchObject({ nya_name: 'CORNER SHOP', tags: '' });
    let ofx = await statement();
    expect(ofx.incomplete).toContain('rules');
    expect(ofx.notes.some((n) => n.startsWith('Your rules could not be read, so none is applied in this statement'))).toBe(true);

    await fake.del(ctxKey('rules'));
    await say({ transaction_id: ids['CORNER SHOP'], add_tags: [work] });
    await fake.set(ctxKey('tags'), 'not-ciphertext-but-long-enough-to-be-tried');
    doc = await download();
    csv = exportFile(doc, 'transactions-csv');
    expect(csv.incomplete).toEqual(['tags']);
    expect(csv.notes).toContain(
      'Your tags could not be read (the stored data is damaged), so the tags column is empty, as the app shows no tags until they can be read. Nothing was changed: what could not be read is still stored as it was.'
    );
    expect(csvOf(doc).get(ids['CORNER SHOP'])!.tags).toBe('');
    ofx = await statement();
    expect(ofx.incomplete).toContain('tags');
    expect(ofx.notes.some((n) => n.startsWith('Your tags could not be read, so no memo has them'))).toBe(true);
  });

  test('an imported row’s book, or what was carried from an earlier account: transactions.csv says what it is missing', async () => {
    await importStatement();
    await fake.hset(ctxKey('carried-annotations'), { acc_old: 'not-ciphertext-but-long-enough-to-be-tried' });
    await fake.hset(ctxKey('imported-transactions'), { acc_chk: 'not-ciphertext-but-long-enough-to-be-tried' });
    const csv = exportFile(await download(), 'transactions-csv');
    expect(csv.incomplete).toEqual(['carried-annotations', 'imported-transactions']);
    expect(csv.notes).toContain(
      'Not all of your transactions imported into linked accounts could be read, so this file is missing the imported transactions of 1 account whose stored data is damaged, and a transaction the bank sent that stands for one of them doesn’t show what you said about it. The JSON download lists them under problems. Nothing was changed: what could not be read is still stored as it was.'
    );
    expect(csv.notes).toContain(
      'Not all of your notes, tags and exclusions carried from earlier accounts could be read: 1 entry whose stored data is damaged. The transactions of the accounts you linked those to are in this file without them. The JSON download lists them under problems. Nothing was changed: what could not be read is still stored as it was.'
    );
  });
});

describe('a report and a category’s usage', () => {
  test('a report counts an imported row a rule hides as hidden by a rule', async () => {
    const { ids } = await importStatement();
    await addRule({ conditions: [{ field: 'name', op: 'contains', value: 'corner' }], actions: { hide: true } });
    await addRule({ conditions: [{ field: 'name', op: 'contains', value: 'old store' }], actions: { add_tags: [work] } });
    await say({ transaction_id: ids['OLD DEPOSIT'], excluded: true });
    const period = resolvePeriod({ kind: 'range', start: daysAgo(330), end: daysAgo(0) }, 'UTC', Date.now());
    if ('error' in period) throw new Error(period.error);
    const report = await readReport(ctx, period);
    expect(report.totals).toMatchObject({ excluded: 2, hidden_by_rule: 1 });
  });

  test('a category a rule files imported rows under is in use, by the rule and by them', async () => {
    await importStatement();
    const travel = catId('travel');
    await addRule({ conditions: [{ field: 'source', op: 'equals', value: 'import' }], actions: { set_category: travel } });
    const usage = await categoryUsage(ctx, (await readTaxonomy(ctx))!, travel);
    expect(usage.rules).toBe(1);
    expect(usage.transactions).toBeGreaterThanOrEqual(3);
  });
});
