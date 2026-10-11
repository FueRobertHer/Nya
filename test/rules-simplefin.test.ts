import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount, type FakeTxn } from './simplefin-fake';
import { parseCsv } from './csv-parse';

// Rules, tags and notes (#36, #40) on the rows SimpleFIN brings: rules rename,
// tag, hide and file them, matched by their source and their bank as the app
// names it, alike in the app, the read-only API, the transactions CSV and an
// OFX statement; a pair Nya works out between two SimpleFIN accounts keeps
// its pair's category, so a rule never makes half a transfer count; a note on
// one is kept beside it, the row staying as the bank gave it; and reports and
// a category's usage count what rules do to them.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// The real ceiling on a stored value: a file run before this one may have
// lowered it for its own tests (lib/blob.ts reads it on every write).
delete process.env.MAX_TXN_BLOB_CHARS;

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

const { setTransportForTests } = await import('@/lib/connectors/http');
const { connect, trackAccounts } = await import('@/lib/connectors/manage');
const { connectorAccountsStore } = await import('@/lib/connectors/store');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { forgetEpochs } = await import('@/lib/sessions');
const { createToken } = await import('@/lib/api-tokens');
const { ensureTaxonomy } = await import('@/lib/category-store');
const { indexTaxonomy } = await import('@/lib/categories');
const { addRule, changeRules, newRuleId } = await import('@/lib/rules');
const { ensureTag, readTagSet } = await import('@/lib/tags');
const { countsInTotals } = await import('@/lib/spending');
const { collectUserData, buildUserExport, exportFile } = await import('@/lib/user-export');
const { ofxFile } = await import('@/lib/ofx-export');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const transactionsRoute = await import('@/app/api/transactions/route');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const NOW = Date.now();
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ago = (n: number) => Math.floor(Date.parse(`${dayOf(NOW - n * DAY)}T12:00:00Z`) / 1000);
const txn = (id: string, daysAgo: number, amount: string, description: string): FakeTxn => ({ id, posted: ago(daysAgo), amount, description });

let server: FakeSimplefin;
beforeAll(async () => {
  server = await FakeSimplefin.start();
});
afterAll(() => {
  setTransportForTests(null);
  server.stop();
});
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  server.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  setTransportForTests(server.transport());
});
afterEach(() => {
  process.env = { ...saved };
});

/** Checking and a card at My Bank through SimpleFIN: the card paid from
 *  checking (a pair), a coffee and a dinner, and pay. */
async function trackBoth(): Promise<void> {
  server.accounts = [
    fakeAccount({
      id: 'CHK',
      name: 'Checking',
      balance: '5000.00',
      'balance-date': ago(1),
      transactions: [txn('coffee', 2, '-12.50', 'COFFEE'), txn('pay', 3, '-300.00', 'PAYMENT TO VISA'), txn('payroll', 10, '2500.00', 'PAYROLL')],
    }),
    fakeAccount({ id: 'CARD', name: 'Visa', balance: '-300.00', 'balance-date': ago(1), transactions: [txn('thanks', 2, '300.00', 'PAYMENT THANK YOU'), txn('dinner', 2, '-45.67', 'DINER')] }),
  ];
  const { connection_id } = await connect(ctx, 'simplefin', server.setupToken(`t${Math.random()}`), NOW);
  await trackAccounts(
    ctx,
    connection_id,
    [
      { remote_id: 'CHK', type: 'depository' },
      { remote_id: 'CARD', type: 'credit' },
    ],
    NOW
  );
}

const idOf = async (name: string) => [...(await connectorAccountsStore.getAll(ctx)).values()].find((a) => a.name === name)!.account_id;
const rowId = async (account: string, name: string) => (await manualTxnStore.get(ctx, await idOf(account)))!.rows.find((r) => r.name === name)!.id;

/** A rule made as the app makes it, the categories stored first. */
async function rule(input: unknown): Promise<string> {
  const ix = indexTaxonomy(await ensureTaxonomy(ctx));
  const tags = await readTagSet(ctx);
  let id = '';
  await changeRules(ctx, (s) => {
    const made = addRule(s, input, { ix, tags }, newRuleId);
    id = made.rule.id;
    return made.set;
  });
  return id;
}
const catId = async (name: string) => (await ensureTaxonomy(ctx)).categories.find((c) => c.name === name)!.id;

