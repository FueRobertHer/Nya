// What test/design-guard.test.ts measures, kept apart so the baseline it
// compares against (test/design-guard-baseline.json) is produced by the same
// code. The rules being held are in docs/design/guidelines.md.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { TAG_COLORS } from '@/lib/tags';
import { lex } from './amount-sources';

export const ROOT = join(import.meta.dir, '..');

export function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
}

/** Every .tsx under components/ and app/, as repository paths with forward slashes. */
export function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      const path = `${dir}/${name}`;
      if (statSync(join(ROOT, path)).isDirectory()) walk(path);
      else if (name.endsWith('.tsx')) out.push(relative(ROOT, join(ROOT, path)).replace(/\\/g, '/'));
    }
  };
  walk('components');
  walk('app');
  return out.sort();
}

// A hex color (not part of a word, an HTML entity, or an href or id anchor),
// or a color function.
const COLOR =
  /(?<![&\w])(?<!(?:href|id)=["'`])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lch|lab|color)\(/g;

/** Color literals in a component. Colors belong in globals.css as var(--token). */
export function rawColors(src: string): number {
  // Comments go (lex keeps every offset); strings stay, since that is where colors are written.
  return (lex(src, true).code.match(COLOR) ?? []).length;
}

// Inline style keys that patch spacing or type. Widths, positions, transforms
// and CSS custom properties carry data and stay allowed.
const LAYOUT_KEYS = new Set([
  'margin', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'marginBlock', 'marginInline',
  'padding', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'paddingBlock', 'paddingInline',
  'gap', 'rowGap', 'columnGap',
  'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform',
]);

/** Spacing and type keys set in `style={{ ... }}` objects. Read with lex, so a
 *  brace or a "//" inside a string, a template or a comment changes nothing. */
export function inlineLayoutStyles(src: string): number {
  const lx = lex(src, true);
  let count = 0;
  for (const m of lx.names.matchAll(/\bstyle\s*=\s*\{\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const close = lx.pairs.get(open);
    if (close === undefined || close < open) continue;
    // names has every string and comment written over with spaces, so only real keys remain.
    const body = lx.names.slice(open + 1, close);
    for (const [, key] of body.matchAll(/([A-Za-z]+)\s*:/g)) if (LAYOUT_KEYS.has(key)) count++;
  }
  return count;
}

type Declaration = { selector: string; atRules: string[]; property: string; value: string };

/** The stylesheet's declarations with the selector and at-rules around each. */
export function declarations(css: string): Declaration[] {
  // Comments go, and strings are blanked (as in css-balance.test.ts), so a
  // quoted ; { or } can't end a declaration or a rule.
  const src = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const out: Declaration[] = [];
  const stack: string[] = [];
  let head = '';
  for (const ch of src) {
    if (ch === '{') {
      stack.push(head.trim());
      head = '';
    } else if (ch === '}') {
      flush();
      stack.pop();
      head = '';
    } else if (ch === ';') {
      flush();
      head = '';
    } else head += ch;
  }
  function flush() {
    const at = head.indexOf(':');
    const selector = stack[stack.length - 1];
    if (at > 0 && selector !== undefined && !selector.startsWith('@')) {
      out.push({
        selector,
        atRules: stack.filter((s) => s.startsWith('@')),
        property: head.slice(0, at).trim(),
        value: head.slice(at + 1).trim(),
      });
    }
  }
  return out;
}

/** On-screen declarations: print styles and the custom properties a :root
 *  block defines (the tokens themselves) don't count. */
function onScreen(css: string): Declaration[] {
  return declarations(css).filter(
    (d) =>
      !d.atRules.some((a) => /^@media\s+print/.test(a)) &&
      !(d.selector.startsWith(':root') && d.property.startsWith('--')),
  );
}

/** Color literals in stylesheet rules outside the :root token blocks and print. */
export function cssRawColors(css: string): number {
  return onScreen(css).reduce((n, d) => n + (d.value.match(COLOR) ?? []).length, 0);
}

/** On-screen font sizes under 12px. */
export function cssSmallFonts(css: string): number {
  return onScreen(css).filter((d) => {
    let size: string | undefined;
    if (d.property === 'font-size') size = d.value;
    // The shorthand's size is the token before an optional "/line-height".
    else if (d.property === 'font') size = d.value.match(/(?:^|\s)(\d+(?:\.\d+)?(?:px|r?em))(?:\/|\s)/)?.[1];
    const m = size?.replace(/\s*!important$/, '').match(/^(\d+(?:\.\d+)?)(px|r?em)$/);
    if (!m) return false;
    const px = m[2] === 'px' ? Number(m[1]) : Number(m[1]) * 16;
    return px < 12;
  }).length;
}

/** Whether a class appears in some rule's selector. */
export function hasClass(css: string, cls: string): boolean {
  const re = new RegExp(`\\.${cls}(?![\\w-])`);
  return declarations(css).some((d) => re.test(d.selector));
}

export type Counts = { rawColors: number; inlineLayoutStyles: number; smallFonts: number };

/** Every file's counts; files with nothing to report are left out. */
export function measure(): Record<string, Partial<Counts>> {
  const out: Record<string, Partial<Counts>> = {};
  for (const file of sourceFiles()) {
    const src = read(file);
    const c: Partial<Counts> = {};
    const colors = rawColors(src);
    const layout = inlineLayoutStyles(src);
    if (colors) c.rawColors = colors;
    if (layout) c.inlineLayoutStyles = layout;
    if (Object.keys(c).length) out[file] = c;
  }
  const css = read('app/globals.css');
  const c: Partial<Counts> = {};
  const colors = cssRawColors(css);
  const small = cssSmallFonts(css);
  if (colors) c.rawColors = colors;
  if (small) c.smallFonts = small;
  if (Object.keys(c).length) out['app/globals.css'] = c;
  return out;
}

// ---------- Contrast of docs/design/tokens.css ----------

function luminance(hex: string): number {
  const c = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function tokenBlock(css: string, opener: RegExp): Record<string, string> {
  const start = css.search(opener);
  if (start < 0) throw new Error(`tokens.css: no block matching ${opener}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const vars: Record<string, string> = {};
  for (const [, k, v] of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) vars[k] = v.toLowerCase();
  return vars;
}

const DARK_BLOCK = /:root,\s*:root\[data-theme="dark"\]\s*\{/;
const LIGHT_BLOCK = /^:root\[data-theme="light"\]\s*\{/m;
const LIGHT_BY_SYSTEM = /:root:not\(\[data-theme="dark"\]\)\s*\{/;
// Print's copy of the light theme: the first of its two blocks (the second
// is black and white over it).
const PRINT_BLOCK = /:root:not\(\[data-theme\]\),\s*:root\[data-theme\]\s*\{/;
const SCALES_BLOCK = /:root\s*\{\s*\/\*\s*Type\./;

/** Every custom property a block declares, as written (rgba and the scales
 *  too), so a copy of the block can be held to the original. */
export function declaredVars(css: string, opener: RegExp): Record<string, string> {
  const start = css.search(opener);
  if (start < 0) throw new Error(`no block matching ${opener}`);
  const body = css
    .slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const vars: Record<string, string> = {};
  for (const [, k, v] of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) vars[k] = v.trim().replace(/\s+/g, ' ');
  if (!Object.keys(vars).length) throw new Error(`the block matching ${opener} declares nothing`);
  return vars;
}

/** The app's themes in app/globals.css: their hex colors for the contrast
 *  check, and every token of the scales and of each theme block (the system's
 *  light, the chosen light, print's light) for comparing with
 *  docs/design/tokens.css. */
export function appTheme(css: string) {
  return {
    dark: tokenBlock(css, DARK_BLOCK),
    light: tokenBlock(css, LIGHT_BLOCK),
    darkVars: declaredVars(css, DARK_BLOCK),
    lightVars: declaredVars(css, LIGHT_BLOCK),
    lightBySystemVars: declaredVars(css, LIGHT_BY_SYSTEM),
    printVars: declaredVars(css, PRINT_BLOCK),
    scales: declaredVars(css, SCALES_BLOCK),
  };
}

/** The same blocks in docs/design/tokens.css. */
export function referenceVars(css: string) {
  return { darkVars: declaredVars(css, DARK_BLOCK), lightVars: declaredVars(css, LIGHT_BLOCK), scales: declaredVars(css, SCALES_BLOCK) };
}

/** The two themes' colors, plus the light block the system setting selects (it must match the explicit one). */
export function themes(css: string) {
  return {
    dark: tokenBlock(css, DARK_BLOCK),
    light: tokenBlock(css, LIGHT_BLOCK),
    lightBySystem: tokenBlock(css, LIGHT_BY_SYSTEM),
  };
}

const TEXT = 4.5;
const UI = 3;

/** [foreground, background, minimum ratio] pairs the design system allows. */
export function contrastPairs(): [string, string, number][] {
  const pairs: [string, string, number][] = [];
  for (const bg of ['canvas', 'surface', 'elevated']) {
    for (const fg of ['text-1', 'text-2', 'text-3', 'accent', 'pos', 'neg', 'warn']) pairs.push([fg, bg, TEXT]);
    pairs.push(['border-input', bg, UI]);
  }
  pairs.push(['text-1', 'caveat-surface', TEXT], ['text-2', 'caveat-surface', TEXT]);
  for (const k of ['accent', 'pos', 'neg', 'warn']) pairs.push([k, `${k}-tint`, TEXT], ['text-1', `${k}-tint`, TEXT]);
  pairs.push(['text-2', 'warn-tint', TEXT], ['text-2', 'neg-tint', TEXT]);
  pairs.push(['on-fill', 'accent-fill', TEXT], ['on-fill', 'danger-fill', TEXT]);
  pairs.push(['focus', 'surface', UI], ['focus', 'canvas', UI]);
  // A tag's text on its tint, and its swatch (the text step) on a card.
  for (const tag of TAG_COLORS) pairs.push([`tag-${tag}`, `tag-${tag}-tint`, TEXT], [`tag-${tag}`, 'surface', UI]);
  return pairs;
}
