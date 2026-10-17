// lib/key-archive.ts
//
// The key archives: the key store's own backups, kept apart from the nightly
// data archives (docs/operations.md, "Per-container data keys"). A data
// archive (lib/export.ts, format 2) leaves the key store out, so it can't be
// read on its own; a key archive holds the wrapped keys, the tombstones of the
// destroyed ones and the few records beside them. Kept apart so a deletion can
// take a destroyed key out of every copy Nya keeps, in seconds, without
// rewriting a data archive.
//
// SEVEN GENERATIONS, under keys/<environment>/ in the same private Blob store,
// outside the folder the data archives are pruned from. A new one is written
// each night after the data archive; the oldest beyond seven is deleted only
// once the new one is checked, and never on a night that fails.
//
// NO KEY IS EVER DROPPED WITHOUT A TOMBSTONE. A generation holds every key of
// the live store and every key of the generation before it that hasn't been
// tombstoned. A key that has left the live store without a tombstone (removed
// by hand, a bug, a restore of an older point) is carried forward with when it
// was first missed, for as long as a kept data archive may need it, and longer
// while a value tonight's data archive holds names it.
//
// CHECKED before anything older is deleted: it reads back byte for byte;
// every key from the live store unwraps with the current master and is the
// key its id names (and, while a rotation is prepared, carries the next
// master's lock); it holds every key id a value in the same night's data
// archive names, or a tombstone for it; and every key of the generation
// before, but those tombstoned since.
//
// REWRITTEN AT EVERY DELETION. A rewrite is a pure filter of the file before
// it: the destroyed keys' lines dropped, their tombstones added, checked line
// by line as exactly that before the file it replaces is deleted. The nightly
// run does the same for any generation still holding a tombstoned key.
//
// ONE WRITER AT A TIME: reading the store, writing, checking and deleting
// older files happen under backups:keys-lock (a token and an expiry, released
// only by its holder). A deletion that can't take it, or finish, in its time
// leaves backups:keys-pending, which the next nightly run honours and clears.
//
// Format (one JSON object per line, each ending in "\n"):
//   {"nya_keys":1,"env_prefix":"production","taken_at":"<iso>","written_at":"<iso>","master":"<fingerprint>"}
//   {"key":"k12-0123abcd","record":"<the key's record, as stored>"}
//   {"key":"k3-89abcdef","record":"...","missing_since":"<iso>"}      carried forward
//   {"tombstone":"k9-deadbeef","container":"<id>","on":"<day>"}
//   {"string":"crypto:active","value":"k1-..."}                         and the rest beside the keys
//   {"end":true,"lines":5,"sha256":"<hex>"}
// Keys, then tombstones, then the records beside them, each in code point
// order, so a file is a function of what it holds and a rewrite can be
// checked by building it again. The sha256 covers the header and every line
// before the footer, as in lib/export.ts. Never a value, a context or a key
// in the clear: every key is wrapped by the master.

import { createHash } from 'node:crypto';
import { envPrefix } from './storage';
import {
  currentMaster,
  isKeyId,
  masterKeyConfigured,
  keysHashKey,
  parseStoredDataKey,
  tombstonesKey,
  unwrapDataKey,
  activeKeyName,
  currentMasterKeyName,
  rotationKey,
  keySeqKey,
  type Tombstone,
} from './crypto';
import type { BackupStore } from './backup';

export const KEY_ARCHIVE_FORMAT = 1;
/** How many nightly generations are kept. */
export const KEY_GENERATIONS = 7;
/** Vercel Blob's shortest cache lifetime, in seconds: a deleted blob can still
 *  be served from its cache this long. */
export const KEY_ARCHIVE_CACHE_SECONDS = 60;

/** The records kept beside the keys and tombstones, relative to the
 *  environment prefix. The rotation lock is in neither kind of file. */
export const BESIDE_KEYS = ['crypto:active', 'crypto:key-seq', 'crypto:master', 'crypto:rotation'] as const;

