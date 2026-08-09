// lib/hidden.ts
//
// Hidden accounts: "keep syncing this, just don't count it." A joint account, a
// business card, an old account kept linked for records. Unlike disconnecting
// or deleting, nothing is discarded -- the account is still fetched, still
// stored, still snapshotted, and unhiding restores it complete.
//
// THE GOVERNING PRINCIPLE: storage never changes; hiding is applied on read.
// recordSnapshot() keeps writing the true total and the full per-account
// balance map regardless of what's hidden (see lib/history.ts). Two things fall
// out of that:
//
//   1. Unhiding is exactly symmetric, because nothing was ever removed. The
//      history accumulated while an account was hidden is still there.
//   2. A failed hidden read can only ever display a wrong number, never write
//      one. Contrast lib/manual.ts, where a bad read *could* poison a permanent
//      record, which is why that module's failure mode has to be louder.
//
// Stored as a Redis hash (field = account_id) rather than a SET, for two
// reasons. HSET/HDEL are atomic single commands keyed by field name, so there's
// no read-modify-write window -- the same reason lib/storage.ts chose a hash.
// And the value can be encrypted: a SET would force plaintext, because
// encrypt() uses a random IV (lib/crypto.ts) so ciphertext is non-deterministic
// and SREM by value could never match its own output.
//
// The stored value carries the account's TYPE. That is load-bearing, not
// incidental: subtracting a hidden account from a past net-worth total needs to
// know whether its balance added or subtracted, and the per-account history map
// stores raw balances only. Resolving the type from the live account list
// instead would fail exactly when an institution is unhealthy --
// fetchInstitution() returns `accounts: []` on ITEM_LOGIN_REQUIRED, so a hidden
// card's type would vanish and the whole series would jump by its balance while
// the reauth banner was up, then jump back.

import { redis, k } from './storage';
import { encrypt, decrypt } from './crypto';
import { signedContribution } from './balance';

const HIDDEN_HASH = k('hidden:accounts');

export type HiddenAccount = {
  type: string;
  hidden_at: string; // ISO
};

/** account_id -> what we need to subtract it from a total. */
export type HiddenMap = Map<string, HiddenAccount>;

/**
 * Every hidden account. Throws on a Redis error, or if any field fails to
 * decrypt or parse -- silently returning an empty map would put data back on
 * screen that was deliberately taken off it, which is the one outcome hiding
 * must never produce.
 */
export async function getHiddenAccounts(): Promise<HiddenMap> {
  const map = await redis().hgetall<Record<string, string>>(HIDDEN_HASH);
  const out: HiddenMap = new Map();
  if (!map) return out; // genuinely empty hash

  await Promise.all(
    Object.entries(map).map(async ([account_id, blob]) => {
      try {
        const parsed = JSON.parse(await decrypt(blob)) as Partial<HiddenAccount>;
        if (typeof parsed.type !== 'string') {
          throw new Error('missing type');
        }
        out.set(account_id, {
          type: parsed.type,
          hidden_at:
            typeof parsed.hidden_at === 'string' ? parsed.hidden_at : new Date(0).toISOString(),
        });
      } catch (err) {
        throw new Error(`Hidden account ${account_id} could not be read`, { cause: err });
      }
    })
  );
  return out;
}

/** Hides or unhides one account. Single-field HSET/HDEL, so concurrent toggles
 *  of different accounts can't clobber each other. */
export async function setAccountHidden(
  account_id: string,
  type: string,
  hidden: boolean
): Promise<void> {
  if (!hidden) {
    await redis().hdel(HIDDEN_HASH, account_id);
    return;
  }
  const value: HiddenAccount = { type, hidden_at: new Date().toISOString() };
  await redis().hset(HIDDEN_HASH, { [account_id]: await encrypt(JSON.stringify(value)) });
}

/**
 * Drops hidden entries for accounts that no longer exist (institution
 * disconnected, manual account deleted).
 *
 * Worth doing properly rather than leaving stale ids around: the historical
 * per-account maps still contain a deleted account's balances, so getHistory
 * would go on subtracting it from every past point indefinitely, and with the
 * account gone from the live list there'd be no Unhide button to stop it.
 */
export async function pruneHidden(account_ids: string[]): Promise<void> {
  if (account_ids.length === 0) return;
  try {
    await redis().hdel(HIDDEN_HASH, ...account_ids);
  } catch {
    // Best effort. The next disconnect or delete of the same account retries.
  }
}

type MarkableAccount = { account_id: string; balance: number | null; type: string; hidden?: boolean };
type MarkableInstitution = { accounts: MarkableAccount[] };

/**
 * Marks each account `hidden` and returns the net worth EXCLUDING them.
 *
 * Deliberately separate from computeNetWorth() rather than folded into it.
 * computeNetWorth is also called by the daily snapshot cron and the ingest
 * route, neither of which cares about hiding; if it read the hidden set, a
 * transient Redis error on a key unrelated to any balance would 500 the cron
 * and cost a permanent gap in the chart, since nothing retries it.
 */
export function applyHidden(institutions: MarkableInstitution[], hidden: HiddenMap): number {
  let visible = 0;
  for (const inst of institutions) {
    for (const a of inst.accounts) {
      a.hidden = hidden.has(a.account_id);
      if (a.hidden || a.balance == null) continue;
      visible += signedContribution(a.type, a.balance);
    }
  }
  return visible;
}
