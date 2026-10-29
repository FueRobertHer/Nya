// lib/splits.ts
//
// Split transactions (#39): one transaction's amount in parts, each with a
// category of the person's own and, if they like, a note, so one Costco charge
// counts as groceries, household and a tire. What is kept, and the edits the
// route makes; applying a split is lib/split-rows.ts, in the read layer every
// reader shares (lib/activity.ts finishActivity).
//
// THE STORE. A map store on the storage seam (lib/repo.ts), `transaction-
// splits`, one encrypted record per split transaction, under its id: Plaid's
// own, a manual, imported or SimpleFIN row's "manual-txn:<uuid>", or that of
// a row imported into a linked account from its bank's files,
// "imported-txn:<uuid>" (#52), opaque as the seam requires of field names. A record holds the parts (each a random
// id, an amount in Plaid's sign, a category by id, and optionally a note and a
// flag that leaves it out of budgets and reports on its own) and the amount
// and currency the transaction had when it was split, which is how a change
// the bank makes later is told (lib/split-rows.ts: the difference is shown as
// a part of its own, never spread silently over the others).
//
// THE SHAPE IS CLOSED. A field this release doesn't know, at any level, makes
// the record unrecognised, never half applied: a part a later release leaves
// out of a total would otherwise count here. Such a record shows its
// transaction whole, with a note, and nothing saves over it.
//
// THE PARTS ADD UP. Saved only when the parts add up to the transaction's
// amount exactly, in the currency's minor units (cents, yen), each of the
// transaction's own sign and none zero (checkParts); a transaction still
// pending, or in a group (lib/groups.ts), is refused by the route.
//
// GONE WITH ITS TRANSACTION, as what was said about a transaction is
// (lib/txn-annotations.ts): a bank transaction's split goes once no stored
// Item holds it (lib/split-gone.ts pruneSplitsAndGroups, after a sync saves
// the bank's removal, a disconnect or a forget, by the same rules: nothing
// while a store can't be read or is behind, never a record this release
// doesn't recognise), and a manual row's with the row (forgetSplits), as does
// one imported into a linked account, with its import's undo or its earlier
// account's forget (lib/history-import/commit.ts): kept past a disconnect, as
// the row is. Splits are not carried across a re-link (docs/features.md says
// why).
//
// FROM A FILE TO THE BANK'S ROW. A row imported into a linked account that a
// bank row comes to stand for (lib/history-import/match.ts) keeps its split,
// under its own id, and the bank row shows it while it stands for it, as it
// shows what was said about the row (lib/split-rows.ts): an edit made from
// the bank row is made here, on the imported row's record, unless the bank
// row is split in its own right.
//
// SIZE. The read layer reads every record on each request (one HGETALL), as
// it reads what was said about each transaction: cheap for what people split
// by hand, far under MAX_SPLITS.

import { defineMapStore } from './repo';
import { stampAfter } from './edit-stamp';
import type { Ctx } from './containers';
import { MAX_NOTE_CHARS } from './manual-txn-input';
import { isTransactionId } from './txn-annotations';
import { unitScale, toUnits, MAX_PARTS, MIN_PARTS } from './split-rows';

export const SPLITS_VERSION = 1;

/** One part of a split transaction. */
export type SplitPart = {
  /** Random (crypto.randomUUID()), kept as long as the part is. */
  id: string;
  /** Plaid's sign: positive is money out, as the transaction's. */
  amount: number;
  /** One of the person's categories, by id (lib/categories.ts categoryById
   *  follows a merge to where it went). */
  category_id: string;
  note?: string;
  /** Left out of budgets and reports on its own (the rest still count). */
  excluded?: true;
};

/** One split transaction: its parts, and the amount and currency it had when
 *  it was split (null for a row stored before currencies were kept). */
export type SplitRecord = {
  version: typeof SPLITS_VERSION;
  amount: number;
  currency: string | null;
  parts: SplitPart[];
  updated_at: string;
};

// ---- Limits ----

/** Parts one transaction can be split into, and the fewest (kept with the
 *  read layer's rows, lib/split-rows.ts, for the views). */
export { MAX_PARTS, MIN_PARTS };
/** Transactions a person can split: far beyond what anyone splits by hand,
 *  and a bound on the one read every load makes. */
