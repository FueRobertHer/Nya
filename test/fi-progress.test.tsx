import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { FiCard } from '@/components/PlanTab';
import { FiProgressView, ready } from '@/components/FiProgressCard';
import { loadFiProgress } from '@/components/FiProgressLoader';
import { PAYROLL_NOTE, wholeMoney, yearsToFiText } from '@/components/plan-text';
import { DEFAULT_PLAN, fiView, type FirePlan } from '@/lib/fire/plan';
import { currencyNote, fiFigures, measuredInputs, planCurrency, savingsRate, type FiInputs } from '@/lib/fire/progress';
import type { InvestedAssets, TrailingFlows, WorkplaceSavings } from '@/lib/fire/inputs';

// The FI card on Home: the Plan's own figures, from the same inputs and the
// same arithmetic (lib/fire/progress.ts), so the two always agree; the
// defaults said as defaults; estimates labelled; and no engine on Home.

const noop = () => {};
const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

const flows: TrailingFlows = {
  spending: 40_000,
  income: 70_000,
  savings: 30_000,
  loanPayments: 0,
  cash: 0,
  refunds: 0,
  unclearLoans: 0,
  largestRefund: null,
  from: '2025-10-07',
  to: '2026-10-06',
  days: 365,
  scaled: false,
  count: 400,
  currency: 'USD',
  mixedCurrency: false,
};
const assets = (over: Partial<InvestedAssets> = {}): InvestedAssets => ({
  total: 250_000,
  accounts: [{ account_id: 'a', name: 'Brokerage', type: 'investment', balance: 250_000, currency: 'USD', institution: 'Vanguard', item_id: 'i1' }],
  unknown: 0,
  caveats: [],
  currency: 'USD',
  mixedCurrency: false,
  ...over,
});
const noPlans: WorkplaceSavings = { total: 0, plans: [], fromBank: [], partial: [], shortHistory: [], problems: [], unmeasured: [] };
const withPlan = (total: number): WorkplaceSavings => ({
  ...noPlans,
  total,
  plans: [{ name: 'Fidelity 401(k)', paidFrom: 'payroll', added: total, count: 24, largest: { date: '2026-09-30', amount: 1000 }, matched: 0 }],
});
const inputs = (over: Partial<FiInputs> = {}): FiInputs & { unread: [] } => ({ flows, workplace: noPlans, assets: assets(), unread: [], ...over });

const home = (p: FirePlan, i = inputs(), saved = true, repaired = false) =>
  text(renderToStaticMarkup(<FiProgressView figures={fiFigures(p, i, 'USD')} plan={p} saved={saved} repaired={repaired} inputs={i} onOpenPlan={noop} />));
const planTab = (p: FirePlan, i = inputs()) => {
  const f = fiFigures(p, i, 'USD');
  return text(
    renderToStaticMarkup(
      <FiCard
        plan={p}
        view={f.view}
        flows={i.flows}
        unread={[]}
        txnsLoading={false}
        txnsFailed={false}
        assets={i.assets}
        balancesAsOf="2026-10-06T15:12:00Z"
        workplace={i.workplace}
        workplaceCount={i.workplace?.plans.length ?? 0}
        currencyNote={f.currencyNote}
        money={(n) => wholeMoney(n, f.currency)}
        editable
        open={noop}
        savingsRate={f.savingsRate}
      />
    )
  );
};

