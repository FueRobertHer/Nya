import { describe, expect, test } from 'bun:test';
import { seededRandom } from '@/lib/fire/random';
import { federal, newFederalInput, newFederalResult } from '@/lib/fire/tax/federal';
import { benchmarkAt, health, newHealthResult, povertyLine, type HealthInput } from '@/lib/fire/tax/health';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import type { StateCode } from '@/lib/fire/tax/law/types';
import { begin, lin } from '@/lib/fire/tax/piece';
import {
  PAY_EPS, capacity, checkYearInput, newPersonYear, newYearResult, pieceAt, runYear, surplusAt, type YearInput,
} from '@/lib/fire/tax/year';

// The year (lib/fire/tax/year.ts): hand-worked years, then properties over
// seeded random households. The properties: cost rises with income outside
// the lines where it falls, the cliff is exactly at 400%, and the solver's
// answer is the least withdrawal that pays, checked independently of the
// solver's own pieces.

const law = LAW_2026;

function year(over: Partial<YearInput> = {}): YearInput {
  return {
    calendarYear: 2026, yearsFromToday: 0, priceLevel: 1, irmaaPriceRatio: 1, filing: 'single',
    people: [newPersonYear(55), newPersonYear(55)], dependents: 0, state: 'NV', stateRate: 0,
    spending: 40_000, oneOffs: 0, windfall: 0, afterTaxIncome: 0, taxableYield: 0, qualifiedShare: 1,
    taxExempt: 0, carryover: 0, irmaaMagi: null, coverage: { kind: 'aca', adult: 9_000, quotedAge: 55, child: null },
    medicareExtra: 0, countMedicaid: false, acaLaw: '2026', healthGrowth: 0, incomeGrowth: 0, ceiling: null,
    growth: 0.05, inflation: 0.03, ...over,
  };
}

function solve(inp: YearInput) {
  checkYearInput(inp);
  return runYear(inp, law, newYearResult());
}

