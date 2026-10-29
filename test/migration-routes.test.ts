import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
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

/** What the next sync brings: rows added, modified and removed. */
const plaid = { added: [] as unknown[], modified: [] as unknown[], removed: [] as string[] };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({
      data: {
        added: plaid.added.splice(0),
        modified: plaid.modified.splice(0),
        removed: plaid.removed.splice(0).map((transaction_id) => ({ transaction_id })),
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
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { assembleBankRows, finishActivity } = await import('@/lib/activity');
const { spendingByCategory } = await import('@/lib/totals');
const { getManualAccounts, saveManualAccount } = await import('@/lib/manual');
const { readTaxonomy, ensureTaxonomy } = await import('@/lib/category-store');
const { readTagSet } = await import('@/lib/tags-store');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { importedTxnStore, importedTwinsStore } = await import('@/lib/history-import/store');
const { splitStore } = await import('@/lib/splits');
const { txnAnnotationStore } = await import('@/lib/txn-annotations');
const { migrationStore } = await import('@/lib/migration/store');
const { importedFlowsForBackfill } = await import('@/lib/history-import/extend');
const { getItems, removeItem } = await import('@/lib/storage');
const { linkAccounts } = await import('@/lib/links');
const { loadBudgets, saveBudgets } = await import('@/lib/budget-store');
const { budgetMonthsStore } = await import('@/lib/budget-months-store');
const { setOverride, getOverrides } = await import('@/lib/overrides');
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

async function seed(c = ctx, rows: ReturnType<typeof bankTxn>[] = BANK) {
  await saveItem(c, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt(c, 'access-sandbox-chase') });
  await fake.hset(ctxKey('accounts:meta', c), {
    item_chase: await encrypt(c, JSON.stringify([{ account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }])),
  });
  const accounts = { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } };
  await fake.set(
    ctxKey('txns:item_chase', c),
    await encodeJsonBlob(c, { schema_version: 2, cursor: 'c1', accounts, txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])), synced_at: new Date().toISOString() })
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
 *  spendingByCategory itself: money out that counts, by the category it is
 *  filed under), by the category's name, rounded to the cent. */
function spending(rows: { amount: number; category_name?: string | null; category_id?: string }[], currency = 'USD', only?: (t: any) => boolean) {
  const counted = (rows as any[]).filter((t) => !only || only(t));
  const by = spendingByCategory(counted, () => true, currency, (t) => t.category_name ?? 'other');
  return Object.fromEntries(Object.entries(by).map(([name, n]) => [name, Math.round(n * 100) / 100]));
}

/** The real balance history, as stored: what an import, its undo and the
 *  estimated history drawn after them must leave byte for byte as it is. */
function realLayer(c = ctx): string {
  const keys = ['history:net-worth', 'history:accounts', 'history:accounts:partial', 'snapshot:taken'].map((k) => ctxKey(k, c));
  return JSON.stringify(keys.map((k) => [k, [...((fake as any).hashes.get(k) ?? new Map()).entries()].sort()]));
}

