// lib/lifecycle.ts
//
// Accounts that END on a date (#50): closed at the bank, no longer the
// person's, or no longer followed. Four states, the issue's model:
//
//   active     the default: no entry at all, or the person's "Still open"
//              answer to a question about it (lib/lifecycle-questions.ts)
//   closed     it ceased to exist on a day: closed at the bank, a paid-off
//              loan, an emptied cash jar (manual accounts close too)
//   left       it still exists, but is no longer theirs from a day: sold,
//              transferred, divided
//   untracked  they stopped following it from a day; it still exists, and is
//              still theirs
//
// STORAGE NEVER CHANGES; INTERPRETATION APPLIES ON READ, the rule
// lib/hidden.ts set. Marking an account closed writes one entry here and
// nothing else: the snapshot keeps recording the true total and the full
// per-account map (lib/history.ts), and every reader applies the end:
//
//   1. Every day before the end date is untouched. The money was there, and
//      the history layer is a record of measurements.
//   2. From the end date forward the account does not count: in the live
//      total, every historical point on or after it (the real and estimated
//      layers both, subtracted on read exactly as a hidden account is, from
//      the per-account map recorded with each point), allocation, the Plan's
//      inputs, its transactions in budgets and spending, sharing and the API.
//   3. closed and left behave identically to the math and differ only in
//      wording; untracked does too. Hidden is different: a hidden account is
//      left out of EVERY day, past ones included, where an untracked one
//      counts before its day and not after.
//
// So reopening (back to active) restores exactly: nothing was removed. A
// hidden account that also ended is subtracted once, as hidden. One thing
// reopening can't do is make a bank return an account it stopped returning:
// such an account, once reopened, is held at its last known balance and
// asked about, as any missing account is (reopenMissing), never left
// nowhere.
//
// WHAT AN ENTRY KEEPS THROUGH EVERY CHANGE: the windows its account was
// missing from its bank's answer and assumed closed before it came back
// (`missed`, liftAssumedClosures). The totals recorded on those days are
// short of it, a measurement known to be wrong that the real layer keeps as
// it was written, so the chart leaves those days out on read (shortDays) and
// a note on the timeline says why, under a random id the window keeps (a
// day can't be part of a field name, lib/repo.ts; adoptMissedNotes moves a
// note written before windows kept one).
//
// KEYED TO SURVIVE A RE-LINK. An entry is stored under the id the account had
// when it was set, and read through account links (lib/links.ts) the way
// hidden accounts are: every id the account has had takes its end, each id
// subtracted with its own kind (recorded on the link), so history recorded
// under an earlier id stops counting from the same day, and a re-added
// account linked to a closed one is closed too. Of two entries on one
// account, its current id's wins, then the newest.
//
// EACH ENTRY CARRIES what reading it needs when nothing live can say: the
// account's type (to sign its balance when it is taken out of a past total,
// as lib/hidden.ts keeps one), how to name it (a closed account soon
// vanishes from every live list), and its currency where the write knew it
// (to price it where it is listed after its bank stops returning it:
// allocation over time, the API). A map store on the storage seam
// (lib/repo.ts), keyed by account id (a provider's own id, or a manual
// account's random one), exportable: it is the person's own account of
// their accounts.
//
// STRICT, AND LOUD. Every reader that decides what counts reads this store
// strictly: an entry that can't be read throws (UnreadableEntriesError), and
// the net-worth route, the transactions, the API and sharing fail with it
// rather than count an account the person closed. The stored shape is closed
// (isLifecycleEntry): a later release's entry is unrecognised, never read as
// something it isn't. Only an entry whose bytes are damaged may be removed,
// and only once the person confirms (removeUnreadable, app/api/account-lifecycle).

import { defineMapStore, StoredDataUnreadableError, UnreadableEntriesError, type MapStore } from './repo';
import type { Ctx } from './containers';
import { isCalendarDay, addDays } from './manual-txn-input';
import { resolveId, sameAccountIds, getLinks, effectiveLinks, type Link } from './link-core';
import { liveAccountIds } from './links';
import {
  writeAutoNote,
  removeAutoNote,
  writeMissedNote,
  removeAccountNotes,
  newMissedNoteId,
  isMissedNoteId,
  legacyMissedNoteId,
  moveMissedNote,
  removeMissedNote,
} from './timeline-notes';
import { readHistoryPoints, type EndedAccounts } from './history';

export type { EndedAccounts } from './history';

export type LifecycleState = 'active' | 'closed' | 'left' | 'untracked';
export const LIFECYCLE_STATES: readonly LifecycleState[] = ['active', 'closed', 'left', 'untracked'];

/** The issue's model, as stored and exported. */
export type AccountLifecycle =
  | { state: 'active' }
  | { state: 'closed'; on: string; note?: string }
  | { state: 'left'; on: string; note?: string }
  | { state: 'untracked'; from: string };

export type EndedLifecycle = Exclude<AccountLifecycle, { state: 'active' }>;

/** What a question about an account asked (lib/lifecycle-questions.ts). */
export type QuestionKind = 'missing' | 'zero';

/** How to name an account once no live list has it. */
export type AccountLabel = { name: string; institution: string; mask: string | null };

