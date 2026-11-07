import { describe, expect, test } from 'bun:test';
import { goalName, LIMIT_NAMES, movedLine, ownLine, tapLine, TUNE_BUSY, TUNE_FAILED, TUNE_GONE, TUNE_HELPER, TUNE_HOLDS, TUNE_IRMAA_UNKNOWN, TUNE_NEEDS_CONSTANT, TUNE_ONLY_ORDER, TUNE_ROW_SUB, TUNE_SORT, TUNE_SORTED, tunedFor, tunedHeading, tunedName, tunedNote, comesToTheSame, hasThisRule, orderLine, usedFailed, useLabel } from '@/components/plan-tune';
import { ABOUT_DETAIL } from '@/components/plan-drawdown';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import { conversionRun } from '@/lib/fire/compare-conversions';
import type { PlanItem } from '@/lib/fire/items';
import { DEFAULT_PLAN, type Measured } from '@/lib/fire/plan';
import { detailWork, type DetailedInput } from '@/lib/fire/plan-detail';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { lawFor } from '@/lib/fire/tax/law';
import { bracketTop, NO_STRATEGY, type Strategy } from '@/lib/fire/tax/rules';
import { isOwnSetting, tunedRows, tuneOrder, tuneRuns, tuneSettings, tuneUntil, type TuneAsk, type TuneLimit, type TuneRun } from '@/lib/fire/tune';
import { runTuneJob } from '@/lib/fire/tune-job';
import { genPlan, ON, rand } from './plan-gen';

// Tune to a goal's search (lib/fire/tune.ts): the settings each rule gets, how a row's
// setting is chosen, that a row is what the plan really comes to when using it moves
// nothing, what it does when it does, and the words a lawyer will read.

const account = (bucket: string, value: number, basis: number | null = null) => ({ owner: 'you', value, basis, account_id: bucket, bucket });
const group = (bucket: string, value: number, basis: number | null = null) => ({ bucket, accounts: [account(bucket, value, basis)], total: value });
const BUCKETS = {
  groups: [group('taxable', 140_000, 105_000), group('tax-deferred', 360_000), group('roth', 70_000), group('hsa', 25_000)],
  roth: [{ owner: 'you', amount: 45_000 }],
  total: 595_000,
} as unknown as Pick<BucketsToday, 'groups' | 'roth' | 'total'>;

const social = (id: string, owner: 'you' | 'partner', age: number, yearly: number): PlanItem => ({ id, label: id, kind: 'social-security', from: { anchor: { at: 'age', age }, offset: 0 }, until: null, once: null, yearly, replaces: null, every: null, times: null, inflationAdjusted: true, owner, beforeTax: true });

