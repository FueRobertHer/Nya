import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, unscopedDataKeys } from './fake-redis';
import { FakeLunchFlow, daysAgo, lfAccount, lfTxn } from './lunchflow-fake';

// Lunch Flow on the connector framework (lib/connectors/lunchflow.ts through
// sync.ts, manage.ts and institutions.ts), against a local fake of its
// Personal API: connecting with a good key and a bad one, tracking accounts,
// the daily fetch keeping new, changed and removed rows and a pending row once
// it posts, older history in a second window, every failure stored in Lunch
// Flow's words with the health it gives, a key it no longer takes replaced in
// place, letting accounts go both ways, one container's connection out of
// another's reach, and the key never in storage in the clear nor in a log.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
// Connecting Lunch Flow is off unless the deployment turns it on
// (lib/connectors/switch.ts). Turned on before each test: test/preload.ts
// clears it before and after each one.
beforeEach(() => {
  process.env.LUNCHFLOW_ENABLED = '1';
});

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

// Every Plaid call is counted, and fails: nothing here may make one.
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
const { setLunchFlowApiForTests } = await import('@/lib/connectors/lunchflow');
const { connect, trackAccounts, releaseAccounts, disconnect, reconnect, confirmSigns, forgetEnded } = await import('@/lib/connectors/manage');
const { syncConnection, syncConnectorsDaily, takeRequest, HISTORY_DAYS } = await import('@/lib/connectors/sync');
const { connectionsStore, connectorAccountsStore, secretsStore, endedAccountsStore } = await import('@/lib/connectors/store');
const { computeNetWorth, isRecordable } = await import('@/lib/networth');
const { manualTxnStore, editManualTxn } = await import('@/lib/manual-txns');
const { getManualAccounts } = await import('@/lib/manual');
const { connectorHealthText, connectorBadge } = await import('@/lib/connectors/health');

const ctx = TEST_CTX;
const OTHER = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const NOW = Date.now();
const TODAY = daysAgo(0, NOW);

let server: FakeLunchFlow;
beforeAll(async () => {
  server = await FakeLunchFlow.start();
});
afterAll(() => {
  setTransportForTests(null);
  setLunchFlowApiForTests(null);
  server.stop();
});
beforeEach(() => {
  fake.reset();
  server.reset();
  setTransportForTests(server.transport());
  setLunchFlowApiForTests(server.base());
  plaidCalls.length = 0;
});
afterEach(() => expect(plaidCalls).toEqual([]));

/** A current account and a card at one bank, and savings at another. */
function seedServer() {
  server.accounts = [
    lfAccount({
      id: 1470,
      name: 'Current Account',
      institution_name: 'Monzo',
      balance: { amount: 1520.4, currency: 'GBP' },
      transactions: [lfTxn('t-coffee', 3, -3.2, 'Pret A Manger'), lfTxn('t-salary', 10, 2500, 'ACME LTD'), lfTxn('t-grocer', 40, -80, 'Tesco')],
    }),
    lfAccount({ id: 1471, name: 'Credit Card', institution_name: 'Monzo', balance: { amount: -432.1, currency: 'GBP' }, transactions: [lfTxn('t-diner', 2, -45.67, 'Dishoom')] }),
    lfAccount({ id: 2001, name: 'Savings', institution_name: 'ASB', provider: 'akahu', balance: { amount: 10000, currency: 'NZD' }, transactions: [lfTxn('t-interest', 5, 1.23, 'Interest')] }),
  ];
}

/** Connects with the fake's key, and tracks the given accounts with their kinds. */
async function connectAndTrack(
  choices: [string, 'depository' | 'credit' | 'investment' | 'loan' | 'other'][] = [
    ['1470', 'depository'],
    ['1471', 'credit'],
    ['2001', 'depository'],
  ],
  c = ctx
) {
  seedServer();
  const { connection_id } = await connect(c, 'lunchflow', server.key, NOW);
  await trackAccounts(c, connection_id, choices.map(([remote_id, type]) => ({ remote_id, type })), NOW);
  return connection_id;
}

async function accountsByRemote(c = ctx) {
  return new Map([...(await connectorAccountsStore.getAll(c)).values()].map((a) => [a.remote_id, a]));
}

async function rowsOf(account_id: string, c = ctx) {
  return (await manualTxnStore.get(c, account_id))?.rows ?? [];
}

