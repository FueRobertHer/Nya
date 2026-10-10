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
// A PROMPT, AND A GRACE WINDOW AS THE WAY OUT. A vanished account is either a
// real closure or a provider glitch, and the honest response to an unresolved
// measurement is to record nothing (close the gate). So absence is held as
// unconfirmed, no snapshot is recorded, and the person is asked (#50,
// lib/lifecycle-questions.ts): Closed, Still open, or Stop tracking. An answer
// settles it: an end (lib/lifecycle.ts) holds nothing, and "Still open" holds
// while the account stays missing, for STILL_OPEN_HOLD_DAYS from the answer,
// when it is asked about again with a grace window of its own. Holding
// forever needs a way out, so an account nobody answers about for
// CONFIRM_AFTER_DAYS is recorded as an ASSUMED closure (assumeClosed), which
// the person can correct, and the gate reopens. A glitch resolves inside the window (and an assumption it outlives
// is lifted when the account comes back); a real closure costs a few days of
// gap, which the estimated layer can span, where a wrong measurement in the
// real layer is permanent. If the answers can't be read, nothing is assumed:
// every missing account stays held, the safe direction.
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
import { getLinks, resolveId, effectiveLinks, type Link } from './link-core';
import { readLifecycleEntries, effectiveLifecycle, answersFrom, liftAssumedClosures, type LifecycleAnswers, type LifecycleView } from './lifecycle';
import { assumeClosed } from './lifecycle-questions';
import { clearCaches } from './cache';

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
  /** Absent and unanswered within the window, answered "Still open", or past
   *  the window with an assumed closure that couldn't be recorded. These
   *  close the snapshot gate, and the dashboard holds them at their last
   *  known balance with a question (lib/lifecycle-questions.ts). */
  unconfirmed: string[];
  /** Absent past the window with no answer, and now recorded as an assumed
   *  closure (lib/lifecycle.ts). These do NOT close the gate. */
  accepted: string[];
  /** Assumed closed before, and in this healthy answer again: the assumption
   *  was lifted (stored ids). Present only when there are some. */
  lifted?: string[];
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

/**
 * The ids an Item's record first saw missing at or after `since` (an ISO time).
 * An id missing from before then went missing on its own, not through whatever
 * the caller is accounting for, and keeps its grace window. An unparseable
 * `since`, or entry, matches nothing.
 */
export async function vanishedSince(ctx: Ctx, item_id: string, since: string): Promise<string[]> {
  const from = Date.parse(since);
  if (!Number.isFinite(from)) return [];
  const record = await readRecord(ctx, item_id);
  return Object.keys(record).filter((id) => {
    const at = Date.parse(record[id]);
    return Number.isFinite(at) && at >= from;
  });
}

/**
 * The ids an Item's record first saw missing BEFORE `since` (an ISO time), or
 * with a time that can't be read: accounts that went missing on their own,
 * held for the person's answer (lib/lifecycle-questions.ts) and kept in the
 * Item's remembered record meanwhile, so a caller accounting for a change of
 * its own (the account picker) must not take them for its doing. An
 * unparseable `since` takes every id.
 */
