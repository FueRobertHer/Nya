// lib/vanished.ts
//
// An account that disappears from an otherwise HEALTHY institution response.
//
// THE BUG THIS EXISTS FOR. When a bank closes an account, some institutions
// stop returning it rather than returning it at zero. `fetchInstitution` then
// succeeds, `error` stays null, and the account is simply absent. Every gate in
// the app reads that as a clean fetch, so recordSnapshot writes a total that no
// longer includes the account -- and lib/history.ts never rewrites a past date,
// so the drop is permanent and unexplained.
//
// lib/last-known.ts exists to stop exactly this, and its header names the
// danger: a dropped credit card RAISES net worth, so a broken connection reads
// as good news. But that protection operates at INSTITUTION granularity. One
// account vanishing from a healthy response falls straight through it, and the
// asymmetry is just as bad: a closed card silently improves net worth, a closed
// savings account silently worsens it.
//
// WHY A GRACE WINDOW RATHER THAN A PROMPT. A vanished account is ambiguous: it
// is either a real closure or a provider glitch that omitted one account. The
// honest response to an unresolved measurement is to record nothing, which is
// what closing the gate does. But holding forever needs a way out, and the
// lifecycle UI that would let a user answer "closed" or "still open" is not
// built yet (see issue #50). Holding indefinitely with no resolution would
// freeze the entire history on a condition nobody can clear.
//
// So absence is held as unconfirmed for CONFIRM_AFTER_DAYS, during which no
// snapshot is recorded, and after that it is accepted as a real closure and the
// gate reopens. A glitch resolves itself inside the window; a real closure costs
// a few days of gap rather than a permanent freeze. A gap is recoverable -- the
// estimated layer can span it -- and a wrong measurement written to the real
// layer is not.
//
// WHY ITS OWN RECORD rather than leaning on accounts:meta. rememberAccounts
// rewrites an Item's record wholesale from the current fetch, and
// /api/net-worth calls it UNCONDITIONALLY (deliberately: one broken bank should
// not stop the others' records staying fresh). So meta drops the vanished
// account on the very next load, and a comparison that trusted meta alone would
// detect the disappearance exactly once and then forget it. This record holds
// the account id itself, so detection survives.

import { redis, k } from './storage';
import { encrypt, decrypt } from './crypto';
import { rememberedIdsForItem, rememberedIdsByItem } from './last-known';

const VANISHED_HASH = k('accounts:vanished');

/**
 * How long an account may be absent before absence is accepted as closure.
 *
 * Three days rather than three fetches: the daily cron guarantees roughly one
 * observation per day whether or not the app is opened, so this is about three
 * independent confirmations, and it does not collapse to "three" when someone
 * refreshes the dashboard five times in a minute.
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

/** A fresh empty result. NOT a shared constant: callers receive these arrays,
 *  and one caller pushing onto a returned `unconfirmed` would corrupt the
 *  constant for every later call in the process. */
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

async function readRecord(item_id: string): Promise<VanishRecord> {
  try {
    const blob = await redis().hget<string>(VANISHED_HASH, item_id);
    if (!blob) return {};
    return parseRecord(await decrypt(blob));
  } catch {
    // Unreadable record: treat as empty. The cost is that a disappearance in
    // progress restarts its window, which delays acceptance rather than
    // recording a wrong total, so it fails in the safe direction.
    return {};
  }
}

/** Every Item's record in ONE read, for checkVanishedAll. Same tolerance as
 *  readRecord: one undecryptable field costs only that Item. */
