// lib/history.ts
//
// Net-worth history for the over-time chart, in two layers:
//
// 1. REAL snapshots (`history:net-worth`) -- recorded whenever a clean live
//    fetch happens (each upserts today's point) and daily by the snapshot
//    cron, so history accumulates going forward.
// 2. ESTIMATED backfill (`history:net-worth:est`) -- reconstructed once from
//    transaction history (see /api/backfill): cash and credit accounts are
//    walked backward from their current balances, everything else is held
//    flat. Real points always win over estimated ones for the same date.
//
// Both layers are Redis hashes keyed by UTC date (YYYY-MM-DD), values
// encrypted with the same AES-256-GCM key as everything else financial, so
// a database-only leak doesn't expose your net-worth series either.

import { redis, k } from './storage';
import { encrypt, decrypt } from './crypto';

const HISTORY_HASH = k('history:net-worth');
const ESTIMATED_HASH = k('history:net-worth:est');
// Per-account balances, one JSON map { account_id: balance } per date, so
// individual accounts can be charted too.
const ACCOUNTS_HASH = k('history:accounts');
const ACCOUNTS_EST_HASH = k('history:accounts:est');
const BACKFILL_FLAG = k('history:backfill-done');

export type HistoryPoint = { date: string; value: number; estimated?: boolean };

/** Returns whether the snapshot actually landed. Callers that report success
 *  to a caller of their own (e.g. /api/ingest/balance telling a script the
 *  chart was updated) need to know; the rest can ignore it. */
export async function recordSnapshot(
  netWorth: number,
  accountBalances?: Record<string, number>
): Promise<boolean> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await redis().hset(HISTORY_HASH, { [today]: await encrypt(String(netWorth)) });
    if (accountBalances && Object.keys(accountBalances).length > 0) {
      await redis().hset(ACCOUNTS_HASH, { [today]: await encrypt(JSON.stringify(accountBalances)) });
    }
    return true;
  } catch {
    // Best-effort: a missed snapshot just leaves a gap in the chart.
    return false;
  }
}

/** Wholesale-replace the estimated layer (backfill recomputes it entirely). */
export async function replaceEstimated(points: { date: string; value: number }[]): Promise<void> {
  await redis().del(ESTIMATED_HASH);
  if (points.length === 0) return;
  const fields: Record<string, string> = {};
  for (const p of points) fields[p.date] = await encrypt(String(p.value));
  await redis().hset(ESTIMATED_HASH, fields);
}

/** Same, for the per-account estimated layer. */
export async function replaceEstimatedAccounts(
  points: { date: string; balances: Record<string, number> }[]
): Promise<void> {
  await redis().del(ACCOUNTS_EST_HASH);
  if (points.length === 0) return;
  const fields: Record<string, string> = {};
  for (const p of points) fields[p.date] = await encrypt(JSON.stringify(p.balances));
  await redis().hset(ACCOUNTS_EST_HASH, fields);
}

export async function getRealSnapshotDates(): Promise<Set<string>> {
  try {
    return new Set(await redis().hkeys(HISTORY_HASH));
  } catch {
    return new Set();
  }
}

/** Balance history for one account, merged like getHistory (real wins). */
export async function getAccountHistory(account_id: string): Promise<HistoryPoint[]> {
  const [realMap, estMap] = await Promise.all([
    redis().hgetall<Record<string, string>>(ACCOUNTS_HASH),
    redis().hgetall<Record<string, string>>(ACCOUNTS_EST_HASH),
  ]);

  const entries: { date: string; blob: string; estimated: boolean }[] = [];
  for (const [date, blob] of Object.entries(realMap ?? {})) {
    entries.push({ date, blob, estimated: false });
  }
  for (const [date, blob] of Object.entries(estMap ?? {})) {
    if (!realMap?.[date]) entries.push({ date, blob, estimated: true });
  }

  const points = await Promise.all(
    entries.map(async ({ date, blob, estimated }): Promise<HistoryPoint | null> => {
      try {
        const balances = JSON.parse(await decrypt(blob)) as Record<string, number>;
        const value = balances[account_id];
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        return { date, value, ...(estimated ? { estimated: true } : {}) };
      } catch {
        return null;
      }
    })
  );
  return points
    .filter((p): p is HistoryPoint => p !== null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// The backfill flag makes /api/backfill idempotent; linking a new
// institution clears it so history gets recomputed with the new accounts.
export async function isBackfillDone(): Promise<boolean> {
  try {
    return !!(await redis().get(BACKFILL_FLAG));
  } catch {
    return false;
  }
}

export async function markBackfillDone(): Promise<void> {
  await redis().set(BACKFILL_FLAG, '1');
}

export async function clearBackfillDone(): Promise<void> {
  try {
    await redis().del(BACKFILL_FLAG);
  } catch {
    // Worst case the next backfill is skipped; harmless.
  }
}

export async function getHistory(): Promise<HistoryPoint[]> {
  const [realMap, estMap] = await Promise.all([
    redis().hgetall<Record<string, string>>(HISTORY_HASH),
    redis().hgetall<Record<string, string>>(ESTIMATED_HASH),
  ]);

  const entries: { date: string; blob: string; estimated: boolean }[] = [];
  for (const [date, blob] of Object.entries(realMap ?? {})) {
    entries.push({ date, blob, estimated: false });
  }
  for (const [date, blob] of Object.entries(estMap ?? {})) {
    if (!realMap?.[date]) entries.push({ date, blob, estimated: true });
  }

  const points = await Promise.all(
    entries.map(async ({ date, blob, estimated }): Promise<HistoryPoint | null> => {
      try {
        const value = Number(await decrypt(blob));
        return Number.isFinite(value) ? { date, value, ...(estimated ? { estimated: true } : {}) } : null;
      } catch {
        return null; // undecryptable point (rotated key) -- drop it
      }
    })
  );
  return points
    .filter((p): p is HistoryPoint => p !== null)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}
