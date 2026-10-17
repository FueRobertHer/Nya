import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Importing another app's export, as the app calls it: app/api/migration
// (review, import, list, undo), through each Nya account's own import
// (lib/import/commit.ts, lib/history-import/commit.ts) into the read layer
// every total reads (lib/activity.ts). Per app: its fixture detected, its
// categories mapped in the review, imported into new manual accounts with
// spending by category equal to the file's own (transfers and opening
// balances out of it), split transactions rebuilt, tags and notes kept;
// into a linked account matched against the bank's rows so none is
// doubled; and undone in one action, taking out what it made. Then the
// route's validation, its answers to what blocks an import, the same import
// sent twice, a failure part way undone, and containers.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

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
const { assembleBankRows, finishActivity } = await import('@/lib/activity');
const { countsInTotals } = await import('@/lib/spending');
const { getManualAccounts } = await import('@/lib/manual');
const { readTaxonomy, ensureTaxonomy } = await import('@/lib/category-store');
const { readTagSet } = await import('@/lib/tags');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { importedTxnStore } = await import('@/lib/history-import/store');
const { splitStore } = await import('@/lib/splits');
const { txnAnnotationStore } = await import('@/lib/txn-annotations');
const { migrationStore } = await import('@/lib/migration/store');
const { commitMigration } = await import('@/lib/migration/commit');
const { planMigration } = await import('@/lib/migration/plan');
const { readTargets } = await import('@/lib/migration/targets');
const { readAppFile } = await import('@/lib/import/apps/read');
const routes = await import('@/app/api/migration/route');
const historyRoutes = await import('@/app/api/history-import/route');

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const FIXTURES = join(import.meta.dir, 'fixtures', 'apps');
const fixture = (name: string) => readFileSync(join(FIXTURES, name));

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
  bankTxn('b_rent', 'acc_chk', 55, 1850, { name: 'ZELLE PAYMENT TO LANDLORD', merchant_name: 'Landlord', category: 'rent and utilities' }),
  bankTxn('b_pay', 'acc_chk', 45, -2500, { name: 'ACME PAYROLL', merchant_name: 'Acme Corp', category: 'income' }),
  bankTxn('b_recent', 'acc_chk', 3, 20, { name: 'GROCER' }),
];

async function seed(c = ctx) {
  await saveItem(c, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-chase') });
  await fake.hset(ctxKey('accounts:meta', c), {
    item_chase: await encrypt(JSON.stringify([{ account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }])),
  });
  const accounts = { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } };
  await fake.set(
    ctxKey('txns:item_chase', c),
    await encodeJsonBlob({ schema_version: 2, cursor: 'c1', accounts, txns: Object.fromEntries(BANK.map((t) => [t.transaction_id, t])), synced_at: new Date().toISOString() })
  );
}

type Res = { status: number; body: any };
const asRes = async (res: Response): Promise<Res> => ({ status: res.status, body: await res.json() });

function upload(meta: Record<string, unknown>, file: Uint8Array | string, name = 'export.csv'): Request {
  const form = new FormData();
  const bytes = typeof file === 'string' ? new TextEncoder().encode(file) : file;
  form.set('file', new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
  form.set('meta', JSON.stringify({ file_name: name, ...meta }));
  return new Request('http://localhost/api/migration', { method: 'POST', body: form });
}
const post = async (meta: Record<string, unknown>, file: Uint8Array | string, name?: string) => asRes(await routes.POST(upload(meta, file, name)));
const preview = (file: Uint8Array | string, extra: Record<string, unknown> = {}) => post({ action: 'preview', ...extra }, file);
/** Reviews the file with these answers, then imports it with that review. */
async function importReviewed(file: Uint8Array | string, extra: Record<string, unknown> = {}, migration_id = `app-import:${crypto.randomUUID()}`) {
  const p = await preview(file, extra);
  expect(p.status).toBe(200);
  const done = await post({ action: 'import', review: p.body.preview.review, migration_id, ...extra }, file);
  return { preview: p.body.preview, done, migration_id };
}
const list = async () => asRes(await routes.GET(new Request('http://localhost/api/migration')));
const undo = async (body: object) =>
  asRes(await routes.DELETE(new Request('http://localhost/api/migration', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })));

/** Every transaction the read layer has, of any date, as the Activity tab and
 *  every total read them. */
async function activity(c = ctx) {
  const since = '2000-01-01';
  const bank = await assembleBankRows(c, { sync: false, readOnly: true, withAccountIds: true, since });
  return finishActivity(c, bank.payload, bank.hidden, { since });
}