/** Where each record kept beside the keys lives, in full (lib/crypto.ts). */
export function besideKey(name: (typeof BESIDE_KEYS)[number]): string {
  return { 'crypto:active': activeKeyName, 'crypto:key-seq': keySeqKey, 'crypto:master': currentMasterKeyName, 'crypto:rotation': rotationKey }[name]();
}

const DAY_MS = 86_400_000;

export class KeyArchiveRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyArchiveRefused';
  }
}

export type KeyArchiveHeader = {
  nya_keys: typeof KEY_ARCHIVE_FORMAT;
  env_prefix: string;
  /** When the generation was taken (a rewrite keeps it). */
  taken_at: string;
  /** When this file was written. */
  written_at: string;
  /** The master every key from the live store was checked against. */
  master: string | null;
};

export type KeyEntry = { record: string; missing_since?: string };

/** What a key archive holds. */
export type KeyArchiveContent = {
  keys: Map<string, KeyEntry>;
  tombstones: Map<string, Tombstone>;
  /** The records beside the keys (BESIDE_KEYS), as stored. */
  beside: Map<string, string>;
};

export type VerifiedKeyArchive = KeyArchiveContent & { header: KeyArchiveHeader };

/** Where this environment's key archives live in the store. */
export function keyArchiveFolder(): string {
  return `keys/${envPrefix().replace(/:$/, '')}/`;
}

const stamp = (d: Date | string) => new Date(d).toISOString().replace(/[:.]/g, '-');

/** A generation's file: named by when it was taken, then when it was written,
 *  so a rewrite sorts beside the file it replaces. */
export function keyArchiveName(takenAt: Date | string, writtenAt: Date | string): string {
  return `${keyArchiveFolder()}nya-keys-${stamp(takenAt)}--${stamp(writtenAt)}.ndjson`;
}

