import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planSavers } from '@/components/plan-savers';
import { DEFAULT_PLAN, type FirePlan } from '@/lib/fire/plan';

// Every way the Plan tab saves (components/plan-savers.ts): with a scenario
// open nothing reaches the Plan, with the Plan open nothing reaches a
// scenario, and the tab saves through nothing else.

const ROOT = join(import.meta.dir, '..');
const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });

function recorders() {
  const toPlan: FirePlan[] = [];
  const toScenario: FirePlan[] = [];
  return {
    toPlan,
    toScenario,
    savePlan: async (p: FirePlan) => (toPlan.push(p), true),
    saveScenario: async (p: FirePlan) => (toScenario.push(p), true as const),
  };
}

describe('with a scenario open', () => {
  // Since rollout 6d the method and the mix are fields of the Assumptions
  // sheet, a form like the others: "Use my allocation" opens it.
  test('the forms save to it; the repair and the allocation settings have no saver', async () => {
    const r = recorders();
    const shown = plan({ targetAge: 50 });
    const s = planSavers({ scenario: r.saveScenario, savePlan: r.savePlan, repaired: plan({ withdrawalRate: 0.04 }) });
    expect(await s.form({ ...shown, withdrawalRate: 0.035 })).toBe(true);
    expect(await s.form({ ...shown, stocksPct: 60 })).toBe(true);
    expect(s.repair).toBeNull();
    expect(s.allocationSettings).toBe(false);
    expect(r.toPlan).toEqual([]);
    expect(r.toScenario.map((p) => [p.withdrawalRate, p.stocksPct])).toEqual([
      [0.035, 75],
      [0.04, 60],
    ]);
  });

  test('a refusal’s reason reaches the form', async () => {
    const s = planSavers({ scenario: async () => 'Your age is the same in every plan', savePlan: async () => true, repaired: null });
    expect(await s.form(plan())).toBe('Your age is the same in every plan');
  });
});

describe('with the Plan open', () => {
  test('everything saves the Plan; the repair saves the repaired Plan, never the one on screen', async () => {
    const r = recorders();
    const repaired = plan({ withdrawalRate: 0.04, age: 41 });
    const s = planSavers({ scenario: null, savePlan: r.savePlan, repaired });
    await s.form(plan({ age: 42 }));
    await s.form(plan({ stocksPct: 50, method: 'monte-carlo' }));
    s.repair?.();
    await Promise.resolve();
    expect(s.allocationSettings).toBe(true);
    expect(r.toScenario).toEqual([]);
    expect(r.toPlan.map((p) => [p.age, p.stocksPct, p.method])).toEqual([
      [42, 75, 'historical'],
      [null, 50, 'monte-carlo'],
      [41, 75, 'historical'],
    ]);
    expect(r.toPlan[2]).toBe(repaired);
  });

  test('with no repair waiting there is none to save', () => {
    expect(planSavers({ scenario: null, savePlan: async () => true, repaired: null }).repair).toBeNull();
  });
});

describe('the Plan tab saves through nothing else', () => {
  const tab = readFileSync(join(ROOT, 'components/PlanTab.tsx'), 'utf8');
  const code = tab.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  test('the Plan’s store is handed to the savers, and saved through nowhere else', () => {
    expect(code.match(/store\.save\b/g)).toEqual(['store.save']);
    expect(code).toMatch(/planSavers\(\{ scenario: saveToScenario, savePlan: savePlanIn, repaired: repairing \? repair\.plan : null \}\)/);
    // savePlanIn: the store's save, but never a first typed amount without
    // the currency its figures are in (lib/fire/plan-currency.ts).
    expect(code).toMatch(/const savePlanIn = async \(next: FirePlan\): Promise<boolean \| string> => \{[\s\S]*?return store\.save\(next\);\n  \};/);
    // Every save the cards and forms are given comes from the savers.
    // The drawer's forms save through the savers of the plan they were
    // opened for (test/plan-tab-scenarios.test.tsx renders that lifecycle).
    expect(code).toContain('target === shownForRef.current ? saversRef.current.form(next)');
    expect(code).toContain('onSave={savers.repair}');
    // The allocation card's "Use my allocation" opens the Assumptions sheet,
    // whose save is the drawer's, above.
    expect(code).toContain("open({ kind: 'assumptions', at: 'mix', mix }, 'mix')");
    expect(code).toContain('settingsLocked={!savers.allocationSettings}');
    // And nothing posts to the Plan's route itself (its currency alone is
    // recorded through components/plan-currency-client.ts, below).
    expect(code.match(/['"`]\/api\/fire-plan['"`]/g)).toEqual(["'/api/fire-plan'"]);
    expect(code).not.toMatch(/fetch\(/);
  });

  test('the Plan’s currency is recorded alone, for the plan as stored, and never with a plan of the page’s', () => {
    const text = readFileSync(join(ROOT, 'components/plan-currency-client.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(text.match(/method: '(\w+)'/g)).toEqual(["method: 'POST'"]);
    // What it sends: the currency, the amounts it is for, and whether it is the person's answer.
    expect(text.match(/body: JSON\.stringify\(([^\n]*)\),\n/)?.[1]).toBe('{ currency, amounts, ...(answered ? { answered: true } : {}) }');
  });

  test('the cards it renders save only through what they are given', () => {
    for (const file of ['components/PlanScenarios.tsx', 'components/PlanEvents.tsx', 'components/PlanCompare.tsx', 'components/PlanBar.tsx']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect([file, /fire-plan|fetch\(/.test(text.replace(/\/\/.*$/gm, ''))]).toEqual([file, false]);
    }
    // The allocation card saves its own settings and reads its history, and
    // never the plan: since 6d it has no way to (its mix opens the sheet).
    const alloc = readFileSync(join(ROOT, 'components/AllocationCard.tsx'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(alloc).not.toMatch(/fire-plan|onSavePlan/);
    expect(alloc.match(/fetch\(/g)).toEqual(['fetch(']);
    expect(alloc).toContain("fetch('/api/allocation-history'");
  });
});