describe('hand-worked years', () => {
  test('single at 55 on taxable money, on the ACA: $51,015.63 drawn, MAGI $37,507.81, all gains in the 0% band', () => {
    // $600,000 taxable at half basis, a 2% yield ($12,000, 80% qualified),
    // spending $60,000. MAGI = $12,000 + half of x; above 138% of Medicaid's
    // line the credit applies. At 239% the figure is 6.60% + 39/50 of 1.84%,
    // 0.0804, so MAGI = $36,000 + 0.0402 x MAGI = $37,507.81, the contribution
    // $3,015.63, and x = $48,000 + $3,015.63. No ordinary taxable income.
    const inp = year({ spending: 60_000, taxableYield: 0.02, qualifiedShare: 0.8 });
    inp.people[0].taxable = 600_000;
    inp.people[0].basis = 300_000;
    const r = solve(inp);
    const magi = 36_000 / (1 - 0.0402);
    expect(r.federal.magiAca.v).toBeCloseTo(magi, 4);
    expect(r.health.linePercent).toBe(239);
    expect(r.health.total.v).toBeCloseTo(0.0804 * magi, 4);
    expect(r.withdrawal).toBeCloseTo(48_000 + 0.0804 * magi, 4);
    expect(r.federal.total.v).toBeCloseTo(0, 6);
    expect(r.people[0].drawn.gain).toBeCloseTo(r.withdrawal / 2, 4);
    expect(r.missedKinks).toBe(0);
  });

  test('a couple at 66 and 61: a Medicare spouse in a family of 2, the partner on the ACA; the year agrees with federal and health run on its own income', () => {
    const inp = year({ filing: 'joint', spending: 40_000, irmaaMagi: 90_000, coverage: { kind: 'aca', adult: 10_000, quotedAge: 61, child: null } });
    inp.people[0] = { ...newPersonYear(66), deferred: 600_000, socialSecurity: 24_000 };
    inp.people[1] = { ...newPersonYear(61), deferred: 300_000 };
    const r = solve(inp);
    expect(r.health.people.map((p) => p.status)).toEqual(['medicare', 'aca']);
    expect(r.health.creditPoverty).toBe(21_150);
    // The older owner's tax-deferred money first.
    expect(r.people[0].drawn.deferred).toBeCloseTo(r.withdrawal, 6);
    expect(r.people[1].drawn.deferred).toBe(0);
    // Federal and health on that income alone give the same year.
    const fi = newFederalInput('joint');
    fi.aged = 1;
    fi.ordinary = lin(r.withdrawal);
    fi.socialSecurity = 24_000;
    begin(false);
    const fo = federal(fi, law, newFederalResult());
    const hi: HealthInput = {
      calendarYear: 2026, yearsFromToday: 0, priceLevel: 1, irmaaPriceRatio: 1, filing: 'joint', ages: [66, 61],
      meetsRule: [false, false], dependents: 0, state: 'NV', coverage: inp.coverage, medicareExtra: 0, countMedicaid: false,
      acaLaw: '2026', growth: 0, incomeGrowth: 0, magi: lin(fo.magiAca.v), irmaaMagi: 90_000,
    };
    const ho = health(hi, law, newHealthResult());
    expect(24_000 + r.withdrawal - 40_000 - fo.total.v - ho.total.v).toBeCloseTo(0, 5);
    expect(r.federal.total.v).toBeCloseTo(fo.total.v, 6);
  });

  test('RMDs at 75 and 80: paid whatever the need, the surplus reinvested in taxable at full basis', () => {
    const inp = year({ filing: 'joint', spending: 30_000, irmaaMagi: 150_000 });
    inp.people[0] = { ...newPersonYear(80), rmdAge: 73, deferred: 1_000_000, socialSecurity: 30_000 };
    inp.people[1] = { ...newPersonYear(75), rmdAge: 75, deferred: 500_000, socialSecurity: 20_000 };
    const r = solve(inp);
    expect(r.people[0].rmd).toBeCloseTo(1_000_000 / 20.2, 6);
    expect(r.people[1].rmd).toBeCloseTo(500_000 / 24.6, 6);
    expect(r.withdrawal).toBe(0);
    const surplus = 50_000 + r.people[0].rmd + r.people[1].rmd - 30_000 - r.federal.total.v - r.health.total.v;
    expect(r.surplus).toBeCloseTo(surplus, 6);
    expect(r.people[0].end.taxable).toBeCloseTo(surplus * 1.05, 6);
    expect(r.people[0].end.basis).toBeCloseTo(surplus / 1.03, 6);
    expect(r.people[0].end.deferred).toBeCloseTo((1_000_000 - r.people[0].rmd) * 1.05, 6);
  });

  test('a short year withdraws everything and says what it lacks', () => {
    const inp = year({ spending: 50_000, taxableYield: 0.02 });
    inp.people[0].taxable = 10_000;
    inp.people[0].basis = 10_000;
    const r = solve(inp);
    expect(r.short).toBe(true);
    expect(r.withdrawal).toBeCloseTo(10_000, 6);
    expect(r.shortfall).toBeCloseTo(50_000 - 10_000 - 200 - r.federal.total.v - r.health.total.v, 6);
  });

  test('59 1/2 by whole years: at 59 tax-deferred money pays the 10%, at 60 it does not', () => {
    for (const [age, penalty] of [[59, true], [60, false]] as const) {
      const inp = year({ spending: 30_000, state: 'TX' });
      inp.people[0] = { ...newPersonYear(age), deferred: 500_000 };
      const r = solve(inp);
      expect(r.people[0].drawn.penalized > 0).toBe(penalty);
      expect(r.federal.penalty.v > 0).toBe(penalty);
    }
  });

  test("an HSA from 65 pays Part B and IRMAA untaxed first; the order's categories, the older owner first", () => {
    const inp = year({ filing: 'joint', spending: 50_000, irmaaMagi: 300_000 });
    inp.people[0] = { ...newPersonYear(64), taxable: 100_000, basis: 100_000, hsa: 40_000 };
    inp.people[1] = { ...newPersonYear(66), taxable: 100_000, basis: 100_000, hsa: 40_000 };
    const r = solve(inp);
    const eligible = r.health.hsaEligible;
    expect(eligible).toBeGreaterThan(2_434.8);
    // Only the 66-year-old's HSA may pay them; then the older owner's taxable money.
    expect(r.people[1].drawn.hsaPremiums).toBeCloseTo(eligible, 6);
    expect(r.people[0].drawn.hsaPremiums).toBe(0);
    expect(r.people[1].drawn.taxable).toBeCloseTo(r.withdrawal - eligible, 6);
    expect(r.people[0].drawn.taxable).toBe(0);
  });

  test('with an ACA ceiling, taxable sales stop at it and reachable Roth pays the rest', () => {
    const ceiling = 4 * 15_650 - 500;
    const inp = year({ spending: 90_000, ceiling: { on: 'magi', at: ceiling } });
    inp.people[0] = { ...newPersonYear(62), taxable: 300_000, basis: 100_000, roth: 300_000, rothReachable: 300_000, deferred: 500_000 };
    const r = solve(inp);
    expect(r.crossed).toBe(false);
    expect(r.federal.magiAca.v).toBeCloseTo(ceiling, 4);
    expect(r.people[0].drawn.taxable).toBeCloseTo((ceiling * 3) / 2, 4);
    expect(r.people[0].drawn.roth).toBeGreaterThan(0);
    expect(r.people[0].drawn.deferred).toBe(0);
  });

  test('with no money that stays under the ceiling, the year crosses and says so', () => {
    const inp = year({ spending: 90_000, ceiling: { on: 'magi', at: 40_000 } });
    inp.people[0] = { ...newPersonYear(62), taxable: 300_000, basis: 100_000, deferred: 500_000 };
    const r = solve(inp);
    expect(r.crossed).toBe(true);
    expect(r.federal.magiAca.v).toBeGreaterThan(40_000);
  });
});

