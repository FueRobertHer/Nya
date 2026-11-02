import { describe, expect, test } from 'bun:test';
import { benchmarkAt, cellFigure, health, newHealthResult, povertyLine, type HealthInput } from '@/lib/fire/tax/health';
import { LAW_2026 } from '@/lib/fire/tax/law/2026';
import type { AcaSchedule, TaxLaw } from '@/lib/fire/tax/law/types';
import { begin, lin } from '@/lib/fire/tax/piece';

// Golden tests: health.ts against Form 8962's own printed figures, CMS's age
// curve and Medicare's premiums, and the work rule's cases.
//
// Sources:
//   - Form 8962 instructions, Table 2 (applicable figure): 2015's on Rev.
//     Proc. 2014-37's table, 2016's on Rev. Proc. 2014-62's, 2017's on Rev.
//     Proc. 2016-24's, and 2025's (the enhanced schedule). 2016's 225% (7.295%,
//     printed 0.0730) and 2017's 165% (4.785%, printed 0.0479) are ties that
//     show the IRS rounds half up.
//   - Form 8962 instructions (2025), line 5: "drop any numbers after the
//     decimal point"; more than 400% of the poverty line enters 401.
//   - Pub 974 (2025), Andrew's illustrated example: household income $85,800,
//     275% of the poverty line, annual contribution $4,290, monthly $358.
//   - CMS, Guidance Regarding Age Curves and State Reporting (December 16,
//     2016), Appendix I; CMS, 2026 Medicare Parts A & B Premiums and
//     Deductibles (November 14, 2025).
//   - 42 CFR 435.552(f): the work rule met by household MAGI of $580 a month.

function input(over: Partial<HealthInput> = {}): HealthInput {
  return {
    calendarYear: 2026, yearsFromToday: 0, priceLevel: 1, irmaaPriceRatio: 1, filing: 'single',
    ages: [45, -1], meetsRule: [false, false], dependents: 0, state: 'NV',
    coverage: { kind: 'aca', adult: 12_000, quotedAge: 45, child: null }, medicareExtra: 0,
    countMedicaid: false, acaLaw: '2026', growth: 0, incomeGrowth: 0, magi: lin(0), irmaaMagi: null,
    ...over,
  };
}

function run(over: Partial<HealthInput>, law: TaxLaw = LAW_2026) {
  begin(false);
  return health(input(over), law, newHealthResult());
}

/** A law with another year's applicable percentage table, for Table 2's rows. */
function withTable(bands: [number, number, number, number][], cliff: number | null = 4): TaxLaw {
  const aca: AcaSchedule = { bands: bands.map(([from, to, initial, final]) => ({ from, to, initial, final })), cliff };
  return { ...LAW_2026, aca };
}

/** A table as the revenue procedures print it: under 133%, then each band's
 *  initial percentage (the one before's final), flat from 300% to 400%. */
const regular = (low: number, a: number, b: number, c: number, d: number, e: number) =>
  withTable([[0, 133, low, low], [133, 150, a, b], [150, 200, b, c], [200, 250, c, d], [250, 300, d, e], [300, 400, e, e]]);

