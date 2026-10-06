import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// The storage boundary (Postgres migration plan, Phase 1): only the Redis
// implementations reach Redis. Everything else goes through a store, and a new
// store is declared through the storage seam (lib/repo.ts), so it can later run
// on another backend without its callers changing. Read from the source of
// lib/, app/, components/, scripts/ and proxy.ts.

const ROOT = join(import.meta.dir, '..');

/** Reaching Redis directly: its client, or a primitive that reads and writes
 *  whatever key it is handed. By module (relative to the root, no extension). */
const ACCESS: Record<string, string[]> = {
  'lib/storage': ['redis', 'rawRedis'],
  'lib/stored-json': ['readEncryptedJson', 'writeEncryptedJson'],
};
/** The client package itself, under any import. */
const CLIENT = '@upstash/redis';

/** Where Redis is reached by design: the client's own module, and the seam. */
const IMPLEMENTATION = ['lib/storage.ts', 'lib/repo.ts', 'lib/stored-json.ts'];

/**
 * Files that reached Redis directly before the seam existed. This list only
 * ever shrinks: when a store moves behind the seam, its file comes off it, and
 * this test fails until it does. Never add a file to it; build on lib/repo.ts.
 */
const LEGACY = [
  'app/api/backup/route.ts',
  'app/api/demo/sign-in/route.ts',
  'app/api/login/route.ts',
  'app/api/ops/export/route.ts',
  'lib/account-deletion.ts',
  'lib/admin-items.ts',
  'lib/backup.ts',
  'lib/blob-sizes.ts',
  'lib/budgets.ts',
  'lib/cache.ts',
  'lib/containers.ts',
  'lib/crypto.ts',
  'lib/goals.ts',
  'lib/hidden.ts',
  'lib/history.ts',
  'lib/invstore.ts',
  'lib/item-usage.ts',
  'lib/last-known.ts',
  'lib/link-core.ts',
  'lib/links.ts',
  'lib/manual.ts',
  'lib/new-accounts.ts',
  'lib/overrides.ts',
  'lib/owners.ts',
  'lib/reencrypt.ts',
  'lib/renames.ts',
  'lib/sessions.ts',
  'lib/sharing.ts',
  'lib/snapshot-job.ts',
  'lib/transactions.ts',
  'lib/vanished.ts',
  'scripts/move-data.ts',
  'scripts/restore.ts',
];

const rel = (path: string) => relative(ROOT, path).replaceAll('\\', '/');

/** The source with comments blanked (offsets kept) and strings kept, as in
 *  test/reencrypt.test.ts. */
const code = (src: string) =>
  src.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) =>
    m[0] === '/' ? m.replace(/[^\n]/g, ' ') : m
  );

/** What an import specifier in `file` names: a module relative to the root,
 *  without its extension, or a package. */
function target(file: string, spec: string): string {
  if (!spec.startsWith('@/') && !spec.startsWith('.')) return spec.startsWith(`${CLIENT}/`) ? CLIENT : spec;
  const path = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : resolve(dirname(file), spec);
  return rel(path)
    .replace(/\.(?:[cm]?[jt]sx?)$/, '')
    .replace(/\/index$/, '');
}

/** The names an import or export clause takes, "*" for the whole module (a
 *  namespace, a default, or export *). */
function takenBy(clause: string): string[] {
  const out: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  for (const part of braces?.[1].split(',') ?? []) {
    const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
    if (name) out.push(name);
  }
  if (clause.replace(/\{[^}]*\}/, '').replace(/^\s*type\s/, ' ').replace(/[\s,]/g, '') !== '') out.push('*');
  return out;
}

const scanners = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }) };

/**
 * How a file reaches Redis directly, one line per way; empty if it does not.
 * Every import form is read: static, re-exports, side effects, dynamic and
 * require, under any path spelling. Bun's own scanner counts the imports too,
 * so an import of a guarded module in a form the patterns here cannot read is
 * reported rather than missed.
 */
