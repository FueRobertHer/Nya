import { describe, expect, test } from 'bun:test';
import type { IncomeRow } from '@/lib/fire/compile';
import { foldsPartner, runDrawdown, taxShares, type Drawdown, type DrawdownInput, type DrawdownYear } from '@/lib/fire/drawdown';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import type { MixSlot } from '@/lib/fire/tax/mix';

// The years after you stop, year by year (lib/fire/drawdown.ts).

const slot = (owner: MixSlot['owner'], bucket: MixSlot['bucket'], value: number, more: Partial<MixSlot> = {}): MixSlot => ({ owner, bucket, value, basis: 0, reachable: 0, ...more });

const income = (over: Partial<IncomeRow>): IncomeRow => ({ amount: 0, fromYear: 0, inflationAdjusted: true, kind: 'social-security', owner: 'you', beforeTax: true, gross: 0, ...over });

/** The prototype's couple at the stop. */
const COUPLE: DrawdownInput = {
  startAge: 50,
  years: 45,
  today: { age: 41, partnerAge: 40, calendarYear: 2026 },
  filing: 'joint',
  dependents: [],
  rmdAges: { you: 75, partner: 75 },
  slots: [slot('you', 'taxable', 420_000, { basis: 280_000 }), slot('you', 'tax-deferred', 700_000), slot('partner', 'tax-deferred', 200_000), slot('you', 'roth', 120_000, { reachable: 70_000 }), slot('you', 'hsa', 35_000)],
  share457: { you: 0, partner: 0 },
  spending: 64_000,
  rule: (rate) => ({ kind: 'constant', rate }),
  realReturn: 0.05,
  inflation: 0.03,
  taxableYield: 0.02,
  oneOffs: [],
  lower: [],
  income: [income({ fromYear: 17, gross: 30_000 }), income({ fromYear: 18, gross: 18_000, owner: 'partner' })],
  health: { coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
  state: 'NV',
  stateRate: 0,
  law: LAW_2026,
};

function run(over: Partial<DrawdownInput> = {}): Drawdown {
  const d = runDrawdown({ ...COUPLE, ...over });
  if ('failed' in d) throw new Error(d.failed);
  return d;
}

/** Every dollar in a year has somewhere to go. */
function holdsTogether(y: DrawdownYear, inp: Pick<DrawdownInput, 'realReturn' | 'taxableYield'>) {
  const i = y.income;
  const d = y.drawn;
  const cashIn = i.socialSecurity + i.pension + i.wages + i.afterTax + i.windfall + i.yield + y.rmd + y.withdrawal + y.shortfall;
  expect(cashIn).toBeCloseTo(y.living + y.oneOffs + y.health + y.tax + y.surplus, 4);
  const g = 1 + inp.realReturn;
  expect(y.end.taxable).toBeCloseTo((y.start.taxable - d.taxable + y.surplus) * (g - inp.taxableYield), 4);
  expect(y.end.deferred).toBeCloseTo((y.start.deferred - y.rmd - d.deferred - d.deferred457 - d.penalized) * g, 4);
  expect(y.end.roth).toBeCloseTo((y.start.roth - d.roth - d.young - d.earnings) * g, 4);
  expect(y.end.hsa).toBeCloseTo((y.start.hsa - d.hsaPremiums - d.hsaTaxed - d.hsaEarly) * g, 4);
}

describe('each year', () => {
  test('holds together: what comes in pays what goes out, and balances follow', () => {
    for (const inp of [COUPLE, { ...COUPLE, oneOffs: [{ amount: 90_000, year: 3 }], income: [...COUPLE.income, income({ fromYear: 5, toYear: 6, gross: 200_000, kind: 'windfall', beforeTax: false })] }, { ...COUPLE, spending: 200_000 }]) {
      const d = run(inp);
      expect(d.years.length).toBe(45);
      for (const y of d.years) holdsTogether(y, inp);
    }
  });

  test('runs one year into the next, ages and calendar years with it', () => {
    const d = run();
    expect(d.years[0]).toMatchObject({ age: 50, partnerAge: 49, calendarYear: 2035 });
    expect(d.years[44]).toMatchObject({ age: 94, partnerAge: 93, calendarYear: 2079 });
    for (let i = 1; i < d.years.length; i++) expect(d.years[i].start).toEqual(d.years[i - 1].end);
  });

  test('copies what it keeps: no row holds what a later year wrote', () => {
    const d = run();
    expect(d.years[0].drawn).not.toBe(d.years[1].drawn);
    expect(d.years[0].care.people[0]).not.toBe(d.years[1].care.people[0]);
    expect(d.years[0].drawn.taxable).toBeGreaterThan(0);
    expect(d.years[44].drawn.taxable).not.toBe(d.years[0].drawn.taxable);
    expect(d.years[44].care.people[0].status).toBe('medicare');
    expect(d.years[0].care.people[0].status).not.toBe('medicare');
  });

  test('an income by its kind: wages pay FICA, a pension counts, after tax stays outside MAGI, one not kept up shrinks', () => {
    const base = run({ income: [] }).years[0];
    const wages = run({ income: [income({ kind: 'part-time', gross: 40_000 })] }).years[0];
    expect(wages.income.wages).toBe(40_000);
    expect(wages.law.fica).toBeCloseTo(40_000 * 0.0765, 4);
    const pension = run({ income: [income({ kind: 'pension', gross: 40_000 })] }).years[0];
    expect(pension.income.pension).toBe(40_000);
    expect(pension.law.fica).toBe(0);
    const other = run({ income: [income({ kind: 'other-income', gross: 40_000 })] }).years[0];
    expect(other.income.pension).toBe(40_000);
    const after = run({ income: [income({ kind: 'pension', gross: 40_000, beforeTax: false })] }).years[0];
    expect(after.income.afterTax).toBe(40_000);
    expect(after.income.pension).toBe(0);
    expect(after.law.magiAca).toBeLessThan(base.law.magiAca);
    const windfall = run({ income: [income({ kind: 'windfall', gross: 40_000, beforeTax: false, fromYear: 0, toYear: 1 })] }).years;
    expect(windfall[0].income.windfall).toBe(40_000);
    expect(windfall[1].income.windfall).toBe(0);
    const shrinks = run({ income: [income({ kind: 'pension', gross: 40_000, fromYear: 2, inflationAdjusted: false })] }).years;
    expect(shrinks[1].income.pension).toBe(0);
    expect(shrinks[2].income.pension).toBe(40_000);
    expect(shrinks[4].income.pension).toBeCloseTo(40_000 / 1.03 ** 2, 6);
  });

  test('lower costs come off living spending, and what they leave off the year’s one-offs', () => {
    const y = run({ oneOffs: [{ amount: 10_000, year: 0 }], lower: [{ amount: 70_000, fromYear: 0, toYear: 1 }] }).years;
    expect(y[0].living).toBe(0);
    expect(y[0].oneOffs).toBeCloseTo(4_000, 6);
    expect(y[1].living).toBeCloseTo(64_000, 6);
  });

  test('dependents count until you reach the age they leave', () => {
    const d = run({ dependents: [{ untilAge: 52 }], health: { ...COUPLE.health, coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: 4_000 } } });
    expect(d.years[1].care.dependents.status).not.toBe('none');
    expect(d.years[2].care.dependents.status).toBe('none');
  });
});

