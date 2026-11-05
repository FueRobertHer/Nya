// lib/fire/drawdown.ts
//
// The years after you stop, in the detailed tax model: one tax year
// (lib/fire/tax/year.ts) per plan year from the start age to the plan's end, at
// the plan's steady return, each from the year before's close. What Drawdown's
// Year by year shows, what Whole path's years after the stop are, and where the
// stress test's tax share `t` and health cost `h` come from (lib/fire/bridge.ts).
//
// THE RULE COVERS SPENDING AND HEALTH. The plan's rule decides each year's
// spending as the engine's does (lib/fire/path.ts steadyRun): `planned * (1 - t)`,
// which pays living spending and an average year's health cost `h`, so a year's
// living spending is `planned * (1 - t) - h`, never below zero, and that year's
// own health cost is what the tax year adds back. Health counts once.
//   - A constant rule from a fixed start: `rate = (S + h) / (1 - t) / start`
//     makes living spending S whatever `t` and `h` are, so one run is enough.
//   - Any other rule: a fixed point, seeded at t = 0 and h = 0, until
//     `(S + h) / (1 - t)` moves under $1, at most 8 rounds. Unsettled takes the
//     higher of the last two and says so.
//
// `t` and `h`, by when each dollar is paid, discounted at the plan's return:
//   t = pv(tax) / pv(living + health + one-offs + tax)
//   h = pv(health) / pv(1)
// One-offs are in t's denominator because the stress test grosses them up at `t`
// too, so the two come out the same on a steady market (test/drawdown-bridge).
//
// A SHORT YEAR is recorded and the years run on from empty balances, so later
// health coverage is still known. A rule that only takes a share of what is there
// (percent, VPW, canRunOut in lib/fire/rules.ts) can't run out on its own: its year
// spends less instead, by what it can't pay.
//
// Filing single, or no household or partner's age, folds a partner's balances and
// income into the one return: the year's second person is read only on a joint
// return. The caller says so.
//
// Pure, and safe in the browser.

import type { IncomeRow } from './compile';
import { canRunOut, plannedWithdrawal, type RuleSpec, type YearState } from './rules';
import type { LowerSpending, OneOffExpense } from './simulate';
import type { Owner } from './tax-facts';
import type { Coverage, HealthStatus } from './tax/health';
import type { Filing, StateCode, TaxLaw } from './tax/law/types';
import type { MixSlot } from './tax/mix';
import { checkYearInput, newPersonYear, newYearResult, runYear, type Drawn, type YearInput, type YearResult } from './tax/year';

/** The share of a taxable yield that is qualified dividends: a broad stock fund's,
 *  about. Said in About these numbers. */
export const QUALIFIED_SHARE = 0.75;
/** How many times the fixed point runs the years. */
export const MAX_ROUNDS = 8;
/** Dollars of `(S + h) / (1 - t)` within which the fixed point has settled. */
const SETTLED = 1;
/** Tax's share past which `1 - t` stops being a number to divide by. */
const MAX_T = 0.95;

export type DrawdownHealth = {
  coverage: Coverage;
  medicareExtra: number;
  meetsRule: readonly Owner[];
  countMedicaid: boolean;
  acaLaw: '2026' | 'enhanced';
  /** A year over prices, as a fraction. */
  growth: number;
  incomeGrowth: number;
};

export type DrawdownInput = {
  /** Your age in its first year: today's or later. */
  startAge: number;
  years: number;
  today: { age: number; partnerAge: number | null; calendarYear: number };
  /** Null: not said, and counted as single. */
  filing: Filing | null;
  dependents: readonly { untilAge: number }[];
  rmdAges: Record<Owner, number>;
  /** What is held at the start, by owner and bucket. */
  slots: readonly MixSlot[];
  /** Of each owner's tax-deferred money, the share in a 457(b). */
  share457: Record<Owner, number>;
  /** Living spending, lasting changes in effect at the start included. */
  spending: number;
  /** The plan's rule at a rate (lib/fire/plan.ts ruleSpec). */
  rule: (rate: number) => RuleSpec;
  realReturn: number;
  inflation: number;
  taxableYield: number;
  oneOffs: readonly OneOffExpense[];
  lower: readonly LowerSpending[];
  income: readonly IncomeRow[];
  health: DrawdownHealth;
  state: StateCode | null;
  stateRate: number;
  law: TaxLaw;
};

