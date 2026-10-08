import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { Txn } from '@/components/MonthBreakdown';
import type { FirePlan } from '@/lib/fire/plan';
import type { AssetAccount, AssetInstitution, PlanContributions } from '@/lib/fire/inputs';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt, decrypt } = await import('@/lib/crypto');
const { StoredDataUnreadableError, readEncryptedJson, writeEncryptedJson } = await import('@/lib/stored-json');
const { UnreadableValueError } = await import('@/lib/repo');
const { firePlanStore } = await import('@/lib/fire-plan');
const { declaredStore } = await import('@/lib/stores');
const route = await import('@/app/api/fire-plan/route');
const { classify } = await import('@/lib/reencrypt');
const { DEFAULT_PLAN, enginePlan, fiView, isFirePlan, parsePlan, planYears, repairPlan, startAge, upgradePlan } = await import('@/lib/fire/plan');
const { trailingFlows, investedAssets, planFlow, unreadTransactions, isWorkplacePlan, workplaceSavings, transfersOut, TRAILING_DAYS, MATCH_DAYS } = await import('@/lib/fire/inputs');
const { isTransfer } = await import('@/components/MonthBreakdown');
const { fiNumber, yearsToTarget, coastFiNumber } = await import('@/lib/fire/fi');
const { historicalCycles } = await import('@/lib/fire/simulate');
const { usMarket } = await import('@/lib/fire/us-market');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });

describe('the stored plan’s validation', () => {
  test('the defaults are a valid plan, and a valid plan comes back as it went in', () => {
    expect(parsePlan(DEFAULT_PLAN)).toEqual({ plan: DEFAULT_PLAN });
    const full = plan({
      age: 35,
      targetAge: 50,
      spending: 48_000,
      savings: -1_000,
      assets: 250_000,
      includeCash: true,
      start: 'custom',
      startBalance: 900_000,
      horizon: 45,
      income: [{ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true }],
      expenses: [{ id: 'roof', label: 'Roof', amount: 30_000, atAge: 60 }],
    });
    expect(parsePlan(JSON.parse(JSON.stringify(full)))).toEqual({ plan: full });
  });

  test('how each workplace plan is paid into is kept by account id, the last said for each', () => {
    const r = parsePlan(
      plan({
        planFunding: [
          { account_id: 'acc_1', paidFrom: 'bank' },
          { account_id: 'manual_9bcb3f0c-5760', paidFrom: 'payroll' },
          { account_id: 'acc_1', paidFrom: 'payroll' },
        ],
      })
    );
    expect('plan' in r && r.plan.planFunding).toEqual([
      { account_id: 'manual_9bcb3f0c-5760', paidFrom: 'payroll' },
      { account_id: 'acc_1', paidFrom: 'payroll' },
    ]);
    expect('error' in parsePlan(plan({ planFunding: [{ account_id: 'has space', paidFrom: 'bank' }] }))).toBe(true);
    expect('error' in parsePlan(plan({ planFunding: [{ account_id: 'a', paidFrom: 'sometimes' } as never] }))).toBe(true);
    expect('error' in parsePlan(plan({ planFunding: Array.from({ length: 21 }, (_, i) => ({ account_id: `a${i}`, paidFrom: 'bank' as const })) }))).toBe(true);
  });

  test('labels are trimmed', () => {
    const r = parsePlan(plan({ expenses: [{ id: 'a', label: '  Car  ', amount: 1, atAge: 40 }] }));
    expect('plan' in r && r.plan.expenses[0].label).toBe('Car');
  });

  const bad: [string, unknown][] = [
    ['not an object', 'plan'],
    ['a list', []],
    ['null', null],
    ['another version', { ...DEFAULT_PLAN, version: 2 }],
    ['an unknown field', { ...DEFAULT_PLAN, extra: 1 }],
    ['a missing field', (() => { const { fee: _, ...rest } = DEFAULT_PLAN; return rest; })()],
    ['a fractional age', { ...DEFAULT_PLAN, age: 35.5 }],
    ['an age out of range', { ...DEFAULT_PLAN, age: 12 }],
    ['an age as text', { ...DEFAULT_PLAN, age: '35' }],
    ['negative spending', { ...DEFAULT_PLAN, spending: -1 }],
    ['absurd spending', { ...DEFAULT_PLAN, spending: 1e12 }],
    ['NaN savings', { ...DEFAULT_PLAN, savings: NaN }],
    ['infinite assets', { ...DEFAULT_PLAN, assets: Infinity }],
    ['a withdrawal rate of zero', { ...DEFAULT_PLAN, withdrawalRate: 0 }],
    ['a withdrawal rate as a percent', { ...DEFAULT_PLAN, withdrawalRate: 4 }],
    ['a tax rate over 60%', { ...DEFAULT_PLAN, taxRate: 0.7 }],
    ['an unknown method', { ...DEFAULT_PLAN, method: 'guess' }],
    ['an unknown rule', { ...DEFAULT_PLAN, rule: 'yolo' }],
    ['an unknown start', { ...DEFAULT_PLAN, start: 'later' }],
    ['a custom start with no balance', { ...DEFAULT_PLAN, start: 'custom', startBalance: null }],
    ['a horizon over 60 years', { ...DEFAULT_PLAN, horizon: 61 }],
    ['an allocation over 100%', { ...DEFAULT_PLAN, stocksPct: 80, bondsPct: 30 }],
    ['a fractional percent', { ...DEFAULT_PLAN, stocksPct: 75.5 }],
    ['an unknown rebalancing', { ...DEFAULT_PLAN, rebalance: 'daily' }],
    ['a fee over 3%', { ...DEFAULT_PLAN, fee: 0.05 }],
    ['a floor over 1', { ...DEFAULT_PLAN, floor: 1.1 }],
    ['a ceiling under 1', { ...DEFAULT_PLAN, ceiling: 0.9 }],
    ['a boolean as text', { ...DEFAULT_PLAN, includeCash: 'yes' }],
    ['too many incomes', { ...DEFAULT_PLAN, income: Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, label: 'x', amount: 1, fromAge: 60, inflationAdjusted: true })) }],
    ['an income with an extra field', { ...DEFAULT_PLAN, income: [{ id: 'a', label: 'x', amount: 1, fromAge: 60, inflationAdjusted: true, note: 'x' }] }],
    ['an income with an empty label', { ...DEFAULT_PLAN, income: [{ id: 'a', label: '  ', amount: 1, fromAge: 60, inflationAdjusted: true }] }],
    ['an income with a long label', { ...DEFAULT_PLAN, income: [{ id: 'a', label: 'x'.repeat(61), amount: 1, fromAge: 60, inflationAdjusted: true }] }],
    ['an income with a bad id', { ...DEFAULT_PLAN, income: [{ id: 'a b', label: 'x', amount: 1, fromAge: 60, inflationAdjusted: true }] }],
    ['a negative expense', { ...DEFAULT_PLAN, expenses: [{ id: 'a', label: 'x', amount: -5, atAge: 60 }] }],
    ['an expense at a fractional age', { ...DEFAULT_PLAN, expenses: [{ id: 'a', label: 'x', amount: 5, atAge: 60.5 }] }],
    ['too many expenses', { ...DEFAULT_PLAN, expenses: Array.from({ length: 11 }, (_, i) => ({ id: `e${i}`, label: 'x', amount: 1, atAge: 60 })) }],
    ['a target age before the age', { ...DEFAULT_PLAN, age: 40, targetAge: 30 }],
    ['repeated ids', { ...DEFAULT_PLAN, income: [{ id: 'a', label: 'x', amount: 1, fromAge: 60, inflationAdjusted: true }], expenses: [{ id: 'a', label: 'y', amount: 1, atAge: 60 }] }],
  ];
  for (const [name, value] of bad) {
    test(`refuses ${name}`, () => {
      expect('error' in parsePlan(value)).toBe(true);
    });
  }
});

