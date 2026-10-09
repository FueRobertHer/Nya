import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { InstitutionResult } from '@/lib/networth';

// Allocation over time: the route that reads holdings history and the
// balances measured beside it, and works each recorded day out by today's
// allocation's own rules (lib/allocation/series.ts), for the accounts today's
// allocation shows. Only recorded days, from the first one; a day missing an
// account says so, and an account still shown is expected on every day after
// it was first recorded or known, so an institution that stops answering
// never leaves its days drawn complete; hidden accounts left out; one
// currency; what can't be read is a 409, never an empty series.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { observeHoldings, recordHoldings, readHoldingsHistory } = await import('@/lib/holdings-history');
const { allocationSettingsStore } = await import('@/lib/allocation-settings');
const { setAccountHidden } = await import('@/lib/hidden');
const { forgetEpochs } = await import('@/lib/sessions');
const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { rememberAccounts } = await import('@/lib/last-known');
const route = await import('@/app/api/allocation-history/route');

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
});

const sec = (id: string, over: Record<string, unknown> = {}) => ({ security_id: id, ticker_symbol: id.toUpperCase(), name: `${id} fund`, type: 'etf', is_cash_equivalent: false, ...over });
const hold = (account_id: string, security_id: string, value: number, over: Record<string, unknown> = {}) => ({
  account_id,
  security_id,
  quantity: 1,
  institution_price: value,
  institution_price_as_of: null,
  institution_value: value,
  cost_basis: null,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  ...over,
});
const SECURITIES = [sec('vti'), sec('bnd'), sec('vfifx', { type: 'mutual fund' }), sec('xeqt')];

/** One institution's fetch, its holdings answered, as fetchInstitution
 *  leaves it. */
function answered(name: string, item_id: string, accountIds: string[], holdings: any[]): InstitutionResult {
  const accounts = accountIds.map((account_id) => ({ account_id, type: 'investment', balance: 0 }));
  return {
    institution_name: name,
    item_id,
    accounts,
    holdings: [],
    holdings_observed: observeHoldings({ accounts, holdings, securities: SECURITIES }) ?? undefined,
    error: null,
    needs_reauth: false,
    liabilities: 'unavailable',
  } as InstitutionResult;
}
/** One that failed: nothing recorded for it. */
const failedInst = (name: string, item_id: string): InstitutionResult =>
  ({ institution_name: name, item_id, accounts: [], holdings: [], error: 'This account needs to be reconnected', needs_reauth: true, liabilities: 'unavailable' }) as InstitutionResult;

const recordAt = (iso: string, institutions: InstitutionResult[]) => recordHoldings(ctx, institutions, Date.parse(iso));
const record = (iso: string, accountIds: string[], holdings: any[]) => recordAt(iso, [answered('Broker', 'item_b', accountIds, holdings)]);

/** The balances measured on a day, as recordSnapshot (real) or
 *  recordPartialAccounts (partial) write them. */
async function measured(date: string, balances: Record<string, number>, layer: 'real' | 'partial' = 'real') {
  await fake.hset(ctxKey(layer === 'real' ? 'history:accounts' : 'history:accounts:partial'), { [date]: await encrypt(JSON.stringify(balances)) });
}

/** An account as the account directory remembers it (lib/links.ts). */
async function known(account_id: string, first_seen: string, name: string, institution_name: string) {
  const entry = {
    provider: 'plaid',
    item_id: `item_${institution_name}`,
    institution_id: null,
    institution_name,
    name,
    official_name: null,
    mask: null,
    type: 'investment',
    subtype: '401k',
    persistent_account_id: null,
    first_seen,
    last_seen: first_seen,
  };
  await fake.hset(ctxKey('accounts:directory'), { [account_id]: await encrypt(JSON.stringify(entry)) });
}

/** An investment account as the Plan tab lists it: one today's allocation
 *  shows, unless `shown` is false (its institution can't show it). */
const acct = (account_id: string, currency: string | null = 'USD', manual = false, shown = true) => ({ account_id, currency, manual, shown });

