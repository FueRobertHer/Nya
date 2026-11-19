import { describe, expect, test } from 'bun:test';
import { parseItem, itemRules, type PlanItem, type When } from '@/lib/fire/items';
import { holdsAmounts } from '@/lib/fire/copies';
import { planPath } from '@/lib/fire/path';
import type { EnginePlan } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { DEFAULT_PLAN_V2, planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { makeMarket, type Market } from '@/lib/fire/market';
import { firedAcross, historicalCycles } from '@/lib/fire/simulate';
import { acrossText, coastNotReachedText, waitingStart } from '@/components/plan-items';
import { resolveItems, withoutIdle, type SteadyWorld } from '@/lib/fire/steady';
import { genEvents, genMeasured, genPlan, itemFromEvent, ON, rand } from './plan-gen';

// A milestone on a share of the FI number, or at Coast FI (lib/fire/steady.ts):
// checked year by year in order, against the FI number of the plan as it stands
// that year. It moves nothing itself; an item timed on it moves the FI number
// only from the year after, so nothing placed later reaches back.

const when = (anchor: When['anchor'], offset = 0): When => ({ anchor, offset });
const milestone = (id: string, from: When, owner: PlanItem['owner'] = null): PlanItem => ({
  id,
  label: id,
  kind: 'milestone',
  from,
  until: null,
  once: null,
  yearly: null,
  replaces: null,
  every: null,
  times: null,
  inflationAdjusted: true,
  owner,
  beforeTax: false,
});
const share = (id: string, percent: number) => milestone(id, when({ at: 'share', percent }));
const coast = (id: string) => milestone(id, when({ at: 'coast' }));
const spending = (id: string, from: When, yearly: number): PlanItem => ({ ...milestone(id, from), kind: 'spending', yearly });
const on = (id: string, offset = 0) => when({ at: 'item', id, edge: 'start' }, offset);

// FI number $1,000,000 (4%, no tax); $200,000 now and $50,000 a year at 5%.
const base: FirePlanV2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: 60, spending: 40_000, savings: 50_000, assets: 200_000, realReturn: 0.05, taxRate: 0 };
const M = { spending: null, savings: null, assets: null };
const figures = (items: PlanItem[], over: Partial<FirePlanV2> = {}) => {
  const f = planFigures({ ...base, ...over, items }, M, { count: ON });
  if ('refused' in f) throw new Error('refused');
  return f;
};
/** The steady path's balance at the start of each year, by age. */
const balances = (f: PlanFigures) => new Map((planPath(f)?.points ?? []).map((p) => [p.age, p.balance]));
/** The first age from `from` whose balance reaches `at`. */
const firstAt = (f: PlanFigures, at: number, from = -Infinity): number => [...balances(f)].find(([age, b]) => age >= from && b >= at)?.[0] ?? NaN;

describe('the item', () => {
  test('a share is a whole percent from 1 to 200, Coast FI has nothing else; both on a milestone only, with no years either side', () => {
    expect(parseItem(share('m', 50), 'items[0]')).toEqual({ ok: share('m', 50) });
    expect(parseItem(coast('m'), 'items[0]')).toEqual({ ok: coast('m') });
    expect(parseItem(share('m', 200), 'items[0]')).toEqual({ ok: share('m', 200) });
    for (const percent of [0, 201, 12.5]) expect(parseItem(share('m', percent), 'items[0]')).toEqual({ error: 'items[0]: when it is reached is a whole percent of the FI number from 1 to 200' });
    expect(parseItem({ ...share('m', 50), from: when({ at: 'share', percent: 50 }, 1) }, 'items[0]')).toEqual({ error: 'items[0]: a milestone is reached with no years before or after' });
    expect(parseItem({ ...coast('m'), owner: 'you' }, 'items[0]')).toEqual({ error: 'items[0]: only a milestone at an age says whose' });
    expect(parseItem(spending('s', when({ at: 'share', percent: 50 }), 1_000), 'items[0]')).toEqual({ error: 'items[0]: only a milestone is reached at a share of the FI number or Coast FI' });
    expect(parseItem(spending('s', when({ at: 'coast' }), 1_000), 'items[0]')).toEqual({ error: 'items[0]: only a milestone is reached at a share of the FI number or Coast FI' });
    // A stored shape: exactly its fields.
    expect(parseItem({ ...coast('m'), from: { anchor: { at: 'coast', percent: 50 }, offset: 0 } }, 'items[0]')).toEqual({ error: 'items[0] is not an item of a plan' });
  });

  test('an item can start on one, never before it', () => {
    const plan = { ...base, items: [share('h', 50), spending('s', on('h', 2), 1_000)] };
    expect(itemRules(plan)).toBeNull();
    expect(itemRules({ ...plan, items: [coast('c'), spending('s', on('c', -1), 1_000)] })).toEqual({ field: 'items[1]', error: 'items[1] can’t come before what follows a balance being reached' });
  });

  test('a share or Coast FI holds no amount of its own, so alone it keeps no currency', () => {
    expect(holdsAmounts({ ...DEFAULT_PLAN_V2, items: [share('m', 50), coast('c')] })).toBe(false);
  });
});

