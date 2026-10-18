import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { FakeLunchFlow, daysAgo, lfAccount, lfTxn } from './lunchflow-fake';

// The Lunch Flow connector on its own (lib/connectors/lunchflow.ts), against a
// local fake of the Personal API (test/lunchflow-fake.ts): what a pasted key
// must look like, checking it once, reading accounts, balances and windows of
// transactions account by account, every status Lunch Flow answers, the
// readings chosen where its documentation is silent (`total`, the window's
// parameters, signs, pending rows), and the key going to Lunch Flow's own host
// only, and never into an error.

const { setTransportForTests, guardedRequest, UnsafeUrlError } = await import('@/lib/connectors/http');
const lf = await import('@/lib/connectors/lunchflow');
const { LUNCHFLOW, checkKey, checkWithLunchFlow, fetchLunchFlow, setLunchFlowApiForTests, readTransactions, readBalance, readAccountList, failureOfStatus, NO_DESCRIPTION, LUNCHFLOW_API } = lf;
const { connectorOf } = await import('@/lib/connectors/registry');

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
  server.reset();
  setTransportForTests(server.transport());
  setLunchFlowApiForTests(server.base());
});

const T = { timeoutMs: 10_000 };
const window = (days: number) => ({ start: daysAgo(days), end: null, accounts: ['1470', '1471'] });

/** A checking account and a card at one bank, and savings at another. */
function seed() {
  server.accounts = [
    lfAccount({
      id: 1470,
      name: 'Main Account A',
      transactions: [lfTxn('c98ce8f4b11342ff0877b33d4a9d395d', 3, -95.35, 'Freshto Ideal'), lfTxn('5d823e7fa31f227822c3d3394841eaa5', 4, 15, 'Jennifer Houston')],
    }),
    lfAccount({ id: 1471, name: 'Credit Card', balance: { amount: -432.1, currency: 'EUR' }, transactions: [lfTxn('49a2a3ff8a6916c2c18ab37edae57150', 2, -950, 'Liam Brown')] }),
    lfAccount({ id: 2001, name: 'Savings', institution_name: 'Second Bank', provider: 'akahu', balance: { amount: '10000.00', currency: 'NZD' } }),
  ];
}

describe('the key', () => {
  test('is one word of visible characters, of a key’s length, and nothing else is sent anywhere', () => {
    expect(checkKey(`  ${server.key}\n`)).toBe(server.key);
    for (const [input, words] of [
      ['', 'Paste the API key'],
      ['   ', 'Paste the API key'],
      ['x'.repeat(600), 'too long'],
      ['https://lunchflow.app/destinations', 'web address'],
      ['lf_abc def_ghij', 'no spaces'],
      ['short', 'doesn’t look like'],
      ['lf_ключ_123456', 'doesn’t look like'],
    ] as const) {
      const err = (() => {
        try {
          checkKey(input);
        } catch (e) {
          return e as { kind: string; message: string };
        }
      })();
      expect([input.slice(0, 20), err?.kind, err?.message.includes(words)]).toEqual([input.slice(0, 20), 'invalid', true]);
    }
    expect(server.seen).toEqual([]);
  });

  test('a good key is checked once with the listing, in the x-api-key header only, and kept as it is', async () => {
    seed();
    const got = await checkWithLunchFlow(` ${server.key} `, T);
    expect(got).toEqual({ secret: server.key, host: `bridge.test:${server.port}` });
    expect(server.seen.map((r) => [r.method, r.path, r.key])).toEqual([['GET', '/api/v1/accounts', server.key]]);
    expect(Object.keys(server.seen[0].query)).toEqual([]);
  });

  test('a key Lunch Flow refuses is said so; a key it never got is not used up', async () => {
    const refused = await checkWithLunchFlow('lf_not-a-real-key-000', T).catch((e) => e);
    expect([refused.name, refused.kind]).toEqual(['ExchangeFailure', 'claimed']);
    expect(refused.message).toContain('didn’t accept this API key');
    server.behaviours = [{ on: 'accounts', status: 503, body: JSON.stringify({ error: 'GCRateLimited', message: 'Bank data is temporarily unavailable.' }) }];
    const down = await checkWithLunchFlow(server.key, T).catch((e) => e);
    expect([down.kind, down.message]).toEqual(['down', expect.stringContaining('HTTP 503')]);
    server.behaviours = [{ on: 'accounts', status: 200, body: 'not json' }];
    expect((await checkWithLunchFlow(server.key, T).catch((e) => e)).kind).toBe('answer');
    server.behaviours = [{ on: 'accounts', status: 200, body: JSON.stringify({ items: [] }) }];
    expect((await checkWithLunchFlow(server.key, T).catch((e) => e)).kind).toBe('answer');
  });

  test('Lunch Flow’s host only: one that resolves to a private address is refused before anything is sent', async () => {
    setLunchFlowApiForTests('https://inside.example/api/v1');
    server.names.set('inside.example', ['10.0.0.5']);
    const err = await checkWithLunchFlow(server.key, T).catch((e) => e);
    expect(err.kind).toBe('blocked');
    expect(server.seen).toEqual([]);
  });

  test('the connector is registered, on the documented host, with the words it is shown in', () => {
    expect(connectorOf('lunchflow')).toBe(LUNCHFLOW);
    expect(LUNCHFLOW_API).toBe('https://lunchflow.app/api/v1');
    expect([LUNCHFLOW.label, LUNCHFLOW.providerDailyLimit, LUNCHFLOW.overlapDays]).toEqual(['Lunch Flow', null, 45]);
    expect(LUNCHFLOW.hostOf(server.key)).toBe(`bridge.test:${server.port}`);
    expect(LUNCHFLOW.hostOf('  ')).toBeNull();
    setLunchFlowApiForTests(null);
    expect(LUNCHFLOW.hostOf(server.key)).toBe('lunchflow.app');
  });
});

