import { describe, expect, test } from 'bun:test';
import { planGrowth } from '@/lib/fire/account-growth';
import { yearsToTarget } from '@/lib/fire/fi';
import { fiView, type AccountRate, type Measured } from '@/lib/fire/plan';
import { DEFAULT_PLAN_V2, basePlanOf, isFirePlanV2, parsePlanV2, repairPlanV2, toStored, upgradeStoredPlan, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { planFigures } from '@/lib/fire/plan-figures';
import { planPath } from '@/lib/fire/path';
import { IN_WALK } from '@/lib/fire/compile';
import { changedSince, isSavedPlan, parseSavedDraft, plannedAt, savedGrowth, type SavedPlan } from '@/lib/fire/saved-plan';
import { copyDiffParts, sameChange } from '@/components/plan-diff';

const rate = (account_id: string, growth: number | null, yieldRate: number | null = null): AccountRate => ({ account_id, growth, yield: yieldRate });
const measured = (accounts: { id: string; value: number }[], over: Partial<Measured> = {}): Measured => ({
  spending: 40_000,
  savings: 20_000,
  assets: accounts.reduce((s, a) => s + a.value, 0),
  accounts,
  ...over,
});
const PLAN: FirePlanV2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: 55 };
const TWO = [
  { id: 'brokerage', value: 300_000 },
  { id: 'ira', value: 100_000 },
];

describe('the growth a plan runs at', () => {
  test('the plan’s own rate, to the bit, wherever no counted account has its own', () => {
    const cases: [Pick<FirePlanV2, 'realReturn' | 'assets' | 'accounts'>, Measured][] = [
      [PLAN, measured(TWO)],
      [{ ...PLAN, accounts: [] }, measured(TWO)],
      // Only dividends of its own.
      [{ ...PLAN, accounts: [rate('ira', null, 0.03)] }, measured(TWO)],
      // An account since closed or hidden: kept, and ignored.
      [{ ...PLAN, accounts: [rate('gone', 0.09)] }, measured(TWO)],
      // Typed assets: no accounts make them up.
      [{ ...PLAN, assets: 500_000, accounts: [rate('ira', 0.09)] }, measured(TWO)],
      // Not measured, or nothing to measure.
      [{ ...PLAN, accounts: [rate('ira', 0.09)] }, measured(TWO, { assets: null, unmeasured: ['assets'] })],
      [{ ...PLAN, accounts: [rate('ira', 0.09)] }, measured([])],
      // Nothing counted above zero.
      [{ ...PLAN, accounts: [rate('ira', 0.09)] }, measured([{ id: 'ira', value: 0 }, { id: 'brokerage', value: -5_000 }])],
    ];
    for (const [plan, m] of cases) expect(planGrowth(plan, m)).toEqual({ growth: plan.realReturn, own: 0 });
  });

  test('the mean of each account’s rate, its own or the plan’s, weighted by what it adds', () => {
    const r = planGrowth({ ...PLAN, accounts: [rate('ira', 0.09)] }, measured(TWO));
    expect(r.own).toBe(1);
    expect(r.growth).toBeCloseTo((300_000 * 0.05 + 100_000 * 0.09) / 400_000, 14);
    const both = planGrowth({ ...PLAN, accounts: [rate('brokerage', 0.07), rate('ira', 0.03)] }, measured(TWO));
    expect(both.own).toBe(2);
    expect(both.growth).toBeCloseTo(0.06, 14);
  });

  test('every account at the plan’s rate as its own is the plan’s rate exactly, whatever the balances', () => {
    for (const g of [0.05, 0.047, -0.013, 0.1234]) {
      const values = [123_456.78, 9_999.01, 1, 77_777.77, 0.33];
      const m = measured(values.map((value, i) => ({ id: `a${i}`, value })));
      const r = planGrowth({ ...PLAN, realReturn: g, accounts: values.map((_, i) => rate(`a${i}`, g)) }, m);
      expect(r).toEqual({ growth: g, own: values.length });
    }
  });

  test('a balance below zero weighs nothing, and the order accounts arrive in moves no digit', () => {
    const plan = { ...PLAN, accounts: [rate('a', 0.08), rate('c', 0.02)] };
    const accounts = [
      { id: 'a', value: 100_000.1 },
      { id: 'b', value: 33_333.3 },
      { id: 'c', value: 70_000.7 },
      { id: 'd', value: -20_000 },
    ];
    const one = planGrowth(plan, measured(accounts));
    expect(one.growth).toBeCloseTo((100_000.1 * 0.08 + 33_333.3 * 0.05 + 70_000.7 * 0.02) / (100_000.1 + 33_333.3 + 70_000.7), 14);
    expect(planGrowth(plan, measured([...accounts].reverse()))).toEqual(one);
    expect(planGrowth(plan, measured([accounts[2], accounts[0], accounts[3], accounts[1]]))).toEqual(one);
  });

  test('fiView reads it for years to FI, Coast FI and the balance at the stop', () => {
    const plan = { ...PLAN, accounts: [rate('ira', 0.09)] };
    const m = measured(TWO);
    const v = fiView(plan, m);
    const g = planGrowth(plan, m).growth;
    expect(v.growth).toBe(g);
    expect(v.ownRates).toBe(1);
    expect(v.yearsToFi).toBe(yearsToTarget(400_000, 20_000, g, v.fiNumber!));
    expect(v.yearsToFi).toBeLessThan(fiView(PLAN, m).yearsToFi!);
    expect(v.coast!.number).toBeLessThan(fiView(PLAN, m).coast!.number);
    expect(v.atTargetAge).toBeGreaterThan(fiView(PLAN, m).atTargetAge!);
  });

  test('the figures and the path run at it: the path reaches the balance at the stop the view says', () => {
    const plan = { ...PLAN, accounts: [rate('ira', 0.09)] };
    const f = planFigures(plan, measured(TWO), { count: IN_WALK });
    if ('refused' in f) throw new Error('refused');
    expect(f.view.growth).toBe(fiView(plan, measured(TWO)).growth);
    const p = planPath(f)!;
    expect(p.points[p.points.length - 1].balance).toBeCloseTo(f.view.atTargetAge!, 6);
  });
});

