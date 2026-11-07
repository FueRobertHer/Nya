// lib/fire/tune.ts
//
// Tune to a goal (the tax plan's D4): each conversion rule's settings, run from the
// plan's own start as Compare conversions runs them, and for a goal the person picks,
// with any limits, each rule's setting that comes closest. One row per rule: no rule is
// picked over another, and what the person does with the rows is theirs.
//
// In two parts, so a goal or a limit never needs another run. `tuneRuns` is the slow one
// and doesn't depend on them, so it runs in a worker (lib/fire/tune-job.ts). `tunedRows`
// is instant. A limit is a filter on what a setting's years did, not a ceiling in them:
// a run under a ceiling the rule doesn't hold isn't one the person could then have.
//
// A run holds the plan's stop, its start and what is timed on them where they are, so
// the rows differ only by the rule. Once a rule is used those can move with it, so a row
// isn't always what Use gives: components/PlanTune.tsx runs that once, and says so.

import { conversionRun } from './compare-conversions';
import type { Drawdown } from './drawdown';
import type { DetailedInput } from './plan-detail';
import type { PlanFigures } from './plan-figures';
import { bracketTop, defaultUntil, type Strategy } from './tax/rules';

export type TuneGoal = 'left' | 'cost';
export type TuneLimit = 'aca' | 'irmaa' | 'bracket-22';
export type TuneAsk = { goal: TuneGoal; limits: readonly TuneLimit[] };

/** One setting's run, in figures: 252 of these go to the page, not 252 drawdowns. */
export type TuneRun = {
  /** Which rule's row it is in. */
  row: string;
  strategy: Strategy;
  left: number;
  cost: number;
  /** Your age when it can't pay; null when it lasts. */
  short: number | null;
  /** What the years couldn't pay, in all. */
  unpaid: number;
  converted: number;
  /** The years that break each limit. */
  crosses: Record<TuneLimit, number>;
};

export type TunedRow = {
  key: string;
  run: TuneRun;
  /** The limits asked of it that its setting still breaks: every setting of the row
   *  breaks one, and this is the closest. */
  crossing: { limit: TuneLimit; years: number }[];
  /** Whether it beats None on the goal. False only where the goal's own figure says the
   *  same, so the words on it are true of the row. Null on None, where either breaks a
   *  limit, and where that figure reads ahead of a run that is behind (it ran out sooner,
   *  or left more unpaid). */
  beatsNone: boolean | null;
  /** The plan's own setting. */
  mine: boolean;
};

const FILLED = [0.1, 0.12, 0.22] as const;
const ORDERS: readonly Strategy['order'][] = ['standard', 'roth-before-deferred'];
/** The steps of a fixed amount, up to the top of the 22% bracket: the highest Tune fills. */
const FIXED_STEP = 5_000;

const fillRow = (top: number) => `fill-${Math.round(top * 100)}`;

function rowOf(rule: Strategy['conversions']): string {
  switch (rule.kind) {
    case 'none':
      return 'none';
    case 'bracket':
      return fillRow(rule.top);
    case 'aca-then-bracket':
      return 'aca';
    case 'fixed':
      return 'fixed';
  }
}

/** Compare's order, and what only the plan's own rule brings. */
const ROW_ORDER = ['none', 'fill-10', 'fill-12', 'fill-22', 'fill-24', 'aca', 'fixed'];

/** Whether it is the plan's own setting: an age not set is the age it runs to by default. */
export function isOwnSetting(s: Strategy, own: Strategy, until: number): boolean {
  if (s.order !== own.order || JSON.stringify(s.conversions) !== JSON.stringify(own.conversions)) return false;
  return s.conversions.kind === 'none' || (s.convertUntil ?? until) === (own.convertUntil ?? until);
}

/** The age a plan's rule runs to by default, on the return its years are worked on. */
export function tuneUntil(f: Pick<PlanFigures, 'plan'>, input: Pick<DetailedInput, 'filing' | 'rmdAges'>): number {
  const { age, partnerAge } = f.plan;
  return defaultUntil(input.rmdAges, { age: age as number, partnerAge: input.filing === 'joint' ? partnerAge : null });
}

/** Each rule's settings, the plan's own always among them. */
export function tuneSettings(f: Pick<PlanFigures, 'plan'>, input: DetailedInput, none: Pick<Drawdown, 'years' | 'aca'>): { row: string; strategy: Strategy }[] {
  const own = input.strategy;
  const rule = own.conversions;
  const until = tuneUntil(f, input);
  const first = none.years[0].age;
  const ages: number[] = [];
  for (let age = first; age <= until; age++) ages.push(age);

  const out: { row: string; strategy: Strategy }[] = ORDERS.map((order) => ({ row: 'none', strategy: { order, conversions: { kind: 'none' }, convertUntil: null } }));
  const add = (conversions: Strategy['conversions']) => {
    for (const order of ORDERS) for (const convertUntil of ages) out.push({ row: rowOf(conversions), strategy: { order, conversions, convertUntil } });
  };
  for (const top of FILLED) add({ kind: 'bracket', top });
  if (rule.kind === 'bracket' && rule.top === 0.24) add(rule);
  if (none.aca.on > 0 || rule.kind === 'aca-then-bracket') {
    add({ kind: 'aca-then-bracket', top: 0.12 });
    add({ kind: 'aca-then-bracket', top: 0.22 });
  }
  if (rule.kind === 'fixed') {
    const top = bracketTop(input.law, input.filing === 'joint' && f.plan.partnerAge !== null ? 'joint' : 'single', 0.22);
    for (let yearly = FIXED_STEP; yearly <= top; yearly += FIXED_STEP) add({ kind: 'fixed', yearly });
    if (rule.yearly % FIXED_STEP !== 0 || rule.yearly > top) add(rule);
  }
  // The form takes an age the search doesn't try, and required withdrawals may have started.
  if (!out.some((s) => isOwnSetting(s.strategy, own, until))) out.push({ row: rowOf(rule), strategy: own });
  return out;
}

