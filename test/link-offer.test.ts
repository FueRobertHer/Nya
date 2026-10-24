import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Home's row about reconnected accounts to link (rollout phase 4d): what
// Settings > Connections suggests, worked out from the account directory
// alone (lib/links.ts linkOfferForDisplay), and applied to the dashboard's
// load (app/api/net-worth) without ever being cached. Plaid is stubbed: the
// bank answers with one checking account, ••4821, that replaced an earlier
// one with the same mask at a connection since removed.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const plaid = { accounts: [] as any[], down: new Set<string>() };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async (req: any) => {
      if (plaid.down.has(req.access_token)) throw { response: { data: { error_code: 'INSTITUTION_DOWN' } } };
      return { data: { item: { institution_id: 'ins_1' }, accounts: plaid.accounts } };
    },
    investmentsHoldingsGet: async () => ({ data: { accounts: [], holdings: [], securities: [] } }),
    liabilitiesGet: async () => ({ data: { liabilities: {} } }),
    itemRemove: async () => ({ data: {} }),
  },
}));

const { encrypt, decrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { rememberAccounts } = await import('@/lib/last-known');
const links = await import('@/lib/links');
const route = await import('@/app/api/net-worth/route');

const checking = (account_id: string) => ({
  account_id,
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask: '4821',
  balances: { available: null, current: 1000, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null },
});
type Entry = import('@/lib/links').DirectoryEntry;
const entry = (over: Partial<Entry>): Entry => ({
  item_id: 'item_bank',
  institution_id: 'ins_1',
  institution_name: 'Bank',
  name: 'Checking',
  official_name: null,
  mask: '4821',
  type: 'depository',
  subtype: 'checking',
  persistent_account_id: null,
  first_seen: '2026-09-14',
  last_seen: '2026-09-14',
  ...over,
});
const OLD = entry({ item_id: 'item_old', first_seen: '2025-01-02', last_seen: '2026-09-10' });
const NAME = 'Bank Checking ••4821';

const saveEntry = async (id: string, e: Entry) => fake.hset(ctxKey('accounts:directory'), { [id]: await encrypt(TEST_CTX, JSON.stringify(e)) });
async function load(query = '?refresh=1') {
  const res = await route.GET(new Request(`http://x/api/net-worth${query}`));
  return (await res.json()) as any;
}
async function settings() {
  const res = await (await import('@/app/api/account-links/route')).GET(new Request('http://x/api/account-links'));
  return (await res.json()) as any;
}

beforeEach(async () => {
  setSystemTime(new Date('2026-09-14T17:00:00Z'));
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(TEST_CTX, { item_id: 'item_bank', institution_name: 'Bank', encrypted_access_token: await encrypt(TEST_CTX, 'tok') });
  plaid.accounts = [checking('new')];
  plaid.down = new Set();
  await saveEntry('old', OLD);
});
afterEach(() => setSystemTime());

describe('the dashboard’s load', () => {
  test('a live load names the reconnected account, once it is in the directory, as Settings does', async () => {
    const body = await load();
    expect(body.link_offer).toEqual([NAME]);
    expect((await settings()).suggestions.map((s: any) => s.to_label)).toEqual([NAME]);
  });

  test('never cached: a cached load reads it afresh, so a decline ends it at once', async () => {
    await load();
    const cached = JSON.parse(await decrypt(TEST_CTX, (await fake.get<string>(ctxKey('cache:net-worth')))!));
    expect(cached.link_offer).toBeUndefined();
    const again = await load('');
    expect(again.from_cache).toBe(true);
    expect(again.link_offer).toEqual([NAME]);

    await links.dismissPair(TEST_CTX, 'old', 'new');
    const declined = await load('');
    expect(declined.from_cache).toBe(true);
    expect(declined.link_offer).toBeUndefined();
  });

  test('absent when nothing is suggested', async () => {
    await fake.hdel(ctxKey('accounts:directory'), 'old');
    expect((await load()).link_offer).toBeUndefined();
  });
});

// Home reads the directory's last day where Settings also reads the history:
// the two must keep pace, so a nightly run with a broken bank still records
// the directory for the banks it recorded balances for, as a load does.
describe('the nightly snapshot', () => {
  test('a run with a bank down records the directory of those that answered', async () => {
    await saveItem(TEST_CTX, { item_id: 'item_down', institution_name: 'Other', encrypted_access_token: await encrypt(TEST_CTX, 'down') });
    plaid.down.add('down');
    const { snapshotData } = await import('@/lib/snapshot-job');
    expect((await snapshotData(TEST_CTX, [])).status).toBe('unclean');
    const stored = await fake.hget<string>(ctxKey('accounts:directory'), 'new');
    expect(stored && JSON.parse(await decrypt(TEST_CTX, stored)).last_seen).toBe('2026-09-14');
  });
});

describe('linkOfferForDisplay', () => {
  const remember = (item_id: string, account_id: string) =>
    rememberAccounts(TEST_CTX, [{ item_id, institution_name: 'Bank', error: null, accounts: [{ ...checking(account_id), balances: undefined }] } as any]);
  beforeEach(async () => {
    await saveEntry('new', entry({}));
    await remember('item_bank', 'new');
  });

  test('a pair Settings suggests, by the name Settings gives it, without reading the balance history', async () => {
    // A read of the history would fail the whole answer: the directory alone decides.
    const hgetall = fake.hgetall.bind(fake);
    fake.hgetall = (async (key: string) => {
      if (key.startsWith(ctxKey('history:'))) throw new Error('the history was read');
      return hgetall(key);
    }) as typeof fake.hgetall;
    try {
      expect(await links.linkOfferForDisplay(TEST_CTX)).toEqual([NAME]);
    } finally {
      fake.hgetall = hgetall;
    }
  });

  // The usual reconnect: the bank added again while the old connection is
  // still there, broken, then the old one removed. The pair exists only then.
  test('nothing while the earlier account’s connection is still stored, the pair once it is removed', async () => {
    await saveItem(TEST_CTX, { item_id: 'item_old', institution_name: 'Bank', encrypted_access_token: await encrypt(TEST_CTX, 'old') });
    await remember('item_old', 'old');
    expect(await links.linkOfferForDisplay(TEST_CTX)).toEqual([]);
    await fake.hdel(ctxKey('plaid:items'), 'item_old');
    expect(await links.linkOfferForDisplay(TEST_CTX)).toEqual([NAME]);
  });

  test('ends once linked, declined, or "None of these"', async () => {
    await links.linkAccounts(TEST_CTX, 'old', 'new', {});
    expect(await links.linkOfferForDisplay(TEST_CTX)).toEqual([]);
    await links.unlinkAccount(TEST_CTX, 'old');
    expect(await links.linkOfferForDisplay(TEST_CTX)).toEqual([NAME]);
    await links.dismissPair(TEST_CTX, 'old', 'new');
    expect(await links.linkOfferForDisplay(TEST_CTX)).toEqual([]);
    await fake.del(ctxKey('account-links:dismissed'));
    await links.dismissAll(TEST_CTX, 'old');
    expect(await links.linkOfferForDisplay(TEST_CTX)).toEqual([]);
  });

  test('declines that can’t be read offer nothing, rather than offering a declined pair again', async () => {
    await links.dismissPair(TEST_CTX, 'old', 'new');
    const hgetall = fake.hgetall.bind(fake);
    fake.hgetall = (async (key: string) => {
      if (key === ctxKey('account-links:dismissed')) throw new Error('down');
      return hgetall(key);
    }) as typeof fake.hgetall;
    try {
      expect(await links.linkOfferForDisplay(TEST_CTX)).toEqual([]);
    } finally {
      fake.hgetall = hgetall;
    }
  });

  test('a connection whose accounts can’t be read offers nothing, rather than taking its accounts for earlier ones', async () => {
    // The earlier account's connection is still stored, but its record of
    // its accounts is damaged: read leniently, "old" would look gone.
    await saveItem(TEST_CTX, { item_id: 'item_old', institution_name: 'Bank', encrypted_access_token: await encrypt(TEST_CTX, 'old') });
    await fake.hset(ctxKey('accounts:meta'), { item_old: 'damaged' });
    expect(await links.linkOfferForDisplay(TEST_CTX)).toEqual([]);
  });
});
