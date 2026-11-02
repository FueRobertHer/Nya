// lib/fire/tax/year.ts
//
// One plan year after you stop, in the detailed model (Tax engine: The year):
//
//   1. RMDs per owner, from last year's closing tax-deferred and 457(b)
//      money, paid out whatever the need; then a fixed conversion, if any.
//   2. Fixed income: Social Security, pensions, wages, the taxable yield
//      (paid out), income given after tax, a windfall.
//   3. The ceiling, if the rule has one (T4 maps each rule to it).
//   4. Withdrawals in the standard order, each step one category across both
//      owners, the older owner's first:
//        a. an HSA of an owner 65 or older, untaxed, up to the household's
//           Part B premiums and IRMAA;
//        b. taxable money, each dollar realizing that owner's average gain;
//        c. tax-deferred money without the penalty (from 60, and any 457(b));
//        d. an HSA of an owner 65 or older, taxed like tax-deferred money;
//        e. reachable Roth money (contributions and conversions five tax
//           years old; all of it from 60);
//        f. younger conversions, which owe only the 10% before 60;
//        g. tax-deferred money with the 10%;
//        h. Roth earnings, taxed and with the 10%;
//        i. an HSA of an owner under 65, taxed and with the 20%.
//      With a ceiling, a source whose next dollar raises the ceiling's
//      measure stops there, the sources that don't follow, and only then the
//      rest, over it: the year says it crossed.
//   5 and 6. Tax and health (lib/fire/tax/federal.ts, lib/fire/tax/health.ts).
//   7. The least withdrawal that pays the year: see the solver below.
//   8. The year's end: growth (taxable at growth less its yield), and basis,
//      reachable Roth, the conversion window and the loss carryover divided by
//      the year's inflation, since all are nominal; the window shifts, its
//      oldest entry joining reachable Roth (a conversion in tax year Y is
//      reachable from Y + 5).
//
// Ages are the ages reached during the calendar year, for everything: from 60
// (59 1/2: the year you turn 59 counts as before it), 65 (Medicare, the HSA)
// and the RMD age. Amounts are today's dollars.
//
// THE SOLVER. A year's cost is not monotone in what it withdraws: it jumps up
// at the 400% cliff and falls across 100% and the Medicaid line, so a loop
// from no withdrawal can settle somewhere that pays but isn't the cheapest.
// The year's surplus f(x) (cash in, less spending, tax and health) is piecewise
// affine in the withdrawal x, and lib/fire/tax/piece.ts gives each evaluation
// its value, slope and room. The walk starts at x = 0 and at each point:
//   1. if f pays there ("at x", f >= -PAY_EPS), that is the answer;
//   2. if f just right of x pays, the paying set is open at x (it has no least
//      point): the answer is x plus a cent, flagged `open`;
//   3. if the piece's root lies inside its room, it is the answer once a full
//      evaluation there pays; a root that doesn't pay means a kink the room
//      missed, recorded (the tests assert it never happens), and the walk goes
//      on from there;
//   4. otherwise it moves to the room's end.
// Inside a sloped ACA band the credit's contribution steps at each whole
// percent; there the walk scans the cells arithmetically (health's
// cellFigure) up to the federal room instead of evaluating each. The walk is
// capped at MAX_PIECES pieces, cells included. When every source is spent and
// f still doesn't pay, the year is short by -f.
//
// Allocation-free: runYear writes into a YearResult made once by
// newYearResult(), as runPaths refills one YearState (lib/fire/simulate.ts).
// Inputs are checked once per plan by checkYearInput; runYear throws only if
// its own result isn't finite.
//
// Imports nothing that touches storage: the Plan tab runs this in the browser.

import { federal, newFederalInput, newFederalResult, type FederalResult } from './federal';
import { cellFigure, health, newHealthResult, type Coverage, type HealthInput, type HealthResult } from './health';
import type { Filing, StateCode, TaxLaw } from './law/types';
import { LINE_EPS, begin, lin, reaching, track, type Lin } from './piece';
import { rmd } from './rmd';

/** Dollars within which the year counts as paid. */
export const PAY_EPS = 1e-6;
/** The most pieces (cells included) a year's walk may take. */
export const MAX_PIECES = 4096;
/** How many tax years before this one the conversion window holds. */
export const WINDOW = 4;

