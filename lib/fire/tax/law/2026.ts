// lib/fire/tax/law/2026.ts
//
// The 2026 law: every figure the detailed model reads, each from its primary
// source, checked against it on 2026-11-01. A value changes only through a
// reviewed pull request whose golden tests pass. The Tax-Calculator
// cross-check (test/tax-calculator.test.ts) compares the parameters both hold.
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import type { MedicaidLine, StateCode, Statute, TaxLaw } from './types';

/** Fixed by statute, the same in every law year until Congress changes it. */
export const STATUTE: Statute = {
  // IRC 86(c)(1) and (2): base amounts $25,000 ($32,000 joint), adjusted base
  // amounts $34,000 ($44,000 joint), as Pub 915 (2025) Worksheet 1 lines 9
  // and 11 use them. Not indexed.
  socialSecurity: {
    base: { single: 25_000, joint: 32_000 },
    adjusted: { single: 34_000, joint: 44_000 },
  },
  // IRC 1411(a)(1) and (b): 3.8% of the lesser of net investment income and
  // MAGI over $200,000 ($250,000 joint). Not indexed.
  niit: { rate: 0.038, threshold: { single: 200_000, joint: 250_000 } },
  // IRC 151(d)(5)(C), added by P.L. 119-21 sec. 70103 (July 4, 2025): $6,000
  // for each filer 65 or older by the year's end, each reduced (not below
  // zero) by 6% of MAGI over $75,000 ($150,000 joint), for tax years
  // beginning before January 1, 2029. Not indexed.
  senior: { amount: 6_000, threshold: { single: 75_000, joint: 150_000 }, rate: 0.06, through: 2028 },
  // IRC 1(h)(1)(C) and (D).
  gainsRates: { fifteen: 0.15, twenty: 0.2 },
  // IRC 72(t)(1). It doesn't reach a 457(b) plan's money, which isn't a
  // qualified retirement plan under 4974(c).
  early: 0.1,
  // IRC 223(f)(4)(A), ending at 65 under 223(f)(4)(C).
  hsa: { rate: 0.2, endsAt: 65 },
  // IRC 1211(b)(1). Not indexed.
  capitalLoss: 3_000,
  // IRC 3101(a) and (b)(1).
  fica: { socialSecurity: 0.062, medicare: 0.0145 },
  // IRC 36B(c)(1)(A): household income at least 100% of the poverty line.
  credit: { floor: 1 },
  // SSA 1902(a)(10)(A)(i)(VII) and 1902(l)(1)(B) to (D), (l)(2)(C): Medicaid
  // for children under 19 to at least 133% of the poverty line in every
  // state, plus the 5% disregard (42 CFR 435.603(d)(4)). States' higher
  // Medicaid and CHIP lines for children aren't modeled.
  childMedicaid: 1.38,
  // IRC 36B(b)(3)(A)(iii) as in effect for 2021 to 2025 (ARPA sec. 9661, IRA
  // sec. 12001), the table the 2025 Form 8962 instructions' Table 2 prints:
  // no indexing, and no cliff (8.5% from 400% up).
  enhanced: {
    bands: [
      { from: 0, to: 133, initial: 0, final: 0 },
      { from: 133, to: 150, initial: 0, final: 0 },
      { from: 150, to: 200, initial: 0, final: 2 },
      { from: 200, to: 250, initial: 2, final: 4 },
      { from: 250, to: 300, initial: 4, final: 6 },
      { from: 300, to: 400, initial: 6, final: 8.5 },
      { from: 400, to: Infinity, initial: 8.5, final: 8.5 },
    ],
    cliff: null,
  },
  // SSA 1902(xx), added by P.L. 119-21 sec. 71119: from the first quarter
  // after December 31, 2026, for applicable individuals 19 to 64 (expansion
  // adults and waiver adults, 1902(xx)(9)(A)(i)). CMS's interim final rule
  // (CMS-2454-IFC, 91 FR 33348, June 3, 2026), 42 CFR 435.552(f): "An
  // applicable individual demonstrates community engagement for a month if
  // the individual has a monthly income that is not less than the applicable
  // Federal minimum wage requirement under 29 U.S.C. 206(a)(1)(C) multiplied
  // by 80 hours", and "(2) The agency must determine the monthly income based
  // on the individual's MAGI-based income, for their MAGI-based household";
  // the preamble (91 FR 33361 to 33362) counts unearned income and "the income
  // of every individual included in the individual's household". The minimum
  // wage, $7.25 (29 U.S.C. 206(a)(1)(C)), isn't indexed.
  workRule: { from: 2027, minimumWage: 7.25, hours: 80, ages: { from: 19, to: 64 } },
  // IRC 401(a)(9)(C)(v), from SECURE 2.0 (P.L. 117-328, div. T, sec. 107): 73
  // for those who reach 72 after 2022 and 73 before 2033, 75 for those who
  // reach 74 after 2032. Born in 1959 meets both; the proposed regulations
  // (July 19, 2024) give 73. Born before 1951 reached 72 by 2022.
  rmdAges: { before1951: 72, from1951: 73, from1960: 75 },
};

