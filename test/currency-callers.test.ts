import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { filesUnder, withoutComments } from './amount-sources';

// Every reader that picks one currency for a total (lib/format.ts
// dominantCurrency, over balances; lib/spending.ts totalsCurrency, over
// rows) is listed here, by file, function and value, with its reason. With a
// home currency, totals of flows convert through one seam (lib/fx/totals.ts
// totalsIn) and balances through lib/fx/net-worth.ts: a reader that still
// picks a currency itself is listed with why (a label, a version 1 field
// that keeps its meaning, a currency what the person typed is in). A reader
// added later that totals in one currency fails this until it is listed
// with its reason, or converts. Outside lib/spending.ts, lib/format.ts and
// lib/fx/, where the rules are kept.

const ROOT = join(import.meta.dir, '..');


const ALLOWED: Record<string, string> = {
  // Balances.
  'components/Dashboard.tsx#Dashboard:accountCurrency':
    'Without a home currency, the label of net worth as it always was; with one, the currency an account saying none is counted in, as the server counts it (lib/fx/net-worth-read.ts mainCurrency).',
  'components/Dashboard.tsx#Dashboard:instCurrency':
    'An institution’s total in its accounts’ currency when they share one; converted into the home currency when they don’t and one is chosen (lib/fx/view.ts).',
  'components/ConnectionHealth.tsx#together:main':
    'The share of net worth an institution’s held balances are, in their currency when they share one; converted into the home currency when one is chosen (lib/fx/view.ts).',
  'lib/api-read.ts#netWorthCurrency':
    'The API’s version 1 fields keep their meaning: one total per currency, and the currency the recorded totals are labelled with. base converts (lib/fx/api-base.ts).',
  'lib/fire/inputs.ts#investedAssets:currency':
    'The Plan’s currency, the one most of its accounts are in, which what the person types in the Plan is in: with a home currency the rest converts into it (lib/fx/net-worth.ts balancesIn), never relabelled.',
  'lib/forecast.ts#cashPosition:currency':
    'The forecast’s currency, its cash accounts’ main one, which the warning the person typed is in: with a home currency the rest converts into it at the newest rates, never relabelled.',
  'lib/share-views.ts#holdingsView:currency':
    'Without the owner’s home currency only: a share’s holdings in their main currency, the rest named. With one, in it, converted at the newest rates (lib/allocation/allocation.ts inputsIn, decision 5).',
  // Flows.
  'components/MonthFlowChart.tsx#MonthFlowChart:currency':
    'Only when the Activity tab gives it no currency: its rows are the ones the tab totals, already converted into the home currency through lib/fx/totals.ts totalsIn, so this is the label of what they are in.',
  'lib/api-cash-flow.ts#readCashFlow:currency': 'Version 1’s field keeps its meaning: one currency, the rest named, never added. With a home currency, base converts (lib/fx/totals.ts totalsIn).',
  'lib/api-read.ts#readRecurring:currency': 'Version 1’s field keeps its meaning: one currency, the rest named, never added. With a home currency, base converts (lib/totals.ts recurringMonthly, at today’s rates).',
  'lib/api-read.ts#readSpending:currency': 'Version 1’s field keeps its meaning: one currency, the rest named, never added. With a home currency, base converts (lib/fx/totals.ts totalsIn).',
  'lib/report/build.ts#buildReport:currency':
    'Without a home currency only, as before: the one most rows are in, the rest named. With one, the home currency or the one asked for, the rest converted through lib/fx/totals.ts totalsIn.',
  'components/Dashboard.tsx#Dashboard:budgets': 'The currency the budgets are read in today, which the offer to choose a home currency suggests (decision 1): never a total.',
};

/** A top-level function's start: `function name(` or `const name = (…) =>`. */
const FUNCTION = /\n(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)|\n(?:export\s+)?const\s+(\w+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=\n]+)?=>/g;

/** Each call of a currency picker in a module, as "file#function:value":
 *  the top-level function it is in, and the value it is given to inside it,
 *  if any. */
export function callers(path: string, source: string): string[] {
  const text = `\n${withoutComments(source.replace(/\r/g, ''))}`;
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:dominantCurrency|totalsCurrency)\s*\(/g)) {
    const before = text.slice(0, m.index!);
    if (/function\s+$/.test(before)) continue; // its definition
    const fn = [...before.matchAll(FUNCTION)].pop();
    const start = fn ? fn.index! + fn[0].length : 0;
    const value = [...before.slice(start).matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=\n]+)?=(?!=)/g)].pop()?.[1];
    out.push(`${path}#${fn ? (fn[1] ?? fn[2]) : '(module)'}${value ? `:${value}` : ''}`);
  }
  return out;
}

describe('every reader that totals in one currency is listed, with its reason', () => {
  const sources = ['lib', 'components', 'app']
    .flatMap((d) => filesUnder(join(ROOT, d)))
    .map((f) => relative(ROOT, f))
    .filter((f) => f !== 'lib/spending.ts' && f !== 'lib/format.ts' && !f.startsWith('lib/fx/'));

  test('the list is the code’s: none missing, none stale', () => {
    const found = [...new Set(sources.flatMap((f) => callers(f, readFileSync(join(ROOT, f), 'utf8'))))].sort();
    // A new one: convert it into the home currency (lib/fx/), or list it here with why it doesn't.
    expect(found).toEqual(Object.keys(ALLOWED).sort());
    for (const [where, why] of Object.entries(ALLOWED)) expect([where, why.length > 20]).toEqual([where, true]);
  });

  // Decision 1: Nya never writes a home currency on its own, on any path.
  test('only the person’s own requests write the currency settings: the two routes, nothing else', () => {
    // Every module, lib/fx/ included; withHome's own definition aside.
    const all = ['lib', 'components', 'app'].flatMap((d) => filesUnder(join(ROOT, d))).map((f) => relative(ROOT, f));
    const writes = (f: string) => {
      const code = withoutComments(readFileSync(join(ROOT, f), 'utf8')).replace(/\bfunction\s+withHome\s*\(/g, '');
      return /\bcurrencySettingsStore\s*\.\s*(?:set|update|remove)\s*\(|\bwithHome\s*\(/.test(code);
    };
    const writers = all.filter(writes);
    expect(writers.sort()).toEqual(['app/api/currency/rates/route.ts', 'app/api/currency/route.ts']);
  });

  test('the scan finds a call by its function and value, and passes over a definition and a comment', () => {
    const source = [
      "import { dominantCurrency } from '@/lib/format';",
      '// dominantCurrency(rows) in a comment',
      'export function dominantCurrencyOf(x: unknown) { return x; }',
      'export function totalOf(rows: any[]) {',
      '  const label = dominantCurrency(rows);',
      '  return label;',
      '}',
      'const viaArrow = (rows: any[]) => totalsCurrency(rows);',
    ].join('\n');
    expect(callers('lib/x.ts', source)).toEqual(['lib/x.ts#totalOf:label', 'lib/x.ts#viaArrow']);
  });
});
