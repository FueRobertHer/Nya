import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// The growth a plan runs at is FiView's `growth` (lib/fire/account-growth.ts
// planGrowth): the plan's `realReturn`, or with accounts' own rates their
// blend. Every figure and every word about the projection reads `growth`, so
// an account's own rate reaches all of them. A read of the plan's field itself
// is allowed only where it is the setting: the readers, the blend, the
// Assumptions sheet that types it, and a saved plan (which keeps the plan as it
// was, and the growth it ran at only where they differ). A file not listed here,
// or a count that rises, fails.
//
// Reads are `.realReturn` (but LIMITS.realReturn, the range) and
// `['realReturn']`. A `realReturn` the engine takes as its own input (the
// drawdown's, the mix's) is set from `growth` by its callers, and isn't
// counted: it is never read off a plan.

const ALLOWED: Record<string, { reads: number; why: string }> = {
  'lib/fire/plan.ts': { reads: 2, why: 'version 1’s reader, and formulasTake' },
  'lib/fire/account-growth.ts': { reads: 3, why: 'the blend, from the plan’s rate' },
  'lib/fire/saved-plan.ts': { reads: 4, why: 'a save keeps growth only where it differs, savedGrowth, and changedSince, which compares the setting' },
  'components/PlanForms.tsx': { reads: 1, why: 'the Assumptions sheet, where the plan’s rate is typed' },
};

const READS = [/(?<!LIMITS)\??\.realReturn\b/g, /\[\s*'realReturn'\s*\]/g];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
}

test('the plan’s growth is read as FiView’s growth, but where it is the setting', () => {
  const root = join(import.meta.dir, '..');
  const found: Record<string, number> = {};
  for (const file of [...files(join(root, 'lib')), ...files(join(root, 'components')), ...files(join(root, 'app'))]) {
    const name = relative(root, file).replaceAll('\\', '/');
    // The demo's plans are data, not reads.
    if (name.startsWith('lib/demo-seed/')) continue;
    const code = readFileSync(file, 'utf8');
    const n = READS.reduce((s, re) => s + (code.match(re)?.length ?? 0), 0);
    if (n > 0) found[name] = n;
  }
  expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, v.reads])));
});