const NAME = /nya-keys-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)--(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.ndjson$/;

/** When a key archive's generation was taken, and its file written, from its
 *  name, or null for a name that is not one. */
export function parseKeyArchiveName(pathname: string): { taken: string; written: string } | null {
  const m = NAME.exec(pathname);
  return m ? { taken: m[1], written: m[2] } : null;
}

function refuse(message: string): never {
  throw new KeyArchiveRefused(message);
}

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The lines of a key archive holding `content`, in the one order a file has. */
function contentLines(content: KeyArchiveContent): string[] {
  const lines: string[] = [];
  for (const id of [...content.keys.keys()].sort(byCodePoint)) {
    const e = content.keys.get(id)!;
    lines.push(JSON.stringify(e.missing_since === undefined ? { key: id, record: e.record } : { key: id, record: e.record, missing_since: e.missing_since }));
  }
  for (const id of [...content.tombstones.keys()].sort(byCodePoint)) {
    const t = content.tombstones.get(id)!;
    lines.push(JSON.stringify({ tombstone: id, container: t.container, on: t.on }));
  }
  for (const name of [...content.beside.keys()].sort(byCodePoint)) lines.push(JSON.stringify({ string: name, value: content.beside.get(name)! }));
  return lines;
}

/** A key archive's text. */
export function serializeKeyArchive(header: KeyArchiveHeader, content: KeyArchiveContent): string {
  const hash = createHash('sha256');
  const out: string[] = [];
  const add = (line: string) => {
    hash.update(line + '\n');
    out.push(line + '\n');
  };
  add(JSON.stringify(header));
  const lines = contentLines(content);
  for (const line of lines) add(line);
  out.push(JSON.stringify({ end: true, lines: lines.length, sha256: hash.digest('hex') }) + '\n');
  return out.join('');
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const CONTAINER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Checks a key archive completely, or throws KeyArchiveRefused naming the
 * first problem: its format, footer, hash and count, every line's shape, and
 * that it is in the one order a file has. Pure: touches no storage.
 */
export function verifyKeyArchive(text: string): VerifiedKeyArchive {
  if (text.includes('\r\n')) refuse('The key archive has Windows (CRLF) line endings, so it was converted after it was written. Use the original.');
  if (!text.endsWith('\n')) refuse('The key archive does not end with a complete line; it may be cut short.');
  const lines = text.slice(0, -1).split('\n');
  if (lines.length < 2) refuse('The key archive has no footer; it is incomplete.');
  const parse = (line: string, n: number): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      refuse(`Line ${n} of the key archive is not valid JSON.`);
    }
  };
  const header = parse(lines[0], 1);
  if (!isPlain(header) || !('nya_keys' in header)) refuse('Line 1 is not a key archive header. Is this a data archive?');
  if (header.nya_keys !== KEY_ARCHIVE_FORMAT) refuse(`Key archive format ${JSON.stringify(header.nya_keys)} is not one this code can read.`);
  if (typeof header.env_prefix !== 'string' || !isIso(header.taken_at) || !isIso(header.written_at) || !(header.master === null || typeof header.master === 'string')) {
    refuse('The key archive header is incomplete.');
  }
  const footer = parse(lines[lines.length - 1], lines.length);
  if (!isPlain(footer) || footer.end !== true) refuse('The last line of the key archive is not a footer; it is incomplete.');

  const hash = createHash('sha256');
  hash.update(lines[0] + '\n');
  const content: KeyArchiveContent = { keys: new Map(), tombstones: new Map(), beside: new Map() };
  for (let i = 1; i < lines.length - 1; i++) {
    const n = i + 1;
    const v = parse(lines[i], n);
    hash.update(lines[i] + '\n');
    if (!isPlain(v)) refuse(`Line ${n} of the key archive is not a record.`);
    if ('key' in v) {
      const keys = Object.keys(v);
      const extra = keys.filter((k) => k !== 'key' && k !== 'record' && k !== 'missing_since');
      if (typeof v.key !== 'string' || !isKeyId(v.key) || v.key === 'k0' || typeof v.record !== 'string' || extra.length > 0) refuse(`Line ${n} of the key archive is not a key.`);
      if ('missing_since' in v && !isIso(v.missing_since)) refuse(`Line ${n} of the key archive has an invalid missing_since.`);
      if (content.keys.has(v.key)) refuse(`Line ${n} of the key archive repeats ${v.key}.`);
      content.keys.set(v.key, 'missing_since' in v ? { record: v.record, missing_since: v.missing_since as string } : { record: v.record });
    } else if ('tombstone' in v) {
      if (typeof v.tombstone !== 'string' || !isKeyId(v.tombstone) || typeof v.container !== 'string' || !CONTAINER_ID.test(v.container) || typeof v.on !== 'string' || !DAY.test(v.on) || Object.keys(v).length !== 3) {
        refuse(`Line ${n} of the key archive is not a tombstone.`);
      }
      if (content.tombstones.has(v.tombstone)) refuse(`Line ${n} of the key archive repeats the tombstone of ${v.tombstone}.`);
      content.tombstones.set(v.tombstone, { container: v.container, on: v.on });
    } else if ('string' in v) {
      if (typeof v.string !== 'string' || !(BESIDE_KEYS as readonly string[]).includes(v.string) || typeof v.value !== 'string' || Object.keys(v).length !== 2) {
        refuse(`Line ${n} of the key archive is not one of the records kept beside the keys.`);
      }
      if (content.beside.has(v.string)) refuse(`Line ${n} of the key archive repeats ${v.string}.`);
      content.beside.set(v.string, v.value);
    } else {
      refuse(`Line ${n} of the key archive is not a key, a tombstone or a record kept beside them.`);
    }
  }
  if (footer.lines !== lines.length - 2) refuse(`The key archive's footer says ${JSON.stringify(footer.lines)} lines but it holds ${lines.length - 2}.`);
  if (footer.sha256 !== hash.digest('hex')) refuse('Checksum mismatch: the key archive was damaged or edited.');
  const expected = contentLines(content);
  if (expected.some((line, i) => line !== lines[i + 1])) refuse('The key archive is not in the order Nya writes one: it was edited.');
  return { header: header as KeyArchiveHeader, ...content };
}

