import { describe, expect, test, mock, beforeEach, afterAll, setSystemTime } from 'bun:test';
import { clerk } from './clerk-mock';
import { FakeRedis, storageMock, ctxKey, testKey, TEST_CTX, registerTestContainer } from './fake-redis';
import { ecbHash } from './fx-fixture';

// Invested assets day by day since the plan saved as your plan
// (app/api/invested-history, lib/fire/invested-series.ts), worked by hand:
// what counts comes from the saved plan (include cash, its currency, its
// day), hidden accounts are left out by every id they had, one balance per
// account a day, an account in another currency left out and named without
// a home currency and converted at that day's rate with one, an account
// missing a day marks the day short, an account that ended counts only
// before its end, and a damaged day is named, never read as one with none.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

/** The file's own clock: Oct 9, 2026, 15:00 UTC. */
const NOW = Date.parse('2026-10-09T15:00:00.000Z');
setSystemTime(new Date(NOW));
afterAll(() => setSystemTime());

const ctx = TEST_CTX;
const { encrypt } = await import('@/lib/crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { savedPlanStore } = await import('@/lib/saved-plan');
const { DEFAULT_PLAN } = await import('@/lib/fire/plan');
const { setAccountHidden } = await import('@/lib/hidden');
const { investedSeries, progressAccountsOf } = await import('@/lib/fire/invested-series');
const route = await import('@/app/api/invested-history/route');

beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  forgetEpochs();
  clerk.signedIn = null;
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
});

/** The plan saved as your plan, on `day`. */
async function saved(day: string, over: { includeCash?: boolean; currency?: string | null } = {}) {
  await savedPlanStore.set(ctx, {
    version: 1,
    plan: { ...DEFAULT_PLAN, age: 35, targetAge: 55, includeCash: over.includeCash ?? false },
    savings: 12_000,
    currency: over.currency === undefined ? 'USD' : over.currency,
    inflation: 0.03,
    day,
    savedAt: `${day}T12:00:00.000Z`,
    rev: 'rev-1',
  });
}

/** The balances measured on a day, as recordSnapshot (real) or
 *  recordPartialAccounts (partial) write them. */
async function measured(date: string, balances: Record<string, number>, layer: 'real' | 'partial' = 'real') {
  await fake.hset(ctxKey(layer === 'real' ? 'history:accounts' : 'history:accounts:partial'), { [date]: await encrypt(ctx, JSON.stringify(balances)) });
}

/** An account as the account directory remembers it (lib/links.ts). */
async function known(account_id: string, first_seen: string, name: string, type = 'investment') {
  const entry = {
    provider: 'plaid',
    item_id: 'item_broker',
    institution_id: null,
    institution_name: 'Broker',
    name,
    official_name: null,
    mask: null,
    type,
    subtype: null,
    persistent_account_id: null,
    first_seen,
    last_seen: first_seen,
  };
  await fake.hset(ctxKey('accounts:directory'), { [account_id]: await encrypt(ctx, JSON.stringify(entry)) });
}

const acct = (account_id: string, type = 'investment', currency: string | null = 'USD') => ({ account_id, type, currency });

