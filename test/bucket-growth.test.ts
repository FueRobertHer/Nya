// Each tax bucket at its accounts' own rates, and the taxable accounts at their
// own yield, in the detailed model (lib/fire/bucket-growth.ts, read by
// lib/fire/plan-detail.ts, lib/fire/tax/mix.ts and lib/fire/tax/year.ts): the
// rates and the yield, the mix holding the walk's total while its shares move,
// each year's buckets following their own rates, and nothing moving at all with
// no account at a rate of its own, or with one at the plan's own.

import { describe, expect, test } from 'bun:test';
import { bucketGrowth, planYield } from '@/lib/fire/bucket-growth';
import { planGrowth } from '@/lib/fire/account-growth';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import { walkPath, type WalkChanges } from '@/lib/fire/events';
import { DEFAULT_PLAN, type AccountRate, type Measured } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { detailWork, type DetailedInput, type PlanDetail } from '@/lib/fire/plan-detail';
import { planPath } from '@/lib/fire/path';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { mixToday, projectMix, taxedMix, type TaxedWalk } from '@/lib/fire/tax/mix';
import { lawFor } from '@/lib/fire/tax/law';
import { NO_STRATEGY } from '@/lib/fire/tax/rules';
import type { DrawdownYear } from '@/lib/fire/drawdown';
import { ON } from './plan-gen';

const rate = (account_id: string, growth: number | null, yieldRate: number | null = null): AccountRate => ({ account_id, growth, yield: yieldRate });
type Acct = { account_id: string; value: number; subtype?: string; income?: number | null; basis?: number | null };
const acct = ({ account_id, value, subtype = 'x', income = null, basis = null }: Acct) => ({ account_id, owner: 'you', value, subtype, income, basis, yieldRate: income === null ? null : income / value });
const group = (bucket: string, ...accounts: Acct[]) => ({ bucket, accounts: accounts.map((a) => ({ ...acct(a), bucket })), total: accounts.reduce((s, a) => s + a.value, 0) });
const groupsOf = (...g: ReturnType<typeof group>[]) => g as unknown as BucketsToday['groups'];

const WIDE = groupsOf(
  group('taxable', { account_id: 'brk', value: 140_000 }),
  group('tax-deferred', { account_id: 'k', value: 260_000 }, { account_id: 'g', value: 40_000, subtype: '457b' }),
  group('unclassified', { account_id: 'o', value: 10_000 }),
  group('roth', { account_id: 'r', value: 50_000 }),
  group('hsa', { account_id: 'h', value: 25_000 }),
  group('education', { account_id: 'c', value: 48_000 })
);
const PLAN = { realReturn: 0.05 };