describe('where a share falls', () => {
  test('at the first year the balance reaches that share of the FI number, worked out or your own', () => {
    const f = figures([share('h', 60)]);
    expect(f.view.fiNumber).toBe(1_000_000);
    expect(f.resolution.ages[0]).toEqual({ start: firstAt(f, 600_000), end: null });
    expect(f.resolution.reachedAt).toEqual([600_000]);
    const own = figures([share('h', 60)], { fiNumber: 1_500_000 });
    expect(own.resolution.ages[0]).toEqual({ start: firstAt(own, 900_000), end: null });
    expect(own.resolution.reachedAt).toEqual([900_000]);
    expect(own.resolution.ages[0]!.start).toBeGreaterThan(f.resolution.ages[0]!.start);
  });

  test('a lasting change timed on Halfway moves a later share’s number, and only from the year after', () => {
    for (const change of [10_000, -10_000]) {
      const plan = [share('half', 50), spending('s', on('half'), change), share('late', 55)];
      const f = figures(plan);
      const before = figures([share('half', 50)]);
      const half = f.resolution.ages[0]!.start;
      const late = f.resolution.ages[2]!.start;
      // The FI number with the change in it; the later share is judged on it.
      expect(f.view.fiNumber).toBe((40_000 + change) / 0.04);
      expect(f.resolution.reachedAt![2]).toBeCloseTo(0.55 * (f.view.fiNumber as number), 6);
      expect(late).toBe(firstAt(f, 0.55 * (f.view.fiNumber as number), half + 1));
      // Never in Halfway's year or before: there it was judged on the number before.
      expect(late).toBeGreaterThan(half);
      // The path up to Halfway is the one without the change.
      for (const [age, b] of balances(before)) if (age <= half) expect([age, Math.round(balances(f).get(age)! * 100)]).toEqual([age, Math.round(b * 100)]);
    }
  });

  test('the board’s case: Halfway with nothing timed on it, before a cut timed on Lean FI, judged on the number before the cut', () => {
    // Lean FI at $1,200,000 (53); the cut takes the FI number to $750,000 from then.
    const f = figures([share('half', 50), milestone('lean', when({ at: 'balance', amount: 1_200_000 })), spending('cut', on('lean'), -10_000)]);
    const half = f.resolution.ages[0]!.start;
    const lean = f.resolution.ages[1]!.start;
    expect(f.view.fiNumber).toBe(750_000);
    expect([half, f.resolution.reachedAt![0]]).toEqual([firstAt(f, 500_000), 500_000]);
    // Half of $750,000 was crossed sooner: the cut never places it earlier.
    expect(firstAt(f, 375_000)).toBeLessThan(half);
    expect(half).toBeLessThan(lean);
  });

  test('Halfway after a cut timed on Lean FI before it, judged on the number then', () => {
    // Lean FI at $450,000 (age 44); the cut lowers the FI number from then.
    const f = figures([share('half', 50), milestone('lean', when({ at: 'balance', amount: 450_000 })), spending('cut', on('lean'), -10_000)]);
    const lean = f.resolution.ages[1]!.start;
    const half = f.resolution.ages[0]!.start;
    expect(lean).toBe(firstAt(f, 450_000));
    // From Lean FI's year on, the number is $750,000; Halfway is half of it, and not before Lean FI's year + 1.
    expect(f.resolution.reachedAt![0]).toBe(375_000);
    expect(half).toBe(firstAt(f, 375_000, lean + 1));
    // $375,000 was crossed before Lean FI, on the number before the cut: it is never placed there.
    expect(firstAt(f, 375_000)).toBeLessThan(lean);
    expect(half).toBe(lean + 1);
  });
});