// A stored plan is checked for its shape, not today's ranges and rules: a
// release that narrows a range, or adds a rule, must not make plans saved
// under an earlier one unreadable. A save is still held to all of them.
describe('a stored plan', () => {
  const outOfRange: [string, unknown][] = [
    ['a withdrawal rate as a percent', { ...DEFAULT_PLAN, withdrawalRate: 4 }],
    ['a tax rate over 60%', { ...DEFAULT_PLAN, taxRate: 0.7 }],
    ['an age out of range', { ...DEFAULT_PLAN, age: 12 }],
    ['absurd spending', { ...DEFAULT_PLAN, spending: 1e12 }],
    ['a horizon over 60 years', { ...DEFAULT_PLAN, horizon: 61 }],
    ['an allocation over 100%', { ...DEFAULT_PLAN, stocksPct: 80, bondsPct: 30 }],
    ['a floor over 1', { ...DEFAULT_PLAN, floor: 1.1 }],
    ['a custom start with no balance', { ...DEFAULT_PLAN, start: 'custom', startBalance: null }],
    ['a target age before the age', { ...DEFAULT_PLAN, age: 40, targetAge: 30 }],
    ['too many incomes', { ...DEFAULT_PLAN, income: Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, label: 'x', amount: 1, fromAge: 60, inflationAdjusted: true })) }],
    ['a long label', { ...DEFAULT_PLAN, expenses: [{ id: 'a', label: 'x'.repeat(61), amount: 1, atAge: 60 }] }],
    ['an id in another form', { ...DEFAULT_PLAN, expenses: [{ id: 'a b', label: 'x', amount: 1, atAge: 60 }] }],
    ['repeated ids', { ...DEFAULT_PLAN, income: [{ id: 'a', label: 'x', amount: 1, fromAge: 60, inflationAdjusted: true }], expenses: [{ id: 'a', label: 'y', amount: 1, atAge: 60 }] }],
  ];
  for (const [name, value] of outOfRange) {
    test(`with ${name} still reads, though a save refuses it`, () => {
      expect(isFirePlan(value)).toBe(true);
      expect('error' in parsePlan(value)).toBe(true);
    });
  }

  const notAPlan: [string, unknown][] = [
    ['not an object', 'plan'],
    ['a list', []],
    ['null', null],
    ['a later version', { ...DEFAULT_PLAN, version: 2 }],
    ['an unknown field', { ...DEFAULT_PLAN, extra: 1 }],
    ['a missing field', (() => { const { fee: _, ...rest } = DEFAULT_PLAN; return rest; })()],
    ['an age as text', { ...DEFAULT_PLAN, age: '35' }],
    ['a fractional age', { ...DEFAULT_PLAN, age: 35.5 }],
    ['infinite assets', { ...DEFAULT_PLAN, assets: Infinity }],
    ['an unknown rule', { ...DEFAULT_PLAN, rule: 'yolo' }],
    ['an unknown rebalancing', { ...DEFAULT_PLAN, rebalance: 'daily' }],
    ['a boolean as text', { ...DEFAULT_PLAN, includeCash: 'yes' }],
    ['an income with an extra field', { ...DEFAULT_PLAN, income: [{ id: 'a', label: 'x', amount: 1, fromAge: 60, inflationAdjusted: true, note: 'x' }] }],
    ['an expense label that is not text', { ...DEFAULT_PLAN, expenses: [{ id: 'a', label: 5, amount: 1, atAge: 60 }] }],
  ];
  for (const [name, value] of notAPlan) {
    test(`is not ${name}`, () => {
      expect(isFirePlan(value)).toBe(false);
    });
  }

  // What the Plan tab works from when a stored plan has a value this release
  // doesn't take: never a crash, and it says what changed.
  test('is repaired to what today accepts, saying what changed', () => {
    const pension = { id: 'p', label: 'Pension', amount: 2e7, fromAge: 65, inflationAdjusted: false };
    const r = repairPlan(
      plan({
        withdrawalRate: 2,
        horizon: 61,
        stocksPct: 80,
        bondsPct: 30,
        age: 40,
        targetAge: 30,
        income: [pension, { id: 'ss', label: 'Social Security', amount: 20_000, fromAge: 67, inflationAdjusted: true }],
        expenses: [{ id: 'ss', label: 'Roof', amount: 1, atAge: 60 }], // repeats an income's id
      })
    );
    expect('plan' in parsePlan(r.plan)).toBe(true);
    expect(r.plan.withdrawalRate).toBe(DEFAULT_PLAN.withdrawalRate);
    expect(r.plan.horizon).toBe(DEFAULT_PLAN.horizon);
    expect([r.plan.stocksPct, r.plan.bondsPct]).toEqual([DEFAULT_PLAN.stocksPct, DEFAULT_PLAN.bondsPct]);
    expect(r.plan.targetAge).toBeNull();
    expect(r.plan.income.map((x) => x.label)).toEqual(['Social Security']);
    expect(r.plan.expenses).toEqual([]);
    expect(r.plan.age).toBe(40); // what was fine is kept
    expect(r.fixed).toEqual([
      { field: 'allocation' },
      { field: 'income', item: { label: 'Pension', amount: 2e7, age: 65 } },
      { field: 'expenses', item: { label: 'Roof', amount: 1, age: 60 } },
      { field: 'withdrawalRate' },
      { field: 'horizon' },
      { field: 'targetAge' },
    ]);
    // A plan today accepts comes back as it is.
    expect(repairPlan(plan({ age: 40 }))).toEqual({ plan: plan({ age: 40 }), fixed: [] });
  });

  test('any plan the lenient reader takes is repaired into one the FI view and the engine plan never throw on', () => {
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const anyNumber = () => [0, -1, 1e9, -1e9, 0.5, 2, 150, 0.99, -0.99, 1e-9][Math.floor(random() * 10)] * (random() < 0.5 ? 1 : random() * 3);
    const whole = () => Math.round(anyNumber());
    for (let i = 0; i < 300; i++) {
      const p = plan({
        age: random() < 0.3 ? null : whole(),
        targetAge: random() < 0.3 ? null : whole(),
        spending: random() < 0.3 ? null : anyNumber(),
        savings: random() < 0.3 ? null : anyNumber(),
        assets: random() < 0.3 ? null : anyNumber(),
        withdrawalRate: anyNumber(),
        realReturn: anyNumber(),
        taxRate: anyNumber(),
        partTimeIncome: anyNumber(),
        startBalance: random() < 0.5 ? null : anyNumber(),
        start: (['fi-number', 'assets', 'custom'] as const)[Math.floor(random() * 3)],
        horizon: random() < 0.5 ? null : whole(),
        stocksPct: whole(),
        bondsPct: whole(),
        fee: anyNumber(),
        floor: anyNumber(),
        ceiling: anyNumber(),
        income: [{ id: 'i', label: 'x'.repeat(1 + Math.floor(random() * 80)), amount: anyNumber(), fromAge: whole(), inflationAdjusted: true }],
        expenses: [{ id: 'e', label: 'y', amount: anyNumber(), atAge: whole() }],
      });
      expect(isFirePlan(JSON.parse(JSON.stringify(p)))).toBe(true);
      const measured = { spending: anyNumber(), savings: anyNumber(), assets: anyNumber() };
      // Even unrepaired, the FI view never throws: it leaves out what it can't work out.
      expect(() => fiView(p, measured)).not.toThrow();
      const fixed = repairPlan(p).plan;
      expect('plan' in parsePlan(fixed)).toBe(true);
      expect(() => enginePlan(fixed, fiView(fixed, measured))).not.toThrow();
    }
  });

  test('saved without a field added since, is given its default; anything else is left as it is', () => {
    const full = plan({ age: 40, spending: 50_000 });
    const { fee: _fee, income: _income, ...old } = full;
    const upgraded = upgradePlan(JSON.parse(JSON.stringify(old))) as FirePlan;
    expect(upgraded).toEqual({ ...full, fee: DEFAULT_PLAN.fee, income: [] });
    expect(upgraded.income).not.toBe(DEFAULT_PLAN.income); // a copy, never the defaults themselves
    expect(isFirePlan(upgraded)).toBe(true);
    // A current plan, a later version's and anything that is not a plan are
    // returned unchanged, never thrown on.
    for (const v of [full, { ...full, version: 2 }, { spending: 1 }, null, 'plan', 5, [], undefined]) expect(upgradePlan(v)).toBe(v);
  });
});