describe('each bucket’s rate', () => {
  test('none with no account above zero at its own', () => {
    expect(bucketGrowth(PLAN, WIDE)).toBeNull();
    expect(bucketGrowth({ ...PLAN, accounts: [rate('gone', 0.08), rate('brk', null, 0.02)] }, WIDE)).toBeNull();
    expect(bucketGrowth({ ...PLAN, accounts: [rate('z', 0.08)] }, groupsOf(group('taxable', { account_id: 'z', value: 0 }), group('roth', { account_id: 'r', value: 10 })))).toBeNull();
  });

  test('each bucket its accounts’ blend; a 457(b) apart only from the stop on; a child’s account as the mix and the year count it', () => {
    const g = bucketGrowth({ ...PLAN, accounts: [rate('brk', 0.07), rate('g', 0.03), rate('c', 0.02)] }, WIDE)!;
    expect(g.mix.taxable).toBe(0.07);
    expect(g.mix['tax-deferred']).toBeCloseTo(0.05 + (40_000 * -0.02) / 310_000, 15);
    expect(g.mix.education).toBe(0.02);
    // Without an account at its own, the plan's own, to the bit.
    expect(g.mix.roth).toBe(0.05);
    expect(g.mix.hsa).toBe(0.05);
    expect(g.year).toEqual({ taxable: 0.07, deferred: expect.any(Number), deferred457: 0.03, roth: 0.05, hsa: 0.05 });
    expect(g.year.deferred).toBeCloseTo(0.05 + (48_000 * -0.03) / 318_000, 15);
  });

  test('a counted child’s account from the stop on: shared with the 457(b) as the year shares it', () => {
    const groups = groupsOf(group('tax-deferred', { account_id: 'k', value: 260_000 }, { account_id: 'g', value: 40_000, subtype: '457b' }), group('education', { account_id: 'c', value: 100_000 }));
    const share457 = { you: 40_000 / 300_000, partner: 0 };
    const g = bucketGrowth({ ...PLAN, accounts: [rate('g', 0.09), rate('c', 0.01)] }, groups, share457)!;
    // The year's two pools, as lib/fire/tax/mix.ts peopleOf makes them of the
    // tax-deferred and education slots.
    const in457 = (300_000 + 100_000) * share457.you;
    const deferred = 400_000 - in457;
    expect(deferred * g.year.deferred! + in457 * g.year.deferred457!).toBeCloseTo(260_000 * 0.05 + 40_000 * 0.09 + 100_000 * 0.01, 6);
    // With no share in a 457(b), none of it is with the 457(b), which stays at its own.
    expect(bucketGrowth({ ...PLAN, accounts: [rate('g', 0.09), rate('c', 0.01)] }, groups)!.year.deferred457).toBe(0.09);
  });

  test('a bucket with no account isn’t said: it grows at the blend', () => {
    const g = bucketGrowth({ ...PLAN, accounts: [rate('brk', 0.07)] }, groupsOf(group('taxable', { account_id: 'brk', value: 100 })))!;
    expect(g.mix).toEqual({ taxable: 0.07 });
    expect(g.year).toEqual({ taxable: 0.07 });
  });

  test('today’s buckets at their rates come to the plan’s blend', () => {
    const accounts = [rate('brk', 0.07), rate('g', 0.03), rate('c', 0.02), rate('h', 0.11)];
    const g = bucketGrowth({ ...PLAN, accounts }, WIDE)!;
    const totals = new Map<string, number>();
    for (const x of WIDE) {
      const b = x.bucket === 'unclassified' ? 'tax-deferred' : x.bucket;
      totals.set(b, (totals.get(b) ?? 0) + x.total);
    }
    let sum = 0;
    let weighted = 0;
    for (const [b, t] of totals) {
      sum += t;
      weighted += t * (g.mix[b as keyof typeof g.mix] as number);
    }
    const measured: Measured = { spending: null, savings: null, assets: sum, accounts: WIDE.flatMap((x) => x.accounts.map((a) => ({ id: a.account_id, value: a.value }))) };
    expect(weighted / sum).toBeCloseTo(planGrowth({ ...PLAN, assets: null, accounts }, measured).growth, 14);
  });
});

describe('the taxable yield', () => {
  const TAXABLE = groupsOf(
    group('taxable', { account_id: 'a', value: 100_000 }, { account_id: 'b', value: 50_000, income: 1_000 }, { account_id: 'c', value: 50_000 }),
    group('roth', { account_id: 'r', value: 80_000 })
  );

  test('with no taxable account at its own, the figure itself', () => {
    expect(planYield({}, TAXABLE, 0.017, null)).toBe(0.017);
    expect(planYield({ accounts: [rate('a', 0.07), rate('r', null, 0.05)] }, TAXABLE, 0.017, null)).toBe(0.017);
  });

  test('its own first, then what each paid, then the figure', () => {
    // a at its own 4%, b at what it paid (2%), c at the figure.
    expect(planYield({ accounts: [rate('a', null, 0.04)] }, TAXABLE, 0.015, null)).toBeCloseTo((100_000 * 0.04 + 50_000 * 0.02 + 50_000 * 0.015) / 200_000, 15);
  });

  test('a yield typed in Assumptions is every other account’s', () => {
    expect(planYield({ accounts: [rate('a', null, 0.04)] }, TAXABLE, 0.01, 0.01)).toBeCloseTo((100_000 * 0.04 + 100_000 * 0.01) / 200_000, 15);
  });
});

