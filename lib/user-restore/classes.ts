// lib/user-restore/classes.ts
//
// What every key a container can hold is, to a restore (docs/data-export.md,
// "Bringing it back"): one class for each key family stored the old way
// (lib/key-families.ts) and each store declared on the seam (lib/stores.ts),
// so the scan that decides whether an account is empty (lib/user-restore/
// empty.ts) never guesses. test/user-restore-classes.test.ts fails when a
// family or a store has no class, as test/user-export.test.ts does for the
// download's STORED_KEYS, so a store added later has to take a side.
//
//   machinery  the app's own bookkeeping, counters, locks and caches; the
//              person's API tokens (they read whatever the account holds) and
//              their record of showings (about sharing, which is not part of a
//              restore). Ignored by the scan. Undo and emptying keep only the
//              part of it that is independent of the data they delete
//              (keptWhenEmptied): what is derived from that data (the
//              holdings index, the walk's record, a connection's markers)
//              goes with it, or a later restore would read it as its own.
//   setting    one value that nothing else stored refers to while the account
//              holds no data: allowed, and replaced by the file's, as the
//              preview says.
//   data       the person's money, or what describes it: the account is in
//              use.
//   record     the restore's own record: one restore at a time.
//
// Every counter store is machinery by its kind, whatever its name. A key this
// table doesn't name counts as data at run time, never as nothing.

import { splitScoped } from '../containers';
import { EXACT, PREFIXES } from '../key-families';
import { declaredStore, declaredStores } from '../stores';

export type KeyClass = 'machinery' | 'setting' | 'data' | 'record';

/** The families stored the old way. */
export const FAMILY_CLASSES: Readonly<Record<string, KeyClass>> = {
  // EXACT
  goals: 'data',
  budgets: 'data',
  'history:accounts:est:flat': 'data',
  'history:net-worth': 'data',
  'history:net-worth:est': 'data',
  'history:accounts': 'data',
  'history:accounts:est': 'data',
  'history:accounts:est:ext': 'data',
  'history:accounts:partial': 'data',
  'history:accounts:est:flatd': 'data',
  // Held while the snapshot waits to be sure an account went missing: a
  // live connection's, inert without one.
  'accounts:vanished': 'machinery',
  'accounts:meta': 'data',
  'accounts:directory': 'data',
  'account-links': 'data',
  'txn-category-overrides': 'data',
  'txn-category-carry': 'data',
  'account-links:lock': 'machinery',
  'txn-vendor-renames': 'data',
  'manual:accounts': 'data',
  'hidden:accounts': 'data',
  'plaid:items': 'data',
  'history:backfill-done': 'machinery',
  'history:backfill-pending': 'machinery',
  'account-links:dismissed': 'data',
  // A prompt to add accounts Plaid found: a live connection's.
  'plaid:new-accounts': 'machinery',
  // Environment-wide: never inside a container. Found inside one, a key was
  // built wrongly, and it counts as data.
  containers: 'data',
  owners: 'data',
  grants: 'data',
  connections: 'data',
  // PREFIXES
  'txns:': 'data',
  'invtxns:': 'data',
  'txns-blocked:': 'machinery',
  'invtxns-lock:': 'machinery',
  'txns-unsaved:': 'machinery',
  'history:forgetting:': 'machinery',
  'ratelimit:': 'machinery',
  'sessions:': 'machinery',
  'move:': 'machinery',
  'snapshot:': 'machinery',
  'cache:': 'machinery',
  'crypto:': 'data',
  'backups:': 'data',
  'invites:': 'data',
};

/** The stores declared on the seam, by name. Counter stores need no entry:
 *  they are machinery by kind. */