describe('the FI view', () => {
  const measured = { spending: 40_000, savings: 30_000, assets: 200_000 };

  test('uses what Nya measured, and says so', () => {
    const v = fiView(plan({ age: 35, targetAge: 55 }), measured);
    expect(v.spending).toEqual({ value: 40_000, source: 'measured' });
    expect(v.fiNumber).toBeCloseTo(1_000_000, 6);
    expect(v.progress).toBeCloseTo(0.2, 9);
    expect(v.yearsToFi).toBeCloseTo(yearsToTarget(200_000, 30_000, 0.05, 1_000_000), 9);
    expect(v.fiAge).toBeCloseTo(35 + v.yearsToFi!, 9);
    expect(v.coast!.number).toBeCloseTo(coastFiNumber(1_000_000, 0.05, 20), 6);
    expect(v.coast!.reached).toBe(false);
    expect(v.barista).toBeNull();
  });

  test('a typed figure wins over the measured one, and says so', () => {
    const v = fiView(plan({ spending: 60_000, taxRate: 0.2 }), measured);
    expect(v.spending).toEqual({ value: 60_000, source: 'typed' });
    expect(v.fiNumber).toBeCloseTo(fiNumber(60_000, 0.04, 0.2), 6);
  });

  test('nothing to measure and nothing typed leaves the figures empty, not zero', () => {
    const v = fiView(plan(), { spending: null, savings: null, assets: null });
    expect(v.spending.source).toBe('none');
    expect(v.fiNumber).toBeNull();
    expect(v.yearsToFi).toBeNull();
    expect(v.progress).toBeNull();
    expect(v.coast).toBeNull();
  });

  test('Barista FI appears with part-time income', () => {
    const v = fiView(plan({ partTimeIncome: 20_000 }), measured);
    expect(v.barista!.number).toBeCloseTo(500_000, 6);
    expect(v.barista!.yearsTo).toBeCloseTo(yearsToTarget(200_000, 30_000, 0.05, 500_000), 9);
  });

  test('already there is zero years, and never is Infinity, with no age to reach', () => {
    expect(fiView(plan({ age: 40 }), { spending: 40_000, savings: 0, assets: 2_000_000 }).yearsToFi).toBe(0);
    const never = fiView(plan({ age: 40, realReturn: 0 }), { spending: 40_000, savings: -1_000, assets: 100_000 });
    expect(never.yearsToFi).toBe(Infinity);
    expect(never.fiAge).toBeNull();
  });
});

