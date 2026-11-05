import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime, spyOn } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import './clerk-mock';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';

// The Plan's inputs in one request (app/api/plan-inputs, D16): your plan
// and its currency exactly as GET /api/fire-plan answers them, and each
// workplace plan's contributions exactly as GET /api/investment-activity
// answers them for the account; the cached rows in one HMGET beside the
// plan's three reads; a row not cached pending, until a sync=1 request fills
// it, syncing each item once; a Plaid outage's stored rows and note; and a
// plan that can't be had failing on its own, never the whole answer.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

// A Plaid that answers each item's own accounts, by its access token, and can
// be down.
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const contribution = (id: string, account_id: string, date: string, amount: number, over: Record<string, unknown> = {}) => ({
  investment_transaction_id: id,
  account_id,
  security_id: 's1',
  date,
  name: 'Contribution',
  quantity: 1,
  amount: -amount,
  price: amount,
  fees: 0,
  type: 'cash',
  subtype: 'contribution',
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  ...over,
});
const plaid = {
  down: false,
  calls: [] as string[],
  items: {
    'tok-i1': { accounts: ['k1', 'k2'], rows: [contribution('a1', 'k1', daysAgo(40), 500), contribution('a2', 'k1', daysAgo(10), 250), contribution('b1', 'k2', daysAgo(20), 300)] },
    'tok-i2': { accounts: ['k3'], rows: [contribution('c1', 'k3', daysAgo(30), 800), contribution('c2', 'k3', daysAgo(5), 50, { name: 'Rollover from 401k' })] },
  } as Record<string, { accounts: string[]; rows: ReturnType<typeof contribution>[] }>,
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    investmentsTransactionsGet: async (req: any) => {
      plaid.calls.push(req.access_token);
      if (plaid.down) throw { response: { data: { error_code: 'INSTITUTION_DOWN' } } };
      const { accounts, rows } = plaid.items[req.access_token];
      const inRange = rows.filter((r) => r.date >= req.start_date && r.date <= req.end_date);
      const offset = req.options?.offset ?? 0;
      return {
        data: {
          accounts: accounts.map((account_id) => ({ account_id, name: account_id, mask: '0000', type: 'investment', subtype: '401k' })),
          securities: [{ security_id: 's1', name: 'Target 2055', ticker_symbol: 'VFFVX' }],
          investment_transactions: inRange.slice(offset, offset + (req.options?.count ?? 500)),
          total_investment_transactions: inRange.length,
        },
      };
    },
  },
}));

const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { DEFAULT_PLAN_V2 } = await import('@/lib/fire/plan-v2');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const plansRoute = await import('@/app/api/plans/route');
const invstore = await import('@/lib/invstore');
const firePlan = await import('@/app/api/fire-plan/route');
const activity = await import('@/app/api/investment-activity/route');
const route = await import('@/app/api/plan-inputs/route');
const { forgetEpochs } = await import('@/lib/sessions');

const CACHE = ctxKey('cache:inv-activity:v4');
const PLANS = ['i1:k1', 'i1:k2', 'i2:k3'];
const FIELDS = ['contributions_12m', 'contributions_12m_from', 'contributions_12m_partial', 'contributions_12m_rows', 'contributions_12m_activity_from', 'dividends_12m', 'note'];

/** The commands sent, and the item each sync took its lock on (a sync
 *  refreshes its lock as it goes; only taking it is counted). */
let sent: string[] = [];
const locks: string[] = [];
const gated = fake as unknown as { gate: (command: string) => void };
const gate = gated.gate.bind(fake);
gated.gate = (command) => {
  sent.push(command);
  gate(command);
};
const realSet = fake.set.bind(fake);
fake.set = ((key: string, ...rest: unknown[]) => {
  if (key.includes('invtxns-lock') && (rest[1] as { nx?: boolean } | undefined)?.nx) locks.push(key);
  return (realSet as (...a: unknown[]) => unknown)(key, ...rest);
}) as typeof fake.set;

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  plaid.down = false;
  plaid.calls = [];
  locks.length = 0;
  for (const item_id of ['i1', 'i2']) {
    await saveItem(TEST_CTX, { item_id, institution_name: item_id, encrypted_access_token: await encrypt(TEST_CTX, `tok-${item_id}`) } as any);
  }
  sent = [];
});
afterEach(() => setSystemTime());

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.error = orig;
  }
};
const ask = (plans: string[], sync = false) =>
  route.GET(new Request(`http://x/api/plan-inputs?${[...(sync ? ['sync=1'] : []), ...plans.map((p) => `plan=${encodeURIComponent(p)}`)].join('&')}`));
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...DEFAULT_PLAN_V2, ...over });
const TYPED = plan({ age: 40, targetAge: 55, spending: 40_000 });
const put = (body: unknown) => firePlan.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }));
const plans = async (method: 'POST' | 'PATCH', body: unknown) => (await plansRoute[method](new Request('http://x', { method, body: JSON.stringify(body) }))).json();
/** Your plan's first save, in USD. */
const saveFirst = () => put({ plan: TYPED, currency: 'USD', facts_were: factsOf(DEFAULT_PLAN_V2), based_on: null });
/** What GET /api/investment-activity answers for the account, its Plan fields. */
const activityRow = async (id: string) => {
  const [item_id, account_id] = id.split(':');
  const body = await (await activity.GET(new Request(`http://x/api/investment-activity?id=${account_id}&item_id=${item_id}`))).json();
  return Object.fromEntries([['id', id], ...FIELDS.map((f) => [f, body[f]])]);
};