describe('the figures, from the Plan’s inputs', () => {
  test('measured inputs: a year’s spending, savings with workplace contributions added, invested assets', () => {
    expect(measuredInputs(inputs())).toEqual({ spending: 40_000, savings: 30_000, assets: 250_000 });
    expect(measuredInputs(inputs({ workplace: withPlan(12_000) }))).toEqual({ spending: 40_000, savings: 42_000, assets: 250_000 });
    expect(measuredInputs(inputs({ flows: null, assets: assets({ total: null }) }))).toEqual({ spending: null, savings: null, assets: null });
  });

  test('the savings rate counts workplace contributions on both sides', () => {
    expect(savingsRate({ flows, workplace: noPlans })).toBeCloseTo(30 / 70, 12);
    // (70,000 + 12,000 - 40,000) / (70,000 + 12,000)
    expect(savingsRate({ flows, workplace: withPlan(12_000) })).toBeCloseTo(42 / 82, 12);
    // Spending more than income: below zero, as it was.
    expect(savingsRate({ flows: { ...flows, income: 30_000, savings: -10_000 }, workplace: null })).toBeCloseTo(-1 / 3, 12);
    // No income to take a share of, or no year of transactions.
    expect(savingsRate({ flows: { ...flows, income: 0, savings: -40_000 }, workplace: null })).toBeNull();
    expect(savingsRate({ flows: null, workplace: withPlan(5_000) })).toBeNull();
  });

  test('the currency and the note about currencies are the Plan’s', () => {
    expect(planCurrency(inputs(), 'EUR')).toBe('USD');
    expect(planCurrency(inputs({ assets: assets({ currency: null }), flows: { ...flows, currency: null } }), 'EUR')).toBe('EUR');
    expect(currencyNote(inputs({ flows: { ...flows, currency: 'CAD' } }))).toContain("can't be compared");
    expect(currencyNote(inputs({ assets: assets({ mixedCurrency: true }) }))).toContain('more than one currency');
    expect(currencyNote(inputs())).toBeNull();
  });

  test('are fiView of the measured inputs, as the Plan tab works them out', () => {
    for (const p of [plan(), plan({ withdrawalRate: 0.035, realReturn: 0.04, taxRate: 0.15 }), plan({ spending: 60_000, savings: 10_000 }), plan({ assets: 0 })]) {
      for (const i of [inputs(), inputs({ workplace: withPlan(8_000) }), inputs({ flows: null })]) {
        expect(fiFigures(p, i, 'USD').view).toEqual(fiView(p, measuredInputs(i)));
      }
    }
  });
});