/** What each bucket holds. */
export type BucketBalances = { taxable: number; deferred: number; roth: number; hsa: number };

/** One person's year in the health function, as the year sheet says it. */
export type PersonCare = { status: HealthStatus; premium: number; credit: number; partB: number; irmaa: number; extra: number; typed: number; irmaaTier: number };

export type DrawdownYear = {
  age: number;
  partnerAge: number | null;
  calendarYear: number;
  start: BucketBalances;
  end: BucketBalances;
  /** Living spending: the rule's less `h`, less lower costs. */
  living: number;
  /** The rule's spending fell under `h`, so living spending was held at zero. */
  heldAtZero: boolean;
  oneOffs: number;
  health: number;
  /** Federal, state, the penalty and FICA. */
  tax: number;
  withdrawal: number;
  surplus: number;
  short: boolean;
  shortfall: number;
  income: { socialSecurity: number; pension: number; wages: number; afterTax: number; windfall: number; yield: number; qualified: number };
  drawn: Drawn;
  rmd: number;
  law: {
    agi: number;
    taxableSocialSecurity: number;
    magiAca: number;
    magiIrmaa: number;
    deduction: number;
    ordinaryTaxable: number;
    ordinaryTax: number;
    gainsTax: number;
    niit: number;
    state: number;
    penalty: number;
    fica: number;
    /** The top rate on ordinary income this year. */
    topRate: number;
  };
  care: {
    people: [PersonCare, PersonCare];
    dependents: { status: HealthStatus; premium: number; credit: number };
    benchmark: number;
    figure: number;
    povertyPercent: number;
    medicaidPercent: number;
    overLimit: boolean;
    underLine: boolean;
    lowerDeductibles: boolean;
    irmaaUnknown: boolean;
  };
};

export type StageKey = 'before-60' | 'before-65' | 'before-rmd' | 'rmd';

/** A stretch of the years, by your age: where the money comes from, and tax. */
export type DrawdownStage = {
  key: StageKey;
  from: number;
  to: number;
  /** The rows of `years` it holds, [first, last). */
  first: number;
  last: number;
  yearlyTax: number;
  /** Over the stage, what each source paid. */
  sources: { taxable: number; deferred: number; roth: number; hsa: number; rmd: number; socialSecurity: number; pension: number; wages: number; afterTax: number };
};

export type DrawdownNote = 'folded-partner' | 'unsettled' | 'held-at-zero' | 'irmaa-unknown';

export type Drawdown = {
  years: DrawdownYear[];
  t: number;
  h: number;
  /** The rate the rule starts at, for this `t` and `h`: what a stress test from
   *  the same balance runs at (VPW has none). */
  rate: number;
  rounds: number;
  settled: boolean;
  /** Taxable at its value, Roth as it is, tax-deferred and an HSA after tax at
   *  the last year's top rate. */
  leftAtEnd: number;
  /** All the years' tax and health coverage, in today's dollars. */
  taxAndHealth: number;
  /** Your age in the first year it couldn't pay; null when it lasts. */
  runsOutAt: number | null;
  stages: DrawdownStage[];
  notes: DrawdownNote[];
};

/** Whether the years have a partner on the return. */
const isJoint = (inp: DrawdownInput) => inp.filing === 'joint' && inp.today.partnerAge !== null;

/** Whether the partner's balances and income go on your return. */
export const foldsPartner = (inp: Pick<DrawdownInput, 'filing' | 'today' | 'slots' | 'income'>): boolean =>
  !(inp.filing === 'joint' && inp.today.partnerAge !== null) && (inp.slots.some((s) => s.owner === 'partner' && s.value > 0) || inp.income.some((r) => r.owner === 'partner'));

