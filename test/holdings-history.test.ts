import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { InstitutionResult } from '@/lib/networth';

// Holdings history (lib/holdings-history.ts): positions recorded per account
// per UTC day from the holdings every clean fetch gets, one compressed month
// per entry. It cannot be rebuilt later, so what matters most here is that a
// failed, recovered or partial answer never records anything, that what is
// recorded reads back exactly, that a failure never reads as "nothing held",
// and that what can't be read never stops forgetting an account it can't
// hold, nor stops recording without a word.

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
  /** The holdings answer's own list of accounts, when it isn't the balance
   *  call's. */
  holdingsAccounts: null as any[] | null,
  /** A whole holdings answer to send instead, for one that is not whole. */
  holdingsAnswer: null as any,
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
      if (plaid.holdingsAnswer) return { data: plaid.holdingsAnswer };
      return { data: { accounts: plaid.holdingsAccounts ?? plaid.accounts, holdings: plaid.holdings, securities: plaid.securities } };
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
  isHoldingsIndex,
  recordHoldings,
  readHoldingsHistory,
  readHoldingsRange,
  readHoldingsMonth,
  readHoldingsSpan,
  forgetAccountHoldings,
  forgetRecentHoldings,
  repairHoldingsIndex,
} = hh;
const { recordFetch } = await import('@/lib/networth');
const { getHistory } = await import('@/lib/history');
const { snapshotData, runSnapshots, readRun } = await import('@/lib/snapshot-job');
const { encrypt, decrypt } = await import('@/lib/crypto');
const { encodeJsonText, decryptJsonText } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { UnreadableEntriesError, StoredDataUnreadableError, StoreRefusedError, UpdateConflictError } = await import('@/lib/repo');
const { classify } = await import('@/lib/reencrypt');
const { exportLines } = await import('@/lib/export');
const { verifyArchive, restoreArchive } = await import('@/lib/restore');
const { recordDirectory, forgetEarlierAccount, linkAccounts } = await import('@/lib/links');
const { setAccountHidden } = await import('@/lib/hidden');
const { forgetEpochs } = await import('@/lib/sessions');
const historyRoute = await import('@/app/api/holdings-history/route');
const linksRoute = await import('@/app/api/account-links/route');
const netWorthRoute = await import('@/app/api/net-worth/route');

const HISTORY = ctxKey('holdings:history');
const INDEX = ctxKey('holdings:history:index');
const DIRECTORY = ctxKey('accounts:directory');

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
const investment = (account_id: string) => ({ account_id, type: 'investment' });

/** A fetched institution whose holdings call answered (as fetchInstitution
 *  leaves it), unless `over` says otherwise. The answer lists the accounts. */
function broker(accountIds: string[], holdings: any[], securities: any[], over: Partial<InstitutionResult> = {}): InstitutionResult {
  const accounts = accountIds.map((account_id) => ({ account_id, type: 'investment', balance: 1000 }));
  return {
    institution_name: 'Broker',
    item_id: 'item_b',
    accounts,
    holdings: [],
    holdings_observed: observeHoldings({ accounts, holdings, securities }) ?? undefined,
    error: null,
    needs_reauth: false,
    liabilities: 'unavailable',
    ...over,
  };
}

const at = (iso: string) => Date.parse(iso);
/** When an account was recorded, as the reads answer it. */
const span = (first: string | null, last: string | null, first_at: string | null = null, last_at: string | null = null) => ({ first, last, first_at, last_at });
/** The stored month entries, by their (random) ids, as raw text. */
const storedMonths = () => [...((fake as any).hashes.get(HISTORY)?.entries() ?? [])] as [string, string][];
/** The index as stored, decrypted. */
const storedIndex = async () => JSON.parse(await decrypt((await fake.hget<string>(INDEX, 'index'))!));
/** Whether any stored month names the account, read past the seam. */
const anyMonthNames = async (account: string) => {
  for (const [, stored] of storedMonths()) if ((await decryptJsonText(stored)).includes(account)) return true;
  return false;
};
/** A value this version does not recognise, as a later version might write. */
const later = (value: unknown) => encodeJsonText(JSON.stringify(value));

const errors: unknown[][] = [];
const warnings: unknown[][] = [];
const origError = console.error;
const origWarn = console.warn;
const origEval = fake.eval;
const saved = { ...process.env };
beforeEach(() => {
  fake.reset();
  // The default ceiling, whatever a file run before this one left set
  // (test/transactions.test.ts lowers it for the whole run).
  delete process.env.MAX_TXN_BLOB_CHARS;
  Object.assign(plaid, { accounts: [], holdings: [], securities: [], holdingsAccounts: null, holdingsAnswer: null, accountsFail: false, holdingsFail: false });
  errors.length = 0;
  warnings.length = 0;
  console.error = (...args: unknown[]) => void errors.push(args);
  console.warn = (...args: unknown[]) => void warnings.push(args);
});
afterEach(() => {
  console.error = origError;
  console.warn = origWarn;
  fake.eval = origEval;
  process.env = { ...saved };
});