/** A new day's window of requests, as the counter's expiry would bring. */
async function nextDay(c = ctx) {
  await fake.del(ctxKey('connector-requests', c));
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

/** Everything storage holds, as text. */
const storedText = () => JSON.stringify([[...(fake as any).hashes.entries()].map(([k, h]: [string, Map<string, string>]) => [k, [...h]]), [...(fake as any).strings.entries()]]);

/** The card of a bank, as net worth shows it. */
async function card(name: string, c = ctx) {
  return (await computeNetWorth(c)).institutions.find((i) => i.institution_name === name)!;
}

describe('connecting', () => {
  test('a good key is checked once, kept encrypted, and the accounts are listed by name with no balance stored', async () => {
    seedServer();
    const { connection_id, result } = await connect(ctx, 'lunchflow', `  ${server.key} `, NOW);
    // The check, then the listing: the accounts and each one's balance.
    expect(server.seen.map((r) => r.path)).toEqual([
      '/api/v1/accounts',
      '/api/v1/accounts',
      '/api/v1/accounts/1470/balance',
      '/api/v1/accounts/1471/balance',
      '/api/v1/accounts/2001/balance',
    ]);
    expect(result.answer?.accounts.map((a) => [a.remote_id, a.balance, a.currency])).toEqual([
      ['1470', 1520.4, 'GBP'],
      ['1471', -432.1, 'GBP'],
      ['2001', 10000, 'NZD'],
    ]);
    const conn = (await connectionsStore.get(ctx, connection_id))!;
    expect([conn.connector, conn.host]).toEqual(['lunchflow', `bridge.test:${server.port}`]);
    expect(conn.available.map((a) => [a.remote_id, a.name, a.institution, a.currency])).toEqual([
      ['1470', 'Current Account', 'Monzo', 'GBP'],
      ['1471', 'Credit Card', 'Monzo', 'GBP'],
      ['2001', 'Savings', 'ASB', 'NZD'],
    ]);
    expect(await secretsStore.get(ctx, connection_id)).toEqual({ connector: 'lunchflow', secret: server.key });
    expect(await connectorAccountsStore.count(ctx)).toBe(0);
    // Only encrypted: nothing in storage holds the key, nor a balance not chosen.
    expect(storedText()).not.toContain(server.key);
    expect(storedText()).not.toContain('1520.4');
  });

  test('a key Lunch Flow refuses keeps nothing, and counts against the hour’s tries', async () => {
    const err = await connect(ctx, 'lunchflow', 'lf_wrong_key_0000000', NOW).catch((e) => e);
    expect([err.name, err.kind]).toEqual(['ExchangeFailure', 'claimed']);
    expect(await connectionsStore.count(ctx)).toBe(0);
    expect(await secretsStore.count(ctx)).toBe(0);
    // What isn't a key at all is refused before it is counted or sent.
    server.seen.length = 0;
    expect((await connect(ctx, 'lunchflow', 'nope', NOW).catch((e) => e)).kind).toBe('invalid');
    expect(server.seen).toEqual([]);
    for (let i = 0; i < 9; i++) await connect(ctx, 'lunchflow', 'lf_wrong_key_0000000', NOW).catch(() => null);
    const limited = await connect(ctx, 'lunchflow', server.key, NOW).catch((e) => e);
    expect([limited.name, limited.status]).toEqual(['ConnectorRefused', 429]);
  });

  test('a listing that fails leaves the connection made, to list later', async () => {
    seedServer();
    server.behaviours = [{ on: 'balance', status: 503, body: JSON.stringify({ error: 'GCRateLimited', message: 'Bank data is temporarily unavailable. This usually resolves within a minute.' }), times: 3 }];
    const { connection_id, result } = await connect(ctx, 'lunchflow', server.key, NOW);
    expect(result.record?.failure).toMatchObject({ kind: 'down', side: 'connector', message: expect.stringContaining('Bank data is temporarily unavailable') });
    const again = await syncConnection(ctx, connection_id, { purpose: 'refresh', now: NOW });
    expect(again.record?.failure).toBeNull();
    expect((await connectionsStore.get(ctx, connection_id))!.available.length).toBe(3);
  });
});

describe('tracking and the daily fetch', () => {
  test('accounts tracked while the day’s requests are spent wait for their first answer, never showing the listing’s word about another bank', async () => {
    seedServer();
    // The listing to choose from says ASB's link is broken: a problem that
    // names no account, since nothing is tracked yet.
    server.accounts[2].status = 'DISCONNECTED';
    const { connection_id } = await connect(ctx, 'lunchflow', server.key, NOW);
    expect((await connectionsStore.get(ctx, connection_id))!.last_fetch?.problems).toEqual([{ message: 'The connection to ASB is disconnected', side: 'connector', accounts: null }]);
    while (await takeRequest(ctx));
    const res = await trackAccounts(ctx, connection_id, [{ remote_id: '1470', type: 'depository' }], NOW);
    expect(res?.skipped).toBe('budget');
    expect((await connectionsStore.get(ctx, connection_id))!.last_fetch).toBeNull();
    const monzo = await card('Monzo');
    expect([monzo.health?.detail?.issue, monzo.health?.side]).toEqual(['waiting', 'connector']);
    expect(connectorHealthText('Monzo', monzo.health!)).toContain("Waiting for Lunch Flow's answer about Monzo");
    expect(connectorHealthText('Monzo', monzo.health!)).not.toContain('ASB');
    // Its first answer, once requests come back, brings it.
    await nextDay();
    await syncConnection(ctx, connection_id, { purpose: 'refresh', now: NOW });
    expect([(await card('Monzo')).error, (await card('Monzo')).health?.detail?.issue]).toEqual([null, 'ok']);
  });

  test('the first fetch brings two years of the tracked accounts’ posted transactions, in Plaid’s sign, under Lunch Flow’s ids', async () => {
    const id = await connectAndTrack([
      ['1470', 'depository'],
      ['1471', 'credit'],
    ]);
    const asked = server.requests('transactions');
    // Only the tracked ones; savings isn't.
    expect(asked.map((r) => [r.path, r.query])).toEqual([
      ['/api/v1/accounts/1470/transactions', { from: daysAgo(730, NOW) }],
      ['/api/v1/accounts/1471/transactions', { from: daysAgo(730, NOW) }],
    ]);
    const accounts = await accountsByRemote();
    expect((await rowsOf(accounts.get('1470')!.account_id)).map((r) => [r.source, r.source_id, r.amount, r.name, r.date, r.currency]).sort()).toEqual(
      [
        ['lunchflow', 't-coffee', 3.2, 'Pret A Manger', daysAgo(3, NOW), 'GBP'],
        ['lunchflow', 't-salary', -2500, 'ACME LTD', daysAgo(10, NOW), 'GBP'],
        ['lunchflow', 't-grocer', 80, 'Tesco', daysAgo(40, NOW), 'GBP'],
      ].sort()
    );
    // Balances as reported, with no time from Lunch Flow: as of when Nya got them.
    expect(accounts.get('1471')).toMatchObject({ reported_balance: -432.1, type: 'credit', balance_at: null, fetched_at: new Date(NOW).toISOString() });
    // Two years in one answer, as far back as Nya keeps history: complete at once.
    const conn = (await connectionsStore.get(ctx, id))!;
    expect(conn.history).toEqual({ from: daysAgo(730, NOW), to: TODAY, complete: true, failed: null });
    // The card owes, the account holds, and the day's total is recordable.
    const monzo = await card('Monzo');
    expect(monzo).toMatchObject({ connector: 'lunchflow', manual: true, error: null, health: { state: 'healthy', cause: 'connector' } });
    expect(monzo.accounts.map((a) => [a.name, a.balance, a.currency, a.updated_at])).toEqual([
      ['Credit Card', 432.1, 'GBP', new Date(NOW).toISOString()],
      ['Current Account', 1520.4, 'GBP', new Date(NOW).toISOString()],
    ]);
    expect((await computeNetWorth(ctx)).institutions.every(isRecordable)).toBe(true);
  });

  test('the next fetches add what is new, bring up to date what changed, keep what Lunch Flow stopped returning, and take a pending row once it posts', async () => {
    const id = await connectAndTrack();
    const current = (await accountsByRemote()).get('1470')!.account_id;
    const coffee = (await rowsOf(current)).find((r) => r.source_id === 't-coffee')!;
    await editManualTxn(ctx, coffee.id, { category: 'food and drink' }, { from: current });
    const txns = server.accounts[0].transactions;
    // New; changed (the bank's own date and a new amount); removed; pending.
    txns.push(lfTxn('t-new', 0, -9.99, 'Waterstones'));
    txns[0] = lfTxn('t-coffee', 2, -3.5, 'Pret A Manger');
    txns.splice(txns.findIndex((t) => t.id === 't-grocer'), 1);
    txns.push(lfTxn('', 0, -12, 'Uber', { id: null, isPending: true }));
    await nextDay();
    const res = await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect(res.record).toMatchObject({ failure: null, added: 1, updated: 1, pending: 0 });
    // Pending rows are never asked for (one sent all the same: the next test).
    expect(server.requests('transactions').every((r) => r.query.include_pending === undefined)).toBe(true);
    const rows = await rowsOf(current);
    expect(rows.find((r) => r.source_id === 't-coffee')).toMatchObject({ id: coffee.id, amount: 3.5, date: daysAgo(2, NOW), category: 'food and drink' });
    expect(rows.find((r) => r.source_id === 't-new')).toMatchObject({ amount: 9.99, name: 'Waterstones' });
    // Lunch Flow no longer returns the grocer: kept, as SimpleFIN's are.
    expect(rows.find((r) => r.source_id === 't-grocer')).toMatchObject({ amount: 80 });
    expect(rows.some((r) => r.name === 'Uber')).toBe(false);
    // It posts, with an id of its own: added once.
    server.accounts[0].transactions = server.accounts[0].transactions.filter((t) => t.id !== null);
    server.accounts[0].transactions.push(lfTxn('t-uber', 0, -12, 'Uber'));
    const posted = await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect(posted.record).toMatchObject({ added: 1 });
    expect((await rowsOf(current)).filter((r) => r.name === 'Uber').map((r) => [r.source_id, r.amount])).toEqual([['t-uber', 12]]);
    // And fetching again adds nothing.
    const again = await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect([again.record?.added, again.record?.updated]).toEqual([0, 0]);
  });

  test('an account nobody tracks is asked about once, to offer it; after that it is only listed, and still offered with its currency', async () => {
    const id = await connectAndTrack([
      ['1470', 'depository'],
      ['1471', 'credit'],
    ]);
    const savings = { remote_id: '2001', name: 'Savings', institution: 'ASB', institution_key: 'name:akahu:asb', currency: 'NZD', currency_text: 'NZD' };
    await nextDay();
    server.seen.length = 0;
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect(server.requests('balance').map((r) => r.path).sort()).toEqual(['/api/v1/accounts/1470/balance', '/api/v1/accounts/1471/balance']);
    expect((await connectionsStore.get(ctx, id))!.available).toEqual([savings]);
    // Renamed at Lunch Flow: still offered, under its new name.
    server.accounts[2].name = 'Rainy Day';
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect((await connectionsStore.get(ctx, id))!.available).toEqual([{ ...savings, name: 'Rainy Day' }]);
    // A new one at Lunch Flow is asked its balance, after the tracked ones', to be offered; then it can be tracked.
    server.accounts.push(lfAccount({ id: 3001, name: 'Holiday Pot', institution_name: 'ASB', provider: 'akahu', balance: { amount: 50, currency: 'NZD' } }));
    await nextDay();
    server.seen.length = 0;
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect(server.requests('balance').map((r) => r.path).at(-1)).toBe('/api/v1/accounts/3001/balance');
    expect((await connectionsStore.get(ctx, id))!.available.map((a) => [a.remote_id, a.currency])).toEqual([
      ['3001', 'NZD'],
      ['2001', 'NZD'],
    ]);
    await trackAccounts(ctx, id, [{ remote_id: '3001', type: 'depository' }], NOW);
    expect((await accountsByRemote()).get('3001')).toMatchObject({ name: 'Holiday Pot', currency: 'NZD', reported_balance: 50 });
    // Gone from Lunch Flow, it is no longer offered.
    server.accounts = server.accounts.filter((a) => a.id !== 2001);
    await nextDay();
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect((await connectionsStore.get(ctx, id))!.available).toEqual([]);
  });

  test('a pending row sent anyway is counted on the fetch, never kept', async () => {
    seedServer();
    const { connection_id } = await connect(ctx, 'lunchflow', server.key, NOW);
    // As a server that answers pending rows whatever it is asked.
    server.behaviours = [
      {
        on: 'transactions',
        account: 1470,
        body: JSON.stringify({
          transactions: [
            { id: null, accountId: 1470, amount: -12, currency: 'GBP', date: daysAgo(0, NOW), merchant: 'HOLD', description: '', isPending: true },
            { id: 't-posted', accountId: 1470, amount: -1, currency: 'GBP', date: daysAgo(0, NOW), merchant: 'Posted', description: '', isPending: false },
          ],
          total: 2,
        }),
      },
    ];
    const res = await trackAccounts(ctx, connection_id, [{ remote_id: '1470', type: 'depository' }], NOW);
    expect(res?.record).toMatchObject({ added: 1, pending: 1 });
    expect((await rowsOf((await accountsByRemote()).get('1470')!.account_id)).map((r) => r.source_id)).toEqual(['t-posted']);
  });

  test('two years at once, as far back as Nya keeps history: nothing older is asked for, nor kept when it comes', async () => {
    seedServer();
    server.accounts[0].transactions.push(lfTxn('t-old', HISTORY_DAYS + 30, -15, 'Old one'));
    server.ignoreWindow = true;
    const { connection_id } = await connect(ctx, 'lunchflow', server.key, NOW);
    await trackAccounts(ctx, connection_id, [{ remote_id: '1470', type: 'depository' }], NOW);
    const current = (await accountsByRemote()).get('1470')!.account_id;
    expect((await rowsOf(current)).some((r) => r.source_id === 't-old')).toBe(false);
    await nextDay();
    // As the catch-up would find it: the last answer old enough to ask again.
    await connectionsStore.update(ctx, connection_id, (c) => (c ? { ...c, last_answer_at: new Date(NOW - 13 * 3_600_000).toISOString() } : c));
    server.seen.length = 0;
    await syncConnectorsDaily(ctx, { now: NOW }).done;
    // Only the recent window, from 45 days before the last day fetched: no
    // older one, since the history reached its limit with the first answer.
    expect(server.requests('transactions').map((r) => r.query)).toEqual([{ from: daysAgo(45, NOW) }]);
    expect((await rowsOf(current)).some((r) => r.source_id === 't-old')).toBe(false);
    expect((await connectionsStore.get(ctx, connection_id))!.history).toMatchObject({ from: daysAgo(730, NOW), complete: true, failed: null });
  });

  test('a row that posts long after its own day is still kept: windows overlap by 45 days, and one sent from before the window is kept', async () => {
    const id = await connectAndTrack([['1470', 'depository']]);
    const current = (await accountsByRemote()).get('1470')!.account_id;
    // A hotel's hold from 30 days back settles today, dated the day of the
    // stay, long after the history reached that day (seven days' overlap,
    // as Lunch Flow's Lunch Money sync has, would never ask for it again).
    expect((await connectionsStore.get(ctx, id))!.history?.to).toBe(TODAY);
    server.accounts[0].transactions.push(lfTxn('t-hotel', 30, -250, 'Grand Hotel'));
    await nextDay();
    server.seen.length = 0;
    const res = await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect(server.requests('transactions').map((r) => r.query.from)).toEqual([daysAgo(45, NOW)]);
    expect(res.record).toMatchObject({ added: 1 });
    expect((await rowsOf(current)).find((r) => r.source_id === 't-hotel')).toMatchObject({ amount: 250, date: daysAgo(30, NOW) });
    // Later still (a car hire's hold, 60 days back), Lunch Flow sends it
    // though it is dated before the window, as one filtering by when it was
    // booked would: kept, and matched by its id, never twice.
    server.ignoreWindow = true;
    server.accounts[0].transactions.push(lfTxn('t-car', 60, -180, 'Car Hire'));
    await nextDay();
    expect((await syncConnection(ctx, id, { purpose: 'refresh', now: NOW })).record).toMatchObject({ added: 1 });
    await nextDay();
    expect((await syncConnection(ctx, id, { purpose: 'refresh', now: NOW })).record).toMatchObject({ added: 0 });
    expect((await rowsOf(current)).filter((r) => r.source_id === 't-car').map((r) => [r.amount, r.date])).toEqual([[180, daysAgo(60, NOW)]]);
  });
});

describe('when Lunch Flow can’t be read', () => {
  test('each failure is stored in Lunch Flow’s words, changes nothing, holds the bank, and says whose side it is on and what to do', async () => {
    const id = await connectAndTrack();
    const before = await accountsByRemote();
    for (const [status, kind, side, action] of [
      [403, 'refused', 'you', 'Connect again with an API key from Lunch Flow'],
      [401, 'refused', 'you', 'Connect again with an API key from Lunch Flow'],
      [402, 'payment', 'you', 'Renew it at Lunch Flow'],
      [429, 'limited', 'nya', 'Nothing for you to do'],
      [400, 'rejected', 'nya', 'whoever runs Nya'],
      [503, 'down', 'connector', 'usually clears on its own'],
    ] as const) {
      await nextDay();
      server.behaviours = [{ on: 'accounts', status, body: JSON.stringify({ error: 'X', message: `Lunch Flow says ${status}` }) }];
      const res = await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
      expect([status, res.record?.failure?.kind, res.record?.failure?.side]).toEqual([status, kind, side]);
      const monzo = await card('Monzo');
      expect([status, !!monzo.error, monzo.health?.detail?.issue, monzo.health?.side]).toEqual([status, true, kind, side]);
      const said = connectorHealthText('Monzo', monzo.health!)!;
      expect([status, said.includes(action)]).toEqual([status, true]);
      // Nothing written: the balances are as before, held out of the day's total.
      expect(await accountsByRemote()).toEqual(before);
      expect((await computeNetWorth(ctx)).institutions.every(isRecordable)).toBe(false);
    }
    expect(connectorBadge((await card('Monzo')).health!)).toBe('Not updating');
  });

  test('a link that broke at Lunch Flow holds its bank only, in its words, and the rest is counted', async () => {
    const id = await connectAndTrack();
    server.accounts[2].status = 'DISCONNECTED';
    await nextDay();
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    const asb = await card('ASB');
    expect([asb.health?.detail?.issue, asb.health?.side, !!asb.error]).toEqual(['reported', 'connector', true]);
    expect(connectorHealthText('ASB', asb.health!)).toContain('Lunch Flow reports: “The connection to ASB is disconnected”');
    expect(connectorBadge(asb.health!)).toBe('Needs attention at Lunch Flow');
    const monzo = await card('Monzo');
    expect([monzo.error, monzo.health?.detail?.issue]).toEqual([null, 'ok']);
    // The history doesn't move on past an answer that wasn't whole.
    expect((await connectionsStore.get(ctx, id))!.last_fetch?.problems).toEqual([{ message: 'The connection to ASB is disconnected', side: 'connector', accounts: [(await accountsByRemote()).get('2001')!.account_id] }]);
  });

  test('one account’s request failing holds its bank, says there is nothing to do, and the window is asked again', async () => {
    const id = await connectAndTrack();
    await nextDay();
    server.accounts[1].transactions.push(lfTxn('t-late', 1, -5, 'Late one'));
    server.behaviours = [{ on: 'transactions', account: 1471, status: 500, body: JSON.stringify({ error: 'ProviderError', message: 'API request failed (429 - Rate limit exceeded). Please try again in 7 seconds.' }) }];
    const conn = (await connectionsStore.get(ctx, id))!;
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW + 86_400_000 });
    const monzo = await card('Monzo');
    // A wait, on Lunch Flow's side: never "fix it in Lunch Flow".
    expect(monzo.health).toMatchObject({ state: 'outage', action: 'wait', side: 'connector' });
    expect(monzo.health?.detail).toMatchObject({ issue: 'down', messages: [expect.stringContaining('Credit Card: no transactions came. API request failed')] });
    expect(connectorBadge(monzo.health!)).toBe('Not updating');
    const said = connectorHealthText('Monzo', monzo.health!)!;
    expect(said).toContain('Nothing to do: this usually clears on its own, and Nya asks again at its next update.');
    expect(said).not.toContain('fix it in');
    expect((await computeNetWorth(ctx)).institutions.every(isRecordable)).toBe(false);
    // Not whole: the history stays where it was, so the next one asks from there.
    expect((await connectionsStore.get(ctx, id))!.history).toEqual(conn.history);
    server.behaviours = [];
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW + 86_400_000 });
    expect((await card('Monzo')).error).toBeNull();
    expect((await rowsOf((await accountsByRemote()).get('1471')!.account_id)).some((r) => r.source_id === 't-late')).toBe(true);
  });

  test('an answer about one account Nya can’t read is a wait too; one Nya’s own time ran out on is on Nya’s side; Lunch Flow’s word about the bank still comes first', async () => {
    const id = await connectAndTrack();
    await nextDay();
    server.behaviours = [{ on: 'transactions', account: 1471, status: 200, body: 'not json' }];
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    let monzo = await card('Monzo');
    expect([monzo.health?.detail?.issue, monzo.health?.side, monzo.health?.action]).toEqual(['down', 'connector', 'wait']);
    expect(connectorHealthText('Monzo', monzo.health!)).toBe('“Credit Card: no transactions came. Its answer isn’t JSON.” Nothing to do: this usually clears on its own, and Nya asks again at its next update.');
    // As a fetch stores one its time ran out on (lib/connectors/lunchflow.ts).
    const cardId = (await accountsByRemote()).get('1471')!.account_id;
    const ranOut = { message: 'Credit Card: no transactions came. Nya’s time for this update ran out before it asked Lunch Flow.', side: 'nya' as const, accounts: [cardId], kind: 'retry' as const };
    await connectionsStore.update(ctx, id, (c) => (c ? { ...c, last_fetch: { ...c.last_fetch!, problems: [ranOut] } } : c));
    monzo = await card('Monzo');
    expect([monzo.health?.detail?.issue, monzo.health?.side]).toEqual(['down', 'nya']);
    // Beside the connector's own word about the bank, that word is what to fix.
    await connectionsStore.update(ctx, id, (c) => (c ? { ...c, last_fetch: { ...c.last_fetch!, problems: [ranOut, { message: 'The connection to Monzo is disconnected', side: 'connector', accounts: [cardId] }] } } : c));
    monzo = await card('Monzo');
    expect(monzo.health?.detail).toMatchObject({ issue: 'reported', messages: ['The connection to Monzo is disconnected'] });
    expect(connectorBadge(monzo.health!)).toBe('Needs attention at Lunch Flow');
    expect(connectorHealthText('Monzo', monzo.health!)).toContain('fix it in Lunch Flow');
  });

  test('a card Lunch Flow reports as money held isn’t counted until the person says which way', async () => {
    seedServer();
    server.accounts[1].balance = { amount: 432.1, currency: 'GBP' };
    const { connection_id } = await connect(ctx, 'lunchflow', server.key, NOW);
    await trackAccounts(ctx, connection_id, [{ remote_id: '1471', type: 'credit' }], NOW);
    const monzo = await card('Monzo');
    expect([monzo.health?.detail?.issue, monzo.accounts[0].balance]).toEqual(['sign', null]);
    // Lunch Flow's words add what to do when neither reading is right.
    expect(connectorHealthText('Monzo', monzo.health!)).toContain('some banks report the credit left to spend instead');
    await confirmSigns(ctx, [{ account_id: monzo.accounts[0].account_id, sign: 'owed_positive' }]);
    expect((await card('Monzo')).accounts[0].balance).toBe(432.1);
  });
});