describe("Form 8962's applicable figure (Table 2)", () => {
  const figure = (law: TaxLaw, pct: number, acaLaw: '2026' | 'enhanced' = '2026') =>
    cellFigure(law, input({ acaLaw }), pct);

  test('2015 (Rev. Proc. 2014-37): interpolated within each band and rounded to four places', () => {
    const law = regular(2.01, 3.02, 4.02, 6.34, 8.1, 9.56);
    const rows: [number, number][] = [[132, 0.0201], [133, 0.0302], [134, 0.0308], [138, 0.0331], [176, 0.0523], [218, 0.0697], [261, 0.0842], [264, 0.0851]];
    for (const [pct, printed] of rows) expect(figure(law, pct)).toBe(printed);
  });

  test('2016 (Rev. Proc. 2014-62) and 2017 (Rev. Proc. 2016-24): the printed ties round half up', () => {
    const y2016 = regular(2.03, 3.05, 4.07, 6.41, 8.18, 9.66);
    for (const [pct, printed] of [[133, 0.0305], [152, 0.0416], [220, 0.0712], [225, 0.073], [226, 0.0733]] as const) {
      expect(figure(y2016, pct)).toBe(printed);
    }
    const y2017 = regular(2.04, 3.06, 4.08, 6.43, 8.21, 9.69);
    for (const [pct, printed] of [[153, 0.0422], [155, 0.0432], [165, 0.0479], [169, 0.0497], [225, 0.0732]] as const) {
      expect(figure(y2017, pct)).toBe(printed);
    }
  });

  test('2025 (the enhanced schedule): 0 to 150%, 8.5% from 400%', () => {
    for (const [pct, printed] of [[149, 0], [150, 0], [151, 0.0004], [200, 0.02], [299, 0.0596], [300, 0.06], [400, 0.085], [650, 0.085]] as const) {
      expect(figure(LAW_2026, pct, 'enhanced')).toBe(printed);
    }
  });

  test("2026 (Rev. Proc. 2025-25): the band's ends, and 175% by the half-up rule (5.395%)", () => {
    for (const [pct, f] of [[100, 0.021], [132, 0.021], [133, 0.0314], [150, 0.0419], [175, 0.054], [200, 0.066], [250, 0.0844], [300, 0.0996], [400, 0.0996]] as const) {
      expect(figure(LAW_2026, pct)).toBe(f);
    }
  });

  test('under 2026 law the percentages rise by premium growth over income growth, never under the enhanced law', () => {
    const law = LAW_2026;
    const later = cellFigure(law, input({ calendarYear: 2030, growth: 0.021, incomeGrowth: 0.011 }), 300);
    // 9.96% times (1.021 / 1.011)^4, rounded to hundredths of a percent.
    expect(later).toBe(Math.round(996 * (1.021 / 1.011) ** 4) / 10_000);
    expect(cellFigure(law, input({ calendarYear: 2030, growth: 0.021, incomeGrowth: 0.011, acaLaw: 'enhanced' }), 300)).toBe(0.06);
  });
});

