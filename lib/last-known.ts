// lib/last-known.ts
//
// Last-known account state for an institution whose live fetch just failed.
//
// Without this, fetchInstitution returns `accounts: []` and the card renders
// $0.00 under a red error while the Home total silently absorbs the whole
// institution. The direction of that error is what makes it dangerous: a
// dropped credit card RAISES net worth, so a broken connection reads as good
// news. Showing the previous balances with the date they were taken is both
// more useful and less misleading than showing nothing.
//
// THE RULE, and the reason this module is separate from lib/networth.ts:
// recovered balances are DISPLAY-ONLY, and callers must apply them AFTER the
// snapshot and cache gates. `error` is deliberately left set so those gates
// stay closed. Feeding a recovered balance to recordSnapshot would write last
// week's number into today's key as though it had been measured, fabricating a
// flat line in the REAL history layer -- which nothing ever rewrites for a past
// date, so the damage would be permanent. That is strictly worse than the gap
// in the chart this feature is not trying to fix.
//
// Two stores, because neither has everything:
//   - history:accounts (lib/history.ts) supplies the balance and the "as of".
//   - accounts:meta, written here, supplies how to draw each account and which
//     Item owns it: name, mask, type, subtype, credit limit, currency.
//
// KEYED BY ITEM, REPLACED WHOLESALE. One hash field per item_id holding that
// Item's whole account list, rewritten every time the Item answers. Not one
// field per account, which was the first shape: that record could only ever
// grow, so a closed card stayed in it forever and there was no way to ask "what
// accounts does this Item have?" without trusting an append-only set. Wholesale
// replacement makes each record a true statement about one Item as of its last
// successful fetch, which is what lets recovery work per institution instead of
// reasoning about a global pool of account ids it cannot attribute.
//
// WHY A DEDICATED STORE rather than the transactions state, which already
// carries a StoredAccount per account: that map is only refreshed for accounts
// appearing in a sync's delta, because /transactions/sync returns `accounts`
// for the accounts related to the transactions in that response. A card with no
// recent activity is never revisited, an Item whose state predates the metadata
// capture keeps `type: null` from migrateLegacyState forever, and an
// investments-only Item never persists transaction state at all. All three are
// the common case for exactly the accounts worth recovering, and an account
// with no type cannot be signed, so recovery would silently do nothing.
// Capturing on the healthy net-worth path instead means it is refreshed every
// time the institution answers.
//
// This is the same move lib/hidden.ts already makes for one field. Its header
// explains why it persists each hidden account's TYPE instead of resolving it
// from the live list: "fetchInstitution() returns `accounts: []` on
// ITEM_LOGIN_REQUIRED, so a hidden card's type would vanish and the whole
// series would jump by its balance while the reauth banner was up." Same
// failure, same fix, wider scope.

import { redis, k } from './storage';
import { encrypt, decrypt } from './crypto';
import { getLatestAccountSnapshot } from './history';

const ACCOUNT_META_HASH = k('accounts:meta');

/**
 * How old the newest snapshot may be and still be presented as an account
 * balance. Past this, the figure stops being "your balance, slightly behind"
 * and starts being a historical curiosity that would drag a stale number into
 * the net-worth total. Crossing it is disclosed rather than silent (see
 * `stale_too_old`), because an institution reverting to $0.00 after five weeks
 * of showing balances is the original bug coming back unannounced.
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
  stale_too_old?: string;
  stale_missing?: number;
};

/**
 * Records how to draw every account of every institution that answered.
 *
 * Per institution and NOT gated on the whole fetch being clean: an institution
 * that succeeded should keep a current record even while a different one is
 * broken. Each Item's record is replaced entirely, so an account closed at the
 * bank disappears from it on the next successful load rather than lingering.
 * Items that did not answer are left untouched, which is what makes a broken
 * institution's record survive the outage that makes it useful.
 *
 * Best-effort, and structurally unable to throw: this runs on the healthy path,
 * where a Redis hiccup must not cost the user their dashboard.
 */
