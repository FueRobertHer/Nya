// What the browser loads stays off the server: no module a client component
// reaches, by a static import, an import() or a worker, is the storage seam,
// the encryption, a server-only package or a Node builtin. Each would ship to
// every phone that opens the app (the Redis client and the seam alone are
// hundreds of kilobytes), and a module that declares a store does so when it
// loads, so the bundler can't leave it out. A pure helper beside a store goes
// in its own module (lib/rules.ts and lib/rules-store.ts, lib/tags.ts and
// lib/tags-store.ts, lib/manual-types.ts).

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const SERVER_ONLY = ['lib/storage.ts', 'lib/repo.ts', 'lib/crypto.ts'];
// The Redis client, Plaid's server SDK and its HTTP client, what only a
// server can ask Clerk or Next, and Node's builtins, with or without node:.
const SERVER_PACKAGES = [/^node:/, /^@upstash\/redis/, /^plaid$/, /^axios$/, /^@clerk\/nextjs\/server/, /^next\/(headers|server)$/];
const BUILTINS = new Set(builtinModules);

const transpilers = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }) };
const rel = (p: string) => relative(ROOT, p).replaceAll('\\', '/');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(name) ? [p] : [];
  });
}

function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(ROOT, spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/** What a module loads at run time: its imports (type-only ones are gone once
 *  transpiled, as in the bundle) and the workers it starts. */
function importsOf(file: string): string[] {
  const code = readFileSync(file, 'utf8');
  const specs = transpilers[file.endsWith('.tsx') ? 'tsx' : 'ts'].scanImports(code).map((i) => i.path);
  for (const m of code.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) specs.push(m[1]);
  return specs;
}

const clientRoots = ['app', 'components', 'lib']
  .flatMap((d) => sourceFiles(join(ROOT, d)))
  .filter((f) => /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8')));

describe('client imports', () => {
  test('there are client components to walk from', () => {
    expect(clientRoots.length).toBeGreaterThan(10);
  });

  test('no client component reaches the storage seam, the encryption, Redis or a Node builtin', () => {
    // Each module reached, with the module that first imported it, so a
    // failure names the chain.
    const via = new Map<string, string | null>(clientRoots.map((f) => [f, null]));
    const queue = [...clientRoots];
    const found: string[] = [];
    const chain = (f: string): string => {
      const parts = [rel(f)];
      for (let p = via.get(f); p; p = via.get(p)) parts.unshift(rel(p));
      return parts.join(' -> ');
    };
    while (queue.length) {
      const file = queue.shift()!;
      for (const spec of importsOf(file)) {
        if (SERVER_PACKAGES.some((re) => re.test(spec)) || BUILTINS.has(spec.split('/')[0])) {
          found.push(`${chain(file)} -> ${spec}`);
          continue;
        }
        const target = resolveLocal(file, spec);
        if (!target || via.has(target)) continue;
        via.set(target, file);
        if (SERVER_ONLY.includes(rel(target))) found.push(chain(target));
        else queue.push(target);
      }
    }
    expect(found).toEqual([]);
  });
});
