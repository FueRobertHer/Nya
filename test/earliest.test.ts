// D9's earliest stop that lasts (lib/fire/earliest.ts) on the tax plan's prototype
// household (test/drawdown-prototype.test.ts): a couple, 41 and 40, $64,000 a year,
// stopping at 50, Social Security of $30,000 from 67 and $18,000 from the partner's 68.
// Decision 25's answer is around 54; a stop at 50 lasts in 82% of historical starts,
// at 51 in 95%.

import { describe, expect, test } from 'bun:test';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import { earliestStop, type EarliestAnswer } from '@/lib/fire/earliest';
import type { PlanItem } from '@/lib/fire/items';
import { DEFAULT_PLAN, type Measured } from '@/lib/fire/plan';
import { detailWork, type DetailedInput } from '@/lib/fire/plan-detail';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { simulate, type Method } from '@/lib/fire/simulate';
import { taxedPaths } from '@/lib/fire/taxed-paths';
import { lawFor } from '@/lib/fire/tax/law';
import { NO_STRATEGY } from '@/lib/fire/tax/rules';
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
  items: [social('you', 'you', 67, 30_000), social('partner', 'partner', 68, 18_000)],
  lastsIn: 0.9,
};
const M: Measured = { spending: null, savings: null, assets: null };
const INPUT: DetailedInput = {
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
  health: { coverage: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
  state: 'NV',
  stateRate: 0,
  paidToday: 0,
  strategy: NO_STRATEGY,
  law: lawFor(2026).law,
  lawYear: { year: 2026, behind: false },
};
const WITH_TAX = { taxed: taxedPaths };
const detailed = detailWork(INPUT);

const solve = (plan: FirePlanV2, method: Method = 'historical', flat = false): EarliestAnswer => {
  const r = earliestStop({ plan, measured: M, count: ON, detailed: flat ? null : detailed, method }, usMarket(), WITH_TAX);
  if (!('age' in r)) throw new Error(`no answer: ${JSON.stringify(r)}`);
  return r;
};

/** Will it last?'s full share for a stop at k, as the plan would run it. */
const fullAt = (plan: FirePlanV2, k: number, method: Method = 'historical', flat = false) => {
  const f = planFigures({ ...plan, stopAtFi: true, start: 'at-stop' }, M, { count: ON, detailed: flat ? null : detailed, fiAt: k }) as PlanFigures;
  if (!('sim' in f.engine)) throw new Error('no sim');
  return simulate(method, f.engine.sim, usMarket(), WITH_TAX).successRate;
};

describe('the earliest stop that lasts', () => {
  test('at 90% of historical starts: 51, whose full run lasts while 50’s falls short', () => {
    const r = solve(PLAN);
    expect(r.age).toBe(51);
    expect(r.share).toBeGreaterThanOrEqual(0.9);
    expect(fullAt(PLAN, 50)).toBeLessThan(0.9);
    expect(r.to).toBe(95);
  }, 60_000);

  test('at 80%, 50; at 95%, 51 or later, never earlier than at 90%', () => {
    expect(solve({ ...PLAN, lastsIn: 0.8 }).age).toBe(50);
    const at95 = solve({ ...PLAN, lastsIn: 0.95 });
    expect(at95.age).toBeGreaterThanOrEqual(51);
    expect(at95.share).toBeGreaterThanOrEqual(0.95);
    expect(fullAt(PLAN, (at95.age as number) - 1)).toBeLessThan(0.95);
  }, 60_000);

  test('by Monte Carlo, the same rule on its own runs', () => {
    const r = solve(PLAN, 'monte-carlo');
    expect(r.age).not.toBeNull();
    expect(r.share).toBeGreaterThanOrEqual(0.9);
    expect(fullAt(PLAN, (r.age as number) - 1, 'monte-carlo')).toBeLessThan(0.9);
  }, 60_000);

  test('the typed stop stays typed; under the stop at FI it is the age found', () => {
    const typed = solve(PLAN);
    expect([typed.resolution.stop, typed.resolution.fi, typed.resolution.searched]).toEqual([50, 51, 'lasts']);
    const f = planFigures(PLAN, M, { count: ON, detailed, resolved: typed.resolution }) as PlanFigures;
    expect([f.view.fiAge, f.view.yearsToFi, f.view.stopAge]).toEqual([51, 10, 50]);
    const atFi = solve({ ...PLAN, stopAtFi: true });
    expect([atFi.age, atFi.resolution.stop]).toEqual([51, 51]);
    const g = planFigures({ ...PLAN, stopAtFi: true }, M, { count: ON, detailed, resolved: atFi.resolution }) as PlanFigures;
    expect([g.view.fiAge, g.view.stopAge]).toEqual([51, 51]);
    // Will it last? at that stop is the run that was found to last.
    if (!('sim' in g.engine)) throw new Error('no sim');
    expect(simulate('historical', g.engine.sim, usMarket(), WITH_TAX).successRate).toBe(atFi.share as number);
  }, 60_000);

  test('what is timed on FI starts at the age found', () => {
    const trip: PlanItem = { id: 'trip', label: 'A trip', kind: 'one-off', from: { anchor: { at: 'fi' }, offset: 0 }, until: null, once: 10_000, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: 'you', beforeTax: false } as unknown as PlanItem;
    const r = solve({ ...PLAN, items: [...PLAN.items, trip] });
    expect(r.resolution.ages[2]).toEqual({ start: r.age as number, end: null });
  }, 60_000);

  test('in the flat model', () => {
    const plan = { ...PLAN, taxRate: 0.1 };
    const r = solve(plan, 'historical', true);
    expect(r.age).not.toBeNull();
    expect(fullAt(plan, r.age as number, 'historical', true)).toBeGreaterThanOrEqual(0.9);
    expect(fullAt(plan, (r.age as number) - 1, 'historical', true)).toBeLessThan(0.9);
  }, 60_000);

  test('a stop today that lasts is today; none by 95 is none', () => {
    expect(solve({ ...PLAN, assets: 5_000_000 }, 'historical', true).age).toBe(41);
    const none = solve({ ...PLAN, spending: 20_000_000, savings: 0 }, 'historical', true);
    expect([none.age, none.share, none.resolution.fi]).toEqual([null, null, null]);
    const f = planFigures({ ...PLAN, spending: 20_000_000, savings: 0 }, M, { count: ON, resolved: none.resolution }) as PlanFigures;
    expect(f.view.yearsToFi).toBe(Infinity);
  }, 60_000);

  test('a stop with nothing to draw doesn’t last, and the search goes on past it', () => {
    const cost = (age: number, once: number): PlanItem => ({ id: `cost-${age}`, label: 'A cost', kind: 'one-off', from: { anchor: { at: 'age', age }, offset: 0 }, until: null, once, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: 'you', beforeTax: false }) as unknown as PlanItem;
    // A cost at 60 the walk can't pay: from then on there is nothing to stop with.
    const short = solve({ ...PLAN, taxRate: 0.1, items: [...PLAN.items, cost(60, 5_000_000)] }, 'historical', true);
    expect([short.age, short.share]).toEqual([null, null]);
    // Nothing invested at 66, Social Security from 67: a stop at 66 has nothing to
    // draw, and one at 67 lasts.
    const late = solve({ ...PLAN, age: 66, partnerAge: null, targetAge: 67, assets: 0, savings: 20_000, spending: 30_000, taxRate: 0.1, items: [social('you', 'you', 67, 40_000)] }, 'historical', true);
    expect(late.age).toBe(67);
  }, 60_000);
});
