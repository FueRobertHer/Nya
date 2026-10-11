// lib/groups.ts
//
// Groups of transactions that net out (#39, the plan's "Group and link
// transactions"): a $120 dinner and the $60 a friend paid back are one $60
// dinner; a work trip and its reimbursement come to nothing. The person picks
// the transactions, names the group and gives it a category, and the group
// counts once, at its net, in that category, in every total; its
// transactions stay listed under it. What is kept, and the edits the route
// makes; applying a group is lib/split-rows.ts, in the read layer every
// reader shares (lib/activity.ts finishActivity).
//
// THE STORE. A map store on the storage seam (lib/repo.ts),
// `transaction-groups`, one encrypted record per group under a random id: its
// name, its category (by id), its transactions (by id: a bank's, a manual,
// imported or SimpleFIN row's, or one imported into a linked account from its
// bank's files, #52), the day it is dated (its earliest
// transaction's, when it was saved: the day its net counts on), the currency
// they are all in, and how many of its transactions went since (removed).
// The shape is closed, as a split's is (lib/splits.ts): a field this release
// doesn't know makes the record unrecognised, never half applied.
//
// WHAT JOINS A GROUP is refused by the route unless it is: posted (a pending
// transaction gets a new id when it posts), not split (its parts count on
// their own, so a group would count it twice: unsplit it first), not a part
// of one (a part isn't a transaction), in no other group, in the same
// currency as the rest (a net of two currencies is no amount), and within a
// year of the rest.
//
// GONE WITH ITS TRANSACTIONS. A transaction the bank removed, one the person
// deleted, or one imported into a linked account whose import was undone,
// leaves its group (forgetGroupMembers, from lib/split-gone.ts: by the rules
// lib/txn-annotations.ts prunes by), counted in `removed` so the group says
// so; a group left with none goes. Groups are not carried across a
// re-link (docs/features.md says why).

import { defineMapStore } from './repo';
import type { Ctx } from './containers';
import { isTransactionId } from './txn-annotations';
import { GROUP_NAME_MAX, MAX_MEMBERS, MIN_MEMBERS } from './split-rows';

export const GROUPS_VERSION = 1;

export type TxnGroup = {
  version: typeof GROUPS_VERSION;
  name: string;
  /** One of the person's categories, by id: where the net counts. */
  category_id: string;
  /** Its transactions, by id, in the order they were added. */
  members: string[];
  /** Its earliest transaction's day when it was saved: the day it counts on. */
  date: string;
  /** The currency its transactions are in, or null for rows that say none. */
  currency: string | null;
  /** How many of its transactions have gone since (the bank removed one, the
   *  person deleted one): the group says so. */
  removed?: number;
  created_at: string;
  updated_at: string;
};

// ---- Limits ----

/** Transactions in one group, the fewest, and a group's name's length (kept
 *  with the read layer's rows, lib/split-rows.ts, for the views). */
export { MAX_MEMBERS, MIN_MEMBERS, GROUP_NAME_MAX };
/** Groups a person can have. */
export const MAX_GROUPS = 2_000;
/** How far apart a group's transactions may be, in days. */
export const MAX_SPAN_DAYS = 366;

// ---- The stored shape ----

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const isInstant = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
/** A group's id: what crypto.randomUUID() makes, or any of the same characters. */
const GROUP_ID = /^[A-Za-z0-9-]{1,64}$/;
const CATEGORY_ID = /^[A-Za-z0-9_:-]{1,80}$/;
const CURRENCY = /^[A-Z0-9]{2,10}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Stored bounds, wider than an edit may make (see lib/splits.ts). */
const STORED_MEMBERS = 500;
const STORED_NAME = 1_000;

export function isGroupId(v: unknown): v is string {
  return typeof v === 'string' && GROUP_ID.test(v);
}

/** The current shape, closed (see the header). */
export function isTxnGroup(v: unknown): v is TxnGroup {
  if (!isRecord(v) || !only(v, ['version', 'name', 'category_id', 'members', 'date', 'currency', 'removed', 'created_at', 'updated_at'])) return false;
  return (
    v.version === GROUPS_VERSION &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    v.name.length <= STORED_NAME &&
    typeof v.category_id === 'string' &&
    CATEGORY_ID.test(v.category_id) &&
    Array.isArray(v.members) &&
    v.members.length >= 1 &&
    v.members.length <= STORED_MEMBERS &&
    v.members.every(isTransactionId) &&
    new Set(v.members).size === v.members.length &&
    typeof v.date === 'string' &&
    DAY.test(v.date) &&
    (v.currency === null || (typeof v.currency === 'string' && CURRENCY.test(v.currency))) &&
    (v.removed === undefined || (typeof v.removed === 'number' && Number.isInteger(v.removed) && v.removed > 0)) &&
    isInstant(v.created_at) &&
    isInstant(v.updated_at)
  );
}

export const groupStore = defineMapStore<TxnGroup>('transaction-groups', {
  what: 'groups of transactions',
  isValid: isTxnGroup,
  exportable: true, // how the person grouped their transactions
});

// ---- Editing ----

/** A group refused for what it asked, with the route's status: nothing was
 *  saved. */
export class GroupError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
    this.name = 'GroupError';
  }
}

/** A group's name as an edit takes it: normalized, spaces collapsed, at most
 *  GROUP_NAME_MAX characters, no control characters. */
