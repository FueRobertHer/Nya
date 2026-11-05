// lib/fire/tax/health.ts
//
// One year's health coverage cost for a household, per person, from one
// function, so every result counts health once and the same way: the ACA
// before 65, with its credit worked out as Form 8962 works it out, the
// Medicaid line and its work rule, and Medicare from 65.
//
//   - Before 65 on the ACA, each covered person is priced at the benchmark
//     (the second lowest cost silver plan) quoted today for one adult at one
//     age, rated by CMS's default age curve and grown by `growth` a year faster
//     than prices. The credit: the household's income as a percent of the
//     credit's poverty line, dropping any fraction (Form 8962 line 5), none
//     under 100% or, under 2026 law, over 400% ("401"); the applicable figure
//     for that whole percent, interpolated within its band and rounded half up
//     to four places, as the instructions' Table 2 prints it (the 2017 table's
//     165% is 4.785%, printed 0.0479); the household's contribution, figure
//     times income; the credit, the benchmark less that, never below zero.
//     Under 2026 law the schedule's percentages rise each year by premium
//     growth over income growth (IRC 36B(b)(3)(A)(ii)); the enhanced schedule
//     (`acaLaw: 'enhanced'`, for a plan that assumes the 2021 to 2025
//     credits return) is fixed by statute.
//   - The family size is everyone on the return, a spouse on Medicare
//     included (IRC 36B(d)(1)); the benchmark covers only those the credit
//     can (Treas. Reg. 1.36B-3(f)).
//   - The Medicaid line: at or under the state's line (on Medicaid's own
//     poverty line, this year's guidelines), a person is on Medicaid if the
//     rule is met: always before 2027; from 2027 by the household's MAGI of at
//     least the federal minimum wage times 80 hours a month (42 CFR
//     435.552(f)), or by that person's answer (work, service, school or an
//     exemption). Otherwise full price and no credit (SSA 1902(xx)(7)(B)).
//     Where there is no line, under 100% is full price. Children are on
//     Medicaid at or under 138% in every state (SSA 1902(l), 133% plus the 5%
//     disregard), with no work rule. `countMedicaid` counts full price anyway.
//   - From 65, Medicare: Part B's standard premium, the typed Part D or
//     supplement, and IRMAA on IRMAA's MAGI from two years before, against
//     tiers that are two years of inflation higher in today's dollars.
//
// Not modeled: out-of-pocket costs, cost-sharing reductions' value (only
// flagged, `lowerDeductibles`, on the credit at or under 250%), state
// programs and Basic Health Programs, children's Medicaid and CHIP lines,
// rating only the three oldest children under 21, a work rule tested month
// by month (a year stands in for even months), and plans other than the
// benchmark.
//
// The ACA's MAGI is a Lin (lib/fire/tax/piece.ts), so the year's solver gets
// the cost's slope and its kinks; inside a sloped band the contribution steps
// at each whole percent, and the solver scans those cells with cellFigure
// instead of evaluating every one.
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import type { AcaBand, AcaSchedule, Filing, PovertyGuidelines, StateCode, TaxLaw } from './law/types';
import { LINE_EPS, addScaled, atLeast, atMost, atOrUnder, lin, reaching, set, track, type Lin } from './piece';

/** How someone under 65 is covered: the ACA at a quoted benchmark (one adult's
 *  at `quotedAge`; `child`, one child's), another way at a typed yearly cost
 *  for the household, or not set. Today's dollars. */
export type Coverage =
  | { kind: 'aca'; adult: number; quotedAge: number; child: number | null }
  | { kind: 'other'; yearly: number }
  | null;

export type HealthStatus =
  | 'aca' // on the ACA with the credit
  | 'medicaid'
  | 'under-line' // full price: under the line without Medicaid, or counted anyway
  | 'over-cliff' // full price: over 400% under 2026 law
  | 'medicare'
  | 'other'
  | 'none';

