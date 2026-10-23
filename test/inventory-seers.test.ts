import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, registerTestContainer, unscopedDataKeys, ctxKey, testKey } from './fake-redis';

// Who else can see each kind (lib/inventory.ts `seen`), held to the code:
// the key families read while every API endpoint and MCP tool answers, while
// what a person shares is shown to the one they share it with (and in their
// own preview of it), and while the weekly summary and the connection
// notices are gathered, each recorded command by command. A family read on
// one of those paths and not saying so fails, and so does a family that says
// so and is read on none of them.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy({}, { get: () => async () => { throw new Error('Plaid is not called here'); } }),
}));

const fake = new FakeRedis({ deserialize: true });
/** Every key a command named while `recording`. */
const touched = new Set<string>();
let recording = false;
const recorded = new Proxy(fake, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== 'function' || typeof prop !== 'string') return value;
    return (...args: unknown[]) => {
      if (recording) {
        if (prop === 'eval') for (const k of (args[1] as string[]) ?? []) touched.add(String(k));
        else if (typeof args[0] === 'string') touched.add(args[0]);
      }
      return value.apply(target, args);
    };
  },
});
const base = storageMock(fake);
mock.module('@/lib/storage', () => ({
  ...base,
  redis: () => recorded,
  rawRedis: () => recorded,
  // The Items' records, read through the recorder too.
  getItems: async (ctx: { container: string }) =>
    Object.values(((await recorded.hgetall<Record<string, unknown>>(ctxKey('plaid:items', ctx))) ?? {}) as Record<string, unknown>).map((v) => (typeof v === 'string' ? JSON.parse(v) : v)),
}));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, seedPerson, seedOther } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { OPERATIONS } = await import('@/lib/api-ops');
const { TOOLS } = await import('@/lib/mcp');
const { forgetEpochs } = await import('@/lib/sessions');
const { ownerContainer } = await import('@/lib/owners');
const { recordDirectory } = await import('@/lib/links');
const { EXACT, PREFIXES } = await import('@/lib/key-families');
const { declaredStore, declaredPublicStore, declaredStores, declaredPublicStores } = await import('@/lib/stores');
const { containerEntry, outsideEntry, families } = await import('@/lib/inventory');
const { gatherWeekly } = await import('@/lib/weekly-summary/gather');
const { prepareNotices } = await import('@/lib/connection-notices');
const mcp = await import('@/app/api/mcp/route');

const NOW = new Date(`${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`);

/** The family or store a key (inside a container, or the environment's)
 *  belongs to. */
function familyOf(key: string): string | null {
  if (Object.hasOwn(EXACT, key)) return key;
  for (const [prefix] of PREFIXES) if (key.startsWith(prefix)) return prefix;
  return declaredStore(key) || declaredPublicStore(key) ? key : null;
}

/** The families `run` reads: in the owner's container, and environment-wide. */
async function readsOf(run: () => Promise<unknown>): Promise<Set<string>> {
  touched.clear();
  recording = true;
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    await run();
  } finally {
    recording = false;
    [console.error, console.warn] = [error, warn];
  }
  const inside = ctxKey('');
  const env = testKey('');
  const out = new Set<string>();
  for (const key of touched) {
    if (key.startsWith(inside)) out.add(familyOf(key.slice(inside.length)) ?? `? ${key.slice(inside.length)}`);
    else if (key.startsWith(env) && !key.startsWith(testKey('c:'))) out.add(familyOf(key.slice(env.length)) ?? `? ${key.slice(env.length)}`);
  }
  return out;
}

const route = async (path: string, method: string, body?: unknown, query = '') => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}${query}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status as number, body: (await res.json()) as any };
};
const as = async <T>(user: string, fn: () => Promise<T>) => {
  clerk.signedIn = user;
  return fn();
};

const GOAL = '00000001-1d2e-4f5a-8b6c-7d8e9f0a1b2c';
let pair = '';
const saved = { ...process.env };
beforeEach(async () => {
  setSystemTime(NOW);
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
  process.env.CLERK_SECRET_KEY = 'sk_test_x';
  process.env.CLERK_ALLOWED_USER_IDS = 'user_owner,user_partner';
  await seedPerson(fake);
  await fake.hdel(ctxKey('plaid:items'), 'item_new');
  const seen = (account_id: string, name: string, type: string, subtype: string, mask: string) => ({ account_id, name, official_name: null, type, subtype, mask });
  await recordDirectory(ctx, [
    {
      item_id: 'item_chase',
      institution_name: 'Chase',
      institution_id: 'ins_3',
      error: null,
      accounts: [seen('acc_chk', 'Checking', 'depository', 'checking', '1111'), seen('acc_card', 'Card', 'credit', 'credit card', '2222'), seen('acc_save', 'Savings', 'depository', 'savings', '3333')],
    },
    { item_id: 'item_broker', institution_name: 'Broker', institution_id: 'ins_9', error: null, accounts: [seen('acc_ira', 'IRA', 'investment', 'ira', '4444')] },
  ] as any);
  expect(await ownerContainer('user_owner')).toBe(ctx.container);
  await seedOther(fake);
  await as('user_partner', () => route('shared', 'GET'));
  const invite = await as('user_owner', () => route('connections/invite', 'POST', {}));
  const accepted = await as('user_partner', () => route('connections/accept', 'POST', { token: invite.body.url.split('/connect/')[1], label: 'Alex' }));
  pair = accepted.body.id;
  const goals = await as('user_owner', () =>
    route('goals', 'PUT', { goals: [{ id: GOAL, name: 'Rainy day', target: 3000, account_id: 'acc_chk', plan: { allocation: 1000, monthly_target: 100, target_date: '2030-01-31' } }] })
  );
  expect(goals.status).toBe(200);
});
afterEach(() => {
  process.env = { ...saved };
  clerk.signedIn = null;
  setSystemTime();
});

