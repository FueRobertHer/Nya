import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

// Deserializing, like Upstash's default client, which is what the command uses.
const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));

const { encryptV2, decrypt, keysHashKey, mastersSeenKey, importMasterKey, unwrapDataKey } = await import(
  '@/lib/crypto'
);
const { main, parseArgs, DROP_ATTEST_WINDOW_MS, CREATE_ATTEST_WINDOW_MS } = await import('@/scripts/keys');
const { RestoreRefused } = await import('@/lib/restore');

// Distinct from every other test file's masters, so no data key cached under
// one of theirs can answer here.
const OLD = Buffer.alloc(32, 11).toString('base64');
const NEW = Buffer.alloc(32, 12).toString('base64');
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

const fp = async (b64: string) => (await importMasterKey(b64)).fingerprint;

/** Master keys as if typed at the prompt, in order. */
const typed = (...values: string[]) => {
  let i = 0;
  return {
    read: async () => {
      if (i >= values.length) throw new Error('prompted more times than expected');
      return values[i++];
    },
  };
};

/** Record that a deployment reported running this master `minutesAgo`. */
async function seen(b64: string, minutesAgo: number) {
  await fake.hset(mastersSeenKey(), { [await fp(b64)]: new Date(NOW - minutesAgo * 60000).toISOString() });
}

const run = (argv: string[], ...masters: string[]) => main([...argv, '--target', 'test'], fake as any, typed(...masters), NOW);

async function ids(): Promise<string[]> {
  return Object.keys((await fake.hgetall(keysHashKey())) ?? {}).sort();
}
async function stored(id: string) {
  return (await fake.hget<any>(keysHashKey(), id))!;
}

const logs: string[] = [];
const origLog = console.log;
const savedMaster = process.env.MASTER_KEY;
beforeEach(() => {
  fake.reset();
  logs.length = 0;
  console.log = (...a: unknown[]) => logs.push(a.join(' '));
  process.env.MASTER_KEY = OLD;
});
afterEach(() => {
  console.log = origLog;
  if (savedMaster === undefined) delete process.env.MASTER_KEY;
  else process.env.MASTER_KEY = savedMaster;
});

describe('parseArgs', () => {
  test('knows its commands and flags', () => {
    expect(parseArgs(['create', '--target', 'x', '--confirm-production', '--skip-attestation-check'])).toEqual({
      command: 'create',
      target: 'x',
      confirmProduction: true,
      confirmRedeployed: false,
      skipAttestationCheck: true,
      withMaster: false,
    });
    expect(() => parseArgs(['rotate'])).toThrow(/Usage/);
    expect(() => parseArgs(['create', '--force'])).toThrow(/Unexpected/);
  });
});

