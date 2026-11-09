// components/plan-lasting.ts createLastingFigures, over a store this test answers: what
// a plan with `lastsIn` shows while its job is out, once answered, after an edit, and
// when the job fails or the figures are refused.

import { describe, expect, test } from 'bun:test';
import { createLastingFigures } from '@/components/plan-lasting';
import { earliestStop, type EarliestAnswer } from '@/lib/fire/earliest';
import type { EarliestJob, PlanJobResult } from '@/lib/fire/jobs';
import { DEFAULT_PLAN, type Measured } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planOf, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { usMarket } from '@/lib/fire/us-market';
import { ON } from './plan-gen';

const M: Measured = { spending: null, savings: null, assets: null };
const PLAN: FirePlanV2 = { ...planOf({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, savings: 30_000, assets: 300_000 }), lastsIn: 0.9 };
const flatOf = (plan: FirePlanV2) => planFigures(plan, M, { count: ON });
const solved = earliestStop({ plan: PLAN, measured: M, count: ON, detailed: null, method: PLAN.method }, usMarket()) as EarliestAnswer;

/** A store whose answer the test sets, and the slots it was told to let go. */
function fakeStore() {
  let result: PlanJobResult | { ok: false; error: string } | null = null;
  const dropped: string[] = [];
  const jobs: EarliestJob[] = [];
  return {
    set: (r: typeof result) => void (result = r),
    dropped,
    jobs,
    answer: (_slot: string, job: EarliestJob) => {
      jobs.push(job);
      return result;
    },
    drop: (slot: string) => void dropped.push(slot),
  };
}

describe('createLastingFigures', () => {
  test('a plan without lastsIn asks for nothing and lets its slot go', () => {
    const store = fakeStore();
    const figures = createLastingFigures(store);
    const { lastsIn: _, ...plain } = PLAN;
    expect(figures('plan', plain, M, ON, null, flatOf(plain))).toBeNull();
    expect([store.dropped, store.jobs.length]).toEqual([['plan'], 0]);
  });

  test('working, then answered, then an edit dims the last answer, and other items never take it', () => {
    expect(solved.age).toBe(52);
    const store = fakeStore();
    const figures = createLastingFigures(store);
    const flat = flatOf(PLAN);
    const first = figures('plan', PLAN, M, ON, null, flat)!;
    expect([first.working, first.failed, first.lasting, first.figures]).toEqual([true, false, null, flat]);
    expect(store.jobs[0]).toMatchObject({ kind: 'earliest', method: 'historical', plan: PLAN, detailed: null });

    store.set({ ok: true, kind: 'earliest', answer: solved });
    const done = figures('plan', PLAN, M, ON, null, flat)!;
    expect([done.working, done.failed, done.lasting]).toEqual([false, false, { age: 52, to: solved.to, share: 0.9 }]);
    expect((done.figures as PlanFigures).resolution.searched).toBe('lasts');
    expect((done.figures as PlanFigures).view.fiAge).toBe(52);

    // Spending edited: the job is out again, and the answer found for these items is held, dimmed.
    store.set(null);
    const edited = { ...PLAN, spending: 41_000 };
    const held = figures('plan', edited, M, ON, null, flatOf(edited))!;
    expect([held.working, held.lasting?.age, (held.figures as PlanFigures).resolution.searched]).toEqual([true, 52, 'lasts']);

    // An item added: ages go by position, so the held answer isn't used.
    const trip = { id: 'trip', label: 'A trip', kind: 'one-off', from: { anchor: { at: 'age', age: 60 }, offset: 0 }, until: null, once: 10_000, yearly: null, replaces: null, every: null, times: null, inflationAdjusted: true, owner: 'you', beforeTax: false } as unknown as FirePlanV2['items'][number];
    const more = { ...PLAN, items: [trip] };
    const moreFlat = flatOf(more);
    const other = figures('plan', more, M, ON, null, moreFlat)!;
    expect([other.working, other.lasting, other.figures]).toEqual([true, null, moreFlat]);
  });

  test('a failed job says so over today’s figures; a refused answer is the refusal', () => {
    const store = fakeStore();
    const figures = createLastingFigures(store);
    const flat = flatOf(PLAN);
    store.set({ ok: false, error: 'the worker stopped' });
    const failed = figures('plan', PLAN, M, ON, null, flat)!;
    expect([failed.working, failed.failed, failed.lasting, failed.figures]).toEqual([false, true, null, flat]);
    const refusal = { refused: 'spending' } as never;
    store.set({ ok: true, kind: 'earliest', answer: refusal });
    const refused = figures('plan', PLAN, M, ON, null, flat)!;
    expect([refused.working, refused.failed, refused.lasting, refused.figures]).toEqual([false, false, null, refusal]);
  });
});
