// components/plan-items.ts
//
// The Timeline's words (the tax plan's E2: components/PlanTimeline.tsx and
// components/PlanItemSheet.tsx): Add's templates in their three groups, the
// empty Timeline's chips, an item's start and end in words, each row's sub
// and amount, the points in time the card hangs its rows on, the name a copy
// made from an item takes, a refusal of itemRules with the items' names, and
// the sheet's "what is possible" lines. Kept apart from the components so
// the exact sentences are tested. Every amount goes through the `money` a
// caller gives (components/plan-text.ts wholeMoney), so hidden amounts stay
// hidden; a copy's name never holds one, since a name isn't masked.

import type { ItemAges } from '@/lib/fire/compile';
import { INCOME_KINDS, ITEM_LIMITS, ONCE_KINDS, type Anchor, type ItemKind, type PlanItem, type When } from '@/lib/fire/items';
import { PLAN_TO_AGE } from '@/lib/fire/plan';
import type { PlanFigures } from '@/lib/fire/plan-figures';
import type { FiredResult, SimPlan } from '@/lib/fire/simulate';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import { nameTaken, SCENARIO_NAME_MAX } from '@/lib/fire/plan-list';
import type { Unplaced } from '@/lib/fire/steady';
import { fiWhen, lifeChoiceText, type FiWhen } from './plan-fi-when';
import { EVENT_PART_TEXT, shortText } from './plan-scenario-text';

type Money = (n: number) => string;

/** What the words read of a plan: its items and the ages that place them. */
type Facts = Pick<FirePlanV2, 'items' | 'age' | 'partnerAge' | 'targetAge' | 'stopAtFi'>;

export type TemplateGroup = 'out' | 'in' | 'work';

export const TEMPLATE_GROUPS: readonly { id: TemplateGroup; name: string }[] = [
  { id: 'out', name: 'Money out' },
  { id: 'in', name: 'Money in' },
  { id: 'work', name: 'Work' },
];

export type ItemTemplate = {
  id: string;
  group: TemplateGroup;
  kind: ItemKind;
  /** Add's row, the chip and the sheet's title. */
  label: string;
  /** The item's name, as the form starts it. */
  name: string;
  /** A career break: pay down, for some years. */
  less?: true;
};

/** Add to your Timeline's 13 templates (timeline.md), in their groups'
 *  order. A template fills in nothing but the item's name and its kind's
 *  direction: every amount, age and length is the person's own. */
export const ITEM_TEMPLATES: readonly ItemTemplate[] = [
  { id: 'home', group: 'out', kind: 'home', label: 'Buy a home', name: 'Buying a home' },
  { id: 'child', group: 'out', kind: 'child', label: 'A child', name: 'A child' },
  { id: 'car', group: 'out', kind: 'car', label: 'Buy a car', name: 'A car' },
  { id: 'loan-end', group: 'out', kind: 'loan-end', label: 'Pay off a loan', name: 'A loan paid off' },
  { id: 'spending', group: 'out', kind: 'spending', label: 'A change in spending', name: 'A change in spending' },
  { id: 'cost', group: 'out', kind: 'one-off', label: 'A cost', name: 'A cost' },
  { id: 'social-security', group: 'in', kind: 'social-security', label: 'Social Security', name: 'Social Security' },
  { id: 'pension', group: 'in', kind: 'pension', label: 'A pension', name: 'A pension' },
  { id: 'windfall', group: 'in', kind: 'windfall', label: 'A windfall', name: 'A windfall' },
  { id: 'other-income', group: 'in', kind: 'other-income', label: 'Other income', name: 'Other income' },
  { id: 'pay', group: 'work', kind: 'pay', label: 'A change in pay', name: 'A change in pay' },
  { id: 'part-time', group: 'work', kind: 'part-time', label: 'Part-time work', name: 'Part-time work' },
  { id: 'career-break', group: 'work', kind: 'pay', label: 'A career break', name: 'A career break', less: true },
];

/** The empty Timeline's five chips, the rest in Add. */
export const CHIP_TEMPLATES: readonly ItemTemplate[] = ['social-security', 'part-time', 'home', 'child', 'cost'].map((id) => ITEM_TEMPLATES.find((t) => t.id === id)!);

/** The template an item there is shown with: its kind's, a career break for
 *  pay down for some years. */
export function templateOf(x: PlanItem): ItemTemplate {
  if (x.kind === 'pay' && x.yearly !== null && x.yearly < 0 && x.until !== null) return ITEM_TEMPLATES.find((t) => t.id === 'career-break')!;
  return ITEM_TEMPLATES.find((t) => t.kind === x.kind && !t.less)!;
}

/** Each template's helper in the item sheet: today's words for its kind
 *  (the income and one-off sheets', and the life events' notes), with what
 *  E1 made false rewritten (part-time work counts before the stop once it
 *  says what it replaces, and its amount may be before tax). */