export const MAX_SPLITS = 5_000;

// ---- The stored shape ----

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
/** A part's id: what crypto.randomUUID() makes, or any of the same characters. */
const PART_ID = /^[A-Za-z0-9-]{1,64}$/;
/** A category's id as stored (lib/category-store.ts takes the same). */
const CATEGORY_ID = /^[A-Za-z0-9_:-]{1,80}$/;
/** A currency as a row carries it: ISO's code, or Plaid's unofficial one. */
const CURRENCY = /^[A-Z0-9]{2,10}$/;
/** The stored bounds are wider than an edit may make, so a record saved under
 *  other limits still reads. */
const STORED_PARTS = 100;
const STORED_NOTE = 10_000;

export function isSplitPart(v: unknown): v is SplitPart {
  return (
    isRecord(v) &&
    only(v, ['id', 'amount', 'category_id', 'note', 'excluded']) &&
    typeof v.id === 'string' &&
    PART_ID.test(v.id) &&
    typeof v.amount === 'number' &&
    Number.isFinite(v.amount) &&
    v.amount !== 0 &&
    typeof v.category_id === 'string' &&
    CATEGORY_ID.test(v.category_id) &&
    (v.note === undefined || (typeof v.note === 'string' && v.note.length > 0 && v.note.length <= STORED_NOTE)) &&
    (v.excluded === undefined || v.excluded === true)
  );
}

/** The current shape, closed (see the header): parts with ids that differ. */
export function isSplitRecord(v: unknown): v is SplitRecord {
  if (!isRecord(v) || !only(v, ['version', 'amount', 'currency', 'parts', 'updated_at'])) return false;
  if (v.version !== SPLITS_VERSION || typeof v.amount !== 'number' || !Number.isFinite(v.amount)) return false;
  if (!(v.currency === null || (typeof v.currency === 'string' && CURRENCY.test(v.currency)))) return false;
  if (typeof v.updated_at !== 'string' || Number.isNaN(Date.parse(v.updated_at))) return false;
  if (!Array.isArray(v.parts) || v.parts.length < 1 || v.parts.length > STORED_PARTS || !v.parts.every(isSplitPart)) return false;
  return new Set(v.parts.map((p) => (p as SplitPart).id)).size === v.parts.length;
}

export const splitStore = defineMapStore<SplitRecord>('transaction-splits', {
  what: 'splits',
  isValid: isSplitRecord,
  exportable: true, // how the person split their transactions
});

// ---- Editing ----

/** A split refused for what it asked, with the route's status: nothing was
 *  saved. */
export class SplitError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
    this.name = 'SplitError';
  }
}

/** A part as a request gives it, before it is checked. */
export type PartInput = { id?: unknown; amount?: unknown; category_id?: unknown; note?: unknown; excluded?: unknown };

/** What is known of the transaction being split. */
export type SplitParentRow = { amount: number; currency: string | null; pending: boolean };

/** A note on a part as an edit takes it: trimmed, at most MAX_NOTE_CHARS,
 *  no control characters but line breaks and tabs. Empty is none. */
export function checkPartNote(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') throw new SplitError('A note is text.');
  const note = raw.normalize('NFC').trim();
  if (note.length > MAX_NOTE_CHARS) throw new SplitError(`A note can be at most ${MAX_NOTE_CHARS} characters.`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) throw new SplitError('A note can’t hold control characters.');
  return note || undefined;
}

/** An amount for a refusal, to the transaction's unit and with its currency
 *  ("$12.34", "¥1,234", "BTC 0.00000001"), so the page can hide what a
 *  refusal says of amounts while amounts are hidden and leave its counts
 *  ("at most 10 parts") as they are (components/SplitSheet.tsx,
 *  hideAmountsIn). */
function shown(units: number, scale: number, currency: string | null): string {
  const places = Math.round(Math.log10(scale));
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD', minimumFractionDigits: places, maximumFractionDigits: places }).format(units / scale);
  } catch {
    // A code Intl refuses: the figures, then the code, as lib/format.ts writes one.
    return `${(units / scale).toFixed(places)} ${currency}`;
  }
}

