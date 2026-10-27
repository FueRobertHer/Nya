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
import { DARK, FONT_UI, LIGHT } from '@/lib/theme';
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
    if (FONT_UI !== app.scales['font-ui']) drift.push(`lib/theme.ts FONT_UI is ${FONT_UI}, --font-ui is ${app.scales['font-ui']}`);
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