describe('the engine plan', () => {
  const measured = { spending: 40_000, savings: 30_000, assets: 600_000 };

  test('starts with the FI number at the target age by default', () => {
    const p = plan({ age: 35, targetAge: 50 });
    const e = enginePlan(p, fiView(p, measured));
    if ('missing' in e) throw new Error('expected a plan');
    expect(e.sim.startBalance).toBeCloseTo(1_000_000, 6);
    expect(e.startAge).toBe(50);
    expect(e.sim.years).toBe(45); // to age 95
    expect(e.sim.rule).toEqual({ kind: 'constant', rate: 0.04 });
    expect(e.rate).toBe(0.04);
    expect(e.rateFrom).toBe('plan');
    expect(e.sim.allocation).toEqual({ stocks: 0.75, bonds: 0.25, cash: 0 });
  });

  // The question "could I stop now?" is about what you spend, so starting
  // from what you have withdraws your spending, at whatever rate that is.
  test('from today’s assets, or a typed balance, it withdraws your spending, at the rate that implies', () => {
    const today = plan({ age: 35, targetAge: 50, start: 'assets', taxRate: 0.2 });
    const e = enginePlan(today, fiView(today, measured));
    if ('missing' in e) throw new Error('expected a plan');
    expect(e.sim.startBalance).toBe(600_000);
    expect(e.startAge).toBe(35);
    expect(e.sim.years).toBe(60);
    expect(e.rateFrom).toBe('spending');
    // 40,000 to spend after a 20% tax is 50,000 withdrawn: 8.33% of 600,000.
    expect(e.rate).toBeCloseTo(50_000 / 600_000, 12);
    expect(e.sim.rule).toEqual({ kind: 'constant', rate: e.rate });
    const typed = plan({ start: 'custom', startBalance: 750_000, horizon: 40, rule: 'guardrails' });
    const t = enginePlan(typed, fiView(typed, measured));
    if ('missing' in t) throw new Error('expected a plan');
    expect(t.sim.startBalance).toBe(750_000);
    expect(t.sim.years).toBe(40);
    expect(t.sim.rule).toEqual({ kind: 'guardrails', rate: 40_000 / 750_000 });
  });

  test('the first year then spends exactly your spending', () => {
    const p = plan({ start: 'assets', taxRate: 0.15, horizon: 30 });
    const e = enginePlan(p, fiView(p, measured));
    if ('missing' in e) throw new Error('expected a plan');
    expect(historicalCycles(e.sim, usMarket()).firstYearSpending).toBeCloseTo(40_000, 6);
  });

  test('says what is missing instead of guessing a balance', () => {
    const none = { spending: null, savings: null, assets: null };
    expect(enginePlan(plan(), fiView(plan(), none))).toEqual({ missing: 'spending' });
    const p = plan({ start: 'assets' });
    expect(enginePlan(p, fiView(p, none))).toEqual({ missing: 'assets' });
    // Assets but no spending: nothing to withdraw.
    expect(enginePlan(p, fiView(p, { spending: null, savings: null, assets: 100_000 }))).toEqual({ missing: 'spending' });
    // A typed balance of zero has no rate.
    const zero = plan({ start: 'custom', startBalance: 0 });
    expect(enginePlan(zero, fiView(zero, measured))).toEqual({ missing: 'balance' });
  });

  test('a plan runs to 95, within 10 to 60 years, or 30 years without an age', () => {
    expect(planYears(plan())).toBe(30);
    expect(planYears(plan({ targetAge: 90 }))).toBe(10);
    expect(planYears(plan({ targetAge: 30 }))).toBe(60);
    expect(planYears(plan({ targetAge: 30, horizon: 25 }))).toBe(25);
    expect(startAge(plan({ age: 40 }))).toBe(40); // no target age: today's
    expect(startAge(plan({ targetAge: 55, start: 'assets' }))).toBe(55); // no age: the target
  });

  test('places income and one-offs by age, and leaves out what it cannot place', () => {
    const p = plan({
      targetAge: 50,
      income: [
        { id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true },
        { id: 'pension', label: 'Pension', amount: 10_000, fromAge: 45, inflationAdjusted: false },
      ],
      expenses: [
        { id: 'roof', label: 'Roof', amount: 30_000, atAge: 60 },
        { id: 'old', label: 'Before the plan', amount: 1, atAge: 49 },
        { id: 'late', label: 'After the plan', amount: 1, atAge: 95 },
      ],
    });
    const e = enginePlan(p, fiView(p, measured));
    if ('missing' in e) throw new Error('expected a plan');
    expect(e.sim.income).toEqual([
      { amount: 24_000, fromYear: 17, inflationAdjusted: true },
      { amount: 10_000, fromYear: 0, inflationAdjusted: false }, // already being paid
    ]);
    // An expense after the plan's end is placed too, as income starting that
    // late is: the grid's longer columns reach it, the plan itself never does.
    expect(e.sim.oneOffs).toEqual([
      { amount: 30_000, year: 10 },
      { amount: 1, year: 45 },
    ]);
    expect(e.left.expenses.map((x) => x.id)).toEqual(['old']);
    expect(e.beyond.map((x) => x.id)).toEqual(['late']);
    const ageless = plan({ income: p.income });
    const a = enginePlan(ageless, fiView(ageless, measured));
    if ('missing' in a) throw new Error('expected a plan');
    expect(a.sim.income).toEqual([]);
    expect(a.left.income).toHaveLength(2);
  });

  test('VPW expects the allocation’s return; floor and ceiling carry their bounds', () => {
    const vpw = plan({ rule: 'vpw', stocksPct: 60, bondsPct: 40 });
    const e = enginePlan(vpw, fiView(vpw, measured));
    if ('missing' in e) throw new Error('expected a plan');
    expect(e.sim.rule).toEqual({ kind: 'vpw', expectedReturn: 0.6 * 0.05 + 0.4 * 0.02 });
    const fc = plan({ rule: 'floor-ceiling', floor: 0.8, ceiling: 1.5 });
    const f = enginePlan(fc, fiView(fc, measured));
    if ('missing' in f) throw new Error('expected a plan');
    expect(f.sim.rule).toEqual({ kind: 'floor-ceiling', rate: 0.04, floor: 0.8, ceiling: 1.5 });
  });
});

let seq = 0;
function txn(over: Partial<Txn>): Txn {
  return {
    transaction_id: `t${++seq}`,
    date: '2026-09-01',
    name: 'Shop',
    amount: 10,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Bank',
    category: 'food and drink',
    iso_currency_code: 'USD',
    vendor_key: 'shop',
    logo_url: null,
    category_icon_url: null,
    subcategory: null,
    category_confidence: null,
    transaction_code: null,
    payment_channel: null,
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: null,
    region: null,
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
    ...over,
  };
}

