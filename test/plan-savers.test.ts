import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planSavers } from '@/components/plan-savers';
import { DEFAULT_PLAN_V2, type FirePlanV2 } from '@/lib/fire/plan-v2';

// Every way the Plan tab saves (components/plan-savers.ts): with a copy open
// nothing reaches your plan but the plans checked in Also change it in, with
// your plan open nothing reaches a copy unasked, and the tab saves through
// nothing else.

const ROOT = join(import.meta.dir, '..');
const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...DEFAULT_PLAN_V2, ...over });

function recorders() {
  const toPlan: [FirePlanV2, readonly string[]][] = [];
  const toCopy: [FirePlanV2, readonly string[]][] = [];
  return {
    toPlan,
    toCopy,
    savePlan: async (p: FirePlanV2, also: readonly string[] = []) => (toPlan.push([p, also]), true),
    saveCopy: async (p: FirePlanV2, also: readonly string[] = []) => (toCopy.push([p, also]), true as const),
  };
}

const noMore = async () => true as const;

describe('with a copy open', () => {
  // Since rollout 6d the method and the mix are fields of the Assumptions
  // sheet, a form like the others: "Use my allocation" opens it.
  test('the forms save to it, with the plans checked; the repair and the allocation settings have no saver', async () => {
    const r = recorders();
    const shown = plan({ targetAge: 50 });
    const s = planSavers({ copy: r.saveCopy, savePlan: r.savePlan, repaired: plan({ withdrawalRate: 0.04 }), more: noMore });
    expect(await s.form({ ...shown, withdrawalRate: 0.035 })).toBe(true);
    expect(await s.form({ ...shown, stocksPct: 60 }, ['main'])).toBe(true);
    expect(s.repair).toBeNull();
    expect(s.allocationSettings).toBe(false);
    expect(s.taxFacts).toBe(false);
    expect(r.toPlan).toEqual([]);
    expect(r.toCopy.map(([p, also]) => [p.withdrawalRate, p.stocksPct, also])).toEqual([
      [0.035, 75, []],
      [0.04, 60, ['main']],
    ]);
  });

  test('a refusal’s reason reaches the form', async () => {
    const s = planSavers({ copy: async () => 'Your age is the same in every plan', savePlan: async () => true, repaired: null, more: noMore });
    expect(await s.form(plan())).toBe('Your age is the same in every plan');
  });
});

describe('with your plan open', () => {
  test('everything saves your plan; the repair saves the repaired plan, never the one on screen', async () => {
    const r = recorders();
    const repaired = plan({ withdrawalRate: 0.04, age: 41 });
    const s = planSavers({ copy: null, savePlan: r.savePlan, repaired, more: noMore });
    await s.form(plan({ age: 42 }));
    await s.form(plan({ stocksPct: 50, method: 'monte-carlo' }), ['copy-1']);
    s.repair?.();
    await Promise.resolve();
    expect(s.allocationSettings).toBe(true);
    expect(r.toCopy).toEqual([]);
    expect(r.toPlan.map(([p, also]) => [p.age, p.stocksPct, p.method, also])).toEqual([
      [42, 75, 'historical', []],
      [null, 50, 'monte-carlo', ['copy-1']],
      [41, 75, 'historical', []],
    ]);
    expect(r.toPlan[2][0]).toBe(repaired);
  });

  test('with no repair waiting there is none to save', () => {
    expect(planSavers({ copy: null, savePlan: async () => true, repaired: null, more: noMore }).repair).toBeNull();
    expect(planSavers({ copy: null, savePlan: async () => true, repaired: null, more: noMore }).taxFacts).toBe(true);
  });
});