describe('t and h', () => {
  test('come from the rows, by when each is paid', () => {
    const d = run();
    let tax = 0;
    let cost = 0;
    let health = 0;
    let ones = 0;
    d.years.forEach((y, i) => {
      const v = 1.05 ** -i;
      tax += y.tax * v;
      cost += (y.living + y.oneOffs + y.health + y.tax) * v;
      health += y.health * v;
      ones += v;
    });
    expect(d.t).toBeCloseTo(tax / cost, 10);
    expect(d.h).toBeCloseTo(health / ones, 8);
    expect(d.t).toBeGreaterThan(0);
    expect(d.h).toBeGreaterThan(0);
    expect(taxShares(d.years, 0.05)).toEqual({ t: d.t, h: d.h });
  });

  test('nothing spent is no share, never a division by nothing', () => {
    expect(taxShares([], 0.05)).toEqual({ t: 0, h: 0 });
    expect(taxShares([{ living: 0, oneOffs: 0, health: 0, tax: 0 }], 0.05)).toEqual({ t: 0, h: 0 });
  });

  test('held short of one even when all that is spent is tax', () => {
    expect(taxShares([{ living: 0, oneOffs: 0, health: 0, tax: 100 }], 0.05).t).toBeLessThan(1);
  });
});

describe('the rule', () => {
  test('a constant rule from a fixed start spends the plan’s spending whatever t and h are, in one run', () => {
    const d = run();
    expect(d.rounds).toBe(1);
    expect(d.settled).toBe(true);
    for (const y of d.years) expect(y.living).toBeCloseTo(64_000, 6);
    const start = COUPLE.slots.reduce((s, x) => s + x.value, 0);
    expect(d.rate).toBeCloseTo((64_000 + d.h) / (1 - d.t) / start, 12);
  });

  test('a flexible rule’s fixed point settles and reproduces itself', () => {
    for (const rule of [
      (rate: number) => ({ kind: 'percent', rate }) as const,
      (rate: number) => ({ kind: 'guardrails', rate }) as const,
      (rate: number) => ({ kind: 'floor-ceiling', rate, floor: 0.8, ceiling: 1.2 }) as const,
    ]) {
      const d = run({ rule });
      expect(d.settled).toBe(true);
      expect(d.rounds).toBeGreaterThan(1);
      expect(d.rounds).toBeLessThanOrEqual(8);
      // The first year spends the plan's spending, within what it settled to.
      expect(d.years[0].living).toBeCloseTo(64_000, -1);
    }
  });

  test('VPW sets its own share: its rate is what the year asks, and it never reads as short', () => {
    const d = run({ rule: () => ({ kind: 'vpw', expectedReturn: 0.05 }) });
    expect(d.runsOutAt).toBeNull();
    expect(d.years.every((y) => !y.short)).toBe(true);
    expect(d.years[44].living).toBeGreaterThanOrEqual(0);
  });

  test('a rule’s spending under h holds living spending at zero, and says so', () => {
    const d = run({ spending: 0, rule: (rate) => ({ kind: 'percent', rate: rate * 0 }) });
    expect(d.years.every((y) => y.living === 0)).toBe(true);
    expect(d.notes).toContain('held-at-zero');
  });

  test('a start of nothing draws nothing, never a division by it', () => {
    const d = run({ slots: [] });
    expect(d.rate).toBe(0);
    expect(d.years.length).toBe(45);
  });
});

