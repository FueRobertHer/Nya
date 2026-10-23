import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CONTAINER, testKey } from './fake-redis';

// POST /api/ops/container-keys (lib/container-key-ops.ts): the status of the
// data keys per container, and destroying by hand the keys of containers the
// registry no longer lists.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const c = await import('@/lib/crypto');
const { registryKey } = await import('@/lib/containers');
const route = await import('@/app/api/ops/container-keys/route');

const MASTER = Buffer.alloc(32, 81).toString('base64');
const A = TEST_CONTAINER;
const B = '5d1c7e2a-9b3f-4c6d-8e1a-2b3c4d5e6f70';
const C = 'c0ffee00-1111-4222-8333-444455556666';
const GONE = 'deadbeef-0000-4000-8000-000000000000';

const post = (body?: string, auth = 'Bearer s3cret') =>
  route.POST(new Request('http://x/api/ops/container-keys', { method: 'POST', headers: auth ? { authorization: auth } : {}, body }));

async function register(...ids: string[]) {
  for (const id of ids) await fake.hset(registryKey(), { [id]: JSON.stringify({ status: 'active', primary: id === A, created_at: '2026-01-01T00:00:00.000Z' }) });
}
async function giveKey(container: string, born: boolean): Promise<string> {
  const p = (await c.prepareContainerKey(container as any, { born }))!;
  expect((await c.claimContainerKey(p)).outcome).toBe('made');
  return p.id;
}

const saved = { ...process.env };
let keyGone = '';
beforeEach(async () => {
  fake.reset();
  c.forgetActiveKey();
  process.env.MASTER_KEY = MASTER;
  process.env.OPS_ENABLED = '1';
  process.env.OPS_SECRET = 's3cret';
  delete process.env.BLOB_READ_WRITE_TOKEN;
  // A: no key yet. B: born with one. C: given one, not yet moved. GONE: an
  // account deleted while rolled back left its key behind.
  await register(A, B, C, GONE);
  await giveKey(B, true);
  await giveKey(C, false);
  keyGone = await giveKey(GONE, true);
  await fake.hdel(registryKey(), GONE);
});
afterEach(() => {
  process.env = { ...saved };
});

describe('the container keys route', () => {
  test('does not exist unless OPS_ENABLED is set, and needs the secret', async () => {
    delete process.env.OPS_ENABLED;
    expect((await post()).status).toBe(404);
    process.env.OPS_ENABLED = '1';
    expect((await post(undefined, 'Bearer nope')).status).toBe(401);
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'] as const) expect((await route[method]()).status).toBe(404);
  });

  test('an empty body reports, and writes nothing', async () => {
    await fake.hset(c.containerKeysKey(), { 'aaaaaaaa-0000-4000-8000-000000000000': JSON.stringify({ key: 'k99-00000000', since: '2026-01-01T00:00:00.000Z' }) });
    await fake.hset(c.containerKeysKey(), { 'bbbbbbbb-0000-4000-8000-000000000000': '{nope' });
    const before = JSON.stringify([...fake.hashes].map(([k, h]) => [k, [...h]]));
    const res = await post();
    expect(res.status).toBe(200);
    const status = await res.json();
    expect(status).toMatchObject({
      with_key: { count: 2, moved: 1 },
      without_key: { count: 1, ids: [A] },
      not_moved: { count: 1, ids: [C] },
      orphaned_keys: { count: 1, ids: [keyGone], containers: [GONE] },
      entries_missing_key: { count: 1, ids: ['aaaaaaaa-0000-4000-8000-000000000000'] },
      unreadable_entries: { count: 1, ids: ['bbbbbbbb-0000-4000-8000-000000000000'] },
      carried_forward: null,
      tombstones: 0,
      key_numbers: { next: 4, max: c.MAX_KEY_NUMBER, left: c.MAX_KEY_NUMBER - 3 },
      key_archives_pending: null,
    });
    expect(JSON.stringify(status)).not.toContain('wrapped');
    expect(JSON.stringify([...fake.hashes].map(([k, h]) => [k, [...h]]))).toBe(before);
  });

  test('destroy_keys_of destroys the keys of a container gone from the registry, and never one it lists', async () => {
    const res = await post(JSON.stringify({ destroy_keys_of: [GONE, B] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [
        { container: GONE, destroyed: [keyGone] },
        { container: B, refused: 'the registry still lists it, so its keys were not destroyed' },
      ],
      key_backups: { none: true },
    });
    expect(fake.hashes.get(c.keysHashKey())!.has(keyGone)).toBe(false);
    expect(fake.hashes.get(c.tombstonesKey())!.has(keyGone)).toBe(true);
    expect((await (await post()).json()).orphaned_keys.count).toBe(0);
    expect(fake.strings.has(testKey('backups:keys-pending'))).toBe(false);
  });

  test('anything else is refused', async () => {
    for (const body of ['{"destroy_keys_of":[]}', '{"destroy_keys_of":["nope"]}', `{"destroy_keys_of":"${GONE}"}`, '{"status":true}', '[]', 'nope', `{"destroy_keys_of":["${GONE}"],"x":1}`]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await post(JSON.stringify({ destroy_keys_of: Array(51).fill(GONE) }))).status).toBe(400);
    expect((await post('x'.repeat(5000))).status).toBe(413);
  });
});