describe('spending and savings from the trailing year', () => {
  const today = '2026-10-06';
  const yearAgo = '2025-10-07'; // the first day of the 365 ending today

  // Replaces the test that kept loan payments and ATM cash out of spending:
  // for planning, a mortgage or car payment and cash spent are money needed
  // every year (lib/fire/inputs.ts).
  test('counts spending, loan payments that are not card payments, cash and bank charges, less refunds', () => {
    const r = trailingFlows(
      [
        txn({ date: yearAgo, amount: 100 }),
        txn({ date: '2026-03-01', amount: -5_000, category: 'income' }),
        txn({ date: '2026-10-06', amount: 50, pending: true }), // pending rows count, as on the Activity tab
        txn({ date: '2026-05-06', amount: 1_500, category: 'loan payments', subcategory: 'mortgage payment' }),
        txn({ date: '2026-05-07', amount: 200, category: 'other', transaction_code: 'atm' }),
        txn({ date: '2026-05-08', amount: 60, category: 'transfer out', subcategory: 'withdrawal' }), // cash, no code
        txn({ date: '2026-05-09', amount: 12, category: 'other', transaction_code: 'bank charge' }),
        txn({ date: '2026-05-10', amount: -40, category: 'general merchandise' }), // a refund
        // None of these is spending or income:
        txn({ date: '2026-05-01', amount: 2_000, category: 'transfer out' }),
        txn({ date: '2026-05-02', amount: -2_000, category: 'transfer in' }),
        txn({ date: '2026-05-03', amount: 900, category: 'loan payments', subcategory: 'credit card payment' }),
        txn({ date: '2026-05-06', amount: -1_500, category: 'loan payments', subcategory: 'mortgage payment' }), // the loan's side
        txn({ date: '2026-05-04', amount: 300, category: 'general merchandise', transaction_code: 'transfer' }),
        txn({ date: '2026-05-05', amount: 400, category: 'loan payments', subcategory: null }), // can't tell: left out, reported
        txn({ date: '2026-05-05', amount: 70, category: 'loan payments', subcategory: 'other payment' }), // a store card, maybe: the same
      ],
      today
    )!;
    expect(r.spending).toBe(100 + 50 + 1_500 + 200 + 60 + 12 - 40);
    expect(r.income).toBe(5_000);
    expect(r.savings).toBe(5_000 - 1_882);
    expect(r.loanPayments).toBe(1_500);
    expect(r.cash).toBe(260);
    expect(r.refunds).toBe(40);
    expect(r.largestRefund).toEqual({ amount: 40, date: '2026-05-10', name: 'Shop' });
    expect(r.unclearLoans).toBe(470);
    expect(r.count).toBe(8);
    expect(r.scaled).toBe(false);
    expect(r.days).toBe(TRAILING_DAYS);
    expect(r.from).toBe(yearAgo);
  });

  test("leaves the Activity tab's own rule as it was", () => {
    expect(isTransfer(txn({ amount: 1_500, category: 'loan payments', subcategory: 'mortgage payment' }))).toBe(true);
    expect(isTransfer(txn({ amount: 200, transaction_code: 'atm' }))).toBe(true);
  });

  test('classifies each kind of row', () => {
    const flow = (over: Partial<Txn>) => planFlow(txn(over));
    expect(flow({ amount: 10, category: 'food and drink' })).toBe('spending');
    for (const sub of ['mortgage payment', 'car payment', 'student loan payment', 'personal loan payment']) {
      expect(flow({ amount: 10, category: 'loan payments', subcategory: sub })).toBe('loan');
    }
    expect(flow({ amount: 10, category: 'loan payments', subcategory: 'credit card payment' })).toBe('card-payment');
    // Anything else under loan payments can't be told from a card payoff.
    expect(flow({ amount: 10, category: 'loan payments', subcategory: null })).toBe('unclear-loan');
    expect(flow({ amount: 10, category: 'loan payments', subcategory: 'other payment' })).toBe('unclear-loan');
    expect(flow({ amount: -10, category: 'loan payments', subcategory: 'car payment' })).toBe('transfer');
    // Paying a card off is never spending, whatever it was recategorized as;
    // the card's side of it is a transfer.
    expect(flow({ amount: 10, category: 'general merchandise', subcategory: 'credit card payment' })).toBe('card-payment');
    expect(flow({ amount: -10, category: 'loan payments', subcategory: 'credit card payment' })).toBe('transfer');
    expect(flow({ amount: 10, transaction_code: 'atm' })).toBe('cash');
    // A transfer code wins over the category's "withdrawal".
    expect(flow({ amount: 10, category: 'transfer out', subcategory: 'withdrawal', transaction_code: 'transfer' })).toBe('transfer');
    expect(flow({ amount: -10, transaction_code: 'atm' })).toBe('transfer'); // a deposit at an ATM
    expect(flow({ amount: -10, category: 'income' })).toBe('income');
    // Money back is a refund only in a spending category.
    expect(flow({ amount: -10, category: 'rent and utilities' })).toBe('refund');
    expect(flow({ amount: -10, category: 'general services' })).toBe('refund');
    expect(flow({ amount: -10, category: 'transfer in' })).toBe('transfer');
    expect(flow({ amount: -10, category: 'other' })).toBe('income');
    expect(flow({ amount: -10, category: null })).toBe('income'); // no telling: stays income
  });

  // Recategorizing replaces the category but keeps Plaid's detail
  // (app/api/transactions/route.ts), so a card payoff filed by Plaid as a
  // transfer and moved to "loan payments" still says "account transfer".
  test('a card payoff recategorized as a loan payment is left out and named, never counted twice', () => {
    const r = trailingFlows(
      [
        txn({ date: yearAgo, amount: 1_000, category: 'general merchandise' }), // bought on the card
        txn({ date: '2026-05-01', amount: 1_000, category: 'loan payments', subcategory: 'account transfer' }), // the payoff
      ],
      today
    )!;
    expect(r.spending).toBe(1_000);
    expect(r.loanPayments).toBe(0);
    expect(r.unclearLoans).toBe(1_000);
  });

  test('leaves out what is older than a year, or dated after today', () => {
    const r = trailingFlows(
      [
        txn({ date: yearAgo, amount: 100 }),
        txn({ date: '2025-10-06', amount: 1_000 }), // 366 days ago, counting today
        txn({ date: '2026-10-07', amount: 1_000 }),
      ],
      today
    )!;
    expect(r.spending).toBe(100);
  });

  test('scales any history shorter than a year up to one, and says so', () => {
    // 100 days of history, today included.
    const r = trailingFlows([txn({ date: '2026-06-29', amount: 1_000 }), txn({ date: today, amount: 0 })], today)!;
    expect(r.days).toBe(100);
    expect(r.scaled).toBe(true);
    expect(r.spending).toBeCloseTo(1_000 * 3.65, 9);
    // Even a few days short.
    const near = trailingFlows([txn({ date: '2025-10-12', amount: 360 }), txn({ date: today, amount: 0 })], today)!;
    expect(near.days).toBe(360);
    expect(near.scaled).toBe(true);
    expect(near.spending).toBeCloseTo(365, 9);
  });

  test('only money back in a spending category is a refund, and the largest is named', () => {
    const r = trailingFlows(
      [
        txn({ date: yearAgo, amount: 3_000, category: 'rent and utilities' }),
        txn({ date: '2026-02-01', amount: -1_500, category: 'rent and utilities', name: 'Deposit returned' }), // odd, but shown
        txn({ date: '2026-03-01', amount: -25, category: 'food and drink' }),
        txn({ date: '2026-04-01', amount: -900, category: 'other' }), // not a spending category: income
        txn({ date: '2026-04-02', amount: -800, category: 'transfer in' }), // a transfer
      ],
      today
    )!;
    expect(r.refunds).toBe(1_525);
    expect(r.spending).toBe(3_000 - 1_525);
    expect(r.income).toBe(900);
    expect(r.largestRefund).toEqual({ amount: 1_500, date: '2026-02-01', name: 'Deposit returned' });
  });

  test('refunds never take spending below zero', () => {
    const r = trailingFlows([txn({ date: yearAgo, amount: 10 }), txn({ date: today, amount: -50, category: 'general merchandise' })], today)!;
    expect(r.spending).toBe(0);
  });

  test('gives no figure from under four weeks of history, or from transfers alone', () => {
    expect(trailingFlows([txn({ date: '2026-09-20', amount: 100 })], today)).toBeNull();
    expect(trailingFlows([txn({ date: yearAgo, amount: 100, category: 'transfer out' })], today)).toBeNull();
    expect(trailingFlows([], today)).toBeNull();
  });

  test('flags spending summed across currencies', () => {
    const r = trailingFlows([txn({ date: yearAgo, amount: 10 }), txn({ date: today, amount: 10, iso_currency_code: 'EUR' }), txn({ date: today, amount: 10 })], today)!;
    expect(r.currency).toBe('USD');
    expect(r.mixedCurrency).toBe(true);
  });

  test("reads which institutions couldn't be read from the transactions' notes", () => {
    expect(unreadTransactions(['Chase: needs to be reconnected', 'Could not load transactions.'])).toEqual([
      { institution: 'Chase', reason: 'needs to be reconnected' },
      { institution: null, reason: 'Could not load transactions.' },
    ]);
  });
});

