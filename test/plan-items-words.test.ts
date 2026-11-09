import { describe, expect, test } from 'bun:test';
import { walkWords } from '@/components/plan-text';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import type { PlanItem } from '@/lib/fire/items';
import { DEFAULT_PLAN_V2, type FirePlanV2 } from '@/lib/fire/plan-v2';
import {
  CHIP_TEMPLATES,
  ITEM_TEMPLATES,
  TEMPLATE_GROUPS,
  beforeStartText,
  copyNameFor,
  countsInFiDate,
  endWords,
  everyRunText,
  itemAmount,
  itemCautions,
  itemRuleText,
  itemSentence,
  itemTitle,
  previewLines,
  reachesStart,
  rowSub,
  templateHelp,
  templateOf,
  timelinePoints,
  unplacedText,
  whenWords,
  whereItCountsText,
} from '@/components/plan-items';
import { fiWhen } from '@/components/plan-fi-when';
import { wholeMoney } from '@/components/plan-text';
import { OFF, ON } from './plan-gen';

// The Timeline's words (components/plan-items.ts): its templates, an item's
// start, end and amount, the points it hangs rows on, a copy's name, and the
// item sheet's lines.

const money = (n: number) => wholeMoney(n, 'USD');
const m = { spending: null, savings: null, assets: null };
// FI number $1,000,000 (4%, no tax); $500,000 now and $50,000 a year at 5%:
// FI around 46.
const base: FirePlanV2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: 50, spending: 40_000, savings: 50_000, assets: 500_000, realReturn: 0.05, taxRate: 0 };

const mk = (id: string, kind: PlanItem['kind'], from: PlanItem['from'], set: Partial<PlanItem> = {}): PlanItem => ({
  id,
  label: id,
  kind,
  from,
  until: null,
  once: null,
  yearly: null,
  replaces: null,
  every: null,
  times: null,
  inflationAdjusted: true,
  owner: null,
  beforeTax: false,
  ...set,
});
const at = (age: number, offset = 0) => ({ anchor: { at: 'age' as const, age }, offset });
const on = (a: 'stop' | 'fi', offset = 0) => ({ anchor: { at: a }, offset });

const figures = (over: Partial<FirePlanV2>, count = OFF): PlanFigures => {
  const f = planFigures({ ...base, ...over }, m, { count });
  if ('refused' in f) throw new Error('refused');
  return f;
};

describe('an income given after tax, under a detailed plan', () => {
  const pension = { id: 'p', label: 'Pension', kind: 'pension', from: { anchor: { at: 'age', age: 60 }, offset: 0 }, until: null, once: null, yearly: 10_000, replaces: null, every: null, times: null, inflationAdjusted: true, owner: null, beforeTax: false } as const;
  const at = { start: 60, stop: 50, inFi: false, taxRate: 0.1 };

  test('asks for it before tax', () => {
    expect(itemCautions(pension, { ...at, detailed: true })).toContain('Give it before tax, so its tax and its part in your ACA income count.');
    expect(itemCautions({ ...pension, beforeTax: true }, { ...at, detailed: true })).toEqual([]);
  });

  test('part-time work says what it may hide', () => {
    expect(itemCautions({ ...pension, kind: 'part-time', replaces: 0 }, { ...at, detailed: true })).toContain('Given after tax, it may hide a year over the ACA limit.');
  });

  test('says nothing in the flat model, where every income is after tax', () => {
    expect(itemCautions(pension, at)).toEqual([]);
    expect(itemCautions({ ...pension, kind: 'part-time', replaces: 0 }, at)).toEqual([]);
  });
});

describe('what moved the walk', () => {
  test('its tax is said, alone or with what drew it', () => {
    expect(walkWords({ items: false, events: false, tax: true })).toBe('the tax on what you draw');
    expect(walkWords({ items: true, events: false, tax: true })).toBe('one-offs and income, and the tax on what they draw');
    expect(walkWords({ items: true, events: false })).toBe('one-offs and income');
    expect(walkWords({ items: false, events: false })).toBeNull();
  });
});

