// lib/review-store.ts
//
// The review queue (master plan M3, ranked request 14): which transactions
// the person has approved, and whether the queue is on and since when. What
// approving means on read (needs review, approved, changed since) is
// lib/review-layer.ts, applied in the read layer every reader shares
// (lib/activity.ts finishActivity, through lib/txn-layers.ts).
//
// TWO STORES on the storage seam (lib/repo.ts), both encrypted and in the
// person's download:
//   - `transaction-approvals`, a map store, one record per approved
//     transaction under its id (Plaid's own, a manual, imported or SimpleFIN
//     row's "manual-txn:<uuid>", or a row's imported into a linked account,
//     "imported-txn:<uuid>"), never under anything taken from what it says.
//     A record is the transaction as the person saw it when they approved it:
//     its amount and currency, the category it was filed under (by id), the
//     merchant's name as shown, and whether it was pending. That is what
//     "this is right as it is now" means, and what a later read compares
//     against (lib/review-layer.ts): a bank that changes the amount puts the
//     transaction back in the queue, saying why; a rule, a merchant's default
//     or the bank's own category never moves an approved transaction to
//     another category, only offers it.
//   - `review-settings`, a value store: whether the queue is on, and the
//     first day whose transactions need review (`since`).
//
// WHAT NEEDS REVIEW is decided on read, never stored: a transaction from the
// bank, SimpleFIN or a file (one entered by hand is the person's own, so
// never), dated on or after `since`, with no approval that still holds. So
// turning the queue on never marks years of history to review: the queue
// starts from the day picked (today, or up to 31 days before), and a file of
// last year's transactions imported next month adds none. Off, nothing needs
// review and every approval is kept, still holding what it holds.
//
// ONE TRANSACTION, ONE RECORD, as lib/spending.ts transactionCounter counts
// them: a split transaction is approved whole, under its own id (its parts
// are what it counts as, never what is approved); each transaction of a group
// is approved on its own, never the group's row.
//
// THE SHAPES ARE CLOSED. A field this release doesn't know makes a record
// unrecognised, never half read: an approval a later release qualifies
// (approved for one part only, say) must not read here as approving the
// whole. Such a record leaves its transaction's review not known (the
// Activity tab says so), and nothing saves over it.
//
// STRICT. Every write reads what it replaces strictly first, so an approval
// that can't be read is never replaced or removed unseen (409, as every seam
// store answers); the display read (readApprovalsForDisplay) reads only the
// shown rows' records (getMany), names those it can't use, and never takes
// them for "not approved", which would put an approved transaction back in
// the queue. Only damaged records are ever offered for removal, once the
// person confirms (repairReview).
//
// GONE WITH ITS TRANSACTION, as what was said about a transaction is
// (lib/txn-annotations.ts) and at the same moments (lib/split-gone.ts): a
// bank transaction's approval goes once no stored Item holds it (after a
// sync saves the bank's removal, a disconnect or a forget; nothing while a
// store can't be read or is behind, never a record this release doesn't
// recognise), and a manual or imported row's with the row. A pending
// transaction's approval moves to the posted one the bank replaces it with
// (carryApprovalsToPosted, when the sync that brings it saves), since it is
// the same transaction. Approvals are not carried across a re-link: a
// re-linked account's transactions since the queue began need review again
// (docs/features.md says why).
//
// SIZE. The read layer reads the shown rows' records (getMany, a few
// thousand at most), never the whole store; the prune and the download read
// it whole, rarely. MAX_APPROVALS bounds it.

import { defineMapStore, defineValueStore, UnreadableEntriesError } from './repo';
import type { Ctx } from './containers';
import { isTransactionId } from './txn-annotations';
import { isCalendarDay, MANUAL_TXN_PREFIX } from './manual-txn-input';
import { IMPORTED_TXN_PREFIX } from './history-import/view';
import { isSplitOrGroupId } from './split-rows';
import { MAX_NAME_CHARS, MAX_PER_REQUEST, MAX_SINCE_DAYS } from './review-layer';