function accessIn(file: string, source: string): string[] {
  const src = code(source);
  const found: string[] = [];
  const read = new Map<string, number>();
  const check = (spec: string, taken: string[]) => {
    const to = target(file, spec);
    read.set(to, (read.get(to) ?? 0) + 1);
    if (to === CLIENT) found.push(`imports ${spec}`);
    const guarded = ACCESS[to] ?? [];
    for (const name of taken) {
      if (name === '*' && guarded.length > 0) found.push(`all of ${spec}`);
      else if (guarded.includes(name)) found.push(`${name} from ${spec}`);
    }
  };
  for (const m of src.matchAll(/\b(?:import|export)\s+([^;'"`]*?)\s*\bfrom\s*(['"])([^'"\n]+)\2/g)) check(m[3], takenBy(m[1]));
  for (const m of src.matchAll(/\bimport\s*(['"])([^'"\n]+)\1/g)) check(m[2], []);
  for (const m of src.matchAll(/(?:\{([^{}]*)\}\s*=\s*)?(?:await\s+)?\b(?:import|require)\s*\(\s*(['"`])([^'"`\n$]+)\2\s*\)/g)) {
    // const { a, b: c } = await import('...'), or the whole module.
    check(m[3], m[1] ? m[1].split(',').map((p) => p.trim().split(/\s*:\s*/)[0]).filter(Boolean) : ['*']);
  }
  const counted = new Map<string, number>();
  for (const i of scanners[file.endsWith('.tsx') ? 'tsx' : 'ts'].scanImports(source)) {
    const to = target(file, i.path);
    counted.set(to, (counted.get(to) ?? 0) + 1);
  }
  for (const [to, n] of counted) {
    if ((to === CLIENT || to in ACCESS) && n > (read.get(to) ?? 0)) found.push(`an import of ${to} this test cannot read`);
  }
  return found;
}

const files: string[] = [join(ROOT, 'proxy.ts')];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.tsx?$/.test(name)) files.push(path);
  }
};
for (const dir of ['lib', 'app', 'components', 'scripts']) walk(join(ROOT, dir));
const sources = files.map((path) => ({ file: rel(path), path, source: readFileSync(path, 'utf8') }));

describe('reaching Redis', () => {
  const reaching = sources.map((s) => ({ file: s.file, access: accessIn(s.path, s.source) })).filter((s) => s.access.length > 0);

  test('is left to the Redis implementations and the files listed as legacy', () => {
    expect(sources.length).toBeGreaterThan(100); // the walk found the code
    const outside = reaching.filter((r) => !IMPLEMENTATION.includes(r.file) && !LEGACY.includes(r.file));
    expect(
      outside.map((r) => `${r.file}: ${r.access.join('; ')}`),
      [
        'These files reach Redis directly. Build stores on the storage seam instead: declare one with',
        'defineValueStore or defineMapStore (lib/repo.ts), import its module in lib/stores.ts, and call',
        'its methods. If the seam lacks an operation you need, add a named, tested method to lib/repo.ts.',
        'Do not add a file to LEGACY in this test: that list only shrinks. See docs/architecture.md, "Storage seam".',
      ].join(' ')
    ).toEqual([]);
  });

  test('the legacy list only shrinks: every file on it still reaches Redis', () => {
    const still = new Set(reaching.map((r) => r.file));
    expect(
      LEGACY.filter((f) => !still.has(f)),
      'These files no longer reach Redis directly (or are gone): take them off LEGACY in this test.'
    ).toEqual([]);
    expect(LEGACY).toEqual([...new Set(LEGACY)].sort());
    for (const f of IMPLEMENTATION) expect(existsSync(join(ROOT, f))).toBe(true);
  });

  test('every way of importing the client is seen, and nothing else is', () => {
    const cases: [string, string, string[]][] = [
      ['lib/a.ts', `import { redis } from './storage';`, ['redis from ./storage']],
      ['lib/a.ts', `import {\n  kc,\n  redis as r,\n  type Ctx,\n} from "./storage.ts";`, ['redis from ./storage.ts']],
      ['app/api/x/route.ts', `import { rawRedis } from '@/lib/storage';`, ['rawRedis from @/lib/storage']],
      ['app/api/x/route.ts', `import { kc, getItems } from '../../../lib/storage';`, []],
      ['lib/a.ts', `import * as storage from '../lib/storage';`, ['all of ../lib/storage']],
      ['lib/a.ts', `import storage, { kc } from './storage';`, ['all of ./storage']],
      ['lib/a.ts', `export { redis } from './storage';`, ['redis from ./storage']],
      ['lib/a.ts', `export * from './storage';`, ['all of ./storage']],
      ['lib/a.ts', `const { redis } = await import('@/lib/storage');`, ['redis from @/lib/storage']],
      ['lib/a.ts', `const { kc: key } = await import('@/lib/storage');`, []],
      ['lib/a.ts', 'const storage = await import(`./storage`);', ['all of ./storage']],
      ['lib/a.ts', `const storage = require('./storage');`, ['all of ./storage']],
      ['lib/a.ts', `import { Redis } from '@upstash/redis';`, ['imports @upstash/redis']],
      ['lib/a.ts', `import type { Redis } from '@upstash/redis/nodejs';`, ['imports @upstash/redis/nodejs']],
      ['lib/a.ts', `import '@upstash/redis';`, ['imports @upstash/redis']],
      ['lib/a.ts', `import { readEncryptedJson } from './stored-json';`, ['readEncryptedJson from ./stored-json']],
      ['lib/a.ts', `import { StoredDataUnreadableError, describeUnreadable } from './stored-json';`, []],
      ['lib/a.ts', `// import { redis } from './storage';\n/* import { rawRedis } from './storage'; */`, []],
      ['lib/a.ts', `import { redisStatus } from './storage';`, []],
      ['lib/a.ts', `import { redis } from './storage-helpers';`, []],
      ['lib/sub/a.ts', `import { redis } from './storage';`, []], // lib/sub/storage is another module
      // A form the patterns miss is still counted, so it fails rather than passes.
      ['lib/a.ts', `import{redis}from'./storage';`, ['an import of lib/storage this test cannot read']],
    ];
    for (const [file, source, expected] of cases) {
      expect([source, accessIn(join(ROOT, file), source)]).toEqual([source, expected]);
    }
  });
});

describe("the seam's own hooks", () => {
  const using = (name: string) =>
    sources.filter((s) => new RegExp(`\\b${name}\\b`).test(code(s.source))).map((s) => s.file);

  test('only lib/stores.ts reads the registry, so every reader sees every store', () => {
    expect(
      using('storesDeclaredSoFar').filter((f) => f !== 'lib/repo.ts' && f !== 'lib/stores.ts'),
      'Read declared stores through declaredStores() or declaredStore() in lib/stores.ts, which loads every declaring module first.'
    ).toEqual([]);
  });

  test('forgetting a declared store is for tests only', () => {
    expect(
      using('forgetDeclaredStore').filter((f) => f !== 'lib/repo.ts'),
      'forgetDeclaredStore takes a store out of the key inventory and the data download: tests only.'
    ).toEqual([]);
  });
});
