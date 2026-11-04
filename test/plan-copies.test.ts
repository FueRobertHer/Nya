import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLAN, type FirePlan, type PlanIncome } from '@/lib/fire/plan';
import { basePlanOf, isStoredPlan, planOf, toStored, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { eventItems, itemFromIncome } from '@/lib/fire/items';
import { resolveScenario, type PlanScenario, type ScenarioSet } from '@/lib/fire/scenarios';
import { currencyRecord, hasTypedAmounts } from '@/lib/fire/plan-currency';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import type { LifeEvent } from '@/lib/fire/events';
import { MAIN_ID, factsOf, holdsAmounts, isPlanEntry, isPlanFacts, mainOf, migratePlans, sameFacts, upgradePlanEntry, withFacts, type PlanEntry } from '@/lib/fire/copies';
import { genEvents, genMeasured, genPlan, OFF, ON, rand, type Rand } from './plan-gen';

// Plans as copies, the shapes and the migration in memory (lib/fire/copies.ts):
// what reads, which entry is yours, and each scenario as a copy whose
// figures are the ones the Plan shows for the scenario today.

const AT = '2026-11-03T10:00:00.000Z';
const STAMPS = { main: 'stamp-main', copies: new Map<string, string>() };
const income = (over: Partial<PlanIncome> = {}): PlanIncome => ({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true, ...over });
const entry = (over: Partial<PlanEntry> = {}): PlanEntry => ({ name: 'First plan', plan: DEFAULT_PLAN, tax: null, currency: null, createdAt: AT, updatedAt: AT, ...over });
const scenario = (over: Partial<PlanScenario> = {}): PlanScenario => ({
  version: 1,
  name: 'Retire at 50',
  currency: 'USD',
  createdAt: '2026-10-01T10:00:00.000Z',
  savedAt: '2026-10-01T10:00:00.000Z',
  rev: 'r1',
  set: {},
  income: { leaveOut: [], add: [] },
  expenses: { leaveOut: [], add: [] },
  events: [],
  ...over,
});
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

describe('the plan and its scenarios as copies', () => {
  const typed = { ...DEFAULT_PLAN, age: 40, spending: 40_000, income: [income()] };

  test('your plan as main, as stored, with the facts from its fields; each scenario keeps its id, name and when it was made', () => {
    const s = scenario({ set: { targetAge: 50 } });
    const r = migratePlans(typed, currencyRecord(typed, 'USD'), [['sc1', s]], AT, { main: 'm1', copies: new Map([['sc1', 'c1']]) });
    if (!('ok' in r)) throw new Error(r.error);
    expect(r.ok.main).toEqual({ name: 'First plan', plan: typed, tax: null, currency: 'USD', createdAt: AT, updatedAt: 'm1' });
    expect(r.ok.facts).toEqual({ version: 1, main: MAIN_ID, ...factsOf(typed) });
    expect(r.ok.copies.map((c) => [c.id, c.entry.name, c.entry.createdAt, c.entry.updatedAt, c.notRun])).toEqual([['sc1', 'Retire at 50', s.createdAt, 'c1', null]]);
    expect(r.ok.copies[0].entry.plan).toEqual(planOf({ ...typed, targetAge: 50 }));
    expect(isPlanEntry(r.ok.main) && isPlanEntry(r.ok.copies[0].entry)).toBe(true);
    expect(isPlanFacts(r.ok.facts)).toBe(true);
  });

  test('a copy’s first stamp is the time when none is given', () => {
    const r = migratePlans(null, null, [['sc1', scenario()]], AT, STAMPS);
    expect('ok' in r && r.ok.copies[0].entry.updatedAt).toBe(AT);
  });

  test('never with a currency unknown beside typed amounts: a record of other amounts, or none', () => {
    const other = { ...typed, spending: 50_000 };
    expect(migratePlans(typed, currencyRecord(other, 'USD'), [], AT, STAMPS)).toEqual({ error: 'Say which currency your plan’s figures are in first, so each plan keeps it.' });
    expect('error' in migratePlans(typed, null, [], AT, STAMPS)).toBe(true);
  });

  test('a plan with nothing typed has no currency, and neither has a copy holding nothing', () => {
    const r = migratePlans(DEFAULT_PLAN, null, [['sc1', scenario({ set: { targetAge: 50 } })]], AT, STAMPS);
    if (!('ok' in r)) throw new Error(r.error);
    expect(r.ok.main.currency).toBeNull();
    expect(r.ok.copies[0].entry.currency).toBeNull();
  });

  test('a scenario without amounts of its own takes your plan’s currency, whatever it was saved under; one with its own keeps it', () => {
    const r = migratePlans(
      typed,
      currencyRecord(typed, 'USD'),
      [
        ['shown-eur', scenario({ currency: 'EUR', set: { targetAge: 50 } })],
        ['none', scenario({ currency: null, set: { targetAge: 52 } })],
        ['own', scenario({ currency: 'EUR', set: { spending: 30_000 } })],
      ],
      AT,
      STAMPS
    );
    if (!('ok' in r)) throw new Error(r.error);
    expect(r.ok.copies.map((c) => [c.id, c.entry.currency])).toEqual([
      ['shown-eur', 'USD'],
      ['none', 'USD'],
      ['own', 'EUR'],
    ]);
  });

  test('a scenario’s amounts over a plan with none: its own currency, or none for the newer page to ask', () => {
    const r = migratePlans(DEFAULT_PLAN, null, [['eur', scenario({ currency: 'EUR', set: { spending: 30_000 } })], ['unsaid', scenario({ currency: null, set: { spending: 30_000 } })]], AT, STAMPS);
    if (!('ok' in r)) throw new Error(r.error);
    expect(r.ok.copies.map((c) => c.entry.currency)).toEqual(['EUR', null]);
  });

  test('refused for a version 2 plan, and for a scenario with your plan’s id', () => {
    expect('error' in migratePlans(v2(), null, [], AT, STAMPS)).toBe(true);
    expect(migratePlans(DEFAULT_PLAN, null, [[MAIN_ID, scenario()]], AT, STAMPS)).toEqual({ error: 'A scenario has the id "main", which your plan takes.' });
  });

  test('life events become items after its incomes and one-offs', () => {
    const events: LifeEvent[] = [{ id: 'kid', kind: 'child', label: 'A child', fromAge: 42, yearly: 15_000, years: 18 }];
    const s = scenario({ income: { leaveOut: [], add: [income({ id: 'rent', label: 'Rent', amount: 12_000, fromAge: 50 })] }, expenses: { leaveOut: [], add: [{ id: 'roof', label: 'Roof', amount: 30_000, atAge: 60 }] }, events });
    const r = migratePlans(typed, currencyRecord(typed, 'USD'), [['sc1', s]], AT, STAMPS);
    if (!('ok' in r)) throw new Error(r.error);
    const items = r.ok.copies[0].entry.plan.version === 2 ? r.ok.copies[0].entry.plan.items : [];
    expect(items.map((x) => x.id)).toEqual(['ss', 'rent', 'roof', ...eventItems(events).map((x) => x.id)]);
    expect(items.slice(3)).toEqual(eventItems(events));
  });

  test('a scenario the plan’s rules refuse now is kept, not run, with why, even over the items a plan takes', () => {
    const full = { ...DEFAULT_PLAN, age: 40, income: Array.from({ length: 5 }, (_, i) => income({ id: `i${i}` })), expenses: Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, label: 'Roof', amount: 1_000, atAge: 60 })) };
    const s = scenario({
      currency: 'USD',
      income: { leaveOut: [], add: Array.from({ length: 6 }, (_, i) => income({ id: `a${i}` })) },
      expenses: { leaveOut: [], add: Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, label: 'Car', amount: 2_000, atAge: 61 })) },
      events: genEvents(rand(7), 'ev').slice(0, 6),
    });
    const r = migratePlans(full, currencyRecord(full, 'USD'), [['big', s], ['early', scenario({ set: { targetAge: 30 } })]], AT, STAMPS);
    if (!('ok' in r)) throw new Error(r.error);
    const [big, early] = r.ok.copies;
    expect(big.notRun).toEqual(expect.any(String));
    expect(big.entry.plan.version === 2 && big.entry.plan.items.length).toBeGreaterThan(25);
    expect(isPlanEntry(big.entry)).toBe(true);
    expect(early.notRun).toEqual(expect.any(String));
    expect(early.entry.plan.targetAge).toBe(30);
  });

  test('a replacement of an item the plan no longer has rides along, said', () => {
    const r = migratePlans(typed, currencyRecord(typed, 'USD'), [['sc1', scenario({ income: { leaveOut: ['gone'], add: [income({ id: 'gone', fromAge: 62 })] } })]], AT, STAMPS);
    if (!('ok' in r)) throw new Error(r.error);
    expect(r.ok.copies[0].orphans.income.map((x) => x.id)).toEqual(['gone']);
  });
});

