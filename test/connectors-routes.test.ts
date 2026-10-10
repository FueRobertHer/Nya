import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount, type FakeTxn } from './simplefin-fake';

// The connector routes (app/api/connectors) as the app calls them, against a
// local fake SimpleFIN server, and what SimpleFIN's accounts are everywhere
// else: Activity, sharing, the data download. Then the two promises that
// hold everywhere: the Access URL never reaches a log, an error or an answer,
// and nothing here ever calls Plaid.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

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

const { setTransportForTests } = await import('@/lib/connectors/http');
const { forgetEpochs } = await import('@/lib/sessions');
const { connectorAccountsStore, connectionsStore } = await import('@/lib/connectors/store');
const { shareableAccounts } = await import('@/lib/sharing');
const { collectUserData, buildUserExport, countAccounts } = await import('@/lib/user-export');
const { syncConnectorsDaily } = await import('@/lib/connectors/sync');
const { snapshotData } = await import('@/lib/snapshot-job');
const connectors = await import('@/app/api/connectors/route');
const connectRoute = await import('@/app/api/connectors/connect/route');
const accountsRoute = await import('@/app/api/connectors/accounts/route');
const refreshRoute = await import('@/app/api/connectors/refresh/route');
const transactions = await import('@/app/api/transactions/route');
const manualTxns = await import('@/app/api/manual-transactions/route');
const recategorize = await import('@/app/api/recategorize/route');
const netWorth = await import('@/app/api/net-worth/route');

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
beforeEach(async () => {
  fake.reset();
  server.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  setTransportForTests(server.transport());
  plaidCalls.length = 0;
  server.accounts = [
    fakeAccount({ id: 'CHK', name: 'Checking', balance: '1500.25', 'balance-date': ago(1), transactions: [txn('c1', 3, '-12.50', 'COFFEE'), txn('c2', 10, '2500.00', 'PAYROLL')] }),
    fakeAccount({ id: 'CARD', name: 'Visa', balance: '-432.10', 'balance-date': ago(1), transactions: [txn('v1', 2, '-45.67', 'DINER')] }),
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

/** Connects through the route and tracks both accounts. */
async function connectAndTrack(): Promise<string> {
  const made = await call(connectRoute.POST, 'POST', { connector: 'simplefin', token: server.setupToken(`t${Math.random()}`) });
  expect(made.status).toBe(200);
  const tracked = await call(accountsRoute.PUT, 'PUT', {
    connection_id: made.body.connection_id,
    track: [
      { remote_id: 'CHK', type: 'depository' },
      { remote_id: 'CARD', type: 'credit' },
    ],
  });
  expect(tracked.status).toBe(200);
  return made.body.connection_id;
}

/** Runs `fn` with console output collected instead of printed. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const saved = [console.error, console.warn, console.log, console.info];
  const lines: string[] = [];
  const keep = (...a: unknown[]) =>
    lines.push(a.map((x) => (x instanceof Error ? `${x.name} ${x.message} ${x.stack} ${JSON.stringify(x)}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.error = console.warn = console.log = console.info = keep;
  try {
    return { result: await fn(), logged: lines.join('\n') };
  } finally {
    [console.error, console.warn, console.log, console.info] = saved;
  }
}

describe('connecting through the routes', () => {
  test('lists what SimpleFIN offers with its balances, to choose from, and keeps none of those balances', async () => {
    const made = await call(connectRoute.POST, 'POST', { connector: 'simplefin', token: server.setupToken('one') });
    expect(made.status).toBe(200);
    expect(made.body.offers.map((o: any) => [o.remote_id, o.name, o.institution, o.balance])).toEqual([
      ['CHK', 'Checking', 'My Bank', 1500.25],
      ['CARD', 'Visa', 'My Bank', -432.1],
    ]);
    expect(made.body.connection).toMatchObject({ label: 'SimpleFIN', host: `bridge.test:${server.port}`, site: `https://bridge.test:${server.port}/`, accounts: [] });
    const { body } = await list();
    expect(body.connections[0].available.map((a: any) => a.balance)).toEqual([undefined, undefined]);
    expect(body.requests).toMatchObject({ left: 7, limit: 8 });
  });

  test('a token used already, or not a token, is refused in words for the person', async () => {
    const token = server.setupToken('once');
    await call(connectRoute.POST, 'POST', { connector: 'simplefin', token });
    const again = await call(connectRoute.POST, 'POST', { connector: 'simplefin', token });
    expect([again.status, again.body.kind]).toEqual([409, 'claimed']);
    expect(again.body.error).toContain('already been used');
    const bad = await call(connectRoute.POST, 'POST', { connector: 'simplefin', token: 'hello' });
    expect([bad.status, bad.body.kind]).toEqual([400, 'invalid']);
    const unknown = await call(connectRoute.POST, 'POST', { connector: 'plaid', token: server.setupToken('x') });
    expect(unknown.status).toBe(400);
    const long = await call(connectRoute.POST, 'POST', { connector: 'simplefin', token: 'A'.repeat(20_000) });
    expect(long.status).toBe(413);
  });

  test('tracks, refreshes, retypes, stops one and disconnects', async () => {
    const id = await connectAndTrack();
    let { body } = await list();
    const conn = body.connections[0];
    expect(conn.accounts.map((a: any) => [a.name, a.type, a.balance])).toEqual([
      ['Checking', 'depository', 1500.25],
      ['Visa', 'credit', 432.1],
    ]);
    expect(conn.last_fetch).toMatchObject({ ok: true, added: 3, problems: [], missing: [] });
    server.accounts[0].transactions.push(txn('c3', 0, '-1.00', 'GUM'));
    const refreshed = await call(refreshRoute.POST, 'POST', { connection_id: id });
    expect([refreshed.status, refreshed.body.connection.last_fetch.added]).toEqual([200, 1]);

    const card = conn.accounts.find((a: any) => a.name === 'Visa');
    const retyped = await call(accountsRoute.PUT, 'PUT', { connection_id: id, retype: [{ account_id: card.account_id, type: 'loan' }] });
    expect([retyped.status, retyped.body.retyped]).toEqual([200, 1]);
    const stopped = await call(accountsRoute.PUT, 'PUT', { connection_id: id, stop: { account_ids: [card.account_id], keep: false } });
    expect([stopped.status, stopped.body.removed]).toEqual([200, 1]);
    ({ body } = await list());
    expect(body.connections[0].accounts.map((a: any) => a.name)).toEqual(['Checking']);

    const gone = await call(connectors.DELETE, 'DELETE', { connection_id: id });
    expect([gone.status, gone.body.kept]).toEqual([200, 1]);
    ({ body } = await list());
    expect(body.connections).toEqual([]);
  });

  test('refuses accounts that are not this connection’s, and malformed requests', async () => {
    const id = await connectAndTrack();
    const strange = await call(accountsRoute.PUT, 'PUT', { connection_id: id, stop: { account_ids: ['manual_someone-else'] } });
    expect(strange.status).toBe(400);
    for (const body of [
      { connection_id: 'nope' },
      { connection_id: id, track: [{ remote_id: 'CHK', type: 'savings' }] },
      { connection_id: id, track: 'all' },
      { connection_id: id, retype: [{ account_id: 'plaid-id', type: 'credit' }] },
      { connection_id: id, stop: { account_ids: [], keep: 'yes' } },
      { connection_id: id, track: [{ remote_id: 'CHK', type: 'depository' }, { remote_id: 'CHK', type: 'credit' }] },
    ]) {
      expect([JSON.stringify(body), (await call(accountsRoute.PUT, 'PUT', body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    expect((await call(refreshRoute.POST, 'POST', { connection_id: 'conn_00000000-0000-4000-8000-000000000000' })).status).toBe(404);
    expect((await call(connectors.DELETE, 'DELETE', { connection_id: id, keep: 'no' })).status).toBe(400);
  });

  test('a card reported as money held isn’t counted until the person answers which way, through the route', async () => {
    server.accounts[1].balance = '432.10';
    const id = await connectAndTrack();
    let { body } = await list();
    const visa = body.connections[0].accounts.find((a: any) => a.name === 'Visa');
    expect(visa).toMatchObject({ balance: null, reported: 432.1, sign: null, needs_sign: true });
    for (const bad of [
      { connection_id: id, sign: [{ account_id: visa.account_id, sign: 'negative' }] },
      { connection_id: id, sign: [{ account_id: 'manual_someone-else', sign: 'as_reported' }] },
    ]) {
      expect((await call(accountsRoute.PUT, 'PUT', bad)).status).toBe(400);
    }
    const said = await call(accountsRoute.PUT, 'PUT', { connection_id: id, sign: [{ account_id: visa.account_id, sign: 'owed_positive' }] });
    expect([said.status, said.body.signed]).toEqual([200, 1]);
    ({ body } = await list());
    expect(body.connections[0].accounts.find((a: any) => a.name === 'Visa')).toMatchObject({ balance: 432.1, sign: 'owed_positive', needs_sign: false });
  });

  test('Refresh is refused once the day’s requests are spent, saying when they come back', async () => {
    const id = await connectAndTrack();
    let last = await call(refreshRoute.POST, 'POST', { connection_id: id });
    for (let i = 0; i < 10 && last.status === 200; i++) last = await call(refreshRoute.POST, 'POST', { connection_id: id });
    expect(last.status).toBe(429);
    expect(last.body.error).toContain("today's 8 requests");
    expect(server.accountRequests.length).toBe(8);
  });
});

describe('everywhere else, like any account', () => {
  test('Activity lists their transactions from SimpleFIN; their category changes, their amount and their deletion are refused', async () => {
    await connectAndTrack();
    const res = await transactions.GET(new Request('http://localhost/api/transactions'));
    const body = await res.json();
    const coffee = body.transactions.find((t: any) => t.name === 'COFFEE');
    expect(coffee).toMatchObject({ amount: 12.5, source: 'simplefin', institution_name: 'My Bank', account_name: 'Checking', iso_currency_code: 'USD', pending: false });
    const recat = await call(recategorize.POST, 'POST', { transaction_id: coffee.transaction_id, category: 'Food', account_id: coffee.account_id });
    expect(recat.status).toBe(200);
    const edit = await call(manualTxns.PATCH, 'PATCH', { id: coffee.transaction_id, account_id: coffee.account_id, amount: 1 });
    expect([edit.status, edit.body.error]).toEqual([400, expect.stringContaining('through SimpleFIN')]);
    const del = await call(manualTxns.DELETE, 'DELETE', { id: coffee.transaction_id, account_id: coffee.account_id });
    expect(del.status).toBe(400);
    // Nor can a transaction be added to one: it is not a manual account.
    const add = await call(manualTxns.POST, 'POST', { account_id: coffee.account_id, date: dayOf(NOW), amount: 1, currency: 'USD', name: 'X' });
    expect(add.status).toBe(404);
    const after = (await (await transactions.GET(new Request('http://localhost/api/transactions'))).json()).transactions.find((t: any) => t.transaction_id === coffee.transaction_id);
    expect([after.category, after.amount]).toEqual(['food', 12.5]);
  });

  test('a payment between two of them is a transfer, left out of totals; the rest say they have no category', async () => {
    server.accounts[0].transactions.push(txn('p1', 2, '-300.00', 'PAYMENT TO VISA'));
    server.accounts[1].transactions.push(txn('p2', 1, '300.00', 'PAYMENT THANK YOU'));
    await connectAndTrack();
    const rows = (await (await transactions.GET(new Request('http://localhost/api/transactions'))).json()).transactions;
    const code = (name: string) => rows.find((t: any) => t.name === name)?.transaction_code;
    expect([code('PAYMENT TO VISA'), code('PAYMENT THANK YOU'), code('COFFEE')]).toEqual(['transfer', 'transfer', null]);
    const { isTransfer, uncategorizedFromConnector, uncategorizedNote } = await import('@/lib/spending');
    const { planFlow } = await import('@/lib/fire/inputs');
    const payments = rows.filter((t: any) => t.name.startsWith('PAYMENT'));
    expect(payments.every(isTransfer)).toBe(true);
    // Neither side is spending or income on the Plan either.
    expect(payments.map(planFlow)).toEqual(['transfer', 'transfer']);
    // COFFEE, PAYROLL and DINER count, uncategorized: said under the totals.
    expect(uncategorizedFromConnector(rows)).toBe(3);
    expect(uncategorizedNote(3)).toContain('3 transactions from SimpleFIN have no category');
    // Categorized, it counts as the person said, and is no longer one of them.
    const coffee = rows.find((t: any) => t.name === 'COFFEE');
    await call(recategorize.POST, 'POST', { transaction_id: coffee.transaction_id, category: 'food', account_id: coffee.account_id });
    const after = (await (await transactions.GET(new Request('http://localhost/api/transactions'))).json()).transactions;
    expect(uncategorizedFromConnector(after)).toBe(2);
  });

  test('its category edits through the form answer like any row’s; its note, like its amount, is refused before anything is saved', async () => {
    await connectAndTrack();
    const rows = (await (await transactions.GET(new Request('http://localhost/api/transactions'))).json()).transactions;
    const coffee = rows.find((t: any) => t.name === 'COFFEE');
    const category = await call(manualTxns.PATCH, 'PATCH', { id: coffee.transaction_id, account_id: coffee.account_id, category: 'groceries' });
    expect([category.status, category.body.transaction?.category, category.body.transaction?.account_name]).toEqual([200, 'groceries', 'Checking']);
    const note = await call(manualTxns.PATCH, 'PATCH', { id: coffee.transaction_id, account_id: coffee.account_id, note: 'mine' });
    expect([note.status, note.body.error]).toEqual([400, expect.stringContaining('Its category is yours to change')]);
    const now = (await (await transactions.GET(new Request('http://localhost/api/transactions'))).json()).transactions.find((t: any) => t.transaction_id === coffee.transaction_id);
    expect([now.note, now.category]).toEqual([null, 'groceries']);
  });

  test('SimpleFIN accounts that can’t be read hide only their own rows, under a note naming them; banks still importing say so', async () => {
    await connectAndTrack();
    const listed = (await (await transactions.GET(new Request('http://localhost/api/transactions'))).json()).incomplete;
    expect(listed).toEqual([{ institution_name: 'My Bank', coverage: 'importing' }]);
    // A manual account with a row of its own, and a damaged SimpleFIN entry.
    const wallet = 'manual_00000000-0000-4000-8000-0000000000aa';
    const { saveManualAccount } = await import('@/lib/manual');
    await saveManualAccount(ctx, { account_id: wallet, name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 20, updated_at: new Date().toISOString() });
    const manual = await call(manualTxns.POST, 'POST', {
      account_id: wallet,
      id: 'manual-txn:00000000-0000-4000-8000-0000000000bb',
      date: dayOf(NOW),
      amount: 4,
      currency: 'USD',
      name: 'TEA',
    });
    expect(manual.status).toBe(200);
    await fake.hset(`test:c:${ctx.container}:connector-accounts`, { 'manual_00000000-0000-4000-8000-0000000000cc': 'not-ciphertext-but-long-enough-to-be-tried' });
    const { result: body } = await quietly(async () => (await transactions.GET(new Request('http://localhost/api/transactions'))).json());
    expect(body.transactions.map((t: any) => t.name)).toEqual(['TEA']);
    expect(body.notes).toContain("SimpleFIN accounts: couldn't be read, so their transactions aren't shown");
    expect(body.notes).not.toContain("Manual accounts: couldn't be read, so transactions entered for them aren't shown");
  });

  test('net worth shows them under their bank, via SimpleFIN, with their health', async () => {
    await connectAndTrack();
    const body = await (await netWorth.GET(new Request('http://localhost/api/net-worth?refresh=1'))).json();
    const bank = body.institutions.find((i: any) => i.institution_name === 'My Bank');
    expect(bank).toMatchObject({ connector: 'simplefin', manual: true, error: null, health: { state: 'healthy', cause: 'connector' } });
    expect(bank.accounts.map((a: any) => [a.name, a.balance, a.currency])).toEqual([
      ['Checking', 1500.25, 'USD'],
      ['Visa', 432.1, 'USD'],
    ]);
    expect(body.netWorth).toBeCloseTo(1068.15, 6);
    expect(body.history.at(-1)).toMatchObject({ date: dayOf(Date.now()), value: expect.closeTo(1068.15, 6) });
  });

  test('they can be shared, and the download lists them with SimpleFIN as their provider, never the Access URL', async () => {
    const id = await connectAndTrack();
    const shareable = await shareableAccounts(ctx);
    expect(shareable.map((s) => s.label)).toEqual(['My Bank Checking', 'My Bank Visa']);
    const data = await collectUserData({ ctx, userId: null });
    const doc = buildUserExport(data, new Date());
    expect(doc.institutions).toEqual([{ item_id: id, institution_name: `SimpleFIN (bridge.test:${server.port})`, institution_id: null, provider: 'simplefin' }]);
    expect(doc.accounts.map((a) => [a.name, a.provider, a.item_id, a.institution_name, a.type, a.currency, a.connected])).toEqual([
      ['Checking', 'simplefin', id, 'My Bank', 'depository', 'USD', true],
      ['Visa', 'simplefin', id, 'My Bank', 'credit', 'USD', true],
    ]);
    expect(countAccounts(data)).toEqual({ accounts: 2, earlier: 0 });
    const text = JSON.stringify(doc);
    expect(text).not.toContain(server.password);
    expect(text).not.toContain('connector-secrets');
    expect((doc['manual-transactions'] as any[]).flatMap((b) => b.value.rows).map((r: any) => r.source_id).sort()).toEqual(['c1', 'c2', 'v1']);
    expect((doc['connector-accounts'] as any[]).length).toBe(2);
  });

  test('one kept as a manual account on a disconnect keeps its currency, in the download too', async () => {
    server.accounts[0] = fakeAccount({ id: 'CHK', name: 'Everyday', currency: 'AUD', balance: '900.00', 'balance-date': ago(1), transactions: [] });
    const id = await connectAndTrack();
    const gone = await call(connectors.DELETE, 'DELETE', { connection_id: id });
    expect([gone.status, gone.body.kept]).toEqual([200, 2]);
    const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
    const kept = Object.fromEntries(doc.manual_accounts.map((m) => [m.name, [m.currency ?? null, m.balance]]));
    expect(kept).toEqual({ Everyday: ['AUD', 900], Visa: [null, 432.1] });
    expect(doc.accounts).toEqual([]);
  });

  test('the nightly snapshot fetches from SimpleFIN and records the day', async () => {
    const id = await connectAndTrack();
    await connectionsStore.update(ctx, id, (c) => (c ? { ...c, last_answer_at: new Date(NOW - 13 * 3_600_000).toISOString() } : c));
    const before = server.accountRequests.length;
    const outcome = await snapshotData(ctx, []);
    expect(outcome.status).toBe('recorded');
    // The recent window, then older history while it is still coming.
    const asked = server.accountRequests.slice(before);
    expect(asked[0].query['end-date']).toBeUndefined();
    expect(asked.slice(1).every((r) => r.query['end-date'] !== undefined)).toBe(true);
  });

  test('a failed nightly fetch leaves the day unrecorded', async () => {
    const id = await connectAndTrack();
    await connectionsStore.update(ctx, id, (c) => (c ? { ...c, last_answer_at: new Date(NOW - 13 * 3_600_000).toISOString() } : c));
    server.behaviour = { on: 'accounts', status: 500 };
    const outcome = await snapshotData(ctx, []);
    expect(outcome.status).toBe('unclean');
  });
});

describe('the Access URL', () => {
  test('never reaches a log, an error, an answer, or storage in the clear, whatever fails', async () => {
    const secret = server.accessUrl();
    const leaks: string[] = [];
    const check = (where: string, text: string) => {
      for (const needle of [secret, server.password, `${server.user}:`]) if (text.includes(needle)) leaks.push(`${where}: ${needle}`);
    };
    const { logged } = await quietly(async () => {
      const id = await connectAndTrack();
      const behaviours: (typeof server.behaviour)[] = [
        { on: 'accounts', status: 403, body: `bad ${server.user}:${server.password}` },
        { on: 'accounts', status: 500, body: JSON.stringify({ errors: [`password ${server.password} rejected`] }) },
        { on: 'accounts', status: 200, body: 'not json at all' },
        { on: 'accounts', status: 200, body: JSON.stringify({ errors: [`Access URL ${secret} is old`], accounts: [] }) },
        { on: 'accounts', location: 'https://elsewhere.example/collect' },
        { on: 'accounts', delayMs: 25_000 },
      ];
      for (const b of behaviours) {
        server.behaviour = b;
        // A timeout shorter than the server's delay, as a slow answer would meet.
        const res = b?.delayMs ? await import('@/lib/connectors/sync').then((s) => s.syncConnection(ctx, id, { purpose: 'refresh', deadline: Date.now() + 3_500 })) : null;
        const route = b?.delayMs ? null : await call(refreshRoute.POST, 'POST', { connection_id: id });
        if (route) check(`refresh answer (${route.status})`, route.text);
        if (res) check('sync result', JSON.stringify(res));
        check('connections list', JSON.stringify((await list()).body));
        check('net worth', JSON.stringify(await (await netWorth.GET(new Request('http://localhost/api/net-worth?refresh=1'))).json()));
      }
      server.behaviour = null;
      // The address resolving somewhere Nya won't go.
      setTransportForTests({ ...server.transport(), allowAddress: () => false });
      check('blocked refresh', (await call(refreshRoute.POST, 'POST', { connection_id: id })).text);
      setTransportForTests(server.transport());
      await syncConnectorsDaily(ctx).done;
      // A claim that fails, and the download.
      server.behaviour = { on: 'claim', status: 500, body: secret };
      check('failed claim', (await call(connectRoute.POST, 'POST', { connector: 'simplefin', token: server.setupToken('fails') })).text);
      server.behaviour = null;
      check('download', JSON.stringify(buildUserExport(await collectUserData({ ctx, userId: null }), new Date())));
      // And the paths that do log: a request count that can't be read, and
      // accounts that can't be read when net worth is computed.
      await fake.set(`test:c:${ctx.container}:connector-requests`, 'not a count');
      check('refresh without a count', (await call(refreshRoute.POST, 'POST', { connection_id: id })).text);
      const [first] = [...(await connectorAccountsStore.getAll(ctx)).keys()];
      await fake.hset(`test:c:${ctx.container}:connector-accounts`, { [first]: 'damaged' });
      check('net worth, damaged', JSON.stringify(await (await netWorth.GET(new Request('http://localhost/api/net-worth?refresh=1'))).json()));
      return id;
    });
    check('logs', logged);
    // The failures above were logged, without it.
    expect(logged).toContain('request count');
    expect(logged).toContain('Connector accounts read failed');
    // Storage holds it only encrypted.
    const stored = JSON.stringify([...(fake as any).hashes.entries()].map(([k, h]: [string, Map<string, string>]) => [k, [...h]]));
    check('storage', stored + JSON.stringify([...(fake as any).strings.entries()]));
    expect(leaks).toEqual([]);
  }, 30_000);
});

describe('Plaid', () => {
  test('no connector code can reach it: nothing under lib/connectors or app/api/connectors imports the Plaid client', () => {
    const root = join(import.meta.dir, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(root, 'lib', 'connectors'));
    walk(join(root, 'app', 'api', 'connectors'));
    expect(files.length).toBeGreaterThan(10);
    const offenders = files.filter((f) => /from ['"](plaid|@\/lib\/plaid|\.\.?\/(\.\.\/)*plaid)['"]|require\(['"][^'"]*plaid/.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
    expect(offenders).toEqual([]);
  });
});
