// lib/fire/taxed-paths.ts
//
// The stress test with each year's tax: what runPaths (lib/fire/simulate.ts) does for
// a detailed plan. One tax year (lib/fire/tax/year.ts) per plan year, each from the
// year before's close, on the market that path lives through, giving the same
// RunOutput as the flat branch, so what reads a run reads this one the same way. A
// year here is runYears' in lib/fire/drawdown.ts with the steady return and inflation
// replaced by the path's: on a steady market a path ends where the drawdown ends
// (test/taxed-paths.test.ts).
//
// THE RULE COVERS SPENDING AND HEALTH, as in the drawdown, so `t` and `h` are only the
// rule's split: a year lives on `planned * (1 - t) - h`, never below zero, and what it
// really pays in tax and health is the year's to work out. A run fails in the first
// year that can't pay with every source spent. A rule that only takes a share of what
// is there (canRunOut in lib/fire/rules.ts) gives up living spending first.
//
// WHAT THE PATH BRINGS:
//   - the year's return and inflation, the fee taken off the return;
//   - prices: the law's dollar lines and income that doesn't keep up read the path's
//     own price level (the assumed inflation up to the plan's start), and IRMAA's
//     lookback the path's own two years (the assumed inflation in the first two);
//   - with `rebalance: 'none'`, the mix, tracked as shares. Money in and out is pro
//     rata, so only the markets move them, and a balance of nothing resets them, as
//     the flat branch does.
//
// WHAT WAITS ON A RUN'S OWN BALANCE fires as in the flat branch: each run checks its
// balance against each trigger before that year's money, once.
//
// Apart from simulate.ts because Home loads that, and no year or law: lib/fire/jobs.ts
// hands this in. The law comes with the plan, so this holds no tables either.
//
// Pure, and safe in the browser.

import type { IncomeRow } from './compile';
import { QUALIFIED_SHARE, type DrawdownHealth } from './drawdown';
import type { Market } from './market';
import { canRunOut, plannedWithdrawal, type YearState } from './rules';
import { growthTables, type ConditionalEdge, type PathSource, type RunOutput, type SimPlan } from './simulate';
import type { Owner } from './tax-facts';
import type { Filing, StateCode, TaxLaw } from './tax/law/types';
import { peopleOf, type MixSlot } from './tax/mix';
import { defaultUntil, yearRule, type Strategy } from './tax/rules';
import { checkYearInput, newYearResult, runYear, runYearFilling, splitConversion, startFilling, type PersonYear, type YearInput } from './tax/year';

/** What a run's years need beyond the flat plan's parts. Plain data, as a job carries
 *  it to a worker. Amounts are the drawdown's: before tax, as typed. */
export type SimTax = {
  /** Your age in the first year: today's or later. */
  startAge: number;
  today: { age: number; partnerAge: number | null; calendarYear: number };
  /** Null: not said, and counted as single. */
  filing: Filing | null;
  dependents: readonly { untilAge: number }[];
  rmdAges: Record<Owner, number>;
  /** What is held at the start, by owner and bucket. */
  slots: readonly MixSlot[];
  share457: Record<Owner, number>;
  /** The assumed inflation: up to the start, and for IRMAA's first two years. */
  inflation: number;
  taxableYield: number;
  income: readonly IncomeRow[];
  health: DrawdownHealth;
  state: StateCode | null;
  stateRate: number;
  law: TaxLaw;
  strategy: Strategy;
  /** The rule's split: tax's share of what it withdraws, and the yearly health cost it holds. */
  t: number;
  h: number;
};

/** A person's balances, at a year's start or close. */
type Held = Pick<PersonYear, 'taxable' | 'basis' | 'deferred' | 'deferred457' | 'roth' | 'rothReachable' | 'window' | 'hsa'>;

