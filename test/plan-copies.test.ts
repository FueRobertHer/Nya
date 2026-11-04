import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLAN, type PlanIncome } from '@/lib/fire/plan';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { itemFromIncome } from '@/lib/fire/items';
import { hasTypedAmounts } from '@/lib/fire/plan-currency';
import { MAIN_ID, factsOf, holdsAmounts, isPlanEntry, isPlanFacts, mainOf, sameFacts, upgradePlanEntry, withFacts, type PlanEntry } from '@/lib/fire/copies';

// Plans as copies, the shapes in memory (lib/fire/copies.ts): what reads,
// and which entry is yours.

const AT = '2026-11-03T10:00:00.000Z';
const income = (over: Partial<PlanIncome> = {}): PlanIncome => ({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true, ...over });
const entry = (over: Partial<PlanEntry> = {}): PlanEntry => ({ name: 'First plan', plan: DEFAULT_PLAN, tax: null, currency: null, createdAt: AT, updatedAt: AT, ...over });
const v2 = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...planOf(DEFAULT_PLAN), ...over });
const report = (entries: [string, PlanEntry][], unreadable: string[] = [], unrecognised: string[] = []) => ({ entries: new Map(entries), unreadable, unrecognised });

describe('an entry', () => {
  test('reads by its shape and types, either version of plan', () => {
    expect(isPlanEntry(entry())).toBe(true);
    expect(isPlanEntry(entry({ plan: v2({ partnerAge: 40 }), currency: 'EUR' }))).toBe(true);
    // Types only: a stop age today's rules refuse still reads.
    expect(isPlanEntry(entry({ plan: { ...DEFAULT_PLAN, age: 60, targetAge: 20 } }))).toBe(true);
  });

  test('is refused for anything else, and a tax choice (a newer release’s) is not recognised', () => {
    expect(isPlanEntry({ ...entry(), extra: 1 })).toBe(false);
    const { updatedAt: _u, ...missing } = entry();
    expect(isPlanEntry(missing)).toBe(false);
    expect(isPlanEntry({ ...entry(), tax: { method: 'brackets' } })).toBe(false);
    expect(isPlanEntry({ ...entry(), currency: 840 })).toBe(false);
    expect(isPlanEntry({ ...entry(), name: 1 })).toBe(false);
    expect(isPlanEntry({ ...entry(), plan: { ...DEFAULT_PLAN, version: 3 } })).toBe(false);
    expect(isPlanEntry(null)).toBe(false);
    expect(isPlanEntry([entry()])).toBe(false);
  });

  test('is upgraded as the plan store upgrades a plan, the rest as it is', () => {
    const { planFunding: _p, ...old } = DEFAULT_PLAN;
    const stored = { ...entry({ currency: 'USD' }), plan: { ...old, bankFunded: ['acc_1'] } };
    const up = upgradePlanEntry(stored) as PlanEntry;
    expect(isPlanEntry(up)).toBe(true);
    expect(up.plan.planFunding).toEqual([{ account_id: 'acc_1', paidFrom: 'bank' }]);
    expect({ ...up, plan: null }).toEqual({ ...stored, plan: null });
    expect(upgradePlanEntry('text')).toBe('text');
  });
});

