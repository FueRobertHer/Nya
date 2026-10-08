// lib/connection-health.ts
//
// The server side of connection health (#51): Plaid's early warnings, when
// each connection last answered cleanly, and each connection's health
// (lib/connection-state.ts) attached to what the dashboard is sent. The daily
// job's emails are lib/connection-notices.ts; the stores are
// lib/connection-records.ts.
//
// Nothing here reads or writes a balance or the history layer. What it records
// is dates and Plaid's own words about a connection, and what it reports comes
// from the live fetch's verdict, never from recovered balances
// (lib/last-known.ts), which stay display-only.
//
// WARNINGS. A verified ITEM webhook saying PENDING_EXPIRATION or
// PENDING_DISCONNECT is recorded for its connection (Plaid sends it about a
// week ahead). It is removed when the connection is repaired: Plaid's
// LOGIN_REPAIRED, or a successful update-mode reconnect here
// (app/api/item-reconnected). A new link through /api/exchange-public-token
// is always a new Item with an id of its own, so it has no record to clear.
// A disconnect removes everything kept about the connection
// (lib/disconnect-item.ts). And a warning that a repair outran (one Plaid
// retried after the reconnect, say) lapses by itself once the connection
// answers past the end it announced (warningLapsed).

import type { Ctx } from './containers';
import type { InstitutionResult } from './networth';
import { StoredDataUnreadableError } from './repo';
import { warningsStore, syncsStore, noticesStore, type LastSync } from './connection-records';
import { healthOf, mergeWarning, warningFromWebhook, type ConnectionWarning } from './connection-state';

const nameOf = (err: unknown) => (err instanceof Error ? err.name : typeof err);

/**
 * Records the warning a verified ITEM webhook carries, if it carries one, and
 * returns whether it did. A repeated delivery merges into the warning already
 * there (mergeWarning), through update: the webhook can arrive while anything
 * else touches the entry. A stored warning that can't be read is replaced by
 * this one: it could only have been an older warning about the same
 * connection, and the fresh one, from Plaid, says more.
 */
export async function recordWarning(
  ctx: Ctx,
  item_id: string,
  body: { webhook_code?: unknown; consent_expiration_time?: unknown; reason?: unknown },
  now: number = Date.now()
): Promise<boolean> {
  const incoming = warningFromWebhook(body, now);
  if (!incoming) return false;
  try {
    await warningsStore.update(ctx, item_id, (current) => mergeWarning(current, incoming));
  } catch (err) {
    if (!(err instanceof StoredDataUnreadableError)) throw err;
    console.error('Connection health: a stored warning could not be read; replacing it with the new one.', nameOf(err));
    await warningsStore.set(ctx, item_id, incoming);
  }
  return true;
}

/** Forgets a repaired connection's warning and its email bookkeeping, so a
 *  later break is a new one, with its own notice. */
export async function clearRepaired(ctx: Ctx, item_id: string): Promise<void> {
  await Promise.all([warningsStore.remove(ctx, item_id), noticesStore.remove(ctx, item_id)]);
}

/** Forgets everything kept about a connection's health, when it is removed. */
export async function forgetConnection(ctx: Ctx, item_id: string): Promise<void> {
  await Promise.all([warningsStore.remove(ctx, item_id), syncsStore.remove(ctx, item_id), noticesStore.remove(ctx, item_id)]);
}

/**
 * Records `now` as the last good sync of every Plaid connection that answered.
 * Both callers (a dashboard load that fetched, and the daily snapshot) write
 * "now", so the last write winning is right, and one write covers them all.
 * Never throws: this rides on paths that must not fail for it, and a lost write
 * only leaves an older date, which the next answer replaces.
 */
export async function recordSyncs(ctx: Ctx, institutions: InstitutionResult[], now: number = Date.now()): Promise<void> {
  const at = new Date(now).toISOString();
  const entries = institutions.filter((i) => !i.manual && !i.error).map((i) => [i.item_id, { at }] as const);
  if (entries.length === 0) return;
  try {
    await syncsStore.setMany(ctx, entries);
  } catch (err) {
    console.error('Connection health: the last sync times could not be saved.', nameOf(err));
  }
}

/** What the dashboard's health is built from, beyond the fetch itself. */
export type HealthReads = { warnings: Map<string, ConnectionWarning>; syncs: Map<string, LastSync> };

/**
 * LENIENT, for display only: the dashboard's badges and notes, which nothing
 * writes, deletes or records on. An entry that can't be read is left out (its
 * warning isn't shown); a store that can't be reached at all gives null, and
 * the dashboard says the health could not be read rather than failing. The
 * daily job, which acts on these, reads them strictly
 * (lib/connection-notices.ts).
 */
export async function readHealthForDisplay(ctx: Ctx): Promise<HealthReads | null> {
  try {
    const [warnings, syncs] = await Promise.all([warningsStore.getAllLenient(ctx), syncsStore.getAllLenient(ctx)]);
    return { warnings, syncs };
  } catch (err) {
    console.error('Connection health could not be read for the dashboard.', nameOf(err));
    return null;
  }
}

/** The later of two ISO times, either of which may be missing. */
function later(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/**
 * The institutions, with each Plaid connection's health attached: for the
 * response only (see `health` in lib/networth.ts). `answeredAt` is when the
 * institutions without an error answered: now for a live fetch, the payload's
 * own time for a cached one, which holds only institutions that answered.
 * Without `reads` (the stores could not be read), health still comes from the
 * fetch itself, without Plaid's warnings or the last sync times.
 */
export function withHealth<T extends InstitutionResult>(institutions: T[], reads: HealthReads | null, answeredAt: string, now: number = Date.now()): T[] {
  return institutions.map((inst) => {
    if (inst.manual) return inst;
    const stored = reads?.syncs.get(inst.item_id)?.at ?? null;
    const lastOk = inst.error ? stored : later(stored, answeredAt);
    return { ...inst, health: healthOf(inst, reads?.warnings.get(inst.item_id) ?? null, lastOk, now) };
  });
}