export const APPROVAL_VERSION = 1;

/** One approved transaction, as the person saw it when they approved it. */
export type Approval = {
  version: typeof APPROVAL_VERSION;
  /** When it was approved. */
  approved_at: string;
  /** Its amount then, in Plaid's sign (positive is money out). */
  amount: number;
  /** Its currency then (an ISO code, or Plaid's unofficial one), or null for
   *  a row that says none. */
  currency: string | null;
  /** The category it was filed under then, by id (lib/categories.ts
   *  categoryById follows a merge to where it went); null when it showed
   *  none the app had stored (a provisional id is never kept). */
  category_id: string | null;
  /** The merchant's name as it was shown then. */
  name: string;
  /** Approved while the bank still had it pending. */
  pending?: true;
};

/** Whether the queue is on, and since when. */
export type ReviewSettings = {
  version: 1;
  on: boolean;
  /** The first day whose transactions need review, YYYY-MM-DD, by the day
   *  each is dated (the bank's posting day, a file's day). */
  since: string;
  updated_at: string;
};

// ---- Limits ----

/** Approvals a container keeps: years of a busy household's transactions,
 *  and a bound on the prune's and the download's reads of the whole store. */
export const MAX_APPROVALS = 50_000;
/** How many approvals making room forgets (makeRoom): the oldest, by when
 *  they were made. */
export const ROOM = 10_000;
/** Transactions one request approves or puts back, how far before today the
 *  queue may start, and a merchant's name as an approval takes it: shared
 *  with the views (lib/review-layer.ts, safe in the browser). */
export { MAX_PER_REQUEST, MAX_SINCE_DAYS, MAX_NAME_CHARS } from './review-layer';

// ---- The stored shapes ----

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const isInstant = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
/** A category id as stored (lib/category-store.ts takes the same). */
export const CATEGORY_ID = /^[A-Za-z0-9_:-]{1,80}$/;
/** A currency as a row carries it: ISO's code, or Plaid's unofficial one. */
export const CURRENCY = /^[A-Z0-9]{2,10}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The stored bounds are wider than an approval may make, so a record saved
 *  under other limits still reads. */
const STORED_NAME = 1000;
const MAX_AMOUNT = 1e13;

export function isApproval(v: unknown): v is Approval {
  return (
    isRecord(v) &&
    only(v, ['version', 'approved_at', 'amount', 'currency', 'category_id', 'name', 'pending']) &&
    v.version === APPROVAL_VERSION &&
    isInstant(v.approved_at) &&
    typeof v.amount === 'number' &&
    Number.isFinite(v.amount) &&
    Math.abs(v.amount) <= MAX_AMOUNT &&
    (v.currency === null || (typeof v.currency === 'string' && CURRENCY.test(v.currency))) &&
    (v.category_id === null || (typeof v.category_id === 'string' && CATEGORY_ID.test(v.category_id))) &&
    typeof v.name === 'string' &&
    v.name.length <= STORED_NAME &&
    (v.pending === undefined || v.pending === true)
  );
}

export function isReviewSettings(v: unknown): v is ReviewSettings {
  return (
    isRecord(v) &&
    only(v, ['version', 'on', 'since', 'updated_at']) &&
    v.version === 1 &&
    typeof v.on === 'boolean' &&
    typeof v.since === 'string' &&
    DAY.test(v.since) &&
    isInstant(v.updated_at)
  );
}

export const approvalStore = defineMapStore<Approval>('transaction-approvals', {
  what: 'approvals',
  isValid: isApproval,
  exportable: true, // which transactions the person approved, and as what
});

export const reviewSettingsStore = defineValueStore<ReviewSettings>('review-settings', {
  what: 'review queue settings',
  isValid: isReviewSettings,
  exportable: true, // whether the person reviews new transactions, and since when
});

/** A transaction's id as an approval is kept under: never a part's, a
 *  remainder's or a group's row's (lib/split-rows.ts). */
