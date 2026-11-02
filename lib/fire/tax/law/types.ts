// lib/fire/tax/law/types.ts
//
// The shape every law year fills: the parts of US federal tax and health
// coverage law the detailed model reads, each part one table in code with
// its source beside it (lib/fire/tax/law/2026.ts and the years after).
//
// Dollar amounts are in the law year's dollars. A plan's years hold indexed
// amounts constant in today's dollars and shrink the ones the law doesn't
// index by the price level (Tax engine: Today's dollars and nominal law);
// each comment says which a value is. Percentages are fractions (0.22 is
// 22%), except the ACA's applicable percentages, which are kept as the
// revenue procedures print them, in percent (3.14 is 3.14%).
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

/** The filing statuses the model covers (head of household and married
 *  filing separately are said, not modeled). */
export type Filing = 'single' | 'joint';

/** The 50 states and DC. */
export type StateCode =
  | 'AL' | 'AK' | 'AZ' | 'AR' | 'CA' | 'CO' | 'CT' | 'DE' | 'DC' | 'FL' | 'GA' | 'HI' | 'ID' | 'IL' | 'IN' | 'IA' | 'KS'
  | 'KY' | 'LA' | 'ME' | 'MD' | 'MA' | 'MI' | 'MN' | 'MS' | 'MO' | 'MT' | 'NE' | 'NV' | 'NH' | 'NJ' | 'NM' | 'NY' | 'NC'
  | 'ND' | 'OH' | 'OK' | 'OR' | 'PA' | 'RI' | 'SC' | 'SD' | 'TN' | 'TX' | 'UT' | 'VT' | 'VA' | 'WA' | 'WV' | 'WI' | 'WY';

export const STATE_CODES: readonly StateCode[] = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

/** One ordinary bracket: income up to `upTo` (the last Infinity) taxed at `rate`. */
export type Bracket = { upTo: number; rate: number };

/** The parts a revenue procedure sets each autumn. Indexed. */
export type Brackets = {
  /** Ordinary brackets by filing status, ascending. */
  ordinary: Record<Filing, readonly Bracket[]>;
  /** The basic standard deduction. */
  standard: Record<Filing, number>;
  /** The additional standard deduction for each filer 65 or older: the married
   *  amount on a joint return, the unmarried one on a single return. */
  aged: { married: number; unmarried: number };
  /** The tops of the 0% and 15% bands for long-term gains and qualified
   *  dividends (the maximum zero and 15 percent rate amounts). */
  gains: Record<Filing, { zeroTo: number; fifteenTo: number }>;
};

/** Figures fixed by statute: none of them indexed. */
export type Statute = {
  /** Social Security's taxable share (IRC 86): the base and adjusted base amounts. */
  socialSecurity: { base: Record<Filing, number>; adjusted: Record<Filing, number> };
  /** The net investment income tax (IRC 1411). */
  niit: { rate: number; threshold: Record<Filing, number> };
  /** The senior deduction (IRC 151(d)(5)(C)): an amount for each filer 65 or
   *  older, each reduced by `rate` of the return's MAGI over the threshold,
   *  for tax years through `through`. */
  senior: { amount: number; threshold: Record<Filing, number>; rate: number; through: number };
  /** The 15% and 20% rates on long-term gains and qualified dividends (IRC 1(h)). */
  gainsRates: { fifteen: number; twenty: number };
  /** The additional tax on early distributions (IRC 72(t)). */
  early: number;
  /** The additional tax on an HSA's non-medical distributions (IRC 223(f)(4)),
   *  and the age at which it ends. */
  hsa: { rate: number; endsAt: number };
  /** The capital loss allowed against ordinary income in a year (IRC 1211(b)). */
  capitalLoss: number;
  /** The employee's share of FICA (IRC 3101): Social Security to the wage base,
   *  Medicare on all wages. */
  fica: { socialSecurity: number; medicare: number };
  /** The ACA credit's lower line, as a multiple of the poverty line
   *  (IRC 36B(c)(1)(A)). The upper one is the schedule's `cliff`. */
  credit: { floor: number };
  /** The line every state's Medicaid covers children under 19 to, as a
   *  multiple of Medicaid's poverty line, the 5% disregard included. */
  childMedicaid: number;
  /** The applicable percentage table if the enhanced credits return (D10):
   *  the 2021 to 2025 schedule, fixed by statute, never indexed, no cliff. */
  enhanced: AcaSchedule;
  /** The Medicaid community engagement rule (SSA 1902(xx)): from the first
   *  calendar year it applies, for adults of these ages, met in a month by
   *  household MAGI of at least the federal minimum wage times `hours`. */
  workRule: { from: number; minimumWage: number; hours: number; ages: { from: number; to: number } };
  /** RMD start ages by birth year (IRC 401(a)(9)(C)(v)). */
  rmdAges: { before1951: number; from1951: number; from1960: number };
};