/** The tax plan's household (test/drawdown-prototype.test.ts). */
const PLAN: FirePlanV2 = {
  ...planOf({ ...DEFAULT_PLAN, age: 41, targetAge: 50, spending: 64_000, savings: 50_000, assets: 595_000, realReturn: 0.05, withdrawalRate: 0.04, fee: 0.001, stocksPct: 75, bondsPct: 25, rebalance: 'annual', rule: 'constant' }),
  partnerAge: 40,
  start: 'at-stop',
  items: [social('you', 'you', 67, 30_000), social('partner', 'partner', 68, 18_000)],
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

function figures(plan: FirePlanV2 = PLAN, input: DetailedInput = INPUT): PlanFigures {
  const f = planFigures(plan, M, { count: ON, detailed: detailWork(input) });
  if ('refused' in f) throw new Error('refused');
  return f;
}
const adopted = (plan: FirePlanV2, input: DetailedInput, strategy: Strategy) => {
  const f = figures(plan, { ...input, strategy });
  if (f.detail === null || 'failed' in f.detail) throw new Error('no run');
  return { f, d: f.detail.start };
};
const sim = (f: PlanFigures) => ('sim' in f.engine ? f.engine.sim.startBalance : null);

const settings = (over: Partial<DetailedInput> = {}, plan: FirePlanV2 = PLAN) => {
  const input = { ...INPUT, ...over };
  const f = figures(plan, input);
  const none = conversionRun(f, input, { ...input.strategy, conversions: { kind: 'none' }, convertUntil: null })!;
  return tuneSettings(f, input, none);
};
const countsByRow = (list: readonly { row: string }[]) => {
  const out: Record<string, number> = {};
  for (const s of list) out[s.row] = (out[s.row] ?? 0) + 1;
  return out;
};
const fill = (top: 0.1 | 0.12 | 0.22 | 0.24, convertUntil: number | null = null, order: Strategy['order'] = 'standard'): Strategy => ({ order, conversions: { kind: 'bracket', top }, convertUntil });
const aca = (top: 0.12 | 0.22, convertUntil: number | null = null, order: Strategy['order'] = 'standard'): Strategy => ({ order, conversions: { kind: 'aca-then-bracket', top }, convertUntil });
const noneOf = (order: Strategy['order'] = 'standard'): Strategy => ({ order, conversions: { kind: 'none' }, convertUntil: null });

describe('the settings each rule gets', () => {
  test('from the first year of the run to the year before required withdrawals, in both orders', () => {
    const list = settings();
    expect(countsByRow(list)).toEqual({ none: 2, 'fill-10': 50, 'fill-12': 50, 'fill-22': 50, aca: 100 });
    expect(list.length).toBe(252);
    const ages = list.filter((s) => s.row === 'fill-12').map((s) => s.strategy.convertUntil as number);
    expect(Math.min(...ages)).toBe(50);
    expect(Math.max(...ages)).toBe(74);
    expect(new Set(list.map((s) => s.strategy.order)).size).toBe(2);
  });

  test('the ACA rule only for someone on the ACA at some year of the run, or where it is the plan’s own', () => {
    const health = { ...INPUT.health, coverage: { kind: 'other' as const, yearly: 6_000 } };
    expect(countsByRow(settings({ health })).aca).toBeUndefined();
    expect(countsByRow(settings({ health, strategy: aca(0.22, 60) })).aca).toBe(100);
  });

  test('24% and a fixed amount only where they are the plan’s own, a fixed amount up to the 22% bracket’s top', () => {
    expect(countsByRow(settings()).fixed).toBeUndefined();
    expect(countsByRow(settings({ strategy: fill(0.24, 60) }))['fill-24']).toBe(50);
    const fixed = settings({ strategy: { order: 'standard', conversions: { kind: 'fixed', yearly: 40_000 }, convertUntil: 60 } }).filter((s) => s.row === 'fixed');
    // $5,000 to $210,000, the last step under $211,400, for 25 ages and both orders.
    expect(fixed.length).toBe(42 * 25 * 2);
    const single = settings({ filing: 'single', strategy: { order: 'standard', conversions: { kind: 'fixed', yearly: 40_000 }, convertUntil: 60 } }).filter((s) => s.row === 'fixed');
    // On a single return the top is $105,700, and the age is yours alone.
    expect(Math.max(...single.map((s) => (s.strategy.conversions as { yearly: number }).yearly))).toBe(105_000);
  });

  test('a person’s own amount off the steps, or above them, stays in', () => {
    const oddly = settings({ strategy: { order: 'standard', conversions: { kind: 'fixed', yearly: 41_250 }, convertUntil: 60 } });
    expect(oddly.filter((s) => s.row === 'fixed' && (s.strategy.conversions as { yearly: number }).yearly === 41_250).length).toBe(50);
    const large = settings({ strategy: { order: 'standard', conversions: { kind: 'fixed', yearly: 300_000 }, convertUntil: 60 } });
    expect(large.filter((s) => s.row === 'fixed' && (s.strategy.conversions as { yearly: number }).yearly === 300_000).length).toBe(50);
  });

  test('the plan’s own setting is there whatever its age', () => {
    const own = fill(0.12, 90);
    const list = settings({ strategy: own });
    expect(list.filter((s) => JSON.stringify(s.strategy) === JSON.stringify(own)).length).toBe(1);
    expect(countsByRow(list)['fill-12']).toBe(51);
  });

  test('once required withdrawals have started, only None and the plan’s own', () => {
    const late: FirePlanV2 = { ...PLAN, age: 76, partnerAge: 75, targetAge: 76 };
    expect(countsByRow(settings({}, late))).toEqual({ none: 2 });
    expect(countsByRow(settings({ strategy: fill(0.12, 80) }, late))).toEqual({ none: 2, 'fill-12': 1 });
  });

  test('the age a rule runs to by default is your own on a single return', () => {
    expect(tuneUntil({ plan: PLAN }, INPUT)).toBe(74);
    expect(tuneUntil({ plan: { ...PLAN, partnerAge: 30 } }, INPUT)).toBe(74);
    expect(tuneUntil({ plan: { ...PLAN, partnerAge: 50 } }, INPUT)).toBe(65);
    expect(tuneUntil({ plan: { ...PLAN, partnerAge: 50 } }, { ...INPUT, filing: 'single' })).toBe(74);
  });
});

const run = (over: Partial<TuneRun> = {}): TuneRun => ({ row: 'fill-12', strategy: fill(0.12, 60), left: 1_000_000, cost: 500_000, short: null, unpaid: 0, converted: 100_000, crosses: { aca: 0, irmaa: 0, 'bracket-22': 0 }, ...over });
const ASK_LEFT: TuneAsk = { goal: 'left', limits: [] };
const ASK_COST: TuneAsk = { goal: 'cost', limits: [] };
const OWN = NO_STRATEGY;
const first = (a: TuneRun, b: TuneRun, ask: TuneAsk = ASK_LEFT, own: Strategy = OWN) => {
  expect(tuneOrder(a, b, ask, own, 74)).toBeLessThan(0);
  expect(tuneOrder(b, a, ask, own, 74)).toBeGreaterThan(0);
};

describe('how a row’s setting is chosen', () => {
  test('first, the fewest years breaking the limits picked, whatever it leaves', () => {
    const ask: TuneAsk = { goal: 'left', limits: ['aca'] };
    first(run({ left: 1, crosses: { aca: 1, irmaa: 0, 'bracket-22': 0 } }), run({ left: 9_000_000, crosses: { aca: 2, irmaa: 0, 'bracket-22': 0 } }), ask);
    // A limit not picked counts for nothing.
    first(run({ left: 9, crosses: { aca: 9, irmaa: 9, 'bracket-22': 9 } }), run({ left: 1 }), ASK_LEFT);
    // Limits add up.
    first(run({ crosses: { aca: 1, irmaa: 1, 'bracket-22': 0 } }), run({ crosses: { aca: 0, irmaa: 3, 'bracket-22': 0 } }), { goal: 'left', limits: ['aca', 'irmaa'] });
  });

  test('then one that lasts: the least cost is never one that is cheap because its money ran out', () => {
    first(run({ cost: 900_000, left: 1 }), run({ cost: 10, left: 9_000_000, short: 90 }), ASK_COST);
    first(run({ left: 1 }), run({ left: 9_000_000, short: 94 }), ASK_LEFT);
  });

  test('then the later to run short, then less unpaid', () => {
    first(run({ short: 90, cost: 900_000 }), run({ short: 80, cost: 10 }), ASK_COST);
    first(run({ short: 80, unpaid: 100, cost: 900_000, left: 0 }), run({ short: 80, unpaid: 900, cost: 10, left: 0 }), ASK_COST);
  });

  test('then the goal, to the dollar', () => {
    first(run({ left: 2_000_000, cost: 900_000 }), run({ left: 1_000_000, cost: 1 }), ASK_LEFT);
    first(run({ cost: 1, left: 1 }), run({ cost: 900_000, left: 9_000_000 }), ASK_COST);
    // Under a dollar apart is no difference: the tie's next step says.
    first(run({ left: 1_000_000.1, converted: 5 }), run({ left: 1_000_000.4, converted: 9 }), ASK_LEFT);
  });

  test('a tie keeps the plan’s own', () => {
    const own = aca(0.22, 59);
    first(run({ strategy: own, converted: 9 }), run({ strategy: aca(0.12, 52), converted: 1 }), ASK_LEFT, own);
    // An age not set is the age it runs to by default.
    const byDefault = aca(0.22);
    first(run({ strategy: aca(0.22, 74), converted: 9 }), run({ strategy: aca(0.12, 52), converted: 1 }), ASK_LEFT, byDefault);
  });

  test('then what converts less, then the earlier end, then the lower top or amount, then your order', () => {
    first(run({ converted: 1, strategy: fill(0.12, 70) }), run({ converted: 2, strategy: fill(0.12, 60) }));
    first(run({ strategy: fill(0.12, 60) }), run({ strategy: fill(0.12, 70) }));
    first(run({ strategy: aca(0.12, 60) }), run({ strategy: aca(0.22, 60) }));
    first(run({ strategy: { order: 'standard', conversions: { kind: 'fixed', yearly: 5_000 }, convertUntil: 60 } }), run({ strategy: { order: 'standard', conversions: { kind: 'fixed', yearly: 10_000 }, convertUntil: 60 } }));
    first(run({ strategy: fill(0.12, 60, 'standard') }), run({ strategy: fill(0.12, 60, 'roth-before-deferred') }));
    first(run({ strategy: fill(0.12, 60, 'roth-before-deferred') }), run({ strategy: fill(0.12, 60, 'standard') }), ASK_LEFT, noneOf('roth-before-deferred'));
  });

  test('the same in any order, so a row’s pick doesn’t depend on how the runs came', () => {
    const f = figures();
    const runs = tuneRuns(f, INPUT);
    const reversed = [...runs].reverse();
    for (const ask of [ASK_LEFT, ASK_COST, { goal: 'left', limits: ['aca'] } as TuneAsk]) expect(tunedRows(reversed, ask, OWN, 74).map((r) => r.run.strategy)).toEqual(tunedRows(runs, ask, OWN, 74).map((r) => r.run.strategy));
  });
});

describe('each rule’s row', () => {
  const NONE = run({ row: 'none', strategy: noneOf(), left: 1_000_000, cost: 500_000 });
  const rowsOf = (runs: TuneRun[], ask: TuneAsk = ASK_LEFT, own: Strategy = OWN) => tunedRows(runs, ask, own, 74);
  const rowOf = (runs: TuneRun[], key: string, ask: TuneAsk = ASK_LEFT, own: Strategy = OWN) => rowsOf(runs, ask, own).find((r) => r.key === key)!;

  test('Compare’s order, however the runs came and whatever they leave', () => {
    const runs = [run({ row: 'aca', strategy: aca(0.12, 60), left: 9 }), run({ row: 'fill-22', strategy: fill(0.22, 60) }), NONE, run({ row: 'fixed', strategy: { order: 'standard', conversions: { kind: 'fixed', yearly: 5_000 }, convertUntil: 60 } }), run({ row: 'fill-10', strategy: fill(0.1, 60), left: 9_000_000 })];
    expect(rowsOf(runs).map((r) => r.key)).toEqual(['none', 'fill-10', 'fill-22', 'aca', 'fixed']);
  });

  test('says whether it beats None on the goal, None itself saying nothing', () => {
    const runs = [NONE, run({ row: 'fill-10', strategy: fill(0.1, 60), left: 2_000_000, cost: 900_000 }), run({ row: 'fill-12', strategy: fill(0.12, 60), left: 500_000, cost: 100_000 })];
    expect(rowOf(runs, 'none').beatsNone).toBeNull();
    expect(rowOf(runs, 'fill-10').beatsNone).toBe(true);
    expect(rowOf(runs, 'fill-12').beatsNone).toBe(false);
    expect(rowOf(runs, 'fill-10', ASK_COST).beatsNone).toBe(false);
    expect(rowOf(runs, 'fill-12', ASK_COST).beatsNone).toBe(true);
  });

  test('a tie with None isn’t beating it, to the dollar', () => {
    expect(rowOf([NONE, run({ row: 'fill-10', strategy: fill(0.1, 60), left: 1_000_000.3 })], 'fill-10').beatsNone).toBe(false);
  });

  test('a figure that reads ahead of a run that is behind None is neither: nothing the words could say is true of it', () => {
    const none = run({ row: 'none', strategy: noneOf(), left: 0, cost: 900, short: 90, unpaid: 100 });
    const row = (over: Partial<TuneRun>) => rowOf([none, run({ row: 'fill-22', strategy: fill(0.22, 50), left: 0, ...over })], 'fill-22', ASK_COST);
    // Cheaper, for leaving more unpaid or running out sooner.
    expect(row({ cost: 800, short: 90, unpaid: 200 }).beatsNone).toBeNull();
    expect(row({ cost: 800, short: 85, unpaid: 100 }).beatsNone).toBeNull();
    // No cheaper, and behind: the words are true.
    expect(row({ cost: 950, short: 90, unpaid: 200 }).beatsNone).toBe(false);
    expect(row({ cost: 900, short: 90, unpaid: 200 }).beatsNone).toBe(false);
    // Ahead, whatever it costs.
    expect(row({ cost: 950, short: 92, unpaid: 100 }).beatsNone).toBe(true);
    // The same on what is left.
    const lasting = run({ row: 'none', strategy: noneOf(), left: 500, short: null, unpaid: 0 });
    expect(rowOf([lasting, run({ row: 'fill-10', strategy: fill(0.1, 50), left: 800, short: 90, unpaid: 10 })], 'fill-10').beatsNone).toBeNull();
    expect(rowOf([lasting, run({ row: 'fill-10', strategy: fill(0.1, 50), left: 0, short: 90, unpaid: 10 })], 'fill-10').beatsNone).toBe(false);
  });

  test('None is tuned over the order: a row that beats its standard order alone doesn’t beat None', () => {
    const runs = [NONE, run({ row: 'none', strategy: noneOf('roth-before-deferred'), left: 3_000_000 }), run({ row: 'fill-10', strategy: fill(0.1, 60), left: 2_000_000 })];
    expect(rowOf(runs, 'none').run.strategy.order).toBe('roth-before-deferred');
    expect(rowOf(runs, 'fill-10').beatsNone).toBe(false);
  });

  test('a limit rules a setting out, and a row with none inside it shows its closest and says what it crosses', () => {
    const inside = run({ row: 'fill-10', strategy: fill(0.1, 55), left: 100 });
    const over = run({ row: 'fill-10', strategy: fill(0.1, 60), left: 9_000_000, crosses: { aca: 2, irmaa: 0, 'bracket-22': 0 } });
    const ask: TuneAsk = { goal: 'left', limits: ['aca'] };
    expect(rowOf([NONE, inside, over], 'fill-10', ask).run).toBe(inside);
    expect(rowOf([NONE, inside, over], 'fill-10', ask).crossing).toEqual([]);
    const closest = rowOf([NONE, over, run({ ...over, left: 1, crosses: { aca: 5, irmaa: 0, 'bracket-22': 0 } })], 'fill-10', ask);
    expect(closest.run).toBe(over);
    expect(closest.crossing).toEqual([{ limit: 'aca', years: 2 }]);
    expect(closest.beatsNone).toBeNull();
  });

  test('where None breaks a limit, it says so and no row is compared with it', () => {
    const none = run({ row: 'none', strategy: noneOf(), crosses: { aca: 1, irmaa: 0, 'bracket-22': 0 } });
    const rows = rowsOf([none, run({ row: 'fill-10', strategy: fill(0.1, 60), left: 9_000_000 })], { goal: 'left', limits: ['aca'] });
    expect(rows[0].crossing).toEqual([{ limit: 'aca', years: 1 }]);
    expect(rows[1].crossing).toEqual([]);
    expect(rows[1].beatsNone).toBeNull();
  });

  test('marks the plan’s own, an age not set being the age it runs to by default', () => {
    expect(rowOf([NONE, run({ strategy: fill(0.12, 74) })], 'fill-12', ASK_LEFT, fill(0.12)).mine).toBe(true);
    expect(rowOf([NONE, run({ strategy: fill(0.12, 74) })], 'fill-12', ASK_LEFT, fill(0.12, 60)).mine).toBe(false);
    expect(rowOf([NONE], 'none', ASK_LEFT, NO_STRATEGY).mine).toBe(true);
    expect(rowOf([NONE], 'none', ASK_LEFT, noneOf('roth-before-deferred')).mine).toBe(false);
    expect(isOwnSetting(fill(0.12, 74, 'roth-before-deferred'), fill(0.12), 74)).toBe(false);
  });

  test('the ACA rule’s 12% and 22% come to the same dollar before 65: yours is kept, else the lower', () => {
    const f = figures();
    const runs = tuneRuns(f, INPUT);
    const atSameAge = (top: number) => runs.find((r) => r.row === 'aca' && r.strategy.order === 'standard' && r.strategy.convertUntil === 56 && (r.strategy.conversions as { top: number }).top === top)!;
    expect(Math.round(atSameAge(0.12).left)).toBe(Math.round(atSameAge(0.22).left));
    const mine = tunedRows(runs, ASK_LEFT, OWN, 74).find((r) => r.key === 'aca')!;
    expect(mine.run.strategy.conversions).toEqual({ kind: 'aca-then-bracket', top: 0.12 });
    const own = aca(0.22, 56);
    const kept = tunedRows(tuneRuns(f, { ...INPUT, strategy: own }), ASK_LEFT, own, 74).find((r) => r.key === 'aca')!;
    expect(kept.run.strategy).toEqual(own);
    expect(kept.mine).toBe(true);
  });
});

describe('a row against what the plan comes to once it’s used', () => {
  const ASKS: TuneAsk[] = [ASK_LEFT, ASK_COST, { goal: 'left', limits: ['aca'] }, { goal: 'cost', limits: ['bracket-22'] }, { goal: 'left', limits: ['aca', 'irmaa', 'bracket-22'] }];
  const LIMITS: Record<TuneLimit, (y: { care: { overLimit: boolean; people: { irmaaTier: number }[] }; law: { topRate: number } }) => boolean> = {
    aca: (y) => y.care.overLimit,
    irmaa: (y) => y.care.people.some((p) => p.irmaaTier > 0),
    'bracket-22': (y) => y.law.topRate > 0.22,
  };

  test('on generated plans: nothing in a row sorts ahead of its pick, what a row says of None is true of its figures, and where using it moves nothing a row is what it comes to', () => {
    let compared = 0;
    let plans = 0;
    let behind = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const g = rand(seed);
      const plan: FirePlanV2 = { ...planOf({ ...genPlan(g), age: 30 + g.int(0, 30), rule: 'constant' }), partnerAge: g.chance(0.5) ? 30 + g.int(0, 30) : null };
      const input: DetailedInput = { ...INPUT, filing: plan.partnerAge === null ? 'single' : 'joint', strategy: g.pick([NO_STRATEGY, fill(0.12, 60), aca(0.12), fill(0.22, null, 'roth-before-deferred')]) };
      const f = planFigures(plan, M, { count: ON, detailed: detailWork(input) });
      if ('refused' in f || f.detail === null || 'failed' in f.detail) continue;
      plans++;
      const until = tuneUntil(f, input);
      const runs = tuneRuns(f, input);
      for (const ask of ASKS) {
        const rows = tunedRows(runs, ask, input.strategy, until);
        const none = rows.find((r) => r.key === 'none')!;
        for (const row of rows) {
          for (const other of runs) if (other.row === row.key) expect(tuneOrder(other, row.run, ask, input.strategy, until)).toBeGreaterThanOrEqual(0);
          if (row.beatsNone === false) {
            behind++;
            if (ask.goal === 'left') expect(Math.round(row.run.left)).toBeLessThanOrEqual(Math.round(none.run.left));
            else expect(Math.round(row.run.cost)).toBeGreaterThanOrEqual(Math.round(none.run.cost));
          }
          const used = planFigures(plan, M, { count: ON, detailed: detailWork({ ...input, strategy: row.run.strategy }) });
          if ('refused' in used || used.detail === null || 'failed' in used.detail) continue;
          if (used.view.stopAge !== f.view.stopAge || sim(used) !== sim(f)) continue;
          compared++;
          const d = used.detail.start;
          expect(d.leftAtEnd).toBeCloseTo(row.run.left, 2);
          expect(d.taxAndHealth).toBeCloseTo(row.run.cost, 2);
          expect(d.runsOutAt).toBe(row.run.short);
          const crossed = new Set(row.crossing.map((c) => c.limit));
          for (const limit of ask.limits) if (!crossed.has(limit)) expect(d.years.filter(LIMITS[limit]).length).toBe(0);
        }
      }
    }
    // So this says something: most plans and rows got this far.
    expect(plans).toBeGreaterThan(20);
    expect(compared).toBeGreaterThan(300);
    expect(behind).toBeGreaterThan(50);
  }, 120_000);

  test('the household: a row is what the plan comes to, to the cent', () => {
    const runs = tuneRuns(figures(), INPUT);
    for (const ask of ASKS) {
      for (const row of tunedRows(runs, ask, OWN, 74)) {
        const { d, f } = adopted(PLAN, INPUT, row.run.strategy);
        expect(sim(f)).toBe(sim(figures()));
        expect(d.leftAtEnd).toBeCloseTo(row.run.left, 2);
        expect(d.taxAndHealth).toBeCloseTo(row.run.cost, 2);
      }
    }
  });

  // Why the table can't say it's what Use gives, and a list of these plans wouldn't do:
  // each moves another way. The sheet shows the used figures and what moved.
  const item = (over: Partial<PlanItem>): PlanItem => ({ id: 'x', label: 'x', kind: 'part-time', from: { anchor: { at: 'age', age: 60 }, offset: 0 }, until: null, once: null, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: 'you', beforeTax: true, ...over });
  const moving: [string, FirePlanV2, DetailedInput, Strategy][] = [
    ['a stop at FI', { ...PLAN, stopAtFi: true }, INPUT, fill(0.22, 60)],
    ['part-time work at FI', { ...PLAN, items: [...PLAN.items, item({ from: { anchor: { at: 'fi' }, offset: 0 }, yearly: 20_000 })] }, INPUT, fill(0.22, 60)],
    ['a change at a balance', { ...PLAN, items: [...PLAN.items, item({ kind: 'spending', from: { anchor: { at: 'balance', amount: 2_000_000 }, offset: 0 }, yearly: -10_000, owner: null, beforeTax: false })] }, INPUT, fill(0.1, 74, 'roth-before-deferred')],
    ['a one-off before the stop, in the other order', { ...PLAN, targetAge: 62, items: [...PLAN.items, item({ kind: 'one-off', once: 1_200_000 })] }, INPUT, noneOf('roth-before-deferred')],
    ['a before-tax pension before the stop', { ...PLAN, items: [...PLAN.items, item({ kind: 'pension', from: { anchor: { at: 'age', age: 44 }, offset: 0 }, until: { anchor: { at: 'age', age: 49 }, offset: 0 }, yearly: 40_000 })] }, INPUT, fill(0.22, 60)],
  ];
  for (const [name, plan, input, strategy] of moving) {
    test(`using a rule moves ${name}: the table holds it, and the two differ`, () => {
      const f = figures(plan, input);
      const row = conversionRun(f, input, strategy)!;
      const { d } = adopted(plan, input, strategy);
      expect(Math.abs(row.leftAtEnd - d.leftAtEnd) + Math.abs(row.taxAndHealth - d.taxAndHealth)).toBeGreaterThan(100);
    });
  }

  test('a saving below zero, sold through the other order, moves it too', () => {
    const g = (bucket: string, value: number, basis: number | null = null) => group(bucket, value, basis);
    const buckets = { groups: [g('taxable', 5_000, 5_000), g('tax-deferred', 900_000), g('roth', 500_000)], roth: [{ owner: 'you', amount: 500_000 }], total: 1_405_000 } as unknown as DetailedInput['buckets'];
    const plan: FirePlanV2 = { ...PLAN, age: 60, partnerAge: 59, targetAge: 66, assets: 1_405_000, savings: -80_000 };
    const input: DetailedInput = { ...INPUT, buckets, strategy: noneOf('roth-before-deferred') };
    const f = figures(plan, input);
    const row = conversionRun(f, input, noneOf('standard'))!;
    const { d } = adopted(plan, input, noneOf('standard'));
    expect(Math.abs(row.leftAtEnd - d.leftAtEnd)).toBeGreaterThan(1_000);
  });
});