export function isApprovalId(id: unknown): id is string {
  return isTransactionId(id) && !isSplitOrGroupId(id);
}

/** A bank's transaction, which a prune can find gone: not a manual row's nor
 *  one imported into a linked account, which go with their rows. */
const isBankId = (id: string) => !id.startsWith(MANUAL_TXN_PREFIX) && !id.startsWith(IMPORTED_TXN_PREFIX);

// ---- Errors ----

/** An approval refused for what it asked, with the route's status: nothing
 *  was saved. */
export class ApprovalError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

// ---- Reading ----

/**
 * The approvals of these transactions, for the read layer (lib/activity.ts):
 * `approvals`, and `unknown`, the ids whose approval couldn't be read or
 * isn't recognised. A display read that never fails for the records' own sake
 * (storage failing still throws): a transaction in `unknown` shows its review
 * as not known, never as needing it, and nothing writes on this answer; an
 * approve or an undo of it is refused by the writes below.
 */
export async function readApprovalsForDisplay(ctx: Ctx, ids: Iterable<string>): Promise<{ approvals: Map<string, Approval>; unknown: Set<string> }> {
  const wanted = [...new Set([...ids].filter(isApprovalId))];
  const unknown = new Set<string>();
  // Most people never approve anything: one count (readable or not) saves
  // reading the rows' ids one by one on every load.
  if (wanted.length === 0 || (await approvalStore.count(ctx)) === 0) return { approvals: new Map(), unknown };
  // getMany is strict and names every record it can't use: those are set
  // aside and the rest read again (twice more at most, should a record be
  // damaged in between).
  for (let attempt = 0; ; attempt++) {
    const rest = wanted.filter((id) => !unknown.has(id));
    if (rest.length === 0) return { approvals: new Map(), unknown };
    try {
      return { approvals: await approvalStore.getMany(ctx, rest), unknown };
    } catch (err) {
      if (!(err instanceof UnreadableEntriesError) || attempt >= 2) throw err;
      for (const id of [...err.unreadable, ...err.unrecognised]) unknown.add(id);
    }
  }
}

/**
 * The queue's settings, for the read layer and the app: `settings` (null when
 * never saved), and whether they couldn't be read (`unreadable`, damaged, or
 * `unrecognised`, a later release's). A display read: either way nothing is
 * marked to review, never every transaction, and the change routes refuse to
 * save over them.
 */
export async function readReviewSettings(ctx: Ctx): Promise<{ settings: ReviewSettings | null; unreadable: boolean; unrecognised: boolean }> {
  const { value, unreadable, unrecognised } = await reviewSettingsStore.getReport(ctx);
  return { settings: value, unreadable, unrecognised };
}

// ---- The queue ----

/**
 * Turns the queue on, from `since` (the first day whose transactions need
 * review): one compare-and-set on the settings, refused (UnreadableValueError)
 * over settings that can't be read. Turning it on again starts it again from
 * the new day; the approvals made before are kept.
 */
export async function startReview(ctx: Ctx, since: string, now: Date = new Date()): Promise<ReviewSettings> {
  const next: ReviewSettings = { version: 1, on: true, since, updated_at: now.toISOString() };
  return (await reviewSettingsStore.update(ctx, () => next))!;
}

/** Turns the queue off: nothing needs review, every approval is kept. Null
 *  when it was never turned on. Refused over settings that can't be read. */
export async function stopReview(ctx: Ctx, now: Date = new Date()): Promise<ReviewSettings | null> {
  return reviewSettingsStore.update(ctx, (current) => (current && current.on ? { ...current, on: false, updated_at: now.toISOString() } : current));
}

// ---- Approving ----

/** A transaction approved as the person saw it (see Approval). */
export type ApprovalInput = {
  transaction_id: string;
  amount: number;
  currency: string | null;
  category_id: string | null;
  name: string;
  pending: boolean;
};