describe('reading accounts and balances', () => {
  test('balances only: the listing and each balance, its currency from the balance, no transactions asked for, no time given', async () => {
    seed();
    const answer = await fetchLunchFlow(server.key, { balancesOnly: true }, T);
    expect(server.requests('transactions')).toEqual([]);
    expect(server.requests('balance').map((r) => r.path).sort()).toEqual(['/api/v1/accounts/1470/balance', '/api/v1/accounts/1471/balance', '/api/v1/accounts/2001/balance']);
    expect(server.seen.every((r) => r.key === server.key)).toBe(true);
    expect(answer.accounts.map((a) => [a.remote_id, a.name, a.institution.name, a.currency, a.balance, a.balance_at, a.transactions.length])).toEqual([
      ['1470', 'Main Account A', 'Sandbox Finance', 'EUR', 1520.4, null, 0],
      ['1471', 'Credit Card', 'Sandbox Finance', 'EUR', -432.1, null, 0],
      ['2001', 'Savings', 'Second Bank', 'NZD', 10000, null, 0],
    ]);
    // One card per bank: the two accounts at Sandbox Finance share a key.
    expect(new Set(answer.accounts.map((a) => a.institution.key)).size).toBe(2);
    expect(answer.problems).toEqual([]);
    expect(answer.unreadable_accounts).toBe(0);
  });

  test('an account in a currency Nya doesn’t know is listed without one; one listed twice, or without an id, is counted', async () => {
    seed();
    server.accounts[2].balance = { amount: 5, currency: 'XXP' };
    const answer = await fetchLunchFlow(server.key, { balancesOnly: true }, T);
    expect(answer.accounts.find((a) => a.remote_id === '2001')).toMatchObject({ currency: null, currency_text: 'XXP' });
    expect(readAccountList({ accounts: [{ id: 1, name: 'A' }, { id: 1, name: 'B' }, { name: 'C' }, 'x'], total: 4 })).toMatchObject({ unreadable: 3 });
    expect(() => readAccountList({ items: [] })).toThrow('no list of accounts');
    expect(() => readAccountList({ accounts: Array.from({ length: 101 }, (_, i) => ({ id: i })) })).toThrow('more than 100');
  });

  test('a balance is read as a number or a numeric string, or the older current and available; anything else is no balance', () => {
    expect(readBalance({ balance: { amount: '10.00', currency: 'EUR' } })).toEqual({ balance: 10, available: null, currency_text: 'EUR' });
    expect(readBalance({ balance: { current: -5.5, available: 100, currency: 'GBP' } })).toEqual({ balance: -5.5, available: 100, currency_text: 'GBP' });
    for (const bad of [null, {}, { balance: null }, { balance: { amount: 'ten' } }, { balance: { amount: Infinity } }, { balance: 12 }]) expect(readBalance(bad)).toBeNull();
  });
});

