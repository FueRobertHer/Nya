import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { Planned, PlannedItem } from '@/lib/planned';

// The forecast's planned items (lib/planned.ts): the strict check a save goes
// through, the days each item falls on, and the store and route on the
// storage seam (lib/planned-store.ts, app/api/planned-items).

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt, decrypt } = await import('@/lib/crypto');
const { StoredDataUnreadableError, UnreadableValueError } = await import('@/lib/repo');
const { declaredStore } = await import('@/lib/stores');
const { classify } = await import('@/lib/reencrypt');
const { plannedStore } = await import('@/lib/planned-store');
const route = await import('@/app/api/planned-items/route');
const {
  EMPTY_PLANNED,
  DEFAULT_THRESHOLD,
  MAX_ITEMS,
  MAX_DISMISSED,
  isPlanned,
  nextPlannedDate,
  parsePlanned,
  plannedCadenceLabel,
  plannedDates,
  thresholdOf,
  upgradePlanned,
} = await import('@/lib/planned');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

const item = (over: Partial<PlannedItem> = {}): PlannedItem => ({
  id: 'b3b1f7a2-6c1e-4d55-9a8e-2f0c1d3e4a5b',
  name: 'Car registration',
  kind: 'expense',
  amount: 212.5,
  currency: 'USD',
  date: '2026-11-03',
  cadence: 'yearly',
  ...over,
});
const planned = (over: Partial<Planned> = {}): Planned => ({ ...EMPTY_PLANNED, items: [item()], ...over });

