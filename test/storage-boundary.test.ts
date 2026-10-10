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
 *
 * One entry moved without growing the list: the login's wrong-password limiter
 * left app/api/login/route.ts for lib/rate-limit.ts, unchanged (same key, same
 * commands; it has since counted with its expiry in one script), so the data
 * download's password check shares it. It is
 * environment-wide (it counts by address before any container is known), which
 * the seam, containers only, cannot hold. A move, not a new raw store.
 */
const LEGACY = [
  'app/api/backup/route.ts',
  'app/api/demo/sign-in/route.ts',
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
  'lib/rate-limit.ts',
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
 * Every key name the code builds, with the file that builds it
 * (test/key-names.ts: a templated name is its fixed start and "x"), as when
 * the seam arrived. A new store under a family already listed (a
 * "snapshot:access-log" hash added to lib/sharing.ts, say) changes no list,
 * and a second file building from an existing template (txns:${...}) adds no
 * new name, so each name is frozen with its files. A store declared through
 * the seam builds its key in lib/repo.ts from its declared name, so it never
 * adds one. Like LEGACY, this only shrinks. "ratelimit:login:x" moved with
 * the login's limiter from app/api/login/route.ts to lib/rate-limit.ts (see
 * LEGACY): a move, not a new name. The one name added since,
 * "ratelimit:api:x", was approved with the API's review: a limit per address
 * on tokens that don't work, counted before any container is known, which the
 * seam (containers only) can't hold. It is the login's own pattern, beside it,
 * under the family already listed, and test/rate-limit-keys.test.ts holds it
 * to the environment's.
 */
const FROZEN_KEY_NAMES = [
  'account-links in lib/link-core.ts',
  'account-links:dismissed in lib/links.ts',
  'account-links:lock in lib/links.ts',
  'accounts:directory in lib/links.ts',
  'accounts:meta in lib/last-known.ts',
  'accounts:vanished in lib/vanished.ts',
  'backups:status in lib/backup.ts',
  'budgets in lib/budgets.ts',
  'cache:inv-activity:v4 in lib/cache.ts',
  'cache:net-worth in lib/cache.ts',
  'cache:transactions in lib/cache.ts',
  'connections in lib/sharing.ts',
  'containers in lib/containers.ts',
  'containers in lib/restore.ts',
  'crypto:active in lib/crypto.ts',
  'crypto:keys in lib/crypto.ts',
  'crypto:master in lib/crypto.ts',
  'crypto:rotation in lib/crypto.ts',
  'crypto:rotation-lock in lib/crypto.ts',
  'goals in lib/goals.ts',
  'hidden:accounts in lib/hidden.ts',
  'history:accounts in lib/history.ts',
  'history:accounts:est in lib/history.ts',
  'history:accounts:est:ext in lib/history.ts',
  'history:accounts:est:flat in lib/history.ts',
  'history:accounts:est:flatd in lib/history.ts',
  'history:accounts:partial in lib/history.ts',
  'history:backfill-done in lib/history.ts',
  'history:backfill-pending in lib/history.ts',
  'history:forgetting:x in lib/history.ts',
  'history:net-worth in lib/history.ts',
  'history:net-worth:est in lib/history.ts',
  'invites:x in lib/sharing.ts',
  'invtxns-lock:x in lib/invstore.ts',
  'invtxns: in lib/blob-sizes.ts',
  'invtxns:x in lib/invstore.ts',
  'manual:accounts in lib/manual.ts',
  'move:copied in lib/move.ts',
  'move:lock in lib/move.ts',
  'move:retired in lib/move.ts',
  'move:tmp:x in lib/move.ts',
  'owners in lib/admin-items.ts',
  'owners in lib/owners.ts',
  'plaid:items in lib/storage.ts',
  'plaid:new-accounts in lib/new-accounts.ts',
  'ratelimit:api:x in lib/rate-limit.ts',
  'ratelimit:demo:x in app/api/demo/sign-in/route.ts',
  'ratelimit:login:x in lib/rate-limit.ts',
  'sessions:epoch in lib/sessions.ts',
  'sessions:legacy-cutoff in lib/sessions.ts',
  'snapshot:item-usage in lib/item-usage.ts',
  'snapshot:lock in lib/snapshot-job.ts',
  'snapshot:runs in lib/snapshot-job.ts',
  'snapshot:taken in lib/history.ts',
  'txn-category-carry in lib/overrides.ts',
  'txn-category-overrides in lib/overrides.ts',
  'txn-vendor-renames in lib/renames.ts',
  'txns-blocked: in lib/blob-sizes.ts',
  'txns-blocked:x in lib/transactions.ts',
  'txns-unsaved:x in lib/transactions.ts',
  'txns: in lib/blob-sizes.ts',
  'txns:x in lib/transactions.ts',
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
  const built = [...names].flatMap(([name, at]) => [...at].map((file) => `${name} in ${file}`)).sort();

  test('gain none, nor a new file building one: a new store is declared through the seam', () => {
    expect(
      built.filter((pair) => !FROZEN_KEY_NAMES.includes(pair)),
      `These files build a key the code did not build there before. New key families come through the storage seam, never ` +
        `as a key built by hand, even under a prefix or template the code already uses. ${USE_THE_SEAM}`
    ).toEqual([]);
  });

  test('only shrink: a name a file no longer builds comes off the frozen list here too', () => {
    expect(
      FROZEN_KEY_NAMES.filter((pair) => !built.includes(pair)),
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