describe('the Plan tab saves through nothing else', () => {
  const tab = readFileSync(join(ROOT, 'components/PlanTab.tsx'), 'utf8');
  const code = tab.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  test('your plan’s store and the plans’ save are handed to the savers, and saved through nowhere else', () => {
    expect(code.match(/store\.save\b/g)).toEqual(['store.save']);
    expect(code.match(/plansClient\.save\b/g)).toEqual(['plansClient.save']);
    expect(code).toMatch(/planSavers\(\{ copy: entry \? saveShown : null, savePlan: saveShown, repaired: repairing \? repair\.plan : null, more: saveMore \}\)/);
    // savePlanIn: the store's save of your plan alone, version 2, but never a
    // first typed amount without the currency its figures are in
    // (lib/fire/plan-currency.ts). The facts it sent are the page's once
    // saved (test/plan-inputs-view.test.tsx).
    expect(code).toMatch(
      /const savePlanIn = async \(next: FirePlanV2, tax\?: TaxChoices\): Promise<boolean \| string> => \{\n    const wait = firstAmountWait\(next, tax\);\n    if \(wait\) return wait;\n    const saved = await store\.save\(next\);\n    if \(saved\) factsWere\.current = factsOf\(next\);\n    return saved;\n  \};/,
    );
    // saveShown: your plan alone through the store; a copy, or Also change
    // it in, through the plans' save, all together.
    expect(code).toMatch(/const saveShown = async \([^)]*\): Promise<boolean \| string> => \{\n    if \(!entry && also\.length === 0\) return savePlanIn\(next\);/);
    expect(code).toMatch(/return savePlans\(saves\);\n  \};/);
    // Every save the cards and forms are given comes from the savers.
    // The drawer's forms save through the savers of the plan they were
    // opened for (test/plan-tab-copies.test.tsx renders that lifecycle).
    expect(code).toContain('target === shownForRef.current ? saversRef.current.form(next, also)');
    expect(code).toContain('onSave={savers.repair}');
    // The allocation card's "Use my allocation" opens the Assumptions sheet,
    // whose save is the drawer's, above.
    expect(code).toContain("open({ kind: 'assumptions', at: 'mix', mix }, 'mix')");
    expect(code).toContain('settingsLocked={!savers.allocationSettings}');
    // And nothing posts to the Plan's routes itself (its currency alone is
    // recorded through components/plan-currency-client.ts, below; the plans
    // through components/plan-list.ts).
    expect(code.match(/['"`]\/api\/fire-plan['"`]/g)).toEqual(["'/api/fire-plan'"]);
    expect(code).not.toMatch(/\/api\/plans/);
    expect(code).not.toMatch(/fetch\(/);
  });

  test('the Plan’s currency is recorded alone, for the plan as stored, and never with a plan of the page’s', () => {
    const text = readFileSync(join(ROOT, 'components/plan-currency-client.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(text.match(/method: '(\w+)'/g)).toEqual(["method: 'POST'"]);
    // What it sends: the currency, the amounts it is for, and whether it is the person's answer.
    expect(text.match(/body: JSON\.stringify\(([^\n]*)\),\n/)?.[1]).toBe('{ currency, amounts, ...(answered ? { answered: true } : {}) }');
  });

  test('the cards it renders save only through what they are given', () => {
    for (const file of ['components/PlansSheet.tsx', 'components/PlanTimeline.tsx', 'components/PlanItemSheet.tsx', 'components/PlanCompare.tsx', 'components/PlanBar.tsx', 'components/AlsoChange.tsx']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect([file, /fire-plan|\/api\/plans|fetch\(/.test(text.replace(/\/\/.*$/gm, ''))]).toEqual([file, false]);
    }
    // The allocation card saves its own settings and reads its history, and
    // never the plan: since 6d it has no way to (its mix opens the sheet).
    const alloc = readFileSync(join(ROOT, 'components/AllocationCard.tsx'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(alloc).not.toMatch(/fire-plan|onSavePlan/);
    expect(alloc.match(/fetch\(/g)).toEqual(['fetch(']);
    expect(alloc).toContain("fetch('/api/allocation-history'");
  });
});