/** One filer this year. Balances are at the year's start (last year's close). */
export type PersonYear = {
  /** The age reached during this calendar year. */
  age: number;
  /** The age RMDs start (lib/fire/tax/rmd.ts rmdAge). */
  rmdAge: number;
  taxable: number;
  /** The taxable money's cost basis (average cost). */
  basis: number;
  /** Tax-deferred money but 457(b): IRAs, 401(k)s, 403(b)s. */
  deferred: number;
  deferred457: number;
  /** Roth value, every account. */
  roth: number;
  /** Roth contributions and conversions at least five tax years old. */
  rothReachable: number;
  /** Conversions of tax years Y-4 to Y-1, oldest first (WINDOW long). */
  window: number[];
  hsa: number;
  socialSecurity: number;
  pension: number;
  wages: number;
  /** A fixed conversion this year (0 under None; T4 picks it). */
  conversion: number;
  /** Meets the Medicaid work rule or an exemption by work, service, school or otherwise. */
  meetsRule: boolean;
};

/** A rule's ceiling this year: on ordinary taxable income (a bracket's top),
 *  or on the ACA's MAGI. */
export type Ceiling = { on: 'ordinary' | 'magi'; at: number };

export type YearInput = {
  calendarYear: number;
  yearsFromToday: number;
  /** Prices this year over the law year's. */
  priceLevel: number;
  /** Prices this year over two years before (IRMAA's lookback). */
  irmaaPriceRatio: number;
  filing: Filing;
  /** The filers; the second is read only on a joint return. */
  people: [PersonYear, PersonYear];
  dependents: number;
  state: StateCode | null;
  stateRate: number;
  /** Living spending this year. */
  spending: number;
  /** Costs this year on top of spending. */
  oneOffs: number;
  /** Cash that comes in once: in this year's surplus, outside MAGI. */
  windfall: number;
  /** Income given after tax: cash, outside MAGI. */
  afterTaxIncome: number;
  /** The taxable accounts' yield, a share of their value, paid out. */
  taxableYield: number;
  /** The share of the yield that is qualified dividends; the rest is interest and ordinary dividends. */
  qualifiedShare: number;
  /** Tax-exempt interest this year. */
  taxExempt: number;
  /** The capital loss carried in. */
  carryover: number;
  /** IRMAA's MAGI from two years before, in that year's (today's) dollars; null when unknown. */
  irmaaMagi: number | null;
  coverage: Coverage;
  medicareExtra: number;
  countMedicaid: boolean;
  acaLaw: '2026' | 'enhanced';
  healthGrowth: number;
  incomeGrowth: number;
  ceiling: Ceiling | null;
  /** The year's return after inflation. */
  growth: number;
  inflation: number;
};

export type Drawn = {
  hsaPremiums: number;
  taxable: number;
  /** The gain the taxable sales realized (below 0 for a loss). */
  gain: number;
  deferred: number;
  deferred457: number;
  hsaTaxed: number;
  roth: number;
  young: number;
  penalized: number;
  earnings: number;
  hsaEarly: number;
};

export type PersonResult = {
  rmd: number;
  conversion: number;
  drawn: Drawn;
  /** Balances at the year's close, after growth. */
  end: {
    taxable: number;
    basis: number;
    deferred: number;
    deferred457: number;
    roth: number;
    rothReachable: number;
    /** Next year's window: tax years Y-3 to Y, oldest first. */
    window: number[];
    hsa: number;
  };
};

export type YearResult = {
  /** The withdrawal the solver chose (every source, the HSA's premiums included). */
  withdrawal: number;
  /** Cash left over (RMDs over need, a windfall), reinvested in taxable at full basis. */
  surplus: number;
  /** What the year couldn't pay with every source spent. */
  shortfall: number;
  short: boolean;
  /** The paying set was open at the answer: it is a cent past the boundary. */
  open: boolean;
  /** The year crossed the ceiling. */
  crossed: boolean;
  /** Kinks the room missed (0 in a correct build). */
  missedKinks: number;
  /** Pieces the walk took, cells included. */
  pieces: number;
  /** Full evaluations of federal and health the year took. */
  evaluations: number;
  federal: FederalResult;
  health: HealthResult;
  people: [PersonResult, PersonResult];
  /** The capital loss carried to next year, after inflation. */
  carryoverOut: number;
};

function drawn(): Drawn {
  return {
    hsaPremiums: 0, taxable: 0, gain: 0, deferred: 0, deferred457: 0, hsaTaxed: 0, roth: 0, young: 0,
    penalized: 0, earnings: 0, hsaEarly: 0,
  };
}

function personResult(): PersonResult {
  return {
    rmd: 0, conversion: 0, drawn: drawn(),
    end: { taxable: 0, basis: 0, deferred: 0, deferred457: 0, roth: 0, rothReachable: 0, window: [0, 0, 0, 0], hsa: 0 },
  };
}