/** One account's lifecycle, under the id it had when it was set. */
export type LifecycleEntry = {
  lifecycle: AccountLifecycle;
  /** The account's kind when this was set (depository, credit…), or null when
   *  nothing said: what signs its balance when it is taken out of a past
   *  total. A balance of an account of unknown kind can't be signed, so a
   *  point holding one is left out of the chart rather than guessed at. */
  type: string | null;
  label: AccountLabel;
  /** Its Plaid connection; null for a manual account. */
  item_id: string | null;
  /** Its balance's currency, where the write knew it (an ISO code, or
   *  Plaid's unofficial one): what a reader listing it once its bank no
   *  longer does prices it in. Kept through later writes that don't know it. */
  currency?: string;
  /** When this was saved (an ISO time). */
  set_at: string;
  /** Only with `closed`: Nya recorded it because nobody answered the question
   *  about an account missing from its bank's answer within the grace window
   *  (lib/lifecycle-questions.ts). Shown as assumed, and lifted by itself if
   *  the account comes back. */
  assumed?: true;
  /** Only with `active`: the question "Still open" answered, so the same one
   *  isn't asked again (and a missing account stays held, not assumed, for
   *  STILL_OPEN_HOLD_DAYS from `set_at`). */
  answered?: { kind: QuestionKind; since: string };
  /** The windows it was missing from its bank's answer and assumed closed,
   *  before it came back (liftAssumedClosures), oldest first: the totals
   *  recorded on those days are short of it (shortDays). Any state; kept
   *  through every later change, the newest MAX_MISSED. */
  missed?: MissedWindow[];
  /** Only with closed and left: the balance it showed when its end was set
   *  or last confirmed (null when that wasn't known), and the UTC day. A bank
   *  still returning it with another balance, or with a transaction after
   *  that day, raises the question again (lib/lifecycle-questions.ts
   *  askAboutReportedEnds). `checked`: the UTC day its transactions were
   *  last read for that, at most once a day, with the newest found after
   *  `through` then (`txn`); a write by the person drops both. */
  seen?: { balance: number | null; through: string; checked?: string; txn?: string };
};

/** Days an account was missing from its bank's answer, first and last, and
 *  the id its note on the timeline is kept under (a random one,
 *  lib/timeline-notes.ts newMissedNoteId; absent on a window recorded before
 *  windows kept it, until adoptMissedNotes gives it one). */
export type MissedWindow = { from: string; to: string; note?: string };

/** The longest note on a closure, in characters. */
export const LIFECYCLE_NOTE_MAX = 200;
/** How many missing windows an entry keeps: the newest. */
export const MAX_MISSED = 20;
/** How long a "Still open" answer about a missing account holds it, and with
 *  it every total, from the answer: then Nya asks again, and unanswered, the
 *  grace window ends in an assumed closure as for any missing account
 *  (lib/vanished.ts). An answer can't pause history for good. */
export const STILL_OPEN_HOLD_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The largest balance an entry records: anything past it isn't a balance. */
const BALANCE_MAX = 1e15;
/** The earliest end date: nothing in Nya is older. */
export const FIRST_END_DAY = '1970-01-01';
const LABEL_MAX = 200;
const TYPE = /^[a-z][a-z0-9_ -]{0,39}$/;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A currency as Plaid gives one: ISO 4217's three letters, or an
 *  unofficial code (a cryptocurrency's). */
const CURRENCY = /^[A-Za-z0-9]{2,12}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !CONTROL.test(v);

/** A day an end may fall on: a real calendar day, from FIRST_END_DAY on. */
export function isEndDay(v: unknown): v is string {
  return isCalendarDay(v) && v >= FIRST_END_DAY;
}

/** A note on a closure as stored: trimmed, one line, 1 to LIFECYCLE_NOTE_MAX. */
export function isLifecycleNote(v: unknown): v is string {
  return isText(v, LIFECYCLE_NOTE_MAX) && v.length > 0 && v.trim() === v;
}

/** The model, closed: each state with exactly its own fields. */
export function isAccountLifecycle(v: unknown): v is AccountLifecycle {
  if (!isRecord(v)) return false;
  switch (v.state) {
    case 'active':
      return onlyKeys(v, ['state']);
    case 'closed':
    case 'left':
      return onlyKeys(v, ['state', 'on', 'note']) && isEndDay(v.on) && (v.note === undefined || isLifecycleNote(v.note));
    case 'untracked':
      return onlyKeys(v, ['state', 'from']) && isEndDay(v.from);
    default:
      return false;
  }
}

function isLabel(v: unknown): v is AccountLabel {
  return (
    isRecord(v) &&
    onlyKeys(v, ['name', 'institution', 'mask']) &&
    isText(v.name, LABEL_MAX) &&
    isText(v.institution, LABEL_MAX) &&
    (v.mask === null || isText(v.mask, 20))
  );
}

/** The stored shape, closed: a field this release doesn't know makes the
 *  entry unrecognised (see the header). */
export function isLifecycleEntry(v: unknown): v is LifecycleEntry {
  if (!isRecord(v) || !onlyKeys(v, ['lifecycle', 'type', 'label', 'item_id', 'currency', 'set_at', 'assumed', 'answered', 'missed', 'seen'])) return false;
  if (v.currency !== undefined && !(typeof v.currency === 'string' && CURRENCY.test(v.currency))) return false;
  if (!isAccountLifecycle(v.lifecycle)) return false;
  if (!(v.type === null || (typeof v.type === 'string' && TYPE.test(v.type)))) return false;
  if (!isLabel(v.label)) return false;
  if (!(v.item_id === null || (typeof v.item_id === 'string' && ID.test(v.item_id)))) return false;
  if (!isTime(v.set_at)) return false;
  if (v.assumed !== undefined && !(v.assumed === true && v.lifecycle.state === 'closed')) return false;
  if (v.answered !== undefined) {
    const a = v.answered;
    if (v.lifecycle.state !== 'active' || !isRecord(a) || !onlyKeys(a, ['kind', 'since'])) return false;
    if (!(a.kind === 'missing' || a.kind === 'zero') || !isEndDay(a.since)) return false;
  }
  if (v.missed !== undefined) {
    if (!Array.isArray(v.missed) || v.missed.length === 0 || v.missed.length > MAX_MISSED) return false;
    for (const w of v.missed) {
      if (!isRecord(w) || !onlyKeys(w, ['from', 'to', 'note']) || !isEndDay(w.from) || !isEndDay(w.to) || w.from > w.to) return false;
      if (w.note !== undefined && !isMissedNoteId(w.note)) return false;
    }
  }
  if (v.seen !== undefined) {
    const s = v.seen;
    if (!(v.lifecycle.state === 'closed' || v.lifecycle.state === 'left') || !isRecord(s) || !onlyKeys(s, ['balance', 'through', 'checked', 'txn'])) return false;
    if (!(s.balance === null || (typeof s.balance === 'number' && Number.isFinite(s.balance) && Math.abs(s.balance) <= BALANCE_MAX))) return false;
    if (!isEndDay(s.through)) return false;
    if ((s.checked !== undefined && !isEndDay(s.checked)) || (s.txn !== undefined && !isEndDay(s.txn))) return false;
  }
  return true;
}

/** A balance as an entry records it: a finite number within reason, or null. */
export const isRecordedBalance = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= BALANCE_MAX);

