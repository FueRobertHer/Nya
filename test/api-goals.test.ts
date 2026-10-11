import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Goals in the read-only API and the MCP server (#42): GET /api/v1/goals and
// get_goals, from stored data alone, as the Goals card tells them, with
// hidden accounts and other people's goals never in them, and Plaid never
// called.

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

const { ctx, OTHER, seedPerson, seedOther } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { forgetEpochs } = await import('@/lib/sessions');
const { setGoals } = await import('@/lib/goals');
const { goalPlansStore } = await import('@/lib/goal-plans');
const v1 = await import('@/app/api/v1/goals/route');
const mcp = await import('@/app/api/mcp/route');
const app = await import('@/app/api/goals/route');

const ID = (n: number) => `0000000${n}-1d2e-4f5a-8b6c-7d8e9f0a1b2c`;
const today = () => new Date().toISOString().slice(0, 10);

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
  // Saved as the app saves them: through its route, which checks each. The
  // bike is archived in a save of its own, as the app archives a goal.
  const save = async (bike: Record<string, unknown>) => {
    const res: Response = await app.PUT(
      new Request('http://x/api/goals', {
        method: 'PUT',
        body: JSON.stringify({
          goals: [
            { id: ID(1), name: 'Rainy day', target: 3000, account_id: 'acc_chk', plan: { allocation: 1000, monthly_target: 100, target_date: '2030-01-31' } },
            { id: ID(2), name: 'House', target: 60_000, account_id: 'acc_save', plan: {} },
            { id: ID(3), name: 'Someday', target: 800, account_id: null, plan: { monthly_target: 50 } },
            { id: ID(5), name: 'Bike', target: 900, account_id: 'manual_wallet', plan: bike },
          ],
        }),
      })
    );
    expect(res.status).toBe(200);
  };
  await save({});
  await save({ archived: true });
  plaidTouched.length = 0;
});
afterEach(() => {
  process.env = { ...saved };
  expect(plaidTouched).toEqual([]);
});

const ask = async (query = '', tok = token) => {
  const res: Response = await v1.GET(new Request(`https://nya.test/api/v1/goals${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${tok}` } }));
  return { res, body: (await res.json()) as any };
};
const byId = (body: any) => new Map<string, any>(body.goals.map((g: any) => [g.id, g]));

describe('GET /api/v1/goals', () => {
  test('every goal, as the app counts it, on the balances Nya last measured', async () => {
    const { res, body } = await ask();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.goals.map((g: any) => g.id)).toEqual([ID(1), ID(2), ID(3), ID(5)]);
    const goals = byId(body);
    // Checking's newest measured balance is 1250: the allocation counts as set.
    expect(goals.get(ID(1))).toMatchObject({
      name: 'Rainy day',
      currency: 'USD',
      account_id: 'acc_chk',
      account_name: 'Checking',
      state: 'tracked',
      saved: 1000,
      allocation: 1000,
      scaled: false,
      shares_account_with: [],
      monthly_target: 100,
      target_date: '2030-01-31',
      archived: false,
    });
    expect(goals.get(ID(1)).pace.source).toBe('transactions');
    expect(goals.get(ID(1)).pace.months.map((m: any) => m.month)).toEqual(body.months);
    expect(goals.get(ID(1)).projection.should_have).toBe(1000); // the line starts today, at what it holds
    expect(body.accounts).toEqual([{ account_id: 'acc_chk', currency: 'USD', balance: 1250, allocated: 1000, unallocated: 250, over_allocated: 0 }]);
    // Untracked: its plan, and nothing counted.
    expect(goals.get(ID(3))).toMatchObject({ state: 'untracked', saved: null, monthly_target: 50, pace: null, projection: null, notes: ['No account linked.'] });
    // Archived: marked, with the day, counting nothing.
    expect(goals.get(ID(5))).toMatchObject({ archived: true, archived_on: today(), archived_amount: 40, saved: null, projection: null });
    // A connection hasn't been loaded: said, never passed off as whole.
    expect(body.complete).toBe(false);
    expect(body.missing_accounts.map((m: any) => m.institution)).toEqual(['NewBank']);
  });

  test('a goal on a hidden account counts nothing and names nothing, unless hidden accounts are asked for', async () => {
    expect(byId((await ask()).body).get(ID(2))).toMatchObject({ state: 'hidden', saved: null, account_name: null, projection: null });
    expect(byId((await ask('include_hidden=true')).body).get(ID(2))).toMatchObject({ state: 'tracked', saved: 5000, account_name: 'Savings' });
  });

  test('a goal on a card, saved by the release before, is owed, not saved: no progress', async () => {
    await setGoals(ctx, [{ id: ID(4), name: 'Card', target: 500, account_id: 'acc_card' }]);
    expect(byId((await ask()).body).get(ID(4))).toMatchObject({ state: 'owed', saved: null, projection: null });
  });

  test('plans that can’t be read are a 409, never goals without them', async () => {
    await fake.hset(ctxKey('goal-plans'), { [ID(1)]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const error = console.error;
    console.error = () => {};
    try {
      const { res, body } = await ask();
      expect(res.status).toBe(409);
      expect(body.error.code).toBe('unreadable');
    } finally {
      console.error = error;
    }
  });

  test('another person’s token reads only their own goals', async () => {
    await seedOther(fake);
    await setGoals(OTHER, [{ id: ID(9), name: 'OTHER-SECRET-GOAL', target: 10, account_id: null }]);
    await goalPlansStore.set(OTHER, ID(9), { v: 1, core: { name: 'OTHER-SECRET-GOAL', target: 10, account_id: null }, plan: { monthly_target: 3 }, before: null });
    expect(JSON.stringify((await ask()).body)).not.toContain('OTHER-SECRET');
    process.env.CONTAINER_ID = OTHER.container;
    forgetEpochs();
    const theirs = await ask('', (await createToken(OTHER, 'Theirs')).token);
    expect(theirs.body.goals.map((g: any) => g.name)).toEqual(['OTHER-SECRET-GOAL']);
    expect(JSON.stringify(theirs.body)).not.toContain('Rainy day');
  });

  test('read only: every other method refused, and nothing written', async () => {
    expect(v1.POST().status).toBe(405);
    const before = JSON.stringify([...((fake as any).hashes as Map<string, Map<string, string>>).get(ctxKey('goal-plans'))!.entries()]);
    await ask('include_hidden=true');
    expect(JSON.stringify([...((fake as any).hashes as Map<string, Map<string, string>>).get(ctxKey('goal-plans'))!.entries()])).toBe(before);
  });
});

describe('the MCP tool get_goals', () => {
  const call = async (args?: unknown) => {
    const res: Response = await mcp.POST(
      new Request('https://nya.test/api/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_goals', ...(args === undefined ? {} : { arguments: args }) } }),
      })
    );
    return ((await res.json()) as any).result;
  };

  test('the same answer as the REST endpoint, with a sentence of numbers only', async () => {
    const result = await call();
    expect(result.structuredContent).toEqual((await ask()).body);
    const sentence = result.content[0].text;
    expect(sentence).toMatch(/^3 goals, and 1 archived: \d+ reached, \d+ on track, \d+ behind, \d+ with no recent contributions\. Incomplete:/);
    for (const name of ['Rainy day', 'House', 'Someday', 'Bike', 'Checking']) expect(sentence).not.toContain(name);
  });

  test('its arguments are checked like the endpoint’s', async () => {
    expect((await call({ include_hidden: 'yes' })).isError).toBe(true);
    expect((await call({ include_hidden: true })).structuredContent.goals[1].state).toBe('tracked');
  });
});
