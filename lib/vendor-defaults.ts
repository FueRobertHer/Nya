// lib/vendor-defaults.ts
//
// A merchant's default category (master plan, "Now, small"; YNAB's payee
// default as YNAB has kept it since Aug 2026): when the person gives a
// merchant's transactions a category (Recategorize on the Activity tab, or in
// Card Mode), Nya keeps the last three, and the merchant's default category
// changes only when two of those three agree. The default then files that
// merchant's new transactions that nothing else has given a category.
//
// THE ORDER, most specific first (lib/review-layer.ts applies it, in the read
// layer every reader shares: lib/txn-layers.ts):
//   1. the person's own category on the transaction (chosen for it, carried
//      to it across a re-link, written on a row they entered or imported);
//   2. an approval's (lib/review-store.ts): an approved transaction stays
//      filed as it was approved, whatever a rule, a default or the bank says
//      since, which is offered instead;
//   3. a rule's (lib/rules.ts): a rule says something the person wrote down
//      about every transaction it matches, so it beats a default worked out
//      from what they did on a few;
//   4. the merchant's default, here;
//   5. the provider's (Plaid's) category, then the row's own words.
// A default is the person's own habit, so it beats the bank's guess; it
// never beats what they said outright, on the transaction or in a rule.
//
// NEW TRANSACTIONS. A default files the merchant's transactions dated on or
// after the day it was set (`since`), never one from before it: a default
// formed today changes nothing in last year's totals. When the two of three
// agree on another category later, the default moves to it from that day,
// and the category it had keeps the days it filed (`previous`, each from its
// day up to the next's), so a move files only what is dated from the move
// and never re-files the past (defaultOn). Only the person clearing a default
// takes back what it filed, as they ask. At most MAX_PERIODS earlier
// categories are kept; an older one files nothing more.
//
// HERE, the shape and the rule, pure and safe in the browser; the store is
// lib/vendor-default-store.ts: one value on the storage seam, every
// merchant's last three categorizations and its default, if it has one, each
// under a random id, the vendor key (which holds a merchant's name) inside
// the ciphertext, never in a field name.
//
// BY ID. Votes and defaults keep categories by id, followed through a merge
// to where they went (lib/categories.ts categoryById), so a merge moves a
// default with the category; a vote for a category that is gone agrees with
// nothing. A default's category can't be deleted while it is one, or one it
// had still files days (lib/category-usage.ts): it is cleared, or the
// category merged, first.
//
// WHICH ROWS. A merchant is a vendor key, as a vendor rename's (lib/renames.ts):
// a bank's row, or one imported into a linked account. A row kept in a manual
// account's book (entered by hand, imported into a manual account, or from
// SimpleFIN) has none, as it has no rename, so a default never files it and
// categorizing it counts toward none.

export const VENDOR_DEFAULTS_VERSION = 1;

/** One categorization: the category given (by id), and when. */
export type VendorVote = { category_id: string; at: string };

/** A category a merchant's default had before it moved, and the days it
 *  filed: from `since` up to, not including, `until`, the day the next began. */
export type VendorPeriod = { category_id: string; since: string; until: string };

/** A merchant's default: its category (by id), the day from which it files
 *  the merchant's transactions in it, when it was set to that category, and
 *  the categories it had before, oldest first, each with its days. */
export type VendorDefault = { category_id: string; since: string; set_at: string; previous?: VendorPeriod[] };

/** One merchant's last three categorizations and its default. */
export type VendorEntry = {
  /** Random: what the Defaults list removes it by. */
  id: string;
  /** The merchant (lib/transactions.ts vendorKey). */
  vendor_key: string;
  /** The merchant's name as shown when it was last categorized, for the list. */
  name: string;
  /** The last three categorizations, oldest first. */
  votes: VendorVote[];
  default?: VendorDefault;
  updated_at: string;
};

export type VendorDefaults = { version: typeof VENDOR_DEFAULTS_VERSION; vendors: VendorEntry[] };

// ---- Limits ----

/** Categorizations kept per merchant, of which two must agree. */
export const VOTES_KEPT = 3;
export const VOTES_TO_AGREE = 2;
/** Merchants kept: far more than anyone categorizes by hand. Past it, the one
 *  without a default categorized longest ago makes room. */
export const MAX_VENDORS = 1_000;
/** A vendor key as it is taken (lib/transactions.ts vendorKey). */
export const MAX_VENDOR_KEY = 200;
export const MAX_VENDOR_NAME = 100;
/** The earlier categories kept per merchant's default: past them, the
 *  oldest files nothing more. */
export const MAX_PERIODS = 12;

