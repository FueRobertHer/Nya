import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount, type FakeTxn } from './simplefin-fake';
import { parseCsv } from './csv-parse';

// The read-only API and the MCP server (lib/api-read.ts, lib/mcp.ts) with the
// accounts a SimpleFIN connection keeps up to date: served with source
// 'simplefin', and their rows too; a card SimpleFIN reports as money held has
// no balance to count until the person answers, so net worth says it is
// short; an account kept as a manual one in its own currency keeps it, over
// REST and MCP alike; and an entry that can't be read is named, in the API
// and in the download, while the rest is answered.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { setTransportForTests } = await import('@/lib/connectors/http');
const { connect, trackAccounts, confirmSigns, disconnect } = await import('@/lib/connectors/manage');
const { connectorAccountsStore } = await import('@/lib/connectors/store');
const { createToken } = await import('@/lib/api-tokens');
const { forgetEpochs } = await import('@/lib/sessions');
const { collectUserData, buildUserExport, exportFile, TRANSACTION_COLUMNS } = await import('@/lib/user-export');
const mcp = await import('@/app/api/mcp/route');
const recategorizeRoute = await import('@/app/api/recategorize/route');

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

let token = '';
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  server.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  setTransportForTests(server.transport());
  token = (await createToken(ctx, 'Tests')).token;
});
afterEach(() => {
  process.env = { ...saved };
});

/** One REST endpoint, as a client calls it. */
async function rest(name: string, query = ''): Promise<{ status: number; body: any }> {
  const route = await import(`@/app/api/v1/${name}/route`);
  const res: Response = await route.GET(new Request(`https://nya.test/api/v1/${name}?${query}`, { headers: { authorization: `Bearer ${token}` } }));
  return { status: res.status, body: await res.json() };
}

let nextId = 1;
/** One MCP tool, as an assistant calls it: its sentence and its data. */
async function tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; data: any }> {
  const res: Response = await mcp.POST(
    new Request('https://nya.test/api/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
    })
  );
  const result = (await res.json()).result;
  expect(result.isError).not.toBe(true);
  return { text: result.content[0].text, data: result.structuredContent };
}

/** A SimpleFIN connection tracking a checking account and a card (reported
 *  at `card`), each with a row. */
async function trackSimplefin(card = '-432.10', currency = 'USD'): Promise<string> {
  server.accounts = [
    fakeAccount({ id: 'CHK', name: 'Checking', currency, balance: '1500.25', 'balance-date': ago(1), transactions: [txn('c1', 3, '-12.50', 'COFFEE')] }),
    fakeAccount({ id: 'CARD', name: 'Visa', balance: card, 'balance-date': ago(1), transactions: [txn('v1', 2, '-45.67', 'DINER')] }),
  ];
  const { connection_id } = await connect(ctx, 'simplefin', server.setupToken(`t${Math.random()}`));
  await trackAccounts(ctx, connection_id, [
    { remote_id: 'CHK', type: 'depository' },
    { remote_id: 'CARD', type: 'credit' },
  ]);
  return connection_id;
}

const idOf = async (name: string) => [...(await connectorAccountsStore.getAll(ctx)).values()].find((a) => a.name === name)!.account_id;

