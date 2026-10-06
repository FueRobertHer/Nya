// lib/last-known.ts
//
// Last-known account state for an institution whose live fetch just failed.
//
// Without this, fetchInstitution returns `accounts: []` and the card renders
// $0.00 under a red error while the Home total silently absorbs the whole
// institution. That error is dangerous in one direction: a dropped credit card
// RAISES net worth, so a broken connection reads as good news. Showing the
// previous balances with the date they were taken is more useful and less
// misleading than showing nothing.
//
// THE RULE: recovered balances are DISPLAY-ONLY, and callers must apply them
// AFTER the snapshot and cache gates. `error` is left set so those gates stay
// closed. Feeding a recovered balance to recordSnapshot would write last week's
// number into today's key as though it had been measured, fabricating a flat
// line in the REAL history layer that nothing ever rewrites.
//
// Two stores, because neither has everything:
//   - history:accounts (lib/history.ts) supplies the balance and the "as of".
//   - accounts:meta, written here, supplies how to draw each account and which
//     Item owns it: name, mask, type, subtype, credit limit, currency.
//
// accounts:meta is KEYED BY ITEM and REPLACED WHOLESALE: one hash field per
// item_id holding that Item's whole account list, rewritten every time the Item
// answers. A per-account append-only record could only grow (a closed card
// stayed forever) and couldn't answer "what accounts does this Item have?".
// Wholesale replacement makes each record a true statement about one Item as of
// its last successful fetch, so recovery works per institution.
//
// A dedicated store rather than the transactions state, whose StoredAccount map
// is only refreshed for accounts in a sync's delta: a card with no recent
// activity is never revisited, an Item that predates the metadata capture keeps
// `type: null`, and an investments-only Item never persists transaction state.
// Those are the common case for the accounts worth recovering, and an account
// with no type can't be signed. Capturing on the healthy net-worth path
// refreshes it every time the institution answers. lib/hidden.ts makes the same
// move for one field (a hidden card's TYPE would vanish on ITEM_LOGIN_REQUIRED).

import { redis, kc } from './storage';
import type { Ctx } from './containers';
import { encrypt, decrypt } from './crypto';
import { getLatestAccountSnapshot, snapshotTakenAt } from './history';
import { getLinks, effectiveLinks, sameAccountIds, type Link } from './link-core';

const ACCOUNT_META_HASH = (ctx: Ctx) => kc(ctx, 'accounts:meta');

/**
 * How old the newest snapshot may be and still be presented as an account
 * balance. Past this it would drag a stale number into the net-worth total.
 * Crossing it is disclosed (see `stale_too_old`), because reverting to $0.00
 * after five weeks of showing balances would be the original bug returning
 * unannounced.
 */
const MAX_SNAPSHOT_AGE_DAYS = 35;

/** How to draw one account, captured while its institution was healthy. */
export type RememberedAccount = {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  limit: number | null;
  currency: string | null;
};

/** What was recovered, for logging and tests. The institutions are mutated. */
export type StaleFill = { item_id: string; as_of: string; accounts: number; missing: number };

/** The shape this needs from an InstitutionResult, declared structurally so
 *  lib/networth.ts doesn't have to import this module to be filled by it. */
type Fillable = {
  item_id: string;
  accounts: any[];
  error: string | null;
  manual?: boolean;
  stale_as_of?: string;
  stale_as_of_at?: string;
  stale_too_old?: string;
  stale_too_old_at?: string;
  stale_missing?: number;
};

/**
 * Records how to draw every account of every institution that answered.
 *
 * Per institution and NOT gated on the whole fetch being clean: an institution
 * that succeeded keeps a current record while another is broken. Each Item's
 * record is replaced entirely, so a closed account disappears on the next
 * successful load. Items that did not answer are left untouched, which is what
 * makes a broken institution's record survive the outage.
 *
 * Best-effort, and unable to throw: this runs on the healthy path, where a Redis
 * hiccup must not cost the user their dashboard.
 */