function startPeople(inp: DrawdownInput): [ReturnType<typeof newPersonYear>, ReturnType<typeof newPersonYear>] {
  const joint = isJoint(inp);
  const people = [newPersonYear(), newPersonYear()] as [ReturnType<typeof newPersonYear>, ReturnType<typeof newPersonYear>];
  for (const s of inp.slots) {
    const i = joint && s.owner === 'partner' ? 1 : 0;
    const p = people[i];
    switch (s.bucket) {
      case 'taxable':
        p.taxable += s.value;
        p.basis += Math.min(s.basis, s.value);
        break;
      case 'roth':
        p.roth += s.value;
        p.rothReachable += Math.min(s.reachable, s.value);
        break;
      case 'hsa':
        p.hsa += s.value;
        break;
      // A counted education account stands in as tax-deferred, as an account in
      // no bucket does: the most taxed, the least reachable.
      case 'education':
      case 'tax-deferred': {
        const in457 = s.value * Math.min(1, Math.max(0, inp.share457[s.owner] ?? 0));
        p.deferred += s.value - in457;
        p.deferred457 += in457;
        break;
      }
    }
  }
  return people;
}

const bucketsOf = (people: readonly { taxable: number; deferred: number; deferred457: number; roth: number; hsa: number }[]): BucketBalances => {
  const b: BucketBalances = { taxable: 0, deferred: 0, roth: 0, hsa: 0 };
  for (const p of people) {
    b.taxable += p.taxable;
    b.deferred += p.deferred + p.deferred457;
    b.roth += p.roth;
    b.hsa += p.hsa;
  }
  return b;
};

const totalOf = (b: BucketBalances) => b.taxable + b.deferred + b.roth + b.hsa;

const sumDrawn = (a: Drawn, b: Drawn): Drawn => ({
  hsaPremiums: a.hsaPremiums + b.hsaPremiums, taxable: a.taxable + b.taxable, gain: a.gain + b.gain, deferred: a.deferred + b.deferred, deferred457: a.deferred457 + b.deferred457,
  hsaTaxed: a.hsaTaxed + b.hsaTaxed, roth: a.roth + b.roth, young: a.young + b.young, penalized: a.penalized + b.penalized, earnings: a.earnings + b.earnings, hsaEarly: a.hsaEarly + b.hsaEarly,
});

const careOf = (p: YearResult['health']['people'][number]): PersonCare => ({ status: p.status, premium: p.premium, credit: p.credit, partB: p.partB, irmaa: p.irmaa, extra: p.extra, typed: p.typed, irmaaTier: p.irmaaTier });

/** The ordinary rate on the last dollar of ordinary taxable income. */
function topRateOf(ordinaryTaxable: number, filing: Filing, law: TaxLaw): number {
  const brackets = law.brackets.ordinary[filing];
  for (const b of brackets) if (ordinaryTaxable <= b.upTo) return b.rate;
  return brackets[brackets.length - 1].rate;
}

type Run = { rows: DrawdownYear[]; t: number; h: number; held: boolean; irmaaUnknown: boolean };

