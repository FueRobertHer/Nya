import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { EXACT, PREFIXES } from '@/lib/key-families';
import { keyNamesIn } from './key-names';

// The storage boundary (Postgres migration plan, Phase 1): only the Redis
// implementations reach Redis. Everything else goes through a store, and a new
// store is declared through the storage seam (lib/repo.ts), so it can later run
// on another backend without its callers changing. Read from every source file
// but tests and dependencies.

const ROOT = join(import.meta.dir, '..');

/** What to do instead, for every failure here. */
const USE_THE_SEAM =
  'Build stores on the storage seam instead: declare one with defineValueStore or defineMapStore (lib/repo.ts), ' +
  'import its module in lib/stores.ts, and call its methods. If the seam lacks an operation you need, add a named, ' +
  'tested method to lib/repo.ts. See docs/architecture.md, "Storage seam".';

/** Reaching Redis directly: its client, or a primitive that reads and writes
 *  whatever key it is handed. By module (relative to the root, no extension). */
const ACCESS: Record<string, string[]> = {
  'lib/storage': ['redis', 'rawRedis'],
  'lib/stored-json': ['readEncryptedJson', 'writeEncryptedJson'],
};
/** The client package itself, under any import. */
const CLIENT = '@upstash/redis';

/** Where Redis is reached by design: the client's own module, and the seam. */
const IMPLEMENTATION = ['lib/storage.ts', 'lib/repo.ts'];

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
  'lib/stored-json.ts',
  'lib/transactions.ts',
  'lib/vanished.ts',
  'scripts/move-data.ts',
  'scripts/restore.ts',
];

/**
 * The key families stored the old way (lib/key-families.ts), as they were when
 * the seam arrived. A new key family is a store declared through the seam, never
 * a new entry on those lists: that would bring back raw Redis calls inside a
 * LEGACY file. Like LEGACY, these only shrink, as stores move behind the seam.
 */
const FROZEN_EXACT = [
  'account-links',
  'account-links:dismissed',
  'account-links:lock',
  'accounts:directory',
  'accounts:meta',
  'accounts:vanished',
  'budgets',
  'connections',
  'containers',
  'goals',
  'grants',
  'hidden:accounts',
  'history:accounts',
  'history:accounts:est',
  'history:accounts:est:ext',
  'history:accounts:est:flat',
  'history:accounts:est:flatd',
  'history:accounts:partial',
  'history:backfill-done',
  'history:backfill-pending',
  'history:net-worth',
  'history:net-worth:est',
  'manual:accounts',
  'owners',
  'plaid:items',
  'plaid:new-accounts',
  'txn-category-carry',
  'txn-category-overrides',
  'txn-vendor-renames',
];
const FROZEN_PREFIXES = [
  'backups:',
  'cache:',
  'crypto:',
  'history:forgetting:',
  'invites:',
  'invtxns-lock:',
  'invtxns:',
  'move:',
  'ratelimit:',
  'sessions:',
  'snapshot:',
  'txns-blocked:',
  'txns-unsaved:',
  'txns:',
];

/**
 * Every key name the code builds (test/key-names.ts: a templated name is its
 * fixed start and "x"), as when the seam arrived. A new store under a family
 * already listed (a "snapshot:access-log" hash added to lib/sharing.ts, say)
 * changes no list, so the names are frozen too. A store declared through the
 * seam builds its key in lib/repo.ts from its declared name, so it never adds
 * one. Like LEGACY, this only shrinks.
 */
const FROZEN_KEY_NAMES = [
  'account-links',
  'account-links:dismissed',
  'account-links:lock',
  'accounts:directory',
  'accounts:meta',
  'accounts:vanished',
  'backups:status',
  'budgets',
  'cache:inv-activity:v4',
  'cache:net-worth',
  'cache:transactions',
  'connections',
  'containers',
  'crypto:active',
  'crypto:keys',
  'crypto:master',
  'crypto:rotation',
  'crypto:rotation-lock',
  'goals',
  'hidden:accounts',
  'history:accounts',
  'history:accounts:est',
  'history:accounts:est:ext',
  'history:accounts:est:flat',
  'history:accounts:est:flatd',
  'history:accounts:partial',
  'history:backfill-done',
  'history:backfill-pending',
  'history:forgetting:x',
  'history:net-worth',
  'history:net-worth:est',
  'invites:x',
  'invtxns-lock:x',
  'invtxns:',
  'invtxns:x',
  'manual:accounts',
  'move:copied',
  'move:lock',
  'move:retired',
  'move:tmp:x',
  'owners',
  'plaid:items',
  'plaid:new-accounts',
  'ratelimit:demo:x',
  'ratelimit:login:x',
  'sessions:epoch',
  'sessions:legacy-cutoff',
  'snapshot:item-usage',
  'snapshot:lock',
  'snapshot:runs',
  'snapshot:taken',
  'txn-category-carry',
  'txn-category-overrides',
  'txn-vendor-renames',
  'txns-blocked:',
  'txns-blocked:x',
  'txns-unsaved:x',
  'txns:',
  'txns:x',
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

const scanners = {
  ts: new Bun.Transpiler({ loader: 'ts' }),
  tsx: new Bun.Transpiler({ loader: 'tsx' }),
  js: new Bun.Transpiler({ loader: 'js' }),
  jsx: new Bun.Transpiler({ loader: 'jsx' }),
};
const scannerFor = (file: string) => {
  const ext = /\.([cm]?)([jt]sx?)$/.exec(file)?.[2] ?? 'ts';
  return scanners[ext as keyof typeof scanners];
};

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
  for (const i of scannerFor(file).scanImports(source)) {
    const to = target(file, i.path);
    counted.set(to, (counted.get(to) ?? 0) + 1);
  }
  for (const [to, n] of counted) {
    if ((to === CLIENT || to in ACCESS) && n > (read.get(to) ?? 0)) found.push(`an import of ${to} this test cannot read`);
  }
  return found;
}