describe('templates', () => {
  test('13 in three groups, five as chips; a career break is pay down for some years', () => {
    expect(ITEM_TEMPLATES).toHaveLength(13);
    expect(TEMPLATE_GROUPS.map((g) => [g.name, ITEM_TEMPLATES.filter((t) => t.group === g.id).map((t) => t.label)])).toEqual([
      ['Money out', ['Buy a home', 'A child', 'Buy a car', 'Pay off a loan', 'A change in spending', 'A cost']],
      ['Money in', ['Social Security', 'A pension', 'A windfall', 'Other income']],
      ['Work', ['A change in pay', 'Part-time work', 'A career break']],
    ]);
    expect(CHIP_TEMPLATES.map((t) => t.label)).toEqual(['Social Security', 'Part-time work', 'Buy a home', 'A child', 'A cost']);
    expect(templateOf(mk('b', 'pay', at(45), { yearly: -20_000, until: { years: 1 } })).id).toBe('career-break');
    expect(templateOf(mk('r', 'pay', at(45), { yearly: 5_000 })).id).toBe('pay');
    expect(templateOf(mk('c', 'one-off', at(45), { once: 1 })).id).toBe('cost');
  });
});

describe('an item in words', () => {
  const plan = { ...base, partnerAge: 38, items: [mk('pt', 'part-time', on('stop'), { until: at(55), yearly: 20_000 })] };

  test('starts', () => {
    const x = plan.items[0];
    expect(whenWords(at(45), x, plan, money)).toBe('At 45');
    expect(whenWords(on('stop'), x, plan, money)).toBe('When you stop');
    expect(whenWords(on('stop', -2), x, plan, money)).toBe('2 years before you stop');
    expect(whenWords(on('fi', -1), x, plan, money)).toBe('1 year before FI');
    expect(whenWords(on('fi'), x, plan, money)).toBe('When you reach FI');
    expect(whenWords({ anchor: { at: 'item', id: 'pt', edge: 'end' }, offset: 0 }, x, plan, money)).toBe('When pt ends');
    expect(whenWords({ anchor: { at: 'balance', amount: 2_000_000 }, offset: 0 }, x, plan, money)).toBe('When invested assets reach $2,000,000');
    expect(whenWords(at(67), { ...x, owner: 'partner' }, plan, money)).toBe('At your partner’s 67');
  });

  test('ends and repeats', () => {
    expect(endWords(plan.items[0], plan, money)).toBe('Until 55');
    expect(endWords(mk('c', 'child', at(42), { until: { years: 18 }, yearly: 1 }), plan, money)).toBe('For 18 years');
    expect(endWords(mk('s', 'spending', at(42), { yearly: 1 }), plan, money)).toBe('For good');
    expect(endWords(mk('car', 'car', at(42), { once: 1, every: 8, times: 4 }), plan, money)).toBe('Every 8 years, 4 times');
    expect(endWords(mk('w', 'windfall', at(42), { once: 1 }), plan, money)).toBeNull();
    expect(endWords(mk('l', 'loan-end', at(42), { yearly: 1 }), plan, money)).toBe('For good');
  });

  test('a title says whose once a partner is set', () => {
    const ss = mk('ss', 'social-security', at(67), { yearly: 18_000, label: 'Social Security' });
    expect(itemTitle(ss, { partnerAge: null })).toBe('Social Security');
    expect(itemTitle(ss, { partnerAge: 38 })).toBe('Social Security, you');
    expect(itemTitle({ ...ss, owner: 'partner' }, { partnerAge: null })).toBe('Social Security, your partner');
    expect(itemTitle(mk('h', 'home', at(45), { once: 1 }), { partnerAge: 38 })).toBe('h');
  });

  test('amounts and their lines', () => {
    expect(itemAmount(mk('s', 'spending', at(42), { yearly: -3_000 }))).toEqual({ amount: 3_000, line: 'less a year' });
    expect(itemAmount(mk('p', 'pay', at(42), { yearly: 5_000 }))).toEqual({ amount: 5_000, line: 'more a year' });
    expect(itemAmount(mk('car', 'car', at(42), { once: 30_000, every: 8, times: 4 }))).toEqual({ amount: 30_000, line: 'each' });
    expect(itemAmount(mk('h', 'home', at(45), { once: 100_000, yearly: -6_000 }))).toEqual({ amount: 100_000, line: 'once' });
    expect(itemAmount(mk('ss', 'social-security', at(67), { yearly: 18_000 }))).toEqual({ amount: 18_000, line: 'a year' });
  });

  test('a row’s sub: an offset, the end, before tax, and counts in your FI date', () => {
    const x = mk('pt', 'part-time', on('stop', -2), { until: at(55), yearly: 20_000, beforeTax: true });
    expect(rowSub(x, plan, money, { start: 48, inWalk: true })).toBe('2 years before you stop · until 55 · before tax · counts in your FI date');
    expect(rowSub(mk('s', 'spending', at(45), { yearly: 1 }), plan, money, { start: 45, inWalk: false })).toBe('For good');
    // Before today, the start is said.
    expect(rowSub(mk('w', 'windfall', at(35), { once: 1 }), plan, money, { start: 35, inWalk: false })).toBe('At 35');
  });

  test('a sentence for every kind', () => {
    expect(itemSentence(mk('ss', 'social-security', at(67), { yearly: 18_000, owner: 'partner', beforeTax: true }), plan, money)).toBe('$18,000 a year, at your partner’s 67, for good, before tax');
    expect(itemSentence(mk('pen', 'pension', on('stop', 5), { yearly: 12_000, inflationAdjusted: false }), plan, money)).toBe('$12,000 a year, 5 years after you stop, for good, fixed');
    expect(itemSentence(mk('h', 'home', at(45), { once: 100_000, yearly: -6_000 }), plan, money)).toBe('$100,000 from your investments, then spending $6,000 a year less, at 45, for good');
    expect(itemSentence(mk('car', 'car', on('fi', -1), { once: 40_000, every: 8, times: 3 }), plan, money)).toBe('$40,000 each, 1 year before FI, every 8 years, 3 times');
    expect(itemSentence(mk('roof', 'one-off', on('stop', 2), { once: 30_000 }), plan, money)).toBe('$30,000, 2 years after you stop');
  });
});

