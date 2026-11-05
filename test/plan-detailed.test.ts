// A detailed plan's figures on the page (components/plan-detailed.ts): what the page
// knows made into the drawdown's input, the one flow every caller takes, and what the
// year's spending holds of the category or tag that already pays for coverage.

import { describe, expect, test } from 'bun:test';
import type { BucketsToday } from '@/lib/fire/buckets-today';
import { trailingFlows } from '@/lib/fire/inputs';
import type { PlanItem } from '@/lib/fire/items';
import { DEFAULT_PLAN, type Measured } from '@/lib/fire/plan';
import { drawdownMovesFi, planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { runSearchJob, type SearchJob, type SearchResult } from '@/lib/fire/search-job';
import { DEFAULT_TAX_CHOICES, type TaxChoices } from '@/lib/fire/tax-choices';
import { DEFAULT_TAX_FACTS, type TaxFacts } from '@/lib/fire/tax-facts';
import type { Txn } from '@/lib/transactions';
import { createDetailedFigures, detailedInput, measuredYield } from '@/components/plan-detailed';
import { ON } from './plan-gen';

const account = (bucket: string, value: number, over: object = {}) => ({ owner: 'you', value, basis: null, account_id: `${bucket}-${value}`, subtype: null, income: null, contributions: null, ...over });
const group = (bucket: string, ...accounts: ReturnType<typeof account>[]) => ({ bucket, accounts, total: accounts.reduce((s, a) => s + a.value, 0) });
const TODAY = {
  groups: [group('taxable', account('taxable', 300_000, { income: 6_000 }), account('taxable', 100_000)), group('tax-deferred', account('tax-deferred', 300_000), account('tax-deferred', 100_000, { subtype: '457b' }), account('tax-deferred', 200_000, { owner: 'partner', subtype: '457b' })), group('roth', account('roth', 200_000))],
  total: 1_200_000,
  leftOut: { accounts: [], total: 0 },
  roth: [{ owner: 'you', amount: 80_000 }],
} as unknown as BucketsToday;
const FACTS: TaxFacts = { ...DEFAULT_TAX_FACTS, model: 'detailed', filing: 'joint', dependents: [{ id: 'd1', untilAge: 55 }] };
const input = (over: Partial<Parameters<typeof detailedInput>[0]> = {}) => detailedInput({ plan: { age: 45, partnerAge: 44 }, tax: DEFAULT_TAX_CHOICES, facts: FACTS, today: TODAY, paid: 0, calendarYear: 2026, ...over });

describe('what the page knows, as the drawdown’s input', () => {
  test('choices and facts land where the years read them', () => {
    const tax: TaxChoices = { ...DEFAULT_TAX_CHOICES, state: 'CO', stateRate: 0.044, inflation: 0.025, taxableYield: 0.03, savingsSplit: [{ bucket: 'roth', share: 1 }], health: { beforeMedicare: { kind: 'other', yearly: 6_000 }, medicareExtra: 1_200, meetsMedicaidRule: ['you'], countMedicaid: true, acaLaw: 'enhanced', growth: 0.015 } };
    const made = input({ tax, paid: 900 });
    expect(made).toMatchObject({ calendarYear: 2026, filing: 'joint', dependents: FACTS.dependents, inflation: 0.025, taxableYield: 0.03, state: 'CO', stateRate: 0.044, savingsSplit: [{ bucket: 'roth', share: 1 }], paidToday: 900, lawYear: { year: 2026, behind: false } });
    expect(made.health).toEqual({ coverage: { kind: 'other', yearly: 6_000 }, medicareExtra: 1_200, meetsRule: ['you'], countMedicaid: true, acaLaw: 'enhanced', growth: 0.015, incomeGrowth: 0.011 });
    expect(made.buckets).toEqual({ groups: TODAY.groups, roth: TODAY.roth, total: 1_200_000 });
  });

  test('no choices take the defaults, and health grows at the law’s', () => {
    const made = input({ tax: null });
    expect(made.inflation).toBe(DEFAULT_TAX_CHOICES.inflation);
    expect(made.health.growth).toBe(0.021);
    expect(made.health.coverage).toBeNull();
  });

  test('a state with no income tax has no rate, whatever was typed', () => {
    expect(input({ tax: { ...DEFAULT_TAX_CHOICES, state: 'NV', stateRate: 0.05 } })).toMatchObject({ state: 'NV', stateRate: 0 });
    expect(input({ tax: { ...DEFAULT_TAX_CHOICES, state: 'WA', stateRate: 0.05 } })).toMatchObject({ stateRate: 0 });
    expect(input({ tax: { ...DEFAULT_TAX_CHOICES, state: 'OR', stateRate: 0.05 } })).toMatchObject({ stateRate: 0.05 });
  });

  test('required withdrawals start by birth year, said or from your age', () => {
    expect(input().rmdAges).toEqual({ you: 75, partner: 75 });
    // Born 1959 or earlier: 73.
    expect(input({ plan: { age: 67, partnerAge: 66 }, facts: { ...FACTS, birthYears: [{ owner: 'partner', year: 1950 }] } }).rmdAges).toEqual({ you: 73, partner: 72 });
    expect(input({ plan: { age: 45, partnerAge: null } }).rmdAges).toEqual({ you: 75, partner: 75 });
  });

  test('each person’s 457(b) share is of their own tax-deferred money', () => {
    expect(input().share457).toEqual({ you: 0.25, partner: 1 });
  });

  test('the yield is the choice, else measured over what taxable accounts report, else none', () => {
    expect(measuredYield(TODAY)).toBeCloseTo(0.02);
    expect(input().taxableYield).toBeCloseTo(0.02);
    expect(input({ tax: { ...DEFAULT_TAX_CHOICES, taxableYield: 0 } }).taxableYield).toBe(0);
    const none = { ...TODAY, groups: [group('roth', account('roth', 100_000, { income: 500 }))] } as unknown as BucketsToday;
    expect(measuredYield(none)).toBeNull();
    // An account just emptied, or a year of reversals, says nothing about what the rest pays.
    const odd = (income: number) => ({ ...TODAY, groups: [group('taxable', account('a', 100_000, { income: 2_000 }), account('b', 2_000, { income }))] }) as unknown as BucketsToday;
    expect(measuredYield(odd(5_000))).toBeCloseTo(0.02);
    expect(measuredYield(odd(-40))).toBeCloseTo(0.02);
    expect(measuredYield(odd(40))).toBeCloseTo(0.02);
    expect(input({ today: none }).taxableYield).toBe(0);
  });

  test('a year past the law’s last says which it used', () => {
    expect(input({ calendarYear: 2099 }).lawYear.behind).toBe(true);
  });
});

const at = (a: PlanItem['from']['anchor']) => ({ anchor: a, offset: 0 });
const item = (over: Partial<PlanItem>): PlanItem => ({ id: 'x', label: 'x', kind: 'part-time', from: at({ at: 'age', age: 60 }), until: null, once: null, yearly: 20_000, replaces: null, every: null, times: null, inflationAdjusted: true, owner: 'you', beforeTax: true, ...over });
const plan = (over: Partial<FirePlanV2> = {}): FirePlanV2 => ({ ...planOf({ ...DEFAULT_PLAN, age: 45, targetAge: 55, spending: 60_000, savings: 40_000, assets: 1_000_000, realReturn: 0.05, withdrawalRate: 0.04 }), ...over });
const M: Measured = { spending: null, savings: null, assets: null };
const IN = input({ tax: { ...DEFAULT_TAX_CHOICES, state: 'CO', stateRate: 0.044, health: { ...DEFAULT_TAX_CHOICES.health, beforeMedicare: { kind: 'other', yearly: 6_000 } } } });
const flatOf = (p: FirePlanV2) => planFigures(p, M, { count: ON });
const figuresIn = (f: ReturnType<typeof flatOf>): PlanFigures => {
  if ('refused' in f) throw new Error('refused');
  return f;
};

/** A search store that answers when told, and says what it was asked. */
function fakeSearch() {
  const answers = new Map<string, SearchResult>();
  const asked: { slot: string; job: SearchJob }[] = [];
  const dropped: string[] = [];
  return {
    asked,
    dropped,
    answers,
    answer(slot: string, job: SearchJob) {
      asked.push({ slot, job });
      return answers.get(slot) ?? null;
    },
    drop(slot: string) {
      dropped.push(slot);
    },
  };
}

describe('one flow for every caller', () => {
  const SEARCHING = plan({ stopAtFi: true, items: [item({ id: 'm', from: at({ at: 'balance', amount: 2_000_000 }) })] });

  test('it can’t move the answer: the flat one’s, with the years added, and no job', () => {
    const p = plan({ items: [item({})] });
    const flat = figuresIn(flatOf(p));
    expect(drawdownMovesFi(p, flat.walk, 40_000, flat.view.stopAge)).toBe(false);
    const search = fakeSearch();
    const r = createDetailedFigures(search)('plan', p, M, ON, IN, flat);
    const f = figuresIn(r.figures);
    expect(r).toMatchObject({ working: false, failed: false });
    expect(f.view).toEqual(flat.view);
    expect(f.walk).toEqual(flat.walk);
    expect(f.resolution).toEqual(flat.resolution);
    expect(f.detail).not.toBeNull();
    expect(search.asked).toEqual([]);
    expect(search.dropped).toEqual(['plan']);
  });

  test('it can, with nothing searched for: worked out here, its tax in the walk', () => {
    const p = plan({ targetAge: 60, items: [item({ id: 'h', kind: 'one-off', from: at({ at: 'age', age: 50 }), once: 600_000, yearly: null })] });
    const flat = figuresIn(flatOf(p));
    expect(drawdownMovesFi(p, flat.walk, 40_000, flat.view.stopAge)).toBe(true);
    const search = fakeSearch();
    const f = figuresIn(createDetailedFigures(search)('plan', p, M, ON, IN, flat).figures);
    expect(search.asked).toEqual([]);
    expect(f.walkFrom.tax).toBe(true);
    expect(f.walk).not.toEqual(flat.walk);
  });

  test('it can, with a search: the job; meanwhile the flat answer, with its years, dimmed', () => {
    const flat = figuresIn(flatOf(SEARCHING));
    const search = fakeSearch();
    const run = createDetailedFigures(search);
    const r = run('plan', SEARCHING, M, ON, IN, flat);
    expect(r.working).toBe(true);
    expect(figuresIn(r.figures).resolution).toEqual(flat.resolution);
    expect(figuresIn(r.figures).detail).not.toBeNull();
    expect(search.asked).toHaveLength(1);
    expect(search.asked[0].job).toEqual({ plan: SEARCHING, measured: M, count: ON, detailed: IN });
  });

  test('its answer is what planFigures finds by itself', () => {
    const flat = figuresIn(flatOf(SEARCHING));
    const search = fakeSearch();
    const run = createDetailedFigures(search);
    search.answers.set('plan', runSearchJob({ plan: SEARCHING, measured: M, count: ON, detailed: IN }));
    const r = run('plan', SEARCHING, M, ON, IN, flat);
    expect(r).toMatchObject({ working: false, failed: false });
    const direct = figuresIn(createDetailedFigures(fakeSearch())('other', { ...SEARCHING, stopAtFi: false }, M, ON, IN, figuresIn(flatOf({ ...SEARCHING, stopAtFi: false }))).figures);
    expect(figuresIn(r.figures).detail).not.toBeNull();
    expect(direct.detail).not.toBeNull();
    const answered = search.answers.get('plan')!;
    if (!answered.ok || 'refused' in answered.answer) throw new Error('no answer');
    expect(figuresIn(r.figures).resolution).toEqual(answered.answer);
  });

  test('while a new job is out: the last answer while its items are the same, never for others', () => {
    const flat = figuresIn(flatOf(SEARCHING));
    const search = fakeSearch();
    const run = createDetailedFigures(search);
    const first = runSearchJob({ plan: SEARCHING, measured: M, count: ON, detailed: IN });
    search.answers.set('plan', first);
    run('plan', SEARCHING, M, ON, IN, flat);
    search.answers.delete('plan');
    if (!first.ok || 'refused' in first.answer) throw new Error('no answer');
    const refreshed = { ...SEARCHING, spending: 61_000 };
    const same = run('plan', refreshed, M, ON, IN, figuresIn(flatOf(refreshed)));
    expect(same.working).toBe(true);
    expect(figuresIn(same.figures).resolution).toEqual(first.answer);
    const another = { ...SEARCHING, items: [...SEARCHING.items, item({ id: 'n' })] };
    const anotherFlat = figuresIn(flatOf(another));
    const differs = run('plan', another, M, ON, IN, anotherFlat);
    expect(differs.working).toBe(true);
    expect(figuresIn(differs.figures).resolution).toEqual(anotherFlat.resolution);
  });

  test('a job that failed: flagged, on the flat answer; a refusal is its answer', () => {
    const flat = figuresIn(flatOf(SEARCHING));
    const search = fakeSearch();
    const run = createDetailedFigures(search);
    search.answers.set('plan', { ok: false, error: 'the chunk failed to load', unavailable: true });
    const failed = run('plan', SEARCHING, M, ON, IN, flat);
    expect(failed).toMatchObject({ working: false, failed: true });
    expect(figuresIn(failed.figures).resolution).toEqual(flat.resolution);
    search.answers.set('plan', { ok: true, answer: { refused: 'below-zero', spending: 1, lasting: -2 } });
    expect(run('plan', SEARCHING, M, ON, IN, flat).figures).toEqual({ refused: 'below-zero', spending: 1, lasting: -2 });
  });

  test('flat refused: it stands', () => {
    const search = fakeSearch();
    const refused = { refused: 'below-zero', spending: 1, lasting: -2 } as const;
    expect(createDetailedFigures(search)('plan', plan(), M, ON, IN, refused)).toEqual({ figures: refused, working: false, failed: false });
    expect(search.asked).toEqual([]);
  });

  test('a render asks nothing twice: the same figures, by identity', () => {
    const p = plan({ items: [item({})] });
    const run = createDetailedFigures(fakeSearch());
    const flat = flatOf(p);
    expect(run('plan', p, M, ON, IN, flat).figures).toBe(run('plan', { ...p }, { ...M }, ON, { ...IN }, flat).figures);
  });
});

describe('what the year’s spending holds of what already pays for coverage', () => {
  const row = (over: Partial<Txn>): Txn => ({ transaction_id: `t${Math.random()}`, date: '2026-06-01', amount: 100, name: 'x', category: 'medical', category_name: 'Health', currency: 'USD', iso_currency_code: 'USD', ...over }) as unknown as Txn;
  const rows = [
    // The year's first day, so nothing is scaled.
    row({ date: '2025-11-02', amount: 500, category: 'rent and utilities', category_name: 'Rent' }),
    row({ date: '2026-01-10', amount: 800 }),
    row({ date: '2026-02-10', amount: 800, tags: ['tag1'], category: 'general services', category_name: 'Other' }),
    row({ date: '2026-03-10', amount: -100 }),
    row({ date: '2025-10-01', amount: 200, category: 'rent and utilities', category_name: 'Rent' }),
    row({ date: '2020-01-01', amount: 900 }),
  ];
  const TODAY_DAY = '2026-11-01';

  test('by category and by tag, refunds taken off, the year only', () => {
    expect(trailingFlows(rows, TODAY_DAY, { paid: { kind: 'category', name: 'Health' } })?.paid).toBe(700);
    expect(trailingFlows(rows, TODAY_DAY, { paid: { kind: 'tag', name: 'tag1' } })?.paid).toBe(800);
    expect(trailingFlows(rows, TODAY_DAY, { paid: { kind: 'category', name: 'Nothing' } })?.paid).toBe(0);
  });

  test('asked about nothing: no new field, the figures as they were', () => {
    const plain = trailingFlows(rows, TODAY_DAY)!;
    expect('paid' in plain).toBe(false);
    const { paid: _paid, ...asked } = trailingFlows(rows, TODAY_DAY, { paid: { kind: 'category', name: 'Health' } })!;
    expect(asked).toEqual(plain);
  });

  test('a short year is scaled as spending is', () => {
    const short = trailingFlows(rows.slice(1, 2).concat(row({ date: '2026-07-10', amount: 800 })), TODAY_DAY, { paid: { kind: 'category', name: 'Health' } })!;
    expect(short.scaled).toBe(true);
    expect(short.paid).toBeCloseTo(short.spending);
  });
});
