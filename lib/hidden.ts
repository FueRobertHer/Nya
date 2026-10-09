// lib/hidden.ts
//
// Hidden accounts: "keep syncing this, just don't count it" (a joint account, a
// business card, an old account kept for records). Unlike disconnecting or
// deleting, nothing is discarded: the account is still fetched, stored and
// snapshotted, and unhiding restores it complete.
//
// THE GOVERNING PRINCIPLE: hiding never changes storage; it is applied on read.
// recordSnapshot() keeps writing the true total and the full per-account balance
// map regardless of what's hidden (see lib/history.ts). Two things follow:
//
//   1. Unhiding is exactly symmetric, because nothing was removed. (Forgetting a
//      hidden account is the one exception, at the user's choice: it folds the
//      account out of the stored totals, and unhiding is refused while that
//      runs. See lib/links.ts forgetEarlierAccount.)
//   2. A failed hidden read can only display a wrong number, never write one.
//      Contrast lib/manual.ts, where a bad read could poison a permanent record.
//
// Stored as a Redis hash (field = account_id), not a SET: HSET/HDEL are atomic
// single commands, so there's no read-modify-write window (as in lib/storage.ts),
// and the value can be encrypted, which a SET would forbid (encrypt() uses a
// random IV, so SREM by value could never match its own output).
//
// The stored value carries the account's TYPE, which is load-bearing: subtracting
// a hidden account from a past net-worth total needs to know whether its balance
// added or subtracted, and the per-account history map stores raw balances only.
// Resolving the type from the live account list would fail exactly when an
// institution is unhealthy (fetchInstitution() returns `accounts: []` on
// ITEM_LOGIN_REQUIRED), so the series would jump by the card's balance while the
// reauth banner was up, then jump back.

import { redis, kc } from './storage';
import type { Ctx } from './containers';
import { encrypt, decrypt } from './crypto';
import { signedContribution } from './balance';

const HIDDEN_HASH = (ctx: Ctx) => kc(ctx, 'hidden:accounts');

export type HiddenAccount = {
  type: string;
  hidden_at: string; // ISO
  /** Set while the account is being forgotten: the random tag its progress is
   *  kept under (lib/history.ts foldHiddenAccount). Held here, encrypted, until
   *  the entry is dropped so a retry reuses it. While set the account can't be
   *  unhidden: part of its history may already be folded out of the totals. */
  forget_tag?: string;
};

/** account_id -> what we need to subtract it from a total. */
export type HiddenMap = Map<string, HiddenAccount>;

/**
 * Every hidden account. Throws on a Redis error or if any field fails to decrypt
 * or parse: returning an empty map would put data back on screen that was
 * deliberately taken off, the one outcome hiding must never produce.
 */
export async function getHiddenAccounts(ctx: Ctx): Promise<HiddenMap> {
  const map = await redis().hgetall<Record<string, string>>(HIDDEN_HASH(ctx));
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
          ...(typeof parsed.forget_tag === 'string' ? { forget_tag: parsed.forget_tag } : {}),
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
export async function setAccountHidden(ctx: Ctx, 
  account_id: string,
  type: string,
  hidden: boolean
): Promise<void> {
  if (!hidden) {
    await redis().hdel(HIDDEN_HASH(ctx), account_id);
    return;
  }
  // A forget part way through keeps its mark through a re-hide: without it
  // the account could be unhidden with half its history folded away.
  let forget_tag: string | undefined;
  const existing = await redis().hget<string>(HIDDEN_HASH(ctx), account_id);
  if (existing) {
    try {
      const parsed = JSON.parse(await decrypt(existing)) as Partial<HiddenAccount>;
      if (typeof parsed.forget_tag === 'string') forget_tag = parsed.forget_tag;
    } catch (err) {
      throw new Error(`Hidden account ${account_id} could not be read`, { cause: err });
    }
  }
  const value: HiddenAccount = { type, hidden_at: new Date().toISOString(), ...(forget_tag ? { forget_tag } : {}) };
  await redis().hset(HIDDEN_HASH(ctx), { [account_id]: await encrypt(JSON.stringify(value)) });
}

/** Marks a hidden account as being forgotten, with the tag its progress is
 *  kept under (see HiddenAccount.forget_tag). */
export async function markForgetting(ctx: Ctx, account_id: string, entry: HiddenAccount, forget_tag: string): Promise<void> {
  const value: HiddenAccount = { ...entry, forget_tag };
  await redis().hset(HIDDEN_HASH(ctx), { [account_id]: await encrypt(JSON.stringify(value)) });
}

/**
 * Drops hidden entries for accounts that no longer exist (a manual account
 * deleted; a disconnected institution's hidden accounts are kept, see
 * lib/links.ts). Otherwise the historical per-account maps would keep a deleted
 * account's balances subtracted from every past point, with no Unhide button
 * left to stop it.
 */
export async function pruneHidden(ctx: Ctx, account_ids: string[]): Promise<void> {
  if (account_ids.length === 0) return;
  try {
    await redis().hdel(HIDDEN_HASH(ctx), ...account_ids);
  } catch {
    // Best effort. The next disconnect or delete of the same account retries.
  }
}

type MarkableAccount = { account_id: string; balance: number | null; type: string; hidden?: boolean };
type MarkableInstitution = { accounts: MarkableAccount[]; unshown_accounts?: { account_id: string }[] };

/**
 * Marks each account `hidden` and returns the net worth EXCLUDING them. The
 * accounts a broken institution can't show, which its connection health names
 * (lib/last-known.ts), leave the hidden ones out, as every total does.
 *
 * Separate from computeNetWorth(), which the daily snapshot cron and the ingest
 * route also call: if it read the hidden set, a transient Redis error on an
 * unrelated key would 500 the cron and cost a permanent gap in the chart.
 */
export function applyHidden(institutions: MarkableInstitution[], hidden: HiddenMap): number {
  let visible = 0;
  for (const inst of institutions) {
    for (const a of inst.accounts) {
      a.hidden = hidden.has(a.account_id);
      if (a.hidden || a.balance == null) continue;
      visible += signedContribution(a.type, a.balance);
    }
    if (inst.unshown_accounts) {
      const shown = inst.unshown_accounts.filter((a) => !hidden.has(a.account_id));
      if (shown.length > 0) inst.unshown_accounts = shown;
      else delete inst.unshown_accounts;
    }
  }
  return visible;
}
