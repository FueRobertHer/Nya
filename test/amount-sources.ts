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
// component), or kept in a variable or an object handed on (`const names =
// { money: fmt }`), or a parameter's default; a variable or a component's
// prop given an amount (a `let` given one later, a list or a map one is put
// in, a callback's parameter given their items, what a function returns and
// what is destructured from it; a prop by the name it is renamed to, or read
// through its props), by the members that hold one; and a number
// written as one past the formatters: Intl's or toLocaleString's currency,
// fraction digits or compact notation, a "$" written by hand, toFixed,
// toPrecision, or a toLocaleString given no options, unless the code beside
// it says it is something else (saysWhatItIs). An amount drawn as text is one
// anywhere in a child expression: alone, in a template literal, a ternary or
// a list, or in a call given a formatter as a callback. A number drawn as it
// is can't be told from a count by its text: test/hide-amounts.test.tsx's
// backstop renders the views with amounts hidden for it.

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
    if (recent.size > 512) recent.delete(recent.keys().next().value!);
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

/** A number formatted as an amount without lib/format.ts: Intl's (with
 *  `new` or without) or toLocaleString's currency, fraction digits or
 *  compact notation (not a date's or a count's), toFixed, toPrecision or a
 *  toLocaleString given no options (but where the code beside it says it is
 *  something else: saysWhatItIs), or a "$" written before a figure by hand. */
