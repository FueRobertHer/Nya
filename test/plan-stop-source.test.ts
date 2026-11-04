import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// The stop is read through stopOf (lib/fire/plan.ts) or a view's stopAge, so
// "stop when I reach FI" reaches every figure and word. A read of targetAge
// itself is allowed only where it is the stored field: the readers and the
// Household sheet that types it, and version 1's scenarios, which keep a stop age
// of their own; and where it names the setting, never its value (how a copy
// differs, components/plan-diff.ts). A file not listed here, or a count that
// rises, fails.
//
// Reads are `.targetAge` (and `?.targetAge`), `['targetAge']`, and targetAge
// in destructuring braces. Writes aren't reads (a `targetAge:` key, as the
// path after the stop and the search set it), nor the field's name as a
// string (PlanTab's repair labels). The loops over a
// plan's keys (lib/fire/scenarios.ts settingOf and recordSave) read every
// field alike, the stop among them, as version 1's scenarios do.

const ALLOWED: Record<string, { reads: number; why: string }> = {
  'lib/fire/plan.ts': { reads: 4, why: 'version 1’s reader and stopOf' },
  'lib/fire/plan-v2.ts': { reads: 4, why: 'version 2’s reader, which keeps a stop under stop at FI' },
  'lib/fire/scenarios.ts': { reads: 4, why: 'version 1’s scenarios and their own stop age' },
  'components/plan-scenario-text.ts': { reads: 2, why: 'a version 1 scenario’s stop age, in its words' },
  'components/PlanForms.tsx': { reads: 3, why: 'the Household sheet, where the stop age is typed, and the one kept under stop when I reach FI comes back while it is still ahead' },
  'components/plan-diff.ts': { reads: 1, why: 'the stop setting’s name; its value is said through stopOf' },
};

const READS = [/\.targetAge\b/g, /\[\s*'targetAge'\s*\]/g, /(?:const|let|var)\s*\{[^}]*\btargetAge\b[^}]*\}\s*=/g, /\(\s*\{[^}]*\btargetAge\b(?!\s*:)[^}]*\}[^)]*\)\s*(?:=>|\{|:)/g];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
}

test('the stop is read through stopOf or stopAge, but where it is the stored field', () => {
  const root = join(import.meta.dir, '..');
  const found: Record<string, number> = {};
  for (const file of [...files(join(root, 'lib')), ...files(join(root, 'components'))]) {
    const name = relative(root, file).replaceAll('\\', '/');
    // The demo's plans are data, not reads.
    if (name.startsWith('lib/demo-seed/')) continue;
    const code = readFileSync(file, 'utf8');
    const n = READS.reduce((s, re) => s + (code.match(re)?.length ?? 0), 0);
    if (n > 0) found[name] = n;
  }
  expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, v.reads])));
});
