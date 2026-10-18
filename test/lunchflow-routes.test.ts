import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeLunchFlow, daysAgo, lfAccount, lfTxn } from './lunchflow-fake';
import { parseCsv } from './csv-parse';

// Lunch Flow through the routes the app calls (app/api/connectors) and
// everywhere its accounts and rows go afterwards, as SimpleFIN's do: Activity
// and its edits, transfers worked out between its accounts, net worth, rules,
// the read-only API and the MCP server, the data download (JSON, the
// transactions CSV and an OFX statement), and the reports' list of accounts let
// go. Then each route's answers by the storage seam's rules (no container: 503;
// what can't be read: 409), every input refused that isn't one, another
// container's connection out of reach, and the key never in an answer, a log
// or the download.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// Connecting Lunch Flow is off unless the deployment turns it on (lib/connectors/switch.ts).
process.env.LUNCHFLOW_ENABLED = '1';

const plaidCalls: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get: (_target, name) => async () => {
        plaidCalls.push(String(name));
        throw new Error('Plaid must not be called');
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { setTransportForTests } = await import('@/lib/connectors/http');
const { setLunchFlowApiForTests } = await import('@/lib/connectors/lunchflow');
const { forgetEpochs } = await import('@/lib/sessions');
const { connectionsStore, connectorAccountsStore } = await import('@/lib/connectors/store');
const { connect, trackAccounts } = await import('@/lib/connectors/manage');
const { createToken } = await import('@/lib/api-tokens');
const { collectUserData, buildUserExport, exportFile, notIncluded, TRANSACTION_COLUMNS } = await import('@/lib/user-export');
const { ofxFile } = await import('@/lib/ofx-export');
const { snapshotData } = await import('@/lib/snapshot-job');
const connectors = await import('@/app/api/connectors/route');
const connectRoute = await import('@/app/api/connectors/connect/route');
const accountsRoute = await import('@/app/api/connectors/accounts/route');
const refreshRoute = await import('@/app/api/connectors/refresh/route');
const endedRoute = await import('@/app/api/connectors/ended/route');
const transactions = await import('@/app/api/transactions/route');
const manualTxns = await import('@/app/api/manual-transactions/route');
const recategorize = await import('@/app/api/recategorize/route');
const netWorth = await import('@/app/api/net-worth/route');
const rulesRoute = await import('@/app/api/rules/route');
const mcp = await import('@/app/api/mcp/route');

const ctx = TEST_CTX;
const OTHER = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;

let server: FakeLunchFlow;
beforeAll(async () => {
  server = await FakeLunchFlow.start();
});
afterAll(() => {
  setTransportForTests(null);
  setLunchFlowApiForTests(null);
  server.stop();
});

let token = '';
beforeEach(async () => {
  fake.reset();
  server.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  setTransportForTests(server.transport());
  setLunchFlowApiForTests(server.base());
  plaidCalls.length = 0;
  token = (await createToken(ctx, 'Tests')).token;
  server.accounts = [
    lfAccount({
      id: 1470,
      name: 'Everyday',
      institution_name: 'Monzo',
      balance: { amount: 1520.4, currency: 'GBP' },
      transactions: [lfTxn('t-coffee', 3, -3.2, 'Pret A Manger'), lfTxn('t-salary', 10, 2500, 'ACME LTD')],
    }),
    lfAccount({ id: 1471, name: 'Credit Card', institution_name: 'Monzo', balance: { amount: -432.1, currency: 'GBP' }, transactions: [lfTxn('t-diner', 2, -45.67, 'Dishoom')] }),
  ];
});
afterEach(() => expect(plaidCalls).toEqual([]));

type Handler = (req: Request) => Promise<Response>;
async function call(handler: Handler, method: string, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  const res = await handler(new Request('http://localhost/api/test', { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const list = async () => {
  const res = await connectors.GET();
  return { status: res.status, body: await res.json() };
};
const activity = async () => (await (await transactions.GET(new Request('http://localhost/api/transactions'))).json());

/** Connects with the fake's key through the route and tracks both accounts. */
async function connectAndTrack(): Promise<string> {
  const made = await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: server.key });
  expect(made.status).toBe(200);
  const tracked = await call(accountsRoute.PUT, 'PUT', {
    connection_id: made.body.connection_id,
    track: [
      { remote_id: '1470', type: 'depository' },
      { remote_id: '1471', type: 'credit' },
    ],
  });
  expect(tracked.status).toBe(200);
  return made.body.connection_id;
}

/** One REST endpoint of the read-only API, as a client calls it. */
async function rest(name: string, query = ''): Promise<{ status: number; body: any }> {
  const route = await import(`@/app/api/v1/${name}/route`);
  const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${name}?${query}`, { headers: { authorization: `Bearer ${token}` } }));
  return { status: res.status, body: await res.json() };
}

let nextId = 1;
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; data: any }> {
  const res: Response = await mcp.POST(
    new Request('https://nya.test/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
    })
  );
  const result = (await res.json()).result;
  return { text: result.content[0].text, data: result.structuredContent };
}

/** Runs `fn` with console output collected instead of printed. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const saved = [console.error, console.warn, console.log, console.info];
  const lines: string[] = [];
  console.error = console.warn = console.log = console.info = (...a: unknown[]) =>
    lines.push(a.map((x) => (x instanceof Error ? `${x.name} ${x.message} ${x.stack} ${JSON.stringify(x)}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  try {
    return { result: await fn(), logged: lines.join('\n') };
  } finally {
    [console.error, console.warn, console.log, console.info] = saved;
  }
}

describe('connecting through the routes', () => {
  test('lists what Lunch Flow offers with its balances, to choose from, and keeps none of those balances', async () => {
    const made = await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: server.key });
    expect(made.status).toBe(200);
    expect(made.body.offers.map((o: any) => [o.remote_id, o.name, o.institution, o.currency, o.balance, o.balance_at])).toEqual([
      ['1470', 'Everyday', 'Monzo', 'GBP', 1520.4, null],
      ['1471', 'Credit Card', 'Monzo', 'GBP', -432.1, null],
    ]);
    expect(made.body.connection).toMatchObject({ connector: 'lunchflow', label: 'Lunch Flow', host: `bridge.test:${server.port}`, site: `https://bridge.test:${server.port}/`, accounts: [] });
    const { body } = await list();
    expect(body.connections[0].available.map((a: any) => a.balance)).toEqual([undefined, undefined]);
    expect(body.requests).toMatchObject({ left: 7, limit: 8 });
    // Never the key.
    expect(made.text).not.toContain(server.key);
    expect(JSON.stringify(body)).not.toContain(server.key);
  });

  test('a key Lunch Flow refuses, one that isn’t a key, and one too long are each refused in words for the person', async () => {
    const refused = await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: 'lf_this_key_is_wrong_00' });
    expect([refused.status, refused.body.kind, refused.body.error]).toEqual([409, 'claimed', expect.stringContaining('didn’t accept this API key')]);
    const bad = await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: 'hello' });
    expect([bad.status, bad.body.kind]).toEqual([400, 'invalid']);
    const empty = await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: '  ' });
    expect([empty.status, empty.body.error]).toEqual([400, 'Paste the API key from Lunch Flow']);
    const long = await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: 'k'.repeat(800) });
    expect([long.status, long.body.error]).toEqual([400, 'That is too long to be a Lunch Flow API key']);
    expect((await list()).body.connections).toEqual([]);
  });

  test('a new key for a connection Lunch Flow no longer accepts carries its accounts on; one for another kind is refused', async () => {
    const id = await connectAndTrack();
    server.keys.clear();
    server.keys.add('lf_replacement_key_123456');
    const refreshed = await call(refreshRoute.POST, 'POST', { connection_id: id });
    expect(refreshed.body.connection.last_fetch).toMatchObject({ ok: false, kind: 'refused' });
    const wrongKind = await call(connectRoute.POST, 'POST', { connector: 'simplefin', token: 'aGVsbG8gd29ybGQ=', connection_id: id });
    expect(wrongKind.status).toBe(400);
    const again = await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: 'lf_replacement_key_123456', connection_id: id });
    expect([again.status, again.body.connection.last_fetch.ok, again.body.connection.accounts.length]).toEqual([200, true, 2]);
  });

  test('tracks, refreshes, retypes, stops one and disconnects', async () => {
    const id = await connectAndTrack();
    let { body } = await list();
    const conn = body.connections[0];
    expect(conn.accounts.map((a: any) => [a.name, a.type, a.balance, a.currency])).toEqual([
      ['Credit Card', 'credit', 432.1, 'GBP'],
      ['Everyday', 'depository', 1520.4, 'GBP'],
    ]);
    expect(conn.last_fetch).toMatchObject({ ok: true, added: 3, problems: [], missing: [] });
    server.accounts[0].transactions.push(lfTxn('t-gum', 0, -1, 'Newsagent'));
    const refreshed = await call(refreshRoute.POST, 'POST', { connection_id: id });
    expect([refreshed.status, refreshed.body.connection.last_fetch.added]).toEqual([200, 1]);
    const card = conn.accounts.find((a: any) => a.name === 'Credit Card');
    const retyped = await call(accountsRoute.PUT, 'PUT', { connection_id: id, retype: [{ account_id: card.account_id, type: 'loan' }] });
    expect([retyped.status, retyped.body.retyped]).toEqual([200, 1]);
    const stopped = await call(accountsRoute.PUT, 'PUT', { connection_id: id, stop: { account_ids: [card.account_id], keep: false } });
    expect([stopped.status, stopped.body.removed]).toEqual([200, 1]);
    ({ body } = await list());
    expect(body.connections[0].accounts.map((a: any) => a.name)).toEqual(['Everyday']);
    const gone = await call(connectors.DELETE, 'DELETE', { connection_id: id });
    expect([gone.status, gone.body.kept]).toEqual([200, 1]);
    ({ body } = await list());
    expect(body.connections).toEqual([]);
    // What was let go is listed, by its connector, on the Reports page.
    const ended = await (await endedRoute.GET()).json();
    expect(ended.accounts.map((a: any) => [a.name, a.connector, a.kept]).sort()).toEqual([
      ['Credit Card', 'Lunch Flow', false],
      ['Everyday', 'Lunch Flow', true],
    ]);
  });

  test('Refresh is refused once the day’s requests are spent, saying when they come back', async () => {
    const id = await connectAndTrack();
    let last = await call(refreshRoute.POST, 'POST', { connection_id: id });
    for (let i = 0; i < 10 && last.status === 200; i++) last = await call(refreshRoute.POST, 'POST', { connection_id: id });
    expect(last.status).toBe(429);
    expect(last.body.error).toContain("today's 8 requests for your own sync");
    expect(last.body.error).toContain('Lunch Flow updates about once a day');
  });
});

