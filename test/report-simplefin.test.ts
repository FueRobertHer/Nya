import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount, type FakeTxn } from './simplefin-fake';

// Reports (lib/report/) with the accounts a SimpleFIN connection keeps up to
// date: their rows count in a report's totals exactly as on the Activity tab
// (a card payment worked out between two of them left out, an unrelated charge
// and deposit counted; in the person's categories, the same by group, after a
// rename, and after loan payments move to a spending group, when the pair
// counts in both), and the report's list of where its data comes from
// names each bank the connection reaches, with its last clean sync, and what
// may be missing: older history still arriving, a bank SimpleFIN has only an
// old balance from or a request that failed (hasn't synced since), and
// accounts let go during the period, removed or kept by hand. A card waiting
// for the person's answer about its sign holds its balance, never its
// transactions: said, and never a gap.

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
const { connect, trackAccounts, disconnect } = await import('@/lib/connectors/manage');
const { connectionsStore, connectorAccountsStore, endedAccountsStore } = await import('@/lib/connectors/store');
const { forgetEpochs } = await import('@/lib/sessions');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const { gapSentences, statusLines } = await import('@/lib/report/words');
const { reportCsv } = await import('@/lib/report/csv');
const { ReportView } = await import('@/components/ReportView');
const { formatMoney } = await import('@/lib/format');
const { default: MonthBreakdown } = await import('@/components/MonthBreakdown');
const transactions = await import('@/app/api/transactions/route');
const endedRoute = await import('@/app/api/connectors/ended/route');
const recategorizeRoute = await import('@/app/api/recategorize/route');
const categoriesRoute = await import('@/app/api/categories/route');
const { collectUserData, buildUserExport } = await import('@/lib/user-export');
const { encrypt } = await import('@/lib/crypto');
const { StoppedAccountsView, asksStopped } = await import('@/components/ReportsPage');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const NOW = Date.now();
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const TODAY = dayOf(NOW);
const ago = (n: number) => Math.floor(Date.parse(`${dayOf(NOW - n * DAY)}T12:00:00Z`) / 1000);
const txn = (id: string, posted: number, amount: string, description: string): FakeTxn => ({ id, posted, amount, description });

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
});

/** A report on the days from `start` to `end`, in UTC, made now. */
async function report(start: string, end: string = TODAY) {
  const period = resolvePeriod({ kind: 'range', start, end }, 'UTC', NOW);
  if ('error' in period) throw new Error(period.error);
  return readReport(ctx, period, { now: NOW });
}

/** Tracks a checking account and a card (reported at `card`) with these rows. */
async function trackOn(rows: { checking?: FakeTxn[]; card?: FakeTxn[] } = {}, card = '-432.10'): Promise<string> {
  server.accounts = [
    fakeAccount({ id: 'CHK', name: 'Checking', balance: '1500.25', 'balance-date': ago(1), transactions: rows.checking ?? [] }),
    fakeAccount({ id: 'CARD', name: 'Visa', balance: card, 'balance-date': ago(1), transactions: rows.card ?? [] }),
  ];
  const { connection_id } = await connect(ctx, 'simplefin', server.setupToken(`t${Math.random()}`), NOW);
  await trackAccounts(
    ctx,
    connection_id,
    [
      { remote_id: 'CHK', type: 'depository' },
      { remote_id: 'CARD', type: 'credit' },
    ],
    NOW
  );
  return connection_id;
}

const day = (d: string) => d;