describe('a save is checked field by field', () => {
  test('a valid plan comes back as it went in, names trimmed and anything else dropped', () => {
    const p = planned({ dismissed: ['bill|Chase|Sapphire|netflix|USD|1549'], threshold: { amount: 250, currency: 'USD' } });
    expect(parsePlanned(JSON.parse(JSON.stringify(p)))).toEqual({ ok: p });
    const sent = { ...p, extra: 'x', items: [{ ...item({ name: '  Car registration  ' }), color: 'red' }] };
    expect(parsePlanned(sent)).toEqual({ ok: p });
    expect(parsePlanned(EMPTY_PLANNED)).toEqual({ ok: EMPTY_PLANNED });
  });

  const bad: [string, unknown][] = [
    ['not an object', 'items'],
    ['a list', []],
    ['no version', { ...EMPTY_PLANNED, version: undefined }],
    ['a later version', { ...EMPTY_PLANNED, version: 2 }],
    ['items not a list', { ...EMPTY_PLANNED, items: {} }],
    ['too many items', { ...EMPTY_PLANNED, items: Array.from({ length: MAX_ITEMS + 1 }, (_, i) => item({ id: `id${i}` })) }],
    ['the same id twice', { ...EMPTY_PLANNED, items: [item(), item()] }],
    ['an id with a space', planned({ items: [item({ id: 'has space' })] })],
    ['an empty id', planned({ items: [item({ id: '' })] })],
    ['a blank name', planned({ items: [item({ name: '   ' })] })],
    ['a name too long', planned({ items: [item({ name: 'x'.repeat(61) })] })],
    ['a name on two lines', planned({ items: [item({ name: 'Car\nregistration' })] })],
    ['a kind not listed', planned({ items: [item({ kind: 'transfer' as never })] })],
    ['a zero amount', planned({ items: [item({ amount: 0 })] })],
    ['a negative amount', planned({ items: [item({ amount: -5 })] })],
    ['an amount as text', planned({ items: [item({ amount: '12' as never })] })],
    ['an amount too large', planned({ items: [item({ amount: 2e12 })] })],
    ['cents of a yen', planned({ items: [item({ currency: 'JPY', amount: 1200.5 })] })],
    ['a third of a cent', planned({ items: [item({ amount: 10.001 })] })],
    ['a currency in lower case', planned({ items: [item({ currency: 'usd' })] })],
    ['a currency that is not one', planned({ items: [item({ currency: 'USX' })] })],
    ['no currency', planned({ items: [item({ currency: null as never })] })],
    ['a date that is not a day', planned({ items: [item({ date: '2026-02-30' })] })],
    ['a date with a time', planned({ items: [item({ date: '2026-11-03T00:00:00Z' })] })],
    ['a date before 2000', planned({ items: [item({ date: '1999-12-31' })] })],
    ['a date after 2100', planned({ items: [item({ date: '2101-01-01' })] })],
    ['a cadence not listed', planned({ items: [item({ cadence: 'semimonthly' as never })] })],
    ['dismissed not a list', planned({ dismissed: 'x' as never })],
    ['an empty dismissal', planned({ dismissed: [''] })],
    ['a dismissal twice', planned({ dismissed: ['a', 'a'] })],
    ['a dismissal too long', planned({ dismissed: ['x'.repeat(501)] })],
    ['too many dismissals', planned({ dismissed: Array.from({ length: MAX_DISMISSED + 1 }, (_, i) => `s${i}`) })],
    ['a threshold without its currency', planned({ threshold: 100 as never })],
    ['a negative threshold', planned({ threshold: { amount: -1, currency: 'USD' } })],
    ['a threshold as text', planned({ threshold: { amount: '100' as never, currency: 'USD' } })],
    ['an endless threshold', planned({ threshold: { amount: Infinity, currency: 'USD' } })],
    ['a threshold in no currency', planned({ threshold: { amount: 100, currency: 'USX' } })],
    ['a threshold in cents of a yen', planned({ threshold: { amount: 100.5, currency: 'JPY' } })],
  ];
  for (const [what, raw] of bad) {
    test(`refuses ${what}`, () => {
      expect('error' in parsePlanned(raw)).toBe(true);
    });
  }

  test('the reason names the item', () => {
    const r = parsePlanned(planned({ items: [item(), item({ id: 'second', amount: 0 })] }));
    expect(r).toEqual({ error: 'Item 2: the amount is more than zero' });
  });

  test('a stored value is read by its shape and types, not today\'s ranges', () => {
    expect(isPlanned(EMPTY_PLANNED)).toBe(true);
    expect(isPlanned(planned({ threshold: { amount: 5, currency: 'USD' } }))).toBe(true);
    expect(isPlanned(planned({ threshold: 5 as never }))).toBe(false);
    // A range a later release might widen still reads...
    expect(isPlanned(planned({ items: [item({ name: 'x'.repeat(200), amount: 1e15 })] }))).toBe(true);
    // ...but a shape or a cadence this code doesn't know does not.
    expect(isPlanned({ ...EMPTY_PLANNED, version: 2 })).toBe(false);
    expect(isPlanned(planned({ items: [item({ cadence: 'hourly' as never })] }))).toBe(false);
    expect(isPlanned({ items: [], dismissed: [] })).toBe(false);
    expect(isPlanned(null)).toBe(false);
  });

  test('the low-balance warning defaults to the Home tab\'s figure, in the forecast\'s currency', () => {
    expect(thresholdOf(EMPTY_PLANNED, 'USD')).toEqual({ amount: DEFAULT_THRESHOLD, set: false });
    expect(DEFAULT_THRESHOLD).toBe(100);
    expect(thresholdOf({ threshold: { amount: 0, currency: 'USD' } }, 'USD')).toEqual({ amount: 0, set: true });
  });

  test('a warning saved as a bare number, before its currency was kept, reads in the forecast\'s currency and saves back', () => {
    const old = { ...planned(), threshold: 250 };
    expect(isPlanned(old)).toBe(false);
    const upgraded = upgradePlanned(old) as Planned;
    expect(upgraded.threshold).toEqual({ amount: 250, currency: null });
    expect(isPlanned(upgraded)).toBe(true);
    expect(thresholdOf(upgraded, 'EUR')).toEqual({ amount: 250, set: true });
    // Sent back as read with another change, it is accepted.
    expect(parsePlanned(JSON.parse(JSON.stringify(upgraded)))).toEqual({ ok: upgraded });
    // The current shape, and anything else, go through untouched.
    expect(upgradePlanned(planned())).toEqual(planned());
    expect(upgradePlanned('x')).toBe('x');
  });

  test('a warning set in another currency is never read as the forecast\'s own', () => {
    // Set at 500 when the cash was in dollars; most of it is in euros now.
    const set = { amount: 500, currency: 'USD' };
    expect(thresholdOf({ threshold: set }, 'EUR')).toEqual({ amount: DEFAULT_THRESHOLD, set: false, other: set });
    expect(thresholdOf({ threshold: set }, 'USD')).toEqual({ amount: 500, set: true });
  });
});