export type HealthInput = {
  calendarYear: number;
  /** Years since today: quotes and Medicare's amounts grow by (1 + growth)^this. */
  yearsFromToday: number;
  /** Prices this year over the law year's: the work rule's income line shrinks by it. */
  priceLevel: number;
  /** Prices this year over two years before: IRMAA's tiers are that much higher against its MAGI. */
  irmaaPriceRatio: number;
  filing: Filing;
  /** The filers' ages this year (age reached during the year); the second -1 on a single return. */
  ages: [number, number];
  /** Each filer's answer: meets the work rule or an exemption by work, service, school or otherwise. */
  meetsRule: [boolean, boolean];
  /** Dependents in the tax household this year. */
  dependents: number;
  state: StateCode | null;
  coverage: Coverage;
  /** Each Medicare enrollee's typed Part D or supplement, a year, today's dollars. */
  medicareExtra: number;
  countMedicaid: boolean;
  acaLaw: '2026' | 'enhanced';
  /** Points a year health costs rise faster than prices. */
  growth: number;
  /** Points a year incomes rise faster than prices (the ACA's indexing). */
  incomeGrowth: number;
  /** The ACA's MAGI this year. */
  magi: Lin;
  /** IRMAA's MAGI from two years before, in that year's (today's) dollars; null when unknown. */
  irmaaMagi: number | null;
};

export type PersonHealth = {
  status: HealthStatus;
  /** The benchmark at full price, before any credit (0 on Medicaid or Medicare). */
  premium: number;
  /** This person's share of the household's credit. */
  credit: number;
  partB: number;
  /** IRMAA: Part B's and Part D's income-related amounts. */
  irmaa: number;
  /** The typed Part D or supplement. */
  extra: number;
  /** A typed cost before Medicare (coverage another way). */
  typed: number;
  /** IRMAA's tier, 0 for none. */
  irmaaTier: number;
};

export type HealthResult = {
  people: [PersonHealth, PersonHealth];
  /** All dependents together: their status, benchmark at full price and share of the credit. */
  dependents: { status: HealthStatus; premium: number; credit: number };
  /** The household's cost this year. */
  total: Lin;
  /** The ACA part of `total`: the smaller of the covered benchmark and the contribution. */
  acaNet: Lin;
  /** What an HSA can pay untaxed: Part B and IRMAA (not the typed extra, which may be a supplement). */
  hsaEligible: number;
  /** The ACA's MAGI as a percent of the credit's poverty line and of Medicaid's. */
  povertyPercent: number;
  medicaidPercent: number;
  /** The credit's poverty line for the family. */
  creditPoverty: number;
  /** The benchmark of everyone the credit covers. */
  benchmark: number;
  /** The applicable figure used, as a fraction (0 when no one has the credit). */
  figure: number;
  /** The whole percent Form 8962 enters on line 5 (401 over the cliff). */
  linePercent: number;
  overLimit: boolean;
  underLine: boolean;
  lowerDeductibles: boolean;
  irmaaUnknown: boolean;
  /** Inside a sloped band, paying a contribution under the benchmark, with MAGI
   *  rising: the solver may scan its cells (cellFigure) up to the federal room. */
  staircase: boolean;
};

function person(): PersonHealth {
  return { status: 'none', premium: 0, credit: 0, partB: 0, irmaa: 0, extra: 0, typed: 0, irmaaTier: 0 };
}

export function newHealthResult(): HealthResult {
  return {
    people: [person(), person()], dependents: { status: 'none', premium: 0, credit: 0 }, total: lin(), acaNet: lin(),
    hsaEligible: 0, povertyPercent: 0, medicaidPercent: 0, creditPoverty: 0, benchmark: 0, figure: 0,
    linePercent: 0, overLimit: false, underLine: false, lowerDeductibles: false, irmaaUnknown: false,
    staircase: false,
  };
}

/** The poverty line for a household of `size` in `state`. */
export function povertyLine(guidelines: PovertyGuidelines, state: StateCode | null, size: number): number {
  const table = state === 'AK' ? guidelines.AK : state === 'HI' ? guidelines.HI : guidelines.contiguous;
  return table.first + table.added * Math.max(0, size - 1);
}

/** What the ACA rule's limit and floor read of a year. */
export type AcaYear = {
  filing: Filing;
  people: readonly { age: number; meetsRule: boolean }[];
  dependents: number;
  state: StateCode | null;
  calendarYear: number;
  priceLevel: number;
  coverage: Coverage;
  countMedicaid: boolean;
};

/** Whether anyone is on the ACA this year, as health has it: coverage by the ACA,
 *  and an adult under 65 or a child it covers. */
export function onAcaThisYear(y: AcaYear): boolean {
  const c = y.coverage;
  if (c === null || c.kind !== 'aca') return false;
  const filers = y.filing === 'joint' ? 2 : 1;
  return y.people.slice(0, filers).some((p) => p.age < 65) || (c.child !== null && y.dependents > 0);
}