// The live key store, exactly as stored

/** The raw client's part a key archive reads the store with: values exactly
 *  as stored, never parsed. */
export type KeyStoreClient = {
  hscan(key: string, cursor: string | number, opts: { count: number }): Promise<[string | number, unknown[]]>;
  get(key: string): Promise<unknown>;
};

async function scanRaw(client: KeyStoreClient, key: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | number = 0;
  do {
    const [next, flat] = await client.hscan(key, cursor, { count: 200 });
    for (let i = 0; i + 1 < flat.length; i += 2) {
      if (typeof flat[i + 1] !== 'string') throw new Error(`Read a value of ${key} that is not text; is the client deserializing?`);
      out.set(String(flat[i]), flat[i + 1] as string);
    }
    cursor = next;
  } while (String(cursor) !== '0');
  return out;
}

/** The key store as it stands: every key's record and every tombstone, a
 *  page at a time, and the records beside them. Fields that are not key ids
 *  are left out (the release before would refuse them). */
export async function readLiveKeyStore(client: KeyStoreClient): Promise<KeyArchiveContent> {
  const content: KeyArchiveContent = { keys: new Map(), tombstones: new Map(), beside: new Map() };
  for (const [id, record] of await scanRaw(client, keysHashKey())) if (isKeyId(id) && id !== 'k0') content.keys.set(id, { record });
  for (const [id, raw] of await scanRaw(client, tombstonesKey())) {
    let t: unknown;
    try {
      t = JSON.parse(raw);
    } catch {
      t = null;
    }
    if (!isKeyId(id) || !isPlain(t) || typeof t.container !== 'string' || !CONTAINER_ID.test(t.container) || typeof t.on !== 'string' || !DAY.test(t.on)) {
      throw new KeyArchiveRefused(`The tombstone of ${id} can't be read, so no key archive was written.`);
    }
    content.tombstones.set(id, { container: t.container, on: t.on });
  }
  for (const name of BESIDE_KEYS) {
    const v = await client.get(besideKey(name));
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') throw new Error(`Read ${name} as something that is not text; is the client deserializing?`);
    content.beside.set(name, v);
  }
  return content;
}

// Building and checking a generation

/**
 * Tonight's generation: every key of the live store; every key of the
 * generation before that is neither in the live store nor tombstoned, carried
 * forward with when it was first missed, until it has been missing longer
 * than `maxDays` and no value tonight names it; every tombstone of either.
 * Answers the content and the ids carried, and those let go.
 */
export function nextGeneration(
  live: KeyArchiveContent,
  previous: KeyArchiveContent | null,
  opts: { now: Date; maxDays: number; named: Set<string> }
): { content: KeyArchiveContent; carried: string[]; let_go: string[] } {
  const tombstones = new Map(previous?.tombstones ?? []);
  for (const [id, t] of live.tombstones) tombstones.set(id, t);
  const keys = new Map<string, KeyEntry>();
  for (const [id, e] of live.keys) if (!tombstones.has(id)) keys.set(id, { record: e.record });
  const carried: string[] = [];
  const letGo: string[] = [];
  for (const [id, e] of previous?.keys ?? []) {
    if (keys.has(id) || tombstones.has(id)) continue;
    const since = e.missing_since ?? opts.now.toISOString();
    if (opts.now.getTime() - Date.parse(since) > opts.maxDays * DAY_MS && !opts.named.has(id)) {
      letGo.push(id);
      continue;
    }
    keys.set(id, { record: e.record, missing_since: since });
    carried.push(id);
  }
  return { content: { keys, tombstones, beside: new Map(live.beside) }, carried: carried.sort(byCodePoint), let_go: letGo.sort(byCodePoint) };
}