export function newYearResult(): YearResult {
  return {
    withdrawal: 0, surplus: 0, shortfall: 0, short: false, open: false, crossed: false, missedKinks: 0,
    pieces: 0, evaluations: 0, federal: newFederalResult(), health: newHealthResult(), people: [personResult(), personResult()],
    carryoverOut: 0,
  };
}

/** A person with nothing, for building inputs. */
export function newPersonYear(age = 50): PersonYear {
  return {
    age, rmdAge: 75, taxable: 0, basis: 0, deferred: 0, deferred457: 0, roth: 0, rothReachable: 0,
    window: [0, 0, 0, 0], hsa: 0, socialSecurity: 0, pension: 0, wages: 0, conversion: 0, meetsRule: false,
  };
}

// The sources' kinds, in the order's categories.
const HSA_PREMIUMS = 0, TAXABLE = 1, DEFERRED = 2, PLAN_457 = 3, HSA_TAXED = 4, ROTH = 5, YOUNG = 6;
const PENALIZED = 7, EARNINGS = 8, HSA_EARLY = 9;
const CATEGORY = [0, 1, 2, 2, 3, 4, 5, 6, 7, 8];

// The year's sources, made once: at most 2 owners x 10 kinds.
const MAX_SOURCES = 20;
const kindOf = new Int32Array(MAX_SOURCES);
const ownerOf = new Int32Array(MAX_SOURCES);
const capOf = new Float64Array(MAX_SOURCES);
const drawnOf = new Float64Array(MAX_SOURCES);
const ordOf = new Float64Array(MAX_SOURCES); // ordinary income per dollar
const gainOf = new Float64Array(MAX_SOURCES); // realized gain per dollar
const earlyOf = new Float64Array(MAX_SOURCES); // under the 10% per dollar
const hsaEarlyOf = new Float64Array(MAX_SOURCES); // under the 20% per dollar
const stoppedOf = new Uint8Array(MAX_SOURCES);
let sourceCount = 0;

// The year being solved.
const fed = newFederalInput();
const hin: HealthInput = {
  calendarYear: 0, yearsFromToday: 0, priceLevel: 1, irmaaPriceRatio: 1, filing: 'single',
  ages: [0, -1], meetsRule: [false, false], dependents: 0, state: null, coverage: null, medicareExtra: 0,
  countMedicaid: false, acaLaw: '2026', growth: 0, incomeGrowth: 0, magi: lin(), irmaaMagi: null,
};
const f = lin();
let cashFixed = 0; // cash in before withdrawals
let needFixed = 0; // spending and one-offs
let ordFixed = 0, invFixed = 0, qualFixed = 0;
let active = -1; // the source being drawn
let delta = 0; // how much of it, in the current piece
let ceilingUnder = false; // a ceiling holds and the walk hasn't crossed it
let answeredAt = false; // the walk's last evaluation was "at" its answer
let scanEnd = 0; // the cells' scan: the value at its end, from the left

/** Evaluates the year with `delta` drawn from the active source on top of
 *  what is drawn, "just right of" that point when `right`, into out.federal,
 *  out.health and `f`. */
function evaluate(inp: YearInput, law: TaxLaw, out: YearResult, right: boolean): void {
  out.evaluations++;
  begin(right);
  let ord = ordFixed, ordS = 0, gain = 0, gainS = 0, early = 0, earlyS = 0, hsaE = 0, hsaES = 0, x = 0;
  for (let j = 0; j < sourceCount; j++) {
    const d = drawnOf[j];
    x += d;
    ord += d * ordOf[j];
    gain += d * gainOf[j];
    early += d * earlyOf[j];
    hsaE += d * hsaEarlyOf[j];
  }
  if (active >= 0) {
    x += delta;
    ord += delta * ordOf[active];
    gain += delta * gainOf[active];
    early += delta * earlyOf[active];
    hsaE += delta * hsaEarlyOf[active];
    ordS = ordOf[active];
    gainS = gainOf[active];
    earlyS = earlyOf[active];
    hsaES = hsaEarlyOf[active];
  }
  fed.ordinary.v = ord;
  fed.ordinary.s = ordS;
  fed.gains.v = gain;
  fed.gains.s = gainS;
  fed.early.v = early;
  fed.early.s = earlyS;
  fed.hsaEarly.v = hsaE;
  fed.hsaEarly.s = hsaES;
  const fo = federal(fed, law, out.federal);
  hin.magi.v = fo.magiAca.v;
  hin.magi.s = fo.magiAca.s;
  const ho = health(hin, law, out.health);
  if (ceilingUnder && inp.ceiling !== null) reaching(measure(inp.ceiling, fo), inp.ceiling.at);
  f.v = cashFixed + x - needFixed - fo.total.v - ho.total.v;
  f.s = (active >= 0 ? 1 : 0) - fo.total.s - ho.total.s;
}

