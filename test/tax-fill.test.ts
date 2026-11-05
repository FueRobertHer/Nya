import { describe, expect, test } from 'bun:test';
import { seededRandom } from '@/lib/fire/random';
import { acaLimit, fullPriceUnder, health, newHealthResult, onAcaThisYear, povertyLine, type AcaYear, type Coverage } from '@/lib/fire/tax/health';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import type { StateCode } from '@/lib/fire/tax/law/types';
import { lin } from '@/lib/fire/tax/piece';
import { rmd } from '@/lib/fire/tax/rmd';
import { ACA_MARGIN, NO_STRATEGY, bracketTop, defaultUntil, yearRule, type Strategy } from '@/lib/fire/tax/rules';
import { MAX_FILL, checkYearInput, newPersonYear, newYearResult, runYear, runYearFilling, splitConversion, type Ceiling, type YearInput } from '@/lib/fire/tax/year';

// A year's conversions (lib/fire/tax/year.ts) and what each rule asks of a year
// (lib/fire/tax/rules.ts). The fill's answers are checked by plain solves at fixed
// conversions, never from its own search.

const law = LAW_2026;

function year(over: Partial<YearInput> = {}): YearInput {
  return {
    calendarYear: 2026, yearsFromToday: 0, priceLevel: 1, irmaaPriceRatio: 1, filing: 'single',
    people: [newPersonYear(55), newPersonYear(55)], dependents: 0, state: 'NV', stateRate: 0,
    spending: 40_000, oneOffs: 0, windfall: 0, afterTaxIncome: 0, taxableYield: 0, qualifiedShare: 1,
    taxExempt: 0, carryover: 0, irmaaMagi: null, coverage: null,
    medicareExtra: 0, countMedicaid: false, acaLaw: '2026', healthGrowth: 0, incomeGrowth: 0, ceiling: null,
    growth: 0.05, inflation: 0.03, ...over,
  };
}

const conversionOf = (r: ReturnType<typeof newYearResult>) => r.people[0].conversion + r.people[1].conversion;
const measureOf = (target: Ceiling, r: ReturnType<typeof newYearResult>) => (target.on === 'magi' ? r.federal.magiAca.v : r.federal.ordinaryTaxable.v);

describe('filling a year', () => {
  test('$50,000 tax-deferred pays spending under the 12% bracket, and the conversion fills what is left of it', () => {
    const top = bracketTop(law, 'single', 0.12);
    const line: Ceiling = { on: 'ordinary', at: top };
    const inp = year({ spending: 20_000, ceiling: line, fill: line });
    inp.people[0] = { ...newPersonYear(60), deferred: 900_000, roth: 400_000, rothReachable: 400_000 };
    const r = runYearFilling(inp, law, newYearResult());
    expect(r.short).toBe(false);
    expect(r.federal.ordinaryTaxable.v).toBeCloseTo(top, -1);
    expect(r.federal.ordinaryTaxable.v).toBeLessThanOrEqual(top + 0.01);
    // What spending drew from tax-deferred money stays tax-deferred drawing, not moved to Roth.
    expect(r.people[0].drawn.deferred).toBeGreaterThan(19_000);
    expect(r.people[0].drawn.roth).toBe(0);
    // The income is the bracket's top, plus the deduction, from the draw and the conversion.
    expect(r.people[0].conversion + r.people[0].drawn.deferred).toBeCloseTo(top + law.brackets.standard.single, -1);
  });

  test('takes the older owner\'s money first, then the partner\'s', () => {
    const inp = year({ filing: 'joint', spending: 0 });
    inp.people[0] = { ...newPersonYear(60), deferred: 500_000 };
    inp.people[1] = { ...newPersonYear(63), deferred: 30_000 };
    splitConversion(inp, law, 50_000);
    expect(inp.people[1].conversion).toBe(30_000);
    expect(inp.people[0].conversion).toBe(20_000);
    inp.people[1].age = 60;
    splitConversion(inp, law, 50_000);
    expect(inp.people[0].conversion).toBe(50_000);
    expect(inp.people[1].conversion).toBe(0);
  });

  test('never converts what the year must take as its RMD', () => {
    const inp = year({ spending: 0 });
    inp.people[0] = { ...newPersonYear(80), deferred: 100_000, rmdAge: 75 };
    splitConversion(inp, law, 1_000_000);
    expect(inp.people[0].conversion).toBeCloseTo(100_000 - rmd(100_000, 80, 75, law.uniform), 6);
  });

  test('a year already over the line converts nothing, and a year with nothing to convert stops there', () => {
    const line: Ceiling = { on: 'ordinary', at: 10_000 };
    const over = year({ spending: 0, ceiling: line, fill: line });
    over.people[0] = { ...newPersonYear(60), deferred: 900_000, pension: 80_000 };
    expect(conversionOf(runYearFilling(over, law, newYearResult()))).toBe(0);
    const none = year({ spending: 0, ceiling: line, fill: line });
    none.people[0] = { ...newPersonYear(60), roth: 100_000, rothReachable: 100_000 };
    expect(conversionOf(runYearFilling(none, law, newYearResult()))).toBe(0);
  });

  test('a year with less than the line asks converts it all', () => {
    const line: Ceiling = { on: 'ordinary', at: 200_000 };
    const inp = year({ spending: 0, ceiling: line, fill: line });
    inp.people[0] = { ...newPersonYear(60), deferred: 30_000, taxable: 50_000, basis: 50_000 };
    const r = runYearFilling(inp, law, newYearResult());
    expect(conversionOf(r)).toBeCloseTo(30_000, 2);
    expect(r.short).toBe(false);
  });

  test('a floor reaches its line under no ceiling', () => {
    const at = 1.38 * povertyLine(law.medicaidPoverty, 'NV', 1);
    const coverage: Coverage = { kind: 'aca', adult: 12_000, quotedAge: 60, child: null };
    const inp = year({ spending: 5_000, coverage, ceiling: null, fill: { on: 'magi', at } });
    inp.people[0] = { ...newPersonYear(60), deferred: 600_000, roth: 50_000, rothReachable: 50_000 };
    const floor = runYearFilling(inp, law, newYearResult());
    expect(floor.federal.magiAca.v).toBeGreaterThanOrEqual(at - 1);
    expect(floor.short).toBe(false);
  });
});