/**
 * Approves transactions as they were shown, each replacing any approval it
 * had, and answers when, and what each had before (null for none), which an
 * undo puts back (undoApprovals). Every approval is read strictly first: one
 * that can't be read refuses the whole (UnreadableEntriesError), so nothing is
 * written over it unseen. New approvals past MAX_APPROVALS are refused whole
 * (409), saying what makes room (makeRoom). One request, last write wins
 * against another device's approval of the same transaction (both say it was
 * right as shown).
 */
export async function approve(
  ctx: Ctx,
  items: readonly ApprovalInput[],
  now: Date = new Date(),
  max: number = MAX_APPROVALS
): Promise<{ approved_at: string; previous: Map<string, Approval | null> }> {
  const byId = new Map(items.map((i) => [i.transaction_id, i]));
  const ids = [...byId.keys()];
  const current = await approvalStore.getMany(ctx, ids);
  const fresh = ids.filter((id) => !current.has(id)).length;
  if (fresh > 0 && (await approvalStore.count(ctx)) + fresh > max) {
    throw new ApprovalError(
      `Nya keeps at most ${max.toLocaleString('en-US')} approvals, and approving these would pass that. To make room, forget your ${ROOM.toLocaleString('en-US')} oldest on the Review queue card under Manage: those transactions stay, filed as ones you never approved are, by your rules, your defaults and the bank.`,
      409
    );
  }
  const approved_at = now.toISOString();
  await approvalStore.setMany(
    ctx,
    [...byId.values()].map((i) => [
      i.transaction_id,
      {
        version: APPROVAL_VERSION,
        approved_at,
        amount: i.amount,
        currency: i.currency,
        category_id: i.category_id,
        name: i.name,
        ...(i.pending ? { pending: true as const } : {}),
      },
    ])
  );
  return { approved_at, previous: new Map(ids.map((id) => [id, current.get(id) ?? null])) };
}

/** An approval to undo: the transaction, when the approval being undone was
 *  made (`approved_at`, as approve answered it), and what it replaced. */
export type UndoItem = { transaction_id: string; approved_at: string; previous: Approval | null };

/**
 * Undoes approvals: each transaction whose approval is still the one being
 * undone (made at `approved_at`) gets back what it had before, or none. One
 * approved again since (here or on another device) is left as it is. Read
 * strictly first, as approving is. Answers how many were put back.
 */
export async function undoApprovals(ctx: Ctx, items: readonly UndoItem[]): Promise<number> {
  const ids = [...new Set(items.map((i) => i.transaction_id))];
  const current = await approvalStore.getMany(ctx, ids);
  const restore: [string, Approval][] = [];
  const drop: string[] = [];
  const done = new Set<string>();
  for (const item of items) {
    const now = current.get(item.transaction_id);
    if (done.has(item.transaction_id) || !now || now.approved_at !== item.approved_at) continue;
    done.add(item.transaction_id);
    if (item.previous) restore.push([item.transaction_id, item.previous]);
    else drop.push(item.transaction_id);
  }
  if (restore.length > 0) await approvalStore.setMany(ctx, restore);
  if (drop.length > 0) await approvalStore.remove(ctx, ...drop);
  return restore.length + drop.length;
}

/**
 * After the person gives an approved transaction a category of their own
 * (app/api/recategorize): its approval says so too, so what it holds is what
 * the transaction shows, and a category it no longer shows is never kept in
 * use by it (lib/category-usage.ts). Nothing for a transaction not approved.
 * One compare-and-set; refused over an approval that can't be read.
 */
export async function noteRecategorized(ctx: Ctx, transaction_id: string, category_id: string): Promise<void> {
  if (!isApprovalId(transaction_id)) return;
  await approvalStore.update(ctx, transaction_id, (current) => (current && current.category_id !== category_id ? { ...current, category_id } : current));
}

/**
 * After the person edits the amount or the currency of a row of theirs (one
 * entered or imported into a manual account: app/api/manual-transactions):
 * the edit is their own word, so its approval, when it has one, follows it,
 * rather than putting the row back in the queue as if the bank had changed
 * it. Nothing for a row not approved. One compare-and-set; refused over an
 * approval that can't be read.
 */