describe('SimpleFIN rows in a report’s totals', () => {
  test('count exactly as on the Activity tab: a card payment between them left out, an unrelated charge and deposit counted', async () => {
    // Last month, whole, whatever today is.
    const now = new Date(NOW);
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const on = (d: number) => Math.floor(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), d, 12) / 1000);
    const start = first.toISOString().slice(0, 10);
    const end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    await trackOn({
      checking: [
        txn('c1', on(3), '-12.50', 'COFFEE'),
        txn('c2', on(5), '2500.00', 'PAYROLL'),
        txn('c3', on(10), '-300.00', 'PAYMENT TO VISA'),
        txn('c4', on(17), '120.00', 'ZELLE FROM ALEX'),
      ],
      card: [txn('v1', on(4), '-45.67', 'DINER'), txn('v2', on(11), '300.00', 'PAYMENT THANK YOU'), txn('v3', on(15), '-120.00', 'RESTAURANT')],
    });
    // The Activity tab's rows, from the app's own route, for that month.
    const rows = (await (await transactions.GET(new Request('http://localhost/api/transactions'))).json()).transactions.filter(
      (t: any) => t.date >= start && t.date <= end
    );
    expect(rows).toHaveLength(7);
    const html = renderToStaticMarkup(createElement(MonthBreakdown, { txns: rows, notes: [], loading: false, onRecategorize: () => {}, onRename: () => {} }));
    const figure = (label: string) => new RegExp(`total-label">${label}</div><div class="summary-value[^"]*">([^<]*)<`).exec(html)?.[1];

    const r = await report(start, end);
    const money = (n: number) => formatMoney(n, r.currency);
    expect([figure('In'), figure('Out'), figure('Net')]).toEqual([money(r.totals.money_in), money(r.totals.money_out), money(r.totals.net)]);
    // Pay and the unrelated deposit in; coffee, the dinner and the restaurant out; the card's payment neither.
    expect([r.totals.money_in, r.totals.money_out]).toEqual([2620, 178.17]);
    expect([r.totals.transactions, r.totals.counted, r.totals.transfers]).toEqual([7, 5, 2]);
  });

  test('in the person’s categories, as on the Activity tab: a category chosen for one, renamed since, and the pair filed under transfers', async () => {
    const now = new Date(NOW);
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const on = (d: number) => Math.floor(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), d, 12) / 1000);
    const start = first.toISOString().slice(0, 10);
    const end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    await trackOn({
      checking: [txn('c1', on(3), '-12.50', 'COFFEE'), txn('c2', on(5), '2500.00', 'PAYROLL'), txn('c3', on(10), '-300.00', 'PAYMENT TO VISA'), txn('c5', on(12), '-80.00', 'GROCER')],
      card: [txn('v1', on(4), '-45.67', 'DINER'), txn('v2', on(11), '300.00', 'PAYMENT THANK YOU')],
    });
    const read = async () => (await (await transactions.GET(new Request('http://localhost/api/transactions'))).json()) as { transactions: any[]; categories: any };
    let a = await read();
    // The coffee and the groceries put in food and drink, through the picker.
    const food = a.categories.categories.find((c: any) => c.name === 'food and drink');
    for (const name of ['COFFEE', 'GROCER']) {
      const t = a.transactions.find((x: any) => x.name === name);
      const res = await recategorizeRoute.POST(
        new Request('http://localhost/api/recategorize', { method: 'POST', body: JSON.stringify({ transaction_id: t.transaction_id, category_id: food.id, account_id: t.account_id }) })
      );
      expect(res.status).toBe(200);
    }
    // Renamed since: both show the name it has now.
    await categoriesRoute.POST(new Request('http://localhost/api/categories', { method: 'POST', body: JSON.stringify({ action: 'rename-category', id: food.id, name: 'Eating' }) }));
    a = await read();
    // The month's In, Out and Net on the tab, and its top spending: with
    // categories loaded, by group, each one's name and total in the toggle
    // that opens it.
    const tab = () => {
      const rows = a.transactions.filter((t: any) => t.date >= start && t.date <= end);
      const html = renderToStaticMarkup(
        createElement(MonthBreakdown, { txns: rows, notes: [], loading: false, taxonomy: a.categories, onRecategorize: () => {}, onRename: () => {} })
      );
      const figure = (label: string) => new RegExp(`total-label">${label}</div><div class="summary-value[^"]*">([^<]*)<`).exec(html)?.[1];
      const top = html.slice(html.indexOf('Top spending'));
      return {
        figures: [figure('In'), figure('Out'), figure('Net')],
        groups: [...top.matchAll(/aria-label="([^"]*?): ([^"]*?)\. Show its categories"/g)].map((m) => [m[1], m[2]]),
      };
    };
    const { figures, groups: tabGroups } = tab();

    let r = await report(start, end);
    const money = (n: number) => formatMoney(n, r.currency);
    expect(figures).toEqual([money(r.totals.money_in), money(r.totals.money_out), money(r.totals.net)]);
    // Eating, then the dinner nobody categorized; the card's payment in neither.
    expect(r.money_out.map((c) => [c.category, c.amount, c.transactions])).toEqual([
      ['Eating', 92.5, 2],
      ['other', 45.67, 1],
    ]);
    // The report's categories, summed by the group each is in now, are the tab's groups.
    const groupOf = (name: string) => {
      const c = a.categories.categories.find((x: any) => x.name === name);
      return a.categories.groups.find((g: any) => g.id === c.group).name as string;
    };
    const byGroup = new Map<string, number>();
    for (const c of r.money_out) byGroup.set(groupOf(c.category), (byGroup.get(groupOf(c.category)) ?? 0) + c.amount);
    expect(tabGroups).toEqual([...byGroup].sort((x, y) => y[1] - x[1]).map(([g, n]) => [g, money(n)]));
    expect(tabGroups.map(([g]) => g)).toEqual(['Food', 'Other']);
    expect(r.categories.map((c) => c.name)).toContain('Eating');
    expect(r.totals.transfers).toBe(2);

    // Loan payments moved to a spending group: the card's payment, both
    // sides, counts in the report as on the tab, as a bank's rows there would.
    const loans = a.categories.categories.find((c: any) => c.name === 'loan payments');
    const housing = a.categories.groups.find((g: any) => g.name === 'Housing');
    await categoriesRoute.POST(new Request('http://localhost/api/categories', { method: 'POST', body: JSON.stringify({ action: 'move-category', id: loans.id, group: housing.id }) }));
    a = await read();
    r = await report(start, end);
    expect(tab().figures).toEqual([money(r.totals.money_in), money(r.totals.money_out), money(r.totals.net)]);
    expect(r.totals.transfers).toBe(0);
    expect(r.money_out.map((c) => [c.category, c.amount])).toContainEqual(['loan payments', 300]);
    expect(r.money_in.map((c) => [c.category, c.amount])).toContainEqual(['loan payments', 300]);
    expect(tab().groups).toContainEqual(['Housing', money(300)]);
  });
});

