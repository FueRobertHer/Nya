import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { FakeRedis, storageMock, testKey } from './fake-redis';

// Linking an account's history across a reconnect (lib/links.ts). The
// guarantees under test: nothing is linked that wasn't offered, links never
// cross institutions or manual accounts, stored data is never rewritten, and
// hidden accounts stay hidden through a link.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const links = await import('@/lib/links');
const { getAccountHistory, recordSnapshot } = await import('@/lib/history');
const { rememberAccounts } = await import('@/lib/last-known');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 24, 12);

type Entry = import('@/lib/links').DirectoryEntry;
const entry = (over: Partial<Entry> = {}): Entry => ({
  item_id: 'item_new',
  institution_id: 'ins_1',
  institution_name: 'Capital One',
  name: 'Quicksilver',
  official_name: null,
  mask: '1234',
  type: 'credit',
  subtype: 'credit card',
  persistent_account_id: null,
  first_seen: '2026-07-17',
  last_seen: '2026-09-24',
  ...over,
});
const span = (first: string, last: string, lastBalance = 100) => ({ first, last, firstBalance: lastBalance, lastBalance });
const suggest = (over: Partial<Parameters<typeof links.suggestLinks>[0]> = {}) =>
  links.suggestLinks({
    directory: {
      old: entry({ item_id: 'item_old', first_seen: '2026-01-01', last_seen: '2026-07-16' }),
      new: entry(),
    },
    spans: {},
    liveIds: new Set(['new']),
    links: new Map(),
    dismissed: new Set(),
    ...over,
  });

beforeEach(() => fake.reset());