export async function rememberAccounts(institutions: Fillable[]): Promise<void> {
  const fields: Record<string, string> = {};

  for (const inst of institutions) {
    // Manual institutions have no Plaid Item to fail, and their balances live
    // in lib/manual.ts. An erroring one has `accounts: []`, and writing that
    // would erase a good record with the output of a failure.
    if (inst.error || inst.manual) continue;

    const accounts: RememberedAccount[] = [];
    for (const a of inst.accounts) {
      // No type means it could never be signed on the way back out -- an
      // unsigned balance is added to net worth as an asset, turning a card you
      // owe into money you have -- so there is no point storing it.
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
    await redis().hset(ACCOUNT_META_HASH, fields);
  } catch {
    // Worst case an institution that fails later shows the plain error card
    // instead of its balances. Only that institution: records are per Item.
  }
}

/** Every Item's remembered accounts. An unreadable record costs only that Item:
 *  a single rotated-key entry shouldn't take the rest down with it. */
async function recallByItem(): Promise<Record<string, RememberedAccount[]>> {
  let map: Record<string, string> | null;
  try {
    map = await redis().hgetall<Record<string, string>>(ACCOUNT_META_HASH);
  } catch {
    return {};
  }
  if (!map) return {};

  const out: Record<string, RememberedAccount[]> = {};
  // Fields holding the pre-per-item shape (one account object per account_id).
  // They decrypt fine and are simply not arrays. Nothing else can remove them:
  // forgetItem deletes by item_id, so they would be decrypted on every
  // broken-path load forever, and app/api/hidden-accounts could resolve a type
  // from one belonging to a disconnected Item.
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
      } catch {
        // Undecryptable record: that Item just won't be recoverable. Left in
        // place rather than deleted -- a rotated key is recoverable by putting
        // the old key back, and deleting would make that permanent.
      }
    })
  );

  if (legacy.length > 0) {
    try {
      await redis().hdel(ACCOUNT_META_HASH, ...legacy);
    } catch {
      // Best effort; they stay inert either way.
    }
  }
  return out;
}

/**
 * One remembered account by id, with the Item that owns it.
 *
 * Exists for app/api/hidden-accounts, which needs an account's TYPE to hide it
 * and previously resolved that from the net-worth cache or a live fetch. A
 * recovered account is in neither -- the cache isn't written while anything is
 * erroring, and the live fetch is the thing that failed -- so Hide on a
 * recovered row would 404 without this.
 */
export async function findRememberedAccount(
  account_id: string
): Promise<{ item_id: string; account: RememberedAccount } | null> {
  const byItem = await recallByItem();
  for (const [item_id, accounts] of Object.entries(byItem)) {
    const account = accounts.find((a) => a.account_id === account_id);
    if (account) return { item_id, account };
  }
  return null;
}

/**
 * The account ids remembered for one Item.
 *
 * A third source for the disconnect route's cleanup, and the broadest: unlike
 * the transaction store it doesn't need the Item to have synced transactions,
 * and unlike the net-worth cache it doesn't expire. Any Item that has ever
 * loaded successfully is covered.
 */
