// lib/links.ts
//
// Linking an account's history across a reconnect.
//
// Plaid can issue new account ids for the same accounts, and a disconnect and
// re-add always does (a new Item). Everything in Nya is keyed by account id, so
// the old id's history is orphaned: not deleted, just unreachable. This module
// lets each user say "this is the same account" and lets the readers that
// matter follow that.
//
// Rules:
//
// 1. STORED DATA IS NEVER REWRITTEN. A link is one entry, old id -> new id, in
//    its own hash. Readers resolve it; unlinking deletes the entry and the
//    split view comes straight back.
// 2. THE USER DECIDES. Suggestions come with evidence; nothing is linked
//    automatically. Every key goes through kc(), so links, suggestions and the
//    directory only ever involve one container's accounts.
// 3. LINKS FOLLOW HISTORY, NOT TRANSACTIONS. A disconnect deletes the old Item's
//    transaction stores, so what survives under an old id is its balance history.
// 4. MANUAL ACCOUNTS ARE NEVER LINKED. A recreated manual account must not
//    inherit a deleted one's series (lib/manual.ts).
//
// The DIRECTORY records every account seen (provider, institution id, name, mask,
// type), kept past a disconnect for as long as the balance history is, so
// someone returning months later sees "Chase Checking ••4821", not an anonymous
// series. There are two ways to link: the card OFFERS pairs (suggestLinks), and
// the user can link any earlier account BY HAND (manualChoices), with no time
// limit and even after declining an offer, since a declined or missed match must
// stay fixable.

import { redis, kc, getItems } from './storage';
import type { Ctx } from './containers';
import { encrypt, decrypt } from './crypto';
import { isManualId } from './manual';
import { measuredAccountHistoryKeys, forgetAccountBalances, foldHiddenAccount, dropFoldProgress } from './history';
import { forgetAccountHoldings, forgetRecentHoldings } from './holdings-history';
import { forgetCarried, pruneOrphanOverrides } from './overrides';
import { forgetCarriedAnnotations } from './txn-annotations';
import { storedAccountIds } from './transactions';
import { storedInvestmentAccountIds } from './invstore';
import { isOwedType, isInvestmentType } from './balance';
import { getHiddenAccounts, setAccountHidden, markForgetting, type HiddenMap } from './hidden';
import { rememberedIdsByItem, forgetStaleRecords } from './last-known';
import { getLinks, readLinks, effectiveLinks, resolveId, sameAccountIds, linksKey, type Link } from './link-core';

// Keys are functions of the container.
const directoryKey = (ctx: Ctx) => kc(ctx, 'accounts:directory');
const dismissedKey = (ctx: Ctx) => kc(ctx, 'account-links:dismissed');

/** How long after an old account was last seen a new one can be suggested as it. */
export const MATCH_WINDOW_DAYS = 45;
const MAX_ID = 100;

const DAY = 86_400_000;
const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

// Directory

/** Where an account's data comes from. One provider today; recorded so a
 *  second aggregator needs no change to what is stored. */
export const PROVIDER = 'plaid';

export type DirectoryEntry = {
  /** Absent on entries written before it was recorded: those are Plaid's. */
  provider?: string;
  item_id: string;
  institution_id: string | null;
  institution_name: string;
  name: string | null;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  persistent_account_id: string | null;
  /** First day the account is known to have existed: its earliest recorded
   *  balance, or the day it was first seen live. */
  first_seen: string;
  last_seen: string;
};

/** Every readable entry, and the ids whose entries couldn't be read. Those
 *  are never rewritten: rewriting one would restart its first_seen and make
 *  an old account look brand new. */
async function readDirectory(ctx: Ctx): Promise<{ entries: Record<string, DirectoryEntry>; unreadable: Set<string> }> {
  const raw = (await redis().hgetall<Record<string, string>>(directoryKey(ctx))) ?? {};
  const entries: Record<string, DirectoryEntry> = {};
  const unreadable = new Set<string>();
  await Promise.all(
    Object.entries(raw).map(async ([id, blob]) => {
      try {
        entries[id] = JSON.parse(await decrypt(blob)) as DirectoryEntry;
      } catch {
        unreadable.add(id);
      }
    })
  );
  return { entries, unreadable };
}

/** The whole directory, for the download of my data (lib/user-export.ts).
 *  Strict: throws when it can't be read or any entry can't be, rather than
 *  leaving an account's name out. */
export async function readDirectoryStrict(ctx: Ctx): Promise<Map<string, DirectoryEntry>> {
  const { entries, unreadable } = await readDirectory(ctx);
  if (unreadable.size > 0) throw new Error('An entry in the account directory could not be read');
  for (const e of Object.values(entries)) {
    if (!e || typeof e !== 'object' || typeof e.institution_name !== 'string') {
      throw new Error('An entry in the account directory has an unexpected shape');
    }
  }
  return new Map(Object.entries(entries));
}

/** What the directory knows of an account, for allocation over time. */
export type KnownAccount = {
  /** The first day it is known to have existed (first_seen). */
  first_seen: string | null;
  /** "<name> at <institution>", for naming an account the dashboard no
   *  longer shows; null when the directory has no name for it. */
  label: string | null;
};