describe('the credit, line by line', () => {
  test("Pub 974's Andrew: $85,800 for a family of 4 on 2024's guidelines is 275%, a contribution of $4,290", () => {
    // 2025 coverage used HHS's 2024 guidelines, $15,060 plus $5,380 a person.
    const law: TaxLaw = { ...LAW_2026, creditPoverty: { ...LAW_2026.creditPoverty, contiguous: { first: 15_060, added: 5_380 } } };
    const h = run({ acaLaw: 'enhanced', dependents: 3, magi: lin(85_800), coverage: { kind: 'aca', adult: 9_000, quotedAge: 45, child: 3_000 } }, law);
    expect(h.creditPoverty).toBe(31_200);
    expect(h.linePercent).toBe(275);
    expect(h.figure).toBe(0.05);
    expect(Math.round(h.figure * 85_800)).toBe(4_290); // line 8a
    expect(Math.round(4_290 / 12)).toBe(358); // line 8b
  });

  test('single at 150%: $23,475, figure 0.0419, contribution $983.60, the rest of a $6,000 benchmark as credit', () => {
    const h = run({ magi: lin(1.5 * 15_650), coverage: { kind: 'aca', adult: 6_000, quotedAge: 45, child: null } });
    expect(h.linePercent).toBe(150);
    expect(h.figure).toBe(0.0419);
    expect(h.acaNet.v).toBeCloseTo(23_475 * 0.0419, 6);
    expect(h.people[0].credit).toBeCloseTo(6_000 - 983.6025, 6);
    expect(h.people[0].status).toBe('aca');
  });

  test('a couple at 250%: 0.0844 of $52,875; a Medicare spouse stays in the family of 2 but out of the benchmark', () => {
    const couple = run({ filing: 'joint', ages: [60, 58], magi: lin(2.5 * 21_150) });
    expect(couple.linePercent).toBe(250);
    expect(couple.acaNet.v).toBeCloseTo(52_875 * 0.0844, 6);
    const mixed = run({ filing: 'joint', ages: [66, 60], magi: lin(40_000) });
    expect(mixed.creditPoverty).toBe(21_150);
    expect(mixed.linePercent).toBe(189);
    // 4.19% + 39/50 of 2.41%, 6.0698%, rounded: 0.0607.
    expect(mixed.figure).toBe(0.0607);
    expect(mixed.benchmark).toBeCloseTo(benchmarkAt(LAW_2026, 12_000, 45, 60), 6);
    expect(mixed.people[0].status).toBe('medicare');
  });

  test('the cliff: the credit at exactly 400% ($62,600), none above it ("401")', () => {
    const at = run({ magi: lin(62_600), coverage: { kind: 'aca', adult: 9_000, quotedAge: 45, child: null } });
    expect(at.linePercent).toBe(400);
    expect(at.people[0].credit).toBeCloseTo(9_000 - 62_600 * 0.0996, 6);
    const over = run({ magi: lin(62_600.01), coverage: { kind: 'aca', adult: 9_000, quotedAge: 45, child: null } });
    expect(over.people[0].status).toBe('over-cliff');
    expect(over.linePercent).toBe(401);
    expect(over.total.v).toBeCloseTo(9_000, 6);
    expect(over.overLimit).toBe(true);
  });

  test('under 100% where there is no Medicaid line: full price', () => {
    const h = run({ state: 'TX', magi: lin(15_000) });
    expect(h.people[0].status).toBe('under-line');
    expect(h.total.v).toBeCloseTo(12_000, 6);
    expect(h.underLine).toBe(true);
  });

  test('a contribution over the benchmark leaves no credit', () => {
    const h = run({ magi: lin(60_000), coverage: { kind: 'aca', adult: 3_000, quotedAge: 45, child: null } });
    expect(h.people[0].credit).toBe(0);
    expect(h.total.v).toBeCloseTo(3_000, 6);
  });

  test('lower deductibles under 250%', () => {
    expect(run({ magi: lin(2.5 * 15_650) }).lowerDeductibles).toBe(true);
    expect(run({ magi: lin(2.51 * 15_650) }).lowerDeductibles).toBe(false);
  });

  test('Alaska and Hawaii have their own poverty lines', () => {
    expect(povertyLine(LAW_2026.creditPoverty, 'AK', 2)).toBe(19_550 + 6_880);
    expect(povertyLine(LAW_2026.creditPoverty, 'HI', 1)).toBe(17_990);
    expect(povertyLine(LAW_2026.medicaidPoverty, 'NV', 3)).toBe(15_960 + 2 * 5_680);
  });
});

describe("CMS's default age curve", () => {
  test('its rows (Appendix I), flat from 0 to 14 and from 64', () => {
    const c = LAW_2026.curve;
    expect(c).toHaveLength(65);
    expect(c[0]).toBe(0.765);
    expect(c[14]).toBe(0.765);
    expect(c[15]).toBe(0.833);
    expect(c[21]).toBe(1);
    expect(c[30]).toBe(1.135);
    expect(c[40]).toBe(1.278);
    expect(c[50]).toBe(1.786);
    expect(c[60]).toBe(2.714);
    expect(c[63]).toBe(2.952);
    expect(c[64]).toBe(3);
    for (let a = 1; a < c.length; a++) expect(c[a]).toBeGreaterThanOrEqual(c[a - 1]);
  });

  test('a quote at 50 rated to 40, 60 and 64 and over', () => {
    expect(benchmarkAt(LAW_2026, 10_000, 50, 40)).toBeCloseTo((10_000 * 1.278) / 1.786, 6);
    expect(benchmarkAt(LAW_2026, 10_000, 50, 60)).toBeCloseTo((10_000 * 2.714) / 1.786, 6);
    expect(benchmarkAt(LAW_2026, 10_000, 50, 64)).toBeCloseTo((10_000 * 3) / 1.786, 6);
    expect(benchmarkAt(LAW_2026, 10_000, 50, 70)).toBeCloseTo((10_000 * 3) / 1.786, 6);
  });
});

