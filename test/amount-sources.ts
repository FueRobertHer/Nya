// What test/hide-amounts.test.tsx scans the source with: every module the
// browser's pages can load, and in each one, an amount formatted past the
// switch (lib/format.ts), a formatted amount kept where the switch can't
// reach it (a memo that doesn't change with it), or one drawn where a screen
// reader would be given its mask (as text outside <Masked>, or in a label not
// said through spoken()). The masking holds because every amount on screen is
// written by lib/format.ts at the time it is drawn; this keeps the next
// component, or the next branch's, from writing one some other way unseen.
//
// It reads TypeScript as text, not as a syntax tree: enough for the shapes
// this codebase writes (functions, arrow functions, imports and exports by
// name, JSX), and each check errs towards reporting, so a false report is
// fixed by writing the code the plain way, never by loosening the scan. One
// reader (lex) tells its code from all that is none (strings, template text,
// regular expressions, comments, JSX's text), so a bracket, a quote or a "//"
// in any of those hides nothing after it.
//
// WHAT IT TAKES FOR AN AMOUNT. A call to a formatter (FORMATTERS), or to a
// function that writes one, its module's or imported, to a fixed point; one
// of those handed on uncalled, as a callback (`.map(fmt)`) or as a
// component's prop (`money={fmt}`, then called as `money(...)` in that
// component); a variable or a component's prop given an amount; and a number
// written as one past the formatters: Intl's or toLocaleString's currency,
// fraction digits or compact notation, a "$" written by hand, toFixed, or a
// toLocaleString given no options, unless the code beside it says it is
// something else (saysWhatItIs). An amount drawn as text is one anywhere in a
// child expression: alone, in a template literal, a ternary or a list, or in
// a call given a formatter as a callback.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export type Source = { path: string; text: string };

// ---- Reading the text ----

/** An element as written: its name ('' for a fragment), from its "<" to the
 *  end of its closing tag. */
type Element = { name: string; start: number; end: number };
/** An expression in braces in JSX, `open` and `close` its braces: an
 *  attribute's (`attr` its name, '...' for a spread) or a child's (`attr`
 *  null), in `element`. */
type JsxExpr = { open: number; close: number; element: Element; attr: string | null };
/** A module's elements and JSX expressions, and its code's braces (for where
 *  a variable can be read). */
export type Jsx = { elements: Element[]; exprs: JsxExpr[]; blocks: [number, number][] };

/**
 * A text read as TypeScript, and as JSX too in a .tsx module: what of it is
 * code, and how its brackets pair. What is no code is passed over whole: a
 * string, a template literal's text (its ${...} is code), a regular
 * expression, a comment, and JSX's own text and quoted attributes. So a
 * bracket, a quote or a "//" in any of them is read as the text it is.
 */
export type Lexed = {
  /** The text, its comments written over with spaces: every offset kept. */
  code: string;
  /** The text with all that is no code written over with spaces, its line
   *  breaks kept: the names and the operators it is made of, where they are. */
  names: string;
  /** Where each stretch of no code ends, by where it starts. */
  opaque: Map<number, number>;
  /** Each bracket of the code and the one pairing it, both ways (a
   *  template's ${...} and a JSX expression's braces among them). */
  pairs: Map<number, number>;
  /** Where each element ends, by where it starts. */
  elementEnd: Map<number, number>;
  jsx: Jsx;
};

const IDENT = /[\w$]/;
const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** The word ending at `i`. */
function wordAt(text: string, i: number): string {
  let j = i;
  while (j >= 0 && IDENT.test(text[j])) j--;
  return text.slice(j + 1, i + 1);
}

/** The index past a string literal at `at`: a JSX attribute's may span lines
 *  and has no escapes. */
function pastString(text: string, at: number, jsx = false): number {
  const q = text[at];
  let j = at + 1;
  while (j < text.length && text[j] !== q && (jsx || text[j] !== '\n')) j += !jsx && text[j] === '\\' ? 2 : 1;
  return Math.min(j + 1, text.length);
}

/** The index past a regular expression literal at `at`, or -1 when its line
 *  holds none. */
function pastRegex(text: string, at: number): number {
  let j = at + 1;
  let inClass = false;
  while (j < text.length && text[j] !== '\n') {
    const c = text[j];
    if (c === '\\') j += 2;
    else if (c === '[') (inClass = true), j++;
    else if (c === ']') (inClass = false), j++;
    else if (c === '/' && !inClass) {
      j++;
      while (/[a-z]/.test(text[j] ?? '')) j++;
      return j;
    } else j++;
  }
  return -1;
}

/** `text` written over with spaces in `ranges` (in order), its line breaks
 *  kept. */
function blankIn(text: string, ranges: readonly [number, number][]): string {
  let out = '';
  let at = 0;
  for (const [from, to] of ranges) {
    out += text.slice(at, from) + text.slice(from, to).replace(/[^\n]/g, ' ');
    at = to;
  }
  return out + text.slice(at);
}

/**
 * `text` read as TypeScript, and as JSX too when `jsx` (Lexed). A "<" that
 * turns out to start no element (a generic arrow function's `<T,>`) is read
 * as code again, with nothing recorded from it.
 */