describe('the order', () => {
  test('Roth before tax-deferred spends reachable Roth first, and the standard order spends tax-deferred first', () => {
    const person = { ...newPersonYear(62), deferred: 300_000, roth: 300_000, rothReachable: 300_000 };
    const standard = runYear(year({ spending: 30_000, people: [{ ...person }, newPersonYear(0)] }), law, newYearResult());
    const rothFirst = runYear(year({ spending: 30_000, order: 'roth-before-deferred', people: [{ ...person }, newPersonYear(0)] }), law, newYearResult());
    expect(standard.people[0].drawn.deferred).toBeGreaterThan(29_000);
    expect(standard.people[0].drawn.roth).toBe(0);
    expect(rothFirst.people[0].drawn.roth).toBeCloseTo(30_000, 2);
    expect(rothFirst.people[0].drawn.deferred).toBe(0);
  });

  test('taxable money still comes before Roth in the Roth first order', () => {
    const person = { ...newPersonYear(62), taxable: 100_000, basis: 100_000, deferred: 300_000, roth: 300_000, rothReachable: 300_000 };
    const r = runYear(year({ spending: 30_000, order: 'roth-before-deferred', people: [person, newPersonYear(0)] }), law, newYearResult());
    expect(r.people[0].drawn.taxable).toBeCloseTo(30_000, 2);
    expect(r.people[0].drawn.roth).toBe(0);
  });

  test('a ceiling holds in the Roth first order', () => {
    const line: Ceiling = { on: 'ordinary', at: 5_000 };
    const person = { ...newPersonYear(62), deferred: 300_000, roth: 10_000, rothReachable: 10_000, taxable: 200_000, basis: 200_000 };
    const r = runYear(year({ spending: 30_000, order: 'roth-before-deferred', ceiling: line, people: [person, newPersonYear(0)] }), law, newYearResult());
    expect(r.crossed).toBe(false);
    expect(r.federal.ordinaryTaxable.v).toBeLessThanOrEqual(5_000 + 0.01);
  });
});

// Seeded random households, as test/tax-year.test.ts draws its cases.
const STATES: (StateCode | null)[] = ['NV', 'TX', 'WI', 'GA', 'DC', 'CA', 'FL', 'AK', null];