const ask = async (body: unknown) => {
  const res = await route.POST(new Request('http://x/api/allocation-history', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.error = orig;
  }
};

describe('allocation over time', () => {
  async function threeDays() {
    await record('2026-09-30T13:00:00Z', ['a', 'b'], [hold('a', 'vti', 600), hold('b', 'bnd', 400)]);
    // b isn't recorded on Oct 1: its institution answered for a alone.
    await record('2026-10-01T13:00:00Z', ['a'], [hold('a', 'vti', 610)]);
    await record('2026-10-03T13:00:00Z', ['a', 'b'], [hold('a', 'vti', 620), hold('b', 'bnd', 380), hold('b', 'vfifx', 100)]);
  }
  const AB = [acct('a'), acct('b')];

  test('only recorded days, from the first one, across months, each classified', async () => {
    await threeDays();
    const { status, body } = await ask({ from: '2026-09-01', to: '2026-10-09', currency: 'USD', accounts: AB });
    expect(status).toBe(200);
    expect(body).toMatchObject({ from: '2026-09-01', to: '2026-10-09', currency: 'USD', first_recorded: '2026-09-30', last_recorded: '2026-10-03', unreadable_days: [] });
    expect(body.days.map((d: any) => d.date)).toEqual(['2026-09-30', '2026-10-01', '2026-10-03']);
    expect(body.days[0]).toEqual({
      date: '2026-09-30',
      classes: { 'us-stocks': 600, bonds: 400 },
      total: 1000,
      unlisted: 0,
      missing: [],
      otherCurrencies: {},
      noCurrency: 0,
      unpriced: 0,
    });
    // The target-date fund is unclassified, as it is today.
    expect(body.days[2].classes).toEqual({ 'us-stocks': 620, bonds: 380, unclassified: 100 });
  });

  test('a day missing an account recorded before and after it names that account, with when it was recorded', async () => {
    await threeDays();
    const { body } = await ask({ from: '2026-09-01', to: '2026-10-09', currency: 'USD', accounts: AB });
    expect(body.days.map((d: any) => [d.date, d.missing])).toEqual([
      ['2026-09-30', []],
      ['2026-10-01', ['b']],
      ['2026-10-03', []],
    ]);
    expect(body.accounts).toEqual([
      { account_id: 'a', state: 'shown', first: '2026-09-30', last: '2026-10-03', unlisted: false, label: null },
      { account_id: 'b', state: 'shown', first: '2026-09-30', last: '2026-10-03', unlisted: false, label: null },
    ]);
  });

  test('a range that starts after the first recorded day still knows an account recorded before it', async () => {
    await threeDays();
    const { body } = await ask({ from: '2026-10-01', to: '2026-10-02', currency: 'USD', accounts: AB });
    expect(body.first_recorded).toBe('2026-09-30');
    expect(body.days).toEqual([expect.objectContaining({ date: '2026-10-01', missing: ['b'] })]);
  });

  test('the person’s splits classify the days too', async () => {
    await threeDays();
    await allocationSettingsStore.set(ctx, { v: 1, buckets: [], funds: [{ ticker: 'VFIFX', split: { 'us-stocks': 60, bonds: 40 } }], accounts: [], target: null });
    const { body } = await ask({ from: '2026-10-03', to: '2026-10-03', currency: 'USD', accounts: AB });
    expect(body.days[0].classes).toEqual({ 'us-stocks': 680, bonds: 420 });
  });

  test('hidden accounts are left out, and are never missing, even when a list from before asks for them', async () => {
    await threeDays();
    await setAccountHidden(ctx, 'b', 'investment', true);
    const { body } = await ask({ from: '2026-09-01', to: '2026-10-09', currency: 'USD', accounts: AB });
    expect(body.days.map((d: any) => [d.date, d.total, d.missing])).toEqual([
      ['2026-09-30', 600, []],
      ['2026-10-01', 610, []],
      ['2026-10-03', 620, []],
    ]);
    expect(body.accounts.map((a: any) => a.account_id)).toEqual(['a']);
  });

  test('nothing recorded is an empty series, with no first day', async () => {
    const { status, body } = await ask({ from: '2026-09-01', to: '2026-10-09', currency: 'USD', accounts: AB });
    expect(status).toBe(200);
    expect(body).toMatchObject({ first_recorded: null, last_recorded: null, days: [] });
  });
});

describe('an institution that stops answering', () => {
  // The review's reproduction, through the real recorder and route: a
  // Vanguard brokerage with $100k of BND and a Fidelity 401(k) with $300k of
  // VTI are both recorded on Oct 1 and 2; from Oct 3 Fidelity needs to be
  // reconnected, so only Vanguard is recorded.
  const vanguard = () => answered('Vanguard', 'iv', ['brk'], [hold('brk', 'bnd', 100_000)]);
  const fidelity = () => answered('Fidelity', 'if', ['k401'], [hold('k401', 'vti', 300_000)]);
  const LIST = [acct('brk'), acct('k401')];

  async function fidelityFails(withBalances: boolean) {
    for (const d of ['2026-10-01', '2026-10-02']) {
      await recordAt(`${d}T13:00:00Z`, [vanguard(), fidelity()]);
      if (withBalances) await measured(d, { brk: 100_000, k401: 300_000 });
    }
    for (const d of ['2026-10-03', '2026-10-05', '2026-10-08']) {
      await recordAt(`${d}T13:00:00Z`, [vanguard(), failedInst('Fidelity', 'if')]);
      // A failed institution leaves no total, only the others' balances.
      if (withBalances) await measured(d, { brk: 100_000 }, 'partial');
    }
  }

  for (const withBalances of [true, false]) {
    test(`marks every day after it was last recorded and says since when${withBalances ? '' : ' (positions only)'}`, async () => {
      await fidelityFails(withBalances);
      const { body } = await ask({ from: '2026-10-01', to: '2026-10-09', currency: 'USD', accounts: LIST });
      expect(body.days.map((d: any) => [d.date, d.classes, d.missing])).toEqual([
        ['2026-10-01', { 'us-stocks': 300_000, bonds: 100_000 }, []],
        ['2026-10-02', { 'us-stocks': 300_000, bonds: 100_000 }, []],
        ['2026-10-03', { bonds: 100_000 }, ['k401']],
        ['2026-10-05', { bonds: 100_000 }, ['k401']],
        ['2026-10-08', { bonds: 100_000 }, ['k401']],
      ]);
      // The last day, which the readout opens on, is never complete.
      expect(body.days.at(-1).missing).toEqual(['k401']);
      expect(body.accounts.find((a: any) => a.account_id === 'k401')).toEqual({ account_id: 'k401', state: 'shown', first: '2026-10-01', last: '2026-10-02', unlisted: false, label: null });
    });
  }

  test('one failing when recording began is missing from the days before its first, once the directory knew it', async () => {
    // Known since September; recording starts on Oct 1 while Fidelity is
    // failing, and it is first recorded on Oct 4.
    await known('k401', '2026-09-01', '401(k)', 'Fidelity');
    for (const d of ['2026-10-01', '2026-10-02']) await recordAt(`${d}T13:00:00Z`, [vanguard(), failedInst('Fidelity', 'if')]);
    await recordAt('2026-10-04T13:00:00Z', [vanguard(), fidelity()]);
    const { body } = await ask({ from: '2026-10-01', to: '2026-10-09', currency: 'USD', accounts: LIST });
    expect(body.days.map((d: any) => [d.date, d.missing])).toEqual([
      ['2026-10-01', ['k401']],
      ['2026-10-02', ['k401']],
      ['2026-10-04', []],
    ]);
    expect(body.accounts.find((a: any) => a.account_id === 'k401')).toMatchObject({ first: '2026-10-04', last: '2026-10-04' });
  });

  test('an account linked later is not missing from the days before it existed', async () => {
    await known('k401', '2026-10-04', '401(k)', 'Fidelity');
    for (const d of ['2026-10-01', '2026-10-02']) await recordAt(`${d}T13:00:00Z`, [vanguard()]);
    await recordAt('2026-10-04T13:00:00Z', [vanguard(), fidelity()]);
    const { body } = await ask({ from: '2026-10-01', to: '2026-10-09', currency: 'USD', accounts: LIST });
    expect(body.days.map((d: any) => d.missing)).toEqual([[], [], []]);
  });

  test('a directory entry that can’t be read leaves no day drawn whole without its account', async () => {
    await fake.hset(ctxKey('accounts:directory'), { k401: 'not-a-ciphertext' });
    for (const d of ['2026-10-01', '2026-10-02']) await recordAt(`${d}T13:00:00Z`, [vanguard()]);
    await recordAt('2026-10-04T13:00:00Z', [vanguard(), fidelity()]);
    const { body } = await ask({ from: '2026-10-01', to: '2026-10-09', currency: 'USD', accounts: LIST });
    expect(body.days.map((d: any) => d.missing)).toEqual([['k401'], ['k401'], []]);
  });

  test('an account the dashboard no longer shows is expected only while it was recorded, counted from its positions, and named', async () => {
    await known('old', '2026-09-01', 'Rollover IRA', 'Schwab');
    await recordAt('2026-10-01T13:00:00Z', [vanguard(), answered('Schwab', 'is', ['old'], [hold('old', 'vti', 50_000)])]);
    await measured('2026-10-01', { brk: 100_000, old: 80_000 });
    // Not recorded on the 2nd, then recorded again on the 3rd, then gone.
    await recordAt('2026-10-02T13:00:00Z', [vanguard()]);
    await recordAt('2026-10-03T13:00:00Z', [vanguard(), answered('Schwab', 'is', ['old'], [hold('old', 'vti', 50_000, { iso_currency_code: null })])]);
    await recordAt('2026-10-06T13:00:00Z', [vanguard()]);
    const { body } = await ask({ from: '2026-10-01', to: '2026-10-09', currency: 'USD', accounts: [acct('brk')] });
    expect(body.days.map((d: any) => [d.date, d.classes, d.missing, d.noCurrency])).toEqual([
      // Its positions alone: its balance's currency isn't known, so the
      // $30,000 beyond them isn't counted.
      ['2026-10-01', { 'us-stocks': 50_000, bonds: 100_000 }, [], 0],
      ['2026-10-02', { bonds: 100_000 }, ['old'], 0],
      // A position of its with no currency is left out, never assumed USD.
      ['2026-10-03', { bonds: 100_000 }, [], 50_000],
      // Gone after its last day: not missing.
      ['2026-10-06', { bonds: 100_000 }, [], 0],
    ]);
    expect(body.accounts.find((a: any) => a.account_id === 'old')).toEqual({ account_id: 'old', state: 'gone', first: '2026-10-01', last: '2026-10-03', unlisted: false, label: 'Rollover IRA at Schwab' });
  });
});

describe('an account the dashboard can’t show', () => {
  // The verification's reproduction (case B): a Fidelity 401(k) recorded on
  // Aug 20 whose institution has failed since, past the 35-day recovery
  // limit, so the dashboard shows none of Fidelity's accounts and names k401
  // only in unshown_accounts.
  const LATE = ['2026-09-30', '2026-10-08'];
  async function outage() {
    await known('k401', '2026-01-01', '401(k)', 'Fidelity');
    await recordAt('2026-08-20T13:00:00Z', [answered('Vanguard', 'iv', ['brk'], [hold('brk', 'bnd', 100_000)]), answered('Fidelity', 'if', ['k401'], [hold('k401', 'vti', 300_000)])]);
    await measured('2026-08-20', { brk: 100_000, k401: 300_000 });
    for (const d of LATE) {
      await recordAt(`${d}T13:00:00Z`, [answered('Vanguard', 'iv', ['brk'], [hold('brk', 'bnd', 100_000)]), failedInst('Fidelity', 'if')]);
      await measured(d, { brk: 100_000 }, 'partial');
    }
  }
  const lateDays = (body: any) => body.days.filter((d: any) => LATE.includes(d.date)).map((d: any) => [d.date, d.classes, d.missing]);
  const STILL_MISSING = [
    ['2026-09-30', { bonds: 100_000 }, ['k401']],
    ['2026-10-08', { bonds: 100_000 }, ['k401']],
  ];

  test('listed by the Plan as one it can’t show: expected however long the outage, and never called gone', async () => {
    await outage();
    const { body } = await ask({ from: '2026-08-01', to: '2026-10-09', currency: 'USD', accounts: [acct('brk'), acct('k401', 'USD', false, false)] });
    expect(lateDays(body)).toEqual(STILL_MISSING);
    expect(body.days[0].classes).toEqual({ 'us-stocks': 300_000, bonds: 100_000 });
    expect(body.accounts.find((a: any) => a.account_id === 'k401')).toEqual({ account_id: 'k401', state: 'unshown', first: '2026-08-20', last: '2026-08-20', unlisted: false, label: '401(k) at Fidelity' });
  });

  test('not listed, but remembered for a connection still stored: the same, from what the server knows', async () => {
    await outage();
    await saveItem(ctx, { item_id: 'if', institution_name: 'Fidelity', encrypted_access_token: await encrypt('tok') });
    await rememberAccounts(ctx, [{ item_id: 'if', error: null, accounts: [{ account_id: 'k401', name: '401(k)', type: 'investment', subtype: '401k', currency: 'USD' }] }]);
    const { body } = await ask({ from: '2026-08-01', to: '2026-10-09', currency: 'USD', accounts: [acct('brk')] });
    expect(lateDays(body)).toEqual(STILL_MISSING);
    expect(body.accounts.find((a: any) => a.account_id === 'k401')).toMatchObject({ state: 'unshown' });
  });

  test('missing from an answer pending confirmation: still expected', async () => {
    await outage();
    await fake.hset(ctxKey('accounts:vanished'), { if: await encrypt(JSON.stringify({ k401: new Date().toISOString() })) });
    const { body } = await ask({ from: '2026-08-01', to: '2026-10-09', currency: 'USD', accounts: [acct('brk')] });
    expect(lateDays(body)).toEqual(STILL_MISSING);
    expect(body.accounts.find((a: any) => a.account_id === 'k401')).toMatchObject({ state: 'unshown' });
  });

  test('its connection removed, or the account closed: gone, expected only while it was recorded', async () => {
    await outage();
    const { body } = await ask({ from: '2026-08-01', to: '2026-10-09', currency: 'USD', accounts: [acct('brk')] });
    expect(lateDays(body)).toEqual([
      ['2026-09-30', { bonds: 100_000 }, []],
      ['2026-10-08', { bonds: 100_000 }, []],
    ]);
    expect(body.accounts.find((a: any) => a.account_id === 'k401')).toMatchObject({ state: 'gone' });
  });
});

describe('each day counted by today’s rules', () => {
  test('on a day an account’s positions didn’t come, its balance is unclassified, never spread by its split (the verification’s case A)', async () => {
    // A brokerage's split is for its $5,000 of unlisted cash.
    await allocationSettingsStore.set(ctx, { v: 1, buckets: [], funds: [], accounts: [{ account_id: 'brk', split: { cash: 100 } }], target: null });
    await recordAt('2026-10-01T13:00:00Z', [answered('Vanguard', 'iv', ['brk', 'ira'], [hold('brk', 'vti', 95_000), hold('ira', 'bnd', 50_000)])]);
    await measured('2026-10-01', { brk: 100_000, ira: 50_000 });
    // Oct 2: no answer for brk's holdings was recorded; its balance was measured.
    await recordAt('2026-10-02T13:00:00Z', [answered('Other', 'io', ['ira'], [hold('ira', 'bnd', 50_000)])]);
    await measured('2026-10-02', { brk: 100_000, ira: 50_000 });
    const { body } = await ask({ from: '2026-10-01', to: '2026-10-02', currency: 'USD', accounts: [acct('brk'), acct('ira')] });
    expect(body.days[0].classes).toEqual({ 'us-stocks': 95_000, bonds: 50_000, cash: 5_000 });
    expect(body.days[1]).toMatchObject({ classes: { bonds: 50_000, unclassified: 100_000 }, unlisted: 100_000, missing: [] });
  });


  test('a manual investment account counts its balance, unclassified, or by the split the person set for it', async () => {
    await record('2026-10-01T13:00:00Z', ['brk'], [hold('brk', 'vti', 100_000)]);
    await measured('2026-10-01', { brk: 100_000, manual_401k: 200_000 });
    const list = [acct('brk'), acct('manual_401k', 'USD', true)];
    const plain = await ask({ from: '2026-10-01', to: '2026-10-01', currency: 'USD', accounts: list });
    // As the current view: "Unclassified 67%", not "100% US stocks".
    expect(plain.body.days[0]).toMatchObject({ classes: { 'us-stocks': 100_000, unclassified: 200_000 }, total: 300_000, unlisted: 200_000, missing: [] });
    expect(plain.body.accounts.map((a: any) => [a.account_id, a.unlisted])).toEqual([
      ['brk', false],
      ['manual_401k', true],
    ]);
    await allocationSettingsStore.set(ctx, { v: 1, buckets: [], funds: [], accounts: [{ account_id: 'manual_401k', split: { 'us-stocks': 50, bonds: 50 } }], target: null });
    const split = await ask({ from: '2026-10-01', to: '2026-10-01', currency: 'USD', accounts: list });
    expect(split.body.days[0]).toMatchObject({ classes: { 'us-stocks': 200_000, bonds: 100_000 }, unlisted: 0 });
  });

  test('an account whose positions didn’t come that day counts its balance as unclassified, and isn’t missing', async () => {
    await record('2026-10-01T13:00:00Z', ['brk', 'k401'], [hold('brk', 'bnd', 100_000), hold('k401', 'vti', 300_000)]);
    await measured('2026-10-01', { brk: 100_000, k401: 300_000 });
    // Oct 2: Fidelity's balance was measured, but its holdings call failed.
    await record('2026-10-02T13:00:00Z', ['brk'], [hold('brk', 'bnd', 100_000)]);
    await measured('2026-10-02', { brk: 100_000, k401: 301_000 });
    const { body } = await ask({ from: '2026-10-01', to: '2026-10-02', currency: 'USD', accounts: [acct('brk'), acct('k401')] });
    expect(body.days[1]).toMatchObject({ classes: { bonds: 100_000, unclassified: 301_000 }, unlisted: 301_000, missing: [] });
  });

  test('money a balance holds beyond its positions is unclassified; a partial measurement wins over the real one', async () => {
    await record('2026-10-01T13:00:00Z', ['brk'], [hold('brk', 'vti', 1_000)]);
    await measured('2026-10-01', { brk: 1_000 });
    await measured('2026-10-01', { brk: 1_250 }, 'partial');
    const { body } = await ask({ from: '2026-10-01', to: '2026-10-01', currency: 'USD', accounts: [acct('brk')] });
    expect(body.days[0]).toMatchObject({ classes: { 'us-stocks': 1_000, unclassified: 250 }, total: 1_250, unlisted: 250 });
  });

  test('currencies as today: an account in another is left out whole, a position in another is left out, one with none takes its account’s', async () => {
    // A Canadian RRSP holding a US ETF, and a US brokerage with a CAD
    // position and one with no currency at all.
    await record('2026-10-01T13:00:00Z', ['rrsp', 'brk'], [
      hold('rrsp', 'vti', 5_000),
      hold('brk', 'bnd', 1_000),
      hold('brk', 'xeqt', 300, { iso_currency_code: 'CAD' }),
      hold('brk', 'vti', 200, { iso_currency_code: null }),
    ]);
    await measured('2026-10-01', { rrsp: 7_000, brk: 1_600 });
    const list = [acct('rrsp', 'CAD'), acct('brk', 'USD')];
    const usd = await ask({ from: '2026-10-01', to: '2026-10-01', currency: 'USD', accounts: list });
    expect(usd.body.days[0]).toMatchObject({ classes: { 'us-stocks': 200, bonds: 1_000 }, total: 1_200, otherCurrencies: { CAD: 7_300 }, noCurrency: 0 });
    // In CAD, the brokerage is left out whole, and so are the RRSP's
    // positions, all priced in USD: its balance holds them converted, so it
    // can't be set against them, exactly as today's allocation does.
    const cad = await ask({ from: '2026-10-01', to: '2026-10-01', currency: 'CAD', accounts: list });
    expect(cad.body.days[0]).toMatchObject({ classes: {}, total: 0, otherCurrencies: { USD: 6_600 } });
    // With none asked, the one most listed accounts are in.
    const common = await ask({ from: '2026-10-01', to: '2026-10-01', accounts: [acct('rrsp', 'CAD'), acct('brk', 'USD'), acct('manual_x', 'USD', true)] });
    expect(common.body.currency).toBe('USD');
  });

  test('a listed id from before a reconnect is read as the account it is now', async () => {
    await record('2026-10-01T13:00:00Z', ['acct_new'], [hold('acct_new', 'vti', 1_000)]);
    await fake.hset(ctxKey('account-links'), { acct_old: await encrypt(JSON.stringify({ to: 'acct_new', linked_at: '2026-10-02T00:00:00.000Z', evidence: {} })) });
    const { body } = await ask({ from: '2026-10-01', to: '2026-10-01', currency: 'USD', accounts: [acct('acct_old')] });
    expect(body.days[0]).toMatchObject({ classes: { 'us-stocks': 1_000 }, missing: [] });
    expect(body.accounts.map((a: any) => [a.account_id, a.state])).toEqual([['acct_new', 'shown']]);
  });
});

describe('what can’t be read', () => {
  const AB = [acct('a'), acct('b')];
  async function twoDays() {
    await record('2026-09-30T13:00:00Z', ['a', 'b'], [hold('a', 'vti', 600), hold('b', 'bnd', 400)]);
    await record('2026-10-03T13:00:00Z', ['a', 'b'], [hold('a', 'vti', 620), hold('b', 'bnd', 380)]);
  }

  test('a day whose balances are damaged is left out and named, never counted as a day with none', async () => {
    await twoDays();
    await measured('2026-09-30', { a: 600, b: 400 });
    await fake.hset(ctxKey('history:accounts'), { '2026-10-03': 'not-a-ciphertext' });
    const { status, body } = await ask({ from: '2026-09-01', to: '2026-10-09', currency: 'USD', accounts: AB });
    expect(status).toBe(200);
    expect(body.days.map((d: any) => d.date)).toEqual(['2026-09-30']);
    expect(body.unreadable_days).toEqual(['2026-10-03']);
  });

  test('a month that can’t be read is a flagged 409, never an empty series', async () => {
    await twoDays();
    const key = ctxKey('holdings:history');
    const [id] = [...(fake as any).hashes.get(key).keys()] as string[];
    await fake.hset(key, { [id]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const { status, body } = await quiet(() => ask({ from: '2026-09-01', to: '2026-10-09', currency: 'USD', accounts: AB }));
    expect(status).toBe(409);
    expect(body).toMatchObject({ unreadable: true, unreadable_ids: [id] });
  });

  test('months whose index went missing are a flagged 409 too, never nothing recorded', async () => {
    await twoDays();
    await fake.hdel(ctxKey('holdings:history:index'), 'index');
    const { status, body } = await quiet(() => ask({ from: '2026-09-01', to: '2026-10-09', currency: 'USD', accounts: AB }));
    expect(status).toBe(409);
    expect(body.unreadable).toBe(true);
    expect(body.days).toBeUndefined();
  });

  test('settings that can’t be read are a flagged 409 too', async () => {
    await twoDays();
    await fake.set(ctxKey('allocation-settings'), 'damaged');
    const { status, body } = await quiet(() => ask({ from: '2026-09-01', to: '2026-10-09', currency: 'USD', accounts: AB }));
    expect(status).toBe(409);
    expect(body.unreadable).toBe(true);
  });

  test('storage that can’t be reached is a 500, without the flag', async () => {
    await twoDays();
    fake.failNext('hmget');
    const { status, body } = await quiet(() => ask({ from: '2026-09-01', to: '2026-10-09', currency: 'USD', accounts: AB }));
    expect(status).toBe(500);
    expect(body.unreadable).toBeUndefined();
  });
});

describe('reading', () => {
  test('the months are read one at a time, so no more than a month of positions is held at once', async () => {
    for (const d of ['2026-08-15', '2026-09-15', '2026-10-01']) await record(`${d}T13:00:00Z`, ['a'], [hold('a', 'vti', 1)]);
    const hmget = fake.hmget.bind(fake);
    let open = 0;
    let most = 0;
    (fake as any).hmget = async (...args: [string, ...string[]]) => {
      open++;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 5));
      try {
        return await hmget(...args);
      } finally {
        open--;
      }
    };
    try {
      const { body } = await ask({ from: '2026-08-01', to: '2026-10-09', currency: 'USD', accounts: [acct('a')] });
      expect(body.days).toHaveLength(3);
      // The two balance layers of one month at a time.
      expect(most).toBe(2);
    } finally {
      (fake as any).hmget = hmget;
    }
  });

  test('refuses what isn’t a question it answers', async () => {
    const ok = { accounts: [acct('a')] };
    for (const body of [
      'not json',
      '[]',
      { ...ok, extra: 1 },
      { ...ok, from: '2026-13-01' },
      { ...ok, from: '2026-02-30' },
      { ...ok, to: 'yesterday' },
      { ...ok, from: '2026-10-09', to: '2026-10-01' },
      { ...ok, from: '2025-01-01', to: '2026-10-09' },
      { ...ok, currency: 'usd' },
      { ...ok, currency: 'A' },
      {},
      { accounts: 'a' },
      { accounts: [{ account_id: 'a', currency: 'USD', manual: false }] },
      { accounts: [{ account_id: 'a', currency: 'USD', manual: false, shown: true, name: 'IRA' }] },
      { accounts: [{ account_id: 'has space', currency: 'USD', manual: false, shown: true }] },
      { accounts: [{ account_id: 'a', currency: 'usd', manual: false, shown: true }] },
      { accounts: [{ account_id: 'a', currency: 'USD', manual: 'no', shown: true }] },
      { accounts: [{ account_id: 'a', currency: 'USD', manual: false, shown: 'yes' }] },
      { accounts: [acct('a'), acct('a')] },
      { accounts: Array.from({ length: 501 }, (_, i) => acct(`a${i}`)) },
    ]) {
      expect((await ask(body)).status).toBe(400);
    }
    // A currency of Plaid's unofficial kind is one.
    expect((await ask({ accounts: [acct('a', 'USDC')], currency: 'USDC' })).status).toBe(200);
  });
});

describe('when each account was recorded', () => {
  test('an account recorded under an earlier id spans both, under its current id; a hidden one isn’t there', async () => {
    await record('2026-10-05T13:00:00Z', ['acct_old'], [hold('acct_old', 'vti', 1)]);
    await record('2026-10-07T13:00:00Z', ['acct_new', 'other'], [hold('acct_new', 'vti', 1), hold('other', 'bnd', 1)]);
    const links = new Map([['acct_old', { to: 'acct_new', linked_at: '2026-10-08T00:00:00.000Z', evidence: {} }]]);
    const { accounts } = await readHoldingsHistory(ctx, null, { links, hidden: new Set(['other']) });
    expect([...accounts]).toEqual([['acct_new', { first: '2026-10-05', last: '2026-10-07' }]]);
  });
});