/** The ACA limit as a MAGI: the credit's upper line for the household. The
 *  enhanced law has no cliff there, but a rule named after it still stops there. */
export function acaLimit(y: AcaYear, law: TaxLaw): number {
  const filers = y.filing === 'joint' ? 2 : 1;
  return (law.aca.cliff ?? 4) * povertyLine(law.creditPoverty, y.state, filers + y.dependents);
}

/**
 * The MAGI under which someone on the ACA pays full price this year, or null where
 * nothing does: outside a state with a line, under the credit's floor; in one, under
 * the line for someone Medicaid won't take (who doesn't count on it, or doesn't meet
 * a state's own rule); and from the federal work rule, for someone who doesn't
 * otherwise meet it, under the income that meets it. Where Medicaid is free, none: a
 * floor would only push income into a paid plan.
 */
export function fullPriceUnder(y: AcaYear, law: TaxLaw): number | null {
  const c = y.coverage;
  if (c === null || c.kind !== 'aca') return null;
  const st = law.statute;
  const filers = y.filing === 'joint' ? 2 : 1;
  const adults = y.people.slice(0, filers).filter((p) => p.age < 65);
  if (adults.length === 0) return null;
  const size = filers + y.dependents;
  const creditFloor = st.credit.floor * povertyLine(law.creditPoverty, y.state, size);
  const line = y.state === null ? null : law.medicaidStates[y.state];
  if (line === null || (line.through !== null && y.calendarYear > line.through)) return creditFloor;
  const lineAt = line.line * povertyLine(law.medicaidPoverty, y.state, size);
  const unmet = adults.some((p) => !p.meetsRule);
  if (y.countMedicaid || (line.ownRule && unmet)) return Math.max(lineAt, creditFloor);
  if (line.ownRule || y.calendarYear < st.workRule.from || !unmet) return null;
  return (12 * st.workRule.minimumWage * st.workRule.hours) / y.priceLevel;
}

/** CMS's default curve at `age` (0 to 14 one band, 64 and older one band). */
function curveAt(curve: readonly number[], age: number): number {
  return curve[Math.min(Math.max(0, Math.floor(age)), curve.length - 1)];
}

/** A benchmark quoted at `quotedAge`, rated to `age` on CMS's default curve. */
export function benchmarkAt(law: TaxLaw, quote: number, quotedAge: number, age: number): number {
  return (quote * curveAt(law.curve, age)) / curveAt(law.curve, quotedAge);
}