export const STORE_CLASSES: Readonly<Record<string, KeyClass>> = {
  'account-lifecycle': 'data',
  'allocation-settings': 'setting',
  // The record of changes made with API tokens (lib/api-changes.ts): about
  // the copy it was kept in, whose tokens aren't brought back, and goes when
  // the data it describes is emptied.
  'api-changes': 'machinery',
  'api-change-keys': 'machinery',
  'api-tokens': 'machinery',
  // The person's record of what they brought over from other apps, and its
  // Undo (lib/migration/store.ts).
  'app-imports': 'data',
  'budget-months': 'data',
  'budget-set': 'data',
  'carried-annotations': 'data',
  'carried-imported-twins': 'data',
  categories: 'setting',
  // Plaid connection health: a connection's, dropped by the daily job once it
  // is gone, and never a figure.
  'connection-notices': 'machinery',
  'connection-syncs': 'machinery',
  'connection-warnings': 'machinery',
  'connector-accounts': 'data',
  'connector-connections': 'data',
  'connector-ended': 'data',
  'connector-secrets': 'data',
  // The home currency and own rates (lib/fx/settings.ts): one value the
  // rest is shown through, never referred to by what is stored.
  'currency-settings': 'setting',
  'fire-plan': 'setting',
  'goal-plans': 'data',
  'history-import-summaries': 'data',
  'history-imports': 'data',
  'holdings:history': 'data',
  // Derived from the months, which are data.
  'holdings:history:index': 'machinery',
  'import-settings': 'data',
  'import-summaries': 'data',
  'imported-history-walk': 'machinery',
  'imported-transactions': 'data',
  'imported-twins': 'data',
  imports: 'data',
  'income-carryover': 'setting',
  'manual-transactions': 'data',
  // What-ifs the person kept beside their Plan: theirs, as the runway's are.
  'plan-scenarios': 'data',
  'planned-items': 'data',
  'report-settings': 'setting',
  'restored-accounts': 'data',
  'restored-investment-transactions': 'data',
  'restored-transactions': 'data',
  'review-settings': 'setting',
  rules: 'data',
  // What-ifs the person kept for the runway: theirs, so an account holding
  // one is in use.
  'runway-scenarios': 'data',
  'sharing-access-log': 'machinery',
  tags: 'data',
  'timeline-notes': 'data',
  'transaction-annotations': 'data',
  'transaction-approvals': 'data',
  'transaction-groups': 'data',
  'transaction-splits': 'data',
  'user-restore': 'record',
  'vendor-defaults': 'data',
  'weekly-summary': 'setting',
  'weekly-summary-state': 'machinery',
};

/** The family or store a key (relative to the environment's prefix) belongs
 *  to, and its class; a key nothing names is data. */
export function classOfKey(key: string): { family: string | null; cls: KeyClass } {
  const inner = splitScoped(key).key;
  if (Object.hasOwn(EXACT, inner)) return { family: inner, cls: FAMILY_CLASSES[inner] ?? 'data' };
  for (const [prefix] of PREFIXES) if (inner.startsWith(prefix)) return { family: prefix, cls: FAMILY_CLASSES[prefix] ?? 'data' };
  const store = declaredStore(inner);
  if (store) {
    if (store.kind === 'counter' || store.kind === 'counter-map') return { family: inner, cls: 'machinery' };
    return { family: inner, cls: STORE_CLASSES[inner] ?? 'data' };
  }
  return { family: null, cls: 'data' };
}

/** The machinery that is independent of the person's data (see the header):
 *  counters (by kind), sessions, caches, the rate limits, locks, the
 *  snapshot's own log and lock (SNAPSHOT_KEPT), the move's records, the API
 *  tokens, the record of showings and the weekly summary's key. */
const KEPT_WHEN_EMPTIED: ReadonlySet<string> = new Set([
  'ratelimit:',
  'sessions:',
  'cache:',
  'move:',
  'account-links:lock',
  'invtxns-lock:',
  'api-tokens',
  'sharing-access-log',
  'weekly-summary-state',
]);

/** Whether undo and emptying keep a key (relative to the environment's
 *  prefix): machinery that is independent of the data they delete (see the
 *  header). Everything else goes, derived machinery with the data. */
export function keptWhenEmptied(key: string): boolean {
  const { family, cls } = classOfKey(key);
  if (cls !== 'machinery' || family === null) return false;
  const store = declaredStore(family);
  if (store && (store.kind === 'counter' || store.kind === 'counter-map')) return true;
  // Of the snapshot's keys, its own log and lock: when each day's snapshot
  // was taken (`snapshot:taken`, what a day's "as of" time is read from) and
  // what it saw of each connection (`snapshot:item-usage`) are the data's.
  if (family === 'snapshot:') return SNAPSHOT_KEPT.has(splitScoped(key).key);
  return KEPT_WHEN_EMPTIED.has(family);
}

/** The snapshot's keys that are about the cron, not the data (see
 *  keptWhenEmptied): its runs' outcomes and its lock (lib/snapshot-job.ts). */
const SNAPSHOT_KEPT: ReadonlySet<string> = new Set(['snapshot:runs', 'snapshot:lock']);

/** Families and stores without a class: what the test checks is empty. */
export function unclassified(): string[] {
  const out: string[] = [];
  for (const k of Object.keys(EXACT)) if (!Object.hasOwn(FAMILY_CLASSES, k)) out.push(k);
  for (const [p] of PREFIXES) if (!Object.hasOwn(FAMILY_CLASSES, p)) out.push(p);
  for (const s of declaredStores()) {
    if (s.kind === 'counter' || s.kind === 'counter-map') continue;
    if (!Object.hasOwn(STORE_CLASSES, s.name)) out.push(s.name);
  }
  return out;
}
