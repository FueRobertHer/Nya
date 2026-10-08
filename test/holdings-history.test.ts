import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { InstitutionResult } from '@/lib/networth';

// Holdings history (lib/holdings-history.ts): positions recorded per account
// per UTC day from the holdings every clean fetch gets, one compressed month
// per entry. It cannot be rebuilt later, so what matters most here is that a
// failed or recovered fetch never records anything, that what is recorded
// reads back exactly, and that a failure never reads as "nothing held".

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Deserializing like Upstash, as production reads.
const fake = new FakeRedis({ deserialize: true });
// Nothing may be written outside a container (#53).
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

// What Plaid answers. mock.module is process-wide, so every call
// fetchInstitution can make is stubbed.
const plaid = {
  accounts: [] as any[],
  holdings: [] as any[],
  securities: [] as any[],
  accountsFail: false,
  holdingsFail: false,
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async () => {
      if (plaid.accountsFail) throw { response: { data: { error_code: 'INSTITUTION_DOWN' } } };
      return { data: { item: { institution_id: 'ins_1' }, accounts: plaid.accounts } };
    },
    investmentsHoldingsGet: async () => {
      if (plaid.holdingsFail) throw { response: { data: { error_code: 'PRODUCTS_NOT_SUPPORTED' } } };
      return { data: { holdings: plaid.holdings, securities: plaid.securities } };
    },
    liabilitiesGet: async () => ({ data: { liabilities: {} } }),
  },
}));

const hh = await import('@/lib/holdings-history');
const {
  observeHoldings,
  withObservation,
  withoutAccount,
  isHoldingsMonth,
  recordHoldings,
  readHoldingsRange,
  readHoldingsMonth,
  readHoldingsSpan,
  forgetAccountHoldings,
} = hh;
const { recordFetch } = await import('@/lib/networth');
const { getHistory } = await import('@/lib/history');
const { snapshotData, runSnapshots, readRun } = await import('@/lib/snapshot-job');
const { encrypt } = await import('@/lib/crypto');
const { encodeJsonText } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { UnreadableEntriesError, StoredDataUnreadableError } = await import('@/lib/repo');
const { classify } = await import('@/lib/reencrypt');
const { exportLines } = await import('@/lib/export');
const { verifyArchive, restoreArchive } = await import('@/lib/restore');
const { recordDirectory, forgetEarlierAccount } = await import('@/lib/links');

const HISTORY = ctxKey('holdings:history');
const INDEX = ctxKey('holdings:history:index');

/** A Plaid security and holding, as /investments/holdings/get sends them. */
const sec = (id: string, over: Record<string, unknown> = {}) => ({
  security_id: id,
  ticker_symbol: id.toUpperCase(),
  name: `${id} fund`,
  type: 'etf',
  is_cash_equivalent: false,
  ...over,
});
const hold = (account_id: string, security_id: string, over: Record<string, unknown> = {}) => ({
  account_id,
  security_id,
  quantity: 10,
  institution_price: 100,
  institution_price_as_of: '2026-10-07',
  institution_value: 1000,
  cost_basis: 800,
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  ...over,
});

/** A fetched institution whose holdings call answered (as fetchInstitution
 *  leaves it), unless `over` says otherwise. */
function broker(accountIds: string[], holdings: any[], securities: any[], over: Partial<InstitutionResult> = {}): InstitutionResult {
  const accounts = accountIds.map((account_id) => ({ account_id, type: 'investment', balance: 1000 }));
  return {
    institution_name: 'Broker',
    item_id: 'item_b',
    accounts,
    holdings: [],
    holdings_observed: observeHoldings({ holdings, securities }, accounts),
    error: null,
    needs_reauth: false,
    liabilities: 'unavailable',
    ...over,
  };
}

const at = (iso: string) => Date.parse(iso);
/** The stored month entries, by their (random) ids, as raw text. */
const storedMonths = () => [...((fake as any).hashes.get(HISTORY)?.entries() ?? [])] as [string, string][];

const errors: unknown[][] = [];
const warnings: unknown[][] = [];
const origError = console.error;
const origWarn = console.warn;
const saved = { ...process.env };
beforeEach(() => {
  fake.reset();
  Object.assign(plaid, { accounts: [], holdings: [], securities: [], accountsFail: false, holdingsFail: false });
  errors.length = 0;
  warnings.length = 0;
  console.error = (...args: unknown[]) => void errors.push(args);
  console.warn = (...args: unknown[]) => void warnings.push(args);
});
afterEach(() => {
  console.error = origError;
  console.warn = origWarn;
  process.env = { ...saved };
});