describe('invested assets', () => {
  const acct = (over: Partial<AssetAccount> = {}): AssetAccount => ({
    account_id: `a${++seq}`,
    name: 'Account',
    type: 'investment',
    balance: 1_000,
    currency: 'USD',
    ...over,
  });
  const inst = (accounts: AssetAccount[], over: Partial<AssetInstitution> = {}): AssetInstitution => ({
    name: 'Broker',
    item_id: 'item-1',
    error: false,
    staleAsOf: null,
    staleAsOfAt: null,
    missing: 0,
    accounts,
    ...over,
  });

  test('sums investment accounts that are not hidden, never debts', () => {
    const r = investedAssets(
      [
        inst([
          acct({ balance: 100_000 }),
          acct({ type: 'brokerage', balance: 50_000 }),
          acct({ balance: 999_999, hidden: true }),
          acct({ type: 'depository', balance: 20_000 }),
          acct({ type: 'credit', balance: 5_000 }),
          acct({ type: 'loan', balance: 300_000 }),
        ]),
      ],
      false
    );
    expect(r.total).toBe(150_000);
    expect(r.accounts).toHaveLength(2);
    expect(r.accounts[0].institution).toBe('Broker');
    expect(r.caveats).toEqual([]);
  });

  test('counts checking and savings when asked', () => {
    expect(investedAssets([inst([acct({ balance: 100_000 }), acct({ type: 'depository', balance: 20_000 })])], true).total).toBe(120_000);
  });

  test('an account without a balance is counted as unknown, not as zero', () => {
    const r = investedAssets([inst([acct({ balance: null }), acct({ balance: 5 })])], false);
    expect(r.total).toBe(5);
    expect(r.unknown).toBe(1);
    expect(investedAssets([inst([acct({ balance: null })])], false).total).toBeNull();
    expect(investedAssets([], false).total).toBeNull();
  });

  test('names an institution that failed with nothing recovered, unless what it holds would not count', () => {
    const r = investedAssets([inst([acct({ balance: 10 })]), inst([], { name: 'Fidelity', error: true })], false);
    expect(r.total).toBe(10);
    expect(r.caveats).toEqual([{ kind: 'unreachable', institution: 'Fidelity' }]);
    // Known to hold only a card: it can't make invested assets short.
    expect(investedAssets([inst([acct({ type: 'credit', balance: null })], { name: 'Amex', error: true })], false).caveats).toEqual([]);
  });

  test('names balances recovered from an earlier day, with the day, and accounts that could not be shown', () => {
    const r = investedAssets(
      [
        inst([acct({ balance: 10 })], { name: 'Vanguard', error: true, staleAsOf: '2026-10-03', staleAsOfAt: '2026-10-03T13:00:00Z' }),
        inst([acct({ balance: 20 })], { name: 'Schwab', missing: 2 }),
      ],
      false
    );
    expect(r.total).toBe(30);
    expect(r.caveats).toEqual([
      { kind: 'stale', institution: 'Vanguard', asOf: '2026-10-03', at: '2026-10-03T13:00:00Z' },
      { kind: 'missing', institution: 'Schwab', count: 2 },
    ]);
  });
});

