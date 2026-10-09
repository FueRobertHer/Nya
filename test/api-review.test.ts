import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import './clerk-mock';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The read-only API and the MCP server, held to what their review checked by
// hand: what they write (their own bookkeeping only), what a damaged record
// elsewhere does to an answer (never a 500, never a total passed off as
// whole), the edges of their arguments, a cursor across midnight, how large an
// MCP answer may be, and that nothing of theirs imports the Plaid client.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
/** Every command sent, with its arguments, to tell reads from writes. */
const sent: { cmd: string; args: unknown[] }[] = [];
const recorded = new Proxy(fake, {
  get(target, prop, receiver) {
    const value = Reflect.get(target, prop, receiver);
    if (typeof value !== 'function' || typeof prop !== 'string') return value;
    return (...args: unknown[]) => {
      sent.push({ cmd: prop, args });
      return value.apply(target, args);
    };
  },
});
mock.module('@/lib/storage', () => ({ ...storageMock(fake), redis: () => recorded }));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { ctx, daysAgo, seedPerson } = await import('./api-fixture');
const { createToken } = await import('@/lib/api-tokens');
const { OPERATIONS } = await import('@/lib/api-ops');
const { TOOLS, RPC } = await import('@/lib/mcp');
const { forgetEpochs } = await import('@/lib/sessions');
const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { saveManualAccount } = await import('@/lib/manual');
const { recordHoldings, observeHoldings } = await import('@/lib/holdings-history');
const { MCP_MAX_PAGE_SIZE } = await import('@/lib/api-limits');
const mcpRoute = await import('@/app/api/mcp/route');
const routes: Record<string, any> = {};
for (const op of OPERATIONS) routes[op.name] = await import(`@/app/api/v1/${op.name}/route`);

const DAMAGED = 'not-ciphertext-but-long-enough-to-be-tried';

let token = '';
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  delete process.env.APP_URL;
  await registerTestContainer(fake);
  await seedPerson(fake);
  token = (await createToken(ctx, 'Review')).token;
  sent.length = 0;
  plaidTouched.length = 0;
});
afterEach(() => {
  process.env = { ...saved };
  setSystemTime();
  expect(plaidTouched).toEqual([]);
});

