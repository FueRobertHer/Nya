import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { factsAbout } from './facts-about';

// What a Plaid disconnect does to the tax facts (lib/disconnect-item.ts): what
// was said about the connection's accounts goes, since a re-added account usually
// comes back under a new id and nothing carries it across a link. Best effort, as
// the disconnect's other steps are: a problem with the facts never stops it.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const removed: string[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {
      itemRemove: async (req: { access_token: string }) => {
        removed.push(req.access_token);
        return { data: {} };
      },
    } as Record<string, unknown>,
    { get: (known, name: string) => known[name] ?? (async () => ({})) }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { saveItem, getItems } = await import('@/lib/storage');
const { recordDirectory, directoryIdsForItem } = await import('@/lib/links');
const { rememberAccounts } = await import('@/lib/last-known');
const { planFactsStore } = await import('@/lib/plan-copies');
const route = await import('@/app/api/disconnect/route');

const ctx = TEST_CTX;
const DAMAGED = 'damaged-bytes-not-ciphertext-at-all';

beforeEach(async () => {
  fake.reset();
  removed.length = 0;
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'gone', institution_name: 'Bank gone', encrypted_access_token: await encrypt(ctx, 'tok_gone') });
  await saveItem(ctx, { item_id: 'kept', institution_name: 'Bank kept', encrypted_access_token: await encrypt(ctx, 'tok_kept') });
});

const seen = (item_id: string, ...ids: string[]) => ({ item_id, institution_name: `Bank ${item_id}`, error: null, accounts: ids.map((account_id) => ({ account_id, type: 'depository' })) });
const disconnect = async (item_id: string) => {
  const res = await route.POST(new Request('http://localhost/api/disconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ item_id }) }));
  return { status: res.status, body: await res.json() };
};
const itemIds = async () => (await getItems(ctx)).map((i) => i.item_id).sort();
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const error = console.error;
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.error = error;
  }
};

describe('disconnecting a Plaid connection', () => {
  test('what was said about its accounts goes, and only that: another connection’s accounts and the Roth amounts stay', async () => {
    await recordDirectory(ctx, [seen('gone', 'a', 'b'), seen('kept', 'c')]);
    await planFactsStore.set(ctx, factsAbout('a', 'b', 'c'));
    expect(await disconnect('gone')).toEqual({ status: 200, body: { success: true } });
    expect(await planFactsStore.get(ctx)).toEqual(factsAbout('c'));
    expect(removed).toEqual(['tok_gone']);
    expect(await itemIds()).toEqual(['kept']);
  });

  test('an account only the directory still holds goes: it closed, so the remembered record dropped it', async () => {
    await recordDirectory(ctx, [seen('gone', 'closed', 'open')]);
    await rememberAccounts(ctx, [seen('gone', 'open')]);
    await planFactsStore.set(ctx, factsAbout('closed', 'open', 'other'));
    await disconnect('gone');
    expect(await planFactsStore.get(ctx)).toEqual(factsAbout('other'));
  });

  test('an account only the remembered record holds goes: the directory is best effort', async () => {
    await rememberAccounts(ctx, [seen('gone', 'a')]);
    await planFactsStore.set(ctx, factsAbout('a', 'other'));
    await disconnect('gone');
    expect(await planFactsStore.get(ctx)).toEqual(factsAbout('other'));
  });

  test('a stale id with no stored connection clears them too, and Plaid is not called', async () => {
    await recordDirectory(ctx, [seen('stale', 'a')]);
    await planFactsStore.set(ctx, factsAbout('a', 'other'));
    expect((await disconnect('stale')).status).toBe(200);
    expect(await planFactsStore.get(ctx)).toEqual(factsAbout('other'));
    expect(removed).toEqual([]);
  });

  test('none of its accounts named: facts aren’t made', async () => {
    await recordDirectory(ctx, [seen('gone', 'a')]);
    expect((await disconnect('gone')).status).toBe(200);
    expect(await fake.type(ctxKey('plan-facts'))).toBe('none');
  });

  test('damaged bytes hold nothing to take out: the disconnect goes ahead and they stay as they are', async () => {
    await recordDirectory(ctx, [seen('gone', 'a')]);
    await fake.set(ctxKey('plan-facts'), DAMAGED);
    expect((await disconnect('gone')).status).toBe(200);
    expect(await fake.get<string>(ctxKey('plan-facts'))).toBe(DAMAGED);
    expect(removed).toEqual(['tok_gone']);
  });

  test('facts this version doesn’t recognise never hold a disconnect back: it goes ahead, and they stay for Forget', async () => {
    await recordDirectory(ctx, [seen('gone', 'a')]);
    const newer = await encrypt(ctx, '{"version":3}');
    await fake.set(ctxKey('plan-facts'), newer);
    expect(await quiet(() => disconnect('gone'))).toEqual({ status: 200, body: { success: true } });
    expect(removed).toEqual(['tok_gone']);
    expect(await itemIds()).toEqual(['kept']);
    expect(await fake.get<string>(ctxKey('plan-facts'))).toBe(newer);
    // Its name stays in the directory, so Earlier accounts can still offer Forget.
    expect(await directoryIdsForItem(ctx, 'gone')).toEqual(['a']);
  });
});
