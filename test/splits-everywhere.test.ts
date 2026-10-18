import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// Splits and groups (#39) everywhere transactions are read, from one
// container with a bit of everything (test/api-fixture.ts): the read-only API
// lists each transaction once, with its parts and its group beside it, while
// spending, budgets, categories, tags, rules and recurring bills count as the
// app does; the transactions CSV can't count anything twice; an OFX statement
// lists each transaction whole with its parts in the memo; and a report counts
// the parts and the nets, and lists a part as a part.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, daysAgo, seedPerson } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { forgetEpochs } = await import('@/lib/sessions');
const { ensureTaxonomy } = await import('@/lib/category-store');
const { splitStore } = await import('@/lib/splits');
const { groupStore } = await import('@/lib/groups');
const { setExcluded, changeTags } = await import('@/lib/txn-annotations');
const { ensureTag } = await import('@/lib/tags');
const { collectUserData, buildUserExport, exportFile, TRANSACTION_COLUMNS } = await import('@/lib/user-export');
const { ofxFile } = await import('@/lib/ofx-export');
const { readReport } = await import('@/lib/report/read');
const { reportSettingsStore } = await import('@/lib/report/store');
const { readActivity } = await import('@/lib/api-read');
const { summarize } = await import('@/lib/totals');
const { caveatLines, problemLines } = await import('@/lib/report/words');

const WALLET_ROW = 'manual-txn:5a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const NOW_ISO = new Date().toISOString();
let token = '';
let cat: (name: string) => string;

const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  await seedPerson(fake);
  token = (await createToken(ctx, 'Tests')).token;
  const taxonomy = await ensureTaxonomy(ctx);
  cat = (name) => taxonomy.categories.find((c) => c.name === name)!.id;
});
afterEach(() => {
  process.env = { ...saved };
});

/** The card's 80 split into food and a shelf; each month's Netflix split in
 *  two; and the coffee and the farmers market grouped as one brunch. */
async function splitAndGroup() {
  await splitStore.set(ctx, 't_card', {
    version: 1,
    amount: 80,
    currency: 'USD',
    parts: [
      { id: 'p-food', amount: 50, category_id: cat('food and drink'), note: 'SECRET-PART-NOTE' },
      { id: 'p-home', amount: 30, category_id: cat('home improvement') },
    ],
    updated_at: NOW_ISO,
  });
  for (const i of [0, 1, 2]) {
    await splitStore.set(ctx, `t_flix${i}`, {
      version: 1,
      amount: 15.99,
      currency: 'USD',
      parts: [
        { id: `f${i}a`, amount: 10, category_id: cat('entertainment') },
        { id: `f${i}b`, amount: 5.99, category_id: cat('general merchandise') },
      ],
      updated_at: NOW_ISO,
    });
  }
  await groupStore.set(ctx, 'g-brunch', {
    version: 1,
    name: 'SECRET-GROUP-NAME brunch',
    category_id: cat('food and drink'),
    members: ['t_coffee', WALLET_ROW],
    date: daysAgo(2),
    currency: 'USD',
    created_at: NOW_ISO,
    updated_at: NOW_ISO,
  });
}

