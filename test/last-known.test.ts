import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const {
  fillFromLastKnown,
  rememberAccounts,
  rememberedIdsForItem,
  findRememberedAccount,
  forgetItem,
} = await import('@/lib/last-known');
const { applyHidden } = await import('@/lib/hidden');
const { accountBalanceMap } = await import('@/lib/networth');

async function writeAccountSnapshot(date: string, balances: Record<string, number>) {
  await fake.hset('test:history:accounts', { [date]: await encrypt(JSON.stringify(balances)) });
}

// Recovery only looks back a bounded number of DAYS, so every fixture has to
// sit near today rather than on a fixed calendar date.
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const RECENT = daysAgo(2);

/** An account as fetchInstitution returns it on the healthy path. */
const acct = (
  account_id: string,
  name: string,
  type: string | null,
  extra: Record<string, any> = {}
) => ({
  account_id,
  name,
  official_name: null,
  type,
  subtype: type === 'credit' ? 'credit card' : 'checking',
  mask: '0189',
  balance: 0,
  limit: null,
  currency: 'USD',
  ...extra,
});

/** Runs the healthy path once so the metadata store is populated, exactly as
 *  /api/net-worth does on every load before an institution later fails. */
async function remember(item_id: string, accounts: any[]) {
  await rememberAccounts([{ item_id, accounts, error: null } as any]);
}

/** An institution as fetchInstitution returns it after a failed balance call.
 *  `stale_as_of` is declared (not just left to inference) because that field is
 *  written by mutation, and its absence from the literal's inferred type is
 *  what tsc would otherwise complain about at every assertion site. */
type TestInstitution = {
  institution_name: string;
  item_id: string;
  accounts: any[];
  holdings: never[];
  error: string | null;
  needs_reauth: boolean;
  liabilities: 'unavailable';
  manual?: boolean;
  stale_as_of?: string;
  stale_too_old?: string;
  stale_missing?: number;
};

const broken = (item_id: string, error = 'Could not fetch balances'): TestInstitution => ({
  institution_name: 'Capital One',
  item_id,
  accounts: [],
  holdings: [],
  error,
  needs_reauth: false,
  liabilities: 'unavailable',
});

beforeEach(() => fake.reset());

describe('rememberAccounts', () => {
  test('records every account of an institution that answered', async () => {
    await remember('item_a', [
      acct('card', 'Venture', 'credit', { limit: 10_000 }),
      acct('checking', '360 Checking', 'depository'),
    ]);
    expect((await rememberedIdsForItem('item_a')).sort()).toEqual(['card', 'checking']);
  });

  // A record is only useful if it outlives the institution answering, so the
  // write path must never delete. This is what makes recovery possible at all.
  test('a later failed load leaves the existing record intact', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await rememberAccounts([broken('item_a')]);
    expect(await rememberedIdsForItem('item_a')).toEqual(['card']);
  });

  // Guards the recovery loop's own input: if a failed institution ever carried
  // accounts (recovered ones, or a future partial fetch), remembering them
  // would overwrite good metadata with whatever the failure produced.
  test('skips an institution that reported an error, even if it has accounts', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await rememberAccounts([
      { item_id: 'item_b', accounts: [acct('other', 'Other', 'depository')], error: 'boom' } as any,
    ]);
    expect(await rememberedIdsForItem('item_b')).toEqual([]);
  });

  test('skips manual institutions and untyped accounts', async () => {
    await rememberAccounts([
      { item_id: 'manual:ally', accounts: [acct('m1', 'HSA', 'investment')], error: null, manual: true } as any,
    ]);
    await remember('item_a', [acct('untyped', 'Mystery', null)]);

    expect(await rememberedIdsForItem('manual:ally')).toEqual([]);
    expect(await rememberedIdsForItem('item_a')).toEqual([]);
  });

  // Wholesale replacement, not merge. The first shape of this store was
  // append-only per account, so a card closed at the bank stayed in the record
  // forever and nothing could ask "what accounts does this Item actually have?"
  test('a later load replaces the record, dropping a closed account', async () => {
    await remember('item_a', [
      acct('card', 'Venture', 'credit'),
      acct('closed', 'Quicksilver', 'credit'),
    ]);
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    expect(await rememberedIdsForItem('item_a')).toEqual(['card']);
  });

  test('one Item replacing its record leaves other Items alone', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await remember('item_b', [acct('save', 'Savings', 'depository')]);
    await remember('item_a', [acct('card2', 'Venture 2', 'credit')]);

    expect(await rememberedIdsForItem('item_a')).toEqual(['card2']);
    expect(await rememberedIdsForItem('item_b')).toEqual(['save']);
  });

  test('forgetItem drops one Item and nothing else', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await remember('item_b', [acct('save', 'Savings', 'depository')]);
    await forgetItem('item_a');

    expect(await rememberedIdsForItem('item_a')).toEqual([]);
    expect(await rememberedIdsForItem('item_b')).toEqual(['save']);
  });

  // The store was reshaped from one field per account_id to one per item_id.
  // forgetItem deletes by item_id, so nothing else could ever remove a field of
  // the old shape: it would be decrypted on every broken-path load forever, and
  // findRememberedAccount could resolve a type out of one.
  test('clears records left over from the previous per-account shape', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await fake.hset('test:accounts:meta', {
      old_acct_id: await encrypt(JSON.stringify({ item_id: 'gone', type: 'credit', name: 'Old' })),
    });

    expect(await findRememberedAccount('old_acct_id')).toBeNull();
    expect(await fake.hkeys('test:accounts:meta')).toEqual(['item_a']);
  });

  // app/api/hidden-accounts needs an account's type to hide it, and for a
  // recovered row neither the cache nor a live fetch can supply one.
  test('findRememberedAccount resolves an account to its Item and type', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    const found = await findRememberedAccount('card');
    expect(found?.item_id).toBe('item_a');
    expect(found?.account.type).toBe('credit');
    expect(await findRememberedAccount('nope')).toBeNull();
  });
});

