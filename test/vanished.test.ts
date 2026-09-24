import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

// Real AES-256-GCM: both the remembered-accounts record this reads and the
// vanished record it writes are encrypted, so a round-trip bug here would look
// exactly like a detection bug.
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { checkVanished, checkVanishedAll, forgetVanished } = await import('@/lib/vanished');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-15T12:00:00.000Z');

/** Seed accounts:meta the way rememberAccounts writes it. */
async function remember(item_id: string, ids: string[]): Promise<void> {
  const accounts = ids.map((account_id) => ({
    account_id,
    name: 'Checking',
    official_name: null,
    mask: '4821',
    type: 'depository',
    subtype: 'checking',
    limit: null,
    currency: 'USD',
  }));
  await fake.hset(testKey('accounts:meta'), { [item_id]: await encrypt(JSON.stringify(accounts)) });
}

const asAccounts = (ids: string[]) => ids.map((account_id) => ({ account_id }));

/**
 * Drive ONE institution through checkVanishedAll.
 *
 * Deliberately not `checkVanished`: production calls only the batch form, and
 * the two source `remembered` through different code. rememberedIdsForItem
 * accepts any string account_id; recallByItem, behind rememberedIdsByItem, also
 * drops entries whose `type` is not a string and drops the Item entirely if
 * that leaves none. Testing the single form would leave the real path unproven.
 */
async function check(item_id: string, freshIds: string[], now: number) {
  const all = await checkVanishedAll([{ item_id, accounts: asAccounts(freshIds) }], now);
  return all[item_id] ?? { unconfirmed: [], accepted: [] };
}

/** Read back the vanished record, for asserting on what was persisted. */
async function record(item_id: string): Promise<Record<string, string> | null> {
  const blob = await fake.hget<string>(testKey('accounts:vanished'), item_id);
  if (!blob) return null;
  const { decrypt } = await import('@/lib/crypto');
  return JSON.parse(await decrypt(blob));
}

beforeEach(() => fake.reset());

describe('nothing to report', () => {
  test('an Item with no remembered accounts reports nothing', async () => {
    // A brand new Item, or one that has never had a healthy fetch. There is no
    // prior list to compare against, so absence is unknowable rather than zero.
    expect(await check('item_a', ['acct_1'], NOW)).toEqual({ unconfirmed: [], accepted: [] });
  });

  test('every remembered account still present reports nothing', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);

    expect(await check('item_a', ['acct_1', 'acct_2'], NOW)).toEqual({
      unconfirmed: [],
      accepted: [],
    });
    expect(await record('item_a')).toBeNull(); // nothing persisted when nothing is wrong
  });

  test('an institution reporting NO accounts reports nothing', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);

    // A healthy fetch returning an empty list is an institution telling us
    // nothing, not every account closing at once. Flagging the whole list would
    // close the global gate and then accept every account as closed three days
    // later -- and it could never clear, because rememberAccounts skips an
    // institution with no accounts (lib/last-known.ts:136), so meta is never
    // pruned, every id stays remembered, and the settled-closure prune never
    // fires. The record and its warning would persist on every load forever.
    const res = await check('item_a', [], NOW);

    expect(res).toEqual({ unconfirmed: [], accepted: [] });
    expect(await record('item_a')).toBeNull();
  });

  test('an institution that replaces its entire id set reports nothing', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);

    // A reauth can rotate every account_id (lib/last-known.ts:320 names this as
    // a real case). Accounts do not all close at the same instant while new
    // ones appear in the same response, so an all-miss against a non-empty
    // fresh list is a replaced id set. Flagging it would close ONE gate that
    // covers the whole snapshot, freezing history for every institution and for
    // manual accounts for three days after a routine reconnect.
    const res = await check('item_a', ['acct_9', 'acct_8'], NOW);

    expect(res).toEqual({ unconfirmed: [], accepted: [] });
    expect(await record('item_a')).toBeNull();
  });

  test('a rotation clears a window already in progress', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    expect((await check('item_a', ['acct_1'], NOW)).unconfirmed).toEqual(['acct_2']);
    expect(await record('item_a')).not.toBeNull();

    // The reauth lands next. Leaving acct_2's start time behind would make the
    // old window apply to an id set the institution no longer uses.
    const res = await check('item_a', ['acct_9', 'acct_8'], NOW);

    expect(res).toEqual({ unconfirmed: [], accepted: [] });
    expect(await record('item_a')).toBeNull();
  });
});