/** One band of the applicable percentage table, in percent of the poverty line
 *  (`from` at least, `to` less than, except the last, "not more than"). */
export type AcaBand = { from: number; to: number; initial: number; final: number };

/** An applicable percentage table. `cliff` is the multiple of the poverty line
 *  above which there is no credit; null when there is none (the enhanced law). */
export type AcaSchedule = { bands: readonly AcaBand[]; cliff: number | null };

/** A poverty guideline: the amount for one person and for each person more. */
export type PovertyTable = { first: number; added: number };

/** Where a household's poverty guideline comes from. */
export type PovertyRegion = 'contiguous' | 'AK' | 'HI';

/** The HHS poverty guidelines for one year. Indexed. */
export type PovertyGuidelines = Record<PovertyRegion, PovertyTable>;

/** A state's Medicaid line for adults under 65, as a multiple of Medicaid's
 *  poverty line (the 5% disregard included), the last calendar year it holds
 *  (null: no scheduled end), and whether it carries a work rule of its own
 *  before the federal one (Georgia's Pathways). */
export type MedicaidLine = { line: number; through: number | null; ownRule: boolean };

/** One IRMAA tier: MAGI above `over` (at or above, for the top tier) pays this
 *  total monthly Part B premium and this monthly Part D adjustment. */
export type IrmaaTier = { over: number; atLeast: boolean; partB: number; partD: number };

/** Medicare's premiums. Part B's standard premium and the tiers are monthly.
 *  The thresholds are indexed; the amounts rise with health costs. */
export type Medicare = { partB: number; irmaa: Record<Filing, readonly IrmaaTier[]> };

/** The Uniform Lifetime Table: divisors from `firstAge`, one per year of age;
 *  the last applies at every age after it. */
export type Uniform = { firstAge: number; divisors: readonly number[] };

/** Projections, not law, kept beside the tables (D12): how many points a year
 *  health costs rise faster than prices, and incomes (GDP per capita) faster
 *  than prices, for the ACA's indexing. */
export type HealthGrowth = { overPrices: number; incomeOverPrices: number };

/** Where a part comes from: its source, when it was published (null: not yet,
 *  the year's table lacks it) and when it is due. Read by T2's Tax law card and
 *  the upkeep workflow. */
export type PartSource = { source: string; published: string | null; due: string };

/** One law year, every part present. */
export type TaxLaw = {
  year: number;
  brackets: Brackets;
  statute: Statute;
  /** The applicable percentage table for coverage in this year. */
  aca: AcaSchedule;
  /** The poverty guidelines the credit uses: the ones out when open enrollment
   *  began, so the year before's (Treas. Reg. 1.36B-1(h)). */
  creditPoverty: PovertyGuidelines;
  /** The poverty guidelines Medicaid uses: this year's. */
  medicaidPoverty: PovertyGuidelines;
  medicaidStates: Record<StateCode, MedicaidLine | null>;
  medicare: Medicare;
  /** The Social Security contribution and benefit base. Indexed. */
  wageBase: number;
  uniform: Uniform;
  /** CMS's default age curve, ages 0 to 64; the last applies from 64. */
  curve: readonly number[];
  healthGrowth: HealthGrowth;
  sources: Record<LawPart, PartSource>;
};

/** The parts of a law year, each one table with one source. */
export type LawPart = Exclude<keyof TaxLaw, 'year' | 'sources'>;

export const LAW_PARTS: readonly LawPart[] = [
  'brackets', 'statute', 'aca', 'creditPoverty', 'medicaidPoverty', 'medicaidStates',
  'medicare', 'wageBase', 'uniform', 'curve', 'healthGrowth',
];

/** A law year whose parts are not all out yet. */
export type PartialLaw = { year: number; sources: Record<LawPart, PartSource> } & Partial<Pick<TaxLaw, LawPart>>;