export async function vanishedBefore(ctx: Ctx, item_id: string, since: string): Promise<string[]> {
  const from = Date.parse(since);
  const record = await readRecord(ctx, item_id);
  return Object.keys(record).filter((id) => {
    const at = Date.parse(record[id]);
    return !Number.isFinite(from) || !Number.isFinite(at) || at < from;
  });
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

/**
 * The ids missing from a healthy institution's answer that have not been
 * missing long enough to accept as closed: still the person's accounts,
 * pending confirmation, for allocation over time, which marks the days they
 * are missing from rather than drawing them as whole. Read only. An entry
 * whose time can't be read counts as pending, as checkOne treats it; a
 * record that can't be read holds nothing.
 */
export async function pendingVanishedIds(ctx: Ctx, now: number = Date.now()): Promise<Set<string>> {
  const records = await readAllRecords(ctx);
  const cutoff = now - CONFIRM_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const out = new Set<string>();
  for (const record of Object.values(records)) {
    for (const [id, at] of Object.entries(record)) {
      const since = Date.parse(at);
      if (!Number.isFinite(since) || since > cutoff) out.add(id);
    }
  }
  return out;
}

/** Drops an Item's record, on disconnect. */
export async function forgetVanished(ctx: Ctx, item_id: string): Promise<void> {
  try {
    await redis().hdel(VANISHED_HASH(ctx), item_id);
  } catch {
    // Best effort; a stale record is inert once no Item carries that id.
  }
}

/** Records assumed closures for the ids given (ids missing past the window,
 *  with when each was first seen missing), returning the ids that now have
 *  an answer. lib/lifecycle-questions.ts assumeClosed, in production. */
type Assume = (item_id: string, missing: { account_id: string; missing_since: string }[]) => Promise<Set<string>>;

/**
 * Compare one healthy institution's fresh account ids against what it is known
 * to own, and classify anything absent.
 *
 * Call ONLY for an institution whose fetch succeeded: a failed fetch returns no
 * accounts, which lib/last-known.ts owns. `remembered` is passed in so a caller
 * checking several institutions pays one read for all (see checkVanishedAll).
 *
 * `answers` are the person's (lib/lifecycle.ts): an id with an end is settled
 * and holds nothing; one they said is still open is held, and is a candidate
 * even once its record and the remembered list have both forgotten it; null
 * says they couldn't be read, and then nothing is assumed (every missing id
 * stays unconfirmed). `assume` records the assumed closures (see THE WAY OUT
 * in lib/lifecycle-questions.ts).
 */
async function checkOne(ctx: Ctx,
  item_id: string,
  freshIds: string[],
  remembered: string[],
  now: number,
  preloaded: VanishRecord | undefined,
  answers: LifecycleAnswers | null,
  assume: Assume
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
  const stillOpen = answers?.stillOpen.get(item_id) ?? new Set<string>();

  // Both sources, because neither alone is enough: `remembered` is refreshed
  // from the latest healthy fetch and forgets a vanished account almost
  // immediately, while the record holds only accounts already known missing and
  // can't notice a new one. And the accounts the person said are still open:
  // held while missing, however long since both forgot them.
  const rememberedSet = new Set(remembered);
  const candidates = new Set([...remembered, ...Object.keys(record), ...stillOpen]);
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
  const pastWindow: string[] = [];
  let changed = false;

  // Settled: absent AND no longer remembered (rememberAccounts prunes it once
  // the gate reopens). Dropping it stops the record growing and re-reporting
  // the same closure forever. Not dropped while still remembered, or the next
  // run would rediscover it with a fresh window and cycle.
  const settle = (id: string) => {
    if (!rememberedSet.has(id) && id in record) {
      delete record[id];
      changed = true;
    }
  };

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

    // The person said it ended (or an assumed closure stands): absent is what
    // it should be, and it holds nothing.
    if (answers?.ended.has(id)) {
      settle(id);
      continue;
    }

    if (!(id in record)) {
      record[id] = nowIso;
      changed = true;
    }

    const since = Date.parse(record[id]);
    // A "Still open" that has lapsed asks again, with a window from when it
    // lapsed (lib/lifecycle.ts STILL_OPEN_HOLD_DAYS).
    const reask = answers?.reaskFrom.get(id);
    const start = reask !== undefined ? Math.max(since, Date.parse(reask)) : since;
    // An unparseable timestamp is treated as "just now" rather than as ancient,
    // so a corrupt entry cannot wave a disappearance through unexamined. Held
    // too: "Still open", whatever the window says, and anything while the
    // answers can't be read, since one may be "Still open".
    if (!Number.isFinite(start) || start > cutoff || stillOpen.has(id) || answers === null) {
      unconfirmed.push(id);
      continue;
    }
    pastWindow.push(id);
  }

  // Past the window with no answer: recorded as assumed closures, the way out
  // (lib/lifecycle-questions.ts). One whose closure couldn't be recorded is
  // never accepted silently: it stays held, and is tried again next time.
  let assumed = new Set<string>();
  if (pastWindow.length > 0) {
    try {
      assumed = await assume(
        item_id,
        pastWindow.map((id) => ({ account_id: id, missing_since: record[id] }))
      );
    } catch (err) {
      console.error('vanished: assumed closures could not be recorded, so the accounts stay held', err instanceof Error ? err.name : typeof err);
    }
  }
  const accepted: string[] = [];
  for (const id of pastWindow) {
    if (!assumed.has(id)) {
      unconfirmed.push(id);
      continue;
    }
    accepted.push(id);
    settle(id);
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
  const [remembered, inputs] = await Promise.all([rememberedIdsForItem(ctx, item_id), loadVanishedInputs(ctx)]);
  return checkOne(ctx, item_id, freshIds, remembered, now, undefined, answersAt(inputs, now), assumeWith(ctx, inputs, now));
}

/**
 * Check every healthy institution in one pass. The reads this needs are whole
 * hashes, so they are read ONCE regardless of how many institutions are
 * linked, on a path already tuned for latency (see `eager()` in
 * app/api/net-worth/route.ts).
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
  /** What the person said about their accounts (lib/lifecycle.ts), through
   *  the links that apply; null when it couldn't be read, and then nothing is
   *  assumed closed. Absent reads as nothing said. */
  lifecycle?: LifecycleView | null;
};

