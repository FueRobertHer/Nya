// What the stress test says of its history and your accounts' own growth
// (components/plan-text.ts historyLine and the Assumptions notes, from
// lib/fire/account-growth.ts historyMove), and Compare's "Stress test differs"
// (components/plan-diff.ts).

import { describe, expect, test } from 'bun:test';
import { historyMove, type HistoryMove } from '@/lib/fire/account-growth';
import { gapPoints, historyAsItRanNote, historyFar, historyLine, historyFarText, historyMovedNote } from '@/components/plan-text';
import { copyDiffParts } from '@/components/plan-diff';
import { DEFAULT_PLAN_V2, type FirePlanV2 } from '@/lib/fire/plan-v2';

const flat = (over: Partial<HistoryMove> = {}): HistoryMove => ({ on: true, blend: 0.051, rate: 0.05, together: 0.051 - 0.05, buckets: null, ...over });

describe('the points said for a gap', () => {
  test('to a tenth, a hundredth where a tenth says nothing, and nothing below that', () => {
    // 0.06 - 0.05 is 0.009999999999999995: a point, as said.
    expect(gapPoints(0.06 - 0.05)).toBe(1);
    expect(gapPoints(0.051 - 0.05)).toBe(0.1);
    expect(gapPoints(-0.003)).toBe(0.3);
    expect(gapPoints(0.0004)).toBe(0.04);
    expect(gapPoints(0.00001)).toBe(0);
    expect(gapPoints(0)).toBe(0);
  });
});

describe('what is moved, from the plan', () => {
  const view = { growth: 0.058, ownRates: 1 };
  test('nothing could move with no account at its own rate', () => {
    expect(historyMove({ realReturn: 0.05, historyMoved: true }, { growth: 0.05, ownRates: 0 }, { taxable: 0.07 })).toBeNull();
  });

  test('on or off, the gaps it would move by: the blend’s, and each bucket held', () => {
    const off = historyMove({ realReturn: 0.05 }, view, { taxable: 0.07, deferred: 0.05, roth: 0.05 }) as HistoryMove;
    expect(off.on).toBe(false);
    expect(off.together).toBeCloseTo(0.008, 12);
    expect(off.buckets?.map((b) => b.bucket)).toEqual(['taxable', 'deferred', 'roth']);
    expect(off.buckets?.[0].gap).toBeCloseTo(0.02, 12);
    expect(off.buckets?.[1].gap).toBe(0);
    expect(historyMove({ realReturn: 0.05, historyMoved: true }, view, null)?.buckets).toBeNull();
  });

  test('a 457(b) at tax-deferred’s gap is said with it, and on its own otherwise', () => {
    expect(historyMove({ realReturn: 0.05 }, view, { deferred: 0.06, deferred457: 0.06 })?.buckets?.map((b) => b.bucket)).toEqual(['deferred']);
    expect(historyMove({ realReturn: 0.05 }, view, { deferred: 0.06, deferred457: 0.05 })?.buckets?.map((b) => b.bucket)).toEqual(['deferred', 'deferred457']);
    expect(historyMove({ realReturn: 0.05 }, view, { deferred457: 0.06 })?.buckets?.map((b) => b.bucket)).toEqual(['deferred457']);
  });
});