describe('reading transactions', () => {
  test('asks for the tracked accounts only, from the window’s first day to its last, inclusive, and never for pending ones', async () => {
    seed();
    const start = daysAgo(30);
    const end = daysAgo(1);
    await fetchLunchFlow(server.key, { start, end, accounts: ['1470'] }, T);
    expect(server.requests('transactions').map((r) => [r.path, r.query])).toEqual([['/api/v1/accounts/1470/transactions', { from: start, to: daysAgo(2) }]]);
    // A window that runs to now has no end.
    server.seen.length = 0;
    await fetchLunchFlow(server.key, window(10), T);
    expect(server.requests('transactions').map((r) => r.query)).toEqual([{ from: daysAgo(10) }, { from: daysAgo(10) }]);
    expect(server.seen.some((r) => r.query.include_pending !== undefined)).toBe(false);
  });

  test('in Plaid’s sign, under Lunch Flow’s ids, named by the merchant, else the description', async () => {
    seed();
    server.accounts[0].transactions.push(lfTxn('t3', 1, '-4.20', '', { description: 'CARD PAYMENT 1234' }), lfTxn('t4', 1, -1, '', { merchant: null, description: '' }));
    const answer = await fetchLunchFlow(server.key, window(10), T);
    const main = answer.accounts.find((a) => a.remote_id === '1470')!;
    expect(main.transactions.map((t) => [t.source, t.source_id, t.amount, t.description, t.date, t.currency])).toEqual([
      ['lunchflow', 'c98ce8f4b11342ff0877b33d4a9d395d', 95.35, 'Freshto Ideal', daysAgo(3), 'EUR'],
      ['lunchflow', '5d823e7fa31f227822c3d3394841eaa5', -15, 'Jennifer Houston', daysAgo(4), 'EUR'],
      ['lunchflow', 't3', 4.2, 'CARD PAYMENT 1234', daysAgo(1), 'EUR'],
      ['lunchflow', 't4', 1, NO_DESCRIPTION, daysAgo(1), 'EUR'],
    ]);
    // A card's purchase is money out, positive in Plaid's sign.
    expect(answer.accounts.find((a) => a.remote_id === '1471')!.transactions.map((t) => t.amount)).toEqual([950]);
    // The untracked savings account is listed with its balance, without transactions asked for.
    expect(answer.accounts.find((a) => a.remote_id === '2001')!.transactions).toEqual([]);
  });

  test('pending ones that come all the same, and rows it can’t read, are left out and counted', () => {
    const json = {
      transactions: [
        { id: null, accountId: 1470, amount: -12, currency: 'EUR', date: daysAgo(1), merchant: 'HOLD', isPending: true },
        { id: 'p2', accountId: 1470, amount: -3, currency: 'EUR', date: daysAgo(1), merchant: 'Pending cafe', isPending: true },
        { id: null, accountId: 1470, amount: -7, currency: 'EUR', date: daysAgo(1), merchant: 'No id at all' },
        { id: null, accountId: 1470, amount: -7, currency: 'EUR', date: daysAgo(1), merchant: 'Says posted, has no id', isPending: false },
        { id: 'bad-date', accountId: 1470, amount: -1, currency: 'EUR', date: 'yesterday', merchant: 'X' },
        { id: 'bad-amount', accountId: 1470, amount: 'lots', currency: 'EUR', date: daysAgo(1), merchant: 'X' },
        { id: 'other-account', accountId: 9999, amount: -1, currency: 'EUR', date: daysAgo(1), merchant: 'X' },
        { id: 'odd-currency', accountId: 1470, amount: -1, currency: 'DOGE', date: daysAgo(1), merchant: 'X' },
        { id: 'with-time', accountId: 1470, amount: -2, currency: 'EUR', date: `${daysAgo(2)}T23:30:00.000Z`, merchant: 'Late' },
        { id: 'other-currency', accountId: 1470, amount: -2, currency: 'usd', date: daysAgo(2), merchant: 'Abroad' },
        // A transaction's id is only matched against: any text is kept whole,
        // and a number read as one; too long, or with a control character in
        // it, it can't be read, never cut.
        { id: 'tx/9+Q== a', accountId: 1470, amount: -4, currency: 'EUR', date: daysAgo(3), merchant: 'Odd id' },
        { id: 4242, accountId: 1470, amount: -5, currency: 'EUR', date: daysAgo(3), merchant: 'Number id' },
        { id: 'x'.repeat(201), accountId: 1470, amount: -6, currency: 'EUR', date: daysAgo(3), merchant: 'Long id' },
        { id: 'a\u0007b', accountId: 1470, amount: -6, currency: 'EUR', date: daysAgo(3), merchant: 'Bell id' },
        'not a row',
      ],
      total: 15,
    };
    const got = readTransactions(json, '1470', daysAgo(10), 'EUR')!;
    expect(got.left_out).toEqual({ pending: 3, unreadable: 8 });
    // A time after the day is cut off, never moved into a time zone; a row in
    // another currency keeps its own.
    expect(got.records.map((r) => [r.source_id, r.date, r.currency])).toEqual([
      ['with-time', daysAgo(2), 'EUR'],
      ['other-currency', daysAgo(2), 'USD'],
      ['tx/9+Q== a', daysAgo(3), 'EUR'],
      ['4242', daysAgo(3), 'EUR'],
    ]);
    // Its `total` isn't read, whatever it says.
    expect(got).toEqual({ records: got.records, left_out: got.left_out });
    expect(readTransactions({ items: [] }, '1470', daysAgo(1), 'EUR')).toBeNull();
  });

  test('a window Lunch Flow ignores costs a larger answer, never a wrong one; rows it sends late are kept, back to the history’s limit', async () => {
    seed();
    server.accounts[0].transactions.push(lfTxn('old', 800, -1, 'Older than the limit'), lfTxn('late', 100, -1, 'Posted late'), lfTxn('after', 1, -1, 'After the window'));
    server.ignoreWindow = true;
    const ids = async (request: Parameters<typeof fetchLunchFlow>[1]) =>
      (await fetchLunchFlow(server.key, request, T)).accounts.find((a) => a.remote_id === '1470')!.transactions.map((t) => t.source_id).sort();
    // Every row it holds back to `since`, matched by Lunch Flow's id, whatever
    // the window: nothing before the limit, and nothing ever counted twice.
    expect(await ids({ start: daysAgo(10), end: daysAgo(2), accounts: ['1470'], since: daysAgo(730) })).toEqual(['5d823e7fa31f227822c3d3394841eaa5', 'after', 'c98ce8f4b11342ff0877b33d4a9d395d', 'late']);
    // With no limit given, the window's first day is one.
    expect(await ids({ start: daysAgo(10), end: daysAgo(2), accounts: ['1470'] })).toEqual(['5d823e7fa31f227822c3d3394841eaa5', 'after', 'c98ce8f4b11342ff0877b33d4a9d395d']);
  });

  test('an answer whose total is more than it sent is taken as it came: `total` alone never holds a bank', async () => {
    seed();
    server.totalExtra = 2916;
    const answer = await fetchLunchFlow(server.key, window(10), T);
    expect(answer.problems).toEqual([]);
    expect(answer.accounts.find((a) => a.remote_id === '1470')!.transactions.length).toBe(2);
  });
});

