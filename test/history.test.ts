import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

// Real AES-256-GCM, not a stub: encryption sits between every write and read in
// this module, and a round-trip bug would look exactly like a logic bug.
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const {
  recordSnapshot,
  replaceEstimated,
  replaceEstimatedAccounts,
  replaceEstimatedFlat,
  getHistory,
  getAccountHistory,
  estimatedLayerCovers,
  isBackfillDone,
  markBackfillDone,
  clearBackfillDone,
  getLatestAccountSnapshot,
} = await import('@/lib/history');

const { encrypt } = await import('@/lib/crypto');

/** Writes a real per-account snapshot for a specific date. recordSnapshot only
 *  ever writes today, so backdating has to go through the hash directly. */
async function writeAccountSnapshot(date: string, balances: Record<string, number>) {
  await fake.hset('test:history:accounts', { [date]: await encrypt(JSON.stringify(balances)) });
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
  await replaceEstimated(dates.map((date) => ({ date, value: total })));
  await replaceEstimatedAccounts(dates.map((date) => ({ date, balances: walked })));
  await replaceEstimatedFlat(dates.map((date) => ({ date, balances: flat })));
}

const valuesByDate = (points: { date: string; value: number }[]) =>
  Object.fromEntries(points.map((p) => [p.date, p.value]));

beforeEach(() => fake.reset());

