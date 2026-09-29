import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, testKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The admin's view of unused connections across every account
// (lib/admin-items.ts and /api/admin/unused): who may see it, and that removal
// is fenced (only a flagged Item, confirmed again by a read made just before).

const admin = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const DAY = 86_400_000;
const plaid = {
  fail: {} as Record<string, string>,
  removed: [] as string[],
  read: [] as string[], // access tokens /accounts/get was asked about
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async (req: any) => {
      plaid.read.push(req.access_token);
      const code = plaid.fail[req.access_token];
      if (code) throw { response: { data: { error_code: code } } };
      return { data: { item: {}, accounts: [{ account_id: `acct_${req.access_token}` }] } };
    },
    itemRemove: async (req: any) => {
      plaid.removed.push(req.access_token);
      return { data: {} };
    },
    itemWebhookUpdate: async () => ({ data: {} }),
  },
}));

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { saveItem, getItems } = await import('@/lib/storage');
const { checkItemUsage } = await import('@/lib/item-usage');
const { isAdmin, listFlagged, removeFlagged } = await import('@/lib/admin-items');
const route = await import('@/app/api/admin/unused/route');

const OTHER = { container: '7c1d9e4a-52b3-4f6e-9a08-3d2e1f0a9b8c' } as typeof admin;

async function link(ctx: typeof admin, item_id: string, token: string) {
  await saveItem(ctx, { item_id, institution_name: `Bank ${item_id}`, encrypted_access_token: await encrypt(token) });
}
/** Starts the clock long enough ago that the next check flags an Item Plaid refuses. */
async function aged(ctx: typeof admin) {
  await checkItemUsage(ctx, { now: Date.now() - 61 * DAY, days: 60 });
}
const ids = async (ctx: typeof admin) => (await getItems(ctx)).map((i) => i.item_id).sort();

const errors = console.error;
beforeEach(async () => {
  fake.reset();
  plaid.fail = {};
  plaid.removed = [];
  plaid.read = [];
  console.error = () => {};
  await registerTestContainer(fake);
  await fake.hset(testKey('containers'), {
    [OTHER.container]: JSON.stringify({ status: 'active', primary: false, created_at: '2026-02-01T00:00:00.000Z' }),
  });
});
afterEach(() => {
  console.error = errors;
});

describe('who is the admin', () => {
  test('the deployment\'s own (primary) container, and no other', async () => {
    expect(await isAdmin(admin)).toBe(true);
    expect(await isAdmin(OTHER)).toBe(false);
  });
});

describe('the list', () => {
  test('shows flagged connections from every account, labelled by owner', async () => {
    await link(admin, 'mine', 'tok_mine');
    await link(OTHER, 'theirs', 'tok_theirs');
    await link(OTHER, 'fine', 'tok_fine');
    plaid.fail.tok_mine = 'ITEM_LOGIN_REQUIRED';
    plaid.fail.tok_theirs = 'ITEM_LOGIN_REQUIRED';
    await aged(admin);
    await aged(OTHER);
    await checkItemUsage(admin);
    await checkItemUsage(OTHER);

    const rows = await listFlagged(admin);
    expect(rows.map((r) => [r.owner, r.item_id, r.kind]).sort()).toEqual([
      ['Account from 2026-02-01', 'theirs', 'refused'],
      ['You', 'mine', 'refused'],
    ]);
  });

  test('is empty when nothing is flagged, and skips accounts that are not active', async () => {
    await link(OTHER, 'theirs', 'tok_theirs');
    plaid.fail.tok_theirs = 'ITEM_LOGIN_REQUIRED';
    await aged(OTHER);
    await checkItemUsage(OTHER);
    await fake.hset(testKey('containers'), {
      [OTHER.container]: JSON.stringify({ status: 'restoring', primary: false, created_at: '2026-02-01T00:00:00.000Z' }),
    });
    expect(await listFlagged(admin)).toEqual([]);
  });
});