function hold(to: Held, from: Held): void {
  to.taxable = from.taxable;
  to.basis = from.basis;
  to.deferred = from.deferred;
  to.deferred457 = from.deferred457;
  to.roth = from.roth;
  to.rothReachable = from.rothReachable;
  to.hsa = from.hsa;
  for (let w = 0; w < to.window.length; w++) to.window[w] = from.window[w];
}

const totalHeld = (p: Held) => p.taxable + p.deferred + p.deferred457 + p.roth + p.hsa;

export function taxedPaths(plan: SimPlan, market: Market, source: PathSource, keep: boolean, watch: number | null = null): RunOutput {
  const tax = plan.tax;
  if (!tax) throw new RangeError('This plan has no tax to work out');
  const { today, law, strategy, t, h } = tax;
  const years = plan.years;
  const count = source.count;
  const g = growthTables(plan, market);
  const afterFee = 1 - plan.fee;
  const target = plan.allocation;
  const drift = plan.rebalance === 'none';
  const joint = tax.filing === 'joint' && today.partnerAge !== null;
  const shortens = !canRunOut(plan.rule.kind);
  const until = strategy.convertUntil ?? defaultUntil(tax.rmdAges, { age: today.age, partnerAge: joint ? today.partnerAge : null });

  const oneOffs = new Float64Array(years);
  for (const o of plan.oneOffs) if (o.year < years) oneOffs[o.year] += o.amount;
  const lower = new Float64Array(years);
  for (const l of plan.lowerSpending ?? []) {
    for (let y = l.fromYear; y < Math.min(years, l.toYear ?? years); y++) lower[y] += l.amount;
  }

  const out: RunOutput = {
    balances: keep ? new Float64Array(count * (years + 1)) : null,
    spending: keep ? new Float64Array(count * years) : null,
    failedYear: new Int32Array(count).fill(-1),
    lowestSpending: new Float64Array(count),
    endBalance: new Float64Array(count),
    firstYearSpending: 0,
    firedYear: watch === null ? null : new Int32Array(count).fill(-1),
  };

  const people = peopleOf(tax.slots, tax.share457, joint);
  const start = people.map((p) => ({ ...p, window: [...p.window] }));
  people[0].rmdAge = tax.rmdAges.you;
  people[0].meetsRule = tax.health.meetsRule.includes('you');
  people[1].rmdAge = tax.rmdAges.partner;
  people[1].meetsRule = tax.health.meetsRule.includes('partner');
  const startBalance = totalHeld(people[0]) + (joint ? totalHeld(people[1]) : 0);

  // One of each, refilled: a plan runs up to 300,000 years at a time.
  const result = newYearResult();
  const state: YearState = { year: 0, years, balance: 0, startBalance, previous: 0, initial: 0, lastNominalReturn: 0, lastInflation: 0 };
  const input: YearInput = {
    calendarYear: 0,
    yearsFromToday: 0,
    priceLevel: 1,
    irmaaPriceRatio: 1,
    filing: joint ? 'joint' : 'single',
    people,
    dependents: 0,
    state: tax.state,
    stateRate: tax.stateRate,
    spending: 0,
    oneOffs: 0,
    windfall: 0,
    afterTaxIncome: 0,
    taxableYield: tax.taxableYield,
    qualifiedShare: QUALIFIED_SHARE,
    taxExempt: 0,
    carryover: 0,
    irmaaMagi: null,
    coverage: tax.health.coverage,
    medicareExtra: tax.health.medicareExtra,
    countMedicaid: tax.health.countMedicaid,
    acaLaw: tax.health.acaLaw,
    healthGrowth: tax.health.growth,
    incomeGrowth: tax.health.incomeGrowth,
    ceiling: null,
    order: strategy.order,
    fill: null,
    growth: 0,
    inflation: 0,
  };
  // The price level at the start of each year, relative to the plan's start.
  const priceAt = new Float64Array(years + 1);
  const priceBefore = (1 + tax.inflation) ** (tax.startAge - today.age);
  const assumedTwoYears = (1 + tax.inflation) ** 2;

  const socialSecurity = [0, 0];
  const pension = [0, 0];
  const wages = [0, 0];
  let afterTax = 0;
  let windfall = 0;
  /** A year's amount of an income, by what the law taxes it as. */
  const earn = (kind: IncomeRow['kind'] | undefined, owner: IncomeRow['owner'] | undefined, beforeTax: boolean | undefined, amount: number) => {
    const i = joint && owner === 'partner' ? 1 : 0;
    if (kind === 'windfall') windfall += amount;
    else if (!beforeTax) afterTax += amount;
    else if (kind === 'social-security') socialSecurity[i] += amount;
    else if (kind === 'part-time') wages[i] += amount;
    else pension[i] += amount;
  };

  const conditional = plan.conditional ?? null;
  // The year each trigger fired in this run; -1 until it does.
  const firedIn = conditional ? new Int32Array(conditional.triggers.length) : null;
  const yearOf = (e: ConditionalEdge) => ('year' in e ? e.year : (firedIn as Int32Array)[e.trigger] < 0 ? Infinity : (firedIn as Int32Array)[e.trigger] + e.offset);

  for (let p = 0; p < count; p++) {
    hold(people[0], start[0]);
    hold(people[1], start[1]);
    let bal = startBalance;
    // The share of each asset, moved only when the mix is left to drift.
    let shareStocks = target.stocks;
    let shareBonds = target.bonds;
    let shareCash = target.cash;
    let lowest = Infinity;
    let failed = -1;
    // IRMAA's MAGI from one and two years before.
    let magiLast = 0;
    let magiBefore = 0;
    let hint = 0;
    input.carryover = 0;
    state.previous = 0;
    state.initial = 0;
    state.lastNominalReturn = 0;
    state.lastInflation = 0;
    priceAt[0] = 1;
    startFilling();
    if (firedIn) firedIn.fill(-1);

    for (let y = 0; y < years; y++) {
      if (out.balances) out.balances[p * (years + 1) + y] = bal;
      const age = tax.startAge + y;
      const k = age - today.age;

      state.year = y;
      state.balance = bal;
      const raw = plannedWithdrawal(plan.rule, state);
      const planned = Number.isFinite(raw) && raw > 0 ? raw : 0;
      if (y === 0) state.initial = planned;
      state.previous = planned;
      const spend = Math.max(planned * (1 - t), h);
      if (y === 0 && p === 0) out.firstYearSpending = spend;

      socialSecurity[0] = socialSecurity[1] = pension[0] = pension[1] = wages[0] = wages[1] = 0;
      afterTax = windfall = 0;
      for (const r of tax.income) {
        if (y < r.fromYear || (r.toYear !== undefined && y >= r.toYear)) continue;
        earn(r.kind, r.owner, r.beforeTax, r.inflationAdjusted ? r.gross : (r.gross * priceAt[Math.max(0, r.fromYear)]) / priceAt[y]);
      }

      let more = oneOffs[y];
      let less = lower[y];
      if (conditional && firedIn) {
        for (let i = 0; i < firedIn.length; i++) if (firedIn[i] < 0 && bal >= conditional.triggers[i]) firedIn[i] = y;
        for (const x of conditional.items) {
          const from = yearOf(x.start);
          if (y < from) continue;
          if (y === from) windfall += x.moneyIn;
          for (const o of x.once) if (y === from + o.after) more += o.amount;
          if (x.end !== null && y >= yearOf(x.end)) continue;
          if (x.yearly > 0) more += x.yearly;
          else if (x.yearly < 0) less -= x.yearly;
          // A fixed-value income keeps its value until it starts in this run.
          if (x.income) earn(x.income.kind, x.income.owner, x.income.beforeTax, x.income.inflationAdjusted ? x.income.amount : (x.income.amount * priceAt[Math.max(0, from)]) / priceAt[y]);
        }
      }

      // The rule's spending less the average health cost, then lower costs off
      // living spending and what they leave off the year's one-offs.
      const asks = Math.max(0, planned * (1 - t) - h);
      const off = Math.min(less, asks);
      const living = asks - off;

      if (drift && bal <= 0) {
        shareStocks = target.stocks;
        shareBonds = target.bonds;
        shareCash = target.cash;
      }
      const m = source.monthAt(p, y);
      const factor = drift ? shareStocks * g.stocks[m] + shareBonds * g.bonds[m] + shareCash * g.cash : (g.portfolio as Float64Array)[m];

      people[0].age = age;
      people[0].socialSecurity = socialSecurity[0];
      people[0].pension = pension[0];
      people[0].wages = wages[0];
      people[0].conversion = 0;
      if (joint) {
        people[1].age = (today.partnerAge as number) + k;
        people[1].socialSecurity = socialSecurity[1];
        people[1].pension = pension[1];
        people[1].wages = wages[1];
        people[1].conversion = 0;
      }
      let dependents = 0;
      for (const d of tax.dependents) if (d.untilAge > age) dependents++;
      input.calendarYear = today.calendarYear + k;
      input.yearsFromToday = k;
      input.priceLevel = priceBefore * priceAt[y];
      input.irmaaPriceRatio = y >= 2 ? priceAt[y] / priceAt[y - 2] : assumedTwoYears;
      input.dependents = dependents;
      input.spending = living;
      input.oneOffs = Math.max(0, more - (less - off));
      input.windfall = windfall;
      input.afterTaxIncome = afterTax;
      input.irmaaMagi = y >= 2 ? magiBefore : null;
      input.growth = factor * afterFee - 1;
      input.inflation = g.inflation[m] - 1;

      const asked = yearRule(strategy, until, age, input, law);
      input.ceiling = asked.ceiling;
      input.fill = asked.fill;
      if (asked.fixed > 0) splitConversion(input, law, asked.fixed);
      if (p === 0 && y === 0) checkYearInput(input);
      if (asked.fill) runYearFilling(input, law, result, hint);
      else runYear(input, law, result);
      // A share of what is there can't run out: the year spends less.
      for (let pass = 0; shortens && result.short && input.spending > 0 && pass < 4; pass++) {
        input.spending = Math.max(0, input.spending - result.shortfall);
        if (asked.fill) runYearFilling(input, law, result);
        else runYear(input, law, result);
      }
      if (result.short) {
        failed = y;
        break;
      }
      if (asked.fill) hint = result.people[0].conversion + (joint ? result.people[1].conversion : 0);

      const spent = spend - (living - input.spending);
      if (out.spending) out.spending[p * years + y] = spent;
      if (spent < lowest) lowest = spent;

      hold(people[0], result.people[0].end);
      hold(people[1], result.people[1].end);
      bal = totalHeld(people[0]) + (joint ? totalHeld(people[1]) : 0);
      if (!Number.isFinite(bal)) throw new RangeError('A year’s balance came to something that isn’t a number');
      input.carryover = result.carryoverOut;
      magiBefore = magiLast;
      magiLast = result.federal.magiIrmaa.v;
      if (drift && factor > 0) {
        shareStocks = (shareStocks * g.stocks[m]) / factor;
        shareBonds = (shareBonds * g.bonds[m]) / factor;
        shareCash = (shareCash * g.cash) / factor;
      }
      state.lastNominalReturn = bal > 0 ? factor * afterFee * g.inflation[m] - 1 : 0;
      state.lastInflation = g.inflation[m] - 1;
      priceAt[y + 1] = priceAt[y] * g.inflation[m];
    }

    out.failedYear[p] = failed;
    out.lowestSpending[p] = lowest === Infinity ? 0 : lowest;
    // A plan that ran out holds 0 from then on; the arrays start at 0.
    out.endBalance[p] = failed >= 0 ? 0 : bal;
    if (out.firedYear && firedIn) out.firedYear[p] = firedIn[watch as number];
    if (out.balances && failed < 0) out.balances[p * (years + 1) + years] = bal;
  }
  return out;
}
