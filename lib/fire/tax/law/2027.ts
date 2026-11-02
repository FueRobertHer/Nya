// lib/fire/tax/law/2027.ts
//
// The 2027 law, as far as it is out on 2026-11-01. A plan uses it only once
// every part is here (lib/fire/tax/law/index.ts); until then, 2026's, with the
// caution "2026 tax law: 2027's isn't in Nya yet".
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import { AGE_CURVE, HEALTH_GROWTH, LAW_2026, MEDICAID_STATES, STATUTE, UNIFORM_DIVISORS } from './2026';
import type { PartialLaw } from './types';

export const LAW_2027: PartialLaw = {
  year: 2027,
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
  // SSA, contribution and benefit base for 2027 (announced October 14, 2026).
  wageBase: 192_300,
  uniform: { firstAge: 72, divisors: UNIFORM_DIVISORS },
  curve: AGE_CURVE,
  healthGrowth: HEALTH_GROWTH,
  sources: {
    brackets: { source: "2027's revenue procedure on inflation adjusted items", published: null, due: 'October or November 2026' },
    statute: LAW_2026.sources.statute,
    aca: { source: 'Rev. Proc. 2026-26, sec. 3.01', published: '2026-07-21', due: 'About July 2026' },
    creditPoverty: { source: 'HHS poverty guidelines for 2026, 91 FR 1797', published: '2026-01-15', due: 'January 2026' },
    medicaidPoverty: { source: 'HHS poverty guidelines for 2027', published: null, due: 'January 2027' },
    medicaidStates: LAW_2026.sources.medicaidStates,
    medicare: { source: 'CMS, 2027 Medicare Parts A and B Premiums and Deductibles', published: null, due: 'Mid-November 2026' },
    wageBase: { source: 'SSA, contribution and benefit base', published: '2026-10-14', due: 'October 2026' },
    uniform: LAW_2026.sources.uniform,
    curve: LAW_2026.sources.curve,
    healthGrowth: LAW_2026.sources.healthGrowth,
  },
};
