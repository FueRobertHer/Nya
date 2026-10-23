// Every key name the code builds, read from the source: the name each
// kc(ctx, '...'), k('...') and kEnv('...') call spells out (a templated one as
// its fixed start followed by "x"), and every place a key is built from
// something this scan cannot read. Shared by test/reencrypt.test.ts, which
// checks each name is classified, and test/storage-boundary.test.ts, which
// freezes them so no new key family is built outside the storage seam.

import { readFileSync } from 'node:fs';

export type KeyNames = {
  /** Each name, with the files that build it (relative, forward slashes). */
  names: Map<string, Set<string>>;
  /** "file: code" for each key built from something the scan cannot read. */
  opaque: string[];
};

export function keyNamesIn(root: string, files: string[]): KeyNames {
  const names = new Map<string, Set<string>>();
  const opaque: string[] = [];
  for (const file of files) {
    // Forward slashes, so allowances that match on a path work on Windows too.
    const rel = file.slice(root.length + 1).replaceAll('\\', '/');
    const add = (name: string) => {
      if (!names.has(name)) names.set(name, new Set());
      names.get(name)!.add(rel);
    };
    // Comments blanked (offsets kept): a builder named in prose is not a
    // call. Strings are matched first and kept as they are, so a "//" or
    // "/*" inside one is never taken for a comment that hides code.
    const src = readFileSync(file, 'utf8').replace(
      /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      (m) => (m[0] === '/' ? m.replace(/[^\n]/g, ' ') : m)
    );
    const where = (i: number) => `${rel}: ${src.slice(i, i + 40).split('\n')[0]}`;
    const read = new Set<number>(); // where each call this could read starts

    // kc(ctx, 'name'): the name is the second argument.
    for (const m of src.matchAll(/\bkc\(\s*[A-Za-z_.]+\s*,\s*([^)]*?)\s*\)/g)) {
      read.add(m.index!);
      const quoted = /^(['"`])([^'"`$]*)\1$/.exec(m[1]);
      const templated = /^`([^`$]*)\$\{/.exec(m[1]);
      if (quoted) add(quoted[2]);
      else if (templated) add(`${templated[1]}x`);
      else if (!/^[a-zA-Z_]+: string$/.test(m[1])) opaque.push(where(m.index!));
    }
    // k('name') and kEnv('name').
    for (const m of src.matchAll(/\bk(?:Env)?\(\s*([^)]*?)\s*\)/g)) {
      read.add(m.index!);
      const arg = m[1];
      const quoted = /^(['"`])([^'"`$]*)\1$/.exec(arg);
      const templated = /^`([^`$]*)\$\{/.exec(arg);
      if (quoted) add(quoted[2]);
      else if (templated) add(`${templated[1]}x`);
      else if (!/^[a-zA-Z_]+: string$/.test(arg)) opaque.push(where(m.index!));
    }
    // Every other mention of kc or kEnv in code is reported: "kc (ctx, ...)",
    // "kc?.(...)", "const f = kc", "import { kc as f }" would all build keys
    // this scan cannot see. Only a plain import and the definitions pass.
    const imports = [...src.matchAll(/import\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]/g)].map(
      (m) => [m.index!, m.index! + m[0].length] as const
    );
    for (const m of src.matchAll(/\b(?:kc|kEnv)\b/g)) {
      const i = m.index!;
      if (read.has(i)) continue;
      if (/\bfunction\s+$/.test(src.slice(Math.max(0, i - 20), i))) continue;
      if (imports.some(([a, b]) => i > a && i < b) && !/^\w+\s+as\b/.test(src.slice(i))) continue;
      opaque.push(where(i));
    }
  }
  return { names, opaque };
}
