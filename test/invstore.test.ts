import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

// The rules under test were each found by a review of this design as a way to
// lose rows no fetch can bring back. See the header of lib/invstore.ts.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
const ITEM = { item_id: 'item1', institution_name: 'Vanguard', encrypted_access_token: '' };
let items = [ITEM];
mock.module('@/lib/storage', () => ({ ...storageMock(fake), getItems: async () => items }));

// A Plaid that serves `plaid.rows` by date range, one page at a time.
type Row = Record<string, any>;
const plaid = {
  rows: [] as Row[],
  accounts: [{ account_id: 'ira', name: 'IRA', mask: '1234', type: 'investment', subtype: 'ira' }] as Row[],
  calls: [] as { start: string; end: string; offset: number }[],
  fail: null as null | string,
  /** Lie about the total for ranges containing this date (a list that moved). */
  wrongTotalOn: null as null | string,
  /** Also return rows outside the requested range. */
  leakOutOfRange: false,
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    investmentsTransactionsGet: async (req: any) => {
      const { start_date: start, end_date: end } = req;
      const offset = req.options?.offset ?? 0;
      const count = req.options?.count ?? 500;
      plaid.calls.push({ start, end, offset });
      if (plaid.fail) throw { response: { data: { error_code: plaid.fail } } };
      const inRange = plaid.rows.filter((r) => r.date >= start && r.date <= end);
      const page = (plaid.leakOutOfRange ? plaid.rows : inRange).slice(offset, offset + count);
      const lie = plaid.wrongTotalOn && plaid.wrongTotalOn >= start && plaid.wrongTotalOn <= end;
      return {
        data: {
          accounts: plaid.accounts,
          securities: [{ security_id: 's1', name: 'Target 2055', ticker_symbol: 'VFFVX' }],
          investment_transactions: page,
          total_investment_transactions: inRange.length + (lie ? 1 : 0),
        },
      };
    },
  },
}));

const { encrypt } = await import('@/lib/crypto');
ITEM.encrypted_access_token = await encrypt('access-token');
const { syncInvestments, readInvStore, nextWindow, clearInvestmentStore } = await import('@/lib/invstore');
const { encodeJsonBlob } = await import('@/lib/blob');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 24, 12); // 2026-09-24
const row = (id: string, date: string, over: Row = {}): Row => ({
  investment_transaction_id: id,
  account_id: 'ira',
  security_id: 's1',
  date,
  name: 'Contribution',
  quantity: 1,
  amount: -500,
  price: 500,
  fees: 0,
  type: 'cash',
  subtype: 'contribution',
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
  ...over,
});
const key = testKey('invtxns:item1');
const ids = (rows: { investment_transaction_id: string }[]) => rows.map((r) => r.investment_transaction_id).sort();

beforeEach(() => {
  fake.reset();
  items = [ITEM];
  plaid.rows = [];
  plaid.accounts = [{ account_id: 'ira', name: 'IRA', mask: '1234', type: 'investment', subtype: 'ira' }];
  plaid.calls = [];
  plaid.fail = null;
  plaid.wrongTotalOn = null;
  plaid.leakOutOfRange = false;
});

describe('first fill', () => {
  test('asks for two years, stores rows and covers each account from the window', async () => {
    plaid.rows = [row('a', '2025-03-01'), row('b', '2026-09-01')];
    const sync = await syncInvestments(ITEM, { now: NOW });
    expect(plaid.calls[0]).toEqual({ start: '2024-09-24', end: '2026-09-24', offset: 0 });
    expect(ids(sync.rows)).toEqual(['a', 'b']);
    expect(sync.coverage.ira).toEqual({ from: '2024-09-24', through: '2026-09-24' });
    const stored = await readInvStore('item1');
    expect(Object.keys(stored.txns).sort()).toEqual(['a', 'b']);
    expect(stored.txns.a.raw.security_id).toBe('s1'); // raw row kept whole
  });

  test('never stores pending rows', async () => {
    plaid.rows = [row('p', '2026-09-20', { subtype: 'pending credit' }), row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    expect(Object.keys((await readInvStore('item1')).txns)).toEqual(['a']);
  });

  test('stores nothing dated outside the requested range', async () => {
    plaid.rows = [row('old', '2020-01-01'), row('a', '2026-09-01')];
    plaid.leakOutOfRange = true;
    await syncInvestments(ITEM, { now: NOW });
    expect(Object.keys((await readInvStore('item1')).txns)).toEqual(['a']);
  });
});

describe('rule 1: a failed fetch never writes', () => {
  test('the stored blob is byte-identical after a Plaid failure, and its rows are served', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    const before = await fake.get<string>(key);

    plaid.fail = 'ITEM_LOGIN_REQUIRED';
    const sync = await syncInvestments(ITEM, { now: NOW + DAY });
    expect(await fake.get<string>(key)).toBe(before!);
    expect(sync.note).toBe('This account needs to be reconnected');
    expect(ids(sync.rows)).toEqual(['a']);
  });
});

