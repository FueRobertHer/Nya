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
//   - history:accounts (lib/history.ts) holds balances keyed by date, so it
//     supplies both the figure and an honest "as of". It also decides which
//     accounts still EXIST -- see getLatestAccountSnapshot.
//   - accounts:meta, written here, holds how to render them: name, mask, type,
//     subtype, credit limit, currency.
//
// WHY A DEDICATED METADATA STORE rather than reusing the transactions state,
// which already carries a StoredAccount per account. Because that map is only
// refreshed for accounts appearing in a sync's delta: /transactions/sync
// returns `accounts` for the accounts related to the transactions in that
// response, so a card with no recent activity is never revisited. An Item whose
// state predates the metadata capture keeps `type: null` from
// migrateLegacyState forever, and an investments-only Item never persists
// transaction state at all. Both are the common case for exactly the accounts
// worth recovering, and an account with no type cannot be signed, so recovery
// would silently do nothing. Capturing metadata on the healthy net-worth path
// instead means it is refreshed every time the institution answers.
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

/** How to render an account, captured while its institution was healthy. */
export type RememberedAccount = {
  item_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  limit: number | null;
  currency: string | null;
};

/**
 * How old the newest snapshot may be and still be presented as an account
 * balance. Past this, the figure stops being "your balance, slightly behind"
 * and starts being a historical curiosity that would drag a stale number into
 * the net-worth total. Crossing it is disclosed rather than silent (see
 * `stale_too_old`), because an institution silently reverting to $0.00 after
 * five weeks of showing balances is the original bug coming back unannounced.
 */
const MAX_SNAPSHOT_AGE_DAYS = 35;

/** What was recovered, for logging and tests. The institutions are mutated. */
export type StaleFill = { item_id: string; as_of: string; accounts: number };

/** The shape this needs from an InstitutionResult, declared structurally so
 *  lib/networth.ts doesn't have to import this module to be filled by it. */
type Fillable = {
  item_id: string;
  accounts: any[];
  error: string | null;
  needs_reauth?: boolean;
  manual?: boolean;
  stale_as_of?: string;
  stale_too_old?: string;
};

/**
 * Records how to render every account of every institution that answered.
 *
 * Per institution, not gated on the whole fetch being clean: an institution
 * that succeeded should keep a fresh record even while a different one is
 * broken. Entries are only ever written, never deleted, so a broken
 * institution's record survives the outage that makes it useful.
 *
 * Stale entries for closed or disconnected accounts are harmless: nothing here
 * decides whether an account exists, only how to draw one the snapshot layer
 * already vouched for.
 *
 * Best-effort. This runs on the healthy path, where a Redis hiccup must not
 * cost the user their dashboard.
 */
export async function rememberAccounts(institutions: Fillable[]): Promise<void> {
  const fields: Record<string, string> = {};

  for (const inst of institutions) {
    if (inst.error || inst.manual) continue;
    for (const a of inst.accounts) {
      // No type means it could never be signed on the way back out, so there is
      // no point storing it.
      if (typeof a?.account_id !== 'string' || typeof a?.type !== 'string') continue;
      const value: RememberedAccount = {
        item_id: inst.item_id,
        name: a.name ?? '',
        official_name: a.official_name ?? null,
        mask: a.mask ?? null,
        type: a.type,
        subtype: a.subtype ?? null,
        limit: typeof a.limit === 'number' ? a.limit : null,
        currency: a.currency ?? null,
      };
      try {
        fields[a.account_id] = await encrypt(JSON.stringify(value));
      } catch {
        // Skip this one rather than lose the whole batch.
      }
    }
  }

  if (Object.keys(fields).length === 0) return;
  try {
    await redis().hset(ACCOUNT_META_HASH, fields);
  } catch {
    // Worst case a later failure shows the plain error card instead of balances.
  }
}

/** Everything remembered, by account_id. Unreadable fields are skipped rather
 *  than failing the batch: a single rotated-key entry shouldn't cost the rest. */