function randomYear(rand: () => number): YearInput {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const between = (a: number, b: number) => a + (b - a) * rand();
  const maybe = (p: number) => rand() < p;
  const joint = maybe(0.5);
  const calendarYear = pick([2026, 2026, 2027, 2030]);
  const person = () => {
    const age = Math.floor(between(45, 84));
    const taxable = maybe(0.8) ? between(0, 800_000) : 0;
    const roth = maybe(0.6) ? between(0, 400_000) : 0;
    const reachable = roth * between(0, 0.6);
    const w = roth - reachable;
    return {
      ...newPersonYear(age), rmdAge: pick([73, 75]), taxable, basis: taxable * between(0.3, 1),
      deferred: maybe(0.8) ? between(0, 1_200_000) : 0, deferred457: maybe(0.15) ? between(0, 200_000) : 0,
      roth, rothReachable: reachable, window: [w * 0.05, w * 0.05, w * 0.05, w * 0.05],
      hsa: maybe(0.3) ? between(0, 60_000) : 0, socialSecurity: age >= 62 && maybe(0.7) ? between(10_000, 40_000) : 0,
      pension: maybe(0.15) ? between(0, 30_000) : 0, wages: maybe(0.1) ? between(0, 30_000) : 0,
      meetsRule: maybe(0.2),
    };
  };
  const coverage = pick([
    { kind: 'aca' as const, adult: between(5_000, 15_000), quotedAge: Math.floor(between(40, 60)), child: maybe(0.5) ? between(2_000, 4_000) : null },
    { kind: 'aca' as const, adult: between(5_000, 15_000), quotedAge: 50, child: null },
    { kind: 'other' as const, yearly: between(3_000, 20_000) },
    null,
  ]);
  return year({
    calendarYear, yearsFromToday: calendarYear - 2026, priceLevel: 1.03 ** (calendarYear - 2026), irmaaPriceRatio: maybe(0.5) ? 1.0609 : 1,
    filing: joint ? 'joint' : 'single', people: [person(), person()], dependents: maybe(0.2) ? Math.floor(between(1, 3)) : 0,
    state: pick(STATES), stateRate: maybe(0.4) ? between(0, 0.08) : 0, spending: between(5_000, 120_000),
    oneOffs: maybe(0.1) ? between(0, 40_000) : 0, windfall: maybe(0.05) ? between(0, 30_000) : 0,
    afterTaxIncome: maybe(0.1) ? between(0, 20_000) : 0, taxableYield: between(0, 0.04), qualifiedShare: between(0.5, 1),
    taxExempt: maybe(0.1) ? between(0, 5_000) : 0, carryover: maybe(0.1) ? between(0, 20_000) : 0,
    irmaaMagi: maybe(0.7) ? between(50_000, 600_000) : null, coverage, medicareExtra: between(0, 3_000),
    countMedicaid: maybe(0.1), acaLaw: maybe(0.2) ? 'enhanced' : '2026', healthGrowth: between(0, 0.03), incomeGrowth: between(0, 0.015),
    order: maybe(0.3) ? 'roth-before-deferred' : 'standard', growth: between(-0.2, 0.2), inflation: between(0, 0.05),
  });
}

const room = (inp: YearInput) => {
  const one = (i: number) => {
    const p = inp.people[i];
    return p.deferred + p.deferred457 - rmd(p.deferred + p.deferred457, p.age, p.rmdAge, law.uniform);
  };
  return one(0) + (inp.filing === 'joint' ? one(1) : 0);
};

/** The year at `total` converted, by a plain solve. */
function fixedAt(inp: YearInput, total: number, out: ReturnType<typeof newYearResult>) {
  splitConversion(inp, law, total);
  return runYear(inp, law, out);
}