describe('the Medicaid line and the work rule', () => {
  const nv = (year: number, magi: number, over: Partial<HealthInput> = {}) =>
    run({ calendarYear: year, filing: 'joint', ages: [55, 55], magi: lin(magi), ...over });

  test('2026: Medicaid at 120% in an expansion state, no rule yet', () => {
    const h = run({ magi: lin(1.2 * 15_960) });
    expect(h.people[0].status).toBe('medicaid');
    expect(h.total.v).toBe(0);
  });

  test('2027: a couple with $7,000 of MAGI meets the rule by income ($583 a month), both on Medicaid', () => {
    const h = nv(2027, 7_000);
    expect(h.people.map((p) => p.status)).toEqual(['medicaid', 'medicaid']);
  });

  test('2027: at $6,000 with both answers no, full price and no credit; with one yes, that one on Medicaid', () => {
    const none = nv(2027, 6_000);
    expect(none.people.map((p) => p.status)).toEqual(['under-line', 'under-line']);
    expect(none.total.v).toBeCloseTo(2 * 12_000 * (benchmarkAt(LAW_2026, 1, 45, 55)), 6);
    const one = nv(2027, 6_000, { meetsRule: [false, true] });
    expect(one.people.map((p) => p.status)).toEqual(['under-line', 'medicaid']);
  });

  test("the rule's $580 isn't indexed: at twice the price level $3,480 a year meets it", () => {
    expect(nv(2027, 3_500, { priceLevel: 2 }).people[0].status).toBe('medicaid');
    expect(nv(2027, 3_400, { priceLevel: 2 }).people[0].status).toBe('under-line');
  });

  test('the states: Wisconsin at 100%, Georgia through 2026 by its own rule, Texas none, DC to 215%', () => {
    const at95 = 0.95 * 15_960;
    expect(run({ state: 'WI', magi: lin(at95) }).people[0].status).toBe('medicaid');
    expect(run({ state: 'GA', magi: lin(at95), meetsRule: [true, false] }).people[0].status).toBe('medicaid');
    expect(run({ state: 'GA', magi: lin(at95) }).people[0].status).toBe('under-line');
    expect(run({ state: 'GA', calendarYear: 2027, magi: lin(at95), meetsRule: [true, false] }).people[0].status).toBe('under-line');
    expect(run({ state: 'TX', magi: lin(at95) }).people[0].status).toBe('under-line');
    expect(run({ state: 'DC', magi: lin(2 * 15_960) }).people[0].status).toBe('medicaid');
  });

  test('countMedicaid counts full price anyway', () => {
    expect(run({ magi: lin(1.2 * 15_960), countMedicaid: true }).people[0].status).toBe('under-line');
  });
});