export const lifecycleStore: MapStore<LifecycleEntry> = defineMapStore<LifecycleEntry>('account-lifecycle', {
  what: 'account closures',
  isValid: isLifecycleEntry,
  exportable: true, // what the person said of their accounts, and when
});

// ---- Reading the model ----

/** The day an account stops counting: `on` for closed and left, `from` for
 *  untracked; null while it is active. */
export function endOf(lifecycle: AccountLifecycle): string | null {
  switch (lifecycle.state) {
    case 'closed':
    case 'left':
      return lifecycle.on;
    case 'untracked':
      return lifecycle.from;
    default:
      return null;
  }
}

/** Whether the account counts on a day (a YYYY-MM-DD): every day before its
 *  end, and every day while it has none. */
export function countsOn(lifecycle: AccountLifecycle, day: string): boolean {
  const end = endOf(lifecycle);
  return end === null || day < end;
}

/** The UTC day of an instant, as history keys its days. */
export const utcDay = (now: number = Date.now()) => new Date(now).toISOString().slice(0, 10);

/**
 * The last day an end may be set on, from `now`: today, as the person's own
 * calendar has it, which for anyone east of Greenwich can be the UTC day after
 * (history keys its days in UTC). An end is a thing that happened: never
 * further ahead than that.
 */
export const lastEndDay = (now: number = Date.now()) => addDays(utcDay(now), 1);

/** Whether an end has come, for the live total: any end up to lastEndDay.
 *  The person's "closed today" leaves the total at once, wherever they are. */
export function endedNow(lifecycle: AccountLifecycle, now: number = Date.now()): boolean {
  const end = endOf(lifecycle);
  return end !== null && end <= lastEndDay(now);
}

/** What applies to every id of every account with an entry. */
export type LifecycleView = {
  /** Each account with an entry, under its current id: the entry that
   *  applies (its current id's, else the newest), and the id it is stored
   *  under. */
  accounts: Map<string, { entry: LifecycleEntry; stored: string }>;
  /** Every id of every account with an entry, to its current id. */
  rootOf: Map<string, string>;
  /** Every id of every account with an end, with the day it stops counting
   *  and the kind each id is subtracted as: what lib/history.ts reads. */
  ended: EndedAccounts;
  /** The raw entries, by the id each is stored under. */
  entries: Map<string, LifecycleEntry>;
};

export const EMPTY_VIEW: LifecycleView = Object.freeze({
  accounts: new Map(),
  rootOf: new Map(),
  ended: new Map(),
  entries: new Map(),
}) as LifecycleView;

/**
 * Applies account links to the stored entries (see KEYED TO SURVIVE A
 * RE-LINK). `links` are the links that apply (lib/link-core.ts
 * effectiveLinks): a paused link, whose earlier id is live again, joins two
 * live accounts, and must not carry one's end to the other. Pure.
 */
export function effectiveLifecycle(entries: ReadonlyMap<string, LifecycleEntry>, links: ReadonlyMap<string, Link>): LifecycleView {
  const linkMap = links as Map<string, Link>;
  const accounts = new Map<string, { entry: LifecycleEntry; stored: string }>();
  const ids = [...entries.keys()].sort();
  for (const id of ids) {
    const entry = entries.get(id)!;
    const root = resolveId(id, linkMap);
    const held = accounts.get(root);
    // The current id's own entry wins; else the newest (ties by id, so the
    // answer never depends on the order the store gave them in).
    if (!held || (held.stored !== root && (id === root || entry.set_at > held.entry.set_at))) accounts.set(root, { entry, stored: id });
  }
  const rootOf = new Map<string, string>();
  const ended = new Map<string, { type: string | null; from: string }>();
  for (const [root, { entry }] of accounts) {
    const end = endOf(entry.lifecycle);
    for (const id of sameAccountIds(root, linkMap)) {
      rootOf.set(id, root);
      if (end === null) continue;
      // Each id is subtracted with ITS OWN kind, recorded on the link when it
      // was made (as lib/links.ts expandHidden does); the entry's is the
      // fallback.
      const oldType = linkMap.get(id)?.evidence?.old_type;
      ended.set(id, { type: typeof oldType === 'string' ? oldType : entry.type, from: end });
    }
  }
  return { accounts, rootOf, ended, entries: new Map(entries) };
}

/** The entry that applies to an account, by any of its ids, or null. */
export function lifecycleOf(view: LifecycleView, id: string): LifecycleEntry | null {
  const root = view.rootOf.get(id);
  return root ? (view.accounts.get(root)?.entry ?? null) : null;
}

/** Every id of every account ended by now (endedNow): what the live total,
 *  the Accounts tab and the Plan leave out. */
export function endedNowIds(view: LifecycleView, now: number = Date.now()): Set<string> {
  const out = new Set<string>();
  for (const [id, root] of view.rootOf) {
    const entry = view.accounts.get(root)?.entry;
    if (entry && endedNow(entry.lifecycle, now)) out.add(id);
  }
  return out;
}

/** Every id of every account with an end, with the day it stops counting:
 *  for a reader that drops what is dated on or after it (transactions). */
export function endDays(view: LifecycleView): Map<string, string> {
  return new Map([...view.ended].map(([id, { from }]) => [id, from]));
}

/** What a closed or left account showed, as the question about one its bank
 *  still returns reads it (lib/lifecycle-questions.ts askAboutReportedEnds):
 *  as recorded, or, with nothing recorded, a closed account's zero (a left
 *  one's not known) through the day before its end. Null for any other. */