describe('a key Lunch Flow no longer takes', () => {
  test('is a connection problem with a way to replace it, and a new key carries the same accounts on', async () => {
    const id = await connectAndTrack();
    const before = await accountsByRemote();
    server.keys.clear(); // deleted in Lunch Flow
    await nextDay();
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    const monzo = await card('Monzo');
    expect([monzo.health?.state, monzo.health?.action, monzo.health?.detail?.issue]).toEqual(['relink', 'relink', 'refused']);
    expect(monzo.error).toBe('Lunch Flow needs connecting again');
    expect(connectorHealthText('Monzo', monzo.health!)).toContain('Connect again with an API key from Lunch Flow: your accounts and their history stay.');
    // A new key, in place: the same connection, the same accounts and rows.
    server.keys.add('lf_new_key_1234567890abcdef');
    const wrong = await reconnect(ctx, id, 'lf_still_wrong_000000', NOW).catch((e) => e);
    expect(wrong.kind).toBe('claimed');
    const res = await reconnect(ctx, id, 'lf_new_key_1234567890abcdef', NOW);
    expect(res.record?.failure).toBeNull();
    expect(await secretsStore.get(ctx, id)).toEqual({ connector: 'lunchflow', secret: 'lf_new_key_1234567890abcdef' });
    const after = await accountsByRemote();
    expect([...after.values()].map((a) => a.account_id).sort()).toEqual([...before.values()].map((a) => a.account_id).sort());
    expect((await card('Monzo')).error).toBeNull();
    // A key for another kind of connection is refused, changing nothing.
    const other = await reconnect(ctx, id, 'whatever-token', NOW, 'simplefin').catch((e) => e);
    expect([other.name, other.status]).toEqual(['ConnectorRefused', 400]);
  });

  test('a key Nya can’t read asks for one again, in Lunch Flow’s words', async () => {
    const id = await connectAndTrack();
    await secretsStore.remove(ctx, id);
    await nextDay();
    const res = await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect(res.record?.failure).toMatchObject({ kind: 'credentials', message: 'Nya no longer has the access Lunch Flow gave it. Connect again with an API key from Lunch Flow.' });
  });
});