/**
 * What the directory knows of each account, by the id it was seen under: when
 * it is first known to have existed, so a day after that and before the
 * account was first recorded is a day it is missing from rather than one
 * before it existed, and its name. The ids whose entries can't be read are
 * named, so the caller can tell "not known" from "not in it".
 */
export async function readKnownAccounts(ctx: Ctx): Promise<{ known: Map<string, KnownAccount>; unreadable: Set<string> }> {
  const { entries, unreadable } = await readDirectory(ctx);
  const known = new Map<string, KnownAccount>();
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  for (const [id, e] of Object.entries(entries)) {
    if (!e || typeof e !== 'object') {
      unreadable.add(id);
      continue;
    }
    const first = typeof e.first_seen === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.first_seen) ? e.first_seen : null;
    if (first === null) unreadable.add(id);
    const name = text(e.name) ?? text(e.official_name);
    const at = text(e.institution_name);
    known.set(id, { first_seen: first, label: name ? (at ? `${name} at ${at}` : name) : null });
  }
  return { known, unreadable };
}

/** Every offer the user declined (dismissPair, dismissAll): "<old>><new>" or
 *  "<old>>*" -> when. For the download of my data; strict, unlike
 *  getDismissed. */
export async function readDismissedStrict(ctx: Ctx): Promise<Map<string, string>> {
  const raw = (await redis().hgetall<Record<string, unknown>>(dismissedKey(ctx))) ?? {};
  return new Map(Object.entries(raw).map(([k, v]) => [k, String(v)]));
}

export type Span = { first: string; last: string; firstBalance: number; lastBalance: number };

/**
 * Each account id's first and last recorded balance, from the real and partial
 * per-account history. The only evidence left for an account whose Item was
 * disconnected before the directory existed. Reads every date, so it is only
 * used off the hot path (suggestions, and the one-time dating of new entries).
 */
export async function historySpans(ctx: Ctx): Promise<Record<string, Span>> {
  const spans: Record<string, Span> = {};
  const maps = await Promise.all(
    measuredAccountHistoryKeys(ctx).map(async (key) => (await redis().hgetall<Record<string, string>>(key)) ?? {})
  );
  for (const map of maps) {
    // Decrypted in parallel: this reads every recorded date.
    const decoded = await Promise.all(
      Object.entries(map).map(async ([date, blob]) => {
        try {
          return [date, JSON.parse(await decrypt(blob)) as Record<string, number>] as const;
        } catch {
          return null;
        }
      })
    );
    for (const pair of decoded) {
      if (!pair) continue;
      const [date, balances] = pair;
      for (const [id, value] of Object.entries(balances ?? {})) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const s = spans[id];
        if (!s) spans[id] = { first: date, last: date, firstBalance: value, lastBalance: value };
        else {
          if (date < s.first) Object.assign(s, { first: date, firstBalance: value });
          if (date > s.last) Object.assign(s, { last: date, lastBalance: value });
        }
      }
    }
  }
  return spans;
}

type SeenAccount = {
  account_id: string;
  name?: string | null;
  official_name?: string | null;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  persistent_account_id?: string | null;
};
type SeenInstitution = {
  item_id: string;
  institution_name: string;
  institution_id?: string | null;
  error: string | null;
  manual?: boolean;
  accounts: SeenAccount[];
};

/**
 * Records every account of every institution that answered, for matching a
 * re-added institution later. Call next to rememberAccounts, on the same
 * healthy fetches. Best effort: never throws, and never rewrites an entry it
 * couldn't read.
 *
 * Writes an entry only when it is new, its details changed, or it hasn't been
 * stamped today, so a normal load writes nothing after the first of the day.
 * A new entry is dated from the account's earliest recorded balance, not
 * today: otherwise every existing account would look newly opened on the day
 * this shipped, and nothing could be matched to anything.
 */
export async function recordDirectory(ctx: Ctx, institutions: SeenInstitution[], now: number = Date.now()): Promise<void> {
  try {
    const healthy = institutions.filter((i) => !i.error && !i.manual && i.accounts.length > 0);
    if (healthy.length === 0) return;
    const day = today(now);
    const { entries, unreadable } = await readDirectory(ctx);

    const fresh = healthy.flatMap((i) => i.accounts.map((a) => ({ inst: i, a })));
    const unknown = fresh.filter(({ a }) => !entries[a.account_id] && !unreadable.has(a.account_id));
    const spans = unknown.length > 0 ? await historySpans(ctx) : {};

    const writes: Record<string, string> = {};
    for (const { inst, a } of fresh) {
      if (unreadable.has(a.account_id) || isManualId(a.account_id)) continue;
      const prev = entries[a.account_id];
      const next: DirectoryEntry = {
        provider: PROVIDER,
        item_id: inst.item_id,
        institution_id: inst.institution_id ?? prev?.institution_id ?? null,
        institution_name: inst.institution_name,
        name: a.name ?? null,
        official_name: a.official_name ?? null,
        mask: a.mask ?? null,
        type: a.type ?? null,
        subtype: a.subtype ?? null,
        persistent_account_id: a.persistent_account_id ?? prev?.persistent_account_id ?? null,
        first_seen: prev?.first_seen ?? spans[a.account_id]?.first ?? day,
        last_seen: day,
      };
      if (prev && JSON.stringify({ ...prev, last_seen: day }) === JSON.stringify(next)) continue;
      writes[a.account_id] = await encrypt(JSON.stringify(next));
    }
    if (Object.keys(writes).length > 0) await redis().hset(directoryKey(ctx), writes);
  } catch (err) {
    console.warn('links: could not record the account directory', err instanceof Error ? err.message : err);
  }
}