describe('what Lunch Flow answers', () => {
  test('a refused key, a payment, a limit and a request it refuses stop the fetch, in words, with whose side', async () => {
    seed();
    for (const [status, kind, side] of [
      [401, 'refused', 'you'],
      [403, 'refused', 'you'],
      [402, 'payment', 'you'],
      [429, 'limited', 'nya'],
      [400, 'rejected', 'nya'],
      [500, 'down', 'connector'],
      [503, 'down', 'connector'],
    ] as const) {
      server.behaviours = [{ on: 'accounts', status, body: JSON.stringify({ error: 'X', message: `said ${status}` }) }];
      const err = await fetchLunchFlow(server.key, window(5), T).catch((e) => e);
      expect([status, err.name, err.kind, err.side, err.status, err.message.includes(`said ${status}`)]).toEqual([status, 'ConnectorFailure', kind, side, status, true]);
    }
    // The same from an account's own request: refused at once, whatever else came.
    server.behaviours = [{ on: 'balance', account: 1471, status: 403, body: JSON.stringify({ error: 'Forbidden', message: 'Invalid API key.' }) }];
    expect((await fetchLunchFlow(server.key, window(5), T).catch((e) => e)).kind).toBe('refused');
    server.behaviours = [{ on: 'transactions', status: 429, body: '{}' }];
    expect((await fetchLunchFlow(server.key, window(5), T).catch((e) => e)).kind).toBe('limited');
    expect(failureOfStatus(302, '').kind).toBe('answer');
  });

  test('one account’s trouble is a problem for that account alone; the rest come', async () => {
    seed();
    server.behaviours = [
      { on: 'balance', account: 1471, status: 503, body: JSON.stringify({ error: 'GCRateLimited', message: 'Bank data is temporarily unavailable. This usually resolves within a minute.' }) },
      { on: 'transactions', account: 1470, status: 500, body: JSON.stringify({ error: 'ProviderError', message: 'API request failed (429 - Rate limit exceeded). Please try again in 7 seconds.' }) },
    ];
    const answer = await fetchLunchFlow(server.key, { ...window(10), accounts: ['1470', '1471', '2001'] }, T);
    expect(answer.accounts.map((a) => a.remote_id)).toEqual(['1470', '2001']);
    // Each a request to ask again, never Lunch Flow's word about the bank.
    expect(answer.problems).toEqual([
      { message: 'Main Account A: no transactions came. API request failed (429 - Rate limit exceeded). Please try again in 7 seconds. (HTTP 500)', side: 'connector', accounts: ['1470'], kind: 'retry' },
      { message: 'Credit Card: no balance came. Bank data is temporarily unavailable. This usually resolves within a minute. (HTTP 503)', side: 'connector', accounts: ['1471'], kind: 'retry' },
    ]);
    // The card's transactions weren't asked for without its balance.
    expect(server.requests('transactions').map((r) => r.path).sort()).toEqual(['/api/v1/accounts/1470/transactions', '/api/v1/accounts/2001/transactions']);
    // When every tracked account had trouble, the fetch failed, as one
    // request would: its accounts are held as they were.
    const failed = await fetchLunchFlow(server.key, window(10), T).catch((e) => e);
    expect([failed.name, failed.kind]).toEqual(['ConnectorFailure', 'down']);
  });

  test('nothing came through for any account: the fetch failed, as one request would', async () => {
    seed();
    server.behaviours = [{ on: 'balance', status: 503, body: JSON.stringify({ message: 'Bank data is temporarily unavailable.' }) }];
    const err = await fetchLunchFlow(server.key, window(10), T).catch((e) => e);
    expect([err.kind, err.status, err.message]).toEqual(['down', 503, expect.stringContaining('Bank data is temporarily unavailable.')]);
  });

  test('an account is gone only when Lunch Flow says “Account not found” of it; another 404 is that account’s, asked again', async () => {
    seed();
    server.behaviours = [{ on: 'balance', account: 1471, status: 404, body: JSON.stringify({ error: 'Not Found', message: 'Account not found.' }) }];
    let answer = await fetchLunchFlow(server.key, window(10), T);
    expect(answer.accounts.map((a) => a.remote_id)).toEqual(['1470', '2001']);
    expect(answer.problems).toEqual([]);
    // An account with no balance yet (the fake's own 404 for one): a problem
    // for it, never taken for gone.
    server.behaviours = [];
    server.accounts[1].balance = null;
    answer = await fetchLunchFlow(server.key, window(10), T);
    expect(answer.problems).toEqual([{ message: 'Credit Card: no balance came. Balance not found. (HTTP 404)', side: 'connector', accounts: ['1471'], kind: 'retry' }]);
    // Asked to list them to choose from, it isn't offered yet, and the
    // connection's card says why (naming no account, it holds none).
    answer = await fetchLunchFlow(server.key, { balancesOnly: true }, T);
    expect(answer.accounts.map((a) => a.remote_id)).toEqual(['1470', '2001']);
    expect(answer.problems).toEqual([{ message: 'Credit Card: no balance came. Balance not found. (HTTP 404)', side: 'connector', accounts: null, kind: 'retry' }]);
  });

  test('a link that broke at Lunch Flow is a problem for its bank, said once, from the accounts’ status: only for banks it is asked about', async () => {
    seed();
    server.accounts[0].status = 'DISCONNECTED';
    server.accounts[1].status = 'DISCONNECTED';
    server.accounts[2].status = 'ERROR';
    const all = await fetchLunchFlow(server.key, { ...window(10), accounts: ['1470', '1471', '2001'] }, T);
    expect(all.problems).toEqual([
      { message: 'The connection to Sandbox Finance is disconnected', side: 'connector', accounts: ['1470', '1471'] },
      { message: 'The connection to Second Bank has an error', side: 'connector', accounts: ['2001'] },
    ]);
    // An account nobody tracks says nothing about a bank nobody tracks.
    expect((await fetchLunchFlow(server.key, window(10), T)).problems).toEqual([{ message: 'The connection to Sandbox Finance is disconnected', side: 'connector', accounts: ['1470', '1471'] }]);
    // A status Nya doesn't know says nothing.
    server.accounts.forEach((a) => (a.status = 'SYNCING'));
    expect((await fetchLunchFlow(server.key, window(10), T)).problems).toEqual([]);
  });

  test('accounts Nya offers already are only listed, never asked about; new ones are asked their balances after the tracked ones', async () => {
    seed();
    server.accounts.push(lfAccount({ id: 3001, name: 'New Pot', institution_name: 'Second Bank', provider: 'akahu', balance: { amount: 5, currency: 'NZD' } }));
    const answer = await fetchLunchFlow(server.key, { ...window(10), offered: ['2001'] }, T);
    // The listing; the tracked accounts, each its balance then its
    // transactions (the two at once, so in either order); then the new one.
    const paths = server.seen.map((r) => r.path);
    expect(paths[0]).toBe('/api/v1/accounts');
    expect(paths.slice(1, 5).sort()).toEqual(['/api/v1/accounts/1470/balance', '/api/v1/accounts/1470/transactions', '/api/v1/accounts/1471/balance', '/api/v1/accounts/1471/transactions']);
    for (const id of ['1470', '1471']) expect(paths.indexOf(`/api/v1/accounts/${id}/balance`)).toBeLessThan(paths.indexOf(`/api/v1/accounts/${id}/transactions`));
    expect(paths.slice(5)).toEqual(['/api/v1/accounts/3001/balance']);
    expect(answer.accounts.map((a) => a.remote_id)).toEqual(['1470', '1471', '3001']);
    expect(answer.listed).toEqual([{ remote_id: '2001', name: 'Savings', institution: { name: 'Second Bank', key: 'name:akahu:second bank', domain: null } }]);
  });

  test('at most four requests at once, the tracked accounts first; past the fetch’s time the rest are Nya’s, asked again', async () => {
    seed();
    server.accounts = Array.from({ length: 10 }, (_, i) => lfAccount({ id: 5000 + i, name: `Pot ${i}`, transactions: [lfTxn(`t${i}`, 1, -1, 'Shop')] }));
    server.slowMs = 200;
    const tracked = server.accounts.slice(0, 6).map((a) => String(a.id));
    const answer = await fetchLunchFlow(server.key, { start: daysAgo(10), end: null, accounts: tracked }, T);
    expect(server.maxInFlight).toBe(4);
    expect(answer.problems).toEqual([]);
    // Not one balance of an untracked account was asked before every tracked
    // account's had been.
    const asked = server.requests('balance').map((r) => r.path.split('/')[4]);
    expect(asked.slice(0, 6).sort()).toEqual([...tracked].sort());
    // A fetch whose time runs out: what wasn't asked yet is a problem on
    // Nya's side, to ask again, and what came is kept.
    server.reset();
    server.accounts = Array.from({ length: 10 }, (_, i) => lfAccount({ id: 5000 + i, name: `Pot ${i}` }));
    server.slowMs = 500;
    const short = await fetchLunchFlow(server.key, { start: daysAgo(10), end: null, accounts: server.accounts.map((a) => String(a.id)) }, { timeoutMs: 3_000 });
    const late = short.problems.filter((p) => p.side === 'nya');
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((p) => p.kind === 'retry' && p.message.endsWith('Nya’s time for this update ran out before it asked Lunch Flow.'))).toBe(true);
    expect(short.accounts.length).toBeGreaterThan(0);
  });

  test('past twenty problems, the rest are one that names no account, so a cut list never reads as whole', async () => {
    server.accounts = Array.from({ length: 25 }, (_, i) => lfAccount({ id: 6000 + i, name: `Pot ${i}` }));
    // One account comes whole; the other 24 bring no transactions.
    server.behaviours = [
      { on: 'transactions', account: 6024, status: 200, body: JSON.stringify({ transactions: [], total: 0 }) },
      { on: 'transactions', status: 503, body: JSON.stringify({ message: 'Bank data is temporarily unavailable.' }) },
    ];
    const answer = await fetchLunchFlow(server.key, { start: daysAgo(10), end: null, accounts: server.accounts.map((a) => String(a.id)) }, T);
    expect(answer.problems.length).toBe(20);
    expect(answer.problems.slice(0, 19).every((p) => p.accounts?.length === 1)).toBe(true);
    expect(answer.problems[19]).toEqual({ message: '5 more problems with other accounts, which Nya doesn’t keep', side: 'connector', accounts: null, kind: 'retry' });
  });

  test('an answer that isn’t one, or is too large, or comes too slowly, is said so', async () => {
    seed();
    server.behaviours = [{ on: 'accounts', status: 200, body: '<html>maintenance</html>' }];
    expect((await fetchLunchFlow(server.key, window(5), T).catch((e) => e)).kind).toBe('answer');
    server.behaviours = [{ on: 'accounts', status: 200, body: JSON.stringify({ accounts: 'none' }) }];
    expect((await fetchLunchFlow(server.key, window(5), T).catch((e) => e)).kind).toBe('answer');
    server.behaviours = [{ on: 'balance', account: 1470, status: 200, body: 'x'.repeat(6 * 1024 * 1024) }];
    const big = await fetchLunchFlow(server.key, window(5), T);
    expect(big.problems[0]).toMatchObject({ message: expect.stringContaining('larger than Nya reads'), accounts: ['1470'] });
    server.behaviours = [{ on: 'accounts', delayMs: 3_000 }];
    const slow = await fetchLunchFlow(server.key, window(5), { timeoutMs: 1_500 }).catch((e) => e);
    expect([slow.kind, slow.message]).toEqual(['down', 'Lunch Flow didn’t answer in time.']);
  });
});