describe('running short', () => {
  test('is the first year it can’t pay; the years run on, so later health is known', () => {
    const d = run({ spending: 300_000 });
    expect(d.runsOutAt).not.toBeNull();
    expect(d.years.find((y) => y.short)!.age).toBe(d.runsOutAt as number);
    expect(d.years.length).toBe(45);
    expect(d.years[44].health).toBeGreaterThan(0);
    for (const y of d.years) holdsTogether(y, COUPLE);
  });

  test('a one-off larger than everything empties even a rule that takes a share', () => {
    const d = run({ rule: (rate) => ({ kind: 'percent', rate }), oneOffs: [{ amount: 5_000_000, year: 2 }] });
    expect(d.runsOutAt).toBe(52);
  });
});

describe('who files', () => {
  const allYours = COUPLE.slots.map((s) => ({ ...s, owner: 'you' as const }));
  const ssYours = COUPLE.income.map((r) => ({ ...r, owner: 'you' as const }));

  test('single folds a partner’s money and income onto the one return, totals kept, and says so', () => {
    const folded = run({ filing: 'single' });
    const yours = run({ filing: 'single', slots: allYours, income: ssYours });
    expect(folded.years).toEqual(yours.years);
    expect(folded.notes).toContain('folded-partner');
    expect(yours.notes).not.toContain('folded-partner');
    expect(folded.years[0].start.deferred).toBe(900_000);
  });

  test('no household counts as single, and so does a joint return with no partner’s age', () => {
    expect(run({ filing: null }).years).toEqual(run({ filing: 'single' }).years);
    const noAge = run({ today: { ...COUPLE.today, partnerAge: null } });
    expect(noAge.notes).toContain('folded-partner');
    expect(noAge.years[0].partnerAge).toBeNull();
    expect(foldsPartner({ filing: 'joint', today: COUPLE.today, slots: COUPLE.slots, income: COUPLE.income })).toBe(false);
  });

  test('a 457(b) share has no penalty before 60', () => {
    const none = run({ spending: 150_000, slots: [slot('you', 'tax-deferred', 2_000_000)] });
    const all = run({ spending: 150_000, slots: [slot('you', 'tax-deferred', 2_000_000)], share457: { you: 1, partner: 0 } });
    expect(none.years[0].law.penalty).toBeGreaterThan(0);
    expect(all.years[0].law.penalty).toBe(0);
    expect(all.years[0].drawn.deferred457).toBeGreaterThan(0);
  });

  test('a counted education account stands in as tax-deferred', () => {
    const d = run({ slots: [slot('you', 'education', 100_000)] });
    expect(d.years[0].start.deferred).toBe(100_000);
  });
});