/**
 * The parts a request asks for, checked against the transaction: between
 * MIN_PARTS and MAX_PARTS, each an amount of the transaction's own sign, no
 * finer than its currency's minor unit and never zero, adding up to its
 * amount exactly in those units; a category id of the right form (whether a
 * category has it is the route's to check, against the person's categories);
 * and a note, optionally. A part keeps the id it came with when it has one of
 * the right form, so its place survives an edit; a new one gets a random id.
 * Pure but for `newId`. SplitError otherwise.
 */
export function checkParts(raw: unknown, parent: SplitParentRow, newId: () => string = () => crypto.randomUUID()): SplitPart[] {
  if (parent.pending) throw new SplitError('A pending transaction can’t be split: the bank gives it a new id when it posts. Split it once it has posted.', 409);
  if (!Array.isArray(raw)) throw new SplitError('Say what the parts are.');
  if (raw.length < MIN_PARTS) throw new SplitError(`A split has at least ${MIN_PARTS} parts. To file the whole transaction under one category, change its category instead.`);
  if (raw.length > MAX_PARTS) throw new SplitError(`A transaction can be split into at most ${MAX_PARTS} parts.`);
  const scale = unitScale(parent.currency);
  const sign = Math.sign(parent.amount);
  if (sign === 0) throw new SplitError('A transaction of nothing can’t be split.');
  const seen = new Set<string>();
  let total = 0;
  const parts = raw.map((p: unknown): SplitPart => {
    if (!isRecord(p)) throw new SplitError('Each part is an amount and a category.');
    const input = p as PartInput;
    if (typeof input.amount !== 'number' || !Number.isFinite(input.amount)) throw new SplitError('Each part needs an amount.');
    const units = input.amount * scale;
    // In whole units, but for the float error of a decimal sent as a number,
    // which grows with the amount: a few units in the last place, never half
    // a unit (eight places at 1e8 lose a whole one only past millions).
    if (!Number.isSafeInteger(Math.round(units))) throw new SplitError('That amount is too large to split.');
    if (Math.abs(units - Math.round(units)) > Math.max(1e-6, Math.abs(units) * 4 * Number.EPSILON)) {
      throw new SplitError(`A part’s amount can’t be finer than ${shown(1, scale, parent.currency)}.`);
    }
    if (Math.round(units) === 0) throw new SplitError('A part can’t be nothing: take it out instead.');
    if (Math.sign(input.amount) !== sign) {
      throw new SplitError(sign > 0 ? 'Each part of money out is money out too.' : 'Each part of money in is money in too.');
    }
    if (typeof input.category_id !== 'string' || !CATEGORY_ID.test(input.category_id)) throw new SplitError('Choose a category for each part.');
    if (input.excluded !== undefined && typeof input.excluded !== 'boolean') throw new SplitError('Say whether to leave a part out.');
    let id = typeof input.id === 'string' && PART_ID.test(input.id) && !seen.has(input.id) ? input.id : newId();
    while (seen.has(id)) id = newId();
    seen.add(id);
    total += Math.round(units);
    const note = checkPartNote(input.note);
    return {
      id,
      amount: Math.round(units) / scale,
      category_id: input.category_id,
      ...(note ? { note } : {}),
      ...(input.excluded === true ? { excluded: true as const } : {}),
    };
  });
  const whole = toUnits(parent.amount, scale);
  if (total !== whole) {
    const left = whole - total;
    throw new SplitError(
      `The parts add up to ${shown(Math.abs(total), scale, parent.currency)}, not the transaction’s ${shown(Math.abs(whole), scale, parent.currency)}: ${shown(Math.abs(left), scale, parent.currency)} ${Math.sign(left) === sign ? 'is left over' : 'too much'}.`
    );
  }
  return parts;
}

/** What an edit was made from: the split as it was saved then (its
 *  `updated_at`), null for none, or undefined when the edit doesn't say. */
export type SeenSplit = string | null | undefined;

/** Refused when the split changed since the edit was opened on it (another
 *  device): nothing it made there is lost. */
function checkSeen(current: SplitRecord | null, seen: SeenSplit): void {
  if (seen === undefined || (current?.updated_at ?? null) === seen) return;
  throw new SplitError('This split was changed on another device since you opened it. Close it and open it again to see the change.', 409);
}