describe('accounts’ own rates, as a plan holds them', () => {
  test('a save keeps one entry an account, the last said, none with neither rate, sorted by id; none is absent', () => {
    const r = parsePlanV2({ ...PLAN, accounts: [rate('z', 0.07), rate('a', 0.02, 0.01), rate('m', null, null), rate('z', 0.06)] });
    expect('plan' in r && r.plan.accounts).toEqual([rate('a', 0.02, 0.01), rate('z', 0.06)]);
    for (const accounts of [[], [rate('m', null)]]) {
      const empty = parsePlanV2({ ...PLAN, accounts });
      expect('plan' in empty && Object.hasOwn(empty.plan, 'accounts')).toBe(false);
    }
  });

  test('a save takes rates in range only, ids as accounts carry them, and at most 50', () => {
    const refuse = (accounts: unknown) => 'error' in parsePlanV2({ ...PLAN, accounts });
    expect(refuse([rate('a', 0.16)])).toBe(true);
    expect(refuse([rate('a', -0.06)])).toBe(true);
    expect(refuse([rate('a', null, 0.21)])).toBe(true);
    expect(refuse([rate('a', null, -0.01)])).toBe(true);
    expect(refuse([rate('a b', 0.05)])).toBe(true);
    expect(refuse([{ account_id: 'a', growth: 0.05 }])).toBe(true);
    expect(refuse([{ ...rate('a', 0.05), extra: 1 }])).toBe(true);
    expect(refuse('a')).toBe(true);
    expect(refuse(Array.from({ length: 51 }, (_, i) => rate(`a${i}`, 0.05)))).toBe(true);
    expect(refuse(Array.from({ length: 50 }, (_, i) => rate(`a${i}`, 0.05)))).toBe(false);
    expect(refuse([rate('acc_1.x:y-2', 0.15, 0.2), rate('b', -0.05, 0)])).toBe(false);
  });

  test('stored, the shape and types only; the upgrade leaves it as it is', () => {
    const stored = { ...PLAN, accounts: [rate('a b', 0.4, 0.9)] };
    expect(isFirePlanV2(stored)).toBe(true);
    expect(upgradeStoredPlan(stored)).toBe(stored);
    expect(isFirePlanV2({ ...PLAN, accounts: [{ account_id: 1, growth: 0.05, yield: null }] })).toBe(false);
    expect(isFirePlanV2({ ...PLAN, accounts: [{ account_id: 'a', growth: '5%', yield: null }] })).toBe(false);
    expect(isFirePlanV2({ ...PLAN, accounts: [{ account_id: 'a', growth: 0.05 }] })).toBe(false);
    expect(isFirePlanV2({ ...PLAN, accounts: {} })).toBe(false);
  });

  test('a repair leaves out the entries it can’t use, named once, and never resets the plan', () => {
    const plan = { ...PLAN, spending: 48_000, accounts: [rate('a', 0.07), rate('b', 0.4), rate('c', null, 0.5)] };
    const { plan: fixed, fixed: what } = repairPlanV2(plan);
    expect(fixed.accounts).toEqual([rate('a', 0.07)]);
    expect(fixed.spending).toBe(48_000);
    expect(what).toEqual([{ field: 'accounts' }]);
    const all = repairPlanV2({ ...PLAN, spending: 48_000, accounts: [rate('b', 0.4)] });
    expect(Object.hasOwn(all.plan, 'accounts')).toBe(false);
    expect(all.plan.spending).toBe(48_000);
    const long = repairPlanV2({ ...PLAN, accounts: Array.from({ length: 60 }, (_, i) => rate(`a${String(i).padStart(2, '0')}`, 0.05)) });
    expect(long.plan.accounts).toHaveLength(50);
    expect(basePlanOf({ ...PLAN, accounts: [rate('b', 0.4)] }).fixed).toEqual([{ field: 'accounts' }]);
  });

  test('version 1 can’t hold them', () => {
    expect(toStored({ ...PLAN, accounts: [rate('a', 0.07)] }, 1)).toEqual({ error: 'This plan holds settings only a newer version of Nya can save.' });
    expect('plan' in toStored(PLAN, 1)).toBe(true);
  });

  test('a copy says how its accounts’ rates differ, and Also change it in passes none on', () => {
    const money = (n: number) => `$${n}`;
    const main = { ...PLAN, accounts: [rate('a', 0.07)] };
    expect(copyDiffParts(main, main, money)).toEqual([]);
    expect(copyDiffParts(main, PLAN, money)).toEqual(['Account growth differs']);
    expect(copyDiffParts(main, { ...PLAN, accounts: [rate('a', 0.07, 0.02)] }, money)).toEqual(['Account dividends differ']);
    const changed = sameChange(PLAN, { ...PLAN, spending: 50_000, accounts: [rate('a', 0.09)] }, main);
    expect(changed.spending).toBe(50_000);
    expect(changed.accounts).toEqual([rate('a', 0.07)]);
  });
});

