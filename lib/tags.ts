// lib/tags.ts
//
// Your tags (#40): labels that cut across categories ("reimbursable",
// "vacation 2026", "tax deductible"), any number of them on a transaction.
// This module keeps what a tag is (its id, name and color); which tags a
// transaction carries is said beside the transaction (lib/txn-annotations.ts,
// by the transaction's id, for a bank's row and a manual, imported or
// SimpleFIN one alike), and rules can add them on read (lib/rules.ts).
//
// ONE VALUE PER CONTAINER on the storage seam (lib/repo.ts), the `tags`
// store: the list of tags, encrypted, edited with a compare-and-set
// (ValueStore.update), so a tag created from one transaction on a phone and
// another renamed on a laptop both land (lib/tags-store.ts). This module is
// the pure part, safe in the browser.
//
// IDS, NOT NAMES. A transaction and a rule hold a tag's random id, so renaming
// a tag renames it everywhere at once, and two tags never share a name in any
// case ("Work" and "work" are one tag). Reads show only the ids of tags that
// exist: an id no tag has is never shown, counted or answered by the API.
//
// DELETING A TAG takes it off every transaction and out of every rule, in a
// sequence that can't leave half a state (lib/tag-delete.ts): first the tag
// leaves this list and its id is noted under `deleting`, in one
// compare-and-set, so from that moment no transaction, filter, total or answer
// has it; then its id is swept out of what the person said about each
// transaction, what was carried from earlier accounts, and the rules; last the
// note goes. A sweep that stops part way leaves ids nothing shows, and the
// next change to the tags finishes it (`deleting` says which ids to sweep, so
// a tag made meanwhile on another device is never swept by mistake).
//
// LATER FIELDS SURVIVE. A field a later release adds to the list or to a tag
// is let through and kept by every edit here, as the categories' are, so a
// rollback still reads the tags rather than losing every one of them; a change
// of meaning bumps the version instead.


/** Bumped only when a field changes meaning. */
export const TAGS_VERSION = 1;

/** The colors a tag can have, by name: the app draws each from its own
 *  palette, in both themes. A color a later release adds reads, and shows as
 *  the first. */
export const TAG_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export type Tag = {
  /** Random (crypto.randomUUID()): what transactions and rules hold. */
  id: string;
  name: string;
  /** One of TAG_COLORS (or a later release's). */
  color: string;
  created_at: string;
};

export type TagSet = {
  version: typeof TAGS_VERSION;
  /** In the order they were made. */
  tags: Tag[];
  /** Tags deleted whose ids may still be on a transaction or a rule, until
   *  the sweep has taken them off (see DELETING above). Never shown. */
  deleting?: string[];
};

// ---- Limits ----

/** A tag's name: short enough to sit on a transaction's row. */
export const TAG_NAME_MAX = 40;
/** Tags a person can have. */
export const MAX_TAGS = 250;
/** Tags on one transaction, put there by hand. */
export const MAX_TAGS_PER_TRANSACTION = 20;

/** A tag's id as stored and as a route takes one: what crypto.randomUUID()
 *  makes, or any id of the same characters (a restored or hand-made list). */
const TAG_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isTagId(v: unknown): v is string {
  return typeof v === 'string' && TAG_ID.test(v);
}

const COLOR = /^[a-z]{1,20}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInstant = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/**
 * The stored shape, checked on every read and before every write: version 1,
 * each tag with a well formed id (once), a name that isn't blank, a color
 * written as a word and when it was made; `deleting` a list of ids. The
 * bounds are the stored shape's, wider than an edit may make, so a list saved
 * under other limits still reads. Fields a later release adds ride along.
 */
export function isTagSet(v: unknown): v is TagSet {
  if (!isRecord(v) || v.version !== TAGS_VERSION || !Array.isArray(v.tags) || v.tags.length > 5000) return false;
  const ids = new Set<string>();
  for (const t of v.tags) {
    if (!isRecord(t) || !isTagId(t.id) || ids.has(t.id)) return false;
    if (typeof t.name !== 'string' || t.name.trim().length === 0 || t.name.length > 200) return false;
    if (typeof t.color !== 'string' || !COLOR.test(t.color) || !isInstant(t.created_at)) return false;
    ids.add(t.id);
  }
  if (v.deleting !== undefined && (!Array.isArray(v.deleting) || v.deleting.length > 5000 || !v.deleting.every(isTagId))) return false;
  return true;
}

/** A list with no tags, for a container that never saved one. */
export const emptyTagSet = (): TagSet => ({ version: TAGS_VERSION, tags: [] });

// ---- Names ----

