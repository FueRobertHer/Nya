import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLAN, type FirePlan } from '@/lib/fire/plan';
import { changedSince, isSavedPlan, parseSavedDraft, plannedAt, upgradeSavedPlan, yearsBetween, type SavedItems, type SavedPlan } from '@/lib/fire/saved-plan';
import { resolveSaved } from '@/lib/fire/plan-figures';

// The plan saved as your plan (lib/fire/saved-plan.ts): what a save must
// meet, what a stored one must be to read back, where the plan has you on a
// day (worked by hand), and what the Plan changed since that moves it.

const PLAN: FirePlan = { ...DEFAULT_PLAN, age: 35, targetAge: 55, realReturn: 0.05 };
const SAVED: SavedPlan = {
  version: 1,
  plan: PLAN,
  savings: 10_000,
  currency: 'USD',
  inflation: 0.03,
  day: '2024-10-26',
  savedAt: '2024-10-26T15:00:00.000Z',
  rev: 'rev-1',
};
const draft = (over: Record<string, unknown> = {}) => ({ plan: PLAN, savings: 10_000, currency: 'USD', inflation: 0.03, ...over });

describe('what a save must meet', () => {
  test('exactly the draft, the plan as the Plan’s own save takes it, figures in range', () => {
    expect(parseSavedDraft(draft())).toEqual({ ok: draft() });
    expect(parseSavedDraft(draft({ currency: null }))).toEqual({ ok: draft({ currency: null }) });
    const refused: [unknown, string][] = [
      [null, 'as an object'],
      [draft({ extra: 1 }), 'extra isn’t taken here'],
      [{ plan: PLAN, savings: 1, currency: 'USD' }, 'plan, savings, currency and inflation'],
      [draft({ plan: { ...PLAN, withdrawalRate: 2 } }), 'plan:'],
      [draft({ savings: Number.NaN }), 'savings is an amount'],
      [draft({ savings: '10000' }), 'savings is an amount'],
      [draft({ currency: 'usd' }), 'currency is a currency code'],
      [draft({ inflation: -0.01 }), 'inflation is a rate'],
      [draft({ inflation: 0.21 }), 'inflation is a rate'],
      // The server sets these.
      [{ ...draft(), day: '2024-10-26' }, 'day isn’t taken here'],
      [{ ...draft(), rev: 'x' }, 'rev isn’t taken here'],
    ];
    for (const [raw, said] of refused) {
      const r = parseSavedDraft(raw);
      expect([raw, 'error' in r ? r.error : 'saved']).toEqual([raw, expect.stringContaining(said)]);
    }
  });

  test('negative savings are a plan too (spending more than comes in)', () => {
    expect(parseSavedDraft(draft({ savings: -5_000 }))).toEqual({ ok: draft({ savings: -5_000 }) });
  });
});

describe('what a stored one must be to read back', () => {
  test('the shape and types, never a figure worked out, none of today’s ranges', () => {
    expect(isSavedPlan(SAVED)).toBe(true);
    // A range narrowed since it was saved still reads: the shape holds.
    expect(isSavedPlan({ ...SAVED, plan: { ...PLAN, withdrawalRate: 0.5 }, inflation: 0.5 })).toBe(true);
    // A result is never part of one.
    expect(isSavedPlan({ ...SAVED, fiAge: 48 })).toBe(false);
    expect(isSavedPlan({ ...SAVED, assets: 100_000 })).toBe(false);
    expect(isSavedPlan({ ...SAVED, version: 2 })).toBe(false);
    expect(isSavedPlan({ ...SAVED, day: '2024-02-30' })).toBe(false);
    expect(isSavedPlan({ ...SAVED, savedAt: 'yesterday' })).toBe(false);
    expect(isSavedPlan({ ...SAVED, currency: 'usd' })).toBe(false);
    expect(isSavedPlan({ ...SAVED, plan: { ...PLAN, method: 'tarot' } })).toBe(false);
  });

  test('a plan saved before a field was added reads with it filled in, as the Plan’s store reads it', () => {
    const { planFunding: _, ...older } = PLAN;
    const upgraded = upgradeSavedPlan({ ...SAVED, plan: older });
    expect(isSavedPlan(upgraded)).toBe(true);
    expect((upgraded as SavedPlan).plan.planFunding).toEqual([]);
    // Anything else is left for isSavedPlan to refuse.
    expect(upgradeSavedPlan('text')).toBe('text');
    expect(upgradeSavedPlan({ ...SAVED, version: 2 })).toEqual({ ...SAVED, version: 2 });
  });
});

