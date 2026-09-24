// lib/links.ts
//
// Linking an account's history across a reconnect.
//
// Plaid can issue new account ids for the same accounts, and a disconnect and
// re-add always does (a new Item). Everything in Nya is keyed by account id, so
// the new id starts from nothing and the old one's history is orphaned: not
// deleted, just unreachable. This module lets each user say "this is the same
// account", and lets the readers that matter follow that.
//
// THE RULES, each from a review of this design:
//
// 1. STORED DATA IS NEVER REWRITTEN. A link is one entry, old id -> new id, in
//    its own hash. Readers resolve it; nothing else changes. Unlinking deletes
//    the entry and the split view comes straight back.
// 2. THE USER DECIDES. Suggestions come with evidence; nothing is linked
//    automatically. With more than one user, "the user" is whoever owns the
//    container (#53): every key here goes through k(), so links, suggestions
//    and the directory can only ever involve one container's accounts.
// 3. LINKS FOLLOW HISTORY, NOT TRANSACTIONS. After a disconnect the old Item's
//    transaction stores are deleted, so what survives under an old id is its
//    balance history. Row-level merging only matters for a rotation inside one
//    Item and is deferred until a real one shows what Plaid sends.
// 4. MANUAL ACCOUNTS ARE NEVER LINKED. A recreated manual account must not
//    inherit a deleted one's series (lib/manual.ts says so).
//
// The DIRECTORY is what makes a re-added institution matchable: a record of
// every Plaid account seen, with its institution id, name, mask and type, kept
// past a disconnect (accounts:meta and the stores are deleted then). Entries of
// a removed Item that nothing links to are pruned PRUNE_AFTER_DAYS after they
// were last seen, so removing an institution still removes its names.

import { redis, k, getItems } from './storage';
import { encrypt, decrypt } from './crypto';
import { isManualId } from './manual';
import { measuredAccountHistoryKeys } from './history';
import { isOwedType } from './balance';
import { getHiddenAccounts, type HiddenMap } from './hidden';
import { rememberedIdsByItem } from './last-known';
import { getLinks, readLinks, effectiveLinks, resolveId, sameAccountIds, linksKey, type Link } from './link-core';

// Lazy keys, not module constants: the container (#53) will be a parameter.
const directoryKey = () => k('accounts:directory');
const dismissedKey = () => k('account-links:dismissed');

/** How long after an old account was last seen a new one can be suggested as it. */
export const MATCH_WINDOW_DAYS = 45;
const MAX_ID = 100;

const DAY = 86_400_000;
const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

// ---------------------------------------------------------------------------
// Directory