describe('an account disappears from a healthy fetch', () => {
  test('is unconfirmed at first, and closes the gate', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);

    const res = await check('item_a', ['acct_1'], NOW);

    expect(res.unconfirmed).toEqual(['acct_2']);
    expect(res.accepted).toEqual([]);
    // Persisted, so the next run knows when this started rather than
    // restarting the window on every load.
    expect(await record('item_a')).toEqual({ acct_2: new Date(NOW).toISOString() });
  });

  test('survives accounts:meta being refreshed without it', async () => {
    // THE case this module's own record exists for. rememberAccounts rewrites
    // an Item's meta wholesale from the latest fetch, and /api/net-worth calls
    // it unconditionally, so the vanished account is dropped from meta on the
    // very next load. A check that trusted meta alone would notice the
    // disappearance exactly once and then forget it.
    await remember('item_a', ['acct_1', 'acct_2']);
    await check('item_a', ['acct_1'], NOW);

    await remember('item_a', ['acct_1']); // meta now reflects only what answered

    const res = await check('item_a', ['acct_1'], NOW + DAY);
    expect(res.unconfirmed).toEqual(['acct_2']);
    // And the original timestamp survived, so the window is not restarted.
    expect(await record('item_a')).toEqual({ acct_2: new Date(NOW).toISOString() });
  });

  test('is accepted once it has been absent past the window', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await check('item_a', ['acct_1'], NOW);

    const res = await check('item_a', ['acct_1'], NOW + 4 * DAY);

    // Accepted does NOT close the gate: a real closure should cost a few days
    // of gap, not a permanent freeze on a condition nothing can clear while
    // the lifecycle UI is unbuilt.
    expect(res.unconfirmed).toEqual([]);
    expect(res.accepted).toEqual(['acct_2']);
  });

  test('is still unconfirmed one second inside the window', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await check('item_a', ['acct_1'], NOW);

    const res = await check('item_a', ['acct_1'], NOW + 3 * DAY - 1000);
    expect(res.unconfirmed).toEqual(['acct_2']);
  });

  test('accepts exactly at the window, so the boundary is inclusive', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await check('item_a', ['acct_1'], NOW);

    // Pins which side the boundary falls on. With cron jitter around 13:00 UTC
    // this decides whether acceptance lands on the third or fourth run, which
    // is benign either way but should not change silently.
    const res = await check('item_a', ['acct_1'], NOW + 3 * DAY);
    expect(res.accepted).toEqual(['acct_2']);
  });

  test('tracks two accounts vanishing at different times independently', async () => {
    await remember('item_a', ['acct_1', 'acct_2', 'acct_3']);

    await check('item_a', ['acct_1', 'acct_2'], NOW); // acct_3 goes
    const res = await check('item_a', ['acct_1'], NOW + 3 * DAY); // acct_2 goes, later

    // acct_3 has served its window; acct_2 has just started one. A single
    // per-Item timestamp would have accepted both or neither.
    expect(res.accepted).toEqual(['acct_3']);
    expect(res.unconfirmed).toEqual(['acct_2']);
  });
});

describe('the glitch case', () => {
  test('an account that comes back clears its record', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await check('item_a', ['acct_1'], NOW);
    expect(await record('item_a')).not.toBeNull();

    const res = await check('item_a', ['acct_1', 'acct_2'], NOW + DAY);

    expect(res).toEqual({ unconfirmed: [], accepted: [] });
    expect(await record('item_a')).toBeNull();
  });

  test('a later disappearance starts a fresh window, not an inherited one', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await check('item_a', ['acct_1'], NOW); // vanishes
    await check('item_a', ['acct_1', 'acct_2'], NOW + DAY); // returns

    // Months later it vanishes again. If the old timestamp had been kept, this
    // would be accepted as closed instantly on the strength of an absence that
    // already resolved.
    const res = await check('item_a', ['acct_1'], NOW + 90 * DAY);
    expect(res.unconfirmed).toEqual(['acct_2']);
    expect(res.accepted).toEqual([]);
  });
});