describe('the points', () => {
  test('today, the stop, FI and ages, in order, each item under its start', () => {
    const items = [
      mk('home', 'home', at(45), { once: 0, yearly: 0 }),
      mk('pt', 'part-time', on('stop'), { until: at(55), yearly: 20_000 }),
      mk('ss', 'social-security', at(67), { yearly: 18_000, owner: 'partner' }),
      mk('w', 'windfall', at(38), { once: 1_000 }),
    ];
    const plan = { ...base, partnerAge: 38, items };
    const f = figures({ partnerAge: 38, items });
    expect(fiWhen(f)).toEqual({ kind: 'age', age: 46 });
    const layout = timelinePoints(plan, f, money);
    expect(layout.points.map((p) => [p.label, p.items])).toEqual([
      ['Today, 40', [3]],
      ['At 45', [0]],
      ['FI around 46', []],
      ['You stop at 50', [1]],
      ['At 69 · your partner’s 67', [2]],
    ]);
    expect(layout.notReached).toEqual([]);
    expect(layout.unplaced).toEqual([]);
  });

  test('under stop when I reach FI, the stop and FI are one point', () => {
    const items = [mk('pt', 'part-time', on('stop'), { until: at(60), yearly: 20_000 })];
    const f = figures({ stopAtFi: true, items });
    const layout = timelinePoints({ ...base, stopAtFi: true, items }, f, money);
    expect(layout.points.map((p) => p.label)).toEqual([`You stop at FI, around ${f.resolution.stop}`]);
  });

  test('a balance never reached is last, and an item waiting on it with no age is unplaced', () => {
    const items = [mk('t', 'spending', { anchor: { at: 'balance', amount: 900_000_000 }, offset: 0 }, { yearly: 1_000 })];
    const f = figures({ items });
    const layout = timelinePoints({ ...base, items }, f, money);
    expect(layout.notReached.map((p) => [p.label, p.items])).toEqual([['Invested assets reach $900,000,000 · not by 95', [0]]]);
    expect(timelinePoints({ ...base, age: null, items }, null, money)).toEqual({ points: [], notReached: [], unplaced: [0] });
  });

  test('an item on the stop with no stop waits on it', () => {
    const items = [mk('roof', 'one-off', on('stop'), { once: 1_000 })];
    const plan = { ...base, targetAge: null, items };
    const f = figures({ targetAge: null, items });
    const layout = timelinePoints(plan, f, money);
    expect(layout.unplaced).toEqual([0]);
    expect(unplacedText(items[0], f.resolution.why[0], plan)).toBe('Waits on your stop: set it in Household.');
  });
});