export const TEMPLATE_HELP: Record<string, string> = {
  home: 'What you pay from your investments when you buy (0 if the down payment comes from cash the plan doesn’t count), and how your yearly spending changes from then: the mortgage, taxes and upkeep, less the rent you stop paying. A change for good that is already in effect when you stop working is part of your spending in retirement, and so of your FI number.',
  child: 'How much more you would spend a year, and for how many years.',
  car: 'What you pay from your investments for each car when you buy it, once or every few years. Payments on a car loan are already in your measured spending, so count only what comes from your investments, never a loan’s payments.',
  'loan-end': 'How much less you would spend a year, for good, once a loan is paid off: its payments, which are in your measured spending until then. You save that much more from then until FI. Paid off by the time you stop, it is part of your spending in retirement, and so of your FI number.',
  spending: 'How much more (or less) you would spend a year, for some years or for good: travel, a hobby, care for a parent. It changes what you save in its years too. A change for good that is already in effect when you stop working is part of your spending in retirement, and so of your FI number. Typing the plan’s own annual spending instead changes the FI number the same way, but leaves what you save as it is.',
  cost: 'A one-off from your investments, once or every few years: a roof, a wedding, tuition. In today’s money, after tax. Counted in Will it last? from where it starts, and in your FI date before then.',
  'social-security': 'A year, from the age it starts, as your statement gives it. Counted in Will it last? from where it starts, and in your FI date before then.',
  pension: 'A year, from the age it starts. Counted in Will it last? from where it starts, and in your FI date before then.',
  windfall: 'Money that comes in once (an inheritance, a sale), after tax, added to your investments at that age. From where Will it last? starts, it takes it as money in that year.',
  'other-income': 'Money in a year from anything but your job: rent from a property, a business, an annuity. Counted in Will it last? from where it starts, and in your FI date before then.',
  pay: 'Your own take-home pay, up or down: a raise, a pay cut, a new job. It moves your FI date and what you’d have when you stop: it never changes your spending in retirement, or your FI number.',
  'part-time': 'Work in place of your job, or after you stop. Started before you stop, it also asks the take-home it replaces, so it counts in your FI date. The FI card’s Barista FI uses your plan’s own part-time income, not this.',
  'career-break': 'How much less you would save each year of it: what you would have saved, plus anything you would spend from savings. It moves your FI date; once you have stopped working it changes nothing.',
};

