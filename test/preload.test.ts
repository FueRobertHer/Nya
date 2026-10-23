import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// test/preload.ts, in a run of its own: whatever the shell (or a .env file)
// gives the blob ceiling and the Lunch Flow switch, and whatever a file sets
// at load time or in a test, no test and no later file's load or beforeAll
// sees it. Two probe files run in a child `bun test` from the repo root, so it
// reads bunfig.toml as any run does.

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
});