describe('where it counts', () => {
  test('one line for each place, the FI date counting one-offs and income (D15)', () => {
    expect(whereItCountsText(50)).toEqual(['Your FI date counts costs, windfalls, changes in pay, work that starts before you stop and other money in, until you reach it.', 'Will it last? counts costs, windfalls and income, from 50, where it starts.']);
    expect(whereItCountsText(null)[1]).toBe('Will it last? counts costs, windfalls and income, from where it starts.');
  });

  test('part-time before Will it last? starts, by what it replaces and the start', () => {
    const pt = mk('pt', 'part-time', at(45), { until: at(55), yearly: 20_000, replaces: 30_000 });
    expect(beforeStartText(pt, { start: 'fi-number' }, 50)).toBe('Its years before 50 count in your FI date, not in Will it last?, which starts at 50.');
    expect(beforeStartText({ ...pt, replaces: null }, { start: 'fi-number' }, 50)).toBeNull();
    expect(beforeStartText(pt, { start: 'assets' }, 40)).toBeNull();
  });

  test('every run, by where Will it last? starts', () => {
    expect(everyRunText(58, { start: 'fi-number' })).toBe('Starts at 58 in every run, as on your steady path: Will it last? starts from your FI number, not your own path.');
    expect(everyRunText(58, { start: 'assets' })).toContain('each run’s path differs from the steady one');
  });

  test('the Honesty cautions', () => {
    const pt = mk('pt', 'part-time', at(45), { until: at(55), yearly: 20_000 });
    expect(itemCautions(pt, { start: 45, stop: 50, inFi: false, taxRate: 0 })).toEqual(['Say what take-home it replaces, so it counts in your FI date.']);
    expect(itemCautions({ ...pt, replaces: 0, beforeTax: true }, { start: 45, stop: 50, inFi: true, taxRate: 0.15 })).toEqual([
      'In your FI date after 15% tax, your plan’s rate on withdrawals. It may keep less: give its take-home for a closer date.',
    ]);
    expect(itemCautions({ ...pt, replaces: 0 }, { start: 45, stop: 50, inFi: true, taxRate: 0 })).toEqual([]);
  });
});

describe('copies and refusals', () => {
  const home = ITEM_TEMPLATES.find((t) => t.id === 'home')!;
  const pt = ITEM_TEMPLATES.find((t) => t.id === 'part-time')!;
  test('a copy’s name: the template, its start, never an amount', () => {
    const plan = { ...base, items: [] };
    const named = (t: typeof home, x: PlanItem) => ({ ...x, label: t.name });
    expect(copyNameFor(home, named(home, mk('h', 'home', at(38), { once: 100_000 })), plan, [])).toBe('Buy a home at 38');
    expect(copyNameFor(pt, named(pt, mk('p', 'part-time', at(50), { until: at(55) })), plan, [])).toBe('Part-time work from 50');
    expect(copyNameFor(pt, named(pt, mk('p', 'part-time', on('stop'), { until: at(55) })), plan, [])).toBe('Part-time work when you stop');
    expect(copyNameFor(home, named(home, mk('h', 'home', on('fi'))), plan, [])).toBe('Buy a home when you reach FI');
    expect(copyNameFor(home, named(home, mk('h', 'home', { anchor: { at: 'balance', amount: 2_000_000 }, offset: 0 })), plan, [])).toBe('Buy a home at a milestone');
    expect(copyNameFor(ITEM_TEMPLATES.find((t) => t.id === 'spending')!, mk('s', 'spending', on('stop', -2), { label: 'A change in spending' }), plan, [])).toBe('A change in spending before you stop');
    expect(copyNameFor(home, named(home, mk('h', 'home', on('stop', -2))), plan, [])).toBe('Buy a home 2 years before you stop');
    expect(copyNameFor(home, named(home, mk('h', 'home', at(38))), plan, [{ id: 'a', name: 'Buy a home at 38' }, { id: 'b', name: 'buy a home at 38 (2)' }])).toBe('Buy a home at 38 (3)');
  });

  test('a copy’s name takes the item’s own name, once it has one', () => {
    const t = ITEM_TEMPLATES.find((x) => x.id === 'other-income')!;
    expect(copyNameFor(t, mk('x', 'other-income', at(67), { label: 'Rent', yearly: 1 }), base, [])).toBe('Rent at 67');
    expect(copyNameFor(t, mk('x', 'other-income', at(67), { label: t.name, yearly: 1 }), base, [])).toBe('Other income at 67');
  });

  test('a refusal names the items', () => {
    const plan = { items: [mk('a', 'spending', at(40), { label: 'Travel' }), mk('b', 'car', at(40), { label: 'A car' })] };
    expect(itemRuleText('items[0] and items[1] wait on each other', plan)).toBe('“Travel” and “A car” wait on each other.');
    expect(itemRuleText('items[1].until is before its start', plan)).toBe('“A car” is before its start.');
  });
});