export function lex(text: string, jsx: boolean): Lexed {
  const passed: [number, number][] = [];
  const comments: [number, number][] = [];
  const pairs: [number, number][] = [];
  const out: Jsx = { elements: [], exprs: [], blocks: [] };
  const mark = () => [passed.length, comments.length, pairs.length, out.elements.length, out.exprs.length, out.blocks.length];
  const undo = (m: number[]) => {
    [passed.length, comments.length, pairs.length, out.elements.length, out.exprs.length, out.blocks.length] = m;
    return -1;
  };
  const pass = (from: number, to: number) => (passed.push([from, to]), to);

  // A comment at `at`, to past its end.
  const comment = (at: number): number => {
    const end = text[at + 1] === '/' ? text.indexOf('\n', at) : text.indexOf('*/', at + 2);
    const to = end < 0 ? text.length : text[at + 1] === '/' ? end : end + 2;
    comments.push([at, to]);
    return pass(at, to);
  };

  // The last index before `at` that is neither a space nor in a comment.
  const previous = (at: number): number => {
    let i = at - 1;
    let k = comments.length - 1;
    for (;;) {
      while (i >= 0 && /\s/.test(text[i])) i--;
      while (k >= 0 && comments[k][0] > i) k--;
      if (k < 0 || i >= comments[k][1]) return i;
      i = comments[k][0] - 1;
    }
  };

  // Whether a "<" at `at`, in code, starts an element rather than comparing
  // or naming a type: after an operator, a bracket or `return`, never after a
  // name, a number or a closing bracket.
  const startsElement = (at: number): boolean => {
    if (!/[A-Za-z_$>]/.test(text[at + 1] ?? '')) return false;
    const i = previous(at);
    if (i < 0) return true;
    if (IDENT.test(text[i])) return /^(?:return|yield|await|default|case)$/.test(wordAt(text, i));
    return !/[)\]'"`.]/.test(text[i]);
  };

  // Whether a "/" at `at`, in code, starts a regular expression rather than
  // dividing: after an operator, a bracket or a keyword.
  const startsRegex = (at: number): boolean => {
    const i = previous(at);
    if (i < 0) return true;
    if (IDENT.test(text[i])) return /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(wordAt(text, i));
    return !/[)\]'"`]/.test(text[i]);
  };

  // Code from `i`: to the "}" closing it (`inBraces`), whose index is
  // returned, or to the end.
  const code = (i: number, inBraces: boolean): number => {
    const open: number[] = [];
    while (i < text.length) {
      const c = text[i];
      if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
        i = comment(i);
        continue;
      }
      if (c === "'" || c === '"') {
        i = pass(i, pastString(text, i));
        continue;
      }
      if (c === '`') {
        i = template(i);
        continue;
      }
      if (c === '/' && startsRegex(i)) {
        const past = pastRegex(text, i);
        if (past > 0) {
          i = pass(i, past);
          continue;
        }
      }
      if (c === '(' || c === '[' || c === '{') open.push(i);
      else if (c === ')' || c === ']' || c === '}') {
        const top = open[open.length - 1];
        if (top !== undefined && text[top] === OPENER[c]) {
          open.pop();
          pairs.push([top, i]);
          if (c === '}') out.blocks.push([top, i]);
        } else if (c === '}' && inBraces && !open.some((o) => text[o] === '{')) return i;
      } else if (jsx && c === '<' && startsElement(i)) {
        const past = element(i);
        if (past > 0) {
          i = past;
          continue;
        }
      }
      i++;
    }
    return i;
  };

  // A template literal at `i`, to past its closing backtick.
  const template = (i: number): number => {
    let from = i;
    let j = i + 1;
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') j += 2;
      else if (c === '`') return pass(from, j + 1);
      else if (c === '$' && text[j + 1] === '{') {
        pass(from, j + 1);
        const close = code(j + 2, true);
        if (close >= text.length) return close;
        pairs.push([j + 1, close]);
        from = j = close + 1;
      } else j++;
    }
    return pass(from, text.length);
  };

  // Past spaces and comments, in a tag.
  const pastSpace = (j: number): number => {
    for (;;) {
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== '/' || (text[j + 1] !== '/' && text[j + 1] !== '*')) return j;
      j = comment(j);
    }
  };

  // A JSX expression whose "{" is at `j`, in `el`, to past its "}", or -1
  // for none.
  const expr = (j: number, el: Element, attr: string | null): number => {
    const close = code(j + 1, true);
    if (close >= text.length) return -1;
    pairs.push([j, close]);
    out.exprs.push({ open: j, close, element: el, attr });
    return close + 1;
  };

  // An element at `i`, to past its end, or -1 for none.
  const element = (i: number): number => {
    const before = mark();
    const name = /^[A-Za-z_$][\w$.:-]*/.exec(text.slice(i + 1, i + 200))?.[0] ?? '';
    let j = i + 1 + name.length;
    // A generic arrow function's type parameters, `<T,>` or `<T extends ...>`.
    if (name && /^\s*(?:,|extends\b)/.test(text.slice(j, j + 20))) return -1;
    const el: Element = { name, start: i, end: -1 };
    if (!name) {
      if (text[j] !== '>') return -1;
      j++;
    } else {
      for (;;) {
        j = pastSpace(j);
        if (j >= text.length) return undo(before);
        if (text.startsWith('/>', j)) {
          el.end = j + 2;
          out.elements.push(el);
          return el.end;
        }
        if (text[j] === '>') {
          j++;
          break;
        }
        if (text[j] === '{') {
          j = expr(j, el, '...');
          if (j < 0) return undo(before);
          continue;
        }
        const attr = /^[\w$:.-]+/.exec(text.slice(j, j + 100))?.[0];
        if (!attr) return undo(before);
        j = pastSpace(j + attr.length);
        if (text[j] !== '=') continue;
        j = pastSpace(j + 1);
        if (text[j] === '"' || text[j] === "'") j = pass(j, pastString(text, j, true));
        else if (text[j] === '{') j = expr(j, el, attr);
        else if (text[j] === '<') j = element(j);
        else return undo(before);
        if (j < 0) return undo(before);
      }
    }
    // Its children, their text passed over, to its closing tag.
    let from = j;
    while (j < text.length) {
      const c = text[j];
      if (c === '<' || c === '{') {
        if (j > from) pass(from, j);
        if (text.startsWith('</', j)) {
          const close = text.indexOf('>', j);
          if (close < 0 || text.slice(j + 2, close).trim() !== name) return undo(before);
          el.end = close + 1;
          out.elements.push(el);
          return el.end;
        }
        j = c === '<' ? element(j) : expr(j, el, null);
        if (j < 0) return undo(before);
        from = j;
        continue;
      }
      j++;
    }
    return undo(before);
  };

  code(0, false);
  return {
    code: blankIn(text, comments),
    names: blankIn(text, passed),
    opaque: new Map(passed),
    pairs: new Map(pairs.flatMap(([a, b]) => [[a, b] as const, [b, a] as const])),
    elementEnd: new Map(out.elements.map((el) => [el.start, el.end])),
    jsx: out,
  };
}