/**
 * Families a path reads that are about letting it in, not about what it is
 * shown: the token and its count, the registry and the owners entry that
 * resolve the container, the address counts that refuse a bad token, the
 * restore record every read checks first, and the count of reads of what is
 * shared.
 */
const BOOKKEEPING = new Set(['api-tokens', 'api-requests', 'containers', 'owners', 'ratelimit:', 'user-restore', 'sharing-reads']);

/** Every family and store with an entry, and those claiming `seer`. */
const named = () => [...families(), ...declaredStores().map((s) => s.name), ...declaredPublicStores().map((s) => s.name)];
const claiming = (seer: 'shared' | 'api' | 'email') => named().filter((n) => ((containerEntry(n) ?? outsideEntry(n))?.seen ?? []).includes(seer)).sort();
const expected = (reads: Set<string>) => {
  expect([...reads].filter((f) => f.startsWith('? '))).toEqual([]);
  return [...reads].filter((f) => !BOOKKEEPING.has(f)).sort();
};

describe('who else can see each kind, as the code reads it', () => {
  test('programs given an API token: every family an endpoint or an MCP tool reads to answer, and no other', async () => {
    const { token } = await createToken(ctx, 'Tests', NOW, 'user_owner');
    const reads = new Set<string>();
    // Every endpoint, and the ones that read more for one account, for each kind of account.
    const asks: [string, string][] = OPERATIONS.map((op) => [op.name, op.name === 'me' ? '' : 'include_hidden=true']);
    for (const id of ['acc_chk', 'acc_ira', 'manual_house', 'acc_save']) asks.push(['balance-history', `account_id=${id}&include_estimated=true&include_hidden=true`]);
    asks.push(['holdings', 'account_id=acc_ira&include_hidden=true']);
    for (const [name, query] of asks) {
      const mod: any = await import(`@/app/api/v1/${name}/route`);
      let status = 0;
      for (const f of await readsOf(async () => {
        status = (await mod.GET(new Request(`https://nya.test/api/v1/${name}?${query}`, { headers: { authorization: `Bearer ${token}` } }))).status;
      }))
        reads.add(f);
      expect([name, query, status]).toEqual([name, query, 200]);
    }
    let id = 1;
    for (const tool of TOOLS) {
      let answer: any = null;
      for (const f of await readsOf(async () => {
        const res = await mcp.POST(
          new Request('https://nya.test/api/mcp', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: tool.name, arguments: {} } }),
          })
        );
        answer = await res.json();
      }))
        reads.add(f);
      expect([tool.name, answer?.result?.isError ?? false]).toEqual([tool.name, false]);
    }
    expect(claiming('api')).toEqual(expected(reads));
  });

  test('people you share with: every family read to show them everything at its widest, and to preview it, and no other', async () => {
    const every = { acc_chk: 'transactions', acc_card: 'transactions', acc_ira: 'transactions', manual_house: 'transactions', manual_wallet: 'transactions' };
    const views = {
      net_worth: { detail: 'history', accounts: true },
      spending: { detail: 'amounts', by: 'category' },
      holdings: { detail: 'amounts', positions: true },
      budgets: { detail: 'amounts', by: 'category' },
      goals: { detail: 'amounts', goals: [GOAL] },
    };
    expect((await as('user_owner', () => route('connections', 'PUT', { id: pair, accounts: every, views }))).status).toBe(200);
    let shown: any = null;
    const reads = new Set<string>([
      ...(await readsOf(async () => {
        shown = await as('user_partner', () => route('shared', 'GET'));
      })),
      ...(await readsOf(() => as('user_owner', () => route('connections/preview', 'GET', undefined, `?id=${encodeURIComponent(pair)}`)))),
    ]);
    // Everything was shown, so every path was taken.
    expect(shown.status).toBe(200);
    expect(Object.keys(shown.body.shared[0].views).sort()).toEqual(Object.keys(views).sort());
    expect(claiming('shared')).toEqual(expected(reads));
  });

  test('the email service: every family the weekly summary and the connection notices are gathered from, and no other', async () => {
    const reads = new Set<string>([
      ...(await readsOf(() => gatherWeekly(ctx, { now: NOW.getTime(), timeZone: 'UTC', weekday: 1 }))),
      // The notices name the banks the daily fetch found, from the Items'
      // records, which the summary reads too.
      ...(await readsOf(() => prepareNotices(ctx, [], { now: NOW.getTime() }))),
    ]);
    expect(reads.has('plaid:items')).toBe(true);
    expect(claiming('email')).toEqual(expected(reads));
  });

  test('what is about letting a path in claims no one', () => {
    for (const name of BOOKKEEPING) expect([name, (containerEntry(name) ?? outsideEntry(name))?.seen ?? []]).toEqual([name, []]);
  });
});
