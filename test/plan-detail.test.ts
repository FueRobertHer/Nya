// One plan's figures in the detailed tax model (lib/fire/plan-detail.ts, read by
// lib/fire/plan-figures.ts): the drawdowns, the walk's tax, and the FI number's own
// run, whose tax and health go in that number.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLAN, type Measured } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { detailWork, type DetailedInput, type PlanDetail } from '@/lib/fire/plan-detail';
import { planPath } from '@/lib/fire/path';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import type { PlanItem } from '@/lib/fire/items';
import { lawFor } from '@/lib/fire/tax/law';
import { NO_STRATEGY } from '@/lib/fire/tax/rules';
import { genEvents, genMeasured, genPlan, itemFromEvent, ON, rand } from './plan-gen';

const account = (bucket: string, value: number, basis: number | null = null) => ({ owner: 'you', value, basis, account_id: bucket, bucket });
const group = (bucket: string, ...accounts: ReturnType<typeof account>[]) => ({ bucket, accounts, total: accounts.reduce((s, a) => s + a.value, 0) });
const BUCKETS = {
  groups: [group('taxable', account('taxable', 300_000, 150_000)), group('tax-deferred', account('tax-deferred', 500_000)), group('roth', account('roth', 200_000))],
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

const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...planOf({ ...DEFAULT_PLAN, age: 45, targetAge: 55, spending: 60_000, savings: 40_000, assets: 1_000_000, realReturn: 0.05, withdrawalRate: 0.04 }), ...over });
const M: Measured = { spending: null, savings: null, assets: null };

function figures(p: FirePlanV2, opts: { detailed?: boolean; m?: Measured } = {}): PlanFigures {
  const f = planFigures(p, opts.m ?? M, { count: ON, detailed: opts.detailed === false ? null : work });
  if ('refused' in f) throw new Error('refused');
  return f;
}
const detailOf = (f: PlanFigures): PlanDetail => {
  if (f.detail === null || 'failed' in f.detail) throw new Error(`no detail: ${JSON.stringify(f.detail)}`);
  return f.detail;
};
const total = (b: { taxable: number; deferred: number; roth: number; hsa: number }) => b.taxable + b.deferred + b.roth + b.hsa;

const when = (age: number) => ({ anchor: { at: 'age' as const, age }, offset: 0 });
const item = (over: Partial<PlanItem> & Pick<PlanItem, 'kind'>): PlanItem => ({ id: 'x', label: 'x', from: when(50), until: null, once: null, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false, ...over });

