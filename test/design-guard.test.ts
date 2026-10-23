// One design language as the app grows (docs/design/guidelines.md). The suite
// can't see a screen, so this holds what the source shows: no file gains a
// color literal, an inline spacing or type patch, or on-screen text under
// 12px (each file is held to its count in design-guard-baseline.json, a new
// file to none); every component has a recorded home in the information
// architecture; the classes the guidelines name exist; and the proposed
// tokens keep AA contrast in both themes.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import baselineJson from './design-guard-baseline.json';
import {
  ROOT,
  contrast,
  contrastPairs,
  hasClass,
  measure,
  read,
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
  test('every class under "Use today" exists in app/globals.css', () => {
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

describe('design guard: the proposed tokens (docs/design/tokens.css)', () => {
  const t = themes(read('docs/design/tokens.css'));

  for (const [name, theme] of [['dark', t.dark], ['light', t.light]] as const) {
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
});