function measure(c: Ceiling, fo: FederalResult): Lin {
  return c.on === 'magi' ? fo.magiAca : fo.ordinaryTaxable;
}

function remaining(j: number): number {
  return capOf[j] - drawnOf[j];
}

/** The first source in order with money left that may be drawn now: under a
 *  ceiling, one whose next dollar raises the measure stops once the measure is
 *  at it, and waits until every source that doesn't raise it is spent. */
function pick(inp: YearInput, law: TaxLaw, out: YearResult): number {
  for (;;) {
    for (let j = 0; j < sourceCount; j++) {
      if (remaining(j) <= LINE_EPS || stoppedOf[j]) continue;
      if (ceilingUnder && inp.ceiling !== null) {
        active = j;
        delta = 0;
        evaluate(inp, law, out, true);
        const m = measure(inp.ceiling, out.federal);
        if (m.s > 0 && m.v >= inp.ceiling.at - LINE_EPS) {
          stoppedOf[j] = 1;
          continue;
        }
      }
      return j;
    }
    if (!ceilingUnder) return -1;
    // Nothing that stays under is left: the rest, in order, over the ceiling.
    ceilingUnder = false;
    out.crossed = true;
    stoppedOf.fill(0);
  }
}

function addSource(kind: number, owner: number, cap: number, ord: number, gain: number, early: number, hsaEarly: number): void {
  if (!(cap > LINE_EPS)) return;
  const j = sourceCount++;
  kindOf[j] = kind;
  ownerOf[j] = owner;
  capOf[j] = cap;
  drawnOf[j] = 0;
  ordOf[j] = ord;
  gainOf[j] = gain;
  earlyOf[j] = early;
  hsaEarlyOf[j] = hsaEarly;
  stoppedOf[j] = 0;
}

function windowSum(p: PersonYear, conversion: number): number {
  let s = conversion;
  for (let i = 0; i < WINDOW; i++) s += p.window[i];
  return s;
}

/** Works out one year into `out` (see the header). */
export function runYear(inp: YearInput, law: TaxLaw, out: YearResult): YearResult {
  prepare(inp, law, out);
  walk(inp, law, out);
  return finish(inp, law, out);
}

/** For checking the solver: the year's surplus had it withdrawn `x` along the
 *  order with no ceiling ("at x"), with out.federal and out.health filled. */
export function surplusAt(inp: YearInput, law: TaxLaw, out: YearResult, x: number): number {
  prepare(inp, law, out);
  fillTo(x);
  evaluate(inp, law, out, false);
  const v = f.v;
  active = -1;
  delta = 0;
  return v;
}

/** For checking the solver: the piece just right of `x` along the order with
 *  no ceiling: its value, slope and room (to the next kink, cells included). */
export function pieceAt(inp: YearInput, law: TaxLaw, out: YearResult, x: number): { v: number; s: number; room: number } {
  prepare(inp, law, out);
  fillTo(x);
  evaluate(inp, law, out, true);
  const room = active >= 0 ? Math.min(track.room, remaining(active) - delta) : track.room;
  const piece = { v: f.v, s: f.s, room };
  active = -1;
  delta = 0;
  return piece;
}

/** For checking the solver: everything the order could draw this year. */
export function capacity(inp: YearInput, law: TaxLaw, out: YearResult): number {
  prepare(inp, law, out);
  let total = 0;
  for (let j = 0; j < sourceCount; j++) total += capOf[j];
  return total;
}

/** Draws `x` along the order, the source it ends in left active. */
function fillTo(x: number): void {
  let left = x;
  active = -1;
  delta = 0;
  drawnOf.fill(0);
  for (let j = 0; j < sourceCount; j++) {
    if (left < capOf[j]) {
      active = j;
      delta = Math.max(0, left);
      return;
    }
    drawnOf[j] = capOf[j];
    left -= capOf[j];
  }
}