describe('suggestLinks', () => {
  test('pairs an account that stopped with one that started, same institution, type and mask', () => {
    const { suggestions } = suggest();
    expect(suggestions.map((s) => [s.old, s.to])).toEqual([['old', 'new']]);
  });

  test('matches across a re-add on institution_id, whatever the display name', () => {
    const { suggestions } = suggest({
      directory: {
        old: entry({ item_id: 'item_old', institution_name: 'Capital One 360', first_seen: '2026-01-01', last_seen: '2026-07-16' }),
        new: entry(),
      },
    });
    expect(suggestions).toHaveLength(1);
  });

  test('never across institutions, types or masks', () => {
    const old = { item_id: 'item_old', first_seen: '2026-01-01', last_seen: '2026-07-16' };
    expect(suggest({ directory: { old: entry({ ...old, institution_id: 'ins_2', institution_name: 'Chase' }), new: entry() } }).suggestions).toHaveLength(0);
    expect(suggest({ directory: { old: entry({ ...old, subtype: 'checking', type: 'depository' }), new: entry() } }).suggestions).toHaveLength(0);
    expect(suggest({ directory: { old: entry({ ...old, mask: '9999' }), new: entry() } }).suggestions).toHaveLength(0);
    expect(suggest({ directory: { old: entry({ ...old, mask: null }), new: entry({ mask: null }) } }).suggestions).toHaveLength(0);
  });

  // Masks can repeat within an institution: two candidates means no suggestion.
  test('only when the pairing is unique both ways', () => {
    const old = { item_id: 'item_old', first_seen: '2026-01-01', last_seen: '2026-07-16' };
    const twoOld = suggest({ directory: { old: entry(old), old2: entry(old), new: entry() } });
    expect(twoOld.suggestions).toHaveLength(0);
    const twoNew = suggest({ directory: { old: entry(old), new: entry(), new2: entry() }, liveIds: new Set(['new', 'new2']) });
    expect(twoNew.suggestions).toHaveLength(0);
  });

  test('only within the window after the old account was last seen', () => {
    const late = suggest({ directory: { old: entry({ item_id: 'item_old', last_seen: '2026-05-01' }), new: entry() } });
    expect(late.suggestions).toHaveLength(0);
    const before = suggest({ directory: { old: entry({ item_id: 'item_old', last_seen: '2026-08-01' }), new: entry() } });
    expect(before.suggestions).toHaveLength(0);
  });

  test('never a dismissed pair, a live old account, an already-linked one, or a manual one', () => {
    expect(suggest({ dismissed: new Set(['old>new']) }).suggestions).toHaveLength(0);
    expect(suggest({ liveIds: new Set(['new', 'old']) }).suggestions).toHaveLength(0);
    const linked = new Map([['old', { to: 'x', linked_at: '2026-08-01', evidence: {} }]]);
    expect(suggest({ links: linked }).suggestions).toHaveLength(0);
    const manual = suggest({
      directory: { manual_old: entry({ item_id: 'manual', last_seen: '2026-07-16' }), manual_new: entry({ item_id: 'manual' }) },
      liveIds: new Set(['manual_new']),
    });
    expect(manual.suggestions).toHaveLength(0);
  });

  // A deleted manual account's balances must not be offered to a new account:
  // a recreated manual account must not inherit a deleted one's series.
  test('never offers the history of a manual account for assignment', () => {
    const { unclaimed } = suggest({
      directory: { new: entry({ first_seen: '2026-07-17' }) },
      spans: { manual_old: span('2026-07-01', '2026-07-10') },
    });
    expect(unclaimed).toEqual([]);
  });

  test('flags a shared persistent account id as strong evidence', () => {
    const { suggestions } = suggest({
      directory: {
        old: entry({ item_id: 'item_old', last_seen: '2026-07-16', persistent_account_id: 'p1' }),
        new: entry({ persistent_account_id: 'p1' }),
      },
    });
    expect(suggestions[0].evidence.persistent_match).toBe(true);
  });

  // The July relinks: old ids known only from balances, no directory entry.
  test('offers balance-only history for the user to assign, to accounts that appeared after it', () => {
    const { unclaimed, suggestions } = suggest({
      directory: { new: entry({ first_seen: '2026-07-17' }), older: entry({ first_seen: '2026-01-01', mask: '5555' }) },
      spans: { A7: span('2026-07-12', '2026-07-16', 850) },
      liveIds: new Set(['new', 'older']),
    });
    expect(suggestions).toHaveLength(0);
    expect(unclaimed).toEqual([
      { old: 'A7', first: '2026-07-12', last: '2026-07-16', last_balance: 850, candidates: [{ id: 'new', label: 'Capital One Quicksilver ••1234' }] },
    ]);
  });

  test('isOffered accepts only what was offered', () => {
    const offer = suggest({
      directory: { old: entry({ item_id: 'item_old', last_seen: '2026-07-16' }), new: entry() },
      spans: { A7: span('2026-07-12', '2026-07-16') },
    });
    expect(links.isOffered('old', 'new', offer)).toBe(true);
    expect(links.isOffered('A7', 'new', offer)).toBe(true);
    expect(links.isOffered('old', 'somewhere', offer)).toBe(false);
    expect(links.isOffered('anything', 'new', offer)).toBe(false);
  });
});

describe('following links', () => {
  const L = (pairs: [string, string, string][]) =>
    new Map(pairs.map(([old, to, at]) => [old, { to, linked_at: at, evidence: {} }]));

  test('resolveId follows chains, and a cycle stops', () => {
    expect(links.resolveId('a', L([['a', 'b', '1'], ['b', 'c', '2']]))).toBe('c');
    expect(() => links.resolveId('a', L([['a', 'b', '1'], ['b', 'a', '2']]))).not.toThrow();
  });

  test('sameAccountIds lists the current id first, then older ones newest link first', () => {
    expect(links.sameAccountIds('c', L([['a', 'b', '2026-07-01'], ['b', 'c', '2026-08-01']]))).toEqual(['c', 'b', 'a']);
  });

  test('a link whose old id is live again is ignored', () => {
    const live = links.effectiveLinks(L([['a', 'b', '1']]), new Set(['a', 'b']));
    expect(live.size).toBe(0);
  });

  // Hiding one id of an account hides every id it has had, and the client
  // sees one current id per account.
  test('hidden accounts follow links', () => {
    const hidden = new Map([['old', { type: 'credit', hidden_at: 'x' }]]);
    const ls = L([['old', 'new', '1']]);
    expect([...links.expandHidden(hidden, ls).keys()].sort()).toEqual(['new', 'old']);
    expect(links.hiddenForClient(hidden, ls)).toEqual([{ account_id: 'new', type: 'credit' }]);
  });
});

