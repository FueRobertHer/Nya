// lib/connection-records.ts
//
// What Nya keeps about the health of each bank connection (#51): one entry per
// connection, under Plaid's item_id (a provider's own opaque id, already the
// field name of every per-connection store), in three stores on the storage
// seam (lib/repo.ts). Each is written from one module and only removed
// anywhere else, so "last write wins" never costs one the others' change (see
// WHO WINS in lib/repo.ts):
//
//   connection-warnings  Plaid's early warning that the connection is going to
//                        end, from the verified webhook
//                        (lib/connection-health.ts). Removed when the
//                        connection is repaired or removed, or the warning
//                        lapses.
//   connection-syncs     when the connection last answered without an error:
//                        every load that fetched it, and the daily snapshot.
//   connection-notices   the email bookkeeping for a break: when it began, what
//                        it was, when its notices and its reminder went, and
//                        whether its notice is held back for a while
//                        (lib/connection-notices.ts, from the daily job).
//
// Encrypted like every seam value; the ids are the item_ids the other stores
// already hold in plain text. All three are in the person's data download
// (docs/data-export.md): they are about that person's own connections, shown
// on their Connection health card and named on /privacy, and the notices are
// the record of the emails Nya sent them. The container's deletion deletes
// them, and a disconnect removes the connection's entries
// (lib/disconnect-item.ts).
//
// This module only declares the stores, so lib/stores.ts can load it without
// pulling in anything else.

import { defineMapStore } from './repo';
import { HEALTH_STATES, type ConnectionWarning, type HealthState, type Side } from './connection-state';

/** When a connection last answered without an error (whatever accounts it
 *  reported: one missing an account still answered). */
export type LastSync = { at: string };

/** One break of one connection, from the first daily run that saw it until a
 *  run sees it healthy again (lib/connection-notices.ts). */
export type ConnectionNotice = {
  /** A random id for this break: the email's idempotency key is built from it. */
  episode: string;
  /** When the daily job first saw it (an ISO time). */
  since: string;
  /** Its state when last seen. */
  state: HealthState;
  /** Whose side it was on when last seen. Absent from a record written before
   *  this was kept. */
  side?: Side;
  /** When its latest notice was sent, or null while none has been. */
  notified_at: string | null;
  /** When the reminder of that notice was sent, or null while none has been. */
  reminded_at: string | null;
  /** The states its notices were about, in the order they were sent: a state
   *  that needs the person and isn't here yet gets a notice of its own. Absent
   *  from a record written before this was kept, which reads as its own state
   *  once notified. */
  told?: HealthState[];
  /** When its pending notice first became due; absent once a notice is sent.
   *  Only a notice first due on a run can be held back on it. */
  due_since?: string;
  /** When its notice was held back as part of a fault many containers shared
   *  (lib/connection-notices.ts). It goes three days later if the break is
   *  still open, and is never held again; absent once a notice is sent. */
  held_at?: string;
};

const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const STATES = new Set<unknown>(HEALTH_STATES);
const SIDES = new Set<unknown>(['none', 'you', 'bank', 'plaid', 'nya', 'unknown'] satisfies Side[]);

export function isWarning(v: unknown): v is ConnectionWarning {
  return (
    isRecord(v) &&
    (v.kind === 'pending_expiration' || v.kind === 'pending_disconnect') &&
    isTime(v.received_at) &&
    isTime(v.ends_at) &&
    typeof v.ends_estimated === 'boolean' &&
    (v.reason === null || (typeof v.reason === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v.reason)))
  );
}

export function isLastSync(v: unknown): v is LastSync {
  return isRecord(v) && isTime(v.at);
}

export function isNotice(v: unknown): v is ConnectionNotice {
  return (
    isRecord(v) &&
    typeof v.episode === 'string' &&
    /^[A-Za-z0-9-]{1,64}$/.test(v.episode) &&
    isTime(v.since) &&
    STATES.has(v.state) &&
    (v.side === undefined || SIDES.has(v.side)) &&
    (v.notified_at === null || isTime(v.notified_at)) &&
    (v.reminded_at === null || isTime(v.reminded_at)) &&
    (v.told === undefined || (Array.isArray(v.told) && v.told.length <= HEALTH_STATES.length && v.told.every((s) => STATES.has(s)))) &&
    (v.due_since === undefined || isTime(v.due_since)) &&
    (v.held_at === undefined || isTime(v.held_at))
  );
}

export const warningsStore = defineMapStore<ConnectionWarning>('connection-warnings', {
  what: 'connection warnings',
  isValid: isWarning,
  exportable: true,
});

export const syncsStore = defineMapStore<LastSync>('connection-syncs', {
  what: 'connection sync times',
  isValid: isLastSync,
  exportable: true,
});

export const noticesStore = defineMapStore<ConnectionNotice>('connection-notices', {
  what: 'connection notices',
  isValid: isNotice,
  exportable: true,
});