describe('the switch (LUNCHFLOW_ENABLED, lib/connectors/switch.ts)', () => {
  afterEach(() => {
    process.env.LUNCHFLOW_ENABLED = '1';
  });

  test('off, a new connection is refused before anything is counted or sent; on, it connects', async () => {
    for (const value of [undefined, '0', 'true']) {
      if (value === undefined) delete process.env.LUNCHFLOW_ENABLED;
      else process.env.LUNCHFLOW_ENABLED = value;
      const off = await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: server.key });
      expect([value, off.status, off.body.error]).toEqual([value, 403, "Connecting Lunch Flow isn't turned on for this copy of Nya."]);
    }
    expect(server.seen).toEqual([]);
    expect(await fake.get(ctxKey('connector-claims', ctx))).toBeNull();
    expect((await list()).body.connections).toEqual([]);
    process.env.LUNCHFLOW_ENABLED = '1';
    expect((await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: server.key })).status).toBe(200);
  });

  test('turned off later, a connection made keeps working: listed, refreshed, connected again, chosen from and disconnected', async () => {
    const id = await connectAndTrack();
    delete process.env.LUNCHFLOW_ENABLED;
    expect((await list()).body.connections.map((c: any) => [c.connector, c.accounts.length])).toEqual([['lunchflow', 2]]);
    server.accounts[0].transactions.push(lfTxn('t-gum', 0, -1, 'Newsagent'));
    const refreshed = await call(refreshRoute.POST, 'POST', { connection_id: id });
    expect([refreshed.status, refreshed.body.connection.last_fetch.ok, refreshed.body.connection.last_fetch.added]).toEqual([200, true, 1]);
    server.keys.clear();
    server.keys.add('lf_replacement_key_123456');
    const again = await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: 'lf_replacement_key_123456', connection_id: id });
    expect([again.status, again.body.connection.last_fetch.ok]).toEqual([200, true]);
    const everyday = again.body.connection.accounts.find((a: any) => a.name === 'Everyday');
    const stopped = await call(accountsRoute.PUT, 'PUT', { connection_id: id, stop: { account_ids: [everyday.account_id], keep: true } });
    expect(stopped.status).toBe(200);
    const gone = await call(connectors.DELETE, 'DELETE', { connection_id: id });
    expect(gone.status).toBe(200);
    // But no new one.
    expect((await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: 'lf_replacement_key_123456' })).status).toBe(403);
  });
});