describe('workplace plan contributions', () => {
  test('are counted for workplace plans only, by subtype', () => {
    for (const s of ['401k', '403B', '457b', 'roth 401k', 'thrift savings plan', 'simple ira', '401a']) expect(isWorkplacePlan(s)).toBe(true);
    for (const s of ['ira', 'roth', 'brokerage', 'hsa', 'sep ira', '529', null]) expect(isWorkplacePlan(s)).toBe(false);
  });

  const plan = (over: Partial<PlanContributions> & Pick<PlanContributions, 'account_id' | 'name' | 'institution'>): PlanContributions => ({
    amount: 0,
    from: '2025-10-07',
    partial: false,
    rows: [],
    activityFrom: null,
    note: null,
    ...over,
  });
  const none = { transfersOut: [], funding: [] };
  const added = (w: ReturnType<typeof workplaceSavings>) => w.plans.map((x) => [x.name, x.added]);

  test('are summed, with plans measured over less than a year (as the route says), or not at all, named', () => {
    const w = workplaceSavings(
      [
        plan({ account_id: 'a', name: '401(k)', institution: 'Fidelity', amount: 12_000 }),
        plan({ account_id: 'b', name: '403(b)', institution: 'TIAA', amount: 3_000, from: '2026-04-01', partial: true }),
        plan({ account_id: 'c', name: 'TSP', institution: 'TSP', amount: null, from: null }),
        plan({ account_id: 'd', name: '457(b)', institution: 'Empower', amount: 500, note: 'Could not fetch investment activity; showing saved activity' }),
        // A later day than the viewer's year ago, but the route says covered: not partial.
        plan({ account_id: 'e', name: '401(a)', institution: 'Vanguard', amount: 100, from: '2025-10-08' }),
        // Covered all year, but the institution's activity starts in March: said.
        plan({ account_id: 'f', name: '401(k)', institution: 'Schwab', amount: 0, activityFrom: '2026-03-03' }),
      ],
      none
    );
    expect(w.total).toBe(15_600);
    expect(added(w)).toEqual([
      ['Fidelity 401(k)', 12_000],
      ['TIAA 403(b)', 3_000],
      ['Empower 457(b)', 500],
      ['Vanguard 401(a)', 100],
      ['Schwab 401(k)', 0],
    ]);
    expect(w.partial).toEqual([{ name: 'TIAA 403(b)', from: '2026-04-01' }]);
    expect(w.shortHistory).toEqual([{ name: 'Schwab 401(k)', from: '2026-03-03' }]);
    expect(w.unmeasured).toEqual(['TSP TSP']);
    expect(w.problems).toEqual([{ name: 'Empower 457(b)', note: 'Could not fetch investment activity; showing saved activity' }]);
  });

  // A Solo 401(k) paid from checking, not set: the transfer out already
  // counts as saved in income minus spending, so the contribution isn't
  // added again.
  test('for a plan not set, a contribution a transfer to retirement funds paid for is not added again, and each transfer pays for one at most', () => {
    const w = workplaceSavings(
      [
        plan({
          account_id: 'solo',
          name: 'Solo 401(k)',
          institution: 'Vanguard',
          amount: 20_500,
          rows: [
            { date: '2026-03-02', amount: 10_000 }, // paid by the transfer on Feb 27
            { date: '2026-03-20', amount: 10_000 }, // no transfer near it: added
            { date: '2026-06-01', amount: 500 },
          ],
        }),
        plan({ account_id: 'k', name: '401(k)', institution: 'Fidelity', amount: 500, rows: [{ date: '2026-06-02', amount: 500 }] }),
      ],
      {
        transfersOut: [
          { date: '2026-02-27', amount: 10_000 },
          { date: '2026-06-03', amount: 500.4 }, // within a dollar: pays for the first of the two
          { date: '2026-04-10', amount: 10_000 }, // three weeks after: no match
        ],
        funding: [],
      }
    );
    expect(w.plans).toEqual([
      // What counted is named: how many, and the largest.
      { name: 'Vanguard Solo 401(k)', paidFrom: null, added: 10_000, count: 1, largest: { date: '2026-03-20', amount: 10_000 }, matched: 10_500 },
      { name: 'Fidelity 401(k)', paidFrom: null, added: 500, count: 1, largest: { date: '2026-06-02', amount: 500 }, matched: 0 },
    ]);
    expect(w.total).toBe(10_500);
  });

  // One transfer the plan records as a deferral and an employer share.
  test('a transfer recorded as several contributions on one day is matched by their sum', () => {
    const w = workplaceSavings(
      [
        plan({
          account_id: 'solo',
          name: 'Solo 401(k)',
          institution: 'Vanguard',
          amount: 6_500,
          rows: [
            { date: '2026-04-02', amount: 5_000 },
            { date: '2026-04-02', amount: 1_500 },
          ],
        }),
      ],
      { transfersOut: [{ date: '2026-03-31', amount: 6_500 }], funding: [] }
    );
    expect(w.total).toBe(0);
    expect(w.plans[0].matched).toBe(6_500);
  });

  // A payday that moves $500 to savings and defers $500 to the 401(k): the
  // move to savings never paid for the contribution. Only transfers Plaid
  // details as investment and retirement funds are matched, and a plan set
  // as paid through payroll is never matched at all.
  test('only transfers to investment and retirement funds are matched, and only for a plan not set', () => {
    const rows = [
      { date: '2026-05-01', amount: 500 },
      { date: '2026-05-15', amount: 500 },
    ];
    const k = plan({ account_id: 'k', name: '401(k)', institution: 'Fidelity', amount: 1_000, rows });
    const toSavings = transfersOut(
      [
        txn({ date: '2026-05-01', amount: 500, category: 'transfer out', subcategory: 'savings' }),
        txn({ date: '2026-05-15', amount: 500, category: 'transfer out', subcategory: 'account transfer' }),
      ],
      '2026-10-06'
    );
    expect(toSavings).toEqual([]);
    expect(workplaceSavings([k], { transfersOut: toSavings, funding: [] }).total).toBe(1_000);
    const toRetirement = [{ date: '2026-05-01', amount: 500 }];
    expect(workplaceSavings([k], { transfersOut: toRetirement, funding: [] }).total).toBe(500);
    const payroll = workplaceSavings([k], { transfersOut: toRetirement, funding: [{ account_id: 'k', paidFrom: 'payroll' }] });
    expect(payroll.total).toBe(1_000);
    expect(payroll.plans[0]).toMatchObject({ paidFrom: 'payroll', matched: 0, count: 2 });
  });

  test('match by amount within a dollar or 1%, and by day within a few days', () => {
    const one = (transfer: { date: string; amount: number }) =>
      workplaceSavings([plan({ account_id: 'a', name: 'x', institution: 'y', amount: 2_000, rows: [{ date: '2026-06-10', amount: 2_000 }] })], {
        transfersOut: [transfer],
        funding: [],
      }).total;
    expect(one({ date: '2026-06-10', amount: 2_019 })).toBe(0); // within 1%
    expect(one({ date: '2026-06-10', amount: 2_030 })).toBe(2_000); // not
    expect(one({ date: `2026-06-${10 + MATCH_DAYS}`, amount: 2_000 })).toBe(0);
    expect(one({ date: `2026-06-${11 + MATCH_DAYS}`, amount: 2_000 })).toBe(2_000);
  });

  test('a plan set as paid from the bank adds nothing, and is named', () => {
    const w = workplaceSavings([plan({ account_id: 'solo', name: 'Solo 401(k)', institution: 'Vanguard', amount: 20_000, rows: [{ date: '2026-03-01', amount: 20_000 }] })], {
      transfersOut: [],
      funding: [{ account_id: 'solo', paidFrom: 'bank' }],
    });
    expect(w.total).toBe(0);
    expect(w.fromBank).toEqual(['Vanguard Solo 401(k)']);
    expect(w.plans).toEqual([]);
  });

  test('transfers out are moves to investment and retirement funds over the year, and nothing else', () => {
    const out = transfersOut(
      [
        txn({ date: '2026-03-01', amount: 10_000, category: 'transfer out', subcategory: 'investment and retirement funds' }),
        txn({ date: '2026-03-02', amount: 50, category: 'food and drink' }), // spending
        txn({ date: '2026-03-03', amount: -10_000, category: 'transfer in', subcategory: 'investment and retirement funds' }), // money in
        txn({ date: '2026-03-04', amount: 900, category: 'loan payments', subcategory: 'credit card payment' }), // a card payoff
        txn({ date: '2026-03-05', amount: 700, category: 'transfer out', subcategory: 'savings' }), // to savings: never a contribution
        // Recategorized as spending: it counts as spent, so it never paid for a contribution here.
        txn({ date: '2026-03-06', amount: 300, category: 'general services', subcategory: 'investment and retirement funds' }),
        txn({ date: '2025-01-01', amount: 7_000, category: 'transfer out', subcategory: 'investment and retirement funds' }), // older than a year
      ],
      '2026-10-06'
    );
    expect(out).toEqual([{ date: '2026-03-01', amount: 10_000 }]);
  });
});