describe('what a holdings answer records', () => {
  test("each position's Plaid fields, and each security's description", () => {
    const seen = observeHoldings({
      accounts: [investment('acct_1')],
      securities: [sec('vti', { ticker_symbol: 'VTI', name: 'Vanguard Total Stock Market ETF' }), sec('btc', { type: 'cryptocurrency', ticker_symbol: 'BTC', name: null })],
      holdings: [
        hold('acct_1', 'vti', { quantity: 12.5, institution_price: 250.25, institution_value: 3128.13, cost_basis: 2000 }),
        hold('acct_1', 'btc', { iso_currency_code: null, unofficial_currency_code: 'BTC', cost_basis: null, institution_price_as_of: null }),
      ],
    });
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

  // The answer's own list, not the balance call's: an empty list then means
  // the answer spoke for the account and listed nothing.
  test('an investment account the answer lists with no positions is seen holding nothing; a position names its own account', () => {
    const seen = observeHoldings({
      accounts: [investment('acct_empty'), { account_id: 'acct_old_type', type: 'brokerage' }, { account_id: 'acct_checking', type: 'depository' }],
      securities: [sec('vti')],
      holdings: [hold('acct_elsewhere', 'vti')],
    })!;
    expect(Object.keys(seen.accounts).sort()).toEqual(['acct_elsewhere', 'acct_empty', 'acct_old_type']);
    expect(seen.accounts.acct_empty).toEqual([]);
    // An answer that lists no account says nothing about any.
    expect(observeHoldings({ holdings: [], securities: [] })).toEqual({ accounts: {}, securities: {} });
  });

  test('an answer with no list of holdings says nothing about any account', () => {
    // As Plaid never sends it: nothing was listed, which is not "nothing held".
    for (const answer of [
      { accounts: [investment('acct_1')], securities: [sec('vti')] },
      { accounts: [investment('acct_1')], holdings: null, securities: [] },
      { accounts: [investment('acct_1')], holdings: 'nonsense' },
      { accounts: [investment('acct_1')], holdings: { 0: hold('acct_1', 'vti') } },
    ]) {
      expect(observeHoldings(answer)).toBeNull();
    }
  });

  test("a holding that names no account makes the whole answer unusable: it could be any account's", () => {
    const accounts = [investment('acct_1'), investment('acct_2')];
    for (const odd of [null, 'vti', hold('', 'vti'), hold('__proto__', 'vti'), { ...hold('acct_1', 'vti'), account_id: undefined }, { ...hold('acct_1', 'vti'), account_id: 7 }]) {
      expect(observeHoldings({ accounts, securities: [sec('vti')], holdings: [hold('acct_1', 'vti'), odd, hold('acct_2', 'vti')] })).toBeNull();
    }
  });

  test('an account with a holding that names no security is left out of the day; the others are recorded', () => {
    const seen = observeHoldings({
      accounts: [investment('acct_1'), investment('acct_2')],
      securities: [sec('vti'), sec('bnd')],
      holdings: [hold('acct_1', 'vti'), { ...hold('acct_1', 'bnd'), security_id: null }, hold('acct_2', 'bnd')],
    })!;
    // Not as holding nothing, and not as holding only what was named: not at all.
    expect(Object.keys(seen.accounts)).toEqual(['acct_2']);
    // Only what a kept position names is described.
    expect(Object.keys(seen.securities)).toEqual(['bnd']);
  });

  test('whatever the answer holds, it never throws', () => {
    for (const answer of [null, undefined, 'x', 1, [], { holdings: 'nonsense', securities: null, accounts: 'none' }]) {
      expect(observeHoldings(answer)).toBeNull();
    }
    const seen = observeHoldings({
      accounts: [null, investment('acct_1'), investment('__proto__'), { type: 'investment' }, { account_id: 'acct_2', type: null }],
      securities: [null, { security_id: '' }, sec('vti')],
      holdings: [hold('acct_1', 'vti', { quantity: 'many', institution_price: Number.NaN, institution_value: Infinity, cost_basis: undefined })],
    })!;
    expect(seen.accounts).toEqual({
      acct_1: [{ security_id: 'vti', quantity: null, price: null, price_as_of: '2026-10-07', value: null, cost_basis: null, currency: 'USD' }],
    });
    expect(Object.getPrototypeOf(seen.accounts)).toBe(Object.prototype);
  });
});

describe('a month', () => {
  const seen = (positions: [string, string, number][], securities: any[] = [sec('vti'), sec('bnd'), sec('vmfxx', { type: 'cash', is_cash_equivalent: true })]) =>
    observeHoldings({ securities, holdings: positions.map(([a, s, q]) => hold(a, s, { quantity: q })) })!;

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

  // A field a later version adds reads as unrecognised, at every level, so
  // this version never rewrites a month without it.
  test('a field this version does not know makes a month, or the index, unrecognised', () => {
    const month = withObservation(null, '2026-10', '2026-10-07', '2026-10-07T09:00:00.000Z', seen([['a1', 'vti', 1]]))!;
    for (const add of [
      (m: any) => (m.note = 'x'),
      (m: any) => (m.securities[0].exchange = 'NYSE'),
      (m: any) => (m.days['2026-10-07'].a1.complete = true),
      (m: any) => (m.days['2026-10-07'].a1.positions[0].lots = []),
    ]) {
      const copy = structuredClone(month) as any;
      add(copy);
      expect(isHoldingsMonth(copy)).toBe(false);
    }
    const index = { v: 1, months: { '2026-10': 'a-random-id' }, accounts: { a1: { first: '2026-10-07', last: '2026-10-08', first_at: '2026-10-07T09:00:00.000Z' } } };
    expect(isHoldingsIndex(index)).toBe(true);
    expect(isHoldingsIndex({ ...index, note: 'x' })).toBe(false);
    expect(isHoldingsIndex({ ...index, accounts: { a1: { ...index.accounts.a1, count: 2 } } })).toBe(false);
    expect(isHoldingsIndex({ ...index, accounts: { a1: { first: '2026-10-08', last: '2026-10-07' } } })).toBe(false);
    expect(isHoldingsIndex({ ...index, months: { '2026-10': 'not an id' } })).toBe(false);
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
  // balances are (measuredBalanceMap), and an account its holdings answer
  // listed with nothing is recorded as that.
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
    // And the moments behind the first and last days, for the viewer's own day.
    expect(await readHoldingsSpan(ctx)).toEqual(span('2026-10-31', '2026-11-01', '2026-10-31T23:59:59.999Z', '2026-11-01T00:00:00.000Z'));
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
    // The moment the first day was first recorded, not its latest.
    expect(await readHoldingsSpan(ctx)).toEqual(span('2026-10-07', '2026-10-08', '2026-10-07T10:00:00.000Z', '2026-10-08T01:00:00.000Z'));
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
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_3' })).toEqual(span('2026-10-07', '2026-10-07', '2026-10-07T13:00:02.000Z', '2026-10-07T13:00:02.000Z'));
  });

  /** Records with the index's `n`th write failing: its first write claims
   *  the month, its second notes the accounts' days. */
  async function withIndexWriteFailing<T>(n: number, record: () => Promise<T>): Promise<T> {
    let indexWrites = 0;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:repo-update-entry') && keys[0] === INDEX && ++indexWrites === n) throw new Error('down');
      return origEval.call(fake, script, keys, args);
    }) as typeof fake.eval;
    try {
      return await record();
    } finally {
      fake.eval = origEval;
    }
  }

  test("a lost note of an account's days is a warning, its positions still count, and the next day finds its first day", async () => {
    const seen = (q: number) => [broker(['acct_1'], [hold('acct_1', 'vti', { quantity: q })], [sec('vti')])];
    expect(await withIndexWriteFailing(2, () => recordHoldings(ctx, seen(1), at('2026-10-05T13:00:00Z')))).toEqual({ recorded: 1, failed: 0 });
    expect(warnings.some((w) => String(w[0]).includes('could not be noted'))).toBe(true);
    expect((await readHoldingsMonth(ctx, '2026-10')).map((d) => d.date)).toEqual(['2026-10-05']);
    expect(await readHoldingsSpan(ctx)).toEqual(span(null, null));
    await recordHoldings(ctx, seen(2), at('2026-10-06T13:00:00Z'));
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_1' })).toEqual(span('2026-10-05', '2026-10-06', '2026-10-05T13:00:00.000Z', '2026-10-06T13:00:00.000Z'));
  });

  test('a lost note of the first day is found in the month before, when the next recording starts a month', async () => {
    const seen = (q: number) => [broker(['acct_1'], [hold('acct_1', 'vti', { quantity: q })], [sec('vti')])];
    await withIndexWriteFailing(2, () => recordHoldings(ctx, seen(1), at('2026-10-31T13:00:00Z')));
    await recordHoldings(ctx, seen(2), at('2026-11-01T13:00:00Z'));
    expect((await readHoldingsRange(ctx, '2026-10-01', '2026-11-30')).map((d) => d.date)).toEqual(['2026-10-31', '2026-11-01']);
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_1' })).toEqual(span('2026-10-31', '2026-11-01', '2026-10-31T13:00:00.000Z', '2026-11-01T13:00:00.000Z'));
  });

  test('an index gone missing while months remain is rebuilt from them before anything is claimed', async () => {
    await recordHoldings(ctx, [broker(['acct_gone', 'acct_kept'], [hold('acct_gone', 'vti'), hold('acct_kept', 'vti')], [sec('vti')])], at('2026-10-07T13:00:00Z'));
    const [[id]] = storedMonths();
    // Lost (no code removes it; a copy made by hand might): the month stays.
    await fake.hdel(INDEX, 'index');
    expect(await recordHoldings(ctx, [broker(['acct_kept'], [hold('acct_kept', 'vti')], [sec('vti')])], at('2026-10-08T13:00:00Z'))).toEqual({ recorded: 1, failed: 0 });
    // Into the month there was, not a second one beside it.
    expect(storedMonths().map(([i]) => i)).toEqual([id]);
    expect((await readHoldingsRange(ctx, '2026-10-01', '2026-10-31')).map((d) => [d.date, d.accounts.map((a) => a.account_id)])).toEqual([
      ['2026-10-07', ['acct_gone', 'acct_kept']],
      ['2026-10-08', ['acct_kept']],
    ]);
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_gone' })).toEqual(span('2026-10-07', '2026-10-07', '2026-10-07T13:00:00.000Z', '2026-10-07T13:00:00.000Z'));
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_kept' })).toEqual(span('2026-10-07', '2026-10-08', '2026-10-07T13:00:00.000Z', '2026-10-08T13:00:00.000Z'));
    // And forgetting finds what it holds.
    expect(await forgetAccountHoldings(ctx, 'acct_gone')).toEqual({ changed: 1, damaged: false });
    expect(await anyMonthNames('acct_gone')).toBe(false);
  });

  test('an index gone missing beside a month this version does not recognise is not rebuilt around it', async () => {
    await recordHoldings(ctx, [broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')])], at('2026-10-07T13:00:00Z'));
    const [[id]] = storedMonths();
    const unknown = await later({ v: 2, month: '2026-10' });
    await fake.hset(HISTORY, { [id]: unknown });
    await fake.hdel(INDEX, 'index');
    // It could be any month: claiming one again could store it twice.
    expect(await recordHoldings(ctx, [broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')])], at('2026-10-08T13:00:00Z'))).toEqual({ recorded: 0, failed: 1 });
    expect(storedMonths()).toEqual([[id, unknown]]);
    expect(await fake.hget<string>(INDEX, 'index')).toBeNull();
  });

  test('a damaged index stops recording, loudly, and is never written over', async () => {
    await recordHoldings(ctx, [broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')])], at('2026-10-07T13:00:00Z'));
    const months = storedMonths();
    await fake.hset(INDEX, { index: 'damaged bytes' });
    expect(await recordHoldings(ctx, [broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')])], at('2026-10-08T13:00:00Z'))).toEqual({ recorded: 0, failed: 1 });
    expect(errors.some((e) => String(e[0]).includes('holdings-history: the positions of 1 account(s) could not be recorded'))).toBe(true);
    expect(await fake.hget<string>(INDEX, 'index')).toBe('damaged bytes');
    expect(storedMonths()).toEqual(months);
  });

  test('hidden accounts are recorded like every other, and left out on read when asked', async () => {
    await recordHoldings(ctx, [broker(['acct_shown', 'acct_hidden'], [hold('acct_shown', 'vti'), hold('acct_hidden', 'vti')], [sec('vti')])], at('2026-10-07T13:00:00Z'));
    const all = await readHoldingsRange(ctx, '2026-10-07', '2026-10-07');
    expect(all[0].accounts.map((a) => a.account_id)).toEqual(['acct_hidden', 'acct_shown']);
    const hidden = new Set(['acct_hidden']);
    const shown = await readHoldingsRange(ctx, '2026-10-07', '2026-10-07', { hidden });
    expect(shown[0].accounts.map((a) => a.account_id)).toEqual(['acct_shown']);
    expect(await readHoldingsRange(ctx, '2026-10-07', '2026-10-07', { hidden, accountId: 'acct_hidden' })).toEqual([]);
    expect(await readHoldingsSpan(ctx, { hidden, accountId: 'acct_hidden' })).toEqual(span(null, null));
  });

  test('recordings and a forget at once, in any order, lose nothing and leave no month the index does not name', async () => {
    // Seeded, so a failure can be run again; delays around every script.
    let seed = 1;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      await Bun.sleep(Math.floor(rand() * 4));
      const out = await origEval.call(fake, script, keys, args);
      await Bun.sleep(Math.floor(rand() * 4));
      return out;
    }) as typeof fake.eval;
    const moments = ['2026-10-31T23:59:00Z', '2026-11-01T00:01:00Z', '2026-11-02T10:00:00Z'];
    for (let round = 0; round < 8; round++) {
      fake.reset();
      // Earlier history for the account to forget, in October.
      await recordHoldings(ctx, [broker(['acct_gone'], [hold('acct_gone', 'vti')], [sec('vti')])], at('2026-10-05T13:00:00Z'));
      const recordings = Array.from({ length: 6 }, (_, k) => {
        const account = `acct_${k % 3}`;
        const inst = broker([account], [hold(account, 'vti', { quantity: round * 100 + k })], [sec('vti')]);
        return recordHoldings(ctx, [inst], at(moments[k % 3]) + k).then((r) => ({ r, account, date: moments[k % 3].slice(0, 10) }));
      });
      const [forgot, ...recorded] = await Promise.all([forgetAccountHoldings(ctx, 'acct_gone'), ...recordings]);
      expect(forgot.damaged).toBe(false);
      const days = await readHoldingsRange(ctx, '2026-10-01', '2026-11-30');
      // Every recording that said it landed did.
      for (const { r, account, date } of recorded) {
        if (r.failed === 0) expect([round, account, date, days.find((d) => d.date === date)?.accounts.some((a) => a.account_id === account)]).toEqual([round, account, date, true]);
      }
      expect(days.some((d) => d.accounts.some((a) => a.account_id === 'acct_gone'))).toBe(false);
      // Every entry is a month the index names, so none is stored twice.
      const index = await storedIndex();
      for (const [id] of storedMonths()) expect(Object.values(index.months)).toContain(id);
      // And no account is said to be recorded on a day it wasn't.
      for (const [account, s] of Object.entries(index.accounts as Record<string, { first: string; last: string }>)) {
        const dates = days.filter((d) => d.accounts.some((a) => a.account_id === account)).map((d) => d.date);
        expect([account, dates.includes(s.first), dates.includes(s.last)]).toEqual([account, true, true]);
      }
    }
  }, 60_000);
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
      const accts = Array.from({ length: accounts }, () => investment(id()));
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
        value = withObservation(value, '2026-10', date, `${date}T13:00:05.123Z`, observeHoldings({ accounts: accts, holdings, securities })!);
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
    await fake.hset(HISTORY, { [id]: await later({ v: 2, month: '2026-10' }) });
    const err = await readHoldingsMonth(ctx, '2026-10').catch((e) => e);
    expect(err).toBeInstanceOf(UnreadableEntriesError);
    expect([err.unreadable, err.unrecognised]).toEqual([[], [id]]);
  });

  test("a month stored under another month's id is unrecognised, not read as that month", async () => {
    const id = await recorded();
    const other = withObservation(null, '2026-09', '2026-09-30', '2026-09-30T13:00:00.000Z', observeHoldings({ holdings: [hold('acct_1', 'vti')] })!);
    await fake.hset(HISTORY, { [id]: await encodeJsonText(JSON.stringify(other)) });
    const err = await readHoldingsRange(ctx, '2026-09-01', '2026-10-31').catch((e) => e);
    expect(err).toBeInstanceOf(UnreadableEntriesError);
    expect(err.unrecognised).toEqual([id]);
  });

  test('an unreadable index fails every read, the span included, and stops recording', async () => {
    await recorded();
    const unknown = await encrypt('{"v":1}');
    await fake.hset(INDEX, { index: unknown });
    for (const read of [() => readHoldingsRange(ctx, '2026-10-01', '2026-10-31'), () => readHoldingsSpan(ctx)]) {
      expect(await read().catch((e) => e)).toBeInstanceOf(StoredDataUnreadableError);
    }
    expect(await recordHoldings(ctx, [broker(['acct_1'], [hold('acct_1', 'vti')], [sec('vti')])], at('2026-10-08T13:00:00Z'))).toEqual({ recorded: 0, failed: 1 });
    expect(await fake.hget<string>(INDEX, 'index')).toBe(unknown);
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
    expect(await readHoldingsSpan(ctx)).toEqual(span(null, null));
    expect(await readHoldingsHistory(ctx, { from: '2026-10-01', to: '2026-10-31' })).toEqual({ span: span(null, null), days: [] });
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
    expect(await readHoldingsSpan(ctx, { links, accountId: 'acct_new' })).toEqual(span('2026-10-05', '2026-10-07', '2026-10-05T13:00:00.000Z', '2026-10-07T13:00:00.000Z'));
  });

  test('unlinked, each id is its own account', async () => {
    await history();
    expect(shape(await readHoldingsRange(ctx, '2026-10-01', '2026-10-31'))).toEqual([
      ['2026-10-05', ['acct_old<acct_old:1']],
      ['2026-10-06', ['acct_new<acct_new:3', 'acct_old<acct_old:2']],
      ['2026-10-07', ['acct_new<acct_new:4']],
    ]);
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_new' })).toEqual(span('2026-10-06', '2026-10-07', '2026-10-06T14:00:00.000Z', '2026-10-07T13:00:00.000Z'));
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
    expect(await forgetAccountHoldings(ctx, 'acct_gone')).toEqual({ changed: 3, damaged: false });
    const days = await readHoldingsRange(ctx, '2026-08-01', '2026-10-31');
    expect(days.map((d) => [d.date, d.accounts.map((a) => a.account_id)])).toEqual([
      ['2026-09-30', ['acct_kept']],
      ['2026-10-01', ['acct_kept']],
    ]);
    // Nothing anywhere names it, or the security only it held.
    expect(await anyMonthNames('acct_gone')).toBe(false);
    expect(await anyMonthNames('only_gone')).toBe(false);
    // August held only it: its entry is gone.
    expect(storedMonths()).toHaveLength(2);
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_gone' })).toEqual(span(null, null));
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_kept' })).toEqual(span('2026-09-30', '2026-10-01', '2026-09-30T13:00:00.000Z', '2026-10-01T13:00:00.000Z'));
    // And August can still be recorded again, under the place it had.
    await recordHoldings(ctx, [broker(['acct_kept'], [hold('acct_kept', 'vti')], [sec('vti')])], at('2026-08-16T13:00:00Z'));
    expect((await readHoldingsMonth(ctx, '2026-08')).map((d) => d.date)).toEqual(['2026-08-16']);
    expect(storedMonths()).toHaveLength(3);
  });

  test('a forget that stops part way is finished by running it again', async () => {
    await twoMonths();
    let writes = 0;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:repo-update-entry') && keys[0] === HISTORY && ++writes === 2) throw new Error('down');
      return origEval.call(fake, script, keys, args);
    }) as typeof fake.eval;
    try {
      expect(await forgetAccountHoldings(ctx, 'acct_gone').catch((e) => e)).toBeInstanceOf(Error);
    } finally {
      fake.eval = origEval;
    }
    // One month is done; the rest still hold it.
    expect((await readHoldingsRange(ctx, '2026-08-01', '2026-10-31', { accountId: 'acct_gone' })).length).toBeGreaterThan(0);
    expect(await forgetAccountHoldings(ctx, 'acct_gone')).toEqual({ changed: 2, damaged: false });
    expect(await readHoldingsRange(ctx, '2026-08-01', '2026-10-31', { accountId: 'acct_gone' })).toEqual([]);
    expect(await forgetAccountHoldings(ctx, 'acct_gone')).toEqual({ changed: 0, damaged: false });
  });

  test('a damaged month is left as it is and reported', async () => {
    await twoMonths();
    const index = await storedIndex();
    await fake.hset(HISTORY, { [index.months['2026-09']]: 'damaged' });
    expect(await forgetAccountHoldings(ctx, 'acct_gone')).toEqual({ changed: 2, damaged: true });
    expect(await fake.hget<string>(HISTORY, index.months['2026-09'])).toBe('damaged');
    expect(await readHoldingsRange(ctx, '2026-10-01', '2026-10-31', { accountId: 'acct_gone' })).toEqual([]);
  });

  test('an unrecognised month stops the forget of an account the index has days for, before anything changes', async () => {
    await twoMonths();
    const index = await storedIndex();
    const unknown = await later({ v: 9 });
    await fake.hset(HISTORY, { [index.months['2026-09']]: unknown });
    const before = storedMonths();
    const indexBefore = await fake.hget<string>(INDEX, 'index');
    const err = await forgetAccountHoldings(ctx, 'acct_gone').catch((e) => e);
    expect(err).toBeInstanceOf(UnreadableEntriesError);
    expect([err.unreadable, err.unrecognised]).toEqual([[], [index.months['2026-09']]]);
    expect(storedMonths()).toEqual(before);
    expect(await fake.hget<string>(INDEX, 'index')).toBe(indexBefore);
  });

  // The months still hold the positions: the index is bookkeeping.
  test('a damaged index stops nothing: the months are walked, the account removed, and the damage reported', async () => {
    await twoMonths();
    await fake.hset(INDEX, { index: 'damaged bytes' });
    expect(await forgetAccountHoldings(ctx, 'acct_gone')).toEqual({ changed: 3, damaged: true });
    expect(await anyMonthNames('acct_gone')).toBe(false);
    expect(await fake.hget<string>(INDEX, 'index')).toBe('damaged bytes');
    // No recording can land while it is damaged: the second pass has nothing to do.
    expect(await forgetRecentHoldings(ctx, 'acct_gone', at('2026-10-01T12:00:00Z'))).toEqual({ changed: 0 });
  });

  test('a month the index does not name is reached too', async () => {
    await twoMonths();
    // Left by an index lost before it could be rebuilt, say.
    const orphan = withObservation(
      null,
      '2026-07',
      '2026-07-15',
      '2026-07-15T13:00:00.000Z',
      observeHoldings({ holdings: [hold('acct_gone', 'vti'), hold('acct_kept', 'vti')], securities: [sec('vti')] })!
    );
    await fake.hset(HISTORY, { 'orphan-month': await encodeJsonText(JSON.stringify(orphan)) });
    expect(await forgetAccountHoldings(ctx, 'acct_gone')).toEqual({ changed: 4, damaged: false });
    expect(await anyMonthNames('acct_gone')).toBe(false);
    expect(await decryptJsonText((await fake.hget<string>(HISTORY, 'orphan-month'))!)).toContain('acct_kept');
  });

  test('an account that cannot hold positions is never held back by what cannot be read', async () => {
    await twoMonths();
    const index = (await fake.hget<string>(INDEX, 'index'))!;
    // A checking account, past a damaged index: nothing to do, nothing to say.
    await fake.hset(INDEX, { index: 'damaged bytes' });
    expect(await forgetAccountHoldings(ctx, 'chk_old', { mayHoldPositions: false })).toEqual({ changed: 0, damaged: false });
    // Past an index this version does not recognise, too.
    await fake.hset(INDEX, { index: await later({ v: 2 }) });
    expect(await forgetAccountHoldings(ctx, 'chk_old', { mayHoldPositions: false })).toEqual({ changed: 0, damaged: false });
    // An account that may hold positions could be in what can't be read: that stops.
    expect(await forgetAccountHoldings(ctx, 'acct_unknown_type').catch((e) => e)).toBeInstanceOf(UnreadableEntriesError);
    // With the index readable, an unrecognised month holds back no account it never recorded.
    await fake.hset(INDEX, { index });
    await fake.hset(HISTORY, { [(await storedIndex()).months['2026-09']]: await later({ v: 9 }) });
    expect(await forgetAccountHoldings(ctx, 'chk_old')).toEqual({ changed: 0, damaged: false });
  });

  test('the second pass touches only the recent months', async () => {
    await twoMonths();
    expect(await forgetRecentHoldings(ctx, 'acct_gone', at('2026-10-01T12:00:00Z'))).toEqual({ changed: 2 });
    expect((await readHoldingsMonth(ctx, '2026-08', { accountId: 'acct_gone' })).length).toBe(1);
  });

  test('forgetting an earlier account takes its holdings history with it', async () => {
    await twoMonths();
    // Known to the directory from an institution since disconnected (no
    // stored Item): an earlier account that can be forgotten.
    await recordDirectory(ctx, [
      { item_id: 'item_gone', institution_name: 'Broker', error: null, accounts: [{ account_id: 'acct_gone', type: 'investment', subtype: 'ira' }] },
    ] as any);
    const result = await forgetEarlierAccount(ctx, 'acct_gone');
    expect(result.holdingsDamaged).toBe(false);
    expect(await readHoldingsRange(ctx, '2026-08-01', '2026-10-31', { accountId: 'acct_gone' })).toEqual([]);
    expect((await readHoldingsRange(ctx, '2026-08-01', '2026-10-31', { accountId: 'acct_kept' })).length).toBe(2);
  });
});

describe('forgetting through the account-links route', () => {
  // An IRA and a checking account, at institutions since disconnected.
  async function setup() {
    fake.reset();
    forgetEpochs();
    await registerTestContainer(fake);
    await recordDirectory(ctx, [
      { item_id: 'item_gone', institution_name: 'Broker', error: null, accounts: [{ account_id: 'acct_gone', type: 'investment', subtype: 'ira' }] },
      { item_id: 'item_bank', institution_name: 'Bank', error: null, accounts: [{ account_id: 'chk_old', type: 'depository', subtype: 'checking' }] },
    ] as any);
    await recordHoldings(ctx, [broker(['acct_gone', 'acct_kept'], [hold('acct_gone', 'vti'), hold('acct_kept', 'vti')], [sec('vti')])], at('2026-10-07T13:00:00Z'));
    return storedMonths()[0][0];
  }
  const forget = async (old: string) => {
    const res = await linksRoute.POST(new Request('http://x/api/account-links', { method: 'POST', body: JSON.stringify({ action: 'forget', old }) }));
    return { status: res.status, body: await res.json() };
  };
  const listed = async (id: string) => (await fake.hget<string>(DIRECTORY, id)) !== null;
  const forgotten = { status: 200, body: { forgotten: true, unreadable_days: 0 } };
  const unreadable = 'Your saved holdings records could not be read, so they were left untouched.';

  test('a checking account is forgotten whatever holdings records cannot be read', async () => {
    for (const damage of [
      async () => {},
      async () => fake.hset(INDEX, { index: 'damaged bytes' }),
      async () => fake.hset(INDEX, { index: await later({ v: 2 }) }),
      async (month: string) => fake.hset(HISTORY, { [month]: await later({ v: 2, month: '2026-10' }) }),
    ]) {
      const month = await setup();
      await damage(month);
      expect(await forget('chk_old')).toEqual(forgotten);
      expect(await listed('chk_old')).toBe(false);
    }
  });

  test('an investment account past a damaged index is forgotten, and the damage is said', async () => {
    await setup();
    await fake.hset(INDEX, { index: 'damaged bytes' });
    expect(await forget('acct_gone')).toEqual({ status: 200, body: { forgotten: true, unreadable_days: 0, damaged_holdings: true } });
    expect(await listed('acct_gone')).toBe(false);
    expect(await anyMonthNames('acct_gone')).toBe(false);
  });

  test('past a damaged month, it is forgotten from the rest, and the damage is said', async () => {
    const month = await setup();
    await fake.hset(HISTORY, { [month]: 'damaged' });
    expect(await forget('acct_gone')).toEqual({ status: 200, body: { forgotten: true, unreadable_days: 0, damaged_holdings: true } });
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_gone' })).toEqual(span(null, null));
  });

  test("a month this version does not recognise, that may hold it: a 409 in the store's words, and nothing changed", async () => {
    const month = await setup();
    await fake.hset(HISTORY, { [month]: await later({ v: 2, month: '2026-10' }) });
    expect(await forget('acct_gone')).toEqual({
      status: 409,
      body: { error: unreadable, unreadable: true, unreadable_ids: [], unrecognised_ids: [month] },
    });
    // Still listed, so it can be forgotten once it can be read.
    expect(await listed('acct_gone')).toBe(true);
    expect((await readHoldingsSpan(ctx, { accountId: 'acct_gone' })).first).toBe('2026-10-07');
  });

  test('a month that kept changing: a 409 to try again, and trying again finishes it', async () => {
    await setup();
    // Every compare-and-set on a month finds it changed.
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:repo-update-entry') && keys[0] === HISTORY) return 0;
      return origEval.call(fake, script, keys, args);
    }) as typeof fake.eval;
    const refused = await forget('acct_gone');
    fake.eval = origEval;
    expect(refused).toEqual({ status: 409, body: { error: new UpdateConflictError('holdings records').message } });
    expect(refused.body.error).toContain('Try again.');
    expect(await listed('acct_gone')).toBe(true);
    expect(await forget('acct_gone')).toEqual(forgotten);
    expect(await anyMonthNames('acct_gone')).toBe(false);
  });

  test("a month too large to save again: a 413 in the store's words", async () => {
    await setup();
    // Over the ceiling even without the account (lowered here to show it).
    process.env.MAX_TXN_BLOB_CHARS = '200';
    const { status, body } = await forget('acct_gone');
    expect(status).toBe(413);
    expect(body.error).toMatch(/^Your holdings records are too large to save \(\d+ characters stored, over the limit of 200\), so nothing was changed\.$/);
    expect(await listed('acct_gone')).toBe(true);
  });
});

describe('repairing a damaged index', () => {
  const seen = (q: number) => [broker(['acct_1'], [hold('acct_1', 'vti', { quantity: q })], [sec('vti')])];
  async function twoMonths() {
    await recordHoldings(ctx, seen(1), at('2026-09-30T13:00:00Z'));
    await recordHoldings(ctx, seen(2), at('2026-10-01T13:00:00Z'));
  }

  test('rebuilds it from the months in place of the damaged bytes, and recording starts again', async () => {
    await twoMonths();
    const months = storedMonths();
    await fake.hset(INDEX, { index: 'damaged bytes' });
    expect(await recordHoldings(ctx, seen(3), at('2026-10-02T13:00:00Z'))).toEqual({ recorded: 0, failed: 1 });
    expect(await repairHoldingsIndex(ctx)).toEqual({ months: 2, damaged_months: 0 });
    expect(storedMonths()).toEqual(months);
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_1' })).toEqual(span('2026-09-30', '2026-10-01', '2026-09-30T13:00:00.000Z', '2026-10-01T13:00:00.000Z'));
    expect(await recordHoldings(ctx, seen(3), at('2026-10-02T13:00:00Z'))).toEqual({ recorded: 1, failed: 0 });
    // Into the month it had, not a second one.
    expect(storedMonths()).toHaveLength(2);
    expect((await readHoldingsRange(ctx, '2026-09-01', '2026-10-31')).map((d) => d.date)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });

  test('never replaces an index that reads, and has nothing to do with nothing stored', async () => {
    await twoMonths();
    const index = await fake.hget<string>(INDEX, 'index');
    const err = await repairHoldingsIndex(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(StoreRefusedError);
    expect([err.status, err.message]).toEqual([409, 'Your holdings records need no repair.']);
    expect(await fake.hget<string>(INDEX, 'index')).toBe(index);
    fake.reset();
    expect(await repairHoldingsIndex(ctx).catch((e) => e)).toBeInstanceOf(StoreRefusedError);
    expect(fake.hashes.size).toBe(0);
  });

  test('never replaces, or repairs around, a record this version does not recognise', async () => {
    await twoMonths();
    const unknownIndex = await later({ v: 2 });
    await fake.hset(INDEX, { index: unknownIndex });
    const err = await repairHoldingsIndex(ctx).catch((e) => e);
    expect(err).toBeInstanceOf(UnreadableEntriesError);
    expect([err.unreadable, err.unrecognised]).toEqual([[], ['index']]);
    expect(await fake.hget<string>(INDEX, 'index')).toBe(unknownIndex);
    // A damaged index beside an unrecognised month: it could be any month.
    await fake.hset(INDEX, { index: 'damaged bytes' });
    const [[month]] = storedMonths();
    await fake.hset(HISTORY, { [month]: await later({ v: 2, month: '2026-09' }) });
    const again = await repairHoldingsIndex(ctx).catch((e) => e);
    expect(again).toBeInstanceOf(UnreadableEntriesError);
    expect(again.unrecognised).toEqual([month]);
    expect(await fake.hget<string>(INDEX, 'index')).toBe('damaged bytes');
  });

  test('a damaged month is left where it is, and counted', async () => {
    await twoMonths();
    const october = (await storedIndex()).months['2026-10'];
    await fake.hset(INDEX, { index: 'damaged bytes' });
    await fake.hset(HISTORY, { [october]: 'damaged' });
    expect(await repairHoldingsIndex(ctx)).toEqual({ months: 1, damaged_months: 1 });
    expect(await fake.hget<string>(HISTORY, october)).toBe('damaged');
    expect(await readHoldingsSpan(ctx, { accountId: 'acct_1' })).toEqual(span('2026-09-30', '2026-09-30', '2026-09-30T13:00:00.000Z', '2026-09-30T13:00:00.000Z'));
  });
});

describe('beside the net-worth snapshot', () => {
  const ira = { account_id: 'acct_ira', name: 'IRA', type: 'investment', subtype: 'ira', balances: { current: 1000, iso_currency_code: 'USD' } };
  const roth = { account_id: 'acct_roth', name: 'Roth', type: 'investment', subtype: 'roth', balances: { current: 500, iso_currency_code: 'USD' } };
  const registry = [{ id: ctx.container, status: 'active' as const, primary: true, created_at: 'x' }];
  // One investment Item, linked and answering.
  async function linked() {
    await registerTestContainer(fake);
    await saveItem(ctx, { item_id: 'item_b', institution_name: 'Broker', encrypted_access_token: await encrypt('tok') });
    plaid.accounts = [ira];
    plaid.holdings = [hold('acct_ira', 'vti')];
    plaid.securities = [sec('vti')];
  }
  const today = () => new Date().toISOString().slice(0, 10);
  const recordedToday = async () => (await readHoldingsRange(ctx, today(), today()))[0]?.accounts.map((a) => [a.account_id, a.positions.length]) ?? [];

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
    expect(await readHoldingsSpan(ctx)).toEqual(span(null, null));
  });

  test('a holdings answer that is not whole records nothing, and the snapshot is recorded as ever', async () => {
    await linked();
    for (const answer of [
      // No list of holdings at all.
      { accounts: [ira], securities: [sec('vti')] },
      // A holding of no account.
      { accounts: [ira], holdings: [hold('acct_ira', 'vti'), { ...hold('acct_ira', 'bnd'), account_id: null }], securities: [sec('vti'), sec('bnd')] },
    ]) {
      plaid.holdingsAnswer = answer;
      expect(await snapshotData(ctx)).toEqual({ status: 'recorded' });
      expect(fake.hashes.has(HISTORY)).toBe(false);
    }
  });

  test('an account with a holding that names no security is not recorded for the day; the others are', async () => {
    await linked();
    plaid.accounts = [ira, roth];
    plaid.holdings = [hold('acct_ira', 'vti'), { ...hold('acct_ira', 'bnd'), security_id: null }, hold('acct_roth', 'vti')];
    expect(await snapshotData(ctx)).toEqual({ status: 'recorded' });
    expect(await recordedToday()).toEqual([['acct_roth', 1]]);
  });

  test('only the accounts the holdings answer lists are recorded as holding nothing', async () => {
    await linked();
    plaid.accounts = [ira, roth];
    plaid.holdingsAccounts = [ira];
    plaid.holdings = [];
    expect(await snapshotData(ctx)).toEqual({ status: 'recorded' });
    expect(await recordedToday()).toEqual([['acct_ira', 0]]);
  });

  test('an institution that fails records nothing', async () => {
    await linked();
    plaid.accountsFail = true;
    expect((await snapshotData(ctx)).status).toBe('unclean');
    expect(fake.hashes.has(HISTORY)).toBe(false);
  });

  test('a holdings write that fails never changes the snapshot, and the catch-up records the positions', async () => {
    await linked();
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:repo-')) throw new Error('down');
      return origEval.call(fake, script, keys, args);
    }) as typeof fake.eval;
    let report;
    try {
      report = await runSnapshots(registry, { scheduledFor: today() });
    } finally {
      fake.eval = origEval;
    }
    expect(report.results).toEqual([{ container: ctx.container, status: 'recorded', holdings_failed: 1, ms: expect.any(Number) }]);
    expect(await readRun(ctx, today())).toMatchObject({ status: 'recorded', holdings_failed: 1 });
    // The net worth landed regardless.
    expect((await getHistory(ctx)).map((p) => p.date)).toEqual([today()]);
    expect(errors.some((e) => String(e[0]).includes('holdings-history: the positions of 1 account(s)'))).toBe(true);
    expect(fake.hashes.has(HISTORY)).toBe(false);

    // The catch-up, two hours later, runs the day again for its positions.
    const catchup = await runSnapshots(registry, { scheduledFor: today() });
    expect(catchup.results).toEqual([{ container: ctx.container, status: 'recorded', ms: expect.any(Number) }]);
    expect(await readRun(ctx, today())).not.toHaveProperty('holdings_failed');
    expect(await recordedToday()).toEqual([['acct_ira', 1]]);
    expect((await getHistory(ctx)).map((p) => p.date)).toEqual([today()]);
    // And that is the day done.
    expect((await runSnapshots(registry, { scheduledFor: today() })).results[0].status).toBe('already');
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

describe('/api/holdings-history', () => {
  const get = async (query = '') => {
    const res = await historyRoute.GET(new Request(`http://x/api/holdings-history${query}`));
    return { status: res.status, body: await res.json() };
  };
  const post = async (body: unknown) => {
    const res = await historyRoute.POST(new Request('http://x/api/holdings-history', { method: 'POST', body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  };
  const today = () => new Date().toISOString().slice(0, 10);
  beforeEach(async () => {
    forgetEpochs();
    await registerTestContainer(fake);
  });
  const recordToday = (ids: string[]) => recordHoldings(ctx, [broker(ids, ids.map((id) => hold(id, 'vti')), [sec('vti')])]);
  const isoToday = () => expect.stringMatching(new RegExp(`^${today()}T`));
  const unreadable = 'Your saved holdings records could not be read, so they were left untouched.';

  test('the last 31 days by default, each position with its description', async () => {
    await recordToday(['acct_1']);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.to).toBe(today());
    expect(Date.parse(body.to) - Date.parse(body.from)).toBe(30 * 86_400_000);
    expect([body.first_recorded, body.last_recorded]).toEqual([today(), today()]);
    expect([body.first_recorded_at, body.last_recorded_at]).toEqual([isoToday(), isoToday()]);
    expect(body.dates).toHaveLength(1);
    expect(body.dates[0].accounts[0]).toMatchObject({ account_id: 'acct_1', recorded_as: 'acct_1' });
    expect(body.dates[0].accounts[0].positions[0]).toMatchObject({ security_id: 'vti', ticker: 'VTI', quantity: 10, value: 1000, currency: 'USD' });
  });

  test('a range and an account narrow it; hidden accounts are left out unless asked', async () => {
    await recordToday(['acct_1', 'acct_2']);
    await setAccountHidden(ctx, 'acct_2', 'investment', true);
    const ids = (body: any) => body.dates.flatMap((d: any) => d.accounts.map((a: any) => a.account_id));
    expect(ids((await get()).body)).toEqual(['acct_1']);
    expect(ids((await get('?include_hidden=1')).body)).toEqual(['acct_1', 'acct_2']);
    expect(ids((await get('?account_id=acct_2')).body)).toEqual([]);
    expect(ids((await get('?account_id=acct_2&include_hidden=1')).body)).toEqual(['acct_2']);
    expect((await get(`?from=2020-01-01&to=2020-01-31`)).body.dates).toEqual([]);
  });

  test("follows a link, so an earlier id's positions continue under the current one", async () => {
    await recordHoldings(ctx, [broker(['acct_old'], [hold('acct_old', 'vti')], [sec('vti')])], Date.now() - 2 * 86_400_000);
    await recordToday(['acct_new']);
    await linkAccounts(ctx, 'acct_old', 'acct_new', { old_last: 'x' });
    const { body } = await get('?account_id=acct_new');
    expect(body.dates.map((d: any) => d.accounts.map((a: any) => `${a.account_id}<${a.recorded_as}`))).toEqual([['acct_new<acct_old'], ['acct_new<acct_new']]);
    expect(body.first_recorded).toBe(new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10));
  });

  test('a summary is read from the index alone', async () => {
    await recordToday(['acct_1']);
    const [[id]] = storedMonths();
    await fake.hset(HISTORY, { [id]: 'damaged' });
    expect(await get('?summary=1&account_id=acct_1')).toEqual({
      status: 200,
      body: { first_recorded: today(), last_recorded: today(), first_recorded_at: isoToday(), last_recorded_at: isoToday() },
    });
    expect(await get('?summary=1&account_id=acct_unknown')).toEqual({
      status: 200,
      body: { first_recorded: null, last_recorded: null, first_recorded_at: null, last_recorded_at: null },
    });
  });

  test('one read of the index answers both the days and when recording began', async () => {
    await recordToday(['acct_1']);
    let indexReads = 0;
    fake.eval = (async (script: string, keys: string[], args: string[]) => {
      if (script.startsWith('-- nya:repo-read-entries') && keys[0] === INDEX) indexReads++;
      return origEval.call(fake, script, keys, args);
    }) as typeof fake.eval;
    expect((await get()).status).toBe(200);
    expect(indexReads).toBe(1);
    expect((await get('?summary=1')).status).toBe(200);
    expect(indexReads).toBe(2);
  });

  test('what cannot be read is a 409 naming it, never an empty history', async () => {
    await recordToday(['acct_1']);
    const [[id]] = storedMonths();
    await fake.hset(HISTORY, { [id]: 'damaged' });
    expect(await get()).toEqual({
      status: 409,
      body: { error: unreadable, unreadable: true, unreadable_ids: [id], unrecognised_ids: [] },
    });
  });

  test('a damaged index is a 409 that offers the repair; one this version does not recognise is not', async () => {
    await recordToday(['acct_1']);
    await fake.hset(INDEX, { index: 'damaged bytes' });
    for (const query of ['?summary=1&account_id=acct_1', '']) {
      expect(await get(query)).toEqual({ status: 409, body: { error: unreadable, unreadable: true, unreadable_ids: ['index'], unrecognised_ids: [], repairable: true } });
    }
    await fake.hset(INDEX, { index: await later({ v: 2 }) });
    expect(await get('?summary=1')).toEqual({ status: 409, body: { error: unreadable, unreadable: true, unreadable_ids: [], unrecognised_ids: ['index'] } });
  });

  test("a repair is made only on the person's word, and only of a damaged index", async () => {
    await recordToday(['acct_1']);
    await fake.hset(INDEX, { index: 'damaged bytes' });
    for (const body of [null, {}, { action: 'repair' }, { action: 'repair', confirm: 'yes' }, { action: 'rebuild', confirm: true }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(await fake.hget<string>(INDEX, 'index')).toBe('damaged bytes');
    expect(await post({ action: 'repair', confirm: true })).toEqual({ status: 200, body: { repaired: true, months: 1 } });
    expect(await get('?summary=1&account_id=acct_1')).toEqual({
      status: 200,
      body: { first_recorded: today(), last_recorded: today(), first_recorded_at: isoToday(), last_recorded_at: isoToday() },
    });
    // Once it reads again, there is nothing to repair.
    expect(await post({ action: 'repair', confirm: true })).toEqual({ status: 409, body: { error: 'Your holdings records need no repair.' } });
  });

  test('a repair beside a month this version does not recognise is refused, naming it', async () => {
    await recordToday(['acct_1']);
    const [[id]] = storedMonths();
    await fake.hset(INDEX, { index: 'damaged bytes' });
    await fake.hset(HISTORY, { [id]: await later({ v: 2, month: today().slice(0, 7) }) });
    expect(await post({ action: 'repair', confirm: true })).toEqual({
      status: 409,
      body: { error: unreadable, unreadable: true, unreadable_ids: [], unrecognised_ids: [id] },
    });
    expect(await fake.hget<string>(INDEX, 'index')).toBe('damaged bytes');
  });

  test('every input is checked', async () => {
    for (const query of [
      '?from=2026-02-30',
      '?from=yesterday',
      '?to=2026-1-01',
      '?from=2026-10-08&to=2026-10-07',
      '?from=2026-01-01&to=2026-04-03', // 93 days
      '?include_hidden=yes',
      '?summary=true',
      `?account_id=${'a'.repeat(101)}`,
      '?account_id=',
      '?from=2026-10-01&from=2026-10-02',
    ]) {
      const { status, body } = await get(query);
      expect([query, status, typeof body.error]).toEqual([query, 400, 'string']);
    }
    expect((await get('?from=2026-01-01&to=2026-04-02')).status).toBe(200); // 92 days
  });

  test('a range too large for one answer is refused by its size, never cut short', async () => {
    // Fewer positions than any count would refuse, with long names: what
    // decides is the size of the answer itself, in bytes.
    const securities = Array.from({ length: 1500 }, (_, i) => sec(`s${i}`, { name: `Fonds d'épargne ${i} `.repeat(20) }));
    const holdings = securities.map((s) => hold('acct_big', s.security_id));
    for (let d = 1; d <= 5; d++) await recordHoldings(ctx, [broker(['acct_big'], holdings, securities)], at(`2026-10-0${d}T13:00:00Z`));
    const { status, body } = await get('?from=2026-10-01&to=2026-10-05');
    expect(status).toBe(400);
    expect(body.error).toMatch(/^That range holds more than one answer carries \(\d+ bytes, over 4000000\)\. Ask for fewer days, or one account\.$/);
    const fits = await historyRoute.GET(new Request('http://x/api/holdings-history?from=2026-10-01&to=2026-10-03'));
    expect(fits.status).toBe(200);
    const text = await fits.text();
    expect(Buffer.byteLength(text)).toBeLessThan(4_000_000);
    expect(JSON.parse(text).dates).toHaveLength(3);
  });

  test('no container to read from is a 503', async () => {
    fake.reset();
    forgetEpochs();
    expect((await get()).status).toBe(503);
    expect((await post({ action: 'repair', confirm: true })).status).toBe(503);
  });
});

describe('a live load of the dashboard', () => {
  test('records the positions it fetched, and never sends the raw holdings answer', async () => {
    forgetEpochs();
    await registerTestContainer(fake);
    await saveItem(ctx, { item_id: 'item_b', institution_name: 'Broker', encrypted_access_token: await encrypt('tok') });
    plaid.accounts = [{ account_id: 'acct_ira', name: 'IRA', type: 'investment', subtype: 'ira', balances: { current: 1000, iso_currency_code: 'USD' } }];
    plaid.holdings = [hold('acct_ira', 'vti')];
    plaid.securities = [sec('vti')];
    const res = await netWorthRoute.GET(new Request('http://x/api/net-worth?refresh=1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.institutions[0].holdings).toHaveLength(1);
    expect('holdings_observed' in body.institutions[0]).toBe(false);
    const today = new Date().toISOString().slice(0, 10);
    expect((await readHoldingsRange(ctx, today, today))[0].accounts.map((a) => a.account_id)).toEqual(['acct_ira']);
  });
});