describe('the two drawdowns', () => {
  test('from the FI number: `start` from it, `whole` from what the walk has at the stop', () => {
    const f = figures(plan());
    const d = detailOf(f);
    expect(d.startAge).toBe(55);
    expect(total(d.start.years[0].start)).toBeCloseTo(f.view.fiNumber as number, 6);
    const p = planPath(f)!;
    const last = p.points[p.points.length - 1];
    expect(total(d.whole!.years[0].start)).toBeCloseTo(last.balance, 6);
    expect(d.whole).not.toBe(d.start);
  });

  test('from what you’d have at the stop: the same run', () => {
    const d = detailOf(figures(plan({ start: 'at-stop' })));
    expect(d.whole).toBe(d.start);
  });

  test('both end at the plan’s end, whichever age they start at', () => {
    const d = detailOf(figures(plan({ start: 'assets' })));
    expect(d.startAge).toBe(45);
    expect(d.start.years[d.start.years.length - 1].age).toBe(94);
    expect(d.whole!.years[0].age).toBe(55);
    expect(d.whole!.years[d.whole!.years.length - 1].age).toBe(94);
  });

  test('once the stop has come, the years run from today, on today’s mix', () => {
    const f = figures(plan({ age: 60, targetAge: 55, assets: 1_000_000, start: 'custom', startBalance: 900_000 }));
    const d = detailOf(f);
    expect(d.startAge).toBe(60);
    expect(d.start.years[0].age).toBe(60);
    expect(total(d.start.years[0].start)).toBeCloseTo(900_000, 6);
    // Today's shares: 30% taxable, 50% tax-deferred, 20% Roth.
    expect(d.start.years[0].start.taxable).toBeCloseTo(270_000, 6);
  });

  test('the mix at the start: projected, then scaled to the start’s balance, keeping its shares', () => {
    const d = detailOf(figures(plan({ savings: 0 })));
    const first = d.start.years[0].start;
    // No savings and no walk, so the shares are today's, to the cent.
    expect(first.taxable / total(first)).toBeCloseTo(0.3, 9);
    expect(first.deferred / total(first)).toBeCloseTo(0.5, 9);
    expect(d.notes).toEqual([]);
  });

  test('a walk that can’t get there still runs, on today’s shares, and says so', () => {
    const home = item({ kind: 'one-off', once: 5_000_000 });
    const f = figures(plan({ items: [home], savings: 0 }));
    const d = detailOf(f);
    expect(d.notes).toEqual(['no-mix']);
    expect(d.whole).toBeNull();
    expect(d.start.years[0].start.taxable / total(d.start.years[0].start)).toBeCloseTo(0.3, 9);
    expect(planPath(f)!.after).toBeNull();
  });

  test('with no age there is nothing to work out: the flat model carries it', () => {
    expect(figures(plan({ age: null })).detail).toBeNull();
  });

  test('with nothing to start from there is nothing to draw', () => {
    expect(figures(plan({ spending: null })).detail).toBeNull();
  });

  test('a law that can’t run says it failed, and the flat figures stand', () => {
    const bad = detailWork({ ...input, stateRate: 2 });
    const f = planFigures(plan(), M, { count: ON, detailed: bad });
    if ('refused' in f) throw new Error('refused');
    expect(f.detail).toEqual({ failed: expect.any(String) });
    const flat = figures(plan(), { detailed: false });
    expect(f.view).toEqual(flat.view);
    expect(f.engine).toEqual(flat.engine);
    expect(planPath(f)).toEqual(planPath(flat));
  });
});

describe('spending, and what measured spending already holds of coverage', () => {
  const noCare = { ...input, health: { ...input.health, coverage: null } };

  test('lasting changes are in it', () => {
    const f = figures(plan({ items: [item({ kind: 'spending', from: when(50), yearly: 12_000 })] }));
    expect(detailOf(f).start.years[0].living).toBeCloseTo(72_000, 4);
  });

  test('what’s already paid comes off measured spending', () => {
    const m: Measured = { spending: 60_000, savings: 40_000, assets: 1_000_000 };
    const p = plan({ spending: null, savings: null, assets: null });
    const run = (paidToday: number) => {
      const f = planFigures(p, m, { count: ON, detailed: detailWork({ ...noCare, paidToday }) });
      if ('refused' in f) throw new Error('refused');
      return f;
    };
    expect(detailOf(run(0)).start.years[0].living).toBeCloseTo(60_000, 4);
    expect(detailOf(run(9_000)).start.years[0].living).toBeCloseTo(51_000, 4);
    expect(run(9_000).view.fiNumber as number).toBeLessThan(run(0).view.fiNumber as number);
  });

  test('a typed spending isn’t measured, so nothing comes off it', () => {
    const f = planFigures(plan(), M, { count: ON, detailed: detailWork({ ...noCare, paidToday: 9_000 }) });
    if ('refused' in f) throw new Error('refused');
    expect(detailOf(f).start.years[0].living).toBeCloseTo(60_000, 4);
  });
});

