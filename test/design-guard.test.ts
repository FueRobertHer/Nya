// One design language as the app grows (docs/design/guidelines.md). The suite
// can't see a screen, so this holds what the source shows: no file gains a
// color literal, an inline spacing or type patch, or on-screen text under
// 12px (each file is held to its count in design-guard-baseline.json, a new
// file to none); every component has a recorded home in the information
// architecture; the classes the guidelines name exist; and the tokens keep
// AA contrast in both themes, with every copy of the palette in step.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BUCKET_COLORS, CLASS_COLORS } from '@/components/allocation-text';
import { CLERK_APPEARANCE, DARK, LIGHT } from '@/lib/theme';
import baselineJson from './design-guard-baseline.json';
import {
  ROOT,
  appTheme,
  contrast,
  contrastPairs,
  hasClass,
  measure,
  read,
  referenceVars,
  sourceFiles,
  themes,
  type Counts,
} from './design-guard-metrics';

const baseline = baselineJson as Record<string, Partial<Counts>>;
const METRICS: (keyof Counts)[] = ['rawColors', 'inlineLayoutStyles', 'smallFonts'];
const FIX: Record<keyof Counts, string> = {
  rawColors: 'use a var(--…) color from app/globals.css',
  inlineLayoutStyles: 'space with .stack or a button group, and size text with a class',
  smallFonts: 'use 12px or more',
};

describe('design guard: no file moves away from the design language', () => {
  const now = measure();

  test('no file has more color literals, inline spacing or small type than its baseline', () => {
    const over: string[] = [];
    for (const [file, counts] of Object.entries(now)) {
      for (const metric of METRICS) {
        const count = counts[metric] ?? 0;
        const allowed = baseline[file]?.[metric] ?? 0;
        if (count > allowed) over.push(`${file}: ${metric} is ${count}, at most ${allowed} (${FIX[metric]})`);
      }
    }
    expect(over).toEqual([]);
  });

  test('the baseline only holds what is still there (lower it when a count falls)', () => {
    const stale: string[] = [];
    for (const [file, counts] of Object.entries(baseline)) {
      if (!existsSync(join(ROOT, file))) {
        stale.push(`${file} no longer exists: remove it from test/design-guard-baseline.json`);
        continue;
      }
      for (const metric of METRICS) {
        const allowed = counts[metric];
        if (allowed === undefined) continue;
        const count = now[file]?.[metric] ?? 0;
        if (count < allowed) stale.push(`${file}: ${metric} is now ${count}; lower the baseline from ${allowed} to ${count}`);
      }
    }
    expect(stale).toEqual([]);
  });
});

describe('design guard: every component has a home', () => {
  test('each component in components/ is placed in docs/design/information-architecture.md', () => {
    const doc = read('docs/design/information-architecture.md');
    const missing = sourceFiles()
      .filter((file) => file.startsWith('components/'))
      .map((file) => file.slice(file.lastIndexOf('/') + 1, -'.tsx'.length))
      .filter((name) => !new RegExp(`\\b${name}\\b`).test(doc));
    // Add it to "Feature to location", or to "Building blocks" if it only serves other components.
    expect(missing).toEqual([]);
  });
});

