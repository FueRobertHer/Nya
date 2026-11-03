import { describe, expect, test } from 'bun:test';
import {
  asExpense,
  asIncome,
  eventItems,
  expensesOf,
  fixedEdges,
  incomeOf,
  isPlanItem,
  itemFromEvent,
  itemFromExpense,
  itemFromIncome,
  itemRules,
  parseItem,
  withExpenses,
  withIncome,
  type PlanItem,
} from '@/lib/fire/items';
import { DEFAULT_PLAN_V2, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { parseLifeEvent, type LifeEvent } from '@/lib/fire/events';
import { genEvents, genPlan, rand } from './plan-gen';

// A plan's items (lib/fire/items.ts): the one shape, its checks, the upgrades
// from version 1 and life events, the cards' version 1 views, and the rules
// between items.

const age = (a: number, offset = 0) => ({ anchor: { at: 'age' as const, age: a }, offset });
const base = (over: Partial<PlanItem>): PlanItem => ({
  id: 'x',
  label: 'Thing',
  kind: 'one-off',
  from: age(50),
  until: null,
  once: 10_000,
  yearly: null,
  replaces: null,
  every: null,
  times: null,
  inflationAdjusted: true,
  owner: null,
  beforeTax: false,
  ...over,
});
const plan = (items: PlanItem[], over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...DEFAULT_PLAN_V2, age: 40, targetAge: 55, ...over, items });

describe('the shape', () => {
  test('every upgrade makes the one closed shape, which isPlanItem and parseItem take', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const g = rand(seed);
      const p = genPlan(g, true);
      const items = [...p.income.map(itemFromIncome), ...p.expenses.map(itemFromExpense), ...eventItems(genEvents(g))];
      for (const [i, x] of items.entries()) {
        expect(Object.keys(x).sort()).toEqual(['beforeTax', 'every', 'from', 'id', 'inflationAdjusted', 'kind', 'label', 'once', 'owner', 'replaces', 'times', 'until', 'yearly']);
        expect(isPlanItem(x)).toBe(true);
        expect(parseItem(x, `items[${i}]`)).toEqual({ ok: x });
      }
    }
  });

  test('a stored item is its types, whatever ranges; anything else is not one', () => {
    expect(isPlanItem(base({ once: -5, from: age(500) }))).toBe(true);
    expect(isPlanItem({ ...base({}), extra: 1 })).toBe(false);
    expect(isPlanItem(base({ kind: 'yacht' as never }))).toBe(false);
    expect(isPlanItem(base({ from: { anchor: { at: 'moon' } as never, offset: 0 } }))).toBe(false);
    expect(isPlanItem(base({ until: { years: '3' as never } }))).toBe(false);
    expect(isPlanItem(base({ owner: 'cat' as never }))).toBe(false);
  });

  test('a save meets its kind’s ranges and fields', () => {
    expect(parseItem(base({ yearly: 5 }), 'items[0]')).toEqual({ error: 'items[0]: a one-off item has no yearly' });
    expect(parseItem(base({ inflationAdjusted: false }), 'items[0]')).toEqual({ error: 'items[0]: only income can lose value with inflation' });
    expect(parseItem(base({ kind: 'windfall', once: 0 }), 'items[0]')).toEqual({ error: 'items[0]: the amount is an amount above 0, up to 100000000' });
    expect(parseItem(base({ from: { anchor: { at: 'balance', amount: 1_000_000 }, offset: -1 } }), 'items[0]')).toEqual({ error: 'items[0]: when it starts can’t come before a balance is reached' });
    expect(parseItem(base({ kind: 'part-time', once: null, yearly: 20_000, until: null }), 'items[0]')).toEqual({ error: 'items[0]: part-time work needs when it stops' });
    // Version 1's ranges for what version 1 held: an amount of 0 and a tab.
    expect('ok' in parseItem(itemFromIncome({ id: 'a', label: 'Odd\tname', amount: 0, fromAge: 67, inflationAdjusted: true }), 'items[0]')).toBe(true);
    expect('ok' in parseItem(base({ kind: 'windfall', label: 'Odd\tname' }), 'items[0]')).toBe(false);
  });
});