const call = async (name: string, query = '') => {
  const res: Response = await routes[name].GET(new Request(`https://nya.test/api/v1/${name}${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${token}` } }));
  return { res, body: (await res.json()) as any };
};
let nextId = 1;
const rpc = async (body: unknown, headers: Record<string, string> = {}) => {
  const res: Response = await mcpRoute.POST(
    new Request('https://nya.test/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  );
  const text = await res.text();
  return { res, body: text ? JSON.parse(text) : null };
};
const tool = async (name: string, args: Record<string, unknown> = {}) =>
  (await rpc({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })).body.result;
/** Console errors, kept quiet, and returned. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
}

const READS = new Set(['get', 'hget', 'hgetall', 'hkeys', 'hlen', 'hexists', 'mget', 'hmget', 'ttl', 'exists', 'scan', 'type', 'strlen', 'hvals']);
const READ_SCRIPTS = new Set(['-- nya:repo-read-entries', '-- nya:repo-read-entry-hashed', '-- nya:repo-counter-read']);
/** What a request wrote: the commands that aren't reads, a script by its name. */
function writes(): string[] {
  return sent.flatMap(({ cmd, args }) => {
    if (READS.has(cmd)) return [];
    if (cmd === 'eval' || cmd === 'evalsha') {
      const name = String(args[0] ?? '').split('\n')[0];
      return READ_SCRIPTS.has(name) ? [] : [`${name} ${JSON.stringify(args[1])}`];
    }
    return [`${cmd} ${JSON.stringify(args[0])}`];
  });
}

describe('what a request writes: its token’s bookkeeping, and nothing else', () => {
  // The count of its requests (a counter map store) and, at most once a
  // minute, when it was last used (the token's record).
  const allowed = new Set([`-- nya:repo-counters-take ${JSON.stringify([ctxKey('api-requests')])}`, `-- nya:repo-update-entry ${JSON.stringify([ctxKey('api-tokens')])}`]);

  test('every endpoint, with and without hidden accounts', async () => {
    for (const op of OPERATIONS) {
      for (const query of ['', ...(op.args.include_hidden ? ['include_hidden=true'] : [])]) {
        sent.length = 0;
        const { res } = await call(op.name, query);
        expect([op.name, query, res.status]).toEqual([op.name, query, 200]);
        expect([op.name, query, writes().filter((w) => !allowed.has(w))]).toEqual([op.name, query, []]);
      }
    }
  });

  test('every tool', async () => {
    for (const t of TOOLS) {
      sent.length = 0;
      const result = await tool(t.name, t.args.include_hidden ? { include_hidden: true } : {});
      expect([t.name, result.isError ?? false]).toEqual([t.name, false]);
      expect([t.name, writes().filter((w) => !allowed.has(w))]).toEqual([t.name, []]);
    }
  });
});

describe('a damaged record elsewhere', () => {
  test('of another Item: every answer stands, and accounts and net worth say what they are short of', async () => {
    await fake.hset(ctxKey('accounts:meta'), { item_broker: DAMAGED });
    await quietly(async () => {
      for (const [name, query] of [
        ['accounts', ''],
        ['net-worth', ''],
        ['balance-history', ''],
        ['balance-history', 'account_id=acc_chk'],
        ['balance-history', 'account_id=manual_house'],
        ['holdings', ''],
        ['transactions', ''],
      ]) {
        expect([name, query, (await call(name, query)).res.status]).toEqual([name, query, 200]);
      }
      const accounts = (await call('accounts')).body;
      expect(accounts.complete).toBe(false);
      expect(accounts.missing_accounts).toContainEqual({ institution: 'Broker', account_id: null, reason: 'unreadable' });
      const worth = (await call('net-worth')).body;
      expect(worth.complete).toBe(false);
      expect(worth.missing_accounts).toContainEqual({ institution: 'Broker', account_id: null, reason: 'unreadable' });
      // This account's own record is whole: its currency is still known.
      expect((await call('balance-history', 'account_id=acc_chk')).body.currency).toBe('USD');
      const history = await tool('get_balance_history', { account_id: 'acc_chk' });
      expect(history.isError ?? false).toBe(false);
      const sentence = (await tool('get_net_worth')).content[0].text;
      expect(sentence).toContain('Incomplete: the accounts of 1 connection couldn’t be read');
      expect(sentence).not.toContain('Broker');
    });
  });

  test('of a manual account: the others are counted, it is named by id, and the total says it is short', async () => {
    const whole = (await call('net-worth')).body;
    await fake.hset(ctxKey('manual:accounts'), { manual_wallet: DAMAGED });
    await quietly(async () => {
      const { body: accounts } = await call('accounts');
      expect(accounts.accounts.map((a: any) => a.id)).toContain('manual_house');
      expect(accounts.accounts.map((a: any) => a.id)).not.toContain('manual_wallet');
      expect(accounts.missing_accounts).toContainEqual({ institution: null, account_id: 'manual_wallet', reason: 'unreadable' });
      const worth = (await call('net-worth')).body;
      // The house still counts: only the wallet's 40 is missing, and the answer says so.
      expect(worth.totals[0].net_worth).toBe(whole.totals[0].net_worth - 40);
      expect(worth.complete).toBe(false);
      for (const id of ['acc_chk', 'manual_house']) {
        const { res, body } = await call('balance-history', `account_id=${id}`);
        expect([id, res.status, body.currency]).toEqual([id, 200, 'USD']);
      }
      expect((await tool('get_net_worth')).content[0].text).toContain('1 manual account couldn’t be read');
    });
  });

  test('a whole answer says it is whole', async () => {
    // The fixture's NewBank has never been loaded: a short answer, said so.
    expect((await call('net-worth')).body).toMatchObject({ complete: false, missing_accounts: [{ institution: 'NewBank', account_id: null, reason: 'not_loaded' }] });
    await fake.hdel(ctxKey('plaid:items'), 'item_new');
    expect((await call('accounts')).body).toMatchObject({ complete: true, missing_accounts: [] });
    expect((await call('net-worth')).body).toMatchObject({ complete: true, missing_accounts: [], accounts_without_balance: 0 });
    expect((await tool('get_net_worth')).content[0].text).not.toContain('Incomplete');
  });
});

describe('an account_id', () => {
  test('that no account has, or had, is a 404, never an empty history', async () => {
    const { res, body } = await call('balance-history', 'account_id=does_not_exist');
    expect(res.status).toBe(404);
    expect(body).toEqual({ error: { code: 'not_found', message: 'No account has that id. The ids are in /api/v1/accounts.' } });
    const result = await tool('get_balance_history', { account_id: 'does_not_exist' });
    expect(result.isError).toBe(true);
    expect((await call('holdings', 'account_id=does_not_exist')).res.status).toBe(404);
  });

  test('of an account with no history yet is an empty series, and holdings take one account', async () => {
    await saveManualAccount(ctx, { account_id: 'manual_new', name: 'New', institution_name: 'Cash', type: 'depository', subtype: null, balance: 5, updated_at: new Date().toISOString() });
    expect((await call('balance-history', 'account_id=manual_new')).body).toMatchObject({ account_id: 'manual_new', currency: 'USD', points: [], notes: [] });
    const { body } = await call('holdings', 'account_id=acc_ira');
    expect(body.accounts.map((a: any) => a.account_id)).toEqual(['acc_ira']);
  });
});

describe('the edges of arguments and messages', () => {
  test('a month before the year 1000 is refused, not read as the 1900s', async () => {
    const { res, body } = await call('spending', 'month=0050-01');
    expect(res.status).toBe(400);
    expect(body.error.message).toBe('month is a month, YYYY-MM.');
    expect((await call('spending', 'month=1999-02')).body).toMatchObject({ from: '1999-02-01', to: '1999-02-28' });
  });

  test('an MCP request id is a string or an integer; params an object', async () => {
    for (const id of [1.5, null, true]) {
      const { body } = await rpc({ jsonrpc: '2.0', id, method: 'ping' });
      expect([id, body.error.code]).toEqual([id, RPC.invalidRequest]);
    }
    expect((await rpc({ jsonrpc: '2.0', id: 7, method: 'ping' })).body.result).toEqual({});
    expect((await rpc({ jsonrpc: '2.0', id: 'x', method: 'tools/call', params: [] })).body.error.code).toBe(RPC.invalidParams);
  });

  test(`search_transactions pages are at most ${MCP_MAX_PAGE_SIZE}`, async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const search = body.result.tools.find((t: any) => t.name === 'search_transactions');
    expect(search.inputSchema.properties.limit.maximum).toBe(MCP_MAX_PAGE_SIZE);
    expect((await tool('search_transactions', { limit: MCP_MAX_PAGE_SIZE + 1 })).isError).toBe(true);
    expect((await call('transactions', `limit=${MCP_MAX_PAGE_SIZE + 1}`)).res.status).toBe(200); // the REST endpoint's are larger
  });

  test('get_net_worth reads the accounts and the history once, as the net-worth endpoint alone does', async () => {
    // The container's own data (the registry is read once per instance, for a few seconds).
    const mine = ctxKey('');
    const reads = () =>
      sent
        .filter(({ cmd, args }) => (cmd === 'hgetall' || cmd === 'hkeys') && typeof args[0] === 'string' && args[0].startsWith(mine))
        .map(({ cmd, args }) => `${cmd} ${args[0]}`)
        .sort();
    sent.length = 0;
    await call('net-worth');
    const once = reads();
    expect(once.length).toBeGreaterThan(0);
    sent.length = 0;
    await tool('get_net_worth');
    expect(reads()).toEqual(once);
  });

  test('a net worth from balances with no date says none', async () => {
    fake.reset();
    await registerTestContainer(fake);
    token = (await createToken(ctx, 'Review')).token;
    await saveManualAccount(ctx, { account_id: 'manual_cash', name: 'Cash', institution_name: 'Cash', type: 'depository', subtype: null, balance: 40, updated_at: '1970-01-01T00:00:00.000Z' });
    const sentence = (await tool('get_net_worth', { include_history: false })).content[0].text;
    expect(sentence).toBe('Net worth 40.00 USD.');
  });
});

describe('a page of transactions asked for after midnight (UTC)', () => {
  test('goes on with the range the first page had, defaults and all', async () => {
    setSystemTime(new Date(`${daysAgo(0)}T23:59:00.000Z`));
    const first = (await call('transactions', 'limit=2')).body;
    expect(first.has_more).toBe(true);
    setSystemTime(new Date(Date.parse(`${daysAgo(0)}T23:59:00.000Z`) + 2 * 60_000));
    const next = await call('transactions', `limit=2&cursor=${first.next_cursor}`);
    expect(next.res.status).toBe(200);
    expect([next.body.from, next.body.to]).toEqual([first.from, first.to]);
    expect(next.body.transactions[0].id).not.toBe(first.transactions[0].id);
    // A cursor still belongs to its query: other arguments are another query.
    expect((await call('transactions', `limit=2&q=coffee&cursor=${first.next_cursor}`)).res.status).toBe(400);
  });
});

describe('the MCP server', () => {
  test('takes a browser’s request only from this app’s own origin, APP_URL’s when it is set', async () => {
    process.env.APP_URL = 'https://money.example.org';
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await rpc(ping, { origin: 'https://money.example.org' })).res.status).toBe(200);
    expect((await rpc(ping, { origin: 'https://nya.test' })).res.status).toBe(403);
    delete process.env.APP_URL;
    expect((await rpc(ping, { origin: 'https://nya.test' })).res.status).toBe(200);
    expect((await rpc(ping)).res.status).toBe(200); // a client that isn't a browser sends none
  });

  test('refuses a result too large to send, saying how to ask for less', async () => {
    // Two brokerage accounts with thousands of positions each: together over the cap, each within it.
    const accounts = [
      { account_id: 'acc_big_a', name: 'Big A', type: 'investment', subtype: 'brokerage', mask: '0001' },
      { account_id: 'acc_big_b', name: 'Big B', type: 'investment', subtype: 'brokerage', mask: '0002' },
    ];
    await saveItem(ctx, { item_id: 'item_big', institution_name: 'Big Broker', encrypted_access_token: await encrypt('access-sandbox-big') });
    await fake.hset(ctxKey('accounts:meta'), {
      item_big: await encrypt(JSON.stringify(accounts.map((a) => ({ official_name: null, limit: null, currency: 'USD', ...a })))),
    });
    const securities = Array.from({ length: 2400 }, (_, i) => ({ security_id: `sec_${i}`, ticker_symbol: `T${i}`, name: `Security number ${i} with a longer name`, type: 'equity', is_cash_equivalent: false }));
    const holdings = accounts.flatMap((a) =>
      securities.map((s) => ({ account_id: a.account_id, security_id: s.security_id, quantity: 12.5, institution_price: 101.25, institution_price_as_of: daysAgo(1), institution_value: 1265.63, cost_basis: 1000, iso_currency_code: 'USD', unofficial_currency_code: null }))
    );
    const seen = accounts.map((a) => ({ account_id: a.account_id, type: 'investment', balance: 3_000_000 }));
    await recordHoldings(ctx, [{ error: null, accounts: seen, holdings_observed: observeHoldings({ accounts: seen, holdings, securities })! }]);

    const all = await tool('get_holdings');
    expect(all.isError).toBe(true);
    expect(all.content[0].text).toMatch(/^This answer is too large to send \(\d+\.\d MB\)\. Ask for one account at a time with account_id/);
    const one = await tool('get_holdings', { account_id: 'acc_big_a' });
    expect(one.isError ?? false).toBe(false);
    expect(one.structuredContent.accounts[0].positions).toHaveLength(2400);
  });
});

describe('nothing of the API’s imports the Plaid client', () => {
  test('the routes, the read layer and the MCP server', () => {
    const root = join(import.meta.dir, '..');
    const walk = (dir: string): string[] =>
      readdirSync(join(root, dir)).flatMap((name) => {
        const path = join(dir, name);
        return statSync(join(root, path)).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
      });
    const files = [...walk('app/api/v1'), ...walk('app/api/mcp'), ...readdirSync(join(root, 'lib')).filter((f) => /^(api-.*|mcp|activity)\.ts$/.test(f)).map((f) => join('lib', f))];
    expect(files.length).toBeGreaterThan(15);
    for (const file of files) {
      const src = readFileSync(join(root, file), 'utf8');
      expect([file, /from ['"](@\/lib\/plaid|\.\/plaid|plaid)['"]/.test(src)]).toEqual([file, false]);
    }
  });
});