describe('recovering a failed institution', () => {
  test('fills accounts from the last snapshot and dates them', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit', { limit: 10_000 })]);
    await writeAccountSnapshot(RECENT, { card: 5544.35 });

    const inst = broken('item_a');
    const filled = await fillFromLastKnown([inst]);

    expect(filled).toEqual([{ item_id: 'item_a', as_of: RECENT, accounts: 1, missing: 0 }]);
    expect(inst.stale_as_of).toBe(RECENT);
    expect(inst.accounts).toHaveLength(1);
    expect(inst.accounts[0]).toMatchObject({
      account_id: 'card',
      name: 'Venture',
      type: 'credit',
      mask: '0189',
      balance: 5544.35,
      limit: 10_000,
      currency: 'USD',
    });
    // Captured at a different moment than stale_as_of, and volatile.
    expect(inst.accounts[0].available).toBeNull();
  });

  // Closes the seam between the two halves of the display-only guard.
  // test/networth.test.ts proves accountBalanceMap honours `stale`, but with a
  // hand-written object; nothing proved that recovery actually SETS it. Delete
  // `stale: true` from the recovered literal and both halves still passed.
  test('recovered accounts are marked so they can never be snapshotted', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await writeAccountSnapshot(RECENT, { card: 5544.35 });

    const inst = broken('item_a');
    await fillFromLastKnown([inst]);

    expect(inst.accounts[0].stale).toBe(true);
    expect(accountBalanceMap([inst] as any)).toEqual({});
  });

  // The metadata store is never pruned on account closure, so the newest
  // snapshot is the only thing that can say an account is gone: snapshots exist
  // only for days when every institution answered, so an account missing from
  // the newest one was already closed while its bank was still working. Without
  // this the user gets a live-looking row, mask and utilization meter included,
  // for a card they paid off and cancelled, with no way to dismiss it.
  test('does not resurrect an account closed before the outage', async () => {
    await remember('item_a', [
      acct('card', 'Venture', 'credit'),
      acct('closed_card', 'Quicksilver', 'credit'),
    ]);
    await writeAccountSnapshot(daysAgo(60), { card: 400, closed_card: 3000 });
    await writeAccountSnapshot(RECENT, { card: 500 });

    const inst = broken('item_a');
    await fillFromLastKnown([inst]);

    expect(inst.accounts.map((a) => a.account_id)).toEqual(['card']);
  });

  // THE invariant. /api/net-worth and the snapshot cron both gate on
  // `institutions.every(i => !i.error)`. If recovery cleared the error, a
  // balance from a week ago would be written to today's key in the REAL history
  // layer as though it had been measured -- a fabricated flat line that nothing
  // ever rewrites for a past date. The gap this feature leaves in the chart is
  // deliberate; the point is only to stop lying about the total.
  test('leaves error set, so the snapshot and cache gates stay closed', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await writeAccountSnapshot(RECENT, { card: 5544.35 });

    const inst = broken('item_a');
    await fillFromLastKnown([inst]);

    expect(inst.error).toBe('Could not fetch balances');
    expect([inst].every((i) => !i.error)).toBe(false);
  });

  test('a reconnect-needed institution keeps its reauth flag and gets its balances back', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await writeAccountSnapshot(RECENT, { card: 100 });

    const inst = { ...broken('item_a', 'This account needs to be reconnected'), needs_reauth: true };
    await fillFromLastKnown([inst]);

    expect(inst.needs_reauth).toBe(true);
    expect(inst.accounts).toHaveLength(1);
  });

  test('recovers several accounts from one institution', async () => {
    await remember('item_a', [
      acct('card', 'Venture', 'credit'),
      acct('checking', '360 Checking', 'depository'),
    ]);
    await writeAccountSnapshot(RECENT, { card: 500, checking: 1200 });

    const inst = broken('item_a');
    await fillFromLastKnown([inst]);
    expect(inst.accounts).toHaveLength(2);
  });
});

