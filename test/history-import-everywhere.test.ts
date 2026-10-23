import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// The rows imported into a linked account (#52) everywhere else transactions
// are read, all through the shared read layer (lib/activity.ts) and the
// shared spending rule: the API and MCP, spending and budgets with the
// person's exclusions and categories, recurring detection (rows from before
// the loaded year among them), the Plan's spending baseline, hidden accounts,
// the data download (JSON and transactions.csv), storage usage, and what a
// disconnect keeps and forgetting the account takes. Sharing is in
// test/sharing.test.ts; the chart's history in history-import-walk-route.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// The real size ceiling, whatever a file before this one lowered it to
// (lib/blob.ts reads it each time it is used; test/preload.ts puts it back too).
delete process.env.MAX_TXN_BLOB_CHARS;

const plaid = { later: [] as unknown[] };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    itemRemove: async () => ({ data: {} }),
    transactionsSync: async () => ({
      data: {
        added: plaid.later.splice(0),
        modified: [],
        removed: [],
        accounts: [],
        next_cursor: 'c-next',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem, getItems } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { setExcluded, changeAnnotation, txnAnnotationStore } = await import('@/lib/txn-annotations');
const { getOverrides } = await import('@/lib/overrides');
const { setBudgets } = await import('@/lib/budgets');
const { readTaxonomy } = await import('@/lib/category-store');
const { setAccountHidden } = await import('@/lib/hidden');
const { recordDirectory, forgetEarlierAccount } = await import('@/lib/links');
const { disconnectItem } = await import('@/lib/disconnect-item');
const { assembleBankRows, finishActivity } = await import('@/lib/activity');
const { queryTransactions, readSpending, readBudgets, readRecurring } = await import('@/lib/api-read');
const { callTool } = await import('@/lib/mcp');
const { trailingFlows } = await import('@/lib/fire/inputs');
const { readStorageUsage } = await import('@/lib/blob-sizes');
const { collectUserData, buildUserExport, exportFile, TRANSACTION_COLUMNS } = await import('@/lib/user-export');
const { ofxFile } = await import('@/lib/ofx-export');
const { parseOfx, ofxRecords } = await import('@/lib/import/ofx');
const { importedTxnStore, historyImportStore, historyImportSummaryStore } = await import('@/lib/history-import/store');
const routes = await import('@/app/api/history-import/route');
const transactions = await import('@/app/api/transactions/route');
const recategorize = await import('@/app/api/recategorize/route');

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
  // A domain renewed every year: the bank has this year's charge only.
  bankTxn('b_domain', 'acc_chk', 20, 120, { name: 'DOMAIN RENEWAL' }),
  bankTxn('b_grocer', 'acc_chk', 3, 20, { name: 'GROCER', category: 'food and drink' }),
  bankTxn('b_card', 'acc_card', 20, 80, { name: 'CARD SHOP', account_name: 'Visa', category: 'general merchandise' }),
];

function ofx(trns: { fitid: string; days: number; amount: number; name: string }[], period: { start: number; end: number }) {
  const list = trns
    .map((t) => `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${compact(daysAgo(t.days))}</DTPOSTED><TRNAMT>${t.amount.toFixed(2)}</TRNAMT><FITID>${t.fitid}</FITID><NAME>${t.name}</NAME></STMTTRN>`)
    .join('\n');
  return `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>325081403</BANKID><ACCTID>0009991111</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>${compact(daysAgo(period.start))}</DTSTART><DTEND>${compact(daysAgo(period.end))}</DTEND>\n${list}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

// Two years of the checking account: the domain's renewals before the bank's
// own (one before the loaded year), an old purchase and deposit, a purchase
// the bank's period holds but never sent, and the rent the bank did send.
const STATEMENT = ofx(
  [
    { fitid: 'F_domain2', days: 750, amount: -120, name: 'DOMAIN RENEWAL' },
    { fitid: 'F_domain1', days: 385, amount: -120, name: 'DOMAIN RENEWAL' },
    { fitid: 'F_old', days: 300, amount: -100, name: 'OLD STORE' },
    { fitid: 'F_dep', days: 200, amount: 500, name: 'OLD DEPOSIT' },
    { fitid: 'F_rent', days: 55, amount: -1850, name: 'Online Transfer to Landlord' },
    { fitid: 'F_mid', days: 50, amount: -60, name: 'CORNER SHOP' },
  ],
  { start: 760, end: 35 }
);
const IMPORTED_NOW = ['CORNER SHOP', 'OLD DEPOSIT', 'OLD STORE'];

async function storeBank(rows: ReturnType<typeof bankTxn>[]) {
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob(TEST_CTX, {
      schema_version: 2,
      cursor: 'c1',
      accounts: {
        acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
        acc_card: { name: 'Visa', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: null },
      },
      txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])),
      synced_at: new Date().toISOString(),
    })
  );
}

async function seed() {
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt(TEST_CTX, 'access-sandbox-chase') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await encrypt(TEST_CTX, 
      JSON.stringify([
        { account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' },
        { account_id: 'acc_card', name: 'Visa', official_name: null, mask: '2222', type: 'credit', subtype: 'credit card', limit: 5000, currency: 'USD' },
      ])
    ),
  });
  await storeBank(BANK);
}

function upload(meta: Record<string, unknown>, file: string): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(file) as Uint8Array<ArrayBuffer>]), 'statement.ofx');
  form.set('meta', JSON.stringify({ file_name: 'statement.ofx', ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
}
/** Reviews the statement, then imports it as reviewed. */
async function importStatement(): Promise<string> {
  const p = await routes.POST(upload({ action: 'preview', account_id: 'acc_chk' }, STATEMENT));
  const review = (await p.json()).preview.review;
  const res = await routes.POST(upload({ action: 'import', account_id: 'acc_chk', review }, STATEMENT));
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body).toMatchObject({ imported: 5, duplicates: 1 });
  return body.import_id;
}
const activity = async (includeHidden = false) => {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, includeHidden, withAccountIds: true });
  return finishActivity(ctx, bank.payload, includeHidden ? new Set() : bank.hidden);
};
const importedRow = async (name: string) => (await activity()).transactions.find((t) => t.name === name && t.source === 'import:ofx')!;
const window = { from: daysAgo(364), to: daysAgo(0) };
const download = async () => buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
const csvRows = (doc: Awaited<ReturnType<typeof download>>) => {
  const [, ...rows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
  const col = (r: string[], name: (typeof TRANSACTION_COLUMNS)[number]) => r[TRANSACTION_COLUMNS.indexOf(name)];
  return rows.map((r) => ({ id: col(r, 'transaction_id'), name: col(r, 'name'), amount: col(r, 'amount'), source: col(r, 'source'), account_id: col(r, 'account_id'), yours: col(r, 'your_category') }));
};

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  plaid.later = [];
  await registerTestContainer(fake);
  await seed();
});

describe('the API and MCP', () => {
  test('list the imported rows beside the bank’s, with their source, id and account; a duplicate of the bank’s row is listed once, as the bank’s', async () => {
    await importStatement();
    const page = await queryTransactions(ctx, { ...window, limit: 100 });
    const imported = page.transactions.filter((t) => t.source === 'import:ofx');
    expect(imported.map((t) => t.name).sort()).toEqual(IMPORTED_NOW);
    for (const t of imported) {
      expect(t.id).toMatch(/^imported-txn:/);
      expect(t).toMatchObject({ account_id: 'acc_chk', account_name: 'Checking', institution: 'Chase', pending: false, hidden: false });
    }
    // Plaid's sign, as every row: the deposit is money in.
    expect(imported.find((t) => t.name === 'OLD DEPOSIT')!.amount).toBe(-500);
    expect(page.transactions.filter((t) => t.amount === 1850).map((t) => t.id)).toEqual(['b_rent']);
    // The bank's own rows say so, as before.
    expect(page.transactions.find((t) => t.id === 'b_grocer')!.source).toBe('plaid');

    // MCP's search reads the same.
    const mcp = (await callTool({ ctx, access: 'read' } as any, 'search_transactions', { from: window.from, to: window.to, limit: 100 })) as any;
    expect(mcp.isError).toBeUndefined();
    expect(mcp.structuredContent.transactions.filter((t: any) => t.source === 'import:ofx').map((t: any) => t.name).sort()).toEqual(IMPORTED_NOW);
  });
});

describe('spending, budgets and the Plan', () => {
  test('count the imported rows by the shared rule, and the person’s exclusion and category work on them as on any row', async () => {
    const before = await readSpending(ctx, window);
    await importStatement();
    const after = await readSpending(ctx, window);
    // The old purchase and the corner shop out, the deposit in; the rent
    // duplicate never, and the renewals before the year aren't in it.
    expect(after.money_out).toBeCloseTo(before.money_out + 160, 2);
    expect(after.money_in).toBeCloseTo(before.money_in + 500, 2);
    expect(after.counted).toBe(before.counted + 3);

    // The corner shop is the person's groceries, budgeted for its month.
    const shop = await importedRow('CORNER SHOP');
    const res = await recategorize.POST(new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id: shop.transaction_id, category: 'groceries' }) }));
    expect(res.status).toBe(200);
    await setBudgets(ctx, { groceries: 200 });
    const month = daysAgo(50).slice(0, 7);
    expect((await readBudgets(ctx, { month })).budgets).toEqual([expect.objectContaining({ category: 'groceries', budget: 200, spent: 60 })]);
    // Filed into the person's own category, by its id and group, once the app
    // has stored their categories (its own load grows them).
    await transactions.GET(new Request('http://localhost/api/transactions'));
    const taxonomy = (await readTaxonomy(ctx))!;
    const groceries = taxonomy.categories.find((c) => c.provider_keys.some((k) => k.provider === 'text' && k.key === 'groceries'))!;
    const group = taxonomy.groups.find((g) => g.id === groceries.group)!;
    expect((await readSpending(ctx, window)).categories.find((c) => c.category_id === groceries.id)).toEqual({
      category: groceries.name,
      category_id: groceries.id,
      group: group.name,
      group_id: group.id,
      spent: 60,
      transactions: 1,
    });

    // Excluded, it counts nowhere, and is said to be left out.
    await setExcluded(ctx, shop.transaction_id, true);
    const budgets = await readBudgets(ctx, { month });
    expect(budgets.budgets[0].spent).toBe(0);
    expect(budgets.excluded).toBe(1);
    const excluded = await readSpending(ctx, window);
    expect(excluded.money_out).toBeCloseTo(before.money_out + 100, 2);
    expect(excluded.excluded).toBe(before.excluded + 1);
  });

  test('the Plan’s spending baseline reaches back through them: a longer history, scaled less', async () => {
    const today = daysAgo(0);
    const before = trailingFlows((await activity()).transactions, today)!;
    expect(before.from).toBe(daysAgo(55));
    await importStatement();
    const after = trailingFlows((await activity()).transactions, today)!;
    expect(after.from).toBe(daysAgo(300));
    expect(after.count).toBe(before.count + 3);
    // Unscaled, the year's spending is the bank's and the two purchases.
    const unscaled = (f: typeof after) => (f.spending * f.days) / 365;
    expect(unscaled(after)).toBeCloseTo(unscaled(before) + 160, 2);
  });
});

describe('recurring detection', () => {
  test('sees a yearly bill through the imported renewals, the one before the loaded year among them', async () => {
    const domain = (r: Awaited<ReturnType<typeof readRecurring>>) => r.bills.find((b) => b.name === 'DOMAIN RENEWAL');
    expect(domain(await readRecurring(ctx))).toBeUndefined();
    await importStatement();
    // The renewal before the loaded year is sent for detection only.
    const shown = await activity();
    expect(shown.transactions.some((t) => t.name === 'DOMAIN RENEWAL' && t.source === 'import:ofx')).toBe(false);
    expect(shown.history.filter((t) => t.name === 'DOMAIN RENEWAL').map((t) => t.date)).toEqual(expect.arrayContaining([daysAgo(385)]));
    expect(domain(await readRecurring(ctx))).toMatchObject({ cadence: 'yearly', amount: 120, last_date: daysAgo(20), institution: 'Chase' });
  });
});

describe('a hidden account', () => {
  test('its imported rows are left out as the bank’s are, and listed, marked, when hidden accounts are asked for', async () => {
    await importStatement();
    await setAccountHidden(ctx, 'acc_chk', 'depository', true);
    expect((await queryTransactions(ctx, { ...window, limit: 100 })).transactions.filter((t) => t.source === 'import:ofx')).toEqual([]);
    expect((await activity()).transactions.some((t) => t.source === 'import:ofx')).toBe(false);
    const all = await queryTransactions(ctx, { ...window, limit: 100, includeHidden: true });
    const imported = all.transactions.filter((t) => t.source === 'import:ofx');
    expect(imported.length).toBe(3);
    expect(imported.every((t) => t.hidden)).toBe(true);
  });
});

describe('the download of my data', () => {
  test('keeps the books and the imports, raw records and all, in the JSON; transactions.csv has each counted row once, and never a superseded one', async () => {
    const import_id = await importStatement();
    const shop = await importedRow('CORNER SHOP');
    await recategorize.POST(new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id: shop.transaction_id, category: 'groceries' }) }));
    const doc = await download();
    expect(doc.problems).toEqual([]);
    const books = doc['imported-transactions'] as { id: string; value: { rows: { source: string; source_id: string; import_id: string; same_as?: unknown }[] } }[];
    expect(books.map((b) => b.id)).toEqual(['acc_chk']);
    expect(books[0].value.rows.length).toBe(6);
    expect(books[0].value.rows.every((r) => r.source === 'import:ofx' && r.import_id === import_id && r.source_id.startsWith('F_'))).toBe(true);
    const imports = doc['history-imports'] as { id: string; value: { account_id: string; records: { raw: unknown }[] } }[];
    expect(imports.map((i) => i.id)).toEqual([import_id]);
    expect(imports[0].value.records.length).toBe(6);
    expect(imports[0].value.records.every((r) => !!r.raw)).toBe(true);
    // Bookkeeping isn't the person's data.
    expect(Object.keys(doc)).not.toContain('history-import-summaries');
    expect(Object.keys(doc)).not.toContain('imported-history-walk');

    const rows = csvRows(doc);
    const imported = rows.filter((r) => r.source === 'import:ofx');
    // Every counted row, those before the loaded year too; the rent once, as the bank's.
    expect(imported.map((r) => r.name).sort()).toEqual(['CORNER SHOP', 'DOMAIN RENEWAL', 'DOMAIN RENEWAL', 'OLD DEPOSIT', 'OLD STORE']);
    expect(imported.every((r) => r.account_id === 'acc_chk' && r.id.startsWith('imported-txn:'))).toBe(true);
    expect(rows.filter((r) => r.amount === '1850').map((r) => r.id)).toEqual(['b_rent']);
    expect(imported.find((r) => r.name === 'CORNER SHOP')!.yours).toBe('groceries');
    expect(imported.find((r) => r.name === 'OLD DEPOSIT')!.amount).toBe('-500');

    // The bank sends the corner shop later: in the CSV once, as the bank's,
    // with the category set on the imported row.
    const mid = bankTxn('b_mid', 'acc_chk', 49, 60, { name: 'CORNER SHOP #12' });
    await storeBank([...BANK, mid]);
    const later = csvRows(await download());
    expect(later.filter((r) => r.amount === '60').map((r) => [r.id, r.source, r.yours])).toEqual([['b_mid', 'plaid', 'groceries']]);
    // The bank takes its rent back: the row kept as its duplicate is a row again.
    await storeBank([...BANK.filter((t) => t.transaction_id !== 'b_rent'), mid]);
    const after = csvRows(await download());
    expect(after.filter((r) => r.amount === '1850').map((r) => [r.name, r.source])).toEqual([['Online Transfer to Landlord', 'import:ofx']]);
  });
});

describe('the checking account’s OFX statement', () => {
  test('holds the imported transactions that count, with Nya’s own ids, beside the bank’s, each once, and says so', async () => {
    await importStatement();
    // Excluded on the imported row the bank later sends: the bank's is excluded too.
    const shop = await importedRow('CORNER SHOP');
    await setExcluded(ctx, shop.transaction_id, true);
    await storeBank([...BANK, bankTxn('b_mid', 'acc_chk', 49, 60, { name: 'CORNER SHOP #12' })]);
    const data = await collectUserData({ ctx, userId: null });
    const made = ofxFile(data, buildUserExport(data, new Date()), 'acc_chk', new Date());
    if (!('file' in made)) throw new Error(made.refused);
    const parsed = parseOfx([...made.file.pieces()].join(''));
    expect(parsed.error).toBeNull();
    const records = parsed.statements.flatMap((st) => ofxRecords(st).records);
    const fitids = records.map((r) => r.source_id ?? '');
    // The bank's rows, the rent once (the bank's: the file's is its duplicate),
    // the corner shop once (the bank's), and the imported rows that count:
    // every one older than the bank's, the renewals before the year among them.
    expect(fitids.filter((id) => id.startsWith('imported-txn:')).length).toBe(4);
    expect(records.filter((r) => Math.abs(r.amount) === 1850).map((r) => r.source_id)).toEqual(['b_rent']);
    expect(records.filter((r) => Math.abs(r.amount) === 60).map((r) => r.source_id)).toEqual(['b_mid']);
    expect(records.filter((r) => r.source_id?.startsWith('imported-txn:')).map((r) => r.description).sort()).toEqual(['DOMAIN RENEWAL', 'DOMAIN RENEWAL', 'OLD DEPOSIT', 'OLD STORE']);
    // The bank's corner shop stands for the one the person excluded: excluded too.
    expect(records.find((r) => r.source_id === 'b_mid')!.note).toContain('Excluded from budgets and reports in Nya');
    expect(made.file.notes.some((n) => n.startsWith('4 transactions you imported from files are in it'))).toBe(true);
  });
});

describe('storage usage', () => {
  test('measures the books and the imports', async () => {
    await importStatement();
    const { stores } = await readStorageUsage(ctx);
    const named = (name: string) => stores.find((s) => s.store === name);
    expect(named('imported-transactions')).toMatchObject({ entries: 1 });
    expect(named('history-imports')).toMatchObject({ entries: 1 });
    expect(named('imported-transactions')!.chars).toBeGreaterThan(0);
  });
});

describe('disconnecting and forgetting', () => {
  test('a disconnect keeps the imported rows and what was said about them, for a re-link; forgetting the account takes them all', async () => {
    const import_id = await importStatement();
    const shop = await importedRow('CORNER SHOP');
    await changeAnnotation(ctx, shop.transaction_id, { excluded: true, add: ['tag-work'], note: 'Milk for the office' });
    await recategorize.POST(new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id: shop.transaction_id, category: 'groceries' }) }));
    await recordDirectory(ctx, [
      { item_id: 'item_chase', institution_name: 'Chase', error: null, accounts: [{ account_id: 'acc_chk', type: 'depository', subtype: 'checking', name: 'Checking', mask: '1111' }] },
    ] as any);

    const [item] = await getItems(ctx);
    await disconnectItem(ctx, 'item_chase', item);
    expect((await importedTxnStore.get(ctx, 'acc_chk'))?.rows.length).toBe(6);
    expect(await historyImportStore.get(ctx, import_id)).not.toBeNull();
    expect(await txnAnnotationStore.get(ctx, shop.transaction_id)).toMatchObject({ excluded: true, tags: ['tag-work'], note: 'Milk for the office' });
    expect((await getOverrides(ctx))[shop.transaction_id]).toBe('groceries');
    // Shown nowhere while the account isn't live.
    expect((await activity()).transactions.some((t) => t.source === 'import:ofx')).toBe(false);

    await forgetEarlierAccount(ctx, 'acc_chk');
    expect(await importedTxnStore.get(ctx, 'acc_chk')).toBeNull();
    expect(await historyImportStore.get(ctx, import_id)).toBeNull();
    expect(await historyImportSummaryStore.get(ctx, import_id)).toBeNull();
    expect(await txnAnnotationStore.get(ctx, shop.transaction_id)).toBeNull();
    expect((await getOverrides(ctx))[shop.transaction_id]).toBeUndefined();
  });

  test('a sync after the import changes none of it: the rows stay where the bank has none', async () => {
    await importStatement();
    plaid.later.push(bankTxn('b_new', 'acc_chk', 0, 9, { name: 'NEW ROW' }));
    await transactions.GET(new Request('http://localhost/api/transactions'));
    expect((await activity()).transactions.filter((t) => t.source === 'import:ofx').map((t) => t.name).sort()).toEqual(IMPORTED_NOW);
  });
});