export async function followEdit(ctx: Ctx, transaction_id: string, now: { amount: number; currency: string | null }): Promise<void> {
  if (!isApprovalId(transaction_id)) return;
  await approvalStore.update(ctx, transaction_id, (current) =>
    current && (current.amount !== now.amount || current.currency !== now.currency) ? { ...current, amount: now.amount, currency: now.currency } : current
  );
}

/**
 * Makes room once approvals near MAX_APPROVALS, as the person asks (the
 * Review queue card): forgets the `n` oldest approvals by when they were made
 * (`approved_at`), readable ones only (a damaged one is the repair's). Their
 * transactions stay, filed as a transaction never approved is (the person's
 * own category, their rules, their merchants' defaults, the bank), and those
 * dated in the queue's days wait for review again. Answers how many went and
 * when the newest of them was made. One read of the whole store (bounded by
 * MAX_APPROVALS), then removes by id: an approval made again in between may
 * go with them, which the person, having asked, can approve again.
 */
export async function makeRoom(ctx: Ctx, n = ROOM): Promise<{ removed: number; through: string | null }> {
  const { entries } = await approvalStore.getAllReport(ctx);
  const oldest = [...entries].sort(([, a], [, b]) => (a.approved_at < b.approved_at ? -1 : a.approved_at > b.approved_at ? 1 : 0)).slice(0, Math.max(0, n));
  const ids = oldest.map(([id]) => id);
  for (let i = 0; i < ids.length; i += 1000) await approvalStore.remove(ctx, ...ids.slice(i, i + 1000));
  return { removed: ids.length, through: oldest.length > 0 ? oldest[oldest.length - 1][1].approved_at : null };
}

// ---- Gone with the transaction ----

/** Forgets the approvals of transactions that are gone (a deleted manual
 *  row, every row of a deleted account, an import undone), readable or not:
 *  nothing can show them again. */
export async function forgetApprovals(ctx: Ctx, transaction_ids: readonly string[]): Promise<void> {
  const ids = transaction_ids.filter(isApprovalId);
  for (let i = 0; i < ids.length; i += 1000) await approvalStore.remove(ctx, ...ids.slice(i, i + 1000));
}

/**
 * The bank transactions' approvals a prune may forget once no stored Item
 * holds them (lib/split-gone.ts pruneSplitsAndGroups, by the rules of
 * lib/txn-annotations.ts pruneOrphanAnnotations): every one, or, with
 * `among`, those of these transactions only (the ones a sync just saw the
 * bank remove), read by id rather than the whole store. Damaged ones go with
 * their transaction too; one this release doesn't recognise is never among
 * them, kept for the release that wrote it. A manual row's and one imported
 * into a linked account go with their rows, never here.
 */
export async function approvalsToPrune(ctx: Ctx, among?: ReadonlySet<string>): Promise<string[]> {
  if (!among) {
    const { entries, unreadable } = await approvalStore.getAllReport(ctx);
    return [...entries.keys(), ...unreadable].filter(isBankId);
  }
  const wanted = [...among].filter((id) => isApprovalId(id) && isBankId(id));
  if (wanted.length === 0) return [];
  const damaged: string[] = [];
  const skip = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    const rest = wanted.filter((id) => !skip.has(id));
    try {
      return [...(await approvalStore.getMany(ctx, rest)).keys(), ...damaged];
    } catch (err) {
      if (!(err instanceof UnreadableEntriesError) || attempt >= 2) throw err;
      damaged.push(...err.unreadable);
      for (const id of [...err.unreadable, ...err.unrecognised]) skip.add(id);
    }
  }
}

/**
 * A pending transaction's approval, moved to the posted one the bank replaced
 * it with: the bank gives the posted one a new id, naming the pending one
 * (pending_transaction_id), and removes the pending one, in the sync that
 * brings it (lib/transactions.ts, before the removed rows' records are
 * pruned). It is the same transaction, so it stays approved, as it was seen
 * while pending: a posted amount that differs (a tip added) puts it back in
 * the queue, saying so (lib/review-layer.ts). A posted one approved in its
 * own right keeps its own. An approval that can't be read moves nothing.
 * Answers how many moved.
 */