describe('create', () => {
  test('makes k1 then k2, each committed to its key, wrapped, and usable', async () => {
    await seen(OLD, 5);
    await run(['create'], OLD);
    await run(['create'], OLD);

    const [a, b] = await ids();
    expect(a).toMatch(/^k1-[0-9a-f]{8}$/);
    expect(b).toMatch(/^k2-[0-9a-f]{8}$/);
    expect(Object.keys((await stored(a)).wrapped)).toEqual([await fp(OLD)]);
    expect(await decrypt(await encryptV2('hello', b))).toBe('hello');
  });

  test('a number handed out again still gets a different id', async () => {
    // The finding this guards: delete k2, create again, and the new key must
    // not share an id with the old one that a running process may still hold.
    await seen(OLD, 5);
    await run(['create'], OLD);
    await run(['create'], OLD);
    const [, oldK2] = await ids();
    await fake.hdel(keysHashKey(), oldK2);
    await run(['create'], OLD);
    const [, newK2] = await ids();

    expect(newK2.startsWith('k2-')).toBe(true);
    expect(newK2).not.toBe(oldK2);
  });

  test('refuses a master no deployment has reported, writing nothing', async () => {
    await expect(run(['create'], OLD)).rejects.toThrow(/No deployment .* has reported running master/);
    await seen(OLD, 25 * 60); // over a day ago
    await expect(run(['create'], OLD)).rejects.toThrow(/No deployment/);
    expect(await ids()).toEqual([]);
  });

  test('the attestation check can be skipped deliberately', async () => {
    await run(['create', '--skip-attestation-check'], OLD);
    expect(await ids()).toHaveLength(1);
  });

  test('refuses a master that does not open the existing keys, writing nothing', async () => {
    await seen(OLD, 5);
    await seen(NEW, 5);
    await run(['create'], OLD);
    const before = await ids();

    await expect(run(['create'], NEW)).rejects.toThrow(/does not open/);
    expect(await ids()).toEqual(before);
  });

  test('a key that does not read back intact is reported, not trusted', async () => {
    await seen(OLD, 5);
    const damaging = Object.assign(Object.create(fake), {
      hsetnx: async (key: string, field: string, value: string) => {
        const v = JSON.parse(value);
        for (const f of Object.keys(v.wrapped)) v.wrapped[f] = v.wrapped[f].replace(/^./, (c: string) => (c === 'A' ? 'B' : 'A'));
        return fake.hsetnx(key, field, JSON.stringify(v));
      },
    });
    await expect(main(['create', '--target', 'test'], damaging, typed(OLD), NOW)).rejects.toThrow(
      /could not be unwrapped/
    );
  });

  test('two creates racing cannot both claim an id', async () => {
    await seen(OLD, 5);
    const racing = Object.assign(Object.create(fake), { hsetnx: async () => 0 });
    await expect(main(['create', '--target', 'test'], racing, typed(OLD), NOW)).rejects.toThrow(/already exists/);
  });

  test('a wrong target is refused before anything is read or written', async () => {
    const before = fake.ops;
    await expect(main(['create', '--target', 'production'], fake as any, typed(OLD), NOW)).rejects.toThrow(
      RestoreRefused
    );
    expect(fake.ops).toBe(before);
  });

  test('an empty master key is refused', async () => {
    await expect(run(['create'], '   ')).rejects.toThrow(/No master key was given/);
  });

  test('the key store only accepts key ids', async () => {
    await fake.hset(keysHashKey(), { active: 'k1' });
    await expect(run(['status'])).rejects.toThrow(/Unexpected entry "active"/);
  });
});