describe('counts in your FI date', () => {
  const money2 = (x: PlanItem, over = {}) => rowSub(x, { ...base, items: [x], ...over }, money, { start: null, inWalk: countsInFiDate(figures({ items: [x], ...over }, ON), 0) });

  test('what the walk has, by the time you reach FI: income at 67 with FI around 46 moves nothing', () => {
    expect(money2(mk('x', 'other-income', at(45), { yearly: 1_000 }))).toContain('ounts in your FI date');
    expect(money2(mk('x', 'other-income', at(67), { yearly: 1_000 }))).not.toContain('ounts in your FI date');
    // Already at FI: nothing moves it.
    expect(money2(mk('x', 'one-off', at(45), { once: 1_000 }), { assets: 5_000_000 })).not.toContain('ounts in your FI date');
    // With no FI on the walk, it is what the search is looking through.
    expect(money2(mk('x', 'one-off', at(45), { once: 1_000 }), { savings: 0, assets: 1_000, spending: 90_000 })).toContain('ounts in your FI date');
  });
});

describe('what is possible', () => {
  test('a cost before FI moves it; the steady path and the FI date as rows', () => {
    const roof = mk('roof', 'home', at(43), { once: 100_000, yearly: 0 });
    const before = figures({});
    const after = figures({ items: [roof] });
    const p = previewLines({ draft: { ok: roof }, before, after, without: null, where: 'plan', money, startAge: 50, most: null, savings: 50_000, runsOutAt: null });
    expect(p.rows[0]).toEqual({ key: 'On your steady path', value: 'From 43' });
    expect(p.rows[1].key).toBe('Your FI date');
    expect(p.rows[1].value).toMatch(/^From around \d+ to around \d+$/);
    expect(p.lines[0]).toBe('Starts at 43, before your FI date, so it counts in your FI date.');
  });

  test('waiting on figures, and a balance checked each year', () => {
    const p = previewLines({ draft: { error: 'x', missing: true }, before: null, after: null, without: null, where: 'copy', money, startAge: null, most: null, savings: null, runsOutAt: null });
    expect(p.lines).toEqual(['Fill in the figures to see how it moves this copy’s FI age.']);
    const t = mk('t', 'spending', { anchor: { at: 'balance', amount: 900_000_000 }, offset: 0 }, { yearly: 1_000 });
    const q = previewLines({ draft: { ok: t }, before: figures({}), after: figures({ items: [t] }), without: null, where: 'plan', money, startAge: 50, most: { amount: 3_547_000, age: 95 }, savings: null, runsOutAt: null });
    expect(q.rows[0]).toEqual({ key: 'On your steady path', value: 'It never starts' });
    expect(q.lines).toContain('On your steady path invested assets start a year with at most $3,547,000, at 95, so it never starts.');
    expect(q.lines).toContain('Checked on the balance at the start of each year, and started once, so the spending it adds can’t switch it off again.');
  });

  const preview = (x: PlanItem, count = OFF) =>
    previewLines({ draft: { ok: x }, before: figures({}, count), after: figures({ items: [x] }, count), without: null, where: 'plan', money, startAge: 50, most: null, savings: 50_000, runsOutAt: null });
  // FI around 46, Will it last? from 50.
  const NEITHER = 'It comes after you reach FI and before 50, where Will it last? starts, so it counts in neither your FI date nor Will it last?';

  test('after FI, it says where it counts by where Will it last? starts, as its row does', () => {
    const cost = mk('c', 'one-off', at(48), { once: 1_000 });
    for (const count of [OFF, ON]) {
      const p = preview(cost, count);
      expect(p.lines).toContain(NEITHER);
      expect(p.warnings).toEqual(['Before 50, where Will it last? starts, so it isn’t counted anywhere.']);
    }
    expect(preview(mk('c', 'one-off', at(52), { once: 1_000 })).lines).toContain('It starts after you reach FI, so it counts in Will it last?, not in your FI date or your FI number.');
    // Its years past the start count there; one over by then doesn't.
    expect(preview(mk('s', 'spending', at(48), { yearly: 1_000, until: { years: 5 } })).lines).not.toContain(NEITHER);
    expect(preview(mk('s', 'spending', at(47), { yearly: 1_000, until: { years: 2 } })).lines).toContain(NEITHER);
    expect(preview(mk('p', 'pay', at(48), { yearly: 1_000 })).lines).toContain('It starts after you reach FI, and a change in pay ends when you stop, so it counts in neither your FI date nor Will it last?');
  });

  test('before FI, as the app counts, the row and the sheet both say the FI date', () => {
    const p = preview(mk('c', 'one-off', at(44), { once: 1_000 }), ON);
    expect(p.warnings).toEqual(['Before 50, where Will it last? starts, so it counts in your FI date, not in Will it last?']);
    expect(preview(mk('c', 'one-off', at(44), { once: 1_000 }), OFF).warnings).toEqual(['Before 50, where Will it last? starts, so it isn’t counted anywhere.']);
  });

  test('before today, it says so; only a milestone is already true', () => {
    const past = preview(mk('c', 'one-off', at(35), { once: 1_000 }));
    expect(past.rows[0]).toEqual({ key: 'On your steady path', value: 'At 35, before today' });
    expect(past.warnings).toEqual(['Before today, so it isn’t counted: your measured figures may already count it.']);
    expect(preview(mk('s', 'spending', at(35), { yearly: 1_000 })).rows[0].value).toBe('From 35, before today');
    const met = preview(mk('s', 'spending', { anchor: { at: 'balance', amount: 1_000 }, offset: 0 }, { yearly: 1_000 }));
    expect(met.rows[0].value).toBe('Already true today: it starts now');
  });

  test('income before tax is cautioned only where the FI date has it', () => {
    const rent = mk('r', 'other-income', at(45), { yearly: 12_000, beforeTax: true });
    expect(preview(rent, OFF).cautions).toEqual([]);
    expect(preview(rent, ON).cautions[0]).toContain('In your FI date after');
  });

  test('a kind’s help says it counts in the FI date before Will it last? starts', () => {
    for (const id of ['cost', 'social-security', 'pension', 'other-income']) expect(templateHelp(id)).toContain('and in your FI date before then.');
    expect(templateHelp('nothing')).toBeUndefined();
  });

  test('what reaches Will it last?: its start, a repeat, or years that run on past it', () => {
    const on = (x: PlanItem, end: number | null) => reachesStart(x, { start: 50, end }, 55);
    expect(on(mk('p', 'part-time', at(50), { yearly: 1_000 }), 60)).toBe(true);
    expect(on(mk('p', 'part-time', at(50), { yearly: 1_000 }), 55)).toBe(false);
    expect(on(mk('c', 'one-off', at(50), { once: 1_000 }), null)).toBe(false);
    expect(on(mk('c', 'one-off', at(50), { once: 1_000, every: 5, times: 2 }), null)).toBe(true);
    expect(on(mk('c', 'one-off', at(50), { once: 1_000, every: 4, times: 2 }), null)).toBe(false);
    expect(on(mk('h', 'home', at(50), { once: 1_000, yearly: 0 }), null)).toBe(false);
    expect(on(mk('h', 'home', at(50), { once: 1_000, yearly: 500 }), null)).toBe(true);
    expect(on(mk('n', 'pay', at(50), { yearly: 500 }), null)).toBe(false);
    expect(reachesStart(mk('c', 'one-off', at(60), { once: 1_000 }), { start: 60, end: null }, 55)).toBe(true);
  });

  test('a change in pay says what you’d save', () => {
    const pay = mk('pay', 'pay', at(45), { yearly: -20_000 });
    const p = previewLines({ draft: { ok: pay }, before: figures({}, ON), after: figures({ items: [pay] }, ON), without: null, where: 'plan', money, startAge: 50, most: null, savings: 50_000, runsOutAt: null });
    expect(p.rows).toContainEqual({ key: 'You’d save', value: '$30,000 a year, not $50,000' });
  });
});