/** The years once, the rule at `rate`, keeping `t` and `h` out of living spending. */
function runYears(inp: DrawdownInput, rule: RuleSpec, t: number, h: number): Run {
  const { startAge, years, today, law, inflation, realReturn, health } = inp;
  const joint = isJoint(inp);
  const filing: Filing = joint ? 'joint' : 'single';
  const shortens = !canRunOut(rule.kind);
  const people = startPeople(inp);
  const oneOffs = new Array<number>(years).fill(0);
  for (const o of inp.oneOffs) if (o.year >= 0 && o.year < years) oneOffs[o.year] += o.amount;
  const lower = new Array<number>(years).fill(0);
  for (const l of inp.lower) for (let y = Math.max(0, l.fromYear); y < Math.min(years, l.toYear ?? years); y++) lower[y] += l.amount;

  const startBalance = totalOf(bucketsOf(people));
  const state: YearState = { year: 0, years, balance: startBalance, startBalance, previous: 0, initial: 0, lastNominalReturn: 0, lastInflation: 0 };
  const out = newYearResult();
  const rows: DrawdownYear[] = [];
  let carryover = 0;
  let held = false;
  let irmaaUnknown = false;
  const meets = (owner: Owner) => health.meetsRule.includes(owner);

  for (let y = 0; y < years; y++) {
    const age = startAge + y;
    const k = age - today.age;
    const partnerAge = today.partnerAge === null ? null : today.partnerAge + k;
    state.year = y;
    state.balance = totalOf(bucketsOf(people));
    const raw = plannedWithdrawal(rule, state);
    const planned = Number.isFinite(raw) && raw > 0 ? raw : 0;
    if (y === 0) state.initial = planned;
    state.previous = planned;

    // The rule's spending, less the average health cost, then lower costs off
    // living spending and what they leave off the year's one-offs.
    const spent = planned * (1 - t) - h;
    const heldAtZero = spent < 0;
    held ||= heldAtZero;
    let living = Math.max(0, spent);
    const off = Math.min(lower[y], living);
    living -= off;
    const once = Math.max(0, oneOffs[y] - (lower[y] - off));

    const socialSecurity = [0, 0];
    const pension = [0, 0];
    const wages = [0, 0];
    let afterTax = 0;
    let windfall = 0;
    for (const r of inp.income) {
      if (y < r.fromYear || (r.toYear !== undefined && y >= r.toYear)) continue;
      const amount = r.inflationAdjusted ? r.gross : r.gross / (1 + inflation) ** (y - Math.max(0, r.fromYear));
      const i = joint && r.owner === 'partner' ? 1 : 0;
      if (r.kind === 'windfall') windfall += amount;
      else if (!r.beforeTax) afterTax += amount;
      else if (r.kind === 'social-security') socialSecurity[i] += amount;
      else if (r.kind === 'part-time') wages[i] += amount;
      else pension[i] += amount;
    }

    people[0].age = age;
    people[0].rmdAge = inp.rmdAges.you;
    people[0].socialSecurity = socialSecurity[0];
    people[0].pension = pension[0];
    people[0].wages = wages[0];
    people[0].conversion = 0;
    people[0].meetsRule = meets('you');
    if (joint) {
      people[1].age = partnerAge as number;
      people[1].rmdAge = inp.rmdAges.partner;
      people[1].socialSecurity = socialSecurity[1];
      people[1].pension = pension[1];
      people[1].wages = wages[1];
      people[1].conversion = 0;
      people[1].meetsRule = meets('partner');
    }
    const input: YearInput = {
      calendarYear: today.calendarYear + k,
      yearsFromToday: k,
      priceLevel: (1 + inflation) ** k,
      irmaaPriceRatio: (1 + inflation) ** 2,
      filing,
      people,
      dependents: inp.dependents.reduce((n, d) => (d.untilAge > age ? n + 1 : n), 0),
      state: inp.state,
      stateRate: inp.stateRate,
      spending: living,
      oneOffs: once,
      windfall,
      afterTaxIncome: afterTax,
      taxableYield: inp.taxableYield,
      qualifiedShare: QUALIFIED_SHARE,
      taxExempt: 0,
      carryover,
      irmaaMagi: y >= 2 ? rows[y - 2].law.magiIrmaa : null,
      coverage: health.coverage,
      medicareExtra: health.medicareExtra,
      countMedicaid: health.countMedicaid,
      acaLaw: health.acaLaw,
      healthGrowth: health.growth,
      incomeGrowth: health.incomeGrowth,
      ceiling: null,
      growth: realReturn,
      inflation,
    };
    if (y === 0) checkYearInput(input);
    const startBuckets = bucketsOf(joint ? people : [people[0]]);
    const yieldCash = (joint ? people[0].taxable + people[1].taxable : people[0].taxable) * inp.taxableYield;
    runYear(input, law, out);
    // A share of what is there can't run out: the year spends less.
    for (let pass = 0; shortens && out.short && input.spending > 0 && pass < 4; pass++) {
      input.spending = Math.max(0, input.spending - out.shortfall);
      runYear(input, law, out);
    }

    const fed = out.federal;
    const care = out.health;
    const end = bucketsOf([out.people[0].end, ...(joint ? [out.people[1].end] : [])]);
    irmaaUnknown ||= care.irmaaUnknown;
    rows.push({
      age,
      partnerAge,
      calendarYear: input.calendarYear,
      start: startBuckets,
      end,
      living: input.spending,
      heldAtZero,
      oneOffs: once,
      health: care.total.v,
      tax: fed.total.v,
      withdrawal: out.withdrawal,
      surplus: out.surplus,
      short: out.short,
      shortfall: out.shortfall,
      income: {
        socialSecurity: socialSecurity[0] + socialSecurity[1],
        pension: pension[0] + pension[1],
        wages: wages[0] + wages[1],
        afterTax,
        windfall,
        yield: yieldCash,
        qualified: yieldCash * QUALIFIED_SHARE,
      },
      drawn: joint ? sumDrawn(out.people[0].drawn, out.people[1].drawn) : { ...out.people[0].drawn },
      rmd: out.people[0].rmd + (joint ? out.people[1].rmd : 0),
      law: {
        agi: fed.agi.v,
        taxableSocialSecurity: fed.taxableSocialSecurity.v,
        magiAca: fed.magiAca.v,
        magiIrmaa: fed.magiIrmaa.v,
        deduction: fed.deduction.v,
        ordinaryTaxable: fed.ordinaryTaxable.v,
        ordinaryTax: fed.ordinaryTax.v,
        gainsTax: fed.gainsTax.v,
        niit: fed.niit.v,
        state: fed.state.v,
        penalty: fed.penalty.v,
        fica: fed.fica.v,
        topRate: topRateOf(fed.ordinaryTaxable.v, filing, law),
      },
      care: {
        people: [careOf(care.people[0]), careOf(care.people[1])],
        dependents: { ...care.dependents },
        benchmark: care.benchmark,
        figure: care.figure,
        povertyPercent: care.povertyPercent,
        medicaidPercent: care.medicaidPercent,
        overLimit: care.overLimit,
        underLine: care.underLine,
        lowerDeductibles: care.lowerDeductibles,
        irmaaUnknown: care.irmaaUnknown,
      },
    });

    // Next year's start. What a year's result holds is reused: copied here.
    for (let i = 0; i < 2; i++) {
      const e = out.people[i].end;
      const p = people[i];
      p.taxable = e.taxable;
      p.basis = e.basis;
      p.deferred = e.deferred;
      p.deferred457 = e.deferred457;
      p.roth = e.roth;
      p.rothReachable = e.rothReachable;
      p.hsa = e.hsa;
      for (let w = 0; w < p.window.length; w++) p.window[w] = e.window[w];
    }
    carryover = out.carryoverOut;
    state.lastNominalReturn = totalOf(end) > 0 ? (1 + realReturn) * (1 + inflation) - 1 : 0;
    state.lastInflation = inflation;
  }

  const shares = taxShares(rows, realReturn);
  return { rows, t: shares.t, h: shares.h, held, irmaaUnknown };
}