describe('where a report’s data comes from', () => {
  test('names the connection and its bank, with its last clean sync, and older history still arriving as a gap only before what has come', async () => {
    const id = await trackOn();
    const conn = (await connectionsStore.get(ctx, id))!;
    const from = conn.history!.from;
    expect(conn.history!.complete).toBe(false);

    // A period reaching back before the history that has come.
    const long = await report(dayOf(NOW - 200 * DAY));
    const bank = long.institutions.find((i) => i.connector)!;
    expect(bank).toMatchObject({
      institution_name: 'My Bank (through SimpleFIN)',
      coverage: 'importing',
      first_date: from,
      connector: { label: 'SimpleFIN', host: `bridge.test:${server.port}`, state: 'Working', waiting: [] },
    });
    expect(bank.synced_at).toBeTruthy();
    expect(long.gaps).toEqual([{ kind: 'importing', item_id: bank.item_id, institution: 'My Bank (through SimpleFIN)', before: from }]);
    expect(gapSentences(long.gaps, day)).toEqual(['My Bank (through SimpleFIN) is still importing older transactions, so this report may be incomplete.']);
    // Only the months before what has come are short.
    expect(long.months.filter((m) => m.uncertain).every((m) => m.start < from)).toBe(true);
    expect(long.months.some((m) => !m.uncertain && !m.future)).toBe(true);
    // The page names it, at its host, with its state.
    const page = renderToStaticMarkup(createElement(ReportView, { report: long }));
    expect(page).toContain(`My Bank (through SimpleFIN) at bridge.test:${server.port}`);
    expect(reportCsv(long)).toContain(`institution,My Bank (through SimpleFIN),,,,,,at bridge.test:${server.port}; Working; transactions last brought in`);

    // A period inside what has come: nothing missing.
    expect((await report(dayOf(NOW - 30 * DAY))).gaps).toEqual([]);
    // Once its history is all in, the days before it are said to be before it.
    await connectionsStore.update(ctx, id, (c) => (c ? { ...c, history: { ...c.history!, complete: true } } : c));
    expect((await report(dayOf(NOW - 200 * DAY))).gaps).toMatchObject([{ kind: 'begins_late', first: from, from: 'stored' }]);
  });

  test('an old balance at SimpleFIN, or a request that failed, is a bank that hasn’t synced since its last clean sync', async () => {
    const id = await trackOn();
    // SimpleFIN's link to the bank stopped ten days ago: its balance is that old.
    const old = new Date(NOW - 10 * DAY).toISOString();
    for (const a of (await connectorAccountsStore.getAll(ctx)).values()) await connectorAccountsStore.set(ctx, a.account_id, { ...a, balance_at: old, ok_at: old });
    let r = await report(dayOf(NOW - 30 * DAY));
    expect(r.institutions.find((i) => i.connector)!.connector!.state).toBe('Not updating at SimpleFIN');
    expect(r.gaps).toMatchObject([{ kind: 'stale', since: dayOf(NOW - 10 * DAY) }]);
    expect(gapSentences(r.gaps, day)).toEqual([`My Bank (through SimpleFIN) hasn’t synced since ${dayOf(NOW - 10 * DAY)}, so this report may be missing some of its transactions.`]);
    // A period that ended before then is all in.
    expect((await report(dayOf(NOW - 60 * DAY), dayOf(NOW - 20 * DAY))).gaps).toEqual([]);

    // A request that failed after a clean sync five days ago.
    const five = new Date(NOW - 5 * DAY).toISOString();
    for (const a of (await connectorAccountsStore.getAll(ctx)).values()) await connectorAccountsStore.set(ctx, a.account_id, { ...a, balance_at: five, ok_at: five });
    await connectionsStore.update(ctx, id, (c) =>
      c ? { ...c, last_fetch: { ...c.last_fetch!, failure: { kind: 'down', side: 'connector', message: 'SimpleFIN is down for maintenance.', status: 503 } } } : c
    );
    r = await report(dayOf(NOW - 30 * DAY));
    expect(r.gaps).toMatchObject([{ kind: 'stale', since: dayOf(NOW - 5 * DAY) }]);
    expect(r.institutions.find((i) => i.connector)!.connector!.state).toBe('Not updating');
  });

  test('a card waiting for an answer about its sign is said beside it, never a gap: its transactions are all there', async () => {
    await trackOn({ card: [txn('v1', ago(2), '-45.67', 'DINER')] }, '432.10');
    const r = await report(dayOf(NOW - 30 * DAY));
    const bank = r.institutions.find((i) => i.connector)!;
    expect(bank.connector).toMatchObject({ state: 'Needs your answer', waiting: ['Visa'] });
    expect(r.gaps).toEqual([]);
    expect(statusLines(r, day)).toContain(
      'SimpleFIN reports Visa at My Bank (through SimpleFIN) as money held, and Nya is waiting for your answer about it: that holds its balance in the app, not its transactions, which are in this report as SimpleFIN reports them.'
    );
    expect(r.totals.money_out).toBe(45.67);
  });

  test('accounts let go during the period: removed, their transactions gone with them, or kept by hand from that day; back when tracked again', async () => {
    const id = await trackOn({ checking: [txn('c1', ago(3), '-12.50', 'COFFEE')] });
    await disconnect(ctx, id, false, NOW);
    expect([...(await endedAccountsStore.getAll(ctx)).values()].map((e) => [e.name, e.kept, e.host])).toEqual(
      expect.arrayContaining([
        ['Checking', false, `bridge.test:${server.port}`],
        ['Visa', false, `bridge.test:${server.port}`],
      ])
    );
    let r = await report(dayOf(NOW - 30 * DAY));
    expect(r.gaps).toMatchObject([{ kind: 'removed', institution: 'My Bank (through SimpleFIN)', last_seen: TODAY, accounts: ['Checking', 'Visa'], partly_back: false }]);
    expect(gapSentences(r.gaps, day)).toEqual([
      `My Bank (through SimpleFIN) (Checking and Visa) was removed on or after ${TODAY}, and the transactions it brought in went with it, so this report may be missing some of them.`,
    ]);
    expect(r.removed).toEqual([{ institution: 'My Bank (through SimpleFIN)', first_seen: TODAY, last_seen: TODAY, connected_again: false, not_back: ['Checking', 'Visa'] }]);
    // A period that ended before they were tracked: nothing of theirs is missing from it.
    expect((await report(dayOf(NOW - 1500 * DAY), dayOf(NOW - 1000 * DAY))).gaps).toEqual([]);

    // Tracked again through a new connection: back, its own gaps say how far.
    await trackOn();
    r = await report(dayOf(NOW - 30 * DAY));
    expect(r.gaps).toEqual([]);
    expect(r.removed).toEqual([]);
  });

  test('a removed account its history still mentions is SimpleFIN’s in the download, and forgetting its record takes it out of reports', async () => {
    const id = await trackOn({ checking: [txn('c1', ago(3), '-12.50', 'COFFEE')] });
    const accounts = [...(await connectorAccountsStore.getAll(ctx)).values()];
    const checking = accounts.find((a) => a.name === 'Checking')!.account_id;
    const visa = accounts.find((a) => a.name === 'Visa')!.account_id;
    // A day of its balance in the history, which outlives the account.
    await fake.hset(ctxKey('history:accounts'), { [dayOf(NOW - 2 * DAY)]: await encrypt(JSON.stringify({ [checking]: 1500.25 })) });
    await disconnect(ctx, id, false, NOW);

    const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
    expect(doc.accounts.find((a) => a.account_id === checking)).toMatchObject({
      provider: 'simplefin',
      name: 'Checking',
      institution_name: 'My Bank',
      type: 'depository',
      currency: 'USD',
      connected: false,
      first_seen: TODAY,
      last_seen: TODAY,
      latest_balance: { balance: 1500.25, date: dayOf(NOW - 2 * DAY) },
    });

    // Listed to forget, newest first; forgetting one takes it out of reports.
    const call = async (method: 'GET' | 'DELETE', body?: unknown) => {
      const res = method === 'GET' ? await endedRoute.GET() : await endedRoute.DELETE(new Request('http://localhost/api/connectors/ended', { method, body: JSON.stringify(body) }));
      return { status: res.status, body: await res.json() };
    };
    const listed = await call('GET');
    expect(listed.body.accounts.map((a: any) => [a.name, a.institution_name, a.connector, a.kept])).toEqual([
      ['Checking', 'My Bank', 'SimpleFIN', false],
      ['Visa', 'My Bank', 'SimpleFIN', false],
    ]);
    expect((await call('DELETE', { account_id: checking })).body).toEqual({ forgotten: true });
    expect((await report(dayOf(NOW - 30 * DAY))).gaps).toMatchObject([{ kind: 'removed', accounts: ['Visa'] }]);
    expect((await call('DELETE', { account_id: checking })).body).toEqual({ forgotten: false });
    expect((await call('DELETE', { account_id: 'not-an-account' })).status).toBe(400);

    // A record that can't be read is listed by id and may be forgotten; one a
    // newer version saved is counted, and never forgotten here.
    const later = 'manual_00000000-0000-4000-8000-0000000000ee';
    await fake.hset(ctxKey('connector-ended'), { [visa]: 'damaged', [later]: await encrypt(JSON.stringify({ version: 2 })) });
    expect((await call('GET')).body).toEqual({ accounts: [], unreadable: [visa], unrecognised: 1 });
    expect((await call('DELETE', { account_id: later })).status).toBe(409);
    expect((await call('DELETE', { account_id: visa })).body).toEqual({ forgotten: true });
    expect((await call('GET')).body).toEqual({ accounts: [], unreadable: [], unrecognised: 1 });
  });

  test('the list to forget them from says what each is and offers Forget', () => {
    const html = renderToStaticMarkup(
      createElement(StoppedAccountsView, {
        list: {
          accounts: [{ account_id: 'manual_a', name: 'Visa', institution_name: 'My Bank', connector: 'SimpleFIN', ended_at: '2026-09-20T12:00:00.000Z', kept: false }],
          unreadable: ['manual_b'],
          unrecognised: 1,
        },
        busy: false,
        error: null,
        onForget: () => {},
      })
    );
    expect(html).toContain('My Bank Visa');
    expect(html).toContain('Removed on ');
    expect(html).toContain('through SimpleFIN');
    expect(html).toContain('A record that can’t be read');
    expect(html.match(/>Forget</g)).toHaveLength(2);
    expect(html).toContain('One more was saved by a newer version of Nya');
    // The link from where accounts are let go opens it (components/Connectors.tsx EndedPointer).
    expect([asksStopped('?stopped=1'), asksStopped('?kind=year&year=2025&stopped'), asksStopped('?kind=year&year=2025'), asksStopped('')]).toEqual([true, true, false, false]);
  });

  test('kept as manual accounts: from that day only what is entered or imported', async () => {
    const id = await trackOn({ checking: [txn('c1', ago(3), '-12.50', 'COFFEE')] });
    await disconnect(ctx, id, true, NOW);
    const r = await report(dayOf(NOW - 30 * DAY));
    expect(r.gaps).toEqual([{ kind: 'disconnected', item_id: null, institution: 'My Bank (through SimpleFIN)', since: TODAY, accounts: ['Checking', 'Visa'] }]);
    expect(gapSentences(r.gaps, day)).toEqual([
      `Checking and Visa at My Bank (through SimpleFIN) were disconnected on ${TODAY} and kept as manual accounts, so from then on their transactions are only the ones you entered or imported: this report may be missing some of them.`,
    ]);
    // They are manual accounts now, their rows with them, and only this month is short.
    expect(r.manual.map((m) => [m.name, m.transactions])).toEqual([
      ['Checking', 1],
      ['Visa', 0],
    ]);
    expect(r.months.filter((m) => m.uncertain).map((m) => m.month)).toEqual([TODAY.slice(0, 7)]);
    expect(r.totals.money_out).toBe(12.5);
  });
});
