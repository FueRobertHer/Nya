import { expect, test, mock, afterEach } from 'bun:test';
import { FakeRedis, storageMock, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The shared fixture (test/api-fixture.ts) dates what it seeds from one
// reading of the clock (TIMES FOLLOW THE CLOCK AT SEEDING): read again for
// each row, a seeding that crossed UTC midnight would date its rows a day
// apart, and a test comparing them would fail on that night only.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { daysAgo, seedPerson, syncedAt } = await import('./api-fixture');

test('every day it seeds is worked out from one reading of the clock, even a moment before midnight', async () => {
  fake.reset();
  await registerTestContainer(fake);
  const start = Date.parse('2026-10-10T23:59:59.900Z');
  const real = Date.now;
  let reads = 0;
  // Each reading a second after the one before, so every one after the
  // first is on the next day.
  Date.now = () => start + 1000 * reads++;
  let seeded: Awaited<ReturnType<typeof seedPerson>>;
  try {
    seeded = await seedPerson(fake);
  } finally {
    Date.now = real;
  }
  expect(seeded.syncedAt).toBe(syncedAt(start));
  const dates = new Map(seeded.chaseTxns.map((t) => [t.transaction_id, t.date]));
  expect([dates.get('t_posted'), dates.get('t_coffee'), dates.get('t_big')]).toEqual(['2026-10-09', '2026-10-08', '2026-10-01']);
  for (const t of seeded.chaseTxns) expect(t.date <= '2026-10-09').toBe(true);
  // The days recorded for those rows' balances agree with them.
  expect([...fake.hashes.get(ctxKey('history:accounts'))!.keys()].sort()).toEqual([daysAgo(3, start), daysAgo(2, start)]);
  expect([...fake.hashes.get(ctxKey('history:accounts:partial'))!.keys()]).toEqual(['2026-10-09']);
  expect([...fake.hashes.get(ctxKey('snapshot:taken'))!.keys()]).toEqual(['2026-10-08']);
});