const years = (n: number) => `${n} year${n === 1 ? '' : 's'}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Kinds whose amount says whose it is (lib/fire/items.ts FIELDS). */
const OWNED: readonly ItemKind[] = [...INCOME_KINDS, 'pay'];

/** An item's title: its name, with whose once a partner is set (or the item
 *  is the partner's). */
export function itemTitle(x: PlanItem, plan: Pick<Facts, 'partnerAge'>): string {
  if (!OWNED.includes(x.kind)) return x.label;
  if (x.owner === 'partner') return `${x.label}, your partner`;
  return plan.partnerAge !== null ? `${x.label}, you` : x.label;
}

/** What an anchor is, said after "when" or "until": "you stop", "you reach
 *  FI", "Part-time work ends", "invested assets reach $2,000,000". */
function anchorWords(a: Anchor, x: PlanItem, plan: Facts, money: Money): string {
  switch (a.at) {
    case 'age':
      return x.owner === 'partner' ? `your partner’s ${a.age}` : `${a.age}`;
    case 'stop':
      return 'you stop';
    case 'fi':
      return 'you reach FI';
    case 'item': {
      const other = plan.items.find((y) => y.id === a.id);
      return `${other ? other.label : 'another item'} ${a.edge === 'start' ? 'starts' : 'ends'}`;
    }
    case 'balance':
      return `invested assets reach ${money(a.amount)}`;
  }
}

/** When an item starts or stops, in words: "At 45", "When you stop", "2
 *  years before you stop", "1 year before FI", "When Part-time work ends". */
export function whenWords(w: When, x: PlanItem, plan: Facts, money: Money, until = false): string {
  const a = w.anchor;
  if (a.at === 'age') {
    const age = a.age + w.offset;
    const at = x.owner === 'partner' ? `your partner’s ${age}` : `${age}`;
    return until ? `Until ${at}` : `At ${at}`;
  }
  if (w.offset === 0) return `${until ? 'Until' : 'When'} ${anchorWords(a, x, plan, money)}`;
  const n = Math.abs(w.offset);
  const dir = w.offset < 0 ? 'before' : 'after';
  const what = a.at === 'fi' ? 'FI' : anchorWords(a, x, plan, money);
  return `${until ? 'Until ' : ''}${years(n)} ${dir} ${what}`;
}

/** How it ends, or repeats: "Until 55", "For good", "For 18 years", "Every 8
 *  years, 4 times"; null for something that happens once. */
export function endWords(x: PlanItem, plan: Facts, money: Money): string | null {
  if (ONCE_KINDS.includes(x.kind)) return x.every !== null && x.times !== null ? `Every ${x.every} years, ${x.times} times` : null;
  if (x.kind === 'loan-end') return 'For good';
  if (x.kind === 'home' && x.yearly === 0) return null;
  if (x.until === null) return 'For good';
  if ('years' in x.until) return `For ${years(x.until.years)}`;
  return whenWords(x.until, x, plan, money, true);
}

/** An amount's line under it: a year, once, each, or a change's way. */
export type ItemAmount = { amount: number; line: string };

export function itemAmount(x: PlanItem): ItemAmount {
  const yearly = x.yearly ?? 0;
  const change = (v: number) => (v < 0 ? 'less a year' : 'more a year');
  switch (x.kind) {
    case 'spending':
    case 'pay':
      return { amount: Math.abs(yearly), line: change(yearly) };
    case 'loan-end':
      return { amount: yearly, line: 'less a year' };
    case 'home':
      return (x.once ?? 0) > 0 || yearly === 0 ? { amount: x.once ?? 0, line: 'once' } : { amount: Math.abs(yearly), line: change(yearly) };
    case 'car':
    case 'one-off':
      return { amount: x.once ?? 0, line: x.every !== null ? 'each' : 'once' };
    case 'windfall':
      return { amount: x.once ?? 0, line: 'once' };
    default:
      return { amount: yearly, line: 'a year' };
  }
}

/** Whether an item counts in the FI date: the walk has it, and it starts by
 *  then (the walk ends at FI, so income at 67 with FI around 52 moves nothing). */
export function countsInFiDate(f: PlanFigures, i: number): boolean {
  if (!f.inWalk[i]) return false;
  const start = f.resolution.ages[i]?.start ?? null;
  const fi = fiWhen(f);
  if (start === null) return true;
  return fi.kind === 'age' ? start <= fi.age : fi.kind !== 'now';
}

/** A kind's help, by D15's switch: with it off, a cost and income don't count
 *  in the FI date. */
export function templateHelp(id: string, planInWalk: boolean): string | undefined {
  const help = TEMPLATE_HELP[id];
  return planInWalk ? help : help?.replace(', and in your FI date before then.', '.');
}

/** Whether any of an item reaches Will it last?, which starts at startAge: it
 *  starts there or later, a repeat lands there, or its years run on past it.
 *  A change in pay never does: the job ends when you stop. */
export function reachesStart(x: PlanItem, ages: { start: number; end: number | null }, startAge: number): boolean {
  if (x.kind === 'pay') return false;
  if (ages.start + (x.every ?? 0) * ((x.times ?? 1) - 1) >= startAge) return true;
  return !!x.yearly && (ages.end === null || ages.end > startAge);
}

/** A Timeline row's sub: how it starts when its point doesn't say it (an
 *  offset, or a start before today), how it ends or repeats, "before tax",
 *  and "counts in your FI date" exactly when the walk counts it. */
export function rowSub(x: PlanItem, plan: Facts, money: Money, at: { start: number | null; inWalk: boolean }): string {
  const parts: string[] = [];
  const before = at.start !== null && plan.age !== null && at.start < plan.age;
  if (x.from.offset !== 0 || before) parts.push(whenWords(x.from, x, plan, money));
  const end = endWords(x, plan, money);
  if (end) parts.push(end);
  if (x.beforeTax) parts.push('before tax');
  if (at.inWalk) parts.push('counts in your FI date');
  return cap(parts.map(lower).join(' · '));
}

/** An item in one line, for how a copy differs and Also change it in:
 *  "$18,000 a year, at your partner’s 67, for good, before tax". */
export function itemSentence(x: PlanItem, plan: Facts, money: Money): string {
  const v = itemAmount(x);
  let amount: string;
  if (x.kind === 'home') {
    const yearly = x.yearly ?? 0;
    amount = `${money(x.once ?? 0)} from your investments${yearly !== 0 ? `, then spending ${money(Math.abs(yearly))} a year ${yearly < 0 ? 'less' : 'more'}` : ''}`;
  } else {
    amount = `${money(v.amount)}${v.line === 'once' ? '' : ` ${v.line}`}`;
  }
  const parts = [amount, lower(whenWords(x.from, x, plan, money))];
  const end = endWords(x, plan, money);
  if (end) parts.push(lower(end));
  if (x.beforeTax) parts.push('before tax');
  if (INCOME_KINDS.includes(x.kind) && !x.inflationAdjusted) parts.push('fixed');
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// The points in time.

export type TimelinePoint = {
  key: string;
  label: string;
  /** The items under it, by their place in the plan. */
  items: number[];
};

export type TimelineLayout = {
  /** In order of the steady path's years; a point with nothing under it is
   *  a marker (the stop, FI). */
  points: TimelinePoint[];
  /** Milestones the steady path never reaches, last, with their items. */
  notReached: TimelinePoint[];
  /** Items that can't be placed, in the order they were added. */
  unplaced: number[];
};

/** The age FI is said at, as the answer rounds it, or why there is none. */
function fiAt(f: PlanFigures): { age: number | null; now: boolean; when: FiWhen } {
  const when = fiWhen(f);
  if (when.kind === 'age') return { age: when.age, now: false, when };
  if (when.kind === 'now') return { age: null, now: true, when };
  return { age: null, now: false, when };
}

/** The Timeline's points (timeline.md "The points"): each year that names
 *  something, one label joined with " · " (today, the stop, FI, balance
 *  milestones, item edges, then a plain age only when nothing else names
 *  it), each item under the year it starts. With no age there are no
 *  points, and every item is listed in the order it was added. */
export function timelinePoints(plan: FirePlanV2, f: PlanFigures | null, money: Money): TimelineLayout {
  const all = plan.items.map((_, i) => i);
  if (plan.age === null || !f) return { points: [], notReached: [], unplaced: all };
  const today = plan.age;
  const res = f.resolution;
  const stop = res.stop;
  const fi = fiAt(f);
  const shift = plan.partnerAge !== null ? today - plan.partnerAge : null;

  type Year = { items: number[]; balances: string[]; edges: string[]; partner: boolean };
  const byYear = new Map<number, Year>();
  const year = (age: number): Year => {
    let y = byYear.get(age);
    if (!y) byYear.set(age, (y = { items: [], balances: [], edges: [], partner: false }));
    return y;
  };
  const todayItems: number[] = [];
  const unplaced: number[] = [];
  const notReached = new Map<string, TimelinePoint>();
  const fiNot = () => {
    let p = notReached.get('fi');
    if (!p) notReached.set('fi', (p = { key: 'fi-not', label: lifeChoiceText(fi.when, { kind: 'none' }), items: [] }));
    return p;
  };

  plan.items.forEach((x, i) => {
    const ages: ItemAges = res.ages[i] ?? null;
    const why: Unplaced | null = res.why[i] ?? null;
    const a = x.from.anchor;
    if (ages === null) {
      if (why === 'not-reached' && a.at === 'balance') {
        const key = `balance:${a.amount}`;
        let p = notReached.get(key);
        if (!p) notReached.set(key, (p = { key, label: `Invested assets reach ${money(a.amount)} · not by ${PLAN_TO_AGE}`, items: [] }));
        p.items.push(i);
      } else if ((why === 'waits-on-fi' || why === 'not-reached') && a.at === 'fi') {
        fiNot().items.push(i);
      } else {
        unplaced.push(i);
      }
      return;
    }
    if (ages.start <= today) {
      todayItems.push(i);
      return;
    }
    const y = year(ages.start);
    y.items.push(i);
    if (x.from.offset === 0 && a.at === 'balance') {
      const label = `Invested assets reach ${money(a.amount)} · ${ages.start} on your steady path`;
      if (!y.balances.includes(label)) y.balances.push(label);
    }
    if (x.from.offset === 0 && a.at === 'item') {
      const other = plan.items.find((o) => o.id === a.id);
      const label = `${other ? other.label : 'Another item'} ${a.edge === 'start' ? 'starts' : 'ends'} at ${ages.start}`;
      if (!y.edges.includes(label)) y.edges.push(label);
    }
    if (a.at === 'age' && x.owner === 'partner') y.partner = true;
  });

  // The markers: the stop and FI, always, in the future; past, they join Today.
  const stopFuture = stop !== null && stop > today;
  const fiFuture = fi.age !== null && fi.age > today;
  if (stopFuture) year(stop!);
  if (fiFuture) year(fi.age!);
  if ((fi.when.kind === 'never' || fi.when.kind === 'short') && !plan.stopAtFi) fiNot();

  const points: TimelinePoint[] = [];
  const todayParts = [`Today, ${today}`];
  if (stop !== null && stop <= today) todayParts.push(stop < today ? `you stopped at ${stop}` : `you stop at ${stop}`);
  if (fi.now || (fi.age !== null && fi.age <= today)) todayParts.push('you’re at FI');
  if (todayItems.length > 0 || todayParts.length > 1) points.push({ key: 'today', label: todayParts.join(' · '), items: todayItems });

  for (const age of [...byYear.keys()].sort((p, q) => p - q)) {
    const y = byYear.get(age)!;
    const parts: string[] = [];
    const isStop = stopFuture && age === stop;
    const isFi = fiFuture && age === fi.age;
    if (isStop) parts.push(plan.stopAtFi ? `You stop at FI, around ${age}` : `You stop at ${age}`);
    if (isFi && !(isStop && plan.stopAtFi)) parts.push(`FI around ${age}`);
    parts.push(...y.balances, ...y.edges);
    if (parts.length === 0) parts.push(y.partner && shift !== null ? `At ${age} · your partner’s ${age - shift}` : `At ${age}`);
    points.push({ key: `age:${age}`, label: parts.join(' · '), items: y.items });
  }
  // Under stop when I reach FI with no answer, the stop isn't placed either.
  if (plan.stopAtFi && stop === null && (fi.when.kind === 'never' || fi.when.kind === 'short')) {
    notReached.set('fi', { ...fiNot(), label: `You stop at FI: ${lifeChoiceText(fi.when, { kind: 'none' }).replace(/^./, (c) => c.toLowerCase())}` });
  }
  return { points, notReached: [...notReached.values()], unplaced };
}

/** Why an item isn't placed, under Not placed yet, or on its row. */
export function unplacedText(x: PlanItem, why: Unplaced | null, plan: Facts): string | null {
  switch (why) {
    case 'waits-on-stop':
      return plan.stopAtFi ? `Waits on your stop: no FI by ${PLAN_TO_AGE}, so nothing is simulated.` : 'Waits on your stop: set it in Household.';
    case 'waits-on-fi':
      return `Waits on FI, which isn’t reached by ${PLAN_TO_AGE}.`;
    case 'no-age':
      return 'Not placed: add your age.';
    case 'no-years':
      return 'Ends before it starts, so it runs no years.';
    case 'not-reached': {
      const a = x.from.anchor;
      if (a.at === 'item') {
        const other = plan.items.find((y) => y.id === a.id);
        return `Waits on ${other ? other.label : 'another item'}, which never ${a.edge === 'start' ? 'starts' : 'ends'} on your steady path.`;
      }
      return `Not reached on your steady path by ${PLAN_TO_AGE}.`;
    }
    default:
      return null;
  }
}

/** The lines under the Timeline's heading, one for each place its kinds count (D15's
 *  switch decides whether a cost and income count in your FI date). */
export function whereItCountsText(startAge: number | null, planInWalk: boolean): readonly [string, string] {
  const from = startAge === null ? 'where it starts' : `${startAge}, where it starts`;
  const fiDate = planInWalk
    ? 'Your FI date counts costs, windfalls, changes in pay, work that starts before you stop and other money in, until you reach it.'
    : 'Your FI date counts homes, children, cars, changes in spending and pay, windfalls and work that starts before you stop, until you reach it. Other costs and income don’t count there yet.';
  return [fiDate, `Will it last? counts costs, windfalls and income, from ${from}.`];
}

/** Part-time work's years before Will it last? starts, in words that are
 *  true since E1: with what it replaces said, they count in your FI date;
 *  without it, the caution says what to do, and this says nothing. From
 *  today's assets Will it last? starts today, so nothing comes before it. */
export function beforeStartText(x: PlanItem, plan: Pick<FirePlanV2, 'start'>, startAge: number | null): string | null {
  if (x.kind !== 'part-time') return EVENT_PART_TEXT['before-start'];
  if (x.replaces === null || plan.start === 'assets' || startAge === null) return null;
  return `Its years before ${startAge} count in your FI date, not in Will it last?, which starts at ${startAge}.`;
}

/** An item note's words, for its row and its sheet. */
export function notePartText(x: PlanItem, part: keyof typeof EVENT_PART_TEXT, plan: Pick<FirePlanV2, 'start'>, startAge: number | null): string | null {
  return part === 'before-start' ? beforeStartText(x, plan, startAge) : EVENT_PART_TEXT[part];
}

/** A row's note from the figures (lib/fire/plan-figures.ts itemNotes), in
 *  the words its kind had before E2: a cost's and income's as the Income and
 *  one-off expenses card said them, the rest as the life events' did (with
 *  part-time's before-start as beforeStartText has it). `at` is where it
 *  starts; `end` where Will it last? ends. */
export function rowNoteText(
  x: PlanItem,
  part: keyof typeof EVENT_PART_TEXT,
  o: { plan: Pick<FirePlanV2, 'start' | 'age'>; at: number | null; startAge: number | null; end: number | null; inFi: boolean; runs: boolean }
): string | null {
  const money = x.kind === 'one-off' || (INCOME_KINDS.includes(x.kind) && x.kind !== 'part-time');
  // Where the simulation has a cost or income, so only when it runs: waiting
  // on spending or a balance, "add your age" would be the wrong ask.
  if (money && !o.runs) return null;
  if (money && part === 'no-age') return 'Not in the simulation: add your age.';
  if (x.kind === 'one-off') {
    if (part === 'before-start') {
      if (o.startAge === null) return 'Not in the simulation: add your age.';
      if (o.plan.age !== null && o.at !== null && o.at < o.plan.age) return 'Before today, so it isn’t counted: your measured figures may already count it.';
      return o.inFi ? `Before ${o.startAge}, where Will it last? starts, so it counts in your FI date, not in Will it last?` : `Before ${o.startAge}, where Will it last? starts, so it isn’t counted anywhere.`;
    }
    if (part === 'after-end') return `After the plan ends${o.end !== null ? ` at ${o.end}` : ''}: only the grid’s longer columns reach it.`;
  }
  return notePartText(x, part, o.plan, o.startAge);
}

/** Two part-time items for one person are refused between fixed ages
 *  (lib/fire/items.ts itemRules). On an anchor that moves they can still meet,
 *  and both count there (lib/fire/compile.ts), so each says so, by where the
 *  steady path has them. Only from today, since years gone count nowhere, and
 *  only where both do count: both in the FI date, or the years in Will it
 *  last? An item that runs no years meets nothing. */
function overlapText(x: PlanItem, f: PlanFigures, i: number, startAge: number | null): string | null {
  const ages = f.resolution.ages[i];
  if (x.kind !== 'part-time' || !ages) return null;
  const clash = f.plan.items.find((y, j) => {
    const o = f.resolution.ages[j];
    if (j === i || y.kind !== 'part-time' || (y.owner === 'partner') !== (x.owner === 'partner') || !o) return false;
    const from = Math.max(ages.start, o.start, f.plan.age ?? -Infinity);
    const to = Math.min(ages.end ?? Infinity, o.end ?? Infinity);
    if (from >= to) return false;
    return (countsInFiDate(f, i) && countsInFiDate(f, j)) || (startAge !== null && to > startAge);
  });
  return clash ? `It overlaps “${clash.label}” on your steady path. Both count in those years. If one takes over from the other, start it when the other ends.` : null;
}

/** What the compile says of an item, the same in its row and its sheet. */
export function itemWarnings(x: PlanItem, f: PlanFigures, i: number): string[] {
  const sim = 'sim' in f.engine ? f.engine : null;
  const startAge = sim ? sim.startAge : null;
  const end = sim && sim.startAge !== null ? sim.startAge + sim.sim.years : null;
  const at = f.resolution.ages[i]?.start ?? null;
  const inFi = countsInFiDate(f, i);
  const said = f.itemNotes.filter((n) => n.id === x.id).flatMap((n) => rowNoteText(x, n.part, { plan: f.plan, at, startAge, end, inFi, runs: sim !== null }) ?? []);
  const overlap = overlapText(x, f, i, startAge);
  return [...new Set(overlap ? [...said, overlap] : said)];
}

/** Whether an item is placed by the steady path in every run of Will it
 *  last? (on FI or a balance, or timed by one of those). */
export function onSteadyPath(x: PlanItem, plan: Facts, seen = new Set<string>()): boolean {
  if (seen.has(x.id)) return false;
  seen.add(x.id);
  const ends = x.until !== null && !('years' in x.until) && !ONCE_KINDS.includes(x.kind) ? [x.from, x.until] : [x.from];
  return ends.some((w) => {
    const a = w.anchor;
    if (a.at === 'fi' || a.at === 'balance') return true;
    if (a.at !== 'item') return false;
    const y = plan.items.find((o) => o.id === a.id);
    return !!y && onSteadyPath(y, plan, seen);
  });
}

/** The every-run note (timeline.md "Otherwise the steady-path year in every
 *  run"), its reason by where Will it last? starts. */
export function everyRunText(start: number | null, plan: Pick<FirePlanV2, 'start'>, perRun = false): string | null {
  if (perRun) return 'Will it last? goes by each run’s own balance for this.';
  if (start === null) return null;
  const why =
    plan.start === 'fi-number'
      ? 'Will it last? starts from your FI number, not your own path'
      : plan.start === 'custom'
        ? 'Will it last? starts from the balance you typed, not your own path'
        : plan.start === 'at-stop'
          ? 'your FI date and what comes before your stop are the steady path’s, not each run’s'
          : 'Will it last? starts from today’s assets, so each run’s path differs from the steady one';
  return `Starts at ${start} in every run, as on your steady path: ${why}.`;
}

/** The Honesty table's cautions on an item (screens.md): part-time work
 *  before you stop that doesn't say what it replaces, and income before FI
 *  given before tax. */
export function itemCautions(x: PlanItem, at: { start: number | null; stop: number | null; inFi: boolean; taxRate: number; detailed?: boolean }): string[] {
  const out: string[] = [];
  if (at.detailed && !x.beforeTax && (x.kind === 'pension' || x.kind === 'social-security' || x.kind === 'other-income')) out.push('Give it before tax, so its tax and its part in your ACA income count.');
  if (at.detailed && !x.beforeTax && x.kind === 'part-time') out.push('Given after tax, it may hide a year over the ACA limit.');
  if (x.kind === 'part-time' && x.replaces === null && at.start !== null && at.stop !== null && at.start < at.stop) out.push('Say what take-home it replaces, so it counts in your FI date.');
  if (INCOME_KINDS.includes(x.kind) && x.beforeTax && at.inFi) {
    out.push(`In your FI date after ${Math.round(at.taxRate * 1000) / 10}% tax, ${at.detailed ? 'your plan’s tax after you stop' : 'your plan’s rate on withdrawals'}. It may keep less: give its take-home for a closer date.`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Copies and refusals.

/** The copy's name for an item tried in one: the template's words with its
 *  start ("Buy a home at 38", "Part-time work when you stop", "… at a
 *  milestone" for a balance), never an amount, cut at a word to the 40 a
 *  name holds, with " (2)", " (3)"... when another plan has it already. */
export function copyNameFor(template: ItemTemplate, x: PlanItem, plan: Facts, others: readonly { id: string; name: string }[]): string {
  const a = x.from.anchor;
  const n = Math.abs(x.from.offset);
  const dir = x.from.offset < 0 ? 'before' : 'after';
  // The item's own name, once it has one: the template's says what it is.
  const what = x.label !== template.name ? x.label : template.label;
  let when: string;
  // Too long with the years, "before you stop" says enough.
  const by = (where: string) => (x.from.offset === 0 ? `when ${where === 'FI' ? 'you reach FI' : where}` : `${what} ${years(n)} ${dir} ${where}`.length <= SCENARIO_NAME_MAX ? `${years(n)} ${dir} ${where}` : `${dir} ${where}`);
  switch (a.at) {
    case 'age':
      when = `${x.kind === 'part-time' ? 'from' : 'at'} ${x.owner === 'partner' ? 'your partner’s ' : ''}${a.age + x.from.offset}`;
      break;
    case 'stop':
      when = by('you stop');
      break;
    case 'fi':
      when = by('FI');
      break;
    case 'balance':
      when = 'at a milestone';
      break;
    case 'item': {
      const other = plan.items.find((y) => y.id === a.id);
      when = `when ${other ? other.label : 'another item'} ${a.edge === 'start' ? 'starts' : 'ends'}`;
      break;
    }
  }
  const base = `${what} ${when}`;
  const first = fit(base, SCENARIO_NAME_MAX);
  if (!nameTaken(others, first)) return first;
  for (let k = 2; ; k++) {
    const tail = ` (${k})`;
    const name = fit(base, SCENARIO_NAME_MAX - tail.length) + tail;
    if (!nameTaken(others, name)) return name;
  }
}

/** A name cut to `max` characters at a word's end. */
function fit(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const end = cut.lastIndexOf(' ');
  return (end > 0 ? cut.slice(0, end) : s.slice(0, max)).replace(/[\s,·]+$/, '');
}

/** A refusal of the plan's checks with its items named: "items[2] and
 *  items[4] wait on each other" as "“Part-time work” and “A car” wait on
 *  each other." */
export function itemRuleText(error: string, plan: Pick<FirePlanV2, 'items'>): string {
  const named = error.replace(/items\[(\d+)\](?:\.[a-z]+)?/g, (_, i: string) => {
    const x = plan.items[Number(i)];
    return x ? `“${x.label}”` : 'an item';
  });
  return `${cap(named)}${/[.!?]$/.test(named) ? '' : '.'}`;
}

/** Whether the plan holds as many items as it can. */
export const itemsFull = (plan: Pick<FirePlanV2, 'items'>) => plan.items.length >= ITEM_LIMITS.items;

export const ITEMS_FULL_TEXT = `A plan holds up to ${ITEM_LIMITS.items} items: remove one to add another.`;

// ---------------------------------------------------------------------------
// What is possible: the item sheet's lines, as the draft is typed.

export type PreviewInput = {
  /** The draft as it would be saved, or why it can't be yet. */
  draft: { ok: PlanItem } | { error: string; missing?: true };
  /** The plan as saved (with the item as it was, for one there). */
  before: PlanFigures | null;
  /** The plan with the draft in it; null while it can't be worked out. */
  after: PlanFigures | 'refused' | null;
  /** A detailed plan's search for it is under way. */
  working?: boolean;
  /** It couldn't be run. */
  failed?: boolean;
  /** The plan without the item, for an item on FI ("without it, FI would
   *  be around 53"). */
  without: PlanFigures | null;
  /** In a copy, the lines say "this copy". */
  where: 'plan' | 'copy';
  money: Money;
  /** Where Will it last? starts, with the draft in. */
  startAge: number | null;
  /** The steady path's highest balance and its age, with the draft in. */
  most: { amount: number; age: number } | null;
  /** The steady path's balances, with the draft in. */
  points?: readonly { age: number; balance: number }[];
  /** Measured or typed savings a year, for a change in pay. */
  savings: number | null;
  /** The age the steady path with the draft runs out at, if it does. */
  runsOutAt: number | null;
  /** Where it falls across the runs, for a start that waits on a run's own balance. */
  across?: AcrossAnswer | null;
};

/** Across history, while it is worked out and once it has been. */
export type AcrossAnswer = { working: true } | { fired: FiredResult; startAge: number };

/** The item's start when it waits on a run's own balance: what to run, to say where it
 *  falls across the runs. Only when Will it last? starts from what you'd have at the
 *  stop, and the steady path hasn't fired it by then. */
export function waitingStart(f: PlanFigures, id: string): { sim: SimPlan; trigger: number; offset: number; startAge: number } | null {
  if (f.plan.start !== 'at-stop' || !('sim' in f.engine) || !f.engine.sim.conditional || f.engine.startAge === null) return null;
  const edge = f.resolution.perRun?.edges[f.plan.items.findIndex((y) => y.id === id)]?.start;
  if (edge === undefined || typeof edge === 'number') return null;
  return { sim: f.engine.sim, trigger: edge.trigger, offset: edge.offset, startAge: f.engine.startAge };
}

/** "It starts in 74% of runs, by 62 in half of those; in 26% of runs it never does." */
export function acrossText({ fired, startAge }: { fired: FiredResult; startAge: number }): string {
  if (fired.fired === 0 || fired.byHalf === null) return 'It never starts, in any run';
  const by = startAge + fired.byHalf;
  if (fired.fired === fired.runs) return `It starts in every run, by ${by} in half of them`;
  // Some and not all stay so, whatever the rounding says.
  const share = Math.min(99, Math.max(1, Math.round((fired.fired / fired.runs) * 100)));
  return `It starts in ${share}% of runs, by ${by} in half of those; in ${100 - share}% of runs it never does`;
}

export type PreviewLines = {
  /** The steady path's start and end, the FI date, and for pay what you'd
   *  save: key and value rows. */
  rows: { key: string; value: string }[];
  /** The sentence that moves as it is typed, and the rest. */
  lines: string[];
  /** The Honesty table's cautions. */
  cautions: string[];
  /** What the compile says of it, in its row's words. */
  warnings: string[];
};

/** FI in the sheet's words: "around 53", "now", or the answer's own. */
function fiWords(when: FiWhen): string {
  if (when.kind === 'age') return `around ${when.age}`;
  if (when.kind === 'now') return 'now';
  return lifeChoiceText(when, { kind: 'none' }).replace(/^./, (c) => c.toLowerCase());
}

/** What the sheet says the draft does (timeline.md "What is possible"). */
export function previewLines(p: PreviewInput): PreviewLines {
  const whose = p.where === 'copy' ? 'this copy’s' : 'your';
  if ('error' in p.draft) {
    return { rows: [], lines: [p.draft.missing ? `Fill in the figures to see how it moves ${whose} FI age.` : `Once the figures are in range, this says how they move ${whose} FI age.`], cautions: [], warnings: [] };
  }
  if (p.after === 'refused') return { rows: [], lines: ['With this item, the figures can’t be worked out: its lasting change takes your spending in retirement below zero.'], cautions: [], warnings: [] };
  // A detailed plan's search takes a moment, and what it finds replaces this.
  if (p.working) return { rows: [], lines: ['Working it out'], cautions: [], warnings: [] };
  if (p.failed) return { rows: [], lines: [`Tax on this plan couldn’t be worked out on this page, so this can’t say how it moves ${whose} FI age.`], cautions: [], warnings: [] };
  if (!p.after) return { rows: [], lines: [], cautions: [], warnings: [] };
  const x = p.draft.ok;
  const f = p.after;
  const i = f.plan.items.findIndex((y) => y.id === x.id);
  const ages = i >= 0 ? (f.resolution.ages[i] ?? null) : null;
  const why = i >= 0 ? (f.resolution.why[i] ?? null) : null;
  const today = f.plan.age;
  const after = fiWhen(f);
  const before = fiWhen(p.before);
  const stop = f.resolution.stop;
  const a = x.from.anchor;
  const rows: { key: string; value: string }[] = [];
  const lines: string[] = [];

  if (f.short) {
    const s = shortText(f.short, f.plan.age, p.money);
    lines.push(`With this item, ${s.charAt(0).toLowerCase()}${s.slice(1)}`);
  }

  // On the steady path: where it starts and ends.
  if (ages) {
    let start: string;
    if (today !== null && ages.start <= today && a.at !== 'age') start = 'Already true today: it starts now';
    else if (today !== null && ages.start < today) start = `${ONCE_KINDS.includes(x.kind) ? 'At' : 'From'} ${ages.start}, before today`;
    else if (a.at === 'balance' && x.from.offset === 0) start = `From ${ages.start}, when invested assets reach ${p.money(a.amount)}`;
    else start = `From ${ages.start}`;
    const end = ONCE_KINDS.includes(x.kind) ? '' : ages.end === null ? (x.until === null || x.kind === 'loan-end' ? '' : ', to the plan’s end: its end isn’t reached') : `, until ${ages.end}`;
    rows.push({ key: 'On your steady path', value: `${start}${end}` });
  } else if (why === 'not-reached' && a.at === 'balance') {
    const most = p.most;
    rows.push({ key: 'On your steady path', value: 'It never starts' });
    if (most) lines.push(`On your steady path invested assets start a year with at most ${p.money(most.amount)}, at ${most.age}, so it never starts.`);
  } else {
    const text = unplacedText(x, why, f.plan);
    if (text) rows.push({ key: 'On your steady path', value: text.replace(/\.$/, '') });
  }

  if (p.across) rows.push({ key: f.plan.method === 'historical' ? 'Across history' : 'Across simulated runs', value: 'working' in p.across ? 'Working it out' : acrossText(p.across) });

  // The FI date, before and with it.
  if (after.kind === 'age' && before.kind === 'age') {
    rows.push({ key: `${cap(whose)} FI date`, value: after.age === before.age ? `Stays around ${before.age}` : `From around ${before.age} to around ${after.age}` });
  } else if (after.kind !== 'none' && after.kind !== 'not-run') {
    rows.push({ key: `${cap(whose)} FI date`, value: cap(fiWords(after)) });
  }

  // A change in pay: what you'd save from then.
  if (x.kind === 'pay' && p.savings !== null && x.yearly !== null && ages) {
    rows.push({ key: 'You’d save', value: `${p.money(Math.max(0, p.savings + x.yearly))} a year, not ${p.money(p.savings)}` });
  }

  // Part-time work before the stop: what it pays, less what it replaces. Begun
  // before today it is in the saving this would be measured against.
  if (x.kind === 'part-time' && p.savings !== null && x.yearly !== null && x.replaces !== null && ages && stop !== null && ages.start < stop && today !== null && ages.start >= today) {
    const pays = x.yearly * (x.beforeTax ? 1 - (f.shares?.t ?? f.plan.taxRate) : 1);
    rows.push({ key: 'You’d save', value: `${p.money(Math.max(0, p.savings + pays - x.replaces))} a year, not ${p.money(p.savings)}` });
  }

  // Where it counts this time.
  const fiAge = after.kind === 'age' ? after.age : null;
  if (ages) {
    const inWalk = i >= 0 && countsInFiDate(f, i);
    const starts = `Starts at ${ages.start}`;
    if (a.at === 'fi') {
      const without = p.without ? fiWhen(p.without) : null;
      if (fiAge !== null && x.from.offset < 0 && today !== null && fiAge - today < -x.from.offset) {
        lines.push(`Starts now: FI is less than ${years(-x.from.offset)} away.`);
      } else if (fiAge !== null) {
        const off = x.from.offset;
        const rel = off === 0 ? 'the year you reach FI' : `${years(Math.abs(off))} ${off < 0 ? 'before' : 'after'} FI at around ${fiAge}`;
        const was = without && without.kind === 'age' ? `; without it, FI would be around ${without.age}` : '';
        lines.push(`${starts}, ${rel}${was}. It moves when FI does.`);
        if (off === 0 && (x.once ?? 0) > 0 && without && without.kind === 'age' && fiAge > without.age) {
          lines.push(`Your FI date is ${fiAge}: the first age at which, after the ${p.money(x.once ?? 0)} at FI, you’re still at your FI number.`);
        }
      }
    } else if (inWalk) {
      lines.push(`${starts}, ${fiAge === ages.start ? 'the year you reach FI' : `before ${fiAge !== null ? 'your FI date' : 'you reach FI'}`}, so it counts in ${whose} FI date${x.kind === 'pay' ? ' every year until you reach it' : ''}.`);
    } else if (fiAge !== null && ages.start >= fiAge && !INCOME_KINDS.includes(x.kind)) {
      const there = x.kind !== 'pay' && (p.startAge === null || reachesStart(x, ages, p.startAge));
      if (x.kind === 'pay') lines.push('It starts after you reach FI, and a change in pay ends when you stop, so it counts in neither your FI date nor Will it last?');
      else if (there) lines.push(`It starts after you reach FI, so it counts in Will it last?, not in your FI date or your FI number.`);
      else lines.push(`It comes after you reach FI and before ${p.startAge}, where Will it last? starts, so it counts in neither your FI date nor Will it last?`);
      // Still saving, a cost can undo what reaching FI meant.
      const next = p.points?.find((q) => q.age === ages.start + 1);
      const fiNumber = f.view.fiNumber;
      if (ONCE_KINDS.includes(x.kind) && (x.once ?? 0) > 0 && (stop === null || ages.start < stop) && next && fiNumber !== null && next.balance < fiNumber) {
        lines.push(`At ${ages.start} it takes you back under your FI number${there ? ': Will it last? counts it' : ''}.`);
      }
    } else if (x.kind === 'part-time' && stop !== null && ages.start >= stop) {
      lines.push(`Starts ${ages.start === stop ? 'when you stop' : `at ${ages.start}, after you stop`}: income in Will it last?. Your FI date, which assumes full-time work until then, ${after.kind === 'age' ? `stays around ${after.age}` : 'doesn’t move'}.`);
    } else if (p.startAge !== null && ages.start >= p.startAge) {
      lines.push(`${starts}, from where Will it last? starts, so it counts there.`);
    }
  }
  if (a.at === 'balance') lines.push('Checked on the balance at the start of each year, and started once, so the spending it adds can’t switch it off again.');

  if (p.runsOutAt !== null) lines.push(`On ${p.where === 'copy' ? 'this copy’s' : 'this'} steady path your invested assets run out at ${p.runsOutAt}.`);
  const perRun = i >= 0 && !!f.resolution.perRun?.edges[i];
  if ((ages || perRun) && onSteadyPath(x, f.plan)) {
    const every = everyRunText(ages?.start ?? null, f.plan, perRun);
    if (every) lines.push(every);
  }
  if (why === 'no-years') lines.push('Ends before it starts, so it runs no years.');

  const cautions = itemCautions(x, { start: ages?.start ?? null, stop, inFi: i >= 0 && countsInFiDate(f, i), taxRate: f.shares?.t ?? f.plan.taxRate, detailed: !!f.detail && !('failed' in f.detail) });
  return { rows, lines, cautions, warnings: i >= 0 ? itemWarnings(x, f, i) : [] };
}
