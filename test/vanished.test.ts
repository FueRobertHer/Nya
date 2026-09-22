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
    expect(await checkVanished('item_a', ['acct_1'], NOW)).toEqual({
      unconfirmed: [],
      accepted: [],
    });
  });

  test('every remembered account still present reports nothing', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);

    expect(await checkVanished('item_a', ['acct_1', 'acct_2'], NOW)).toEqual({
      unconfirmed: [],
      accepted: [],
    });
    expect(await record('item_a')).toBeNull(); // nothing persisted when nothing is wrong
  });
});

describe('an account disappears from a healthy fetch', () => {
  test('is unconfirmed at first, and closes the gate', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);

    const res = await checkVanished('item_a', ['acct_1'], NOW);

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
    await checkVanished('item_a', ['acct_1'], NOW);

    // Meta now reflects only what answered.
    await remember('item_a', ['acct_1']);

    const res = await checkVanished('item_a', ['acct_1'], NOW + DAY);
    expect(res.unconfirmed).toEqual(['acct_2']);
    // And the original timestamp survived, so the window is not restarted.
    expect(await record('item_a')).toEqual({ acct_2: new Date(NOW).toISOString() });
  });

  test('is accepted once it has been absent past the window', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await checkVanished('item_a', ['acct_1'], NOW);

    const res = await checkVanished('item_a', ['acct_1'], NOW + 4 * DAY);

    // Accepted does NOT close the gate: a real closure should cost a few days
    // of gap, not a permanent freeze on a condition nothing can clear while
    // the lifecycle UI is unbuilt.
    expect(res.unconfirmed).toEqual([]);
    expect(res.accepted).toEqual(['acct_2']);
  });

  test('is still unconfirmed on the last day of the window', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await checkVanished('item_a', ['acct_1'], NOW);

    const res = await checkVanished('item_a', ['acct_1'], NOW + 2 * DAY);
    expect(res.unconfirmed).toEqual(['acct_2']);
  });
});

describe('the glitch case', () => {
  test('an account that comes back clears its record', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await checkVanished('item_a', ['acct_1'], NOW);
    expect(await record('item_a')).not.toBeNull();

    const res = await checkVanished('item_a', ['acct_1', 'acct_2'], NOW + DAY);

    expect(res).toEqual({ unconfirmed: [], accepted: [] });
    expect(await record('item_a')).toBeNull();
  });

  test('a later disappearance starts a fresh window, not an inherited one', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await checkVanished('item_a', ['acct_1'], NOW); // vanishes
    await checkVanished('item_a', ['acct_1', 'acct_2'], NOW + DAY); // returns

    // Months later it vanishes again. If the old timestamp had been kept, this
    // would be accepted as closed instantly on the strength of an absence that
    // already resolved.
    const res = await checkVanished('item_a', ['acct_1'], NOW + 90 * DAY);
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
    const res = await checkVanished('item_a', ['acct_1'], NOW);
    expect(res.unconfirmed).toEqual(['acct_2']);
    expect(res.accepted).toEqual([]);
  });

  test('an unreadable record restarts the window rather than accepting', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await fake.hset(testKey('accounts:vanished'), { item_a: 'not-ciphertext' });

    const res = await checkVanished('item_a', ['acct_1'], NOW);
    expect(res.unconfirmed).toEqual(['acct_2']);
  });

  test('a failed Redis read does not report a disappearance', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    fake.failNext('hget', 2); // remembered ids, then the record

    const res = await checkVanished('item_a', ['acct_1'], NOW);
    expect(res).toEqual({ unconfirmed: [], accepted: [] });
  });
});

describe('a settled closure stops being reported', () => {
  test('is pruned once the institution no longer remembers it', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await checkVanished('item_a', ['acct_1'], NOW);

    // Past the window, and rememberAccounts has since pruned meta (which it
    // does once the gate reopens and a healthy fetch is recorded).
    await remember('item_a', ['acct_1']);
    const first = await checkVanished('item_a', ['acct_1'], NOW + 4 * DAY);
    expect(first.accepted).toEqual(['acct_2']);

    // Without pruning, this entry would stay a candidate forever: reported as
    // accepted and logged on every single load, and the record would grow by
    // one permanent entry per closed account.
    expect(await record('item_a')).toBeNull();
    const second = await checkVanished('item_a', ['acct_1'], NOW + 5 * DAY);
    expect(second).toEqual({ unconfirmed: [], accepted: [] });
  });

  test('is NOT pruned while the institution still remembers it', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await checkVanished('item_a', ['acct_1'], NOW);

    // meta still lists it, so dropping the record here would make the next run
    // rediscover it with a fresh window, and the two would cycle forever.
    const res = await checkVanished('item_a', ['acct_1'], NOW + 4 * DAY);
    expect(res.accepted).toEqual(['acct_2']);
    expect(await record('item_a')).toEqual({ acct_2: new Date(NOW).toISOString() });
  });
});

describe('checkVanishedAll', () => {
  test('checks several institutions on one read of the remembered hash', async () => {
    await remember('item_a', ['a1', 'a2']);
    await remember('item_b', ['b1']);

    fake.ops = 0;
    const res = await checkVanishedAll(
      [
        { item_id: 'item_a', accounts: [{ account_id: 'a1' }] },
        { item_id: 'item_b', accounts: [{ account_id: 'b1' }] },
      ],
      NOW
    );

    expect(res.item_a.unconfirmed).toEqual(['a2']);
    expect(res.item_b).toBeUndefined(); // healthy institutions are omitted

    // One hgetall for the remembered hash, then per-item record reads. The
    // per-institution form cost two reads each, which on a six-institution
    // dashboard load was twelve round trips on a path this repo has already
    // had to cut latency out of once.
    expect(fake.ops).toBeLessThan(6);
  });

  test('returns nothing for an empty institution list without touching Redis', async () => {
    fake.ops = 0;
    expect(await checkVanishedAll([], NOW)).toEqual({});
    expect(fake.ops).toBe(0);
  });
});

describe('forgetVanished', () => {
  test('drops the record so a relinked Item starts clean', async () => {
    await remember('item_a', ['acct_1', 'acct_2']);
    await checkVanished('item_a', ['acct_1'], NOW);

    await forgetVanished('item_a');

    expect(await record('item_a')).toBeNull();
  });
});