// Links: the pure core lives in lib/link-core.ts (so lib/last-known.ts and
// lib/vanished.ts can follow links without importing this module back).
export { getLinks, effectiveLinks, resolveId, sameAccountIds, type Link } from './link-core';

// Suggestions

export type Suggestion = {
  old: string;
  to: string;
  old_label: string;
  to_label: string;
  evidence: {
    persistent_match: boolean;
    old_last: string | null;
    old_last_balance: number | null;
    new_first: string | null;
    new_first_balance: number | null;
  };
};

/** An earlier account the user can attach by hand: one known only from its
 *  balances (older than the directory), or one the strict matching couldn't
 *  pair (no mask, a changed subtype, a longer gap, or "Not the same"). */
export type Unclaimed = {
  old: string;
  /** What it was, when the directory knows; otherwise null (balances only). */
  old_label: string | null;
  first: string;
  last: string;
  last_balance: number | null;
  /** Live accounts it could be (see suggestLinks for the rules). */
  candidates: { id: string; label: string }[];
};

/** How long after an earlier account stopped the card still OFFERS it for a
 *  new one. Reconnects happen close in time; a closed account's history is not
 *  pushed at every account opened in the years after it. Linking by hand
 *  (manualChoices) has no such limit. */
export const ASSIGN_WINDOW_DAYS = 90;

/** When an account was last seen: the later of its directory stamp and its
 *  last recorded balance. Recorded on a link as old_last, which orders earlier
 *  ids (link-core sameAccountIds), so the preview must use the same rule. */
export function lastSeenOf(id: string, directory: Record<string, DirectoryEntry>, spans: Record<string, Span>): string | null {
  const d = directory[id]?.last_seen ?? null;
  const s = spans[id]?.last ?? null;
  return d && s ? (d > s ? d : s) : d ?? s;
}

const normal = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const label = (e: DirectoryEntry | undefined, id: string) =>
  e ? `${e.institution_name} ${e.name ?? 'account'}${e.mask ? ` ••${e.mask}` : ''}` : id;
const sameInstitution = (a: DirectoryEntry, b: DirectoryEntry) =>
  a.institution_id && b.institution_id
    ? a.institution_id === b.institution_id
    : normal(a.institution_name) === normal(b.institution_name);
/** Debt or asset. A link across the two would subtract a hidden account with
 *  the wrong sign on every date its earlier id covers. */
const owedClass = (type: string | null | undefined) => (type ? isOwedType(type) : null);

/** The key that dismisses every candidate for one earlier account. */
export const dismissAllKey = (old: string) => `${old}>*`;

/**
 * What to offer the user. Pure: callers load the inputs.
 *
 * A SUGGESTION pairs an orphan (a known account that is not live and not
 * linked) with a newcomer (a live account first seen within MATCH_WINDOW_DAYS
 * after the orphan was last seen) when both have directory entries and match on
 * institution, type, subtype and a non-null mask, uniquely in both directions.
 * A shared persistent_account_id is shown as strong evidence.
 *
 * Every other orphan is UNCLAIMED: the user can attach it by hand to a live
 * account that
 *   - first appeared on or after the orphan's last day, and within
 *     ASSIGN_WINDOW_DAYS of it;
 *   - has no history already linked to it that overlaps the orphan's (an
 *     earlier id attached to it before counts as where it starts);
 *   - is the same kind of account (debt or asset) when the orphan's type is
 *     known. For an orphan known only from balances it can't be checked, which
 *     is why every choice is previewed first.
 * "None of these" (dismissAllKey) stops an orphan being offered at all.
 */