const call = async (name: string, query = '') => {
  const route = await import(`@/app/api/v1/${name}/route`);
  const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${name}${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${token}` } }));
  expect([name, res.status]).toEqual([name, 200]);
  return (await res.json()) as any;
};
const FROM = `from=${daysAgo(120)}&to=${daysAgo(0)}`;

describe('the read-only API', () => {
  test('lists each transaction once, whole, with its parts and its group beside it', async () => {
    await splitAndGroup();
    const page = await call('transactions', `${FROM}&limit=500`);
    const ids = page.transactions.map((t: any) => t.id);
    expect(ids.filter((id: string) => id.startsWith('split') || id.startsWith('group:'))).toEqual([]);
    expect(ids.filter((id: string) => id === 't_card')).toHaveLength(1);
    const card = page.transactions.find((t: any) => t.id === 't_card');
    expect(card).toMatchObject({ amount: 80, category: 'general merchandise', transaction_group: null });
    expect(card.splits).toEqual([
      { id: 'p-food', amount: 50, category: 'food and drink', category_id: cat('food and drink'), group_id: expect.any(String), group: 'Food', note: 'SECRET-PART-NOTE', excluded: false, remainder: false },
      { id: 'p-home', amount: 30, category: 'home improvement', category_id: cat('home improvement'), group_id: expect.any(String), group: 'Housing', note: null, excluded: false, remainder: false },
    ]);
    const group = { id: 'g-brunch', name: 'SECRET-GROUP-NAME brunch', date: daysAgo(2), net: 30.5, currency: 'USD', category: 'food and drink', transactions: 2, missing: 0 };
    expect(page.transactions.find((t: any) => t.id === 't_coffee')).toMatchObject({ amount: 5.5, splits: null, transaction_group: group });
    expect(page.transactions.find((t: any) => t.id === WALLET_ROW)).toMatchObject({ amount: 25, transaction_group: group });
    expect(page.transactions.find((t: any) => t.id === 't_rent')).toMatchObject({ splits: null, transaction_group: null });
    // A category finds a split transaction by its parts, and one in a group by the group's.
    expect((await call('transactions', `${FROM}&category=home%20improvement`)).transactions.map((t: any) => t.id)).toEqual(['t_card']);
    expect((await call('transactions', `${FROM}&q=secret-part`)).transactions.map((t: any) => t.id)).toEqual(['t_card']);
  });

  test('spending, budgets and categories count the parts and the net; money out stays the same', async () => {
    const before = await call('spending', FROM);
    await splitAndGroup();
    const after = await call('spending', FROM);
    expect(after.money_out).toBe(before.money_out);
    expect(after.money_in).toBe(before.money_in);
    const by = (s: any) => Object.fromEntries(s.categories.map((c: any) => [c.category, c.spent]));
    expect(by(after)['home improvement']).toBe(30);
    expect(by(after)['food and drink']).toBe(by(before)['food and drink'] + 50);
    expect(by(after)['general merchandise']).toBe(by(before)['general merchandise'] - 80 + 5.99 * 3);
    const categories = await call('categories');
    expect(categories.categories.find((c: any) => c.name === 'home improvement')).toMatchObject({ transactions: 1 });
  });

  test('tags and rules count each transaction once, its parts carrying its tags', async () => {
    await splitAndGroup();
    const work = (await ensureTag(ctx, { name: 'Work' })).tag;
    await changeTags(ctx, 't_card', { add: [work.id] });
    expect((await call('tags')).tags.find((t: any) => t.name === 'Work')).toMatchObject({ transactions: 1 });
  });

  test('recurring bills: a subscription split each month is still one, at its whole price', async () => {
    const before = (await call('recurring')).bills;
    await splitAndGroup();
    const after = (await call('recurring')).bills;
    expect(after).toEqual(before);
    expect(after.find((b: any) => b.name === 'Netflix')).toMatchObject({ amount: 15.99 });
  });

  test('the counts beside the totals count transactions as they did before any split: a split one is one, a group as many as it holds', async () => {
    await setExcluded(ctx, 't_card', true);
    const month = daysAgo(8).slice(0, 7);
    const counts = (s: any) => ({ transactions: s.transactions, counted: s.counted, excluded: s.excluded, transfers: s.transfers, exclusion_unknown: s.exclusion_unknown });
    const before = { spending: await call('spending', FROM), budgets: await call('budgets', `month=${month}`), categories: await call('categories') };
    await splitAndGroup();
    const after = { spending: await call('spending', FROM), budgets: await call('budgets', `month=${month}`), categories: await call('categories') };
    expect(counts(after.spending)).toEqual(counts(before.spending));
    expect(after.budgets.excluded).toBe(before.budgets.excluded);
    expect(after.budgets.excluded).toBeGreaterThan(0);
    // Each Netflix month, split in two, is one transaction in each of its categories.
    const inCategory = (r: any, name: string) => r.categories.categories.find((c: any) => c.name === name)?.transactions;
    expect(inCategory(after, 'entertainment')).toBe(inCategory(before, 'entertainment'));
    expect(after.spending.categories.find((c: any) => c.category === 'entertainment').transactions).toBe(
      before.spending.categories.find((c: any) => c.category === 'entertainment').transactions
    );
    const groupOf = (r: any, name: string) => r.spending.groups.find((g: any) => g.name === name)?.transactions;
    expect(groupOf(after, 'Travel and entertainment')).toBe(groupOf(before, 'Travel and entertainment'));
    expect([inCategory(after, 'entertainment'), groupOf(after, 'Travel and entertainment')]).toEqual([3, 3]);
  });

  test('a transaction of a group dated before the window read is listed, its group beside it with no net, and counted nowhere in the window', async () => {
    const before = await call('spending', FROM);
    await groupStore.set(ctx, 'g-old', {
      version: 1,
      name: 'Last year’s trip',
      category_id: cat('travel'),
      members: ['t_long_gone', 't_coffee'],
      date: daysAgo(400),
      currency: 'USD',
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    });
    const coffee = (await call('transactions', `${FROM}&limit=500`)).transactions.find((t: any) => t.id === 't_coffee');
    expect(coffee).toMatchObject({ amount: 5.5, transaction_group: { id: 'g-old', name: 'Last year’s trip', date: daysAgo(400), net: null, category: 'travel', transactions: 1, missing: 1 } });
    const after = await call('spending', FROM);
    expect(after.money_out).toBeCloseTo(before.money_out - 5.5, 8);
    expect(after.transactions).toBe(before.transactions);
    expect(after.counted).toBe(before.counted - 1);
  });

  test('a part left out on its own, or the whole transaction excluded, as the app counts it', async () => {
    await splitAndGroup();
    await setExcluded(ctx, 't_card', true);
    const card = (await call('transactions', `${FROM}&limit=500`)).transactions.find((t: any) => t.id === 't_card');
    expect(card.excluded).toBe(true);
    expect(card.splits.map((p: any) => p.excluded)).toEqual([true, true]);
  });
});

/** The download, as the route makes it. */
async function download() {
  const data = await collectUserData({ ctx, userId: null });
  return { data, doc: buildUserExport(data, new Date()) };
}
const csvRows = async () => {
  const { doc } = await download();
  const [header, ...rows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
  expect(header).toEqual([...TRANSACTION_COLUMNS]);
  const col = (r: string[], name: (typeof TRANSACTION_COLUMNS)[number]) => r[header.indexOf(name)];
  return { rows, col };
};
const units = (s: string) => (s === '' ? 0 : Math.round(Number(s) * 100));

describe('the download', () => {
  test('both stores are in the JSON file', async () => {
    await splitAndGroup();
    const { doc } = await download();
    expect((doc['transaction-splits'] as any[]).map((e) => e.id)).toEqual(['t_card', 't_flix0', 't_flix1', 't_flix2']);
    expect((doc['transaction-groups'] as any[]).map((e) => [e.id, e.value.members])).toEqual([['g-brunch', ['t_coffee', WALLET_ROW]]]);
  });

  test('the transactions CSV lists each transaction once with its own amount, and its parts and a group’s net beside them, so neither column counts twice', async () => {
    await splitAndGroup();
    const { rows, col } = await csvRows();
    const byId = new Map(rows.map((r) => [col(r, 'transaction_id'), r]));
    const card = byId.get('t_card')!;
    expect([col(card, 'amount'), col(card, 'nya_amount'), col(card, 'split_of')]).toEqual(['80', '', '']);
    const parts = rows.filter((r) => col(r, 'split_of') === 't_card');
    expect(parts.map((r) => [col(r, 'transaction_id'), col(r, 'amount'), col(r, 'nya_amount'), col(r, 'split_index'), col(r, 'nya_category'), col(r, 'note')])).toEqual([
      ['split:p-food', '', '50', '0', 'food and drink', 'SECRET-PART-NOTE'],
      ['split:p-home', '', '30', '1', 'home improvement', ''],
    ]);
    // The parts right after their transaction.
    const at = rows.indexOf(card);
    expect(rows.slice(at + 1, at + 3)).toEqual(parts);
    const group = byId.get('group:g-brunch')!;
    expect([col(group, 'amount'), col(group, 'nya_amount'), col(group, 'group_name'), col(group, 'nya_category'), col(group, 'date')]).toEqual([
      '',
      '30.5',
      'SECRET-GROUP-NAME brunch',
      'food and drink',
      daysAgo(2),
    ]);
    for (const id of ['t_coffee', WALLET_ROW]) {
      const m = byId.get(id)!;
      expect([col(m, 'nya_amount'), col(m, 'group_id')]).toEqual(['', 'g-brunch']);
      expect(col(m, 'amount')).not.toBe('');
    }
    // Every other row counts as itself.
    expect(col(byId.get('t_rent')!, 'nya_amount')).toBe('1200');
    // Neither column counts anything twice: added up, they agree. A pending
    // row its posted one replaced has no nya_amount, as the app lists none.
    const superseded = rows.filter((r) => col(r, 'superseded_by_posted') === 'true');
    expect(superseded.length).toBeGreaterThan(0);
    expect(superseded.map((r) => col(r, 'nya_amount'))).toEqual(superseded.map(() => ''));
    const counted = rows.filter((r) => col(r, 'superseded_by_posted') !== 'true');
    const amounts = counted.reduce((n, r) => n + units(col(r, 'amount')), 0);
    const nya = rows.reduce((n, r) => n + units(col(r, 'nya_amount')), 0);
    expect(nya).toBe(amounts);
    // And by category, nya_amount is the app's spread.
    const foodNya = counted.filter((r) => col(r, 'nya_category') === 'food and drink').reduce((n, r) => n + units(col(r, 'nya_amount')), 0);
    const foodAmount = counted.filter((r) => col(r, 'nya_category') === 'food and drink').reduce((n, r) => n + units(col(r, 'amount')), 0);
    expect(foodNya - foodAmount).toBe(5000 + 3050 - 550 - 2500);
  });

  test('a transaction whose amount the bank changed since its split has a row for the difference', async () => {
    await splitAndGroup();
    await splitStore.set(ctx, 't_card', { ...(await splitStore.get(ctx, 't_card'))!, amount: 70, parts: [{ id: 'p-food', amount: 40, category_id: cat('food and drink') }, { id: 'p-home', amount: 30, category_id: cat('home improvement') }] });
    const { rows, col } = await csvRows();
    const parts = rows.filter((r) => col(r, 'split_of') === 't_card');
    expect(parts.map((r) => [col(r, 'transaction_id'), col(r, 'nya_amount'), col(r, 'category'), col(r, 'nya_category')])).toEqual([
      ['split:p-food', '40', 'food and drink', 'food and drink'],
      ['split:p-home', '30', 'home improvement', 'home improvement'],
      // The difference is filed as the transaction is, its category the transaction's own.
      ['split-rest:t_card', '10', 'general merchandise', 'general merchandise'],
    ]);
  });

  test('an OFX statement lists the transaction once, whole, its parts in its memo; a group’s transaction names its group', async () => {
    await splitAndGroup();
    const { data, doc } = await download();
    const text = (account: string) => {
      const made = ofxFile(data, doc, account, new Date());
      if (!('file' in made)) throw new Error(made.refused);
      return [...made.file.pieces()].join('');
    };
    const card = text('acc_card');
    expect(card.match(/<FITID>t_card\r\n/g)).toHaveLength(1);
    expect(card).not.toContain('<FITID>split');
    expect(card).toContain('<TRNAMT>-80.00\r\n<FITID>t_card');
    expect(card).toContain('Split in Nya: Food and drink 50.00; Home improvement 30.00');
    const checking = text('acc_chk');
    expect(checking).toContain('In the group SECRET-GROUP-NAME brunch in Nya');
    expect(checking).not.toContain('<FITID>group:');
  });

  test('splits that can’t be read: the CSV shows those transactions whole, counted, and says so', async () => {
    await splitAndGroup();
    await fake.hset(`test:c:${ctx.container}:transaction-splits`, { t_card: 'not-ciphertext-but-long-enough-to-be-tried' });
    const { doc } = await download();
    const file = exportFile(doc, 'transactions-csv');
    expect(file.incomplete).toContain('transaction-splits');
    expect(file.notes.join(' ')).toContain('Those transactions are in this file whole');
    const [header, ...rows] = parseCsv([...file.pieces()].join(''));
    const card = rows.find((r) => r[header.indexOf('transaction_id')] === 't_card')!;
    expect(card[header.indexOf('nya_amount')]).toBe('80');
    expect(rows.some((r) => r[header.indexOf('split_of')] === 't_card')).toBe(false);
  });
});

describe('reports', () => {
  test('count the parts and the nets as the Activity tab does, and list a part as a part', async () => {
    await splitAndGroup();
    await reportSettingsStore.set(ctx, { v: 1, marked: ['home improvement', 'food and drink'] });
    const period = { kind: 'range' as const, start: daysAgo(30), end: daysAgo(0), through: daysAgo(0), today: daysAgo(0), time_zone: 'UTC' };
    const report = await readReport(ctx, period);
    const activity = await readActivity(ctx, false);
    const inPeriod = (d: string) => d >= period.start && d <= period.end;
    const app = summarize(activity.rows, inPeriod, report.currency);
    expect([report.totals.money_in, report.totals.money_out]).toEqual([app.money_in, app.money_out]);
    const rows = report.appendix!.rows;
    expect(rows.find((r) => r.category === 'home improvement')).toMatchObject({ name: 'T_CARD', account: 'Card', amount: 30, split: { part: 2, parts: 2, whole: 80, remainder: false } });
    expect(rows.find((r) => r.group)).toMatchObject({ name: 'SECRET-GROUP-NAME brunch', amount: 30.5, group: { transactions: 2, missing: 0 } });
    // Its counts are of transactions: the card's two parts, both marked, are one; the brunch is two.
    const lines = rows.length;
    const card = rows.filter((r) => r.name === 'T_CARD').length;
    expect(card).toBe(2);
    expect(report.appendix!.total).toBe(lines - card + 1 + 1);
    expect(report.appendix!.shown).toBe(report.appendix!.total);
    expect(report.totals.transactions).toBe(app.transactions);
  });

  test('a split that can’t be read is a caveat on the totals, never a gap: no transaction is missing, and no month is made uncertain', async () => {
    await splitAndGroup();
    const period = { kind: 'range' as const, start: daysAgo(30), end: daysAgo(0), through: daysAgo(0), today: daysAgo(0), time_zone: 'UTC' };
    const before = await readReport(ctx, period);
    expect(before.caveats.notes).toEqual([]);
    await fake.hset(`test:c:${ctx.container}:transaction-splits`, { t_card: 'not-ciphertext-but-long-enough-to-be-tried' });
    const [error, warn] = [console.error, console.warn];
    console.error = console.warn = () => {};
    const report = await readReport(ctx, period).finally(() => ([console.error, console.warn] = [error, warn]));
    // The fixture's own gaps (a connection never loaded, one not synced), and
    // nothing more: no gap of the split, and each month as it was.
    expect(report.gaps).toEqual(before.gaps);
    expect(report.gaps.some((g) => g.kind === 'unreadable')).toBe(false);
    expect(report.months.map((m) => [m.month, m.uncertain, m.gaps])).toEqual(before.months.map((m) => [m.month, m.uncertain, m.gaps]));
    expect(problemLines(report, (d) => d)).toEqual(problemLines(before, (d) => d));
    expect(report.caveats.notes).toHaveLength(1);
    expect(report.caveats.notes[0]).toContain('couldn’t be read');
    expect(caveatLines(report, (d) => d).at(-1)).toBe(`${report.caveats.notes[0].replace(/[.\s]+$/, '')}.`);
    // The transaction counts whole, as the Activity tab shows it.
    const activity = await readActivity(ctx, false);
    const app = summarize(activity.rows, (d) => d >= period.start && d <= period.end, report.currency);
    expect([report.totals.money_in, report.totals.money_out]).toEqual([app.money_in, app.money_out]);
  });
});
