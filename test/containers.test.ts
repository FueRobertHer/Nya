import { describe, expect, test, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import { join } from 'node:path';
import { FakeRedis, storageMock, testKey } from './fake-redis';

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const {
  asContainerId,
  isContainerId,
  createFirstContainer,
  listContainers,
  getContainer,
  resolveCtx,
  registryKey,
  ContainerError,
  CREATE_FIRST,
  splitScoped,
  isEnvWide,
} = await import('@/lib/containers');
const { isExcluded } = await import('@/lib/export');
const route = await import('@/app/api/ops/containers/route');

const saved = { ...process.env };
beforeEach(() => {
  fake.reset();
  delete process.env.CONTAINER_ID;
});
afterEach(() => {
  process.env = { ...saved };
});

describe('container ids', () => {
  test('a minted UUID is one; anything else is not', () => {
    const id = crypto.randomUUID();
    expect(isContainerId(id)).toBe(true);
    expect(asContainerId(id)).toBe(id as ReturnType<typeof asContainerId>);
    for (const bad of [
      '',
      'goals',
      id.toUpperCase(),
      '0b6f5a52-3c1d-1e2f-8a9b-1c2d3e4f5a6b', // v1, not v4
      `${id}:x`,
      ` ${id}`,
    ]) {
      expect(isContainerId(bad)).toBe(false);
      expect(() => asContainerId(bad)).toThrow(ContainerError);
    }
  });

  test('kc puts the container segment in every key, and k and kEnv do not', () => {
    // Run against the real lib/storage in its own process: this file mocks it.
    const id = crypto.randomUUID();
    const script = `import { k, kc, kEnv } from './lib/storage';
console.log(JSON.stringify([kc({ container: ${JSON.stringify(id)} }, 'goals'), k('goals'), kEnv('containers')]));`;
    const out = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, REDIS_PREFIX: 'unit' },
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout.toString())).toEqual([`unit:c:${id}:goals`, 'unit:goals', 'unit:containers']);
  });
});

describe('keys inside a container', () => {
  const id = asContainerId('0b6f5a52-3c1d-4e2f-8a9b-1c2d3e4f5a6b');

  test('split into the container and the key inside it', () => {
    expect(splitScoped(`c:${id}:goals`)).toEqual({ container: id, key: 'goals' });
    expect(splitScoped(`c:${id}:history:accounts`)).toEqual({ container: id, key: 'history:accounts' });
    expect(splitScoped('goals')).toEqual({ container: null, key: 'goals' });
    expect(splitScoped('c:not-an-id:goals')).toEqual({ container: null, key: 'c:not-an-id:goals' });
    expect(splitScoped(`c:${id}:`)).toEqual({ container: null, key: `c:${id}:` });
  });

  test('a container cache or lock is left out of exports like any other', () => {
    for (const key of ['cache:net-worth', 'ratelimit:login:x', 'invtxns-lock:item']) {
      expect(isExcluded(key)).toBe(true);
      expect(isExcluded(`c:${id}:${key}`)).toBe(true);
    }
    expect(isExcluded(`c:${id}:goals`)).toBe(false);
    expect(isExcluded('goals')).toBe(false);
  });

  test('the environment-wide stores are named', () => {
    for (const key of ['crypto:keys', 'containers', 'ratelimit:login:x']) expect(isEnvWide(key)).toBe(true);
    for (const key of ['goals', 'containers:x', 'cache:net-worth', 'crypto']) expect(isEnvWide(key)).toBe(false);
  });
});

describe('the registry', () => {
  test('the first container is created active and primary', async () => {
    const id = await createFirstContainer(Date.parse('2026-09-25T00:00:00.000Z'));
    expect(isContainerId(id)).toBe(true);
    expect(await listContainers()).toEqual([{ id, status: 'active', primary: true, created_at: '2026-09-25T00:00:00.000Z' }]);
    expect(await getContainer(id)).toMatchObject({ status: 'active', primary: true });
  });

  test('a second is refused, and the registry is unchanged', async () => {
    const id = await createFirstContainer();
    const before = JSON.stringify(await fake.hgetall(registryKey()));
    const err = await createFirstContainer().catch((e) => e);
    expect(err).toBeInstanceOf(ContainerError);
    expect(err.message).toContain(id);
    expect(JSON.stringify(await fake.hgetall(registryKey()))).toBe(before);
  });

  test('racing creators make exactly one', async () => {
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => createFirstContainer()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await listContainers()).toHaveLength(1);
  });

  test('an unreadable entry is an error, not skipped', async () => {
    await fake.hset(registryKey(), { [crypto.randomUUID()]: '{"status":"weird","primary":true,"created_at":"x"}' });
    expect(await listContainers().catch((e) => e)).toBeInstanceOf(ContainerError);

    fake.reset();
    await fake.hset(registryKey(), { 'not-an-id': '{"status":"active","primary":true,"created_at":"x"}' });
    expect(await listContainers().catch((e) => e)).toBeInstanceOf(ContainerError);
  });

  test('lives in the environment, outside any container', () => {
    expect(registryKey()).toBe(testKey('containers'));
  });
});

