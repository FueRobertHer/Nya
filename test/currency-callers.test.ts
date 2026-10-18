import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { filesUnder, withoutComments } from './amount-sources';

// Every reader that picks one currency for a total (lib/format.ts
// dominantCurrency, over balances; lib/spending.ts totalsCurrency, over
// rows) is listed here, by file, function and value, with its reason. A home
// currency converts net worth only, in this step (lib/fx/): the readers of
// balances that a home currency reaches convert, and every other is listed
// "until step 2", when flows, budgets, the Plan, reports and shares convert.
// A reader added later that totals in one currency fails this until it is
// listed with its reason, or converts. Outside lib/spending.ts, lib/format.ts
// and lib/fx/, where the rules are kept.

const ROOT = join(import.meta.dir, '..');

const STEP_2 = 'Until step 2: totals of flows in the one currency most rows are in, what is in another named, never added.';

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
  'lib/fire/inputs.ts#investedAssets:currency': 'Until step 2: the Plan’s invested assets in their main currency; the Plan doesn’t convert yet, and says so.',
  'lib/forecast.ts#cashPosition:currency': 'Until step 2: the cash forecast in its cash accounts’ main currency.',
  'lib/share-views.ts#holdingsView:currency': 'Until step 2: a share’s holdings in their main currency; shares convert in step 2 (decision 5), and say they don’t until then.',
  // Flows.
  'components/BudgetsTab.tsx#BudgetsTab:displayCurrency': STEP_2,
  'components/Insights.tsx#Insights:displayCurrency': STEP_2,
  'components/MonthBreakdown.tsx#MonthBreakdown:currency': STEP_2,
  'components/MonthFlowChart.tsx#MonthFlowChart:currency': STEP_2,
  'lib/api-cash-flow.ts#readCashFlow:currency': STEP_2,
  'lib/api-read.ts#readRecurring:currency': STEP_2,
  'lib/api-read.ts#readSpending:currency': STEP_2,
  'lib/budget-month.ts#monthFromActivity:currency': STEP_2,
  'lib/fire/inputs.ts#trailingFlows:currency': STEP_2,
  'lib/report/build.ts#buildReport:currency': STEP_2,
  'lib/share-views.ts#spendingView:currency': `${STEP_2} A share says it doesn’t convert.`,
  'lib/weekly-summary/gather.ts#gatherWeekly:spending': STEP_2,
  'components/Dashboard.tsx#Dashboard:offer': 'The currency the budgets are read in today, which the offer to choose a home currency suggests (decision 1): never a total.',
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