describe('a saved plan’s growth', () => {
  const draft = { plan: PLAN, savings: 20_000, currency: 'USD', inflation: 0.03 };
  const saved = (over: Partial<SavedPlan> = {}): SavedPlan => ({ version: 1, ...draft, day: '2026-01-01', savedAt: '2026-01-01T00:00:00Z', rev: 'r1', ...over });

  test('kept only where it differs from the plan’s, and in range', () => {
    expect(parseSavedDraft({ ...draft, growth: 0.061 })).toEqual({ ok: { ...draft, growth: 0.061 } });
    expect(parseSavedDraft({ ...draft, growth: PLAN.realReturn })).toEqual({ ok: draft });
    expect(parseSavedDraft(draft)).toEqual({ ok: draft });
    expect('error' in parseSavedDraft({ ...draft, growth: 0.2 })).toBe(true);
    expect('error' in parseSavedDraft({ ...draft, growth: '6%' })).toBe(true);
    expect('error' in parseSavedDraft({ ...draft, other: 1 })).toBe(true);
  });

  test('read back as a number, or absent', () => {
    expect(isSavedPlan(saved())).toBe(true);
    expect(isSavedPlan(saved({ growth: 0.061 }))).toBe(true);
    expect(isSavedPlan({ ...saved(), growth: null })).toBe(false);
    expect(isSavedPlan({ ...saved(), other: 1 })).toBe(false);
  });

  test('the comparison grows at it, else at the plan’s rate', () => {
    expect(savedGrowth(saved())).toBe(PLAN.realReturn);
    expect(savedGrowth(saved({ growth: 0.061 }))).toBe(0.061);
    const start = { day: '2026-01-01', total: 400_000 };
    const at = (s: SavedPlan) => plannedAt(s, start, '2031-01-01');
    expect(at(saved({ growth: 0.061 }))).toBe(at(saved({ plan: { ...PLAN, realReturn: 0.061 } })));
    expect(at(saved({ growth: 0.061 }))!).toBeGreaterThan(at(saved())!);
  });

  test('a change to an account’s own growth is a change to the growth it rests on; to its dividends, or its balance, isn’t', () => {
    const was = saved({ plan: { ...PLAN, accounts: [rate('a', 0.07)] }, growth: 0.061 });
    expect(changedSince(was, { ...PLAN, accounts: [rate('a', 0.07)] })).toEqual([]);
    expect(changedSince(was, { ...PLAN, accounts: [rate('a', 0.07, 0.02)] })).toEqual([]);
    expect(changedSince(was, { ...PLAN, accounts: [rate('a', 0.08)] })).toEqual(['growth after inflation']);
    expect(changedSince(was, PLAN)).toEqual(['growth after inflation']);
    expect(changedSince(saved(), { ...PLAN, accounts: [rate('a', 0.08)] })).toEqual(['growth after inflation']);
  });
});
