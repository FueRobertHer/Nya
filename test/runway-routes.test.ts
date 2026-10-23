import { describe, expect, test, mock, beforeEach, afterEach, afterAll, setSystemTime } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, ctxKey, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The runway and year over year through their routes and the real read layer
// (app/api/reports/runway, app/api/reports/year-over-year, lib/report/
// runway-read.ts, lib/report/year-over-year-read.ts), and the read-only API's
// (/api/v1/runway, /api/v1/year-over-year): the hand-worked case of
// test/runway.test.ts, stored, to the day; cash defined right (checking,
// savings and cash on hand, less what is pending; never a card, an
// investment or a hidden account; one in another currency left out); a month
// that may be short; year over year held to /api/v1/spending month by month;
// every parameter checked; nothing ever written by either, a what-if never
// sent; other people's data never in them; Plaid never called. And the saved
// scenarios on the storage seam (app/api/runway-scenarios): validation, the
// seam's errors, each person's own, and in the data download.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const plaidTouched: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'string') plaidTouched.push(prop);
        return async () => {
          throw new Error('Plaid must not be called by a report');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

/** Oct 22, 2026, 11:00 in New York: when everything here is read. */
const NOW = Date.parse('2026-10-22T15:00:00.000Z');
setSystemTime(new Date(NOW));
afterAll(() => setSystemTime());

const { ctx, OTHER, txn, seedOther } = await import('./api-fixture');
const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { saveManualAccount } = await import('@/lib/manual');
const { setAccountHidden } = await import('@/lib/hidden');
const { setExcluded } = await import('@/lib/txn-annotations');
const { syncsStore } = await import('@/lib/connection-records');
const { plannedStore } = await import('@/lib/planned-store');
const { createToken } = await import('@/lib/api-tokens');
const { forgetEpochs } = await import('@/lib/sessions');
const { projectRunway, DEFAULT_WHAT_IF } = await import('@/lib/report/runway');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const { firstDay } = await import('@/lib/api-read');
const { runwayScenariosStore } = await import('@/lib/report/runway-scenario-store');
const { MAX_SCENARIOS } = await import('@/lib/report/runway-scenarios');
const { declaredStore } = await import('@/lib/stores');
const { collectUserData, buildUserExport } = await import('@/lib/user-export');
const runwayRoute = await import('@/app/api/reports/runway/route');
const yoyRoute = await import('@/app/api/reports/year-over-year/route');
const scenariosRoute = await import('@/app/api/runway-scenarios/route');
const apiRunway = await import('@/app/api/v1/runway/route');
const apiYoy = await import('@/app/api/v1/year-over-year/route');
const apiSpending = await import('@/app/api/v1/spending/route');

const NY = 'America/New_York';
const period = (start: string, end: string) => {
  const p = resolvePeriod({ kind: 'range', start, end }, NY, NOW);
  if ('error' in p) throw new Error(p.error);
  return p;
};
const RECENT = '2026-10-22T13:00:00.000Z';
const env = { ...process.env };
let token = '';

beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  forgetEpochs();
  clerk.signedIn = null;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  token = (await createToken(ctx, 'Tests')).token;
  plaidTouched.length = 0;
});
afterEach(() => {
  process.env = { ...env };
  expect(plaidTouched).toEqual([]);
});

const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const [error, warn] = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await f();
  } finally {
    [console.error, console.warn] = [error, warn];
  }
};