export async function carryApprovalsToPosted(
  ctx: Ctx,
  removed: ReadonlySet<string>,
  rows: Iterable<{ transaction_id: string; pending_transaction_id: string | null; pending: boolean }>
): Promise<number> {
  const postedFor = new Map<string, string>();
  for (const r of rows) {
    const from = r.pending_transaction_id;
    if (!r.pending && from && removed.has(from) && !postedFor.has(from) && isApprovalId(r.transaction_id)) postedFor.set(from, r.transaction_id);
  }
  if (postedFor.size === 0) return 0;
  const read = await readApprovalsForDisplay(ctx, [...postedFor.keys(), ...postedFor.values()]);
  let moved = 0;
  for (const [pendingId, postedId] of postedFor) {
    const approval = read.approvals.get(pendingId);
    if (!approval || read.unknown.has(postedId)) continue;
    await approvalStore.update(ctx, postedId, (current) => current ?? approval);
    await approvalStore.remove(ctx, pendingId);
    moved++;
  }
  return moved;
}

// ---- What a request asks (app/api/review) ----

/** The days it can be anywhere at `now` (UTC-12 to UTC+14): a day a page
 *  says is today is one of these. */
export function currentDays(now: number = Date.now()): string[] {
  const at = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return [...new Set([at(now - 12 * 3600_000), at(now), at(now + 14 * 3600_000)])];
}

/** The day a page says is today, when it can be today somewhere, else the
 *  UTC day: a stale or forged day never starts the queue elsewhere. */
export function todayOf(asked: unknown, now: number = Date.now()): string {
  return typeof asked === 'string' && currentDays(now).includes(asked) ? asked : new Date(now).toISOString().slice(0, 10);
}

/** A day YYYY-MM-DD `days` before `day`. */
export function daysBefore(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** The first day the queue reviews: `since`, today when absent, from today
 *  back at most MAX_SINCE_DAYS, never after it. ApprovalError otherwise. */
export function startDay(since: unknown, today: string): string {
  if (since === undefined || since === null) return today;
  if (!isCalendarDay(since)) throw new ApprovalError('The day to start from is a date, YYYY-MM-DD.');
  if (since > today) throw new ApprovalError('The queue can’t start after today.');
  if (since < daysBefore(today, MAX_SINCE_DAYS)) {
    throw new ApprovalError(`The queue can start at most ${MAX_SINCE_DAYS} days back, so years of history never fill it.`);
  }
  return since;
}

const APPROVAL_INPUT_KEYS = ['transaction_id', 'amount', 'currency', 'category_id', 'name', 'pending'] as const;

/** A list from a request: an array of 1 to MAX_PER_REQUEST objects. */
function listOf(raw: unknown, what: string): Record<string, unknown>[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ApprovalError(`Say which ${what}.`);
  if (raw.length > MAX_PER_REQUEST) throw new ApprovalError(`At most ${MAX_PER_REQUEST} ${what} at a time.`);
  if (!raw.every(isRecord)) throw new ApprovalError(`Each of the ${what} is an object.`);
  return raw as Record<string, unknown>[];
}

/** A transaction id a request names, checked: a transaction's own, never a
 *  part's, a remainder's or a group's row's. */
function idOf(v: unknown): string {
  if (!isApprovalId(v) || (v.startsWith(MANUAL_TXN_PREFIX) && !/^[A-Za-z0-9_.:-]{12,200}$/.test(v))) throw new ApprovalError('Invalid transaction id');
  return v;
}

/**
 * The approvals a request asks for, each the transaction as the page showed
 * it: exactly `transaction_id`, `amount` (a number, Plaid's sign), `currency`
 * (a code, or null), `category_id` (an id, or null; a provisional one, of
 * categories that couldn't be read, is kept as null), `name` (text, at most
 * MAX_NAME_CHARS) and `pending` (true or false). Anything else, or a field
 * missing or of another type, is refused (ApprovalError), never guessed.
 */
export function parseApprovals(raw: unknown): ApprovalInput[] {
  return listOf(raw, 'transactions to approve').map((item) => {
    const extra = Object.keys(item).find((k) => !(APPROVAL_INPUT_KEYS as readonly string[]).includes(k));
    if (extra !== undefined) throw new ApprovalError(`${extra.slice(0, 40)} isn’t part of an approval.`);
    const { amount, currency, category_id, name, pending } = item;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) > MAX_AMOUNT) throw new ApprovalError('Each approval needs the amount it was shown with.');
    if (!(currency === null || (typeof currency === 'string' && CURRENCY.test(currency)))) throw new ApprovalError('A currency is a code, or null.');
    if (!(category_id === null || (typeof category_id === 'string' && CATEGORY_ID.test(category_id)))) throw new ApprovalError('Invalid category id');
    if (typeof name !== 'string' || name.length > MAX_NAME_CHARS) throw new ApprovalError(`A name is text, at most ${MAX_NAME_CHARS} characters.`);
    if (typeof pending !== 'boolean') throw new ApprovalError('Say whether it is pending.');
    return {
      transaction_id: idOf(item.transaction_id),
      amount,
      currency,
      // A provisional id (lib/categories.ts isProvisionalId) names no stored
      // category, so it would file nothing later.
      category_id: category_id === null || category_id.includes(':') ? null : category_id,
      name: name.normalize('NFC'),
      pending,
    };
  });
}