// Every source file, JavaScript included, wherever it sits: a new top-level
// directory or a root file is read too. Not the tests in test/, which use the
// test doubles; any other directory called test (an app/api/test/ route) is code.
const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.') || path === import.meta.dir) continue;
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.[cm]?[jt]sx?$/.test(name)) files.push(path);
  }
};
walk(ROOT);
const sources = files.map((path) => ({ file: rel(path), path, source: readFileSync(path, 'utf8') }));

describe('reaching Redis', () => {
  const reaching = sources.map((s) => ({ file: s.file, access: accessIn(s.path, s.source) })).filter((s) => s.access.length > 0);

  test('is left to the Redis implementations and the files listed as legacy', () => {
    // The walk found the code, from the root down, JavaScript included.
    expect(sources.length).toBeGreaterThan(100);
    for (const f of ['proxy.ts', 'next.config.js', 'lib/repo.ts', 'app/api/budgets/route.ts']) expect(files.map(rel)).toContain(f);
    const outside = reaching.filter((r) => !IMPLEMENTATION.includes(r.file) && !LEGACY.includes(r.file));
    expect(
      outside.map((r) => `${r.file}: ${r.access.join('; ')}`),
      `These files reach Redis directly. ${USE_THE_SEAM} Do not add a file to LEGACY in this test: that list only shrinks.`
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
      // JavaScript too, anywhere in the tree.
      ['instrumentation.js', `const { redis } = require('./lib/storage');`, ['redis from ./lib/storage']],
      ['tools/seed.mjs', `import { rawRedis } from '../lib/storage.ts';`, ['rawRedis from ../lib/storage.ts']],
    ];
    for (const [file, source, expected] of cases) {
      expect([source, accessIn(join(ROOT, file), source)]).toEqual([source, expected]);
    }
  });
});

describe('the key families stored the old way', () => {
  const exact = Object.keys(EXACT);
  const prefixes = PREFIXES.map(([p]) => p);

  test('gain no entry: a new key family is a store declared through the seam', () => {
    const message =
      'New key families come through the storage seam, never as a new entry in lib/key-families.ts written with raw ' +
      `Redis calls (not even inside a LEGACY file). ${USE_THE_SEAM}`;
    expect(
      exact.filter((k) => !FROZEN_EXACT.includes(k)),
      message
    ).toEqual([]);
    expect(
      prefixes.filter((p) => !FROZEN_PREFIXES.includes(p)),
      message
    ).toEqual([]);
  });

  test('only shrink: an entry that came off comes off the frozen list here too', () => {
    const message = 'These came off lib/key-families.ts (their stores moved behind the seam): take them off the frozen lists in this test.';
    expect(
      FROZEN_EXACT.filter((k) => !exact.includes(k)),
      message
    ).toEqual([]);
    expect(
      FROZEN_PREFIXES.filter((p) => !prefixes.includes(p)),
      message
    ).toEqual([]);
    for (const frozen of [FROZEN_EXACT, FROZEN_PREFIXES]) expect(frozen).toEqual([...new Set(frozen)].sort());
  });
});

describe('the key names the code builds', () => {
  const { names } = keyNamesIn(ROOT, files);

  test('gain none: a new store, even under a listed family, is declared through the seam', () => {
    expect(
      [...names].filter(([name]) => !FROZEN_KEY_NAMES.includes(name)).map(([name, at]) => `${[...at].join(', ')}: ${name}`),
      `These files build a key name the code did not build before. New key families come through the storage seam, never ` +
        `as a key built by hand, even under a prefix lib/key-families.ts already lists. ${USE_THE_SEAM}`
    ).toEqual([]);
  });

  test('only shrink: a name no longer built comes off the frozen list here too', () => {
    expect(
      FROZEN_KEY_NAMES.filter((name) => !names.has(name)),
      'The code no longer builds these (their stores moved behind the seam, or are gone): take them off FROZEN_KEY_NAMES in this test.'
    ).toEqual([]);
    expect(FROZEN_KEY_NAMES).toEqual([...new Set(FROZEN_KEY_NAMES)].sort());
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