export async function rememberAccounts(ctx: Ctx, institutions: Fillable[]): Promise<void> {
  const fields: Record<string, string> = {};

  for (const inst of institutions) {
    // Manual institutions have no Plaid Item to fail (their balances live in
    // lib/manual.ts), and an erroring one has `accounts: []`, which would erase
    // a good record.
    if (inst.error || inst.manual) continue;

    const accounts: RememberedAccount[] = [];
    for (const a of inst.accounts) {
      // No type means it could never be signed on the way back out (an unsigned
      // card would be added to net worth as an asset), so don't store it.
      if (typeof a?.account_id !== 'string' || typeof a?.type !== 'string') continue;
      accounts.push({
        account_id: a.account_id,
        name: a.name ?? '',
        official_name: a.official_name ?? null,
        mask: a.mask ?? null,
        type: a.type,
        subtype: a.subtype ?? null,
        limit: typeof a.limit === 'number' ? a.limit : null,
        currency: a.currency ?? null,
      });
    }
    if (accounts.length === 0) continue;

    try {
      fields[inst.item_id] = await encrypt(JSON.stringify(accounts));
    } catch {
      // Skip this Item rather than lose the whole batch.
    }
  }

  if (Object.keys(fields).length === 0) return;
  try {
    await redis().hset(ACCOUNT_META_HASH(ctx), fields);
  } catch {
    // Worst case an institution that fails later shows the plain error card
    // instead of its balances. Only that institution: records are per Item.
  }
}

/** Every Item's remembered accounts. An unreadable record costs only that Item:
 *  a single rotated-key entry shouldn't take the rest down with it.
 *
 *  `strict` throws instead, on a failed read or any unreadable record, for a
 *  caller that writes on the strength of the answer (lib/links.ts
 *  liveAccountIds). */
async function recallByItem(ctx: Ctx, strict = false): Promise<Record<string, RememberedAccount[]>> {
  let map: Record<string, string> | null;
  try {
    map = await redis().hgetall<Record<string, string>>(ACCOUNT_META_HASH(ctx));
  } catch (err) {
    if (strict) throw err;
    return {};
  }
  if (!map) return {};

  const out: Record<string, RememberedAccount[]> = {};
  // Fields in the pre-per-item shape (one account object per account_id).
  // They decrypt but aren't arrays. Nothing else removes them (forgetItem
  // deletes by item_id), so they'd be decrypted on every broken-path load, and
  // app/api/hidden-accounts could resolve a type from a disconnected Item's.
  const legacy: string[] = [];

  await Promise.all(
    Object.entries(map).map(async ([item_id, blob]) => {
      try {
        const parsed = JSON.parse(await decrypt(blob)) as RememberedAccount[];
        if (!Array.isArray(parsed)) {
          legacy.push(item_id);
          return;
        }
        const accounts = parsed.filter(
          (a) => typeof a?.account_id === 'string' && typeof a?.type === 'string'
        );
        if (accounts.length > 0) out[item_id] = accounts;
      } catch (err) {
        if (strict) throw err;
        // Undecryptable: that Item just won't be recoverable. Left in place
        // rather than deleted, since a rotated key is fixed by restoring the key.
      }
    })
  );

  if (legacy.length > 0) {
    try {
      await redis().hdel(ACCOUNT_META_HASH(ctx), ...legacy);
    } catch {
      // Best effort; they stay inert either way.
    }
  }
  return out;
}

/**
 * One remembered account by id, with the Item that owns it.
 *
 * For app/api/hidden-accounts, which needs an account's TYPE to hide it. A
 * recovered account is in neither the net-worth cache (not written while
 * anything is erroring) nor a live fetch (the thing that failed), so Hide on a
 * recovered row would 404 without this.
 */