/** The Activity tab's rows. */
async function activity(): Promise<any[]> {
  const res = await transactionsRoute.GET(new Request('http://localhost/api/transactions'));
  expect(res.status).toBe(200);
  return (await res.json()).transactions;
}
const named = (rows: any[], name: string) => rows.find((t) => t.name === name || t.name_before_rules === name);

/** The read-only API's answer at an endpoint. */
async function api(name: string, query = ''): Promise<any> {
  const token = (await createToken(ctx, 'Tests')).token;
  const route = await import(`@/app/api/v1/${name}/route`);
  const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${name}${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${token}` } }));
  expect(res.status).toBe(200);
  return res.json();
}
const apiRows = async (): Promise<any[]> => (await api('transactions', 'from=2000-01-01')).transactions;

/** An MCP tool's structured answer. */
async function tool(name: string, args: unknown): Promise<any> {
  const token = (await createToken(ctx, 'Tests')).token;
  const mcp = await import('@/app/api/mcp/route');
  const res: Response = await mcp.POST(
    new Request('https://nya.test/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
  );
  return (await res.json()).result.structuredContent;
}

/** The download: its document, its transactions CSV by id, and an account's OFX statement's text. */
async function download() {
  const data = await collectUserData({ ctx, userId: null });
  const doc = buildUserExport(data, new Date(NOW));
  const [header, ...rows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
  const csv = (id: string) => {
    const r = rows.find((x) => x[header.indexOf('transaction_id')] === id)!;
    return (column: string) => r[header.indexOf(column)];
  };
  const ofx = (account_id: string) => {
    const made = ofxFile(data, doc, account_id, new Date(NOW));
    if ('refused' in made) throw new Error(made.refused);
    return { text: [...made.file.pieces()].join(''), notes: made.file.notes };
  };
  return { doc, csv, ofx };
}

describe('rules on the rows SimpleFIN brings', () => {
  test('rename, tag and hide them, matched by their source and their bank, alike in the app, the API and the CSV', async () => {
    await trackBoth();
    const work = (await ensureTag(ctx, { name: 'Work' })).tag.id;
    await rule({
      conditions: [
        { field: 'source', op: 'equals', value: 'simplefin' },
        { field: 'name', op: 'contains', value: 'coffee' },
      ],
      actions: { set_name: 'Coffee shop', add_tags: [work], hide: true },
    });
    await rule({ conditions: [{ field: 'institution', op: 'equals', value: 'my bank' }, { field: 'name', op: 'contains', value: 'diner' }], actions: { set_name: 'Diner at my bank' } });

    const rows = await activity();
    expect(named(rows, 'COFFEE')).toMatchObject({ name: 'Coffee shop', name_before_rules: 'COFFEE', source: 'simplefin', tags: [work], excluded: true, excluded_by_rule: true });
    expect(named(rows, 'DINER')).toMatchObject({ name: 'Diner at my bank', name_before_rules: 'DINER' });
    // The bank's own rows are unchanged: the name is the person's to see, never written.
    expect((await manualTxnStore.get(ctx, await idOf('Checking')))!.rows.find((r) => r.source_id === 'coffee')!.name).toBe('COFFEE');

    const viaApi = await apiRows();
    const coffee = viaApi.find((t) => t.name === 'Coffee shop');
    expect(coffee).toMatchObject({ source: 'simplefin', tags: [{ id: work, name: 'Work' }], excluded: true, excluded_by_rule: true, rule_ids: [expect.any(String)] });
    expect(viaApi.find((t) => t.name === 'Diner at my bank')).toBeDefined();
    // The rules endpoint says the source in words; the MCP server finds them by tag.
    const rules = (await api('rules')).rules;
    expect(rules.map((r: any) => r.sentence)).toContain('If from SimpleFIN and name contains “coffee”: name it “Coffee shop”, tag Work, hide it from budgets and reports.');
    const found = await tool('search_transactions', { from: '2000-01-01', tag: 'work' });
    expect(found.transactions.map((t: any) => [t.name, t.source])).toEqual([['Coffee shop', 'simplefin']]);

    const { csv } = await download();
    const coffeeCsv = csv(await rowId('Checking', 'COFFEE'));
    expect([coffeeCsv('nya_name'), coffeeCsv('excluded'), coffeeCsv('tags'), coffeeCsv('source')]).toEqual(['Coffee shop', 'true', 'Work', 'simplefin']);
    expect(csv(await rowId('Visa', 'DINER'))('nya_name')).toBe('Diner at my bank');
  });

  test('a pair worked out between two of them keeps its pair’s category: a rule never files one side, so no total counts half a transfer', async () => {
    await trackBoth();
    const food = await catId('food and drink');
    await rule({ conditions: [{ field: 'amount', op: 'between', value: 300, value2: 300 }], actions: { set_category: food, set_name: 'Card payment' } });
    const rows = await activity();
    for (const name of ['PAYMENT TO VISA', 'PAYMENT THANK YOU']) {
      const t = named(rows, name);
      // Matched and renamed, never refiled: still the pair's, left out of every total.
      expect([t.name, t.paired, t.category_name, t.category_by_rule, t.rule_ids?.length, countsInTotals(t, 'USD')]).toEqual(['Card payment', 'card', 'loan payments', undefined, 1, false]);
    }
    // The preview says the two keep their category.
    const preview = await import('@/app/api/rules/preview/route');
    const res = await preview.POST(new Request('http://localhost/api/rules/preview', { method: 'POST', body: JSON.stringify({ rule: { conditions: [{ field: 'amount', op: 'between', value: 300, value2: 300 }], actions: { set_category: food } } }) }));
    expect(await res.json()).toMatchObject({ matches: 2, keep_category: 2 });
    // In the download too: each side filed by the pair's words.
    const { csv } = await download();
    expect(csv(await rowId('Checking', 'PAYMENT TO VISA'))('nya_category')).toBe('loan payments');
  });

  test('a category a rule files them under counts them in its usage, and can’t be deleted while the rule names it', async () => {
    await trackBoth();
    const categories = await import('@/app/api/categories/route');
    const call = async (body: unknown) => {
      const res = await categories.POST(new Request('http://localhost/api/categories', { method: 'POST', body: JSON.stringify(body) }));
      return { status: res.status, body: await res.json() };
    };
    const set = (await ensureTaxonomy(ctx));
    const food = set.groups.find((g) => g.name === 'Food')!.id;
    const added = await call({ action: 'add-category', name: 'Coffee shops', group: food });
    const shops = added.body.categories.categories.find((c: any) => c.name === 'Coffee shops').id;
    await rule({ conditions: [{ field: 'name', op: 'contains', value: 'coffee' }], actions: { set_category: shops } });
    expect(named(await activity(), 'COFFEE')).toMatchObject({ category_id: shops, category_by_rule: true });
    const refused = await call({ action: 'delete-category', id: shops });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('rule');
  });
});

describe('a note on a row SimpleFIN brought', () => {
  test('is kept beside it, in the API, the CSV and its account’s OFX statement, which also says what a rule did', async () => {
    await trackBoth();
    const work = (await ensureTag(ctx, { name: 'Work' })).tag.id;
    await rule({ conditions: [{ field: 'name', op: 'contains', value: 'coffee' }], actions: { set_name: 'Coffee shop', add_tags: [work], hide: true } });
    const coffee = await rowId('Checking', 'COFFEE');
    const annotations = await import('@/app/api/transaction-annotations/route');
    const res = await annotations.PATCH(new Request('http://localhost/api/transaction-annotations', { method: 'PATCH', body: JSON.stringify({ transaction_id: coffee, account_id: await idOf('Checking'), note: 'with Sam' }) }));
    expect(res.status).toBe(200);
    expect(named(await activity(), 'COFFEE').note).toBe('with Sam');
    expect((await apiRows()).find((t) => t.id === coffee).note).toBe('with Sam');

    const { csv, ofx } = await download();
    expect(csv(coffee)('note')).toBe('with Sam');
    const statement = ofx(await idOf('Checking'));
    const entry = statement.text.split('<STMTTRN>').find((s) => s.includes(`<FITID>${coffee}`))!;
    expect(entry).toContain('<NAME>Coffee shop\r\n');
    expect(entry).toContain('<MEMO>Hidden from budgets and reports by a rule in Nya; COFFEE; with Sam; Tags: Work\r\n');
  });
});

describe('a report over SimpleFIN rows', () => {
  test('counts what a rule hides as a rule’s', async () => {
    await trackBoth();
    await rule({ conditions: [{ field: 'name', op: 'contains', value: 'diner' }], actions: { hide: true } });
    const p = resolvePeriod({ kind: 'range', start: dayOf(NOW - 30 * DAY), end: dayOf(NOW) }, 'UTC', NOW);
    if ('error' in p) throw new Error(p.error);
    const report = await readReport(ctx, p, { currency: 'USD', now: NOW });
    expect([report.totals.excluded, report.totals.hidden_by_rule]).toEqual([1, 1]);
  });
});
