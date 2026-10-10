// lib/categories.ts
//
// Your categories and the groups they roll up to (#38): a set of categories
// you own, each with a stable id, that every transaction is filed into. Pure
// functions, safe to import from client code; lib/category-store.ts keeps the
// set, one encrypted value per container on the storage seam.
//
// THE SHAPE (Taxonomy). A category has a random id (what budgets store, and
// rules will), a name, a group, an optional icon, an archived flag, and the
// provider keys that file transactions into it: {provider, key} pairs, today
// from two providers:
//   - 'plaid': a value of Plaid's personal finance category, primary
//     (FOOD_AND_DRINK) or detailed (FOOD_AND_DRINK_COFFEE);
//   - 'text': a category written as words, the way Nya keeps one on a
//     transaction entered by hand or imported from a file, on a category chosen
//     for a transaction (lib/overrides.ts, and carried across a re-link), and as
//     the name a budget was saved under before categories had ids. Lower case,
//     spaces collapsed (textKey).
// A second aggregator brings its own provider name and keys, with no change of
// shape. A group has an id, a name, a kind (income, expense or transfer) and an
// order. One category, Other when seeded, is `uncategorized`: where a
// transaction that says nothing about its category is filed.
//
// TEXT KEYS ARE HOW THE OLDER STORES POINT HERE. What was stored before
// categories had ids stays as it was, as text, and each text is a key of
// exactly one category. A key never changes when a category is renamed or
// moved, so a rename renames it everywhere at once, and the release before this
// one still reads every store it wrote (docs/operations.md). Choosing a
// category for a transaction stores the category's first text key
// (choiceText), so that release can read that too. Merging moves the merged
// category's keys, so everything that pointed at it points at what it was
// merged into, with nothing rewritten.
//
// RESOLUTION, one function for every transaction (resolveCategory), most
// specific first:
//   1. the person's own: a category chosen for this transaction, or for the
//      one it continues across a re-link, or written on a row they entered or
//      imported (its text key);
//   2. rules (#36) will go here: below a choice made on one transaction, above
//      what the bank says;
//   3. the provider's: Plaid's detailed category, then its primary one;
//   4. the text the row carries, for a row stored before Plaid's values were;
//   5. the uncategorized category, for a row that says nothing at all.
// The name shown comes from the category, never from the row.
//
// KINDS. A category counts as its group's kind: spending (expense), income, or
// a transfer, which totals leave out (lib/spending.ts). Seeded, the groups give
// every category the kind the spending rule gave its text before kinds
// existed (legacyKind), so no total moves; moving a category to a group of
// another kind is how a person makes, say, loan payments count as spending.
// The finer rules (recurring detection's everyday categories, the Plan's
// loan payments and refunds) read the text key the row carries, never a name
// (lib/spending.ts categoryKey).
//
// GROWING. A key no category has yet (Plaid starts a new category, a file is
// imported with categories of its own) is given one: a category that already
// has the same words (a name, or Plaid's value humanized) takes it, else a new
// one is made where its kind belongs (growTaxonomy). The app's own reads grow
// the stored set as they go (lib/category-store.ts); the read-only API grows a
// copy in memory, with provisional ids it never shows.

/** Bumped only when a field changes meaning: a later version reads as
 *  unrecognised, never as something it isn't. Fields added ride along. */
export const TAXONOMY_VERSION = 1;

export type CategoryKind = 'income' | 'expense' | 'transfer';
export const CATEGORY_KINDS: readonly CategoryKind[] = ['expense', 'income', 'transfer'];

/** Plaid's personal finance category. */
export const PLAID = 'plaid';
/** A category written as words (see the header). */
export const TEXT = 'text';

export type ProviderKey = { provider: string; key: string };

export type Category = {
  id: string;
  name: string;
  /** Its group's id. */
  group: string;
  /** An emoji or a few characters, shown before the name. */
  icon?: string;
  /** Hidden from the lists to choose from; transactions in it still show it. */
  archived?: boolean;
  provider_keys: ProviderKey[];
};

export type CategoryGroup = {
  id: string;
  name: string;
  kind: CategoryKind;
  /** Lower first. */
  order: number;
};

export type Taxonomy = {
  version: typeof TAXONOMY_VERSION;
  groups: CategoryGroup[];
  categories: Category[];
  /** The category a transaction that says nothing is filed under. */
  uncategorized: string;
  /** Categories merged away, by id, and the category each was merged into, so
   *  a reference saved meanwhile (a budget from a page loaded before the
   *  merge) still finds where it went. */
  merged?: Record<string, string>;
};