/**
 * Saves a transaction's split, replacing any it had, in one compare-and-set,
 * and returns it as saved. A new split past MAX_SPLITS is refused; changing
 * one there already never is. A record that can't be read is refused
 * (UnreadableEntriesError), never saved over; and, given `seen`, one that
 * changed since the edit was opened on it (checkSeen).
 */
export async function saveSplit(
  ctx: Ctx,
  transaction_id: string,
  parent: SplitParentRow,
  parts: SplitPart[],
  now: Date = new Date(),
  seen: SeenSplit = undefined
): Promise<SplitRecord> {
  if (!(await splitStore.has(ctx, transaction_id)) && (await splitStore.count(ctx)) >= MAX_SPLITS) {
    throw new SplitError(`At most ${MAX_SPLITS.toLocaleString('en-US')} transactions can be split. Unsplit some first.`, 409);
  }
  return (await splitStore.update(ctx, transaction_id, (current) => {
    checkSeen(current, seen);
    return { version: SPLITS_VERSION, amount: parent.amount, currency: parent.currency, parts, updated_at: stampAfter(current?.updated_at, now) };
  }))!;
}

/** A change to one part that leaves the amounts alone: its category, its
 *  note (empty clears it) or whether it is left out on its own. */
export type PartChange = { category_id?: string; note?: string; excluded?: boolean };

/**
 * Changes one part of a split, in one compare-and-set, and returns the split
 * as saved; null when the transaction has no split now, or the split no such
 * part (unsplit or edited on another device meanwhile). The amounts are left
 * as they are, so a split whose transaction's amount the bank changed since
 * can still be given a category part by part.
 */
export async function changePart(ctx: Ctx, transaction_id: string, part_id: string, change: PartChange, now: Date = new Date()): Promise<SplitRecord | null> {
  let found = false;
  const saved = await splitStore.update(ctx, transaction_id, (current) => {
    found = !!current?.parts.some((p) => p.id === part_id);
    if (!current || !found) return current;
    const parts = current.parts.map((p): SplitPart => {
      if (p.id !== part_id) return p;
      const next: SplitPart = { ...p };
      if (change.category_id !== undefined) next.category_id = change.category_id;
      if (change.note !== undefined) {
        if (change.note) next.note = change.note;
        else delete next.note;
      }
      if (change.excluded === true) next.excluded = true;
      else if (change.excluded === false) delete next.excluded;
      return next;
    });
    return { ...current, parts, updated_at: stampAfter(current.updated_at, now) };
  });
  return found ? saved : null;
}

/** Unsplits a transaction: its split goes, so it shows and counts whole again,
 *  exactly as before it was split. Reads it first, strictly: one that can't
 *  be read, or isn't recognised, is refused (UnreadableEntriesError), never
 *  deleted unseen; and, given `seen`, one changed since (checkSeen). Returns
 *  whether there was one. */
export async function removeSplit(ctx: Ctx, transaction_id: string, seen: SeenSplit = undefined): Promise<boolean> {
  let had = false;
  await splitStore.update(ctx, transaction_id, (current) => {
    checkSeen(current, seen);
    had = current !== null;
    return null;
  });
  return had;
}

// ---- Reading ----

/**
 * Every split, for the read layer (lib/activity.ts): `records`, and
 * `unknown`, the ids of transactions whose split couldn't be read or isn't
 * recognised. A display read that never fails for the records' own sake
 * (storage failing still throws): such a transaction is shown whole, marked,
 * with a note, so a total is never short. Nothing writes on this answer; an
 * edit of an unreadable record is refused by every edit here.
 */
export async function readSplitsForDisplay(ctx: Ctx): Promise<{ records: Map<string, SplitRecord>; unknown: Set<string> }> {
  const { entries, unreadable, unrecognised } = await splitStore.getAllReport(ctx);
  return { records: entries, unknown: new Set([...unreadable, ...unrecognised]) };
}

// ---- Gone with the transaction ----

/** Forgets the splits of transactions that are gone (a deleted manual row,
 *  every row of a deleted manual account, an import undone), readable or
 *  not: nothing can show them again. */
export async function forgetSplits(ctx: Ctx, transaction_ids: readonly string[]): Promise<void> {
  const ids = transaction_ids.filter(isTransactionId);
  for (let i = 0; i < ids.length; i += 1000) await splitStore.remove(ctx, ...ids.slice(i, i + 1000));
}