async function recallAccounts(): Promise<Record<string, RememberedAccount>> {
  let map: Record<string, string> | null;
  try {
    map = await redis().hgetall<Record<string, string>>(ACCOUNT_META_HASH);
  } catch {
    return {};
  }
  if (!map) return {};

  const out: Record<string, RememberedAccount> = {};
  await Promise.all(
    Object.entries(map).map(async ([account_id, blob]) => {
      try {
        const parsed = JSON.parse(await decrypt(blob)) as Partial<RememberedAccount>;
        if (typeof parsed.item_id !== 'string' || typeof parsed.type !== 'string') return;
        out[account_id] = {
          item_id: parsed.item_id,
          name: parsed.name ?? '',
          official_name: parsed.official_name ?? null,
          mask: parsed.mask ?? null,
          type: parsed.type,
          subtype: parsed.subtype ?? null,
          limit: typeof parsed.limit === 'number' ? parsed.limit : null,
          currency: parsed.currency ?? null,
        };
      } catch {
        // Undecryptable entry: that account just won't be recoverable.
      }
    })
  );
  return out;
}

/**
 * The account ids remembered for one Item.
 *
 * A third source for the disconnect route's cleanup, and the most complete one:
 * unlike the transaction store it doesn't need the Item to have synced
 * transactions, and unlike the net-worth cache it doesn't expire. Any Item that
 * has ever loaded successfully is covered.
 */
export async function rememberedIdsForItem(item_id: string): Promise<string[]> {
  const meta = await recallAccounts();
  return Object.entries(meta)
    .filter(([, m]) => m.item_id === item_id)
    .map(([account_id]) => account_id);
}

/** Drops remembered entries for accounts that no longer exist, mirroring
 *  pruneHidden. Not load-bearing (the snapshot layer decides existence), just
 *  housekeeping so a disconnected Item's rows don't linger forever. */
export async function pruneRemembered(account_ids: string[]): Promise<void> {
  if (account_ids.length === 0) return;
  try {
    await redis().hdel(ACCOUNT_META_HASH, ...account_ids);
  } catch {
    // Best effort; a stale entry is inert.
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
  // the whole snapshot hash N times in parallel. Sharing the snapshot also
  // makes every recovered card carry the same "as of", which is the correct
  // answer rather than a convenient one -- snapshots exist only for days when
  // everything answered, so there is exactly one newest such day for all of them.
  const [last, meta] = await Promise.all([getLatestAccountSnapshot(), recallAccounts()]);
  if (!last) return [];

  // REFUSE TO RECOVER PART OF AN INSTITUTION.
  //
  // An account can only be recovered if BOTH stores know it: the snapshot for
  // its balance, accounts:meta for its type and owning Item. If the snapshot
  // names an account that is neither live right now nor in accounts:meta, it
  // must belong to one of the failed institutions and cannot be attributed to
  // one -- so any card we drew would be missing a row, and its subtotal would
  // be wrong while the note said only "dated". A missing credit card overstates
  // net worth, which is precisely the failure this whole feature exists to
  // prevent, and it would be reintroduced one layer down and harder to see.
  //
  // The divergence is real, not theoretical: recordSnapshot has three callers
  // (this route, the daily cron, /api/ingest/balance) and rememberAccounts is
  // called from all three, but only a deploy where they agree keeps the stores
  // in step. This check is what makes a fourth writer, or a missed one, fail
  // safe rather than silently.
  const liveIds = new Set<string>();
  for (const inst of institutions) {
    if (inst.error) continue;
    for (const a of inst.accounts) {
      if (typeof a?.account_id === 'string') liveIds.add(a.account_id);
    }
  }
  const unattributable = Object.keys(last.balances).filter((id) => !liveIds.has(id) && !meta[id]);
  if (unattributable.length > 0) {
    console.warn(
      `last-known: ${unattributable.length} snapshot account(s) have no metadata; ` +
        'skipping recovery rather than showing a partial institution',
      unattributable
    );
    return [];
  }

  const cutoff = new Date(Date.now() - MAX_SNAPSHOT_AGE_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const tooOld = last.date < cutoff;

  const filled: StaleFill[] = [];

  for (const inst of broken) {
    const accounts = [];
    for (const [account_id, balance] of Object.entries(last.balances)) {
      // The snapshot decides existence, the metadata decides presentation and
      // which institution the account belongs to.
      const m = meta[account_id];
      if (!m || m.item_id !== inst.item_id) continue;
      accounts.push({
        account_id,
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
    filled.push({ item_id: inst.item_id, as_of: last.date, accounts: accounts.length });
  }

  return filled;
}
