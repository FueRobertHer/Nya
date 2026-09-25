import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
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
  /** Leave this account out of responses for ranges containing `on`. */
  omit: null as null | { account_id: string; on: string },
  /** Throw on this call number (1-based). */
  failOnCall: 0,
  /** Runs on every call, before answering. */
  onCall: null as null | (() => Promise<void> | void),
  /** Leave total_investment_transactions out of every response. */
  noTotal: false,
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    investmentsTransactionsGet: async (req: any) => {
      const { start_date: start, end_date: end } = req;
      const offset = req.options?.offset ?? 0;
      const count = req.options?.count ?? 500;
      plaid.calls.push({ start, end, offset });
      if (plaid.onCall) await plaid.onCall();
      if (plaid.fail) throw { response: { data: { error_code: plaid.fail } } };
      if (plaid.failOnCall && plaid.calls.length === plaid.failOnCall) {
        throw { response: { data: { error_code: 'INTERNAL_SERVER_ERROR' } } };
      }
      const omitHere = plaid.omit && plaid.omit.on >= start && plaid.omit.on <= end;
      const inRange = plaid.rows.filter((r) => r.date >= start && r.date <= end);
      const page = (plaid.leakOutOfRange ? plaid.rows : inRange).slice(offset, offset + count);
      const lie = plaid.wrongTotalOn && plaid.wrongTotalOn >= start && plaid.wrongTotalOn <= end;
      return {
        data: {
          accounts: omitHere ? plaid.accounts.filter((a) => a.account_id !== plaid.omit!.account_id) : plaid.accounts,
          securities: [{ security_id: 's1', name: 'Target 2055', ticker_symbol: 'VFFVX' }],
          investment_transactions: page,
          total_investment_transactions: plaid.noTotal ? undefined : inRange.length + (lie ? 1 : 0),
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

// The investment-activity route caches in the request's container
// (lib/cache.ts); without one every cache assertion would pass vacuously.
beforeEach(async () => {
  const { createFirstContainer } = await import('@/lib/containers');
  const { forgetCacheCtx } = await import('@/lib/cache');
  fake.reset();
  forgetCacheCtx();
  process.env.CONTAINER_ID = await createFirstContainer();
});
afterEach(() => {
  delete process.env.CONTAINER_ID;
});

beforeEach(() => {
  items = [ITEM];
  plaid.rows = [];
  plaid.accounts = [{ account_id: 'ira', name: 'IRA', mask: '1234', type: 'investment', subtype: 'ira' }];
  plaid.calls = [];
  plaid.fail = null;
  plaid.wrongTotalOn = null;
  plaid.leakOutOfRange = false;
  plaid.omit = null;
  plaid.failOnCall = 0;
  plaid.onCall = null;
  plaid.noTotal = false;
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

  // Re-keyed ids: until confirmed both copies are shown (the backfill leaves the
  // old ones out of its walk); once confirmed only the new ones remain.
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
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(' '));
    try {
      plaid.rows = [row('a', '2026-09-01'), row('b', '2026-09-02')];
      const sync = await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
      expect(ids(sync.rows)).toEqual(['a', 'b']); // served live, nothing dropped
      expect(sync.storeNote).toContain('too large');
      expect(await fake.get<string>(key)).toBe(before!);
      // The ceiling error names the container (#58).
      expect(errors.join(' ')).toContain(`refusing to persist item1 in container ${process.env.CONTAINER_ID}`);
    } finally {
      console.error = origError;
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

// Cases the code review found untested, or tested too weakly to fail.
describe('review follow-ups', () => {
  // Enough rows that the fetch splits into several requests.
  const spread = (n: number, account = 'ira') =>
    Array.from({ length: n }, (_, i) =>
      row(`${account}${i}`, new Date(Date.UTC(2025, 0, 1) + (i % 600) * DAY).toISOString().slice(0, 10), { account_id: account })
    );

  test('an account missing from one of several requests is not judged in any of them', async () => {
    plaid.accounts.push({ account_id: 'roth', name: 'Roth', mask: '9', type: 'investment', subtype: 'roth' });
    // Four rows a day: the one-year window splits into about four requests.
    const roth = [
      row('r_old', '2025-10-15', { account_id: 'roth' }),
      row('r_mid', '2026-02-15', { account_id: 'roth' }),
      row('r_end', '2026-08-01', { account_id: 'roth' }),
    ];
    plaid.rows = [...spread(2400), ...roth];
    await syncInvestments(ITEM, { now: NOW });

    // The request covering mid-February stops listing roth, and returns none of
    // its rows. Roth is still listed, with rows, before and after it.
    plaid.omit = { account_id: 'roth', on: '2026-02-15' };
    plaid.rows = plaid.rows.filter((r) => r.investment_transaction_id !== 'r_mid');
    await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    expect(plaid.calls.filter((c) => c.start > '2025-09-01').length).toBeGreaterThan(2);
    const sync = await syncInvestments(ITEM, { now: NOW + 3 * DAY, maxAgeMs: 0 });
    expect(ids(sync.rows)).toContain('r_mid');
  });

  test('a Plaid failure partway through a split fetch writes nothing', async () => {
    plaid.rows = spread(1200);
    await syncInvestments(ITEM, { now: NOW });
    const before = await fake.get<string>(key);
    // Still over one page within the one-year window, so it splits; the
    // second request fails after the first succeeded.
    plaid.failOnCall = plaid.calls.length + 2;
    const sync = await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    expect(sync.note).toBeTruthy();
    expect(await fake.get<string>(key)).toBe(before!);
  });

  // Only the ranges the duplicate appeared in prove nothing: a verified range
  // between them still covers, and coverage never spans a duplicate's date.
  test('duplicate ids make only their own ranges unverified', async () => {
    plaid.rows = [row('dup', '2025-01-10'), row('dup', '2026-06-10'), ...spread(900)];
    const sync = await syncInvestments(ITEM, { now: NOW });
    const cov = sync.coverage.ira;
    expect(cov).toBeDefined();
    for (const d of ['2025-01-10', '2026-06-10']) expect(cov!.from <= d && cov!.through >= d).toBe(false);
  });

  // A crowded day (a direct-indexing account's funding day) is read with
  // offsets, and verified when the total holds still and the ids add up.
  test('a single day with more rows than a page is read with offsets and verified', async () => {
    plaid.rows = Array.from({ length: 501 }, (_, i) => row(`d${i}`, '2026-03-03'));
    const sync = await syncInvestments(ITEM, { now: NOW });
    expect(sync.rows).toHaveLength(501);
    expect(plaid.calls.some((c) => c.offset > 0)).toBe(true);
    expect(sync.coverage.ira).toEqual({ from: '2024-09-24', through: '2026-09-24' });
  });

  test('a crowded day whose total moves between pages is not verified', async () => {
    plaid.rows = Array.from({ length: 501 }, (_, i) => row(`d${i}`, '2026-03-03'));
    // The total reported for that day changes once its offset pages begin.
    plaid.onCall = () => {
      const last = plaid.calls[plaid.calls.length - 1];
      plaid.wrongTotalOn = last.offset > 0 ? '2026-03-03' : null;
    };
    const sync = await syncInvestments(ITEM, { now: NOW });
    const cov = sync.coverage.ira;
    expect(!!cov && cov.from <= '2026-03-03' && cov.through >= '2026-03-03').toBe(false);
  });

  // A row can only be marked while a two-year fill is judging it; once fills
  // stop, later one-year windows never reach it, so a mark left behind could
  // never be confirmed or cleared. It must be dropped.
  test('an unconfirmed mark is dropped once its row leaves the judged range', async () => {
    plaid.rows = [row('older', '2024-12-01'), row('old', '2025-01-05'), row('a', '2026-09-01')];
    await syncInvestments(ITEM, { now: NOW });

    // A new account: the next sync learns of it (one-year window), and the one
    // after fills two years for it. In that fill 'old' goes missing: marked,
    // not yet confirmed.
    plaid.accounts.push({ account_id: 'roth', name: 'Roth', mask: '9', type: 'investment', subtype: 'roth' });
    plaid.rows = [row('older', '2024-12-01'), row('a', '2026-09-01'), row('r', '2026-09-02', { account_id: 'roth' })];
    await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    let sync = await syncInvestments(ITEM, { now: NOW + 2 * DAY, maxAgeMs: 0 });
    expect(plaid.calls[plaid.calls.length - 1].start).toBe('2024-09-26');
    expect(sync.unconfirmed.ira).toEqual(['2025-01-05']);

    // Filled now: the one-year window no longer reaches 'old', so its mark goes.
    sync = await syncInvestments(ITEM, { now: NOW + 3 * DAY, maxAgeMs: 0 });
    expect(ids(sync.rows)).toContain('old');
    expect(sync.unconfirmed.ira ?? []).toEqual([]);
  });

  test('a cancelled trade stays excluded when a later fetch returns it without its cancel', async () => {
    plaid.rows = [row('orig', '2026-06-01'), row('c', '2026-06-02', { type: 'cancel', subtype: 'cancel', cancel_transaction_id: 'orig' })];
    await syncInvestments(ITEM, { now: NOW });
    plaid.rows = [row('orig', '2026-06-01'), row('new', '2026-09-20')];
    plaid.wrongTotalOn = '2026-09-20'; // unverified: upsert only
    const sync = await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    expect(ids(sync.rows)).toEqual(['new']);
  });

  test('an unverified sync still counts as recent, so Plaid is not asked again at once', async () => {
    plaid.rows = [row('a', '2026-09-20')];
    plaid.wrongTotalOn = '2026-09-20';
    await syncInvestments(ITEM, { now: NOW });
    const calls = plaid.calls.length;
    await syncInvestments(ITEM, { now: NOW + 60_000 });
    expect(plaid.calls.length).toBe(calls);
  });

  // The disconnect lands between this sync's check and its write: only a
  // check AFTER the write catches it.
  test('a disconnect that lands during the write still removes the blob', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    const set = fake.set.bind(fake);
    fake.set = (async (k: string, v: string, o?: any) => {
      const r = await set(k, v, o);
      if (k === key) items = [];
      return r;
    }) as typeof fake.set;
    try {
      await syncInvestments(ITEM, { now: NOW });
    } finally {
      fake.set = set;
    }
    expect(await fake.get(key)).toBeNull();
  });

  test('a sync never releases a lock it no longer holds', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    const lock = testKey('invtxns-lock:item1');
    plaid.onCall = async () => {
      await fake.set(lock, 'someone-else'); // ours lapsed and another took it
    };
    const sync = await syncInvestments(ITEM, { now: NOW });
    expect(await fake.get<string>(lock)).toBe('someone-else');
    // Nor writes over what the new holder may have written.
    expect(await fake.get(key)).toBeNull();
    expect(sync.busy).toBe(true);
  });
});

// The activity route reads the store: what it caches and how far the line runs.
describe('/api/investment-activity', () => {
  const get = async () => {
    const { GET } = await import('@/app/api/investment-activity/route');
    const res = await GET(new Request('http://x/api/investment-activity?id=ira&item_id=item1'));
    return res.json();
  };

  test('a busy answer is not cached, so the next load sees the real rows', async () => {
    await fake.set(testKey('invtxns-lock:item1'), 'someone-else', { nx: true, px: 60_000 });
    plaid.rows = [row('a', '2026-09-01')];
    await syncInvestments(ITEM); // blocked: stores nothing
    expect((await get()).txns).toEqual([]);

    await fake.del(testKey('invtxns-lock:item1'));
    const second = await get();
    expect(second.from_cache).toBe(false);
    expect(second.txns.map((t: any) => t.investment_transaction_id)).toEqual(['a']);
  });

  test('the flows run from the later of coverage and the oldest row, to the end of coverage', async () => {
    plaid.rows = [row('a', '2026-03-01'), row('b', '2026-09-01')];
    const body = await get();
    const today = new Date().toISOString().slice(0, 10);
    expect(body.flows_from).toBe('2026-03-01');
    expect(body.flows_to).toBe(today);
    expect(body.txns.map((t: any) => t.investment_transaction_id)).toEqual(['b', 'a']); // newest first
  });

  test('during an outage it serves saved rows with a note, and caches nothing', async () => {
    plaid.rows = [row('a', '2026-09-01')];
    // Synced an hour ago, so the route's sync is due and meets the outage.
    await syncInvestments(ITEM, { now: Date.now() - 60 * 60 * 1000 });
    plaid.fail = 'INSTITUTION_DOWN';
    const body = await get();
    expect(body.txns).toHaveLength(1);
    expect(body.note).toBe('Could not fetch investment activity; showing saved activity');
    expect((await get()).from_cache).toBe(false);
  });
});

describe('second review follow-ups', () => {
  test('the lock is refreshed before each request of a long fill', async () => {
    const lock = testKey('invtxns-lock:item1');
    plaid.rows = Array.from({ length: 1200 }, (_, i) =>
      row(`r${i}`, new Date(Date.UTC(2025, 0, 1) + (i % 600) * DAY).toISOString().slice(0, 10))
    );
    const ttls: number[] = [];
    plaid.onCall = async () => {
      ttls.push(await fake.ttl(lock));
      await fake.expire(lock, 1); // about to lapse
    };
    await syncInvestments(ITEM, { now: NOW });
    expect(ttls.length).toBeGreaterThan(2);
    expect(ttls.slice(1).every((t) => t === 120)).toBe(true); // refreshed each time
  });

  // Plaid can cancel a trade by re-issuing it under the same id, typed cancel.
  test('a cancel row under the same id as the trade excludes the stored trade', async () => {
    plaid.rows = [row('x', '2026-09-01'), row('a', '2026-09-02')];
    await syncInvestments(ITEM, { now: NOW });
    plaid.rows = [row('x', '2026-09-01', { type: 'cancel', subtype: 'cancel' }), row('a', '2026-09-02')];
    const sync = await syncInvestments(ITEM, { now: NOW + DAY, maxAgeMs: 0 });
    expect(ids(sync.rows)).toEqual(['a']);
  });

  // The backfill's runs are capped; one that serves an unverified store
  // without fetching again would spend a retry for nothing.
  test('freshOnlyIfVerified fetches again after an unverified sync', async () => {
    plaid.rows = [row('a', '2026-09-20')];
    plaid.wrongTotalOn = '2026-09-20';
    await syncInvestments(ITEM, { now: NOW });
    const calls = plaid.calls.length;
    await syncInvestments(ITEM, { now: NOW + 60_000, freshOnlyIfVerified: true });
    expect(plaid.calls.length).toBeGreaterThan(calls);
  });

  test('a response with no total is taken as is, not split down to single days', async () => {
    plaid.rows = [row('a', '2026-09-01'), row('b', '2025-06-01')];
    plaid.noTotal = true;
    const sync = await syncInvestments(ITEM, { now: NOW });
    expect(plaid.calls).toHaveLength(1);
    expect(ids(sync.rows)).toEqual(['a', 'b']);
    expect(sync.coverage.ira).toBeUndefined(); // proves nothing
  });
});

describe('third review follow-ups', () => {
  // A failure partway keeps what came before it: recent ranges are asked
  // first, so they are the ones kept.
  test('a failure partway keeps the ranges answered before it', async () => {
    plaid.rows = Array.from({ length: 1200 }, (_, i) =>
      row(`r${i}`, new Date(Date.UTC(2025, 0, 1) + (i % 600) * DAY).toISOString().slice(0, 10))
    );
    plaid.failOnCall = 4; // after the newest ranges were answered
    const sync = await syncInvestments(ITEM, { now: NOW });
    expect(sync.note).toBeTruthy();
    expect(sync.rows.length).toBeGreaterThan(0);
    expect((await readInvStore('item1')).coverage.ira?.through).toBe('2026-09-24');
    expect(plaid.calls[1].end).toBe('2026-09-24'); // after the first split, the newest half is asked first
  });

  // Temporary by Plaid's own classification, so the backfill waits for it.
  test('a temporary Plaid failure is reported as pending', async () => {
    plaid.onCall = () => {
      throw { response: { status: 503, data: { error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_DOWN' } } };
    };
    const sync = await syncInvestments(ITEM, { now: NOW });
    expect(sync).toMatchObject({ note: 'Investment activity is temporarily unavailable', pending: true });
  });
});

describe('third review: route and shape details', () => {
  const get = async () => {
    const { GET } = await import('@/app/api/investment-activity/route');
    return (await GET(new Request('http://x/api/investment-activity?id=ira&item_id=item1'))).json();
  };

  // Rows fetched live are good for the TTL; without caching, an unwritable
  // store would re-run the full download on every load.
  test('a storage-only problem is cached', async () => {
    await fake.set(key, 'not-a-ciphertext');
    plaid.rows = [row('a', '2026-09-01')];
    expect((await get()).note).toBe('Saved investment history could not be read');
    const again = await get();
    expect(again.from_cache).toBe(true);
  });

  test('a fetch failure and a storage problem are both reported', async () => {
    await fake.set(key, 'not-a-ciphertext');
    plaid.fail = 'ITEM_LOGIN_REQUIRED';
    expect((await get()).note).toBe('This account needs to be reconnected. Saved investment history could not be read');
  });

  test('while another sync does the first download, it says so instead of "no activity"', async () => {
    await fake.set(testKey('invtxns-lock:item1'), 'someone-else', { nx: true, px: 60_000 });
    expect((await get()).note).toBe('Investment activity is still loading');
  });

  test('a stored `cancelled` that is not an object makes the store unreadable, not a crash', async () => {
    await fake.set(key, await encodeJsonBlob({ schema_version: 1, txns: {}, accounts: {}, coverage: {}, securities: {}, cancelled: 'x' }));
    plaid.rows = [row('a', '2026-09-01')];
    const sync = await syncInvestments(ITEM, { now: NOW });
    expect(sync.storeNote).toBe('Saved investment history could not be read');
    expect(ids(sync.rows)).toEqual(['a']);
  });
});