const ask = async (body: unknown) => {
  const res = await route.POST(new Request('http://x/api/invested-history', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));
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

describe('what counts, by the saved plan’s rules', () => {
  test('investment accounts only, then with include cash checking and savings too; credit never', async () => {
    await saved('2026-10-01');
    await measured('2026-10-01', { brk: 10_000, ira: 5_000, chk: 2_000, card: -800 });
    await measured('2026-10-02', { brk: 10_100, ira: 5_050, chk: 1_500, card: -900 });
    const accounts = [acct('brk'), acct('ira', 'brokerage'), acct('chk', 'depository'), acct('card', 'credit')];
    const off = await ask({ accounts });
    expect(off.status).toBe(200);
    // 10,000 + 5,000; then 10,100 + 5,050.
    expect(off.body.anchor).toMatchObject({ date: '2026-10-01', total: 15_000, counted: 2, missing: [] });
    expect(off.body.latest).toMatchObject({ date: '2026-10-02', total: 15_150 });
    expect(off.body).toMatchObject({ currency: 'USD', saved_day: '2026-10-01', unreadable_days: [] });
    expect(off.body.accounts.map((a: any) => a.account_id)).toEqual(['brk', 'ira']);

    // Saved with include cash: 15,000 + 2,000 and 15,150 + 1,500.
    await saved('2026-10-01', { includeCash: true });
    const on = await ask({ accounts });
    expect(on.body.anchor).toMatchObject({ total: 17_000, counted: 3 });
    expect(on.body.latest).toMatchObject({ total: 16_650 });
  });

  test('nothing from before the day it was saved', async () => {
    await saved('2026-10-02');
    await measured('2026-10-01', { brk: 99_999 });
    await measured('2026-10-02', { brk: 10_000 });
    const { body } = await ask({ accounts: [acct('brk')] });
    expect(body.anchor.date).toBe('2026-10-02');
    expect(body.months).toEqual([{ date: '2026-10-02', total: 10_000 }]);
  });

  test('a hidden account is left out on every day, by every id it had, whatever the page sends', async () => {
    await saved('2026-10-01');
    // `hid` was `hid_old` before a reconnect.
    await fake.hset(ctxKey('account-links'), { hid_old: await encrypt(ctx, JSON.stringify({ to: 'hid', linked_at: '2026-10-02T00:00:00.000Z', evidence: {} })) });
    await setAccountHidden(ctx, 'hid', 'investment', true);
    await measured('2026-10-01', { brk: 10_000, hid_old: 4_000 });
    await measured('2026-10-02', { brk: 10_000, hid: 4_100 });
    const { body } = await ask({ accounts: [acct('brk'), acct('hid'), acct('hid_old')] });
    expect(body.anchor).toMatchObject({ total: 10_000, counted: 1 });
    expect(body.latest).toMatchObject({ total: 10_000, counted: 1, missing: [] });
    expect(body.accounts.map((a: any) => a.account_id)).toEqual(['brk']);
  });

  test('one balance per account a day: on a day both its ids were measured, never both', async () => {
    await saved('2026-10-01');
    await fake.hset(ctxKey('account-links'), { old: await encrypt(ctx, JSON.stringify({ to: 'new', linked_at: '2026-10-02T00:00:00.000Z', evidence: {} })) });
    await measured('2026-10-01', { old: 8_000 });
    // The reconnect day: the partial layer still has the old id.
    await measured('2026-10-02', { new: 8_050 });
    await measured('2026-10-02', { old: 8_000 }, 'partial');
    const { body } = await ask({ accounts: [acct('new')] });
    expect(body.anchor).toMatchObject({ date: '2026-10-01', total: 8_000, counted: 1 });
    // The id it is known by now first: 8,050, never 16,050.
    expect(body.latest).toMatchObject({ date: '2026-10-02', total: 8_050, counted: 1 });
  });
});

describe('a gap', () => {
  test('an account expected and not measured marks its day short and named, and the plan starts from the first whole day', async () => {
    await saved('2026-10-01');
    await known('brk', '2026-09-01', 'Brokerage');
    await known('ira', '2026-09-01', 'IRA');
    // The IRA's institution failed on Oct 1: only a partial map.
    await measured('2026-10-01', { brk: 10_000 }, 'partial');
    await measured('2026-10-02', { brk: 10_000, ira: 5_000 });
    // No snapshot at all on Oct 3: not a day of the series.
    await measured('2026-10-04', { brk: 10_200 });
    const { body } = await ask({ accounts: [acct('brk'), acct('ira')] });
    expect(body.anchor).toMatchObject({ date: '2026-10-02', total: 15_000, missing: [] });
    // The newest day, short: what it has, and who is missing.
    expect(body.latest).toMatchObject({ date: '2026-10-04', total: 10_200, counted: 1, missing: ['ira'] });
    // A point a month: the last whole day.
    expect(body.months).toEqual([{ date: '2026-10-02', total: 15_000 }]);
    expect(body.accounts).toEqual([
      { account_id: 'brk', first: '2026-10-01', last: '2026-10-04', ended: null, label: 'Brokerage at Broker' },
      { account_id: 'ira', first: '2026-10-02', last: '2026-10-02', ended: null, label: 'IRA at Broker' },
    ]);
  });

  test('an account first measured after the start is never missing before it, and says when it was first measured', async () => {
    await saved('2026-10-01');
    await measured('2026-10-01', { brk: 10_000 });
    await measured('2026-10-05', { brk: 10_000, newira: 3_000 });
    const { body } = await ask({ accounts: [acct('brk'), acct('newira')] });
    expect(body.anchor).toMatchObject({ date: '2026-10-01', total: 10_000, missing: [] });
    expect(body.latest).toMatchObject({ total: 13_000, missing: [] });
    expect(body.accounts.find((a: any) => a.account_id === 'newira').first).toBe('2026-10-05');
  });

  test('no whole day yet: no start, and the newest day says what it misses', async () => {
    await saved('2026-10-01');
    await known('ira', '2026-09-01', 'IRA');
    await measured('2026-10-01', { brk: 10_000 }, 'partial');
    const { body } = await ask({ accounts: [acct('brk'), acct('ira')] });
    expect(body.anchor).toBeNull();
    expect(body.months).toEqual([]);
    expect(body.latest).toMatchObject({ total: 10_000, missing: ['ira'] });
  });

  test('a day damaged for good is named and left out, never read as a day with none', async () => {
    await saved('2026-10-01');
    await measured('2026-10-01', { brk: 10_000 });
    await fake.hset(ctxKey('history:accounts'), { '2026-10-02': 'not-a-ciphertext' });
    const { status, body } = await quiet(() => ask({ accounts: [acct('brk')] }));
    expect(status).toBe(200);
    expect(body.unreadable_days).toEqual(['2026-10-02']);
    expect(body.latest.date).toBe('2026-10-01');
  });
});

describe('an account that ended', () => {
  test('counts on the days before its end, whether or not the page lists it, and is never missing from then on', async () => {
    await saved('2026-09-30');
    const { markEnded } = await import('@/lib/lifecycle');
    await markEnded(ctx, 'old401k', { state: 'closed', on: '2026-10-02' }, { type: 'investment', label: { name: '401(k)', institution: 'Work', mask: null }, item_id: 'item_w', currency: 'USD' });
    await measured('2026-10-01', { brk: 10_000, old401k: 20_000 });
    await measured('2026-10-02', { brk: 30_000, old401k: 20_000 });
    const { body } = await ask({ accounts: [acct('brk')] });
    // Rolled over on Oct 2: 30,000, never 50,000.
    expect(body.anchor).toMatchObject({ date: '2026-10-01', total: 30_000, counted: 2 });
    expect(body.latest).toMatchObject({ date: '2026-10-02', total: 30_000, counted: 1, missing: [] });
    // Said, so the page can name it: in the start, and not since.
    expect(body.accounts.find((a: any) => a.account_id === 'old401k')).toMatchObject({ first: '2026-10-01', last: '2026-10-01', ended: '2026-10-02' });
    expect(body.accounts.find((a: any) => a.account_id === 'brk').ended).toBeNull();
  });
});

describe('one currency, the saved plan’s', () => {
  test('without a home currency, an account in another is left out and named, so no day is whole', async () => {
    await saved('2026-10-01');
    await measured('2026-10-01', { brk: 10_000, eur: 1_000, plain: 500 });
    const { body } = await ask({ accounts: [acct('brk'), acct('eur', 'investment', 'EUR'), acct('plain', 'investment', null)] });
    // An account that names no currency counts in the plan's, as today's figure counts it.
    expect(body.latest).toMatchObject({ total: 10_500, counted: 2, otherCurrencies: { EUR: 1 }, unrated: [] });
    expect(body.anchor).toBeNull();
  });

  test('saved with no currency of its own, only accounts that name none are summed; one that names a currency is left out and named', async () => {
    await saved('2026-10-01', { currency: null });
    await measured('2026-10-01', { plain: 500, usd: 1_000, cad: 2_000 });
    const { body } = await ask({ accounts: [acct('plain', 'investment', null), acct('usd'), acct('cad', 'investment', 'CAD')] });
    expect(body.latest).toMatchObject({ total: 500, counted: 1, otherCurrencies: { USD: 1, CAD: 1 } });
    expect(body.anchor).toBeNull();
  });

  test('with one, each currency’s subtotal converted at that day’s ECB rate', async () => {
    setSystemTime(new Date('2026-09-14T15:00:00.000Z'));
    const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
    await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'USD' } as never);
    await fake.hset(testKey('fx:ecb'), ecbHash());
    await saved('2026-09-10');
    await measured('2026-09-10', { brk: 500, eur: 1_000 });
    await measured('2026-09-11', { brk: 500, eur: 1_000 });
    const { body } = await ask({ accounts: [acct('brk'), acct('eur', 'investment', 'EUR')] });
    // 1,000 EUR at 1.1616 USD on Sep 10 and 1.1592 on Sep 11.
    expect(body.anchor).toMatchObject({ date: '2026-09-10', total: 1_661.6, counted: 2, otherCurrencies: {}, unrated: [] });
    expect(body.latest).toMatchObject({ date: '2026-09-11', total: 1_659.2, counted: 2 });
  });

  test('with one, a currency with no rate that day is left out and named', async () => {
    setSystemTime(new Date('2026-09-14T15:00:00.000Z'));
    const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
    await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'USD' } as never);
    await fake.hset(testKey('fx:ecb'), ecbHash());
    await saved('2026-09-10');
    await measured('2026-09-10', { brk: 500, ars: 1_000_000 });
    const { body } = await ask({ accounts: [acct('brk'), acct('ars', 'investment', 'ARS')] });
    expect(body.latest).toMatchObject({ total: 500, counted: 1 });
    expect(body.latest.unrated.map((u: any) => [u.currency, u.accounts])).toEqual([['ARS', 1]]);
    expect(body.anchor).toBeNull();
  });
});

