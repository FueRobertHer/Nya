import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLAN, parsePlan, repairPlan, upgradePlan, type FirePlan } from '@/lib/fire/plan';
import { DEFAULT_PLAN_V2, basePlanOf, isFirePlanV2, isStoredPlan, parsePlanV2, planOf, repairPlanV2, toStored, upgradeStoredPlan, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { expensesOf, incomeOf, itemFromEvent, withExpenses, withIncome } from '@/lib/fire/items';
import * as old from './fixtures/release-before/fire/plan';
import { genPlan, rand } from './plan-gen';

// FirePlan version 2 (lib/fire/plan-v2.ts): read and checked, upgraded in
// memory from version 1 and sent back as version 1, repaired, and the
// store's upgrade, which never changes the version.

describe('version 1 in memory and back', () => {
  test('toStored(planOf(v1), 1) is v1 exactly, for every plan parsePlan takes', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const v1 = genPlan(rand(seed), true);
      const parsed = parsePlan(v1);
      expect('plan' in parsed).toBe(true);
      const p = (parsed as { plan: FirePlan }).plan;
      const v2 = planOf(p);
      expect(isFirePlanV2(v2)).toBe(true);
      expect(parsePlanV2(v2)).toEqual({ plan: v2 });
      expect(toStored(v2, 1)).toEqual({ plan: p });
    }
  });

  test('edits through the cards’ views keep each list’s order, whatever the items’ order', () => {
    // No incomes and two one-offs, then an income: the items interleave.
    const v1: FirePlan = { ...DEFAULT_PLAN, age: 40, expenses: [{ id: 'a', label: 'A', amount: 1, atAge: 50 }, { id: 'b', label: 'B', amount: 2, atAge: 45 }] };
    let p = planOf(v1);
    p = withIncome(p, [{ id: 'i', label: 'I', amount: 3, fromAge: 67, inflationAdjusted: true }]);
    p = withExpenses(p, [...expensesOf(p), { id: 'c', label: 'C', amount: 4, atAge: 60 }]);
    const back = toStored(p, 1) as { plan: FirePlan };
    expect(back.plan.income.map((x) => x.id)).toEqual(['i']);
    expect(back.plan.expenses.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(planOf(back.plan).items.map((x) => x.id)).toEqual(['i', 'a', 'b', 'c']);
    expect(incomeOf(planOf(back.plan))).toEqual(incomeOf(p));
    expect(expensesOf(planOf(back.plan))).toEqual(expensesOf(p));
  });

  test('a plan version 1 can’t hold is refused, with why', () => {
    const p = planOf(DEFAULT_PLAN);
    expect(toStored({ ...p, items: [itemFromEvent({ id: 'r', kind: 'raise', label: 'Raise', fromAge: 40, yearly: 1 })] }, 1)).toEqual({ error: 'This plan holds items only a newer version of Nya can save.' });
    expect(toStored({ ...p, stopAtFi: true }, 1)).toEqual({ error: 'This plan holds settings only a newer version of Nya can save.' });
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, label: 'I', amount: 1, fromAge: 60, inflationAdjusted: true }));
    expect(toStored(withIncome(p, six), 1)).toEqual({ error: 'A plan takes 5 incomes at most.' });
    expect(toStored({ ...p, stopAtFi: true }, 2)).toEqual({ plan: { ...p, stopAtFi: true } });
  });
});