/** The years of a drawdown that break each limit. */
export function crossesOf(d: Pick<Drawdown, 'years'>): Record<TuneLimit, number> {
  const years = (test: (y: Drawdown['years'][number]) => boolean) => d.years.filter(test).length;
  return {
    aca: years((y) => y.care.overLimit),
    irmaa: years((y) => y.care.people.some((p) => p.irmaaTier > 0)),
    'bracket-22': years((y) => y.law.topRate > 0.22),
  };
}

/** The limits asked of it that those years break. */
export const crossingOf = (crosses: Record<TuneLimit, number>, limits: readonly TuneLimit[]) => limits.filter((limit) => crosses[limit] > 0).map((limit) => ({ limit, years: crosses[limit] }));

function runOf(row: string, strategy: Strategy, d: Drawdown): TuneRun {
  return {
    row,
    strategy,
    left: d.leftAtEnd,
    cost: d.taxAndHealth,
    short: d.runsOutAt,
    unpaid: d.years.reduce((n, y) => n + y.shortfall, 0),
    converted: d.years.reduce((n, y) => n + y.conversion, 0),
    crosses: crossesOf(d),
  };
}

/** Every rule's settings, run. Throws where the plan's start can't run, which the job says. */
export function tuneRuns(f: PlanFigures, input: DetailedInput): TuneRun[] {
  const none = conversionRun(f, input, { order: input.strategy.order, conversions: { kind: 'none' }, convertUntil: null });
  if (none === null) throw new Error('This start can’t be run.');
  return tuneSettings(f, input, none).flatMap(({ row, strategy }) => {
    const d = conversionRun(f, input, strategy);
    return d === null ? [] : [runOf(row, strategy, d)];
  });
}

const breaks = (r: TuneRun, limits: readonly TuneLimit[]) => limits.reduce((n, l) => n + r.crosses[l], 0);

/** Whether `a` is ahead of `b` on what the goal reads, to the dollar: below zero when it is.
 *  A run that lasts comes first, so the least cost is never one that is cheap because its
 *  money ran out. */
function ahead(a: TuneRun, b: TuneRun, goal: TuneGoal): number {
  if ((a.short === null) !== (b.short === null)) return a.short === null ? -1 : 1;
  if (a.short !== null && b.short !== null && a.short !== b.short) return b.short - a.short;
  const unpaid = Math.round(a.unpaid) - Math.round(b.unpaid);
  if (unpaid !== 0) return unpaid;
  return goal === 'left' ? Math.round(b.left) - Math.round(a.left) : Math.round(a.cost) - Math.round(b.cost);
}

/** How a row stands to None: see TunedRow's beatsNone. */
function versusNone(run: TuneRun, none: TuneRun, goal: TuneGoal): boolean | null {
  if (ahead(run, none, goal) < 0) return true;
  const figure = goal === 'left' ? Math.round(none.left) - Math.round(run.left) : Math.round(run.cost) - Math.round(none.cost);
  return figure < 0 ? null : false;
}

const sizeOf = (r: TuneRun) => {
  const rule = r.strategy.conversions;
  return rule.kind === 'fixed' ? rule.yearly : rule.kind === 'none' ? 0 : rule.top;
};

/** Which of a row's settings comes first, for the goal and limits: below zero for `a`.
 *  A tie, to the dollar, goes to the plan's own, so no Use is offered that changes nothing;
 *  then to what converts less and ends earlier. No figure tells the settings apart there. */
export function tuneOrder(a: TuneRun, b: TuneRun, ask: TuneAsk, own: Strategy, until: number): number {
  const limits = breaks(a, ask.limits) - breaks(b, ask.limits);
  if (limits !== 0) return limits;
  const goal = ahead(a, b, ask.goal);
  if (goal !== 0) return goal;
  const mine = Number(isOwnSetting(b.strategy, own, until)) - Number(isOwnSetting(a.strategy, own, until));
  if (mine !== 0) return mine;
  const converted = Math.round(a.converted) - Math.round(b.converted);
  if (converted !== 0) return converted;
  const ends = (a.strategy.convertUntil ?? until) - (b.strategy.convertUntil ?? until);
  if (ends !== 0) return ends;
  const size = sizeOf(a) - sizeOf(b);
  if (size !== 0) return size;
  return Number(b.strategy.order === own.order) - Number(a.strategy.order === own.order);
}

/** Each rule's row, in Compare's order: nothing here is sorted by the goal until asked. */
export function tunedRows(runs: readonly TuneRun[], ask: TuneAsk, own: Strategy, until: number): TunedRow[] {
  const picked = new Map<string, TuneRun>();
  for (const r of runs) {
    const was = picked.get(r.row);
    if (!was || tuneOrder(r, was, ask, own, until) < 0) picked.set(r.row, r);
  }
  const none = picked.get('none') ?? null;
  const rank = (key: string) => ROW_ORDER.indexOf(key);
  return [...picked.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([key, run]) => {
      const crossing = crossingOf(run.crosses, ask.limits);
      const comparable = key !== 'none' && none !== null && crossing.length === 0 && breaks(none, ask.limits) === 0;
      return { key, run, crossing, beatsNone: comparable ? versusNone(run, none, ask.goal) : null, mine: isOwnSetting(run.strategy, own, until) };
    });
}