describe('where Coast FI falls', () => {
  test('at today exactly when You could stop saving now shows', () => {
    for (const assets of [200_000, 400_000, 700_000]) {
      const f = figures([coast('c')], { assets });
      const reached = f.view.coast?.reached;
      const start = f.resolution.ages[0]?.start ?? null;
      expect([assets, reached ? start : start !== null && start > 40]).toEqual([assets, reached ? 40 : true]);
      expect(balances(f).get(40)).toBe(assets);
    }
  });

  test('the first year what you have grows to your FI number by the stop with nothing more added', () => {
    const f = figures([coast('c')]);
    const at = f.resolution.ages[0]!.start;
    const g = f.view.growth;
    const need = (age: number) => 1_000_000 / (1 + g) ** (60 - age);
    expect(balances(f).get(at)!).toBeGreaterThanOrEqual(need(at));
    expect(balances(f).get(at - 1)!).toBeLessThan(need(at - 1));
    expect(f.resolution.reachedAt![0]).toBeCloseTo(need(at), 6);
  });

  test('with FI after the stop, not reached; with no stop, waiting on one; under the stop at FI, by the stop found', () => {
    const late = figures([coast('c')], { targetAge: 45 });
    expect(late.view.fiAge! > 45).toBe(true);
    expect([late.resolution.ages[0], late.resolution.why[0]]).toEqual([null, 'not-reached']);
    const none = figures([coast('c')], { targetAge: null });
    expect([none.resolution.ages[0], none.resolution.why[0]]).toEqual([null, 'waits-on-stop']);
    // Under the stop at FI, by the stop the search found, as with that stop typed.
    // Here FI rounds down to 50, with the balance short of the number at the
    // start of that year, so it isn't reached by that stop.
    for (const over of [{}, { assets: 680_000, savings: 0 }]) {
      const found = figures([coast('c')], { ...over, stopAtFi: true, targetAge: null });
      const stop = found.resolution.stop as number;
      const typed = figures([coast('c')], { ...over, targetAge: stop });
      expect([stop, found.resolution.ages, found.resolution.why]).toEqual([stop, typed.resolution.ages, typed.resolution.why]);
    }
    const atFi = figures([coast('c')], { stopAtFi: true, targetAge: null });
    expect(atFi.resolution.why).toEqual(['not-reached']);
    // Said as it is, never as a rule about stopping at FI (one can come before that stop).
    expect(coastNotReachedText(atFi)).toBe('What you have doesn’t grow to your FI number by your stop with nothing more added.');
    // With nothing more saved, $680,000 grows to $1,000,000 by 48, the stop found: Coast FI today.
    const coasting = figures([coast('c')], { assets: 680_000, savings: 0, stopAtFi: true, targetAge: null });
    expect([coasting.resolution.stop, coasting.resolution.ages[0]]).toEqual([48, { start: 40, end: null }]);
  });
});

describe('with no FI number', () => {
  test('neither is placed, and says why; nor is what is timed on one', () => {
    const f = planFigures({ ...base, spending: null, items: [share('h', 50), coast('c'), spending('s', on('h'), 1_000)] }, { spending: null, savings: null, assets: null, unmeasured: ['spending'] }, { count: ON });
    if ('refused' in f) throw new Error('refused');
    expect(f.resolution.ages).toEqual([null, null, null]);
    expect(f.resolution.why).toEqual(['no-fi-number', 'no-fi-number', 'no-fi-number']);
  });
});

describe('each run (D11, from what you’d have at your stop)', () => {
  test('a share not reached by the stop waits in each run at its threshold; Coast FI never does', () => {
    const f = figures([share('big', 150), spending('s', on('big'), 5_000), coast('c'), spending('t', on('c'), 5_000)], { start: 'at-stop', targetAge: 45 });
    const r = f.resolution;
    const at = r.reachedAt?.[0] ?? 1.5 * (f.view.fiNumber as number);
    expect(r.perRun?.triggers).toEqual([at]);
    expect(r.perRun?.edges[1]).toEqual({ start: { trigger: 0, offset: 0 }, end: null });
    expect([r.perRun?.edges[2], r.perRun?.edges[3]]).toEqual([null, null]);
    expect([r.ages[3], r.why[3]]).toEqual([null, 'not-reached']);
    const sim = (f.engine as EnginePlan).sim;
    expect(sim.conditional?.triggers).toEqual([at]);
  });

  test('Across history says where one nothing is timed on falls across the runs', () => {
    const f = figures([share('big', 150)], { start: 'at-stop', targetAge: 45 });
    expect(f.resolution.ages[0]).toBeNull();
    const w = waitingStart(f, 'big');
    expect(w).not.toBeNull();
    expect((f.engine as EnginePlan).sim.conditional?.triggers).toEqual([1.5 * (f.view.fiNumber as number)]);
    const fired = firedAcross('historical', w!.sim, MARKET, w!.trigger, w!.offset);
    expect(fired.runs).toBeGreaterThan(0);
    expect(acrossText({ fired, startAge: w!.startAge }, true)).toMatch(/^It (is reached in (every run|\d+% of runs), by \d+ in half of (them|those)|is never reached, in any run)/);
  });

  test('one the steady path reaches after the stop waits at the amount it was reached at there', () => {
    // $900,000 at 40, stopping at 42: the balance keeps growing after the stop, to $1,200,000 at 49 or so.
    const f = figures([share('big', 120), spending('s', on('big'), 5_000)], { assets: 900_000, start: 'at-stop', targetAge: 42 });
    const r = f.resolution;
    expect(r.ages[0]!.start).toBeGreaterThan(42);
    expect(r.reachedAt?.[0]).toBeCloseTo(1_200_000, 6);
    // The same as 120% of the FI number as it last stood: the number reads its
    // lasting changes at the stop, so nothing placed after the stop moves it.
    expect(r.perRun?.triggers.map((t) => Math.round(t))).toEqual([1_200_000]);
  });
});