describe('what the limits read, against the engine', () => {
  const runOf = (strategy: Strategy, plan: FirePlanV2 = PLAN, input: DetailedInput = INPUT) => {
    const d = conversionRun(figures(plan, input), input, strategy);
    if (d === null) throw new Error('no run');
    return d;
  };
  // A large tax-deferred balance: required withdrawals reach both of these.
  const LARGE: FirePlanV2 = { ...PLAN, assets: 5_000_000 };
  const LARGE_INPUT: DetailedInput = { ...INPUT, buckets: { groups: [group('tax-deferred', 5_000_000)], roth: [], total: 5_000_000 } as unknown as DetailedInput['buckets'], savingsSplit: [{ bucket: 'tax-deferred', share: 1 }] };

  test('the ACA’s: a year over the limit has someone over its cliff, past 400% of the poverty line', () => {
    let over = 0;
    for (const s of [noneOf(), fill(0.22, 60), fill(0.12, 74), aca(0.12, 59)]) {
      for (const y of runOf(s).years) {
        const onAca = y.care.people.some((p) => p.status === 'aca');
        if (y.care.overLimit) {
          over++;
          expect(y.care.people.some((p) => p.status === 'over-cliff')).toBe(true);
          expect(y.care.povertyPercent).toBeGreaterThan(400);
        } else if (onAca) expect(y.care.povertyPercent).toBeLessThanOrEqual(400);
      }
    }
    expect(over).toBeGreaterThan(0);
  });

  test('IRMAA’s: a tier in a year is the income two years before over the first line, and only on Medicare', () => {
    const first = INPUT.law.medicare.irmaa.joint[0].over * (1 + INPUT.inflation) ** 2;
    const d = runOf(noneOf(), LARGE, LARGE_INPUT);
    let tiers = 0;
    d.years.forEach((y, i) => {
      for (const p of y.care.people) {
        if (p.status === 'medicare' && i >= 2) expect(p.irmaaTier > 0).toBe(d.years[i - 2].law.magiIrmaa > first);
        if (p.irmaaTier === 0) continue;
        tiers++;
        expect(p.status).toBe('medicare');
      }
    });
    expect(tiers).toBeGreaterThan(0);
  });

  test('the 22% bracket’s: a year past it has ordinary taxable income over that bracket’s top, and only then', () => {
    const top = bracketTop(INPUT.law, 'joint', 0.22);
    let past = 0;
    for (const y of runOf(noneOf(), LARGE, LARGE_INPUT).years) {
      expect(y.law.topRate > 0.22).toBe(y.law.ordinaryTaxable > top);
      if (y.law.topRate > 0.22) past++;
    }
    expect(past).toBeGreaterThan(0);
  });
});