describe('the routes, by the storage seam’s rules', () => {
  test('refuse what isn’t an input, and accounts that aren’t this connection’s', async () => {
    const id = await connectAndTrack();
    for (const body of [
      { connection_id: 'nope' },
      { connection_id: id, track: [{ remote_id: '1470', type: 'savings' }] },
      { connection_id: id, track: 'all' },
      { connection_id: id, retype: [{ account_id: 'plaid-id', type: 'credit' }] },
      { connection_id: id, stop: { account_ids: [], keep: 'yes' } },
      { connection_id: id, stop: { account_ids: ['manual_someone-else'] } },
      { connection_id: id, sign: [{ account_id: 'manual_someone-else', sign: 'as_reported' }] },
    ]) {
      expect([JSON.stringify(body), (await call(accountsRoute.PUT, 'PUT', body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    for (const body of [{ connector: 'lunchflow' }, { connector: 'lunchflow', token: 42 }, { connector: 'lunchfl0w', token: server.key }, { connector: 'lunchflow', token: server.key, connection_id: 'x' }]) {
      expect([JSON.stringify(body).replace(server.key, 'KEY'), (await call(connectRoute.POST, 'POST', body)).status]).toEqual([JSON.stringify(body).replace(server.key, 'KEY'), 400]);
    }
    const huge = await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: 'k'.repeat(20_000) });
    expect(huge.status).toBe(413);
    expect((await call(refreshRoute.POST, 'POST', { connection_id: 'conn_00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await call(connectors.DELETE, 'DELETE', { connection_id: id, keep: 'no' })).status).toBe(400);
  });

  test('no container: 503 from every route', async () => {
    const id = await connectAndTrack();
    await registerTestContainer(fake, 'restoring');
    forgetEpochs();
    expect((await connectors.GET()).status).toBe(503);
    expect((await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: server.key })).status).toBe(503);
    expect((await call(accountsRoute.PUT, 'PUT', { connection_id: id })).status).toBe(503);
    expect((await call(refreshRoute.POST, 'POST', { connection_id: id })).status).toBe(503);
    expect((await call(connectors.DELETE, 'DELETE', { connection_id: id })).status).toBe(503);
    expect((await endedRoute.GET()).status).toBe(503);
  });

  test('what can’t be read is a 409 that says so, never taken for none', async () => {
    const id = await connectAndTrack();
    await fake.hset(ctxKey('connector-connections'), { [id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const { result } = await quietly(async () => ({ list: await connectors.GET(), stop: await call(connectors.DELETE, 'DELETE', { connection_id: id }) }));
    expect(result.list.status).toBe(409);
    expect(await result.list.json()).toMatchObject({ unreadable: true, unreadable_ids: [id] });
    expect(result.stop.status).toBe(409);
    // Nothing went: its accounts are all still there.
    expect(await connectorAccountsStore.count(ctx)).toBe(2);
  });

  test('another container’s connection is out of reach: not refreshed, not listed, not let go', async () => {
    server.keys.add('lf_other_persons_key_0001');
    const { connection_id: theirs } = await connect(OTHER, 'lunchflow', 'lf_other_persons_key_0001');
    await trackAccounts(OTHER, theirs, [{ remote_id: '1470', type: 'depository' }]);
    expect((await call(refreshRoute.POST, 'POST', { connection_id: theirs })).status).toBe(404);
    expect((await list()).body.connections).toEqual([]);
    const [account] = [...(await connectorAccountsStore.getAll(OTHER)).keys()];
    expect((await call(accountsRoute.PUT, 'PUT', { connection_id: theirs, stop: { account_ids: [account], keep: false } })).status).toBe(400);
    await call(connectors.DELETE, 'DELETE', { connection_id: theirs, keep: false });
    expect(await connectionsStore.get(OTHER, theirs)).not.toBeNull();
    expect(await connectorAccountsStore.count(OTHER)).toBe(1);
  });
});

describe('everywhere else, as SimpleFIN’s are', () => {
  test('Activity lists their rows from Lunch Flow; their category changes, their amount and their deletion are refused', async () => {
    await connectAndTrack();
    const coffee = (await activity()).transactions.find((t: any) => t.name === 'Pret A Manger');
    expect(coffee).toMatchObject({ amount: 3.2, source: 'lunchflow', institution_name: 'Monzo', account_name: 'Everyday', iso_currency_code: 'GBP', pending: false, date: daysAgo(3) });
    expect((await call(recategorize.POST, 'POST', { transaction_id: coffee.transaction_id, category: 'Food', account_id: coffee.account_id })).status).toBe(200);
    const edit = await call(manualTxns.PATCH, 'PATCH', { id: coffee.transaction_id, account_id: coffee.account_id, amount: 1 });
    expect([edit.status, edit.body.error]).toEqual([400, expect.stringContaining('came from your bank through Lunch Flow')]);
    const del = await call(manualTxns.DELETE, 'DELETE', { id: coffee.transaction_id, account_id: coffee.account_id });
    expect([del.status, del.body.error]).toEqual([400, expect.stringContaining('through Lunch Flow')]);
    const after = (await activity()).transactions.find((t: any) => t.transaction_id === coffee.transaction_id);
    expect([after.category, after.amount]).toEqual(['food', 3.2]);
  });

  test('a payment from the current account to the card is a card payment, left out of totals; the rest say they have no category, from Lunch Flow', async () => {
    server.accounts[0].transactions.push(lfTxn('p-out', 2, -300, 'MONZO CARD'));
    server.accounts[1].transactions.push(lfTxn('p-in', 1, 300, 'PAYMENT RECEIVED'));
    await connectAndTrack();
    const rows = (await activity()).transactions;
    const shown = (name: string) => {
      const t = rows.find((r: any) => r.name === name);
      return [t?.category, t?.subcategory, t?.paired ?? null];
    };
    expect(shown('MONZO CARD')).toEqual(['loan payments', 'credit card payment', 'card']);
    expect(shown('PAYMENT RECEIVED')).toEqual(['loan payments', 'credit card payment', 'card']);
    const { uncategorizedFrom, uncategorizedFromConnector, uncategorizedNote } = await import('@/lib/spending');
    expect(uncategorizedFromConnector(rows)).toBe(3);
    expect(uncategorizedNote(uncategorizedFromConnector(rows), uncategorizedFrom(rows))).toContain('3 transactions from Lunch Flow have no category');
  });

  test('net worth shows them under their bank, via Lunch Flow, as of when Nya received the balances, and the nightly snapshot records the day', async () => {
    const id = await connectAndTrack();
    const body = await (await netWorth.GET(new Request('http://localhost/api/net-worth?refresh=1'))).json();
    const bank = body.institutions.find((i: any) => i.institution_name === 'Monzo');
    expect(bank).toMatchObject({ connector: 'lunchflow', manual: true, error: null, health: { state: 'healthy', cause: 'connector', detail: { label: 'Lunch Flow' } } });
    expect(bank.accounts.map((a: any) => [a.name, a.balance, a.currency])).toEqual([
      ['Credit Card', 432.1, 'GBP'],
      ['Everyday', 1520.4, 'GBP'],
    ]);
    const fetched = (await connectorAccountsStore.getAll(ctx)).values().next().value!.fetched_at;
    expect(bank.accounts.every((a: any) => a.updated_at === fetched)).toBe(true);
    await connectionsStore.update(ctx, id, (c) => (c ? { ...c, last_answer_at: new Date(Date.now() - 13 * 3_600_000).toISOString() } : c));
    const outcome = await snapshotData(ctx, []);
    expect(outcome.status).toBe('recorded');
    // The recent window, then the older one, for the tracked accounts only.
    expect(server.requests('transactions').slice(-4).map((r) => r.path)).toEqual([
      '/api/v1/accounts/1470/transactions',
      '/api/v1/accounts/1471/transactions',
      '/api/v1/accounts/1470/transactions',
      '/api/v1/accounts/1471/transactions',
    ]);
  });

  test('a rule takes Lunch Flow as a source, and files its rows', async () => {
    await connectAndTrack();
    const saved = await call(rulesRoute.POST, 'POST', {
      action: 'add',
      rule: {
        conditions: [
          { field: 'source', op: 'equals', value: 'lunchflow' },
          { field: 'name', op: 'contains', value: 'pret' },
        ],
        actions: { set_name: 'Pret' },
      },
    });
    expect(saved.status).toBe(200);
    const coffee = (await activity()).transactions.find((t: any) => t.name === 'Pret');
    expect(coffee).toMatchObject({ name: 'Pret', name_before_rules: 'Pret A Manger', source: 'lunchflow' });
    // A source the rules don't know is refused, as before.
    const odd = await call(rulesRoute.POST, 'POST', { action: 'add', rule: { conditions: [{ field: 'source', op: 'equals', value: 'lunchfl0w' }], actions: { hide: true } } });
    expect(odd.status).toBe(400);
  });

  test('the read-only API and the MCP server serve them with source lunchflow, in Nya’s sign', async () => {
    await connectAndTrack();
    const accounts = (await rest('accounts')).body;
    expect(accounts.accounts.map((a: any) => [a.name, a.source, a.balance, a.currency, a.is_debt])).toEqual([
      ['Credit Card', 'lunchflow', 432.1, 'GBP', true],
      ['Everyday', 'lunchflow', 1520.4, 'GBP', false],
    ]);
    const rows = (await rest('transactions')).body;
    expect(rows.transactions.find((t: any) => t.name === 'Pret A Manger')).toMatchObject({ source: 'lunchflow', amount: 3.2 });
    // Older history comes with the next daily update: said as Lunch Flow's.
    expect(rows.notes).toContain('Monzo: older transactions are still arriving from Lunch Flow, with its next daily update');
    const holdings = await rest('holdings', `account_id=${accounts.accounts[1].id}`);
    expect([holdings.status, holdings.body.error.message]).toEqual([404, 'That account is kept up to date through Lunch Flow, and Nya reads its balance, not its positions: it has no holdings.']);
    // An entry that can't be read is named under missing_accounts, by its connector.
    const [first] = [...(await connectorAccountsStore.getAll(ctx)).keys()];
    await fake.hset(ctxKey('connector-accounts'), { [first]: 'damaged' });
    const short = (await rest('accounts')).body;
    expect(short.missing_accounts).toEqual([{ institution: null, account_id: first, reason: 'unreadable', source: 'lunchflow' }]);
    expect(short.notes).toContain('An account Lunch Flow keeps up to date couldn’t be read, so it isn’t listed');
    expect((await tool('list_accounts')).text).toContain('1 Lunch Flow account couldn’t be read');
  });

  test('the download lists them with Lunch Flow as their provider, never the key; the CSV and the OFX statement carry their rows', async () => {
    const id = await connectAndTrack();
    const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
    expect(doc.institutions).toEqual([{ item_id: id, institution_name: `Lunch Flow (bridge.test:${server.port})`, institution_id: null, provider: 'lunchflow' }]);
    expect(doc.accounts.map((a) => [a.name, a.provider, a.item_id, a.institution_name, a.type, a.currency, a.connected])).toEqual([
      ['Credit Card', 'lunchflow', id, 'Monzo', 'credit', 'GBP', true],
      ['Everyday', 'lunchflow', id, 'Monzo', 'depository', 'GBP', true],
    ]);
    expect((doc['manual-transactions'] as any[]).flatMap((b) => b.value.rows).map((r: any) => [r.source, r.source_id]).sort()).toEqual([
      ['lunchflow', 't-coffee'],
      ['lunchflow', 't-diner'],
      ['lunchflow', 't-salary'],
    ]);
    expect(notIncluded(false)).toContain('The Lunch Flow API key you gave Nya when you connected it: a credential, which reads your accounts there, not your data. Delete its API destination in Lunch Flow to end it.');
    const text = JSON.stringify(doc);
    expect(text).not.toContain(server.key);
    expect(text).not.toContain('connector-secrets');
    // The transactions CSV: every row, with its account and bank.
    const csv = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
    const header = csv[0];
    const named = csv.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
    expect(named.filter((r) => r.source === 'lunchflow').map((r) => r.name).sort()).toEqual(['ACME LTD', 'Dishoom', 'Pret A Manger']);
    expect(header).toEqual([...TRANSACTION_COLUMNS]);
    // An OFX statement of the current account, with its balance and Lunch Flow's words.
    const everyday = doc.accounts.find((a) => a.name === 'Everyday')!;
    const data = await collectUserData({ ctx, userId: null });
    const ofx = ofxFile(data, buildUserExport(data, new Date()), everyday.account_id, new Date());
    if ('refused' in ofx) throw new Error(ofx.refused);
    expect([...ofx.file.pieces()].join('')).toContain('<TRNAMT>-3.20');
    expect(ofx.file.notes.join(' ')).toContain('Lunch Flow is still bringing in older transactions, with its next daily update');
  });
});

describe('the key', () => {
  test('never reaches a log, an answer, the download or storage in the clear, whatever fails', async () => {
    const leaks: string[] = [];
    const check = (where: string, text: string) => {
      if (text.includes(server.key)) leaks.push(where);
    };
    const { logged } = await quietly(async () => {
      const id = await connectAndTrack();
      for (const b of [
        { on: 'accounts' as const, status: 403, body: JSON.stringify({ error: 'Forbidden', message: `bad key ${server.key}` }) },
        { on: 'accounts' as const, status: 500, body: JSON.stringify({ message: `key ${server.key} rejected` }) },
        { on: 'balance' as const, status: 503, body: JSON.stringify({ message: `${server.key} limited` }) },
        { on: 'accounts' as const, status: 200, body: 'not json at all' },
        { on: 'accounts' as const, location: 'https://elsewhere.example/collect' },
      ]) {
        server.behaviours = [b];
        const route = await call(refreshRoute.POST, 'POST', { connection_id: id });
        check(`refresh (${route.status})`, route.text);
        check('connections list', JSON.stringify((await list()).body));
        check('net worth', JSON.stringify(await (await netWorth.GET(new Request('http://localhost/api/net-worth?refresh=1'))).json()));
      }
      server.behaviours = [{ on: 'accounts', status: 500, body: JSON.stringify({ message: `${server.key} broke` }) }];
      check('failed connect', (await call(connectRoute.POST, 'POST', { connector: 'lunchflow', token: server.key })).text);
      server.behaviours = [];
      check('download', JSON.stringify(buildUserExport(await collectUserData({ ctx, userId: null }), new Date())));
      check('api', JSON.stringify((await rest('accounts')).body));
    });
    check('logs', logged);
    check('storage', JSON.stringify([[...(fake as any).hashes.entries()].map(([k, h]: [string, Map<string, string>]) => [k, [...h]]), [...(fake as any).strings.entries()]]));
    expect(leaks).toEqual([]);
  }, 30_000);
});