describe('what a holdings answer records', () => {
  test("each position's Plaid fields, and each security's description", () => {
    const seen = observeHoldings(
      {
        securities: [sec('vti', { ticker_symbol: 'VTI', name: 'Vanguard Total Stock Market ETF' }), sec('btc', { type: 'cryptocurrency', ticker_symbol: 'BTC', name: null })],
        holdings: [
          hold('acct_1', 'vti', { quantity: 12.5, institution_price: 250.25, institution_value: 3128.13, cost_basis: 2000 }),
          hold('acct_1', 'btc', { iso_currency_code: null, unofficial_currency_code: 'BTC', cost_basis: null, institution_price_as_of: null }),
        ],
      },
      [{ account_id: 'acct_1', type: 'investment' }]
    );
    expect(seen).toEqual({
      accounts: {
        acct_1: [
          { security_id: 'vti', quantity: 12.5, price: 250.25, price_as_of: '2026-10-07', value: 3128.13, cost_basis: 2000, currency: 'USD' },
          { security_id: 'btc', quantity: 10, price: 100, price_as_of: null, value: 1000, cost_basis: null, currency: null, unofficial_currency: 'BTC' },
        ],
      },
      securities: {
        vti: { ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', security_type: 'etf', is_cash_equivalent: false },
        btc: { ticker: 'BTC', name: null, security_type: 'cryptocurrency', is_cash_equivalent: false },
      },
    });
  });

  test('an investment account holding nothing is seen holding nothing; a position names its own account', () => {
    const seen = observeHoldings({ securities: [sec('vti')], holdings: [hold('acct_elsewhere', 'vti')] }, [
      { account_id: 'acct_empty', type: 'investment' },
      { account_id: 'acct_old_type', type: 'brokerage' },
      { account_id: 'acct_checking', type: 'depository' },
    ]);
    expect(Object.keys(seen.accounts).sort()).toEqual(['acct_elsewhere', 'acct_empty', 'acct_old_type']);
    expect(seen.accounts.acct_empty).toEqual([]);
  });

  test('whatever the answer holds, it never throws, and records only what it can place', () => {
    expect(observeHoldings({ holdings: 'nonsense', securities: null }, [])).toEqual({ accounts: {}, securities: {} });
    expect(observeHoldings(null as any, [null as any])).toEqual({ accounts: {}, securities: {} });
    const seen = observeHoldings(
      {
        securities: [null, { security_id: '' }, sec('vti')],
        holdings: [
          null,
          hold('', 'vti'),
          hold('acct_1', ''),
          hold('__proto__', 'vti'),
          hold('acct_1', 'vti', { quantity: 'many', institution_price: Number.NaN, institution_value: Infinity, cost_basis: undefined }),
        ],
      },
      []
    );
    expect(seen.accounts).toEqual({
      acct_1: [{ security_id: 'vti', quantity: null, price: null, price_as_of: '2026-10-07', value: null, cost_basis: null, currency: 'USD' }],
    });
  });
});

describe('a month', () => {
  const seen = (positions: [string, string, number][], securities: any[] = [sec('vti'), sec('bnd'), sec('vmfxx', { type: 'cash', is_cash_equivalent: true })]) =>
    observeHoldings({ securities, holdings: positions.map(([a, s, q]) => hold(a, s, { quantity: q })) }, []);

  test('names each security once, by number, and reads in the stored shape', () => {
    const month = withObservation(null, '2026-10', '2026-10-07', '2026-10-07T13:00:00.000Z', seen([['a1', 'vti', 1], ['a1', 'bnd', 2], ['a2', 'vti', 3]]))!;
    expect(isHoldingsMonth(month)).toBe(true);
    expect(month.securities.map((s) => s.security_id)).toEqual(['vti', 'bnd']);
    expect(month.days['2026-10-07'].a2.positions.map((p) => p.security)).toEqual([0]);
    // The next day names them by the same numbers, and adds what is new.
    const next = withObservation(month, '2026-10', '2026-10-08', '2026-10-08T13:00:00.000Z', seen([['a1', 'vmfxx', 5], ['a2', 'vti', 3]]))!;
    expect(next.securities.map((s) => s.security_id)).toEqual(['vti', 'bnd', 'vmfxx']);
    expect(next.securities[2]).toEqual({ security_id: 'vmfxx', ticker: 'VMFXX', name: 'vmfxx fund', security_type: 'cash', is_cash_equivalent: true });
  });

  test('the latest observation of a day wins for each account, whatever order the writes land in', () => {
    const morning = withObservation(null, '2026-10', '2026-10-07', '2026-10-07T09:00:00.000Z', seen([['a1', 'vti', 1], ['a2', 'vti', 7]]))!;
    const noon = withObservation(morning, '2026-10', '2026-10-07', '2026-10-07T12:00:00.000Z', seen([['a1', 'bnd', 2]]))!;
    // An earlier fetch whose write lands late changes nothing.
    const late = withObservation(noon, '2026-10', '2026-10-07', '2026-10-07T10:00:00.000Z', seen([['a1', 'vti', 99]]))!;
    expect(late).toEqual(noon);
    const day = late.days['2026-10-07'];
    expect(day.a1.observed_at).toBe('2026-10-07T12:00:00.000Z');
    expect(day.a1.positions.map((p) => [late.securities[p.security].security_id, p.quantity])).toEqual([['bnd', 2]]);
    // An account the later fetch did not report keeps its own latest.
    expect(day.a2.positions.map((p) => p.quantity)).toEqual([7]);
    // A security nothing holds any more is no longer described.
    const only = withObservation(late, '2026-10', '2026-10-07', '2026-10-07T13:00:00.000Z', seen([['a2', 'bnd', 1]]))!;
    expect(only.securities.map((s) => s.security_id)).toEqual(['bnd']);
  });

  test("a security's description is the one its latest position came with, and an undescribed one reads as unknown", () => {
    const first = withObservation(null, '2026-10', '2026-10-07', '2026-10-07T09:00:00.000Z', seen([['a1', 'vti', 1]], [sec('vti', { name: 'Old name' })]))!;
    const renamed = withObservation(first, '2026-10', '2026-10-08', '2026-10-08T09:00:00.000Z', seen([['a1', 'vti', 1]], [sec('vti', { name: 'New name' })]))!;
    expect(renamed.securities[0].name).toBe('New name');
    // Plaid leaving it out of a later answer keeps what is known.
    const silent = withObservation(renamed, '2026-10', '2026-10-09', '2026-10-09T09:00:00.000Z', seen([['a1', 'vti', 1]], []))!;
    expect(silent.securities[0].name).toBe('New name');
    const never = withObservation(null, '2026-10', '2026-10-07', '2026-10-07T09:00:00.000Z', seen([['a1', 'xyz', 1]], []))!;
    expect(never.securities).toEqual([{ security_id: 'xyz', ticker: null, name: null, security_type: null, is_cash_equivalent: null }]);
  });

  test('an entry holding another month is refused, never mixed in', () => {
    const october = withObservation(null, '2026-10', '2026-10-07', '2026-10-07T09:00:00.000Z', seen([['a1', 'vti', 1]]))!;
    expect(() => withObservation(october, '2026-11', '2026-11-01', '2026-11-01T09:00:00.000Z', seen([['a1', 'vti', 1]]))).toThrow();
  });

  test('without an account: its days, and the securities only it held; nothing left is null', () => {
    let month = withObservation(null, '2026-10', '2026-10-07', '2026-10-07T09:00:00.000Z', seen([['a1', 'vti', 1], ['a1', 'bnd', 1], ['a2', 'vti', 2]]))!;
    month = withObservation(month, '2026-10', '2026-10-08', '2026-10-08T09:00:00.000Z', seen([['a1', 'bnd', 1]]))!;
    const rest = withoutAccount(month, 'a1')!;
    expect(isHoldingsMonth(rest)).toBe(true);
    expect(Object.keys(rest.days)).toEqual(['2026-10-07']);
    expect(rest.securities.map((s) => s.security_id)).toEqual(['vti']);
    expect(rest.days['2026-10-07'].a2.positions).toEqual([expect.objectContaining({ security: 0, quantity: 2 })]);
    expect(withoutAccount(rest, 'a2')).toBeNull();
  });

  test('the stored shape is checked strictly', () => {
    const month = withObservation(null, '2026-10', '2026-10-07', '2026-10-07T09:00:00.000Z', seen([['a1', 'vti', 1]]))!;
    const broken = (f: (m: any) => void) => {
      const copy = structuredClone(month) as any;
      f(copy);
      return isHoldingsMonth(copy);
    };
    expect(broken(() => {})).toBe(true);
    expect(broken((m) => (m.v = 2))).toBe(false);
    expect(broken((m) => (m.month = '2026-13'))).toBe(false);
    expect(broken((m) => (m.days['2026-11-01'] = {}))).toBe(false); // a day of another month
    expect(broken((m) => (m.days['2026-10-07'].a1.positions[0].security = 1))).toBe(false); // no such security
    expect(broken((m) => (m.days['2026-10-07'].a1.positions[0].quantity = '1'))).toBe(false);
    expect(broken((m) => (m.days['2026-10-07'].a1.observed_at = 'yesterday'))).toBe(false);
    expect(broken((m) => m.securities.push({ ...m.securities[0] }))).toBe(false); // named twice
  });
});

describe('recording', () => {
  test('a clean fetch records each position under the UTC day, read back with its description', async () => {
    const now = at('2026-10-07T13:00:05.000Z');
    const result = await recordHoldings(ctx, [broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')])], now);
    expect(result).toEqual({ recorded: 1, failed: 0 });
    expect(await readHoldingsRange(ctx, '2026-10-01', '2026-10-31')).toEqual([
      {
        date: '2026-10-07',
        accounts: [
          {
            account_id: 'acct_1',
            recorded_as: 'acct_1',
            observed_at: '2026-10-07T13:00:05.000Z',
            positions: [
              {
                security_id: 'vti',
                ticker: 'VTI',
                name: 'vti fund',
                security_type: 'etf',
                is_cash_equivalent: false,
                quantity: 10,
                price: 100,
                price_as_of: '2026-10-07',
                value: 1000,
                cost_basis: 800,
                currency: 'USD',
              },
            ],
          },
        ],
      },
    ]);
  });

  test('kept encrypted and compressed, under random ids, never the month', async () => {
    await recordHoldings(ctx, [broker(['acct_secret'], [hold('acct_secret', 'vti')], [sec('vti', { name: 'Secret Fund' })])], at('2026-10-07T13:00:00Z'));
    const months = storedMonths();
    expect(months).toHaveLength(1);
    const [id, stored] = months[0];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const text of [stored, ...((fake as any).hashes.get(INDEX)?.values() ?? [])]) {
      for (const plain of ['acct_secret', 'Secret Fund', '2026-10', 'VTI']) expect(text).not.toContain(plain);
    }
    expect([...(fake as any).hashes.get(INDEX).keys()]).toEqual(['index']);
  });

  test('an institution whose fetch failed, or whose holdings call failed, records nothing', async () => {
    const failed = broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')], { error: 'Could not fetch balances' });
    // Its holdings call failed: fetchHoldings leaves no observation, never an
    // empty one, so its accounts are not recorded as holding nothing.
    const noHoldings = broker(['acct_2'], [], [], { holdings_observed: undefined });
    expect(await recordHoldings(ctx, [failed, noHoldings], at('2026-10-07T13:00:00Z'))).toEqual({ recorded: 0, failed: 0 });
    expect(fake.hashes.size).toBe(0);
  });

  test('never what was recovered from an earlier snapshot, nor a manual account', async () => {
    const recovered = broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')]);
    recovered.accounts[0].stale = true;
    const manual = broker(['manual_x'], [hold('manual_x', 'vti')], [sec('vti')], { manual: true });
    const fresh = broker(['acct_2'], [hold('acct_2', 'vti')], [sec('vti')]);
    expect(await recordHoldings(ctx, [recovered, manual, fresh], at('2026-10-07T13:00:00Z'))).toEqual({ recorded: 1, failed: 0 });
    const [day] = await readHoldingsRange(ctx, '2026-10-07', '2026-10-07');
    expect(day.accounts.map((a) => a.account_id)).toEqual(['acct_2']);
  });

  // It answered, short an account: what it did return is real, as its
  // balances are (measuredBalanceMap), and an account seen holding nothing is
  // recorded as that.
  test('an institution missing an account still records the accounts it returned', async () => {
    const short = broker(['acct_1', 'acct_empty'], [hold('acct_1', 'vti')], [sec('vti')], { unconfirmed_missing: 1 });
    expect(await recordHoldings(ctx, [short], at('2026-10-07T13:00:00Z'))).toEqual({ recorded: 2, failed: 0 });
    const [day] = await readHoldingsRange(ctx, '2026-10-07', '2026-10-07');
    expect(day.accounts.map((a) => [a.account_id, a.positions.length])).toEqual([
      ['acct_1', 1],
      ['acct_empty', 0],
    ]);
  });

  test('a fetch with no investment account touches no storage', async () => {
    const bank = { ...broker([], [], []), holdings_observed: undefined, accounts: [{ account_id: 'chk', type: 'depository', balance: 5 }] };
    const ops = fake.ops;
    expect(await recordHoldings(ctx, [bank], at('2026-10-07T13:00:00Z'))).toEqual({ recorded: 0, failed: 0 });
    expect(fake.ops).toBe(ops);
  });

  // The real net-worth layer's convention (lib/history.ts): the UTC date of
  // the moment it is recorded, whatever the server's time zone.
  test('the UTC day decides the date and the month, across a month boundary', async () => {
    const seen = (q: number) => [broker(['acct_1'], [hold('acct_1', 'vti', { quantity: q })], [sec('vti')])];
    await recordHoldings(ctx, seen(1), at('2026-10-31T23:59:59.999Z'));
    await recordHoldings(ctx, seen(2), at('2026-11-01T00:00:00.000Z'));
    expect(storedMonths()).toHaveLength(2);
    const both = await readHoldingsRange(ctx, '2026-10-01', '2026-11-30');
    expect(both.map((d) => [d.date, d.accounts[0].positions[0].quantity])).toEqual([
      ['2026-10-31', 1],
      ['2026-11-01', 2],
    ]);
    expect((await readHoldingsMonth(ctx, '2026-10')).map((d) => d.date)).toEqual(['2026-10-31']);
    expect((await readHoldingsMonth(ctx, '2026-11')).map((d) => d.date)).toEqual(['2026-11-01']);
    expect(await readHoldingsRange(ctx, '2026-11-02', '2026-12-31')).toEqual([]);
    expect(await readHoldingsSpan(ctx)).toEqual({ first: '2026-10-31', last: '2026-11-01' });
  });

  test('the same day as the net-worth snapshot recorded beside it', async () => {
    const { date } = await recordFetch(ctx, [broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')])], 1000);
    expect(date).not.toBeNull();
    expect((await readHoldingsRange(ctx, date!, date!)).map((d) => d.date)).toEqual([date!]);
  });

  test('stored, the latest observation of a day wins, and the next day is its own', async () => {
    const seen = (q: number) => [broker(['acct_1'], [hold('acct_1', 'vti', { quantity: q })], [sec('vti')])];
    await recordHoldings(ctx, seen(10), at('2026-10-07T10:00:00Z'));
    await recordHoldings(ctx, seen(9), at('2026-10-07T09:00:00Z')); // an earlier fetch, landing late
    expect((await readHoldingsMonth(ctx, '2026-10'))[0].accounts[0].positions[0].quantity).toBe(10);
    await recordHoldings(ctx, seen(11), at('2026-10-07T11:00:00Z'));
    await recordHoldings(ctx, seen(12), at('2026-10-08T01:00:00Z'));
    expect((await readHoldingsMonth(ctx, '2026-10')).map((d) => [d.date, d.accounts[0].observed_at, d.accounts[0].positions[0].quantity])).toEqual([
      ['2026-10-07', '2026-10-07T11:00:00.000Z', 11],
      ['2026-10-08', '2026-10-08T01:00:00.000Z', 12],
    ]);
  });

  test('recordings at once, starting a month, agree on one entry and all land', async () => {
    const results = await Promise.all(
      ['acct_1', 'acct_2', 'acct_3'].map((id, i) =>
        recordHoldings(ctx, [broker([id], [hold(id, 'vti', { quantity: i + 1 })], [sec('vti')])], at(`2026-10-07T13:00:0${i}Z`))
      )
    );
    expect(results.every((r) => r.failed === 0)).toBe(true);
    expect(storedMonths()).toHaveLength(1);
    const [day] = await readHoldingsMonth(ctx, '2026-10');
    expect(day.accounts.map((a) => [a.account_id, a.positions[0].quantity])).toEqual([
      ['acct_1', 1],
      ['acct_2', 2],
      ['acct_3', 3],
    ]);
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_3' })).toEqual({ first: '2026-10-07', last: '2026-10-07' });
  });

  test('hidden accounts are recorded like every other, and left out on read when asked', async () => {
    await recordHoldings(ctx, [broker(['acct_shown', 'acct_hidden'], [hold('acct_shown', 'vti'), hold('acct_hidden', 'vti')], [sec('vti')])], at('2026-10-07T13:00:00Z'));
    const all = await readHoldingsRange(ctx, '2026-10-07', '2026-10-07');
    expect(all[0].accounts.map((a) => a.account_id)).toEqual(['acct_hidden', 'acct_shown']);
    const hidden = new Set(['acct_hidden']);
    const shown = await readHoldingsRange(ctx, '2026-10-07', '2026-10-07', { hidden });
    expect(shown[0].accounts.map((a) => a.account_id)).toEqual(['acct_shown']);
    expect(await readHoldingsRange(ctx, '2026-10-07', '2026-10-07', { hidden, accountId: 'acct_hidden' })).toEqual([]);
    expect(await readHoldingsSpan(ctx, { hidden, accountId: 'acct_hidden' })).toEqual({ first: null, last: null });
  });
});

describe('a month that would not fit', () => {
  test('is refused whole and loudly: the earlier days stay as they were, and nothing is trimmed', async () => {
    const seen = (n: number) => [
      broker(
        ['acct_1'],
        Array.from({ length: n }, (_, i) => hold('acct_1', `sec_${i}`, { quantity: i })),
        Array.from({ length: n }, (_, i) => sec(`sec_${i}`))
      ),
    ];
    await recordHoldings(ctx, seen(2), at('2026-10-07T13:00:00Z'));
    const before = storedMonths();
    process.env.MAX_TXN_BLOB_CHARS = '3000';
    expect(await recordHoldings(ctx, seen(300), at('2026-10-08T13:00:00Z'))).toEqual({ recorded: 0, failed: 1 });
    expect(storedMonths()).toEqual(before);
    expect(errors.some((e) => String(e[0]).includes('refusing to save holdings:history'))).toBe(true);
    expect(errors.some((e) => String(e[0]).includes('holdings-history: the positions of 1 account(s) could not be recorded'))).toBe(true);
    // Logged by counts and container, never by account.
    expect(errors.flat().some((e) => String(e).includes('acct_1'))).toBe(false);
    delete process.env.MAX_TXN_BLOB_CHARS;
    const days = await readHoldingsMonth(ctx, '2026-10');
    expect(days.map((d) => [d.date, d.accounts[0].positions.length])).toEqual([['2026-10-07', 2]]);
  });

  test('a month stays far below the ceiling for a realistic portfolio, and for a large one', async () => {
    // Prices move every day and quantities now and then, as a month of real
    // holdings does; ids are as long and as random as Plaid's.
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const id = () => Array.from({ length: 37 }, () => alnum[Math.floor(rand() * alnum.length)]).join('');
    const month = async (accounts: number, per: number) => {
      const accts = Array.from({ length: accounts }, () => ({ account_id: id(), type: 'investment' }));
      const positions = accts.flatMap((a) =>
        Array.from({ length: per }, () => ({ a: a.account_id, s: id(), q: Math.round(rand() * 1e5) / 1e3, p: Math.round(rand() * 5e4) / 100, cb: Math.round(rand() * 2e6) / 100 }))
      );
      const securities = positions.map((p) => sec(p.s, { ticker_symbol: p.s.slice(0, 4).toUpperCase(), name: `Fund ${p.s.slice(0, 12)}` }));
      let value = null;
      for (let d = 1; d <= 31; d++) {
        const date = `2026-10-${String(d).padStart(2, '0')}`;
        const holdings = positions.map((p) => {
          p.p = Math.round(p.p * (1 + (rand() - 0.5) * 0.04) * 100) / 100;
          if (rand() < 0.03) p.q = Math.round((p.q + rand()) * 1000) / 1000;
          return hold(p.a, p.s, { quantity: p.q, institution_price: p.p, institution_value: Math.round(p.p * p.q * 100) / 100, cost_basis: p.cb, institution_price_as_of: date });
        });
        value = withObservation(value, '2026-10', date, `${date}T13:00:05.123Z`, observeHoldings({ holdings, securities }, accts));
      }
      return (await encodeJsonText(JSON.stringify(value))).length;
    };
    // The numbers lib/holdings-history.ts and docs/architecture.md give.
    const ceiling = 8 * 1024 * 1024;
    const realistic = await month(4, 15); // about 48,000 characters: 0.6%
    expect(realistic).toBeLessThan(ceiling * 0.01);
    const large = await month(10, 100); // about 1,330,000: 16%
    expect(large).toBeLessThan(ceiling * 0.2);
  });
});

describe('strict reads', () => {
  async function recorded() {
    await recordHoldings(ctx, [broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')])], at('2026-10-07T13:00:00Z'));
    return storedMonths()[0][0];
  }

  test('a damaged month is named as unreadable, never read as nothing held', async () => {
    const id = await recorded();
    await fake.hset(HISTORY, { [id]: 'not ciphertext at all' });
    const err = await readHoldingsRange(ctx, '2026-10-01', '2026-10-31').catch((e) => e);
    expect(err).toBeInstanceOf(UnreadableEntriesError);
    expect([err.unreadable, err.unrecognised]).toEqual([[id], []]);
    expect(err.message).toBe('Your saved holdings records could not be read, so they were left untouched.');
    // And a recording over it is refused, leaving it exactly as it is.
    expect(await recordHoldings(ctx, [broker(['acct_1'], [], [])], at('2026-10-08T13:00:00Z'))).toEqual({ recorded: 0, failed: 1 });
    expect(await fake.hget<string>(HISTORY, id)).toBe('not ciphertext at all');
  });

  test('an intact month this code does not understand is unrecognised, never offered for removal', async () => {
    const id = await recorded();
    await fake.hset(HISTORY, { [id]: await encodeJsonText(JSON.stringify({ v: 2, month: '2026-10' })) });
    const err = await readHoldingsMonth(ctx, '2026-10').catch((e) => e);
    expect(err).toBeInstanceOf(UnreadableEntriesError);
    expect([err.unreadable, err.unrecognised]).toEqual([[], [id]]);
  });

  test('a month stored under another month\'s id is unrecognised, not read as that month', async () => {
    const id = await recorded();
    const other = withObservation(null, '2026-09', '2026-09-30', '2026-09-30T13:00:00.000Z', observeHoldings({ holdings: [hold('acct_1', 'vti')] }, []));
    await fake.hset(HISTORY, { [id]: await encodeJsonText(JSON.stringify(other)) });
    const err = await readHoldingsRange(ctx, '2026-09-01', '2026-10-31').catch((e) => e);
    expect(err).toBeInstanceOf(UnreadableEntriesError);
    expect(err.unrecognised).toEqual([id]);
  });

  test('an unreadable index fails every read, the span included', async () => {
    await recorded();
    await fake.hset(INDEX, { index: await encrypt('{"v":1}') });
    for (const read of [() => readHoldingsRange(ctx, '2026-10-01', '2026-10-31'), () => readHoldingsSpan(ctx)]) {
      expect(await read().catch((e) => e)).toBeInstanceOf(StoredDataUnreadableError);
    }
  });

  test('storage that cannot be reached is an error, never an empty history', async () => {
    await recorded();
    fake.failNext('eval');
    expect(await readHoldingsRange(ctx, '2026-10-01', '2026-10-31').catch((e) => e)).toBeInstanceOf(Error);
    fake.failNext('eval');
    expect(await readHoldingsSpan(ctx).catch((e) => e)).toBeInstanceOf(Error);
  });

  test('nothing recorded reads as nothing', async () => {
    expect(await readHoldingsRange(ctx, '2026-10-01', '2026-10-31')).toEqual([]);
    expect(await readHoldingsSpan(ctx)).toEqual({ first: null, last: null });
  });
});

describe('account links', () => {
  // acct_old was the account before a reconnect, acct_new after; both
  // recorded acct_new's first day, which the current id must win.
  async function history() {
    const seen = (id: string, q: number) => [broker([id], [hold(id, 'vti', { quantity: q })], [sec('vti')])];
    await recordHoldings(ctx, seen('acct_old', 1), at('2026-10-05T13:00:00Z'));
    await recordHoldings(ctx, seen('acct_old', 2), at('2026-10-06T13:00:00Z'));
    await recordHoldings(ctx, seen('acct_new', 3), at('2026-10-06T14:00:00Z'));
    await recordHoldings(ctx, seen('acct_new', 4), at('2026-10-07T13:00:00Z'));
  }
  const links = new Map([['acct_old', { to: 'acct_new', linked_at: '2026-10-08T00:00:00.000Z', evidence: { old_last: '2026-10-06' } }]]);
  const shape = (days: Awaited<ReturnType<typeof readHoldingsRange>>) =>
    days.map((d) => [d.date, d.accounts.map((a) => `${a.account_id}<${a.recorded_as}:${a.positions[0].quantity}`)]);

  test("an earlier id's positions continue under the current one, and the current id wins a shared day", async () => {
    await history();
    expect(shape(await readHoldingsRange(ctx, '2026-10-01', '2026-10-31', { links }))).toEqual([
      ['2026-10-05', ['acct_new<acct_old:1']],
      ['2026-10-06', ['acct_new<acct_new:3']],
      ['2026-10-07', ['acct_new<acct_new:4']],
    ]);
    expect(shape(await readHoldingsRange(ctx, '2026-10-01', '2026-10-31', { links, accountId: 'acct_new' }))).toEqual([
      ['2026-10-05', ['acct_new<acct_old:1']],
      ['2026-10-06', ['acct_new<acct_new:3']],
      ['2026-10-07', ['acct_new<acct_new:4']],
    ]);
    expect(await readHoldingsSpan(ctx, { links, accountId: 'acct_new' })).toEqual({ first: '2026-10-05', last: '2026-10-07' });
  });

  test('unlinked, each id is its own account', async () => {
    await history();
    expect(shape(await readHoldingsRange(ctx, '2026-10-01', '2026-10-31'))).toEqual([
      ['2026-10-05', ['acct_old<acct_old:1']],
      ['2026-10-06', ['acct_new<acct_new:3', 'acct_old<acct_old:2']],
      ['2026-10-07', ['acct_new<acct_new:4']],
    ]);
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_new' })).toEqual({ first: '2026-10-06', last: '2026-10-07' });
  });

  test('hiding the account hides every id it had', async () => {
    await history();
    // As getEffectiveHidden expands it across links.
    const hidden = new Set(['acct_new', 'acct_old']);
    expect(await readHoldingsRange(ctx, '2026-10-01', '2026-10-31', { links, hidden })).toEqual([]);
  });
});

describe('forgetting an account', () => {
  async function twoMonths() {
    const day = (iso: string, q: number) =>
      recordHoldings(
        ctx,
        [broker(['acct_gone', 'acct_kept'], [hold('acct_gone', 'only_gone', { quantity: q }), hold('acct_gone', 'vti'), hold('acct_kept', 'vti', { quantity: q })], [sec('only_gone'), sec('vti')])],
        at(iso)
      );
    await day('2026-09-30T13:00:00Z', 1);
    await day('2026-10-01T13:00:00Z', 2);
    // A month only the forgotten account was recorded in.
    await recordHoldings(ctx, [broker(['acct_gone'], [hold('acct_gone', 'vti')], [sec('vti')])], at('2026-08-15T13:00:00Z'));
  }

  test('removes its positions from every month, and what only it held, and keeps the rest', async () => {
    await twoMonths();
    expect(await forgetAccountHoldings(ctx, 'acct_gone')).toEqual({ changed: 3, unreadableMonths: [] });
    const days = await readHoldingsRange(ctx, '2026-08-01', '2026-10-31');
    expect(days.map((d) => [d.date, d.accounts.map((a) => a.account_id)])).toEqual([
      ['2026-09-30', ['acct_kept']],
      ['2026-10-01', ['acct_kept']],
    ]);
    // Nothing anywhere names it, or the security only it held.
    for (const [, stored] of storedMonths()) {
      const value = JSON.parse(await (await import('@/lib/blob')).decryptJsonText(stored));
      expect(JSON.stringify(value)).not.toContain('acct_gone');
      expect(JSON.stringify(value)).not.toContain('only_gone');
    }
    // August held only it: its entry is gone.
    expect(storedMonths()).toHaveLength(2);
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_gone' })).toEqual({ first: null, last: null });
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_kept' })).toEqual({ first: '2026-09-30', last: '2026-10-01' });
    // And August can still be recorded again, under the place it had.
    await recordHoldings(ctx, [broker(['acct_kept'], [hold('acct_kept', 'vti')], [sec('vti')])], at('2026-08-16T13:00:00Z'));
    expect((await readHoldingsMonth(ctx, '2026-08')).map((d) => d.date)).toEqual(['2026-08-16']);
    expect(storedMonths()).toHaveLength(3);
  });

  test('a forget that stops part way is finished by running it again', async () => {
    await twoMonths();
    const evalOrig = fake.eval.bind(fake);
    let writes = 0;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:repo-update-entry') && keys[0] === HISTORY && ++writes === 2) throw new Error('down');
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    try {
      expect(await forgetAccountHoldings(ctx, 'acct_gone').catch((e) => e)).toBeInstanceOf(Error);
    } finally {
      fake.eval = evalOrig;
    }
    // One month is done; the rest still hold it.
    expect((await readHoldingsRange(ctx, '2026-08-01', '2026-10-31', { accountId: 'acct_gone' })).length).toBeGreaterThan(0);
    expect(await forgetAccountHoldings(ctx, 'acct_gone')).toEqual({ changed: 2, unreadableMonths: [] });
    expect(await readHoldingsRange(ctx, '2026-08-01', '2026-10-31', { accountId: 'acct_gone' })).toEqual([]);
    expect(await forgetAccountHoldings(ctx, 'acct_gone')).toEqual({ changed: 0, unreadableMonths: [] });
  });

  test('a damaged month is left as it is and reported; an unrecognised one stops it', async () => {
    await twoMonths();
    const index = JSON.parse(await (await import('@/lib/crypto')).decrypt((await fake.hget<string>(INDEX, 'index'))!));
    await fake.hset(HISTORY, { [index.months['2026-09']]: 'damaged' });
    expect(await forgetAccountHoldings(ctx, 'acct_gone')).toEqual({ changed: 2, unreadableMonths: ['2026-09'] });
    expect(await fake.hget<string>(HISTORY, index.months['2026-09'])).toBe('damaged');

    fake.reset();
    await twoMonths();
    const again = JSON.parse(await (await import('@/lib/crypto')).decrypt((await fake.hget<string>(INDEX, 'index'))!));
    const unknown = await encodeJsonText(JSON.stringify({ v: 9 }));
    await fake.hset(HISTORY, { [again.months['2026-09']]: unknown });
    const err = await forgetAccountHoldings(ctx, 'acct_gone').catch((e) => e);
    expect(err).toBeInstanceOf(UnreadableEntriesError);
    expect(err.unrecognised).toEqual([again.months['2026-09']]);
    expect(await fake.hget<string>(HISTORY, again.months['2026-09'])).toBe(unknown);
  });

  test('the second pass touches only the recent months', async () => {
    await twoMonths();
    expect(await forgetAccountHoldings(ctx, 'acct_gone', { recent: true, now: at('2026-10-01T12:00:00Z') })).toEqual({ changed: 2, unreadableMonths: [] });
    expect((await readHoldingsMonth(ctx, '2026-08', { accountId: 'acct_gone' })).length).toBe(1);
  });

  test('forgetting an earlier account takes its holdings history with it', async () => {
    await twoMonths();
    // Known to the directory from an institution since disconnected (no
    // stored Item): an earlier account that can be forgotten.
    await recordDirectory(ctx, [
      { item_id: 'item_gone', institution_name: 'Broker', error: null, accounts: [{ account_id: 'acct_gone', type: 'investment', subtype: 'ira' }] },
    ]);
    const result = await forgetEarlierAccount(ctx, 'acct_gone');
    expect(result.unreadableHoldingsMonths).toEqual([]);
    expect(await readHoldingsRange(ctx, '2026-08-01', '2026-10-31', { accountId: 'acct_gone' })).toEqual([]);
    expect((await readHoldingsRange(ctx, '2026-08-01', '2026-10-31', { accountId: 'acct_kept' })).length).toBe(2);
  });
});

describe('beside the net-worth snapshot', () => {
  // One investment Item, linked and answering.
  async function linked() {
    await registerTestContainer(fake);
    await saveItem(ctx, { item_id: 'item_b', institution_name: 'Broker', encrypted_access_token: await encrypt('tok') });
    plaid.accounts = [{ account_id: 'acct_ira', name: 'IRA', type: 'investment', subtype: 'ira', balances: { current: 1000, iso_currency_code: 'USD' } }];
    plaid.holdings = [hold('acct_ira', 'vti')];
    plaid.securities = [sec('vti')];
  }
  const today = () => new Date().toISOString().slice(0, 10);

  test('the nightly snapshot records the positions its fetch got', async () => {
    await linked();
    expect(await snapshotData(ctx)).toEqual({ status: 'recorded' });
    const [day] = await readHoldingsRange(ctx, today(), today());
    expect(day.accounts.map((a) => [a.account_id, a.positions.map((p) => p.ticker)])).toEqual([['acct_ira', ['VTI']]]);
  });

  test('a holdings call that fails records nothing, and the snapshot is recorded as ever', async () => {
    await linked();
    plaid.holdingsFail = true;
    expect(await snapshotData(ctx)).toEqual({ status: 'recorded' });
    expect(fake.hashes.has(HISTORY)).toBe(false);
    expect(await readHoldingsSpan(ctx)).toEqual({ first: null, last: null });
  });

  test('an institution that fails records nothing', async () => {
    await linked();
    plaid.accountsFail = true;
    expect((await snapshotData(ctx)).status).toBe('unclean');
    expect(fake.hashes.has(HISTORY)).toBe(false);
  });

  test('a holdings write that fails never changes the snapshot: it is counted beside it', async () => {
    await linked();
    const evalOrig = fake.eval.bind(fake);
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:repo-')) throw new Error('down');
      return evalOrig(script, keys, args);
    }) as typeof fake.eval;
    let report;
    try {
      report = await runSnapshots([{ id: ctx.container, status: 'active', primary: true, created_at: 'x' }], { scheduledFor: today() });
    } finally {
      fake.eval = evalOrig;
    }
    expect(report.results).toEqual([{ container: ctx.container, status: 'recorded', holdings_failed: 1, ms: expect.any(Number) }]);
    expect(await readRun(ctx, today())).toMatchObject({ status: 'recorded', holdings_failed: 1 });
    // The net worth landed regardless.
    expect((await getHistory(ctx)).map((p) => p.date)).toEqual([today()]);
    expect(errors.some((e) => String(e[0]).includes('holdings-history: the positions of 1 account(s)'))).toBe(true);
  });

  test('and recordFetch reports both, the total never waiting on the positions', async () => {
    const result = await recordFetch(ctx, [broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')])], 1000);
    expect(result).toEqual({ date: today(), holdings: { recorded: 1, failed: 0 } });
  });
});

describe('backups and the key inventory', () => {
  test('both stores are classified, exported and restored by construction', async () => {
    await registerTestContainer(fake);
    await recordHoldings(ctx, [broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')])], at('2026-10-07T13:00:00Z'));
    const c = `c:${ctx.container}:`;
    expect(classify(`${c}holdings:history`)).toBe('hash');
    expect(classify(`${c}holdings:history:index`)).toBe('hash');

    let text = '';
    for await (const line of exportLines(fake as any)) text += line;
    const archive = verifyArchive(text);
    expect(archive.records.map((r) => r.key)).toEqual(expect.arrayContaining([`${c}holdings:history`, `${c}holdings:history:index`]));

    const before = await readHoldingsRange(ctx, '2026-10-01', '2026-10-31');
    fake.reset();
    await restoreArchive(fake as any, archive, { overwrite: false });
    expect(await readHoldingsRange(ctx, '2026-10-01', '2026-10-31')).toEqual(before);
  });

  test('everything is kept inside the container, which deleting the account sweeps', async () => {
    await recordHoldings(ctx, [broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')])], at('2026-10-07T13:00:00Z'));
    const keys = [...(fake as any).hashes.keys(), ...(fake as any).strings.keys()];
    expect(keys.sort()).toEqual([HISTORY, INDEX].sort());
    for (const key of keys) expect(key.startsWith(ctxKey(''))).toBe(true);
  });
});