describe('the days an item falls on', () => {
  test('a one-off, only inside the range asked', () => {
    const once = item({ cadence: 'once', date: '2026-10-20' });
    expect(plannedDates(once, '2026-10-09', '2026-11-07')).toEqual(['2026-10-20']);
    expect(plannedDates(once, '2026-10-21', '2026-11-07')).toEqual([]);
    expect(plannedDates(once, '2026-10-20', '2026-10-20')).toEqual(['2026-10-20']);
  });

  test('weekly and every two weeks, from a first day long past', () => {
    expect(plannedDates(item({ cadence: 'weekly', date: '2019-01-04' }), '2026-10-09', '2026-10-31')).toEqual([
      '2026-10-09',
      '2026-10-16',
      '2026-10-23',
      '2026-10-30',
    ]);
    expect(plannedDates(item({ cadence: 'biweekly', date: '2026-10-02' }), '2026-10-09', '2026-11-07')).toEqual(['2026-10-16', '2026-10-30']);
  });

  test('never before its first day', () => {
    expect(plannedDates(item({ cadence: 'monthly', date: '2026-12-15' }), '2026-10-09', '2027-01-31')).toEqual(['2026-12-15', '2027-01-15']);
  });

  test('monthly on the 31st, and quarterly, across short months', () => {
    expect(plannedDates(item({ cadence: 'monthly', date: '2026-01-31' }), '2026-10-09', '2027-03-31')).toEqual([
      '2026-10-31',
      '2026-11-30',
      '2026-12-31',
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
    ]);
    expect(plannedDates(item({ cadence: 'quarterly', date: '2025-11-30' }), '2026-01-01', '2026-12-31')).toEqual(['2026-02-28', '2026-05-30', '2026-08-30', '2026-11-30']);
  });

  test('yearly on February 29th, and every six months', () => {
    expect(plannedDates(item({ cadence: 'yearly', date: '2024-02-29' }), '2026-01-01', '2028-12-31')).toEqual(['2026-02-28', '2027-02-28', '2028-02-29']);
    expect(plannedDates(item({ cadence: 'semiannual', date: '2026-03-31' }), '2026-01-01', '2027-12-31')).toEqual(['2026-03-31', '2026-09-30', '2027-03-31', '2027-09-30']);
  });

  test('the next one from today', () => {
    expect(nextPlannedDate(item({ cadence: 'yearly', date: '2024-11-03' }), '2026-10-09')).toBe('2026-11-03');
    expect(nextPlannedDate(item({ cadence: 'once', date: '2026-10-08' }), '2026-10-09')).toBeNull();
    expect(nextPlannedDate(item({ cadence: 'once', date: '2026-10-09' }), '2026-10-09')).toBe('2026-10-09');
    expect(plannedCadenceLabel('semiannual')).toBe('Every 6 months');
  });
});

describe('the store', () => {
  test('is declared on the storage seam and in the data download', () => {
    expect(plannedStore.name).toBe('planned-items');
    expect(plannedStore.kind).toBe('value');
    expect(declaredStore('planned-items')).toBe(plannedStore);
    expect(plannedStore.exportable).toBe(true);
  });

  test('never saved reads as null, and a plan round-trips, encrypted', async () => {
    expect(await plannedStore.get(TEST_CTX)).toBeNull();
    await plannedStore.set(TEST_CTX, planned());
    expect(await plannedStore.get(TEST_CTX)).toEqual(planned());
    const raw = String(await fake.get(ctxKey('planned-items')));
    expect(raw).not.toContain('Car registration');
    expect(JSON.parse(await decrypt(raw))).toEqual(planned());
  });

  test('damaged bytes are unreadable, a later release\'s value is not understood, and neither reads as none', async () => {
    await fake.set(ctxKey('planned-items'), 'not-ciphertext-at-all-but-long-enough');
    const damaged = await plannedStore.get(TEST_CTX).catch((e: unknown) => e);
    expect(damaged).toBeInstanceOf(UnreadableValueError);
    expect((damaged as InstanceType<typeof UnreadableValueError>).unrecognised).toBe(false);
    await fake.set(ctxKey('planned-items'), await encrypt(JSON.stringify({ ...EMPTY_PLANNED, version: 2 })));
    const later = await plannedStore.get(TEST_CTX).catch((e: unknown) => e);
    expect(later).toBeInstanceOf(StoredDataUnreadableError);
    expect((later as InstanceType<typeof UnreadableValueError>).unrecognised).toBe(true);
  });

  test('is on the key inventory as a string of ciphertext, inside a container only', () => {
    expect(classify(ctxKey('planned-items').replace(/^[^:]+:(?=c:)/, ''))).toBe('string');
    expect(classify('planned-items')).toBeNull();
  });
});

