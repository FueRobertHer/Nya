// lib/api-versioned.ts
//
// The `version` the API's reads give what a write can change
// (lib/api-versions.ts), worked out from what is stored: a manual account's
// details, a manual row typed by the person or a program, with what is said
// beside it. Read LENIENTLY, for the answer alone: a version that can't be
// worked out is null, and nothing writes on it, since every write reads what
// it changes strictly and checks the version again inside the compare-and-set
// that writes it (lib/api-writes.ts).

import type { Ctx } from './containers';
import { getManualAccountsReport } from './manual';
import { manualTxnStore, isManualTxnId } from './manual-txns';
import { txnAnnotationStore } from './txn-annotations';
import { accountVersion, txnVersion } from './api-versions';

/** Each manual account's version, by id; empty when they can't be read. */
export async function accountVersions(ctx: Ctx): Promise<Map<string, string>> {
  try {
    const { accounts } = await getManualAccountsReport(ctx);
    return new Map(accounts.map((a) => [a.account_id, accountVersion(a)]));
  } catch {
    return new Map();
  }
}

/** Gives each account of a list its version: a manual one's, else null. */
export async function withAccountVersions<T extends { id: string; source: string }>(ctx: Ctx, accounts: readonly T[]): Promise<(T & { version: string | null })[]> {
  const versions = accounts.some((a) => a.source === 'manual') ? await accountVersions(ctx) : new Map<string, string>();
  return accounts.map((a) => ({ ...a, version: a.source === 'manual' ? (versions.get(a.id) ?? null) : null }));
}

/** Gives each transaction of a list its version: a manual row typed by the
 *  person or a program (source manual) gets one, any other null. One read of
 *  the books of the accounts those rows are on, one of what is said about
 *  them. */
export async function withTxnVersions<T extends { id: string; account_id: string; source: string }>(ctx: Ctx, txns: readonly T[]): Promise<(T & { version: string | null })[]> {
  const mine = txns.filter((t) => t.source === 'manual' && isManualTxnId(t.id));
  const versions = new Map<string, string>();
  if (mine.length > 0) {
    try {
      const [books, said] = await Promise.all([manualTxnStore.getMany(ctx, new Set(mine.map((t) => t.account_id))), txnAnnotationStore.getMany(ctx, mine.map((t) => t.id))]);
      for (const book of books.values()) {
        for (const row of book.rows) if (row.source === 'manual') versions.set(row.id, txnVersion(row, said.get(row.id) ?? null));
      }
    } catch {
      // Unreadable now: no version, and a write reads it again, strictly.
    }
  }
  return txns.map((t) => ({ ...t, version: versions.get(t.id) ?? null }));
}