describe('the stress test’s line', () => {
  test('as it ran: where your accounts’ growth counts, and that Assumptions can move history by it', () => {
    // The steady years with a flat rate too: Your path's years after the stop grow at the blend.
    const said = 'History as it ran: your accounts’ own growth (5.1% together) counts only in the steady years. Assumptions can move history by it.';
    expect(historyLine(flat({ on: false }))).toBe(said);
    expect(historyLine(flat({ on: false, buckets: [] }))).toBe(said);
    // Nothing to move it by: not offered as a move.
    expect(historyLine(flat({ on: false, blend: 0.05, together: 0 }))).toBe('History as it ran: your accounts’ own growth comes to the plan’s 5%.');
  });

  test('moved with a flat rate: by how much, higher or lower, against the plan’s rate', () => {
    expect(historyLine(flat())).toBe('History moved 0.1 points a year higher by your accounts’ own growth: 5.1% together, against the plan’s 5%.');
    expect(historyLine(flat({ blend: 0.04, together: 0.04 - 0.05 }))).toBe('History moved 1 point a year lower by your accounts’ own growth: 4% together, against the plan’s 5%.');
  });

  test('moved with tax worked out: each bucket that moves, then together', () => {
    const m = flat({
      buckets: [
        { bucket: 'taxable', gap: 0.01 },
        { bucket: 'deferred', gap: -0.003 },
        { bucket: 'roth', gap: 0 },
      ],
    });
    expect(historyLine(m)).toBe('History moved by your accounts’ own growth: taxable 1 point a year higher, tax-deferred 0.3 lower, 0.1 higher together.');
    expect(historyLine({ ...m, together: 0 })).toBe('History moved by your accounts’ own growth: taxable 1 point a year higher, tax-deferred 0.3 lower, unmoved together.');
  });

  test('moved by nothing: as it ran, at the plan’s rate', () => {
    expect(historyLine(flat({ blend: 0.05, together: 0 }))).toBe('History as it ran: your accounts’ own growth comes to the plan’s 5%.');
    expect(historyLine(flat({ blend: 0.05, together: 0, buckets: [{ bucket: 'taxable', gap: 0 }] }))).toBe('History as it ran: your accounts’ own growth comes to the plan’s 5%.');
  });

  test('a caution from a point a year higher, as said; never lower, nor off', () => {
    expect(historyFar(flat({ blend: 0.06, together: 0.06 - 0.05 }))).toBe(true);
    expect(historyFar(flat({ blend: 0.0595, together: 0.0095 }))).toBe(true);
    expect(historyFar(flat({ blend: 0.0594, together: 0.0094 }))).toBe(false);
    expect(historyFar(flat({ blend: 0.03, together: -0.02 }))).toBe(false);
    expect(historyFar(flat({ on: false, blend: 0.07, together: 0.02 }))).toBe(false);
    expect(historyFarText(false)).toBe('Every start does far better than it did, and a rate from a few strong years rarely repeats.');
    expect(historyFarText(true)).toBe('Every run does far better than the history it’s drawn from, and a rate from a few strong years rarely repeats.');
  });
});

describe('the Assumptions notes', () => {
  test('as it ran: where your accounts’ growth counts, for starts or runs', () => {
    expect(historyAsItRanNote(false)).toBe('Every start lives through the market as it was, for your mix. Your accounts’ own growth counts only in the steady years.');
    expect(historyAsItRanNote(true)).toBe('Every run is drawn from the market as it was, for your mix. Your accounts’ own growth counts only in the steady years.');
  });

  test('moved: by how much at the rate as typed, the buckets unmoved named, and how much a point moves', () => {
    const TAIL = ' A point a year can move the answer by 10 points or more.';
    expect(historyMovedNote(flat())).toBe(`Every year of history 0.1 points higher: your accounts grow 5.1% together, against the plan’s 5%.${TAIL}`);
    const m = flat({
      buckets: [
        { bucket: 'taxable', gap: 0.01 },
        { bucket: 'deferred', gap: -0.003 },
        { bucket: 'roth', gap: 0 },
        { bucket: 'hsa', gap: 0 },
      ],
    });
    expect(historyMovedNote(m)).toBe(`Every year of history moves by your accounts’ gap from the plan’s 5%: taxable 1 point higher, tax-deferred 0.3 lower, Roth and HSA unmoved.${TAIL}`);
    expect(historyMovedNote(flat({ blend: 0.05, together: 0 }))).toBe(`Your accounts grow at the plan’s 5% together, so nothing moves.${TAIL}`);
    expect(historyMovedNote(null)).toBe(`Every year of history moves by your accounts’ gap from the plan’s rate.${TAIL}`);
  });
});

describe('Compare', () => {
  const money = (n: number) => `$${n}`;
  const main: FirePlanV2 = { ...DEFAULT_PLAN_V2, accounts: [{ account_id: 'brk', growth: 0.07, yield: null }] };
  test('says the stress test differs where one plan moves its history', () => {
    expect(copyDiffParts(main, { ...main, historyMoved: true }, money)).toEqual(['Stress test differs']);
    expect(copyDiffParts({ ...main, historyMoved: true }, main, money)).toEqual(['Stress test differs']);
    expect(copyDiffParts({ ...main, historyMoved: true }, { ...main, historyMoved: true }, money)).toEqual([]);
  });

  test('and nothing where neither can: no account at its own rate, or invested assets typed', () => {
    const none = { ...main, accounts: [{ account_id: 'brk', growth: null, yield: 0.02 }] };
    expect(copyDiffParts(none, { ...none, historyMoved: true }, money)).toEqual([]);
    const typed = { ...main, assets: 500_000 };
    expect(copyDiffParts(typed, { ...typed, historyMoved: true }, money)).toEqual([]);
  });
});