/**
 * The checks a generation passes before anything older is deleted (the
 * header). `named`: every key id a value in the same night's data archive
 * names. Throws KeyArchiveRefused naming the first that fails.
 */
export async function checkGeneration(
  written: VerifiedKeyArchive,
  opts: { named: Set<string>; previous: KeyArchiveContent | null; live: KeyArchiveContent; letGo: string[] }
): Promise<void> {
  // The master only when there is a key from the live store to open with it:
  // a deployment without one keeps an archive of tombstones alone.
  const fromStore = [...written.keys.values()].some((e) => e.missing_since === undefined);
  let master: Awaited<ReturnType<typeof currentMaster>> | null = null;
  if (fromStore) {
    try {
      master = await currentMaster();
    } catch (err) {
      refuse(`The key archive can't be checked: ${err instanceof Error ? err.message : err}`);
    }
  }
  let rotation: { next?: unknown } | null = null;
  const rawRotation = written.beside.get('crypto:rotation');
  if (rawRotation !== undefined) {
    try {
      rotation = JSON.parse(rawRotation);
    } catch {
      refuse('The rotation record in the key archive is unreadable.');
    }
  }
  for (const [id, e] of written.keys) {
    if (e.missing_since !== undefined) {
      // Carried forward: checked when it was last in the store.
      continue;
    }
    let stored;
    try {
      stored = parseStoredDataKey(id, e.record);
      await unwrapDataKey(master!, id, stored);
    } catch (err) {
      refuse(`${id} in the key archive doesn't open with this master (${err instanceof Error ? err.message : err}).`);
    }
    if (rotation && typeof rotation.next === 'string' && (stored.next !== rotation.next || !stored.wrapped[rotation.next])) {
      refuse(`${id} in the key archive is missing the lock of the master being rotated to.`);
    }
  }
  for (const id of opts.named) {
    if (id === 'k0') continue;
    if (!written.keys.has(id) && !written.tombstones.has(id)) refuse(`A value in tonight's data archive is under ${id}, which the key archive neither holds nor marks destroyed.`);
  }
  const letGo = new Set(opts.letGo);
  for (const id of opts.previous?.keys.keys() ?? []) {
    if (written.keys.has(id) || written.tombstones.has(id)) continue;
    // Let go only after its time, and never while a value names it.
    if (!letGo.has(id) || opts.named.has(id)) refuse(`${id}, in the generation before, is missing from the new key archive.`);
  }
  for (const id of opts.live.keys.keys()) {
    if (!written.keys.has(id) && !written.tombstones.has(id)) refuse(`${id}, in the key store, is missing from the new key archive.`);
  }
}

/**
 * A rewrite of a generation without the keys tombstoned since: the destroyed
 * keys' lines dropped, their tombstones added, nothing else changed. Null when
 * it holds none of them (nothing to rewrite).
 */
export function rewriteGeneration(old: VerifiedKeyArchive, tombstones: Map<string, Tombstone>, writtenAt: Date): string | null {
  const drop = [...old.keys.keys()].filter((id) => tombstones.has(id));
  if (drop.length === 0) return null;
  const keys = new Map(old.keys);
  const stones = new Map(old.tombstones);
  for (const id of drop) {
    keys.delete(id);
    if (!stones.has(id)) stones.set(id, tombstones.get(id)!);
  }
  return serializeKeyArchive({ ...old.header, written_at: writtenAt.toISOString() }, { keys, tombstones: stones, beside: old.beside });
}

/** Checks a rewrite line by line: exactly the old file's lines but the
 *  dropped keys', with their tombstones, the header's write time the only
 *  other change. */