describe('letting go', () => {
  test('a disconnect deletes the key and keeps the accounts as manual ones, in their currencies, with their rows', async () => {
    const id = await connectAndTrack();
    const before = await accountsByRemote();
    const released = await disconnect(ctx, id, true, NOW);
    expect(released.kept.length).toBe(3);
    expect(await secretsStore.get(ctx, id)).toBeNull();
    expect(await connectionsStore.get(ctx, id)).toBeNull();
    const manual = await getManualAccounts(ctx);
    expect(manual.map((m) => [m.name, m.balance, m.currency ?? 'USD']).sort()).toEqual(
      [
        ['Credit Card', 432.1, 'GBP'],
        ['Current Account', 1520.4, 'GBP'],
        ['Savings', 10000, 'NZD'],
      ].sort()
    );
    expect((await rowsOf(before.get('1470')!.account_id)).length).toBe(3);
    const ended = await endedAccountsStore.getAll(ctx);
    expect([...ended.values()].map((e) => [e.connector, e.host, e.kept])).toEqual([
      ['lunchflow', `bridge.test:${server.port}`, true],
      ['lunchflow', `bridge.test:${server.port}`, true],
      ['lunchflow', `bridge.test:${server.port}`, true],
    ]);
    // Nothing is fetched again.
    server.seen.length = 0;
    await syncConnectorsDaily(ctx, { now: NOW }).done;
    expect(server.seen).toEqual([]);
    // The person forgets what was kept of one.
    expect(await forgetEnded(ctx, before.get('2001')!.account_id)).toBe(true);
    expect(await endedAccountsStore.count(ctx)).toBe(2);
  });

  test('removing them forgets their rows; stopping one keeps the rest connected', async () => {
    const id = await connectAndTrack();
    const before = await accountsByRemote();
    const one = await releaseAccounts(ctx, [before.get('2001')!.account_id], false, NOW);
    expect(one.removed.length).toBe(1);
    expect(await rowsOf(before.get('2001')!.account_id)).toEqual([]);
    expect((await connectionsStore.get(ctx, id))!.tracked.map((t) => t.remote_id).sort()).toEqual(['1470', '1471']);
    const all = await disconnect(ctx, id, false, NOW);
    expect(all.removed.length).toBe(2);
    expect(await rowsOf(before.get('1470')!.account_id)).toEqual([]);
    expect(await secretsStore.count(ctx)).toBe(0);
  });
});

