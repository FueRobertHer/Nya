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
// hidden account that also ended is subtracted once, as hidden.
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
// as lib/hidden.ts keeps one) and how to name it (a closed account soon
// vanishes from every live list). A map store on the storage seam
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

import { defineMapStore, UnreadableEntriesError, type MapStore } from './repo';
import type { Ctx } from './containers';
import { isCalendarDay, addDays } from './manual-txn-input';
import { resolveId, sameAccountIds, getLinks, effectiveLinks, type Link } from './link-core';
import { liveAccountIds } from './links';
import { writeAutoNote, removeAutoNote } from './timeline-notes';
import type { EndedAccounts } from './history';

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
  /** When this was saved (an ISO time). */
  set_at: string;
  /** Only with `closed`: Nya recorded it because nobody answered the question
   *  about an account missing from its bank's answer within the grace window
   *  (lib/lifecycle-questions.ts). Shown as assumed, and lifted by itself if
   *  the account comes back. */
  assumed?: true;
  /** Only with `active`: the question "Still open" answered, so the same one
   *  isn't asked again (and a missing account stays held, not assumed). */
  answered?: { kind: QuestionKind; since: string };
};

/** The longest note on a closure, in characters. */
export const LIFECYCLE_NOTE_MAX = 200;
/** The earliest end date: nothing in Nya is older. */
export const FIRST_END_DAY = '1970-01-01';
const LABEL_MAX = 200;
const TYPE = /^[a-z][a-z0-9_ -]{0,39}$/;
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

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
  if (!isRecord(v) || !onlyKeys(v, ['lifecycle', 'type', 'label', 'item_id', 'set_at', 'assumed', 'answered'])) return false;
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
  return true;
}

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

/** What the vanished-account guard (lib/vanished.ts) needs of the answers. */
export type LifecycleAnswers = {
  /** Every id of every account with an end (an assumed closure among them):
   *  answered, so its absence holds nothing. */
  ended: Set<string>;
  /** Per Plaid connection, the ids the person said are still open while they
   *  were missing from its answer: held, never assumed closed. Only the id
   *  each answer was given for, on the connection it belongs to. */
  stillOpen: Map<string, Set<string>>;
  /** Every id of each assumed closure, to the id the entry is stored under:
   *  lifted when the account comes back. */
  assumed: Map<string, string>;
};

/** The answers, from the view. Pure. */
export function answersFrom(view: LifecycleView): LifecycleAnswers {
  const ended = new Set(view.ended.keys());
  const stillOpen = new Map<string, Set<string>>();
  const assumed = new Map<string, string>();
  for (const [id, entry] of view.entries) {
    if (entry.lifecycle.state === 'active' && entry.answered?.kind === 'missing' && entry.item_id) {
      const set = stillOpen.get(entry.item_id) ?? new Set<string>();
      set.add(id);
      stillOpen.set(entry.item_id, set);
    }
  }
  for (const [root, { entry, stored }] of view.accounts) {
    if (!entry.assumed) continue;
    for (const [id, r] of view.rootOf) if (r === root) assumed.set(id, stored);
  }
  return { ended, stillOpen, assumed };
}

