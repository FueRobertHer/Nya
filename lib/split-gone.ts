// lib/split-gone.ts
//
// When transactions go, their splits go with them and they leave their
// groups (lib/splits.ts, lib/groups.ts), and their approvals go
// (lib/review-store.ts), as what was said about them goes
// (lib/txn-annotations.ts), and at the same moments: a manual row deleted, a
// manual account deleted, an import undone (into a manual account, or into a
// linked one: lib/history-import/commit.ts), the rows imported into an
// earlier account forgotten with it, a SimpleFIN account let go and removed
// (forgetSplitsAndGroups); a sync that saved the bank's removal of a
// transaction, a disconnect, an earlier account forgotten (pruneSplitsAndGroups,
// by the rules every such prune keeps: nothing while a store of transactions
// can't be read or is behind, never a record this release doesn't
// recognise). One line at each place a transaction goes.

import type { Ctx } from './containers';
import { MANUAL_TXN_PREFIX } from './manual-txn-input';
import { IMPORTED_TXN_PREFIX } from './history-import/view';
import { forgetSplits, splitStore } from './splits';
import { forgetGroupMembers, groupStore } from './groups';
import { approvalsToPrune, forgetApprovals } from './review-store';

/** Forgets the splits of these transactions, takes them out of their groups
 *  (a group left with none goes), and forgets their approvals. Each on its
 *  own, so one failing leaves the others done (and throws after). */
export async function forgetSplitsAndGroups(ctx: Ctx, transaction_ids: readonly string[]): Promise<void> {
  if (transaction_ids.length === 0) return;
  let failed: unknown = null;
  await forgetSplits(ctx, transaction_ids).catch((err) => (failed = err));
  await forgetGroupMembers(ctx, transaction_ids).catch((err) => (failed ??= err));
  await forgetApprovals(ctx, transaction_ids).catch((err) => (failed ??= err));
  if (failed) throw failed;
}

/**
 * The same for bank transactions no stored Item holds any more (an Item
 * disconnected, rows the bank removed), by the rules of lib/txn-annotations.ts
 * pruneOrphanAnnotations: `readKnown` reads every transaction id the stored
 * Items hold, or null when a store couldn't be read or is behind, and then
 * nothing goes; a manual row's split, group places and approval go with the
 * row, never here, and so do a row's imported into a linked account from a
 * file, which no Item holds and which is kept past a disconnect; `among`
 * keeps it to those transactions (the ones a sync just saw the bank remove).
 * The records first, the splits', the groups' and the approvals', and the
 * stores after, once, so a split, a group or an approval set meanwhile on a
 * newly stored row is checked against a read that has the row. A split or an
 * approval that can't be read goes with its transaction too; a group that
 * can't be read is passed over, since what it holds can't be seen. Each
 * forgotten on its own, so one failing leaves the others done (and throws
 * after).
 */
export async function pruneSplitsAndGroups(ctx: Ctx, readKnown: () => Promise<Set<string> | null>, opts: { among?: ReadonlySet<string> } = {}): Promise<void> {
  const bank = (id: string) => !id.startsWith(MANUAL_TXN_PREFIX) && !id.startsWith(IMPORTED_TXN_PREFIX) && (!opts.among || opts.among.has(id));
  const splits = await splitStore.getAllReport(ctx);
  const groups = await groupStore.getAllReport(ctx);
  const splitIds = [...splits.entries.keys(), ...splits.unreadable].filter(bank);
  const memberIds = [...new Set([...groups.entries.values()].flatMap((g) => g.members))].filter(bank);
  // Only the removed ones' approvals, by id, when a sync says which.
  const approvalIds = (await approvalsToPrune(ctx, opts.among)).filter(bank);
  if (splitIds.length === 0 && memberIds.length === 0 && approvalIds.length === 0) return;
  const known = await readKnown();
  if (!known) return;
  let failed: unknown = null;
  const orphanSplits = splitIds.filter((id) => !known.has(id));
  if (orphanSplits.length > 0) await forgetSplits(ctx, orphanSplits).catch((err) => (failed = err));
  const orphanMembers = memberIds.filter((id) => !known.has(id));
  if (orphanMembers.length > 0) await forgetGroupMembers(ctx, orphanMembers).catch((err) => (failed ??= err));
  const orphanApprovals = approvalIds.filter((id) => !known.has(id));
  if (orphanApprovals.length > 0) await forgetApprovals(ctx, orphanApprovals).catch((err) => (failed ??= err));
  if (failed) throw failed;
}