describe('the upgrades', () => {
  test('an income and a one-off keep their ids and figures, and read back through the views', () => {
    const inc = { id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: false };
    const exp = { id: 'roof', label: 'Roof', amount: 25_000, atAge: 70 };
    expect(itemFromIncome(inc)).toMatchObject({ id: 'ss', kind: 'other-income', from: age(67), until: null, yearly: 24_000, inflationAdjusted: false, beforeTax: false, owner: null });
    expect(itemFromExpense(exp)).toMatchObject({ id: 'roof', kind: 'one-off', from: age(70), once: 25_000 });
    expect(asIncome(itemFromIncome(inc))).toEqual(inc);
    expect(asExpense(itemFromExpense(exp))).toEqual(exp);
    expect(asIncome(itemFromExpense(exp))).toBeNull();
    expect(asIncome({ ...itemFromIncome(inc), beforeTax: true })).toBeNull();
    expect(asExpense({ ...itemFromExpense(exp), from: age(70, 1) })).toBeNull();
  });

  test('each life event becomes its kind with the same figures and ages', () => {
    const cases: [LifeEvent, Partial<PlanItem>][] = [
      [{ id: 'h', kind: 'house', label: 'Home', atAge: 45, cost: 80_000, yearly: 6_000, years: null }, { kind: 'home', from: age(45), until: null, once: 80_000, yearly: 6_000 }],
      [{ id: 'c', kind: 'child', label: 'Kid', fromAge: 35, yearly: 15_000, years: 18 }, { kind: 'child', until: { years: 18 }, yearly: 15_000 }],
      [{ id: 's', kind: 'sabbatical', label: 'Break', fromAge: 40, years: 2, savingsLost: 30_000 }, { kind: 'pay', until: { years: 2 }, yearly: -30_000 }],
      [{ id: 'p', kind: 'part-time', label: 'Shop', fromAge: 55, toAge: 62, yearly: 20_000 }, { kind: 'part-time', until: age(62), yearly: 20_000, replaces: null }],
      [{ id: 'r', kind: 'raise', label: 'Raise', fromAge: 38, yearly: 10_000 }, { kind: 'pay', until: null, yearly: 10_000 }],
      [{ id: 'k', kind: 'car', label: 'Cars', atAge: 40, cost: 30_000, every: 8, times: 4 }, { kind: 'car', once: 30_000, every: 8, times: 4 }],
      [{ id: 'w', kind: 'windfall', label: 'Gift', atAge: 50, amount: 100_000 }, { kind: 'windfall', once: 100_000 }],
      [{ id: 'l', kind: 'loan-end', label: 'Car loan', atAge: 44, yearly: 6_000 }, { kind: 'loan-end', yearly: 6_000, until: null }],
    ];
    for (const [e, expected] of cases) {
      expect(parseLifeEvent(e, 'e')).toEqual({ ok: e });
      expect(itemFromEvent(e)).toMatchObject({ id: e.id, label: e.label, ...expected });
    }
  });
});

describe('the cards’ views', () => {
  const a = itemFromIncome({ id: 'a', label: 'A', amount: 1, fromAge: 60, inflationAdjusted: true });
  const x = itemFromExpense({ id: 'x', label: 'X', amount: 2, atAge: 50 });
  const pay = itemFromEvent({ id: 'r', kind: 'raise', label: 'Raise', fromAge: 41, yearly: 5 });

  test('read in item order, and write each list keeping every other item where it is', () => {
    const p = plan([a, x, pay]);
    expect(incomeOf(p).map((i) => i.id)).toEqual(['a']);
    expect(expensesOf(p).map((i) => i.id)).toEqual(['x']);
    const b = { id: 'b', label: 'B', amount: 3, fromAge: 70, inflationAdjusted: true };
    expect(withIncome(p, [...incomeOf(p), b]).items.map((i) => i.id)).toEqual(['a', 'x', 'r', 'b']);
    expect(withIncome(p, []).items.map((i) => i.id)).toEqual(['x', 'r']);
    expect(withExpenses(p, [{ ...expensesOf(p)[0], amount: 9 }]).items.map((i) => [i.id, i.once])).toEqual([
      ['a', null],
      ['x', 9],
      ['r', null],
    ]);
  });

  test('an id already among the items, of any kind, is replaced where it is, never doubled', () => {
    const p = plan([a, x, pay]);
    const clash = { id: 'r', label: 'Now income', amount: 7, fromAge: 65, inflationAdjusted: true };
    const next = withIncome(p, [...incomeOf(p), clash]);
    expect(next.items.map((i) => [i.id, i.kind])).toEqual([
      ['a', 'other-income'],
      ['x', 'one-off'],
      ['r', 'other-income'],
    ]);
  });
});

