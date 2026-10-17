// What test/hide-amounts.test.tsx scans the source with: every module the
// browser's pages can load, and in each one, an amount formatted past the
// switch (lib/format.ts), or a formatted amount kept where the switch can't
// reach it (a memo that doesn't change with it). The masking holds because
// every amount on screen is written by lib/format.ts at the time it is drawn;
// this keeps the next component, or the next branch's, from writing one some
// other way unseen.
//
// It reads TypeScript as text, not as a syntax tree: enough for the shapes
// this codebase writes (functions, arrow functions, imports and exports by
// name), and each check errs towards reporting, so a false report is fixed by
// writing the code the plain way, never by loosening the scan.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export type Source = { path: string; text: string };

/** The source without its comments, its string and template text kept (a
 *  template's ${...} is code). Keeps every offset's line. */
export function withoutComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const body = text.slice(i, end < 0 ? text.length : end + 2);
      out += body.replace(/[^\n]/g, ' ');
      i += body.length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The index of the bracket closing the one at `open`, or -1. Skips string
 *  and template text, but not a template's code. */
export function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Every .ts and .tsx file under `dir`. */
export function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** The modules a module imports at run time (not `import type`), as files. */
export function importsOf(root: string, file: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    const base = spec.startsWith('@/') ? join(root, spec.slice(2)) : spec.startsWith('.') ? join(dirname(file), spec) : null;
    if (!base) continue;
    const found = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find((p) => existsSync(p) && statSync(p).isFile());
    if (found) out.push(found);
  }
  return out;
}

/** The modules a browser's page can load: every component, every module
 *  marked 'use client', and all they import, transitively. */
