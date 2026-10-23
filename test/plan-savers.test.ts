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
  test('the forms and Use my allocation save to it; the method, the repair and the allocation settings have no saver', async () => {
    const r = recorders();
    const shown = plan({ targetAge: 50 });
    const s = planSavers({ scenario: r.saveScenario, savePlan: r.savePlan, plan: plan(), repaired: plan({ withdrawalRate: 0.04 }) });
    expect(await s.form({ ...shown, withdrawalRate: 0.035 })).toBe(true);
    expect(await s.allocationMix({ ...shown, stocksPct: 60 })).toBe(true);
    expect(s.method).toBeNull();
    expect(s.repair).toBeNull();
    expect(s.allocationSettings).toBe(false);
    expect(r.toPlan).toEqual([]);
    expect(r.toScenario.map((p) => [p.withdrawalRate, p.stocksPct])).toEqual([
      [0.035, 75],
      [0.04, 60],
    ]);
  });

  test('a refusal’s reason reaches the form; Use my allocation hears only that it wasn’t saved', async () => {
    const s = planSavers({ scenario: async () => 'Your age is the same in every plan', savePlan: async () => true, plan: plan(), repaired: null });
    expect(await s.form(plan())).toBe('Your age is the same in every plan');
    expect(await s.allocationMix(plan())).toBe(false);
  });
});

describe('with the Plan open', () => {
  test('everything saves the Plan; the repair saves the repaired Plan, never the one on screen', async () => {
    const r = recorders();
    const repaired = plan({ withdrawalRate: 0.04, age: 41 });
    const s = planSavers({ scenario: null, savePlan: r.savePlan, plan: plan({ age: 41 }), repaired });
    await s.form(plan({ age: 42 }));
    await s.allocationMix(plan({ stocksPct: 50 }));
    s.method?.('monte-carlo');
    s.repair?.();
    await Promise.resolve();
    expect(s.allocationSettings).toBe(true);
    expect(r.toScenario).toEqual([]);
    expect(r.toPlan.map((p) => [p.age, p.stocksPct, p.method])).toEqual([
      [42, 75, 'historical'],
      [null, 50, 'historical'],
      [41, 75, 'monte-carlo'],
      [41, 75, 'historical'],
    ]);
    expect(r.toPlan[3]).toBe(repaired);
  });

  test('with no repair waiting there is none to save', () => {
    expect(planSavers({ scenario: null, savePlan: async () => true, plan: plan(), repaired: null }).repair).toBeNull();
  });
});

describe('the Plan tab saves through nothing else', () => {
  const tab = readFileSync(join(ROOT, 'components/PlanTab.tsx'), 'utf8');
  const code = tab.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  test('the Plan’s store is handed to the savers, and saved through nowhere else', () => {
    expect(code.match(/store\.save\b/g)).toEqual(['store.save']);
    expect(code).toMatch(/planSavers\(\{ scenario: saveToScenario, savePlan: store\.save, plan: basePlan, repaired: repairing \? repair\.plan : null \}\)/);
    // Every save the cards and forms are given comes from the savers.
    expect(code).toContain('onSave: savers.form');
    expect(code).toContain('onSavePlan={savers.allocationMix}');
    expect(code).toContain('onMethod={savers.method}');
    expect(code).toContain('onSave={savers.repair}');
    expect(code).toContain('settingsLocked={!savers.allocationSettings}');
    // And nothing posts to the Plan's route itself.
    expect(code.match(/['"`]\/api\/fire-plan['"`]/g)).toEqual(["'/api/fire-plan'"]);
    expect(code).not.toMatch(/fetch\(/);
  });

  test('the cards it renders save only through what they are given', () => {
    for (const file of ['components/PlanScenarios.tsx', 'components/PlanEvents.tsx', 'components/PlanCompare.tsx']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect([file, /fire-plan|fetch\(/.test(text.replace(/\/\/.*$/gm, ''))]).toEqual([file, false]);
    }
  });
});
