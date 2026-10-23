// lib/goal-export.ts
//
// The goals as the download of my data gives them (lib/user-export.ts, the
// `goals` part; docs/data-export.md): each goal's four stored fields, as every
// version of the file has had them, then what this release adds, from its
// plan (lib/goal-plans.ts) as the app applies it: an allocation set on an
// account the goal no longer tracks is left out, as the app leaves it out.
// The plans as stored are a part of their own (`goal-plans`), which names
// any it can't read; a goal whose plan is one of those has the added fields
// null here, never taken for a plan with nothing set. Read only.

import type { Ctx } from './containers';
import type { Goal as StoredGoal } from './goals';
import { coreOf, goalLinks, goalPlansStore, recordOf } from './goal-plans';

export type ExportedGoal = {
  id: unknown;
  name: unknown;
  target: unknown;
  account_id: string | null;
  allocation: number | null;
  monthly_target: number | null;
  target_date: string | null;
  /** Null when its plan couldn't be read. */
  archived: boolean | null;
  archived_on: string | null;
  archived_amount: number | null;
  plan_start: { date: string; amount: number | null } | null;
};

/** The goals, as the file gives them. A plan entry that can't be read never
 *  stops it: `goal-plans` names it. Storage out of reach throws. */
export async function exportedGoals(ctx: Ctx, goals: StoredGoal[]): Promise<ExportedGoal[]> {
  const [report, links] = await Promise.all([goalPlansStore.getAllReport(ctx), goalLinks(ctx, { readOnly: true })]);
  const unknown = new Set([...report.unreadable, ...report.unrecognised]);
  return goals.map((g) => {
    const core = coreOf(g);
    const four = { id: g.id, name: g.name, target: g.target, account_id: g.account_id ?? null };
    if (unknown.has(core.id)) {
      return { ...four, allocation: null, monthly_target: null, target_date: null, archived: null, archived_on: null, archived_amount: null, plan_start: null };
    }
    const { plan } = recordOf(core, report.entries.get(core.id), links);
    return {
      ...four,
      allocation: plan.allocation?.amount ?? null,
      monthly_target: plan.monthly_target ?? null,
      target_date: plan.target_date ?? null,
      archived: !!plan.archived,
      archived_on: plan.archived?.on ?? null,
      archived_amount: plan.archived?.amount ?? null,
      plan_start: plan.plan_start ? { date: plan.plan_start.date, amount: plan.plan_start.amount } : null,
    };
  });
}