describe('Medicare from 65', () => {
  const single = (magi: number | null, over: Partial<HealthInput> = {}) =>
    run({ ages: [66, -1], irmaaMagi: magi, ...over }).people[0];

  test("Part B's standard premium is $202.90 a month, $2,434.80 a year; unknown MAGI gives no IRMAA and says so", () => {
    expect(single(null).partB).toBeCloseTo(2_434.8, 6);
    expect(run({ ages: [66, -1], irmaaMagi: null }).irmaaUnknown).toBe(true);
  });

  test('each tier at and $1 over its edge, the top at or above $500,000 ($750,000 joint)', () => {
    expect(single(109_000).irmaaTier).toBe(0);
    expect(single(109_001).irmaaTier).toBe(1);
    expect(single(109_001).irmaa).toBeCloseTo(12 * (284.1 - 202.9 + 14.5), 6);
    expect(single(499_999).irmaaTier).toBe(4);
    expect(single(500_000).irmaaTier).toBe(5);
    expect(single(500_000).irmaa).toBeCloseTo(12 * (689.9 - 202.9 + 91), 6);
    const joint = (magi: number) => run({ filing: 'joint', ages: [66, 67], irmaaMagi: magi }).people[1];
    expect(joint(218_000).irmaaTier).toBe(0);
    expect(joint(218_001).irmaaTier).toBe(1);
    expect(joint(749_999).irmaaTier).toBe(4);
    expect(joint(750_000).irmaaTier).toBe(5);
  });

  test("two years of inflation raise the tiers against the MAGI from two years before", () => {
    expect(single(115_000, { irmaaPriceRatio: 1.03 ** 2 }).irmaaTier).toBe(0);
    expect(single(116_000, { irmaaPriceRatio: 1.03 ** 2 }).irmaaTier).toBe(1);
  });

  test('premiums rise with health costs; the HSA may pay Part B and IRMAA, not the typed extra', () => {
    const h = run({ ages: [66, -1], irmaaMagi: 120_000, medicareExtra: 1_000, yearsFromToday: 10, growth: 0.02 });
    const grow = 1.02 ** 10;
    expect(h.people[0].partB).toBeCloseTo(2_434.8 * grow, 6);
    expect(h.people[0].extra).toBeCloseTo(1_000 * grow, 6);
    expect(h.hsaEligible).toBeCloseTo(h.people[0].partB + h.people[0].irmaa, 6);
  });
});

describe('dependents', () => {
  // Every state covers children under 19 on Medicaid to 133% of the poverty
  // line plus the 5% disregard (SSA 1902(l)), with no work rule; above it a
  // child is priced on the household's credit, or at full price without one.
  const kids = (over: Partial<HealthInput>) =>
    run({ coverage: { kind: 'aca', adult: 9_000, quotedAge: 40, child: 3_600 }, dependents: 1, ...over });

  test('a child at or under 138% is on Medicaid, with the adult on Medicaid or the credit', () => {
    const nv = kids({ ages: [40, -1], magi: lin(25_000) });
    expect(nv.people[0].status).toBe('medicaid');
    expect(nv.dependents.status).toBe('medicaid');
    expect(nv.total.v).toBe(0);
    const tx = kids({ state: 'TX', ages: [40, -1], magi: lin(25_000) });
    expect(tx.people[0].status).toBe('aca');
    expect(tx.dependents.status).toBe('medicaid');
    expect(tx.benchmark).toBeCloseTo(9_000, 6);
  });

  test('counting Medicaid at full price counts the child at full price too', () => {
    const h = kids({ ages: [40, -1], magi: lin(25_000), countMedicaid: true });
    expect(h.people[0].status).toBe('under-line');
    expect(h.dependents.status).toBe('under-line');
    expect(h.total.v).toBeCloseTo(9_000 + 3_600, 6);
  });

  test('with every filer on Medicare, a covered child still meets the lines: Medicaid low, full price over the cliff', () => {
    const low = kids({ ages: [65, -1], magi: lin(10_000) });
    expect(low.dependents.status).toBe('medicaid');
    expect(low.total.v).toBeCloseTo(low.people[0].partB, 6);
    const high = kids({ ages: [65, -1], magi: lin(90_000) });
    expect(high.dependents.status).toBe('over-cliff');
    expect(high.overLimit).toBe(true);
    expect(high.total.v).toBeCloseTo(high.people[0].partB + 3_600, 6);
    const between = kids({ ages: [65, -1], magi: lin(35_000) }); // 165%: a contribution of $1,720 under the $3,600 benchmark
    expect(between.dependents.status).toBe('aca');
    expect(between.dependents.credit).toBeGreaterThan(0);
  });

  test("line 5's percent is the truncated one under 100%, and 401 only over the cliff", () => {
    expect(run({ state: 'TX', magi: lin(12_520) }).linePercent).toBe(80);
    expect(run({ magi: lin(62_601) }).linePercent).toBe(401);
  });
});
