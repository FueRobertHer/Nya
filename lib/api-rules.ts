// lib/api-rules.ts
//
// The read-only API's rules (#36): what /api/v1/rules and the MCP server's
// list_rules answer. Each rule as stored (its conditions and actions, by id),
// in the order they run, with a sentence saying it in words, what keeps it
// from working, if anything, and how many transactions it matches in the
// window the API reads, counted from the Activity tab's own assembly
// (lib/api-read.ts readActivity), so the count is of the rows a rule applies
// to there. Read only: rules are made and changed in the app.

import type { Ctx } from './containers';
import { firstDay, readActivity, withoutTransactionsNotes, type ApiSource } from './api-read';
import { readRuleSet, ruleProblem, ruleSentence, sortedRules, withCurrentCategories, type RuleActions, type RuleCondition } from './rules';

export type ApiRule = {
  id: string;
  enabled: boolean;
  /** 1 runs first: when two rules set a transaction's category or name, the
   *  one that runs first decides it. */
  priority: number;
  conditions: RuleCondition[];
  actions: RuleActions;
  /** The rule in words, with the names of what it names. */
  sentence: string;
  /** What keeps it from working (a category it names was deleted), or null. */
  problem: string | null;
  /** Transactions it matches, in the window the API reads. */
  transactions: number;
  created_at: string;
  updated_at: string;
};

export async function readRules(ctx: Ctx, opts: { includeHidden?: boolean } = {}): Promise<{ from: string; rules: ApiRule[]; sources: ApiSource[]; notes: string[] }> {
  // Strict: rules that can't be read are an error (409), never "no rules".
  const [set, activity] = await Promise.all([readRuleSet(ctx), readActivity(ctx, !!opts.includeHidden)]);
  const counts = new Map<string, number>();
  for (const t of activity.rows) for (const id of t.rule_ids ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  const names = { ix: activity.ix, tags: activity.tags };
  return {
    from: firstDay(),
    // Each category a rule names as it is known now: one merged away is
    // answered as the one it went into, which categories lists.
    rules: sortedRules(set).map((stored) => withCurrentCategories(stored, activity.ix)).map((r) => ({
      id: r.id,
      enabled: r.enabled,
      priority: r.priority,
      conditions: r.conditions,
      actions: r.actions,
      sentence: ruleSentence(r, names),
      problem: ruleProblem(r, activity.ix),
      transactions: counts.get(r.id) ?? 0,
      created_at: r.created_at,
      updated_at: r.updated_at,
    })),
    sources: activity.sources,
    notes: [...activity.notes, ...withoutTransactionsNotes(activity.view, activity.rows.length, 'list')],
  };
}
