import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// A merchant's default category (lib/vendor-defaults.ts): the rule, that it
// changes only when two of the last three categorizations agree, through
// agreeing, disagreeing, three that differ (no tie to break), and a category
// merged or deleted in between; the cap on merchants kept; and the store
// (lib/vendor-default-store.ts): one value changed by compare-and-set, strict,
// an undo that puts back exactly what a vote changed, and one container
// never seeing another's.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { agreedCategory, defaultsByVendor, defaultUses, isVendorDefaults, isVendorKey, MAX_VENDORS, withVote } = await import('@/lib/vendor-defaults');
const { clearDefault, readVendorDefaults, recordCategorization, repairDefaults, restoreVendorEntry, vendorDefaultsStore } = await import('@/lib/vendor-default-store');
const { encrypt } = await import('@/lib/crypto');
const { UnreadableValueError } = await import('@/lib/repo');

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const same = (id: string): string | null => id;
const at = (n: number) => new Date(Date.UTC(2026, 9, 1 + n, 12));
const vote = (category_id: string, vendor_key = 'nm:chase::costco') => ({ vendor_key, name: 'Costco', category_id });

/** Votes, in order, through the pure rule, starting from nothing. */
function after(categories: string[], resolve = same) {
  let state = null as ReturnType<typeof withVote> extends infer R ? (R extends { next: infer N } ? N : never) | null : never;
  let last: ReturnType<typeof withVote> = null;
  categories.forEach((c, i) => {
    last = withVote(state, vote(c), { at: at(i), today: `2026-10-${String(1 + i).padStart(2, '0')}`, resolve, newId: () => 'v1' });
    state = last!.next;
  });
  return { state: state!, last: last! };
}

beforeEach(async () => {
  fake.reset();
  await registerTestContainer(fake);
});