export function seenOf(entry: LifecycleEntry): NonNullable<LifecycleEntry['seen']> | null {
  const l = entry.lifecycle;
  if (l.state !== 'closed' && l.state !== 'left') return null;
  return entry.seen ?? { balance: l.state === 'closed' ? 0 : null, through: addDays(l.on, -1) };
}

/**
 * Records that an ended account's transactions were read for that question:
 * the day (`checked`) and the newest found after what was seen (`txn`), so
 * they are read at most once a day. Only while the entry still says what was
 * read against (the same end, the same balance and day seen): a change the
 * person made meanwhile is never written over. One with nothing recorded
 * gets what it read as (seenOf). A compare-and-set.
 */
export async function recordReportedCheck(
  ctx: Ctx,
  id: string,
  read: { on: string; balance: number | null; through: string },
  checked: string,
  txn: string | null
): Promise<void> {
  await lifecycleStore.update(ctx, id, (current) => {
    const s = current ? seenOf(current) : null;
    if (!current || !s || endOf(current.lifecycle) !== read.on || s.balance !== read.balance || s.through !== read.through) return current;
    return { ...current, seen: { balance: s.balance, through: s.through, checked, ...(txn ? { txn } : {}) } };
  });
}

/** What the vanished-account guard (lib/vanished.ts) needs of the answers. */
export type LifecycleAnswers = {
  /** Every id of every account with an end (an assumed closure among them):
   *  answered, so its absence holds nothing. */
  ended: Set<string>;
  /** Per Plaid connection, the ids the person said are still open while they
   *  were missing from its answer, within STILL_OPEN_HOLD_DAYS of saying so:
   *  held, never assumed closed. Only the id each answer was given for, on
   *  the connection it belongs to. */
  stillOpen: Map<string, Set<string>>;
  /** The ids whose "Still open" is older than that, to when it lapsed: asked
   *  again, with a grace window counted from then. */
  reaskFrom: Map<string, string>;
  /** Every id of each assumed closure, to the id the entry is stored under:
   *  lifted when the account comes back. */
  assumed: Map<string, string>;
};

/** When a "Still open" answer about a missing account stops holding it (an
 *  ISO time), or null for any other entry. */
export function stillOpenUntil(entry: LifecycleEntry): string | null {
  if (entry.lifecycle.state !== 'active' || entry.answered?.kind !== 'missing') return null;
  const at = Date.parse(entry.set_at);
  return Number.isFinite(at) ? new Date(at + STILL_OPEN_HOLD_DAYS * DAY_MS).toISOString() : null;
}

/** Whether an entry is a "Still open" answer about a missing account that
 *  still holds it (see STILL_OPEN_HOLD_DAYS). */
export function holdsStillOpen(entry: LifecycleEntry | null | undefined, now: number = Date.now()): boolean {
  const until = entry ? stillOpenUntil(entry) : null;
  return until !== null && now < Date.parse(until);
}

/** The answers, from the view, as they stand at `now`. Pure. */
export function answersFrom(view: LifecycleView, now: number = Date.now()): LifecycleAnswers {
  const ended = new Set(view.ended.keys());
  const stillOpen = new Map<string, Set<string>>();
  const reaskFrom = new Map<string, string>();
  const assumed = new Map<string, string>();
  for (const [id, entry] of view.entries) {
    const until = stillOpenUntil(entry);
    if (until === null || !entry.item_id) continue;
    if (now >= Date.parse(until)) {
      reaskFrom.set(id, until);
      continue;
    }
    const set = stillOpen.get(entry.item_id) ?? new Set<string>();
    set.add(id);
    stillOpen.set(entry.item_id, set);
  }
  for (const [root, { entry, stored }] of view.accounts) {
    if (!entry.assumed) continue;
    for (const [id, r] of view.rootOf) if (r === root) assumed.set(id, stored);
  }
  return { ended, stillOpen, reaskFrom, assumed };
}

/**
 * The days whose recorded totals are known to be short of an account: the
 * windows it was missing and assumed closed before it came back (`missed`),
 * on the days it counts (before any end it has since been given), never for
 * a hidden one (left out of every total anyway). getHistory leaves those
 * points out, so the chart bridges the hole rather than draw a dip that never
 * happened. The real layer keeps them as written. Pure.
 */
export function shortDays(view: LifecycleView, hidden: ReadonlyMap<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const [id, entry] of view.entries) {
    if (!entry.missed?.length) continue;
    const root = view.rootOf.get(id) ?? id;
    if (hidden.has(id) || hidden.has(root)) continue;
    const applies = view.accounts.get(root)?.entry ?? entry;
    for (const w of entry.missed) {
      for (let day = w.from; day <= w.to; day = addDays(day, 1)) if (countsOn(applies.lifecycle, day)) out.add(day);
    }
  }
  return out;
}

/** Strict: every entry, or UnreadableEntriesError. */
export async function readLifecycleEntries(ctx: Ctx): Promise<Map<string, LifecycleEntry>> {
  return lifecycleStore.getAll(ctx);
}

/**
 * Why an earlier account can't be forgotten while it has an end, or null.
 * From its end on, an account is taken out of each stored total by its own
 * balances (getHistory): forgetting those (lib/links.ts forgetEarlierAccount)
 * would put it back into every total from its end, and forgetting promises
 * the past totals stay as they were. So it is refused only when that would
 * change a point: an account not reported after its end, the usual closure,
 * is forgotten as any other. A hidden one is folded out of every total by
 * the forget itself. Strict: closures that can't be read throw.
 */
export async function endedForgetRefusal(ctx: Ctx, id: string, hidden: boolean): Promise<string | null> {
  if (hidden) return null;
  const entry = await lifecycleStore.get(ctx, id);
  const end = entry ? endOf(entry.lifecycle) : null;
  if (!entry || !end) return null;
  const ended: EndedAccounts = new Map([[id, { type: entry.type, from: end }]]);
  // The points as read, before bridging, which the end's step alone would
  // set apart.
  const [withEnd, without] = await Promise.all([readHistoryPoints(ctx, undefined, ended).then((r) => r.points), readHistoryPoints(ctx).then((r) => r.points)]);
  const same = withEnd.length === without.length && withEnd.every((p, i) => p.date === without[i].date && p.value === without[i].value);
  if (same) return null;
  return `It stopped counting on ${end}, but balances after that are recorded, and forgetting them would put it back into your totals from then on. Reopen it first if that is what you want.`;
}