export function checkRewrite(old: VerifiedKeyArchive, text: string, tombstones: Map<string, Tombstone>): VerifiedKeyArchive {
  const next = verifyKeyArchive(text);
  const { written_at: _a, ...oldHeader } = old.header;
  const { written_at: _b, ...newHeader } = next.header;
  if (JSON.stringify(oldHeader) !== JSON.stringify(newHeader)) refuse('A rewritten key archive changed its header.');
  for (const [id, e] of old.keys) {
    if (tombstones.has(id)) {
      if (next.keys.has(id)) refuse(`A rewritten key archive still holds ${id}, which was destroyed.`);
      if (!next.tombstones.has(id)) refuse(`A rewritten key archive dropped ${id} without its tombstone.`);
    } else {
      const kept = next.keys.get(id);
      if (!kept || kept.record !== e.record || kept.missing_since !== e.missing_since) refuse(`A rewritten key archive changed ${id}.`);
    }
  }
  for (const id of next.keys.keys()) if (!old.keys.has(id)) refuse(`A rewritten key archive gained ${id}.`);
  for (const [id, t] of old.tombstones) {
    const kept = next.tombstones.get(id);
    if (!kept || kept.container !== t.container || kept.on !== t.on) refuse(`A rewritten key archive changed the tombstone of ${id}.`);
  }
  for (const id of next.tombstones.keys()) if (!old.tombstones.has(id) && !(old.keys.has(id) && tombstones.has(id))) refuse(`A rewritten key archive gained the tombstone of ${id}.`);
  if (JSON.stringify([...old.beside]) !== JSON.stringify([...next.beside])) refuse('A rewritten key archive changed the records kept beside the keys.');
  return next;
}

// The lock, and the marker a deletion leaves

/** What a deletion that couldn't rewrite the key archives leaves for the
 *  nightly run: since when, and the containers waiting. */
export type KeysPending = { since: string; containers: string[] };

/**
 * One writer at a time (backups:keys-lock: a token, an expiry, released only
 * by its holder), and the marker a deletion leaves when it can't take it or
 * finish (backups:keys-pending). Kept beside the backups' own record
 * (lib/backup.ts keysLock), so this module reads and writes nothing in the
 * database but through the client it is handed.
 */
export type KeysLock = {
  /** The lock's token, trying until `waitMs` has passed; null if it is held. */
  take(waitMs: number): Promise<string | null>;
  /** Frees the lock if it is still `token`'s. Never throws: it expires. */
  release(token: string): Promise<void>;
  readPending(): Promise<KeysPending | null>;
  /** Adds a container to the marker. */
  markPending(container: string, now: Date): Promise<void>;
  /** Clears the marker if it is still exactly what was read. */
  clearPendingIf(seen: KeysPending): Promise<void>;
};

// Listing and rewriting the generations

export type Generation = { taken: string; pathname: string; uploadedAt: Date };

/** The kept generations, newest first: for each, its newest file. Older files
 *  of a generation (a rewrite that stopped before deleting them) come back
 *  as `stale`. */
export async function listGenerations(store: BackupStore, signal?: AbortSignal): Promise<{ generations: Generation[]; stale: string[] }> {
  const files = (await store.list(keyArchiveFolder(), signal)).filter((b) => parseKeyArchiveName(b.pathname));
  const byTaken = new Map<string, { pathname: string; written: string; uploadedAt: Date }[]>();
  for (const f of files) {
    const { taken, written } = parseKeyArchiveName(f.pathname)!;
    byTaken.set(taken, [...(byTaken.get(taken) ?? []), { pathname: f.pathname, written, uploadedAt: f.uploadedAt }]);
  }
  const generations: Generation[] = [];
  const stale: string[] = [];
  for (const [taken, list] of byTaken) {
    list.sort((a, b) => byCodePoint(b.written, a.written));
    generations.push({ taken, pathname: list[0].pathname, uploadedAt: list[0].uploadedAt });
    stale.push(...list.slice(1).map((f) => f.pathname));
  }
  generations.sort((a, b) => byCodePoint(b.taken, a.taken));
  return { generations, stale: stale.sort(byCodePoint) };
}