describe('reading and checking version 2', () => {
  const v2 = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...DEFAULT_PLAN_V2, age: 40, targetAge: 55, ...over });

  test('the fields it shares with version 1 by version 1’s reader, then its own', () => {
    expect(parsePlanV2(v2({ withdrawalRate: 0.5 }))).toMatchObject({ field: 'withdrawalRate' });
    expect(parsePlanV2(v2({ partnerAge: 12 }))).toMatchObject({ field: 'partnerAge' });
    expect(parsePlanV2(v2({ fiNumber: 0 }))).toMatchObject({ field: 'fiNumber' });
    expect(parsePlanV2({ ...v2(), income: [] })).toMatchObject({ field: 'plan' });
    expect(parsePlanV2({ ...v2(), version: 1 })).toMatchObject({ field: 'version' });
    // The stop before today's age is refused at an age, kept under stop at FI.
    expect(parsePlanV2(v2({ age: 60, targetAge: 50 }))).toMatchObject({ field: 'targetAge' });
    expect(parsePlanV2(v2({ age: 60, targetAge: 50, stopAtFi: true }))).toEqual({ plan: v2({ age: 60, targetAge: 50, stopAtFi: true }) });
    expect(parsePlanV2(v2({ fiNumber: 1_500_000, partnerAge: 38 }))).toEqual({ plan: v2({ fiNumber: 1_500_000, partnerAge: 38 }) });
  });

  test('stored, its shape and types; either version is a stored plan', () => {
    expect(isFirePlanV2(v2({ fiNumber: -1, partnerAge: 500 }))).toBe(true);
    expect(isFirePlanV2({ ...v2(), items: [{}] })).toBe(false);
    expect(isStoredPlan(DEFAULT_PLAN)).toBe(true);
    expect(isStoredPlan(DEFAULT_PLAN_V2)).toBe(true);
    expect(isStoredPlan({ ...DEFAULT_PLAN, version: 3 })).toBe(false);
  });

  test('the store’s upgrade never changes the version, and reads version 1 as the release before does', () => {
    for (let seed = 1; seed <= 80; seed++) {
      const p = genPlan(rand(seed));
      const { planFunding: _f, ...older } = p;
      const shapes: unknown[] = [p, older, { ...older, bankFunded: ['acc-1'] }, { ...p, horizon: undefined }, 'x', null, [1]];
      for (const s of shapes) expect(upgradeStoredPlan(s)).toEqual(old.upgradePlan(s));
    }
    const { fiNumber: _fi, ...missing } = DEFAULT_PLAN_V2;
    expect(upgradeStoredPlan(missing)).toEqual(DEFAULT_PLAN_V2);
    expect(upgradePlan(DEFAULT_PLAN_V2)).toBe(DEFAULT_PLAN_V2);
  });
});

describe('repair', () => {
  test('a version 1 plan is repaired by today’s repair, then held as version 2', () => {
    // An amount of 0 and a tab in a name, which version 1 takes.
    const v1: FirePlan = { ...DEFAULT_PLAN, income: [{ id: 'a', label: 'Odd\tname', amount: 0, fromAge: 67, inflationAdjusted: true }] };
    expect(basePlanOf(v1)).toEqual({ plan: planOf(v1), fixed: [] });
    for (let seed = 1; seed <= 120; seed++) {
      const p = genPlan(rand(seed), true);
      const stored = { ...p, withdrawalRate: seed % 3 === 0 ? 0.5 : p.withdrawalRate, income: seed % 4 === 0 ? [...p.income, { ...p.income[0], id: 'zz', fromAge: 200 }].filter(Boolean) : p.income };
      const r = repairPlan(stored as FirePlan);
      expect(old.repairPlan(stored as never)).toEqual(r as never);
      expect(basePlanOf(stored as FirePlan)).toEqual({ plan: planOf(r.plan), fixed: r.fixed });
    }
  });

  test('a version 2 plan drops what its checks refuse, naming an income or one-off as version 1 did', () => {
    const p = planOf({ ...DEFAULT_PLAN, age: 40, income: [{ id: 'a', label: 'Pension', amount: 5, fromAge: 300, inflationAdjusted: true }] });
    const r = repairPlanV2({ ...p, fee: 9 });
    expect(r.plan.items).toEqual([]);
    expect(r.plan.fee).toBe(DEFAULT_PLAN_V2.fee);
    // The fields it shares with version 1 are checked first.
    expect(r.fixed).toEqual([{ field: 'fee' }, { field: 'income', item: { label: 'Pension', amount: 5, age: 300 } }]);
    expect(basePlanOf(null)).toEqual({ plan: DEFAULT_PLAN_V2, fixed: [] });
  });
});
