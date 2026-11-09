// components/plan-lasting.ts
//
// D9 on the page: a plan with `lastsIn` answers with the earliest stop that lasts
// (lib/fire/earliest.ts), found in the simulator's worker by the page's one store
// (components/plan-search.ts planLasting), for every caller alike: the Plan's answer,
// a copy's row, a sheet's preview and Home's line. As components/plan-detailed.ts
// does for a search:
//
//   1. Nothing to search with (no age, the figures refused, or an input the answer
//      needs isn't there): null, and the caller's figures stand, saying what's needed.
//   2. Otherwise the job, and meanwhile the last answer for these same items, or
//      today's figures, dimmed (`working`). Ages go by position, so an answer found
//      for other items is never used.
//   3. Answered: the figures with FI at the age found (planFigures `resolved`).
//
// Loads planFigures and, for a detailed plan, its drawdown, so Home imports it only
// for a plan with `lastsIn`.

import type { Count } from '@/lib/fire/compile';
import type { EarliestAnswer } from '@/lib/fire/earliest';
import type { EarliestJob, PlanJobResult } from '@/lib/fire/jobs';
import type { Measured } from '@/lib/fire/plan';
import { detailWork, type DetailWork, type DetailedInput } from '@/lib/fire/plan-detail';
import { planFigures, type FiguresRefused, type PlanFigures } from '@/lib/fire/plan-figures';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import type { Resolution } from '@/lib/fire/steady';
import type { DetailedAnswer } from './plan-detailed';
import type { PlanSearch } from './plan-search';
import { asksLasting } from './plan-text';

/** What the answer's how line says: the age found (null: none by PLAN_TO_AGE),
 *  the share asked for and the age the run that lasts runs to. */
export type LastingFound = Pick<EarliestAnswer, 'age' | 'to'> & { share: number };

export type LastingAnswer = DetailedAnswer & { lasting: LastingFound | null };

const MAX_REMEMBERED = 32;

/** The flow, for one page, keeping each plan's figures by what they rest on. */
export function createLastingFigures(store: Pick<PlanSearch<EarliestJob, PlanJobResult>, 'answer' | 'drop'>) {
  const works = new Map<string, DetailWork>();
  const figures = new Map<string, PlanFigures | FiguresRefused>();
  const last = new Map<string, { items: string; resolution: Resolution; found: LastingFound }>();

  /** `input`: what a detailed plan's drawdown runs on, null in the flat model;
   *  `flat`: the plan's figures as they are without it. */
  return (slot: string, plan: FirePlanV2, measured: Measured, count: Count, input: DetailedInput | null, flat: PlanFigures | FiguresRefused): LastingAnswer | null => {
    if (!asksLasting(plan, flat) || 'refused' in flat) {
      store.drop(slot);
      return null;
    }
    const share = plan.lastsIn as number;
    const inputKey = input ? JSON.stringify({ ...input, law: undefined }) : null;
    let work: DetailWork | null = null;
    if (input && inputKey) {
      work = works.get(inputKey) ?? null;
      if (!work) {
        if (works.size >= MAX_REMEMBERED) works.clear();
        work = detailWork(input);
        works.set(inputKey, work);
      }
    }
    const worked = (resolved: Resolution) => {
      const key = JSON.stringify([plan, measured, count, resolved, inputKey]);
      const kept = figures.get(key);
      if (kept) return kept;
      const made = planFigures(plan, measured, { count, detailed: work, resolved });
      if (figures.size >= MAX_REMEMBERED) figures.clear();
      figures.set(key, made);
      return made;
    };
    const items = plan.items.map((x) => x.id).join(',');
    const result = store.answer(slot, { kind: 'earliest', method: plan.method, plan, measured, count, detailed: input });
    if (result === null) {
      const held = last.get(slot);
      if (held && held.items === items) return { figures: worked(held.resolution), working: true, failed: false, lasting: held.found };
      return { figures: work ? worked(flat.resolution) : flat, working: true, failed: false, lasting: null };
    }
    if (!result.ok || result.kind !== 'earliest') return { figures: work ? worked(flat.resolution) : flat, working: false, failed: true, lasting: null };
    const answer = result.answer;
    if ('refused' in answer) return { figures: answer, working: false, failed: false, lasting: null };
    const found: LastingFound = { age: answer.age, to: answer.to, share };
    last.set(slot, { items, resolution: answer.resolution, found });
    return { figures: worked(answer.resolution), working: false, failed: false, lasting: found };
  };
}
