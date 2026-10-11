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
import { MANUAL_TXN_PREFIX } from './manual-txn-input';
import { forgetSplits, splitStore } from './splits';
import { forgetGroupMembers, groupStore } from './groups';

/** Forgets the splits of these transactions, and takes them out of their
 *  groups (a group left with none goes). */
export async function forgetSplitsAndGroups(ctx: Ctx, transaction_ids: readonly string[]): Promise<void> {
  if (transaction_ids.length === 0) return;
  await forgetSplits(ctx, transaction_ids);
  await forgetGroupMembers(ctx, transaction_ids);
}

/**
 * The same for bank transactions no stored Item holds any more (an Item
 * disconnected, rows the bank removed), by the rules of lib/txn-annotations.ts
 * pruneOrphanAnnotations: `readKnown` reads every transaction id the stored
 * Items hold, or null when a store couldn't be read or is behind, and then
 * nothing goes; a manual row's split and group places go with the row, never
 * here; `among` keeps it to those transactions (the ones a sync just saw the
 * bank remove). The records first, the splits' and the groups', and the
 * stores after, once, so a split or a group set meanwhile on a newly stored
 * row is checked against a read that has the row. A split record that can't
 * be read goes with its transaction too; a group that can't be read is passed
 * over, since what it holds can't be seen. Each forgotten on its own, so one
 * failing leaves the other done (and throws after).
 */
export async function pruneSplitsAndGroups(ctx: Ctx, readKnown: () => Promise<Set<string> | null>, opts: { among?: ReadonlySet<string> } = {}): Promise<void> {
  const bank = (id: string) => !id.startsWith(MANUAL_TXN_PREFIX) && (!opts.among || opts.among.has(id));
  const splits = await splitStore.getAllReport(ctx);
  const groups = await groupStore.getAllReport(ctx);
  const splitIds = [...splits.entries.keys(), ...splits.unreadable].filter(bank);
  const memberIds = [...new Set([...groups.entries.values()].flatMap((g) => g.members))].filter(bank);
  if (splitIds.length === 0 && memberIds.length === 0) return;
  const known = await readKnown();
  if (!known) return;
  let failed: unknown = null;
  const orphanSplits = splitIds.filter((id) => !known.has(id));
  if (orphanSplits.length > 0) await forgetSplits(ctx, orphanSplits).catch((err) => (failed = err));
  const orphanMembers = memberIds.filter((id) => !known.has(id));
  if (orphanMembers.length > 0) await forgetGroupMembers(ctx, orphanMembers).catch((err) => (failed ??= err));
  if (failed) throw failed;
}