describe('rule 2: nothing is deleted, and absence needs two verified syncs', () => {
  test('a row missing once is kept and served; missing again a day later it is excluded; back again it returns', async () => {
    plaid.rows = [row('a', '2026-08-01'), row('b', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });

    plaid.rows = [row('a', '2026-08-01')];
    let sync = await syncInvestments(ITEM, { now: NOW + DAY / 2, maxAgeMs: 0 });
    expect(ids(sync.rows)).toEqual(['a', 'b']);
    expect(sync.unconfirmed.ira).toEqual(['2026-09-01']);

    sync = await syncInvestments(ITEM, { now: NOW + 2 * DAY, maxAgeMs: 0 });
    expect(ids(sync.rows)).toEqual(['a']);
    expect((await readInvStore('item1')).txns.b).toBeDefined(); // excluded, not deleted

    plaid.rows = [row('a', '2026-08-01'), row('b', '2026-09-01')];
    sync = await syncInvestments(ITEM, { now: NOW + 3 * DAY, maxAgeMs: 0 });
    expect(ids(sync.rows)).toEqual(['a', 'b']);
  });

  // Two verified syncs agreeing is not enough on its own: they must be a day
  // apart, so one bad hour can't confirm itself.
  test('missing twice within a day is not enough to exclude', async () => {
    plaid.rows = [row('a', '2026-08-01'), row('b', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    plaid.rows = [row('a', '2026-08-01')];
    await syncInvestments(ITEM, { now: NOW + 1000, maxAgeMs: 0 });
    const sync = await syncInvestments(ITEM, { now: NOW + DAY / 2, maxAgeMs: 0 });
    expect(ids(sync.rows)).toEqual(['a', 'b']);
  });

  test('an account left out of a response keeps every row, unjudged', async () => {
    plaid.accounts.push({ account_id: 'roth', name: 'Roth', mask: '9', type: 'investment', subtype: 'roth' });
    plaid.rows = [row('a', '2026-09-01'), row('r', '2026-09-02', { account_id: 'roth' })];
    await syncInvestments(ITEM, { now: NOW });

    plaid.accounts = plaid.accounts.filter((a) => a.account_id !== 'roth');
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    const sync = await syncInvestments(ITEM, { now: NOW + 3 * DAY, maxAgeMs: 0 });
    expect(ids(sync.rows)).toEqual(['a', 'r']);
    expect(sync.unconfirmed.roth).toBeUndefined();
  });

  // Rotated ids with less history: rows older than the account's oldest
  // returned row are never judged.
  test('rows older than an account’s oldest returned row are never judged', async () => {
    // Inside every later window, but older than anything the account now returns.
    plaid.rows = [row('old', '2026-01-01'), row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    const sync = await syncInvestments(ITEM, { now: NOW + 3 * DAY, maxAgeMs: 0 });
    expect(ids(sync.rows)).toEqual(['a', 'old']);
  });

  // Re-keyed ids: until confirmed both copies are served (and the backfill is
  // told to wait); once confirmed only the new ones remain. Never both for good.
  test('re-keyed rows settle to one copy', async () => {
    plaid.rows = [row('a', '2026-09-01'), row('b', '2026-09-02')];
    await syncInvestments(ITEM, { now: NOW });
    plaid.rows = [row('a2', '2026-09-01'), row('b2', '2026-09-02')];
    await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    const sync = await syncInvestments(ITEM, { now: NOW + 3 * DAY, maxAgeMs: 0 });
    expect(ids(sync.rows)).toEqual(['a2', 'b2']);
  });

  test('a row named by a cancel row is excluded at once, whatever its date', async () => {
    plaid.rows = [row('orig', '2025-06-01'), row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    plaid.rows = [row('a', '2026-09-01'), row('c', '2026-09-10', { type: 'cancel', subtype: 'cancel', cancel_transaction_id: 'orig' })];
    const sync = await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    expect(ids(sync.rows)).toEqual(['a']);
  });
});

describe('rule 3: only a verified fetch is evidence', () => {
  test('a range too big for one page is split by date, never paged by offset', async () => {
    plaid.rows = Array.from({ length: 1200 }, (_, i) =>
      row(`r${i}`, new Date(Date.UTC(2025, 0, 1) + (i % 600) * DAY).toISOString().slice(0, 10))
    );
    const sync = await syncInvestments(ITEM, { now: NOW });
    expect(sync.rows).toHaveLength(1200);
    expect(plaid.calls.every((c) => c.offset === 0)).toBe(true);
    expect(sync.coverage.ira).toBeDefined(); // verified
  });

  test('a total that moves between requests: upserts only, no judging, no coverage', async () => {
    plaid.rows = [row('a', '2026-08-01'), row('b', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    const coverageBefore = (await readInvStore('item1')).coverage;

    plaid.rows = [row('a', '2026-08-01'), row('new', '2026-09-20')];
    plaid.wrongTotalOn = '2026-09-20';
    await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    const sync = await syncInvestments(ITEM, { now: NOW + 3 * DAY, maxAgeMs: 0 });
    expect(ids(sync.rows)).toEqual(['a', 'b', 'new']); // b not judged, new upserted
    expect((await readInvStore('item1')).coverage).toEqual(coverageBefore);
  });
});

describe('storage failures never overwrite', () => {
  test('an unreadable blob is left alone and live rows are served', async () => {
    await fake.set(key, 'not-a-ciphertext');
    plaid.rows = [row('a', '2026-09-01')];
    const sync = await syncInvestments(ITEM, { now: NOW });
    expect(ids(sync.rows)).toEqual(['a']);
    expect(sync.storeNote).toContain('could not be read');
    expect(await fake.get<string>(key)).toBe('not-a-ciphertext');
  });

  test('a blob over the size ceiling is refused, the stored one kept', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    const before = await fake.get<string>(key);
    process.env.MAX_TXN_BLOB_CHARS = '10';
    try {
      plaid.rows = [row('a', '2026-09-01'), row('b', '2026-09-02')];
      const sync = await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
      expect(ids(sync.rows)).toEqual(['a', 'b']); // served live, nothing dropped
      expect(sync.storeNote).toContain('too large');
      expect(await fake.get<string>(key)).toBe(before!);
    } finally {
      delete process.env.MAX_TXN_BLOB_CHARS;
    }
  });

  test('a blob from a newer schema is never written over', async () => {
    const newer = await encodeJsonBlob({ schema_version: 99, txns: {}, accounts: {}, coverage: {}, securities: {} });
    await fake.set(key, newer);
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    expect(await fake.get<string>(key)).toBe(newer);
  });
});

describe('rule 5: one sync at a time, and disconnect sticks', () => {
  test('a sync that finds the lock held serves what is stored and reports busy', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    await fake.set(testKey('invtxns-lock:item1'), 'someone-else', { nx: true, px: 60_000 });
    plaid.rows = [row('a', '2026-09-01'), row('b', '2026-09-02')];
    const sync = await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    expect(sync.busy).toBe(true);
    expect(ids(sync.rows)).toEqual(['a']);
  });

  test('a sync that finishes after a disconnect removes what it wrote', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    items = []; // disconnected while the sync ran
    await syncInvestments(ITEM, { now: NOW });
    expect(await fake.get(key)).toBeNull();
  });

  test('clearInvestmentStore deletes the key', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    await clearInvestmentStore('item1');
    expect(await fake.get(key)).toBeNull();
  });
});

describe('freshness and windows', () => {
  test('a sync within 15 minutes of a verified one makes no Plaid call', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    const calls = plaid.calls.length;
    await syncInvestments(ITEM, { now: NOW + 60_000 });
    expect(plaid.calls.length).toBe(calls);
  });

  test('after the fill, later syncs verify the last year', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    expect(nextWindow(await readInvStore('item1'), NOW + DAY)).toEqual({ from: '2025-09-25', to: '2026-09-25' });
  });

  // A long absence is re-verified back to where coverage ended, not left as a gap.
  test('after a long absence the window reaches back to the end of coverage', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    const later = NOW + 500 * DAY;
    expect(nextWindow(await readInvStore('item1'), later).from).toBe('2026-09-24');
  });

  test('coverage joins across contiguous syncs', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });
    const sync = await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    expect(sync.coverage.ira).toEqual({ from: '2024-09-24', through: '2026-09-25' });
  });
});