/** Steps 1 to 4: RMDs and conversions, what is fixed, and the sources. */
function prepare(inp: YearInput, law: TaxLaw, out: YearResult): void {
  const joint = inp.filing === 'joint';
  const filers = joint ? 2 : 1;
  // The older owner first; "you" first at the same age.
  const first = joint && inp.people[1].age > inp.people[0].age ? 1 : 0;

  // Step 1: RMDs, then a fixed conversion, from tax-deferred money then 457(b).
  let rmdTotal = 0, conversions = 0, yieldCash = 0;
  for (let i = 0; i < 2; i++) {
    const r = out.people[i];
    r.rmd = 0;
    r.conversion = 0;
    const d = r.drawn;
    d.hsaPremiums = d.taxable = d.gain = d.deferred = d.deferred457 = d.hsaTaxed = 0;
    d.roth = d.young = d.penalized = d.earnings = d.hsaEarly = 0;
    if (i >= filers) continue;
    const p = inp.people[i];
    r.rmd = rmd(p.deferred + p.deferred457, p.age, p.rmdAge, law.uniform);
    r.conversion = Math.min(p.conversion, p.deferred + p.deferred457 - r.rmd);
    rmdTotal += r.rmd;
    conversions += r.conversion;
    yieldCash += p.taxable * inp.taxableYield;
  }

  // Step 2: what is fixed in the year.
  let ss = 0, pensions = 0, aged = 0;
  for (let i = 0; i < filers; i++) {
    const p = inp.people[i];
    ss += p.socialSecurity;
    pensions += p.pension;
    if (p.age >= 65) aged++;
  }
  const qualified = yieldCash * inp.qualifiedShare;
  const interest = yieldCash - qualified;
  ordFixed = pensions + rmdTotal + conversions + interest;
  invFixed = interest;
  qualFixed = qualified;
  const wages0 = inp.people[0].wages;
  const wages1 = joint ? inp.people[1].wages : 0;
  cashFixed = ss + pensions + wages0 + wages1 + yieldCash + rmdTotal + inp.afterTaxIncome + inp.windfall;
  needFixed = inp.spending + inp.oneOffs;

  fed.filing = inp.filing;
  fed.calendarYear = inp.calendarYear;
  fed.priceLevel = inp.priceLevel;
  fed.aged = aged;
  fed.wages[0].v = wages0;
  fed.wages[0].s = 0;
  fed.wages[1].v = wages1;
  fed.wages[1].s = 0;
  fed.investmentOrdinary.v = invFixed;
  fed.investmentOrdinary.s = 0;
  fed.qualified.v = qualFixed;
  fed.qualified.s = 0;
  fed.exempt.v = inp.taxExempt;
  fed.exempt.s = 0;
  fed.socialSecurity = ss;
  fed.carryover = inp.carryover;
  fed.stateRate = inp.stateRate;

  hin.calendarYear = inp.calendarYear;
  hin.yearsFromToday = inp.yearsFromToday;
  hin.priceLevel = inp.priceLevel;
  hin.irmaaPriceRatio = inp.irmaaPriceRatio;
  hin.filing = inp.filing;
  hin.ages[0] = inp.people[0].age;
  hin.ages[1] = joint ? inp.people[1].age : -1;
  hin.meetsRule[0] = inp.people[0].meetsRule;
  hin.meetsRule[1] = joint && inp.people[1].meetsRule;
  hin.dependents = inp.dependents;
  hin.state = inp.state;
  hin.coverage = inp.coverage;
  hin.medicareExtra = inp.medicareExtra;
  hin.countMedicaid = inp.countMedicaid;
  hin.acaLaw = inp.acaLaw;
  hin.growth = inp.healthGrowth;
  hin.incomeGrowth = inp.incomeGrowth;
  hin.irmaaMagi = inp.irmaaMagi;

  // What an HSA may pay untaxed doesn't depend on the withdrawal.
  out.evaluations = 0;
  sourceCount = 0;
  active = -1;
  delta = 0;
  ceilingUnder = false;
  let premiumsLeft = 0;
  if ((inp.people[0].age >= 65 && inp.people[0].hsa > 0) || (joint && inp.people[1].age >= 65 && inp.people[1].hsa > 0)) {
    evaluate(inp, law, out, false);
    premiumsLeft = out.health.hsaEligible;
  }

  // Step 4: the sources, category by category, the older owner first.
  for (let c = 0; c <= 8; c++) {
    for (let n = 0; n < filers; n++) {
      const i = n === 0 ? first : 1 - first;
      const p = inp.people[i];
      const r = out.people[i];
      const after60 = p.age >= 60;
      const from65 = p.age >= 65;
      const fromDeferred = Math.min(p.deferred, r.rmd + r.conversion);
      const deferredLeft = p.deferred - fromDeferred;
      const plan457Left = p.deferred457 - (r.rmd + r.conversion - fromDeferred);
      const roth = p.roth + r.conversion;
      const reachable = Math.min(p.rothReachable, roth);
      const young = Math.min(windowSum(p, r.conversion), roth - reachable);
      const premiums = from65 ? Math.min(p.hsa, premiumsLeft) : 0;
      switch (c) {
        case 0:
          if (premiums > 0) {
            addSource(HSA_PREMIUMS, i, premiums, 0, 0, 0, 0);
            premiumsLeft -= premiums;
          }
          break;
        case 1:
          addSource(TAXABLE, i, p.taxable, 0, p.taxable > 0 ? 1 - p.basis / p.taxable : 0, 0, 0);
          break;
        case 2:
          if (after60) addSource(DEFERRED, i, deferredLeft, 1, 0, 0, 0);
          addSource(PLAN_457, i, plan457Left, 1, 0, 0, 0);
          break;
        case 3:
          if (from65) addSource(HSA_TAXED, i, p.hsa - hsaPremiumCap(i), 1, 0, 0, 0);
          break;
        case 4:
          addSource(ROTH, i, after60 ? roth : reachable, 0, 0, 0, 0);
          break;
        case 5:
          if (!after60) addSource(YOUNG, i, young, 0, 0, 1, 0);
          break;
        case 6:
          if (!after60) addSource(PENALIZED, i, deferredLeft, 1, 0, 1, 0);
          break;
        case 7:
          if (!after60) addSource(EARNINGS, i, roth - reachable - young, 1, 0, 1, 0);
          break;
        case 8:
          if (!from65) addSource(HSA_EARLY, i, p.hsa, 1, 0, 0, 1);
          break;
      }
    }
  }

}