const EXPANSION: MedicaidLine = { line: 1.38, through: null, ownRule: false };

/** Medicaid.gov, "Medicaid, Children's Health Insurance Program, & Basic
 *  Health Program Eligibility Levels" (state decisions as of December 1,
 *  2023; no state has adopted or ended expansion since), adults' limit plus
 *  the 5% disregard: 133% + 5 = 138% for expansion adults; DC's 210% + 5 =
 *  215%; Wisconsin's 95% + 5 = 100% (waiver adults). Minnesota's and New
 *  York's 200% in that table is their Basic Health Program, not Medicaid, so
 *  their line is 138%. Georgia covers adults to 100% under its Pathways
 *  demonstration, with a work requirement of its own, through December 31,
 *  2026, the end of CMS's current approval. */
export const MEDICAID_STATES: Record<StateCode, MedicaidLine | null> = {
  AL: null, AK: EXPANSION, AZ: EXPANSION, AR: EXPANSION, CA: EXPANSION, CO: EXPANSION, CT: EXPANSION,
  DE: EXPANSION, DC: { line: 2.15, through: null, ownRule: false }, FL: null,
  GA: { line: 1, through: 2026, ownRule: true }, HI: EXPANSION, ID: EXPANSION, IL: EXPANSION, IN: EXPANSION,
  IA: EXPANSION, KS: null, KY: EXPANSION, LA: EXPANSION, ME: EXPANSION, MD: EXPANSION, MA: EXPANSION,
  MI: EXPANSION, MN: EXPANSION, MS: null, MO: EXPANSION, MT: EXPANSION, NE: EXPANSION, NV: EXPANSION,
  NH: EXPANSION, NJ: EXPANSION, NM: EXPANSION, NY: EXPANSION, NC: EXPANSION, ND: EXPANSION, OH: EXPANSION,
  OK: EXPANSION, OR: EXPANSION, PA: EXPANSION, RI: EXPANSION, SC: null, SD: EXPANSION, TN: null, TX: null,
  UT: EXPANSION, VT: EXPANSION, VA: EXPANSION, WA: EXPANSION, WV: EXPANSION,
  WI: { line: 1, through: null, ownRule: false }, WY: null,
};

/** CMS, "Guidance Regarding Age Curves and State Reporting" (December 16,
 *  2016), Appendix I: the federal default standard age curve for plan years
 *  from 2018, by age 0 to 64 (0 to 14 one band; 64 and older one band). */
export const AGE_CURVE: readonly number[] = [
  ...Array<number>(15).fill(0.765),
  0.833, 0.859, 0.885, 0.913, 0.941, 0.97, // 15 to 20
  1, 1, 1, 1, 1.004, 1.024, 1.048, 1.087, 1.119, 1.135, // 21 to 30
  1.159, 1.183, 1.198, 1.214, 1.222, 1.23, 1.238, 1.246, 1.262, 1.278, // 31 to 40
  1.302, 1.325, 1.357, 1.397, 1.444, 1.5, 1.563, 1.635, 1.706, 1.786, // 41 to 50
  1.865, 1.952, 2.04, 2.135, 2.23, 2.333, 2.437, 2.548, 2.603, 2.714, // 51 to 60
  2.81, 2.873, 2.952, 3, // 61 to 64
];