describe('what it refuses to do', () => {
  test('healthy institutions are untouched and cost zero Redis reads', async () => {
    const healthy = { ...broken('item_a'), error: null, accounts: [{ account_id: 'x' }] };
    fake.ops = 0;

    expect(await fillFromLastKnown([healthy])).toEqual([]);
    expect(fake.ops).toBe(0);
    expect(healthy.stale_as_of).toBeUndefined();
  });

  // A manual institution's error means the Redis read failed, and its balances
  // live in that same store. Guessing would understate net worth silently,
  // which is the exact failure lib/manual.ts is written to make loud.
  test('manual institutions are never filled', async () => {
    await rememberAccounts([
      { item_id: 'manual:ally', accounts: [acct('m1', 'HSA', 'investment')], error: null } as any,
    ]);
    await writeAccountSnapshot(RECENT, { m1: 9000 });

    const inst = {
      ...broken('manual:ally', 'Could not load manually-tracked accounts'),
      manual: true,
    };
    expect(await fillFromLastKnown([inst])).toEqual([]);
    expect(inst.accounts).toHaveLength(0);
  });

  test('an institution that returned some accounts is left alone', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await writeAccountSnapshot(RECENT, { card: 500 });

    const partial = { ...broken('item_a'), accounts: [{ account_id: 'live' }] };
    expect(await fillFromLastKnown([partial])).toEqual([]);
    expect(partial.accounts).toEqual([{ account_id: 'live' }]);
  });

  // An unsigned balance would be added to net worth as an asset, turning a card
  // you owe into money you have, so the write path drops untyped accounts.
  test('an untyped account is never recovered', async () => {
    await remember('item_a', [acct('card', 'Venture', null), acct('checking', '360', 'depository')]);
    await writeAccountSnapshot(RECENT, { card: 5000, checking: 100 });

    const inst = broken('item_a');
    await fillFromLastKnown([inst]);
    expect(inst.accounts.map((a) => a.account_id)).toEqual(['checking']);
  });

  // Recovery is scoped by item_id, so a failing institution can't absorb
  // another one's accounts just because they share the snapshot.
  test('only recovers accounts belonging to the failed institution', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await remember('item_b', [acct('save', 'Savings', 'depository')]);
    await writeAccountSnapshot(RECENT, { card: 500, save: 2000 });

    const inst = broken('item_a');
    await fillFromLastKnown([inst]);
    expect(inst.accounts.map((a) => a.account_id)).toEqual(['card']);
  });

  test('no fill when the institution was never recorded healthy', async () => {
    await writeAccountSnapshot(RECENT, { card: 500 });
    const inst = broken('item_a');
    expect(await fillFromLastKnown([inst])).toEqual([]);
    expect(inst.stale_as_of).toBeUndefined();
  });

  test('no fill when no snapshot covers the accounts', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await writeAccountSnapshot(RECENT, { someone_else: 500 });

    const inst = broken('item_a');
    expect(await fillFromLastKnown([inst])).toEqual([]);
    expect(inst.accounts).toHaveLength(0);
  });

  // BLAST RADIUS. Recovery is driven by each Item's own record, so nothing
  // about one institution can disable another's. An earlier design scanned the
  // snapshot for ids it couldn't attribute and refused everything when it found
  // any -- which fired on a disconnected Item, a deleted manual account, a
  // failed manual read, and on deploy day, each time silently reverting every
  // institution to $0.00 for the duration of the outage.
  test('an unreadable record costs only its own Item', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await remember('item_b', [acct('save', 'Savings', 'depository')]);
    await fake.hset('test:accounts:meta', { item_a: 'not-ciphertext' });
    await writeAccountSnapshot(RECENT, { card: 500, save: 2000 });

    const a = broken('item_a');
    const b = broken('item_b');
    expect(await fillFromLastKnown([a, b])).toHaveLength(1);
    expect(a.accounts).toHaveLength(0);
    expect(b.accounts.map((x) => x.account_id)).toEqual(['save']);
  });

  test('a snapshot id no Item claims is ignored, not treated as a blocker', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    // A deleted manual account, a disconnected Item, an account closed since:
    // all leave ids in the snapshot that nothing owns any more.
    await writeAccountSnapshot(RECENT, { card: 500, orphan: 9000, manual_1: 400 });

    const inst = broken('item_a');
    expect(await fillFromLastKnown([inst])).toHaveLength(1);
    expect(inst.accounts.map((a) => a.account_id)).toEqual(['card']);
  });

  // THE residual risk, and it is disclosed rather than hidden. An account this
  // Item has but the snapshot doesn't can be harmless (opened during a partial
  // outage, which refreshes this Item's record but blocks the global snapshot)
  // or not (ids rotated at reauth, a newer snapshot that wouldn't decrypt). The
  // reason is unknowable here, and a card drawn short understates debt, which
  // OVERSTATES net worth -- so the count ships and the card says so.
  test('reports how many accounts it could not show', async () => {
    await remember('item_a', [
      acct('card', 'Venture', 'credit'),
      acct('brand_new', 'New Card', 'credit'),
    ]);
    await writeAccountSnapshot(RECENT, { card: 500 });

    const inst = broken('item_a');
    const filled = await fillFromLastKnown([inst]);

    expect(filled).toEqual([{ item_id: 'item_a', as_of: RECENT, accounts: 1, missing: 1 }]);
    expect(inst.accounts.map((a) => a.account_id)).toEqual(['card']);
    expect(inst.stale_missing).toBe(1);
  });

  test('a complete recovery reports nothing missing', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await writeAccountSnapshot(RECENT, { card: 500 });

    const inst = broken('item_a');
    await fillFromLastKnown([inst]);
    expect(inst.stale_missing).toBeUndefined();
  });
});