describe('cost', () => {
  test('one nothing is timed on costs one path at the answer alone, and at most that one when something else waits', () => {
    const plan = { ...base, stopAtFi: true, items: [share('h', 50)] };
    let paths = 0;
    // Grows $100,000 a year from $200,000; FI is reached at 48.
    const world: SteadyWorld = {
      path: () => {
        paths++;
        return { balances: Array.from({ length: 50 }, (_, k) => 200_000 + k * 100_000), fiNumber: 1_000_000, growth: 0.05 };
      },
      fiAge: (_ages, stop) => (stop !== null && stop >= 48 ? 48 : null),
    };
    const r = resolveItems(plan, world);
    expect([r.stop, r.ages[0], r.reachedAt]).toEqual([48, { start: 43, end: null }, [500_000]]);
    expect(paths).toBe(1);
    // Riding the passes of an item on a balance: the paths they cost, and one at
    // the answer for what is left once nothing with an item on it waits.
    const watched = [milestone('b', when({ at: 'balance', amount: 700_000 })), spending('s', on('b'), 1)];
    paths = 0;
    resolveItems({ ...plan, items: watched }, world);
    const alone = paths;
    // As before share and Coast FI (6abdd3b3's lib/fire/steady.ts on this world).
    expect(alone).toBe(9);
    paths = 0;
    const both = resolveItems({ ...plan, items: [...watched, share('h', 50), coast('c')] }, world);
    expect(paths).toBe(alone + 1);
    // Halfway rides alone: it fires before the balance, so nothing is left.
    paths = 0;
    resolveItems({ ...plan, items: [...watched, share('h', 50)] }, world);
    expect(paths).toBe(alone);
    // Half of $1,000,000 at 43; Coast FI where what you have would grow to it by the stop at 48.
    expect([both.ages[2], both.ages[3]]).toEqual([{ start: 43, end: null }, { start: 48, end: null }]);
  });

  test('an item on a balance with a stop typed costs one path, and no more once it fires', () => {
    let paths = 0;
    const world: SteadyWorld = {
      path: () => {
        paths++;
        return { balances: Array.from({ length: 50 }, (_, k) => 200_000 + k * 100_000), fiNumber: 1_000_000, growth: 0.05 };
      },
      fiAge: () => 48,
    };
    const r = resolveItems({ ...base, targetAge: 50, items: [milestone('b', when({ at: 'balance', amount: 700_000 })), spending('s', on('b'), 1)] }, world);
    expect([r.ages[0], r.ages[1]]).toEqual([{ start: 45, end: null }, { start: 45, end: null }]);
    expect(paths).toBe(1);
  });
});

/** A market of varied years, long enough for several starts. */
const MARKET: Market = (() => {
  const rates = Array.from({ length: 140 }, (_, k) => [0.12, -0.08, 0.05, 0.2, -0.15, 0.07, 0.03][k % 7]);
  const months = rates.flatMap((r) => new Array<number>(12).fill((1 + r) ** (1 / 12) - 1));
  return makeMarket('1900-01', months, months, new Array(months.length).fill(0.03 / 12));
})();