describe('the store', () => {
  const saved = plan({ age: 40, spending: 50_000 });
  const stored = async () => JSON.parse(await decrypt(String(await fake.get(ctxKey('fire-plan')))));

  test('is declared on the storage seam, under the name it always had, and in the data download', () => {
    expect(firePlanStore.name).toBe('fire-plan');
    expect(firePlanStore.kind).toBe('value');
    expect(declaredStore('fire-plan')).toBe(firePlanStore);
    expect(firePlanStore.exportable).toBe(true);
  });

  test('never saved reads as null, and a plan round-trips, encrypted', async () => {
    expect(await firePlanStore.get(TEST_CTX)).toBeNull();
    await firePlanStore.set(TEST_CTX, saved);
    expect(await firePlanStore.get(TEST_CTX)).toEqual(saved);
    // Encrypted: nothing of the plan is readable in the database.
    expect(String(await fake.get(ctxKey('fire-plan')))).not.toContain('50000');
  });

  test('a plan saved before the store moved onto the seam reads back unchanged, and the old reader reads the new', async () => {
    // Exactly as the store saved it before: lib/stored-json.ts, under the same key.
    await writeEncryptedJson(ctxKey('fire-plan'), 'plan assumptions', saved, isFirePlan);
    expect(await firePlanStore.get(TEST_CTX)).toEqual(saved);
    expect(await (await route.GET()).json()).toEqual({ plan: saved });
    // And what the seam saves, the release before it reads: a rollback loses nothing.
    await firePlanStore.set(TEST_CTX, plan({ age: 41 }));
    expect(await readEncryptedJson(ctxKey('fire-plan'), 'plan assumptions', isFirePlan)).toEqual(plan({ age: 41 }));
  });

  test('a plan saved without a field added since reads with its default, and the next save stores every field', async () => {
    const { ceiling: _, ...old } = saved;
    await fake.set(ctxKey('fire-plan'), await encrypt(JSON.stringify(old)));
    const read = await firePlanStore.get(TEST_CTX);
    expect(read).toEqual({ ...saved, ceiling: DEFAULT_PLAN.ceiling });
    await firePlanStore.set(TEST_CTX, read!);
    expect(Object.keys(await stored()).sort()).toEqual(Object.keys(DEFAULT_PLAN).sort());
  });

  // Through the store's upgrade hook: before any switch every plan was
  // matched, which is "not set" now; the two-way switch's list of plans paid
  // from a bank is "bank" for each.
  test('plans saved before the three-way switch read with what they meant', async () => {
    const { planFunding: _, ...older } = saved;
    await fake.set(ctxKey('fire-plan'), await encrypt(JSON.stringify(older)));
    expect(await firePlanStore.get(TEST_CTX)).toEqual({ ...saved, planFunding: [] });
    await fake.set(ctxKey('fire-plan'), await encrypt(JSON.stringify({ ...older, bankFunded: ['acc_solo', 'acc_sep'] })));
    const read = await firePlanStore.get(TEST_CTX);
    expect(read).toEqual({
      ...saved,
      planFunding: [
        { account_id: 'acc_solo', paidFrom: 'bank' },
        { account_id: 'acc_sep', paidFrom: 'bank' },
      ],
    });
    // The next save stores the new field, and not the old one.
    await firePlanStore.set(TEST_CTX, read!);
    expect(await stored()).not.toHaveProperty('bankFunded');
    // A list that isn't one of ids is left for the reader to refuse, not guessed at.
    expect(upgradePlan({ ...older, bankFunded: [5] })).toEqual({ ...older, bankFunded: [5] });
  });

  test('a plan outside today’s ranges or rules still reads; a save is held to them', async () => {
    const old = { ...saved, withdrawalRate: 0.2, horizon: 61, targetAge: 30 };
    await fake.set(ctxKey('fire-plan'), await encrypt(JSON.stringify(old)));
    expect(await firePlanStore.get(TEST_CTX)).toEqual(old);
    const res = await route.PUT(new Request('http://x', { method: 'PUT', body: JSON.stringify({ plan: old }) }));
    expect(res.status).toBe(400);
    expect(await stored()).toEqual(old);
  });

  test('damaged bytes are unreadable, a later release’s plan is not understood, and neither reads as none', async () => {
    await fake.set(ctxKey('fire-plan'), 'not-ciphertext-at-all-but-long-enough');
    const damaged = await firePlanStore.get(TEST_CTX).catch((e: unknown) => e);
    expect(damaged).toBeInstanceOf(UnreadableValueError);
    expect((damaged as InstanceType<typeof UnreadableValueError>).unrecognised).toBe(false);
    // Intact, but not understood: never offered for removal.
    for (const later of [{ ...saved, version: 9 }, { ...saved, goal: 'travel' }]) {
      await fake.set(ctxKey('fire-plan'), await encrypt(JSON.stringify(later)));
      const e = await firePlanStore.get(TEST_CTX).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(StoredDataUnreadableError);
      expect((e as InstanceType<typeof UnreadableValueError>).unrecognised).toBe(true);
    }
  });

  test('saving over an unreadable value is refused, and it is left as it was', async () => {
    await fake.set(ctxKey('fire-plan'), 'unreadable-but-recoverable');
    await expect(firePlanStore.set(TEST_CTX, saved)).rejects.toBeInstanceOf(StoredDataUnreadableError);
    expect(await fake.get<string>(ctxKey('fire-plan'))).toBe('unreadable-but-recoverable');
  });

  test('is on the key inventory as a string of ciphertext, inside a container only', () => {
    expect(classify(ctxKey('fire-plan').replace(/^[^:]+:(?=c:)/, ''))).toBe('string');
    // Outside a container the name was built wrongly, so it is reported.
    expect(classify('fire-plan')).toBeNull();
  });
});

describe('the route', () => {
  const put = (body: unknown) => route.PUT(new Request('http://x', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
    const orig = console.error;
    console.error = () => {};
    try {
      return await f();
    } finally {
      console.error = orig;
    }
  };

  test('loads null before anything is saved, then what was saved', async () => {
    expect(await (await route.GET()).json()).toEqual({ plan: null });
    const res = await put({ plan: plan({ age: 30 }) });
    expect(res.status).toBe(200);
    expect(await (await route.GET()).json()).toEqual({ plan: plan({ age: 30 }) });
  });

  test('refuses an invalid plan with the reason, and stores nothing', async () => {
    const res = await put({ plan: { ...DEFAULT_PLAN, withdrawalRate: 4 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('withdrawalRate');
    expect(await fake.get(ctxKey('fire-plan'))).toBeNull();
    expect((await put('{not json')).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put(null)).status).toBe(400);
  });

  test('an unreadable store is a flagged 409 on load and on save, and is left alone', async () => {
    await fake.set(ctxKey('fire-plan'), 'unreadable');
    const get = await quiet(() => route.GET());
    expect(get.status).toBe(409);
    expect(await get.json()).toMatchObject({ unreadable: true });
    const res = await quiet(() => put({ plan: DEFAULT_PLAN }));
    expect(res.status).toBe(409);
    expect(await fake.get<string>(ctxKey('fire-plan'))).toBe('unreadable');
  });

  test('a database failure is a 500 without the flag', async () => {
    fake.failNext('get');
    const res = await quiet(() => route.GET());
    expect(res.status).toBe(500);
    expect((await res.json()).unreadable).toBeUndefined();
  });

  test('a plan too large to store is refused whole, with the seam’s reason, and nothing is written', async () => {
    const before = process.env.MAX_TXN_BLOB_CHARS;
    process.env.MAX_TXN_BLOB_CHARS = '100';
    try {
      const res = await quiet(() => put({ plan: plan({ age: 30 }) }));
      expect(res.status).toBe(413);
      expect((await res.json()).error).toContain('too large to save');
      expect(await fake.get(ctxKey('fire-plan'))).toBeNull();
    } finally {
      if (before === undefined) delete process.env.MAX_TXN_BLOB_CHARS;
      else process.env.MAX_TXN_BLOB_CHARS = before;
    }
  });
});
