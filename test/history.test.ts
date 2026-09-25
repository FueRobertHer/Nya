import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, testKey, TEST_CTX, ctxKey, unscopedDataKeys } from './fake-redis';

const ctx = TEST_CTX;

// Real AES-256-GCM, not a stub: encryption sits between every write and read in
// this module, and a round-trip bug would look exactly like a logic bug.
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
// Nothing may be written outside a container (#53).
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const {
  recordSnapshot,
  replaceEstimated,
  replaceEstimatedAccounts,
  replaceEstimatedExtension,
  replaceEstimatedFlat,
  getHistory,
  getAccountHistory,
  estimatedLayerCovers,
  isBackfillDone,
  markBackfillDone,
  clearBackfillDone,
  backfillPendingExhausted,
  clearBackfillPending,
  getLatestAccountSnapshot,
  withTodayPoint,
  recordPartialAccounts,
  bridgeInteriorEstimates,
} = await import('@/lib/history');

const { encrypt } = await import('@/lib/crypto');

/** Writes a real per-account snapshot for a specific date. recordSnapshot only
 *  ever writes today, so backdating has to go through the hash directly. */
async function writeAccountSnapshot(date: string, balances: Record<string, number>) {
  await fake.hset(ctxKey('history:accounts'), { [date]: await encrypt(JSON.stringify(balances)) });
}

type Hidden = Map<string, { type: string; hidden_at: string }>;
const hide = (...entries: [string, string][]): Hidden =>
  new Map(entries.map(([id, type]) => [id, { type, hidden_at: '2026-01-01' }]));

/** Writes an estimated era: totals, per-account walked balances, flat balances. */
async function writeEra(
  dates: string[],
  total: number,
  walked: Record<string, number>,
  flat: Record<string, number>
) {
  await replaceEstimated(ctx, dates.map((date) => ({ date, value: total })));
  await replaceEstimatedAccounts(ctx, dates.map((date) => ({ date, balances: walked })));
  await replaceEstimatedFlat(ctx, dates.map((date) => ({ date, balances: flat })));
}

const valuesByDate = (points: { date: string; value: number }[]) =>
  Object.fromEntries(points.map((p) => [p.date, p.value]));

beforeEach(() => fake.reset());