describe('accounts and rows SimpleFIN keeps up to date', () => {
  test('come back with source simplefin, their balance as of the bank’s day, over REST and MCP', async () => {
    await trackSimplefin();
    const { status, body } = await rest('accounts');
    expect(status).toBe(200);
    expect(body.complete).toBe(true);
    expect(body.accounts.map((a: any) => [a.source, a.institution, a.name, a.type, a.balance, a.currency, a.is_debt, a.as_of])).toEqual([
      ['simplefin', 'My Bank', 'Checking', 'depository', 1500.25, 'USD', false, dayOf(NOW - DAY)],
      ['simplefin', 'My Bank', 'Visa', 'credit', 432.1, 'USD', true, dayOf(NOW - DAY)],
    ]);
    // Its bank's link, as Connection health shows it: working.
    expect(body.accounts[0].connection).toMatchObject({ problem: null, ends_at: null });
    expect(body.accounts[0].connection.last_ok_at).toBeTruthy();
    // Net worth counts them.
    const worth = (await rest('net-worth')).body;
    expect([worth.complete, worth.totals]).toEqual([true, [{ currency: 'USD', net_worth: 1068.15, assets: 1500.25, debts: 432.1, accounts: 2 }]]);

    // Their rows, with their source; each bank among the sources, its older
    // history still coming in a window a night.
    const rows = (await rest('transactions', `from=${dayOf(NOW - 30 * DAY)}`)).body;
    expect(rows.transactions.map((t: any) => [t.name, t.source, t.institution, t.account_name])).toEqual([
      ['DINER', 'simplefin', 'My Bank', 'Visa'],
      ['COFFEE', 'simplefin', 'My Bank', 'Checking'],
    ]);
    expect(rows.sources).toEqual([{ institution: 'My Bank', synced_at: expect.any(String), complete: false, no_transactions: null }]);
    expect(rows.notes).toContain('My Bank: older transactions are still arriving from SimpleFIN, a few months each night');

    // The MCP tools read the same layer.
    const listed = await tool('list_accounts');
    expect(listed.data.accounts.map((a: any) => [a.source, a.name, a.balance])).toEqual([
      ['simplefin', 'Checking', 1500.25],
      ['simplefin', 'Visa', 432.1],
    ]);
    const found = await tool('search_transactions', { from: dayOf(NOW - 30 * DAY) });
    expect(found.data.transactions.map((t: any) => t.source)).toEqual(['simplefin', 'simplefin']);
    // One with no holdings is said to be one SimpleFIN feeds, never unknown.
    const holdings = await rest('holdings', `account_id=${await idOf('Checking')}`);
    expect([holdings.status, holdings.body.error.message]).toEqual([404, expect.stringContaining('kept up to date through SimpleFIN')]);
  });

  test('a card SimpleFIN reports as money held has no balance to count until answered: net worth says it is short', async () => {
    await trackSimplefin('432.10');
    const accounts = (await rest('accounts')).body;
    const visa = accounts.accounts.find((a: any) => a.name === 'Visa');
    expect([visa.source, visa.balance]).toEqual(['simplefin', null]);
    // Its bank's link says what is wrong, and the notes in words.
    expect(visa.connection.problem).toMatchObject({ state: 'partial', since: expect.any(String) });
    expect(accounts.notes.some((n: string) => n.startsWith('My Bank, through SimpleFIN: SimpleFIN reports Visa (+$432.10) as money held.'))).toBe(true);
    const worth = (await rest('net-worth')).body;
    expect(worth).toMatchObject({ complete: false, accounts_without_balance: 1, totals: [{ currency: 'USD', net_worth: 1500.25, accounts: 1 }] });
    expect((await tool('get_net_worth', { include_history: false })).text).toContain('1 account has no balance to count');

    // Answered: counted, and whole again.
    await confirmSigns(ctx, [{ account_id: await idOf('Visa'), sign: 'owed_positive' }]);
    const after = (await rest('net-worth')).body;
    expect(after).toMatchObject({ complete: true, accounts_without_balance: 0, totals: [{ currency: 'USD', net_worth: 1068.15, accounts: 2 }] });
  });
});

describe('an account kept as a manual one in its own currency', () => {
  test('keeps it over REST and MCP: its balance, net worth’s total for it, and its history', async () => {
    const id = await trackSimplefin('-432.10', 'AUD');
    const everyday = await idOf('Checking');
    expect((await disconnect(ctx, id, true)).kept).toHaveLength(2);
    const accounts = (await rest('accounts')).body;
    expect(accounts.accounts.map((a: any) => [a.source, a.name, a.balance, a.currency])).toEqual([
      ['manual', 'Checking', 1500.25, 'AUD'],
      ['manual', 'Visa', 432.1, 'USD'],
    ]);
    // One total per currency: nothing converted.
    const worth = (await rest('net-worth')).body;
    expect(worth.totals.map((t: any) => [t.currency, t.net_worth])).toEqual([
      ['AUD', 1500.25],
      ['USD', -432.1],
    ]);
    // Its history is in its own currency.
    expect((await rest('balance-history', `account_id=${everyday}`)).body.currency).toBe('AUD');
    // Its rows are still the ones SimpleFIN brought in.
    expect((await rest('transactions', `from=${dayOf(NOW - 30 * DAY)}`)).body.transactions.map((t: any) => [t.name, t.source, t.currency])).toEqual([
      ['DINER', 'simplefin', 'USD'],
      ['COFFEE', 'simplefin', 'AUD'],
    ]);
    // MCP alike.
    expect((await tool('list_accounts')).data.accounts.find((a: any) => a.id === everyday).currency).toBe('AUD');
    expect((await tool('get_balance_history', { account_id: everyday })).data.currency).toBe('AUD');
  });
});