describe('recordDirectory', () => {
  const inst = (accounts: any[], over: any = {}) => ({ item_id: 'item1', institution_name: 'Vanguard', institution_id: 'ins_v', error: null, accounts, ...over });
  const read = async () => {
    const raw = (await fake.hgetall<Record<string, string>>(testKey('accounts:directory'))) ?? {};
    const { decrypt } = await import('@/lib/crypto');
    return Object.fromEntries(await Promise.all(Object.entries(raw).map(async ([k, v]) => [k, JSON.parse(await decrypt(v))])));
  };

  // Otherwise every existing account would look newly opened the day this
  // shipped, and nothing could ever be matched.
  test('dates a new entry from the account’s earliest recorded balance', async () => {
    await fake.hset(testKey('history:accounts'), { '2026-07-15': await encrypt(JSON.stringify({ ira: 10 })) });
    await links.recordDirectory([inst([{ account_id: 'ira', name: 'IRA', mask: '1', type: 'investment', subtype: 'ira' }])], NOW);
    expect((await read()).ira.first_seen).toBe('2026-07-15');
  });

  test('never rewrites an entry it could not read', async () => {
    await fake.hset(testKey('accounts:directory'), { ira: 'not-a-ciphertext' });
    await links.recordDirectory([inst([{ account_id: 'ira', type: 'investment' }])], NOW);
    expect(await fake.hget<string>(testKey('accounts:directory'), 'ira')).toBe('not-a-ciphertext');
  });

  test('skips failed institutions and manual accounts', async () => {
    await links.recordDirectory([inst([{ account_id: 'x' }], { error: 'down' }), inst([{ account_id: 'manual_1' }], { manual: true })], NOW);
    expect(await read()).toEqual({});
  });

  test('writes nothing more on a second load the same day', async () => {
    await links.recordDirectory([inst([{ account_id: 'ira', type: 'investment' }])], NOW);
    fake.ops = 0;
    await links.recordDirectory([inst([{ account_id: 'ira', type: 'investment' }])], NOW + 1000);
    expect(fake.ops).toBe(1); // the read, no write
  });

  test('prunes an unlinked disconnected entry after the window, but not a linked one', async () => {
    await links.recordDirectory([inst([{ account_id: 'gone' }, { account_id: 'kept' }], { item_id: 'old' })], NOW);
    await links.markDisconnected('old', NOW);
    await links.linkAccounts('kept', 'new', {});
    await links.recordDirectory([inst([{ account_id: 'new' }])], NOW + 50 * DAY);
    const dir = await read();
    expect(dir.gone).toBeUndefined();
    expect(dir.kept).toBeDefined();
  });
});

describe('per-account history across a link', () => {
  test('joins the old id’s history onto the current account', async () => {
    await fake.hset(testKey('history:accounts'), {
      '2026-07-15': await encrypt(JSON.stringify({ old: 800 })),
      '2026-07-16': await encrypt(JSON.stringify({ old: 850 })),
      '2026-07-17': await encrypt(JSON.stringify({ new: 900 })),
    });
    const points = await getAccountHistory('new', ['old']);
    expect(points.map((p) => [p.date, p.value])).toEqual([
      ['2026-07-15', 800],
      ['2026-07-16', 850],
      ['2026-07-17', 900],
    ]);
    expect(await getAccountHistory('new')).toHaveLength(1); // unlinked: split, as before
  });

  test('the current id wins on a date both have', async () => {
    await fake.hset(testKey('history:accounts'), { '2026-07-17': await encrypt(JSON.stringify({ old: 1, new: 2 })) });
    expect((await getAccountHistory('new', ['old']))[0].value).toBe(2);
  });
});