export function checkGroupName(raw: unknown): string {
  if (typeof raw !== 'string') throw new GroupError('Give the group a name.');
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name) throw new GroupError('Give the group a name.');
  if (name.length > GROUP_NAME_MAX) throw new GroupError(`A group’s name can be at most ${GROUP_NAME_MAX} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new GroupError('A group’s name can’t hold control characters.');
  return name;
}

/** A list of transaction ids from a request: each once, of the right form. */
export function checkMemberIds(raw: unknown, what = 'transactions'): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_MEMBERS || !raw.every(isTransactionId)) throw new GroupError(`Invalid ${what}`);
  return [...new Set(raw)];
}

/** What is known of each transaction that would be in a group. */
export type MemberRow = { transaction_id: string; date: string; currency: string | null; pending: boolean; amount: number };

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/**
 * Whether these transactions can be one group, and the day and currency it
 * takes from them: between MIN_MEMBERS and MAX_MEMBERS, none pending, all in
 * one currency, within MAX_SPAN_DAYS of each other. Whether each is split, or
 * in another group, is the route's to check against the stores. Pure.
 */
export function checkMembers(rows: readonly MemberRow[]): { date: string; currency: string | null } {
  if (rows.length < MIN_MEMBERS) throw new GroupError(`A group has at least ${MIN_MEMBERS} transactions.`);
  if (rows.length > MAX_MEMBERS) throw new GroupError(`A group can hold at most ${MAX_MEMBERS} transactions.`);
  if (rows.some((r) => r.pending)) {
    throw new GroupError('A pending transaction can’t join a group: the bank gives it a new id when it posts. Group it once it has posted.', 409);
  }
  const currencies = new Set(rows.map((r) => r.currency));
  if (currencies.size > 1) {
    throw new GroupError(`These transactions are in more than one currency (${[...currencies].map((c) => c ?? 'none').join(', ')}), and a group nets them into one amount: nothing is converted.`, 409);
  }
  const days = rows.map((r) => r.date).sort();
  if (dayNumber(days[days.length - 1]) - dayNumber(days[0]) > MAX_SPAN_DAYS) {
    throw new GroupError(`A group’s transactions are within ${MAX_SPAN_DAYS} days of each other.`, 409);
  }
  return { date: days[0], currency: rows[0].currency };
}

/** Makes a group, under a new random id, past MAX_GROUPS refused. */
export async function createGroup(
  ctx: Ctx,
  input: { name: string; category_id: string; members: string[]; date: string; currency: string | null },
  now: Date = new Date(),
  id: string = crypto.randomUUID()
): Promise<{ id: string; group: TxnGroup }> {
  if ((await groupStore.count(ctx)) >= MAX_GROUPS) throw new GroupError(`You can have at most ${MAX_GROUPS.toLocaleString('en-US')} groups. Ungroup some first.`, 409);
  const at = now.toISOString();
  const group: TxnGroup = { version: GROUPS_VERSION, ...input, created_at: at, updated_at: at };
  // A new random id: nothing is there to compare with.
  await groupStore.set(ctx, id, group);
  return { id, group };
}

/**
 * Changes a group in one compare-and-set, from what is stored now: `fn` gets
 * the group and returns it changed (never null: ungrouping is removeGroup).
 * Null when there is no such group (ungrouped on another device meanwhile).
 * One that can't be read is refused (UnreadableEntriesError).
 */
export async function changeGroup(ctx: Ctx, id: string, fn: (current: TxnGroup) => TxnGroup, now: Date = new Date()): Promise<TxnGroup | null> {
  return groupStore.update(ctx, id, (current) => (current ? { ...fn(current), updated_at: now.toISOString() } : null));
}

/** Ungroups: the group goes, and its transactions count on their own again,
 *  exactly as before. Read first, strictly (UnreadableEntriesError for one
 *  that can't be read or isn't recognised). Whether there was one. */
export async function removeGroup(ctx: Ctx, id: string): Promise<boolean> {
  let had = false;
  await groupStore.update(ctx, id, (current) => {
    had = current !== null;
    return null;
  });
  return had;
}

/** Which group each transaction is in, from the groups that could be read:
 *  for refusing one that is in another. */
export function memberIndex(groups: ReadonlyMap<string, TxnGroup>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, g] of groups) for (const m of g.members) if (!out.has(m)) out.set(m, id);
  return out;
}

// ---- Reading ----

/**
 * Every group, for the read layer (lib/activity.ts): `groups`, and how many
 * couldn't be read or aren't recognised (`unknown`). A display read that
 * never fails for the records' own sake (storage failing still throws):
 * which transactions such a group holds isn't known, so they count on their
 * own, as before they were grouped, with a note. Nothing writes on this
 * answer.
 */
export async function readGroupsForDisplay(ctx: Ctx): Promise<{ groups: Map<string, TxnGroup>; unknown: number }> {
  const { entries, unreadable, unrecognised } = await groupStore.getAllReport(ctx);
  return { groups: entries, unknown: unreadable.length + unrecognised.length };
}

// ---- Gone with its transactions ----

/**
 * Takes transactions that are gone out of every group holding them, each
 * group in its own compare-and-set, counting them in `removed`; a group left
 * with none goes. Groups that can't be read are passed over: what they hold
 * can't be shown either. Returns how many groups changed.
 */
export async function forgetGroupMembers(ctx: Ctx, transaction_ids: readonly string[], now: Date = new Date()): Promise<number> {
  const gone = new Set(transaction_ids.filter(isTransactionId));
  if (gone.size === 0) return 0;
  const { entries } = await groupStore.getAllReport(ctx);
  let changed = 0;
  for (const [id, g] of entries) {
    if (!g.members.some((m) => gone.has(m))) continue;
    await groupStore.update(ctx, id, (current) => {
      if (!current) return current;
      const members = current.members.filter((m) => !gone.has(m));
      if (members.length === current.members.length) return current;
      if (members.length === 0) return null;
      return { ...current, members, removed: (current.removed ?? 0) + (current.members.length - members.length), updated_at: now.toISOString() };
    });
    changed++;
  }
  return changed;
}