describe('resolving the container', () => {
  test('from CONTAINER_ID, when it names an active container', async () => {
    const id = await createFirstContainer();
    process.env.CONTAINER_ID = id;
    expect(await resolveCtx()).toEqual({ container: id });
  });

  test('never guesses: unset, malformed, unknown or inactive all refuse', async () => {
    const id = await createFirstContainer();
    const cases: [string | undefined, string][] = [
      [undefined, 'not set'],
      ['nope', 'not a container id'],
      [crypto.randomUUID(), 'not in the registry'],
    ];
    for (const [value, message] of cases) {
      if (value === undefined) delete process.env.CONTAINER_ID;
      else process.env.CONTAINER_ID = value;
      const err = await resolveCtx().catch((e) => e);
      expect(err).toBeInstanceOf(ContainerError);
      expect(err.message).toContain(message);
    }

    await fake.hset(registryKey(), { [id]: JSON.stringify({ status: 'restoring', primary: true, created_at: 'x' }) });
    process.env.CONTAINER_ID = id;
    expect((await resolveCtx().catch((e) => e)).message).toContain('restoring');
  });

  test('does not create a container when there is none', async () => {
    process.env.CONTAINER_ID = crypto.randomUUID();
    await resolveCtx().catch(() => {});
    expect(await listContainers()).toEqual([]);
  });
});

describe('the route', () => {
  const post = (body?: string, auth = 'Bearer s3cret') =>
    route.POST(new Request('http://x/api/ops/containers', { method: 'POST', headers: auth ? { authorization: auth } : {}, body }));

  beforeEach(() => {
    process.env.OPS_ENABLED = '1';
    process.env.OPS_SECRET = 's3cret';
  });

  test('does not exist unless OPS_ENABLED is set, and needs the secret', async () => {
    delete process.env.OPS_ENABLED;
    expect((await post()).status).toBe(404);
    process.env.OPS_ENABLED = '1';
    expect((await post(undefined, 'Bearer nope')).status).toBe(401);
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect((await route[method]()).status).toBe(404);
    }
  });

  test('lists, creates once, and reports whether CONTAINER_ID is usable', async () => {
    expect(await (await post()).json()).toEqual({ containers: [], container_id: null, container_id_status: 'unset' });

    const created = await (await post('{"create":true}')).json();
    expect(isContainerId(created.created)).toBe(true);
    expect(created.next_step).toContain(`CONTAINER_ID=${created.created}`);

    const again = await post('{"create":true}');
    expect(again.status).toBe(409);

    process.env.CONTAINER_ID = crypto.randomUUID();
    expect((await (await post()).json()).container_id_status).toContain('not in the registry');
    process.env.CONTAINER_ID = created.created;
    const listed = await (await post()).json();
    expect(listed).toMatchObject({ container_id: created.created, container_id_status: 'ok' });
    expect(listed.containers).toHaveLength(1);
  });

  test('anything else is refused', async () => {
    for (const body of ['{"create":"yes"}', '{"create":true,"x":1}', '{"make":true}', '[]', 'nope']) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await post('x'.repeat(300))).status).toBe(413);
  });
});

// The create script on a real Redis, where one is installed (not in CI).
const hasRedis = Bun.which('redis-server') !== null;
describe.skipIf(!hasRedis)('the create script, on a real Redis', () => {
  const port = 30000 + Math.floor(Math.random() * 20000);
  let server: ReturnType<typeof Bun.spawn> | null = null;
  let client: InstanceType<typeof Bun.RedisClient>;

  beforeEach(async () => {
    if (!server) {
      server = Bun.spawn(['redis-server', '--port', String(port), '--save', '', '--appendonly', 'no'], { stdout: 'ignore', stderr: 'ignore' });
      client = new Bun.RedisClient(`redis://127.0.0.1:${port}`);
      for (let i = 0; i < 50; i++) {
        try {
          await client.send('PING', []);
          break;
        } catch {
          await Bun.sleep(50);
        }
      }
    }
    await client.send('FLUSHALL', []);
  });
  afterAll(() => {
    server?.kill();
  });

  test('writes only into an empty registry', async () => {
    expect(await client.send('EVAL', [CREATE_FIRST, '1', 'reg', 'a', '{}'])).toBe(1);
    expect(await client.send('EVAL', [CREATE_FIRST, '1', 'reg', 'b', '{}'])).toBe(0);
    expect(await client.send('HKEYS', ['reg'])).toEqual(['a']);
  });
});