/** The approvals to undo a request names: exactly `transaction_id`,
 *  `approved_at` (as the approval answered it) and `previous` (the approval
 *  it replaced, as answered, or null). Refused otherwise (ApprovalError). */
export function parseUndo(raw: unknown): UndoItem[] {
  return listOf(raw, 'approvals to undo').map((item) => {
    if (Object.keys(item).some((k) => k !== 'transaction_id' && k !== 'approved_at' && k !== 'previous')) throw new ApprovalError('An undo names a transaction, when it was approved, and what it had before.');
    if (!isInstant(item.approved_at)) throw new ApprovalError('Say when the approval being undone was made.');
    if (!(item.previous === null || isApproval(item.previous))) throw new ApprovalError('What it had before isn’t an approval.');
    return { transaction_id: idOf(item.transaction_id), approved_at: item.approved_at, previous: item.previous };
  });
}

// ---- Repair ----

/**
 * Removes the approvals whose bytes are damaged, and the settings if theirs
 * are, once the person has confirmed (app/api/review, repair): nothing
 * readable is lost, and one this release doesn't recognise is never touched.
 * Each damaged approval is replaced by a placeholder in one compare-and-set
 * over the damaged bytes (MapStore.replaceUnreadable), then removed only while
 * it is still that placeholder, as lib/lifecycle.ts removeUnreadable does.
 * Answers what was removed and what is left unrecognised.
 */
export async function repairReview(ctx: Ctx): Promise<{ removed: number; settings: boolean; unrecognised: number }> {
  const report = await approvalStore.getAllReport(ctx);
  let removed = 0;
  const placeholder: Approval = { version: APPROVAL_VERSION, approved_at: new Date(0).toISOString(), amount: 0, currency: null, category_id: null, name: '' };
  for (const id of report.unreadable) {
    if (!(await approvalStore.replaceUnreadable(ctx, id, placeholder))) continue;
    await approvalStore.update(ctx, id, (current) => (current && current.approved_at === placeholder.approved_at && current.name === '' ? null : current));
    removed++;
  }
  const settings = await reviewSettingsStore.getReport(ctx);
  // A value that can't be read can't change except by its removal: set and
  // update both refuse over it, so it is still the damaged one here.
  if (settings.unreadable) await reviewSettingsStore.remove(ctx);
  return { removed, settings: settings.unreadable, unrecognised: report.unrecognised.length + (settings.unrecognised ? 1 : 0) };
}
