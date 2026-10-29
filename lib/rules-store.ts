// lib/rules-store.ts
//
// The stored rules: the `rules` store on the storage seam (lib/repo.ts) and
// its reads and edits. Apart from lib/rules.ts, which says what a rule is and
// is safe in the browser, so a client component importing it never pulls the
// storage seam into its bundle.

import { defineValueStore } from './repo';
import type { Ctx } from './containers';
import { emptyRuleSet, isRuleSet, withoutTags, type RuleSet } from './rules';

export const rulesStore = defineValueStore<RuleSet>('rules', {
  what: 'rules',
  isValid: isRuleSet,
  exportable: true, // the person's own rules
});

/** Strict: the stored rules, or null when none were ever saved. */
export function readRuleSet(ctx: Ctx): Promise<RuleSet | null> {
  return rulesStore.get(ctx);
}

/**
 * The rules for showing transactions (lib/activity.ts): the stored ones, or
 * none, with a note when they can't be read (damaged, or saved by a version
 * this one doesn't know): no rule is applied then, so a transaction a rule
 * hid counts again until they can be, and nothing writes on this answer.
 * Storage that can't be reached throws, as every read does.
 */
export async function rulesForDisplay(ctx: Ctx): Promise<{ set: RuleSet | null; note: string | null }> {
  const report = await rulesStore.getReport(ctx);
  if (report.unreadable || report.unrecognised) {
    console.error(`Stored rules ${report.unreadable ? 'unreadable' : 'unrecognised'}`);
    return { set: null, note: "Your rules couldn't be read, so none are applied until they can be: transactions show as the bank and you have them." };
  }
  return { set: report.value, note: null };
}

/** Changes the rules with `op` (from none when none were saved), in one
 *  compare-and-set: `op` may run more than once and throws RuleError to
 *  refuse. Rules that can't be read are refused (StoredDataUnreadableError),
 *  never replaced. */
export async function changeRules(ctx: Ctx, op: (set: RuleSet) => RuleSet): Promise<RuleSet> {
  return (await rulesStore.update(ctx, (cur) => op(cur ?? emptyRuleSet())))!;
}

/** Takes deleted tags' ids out of every rule (lib/tag-delete.ts). Returns how
 *  many rules changed, or null when the rules can't be read: they are left
 *  as they are (no rule is applied while they can't be, and nothing shows a
 *  deleted tag), and the deletion stays noted, to be swept once they can. */
export async function sweepRuleTags(ctx: Ctx, ids: readonly string[]): Promise<number | null> {
  const report = await rulesStore.getReport(ctx);
  if (report.unreadable || report.unrecognised) return null;
  if (!report.value) return 0;
  const before = report.value.rules.filter((r) => r.actions.add_tags?.some((t) => ids.includes(t))).length;
  if (before === 0) return 0;
  await rulesStore.update(ctx, (cur) => (cur ? withoutTags(cur, ids) : cur));
  return before;
}