const recent = new Map<string, Lexed>();

/** A part of an expression read as code (lex): the last few kept, as the
 *  same part is read again and again. */
function lexed(text: string): Lexed {
  let lx = recent.get(text);
  if (!lx) {
    lx = lex(text, false);
    recent.set(text, lx);
    if (recent.size > 64) recent.delete(recent.keys().next().value!);
  }
  return lx;
}

/** The source without its comments, written over with spaces. */
export function withoutComments(text: string, jsx = true): string {
  return lex(text, jsx).code;
}

/** The elements, JSX expressions and code blocks of a module's text. */
export function jsxOf(text: string): Jsx {
  return lex(text, true).jsx;
}

/** The index of the bracket closing the one at `open`, or -1, in code (lex):
 *  past strings, template text, regular expressions and comments. */
export function closing(text: string | Lexed, open: number): number {
  const close = (typeof text === 'string' ? lexed(text) : text).pairs.get(open);
  return close !== undefined && close > open ? close : -1;
}

/** The index of the bracket opening the one at `close`, or -1: closing(),
 *  backwards. */
function opening(lx: Lexed, close: number): number {
  const open = lx.pairs.get(close);
  return open !== undefined && open < close ? open : -1;
}

/** The indexes of `code` at its outermost level: in no bracket, and in no
 *  string, template or regular expression. */
function topLevel(code: string): number[] {
  const lx = lexed(code);
  const out: number[] = [];
  for (let i = 0; i < code.length; i++) {
    const past = lx.opaque.get(i);
    const pair = lx.pairs.get(i);
    if (past !== undefined) i = past - 1;
    else if (pair !== undefined) i = Math.max(i, pair);
    else out.push(i);
  }
  return out;
}

/** Where the statement at `at` ends: at the first ";" or line end at its
 *  outermost level that ends it, or at the bracket closing what it is in;
 *  an element, a string or a template being read whole. */