describe('the route', () => {
  const put = (body: unknown) => route.PUT(new Request('http://x', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
    const orig = console.error;
    console.error = () => {};
    try {
      return await f();
    } finally {
      console.error = orig;
    }
  };

  test('loads the empty plan before anything is saved, then what was saved', async () => {
    expect(await (await route.GET()).json()).toEqual({ planned: EMPTY_PLANNED });
    const res = await put({ planned: planned({ dismissed: ['bill|Chase|netflix|USD'] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ planned: planned({ dismissed: ['bill|Chase|netflix|USD'] }) });
    expect(await (await route.GET()).json()).toEqual({ planned: planned({ dismissed: ['bill|Chase|netflix|USD'] }) });
  });

  test('refuses an invalid save with the reason, and stores nothing', async () => {
    const res = await put({ planned: planned({ items: [item({ amount: -1 })] }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Item 1: the amount is more than zero');
    expect(await fake.get(ctxKey('planned-items'))).toBeNull();
    for (const body of ['{not json', {}, null, { planned: null }, { planned: [] }]) expect((await put(body)).status).toBe(400);
    expect(await fake.get(ctxKey('planned-items'))).toBeNull();
  });

  test('a save keeps what was there when the next one is refused', async () => {
    await put({ planned: planned() });
    expect((await put({ planned: planned({ threshold: { amount: -5, currency: 'USD' } }) })).status).toBe(400);
    expect(await plannedStore.get(TEST_CTX)).toEqual(planned());
  });

  test('a plan stored with its warning as a bare number loads, upgraded, and saves back', async () => {
    await fake.set(ctxKey('planned-items'), await encrypt(JSON.stringify({ ...planned(), threshold: 250 })));
    const res = await route.GET();
    expect(res.status).toBe(200);
    const { planned: read } = await res.json();
    expect(read.threshold).toEqual({ amount: 250, currency: null });
    expect((await put({ planned: { ...read, dismissed: ['bill|Chase|Checking|netflix|USD|1549'] } })).status).toBe(200);
  });

  test('an unreadable store is a flagged 409 on load and on save, and is left alone', async () => {
    await fake.set(ctxKey('planned-items'), 'unreadable');
    const get = await quiet(() => route.GET());
    expect(get.status).toBe(409);
    expect(await get.json()).toMatchObject({ unreadable: true });
    const res = await quiet(() => put({ planned: EMPTY_PLANNED }));
    expect(res.status).toBe(409);
    expect(await fake.get<string>(ctxKey('planned-items'))).toBe('unreadable');
  });

  test('a database failure is a 500 without the flag', async () => {
    fake.failNext('get');
    const res = await quiet(() => route.GET());
    expect(res.status).toBe(500);
    expect((await res.json()).unreadable).toBeUndefined();
  });

  test('a value too large to store is refused whole, with the seam\'s reason', async () => {
    const before = process.env.MAX_TXN_BLOB_CHARS;
    process.env.MAX_TXN_BLOB_CHARS = '100';
    try {
      const res = await quiet(() => put({ planned: planned() }));
      expect(res.status).toBe(413);
      expect((await res.json()).error).toContain('too large to save');
      expect(await fake.get(ctxKey('planned-items'))).toBeNull();
    } finally {
      if (before === undefined) delete process.env.MAX_TXN_BLOB_CHARS;
      else process.env.MAX_TXN_BLOB_CHARS = before;
    }
  });
});