/** Tax's share of what the years cost, and the level yearly health cost, by when
 *  each dollar is paid. From the rows, so a test can work them out again. */
export function taxShares(rows: readonly Pick<DrawdownYear, 'living' | 'oneOffs' | 'health' | 'tax'>[], realReturn: number): { t: number; h: number } {
  let pvTax = 0;
  let pvCost = 0;
  let pvHealth = 0;
  let pvOne = 0;
  let d = 1;
  for (const r of rows) {
    pvTax += r.tax * d;
    pvCost += (r.living + r.oneOffs + r.health + r.tax) * d;
    pvHealth += r.health * d;
    pvOne += d;
    d /= 1 + realReturn;
  }
  return { t: pvCost > 0 ? Math.min(MAX_T, pvTax / pvCost) : 0, h: pvOne > 0 ? pvHealth / pvOne : 0 };
}

function stagesOf(rows: readonly DrawdownYear[], rmdAge: number): DrawdownStage[] {
  const stageOf = (age: number): StageKey => (age < 60 ? 'before-60' : age < 65 ? 'before-65' : age < rmdAge ? 'before-rmd' : 'rmd');
  const stages: DrawdownStage[] = [];
  rows.forEach((r, i) => {
    const key = stageOf(r.age);
    let s = stages[stages.length - 1];
    if (!s || s.key !== key) {
      s = { key, from: r.age, to: r.age, first: i, last: i, yearlyTax: 0, sources: { taxable: 0, deferred: 0, roth: 0, hsa: 0, rmd: 0, socialSecurity: 0, pension: 0, wages: 0, afterTax: 0 } };
      stages.push(s);
    }
    s.to = r.age;
    s.last = i + 1;
    s.yearlyTax += r.tax;
    const d = r.drawn;
    s.sources.taxable += d.taxable;
    s.sources.deferred += d.deferred + d.deferred457 + d.penalized;
    s.sources.roth += d.roth + d.young + d.earnings;
    s.sources.hsa += d.hsaPremiums + d.hsaTaxed + d.hsaEarly;
    s.sources.rmd += r.rmd;
    s.sources.socialSecurity += r.income.socialSecurity;
    s.sources.pension += r.income.pension;
    s.sources.wages += r.income.wages;
    s.sources.afterTax += r.income.afterTax;
  });
  for (const s of stages) s.yearlyTax /= s.last - s.first;
  return stages;
}