describe('the walk’s tax', () => {
  // $180,000 out a year from 47 to the stop, from $1M: it has to sell.
  const below = plan({ items: [item({ kind: 'pay', from: when(47), until: when(55), yearly: -180_000 })], savings: 40_000 });

  test('it lowers the path, the balance at the stop, and the start at the stop', () => {
    const flat = figures(below, { detailed: false });
    const f = figures(below);
    expect(f.walk.taxes?.length).toBeGreaterThan(0);
    expect(f.walkFrom.tax).toBe(true);
    expect(detailOf(f).walkTax).toBeCloseTo((f.walk.taxes ?? []).reduce((s, x) => s + x.amount, 0), 6);
    expect(f.view.atTargetAge as number).toBeLessThan(flat.view.atTargetAge as number);
    const p = planPath(f)!;
    expect(p.points[p.points.length - 1].balance).toBe(f.view.atTargetAge as number);
    const atStop = figures({ ...below, start: 'at-stop' });
    expect(total(detailOf(atStop).start.years[0].start)).toBeCloseTo(f.view.atTargetAge as number, 4);
  });

  test('it moves the date', () => {
    const flat = figures(below, { detailed: false });
    const f = figures(below);
    expect(flat.view.fiAge).not.toBeNull();
    expect(f.view.fiAge as number).toBeGreaterThan(flat.view.fiAge as number);
  });

  test('a walk moved only by tax is a walk, not the plan’s items', () => {
    const p = plan({ savings: -60_000 });
    const f = figures(p);
    expect(f.walkFrom).toEqual({ items: false, events: false, tax: true });
    expect(planPath(f)!.fromWalk).toBe(true);
    expect(planPath(figures(p, { detailed: false }))!.fromWalk).toBe(false);
  });
});

describe('Whole path from the drawdown', () => {
  test('its years after the stop are `whole`’s balances, from where the walk ends', () => {
    const f = figures(plan());
    const p = planPath(f)!;
    const whole = detailOf(f).whole!;
    const after = p.after!;
    expect(after.points.length).toBe(whole.years.length + 1);
    expect(after.points[0].balance).toBeCloseTo(p.points[p.points.length - 1].balance, 6);
    whole.years.forEach((y, i) => {
      expect(after.points[i].age).toBe(y.age);
      expect(after.points[i].balance).toBe(total(y.start));
    });
    expect(after.points[after.points.length - 1].balance).toBe(total(whole.years[whole.years.length - 1].end));
    expect(after.endAge).toBe(95);
    expect(after.runsOutAt).toBe(whole.runsOutAt);
  });

  test('where it runs out, it ends at the start of that year', () => {
    const f = figures(plan({ spending: 200_000, savings: 0, assets: 500_000 }));
    const whole = detailOf(f).whole!;
    expect(whole.runsOutAt).not.toBeNull();
    const after = planPath(f)!.after!;
    expect(after.runsOutAt).toBe(whole.runsOutAt);
    expect(after.points[after.points.length - 1].age).toBe(whole.runsOutAt as number);
  });

  test('it lists what the FI number leaves out, as the flat path does', () => {
    const p = plan({ items: [item({ kind: 'one-off', from: when(70), once: 30_000 }), item({ id: 'y', kind: 'social-security', from: when(67), yearly: 24_000, beforeTax: true })] });
    expect(planPath(figures(p))!.after!.leftOut).toEqual(planPath(figures(p, { detailed: false }))!.after!.leftOut);
    expect(planPath(figures(p))!.after!.withEvents).toBe(planPath(figures(p, { detailed: false }))!.after!.withEvents);
  });

  test('a milestone after the stop fires on the drawdown’s path', () => {
    const on = (amount: number, from = 0) => ({ anchor: { at: 'balance' as const, amount }, offset: from });
    // Roth and tax-deferred money grow past $2M only some years on: when, depends
    // on what the years pay, health and tax included.
    const p = plan({ items: [item({ kind: 'one-off', from: on(3_000_000), once: 10_000 })], savings: 0, assets: 1_000_000, spending: 20_000, targetAge: 46, start: 'at-stop' });
    const flat = figures(p, { detailed: false });
    const f = figures(p);
    const firedFlat = flat.resolution.ages[0]?.start;
    const fired = f.resolution.ages[0]?.start;
    expect(firedFlat).toBeDefined();
    expect(fired).toBeDefined();
    expect(fired as number).toBeGreaterThan(firedFlat as number);
    const whole = detailOf(f).whole!;
    const k = (fired as number) - whole.years[0].age;
    expect(total(whole.years[k].start)).toBeGreaterThanOrEqual(3_000_000 - 20_000);
  });
});

