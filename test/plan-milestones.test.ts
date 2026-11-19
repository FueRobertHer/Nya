import { describe, expect, test } from 'bun:test';
import { parseItem, itemRules, type PlanItem, type When } from '@/lib/fire/items';
import { holdsAmounts } from '@/lib/fire/copies';
import { planPath } from '@/lib/fire/path';
import type { EnginePlan } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { DEFAULT_PLAN_V2, planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { makeMarket, type Market } from '@/lib/fire/market';
import { historicalCycles } from '@/lib/fire/simulate';
import { resolveItems, withoutIdle, type SteadyWorld } from '@/lib/fire/steady';
import { earliestStop } from '@/lib/fire/earliest';
import { DEFAULT_PLAN } from '@/lib/fire/plan';
import { usMarket } from '@/lib/fire/us-market';
import { checkDraft, draftOf, templateById } from '@/components/PlanItemSheet';
import { genEvents, genMeasured, genPlan, itemFromEvent, ON, rand } from './plan-gen';

// A milestone (lib/fire/items.ts): an item with no money, reached at an amount
// or an age, that other items can start or end on. It must move nothing: the
// figures with one are the figures without it, wherever it falls, whatever the
// plan's start; and placing one that nothing is timed on costs one path, at the
// answer, never one per candidate of a search.

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
const spending = (id: string, from: When, yearly: number): PlanItem => ({ ...milestone(id, from), kind: 'spending', yearly });

describe('the item', () => {
  test('reached at an amount or an age, with no years either side, no end and no money; whose only for an age', () => {
    expect(parseItem(milestone('m', when({ at: 'balance', amount: 1_000_000 })), 'items[0]')).toEqual({ ok: milestone('m', when({ at: 'balance', amount: 1_000_000 })) });
    expect('ok' in parseItem(milestone('m', when({ at: 'age', age: 55 }), 'partner'), 'items[0]')).toBe(true);
    expect(parseItem(milestone('m', when({ at: 'stop' })), 'items[0]')).toEqual({ error: 'items[0]: a milestone is reached at an amount, an age, a share of the FI number or Coast FI' });
    expect(parseItem(milestone('m', when({ at: 'item', id: 'a', edge: 'start' })), 'items[0]')).toEqual({ error: 'items[0]: a milestone is reached at an amount, an age, a share of the FI number or Coast FI' });
    expect(parseItem(milestone('m', when({ at: 'balance', amount: 1_000_000 }, 2)), 'items[0]')).toEqual({ error: 'items[0]: a milestone is reached with no years before or after' });
    expect(parseItem({ ...milestone('m', when({ at: 'balance', amount: 1_000_000 })), owner: 'you' }, 'items[0]')).toEqual({ error: 'items[0]: only a milestone at an age says whose' });
    expect(parseItem({ ...milestone('m', when({ at: 'age', age: 55 })), until: { years: 2 } }, 'items[0]')).toEqual({ error: 'items[0]: a milestone item has no until' });
    expect(parseItem({ ...milestone('m', when({ at: 'age', age: 55 })), yearly: 1 }, 'items[0]')).toEqual({ error: 'items[0]: a milestone item has no yearly' });
    expect(parseItem({ ...milestone('m', when({ at: 'balance', amount: 0 })) }, 'items[0]')).toEqual({ error: 'items[0]: when it is reached is a balance above 0, up to 1000000000' });
  });

  test('an item can start on it, never end on it, since it has no end', () => {
    const base = { ...DEFAULT_PLAN_V2, age: 40 };
    const m = milestone('m', when({ at: 'balance', amount: 1_000_000 }));
    expect(itemRules({ ...base, items: [m, spending('s', when({ at: 'item', id: 'm', edge: 'start' }, 2), 1_000)] })).toBeNull();
    expect(itemRules({ ...base, items: [m, spending('s', when({ at: 'item', id: 'm', edge: 'end' }), 1_000)] })).toEqual({ field: 'items[1]', error: 'items[1] is timed by the end of items[0], which has none' });
    expect(itemRules({ ...base, items: [m, spending('s', when({ at: 'item', id: 'm', edge: 'start' }, -1), 1_000)] })).toEqual({ field: 'items[1]', error: 'items[1] can’t come before what follows a balance being reached' });
  });

  test('its amount is an amount the plan holds, so the plan keeps its currency', () => {
    expect(holdsAmounts({ ...DEFAULT_PLAN_V2, items: [milestone('m', when({ at: 'balance', amount: 1_000_000 }))] })).toBe(true);
    expect(holdsAmounts({ ...DEFAULT_PLAN_V2, items: [milestone('m', when({ at: 'age', age: 55 }))] })).toBe(false);
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
  // A milestone left to each run adds its own trigger, which nothing else
  // waits on, so a trigger is said by its amount, not its place in the list.
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
    // By id: a note's place moves with the list.
    notes: f.itemNotes.map(({ id, part }) => ({ id, part })),
    inWalk: f.inWalk.filter((_, i) => keep(i)),
    path: planPath(f)?.points ?? null,
    sim: sim ? rest : f.engine,
    conditional: items.length > 0 ? items : null,
    runs: sim ? historicalCycles(sim, MARKET) : null,
  };
}

describe('it moves nothing', () => {
  test('over 120 seeded plans, every start, the stop at FI or not: with milestones on amounts and ages, every figure is the same', () => {
    let placed = 0;
    let after = 0;
    for (let n = 0; n < 120; n++) {
      const g = rand(7100 + n);
      const p = planOf(genPlan(g, n % 4 === 0));
      const events = g.chance(0.7) ? genEvents(g).map(itemFromEvent) : [];
      // Now and then an item on a balance, so the passes run.
      const onBalance = g.chance(0.4) ? [spending('b', when({ at: 'balance', amount: g.int(2, 30) * 100_000 }), g.int(-20, 20) * 1000 || 1000)] : [];
      const plan: FirePlanV2 = { ...p, start: g.pick(['fi-number', 'assets', 'custom', 'at-stop'] as const), stopAtFi: g.chance(0.3), items: [...p.items, ...events, ...onBalance] };
      const m = genMeasured(g);
      const marks = [
        milestone('m1', when({ at: 'balance', amount: g.int(1, 60) * 100_000 })),
        milestone('m2', when({ at: 'age', age: g.int(20, 100) })),
        ...(g.chance(0.5) ? [milestone('m3', when({ at: 'balance', amount: g.int(1, 60) * 100_000 }))] : []),
      ];
      // Milestones go anywhere in the list.
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
      for (const [i, x] of items.entries()) {
        if (x.kind !== 'milestone' || x.from.anchor.at !== 'balance') continue;
        const age = withThem.resolution.ages[i];
        if (age) placed++;
        if (withThem.resolution.perRun?.edges[i]) after++;
      }
    }
    // The cases reach both: milestones placed, and ones left to each run.
    expect(placed).toBeGreaterThan(20);
    expect(after).toBeGreaterThan(3);
  }, 120_000);

  test('with your FI date as the earliest stop that lasts (D9), placed at a given FI, the same', () => {
    for (let n = 0; n < 30; n++) {
      const g = rand(7300 + n);
      const p = planOf(genPlan(g));
      const plan: FirePlanV2 = { ...p, age: g.int(30, 50), stopAtFi: g.chance(0.5), items: [...p.items, ...genEvents(g).map(itemFromEvent)] };
      const items = [...plan.items, milestone('m', when({ at: 'balance', amount: g.int(1, 40) * 100_000 }))];
      const fiAt = g.chance(0.2) ? null : (plan.age as number) + g.int(0, 30);
      const m = genMeasured(g);
      const without = planFigures(plan, m, { count: ON, fiAt });
      const withIt = planFigures({ ...plan, items }, m, { count: ON, fiAt });
      if ('refused' in without || 'refused' in withIt) continue;
      expect([n, seen(withIt, (i) => i < plan.items.length)]).toEqual([n, seen(without, () => true)]);
    }
  }, 60_000);
});

describe('where it falls', () => {
  // FI number $1,000,000 (4%, no tax); $500,000 now and $50,000 a year at 5%.
  const base: FirePlanV2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: 60, spending: 40_000, savings: 50_000, assets: 500_000, realReturn: 0.05, taxRate: 0 };
  const m = { spending: null, savings: null, assets: null };
  const figures = (items: PlanItem[], over: Partial<FirePlanV2> = {}) => {
    const f = planFigures({ ...base, ...over, items }, m, { count: ON });
    if ('refused' in f) throw new Error('refused');
    return f;
  };

  test('at the first year the balance reaches it, as an item on a balance starts; never reached, not placed', () => {
    const on = figures([spending('s', when({ at: 'balance', amount: 800_000 }), 1)]).resolution.ages[0];
    const f = figures([milestone('m', when({ at: 'balance', amount: 800_000 })), milestone('never', when({ at: 'balance', amount: 900_000_000 }))]);
    expect(f.resolution.ages[0]).toEqual({ start: on!.start, end: null });
    expect([f.resolution.ages[1], f.resolution.why[1]]).toEqual([null, 'not-reached']);
  });

  test('an item timed on it follows it; one on an age is that age, yours or your partner’s', () => {
    const f = figures([milestone('m', when({ at: 'balance', amount: 800_000 })), spending('s', when({ at: 'item', id: 'm', edge: 'start' }, 2), 5_000)]);
    const [mark, follower] = f.resolution.ages as { start: number }[];
    expect(follower.start).toBe(mark.start + 2);
    const g = figures([milestone('a', when({ at: 'age', age: 55 }), 'partner'), spending('s', when({ at: 'item', id: 'a', edge: 'start' }), 5_000)], { partnerAge: 37 });
    expect(g.resolution.ages).toEqual([{ start: 58, end: null }, { start: 58, end: null }]);
  });

  test('one that nothing is timed on costs one path at the answer, never one per candidate', () => {
    const plan = { ...base, stopAtFi: true, items: [milestone('m', when({ at: 'balance', amount: 800_000 }))] };
    let paths = 0;
    let candidates = 0;
    // Grows $100,000 a year from $500,000; FI is reached at 47.
    const world: SteadyWorld = {
      path: () => {
        paths++;
        return { balances: Array.from({ length: 50 }, (_, k) => 500_000 + k * 100_000), fiNumber: null, growth: 0 };
      },
      fiAge: (_ages, stop) => {
        candidates++;
        return stop !== null && stop >= 47 ? 47 : null;
      },
    };
    const r = resolveItems(plan, world);
    expect([r.stop, r.ages[0]]).toEqual([47, { start: 43, end: null }]);
    expect(candidates).toBeGreaterThan(5);
    expect(paths).toBe(1);
    // Timed on, it is a balance anchor like any other: one path a pass, per candidate.
    paths = 0;
    resolveItems({ ...plan, items: [...plan.items, spending('s', when({ at: 'item', id: 'm', edge: 'start' }), 1)] }, world);
    expect(paths).toBeGreaterThan(5);
    // On an age, no path at all.
    paths = 0;
    resolveItems({ ...plan, items: [milestone('a', when({ at: 'age', age: 50 }))] }, world);
    expect(paths).toBe(0);
  });
});

describe('D9 and the sheet', () => {
  const base: FirePlanV2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: 60, spending: 40_000, savings: 50_000, assets: 500_000, realReturn: 0.05, taxRate: 0 };

  test('D9’s candidates run without a milestone nothing is timed on, and find the same stop', () => {
    const idle = milestone('idle', when({ at: 'balance', amount: 900_000 }));
    const watched = milestone('watched', when({ at: 'balance', amount: 700_000 }));
    const age = milestone('age', when({ at: 'age', age: 50 }));
    const follower = spending('s', when({ at: 'item', id: 'watched', edge: 'start' }), 1_000);
    expect(withoutIdle({ ...base, items: [idle, watched, age, follower] }).map((x) => x.id)).toEqual(['watched', 'age', 's']);
    const plan: FirePlanV2 = { ...planOf({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, savings: 30_000, assets: 300_000 }), lastsIn: 0.9 };
    const M = { spending: null, savings: null, assets: null };
    const answer = (p: FirePlanV2) => earliestStop({ plan: p, measured: M, count: ON, detailed: null, method: p.method }, usMarket());
    // The same answer; its own figures then place the milestone, once.
    const { resolution: withIt, ...rest } = answer({ ...plan, items: [idle] }) as { resolution: { ages: unknown[]; why: unknown[] } };
    const { resolution: without, ...restWithout } = answer(plan) as { resolution: { ages: unknown[]; why: unknown[] } };
    expect(rest).toEqual(restWithout);
    expect({ ...withIt, ages: [] as unknown[], why: [] as unknown[] }).toEqual(without);
    expect(withIt.ages.length).toBe(1);
    expect(withIt.ages[0]).toMatchObject({ end: null });
  });

  test('years after a milestone are never negative, as after a balance', () => {
    const plan = { ...base, items: [milestone('fifty', when({ at: 'age', age: 50 }))] };
    const d = draftOf(null, templateById('spending'));
    const on = (years: string) => checkDraft({ ...d, yearly: '1000', from: { ...d.from, pick: 'milestone', milestone: 'fifty', years } }, plan);
    expect(on('-2')).toEqual({ error: 'Years after a milestone can’t be below 0.' });
    expect('ok' in on('2') && on('2')).toMatchObject({ ok: { from: { anchor: { at: 'item', id: 'fifty', edge: 'start' }, offset: 2 } } });
  });
});