export function suggestLinks(input: {
  directory: Record<string, DirectoryEntry>;
  spans: Record<string, Span>;
  liveIds: Set<string>;
  links: Map<string, Link>;
  dismissed: Set<string>;
  /** Old ids with an unreadable link: linked to something, so never offered. */
  unreadableLinks?: Set<string>;
}): { suggestions: Suggestion[]; unclaimed: Unclaimed[] } {
  const { directory, spans, liveIds, links, dismissed } = input;
  const linkedAway = new Set([...links.keys(), ...(input.unreadableLinks ?? [])]);
  const isOrphan = (id: string) =>
    !liveIds.has(id) && !linkedAway.has(id) && !isManualId(id) && !dismissed.has(dismissAllKey(id));
  const live = [...liveIds].filter((id) => !isManualId(id) && !linkedAway.has(id));
  const firstSeen = (id: string) => directory[id]?.first_seen ?? spans[id]?.first ?? null;
  const lastSeen = (id: string) => lastSeenOf(id, directory, spans);
  /** Where a live account's history starts once its linked earlier ids count. */
  const startsAt = (n: string) => {
    let first = firstSeen(n);
    for (const old of links.keys()) {
      if (resolveId(old, links) !== n) continue;
      const f = spans[old]?.first ?? directory[old]?.first_seen ?? null;
      if (f && (!first || f < first)) first = f;
    }
    return first;
  };

  const orphans = [...new Set([...Object.keys(directory), ...Object.keys(spans)])].filter(isOrphan);

  const fits = (o: string, n: string) => {
    const a = directory[o];
    const b = directory[n];
    if (!a || !b) return false;
    if (!sameInstitution(a, b) || a.type !== b.type || a.subtype !== b.subtype) return false;
    if (!a.mask || a.mask !== b.mask) return false;
    // From where n's history starts once what is already linked to it
    // counts, so a suggestion never overlaps history joined on before.
    const last = lastSeen(o);
    const first = startsAt(n);
    if (!last || !first) return false;
    const gap = daysBetween(last, first);
    return gap >= 0 && gap <= MATCH_WINDOW_DAYS;
  };

  const suggestions: Suggestion[] = [];
  for (const o of orphans.filter((id) => directory[id])) {
    const matches = live.filter((n) => fits(o, n));
    if (matches.length !== 1) continue;
    const n = matches[0];
    if (orphans.filter((x) => fits(x, n)).length !== 1) continue; // unique both ways
    if (dismissed.has(`${o}>${n}`)) continue;
    suggestions.push({
      old: o,
      to: n,
      old_label: label(directory[o], o),
      to_label: label(directory[n], n),
      evidence: {
        persistent_match:
          !!directory[o].persistent_account_id &&
          directory[o].persistent_account_id === directory[n].persistent_account_id,
        old_last: lastSeen(o),
        old_last_balance: spans[o]?.lastBalance ?? null,
        new_first: firstSeen(n),
        new_first_balance: spans[n]?.firstBalance ?? null,
      },
    });
  }

  const suggested = new Set(suggestions.map((x) => x.old));
  const unclaimed: Unclaimed[] = [];
  for (const o of orphans.filter((id) => !suggested.has(id))) {
    const last = lastSeen(o);
    const first = spans[o]?.first ?? directory[o]?.first_seen ?? null;
    if (!last || !first) continue;
    const oldClass = owedClass(directory[o]?.type);
    const candidates = live
      .filter((n) => {
        const start = startsAt(n);
        if (!start) return false;
        const gap = daysBetween(last, start);
        if (gap < 0 || gap > ASSIGN_WINDOW_DAYS) return false;
        const newClass = owedClass(directory[n]?.type);
        if (oldClass !== null && newClass !== null && newClass !== oldClass) return false;
        return !dismissed.has(`${o}>${n}`);
      })
      .map((n) => ({ id: n, label: label(directory[n], n) }));
    if (candidates.length === 0) continue;
    unclaimed.push({
      old: o,
      old_label: directory[o] ? label(directory[o], o) : null,
      first,
      last,
      last_balance: spans[o]?.lastBalance ?? null,
      candidates,
    });
  }
  return { suggestions, unclaimed };
}

/**
 * Whether the user may link `old` to `to`: it must be one of the suggestions or
 * unclaimed choices computed from this container's own data, right now. A
 * client can't link arbitrary ids, and can't link anything that isn't offered.
 */
export function isOffered(old: string, to: string, offered: ReturnType<typeof suggestLinks>): boolean {
  if (offered.suggestions.some((s) => s.old === old && s.to === to)) return true;
  return offered.unclaimed.some((u) => u.old === old && u.candidates.some((c) => c.id === to));
}

/**
 * Every earlier account the user may link BY HAND, with what each may be
 * linked to. Pure: callers load the inputs.
 *
 * Wider than what suggestLinks offers, on purpose: no time window (someone
 * returning after months must still be able to join their history back up),
 * and dismissals don't apply (a declined or missed match must stay fixable).
 * The rules that keep a link from corrupting a series still do:
 *   - the earlier account is not live, not already linked, and not manual;
 *   - the target is live, not manual, and not itself linked to something;
 *   - the target's history (with whatever is already linked to it) starts on
 *     or after the earlier account's last day, so the two never overlap;
 *   - the same kind of account (debt or asset) when both kinds are known.
 */
export function manualChoices(input: {
  directory: Record<string, DirectoryEntry>;
  spans: Record<string, Span>;
  liveIds: Set<string>;
  links: Map<string, Link>;
  unreadableLinks?: Set<string>;
}): Unclaimed[] {
  const { directory, spans, liveIds, links } = input;
  const linkedAway = new Set([...links.keys(), ...(input.unreadableLinks ?? [])]);
  const live = [...liveIds].filter((id) => !isManualId(id) && !linkedAway.has(id));
  // Where each live account's history starts, with what is already linked to
  // it: worked out once, not per pair, since the directory only grows.
  const starts = new Map<string, string | null>(live.map((n) => [n, directory[n]?.first_seen ?? spans[n]?.first ?? null]));
  for (const old of links.keys()) {
    const n = resolveId(old, links);
    if (!starts.has(n)) continue;
    const f = spans[old]?.first ?? directory[old]?.first_seen ?? null;
    const first = starts.get(n);
    if (f && (!first || f < first)) starts.set(n, f);
  }
  const startsAt = (n: string) => starts.get(n) ?? null;
  const earlier = [...new Set([...Object.keys(directory), ...Object.keys(spans)])].filter(
    (id) => !liveIds.has(id) && !linkedAway.has(id) && !isManualId(id)
  );
  const out: Unclaimed[] = [];
  for (const o of earlier) {
    const last = lastSeenOf(o, directory, spans);
    const first = spans[o]?.first ?? directory[o]?.first_seen ?? null;
    if (!last || !first) continue;
    const oldClass = owedClass(directory[o]?.type);
    const candidates = live
      .filter((n) => {
        const start = startsAt(n);
        if (!start || daysBetween(last, start) < 0) return false;
        const newClass = owedClass(directory[n]?.type);
        return oldClass === null || newClass === null || newClass === oldClass;
      })
      .map((n) => ({ id: n, label: label(directory[n], n) }));
    if (candidates.length === 0) continue;
    out.push({
      old: o,
      old_label: directory[o] ? label(directory[o], o) : null,
      first,
      last,
      last_balance: spans[o]?.lastBalance ?? null,
      candidates,
    });
  }
  // Most recently stopped first: the likeliest to be what the user is after.
  return out.sort((x, y) => (x.last < y.last ? 1 : x.last > y.last ? -1 : x.old < y.old ? -1 : 1));
}