describe('a bracket ceiling and the senior phase-out', () => {
  test("sales that raise ordinary taxable income only past $150,000 of MAGI stop there", () => {
    // Two seniors at 70 with $70,000 of Social Security and a $60,000 pension:
    // at no withdrawal, AGI $109,350 ($49,350 of the benefits taxable) and
    // ordinary taxable income $61,850. A sale's gain (two thirds of it) first
    // raises the taxable share until it reaches 85% ($59,500), then nothing
    // until AGI passes $150,000, where each dollar of gain phases out 12 cents
    // of the senior deduction. Under a ceiling of $80,000 the sales stop there
    // and Roth money pays the rest.
    const inp = year({ filing: 'joint', spending: 300_000, irmaaMagi: 100_000, ceiling: { on: 'ordinary', at: 80_000 } });
    inp.people[0] = { ...newPersonYear(70), rmdAge: 75, taxable: 900_000, basis: 300_000, roth: 400_000, rothReachable: 400_000, socialSecurity: 40_000, pension: 60_000 };
    inp.people[1] = { ...newPersonYear(70), rmdAge: 75, socialSecurity: 30_000 };
    const before = solve({ ...inp, spending: 0, ceiling: null });
    expect(before.federal.ordinaryTaxable.v).toBeCloseTo(61_850, 6);
    const r = solve(inp);
    expect(r.missedKinks).toBe(0);
    expect(r.crossed).toBe(false);
    expect(r.federal.ordinaryTaxable.v).toBeCloseTo(80_000, 4);
    // $59,500 taxable; the senior deduction $12,000 less 12% of AGI over $150,000.
    expect(r.federal.taxableSocialSecurity.v).toBeCloseTo(59_500, 4);
    expect(r.federal.agi.v).toBeCloseTo(150_000 + (80_000 - 72_000) / 0.12, 3);
    expect(r.people[0].drawn.roth).toBeGreaterThan(0);
  });

  test('a year already over the ceiling at no withdrawal still draws what stays under it first', () => {
    const inp = year({ filing: 'joint', spending: 200_000, irmaaMagi: 100_000, ceiling: { on: 'ordinary', at: 50_000 } });
    inp.people[0] = { ...newPersonYear(70), rmdAge: 75, pension: 120_000, taxable: 200_000, basis: 50_000, roth: 50_000, rothReachable: 50_000 };
    inp.people[1] = { ...newPersonYear(70), rmdAge: 75 };
    const r = solve(inp);
    expect(r.crossed).toBe(true);
    expect(r.people[0].drawn.roth).toBeCloseTo(50_000, 6);
  });
});