describe('where the saved plan has you on a day', () => {
  const start = { day: '2024-10-26', total: 100_000 };

  test('four years on, by hand: grown at 5%, savings of 10,000 a year added, raised by 3% inflation a year', () => {
    // 1,461 days is four years of 365.25.
    expect(yearsBetween('2024-10-26', '2028-10-26')).toBe(4);
    // 100,000 x 1.05^4 + 10,000 x (1.05^4 - 1) / 0.05 = 121,550.625 + 43,101.25
    // = 164,651.875 in the start day's dollars, x 1.03^4 (1.12550881) in that
    // day's own: 185,317.14.
    expect(plannedAt(SAVED, start, '2028-10-26')).toBeCloseTo(185_317.14, 2);
  });

  test('on the start day it is the start; between years the savings come in steadily; never before the start', () => {
    expect(plannedAt(SAVED, start, '2024-10-26')).toBe(100_000);
    // Half a year (182 days, 0.498 years), no savings: 50,000 x 1.05^0.498 x 1.03^0.498.
    const t = 182 / 365.25;
    expect(plannedAt({ ...SAVED, savings: 0 }, { day: '2025-10-26', total: 50_000 }, '2026-04-26')).toBeCloseTo(50_000 * 1.05 ** t * 1.03 ** t, 6);
    expect(plannedAt({ ...SAVED, savings: 0 }, { day: '2025-10-26', total: 50_000 }, '2026-04-26')).toBeCloseTo(51_990.63, 2);
    const half = plannedAt(SAVED, start, '2025-04-26')!;
    const year = plannedAt(SAVED, start, '2025-10-26')!;
    expect(half).toBeGreaterThan(plannedAt({ ...SAVED, savings: 0 }, start, '2025-04-26')!);
    expect(half).toBeLessThan(year);
    expect(plannedAt(SAVED, start, '2024-10-25')).toBeNull();
  });

  test('no growth and no inflation is the start plus the savings so far', () => {
    expect(plannedAt({ ...SAVED, plan: { ...PLAN, realReturn: 0 }, inflation: 0 }, start, '2026-10-26')).toBeCloseTo(100_000 + 10_000 * (730 / 365.25), 6);
  });

  test('a growth rate the formula doesn’t take gives nothing, never a guess', () => {
    expect(plannedAt({ ...SAVED, plan: { ...PLAN, realReturn: -1 } }, start, '2025-10-26')).toBeNull();
  });
});

describe('a saved plan’s one-offs and income on its line', () => {
  const start = { day: '2024-10-26', total: 100_000 };
  const walk = (over: Partial<SavedItems['walk']>): SavedItems => ({ from: '2024-10-26', age: 35, walk: { moneyIn: [], costs: [], spans: [], ...over }, counted: [] });

  test('by hand: a cost at the start of its year, grown from then', () => {
    // 164,651.875 four years on (above), less 20,000 taken two years in and
    // its two years of growth (22,050), raised by 3% inflation a year.
    expect(plannedAt(SAVED, start, '2028-10-26', walk({ costs: [{ year: 2, amount: 20_000 }] }))).toBeCloseTo((164_651.875 - 22_050) * 1.03 ** 4, 6);
    expect(plannedAt(SAVED, start, '2028-10-26', walk({ moneyIn: [{ year: 2, amount: 20_000 }] }))).toBeCloseTo((164_651.875 + 22_050) * 1.03 ** 4, 6);
    // Not yet come: nothing.
    expect(plannedAt(SAVED, start, '2025-10-26', walk({ costs: [{ year: 2, amount: 20_000 }] }))).toBe(plannedAt(SAVED, start, '2025-10-26'));
  });

  test('a year that starts before the start day is left out: the measured start holds it', () => {
    const later = { day: '2025-10-26', total: 100_000 };
    expect(plannedAt(SAVED, later, '2027-10-26', walk({ costs: [{ year: 0, amount: 20_000 }] }))).toBe(plannedAt(SAVED, later, '2027-10-26'));
    // Year 1 starts 365.25 days after the saved day, a day after the start.
    const years = yearsBetween(later.day, '2027-10-26');
    const at = 1 - yearsBetween('2024-10-26', later.day);
    expect(plannedAt(SAVED, later, '2027-10-26', walk({ costs: [{ year: 1, amount: 20_000 }] }))).toBeCloseTo(plannedAt(SAVED, later, '2027-10-26')! - 20_000 * 1.05 ** (years - at) * 1.03 ** years, 6);
  });

  test('a change to savings is added through the years it covers, as the savings are', () => {
    const flat = { ...SAVED, plan: { ...PLAN, realReturn: 0 }, inflation: 0 };
    expect(plannedAt(flat, start, '2028-10-26', walk({ spans: [{ from: 1, to: 3, delta: -10_000 }] }))).toBeCloseTo(140_000 - 20_000, 6);
    expect(plannedAt(flat, start, '2028-10-26', walk({ spans: [{ from: 3, to: null, delta: 5_000 }] }))).toBeCloseTo(140_000 + 5_000, 6);
  });

  test('placed once from the saved copy, with D15’s switch: one-offs and income only with it on', () => {
    const saved = { ...SAVED, plan: { ...PLAN, expenses: [{ id: 'roof', label: 'Roof', amount: 20_000, atAge: 37 }] } };
    expect(resolveSaved(saved, start, 40_000, { planInWalk: false })).toBeNull();
    const on = resolveSaved(saved, start, 40_000, { planInWalk: true });
    expect(on?.walk.costs).toEqual([{ year: 2, amount: 20_000 }]);
    expect(on?.counted.map((c) => [c.item.label, c.ages])).toEqual([['Roof', { start: 37, end: null }]]);
    expect(resolveSaved(saved, start, 40_000, { planInWalk: true })).toBe(on);
    // No age: nothing placed, a steady line as before.
    expect(resolveSaved({ ...saved, rev: 'r2', plan: { ...saved.plan, age: null } }, start, 40_000, { planInWalk: true })).toBeNull();
  });
});

describe('what the Plan changed since that moves the comparison', () => {
  test('growth, include cash and typed savings only', () => {
    expect(changedSince(SAVED, PLAN)).toEqual([]);
    // A birthday, or a new withdrawal rate, moves nothing the comparison uses.
    expect(changedSince(SAVED, { ...PLAN, age: 36, withdrawalRate: 0.035, spending: 50_000 })).toEqual([]);
    expect(changedSince(SAVED, { ...PLAN, realReturn: 0.04, includeCash: true, savings: 12_000 })).toEqual(['growth after inflation', 'include cash', 'the savings you typed']);
    expect(changedSince({ plan: { ...PLAN, savings: 12_000 } }, PLAN)).toEqual(['savings, which follow Nya’s figure now']);
  });
});