/** A name as typed: Unicode-normalized, spaces collapsed, trimmed. */
export function cleanTagName(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** What two names are compared by: "Work" and "work" are one tag. */
export const tagNameKey = (s: string): string => cleanTagName(s).toLowerCase();

/** A tag's color as the app draws it: its own when the app knows it, else the
 *  first (a color a later release added). */
export function shownColor(color: string): TagColor {
  return (TAG_COLORS as readonly string[]).includes(color) ? (color as TagColor) : TAG_COLORS[0];
}

// ---- Looking things up ----

/** The ids of the tags that exist: everything shown is among them. */
export function liveTagIds(set: TagSet | null): Set<string> {
  return new Set((set?.tags ?? []).map((t) => t.id));
}

/** The tag with this name, in any case, or null. */
export function tagByName(set: TagSet | null, name: string): Tag | null {
  const key = tagNameKey(name);
  return set?.tags.find((t) => tagNameKey(t.name) === key) ?? null;
}

/** Ids in the order the tags were made, those of tags that don't exist left
 *  out: how a transaction's tags are listed. */
export function orderTagIds(set: TagSet | null, ids: Iterable<string>): string[] {
  const wanted = new Set(ids);
  return (set?.tags ?? []).filter((t) => wanted.has(t.id)).map((t) => t.id);
}

// ---- Editing ----

/** An edit refused, with what to say to the person and the status a route
 *  answers with: 400 a bad request, 404 nothing there, 409 not now. */
export class TagError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400
  ) {
    super(message);
    this.name = 'TagError';
  }
}

/** A name as an edit takes it, or a TagError saying why not. */
export function checkTagName(raw: unknown): string {
  if (typeof raw !== 'string') throw new TagError('Give the tag a name.');
  const name = cleanTagName(raw);
  if (!name) throw new TagError('Give the tag a name.');
  if (name.length > TAG_NAME_MAX) throw new TagError(`A tag's name can be at most ${TAG_NAME_MAX} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new TagError('A tag’s name can’t hold control characters.');
  return name;
}

function checkColor(raw: unknown): TagColor {
  if (typeof raw !== 'string' || !(TAG_COLORS as readonly string[]).includes(raw)) {
    throw new TagError(`A tag's color is one of ${TAG_COLORS.join(', ')}.`);
  }
  return raw as TagColor;
}

function checkUnique(set: TagSet, name: string, except?: string): void {
  const other = set.tags.find((t) => t.id !== except && tagNameKey(t.name) === tagNameKey(name));
  if (other) throw new TagError(`There is already a tag named ${other.name}.`, 409);
}

function findTag(set: TagSet, id: unknown): Tag {
  const t = isTagId(id) ? set.tags.find((x) => x.id === id) : undefined;
  if (!t) throw new TagError('That tag no longer exists. Reload to see your tags as they are.', 404);
  return t;
}

/** The color a new tag gets when none is chosen: the next in the palette, so
 *  tags made one after another are told apart. */
export function nextColor(set: TagSet | null): TagColor {
  const used = (set?.tags.length ?? 0) % (TAG_COLORS.length - 1);
  return TAG_COLORS[used + 1];
}

/** A new tag, last. */
export function addTag(set: TagSet, input: { name: unknown; color?: unknown }, newId: () => string, now: Date = new Date()): { set: TagSet; tag: Tag } {
  const name = checkTagName(input.name);
  checkUnique(set, name);
  if (set.tags.length >= MAX_TAGS) throw new TagError(`You can have at most ${MAX_TAGS} tags. Delete some first.`, 409);
  const color = input.color === undefined || input.color === null ? nextColor(set) : checkColor(input.color);
  const tag: Tag = { id: newId(), name, color, created_at: now.toISOString() };
  return { set: { ...set, tags: [...set.tags, tag] }, tag };
}

/** A new name, everywhere at once: nothing else holds it. */
export function renameTag(set: TagSet, id: unknown, rawName: unknown): TagSet {
  const tag = findTag(set, id);
  const name = checkTagName(rawName);
  checkUnique(set, name, tag.id);
  return { ...set, tags: set.tags.map((t) => (t.id === tag.id ? { ...t, name } : t)) };
}

export function recolorTag(set: TagSet, id: unknown, rawColor: unknown): TagSet {
  const tag = findTag(set, id);
  const color = checkColor(rawColor);
  return { ...set, tags: set.tags.map((t) => (t.id === tag.id ? { ...t, color } : t)) };
}

/** The first step of deleting a tag (see DELETING above): out of the list,
 *  its id noted for the sweep. A tag already gone is refused (404) unless it
 *  is still being swept, which goes on. */
export function markDeleted(set: TagSet, id: unknown): TagSet {
  if (isTagId(id) && set.deleting?.includes(id) && !set.tags.some((t) => t.id === id)) return set;
  const tag = findTag(set, id);
  return { ...set, tags: set.tags.filter((t) => t.id !== tag.id), deleting: [...(set.deleting ?? []), tag.id] };
}

/** The last step: the swept ids' notes go. */
export function sweptAway(set: TagSet, ids: readonly string[]): TagSet {
  if (!set.deleting?.some((id) => ids.includes(id))) return set;
  const deleting = set.deleting.filter((id) => !ids.includes(id));
  const next: TagSet = { ...set, deleting };
  if (deleting.length === 0) delete next.deleting;
  return next;
}

// ---- Ids ----

/** A new tag's id: random, so it says nothing of what it is. */
export const newTagId = (): string => crypto.randomUUID();