describe('two of the last three', () => {
  test('one categorization sets nothing; a second that agrees sets the default, from that day', () => {
    expect(after(['groceries']).state.vendors[0].default).toBeUndefined();
    const two = after(['groceries', 'groceries']);
    expect(two.state.vendors[0].default).toEqual({ category_id: 'groceries', since: '2026-10-02', set_at: at(1).toISOString() });
    expect(two.last.changed).toBe(true);
  });

  test('two that disagree set nothing; a third that agrees with either sets it', () => {
    expect(after(['groceries', 'household']).state.vendors[0].default).toBeUndefined();
    expect(after(['groceries', 'household', 'groceries']).state.vendors[0].default?.category_id).toBe('groceries');
    expect(after(['groceries', 'household', 'household']).state.vendors[0].default?.category_id).toBe('household');
  });

  test('three that differ agree on nothing, so there is never a tie to break: the default stays as it was', () => {
    expect(agreedCategory([{ category_id: 'a', at: '' }, { category_id: 'b', at: '' }, { category_id: 'c', at: '' }], same)).toBeNull();
    const kept = after(['groceries', 'groceries', 'household', 'auto']);
    // The last three are groceries, household, auto: no two agree.
    expect(kept.state.vendors[0].votes.map((v) => v.category_id)).toEqual(['groceries', 'household', 'auto']);
    expect(kept.state.vendors[0].default?.category_id).toBe('groceries');
    expect(kept.last.changed).toBe(false);
  });

  test('it changes only when two of the last three agree on another, from that day, the category before keeping the days it filed', () => {
    const moved = after(['groceries', 'groceries', 'household', 'household']);
    expect(moved.state.vendors[0].default).toEqual({
      category_id: 'household',
      since: '2026-10-04',
      set_at: at(3).toISOString(),
      previous: [{ category_id: 'groceries', since: '2026-10-02', until: '2026-10-04' }],
    });
    // One more that disagrees, with household still two of the last three: unchanged.
    const held = after(['groceries', 'groceries', 'household', 'household', 'auto']);
    expect(held.state.vendors[0].default?.category_id).toBe('household');
    expect(held.last.changed).toBe(false);
  });

  test('a category merged in between agrees with the one it went into; one deleted agrees with nothing', () => {
    // Groceries and food were two; food merged into groceries makes them one.
    const merged = (id: string) => (id === 'food' ? 'groceries' : id);
    expect(after(['groceries', 'food'], merged).state.vendors[0].default?.category_id).toBe('groceries');
    expect(after(['groceries', 'food']).state.vendors[0].default).toBeUndefined();
    // Deleted (it resolves to nothing): two votes for it agree on nothing.
    const deleted = (id: string) => (id === 'gone' ? null : id);
    expect(after(['gone', 'gone'], deleted).state.vendors[0].default).toBeUndefined();
    expect(agreedCategory([{ category_id: 'gone', at: '' }, { category_id: 'gone', at: '' }, { category_id: 'auto', at: '' }], deleted)).toBeNull();
    // A default whose category is gone files nothing, and a new agreement replaces it.
    const { state } = after(['gone', 'gone']);
    expect(defaultsByVendor(state, deleted).size).toBe(0);
    const replaced = withVote(state, vote('auto'), { at: at(5), today: '2026-10-06', resolve: deleted });
    expect(replaced!.next.vendors[0].default).toBeDefined();
    expect(replaced!.next.vendors[0].default!.category_id).toBe('gone');
    const again = withVote(replaced!.next, vote('auto'), { at: at(6), today: '2026-10-07', resolve: deleted });
    // It files from that day; the category before is gone and filed nothing,
    // so no days of it are kept.
    expect(again!.next.vendors[0].default).toEqual({ category_id: 'auto', since: '2026-10-07', set_at: at(6).toISOString() });
  });

  test('what the read layer applies: the category through merges, and how many of the last three agree now', () => {
    const { state } = after(['groceries', 'groceries', 'household']);
    expect(defaultsByVendor(state, same).get('nm:chase::costco')).toEqual({ id: 'v1', category_id: 'groceries', since: '2026-10-02', agree: 2 });
    expect(defaultUses(state, (id) => id === 'groceries')).toBe(1);
    expect(defaultUses(state, (id) => id === 'household')).toBe(0);
  });

  test('merchants are kept up to a bound; room is made by one without a default, never one with', () => {
    let state = null as null | NonNullable<ReturnType<typeof withVote>>['next'];
    for (let i = 0; i < MAX_VENDORS; i++) {
      const v = vote('groceries', `nm:chase::m${i}`);
      state = withVote(state, v, { at: at(0), today: '2026-10-01', resolve: same })!.next;
      if (i >= MAX_VENDORS - 2) state = withVote(state, v, { at: at(1), today: '2026-10-02', resolve: same })!.next;
    }
    const more = withVote(state, vote('auto', 'nm:chase::new'), { at: at(2), today: '2026-10-03', resolve: same })!;
    expect(more.next.vendors.length).toBe(MAX_VENDORS);
    expect(more.next.vendors.some((e) => e.vendor_key === 'nm:chase::new')).toBe(true);
    // The one categorized longest ago without a default made room.
    expect(more.next.vendors.some((e) => e.vendor_key === 'nm:chase::m0')).toBe(false);
    // With every merchant holding a default, nothing is dropped to make room.
    const full = { version: 1 as const, vendors: more.next.vendors.map((e) => ({ ...e, default: { category_id: 'groceries', since: '2026-10-01', set_at: at(0).toISOString() } })) };
    expect(withVote(full, vote('auto', 'nm:chase::another'), { at: at(3), today: '2026-10-04', resolve: same })).toBeNull();
  });

  test('a vendor key is one lib/transactions.ts makes', () => {
    expect(isVendorKey('mid:abc123')).toBe(true);
    expect(isVendorKey('nm:chase::costco')).toBe(true);
    expect(isVendorKey('costco')).toBe(false);
    expect(isVendorKey('nm:')).toBe(false);
    expect(isVendorKey(`nm:${'x'.repeat(300)}`)).toBe(false);
    expect(isVendorKey(42)).toBe(false);
  });
});

