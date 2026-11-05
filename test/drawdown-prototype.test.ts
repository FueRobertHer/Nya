// The tax plan's household (Overview: "What the prototype found"), run through the
// build rather than the prototype: the drawdown, the bridge and the engine, under
// D6's work rule by household income, with no conversions, which T4 brings. These
// figures go into Overview. Pinned, so a change to any of the three shows here.
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
import { lawFor } from '@/lib/fire/tax/law';
import { usMarket } from '@/lib/fire/us-market';
import { ON } from './plan-gen';

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
    split: () => [
      { bucket: 'taxable', owner: 'you', share: 18 / 50 },
      { bucket: 'tax-deferred', owner: 'you', share: 24 / 50 },
      { bucket: 'roth', owner: 'you', share: 8 / 50 },
    ],
    share457: { you: 0, partner: 0 },
    inflation: 0.03,
    taxableYield: 0.02,
    health: { coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth, incomeGrowth },
    state: 'NV',
    stateRate: 0,
    paidToday: 0,
    law: lawFor(2026).law,
    lawYear: { year: 2026, behind: false },
  };
  const f = planFigures(PLAN, M, { count: ON, detailed: detailWork(input) });
  if ('refused' in f || !('sim' in f.engine) || f.detail === null || 'failed' in f.detail) throw new Error('no drawdown');
  const d: PlanDetail = f.detail;
  const history = historicalCycles(f.engine.sim, usMarket());
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

describe('the prototype’s household, through the build', () => {
  test('at the law’s health growth, 2.1 and 1.1 points', () => {
    expect(run(0.021, 0.011)).toEqual({ start: 1_474_369, rate: 5.17, t: 5.28, h: 8_250, historical: 84.6, left: 3_126_746, taxAndHealth: 720_330, rounds: 1 });
  });
  test('at the prototype’s, 1.5 and 1', () => {
    // The start is the prototype's to the dollar. It had 81.1% with no conversions:
    // the 5.4 points are D6, a household over the work rule's income meeting it.
    expect(run(0.015, 0.01)).toEqual({ start: 1_474_369, rate: 5.09, t: 5.36, h: 7_039, historical: 86.5, left: 3_314_950, taxAndHealth: 645_914, rounds: 1 });
  });
});