/** The answers as they stand at `now` (a "Still open" lapses: answersFrom). */
function answersAt(inputs: VanishedInputs, now: number): LifecycleAnswers | null {
  if (inputs.lifecycle === null) return null;
  if (inputs.lifecycle === undefined) return { ended: new Set(), stillOpen: new Map(), reaskFrom: new Map(), assumed: new Map() };
  return answersFrom(inputs.lifecycle, now);
}

/**
 * Issue the reads. Depends only on what is already in Redis, never on the
 * Plaid fetch, so a caller can run this alongside the fan-out and pay for
 * whichever is slower.
 */
export async function loadVanishedInputs(ctx: Ctx): Promise<VanishedInputs> {
  const [remembered, records, links, entries] = await Promise.all([
    rememberedIdsByItem(ctx),
    readAllRecords(ctx),
    // Unreadable links mean a linked id reads as missing and pauses snapshots:
    // the safe direction, the same as before links existed.
    getLinks(ctx).catch(() => new Map<string, Link>()),
    // Unreadable answers hold every missing account (see the header).
    readLifecycleEntries(ctx).catch((err) => {
      console.error('vanished: the answers about missing accounts could not be read, so nothing is assumed closed', err instanceof Error ? err.name : typeof err);
      return null;
    }),
  ]);
  // A link whose earlier id is live again joins two live accounts: one's end
  // must not settle the other's absence (lib/link-core.ts effectiveLinks).
  const live = new Set(Object.values(remembered).flat());
  const lifecycle = entries === null ? null : effectiveLifecycle(entries, effectiveLinks(links, live));
  return { remembered, records, links, lifecycle };
}

/** The assumed-closure recorder for these inputs. */
function assumeWith(ctx: Ctx, inputs: VanishedInputs, now: number): Assume {
  return (item_id, missing) => assumeClosed(ctx, item_id, missing, inputs.links ?? new Map(), now);
}

/** The comparison itself, against already-loaded inputs. Writes happen here:
 *  only an Item whose record actually changed costs a write, and an assumed
 *  closure is recorded, or lifted when its account came back. */
export async function applyVanished(ctx: Ctx, 
  institutions: { item_id: string; accounts: { account_id: string }[] }[],
  inputs: VanishedInputs,
  now: number = Date.now()
): Promise<Record<string, VanishedResult>> {
  const out: Record<string, VanishedResult> = {};
  const answers = answersAt(inputs, now);
  const assume = assumeWith(ctx, inputs, now);

  await Promise.all(
    institutions.map(async (inst) => {
      const fresh = inst.accounts.map((a) => a.account_id);
      const freshSet = new Set(fresh);
      // Earlier ids of accounts that are here now count as here.
      const linkedHere = [...(inputs.links ?? new Map()).keys()].filter(
        (old) => !freshSet.has(old) && freshSet.has(resolveId(old, inputs.links!))
      );
      // An account assumed closed that is in a healthy answer again: the
      // assumption was wrong, and is lifted (lib/lifecycle.ts). An empty
      // answer says nothing (see checkOne).
      const lift = new Set<string>();
      if (fresh.length > 0) {
        for (const id of [...fresh, ...linkedHere]) {
          const stored = answers?.assumed.get(id);
          if (stored) lift.add(stored);
        }
      }
      const lifted = lift.size > 0 ? await liftAssumedClosures(ctx, lift, now) : [];
      if (lifted.length > 0) {
        console.warn(`vanished: ${lifted.length} account(s) assumed closed came back, so the assumption was lifted`);
        // The dashboard's cached payload left them out.
        await clearCaches(ctx).catch(() => {});
      }
      const res = await checkOne(ctx, 
        inst.item_id,
        [...fresh, ...linkedHere],
        inputs.remembered[inst.item_id] ?? [],
        now,
        inputs.records[inst.item_id] ?? {},
        answers,
        assume
      );
      if (lifted.length > 0) res.lifted = lifted;
      if (res.unconfirmed.length > 0 || res.accepted.length > 0 || lifted.length > 0) out[inst.item_id] = res;
    })
  );

  return out;
}
