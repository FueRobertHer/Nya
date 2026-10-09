import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount, type FakeTxn } from './simplefin-fake';

// The daily fetch from SimpleFIN and what it keeps (lib/connectors/sync.ts,
// manage.ts, institutions.ts), against a local fake server: connecting,
// tracking accounts, transactions matched by SimpleFIN's id across
// overlapping windows, the request budget, older history a window at a time,
// the snapshot gate held whenever an answer isn't whole, connection health,
// letting accounts go both ways, one container's connections out of
// another's reach, and Plaid never called.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

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
const { connect, trackAccounts, retypeAccounts, releaseAccounts, disconnect, reconnect, MAX_CONNECTIONS } = await import('@/lib/connectors/manage');
const sync = await import('@/lib/connectors/sync');
const { syncConnection, syncConnectorsDaily, recentStart, advanceHistory, backfillWindow, DAILY_REQUESTS, REFRESH_RESERVE, BACKFILL_WINDOWS_PER_RUN } = sync;
const { connectionsStore, connectorAccountsStore, secretsStore } = await import('@/lib/connectors/store');
const { buildConnectorInstitutions, FRESH_HOURS } = await import('@/lib/connectors/institutions');
const { computeNetWorth, recordFetch, isRecordable } = await import('@/lib/networth');
const { manualTxnStore, editManualTxn, findManualTxn } = await import('@/lib/manual-txns');
const { getManualAccounts } = await import('@/lib/manual');
const { getAccountHistory, recordSnapshot } = await import('@/lib/history');
const { setAccountHidden, getHiddenAccounts } = await import('@/lib/hidden');
const { setExcluded, readExclusions } = await import('@/lib/txn-annotations');
const { getKeptAccounts } = await import('@/lib/kept-accounts');
const { SIMPLEFIN } = await import('@/lib/connectors/simplefin');