/** Everything a figure is made of, the milestones' own places left out. */
function seen(f: PlanFigures, keep: (i: number) => boolean) {
  const r = f.resolution;
  const sim = 'sim' in f.engine ? (f.engine as EnginePlan).sim : null;
  const { conditional, ...rest } = sim ?? { conditional: undefined };
  const byAmount = (triggers: readonly number[]) => (e: unknown) => (typeof e === 'object' && e !== null && 'trigger' in e ? { ...e, trigger: triggers[(e as { trigger: number }).trigger] } : e);
  const runEdge = byAmount(r.perRun?.triggers ?? []);
  const perRun = (r.perRun?.edges.filter((_, i) => keep(i)) ?? []).map((e) => (e === null ? null : { start: runEdge(e.start), end: runEdge(e.end) }));
  const simEdge = byAmount(conditional?.triggers ?? []);
  const items = conditional?.items.map((x) => ({ ...x, start: simEdge(x.start), end: simEdge(x.end) })) ?? [];
  return {
    stop: r.stop,
    fi: r.fi,
    searched: r.searched,
    ages: r.ages.filter((_, i) => keep(i)),
    why: r.why.filter((_, i) => keep(i)),
    perRun: perRun.some((e) => e !== null) ? perRun : null,
    view: f.view,
    events: f.events,
    notes: f.itemNotes.map(({ id, part }) => ({ id, part })),
    inWalk: f.inWalk.filter((_, i) => keep(i)),
    path: planPath(f)?.points ?? null,
    sim: sim ? rest : f.engine,
    conditional: items.length > 0 ? items : null,
    runs: sim ? historicalCycles(sim, MARKET) : null,
  };
}

describe('it moves nothing', () => {
  test('over 120 seeded plans, every start, the stop at FI or not: with shares and Coast FI nothing is timed on, every figure is the same', () => {
    let placed = 0;
    for (let n = 0; n < 120; n++) {
      const g = rand(9100 + n);
      const p = planOf(genPlan(g, n % 4 === 0));
      const events = g.chance(0.7) ? genEvents(g).map(itemFromEvent) : [];
      // Now and then an item on a balance, so the passes run and they ride them.
      const onBalance = g.chance(0.5) ? [spending('b', when({ at: 'balance', amount: g.int(2, 30) * 100_000 }), g.int(-20, 20) * 1000 || 1000)] : [];
      const plan: FirePlanV2 = { ...p, start: g.pick(['fi-number', 'assets', 'custom', 'at-stop'] as const), stopAtFi: g.chance(0.3), items: [...p.items, ...events, ...onBalance] };
      const m = genMeasured(g);
      const marks = [share('s1', g.int(1, 200)), coast('c'), ...(g.chance(0.5) ? [share('s2', g.int(1, 200))] : [])];
      const at = g.int(0, plan.items.length);
      const items = [...plan.items.slice(0, at), ...marks, ...plan.items.slice(at)];
      const keep = (i: number) => items[i].kind !== 'milestone';
      const without = planFigures(plan, m, { count: ON });
      const withThem = planFigures({ ...plan, items }, m, { count: ON });
      if ('refused' in without || 'refused' in withThem) {
        expect(['refused' in without, 'refused' in withThem]).toEqual([true, true]);
        continue;
      }
      expect([n, seen(withThem, keep)]).toEqual([n, seen(without, () => true)]);
      placed += items.filter((x, i) => x.kind === 'milestone' && withThem.resolution.ages[i] !== null).length;
    }
    expect(placed).toBeGreaterThan(40);
  }, 120_000);

  test('D9’s candidates run without them, and placed at a given FI, the same', () => {
    expect(withoutIdle({ ...base, items: [share('a', 50), coast('c'), share('w', 60), spending('s', on('w'), 1)] }).map((x) => x.id)).toEqual(['w', 's']);
    for (let n = 0; n < 30; n++) {
      const g = rand(9300 + n);
      const p = planOf(genPlan(g));
      const plan: FirePlanV2 = { ...p, age: g.int(30, 50), stopAtFi: g.chance(0.5), items: [...p.items, ...genEvents(g).map(itemFromEvent)] };
      const items = [...plan.items, share('m', g.int(1, 200)), coast('c')];
      const fiAt = g.chance(0.2) ? null : (plan.age as number) + g.int(0, 30);
      const m = genMeasured(g);
      const without = planFigures(plan, m, { count: ON, fiAt });
      const withIt = planFigures({ ...plan, items }, m, { count: ON, fiAt });
      if ('refused' in without || 'refused' in withIt) continue;
      expect([n, seen(withIt, (i) => i < plan.items.length)]).toEqual([n, seen(without, () => true)]);
    }
  }, 60_000);
});