describe('the five-year clock', () => {
  test('a conversion in Y is drawn as young with the 10% in Y to Y+4, and is reachable in Y+5', () => {
    let inp = year({ spending: 2_000, state: 'TX', coverage: null });
    inp.people[0] = { ...newPersonYear(50), deferred: 200_000, conversion: 50_000 };
    for (let y = 0; y <= 5; y++) {
      const r = solve(inp);
      if (y <= 4) {
        expect(r.people[0].drawn.young).toBeGreaterThan(0);
        expect(r.federal.penalty.v).toBeCloseTo(0.1 * r.people[0].drawn.young, 6);
      } else {
        expect(r.people[0].drawn.young).toBe(0);
        expect(r.people[0].drawn.roth).toBeGreaterThan(0);
        expect(r.federal.penalty.v).toBe(0);
      }
      const e = r.people[0].end;
      inp = year({ spending: 2_000, state: 'TX', coverage: null, calendarYear: 2027 + y });
      inp.people[0] = {
        ...newPersonYear(51 + y), deferred: e.deferred, roth: e.roth, rothReachable: e.rothReachable, window: [...e.window],
      };
    }
  });
});

// Seeded random households, as fire-path.test.ts draws its cases.
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
      ...newPersonYear(age), rmdAge: pick([73, 75]), taxable, basis: taxable * between(0.3, maybe(0.1) ? 1.3 : 1),
      deferred: maybe(0.8) ? between(0, 1_200_000) : 0, deferred457: maybe(0.15) ? between(0, 200_000) : 0,
      roth, rothReachable: reachable, window: [w * 0.05, w * 0.05, w * 0.05, w * 0.05],
      hsa: maybe(0.3) ? between(0, 60_000) : 0, socialSecurity: age >= 62 && maybe(0.7) ? between(10_000, 40_000) : 0,
      pension: maybe(0.15) ? between(0, 30_000) : 0, wages: maybe(0.1) ? between(0, 30_000) : 0,
      conversion: age < 60 && maybe(0.15) ? between(0, 40_000) : 0, meetsRule: maybe(0.2),
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
    state: pick(STATES), stateRate: maybe(0.4) ? between(0, 0.08) : 0, spending: between(15_000, 150_000),
    oneOffs: maybe(0.1) ? between(0, 40_000) : 0, windfall: maybe(0.05) ? between(0, 30_000) : 0,
    afterTaxIncome: maybe(0.1) ? between(0, 20_000) : 0, taxableYield: between(0, 0.04), qualifiedShare: between(0.5, 1),
    taxExempt: maybe(0.1) ? between(0, 5_000) : 0, carryover: maybe(0.1) ? between(0, 20_000) : 0,
    irmaaMagi: maybe(0.7) ? between(50_000, 600_000) : null, coverage, medicareExtra: between(0, 3_000),
    countMedicaid: maybe(0.1), acaLaw: maybe(0.2) ? 'enhanced' : '2026', healthGrowth: between(0, 0.03), incomeGrowth: between(0, 0.015),
    growth: between(-0.2, 0.2), inflation: between(0, 0.05),
  });
}

/** The withdrawals at which the year's MAGI reaches `level`, by bisection on
 *  plain evaluations (MAGI along the order is monotone here). */