describe('the mix before the stop', () => {
  const NO_WALK: WalkChanges = { moneyIn: [], costs: [], spans: [] };
  const today = mixToday({ groups: groupsOf(group('taxable', { account_id: 't', value: 300_000, basis: 200_000 }), group('tax-deferred', { account_id: 'd', value: 500_000 })), roth: [], total: 800_000 }, 800_000);
  const split = [{ bucket: 'tax-deferred' as const, owner: 'you' as const, share: 1 }];
  const WALK: WalkChanges = { moneyIn: [{ year: 2, amount: 50_000 }], costs: [{ year: 4, amount: 120_000 }], spans: [{ from: 6, to: 8, delta: -60_000 }] };
  const args = { savings: 30_000, split, realReturn: 0.05, inflation: 0.03, years: 10 };

  test('the total is the walk’s every year, and the faster bucket gains its share', () => {
    for (const walk of [NO_WALK, WALK]) {
      for (let years = 1; years <= 10; years++) {
        const apart = projectMix(today, { ...args, walk, years, bucketGrowth: { taxable: 0.09, 'tax-deferred': 0.026 } })!;
        const together = projectMix(today, { ...args, walk, years })!;
        const walked = walkPath(800_000, 30_000, 0.05, walk, years).balances[years];
        expect(apart.total).toBeCloseTo(walked, 4);
        expect(together.total).toBeCloseTo(walked, 4);
        const share = (m: typeof apart) => m.slots.find((s) => s.bucket === 'taxable')!.value / m.total;
        expect(share(apart)).toBeGreaterThan(share(together));
        // A basis isn't scaled with the shares (a sale takes basis with value, so only without one).
        if (walk === NO_WALK) expect(apart.slots.find((s) => s.bucket === 'taxable')!.basis).toBeCloseTo(together.slots.find((s) => s.bucket === 'taxable')!.basis, 4);
      }
    }
  });

  test('a year that sells moves a basis by what it sells, not by the shares drifting', () => {
    const TAXED: TaxedWalk = { today: { age: 40, partnerAge: null, calendarYear: 2026 }, filing: 'single', rmdAges: { you: 75, partner: 75 }, share457: { you: 0, partner: 0 }, state: null, stateRate: 0, law: lawFor(2026).law };
    const walk: WalkChanges = { moneyIn: [], costs: [{ year: 0, amount: 250_000 }], spans: [] };
    const apart = taxedMix(today, { ...args, walk, years: 1, bucketGrowth: { taxable: 0.09, 'tax-deferred': 0.026 } }, TAXED);
    const together = taxedMix(today, { ...args, walk, years: 1 }, TAXED);
    expect(together.taxes.length).toBe(1);
    expect(apart.taxes).toEqual(together.taxes);
    expect(apart.mix!.total).toBeCloseTo(together.mix!.total, 4);
    const taxable = (m: typeof apart) => m.mix!.slots.find((s) => s.bucket === 'taxable')!;
    expect(taxable(apart).value / apart.mix!.total).toBeGreaterThan(taxable(together).value / together.mix!.total);
    expect(taxable(apart).basis).toBeCloseTo(taxable(together).basis, 4);
  });

  test('a cost the walk can’t pay stops it, as the walk does', () => {
    const walk: WalkChanges = { moneyIn: [], costs: [{ year: 1, amount: 2_000_000 }], spans: [] };
    expect(projectMix(today, { ...args, walk, years: 3, bucketGrowth: { taxable: 0.09 } })).toBeNull();
  });

  test('every bucket at the plan’s rate: the same mix, to the bit', () => {
    expect(projectMix(today, { ...args, walk: WALK, bucketGrowth: { taxable: 0.05, 'tax-deferred': 0.05 } })).toEqual(projectMix(today, { ...args, walk: WALK }));
  });
});