describe('corrupt or missing state fails safe', () => {
  test('an unparseable timestamp is treated as just now, not as ancient', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await fake.hset(testKey('accounts:vanished'), {
      item_a: await encrypt(JSON.stringify({ acct_2: 'not-a-date' })),
    });

    // Waving it through would be the failure that matters: a corrupt entry
    // must not let a disappearance be accepted unexamined.
    const res = await check('item_a', ['acct_1'], NOW);
    expect(res.unconfirmed).toEqual(['acct_2']);
    expect(res.accepted).toEqual([]);
  });

  test('an unreadable record restarts the window rather than accepting', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await fake.hset(testKey('accounts:vanished'), { item_a: 'not-ciphertext' });

    const res = await check('item_a', ['acct_1'], NOW);
    expect(res.unconfirmed).toEqual(['acct_2']);
  });

  test('a failed record read does not report a disappearance', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    // Both reads in loadVanishedInputs are hgetall; failing them means the
    // comparison has nothing to compare against and must say nothing rather
    // than flagging every account.
    fake.failNext('hgetall', 2);

    const res = await check('item_a', ['acct_1'], NOW);
    expect(res).toEqual({ unconfirmed: [], accepted: [] });
  });
});

describe('a settled closure stops being reported', () => {
  test('is pruned once the institution no longer remembers it', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await check('item_a', ['acct_1'], NOW);

    // Past the window, and rememberAccounts has since pruned meta (which it
    // does once the gate reopens and a healthy fetch is recorded).
    await remember('item_a', ['acct_1']);
    const first = await check('item_a', ['acct_1'], NOW + 4 * DAY);
    expect(first.accepted).toEqual(['acct_2']);

    // Without pruning, this entry would stay a candidate forever: reported as
    // accepted and logged on every single load, and the record would grow by
    // one permanent entry per closed account.
    expect(await record('item_a')).toBeNull();
    expect(await check('item_a', ['acct_1'], NOW + 5 * DAY)).toEqual({
      unconfirmed: [],
      accepted: [],
    });
  });

  test('is NOT pruned while the institution still remembers it', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await check('item_a', ['acct_1'], NOW);

    // meta still lists it, so dropping the record here would make the next run
    // rediscover it with a fresh window, and the two would cycle forever.
    const res = await check('item_a', ['acct_1'], NOW + 4 * DAY);
    expect(res.accepted).toEqual(['acct_2']);
    expect(await record('item_a')).toEqual({ acct_2: new Date(NOW).toISOString() });
  });
});

describe('cost', () => {
  const healthy = (item_id: string, ids: string[]) => ({ item_id, accounts: asAccounts(ids) });

  test('does not grow with the number of institutions', async () => {
    await remember('item_a', ['a1', 'a2']);
    await remember('item_b', ['b1', 'b2']);
    await remember('item_c', ['c1', 'c2']);

    fake.ops = 0;
    await checkVanishedAll([healthy('item_a', ['a1', 'a2']), healthy('item_b', ['b1', 'b2'])], NOW);
    const two = fake.ops;

    fake.ops = 0;
    await checkVanishedAll(
      [
        healthy('item_a', ['a1', 'a2']),
        healthy('item_b', ['b1', 'b2']),
        healthy('item_c', ['c1', 'c2']),
      ],
      NOW
    );
    const three = fake.ops;

    // The property that actually matters, and the one a regression to per-item
    // reads would break. An absolute bound would not: per-item reads for two
    // institutions cost only one more than batched, so any loose threshold
    // passes both.
    expect(three).toBe(two);
    // Exactly two: one hgetall for the remembered hash, one for the records.
    expect(two).toBe(2);
  });

  test('costs nothing at all when there are no institutions', async () => {
    fake.ops = 0;
    expect(await checkVanishedAll([], NOW)).toEqual({});
    expect(fake.ops).toBe(0);
  });
});

describe('the single-Item form', () => {
  // Still exported for callers with one Item in hand; production uses the batch
  // form. Covered so it cannot rot unnoticed.
  test('behaves like the batch form', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);

    const res = await checkVanished('item_a', ['acct_1'], NOW);
    expect(res.unconfirmed).toEqual(['acct_2']);
  });

  test('refuses an empty account list too', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    expect(await checkVanished('item_a', [], NOW)).toEqual({ unconfirmed: [], accepted: [] });
  });
});

describe('forgetVanished', () => {
  test('drops the record so a relinked Item starts clean', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await check('item_a', ['acct_1'], NOW);

    await forgetVanished('item_a');

    expect(await record('item_a')).toBeNull();
  });
});