describe('filling, over generated households', () => {
  const rand = seededRandom(20261105);
  const between = (a: number, b: number) => a + (b - a) * rand();
  const CASES = 800;

  test('a ceiling never crosses for a conversion, and the fill is the least that reaches it', () => {
    let filled = 0;
    let at = 0;
    const out = newYearResult();
    const probe = newYearResult();
    for (let n = 0; n < CASES; n++) {
      const inp = randomYear(rand);
      const line: Ceiling = rand() < 0.5
        ? { on: 'ordinary', at: between(5_000, 200_000) }
        : { on: 'magi', at: between(15_000, 250_000) };
      inp.ceiling = line;
      inp.fill = line;
      checkYearInput(inp);

      const nothing = fixedAt(inp, 0, probe);
      const atNothing = measureOf(line, nothing);
      const shortAtNothing = nothing.short;
      const crossedAtNothing = nothing.crossed;
      runYearFilling(inp, law, out);
      const c = conversionOf(out);

      // Within what there is to convert.
      expect(c).toBeLessThanOrEqual(room(inp) + 0.01);
      if (shortAtNothing) {
        expect(c).toBe(0);
        continue;
      }
      // Its result is a plain solve at that conversion.
      const plain = fixedAt(inp, c, probe);
      expect(out.federal.total.v).toBeCloseTo(plain.federal.total.v, 6);
      expect(out.withdrawal).toBeCloseTo(plain.withdrawal, 6);
      expect(out.short).toBe(plain.short);
      if (c === 0) {
        // Nothing converted: already there, or nothing to convert.
        expect(atNothing >= line.at - 1 || room(inp) <= 0.01 || crossedAtNothing).toBe(true);
        continue;
      }
      filled++;
      // A conversion never crosses the ceiling, and never leaves the year short.
      expect(measureOf(line, out)).toBeLessThanOrEqual(line.at + 0.01);
      expect(out.short).toBe(false);
      const reached = measureOf(line, out) >= line.at - 1;
      if (reached) at++;
      else if (c < room(inp) - 0.01) {
        // Short of it with money left: the very next dollars jump over the line or
        // leave the year short.
        const next = fixedAt(inp, c + 1, probe);
        expect(next.short || measureOf(line, next) > line.at).toBe(true);
      }
      // The least: anything well under it doesn't reach the line.
      for (const share of [0.25, 0.5, 0.75, 0.95]) {
        const less = c * share;
        if (c - less < 5) continue;
        const under = fixedAt(inp, less, probe);
        expect(measureOf(line, under)).toBeLessThan(line.at - 1 + 0.01);
      }
    }
    // The generator has to exercise the search.
    expect(filled).toBeGreaterThan(CASES / 4);
    expect(at).toBeGreaterThan(filled / 2);
  });

  test('a floor reaches its line, or as much as there is, and never takes more solves than it may', () => {
    const out = newYearResult();
    const probe = newYearResult();
    let solves = 0;
    for (let n = 0; n < CASES; n++) {
      const inp = randomYear(rand);
      const line: Ceiling = { on: 'magi', at: between(5_000, 60_000) };
      inp.ceiling = null;
      inp.fill = line;
      const nothing = fixedAt(inp, 0, probe);
      if (nothing.short) continue;
      const before = measureOf(line, nothing);
      runYearFilling(inp, law, out);
      const c = conversionOf(out);
      if (before >= line.at - 1) {
        expect(c).toBe(0);
        continue;
      }
      solves++;
      if (out.short || c >= room(inp) - 0.01) continue;
      expect(measureOf(line, out)).toBeGreaterThanOrEqual(line.at - 1);
    }
    expect(solves).toBeGreaterThan(50);
    expect(MAX_FILL).toBeLessThanOrEqual(32);
  });
});