describe('a plan’s detailed figures', () => {
  const account = (account_id: string, value: number, basis: number | null = null) => ({ owner: 'you', value, basis, account_id, bucket: account_id, income: null, subtype: 'x' });
  const grp = (bucket: string, ...accounts: ReturnType<typeof account>[]) => ({ bucket, accounts, total: accounts.reduce((s, a) => s + a.value, 0) });
  const BUCKETS = {
    groups: [grp('taxable', account('taxable', 300_000, 150_000)), grp('tax-deferred', account('tax-deferred', 500_000)), grp('roth', account('roth', 200_000))],
    roth: [{ owner: 'you', amount: 80_000 }],
    total: 1_000_000,
  } as unknown as Pick<BucketsToday, 'groups' | 'roth' | 'total'>;
  const input: DetailedInput = {
    calendarYear: 2026,
    filing: 'single',
    dependents: [],
    rmdAges: { you: 75, partner: 75 },
    buckets: BUCKETS,
    savingsSplit: [{ bucket: 'taxable', share: 1 }],
    share457: { you: 0, partner: 0 },
    inflation: 0.03,
    taxableYield: 0,
    health: { coverage: { kind: 'other', yearly: 6_000 }, medicareExtra: 0, meetsRule: [], countMedicaid: false, acaLaw: '2026', growth: 0.021, incomeGrowth: 0.011 },
    state: null,
    stateRate: 0,
    paidToday: 0,
    strategy: NO_STRATEGY,
    law: lawFor(2026).law,
    lawYear: { year: 2026, behind: false },
  };
  const work = detailWork(input);
  const M: Measured = { spending: null, savings: null, assets: 1_000_000, accounts: [{ id: 'taxable', value: 300_000 }, { id: 'tax-deferred', value: 500_000 }, { id: 'roth', value: 200_000 }] };
  const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...planOf({ ...DEFAULT_PLAN, age: 45, targetAge: 55, spending: 60_000, savings: 40_000, assets: null, realReturn: 0.05, withdrawalRate: 0.04 }), ...over });
  const figures = (p: FirePlanV2): PlanFigures => {
    const f = planFigures(p, M, { count: ON, detailed: work });
    if ('refused' in f) throw new Error('refused');
    return f;
  };
  const detailOf = (f: PlanFigures): PlanDetail => {
    if (f.detail === null || 'failed' in f.detail) throw new Error(`no detail: ${JSON.stringify(f.detail)}`);
    return f.detail;
  };
  const total = (b: { taxable: number; deferred: number; roth: number; hsa: number }) => b.taxable + b.deferred + b.roth + b.hsa;
  /** A year whose buckets each follow their own rate. */
  function holdsApart(y: DrawdownYear, g: { taxable: number; deferred: number; roth: number; hsa: number }, taxableYield: number) {
    const d = y.drawn;
    expect(y.end.taxable).toBeCloseTo((y.start.taxable - d.taxable + y.surplus) * (1 + g.taxable - taxableYield), 4);
    expect(y.end.deferred).toBeCloseTo((y.start.deferred - y.rmd - d.deferred - d.deferred457 - d.penalized) * (1 + g.deferred), 4);
    expect(y.end.roth).toBeCloseTo((y.start.roth - d.roth - d.young - d.earnings) * (1 + g.roth), 4);
    expect(y.end.hsa).toBeCloseTo((y.start.hsa - d.hsaPremiums - d.hsaTaxed - d.hsaEarly) * (1 + g.hsa), 4);
  }

  test('an account at the plan’s own rate moves nothing', () => {
    const none = figures(plan());
    const same = figures(plan({ accounts: [rate('taxable', 0.05)] }));
    expect(same.view.ownRates).toBe(1);
    expect(detailOf(same)).toEqual(detailOf(none));
    expect(same.walk).toEqual(none.walk);
  });

  test('from the stop each bucket grows at its own; before it the total is the walk’s', () => {
    const f = figures(plan({ start: 'at-stop', accounts: [rate('taxable', 0.08), rate('roth', 0.06)] }));
    const d = detailOf(f);
    const g = { taxable: 0.08, deferred: 0.05, roth: 0.06, hsa: f.view.growth };
    for (const y of d.start.years) holdsApart(y, g, 0);
    const p = planPath(f)!;
    expect(total(d.start.years[0].start)).toBeCloseTo(p.points[p.points.length - 1].balance, 4);
    // Each copy runs at its own: the same page's work, another plan's rates.
    const other = detailOf(figures(plan({ start: 'at-stop', accounts: [rate('taxable', 0.03)] })));
    expect(other.start.years[0].start.taxable).not.toBeCloseTo(d.start.years[0].start.taxable, 0);
  });

  test('a year before the stop that sells is taxed on the mix the rates gave it', () => {
    // The blend stays the plan's 5%: taxable ahead, tax-deferred behind.
    const accounts = [rate('taxable', 0.09), rate('tax-deferred', 0.026)];
    const cost = [{ id: 'c', label: 'Roof', kind: 'one-off' as const, from: { anchor: { at: 'age' as const, age: 52 }, offset: 0 }, until: null, once: 700_000, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false }];
    const apart = figures(plan({ accounts, items: cost }));
    const together = figures(plan({ items: cost }));
    expect(apart.view.growth).toBeCloseTo(together.view.growth, 12);
    expect(together.walk.taxes?.length).toBeGreaterThan(0);
    expect(apart.walk.taxes).not.toEqual(together.walk.taxes);
  });

  test('the taxable accounts at their own yield, but with invested assets typed', () => {
    const own = detailOf(figures(plan({ start: 'at-stop', accounts: [rate('taxable', null, 0.03)] })));
    const y = own.start.years[0];
    expect(y.income.yield).toBeCloseTo(y.start.taxable * 0.03, 4);
    holdsApart(y, { taxable: 0.05, deferred: 0.05, roth: 0.05, hsa: 0.05 }, 0.03);
    const typed = detailOf(figures(plan({ start: 'at-stop', assets: 1_000_000, accounts: [rate('taxable', 0.08, 0.03)] })));
    expect(typed.start.years[0].income.yield).toBe(0);
    expect(typed).toEqual(detailOf(figures(plan({ start: 'at-stop', assets: 1_000_000 }))));
  });
});
