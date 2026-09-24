import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock } from './fake-redis';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis();
mock.module('@/lib/storage', () => storageMock(fake));

const { encryptV2, decrypt, keysHashKey, importMasterKey, unwrapDataKey, MasterKeyError } = await import(
  '@/lib/crypto'
);
const { main, parseArgs } = await import('@/scripts/keys');
const { RestoreRefused } = await import('@/lib/restore');

// Distinct from every other test file's masters, so no data key cached under
// one of theirs can answer here.
const OLD = Buffer.alloc(32, 11).toString('base64');
const NEW = Buffer.alloc(32, 12).toString('base64');

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

const run = (argv: string[], env: Record<string, string | undefined>) => main([...argv, '--target', 'test'], fake as any, env);

async function stored(id: string) {
  return JSON.parse((await fake.hget<string>(keysHashKey(), id))!);
}

describe('parseArgs', () => {
  test('knows its commands and flags', () => {
    expect(parseArgs(['create', '--target', 'x', '--confirm-production'])).toEqual({
      command: 'create',
      target: 'x',
      confirmProduction: true,
      confirmRedeployed: false,
    });
    expect(() => parseArgs(['rotate'])).toThrow(/Usage/);
    expect(() => parseArgs(['create', '--force'])).toThrow(/Unexpected/);
  });
});

describe('create', () => {
  test('makes k1, then k2, each wrapped for MASTER_KEY and usable', async () => {
    await run(['create'], { MASTER_KEY: OLD });
    await run(['create'], { MASTER_KEY: OLD });

    const fp = (await importMasterKey(OLD)).fingerprint;
    expect(Object.keys((await stored('k1')).wrapped)).toEqual([fp]);
    expect(Object.keys((await stored('k2')).wrapped)).toEqual([fp]);
    expect(await decrypt(await encryptV2('hello', 'k2'))).toBe('hello');
  });

  test('never reuses an id, even after gaps', async () => {
    await run(['create'], { MASTER_KEY: OLD });
    await run(['create'], { MASTER_KEY: OLD });
    await fake.hdel(keysHashKey(), 'k1');
    await run(['create'], { MASTER_KEY: OLD });
    expect(await fake.hget(keysHashKey(), 'k3')).not.toBeNull();
  });

  test('refuses without MASTER_KEY, writing nothing', async () => {
    await expect(run(['create'], {})).rejects.toThrow(/MASTER_KEY is not set/);
    expect(await fake.hgetall(keysHashKey())).toBeNull();
  });

  test('two creates racing cannot both claim an id', async () => {
    const racing = Object.assign(Object.create(fake), { hsetnx: async () => 0 });
    await expect(main(['create', '--target', 'test'], racing, { MASTER_KEY: OLD })).rejects.toThrow(
      /created by someone else/
    );
  });

  test('a key that does not read back intact is reported, not trusted', async () => {
    const damaging = Object.assign(Object.create(fake), {
      hsetnx: async (key: string, field: string, value: string) => {
        const v = JSON.parse(value);
        for (const fp of Object.keys(v.wrapped)) v.wrapped[fp] = v.wrapped[fp].replace(/^./, (c: string) => (c === 'A' ? 'B' : 'A'));
        return fake.hsetnx(key, field, JSON.stringify(v));
      },
    });
    await expect(main(['create', '--target', 'test'], damaging, { MASTER_KEY: OLD })).rejects.toBeInstanceOf(
      MasterKeyError
    );
  });

  test('a wrong target is refused before anything is read or written', async () => {
    const before = fake.ops;
    await expect(main(['create', '--target', 'production'], fake as any, { MASTER_KEY: OLD })).rejects.toThrow(
      RestoreRefused
    );
    expect(fake.ops).toBe(before);
  });
});