describe('fullPriceUnder, against health', () => {
  const rand = seededRandom(1105);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const between = (a: number, b: number) => a + (b - a) * rand();
  const healthAt = (y: AcaYear, magi: number, acaLaw: '2026' | 'enhanced') => {
    const m = lin();
    m.v = magi;
    const joint = y.filing === 'joint';
    return health({
      calendarYear: y.calendarYear, yearsFromToday: y.calendarYear - 2026, priceLevel: y.priceLevel, irmaaPriceRatio: 1, filing: y.filing,
      ages: [y.people[0].age, joint ? y.people[1].age : -1], meetsRule: [y.people[0].meetsRule, joint ? y.people[1].meetsRule : false],
      dependents: y.dependents, state: y.state, coverage: y.coverage, medicareExtra: 0, countMedicaid: y.countMedicaid, acaLaw,
      growth: 0, incomeGrowth: 0, magi: m, irmaaMagi: null,
    }, law, newHealthResult());
  };
  const fullPrice = (y: AcaYear, magi: number, acaLaw: '2026' | 'enhanced') => {
    const r = healthAt(y, magi, acaLaw);
    const filers = y.filing === 'joint' ? 2 : 1;
    for (let i = 0; i < filers; i++) if (y.people[i].age < 65 && r.people[i].status === 'under-line') return true;
    return false;
  };

  test('someone under 65 pays full price just under it, and no one just over it; where it is null, no one at any income', () => {
    let some = 0;
    let none = 0;
    for (let n = 0; n < 1_500; n++) {
      const joint = rand() < 0.5;
      const calendarYear = pick([2026, 2027, 2030, 2036]);
      const y: AcaYear = {
        filing: joint ? 'joint' : 'single',
        people: [{ age: Math.floor(between(40, 70)), meetsRule: rand() < 0.4 }, { age: Math.floor(between(40, 70)), meetsRule: rand() < 0.4 }],
        dependents: rand() < 0.2 ? Math.floor(between(1, 3)) : 0,
        state: pick(STATES), calendarYear, priceLevel: 1.03 ** (calendarYear - 2026),
        coverage: { kind: 'aca', adult: 9_000, quotedAge: 50, child: null }, countMedicaid: rand() < 0.2,
      };
      const acaLaw = rand() < 0.2 ? 'enhanced' : '2026';
      const under65 = y.people.slice(0, joint ? 2 : 1).some((p) => p.age < 65);
      const f = fullPriceUnder(y, law);
      if (!under65) {
        expect(f).toBeNull();
        continue;
      }
      if (f === null) {
        none++;
        for (let magi = 500; magi < 80_000; magi += 1_500) expect(fullPrice(y, magi, acaLaw)).toBe(false);
        continue;
      }
      some++;
      expect(fullPrice(y, f - 1, acaLaw)).toBe(true);
      expect(fullPrice(y, f + 1, acaLaw)).toBe(false);
    }
    expect(some).toBeGreaterThan(100);
    expect(none).toBeGreaterThan(100);
  });

  test('no coverage by the ACA, or everyone at Medicare, has no floor', () => {
    const base: AcaYear = { filing: 'single', people: [{ age: 60, meetsRule: false }], dependents: 0, state: 'TX', calendarYear: 2026, priceLevel: 1, coverage: null, countMedicaid: false };
    expect(fullPriceUnder(base, law)).toBeNull();
    expect(fullPriceUnder({ ...base, coverage: { kind: 'other', yearly: 5_000 } }, law)).toBeNull();
    expect(fullPriceUnder({ ...base, coverage: { kind: 'aca', adult: 9_000, quotedAge: 50, child: null }, people: [{ age: 66, meetsRule: false }] }, law)).toBeNull();
  });

  test('$580 a month, deflated, from the work rule in a state without its own', () => {
    const y: AcaYear = { filing: 'single', people: [{ age: 60, meetsRule: false }], dependents: 0, state: 'NV', calendarYear: 2027, priceLevel: 1.03, coverage: { kind: 'aca', adult: 9_000, quotedAge: 50, child: null }, countMedicaid: false };
    expect(fullPriceUnder(y, law)).toBeCloseTo((12 * 580) / 1.03, 6);
    expect(fullPriceUnder({ ...y, people: [{ age: 60, meetsRule: true }] }, law)).toBeNull();
    expect(fullPriceUnder({ ...y, calendarYear: 2026, priceLevel: 1 }, law)).toBeNull();
  });
});