/** A scenario on a plan, as the Plan's page saves one. */
function genScenario(g: Rand, p: FirePlan, i: number): PlanScenario {
  const set: ScenarioSet = {};
  if (g.chance(0.5)) set.targetAge = g.int(30, 75);
  if (g.chance(0.3)) set.spending = g.chance(0.2) ? null : g.int(20, 120) * 1000;
  if (g.chance(0.2)) set.withdrawalRate = g.pick([0.03, 0.035, 0.04]);
  if (g.chance(0.2)) set.realReturn = g.pick([0.02, 0.05]);
  const leaveOut = p.income.filter(() => g.chance(0.3)).map((x) => x.id);
  const add = g.chance(0.3) ? [income({ id: `s${i}inc`, label: 'Rental income', amount: g.int(1, 30) * 1000, fromAge: g.int(30, 80) })] : [];
  const expenses = g.chance(0.3) ? [{ id: `s${i}exp`, label: 'Boat', amount: g.int(1, 100) * 1000, atAge: g.int(30, 90) }] : [];
  return scenario({ name: `Scenario ${i}`, rev: `r${i}`, createdAt: `2026-10-0${i + 1}T10:00:00.000Z`, set, income: { leaveOut, add }, expenses: { leaveOut: p.expenses.filter(() => g.chance(0.2)).map((x) => x.id), add: expenses }, events: g.chance(0.6) ? genEvents(g, `s${i}e`) : [] });
}