// ---- The stored shape ----

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const isInstant = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const ENTRY_ID = /^[A-Za-z0-9-]{1,64}$/;
const CATEGORY_ID = /^[A-Za-z0-9_:-]{1,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The stored bounds are wider than a vote may make, so a value saved under
 *  other limits still reads. */
const STORED_VENDORS = 5_000;
const STORED_TEXT = 1_000;
const STORED_PERIODS = 100;

/** A vendor key as lib/transactions.ts vendorKey makes one: a merchant's
 *  entity id, or an institution and a name. */
export function isVendorKey(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_VENDOR_KEY && /^(mid:|nm:)/.test(v) && v.length > 4 && !/[\u0000-\u001f\u007f]/.test(v);
}

function isVote(v: unknown): v is VendorVote {
  return isRecord(v) && only(v, ['category_id', 'at']) && typeof v.category_id === 'string' && CATEGORY_ID.test(v.category_id) && isInstant(v.at);
}

function isPeriod(v: unknown): v is VendorPeriod {
  return (
    isRecord(v) &&
    only(v, ['category_id', 'since', 'until']) &&
    typeof v.category_id === 'string' &&
    CATEGORY_ID.test(v.category_id) &&
    typeof v.since === 'string' &&
    DAY.test(v.since) &&
    typeof v.until === 'string' &&
    DAY.test(v.until) &&
    v.since < v.until
  );
}

/** A default, its earlier categories optional (seam rule 7: a default saved
 *  before they were kept has none). */
function isDefault(v: unknown): v is VendorDefault {
  return (
    isRecord(v) &&
    only(v, ['category_id', 'since', 'set_at', 'previous']) &&
    typeof v.category_id === 'string' &&
    CATEGORY_ID.test(v.category_id) &&
    typeof v.since === 'string' &&
    DAY.test(v.since) &&
    isInstant(v.set_at) &&
    (v.previous === undefined || (Array.isArray(v.previous) && v.previous.length <= STORED_PERIODS && v.previous.every(isPeriod)))
  );
}

export function isVendorEntry(v: unknown): v is VendorEntry {
  return (
    isRecord(v) &&
    only(v, ['id', 'vendor_key', 'name', 'votes', 'default', 'updated_at']) &&
    typeof v.id === 'string' &&
    ENTRY_ID.test(v.id) &&
    typeof v.vendor_key === 'string' &&
    v.vendor_key.length > 0 &&
    v.vendor_key.length <= STORED_TEXT &&
    typeof v.name === 'string' &&
    v.name.length <= STORED_TEXT &&
    Array.isArray(v.votes) &&
    v.votes.length >= 1 &&
    v.votes.length <= VOTES_KEPT &&
    v.votes.every(isVote) &&
    (v.default === undefined || isDefault(v.default)) &&
    isInstant(v.updated_at)
  );
}

/** The current shape, closed (a field a later release adds makes the whole
 *  unrecognised, never half applied): merchants with ids and keys that differ. */
export function isVendorDefaults(v: unknown): v is VendorDefaults {
  if (!isRecord(v) || !only(v, ['version', 'vendors']) || v.version !== VENDOR_DEFAULTS_VERSION) return false;
  if (!Array.isArray(v.vendors) || v.vendors.length > STORED_VENDORS || !v.vendors.every(isVendorEntry)) return false;
  const entries = v.vendors as VendorEntry[];
  return new Set(entries.map((e) => e.id)).size === entries.length && new Set(entries.map((e) => e.vendor_key)).size === entries.length;
}

// ---- The rule (pure) ----

/** How a category id is known now: the category it names, through merges,
 *  or null for one that is gone. */
export type Resolve = (category_id: string) => string | null;

/**
 * The category at least two of the votes agree on (each followed through a
 * merge; a vote for a category that is gone agrees with nothing), with how
 * many do, or null when no two agree. Of three votes only one category can
 * have two, so there is never a tie to break: three different categories, or
 * two that differ, agree on nothing.
 */
export function agreedCategory(votes: readonly VendorVote[], resolve: Resolve): { category_id: string; agree: number } | null {
  const counts = new Map<string, number>();
  for (const v of votes.slice(-VOTES_KEPT)) {
    const id = resolve(v.category_id);
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: { category_id: string; agree: number } | null = null;
  for (const [category_id, agree] of counts) if (agree >= VOTES_TO_AGREE && (!best || agree > best.agree)) best = { category_id, agree };
  return best;
}

/** One categorization, as the route records it. */
export type CategorizationInput = { vendor_key: string; name: string; category_id: string };

/** A default set to `category_id` from `today`: a new one, or one that moves,
 *  whose category before keeps the days it filed, from its day up to today
 *  (none when it filed none: set today, or its category is gone), so the
 *  past stays filed as it was. */
function movedTo(before: VendorDefault | undefined, category_id: string, beforeId: string | null, today: string, at: string): VendorDefault {
  if (!before) return { category_id, since: today, set_at: at };
  const earlier = beforeId !== null && before.since < today ? [{ category_id: before.category_id, since: before.since, until: today }] : [];
  const previous = [...(before.previous ?? []), ...earlier].slice(-MAX_PERIODS);
  return { category_id, since: today, set_at: at, ...(previous.length > 0 ? { previous } : {}) };
}

/**
 * The defaults after the person gives one of a merchant's transactions a
 * category: the vote joins the merchant's last three (the oldest goes), and
 * its default changes only when two of those three agree on another category
 * than it has: set from `today`, or moved from `today` with the category it
 * had keeping the days it filed (movedTo). Otherwise it stays as it was, a
 * default of none included. `entry` is the
 * merchant's entry after, `previous` before (null for a merchant new here),
 * and `changed` whether its default did. Null when there is no room: every
 * merchant kept has a default (MAX_VENDORS), so none is dropped to make it.
 * Pure but for `newId`.
 */
export function withVote(
  state: VendorDefaults | null,
  vote: CategorizationInput,
  opts: { at: Date; today: string; resolve: Resolve; newId?: () => string }
): { next: VendorDefaults; entry: VendorEntry; previous: VendorEntry | null; changed: boolean } | null {
  const vendors = state?.vendors ?? [];
  const previous = vendors.find((e) => e.vendor_key === vote.vendor_key) ?? null;
  const at = opts.at.toISOString();
  const votes = [...(previous?.votes ?? []), { category_id: vote.category_id, at }].slice(-VOTES_KEPT);
  const agreed = agreedCategory(votes, opts.resolve);
  const before = previous?.default;
  const beforeId = before ? opts.resolve(before.category_id) : null;
  let next: VendorDefault | undefined = before;
  if (agreed && agreed.category_id !== beforeId) next = movedTo(before, agreed.category_id, beforeId, opts.today, at);
  const entry: VendorEntry = {
    id: previous?.id ?? (opts.newId ?? (() => crypto.randomUUID()))(),
    vendor_key: vote.vendor_key,
    name: vote.name,
    votes,
    ...(next ? { default: next } : {}),
    updated_at: at,
  };
  let kept = previous ? vendors.map((e) => (e === previous ? entry : e)) : [...vendors, entry];
  if (kept.length > MAX_VENDORS) {
    // Room is made by the merchant without a default categorized longest ago,
    // never by one with a default, which files transactions.
    const spare = kept.filter((e) => !e.default && e !== entry).sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0))[0];
    if (!spare) return null;
    kept = kept.filter((e) => e !== spare);
  }
  return { next: { version: VENDOR_DEFAULTS_VERSION, vendors: kept }, entry, previous, changed: next !== before };
}