describe('/api/account-links', () => {
  const call = async (method: string, body?: unknown) => {
    const route = await import('@/app/api/account-links/route');
    const handler = (route as any)[method];
    const res = await handler(new Request('http://x/api/account-links', { method, body: body ? JSON.stringify(body) : undefined }));
    return { status: res.status, body: await res.json() };
  };

  const setup = async () => {
    // A live account remembered for its Item, an old one only in history.
    await rememberAccounts([{ item_id: 'item_new', institution_name: 'Capital One', error: null, accounts: [{ account_id: 'new', name: 'Quicksilver', mask: '1234', type: 'credit', subtype: 'credit card' }] } as any]);
    await fake.hset(testKey('accounts:directory'), { new: await encrypt(JSON.stringify(entry())) });
    await fake.hset(testKey('history:accounts'), { '2026-07-16': await encrypt(JSON.stringify({ A7: 850 })) });
  };

  test('refuses to link a pair it does not offer', async () => {
    await setup();
    expect((await call('POST', { action: 'link', old: 'A7', to: 'elsewhere' })).status).toBe(409);
    expect((await call('POST', { action: 'link', old: 'made-up', to: 'new' })).status).toBe(409);
    expect((await call('POST', { action: 'link', old: 1, to: 'new' })).status).toBe(400);
  });

  test('links an offered pair, lists it, and unlinks it', async () => {
    await setup();
    const offer = await call('GET');
    expect(offer.body.unclaimed.map((u: any) => u.old)).toEqual(['A7']);
    expect((await call('POST', { action: 'link', old: 'A7', to: 'new' })).body).toEqual({ linked: true });
    const after = await call('GET');
    expect(after.body.links.map((l: any) => [l.old, l.to])).toEqual([['A7', 'new']]);
    expect(after.body.unclaimed).toEqual([]);
    await call('DELETE', { old: 'A7' });
    expect((await call('GET')).body.links).toEqual([]);
  });

  test('a dismissed pair is not offered again', async () => {
    await setup();
    await call('POST', { action: 'dismiss', old: 'A7', to: 'new' });
    expect((await call('GET')).body.unclaimed).toEqual([]);
  });
});

describe('recordSnapshot is untouched by links', () => {
  // Stored data is never rewritten: links are resolved on read only.
  test('a snapshot still records raw ids', async () => {
    await links.linkAccounts('old', 'new', {});
    await recordSnapshot(100, { new: 100 });
    const today = new Date().toISOString().slice(0, 10);
    const { decrypt } = await import('@/lib/crypto');
    const raw = await fake.hget<string>(testKey('history:accounts'), today);
    expect(JSON.parse(await decrypt(raw!))).toEqual({ new: 100 });
  });
});

describe('readers that follow links', () => {
  // An earlier id left hidden would keep hiding the account through the link.
  test('Unhide clears every id the account has had', async () => {
    const { setAccountHidden, getHiddenAccounts } = await import('@/lib/hidden');
    await setAccountHidden('old', 'credit', true);
    await links.linkAccounts('old', 'new', {});
    const { POST } = await import('@/app/api/hidden-accounts/route');
    await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ account_id: 'new', hidden: false }) }));
    expect([...(await getHiddenAccounts()).keys()]).toEqual([]);
  });

  // A linked earlier id whose account is present is not missing: without this
  // a partial rotation would pause every snapshot for three days.
  test('the vanished check counts a linked id as present', async () => {
    const { checkVanishedAll } = await import('@/lib/vanished');
    await rememberAccounts([{ item_id: 'i', institution_name: 'Bank', error: null, accounts: [{ account_id: 'old', type: 'credit' }, { account_id: 'keep', type: 'credit' }] } as any]);
    await links.linkAccounts('old', 'new', {});
    const result = await checkVanishedAll([{ item_id: 'i', accounts: [{ account_id: 'new' }, { account_id: 'keep' }] }], NOW);
    expect(result).toEqual({});
  });

  // A failing bank's account known now by a new id is found in a snapshot
  // taken while it still had its old one.
  test('last-known recovery finds a balance under a linked earlier id', async () => {
    const { fillFromLastKnown } = await import('@/lib/last-known');
    const recent = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
    await rememberAccounts([{ item_id: 'i', institution_name: 'Bank', error: null, accounts: [{ account_id: 'new', name: 'Card', type: 'credit' }] } as any]);
    await fake.hset(testKey('history:accounts'), { [recent]: await encrypt(JSON.stringify({ old: 420 })) });
    await links.linkAccounts('old', 'new', {});
    const inst: any = { item_id: 'i', institution_name: 'Bank', error: 'down', accounts: [], holdings: [] };
    await fillFromLastKnown([inst]);
    expect(inst.accounts.map((a: any) => [a.account_id, a.balance])).toEqual([['new', 420]]);
  });
});