/** Spending by category, as the totals count it (lib/totals.ts
 *  spendingByCategory: money out that counts, by the category it is filed
 *  under), rounded to the cent. */
function spending(rows: { amount: number; category_name?: string | null; category_id?: string }[], currency = 'USD', only?: (t: any) => boolean) {
  const out: Record<string, number> = {};
  for (const t of rows as any[]) {
    if (only && !only(t)) continue;
    if (t.amount <= 0 || !countsInTotals(t, currency)) continue;
    const name = t.category_name ?? 'other';
    out[name] = Math.round(((out[name] ?? 0) + t.amount) * 100) / 100;
  }
  return out;
}

/** A new manual account for each of the file's accounts, typed by its name. */
function newAccounts(names: string[]) {
  return Object.fromEntries(
    names.map((n) => [n, { to: 'new', name: n, institution: 'Imported', type: /visa|sapphire|card/i.test(n) ? 'credit' : /brokerage/i.test(n) ? 'investment' : 'depository', balance: 0 }])
  );
}

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
  await registerTestContainer(fake);
});

// ---- Each app ----

type Case = {
  app: string;
  file: string;
  options?: Record<string, unknown>;
  accounts: string[];
  /** Money out by category, as the file has it: what Nya's totals must say. */
  spending: Record<string, number>;
  /** The categories the review maps to the person's own, and makes new. */
  existing: Record<string, string>;
  made: string[];
  /** A row with a tag and the tag's name; a row with a note. */
  tagged: [string, string];
  noted: [string, string];
  /** The payee of a split transaction rebuilt (null for an app whose export
   *  doesn't say). */
  split: string | null;
  /** Each app's own format, for a file of a linked account's rows. */
  linked: (rows: { days: number; payee: string; amount: number; category: string; group: string }[]) => string;
  linkedOptions?: Record<string, unknown>;
};