describe('the plan', () => {
  test('is GET /api/fire-plan’s answer, whatever is stored, with the rows beside it', async () => {
    let copy = '';
    const states: (() => Promise<unknown>)[] = [
      async () => {}, // nothing saved: the defaults
      saveFirst, // your plan, in USD
      () => fake.del(ctxKey('plan-facts')), // the facts missing (a first write stopped before them): its own fields
      async () => {
        // A copy, its amounts said to be in EUR, made your plan (which makes the facts).
        const made = (await plans('POST', { from: MAIN_ID, name: 'In euros', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' })).plan;
        const relabelled = (await plans('PATCH', { id: made.id, currency: 'EUR', based_on: made.updated_at })).plan;
        await plans('PATCH', { main: made.id, based_on: relabelled.updated_at });
        copy = made.id;
      },
    ];
    const seen: unknown[] = [];
    for (const state of states) {
      await state();
      const expected = await (await firePlan.GET()).json();
      const { status, body } = await json(await quiet(() => ask([])));
      expect(status).toBe(200);
      expect(body).toEqual({ ...expected, plans: [] });
      seen.push([body.id === MAIN_ID ? 'main' : body.id === copy ? 'copy' : body.id, body.currency, body.updated_at === null]);
    }
    expect(seen).toEqual([
      ['main', null, true],
      ['main', 'USD', false],
      ['main', 'USD', false],
      ['copy', 'EUR', false],
    ]);
  });

  test('your plan’s entry that can’t be read is a flagged 409, as GET /api/fire-plan answers it, with every row', async () => {
    await fake.hset(ctxKey('fire-plans'), { [MAIN_ID]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const expected = await (await quiet(() => firePlan.GET())).json();
    const { status, body } = await json(await quiet(() => ask(['i1:k1', 'bad'])));
    expect(status).toBe(409);
    expect(body).toEqual({ ...expected, plans: [{ id: 'i1:k1', pending: true }, { id: 'bad', failed: true }] });
    expect(body.unreadable).toBe(true);
  });

  test('a database failure on the plan is a 500 without the flag; no container to reach, a 503', async () => {
    // How many plans there are, read before anything is saved.
    fake.failNext('hlen');
    const failed = await json(await quiet(() => ask(PLANS)));
    expect(failed.status).toBe(500);
    expect(failed.body.unreadable).toBeUndefined();
    // The facts, read beside your plan's entry once there is one.
    await saveFirst();
    fake.failNext('get');
    const facts = await json(await quiet(() => ask(PLANS)));
    expect([facts.status, facts.body.unreadable]).toEqual([500, undefined]);
    fake.reset();
    forgetEpochs();
    expect((await quiet(() => ask(PLANS))).status).toBe(503);
  });
});

describe('the rows', () => {
  test('a row not cached is pending; sync=1 fills it, each item synced once, and caches it; the next answer has every row from one HMGET', async () => {
    expect((await saveFirst()).status).toBe(200);
    expect((await json(await ask(PLANS))).body.plans).toEqual(PLANS.map((id) => ({ id, pending: true })));

    const synced = await json(await ask(PLANS, true));
    expect(synced.status).toBe(200);
    expect(Object.keys(synced.body)).toEqual(['plans']); // the rows alone
    expect(locks.map((k) => k.slice(k.lastIndexOf(':') + 1)).sort()).toEqual(['i1', 'i2']); // one sync per item
    expect(Object.keys((await fake.hgetall(CACHE)) ?? {}).sort()).toEqual(PLANS);

    // Each row is what the Accounts tab's route answers for the account.
    const expected = [];
    for (const id of PLANS) expected.push(await activityRow(id));
    expect(synced.body.plans).toEqual(expected);
    expect(synced.body.plans[0].contributions_12m).toBe(750);
    expect(synced.body.plans[2].contributions_12m).toBe(800); // the rollover left out

    sent = [];
    const answer = await json(await ask(PLANS));
    expect(answer.body.plans).toEqual(expected);
    // The plan's three reads (the facts, your plan's entry and how many plans
    // there are) and every row, the rows one HMGET.
    expect(sent.sort()).toEqual(['eval', 'get', 'hlen', 'hmget']);
  });

  test('with no workplace plan, the plan alone: its three reads, no HMGET', async () => {
    await ask([]); // the deployment's container read once, then reused
    sent = [];
    expect((await json(await ask([]))).body.plans).toEqual([]);
    // The facts, your plan's entry (a script) and how many plans there are,
    // all begun at once: with none, the defaults, nothing more read.
    expect(sent).toEqual(['get', 'eval', 'hlen']);
    await saveFirst();
    sent = [];
    expect((await json(await ask([]))).body.plan).toEqual(TYPED);
    expect(sent).toEqual(['get', 'eval', 'hlen']);
  });

  test('a row past the cache’s age, or cached before the Plan’s fields, is pending', async () => {
    await ask(PLANS, true);
    setSystemTime(new Date(Date.now() + 16 * 60_000));
    expect((await json(await ask(['i1:k1']))).body.plans).toEqual([{ id: 'i1:k1', pending: true }]);
    setSystemTime();
    const { writeAccountCache } = await import('@/lib/cache');
    await writeAccountCache(TEST_CTX, 'i1:k2', { txns: [], contributions_12m: 0, note: null });
    expect((await json(await ask(['i1:k2']))).body.plans).toEqual([{ id: 'i1:k2', pending: true }]);
  });

  test('sync=1 answers a cached row as it is, and syncs only the items of the rest', async () => {
    await ask(['i2:k3'], true);
    locks.length = 0;
    const synced = await json(await ask(PLANS, true));
    expect(synced.body.plans.map((r: { id: string }) => r.id)).toEqual(PLANS);
    expect(locks.map((k) => k.slice(k.lastIndexOf(':') + 1))).toEqual(['i1']);
  });

  test('in a Plaid outage, the stored rows with the route’s own note, not cached', async () => {
    await ask(PLANS, true);
    await fake.del(CACHE);
    setSystemTime(new Date(Date.now() + 20 * 60_000)); // the store no longer fresh
    plaid.down = true;
    const { body } = await json(await quiet(() => ask(['i1:k1'], true)));
    const expected = await quiet(() => activityRow('i1:k1'));
    expect(body.plans).toEqual([expected]);
    expect(body.plans[0].note).toContain('showing saved activity');
    expect(body.plans[0].contributions_12m).toBe(750);
    expect(await fake.hgetall(CACHE)).toBeNull();
  });

  test('a plan that can’t be had fails on its own: an id that isn’t one, an item not linked, a sync that throws, the items unreadable', async () => {
    const odd = await json(await ask(['nope', ':k1', 'i1:', 'i9:k9', 'i2:k3'], true));
    expect(odd.status).toBe(200);
    expect(odd.body.plans.map((r: { id: string; failed?: boolean }) => [r.id, r.failed === true])).toEqual([
      ['nope', true],
      [':k1', true],
      ['i1:', true],
      ['i9:k9', true],
      ['i2:k3', false],
    ]);

    const real = invstore.syncInvestments;
    const spy = spyOn(invstore, 'syncInvestments').mockImplementation(async (ctx, item, opts) => {
      if (item.item_id === 'i1') throw new Error('boom');
      return real(ctx, item, opts);
    });
    try {
      await fake.del(CACHE);
      const thrown = await json(await quiet(() => ask(PLANS, true)));
      expect(thrown.body.plans.map((r: { id: string; failed?: boolean }) => [r.id, r.failed === true])).toEqual([
        ['i1:k1', true],
        ['i1:k2', true],
        ['i2:k3', false],
      ]);
    } finally {
      spy.mockRestore();
    }

    await fake.del(CACHE);
    fake.failNext('hgetall');
    const unreadable = await json(await quiet(() => ask(PLANS, true)));
    expect(unreadable.status).toBe(200);
    expect(unreadable.body.plans).toEqual(PLANS.map((id) => ({ id, failed: true })));
  });

  test('each plan asked once, in the order asked; more than 100 is refused', async () => {
    const { body } = await json(await ask(['i2:k3', 'i1:k1', 'i2:k3']));
    expect(body.plans.map((r: { id: string }) => r.id)).toEqual(['i2:k3', 'i1:k1']);
    const many = Array.from({ length: 101 }, (_, i) => `i1:a${i}`);
    const refused = await json(await ask(many));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toContain('100');
  });
});
