import { expect, test } from 'bun:test';
import { join } from 'node:path';

// The plan's modules import one way (plan ← events ← items ← compile and
// plan-v2 ← saved-plan ← path ← steady ← plan-figures), so none meets a
// constant (LIMITS, EVENT_LIMITS, ITEM_LIMITS, DEFAULT_PLAN_V2) before it is
// set. Each is loaded first and alone, in a process of its own.

const MODULES = ['plan', 'events', 'items', 'compile', 'plan-v2', 'saved-plan', 'path', 'steady', 'plan-figures'];

test.each(MODULES)('lib/fire/%s.ts loads first, alone', (name) => {
  const file = join(import.meta.dir, '..', 'lib', 'fire', `${name}.ts`).replaceAll('\\', '/');
  const r = Bun.spawnSync([process.execPath, '-e', `const m = await import(${JSON.stringify(file)}); if (Object.keys(m).length === 0) process.exit(2);`]);
  expect({ code: r.exitCode, err: r.stderr.toString() }).toEqual({ code: 0, err: '' });
});