describe('removing one', () => {
  async function flagOthers() {
    await link(OTHER, 'theirs', 'tok_theirs');
    await link(OTHER, 'keep', 'tok_keep');
    plaid.fail.tok_theirs = 'ITEM_LOGIN_REQUIRED';
    await aged(OTHER);
    await checkItemUsage(OTHER);
  }

  test('disconnects a flagged connection, and only that one', async () => {
    await flagOthers();
    expect(await removeFlagged(OTHER.container, 'theirs')).toEqual({ ok: true });
    expect(await ids(OTHER)).toEqual(['keep']);
    expect(plaid.removed).toEqual(['tok_theirs']);
  });

  test('rechecks only the connection being removed, not the whole account', async () => {
    await flagOthers();
    plaid.read = [];
    expect(await removeFlagged(OTHER.container, 'theirs')).toEqual({ ok: true });
    expect(plaid.read).toEqual(['tok_theirs']);
  });

  test('refuses one that is not flagged', async () => {
    await flagOthers();
    const res = await removeFlagged(OTHER.container, 'keep');
    expect(res.ok).toBe(false);
    expect(await ids(OTHER)).toEqual(['keep', 'theirs']);
    expect(plaid.removed).toEqual([]);
  });

  test('refuses one its owner reconnected since the last check', async () => {
    await flagOthers();
    delete plaid.fail.tok_theirs;
    const res = await removeFlagged(OTHER.container, 'theirs');
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(await ids(OTHER)).toEqual(['keep', 'theirs']);
    expect(plaid.removed).toEqual([]);
  });

  test('refuses when Plaid does not answer, rather than acting on an old flag', async () => {
    await flagOthers();
    plaid.fail.tok_theirs = 'ETIMEDOUT';
    const res = await removeFlagged(OTHER.container, 'theirs');
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(await ids(OTHER)).toEqual(['keep', 'theirs']);
    expect(plaid.removed).toEqual([]);
  });

  test('refuses an account that is not active, a bad id, and a connection from another account', async () => {
    await flagOthers();
    expect(await removeFlagged('not-a-container', 'theirs')).toMatchObject({ ok: false, status: 400 });
    expect(await removeFlagged(OTHER.container, 42)).toMatchObject({ ok: false, status: 400 });
    // Named against the wrong account: not in its flagged list.
    expect(await removeFlagged(admin.container, 'theirs')).toMatchObject({ ok: false, status: 409 });
    await fake.hset(testKey('containers'), {
      [OTHER.container]: JSON.stringify({ status: 'restoring', primary: false, created_at: '2026-02-01T00:00:00.000Z' }),
    });
    expect(await removeFlagged(OTHER.container, 'theirs')).toMatchObject({ ok: false, status: 409 });
    expect(plaid.removed).toEqual([]);
  });
});

describe('the route', () => {
  const body = (b: unknown) => new Request('http://x/api/admin/unused', { method: 'DELETE', body: JSON.stringify(b) });

  test('lists, checks and removes for the admin', async () => {
    await link(OTHER, 'theirs', 'tok_theirs');
    plaid.fail.tok_theirs = 'ITEM_LOGIN_REQUIRED';
    await aged(OTHER);

    expect((await (await route.GET()).json()).items).toEqual([]); // nothing flagged until a check runs
    const checked = await (await route.POST()).json();
    expect(checked.items.map((i: any) => [i.owner, i.item_id, i.institution_name])).toEqual([['Account from 2026-02-01', 'theirs', 'Bank theirs']]);
    expect(checked.flag_after_days).toBe(60);
    expect(plaid.removed).toEqual([]); // listing and checking remove nothing

    const removed = await route.DELETE(body({ container: OTHER.container, item_id: 'theirs' }));
    expect(removed.status).toBe(200);
    expect((await removed.json()).items).toEqual([]);
    expect(await ids(OTHER)).toEqual([]);
  });

  test('answers a malformed or unflagged removal with a refusal, not a deletion', async () => {
    await link(OTHER, 'theirs', 'tok_theirs');
    expect((await route.DELETE(body({}))).status).toBe(400);
    expect((await route.DELETE(new Request('http://x', { method: 'DELETE', body: 'nope' }))).status).toBe(400);
    expect((await route.DELETE(body({ container: OTHER.container, item_id: 'theirs' }))).status).toBe(409);
    expect(await ids(OTHER)).toEqual(['theirs']);
  });
});