describe('the age limit', () => {
  // Reverting to a bare $0.00 after five weeks of showing balances is the
  // original bug returning with no signal that anything changed, so crossing
  // the limit has to say so.
  test('does not fill from a snapshot past the limit, and says why', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await writeAccountSnapshot(daysAgo(40), { card: 500 });

    const inst = broken('item_a');
    expect(await fillFromLastKnown([inst])).toEqual([]);
    expect(inst.accounts).toHaveLength(0);
    expect(inst.stale_as_of).toBeUndefined();
    expect(inst.stale_too_old).toBe(daysAgo(40));
  });

  test('fills normally just inside the limit', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await writeAccountSnapshot(daysAgo(34), { card: 500 });

    const inst = broken('item_a');
    expect(await fillFromLastKnown([inst])).toHaveLength(1);
    expect(inst.stale_as_of).toBe(daysAgo(34));
    expect(inst.stale_too_old).toBeUndefined();
  });

  // Exactly at the limit. The other two cases sit at 34 and 40 days, which
  // leaves `<` vs `<=` free to flip without failing anything.
  test('a snapshot exactly at the limit still fills', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await writeAccountSnapshot(daysAgo(35), { card: 500 });

    const inst = broken('item_a');
    expect(await fillFromLastKnown([inst])).toHaveLength(1);
    expect(inst.stale_too_old).toBeUndefined();
  });

  // An institution with nothing recoverable gets no explanation, because there
  // is nothing to explain: it never had balances to be too old. Guards the
  // order of the two guards -- swapping them would label an institution that
  // never had balances "too old to show", inventing history it never had.
  test('says nothing when there was nothing to recover anyway', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    // The Item is known, but this old snapshot predates every one of its
    // accounts, so there is nothing to date.
    await writeAccountSnapshot(daysAgo(40), { someone_else: 500 });

    const inst = broken('item_a');
    await fillFromLastKnown([inst]);
    expect(inst.stale_too_old).toBeUndefined();
    expect(inst.stale_as_of).toBeUndefined();
  });
});