describe('what each rule asks of a year', () => {
  const aca: Coverage = { kind: 'aca', adult: 9_000, quotedAge: 50, child: null };
  const y = (over: Partial<AcaYear> = {}): AcaYear => ({
    filing: 'joint', people: [{ age: 55, meetsRule: false }, { age: 53, meetsRule: false }], dependents: 0, state: 'NV',
    calendarYear: 2026, priceLevel: 1, coverage: aca, countMedicaid: false, ...over,
  });
  const rule = (conversions: Strategy['conversions'], convertUntil: number | null = null): Strategy => ({ order: 'standard', conversions, convertUntil });
  const top12 = bracketTop(law, 'joint', 0.12);

  test('none asks nothing at any age', () => {
    for (const age of [40, 60, 90]) expect(yearRule(NO_STRATEGY, 74, age, y(), law)).toEqual({ ceiling: null, fill: null, fixed: 0 });
  });

  test('a bracket, to the age set and through it, and nothing after', () => {
    const r = rule({ kind: 'bracket', top: 0.12 });
    expect(yearRule(r, 74, 74, y(), law)).toEqual({ ceiling: { on: 'ordinary', at: top12 }, fill: { on: 'ordinary', at: top12 }, fixed: 0 });
    expect(yearRule(r, 74, 75, y(), law)).toEqual({ ceiling: null, fill: null, fixed: 0 });
  });

  test('a fixed amount, to the age set, under no ceiling', () => {
    const r = rule({ kind: 'fixed', yearly: 30_000 });
    expect(yearRule(r, 60, 60, y(), law)).toEqual({ ceiling: null, fill: null, fixed: 30_000 });
    expect(yearRule(r, 60, 61, y(), law).fixed).toBe(0);
  });

  test('the ACA rule: the limit less the margin while someone is on the ACA, then the bracket', () => {
    const r = rule({ kind: 'aca-then-bracket', top: 0.12 });
    const limit = 4 * povertyLine(law.creditPoverty, 'NV', 2) - ACA_MARGIN;
    expect(yearRule(r, 74, 55, y(), law)).toEqual({ ceiling: { on: 'magi', at: limit }, fill: { on: 'magi', at: limit }, fixed: 0 });
    // One 65, the other 63: still on the ACA, for one, on the family's line.
    expect(yearRule(r, 74, 65, y({ people: [{ age: 65, meetsRule: false }, { age: 63, meetsRule: false }] }), law).ceiling).toEqual({ on: 'magi', at: limit });
    // Both on Medicare.
    expect(yearRule(r, 74, 67, y({ people: [{ age: 67, meetsRule: false }, { age: 65, meetsRule: false }] }), law).ceiling).toEqual({ on: 'ordinary', at: top12 });
    // A child on the ACA while the adults are on Medicare.
    const child: AcaYear = y({ people: [{ age: 67, meetsRule: false }, { age: 65, meetsRule: false }], dependents: 1, coverage: { ...aca, child: 3_000 } });
    expect(onAcaThisYear(child)).toBe(true);
    expect(yearRule(r, 74, 67, child, law).ceiling).toEqual({ on: 'magi', at: 4 * povertyLine(law.creditPoverty, 'NV', 3) - ACA_MARGIN });
  });

  test('the ACA rule still stops at 400% where the law has no cliff', () => {
    const noCliff = { ...law, aca: { ...law.aca, cliff: null } };
    expect(acaLimit(y(), noCliff)).toBe(4 * povertyLine(law.creditPoverty, 'NV', 2));
  });

  test('past the age set, on the ACA, only a floor, at the income under which coverage is full price', () => {
    const r = rule({ kind: 'aca-then-bracket', top: 0.12 });
    const nv = y({ calendarYear: 2027 });
    const floor = fullPriceUnder(nv, law) as number;
    expect(yearRule(r, 50, 55, nv, law)).toEqual({ ceiling: null, fill: { on: 'magi', at: floor + ACA_MARGIN }, fixed: 0 });
    // Where Medicaid is free, no floor.
    expect(yearRule(r, 50, 55, y({ calendarYear: 2026 }), law)).toEqual({ ceiling: null, fill: null, fixed: 0 });
    // Past it, off the ACA, nothing.
    expect(yearRule(r, 50, 67, y({ people: [{ age: 67, meetsRule: false }, { age: 65, meetsRule: false }] }), law)).toEqual({ ceiling: null, fill: null, fixed: 0 });
    // Only the ACA rule has one.
    expect(yearRule(rule({ kind: 'bracket', top: 0.12 }), 50, 55, nv, law)).toEqual({ ceiling: null, fill: null, fixed: 0 });
  });

  test('until: the year before the earlier owner\'s RMDs, in your age', () => {
    expect(defaultUntil({ you: 75, partner: 75 }, { age: 41, partnerAge: null })).toBe(74);
    // A partner three years older reaches 75 at your 72.
    expect(defaultUntil({ you: 75, partner: 75 }, { age: 41, partnerAge: 44 })).toBe(71);
    expect(defaultUntil({ you: 73, partner: 75 }, { age: 41, partnerAge: 38 })).toBe(72);
    expect(defaultUntil({ you: 75, partner: 73 }, { age: 41, partnerAge: 41 })).toBe(72);
  });
});