// ---- Limits ----

/** A name's length, as long as a category could ever be written
 *  (lib/manual-txn-input.ts MAX_CATEGORY_CHARS). */
export const NAME_MAX = 60;
/** An icon: an emoji, or a few characters. */
export const ICON_MAX = 16;
/** Categories and groups a person can make. Growing past MAX_CATEGORIES
 *  stops: a transaction whose category has no room is filed as uncategorized. */
export const MAX_CATEGORIES = 500;
export const MAX_GROUPS = 50;

// ---- Text ----

/** A category written as words, as a text key: Unicode-normalized, spaces
 *  collapsed, trimmed, lower case. Every category Nya stored as text was
 *  already lower case. */
export function textKey(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** A name or a group's name as typed: normalized, spaces collapsed, trimmed. */
export function cleanName(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Plaid's value as the words Nya stored on a row before category ids
 *  (lib/transactions.ts): FOOD_AND_DRINK is "food and drink". */
export function plaidText(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase();
}

/** The name a category grown from words is given: the words themselves,
 *  exactly as Nya showed that category before categories had ids ("food and
 *  drink"), so nothing a person or a program reads (the read-only API's
 *  `category`) changes until they rename it. */
export function defaultName(text: string): string {
  return text;
}

/** A name as the app shows it: as typed when it has a capital letter, else
 *  with its first letter in capitals ("food and drink" shows as "Food and
 *  drink", "iCloud" as it is). Only for showing: what is stored, and what the
 *  API answers, is the name itself. */
export function displayName(name: string): string {
  return /\p{Lu}/u.test(name) || name.length === 0 ? name : name[0].toUpperCase() + name.slice(1);
}

const LOAN_PAYMENTS = 'loan payments';

/** The kind the spending rule gave a category written as these words before
 *  categories had kinds (lib/spending.ts): a transfer when it starts with
 *  "transfer" or is "loan payments", income when it is "income", else
 *  spending. Seeding places each category by it, so no total moves. */
export function legacyKind(text: string): CategoryKind {
  if (text.startsWith('transfer') || text === LOAN_PAYMENTS) return 'transfer';
  if (text === 'income') return 'income';
  return 'expense';
}

// ---- The seed ----

/** The groups a new set starts with, by a role only seeding uses. */
const DEFAULT_GROUPS: readonly { role: string; name: string; kind: CategoryKind }[] = [
  { role: 'income', name: 'Income', kind: 'income' },
  { role: 'food', name: 'Food', kind: 'expense' },
  { role: 'shopping', name: 'Shopping', kind: 'expense' },
  { role: 'housing', name: 'Housing', kind: 'expense' },
  { role: 'transport', name: 'Transport', kind: 'expense' },
  { role: 'leisure', name: 'Travel and entertainment', kind: 'expense' },
  { role: 'health', name: 'Health and personal care', kind: 'expense' },
  { role: 'services', name: 'Services and fees', kind: 'expense' },
  { role: 'other', name: 'Other', kind: 'expense' },
  { role: 'transfers', name: 'Transfers', kind: 'transfer' },
];

/** Plaid's primary personal finance categories, each with the group it starts
 *  in. Every one is seeded, used yet or not, so a category Plaid starts using
 *  later lands somewhere sensible; a primary Plaid adds after this list grows
 *  like any other key. */
export const PLAID_PRIMARIES: Readonly<Record<string, string>> = {
  INCOME: 'income',
  FOOD_AND_DRINK: 'food',
  GENERAL_MERCHANDISE: 'shopping',
  RENT_AND_UTILITIES: 'housing',
  HOME_IMPROVEMENT: 'housing',
  TRANSPORTATION: 'transport',
  TRAVEL: 'leisure',
  ENTERTAINMENT: 'leisure',
  MEDICAL: 'health',
  PERSONAL_CARE: 'health',
  GENERAL_SERVICES: 'services',
  GOVERNMENT_AND_NON_PROFIT: 'services',
  BANK_FEES: 'services',
  TRANSFER_IN: 'transfers',
  TRANSFER_OUT: 'transfers',
  LOAN_PAYMENTS: 'transfers',
};

/** What seeding names the uncategorized category, and its text key: the
 *  bucket every total filed a transaction without a category under. */
const OTHER = 'other';

/** A key seen on a transaction (or a budget), to grow the set by, with the
 *  words as they were written (`label`), for the name of a category grown
 *  from them. */
export type ObservedKey = { provider: typeof PLAID | typeof TEXT; key: string; label?: string };

/**
 * A new set: the default groups, every Plaid primary, Other (uncategorized),
 * then whatever `observed` holds that those don't (the categories already on
 * the person's transactions, overrides and budgets), each where its kind
 * belongs. `newId` makes the ids (random ones, in the app).
 */
export function seedTaxonomy(observed: Iterable<ObservedKey>, newId: () => string): Taxonomy {
  const groups = DEFAULT_GROUPS.map((g, order) => ({ id: newId(), name: g.name, kind: g.kind, order }));
  const groupFor = (role: string) => groups[DEFAULT_GROUPS.findIndex((g) => g.role === role)].id;
  const other: Category = { id: newId(), name: defaultName(OTHER), group: groupFor('other'), provider_keys: [{ provider: TEXT, key: OTHER }] };
  const categories: Category[] = [
    other,
    ...Object.entries(PLAID_PRIMARIES).map(([value, role]) => ({
      id: newId(),
      name: defaultName(plaidText(value)),
      group: groupFor(role),
      provider_keys: [
        { provider: PLAID, key: value },
        { provider: TEXT, key: plaidText(value) },
      ],
    })),
  ];
  return growTaxonomy({ version: TAXONOMY_VERSION, groups, categories, uncategorized: other.id }, observed, newId).taxonomy;
}

// ---- Looking things up ----

const slot = (provider: string, key: string) => `${provider}\u0000${key}`;

/** A set, indexed for resolving transactions against it. */
export type CategoryIndex = {
  readonly taxonomy: Taxonomy;
  readonly byId: ReadonlyMap<string, Category>;
  readonly groupById: ReadonlyMap<string, CategoryGroup>;
  /** Category id by provider and key. */
  readonly byKey: ReadonlyMap<string, string>;
};

export function indexTaxonomy(taxonomy: Taxonomy): CategoryIndex {
  const byKey = new Map<string, string>();
  for (const c of taxonomy.categories) for (const k of c.provider_keys) byKey.set(slot(k.provider, k.key), c.id);
  return {
    taxonomy,
    byId: new Map(taxonomy.categories.map((c) => [c.id, c])),
    groupById: new Map(taxonomy.groups.map((g) => [g.id, g])),
    byKey,
  };
}

/** The category a key files into, or null. */
export function categoryForKey(ix: CategoryIndex, provider: string, key: string): Category | null {
  const id = ix.byKey.get(slot(provider, key));
  return id === undefined ? null : (ix.byId.get(id) ?? null);
}

/** The category an id names, following merges to where it went; null for an
 *  id no category has (deleted, or never one). */
export function categoryById(ix: CategoryIndex, id: string): Category | null {
  let at = id;
  // Merges are kept pointing at their final category; the bound only guards
  // against a set edited by hand into a loop.
  for (let hops = 0; hops < 8; hops++) {
    const c = ix.byId.get(at);
    if (c) return c;
    const next = ix.taxonomy.merged?.[at];
    if (next === undefined) return null;
    at = next;
  }
  return null;
}

/** A category's group. */
export function groupOf(ix: CategoryIndex, c: Category): CategoryGroup {
  return ix.groupById.get(c.group)!;
}

/** The text a choice of this category is stored as: its first text key. */
export function choiceText(c: Category): string {
  return c.provider_keys.find((k) => k.provider === TEXT)!.key;
}

/** The uncategorized category. */
export function uncategorizedOf(ix: CategoryIndex): Category {
  return ix.byId.get(ix.taxonomy.uncategorized)!;
}

/** Groups in their order (then by name, for groups saved with the same). */
export function sortedGroups(t: Taxonomy): CategoryGroup[] {
  return [...t.groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** A group's categories, by name. */
export function categoriesIn(t: Taxonomy, group: string): Category[] {
  return t.categories.filter((c) => c.group === group).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Resolution ----

/** What resolution reads of a transaction (lib/transactions.ts Txn, before
 *  its category is resolved). */
export type CategoryFacts = {
  /** The category text the row carries: the one chosen for it, else carried
   *  across a re-link, else Plaid's primary in words, or a manual or imported
   *  row's own. */
  category: string | null;
  /** True when `category` is the person's choice (lib/activity.ts). */
  category_set?: boolean;
  /** A manual or imported row's source: its category is its own. */
  source?: string;
  /** Plaid's own values, on a bank's row. */
  pfc_primary?: string | null;
  pfc_detailed?: string | null;
};

/** Where a transaction is filed: its category, and whether the row said
 *  anything about its category at all (a row that says nothing shows no
 *  category, as before, and is counted under the uncategorized one). */
export type Filed = { category: Category; said: boolean };

/** The category a transaction is filed under (see RESOLUTION in the header). */
export function resolveCategory(ix: CategoryIndex, f: CategoryFacts): Filed {
  const text = f.category ? textKey(f.category) : '';
  const own = !!f.category_set || f.source !== undefined;
  if (own && text) {
    const c = categoryForKey(ix, TEXT, text);
    if (c) return { category: c, said: true };
  }
  // Rules (#36) go here.
  if (!own) {
    for (const value of [f.pfc_detailed, f.pfc_primary]) {
      if (!value) continue;
      const c = categoryForKey(ix, PLAID, value);
      if (c) return { category: c, said: true };
    }
  }
  if (text) {
    const c = categoryForKey(ix, TEXT, text);
    if (c) return { category: c, said: true };
  }
  // A key with no category (only past MAX_CATEGORIES) is filed as
  // uncategorized, and still said something.
  return { category: uncategorizedOf(ix), said: !!text || !!f.pfc_primary || !!f.pfc_detailed };
}

/** The keys transactions carry that a set must have to file them: each row's
 *  text, and Plaid's primary value. Detailed values are only ever mapped by
 *  hand, so a row's falls through to its primary. */
export function observedKeys(rows: Iterable<CategoryFacts>): ObservedKey[] {
  const seen = new Map<string, ObservedKey>();
  for (const r of rows) {
    const text = r.category ? textKey(r.category) : '';
    if (text) seen.set(slot(TEXT, text), { provider: TEXT, key: text });
    if (r.pfc_primary) seen.set(slot(PLAID, r.pfc_primary), { provider: PLAID, key: r.pfc_primary });
  }
  return [...seen.values()];
}

/** Texts (a budget's names, override values) as keys to grow by, each with
 *  the words as first written. */
export function textKeys(texts: Iterable<string>): ObservedKey[] {
  const out = new Map<string, ObservedKey>();
  for (const s of texts) {
    const key = textKey(s);
    if (key && !out.has(key)) out.set(key, { provider: TEXT, key, label: cleanName(s) });
  }
  return [...out.values()];
}

/** Whether a set lacks any of these keys. */
export function lacksKeys(t: Taxonomy | CategoryIndex, observed: Iterable<ObservedKey>): boolean {
  const ix = 'byKey' in t ? t : indexTaxonomy(t);
  for (const o of observed) if (!ix.byKey.has(slot(o.provider, o.key))) return true;
  return false;
}

// ---- Growing ----

/**
 * The set with a category for every observed key it lacks (see GROWING in the
 * header): a key Plaid's words or a name already match joins that category;
 * anything else becomes a new category, in the group its kind belongs to (the
 * uncategorized category's group for spending, the first group of its kind
 * otherwise, made if there is none). `added` counts the keys taken in; the
 * set is returned as it was when it is 0. `full` says a key found no room:
 * past `limit` categories (MAX_CATEGORIES), which a budget's name, that must
 * always have a category, is grown without.
 */
export function growTaxonomy(
  t: Taxonomy,
  observed: Iterable<ObservedKey>,
  newId: () => string,
  opts: { limit?: number } = {}
): { taxonomy: Taxonomy; added: number; full: boolean } {
  const limit = opts.limit ?? MAX_CATEGORIES;
  const ix = indexTaxonomy(t);
  const missing = [...observed].filter((o) => !ix.byKey.has(slot(o.provider, o.key)));
  if (missing.length === 0) return { taxonomy: t, added: 0, full: false };

  const categories = t.categories.map((c) => ({ ...c, provider_keys: [...c.provider_keys] }));
  const groups = t.groups.map((g) => ({ ...g }));
  const byKey = new Map(ix.byKey);
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));
  const byPlaidText = new Map<string, Category>();
  for (const c of categories) for (const k of c.provider_keys) if (k.provider === PLAID && !byPlaidText.has(plaidText(k.key))) byPlaidText.set(plaidText(k.key), c);
  let added = 0;
  let full = false;

  const take = (c: Category, k: ObservedKey) => {
    if (byKey.has(slot(k.provider, k.key))) return;
    c.provider_keys.push({ provider: k.provider, key: k.key });
    byKey.set(slot(k.provider, k.key), c.id);
    if (k.provider === PLAID && !byPlaidText.has(plaidText(k.key))) byPlaidText.set(plaidText(k.key), c);
    added++;
  };
  const groupFor = (kind: CategoryKind): string => {
    const home = categories.find((c) => c.id === t.uncategorized)?.group;
    if (kind === 'expense' && home && groups.find((g) => g.id === home)?.kind === 'expense') return home;
    const first = [...groups].sort((a, b) => a.order - b.order).find((g) => g.kind === kind);
    if (first) return first.id;
    const made = {
      id: newId(),
      name: kind === 'income' ? 'Income' : kind === 'transfer' ? 'Transfers' : 'Other',
      kind,
      order: groups.reduce((n, g) => Math.max(n, g.order + 1), 0),
    };
    groups.push(made);
    return made.id;
  };
  const make = (name: string, kind: CategoryKind, keys: ObservedKey[]) => {
    if (categories.length >= limit) {
      full = true;
      return;
    }
    const c: Category = { id: newId(), name, group: groupFor(kind), provider_keys: [] };
    categories.push(c);
    byName.set(name.toLowerCase(), c);
    for (const k of keys) take(c, k);
  };

  for (const o of missing) {
    if (byKey.has(slot(o.provider, o.key))) continue; // taken in with an earlier one
    if (o.provider === PLAID) {
      const words = plaidText(o.key);
      const text: ObservedKey = { provider: TEXT, key: words };
      const id = byKey.get(slot(TEXT, words));
      const c = (id !== undefined ? categories.find((x) => x.id === id) : undefined) ?? byName.get(defaultName(words).toLowerCase());
      if (c) {
        take(c, o);
        take(c, text);
      } else make(defaultName(words), legacyKind(words), [o, text]);
    } else {
      const c = byPlaidText.get(o.key) ?? byName.get(o.key);
      const label = o.label && textKey(o.label) === o.key && o.label.length <= NAME_MAX ? o.label : o.key;
      if (c) take(c, o);
      else make(defaultName(label), legacyKind(o.key), [o]);
    }
  }
  if (added === 0) return { taxonomy: t, added: 0, full };
  return { taxonomy: { ...t, groups, categories }, added, full };
}

// ---- The stored shape ----

/** An id: random (crypto.randomUUID()) in the app. No ":", which marks a
 *  provisional id the read-only API makes and never stores. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Text within a bound, not blank. The bounds are the stored shape's, wider
 *  than an edit may make, so a set saved under other limits still reads. */
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && v.trim().length > 0;

/**
 * The stored shape, checked on every read and before every write
 * (lib/category-store.ts): version 1, every id unique and well formed, every
 * category in a group that exists, each provider key in one category only,
 * every category with a text key, the uncategorized category there, and each
 * merge pointing at a category that is. Fields a later release adds to the
 * set, a group or a category are let through and kept by every edit here, so
 * a rollback still reads it rather than locking the person out of their
 * categories; a change of meaning bumps the version instead.
 */
export function isTaxonomy(v: unknown): v is Taxonomy {
  if (!isRecord(v) || v.version !== TAXONOMY_VERSION) return false;
  if (!Array.isArray(v.groups) || !Array.isArray(v.categories) || v.groups.length > 500 || v.categories.length > 5000) return false;
  const groups = new Set<string>();
  for (const g of v.groups) {
    if (!isRecord(g) || typeof g.id !== 'string' || !ID.test(g.id) || groups.has(g.id)) return false;
    if (!isText(g.name, 200) || !CATEGORY_KINDS.includes(g.kind as CategoryKind)) return false;
    if (typeof g.order !== 'number' || !Number.isFinite(g.order)) return false;
    groups.add(g.id);
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const c of v.categories) {
    if (!isRecord(c) || typeof c.id !== 'string' || !ID.test(c.id) || ids.has(c.id)) return false;
    if (!isText(c.name, 200) || typeof c.group !== 'string' || !groups.has(c.group)) return false;
    if (c.icon !== undefined && !isText(c.icon, 64)) return false;
    if (c.archived !== undefined && typeof c.archived !== 'boolean') return false;
    if (!Array.isArray(c.provider_keys) || c.provider_keys.length > 1000) return false;
    let text = false;
    for (const k of c.provider_keys) {
      if (!isRecord(k) || typeof k.provider !== 'string' || !PROVIDER.test(k.provider) || typeof k.key !== 'string') return false;
      if (k.key.length === 0 || k.key.length > 200 || keys.has(slot(k.provider, k.key))) return false;
      keys.add(slot(k.provider, k.key));
      if (k.provider === TEXT) text = true;
    }
    if (!text) return false;
    ids.add(c.id);
  }
  if (typeof v.uncategorized !== 'string' || !ids.has(v.uncategorized)) return false;
  if (v.merged !== undefined) {
    if (!isRecord(v.merged)) return false;
    for (const [from, into] of Object.entries(v.merged)) {
      if (!ID.test(from) || ids.has(from) || typeof into !== 'string' || !ids.has(into)) return false;
    }
  }
  return true;
}

/** Whether an id is one the read-only API made for a category the stored set
 *  doesn't have yet (lib/category-store.ts): never stored, never shown. */
export function isProvisionalId(id: string): boolean {
  return id.includes(':');
}

// ---- Managing ----

/** An edit refused, with what to say to the person and the status a route
 *  answers with: 400 a bad request, 404 nothing there, 409 not now. */
export class CategoryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
    this.name = 'CategoryError';
  }
}

function findCategory(t: Taxonomy, id: string): Category {
  const c = t.categories.find((x) => x.id === id);
  if (!c) throw new CategoryError('That category no longer exists. Reload to see your categories as they are.', 404);
  return c;
}

function findGroup(t: Taxonomy, id: string): CategoryGroup {
  const g = t.groups.find((x) => x.id === id);
  if (!g) throw new CategoryError('That group no longer exists. Reload to see your categories as they are.', 404);
  return g;
}

function checkName(raw: unknown, what: 'category' | 'group'): string {
  if (typeof raw !== 'string') throw new CategoryError(`Give the ${what} a name.`);
  const name = cleanName(raw);
  if (!name) throw new CategoryError(`Give the ${what} a name.`);
  if (name.length > NAME_MAX) throw new CategoryError(`A ${what}'s name can be at most ${NAME_MAX} characters.`);
  return name;
}

function checkIcon(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new CategoryError('That icon is not one Nya can show.');
  const icon = raw.normalize('NFC').trim();
  if (!icon) return undefined;
  if (icon.length > ICON_MAX || /[\u0000-\u001f\u007f]/.test(icon)) throw new CategoryError(`An icon can be at most ${ICON_MAX} characters: an emoji, say.`);
  return icon;
}

/** Refuses a name another category has (in any case), saying where it is. */
function checkUnique(t: Taxonomy, name: string, except?: string): void {
  const other = t.categories.find((c) => c.id !== except && c.name.toLowerCase() === name.toLowerCase());
  if (!other) return;
  throw new CategoryError(
    other.archived
      ? `There is already a category named ${other.name}, archived: unarchive it instead.`
      : `There is already a category named ${other.name}. Merge the two to make them one.`,
    409
  );
}

/** A text key for a new category: its name's, or, when an earlier category
 *  already has those words (one since renamed), the first of "words (2)",
 *  "words (3)"... that none has. */
function freeTextKey(t: Taxonomy, name: string): string {
  const taken = new Set(t.categories.flatMap((c) => c.provider_keys.filter((k) => k.provider === TEXT).map((k) => k.key)));
  const base = textKey(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
}

const replaceCategory = (t: Taxonomy, c: Category): Taxonomy => ({ ...t, categories: t.categories.map((x) => (x.id === c.id ? c : x)) });

/** A new category, in a group. */
export function addCategory(t: Taxonomy, input: { name: unknown; group: unknown; icon?: unknown }, newId: () => string): { taxonomy: Taxonomy; category: Category } {
  const name = checkName(input.name, 'category');
  if (typeof input.group !== 'string') throw new CategoryError('Choose a group for it.');
  findGroup(t, input.group);
  checkUnique(t, name);
  if (t.categories.length >= MAX_CATEGORIES) throw new CategoryError(`You can have at most ${MAX_CATEGORIES} categories. Merge or delete some first.`, 409);
  const icon = checkIcon(input.icon);
  const category: Category = { id: newId(), name, group: input.group, ...(icon ? { icon } : {}), provider_keys: [{ provider: TEXT, key: freeTextKey(t, name) }] };
  return { taxonomy: { ...t, categories: [...t.categories, category] }, category };
}

/** A new name, everywhere at once: nothing stored elsewhere names it. */
export function renameCategory(t: Taxonomy, id: string, rawName: unknown): Taxonomy {
  const c = findCategory(t, id);
  const name = checkName(rawName, 'category');
  checkUnique(t, name, id);
  return replaceCategory(t, { ...c, name });
}

/** Sets or clears its icon. */
export function setCategoryIcon(t: Taxonomy, id: string, rawIcon: unknown): Taxonomy {
  const c = findCategory(t, id);
  const icon = checkIcon(rawIcon);
  const next: Category = { ...c };
  if (icon) next.icon = icon;
  else delete next.icon;
  return replaceCategory(t, next);
}

/** Into another group. Into one of another kind changes how its transactions
 *  count (lib/spending.ts); the uncategorized category stays spending, since
 *  what says nothing has always counted as spending. */
export function moveCategory(t: Taxonomy, id: string, group: unknown): Taxonomy {
  const c = findCategory(t, id);
  if (typeof group !== 'string') throw new CategoryError('Choose a group for it.');
  const g = findGroup(t, group);
  if (c.id === t.uncategorized && g.kind !== 'expense') {
    throw new CategoryError(`${c.name} is where transactions with no category go, which count as spending: it stays in a spending group.`, 409);
  }
  return replaceCategory(t, { ...c, group: g.id });
}

/** Archived: out of the lists to choose from, still on every transaction in
 *  it, and still filing new ones (its keys stay). */
export function setArchived(t: Taxonomy, id: string, archived: boolean): Taxonomy {
  const c = findCategory(t, id);
  if (archived && c.id === t.uncategorized) {
    throw new CategoryError(`${c.name} is where transactions with no category go, so it can't be archived.`, 409);
  }
  const next: Category = { ...c };
  if (archived) next.archived = true;
  else delete next.archived;
  return replaceCategory(t, next);
}

/**
 * Merges `from` into `into`: `into` takes every key of `from`, so every
 * transaction filed under either is filed under `into`, and `from` goes, with a
 * note of where (merged), so anything still naming it finds `into`. Only
 * within one kind, so no total moves: a transfer merged into spending would
 * start counting. The uncategorized category can be merged into, never away.
 */
export function mergeCategories(t: Taxonomy, fromId: string, intoId: unknown): Taxonomy {
  const from = findCategory(t, fromId);
  if (typeof intoId !== 'string') throw new CategoryError('Choose the category to merge it into.');
  const into = findCategory(t, intoId);
  if (from.id === into.id) throw new CategoryError('Choose another category to merge it into.');
  if (from.id === t.uncategorized) {
    throw new CategoryError(`${from.name} is where transactions with no category go, so it can't be merged away. Merge the other into it instead.`, 409);
  }
  if (into.archived) throw new CategoryError(`${into.name} is archived: unarchive it before merging into it.`, 409);
  const ix = indexTaxonomy(t);
  const [kf, ki] = [groupOf(ix, from).kind, groupOf(ix, into).kind];
  if (kf !== ki) {
    throw new CategoryError(
      `${from.name} counts as ${KIND_WORDS[kf]} and ${into.name} as ${KIND_WORDS[ki]}, so merging them would change your totals. Move one into a group of the other's kind first.`,
      409
    );
  }
  const merged: Record<string, string> = {};
  for (const [a, b] of Object.entries(t.merged ?? {})) merged[a] = b === from.id ? into.id : b;
  merged[from.id] = into.id;
  return {
    ...t,
    categories: t.categories
      .filter((c) => c.id !== from.id)
      .map((c) => (c.id === into.id ? { ...c, provider_keys: [...c.provider_keys, ...from.provider_keys] } : c)),
    merged,
  };
}

/** How a kind is said in a sentence. */
export const KIND_WORDS: Readonly<Record<CategoryKind, string>> = { expense: 'spending', income: 'income', transfer: 'a transfer' };

/** What still uses a category, for deleting it (lib/category-store.ts
 *  categoryUsage). */
export type CategoryUsage = { transactions: number; budget: boolean };

/**
 * Deletes a category nothing uses: no transaction is filed under it and no
 * budget is set on it. One Plaid files into is never deleted (Plaid would file
 * its next transaction nowhere): archive it or merge it instead.
 */
export function deleteCategory(t: Taxonomy, id: string, usage: CategoryUsage): Taxonomy {
  const c = findCategory(t, id);
  if (c.id === t.uncategorized) throw new CategoryError(`${c.name} is where transactions with no category go, so it can't be deleted.`, 409);
  const provider = c.provider_keys.find((k) => k.provider !== TEXT)?.provider;
  if (provider) {
    const who = provider === PLAID ? 'Plaid files' : `${provider} files`;
    throw new CategoryError(`${who} your bank's transactions under ${c.name}, so it can't be deleted. Archive it to hide it, or merge it into another category.`, 409);
  }
  if (usage.transactions > 0 || usage.budget) {
    const what = [
      ...(usage.transactions > 0 ? [`${usage.transactions} transaction${usage.transactions === 1 ? '' : 's'}`] : []),
      ...(usage.budget ? ['a budget'] : []),
    ].join(' and ');
    throw new CategoryError(`${c.name} is used by ${what}, so it can't be deleted. Merge it into another category, or archive it to hide it.`, 409);
  }
  const merged = Object.fromEntries(Object.entries(t.merged ?? {}).filter(([, into]) => into !== id));
  return { ...t, categories: t.categories.filter((x) => x.id !== id), ...(t.merged ? { merged } : {}) };
}

function checkGroupName(t: Taxonomy, raw: unknown, except?: string): string {
  const name = checkName(raw, 'group');
  if (t.groups.some((g) => g.id !== except && g.name.toLowerCase() === name.toLowerCase())) {
    throw new CategoryError(`There is already a group named ${name}.`, 409);
  }
  return name;
}

/** A new group, last. Its kind is for good: moving a category into another
 *  group is how one changes kind. */
export function addGroup(t: Taxonomy, input: { name: unknown; kind: unknown }, newId: () => string): { taxonomy: Taxonomy; group: CategoryGroup } {
  const name = checkGroupName(t, input.name);
  if (!CATEGORY_KINDS.includes(input.kind as CategoryKind)) throw new CategoryError('Say whether it holds spending, income or transfers.');
  if (t.groups.length >= MAX_GROUPS) throw new CategoryError(`You can have at most ${MAX_GROUPS} groups.`, 409);
  const group: CategoryGroup = { id: newId(), name, kind: input.kind as CategoryKind, order: t.groups.reduce((n, g) => Math.max(n, g.order + 1), 0) };
  return { taxonomy: { ...t, groups: [...t.groups, group] }, group };
}

export function renameGroup(t: Taxonomy, id: string, rawName: unknown): Taxonomy {
  const g = findGroup(t, id);
  const name = checkGroupName(t, rawName, id);
  return { ...t, groups: t.groups.map((x) => (x.id === g.id ? { ...x, name } : x)) };
}

/** The groups in a new order: `ids` is every group's id, once, in the order
 *  wanted. A list that isn't (a group added or deleted meanwhile) is
 *  refused, so nothing is put somewhere by guesswork. */
export function orderGroups(t: Taxonomy, ids: unknown): Taxonomy {
  if (!Array.isArray(ids) || ids.length !== t.groups.length || new Set(ids).size !== ids.length || !ids.every((id) => t.groups.some((g) => g.id === id))) {
    throw new CategoryError('Your groups changed since this page loaded. Reload to see them as they are.', 409);
  }
  const at = new Map((ids as string[]).map((id, i) => [id, i]));
  return { ...t, groups: t.groups.map((g) => ({ ...g, order: at.get(g.id)! })) };
}

/** Deletes a group with nothing in it: no category, and no budget of its own
 *  (`budgeted`), which would otherwise go with it unasked. */
export function deleteGroup(t: Taxonomy, id: string, budgeted: boolean): Taxonomy {
  const g = findGroup(t, id);
  const inside = t.categories.filter((c) => c.group === id).length;
  if (inside > 0) {
    throw new CategoryError(`${g.name} still holds ${inside} categor${inside === 1 ? 'y' : 'ies'}: move or merge them into other groups first.`, 409);
  }
  if (budgeted) throw new CategoryError(`${g.name} has a budget of its own: remove it on the Budgets tab first.`, 409);
  return { ...t, groups: t.groups.filter((x) => x.id !== id) };
}