const mdy = (day: string) => `${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;

const CASES: Case[] = [
  {
    app: 'monarch',
    file: 'monarch-transactions.csv',
    accounts: ['Chase Checking (...1111)', 'Chase Sapphire (...4444)', 'Ally Savings (...2222)'],
    spending: { Groceries: 166.42, 'Coffee Shops': 4.5, Household: 40, 'Restaurants & Bars': 62.1, Rent: 1850, 'Travel & Vacation': 412.3, 'Entertainment & Recreation': 10.99, other: 12 },
    existing: {},
    made: ['Groceries', 'Paychecks', 'Transfer', 'Credit Card Payment', 'Interest'],
    tagged: ['Blue Bottle Coffee', 'Reimbursable'],
    noted: ['Rent', 'August rent'],
    split: null,
    linked: (rows) =>
      ['Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags', ...rows.map((r) => `${daysAgo(r.days)},${r.payee},${r.category},Checking,${r.payee.toUpperCase()},,${(-r.amount).toFixed(2)},`)].join('\n'),
  },
  {
    app: 'ynab',
    file: 'ynab-register.csv',
    accounts: ['Checking', 'Savings', 'Visa', 'Brokerage'],
    spending: { Groceries: 166.42, Household: 40, Birthdays: 25, Rent: 1850, 'Dining Out': 62.1, other: 12 },
    existing: { 'inflow\u001fready to assign': 'income' },
    made: ['Groceries', 'Household', 'Birthdays', 'Rent', 'Dining Out', 'Starting balances'],
    tagged: ['Landlord', 'Blue flag'],
    noted: ['Landlord', 'September'],
    split: 'Costco',
    linked: (rows) =>
      [
        '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"',
        ...rows.map(
          (r) =>
            `"Checking","","${mdy(daysAgo(r.days))}","${r.payee}","${r.group}: ${r.category}","${r.group}","${r.category}","",$${Math.max(r.amount, 0).toFixed(2)},$${Math.max(-r.amount, 0).toFixed(2)},"Cleared"`
        ),
      ].join('\n'),
    linkedOptions: { options: { date_order: 'mdy' } },
  },
  {
    app: 'lunchmoney',
    file: 'lunchmoney-transactions.csv',
    accounts: ['Chase Checking', 'Chase Sapphire', 'Ally Savings'],
    spending: { Groceries: 166.42, Household: 40, Restaurants: 45, Subscriptions: 10.99, other: 9.99 },
    existing: {},
    made: ['Groceries', 'Paycheck', 'Payment, Transfer'],
    tagged: ['Whole Foods', 'Weekly'],
    noted: ['REI', 'returned the tent'],
    split: 'Costco Wholesale',
    linked: (rows) =>
      [
        'date,payee,amount,currency,category,category_group,notes,tags,account,original_name,type,parent_id,id,recurring_id,created_at',
        ...rows.map((r, i) => `${daysAgo(r.days)},${r.payee},${r.amount.toFixed(2)},usd,${r.category},${r.group},,,Checking,,,,${7000 + i},,`),
      ].join('\n'),
  },
  {
    app: 'actual',
    file: 'actual-export.csv',
    accounts: ['Checking', 'Savings'],
    spending: { Food: 166.42, General: 49.99, Rent: 1850, other: 12 },
    existing: { 'income\u001fincome': 'income' },
    made: ['Food', 'General', 'Rent', 'Starting balances'],
    tagged: ['', ''],
    noted: ['Landlord', 'September'],
    split: 'Costco',
    linked: (rows) =>
      [
        'Account,Date,Payee,Notes,Category_Group,Category,Amount,Split_Amount,Cleared',
        ...rows.map((r) => `Checking,${daysAgo(r.days)},${r.payee},,${r.group},${r.category},${(-r.amount).toFixed(2)},0,Cleared`),
      ].join('\n'),
  },
  {
    app: 'zerosum',
    file: 'zerosum-transactions.csv',
    accounts: ['Checking', 'Savings', 'Visa'],
    spending: { Groceries: 166.42, Household: 40, Rent: 1850, other: 12 },
    existing: { 'income\u001fready to budget': 'income' },
    made: ['Groceries', 'Household', 'Rent', 'Starting balances'],
    tagged: ['Landlord', 'Home'],
    noted: ['Landlord', 'September'],
    split: null,
    linked: (rows) =>
      [
        'Date,Account,Payee,Category Group,Category,Memo,Tags,Outflow,Inflow,Cleared',
        ...rows.map((r) => `${mdy(daysAgo(r.days))},Checking,${r.payee},${r.group},${r.category},,,${r.amount > 0 ? r.amount.toFixed(2) : ''},${r.amount < 0 ? (-r.amount).toFixed(2) : ''},Cleared`),
      ].join('\n'),
    linkedOptions: { options: { date_order: 'mdy' } },
  },
];

for (const c of CASES) {
  describe(c.app, () => {
    test('detected, its accounts asked about, its categories mapped in the review', async () => {
      const p = await preview(fixture(c.file));
      expect(p.status).toBe(200);
      const review = p.body.preview;
      expect(review.app).toBe(c.app);
      expect(review.detected).toBe(true);
      expect(review.accounts.map((a: any) => a.key).sort()).toEqual([...c.accounts].sort());
      // Nothing goes anywhere until the person says where.
      expect(review.waiting.accounts).toBe(c.accounts.length);
      expect(review.targets).toEqual([]);
      const answered = await preview(fixture(c.file), { accounts: newAccounts(c.accounts) });
      const mappings = answered.body.preview.categories.mappings as any[];
      for (const [key, text] of Object.entries(c.existing)) {
        const m = mappings.find((x) => x.key === key);
        expect(m?.target.to).toBe('existing');
        expect(m?.target.text).toBe(text);
      }
      const made = mappings.filter((m) => m.target.to === 'new').map((m) => m.target.name);
      for (const name of c.made) expect(made).toContain(name);
      // A category the app counts as income or a transfer is made of that kind.
      for (const m of mappings) if (m.kind && m.target.to === 'new') expect(m.target.kind).toBe(m.kind);
      expect(answered.body.preview.waiting.accounts).toBe(0);
      expect(answered.body.preview.blocks).toEqual([]);
    });

    test('into new manual accounts: its own spending by category, transfers out, splits, tags and notes', async () => {
      const { done } = await importReviewed(fixture(c.file), { accounts: newAccounts(c.accounts) });
      expect(done.status).toBe(200);
      expect(done.body.made.accounts.length).toBe(c.accounts.length);
      const accounts = await getManualAccounts(ctx);
      expect(accounts.map((a) => a.name).sort()).toEqual([...c.accounts].sort());
      const read = await activity();
      const imported = read.transactions.filter((t: any) => t.source === 'import:csv');
      expect(imported.length).toBeGreaterThan(0);
      // Spending by category is the file's own: transfers between the
      // person's accounts and opening balances count in nothing.
      expect(spending(read.transactions)).toEqual(c.spending);
      const transfers = imported.filter((t: any) => t.category_kind === 'transfer');
      expect(transfers.length).toBeGreaterThan(0);
      // The app's tags on its rows; its notes on them.
      if (c.tagged[0]) {
        const set = await readTagSet(ctx);
        const row = read.transactions.find((t: any) => t.name === c.tagged[0] && t.tags?.length) as any;
        expect(row.tags.map((id: string) => set!.tags.find((x) => x.id === id)?.name)).toContain(c.tagged[1]);
      }
      const noted = read.transactions.find((t: any) => t.name === c.noted[0]) as any;
      expect(noted.note).toBe(c.noted[1]);
      // A split transaction is one transaction, its parts adding up exactly.
      if (c.split) {
        const parts = read.transactions.filter((t: any) => t.split_of && t.name === c.split) as any[];
        expect(parts.length).toBeGreaterThanOrEqual(2);
        const splits = await splitStore.getAll(ctx);
        expect(splits.size).toBe(1);
        const [record] = [...splits.values()];
        const total = record.parts.reduce((n, p) => n + Math.round(p.amount * 100), 0);
        expect(total).toBe(Math.round(record.amount * 100));
      }
    });

    test('undone in one action: its rows, and the accounts, categories and tags it made', async () => {
      // The person's categories as the app's first load makes them.
      const before = await ensureTaxonomy(ctx);
      const { done, migration_id } = await importReviewed(fixture(c.file), { accounts: newAccounts(c.accounts) });
      expect(done.status).toBe(200);
      const listed = await list();
      expect(listed.body.imports.map((i: any) => i.id)).toEqual([migration_id]);
      const plan = await asRes(await routes.GET(new Request(`http://localhost/api/migration?undo=${migration_id}`)));
      expect(plan.body.undo.made.accounts.length).toBe(c.accounts.length);
      const undone = await undo({ migration_id, confirm: true });
      expect(undone.status).toBe(200);
      expect(undone.body.accounts.removed.sort()).toEqual([...c.accounts].sort());
      expect(await getManualAccounts(ctx)).toEqual([]);
      expect((await manualTxnStore.getAll(ctx)).size).toBe(0);
      expect((await splitStore.getAll(ctx)).size).toBe(0);
      expect((await txnAnnotationStore.getAll(ctx)).size).toBe(0);
      expect((await migrationStore.getAll(ctx)).size).toBe(0);
      expect((await readTagSet(ctx))?.tags ?? []).toEqual([]);
      const after = await readTaxonomy(ctx);
      expect(after!.categories.map((x) => x.name).sort()).toEqual(before!.categories.map((x) => x.name).sort());
      expect(after!.groups.map((x) => x.name).sort()).toEqual(before!.groups.map((x) => x.name).sort());
      expect((await activity()).transactions.filter((t: any) => t.source)).toEqual([]);
    });

    test('into a linked account: matched against the bank’s rows, never doubled, and undone exactly', async () => {
      await seed();
      const file = c.linked([
        { days: 400, payee: 'Old Store', amount: 100, category: 'Shopping', group: 'Fun' },
        { days: 55, payee: 'Landlord', amount: 1850, category: 'Rent', group: 'Bills' },
        { days: 45, payee: 'Acme Corp', amount: -2500, category: 'Salary', group: 'Income' },
        { days: 30, payee: 'Corner Shop', amount: 60, category: 'Shopping', group: 'Fun' },
      ]);
      const before = (await activity()).transactions.map((t: any) => t.transaction_id).sort();
      const answers = { accounts: { Checking: { to: 'linked', id: 'acc_chk' } }, ...(c.linkedOptions ?? {}) };
      const { preview: review, done } = await importReviewed(file, answers);
      expect(review.targets.length).toBe(1);
      const target = review.targets[0];
      expect(target.kind).toBe('linked');
      expect(target.counts.duplicates).toBe(2);
      expect(target.counts.new).toBe(2);
      expect(target.before_bank).toBe(1);
      expect(done.status).toBe(200);
      const read = (await activity()).transactions as any[];
      // The bank's rent and pay once each, as the bank's; the file's two
      // other rows beside them.
      expect(read.filter((t) => t.amount === 1850).length).toBe(1);
      expect(read.filter((t) => t.amount === -2500).length).toBe(1);
      expect(read.find((t) => t.amount === 1850).transaction_id).toBe('b_rent');
      expect(read.filter((t) => t.source === 'import:csv').map((t) => t.name).sort()).toEqual(['Corner Shop', 'Old Store']);
      // The bank's rent shows the app's category, as the person filed it there.
      expect(read.find((t) => t.transaction_id === 'b_rent').category_name).toBe('Rent');
      expect((await importedTxnStore.get(ctx, 'acc_chk'))!.rows.length).toBe(4);
      const undone = await undo({ migration_id: (await list()).body.imports[0].id, confirm: true });
      expect(undone.status).toBe(200);
      expect(await importedTxnStore.get(ctx, 'acc_chk')).toBeNull();
      expect((await activity()).transactions.map((t: any) => t.transaction_id).sort()).toEqual(before);
      expect((await activity()).transactions.find((t: any) => t.transaction_id === 'b_rent')!.category_name).toBe('rent and utilities');
    });
  });
}