/** The figure the fixed point settles: what the rule withdraws in a first year. */
const grossed = (spending: number, r: { t: number; h: number }) => (spending + r.h) / (1 - r.t);

/** The drawdown, or why it couldn't be worked out, when the flat model carries
 *  the plan instead. */
export function runDrawdown(inp: DrawdownInput): Drawdown | { failed: string } {
  if (!(inp.years >= 1) || !(inp.startAge >= inp.today.age)) return { failed: 'It needs a year to run, from today or later' };
  const start = inp.slots.reduce((sum, s) => sum + s.value, 0);
  const rateFor = (r: { t: number; h: number }) => (start > 0 ? grossed(inp.spending, r) / start : 0);
  const kind = inp.rule(0).kind;
  try {
    let run: Run;
    let rounds = 1;
    let settled = true;
    if (kind === 'constant') {
      // S / start gives living spending S with t and h at zero, and
      // (S + h) / (1 - t) / start gives the same with any others.
      run = runYears(inp, inp.rule(rateFor({ t: 0, h: 0 })), 0, 0);
    } else {
      let seed = { t: 0, h: 0 };
      run = runYears(inp, inp.rule(rateFor(seed)), 0, 0);
      let before = run;
      settled = false;
      while (rounds < MAX_ROUNDS) {
        const moved = Math.abs(grossed(inp.spending, run) - grossed(inp.spending, seed));
        if (moved < SETTLED) {
          settled = true;
          break;
        }
        seed = { t: run.t, h: run.h };
        before = run;
        run = runYears(inp, inp.rule(rateFor(seed)), seed.t, seed.h);
        rounds++;
      }
      if (!settled && Math.abs(grossed(inp.spending, run) - grossed(inp.spending, seed)) < SETTLED) settled = true;
      if (!settled && grossed(inp.spending, before) > grossed(inp.spending, run)) run = before;
    }
    const { rows, t, h } = run;
    const last = rows[rows.length - 1];
    const left = last.end.taxable + last.end.roth + (last.end.deferred + last.end.hsa) * (1 - last.law.topRate);
    const firstShort = rows.find((r) => r.short);
    const notes: DrawdownNote[] = [];
    if (foldsPartner(inp)) notes.push('folded-partner');
    if (!settled) notes.push('unsettled');
    if (run.held) notes.push('held-at-zero');
    if (run.irmaaUnknown) notes.push('irmaa-unknown');
    return {
      years: rows,
      t,
      h,
      rate: rateFor({ t, h }),
      rounds,
      settled,
      leftAtEnd: left,
      taxAndHealth: rows.reduce((sum, r) => sum + r.tax + r.health, 0),
      runsOutAt: firstShort ? firstShort.age : null,
      stages: stagesOf(rows, inp.rmdAges.you),
      notes,
    };
  } catch (e) {
    return { failed: e instanceof Error ? e.message : 'The years couldn’t be worked out' };
  }
}
