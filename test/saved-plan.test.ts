import { describe, expect, test } from 'bun:test';
import { DEFAULT_PLAN, type FirePlan } from '@/lib/fire/plan';
import { changedSince, isSavedPlan, parseSavedDraft, plannedAt, upgradeSavedPlan, yearsBetween, type SavedPlan } from '@/lib/fire/saved-plan';

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

describe('what the Plan changed since that moves the comparison', () => {
  test('growth, include cash and typed savings only', () => {
    expect(changedSince(SAVED, PLAN)).toEqual([]);
    // A birthday, or a new withdrawal rate, moves nothing the comparison uses.
    expect(changedSince(SAVED, { ...PLAN, age: 36, withdrawalRate: 0.035, spending: 50_000 })).toEqual([]);
    expect(changedSince(SAVED, { ...PLAN, realReturn: 0.04, includeCash: true, savings: 12_000 })).toEqual(['growth after inflation', 'include cash', 'the savings you typed']);
    expect(changedSince({ plan: { ...PLAN, savings: 12_000 } }, PLAN)).toEqual(['savings, which follow Nya’s figure now']);
  });
});