/** Two recorded days of balance history. */
async function recordHistory(c = ctx) {
  const map = (m: Record<string, number>) => encrypt(c, JSON.stringify(m));
  await fake.hset(ctxKey('history:net-worth', c), { [daysAgo(2)]: await encrypt(c, '1000'), [daysAgo(1)]: await encrypt(c, '1000') });
  await fake.hset(ctxKey('history:accounts', c), { [daysAgo(2)]: await map({ acc_chk: 1000 }), [daysAgo(1)]: await map({ acc_chk: 1000 }) });
  await fake.hset(ctxKey('snapshot:taken', c), { [daysAgo(1)]: `${daysAgo(1)}T13:00:00.000Z` });
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
  plaid.added = [];
  plaid.modified = [];
  plaid.removed = [];
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
      await recordHistory();
      const real = realLayer();
      const { done } = await importReviewed(fixture(c.file), { accounts: newAccounts(c.accounts) });
      expect(done.status).toBe(200);
      expect(realLayer()).toBe(real);
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
      expect(plan.body.undo.entry.made.accounts.length).toBe(c.accounts.length);
      // What it takes out, as each account's own Undo would say it.
      expect(plan.body.undo.remove).toBe((await manualTxnStore.getAll(ctx)).size > 0 ? [...(await manualTxnStore.getAll(ctx)).values()].reduce((n, b) => n + b.rows.length, 0) : 0);
      expect(plan.body.undo.edited).toBe(0);
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
      await recordHistory();
      const real = realLayer();
      expect(real).toContain(`${daysAgo(1)}T13:00:00.000Z`);
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
      // Nothing is written to the balance history.
      expect(realLayer()).toBe(real);
      const undone = await undo({ migration_id: (await list()).body.imports[0].id, confirm: true });
      expect(undone.status).toBe(200);
      expect(realLayer()).toBe(real);
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
    // Each account's own, so an account YNAB tracks off budget (none of its
    // rows categorized) is seen for what it is.
    expect(Object.fromEntries(p.body.preview.accounts.map((a: any) => [a.key, a.uncategorized]))).toEqual({ Checking: 1, Savings: 0, Visa: 0, Brokerage: 0 });
    expect(p.body.preview.splits.rebuilt).toBe(1);
    expect(p.body.preview.notes.join(' ')).toContain('1 transfer has a category in YNAB');
  });

  test('the currency of a file that doesn’t say one is the person’s to choose', async () => {
    const accounts = newAccounts(['Checking', 'Savings', 'Visa', 'Brokerage']);
    const p = await preview(fixture('ynab-register.csv'), { accounts });
    expect(p.body.preview.currency).toEqual({ chosen: null, in_file: false });
    expect(p.body.preview.targets.map((t: any) => t.currency)).toEqual(['USD', 'USD', 'USD', 'USD']);
    const { preview: chosen, done } = await importReviewed(fixture('ynab-register.csv'), { accounts, currency: 'eur' });
    expect(chosen.currency.chosen).toBe('EUR');
    expect(chosen.targets.map((t: any) => t.currency)).toEqual(['EUR', 'EUR', 'EUR', 'EUR']);
    expect(done.status).toBe(200);
    expect((await getManualAccounts(ctx)).map((a) => a.currency)).toEqual(['EUR', 'EUR', 'EUR', 'EUR']);
    for (const book of (await manualTxnStore.getAll(ctx)).values()) expect(book.rows.every((r) => r.currency === 'EUR')).toBe(true);
    // Lunch Money's rows say theirs.
    const lm = await preview(fixture('lunchmoney-transactions.csv'));
    expect(lm.body.preview.currency).toEqual({ chosen: null, in_file: true });
  });

  test('tags that can’t be read are said, and the file can come in without them', async () => {
    await fake.set(ctxKey('tags'), 'not-ciphertext-but-long-enough-to-be-tried');
    const accounts = newAccounts(['Chase Checking (...1111)', 'Chase Sapphire (...4444)', 'Ally Savings (...2222)']);
    const p = await quietly(() => preview(fixture('monarch-transactions.csv'), { accounts }));
    expect(p.status).toBe(200);
    expect(p.body.preview.blocks.join(' ')).toContain('tags can’t be read');
    const refused = await quietly(() => post({ action: 'import', review: p.body.preview.review, migration_id: `app-import:${crypto.randomUUID()}`, accounts }, fixture('monarch-transactions.csv')));
    expect(refused.status).toBe(409);
    expect(await getManualAccounts(ctx)).toEqual([]);
    const without = await quietly(() => importReviewed(fixture('monarch-transactions.csv'), { accounts, tags: false }));
    expect(without.preview.blocks).toEqual([]);
    expect(without.done.status).toBe(200);
    // The tags are left as they are, for the person to see to.
    expect(await fake.get<string>(ctxKey('tags'))).toBe('not-ciphertext-but-long-enough-to-be-tried');
  });

  test('a linked account’s uncertain match waits for the person, answered by the file’s line', async () => {
    await seed();
    const file = [
      '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"',
      `"Checking","","${mdy(daysAgo(30))}","Corner Shop","Fun: Treats","Fun","Treats","",$60.00,$0.00,"Cleared"`,
      `"Checking","","${mdy(daysAgo(50))}","Mystery Payee","Bills: Rent","Bills","Rent","",$1850.00,$0.00,"Cleared"`,
    ].join('\n');
    const answers = { accounts: { Checking: { to: 'linked', id: 'acc_chk' } }, options: { date_order: 'mdy' } };
    const p = await preview(file, answers);
    const [target] = p.body.preview.targets;
    // The bank's rent five days off, with nothing else alike: possibly the
    // same, so it waits.
    expect(target.proposals.map((x: any) => [x.line, x.confidence, x.choice])).toEqual([[3, 'low', null]]);
    expect(p.body.preview.waiting.proposals).toBe(1);
    expect((await post({ action: 'import', review: p.body.preview.review, migration_id: `app-import:${crypto.randomUUID()}`, ...answers }, file)).body.needs).toBe('answers');
    // Answered by its line in the file, which stays its own whatever else
    // the review reads.
    const choices = { [target.key]: { proposals: { each: { '3': 'new' } } } };
    const { preview: answered, done } = await importReviewed(file, { ...answers, choices });
    expect(answered.waiting.proposals).toBe(0);
    expect(answered.targets[0].proposals[0].choice).toBe('new');
    expect(done.status).toBe(200);
    const read = (await activity()).transactions as any[];
    // The bank's rent, and the file's row beside it as one of its own.
    const rent = read.filter((t) => t.amount === 1850);
    expect(rent.length).toBe(2);
    expect(rent.some((t) => t.transaction_id === 'b_rent')).toBe(true);
    expect(rent.some((t) => t.source === 'import:csv' && t.name === 'Mystery Payee')).toBe(true);
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
    const { crc32, deflateRawSync } = await import('node:zlib');
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
        local.writeUInt32LE(crc32(data), 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(n.length, 26);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(8, 10);
        cd.writeUInt32LE(crc32(data), 16);
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
    const { addTag } = await import('@/lib/tags');
    const { changeTagSet } = await import('@/lib/tags-store');
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

  test('one still being made isn’t undone under it; one that stopped part way is', async () => {
    const file = fixture('actual-export.csv');
    const accounts = newAccounts(['Checking', 'Savings']);
    const { preview: p, done, migration_id } = await importReviewed(file, { accounts });
    expect(done.status).toBe(200);
    const entry = (await migrationStore.get(ctx, migration_id))!;
    // As it is while its steps run.
    await migrationStore.set(ctx, migration_id, { ...entry, status: 'importing', finished_at: null, started_at: new Date().toISOString() });
    const busy = await undo({ migration_id, confirm: true });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toContain('still being made');
    expect((await getManualAccounts(ctx)).length).toBe(2);
    // Sent again meanwhile, it says so rather than making it twice.
    const again = await post({ action: 'import', review: p.review, migration_id, accounts }, file);
    expect(again.body).toMatchObject({ migration_id, already: true, status: 'importing' });
    // Quiet for longer than any import takes, it stopped part way: Undo takes
    // out what it made.
    const stopped = new Date(Date.now() - 10 * 60_000).toISOString();
    await migrationStore.set(ctx, migration_id, { ...entry, status: 'importing', finished_at: null, started_at: stopped });
    // As the import saved its accounts then, stamped with its start.
    for (const a of await getManualAccounts(ctx)) await saveManualAccount(ctx, { ...a, updated_at: stopped });
    const undone = await undo({ migration_id, confirm: true });
    expect(undone.status).toBe(200);
    expect(await getManualAccounts(ctx)).toEqual([]);
    expect(await migrationStore.get(ctx, migration_id)).toBeNull();
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
    const answers = { accounts: { Cash: { to: 'new' as const, name: 'Cash', institution: 'Wallet', type: 'depository' as const, balance: 20 }, Checking: { to: 'linked' as const, id: 'acc_chk' } }, categories: {}, tags: true, carry: true, currency: null, choices: {} };
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

// ---- A linked account's pairs kept once made ----

describe('into a linked account whose bank rows stand for an earlier import’s', () => {
  /** A bank's own CSV of the account, imported into it through its history
   *  import, as reviewed: the row it brought. */
  async function historyImport(lines: string[]) {
    const form = (meta: object) => {
      const f = new FormData();
      f.set('file', new Blob([new TextEncoder().encode(['Date,Description,Amount', ...lines].join('\n')) as Uint8Array<ArrayBuffer>]), 'bank.csv');
      f.set('meta', JSON.stringify({ file_name: 'bank.csv', account_id: 'acc_chk', options: { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } }, ...meta }));
      return new Request('http://localhost/api/history-import', { method: 'POST', body: f });
    };
    const p = await asRes(await historyRoutes.POST(form({ action: 'preview' })));
    expect(p.status).toBe(200);
    expect((await asRes(await historyRoutes.POST(form({ action: 'import', review: p.body.preview.review })))).status).toBe(200);
    return (await importedTxnStore.get(ctx, 'acc_chk'))!.rows;
  }
  const sync = () => assembleBankRows(ctx, { sync: true });
  const RENT = bankTxn('b_rent', 'acc_chk', 55, 1850, { name: 'ZELLE PAYMENT TO LANDLORD', merchant_name: 'Landlord', category: 'rent and utilities' });
  /** YNAB's register of the same account: the rent, and a row of its own. */
  const file = (rent: number) => {
    const ynab = CASES.find((c) => c.app === 'ynab')!;
    return ynab.linked([
      { days: 55, payee: 'Landlord', amount: rent, category: 'Rent', group: 'Bills' },
      { days: 30, payee: 'Corner Shop', amount: 60, category: 'Shopping', group: 'Fun' },
    ]);
  };
  const answers = { accounts: { Checking: { to: 'linked', id: 'acc_chk' } }, options: { date_order: 'mdy' } };
  const rent = async () => ((await activity()).transactions as any[]).filter((t) => t.name !== 'FIRST ROW' && /landlord/i.test(`${t.name} ${t.merchant_name ?? ''}`));
  const spentOnRent = async () => (await activity()).transactions.filter((t: any) => t.amount > 1000).reduce((n: number, t: any) => n + t.amount, 0);

  test('a bank row standing for an earlier file’s row: the app’s row is that transaction, never one beside it, and undone it stays so', async () => {
    await seed();
    const [earlier] = await historyImport([`${daysAgo(55)},ZELLE PAYMENT TO LANDLORD,-1850.00`]);
    expect(earlier.same_as).toBeDefined();
    const { preview, done } = await importReviewed(file(1850), answers);
    const [target] = preview.targets;
    expect(target.proposals.map((p: any) => [p.file.name, p.twin.kind, p.twin.amount, p.choice])).toEqual([['Landlord', 'bank', 1850, 'same']]);
    expect(target.counts.new).toBe(1);
    expect(done.status).toBe(200);
    // The rent once, as the bank's, kept as the earlier file's row it stands
    // for, with the app's category; the app's own row beside the bank's rows.
    expect((await rent()).map((t) => [t.transaction_id, t.amount, t.category_name])).toEqual([['b_rent', 1850, 'Rent']]);
    expect(await spentOnRent()).toBe(1850);
    expect((await importedTxnStore.get(ctx, 'acc_chk'))!.rows.find((r) => r.name === 'Landlord')!.same_as_row).toBe(earlier.id);
    const undone = await undo({ migration_id: (await list()).body.imports[0].id, confirm: true });
    expect(undone.status).toBe(200);
    expect((await rent()).map((t) => [t.transaction_id, t.amount, t.category_name])).toEqual([['b_rent', 1850, 'rent and utilities']]);
    expect((await importedTxnStore.get(ctx, 'acc_chk'))!.rows.map((r) => r.id)).toEqual([earlier.id]);
  });

  test('a row the bank changed since: the app’s row is found as the earlier file’s, and the transaction counts once, at the bank’s amount', async () => {
    await seed();
    const [earlier] = await historyImport([`${daysAgo(55)},ZELLE PAYMENT TO LANDLORD,-1850.00`]);
    // The bank modifies its row (the same id): the sync keeps the pair first.
    plaid.modified.push({ ...RENT, amount: 1875 });
    await sync();
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toEqual({ version: 1, twins: { [earlier.id]: 'b_rent' } });
    expect((await rent()).map((t) => [t.transaction_id, t.amount])).toEqual([['b_rent', 1875]]);

    // The app's file has the rent as the person entered it, at the old amount.
    const { preview, done } = await importReviewed(file(1850), answers);
    const [target] = preview.targets;
    expect(target.proposals.map((p: any) => [p.twin.kind, p.twin.id, p.twin.amount, p.choice])).toEqual([['imported', earlier.id, 1850, 'same']]);
    expect(target.counts.new).toBe(1);
    expect(done.status).toBe(200);
    expect((await rent()).map((t) => [t.transaction_id, t.amount, t.category_name])).toEqual([['b_rent', 1875, 'Rent']]);
    expect(await spentOnRent()).toBe(1875);
    // At the bank's new amount the app's row is the same transaction too.
    const again = await preview_(file(1875));
    expect(again.targets[0].counts.new ?? 0).toBe(0);

    // Undone, the pair still holds: the earlier file's row stays the bank's.
    const undone = await undo({ migration_id: (await list()).body.imports[0].id, confirm: true });
    expect(undone.status).toBe(200);
    expect((await rent()).map((t) => [t.transaction_id, t.amount])).toEqual([['b_rent', 1875]]);
    expect(await spentOnRent()).toBe(1875);
  });

  test('the app’s row at the bank’s new amount, after the bank changed its row: the pair kept makes it that transaction, counted once', async () => {
    await seed();
    const [earlier] = await historyImport([`${daysAgo(55)},ZELLE PAYMENT TO LANDLORD,-1850.00`]);
    plaid.modified.push({ ...RENT, amount: 1875 });
    await sync();
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toEqual({ version: 1, twins: { [earlier.id]: 'b_rent' } });
    // Without the pair the bank's row would stand for the earlier file's row
    // and nothing else, and the app's row at 1,875 would count beside it.
    const { preview, done } = await importReviewed(file(1875), answers);
    expect(preview.targets[0].proposals.map((p: any) => [p.twin.kind, p.twin.amount, p.choice])).toEqual([['bank', 1875, 'same']]);
    expect(done.status).toBe(200);
    expect((await rent()).map((t) => [t.transaction_id, t.amount])).toEqual([['b_rent', 1875]]);
    expect(await spentOnRent()).toBe(1875);
  });

  test('pairs that can’t be read: the account isn’t matched against, said, and nothing is imported into it', async () => {
    await seed();
    await historyImport([`${daysAgo(55)},ZELLE PAYMENT TO LANDLORD,-1850.00`]);
    await fake.hset(ctxKey('imported-twins'), { item_chase: 'not-ciphertext-but-long-enough-to-be-tried' });
    const p = await quietly(() => preview(file(1850), answers));
    expect(p.status).toBe(200);
    expect(p.body.preview.blocks.join(' ')).toContain('stand for');
    const refused = await quietly(() => post({ action: 'import', review: p.body.preview.review, migration_id: `app-import:${crypto.randomUUID()}`, ...answers }, file(1850)));
    expect(refused.status).toBe(409);
    expect((await importedTxnStore.get(ctx, 'acc_chk'))!.rows.length).toBe(1);
  });

  /** The review of a file into the linked account, with the answers above. */
  const preview_ = async (f: string) => (await preview(f, answers)).body.preview;
});

// ---- What a linked account's bank already is ----

describe('into a linked account, nothing its bank has is brought beside it', () => {
  const COSTCO = bankTxn('b_costco', 'acc_chk', 20, 120, { name: 'COSTCO WHSE #0012', merchant_name: 'Costco' });
  const linkedTo = { accounts: { Checking: { to: 'linked', id: 'acc_chk' } } };
  const ynabHeader = '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"';
  /** A row of YNAB's register, on a day (`ynabOn`) or so many days ago. */
  const ynabOn = (day: string, payee: string, group: string, category: string, memo: string, out: number, inn = 0) =>
    `"Checking","","${mdy(day)}","${payee}","${group ? `${group}: ${category}` : ''}","${group}","${category}","${memo}",$${out.toFixed(2)},$${inn.toFixed(2)},"Cleared"`;
  const ynabRow = (days: number, payee: string, group: string, category: string, memo: string, out: number, inn = 0) => ynabOn(daysAgo(days), payee, group, category, memo, out, inn);
  /** What counts of Costco, as every total reads it: the bank's whole row
   *  (or its parts, split as the app had it), never the file's lines beside it. */
  async function costco() {
    const read = (await activity()).transactions as any[];
    const rows = read.filter((t) => /costco/i.test(`${t.name} ${t.merchant_name ?? ''}`));
    return { rows, out: spending(rows, 'USD') };
  }
  const cases: { name: string; file: string; options?: Record<string, unknown>; expect: { new: number; duplicates: number }; left?: Record<string, number>; whole?: number; combined?: number; parts?: number }[] = [
    {
      name: 'Monarch’s rows of one split, which its export doesn’t mark: taken together as the bank’s transaction, with their categories as its parts',
      file: ['Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags', `${daysAgo(20)},Costco,Groceries,Checking,COSTCO WHSE #0012,,-80.00,`, `${daysAgo(20)},Costco,Household,Checking,COSTCO WHSE #0012,,-40.00,`].join('\n'),
      expect: { new: 0, duplicates: 1 },
      combined: 1,
      parts: 2,
    },
    {
      name: 'ZeroSum’s unmarked lines of one split, the same way',
      file: ['Date,Account,Payee,Category Group,Category,Memo,Tags,Outflow,Inflow,Cleared', `${mdy(daysAgo(20))},Checking,Costco,Food,Groceries,,,80.00,,Cleared`, `${mdy(daysAgo(20))},Checking,Costco,Home,Household,,,40.00,,Cleared`].join('\n'),
      options: { options: { date_order: 'mdy' } },
      expect: { new: 0, duplicates: 1 },
      combined: 1,
      parts: 2,
    },
    {
      name: 'Actual’s parts from before 24.8, each with the transaction’s payee, the same way',
      file: ['Account,Date,Payee,Notes,Category,Amount,Cleared', `Checking,${daysAgo(20)},Costco,,Groceries,-80.00,Cleared`, `Checking,${daysAgo(20)},Costco,,Household,-40.00,Cleared`].join('\n'),
      expect: { new: 0, duplicates: 1 },
      combined: 1,
      parts: 2,
    },
    {
      name: 'a YNAB split with a line of no category, which Nya can’t hold as one: whole, as the bank has it',
      file: [ynabHeader, ynabRow(20, 'Costco', 'Food', 'Groceries', 'Split (1/2) ', 80), ynabRow(20, 'Costco', '', '', 'Split (2/2) ', 40)].join('\n'),
      options: { options: { date_order: 'mdy' } },
      expect: { new: 0, duplicates: 1 },
      whole: 2,
    },
    {
      name: 'a YNAB split with a line missing: the file doesn’t hold the transaction, so its lines are left out',
      file: [ynabHeader, ynabRow(20, 'Costco', 'Food', 'Groceries', 'Split (1/3) ', 80), ynabRow(20, 'Costco', 'Home', 'Household', 'Split (3/3) ', 40)].join('\n'),
      options: { options: { date_order: 'mdy' } },
      expect: { new: 0, duplicates: 0 },
      left: { lines: 2 },
    },
    {
      name: 'Lunch Money’s parts on other days than their transaction: its parent row whole, as the bank has it',
      file: [
        'date,payee,amount,currency,category,category_group,notes,tags,account,original_name,type,parent_id,id,recurring_id,created_at',
        `${daysAgo(20)},Costco,120.00,usd,,,,,Checking,COSTCO WHSE #0012,split,,900,,`,
        `${daysAgo(20)},Costco,80.00,usd,Groceries,Food,,,Checking,COSTCO WHSE #0012,,900,901,,`,
        `${daysAgo(19)},Costco,40.00,usd,Household,Home,,,Checking,COSTCO WHSE #0012,,900,902,,`,
      ].join('\n'),
      expect: { new: 0, duplicates: 1 },
      whole: 2,
    },
    {
      name: 'Actual’s split whose parts don’t add up to it: its own row’s total, whole',
      file: [
        'Account,Date,Payee,Notes,Category_Group,Category,Amount,Split_Amount,Cleared',
        `Checking,${daysAgo(20)},Costco,(SPLIT INTO 2),,,0,-120.00,Cleared`,
        `Checking,${daysAgo(20)},Costco,(SPLIT 1 OF 2),Food,Groceries,-80.00,0,Cleared`,
        `Checking,${daysAgo(20)},Costco,(SPLIT 2 OF 2),Home,Household,-30.00,0,Cleared`,
      ].join('\n'),
      expect: { new: 0, duplicates: 1 },
      whole: 2,
    },
    {
      name: 'Lunch Money’s group, the net of transactions the bank has one by one: left out',
      file: [
        'date,payee,amount,currency,category,category_group,notes,tags,account,original_name,type,parent_id,id,recurring_id,created_at',
        `${daysAgo(30)},Dinner with Sam,40.00,usd,Restaurants,Food,,,Checking,,group,,800,,`,
      ].join('\n'),
      expect: { new: 0, duplicates: 0 },
      left: { groups: 1 },
    },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      await seed(ctx, [...BANK, COSTCO]);
      const before = await costco();
      const { preview, done } = await importReviewed(c.file, { ...linkedTo, ...(c.options ?? {}) });
      const [target] = preview.targets;
      expect({ new: target.counts.new ?? 0, duplicates: target.counts.duplicates ?? 0 }).toEqual(c.expect);
      if (c.left) for (const [k, n] of Object.entries(c.left)) expect(target.left_out[k]).toBe(n);
      if (c.whole) expect(target.whole.reduce((n: number, w: any) => n + w.count, 0)).toBe(c.whole);
      if (c.combined) expect(target.combined.transactions).toBe(c.combined);
      expect(done.status).toBe(200);
      const after = await costco();
      // Never beside the bank's row: Costco counts what the bank says, once,
      // as it did before the import, and nothing of the file counts beside it.
      const total = (o: Record<string, number>) => Math.round(Object.values(o).reduce((n, x) => n + x, 0) * 100) / 100;
      expect(total(before.out)).toBe(120);
      expect(total(after.out)).toBe(120);
      expect(((await activity()).transactions as any[]).filter((t) => t.source === 'import:csv')).toEqual([]);
      // The app's parts carried onto the bank's row, as its split.
      if (c.parts) expect(after.rows.filter((t) => t.split_of).map((t) => t.amount).sort()).toEqual([40, 80]);
    });
  }

  /** Everything counted, as one total (the bank's first row of 1 too). */
  const counted = async () => {
    const out = spending((await activity()).transactions as any[], 'USD');
    return Math.round(Object.values(out).reduce((n, x) => n + x, 0) * 100) / 100;
  };
  const MONARCH = 'Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags';
  const ONE = bankTxn('b_first', 'acc_chk', 60, 1, { name: 'FIRST ROW' });

  test('a split whose bank row is still pending is taken as it, and retired by it once it posts', async () => {
    await seed(ctx, [ONE, bankTxn('p_costco', 'acc_chk', 1, 120, { name: 'COSTCO WHSE #0012', pending: true })]);
    const file = [MONARCH, `${daysAgo(1)},Costco,Groceries,Checking,COSTCO WHSE #0012,,-80.00,`, `${daysAgo(1)},Costco,Household,Checking,COSTCO WHSE #0012,,-40.00,`].join('\n');
    const { preview, done } = await importReviewed(file, linkedTo);
    expect(preview.targets[0].combined.transactions).toBe(1);
    expect(preview.targets[0].pending_alike).toBe(1);
    expect(done.status).toBe(200);
    expect(await counted()).toBe(121);
    // The bank posts it: one transaction, the app's parts on it.
    await seed(ctx, [ONE, bankTxn('b_costco', 'acc_chk', 1, 120, { name: 'COSTCO WHSE #0012', pending_transaction_id: 'p_costco' })]);
    expect(await counted()).toBe(121);
    expect(((await activity()).transactions as any[]).filter((t) => t.split_of).map((t) => t.amount).sort()).toEqual([40, 80]);
  });

  test('separate purchases still pending at the bank are each their own, never made one to match another transaction', async () => {
    const parking = (id: string, over: Record<string, unknown> = {}) => bankTxn(id, 'acc_chk', 1, 2.5, { name: 'CITY PARKING 0042', ...over });
    await seed(ctx, [ONE, parking('p_park1', { pending: true }), parking('p_park2', { pending: true }), bankTxn('b_bakery', 'acc_chk', 3, 5, { name: 'CORNER BAKERY' })]);
    const file = [
      MONARCH,
      `${daysAgo(1)},City Parking,Parking,Checking,CITY PARKING 0042,,-2.50,`,
      `${daysAgo(1)},City Parking,Parking,Checking,CITY PARKING 0042,,-2.50,`,
      `${daysAgo(3)},Corner Bakery,Restaurants,Checking,CORNER BAKERY,,-5.00,`,
    ].join('\n');
    const { preview, done } = await importReviewed(file, linkedTo);
    expect(preview.targets[0].combined.transactions).toBe(0);
    expect(preview.targets[0].pending_alike).toBe(2);
    expect(done.status).toBe(200);
    expect(await counted()).toBe(11);
    await seed(ctx, [ONE, parking('b_park1', { pending_transaction_id: 'p_park1' }), parking('b_park2', { pending_transaction_id: 'p_park2' }), bankTxn('b_bakery', 'acc_chk', 3, 5, { name: 'CORNER BAKERY' })]);
    expect(await counted()).toBe(11);
  });

  /** On a clock of its own (every day in these tests is a fixed one): the
   *  account's bank rows from 2026-08-18, and the bank's own file of a year
   *  before, through its history import, as reviewed. The clock moves on
   *  after it, so the app's import is made later, as it always is in use
   *  (the order of imports is by when they were made: lib/history-import/
   *  read.ts importOrder). */
  async function bankFileFirst(lines: string[]) {
    setSystemTime(new Date('2026-10-17T12:00:00Z'));
    await seed(ctx, [bankTxn('b_first', 'acc_chk', 0, 1, { name: 'FIRST ROW', date: '2026-08-18' })]);
    const bankCsv = ['Date,Description,Amount', ...lines].join('\n');
    const form = (meta: object) => {
      const f = new FormData();
      f.set('file', new Blob([new TextEncoder().encode(bankCsv) as Uint8Array<ArrayBuffer>]), 'bank.csv');
      f.set('meta', JSON.stringify({ file_name: 'bank.csv', account_id: 'acc_chk', options: { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } }, ...meta }));
      return new Request('http://localhost/api/history-import', { method: 'POST', body: f });
    };
    const hp = await asRes(await historyRoutes.POST(form({ action: 'preview' })));
    expect((await asRes(await historyRoutes.POST(form({ action: 'import', review: hp.body.preview.review })))).status).toBe(200);
    setSystemTime(new Date('2026-10-17T12:05:00Z'));
  }

  test('a group dated inside a bank file imported before is left out, since that file has its transactions one by one', async () => {
    try {
      // The bank's own file: the dinner as the bank has it, a charge and a
      // friend's repayment.
      await bankFileFirst(['2025-08-23,GROCER,-30.00', '2025-09-12,DINNER PLACE,-135.00', '2025-09-13,VENMO FROM SAM,90.00', '2025-10-02,GROCER,-20.00']);
      expect(await counted()).toBe(1 + 30 + 135 + 20);
      // Lunch Money's export of the same days: the dinner as a group at its net.
      const lm = [
        'date,payee,amount,currency,category,category_group,notes,tags,account,original_name,type,parent_id,id,recurring_id,created_at',
        '2025-08-23,Grocer,30.00,usd,Groceries,Food,,,Checking,,,,1,,',
        '2025-09-12,Dinner with friends,45.00,usd,Restaurants,Food,,,Checking,,group,,2,,',
        '2025-10-02,Grocer,20.00,usd,Groceries,Food,,,Checking,,,,3,,',
      ].join('\n');
      const { preview, done } = await importReviewed(lm, linkedTo);
      const [target] = preview.targets;
      // The group is left out, and the groceries are found exactly as the
      // earlier file's own rows, already in the account.
      expect(target.left_out).toEqual({ opening: 0, groups: 1, lines: 0 });
      expect(target.counts.new ?? 0).toBe(0);
      expect(target.counts.present).toBe(2);
      expect(target.proposals).toEqual([]);
      expect(done.status).toBe(200);
      // Spent as the bank's file says, the dinner once: never the group's 45 beside it.
      expect(await counted()).toBe(1 + 30 + 135 + 20);
      expect(((await activity()).transactions as any[]).some((t) => t.name === 'Dinner with friends')).toBe(false);
    } finally {
      setSystemTime();
    }
  });

  test('a split dated inside a bank file imported before, which has the transaction: its lines left out without their whole, whole when Nya can’t hold it', async () => {
    try {
      await bankFileFirst(['2025-09-12,COSTCO WHSE #0012,-120.00', '2025-09-20,TARGET T-1234,-22.00']);
      expect(await counted()).toBe(1 + 120 + 22);
      // YNAB's split of three lines, its second missing from the file; and
      // one with a line of no category, which a split in Nya can't have.
      const ynab = [
        ynabHeader,
        ynabOn('2025-09-12', 'Costco', 'Food', 'Groceries', 'Split (1/3) ', 80),
        ynabOn('2025-09-12', 'Costco', 'Home', 'Household', 'Split (3/3) ', 15),
        ynabOn('2025-09-20', 'Target', 'Food', 'Groceries', 'Split (1/2) ', 10),
        ynabOn('2025-09-20', 'Target', '', '', 'Split (2/2) ', 12),
      ].join('\n');
      const { preview, done } = await importReviewed(ynab, { ...linkedTo, options: { date_order: 'mdy' } });
      const [target] = preview.targets;
      expect(target.left_out).toEqual({ opening: 0, groups: 0, lines: 2 });
      expect(target.whole.reduce((n: number, w: any) => n + w.count, 0)).toBe(2);
      expect(target.proposals.map((p: any) => [p.file.name, p.file.amount, p.twin.kind, p.choice])).toEqual([['Target', 22, 'imported', 'same']]);
      expect(target.counts.new ?? 0).toBe(0);
      expect(done.status).toBe(200);
      // Each once, as the bank's file says: never Costco's two lines' 95 nor
      // Target's lines beside them.
      expect(await counted()).toBe(1 + 120 + 22);
    } finally {
      setSystemTime();
    }
  });

  test('the app’s rows a bank file imported before brought carry nothing onto them, and the review says those keep what they have', async () => {
    try {
      // A year before the bank's own rows begin: only the bank's file has these.
      await bankFileFirst(['2025-08-30,TARGET T-1234,-22.00', '2025-09-12,COSTCO WHSE #0012,-120.00']);
      const shown = async () => {
        const read = ((await activity()).transactions as any[]).filter((t) => t.name !== 'FIRST ROW');
        return { rows: read.map((t) => [t.name, t.amount, t.category_name ?? null, t.note ?? null, t.tags ?? [], !!t.split_of]).sort(), spent: spending(read, 'USD') };
      };
      const before = await shown();
      expect(before.rows.length).toBe(2);
      // YNAB's register of those days: Target under Home: Supplies, with a
      // memo, and Costco split between groceries and household.
      const ynab = [
        ynabHeader,
        ynabOn('2025-09-12', 'Costco', 'Food', 'Groceries', 'Split (1/2) ', 80),
        ynabOn('2025-09-12', 'Costco', 'Home', 'Household', 'Split (2/2) ', 40),
        ynabOn('2025-08-30', 'Target', 'Home', 'Supplies', 'bought a lamp', 22),
      ].join('\n');
      const { preview, done } = await importReviewed(ynab, { ...linkedTo, options: { date_order: 'mdy' } });
      const [target] = preview.targets;
      // Each is the bank file's row, as the review says, and nothing of the
      // app's would show on it (only a bank's row shows what is said on a
      // row standing for it): so nothing goes, and the review counts them
      // as keeping what they have, not as taking the app's.
      expect(target.proposals.map((p: any) => [p.file.name, p.twin.kind, p.choice, p.carry_to])).toEqual([
        ['Target', 'imported', 'same', 'earlier'],
        ['Costco', 'imported', 'same', 'earlier'],
      ]);
      expect(target.counts.already).toBe(2);
      expect(target.carry).toEqual({ bank: 0, approved: 0, notes: 0, earlier: 2 });
      expect(done.status).toBe(200);
      expect(done.body.counts).toMatchObject({ imported: 0, duplicates: 2, splits: 0, tagged: 0 });
      // They keep what they have, and spending is what it was.
      expect(await shown()).toEqual(before);
      // Nothing is said about the app's rows: no category, note or split.
      const ids = (await importedTxnStore.get(ctx, 'acc_chk'))!.rows.filter((r) => r.name === 'Target' || r.name === 'Costco').map((r) => r.id);
      expect(ids.length).toBe(2);
      expect([...(await txnAnnotationStore.getMany(ctx, ids)).keys()]).toEqual([]);
      expect([...(await splitStore.getMany(ctx, ids)).keys()]).toEqual([]);
      const overrides = await getOverrides(ctx);
      expect(ids.filter((id) => id in overrides)).toEqual([]);
    } finally {
      setSystemTime();
    }
  });

  /** The review queue on, and a bank's row approved as it shows, as the
   *  Activity tab and Card Mode approve one. */
  async function approve(id: string) {
    const reviewRoute = await import('@/app/api/review/route');
    const { approvalInputOf } = await import('@/lib/review-layer');
    const { bankRows } = await import('@/lib/split-rows');
    const send = async (body: unknown) => (await reviewRoute.POST(new Request('http://localhost/api/review', { method: 'POST', body: JSON.stringify(body) }))).status;
    expect(await send({ action: 'start', today: daysAgo(0), since: daysAgo(20) })).toBe(200);
    const row = bankRows((await activity()).transactions as any[]).find((t: any) => t.transaction_id === id);
    expect(row).toBeDefined();
    expect(await send({ action: 'approve', items: [approvalInputOf(row as any)] })).toBe(200);
  }
  /** The bank's Costco row as every reader shows it (whole again, when
   *  split), its parts, and what is spent. */
  async function bankCostco() {
    const { bankRows } = await import('@/lib/split-rows');
    const read = (await activity()).transactions as any[];
    const t = bankRows(read).find((x: any) => x.transaction_id === 'b_costco') as any;
    const set = await readTagSet(ctx);
    return {
      category: t.category_name,
      approved: !!t.reviewed_at,
      offered: t.review_suggestion ?? null,
      note: t.note ?? null,
      tags: (t.tags ?? []).map((id: string) => set?.tags.find((x) => x.id === id)?.name),
      parts: read.filter((x) => x.split_of === 'b_costco').map((x) => [x.amount, x.category_name]),
      spent: spending(read, 'USD'),
    };
  }
  const costcoRow = (over: Record<string, unknown> = {}) => bankTxn('b_costco', 'acc_chk', 5, 120, { name: 'COSTCO WHSE #0012', merchant_name: 'Costco', ...over });

  for (const variant of ['category', 'split'] as const) {
    test(`a transaction approved in the review queue stays where it was approved: the app’s ${variant} doesn’t move it, its tags and notes still come, and Undo leaves it as it was`, async () => {
      await seed(ctx, [ONE, costcoRow()]);
      await approve('b_costco');
      const before = await bankCostco();
      expect(before).toMatchObject({ category: 'general merchandise', approved: true, offered: null, note: null, tags: [], parts: [] });
      // Monarch has it under Household, with a note; or as two rows, 80 of
      // groceries and 40 of household, which are taken together as it.
      const file =
        variant === 'category'
          ? [MONARCH, `${daysAgo(5)},Costco,Household,Checking,COSTCO WHSE #0012,bulk run,-120.00,Costco run`].join('\n')
          : [MONARCH, `${daysAgo(5)},Costco,Groceries,Checking,COSTCO WHSE #0012,,-80.00,Costco run`, `${daysAgo(5)},Costco,Household,Checking,COSTCO WHSE #0012,,-40.00,`].join('\n');
      const { preview, done, migration_id } = await importReviewed(file, linkedTo);
      const [target] = preview.targets;
      if (variant === 'split') expect(target.combined.transactions).toBe(1);
      expect(target.proposals.map((p: any) => [p.twin.kind, p.choice, p.carry_to])).toEqual([['bank', 'same', 'approved']]);
      expect(target.carry).toEqual({ bank: 0, approved: 1, notes: 1, earlier: 0 });
      expect(done.status).toBe(200);
      expect(done.body.counts).toMatchObject({ duplicates: 1, splits: 0, tagged: 1 });
      // Where it was approved, still approved, with nothing offered: only
      // the app's tags and note beside it, its 120 spent where it was.
      expect(await bankCostco()).toEqual({ ...before, note: variant === 'category' ? 'bulk run' : null, tags: ['Costco run'] });
      const undone = await undo({ migration_id, confirm: true });
      expect(undone.status).toBe(200);
      expect(await bankCostco()).toEqual(before);
    });
  }

  const HOUSEHOLD = [MONARCH, `${daysAgo(5)},Costco,Household,Checking,COSTCO WHSE #0012,,-120.00,`].join('\n');

  test('an approval made while the bank’s row was pending holds it too, as the posted row has it from the pending one', async () => {
    await seed(ctx, [ONE, costcoRow({ transaction_id: 'p_costco', pending: true })]);
    await approve('p_costco');
    // Posted: its approval is the pending one's until the sync that removes
    // that one moves it.
    await seed(ctx, [ONE, costcoRow({ pending_transaction_id: 'p_costco' })]);
    expect((await bankCostco()).approved).toBe(true);
    const { preview, done } = await importReviewed(HOUSEHOLD, linkedTo);
    expect(preview.targets[0].carry).toEqual({ bank: 0, approved: 1, notes: 0, earlier: 0 });
    expect(done.status).toBe(200);
    expect(await bankCostco()).toMatchObject({ category: 'general merchandise', approved: true, offered: null });
  });

  test('an approval of a row a bank file brought holds the bank’s row that took its place', async () => {
    await seed(ctx, [ONE]);
    const form = (meta: object) => {
      const f = new FormData();
      f.set('file', new Blob([new TextEncoder().encode(['Date,Description,Amount', `${daysAgo(5)},COSTCO WHSE #0012,-120.00`].join('\n')) as Uint8Array<ArrayBuffer>]), 'bank.csv');
      f.set('meta', JSON.stringify({ file_name: 'bank.csv', account_id: 'acc_chk', options: { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } }, ...meta }));
      return new Request('http://localhost/api/history-import', { method: 'POST', body: f });
    };
    const hp = await asRes(await historyRoutes.POST(form({ action: 'preview' })));
    expect((await asRes(await historyRoutes.POST(form({ action: 'import', review: hp.body.preview.review })))).status).toBe(200);
    const [fromFile] = (await importedTxnStore.get(ctx, 'acc_chk'))!.rows;
    await approve(fromFile.id);
    // The bank's own row arrives and stands for the file's.
    await seed(ctx, [ONE, costcoRow()]);
    expect((await bankCostco()).approved).toBe(true);
    const { preview, done } = await importReviewed(HOUSEHOLD, linkedTo);
    expect(preview.targets[0].proposals.map((p: any) => [p.twin.kind, p.carry_to])).toEqual([['bank', 'approved']]);
    expect(done.status).toBe(200);
    expect(await bankCostco()).toMatchObject({ category: 'general merchandise', approved: true, offered: null });
  });

  test('an approval made after the review asks for the review again, which then says it', async () => {
    await seed(ctx, [ONE, costcoRow()]);
    const p = await preview(HOUSEHOLD, linkedTo);
    expect(p.body.preview.targets[0].carry).toEqual({ bank: 1, approved: 0, notes: 0, earlier: 0 });
    await approve('b_costco');
    const refused = await post({ action: 'import', review: p.body.preview.review, migration_id: `app-import:${crypto.randomUUID()}`, ...linkedTo }, HOUSEHOLD);
    expect(refused.status).toBe(409);
    expect(refused.body.needs).toBe('review');
    const { preview: again, done } = await importReviewed(HOUSEHOLD, linkedTo);
    expect(again.targets[0].carry).toEqual({ bank: 0, approved: 1, notes: 0, earlier: 0 });
    expect(done.status).toBe(200);
    expect((await bankCostco()).category).toBe('general merchandise');
  });

  // ---- A transaction the bank still has pending ----

  /** The bank's Costco row still pending, then posted in its place: the
   *  posted row takes the place of the app's row the pending one stood in
   *  for, and what is said about it. */
  const pendingCostco = () => costcoRow({ transaction_id: 'p_costco', date: daysAgo(1), pending: true });
  const postedCostco = () => costcoRow({ date: daysAgo(1), pending_transaction_id: 'p_costco' });
  const pendingSplits: Record<string, { file: string; extra: Record<string, unknown> }> = {
    'Monarch’s two rows of it, taken together': {
      file: [MONARCH, `${daysAgo(1)},Costco,Groceries,Checking,COSTCO WHSE #0012,,-80.00,`, `${daysAgo(1)},Costco,Household,Checking,COSTCO WHSE #0012,,-40.00,`].join('\n'),
      extra: {},
    },
    'YNAB’s marked split of it': {
      file: [ynabHeader, ynabRow(1, 'Costco', 'Food', 'Groceries', 'Split (1/2) ', 80), ynabRow(1, 'Costco', 'Home', 'Household', 'Split (2/2) ', 40)].join('\n'),
      extra: { options: { date_order: 'mdy' } },
    },
  };
  for (const [name, { file, extra }] of Object.entries(pendingSplits)) {
    for (const variant of ['approved', 'carry off', 'carry on'] as const) {
      test(`${name}, for a transaction the bank still has pending: its parts reach the bank’s row once it posts only with carry on and no approval (${variant})`, async () => {
        await seed(ctx, [ONE, pendingCostco()]);
        if (variant === 'approved') await approve('p_costco');
        const { preview, done, migration_id } = await importReviewed(file, { ...linkedTo, ...extra, ...(variant === 'carry off' ? { carry: false } : {}) });
        const [target] = preview.targets;
        // The app's own row, which the pending one stands in for until it posts.
        expect({ new: target.counts.new, pending_alike: target.pending_alike }).toEqual({ new: 1, pending_alike: 1 });
        expect(target.carry).toEqual(variant === 'approved' ? { bank: 0, approved: 1, notes: 0, earlier: 0 } : { bank: 1, approved: 0, notes: 0, earlier: 0 });
        // Otherwise it comes in at its total, without its parts.
        expect(target.splits).toBe(variant === 'carry on' ? 1 : 0);
        expect(done.status).toBe(200);
        expect(done.body.counts.splits).toBe(variant === 'carry on' ? 1 : 0);
        expect(await counted()).toBe(121);
        await seed(ctx, [ONE, postedCostco()]);
        const posted = await bankCostco();
        expect(await counted()).toBe(121);
        if (variant === 'carry on') expect(posted.parts.sort()).toEqual([[40, 'Household'], [80, 'Groceries']]);
        else expect(posted).toMatchObject({ category: 'general merchandise', parts: [], spent: { 'general merchandise': 121 } });
        if (variant === 'approved') expect(posted).toMatchObject({ approved: true, offered: null });
        // Undone, the bank's row is as it was.
        expect((await undo({ migration_id, confirm: true })).status).toBe(200);
        expect(await bankCostco()).toMatchObject({ category: 'general merchandise', parts: [], spent: { 'general merchandise': 121 } });
      });
    }
  }

  for (const carry of [false, true]) {
    test(`a tagged row of the app’s for a transaction the bank still has pending: its tag and note reach the bank’s row once it posts ${carry ? 'with carry on, with its category' : 'never with carry off'}`, async () => {
      await seed(ctx, [ONE, pendingCostco()]);
      const tagged = [MONARCH, `${daysAgo(1)},Costco,Household,Checking,COSTCO WHSE #0012,bulk run,-120.00,Reimbursable`].join('\n');
      const { preview, done } = await importReviewed(tagged, { ...linkedTo, carry });
      expect(preview.targets[0].pending_alike).toBe(1);
      expect(preview.targets[0].carry).toEqual({ bank: 1, approved: 0, notes: 0, earlier: 0 });
      expect(done.status).toBe(200);
      expect(done.body.counts.tagged).toBe(carry ? 1 : 0);
      await seed(ctx, [ONE, postedCostco()]);
      expect(await bankCostco()).toMatchObject(carry ? { category: 'Household', note: 'bulk run', tags: ['Reimbursable'] } : { category: 'general merchandise', note: null, tags: [] });
    });
  }

  test('a pending row the bank brings after the review asks for the review again, carry off too: what the app’s row brings is no longer what was reviewed', async () => {
    await seed(ctx, [ONE]);
    const tagged = [MONARCH, `${daysAgo(1)},Costco,Household,Checking,COSTCO WHSE #0012,bulk run,-120.00,Reimbursable`].join('\n');
    const p = await preview(tagged, { ...linkedTo, carry: false });
    expect(p.body.preview.targets[0].pending_alike).toBe(0);
    await seed(ctx, [ONE, pendingCostco()]);
    const refused = await post({ action: 'import', review: p.body.preview.review, migration_id: `app-import:${crypto.randomUUID()}`, ...linkedTo, carry: false }, tagged);
    expect(refused.status).toBe(409);
    expect(refused.body.needs).toBe('review');
    const { preview: again, done } = await importReviewed(tagged, { ...linkedTo, carry: false });
    expect(again.targets[0].pending_alike).toBe(1);
    expect(done.status).toBe(200);
    expect(done.body.counts.tagged).toBe(0);
  });

  // Plaid posts a pending transaction under a new id, naming the pending
  // one, dated by its posting: usually after the export's last day.
  for (const tip of [0, 10]) {
    test(`the app’s last row, for a transaction the bank posts the next day${tip ? ' with a tip' : ''}: the bank’s row takes its place and what the app said of it, counted once, and Undo leaves the bank’s alone`, async () => {
      await seed(ctx, [ONE, bankTxn('p_dinner', 'acc_chk', 2, 50, { name: 'DINER 0042', merchant_name: 'Diner', pending: true })]);
      const file = [MONARCH, `${daysAgo(2)},Diner,Restaurants,Checking,DINER 0042,date night,-50.00,`].join('\n');
      const { preview, done, migration_id } = await importReviewed(file, linkedTo);
      expect(preview.targets[0].pending_alike).toBe(1);
      expect(preview.targets[0].covers).toMatchObject({ from: daysAgo(2), to: daysAgo(2) });
      expect(done.status).toBe(200);
      expect(await counted()).toBe(1 + 50);
      // The sync that posts it, a day after the file's last.
      const food = { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT', confidence_level: 'HIGH' };
      plaid.added = [bankTxn('b_dinner', 'acc_chk', 1, 50 + tip, { name: 'DINER 0042', merchant_name: 'Diner', pending_transaction_id: 'p_dinner', personal_finance_category: food })];
      plaid.removed = ['p_dinner'];
      await assembleBankRows(ctx, { sync: true });
      const diner = async () =>
        ((await activity()).transactions as any[]).filter((t) => /diner/i.test(`${t.name} ${t.merchant_name ?? ''}`)).map((t) => [t.transaction_id, t.amount, t.category_name, t.note ?? null, t.imported_amount ?? null]);
      expect(await diner()).toEqual([['b_dinner', 50 + tip, 'Restaurants', 'date night', tip ? 50 : null]]);
      expect(await counted()).toBe(1 + 50 + tip);
      expect((await undo({ migration_id, confirm: true })).status).toBe(200);
      expect(await diner()).toEqual([['b_dinner', 50 + tip, 'food and drink', null, null]]);
      expect(await counted()).toBe(1 + 50 + tip);
    });
  }

  test('before the bank’s own rows begin, nothing has a group or a split’s lines: they come in as a manual account takes them, and the period is whole', async () => {
    await seed(ctx, [ONE]);
    const lm = [
      'date,payee,amount,currency,category,category_group,notes,tags,account,original_name,type,parent_id,id,recurring_id,created_at',
      `${daysAgo(420)},Grocer,30.00,usd,Groceries,Food,,,Checking,,,,1,,`,
      `${daysAgo(400)},Dinner with friends,45.00,usd,Restaurants,Food,we split the bill,,Checking,,group,,2,,`,
      `${daysAgo(380)},Grocer,20.00,usd,Groceries,Food,,,Checking,,,,3,,`,
    ].join('\n');
    const { preview, done } = await importReviewed(lm, linkedTo);
    const [target] = preview.targets;
    expect(target.left_out).toEqual({ opening: 0, groups: 0, lines: 0 });
    expect(target.counts.new).toBe(3);
    expect(done.status).toBe(200);
    expect((await importedTxnStore.get(ctx, 'acc_chk'))!.rows.map((r) => [r.name, r.amount]).sort()).toEqual([['Dinner with friends', 45], ['Grocer', 20], ['Grocer', 30]]);
    // YNAB's split with a line missing, and one Nya can't hold, from before
    // the bank's rows: their lines, each under its category.
    const ynab = [ynabHeader, ynabRow(300, 'Target', 'Food', 'Groceries', 'Split (1/3) ', 10), ynabRow(300, 'Target', 'Home', 'Supplies', 'Split (3/3) ', 12), ynabRow(200, 'Costco', 'Food', 'Groceries', 'Split (1/2) ', 80), ynabRow(200, 'Costco', '', '', 'Split (2/2) ', 40)].join('\n');
    const second = await importReviewed(ynab, { ...linkedTo, options: { date_order: 'mdy' } });
    expect(second.preview.targets[0].left_out.lines).toBe(0);
    expect(second.preview.targets[0].whole).toEqual([]);
    expect(second.preview.targets[0].counts.new).toBe(4);
    expect(second.done.status).toBe(200);
  });

  test('opening balances and balance adjustments aren’t brought in, so they are never walked as money that moved', async () => {
    const FIRST = bankTxn('b_first', 'acc_chk', 300, 10, { name: 'FIRST ROW' });
    await seed(ctx, [FIRST, ...BANK.slice(1)]);
    const file = [
      ynabHeader,
      `"Checking","","${mdy(daysAgo(100))}","Starting Balance","Inflow: Ready to Assign","Inflow","Ready to Assign","",$0.00,$4000.00,"Reconciled"`,
      `"Checking","","${mdy(daysAgo(60))}","Reconciliation Balance Adjustment","Inflow: Ready to Assign","Inflow","Ready to Assign","Entered automatically by YNAB",$0.00,$1.25,"Reconciled"`,
      ynabRow(30, 'Corner Shop', 'Fun', 'Treats', '', 60),
    ].join('\n');
    const { preview, done } = await importReviewed(file, { ...linkedTo, options: { date_order: 'mdy' } });
    expect(preview.targets[0].left_out.opening).toBe(2);
    expect(preview.counts.opening).toBe(0);
    // No Starting balances category is made for rows that don't come in.
    expect(preview.categories.mappings.map((m: any) => m.name)).not.toContain('Starting balances');
    expect(done.status).toBe(200);
    const { flows } = await importedFlowsForBackfill(ctx, { items: await getItems(ctx), walked: new Map([['acc_chk', 'USD']]), since: daysAgo(730), today: daysAgo(0) });
    expect((flows as any[]).map((f) => f.amount).sort()).toEqual([60]);
  });

  test('a file read in another currency than the linked account’s bank keeps it in is refused, never doubled', async () => {
    await seed();
    const file = [ynabHeader, ynabRow(55, 'Landlord', 'Bills', 'Rent', '', 1850)].join('\n');
    const answers = { ...linkedTo, options: { date_order: 'mdy' }, currency: 'EUR' };
    const p = await preview(file, answers);
    expect(p.body.preview.blocks.join(' ')).toContain('Chase keeps Checking in USD');
    const refused = await post({ action: 'import', review: p.body.preview.review, migration_id: `app-import:${crypto.randomUUID()}`, ...answers }, file);
    expect(refused.status).toBe(409);
    expect(await importedTxnStore.get(ctx, 'acc_chk')).toBeNull();
  });

  test('the bank’s rows keep their own categories when the person says so', async () => {
    await seed();
    const file = [ynabHeader, ynabRow(55, 'Landlord', 'Bills', 'Rent', 'September', 1850)].join('\n');
    const { preview, done } = await importReviewed(file, { ...linkedTo, options: { date_order: 'mdy' }, carry: false });
    expect(preview.carry).toBe(false);
    expect(done.status).toBe(200);
    const rent = ((await activity()).transactions as any[]).find((t) => t.transaction_id === 'b_rent');
    expect(rent.category_name).toBe('rent and utilities');
    expect(rent.note ?? null).toBeNull();
  });

  test('a linked account that ended is said: the rows the file adds from its end count in nothing', async () => {
    await seed();
    const { lifecycleStore } = await import('@/lib/lifecycle');
    await lifecycleStore.set(ctx, 'acc_chk', {
      lifecycle: { state: 'closed', on: daysAgo(10) },
      type: 'depository',
      label: { name: 'Checking', institution: 'Chase', mask: '1111' },
      item_id: 'item_chase',
      set_at: new Date().toISOString(),
    } as any);
    const file = [ynabHeader, ynabRow(30, 'Corner Shop', 'Fun', 'Treats', '', 60), ynabRow(5, 'Late Shop', 'Fun', 'Treats', '', 9)].join('\n');
    const p = await preview(file, { ...linkedTo, options: { date_order: 'mdy' } });
    expect(p.status).toBe(200);
    expect(p.body.preview.targets[0].ended).toEqual({ state: 'closed', day: daysAgo(10), rows: 1 });
  });

  test('undone after a re-link, the rows a later import made under the account’s new id relied on stay with it', async () => {
    await seed(ctx, [bankTxn('b_first', 'acc_chk', 60, 10, { name: 'FIRST ROW' })]);
    const { done, migration_id } = await importReviewed([ynabHeader, ynabRow(400, 'Old Store', 'Fun', 'Shopping', '', 100)].join('\n'), { ...linkedTo, options: { date_order: 'mdy' } });
    expect(done.status).toBe(200);
    // The institution added back: a new connection, a new id for the account, linked to the old.
    await removeItem(ctx, 'item_chase');
    await fake.del(ctxKey('txns:item_chase'));
    await fake.hdel(ctxKey('accounts:meta'), 'item_chase');
    await saveItem(ctx, { item_id: 'item_chase2', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'access-sandbox-chase2') });
    await fake.hset(ctxKey('accounts:meta'), {
      item_chase2: await encrypt(ctx, JSON.stringify([{ account_id: 'acc_chk_new', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }])),
    });
    await fake.set(
      ctxKey('txns:item_chase2'),
      await encodeJsonBlob(ctx, {
        schema_version: 2,
        cursor: 'c1',
        accounts: { acc_chk_new: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } },
        txns: { n_first: bankTxn('n_first', 'acc_chk_new', 60, 10, { name: 'FIRST ROW' }) },
        synced_at: new Date().toISOString(),
      })
    );
    await linkAccounts(ctx, 'acc_chk', 'acc_chk_new', { basis: 'by_hand' });
    // The bank's own file of that period, into the new id: the app's row is found there.
    const form = (meta: object) => {
      const f = new FormData();
      f.set('file', new Blob([new TextEncoder().encode(['Date,Description,Amount', `${daysAgo(400)},Old Store,-100.00`, `${daysAgo(500)},Older Store,-7.00`].join('\n')) as Uint8Array<ArrayBuffer>]), 'bank.csv');
      f.set('meta', JSON.stringify({ file_name: 'bank.csv', account_id: 'acc_chk_new', options: { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } }, ...meta }));
      return new Request('http://localhost/api/history-import', { method: 'POST', body: f });
    };
    const hp = await asRes(await historyRoutes.POST(form({ action: 'preview' })));
    const hi = await asRes(await historyRoutes.POST(form({ action: 'import', review: hp.body.preview.review })));
    expect(hi.status).toBe(200);
    expect(hp.body.preview.counts).toMatchObject({ new: 1, present: 1 });
    // What Undo would take, said before: the row stays, for that import.
    const plan = await asRes(await routes.GET(new Request(`http://localhost/api/migration?undo=${migration_id}`)));
    expect(plan.body.undo.kept.map((k: any) => k.count)).toEqual([1]);
    const undone = await undo({ migration_id, confirm: true });
    expect(undone.body).toMatchObject({ removed: 0, kept: 1 });
    expect(((await activity()).transactions as any[]).filter((t) => t.name === 'Old Store').length).toBe(1);
  });
});

