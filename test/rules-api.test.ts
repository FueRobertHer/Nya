import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys, ctxKey } from './fake-redis';

// Rules (#36) through the read-only API and the MCP server: the rules
// endpoint, and every answer built on transactions agreeing with what the
// rules do, as the app shows it: each transaction, spending, budgets and
// recurring bills. Additive to version 1, from stored data alone.

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
          throw new Error('Plaid must not be called by the API');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, seedPerson } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { forgetEpochs } = await import('@/lib/sessions');
const { ensureTaxonomy } = await import('@/lib/category-store');
const { indexTaxonomy } = await import('@/lib/categories');
const { addRule, changeRules, newRuleId, enableRule, sortedRules, readRuleSet } = await import('@/lib/rules');
const { ensureTag, readTagSet } = await import('@/lib/tags');
const mcpRoute = await import('@/app/api/mcp/route');

let token = '';
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  await seedPerson(fake);
  token = (await createToken(ctx, 'Tests')).token;
});

const call = async (name: string, query = '') => {
  const route = await import(`@/app/api/v1/${name}/route`);
  const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${name}${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${token}` } }));
  return { status: res.status, body: (await res.json()) as any };
};
/** Makes a rule as the app does (the categories stored first, as the app's first load stores them). */
const rule = async (input: unknown) => {
  const ix = indexTaxonomy(await ensureTaxonomy(ctx));
  const tags = await readTagSet(ctx);
  let id = '';
  await changeRules(ctx, (s) => {
    const made = addRule(s, input, { ix, tags }, newRuleId);
    id = made.rule.id;
    return made.set;
  });
  return id;
};
const catId = async (name: string) => (await ensureTaxonomy(ctx)).categories.find((c) => c.name === name)!.id;

describe('the rules endpoint', () => {
  test('each rule, in order, with its sentence and how many transactions it matches; none is none', async () => {
    expect((await call('rules')).body.rules).toEqual([]);
    const work = (await ensureTag(ctx, { name: 'Work' })).tag.id;
    const netflix = await rule({ conditions: [{ field: 'name', op: 'contains', value: 'netflix' }], actions: { add_tags: [work] } });
    const { status, body } = await call('rules');
    expect(status).toBe(200);
    expect(body.rules).toEqual([
      {
        id: netflix,
        enabled: true,
        priority: 1,
        conditions: [{ field: 'name', op: 'contains', value: 'netflix' }],
        actions: { add_tags: [work] },
        sentence: 'If name contains “netflix”: tag Work.',
        problem: null,
        transactions: 3,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      },
    ]);
  });

  test('an account a rule names is named as the app names it', async () => {
    await rule({ conditions: [{ field: 'account', op: 'equals', value: 'acc_card' }], actions: { hide: true } });
    const { body } = await call('rules');
    expect(body.rules[0].sentence).toBe('If account is Chase Card ••2222: hide it from budgets and reports.');
  });

  test('rules that can’t be read are a 409, never no rules', async () => {
    await fake.set(ctxKey('rules'), 'not-ciphertext-but-long-enough-to-be-tried');
    const quiet = console.error;
    console.error = () => {};
    try {
      expect((await call('rules')).status).toBe(409);
    } finally {
      console.error = quiet;
    }
  });
});

describe('every answer agrees with what the rules do', () => {
  test('a transaction shows what its rules did, and which match', async () => {
    const travel = await catId('travel');
    const id = await rule({ conditions: [{ field: 'name', op: 'equals', value: 'T_CARD' }], actions: { set_category: travel, set_name: 'Bookshop', hide: true } });
    const { body } = await call('transactions', 'from=2000-01-01');
    const card = body.transactions.find((t: any) => t.id === 't_card');
    expect(card).toMatchObject({ name: 'Bookshop', category_id: travel, excluded: true, excluded_by_rule: true, rule_ids: [id] });
    expect(body.transactions.find((t: any) => t.id === 't_rent')).toMatchObject({ rule_ids: [], excluded_by_rule: false });
    // Turned off: as it was.
    await changeRules(ctx, (s) => enableRule(s, id, false));
    const after = (await call('transactions', 'from=2000-01-01')).body.transactions.find((t: any) => t.id === 't_card');
    expect(after).toMatchObject({ name: 'T_CARD', excluded: false, rule_ids: [] });
  });

  test('spending and budgets count what a rule files and leave out what it hides', async () => {
    const before = (await call('spending', 'from=2000-01-01')).body;
    const travel = await catId('travel');
    // t_card (80) to travel; t_fee (35) hidden.
    await rule({ conditions: [{ field: 'name', op: 'equals', value: 'T_CARD' }], actions: { set_category: travel } });
    await rule({ conditions: [{ field: 'name', op: 'equals', value: 'T_FEE' }], actions: { hide: true } });
    const after = (await call('spending', 'from=2000-01-01')).body;
    expect(after.money_out).toBe(before.money_out - 35);
    expect(after.excluded).toBe(before.excluded + 1);
    expect(after.categories.find((c: any) => c.category_id === travel)?.spent).toBe(80);
    // Nothing counted twice: the categories still add up to money out.
    expect(after.categories.reduce((n: number, c: any) => n + c.spent, 0)).toBeCloseTo(after.money_out, 6);
    const budgets = (await call('budgets')).body;
    // The fixture budgets travel: what the rule filed there is its spending this month.
    const travelBudget = budgets.budgets.find((b: any) => b.category_id === travel);
    expect(travelBudget).toBeDefined();
    expect(travelBudget.spent).toBe(80);
  });

  test('recurring bills leave out what a rule hides, as the app does', async () => {
    expect((await call('recurring')).body.bills.map((b: any) => b.name)).toContain('Netflix');
    await rule({ conditions: [{ field: 'name', op: 'contains', value: 'netflix' }], actions: { hide: true } });
    expect((await call('recurring')).body.bills.map((b: any) => b.name)).not.toContain('Netflix');
  });

  test('the newest rule runs first, and the API says so', async () => {
    await rule({ conditions: [{ field: 'amount', op: 'gt', value: 1000 }], actions: { set_name: 'Big' } });
    await rule({ conditions: [{ field: 'name', op: 'equals', value: 'T_BIG' }], actions: { set_name: 'Laptop' } });
    expect((await call('transactions', 'from=2000-01-01')).body.transactions.find((t: any) => t.id === 't_big').name).toBe('Laptop');
    expect((await call('rules')).body.rules.map((r: any) => r.sentence)).toEqual(['If name is “T_BIG”: name it “Laptop”.', 'If amount more than 1000: name it “Big”.']);
    expect(sortedRules(await readRuleSet(ctx)).map((r) => r.priority)).toEqual([1, 2]);
  });
});

describe('through the MCP server', () => {
  test('list_rules', async () => {
    await rule({ conditions: [{ field: 'name', op: 'contains', value: 'netflix' }], actions: { hide: true } });
    const res: Response = await mcpRoute.POST(
      new Request('https://nya.test/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_rules', arguments: {} } }),
      })
    );
    const result = (await res.json()).result;
    expect(result.content[0].text).toBe('1 rule, 1 on.');
    expect(result.structuredContent.rules[0].sentence).toBe('If name contains “netflix”: hide it from budgets and reports.');
  });
});