/** Treas. Reg. 1.401(a)(9)-9(c) (T.D. 9930, for distribution years from
 *  2022), as IRS Pub 590-B (2025) Appendix B Table III prints it: ages 72 to
 *  120, 120 and over. */
export const UNIFORM_DIVISORS: readonly number[] = [
  27.4, 26.5, 25.5, 24.6, 23.7, 22.9, 22, 21.1, 20.2, 19.4, // 72 to 81
  18.5, 17.7, 16.8, 16, 15.2, 14.4, 13.7, 12.9, 12.2, 11.5, // 82 to 91
  10.8, 10.1, 9.5, 8.9, 8.4, 7.8, 7.3, 6.8, 6.4, 6, // 92 to 101
  5.6, 5.2, 4.9, 4.6, 4.3, 4.1, 3.9, 3.7, 3.5, 3.4, // 102 to 111
  3.3, 3.1, 3, 2.9, 2.8, 2.7, 2.5, 2.3, 2, // 112 to 120
];

/** CMS National Health Expenditure Projections 2025-2034 (tables released June
 *  2026). Private health insurance spending per enrollee, excluding Medigap
 *  (Table 17; the closest to HHS's premium measure, which joins employer and
 *  individual market premiums): $9,659 in 2027 to $13,155 in 2034, 4.51% a
 *  year. CPI-U (Table 1): 338.5 to 399.6, 2.40% a year. GDP per capita (Table
 *  1; the IRS's income growth, Rev. Proc. 2014-37 sec. 4.02): $97,171 to
 *  $124,127, 3.56% a year. So health costs rise 2.06 points a year faster than
 *  prices and incomes 1.13 points, over 2027 to 2034, the years after the
 *  near-term rise the projections expect (2024 to 2034 gives 2.63 and 1.27).
 *  A projection, not law. */
export const HEALTH_GROWTH = { overPrices: 0.021, incomeOverPrices: 0.011 } as const;

