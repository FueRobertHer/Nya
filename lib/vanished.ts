// lib/vanished.ts
//
// An account that disappears from an otherwise HEALTHY institution response.
//
// THE BUG THIS EXISTS FOR. When a bank closes an account, some institutions stop
// returning it rather than returning it at zero. `fetchInstitution` then
// succeeds, `error` stays null, and the account is simply absent. Every gate
// reads that as a clean fetch, so recordSnapshot writes a total without the
// account, and lib/history.ts never rewrites a past date: the drop is permanent
// and unexplained.
//
// lib/last-known.ts stops this at INSTITUTION granularity; one account vanishing
// from a healthy response falls straight through it. The asymmetry is as bad: a
// closed card silently improves net worth, a closed savings account silently
// worsens it.
//
// WHY A GRACE WINDOW RATHER THAN A PROMPT. A vanished account is either a real
// closure or a provider glitch, and the honest response to an unresolved
// measurement is to record nothing (close the gate). Holding forever needs a way
// out, and the lifecycle UI that would let a user answer "closed" or "still open"
// isn't built (issue #50). So absence is held as unconfirmed for
// CONFIRM_AFTER_DAYS, during which no snapshot is recorded, then accepted as a
// real closure and the gate reopens. A glitch resolves inside the window; a real
// closure costs a few days of gap, which the estimated layer can span, where a
// wrong measurement in the real layer is permanent.
//
// WHY ITS OWN RECORD rather than accounts:meta. rememberAccounts rewrites an
// Item's record wholesale from the current fetch, unconditionally (one broken
// bank shouldn't stop the others staying fresh), so meta drops the vanished
// account on the very next load and a comparison trusting meta alone would detect
// the disappearance once and forget it. This record holds the id itself.

import { redis, kc } from './storage';
import type { Ctx } from './containers';
import { encrypt, decrypt } from './crypto';
import { rememberedIdsForItem, rememberedIdsByItem } from './last-known';
import { getLinks, resolveId, type Link } from './link-core';

const VANISHED_HASH = (ctx: Ctx) => kc(ctx, 'accounts:vanished');

/**
 * How long an account may be absent before absence is accepted as closure.
 *
 * Days rather than fetches: the daily cron guarantees roughly one observation a
 * day whether or not the app is opened, and it doesn't collapse when someone
 * refreshes five times in a minute.
 */
const CONFIRM_AFTER_DAYS = 3;

/** account_id -> ISO timestamp it was first seen missing. */
type VanishRecord = Record<string, string>;

export type VanishedResult = {
  /** Absent, but not long enough to be sure. These close the snapshot gate. */
  unconfirmed: string[];
  /** Absent long enough to accept as closed. These do NOT close the gate. */
  accepted: string[];
};

/** A fresh empty result, NOT a shared constant: a caller pushing onto a returned
 *  array would corrupt it for every later call. */
const empty = (): VanishedResult => ({ unconfirmed: [], accepted: [] });

/** Decode one already-decrypted record, tolerating anything that is not a plain
 *  object. */