/** The answer's figures and step 8, the year's end. */
function finish(inp: YearInput, law: TaxLaw, out: YearResult): YearResult {
  const filers = inp.filing === 'joint' ? 2 : 1;
  // The answer's own evaluation fills out.federal and out.health.
  if (!answeredAt) evaluate(inp, law, out, false);
  if (!Number.isFinite(f.v)) throw new Error("The year's result isn't finite");
  let withdrawal = 0;
  for (let j = 0; j < sourceCount; j++) withdrawal += drawnOf[j];
  out.withdrawal = withdrawal;
  if (inp.ceiling !== null && measure(inp.ceiling, out.federal).v > inp.ceiling.at + LINE_EPS) out.crossed = true;
  out.surplus = out.short ? 0 : Math.max(0, f.v);
  out.carryoverOut = out.federal.carryoverOut / (1 + inp.inflation);

  // Step 8: what was drawn, and the year's end.
  for (let j = 0; j < sourceCount; j++) {
    const d = out.people[ownerOf[j]].drawn;
    const amount = drawnOf[j];
    switch (kindOf[j]) {
      case HSA_PREMIUMS: d.hsaPremiums += amount; break;
      case TAXABLE: d.taxable += amount; d.gain += amount * gainOf[j]; break;
      case DEFERRED: d.deferred += amount; break;
      case PLAN_457: d.deferred457 += amount; break;
      case HSA_TAXED: d.hsaTaxed += amount; break;
      case ROTH: d.roth += amount; break;
      case YOUNG: d.young += amount; break;
      case PENALIZED: d.penalized += amount; break;
      case EARNINGS: d.earnings += amount; break;
      case HSA_EARLY: d.hsaEarly += amount; break;
    }
  }
  const g = inp.growth;
  const infl = 1 + inp.inflation;
  for (let i = 0; i < 2; i++) {
    const r = out.people[i];
    const e = r.end;
    if (i >= filers) {
      e.taxable = e.basis = e.deferred = e.deferred457 = e.roth = e.rothReachable = e.hsa = 0;
      for (let w = 0; w < WINDOW; w++) e.window[w] = 0;
      continue;
    }
    const p = inp.people[i];
    const d = r.drawn;
    const share = p.taxable > 0 ? p.basis / p.taxable : 0;
    let taxable = p.taxable - d.taxable;
    let basis = p.basis - d.taxable * share;
    if (i === 0 && out.surplus > 0) {
      taxable += out.surplus;
      basis += out.surplus;
    }
    const fromDeferred = Math.min(p.deferred, r.rmd + r.conversion);
    const deferred = p.deferred - fromDeferred - d.deferred - d.penalized;
    const plan457 = p.deferred457 - (r.rmd + r.conversion - fromDeferred) - d.deferred457;
    // Roth by its ordering rules: reachable money first, then the window
    // oldest first (this year's conversion last), then earnings.
    const roth = p.roth + r.conversion - d.roth - d.young - d.earnings;
    let reachable = Math.min(p.rothReachable, p.roth + r.conversion);
    let take = d.roth + d.young;
    const fromReachable = Math.min(reachable, take);
    reachable -= fromReachable;
    take -= fromReachable;
    // The window, Y-4 to Y, oldest first; Y-4's conversion is reachable from
    // Y+1, and the window moves on a year.
    let held = 0;
    for (let w = 0; w <= WINDOW; w++) {
      const v = w < WINDOW ? p.window[w] : r.conversion;
      const t = Math.min(v, take);
      take -= t;
      if (w === 0) held = v - t;
      else e.window[w - 1] = (v - t) / infl;
    }
    e.taxable = Math.max(0, taxable) * (1 + g - inp.taxableYield);
    e.basis = Math.max(0, basis) / infl;
    e.deferred = Math.max(0, deferred) * (1 + g);
    e.deferred457 = Math.max(0, plan457) * (1 + g);
    e.roth = Math.max(0, roth) * (1 + g);
    e.rothReachable = (reachable + held) / infl;
    e.hsa = Math.max(0, p.hsa - d.hsaPremiums - d.hsaTaxed - d.hsaEarly) * (1 + g);
  }
  return out;
}