/**
 * Forgetting an earlier account (lib/links.ts forgetEarlierAccount) takes its
 * closure, which names it, and Nya's note about it, which does too. A note
 * that can't be read holds nothing anyone can read, and is passed over.
 */
export async function forgetLifecycle(ctx: Ctx, id: string): Promise<void> {
  await lifecycleStore.update(ctx, id, () => null);
  await removeAccountNotes(ctx, id).catch((err) => {
    if (!(err instanceof StoredDataUnreadableError)) throw err;
  });
}

/** A read that failed on closures that can't be read: the dashboard then
 *  offers to remove the damaged ones (app/api/account-lifecycle, repair). */
export const isLifecycleUnreadable = (err: unknown): err is UnreadableEntriesError =>
  err instanceof UnreadableEntriesError && err.what === lifecycleStore.what;

/**
 * The view, read strictly. `links` are the links that apply, when the caller
 * has them already (the net-worth route reads them with the hidden set);
 * null says they couldn't be read, which only matters when something has an
 * entry: then this throws, as the hidden set does, rather than leave an
 * earlier id of a closed account counting.
 */
export async function getEffectiveLifecycle(ctx: Ctx, links: ReadonlyMap<string, Link> | null): Promise<LifecycleView> {
  const entries = await readLifecycleEntries(ctx);
  if (entries.size === 0) return EMPTY_VIEW;
  if (links === null) throw new Error('Account links could not be read, so which of their ids are closed can’t be told');
  return effectiveLifecycle(entries, links);
}

/**
 * The view for a reader with no links in hand (sharing, allocation over time):
 * the entries, and only when there are some, the links that apply, read as
 * the hidden set reads them (lib/links.ts getEffectiveHidden): live ids that
 * can't be read pause no link, which can only end more, never count more.
 * `readOnly` changes nothing while reading (someone else's read). Strict.
 */
export async function readLifecycleView(ctx: Ctx, opts: { readOnly?: boolean } = {}): Promise<LifecycleView> {
  const entries = await readLifecycleEntries(ctx);
  if (entries.size === 0) return EMPTY_VIEW;
  const [links, live] = await Promise.all([getLinks(ctx), liveAccountIds(ctx, { strict: true, readOnly: opts.readOnly }).catch(() => new Set<string>())]);
  return effectiveLifecycle(entries, effectiveLinks(links, live));
}

// ---- Words ----

/** "Ally Savings ••1234". */
export function accountWords(label: AccountLabel): string {
  const name = label.name.trim() || 'An account';
  return label.mask ? `${name} ••${label.mask}` : name;
}

/** The auto note an end writes on its day (lib/timeline-notes.ts). */
export function autoNoteText(entry: Pick<LifecycleEntry, 'lifecycle' | 'label' | 'assumed'>): string | null {
  const who = accountWords(entry.label);
  const at = entry.label.institution ? ` at ${entry.label.institution}` : '';
  const l = entry.lifecycle;
  const why = (l.state === 'closed' || l.state === 'left') && l.note ? `: ${l.note}` : '';
  switch (l.state) {
    case 'closed':
      return entry.assumed ? `${who} assumed closed: it stopped appearing${at}` : `${who} closed${why}`;
    case 'left':
      return `${who} no longer yours${why}`;
    case 'untracked':
      return `${who} no longer tracked`;
    default:
      return null;
  }
}

// ---- Writing ----

/** What an entry needs to know about its account, besides its lifecycle:
 *  `currency` where the writer knows it. */
export type AccountAbout = { type: string | null; label: AccountLabel; item_id: string | null; currency?: string | null };

/** Cleans what a write was told about an account into the stored shape:
 *  long names cut, an unknown kind as null, a currency that isn't one left
 *  out. */
export function cleanAbout(about: AccountAbout): Pick<LifecycleEntry, 'type' | 'label' | 'item_id' | 'currency'> {
  const text = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const mask = about.label.mask === null ? null : text(about.label.mask, 20) || null;
  return {
    type: about.type !== null && TYPE.test(about.type) ? about.type : null,
    label: { name: text(about.label.name, LABEL_MAX), institution: text(about.label.institution, LABEL_MAX), mask },
    item_id: about.item_id !== null && ID.test(about.item_id) ? about.item_id : null,
    ...(typeof about.currency === 'string' && CURRENCY.test(about.currency) ? { currency: about.currency } : {}),
  };
}

/** Writes or moves the auto note an entry implies, or removes it. Best
 *  effort: a note that can't be written leaves the end itself in place, and
 *  the next change writes it. */
async function noteFor(ctx: Ctx, account_id: string, entry: LifecycleEntry | null, now: number): Promise<void> {
  try {
    const end = entry ? endOf(entry.lifecycle) : null;
    const text = entry ? autoNoteText(entry) : null;
    if (end && text) await writeAutoNote(ctx, account_id, end, text, now);
    else await removeAutoNote(ctx, account_id);
  } catch (err) {
    console.error('Account lifecycle: its note on the timeline could not be saved', err instanceof Error ? err.name : typeof err);
  }
}

/** The auto notes of an account's other ids (through the links that apply)
 *  go: its current entry wins over theirs, so the chart marks the one change
 *  that entry says, never a stale one beside it. Best effort, as notes are. */
async function dropOtherNotes(ctx: Ctx, account_id: string, links: ReadonlyMap<string, Link>, now: number): Promise<void> {
  for (const id of sameAccountIds(account_id, links as Map<string, Link>)) if (id !== account_id) await noteFor(ctx, id, null, now);
}

/** What every write carries over from the entry it replaces: the windows the
 *  account was missing (see the header), and its currency when the write
 *  (`base`) wasn't told one. */
