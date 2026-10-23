import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// test/preload.ts, in a run of its own: whatever the shell (or a .env file)
// gives the blob ceiling and the Lunch Flow switch, and whatever a file sets
// at load time or in a test, no test and no later file's load or beforeAll
// sees it; the same for a shared helper's state set back with resetEachTest
// (test/shared-reset.ts), in two orders. Probe files run in a child `bun
// test` from the repo root, so it reads bunfig.toml as any run does.

const ROOT = join(import.meta.dir, '..');
const NAMES = ['MAX_TXN_BLOB_CHARS', 'LUNCHFLOW_ENABLED'];

const seen = (where: string) => `console.log('SEEN ${where} ' + JSON.stringify(${JSON.stringify(NAMES)}.map((n) => process.env[n] ?? null)));`;
const setBoth = `process.env.MAX_TXN_BLOB_CHARS = '50'; process.env.LUNCHFLOW_ENABLED = '1';`;

describe('the test preload', () => {
  test('clears the ceiling and the switch before each test and after it, whatever the run started with', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nya-preload-'));
    try {
      writeFileSync(
        join(dir, 'a.test.ts'),
        `import { test } from 'bun:test';\n${seen('a-load')}\n${setBoth}\ntest('a1', () => { ${seen('a1')} ${setBoth} });\ntest('a2', () => { ${seen('a2')} ${setBoth} });\n`
      );
      writeFileSync(join(dir, 'b.test.ts'), `import { beforeAll, test } from 'bun:test';\n${seen('b-load')}\nbeforeAll(() => { ${seen('b-all')} });\ntest('b1', () => { ${seen('b1')} });\n`);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(?:PATH|HOME|TMPDIR|TZ|LANG|LC_\w+|BUN_\w+)$/.test(k)));
      const run = Bun.spawnSync([process.execPath, 'test', join(dir, 'a.test.ts'), join(dir, 'b.test.ts')], {
        cwd: ROOT,
        env: { ...env, MAX_TXN_BLOB_CHARS: '5000', LUNCHFLOW_ENABLED: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const said = `${run.stdout.toString()}${run.stderr.toString()}`;
      expect(said).toContain(' 3 pass');
      const lines = [...said.matchAll(/^SEEN (\S+) (.+)$/gm)].map((m) => [m[1], JSON.parse(m[2])]);
      // Bun runs the files in its own order; each one's lines stay together.
      const unset = [null, null];
      expect(Object.fromEntries(lines)).toEqual({ 'a-load': unset, a1: unset, a2: unset, 'b-load': unset, 'b-all': unset, b1: unset });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('sets a shared helper’s state back before each test of every file, and before the next file loads, in either order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nya-shared-reset-'));
    try {
      // A helper loaded once for the whole run, as test/restore-run.ts is,
      // with its state set back through test/shared-reset.ts.
      writeFileSync(
        join(dir, 'shared.ts'),
        `import { resetEachTest } from ${JSON.stringify(join(ROOT, 'test', 'shared-reset.ts'))};\nexport const state = { value: 'clean' };\nresetEachTest(() => { state.value = 'clean'; });\n`
      );
      const seenState = (where: string) => `console.log('STATE ${where} ' + state.value);`;
      const dirty = `state.value = 'dirty';`;
      writeFileSync(
        join(dir, 'a.test.ts'),
        `import { test } from 'bun:test';\nimport { state } from './shared';\n${seenState('a-load')}\n${dirty}\ntest('a1', () => { ${seenState('a1')} ${dirty} });\ntest('a2', () => { ${seenState('a2')} ${dirty} });\n`
      );
      writeFileSync(
        join(dir, 'b.test.ts'),
        `import { beforeAll, test } from 'bun:test';\nimport { state } from './shared';\n${seenState('b-load')}\nbeforeAll(() => { ${seenState('b-all')} });\ntest('b1', () => { ${seenState('b1')} ${dirty} });\ntest('b2', () => { ${seenState('b2')} ${dirty} });\n`
      );
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(?:PATH|HOME|TMPDIR|TZ|LANG|LC_\w+|BUN_\w+)$/.test(k)));
      const orders = new Set<string>();
      // Two orders of the files and of each file's tests.
      for (const seed of ['1', '4']) {
        const run = Bun.spawnSync([process.execPath, 'test', '--randomize', '--seed', seed, join(dir, 'a.test.ts'), join(dir, 'b.test.ts')], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
        const said = `${run.stdout.toString()}${run.stderr.toString()}`;
        expect([seed, said.includes(' 4 pass')]).toEqual([seed, true]);
        const lines = [...said.matchAll(/^STATE (\S+) (\S+)$/gm)].map((m) => [m[1], m[2]] as const);
        expect([seed, Object.fromEntries(lines)]).toEqual([seed, { 'a-load': 'clean', a1: 'clean', a2: 'clean', 'b-load': 'clean', 'b-all': 'clean', b1: 'clean', b2: 'clean' }]);
        orders.add(lines.map(([w]) => w).join(' '));
      }
      // The two runs went in different orders, one of them with the file that dirties it first.
      expect(orders.size).toBe(2);
      expect([...orders].some((o) => o.startsWith('a-load'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('a container’s key one file cached is never used for the next file’s data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nya-key-cache-'));
    try {
      // Every file keeps its data in TEST_CONTAINER. The first gives it a key
      // of its own under a MASTER_KEY it sets, uses it (lib/crypto keeps the
      // entry for a minute), and takes the MASTER_KEY away again, as
      // test/account-deletion.test.ts does; the second stores its data with
      // the environment's key.
      // By path: the repo's aliases don't reach a file outside it.
      const at = (...p: string[]) => JSON.stringify(join(ROOT, ...p));
      const head = `import { afterEach, expect, mock, test } from 'bun:test';\nimport { FakeRedis, storageMock, registerTestContainer, TEST_CTX } from ${at('test', 'fake-redis.ts')};\nprocess.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');\nconst fake = new FakeRedis({ deserialize: true });\nmock.module(${at('lib', 'storage.ts')}, () => storageMock(fake));\n`;
      writeFileSync(
        join(dir, 'a.test.ts'),
        `${head}afterEach(() => { delete process.env.MASTER_KEY; });\ntest('a1', async () => {\n  await registerTestContainer(fake);\n  process.env.MASTER_KEY = Buffer.alloc(32, 93).toString('base64');\n  const crypto = await import(${at('lib', 'crypto.ts')});\n  const p = (await crypto.prepareContainerKey(TEST_CTX.container, { born: false }))!;\n  expect((await crypto.claimContainerKey(p)).outcome).toBe('made');\n  expect(await crypto.decrypt(TEST_CTX, await crypto.encrypt(TEST_CTX, 'x'))).toBe('x');\n});\n`
      );
      writeFileSync(
        join(dir, 'b.test.ts'),
        `${head}test('b1', async () => {\n  await registerTestContainer(fake);\n  const crypto = await import(${at('lib', 'crypto.ts')});\n  expect(await crypto.decrypt(TEST_CTX, await crypto.encrypt(TEST_CTX, 'y'))).toBe('y');\n});\n`
      );
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(?:PATH|HOME|TMPDIR|TZ|LANG|LC_\w+|BUN_\w+)$/.test(k)));
      // Files in the order given (a, then b), as bun runs them by name.
      const run = Bun.spawnSync([process.execPath, 'test', join(dir, 'a.test.ts'), join(dir, 'b.test.ts')], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' });
      const said = `${run.stdout.toString()}${run.stderr.toString()}`;
      expect(said).not.toContain('MASTER_KEY is not set');
      expect(said).toContain(' 2 pass');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