describe('containers', () => {
  test('one container’s Lunch Flow connection, key and accounts are out of another’s reach', async () => {
    const mine = await connectAndTrack();
    expect(await connectionsStore.get(OTHER, mine)).toBeNull();
    expect(await secretsStore.get(OTHER, mine)).toBeNull();
    expect(await connectorAccountsStore.count(OTHER)).toBe(0);
    expect((await syncConnection(OTHER, mine, { purpose: 'refresh', now: NOW })).skipped).toBe('gone');
    expect((await computeNetWorth(OTHER)).institutions.some((i) => i.connector === 'lunchflow')).toBe(false);
    await disconnect(OTHER, mine, false, NOW);
    expect(await secretsStore.get(ctx, mine)).toEqual({ connector: 'lunchflow', secret: server.key });
    expect(await connectorAccountsStore.count(ctx)).toBe(3);
  });
});

describe('the key', () => {
  test('never reaches a log or storage in the clear, whatever fails', async () => {
    const { logged } = await quietly(async () => {
      const id = await connectAndTrack();
      for (const b of [
        { on: 'accounts' as const, status: 403, body: JSON.stringify({ error: 'Forbidden', message: `bad key ${server.key}` }) },
        { on: 'accounts' as const, status: 500, body: `key ${server.key} rejected` },
        { on: 'balance' as const, status: 503, body: JSON.stringify({ message: `${server.key} is rate limited` }) },
        { on: 'accounts' as const, status: 200, body: 'not json at all' },
        { on: 'accounts' as const, location: 'https://elsewhere.example/collect' },
      ]) {
        await nextDay();
        server.behaviours = [b];
        await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
        await computeNetWorth(ctx);
      }
      server.behaviours = [];
      await fake.set(ctxKey('connector-requests'), 'not a count');
      await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
      await syncConnectorsDaily(ctx).done;
      const [first] = [...(await connectorAccountsStore.getAll(ctx)).keys()];
      await fake.hset(ctxKey('connector-accounts'), { [first]: 'damaged' });
      await computeNetWorth(ctx);
    });
    expect(logged).toContain('request count');
    expect(logged).toContain('Connector accounts read failed');
    expect(logged).not.toContain(server.key);
    expect(storedText()).not.toContain(server.key);
  });
});
