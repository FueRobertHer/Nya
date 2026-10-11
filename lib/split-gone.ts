// lib/split-gone.ts
//
// When transactions go, their splits go with them and they leave their
// groups (lib/splits.ts, lib/groups.ts), as what was said about them goes
// (lib/txn-annotations.ts), and at the same moments: a manual row deleted, a
// manual account deleted, an import undone, a SimpleFIN account let go and
// removed (forgetSplitsAndGroups); a sync that saved the bank's removal of a
// transaction, a disconnect, an earlier account forgotten (pruneSplitsAndGroups,
// by the rules every such prune keeps: nothing while a store of transactions
// can't be read or is behind, never a record this release doesn't
// recognise). One line at each place a transaction goes.

import type { Ctx } from './containers';
import { forgetSplits, pruneOrphanSplits } from './splits';
import { forgetGroupMembers, pruneOrphanGroupMembers } from './groups';

/** Forgets the splits of these transactions, and takes them out of their
 *  groups (a group left with none goes). */
export async function forgetSplitsAndGroups(ctx: Ctx, transaction_ids: readonly string[]): Promise<void> {
  if (transaction_ids.length === 0) return;
  await forgetSplits(ctx, transaction_ids);
  await forgetGroupMembers(ctx, transaction_ids);
}

/** The same for bank transactions no stored Item holds any more: `readKnown`
 *  reads every id they hold, or null to change nothing (see
 *  lib/txn-annotations.ts pruneOrphanAnnotations); `among` keeps it to
 *  those. Each part on its own, so one failing leaves the other done. */
export async function pruneSplitsAndGroups(ctx: Ctx, readKnown: () => Promise<Set<string> | null>, opts: { among?: ReadonlySet<string> } = {}): Promise<void> {
  // One read of the stores for both, and only if either holds a bank row.
  let known: Promise<Set<string> | null> | null = null;
  const once = () => (known ??= readKnown());
  await pruneOrphanSplits(ctx, once, opts);
  await pruneOrphanGroupMembers(ctx, once, opts);
}