describe('undo keeps what is the person’s own since', () => {
  test('a made account with their own transactions, or changed by them; a tag, a category and a group with a budget they use', async () => {
    const accounts = newAccounts(['Checking', 'Savings', 'Visa', 'Brokerage']);
    const { done, migration_id } = await importReviewed(fixture('ynab-register.csv'), { accounts });
    expect(done.status).toBe(200);
    const made = await getManualAccounts(ctx);
    const checking = made.find((a) => a.name === 'Checking')!;
    const savings = made.find((a) => a.name === 'Savings')!;
    const visa = made.find((a) => a.name === 'Visa')!;
    // A transaction of their own in Checking; Savings' balance typed since.
    const { newManualTxnId } = await import('@/lib/manual-txn-input');
    await manualTxnStore.update(ctx, checking.account_id, (b) => {
      const { import_id: _i, source_key: _k, ...base } = b!.rows[0] as any;
      return { ...b!, rows: [...b!.rows, { ...base, id: newManualTxnId(), source: 'manual', source_id: null, name: 'Typed by hand' }] };
    });
    await saveManualAccount(ctx, { ...savings, balance: 12_345, updated_at: new Date(Date.now() + 1000).toISOString() });
    // A made tag on a transaction, a made category chosen for one, and a
    // budget on a made group whose categories nothing else uses.
    const set = (await readTagSet(ctx))!;
    const red = set.tags.find((t) => t.name === 'Red flag')!;
    await txnAnnotationStore.set(ctx, 'b_somewhere', { tags: [red.id], updated_at: new Date().toISOString() });
    await setOverride(ctx, 'b_somewhere', 'dining out');
    const t = (await readTaxonomy(ctx))!;
    const gifts = t.groups.find((g) => g.name === 'Gifts')!;
    await saveBudgets(ctx, { ...(await loadBudgets(ctx)).budgets, groups: { [gifts.id]: { amount: 50 } } }, t);
    const undone = await undo({ migration_id, confirm: true });
    expect(undone.status).toBe(200);
    expect(undone.body.accounts.kept).toEqual(expect.arrayContaining([{ name: 'Checking', why: 'transactions' }, { name: 'Savings', why: 'changed' }]));
    expect(undone.body.accounts.removed).toContain('Visa');
    expect((await getManualAccounts(ctx)).map((a) => a.name).sort()).toEqual(['Checking', 'Savings']);
    expect((await readTagSet(ctx))!.tags.map((x) => x.name)).toEqual(['Red flag']);
    const after = (await readTaxonomy(ctx))!;
    expect(after.categories.map((c) => c.name)).toContain('Dining Out');
    expect(after.categories.map((c) => c.name)).not.toContain('Groceries');
    expect(after.groups.map((g) => g.name)).toContain('Gifts');
    expect(visa).toBeDefined();
  });

  test('a made group with a past month’s budget stays', async () => {
    const { done, migration_id } = await importReviewed(fixture('ynab-register.csv'), { accounts: newAccounts(['Checking', 'Savings', 'Visa', 'Brokerage']) });
    expect(done.status).toBe(200);
    const t = (await readTaxonomy(ctx))!;
    const gifts = t.groups.find((g) => g.name === 'Gifts')!;
    await budgetMonthsStore.set(ctx, { version: 1, since: daysAgo(90).slice(0, 7), categories: {}, groups: { [gifts.id]: { seen: 50 } } });
    expect((await undo({ migration_id, confirm: true })).status).toBe(200);
    expect((await readTaxonomy(ctx))!.groups.map((g) => g.name)).toContain('Gifts');
  });

  test('what Undo would take is said first: rows changed since go too', async () => {
    const { done, migration_id } = await importReviewed(fixture('actual-export.csv'), { accounts: newAccounts(['Checking', 'Savings']) });
    expect(done.status).toBe(200);
    const [id, book] = [...(await manualTxnStore.getAll(ctx))][0];
    await manualTxnStore.update(ctx, id, (b) => ({ ...b!, rows: b!.rows.map((r, i) => (i === 0 ? { ...r, note: 'mine now', updated_at: new Date(Date.now() + 1000).toISOString() } : r)) }));
    const plan = await asRes(await routes.GET(new Request(`http://localhost/api/migration?undo=${migration_id}`)));
    expect(plan.status).toBe(200);
    expect(plan.body.undo.edited).toBe(1);
    expect(plan.body.undo.remove).toBeGreaterThanOrEqual(book.rows.length);
  });
});