function parseRecord(plain: string): VanishRecord {
  try {
    const parsed = JSON.parse(plain) as VanishRecord;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readRecord(ctx: Ctx, item_id: string): Promise<VanishRecord> {
  try {
    const blob = await redis().hget<string>(VANISHED_HASH(ctx), item_id);
    if (!blob) return {};
    return parseRecord(await decrypt(blob));
  } catch {
    // Unreadable record: treat as empty. A disappearance in progress restarts its
    // window, delaying acceptance rather than recording a wrong total.
    return {};
  }
}

/** Every Item's record in ONE read, for checkVanishedAll. Same tolerance as
 *  readRecord: one undecryptable field costs only that Item. */
async function readAllRecords(ctx: Ctx): Promise<Record<string, VanishRecord>> {
  let map: Record<string, string> | null;
  try {
    map = await redis().hgetall<Record<string, string>>(VANISHED_HASH(ctx));
  } catch {
    return {};
  }
  if (!map) return {};

  const out: Record<string, VanishRecord> = {};
  await Promise.all(
    Object.entries(map).map(async ([item_id, blob]) => {
      try {
        out[item_id] = parseRecord(await decrypt(blob));
      } catch {
        out[item_id] = {};
      }
    })
  );
  return out;
}

async function writeRecord(ctx: Ctx, item_id: string, record: VanishRecord): Promise<void> {
  try {
    if (Object.keys(record).length === 0) {
      await redis().hdel(VANISHED_HASH(ctx), item_id);
      return;
    }
    await redis().hset(VANISHED_HASH(ctx), { [item_id]: await encrypt(JSON.stringify(record)) });
  } catch {
    // Best effort. A lost write means the window restarts next run: later
    // acceptance, never a wrong measurement.
  }
}

/** The ids an Item's record currently holds as missing. */
export async function vanishedIdsForItem(ctx: Ctx, item_id: string): Promise<string[]> {
  return Object.keys(await readRecord(ctx, item_id));
}

/**
 * Drops just these ids from an Item's record: accounts the user removed from the
 * Item themselves (Link's account selection), whose absence is a known choice
 * rather than something to wait out. Without this a removal would pause every
 * snapshot for CONFIRM_AFTER_DAYS.
 */
export async function forgetVanishedIds(ctx: Ctx, item_id: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const record = await readRecord(ctx, item_id);
  let changed = false;
  for (const id of ids) {
    if (id in record) {
      delete record[id];
      changed = true;
    }
  }
  if (changed) await writeRecord(ctx, item_id, record);
}

/** Drops an Item's record, on disconnect. */
export async function forgetVanished(ctx: Ctx, item_id: string): Promise<void> {
  try {
    await redis().hdel(VANISHED_HASH(ctx), item_id);
  } catch {
    // Best effort; a stale record is inert once no Item carries that id.
  }
}

/**
 * Compare one healthy institution's fresh account ids against what it is known
 * to own, and classify anything absent.
 *
 * Call ONLY for an institution whose fetch succeeded: a failed fetch returns no
 * accounts, which lib/last-known.ts owns. `remembered` is passed in so a caller
 * checking several institutions pays one read for all (see checkVanishedAll).
 */
async function checkOne(ctx: Ctx, 
  item_id: string,
  freshIds: string[],
  remembered: string[],
  now: number,
  preloaded?: VanishRecord
): Promise<VanishedResult> {
  // A healthy institution that reports NOTHING isn't every account closing at
  // once; it is an institution telling us nothing (lib/last-known.ts owns that
  // shape). Flagging the whole list would close the global gate, and it could
  // never clear itself: rememberAccounts skips an institution with an empty list,
  // so accounts:meta is never pruned, every id stays remembered, and the prune
  // below never fires. The one path where the settled-closure prune doesn't
  // hold, so it is refused before it starts.
  if (freshIds.length === 0) return empty();

  const record = preloaded ?? (await readRecord(ctx, item_id));

  // Both sources, because neither alone is enough: `remembered` is refreshed
  // from the latest healthy fetch and forgets a vanished account almost
  // immediately, while the record holds only accounts already known missing and
  // can't notice a new one.
  const rememberedSet = new Set(remembered);
  const candidates = new Set([...remembered, ...Object.keys(record)]);
  if (candidates.size === 0) return empty();

  const fresh = new Set(freshIds);

  // ACCOUNT-ID ROTATION. "Its account_id changed at reauth" is a real case (see
  // lib/last-known.ts). The healthy fetch then carries an all-new id set, so
  // EVERY remembered id reads as vanished, and since one gate covers the whole
  // snapshot, reconnecting a bank would freeze history for every institution
  // (and manual accounts) for three days.
  //
  // Accounts don't all close at the same instant while new ones appear in the
  // same response, so an all-miss against a non-empty fresh list is a
  // replacement of the id set, not a mass closure: clear the record, report
  // nothing. If wrong, a genuine simultaneous closure of every account goes
  // undetected, which is the behaviour before this file existed.
  if (remembered.length > 0 && !remembered.some((id) => fresh.has(id))) {
    if (Object.keys(record).length > 0) await writeRecord(ctx, item_id, {});
    return empty();
  }

  const nowIso = new Date(now).toISOString();
  const cutoff = now - CONFIRM_AFTER_DAYS * 24 * 60 * 60 * 1000;

  const unconfirmed: string[] = [];
  const accepted: string[] = [];
  let changed = false;

  for (const id of candidates) {
    if (fresh.has(id)) {
      // Present again (a glitch, or an account that came back): forget it, so a
      // future disappearance starts a fresh window instead of being accepted
      // instantly.
      if (id in record) {
        delete record[id];
        changed = true;
      }
      continue;
    }

    if (!(id in record)) {
      record[id] = nowIso;
      changed = true;
    }

    const since = Date.parse(record[id]);
    // An unparseable timestamp is treated as "just now" rather than as ancient,
    // so a corrupt entry cannot wave a disappearance through unexamined.
    if (!Number.isFinite(since) || since > cutoff) {
      unconfirmed.push(id);
      continue;
    }

    accepted.push(id);

    // Settled: absent past the window AND no longer remembered (rememberAccounts
    // prunes it once the gate reopens). Dropping it stops the record growing and
    // re-reporting the same closure forever. Not dropped while still remembered,
    // or the next run would rediscover it with a fresh window and cycle.
    if (!rememberedSet.has(id)) {
      delete record[id];
      changed = true;
    }
  }

  if (changed) await writeRecord(ctx, item_id, record);
  return { unconfirmed, accepted };
}

/** Single-institution check. Prefer checkVanishedAll when checking several. */
export async function checkVanished(ctx: Ctx, 
  item_id: string,
  freshIds: string[],
  now: number = Date.now()
): Promise<VanishedResult> {
  return checkOne(ctx, item_id, freshIds, await rememberedIdsForItem(ctx, item_id), now);
}

/**
 * Check every healthy institution in one pass. Both reads this needs are whole
 * hashes keyed by item_id, so they are read ONCE regardless of how many
 * institutions are linked, on a path already tuned for latency (see `eager()` in
 * app/api/net-worth/route.ts). checkVanished pays two reads, the same at N=1.
 */
export async function checkVanishedAll(ctx: Ctx, 
  institutions: { item_id: string; accounts: { account_id: string }[] }[],
  now: number = Date.now()
): Promise<Record<string, VanishedResult>> {
  if (institutions.length === 0) return {};
  return applyVanished(ctx, institutions, await loadVanishedInputs(ctx), now);
}

/** Everything the comparison reads, so it can be fetched before the account
 *  lists it will be compared against exist. */
export type VanishedInputs = {
  remembered: Record<string, string[]>;
  records: Record<string, VanishRecord>;
  /** Account links (lib/links.ts). An id the user linked to an account that
   *  is present is not missing: the account is there under its new id. */
  links?: Map<string, Link>;
};

/**
 * Issue both reads. Depends only on what is already in Redis, never on the Plaid
 * fetch, so a caller can run this alongside the fan-out and pay for whichever
 * is slower.
 */
export async function loadVanishedInputs(ctx: Ctx): Promise<VanishedInputs> {
  const [remembered, records, links] = await Promise.all([
    rememberedIdsByItem(ctx),
    readAllRecords(ctx),
    // Unreadable links mean a linked id reads as missing and pauses snapshots:
    // the safe direction, the same as before links existed.
    getLinks(ctx).catch(() => new Map<string, Link>()),
  ]);
  return { remembered, records, links };
}

/** The comparison itself, against already-loaded inputs. Writes happen here:
 *  only an Item whose record actually changed costs a write. */
export async function applyVanished(ctx: Ctx, 
  institutions: { item_id: string; accounts: { account_id: string }[] }[],
  inputs: VanishedInputs,
  now: number = Date.now()
): Promise<Record<string, VanishedResult>> {
  const out: Record<string, VanishedResult> = {};

  await Promise.all(
    institutions.map(async (inst) => {
      const fresh = inst.accounts.map((a) => a.account_id);
      const freshSet = new Set(fresh);
      // Earlier ids of accounts that are here now count as here.
      const linkedHere = [...(inputs.links ?? new Map()).keys()].filter(
        (old) => !freshSet.has(old) && freshSet.has(resolveId(old, inputs.links!))
      );
      const res = await checkOne(ctx, 
        inst.item_id,
        [...fresh, ...linkedHere],
        inputs.remembered[inst.item_id] ?? [],
        now,
        inputs.records[inst.item_id] ?? {}
      );
      if (res.unconfirmed.length > 0 || res.accepted.length > 0) out[inst.item_id] = res;
    })
  );

  return out;
}