// ---- What the review offers, and what it refuses ----

describe('the review', () => {
  test('into an account the person has: the same file again adds nothing, and makes no category twice', async () => {
    const accounts = newAccounts(['Checking', 'Savings', 'Visa', 'Brokerage']);
    const first = await importReviewed(fixture('ynab-register.csv'), { accounts });
    expect(first.done.status).toBe(200);
    const made = (await getManualAccounts(ctx)).find((a) => a.name === 'Checking')!;
    const categories = (await readTaxonomy(ctx))!.categories.length;
    const again = await importReviewed(fixture('ynab-register.csv'), { accounts: { Checking: { to: 'manual', id: made.account_id }, Savings: { to: 'skip' }, Visa: { to: 'skip' }, Brokerage: { to: 'skip' } } });
    expect(again.preview.targets[0].counts.new).toBe(0);
    expect(again.preview.targets[0].counts.present).toBeGreaterThan(0);
    expect(again.preview.categories.added).toBe(0);
    expect(again.done.status).toBe(200);
    expect((await readTaxonomy(ctx))!.categories.length).toBe(categories);
    expect((await manualTxnStore.get(ctx, made.account_id))!.rows.length).toBe(first.preview.targets.find((t: any) => t.name === 'Checking').counts.new);
  });

  test('a category sent to one the person has, or made of another kind, and one whose kind differs is said', async () => {
    const accounts = newAccounts(['Checking', 'Savings', 'Visa', 'Brokerage']);
    const p = await preview(fixture('ynab-register.csv'), { accounts });
    const t = (await readTaxonomy(ctx))!;
    const food = t.categories.find((c) => c.name === 'food and drink')!;
    const groceries = p.body.preview.categories.mappings.find((m: any) => m.name === 'Groceries');
    const dining = p.body.preview.categories.mappings.find((m: any) => m.name === 'Dining Out');
    const chosen = await preview(fixture('ynab-register.csv'), { accounts, categories: { [groceries.key]: { to: 'existing', id: food.id }, [dining.key]: { to: 'new', kind: 'income' } } });
    const after = chosen.body.preview.categories.mappings;
    expect(after.find((m: any) => m.key === groceries.key).target).toMatchObject({ to: 'existing', id: food.id, name: 'food and drink' });
    expect(after.find((m: any) => m.key === dining.key).target).toMatchObject({ to: 'new', kind: 'income' });
    // The app's Inflow is income; sent to spending, the review says so.
    const inflow = after.find((m: any) => m.name === 'Ready to Assign');
    const spendingOnly = await preview(fixture('ynab-register.csv'), { accounts, categories: { [inflow.key]: { to: 'existing', id: food.id } } });
    expect(spendingOnly.body.preview.categories.mappings.find((m: any) => m.key === inflow.key).differs).toContain('counts it as income');
  });

  test('the transfers, opening balances and rows with no category are counted for the review', async () => {
    const p = await preview(fixture('ynab-register.csv'), { accounts: newAccounts(['Checking', 'Savings', 'Visa', 'Brokerage']) });
    expect(p.body.preview.counts).toEqual({ uncategorized: 1, transfers: 6, opening: 4 });
    expect(p.body.preview.splits.rebuilt).toBe(1);
    expect(p.body.preview.notes.join(' ')).toContain('1 transfer has a category in YNAB');
  });

  test('a header Nya doesn’t know asks which app and which column is which', async () => {
    const file = ['When,Bank,Who,Note,Out,In,Group,Kind', '2026-09-01,Checking,Shop,,10.00,,Fun,Games'].join('\n');
    const asked = await preview(file);
    expect(asked.body.needs).toBe('mapping');
    expect(asked.body.table.header).toEqual(['When', 'Bank', 'Who', 'Note', 'Out', 'In', 'Group', 'Kind']);
    const mapped = await preview(file, { options: { app: 'zerosum', columns: { date: 0, account: 1, payee: 2, notes: 3, outflow: 4, inflow: 5, group: 6, category: 7 } } });
    expect(mapped.status).toBe(200);
    expect(mapped.body.preview.detected).toBe(false);
    expect(mapped.body.preview.accounts[0].key).toBe('Checking');
  });

  test('dates the file doesn’t settle are asked about', async () => {
    const asked = await preview(fixture('ynab-register-eu.csv'));
    expect(asked.body.needs).toBe('date_order');
    const answered = await preview(fixture('ynab-register-eu.csv'), { options: { date_order: 'dmy' } });
    expect(answered.body.preview.read.date_order).toBe('dmy');
  });

  test('a zip from YNAB is read; Actual’s database export says how to export its CSV', async () => {
    const { deflateRawSync } = await import('node:zlib');
    const zipOf = (files: Record<string, Uint8Array>) => {
      const parts: Buffer[] = [];
      const central: Buffer[] = [];
      let at = 0;
      for (const [name, data] of Object.entries(files)) {
        const packed = deflateRawSync(data);
        const n = Buffer.from(name);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(n.length, 26);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(8, 10);
        cd.writeUInt32LE(packed.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(n.length, 28);
        cd.writeUInt32LE(at, 42);
        parts.push(local, n, packed);
        central.push(cd, n);
        at += 30 + n.length + packed.length;
      }
      const dir = Buffer.concat(central);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(Object.keys(files).length, 8);
      end.writeUInt16LE(Object.keys(files).length, 10);
      end.writeUInt32LE(dir.length, 12);
      end.writeUInt32LE(at, 16);
      return new Uint8Array(Buffer.concat([...parts, dir, end]));
    };
    const ynab = await preview(zipOf({ 'Budget - Plan.csv': fixture('ynab-plan.csv'), 'Budget - Register.csv': fixture('ynab-register.csv') }), {});
    expect(ynab.status).toBe(200);
    expect(ynab.body.preview.entry).toBe('Budget - Register.csv');
    const actual = await preview(zipOf({ 'db.sqlite': new TextEncoder().encode('SQLite format 3\u0000'), 'metadata.json': new TextEncoder().encode('{}') }));
    expect(actual.status).toBe(422);
    expect(actual.body.error).toContain('Export its transactions as CSV instead');
  });

  test('the import waits for every account’s answer, and for the review the person saw', async () => {
    const file = fixture('ynab-register.csv');
    const p = await preview(file);
    const waiting = await post({ action: 'import', review: p.body.preview.review, migration_id: `app-import:${crypto.randomUUID()}` }, file);
    expect(waiting.status).toBe(409);
    expect(waiting.body.needs).toBe('answers');
    const accounts = newAccounts(['Checking', 'Savings', 'Visa', 'Brokerage']);
    const reviewed = await preview(file, { accounts });
    // The answers changed since the review the person saw.
    const changed = await post({ action: 'import', review: reviewed.body.preview.review, migration_id: `app-import:${crypto.randomUUID()}`, accounts, tags: false }, file);
    expect(changed.status).toBe(409);
    expect(changed.body.needs).toBe('review');
    expect(await getManualAccounts(ctx)).toEqual([]);
  });

  test('what blocks an import is said in the review and refused on import: categories, tags, accounts, a bad balance', async () => {
    const accounts = newAccounts(['Checking', 'Savings', 'Visa', 'Brokerage']);
    // A card's balance can't be negative.
    const bad = await preview(fixture('ynab-register.csv'), { accounts: { ...accounts, Visa: { ...accounts.Visa, balance: -5 } } });
    expect(bad.body.preview.blocks.join(' ')).toContain('can’t be negative');
    const refused = await post({ action: 'import', review: bad.body.preview.review, migration_id: `app-import:${crypto.randomUUID()}`, accounts: { ...accounts, Visa: { ...accounts.Visa, balance: -5 } } }, fixture('ynab-register.csv'));
    expect(refused.status).toBe(409);
    expect(await getManualAccounts(ctx)).toEqual([]);
    // Too many tags for the room left: imported without them instead.
    const { changeTagSet, addTag } = await import('@/lib/tags');
    await changeTagSet(ctx, (s) => {
      let next = s;
      for (let i = 0; i < 250; i++) next = addTag(next, { name: `tag ${i}` }, () => crypto.randomUUID()).set;
      return next;
    });
    const full = await preview(fixture('monarch-transactions.csv'), { accounts: newAccounts(['Chase Checking (...1111)', 'Chase Sapphire (...4444)', 'Ally Savings (...2222)']) });
    expect(full.body.preview.blocks.join(' ')).toContain('room for 0 more');
    const without = await preview(fixture('monarch-transactions.csv'), { accounts: newAccounts(['Chase Checking (...1111)', 'Chase Sapphire (...4444)', 'Ally Savings (...2222)']), tags: false });
    expect(without.body.preview.blocks).toEqual([]);
    expect(without.body.preview.tags.on).toBe(false);
  });
});

describe('the import', () => {
  test('sent twice with one id is made once', async () => {
    const file = fixture('ynab-register.csv');
    const accounts = newAccounts(['Checking', 'Savings', 'Visa', 'Brokerage']);
    const p = await preview(file, { accounts });
    const migration_id = `app-import:${crypto.randomUUID()}`;
    const first = await post({ action: 'import', review: p.body.preview.review, migration_id, accounts }, file);
    expect(first.status).toBe(200);
    // The same request again, as a phone sends it when the answer was lost:
    // the import already made is said so, and nothing is made twice.
    const second = await post({ action: 'import', review: p.body.preview.review, migration_id, accounts }, file);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ migration_id, already: true, status: 'done' });
    expect(second.body.counts).toEqual(first.body.counts);
    expect((await getManualAccounts(ctx)).length).toBe(4);
    // Another id with the old review is refused: what it reviewed changed.
    const stale = await post({ action: 'import', review: p.body.preview.review, migration_id: `app-import:${crypto.randomUUID()}`, accounts }, file);
    expect(stale.status).toBe(409);
    expect(stale.body.needs).toBe('review');
    expect((await getManualAccounts(ctx)).length).toBe(4);
    expect((await migrationStore.getAll(ctx)).size).toBe(1);
  });

  test('one that fails part way is undone, so nothing it made is left', async () => {
    await seed();
    // A manual account first, then the linked one, whose review changes
    // between the plan and its commit (another import into it lands).
    const lines = [
      '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"',
      `"Cash","","${mdy(daysAgo(20))}","Market","Fun: Treats","Fun","Treats","",$5.00,$0.00,"Cleared"`,
      `"Checking","","${mdy(daysAgo(25))}","Corner Shop","Fun: Treats","Fun","Treats","",$60.00,$0.00,"Cleared"`,
    ].join('\n');
    const read = readAppFile(lines, { options: { date_order: 'mdy' }, thisYear: new Date().getUTCFullYear() });
    if (read.status !== 'ready') throw new Error(read.status);
    const answers = { accounts: { Cash: { to: 'new' as const, name: 'Cash', institution: 'Wallet', type: 'depository' as const, balance: 20 }, Checking: { to: 'linked' as const, id: 'acc_chk' } }, categories: {}, tags: true, currency: null, choices: {} };
    const state = await readTargets(ctx, { manualIds: [], linkedIds: ['acc_chk'], withTags: true, today: daysAgo(0) });
    const plan = planMigration(read, answers, state);
    expect(plan.blocks).toEqual([]);
    // Another import into the linked account, after the plan was made.
    const other = ['Date,Description,Amount', `${daysAgo(26)},CORNER SHOP,-60.00`].join('\n');
    const form = (meta: object) => {
      const f = new FormData();
      f.set('file', new Blob([new TextEncoder().encode(other) as Uint8Array<ArrayBuffer>]), 'other.csv');
      f.set('meta', JSON.stringify(meta));
      return new Request('http://localhost/api/history-import', { method: 'POST', body: f });
    };
    const csv = { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } };
    const op = await asRes(await historyRoutes.POST(form({ action: 'preview', account_id: 'acc_chk', options: csv })));
    expect((await asRes(await historyRoutes.POST(form({ action: 'import', account_id: 'acc_chk', options: csv, review: op.body.preview.review })))).status).toBe(200);
    const taxonomy = (await readTaxonomy(ctx))!.categories.length;
    const id = `app-import:${crypto.randomUUID()}`;
    await expect(quietly(() => commitMigration(ctx, { id, plan, answers, state, file: { name: 'x.csv', entry: null, bytes: 10, encoding: 'utf-8' } }))).rejects.toThrow('changed since you reviewed');
    // The manual account it made, its rows, its categories: all gone again.
    expect(await getManualAccounts(ctx)).toEqual([]);
    expect((await manualTxnStore.getAll(ctx)).size).toBe(0);
    expect((await readTaxonomy(ctx))!.categories.length).toBe(taxonomy);
    expect(await migrationStore.get(ctx, id)).toBeNull();
    expect((await importedTxnStore.get(ctx, 'acc_chk'))!.rows.length).toBe(1);
  });
});