describe('the download’s transactions.csv', () => {
  test('holds SimpleFIN’s rows as stored, with their account and bank and their source', async () => {
    server.accounts = [
      fakeAccount({ id: 'CHK', name: 'Checking', balance: '1500.25', 'balance-date': ago(1), transactions: [txn('c1', 3, '-12.50', 'COFFEE'), txn('p1', 5, '-300.00', 'PAYMENT TO VISA')] }),
      fakeAccount({ id: 'CARD', name: 'Visa', balance: '-432.10', 'balance-date': ago(1), transactions: [txn('p2', 4, '300.00', 'PAYMENT THANK YOU')] }),
    ];
    const { connection_id } = await connect(ctx, 'simplefin', server.setupToken('csv'));
    await trackAccounts(ctx, connection_id, [
      { remote_id: 'CHK', type: 'depository' },
      { remote_id: 'CARD', type: 'credit' },
    ]);
    const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
    const [header, ...rows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
    expect(header).toEqual([...TRANSACTION_COLUMNS]);
    const col = (r: string[], name: (typeof TRANSACTION_COLUMNS)[number]) => r[TRANSACTION_COLUMNS.indexOf(name)];
    expect(rows.map((r) => [col(r, 'name'), col(r, 'account_name'), col(r, 'institution_name'), col(r, 'source'), col(r, 'amount')]).sort()).toEqual([
      ['COFFEE', 'Checking', 'My Bank', 'simplefin', '12.5'],
      ['PAYMENT THANK YOU', 'Visa', 'My Bank', 'simplefin', '-300'],
      ['PAYMENT TO VISA', 'Checking', 'My Bank', 'simplefin', '300'],
    ]);
  });

  test('files a pair between two SimpleFIN accounts as the app does: each side in the pair’s words, under Transfers, though nothing is stored', async () => {
    server.accounts = [
      fakeAccount({
        id: 'CHK',
        name: 'Checking',
        balance: '5000.00',
        'balance-date': ago(1),
        transactions: [txn('coffee', 2, '-12.50', 'COFFEE'), txn('pay', 3, '-300.00', 'PAYMENT TO VISA'), txn('mtg', 5, '-2000.00', 'MORTGAGE PMT'), txn('sav', 6, '-500.00', 'TO SAVINGS')],
      }),
      fakeAccount({ id: 'CARD', name: 'Visa', balance: '-300.00', 'balance-date': ago(1), transactions: [txn('thanks', 2, '300.00', 'PAYMENT THANK YOU'), txn('dinner', 2, '-45.67', 'DINER')] }),
      fakeAccount({ id: 'MTG', name: 'Home Loan', balance: '-250000.00', 'balance-date': ago(1), transactions: [txn('mtgin', 4, '2000.00', 'PAYMENT RECEIVED')] }),
      fakeAccount({ id: 'SAV', name: 'Savings', balance: '1500.00', 'balance-date': ago(1), transactions: [txn('savin', 6, '500.00', 'FROM CHECKING')] }),
    ];
    const { connection_id } = await connect(ctx, 'simplefin', server.setupToken('pairs'));
    await trackAccounts(ctx, connection_id, [
      { remote_id: 'CHK', type: 'depository' },
      { remote_id: 'CARD', type: 'credit' },
      { remote_id: 'MTG', type: 'loan' },
      { remote_id: 'SAV', type: 'depository' },
    ]);
    /** By name: the file's category, and where it files the row (its name, id and group). */
    const fromFile = async () => {
      const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
      const [, ...rows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
      const col = (r: string[], name: (typeof TRANSACTION_COLUMNS)[number]) => r[TRANSACTION_COLUMNS.indexOf(name)];
      const filed = Object.fromEntries(rows.map((r) => [col(r, 'name'), [col(r, 'category'), col(r, 'nya_category'), col(r, 'nya_category_id'), col(r, 'nya_group')]]));
      return { doc, filed };
    };
    /** By name, where the API files each row (as the app does). */
    const fromApi = async () =>
      Object.fromEntries(((await rest('transactions')).body.transactions as any[]).map((t) => [t.name, [t.category ?? '', t.category_id ?? '', t.group ?? '']]));

    const { doc, filed } = await fromFile();
    const words = Object.fromEntries(Object.entries(filed).map(([name, [category, nya, , group]]) => [name, [category, nya, group]]));
    expect(words).toEqual({
      COFFEE: ['', '', 'Other'],
      DINER: ['', '', 'Other'],
      'PAYMENT TO VISA': ['loan payments', 'loan payments', 'Transfers'],
      'PAYMENT THANK YOU': ['loan payments', 'loan payments', 'Transfers'],
      'MORTGAGE PMT': ['loan payments', 'loan payments', 'Transfers'],
      'PAYMENT RECEIVED': ['loan payments', 'loan payments', 'Transfers'],
      'TO SAVINGS': ['transfer out', 'transfer out', 'Transfers'],
      'FROM CHECKING': ['transfer in', 'transfer in', 'Transfers'],
    });
    // Filed exactly as the API files them.
    const api = await fromApi();
    expect(Object.fromEntries(Object.entries(filed).map(([name, [, ...nya]]) => [name, nya]))).toEqual(api);
    // Worked out, never stored: the JSON file holds the rows as SimpleFIN gave them.
    const stored = (doc['manual-transactions'] as { value: { rows: { name: string; category: string | null }[] } }[]).flatMap((e) => e.value.rows);
    expect(stored.filter((r) => r.category !== null)).toEqual([]);

    // A category of the person's on one side wins and undoes the pair, there as in the app.
    const visa = ((await rest('transactions')).body.transactions as any[]).find((t) => t.name === 'PAYMENT TO VISA');
    const res = await recategorizeRoute.POST(
      new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id: visa.id, category: 'shopping', account_id: visa.account_id }) })
    );
    expect(res.status).toBe(200);
    const after = (await fromFile()).filed;
    expect([after['PAYMENT TO VISA'][0], after['PAYMENT THANK YOU'][0], after['PAYMENT THANK YOU'][3]]).toEqual(['shopping', '', 'Other']);
    expect(Object.fromEntries(Object.entries(after).map(([name, [, ...nya]]) => [name, nya]))).toEqual(await fromApi());
  });
});