/** The cap the HSA's premium source took for owner i. */
function hsaPremiumCap(i: number): number {
  for (let j = 0; j < sourceCount; j++) if (kindOf[j] === HSA_PREMIUMS && ownerOf[j] === i) return capOf[j];
  return 0;
}

/** Adds the active source's draw in this piece to what is drawn. */
function commit(): void {
  if (active >= 0) drawnOf[active] += delta;
  delta = 0;
}

/** The solver (see the header): from x = 0 to the least withdrawal that pays.
 *  Each piece takes one evaluation just right of its start. "At" a point
 *  matters only where that can differ: at x = 0, where the right-hand limit
 *  pays (exactly there, or open), at a root, and at a piece's end that is its
 *  own (the cliff), which step 3 checks; any other end belongs to the next
 *  piece, whose right-hand limit is its value. Leaves `answeredAt` true when
 *  the last evaluation was "at" the answer. */
function walk(inp: YearInput, law: TaxLaw, out: YearResult): void {
  out.open = out.crossed = out.short = false;
  out.missedKinks = 0;
  out.pieces = 0;
  out.shortfall = 0;
  ceilingUnder = inp.ceiling !== null;
  active = -1;
  delta = 0;
  answeredAt = true;
  let needAt = true;
  for (;;) {
    if (++out.pieces > MAX_PIECES) throw new Error(`The year's walk took more than ${MAX_PIECES} pieces`);
    let fresh = false;
    if (active < 0 || ceilingUnder) {
      commit();
      active = pick(inp, law, out);
      fresh = ceilingUnder && active >= 0;
      delta = 0;
      if (active < 0) {
        evaluate(inp, law, out, false);
        if (f.v < -PAY_EPS) {
          out.short = true;
          out.shortfall = -f.v;
        }
        return;
      }
    }
    // 1. Pays here? (Only where "at" can differ from just right of here.)
    if (needAt) {
      evaluate(inp, law, out, false);
      if (f.v >= -PAY_EPS) break;
      needAt = false;
      fresh = false;
    }
    // 2. Pays just right of here: exactly here, or open at this point.
    if (!fresh) evaluate(inp, law, out, true);
    const start = delta;
    const left = remaining(active) - start;
    const room = Math.min(track.room, left);
    const federalRoom = Math.min(track.federalRoom, left);
    if (f.v >= -PAY_EPS) {
      evaluate(inp, law, out, false);
      if (f.v >= -PAY_EPS) break;
      delta = start + Math.min(0.01, room / 2);
      out.open = true;
      answeredAt = false;
      break;
    }
    // 3. A root inside the piece (or the cells' scan), else 4. the room's end.
    // The end is checked "at" only when the piece's own value there pays: it
    // then pays only if the end is this piece's (the cliff, an "at or under"
    // line); otherwise it belongs to the next piece.
    let step = Math.max(room, 1e-7);
    let endPays = false;
    if (out.health.staircase && room < federalRoom) {
      const r = scanCells(law, out, federalRoom);
      if (r >= 0) {
        delta = start + r;
        evaluate(inp, law, out, false);
        if (f.v >= -PAY_EPS) break;
        out.missedKinks++;
        needAt = true;
        continue;
      }
      step = federalRoom;
      endPays = scanEnd >= -PAY_EPS;
    } else {
      if (f.s > 0) {
        const r = -f.v / f.s;
        if (r < room - LINE_EPS) {
          delta = start + r;
          evaluate(inp, law, out, false);
          if (f.v >= -PAY_EPS) break;
          out.missedKinks++;
          needAt = true;
          continue;
        }
      }
      endPays = f.v + f.s * room >= -PAY_EPS;
    }
    if (endPays) {
      delta = start + step;
      evaluate(inp, law, out, false);
      if (f.v >= -PAY_EPS) break;
    }
    delta = start + step;
    if (remaining(active) - delta <= LINE_EPS) {
      delta = remaining(active);
      commit();
      active = -1;
    }
  }
  commit();
  active = -1;
}