const kept = (current: LifecycleEntry | null, base?: Pick<LifecycleEntry, 'currency'>): Pick<LifecycleEntry, 'missed' | 'currency'> => ({
  ...(current?.missed?.length ? { missed: current.missed } : {}),
  ...(!base?.currency && current?.currency ? { currency: current.currency } : {}),
});

/** An entry's currency, as a spread: none when it has none. */
const currencyOf = (e: Pick<LifecycleEntry, 'currency'> | null | undefined): Pick<LifecycleEntry, 'currency'> => (e?.currency ? { currency: e.currency } : {});

/** "Mar 13": a UTC day, as the notes Nya writes say one (they are read in
 *  any time zone, and a history day is a UTC day). */
const shortDay = (day: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));

/** The note on a window an account was missing (liftAssumedClosures). */
export function missedNoteText(label: AccountLabel, window: MissedWindow): string {
  const who = accountWords(label);
  const at = label.institution ? ` at ${label.institution}` : '';
  const span = window.from === window.to ? `on ${shortDay(window.from)}` : `from ${shortDay(window.from)} to ${shortDay(window.to)}`;
  return `${who} was missing${at} ${span}, so the totals saved then, short of it, are left out`;
}

/**
 * Sets an account's end, as the person said: closed or left on a day (with a
 * note), or untracked from one. Replaces whatever was there for that id (an
 * assumed closure becomes theirs), in one compare-and-set, and writes its
 * note on the timeline, the only one for the account (`links`, the links
 * that apply). `seen` is the balance the person was shown when they said so,
 * when the app knew it: what a bank still returning the account is compared
 * with (askAboutReportedEnds). Without it, what was seen before stays.
 * Validation of the day against today is the route's (lastEndDay).
 */
export async function markEnded(
  ctx: Ctx,
  account_id: string,
  lifecycle: EndedLifecycle,
  about: AccountAbout,
  now: number = Date.now(),
  links: ReadonlyMap<string, Link> = new Map(),
  seen?: { balance: number | null }
): Promise<LifecycleEntry> {
  const base: LifecycleEntry = { lifecycle, ...cleanAbout(about), set_at: new Date(now).toISOString() };
  let entry = base;
  await lifecycleStore.update(ctx, account_id, (current) => {
    const keepsSeen = lifecycle.state === 'closed' || lifecycle.state === 'left';
    // What was seen, never the last check of it: an end changed may change
    // which transactions come after it, so they are read again.
    const seenNow = seen && isRecordedBalance(seen.balance) ? { balance: seen.balance, through: utcDay(now) } : current?.seen ? { balance: current.seen.balance, through: current.seen.through } : undefined;
    entry = { ...base, ...kept(current, base), ...(keepsSeen && seenNow ? { seen: seenNow } : {}) };
    return entry;
  });
  await noteFor(ctx, account_id, entry, now);
  await dropOtherNotes(ctx, account_id, links, now);
  return entry;
}

/**
 * "Still open": the person's answer to a question about an account, recorded
 * so the question isn't asked again and a missing account is held rather
 * than assumed closed (lib/lifecycle-questions.ts), for STILL_OPEN_HOLD_DAYS.
 * Also what reopening an account its bank no longer returns does
 * (reopenMissing). Takes away any end, and its note.
 */
export async function markStillOpen(
  ctx: Ctx,
  account_id: string,
  answered: { kind: QuestionKind; since: string },
  about: AccountAbout,
  now: number = Date.now(),
  links: ReadonlyMap<string, Link> = new Map()
): Promise<LifecycleEntry> {
  const base: LifecycleEntry = { lifecycle: { state: 'active' }, ...cleanAbout(about), set_at: new Date(now).toISOString(), answered };
  let entry = base;
  await lifecycleStore.update(ctx, account_id, (current) => {
    entry = { ...base, ...kept(current, base) };
    return entry;
  });
  await noteFor(ctx, account_id, null, now);
  await dropOtherNotes(ctx, account_id, links, now);
  return entry;
}

/** Takes an entry's end and answers away, keeping only what every entry
 *  keeps (`missed`): null when that is nothing. */
function withoutEnd(current: LifecycleEntry | null, now: number): LifecycleEntry | null {
  if (!current?.missed?.length) return null;
  return { lifecycle: { state: 'active' }, type: current.type, label: current.label, item_id: current.item_id, ...currencyOf(current), set_at: new Date(now).toISOString(), missed: current.missed };
}

/**
 * Reopens an account: every entry on every id it has had (through the links
 * that apply) goes, with its note, so nothing an earlier id says keeps it
 * ended (an entry that keeps missing windows stays, active). Exact: nothing
 * was ever removed from storage, so every day reads as it did before it was
 * ended. For an account its bank no longer returns, see reopenMissing.
 * Returns the ids whose entries changed.
 */
export async function reopenAccount(ctx: Ctx, account_id: string, links: ReadonlyMap<string, Link>, now: number = Date.now()): Promise<string[]> {
  const ids = sameAccountIds(account_id, links as Map<string, Link>);
  const stored = await lifecycleStore.getMany(ctx, ids);
  const gone: string[] = [];
  for (const id of ids) {
    if (!stored.has(id)) continue;
    await lifecycleStore.update(ctx, id, (current) => withoutEnd(current, now));
    gone.push(id);
    await noteFor(ctx, id, null, now);
  }
  return gone;
}

/**
 * Reopens an account its bank no longer returns: no live answer lists it, so
 * deleting its end would leave it nowhere (no row, no question, no hold) while
 * totals went on being saved without it. Instead it is answered "Still open"
 * to the question about it going missing: held at its last known balance and
 * asked about, as any missing account is, until its bank returns it or the
 * person says it closed (lib/lifecycle-questions.ts). `entry` is the one that
 * applies to it now; its other ids' entries go, as in reopenAccount.
 */