describe('design guard: the guidelines name real classes', () => {
  test('every class under "Use" exists in app/globals.css', () => {
    const guide = read('docs/design/guidelines.md');
    const table = guide.match(/<!-- design-guard:classes -->([\s\S]*?)<!-- \/design-guard:classes -->/);
    expect(table).not.toBeNull();
    const css = read('app/globals.css');
    const named = new Set<string>();
    for (const row of table![1].split('\n').filter((l) => l.startsWith('|'))) {
      const today = row.split('|')[2] ?? '';
      for (const [, code] of today.matchAll(/`([^`]+)`/g)) {
        for (const [, cls] of code.matchAll(/\.([a-z][a-z0-9-]*)/g)) named.add(cls);
      }
    }
    expect(named.size).toBeGreaterThan(10);
    const missing = [...named].filter((cls) => !hasClass(css, cls));
    expect(missing).toEqual([]);
  });
});

// What the token check can't see: which token a rule uses. A field or chip is
// marked by an edge that meets 3:1 (--border-input; --border-strong is about
// 1.4:1), and a state is never shown by color alone. A button is named by its
// label or its icon and aria-label, so it needs no edge (WCAG 1.4.11): it is
// tonal or bare (look and feel, step 2), with a transparent edge that forced
// colors draw, and keeps a 3:1 edge only on a fill of its own.
describe('design guard: controls and states read without color', () => {
  const css = read('app/globals.css');
  // The bodies of the rules whose selector has a line starting with `start`.
  const rules = (start: string) =>
    [...css.matchAll(new RegExp(`(^|\\n)${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'))].map((m) => {
      const open = css.indexOf('{', m.index!);
      return css.slice(open + 1, css.indexOf('}', open));
    });
  const NEEDS: [string, string, string][] = [
    [':where(input:not(', 'var(--border-input)', 'a plain field is edged in --border-input'],
    ['.text-input {', 'var(--border-input)', 'a .text-input is edged in --border-input'],
    ['.invite-link {', 'var(--border-input)', 'the invite link field is edged in --border-input'],
    ['button.secondary {', '1px solid transparent', 'a secondary button has an edge forced colors draw'],
    ['.btn.secondary {', '1px solid transparent', 'a .btn.secondary has an edge forced colors draw'],
    [':is(.notice, .rule-offer, .rule-preview) :is(button.secondary, .btn.secondary) {', 'var(--border-input)', 'a secondary on a fill of its own is edged in --border-input'],
    ['.icon-btn {', '1px solid transparent', 'an icon button has an edge forced colors draw'],
    ['.chip {', 'var(--border-input)', 'a chip is edged in --border-input'],
    ['h1,', 'font-family: var(--font-display)', 'titles and figures are in Red Hat Display (look and feel, step 3)'],
    ['.segmented > button:is([aria-selected="true"], [aria-checked="true"]) {', 'border-bottom: 3px solid var(--accent)', 'the current item of a switch has a bar'],
    ['.segmented > button:is([aria-selected="true"], [aria-checked="true"]) {', 'font-weight: var(--fw-semibold)', 'the current item of a switch is heavier'],
    ['.chip:is([aria-pressed="true"], [aria-checked="true"], [aria-selected="true"], [data-on])::before {', 'mask', 'a chip that is on has a check'],
    ['.tab-bar button.active::before {', 'var(--accent)', 'the current tab has a bar'],
    ['.notice.critical {', 'border-color: currentColor', 'a critical notice has an edge'],
    // Look and feel, step 4: brass sits close to orange, coral and body text.
    ['a:not([class]) {', 'text-decoration: underline', 'a link inside a sentence is underlined'],
    ['.meter-fill.warn {', 'repeating-linear-gradient', 'a meter at caution is hatched, not only orange'],
    ['.cal-dot.planned {', 'border: 1.5px solid var(--accent)', "the calendar's planned dot is a ring"],
    ['.cal-dot.due {', 'border-radius: 1px', "the calendar's payment due dot is a square"],
    ['.brand-mark {', 'forced-color-adjust: none', "forced colors leaves the logo's mask as drawn"],
    ['.brand-mark {', 'color: var(--brand-mark)', "the logo's ink is --brand-mark"],
    // Look and feel, step 5: the hero on the page.
    ['.net-worth-hero .notice:not(.critical) {', 'border-color: var(--border-subtle)', 'a notice on the page keeps an edge'],
    ['.net-worth-hero .total-value {', 'white-space: nowrap', "the hero's figure never wraps under a finger"],
    ['.chart-svg.hero-chart {', 'margin-inline: calc(-1 * var(--sp-4))', "the hero's chart bleeds through the gutter"],
    ['.chart-svg.hero-chart {', 'touch-action: pan-y', "the hero's chart still lets the page scroll"],
    ['.plan-table-view summary {', 'line-height: var(--tap)', 'Show as a table is a 44px target'],
  ];
  test('each control has its edge and each state more than a color', () => {
    const missing = NEEDS.filter(([start, needs]) => !rules(start).some((body) => body.includes(needs))).map(([, , what]) => what);
    expect(missing).toEqual([]);
  });

  // Look and feel, step 3: each title and figure the design draws in Red Hat
  // Display is named in the one rule that gives it (the entry above holds the
  // rule itself), and a heading drawn as a label isn't.
  test('each title and figure is in the Display rule', () => {
    const at = css.indexOf('h1,', css.indexOf('Titles and figures in Red Hat Display'));
    const head = css.slice(at, css.indexOf('{', at));
    const roles = ['.card-header > :is(h2, h3)', '.sheet-header h2', '.month-stepper-title', '.budgets-title', '.plan-title', '.total-value', '.summary-value', '.plan-stat-value', '.card-mode-amount', '.txn-sheet-amount', '.account-balance', '.txn-logo-fallback'];
    expect(roles.filter((r) => !head.includes(r))).toEqual([]);
    expect(head).not.toContain('total-label');
  });

  // A bare icon button has nothing but its icon, so its aria-label is its
  // name (WCAG 4.1.2). Each element whose class has icon-btn (not the sheet's
  // own .sheet-icon-btn) carries one.
  test('each icon button has an aria-label', () => {
    const unnamed: string[] = [];
    for (const file of sourceFiles()) {
      const src = read(file);
      for (const m of src.matchAll(/className=["{][^>]*?(?<![\w-])icon-btn(?![\w-])/g)) {
        const open = src.lastIndexOf('<', m.index!);
        // The tag runs to the first > outside braces (an arrow's => is inside).
        let depth = 0;
        let end = open;
        for (; end < src.length; end++) {
          const ch = src[end];
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          else if (ch === '>' && depth === 0) break;
        }
        if (!src.slice(open, end).includes('aria-label=')) unnamed.push(`${file}:${src.slice(0, open).split('\n').length}`);
      }
    }
    expect(unnamed).toEqual([]);
  });

  // The primary's fill is brass in dark, where a white label is 2.12:1, so
  // every rule that draws the fill names its own label.
  test('every rule that fills with --accent-fill labels it --on-accent-fill', () => {
    const filled = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => /background:\s*var\(--accent-fill\)/.test(m[2]));
    expect(filled.length).toBeGreaterThanOrEqual(2);
    expect(filled.filter((m) => !/(^|[^-])color:\s*var\(--on-accent-fill\)/.test(m[2])).map((m) => m[1].trim())).toEqual([]);
  });

  test('a caution notice has the clock, not the critical triangle', () => {
    const found: string[] = [];
    for (const file of sourceFiles()) {
      if (/className="notice caution[^"]*"[^>]*>\s*\{ALERT\}/.test(read(file))) found.push(file);
    }
    expect(found).toEqual([]);
  });
});

describe('design guard: copy', () => {
  test('no em or en dash in UI source or the design docs (guidelines.md, Copy)', () => {
    const files = [
      ...sourceFiles(),
      'app/globals.css',
      ...['README.md', 'guidelines.md', 'design-system.md', 'information-architecture.md', 'rollout.md', 'tokens.css', 'mockups/index.html'].map(
        (f) => `docs/design/${f}`,
      ),
    ];
    const found: string[] = [];
    for (const file of files) {
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (/[\u2013\u2014]/.test(line)) found.push(`${file}:${i + 1}`);
        });
    }
    expect(found).toEqual([]);
  });
});

describe('design guard: the tokens (app/globals.css and docs/design/tokens.css)', () => {
  const t = themes(read('docs/design/tokens.css'));
  const app = appTheme(read('app/globals.css'));

  test("the app's scales and both themes are the ones in docs/design/tokens.css", () => {
    const ref = referenceVars(read('docs/design/tokens.css'));
    expect(app.scales).toEqual(ref.scales);
    expect(app.darkVars).toEqual(ref.darkVars);
    expect(app.lightVars).toEqual(ref.lightVars);
  });

  test("the app's light theme is the same whether the system, a choice or print selects it", () => {
    expect(app.lightBySystemVars).toEqual(app.lightVars);
    expect(app.printVars).toEqual(app.lightVars);
  });

  test('lib/theme.ts and the web manifest hold the same values as the tokens', () => {
    const drift: string[] = [];
    for (const [k, v] of Object.entries(DARK)) {
      if (app.darkVars[k] !== v) drift.push(`lib/theme.ts ${k} is ${v}, --${k} is ${app.darkVars[k]}`);
    }
    for (const [k, v] of Object.entries(LIGHT)) {
      if (app.lightVars[k] !== v) drift.push(`lib/theme.ts LIGHT ${k} is ${v}, light --${k} is ${app.lightVars[k]}`);
    }
    // Clerk reads the app's own font token, so it can't drift from it.
    if (CLERK_APPEARANCE.variables.fontFamily !== 'var(--font-ui)') drift.push(`lib/theme.ts Clerk's fontFamily is ${CLERK_APPEARANCE.variables.fontFamily}, not var(--font-ui)`);
    // Its primary states carry the primary's label, ink on brass in dark.
    if (CLERK_APPEARANCE.variables.colorPrimaryForeground !== 'var(--on-accent-fill)') drift.push(`lib/theme.ts Clerk's colorPrimaryForeground is ${CLERK_APPEARANCE.variables.colorPrimaryForeground}, not var(--on-accent-fill)`);
    const manifest = JSON.parse(read('public/manifest.json'));
    for (const k of ['background_color', 'theme_color']) {
      if (manifest[k] !== app.dark.canvas) drift.push(`public/manifest.json ${k} is ${manifest[k]}, --canvas is ${app.dark.canvas}`);
    }
    expect(drift).toEqual([]);
  });

  for (const [name, theme] of [['dark', app.dark], ['light', app.light]] as const) {
    test(`every allowed pairing passes AA in ${name}`, () => {
      const failing: string[] = [];
      for (const [fg, bg, min] of contrastPairs()) {
        if (!theme[fg] || !theme[bg]) {
          failing.push(`--${fg} or --${bg} is missing`);
          continue;
        }
        const ratio = contrast(theme[fg], theme[bg]);
        if (ratio < min) failing.push(`--${fg} on --${bg} is ${ratio.toFixed(2)}:1, needs ${min}:1`);
      }
      expect(failing).toEqual([]);
    });
  }

  test('the light theme is the same whether the system or a choice selects it', () => {
    expect(t.lightBySystem).toEqual(t.light);
  });

  // The allocation views draw each class and tax bucket in one color in both
  // themes (components/allocation-text.ts), on a card.
  test('the allocation colors pass 3:1 on a card in both themes', () => {
    const failing: string[] = [];
    for (const [name, theme] of [['dark', app.dark], ['light', app.light]] as const) {
      for (const color of new Set([...Object.values(CLASS_COLORS), ...Object.values(BUCKET_COLORS)])) {
        const ratio = contrast(color, theme.surface);
        if (ratio < 3) failing.push(`${color} on ${name} --surface is ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failing).toEqual([]);
  });
});