describe('the total it produces', () => {
  // The bug that motivated all of this: a dropped credit card RAISES net worth,
  // so a broken connection reads as good news. Recovery has to restore the
  // subtraction, not just the row.
  test('a recovered card subtracts from the visible total again', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await writeAccountSnapshot(RECENT, { card: 5544.35 });

    const cash = { accounts: [{ account_id: 'c', type: 'depository', balance: 10_000 }] };
    const inst = broken('item_a');

    expect(applyHidden([cash, inst as any], new Map())).toBe(10_000); // before: card missing
    await fillFromLastKnown([inst]);
    expect(applyHidden([cash, inst as any], new Map())).toBeCloseTo(4455.65, 2);
  });

  test('a hidden account stays hidden after being recovered', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await writeAccountSnapshot(RECENT, { card: 5544.35 });

    const inst = broken('item_a');
    await fillFromLastKnown([inst]);

    const hidden = new Map([['card', { type: 'credit', hidden_at: '2026-01-01' }]]);
    expect(applyHidden([inst as any], hidden)).toBe(0);
    expect(inst.accounts[0].hidden).toBe(true);
  });

  // Every recovered institution shares one "as of", and that is correct rather
  // than convenient: a snapshot exists only for a day when EVERYTHING answered,
  // so there is exactly one newest such day and it applies to all of them.
  test('several broken institutions are recovered, all carrying the same date', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await remember('item_b', [acct('save', 'Savings', 'depository')]);
    await writeAccountSnapshot(daysAgo(9), { card: 1, save: 2 });
    await writeAccountSnapshot(RECENT, { card: 500, save: 2000 });

    const a = broken('item_a');
    const b = broken('item_b');
    const filled = await fillFromLastKnown([a, b]);

    expect(filled).toHaveLength(2);
    expect(a.stale_as_of).toBe(RECENT);
    expect(b.stale_as_of).toBe(RECENT);
    expect(applyHidden([a as any, b as any], new Map())).toBe(1500);
  });

  // Both stores span every Item and every date since install, so reading them
  // per institution would download and decrypt the lot N times in parallel
  // during exactly the outage that makes N large.
  test('reads each store once regardless of how many institutions broke', async () => {
    await remember('item_a', [acct('card', 'Venture', 'credit')]);
    await remember('item_b', [acct('save', 'Savings', 'depository')]);
    await remember('item_c', [acct('ira', 'IRA', 'investment')]);
    await writeAccountSnapshot(RECENT, { card: 500, save: 2000, ira: 30_000 });
    fake.ops = 0;

    const filled = await fillFromLastKnown([broken('item_a'), broken('item_b'), broken('item_c')]);

    expect(filled).toHaveLength(3);
    // hkeys + one hget for the winning snapshot date (never a full hgetall of
    // every date since install), plus one hgetall of the metadata hash.
    expect(fake.ops).toBe(3);
  });
});