/** Scans a sloped band's percent cells from the current point to the federal
 *  room's end, holding everything but the ACA's contribution affine. Returns
 *  the offset of the least paying point, or -1 when none pays. Reads the
 *  right-hand evaluation just made (f, out.health). */
function scanCells(law: TaxLaw, out: YearResult, federalRoom: number): number {
  const h = out.health;
  const p = h.creditPoverty;
  const b = h.benchmark;
  const i0 = hin.magi.v;
  const si = hin.magi.s;
  // Everything but the ACA's net cost, affine across the federal room.
  const base = f.v + h.acaNet.v;
  const baseS = f.s + h.acaNet.s;
  let pct = h.linePercent;
  let start = 0;
  while (start < federalRoom) {
    if (++out.pieces > MAX_PIECES) throw new Error(`The year's walk took more than ${MAX_PIECES} pieces`);
    const fig = pct === h.linePercent ? h.figure : cellFigure(law, hin, pct);
    const end = Math.min(federalRoom, (((pct + 1) * p) / 100 - i0) / si);
    // The contribution meets the benchmark at `full`; past it, the cost is the benchmark.
    const full = fig > 0 ? (b / fig - i0) / si : Infinity;
    const split = Math.min(end, Math.max(start, full));
    // Before `split`: base - fig * income; after it: base - b.
    const atStart = start < split ? base + baseS * start - fig * (i0 + si * start) : base + baseS * start - b;
    if (atStart >= -PAY_EPS) return start;
    const s1 = baseS - fig * si;
    if (split > start && s1 > 0) {
      const r = start - atStart / s1;
      if (r < split) return r;
    }
    if (end > split && baseS > 0) {
      const atSplit = base + baseS * split - b;
      if (atSplit >= -PAY_EPS) return split;
      const r = split - atSplit / baseS;
      if (r < end) return r;
    }
    scanEnd = end > split ? base + baseS * end - b : base + baseS * end - fig * (i0 + si * end);
    start = end;
    pct++;
  }
  return -1;
}

/** Checks a year's input once per plan: types, ranges, and that Roth value
 *  covers its reachable money and window. Throws naming the field. */
export function checkYearInput(inp: YearInput): void {
  const finite = (v: number, name: string, min = 0) => {
    if (!Number.isFinite(v) || v < min) throw new Error(`${name} must be a number of at least ${min}`);
  };
  finite(inp.calendarYear, 'calendarYear', 1900);
  finite(inp.yearsFromToday, 'yearsFromToday');
  finite(inp.priceLevel, 'priceLevel', 1e-9);
  finite(inp.irmaaPriceRatio, 'irmaaPriceRatio', 1e-9);
  finite(inp.dependents, 'dependents');
  finite(inp.stateRate, 'stateRate');
  finite(inp.spending, 'spending');
  finite(inp.oneOffs, 'oneOffs');
  finite(inp.windfall, 'windfall');
  finite(inp.afterTaxIncome, 'afterTaxIncome');
  finite(inp.taxableYield, 'taxableYield');
  finite(inp.qualifiedShare, 'qualifiedShare');
  if (inp.qualifiedShare > 1 || inp.stateRate >= 1 || inp.taxableYield >= 1) throw new Error('A share must be under 1');
  finite(inp.taxExempt, 'taxExempt');
  finite(inp.carryover, 'carryover');
  if (inp.irmaaMagi !== null) finite(inp.irmaaMagi, 'irmaaMagi', -Infinity);
  finite(inp.medicareExtra, 'medicareExtra');
  finite(inp.healthGrowth, 'healthGrowth', -0.5);
  finite(inp.incomeGrowth, 'incomeGrowth', -0.5);
  finite(inp.growth, 'growth', -1);
  finite(inp.inflation, 'inflation', -0.5);
  if (inp.ceiling !== null) finite(inp.ceiling.at, 'ceiling.at');
  const filers = inp.filing === 'joint' ? 2 : 1;
  for (let i = 0; i < filers; i++) {
    const p = inp.people[i];
    const at = (name: string) => `people[${i}].${name}`;
    for (const k of ['age', 'rmdAge', 'taxable', 'basis', 'deferred', 'deferred457', 'roth', 'rothReachable', 'hsa', 'socialSecurity', 'pension', 'wages', 'conversion'] as const) {
      finite(p[k], at(k));
    }
    if (p.window.length !== WINDOW) throw new Error(`${at('window')} must hold ${WINDOW} years`);
    p.window.forEach((v, w) => finite(v, at(`window[${w}]`)));
    if (p.rothReachable + windowSum(p, 0) > p.roth + 1e-6) throw new Error(`${at('roth')} must cover its reachable money and window`);
  }
}