/** Strict: every entry, or UnreadableEntriesError. */
export async function readLifecycleEntries(ctx: Ctx): Promise<Map<string, LifecycleEntry>> {
  return lifecycleStore.getAll(ctx);
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

/** What an entry needs to know about its account, besides its lifecycle. */
export type AccountAbout = { type: string | null; label: AccountLabel; item_id: string | null };

/** Cleans what a write was told about an account into the stored shape:
 *  long names cut, an unknown kind as null. */
export function cleanAbout(about: AccountAbout): AccountAbout {
  const text = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const mask = about.label.mask === null ? null : text(about.label.mask, 20) || null;
  return {
    type: about.type !== null && TYPE.test(about.type) ? about.type : null,
    label: { name: text(about.label.name, LABEL_MAX), institution: text(about.label.institution, LABEL_MAX), mask },
    item_id: about.item_id !== null && ID.test(about.item_id) ? about.item_id : null,
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

/**
 * Sets an account's end, as the person said: closed or left on a day (with a
 * note), or untracked from one. Replaces whatever was there for that id (an
 * assumed closure becomes theirs), in one compare-and-set, and writes its
 * note on the timeline. Validation of the day against today is the route's
 * (lastEndDay).
 */
export async function markEnded(ctx: Ctx, account_id: string, lifecycle: EndedLifecycle, about: AccountAbout, now: number = Date.now()): Promise<LifecycleEntry> {
  const entry: LifecycleEntry = { lifecycle, ...cleanAbout(about), set_at: new Date(now).toISOString() };
  await lifecycleStore.update(ctx, account_id, () => entry);
  await noteFor(ctx, account_id, entry, now);
  return entry;
}

/**
 * "Still open": the person's answer to a question about an account, recorded
 * so the question isn't asked again and a missing account is held rather
 * than assumed closed (lib/lifecycle-questions.ts). Also what reopening a
 * held account does. Takes away any end, and its note.
 */
export async function markStillOpen(
  ctx: Ctx,
  account_id: string,
  answered: { kind: QuestionKind; since: string },
  about: AccountAbout,
  now: number = Date.now()
): Promise<LifecycleEntry> {
  const entry: LifecycleEntry = { lifecycle: { state: 'active' }, ...cleanAbout(about), set_at: new Date(now).toISOString(), answered };
  await lifecycleStore.update(ctx, account_id, () => entry);
  await noteFor(ctx, account_id, null, now);
  return entry;
}

/**
 * Reopens an account: every entry on every id it has had (through the links
 * that apply) goes, with its note, so nothing an earlier id says keeps it
 * ended. Exact: nothing was ever removed from storage, so every day reads as
 * it did before it was ended. Returns the ids whose entries went.
 */
export async function reopenAccount(ctx: Ctx, account_id: string, links: ReadonlyMap<string, Link>, now: number = Date.now()): Promise<string[]> {
  const ids = sameAccountIds(account_id, links as Map<string, Link>);
  const stored = await lifecycleStore.getMany(ctx, ids);
  const gone: string[] = [];
  for (const id of ids) {
    if (!stored.has(id)) continue;
    await lifecycleStore.update(ctx, id, () => null);
    gone.push(id);
    await noteFor(ctx, id, null, now);
  }
  return gone;
}

/** One account the guard is about to assume closed. */
export type AssumeInput = { account_id: string; on: string; about: AccountAbout };

/**
 * Records assumed closures (lib/lifecycle-questions.ts, THE WAY OUT), each in
 * one compare-and-set that writes only where there is no entry: an answer
 * the person gave meanwhile always wins. Returns the ids that now have an
 * answer (assumed here, or already answered). One that can't be recorded is
 * left out, so it stays held and is tried again; storage out of reach throws
 * for the caller to hold them all.
 */
export async function recordAssumedClosures(ctx: Ctx, inputs: AssumeInput[], now: number = Date.now()): Promise<Set<string>> {
  const answered = new Set<string>();
  for (const { account_id, on, about } of inputs) {
    const assumed: LifecycleEntry = { lifecycle: { state: 'closed', on }, ...cleanAbout(about), set_at: new Date(now).toISOString(), assumed: true };
    let wrote = false;
    try {
      await lifecycleStore.update(ctx, account_id, (current) => {
        wrote = current === null;
        return current ?? assumed;
      });
    } catch (err) {
      console.error('Account lifecycle: an assumed closure could not be recorded, so the account stays held', err instanceof Error ? err.name : typeof err);
      continue;
    }
    answered.add(account_id);
    if (wrote) await noteFor(ctx, account_id, assumed, now);
  }
  return answered;
}

/**
 * Lifts assumed closures whose accounts came back in a healthy answer: the
 * assumption was only ever a way out of holding, and the account is
 * measured again. Each only while it is still an assumption (a confirmed
 * closure stays). Best effort: one left is lifted next time. Returns the
 * stored ids lifted.
 */
export async function liftAssumedClosures(ctx: Ctx, storedIds: Iterable<string>, now: number = Date.now()): Promise<string[]> {
  const lifted: string[] = [];
  for (const id of new Set(storedIds)) {
    let lift = false;
    try {
      await lifecycleStore.update(ctx, id, (current) => {
        lift = !!current?.assumed;
        return lift ? null : current;
      });
    } catch (err) {
      console.error('Account lifecycle: an assumed closure could not be lifted', err instanceof Error ? err.name : typeof err);
      continue;
    }
    if (!lift) continue;
    lifted.push(id);
    await noteFor(ctx, id, null, now);
  }
  return lifted;
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
  accounts: { account_id: string }[];
  holdings: { account_id?: string }[];
  unshown_accounts?: { account_id: string }[];
};

/**
 * Takes every account ended by now (endedNow) out of the live institutions:
 * its row, its positions and its name among the accounts a broken
 * institution can't show. So the live total, the Accounts tab's cards, the
 * Plan, allocation and every figure the dashboard adds up leave it out,
 * without each having to know. A hidden one stays: it is left out of every
 * total already, and the Hidden card lists it from its row. Display only, on
 * a fetch that has been recorded already: storage never changes. Returns the
 * ids taken out.
 */
export function applyLifecycle(institutions: EndingInstitution[], view: LifecycleView, hidden: ReadonlyMap<string, unknown>, now: number = Date.now()): Set<string> {
  const ended = endedNowIds(view, now);
  const out = new Set<string>();
  if (ended.size === 0) return out;
  const gone = (id: string | undefined) => !!id && ended.has(id) && !hidden.has(id);
  for (const inst of institutions) {
    for (const a of inst.accounts) if (gone(a.account_id)) out.add(a.account_id);
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