describe('the rules between items', () => {
  test('ids unique, anchors that exist, no end to anchor on for good or once', () => {
    expect(itemRules(plan([base({ id: 'a' }), base({ id: 'a' })]))).toEqual({ field: 'items[1]', error: 'item ids must be unique' });
    expect(itemRules(plan([base({ from: { anchor: { at: 'item', id: 'zz', edge: 'start' }, offset: 0 } })]))).toMatchObject({ field: 'items[0]' });
    const ss = base({ id: 'ss', kind: 'social-security', once: null, yearly: 20_000 });
    expect(itemRules(plan([ss, base({ id: 'b', from: { anchor: { at: 'item', id: 'ss', edge: 'end' }, offset: 0 } })]))).toEqual({ field: 'items[1]', error: 'items[1] is timed by the end of items[0], which has none' });
  });

  test('loops between edges are refused, naming both; an edge on another edge of the same item isn’t a loop', () => {
    const job = (id: string, from: PlanItem['from'], until: PlanItem['until']) => base({ id, kind: 'part-time', once: null, yearly: 10_000, from, until });
    const a = job('a', { anchor: { at: 'item', id: 'b', edge: 'end' }, offset: 0 }, { years: 3 });
    const b = job('b', age(50), { anchor: { at: 'item', id: 'a', edge: 'start' }, offset: 0 });
    expect(itemRules(plan([a, b]))).toEqual({ field: 'items[0]', error: 'items[0] and items[1] wait on each other' });
    const pt = job('pt', age(50), { anchor: { at: 'item', id: 'b2', edge: 'start' }, offset: 0 });
    const b2 = base({ id: 'b2', kind: 'spending', once: null, yearly: 5_000, from: { anchor: { at: 'item', id: 'pt', edge: 'start' }, offset: 2 } });
    expect(itemRules(plan([pt, b2]))).toBeNull();
  });

  test('nothing comes before a balance is reached, nor before what follows one', () => {
    const m = base({ id: 'm', kind: 'spending', once: null, yearly: 5_000, from: { anchor: { at: 'balance', amount: 2_000_000 }, offset: 0 } });
    const before = base({ id: 'b', from: { anchor: { at: 'item', id: 'm', edge: 'start' }, offset: -2 } });
    expect(itemRules(plan([m, before]))).toMatchObject({ field: 'items[1]' });
    expect(itemRules(plan([m, { ...before, from: { ...before.from, offset: 2 } }]))).toBeNull();
  });

  test('an end before its start between fixed anchors; two part-time jobs for one person at once; a partner’s age unset', () => {
    const job = (id: string, from: number, to: number, owner: PlanItem['owner'] = null) => base({ id, kind: 'part-time', once: null, yearly: 10_000, from: age(from), until: age(to), owner });
    expect(itemRules(plan([job('a', 60, 55)]))).toEqual({ field: 'items[0]', error: 'items[0] stops before it starts' });
    expect(itemRules(plan([job('a', 50, 60), job('b', 55, 65)]))).toMatchObject({ field: 'items[1]' });
    expect(itemRules(plan([job('a', 50, 60), job('b', 55, 65, 'partner')], { partnerAge: 38 }))).toBeNull();
    expect(itemRules(plan([job('a', 50, 60, 'partner')]))).toMatchObject({ field: 'items[0]' });
    // The stop while it is an age is fixed; at FI it isn't.
    const toStop = base({ id: 's', kind: 'spending', once: null, yearly: 1_000, from: age(60), until: { anchor: { at: 'stop' }, offset: 0 } });
    expect(itemRules(plan([toStop]))).toMatchObject({ error: 'items[0] stops before it starts' });
    expect(itemRules(plan([toStop], { stopAtFi: true }))).toBeNull();
  });

  test('fixed edges: ages, the partner’s as yours, the stop, and chains', () => {
    const p = plan(
      [
        base({ id: 'a', kind: 'pension', once: null, yearly: 1, owner: 'partner', from: age(65) }),
        base({ id: 'b', kind: 'spending', once: null, yearly: 1, from: { anchor: { at: 'stop' }, offset: 2 }, until: { years: 5 } }),
        base({ id: 'c', from: { anchor: { at: 'item', id: 'b', edge: 'end' }, offset: 1 } }),
        base({ id: 'd', from: { anchor: { at: 'fi' }, offset: 0 } }),
      ],
      { partnerAge: 37 }
    );
    expect(Object.fromEntries(fixedEdges(p))).toEqual({ '0:start': 68, '1:start': 57, '1:end': 62, '2:start': 63 });
  });
});