const ctx = TEST_CTX;
const OTHER = { container: '3f0b8c1e-6d2a-4b5c-9e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const DAY = 86_400_000;
const NOW = Date.now();
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const TODAY = dayOf(NOW);
/** Noon UTC, n days ago, as a Unix time. */
const ago = (n: number) => Math.floor(Date.parse(`${dayOf(NOW - n * DAY)}T12:00:00Z`) / 1000);

let server: FakeSimplefin;
beforeAll(async () => {
  server = await FakeSimplefin.start();
});
afterAll(() => {
  setTransportForTests(null);
  server.stop();
});
beforeEach(() => {
  fake.reset();
  server.reset();
  setTransportForTests(server.transport());
  plaidCalls.length = 0;
});
afterEach(() => expect(plaidCalls).toEqual([]));

const txn = (id: string, daysAgo: number, amount: string, description = `TXN ${id}`, extra: Partial<FakeTxn> = {}): FakeTxn => ({ id, posted: ago(daysAgo), amount, description, ...extra });

/** A checking account and a card at one bank, and a savings account at another. */
function seedServer() {
  server.accounts = [
    fakeAccount({
      id: 'CHK',
      name: 'Checking',
      balance: '1500.25',
      'balance-date': ago(1),
      transactions: [txn('c1', 3, '-12.50', 'COFFEE'), txn('c2', 10, '2500.00', 'PAYROLL'), txn('c3', 40, '-80.00', 'GROCER')],
    }),
    fakeAccount({
      id: 'CARD',
      name: 'Visa',
      balance: '-432.10',
      'balance-date': ago(1),
      transactions: [txn('v1', 2, '-45.67', 'DINER'), txn('v2', 20, '300.00', 'PAYMENT THANK YOU')],
    }),
    fakeAccount({
      id: 'SAV',
      name: 'Savings',
      org: { name: 'Second Credit Union', domain: 'scu.example' },
      balance: '10000.00',
      'balance-date': ago(1),
      transactions: [txn('s1', 5, '1.23', 'INTEREST')],
    }),
  ];
}

/** Connects, and tracks the given accounts with their kinds. */
async function connectAndTrack(choices: [string, 'depository' | 'credit' | 'investment' | 'loan' | 'other'][] = [['CHK', 'depository'], ['CARD', 'credit'], ['SAV', 'depository']], c = ctx) {
  seedServer();
  const { connection_id } = await connect(c, 'simplefin', server.setupToken(`t-${Math.random()}`), NOW);
  await trackAccounts(c, connection_id, choices.map(([remote_id, type]) => ({ remote_id, type })), NOW);
  return connection_id;
}

/** The tracked accounts, by the connector's id for each. */
async function accountsByRemote(c = ctx) {
  return new Map([...(await connectorAccountsStore.getAll(c)).values()].map((a) => [a.remote_id, a]));
}

/** A new day's window of requests, as the counter's expiry would bring. */
async function nextDay(c = ctx) {
  await fake.del(ctxKey('connector-requests', c));
}

async function rowsOf(account_id: string, c = ctx) {
  return (await manualTxnStore.get(c, account_id))?.rows ?? [];
}

/** Runs `fn` with console output collected instead of printed. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const saved = [console.error, console.warn, console.log];
  const lines: string[] = [];
  console.error = console.warn = console.log = (...a: unknown[]) => lines.push(a.map((x) => (x instanceof Error ? `${x.name} ${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  try {
    return { result: await fn(), logged: lines.join('\n') };
  } finally {
    [console.error, console.warn, console.log] = saved;
  }
}

describe('connecting', () => {
  test('claims the token once, keeps the Access URL encrypted, and lists the accounts by name without storing a balance', async () => {
    seedServer();
    const { connection_id, result } = await connect(ctx, 'simplefin', server.setupToken('first'), NOW);
    expect(server.seen.map((r) => [r.method, r.path, r.query])).toEqual([
      ['POST', '/simplefin/claim/first', {}],
      ['GET', '/simplefin/accounts', { 'balances-only': '1' }],
    ]);
    expect(result.answer?.accounts.map((a) => [a.remote_id, a.balance])).toEqual([
      ['CHK', 1500.25],
      ['CARD', -432.1],
      ['SAV', 10000],
    ]);
    const conn = (await connectionsStore.get(ctx, connection_id))!;
    expect(conn.available.map((a) => [a.remote_id, a.name, a.institution, a.currency])).toEqual([
      ['CHK', 'Checking', 'My Bank', 'USD'],
      ['CARD', 'Visa', 'My Bank', 'USD'],
      ['SAV', 'Savings', 'Second Credit Union', 'USD'],
    ]);
    expect(conn.host).toBe(`bridge.test:${server.port}`);
    expect(await connectorAccountsStore.count(ctx)).toBe(0);
    // The credential is kept, and only encrypted: nothing in storage holds it
    // in the clear, nor any balance of an account not chosen.
    expect((await secretsStore.get(ctx, connection_id))?.secret).toBe(server.accessUrl());
    const stored = JSON.stringify([...(fake as any).hashes.entries()].map(([k, h]: [string, Map<string, string>]) => [k, [...h]]));
    expect(stored).not.toContain(server.password);
    expect(stored).not.toContain('1500.25');
  });

  test('a token already used is said so, and nothing is kept', async () => {
    const token = server.setupToken('used');
    await connect(ctx, 'simplefin', token, NOW);
    const err = await connect(ctx, 'simplefin', token, NOW).catch((e) => e);
    expect(err.kind).toBe('claimed');
    expect(await connectionsStore.count(ctx)).toBe(1);
  });

  test(`at most ${MAX_CONNECTIONS} connections, and the claims an hour are bounded`, async () => {
    for (let i = 0; i < MAX_CONNECTIONS; i++) await connect(ctx, 'simplefin', server.setupToken(`c${i}`), NOW);
    const err = await connect(ctx, 'simplefin', server.setupToken('more'), NOW).catch((e) => e);
    expect([err.name, err.status]).toEqual(['ConnectorRefused', 409]);
    expect(server.claimed.get('more')).toBe(false);
  });

  test('a failed listing leaves the connection made, to list later', async () => {
    seedServer();
    server.behaviour = { on: 'accounts', status: 500, body: 'down for maintenance' };
    const { connection_id, result } = await connect(ctx, 'simplefin', server.setupToken('x'), NOW);
    expect(result.record?.failure?.kind).toBe('down');
    expect(result.record?.failure?.message).toContain('down for maintenance');
    server.behaviour = null;
    const again = await syncConnection(ctx, connection_id, { purpose: 'refresh', now: NOW });
    expect(again.record?.failure).toBeNull();
    expect((await connectionsStore.get(ctx, connection_id))!.available.length).toBe(3);
  });
});

describe('tracking and fetching', () => {
  test('the first fetch asks for the last 90 days and keeps posted transactions in Plaid’s sign, under SimpleFIN’s ids', async () => {
    const id = await connectAndTrack();
    const fetch = server.accountRequests.at(-1)!;
    expect(fetch.query).toEqual({ 'start-date': String(Date.parse(`${dayOf(NOW - 90 * DAY)}T00:00:00Z`) / 1000) });
    const accounts = await accountsByRemote();
    const chk = await rowsOf(accounts.get('CHK')!.account_id);
    expect(chk.map((r) => [r.source, r.source_id, r.amount, r.name, r.date]).sort()).toEqual(
      [
        ['simplefin', 'c1', 12.5, 'COFFEE', dayOf(NOW - 3 * DAY)],
        ['simplefin', 'c2', -2500, 'PAYROLL', dayOf(NOW - 10 * DAY)],
        ['simplefin', 'c3', 80, 'GROCER', dayOf(NOW - 40 * DAY)],
      ].sort()
    );
    expect(chk.every((r) => r.id.startsWith('manual-txn:') && r.account_id === accounts.get('CHK')!.account_id && r.category === null)).toBe(true);
    // The card's purchase is money out (positive), its payment money in.
    expect((await rowsOf(accounts.get('CARD')!.account_id)).map((r) => [r.source_id, r.amount]).sort()).toEqual([
      ['v1', 45.67],
      ['v2', -300],
    ]);
    // Balances as reported, and the time the bank gave them.
    expect(accounts.get('CARD')).toMatchObject({ reported_balance: -432.1, type: 'credit', balance_at: new Date(ago(1) * 1000).toISOString() });
    const conn = (await connectionsStore.get(ctx, id))!;
    expect(conn.history).toEqual({ from: dayOf(NOW - 90 * DAY), to: TODAY, complete: false, failed: null });
    expect(conn.available).toEqual([]);
    expect(conn.tracked.map((t) => t.remote_id).sort()).toEqual(['CARD', 'CHK', 'SAV']);
  });

  test('fetching overlapping windows again adds nothing; a new transaction is added once', async () => {
    const id = await connectAndTrack();
    const chkId = (await accountsByRemote()).get('CHK')!.account_id;
    const before = await rowsOf(chkId);
    const again = await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect([again.record?.added, again.record?.updated]).toEqual([0, 0]);
    expect(await rowsOf(chkId)).toEqual(before);
    server.accounts[0].transactions.push(txn('c4', 0, '-5.00', 'BAKERY'));
    const third = await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect(third.record?.added).toBe(1);
    expect((await rowsOf(chkId)).filter((r) => r.source_id === 'c4').length).toBe(1);
    // Two identical coffees with two ids are two transactions.
    server.accounts[0].transactions.push(txn('c5', 0, '-5.00', 'BAKERY'));
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect((await rowsOf(chkId)).filter((r) => r.name === 'BAKERY').length).toBe(2);
  });

  test('an id seen twice in one answer is one transaction', async () => {
    seedServer();
    server.accounts[0].transactions.push(txn('c1', 3, '-12.50', 'COFFEE'));
    const { connection_id } = await connect(ctx, 'simplefin', server.setupToken('dup'), NOW);
    await trackAccounts(ctx, connection_id, [{ remote_id: 'CHK', type: 'depository' }], NOW);
    const chkId = (await accountsByRemote()).get('CHK')!.account_id;
    expect((await rowsOf(chkId)).filter((r) => r.source_id === 'c1').length).toBe(1);
  });

  test('a transaction the bank changed is brought up to date, keeping the person’s category', async () => {
    const id = await connectAndTrack();
    const chkId = (await accountsByRemote()).get('CHK')!.account_id;
    const row = (await rowsOf(chkId)).find((r) => r.source_id === 'c1')!;
    await editManualTxn(ctx, row.id, { category: 'food and drink' }, { from: chkId });
    server.accounts[0].transactions[0] = txn('c1', 3, '-14.00', 'COFFEE SHOP');
    const res = await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect([res.record?.added, res.record?.updated]).toEqual([0, 1]);
    const now = (await rowsOf(chkId)).find((r) => r.source_id === 'c1')!;
    expect([now.id, now.amount, now.name, now.category, now.created_at]).toEqual([row.id, 14, 'COFFEE SHOP', 'food and drink', row.created_at]);
  });

  test('pending transactions are never asked for, and never kept if sent', async () => {
    seedServer();
    server.accounts[0].transactions.push(txn('p1', 0, '-9.99', 'PENDING', { pending: true }));
    const { connection_id } = await connect(ctx, 'simplefin', server.setupToken('pend'), NOW);
    await trackAccounts(ctx, connection_id, [{ remote_id: 'CHK', type: 'depository' }], NOW);
    expect(server.accountRequests.every((r) => r.query.pending === undefined)).toBe(true);
    // A server that sends them anyway.
    server.extra = {};
    const chkId = (await accountsByRemote()).get('CHK')!.account_id;
    expect((await rowsOf(chkId)).some((r) => r.source_id === 'p1')).toBe(false);
  });

  test('a card picked as a card shows its debt as owed, and its contribution is the same whatever kind it is given', async () => {
    await connectAndTrack();
    const card = (await accountsByRemote()).get('CARD')!;
    const shown = async () => (await computeNetWorth(ctx)).institutions.flatMap((i) => i.accounts).find((a) => a.account_id === card.account_id);
    const { netWorth: before } = await computeNetWorth(ctx);
    expect((await shown()).balance).toBe(432.1);
    await retypeAccounts(ctx, [{ account_id: card.account_id, type: 'depository' }]);
    expect((await shown()).balance).toBe(-432.1);
    expect((await computeNetWorth(ctx)).netWorth).toBeCloseTo(before, 6);
    expect(before).toBeCloseTo(1500.25 - 432.1 + 10000, 6);
  });

  test('an account Nya can’t track (an unknown currency) is refused, and one not offered too', async () => {
    seedServer();
    server.accounts.push(fakeAccount({ id: 'MILES', name: 'Miles', currency: 'https://example.com/miles.json' }));
    const { connection_id } = await connect(ctx, 'simplefin', server.setupToken('cur'), NOW);
    const unknown = await trackAccounts(ctx, connection_id, [{ remote_id: 'MILES', type: 'other' }], NOW).catch((e) => e);
    expect([unknown.status, unknown.message]).toEqual([400, expect.stringContaining('currency')]);
    const invented = await trackAccounts(ctx, connection_id, [{ remote_id: 'NOPE', type: 'other' }], NOW).catch((e) => e);
    expect(invented.status).toBe(409);
    expect(await connectorAccountsStore.count(ctx)).toBe(0);
  });

  test('the same account tracked from two devices at once is one account', async () => {
    seedServer();
    const { connection_id } = await connect(ctx, 'simplefin', server.setupToken('twice'), NOW);
    await Promise.all([
      trackAccounts(ctx, connection_id, [{ remote_id: 'CHK', type: 'depository' }], NOW),
      trackAccounts(ctx, connection_id, [{ remote_id: 'CHK', type: 'depository' }], NOW),
    ]);
    expect(await connectorAccountsStore.count(ctx)).toBe(1);
    expect((await connectionsStore.get(ctx, connection_id))!.tracked.length).toBe(1);
  });
});

describe('windows and older history', () => {
  const def = { windowDays: 90, overlapDays: 5 };

  test('the recent window starts five days into what was fetched, and never more than 90 days ago', () => {
    expect(recentStart(null, '2026-10-09', def)).toBe('2026-07-11');
    expect(recentStart({ from: '2026-01-01', to: '2026-10-08', complete: true }, '2026-10-09', def)).toBe('2026-10-03');
    expect(recentStart({ from: '2026-01-01', to: '2026-05-01', complete: true }, '2026-10-09', def)).toBe('2026-07-11');
  });

  test('history joins up when the window overlaps, and starts again after a gap', () => {
    const h = { from: '2026-07-11', to: '2026-10-08', complete: true, failed: null };
    expect(advanceHistory(h, '2026-10-03', '2026-10-09')).toEqual({ ...h, to: '2026-10-09' });
    expect(advanceHistory({ ...h, to: '2026-05-01' }, '2026-07-11', '2026-10-09')).toEqual({ from: '2026-07-11', to: '2026-10-09', complete: false, failed: null });
    expect(advanceHistory(null, '2026-07-11', '2026-10-09')).toEqual({ from: '2026-07-11', to: '2026-10-09', complete: false, failed: null });
  });

  test('each older window ends five days into the one after it', () => {
    expect(backfillWindow({ from: '2026-07-11', to: '2026-10-09', complete: false }, def)).toEqual({ start: '2026-04-17', end: '2026-07-16' });
    expect(backfillWindow({ from: '2026-07-11', to: '2026-10-09', complete: true }, def)).toBeNull();
    expect(backfillWindow(null, def)).toBeNull();
  });

  test('the daily run walks back a window at a time, adds what overlaps once, and stops when there is nothing older', async () => {
    const id = await connectAndTrack([['CHK', 'depository']]);
    const chkId = (await accountsByRemote()).get('CHK')!.account_id;
    // History beyond the first window: 120, 150 and 200 days ago, and one on
    // the edge of the overlap (88 days ago, inside both windows).
    server.accounts[0].transactions.push(txn('old1', 120, '-1.00'), txn('old2', 150, '-2.00'), txn('old3', 200, '-3.00'), txn('edge', 88, '-4.00'));
    // The edge one came with the first window already.
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    const before = server.accountRequests.length;
    const first = await syncConnection(ctx, id, { purpose: 'daily', now: NOW });
    // Fresh within twelve hours: no recent request, two older windows.
    expect(first.skipped).toBe('fresh');
    expect(first.backfilled.windows).toBe(BACKFILL_WINDOWS_PER_RUN);
    const asked = server.accountRequests.slice(before).map((r) => r.query);
    expect(asked).toEqual([
      { 'start-date': String(Date.parse(`${dayOf(NOW - 175 * DAY)}T00:00:00Z`) / 1000), 'end-date': String(Date.parse(`${dayOf(NOW - 85 * DAY)}T00:00:00Z`) / 1000) },
      { 'start-date': String(Date.parse(`${dayOf(NOW - 260 * DAY)}T00:00:00Z`) / 1000), 'end-date': String(Date.parse(`${dayOf(NOW - 170 * DAY)}T00:00:00Z`) / 1000) },
    ]);
    const ids = (await rowsOf(chkId)).map((r) => r.source_id);
    expect(ids.filter((x) => x === 'edge').length).toBe(1);
    expect(['old1', 'old2', 'old3'].every((x) => ids.includes(x))).toBe(true);
    expect((await connectionsStore.get(ctx, id))!.history).toMatchObject({ from: dayOf(NOW - 260 * DAY), complete: false });
    // The next night (a new day's requests): its window brings nothing older,
    // so history is complete.
    await nextDay();
    await syncConnection(ctx, id, { purpose: 'daily', now: NOW });
    expect((await connectionsStore.get(ctx, id))!.history).toMatchObject({ complete: true });
    const after = server.accountRequests.length;
    await syncConnection(ctx, id, { purpose: 'daily', now: NOW });
    expect(server.accountRequests.length).toBe(after);
  });

  test('a window that fails is noted and tried the next night, never touching the gate', async () => {
    const id = await connectAndTrack([['CHK', 'depository']]);
    server.behaviour = { on: 'accounts', status: 500, times: 1 };
    const res = await syncConnection(ctx, id, { purpose: 'daily', now: NOW });
    expect(res.backfilled.windows).toBe(0);
    const conn = (await connectionsStore.get(ctx, id))!;
    expect(conn.history?.failed).toBeTruthy();
    expect(conn.last_fetch?.failure).toBeNull();
    const [inst] = (await computeNetWorth(ctx)).institutions;
    expect(inst.error).toBeNull();
  });
});

describe('the request budget', () => {
  test(`at most ${DAILY_REQUESTS} requests a day, the backfill leaving ${REFRESH_RESERVE} for Refresh`, async () => {
    const id = await connectAndTrack([['CHK', 'depository']]);
    server.accounts[0].transactions.push(...Array.from({ length: 12 }, (_, i) => txn(`h${i}`, 100 + i * 60, '-1.00')));
    // Two requests so far: the listing and the first fetch.
    expect(server.accountRequests.length).toBe(2);
    // Each night's run asks for older windows only while the count leaves the reserve.
    await syncConnection(ctx, id, { purpose: 'daily', now: NOW });
    await syncConnection(ctx, id, { purpose: 'daily', now: NOW });
    expect(server.accountRequests.length).toBe(DAILY_REQUESTS - REFRESH_RESERVE);
    // Refresh takes the rest, then is refused without asking.
    const results = [];
    for (let i = 0; i < REFRESH_RESERVE + 2; i++) results.push((await syncConnection(ctx, id, { purpose: 'refresh', now: NOW })).skipped);
    expect(results).toEqual([...Array(REFRESH_RESERVE).fill(null), 'budget', 'budget']);
    expect(server.accountRequests.length).toBe(DAILY_REQUESTS);
    expect(DAILY_REQUESTS).toBeLessThan(SIMPLEFIN.providerDailyLimit / 2);
  });

  test('a count that can’t be read stops requests rather than opening them', async () => {
    const id = await connectAndTrack([['CHK', 'depository']]);
    await fake.set(ctxKey('connector-requests'), 'not a count');
    const before = server.accountRequests.length;
    const { result } = await quietly(() => syncConnection(ctx, id, { purpose: 'refresh', now: NOW }));
    expect(result.skipped).toBe('budget');
    expect(server.accountRequests.length).toBe(before);
  });

  test('the daily run doesn’t ask again within twelve hours of a good answer', async () => {
    const id = await connectAndTrack([['CHK', 'depository']]);
    const before = server.accountRequests.length;
    const res = await syncConnection(ctx, id, { purpose: 'daily', now: NOW + 3_600_000 });
    expect(res.skipped).toBe('fresh');
    const stale = await syncConnection(ctx, id, { purpose: 'daily', now: NOW + 13 * 3_600_000 });
    expect(stale.skipped).toBeNull();
    expect(server.accountRequests.length).toBeGreaterThan(before);
  });
});

describe('the snapshot gate and connection health', () => {
  const instOf = (list: Awaited<ReturnType<typeof computeNetWorth>>['institutions'], name: string) => list.find((i) => i.institution_name === name)!;

  test('a whole answer is recorded in the real history layer, as a measurement', async () => {
    await connectAndTrack();
    const { institutions, netWorth } = await computeNetWorth(ctx);
    expect(institutions.every(isRecordable)).toBe(true);
    const bank = instOf(institutions, 'My Bank');
    expect(bank).toMatchObject({ manual: true, connector: 'simplefin', error: null, health: { state: 'healthy', cause: 'connector', side: 'none' } });
    const { date } = await recordFetch(ctx, institutions, netWorth);
    expect(date).toBe(TODAY);
    const card = (await accountsByRemote()).get('CARD')!;
    expect((await getAccountHistory(ctx, card.account_id)).at(-1)).toEqual({ date: TODAY, value: 432.1 });
  });

  test('a failed fetch holds the gate: no total, and no point for its accounts, which show their last balances as last known', async () => {
    const id = await connectAndTrack();
    server.behaviour = { on: 'accounts', status: 503, body: JSON.stringify({ errors: ['Bridge maintenance until 5pm'] }) };
    const res = await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect(res.record?.failure).toMatchObject({ kind: 'down', side: 'connector' });
    const { institutions, netWorth } = await computeNetWorth(ctx);
    const bank = instOf(institutions, 'My Bank');
    expect(isRecordable(bank)).toBe(false);
    expect(bank.accounts.every((a) => a.stale === true && a.balance !== null)).toBe(true);
    expect(bank.stale_as_of).toBe(dayOf(ago(1) * 1000));
    expect(bank.health).toMatchObject({ state: 'outage', side: 'connector', detail: { issue: 'down', messages: [expect.stringContaining('Bridge maintenance until 5pm')] } });
    // Shown in the total, never recorded.
    expect(netWorth).toBeCloseTo(1500.25 - 432.1 + 10000, 6);
    const { date } = await recordFetch(ctx, institutions, netWorth);
    expect(date).toBeNull();
    for (const a of (await accountsByRemote()).values()) expect(await getAccountHistory(ctx, a.account_id)).toEqual([]);
  });

  test('a problem SimpleFIN names one bank for holds that bank alone; the other is recorded for its own chart', async () => {
    const id = await connectAndTrack();
    server.errors = ['Connection to Second Credit Union may need attention'];
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    const { institutions, netWorth } = await computeNetWorth(ctx);
    const scu = instOf(institutions, 'Second Credit Union');
    const bank = instOf(institutions, 'My Bank');
    expect(scu.error).toBe('SimpleFIN reports: Connection to Second Credit Union may need attention');
    expect(scu.health).toMatchObject({ state: 'needs_reauth', side: 'connector', detail: { issue: 'reported', host: `bridge.test:${server.port}` } });
    expect(bank.error).toBeNull();
    expect(await recordFetch(ctx, institutions, netWorth)).toMatchObject({ date: null });
    const by = await accountsByRemote();
    expect((await getAccountHistory(ctx, by.get('CHK')!.account_id)).map((p) => p.value)).toEqual([1500.25]);
    expect(await getAccountHistory(ctx, by.get('SAV')!.account_id)).toEqual([]);
  });

  test('a problem that names no bank holds every account of the connection', async () => {
    const id = await connectAndTrack();
    server.errors = ['Something went wrong'];
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    const { institutions } = await computeNetWorth(ctx);
    expect(institutions.map((i) => i.health?.detail?.issue)).toEqual(['reported', 'reported']);
  });

  test('a problem about a bank no tracked account is at holds nothing', async () => {
    seedServer();
    server.accounts.push(fakeAccount({ id: 'OTHER', name: 'Brokerage', org: { name: 'Faraway Brokers' } }));
    const { connection_id } = await connect(ctx, 'simplefin', server.setupToken('far'), NOW);
    await trackAccounts(ctx, connection_id, [{ remote_id: 'CHK', type: 'depository' }], NOW);
    server.errors = ['Connection to Faraway Brokers may need attention'];
    await syncConnection(ctx, connection_id, { purpose: 'refresh', now: NOW });
    const { institutions } = await computeNetWorth(ctx);
    expect(institutions.every(isRecordable)).toBe(true);
  });

  test('a tracked account missing from the answer holds its bank, and says which', async () => {
    const id = await connectAndTrack();
    server.accounts = server.accounts.filter((a) => a.id !== 'CARD');
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    const { institutions } = await computeNetWorth(ctx);
    const bank = instOf(institutions, 'My Bank');
    expect(bank.health).toMatchObject({ state: 'partial', action: 'resolve', detail: { issue: 'missing', accounts: ['Visa'] } });
    expect(isRecordable(bank)).toBe(false);
    expect(isRecordable(instOf(institutions, 'Second Credit Union'))).toBe(true);
  });

  test('accounts no answer has held yet, and an answer older than a day and a half, hold the gate', async () => {
    const id = await connectAndTrack();
    const conn = (await connectionsStore.get(ctx, id))!;
    const accounts = [...(await connectorAccountsStore.getAll(ctx)).values()];
    const waiting = buildConnectorInstitutions(new Map([[id, conn]]), accounts.map((a) => ({ ...a, reported_balance: null, fetched_at: null })), NOW);
    expect(waiting.map((i) => [i.health?.detail?.issue, isRecordable(i)])).toEqual([
      ['waiting', false],
      ['waiting', false],
    ]);
    const late = buildConnectorInstitutions(new Map([[id, conn]]), accounts, NOW + (FRESH_HOURS + 1) * 3_600_000);
    expect(late.map((i) => [i.health?.detail?.issue, i.health?.side, isRecordable(i)])).toEqual([
      ['stale', 'nya', false],
      ['stale', 'nya', false],
    ]);
  });

  test('SimpleFIN refusing Nya’s access asks to connect again, on the person’s side; a new token carries the same accounts on', async () => {
    const id = await connectAndTrack();
    const before = await accountsByRemote();
    server.behaviour = { on: 'accounts', status: 403, body: 'Forbidden' };
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    const { institutions } = await computeNetWorth(ctx);
    expect(instOf(institutions, 'My Bank').health).toMatchObject({ state: 'relink', action: 'relink', side: 'you', detail: { issue: 'refused' } });
    server.behaviour = null;
    await reconnect(ctx, id, server.setupToken('fresh'), NOW);
    expect(await accountsByRemote()).toEqual(
      new Map([...before].map(([k, a]) => [k, { ...a, fetched_at: expect.any(String) }])) as any
    );
    expect((await computeNetWorth(ctx)).institutions.every(isRecordable)).toBe(true);
  });

  test('connector accounts that can’t be read hold the gate rather than going short', async () => {
    await connectAndTrack();
    const [first] = [...(await connectorAccountsStore.getAll(ctx)).keys()];
    await fake.hset(ctxKey('connector-accounts'), { [first]: 'damaged' });
    const { result } = await quietly(() => computeNetWorth(ctx));
    const broken = result.institutions.find((i) => i.item_id === 'connector:unreadable')!;
    expect(broken.error).toContain('Could not load');
    expect(result.institutions.every(isRecordable)).toBe(false);
  });

  test('the daily run fetches beside the snapshot, and its accounts are recorded once it is over', async () => {
    const id = await connectAndTrack();
    server.accounts[0].balance = '1600.00';
    // As the catch-up would find it: the last answer old enough to ask again.
    await connectionsStore.update(ctx, id, (c) => (c ? { ...c, last_answer_at: new Date(NOW - 13 * 3_600_000).toISOString() } : c));
    const ready = syncConnectorsDaily(ctx);
    const { institutions } = await computeNetWorth(ctx, { connectorsReady: ready });
    expect(instOf(institutions, 'My Bank').accounts.find((a) => a.name === 'Checking')?.balance).toBe(1600);
  });
});

describe('letting accounts go', () => {
  test('keeping makes each a manual account under the same id, with its balance, transactions and history', async () => {
    const id = await connectAndTrack();
    const by = await accountsByRemote();
    const chk = by.get('CHK')!;
    const card = by.get('CARD')!;
    await recordSnapshot(ctx, 0, { [chk.account_id]: 1500.25 });
    const rows = await rowsOf(chk.account_id);
    const released = await disconnect(ctx, id, true, NOW);
    expect(released.kept.sort()).toEqual([...by.values()].map((a) => a.account_id).sort());
    const manual = new Map((await getManualAccounts(ctx)).map((m) => [m.account_id, m]));
    expect(manual.get(chk.account_id)).toMatchObject({ name: 'Checking', institution_name: 'My Bank', type: 'depository', balance: 1500.25 });
    expect(manual.get(card.account_id)).toMatchObject({ type: 'credit', balance: 432.1 });
    expect(await rowsOf(chk.account_id)).toEqual(rows);
    expect(await getAccountHistory(ctx, chk.account_id)).toEqual([{ date: TODAY, value: 1500.25 }]);
    // Nothing of the connection is left to fetch with.
    expect(await connectorAccountsStore.count(ctx)).toBe(0);
    expect(await secretsStore.get(ctx, id)).toBeNull();
    expect(await connectionsStore.get(ctx, id)).toBeNull();
    const { institutions } = await computeNetWorth(ctx);
    expect(institutions.every((i) => i.manual && !i.connector)).toBe(true);
    const requests = server.accountRequests.length;
    await syncConnectorsDaily(ctx);
    expect(server.accountRequests.length).toBe(requests);
  });

  test('an account in another currency is kept in it', async () => {
    seedServer();
    server.accounts.push(fakeAccount({ id: 'AUD', name: 'Everyday', currency: 'AUD', balance: '250.00', org: { name: 'Antipodean Bank' } }));
    const { connection_id } = await connect(ctx, 'simplefin', server.setupToken('aud'), NOW);
    await trackAccounts(ctx, connection_id, [{ remote_id: 'AUD', type: 'depository' }], NOW);
    const aud = (await accountsByRemote()).get('AUD')!;
    expect((await computeNetWorth(ctx)).institutions[0].accounts[0].currency).toBe('AUD');
    await disconnect(ctx, connection_id, true, NOW);
    expect((await getManualAccounts(ctx)).find((m) => m.account_id === aud.account_id)?.currency).toBe('AUD');
    expect((await computeNetWorth(ctx)).institutions[0].accounts[0].currency).toBe('AUD');
  });

  test('removing deletes the accounts and their transactions and what was said about them; past balances stay, and a hidden one stays hidden', async () => {
    const id = await connectAndTrack();
    const chk = (await accountsByRemote()).get('CHK')!;
    await recordSnapshot(ctx, 0, { [chk.account_id]: 1500.25 });
    const row = (await rowsOf(chk.account_id))[0];
    await setExcluded(ctx, row.id, true);
    await setAccountHidden(ctx, chk.account_id, 'depository', true);
    const released = await disconnect(ctx, id, false, NOW);
    expect(released.removed.length).toBe(3);
    expect(await manualTxnStore.get(ctx, chk.account_id)).toBeNull();
    expect((await readExclusions(ctx)).records.has(row.id)).toBe(false);
    expect(await getManualAccounts(ctx)).toEqual([]);
    expect(await getAccountHistory(ctx, chk.account_id)).toEqual([{ date: TODAY, value: 1500.25 }]);
    expect((await getHiddenAccounts(ctx)).has(chk.account_id)).toBe(true);
    expect((await computeNetWorth(ctx)).institutions).toEqual([]);
  });

  test('stopping one account keeps the rest tracked, and offers it again', async () => {
    const id = await connectAndTrack();
    const card = (await accountsByRemote()).get('CARD')!;
    await releaseAccounts(ctx, [card.account_id], true, NOW);
    expect([...(await accountsByRemote()).keys()].sort()).toEqual(['CHK', 'SAV']);
    await syncConnection(ctx, id, { purpose: 'refresh', now: NOW });
    expect((await connectionsStore.get(ctx, id))!.available.map((a) => a.remote_id)).toEqual(['CARD']);
    // Kept as a manual account: Activity, sharing and the estimate read it once.
    const kept = await getKeptAccounts(ctx);
    expect(kept.filter((a) => a.account_id === card.account_id).length).toBe(1);
  });
});

describe('containers', () => {
  test('one container’s connections are out of another’s reach', async () => {
    const mine = await connectAndTrack();
    server.reset();
    seedServer();
    const theirs = await connectAndTrack([['SAV', 'depository']], OTHER);
    const mineKeys = () => [...(fake as any).hashes.keys(), ...(fake as any).strings.keys()].filter((k: string) => k.startsWith(ctxKey('', ctx)));
    const theirKeys = () => [...(fake as any).hashes.keys(), ...(fake as any).strings.keys()].filter((k: string) => k.startsWith(ctxKey('', OTHER)));
    const snapshot = () => JSON.stringify(theirKeys().map((k: string) => [k, (fake as any).hashes.get(k) ? [...(fake as any).hashes.get(k)] : (fake as any).strings.get(k)]));
    const before = snapshot();
    expect(mineKeys().length).toBeGreaterThan(0);
    // Reaching for their connection from mine finds nothing, and changes nothing there.
    expect((await syncConnection(ctx, theirs, { purpose: 'refresh', now: NOW })).skipped).toBe('gone');
    await syncConnectorsDaily(ctx);
    await disconnect(ctx, theirs, false, NOW);
    expect(snapshot()).toBe(before);
    expect((await computeNetWorth(OTHER)).institutions.map((i) => i.institution_name)).toEqual(['Second Credit Union']);
    expect((await computeNetWorth(ctx)).institutions.length).toBe(2);
    expect(await connectionsStore.get(OTHER, mine)).toBeNull();
  });
});

describe('the bank’s transactions', () => {
  test('keep their date, amount and payee: only their category and note change, and they are never deleted alone', async () => {
    await connectAndTrack([['CHK', 'depository']]);
    const chk = (await accountsByRemote()).get('CHK')!;
    const row = (await rowsOf(chk.account_id))[0];
    const amount = await editManualTxn(ctx, row.id, { amount: 1 }, { from: chk.account_id }).catch((e) => e);
    expect([amount.name, amount.message]).toEqual(['InvalidTxnError', expect.stringContaining('through SimpleFIN')]);
    const saved = await editManualTxn(ctx, row.id, { category: 'groceries', note: 'weekly shop' }, { from: chk.account_id });
    expect([saved?.category, saved?.note, saved?.amount]).toEqual(['groceries', 'weekly shop', row.amount]);
    const { deleteManualTxn } = await import('@/lib/manual-txns');
    expect((await deleteManualTxn(ctx, row.id, chk.account_id).catch((e) => e)).name).toBe('InvalidTxnError');
    expect(await findManualTxn(ctx, row.id, chk.account_id)).not.toBeNull();
  });
});