export async function rememberedIdsForItem(item_id: string): Promise<string[]> {
  try {
    const blob = await redis().hget<string>(ACCOUNT_META_HASH, item_id);
    if (!blob) return [];
    const parsed = JSON.parse(await decrypt(blob)) as RememberedAccount[];
    if (!Array.isArray(parsed)) return [];
    return parsed.map((a) => a?.account_id).filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/** Drops one Item's record, on disconnect. Safe because attribution is per
 *  Item: removing this record can't affect any other institution's recovery. */
export async function forgetItem(item_id: string): Promise<void> {
  try {
    await redis().hdel(ACCOUNT_META_HASH, item_id);
  } catch {
    // Best effort; a stale record is inert once no Item carries that id.
  }
}

export async function fillFromLastKnown(institutions: Fillable[]): Promise<StaleFill[]> {
  const broken = institutions.filter(
    (i) =>
      i.error &&
      // A manual institution's error means the Redis read failed, and its
      // balances live in exactly the store that just failed. Nothing to
      // recover, and guessing there would understate net worth silently --
      // the failure mode lib/manual.ts is written to make loud.
      !i.manual &&
      // Only a total failure. A partial one can't happen today (balances are
      // all-or-nothing per Item) but if it ever does, splicing recovered rows
      // in beside live ones would mix two dates in one subtotal.
      i.accounts.length === 0
  );
  // The healthy path costs zero reads here, matching getHistory's rule about
  // not paying for work nobody asked for.
  if (broken.length === 0) return [];

  // Both reads are shared across every broken institution rather than repeated
  // per institution: a Plaid-wide outage would otherwise download and decrypt
  // both hashes N times in parallel. Sharing the snapshot also makes every
  // recovered card carry the same "as of", which is the correct answer rather
  // than a convenient one -- snapshots exist only for days when everything
  // answered, so there is exactly one newest such day for all of them.
  const [last, byItem] = await Promise.all([getLatestAccountSnapshot(), recallByItem()]);
  if (!last) return [];

  const cutoff = new Date(Date.now() - MAX_SNAPSHOT_AGE_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const tooOld = last.date < cutoff;

  const filled: StaleFill[] = [];

  for (const inst of broken) {
    // Driven by the Item's own record, never by scanning the snapshot for
    // unowned ids. That is what keeps one institution's problems from touching
    // another's: an account this Item doesn't claim is simply not its business,
    // whether it belongs to a healthy institution, a manual one, or an Item
    // disconnected since the snapshot was taken.
    const remembered = byItem[inst.item_id] ?? [];

    const accounts = [];
    for (const m of remembered) {
      // An account this Item has but the snapshot doesn't. There is no way to
      // tell WHY from here, and the reasons are not equivalent:
      //
      //   - opened since the snapshot (a partial outage refreshes this Item's
      //     record but blocks the global snapshot, so the two drift)
      //   - its balance was null when the snapshot was taken, so it was skipped
      //   - the snapshot we landed on is not the newest, because newer dates
      //     were undecryptable
      //   - its account_id changed at reauth
      //
      // Only the first two are harmless. The rest mean we are about to draw
      // this institution short, and a short card understates debt, which
      // OVERSTATES net worth -- the failure this whole feature exists to
      // prevent. Since the reason is unknowable, the count is reported instead
      // of guessed at, and the card says how many rows it could not show.
      const balance = last.balances[m.account_id];
      if (typeof balance !== 'number') continue;
      accounts.push({
        account_id: m.account_id,
        name: m.name,
        official_name: m.official_name,
        mask: m.mask,
        type: m.type,
        subtype: m.subtype,
        balance,
        // `balance` is from stale_as_of; `limit` and `currency` are from
        // whenever the institution last answered, a different moment. That
        // split is fine for fields that don't move and not fine for one that
        // does, so `available` -- the volatile one, and the one nothing on the
        // Accounts tab renders -- is dropped rather than shown under a date it
        // doesn't belong to. `limit` is kept because without it the utilization
        // meter vanishes from the row, which reads as a rendering bug rather
        // than as missing data.
        available: null,
        limit: m.limit,
        currency: m.currency,
        // Marks these as recovered rather than measured. accountBalanceMap
        // reads it and refuses to put them in a snapshot, which turns the
        // display-only rule from a comment about statement order into
        // something the code enforces on its own.
        stale: true,
      });
    }
    const missing = remembered.length - accounts.length;

    if (accounts.length === 0) continue;

    if (tooOld) {
      // We have the balances but they're past the age limit. Say so instead of
      // reverting to a bare $0.00 card, which would look identical to never
      // having had them.
      inst.stale_too_old = last.date;
      continue;
    }

    inst.accounts = accounts;
    inst.stale_as_of = last.date;
    if (missing > 0) inst.stale_missing = missing;
    filled.push({ item_id: inst.item_id, as_of: last.date, accounts: accounts.length, missing });
  }

  return filled;
}
