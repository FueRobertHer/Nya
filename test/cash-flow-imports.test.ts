import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The cash flow (#41) over rows imported into a linked account from its
// bank's files (#52), as the assembly gives them to the Activity tab and the
// API (lib/activity.ts): held to the month's totals and the budgets'
// spending (lib/totals.ts summarize and spendingByCategory) to the cent, with
// a row the person said is the bank's own and one the bank sent later, each
// counted once, as the bank's; an imported deposit paid by the name the list
// shows; an imported purchase filed where the person filed it; a tap listing
// them; and what is said beside the chart, as the month's summary says it.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
        return async () => {
          throw new Error('Plaid must not be called here');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { setExcluded } = await import('@/lib/txn-annotations');
const { setRename } = await import('@/lib/renames');
const { assembleBankRows, finishActivity } = await import('@/lib/activity');
const { readSpending } = await import('@/lib/api-read');
const { readCashFlow } = await import('@/lib/api-cash-flow');
const { cashFlow, cashFlowNotes, dayText, inPeriod, lastDayOf, periodOf, pickedRows, PERIODS } = await import('@/lib/cash-flow');
const { summarize, spendingByCategory, tidy } = await import('@/lib/totals');
const { countTransactions, totalsCurrency } = await import('@/lib/spending');
const { bankRows } = await import('@/lib/split-rows');
const { filedId, indexTaxonomy, uncategorizedOf } = await import('@/lib/categories');
const { localDate } = await import('@/lib/local-date');
const { monthName } = await import('@/lib/rollover');
const { IMPORTED_TXN_PREFIX, importedRowsNote } = await import('@/lib/history-import/view');
const routes = await import('@/app/api/history-import/route');
const recategorize = await import('@/app/api/recategorize/route');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const compact = (d: string) => d.replace(/-/g, '');

function bankTxn(id: string, days: number, amount: number, over: Record<string, unknown> = {}) {
  return {
    transaction_id: id,
    pending_transaction_id: null,
    account_id: 'acc_chk',
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

// The bank's own: this month's pay and the rest of the last few weeks.
const BANK = [
  bankTxn('b_pay', 10, -3000, { name: 'ACME CORP', category: 'income' }),
  bankTxn('b_rent', 55, 1850, { name: 'ZELLE PAYMENT TO LANDLORD', category: 'rent and utilities' }),
  bankTxn('b_grocer', 3, 20, { name: 'GROCER', category: 'food and drink' }),
];

// The bank's files reach back most of a year: older pay from the same
// employer, a deposit, two purchases, and the rent the bank did send, which
// the person says is the same transaction.
const STATEMENT = (() => {
  const trns = [
    { fitid: 'F_old', days: 300, amount: -100, name: 'OLD STORE' },
    { fitid: 'F_pay', days: 230, amount: 2900, name: 'ACME CORP' },
    { fitid: 'F_dep', days: 200, amount: 500, name: 'OLD DEPOSIT' },
    { fitid: 'F_rent', days: 55, amount: -1850, name: 'Online Transfer to Landlord' },
    { fitid: 'F_mid', days: 50, amount: -60, name: 'CORNER SHOP' },
  ]
    .map((t) => `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${compact(daysAgo(t.days))}</DTPOSTED><TRNAMT>${t.amount.toFixed(2)}</TRNAMT><FITID>${t.fitid}</FITID><NAME>${t.name}</NAME></STMTTRN>`)
    .join('\n');
  return `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>325081403</BANKID><ACCTID>0009991111</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>${compact(daysAgo(310))}</DTSTART><DTEND>${compact(daysAgo(40))}</DTEND>\n${trns}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
})();

async function storeBank(rows: ReturnType<typeof bankTxn>[]) {
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob(ctx, {
      schema_version: 2,
      cursor: 'c1',
      accounts: { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } },
      txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])),
      synced_at: new Date().toISOString(),
    })
  );
}

async function seed() {
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'access-sandbox-chase') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await encrypt(ctx, JSON.stringify([{ account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }])),
  });
  await storeBank(BANK);
}

function upload(meta: Record<string, unknown>): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(STATEMENT) as Uint8Array<ArrayBuffer>]), 'statement.ofx');
  form.set('meta', JSON.stringify({ file_name: 'statement.ofx', ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
}

/** Reviews the statement, then imports it as reviewed: the rent is the bank's. */
async function importStatement() {
  const review = (await (await routes.POST(upload({ action: 'preview', account_id: 'acc_chk' }))).json()).preview.review;
  const res = await routes.POST(upload({ action: 'import', account_id: 'acc_chk', review }));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ imported: 4, duplicates: 1 });
}

/** The Activity tab's rows, as the app and the API assemble them. */
async function activity() {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true });
  const shown = await finishActivity(ctx, bank.payload, bank.hidden);
  return { rows: shown.transactions, notes: shown.notes, ix: indexTaxonomy(shown.taxonomy) };
}

const today = localDate();
const isImported = (t: { transaction_id: string }) => t.transaction_id.startsWith(IMPORTED_TXN_PREFIX);
const byName = <T extends { name: string }>(rows: readonly T[], name: string): T => rows.find((t) => t.name === name)!;
const day = (iso: string) => iso.slice(0, 10);
/** One month as a period of its own: the Activity tab's month. */
const monthPeriod = (m: string) => ({ key: 'this-month' as const, months: [m], from: `${m}-01`, to: lastDayOf(m) });

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  plaidTouched.length = 0;
  await registerTestContainer(fake);
  await seed();
});
afterEach(() => {
  expect(unscopedDataKeys(fake)).toEqual([]);
  expect(plaidTouched).toEqual([]);
});

/** The chart's flows over the rows are the totals' own, period by period
 *  and month by month: money in, out, the counts, and each category's
 *  spending, by the category each row is filed under. */
function expectTheTotals(rows: Awaited<ReturnType<typeof activity>>['rows'], ix: ReturnType<typeof indexTaxonomy>) {
  const currency = totalsCurrency(rows);
  const periods = [...PERIODS.map((p) => periodOf(p.key, today)), ...periodOf('last-12-months', today).months.map(monthPeriod)];
  for (const p of periods) {
    const inRange = inPeriod(p);
    const flow = cashFlow(rows, inRange, currency, ix);
    const s = summarize(rows, inRange, currency, (bucket) => ({ category: bucket, category_id: bucket, group_id: null, group: null }));
    expect([p.from, flow.money_in, flow.money_out, flow.transactions, flow.counted, flow.transfers, flow.excluded]).toEqual([p.from, s.money_in, s.money_out, s.transactions, s.counted, s.transfers, s.excluded]);
    const budgets = spendingByCategory(rows, inRange, currency, (t) => filedId(ix, t));
    expect([p.from, Object.fromEntries(flow.groups.flatMap((g) => g.categories.map((c) => [c.id, c.amount])))]).toEqual([
      p.from,
      Object.fromEntries(Object.entries(budgets).map(([id, v]) => [id, tidy(v)])),
    ]);
    // And each category's transactions, as the totals count them.
    expect([p.from, Object.fromEntries(flow.groups.flatMap((g) => g.categories.map((c) => [c.id, c.transactions])))]).toEqual([
      p.from,
      Object.fromEntries(s.categories.map((c) => [c.category, c.transactions])),
    ]);
    expect(tidy(flow.payers.reduce((a, x) => a + x.amount, 0))).toBe(flow.money_in);
  }
}

describe('the chart over imported rows: the totals’ own figures', () => {
  test('to the cent, over every period and every month, the imported rows in them', async () => {
    await importStatement();
    const { rows, ix } = await activity();
    expect(rows.filter(isImported).map((t) => t.name).sort()).toEqual(['ACME CORP', 'CORNER SHOP', 'OLD DEPOSIT', 'OLD STORE']);
    expectTheTotals(rows, ix);
    // The year's flow holds every one of them, once.
    const year = cashFlow(rows, inPeriod(periodOf('last-12-months', today)), 'USD', ix);
    const ids = [...year.payers.flatMap((p) => p.ids), ...year.groups.flatMap((g) => g.ids)];
    expect(ids.filter((id) => id.startsWith(IMPORTED_TXN_PREFIX)).length).toBe(4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the rent the person said is the bank’s is counted once, as the bank’s', async () => {
    await importStatement();
    const { rows, ix } = await activity();
    expect(rows.filter((t) => t.amount === 1850).map((t) => t.transaction_id)).toEqual(['b_rent']);
    const flow = cashFlow(rows, inPeriod(periodOf('last-12-months', today)), 'USD', ix);
    const rent = flow.groups.flatMap((g) => g.categories).find((c) => c.name === 'rent and utilities')!;
    expect([rent.amount, rent.ids]).toEqual([1850, ['b_rent']]);
  });
});

describe('an imported deposit, paid by the name the list shows', () => {
  test('the bank’s employer and the file’s are one payer by their name; a deposit is its own, under the name you give it', async () => {
    await importStatement();
    const { rows, ix } = await activity();
    const flow = cashFlow(rows, inPeriod(periodOf('last-12-months', today)), 'USD', ix);
    const acme = flow.payers.find((p) => p.key === 'acme corp')!;
    expect([acme.name, acme.amount, acme.transactions]).toEqual(['ACME CORP', 5900, 2]);
    expect(acme.ids.sort()).toEqual(['b_pay', byName(rows.filter(isImported), 'ACME CORP').transaction_id].sort());
    expect(flow.payers.find((p) => p.key === 'old deposit')).toMatchObject({ name: 'OLD DEPOSIT', amount: 500, transactions: 1, refund: false });

    // Renamed, as the Activity list shows it, it is paid under that name.
    await setRename(ctx, byName(rows, 'OLD DEPOSIT').vendor_key, 'Grandma');
    const again = await activity();
    const renamed = cashFlow(again.rows, inPeriod(periodOf('last-12-months', today)), 'USD', again.ix);
    expect(renamed.payers.find((p) => p.key === 'old deposit')).toBeUndefined();
    expect(renamed.payers.find((p) => p.key === 'grandma')).toMatchObject({ name: 'Grandma', amount: 500, ids: [byName(again.rows, 'Grandma').transaction_id] });
  });
});

describe('an imported purchase, filed where it is filed', () => {
  test('under the uncategorized category while its file says none, and under the one you choose for it', async () => {
    await importStatement();
    const before = await activity();
    const shop = byName(before.rows, 'CORNER SHOP');
    const flowOf = (a: Awaited<ReturnType<typeof activity>>) => cashFlow(a.rows, inPeriod(periodOf('last-12-months', today)), 'USD', a.ix);
    const holding = (a: Awaited<ReturnType<typeof activity>>, id: string) => flowOf(a).groups.flatMap((g) => g.categories).find((c) => c.ids.includes(id));
    expect(holding(before, shop.transaction_id)!.id).toBe(filedId(before.ix, shop));
    expect(holding(before, shop.transaction_id)!.id).toBe(uncategorizedOf(before.ix).id);

    const res = await recategorize.POST(new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id: shop.transaction_id, category: 'groceries' }) }));
    expect(res.status).toBe(200);
    const after = await activity();
    const filed = holding(after, shop.transaction_id)!;
    expect([filed.name, filed.amount, filed.id]).toEqual(['groceries', 60, filedId(after.ix, byName(after.rows, 'CORNER SHOP'))]);
    expectTheTotals(after.rows, after.ix);
  });
});

describe('a bank row that now stands for an imported one', () => {
  test('counts once, as the bank’s, with the category and the exclusion said of the imported row, and a tap lists it', async () => {
    await importStatement();
    const first = await activity();
    const shop = byName(first.rows, 'CORNER SHOP');
    await recategorize.POST(new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id: shop.transaction_id, category: 'groceries' }) }));
    const year = periodOf('last-12-months', today);
    const groceriesOf = (a: Awaited<ReturnType<typeof activity>>) => cashFlow(a.rows, inPeriod(year), 'USD', a.ix).groups.flatMap((g) => g.categories).find((c) => c.name === 'groceries');
    const tapped = (a: Awaited<ReturnType<typeof activity>>) => {
      const node = `category:${groceriesOf(a)!.id}`;
      return pickedRows(a.rows, { period: 'last-12-months', node, label: 'Groceries' }, { ix: a.ix, currency: 'USD', today }).map((t) => t.transaction_id);
    };
    const imported = await activity();
    expect(tapped(imported)).toEqual([shop.transaction_id]);

    // The bank sends the corner shop: its row stands for the imported one.
    await storeBank([...BANK, bankTxn('b_mid', 49, 60, { name: 'CORNER SHOP #12' })]);
    const sent = await activity();
    expect(sent.rows.some((t) => t.transaction_id === shop.transaction_id)).toBe(false);
    expect(sent.rows.filter((t) => t.amount === 60).map((t) => t.transaction_id)).toEqual(['b_mid']);
    // What the bank row stands for rides on it to the layers, and is never sent.
    expect(sent.rows.some((t) => 'stands_for' in t)).toBe(false);
    expect(groceriesOf(sent)).toMatchObject({ amount: 60, transactions: 1, ids: ['b_mid'] });
    expect(tapped(sent)).toEqual(['b_mid']);
    expectTheTotals(sent.rows, sent.ix);

    // Excluded on the imported row, the bank's is left out, once.
    const counted = cashFlow(sent.rows, inPeriod(year), 'USD', sent.ix);
    await setExcluded(ctx, shop.transaction_id, true);
    const excluded = await activity();
    const flow = cashFlow(excluded.rows, inPeriod(year), 'USD', excluded.ix);
    expect(excluded.rows.find((t) => t.transaction_id === 'b_mid')!.excluded).toBe(true);
    expect(groceriesOf(excluded)).toBeUndefined();
    expect([flow.money_out, flow.excluded, flow.counted]).toEqual([tidy(counted.money_out - 60), counted.excluded + 1, counted.counted - 1]);
    expectTheTotals(excluded.rows, excluded.ix);
  });
});

describe('what is said beside the chart', () => {
  test('how many of the period’s transactions were imported, as each month’s totals say it of the month', async () => {
    await importStatement();
    const { rows, ix } = await activity();
    const notes = (p: ReturnType<typeof periodOf> | ReturnType<typeof monthPeriod>) =>
      cashFlowNotes({ flow: cashFlow(rows, inPeriod(p), 'USD', ix), period: p, rows, today, day }).counted;
    expect(notes(periodOf('last-12-months', today))).toContain('4 of this period’s transactions were imported from your bank’s files, not sent by the bank.');
    // Each month, the month's own sentence (components/MonthBreakdown.tsx),
    // the month named.
    for (const m of periodOf('last-12-months', today).months) {
      const theirs = importedRowsNote(rows.filter((t) => t.date.slice(0, 7) === m));
      const ours = notes(monthPeriod(m)).find((n) => n.includes('imported from your bank’s files')) ?? null;
      expect([m, ours]).toEqual([m, theirs && theirs.replace('this month’s', `${monthName(m, today)}’s`)]);
    }
    // The bank sends the corner shop: one fewer is imported.
    await storeBank([...BANK, bankTxn('b_mid', 49, 60, { name: 'CORNER SHOP #12' })]);
    const sent = await activity();
    expect(cashFlowNotes({ flow: cashFlow(sent.rows, inPeriod(periodOf('last-12-months', today)), 'USD', sent.ix), period: periodOf('last-12-months', today), rows: sent.rows, today, day }).counted).toContain(
      '3 of this period’s transactions were imported from your bank’s files, not sent by the bank.'
    );
  });

  test('months only the files reach don’t begin late; where they stop, the history begins', async () => {
    const said = async () => {
      const { rows, ix } = await activity();
      return (key: 'last-3-months' | 'last-12-months') => {
        const p = periodOf(key, today);
        return cashFlowNotes({ flow: cashFlow(rows, inPeriod(p), 'USD', ix), period: p, rows, today, day }).gaps;
      };
    };
    const late = (d: string) => `The earliest transaction here is from ${dayText(d)}, so this period may be missing what came before it.`;
    const bankOnly = await said();
    expect(bankOnly('last-3-months')).toContain(late(daysAgo(55)));
    await importStatement();
    const withFiles = await said();
    expect(withFiles('last-3-months').join(' ')).not.toContain('The earliest transaction');
    expect(withFiles('last-12-months')).toContain(late(daysAgo(300)));
  });

  test('imported rows that can’t be read are named beside the chart, as in the list, and in the API’s notes', async () => {
    await importStatement();
    await fake.hset(ctxKey('imported-transactions'), { acc_chk: 'not ciphertext' });
    const { rows, notes, ix } = await activity();
    const named = "Chase: transactions imported for Checking couldn't be read";
    expect(notes).toContain(named);
    expect(rows.some(isImported)).toBe(false);
    const p = periodOf('last-12-months', today);
    expect(cashFlowNotes({ flow: cashFlow(rows, inPeriod(p), 'USD', ix), period: p, rows, read: notes, today, day }).gaps[0]).toBe(`${named}.`);
    expect((await readCashFlow(ctx, { from: daysAgo(364), to: daysAgo(0) })).notes).toContain(named);
  });
});

describe('the API’s cash flow over imported rows', () => {
  test('the same figures as spending, before and after the bank stands for one; its notes spending’s, and how many were imported, as the chart says it', async () => {
    await importStatement();
    const range = { from: daysAgo(364), to: daysAgo(0) };
    const imported = (n: number, of = 'this period') => `${n} of ${of}’s transactions ${n === 1 ? 'was' : 'were'} imported from your bank’s files, not sent by the bank.`;
    const same = async (count: number) => {
      const [f, s] = await Promise.all([readCashFlow(ctx, range), readSpending(ctx, range)]);
      expect([f.money_in, f.money_out, f.net, f.counted, f.transactions, f.excluded]).toEqual([s.money_in, s.money_out, s.net, s.counted, s.transactions, s.excluded]);
      const categories = f.groups.flatMap((g) => g.categories.map((c) => ({ category: c.name, category_id: c.id, group: g.name, group_id: g.id, spent: c.amount, transactions: c.transactions })));
      const sorted = [...categories].sort((a, b) => b.spent - a.spent || (a.category < b.category ? -1 : 1));
      expect(sorted).toEqual(s.categories as unknown as typeof sorted);
      expect(f.notes).toEqual([...s.notes, imported(count)]);
      return f;
    };
    const before = await same(4);
    expect(before.payers.find((p) => p.name === 'OLD DEPOSIT')).toEqual({ name: 'OLD DEPOSIT', amount: 500, transactions: 1, refund: false });
    expect(before.payers.find((p) => p.name === 'ACME CORP')).toMatchObject({ amount: 5900, transactions: 2 });
    // A month is named, as the chart names one; it holds the corner shop alone.
    const m = daysAgo(50).slice(0, 7);
    expect((await readCashFlow(ctx, { from: `${m}-01`, to: lastDayOf(m) })).notes).toContain(imported(1, monthName(m)));

    await storeBank([...BANK, bankTxn('b_mid', 49, 60, { name: 'CORNER SHOP #12' })]);
    const after = await same(3);
    expect([after.money_out, after.counted]).toEqual([before.money_out, before.counted]);
  });
});

describe('an imported row’s split (#39), carried to the bank row that comes to stand for it', () => {
  const route = async (path: string, method: string, body?: unknown) => {
    const mod: any = await import(`@/app/api/${path}/route`);
    const res: Response = await mod[method](new Request(`http://x/api/${path}`, { method, body: body ? JSON.stringify(body) : undefined }));
    return { status: res.status, body: (await res.json()) as any };
  };

  test('counts once, as the bank row’s parts, in the totals’ own figures; a tap lists the part in its node; the API agrees with spending', async () => {
    await importStatement();
    const categories = (await route('categories', 'GET')).body.categories;
    const catId = (name: string): string => categories.categories.find((c: { name: string }) => c.name === name).id;
    const shop = byName((await activity()).rows, 'CORNER SHOP');
    const res = await route('transaction-splits', 'PUT', {
      transaction_id: shop.transaction_id,
      parts: [
        { amount: 45, category_id: catId('food and drink') },
        { amount: 15, category_id: catId('home improvement') },
      ],
    });
    expect(res.status).toBe(200);
    const split = await activity();
    expect(split.rows.filter((t) => t.split_of === shop.transaction_id).map((t) => t.amount)).toEqual([45, 15]);
    expectTheTotals(split.rows, split.ix);

    // The bank sends the corner shop: its row is answered as the imported
    // row's parts, which name the imported row, where the split is kept.
    await storeBank([...BANK, bankTxn('b_mid', 49, 60, { name: 'CORNER SHOP #12' })]);
    const sent = await activity();
    const parts = sent.rows.filter((t) => t.split_of === 'b_mid');
    expect(parts.map((p) => [p.amount, p.split_carried_from])).toEqual([
      [45, shop.transaction_id],
      [15, shop.transaction_id],
    ]);
    expect(sent.rows.some((t) => t.transaction_id === shop.transaction_id || t.split_of === shop.transaction_id || t.transaction_id === 'b_mid')).toBe(false);
    expectTheTotals(sent.rows, sent.ix);
    const year = periodOf('last-12-months', today);
    const flow = cashFlow(sent.rows, inPeriod(year), 'USD', sent.ix);
    const home = flow.groups.flatMap((g) => g.categories).find((c) => c.name === 'home improvement')!;
    expect([home.amount, home.transactions, home.ids]).toEqual([15, 1, [parts[1].transaction_id]]);
    // Out: the rent, the grocer, the corner shop once (two parts) and the old
    // store. In: the pay, the old pay and the deposit.
    expect([flow.money_out_transactions, flow.money_in_transactions]).toEqual([4, 3]);
    // A tap on its category lists the bank row whole, the part in it under it.
    const listed = pickedRows(sent.rows, { period: 'last-12-months', node: `category:${home.id}`, label: '' }, { ix: sent.ix, currency: 'USD', today });
    expect(bankRows(listed).map((t) => [t.transaction_id, t.amount, t.split_parts?.map((p) => p.amount)])).toEqual([['b_mid', 60, [15]]]);
    expect(countTransactions(listed)).toBe(1);
    // The bank's row isn't imported: three of the year's transactions are.
    expect(cashFlowNotes({ flow, period: year, rows: sent.rows, today, day }).counted).toContain('3 of this period’s transactions were imported from your bank’s files, not sent by the bank.');

    const range = { from: daysAgo(364), to: daysAgo(0) };
    const [f, s] = await Promise.all([readCashFlow(ctx, range), readSpending(ctx, range)]);
    expect([f.money_in, f.money_out, f.transactions, f.counted]).toEqual([s.money_in, s.money_out, s.transactions, s.counted]);
    const flat = f.groups.flatMap((g) => g.categories.map((c) => ({ category: c.name, category_id: c.id, group: g.name, group_id: g.id, spent: c.amount, transactions: c.transactions })));
    const sorted = [...flat].sort((a, b) => b.spent - a.spent || (a.category < b.category ? -1 : 1));
    expect(sorted).toEqual(s.categories as unknown as typeof sorted);
    const groups = f.groups.map((g) => ({ id: g.id, name: g.name, kind: g.kind, spent: g.amount, transactions: g.transactions }));
    expect(groups).toEqual(s.groups as unknown as typeof groups);
  });
});