describe('layer merging', () => {
  test('real points win over estimated ones for the same date', async () => {
    await replaceEstimated(ctx, [
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-02', value: 200 },
    ]);
    await recordSnapshot(ctx, 999);
    const today = new Date().toISOString().slice(0, 10);

    const points = await getHistory(ctx);
    const byDate = valuesByDate(points);
    expect(byDate[today]).toBe(999);
    expect(points.find((p) => p.date === today)!.estimated).toBeUndefined();
    expect(points.find((p) => p.date === '2026-01-01')!.estimated).toBe(true);
  });

  test('points come back sorted by date', async () => {
    await replaceEstimated(ctx, [
      { date: '2026-03-01', value: 3 },
      { date: '2026-01-01', value: 1 },
      { date: '2026-02-01', value: 2 },
    ]);
    expect((await getHistory(ctx)).map((p) => p.date)).toEqual([
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  });
});

describe('replaceRange retention', () => {
  // The regression this guards: the estimated layer used to be deleted
  // wholesale, so a recompute -- which can only reach back as far as the
  // transaction window -- silently truncated the chart for anyone who had been
  // running long enough to have older estimated points. The left edge jumped
  // forward by up to a year.
  test('keeps estimated points older than the new run can reach', async () => {
    await replaceEstimated(ctx, [
      { date: '2024-03-20', value: 500 },
      { date: '2025-06-01', value: 600 },
    ]);
    await replaceEstimated(ctx, [{ date: '2025-06-01', value: 700 }]);

    const byDate = valuesByDate(await getHistory(ctx));
    expect(byDate['2024-03-20']).toBe(500); // orphan retained
    expect(byDate['2025-06-01']).toBe(700); // in-window value replaced
  });

  test('drops in-window dates the new run no longer produces', async () => {
    await replaceEstimated(ctx, [
      { date: '2026-01-01', value: 1 },
      { date: '2026-01-02', value: 2 },
      { date: '2026-01-03', value: 3 },
    ]);
    await replaceEstimated(ctx, [{ date: '2026-01-01', value: 10 }]);

    expect((await getHistory(ctx)).map((p) => p.date)).toEqual(['2026-01-01']);
  });

  test('an empty run keeps everything rather than blanking the layer', async () => {
    await replaceEstimated(ctx, [{ date: '2026-01-01', value: 1 }]);
    await replaceEstimated(ctx, []);
    expect(await getHistory(ctx)).toHaveLength(1);
  });

  test('real snapshots are never touched by an estimated recompute', async () => {
    await recordSnapshot(ctx, 4242, { cash: 4242 });
    await replaceEstimated(ctx, [{ date: '2026-01-01', value: 1 }]);
    await replaceEstimated(ctx, []);
    await replaceEstimatedAccounts(ctx, []);

    const today = new Date().toISOString().slice(0, 10);
    expect(valuesByDate(await getHistory(ctx))[today]).toBe(4242);
  });
});

describe('hidden-account subtraction', () => {
  test('subtracts a walked account by its per-date balance', async () => {
    await replaceEstimated(ctx, [
      { date: '2026-01-01', value: 1000 },
      { date: '2026-01-02', value: 1100 },
    ]);
    await replaceEstimatedAccounts(ctx, [
      { date: '2026-01-01', balances: { cash: 400 } },
      { date: '2026-01-02', balances: { cash: 500 } },
    ]);
    await replaceEstimatedFlat(ctx, [
      { date: '2026-01-01', balances: {} },
      { date: '2026-01-02', balances: {} },
    ]);

    const byDate = valuesByDate(await getHistory(ctx, hide(['cash', 'depository'])));
    expect(byDate['2026-01-01']).toBe(600);
    expect(byDate['2026-01-02']).toBe(600);
  });

  test('subtracts a flat-held account by the balance baked into that date', async () => {
    await writeEra(['2026-01-01'], 1000, { cash: 400 }, { k401: 250 });
    const byDate = valuesByDate(await getHistory(ctx, hide(['k401', 'investment'])));
    expect(byDate['2026-01-01']).toBe(750);
  });

  test('negates credit and loan balances, which are amounts owed', async () => {
    await writeEra(['2026-01-01'], 1000, { card: 200 }, {});
    // The card subtracts -200 from the total, so hiding it raises net worth.
    const byDate = valuesByDate(await getHistory(ctx, hide(['card', 'credit'])));
    expect(byDate['2026-01-01']).toBe(1200);
  });

  test('an account absent from both sources contributed nothing and is left alone', async () => {
    await writeEra(['2026-01-01'], 1000, { cash: 400 }, {});
    const byDate = valuesByDate(await getHistory(ctx, hide(['linked-later', 'depository'])));
    expect(byDate['2026-01-01']).toBe(1000);
  });

  test('subtracts several hidden accounts independently', async () => {
    await writeEra(['2026-01-01'], 1000, { cash: 400 }, { k401: 250 });
    const byDate = valuesByDate(
      await getHistory(ctx, hide(['cash', 'depository'], ['k401', 'investment']))
    );
    expect(byDate['2026-01-01']).toBe(350);
  });

  // THE regression. An account that one run holds flat and the next run walks
  // used to be left in a single merged flat record, which getHistory treats as
  // authoritative and terminal -- so it subtracted the stale flat figure and
  // never consulted the walked balance. Across a retained era that produced a
  // fabricated slope: the exact artifact this feature exists to remove.
  test('an account that moves from flat to walked is subtracted per era, not globally', async () => {
    // Era 1: the 401k is flat at 50,000.
    await writeEra(['2024-06-01'], 100_000, { cash: 1000 }, { k401: 50_000 });
    // Era 2 (a later, shorter window): the same 401k is now walked.
    await writeEra(['2026-01-01'], 120_000, { cash: 1000, k401: 41_000 }, {});

    const byDate = valuesByDate(await getHistory(ctx, hide(['k401', 'investment'])));
    expect(byDate['2024-06-01']).toBe(50_000); // era 1's flat figure
    expect(byDate['2026-01-01']).toBe(79_000); // era 2's walked figure
  });

  test('and the same in reverse, when an account drops back to flat', async () => {
    await writeEra(['2024-06-01'], 100_000, { cash: 1000, k401: 30_000 }, {});
    await writeEra(['2026-01-01'], 120_000, { cash: 1000 }, { k401: 45_000 });

    const byDate = valuesByDate(await getHistory(ctx, hide(['k401', 'investment'])));
    expect(byDate['2024-06-01']).toBe(70_000);
    expect(byDate['2026-01-01']).toBe(75_000);
  });

  test('two eras with different flat balances each use their own', async () => {
    await writeEra(['2024-06-01'], 100_000, {}, { mortgage: 310_000 });
    await writeEra(['2026-01-01'], 120_000, {}, { mortgage: 302_000 });

    const byDate = valuesByDate(await getHistory(ctx, hide(['mortgage', 'loan'])));
    // Loans are owed, so hiding one raises the total by the amount baked in.
    expect(byDate['2024-06-01']).toBe(410_000);
    expect(byDate['2026-01-01']).toBe(422_000);
  });

  test('drops a point whose per-account map is missing rather than showing a spike', async () => {
    // A total with no matching per-account or flat map: recordSnapshot writes
    // the two as separate awaits, so the first can land and the second fail.
    await replaceEstimated(ctx, [{ date: '2026-01-01', value: 1000 }]);
    expect(await getHistory(ctx, hide(['cash', 'depository']))).toHaveLength(0);
  });

  test('real points use the real per-account map, not the estimated one', async () => {
    await recordSnapshot(ctx, 5000, { cash: 1500 });
    const today = new Date().toISOString().slice(0, 10);
    const byDate = valuesByDate(await getHistory(ctx, hide(['cash', 'depository'])));
    expect(byDate[today]).toBe(3500);
  });

  test('an empty hidden set leaves every value untouched', async () => {
    await writeEra(['2026-01-01'], 1000, { cash: 400 }, { k401: 250 });
    expect(valuesByDate(await getHistory(ctx, new Map()))['2026-01-01']).toBe(1000);
    expect(valuesByDate(await getHistory(ctx))['2026-01-01']).toBe(1000);
  });
});

describe('getAccountHistory', () => {
  test('returns one account series, real winning over estimated', async () => {
    await replaceEstimatedAccounts(ctx, [
      { date: '2026-01-01', balances: { cash: 100 } },
      { date: '2026-01-02', balances: { cash: 200 } },
    ]);
    await recordSnapshot(ctx, 0, { cash: 999 });
    const today = new Date().toISOString().slice(0, 10);

    const points = await getAccountHistory(ctx, 'cash');
    expect(valuesByDate(points)['2026-01-01']).toBe(100);
    expect(valuesByDate(points)[today]).toBe(999);
  });

  // Flat-held accounts deliberately get no fabricated sparkline: holding a
  // balance constant and drawing it as history would invent a flat line the
  // data doesn't support.
  test('a flat-held account gets no estimated series', async () => {
    await writeEra(['2026-01-01', '2026-01-02'], 1000, { cash: 400 }, { k401: 250 });
    expect(await getAccountHistory(ctx, 'k401')).toHaveLength(0);
    expect(await getAccountHistory(ctx, 'cash')).toHaveLength(2);
  });
});

describe('the extension layer', () => {
  // Backfill walks an investment account past the oldest cash transaction,
  // where its own flows still have data. Those dates go to their own layer:
  // ACCOUNTS_EST is the account-by-account breakdown of each estimated TOTAL,
  // and these dates are older than the newest run's totals -- which is exactly
  // where an earlier run's totals are retained.
  test('extends an account series past where the totals stop', async () => {
    await replaceEstimatedAccounts(ctx, [{ date: '2026-01-01', balances: { cash: 400, ira: 60_000 } }]);
    await replaceEstimatedExtension(ctx, [{ date: '2025-11-01', balances: { ira: 0 } }], '2026-01-01');

    const series = valuesByDate(await getAccountHistory(ctx, 'ira'));
    expect(series['2025-11-01']).toBe(0);
    expect(series['2026-01-01']).toBe(60_000);
    expect((await getAccountHistory(ctx, 'ira')).every((p) => p.estimated)).toBe(true);
  });

  // The regression this split exists for: the extension used to be merged into
  // ACCOUNTS_EST, which rewrote the per-account breakdown of totals a previous
  // run had left behind. Hiding the account then subtracted this run's balance
  // from that run's total.
  test('never changes what a retained total is subtracted by', async () => {
    // An earlier era: a total, its breakdown, and its flat record.
    await writeEra(['2025-11-01'], 100_000, { cash: 1000, ira: 30_000 }, {});
    // A newer run whose walk reaches that far back only for the investments.
    await replaceEstimatedExtension(ctx, [{ date: '2025-11-01', balances: { ira: 0 } }], '2025-12-01');

    const byDate = valuesByDate(await getHistory(ctx, hide(['ira', 'investment'])));
    expect(byDate['2025-11-01']).toBe(70_000); // the era's own 30k, not the new 0
  });

  // Per account, not per date: the extension names only the investment
  // accounts it walked, so a whole-map preference would drop a cash account's
  // retained point on every date the extension also covers.
  test('leaves accounts it does not name to the other layers', async () => {
    await replaceEstimatedAccounts(ctx, [{ date: '2025-11-01', balances: { cash: 1000, ira: 30_000 } }]);
    await replaceEstimatedExtension(ctx, [{ date: '2025-11-01', balances: { ira: 0 } }], '2025-11-01');

    expect(valuesByDate(await getAccountHistory(ctx, 'cash'))['2025-11-01']).toBe(1000);
    expect(valuesByDate(await getAccountHistory(ctx, 'ira'))['2025-11-01']).toBe(0);
  });

  test('a real snapshot still wins over both', async () => {
    await recordSnapshot(ctx, 0, { ira: 999 });
    const today = new Date().toISOString().slice(0, 10);
    await replaceEstimatedExtension(ctx, [{ date: today, balances: { ira: 0 } }], today);

    const points = await getAccountHistory(ctx, 'ira');
    expect(valuesByDate(points)[today]).toBe(999);
    expect(points[0].estimated).toBeUndefined();
  });

  test('is range-scoped like every other layer', async () => {
    await replaceEstimatedExtension(ctx, 
      [
        { date: '2025-06-01', balances: { ira: 1 } },
        { date: '2025-11-01', balances: { ira: 2 } },
      ],
      '2026-01-01'
    );
    await replaceEstimatedExtension(ctx, [{ date: '2025-11-01', balances: { ira: 3 } }], '2026-01-01');

    const series = valuesByDate(await getAccountHistory(ctx, 'ira'));
    expect(series['2025-06-01']).toBe(1); // orphan retained
    expect(series['2025-11-01']).toBe(3);
  });

  // The regression: a run whose cash history now reaches further back produces
  // NO extension points, and an empty write used to mean "keep everything".
  // The stale span then shadowed the newer walk on the very chart this layer
  // exists to fix, with an artifact step at the seam.
  test('an empty run still clears the span the full walk now covers', async () => {
    await replaceEstimatedExtension(ctx, [{ date: '2026-01-01', balances: { ira: 58_000 } }], '2026-02-01');
    // The next run walks everything from 2026-01-01, so it writes no extension.
    await replaceEstimatedAccounts(ctx, [{ date: '2026-01-01', balances: { cash: 10, ira: 70_000 } }]);
    await replaceEstimatedExtension(ctx, [], '2026-01-01');

    expect(valuesByDate(await getAccountHistory(ctx, 'ira'))['2026-01-01']).toBe(70_000);
  });

  test('but keeps the span the full walk still cannot reach', async () => {
    await replaceEstimatedExtension(ctx, [{ date: '2025-06-01', balances: { ira: 1 } }], '2026-02-01');
    await replaceEstimatedExtension(ctx, [], '2026-01-01');

    expect(valuesByDate(await getAccountHistory(ctx, 'ira'))['2025-06-01']).toBe(1);
  });
});

describe('estimatedLayerCovers', () => {
  test('finds walked and flat accounts, and misses unknown ones', async () => {
    await writeEra(['2026-01-01'], 1000, { cash: 400 }, { k401: 250 });
    expect(await estimatedLayerCovers(ctx, 'cash')).toBe(true);
    expect(await estimatedLayerCovers(ctx, 'k401')).toBe(true);
    expect(await estimatedLayerCovers(ctx, 'never-seen')).toBe(false);
  });

  test('reports not-covered on an empty layer, so the caller forces a recompute', async () => {
    expect(await estimatedLayerCovers(ctx, 'anything')).toBe(false);
  });

  // The newest date is the one the newest run wrote, and it holds every
  // account that run walked. Older dates can be an investment-only tail (the
  // walk reaching past the cash horizon) or a retained era from a run with a
  // different account set, and sampling one of those would under-report a cash
  // account and force a recompute on nearly every hide.
  test('answers from the newest date, not an arbitrary one', async () => {
    await replaceEstimatedAccounts(ctx, [
      { date: '2026-01-01', balances: { k401: 250 } },
      { date: '2026-02-01', balances: { cash: 400, k401: 250 } },
    ]);
    expect(await estimatedLayerCovers(ctx, 'cash')).toBe(true);
  });
});

describe('getLatestAccountSnapshot', () => {
  /** N days before today, as the UTC key recordSnapshot would have written. */
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  test('returns the newest snapshot, whole', async () => {
    await writeAccountSnapshot(daysAgo(4), { card: 100 });
    await writeAccountSnapshot(daysAgo(2), { card: 150, checking: 200 });

    expect(await getLatestAccountSnapshot(ctx)).toEqual({
      date: daysAgo(2),
      balances: { card: 150, checking: 200 },
    });
  });

  // THE guard against resurrecting closed accounts. The transactions store
  // never forgets an account, so the only thing that can say a card was closed
  // is its absence from a day when its institution was demonstrably working --
  // and a snapshot exists only for such days. Searching back for the account
  // would find its last balance and put a paid-off, closed card back on screen.
  test('does not search backwards for an account the newest snapshot omits', async () => {
    await writeAccountSnapshot(daysAgo(4), { card: 100, closed_card: 4000 });
    await writeAccountSnapshot(daysAgo(2), { card: 150 });

    const last = await getLatestAccountSnapshot(ctx);
    expect(last!.date).toBe(daysAgo(2));
    expect(last!.balances.closed_card).toBeUndefined();
  });

  test('skips an undecryptable date rather than giving up', async () => {
    await writeAccountSnapshot(daysAgo(4), { card: 100 });
    await fake.hset(ctxKey('history:accounts'), { [daysAgo(2)]: 'not-ciphertext' });

    expect(await getLatestAccountSnapshot(ctx)).toEqual({
      date: daysAgo(4),
      balances: { card: 100 },
    });
  });

  // Age is the caller's policy, not this function's: lib/last-known.ts needs
  // the date even when it's too old to present, so it can say "too old" rather
  // than silently showing nothing.
  test('returns an old snapshot rather than deciding it is too old', async () => {
    for (let m = 1; m <= 13; m++) await writeAccountSnapshot(daysAgo(m * 40), { card: 100 });
    expect((await getLatestAccountSnapshot(ctx))!.date).toBe(daysAgo(40));
  });

  // Reads the date keys, then fetches only the winner. hgetall would pull every
  // date since install, each an encrypted map of every account, to decrypt one
  // -- on the degraded path, growing forever.
  test('fetches one date rather than the whole hash', async () => {
    for (let d = 1; d <= 20; d++) await writeAccountSnapshot(daysAgo(d), { card: d });
    fake.ops = 0;

    expect((await getLatestAccountSnapshot(ctx))!.balances).toEqual({ card: 1 });
    expect(fake.ops).toBe(2); // hkeys, then one hget
  });

  // Keys come from toISOString() on whichever machine recorded them, so clock
  // skew can mint a future one -- and it would otherwise win every lookup from
  // then on, indefinitely.
  test('ignores a future-dated key', async () => {
    await writeAccountSnapshot(daysAgo(2), { card: 100 });
    await writeAccountSnapshot(daysAgo(-5), { card: 999 });

    expect(await getLatestAccountSnapshot(ctx)).toEqual({
      date: daysAgo(2),
      balances: { card: 100 },
    });
  });

  test('null on an empty layer, and skips a date whose balances are all unusable', async () => {
    expect(await getLatestAccountSnapshot(ctx)).toBeNull();

    await writeAccountSnapshot(daysAgo(4), { card: 100 });
    await writeAccountSnapshot(daysAgo(2), { card: 'lots' as unknown as number });
    expect(await getLatestAccountSnapshot(ctx)).toEqual({
      date: daysAgo(4),
      balances: { card: 100 },
    });
  });

  // Reconstructed figures must never be presented as observed ones.
  test('ignores the estimated layer entirely', async () => {
    await replaceEstimatedAccounts(ctx, [{ date: daysAgo(2), balances: { card: 999 } }]);
    expect(await getLatestAccountSnapshot(ctx)).toBeNull();
  });
});

describe('backfill schema flag', () => {
  test('an unset flag means not done', async () => {
    expect(await isBackfillDone(ctx)).toBe(false);
  });

  test('marking done makes it done', async () => {
    await markBackfillDone(ctx);
    expect(await isBackfillDone(ctx)).toBe(true);
  });

  // The migration path: a layer built by the previous algorithm carries the
  // legacy '1'. Without this the improvement would only ever reach new users.
  test('a legacy flag value forces a recompute', async () => {
    await fake.set(ctxKey('history:backfill-done'), '1');
    expect(await isBackfillDone(ctx)).toBe(false);
  });

  test('clearing forces a recompute', async () => {
    await markBackfillDone(ctx);
    await clearBackfillDone(ctx);
    expect(await isBackfillDone(ctx)).toBe(false);
  });
});

// Backfill withholds the done-flag while an Item's investment data is still
// importing, so the next load rebuilds with the flows. This is what stops that
// being unbounded: a wedged extraction would otherwise re-run every
// institution's full Plaid pull on every app open, forever.
describe('the pending-run count', () => {
  test('counts runs and reports when the wait is spent', async () => {
    expect(await backfillPendingExhausted(ctx, 3)).toBe(false); // 1
    expect(await backfillPendingExhausted(ctx, 3)).toBe(false); // 2
    expect(await backfillPendingExhausted(ctx, 3)).toBe(true); // 3
  });

  test('clearing starts the wait over', async () => {
    await backfillPendingExhausted(ctx, 2);
    await clearBackfillPending(ctx);
    expect(await backfillPendingExhausted(ctx, 2)).toBe(false);
  });

  // An uncountable wait is an unbounded one, so it reports spent.
  test('an unreadable counter gives up rather than waiting forever', async () => {
    // Delegates to the real fake for everything else, so this stays a test
    // about one failing command rather than about a half-built stub.
    const broken: FakeRedis = Object.create(fake, {
      incr: { value: async () => { throw new Error('down'); } },
    });
    mock.module('@/lib/storage', () => storageMock(broken));
    try {
      expect(await backfillPendingExhausted(ctx, 5)).toBe(true);
    } finally {
      mock.module('@/lib/storage', () => storageMock(fake));
    }
  });
});

// /api/net-worth now issues getHistory(ctx) alongside the Plaid fetch, so the
// series it gets back predates the snapshot that same request records. This is
// what puts today's point back, and it is the only thing standing between the
// chart and a total it disagrees with.
describe('withTodayPoint', () => {
  const p = (date: string, value: number) => ({ date, value });

  test('appends today when the series has no point for it', () => {
    expect(withTodayPoint([p('2026-09-19', 10), p('2026-09-20', 20)], '2026-09-21', 30)).toEqual([
      p('2026-09-19', 10),
      p('2026-09-20', 20),
      p('2026-09-21', 30),
    ]);
  });

  // The common case, not an edge one: any second load on the same day reads a
  // point an earlier load already wrote. Keeping both would put two points on
  // one date; keeping the older one would show a figure the hero has moved past.
  test('replaces a point an earlier load wrote for today', () => {
    expect(withTodayPoint([p('2026-09-20', 20), p('2026-09-21', 25)], '2026-09-21', 30)).toEqual([
      p('2026-09-20', 20),
      p('2026-09-21', 30),
    ]);
  });

  // getHistory drops a real point it cannot correct for a hidden account, and
  // today's is exactly the point it has live figures for. Re-adding it is the
  // correction, not a bypass: `visible` is the same subtraction applied to
  // today's balances.
  test('restores today even when the stored series omitted it entirely', () => {
    expect(withTodayPoint([], '2026-09-21', 30)).toEqual([p('2026-09-21', 30)]);
  });

  test('stays sorted when the stored series is not', () => {
    expect(withTodayPoint([p('2026-09-20', 20), p('2026-09-18', 5)], '2026-09-19', 9)).toEqual([
      p('2026-09-18', 5),
      p('2026-09-19', 9),
      p('2026-09-20', 20),
    ]);
  });

  // Today is measured, so it must never carry the estimated flag -- the chart
  // draws those dashed, and a real point rendered as a guess undersells the
  // one number the user actually came to see.
  test("today's point is real, and displaces an estimated one for the same date", () => {
    const out = withTodayPoint(
      [{ date: '2026-09-21', value: 12, estimated: true }],
      '2026-09-21',
      30
    );
    expect(out).toEqual([p('2026-09-21', 30)]);
    expect(out[0].estimated).toBeUndefined();
  });

  test('does not mutate the series it was given', () => {
    const stored = [p('2026-09-20', 20)];
    withTodayPoint(stored, '2026-09-21', 30);
    expect(stored).toEqual([p('2026-09-20', 20)]);
  });
});

// The two writes fail independently, and the return value is what /api/net-worth
// uses to decide whether today's point exists. Conflating them hid a point that
// was genuinely in the chart's own layer.
describe('recordSnapshot return value', () => {
  test('returns the date key it wrote', async () => {
    fake.reset();
    const today = new Date().toISOString().slice(0, 10);
    expect(await recordSnapshot(ctx, 123, { cash: 123 })).toBe(today);
  });

  test('returns null when the total itself could not be written', async () => {
    fake.reset();
    const hset = fake.hset.bind(fake);
    fake.hset = async () => {
      throw new Error('upstash down');
    };
    try {
      expect(await recordSnapshot(ctx, 123, { cash: 123 })).toBeNull();
    } finally {
      fake.hset = hset;
    }
  });

  // THE REGRESSION. A transient failure on the second write used to report the
  // whole snapshot as missed, so the route suppressed today's point while the
  // total sat in history:net-worth -- a chart ending yesterday under a hero
  // showing today, cached for the next 15 minutes.
  test('still returns the date when only the per-account map failed', async () => {
    fake.reset();
    const today = new Date().toISOString().slice(0, 10);
    const hset = fake.hset.bind(fake);
    let calls = 0;
    fake.hset = async (key: string, fields: Record<string, string>) => {
      if (++calls === 2) throw new Error('upstash down');
      return hset(key, fields);
    };
    try {
      expect(await recordSnapshot(ctx, 4242, { cash: 4242 })).toBe(today);
    } finally {
      fake.hset = hset;
    }

    // The total really is in the layer, which is what makes charting it honest.
    expect(valuesByDate(await getHistory(ctx))[today]).toBe(4242);
    // ...and the breakdown really is absent, so a hidden account can't be
    // subtracted from this date later. getHistory drops it rather than showing
    // it uncorrected; /api/net-worth re-adds it from live figures instead.
    expect(await getHistory(ctx, hide(['cash', 'depository']))).toHaveLength(0);
  });
});

// One failing institution used to turn every other account's chart into an
// estimate, because nothing at all was recorded on a day the total couldn't be.
describe('the partial per-account layer', () => {
  const today = () => new Date().toISOString().slice(0, 10);
  const partialKey = () => ctxKey('history:accounts:partial');

  test('a measured balance beats the estimate, and is not marked estimated', async () => {
    await replaceEstimatedAccounts(ctx, [{ date: today(), balances: { ira: 1 } }]);
    await recordPartialAccounts(ctx, { ira: 500 });

    const points = await getAccountHistory(ctx, 'ira');
    expect(points).toEqual([{ date: today(), value: 500 }]);
  });

  test('a real snapshot beats it', async () => {
    await recordPartialAccounts(ctx, { ira: 500 });
    await recordSnapshot(ctx, 900, { ira: 900 });

    expect(valuesByDate(await getAccountHistory(ctx, 'ira'))[today()]).toBe(900);
  });

  // The failing institution's accounts are exactly the ones a partial map
  // leaves out. For them absence means "not measured", not "gone".
  test('an account it does not name falls through to the estimate', async () => {
    await replaceEstimatedAccounts(ctx, [{ date: today(), balances: { cash: 40 } }]);
    await recordPartialAccounts(ctx, { ira: 500 });

    expect(await getAccountHistory(ctx, 'cash')).toEqual([{ date: today(), value: 40, estimated: true }]);
  });

  // A real map is authoritative even when it can't be read: falling through
  // would put an estimated figure on a date that has a real answer.
  test('an unreadable real map is a gap, not an estimate', async () => {
    await replaceEstimatedAccounts(ctx, [{ date: today(), balances: { ira: 1 } }]);
    await fake.hset(ctxKey('history:accounts'), { [today()]: 'not-a-ciphertext' });

    expect(await getAccountHistory(ctx, 'ira')).toEqual([]);
  });

  // recordSnapshot clears today's partial map, so one beside a real map was
  // written later: the newer reading, possibly of an account the snapshot
  // never saw.
  test('a partial reading taken after the snapshot wins for the accounts it names', async () => {
    await recordSnapshot(ctx, 900, { ira: 900, cash: 50 });
    await recordPartialAccounts(ctx, { ira: 950, opened_today: 20 });

    expect(valuesByDate(await getAccountHistory(ctx, 'ira'))[today()]).toBe(950);
    expect(valuesByDate(await getAccountHistory(ctx, 'opened_today'))[today()]).toBe(20);
    expect(valuesByDate(await getAccountHistory(ctx, 'cash'))[today()]).toBe(50);
  });

  test('a snapshot clears the partial reading taken before it', async () => {
    await recordPartialAccounts(ctx, { ira: 500 });
    await recordSnapshot(ctx, 900, { ira: 900 });

    expect(await fake.hkeys(partialKey())).toEqual([]);
  });

  // The per-account write failing leaves no real breakdown for today, so the
  // earlier partial reading is the only measurement the charts have.
  test('keeps the partial reading when the snapshot breakdown fails to write', async () => {
    await recordPartialAccounts(ctx, { ira: 500 });
    const hset = fake.hset.bind(fake);
    let calls = 0;
    fake.hset = (async (...args: Parameters<typeof hset>) => {
      if (++calls === 2) throw new Error('upstash down'); // the breakdown, after the total
      return hset(...args);
    }) as typeof fake.hset;
    try {
      await recordSnapshot(ctx, 900, { ira: 900 });
    } finally {
      fake.hset = hset;
    }

    expect(valuesByDate(await getAccountHistory(ctx, 'ira'))[today()]).toBe(500);
  });

  // It is the breakdown of no stored total, so the totals series and the
  // hidden-account subtraction must never see it.
  // A real total with no breakdown of its own must still be dropped when an
  // account is hidden: reading the partial map as that breakdown would
  // subtract a number the total was never built from.
  test('never reaches the totals series', async () => {
    await fake.hset(ctxKey('history:net-worth'), { [today()]: await encrypt('1000') });
    await recordPartialAccounts(ctx, { ira: 500 });

    expect(await getHistory(ctx)).toEqual([{ date: today(), value: 1000 }]);
    expect(await getHistory(ctx, hide(['ira', 'investment']))).toEqual([]);
  });

  // getLatestAccountSnapshot assumes its newest date names every account, and
  // a partial map leaves the failing institution out by definition.
  test('is invisible to the last-known lookup', async () => {
    await writeAccountSnapshot('2026-01-01', { ira: 100, cash: 50 });
    await recordPartialAccounts(ctx, { ira: 500 });

    expect(await getLatestAccountSnapshot(ctx)).toEqual({ date: '2026-01-01', balances: { ira: 100, cash: 50 } });
  });

  test('merges a second write on the same day, newer values winning', async () => {
    await recordPartialAccounts(ctx, { ira: 500, cash: 40 });
    await recordPartialAccounts(ctx, { ira: 600 });

    expect(valuesByDate(await getAccountHistory(ctx, 'ira'))[today()]).toBe(600);
    expect(valuesByDate(await getAccountHistory(ctx, 'cash'))[today()]).toBe(40);
  });

  test('skips the write when today cannot be read, rather than clobbering it', async () => {
    await recordPartialAccounts(ctx, { cash: 40 });
    fake.failNext('hget');
    await recordPartialAccounts(ctx, { ira: 600 });

    expect(valuesByDate(await getAccountHistory(ctx, 'cash'))[today()]).toBe(40);
    expect(await getAccountHistory(ctx, 'ira')).toEqual([]);
  });

  test('skips the write when today cannot be decrypted', async () => {
    await fake.hset(partialKey(), { [today()]: 'not-a-ciphertext' });
    await recordPartialAccounts(ctx, { ira: 600 });

    expect(await fake.hget<string>(partialKey(), today())).toBe('not-a-ciphertext');
  });

  test('writes nothing for an empty map', async () => {
    await recordPartialAccounts(ctx, {});
    expect(await fake.hkeys(partialKey())).toEqual([]);
  });
});

// Inside a hole between two recorded days, the backward walk can be wrong in
// level by whole accounts (a deleted manual account, a rollover from it), so
// the total draws a straight line between the real ends instead.
describe('bridgeInteriorEstimates', () => {
  const r = (date: string, value: number) => ({ date, value });
  const e = (date: string, value: number) => ({ date, value, estimated: true });

  test('draws a straight line across an interior run, still estimated', () => {
    expect(
      bridgeInteriorEstimates([
        r('2026-09-01', 100),
        e('2026-09-02', 10),
        e('2026-09-03', 999),
        e('2026-09-04', 10),
        r('2026-09-05', 200),
      ])
    ).toEqual([
      r('2026-09-01', 100),
      e('2026-09-02', 125),
      e('2026-09-03', 150),
      e('2026-09-04', 175),
      r('2026-09-05', 200),
    ]);
  });

  // By date, not by index: the run can itself have missing days.
  test('interpolates by date when the run skips days', () => {
    expect(
      bridgeInteriorEstimates([r('2026-09-01', 0), e('2026-09-04', 5), r('2026-09-05', 400)])
    ).toEqual([r('2026-09-01', 0), e('2026-09-04', 300), r('2026-09-05', 400)]);
  });

  // Before the first real point the walk is all there is, and after the last
  // one there is no second end to draw a line to.
  test('leaves leading and trailing estimates alone', () => {
    const points = [e('2026-08-30', 7), r('2026-09-01', 100), e('2026-09-02', 3)];
    expect(bridgeInteriorEstimates(points)).toEqual(points);
  });

  test('does not mutate what it is given', () => {
    const points = [r('2026-09-01', 100), e('2026-09-02', 10), r('2026-09-03', 200)];
    bridgeInteriorEstimates(points);
    expect(points[1]).toEqual(e('2026-09-02', 10));
  });

  test('is idempotent', () => {
    const once = bridgeInteriorEstimates([r('2026-09-01', 100), e('2026-09-02', 10), r('2026-09-04', 400)]);
    expect(bridgeInteriorEstimates(once)).toEqual(once);
  });

  // getHistory bridges AFTER subtracting hidden accounts, so the line runs
  // between the values the chart actually shows at each end.
  test('getHistory bridges between the visible real values', async () => {
    const realTotal = async (date: string, value: number, balances: Record<string, number>) => {
      await fake.hset(ctxKey('history:net-worth'), { [date]: await encrypt(String(value)) });
      await writeAccountSnapshot(date, balances);
    };
    await realTotal('2026-09-01', 1000, { cash: 600, ira: 400 });
    await realTotal('2026-09-03', 1400, { cash: 1000, ira: 400 });
    await writeEra(['2026-09-02'], 50, { cash: 50 }, { ira: 0 });

    expect(await getHistory(ctx, hide(['ira', 'investment']))).toEqual([
      r('2026-09-01', 600),
      e('2026-09-02', 800),
      r('2026-09-03', 1000),
    ]);
  });

  // The request's own snapshot is added after getHistory, and can be the real
  // point that closes a hole getHistory saw as trailing.
  test('withTodayPoint bridges a run that today closes', () => {
    expect(withTodayPoint([r('2026-09-19', 100), e('2026-09-20', 5)], '2026-09-21', 300)).toEqual([
      r('2026-09-19', 100),
      e('2026-09-20', 200),
      r('2026-09-21', 300),
    ]);
  });
});