// ---- Validation and containers ----

describe('validation', () => {
  test('every field is checked before anything is read', async () => {
    const file = fixture('ynab-register.csv');
    expect((await post({ action: 'nope' }, file)).status).toBe(400);
    expect((await post({ action: 'preview', extra: 1 }, file)).status).toBe(400);
    expect((await post({ action: 'preview', options: { app: 'mint' } }, file)).status).toBe(400);
    expect((await post({ action: 'preview', options: { columns: { date: 0 } } }, file)).status).toBe(400);
    expect((await post({ action: 'preview', options: { app: 'ynab', columns: { when: 0 } } }, file)).status).toBe(400);
    expect((await post({ action: 'preview', accounts: { Checking: { to: 'new', name: 'X', institution: 'Y', type: 'boat', balance: 0 } } }, file)).status).toBe(400);
    expect((await post({ action: 'preview', accounts: { Checking: { to: 'new', name: 'X', institution: 'Y', type: 'depository', balance: 1e13 } } }, file)).status).toBe(400);
    expect((await post({ action: 'preview', accounts: { Checking: { to: 'manual', id: 'acc_chk' } } }, file)).status).toBe(400);
    expect((await post({ action: 'preview', categories: { k: { to: 'new', kind: 'savings' } } }, file)).status).toBe(400);
    expect((await post({ action: 'preview', currency: 'XXQ' }, file)).status).toBe(400);
    expect((await post({ action: 'preview', choices: { 'manual:x': {} } }, file)).status).toBe(400);
    expect((await post({ action: 'import', review: 'a'.repeat(32) }, file)).status).toBe(400);
    expect((await post({ action: 'import', migration_id: 'app-import:nope', review: 'a'.repeat(32) }, file)).status).toBe(400);
    expect((await post({ action: 'preview' }, new Uint8Array())).status).toBe(400);
    expect((await undo({ migration_id: `app-import:${crypto.randomUUID()}` })).status).toBe(400);
    expect((await undo({ migration_id: `app-import:${crypto.randomUUID()}`, confirm: true })).status).toBe(404);
  });

  test('what the seam can’t read is answered as the seam rules say', async () => {
    const { done, migration_id } = await importReviewed(fixture('actual-export.csv'), { accounts: newAccounts(['Checking', 'Savings']) });
    expect(done.status).toBe(200);
    await fake.hset(ctxKey('app-imports'), { [migration_id]: 'not ciphertext' });
    const listed = await quietly(() => list());
    expect(listed.status).toBe(200);
    expect(listed.body.imports[0].record).toBe('unreadable');
    const refused = await quietly(() => undo({ migration_id, confirm: true }));
    expect(refused.status).toBe(409);
    expect(refused.body.unreadable).toBe(true);
  });
});

describe('containers', () => {
  test('an import is the container’s own: another person’s stores hold none of it, and can’t undo it', async () => {
    const { done, migration_id } = await importReviewed(fixture('monarch-transactions.csv'), { accounts: newAccounts(['Chase Checking (...1111)', 'Chase Sapphire (...4444)', 'Ally Savings (...2222)']) });
    expect(done.status).toBe(200);
    expect((await migrationStore.getAll(OTHER)).size).toBe(0);
    expect((await manualTxnStore.getAll(OTHER)).size).toBe(0);
    expect(await getManualAccounts(OTHER)).toEqual([]);
    expect((await activity(OTHER)).transactions).toEqual([]);
    // An import in another container isn't this one's to see or undo.
    await migrationStore.set(OTHER, 'app-import:00000000-0000-4000-8000-000000000000', (await migrationStore.get(ctx, migration_id))!);
    expect((await list()).body.imports.map((i: any) => i.id)).toEqual([migration_id]);
    expect((await undo({ migration_id: 'app-import:00000000-0000-4000-8000-000000000000', confirm: true })).status).toBe(404);
  });
});