/** What the Plan's figures show and walk. A walk with nothing in it is no
 *  walk: the page's scenario has items past the plan's (its life events),
 *  which always give it one, empty or not. */
const walkOf = (f: PlanFigures) => {
  const w = f.events?.walk ?? null;
  return w && Object.values(w).every((x) => Array.isArray(x) && x.length === 0) ? null : w;
};
const shown = (f: PlanFigures | { refused: unknown }) =>
  'refused' in f ? f : { view: f.view, resolution: f.resolution, engine: f.engine, retirement: f.retirement, short: f.short, items: f.items, inWalk: f.inWalk, walk: walkOf(f) };

describe('each copy’s figures are its scenario’s, as the Plan shows them today', () => {
  test.each([
    ['D15 off', OFF],
    ['D15 on', ON],
  ])('%s', (_name, count) => {
    let run = 0;
    let repaired = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const g = rand(seed);
      const generated = genPlan(g, seed % 3 === 0);
      // Some plans need repair today (a rate a later rule narrowed): the
      // copies run on the plan the page runs scenarios on, repaired.
      const legacy: FirePlan = seed % 5 === 0 ? { ...generated, withdrawalRate: 0.5 } : generated;
      if (basePlanOf(legacy).fixed.length > 0) repaired++;
      const scenarios = Array.from({ length: g.int(1, 4) }, (_, i) => [`sc${i}`, genScenario(g, legacy, i)] as const);
      const measured = genMeasured(g);
      const r = migratePlans(legacy, currencyRecord(legacy, 'USD'), scenarios, AT, STAMPS);
      if (!('ok' in r)) throw new Error(r.error);
      const base = toStored(basePlanOf(legacy).plan, 1);
      if ('error' in base) throw new Error(base.error);
      for (const [i, copy] of r.ok.copies.entries()) {
        const s = scenarios[i][1];
        const page = resolveScenario(base.plan, s);
        expect([seed, copy.id, copy.notRun === null]).toEqual([seed, scenarios[i][0], page.ok]);
        if (!page.ok) continue;
        expect(isStoredPlan(copy.entry.plan)).toBe(true);
        const theirs = planFigures(planOf(page.plan), measured, { events: eventItems(s.events), count });
        const ours = planFigures(planOf(copy.entry.plan), measured, { count });
        expect([seed, copy.id, shown(ours)]).toEqual([seed, copy.id, shown(theirs)]);
        run++;
      }
    }
    expect(run).toBeGreaterThan(150);
    expect(repaired).toBeGreaterThan(10);
  });
});
