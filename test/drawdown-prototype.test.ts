// The tax plan's household (Overview: "What the prototype found"), run through the
// build rather than the prototype: the drawdown and the tax branch, under
// D6's work rule by household income, and T4's rules side by side. These figures go
// into Overview. Pinned, so a change to any of the three shows here.
//   A couple, 41 and 40, stopping at 50 on $64,000 a year. 5% growth, 3% inflation,
//   a 2% yield. $140,000 taxable ($105,000 basis), $360,000 tax-deferred, $70,000
//   Roth ($45,000 reachable), $25,000 in an HSA, saving $18,000, $24,000 and $8,000.
//   An $11,000 benchmark at 50, Social Security of $30,000 and $18,000 from each's 67.

import { describe, expect, test } from 'bun:test';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import type { PlanItem } from '@/lib/fire/items';
import { DEFAULT_PLAN, type Measured } from '@/lib/fire/plan';
import { detailWork, type DetailedInput, type PlanDetail } from '@/lib/fire/plan-detail';
import { planFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { historicalCycles } from '@/lib/fire/simulate';
import { taxedPaths } from '@/lib/fire/taxed-paths';
import { lawFor } from '@/lib/fire/tax/law';
import { usMarket } from '@/lib/fire/us-market';
import { ON } from './plan-gen';
import { NO_STRATEGY, type Strategy } from '@/lib/fire/tax/rules';
import { compareRows, conversionRun } from '@/lib/fire/compare-conversions';
import { convertedIn } from '@/components/plan-conversions';

const account = (bucket: string, value: number, basis: number | null = null) => ({ owner: 'you', value, basis, account_id: bucket, bucket });
const group = (bucket: string, value: number, basis: number | null = null) => ({ bucket, accounts: [account(bucket, value, basis)], total: value });
const BUCKETS = {
  groups: [group('taxable', 140_000, 105_000), group('tax-deferred', 360_000), group('roth', 70_000), group('hsa', 25_000)],
  roth: [{ owner: 'you', amount: 45_000 }],
  total: 595_000,
} as unknown as Pick<BucketsToday, 'groups' | 'roth' | 'total'>;

const social = (id: string, owner: 'you' | 'partner', age: number, yearly: number): PlanItem => ({ id, label: id, kind: 'social-security', from: { anchor: { at: 'age', age }, offset: 0 }, until: null, once: null, yearly, replaces: null, every: null, times: null, inflationAdjusted: true, owner, beforeTax: true });

const PLAN: FirePlanV2 = {
  ...planOf({ ...DEFAULT_PLAN, age: 41, targetAge: 50, spending: 64_000, savings: 50_000, assets: 595_000, realReturn: 0.05, withdrawalRate: 0.04, fee: 0.001, stocksPct: 75, bondsPct: 25, rebalance: 'annual', rule: 'constant' }),
  partnerAge: 40,
  start: 'at-stop',
  // The partner's 67 is your 68.
  items: [social('you', 'you', 67, 30_000), social('partner', 'partner', 68, 18_000)],
};
const M: Measured = { spending: null, savings: null, assets: null };

function run(growth: number, incomeGrowth: number) {
  const input: DetailedInput = {
    calendarYear: 2026,
    filing: 'joint',
    dependents: [],
    rmdAges: { you: 75, partner: 75 },
    buckets: BUCKETS,
    savingsSplit: [
      { bucket: 'taxable', share: 18 / 50 },
      { bucket: 'tax-deferred', share: 24 / 50 },
      { bucket: 'roth', share: 8 / 50 },
    ],
    share457: { you: 0, partner: 0 },
    inflation: 0.03,
    taxableYield: 0.02,
    health: { coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth, incomeGrowth },
    state: 'NV',
    stateRate: 0,
    paidToday: 0,
    strategy: NO_STRATEGY,
    law: lawFor(2026).law,
    lawYear: { year: 2026, behind: false },
  };
  const f = planFigures(PLAN, M, { count: ON, detailed: detailWork(input) });
  if ('refused' in f || !('sim' in f.engine) || f.detail === null || 'failed' in f.detail) throw new Error('no drawdown');
  const d: PlanDetail = f.detail;
  const history = historicalCycles(f.engine.sim, usMarket(), { taxed: taxedPaths });
  return {
    start: Math.round(f.engine.sim.startBalance),
    rate: Number((f.engine.rate * 100).toFixed(2)),
    t: Number((d.start.t * 100).toFixed(2)),
    h: Math.round(d.start.h),
    historical: Number((history.successRate * 100).toFixed(1)),
    left: Math.round(d.start.leftAtEnd),
    taxAndHealth: Math.round(d.start.taxAndHealth),
    rounds: d.start.rounds,
  };
}

function rules(growth: number, incomeGrowth: number) {
  const input: DetailedInput = {
    calendarYear: 2026,
    filing: 'joint',
    dependents: [],
    rmdAges: { you: 75, partner: 75 },
    buckets: BUCKETS,
    savingsSplit: [
      { bucket: 'taxable', share: 18 / 50 },
      { bucket: 'tax-deferred', share: 24 / 50 },
      { bucket: 'roth', share: 8 / 50 },
    ],
    share457: { you: 0, partner: 0 },
    inflation: 0.03,
    taxableYield: 0.02,
    health: { coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth, incomeGrowth },
    state: 'NV',
    stateRate: 0,
    paidToday: 0,
    strategy: NO_STRATEGY,
    law: lawFor(2026).law,
    lawYear: { year: 2026, behind: false },
  };
  const f = planFigures(PLAN, M, { count: ON, detailed: detailWork(input) });
  if ('refused' in f) throw new Error('refused');
  const row = (strategy: Strategy) => {
    const shown = planFigures(PLAN, M, { count: ON, detailed: detailWork({ ...input, strategy }) });
    if ('refused' in shown || shown.shares === null) throw new Error('no shares');
    const d = conversionRun(f, { ...input, strategy }, strategy);
    if (d === null) throw new Error('no run');
    return {
      fi: Math.round(shown.view.fiNumber as number),
      t: Number((shown.shares.t * 100).toFixed(1)),
      h: Math.round(shown.shares.h),
      left: Math.round(d.leftAtEnd),
      taxAndHealth: Math.round(d.taxAndHealth),
      converted: Math.round(convertedIn(d)),
      credit: `${d.aca.withCredit} of ${d.aca.on}`,
      short: d.runsOutAt,
    };
  };
  return Object.fromEntries(compareRows(f, input).map((r) => [r.key, row(r.strategy)]));
}

describe('the prototype’s household, through the build', () => {
  test('at the law’s health growth, 2.1 and 1.1 points', () => {
    expect(run(0.021, 0.011)).toEqual({ start: 1_474_369, rate: 5.17, t: 5.28, h: 8_250, historical: 82.2, left: 3_126_746, taxAndHealth: 720_330, rounds: 1 });
  });
  // From the plan's own start, as Compare has them, and each rule's own FI number. The
  // order the prototype found holds: the ACA rule leaves the most, with a credit every
  // year; a bracket from 12% up gives the credit up and runs low or short.
  test('every rule Compare sets side by side, at the law’s health growth', () => {
    expect(rules(0.021, 0.011)).toEqual({
      none: { fi: 1_944_199, t: 8.2, h: 7_391, left: 3_126_746, taxAndHealth: 720_330, converted: 0, credit: '13 of 16', short: null },
      'fill-10': { fi: 2_113_857, t: 5.1, h: 16_242, left: 2_679_089, taxAndHealth: 640_234, converted: 623_516, credit: '11 of 16', short: null },
      'fill-12': { fi: 2_547_742, t: 10.3, h: 27_413, left: 58_871, taxAndHealth: 1_048_118, converted: 954_014, credit: '1 of 16', short: null },
      'fill-22': { fi: 2_648_968, t: 15.2, h: 25_853, left: 0, taxAndHealth: 1_140_589, converted: 877_832, credit: '1 of 16', short: 79 },
      'aca-12': { fi: 1_956_283, t: 5.3, h: 10_104, left: 3_244_721, taxAndHealth: 573_380, converted: 715_082, credit: '16 of 16', short: null },
    });
  });
  test('every rule, at the prototype’s health growth', () => {
    expect(rules(0.015, 0.01)).toEqual({
      none: { fi: 1_909_956, t: 8.1, h: 6_210, left: 3_314_950, taxAndHealth: 645_914, converted: 0, credit: '13 of 16', short: null },
      'fill-10': { fi: 2_067_500, t: 5, h: 14_565, left: 2_953_508, taxAndHealth: 549_432, converted: 623_430, credit: '11 of 16', short: null },
      'fill-12': { fi: 2_460_706, t: 10.1, h: 24_487, left: 557_927, taxAndHealth: 917_969, converted: 954_034, credit: '1 of 16', short: null },
      'fill-22': { fi: 2_608_697, t: 15.2, h: 24_487, left: 0, taxAndHealth: 1_010_369, converted: 877_834, credit: '1 of 16', short: 88 },
      'aca-12': { fi: 1_921_414, t: 5.2, h: 8_860, left: 3_458_423, taxAndHealth: 491_473, converted: 720_661, credit: '16 of 16', short: null },
    });
  });
  test('at the prototype’s, 1.5 and 1', () => {
    // The start is the prototype's to the dollar. It had 81.1% with no conversions, at
    // a flat rate and before D6, a household over the work rule's income meeting it.
    expect(run(0.015, 0.01)).toEqual({ start: 1_474_369, rate: 5.09, t: 5.36, h: 7_039, historical: 84.3, left: 3_314_950, taxAndHealth: 645_914, rounds: 1 });
  });
});
