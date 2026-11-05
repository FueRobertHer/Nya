import { describe, expect, test } from 'bun:test';
import { runDrawdown, type Drawdown, type DrawdownInput } from '@/lib/fire/drawdown';
import { compareRows, conversionRun, sameRule } from '@/lib/fire/compare-conversions';
import { DEFAULT_PLAN, type Measured } from '@/lib/fire/plan';
import { detailWork, type DetailedInput } from '@/lib/fire/plan-detail';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planOf } from '@/lib/fire/plan-v2';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import { lawFor } from '@/lib/fire/tax/law';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import type { MixSlot } from '@/lib/fire/tax/mix';
import { NO_STRATEGY, type Strategy } from '@/lib/fire/tax/rules';
import { ON } from './plan-gen';

// A rule over a run of years (T4): what it moves, when that money can be reached, the
// stages and the ACA's counts, and Compare's rows from the plan's own start.

const slot = (owner: MixSlot['owner'], bucket: MixSlot['bucket'], value: number, more: Partial<MixSlot> = {}): MixSlot => ({ owner, bucket, value, basis: 0, reachable: 0, ...more }) as MixSlot;

const SOLO: DrawdownInput = {
  startAge: 50,
  years: 30,
  today: { age: 50, partnerAge: null, calendarYear: 2026 },
  filing: 'single',
  dependents: [],
  rmdAges: { you: 75, partner: 75 },
  slots: [slot('you', 'tax-deferred', 1_000_000)],
  share457: { you: 0, partner: 0 },
  spending: 40_000,
  rule: (rate) => ({ kind: 'constant', rate }),
  realReturn: 0.05,
  inflation: 0.03,
  taxableYield: 0,
  oneOffs: [],
  lower: [],
  income: [],
  health: { coverage: { kind: 'other', yearly: 0 }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
  state: null,
  stateRate: 0,
  law: LAW_2026,
};
const run = (strategy: Strategy, over: Partial<DrawdownInput> = {}): Drawdown => {
  const d = runDrawdown({ ...SOLO, strategy, ...over });
  if ('failed' in d) throw new Error(d.failed);
  return d;
};
const fill = (top: 0.1 | 0.12 | 0.22 | 0.24, convertUntil: number | null = null): Strategy => ({ order: 'standard', conversions: { kind: 'bracket', top }, convertUntil });
const ACA = { coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 } as DrawdownInput['health'];
const sum = (ns: readonly number[]) => ns.reduce((a, b) => a + b, 0);

describe('a rule over the years', () => {
  test('none moves nothing', () => {
    const d = run(NO_STRATEGY);
    expect(sum(d.years.map((y) => y.conversion))).toBe(0);
    expect(d.stages.every((s) => s.converted === 0)).toBe(true);
  });

  test('moves tax-deferred money to Roth up to the age set, and no further', () => {
    const d = run(fill(0.12, 60));
    for (const y of d.years) {
      if (y.age <= 60 && y.start.deferred > 0) expect([y.age, y.conversion > 0]).toEqual([y.age, true]);
      if (y.age > 60) expect([y.age, y.conversion]).toEqual([y.age, 0]);
    }
  });

  test('a conversion is income, in the year it moves', () => {
    // Spending from Roth, so what is income this year is the conversion alone.
    const slots = [slot('you', 'roth', 800_000, { reachable: 800_000 }), slot('you', 'tax-deferred', 800_000)];
    const none = run(NO_STRATEGY, { slots }).years[0];
    const rule = run(fill(0.12), { slots }).years[0];
    expect(none.law.agi).toBe(0);
    expect(rule.conversion).toBeGreaterThan(0);
    expect(rule.law.agi).toBeCloseTo(rule.conversion, 2);
    expect(rule.end.deferred).toBeLessThan(none.end.deferred);
    expect(rule.end.roth).toBeGreaterThan(none.end.roth);
  });

  test('money that moves is kept: the rule’s and none’s balances differ by what the tax took', () => {
    const none = run(NO_STRATEGY).years[0];
    const rule = run(fill(0.12)).years[0];
    const total = (b: typeof none.end) => b.taxable + b.deferred + b.roth + b.hsa;
    expect(total(none.end) - total(rule.end)).toBeCloseTo((rule.tax - none.tax) * (1 + SOLO.realReturn), -1);
  });

  test('a stage says what moved in its years', () => {
    const d = run(fill(0.12));
    expect(sum(d.stages.map((s) => s.converted))).toBeCloseTo(sum(d.years.map((y) => y.conversion)), 6);
    for (const s of d.stages) expect(s.converted).toBeCloseTo(sum(d.years.slice(s.first, s.last).map((y) => y.conversion)), 6);
  });

  test('a fixed amount moves that much, in today’s dollars, while there is money', () => {
    const d = run({ order: 'standard', conversions: { kind: 'fixed', yearly: 20_000 }, convertUntil: 55 });
    expect(d.years[0].conversion).toBeCloseTo(20_000, 0);
    expect(d.years[3].conversion).toBeCloseTo(20_000, 0);
    expect(d.years.find((y) => y.age === 56)!.conversion).toBe(0);
  });
});

describe('the five-year window', () => {
  // Taxable money for about five years, so the first conversions sit until they are old enough.
  const slots = [slot('you', 'taxable', 225_000, { basis: 225_000 }), slot('you', 'tax-deferred', 1_000_000)];

  test('a conversion can be drawn with no penalty five tax years on, and not before', () => {
    const none = run(NO_STRATEGY, { slots });
    const rule = run(fill(0.12), { slots });
    const at = (d: Drawdown, age: number) => d.years.find((y) => y.age === age)!;
    // Under five years, nothing from Roth is reached.
    for (const y of rule.years.filter((x) => x.age < 55)) expect([y.age, y.drawn.roth]).toEqual([y.age, 0]);
    // With no rule the first year past taxable money pays the penalty; with one it needn't.
    expect(at(none, 56).law.penalty).toBeGreaterThan(0);
    expect(at(rule, 56).drawn.roth).toBeGreaterThan(0);
    expect(at(rule, 56).law.penalty).toBe(0);
  });

  test('spent before then, a conversion owes the 10% and no more tax: the cheaper of the two early draws', () => {
    const none = run(NO_STRATEGY).years[0];
    const rule = run(fill(0.12)).years[0];
    expect(none.drawn.penalized).toBeGreaterThan(0);
    expect(rule.drawn.penalized).toBe(0);
    expect(rule.drawn.young).toBeGreaterThan(0);
    expect(rule.law.penalty).toBeCloseTo(rule.drawn.young * 0.1, 4);
  });
});

describe('the ACA’s counts', () => {
  const onAca = (d: Drawdown) => d.years.filter((y) => y.care.people.some((p) => p.status === 'aca')).length;

  test('none on it counts none', () => {
    const d = run(NO_STRATEGY);
    expect(d.aca).toEqual({ on: 0, withCredit: 0 });
  });

  test('the years someone is on it, and those with a credit', () => {
    const d = run(NO_STRATEGY, { health: ACA });
    expect(d.aca.on).toBe(onAca(d));
    expect(d.aca.on).toBeGreaterThan(0);
    expect(d.aca.withCredit).toBe(d.years.filter((y) => y.care.people.some((p) => p.credit > 0)).length);
  });

  test('the rule that keeps under the limit holds at least the credits a higher bracket does', () => {
    const limit = run({ order: 'standard', conversions: { kind: 'aca-then-bracket', top: 0.12 }, convertUntil: null }, { health: ACA });
    const high = run(fill(0.22), { health: ACA });
    expect(limit.aca.on).toBe(high.aca.on);
    expect(limit.aca.withCredit).toBeGreaterThanOrEqual(high.aca.withCredit);
    expect(limit.years.filter((y) => y.age < 65).every((y) => !y.care.overLimit)).toBe(true);
  });

  test('past the age set a floor still lifts income to the line, while someone is on the ACA', () => {
    const until = 55;
    const income = [{ amount: 0, fromYear: 0, inflationAdjusted: true, kind: 'pension', owner: 'you', beforeTax: false, gross: 0 }] as never;
    const d = run({ order: 'standard', conversions: { kind: 'aca-then-bracket', top: 0.12 }, convertUntil: until }, { health: ACA, income, slots: [slot('you', 'roth', 800_000, { reachable: 800_000 }), slot('you', 'tax-deferred', 800_000)], spending: 30_000 });
    const past = d.years.filter((y) => y.age > until && y.age < 65);
    // No year falls under the line while there is money to convert, and none moves more than that.
    for (const y of past) expect([y.age, y.care.underLine]).toEqual([y.age, false]);
    const lifted = past.filter((y) => y.conversion > 0);
    expect(lifted.length).toBeGreaterThan(0);
    const before = d.years.find((y) => y.age === until)!;
    for (const y of lifted) expect(y.conversion).toBeLessThan(before.conversion / 2);
    // Once Roth has gone tax-deferred pays the year, so income is over the line with no conversion.
    expect(past.filter((y) => y.conversion === 0).every((y) => y.drawn.deferred > 0)).toBe(true);
    const medicare = d.years.filter((y) => y.age >= 65 && y.age < 75);
    for (const y of medicare) expect([y.age, y.conversion]).toEqual([y.age, 0]);
  });
});

// Compare's rows, through the figures a page has.
const account = (bucket: string, value: number, basis: number | null = null) => ({ owner: 'you', value, basis, account_id: bucket, bucket });
const group = (bucket: string, ...accounts: ReturnType<typeof account>[]) => ({ bucket, accounts, total: accounts.reduce((s, a) => s + a.value, 0) });
const BUCKETS = {
  groups: [group('taxable', account('taxable', 300_000, 150_000)), group('tax-deferred', account('tax-deferred', 500_000)), group('roth', account('roth', 200_000))],
  roth: [{ owner: 'you', amount: 80_000 }],
  total: 1_000_000,
} as unknown as Pick<BucketsToday, 'groups' | 'roth' | 'total'>;
const INPUT: DetailedInput = {
  calendarYear: 2026,
  filing: 'single',
  dependents: [],
  rmdAges: { you: 75, partner: 75 },
  buckets: BUCKETS,
  savingsSplit: [{ bucket: 'taxable', share: 1 }],
  share457: { you: 0, partner: 0 },
  inflation: 0.03,
  taxableYield: 0,
  health: { coverage: { kind: 'other', yearly: 6_000 }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
  state: null,
  stateRate: 0,
  paidToday: 0,
  strategy: NO_STRATEGY,
  law: lawFor(2026).law,
  lawYear: { year: 2026, behind: false },
};
const PLAN = { ...planOf({ ...DEFAULT_PLAN, age: 45, targetAge: 55, spending: 60_000, savings: 40_000, assets: 1_000_000, realReturn: 0.05, withdrawalRate: 0.04 }), start: 'at-stop' as const };
const M: Measured = { spending: null, savings: null, assets: null };
const figures = (input: DetailedInput): PlanFigures => {
  const f = planFigures(PLAN, M, { count: ON, detailed: detailWork(input) });
  if ('refused' in f) throw new Error(f.refused);
  return f;
};
const keys = (input: DetailedInput) => compareRows(figures(input), input).map((r) => r.key);

describe('Compare’s rows', () => {
  test('the standing rules, with no ACA rule for a plan not on it', () => {
    expect(keys(INPUT)).toEqual(['none', 'fill-10', 'fill-12', 'fill-22']);
  });

  test('the ACA rule, once someone is on it at some year of the run', () => {
    const on = { ...INPUT, health: { ...INPUT.health, coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null } } } as DetailedInput;
    expect(keys(on)).toEqual(['none', 'fill-10', 'fill-12', 'fill-22', 'aca-12']);
  });

  test('your plan’s rule is marked; one that isn’t a standing rule is a row of its own, last', () => {
    expect(compareRows(figures(INPUT), INPUT).filter((r) => r.mine).map((r) => r.key)).toEqual(['none']);
    const filling = { ...INPUT, strategy: fill(0.12) };
    expect(compareRows(figures(filling), filling).filter((r) => r.mine).map((r) => r.key)).toEqual(['fill-12']);
    const fixed: DetailedInput = { ...INPUT, strategy: { order: 'standard', conversions: { kind: 'fixed', yearly: 30_000 }, convertUntil: null } };
    const rows = compareRows(figures(fixed), fixed);
    expect(rows.map((r) => r.key)).toEqual(['none', 'fill-10', 'fill-12', 'fill-22', 'own']);
    expect(rows.filter((r) => r.mine).map((r) => r.key)).toEqual(['own']);
    const until: DetailedInput = { ...INPUT, strategy: fill(0.12, 60) };
    expect(compareRows(figures(until), until).filter((r) => r.mine).map((r) => r.key)).toEqual(['own']);
  });

  test('every row keeps your plan’s order, and each reaches the plan’s own start', () => {
    const roth: DetailedInput = { ...INPUT, strategy: { ...NO_STRATEGY, order: 'roth-before-deferred' } };
    const f = figures(roth);
    const rows = compareRows(f, roth);
    expect(rows.every((r) => r.strategy.order === 'roth-before-deferred')).toBe(true);
    const total = (r: (typeof rows)[number]) => {
      const b = r.drawn.years[0].start;
      return b.taxable + b.deferred + b.roth + b.hsa;
    };
    const first = total(rows[0]);
    expect(rows.every((r) => Math.abs(total(r) - first) < 1)).toBe(true);
  });

  test('the plan’s own row is the run the page already has, so the two can’t differ', () => {
    const f = figures(INPUT);
    const own = conversionRun(f, INPUT, INPUT.strategy)!;
    const rows = compareRows(f, INPUT, own);
    expect(rows.find((r) => r.mine)!.drawn === own).toBe(true);
    expect(rows.find((r) => !r.mine)!.drawn === own).toBe(false);
  });

  test('the same conversions are the same rule, whatever the order', () => {
    expect(sameRule(fill(0.12), { ...fill(0.12), order: 'roth-before-deferred' })).toBe(true);
    expect(sameRule(fill(0.12), fill(0.22))).toBe(false);
    expect(sameRule(fill(0.12), fill(0.12, 60))).toBe(false);
  });

  test('a rule costs more now and leaves less tax-deferred: all it says, with none called best', () => {
    const rows = compareRows(figures(INPUT), INPUT);
    const left = (key: string) => rows.find((r) => r.key === key)!.drawn.years.at(-1)!.end.deferred;
    expect(left('fill-22')).toBeLessThan(left('none'));
    for (const r of rows) expect(Number.isFinite(r.drawn.leftAtEnd) && Number.isFinite(r.drawn.taxAndHealth)).toBe(true);
  });
});