export async function findRememberedAccount(ctx: Ctx, 
  account_id: string
): Promise<{ item_id: string; account: RememberedAccount } | null> {
  const byItem = await recallByItem(ctx);
  for (const [item_id, accounts] of Object.entries(byItem)) {
    const account = accounts.find((a) => a.account_id === account_id);
    if (account) return { item_id, account };
  }
  return null;
}

/**
 * The account ids remembered for one Item: a source for the disconnect route's
 * cleanup, and the broadest, since it needs no transaction sync and doesn't
 * expire. Any Item that has ever loaded successfully is covered.
 */
export async function rememberedIdsForItem(ctx: Ctx, item_id: string): Promise<string[]> {
  try {
    const blob = await redis().hget<string>(ACCOUNT_META_HASH(ctx), item_id);
    if (!blob) return [];
    const parsed = JSON.parse(await decrypt(blob)) as RememberedAccount[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((a) => a?.account_id).filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/**
 * Every Item's remembered account ids, in ONE read: the batch form of
 * rememberedIdsForItem (lib/vanished.ts). Upstash is HTTP, so per-Item reads
 * cost a round trip each on the uncached dashboard path.
 */
export async function rememberedIdsByItem(ctx: Ctx, strict = false): Promise<Record<string, string[]>> {
  const byItem = await recallByItem(ctx, strict);
  const out: Record<string, string[]> = {};
  for (const [item_id, accounts] of Object.entries(byItem)) {
    out[item_id] = accounts.map((a) => a.account_id);
  }
  return out;
}

/** Every Item's remembered accounts, whole, for the download of my data
 *  (lib/user-export.ts). Strict: throws on a failed read or any record that
 *  can't be read, rather than leaving that Item's accounts out. */
export async function rememberedAccountsByItem(ctx: Ctx): Promise<Record<string, RememberedAccount[]>> {
  return recallByItem(ctx, true);
}

/**
 * Deletes the remembered records of Items no longer stored that name this
 * account, for a user forgetting it. A disconnect already deletes the Item's
 * record, but a load in flight can write it back after (see liveAccountIds in
 * lib/links.ts), and it carries the account's name and mask. Throws on a
 * failed read, so the caller doesn't report the account forgotten.
 */
export async function forgetStaleRecords(ctx: Ctx, account_id: string, storedItems: Set<string>): Promise<void> {
  const byItem = await recallByItem(ctx, true);
  const stale = Object.entries(byItem)
    .filter(([item_id, accounts]) => !storedItems.has(item_id) && accounts.some((a) => a.account_id === account_id))
    .map(([item_id]) => item_id);
  if (stale.length > 0) await redis().hdel(ACCOUNT_META_HASH(ctx), ...stale);
}

/** Drops one Item's record, on disconnect. Safe because attribution is per
 *  Item: removing this record can't affect any other institution's recovery. */
export async function forgetItem(ctx: Ctx, item_id: string): Promise<void> {
  try {
    await redis().hdel(ACCOUNT_META_HASH(ctx), item_id);
  } catch {
    // Best effort; a stale record is inert once no Item carries that id.
  }
}

export async function fillFromLastKnown(ctx: Ctx, institutions: Fillable[]): Promise<StaleFill[]> {
  const broken = institutions.filter(
    (i) =>
      i.error &&
      // A manual institution's error means the Redis read failed, and its
      // balances live in the store that just failed. Guessing would silently
      // understate net worth, the failure lib/manual.ts is written to make loud.
      !i.manual &&
      // Only a total failure. Splicing recovered rows beside live ones would mix
      // two dates in one subtotal (can't happen today: balances are per Item).
      i.accounts.length === 0
  );
  // The healthy path costs zero reads here, matching getHistory's rule about
  // not paying for work nobody asked for.
  if (broken.length === 0) return [];

  // Both reads are shared across every broken institution: a Plaid-wide outage
  // would otherwise download and decrypt both hashes N times in parallel. Sharing
  // the snapshot also gives every recovered card the same "as of", which is
  // correct: snapshots exist only for days when everything answered.
  const [last, byItem, links] = await Promise.all([
    getLatestAccountSnapshot(ctx),
    recallByItem(ctx),
    // Recovery is display-only, so links that can't be read just mean an
    // account known by an earlier id isn't found under it.
    getLinks(ctx).catch(() => new Map<string, Link>()),
  ]);
  if (!last) return [];
  // A link whose old id is live again is paused (see effectiveLinks): following
  // it would give that account the new id's balance and count one twice.
  const liveIds = new Set(
    Object.values(byItem).flatMap((accounts) => accounts.map((a) => a.account_id))
  );
  const activeLinks = effectiveLinks(links, liveIds);

  const cutoff = new Date(Date.now() - MAX_SNAPSHOT_AGE_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const tooOld = last.date < cutoff;
  // The instant behind that date, so the card can name the viewer's own day
  // (the date is a UTC day). Absent for an older snapshot: the date shows.
  const taken = await snapshotTakenAt(ctx, last.date);
  // Only an instant inside that UTC day is this snapshot's: a restore keeps this
  // environment's own record, which can outlive different restored balances.
  const takenAt = taken && taken.slice(0, 10) === last.date ? taken : null;

  const filled: StaleFill[] = [];

  for (const inst of broken) {
    // Driven by the Item's own record, never by scanning the snapshot for
    // unowned ids, so one institution's problems never touch another's (healthy,
    // manual, or disconnected since the snapshot).
    const remembered = byItem[inst.item_id] ?? [];

    const accounts = [];
    for (const m of remembered) {
      // An account this Item has but the snapshot doesn't. The reason is
      // unknowable from here:
      //
      //   - opened since the snapshot (a partial outage refreshes this Item's
      //     record but blocks the global snapshot, so the two drift)
      //   - its balance was null when the snapshot was taken
      //   - the snapshot we landed on is not the newest, because newer dates
      //     were undecryptable
      //   - its account_id changed at reauth
      //
      // Only the first two are harmless. The rest mean this institution is drawn
      // short, which understates debt and OVERSTATES net worth, so the count is
      // reported and the card says how many rows it could not show.
      // Looked up under its current id, or an earlier id the user linked to it
      // (lib/links.ts): the snapshot may predate the new id.
      const balance = sameAccountIds(m.account_id, activeLinks)
        .map((id) => last.balances[id])
        .find((b) => typeof b === 'number');
      if (typeof balance !== 'number') continue;
      accounts.push({
        account_id: m.account_id,
        name: m.name,
        official_name: m.official_name,
        mask: m.mask,
        type: m.type,
        subtype: m.subtype,
        balance,
        // `balance` is from stale_as_of; `limit` and `currency` are from whenever
        // the institution last answered. Fine for fields that don't move, not for
        // `available` (volatile, and not rendered on the Accounts tab), which is
        // dropped rather than shown under the wrong date. `limit` is kept because
        // without it the utilization meter vanishes, which reads as a rendering bug.
        available: null,
        limit: m.limit,
        currency: m.currency,
        // Marks these as recovered rather than measured: accountBalanceMap
        // refuses to snapshot them, so the display-only rule is enforced by code.
        stale: true,
      });
    }
    const missing = remembered.length - accounts.length;

    if (accounts.length === 0) continue;

    if (tooOld) {
      // Balances exist but are past the age limit. Say so instead of a bare
      // $0.00 card, which would look like never having had them.
      inst.stale_too_old = last.date;
      if (takenAt) inst.stale_too_old_at = takenAt;
      continue;
    }

    inst.accounts = accounts;
    inst.stale_as_of = last.date;
    if (takenAt) inst.stale_as_of_at = takenAt;
    if (missing > 0) inst.stale_missing = missing;
    filled.push({ item_id: inst.item_id, as_of: last.date, accounts: accounts.length, missing });
  }

  return filled;
}