const NUMBER_FORMAT = /(?<![\w$.])(?:new\s+)?Intl\.NumberFormat\s*\(/g;
const LOCALE_STRING = /\.toLocaleString\s*\(/g;
const TO_FIXED = /\.to(?:Fixed|Precision)\s*\(/g;
const AMOUNT_OPTIONS = /currency|FractionDigits|notation|style:\s*['"]currency['"]/;
const DOLLAR_BY_HAND = /`[^`]*?\$\$\{|['"]-?\$['"]\s*\+|\+\s*['"]-?\$['"]|\?\s*['"]-?\$['"]\s*:/g;

/** Where the statement around `at` starts: past the ";", "{" or "}" before
 *  it (a block before it is a statement of its own), out of the parentheses
 *  and brackets `at` is in. */
function statementStart(lx: Lexed, at: number): number {
  const t = lx.names;
  for (let i = at - 1; i >= 0; i--) {
    if (t[i] === ';' || t[i] === '{' || t[i] === '}') return i + 1;
    const open = lx.pairs.get(i);
    if (open !== undefined && open < i) i = open;
  }
  return 0;
}

/**
 * A number formatted as an amount at `at` is guarded when the mask is written
 * in its place while amounts are hidden: its figure goes through
 * hiddenFigure or hiddenMoney (it is in their call, or a "$" by hand is
 * followed by one), its own statement chooses by the switch (`amountsHidden()
 * ? ...`), or the function it is in has returned before it when amounts are
 * hidden (`if (amountsHidden()) return ...`). Nothing else in the function
 * says anything of it.
 */
function guarded(lx: Lexed, ranges: Map<string, [number, number]>, at: number): boolean {
  const t = lx.names;
  if (/^`[^`]*?\$\$\{\s*(?:hiddenFigure|hiddenMoney)\s*\(/.test(lx.code.slice(at))) return true;
  for (const m of t.matchAll(/(?<![\w$.])(?:hiddenFigure|hiddenMoney)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    if (open < at && at < closing(lx, open)) return true;
  }
  if (/\bamountsHidden\(\)/.test(t.slice(statementStart(lx, at), at))) return true;
  let fn: [number, number] | null = null;
  for (const r of ranges.values()) if (r[0] <= at && at < r[1] && (!fn || r[1] - r[0] < fn[1] - fn[0])) fn = r;
  if (!fn) return false;
  // The body of the function it is in, a callback written inside one too.
  const outer = bodyIn(lx, fn[0], fn[1]);
  let own: [number, number] | null = outer?.block ? [outer.from, outer.to] : null;
  for (const b of innerBodies(lx, fn[0], fn[1])) if (b[0] <= at && at < b[1] && (!own || b[0] > own[0])) own = b;
  if (!own) return false;
  // Its own early return, at the top of that body: not one inside another
  // function, nor one a condition of its own may pass by.
  for (const m of t.slice(own[0], at).matchAll(/\bif\s*\(\s*amountsHidden\(\)\s*\)\s*\{?\s*return\b/g)) {
    const p = own[0] + m.index!;
    let block: [number, number] | null = null;
    for (const b of lx.jsx.blocks) if (b[0] < p && p < b[1] && (!block || b[0] > block[0])) block = b;
    if (block?.[0] === own[0] - 1) return true;
  }
  return false;
}

/** Whether `at` is in what an element draws: its innermost JSX expression
 *  is a child's, or a label's a screen reader reads (LABELS). */
function drawnAt(lx: Lexed, at: number): boolean {
  let inner: JsxExpr | null = null;
  for (const x of lx.jsx.exprs) if (x.open < at && at < x.close && (!inner || x.open > inner.open)) inner = x;
  return !!inner && (inner.attr === null || LABELS.has(inner.attr));
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

/** Where the text after a word ends: a template's or a tag's end, or a
 *  sentence's punctuation. */
const ENDS = '(?=[\\s\\u00a0]*(?:[`\'"<.,;:)}]|$))';
/** What the app writes after a count ("3 rows", "3 of them", "3 more not
 *  listed"), each phrase whole: what it counts, or how its sentence goes on.
 *  A number followed by anything else is taken for an amount ("40 spent",
 *  "40 dollars", "40 a month"), and so is one followed by words that only
 *  begin as one of these phrases does ("40 still owed", "40 of the goal",
 *  "40 more to save", "40 to go"). A word that counts nothing ("more",
 *  "new") is a phrase alone only where it ends the text ("and 3 more"). A
 *  count said some other way goes through plainNumber. */
const COUNT_WORDS = new RegExp(
  String.raw`^\s+(?:` +
    [
      // What it counts.
      String.raw`(?:accounts?|categor(?:y|ies)|characters?|days?|files?|lines?|months?|parts?|rows?|rules?|runs?|starts?|tags?|transactions?|years?)\b`,
      // How its sentence goes on.
      String.raw`already (?:imported|there|in (?:Nya\b|\$\{))`,
      String.raw`an earlier file brought\b`,
      String.raw`end tags?\b`,
      String.raw`kept (?:as (?:the bank’s|your banks’|rows an earlier file|they were|\$\{[^}]*\}’s own)|for a later import)`,
      String.raw`listed twice in the file\b`,
      String.raw`more(?: not listed\b|${ENDS})`,
      String.raw`new${ENDS}`,
      String.raw`of (?:them|the transactions this file adds|your stored transactions?|\$\{\w+\}’s transactions|its lines|this file)\b`,
      String.raw`opening balances and balance adjustments\b`,
      String.raw`put back as\b`,
      String.raw`skipped${ENDS}`,
      String.raw`still stored\b`,
      String.raw`tagged${ENDS}`,
      String.raw`to (?:answer|update)\b`,
      String.raw`updated(?: from the file\b|${ENDS})`,
      String.raw`with no category\b`,
    ].join('|') +
    ')'
);

/**
 * Whether the code beside a number written with toFixed or toPrecision, or
 * with a toLocaleString given no options, says it is no amount: a percentage
 * (a "%" after it, or a fraction made one by a hundred), a size or a time
 * after it, a drawn shape's coordinate, a color's channel, or a number
 * rounded as a number (in Number(...), but not drawn as it is: drawnAt); and,
 * for toLocaleString, a count (followed by one of the words the app writes
 * after a count, COUNT_WORDS, each phrase whole, or by its noun chosen by
 * it, or a length) or a date. Anything else is taken for an amount.
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
  if (/\bNumber\($/.test(before) && text[end + 1] === ')' && !drawnAt(lx, dot)) return true;
  if (method !== 'toLocaleString') return false;
  if (COUNT_WORDS.test(after)) return true;
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
    const { ranges } = functionRanges(lx);
    const lines = new Set<number>();
    for (const at of numberFormats(lx)) {
      const line = lineOf(text, at);
      if (guarded(lx, ranges, at) || lines.has(line)) continue;
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

/** Each function a module defines, by name, with where its body is (a
 *  function's braces, or a const's arrow to the end of its statement), and
 *  where its parameters are, inside their parentheses. */
function functionRanges(lx: Lexed): { ranges: Map<string, [number, number]>; params: Map<string, [number, number]> } {
  const ranges = new Map<string, [number, number]>();
  const params = new Map<string, [number, number]>();
  for (const m of lx.names.matchAll(/\bfunction\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const paramsEnd = closing(lx, open);
    const body = paramsEnd < 0 ? -1 : bodyOpen(lx, paramsEnd);
    const end = body < 0 ? -1 : closing(lx, body);
    if (end > 0) ranges.set(m[1], [body, end + 1]), params.set(m[1], [open + 1, paramsEnd]);
  }
  for (const m of lx.names.matchAll(/\bconst\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(\(|\w+\s*=>)/g)) {
    if (ranges.has(m[1])) continue;
    ranges.set(m[1], [m.index!, statementEnd(lx, m.index!)]);
    const open = m.index! + m[0].length - m[2].length;
    const close = m[2] === '(' ? closing(lx, open) : -1;
    if (close > 0) params.set(m[1], [open + 1, close]);
  }
  return { ranges, params };
}

/** The ranges of the parts of [from, to) of a module separated by commas at
 *  its outermost level: a call's arguments, a function's parameters. */
function partsOf(lx: Lexed, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let start = from;
  for (let i = from; i < to; i++) {
    const past = lx.opaque.get(i) ?? lx.elementEnd.get(i);
    const pair = lx.pairs.get(i);
    if (past !== undefined) i = past - 1;
    else if (pair !== undefined && pair > i) i = pair;
    else if (lx.code[i] === ',') out.push([start, i]), (start = i + 1);
  }
  if (lx.code.slice(start, to).trim()) out.push([start, to]);
  return out;
}

/** A name a binding binds; in an object pattern, the key it is bound from
 *  (an outer one's, in a pattern inside it); and its default's code, if any. */
type Binding = { name: string; key: string | null; init: string | null };

/** What a binding binds: a name, with its default; or each name of a
 *  pattern (`{ a, b: c = x, ...d }` binds a, c from b with its default x, and
 *  d; `[e, [f]]` binds e and f). Its type is left out. */
function bindingsIn(binding: string, key: string | null = null): Binding[] {
  let b = binding.trim().replace(/^\.\.\./, '').trim();
  const isEq = (e: string, i: number) => e[i] === '=' && e[i + 1] !== '=' && e[i + 1] !== '>' && !/[=!<>]/.test(e[i - 1] ?? '');
  const eq = topLevel(b).find((i) => isEq(b, i));
  const init = eq === undefined ? null : b.slice(eq + 1).trim();
  if (eq !== undefined) b = b.slice(0, eq).trim();
  if (b[0] !== '{' && b[0] !== '[') {
    const name = /^[A-Za-z_$][\w$]*/.exec(b)?.[0];
    return name ? [{ name, key, init }] : [];
  }
  const close = closing(b, 0);
  if (close < 0) return [];
  const inner = b.slice(1, close);
  const out: Binding[] = [];
  let from = 0;
  for (const cut of [...topLevel(inner).filter((i) => inner[i] === ','), inner.length]) {
    let part = inner.slice(from, cut);
    from = cut + 1;
    let own = key;
    if (b[0] === '{') {
      // `key: binding`, but not a default's own colon (a ternary's).
      const top = topLevel(part);
      const colon = top.find((i) => part[i] === ':');
      const def = top.find((i) => isEq(part, i));
      const named = colon !== undefined && (def === undefined || colon < def);
      // A rest element holds what the others don't: all the value has.
      if (!/^\s*\.\.\./.test(part)) own ??= /^\s*['"]?([\w$-]+)/.exec(named ? part.slice(0, colon) : part)?.[1] ?? null;
      if (named) part = part.slice(colon + 1);
    }
    out.push(...bindingsIn(part, own));
  }
  return out;
}

/** A function's parameter as written, and what it binds. */
type Param = { text: string; bindings: Binding[] };

/** The parameters of a function written at [from, to) of a module (an arrow
 *  function, or a function expression), or null when what is there is no
 *  function written there (a name, a call, a value). */
function paramsAt(lx: Lexed, from: number, to: number): Param[] | null {
  const t = lx.names;
  let i = from;
  while (i < to && /\s/.test(t[i])) i++;
  if (/^async\b/.test(t.slice(i, i + 6))) i += 5;
  while (i < to && /\s/.test(t[i])) i++;
  const list = (open: number, close: number) =>
    partsOf(lx, open + 1, close).map(([a, b]) => ({ text: lx.code.slice(a, b).trim(), bindings: bindingsIn(lx.code.slice(a, b)) }));
  if (/^function\b/.test(t.slice(i, i + 9))) {
    const open = t.indexOf('(', i);
    const close = open < 0 || open >= to ? -1 : closing(lx, open);
    return close < 0 ? null : list(open, close);
  }
  if (t[i] === '(') {
    const close = closing(lx, i);
    // An arrow's parameters: "=>" after them, past a return type.
    return close > 0 && close < to && /^\s*(?::[^=]*)?=>/.test(t.slice(close + 1, to)) ? list(i, close) : null;
  }
  const one = /^([A-Za-z_$][\w$]*)\s*=>/.exec(t.slice(i, to));
  return one ? [{ text: one[1], bindings: [{ name: one[1], key: null, init: null }] }] : null;
}

/** The indexes of [from, to) of a module at its outermost level: in no
 *  bracket, string, template, regular expression or element. */
function topLevelIn(lx: Lexed, from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) {
    const past = lx.opaque.get(i) ?? lx.elementEnd.get(i);
    const pair = lx.pairs.get(i);
    if (past !== undefined) i = past - 1;
    else if (pair !== undefined) i = Math.max(i, pair);
    else out.push(i);
  }
  return out;
}

/** The body of the function written at [from, to) of a module: a block's
 *  inside, or an arrow's expression; null when none is written there. */
function bodyIn(lx: Lexed, from: number, to: number): { block: boolean; from: number; to: number } | null {
  const t = lx.names;
  let i = from;
  while (i < to && /\s/.test(t[i])) i++;
  const block = (open: number) => {
    const close = closing(lx, open);
    return close > 0 && close <= to ? { block: true, from: open + 1, to: close } : null;
  };
  if (t[i] === '{') return block(i);
  if (/^(?:async\s+)?function\b/.test(t.slice(i, i + 15))) {
    const params = closing(lx, t.indexOf('(', i));
    const open = params < 0 ? -1 : bodyOpen(lx, params);
    return open < 0 ? null : block(open);
  }
  const arrow = topLevelIn(lx, i, to).find((k) => t[k] === '=' && t[k + 1] === '>');
  if (arrow === undefined) return null;
  let j = arrow + 2;
  while (j < to && /\s/.test(t[j])) j++;
  return t[j] === '{' ? block(j) : { block: false, from: j, to };
}

/** The blocks of the functions written in [from, to) of a module. */
function innerBodies(lx: Lexed, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (const m of lx.names.slice(from, to).matchAll(/=>|\bfunction\b/g)) {
    const body = bodyIn(lx, from + m.index!, to);
    if (body?.block) out.push([body.from, body.to]);
  }
  return out;
}

/** Where each return of a function's block [from, to) gives its value: its
 *  own, not those of a function written inside it. */
function ownReturns(lx: Lexed, from: number, to: number): [number, number][] {
  const inner = innerBodies(lx, from, to);
  const out: [number, number][] = [];
  for (const m of lx.names.slice(from, to).matchAll(/(?<![\w$.])return\b/g)) {
    const at = from + m.index!;
    if (inner.some(([a, b]) => at >= a && at < b)) continue;
    out.push([at + m[0].length, statementEnd(lx, at + m[0].length)]);
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

/** What of a value holds an amount: all of it (null), or only these of its
 *  members (an object's, or the items' of a list). */
type Holds = ReadonlySet<string> | null;

/** Two answers to what of a value holds an amount (false: none), together. */
function joined(a: Holds | false, b: Holds | false): Holds | false {
  if (a === false) return b;
  if (b === false || a === null) return a;
  return b === null ? null : new Set([...a, ...b]);
}

const sameHolds = (a: Holds | false, b: Holds | false) => a === b || (a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((m) => b.has(m)));

/** A variable given an amount (`members`: what of it holds one), or holding
 *  a function that writes one, and where it can be read: from its
 *  declaration to the end of the block it is in (a callback's parameter: in
 *  the callback). */
type AmountVar = { name: string; from: number; to: number; members: Holds };

type ModuleFacts = {
  file: string;
  lx: Lexed;
  /** Its text, without its comments (lx.code). */
  text: string;
  jsx: Jsx;
  /** Where it formats a number as an amount (numberFormats). */
  formats: number[];
  ranges: Map<string, [number, number]>;
  params: Map<string, [number, number]>;
  bindings: Map<string, { file: string; name: string }>;
  /** Its functions that write an amount, and those that write a field's figures. */
  writers: Set<string>;
  fieldWriters: Set<string>;
  /** Of each of its components, the props given a function that writes an
   *  amount, and the props given an amount. */
  propWriters: Map<string, Set<string>>;
  propAmounts: Map<string, Set<string>>;
  amountVars: AmountVar[];
  /** Its variables holding a function that writes an amount: one given a
   *  writer (`const money = formatMoney`), or an object holding one
   *  (`{ money: size }`); and the parameters whose default is one. */
  writerVars: AmountVar[];
  /** Of each of its functions writing an amount, what of what it returns
   *  holds one (holdsOf). */
  returns: Map<string, Holds | false>;
  /** What region() and componentAt() found, by where. */
  regions: Map<string, { names: string; formats: boolean }>;
  components: Map<number, string | null>;
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
  // The text alone decides it: kept, as the same regions are read on each round.
  const key = `${from}:${to}:${how}`;
  let r = f.regions.get(key);
  if (!r) f.regions.set(key, (r = readRegion(f, from, to, how)));
  return r;
}

function readRegion(f: ModuleFacts, from: number, to: number, how: Reading): { names: string; formats: boolean } {
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
  const known = f.components.get(at);
  if (known !== undefined) return known;
  let best: string | null = null;
  let size = Infinity;
  for (const [name, [from, to]] of f.ranges) {
    if (/^[A-Z]/.test(name) && at >= from && at < to && to - from < size) {
      best = name;
      size = to - from;
    }
  }
  f.components.set(at, best);
  return best;
}

/** Whether `name` (or its `member`), at `at` in `f`, is one of `seeds`, a
 *  function `pick` counts (its module's, or imported) or, with `props`, a
 *  variable holding a function that writes an amount, or a prop of the
 *  component it is in given one. */
function isWriter(name: string, member: string | undefined, f: ModuleFacts, at: number, pick: Pick, seeds: readonly string[], props: boolean): boolean {
  const component = props ? componentAt(f, at) : null;
  const given = (component && f.propWriters.get(component)) || new Set<string>();
  // Each prop by the name the component's body reads it by.
  const { local } = component ? propNamesOf(f, component) : NO_PROP_NAMES;
  const read = new Set([...given].flatMap((key) => local.get(key) ?? [key]));
  const held = props && f.writerVars.some((v) => v.name === name && at >= v.from && at < v.to);
  if (!member && (seeds.includes(name) || read.has(name) || held || (f.ranges.has(name) && pick(f.file, name)))) return true;
  if (member && (given.has(member) || read.has(name) || held)) return true;
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

const escaped = (name: string) => name.replace(/\$/g, '\\$');

/** `name` read in code: not as another's member (`x.name`), but spread
 *  (`...name`) or alone; then the member read of it, if any. */
const readOf = (name: string) => new RegExp(`(?:(?<=\\.\\.\\.)|(?<![\\w$.]))${escaped(name)}(?![\\w$])(?:\\s*\\??\\.\\s*([\\w$]+))?`, 'g');

/** Whether `names`, at `at` in `f`, reads a variable or a component's prop
 *  given an amount: of a variable holding one in some members only, one of
 *  those, or all of it. */
function readsAmount(names: string, f: ModuleFacts, at: number): boolean {
  for (const v of f.amountVars) {
    if (at < v.from || at >= v.to) continue;
    for (const m of names.matchAll(readOf(v.name))) if (!v.members || !m[1] || v.members.has(m[1])) return true;
  }
  const component = componentAt(f, at);
  const given = component && f.propAmounts.get(component);
  if (!given) return false;
  const { local, whole } = propNamesOf(f, component!);
  for (const key of given) {
    if ((local.get(key) ?? [key]).some((name) => readOf(name).test(names))) return true;
    if (whole && new RegExp(`(?<![\\w$.])${escaped(whole)}\\s*\\??\\.\\s*${escaped(key)}(?![\\w$])`).test(names)) return true;
  }
  return false;
}

/** The names a component's body reads its props by: each by its own, or by
 *  the one it is renamed to where they are destructured (`{ label: text }`);
 *  and, when they aren't, the name they are read through (`props.label`). */
type PropNames = { local: Map<string, string[]>; whole: string | null };
const NO_PROP_NAMES: PropNames = { local: new Map(), whole: null };
const propNames = new WeakMap<ModuleFacts, Map<string, PropNames>>();

function propNamesOf(f: ModuleFacts, component: string): PropNames {
  const known = propNames.get(f) ?? new Map<string, PropNames>();
  propNames.set(f, known);
  let out = known.get(component);
  if (out) return out;
  const params = f.params.get(component);
  const [first] = params ? partsOf(f.lx, ...params) : [];
  const text = first ? f.lx.code.slice(...first).trim() : '';
  out = { local: new Map(), whole: null };
  if (text.startsWith('{')) for (const b of bindingsIn(text)) b.key && out.local.set(b.key, [...(out.local.get(b.key) ?? []), b.name]);
  else out.whole = /^[A-Za-z_$][\w$]*/.exec(text)?.[0] ?? null;
  known.set(component, out);
  return out;
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

/** A module's declarations: the names each binds (`pattern`, the "{" or
 *  "[" of a destructuring), where it is, where it can be read (to its
 *  block's end), and where its value is, if it is given one. */
type Declaration = { names: Binding[]; pattern: string | null; at: number; to: number; kind: string; init: [number, number] | null };

function declarationsOf(f: ModuleFacts): Declaration[] {
  const { lx } = f;
  const t = lx.names;
  const out: Declaration[] = [];
  for (const m of t.matchAll(/\b(const|let|var)\s+/g)) {
    const at = m.index!;
    const start = at + m[0].length;
    let end = start;
    let names: Binding[];
    const pattern = t[start] === '{' || t[start] === '[' ? t[start] : null;
    if (pattern) {
      const close = closing(lx, start);
      if (close < 0) continue;
      names = bindingsIn(lx.code.slice(start, close + 1));
      end = close + 1;
    } else {
      const name = /^[A-Za-z_$][\w$]*/.exec(t.slice(start, start + 100))?.[0];
      if (!name) continue;
      names = [{ name, key: null, init: null }];
      end = start + name.length;
    }
    let to = t.length;
    for (const [open, close] of f.jsx.blocks) if (open < at && close > at && close < to) to = close;
    // Its value: past its type, after "=".
    const eq = /^\s*(?::[^=;\n]+)?=(?![=>])/.exec(t.slice(end, end + 300));
    const init: [number, number] | null = eq ? [end + eq[0].length, statementEnd(lx, end + eq[0].length)] : null;
    out.push({ names, pattern, at, to, kind: m[1], init });
  }
  return out;
}

/** The methods giving a list's own items, or one of them. */
const SAME_ITEMS = /^(?:filter|slice|sort|toSorted|toReversed|reverse|concat|find|findLast|at|flat)$/;

/**
 * What of the value at [from, to) of `f` holds an amount (Holds), or false
 * for none: of an object written there, its members given one; of a list
 * written there, its items'; of a variable given one, what of it does; of a
 * member of one, all of it, when that member holds one; of a list's own
 * items (filter, sort, find...), the list's; of what .map gives, what its
 * callback returns; of useMemo's value, what its callback returns; of a call
 * of a function the model knows that writes one, what it returns; and of
 * anything else that writes one, all of it.
 */
function holdsOf(f: ModuleFacts, from: number, to: number, model: Model): Holds | false {
  const { lx } = f;
  const t = lx.names;
  let a = from;
  let b = to;
  while (a < b && /\s/.test(lx.code[a])) a++;
  while (b > a && /[\s;,]/.test(lx.code[b - 1])) b--;
  if (a >= b) return false;
  const whole = (): Holds | false => (writesAmount(f, a, b, textPick(model), 'drawn') ? null : false);
  // A string or a template: all of it, if it writes one.
  if (/['"`]/.test(lx.code[a])) return whole();
  const awaited = /^await\s+/.exec(t.slice(a, b));
  if (awaited) return holdsOf(f, a + awaited[0].length, b, model);
  if (t[b - 1] === '!') return holdsOf(f, a, b - 1, model);
  const top = topLevelIn(lx, a, b);
  const cast = top.find((i) => /^\sas\s/.test(t.slice(i, i + 4)) || /^\ssatisfies\s/.test(t.slice(i, i + 11)));
  if (cast !== undefined) return holdsOf(f, a, cast, model);
  // A ternary's branches, not its test; each side of || and ??; the last of
  // a run of && (one before it is given when falsy: nothing).
  const q = top.find((i) => isQuestion(t, i));
  if (q !== undefined) {
    let nest = 0;
    const colon = top.find((i) => i > q && (isQuestion(t, i) ? (nest++, false) : t[i] === ':' && nest-- === 0));
    return colon === undefined ? whole() : joined(holdsOf(f, q + 1, colon, model), holdsOf(f, colon + 1, b, model));
  }
  const or = top.find((i) => /^(?:\|\||\?\?)/.test(t.slice(i, i + 2)));
  if (or !== undefined) return joined(holdsOf(f, a, or, model), holdsOf(f, or + 2, b, model));
  const and = top.findLast((i) => t.startsWith('&&', i));
  if (and !== undefined) return holdsOf(f, and + 2, b, model);
  if (lx.pairs.get(a) === b - 1) {
    if (t[a] === '(') return holdsOf(f, a + 1, b - 1, model);
    if (t[a] === '{') return objectHolds(f, a, b, model);
    if (t[a] === '[') {
      let out: Holds | false = false;
      for (const [p, q] of partsOf(lx, a + 1, b - 1)) {
        const spread = /^\s*\.\.\./.exec(t.slice(p, q));
        out = joined(out, holdsOf(f, spread ? p + spread[0].length : p, q, model));
      }
      return out;
    }
  }
  const open = t[b - 1] === ')' || t[b - 1] === ']' ? lx.pairs.get(b - 1) : undefined;
  if (open !== undefined && open > a) {
    // An item of a list.
    if (t[b - 1] === ']') return holdsOf(f, a, open, model);
    const callee = t.slice(a, open);
    const method = /\??\.\s*([\w$]+)\s*$/.exec(callee);
    if (method && SAME_ITEMS.test(method[1])) return holdsOf(f, a, a + method.index!, model);
    if (method && /^(?:map|flatMap)$/.test(method[1])) {
      const [callback] = partsOf(lx, open + 1, b - 1);
      return callback ? returnsHold(f, callback[0], callback[1], model) : false;
    }
    const fn = method ? null : /^([A-Za-z_$][\w$]*)\s*(?:<[^()]*>)?\s*$/.exec(callee)?.[1];
    if (fn === 'useMemo') {
      const [callback] = partsOf(lx, open + 1, b - 1);
      return callback ? returnsHold(f, callback[0], callback[1], model) : false;
    }
    const known = fn ? returnsOfCall(f, fn, model) : undefined;
    return known === undefined || known === false ? whole() : known;
  }
  const ref = /^([A-Za-z_$][\w$]*)(?:\s*\??\.\s*([A-Za-z_$][\w$]*))?$/.exec(t.slice(a, b));
  const v = ref && f.amountVars.findLast((v) => v.name === ref[1] && a >= v.from && a < v.to);
  if (v) return !ref[2] ? v.members : !v.members || v.members.has(ref[2]) ? null : false;
  return whole();
}

/** What of an object written at [a, b) of `f` (its braces) holds an amount:
 *  its members given one, and what a spread of one brings. */
function objectHolds(f: ModuleFacts, a: number, b: number, model: Model): Holds | false {
  const { lx } = f;
  const members = new Set<string>();
  for (const [p, q] of partsOf(lx, a + 1, b - 1)) {
    const spread = /^\s*\.\.\./.exec(lx.names.slice(p, q));
    if (spread) {
      const h = holdsOf(f, p + spread[0].length, q, model);
      if (h === null) return null;
      if (h) for (const m of h) members.add(m);
      continue;
    }
    const colon = topLevelIn(lx, p, q).find((i) => lx.names[i] === ':');
    // `key: value` or `key`; a method or a computed key holds no figure written here.
    const key = /^\s*(?:['"]([^'"]*)['"]|([A-Za-z_$][\w$]*))\s*$/.exec(lx.code.slice(p, colon ?? q));
    if (key && holdsOf(f, colon === undefined ? p : colon + 1, q, model) !== false) members.add(key[1] ?? key[2]);
  }
  return members.size > 0 ? members : false;
}

/** What of what the function written at [from, to) of `f` returns holds an
 *  amount: its expression's, or its own returns'; a function named, as a
 *  call of it. */
function returnsHold(f: ModuleFacts, from: number, to: number, model: Model): Holds | false {
  const body = bodyIn(f.lx, from, to);
  if (!body) {
    const name = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(f.lx.names.slice(from, to))?.[1];
    return name && isWriter(name, undefined, f, from, textPick(model), FORMATTERS, true) ? null : false;
  }
  if (!body.block) return holdsOf(f, body.from, body.to, model);
  let out: Holds | false = false;
  for (const [p, q] of ownReturns(f.lx, body.from, body.to)) out = joined(out, holdsOf(f, p, q, model));
  return out;
}

/** What of what a call of `name`, in `f`, returns holds an amount, when it
 *  is a function the model knows (its module's, or imported) that writes
 *  one. */
function returnsOfCall(f: ModuleFacts, name: string, model: Model): Holds | false | undefined {
  if (f.ranges.has(name)) return f.returns.get(name);
  const b = f.bindings.get(name);
  const target = b && model.byFile.get(b.file);
  const fn = target && (b.name === 'default' ? defaultExportOf(target.text) : b.name);
  return fn ? target.returns.get(fn) : undefined;
}

/** The methods whose callback is given a list's items, or a map's. */
const ITEM_CALLBACKS = /\.\s*(map|flatMap|filter|find|findLast|forEach|some|every|reduce|sort|toSorted)\s*\(/g;

/**
 * The variables of `f` given an amount, with where each can be read, and
 * what of each holds one (holdsOf): one declared with one, or a `let` given
 * one later; a list or a map one is put in (push, unshift, set, add); and
 * the parameters of a callback given a list's items holding one (.map,
 * .filter, .forEach...), or a for...of's over one. What a destructuring
 * binds holds one when the member it is bound from does.
 */
function amountVarsOf(f: ModuleFacts, model: Model, declared: Declaration[]): AmountVar[] {
  const { lx } = f;
  const t = lx.names;
  const holds = (from: number, to: number) => holdsOf(f, from, to, model);
  const out: AmountVar[] = [];
  const give = (name: string, from: number, to: number, h: Holds | false) => {
    if (h === false) return;
    const had = out.find((v) => v.name === name && v.from === from);
    if (had) had.members = joined(had.members, h) as Holds;
    else out.push({ name, from, to, members: h });
  };
  // What each binding of a value holding `h` holds, by its key in an object pattern.
  const bind = (names: readonly Binding[], pattern: string | null, from: number, to: number, h: Holds | false) => {
    for (const b of names) {
      if (pattern !== '{') give(b.name, from, to, h);
      else if (h === null || (h && b.key !== null && h.has(b.key))) give(b.name, from, to, null);
    }
  };
  const patternOf = (text: string) => (/^[{[]/.test(text) ? text[0] : null);
  // A JSX attribute's "=" is no assignment.
  const attrs = new Set(f.jsx.exprs.filter((x) => x.attr !== null).map((x) => x.open));
  for (const d of declared) {
    // A function is no value.
    if (d.init && paramsAt(lx, ...d.init) === null) bind(d.names, d.pattern, d.at, d.to, holds(...d.init));
    if (d.kind === 'const') continue;
    for (const b of d.names) {
      const rx = new RegExp(`(?<![\\w$.])${escaped(b.name)}\\s*(?:[-+*/%]|\\|\\||&&|\\?\\?)?=(?![=>])`, 'g');
      for (const a of t.slice(d.at, d.to).matchAll(rx)) {
        let from = d.at + a.index! + a[0].length;
        while (/\s/.test(t[from] ?? '')) from++;
        if (!attrs.has(from)) give(b.name, d.at, d.to, holds(from, statementEnd(lx, from)));
      }
    }
  }
  const declarationOf = (name: string, at: number) => declared.findLast((d) => d.at < at && at < d.to && d.names.some((b) => b.name === name));
  for (const m of t.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\.\s*(push|unshift|set|add)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = closing(lx, open);
    const d = close > 0 ? declarationOf(m[1], m.index!) : undefined;
    if (!d) continue;
    // A map's values; a list's or a set's items.
    let h: Holds | false = false;
    for (const [p, q] of partsOf(lx, open + 1, close).slice(m[2] === 'set' ? 1 : 0)) h = joined(h, holds(p, q));
    give(m[1], d.at, d.to, h);
  }
  for (const m of t.matchAll(ITEM_CALLBACKS)) {
    const open = m.index! + m[0].length - 1;
    const close = closing(lx, open);
    const [callback] = close > 0 ? partsOf(lx, open + 1, close) : [];
    const params = callback ? paramsAt(lx, ...callback) : null;
    if (!params?.length) continue;
    const dot = t[m.index! - 1] === '?' ? m.index! - 1 : m.index!;
    const start = receiverStart(lx, dot);
    const h = start < dot ? holds(start, dot) : false;
    if (h === false) continue;
    // The items: the first parameter, both of sort's; reduce's total too.
    const items = m[1] === 'reduce' ? [null, h] : /sort/i.test(m[1]) ? [h, h] : [h];
    items.forEach((held, k) => params[k] && bind(params[k].bindings, patternOf(params[k].text), callback[0], callback[1], held ?? null));
  }
  for (const m of t.matchAll(/\bfor\s*(?:await\s*)?\(\s*(?:const|let|var)\s+/g)) {
    const paren = t.indexOf('(', m.index!);
    const close = closing(lx, paren);
    const d = declared.find((x) => x.at > paren && x.at < close);
    const of = d && close > 0 ? /\s+of\s+/.exec(t.slice(d.at, close)) : null;
    if (!d || !of) continue;
    let body = close + 1;
    while (/\s/.test(t[body] ?? '')) body++;
    const to = t[body] === '{' ? closing(lx, body) : statementEnd(lx, body);
    bind(d.names, d.pattern, m.index!, to, holds(d.at + of.index! + of[0].length, close));
  }
  return out;
}

/**
 * The variables of `f` holding a function that writes an amount, with where
 * each can be read: one given a writer uncalled (`const money =
 * formatMoney`, `flag ? compactMoney : formatMoney`) or an object or a list
 * holding one (`{ money: size }`, `{ money: (n) => formatMoney(n, c) }`),
 * and a function's parameter whose default is one.
 */
function writerVarsOf(f: ModuleFacts, model: Model, declared: Declaration[]): AmountVar[] {
  const { lx } = f;
  const pick = amountPick(model);
  // Whether code at `at` names a writer uncalled (an object's key aside), or writes one in a function of its own.
  const holds = (names: string, at: number) =>
    [...names.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?!\s*[\w$(.])/g)].some(
      (m) => !(/^\s*:/.test(names.slice(m.index! + m[0].length)) && /[{,]\s*$/.test(names.slice(0, m.index!))) && isWriter(m[1], undefined, f, at, pick, FORMATTERS, true)
    ) ||
    (/=>|\bfunction\b/.test(names) && usesWriter(names, f, at, pick, FORMATTERS, true));
  const out: AmountVar[] = [];
  for (const d of declared) {
    if (!d.init || paramsAt(lx, ...d.init) !== null) continue;
    if (holds(lx.names.slice(...d.init), d.init[0])) for (const b of d.names) out.push({ name: b.name, from: d.at, to: d.to, members: null });
  }
  for (const [name, [from, to]] of f.params) {
    const body = f.ranges.get(name);
    if (!body) continue;
    for (const p of partsOf(lx, from, to).flatMap(([a, b]) => bindingsIn(lx.code.slice(a, b)))) {
      if (p.init && holds(lexed(p.init).names, body[0])) out.push({ name: p.name, from: body[0], to: body[1], members: null });
    }
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
      ...functionRanges(lx),
      bindings: bindingsOf(root, file, lx.code),
      writers: new Set<string>(),
      fieldWriters: new Set<string>(),
      propWriters: new Map(),
      propAmounts: new Map(),
      amountVars: [],
      writerVars: [],
      returns: new Map(),
      regions: new Map(),
      components: new Map(),
    };
  });
  const declared = new Map(facts.map((f) => [f, declarationsOf(f)]));
  const model: Model = {
    facts,
    byFile: new Map(facts.map((f) => [f.file, f])),
    writers: new Map(facts.map((f) => [f.file, f.writers])),
    fieldWriters: new Map(facts.map((f) => [f.file, f.fieldWriters])),
  };
  // Each round works a module out again only when what it reads is new
  // since the round before: its own facts, or those of a module it imports.
  const imports = new Map(facts.map((f) => [f, [...new Set([...f.bindings.values()].map((b) => model.byFile.get(b.file)))].filter((g): g is ModuleFacts => !!g && g !== f)]));
  for (let last = new Set(facts); last.size > 0; ) {
    const now = new Set<ModuleFacts>();
    for (const f of facts) {
      if (!last.has(f) && !imports.get(f)!.some((g) => last.has(g))) continue;
      for (const [name, [from, to]] of f.ranges) {
        if (!f.writers.has(name) && writesAmount(f, from, to, amountPick(model), 'all')) f.writers.add(name), now.add(f);
        if (!f.fieldWriters.has(name) && writesFieldFigures(f, from, to, model, 'all')) f.fieldWriters.add(name), now.add(f);
      }
      // What it re-exports under its own name.
      for (const [local, b] of f.bindings) {
        const target = model.byFile.get(b.file);
        if (!target || b.name === '*' || !new RegExp(`export\\s*\\{[^}]*\\b${local}\\b`).test(f.text)) continue;
        if (!f.writers.has(local) && target.writers.has(b.name)) f.writers.add(local), now.add(f);
        if (!f.fieldWriters.has(local) && target.fieldWriters.has(b.name)) f.fieldWriters.add(local), now.add(f);
      }
      // What its functions writing an amount return, but those building elements.
      for (const [name, [from, to]] of f.ranges) {
        if (!f.writers.has(name) || builds(f, name)) continue;
        const had = f.returns.has(name) ? f.returns.get(name)! : false;
        const held = joined(had, returnsHold(f, from, to, model));
        if (!sameHolds(had, held)) f.returns.set(name, held), now.add(f);
      }
      const vars = amountVarsOf(f, model, declared.get(f)!);
      const key = (vs: AmountVar[]) => vs.map((v) => `${v.name}@${v.from}:${v.members ? [...v.members].sort().join(',') : '*'}`).join(';');
      if (key(vars) !== key(f.amountVars)) (f.amountVars = vars), now.add(f);
      const holding = writerVarsOf(f, model, declared.get(f)!);
      if (holding.length !== f.writerVars.length) (f.writerVars = holding), now.add(f);
      // What its elements give the components they name.
      for (const x of f.jsx.exprs) {
        if (!x.attr || x.attr === '...' || x.attr === 'key') continue;
        const to = componentOf(f, x.element.name, model);
        if (!to) continue;
        const r = region(f, x.open + 1, x.close, 'own');
        const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(r.names)?.[1];
        if (paramsAt(f.lx, x.open + 1, x.close) !== null || bare) {
          // A function that writes an amount, handed on: an arrow that writes one, or one named.
          const writes = bare ? isWriter(bare, undefined, f, x.open, textPick(model), FORMATTERS, true) : writesAmount(f, x.open + 1, x.close, textPick(model), 'own');
          if (writes && add(to.target.propWriters, to.component, x.attr)) now.add(to.target);
          if (bare && readsAmount(r.names, f, x.open) && add(to.target.propAmounts, to.component, x.attr)) now.add(to.target);
        } else if (writesAmount(f, x.open + 1, x.close, textPick(model), 'drawn') && add(to.target.propAmounts, to.component, x.attr)) now.add(to.target);
      }
    }
    last = now;
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

/** The attributes a screen reader reads alone, or as a field's or a
 *  meter's own words. */
const LABELS = new Set(['aria-label', 'aria-valuetext', 'aria-valuenow', 'aria-description', 'title', 'alt', 'placeholder']);

/**
 * Each label a screen reader reads alone (LABELS: aria-label,
 * aria-valuetext, title, alt...) built from an amount not said through
 * spoken(): while amounts are hidden it would be read as bullets, never as
 * "hidden". And each built from a field's figures, which it would say
 * whatever the switch says.
 */
export function unspokenLabels(root: string, modules: readonly string[]): Unspoken[] {
  const model = modelOf(root, modules);
  const out: Unspoken[] = [];
  for (const [i, m] of modules.entries()) {
    const f = model.facts[i];
    for (const x of f.jsx.exprs) {
      if (!x.attr || !LABELS.has(x.attr)) continue;
      // What of it is drawn but said through spoken() (region, 'drawn').
      if (writesAmount(f, x.open + 1, x.close, amountPick(model), 'drawn') || writesFieldFigures(f, x.open + 1, x.close, model, 'drawn')) {
        const at = f.text.lastIndexOf(x.attr, x.open);
        out.push({ file: m, line: lineOf(f.text, at), text: lineText(f.text, at) });
      }
    }
  }
  return out;
}

/** An element's opening tag, as written. */
function openTag(f: ModuleFacts, el: Element): string {
  for (let i = el.start + 1; i < el.end; i++) {
    const past = f.lx.opaque.get(i);
    const pair = f.lx.pairs.get(i);
    if (past !== undefined) i = past - 1;
    else if (pair !== undefined && pair > i) i = pair;
    else if (f.text[i] === '>') return f.text.slice(el.start, i + 1);
  }
  return f.text.slice(el.start, el.end);
}

const hasAttr = (tag: string, name: string, value?: string) =>
  new RegExp(`\\s${name}(?=[\\s=/>])${value === undefined ? '' : `\\s*=\\s*(?:["']${value}["']|\\{\\s*['"]?${value}['"]?\\s*\\})`}`).test(tag);

/**
 * Whether the text of `el` (an element whose text can't hold markup) is said
 * some other way: SVG text and a title in a chart drawn as an image (an svg
 * with role="img", and so with its own label, or one hidden from a screen
 * reader), and a select's option with an aria-label of its own (which
 * unspokenLabels holds to spoken()).
 */
function saidElsewhere(f: ModuleFacts, el: Element): boolean {
  if (el.name === 'option') return hasAttr(openTag(f, el), 'aria-label');
  if (!['text', 'tspan', 'title'].includes(el.name)) return false;
  let svg: Element | null = null;
  for (const e of f.jsx.elements) if (e.name === 'svg' && e.start < el.start && el.end <= e.end && (!svg || e.start > svg.start)) svg = e;
  const tag = svg ? openTag(f, svg) : '';
  return !!svg && (hasAttr(tag, 'role', 'img') || hasAttr(tag, 'aria-hidden', 'true'));
}

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
      if (!field && (x.element.name === 'Masked' || saidElsewhere(f, x.element))) continue;
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
