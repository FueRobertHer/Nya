// lib/manual-account-delete.ts
//
// Deleting a manual account and everything kept about its transactions: what
// app/api/manual-accounts DELETE does, and what undoing an import from
// another app does for an account that import made (lib/migration/commit.ts),
// in one place so the two never differ.
//
// THE ORDER MATTERS. Its imports' records and settings first, while its rows
// can still say which imports were its (lib/import/commit.ts); then its rows,
// with what was said about them, their splits and places in groups; then the
// account. If it stops part way, the account is still there to delete again,
// rather than gone with its rows left behind where nothing shows them. Then
// its book once more: an add or a move that read the account before it went
// can have written its book again meanwhile (whatever writes after this finds
// the account gone and takes its row back out: app/api/manual-transactions).
// Its balance history is left in place, as it always has been: history is
// keyed by date, and rewriting past dates is something Nya never does.

import type { Ctx } from './containers';
import { removeManualAccount } from './manual';
import { removeAccountTxns } from './manual-txns';
import { forgetAccountImports } from './import/commit';
import { forgetAnnotations } from './txn-annotations';
import { forgetSplitsAndGroups } from './split-gone';
import { pruneHidden } from './hidden';
import { loggable } from './log-safe';

/** Deletes the account and its transactions (see the header). The caller
 *  clears the caches and the backfill flag. */
export async function deleteManualAccount(ctx: Ctx, account_id: string): Promise<void> {
  await forgetAccountImports(ctx, account_id);
  const rows = await removeAccountTxns(ctx, account_id);
  await forgetAnnotations(ctx, rows).catch((err) => console.warn('manual-accounts: exclusions were left behind', loggable(err)));
  await forgetSplitsAndGroups(ctx, rows).catch((err) => console.warn('manual-accounts: splits or groups were left behind', loggable(err)));
  await removeManualAccount(ctx, account_id);
  const late = await removeAccountTxns(ctx, account_id);
  if (late.length > 0) await forgetAnnotations(ctx, late).catch((err) => console.warn('manual-accounts: exclusions were left behind', loggable(err)));
  if (late.length > 0) await forgetSplitsAndGroups(ctx, late).catch((err) => console.warn('manual-accounts: splits or groups were left behind', loggable(err)));
  // The account is gone, so a hidden entry naming it would linger forever.
  await pruneHidden(ctx, [account_id]);
}