function reaching(inp: YearInput, out: ReturnType<typeof newYearResult>, upTo: number, level: (x: number) => number): number | null {
  let lo = 0;
  let hi = upTo;
  if (level(lo) >= 0 || level(hi) < 0) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (level(mid) >= 0) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Checks that the solver's answer for `inp` pays and that nothing below it
 *  does: on a $25 grid, a cent below, and either side of every jump below it
 *  (the credit's 100% and 400%, the Medicaid lines, the work rule's income,
 *  each whole-percent cell), found by bisection on plain evaluations, not
 *  from the solver's pieces. Returns the solver's result. */
function checkLeast(inp: YearInput) {
  checkYearInput(inp);
  const r = runYear(inp, law, newYearResult());
  expect(r.missedKinks).toBe(0);
  expect(Number.isFinite(r.withdrawal)).toBe(true);
  if (r.short) return r;
  const probe = newYearResult();
  const x = r.withdrawal;
  expect(surplusAt(inp, law, probe, x)).toBeGreaterThanOrEqual(-PAY_EPS);
  if (x === 0) return r;
  const pays = (at: number) => surplusAt(inp, law, probe, at) >= -PAY_EPS;
  for (let at = 0; at < x - 0.01; at += 25) expect(pays(at)).toBe(false);
  if (x >= 0.01) expect(pays(x - 0.01)).toBe(false);
  const size = (inp.filing === 'joint' ? 2 : 1) + inp.dependents;
  const pc = povertyLine(law.creditPoverty, inp.state, size);
  const pm = povertyLine(law.medicaidPoverty, inp.state, size);
  const levels = [pc, 4 * pc, 1.38 * pm, 2.15 * pm, pm, 6_960 / inp.priceLevel];
  for (let pct = 101; pct < 400; pct++) levels.push((pct * pc) / 100);
  const magiAt = (at: number) => (surplusAt(inp, law, probe, at), probe.federal.magiAca.v);
  if (magiAt(x) < magiAt(0)) return r; // a falling MAGI (a loss sale) has no simple inverse
  for (const level of levels) {
    if (level > magiAt(x)) continue;
    const at = reaching(inp, probe, x, (v) => magiAt(v) - level);
    if (at === null || at >= x - 0.01) continue;
    for (const d of [-1e-6, 0, 1e-6]) if (at + d >= 0 && at + d < x - 0.01) expect(pays(at + d)).toBe(false);
  }
  return r;
}

describe('the solver against independent checks', () => {
  test("random households: the answer pays, and nothing below it does", () => {
    const rand = seededRandom(2026);
    let checked = 0, payingAtZero = 0, inCells = 0, short = 0, mixed = 0, loss = 0;
    for (let c = 0; c < 160; c++) {
      const inp = randomYear(rand);
      const r = checkLeast(inp);
      if (r.short) short++;
      else if (r.withdrawal === 0) payingAtZero++;
      else checked++;
      if (r.health.figure > 0 && r.health.linePercent > 133 && r.health.linePercent < 300) inCells++;
      if (inp.filing === 'joint' && (inp.people[0].age >= 65) !== (inp.people[1].age >= 65)) mixed++;
      if (inp.people[0].basis > inp.people[0].taxable && inp.people[0].taxable > 0) loss++;
    }
    // Every region the solver has to get right was visited.
    expect(checked).toBeGreaterThan(60);
    expect(payingAtZero).toBeGreaterThan(3);
    expect(inCells).toBeGreaterThan(5);
    expect(short).toBeGreaterThan(0);
    expect(mixed).toBeGreaterThan(3);
    expect(loss).toBeGreaterThan(0);
  }, 60_000);

  test('just below the cliff: spending swept until the year can no longer stay under 400%', () => {
    // Single at 50 in Texas, half-gain taxable money, all gains in the 0%
    // band: MAGI is half the withdrawal, so 400% ($62,600) is reached near
    // $118,965 of spending (x = spending + 9.96% of MAGI). Past that the year
    // must jump over the cliff to full price.
    let under = 0, over = 0;
    for (let spending = 118_400; spending <= 119_600; spending += 20) {
      const inp = year({ state: 'TX', spending, coverage: { kind: 'aca', adult: 14_000, quotedAge: 50, child: null } });
      inp.people[0] = { ...newPersonYear(50), taxable: 900_000, basis: 450_000 };
      const r = checkLeast(inp);
      const room = 4 * 15_650 - r.federal.magiAca.v;
      if (room >= 0 && room < 100) under++;
      if (r.health.people[0].status === 'over-cliff') over++;
    }
    expect(under).toBeGreaterThan(3);
    expect(over).toBeGreaterThan(3);
  }, 60_000);

  test('a year that pays only at exactly 400%, half a micro-dollar short of zero there, takes the cliff', () => {
    const inp = year({ state: 'TX', spending: 100_000, coverage: { kind: 'aca', adult: 14_000, quotedAge: 50, child: null } });
    inp.people[0] = { ...newPersonYear(50), taxable: 900_000, basis: 450_000 };
    const probe = newYearResult();
    const cliff = 4 * 15_650;
    const at = reaching(inp, probe, 900_000, (v) => (surplusAt(inp, law, probe, v), probe.federal.magiAca.v) - cliff)!;
    // Spending such that the surplus at the cliff is -PAY_EPS / 2: it pays there, and nowhere below.
    inp.spending += surplusAt(inp, law, probe, at) + PAY_EPS / 2;
    const r = checkLeast(inp);
    expect(r.withdrawal).toBeCloseTo(at, 5);
    expect(r.health.people[0].status).toBe('aca');
  });

  test('open at the Medicaid line: full price at it, the credit a cent above', () => {
    // Counting Medicaid's full price in an expansion state: at 138% of
    // Medicaid's line full price, just above it the credit, so the paying set
    // starts just past the line and has no least point.
    let opened = 0;
    for (const adult of [8_000, 10_000, 12_000]) {
      const inp = year({ countMedicaid: true, coverage: { kind: 'aca', adult, quotedAge: 55, child: null } });
      inp.people[0] = { ...newPersonYear(55), taxable: 400_000, basis: 200_000 };
      const probe = newYearResult();
      const line = 1.38 * 15_960;
      const at = reaching(inp, probe, 400_000, (v) => (surplusAt(inp, law, probe, v), probe.federal.magiAca.v) - line)!;
      // Spending such that at the line the year is short by half the benchmark.
      inp.spending += surplusAt(inp, law, probe, at) + adult / 2;
      const r = checkLeast(inp);
      expect(r.open).toBe(true);
      expect(r.withdrawal).toBeCloseTo(at + 0.01, 4);
      opened++;
    }
    expect(opened).toBe(3);
  });

  test('the room is honest: the surplus is affine up to it', () => {
    const rand = seededRandom(7);
    const out = newYearResult();
    let checked = 0;
    for (let c = 0; c < 300; c++) {
      const inp = randomYear(rand);
      const top = capacity(inp, law, out);
      if (top <= 0) continue;
      const x = rand() * top;
      const piece = pieceAt(inp, law, out, x);
      if (!(piece.room > 1e-3) || !Number.isFinite(piece.room)) continue;
      for (const t of [piece.room / 2, 0.999 * piece.room]) {
        const v = surplusAt(inp, law, out, x + t);
        expect(Math.abs(v - (piece.v + piece.s * t))).toBeLessThan(1e-6 * Math.max(1, Math.abs(v)));
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  test('the same input gives the same answer', () => {
    const rand = seededRandom(11);
    for (let c = 0; c < 40; c++) {
      const inp = randomYear(rand);
      const a = runYear(inp, law, newYearResult());
      const b = runYear(inp, law, newYearResult());
      expect(b.withdrawal).toBe(a.withdrawal);
      expect(b.federal.total.v).toBe(a.federal.total.v);
    }
  });

  test('with a ceiling and enough reachable Roth, the answer never crosses', () => {
    const rand = seededRandom(31);
    let checked = 0;
    for (let c = 0; c < 120; c++) {
      const inp = randomYear(rand);
      const p = inp.people[0];
      p.roth = p.rothReachable = 2_000_000;
      p.window = [0, 0, 0, 0];
      p.deferred = Math.min(p.deferred, 50_000); // RMDs that can't cross by themselves
      p.pension = 0;
      inp.people[1] = { ...inp.people[1], deferred: 0, pension: 0, wages: 0, conversion: 0 };
      p.wages = 0;
      p.conversion = 0;
      inp.ceiling = { on: rand() < 0.5 ? 'magi' : 'ordinary', at: 60_000 };
      const r = runYear(inp, law, newYearResult());
      const m = inp.ceiling.on === 'magi' ? r.federal.magiAca.v : r.federal.ordinaryTaxable.v;
      if (r.crossed) continue; // over at no withdrawal: Social Security and the yield alone
      expect(m).toBeLessThanOrEqual(60_000 + 1e-6);
      expect(r.missedKinks).toBe(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(60);
  });
});

describe("cost and the lines", () => {
  function cost(inp: HealthInput, ordinary: number, ss: number, filing: 'single' | 'joint', aged: number) {
    const fi = newFederalInput(filing);
    fi.aged = aged;
    fi.ordinary = lin(ordinary);
    fi.socialSecurity = ss;
    fi.calendarYear = inp.calendarYear;
    fi.priceLevel = inp.priceLevel;
    begin(false);
    const fo = federal(fi, law, newFederalResult());
    inp.magi = lin(fo.magiAca.v);
    const ho = health(inp, law, newHealthResult());
    return { cost: fo.total.v + ho.total.v, magi: fo.magiAca.v };
  }

  test('tax plus health never falls with income, except across a line where it may (100%, the Medicaid line, $580 a month)', () => {
    const rand = seededRandom(42);
    let checked = 0;
    for (let c = 0; c < 4_000; c++) {
      const joint = rand() < 0.5;
      const ages: [number, number] = [Math.floor(40 + rand() * 40), joint ? Math.floor(40 + rand() * 40) : -1];
      const state = STATES[Math.floor(rand() * STATES.length)];
      const year = rand() < 0.5 ? 2026 : 2027;
      const inp: HealthInput = {
        calendarYear: year, yearsFromToday: 0, priceLevel: 1, irmaaPriceRatio: 1, filing: joint ? 'joint' : 'single', ages,
        meetsRule: [rand() < 0.3, rand() < 0.3], dependents: rand() < 0.2 ? 1 : 0, state,
        coverage: { kind: 'aca', adult: 4_000 + rand() * 12_000, quotedAge: 50, child: 3_000 }, medicareExtra: 0,
        countMedicaid: rand() < 0.1, acaLaw: rand() < 0.2 ? 'enhanced' : '2026', growth: 0, incomeGrowth: 0, magi: lin(0),
        irmaaMagi: null,
      };
      const ss = rand() < 0.3 ? rand() * 40_000 : 0;
      const aged = (ages[0] >= 65 ? 1 : 0) + (ages[1] >= 65 ? 1 : 0);
      const o1 = rand() * 150_000;
      const o2 = o1 + rand() * 10_000;
      const a = cost(inp, o1, ss, inp.filing, aged);
      const b = cost(inp, o2, ss, inp.filing, aged);
      const size = (joint ? 2 : 1) + inp.dependents;
      const pc = povertyLine(law.creditPoverty, state, size);
      const pm = povertyLine(law.medicaidPoverty, state, size);
      const lines = [pc, 6_960, 1.38 * pm, 2.15 * pm, pm];
      if (lines.some((l) => a.magi <= l + 1e-6 && b.magi > l - 1e-6)) continue;
      expect(b.cost).toBeGreaterThanOrEqual(a.cost - 1e-9);
      checked++;
    }
    expect(checked).toBeGreaterThan(2_500);
  });

  test('the cliff is exactly at 400%: the credit at it, none a hundred-thousandth of a dollar over', () => {
    const rand = seededRandom(400);
    for (let c = 0; c < 200; c++) {
      const joint = rand() < 0.5;
      const state = STATES[Math.floor(rand() * STATES.length)];
      const dependents = rand() < 0.3 ? 2 : 0;
      const size = (joint ? 2 : 1) + dependents;
      const at = 4 * povertyLine(law.creditPoverty, state, size);
      const inp = (magi: number): HealthInput => ({
        calendarYear: 2026, yearsFromToday: 0, priceLevel: 1, irmaaPriceRatio: 1, filing: joint ? 'joint' : 'single',
        ages: [50, joint ? 48 : -1], meetsRule: [false, false], dependents, state,
        coverage: { kind: 'aca', adult: 30_000, quotedAge: 50, child: 5_000 }, medicareExtra: 0, countMedicaid: false,
        acaLaw: '2026', growth: 0, incomeGrowth: 0, magi: lin(magi), irmaaMagi: null,
      });
      begin(false);
      const on = health(inp(at), law, newHealthResult());
      expect(on.people[0].status).toBe('aca');
      expect(on.people[0].credit).toBeGreaterThan(0);
      begin(false);
      const over = health(inp(at + 1e-5), law, newHealthResult());
      expect(over.people[0].status).toBe('over-cliff');
      expect(over.people[0].credit).toBe(0);
      expect(benchmarkAt(law, 30_000, 50, 50)).toBe(30_000);
    }
  });
});

describe('checkYearInput', () => {
  test('refuses what the year cannot use, naming the field', () => {
    expect(() => checkYearInput(year({ spending: Number.NaN }))).toThrow('spending');
    const p = year();
    p.people[0].roth = 10;
    p.people[0].rothReachable = 20;
    expect(() => checkYearInput(p)).toThrow('people[0].roth');
    const w = year();
    w.people[0].window = [0, 0];
    expect(() => checkYearInput(w)).toThrow('people[0].window');
  });
});