async function readAllRecords(): Promise<Record<string, VanishRecord>> {
  let map: Record<string, string> | null;
  try {
    map = await redis().hgetall<Record<string, string>>(VANISHED_HASH);
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

async function writeRecord(item_id: string, record: VanishRecord): Promise<void> {
  try {
    if (Object.keys(record).length === 0) {
      await redis().hdel(VANISHED_HASH, item_id);
      return;
    }
    await redis().hset(VANISHED_HASH, { [item_id]: await encrypt(JSON.stringify(record)) });
  } catch {
    // Best effort. A lost write means the window restarts next run: later
    // acceptance, never a wrong measurement.
  }
}

/** Drops an Item's record, on disconnect. */
export async function forgetVanished(item_id: string): Promise<void> {
  try {
    await redis().hdel(VANISHED_HASH, item_id);
  } catch {
    // Best effort; a stale record is inert once no Item carries that id.
  }
}

/**
 * Compare one healthy institution's fresh account ids against what it is known
 * to own, and classify anything absent.
 *
 * Call ONLY for an institution whose fetch succeeded. A failed fetch returns no
 * accounts at all, and treating that as every account vanishing at once would
 * be nonsense -- lib/last-known.ts already owns that case.
 *
 * `remembered` is passed in rather than fetched here so a caller checking
 * several institutions pays one read for all of them instead of one each; see
 * checkVanishedAll.
 */
async function checkOne(
  item_id: string,
  freshIds: string[],
  remembered: string[],
  now: number,
  preloaded?: VanishRecord
): Promise<VanishedResult> {
  // A healthy institution that reports NOTHING is not every account closing at
  // once; it is an institution telling us nothing, which lib/last-known.ts
  // already owns the shape of. Flagging the whole list here would close the
  // global gate and then, three days later, accept every account as closed.
  //
  // Worse, it could never clear itself: rememberAccounts skips an institution
  // whose account list is empty (lib/last-known.ts:136), so accounts:meta is
  // never pruned, every id stays remembered, and the prune below never fires.
  // The record and its warning would persist on every load forever. This is the
  // one path where the settled-closure prune does not hold, so it is refused
  // before it can start.
  if (freshIds.length === 0) return empty();

  const record = preloaded ?? (await readRecord(item_id));

  // Both sources, because neither alone is enough: `remembered` is refreshed
  // from the latest healthy fetch and so forgets a vanished account almost
  // immediately, while the record holds only accounts already known to be
  // missing and so cannot notice a new one.
  const rememberedSet = new Set(remembered);
  const candidates = new Set([...remembered, ...Object.keys(record)]);
  if (candidates.size === 0) return empty();

  const fresh = new Set(freshIds);

  // ACCOUNT-ID ROTATION. lib/last-known.ts:320 names "its account_id changed at
  // reauth" as a real case in this codebase. When it happens, the healthy fetch
  // carries an all-new id set, so EVERY remembered id reads as vanished. One
  // gate covers the whole snapshot, so without this the routine act of
  // reconnecting a bank would freeze history for every institution -- and for
  // manual accounts -- for three days.
  //
  // Accounts do not all close at the same instant while new ones appear in the
  // same response, so an all-miss against a non-empty fresh list is a
  // replacement of the id set, not a mass closure. Clear the record and report
  // nothing.
  //
  // If the heuristic is ever wrong, a genuine simultaneous closure of every
  // account goes undetected, which is exactly the behaviour before this file
  // existed. It trades a case that cannot be distinguished anyway for one that
  // happens routinely.
  if (remembered.length > 0 && !remembered.some((id) => fresh.has(id))) {
    if (Object.keys(record).length > 0) await writeRecord(item_id, {});
    return empty();
  }

  const nowIso = new Date(now).toISOString();
  const cutoff = now - CONFIRM_AFTER_DAYS * 24 * 60 * 60 * 1000;

  const unconfirmed: string[] = [];
  const accepted: string[] = [];
  let changed = false;

  for (const id of candidates) {
    if (fresh.has(id)) {
      // Present again. A glitch, or an account that came back: forget it, so a
      // future disappearance starts a fresh window rather than inheriting an
      // old one and being accepted instantly.
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

    // Settled: absent past the window AND no longer in the institution's
    // remembered list, which rememberAccounts prunes once the gate reopens.
    // Dropping it here is what stops the record growing without bound and
    // re-reporting the same closure on every load forever. It is NOT dropped
    // while still remembered, or the next run would rediscover it with a fresh
    // window and the pair would cycle indefinitely.
    if (!rememberedSet.has(id)) {
      delete record[id];
      changed = true;
    }
  }

  if (changed) await writeRecord(item_id, record);
  return { unconfirmed, accepted };
}

/** Single-institution check. Prefer checkVanishedAll when checking several. */
export async function checkVanished(
  item_id: string,
  freshIds: string[],
  now: number = Date.now()
): Promise<VanishedResult> {
  return checkOne(item_id, freshIds, await rememberedIdsForItem(item_id), now);
}

/**
 * Check every healthy institution in one pass.
 *
 * Exists for the round trips. Both of the reads this needs are single hashes
 * keyed by item_id, so both are read whole, ONCE, regardless of how many
 * institutions are linked: two reads for six institutions rather than twelve, on
 * a path the repo has already had to cut latency out of once (see the `eager()`
 * comment in app/api/net-worth/route.ts).
 *
 * The per-institution `checkVanished` still exists for callers with one Item,
 * and pays two reads, which is the same thing at N=1.
 */
export async function checkVanishedAll(
  institutions: { item_id: string; accounts: { account_id: string }[] }[],
  now: number = Date.now()
): Promise<Record<string, VanishedResult>> {
  if (institutions.length === 0) return {};
  return applyVanished(institutions, await loadVanishedInputs(), now);
}

/** Everything the comparison reads, so it can be fetched before the account
 *  lists it will be compared against exist. */
export type VanishedInputs = {
  remembered: Record<string, string[]>;
  records: Record<string, VanishRecord>;
};

/**
 * Issue both reads. Depends only on what is already in Redis, never on the
 * Plaid fetch, so a caller can start this and the fan-out together and pay for
 * whichever is slower rather than for both in series.
 */
export async function loadVanishedInputs(): Promise<VanishedInputs> {
  const [remembered, records] = await Promise.all([rememberedIdsByItem(), readAllRecords()]);
  return { remembered, records };
}

/** The comparison itself, against already-loaded inputs. Writes happen here:
 *  only an Item whose record actually changed costs a write. */
export async function applyVanished(
  institutions: { item_id: string; accounts: { account_id: string }[] }[],
  inputs: VanishedInputs,
  now: number = Date.now()
): Promise<Record<string, VanishedResult>> {
  const out: Record<string, VanishedResult> = {};

  await Promise.all(
    institutions.map(async (inst) => {
      const res = await checkOne(
        inst.item_id,
        inst.accounts.map((a) => a.account_id),
        inputs.remembered[inst.item_id] ?? [],
        now,
        inputs.records[inst.item_id] ?? {}
      );
      if (res.unconfirmed.length > 0 || res.accepted.length > 0) out[inst.item_id] = res;
    })
  );

  return out;
}
