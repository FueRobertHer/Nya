// lib/key-families.ts
//
// The key families stored the old way, outside the storage seam, and how each
// one's values are stored: the list the re-encryption pass (lib/reencrypt.ts)
// classifies keys by. Its own module so the seam (lib/repo.ts) can refuse a
// store name one of them already claims without importing the pass, which
// imports the seam's catalogue.
//
// FROZEN. test/storage-boundary.test.ts fails if either list gains an entry: a
// new key family is a store declared through the seam (lib/repo.ts), which the
// pass knows by its declaration. Entries only come off, each when its store
// moves behind the seam.

/** How a key's values are stored. */
export type Kind =
  | 'string' // the whole value is ciphertext
  | 'hash' // every field's value is ciphertext
  | 'cipher' // either of those, whichever type the key has (the caches)
  | 'items' // plaid:items: JSON values whose encrypted_access_token is ciphertext
  | 'plain'; // no ciphertext (checked: a v2 value in one is reported)

export const EXACT: Readonly<Record<string, Kind>> = {
  goals: 'string',
  budgets: 'string',
  'history:accounts:est:flat': 'string',

  'history:net-worth': 'hash',
  'history:net-worth:est': 'hash',
  'history:accounts': 'hash',
  'history:accounts:est': 'hash',
  'history:accounts:est:ext': 'hash',
  'history:accounts:partial': 'hash',
  'history:accounts:est:flatd': 'hash',
  'accounts:vanished': 'hash',
  'accounts:meta': 'hash',
  'accounts:directory': 'hash',
  'account-links': 'hash',
  'txn-category-overrides': 'hash',
  'txn-category-carry': 'hash',
  'account-links:lock': 'plain',
  'txn-vendor-renames': 'hash',
  'manual:accounts': 'hash',
  'hidden:accounts': 'hash',

  'plaid:items': 'items',

  'history:backfill-done': 'plain',
  'history:backfill-pending': 'plain',
  'account-links:dismissed': 'plain',
  'plaid:new-accounts': 'plain', // item id -> when Plaid reported new accounts (lib/new-accounts.ts)

  containers: 'plain', // the container registry
  owners: 'plain', // which Clerk account owns which container (lib/owners.ts)
  grants: 'plain', // sharing's first version (#88), no longer read or written
  connections: 'plain', // who is connected, and what each shares (lib/sharing.ts)
};

export const PREFIXES: readonly (readonly [string, Kind])[] = [
  ['txns:', 'string'],
  ['invtxns:', 'string'],
  ['txns-blocked:', 'plain'],
  ['invtxns-lock:', 'plain'],
  ['txns-unsaved:', 'plain'],
  ['history:forgetting:', 'plain'],
  ['ratelimit:', 'plain'], // by address, environment-wide: login attempts, demo sign-ins
  ['sessions:', 'plain'], // a container's session epoch (lib/sessions.ts)
  ['move:', 'plain'], // the data move's record (lib/move.ts)
  ['snapshot:', 'plain'], // the daily snapshot's outcomes and lock (lib/snapshot-job.ts)
  ['cache:', 'cipher'], // disposable, but moved too so "complete" means every value
  ['crypto:', 'plain'], // the key store itself: wrapped keys, not data
  ['backups:', 'plain'], // the nightly backup's last outcome (lib/backup.ts)
  ['invites:', 'plain'], // unused invite links, hashed (lib/sharing.ts)
];

/** How a key on the lists (without the environment prefix or a container) is
 *  stored, or null if neither list names it. */
export function listedKind(key: string): Kind | null {
  if (Object.hasOwn(EXACT, key)) return EXACT[key];
  for (const [prefix, kind] of PREFIXES) if (key.startsWith(prefix)) return kind;
  return null;
}