/**
 * Rewrites every kept generation that still holds a tombstoned key: each
 * rewrite uploaded, read back, checked line by line, and only then the file
 * it replaces deleted. Answers the files written. Under the lock.
 */
export async function rewriteGenerations(store: BackupStore, tombstones: Map<string, Tombstone>, now: Date, signal?: AbortSignal): Promise<string[]> {
  const { generations, stale } = await listGenerations(store, signal);
  const written: string[] = [];
  for (const g of generations) {
    const text = await store.get(g.pathname, signal);
    if (text === null) continue;
    const old = verifyKeyArchive(text);
    // Always after the file it replaces, so the two never share a name.
    const at = new Date(Math.max(now.getTime(), Date.parse(old.header.written_at) + 1));
    const next = rewriteGeneration(old, tombstones, at);
    if (next === null) continue;
    checkRewrite(old, next, tombstones);
    const pathname = keyArchiveName(old.header.taken_at, at);
    if (pathname === g.pathname) refuse('A key archive would be rewritten under its own name.');
    await store.put(pathname, next, signal, { cacheMaxAgeSeconds: KEY_ARCHIVE_CACHE_SECONDS });
    if ((await store.get(pathname, signal)) !== next) {
      await store.del([pathname], signal).catch(() => {});
      throw new Error(`The rewritten key archive ${pathname} did not read back as written.`);
    }
    await store.del([g.pathname], signal);
    written.push(pathname);
  }
  // Older files of a generation are the rewrite's leftovers: never newer
  // than the file that replaced them, so never needed.
  if (stale.length > 0) await store.del(stale, signal);
  return written;
}

/** Re-reads the tombstones as stored, exactly (the raw client). */
async function liveTombstones(client: KeyStoreClient): Promise<Map<string, Tombstone>> {
  return (await readLiveKeyStore(client)).tombstones;
}

/**
 * A deletion's last step: every kept key archive rewritten without the keys
 * just destroyed, under the lock, within `limitMs`. Answers when it was done,
 * or leaves the marker for the next nightly run and answers that instead.
 * Never throws: the deletion has already destroyed the key.
 */
