import { afterEach, describe, expect, test } from 'bun:test';
import { seededRandom } from '@/lib/fire/random';
import { LAW_2026 as law } from '@/lib/fire/tax/law/2026';
import { newYearResult, runYear, runYearFilling, shortcuts, startFilling, type PersonYear, type YearInput, type YearResult } from '@/lib/fire/tax/year';

// The year's speedups (lib/fire/tax/year.ts `shortcuts`) change how it gets to its
// answer, not the answer: 20,000 seeded households, each worked out with them on and
// the long way. A filling year may land anywhere in the fill's window, a dollar wide.
// And the bug the same households found, in a cell's edge on a falling MAGI.

const rand = seededRandom(77);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const money = (hi: number) => (rand() < 0.25 ? 0 : Math.round(rand() * hi * 100) / 100);
const STATES = ['NV', 'CA', 'TX', 'WI', 'GA', 'NY', 'FL', 'AK', 'DC', null] as const;

function person(age: number, converts: boolean): PersonYear {
  const taxable = money(800_000);
  const roth = money(500_000);
  const reachable = roth * rand();
  const window: PersonYear['window'] = [0, 0, 0, 0];
  let room = roth - reachable;
  for (let i = 0; i < 4; i++) {
    const w = rand() < 0.3 ? room * rand() * 0.5 : 0;
    window[i] = w;
    room -= w;
  }
  return {
    age,
    rmdAge: pick([73, 75]),
    taxable,
    basis: rand() < 0.1 ? taxable * (1 + rand()) : taxable * rand(),
    deferred: money(1_500_000),
    deferred457: rand() < 0.1 ? money(200_000) : 0,
    roth,
    rothReachable: reachable,
    window,
    hsa: money(100_000),
    socialSecurity: age >= 62 && rand() < 0.5 ? money(50_000) : 0,
    pension: rand() < 0.2 ? money(40_000) : 0,
    wages: rand() < 0.1 ? money(60_000) : 0,
    conversion: converts && rand() < 0.3 ? money(100_000) : 0,
    meetsRule: rand() < 0.3,
  };
}

function household(): YearInput {
  const age = 30 + Math.floor(rand() * 60);
  const y = Math.floor(rand() * 40);
  const converts = rand() < 0.2;
  const inflation = pick([0.03, 0.02, -0.01, 0.07, 0]);
  const c = rand();
  const coverage: YearInput['coverage'] = c < 0.6 ? { kind: 'aca', adult: 8_000 + rand() * 6_000, quotedAge: 50, child: rand() < 0.3 ? 4_000 : null } : c < 0.8 ? { kind: 'other', yearly: rand() * 20_000 } : null;
  const hasLine = rand();
  const on = rand() < 0.5 ? ('ordinary' as const) : ('magi' as const);
  const at = rand() < 0.5 ? pick([23_850, 96_950, 206_700, 48_475, 80_000, 84_600, 120_000]) : rand() * 200_000;
  return {
    calendarYear: 2026 + y,
    yearsFromToday: y,
    priceLevel: 1.03 ** y,
    irmaaPriceRatio: 1.03 ** 2,
    filing: rand() < 0.6 ? 'joint' : 'single',
    people: [person(age, converts), person(Math.max(20, age - 5 + Math.floor(rand() * 10)), converts)],
    dependents: rand() < 0.2 ? 1 + Math.floor(rand() * 3) : 0,
    state: pick(STATES),
    stateRate: rand() < 0.5 ? 0 : rand() * 0.1,
    spending: rand() < 0.05 ? 0 : money(150_000),
    oneOffs: rand() < 0.1 ? money(100_000) : 0,
    windfall: rand() < 0.05 ? money(300_000) : 0,
    afterTaxIncome: rand() < 0.1 ? money(30_000) : 0,
    taxableYield: pick([0, 0.01, 0.02, 0.03]),
    qualifiedShare: pick([0.75, 0.9, 1, 0]),
    taxExempt: 0,
    carryover: rand() < 0.15 ? money(40_000) : 0,
    irmaaMagi: rand() < 0.5 ? null : money(600_000),
    coverage,
    medicareExtra: rand() < 0.5 ? 0 : money(4_000),
    countMedicaid: rand() < 0.1,
    acaLaw: rand() < 0.1 ? 'enhanced' : '2026',
    healthGrowth: pick([0.021, 0, 0.015]),
    incomeGrowth: pick([0.011, 0, 0.01]),
    ceiling: hasLine < 0.5 ? null : { on, at },
    order: rand() < 0.2 ? 'roth-before-deferred' : 'standard',
    fill: hasLine < 0.5 ? (rand() < 0.2 ? { on: 'magi', at } : null) : rand() < 0.7 ? { on, at } : null,
    growth: -0.3 + rand() * 0.6,
    inflation,
  };
}

