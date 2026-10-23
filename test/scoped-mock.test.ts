import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// test/scoped-mock.ts, in runs of their own: a module one file mocks with
// mockForFile is the real one again for every file after it, in whichever
// order Bun runs them. The case the scenarios review found: a mock of
// lib/clerk-emails left from test/clerk-proxy.test.ts made a later file's
// check of an account Clerk can't be asked about answer otherwise.

const ROOT = join(import.meta.dir, '..');

describe('a module mock for one file', () => {
  test('is the real module again for the files after it, in any order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nya-scoped-mock-'));
    try {
      const mod = JSON.stringify(join(ROOT, 'lib', 'clerk-emails.ts'));
      const helper = JSON.stringify(join(ROOT, 'test', 'scoped-mock.ts'));
      writeFileSync(
        join(dir, 'mocks.test.ts'),
        [
          "import { expect, test } from 'bun:test';",
          `const { mockForFile } = await import(${helper});`,
          `await mockForFile(${mod}, () => ({ emailAddresses: async () => [{ address: 'mocked@example.com', verified: true }] }));`,
          `const { emailAddresses } = await import(${mod});`,
          "test('mocked here', async () => { console.log('RAN mocks'); expect(await emailAddresses('user_x')).toEqual([{ address: 'mocked@example.com', verified: true }]); });",
        ].join('\n')
      );
      writeFileSync(
        join(dir, 'real.test.ts'),
        [
          "import { expect, test } from 'bun:test';",
          `const { emailAddresses } = await import(${mod});`,
          // The real one asks Clerk, which isn't set up here: it fails.
          "test('real here', async () => { console.log('RAN real'); expect(await emailAddresses('user_x').then(() => 'answered', () => 'real')).toBe('real'); });",
        ].join('\n')
      );
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(?:PATH|HOME|TMPDIR|TZ|LANG|LC_\w+|BUN_\w+)$/.test(k)));
      const orders = new Set<string>();
      for (const seed of [1, 2, 3, 4, 5, 6]) {
        const run = Bun.spawnSync([process.execPath, 'test', '--randomize', '--seed', String(seed), join(dir, 'mocks.test.ts'), join(dir, 'real.test.ts')], {
          cwd: ROOT,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const said = `${run.stdout.toString()}${run.stderr.toString()}`;
        expect([seed, said.includes(' 2 pass') && said.includes(' 0 fail')]).toEqual([seed, true]);
        orders.add([...said.matchAll(/^RAN (\w+)$/gm)].map((m) => m[1]).join(' then '));
      }
      // The mock's file ran first in some of these runs: the case that matters.
      expect(orders.has('mocks then real')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