/** Whether the user may link `old` to `to` by hand right now. */
export function isManualChoice(old: string, to: string, choices: Unclaimed[]): boolean {
  return choices.some((c) => c.old === old && c.candidates.some((x) => x.id === to));
}

/** An earlier account the user can forget: what it was, and its span. */
export type Earlier = { id: string; label: string | null; first: string | null; last: string | null };

/**
 * The earlier accounts the user can FORGET (forgetEarlierAccount): accounts
 * of an institution that is no longer connected. Not live, not manual, not
 * part of any link either end (unlink first: a linked id's history is part of
 * an account on screen), and not an account of an Item still stored: one the
 * bank stopped returning (closed, or left out for a day) still has its
 * transactions stored there, so forgetting it would be neither complete nor
 * safe; it goes when the institution is disconnected. `hidden` says it is
 * hidden, which forgetting keeps out of past totals. Pure. Most recent first.
 */
export function forgettableAccounts(
  input: {
    directory: Record<string, DirectoryEntry>;
    spans: Record<string, Span>;
    liveIds: Set<string>;
    links: Map<string, Link>;
    unreadableLinks?: Set<string>;
  },
  hidden: Set<string>,
  storedItems: Set<string>
): (Earlier & { hidden: boolean })[] {
  const { directory, spans, liveIds, links } = input;
  const linked = new Set([...links.keys(), ...[...links.values()].map((l) => l.to), ...(input.unreadableLinks ?? [])]);
  return [...new Set([...Object.keys(directory), ...Object.keys(spans)])]
    .filter((id) => !liveIds.has(id) && !isManualId(id) && !linked.has(id))
    .filter((id) => !directory[id] || !storedItems.has(directory[id].item_id))
    .map((id) => ({
      id,
      label: directory[id] ? label(directory[id], id) : null,
      first: spans[id]?.first ?? directory[id]?.first_seen ?? null,
      last: lastSeenOf(id, directory, spans),
      hidden: hidden.has(id),
    }))
    .sort((a, b) => ((a.last ?? '') < (b.last ?? '') ? 1 : (a.last ?? '') > (b.last ?? '') ? -1 : a.id < b.id ? -1 : 1));
}

/** A refusal to show the user: nothing was changed. */
export class ForgetRefused extends Error {}