describe('the job', () => {
  const job = { tune: true as const, plan: PLAN, measured: M, count: ON, detailed: INPUT };

  test('its answer is the page’s own figures’ runs, and plain data both ways', () => {
    const result = runTuneJob(job);
    if (!result.ok) throw new Error(result.error);
    expect(result.runs).toEqual(tuneRuns(figures(), INPUT));
    expect(structuredClone(job)).toEqual(job);
    expect(structuredClone(result)).toEqual(result);
  });

  test('what can’t run is an error, never the job’s end', () => {
    expect(runTuneJob({ ...job, plan: null as unknown as FirePlanV2 })).toMatchObject({ ok: false });
    expect(runTuneJob({ ...job, plan: { ...PLAN, age: null } })).toMatchObject({ ok: false });
  });
});

describe('the words', () => {
  const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
  const row = { run: run({ strategy: fill(0.12, 60, 'roth-before-deferred') }), crossing: [{ limit: 'aca' as const, years: 2 }, { limit: 'irmaa' as const, years: 1 }, { limit: 'bracket-22' as const, years: 3 }], beatsNone: false };

  test('a row’s name', () => {
    expect(tunedName(noneOf(), 50, money)).toBe('None');
    expect(tunedName(fill(0.1, 50), 50, money)).toBe('Fill the 10% bracket, at 50 only');
    // Its floor runs on past its age, so one age isn't all of it.
    expect(tunedName(aca(0.12, 50), 50, money)).toBe('ACA limit, then the 12% bracket, until 50');
    expect(tunedName(aca(0.12, 59), 50, money)).toBe('ACA limit, then the 12% bracket, until 59');
    expect(tunedName({ order: 'standard', conversions: { kind: 'fixed', yearly: 40_000 }, convertUntil: 60 }, 50, money)).toBe('$40,000 a year, until 60');
  });

  test('a row’s note: its order where it isn’t yours, what it crosses, and how it stands to None', () => {
    expect(tunedNote(row, noneOf(), 'left')).toBe('Roth before tax-deferred · Crosses the ACA limit in 2 years · Pays IRMAA’s surcharge in 1 year · Goes past the 22% bracket in 3 years · leaves no more than None');
    expect(tunedNote({ ...row, crossing: [] }, row.run.strategy, 'cost')).toBe('Costs no less than None');
    expect(tunedNote({ ...row, crossing: [], beatsNone: true }, row.run.strategy, 'left')).toBe('');
    expect(tunedNote({ ...row, crossing: [], beatsNone: null }, noneOf(), 'left')).toBe('Roth before tax-deferred');
  });

  test('what your plan has now, on the goal’s figure', () => {
    const a = { goal: 'left' as const, own: fill(0.12), until: 74, left: 3_660_060, cost: 497_310, short: null, copyOpen: false };
    expect(ownLine(a, money)).toBe('Your plan’s rule, until 74, leaves $3,660,060.');
    expect(ownLine({ ...a, goal: 'cost' }, money)).toBe('Your plan’s rule, until 74, costs $497,310 in tax and health.');
    expect(ownLine({ ...a, short: 94 }, money)).toBe('Your plan’s rule, until 74, runs short at 94.');
    expect(ownLine({ ...a, own: noneOf() }, money)).toBe('With None, your plan leaves $3,660,060.');
    expect(ownLine({ ...a, copyOpen: true }, money)).toBe('This copy’s rule, until 74, leaves $3,660,060.');
    expect(ownLine({ ...a, own: fill(0.12, 60), copyOpen: true, goal: 'cost' }, money)).toBe('This copy’s rule, until 60, costs $497,310 in tax and health.');
  });

  test('what moved once used', () => {
    const a = { stop: [54, 57] as [number, number], start: [2_007_610, 2_481_685] as [number, number], copyOpen: false };
    expect(movedLine(a, money)).toBe('Once used, your plan stops at 57, not 54, and starts from $2,481,685, not $2,007,610, so this differs from the table.');
    expect(movedLine({ ...a, start: null }, money)).toBe('Once used, your plan stops at 57, not 54, so this differs from the table.');
    expect(movedLine({ ...a, stop: null, copyOpen: true }, money)).toBe('Once used, this copy starts from $2,481,685, not $2,007,610, so this differs from the table.');
    expect(movedLine({ stop: null, start: null, copyOpen: false }, money)).toBe('Once used, more of your plan moves with this rule, so this differs from the table.');
  });

  test('nothing is called best or better, or recommended, or what to do', () => {
    const about = ABOUT_DETAIL.standIns.find((s) => s.startsWith('Tune to a goal'))!;
    expect(about).toContain('keeps your plan’s own');
    const every = [
      TUNE_HELPER, TUNE_ROW_SUB, TUNE_NEEDS_CONSTANT, TUNE_BUSY, TUNE_FAILED, TUNE_GONE, TUNE_SORT, TUNE_HOLDS, TUNE_ONLY_ORDER, TUNE_IRMAA_UNKNOWN, about,
      ...Object.values(LIMIT_NAMES),
      goalName('left', 95), goalName('cost', 95), tunedHeading('left', 95), tunedHeading('cost', 95),
      tunedNote(row, noneOf(), 'left'), tunedNote(row, noneOf(), 'cost'),
      tunedFor(2026, 0.021), tapLine(false), tapLine(true), orderLine('standard', 'roth-before-deferred', false),
      useLabel(false), useLabel(true), hasThisRule(false), hasThisRule(true), comesToTheSame(false), comesToTheSame(true), usedFailed(false), usedFailed(true),
      movedLine({ stop: [54, 57], start: [1, 2], copyOpen: false }, money), movedLine({ stop: null, start: null, copyOpen: true }, money),
      ownLine({ goal: 'left', own: noneOf(), until: 74, left: 1, cost: 1, short: null, copyOpen: false }, money),
    ];
    for (const words of every) {
      expect(words).not.toMatch(/\b(best|better|should|optimal|ideal|optimi[sz]e|winner|top pick)\b/i);
      expect(words.replace('doesn’t recommend', '')).not.toMatch(/recommend/i);
    }
    // The one place "best" is said, to say it isn't, shows only once the person has sorted.
    expect(TUNE_SORTED).toBe('Sorted by your goal because you asked. Nothing here is called best.');
    expect(TUNE_HELPER).toContain('It doesn’t recommend one');
  });
});
