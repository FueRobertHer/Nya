// lib/fire/tax/law/2027.ts
//
// The 2027 law, as far as it is out on 2026-11-07. A plan uses it only once
// every part is here (lib/fire/tax/law/index.ts); until then, 2026's, with the
// caution "Uses 2026 tax law, the newest Nya has." (components/plan-drawdown.ts).
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import { AGE_CURVE, HEALTH_GROWTH, LAW_2026, MEDICAID_STATES, STATE_INCOME_TAX, STATUTE, UNIFORM_DIVISORS } from './2026';
import type { PartialLaw } from './types';

export const LAW_2027: PartialLaw = {
  year: 2027,
  // Rev. Proc. 2026-35 (November 5, 2026), for taxable years beginning in 2027
  // (sec. 4.01). Indexed.
  brackets: {
    // Sec. 3.01, Table 3 (unmarried individuals) and Table 1 (married filing
    // jointly and surviving spouses).
    ordinary: {
      single: [
        { upTo: 12_800, rate: 0.1 },
        { upTo: 52_025, rate: 0.12 },
        { upTo: 109_125, rate: 0.22 },
        { upTo: 208_325, rate: 0.24 },
        { upTo: 264_550, rate: 0.32 },
        { upTo: 661_375, rate: 0.35 },
        { upTo: Infinity, rate: 0.37 },
      ],
      joint: [
        { upTo: 25_600, rate: 0.1 },
        { upTo: 104_050, rate: 0.12 },
        { upTo: 218_250, rate: 0.22 },
        { upTo: 416_650, rate: 0.24 },
        { upTo: 529_100, rate: 0.32 },
        { upTo: 793_650, rate: 0.35 },
        { upTo: Infinity, rate: 0.37 },
      ],
    },
    // Sec. 3.15(1), under IRC 63(c)(2).
    standard: { single: 16_600, joint: 33_200 },
    // Sec. 3.15(3), under IRC 63(f): $1,700, or $2,100 for one unmarried and
    // not a surviving spouse.
    aged: { married: 1_700, unmarried: 2_100 },
    // Sec. 3.03, the maximum zero and 15 percent rate amounts under IRC
    // 1(j)(5)(B): "All Other Individuals" for single, married filing jointly
    // and surviving spouses for joint.
    gains: {
      single: { zeroTo: 51_050, fifteenTo: 563_200 },
      joint: { zeroTo: 102_100, fifteenTo: 633_600 },
    },
  },
  // Fixed by law (lib/fire/tax/law/2026.ts cites where): Rev. Proc. 2026-35
  // adjusts none of these figures.
  statute: STATUTE,
  // Rev. Proc. 2026-26 sec. 3.01 (July 21, 2026), for taxable years beginning
  // in 2027.
  aca: {
    bands: [
      { from: 0, to: 133, initial: 2.15, final: 2.15 },
      { from: 133, to: 150, initial: 3.23, final: 4.3 },
      { from: 150, to: 200, initial: 4.3, final: 6.78 },
      { from: 200, to: 250, initial: 6.78, final: 8.66 },
      { from: 250, to: 300, initial: 8.66, final: 10.22 },
      { from: 300, to: 400, initial: 10.22, final: 10.22 },
    ],
    cliff: 4,
  },
  // HHS poverty guidelines for 2026, 91 FR 1797 (January 15, 2026): the ones
  // out when 2027's open enrollment began.
  creditPoverty: LAW_2026.medicaidPoverty,
  medicaidStates: MEDICAID_STATES,
  stateIncomeTax: STATE_INCOME_TAX,
  // SSA, contribution and benefit base for 2027 (announced October 14, 2026).
  wageBase: 192_300,
  uniform: { firstAge: 72, divisors: UNIFORM_DIVISORS },
  curve: AGE_CURVE,
  healthGrowth: HEALTH_GROWTH,
  sources: {
    brackets: { source: 'Rev. Proc. 2026-35, sec. 3.01, 3.03 and 3.15', published: '2026-11-05', due: 'October or November 2026' },
    statute: LAW_2026.sources.statute,
    aca: { source: 'Rev. Proc. 2026-26, sec. 3.01', published: '2026-07-21', due: 'About July 2026' },
    creditPoverty: { source: 'HHS poverty guidelines for 2026, 91 FR 1797', published: '2026-01-15', due: 'January 2026' },
    medicaidPoverty: { source: 'HHS poverty guidelines for 2027', published: null, due: 'January 2027', opens: '2027-01-01' },
    medicaidStates: LAW_2026.sources.medicaidStates,
    stateIncomeTax: LAW_2026.sources.stateIncomeTax,
    medicare: { source: 'CMS, 2027 Medicare Parts A and B Premiums and Deductibles', published: null, due: 'Mid-November 2026', opens: '2026-11-01' },
    wageBase: { source: 'SSA, contribution and benefit base', published: '2026-10-14', due: 'October 2026' },
    uniform: LAW_2026.sources.uniform,
    curve: LAW_2026.sources.curve,
    healthGrowth: LAW_2026.sources.healthGrowth,
  },
};
