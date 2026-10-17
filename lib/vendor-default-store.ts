// lib/vendor-default-store.ts
//
// Where merchants' default categories are kept (the rule and the shape are
// lib/vendor-defaults.ts, applied on read by lib/review-layer.ts).
//
// ONE VALUE STORE on the storage seam (lib/repo.ts), `vendor-defaults`,
// encrypted and compressed: every merchant's last three categorizations and
// its default, if it has one, each under a random id. A vendor key holds a
// merchant's name (lib/transactions.ts vendorKey: "nm:chase::costco"), so it
// is kept inside the ciphertext, never in a field name (seam rule 8), and the
// Defaults list removes an entry by its random id. One value, changed with the
// seam's compare-and-set (ValueStore.update), so two categorizations at once
// (two devices, a quick run in Card Mode) never lose either.
//
// STRICT. The value is read with a report (getReport): one that can't be
// read files nothing, with a note, and is never taken for "no defaults", so
// nothing is saved over it (every change here refuses, 409) until the person
// removes it, once confirmed and only if its bytes are damaged
// (repairDefaults). A value a later release wrote is never removed.

import { defineValueStore } from './repo';
import type { Ctx } from './containers';
import { isVendorDefaults, withVote, type CategorizationInput, type Resolve, type VendorDefaults, type VendorEntry } from './vendor-defaults';

export const vendorDefaultsStore = defineValueStore<VendorDefaults>('vendor-defaults', {
  what: 'merchant default categories',
  isValid: isVendorDefaults,
  exportable: true, // how the person files each merchant, and why
  compress: true,
});



/** A change to the defaults refused for what it asked: nothing was saved. */
export class VendorDefaultError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message);
    this.name = 'VendorDefaultError';
  }
}

/**
 * The defaults, for the read layer and the Defaults list: `state` (null when
 * never saved), and whether it couldn't be read (`unreadable`, damaged, or
 * `unrecognised`, a later release's). A display read: either way no default
 * files anything (the read layer says so in a note), and every change here
 * refuses to save over it.
 */
export async function readVendorDefaults(ctx: Ctx): Promise<{ state: VendorDefaults | null; unreadable: boolean; unrecognised: boolean }> {
  const { value, unreadable, unrecognised } = await vendorDefaultsStore.getReport(ctx);
  return { state: value, unreadable, unrecognised };
}

/**
 * Records that the person gave one of a merchant's transactions a category
 * (app/api/recategorize), in one compare-and-set (withVote). Answers the
 * merchant's entry before and after, and whether its default changed: what
 * an undo puts back (restoreVendorEntry). Null when there was no room.
 * Refused (UnreadableValueError) over defaults that can't be read.
 */
export async function recordCategorization(
  ctx: Ctx,
  vote: CategorizationInput,
  opts: { resolve: Resolve; today: string; now?: Date }
): Promise<{ entry: VendorEntry; previous: VendorEntry | null; changed: boolean } | null> {
  let result: { entry: VendorEntry; previous: VendorEntry | null; changed: boolean } | null = null;
  await vendorDefaultsStore.update(ctx, (current) => {
    // May run more than once: only computes.
    const made = withVote(current, vote, { at: opts.now ?? new Date(), today: opts.today, resolve: opts.resolve });
    result = made ? { entry: made.entry, previous: made.previous, changed: made.changed } : null;
    return made ? made.next : current;
  });
  return result;
}

/**
 * Clears a merchant's default and forgets its categorizations, so the next
 * two that agree set one afresh (keeping them would set it again at the next
 * one). By the entry's id, in one compare-and-set. Answers whether there was
 * one.
 */
export async function clearDefault(ctx: Ctx, id: string): Promise<boolean> {
  let found = false;
  await vendorDefaultsStore.update(ctx, (current) => {
    found = !!current?.vendors.some((e) => e.id === id);
    if (!current || !found) return current;
    return { ...current, vendors: current.vendors.filter((e) => e.id !== id) };
  });
  return found;
}

/** Whether two entries say the same (JSON written in one order, field by
 *  field, so key order never matters). */
const sameEntry = (a: VendorEntry, b: VendorEntry): boolean => {
  const norm = (e: VendorEntry) =>
    JSON.stringify([e.id, e.vendor_key, e.name, e.votes.map((v) => [v.category_id, v.at]), e.default ? [e.default.category_id, e.default.since, e.default.set_at] : null, e.updated_at]);
  return norm(a) === norm(b);
};

/**
 * Undoes a categorization's vote (Card Mode's undo): the merchant's entry, if
 * it is still exactly the one that vote left (`after`, as the recategorization
 * answered it: compared whole, since two votes can land in one millisecond),
 * becomes what it was before (`previous`, which must be the same merchant's),
 * or goes when there was none. One changed since (another categorization) is
 * left as it is. Answers whether it was put back.
 */
export async function restoreVendorEntry(ctx: Ctx, change: { after: VendorEntry; previous: VendorEntry | null }): Promise<boolean> {
  let restored = false;
  await vendorDefaultsStore.update(ctx, (current) => {
    restored = false;
    const now = current?.vendors.find((e) => e.id === change.after.id);
    if (!current || !now || !sameEntry(now, change.after)) return current;
    if (change.previous && (change.previous.id !== now.id || change.previous.vendor_key !== now.vendor_key)) {
      throw new VendorDefaultError('That isn’t how this merchant’s categories were before.');
    }
    restored = true;
    return { ...current, vendors: change.previous ? current.vendors.map((e) => (e === now ? change.previous! : e)) : current.vendors.filter((e) => e !== now) };
  });
  return restored;
}

/** Removes the defaults if their bytes are damaged, once the person has
 *  confirmed: nothing readable is lost, and a value this release doesn't
 *  recognise is never touched. Answers whether it removed them. */
export async function repairDefaults(ctx: Ctx): Promise<boolean> {
  const report = await vendorDefaultsStore.getReport(ctx);
  // Set and update both refuse over a value that can't be read, so it is
  // still the damaged one here.
  if (report.unreadable) await vendorDefaultsStore.remove(ctx);
  return report.unreadable;
}