describe('the FI card on Home', () => {
  test('agrees with the Plan tab for the same inputs: FI number, years to FI, progress and savings rate', () => {
    for (const p of [plan(), plan({ withdrawalRate: 0.035, realReturn: 0.03, taxRate: 0.1, age: 35 }), plan({ spending: 52_000 })]) {
      for (const i of [inputs(), inputs({ workplace: withPlan(9_500) })]) {
        const f = fiFigures(p, i, 'USD');
        const h = home(p, i);
        const t = planTab(p, i);
        const fi = wholeMoney(f.view.fiNumber!, 'USD');
        const years = yearsToFiText(f.view.yearsToFi);
        for (const s of [fi, years, `${Math.round(f.view.progress! * 100)}% of the way`, `${Math.round(f.savingsRate! * 100)}%`]) {
          expect(h).toContain(s);
          expect(t).toContain(s);
        }
      }
    }
  });

  test('labels its figures as estimates, with the Plan’s note about pay that never reaches a bank', () => {
    const t = home(plan());
    expect(t).toContain('Estimates, from your plan: a 4% withdrawal rate and a 5% real return.');
    expect(t).toContain('savings rate, last 12 months');
    expect(t).toContain(PAYROLL_NOTE);
    expect(planTab(plan())).toContain(PAYROLL_NOTE);
    // With workplace contributions measured, it says they are counted instead.
    const w = home(plan(), inputs({ workplace: withPlan(12_000) }));
    expect(w).toContain('with what went into workplace plans counted on both sides');
    expect(w).not.toContain(PAYROLL_NOTE);
  });

  test('with no plan saved, says the figures come from the defaults and offers the Plan tab', () => {
    const t = home(plan(), inputs(), false);
    expect(t).toContain("from the Plan's default assumptions: a 4% withdrawal rate and a 5% real return. Set your own on the Plan tab.");
    expect(t).toContain('Set up your plan');
    expect(t).toContain('$1,000,000');
    expect(home(plan(), inputs(), true)).toContain('Your plan');
  });

  test('says which of the plan’s inputs were typed, and when a saved plan needed repairs', () => {
    const t = home(plan({ spending: 60_000, savings: 5_000 }));
    expect(t).toContain('Using the spending and savings you typed there.');
    expect(t).toContain('$1,500,000');
    expect(home(plan(), inputs(), true, true)).toContain("Your saved plan has values this version of Nya can't use");
  });

  test('a figure that may be short says so, as the Plan’s does', () => {
    const unread = { ...inputs(), unread: [{ institution: 'Chase', reason: 'needs to be reconnected' }] };
    const t = text(renderToStaticMarkup(<FiProgressView figures={fiFigures(plan(), unread, 'USD')} plan={plan()} saved repaired={false} inputs={unread} onOpenPlan={noop} />));
    expect(t).toContain("May be low: spending is missing transactions that couldn't be read.");
    const short = inputs({ assets: assets({ caveats: [{ kind: 'unreachable', institution: 'Schwab' }] }) });
    expect(home(plan(), short)).toContain('Invested assets may be low');
    // Balances that are only old aren't short.
    expect(home(plan(), inputs({ assets: assets({ caveats: [{ kind: 'stale', institution: 'Schwab', asOf: '2026-10-01', at: null }] }) }))).not.toContain('may be low');
  });

  test('shows nothing with no spending to work from', () => {
    const html = renderToStaticMarkup(
      <FiProgressView figures={fiFigures(plan(), inputs({ flows: null }), 'USD')} plan={plan()} saved={false} repaired={false} inputs={inputs({ flows: null })} onOpenPlan={noop} />
    );
    expect(html).toBe('');
  });

  test('waits for the plan, the first transactions and workplace contributions, but keeps its place through a refresh', () => {
    const base = { plan: 'loaded' as const, txns: [], txnsLoading: false, contributionsPending: false };
    expect(ready(base)).toBe(true);
    expect(ready({ ...base, plan: 'loading' })).toBe(false);
    expect(ready({ ...base, plan: 'failed' })).toBe(false);
    expect(ready({ ...base, txns: null, txnsLoading: true })).toBe(false);
    // A refresh: transactions on screen while new ones load.
    expect(ready({ ...base, txnsLoading: true })).toBe(true);
    // Transactions that couldn't be loaded: what can be shown without them is.
    expect(ready({ ...base, txns: null })).toBe(true);
    expect(ready({ ...base, contributionsPending: true })).toBe(false);
  });

  test('a year that wasn’t a whole year says from when', () => {
    const short = inputs({ flows: { ...flows, from: '2026-07-01', days: 98, scaled: true } });
    expect(home(plan(), short)).toContain('savings rate, since Jul 1, 2026');
  });
});

describe('Home stays fast', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf8');
  const imports = (src: string) => [...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

  test('the card runs no simulation, and its code is loaded after Home paints', () => {
    const card = read('components/FiProgressCard.tsx');
    for (const engine of ['@/lib/fire/simulate', '@/lib/fire/jobs', '@/lib/fire/us-market', '@/lib/fire/history-data', './plan-runner']) {
      expect(imports(card)).not.toContain(engine);
    }
    expect(card).not.toMatch(/\b(simulate|successGrid|createPlanRunner|runPlanJob)\(/);
    // Home imports the loader, which imports the card only with import(),
    // so the card and the Plan's modules are a chunk of their own.
    const dashboard = read('components/Dashboard.tsx');
    expect(imports(dashboard)).toContain('./FiProgressLoader');
    expect(imports(dashboard)).not.toContain('./FiProgressCard');
    const loader = read('components/FiProgressLoader.tsx');
    expect(loader).toContain("import('./FiProgressCard')");
    expect(loader).toMatch(/import type \{ FiProgressProps \} from '\.\/FiProgressCard'/);
  });

  test('a failed load of the card is forgotten, so the next try fetches it again', async () => {
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('chunk failed'));
    };
    await expect(loadFiProgress(failing)).rejects.toThrow('chunk failed');
    await expect(loadFiProgress(failing)).rejects.toThrow('chunk failed');
    expect(calls).toBe(2);
    const mod = await loadFiProgress(() => import('@/components/FiProgressCard'));
    expect(typeof mod.default).toBe('function');
    expect(await loadFiProgress(failing)).toBe(mod);
    expect(calls).toBe(2);
  });
});
