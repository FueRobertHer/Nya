import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Every rate-limit key the code builds, read from the source, and where each
// one lives. A limit counted by address, before anyone is known, belongs to
// the environment (kEnv): it must be on ENV_WIDE_PREFIXES, so that a copy
// built inside a container by mistake is reported by the re-encryption pass
// (classify) instead of passing for that container's own. A limit on what a
// signed-in person does belongs to their container (kc) and must not be on
// that list, or the container's own counter would be reported instead.

const { classify } = await import('@/lib/reencrypt');
const { isEnvWide } = await import('@/lib/containers');

const ROOT = join(import.meta.dir, '..');
const CONTAINER = '6f1e2d3c-4b5a-4c6d-9e8f-7a6b5c4d3e2f';

/** Every .ts and .tsx file under a directory, relative to the repository. */
function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []
  );
}

type Built = { file: string; builder: string; name: string; sample: string };

// kEnv(`ratelimit:login:${ip}`) or kc(ctx, 'ratelimit:downloads'): the literal
// part of the name, and whether more follows it.
const BUILT = /\b(kEnv|kc)\(([^()'"`]*?,)?\s*(['"`])(ratelimit:[^'"`$]*)(\$\{)?/g;
const LITERAL = /(['"`])(ratelimit:[^'"`$]*)/g;

const built: Built[] = [];
const elsewhere: string[] = [];
for (const file of [...sources('lib'), ...sources('app'), ...sources('scripts'), 'proxy.ts']) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  for (const m of src.matchAll(BUILT)) {
    const name = m[4];
    // A name built further on (an address after it) gets a stand-in.
    built.push({ file, builder: m[1], name, sample: (m[5] || name.endsWith(':')) ? `${name}203.0.113.7` : name });
  }
  // A rate-limit name anywhere else is one built some other way, which this
  // test would miss. The lists that sort keys by prefix name only the bare
  // "ratelimit:", and ENV_WIDE_PREFIXES names the environment's own.
  const rest = src.replace(BUILT, '');
  for (const m of rest.matchAll(LITERAL)) {
    if (m[2] === 'ratelimit:') continue;
    if (file === join('lib', 'containers.ts')) continue;
    elsewhere.push(`${file}: ${m[2]}`);
  }
}

describe('every rate-limit key the code builds, and where it lives', () => {
  test('the scan finds them, and nothing builds one another way', () => {
    expect(built.map((b) => `${b.builder} ${b.name}`).sort()).toEqual(
      expect.arrayContaining(['kEnv ratelimit:demo:', 'kEnv ratelimit:login:', 'kc ratelimit:downloads'])
    );
    expect(elsewhere).toEqual([]);
  });

  test('a limit counted before anyone is known is the environment’s, and refused inside a container', () => {
    const env = built.filter((b) => b.builder === 'kEnv');
    expect(env.length).toBeGreaterThanOrEqual(2);
    for (const b of env) {
      expect({ at: b.file, key: b.sample, envWide: isEnvWide(b.sample) }).toEqual({ at: b.file, key: b.sample, envWide: true });
      expect({ at: b.file, key: b.sample, kind: classify(b.sample) }).toEqual({ at: b.file, key: b.sample, kind: 'plain' });
      // Built inside a container by mistake: reported, never taken as its own.
      expect({ at: b.file, key: b.sample, inside: classify(`c:${CONTAINER}:${b.sample}`) }).toEqual({ at: b.file, key: b.sample, inside: null });
    }
  });

  test('a limit on what a signed-in person does is their container’s', () => {
    const own = built.filter((b) => b.builder === 'kc');
    expect(own.length).toBeGreaterThanOrEqual(1);
    for (const b of own) {
      expect({ at: b.file, key: b.sample, envWide: isEnvWide(b.sample) }).toEqual({ at: b.file, key: b.sample, envWide: false });
      expect({ at: b.file, key: b.sample, inside: classify(`c:${CONTAINER}:${b.sample}`) }).toEqual({ at: b.file, key: b.sample, inside: 'plain' });
    }
  });
});