describe('rotating the master key', () => {
  test('add-master, redeploy, drop-old-masters: data stays readable throughout', async () => {
    await run(['create'], { MASTER_KEY: OLD });
    const value = await encryptV2('balance 100', 'k1');

    await run(['add-master'], { MASTER_KEY: OLD, NEW_MASTER_KEY: NEW });
    // A deployment still on the old master keeps working...
    expect(await decrypt(value)).toBe('balance 100');
    // ...and one redeployed with the new master works too.
    process.env.MASTER_KEY = NEW;
    expect(await decrypt(value)).toBe('balance 100');

    await run(['drop-old-masters', '--confirm-redeployed'], { MASTER_KEY: NEW });
    const newFp = (await importMasterKey(NEW)).fingerprint;
    expect(Object.keys((await stored('k1')).wrapped)).toEqual([newFp]);
    expect(await decrypt(value)).toBe('balance 100');
  });

  test('after dropping, the old master opens nothing in the live store', async () => {
    await run(['create'], { MASTER_KEY: OLD });
    await run(['add-master'], { MASTER_KEY: OLD, NEW_MASTER_KEY: NEW });
    await run(['drop-old-masters', '--confirm-redeployed'], { MASTER_KEY: NEW });

    // Checked against the store itself rather than through decrypt(), which
    // keeps opened keys in memory for the life of the process. A running
    // deployment is replaced on redeploy, which is what clears that.
    const oldMaster = await importMasterKey(OLD);
    const err = await unwrapDataKey(oldMaster, 'k1', await stored('k1')).catch((e) => e);
    expect(err).toBeInstanceOf(MasterKeyError);
    expect(err.message).toContain('not wrapped for master key');
  });

  test('add-master refuses the same key twice', async () => {
    await run(['create'], { MASTER_KEY: OLD });
    await expect(run(['add-master'], { MASTER_KEY: OLD, NEW_MASTER_KEY: OLD })).rejects.toThrow(/same/);
  });

  test('add-master writes nothing if any key cannot be opened', async () => {
    await run(['create'], { MASTER_KEY: OLD });
    await run(['create'], { MASTER_KEY: NEW }); // k2, wrapped only for NEW
    const before = JSON.stringify(await fake.hgetall(keysHashKey()));
    const third = Buffer.alloc(32, 13).toString('base64');

    await expect(run(['add-master'], { MASTER_KEY: OLD, NEW_MASTER_KEY: third })).rejects.toBeInstanceOf(
      MasterKeyError
    );
    expect(JSON.stringify(await fake.hgetall(keysHashKey()))).toBe(before);
  });

  test('drop-old-masters needs the redeploy confirmed', async () => {
    await run(['create'], { MASTER_KEY: OLD });
    await expect(run(['drop-old-masters'], { MASTER_KEY: OLD })).rejects.toThrow(/--confirm-redeployed/);
  });

  test('drop-old-masters refuses, writing nothing, if a key would be locked out', async () => {
    await run(['create'], { MASTER_KEY: OLD });
    const before = JSON.stringify(await fake.hgetall(keysHashKey()));

    // NEW was never added, so dropping everything but NEW would lock k1 out.
    await expect(run(['drop-old-masters', '--confirm-redeployed'], { MASTER_KEY: NEW })).rejects.toBeInstanceOf(
      MasterKeyError
    );
    expect(JSON.stringify(await fake.hgetall(keysHashKey()))).toBe(before);
  });
});

describe('status', () => {
  test('lists keys and whether this MASTER_KEY opens them', async () => {
    await run(['create'], { MASTER_KEY: OLD });
    logs.length = 0;
    await run(['status'], { MASTER_KEY: NEW });

    expect(logs[0]).toContain('1 data key(s)');
    expect(logs.join('\n')).toContain('k1');
    expect(logs.join('\n')).toContain('NOT openable with this MASTER_KEY');
  });

  test('reads production without the confirmation flag, since it changes nothing', async () => {
    // k() is "test" here, so this only shows the flag is not demanded; the
    // production match itself is covered by the restore tests.
    await expect(run(['status'], {})).resolves.toBeUndefined();
  });
});

// k() is fixed to "test:" in this process, so the production rules run in a
// child with REDIS_PREFIX=production. Nothing reaches Redis: the refusal comes
// first, and the child has no credentials anyway.
describe('production', () => {
  const run = (args: string) =>
    Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `const { main } = await import('./scripts/keys.ts');
         const client = { hgetall: async () => { throw new Error('touched redis'); } };
         try { await main(${args}, client, { MASTER_KEY: ${JSON.stringify(OLD)} }); console.log('ran'); }
         catch (e) { console.log(e.message); }`,
      ],
      { env: { ...process.env, REDIS_PREFIX: 'production' }, cwd: `${import.meta.dir}/..` }
    );

  test('a write command needs --confirm-production', () => {
    expect(run(`['create', '--target', 'production']`).stdout.toString()).toContain('--confirm-production');
  });

  test('status does not', () => {
    // It gets as far as reading, which the stub client refuses.
    expect(run(`['status', '--target', 'production']`).stdout.toString()).toContain('touched redis');
  });
});