export async function reopenMissing(
  ctx: Ctx,
  account_id: string,
  entry: LifecycleEntry,
  links: ReadonlyMap<string, Link>,
  now: number = Date.now()
): Promise<LifecycleEntry> {
  for (const id of sameAccountIds(account_id, links as Map<string, Link>)) {
    if (id === account_id || !(await lifecycleStore.get(ctx, id))) continue;
    await lifecycleStore.update(ctx, id, (current) => withoutEnd(current, now));
    await noteFor(ctx, id, null, now);
  }
  // The last day it was there: the day before its end, or today.
  const end = endOf(entry.lifecycle);
  const before = end ? addDays(end, -1) : utcDay(now);
  const since = isEndDay(before) ? before : (end ?? utcDay(now));
  return markStillOpen(ctx, account_id, { kind: 'missing', since }, { type: entry.type, label: entry.label, item_id: entry.item_id, currency: entry.currency }, now, links);
}

/** One account the guard is about to assume closed. */
export type AssumeInput = { account_id: string; on: string; about: AccountAbout };

/**
 * Records assumed closures (lib/lifecycle-questions.ts, THE WAY OUT), each in
 * one compare-and-set, and returns the ids that now have an end: assumed
 * here, or ended already. Only an answer that settles a missing account
 * stands: an end the person gave (or an assumption already made), and a
 * "Still open" about it going missing that still holds it, which keeps it
 * held (not returned, so it isn't accepted). Anything else is replaced by
 * the assumed closure, with its note: no entry, a "Still open" about a zero
 * balance (another question), one about it going missing that has lapsed
 * (STILL_OPEN_HOLD_DAYS), and a repair's placeholder. Nothing short of that
 * may let an account that is gone be accepted with no end recorded: the gate
 * would reopen and every total be saved without it, silently. One that can't
 * be recorded is left out, so it stays held and is tried again; storage out
 * of reach throws for the caller to hold them all.
 */
export async function recordAssumedClosures(ctx: Ctx, inputs: AssumeInput[], now: number = Date.now()): Promise<Set<string>> {
  const answered = new Set<string>();
  for (const { account_id, on, about } of inputs) {
    const base: LifecycleEntry = { lifecycle: { state: 'closed', on }, ...cleanAbout(about), set_at: new Date(now).toISOString(), assumed: true };
    let outcome = 'assumed' as 'ended' | 'held' | 'assumed';
    let assumed = base;
    try {
      await lifecycleStore.update(ctx, account_id, (current) => {
        if (current && endOf(current.lifecycle) !== null) {
          outcome = 'ended';
          return current;
        }
        if (holdsStillOpen(current, now)) {
          outcome = 'held';
          return current;
        }
        outcome = 'assumed';
        assumed = { ...base, ...kept(current, base) };
        return assumed;
      });
    } catch (err) {
      console.error('Account lifecycle: an assumed closure could not be recorded, so the account stays held', err instanceof Error ? err.name : typeof err);
      continue;
    }
    if (outcome === 'held') continue;
    answered.add(account_id);
    if (outcome === 'assumed') await noteFor(ctx, account_id, assumed, now);
  }
  return answered;
}

/**
 * Lifts assumed closures whose accounts came back in a healthy answer: the
 * assumption was only ever a way out of holding, and the account is
 * measured again. Each only while it is still an assumption (a confirmed
 * closure stays). The days between its assumed end and today were saved
 * without it, so they are short of it: the entry keeps them as a missing
 * window (`missed`, the chart leaves them out) and a note on the timeline
 * says so, in place of the assumption's. Best effort: one left is lifted
 * next time. Returns the stored ids lifted.
 */
export async function liftAssumedClosures(ctx: Ctx, storedIds: Iterable<string>, now: number = Date.now()): Promise<string[]> {
  const lifted: string[] = [];
  for (const id of new Set(storedIds)) {
    let lift = false;
    let window: MissedWindow | null = null;
    let label: AccountLabel | null = null;
    let dropped: MissedWindow[] = [];
    // Chosen once, so a retried compare-and-set keeps the same.
    const note = newMissedNoteId();
    try {
      await lifecycleStore.update(ctx, id, (current) => {
        lift = !!current?.assumed;
        dropped = [];
        if (!current || !lift) return current;
        const from = endOf(current.lifecycle)!;
        const to = addDays(utcDay(now), -1);
        // Back the day it was assumed gone from: no day was saved short.
        window = from <= to ? { from, to, note } : null;
        label = current.label;
        const all = [...(current.missed ?? []), ...(window ? [window] : [])];
        dropped = all.slice(0, Math.max(0, all.length - MAX_MISSED));
        const missed = all.slice(-MAX_MISSED);
        if (missed.length === 0) return null;
        return { lifecycle: { state: 'active' }, type: current.type, label: current.label, item_id: current.item_id, ...currencyOf(current), set_at: new Date(now).toISOString(), missed };
      });
    } catch (err) {
      console.error('Account lifecycle: an assumed closure could not be lifted', err instanceof Error ? err.name : typeof err);
      continue;
    }
    if (!lift) continue;
    lifted.push(id);
    await noteFor(ctx, id, null, now);
    const w = window as MissedWindow | null;
    if (w && label) {
      await writeMissedNote(ctx, note, id, w.from, missedNoteText(label, w), now).catch((err) =>
        console.error('Account lifecycle: the note on a missing window could not be saved', err instanceof Error ? err.name : typeof err)
      );
    }
    // A window no longer kept leaves no days out, so its note, which says
    // they are, goes with it.
    for (const old of dropped) {
      await removeMissedNote(ctx, old.note ?? legacyMissedNoteId(id, old.from), id).catch((err) =>
        console.error('Account lifecycle: the note on a missing window no longer kept could not be removed', err instanceof Error ? err.name : typeof err)
      );
    }
  }
  return lifted;
}

/** Whether any entry has a missing window without its note's id. */
export function hasUnkeyedWindows(entries: ReadonlyMap<string, LifecycleEntry>): boolean {
  for (const entry of entries.values()) if (entry.missed?.some((w) => !w.note)) return true;
  return false;
}