const rounded = (d: { t: number; h: number }) => ({ t: Math.round(d.t * 1000) / 1000, h: Math.round(d.h) });

describe('the FI number in the detailed model', () => {
  const sharesOf = (f: PlanFigures) => {
    if (f.shares === null) throw new Error('no shares');
    return f.shares;
  };

  test('its own run: from the number, at the stop, giving the pair the number rests on', () => {
    const f = figures(plan());
    const s = sharesOf(f);
    expect(s.settled).toBe(true);
    expect(s.drawn.years[0].age).toBe(55);
    expect(total(s.drawn.years[0].start)).toBeCloseTo(f.view.workedOut as number, 4);
    expect(rounded(s.drawn)).toEqual({ t: s.t, h: s.h });
    expect(f.view.workedOut as number).toBeCloseTo((60_000 + s.h) / (1 - s.t) / 0.04, 6);
    expect(f.view.fiNumber).toBe(f.view.workedOut);
    // Measured to a tenth of a percent and a dollar.
    expect(s.t * 1000).toBeCloseTo(Math.round(s.t * 1000), 9);
    expect(s.h).toBe(Math.round(s.h));
  });

  test('a flat plan has none, and keeps its typed rate', () => {
    const f = figures(plan({ taxRate: 0.1 }), { detailed: false });
    expect(f.shares).toBeNull();
    expect(f.view.workedOut as number).toBeCloseTo(60_000 / 0.9 / 0.04, 6);
  });

  test('a typed rate has no part in it', () => {
    expect(figures(plan({ taxRate: 0.3 })).view.workedOut).toBe(figures(plan()).view.workedOut);
  });

  test('it doesn’t move with what the plan starts from', () => {
    const number = figures(plan()).view.workedOut;
    expect(figures(plan({ start: 'assets' })).view.workedOut).toBeCloseTo(number as number, 6);
    expect(figures(plan({ start: 'at-stop' })).view.workedOut).toBeCloseTo(number as number, 6);
    expect(figures(plan({ start: 'custom', startBalance: 300_000 })).view.workedOut).toBeCloseTo(number as number, 6);
    expect(figures(plan({ assets: 300_000, start: 'assets' })).shares?.settled).toBe(true);
  });

  test('your own number stands beside it, and doesn’t move it', () => {
    const own = figures(plan({ fiNumber: 1_500_000 }));
    expect(own.view.fiNumber).toBe(1_500_000);
    expect(own.view.workedOut).toBeCloseTo(figures(plan()).view.workedOut as number, 6);
    // Your own number is what Will it last? starts from.
    expect(total(detailOf(own).start.years[0].start)).toBeCloseTo(1_500_000, 4);
  });

  test('what measured spending already holds of coverage comes off it; a typed spending keeps all of it', () => {
    const noCare = { ...input, health: { ...input.health, coverage: null } };
    const m: Measured = { spending: 60_000, savings: 40_000, assets: 1_000_000 };
    const measured = (paidToday: number) => {
      const f = planFigures(plan({ spending: null, savings: null, assets: null }), m, { count: ON, detailed: detailWork({ ...noCare, paidToday }) });
      if ('refused' in f) throw new Error('refused');
      return f;
    };
    const at = measured(9_000);
    expect(sharesOf(at).paid).toBe(9_000);
    expect(at.view.workedOut as number).toBeCloseTo((51_000 + sharesOf(at).h) / (1 - sharesOf(at).t) / 0.04, 6);
    // Shown as measured: what's paid comes off only inside the number.
    expect(at.view.spending.value).toBe(60_000);
    const typed = planFigures(plan(), M, { count: ON, detailed: detailWork({ ...noCare, paidToday: 9_000 }) });
    if ('refused' in typed) throw new Error('refused');
    expect(sharesOf(typed).paid).toBe(0);
  });

  test('a lasting change counts at the stop, whatever the plan starts from', () => {
    const change = item({ kind: 'spending', from: when(50), yearly: 12_000 });
    const fromStop = figures(plan({ items: [change] }));
    const fromToday = figures(plan({ items: [change], start: 'assets' }));
    expect(sharesOf(fromToday).spending).toBe(72_000);
    expect(fromToday.view.workedOut).toBeCloseTo(fromStop.view.workedOut as number, 6);
    // And Will it last? still starts from today's spending.
    expect(detailOf(fromToday).start.years[0].living).toBeCloseTo(60_000, 4);
  });

  test('Barista: what part-time work leaves, with health, grossed up for tax', () => {
    const f = figures(plan({ partTimeIncome: 20_000 }));
    const s = sharesOf(f);
    expect(f.view.barista?.number as number).toBeCloseTo((40_000 + s.h) / (1 - s.t) / 0.04, 6);
  });

  test('Coast: through the FI number', () => {
    const f = figures(plan());
    expect(f.view.coast?.number as number).toBeCloseTo((f.view.fiNumber as number) / 1.05 ** 10, 6);
  });

  test('the walk’s income keeps what the tax share leaves', () => {
    const pension = item({ kind: 'pension', from: when(50), until: when(54), yearly: 30_000, beforeTax: true });
    const f = figures(plan({ items: [pension], taxRate: 0.3 }));
    const s = sharesOf(f);
    expect(s.t).toBeGreaterThan(0);
    expect(f.walk.spans[0].delta).toBeCloseTo(30_000 * (1 - s.t), 4);
  });

  test('nothing to work it out from: the flat model carries the plan, and says nothing of shares', () => {
    expect(figures(plan({ age: null })).shares).toBeNull();
    expect(figures(plan({ spending: null })).shares).toBeNull();
    const bad = planFigures(plan({ taxRate: 0.1 }), M, { count: ON, detailed: detailWork({ ...input, stateRate: 2 }) });
    if ('refused' in bad) throw new Error('refused');
    expect(bad.shares).toBeNull();
    expect(bad.view.workedOut as number).toBeCloseTo(60_000 / 0.9 / 0.04, 6);
  });

  test('stop when I reach FI: the stop found reaches its own number', () => {
    const f = figures(plan({ stopAtFi: true, targetAge: null }));
    const s = sharesOf(f);
    const stop = f.view.stopAge as number;
    expect(s.drawn.years[0].age).toBe(stop);
    const p = planPath(f)!;
    expect(p.points[p.points.length - 1].age).toBe(stop);
    // A year before it, the walk hasn't reached the number found at it, to the half year it rounds to.
    expect(p.points[p.points.length - 2].balance).toBeLessThan(f.view.fiNumber as number);
    expect(Math.round(f.view.fiAge as number)).toBe(stop);
  });

  test('on generated plans: a settled number reproduces its pair, nothing thrown', () => {
    let settled = 0;
    let unsettled = 0;
    let none = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const g = rand(seed);
      const base = planOf(genPlan(g));
      const p: FirePlanV2 = { ...base, start: g.chance(0.3) ? 'at-stop' : base.start, items: [...base.items, ...genEvents(g).map(itemFromEvent)] };
      const m = genMeasured(g);
      const f = planFigures(p, m, { count: ON, detailed: work });
      if ('refused' in f) continue;
      if (f.shares === null) {
        none++;
        continue;
      }
      const label = `seed ${seed}`;
      const number = f.view.workedOut as number;
      if (f.shares.settled) {
        settled++;
        expect([label, rounded(f.shares.drawn)]).toEqual([label, { t: f.shares.t, h: f.shares.h }]);
        expect(f.shares.gap).toBe(0);
      } else {
        unsettled++;
        expect(f.shares.gap).toBeGreaterThan(0);
      }
      expect(total(f.shares.drawn.years[0].start)).toBeCloseTo(number, 3);
      expect(number).toBeCloseTo((Math.max(0, f.shares.spending - f.shares.paid) + f.shares.h) / (1 - f.shares.t) / p.withdrawalRate, 3);
    }
    expect(settled).toBeGreaterThan(100);
    expect(unsettled).toBeLessThan(settled / 5);
    expect(none).toBeGreaterThan(0);
  });
});