/** What a caller reads off a year, by name. */
function reading(out: YearResult): Record<string, number> {
  const said: Record<string, number> = {
    withdrawal: out.withdrawal,
    surplus: out.surplus,
    shortfall: out.shortfall,
    carryoverOut: out.carryoverOut,
    tax: out.federal.total.v,
    magiAca: out.federal.magiAca.v,
    magiIrmaa: out.federal.magiIrmaa.v,
    health: out.health.total.v,
  };
  for (const i of [0, 1]) {
    const p = out.people[i];
    said[`conversion${i}`] = p.conversion;
    for (const [k, v] of Object.entries(p.end)) if (typeof v === 'number') said[`end${i}.${k}`] = v;
    for (const [k, v] of Object.entries(p.drawn)) said[`drawn${i}.${k}`] = v;
  }
  return said;
}

/** The year the long way and the short, each from its own copy. */
function bothWays(inp: YearInput, work: (inp: YearInput, out: YearResult) => void) {
  const out = newYearResult();
  const take = (on: boolean) => {
    shortcuts.on = on;
    startFilling();
    work(structuredClone(inp), out);
    return { said: reading(out), short: out.short, crossed: out.crossed, missed: out.missedKinks };
  };
  return { long: take(false), short: take(true) };
}

const within = (long: Record<string, number>, short: Record<string, number>, tolerance: (x: number) => number) =>
  Object.keys(long).filter((k) => Math.abs(long[k] - short[k]) > tolerance(long[k]));

afterEach(() => {
  shortcuts.on = true;
  startFilling();
});

describe('the year’s shortcuts', () => {
  const HOUSEHOLDS = 20_000;
  const MILLIONTH = (x: number) => 1e-6 * Math.max(1, Math.abs(x));

  test(`${HOUSEHOLDS.toLocaleString('en-US')} households: the same year as the long way`, () => {
    const fills: YearInput[] = [];
    let shortYears = 0;
    for (let n = 0; n < HOUSEHOLDS; n++) {
      const inp = household();
      if (inp.fill && n % 4 === 0) fills.push(inp);
      const { long, short } = bothWays(inp, (i, out) => runYear(i, law, out));
      if (long.short) shortYears++;
      expect(within(long.said, short.said, MILLIONTH)).toEqual([]);
      expect([short.short, short.crossed, short.missed]).toEqual([long.short, long.crossed, long.missed]);
    }
    // The generator has to reach the answers that matter.
    expect(shortYears).toBeGreaterThan(HOUSEHOLDS / 200);

    expect(fills.length).toBeGreaterThan(HOUSEHOLDS / 20);
    for (const inp of fills) {
      const { long, short } = bothWays(inp, (i, out) => runYearFilling(i, law, out));
      expect(within(long.said, short.said, () => 1)).toEqual([]);
      expect(short.short).toBe(long.short);
    }
  }, 120_000);
});

describe('a falling MAGI at a cell’s lower edge', () => {
  // Drawing a loss brings MAGI down onto a sloped band's cell edge. The year then reads
  // the cell below, whose own edge is the next one down: on main the room ended at this
  // edge, so the walk carried this cell's slope across the next and paid $752 too much.
  const you = (): PersonYear => ({ age: 36, rmdAge: 75, taxable: 145_990.44, basis: 9_565.881088133343, deferred: 0, deferred457: 0, roth: 221_830.63, rothReachable: 216_760.11545530657, window: [0, 0, 0, 0], hsa: 38_479.52, socialSecurity: 0, pension: 0, wages: 0, conversion: 0, meetsRule: true });
  const partner = (): PersonYear => ({ age: 31, rmdAge: 73, taxable: 785_354.82, basis: 909_105.4028968287, deferred: 509_724, deferred457: 0, roth: 202_257.26, rothReachable: 72_161.48984764279, window: [15_334.376382033579, 27_151.679498416033, 0, 0], hsa: 12_112.75, socialSecurity: 0, pension: 5_205.72, wages: 0, conversion: 0, meetsRule: true });
  const year = (): YearInput => ({
    calendarYear: 2031,
    yearsFromToday: 5,
    priceLevel: 1.1592740742999998,
    irmaaPriceRatio: 1.0609,
    filing: 'joint',
    people: [you(), partner()],
    dependents: 0,
    state: 'AK',
    stateRate: 0,
    spending: 129_588.96,
    oneOffs: 0,
    windfall: 0,
    afterTaxIncome: 0,
    taxableYield: 0,
    qualifiedShare: 0.9,
    taxExempt: 0,
    carryover: 0,
    irmaaMagi: null,
    coverage: { kind: 'aca', adult: 10_681.910297833383, quotedAge: 50, child: null },
    medicareExtra: 0,
    countMedicaid: false,
    acaLaw: 'enhanced',
    healthGrowth: 0.021,
    incomeGrowth: 0,
    ceiling: { on: 'magi', at: 80_000 },
    order: 'standard',
    fill: { on: 'magi', at: 80_000 },
    growth: 0.03489389168098567,
    inflation: 0.03,
  });

  test('the year pays with nothing over, the long way and the short', () => {
    for (const on of [true, false]) {
      shortcuts.on = on;
      const out = runYear(year(), law, newYearResult());
      expect(out.short).toBe(false);
      expect(out.surplus).toBeLessThan(0.01);
      expect(out.withdrawal).toBeCloseTo(127_976.58, 2);
      expect(out.missedKinks).toBe(0);
    }
  });
});