describe('the question', () => {
  test('no saved plan is a 404; a malformed question a 400', async () => {
    expect((await ask({ accounts: [] })).status).toBe(404);
    await saved('2026-10-01');
    for (const body of ['nope', [], {}, { accounts: 'x' }, { accounts: [], from: '2026-01-01' }, { accounts: [{ account_id: 'a', type: 'investment' }] }, { accounts: [acct('a'), acct('a')] }, { accounts: [acct('a b')] }, { accounts: [acct('a', 'Investment!')] }]) {
      expect([body, (await ask(body)).status]).toEqual([body, 400]);
    }
  });

  test('a saved plan that can’t be read is a 409, never no plan', async () => {
    await fake.set(ctxKey('fire-plan-saved'), 'not-a-ciphertext');
    const r = await quiet(() => ask({ accounts: [acct('brk')] }));
    expect(r.status).toBe(409);
    expect(r.body.unreadable).toBe(true);
  });
});

describe('the pure series and the page’s list', () => {
  test('a day is added once, oldest first', () => {
    const s = investedSeries({ accounts: [], currency: 'USD', fx: null });
    s.add('2026-10-02', new Map());
    expect(() => s.add('2026-10-02', new Map())).toThrow();
  });

  test('the page sends every account it knows, hidden ones aside, and the ones it can’t show', () => {
    const list = progressAccountsOf([
      {
        name: 'Broker',
        item_id: 'i1',
        error: false,
        staleAsOf: null,
        staleAsOfAt: null,
        missing: 0,
        accounts: [
          { account_id: 'a', name: 'A', type: 'investment', balance: 1, currency: 'USD' },
          { account_id: 'h', name: 'H', type: 'investment', balance: 1, currency: 'USD', hidden: true },
          { account_id: 'c', name: 'C', type: 'depository', balance: null, currency: null },
        ],
        unshown: [
          { account_id: 'u', name: 'U', type: 'investment', currency: 'EUR' },
          { account_id: 'x', name: 'X', type: null, currency: null },
        ],
      },
    ]);
    expect(list).toEqual([acct('a'), acct('c', 'depository', null), acct('u', 'investment', 'EUR')]);
  });
});