/** a / b rounded half up, for integers a >= 0 and b > 0. */
function roundHalfUp(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

/** A band's endpoints in hundredths of a percent, indexed by `ratio` and
 *  rounded as a revenue procedure prints them. */
function hundredths(p: number, ratio: number): number {
  return Math.round(p * 100 * ratio);
}

/** The applicable percentage table a year uses. */
function scheduleOf(law: TaxLaw, inp: HealthInput): AcaSchedule {
  return inp.acaLaw === 'enhanced' ? law.statute.enhanced : law.aca;
}

/** How far the 2026 schedule's percentages have been indexed by `calendarYear`:
 *  premium growth over income growth for each year since the law's own (IRC
 *  36B(b)(3)(A)(ii)); the enhanced schedule is fixed by statute. */
function indexRatio(law: TaxLaw, inp: HealthInput): number {
  if (inp.acaLaw === 'enhanced') return 1;
  return ((1 + inp.growth) / (1 + inp.incomeGrowth)) ** Math.max(0, inp.calendarYear - law.year);
}

function bandOf(bands: readonly AcaBand[], pct: number): AcaBand {
  for (const b of bands) if (pct < b.to) return b;
  return bands[bands.length - 1];
}

/** The applicable figure, as a fraction, for whole percent `pct` (Form 8962
 *  line 7): the band's initial percentage plus its share of the way to the
 *  final one, rounded half up to four places, worked in integer hundredths of
 *  a percent so no tie is lost to floating error. */
export function cellFigure(law: TaxLaw, inp: HealthInput, pct: number): number {
  const ratio = indexRatio(law, inp);
  const b = bandOf(scheduleOf(law, inp).bands, pct);
  const lo = hundredths(b.initial, ratio);
  const hi = hundredths(b.final, ratio);
  const width = b.to === Infinity ? 1 : b.to - b.from;
  const step = b.to === Infinity ? 0 : roundHalfUp((hi - lo) * Math.max(0, pct - b.from), width);
  return (lo + step) / 10_000;
}

/** Whether a band's figure changes from one whole percent to the next. */
function sloped(law: TaxLaw, inp: HealthInput, pct: number): boolean {
  const b = bandOf(scheduleOf(law, inp).bands, pct);
  return b.initial !== b.final;
}

// Scratch, made once.
const contribution = lin(), net = lin(), fixed = lin();

/** The household's health cost this year into `out`. */
export function health(inp: HealthInput, law: TaxLaw, out: HealthResult): HealthResult {
  const st = law.statute;
  const filers = inp.filing === 'joint' ? 2 : 1;
  const size = filers + inp.dependents;
  const hf = (1 + inp.growth) ** inp.yearsFromToday;
  const magi = inp.magi;
  const schedule = scheduleOf(law, inp);

  const creditPov = povertyLine(law.creditPoverty, inp.state, size);
  const medicaidPov = povertyLine(law.medicaidPoverty, inp.state, size);
  out.creditPoverty = creditPov;
  out.povertyPercent = (100 * magi.v) / creditPov;
  out.medicaidPercent = (100 * magi.v) / medicaidPov;
  out.overLimit = false;
  out.underLine = false;
  out.lowerDeductibles = false;
  out.irmaaUnknown = false;
  out.staircase = false;
  out.hsaEligible = 0;
  out.dependents.premium = 0;
  out.dependents.credit = 0;

  // Where the household stands against the lines (each compared once, so each
  // ends the rooms once).
  const line = inp.state === null ? null : law.medicaidStates[inp.state];
  const lineHolds = line !== null && (line.through === null || inp.calendarYear <= line.through);
  const coverage = inp.coverage;
  const onAca = coverage !== null && coverage.kind === 'aca';
  const children = coverage !== null && coverage.kind === 'aca' && coverage.child !== null && inp.dependents > 0;
  const adultsUnder65 = inp.ages[0] < 65 || (filers === 2 && inp.ages[1] < 65);
  let underMedicaid = false;
  let childrenOnMedicaid = false;
  let incomeMeets = false;
  let atLeastFloor = true;
  let underCliff = true;
  if (onAca && (adultsUnder65 || children)) {
    if (adultsUnder65 && line !== null && lineHolds) underMedicaid = atOrUnder(magi, line.line * medicaidPov);
    if (underMedicaid && line !== null && !line.ownRule && inp.calendarYear >= st.workRule.from) {
      incomeMeets = atLeast(magi, (12 * st.workRule.minimumWage * st.workRule.hours) / inp.priceLevel);
    }
    if (children) childrenOnMedicaid = atOrUnder(magi, st.childMedicaid * medicaidPov);
    atLeastFloor = atLeast(magi, st.credit.floor * creditPov);
    underCliff = schedule.cliff === null || atOrUnder(magi, schedule.cliff * creditPov);
  }
  const creditEligible = atLeastFloor && underCliff;

  // Each filer.
  set(fixed, 0);
  let benchmark = 0;
  let typedDone = false;
  for (let i = 0; i < 2; i++) {
    const p = out.people[i];
    p.status = 'none';
    p.premium = p.credit = p.partB = p.irmaa = p.extra = p.typed = 0;
    p.irmaaTier = 0;
    if (i >= filers) continue;
    const age = inp.ages[i];
    if (age >= 65) {
      medicare(inp, law, p, hf);
      out.hsaEligible += p.partB + p.irmaa;
      if (inp.irmaaMagi === null) out.irmaaUnknown = true;
      fixed.v += p.partB + p.irmaa + p.extra;
      continue;
    }
    if (coverage === null) continue;
    if (coverage.kind === 'other') {
      p.status = 'other';
      if (!typedDone) {
        p.typed = coverage.yearly * hf;
        fixed.v += p.typed;
        typedDone = true;
      }
      continue;
    }
    const full = benchmarkAt(law, coverage.adult, coverage.quotedAge, age) * hf;
    if (underMedicaid && line !== null) {
      const meets = line.ownRule
        ? inp.meetsRule[i]
        : inp.calendarYear < st.workRule.from || incomeMeets || inp.meetsRule[i];
      if (meets && !inp.countMedicaid) {
        p.status = 'medicaid';
        continue;
      }
      p.status = 'under-line';
      p.premium = full;
      fixed.v += full;
      out.underLine = true;
      continue;
    }
    if (!atLeastFloor) {
      p.status = 'under-line';
      p.premium = full;
      fixed.v += full;
      out.underLine = true;
      continue;
    }
    if (!underCliff) {
      p.status = 'over-cliff';
      p.premium = full;
      fixed.v += full;
      out.overLimit = true;
      continue;
    }
    p.status = 'aca';
    p.premium = full;
    benchmark += full;
  }

  // Dependents: on Medicaid at or under the children's line, which every state
  // must cover (no work rule); above it on the household's credit where it has
  // one, else full price.
  let dependentBenchmark = 0;
  out.dependents.status = 'none';
  if (children && coverage !== null && coverage.kind === 'aca' && coverage.child !== null) {
    const full = inp.dependents * coverage.child * hf;
    if (childrenOnMedicaid && !inp.countMedicaid) {
      out.dependents.status = 'medicaid';
    } else if (!childrenOnMedicaid && creditEligible) {
      out.dependents.status = 'aca';
      out.dependents.premium = full;
      dependentBenchmark = full;
      benchmark += full;
    } else {
      out.dependents.status = childrenOnMedicaid || !atLeastFloor ? 'under-line' : 'over-cliff';
      out.dependents.premium = full;
      fixed.v += full;
      if (out.dependents.status === 'under-line') out.underLine = true;
      else out.overLimit = true;
    }
  }

  // The credit (Form 8962), for everyone it covers.
  out.benchmark = benchmark;
  out.figure = 0;
  out.linePercent = underCliff ? Math.floor((100 * (magi.v + LINE_EPS)) / creditPov) : 401;
  set(out.acaNet, 0);
  if (benchmark > 0) {
    // Line 5: the whole percent, the fraction dropped; just right of a cell's
    // lower edge on a falling MAGI, the cell below.
    let pct = Math.floor((100 * (magi.v + LINE_EPS)) / creditPov);
    const lowerEdge = (pct * creditPov) / 100;
    if (track.right && magi.s < 0 && Math.abs(magi.v - lowerEdge) <= LINE_EPS) pct -= 1;
    out.linePercent = pct;
    const figure = cellFigure(law, inp, pct);
    out.figure = figure;
    const b = bandOf(schedule.bands, pct);
    // The band's edges end both rooms; a cell's edge, inside a sloped band, only `room`.
    if (b.from > 0) reaching(magi, (b.from * creditPov) / 100);
    if (b.to !== Infinity) reaching(magi, (b.to * creditPov) / 100);
    const inside = sloped(law, inp, pct);
    if (inside) {
      if (magi.s > 0) reaching(magi, ((pct + 1) * creditPov) / 100, true);
      else if (magi.s < 0) reaching(magi, lowerEdge, true);
    }
    contribution.v = figure * magi.v;
    contribution.s = figure * magi.s;
    atMost(net, contribution, benchmark);
    set(out.acaNet, net.v, net.s);
    const credit = benchmark - net.v;
    for (let i = 0; i < filers; i++) {
      const p = out.people[i];
      if (p.status === 'aca') p.credit = (credit * p.premium) / benchmark;
    }
    if (dependentBenchmark > 0) out.dependents.credit = (credit * dependentBenchmark) / benchmark;
    out.lowerDeductibles = pct <= 250;
    out.staircase = inside && magi.s > 0 && contribution.v < benchmark - LINE_EPS;
  }

  addScaled(out.total, fixed, out.acaNet);
  return out;
}

/** One Medicare enrollee's Part B, IRMAA and typed extra this year. */
function medicare(inp: HealthInput, law: TaxLaw, p: PersonHealth, hf: number): void {
  const m = law.medicare;
  p.status = 'medicare';
  p.partB = 12 * m.partB * hf;
  p.extra = inp.medicareExtra * hf;
  p.irmaa = 0;
  p.irmaaTier = 0;
  if (inp.irmaaMagi === null) return;
  const tiers = m.irmaa[inp.filing];
  const magi = inp.irmaaMagi;
  for (let i = tiers.length - 1; i >= 0; i--) {
    const t = tiers[i];
    const threshold = t.over * inp.irmaaPriceRatio;
    if (t.atLeast ? magi >= threshold : magi > threshold) {
      p.irmaaTier = i + 1;
      p.irmaa = 12 * (t.partB - m.partB + t.partD) * hf;
      return;
    }
  }
}