/** A merchant's default as the read layer applies it: the entry's id, the
 *  category (followed through merges), the day it files from, how many of
 *  the merchant's last three categorizations agree with it now, and the
 *  categories it had before, each with its days (followed through merges;
 *  one that is gone files nothing). */
export type DefaultFor = { id: string; category_id: string; since: string; agree: number; previous?: readonly VendorPeriod[] };

/** Each merchant's default, by vendor key, whose category still exists. */
export function defaultsByVendor(state: VendorDefaults | null, resolve: Resolve): Map<string, DefaultFor> {
  const out = new Map<string, DefaultFor>();
  for (const e of state?.vendors ?? []) {
    if (!e.default) continue;
    const category_id = resolve(e.default.category_id);
    if (category_id === null) continue;
    const agree = e.votes.filter((v) => resolve(v.category_id) === category_id).length;
    const previous = (e.default.previous ?? []).flatMap((p) => {
      const id = resolve(p.category_id);
      return id === null ? [] : [{ ...p, category_id: id }];
    });
    out.set(e.vendor_key, { id: e.id, category_id, since: e.default.since, agree, ...(previous.length > 0 ? { previous } : {}) });
  }
  return out;
}

/** The category a merchant's default files a transaction of `date` under:
 *  its own from its day on, else the earlier one whose days hold the date
 *  (`earlier`), else none, for a day before the default was first set. */
export function defaultOn(d: Pick<DefaultFor, 'category_id' | 'since' | 'previous'>, date: string): { category_id: string; earlier: boolean } | null {
  if (date >= d.since) return { category_id: d.category_id, earlier: false };
  const p = (d.previous ?? []).find((q) => date >= q.since && date < q.until);
  return p ? { category_id: p.category_id, earlier: true } : null;
}

/** How many merchants' defaults are a category (`isIt`, which follows
 *  merges), now or in the days an earlier category of theirs files, for
 *  deleting it (lib/category-usage.ts). */
export function defaultUses(state: VendorDefaults | null, isIt: (category_id: string) => boolean): number {
  return (state?.vendors ?? []).filter((e) => e.default && (isIt(e.default.category_id) || (e.default.previous ?? []).some((p) => isIt(p.category_id)))).length;
}