export const LAW_2026: TaxLaw = {
  year: 2026,
  // Rev. Proc. 2025-32 (October 9, 2025): sec. 4.01 Tables 1 and 3, sec. 4.03,
  // sec. 4.14(1) and (3). Indexed.
  brackets: {
    ordinary: {
      single: [
        { upTo: 12_400, rate: 0.1 },
        { upTo: 50_400, rate: 0.12 },
        { upTo: 105_700, rate: 0.22 },
        { upTo: 201_775, rate: 0.24 },
        { upTo: 256_225, rate: 0.32 },
        { upTo: 640_600, rate: 0.35 },
        { upTo: Infinity, rate: 0.37 },
      ],
      joint: [
        { upTo: 24_800, rate: 0.1 },
        { upTo: 100_800, rate: 0.12 },
        { upTo: 211_400, rate: 0.22 },
        { upTo: 403_550, rate: 0.24 },
        { upTo: 512_450, rate: 0.32 },
        { upTo: 768_700, rate: 0.35 },
        { upTo: Infinity, rate: 0.37 },
      ],
    },
    standard: { single: 16_100, joint: 32_200 },
    aged: { married: 1_650, unmarried: 2_050 },
    gains: {
      single: { zeroTo: 49_450, fifteenTo: 545_500 },
      joint: { zeroTo: 98_900, fifteenTo: 613_700 },
    },
  },
  statute: STATUTE,
  // Rev. Proc. 2025-25 sec. 3.01 (July 18, 2025), for taxable years beginning
  // in 2026; the cliff is IRC 36B(c)(1)(A)'s 400%, back from 2026.
  aca: {
    bands: [
      { from: 0, to: 133, initial: 2.1, final: 2.1 },
      { from: 133, to: 150, initial: 3.14, final: 4.19 },
      { from: 150, to: 200, initial: 4.19, final: 6.6 },
      { from: 200, to: 250, initial: 6.6, final: 8.44 },
      { from: 250, to: 300, initial: 8.44, final: 9.96 },
      { from: 300, to: 400, initial: 9.96, final: 9.96 },
    ],
    cliff: 4,
  },
  // HHS poverty guidelines for 2025, 90 FR 5917 (January 17, 2025): the ones
  // out when 2026's open enrollment began. Indexed.
  creditPoverty: {
    contiguous: { first: 15_650, added: 5_500 },
    AK: { first: 19_550, added: 6_880 },
    HI: { first: 17_990, added: 6_330 },
  },
  // HHS poverty guidelines for 2026, 91 FR 1797 (January 15, 2026). Indexed.
  medicaidPoverty: {
    contiguous: { first: 15_960, added: 5_680 },
    AK: { first: 19_950, added: 7_100 },
    HI: { first: 18_360, added: 6_530 },
  },
  medicaidStates: MEDICAID_STATES,
  // CMS, "2026 Medicare Parts A & B Premiums and Deductibles" (November 14,
  // 2025): the standard Part B premium and the income-related tiers, total
  // monthly Part B premium and monthly Part D adjustment, as printed (each
  // tier above its threshold; the top at or above it).
  medicare: {
    partB: 202.9,
    irmaa: {
      single: [
        { over: 109_000, atLeast: false, partB: 284.1, partD: 14.5 },
        { over: 137_000, atLeast: false, partB: 405.8, partD: 37.5 },
        { over: 171_000, atLeast: false, partB: 527.5, partD: 60.4 },
        { over: 205_000, atLeast: false, partB: 649.2, partD: 83.3 },
        { over: 500_000, atLeast: true, partB: 689.9, partD: 91 },
      ],
      joint: [
        { over: 218_000, atLeast: false, partB: 284.1, partD: 14.5 },
        { over: 274_000, atLeast: false, partB: 405.8, partD: 37.5 },
        { over: 342_000, atLeast: false, partB: 527.5, partD: 60.4 },
        { over: 410_000, atLeast: false, partB: 649.2, partD: 83.3 },
        { over: 750_000, atLeast: true, partB: 689.9, partD: 91 },
      ],
    },
  },
  // SSA, contribution and benefit base for 2026 (announced October 24, 2025).
  wageBase: 184_500,
  uniform: { firstAge: 72, divisors: UNIFORM_DIVISORS },
  curve: AGE_CURVE,
  healthGrowth: HEALTH_GROWTH,
  sources: {
    brackets: { source: 'Rev. Proc. 2025-32, sec. 4.01, 4.03 and 4.14', published: '2025-10-09', due: 'October or November of the year before' },
    statute: {
      source: 'IRC 1(h), 63, 72(t), 86, 151(d)(5)(C), 223(f)(4), 1211(b), 1411, 3101, 36B and 401(a)(9); SSA 1902(xx) and 42 CFR 435.552(f); 29 U.S.C. 206',
      published: '2025-07-04',
      due: 'When Congress changes it',
    },
    aca: { source: 'Rev. Proc. 2025-25, sec. 3.01', published: '2025-07-18', due: 'About July of the year before' },
    creditPoverty: { source: 'HHS poverty guidelines for 2025, 90 FR 5917', published: '2025-01-17', due: 'January of the year before' },
    medicaidPoverty: { source: 'HHS poverty guidelines for 2026, 91 FR 1797', published: '2026-01-15', due: 'January' },
    medicaidStates: { source: 'Medicaid.gov eligibility levels (as of December 1, 2023); CMS approval of Georgia Pathways through 2026', published: '2023-12-01', due: 'When a state changes' },
    medicare: { source: 'CMS, 2026 Medicare Parts A and B Premiums and Deductibles', published: '2025-11-14', due: 'Mid-November of the year before' },
    wageBase: { source: 'SSA, contribution and benefit base', published: '2025-10-24', due: 'October of the year before' },
    uniform: { source: 'Treas. Reg. 1.401(a)(9)-9(c); Pub 590-B (2025) Table III', published: '2020-11-12', due: 'Rarely' },
    curve: { source: 'CMS, Guidance Regarding Age Curves and State Reporting, Appendix I', published: '2016-12-16', due: 'Rarely' },
    healthGrowth: { source: 'CMS National Health Expenditure Projections 2025-2034, Tables 1 and 17', published: '2026-06-17', due: 'About June' },
  },
};