describe('the key goes to Lunch Flow only', () => {
  test('a redirect to the same site’s other name is followed with it; one anywhere else is refused, the key unsent', async () => {
    seed();
    server.behaviours = [{ on: 'accounts', status: 308, location: `https://www.bridge.test:${server.port}/api/v1/accounts`, times: 1 }];
    const answer = await fetchLunchFlow(server.key, { balancesOnly: true }, T);
    expect(answer.accounts.length).toBe(3);
    expect(server.seen.slice(0, 2).map((r) => [r.host, r.key])).toEqual([
      [`bridge.test:${server.port}`, server.key],
      [`www.bridge.test:${server.port}`, server.key],
    ]);
    server.seen.length = 0;
    server.names.set('collector.example', ['93.184.216.34']);
    server.behaviours = [{ on: 'accounts', status: 302, location: 'https://collector.example/steal' }];
    const err = await fetchLunchFlow(server.key, { balancesOnly: true }, T).catch((e) => e);
    expect(err.kind).toBe('blocked');
    expect(server.seen.length).toBe(1);
  });

  test('nothing Lunch Flow echoes carries the key into an error or a problem', async () => {
    seed();
    const echo = JSON.stringify({ error: 'Forbidden', message: `key ${server.key} is not valid` });
    server.behaviours = [{ on: 'accounts', status: 403, body: echo }];
    const refused = await fetchLunchFlow(server.key, window(5), T).catch((e) => e);
    expect(refused.message).not.toContain(server.key);
    expect(refused.message).toContain('key … is not valid');
    server.behaviours = [{ on: 'balance', account: 1470, status: 500, body: echo }];
    const answer = await fetchLunchFlow(server.key, window(5), T);
    expect(JSON.stringify(answer)).not.toContain(server.key);
    const check = await checkWithLunchFlow(server.key, T).then(() => null, (e) => e);
    expect(check).toBeNull();
  });

  test('a key header this module sets itself, or one that would split a header, is never sent', async () => {
    for (const key of [
      { header: 'Authorization', value: 'x' },
      { header: 'Host', value: 'x' },
      { header: 'x api key', value: 'x' },
      { header: 'x-api-key', value: 'a\r\nInjected: 1' },
    ]) {
      const err = await guardedRequest({ method: 'GET', url: new URL(`${server.base()}/accounts`), key, accept: 'application/json', timeoutMs: 2_000, maxBytes: 1024 }).catch((e) => e);
      expect(err).toBeInstanceOf(UnsafeUrlError);
    }
    expect(server.seen).toEqual([]);
  });
});