describe('a linked account’s answers', () => {
  test('go with the import, not one request each: the review they were given after is still the one the person saw', async () => {
    await seed();
    const file = [
      '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"',
      `"Checking","","${mdy(daysAgo(50))}","Mystery Payee","Bills: Rent","Bills","Rent","",$1850.00,$0.00,"Cleared"`,
    ].join('\n');
    const answers = { accounts: { Checking: { to: 'linked', id: 'acc_chk' } }, options: { date_order: 'mdy' } };
    const p = await preview(file, answers);
    expect(p.body.preview.waiting.proposals).toBe(1);
    // Answered in the sheet, sent only with the import.
    const done = await post({ action: 'import', review: p.body.preview.review, migration_id: `app-import:${crypto.randomUUID()}`, ...answers, choices: { 'linked:acc_chk': { proposals: { each: { '2': 'new' } } } } }, file);
    expect(done.status).toBe(200);
    expect(((await activity()).transactions as any[]).filter((t) => t.amount === 1850).length).toBe(2);
  });
});

describe('the download of my data', () => {
  test('holds everything an import from another app wrote, with nothing added to it for it', async () => {
    const { collectUserData, buildUserExport, exportFile } = await import('@/lib/user-export');
    await seed();
    // YNAB's Checking into the linked account, the rest into new manual ones.
    const lines = readFileSync(join(FIXTURES, 'ynab-register.csv'), 'utf8');
    const { done, migration_id } = await importReviewed(lines, {
      accounts: { ...newAccounts(['Savings', 'Visa', 'Brokerage']), Checking: { to: 'linked', id: 'acc_chk' } },
    });
    expect(done.status).toBe(200);
    const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date()) as any;
    // The import's own record, each account's import with its raw records, the rows.
    expect(doc['app-imports'].map((e: any) => e.id)).toEqual([migration_id]);
    expect(doc['app-imports'][0].value.app).toBe('ynab');
    expect(doc.imports.length).toBe(3);
    expect(doc['history-imports'].length).toBe(1);
    expect(doc['imported-transactions'][0].value.rows.length).toBeGreaterThan(0);
    expect(doc['manual-transactions'].flatMap((b: any) => b.value.rows).some((r: any) => r.name === 'Costco')).toBe(true);
    // What was said beside them: tags, the split, the categories and tags made.
    const tagged = doc['transaction-annotations'].filter((a: any) => a.value.tags?.length);
    expect(tagged.length).toBeGreaterThan(0);
    expect(doc['transaction-splits'].length).toBe(1);
    expect(doc.categories.categories.map((c: any) => c.name)).toContain('Groceries');
    expect(doc.tags.tags.map((t: any) => t.name).sort()).toEqual(['Blue flag', 'Red flag']);
    expect(doc.manual_accounts.map((a: any) => a.name).sort()).toEqual(['Brokerage', 'Savings', 'Visa']);
    // The transactions CSV files the rows as the app does, a split's parts among them.
    const body = [...exportFile(doc, 'transactions-csv').pieces()].join('');
    expect(body).toContain('Costco');
    expect(body).toContain('Groceries');
    expect(body).toContain('Blue flag');
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

describe('limits and records', () => {
  test('more of the app’s categories than one import maps are refused in the review, quickly', async () => {
    const rows = Array.from({ length: 1001 }, (_, k) => `Checking,2026-09-01,Shop ${k},,Group ${k},Category ${k},-1.00,0,Cleared`);
    const file = ['Account,Date,Payee,Notes,Category_Group,Category,Amount,Split_Amount,Cleared', ...rows].join('\n');
    const p = await preview(file, { accounts: newAccounts(['Checking']) });
    expect(p.status).toBe(200);
    expect(p.body.preview.blocks.join(' ')).toContain('more than one import maps (1,000)');
    expect(p.body.preview.categories.mappings).toEqual([]);
  });

  test('a tag cut to what Nya keeps never splits a character in two', async () => {
    const name = `${'x'.repeat(39)}\u{1F600}`;
    const file = ['Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags', `2026-09-01,Shop,Groceries,Checking,SHOP,,-5.00,${name}`].join('\n');
    const { done } = await importReviewed(file, { accounts: newAccounts(['Checking']) });
    expect(done.status).toBe(200);
    const [tag] = (await readTagSet(ctx))!.tags;
    expect(tag.name).toBe('x'.repeat(39));
  });

  test('an account’s import given ids that don’t name every row is refused: its record would name other rows', async () => {
    const { commitImport } = await import('@/lib/import/commit');
    const read = readAppFile(['Date,Merchant,Category,Account,Original Statement,Notes,Amount,Tags', '2026-09-01,Shop,Groceries,Checking,SHOP,,-5.00,'].join('\n'), { options: {}, thisYear: 2026 });
    if (read.status !== 'ready') throw new Error(read.status);
    const state = await readTargets(ctx, { manualIds: [], linkedIds: [], withTags: false, today: daysAgo(0) });
    const plan = planMigration(read, { accounts: newAccounts(['Checking']) as any, categories: {}, tags: false, carry: true, currency: null, choices: {} }, state);
    const t = plan.targets[0];
    const account = { ...t.create!, account_id: 'manual_00000000-0000-4000-8000-000000000009', updated_at: new Date().toISOString() };
    await expect(
      commitImport(ctx, { account, format: 'csv', file_name: 'x.csv', file_bytes: 1, encoding: 'utf-8', rows: t.rows, problems: [], read: {}, statement: null, columns: null, ids: { import_id: 'import:00000000-0000-4000-8000-000000000001', rows: [] } } as any)
    ).rejects.toThrow('an id for every row');
  });

  test('an import record a later release wrote more into is listed, never undone without what it added', async () => {
    const { done, migration_id } = await importReviewed(fixture('actual-export.csv'), { accounts: newAccounts(['Checking', 'Savings']) });
    expect(done.status).toBe(200);
    const entry = (await migrationStore.get(ctx, migration_id))!;
    // As a later release would write it: one more kind of thing it made.
    const later = { ...entry, made: { ...entry.made, rules: ['rule-1'] } };
    await fake.hset(ctxKey('app-imports'), { [migration_id]: await encrypt(ctx, JSON.stringify(later)) });
    const listed = await quietly(() => list());
    expect(listed.body.imports.find((i: any) => i.id === migration_id)?.record).toBe('unrecognised');
    const refused = await quietly(() => undo({ migration_id, confirm: true }));
    expect(refused.status).toBe(409);
    expect((await getManualAccounts(ctx)).length).toBe(2);
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