describe('layer merging', () => {
  test('real points win over estimated ones for the same date', async () => {
    await replaceEstimated([
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-02', value: 200 },
    ]);
    await recordSnapshot(999);
    const today = new Date().toISOString().slice(0, 10);

    const points = await getHistory();
    const byDate = valuesByDate(points);
    expect(byDate[today]).toBe(999);
    expect(points.find((p) => p.date === today)!.estimated).toBeUndefined();
    expect(points.find((p) => p.date === '2026-01-01')!.estimated).toBe(true);
  });

  test('points come back sorted by date', async () => {
    await replaceEstimated([
      { date: '2026-03-01', value: 3 },
      { date: '2026-01-01', value: 1 },
      { date: '2026-02-01', value: 2 },
    ]);
    expect((await getHistory()).map((p) => p.date)).toEqual([
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
    await replaceEstimated([
      { date: '2024-03-20', value: 500 },
      { date: '2025-06-01', value: 600 },
    ]);
    await replaceEstimated([{ date: '2025-06-01', value: 700 }]);

    const byDate = valuesByDate(await getHistory());
    expect(byDate['2024-03-20']).toBe(500); // orphan retained
    expect(byDate['2025-06-01']).toBe(700); // in-window value replaced
  });

  test('drops in-window dates the new run no longer produces', async () => {
    await replaceEstimated([
      { date: '2026-01-01', value: 1 },
      { date: '2026-01-02', value: 2 },
      { date: '2026-01-03', value: 3 },
    ]);
    await replaceEstimated([{ date: '2026-01-01', value: 10 }]);

    expect((await getHistory()).map((p) => p.date)).toEqual(['2026-01-01']);
  });

  test('an empty run keeps everything rather than blanking the layer', async () => {
    await replaceEstimated([{ date: '2026-01-01', value: 1 }]);
    await replaceEstimated([]);
    expect(await getHistory()).toHaveLength(1);
  });

  test('real snapshots are never touched by an estimated recompute', async () => {
    await recordSnapshot(4242, { cash: 4242 });
    await replaceEstimated([{ date: '2026-01-01', value: 1 }]);
    await replaceEstimated([]);
    await replaceEstimatedAccounts([]);

    const today = new Date().toISOString().slice(0, 10);
    expect(valuesByDate(await getHistory())[today]).toBe(4242);
  });
});

describe('hidden-account subtraction', () => {
  test('subtracts a walked account by its per-date balance', async () => {
    await replaceEstimated([
      { date: '2026-01-01', value: 1000 },
      { date: '2026-01-02', value: 1100 },
    ]);
    await replaceEstimatedAccounts([
      { date: '2026-01-01', balances: { cash: 400 } },
      { date: '2026-01-02', balances: { cash: 500 } },
    ]);
    await replaceEstimatedFlat([
      { date: '2026-01-01', balances: {} },
      { date: '2026-01-02', balances: {} },
    ]);

    const byDate = valuesByDate(await getHistory(hide(['cash', 'depository'])));
    expect(byDate['2026-01-01']).toBe(600);
    expect(byDate['2026-01-02']).toBe(600);
  });

  test('subtracts a flat-held account by the balance baked into that date', async () => {
    await writeEra(['2026-01-01'], 1000, { cash: 400 }, { k401: 250 });
    const byDate = valuesByDate(await getHistory(hide(['k401', 'investment'])));
    expect(byDate['2026-01-01']).toBe(750);
  });

  test('negates credit and loan balances, which are amounts owed', async () => {
    await writeEra(['2026-01-01'], 1000, { card: 200 }, {});
    // The card subtracts -200 from the total, so hiding it raises net worth.
    const byDate = valuesByDate(await getHistory(hide(['card', 'credit'])));
    expect(byDate['2026-01-01']).toBe(1200);
  });

  test('an account absent from both sources contributed nothing and is left alone', async () => {
    await writeEra(['2026-01-01'], 1000, { cash: 400 }, {});
    const byDate = valuesByDate(await getHistory(hide(['linked-later', 'depository'])));
    expect(byDate['2026-01-01']).toBe(1000);
  });

  test('subtracts several hidden accounts independently', async () => {
    await writeEra(['2026-01-01'], 1000, { cash: 400 }, { k401: 250 });
    const byDate = valuesByDate(
      await getHistory(hide(['cash', 'depository'], ['k401', 'investment']))
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

    const byDate = valuesByDate(await getHistory(hide(['k401', 'investment'])));
    expect(byDate['2024-06-01']).toBe(50_000); // era 1's flat figure
    expect(byDate['2026-01-01']).toBe(79_000); // era 2's walked figure
  });

  test('and the same in reverse, when an account drops back to flat', async () => {
    await writeEra(['2024-06-01'], 100_000, { cash: 1000, k401: 30_000 }, {});
    await writeEra(['2026-01-01'], 120_000, { cash: 1000 }, { k401: 45_000 });

    const byDate = valuesByDate(await getHistory(hide(['k401', 'investment'])));
    expect(byDate['2024-06-01']).toBe(70_000);
    expect(byDate['2026-01-01']).toBe(75_000);
  });

  test('two eras with different flat balances each use their own', async () => {
    await writeEra(['2024-06-01'], 100_000, {}, { mortgage: 310_000 });
    await writeEra(['2026-01-01'], 120_000, {}, { mortgage: 302_000 });

    const byDate = valuesByDate(await getHistory(hide(['mortgage', 'loan'])));
    // Loans are owed, so hiding one raises the total by the amount baked in.
    expect(byDate['2024-06-01']).toBe(410_000);
    expect(byDate['2026-01-01']).toBe(422_000);
  });

  test('drops a point whose per-account map is missing rather than showing a spike', async () => {
    // A total with no matching per-account or flat map: recordSnapshot writes
    // the two as separate awaits, so the first can land and the second fail.
    await replaceEstimated([{ date: '2026-01-01', value: 1000 }]);
    expect(await getHistory(hide(['cash', 'depository']))).toHaveLength(0);
  });

  test('real points use the real per-account map, not the estimated one', async () => {
    await recordSnapshot(5000, { cash: 1500 });
    const today = new Date().toISOString().slice(0, 10);
    const byDate = valuesByDate(await getHistory(hide(['cash', 'depository'])));
    expect(byDate[today]).toBe(3500);
  });

  test('an empty hidden set leaves every value untouched', async () => {
    await writeEra(['2026-01-01'], 1000, { cash: 400 }, { k401: 250 });
    expect(valuesByDate(await getHistory(new Map()))['2026-01-01']).toBe(1000);
    expect(valuesByDate(await getHistory())['2026-01-01']).toBe(1000);
  });
});

describe('getAccountHistory', () => {
  test('returns one account series, real winning over estimated', async () => {
    await replaceEstimatedAccounts([
      { date: '2026-01-01', balances: { cash: 100 } },
      { date: '2026-01-02', balances: { cash: 200 } },
    ]);
    await recordSnapshot(0, { cash: 999 });
    const today = new Date().toISOString().slice(0, 10);

    const points = await getAccountHistory('cash');
    expect(valuesByDate(points)['2026-01-01']).toBe(100);
    expect(valuesByDate(points)[today]).toBe(999);
  });

  // Flat-held accounts deliberately get no fabricated sparkline: holding a
  // balance constant and drawing it as history would invent a flat line the
  // data doesn't support.
  test('a flat-held account gets no estimated series', async () => {
    await writeEra(['2026-01-01', '2026-01-02'], 1000, { cash: 400 }, { k401: 250 });
    expect(await getAccountHistory('k401')).toHaveLength(0);
    expect(await getAccountHistory('cash')).toHaveLength(2);
  });
});

describe('estimatedLayerCovers', () => {
  test('finds walked and flat accounts, and misses unknown ones', async () => {
    await writeEra(['2026-01-01'], 1000, { cash: 400 }, { k401: 250 });
    expect(await estimatedLayerCovers('cash')).toBe(true);
    expect(await estimatedLayerCovers('k401')).toBe(true);
    expect(await estimatedLayerCovers('never-seen')).toBe(false);
  });

  test('reports not-covered on an empty layer, so the caller forces a recompute', async () => {
    expect(await estimatedLayerCovers('anything')).toBe(false);
  });
});

describe('getLatestAccountSnapshot', () => {
  /** N days before today, as the UTC key recordSnapshot would have written. */
  const daysAgo = (n: number) =>
    new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

  test('returns the newest snapshot, whole', async () => {
    await writeAccountSnapshot(daysAgo(4), { card: 100 });
    await writeAccountSnapshot(daysAgo(2), { card: 150, checking: 200 });

    expect(await getLatestAccountSnapshot()).toEqual({
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

    const last = await getLatestAccountSnapshot();
    expect(last!.date).toBe(daysAgo(2));
    expect(last!.balances.closed_card).toBeUndefined();
  });

  test('skips an undecryptable date rather than giving up', async () => {
    await writeAccountSnapshot(daysAgo(4), { card: 100 });
    await fake.hset('test:history:accounts', { [daysAgo(2)]: 'not-ciphertext' });

    expect(await getLatestAccountSnapshot()).toEqual({
      date: daysAgo(4),
      balances: { card: 100 },
    });
  });

  // Age is the caller's policy, not this function's: lib/last-known.ts needs
  // the date even when it's too old to present, so it can say "too old" rather
  // than silently showing nothing.
  test('returns an old snapshot rather than deciding it is too old', async () => {
    for (let m = 1; m <= 13; m++) await writeAccountSnapshot(daysAgo(m * 40), { card: 100 });
    expect((await getLatestAccountSnapshot())!.date).toBe(daysAgo(40));
  });

  // Keys come from toISOString() on whichever machine recorded them, so clock
  // skew can mint a future one -- and it would otherwise win every lookup from
  // then on, indefinitely.
  test('ignores a future-dated key', async () => {
    await writeAccountSnapshot(daysAgo(2), { card: 100 });
    await writeAccountSnapshot(daysAgo(-5), { card: 999 });

    expect(await getLatestAccountSnapshot()).toEqual({
      date: daysAgo(2),
      balances: { card: 100 },
    });
  });

  test('null on an empty layer, and skips a date whose balances are all unusable', async () => {
    expect(await getLatestAccountSnapshot()).toBeNull();

    await writeAccountSnapshot(daysAgo(4), { card: 100 });
    await writeAccountSnapshot(daysAgo(2), { card: 'lots' as unknown as number });
    expect(await getLatestAccountSnapshot()).toEqual({
      date: daysAgo(4),
      balances: { card: 100 },
    });
  });

  // Reconstructed figures must never be presented as observed ones.
  test('ignores the estimated layer entirely', async () => {
    await replaceEstimatedAccounts([{ date: daysAgo(2), balances: { card: 999 } }]);
    expect(await getLatestAccountSnapshot()).toBeNull();
  });
});

describe('backfill schema flag', () => {
  test('an unset flag means not done', async () => {
    expect(await isBackfillDone()).toBe(false);
  });

  test('marking done makes it done', async () => {
    await markBackfillDone();
    expect(await isBackfillDone()).toBe(true);
  });

  // The migration path: a layer built by the previous algorithm carries the
  // legacy '1'. Without this the improvement would only ever reach new users.
  test('a legacy flag value forces a recompute', async () => {
    await fake.set('test:history:backfill-done', '1');
    expect(await isBackfillDone()).toBe(false);
  });

  test('clearing forces a recompute', async () => {
    await markBackfillDone();
    await clearBackfillDone();
    expect(await isBackfillDone()).toBe(false);
  });
});