function statementEnd(lx: Lexed, at: number): number {
  const t = lx.code;
  let i = at;
  for (; i < t.length; i++) {
    const past = lx.opaque.get(i) ?? lx.elementEnd.get(i);
    if (past !== undefined) {
      i = past - 1;
      continue;
    }
    const pair = lx.pairs.get(i);
    if (pair !== undefined && pair > i) {
      i = pair;
      continue;
    }
    const c = t[i];
    if (c === ')' || c === ']' || c === '}' || c === ';') break;
    if (c === '\n' && !/^\s*[.?:&|+]/.test(t.slice(i + 1, i + 40)) && !/[=(,?:&|+]\s*$/.test(t.slice(Math.max(0, i - 40), i))) break;
  }
  return i;
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

/** What writes an amount's own figures for a form's field to hold, whatever
 *  the switch says (lib/format.ts fieldAmount): never text drawn on a page,
 *  where they would show while amounts are hidden, in <Masked> or not. */
export const FIELD_WRITERS = ['fieldAmount'];

/** A number formatted as an amount without lib/format.ts: Intl's or
 *  toLocaleString's currency, fraction digits or compact notation (not a
 *  date's or a count's), toFixed or a toLocaleString given no options (but
 *  where the code beside it says it is something else: saysWhatItIs), or a
 *  "$" written before a figure by hand. */
const NUMBER_FORMAT = /new\s+Intl\.NumberFormat\s*\(/g;
const LOCALE_STRING = /\.toLocaleString\s*\(/g;
const TO_FIXED = /\.toFixed\s*\(/g;
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

/** Where the expression a method is called on starts, `dot` being the "."
 *  before the method: back over names, members, calls, indexes, a group in
 *  parentheses and non-null assertions. */
function receiverStart(lx: Lexed, dot: number): number {
  const text = lx.code;
  let i = dot - 1;
  for (;;) {
    const c = text[i];
    if (c === '!') {
      i--;
      continue;
    }
    if (c === ')' || c === ']') {
      const open = opening(lx, i);
      if (open < 0) return i + 1;
      // A call's callee, or an index's object, is part of it; a group stands alone.
      if (open > 0 && /[\w$)\]!]/.test(text[open - 1])) {
        i = open - 1;
        continue;
      }
      return open;
    }
    if (i >= 0 && /[\w$]/.test(c)) {
      while (i >= 0 && /[\w$]/.test(text[i])) i--;
      if (text[i] === '.') {
        i -= text[i - 1] === '?' ? 2 : 1;
        continue;
      }
      return i + 1;
    }
    return i + 1;
  }
}

/** A percentage, a size or a time, said right after a number. */
const MEASURE_AFTER = /^(?:\s?%|\s*\+\s*['"]\s?%|\s?[KMGT]?B\b|\s(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?)\b)/;
/** A drawn shape's coordinate: right after a path's command letter or a
 *  pair's comma in a template, or right before the comma of a pair. */
const COORDINATE_BEFORE = /[MLHVCSQTAmlhvcsqta,]\$\{$/;
const COORDINATE_AFTER = /^\},(?:\$\{|-?\d)/;
/** A channel of a CSS color. */
const COLOR_BEFORE = /\b(?:rgba?|hsla?)\([^()`]*\$\{$/;

/**
 * Whether the code beside a number written with toFixed, or with a
 * toLocaleString given no options, says it is no amount: a percentage (a "%"
 * after it, or a fraction made one by a hundred), a size or a time after it,
 * a drawn shape's coordinate, a color's channel, or a number rounded as a
 * number (in Number(...)); and, for toLocaleString, a count (followed by a
 * word saying what it counts, or by its noun chosen by it, or a length) or a
 * date. Anything else is taken for an amount.
 */
function saysWhatItIs(lx: Lexed, dot: number, end: number, method: 'toFixed' | 'toLocaleString'): boolean {
  const text = lx.code;
  const start = receiverStart(lx, dot);
  const receiver = text.slice(start, dot);
  const before = text.slice(Math.max(0, start - 60), start);
  // Past the calls wrapping it, and the template's or JSX's brace closing it.
  let k = end + 1;
  while (text[k] === ')') k++;
  const next = text.slice(k, k + 80);
  const after = next.startsWith('}') ? next.slice(1) : next;
  if (MEASURE_AFTER.test(after)) return true;
  if (/\*\s*100\s*\)$/.test(receiver)) return true;
  if (COORDINATE_BEFORE.test(before) || COORDINATE_AFTER.test(next) || COLOR_BEFORE.test(before)) return true;
  if (/\bNumber\($/.test(before) && text[end + 1] === ')') return true;
  if (method !== 'toLocaleString') return false;
  if (/^\s+[a-z]/.test(after)) return true;
  if (/\.length$/.test(receiver)) return true;
  if (/\bnew\s+$/.test(before) && /^Date\b/.test(receiver)) return true;
  // "3 rows", its noun chosen by it: `${n.toLocaleString()} ${n === 1 ? ...`.
  const name = receiver.replace(/[!\s]/g, '').replace(/[.$()[\]?*+|\\^{}]/g, (ch) => `\\${ch}`);
  return new RegExp(`^\\s*\\$?\\{\\s*${name}!?\\s*===\\s*1\\b`).test(after);
}

/** Where a module's code formats a number as an amount itself (Intl or
 *  toLocaleString with an amount's options, toFixed or toLocaleString with
 *  none and nothing beside it to say otherwise, or a "$" by hand), by
 *  offset. */
function numberFormats(lx: Lexed): number[] {
  const text = lx.code;
  const out: number[] = [];
  for (const rx of [NUMBER_FORMAT, LOCALE_STRING, TO_FIXED]) {
    for (const m of lx.names.matchAll(rx)) {
      const open = m.index! + m[0].length - 1;
      const end = closing(lx, open);
      if (end < 0) continue;
      const args = text.slice(open + 1, end);
      if (rx === NUMBER_FORMAT || args.includes('{')) {
        // Given options: an amount's when they name a currency, fraction digits or compact notation.
        if (!AMOUNT_OPTIONS.test(args)) continue;
        // Asked what a currency's minor unit is, not to write one.
        if (/^\s*\.resolvedOptions\(/.test(text.slice(end + 1))) continue;
      } else if (saysWhatItIs(lx, m.index!, end, rx === TO_FIXED ? 'toFixed' : 'toLocaleString')) {
        continue;
      }
      out.push(m.index!);
    }
  }
  for (const m of text.matchAll(DOLLAR_BY_HAND)) out.push(m.index!);
  return out.sort((a, b) => a - b);
}

const lineOf = (text: string, at: number) => text.slice(0, at).split('\n').length;
const lineText = (text: string, at: number) => {
  const end = text.indexOf('\n', at);
  return text.slice(at, end < 0 ? text.length : end).trim().slice(0, 120);
};

/** Each place in `sources` that formats an amount past the switch, once a
 *  line. */
export function bypasses(sources: readonly Source[]): Bypass[] {
  const out: Bypass[] = [];
  for (const { path, text: raw } of sources) {
    const lx = lex(raw.replace(/\r/g, ''), path.endsWith('.tsx'));
    const text = lx.code;
    const lines = new Set<number>();
    for (const at of numberFormats(lx)) {
      const line = lineOf(text, at);
      if (guarded(text, at) || lines.has(line)) continue;
      lines.add(line);
      out.push({ file: path, line, text: lineText(text, at) });
    }
  }
  return out;
}

// ---- What a module writes ----

/** Where the body of a function whose parameters close at `paramsEnd`
 *  opens, past its return type (whose object types are types, not its
 *  body: a "{" after ":", "|", "&", "<", "," or a bracket), or -1. */
function bodyOpen(lx: Lexed, paramsEnd: number): number {
  const t = lx.names;
  for (let i = paramsEnd + 1; i < t.length; i++) {
    const c = t[i];
    if (c === ';' || c === ')' || c === ']' || c === '}') return -1;
    if (c !== '(' && c !== '[' && c !== '{') continue;
    let p = i - 1;
    while (p >= 0 && /\s/.test(lx.code[p])) p--;
    if (c === '{' && !/[:|&<,([]/.test(lx.code[p])) return i;
    i = lx.pairs.get(i) ?? i;
  }
  return -1;
}

/** Each function a module defines, by name, with where its body is: a
 *  function's braces, or a const's arrow to the end of its statement. */
function functionRanges(lx: Lexed): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const m of lx.names.matchAll(/\bfunction\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
    const paramsEnd = closing(lx, m.index! + m[0].length - 1);
    const open = paramsEnd < 0 ? -1 : bodyOpen(lx, paramsEnd);
    const end = open < 0 ? -1 : closing(lx, open);
    if (end > 0) out.set(m[1], [open, end + 1]);
  }
  for (const m of lx.names.matchAll(/\bconst\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\(|\w+\s*=>)/g)) {
    if (!out.has(m[1])) out.set(m[1], [m.index!, statementEnd(lx, m.index!)]);
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

/** The function a module's default export is: its own name, or the name
 *  it exports as default. */
function defaultExportOf(text: string): string | null {
  return /\bexport\s+default\s+(?:async\s+)?function\s+(\w+)/.exec(text)?.[1] ?? /\bexport\s+default\s+(\w+)\s*;/.exec(text)?.[1] ?? null;
}

/** A variable given an amount, and where it can be read: from its
 *  declaration to the end of the block it is in. */
type AmountVar = { name: string; from: number; to: number };

type ModuleFacts = {
  file: string;
  lx: Lexed;
  /** Its text, without its comments (lx.code). */
  text: string;
  jsx: Jsx;
  /** Where it formats a number as an amount (numberFormats). */
  formats: number[];
  ranges: Map<string, [number, number]>;
  bindings: Map<string, { file: string; name: string }>;
  /** Its functions that write an amount, and those that write a field's figures. */
  writers: Set<string>;
  fieldWriters: Set<string>;
  /** Of each of its components, the props given a function that writes an
   *  amount, and the props given an amount. */
  propWriters: Map<string, Set<string>>;
  propAmounts: Map<string, Set<string>>;
  amountVars: AmountVar[];
};

type Model = { facts: ModuleFacts[]; byFile: Map<string, ModuleFacts>; writers: Map<string, Set<string>>; fieldWriters: Map<string, Set<string>> };

/** Which functions count, by module and name: those writing an amount, those
 *  writing one as text (building no elements of their own, which draw
 *  their amounts themselves, inside Masked), or those writing a field's
 *  figures. */
type Pick = (file: string, name: string) => boolean;

/** Whether a function of `f` builds elements: `</` or `/>` in its code. */
function builds(f: ModuleFacts | undefined, name: string): boolean {
  const [from, to] = f?.ranges.get(name) ?? [0, 0];
  return /<\/|\/>/.test(f?.lx.names.slice(from, to) ?? '');
}

const amountPick = (model: Model): Pick => (file, name) => model.writers.get(file)?.has(name) ?? false;
const textPick = (model: Model): Pick => (file, name) => (model.writers.get(file)?.has(name) ?? false) && !builds(model.byFile.get(file), name);
const fieldPick = (model: Model): Pick => (file, name) => model.fieldWriters.get(file)?.has(name) ?? false;

const ARROW = /^\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>|^\s*(?:async\s+)?function\b/;

/** A ternary's "?", not optional chaining's "?." nor "??". */
const isQuestion = (e: string, i: number) => e[i] === '?' && e[i + 1] !== '.' && e[i + 1] !== '?' && e[i - 1] !== '?';
/** A comparison or an equality, whose answer React draws as nothing. */
const isTest = (e: string, i: number) => /^(?:[=!]==?|[<>]=?)/.test(e.slice(i, i + 3)) && !/^(?:=>|==>)/.test(e.slice(i, i + 3)) && e[i - 1] !== '=' && e[i - 1] !== '!' && e[i - 1] !== '<' && e[i - 1] !== '>';

/** What a callback returns: its expression, or each of its block's returns;
 *  a function named, as a call of it. */
function returnsOf(callback: string): string[] {
  const arrow = /^\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>\s*/.exec(callback);
  if (!arrow) return [/^\s*[\w$.]+\s*$/.test(callback) ? `${callback.trim()}()` : callback];
  const body = callback.slice(arrow[0].length).trim();
  if (!body.startsWith('{')) return drawnParts(body);
  const lx = lexed(body);
  const out: string[] = [];
  for (const m of lx.names.matchAll(/(?<![\w$.])return\b/g)) {
    const from = m.index! + m[0].length;
    let i = from;
    for (; i < body.length; i++) {
      const past = lx.opaque.get(i);
      const pair = lx.pairs.get(i);
      if (past !== undefined) i = past - 1;
      else if (pair !== undefined && pair > i) i = pair;
      else if (/[)\]};]/.test(body[i])) break;
    }
    out.push(...drawnParts(body.slice(from, i)));
  }
  return out;
}

/**
 * The parts of a child expression (its elements written over) whose value
 * is what is drawn: a ternary's branches but not its test (and, past a test
 * that a value is not a string, not that value in the branch it isn't), each
 * side of || and ??, the last of a run of &&, what .map's or .flatMap's
 * callback returns but not what it is called on, nothing for a test (React
 * draws true and false as nothing), and anything else whole.
 */
export function drawnParts(code: string): string[] {
  let e = code.trim();
  while (e.startsWith('(') && closing(e, 0) === e.length - 1) e = e.slice(1, -1).trim();
  if (!e) return [];
  const top = topLevel(e);
  const q = top.find((i) => isQuestion(e, i));
  if (q !== undefined) {
    let nest = 0;
    const colon = top.find((i) => {
      if (i <= q) return false;
      if (isQuestion(e, i)) nest++;
      else if (e[i] === ':') {
        if (nest === 0) return true;
        nest--;
      }
      return false;
    });
    if (colon !== undefined) {
      let [yes, no] = [e.slice(q + 1, colon), e.slice(colon + 1)];
      const t = /^\s*typeof\s+([\w$.]+)\s*(===|!==)\s*['"]string['"]\s*$/.exec(e.slice(0, q));
      if (t) {
        const unset = (part: string) => part.replace(new RegExp(`(?<![\\w$.])${t[1].replace(/[.$]/g, (ch) => `\\${ch}`)}(?![\\w$])`, 'g'), ' ');
        if (t[2] === '===') no = unset(no);
        else yes = unset(yes);
      }
      return [...drawnParts(yes), ...drawnParts(no)];
    }
  }
  const ors = top.filter((i) => (e[i] === '|' && e[i + 1] === '|') || (e[i] === '?' && e[i + 1] === '?'));
  if (ors.length > 0) {
    const parts: string[] = [];
    let from = 0;
    for (const i of ors) parts.push(e.slice(from, i)), (from = i + 2);
    parts.push(e.slice(from));
    return parts.flatMap(drawnParts);
  }
  const ands = top.filter((i) => e[i] === '&' && e[i + 1] === '&');
  if (ands.length > 0) return drawnParts(e.slice(ands[ands.length - 1] + 2));
  if (/^!(?!=)|^typeof\b/.test(e) || top.some((i) => isTest(e, i))) return [];
  const maps = top.filter((i) => /^\.(?:map|flatMap)\s*\(/.test(e.slice(i)));
  if (maps.length > 0) {
    const open = e.indexOf('(', maps[maps.length - 1]);
    const close = closing(e, open);
    if (close > 0) return returnsOf(e.slice(open + 1, close).replace(/,\s*[\w$]+\s*$/, ''));
  }
  return [e];
}

/** How much of [from, to) of `f` is read: `all` of it; its `own` code, the
 *  elements in it written over (theirs is their children's and attributes'
 *  to answer for); or only what of that is `drawn` (drawnParts). */
type Reading = 'all' | 'own' | 'drawn';

/** A part drawn as it is said to a screen reader: through spoken(). */
const SAID = /^\s*(?:spoken|spokenLabel)\s*\(/;

/** [from, to) of `f` as `how` reads it, the names its code is made of (no
 *  string's or template's text), and, of what is drawn, but what is said
 *  through spoken(); and whether a number is formatted as an amount in it. */
function region(f: ModuleFacts, from: number, to: number, how: Reading): { names: string; formats: boolean } {
  const nested = how === 'all' ? [] : f.jsx.elements.filter((el) => el.start >= from && el.end <= to);
  const read = (text: string) => {
    let out = text.slice(from, to);
    for (const el of nested) out = out.slice(0, el.start - from) + ' '.repeat(el.end - el.start) + out.slice(el.end - from);
    return out;
  };
  const formats = f.formats.some((p) => p >= from && p < to && !nested.some((el) => p >= el.start && p < el.end));
  if (how !== 'drawn') return { names: read(f.lx.names), formats };
  const parts = drawnParts(read(f.text)).filter((part) => !(SAID.test(part) && closing(part, part.indexOf('(')) === part.trimEnd().length - 1));
  return { names: lexed(parts.join(' ;\n')).names, formats: formats && parts.length > 0 };
}

/** The component whose body `at` is in: the innermost function named as one. */
function componentAt(f: ModuleFacts, at: number): string | null {
  let best: string | null = null;
  let size = Infinity;
  for (const [name, [from, to]] of f.ranges) {
    if (/^[A-Z]/.test(name) && at >= from && at < to && to - from < size) {
      best = name;
      size = to - from;
    }
  }
  return best;
}

/** Whether `name`, a name alone at `at` in `f`, is one of `seeds`, a
 *  function `pick` counts (its module's, or imported) or, with `props`, a prop
 *  of the component it is in given a function that writes an amount. */
function isWriter(name: string, member: string | undefined, f: ModuleFacts, at: number, pick: Pick, seeds: readonly string[], props: boolean): boolean {
  const component = props ? componentAt(f, at) : null;
  const given = (component && f.propWriters.get(component)) || new Set<string>();
  if (!member && (seeds.includes(name) || given.has(name) || (f.ranges.has(name) && pick(f.file, name)))) return true;
  if (member && given.has(member)) return true;
  const b = member ? f.bindings.get(`${name}.*`) : f.bindings.get(name);
  return !!b && pick(b.file, member ?? b.name);
}

/**
 * Whether `names` (from at `at` in `f`) calls a writer (isWriter), or hands
 * one on uncalled to a call (`.map(fmt)`, `note(t, fmt)`): kept uncalled
 * (`{ money: fmt }`), it writes nothing yet.
 */
function usesWriter(names: string, f: ModuleFacts, at: number, pick: Pick, seeds: readonly string[], props: boolean): boolean {
  for (const c of names.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*\??\.\s*([\w$]+))?(\s*\()?/g)) {
    const [, name, member, call] = c;
    const handed = !call && /[(,]$/.test(names.slice(0, c.index!).trimEnd());
    if ((call || handed) && isWriter(name, member, f, at, pick, seeds, props)) return true;
  }
  return false;
}

/** Whether `names`, at `at` in `f`, reads a variable or a component's prop
 *  given an amount. */
function readsAmount(names: string, f: ModuleFacts, at: number): boolean {
  const component = componentAt(f, at);
  const seen = [...f.amountVars.filter((v) => at >= v.from && at < v.to).map((v) => v.name), ...((component && f.propAmounts.get(component)) || [])];
  return seen.some((name) => new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(names));
}

/** Whether [from, to) of `f`, as `how` reads it, writes an amount (see WHAT
 *  IT TAKES FOR AN AMOUNT), through the functions `pick` counts. */
function writesAmount(f: ModuleFacts, from: number, to: number, pick: Pick, how: Reading): boolean {
  const r = region(f, from, to, how);
  return r.formats || usesWriter(r.names, f, from, pick, FORMATTERS, true) || readsAmount(r.names, f, from);
}

/** Whether [from, to) of `f`, as `how` reads it, writes a field's figures. */
function writesFieldFigures(f: ModuleFacts, from: number, to: number, model: Model, how: Reading): boolean {
  return usesWriter(region(f, from, to, how).names, f, from, fieldPick(model), FIELD_WRITERS, false);
}

/** The variables of `f` given an amount, with where each can be read. */
function amountVarsOf(f: ModuleFacts, model: Model): AmountVar[] {
  const out: AmountVar[] = [];
  for (const m of f.lx.names.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=(?![=>])/g)) {
    const from = m.index! + m[0].length;
    const end = statementEnd(f.lx, from);
    if (ARROW.test(f.lx.names.slice(from, end))) continue; // a function, not a value
    if (!writesAmount(f, from, end, textPick(model), 'drawn')) continue;
    let to = f.text.length;
    for (const [open, close] of f.jsx.blocks) if (open < m.index! && close > m.index! && close < to) to = close;
    out.push({ name: m[1], from: m.index!, to });
  }
  return out;
}

/** The component an element names, and the module it is in. */
function componentOf(f: ModuleFacts, name: string, model: Model): { target: ModuleFacts; component: string } | null {
  if (!/^[A-Z]/.test(name) || name.includes('.')) return null;
  if (f.ranges.has(name)) return { target: f, component: name };
  const b = f.bindings.get(name);
  const target = b && model.byFile.get(b.file);
  if (!b || !target) return null;
  const component = b.name === 'default' ? defaultExportOf(target.text) : b.name;
  return component && target.ranges.has(component) ? { target, component } : null;
}

const add = (map: Map<string, Set<string>>, key: string, value: string): boolean => {
  const set = map.get(key) ?? new Set<string>();
  if (set.has(value)) return false;
  map.set(key, set.add(value));
  return true;
};

const models = new Map<string, Model>();

/**
 * What every module writes, worked out together to a fixed point: its
 * functions that write an amount or a field's figures, the props of its
 * components given a function that writes one or an amount, and its
 * variables given one. `modules` are files relative to `root`.
 */
function modelOf(root: string, modules: readonly string[]): Model {
  const key = `${root}\n${modules.join('\n')}`;
  const known = models.get(key);
  if (known) return known;
  const facts: ModuleFacts[] = modules.map((m) => {
    const file = join(root, m);
    // A module without JSX has only code: a "<" in it is never an element.
    const lx = lex(readFileSync(file, 'utf8').replace(/\r/g, ''), m.endsWith('.tsx'));
    return {
      file,
      lx,
      text: lx.code,
      jsx: lx.jsx,
      // lib/format.ts writes amounts with the switch: how it formats a number is its own.
      formats: m === 'lib/format.ts' ? [] : numberFormats(lx),
      ranges: functionRanges(lx),
      bindings: bindingsOf(root, file, lx.code),
      writers: new Set<string>(),
      fieldWriters: new Set<string>(),
      propWriters: new Map(),
      propAmounts: new Map(),
      amountVars: [],
    };
  });
  const model: Model = {
    facts,
    byFile: new Map(facts.map((f) => [f.file, f])),
    writers: new Map(facts.map((f) => [f.file, f.writers])),
    fieldWriters: new Map(facts.map((f) => [f.file, f.fieldWriters])),
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of facts) {
      for (const [name, [from, to]] of f.ranges) {
        if (!f.writers.has(name) && writesAmount(f, from, to, amountPick(model), 'all')) f.writers.add(name), (changed = true);
        if (!f.fieldWriters.has(name) && writesFieldFigures(f, from, to, model, 'all')) f.fieldWriters.add(name), (changed = true);
      }
      // What it re-exports under its own name.
      for (const [local, b] of f.bindings) {
        const target = model.byFile.get(b.file);
        if (!target || b.name === '*' || !new RegExp(`export\\s*\\{[^}]*\\b${local}\\b`).test(f.text)) continue;
        if (!f.writers.has(local) && target.writers.has(b.name)) f.writers.add(local), (changed = true);
        if (!f.fieldWriters.has(local) && target.fieldWriters.has(b.name)) f.fieldWriters.add(local), (changed = true);
      }
      const vars = amountVarsOf(f, model);
      if (vars.length !== f.amountVars.length) (f.amountVars = vars), (changed = true);
      // What its elements give the components they name.
      for (const x of f.jsx.exprs) {
        if (!x.attr || x.attr === '...' || x.attr === 'key') continue;
        const to = componentOf(f, x.element.name, model);
        if (!to) continue;
        const r = region(f, x.open + 1, x.close, 'own');
        const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(r.names)?.[1];
        if (ARROW.test(r.names) || bare) {
          // A function that writes an amount, handed on: an arrow that writes one, or one named.
          const writes = bare ? isWriter(bare, undefined, f, x.open, textPick(model), FORMATTERS, true) : writesAmount(f, x.open + 1, x.close, textPick(model), 'own');
          if (writes && add(to.target.propWriters, to.component, x.attr)) changed = true;
          if (bare && readsAmount(r.names, f, x.open) && add(to.target.propAmounts, to.component, x.attr)) changed = true;
        } else if (writesAmount(f, x.open + 1, x.close, textPick(model), 'drawn') && add(to.target.propAmounts, to.component, x.attr)) changed = true;
      }
    }
  }
  models.set(key, model);
  return model;
}

/**
 * The functions that write an amount, by module: those calling a formatter
 * (FORMATTERS), formatting one past it, calling or handing on another that
 * writes one (in their module or imported, or a prop given one), or reading a
 * variable or prop given one, to a fixed point. `modules` are files relative
 * to `root`.
 */
export function amountWriters(root: string, modules: readonly string[]): Map<string, Set<string>> {
  return modelOf(root, modules).writers;
}

export type StaleMemo = { file: string; line: number; text: string };

/**
 * Each place that keeps an amount it wrote where the switch can't change it:
 * a useMemo whose callback writes one without the switch in its dependencies
 * (a value from useAmountsHidden()), a component wrapped in memo() that
 * writes one without reading the switch, and a useState starting from one.
 */
export function staleMemos(root: string, modules: readonly string[]): StaleMemo[] {
  const model = modelOf(root, modules);
  const out: StaleMemo[] = [];
  for (const [i, m] of modules.entries()) {
    const f = model.facts[i];
    const text = f.text;
    const flags = [...text.matchAll(/\bconst\s+(\w+)\s*=\s*useAmountsHidden\(\)/g)].map((x) => x[1]);
    const report = (at: number) => out.push({ file: m, line: lineOf(text, at), text: lineText(text, at) });
    for (const call of f.lx.names.matchAll(/\b(useMemo|useState|memo)\s*(?:<[^()]*>)?\s*\(/g)) {
      const open = call.index! + call[0].length - 1;
      const end = closing(f.lx, open);
      if (end < 0) continue;
      const args = text.slice(open + 1, end);
      const writes = (from: number, to: number) => {
        const r = region(f, from, to, 'all');
        return r.formats || usesWriter(r.names, f, from, amountPick(model), FORMATTERS, true);
      };
      if (call[1] === 'useMemo') {
        const deps = args.match(/\[([^[\]]*)\]\s*$/)?.[1] ?? '';
        if (writes(open + 1, end - deps.length) && !flags.some((flag) => new RegExp(`\\b${flag}\\b`).test(deps))) report(call.index!);
      } else if (call[1] === 'useState') {
        if (/^\s*\(\s*\)\s*=>/.test(args) && writes(open + 1, end)) report(call.index!);
      } else if (writes(open + 1, end) && !/\buseAmountsHidden\(\)/.test(args)) {
        report(call.index!);
      }
    }
  }
  return out;
}

export type Unspoken = { file: string; line: number; text: string };

/** The attributes a screen reader reads alone. */
const LABELS = new Set(['aria-label', 'aria-valuetext', 'title', 'alt']);

/**
 * Each label a screen reader reads alone (aria-label, aria-valuetext, title,
 * alt) built from an amount without spoken(): while amounts are hidden it
 * would be read as bullets, never as "hidden". And each built from a field's
 * figures, which it would say whatever the switch says.
 */
export function unspokenLabels(root: string, modules: readonly string[]): Unspoken[] {
  const model = modelOf(root, modules);
  const out: Unspoken[] = [];
  for (const [i, m] of modules.entries()) {
    const f = model.facts[i];
    for (const x of f.jsx.exprs) {
      if (!x.attr || !LABELS.has(x.attr)) continue;
      const said = /\b(?:spoken|spokenLabel)\(/.test(f.text.slice(x.open, x.close));
      if ((!said && writesAmount(f, x.open + 1, x.close, amountPick(model), 'drawn')) || writesFieldFigures(f, x.open + 1, x.close, model, 'drawn')) {
        const at = f.text.lastIndexOf(x.attr, x.open);
        out.push({ file: m, line: lineOf(f.text, at), text: lineText(f.text, at) });
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
 * Each amount written into the page as an element's child outside <Masked>:
 * a child expression that writes one anywhere in it (see WHAT IT TAKES FOR
 * AN AMOUNT), but through a function that builds elements of its own (a
 * table, a select), which draws its amounts itself, inside Masked. Drawn, it
 * is hidden, but a screen reader would read its bullets rather than
 * "hidden". And each child writing a field's figures, in <Masked> or not,
 * which would show them whatever the switch says.
 */
export function unmaskedChildren(root: string, modules: readonly string[]): Unspoken[] {
  const model = modelOf(root, modules);
  const out: Unspoken[] = [];
  for (const [i, m] of modules.entries()) {
    const f = model.facts[i];
    for (const x of f.jsx.exprs) {
      if (x.attr !== null) continue;
      const field = writesFieldFigures(f, x.open + 1, x.close, model, 'drawn');
      if (!field && (x.element.name === 'Masked' || PLAIN_TEXT_PARENTS.has(x.element.name))) continue;
      if (field || writesAmount(f, x.open + 1, x.close, textPick(model), 'drawn')) {
        out.push({ file: m, line: lineOf(f.text, x.open), text: lineText(f.text, x.open) });
      }
    }
  }
  return out;
}

export type Field = { file: string; line: number; text: string };

/**
 * Each field the CSS hook covers while amounts are hidden (app/globals.css,
 * "Hide amounts": an `inputMode="decimal"` field or a budget's, but not one
 * marked data-percent) that has no placeholder. `:placeholder-shown` can't
 * tell such a field is empty, so it would draw the mask in it while it holds
 * nothing: one with no example to give has NO_EXAMPLE
 * (components/HideAmounts.tsx).
 */
export function fieldsWithoutPlaceholder(root: string, modules: readonly string[]): Field[] {
  const model = modelOf(root, modules);
  const out: Field[] = [];
  for (const [i, m] of modules.entries()) {
    const f = model.facts[i];
    for (const el of f.jsx.elements) {
      if (el.name !== 'input') continue;
      const tag = f.text.slice(el.start, el.end);
      if (!/\binputMode=(?:["']decimal["']|\{\s*['"]decimal['"]\s*\})|\bbudget-input\b/.test(tag) || /\sdata-percent\b/.test(tag)) continue;
      if (!/\splaceholder=/.test(tag)) out.push({ file: m, line: lineOf(f.text, el.start), text: lineText(f.text, el.start) });
    }
  }
  return out;
}