/**
 * Gives each missing window recorded before windows kept their notes' ids a
 * random one, and moves its note there from the id it was written under,
 * which named the account and the window's first day (a day in a plaintext
 * field name, which the seam forbids); a window whose note isn't there gets
 * one written. The id is recorded on the window first, in one
 * compare-and-set, then the note is moved (moveMissedNote): a failure after
 * the first step leaves the old note where it was, still shown and still
 * removed with the account (removeAccountNotes finds notes by account).
 * Once each window has its id this reads and writes nothing
 * (hasUnkeyedWindows), so it runs where the windows are made, beside the
 * vanished-account guard (lib/vanished.ts). Returns the windows given ids.
 */
export async function adoptMissedNotes(ctx: Ctx, entries: ReadonlyMap<string, LifecycleEntry>, now: number = Date.now()): Promise<number> {
  let adopted = 0;
  for (const [id, entry] of entries) {
    if (!entry.missed?.some((w) => !w.note)) continue;
    // Chosen once per window, so a retried compare-and-set records the same.
    const chosen = new Map<string, string>();
    let given: { window: MissedWindow; label: AccountLabel }[] = [];
    await lifecycleStore.update(ctx, id, (current) => {
      given = [];
      if (!current?.missed?.some((w) => !w.note)) return current;
      const missed = current.missed.map((w) => {
        if (w.note) return w;
        const key = `${w.from}|${w.to}`;
        const note = chosen.get(key) ?? newMissedNoteId();
        chosen.set(key, note);
        const keyed = { ...w, note };
        given.push({ window: keyed, label: current.label });
        return keyed;
      });
      return { ...current, missed };
    });
    for (const { window, label } of given) {
      await moveMissedNote(ctx, legacyMissedNoteId(id, window.from), window.note!, id, window.from, missedNoteText(label, window), now);
      adopted++;
    }
  }
  return adopted;
}

/**
 * Removes the entries whose bytes are damaged, once the person confirmed:
 * the only removal the seam allows (lib/repo.ts, READS). Unrecognised ones
 * are intact data and stay, named. Each is removed only while it is still
 * the damaged bytes read, never one written since.
 */
export async function removeUnreadable(ctx: Ctx): Promise<{ removed: string[]; unrecognised: string[] }> {
  const report = await lifecycleStore.getAllReport(ctx);
  const removed: string[] = [];
  for (const id of report.unreadable) {
    // Put back as nothing: replaceUnreadable writes a value, so a placeholder
    // goes in and is then removed only if it is still the one written.
    const placeholder: LifecycleEntry = {
      lifecycle: { state: 'active' },
      type: null,
      label: { name: '', institution: '', mask: null },
      item_id: null,
      set_at: new Date(0).toISOString(),
    };
    if (await lifecycleStore.replaceUnreadable(ctx, id, placeholder)) {
      await lifecycleStore.update(ctx, id, (current) => (current && current.set_at === placeholder.set_at && current.label.name === '' ? null : current));
      removed.push(id);
    }
  }
  return { removed, unrecognised: report.unrecognised };
}

// ---- For the app ----

type EndingInstitution = {
  accounts: { account_id: string; type?: string; balance?: number | null }[];
  holdings: { account_id?: string }[];
  unshown_accounts?: { account_id: string }[];
};

/** A row applyLifecycle took out: what it held, and the day it stopped
 *  counting. */
export type EndedRow = { account_id: string; type: string | null; balance: number | null; end: string };

/**
 * Takes every account ended by now (endedNow) out of the live institutions:
 * its row, its positions and its name among the accounts a broken
 * institution can't show. So the live total, the Accounts tab's cards, the
 * Plan, allocation and every figure the dashboard adds up leave it out,
 * without each having to know. A hidden one stays: it is left out of every
 * total already, and the Hidden card lists it from its row. Display only, on
 * a fetch that has been recorded already: storage never changes. Returns the
 * rows taken out.
 */
export function applyLifecycle(institutions: EndingInstitution[], view: LifecycleView, hidden: ReadonlyMap<string, unknown>, now: number = Date.now()): EndedRow[] {
  const ended = endedNowIds(view, now);
  const out: EndedRow[] = [];
  if (ended.size === 0) return out;
  const gone = (id: string | undefined) => !!id && ended.has(id) && !hidden.has(id);
  for (const inst of institutions) {
    for (const a of inst.accounts) {
      if (!gone(a.account_id)) continue;
      const end = endOf(lifecycleOf(view, a.account_id)?.lifecycle ?? { state: 'active' });
      if (end) out.push({ account_id: a.account_id, type: a.type ?? null, balance: typeof a.balance === 'number' ? a.balance : null, end });
    }
    inst.accounts = inst.accounts.filter((a) => !gone(a.account_id));
    inst.holdings = inst.holdings.filter((h) => !gone(h.account_id));
    if (inst.unshown_accounts) {
      const shown = inst.unshown_accounts.filter((a) => !gone(a.account_id));
      if (shown.length > 0) inst.unshown_accounts = shown;
      else delete inst.unshown_accounts;
    }
  }
  return out;
}

/** An ended account as the Accounts tab and the chart read it: one per
 *  account, under its current id. */
export type LifecycleForClient = {
  account_id: string;
  lifecycle: EndedLifecycle;
  assumed?: true;
  label: AccountLabel;
  type: string | null;
  /** A Plaid connection's id; null for a manual account. */
  item_id: string | null;
  set_at: string;
};

/** Every account with an end, for the app, in name order. */
export function lifecycleForClient(view: LifecycleView): LifecycleForClient[] {
  const out: LifecycleForClient[] = [];
  for (const [account_id, { entry }] of view.accounts) {
    const l = entry.lifecycle;
    if (l.state === 'active') continue;
    out.push({
      account_id,
      lifecycle: l,
      ...(entry.assumed ? { assumed: true as const } : {}),
      label: entry.label,
      type: entry.type,
      item_id: entry.item_id,
      set_at: entry.set_at,
    });
  }
  return out.sort((a, b) => accountWords(a.label).localeCompare(accountWords(b.label)) || (a.account_id < b.account_id ? -1 : 1));
}