describe('the store', () => {
  test('votes recorded by compare-and-set, cleared by id, the vendor key inside the ciphertext', async () => {
    const opts = { resolve: same, today: '2026-10-02' };
    expect((await recordCategorization(ctx, vote('groceries'), opts))!.changed).toBe(false);
    const second = (await recordCategorization(ctx, vote('groceries'), opts))!;
    expect(second.changed).toBe(true);
    expect(second.entry.default).toMatchObject({ category_id: 'groceries', since: '2026-10-02' });
    const stored = fake.strings.get(ctxKey('vendor-defaults'))!;
    expect(stored).not.toContain('costco');
    expect(await clearDefault(ctx, second.entry.id)).toBe(true);
    expect(await clearDefault(ctx, second.entry.id)).toBe(false);
    expect((await vendorDefaultsStore.get(ctx))!.vendors).toEqual([]);
  });

  test('an undo puts back exactly what the vote changed, only while the entry is still what it left', async () => {
    const opts = { resolve: same, today: '2026-10-02' };
    await recordCategorization(ctx, vote('groceries'), opts);
    const first = (await vendorDefaultsStore.get(ctx))!.vendors[0];
    const set = (await recordCategorization(ctx, vote('groceries'), opts))!;
    expect(set.entry.default).toBeDefined();
    expect(await restoreVendorEntry(ctx, { after: set.entry, previous: set.previous })).toBe(true);
    expect((await vendorDefaultsStore.get(ctx))!.vendors[0]).toEqual(first);
    // A vote that made the entry: undone, the merchant is gone again.
    const fresh = (await recordCategorization(ctx, vote('auto', 'nm:chase::shell'), opts))!;
    expect(await restoreVendorEntry(ctx, { after: fresh.entry, previous: null })).toBe(true);
    expect((await vendorDefaultsStore.get(ctx))!.vendors.map((e) => e.vendor_key)).toEqual(['nm:chase::costco']);
    // Changed since, even within the same millisecond: left as it is.
    const when = { ...opts, now: new Date('2026-10-02T09:00:00.000Z') };
    const a = (await recordCategorization(ctx, vote('auto'), when))!;
    await recordCategorization(ctx, vote('auto'), when);
    expect(await restoreVendorEntry(ctx, { after: a.entry, previous: a.previous })).toBe(false);
    // Another merchant's entry is never put in its place.
    const now = (await vendorDefaultsStore.get(ctx))!.vendors[0];
    await expect(restoreVendorEntry(ctx, { after: now, previous: { ...now, vendor_key: 'nm:chase::other' } })).rejects.toThrow('isn’t how');
  });

  test('a value that can’t be read is never taken for none: every change refuses, and only damaged bytes are removed, once asked', async () => {
    await fake.set(ctxKey('vendor-defaults'), 'not-ciphertext-but-long-enough-to-be-tried');
    expect(await readVendorDefaults(ctx)).toEqual({ state: null, unreadable: true, unrecognised: false });
    await expect(recordCategorization(ctx, vote('groceries'), { resolve: same, today: '2026-10-02' })).rejects.toBeInstanceOf(UnreadableValueError);
    await expect(clearDefault(ctx, 'v1')).rejects.toBeInstanceOf(UnreadableValueError);
    expect(fake.strings.get(ctxKey('vendor-defaults'))).toBe('not-ciphertext-but-long-enough-to-be-tried');
    expect(await repairDefaults(ctx)).toBe(true);
    expect(await readVendorDefaults(ctx)).toEqual({ state: null, unreadable: false, unrecognised: false });
  });

  test('one saved by a later release (a field this one doesn’t know) is unrecognised: never applied, never removed', async () => {
    const later = { version: 1, vendors: [{ id: 'v1', vendor_key: 'nm:chase::costco', name: 'Costco', votes: [{ category_id: 'g', at: at(0).toISOString() }], updated_at: at(0).toISOString(), weight: 2 }] };
    expect(isVendorDefaults(later)).toBe(false);
    await fake.set(ctxKey('vendor-defaults'), await encrypt(JSON.stringify(later)));
    expect(await readVendorDefaults(ctx)).toEqual({ state: null, unreadable: false, unrecognised: true });
    expect(await repairDefaults(ctx)).toBe(false);
    expect(fake.strings.has(ctxKey('vendor-defaults'))).toBe(true);
  });

  test('one container never sees another’s', async () => {
    await recordCategorization(ctx, vote('groceries'), { resolve: same, today: '2026-10-02' });
    expect(await vendorDefaultsStore.get(OTHER)).toBeNull();
    expect((await vendorDefaultsStore.get(ctx))!.vendors.length).toBe(1);
  });
});