// One change to links or earlier accounts at a time, per container: a link
// made while an account is half forgotten would point at an account that is
// about to lose its name and history.
const linksLockKey = (ctx: Ctx) => kc(ctx, 'account-links:lock');
export const RELEASE_LOCK = `-- nya:release-lock
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;
/** How long a request under the lock may run (the routes' maxDuration). The
 *  lock outlives it, so a request can't outlive its lock; a request killed
 *  holding it (the platform ending it) frees it this much later. */
export const LINKS_LOCK_REQUEST_SECONDS = 120;
const LINKS_LOCK_SECONDS = LINKS_LOCK_REQUEST_SECONDS + 30;

export async function withLinksLock<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  if ((await redis().set(linksLockKey(ctx), token, { nx: true, ex: LINKS_LOCK_SECONDS })) === null) {
    throw new ForgetRefused('Another change to your accounts is in progress. Try again in a moment.');
  }
  try {
    return await fn();
  } finally {
    await redis().eval(RELEASE_LOCK, [linksLockKey(ctx)], [token]).catch(() => {});
  }
}

/**
 * Forgets an earlier account for good, at the user's request: its balances
 * in every per-account layer, its positions in holdings history, its
 * directory entry (name, mask, institution), the categories recorded to carry
 * across a re-link, dismissed offers that name it, leftover remembered records
 * naming it, and its hidden entry. The past net-worth totals stay as they were
 * (they were the user's net worth on those dates); a hidden account is folded
 * out of them first, so the chart shows them as it did while it was hidden
 * (lib/history.ts foldHiddenAccount).
 *
 * Refused (ForgetRefused) unless it is forgettable right now, re-checked here
 * from fresh, strict reads; an account known only from balances is also
 * checked against every stored Item's transaction and investment stores.
 * Balances and positions go before the name, so a failure part way leaves it
 * listed, and running it again finishes. Call inside withLinksLock.
 *
 * A backfill or snapshot running beside it isn't locked out: both write each
 * breakdown before its total, which is the order a fold is safe against
 * (foldHiddenAccount). A backfill that fetched before the institution was
 * disconnected sees it gone before writing, and writes nothing.
 *
 * `unreadableDates` are days of balances too damaged for anyone to read, and
 * `holdingsDamaged` says holdings records that could hold the account are
 * (lib/holdings-history.ts forgetAccountHoldings): left as they are. Holdings
 * records this version does not recognise stop the forget before anything is
 * changed, for an account that could be in them (UnreadableEntriesError).
 */
export async function forgetEarlierAccount(
  ctx: Ctx,
  id: string
): Promise<{ changed: number; unreadableDates: string[]; holdingsDamaged: boolean }> {
  const [inputs, hidden, items] = await Promise.all([
    liveAccountIds(ctx, { strict: true }).then((live) => loadSuggestionInputs(ctx, live)),
    getHiddenAccounts(ctx),
    getItems(ctx),
  ]);
  if (inputs.unreadableLinks.size > 0) throw new ForgetRefused('A saved link can\'t be read. Remove it first.');
  const storedItems = new Set(items.map((i) => i.item_id));
  const found = forgettableAccounts(inputs, new Set(hidden.keys()), storedItems).find((e) => e.id === id);
  if (!found) throw new ForgetRefused('That account can\'t be forgotten: its institution is still connected, it is linked, or it is unknown.');
  if (!inputs.directory[id]) {
    // Known only from balances: make sure no connected institution still
    // stores it. Strict: an unreadable store is not an absent one.
    for (const item of items) {
      const [txnIds, invIds] = await Promise.all([storedAccountIds(ctx, item.item_id), storedInvestmentAccountIds(ctx, item.item_id, true)]);
      if (txnIds.has(id) || invIds.includes(id)) {
        throw new ForgetRefused('That account belongs to an institution that is still connected. Disconnect it first.');
      }
    }
  }

  // What it held, from every month of holdings history. First, as the one
  // step that stops for what is stored (a record this version does not
  // recognise that may hold the account), so a forget it stops has changed
  // nothing. An account known not to be an investment account never had
  // positions: holdings records are not read for it at all, so nothing in
  // them, not even a record no one can read, holds its forget back.
  const type = inputs.directory[id]?.type ?? hidden.get(id)?.type ?? null;
  const mayHoldPositions = type === null || isInvestmentType(type);
  const holdings = mayHoldPositions ? await forgetAccountHoldings(ctx, id) : { changed: 0, damaged: false };

  if (found.hidden) {
    // Taken out of every past total for good, point by point, each in one step
    // (foldHiddenAccount). The random tag, kept in its hidden entry, holds
    // progress so a retry skips what is done; the hidden entry is dropped only
    // once every point is folded.
    const entry = hidden.get(id)!;
    const tag = entry.forget_tag ?? crypto.randomUUID();
    if (!entry.forget_tag) await markForgetting(ctx, id, entry, tag);
    const d = inputs.directory[id];
    await foldHiddenAccount(ctx, id, entry.type, tag, { first: d?.first_seen ?? null, last: d?.last_seen ?? null });
    // Every point is folded: the progress goes first, while the hidden entry
    // still holds the tag that names it, so nothing can leave it behind.
    await dropFoldProgress(ctx, tag);
    await setAccountHidden(ctx, id, '', false);
  }
  const result = await forgetAccountBalances(ctx, id);
  const dismissed = Object.keys((await redis().hgetall<Record<string, string>>(dismissedKey(ctx))) ?? {}).filter(
    (k) => k.startsWith(`${id}>`) || k.endsWith(`>${id}`)
  );
  if (dismissed.length > 0) await redis().hdel(dismissedKey(ctx), ...dismissed);
  await forgetCarried(ctx, id);
  await forgetCarriedAnnotations(ctx, id);
  await forgetStaleRecords(ctx, id, storedItems);
  // Once more for today, after everything else: a same-day partial record
  // read before the pass above could have written the account back, and a
  // recording of holdings already under way could have too.
  await forgetAccountBalances(ctx, id, { today: true });
  if (mayHoldPositions) await forgetRecentHoldings(ctx, id);
  // Last: while the entry exists the account is still listed, so a retry is
  // offered. A map nobody can decrypt doesn't hold it back: nothing in it can
  // be read by anyone.
  await redis().hdel(directoryKey(ctx), id);
  // Categories of its transactions that nothing can show any more (a failed
  // disconnect-time cleanup would otherwise leave them for good).
  await pruneOrphanOverrides(ctx, items.map((i) => i.item_id)).catch(() => 0);
  return { ...result, holdingsDamaged: holdings.damaged };
}

/** Whether "None of these" is offered for an earlier account right now. */
export function isUnclaimed(old: string, offered: ReturnType<typeof suggestLinks>): boolean {
  return offered.unclaimed.some((u) => u.old === old);
}

export async function getDismissed(ctx: Ctx): Promise<Set<string>> {
  try {
    return new Set(Object.keys((await redis().hgetall<Record<string, string>>(dismissedKey(ctx))) ?? {}));
  } catch {
    return new Set();
  }
}

export async function dismissPair(ctx: Ctx, old: string, to: string, now: number = Date.now()): Promise<void> {
  await redis().hset(dismissedKey(ctx), { [`${old.slice(0, MAX_ID)}>${to.slice(0, MAX_ID)}`]: new Date(now).toISOString() });
}

/** "None of these": never offer this earlier account again. */
export async function dismissAll(ctx: Ctx, old: string, now: number = Date.now()): Promise<void> {
  await redis().hset(dismissedKey(ctx), { [dismissAllKey(old.slice(0, MAX_ID))]: new Date(now).toISOString() });
}

export async function linkAccounts(ctx: Ctx, old: string, to: string, evidence: Record<string, unknown>, now: number = Date.now()): Promise<void> {
  const link: Link = { to, linked_at: new Date(now).toISOString(), evidence };
  await redis().hset(linksKey(ctx), { [old]: await encrypt(JSON.stringify(link)) });
}

export async function unlinkAccount(ctx: Ctx, old: string): Promise<void> {
  await redis().hdel(linksKey(ctx), old);
}

/** Everything the suggestions need, read once. An unreadable link doesn't
 *  fail it: the card lists those so the user can remove them. */
export async function loadSuggestionInputs(ctx: Ctx, liveIds: Set<string>) {
  const [{ entries }, spans, { links, unreadable }, dismissed] = await Promise.all([
    readDirectory(ctx),
    historySpans(ctx),
    readLinks(ctx),
    getDismissed(ctx),
  ]);
  return { directory: entries, spans, liveIds, links, dismissed, unreadableLinks: unreadable };
}

/** When an earlier id was last seen, by the rule a link records (lastSeenOf),
 *  for a preview of linking it. */
export async function previewLastSeen(ctx: Ctx, id: string): Promise<string | null> {
  const [{ entries }, spans] = await Promise.all([readDirectory(ctx), historySpans(ctx)]);
  return lastSeenOf(id, entries, spans);
}

/** Each account's type as the directory recorded it (depository, credit…). */
export async function directoryTypes(ctx: Ctx, ids: string[]): Promise<Record<string, string | null>> {
  const { entries } = await readDirectory(ctx);
  return Object.fromEntries(ids.map((id) => [id, entries[id]?.type ?? null]));
}

/** Directory labels for a set of ids, for the "Linked accounts" list; null
 *  for an id the directory doesn't know (balance history only). */
export async function directoryLabels(ctx: Ctx, ids: string[]): Promise<Record<string, string | null>> {
  const { entries } = await readDirectory(ctx);
  return Object.fromEntries(ids.map((id) => [id, entries[id] ? label(entries[id], id) : null]));
}

/** The same, in parts: the institution, and the account within it
 *  ("Checking ••1111"), for lists grouped by institution. */
export async function directoryParts(ctx: Ctx, ids: string[]): Promise<Record<string, { institution: string; name: string } | null>> {
  const { entries } = await readDirectory(ctx);
  return Object.fromEntries(
    ids.map((id) => {
      const e = entries[id];
      return [id, e ? { institution: e.institution_name, name: `${e.name ?? 'Account'}${e.mask ? ` ••${e.mask}` : ''}` } : null];
    })
  );
}


// Readers

/**
 * The Plaid account ids that are live now: the remembered accounts
 * (accounts:meta, kept while an Item is erroring) of every Item still stored.
 * Not a live Plaid fetch: opening the Accounts tab must not fan out to every
 * institution. Filtered by the stored Items because a load in flight when an
 * Item is disconnected can write its record back after forgetItem, and nothing
 * would ever remove it.
 *
 * By default, empty when either can't be read. Display callers use this only
 * to PAUSE links whose old id is live again, so an empty set errs toward
 * following links: it can hide more, never reveal. A caller that WRITES on the
 * answer (Unhide clears every id it finds) passes strict, and fails instead.
 * A caller that must change nothing (the download of my data, or someone
 * else's read of what is shared with them, lib/sharing.ts) passes readOnly,
 * which leaves old-shaped remembered records where they are.
 */
export async function liveAccountIds(ctx: Ctx, opts: { strict?: boolean; readOnly?: boolean } = {}): Promise<Set<string>> {
  try {
    const [byItem, items] = await Promise.all([rememberedIdsByItem(ctx, opts.strict, !opts.readOnly), getItems(ctx)]);
    const stored = new Set(items.map((i) => i.item_id));
    return new Set(Object.entries(byItem).flatMap(([item_id, ids]) => (stored.has(item_id) ? ids : [])));
  } catch (err) {
    if (opts.strict) throw err;
    return new Set();
  }
}

/**
 * Hidden accounts, following links: hiding one id of an account hides every id
 * it has had. Storage keeps the raw ids (hiding writes the current id), so an
 * unlink restores exactly what was hidden before.
 *
 * Each expanded id is subtracted on its own by getHistory: on a date where two
 * ids of one account both appear, each is a separate term in that date's
 * total, so subtracting them all is exactly right, and an id that isn't in a
 * date's map subtracts nothing.
 *
 * Throws if the hidden set can't be read, like getHiddenAccounts, or if
 * something is hidden and the links can't be read: a hidden account
 * reappearing on screen is the one outcome hiding must never produce. With
 * nothing hidden the links don't matter, so a bad link can't take down the
 * dashboard. The live ids err the other way when unreadable (see
 * liveAccountIds): a paused link then counts as active, which can only hide
 * more, never reveal.
 */
export async function getEffectiveHidden(
  ctx: Ctx,
  /** readOnly: change nothing while reading, as liveAccountIds (someone
   *  else's request reading what is shared with them, lib/sharing.ts). */
  opts: { describe?: boolean; readOnly?: boolean } = {}
): Promise<{
  /** Every id of every hidden account: what totals and filters subtract. */
  hidden: HiddenMap;
  /** One current id per hidden account: what the Hidden card lists. With
   *  `describe`, a hidden account that isn't live is named from the directory. */
  forClient: HiddenForClient[];
  /** The active links, for other readers on the same request (carried
   *  categories); null when they couldn't be read. */
  links: Map<string, Link> | null;
  /** The live ids read for it: empty when they couldn't be read. */
  live: Set<string>;
  /** Whether the live ids were read (an empty set may just mean none). */
  liveOk: boolean;
}> {
  const [hidden, links, liveRead] = await Promise.all([
    getHiddenAccounts(ctx),
    getLinks(ctx).then(
      (l) => ({ ok: true as const, l }),
      (err) => ({ ok: false as const, err })
    ),
    // Unreadable counts as empty here (see liveAccountIds), but callers are
    // told, since an empty set can also be a user with nothing connected.
    liveAccountIds(ctx, { strict: true, readOnly: opts.readOnly }).then(
      (ids) => ({ ok: true, ids }),
      () => ({ ok: false, ids: new Set<string>() })
    ),
  ]);
  const live = liveRead.ids;
  const liveOk = liveRead.ok;
  const effective = links.ok ? effectiveLinks(links.l, live) : null;
  if (hidden.size === 0) return { hidden, forClient: [], links: effective, live, liveOk };
  if (!effective) throw (links as { err: unknown }).err;
  const forClient = hiddenForClient(hidden, effective);
  return {
    hidden: expandHidden(hidden, effective),
    forClient: opts.describe && liveOk ? await describeGone(ctx, forClient, live) : forClient,
    links: effective,
    live,
    liveOk,
  };
}

/**
 * Names the hidden accounts that aren't live, so the Hidden card can say what
 * each was, and whether its institution was disconnected (it stays hidden
 * until the user unhides it or links it to the re-added account) or is only
 * failing to load. Reads anything only when such an account exists, and
 * leaves the list as it was if those reads fail: it is only a label.
 */
async function describeGone(ctx: Ctx, list: HiddenForClient[], live: Set<string>): Promise<HiddenForClient[]> {
  const gone = list.filter((h) => !live.has(h.account_id));
  if (gone.length === 0) return list;
  try {
    const [entries, items] = await Promise.all([directoryEntries(ctx, gone.map((h) => h.account_id)), getItems(ctx)]);
    const stored = new Set(items.map((i) => i.item_id));
    return list.map((h) => {
      const e = live.has(h.account_id) ? undefined : entries[h.account_id];
      return e ? { ...h, label: label(e, h.account_id), disconnected: !stored.has(e.item_id) } : h;
    });
  } catch {
    return list;
  }
}

/** Just these ids' directory entries (one read each, not the whole directory);
 *  an unreadable or missing one is left out. */
async function directoryEntries(ctx: Ctx, ids: string[]): Promise<Record<string, DirectoryEntry>> {
  const blobs = await Promise.all(ids.map((id) => redis().hget<string>(directoryKey(ctx), id)));
  const out: Record<string, DirectoryEntry> = {};
  await Promise.all(
    ids.map(async (id, i) => {
      if (!blobs[i]) return;
      try {
        out[id] = JSON.parse(await decrypt(blobs[i]!)) as DirectoryEntry;
      } catch {
        // unlabelled, like an account the directory never knew
      }
    })
  );
  return out;
}

export function expandHidden(hidden: HiddenMap, links: Map<string, Link>): HiddenMap {
  if (links.size === 0) return hidden;
  const out: HiddenMap = new Map(hidden);
  for (const [id, entry] of hidden) {
    for (const same of sameAccountIds(id, links)) {
      if (out.has(same)) continue;
      // Each id is subtracted with ITS OWN kind (debt or asset), recorded on
      // the link when it was made; the hidden entry's type is the fallback.
      const oldType = links.get(same)?.evidence?.old_type;
      out.set(same, typeof oldType === 'string' ? { ...entry, type: oldType } : entry);
    }
  }
  return out;
}

export type HiddenForClient = {
  account_id: string;
  type: string;
  /** For an account that isn't live: what it was, from the directory. */
  label?: string;
  /** Its institution was disconnected (not merely failing to load). */
  disconnected?: boolean;
};

/** The hidden set as the client should see it: one current id per account. */
export function hiddenForClient(hidden: HiddenMap, links: Map<string, Link>): HiddenForClient[] {
  const seen = new Map<string, string>();
  for (const [id, { type }] of hidden) {
    const current = resolveId(id, links);
    if (!seen.has(current)) seen.set(current, type);
  }
  return [...seen].map(([account_id, type]) => ({ account_id, type }));
}