describe('an entry that can’t be read', () => {
  test('is named under missing_accounts, and under problems in the download, while the rest is answered', async () => {
    await trackSimplefin();
    const [visa, checking] = [await idOf('Visa'), await idOf('Checking')];
    await fake.hset(ctxKey('connector-accounts'), { [visa]: 'damaged' });

    const accounts = (await rest('accounts')).body;
    expect(accounts.accounts.map((a: any) => a.name)).toEqual(['Checking']);
    expect(accounts).toMatchObject({ complete: false, missing_accounts: [{ institution: null, account_id: visa, reason: 'unreadable', source: 'simplefin' }] });
    expect(accounts.notes).toContain('An account SimpleFIN keeps up to date couldn’t be read, so it isn’t listed');
    expect((await rest('net-worth')).body).toMatchObject({ complete: false, totals: [{ currency: 'USD', net_worth: 1500.25, accounts: 1 }] });
    expect((await tool('list_accounts')).text).toContain('1 SimpleFIN account couldn’t be read');

    // The download: everything else, and the damaged entry named.
    const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
    expect(doc.problems).toContainEqual({ section: 'connector-accounts', problem: 'unreadable', ids: [visa] });
    expect(doc.accounts.map((a) => a.name)).toEqual(['Checking']);
    expect((doc['connector-accounts'] as any[]).map((e) => e.id)).toEqual([checking]);
    expect((doc['manual-transactions'] as any[]).flatMap((b) => b.value.rows).map((r: any) => r.name).sort()).toEqual(['COFFEE', 'DINER']);
    // The transactions CSV, which names its rows and works out their pairs by
    // these accounts, says what it lacks.
    const csv = exportFile(doc, 'transactions-csv');
    expect(csv.incomplete).toEqual(['connector-accounts']);
    expect(csv.notes).toContain(
      'Not all of your accounts from SimpleFIN or Lunch Flow could be read: 1 entry whose stored data is damaged. Their rows in this file are under their account ids, with no account name, and a payment between one of them and another of your accounts is listed as it came, with no category. The JSON download lists them under problems. Nothing was changed: what could not be read is still stored as it was.'
    );
    expect(exportFile(doc, 'balances-csv').incomplete).toEqual([]);
  });
});