export type DirectoryEntry = {
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
async function readDirectory(): Promise<{ entries: Record<string, DirectoryEntry>; unreadable: Set<string> }> {
  const raw = (await redis().hgetall<Record<string, string>>(directoryKey())) ?? {};
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

export type Span = { first: string; last: string; firstBalance: number; lastBalance: number };

/**
 * Each account id's first and last recorded balance, from the real and partial
 * per-account history. The only evidence left for an account whose Item was
 * disconnected before the directory existed. Reads every date, so it is only
 * used off the hot path (suggestions, and the one-time dating of new entries).
 */
export async function historySpans(): Promise<Record<string, Span>> {
  const spans: Record<string, Span> = {};
  const maps = await Promise.all(
    measuredAccountHistoryKeys().map(async (key) => (await redis().hgetall<Record<string, string>>(key)) ?? {})
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
export async function recordDirectory(institutions: SeenInstitution[], now: number = Date.now()): Promise<void> {
  try {
    const healthy = institutions.filter((i) => !i.error && !i.manual && i.accounts.length > 0);
    if (healthy.length === 0) return;
    const day = today(now);
    const { entries, unreadable } = await readDirectory();

    const fresh = healthy.flatMap((i) => i.accounts.map((a) => ({ inst: i, a })));
    const unknown = fresh.filter(({ a }) => !entries[a.account_id] && !unreadable.has(a.account_id));
    const spans = unknown.length > 0 ? await historySpans() : {};

    const writes: Record<string, string> = {};
    for (const { inst, a } of fresh) {
      if (unreadable.has(a.account_id) || isManualId(a.account_id)) continue;
      const prev = entries[a.account_id];
      const next: DirectoryEntry = {
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
    if (Object.keys(writes).length > 0) await redis().hset(directoryKey(), writes);

    await pruneDirectory(entries, now);
  } catch (err) {
    console.warn('links: could not record the account directory', err instanceof Error ? err.message : err);
  }
}

/**
 * Drops unlinked entries of removed Items not seen for PRUNE_AFTER_DAYS.
 *
 * Decided from the stored Items at prune time rather than a mark written on
 * disconnect: a load that fetched just before the disconnect would write the
 * entry back without the mark, and it would never be pruned. An entry is only
 * written for an Item a load just fetched, so one whose Item is no longer
 * stored has been disconnected.
 */
async function pruneDirectory(entries: Record<string, DirectoryEntry>, now: number): Promise<void> {
  const cutoff = today(now - PRUNE_AFTER_DAYS * DAY);
  const old = Object.entries(entries).filter(([, e]) => e.last_seen < cutoff);
  if (old.length === 0) return;
  let links: Map<string, Link>;
  let stored: Set<string>;
  try {
    [links, stored] = await Promise.all([getLinks(), getItems().then((items) => new Set(items.map((i) => i.item_id)))]);
  } catch {
    return; // can't tell what is linked or stored: prune nothing
  }
  const stale = old.filter(([, e]) => !stored.has(e.item_id));
  if (stale.length === 0) return;
  const involved = new Set([...links.keys(), ...[...links.values()].map((l) => l.to)]);
  const doomed = stale.map(([id]) => id).filter((id) => !involved.has(id));
  if (doomed.length > 0) await redis().hdel(directoryKey(), ...doomed);
}

// ---------------------------------------------------------------------------
// Links: the pure core lives in lib/link-core.ts (so lib/last-known.ts and
// lib/vanished.ts can follow links without importing this module back).

export { getLinks, effectiveLinks, resolveId, sameAccountIds, type Link } from './link-core';

// ---------------------------------------------------------------------------
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

/** How long after an earlier account stopped a new one can be offered for it
 *  by hand. Reconnects happen close in time; a closed account's history is not
 *  offered to every account opened in the years after it. */
export const ASSIGN_WINDOW_DAYS = 90;
/** Unlinked directory entries of a removed Item are dropped this long after
 *  they were last seen. No shorter than ASSIGN_WINDOW_DAYS: an earlier account
 *  offered by hand still needs its entry for its name and its kind. */
const PRUNE_AFTER_DAYS = ASSIGN_WINDOW_DAYS;

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

/** Whether "None of these" is offered for an earlier account right now. */
export function isUnclaimed(old: string, offered: ReturnType<typeof suggestLinks>): boolean {
  return offered.unclaimed.some((u) => u.old === old);
}

export async function getDismissed(): Promise<Set<string>> {
  try {
    return new Set(Object.keys((await redis().hgetall<Record<string, string>>(dismissedKey())) ?? {}));
  } catch {
    return new Set();
  }
}

export async function dismissPair(old: string, to: string, now: number = Date.now()): Promise<void> {
  await redis().hset(dismissedKey(), { [`${old.slice(0, MAX_ID)}>${to.slice(0, MAX_ID)}`]: new Date(now).toISOString() });
}

/** "None of these": never offer this earlier account again. */
export async function dismissAll(old: string, now: number = Date.now()): Promise<void> {
  await redis().hset(dismissedKey(), { [dismissAllKey(old.slice(0, MAX_ID))]: new Date(now).toISOString() });
}

export async function linkAccounts(old: string, to: string, evidence: Record<string, unknown>, now: number = Date.now()): Promise<void> {
  const link: Link = { to, linked_at: new Date(now).toISOString(), evidence };
  await redis().hset(linksKey(), { [old]: await encrypt(JSON.stringify(link)) });
}

export async function unlinkAccount(old: string): Promise<void> {
  await redis().hdel(linksKey(), old);
}

/** Everything the suggestions need, read once. An unreadable link doesn't
 *  fail it: the card lists those so the user can remove them. */
export async function loadSuggestionInputs(liveIds: Set<string>) {
  const [{ entries }, spans, { links, unreadable }, dismissed] = await Promise.all([
    readDirectory(),
    historySpans(),
    readLinks(),
    getDismissed(),
  ]);
  return { directory: entries, spans, liveIds, links, dismissed, unreadableLinks: unreadable };
}

/** When an earlier id was last seen, by the rule a link records (lastSeenOf),
 *  for a preview of linking it. */
export async function previewLastSeen(id: string): Promise<string | null> {
  const [{ entries }, spans] = await Promise.all([readDirectory(), historySpans()]);
  return lastSeenOf(id, entries, spans);
}

/** Directory labels for a set of ids, for the "Linked accounts" list; null
 *  for an id the directory doesn't know (balance history only). */
export async function directoryLabels(ids: string[]): Promise<Record<string, string | null>> {
  const { entries } = await readDirectory();
  return Object.fromEntries(ids.map((id) => [id, entries[id] ? label(entries[id], id) : null]));
}


// ---------------------------------------------------------------------------
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
 */
export async function liveAccountIds(opts: { strict?: boolean } = {}): Promise<Set<string>> {
  try {
    const [byItem, items] = await Promise.all([rememberedIdsByItem(opts.strict), getItems()]);
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
export async function getEffectiveHidden(): Promise<{
  /** Every id of every hidden account: what totals and filters subtract. */
  hidden: HiddenMap;
  /** One current id per hidden account: what the Hidden card lists. */
  forClient: { account_id: string; type: string }[];
}> {
  const [hidden, links, live] = await Promise.all([
    getHiddenAccounts(),
    getLinks().then(
      (l) => ({ ok: true as const, l }),
      (err) => ({ ok: false as const, err })
    ),
    liveAccountIds(),
  ]);
  if (hidden.size === 0) return { hidden, forClient: [] };
  if (!links.ok) throw links.err;
  const effective = effectiveLinks(links.l, live);
  return { hidden: expandHidden(hidden, effective), forClient: hiddenForClient(hidden, effective) };
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

/** The hidden set as the client should see it: one current id per account. */
export function hiddenForClient(hidden: HiddenMap, links: Map<string, Link>): { account_id: string; type: string }[] {
  const seen = new Map<string, string>();
  for (const [id, { type }] of hidden) {
    const current = resolveId(id, links);
    if (!seen.has(current)) seen.set(current, type);
  }
  return [...seen].map(([account_id, type]) => ({ account_id, type }));
}