describe('the facts', () => {
  const facts = { version: 1 as const, main: MAIN_ID, ...factsOf(DEFAULT_PLAN) };

  test('read by shape, and types as the plan’s own reader takes them', () => {
    expect(isPlanFacts(facts)).toBe(true);
    expect(isPlanFacts({ ...facts, age: 41, partnerAge: 39, includeCash: true, planFunding: [{ account_id: 'acc_1', paidFrom: 'payroll' }], method: 'monte-carlo' })).toBe(true);
  });

  test('of another version, or any other shape, don’t', () => {
    expect(isPlanFacts({ ...facts, version: 2 })).toBe(false);
    expect(isPlanFacts({ ...facts, filing: 'single' })).toBe(false);
    expect(isPlanFacts({ ...facts, main: 'has space' })).toBe(false);
    expect(isPlanFacts({ ...facts, main: '__proto__' })).toBe(false);
    expect(isPlanFacts({ ...facts, partnerAge: '39' })).toBe(false);
    expect(isPlanFacts({ ...facts, method: 'guess' })).toBe(false);
    expect(isPlanFacts({ ...facts, includeCash: 'yes' })).toBe(false);
  });

  test('are a plan’s own fields; the same by value, workplace plans as a set', () => {
    const p = { ...DEFAULT_PLAN, age: 41, includeCash: true };
    expect(factsOf(p)).toEqual({ age: 41, partnerAge: null, includeCash: true, planFunding: [], method: DEFAULT_PLAN.method });
    expect(factsOf(v2({ partnerAge: 38 })).partnerAge).toBe(38);
    const a = { ...factsOf(p), planFunding: [{ account_id: 'a', paidFrom: 'bank' as const }, { account_id: 'b', paidFrom: 'payroll' as const }] };
    expect(sameFacts(a, { ...a, planFunding: [...a.planFunding].reverse() })).toBe(true);
    expect(sameFacts(a, { ...a, age: 42 })).toBe(false);
    expect(sameFacts(a, { ...a, partnerAge: 40 })).toBe(false);
    expect(sameFacts(a, { ...a, planFunding: [a.planFunding[0]] })).toBe(false);
    expect(sameFacts(a, { ...a, planFunding: [a.planFunding[0], { account_id: 'b', paidFrom: 'bank' }] })).toBe(false);
  });

  test('go into a plan’s fields; a partner’s age makes a version 1 plan version 2, dropping nothing', () => {
    const p = { ...DEFAULT_PLAN, income: [income()] };
    const f = { age: 50, partnerAge: null, includeCash: true, planFunding: [], method: 'monte-carlo' as const };
    expect(withFacts(p, f)).toEqual({ ...p, age: 50, includeCash: true, method: 'monte-carlo' });
    const both = withFacts(p, { ...f, partnerAge: 48 });
    expect(both.version).toBe(2);
    expect(both).toEqual({ ...planOf(p), age: 50, partnerAge: 48, includeCash: true, method: 'monte-carlo' });
    expect(withFacts(v2({ stopAtFi: true }), f)).toEqual({ ...v2({ stopAtFi: true }), age: 50, includeCash: true, method: 'monte-carlo' });
  });
});

describe('whether a plan holds an amount', () => {
  test('a version 1 plan’s typed amounts', () => {
    expect(holdsAmounts(DEFAULT_PLAN)).toBe(false);
    expect(holdsAmounts({ ...DEFAULT_PLAN, spending: 40_000 })).toBe(true);
    expect(holdsAmounts({ ...DEFAULT_PLAN, income: [income()] })).toBe(true);
  });

  test('a version 2 plan’s every item’s amount and its own FI number, which typedAmounts doesn’t see', () => {
    const pension = { ...itemFromIncome(income()), kind: 'pension' as const };
    expect(hasTypedAmounts(v2({ items: [pension] }))).toBe(false);
    expect(holdsAmounts(v2({ items: [pension] }))).toBe(true);
    expect(holdsAmounts(v2({ fiNumber: 1_000_000 }))).toBe(true);
    expect(holdsAmounts(v2({ items: [{ ...pension, yearly: null, kind: 'part-time', replaces: 20_000 }] }))).toBe(true);
    expect(holdsAmounts(v2())).toBe(false);
  });
});

describe('which entry is yours', () => {
  const x = entry({ name: 'Stop at 52', createdAt: '2026-10-02T00:00:00.000Z' });
  const y = entry({ name: 'No conversions', createdAt: '2026-10-01T00:00:00.000Z' });

  test('the one the facts name; else main; else the oldest, and said unless it is main without facts', () => {
    expect(mainOf({ main: 'x' }, report([['x', x], [MAIN_ID, entry()]]))).toEqual({ id: 'x', missing: false });
    expect(mainOf({ main: 'gone' }, report([['x', x], [MAIN_ID, entry()]]))).toEqual({ id: MAIN_ID, missing: true });
    expect(mainOf(null, report([['x', x], [MAIN_ID, entry()]]))).toEqual({ id: MAIN_ID, missing: false });
    expect(mainOf(null, report([['x', x], ['y', y]]))).toEqual({ id: 'y', missing: true });
    expect(mainOf({ main: 'gone' }, report([['x', x], ['y', y]]))).toEqual({ id: 'y', missing: true });
    // Made at the same time: by id.
    expect(mainOf(null, report([['b', x], ['a', x]]))).toEqual({ id: 'a', missing: true });
  });

  test('one that can’t be read is still that one, never passed over', () => {
    expect(mainOf({ main: 'x' }, report([[MAIN_ID, entry()]], ['x']))).toEqual({ id: 'x', missing: false });
    expect(mainOf(null, report([['x', x]], [MAIN_ID]))).toEqual({ id: MAIN_ID, missing: false });
    expect(mainOf({ main: 'x' }, report([], [], ['x']))).toEqual({ id: 'x', missing: false });
    expect(mainOf(null, report([], ['q', 'p']))).toEqual({ id: 'p', missing: true });
    expect(mainOf(null, report([]))).toBeNull();
    expect(mainOf({ main: 'x' }, report([]))).toBeNull();
  });
});
