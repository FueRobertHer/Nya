import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys, ctxKey } from './fake-redis';

// The read-only API's cash flow (#41: app/api/v1/cash-flow, lib/api-cash-flow.ts)
// and the MCP server's get_cash_flow: from stored data alone, the same money
// in, money out and spending by category and group as /api/v1/spending, to
// the cent; hidden accounts and other people's data never in it; every
// argument checked strictly; Plaid never called.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
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

const { ctx, OTHER, daysAgo, seedPerson, seedOther } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { forgetEpochs } = await import('@/lib/sessions');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { rulesStore } = await import('@/lib/rules-store');
const cashFlowRoute = await import('@/app/api/v1/cash-flow/route');
const spendingRoute = await import('@/app/api/v1/spending/route');
const mcpRoute = await import('@/app/api/mcp/route');

let token = '';
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
  plaidTouched.length = 0;
});
afterEach(() => {
  process.env = { ...saved };
  expect(plaidTouched).toEqual([]);
});

const get = async (route: any, path: string, query = '', bearer = token) => {
  const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${path}${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${bearer}` } }));
  return { res, body: (await res.json()) as any };
};
const flow = (query = '', bearer = token) => get(cashFlowRoute, 'cash-flow', query, bearer);
const spending = (query = '', bearer = token) => get(spendingRoute, 'spending', query, bearer);

/** The last nine days: every row of the fixture's but the subscription's. */
const NINE = `from=${daysAgo(9)}&to=${daysAgo(0)}`;

describe('the same figures as spending, to the cent', () => {
  test('money in, out and net; spending by category and by group; what was left out', async () => {
    const [{ body: f }, { body: s }] = await Promise.all([flow(NINE), spending(NINE)]);
    expect([f.money_in, f.money_out, f.net]).toEqual([s.money_in, s.money_out, s.net]);
    expect([f.money_in, f.money_out]).toEqual([3000, 5.5 + 1200 + 35 + 80 + 12 + 25]);
    // Each of spending's categories is one of the cash flow's, in its group, at the same amount.
    const categories = f.groups.flatMap((g: any) => g.categories.map((c: any) => ({ category: c.name, category_id: c.id, group_id: g.id, group: g.name, spent: c.amount, transactions: c.transactions })));
    expect([...categories].sort((a, b) => b.spent - a.spent || (a.category < b.category ? -1 : 1))).toEqual(s.categories);
    expect(f.groups.map((g: any) => ({ id: g.id, name: g.name, kind: g.kind, spent: g.amount, transactions: g.transactions }))).toEqual(s.groups);
    for (const key of ['transactions', 'counted', 'transfers', 'excluded', 'exclusion_unknown', 'left_out', 'left_out_text', 'currency', 'sources']) expect([key, f[key]]).toEqual([key, s[key]]);
    expect(f.hidden_by_rule).toBe(0);
  });

  test('money in by who paid it, and what was left over', async () => {
    const { body } = await flow(NINE);
    expect(body.payers).toEqual([{ name: 'T_PAY', amount: 3000, transactions: 1, refund: false }]);
    expect([body.left_over, body.from_savings_or_debt]).toEqual([3000 - 1357.5, 0]);
    expect([body.from, body.to]).toEqual([daysAgo(9), daysAgo(0)]);
  });

  test('more out than in: what came from savings or debt, and nothing left over', async () => {
    const { body } = await flow(`from=${daysAgo(3)}&to=${daysAgo(0)}`);
    expect(body.payers).toEqual([]);
    expect([body.money_in, body.money_out, body.left_over, body.from_savings_or_debt]).toEqual([0, 1242.5, 0, 1242.5]);
  });

  test('a refund is a payer, marked; a rule’s hide is left out and counted apart, as the totals count it', async () => {
    const now = new Date().toISOString();
    const wallet = (await manualTxnStore.get(ctx, 'manual_wallet'))!;
    await manualTxnStore.set(ctx, 'manual_wallet', {
      ...wallet,
      rows: [
        ...wallet.rows,
        { id: 'manual-txn:7b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d', account_id: 'manual_wallet', date: daysAgo(2), amount: -15, currency: 'USD', name: 'Outdoor Store', category: 'general merchandise', note: null, source: 'manual', source_id: null, created_at: now, updated_at: now },
      ],
    });
    await rulesStore.set(ctx, {
      version: 1,
      rules: [{ id: crypto.randomUUID(), enabled: true, priority: 1, conditions: [{ field: 'name', op: 'contains', value: 't_card' }], actions: { hide: true }, created_at: now, updated_at: now }],
    });
    const [{ body: f }, { body: s }] = await Promise.all([flow(NINE), spending(NINE)]);
    expect(f.payers).toEqual([
      { name: 'T_PAY', amount: 3000, transactions: 1, refund: false },
      { name: 'Outdoor Store', amount: 15, transactions: 1, refund: true },
    ]);
    expect([f.money_in, f.money_out]).toEqual([s.money_in, s.money_out]);
    expect(f.money_in).toBe(3015);
    // The card's 80 is hidden by the rule: in excluded, and in hidden_by_rule.
    expect(f.money_out).toBe(1357.5 - 80);
    expect([f.excluded, f.hidden_by_rule, s.excluded]).toEqual([2, 1, 2]);
    expect(f.groups.find((g: any) => g.name === 'Shopping')).toBeUndefined();
  });

  test('another currency on request, as spending totals it', async () => {
    const [{ body: f }, { body: s }] = await Promise.all([flow(`${NINE}&currency=EUR`), spending(`${NINE}&currency=EUR`)]);
    expect([f.currency, f.money_out, f.money_in]).toEqual(['EUR', 50, 0]);
    expect(f.groups.map((g: any) => [g.name, g.amount])).toEqual(s.groups.map((g: any) => [g.name, g.spent]));
  });

  test('a month at a time, this one by default', async () => {
    const month = daysAgo(0).slice(0, 7);
    const [{ body: f }, { body: s }] = await Promise.all([flow(), spending()]);
    expect([f.from, f.to]).toEqual([s.from, s.to]);
    expect(f.from).toBe(`${month}-01`);
    expect([f.money_in, f.money_out]).toEqual([s.money_in, s.money_out]);
    const { body: m } = await flow(`month=${month}`);
    expect(m.money_out).toBe(f.money_out);
  });
});

describe('never short without saying so', () => {
  test('an institution whose stored rows can’t be read is named, and the rest answered: never an empty period', async () => {
    await fake.set(ctxKey('txns:item_chase'), 'not-a-blob-but-long-enough-to-be-tried');
    const [error, warn] = [console.error, console.warn];
    console.error = console.warn = () => {};
    try {
      const { res, body } = await flow(NINE);
      expect(res.status).toBe(200);
      expect(body.sources.find((x: any) => x.institution === 'Chase').complete).toBe(false);
      expect(body.notes.some((note: string) => note.includes('Chase'))).toBe(true);
      // What could be read is still counted: the wallet's market run.
      expect([body.money_in, body.money_out]).toEqual([0, 25]);
    } finally {
      [console.error, console.warn] = [error, warn];
    }
  });
});

describe('only what this token may read', () => {
  test('hidden accounts are left out unless asked for', async () => {
    const [{ body: plain }, { body: all }] = await Promise.all([flow(NINE), flow(`${NINE}&include_hidden=true`)]);
    expect(JSON.stringify(plain)).not.toContain('999');
    expect(all.money_out).toBe(plain.money_out + 999);
    const { body: s } = await spending(`${NINE}&include_hidden=true`);
    expect(all.money_out).toBe(s.money_out);
  });

  test('another person’s token reads only their own container', async () => {
    await seedOther(fake);
    process.env.CONTAINER_ID = OTHER.container;
    forgetEpochs();
    const theirs = (await createToken(OTHER, 'Theirs')).token;
    const { res, body } = await flow(`from=${daysAgo(9)}`, theirs);
    expect(res.status).toBe(200);
    expect(body.money_out).toBe(77);
    expect(JSON.stringify(body)).not.toContain('T_PAY');
    expect(body.payers).toEqual([]);
  });

  test('with no token, or a bad one, nothing', async () => {
    for (const bearer of ['', 'nya_nope']) {
      const res: Response = await cashFlowRoute.GET(new Request('https://nya.test/api/v1/cash-flow', { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));
      expect(res.status).toBe(401);
    }
  });
});

describe('arguments, checked strictly', () => {
  test('a month and a range at once, a bad month, day or currency, from after to, or one it doesn’t take: a 400', async () => {
    for (const query of ['month=2026-10&from=2026-10-01', 'month=2026-13', 'from=2026-02-30', 'currency=dollars', 'from=2026-10-09&to=2026-10-01', 'include_hidden=yes', 'category=food', 'month=2026-10&month=2026-09']) {
      const { res, body } = await flow(query);
      expect([query, res.status, body.error?.code]).toEqual([query, 400, 'invalid_request']);
    }
  });

  test('read only: every other method is refused in the API’s shape', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res: Response = await (cashFlowRoute as any)[method](new Request('https://nya.test/api/v1/cash-flow', { method }));
      expect([method, res.status]).toEqual([method, 405]);
    }
  });

  test('a range reaching before the window says so', async () => {
    const { body } = await flow('from=2000-01-01');
    expect(body.notes.some((n: string) => n.startsWith('Only transactions from'))).toBe(true);
  });
});

describe('the MCP tool', () => {
  const rpc = async (args: unknown) => {
    const res: Response = await mcpRoute.POST(
      new Request('https://nya.test/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_cash_flow', arguments: args } }),
      })
    );
    return ((await res.json()) as any).result;
  };

  test('answers what the REST endpoint does, with a sentence of numbers and dates only', async () => {
    const result = await rpc({ from: daysAgo(9), to: daysAgo(0) });
    const { body } = await flow(NINE);
    expect(result.structuredContent).toEqual(body);
    expect(result.content[0].text).toBe(`From ${daysAgo(9)} to ${daysAgo(0)}: money in 3000.00 USD from 1 payer, money out 1357.50 USD in 4 groups, 1642.50 USD left over.`);
    expect(result.content[0].text).not.toContain('T_PAY');
  });

  test('says what came from savings or debt when more went out', async () => {
    const result = await rpc({ from: daysAgo(3), to: daysAgo(0) });
    expect(result.content[0].text).toContain('1242.50 USD from savings or debt');
  });

  test('refuses an argument it doesn’t take, as a tool error', async () => {
    const result = await rpc({ month: 'October' });
    expect(result.isError).toBe(true);
  });
});