const get = async (route: { GET: (r: Request) => Promise<Response> }, path: string, query = '') => {
  const res = await route.GET(new Request(`https://nya.test${path}${query ? `?${query}` : ''}`));
  return { res, body: (await res.json()) as any };
};
const api = async (route: { GET: (r: Request) => Promise<Response> }, name: string, query = '') => {
  const res = await route.GET(new Request(`https://nya.test/api/v1/${name}${query ? `?${query}` : ''}`, { headers: { authorization: `Bearer ${token}` } }));
  return { res, body: (await res.json()) as any };
};
const send = async (method: 'POST' | 'DELETE', body: unknown) => {
  const res = await (scenariosRoute as any)[method](new Request('https://nya.test/api/runway-scenarios', { method, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { res, body: (await res.json()) as any };
};

const remembered = (accounts: Record<string, unknown>[]) =>
  encrypt(TEST_CTX, JSON.stringify(accounts.map((a) => ({ official_name: null, subtype: null, mask: null, limit: null, currency: 'USD', ...a }))));
const on = (date: string, id: string, account: string, amount: number, over: Record<string, unknown> = {}) => txn(id, account, 0, amount, { date, ...over });
const store = (txns: ReturnType<typeof txn>[], accounts: Record<string, unknown>, synced_at: string) =>
  encodeJsonBlob(TEST_CTX, { schema_version: 2, cursor: 'c', accounts, txns: Object.fromEntries(txns.map((t) => [t.transaction_id, t])), synced_at });
const plaidAccount = (name: string, type: string, subtype: string) => ({ name, official_name: null, type, subtype, mask: null, balances: null });

/**
 * The case test/runway.test.ts works by hand, as stored: July to September
 * 2026, 9,200.00 of spending (rent, groceries, a car repair; one of the
 * groceries on a Citi card) and 6,440.00 of income; a TV excluded, a move to
 * savings, cash taken out, a meal in euros; the mortgage's 800 on each 5th.
 * Cash: checking 6,985.50 less a lunch of 25.50 still pending, savings
 * 5,000 and a wallet of 40 (12,000.00), but not a hidden savings account,
 * the card's 600 owed, an IRA, or 3,000 in euros. Citi last synced on Aug
 * 20, so August and September may be short of its transactions. And last
 * year, for year over year.
 */
async function seed() {
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt(TEST_CTX, 'a1') });
  await saveItem(ctx, { item_id: 'item_citi', institution_name: 'Citi', encrypted_access_token: await encrypt(TEST_CTX, 'a2') });
  await saveItem(ctx, { item_id: 'item_vg', institution_name: 'Vanguard', encrypted_access_token: await encrypt(TEST_CTX, 'a3') });
  await saveItem(ctx, { item_id: 'item_n26', institution_name: 'N26', encrypted_access_token: await encrypt(TEST_CTX, 'a4') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await remembered([
      { account_id: 'acc_chk', name: 'Checking', type: 'depository', subtype: 'checking' },
      { account_id: 'acc_sav', name: 'Savings', type: 'depository', subtype: 'savings' },
      { account_id: 'acc_hid', name: 'Hidden savings', type: 'depository', subtype: 'savings' },
      { account_id: 'acc_card', name: 'Sapphire', type: 'credit', subtype: 'credit card' },
    ]),
    item_citi: await remembered([{ account_id: 'acc_ci', name: 'Double Cash', type: 'credit', subtype: 'credit card' }]),
    item_vg: await remembered([{ account_id: 'acc_ira', name: 'IRA', type: 'investment', subtype: 'ira' }]),
    item_n26: await remembered([{ account_id: 'acc_eur', name: 'Konto', type: 'depository', subtype: 'checking', currency: 'EUR' }]),
  });
  const balances = { acc_chk: 6985.5, acc_sav: 5000, acc_hid: 9999, acc_card: 600, acc_ci: 0, acc_ira: 50000, acc_eur: 3000 };
  await fake.hset(ctxKey('history:accounts'), { '2026-10-21': await encrypt(TEST_CTX, JSON.stringify(balances)) });
  await setAccountHidden(ctx, 'acc_hid', 'depository', true);

  const chk = (date: string, id: string, amount: number, over: Record<string, unknown> = {}) => on(date, id, 'acc_chk', amount, over);
  const chase = [
    ...['07', '08', '09'].map((m) => chk(`2026-${m}-01`, `rent-${m}`, 1500, { name: 'Landlord', category: 'rent and utilities' })),
    ...['07-03', '07-10', '08-07', '08-14', '08-28', '09-04', '09-11', '09-25'].map((d) => chk(`2026-${d}`, `groceries-${d}`, 300, { name: 'Grocer', category: 'food and drink' })),
    chk('2026-08-15', 'repair', 2000, { name: 'Midas' }),
    ...['07', '08', '09'].map((m) => chk(`2026-${m}-15`, `pay-${m}`, -2000, { name: 'Employer', category: 'income' })),
    chk('2026-08-20', 'refund', -440, { name: 'Shop refund' }),
    chk('2026-07-20', 'tv', 1200, { name: 'TV store' }),
    chk('2026-08-02', 'to-savings', 1000, { name: 'To savings', category: 'transfer out', transaction_code: 'transfer' }),
    chk('2026-09-02', 'atm', 200, { name: 'ATM', transaction_code: 'atm' }),
    chk('2026-09-20', 'paris', 90, { name: 'Bistro', iso_currency_code: 'EUR', category: 'food and drink' }),
    ...['04', '05', '06', '07', '08', '09', '10'].map((m) => chk(`2026-${m}-05`, `mortgage-${m}`, 800, { name: 'Home Loans', category: 'loan payments' })),
    chk('2026-10-22', 'lunch', 25.5, { name: 'Lunch', pending: true, category: 'food and drink' }),
    on('2026-08-09', 'hidden-row', 'acc_hid', 777, { name: 'HIDDEN-ACCOUNT-ROW', account_name: 'Hidden savings' }),
    // Last year, for year over year: the same days, and after them.
    chk('2025-03-01', 'rent-25', 1400, { name: 'Landlord', category: 'rent and utilities' }),
    chk('2025-07-15', 'pay-25', -1900, { name: 'Employer', category: 'income' }),
    chk('2025-08-10', 'groceries-25', 280, { name: 'Grocer', category: 'food and drink' }),
    chk('2025-10-30', 'late-25', 99, { name: 'Grocer', category: 'food and drink' }),
  ];
  await fake.set(
    ctxKey('txns:item_chase'),
    await store(chase, { acc_chk: plaidAccount('Checking', 'depository', 'checking'), acc_sav: plaidAccount('Savings', 'depository', 'savings'), acc_hid: plaidAccount('Hidden savings', 'depository', 'savings'), acc_card: plaidAccount('Sapphire', 'credit', 'credit card') }, RECENT)
  );
  await setExcluded(ctx, 'tv', true);
  // Citi's history goes back years: only its last sync leaves months short.
  const atCiti = { institution_name: 'Citi', account_name: 'Double Cash' };
  const citi = [on('2024-01-05', 'citi-old', 'acc_ci', 12, atCiti), on('2026-07-24', 'citi-groceries', 'acc_ci', 300, { ...atCiti, name: 'Grocer', category: 'food and drink' })];
  await fake.set(ctxKey('txns:item_citi'), await store(citi, { acc_ci: plaidAccount('Double Cash', 'credit', 'credit card') }, '2026-08-20T12:00:00.000Z'));
  await fake.set(ctxKey('txns:item_vg'), await store([], {}, RECENT));
  await fake.set(ctxKey('txns:item_n26'), await store([], { acc_eur: plaidAccount('Konto', 'depository', 'checking') }, RECENT));
  await syncsStore.set(ctx, 'item_chase', { at: RECENT });
  await syncsStore.set(ctx, 'item_citi', { at: '2026-08-20T12:00:00.000Z' });
  await syncsStore.set(ctx, 'item_vg', { at: RECENT });
  await syncsStore.set(ctx, 'item_n26', { at: RECENT });
  await saveManualAccount(ctx, { account_id: 'manual_wallet', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: 'cash', balance: 40, updated_at: '2026-10-20T18:00:00.000Z' });
  await plannedStore.set(ctx, {
    version: 1,
    items: [
      { id: 'reg', name: 'Car registration', kind: 'expense', amount: 300, currency: 'USD', date: '2026-12-01', cadence: 'once' },
      { id: 'refund', name: 'Tax refund', kind: 'income', amount: 1000, currency: 'USD', date: '2027-03-15', cadence: 'once' },
      { id: 'euro', name: 'Paris trip', kind: 'expense', amount: 900, currency: 'EUR', date: '2027-01-10', cadence: 'once' },
    ],
    dismissed: [],
    threshold: null,
  });
}

/** Every key and value the fake holds, for "nothing was written". */
const snapshot = () => JSON.stringify([[...(fake as any).strings].sort(), [...(fake as any).hashes].map(([k, h]: [string, Map<string, string>]) => [k, [...h].sort()]).sort()]);

describe('the runway from stored data', () => {
  test('the hand-worked case, to the day: cash, the spending rule, the loan’s payment, the planned items, income on and off', async () => {
    await seed();
    const { res, body } = await quiet(() => get(runwayRoute, '/api/reports/runway', `tz=${NY}`));
    expect(res.status).toBe(200);
    const r = body.runway;
    expect(r).toMatchObject({ today: '2026-10-22', time_zone: NY, currency: 'USD', start: 12000 });
    // Cash: checking, savings and the wallet, less the lunch pending.
    expect(r.position).toMatchObject({ balances: 12025.5, pending: { amount: 25.5, count: 1 }, start: 12000, leftOut: [{ currency: 'EUR', count: 1 }] });
    expect(r.cash_accounts.map((a: any) => `${a.institution} ${a.name}`).sort()).toEqual(['Cash Wallet', 'Chase Checking', 'Chase Savings']);
    expect(r.owed_on_cards).toBe(600);
    // The spending rule, over July to September.
    const three = r.windows.find((w: any) => w.months === 3);
    expect(three).toMatchObject({ start: '2026-07-01', end: '2026-09-30', days: 92, money_out: 9200, money_in: 6440 });
    expect(three.one_offs).toEqual([{ date: '2026-08-15', name: 'Midas', amount: 2000 }]);
    expect(three.left_out).toEqual([{ currency: 'EUR', count: 1 }]);
    // A month that may be short: Citi last synced on Aug 20.
    expect(three.short).toEqual([
      { month: '2026-08', institutions: ['Citi'] },
      { month: '2026-09', institutions: ['Citi'] },
    ]);
    expect(r.outside).toEqual([{ name: 'Home Loans', institution: 'Chase', account: 'Checking', amount: 800, cadence: 'monthly', next: '2026-11-05' }]);
    expect(r.planned.map((p: any) => p.name)).toEqual(['Car registration', 'Tax refund']);
    expect(r.events_left_out).toEqual([{ currency: 'EUR', count: 1 }]);
    // What it can't see.
    expect(r.notes).toEqual([
      "1 cash account in EUR isn't in this runway, which is in USD.",
      "1 expected payment in EUR isn't in this runway, which is in USD.",
      'Wallet at Cash has no transactions in these months, so what you spend from it isn’t in your spending.',
      'Cash inside investment accounts, such as a brokerage’s settlement or money market fund, isn’t counted: it is money waiting to be invested, days from being spent.',
      'Hidden accounts are left out, their balances and their transactions.',
    ]);
    expect(r.gaps.map((g: any) => [g.kind, g.institution])).toEqual([['stale', 'Citi']]);
    expect(JSON.stringify(r)).not.toContain('HIDDEN-ACCOUNT-ROW');
    // And the days, as worked by hand.
    const p = projectRunway(r, { ...DEFAULT_WHAT_IF, months: 3 });
    expect([p.without_income.runs_out, p.without_income.days]).toEqual(['2027-01-24', 93]);
    expect([p.with_income.runs_out, p.with_income.days]).toEqual(['2027-06-05', 225]);
  });

  test('the API answers the same days, under a what-if when asked, and checks every argument', async () => {
    await seed();
    const plain = await quiet(() => api(apiRunway, 'runway', 'months=3'));
    expect(plain.res.status).toBe(200);
    expect(plain.body).toMatchObject({
      today: '2026-10-22',
      currency: 'USD',
      cash: { start: 12000, balances: 12025.5, pending: 25.5, pending_count: 1, owed_on_cards: 600 },
      spending: { months: 3, from: '2026-07-01', to: '2026-09-30', days: 92, money_out: 9200, money_in: 6440 },
      what_if: { spending_lower_by: 0, income_until: null, include_planned: true, leave_out_one_offs: false },
      without_income: { income: 'none', runs_out: '2027-01-24', days: 93, months: 3.06, outcome: 'runs_out' },
      with_income: { income: 'ongoing', runs_out: '2027-06-05', days: 225, months: 7.39, outcome: 'runs_out' },
    });
    expect(plain.body.spending.months_short).toEqual([
      { month: '2026-08', institutions: ['Citi'] },
      { month: '2026-09', institutions: ['Citi'] },
    ]);
    expect(plain.body.notes).toContain('Citi hasn’t synced since 2026-08-20, so this report may be missing some of its transactions.');
    expect(plain.body.notes).toContain('Your cards owe $600.00: their charges are in the spending as they are made, but paying them off comes out of this cash.');
    // The what-ifs worked by hand in test/runway.test.ts.
    const cases: [string, string, string][] = [
      ['months=3&include_planned=false', '2027-01-27', '2027-05-24'],
      ['months=3&income_until=2026-12-31', '2027-01-24', '2027-03-05'],
      ['months=3&spending_lower_by=304.38', '2027-02-03', ''],
      ['months=3&leave_out_one_offs=true', '2027-02-08', ''],
    ];
    for (const [query, without, withIncome] of cases) {
      const { body } = await quiet(() => api(apiRunway, 'runway', query));
      expect([query, body.without_income.runs_out]).toEqual([query, without]);
      if (withIncome) expect([query, body.with_income.runs_out]).toEqual([query, withIncome]);
    }
    expect((await quiet(() => api(apiRunway, 'runway', 'months=3&include_planned=false'))).body.planned).toEqual([]);
    // Six months by default.
    expect((await quiet(() => api(apiRunway, 'runway'))).body.spending).toMatchObject({ months: 6, from: '2026-04-01' });
    for (const query of ['months=4', 'months=3&months=6', 'spending_lower_by=-5', 'spending_lower_by=lots', 'income_until=2026-02-30', 'include_hidden=true', 'tz=UTC']) {
      const { res, body } = await api(apiRunway, 'runway', query);
      expect([query, res.status, body.error.code]).toEqual([query, 400, 'invalid_request']);
    }
  });

  test('takes only a time zone: a what-if is never sent, and nothing is written', async () => {
    await seed();
    const before = snapshot();
    for (const query of [`tz=${NY}`, '']) expect((await quiet(() => get(runwayRoute, '/api/reports/runway', query))).res.status).toBe(200);
    expect((await quiet(() => api(apiRunway, 'runway', 'months=12&spending_lower_by=100&income_until=2027-01-01&leave_out_one_offs=true'))).res.status).toBe(200);
    // The API's token use is the only write: when it was last used.
    const after = JSON.parse(snapshot());
    const was = JSON.parse(before);
    const changed = (a: any[], b: any[]) => a.filter((x) => !b.some((y) => JSON.stringify(y) === JSON.stringify(x))).map((x) => x[0]);
    expect([...changed(after[0], was[0]), ...changed(after[1], was[1])].filter((k: string) => !/api-tokens|api-requests|ratelimit/.test(k))).toEqual([]);
    for (const query of ['lower_by=100', 'months=3', `tz=${NY}&tz=UTC`, 'tz=Mars/Base', 'currency=USD']) {
      const { res, body } = await get(runwayRoute, '/api/reports/runway', query);
      expect([query, res.status, typeof body.error]).toEqual([query, 400, 'string']);
    }
    expect(snapshot()).toBe(JSON.stringify(after));
  });

  test('a person with nothing: no cash, no spending, and it says so rather than a figure', async () => {
    const { res, body } = await quiet(() => get(runwayRoute, '/api/reports/runway', 'tz=UTC'));
    expect(res.status).toBe(200);
    expect(body.runway).toMatchObject({ start: 0, cash_accounts: [], outside: [], planned: [] });
    expect(body.runway.windows.map((w: any) => w.transactions)).toEqual([0, 0, 0]);
  });

  test('planned items that can’t be read leave it without them, and it says so; hidden accounts that can’t be read fail it', async () => {
    await seed();
    await fake.set(ctxKey('planned-items'), 'damaged-bytes-not-ciphertext-at-all');
    const { body } = await quiet(() => get(runwayRoute, '/api/reports/runway', `tz=${NY}`));
    expect(body.runway.planned).toEqual([]);
    expect(body.runway.outside.map((o: any) => o.name)).toEqual(['Home Loans']);
    expect(body.runway.notes).toContain('Your planned items couldn’t be read, so they aren’t in this, and bills you marked not recurring may be.');
    // Never a runway that may count what the person hid.
    await fake.hset(ctxKey('hidden:accounts'), { acc_hid: 'damaged-not-ciphertext' });
    const failed = await quiet(() => get(runwayRoute, '/api/reports/runway', `tz=${NY}`));
    expect(failed.res.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain('HIDDEN-ACCOUNT-ROW');
  });

  test('other people’s data is never in it, and a container that can’t be reached is a 503', async () => {
    await seed();
    await seedOther(fake);
    const { body } = await quiet(() => get(runwayRoute, '/api/reports/runway', `tz=${NY}`));
    expect(JSON.stringify(body)).not.toMatch(/OTHER-SECRET|OtherBank/);
    const yoy = await quiet(() => get(yoyRoute, '/api/reports/year-over-year', `tz=${NY}`));
    expect(JSON.stringify(yoy.body)).not.toMatch(/OTHER-SECRET|OtherBank/);
    fake.reset();
    forgetEpochs();
    expect((await quiet(() => get(runwayRoute, '/api/reports/runway', `tz=${NY}`))).res.status).toBe(503);
    expect((await quiet(() => get(yoyRoute, '/api/reports/year-over-year', `tz=${NY}`))).res.status).toBe(503);
  });
});

describe('year over year from stored data', () => {
  test('this year against the same days of last year, each month /api/v1/spending’s to the cent, a short month marked', async () => {
    await seed();
    const { res, body } = await quiet(() => get(yoyRoute, '/api/reports/year-over-year', `tz=${NY}`));
    expect(res.status).toBe(200);
    const r = body.report;
    expect(r).toMatchObject({ today: '2026-10-22', currency: 'USD' });
    expect(r.year.this).toMatchObject({ start: '2026-01-01', end: '2026-10-22' });
    expect(r.year.last).toMatchObject({ start: '2025-01-01', end: '2025-10-22', money_out: 1680, money_in: 1900 });
    // Each month is a report's on its days, and, within the year the API
    // reads, /api/v1/spending's.
    for (const m of r.months) {
      for (const side of ['this', 'last']) {
        const span = m[side];
        const report = await quiet(() => readReport(ctx, period(span.start, span.end), { now: NOW, currency: 'USD' }));
        expect([m.month, side, span.money_in, span.money_out, span.net]).toEqual([m.month, side, report.totals.money_in, report.totals.money_out, report.totals.net]);
        if (span.start < firstDay(NOW)) continue;
        const spending = (await quiet(() => api(apiSpending, 'spending', `from=${span.start}&to=${span.end}&currency=USD`))).body;
        expect([m.month, side, span.money_in, span.money_out, span.net]).toEqual([m.month, side, spending.money_in, spending.money_out, spending.net]);
      }
    }
    const aug = r.months.find((m: any) => m.month === '2026-08');
    expect(aug.this).toMatchObject({ uncertain: true, institutions: ['Citi'] });
    expect(aug.last).toMatchObject({ uncertain: false, institutions: [] });
    expect(r.months.find((m: any) => m.month === '2026-07').this.uncertain).toBe(false);
    expect(r.year.this.uncertain).toBe(true);
    // Last year begins with Chase's first transaction on Mar 1, 2025.
    expect(r.gaps.map((g: any) => [g.kind, g.institution])).toEqual([
      ['begins_late', 'Chase'],
      ['stale', 'Citi'],
    ]);
    expect(r.months.find((m: any) => m.month === '2026-02').last).toMatchObject({ uncertain: true, institutions: ['Chase'] });
    // Groups: food this year (the groceries, Citi's among them, and today's
    // lunch, pending, which the Activity tab counts too) against last.
    const food = r.groups.find((g: any) => g.name === 'Food');
    expect(food.money_out).toEqual({ this: 2725.5, last: 280, change: 2445.5, pct: 873.4 });
    expect(JSON.stringify(r)).not.toContain('HIDDEN-ACCOUNT-ROW');

    // The API answers the same figures.
    const a = (await quiet(() => api(apiYoy, 'year-over-year'))).body;
    expect(a.year).toEqual(r.year);
    expect(a.groups).toEqual(r.groups);
    expect(a.notes.slice(0, 2)).toEqual([
      'Chase’s transactions in Nya begin on 2025-03-01: if its accounts were open before then, this report is missing their earlier transactions.',
      'Citi hasn’t synced since 2026-08-20, so this report may be missing some of its transactions.',
    ]);
  });

  test('every parameter is checked before anything is read', async () => {
    for (const query of ['currency=usd', 'kind=year', 'tz=Nowhere/Land', 'currency=USD&currency=EUR']) {
      const { res } = await get(yoyRoute, '/api/reports/year-over-year', query);
      expect([query, res.status]).toEqual([query, 400]);
    }
    for (const query of ['currency=usd', 'from=2026-01-01']) {
      const { res, body } = await api(apiYoy, 'year-over-year', query);
      expect([query, res.status, body.error.code]).toEqual([query, 400, 'invalid_request']);
    }
    // A currency the years have none of: the one most are in.
    await seed();
    expect((await quiet(() => get(yoyRoute, '/api/reports/year-over-year', 'currency=JPY'))).body.report.currency).toBe('USD');
    expect((await quiet(() => get(yoyRoute, '/api/reports/year-over-year', 'currency=EUR'))).body.report.year.this.money_out).toBe(90);
  });
});

describe('saved scenarios, on the storage seam', () => {
  const scenario = (over: Record<string, unknown> = {}) => ({ name: 'If I quit', months: 6, lower_by: 250, currency: 'USD', income_until: '2026-12-31', planned: true, leave_out_one_offs: false, ...over });

  test('saved, listed and deleted, each under a random id, in the data download', async () => {
    const saved = await send('POST', { scenario: scenario() });
    expect(saved.res.status).toBe(200);
    expect(saved.body.scenario).toMatchObject({ v: 1, name: 'If I quit', months: 6, lower_by: 250, saved_at: new Date(NOW).toISOString() });
    expect(saved.body.scenario.id).toMatch(/^[0-9a-f-]{36}$/);
    const listed = await get(scenariosRoute, '/api/runway-scenarios');
    expect(listed.body).toEqual({ scenarios: [saved.body.scenario], unreadable_ids: [], unrecognised_ids: [] });
    expect(declaredStore('runway-scenarios')).toMatchObject({ kind: 'map', exportable: true, what: 'saved runway scenarios' });
    const doc = buildUserExport(await quiet(() => collectUserData({ ctx, userId: null })), new Date(NOW)) as any;
    expect(JSON.stringify(doc['runway-scenarios'])).toContain('If I quit');
    expect((await send('DELETE', { id: saved.body.scenario.id })).res.status).toBe(200);
    expect((await get(scenariosRoute, '/api/runway-scenarios')).body.scenarios).toEqual([]);
    // Only what the person saves is stored: never a figure.
    expect(Object.keys(saved.body.scenario).sort()).toEqual(['currency', 'id', 'income_until', 'leave_out_one_offs', 'lower_by', 'months', 'name', 'planned', 'saved_at', 'v']);
  });

  test('every field is checked, and anything else refused', async () => {
    const refused: [unknown, string][] = [
      ['not json', 'Send the scenario'],
      [{ scenario: scenario(), extra: 1 }, 'extra isn’t taken here'],
      [{ scenario: scenario({ name: '' }) }, 'A name is 1 to 40 characters'],
      [{ scenario: scenario({ name: 'x'.repeat(41) }) }, 'A name is 1 to 40 characters'],
      [{ scenario: scenario({ name: 'two\nlines' }) }, 'on one line'],
      [{ scenario: scenario({ months: 4 }) }, 'months is 3, 6 or 12'],
      [{ scenario: scenario({ lower_by: -1 }) }, 'zero or more'],
      [{ scenario: scenario({ lower_by: 1.234 }) }, 'decimal places'],
      [{ scenario: scenario({ currency: null }) }, 'needs the currency'],
      [{ scenario: scenario({ currency: 'usd' }) }, 'three-letter code'],
      [{ scenario: scenario({ income_until: '2026-02-30' }) }, 'Income stops on a date'],
      [{ scenario: scenario({ planned: 'yes' }) }, 'true or false'],
      [{ scenario: { ...scenario(), result: '2027-01-24' } }, 'result isn’t part of a scenario'],
    ];
    for (const [body, words] of refused) {
      const r = await send('POST', body);
      expect([JSON.stringify(body).slice(0, 60), r.res.status, r.body.error]).toEqual([JSON.stringify(body).slice(0, 60), 400, expect.stringContaining(words)]);
    }
    for (const body of [{}, { id: '../x' }, { id: 'a', also: 1 }]) expect((await send('DELETE', body)).res.status).toBe(400);
    expect((await get(scenariosRoute, '/api/runway-scenarios')).body.scenarios).toEqual([]);
  });

  test('at most MAX_SCENARIOS, counting one that can’t be read', async () => {
    for (let i = 0; i < MAX_SCENARIOS - 1; i++) await runwayScenariosStore.set(ctx, `s${i}`, { v: 1, name: `S${i}`, months: 6, lower_by: 0, currency: null, income_until: null, planned: true, leave_out_one_offs: false, saved_at: '2026-10-01T00:00:00.000Z' });
    await fake.hset(ctxKey('runway-scenarios'), { broken: 'damaged-bytes-not-ciphertext-at-all' });
    const r = await send('POST', { scenario: scenario() });
    expect([r.res.status, r.body.error]).toEqual([409, `At most ${MAX_SCENARIOS} scenarios can be saved: delete one first`]);
  });

  test('one that can’t be read is named, never dropped, and can be deleted; one a newer version saved is never offered', async () => {
    await runwayScenariosStore.set(ctx, 'good', { v: 1, name: 'Good', months: 3, lower_by: 0, currency: null, income_until: null, planned: false, leave_out_one_offs: true, saved_at: '2026-10-01T00:00:00.000Z' });
    await fake.hset(ctxKey('runway-scenarios'), { broken: 'damaged-bytes-not-ciphertext-at-all', later: await encrypt(TEST_CTX, JSON.stringify({ v: 2, name: 'Later' })) });
    const listed = await quiet(() => get(scenariosRoute, '/api/runway-scenarios'));
    expect(listed.res.status).toBe(200);
    expect(listed.body.scenarios.map((s: any) => s.id)).toEqual(['good']);
    expect(listed.body.unreadable_ids).toEqual(['broken']);
    expect(listed.body.unrecognised_ids).toEqual(['later']);
    expect((await send('DELETE', { id: 'broken' })).res.status).toBe(200);
    expect((await quiet(() => get(scenariosRoute, '/api/runway-scenarios'))).body.unreadable_ids).toEqual([]);
  });

  test('each person’s own: another’s are never listed, and deleting by their id leaves them', async () => {
    await seedOther(fake);
    await runwayScenariosStore.set(OTHER, 'theirs', { v: 1, name: 'OTHER-SECRET-SCENARIO', months: 6, lower_by: 0, currency: null, income_until: null, planned: true, leave_out_one_offs: false, saved_at: '2026-10-01T00:00:00.000Z' });
    expect(JSON.stringify((await get(scenariosRoute, '/api/runway-scenarios')).body)).not.toContain('OTHER-SECRET');
    expect((await send('DELETE', { id: 'theirs' })).res.status).toBe(200);
    expect(await runwayScenariosStore.get(OTHER, 'theirs')).toMatchObject({ name: 'OTHER-SECRET-SCENARIO' });
  });

  test('the seam’s errors: 503 with no container', async () => {
    fake.reset();
    forgetEpochs();
    expect((await quiet(() => get(scenariosRoute, '/api/runway-scenarios'))).res.status).toBe(503);
    expect((await quiet(() => send('POST', { scenario: scenario() }))).res.status).toBe(503);
    expect((await quiet(() => send('DELETE', { id: 'a' }))).res.status).toBe(503);
  });

  test('and 500 for storage that fails, with nothing of it said', async () => {
    fake.failNext('hset');
    const failed = await quiet(() => send('POST', { scenario: scenario() }));
    expect([failed.res.status, failed.body]).toEqual([500, { error: 'Failed to save the scenario' }]);
    expect(await runwayScenariosStore.count(ctx)).toBe(0);
  });
});