describe('rotating the master key', () => {
  async function setUp() {
    await seen(OLD, 5);
    await run(['create'], OLD);
    const [id] = await ids();
    return { id, value: await encryptV2('balance 100', id) };
  }

  test('add-master leaves every key openable by BOTH masters', async () => {
    const { id } = await setUp();
    await run(['add-master'], OLD, NEW);

    // Checked against the store, not through decrypt(), which keeps opened
    // keys in memory and would pass even if the old wrapping were gone.
    const s = await stored(id);
    await unwrapDataKey(await importMasterKey(OLD), id, s);
    await unwrapDataKey(await importMasterKey(NEW), id, s);
  });

  test('the whole rotation keeps data readable', async () => {
    const { id, value } = await setUp();
    await run(['add-master'], OLD, NEW);
    process.env.MASTER_KEY = NEW;
    expect(await decrypt(value)).toBe('balance 100');

    await fake.hdel(mastersSeenKey(), await fp(OLD));
    await seen(NEW, 1);
    await run(['drop-old-masters', '--confirm-redeployed'], NEW);

    expect(Object.keys((await stored(id)).wrapped)).toEqual([await fp(NEW)]);
    const err = await unwrapDataKey(await importMasterKey(OLD), id, await stored(id)).catch((e) => e);
    expect(err.message).toContain('not wrapped for master key');
    expect(await decrypt(value)).toBe('balance 100');
  });

  test('add-master refuses the same key twice', async () => {
    await setUp();
    await expect(run(['add-master'], OLD, OLD)).rejects.toThrow(/same/);
  });

  test('add-master writes nothing if the current master is wrong', async () => {
    await setUp();
    const before = JSON.stringify(await fake.hgetall(keysHashKey()));
    const third = Buffer.alloc(32, 13).toString('base64');

    await expect(run(['add-master'], NEW, third)).rejects.toThrow(/does not open/);
    expect(JSON.stringify(await fake.hgetall(keysHashKey()))).toBe(before);
  });

  test('add-master reads back and would catch a wrapping that did not land', async () => {
    await setUp();
    const lossy = Object.assign(Object.create(fake), { hset: async () => undefined });
    await expect(main(['add-master', '--target', 'test'], lossy, typed(OLD, NEW), NOW)).rejects.toThrow(
      /does not open/
    );
  });

  test('drop-old-masters needs the redeploy confirmed', async () => {
    await setUp();
    await expect(run(['drop-old-masters'], OLD)).rejects.toThrow(/--confirm-redeployed/);
  });

  test('drop-old-masters refuses while a deployment still reports the old master', async () => {
    await setUp();
    await run(['add-master'], OLD, NEW);
    await seen(NEW, 1);
    await seen(OLD, 10); // an old deployment, still live ten minutes ago
    const before = JSON.stringify(await fake.hgetall(keysHashKey()));

    await expect(run(['drop-old-masters', '--confirm-redeployed'], NEW)).rejects.toThrow(/lock that deployment out/);
    expect(JSON.stringify(await fake.hgetall(keysHashKey()))).toBe(before);
  });

  test('drop-old-masters refuses until the new master has been reported', async () => {
    await setUp();
    await run(['add-master'], OLD, NEW);
    await seen(OLD, 60 * 3);
    await expect(run(['drop-old-masters', '--confirm-redeployed'], NEW)).rejects.toThrow(
      /No deployment has reported running master/
    );
  });

  test('drop-old-masters refuses a master that would lock keys out', async () => {
    await setUp();
    await seen(NEW, 1);
    await seen(OLD, 60 * 3);
    await expect(run(['drop-old-masters', '--confirm-redeployed'], NEW)).rejects.toThrow(/does not open/);
  });

  test('the attestation windows are what the checks use', () => {
    expect(DROP_ATTEST_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(CREATE_ATTEST_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('status', () => {
  test('lists keys and what deployments report, without asking for a master', async () => {
    await seen(OLD, 5);
    await run(['create'], OLD);
    logs.length = 0;
    await run(['status']);

    const out = logs.join('\n');
    expect(out).toContain('1 data key(s)');
    expect(out).toMatch(/k1-[0-9a-f]{8}/);
    expect(out).toContain(`deployment reported master ${await fp(OLD)} 5 min ago`);
    expect(out).not.toContain('openable');
  });

  test('--with-master says whether the master given opens each key', async () => {
    await seen(OLD, 5);
    await run(['create'], OLD);
    logs.length = 0;
    await run(['status', '--with-master'], NEW);
    expect(logs.join('\n')).toContain('NOT openable with the master given');

    logs.length = 0;
    await run(['status', '--with-master'], OLD);
    expect(logs.join('\n')).toContain('(opens with the master given)');
  });
});

// k() is fixed to "test:" in this process, so the production rules run in a
// child with REDIS_PREFIX=production. Nothing reaches Redis: the refusal comes
// first, and the stub client refuses to be used.
describe('production', () => {
  const run = (args: string) =>
    Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `const { main } = await import('./scripts/keys.ts');
         const client = { hgetall: async () => { throw new Error('touched redis'); } };
         const secrets = { read: async () => ${JSON.stringify(OLD)} };
         try { await main(${args}, client, secrets); console.log('ran'); }
         catch (e) { console.log(e.message); }`,
      ],
      { env: { ...process.env, REDIS_PREFIX: 'production' }, cwd: `${import.meta.dir}/..` }
    );

  test('a write command needs --confirm-production, and says what for', () => {
    const out = run(`['create', '--target', 'production']`).stdout.toString();
    expect(out).toContain('Changing the keys of production also needs --confirm-production');
  });

  test('status does not', () => {
    expect(run(`['status', '--target', 'production']`).stdout.toString()).toContain('touched redis');
  });
});

describe('master keys never come from the environment', () => {
  test('a MASTER_KEY in the environment is not used by the command', () => {
    // The CLI reads masters from stdin; with the env set and stdin empty it
    // must refuse rather than fall back to the env value.
    const res = Bun.spawnSync([process.execPath, 'scripts/keys.ts', 'create', '--target', 'test'], {
      env: { ...process.env, REDIS_PREFIX: 'test', MASTER_KEY: OLD, UPSTASH_REDIS_REST_URL: 'https://127.0.0.1:1', UPSTASH_REDIS_REST_TOKEN: 'x' },
      cwd: `${import.meta.dir}/..`,
      stdin: new TextEncoder().encode(''),
    });
    // Masters are read before Redis is touched, so this is the first thing
    // the command can fail on; the bogus Upstash URL is never contacted.
    expect(res.stderr.toString()).toContain('Expected the master key on stdin');
  });
});