describe('law by year', () => {
  test('IRMAA reads two years before, and says when it can’t', () => {
    const rich = run({ startAge: 63, income: [income({ kind: 'pension', gross: 600_000, toYear: 2 })], slots: [slot('you', 'taxable', 3_000_000, { basis: 3_000_000 })] });
    const at = (age: number) => rich.years.find((y) => y.age === age)!;
    expect(at(65).care.people[0].irmaa).toBeGreaterThan(0);
    expect(at(65).care.irmaaUnknown).toBe(false);
    expect(at(66).care.people[0].irmaa).toBeGreaterThan(0);
    expect(at(67).care.people[0].irmaa).toBe(0);
    const retiredAt65 = run({ startAge: 65, income: [], slots: [slot('you', 'taxable', 3_000_000, { basis: 3_000_000 })] });
    expect(retiredAt65.years[0].care.irmaaUnknown).toBe(true);
    expect(retiredAt65.years[2].care.irmaaUnknown).toBe(false);
    expect(retiredAt65.notes).toContain('irmaa-unknown');
    const twoBefore = run({ startAge: 64, income: [income({ kind: 'pension', gross: 600_000, toYear: 1 })], slots: [slot('you', 'taxable', 3_000_000, { basis: 3_000_000 })] });
    expect(twoBefore.years.find((y) => y.age === 66)!.care.people[0].irmaa).toBeGreaterThan(0);
    expect(twoBefore.years.find((y) => y.age === 67)!.care.people[0].irmaa).toBe(0);
  });

  test('stages turn over at 60, 65 and the RMD age', () => {
    const d = run();
    expect(d.stages.map((s) => [s.key, s.from, s.to])).toEqual([
      ['before-60', 50, 59],
      ['before-65', 60, 64],
      ['before-rmd', 65, 74],
      ['rmd', 75, 94],
    ]);
    const s = d.stages[0];
    expect(d.years.slice(s.first, s.last).map((y) => y.age)).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
    expect(s.yearlyTax).toBeCloseTo(d.years.slice(0, 10).reduce((sum, y) => sum + y.tax, 0) / 10, 6);
    expect(d.stages[3].sources.rmd).toBeGreaterThan(0);
    expect(d.stages[0].sources.rmd).toBe(0);
  });

  test('a start later than 60 has no stage before it', () => {
    expect(run({ startAge: 62, years: 33 }).stages.map((s) => s.key)).toEqual(['before-65', 'before-rmd', 'rmd']);
  });

  test('left at the end values tax-deferred and an HSA at the last year’s top rate', () => {
    const d = run();
    const last = d.years[44];
    expect(d.leftAtEnd).toBeCloseTo(last.end.taxable + last.end.roth + (last.end.deferred + last.end.hsa) * (1 - last.law.topRate), 6);
    expect(d.taxAndHealth).toBeCloseTo(d.years.reduce((s, y) => s + y.tax + y.health, 0), 6);
  });

  test('a state’s rate reaches the year', () => {
    const none = run({ state: 'NV', stateRate: 0 }).years[0];
    const some = run({ state: 'CA', stateRate: 0.05 }).years[0];
    expect(none.law.state).toBe(0);
    expect(some.law.state).toBeGreaterThan(0);
  });
});

describe('what it refuses', () => {
  test('says why, so the flat model carries the plan', () => {
    expect(runDrawdown({ ...COUPLE, years: 0 })).toEqual({ failed: expect.any(String) });
    expect(runDrawdown({ ...COUPLE, startAge: 40 })).toEqual({ failed: expect.any(String) });
    expect(runDrawdown({ ...COUPLE, taxableYield: Number.NaN })).toEqual({ failed: expect.any(String) });
    expect(runDrawdown({ ...COUPLE, slots: [slot('you', 'roth', 100, { reachable: 90 })], stateRate: 2 })).toEqual({ failed: expect.any(String) });
  });
});