export function clientModules(root: string): string[] {
  const seeds = [...filesUnder(join(root, 'components')), ...filesUnder(join(root, 'app')).filter((f) => /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8')))];
  const seen = new Set<string>();
  const queue = [...seeds];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    queue.push(...importsOf(root, f, readFileSync(f, 'utf8')));
  }
  return [...seen].sort().map((f) => relative(root, f));
}

/** The formatter calls that write an amount the way lib/format.ts does, with
 *  the switch: a call to one of these hides it. */
export const FORMATTERS = ['formatMoney', 'signedMoney', 'compactMoney', 'hiddenMoney', 'hiddenFigure', 'hideAmountsIn', 'hideFiguresIn'];

/** A number formatted as an amount without lib/format.ts: Intl's or
 *  toLocaleString's currency, fraction digits or compact notation (not a
 *  date's or a count's), or a "$" written before a figure by hand. */
const NUMBER_FORMAT = /new\s+Intl\.NumberFormat\s*\(/g;
const LOCALE_STRING = /\.toLocaleString\s*\(/g;
const AMOUNT_OPTIONS = /currency|FractionDigits|notation|style:\s*['"]currency['"]/;
const DOLLAR_BY_HAND = /`[^`]*?\$\$\{|['"]-?\$['"]\s*\+|\+\s*['"]-?\$['"]|\?\s*['"]-?\$['"]\s*:/g;

/** Where the enclosing function starts: the last line before `at` that
 *  starts one at the outermost level of a module or a component. */
function functionStart(text: string, at: number): number {
  const before = text.slice(0, at);
  let start = 0;
  for (const m of before.matchAll(/\n[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+\w+|const\s+\w+\s*=\s*(?:\([^)]*\)|\w+)\s*(?::[^=\n]+)?=>)/g)) start = m.index! + 1;
  return start;
}

/** A call formatting an amount is guarded when its function hides it while
 *  amounts are hidden: it checks the switch (amountsHidden()) or writes the
 *  figure through hiddenFigure or hiddenMoney before it. */
function guarded(text: string, at: number): boolean {
  const lineEnd = text.indexOf('\n', at);
  return /\bamountsHidden\(\)|\bhiddenFigure\(|\bhiddenMoney\(/.test(text.slice(functionStart(text, at), lineEnd < 0 ? text.length : lineEnd));
}

export type Bypass = { file: string; line: number; text: string };

/** Where `text` formats a number as an amount itself (Intl or
 *  toLocaleString with an amount's options, or a "$" by hand), by offset. */
function numberFormats(text: string): number[] {
  const out: number[] = [];
  for (const rx of [NUMBER_FORMAT, LOCALE_STRING]) {
    for (const m of text.matchAll(rx)) {
      const open = m.index! + m[0].length - 1;
      const end = closing(text, open);
      if (end < 0 || !AMOUNT_OPTIONS.test(text.slice(open, end + 1))) continue;
      // Asked what a currency's minor unit is, not to write one.
      if (/^\s*\.resolvedOptions\(/.test(text.slice(end + 1))) continue;
      out.push(m.index!);
    }
  }
  for (const m of text.matchAll(DOLLAR_BY_HAND)) out.push(m.index!);
  return out.sort((a, b) => a - b);
}

/** Each place in `sources` that formats an amount past the switch. */
export function bypasses(sources: readonly Source[]): Bypass[] {
  const out: Bypass[] = [];
  for (const { path, text: raw } of sources) {
    const text = withoutComments(raw.replace(/\r/g, ''));
    for (const at of numberFormats(text)) {
      if (!guarded(text, at)) out.push({ file: path, line: text.slice(0, at).split('\n').length, text: text.slice(at, text.indexOf('\n', at)).trim().slice(0, 120) });
    }
  }
  return out;
}

const FORMATTER_CALL = new RegExp(`\\b(?:${FORMATTERS.join('|')})\\s*\\(`);
/** Whether `code` writes an amount itself: a formatter, or a number
 *  formatted as one. */
const writesDirectly = (code: string) => FORMATTER_CALL.test(code) || numberFormats(code).length > 0;

/** Each function a module defines, by name, with its body. */
function functionsOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/\bfunction\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
    const paramsEnd = closing(text, m.index! + m[0].length - 1);
    const open = text.indexOf('{', paramsEnd);
    const end = open < 0 ? -1 : closing(text, open);
    if (end > 0) out.set(m[1], text.slice(open, end + 1));
  }
  for (const m of text.matchAll(/\bconst\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\(|\w+\s*=>)/g)) {
    // To the end of the statement: the first ; or line end at the outermost level.
    let depth = 0;
    let i = m.index!;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (depth === 0 && (c === ';' || (c === '\n' && !/^\s*[.?:&|+]/.test(text.slice(i + 1, i + 40)) && !/[=(,?:&|+]\s*$/.test(text.slice(Math.max(0, i - 40), i))))) break;
      if (depth < 0) break;
    }
    if (!out.has(m[1])) out.set(m[1], text.slice(m.index!, i));
  }
  return out;
}

/** What each name a module calls refers to: its own functions, and what it
 *  imports by name ({ a as b }, a default, or a namespace's members). */
function bindingsOf(root: string, file: string, text: string): Map<string, { file: string; name: string }> {
  const out = new Map<string, { file: string; name: string }>();
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+(?!type\s)([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const [target] = importsOf(root, file, `import x from '${m[2]}'`);
    if (!target) continue;
    const clause = m[1];
    const named = clause.match(/\{([^}]*)\}/);
    for (const part of named ? named[1].split(',') : []) {
      const p = part.trim().replace(/^type\s+/, '');
      if (!p || part.trim().startsWith('type ')) continue;
      const [name, as] = p.split(/\s+as\s+/);
      out.set((as ?? name).trim(), { file: target, name: name.trim() });
    }
    const def = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    const ns = def.match(/\*\s+as\s+(\w+)/);
    if (ns) out.set(`${ns[1]}.*`, { file: target, name: '*' });
    else if (/^\w+$/.test(def)) out.set(def, { file: target, name: 'default' });
  }
  return out;
}

/**
 * The functions that write an amount, by module: those calling a formatter
 * (FORMATTERS), formatting one past it, or calling another that writes one,
 * in their module or imported, to a fixed point. `modules` are files
 * relative to `root`.
 */
export function amountWriters(root: string, modules: readonly string[]): Map<string, Set<string>> {
  const facts = modules.map((m) => {
    const text = withoutComments(readFileSync(join(root, m), 'utf8').replace(/\r/g, ''));
    return { file: join(root, m), text, functions: functionsOf(text), bindings: bindingsOf(root, join(root, m), text) };
  });
  const writers = new Map<string, Set<string>>(facts.map((f) => [f.file, new Set<string>()]));
  const exported = (file: string, name: string) => writers.get(file)?.has(name) ?? false;
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of facts) {
      const mine = writers.get(f.file)!;
      for (const [name, body] of f.functions) {
        if (mine.has(name)) continue;
        if (writesAmount(body, f, mine, exported)) {
          mine.add(name);
          changed = true;
        }
      }
      // What it re-exports under its own name.
      for (const [local, b] of f.bindings) {
        if (!mine.has(local) && b.name !== '*' && exported(b.file, b.name) && new RegExp(`export\\s*\\{[^}]*\\b${local}\\b`).test(f.text)) {
          mine.add(local);
          changed = true;
        }
      }
    }
  }
  return writers;
}

type ModuleFacts = { file: string; text: string; functions: Map<string, string>; bindings: Map<string, { file: string; name: string }> };

/** Whether `code` writes an amount: itself, or by calling a function of its
 *  module or an imported one that writes one. */
function writesAmount(code: string, f: ModuleFacts, mine: Set<string>, exported: (file: string, name: string) => boolean): boolean {
  if (writesDirectly(code)) return true;
  for (const c of code.matchAll(/\b([A-Za-z_]\w*)(?:\.(\w+))?\s*\(/g)) {
    const [, name, member] = c;
    if (mine.has(name)) return true;
    const b = member ? f.bindings.get(`${name}.*`) : f.bindings.get(name);
    if (b && exported(b.file, member ?? b.name)) return true;
  }
  return false;
}

export type StaleMemo = { file: string; line: number; text: string };

/**
 * Each place that keeps an amount it wrote where the switch can't change it:
 * a useMemo whose callback writes one without the switch in its dependencies
 * (a value from useAmountsHidden()), a component wrapped in memo() that
 * writes one without reading the switch, and a useState starting from one.
 */
export function staleMemos(root: string, modules: readonly string[]): StaleMemo[] {
  const writers = amountWriters(root, modules);
  const exported = (file: string, name: string) => writers.get(file)?.has(name) ?? false;
  const out: StaleMemo[] = [];
  for (const m of modules) {
    const file = join(root, m);
    const text = withoutComments(readFileSync(file, 'utf8').replace(/\r/g, ''));
    const f: ModuleFacts = { file, text, functions: functionsOf(text), bindings: bindingsOf(root, file, text) };
    const mine = writers.get(file) ?? new Set<string>();
    const flags = [...text.matchAll(/\bconst\s+(\w+)\s*=\s*useAmountsHidden\(\)/g)].map((x) => x[1]);
    const report = (at: number) => out.push({ file: m, line: text.slice(0, at).split('\n').length, text: text.slice(at, text.indexOf('\n', at)).trim().slice(0, 120) });
    for (const call of text.matchAll(/\b(useMemo|useState|memo)\s*(?:<[^()]*>)?\s*\(/g)) {
      const open = call.index! + call[0].length - 1;
      const end = closing(text, open);
      if (end < 0) continue;
      const args = text.slice(open + 1, end);
      if (call[1] === 'useMemo') {
        const deps = args.match(/\[([^[\]]*)\]\s*$/)?.[1] ?? '';
        if (writesAmount(args.slice(0, args.length - deps.length), f, mine, exported) && !flags.some((flag) => new RegExp(`\\b${flag}\\b`).test(deps))) report(call.index!);
      } else if (call[1] === 'useState') {
        if (/^\s*\(\s*\)\s*=>/.test(args) && writesAmount(args, f, mine, exported)) report(call.index!);
      } else if (writesAmount(args, f, mine, exported) && !/\buseAmountsHidden\(\)/.test(args)) {
        report(call.index!);
      }
    }
  }
  return out;
}

export type Unspoken = { file: string; line: number; text: string };

/**
 * Each label a screen reader reads alone (aria-label, aria-valuetext, title,
 * alt) built from an amount without spoken(): while amounts are hidden it
 * would be read as bullets, never as "hidden".
 */
export function unspokenLabels(root: string, modules: readonly string[]): Unspoken[] {
  const writers = amountWriters(root, modules);
  const exported = (file: string, name: string) => writers.get(file)?.has(name) ?? false;
  const out: Unspoken[] = [];
  for (const m of modules) {
    const file = join(root, m);
    const text = withoutComments(readFileSync(file, 'utf8').replace(/\r/g, ''));
    const f: ModuleFacts = { file, text, functions: functionsOf(text), bindings: bindingsOf(root, file, text) };
    const mine = writers.get(file) ?? new Set<string>();
    for (const a of text.matchAll(/\s(?:aria-label|aria-valuetext|title|alt)=\{/g)) {
      const open = a.index! + a[0].length - 1;
      const end = closing(text, open);
      if (end < 0) continue;
      const expr = text.slice(open, end + 1);
      if (writesAmount(expr, f, mine, exported) && !/\b(?:spoken|spokenLabel)\(/.test(expr)) {
        out.push({ file: m, line: text.slice(0, a.index!).split('\n').length, text: text.slice(a.index!, text.indexOf('\n', a.index!)).trim().slice(0, 120) });
      }
    }
  }
  return out;
}

/** Elements whose text can't hold markup, or isn't read as text: SVG text
 *  (a chart is an image with its own label), a select's option (its
 *  aria-label says it), a document title. */
const PLAIN_TEXT_PARENTS = new Set(['text', 'tspan', 'option', 'title']);

/**
 * Each amount written straight into the page as a child of an element
 * ({formatMoney(...)} between tags or in a line of text, or a call to any
 * function that writes one, its module's or imported) outside <Masked>:
 * drawn, it is hidden, but a screen reader would read its bullets rather
 * than "hidden". A { not after $ (a template's) or = (an attribute's) before
 * a call is a child expression.
 */
export function unmaskedChildren(root: string, modules: readonly string[]): Unspoken[] {
  const writers = amountWriters(root, modules);
  const bodies = new Map<string, Map<string, string>>();
  const bodyOf = (file: string, name: string) => {
    if (!bodies.has(file)) bodies.set(file, functionsOf(withoutComments(readFileSync(file, 'utf8').replace(/\r/g, ''))));
    return bodies.get(file)!.get(name) ?? '';
  };
  // A function that builds elements (a table, a select) draws its amounts
  // itself, inside Masked: it isn't text to wrap.
  const buildsElements = (file: string, name: string) => /<\/|\/>/.test(bodyOf(file, name));
  const out: Unspoken[] = [];
  for (const m of modules) {
    const file = join(root, m);
    const text = withoutComments(readFileSync(file, 'utf8').replace(/\r/g, ''));
    const bindings = bindingsOf(root, file, text);
    const names = new Set(FORMATTERS);
    for (const name of writers.get(file) ?? []) if (!buildsElements(file, name)) names.add(name);
    for (const [local, b] of bindings) if (b.name !== '*' && writers.get(b.file)?.has(b.name) && !buildsElements(b.file, b.name)) names.add(local);
    names.delete('hideAmountsIn');
    names.delete('hideFiguresIn');
    if (names.size === 0) continue;
    const call = new RegExp(`(?<![$=])\\{(?:${[...names].join('|')})\\(`, 'g');
    for (const c of text.matchAll(call)) {
      const at = c.index!;
      if (text.slice(Math.max(0, at - 8), at) === '<Masked>') continue;
      const parent = [...text.slice(Math.max(0, at - 400), at + 1).matchAll(/<([A-Za-z][\w.]*)/g)].pop()?.[1] ?? '';
      if (PLAIN_TEXT_PARENTS.has(parent)) continue;
      out.push({ file: m, line: text.slice(0, at).split('\n').length, text: text.slice(at, text.indexOf('\n', at)).trim().slice(0, 120) });
    }
  }
  return out;
}