export async function rewriteAfterDeletion(
  store: BackupStore | null,
  client: KeyStoreClient,
  lock: KeysLock,
  container: string,
  opts: { now?: Date; limitMs?: number; lockWaitMs?: number } = {}
): Promise<{ rewritten_at: string } | { pending: true } | { none: true }> {
  const now = opts.now ?? new Date();
  if (!store) return { none: true };
  const limitMs = opts.limitMs ?? 20_000;
  let token: string | null = null;
  try {
    token = await lock.take(opts.lockWaitMs ?? 5_000);
    if (!token) throw new Error('another key archive writer holds the lock');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`took longer than ${limitMs / 1000}s`));
      }, limitMs);
    });
    try {
      await Promise.race([rewriteGenerations(store, await liveTombstones(client), now, controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return { rewritten_at: new Date().toISOString() };
  } catch (err) {
    console.error('Key archives: not rewritten at the deletion, so the next nightly backup does it.', err instanceof Error ? err.message : typeof err);
    try {
      await lock.markPending(container, now);
    } catch (e) {
      console.error('Key archives: the marker for the nightly backup could not be written; it rewrites them anyway.', e instanceof Error ? e.name : typeof e);
    }
    return { pending: true };
  } finally {
    if (token) await lock.release(token);
  }
}

export type KeyArchiveResult = {
  pathname: string;
  keys: number;
  carried: string[];
  let_go: string[];
  rewritten: string[];
  pruned: string[];
};

/**
 * The nightly key archive, after the data archive of `takenAt` (whose values
 * name `named`): built from the live store and the newest generation, written
 * with the shortest cache lifetime, read back and checked; then the tombstones
 * read again and every generation still holding a tombstoned key rewritten;
 * then the generations beyond KEY_GENERATIONS deleted, and the deletions'
 * marker cleared. Under the lock: a run that can't take it fails.
 */
export async function writeKeyArchive(
  client: KeyStoreClient,
  store: BackupStore,
  lock: KeysLock,
  opts: { takenAt: Date; named: Set<string>; maxDays: number; signal?: AbortSignal; lockWaitMs?: number }
): Promise<KeyArchiveResult> {
  const token = await lock.take(opts.lockWaitMs ?? 30_000);
  if (!token) throw new Error('The key archive was not written: another writer held the lock.');
  try {
    const pendingBefore = await lock.readPending();
    const live = await readLiveKeyStore(client);
    const { generations } = await listGenerations(store, opts.signal);
    let previous: VerifiedKeyArchive | null = null;
    if (generations.length > 0) {
      const text = await store.get(generations[0].pathname, opts.signal);
      if (text === null) throw new Error(`The newest key archive, ${generations[0].pathname}, can't be read.`);
      previous = verifyKeyArchive(text);
    }
    const { content, carried, let_go } = nextGeneration(live, previous, { now: opts.takenAt, maxDays: opts.maxDays, named: opts.named });
    const header: KeyArchiveHeader = {
      nya_keys: KEY_ARCHIVE_FORMAT,
      env_prefix: envPrefix().replace(/:$/, ''),
      taken_at: opts.takenAt.toISOString(),
      written_at: new Date().toISOString(),
      master: await fingerprintOrNull(),
    };
    const body = serializeKeyArchive(header, content);
    const pathname = keyArchiveName(header.taken_at, header.written_at);
    await store.put(pathname, body, opts.signal, { cacheMaxAgeSeconds: KEY_ARCHIVE_CACHE_SECONDS });
    const back = await store.get(pathname, opts.signal);
    if (back !== body) {
      await store.del([pathname], opts.signal).catch(() => {});
      throw new Error(`The key archive ${pathname} did not read back as written.`);
    }
    await checkGeneration(verifyKeyArchive(back), { named: opts.named, previous, live, letGo: let_go });
    if (carried.length > 0) console.error(`Key archive: ${carried.length} key(s) missing from the key store carried forward: ${carried.join(', ')}`);

    // A deletion may have destroyed a key while this ran: the tombstones read
    // again, and every generation (this one too) rewritten without it.
    const rewritten = await rewriteGenerations(store, await liveTombstones(client), new Date(), opts.signal);

    const { generations: kept } = await listGenerations(store, opts.signal);
    const pruned = kept.slice(KEY_GENERATIONS).map((g) => g.pathname);
    if (pruned.length > 0) await store.del(pruned, opts.signal);
    // Cleared only if no deletion added to it meanwhile: one that did is
    // rewritten by this run all the same, but its marker stays for the next.
    if (pendingBefore) await lock.clearPendingIf(pendingBefore);
    return { pathname: rewritten.find((p) => parseKeyArchiveName(p)?.taken === parseKeyArchiveName(pathname)?.taken) ?? pathname, keys: content.keys.size, carried, let_go, rewritten, pruned };
  } finally {
    await lock.release(token);
  }
}

/** This deployment's master's fingerprint, or null without a usable one. */
async function fingerprintOrNull(): Promise<string | null> {
  if (!masterKeyConfigured()) return null;
  try {
    return (await currentMaster()).fingerprint;
  } catch {
    return null;
  }
}

/** A key archive taken by hand (POST /api/ops/export with {"keys": true}):
 *  the live store as it stands, with every tombstone. Not stored anywhere. */
export async function keyArchiveNow(client: KeyStoreClient, now: Date = new Date()): Promise<string> {
  const live = await readLiveKeyStore(client);
  const header: KeyArchiveHeader = { nya_keys: KEY_ARCHIVE_FORMAT, env_prefix: envPrefix().replace(/:$/, ''), taken_at: now.toISOString(), written_at: now.toISOString(), master: await fingerprintOrNull() };
  return serializeKeyArchive(header, live);
}
