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
// each night after the data archive, built from the newest before it, which
// must read back intact: a run that can't read it fails, naming it, rather
// than build on less. The oldest beyond seven is deleted only once the new one
// is checked, and never on a night that fails.
//
// NO KEY IS EVER DROPPED WITHOUT A TOMBSTONE. A generation holds every key of
// the live store and every key of the generation before it that hasn't been
// tombstoned. A key that has left the live store without a tombstone (removed
// by hand, a bug, a restore of an older point) is carried forward with when it
// was first missed (`missing_since`) and when a data archive last named it
// (`named_last`), until the oldest data archive still kept was taken after
// both, and never sooner than a kept copy's lifetime after the later. A night
// that wrote its data archive but no generation (its key archive failed)
// counts as naming every key carried, since nothing recorded what its values
// named.
//
// CHECKED before anything older is deleted: it reads back byte for byte; it
// is exactly what the live store and the generation before make it (every key
// and tombstone of the store, every key and tombstone of the generation
// before but the keys tombstoned since or let go by the rule above, each
// carried line's times, and nothing else), or it is deleted, as a file that
// doesn't read back is, so no night builds on it; and every key from the live
// store unwraps with the current master and is the key its id names (and,
// while a rotation is prepared, carries the next master's lock), and it holds
// every key id a value in the same night's data archive names, or a tombstone
// for it. A file that fails only these last checks is kept, since it is the
// store as it stands, and the run fails.
//
// REWRITTEN AT EVERY DELETION. A rewrite is a pure filter of the file before
// it: the destroyed keys' lines dropped and every tombstone it lacks added,
// checked line by line as exactly that before the file it replaces is
// deleted. Each file's name ends with a digest of the tombstones it holds, so
// a run tells from the listing alone which files lack one, and reads only
// those; the nightly run rewrites any still lacking one. A generation that
// doesn't read back intact, twice, is deleted when a newer one is intact: that
// one was built from it, so it holds what it held. The newest has none, so
// the rewrite fails, naming it.
//
// ONE WRITER AT A TIME: reading the store, writing, checking and deleting
// older files happen under backups:keys-lock (a token and an expiry, released
// only by its holder). A deletion that can't take it, or finish, in its time
// leaves backups:keys-pending, which the next nightly run honours and clears.
//
// Format (one JSON object per line, each ending in "\n"):
//   {"nya_keys":1,"env_prefix":"production","taken_at":"<iso>","written_at":"<iso>","master":"<fingerprint>"}
//   {"key":"k12-0123abcd","record":"<the key's record, as stored>"}
//   {"key":"k3-89abcdef","record":"...","missing_since":"<iso>","named_last":"<iso>"}   carried forward
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

/** A generation that isn't what the live store and the generation before make
 *  it: a fault in building it, never the store's. It is deleted, so no night
 *  builds on it. */
export class KeyArchiveIncomplete extends KeyArchiveRefused {
  constructor(message: string) {
    super(message);
    this.name = 'KeyArchiveIncomplete';
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

/** A key's line. One carried forward has `missing_since`, when it was first
 *  missed from the live store, and `named_last` once a data archive has named
 *  it since, or may have: when the newest such was taken. */
export type KeyEntry = { record: string; missing_since?: string; named_last?: string };

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

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const stamp = (d: Date | string) => new Date(d).toISOString().replace(/[:.]/g, '-');

/** The digest of a set of tombstoned key ids that ends a file's name: 16 hex
 *  characters of the SHA-256 of the ids in code point order, one per line. */
export function tombstoneDigest(ids: Iterable<string>): string {
  return createHash('sha256').update([...ids].sort(byCodePoint).join('\n')).digest('hex').slice(0, 16);
}

/** A generation's file: named by when it was taken, then when it was written,
 *  so a rewrite sorts beside the file it replaces, then by the tombstones it
 *  holds, so a run tells from the listing which files lack one. */
export function keyArchiveName(takenAt: Date | string, writtenAt: Date | string, tombstones: Iterable<string>): string {
  return `${keyArchiveFolder()}nya-keys-${stamp(takenAt)}--${stamp(writtenAt)}--${tombstoneDigest(tombstones)}.ndjson`;
}

const NAME = /nya-keys-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)--(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)--([0-9a-f]{16})\.ndjson$/;

/** When a key archive's generation was taken, and its file written, and the
 *  digest of its tombstones, from its name, or null for a name that is not
 *  one. */
export function parseKeyArchiveName(pathname: string): { taken: string; written: string; tombstones: string } | null {
  const m = NAME.exec(pathname);
  return m ? { taken: m[1], written: m[2], tombstones: m[3] } : null;
}

function refuse(message: string): never {
  throw new KeyArchiveRefused(message);
}

/** The lines of a key archive holding `content`, in the one order a file has. */
function contentLines(content: KeyArchiveContent): string[] {
  const lines: string[] = [];
  for (const id of [...content.keys.keys()].sort(byCodePoint)) {
    const e = content.keys.get(id)!;
    lines.push(
      JSON.stringify({
        key: id,
        record: e.record,
        ...(e.missing_since !== undefined ? { missing_since: e.missing_since } : {}),
        ...(e.named_last !== undefined ? { named_last: e.named_last } : {}),
      })
    );
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
/** A time as toISOString writes it, the only way a key line's times are. */
const isTime = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && !Number.isNaN(Date.parse(v));
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
  const taken = Date.parse(header.taken_at as string);
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
      const extra = Object.keys(v).filter((k) => k !== 'key' && k !== 'record' && k !== 'missing_since' && k !== 'named_last');
      if (typeof v.key !== 'string' || !isKeyId(v.key) || v.key === 'k0' || typeof v.record !== 'string' || extra.length > 0) refuse(`Line ${n} of the key archive is not a key.`);
      if ('missing_since' in v && !isTime(v.missing_since)) refuse(`Line ${n} of the key archive has an invalid missing_since.`);
      // Only on a key carried forward, and never before it was first missed.
      if ('named_last' in v && (!isTime(v.named_last) || !isTime(v.missing_since) || Date.parse(v.named_last) < Date.parse(v.missing_since))) {
        refuse(`Line ${n} of the key archive has an invalid named_last.`);
      }
      for (const t of [v.missing_since, v.named_last]) if (typeof t === 'string' && Date.parse(t) > taken) refuse(`Line ${n} of the key archive is dated after its generation was taken.`);
      if (content.keys.has(v.key)) refuse(`Line ${n} of the key archive repeats ${v.key}.`);
      content.keys.set(v.key, {
        record: v.record,
        ...(typeof v.missing_since === 'string' ? { missing_since: v.missing_since } : {}),
        ...(typeof v.named_last === 'string' ? { named_last: v.named_last } : {}),
      });
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

/** The tombstones as stored (crypto:destroyed alone, a page at a time), each
 *  checked: one that can't be read stops the run, since a key archive written
 *  without it could hold a destroyed key. */
async function storedTombstones(client: KeyStoreClient): Promise<Map<string, Tombstone>> {
  const out = new Map<string, Tombstone>();
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
    out.set(id, { container: t.container, on: t.on });
  }
  return out;
}

/** The key store as it stands: every key's record and every tombstone, a
 *  page at a time, and the records beside them. Fields that are not key ids
 *  are left out (the release before would refuse them). */
export async function readLiveKeyStore(client: KeyStoreClient): Promise<KeyArchiveContent> {
  const content: KeyArchiveContent = { keys: new Map(), tombstones: await storedTombstones(client), beside: new Map() };
  for (const [id, record] of await scanRaw(client, keysHashKey())) if (isKeyId(id) && id !== 'k0') content.keys.set(id, { record });
  for (const name of BESIDE_KEYS) {
    const v = await client.get(besideKey(name));
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') throw new Error(`Read ${name} as something that is not text; is the client deserializing?`);
    content.beside.set(name, v);
  }
  return content;
}

// Building and checking a generation

/** The newest of these times, or undefined for none. */
function latest(...times: (string | undefined)[]): string | undefined {
  let out: string | undefined;
  for (const t of times) if (t !== undefined && (out === undefined || Date.parse(t) > Date.parse(out))) out = t;
  return out;
}

/** The last time a data archive can have named a key carried forward. */
const lastNeeded = (e: KeyEntry): number => Date.parse(latest(e.missing_since, e.named_last)!);

/**
 * What a night knows of the data archives, from when each still kept was
 * taken (`kept`, the night's own included): the oldest, and the newest taken
 * since the generation before (`previousTaken`) and before tonight, which no
 * generation recorded (its key archive failed).
 */
function archiveFacts(kept: string[], now: string, previousTaken: string | null): { oldest: string; unrecorded: string | undefined } {
  let oldest = now;
  for (const t of kept) if (Date.parse(t) < Date.parse(oldest)) oldest = t;
  const since = previousTaken === null ? null : Date.parse(previousTaken);
  const unrecorded = since === null ? undefined : latest(...kept.filter((t) => Date.parse(t) > since && Date.parse(t) < Date.parse(now)));
  return { oldest, unrecorded };
}

/**
 * Tonight's generation: every key of the live store; every key of the
 * generation before that is neither in the live store nor tombstoned, carried
 * forward with when it was first missed and when a data archive last named it,
 * or may have; every tombstone of either. A carried key is let go once the
 * oldest data archive still kept (`kept`: when each was taken, tonight's
 * included) was taken after both, and `maxDays` have passed since the later:
 * no copy kept can need it then. Answers the content and the ids carried, and
 * those let go.
 */
export function nextGeneration(
  live: KeyArchiveContent,
  previous: VerifiedKeyArchive | null,
  opts: { now: Date; maxDays: number; named: Set<string>; kept: string[] }
): { content: KeyArchiveContent; carried: string[]; let_go: string[] } {
  const now = opts.now.toISOString();
  const { oldest, unrecorded } = archiveFacts(opts.kept, now, previous?.header.taken_at ?? null);
  const tombstones = new Map(previous?.tombstones ?? []);
  for (const [id, t] of live.tombstones) tombstones.set(id, t);
  const keys = new Map<string, KeyEntry>();
  for (const [id, e] of live.keys) if (!tombstones.has(id)) keys.set(id, { record: e.record });
  const carried: string[] = [];
  const letGo: string[] = [];
  for (const [id, e] of previous?.keys ?? []) {
    if (keys.has(id) || tombstones.has(id)) continue;
    const named = opts.named.has(id) ? now : undefined;
    // First missed tonight: every data archive taken before is older than
    // that, so nothing more to note. Carried already: named tonight, or by a
    // night no generation recorded, since the generation before.
    const namedLast = e.missing_since === undefined ? named : latest(e.named_last, unrecorded, named);
    const line: KeyEntry = { record: e.record, missing_since: e.missing_since ?? now, ...(namedLast !== undefined ? { named_last: namedLast } : {}) };
    const needed = lastNeeded(line);
    if (Date.parse(oldest) > needed && opts.now.getTime() - needed > opts.maxDays * DAY_MS) {
      letGo.push(id);
      continue;
    }
    keys.set(id, line);
    carried.push(id);
  }
  return { content: { keys, tombstones, beside: new Map(live.beside) }, carried: carried.sort(byCodePoint), let_go: letGo.sort(byCodePoint) };
}

type CheckOpts = {
  /** Every key id a value in the same night's data archive names. */
  named: Set<string>;
  previous: VerifiedKeyArchive | null;
  live: KeyArchiveContent;
  letGo: string[];
  /** When each data archive still kept was taken, the night's own included. */
  kept: string[];
  maxDays: number;
};

/**
 * That a generation is exactly what the live store and the generation before
 * make it (nextGeneration), or KeyArchiveIncomplete naming the first thing
 * that isn't: every key and tombstone of the store, every key and tombstone
 * of the generation before but the keys tombstoned since or let go by the
 * rule, each carried line's times, and nothing else.
 */
function checkComplete(written: VerifiedKeyArchive, opts: CheckOpts): void {
  const incomplete = (message: string): never => {
    throw new KeyArchiveIncomplete(message);
  };
  const now = written.header.taken_at;
  const { oldest, unrecorded } = archiveFacts(opts.kept, now, opts.previous?.header.taken_at ?? null);
  const stones = new Map([...(opts.previous?.tombstones ?? []), ...opts.live.tombstones]);
  for (const [id, t] of stones) {
    const w = written.tombstones.get(id);
    if (!w || w.container !== t.container || w.on !== t.on) incomplete(`The tombstone of ${id} is missing from the new key archive.`);
  }
  for (const id of written.tombstones.keys()) if (!stones.has(id)) incomplete(`The new key archive holds a tombstone of ${id} that neither the key store nor the generation before holds.`);
  for (const [id, e] of opts.live.keys) {
    if (stones.has(id)) continue;
    const w = written.keys.get(id);
    if (!w || w.record !== e.record || w.missing_since !== undefined) incomplete(`${id}, in the key store, is missing from the new key archive.`);
  }
  const letGo = new Set(opts.letGo);
  for (const [id, e] of opts.previous?.keys ?? []) {
    if (stones.has(id) || opts.live.keys.has(id)) continue;
    const w = written.keys.get(id);
    if (w === undefined) {
      // Let go: only a key carried already, named neither tonight nor by a
      // night no generation recorded, once the oldest data archive kept is
      // newer than both its times and its time has passed.
      const needed = e.missing_since === undefined ? NaN : lastNeeded(e);
      if (!letGo.has(id) || opts.named.has(id) || unrecorded !== undefined || !(Date.parse(oldest) > needed) || !(Date.parse(now) - needed > opts.maxDays * DAY_MS)) {
        incomplete(`${id}, in the generation before, is missing from the new key archive.`);
      }
      continue;
    }
    if (w.record !== e.record || w.missing_since !== (e.missing_since ?? now)) incomplete(`${id} is carried forward with a line that isn't the generation before's.`);
    // Named tonight: tonight. First missed tonight, and not named: never.
    // Carried already: the later of what the generation before says and a
    // night no generation recorded.
    const namedLast = opts.named.has(id) ? now : e.missing_since === undefined ? undefined : latest(e.named_last, unrecorded);
    if (w.named_last !== namedLast) incomplete(`${id} is carried forward without when a data archive last named it.`);
  }
  for (const [id, e] of written.keys) {
    const fromStore = e.missing_since === undefined && opts.live.keys.has(id);
    const carried = e.missing_since !== undefined && !opts.live.keys.has(id) && (opts.previous?.keys.has(id) ?? false);
    if (stones.has(id) || !(fromStore || carried)) incomplete(`The new key archive holds ${id}, which neither the key store nor the generation before holds as it does.`);
  }
}

/**
 * The checks a generation passes before anything older is deleted (the
 * header). Throws KeyArchiveIncomplete when it isn't what the live store and
 * the generation before make it, and KeyArchiveRefused naming any other first
 * check that fails.
 */
export async function checkGeneration(written: VerifiedKeyArchive, opts: CheckOpts): Promise<void> {
  checkComplete(written, opts);
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
}

/**
 * A rewrite of a generation for these tombstones: the keys they name dropped,
 * every one it lacks added, nothing else changed. Null when it holds none of
 * those keys and lacks none of them (nothing to rewrite).
 */
export function rewriteGeneration(old: VerifiedKeyArchive, tombstones: Map<string, Tombstone>, writtenAt: Date): string | null {
  const drop = [...old.keys.keys()].filter((id) => tombstones.has(id));
  const add = [...tombstones.keys()].filter((id) => !old.tombstones.has(id));
  if (drop.length === 0 && add.length === 0) return null;
  const keys = new Map(old.keys);
  for (const id of drop) keys.delete(id);
  const stones = new Map(old.tombstones);
  for (const id of add) stones.set(id, tombstones.get(id)!);
  return serializeKeyArchive({ ...old.header, written_at: writtenAt.toISOString() }, { keys, tombstones: stones, beside: old.beside });
}

/** Checks a rewrite line by line: exactly the old file's lines but the
 *  destroyed keys', with every tombstone it lacked, the header's write time
 *  the only other change. */
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
      if (!kept || kept.record !== e.record || kept.missing_since !== e.missing_since || kept.named_last !== e.named_last) refuse(`A rewritten key archive changed ${id}.`);
    }
  }
  for (const id of next.keys.keys()) if (!old.keys.has(id)) refuse(`A rewritten key archive gained ${id}.`);
  for (const [id, t] of old.tombstones) {
    const kept = next.tombstones.get(id);
    if (!kept || kept.container !== t.container || kept.on !== t.on) refuse(`A rewritten key archive changed the tombstone of ${id}.`);
  }
  for (const [id, t] of tombstones) {
    if (old.tombstones.has(id)) continue;
    const added = next.tombstones.get(id);
    if (!added || added.container !== t.container || added.on !== t.on) refuse(`A rewritten key archive lacks the tombstone of ${id}.`);
  }
  for (const id of next.tombstones.keys()) if (!old.tombstones.has(id) && !tombstones.has(id)) refuse(`A rewritten key archive gained the tombstone of ${id}.`);
  if (JSON.stringify([...old.beside]) !== JSON.stringify([...next.beside])) refuse('A rewritten key archive changed the records kept beside the keys.');
  return next;
}

// The lock, and the marker a deletion leaves

/** What a deletion that couldn't rewrite the key archives leaves for the
 *  nightly run: since when, and the containers waiting. `unreadable`: the
 *  marker stored couldn't be read, which still says a rewrite is owed. */
export type KeysPending = { since: string; containers: string[]; unreadable?: true };

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
  /** Clears the marker if it is still exactly what was read (an unreadable
   *  one, if it still can't be read). */
  clearPendingIf(seen: KeysPending): Promise<void>;
};

// Listing and rewriting the generations

export type Generation = { taken: string; pathname: string; uploadedAt: Date; tombstones: string };

/** The kept generations, newest first: for each, its newest file. Older files
 *  of a generation (a rewrite that stopped before deleting them) come back
 *  as `stale`. */
export async function listGenerations(store: BackupStore, signal?: AbortSignal): Promise<{ generations: Generation[]; stale: string[] }> {
  const files = (await store.list(keyArchiveFolder(), signal)).filter((b) => parseKeyArchiveName(b.pathname));
  const byTaken = new Map<string, { pathname: string; written: string; uploadedAt: Date; tombstones: string }[]>();
  for (const f of files) {
    const { taken, written, tombstones } = parseKeyArchiveName(f.pathname)!;
    byTaken.set(taken, [...(byTaken.get(taken) ?? []), { pathname: f.pathname, written, uploadedAt: f.uploadedAt, tombstones }]);
  }
  const generations: Generation[] = [];
  const stale: string[] = [];
  for (const [taken, list] of byTaken) {
    list.sort((a, b) => byCodePoint(b.written, a.written));
    generations.push({ taken, pathname: list[0].pathname, uploadedAt: list[0].uploadedAt, tombstones: list[0].tombstones });
    stale.push(...list.slice(1).map((f) => f.pathname));
  }
  generations.sort((a, b) => byCodePoint(b.taken, a.taken));
  return { generations, stale: stale.sort(byCodePoint) };
}

/**
 * A generation's file, checked against its own name too: read once more if it
 * doesn't verify (a read cut short), then given up on as damaged. `gone` when
 * the store no longer has it.
 */
async function readGeneration(store: BackupStore, g: Generation, signal?: AbortSignal): Promise<{ archive: VerifiedKeyArchive } | { gone: true } | { damaged: string }> {
  let reason = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await store.get(g.pathname, signal);
    if (text === null) return { gone: true };
    let archive: VerifiedKeyArchive;
    try {
      archive = verifyKeyArchive(text);
    } catch (err) {
      if (!(err instanceof KeyArchiveRefused)) throw err;
      reason = err.message;
      continue;
    }
    if (stamp(archive.header.taken_at) !== g.taken || tombstoneDigest(archive.tombstones.keys()) !== g.tombstones) return { damaged: "its name doesn't match what it holds" };
    return { archive };
  }
  return { damaged: reason };
}

/**
 * Rewrites every kept generation that lacks one of these tombstones, read
 * only where its name says so: each rewrite uploaded, read back, checked line
 * by line, and only then the file it replaces deleted. A generation that
 * doesn't read back intact is deleted if a newer one reads back intact (one
 * passed over by its name is read then, never trusted on its name alone),
 * and kept otherwise: it alone may hold a key. The generations older than a
 * kept one are rewritten all the same, so a key just destroyed leaves every
 * file that can be rewritten, and then it throws, naming the newest kept,
 * once the older files of each generation known intact (or deleted for a
 * newer one intact) are gone: those of any other may be the only ones of it
 * that read, and stay. Answers the files written, and the damaged ones
 * deleted. Under the lock.
 */
export async function rewriteGenerations(
  store: BackupStore,
  tombstones: Map<string, Tombstone>,
  now: Date,
  signal?: AbortSignal
): Promise<{ written: string[]; dropped: string[] }> {
  const { generations, stale } = await listGenerations(store, signal);
  const want = tombstoneDigest(tombstones.keys());
  const written: string[] = [];
  const dropped: string[] = [];
  // Whether a newer generation than the one at hand read back intact in this
  // run: every one was built from the newest before it while that read back
  // intact, so a newer one holds what an older held (but what was destroyed
  // since).
  let newerIntact = false;
  // Newer ones passed over because their name already holds every
  // tombstone: checked when they were written, and read only when an older
  // one's fate rests on them.
  const passed: Generation[] = [];
  // The generations (by `taken`) whose older files nothing needs: their
  // newest file read back intact in this run, or they were deleted for a
  // newer one that did.
  const superseded = new Set<string>();
  const someNewerIntact = async (): Promise<boolean> => {
    while (!newerIntact && passed.length > 0) {
      const g = passed.shift()!;
      const read = await readGeneration(store, g, signal);
      if ('archive' in read) {
        newerIntact = true;
        superseded.add(g.taken);
      }
    }
    return newerIntact;
  };
  // The newest one kept for want of a newer one intact, said once the rest
  // are rewritten.
  let failed: Error | null = null;
  for (const g of generations) {
    if (g.tombstones === want) {
      passed.push(g);
      continue;
    }
    const read = await readGeneration(store, g, signal);
    if ('gone' in read) continue;
    if ('damaged' in read) {
      if (!(await someNewerIntact())) {
        console.error(`Key archive: ${g.pathname} doesn't read back intact (${read.damaged}), and no newer one holds what it held, so it is kept as it is; the older ones are rewritten all the same.`);
        failed ??= new Error(`The key archive ${g.pathname} doesn't read back intact (${read.damaged}), and no newer one holds what it held, so it can't be rewritten.`);
        continue;
      }
      console.error(`Key archive: ${g.pathname} doesn't read back intact (${read.damaged}). A newer generation holds what it held, so it is deleted.`);
      await store.del([g.pathname], signal);
      dropped.push(g.pathname);
      superseded.add(g.taken);
      continue;
    }
    newerIntact = true;
    const old = read.archive;
    // Always after the file it replaces, so the two never share a name.
    const at = new Date(Math.max(now.getTime(), Date.parse(old.header.written_at) + 1));
    const next = rewriteGeneration(old, tombstones, at);
    if (next === null) {
      superseded.add(g.taken);
      continue;
    }
    const checked = checkRewrite(old, next, tombstones);
    const pathname = keyArchiveName(old.header.taken_at, at, checked.tombstones.keys());
    if (pathname === g.pathname) refuse('A key archive would be rewritten under its own name.');
    await store.put(pathname, next, signal, { cacheMaxAgeSeconds: KEY_ARCHIVE_CACHE_SECONDS });
    if ((await store.get(pathname, signal)) !== next) {
      await store.del([pathname], signal).catch(() => {});
      throw new Error(`The rewritten key archive ${pathname} did not read back as written.`);
    }
    await store.del([g.pathname], signal);
    written.push(pathname);
    superseded.add(g.taken);
  }
  // Older files of a generation are the rewrite's leftovers: never newer
  // than the file that replaced them, so never needed. When the run failed,
  // only those of a generation known intact (or deleted for a newer one)
  // go, since they may still hold the key just destroyed: an older file of
  // any other may be the only one of it that reads.
  const leftovers = failed ? stale.filter((p) => superseded.has(parseKeyArchiveName(p)!.taken)) : stale;
  if (leftovers.length > 0) await store.del(leftovers, signal);
  if (failed) throw failed;
  return { written, dropped };
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
      await Promise.race([(async () => rewriteGenerations(store, await storedTombstones(client), now, controller.signal))(), timeout]);
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
  /** Older generations that didn't read back intact, deleted. */
  dropped: string[];
  pruned: string[];
};

/**
 * The nightly key archive, after the data archive of `takenAt` (whose values
 * name `named`; `kept`: when each data archive still kept was taken, that one
 * included): built from the live store and the newest generation, written
 * with the shortest cache lifetime, read back and checked; then the
 * tombstones read again and every generation lacking one rewritten; then the
 * generations beyond KEY_GENERATIONS deleted, and the deletions' marker
 * cleared. Under the lock: a run that can't take it fails.
 */
export async function writeKeyArchive(
  client: KeyStoreClient,
  store: BackupStore,
  lock: KeysLock,
  opts: { takenAt: Date; named: Set<string>; kept: string[]; maxDays: number; signal?: AbortSignal; lockWaitMs?: number }
): Promise<KeyArchiveResult> {
  const token = await lock.take(opts.lockWaitMs ?? 30_000);
  if (!token) throw new Error('The key archive was not written: another writer held the lock.');
  try {
    const pendingBefore = await lock.readPending();
    const live = await readLiveKeyStore(client);
    const { generations } = await listGenerations(store, opts.signal);
    let previous: VerifiedKeyArchive | null = null;
    if (generations.length > 0) {
      const read = await readGeneration(store, generations[0], opts.signal);
      if (!('archive' in read)) {
        throw new Error(
          `The newest key archive, ${generations[0].pathname}, ${'gone' in read ? "is listed but can't be read" : `doesn't read back intact (${read.damaged})`}, so no key archive was written: tonight's would be built on less (docs/operations.md, "A key archive that doesn't read back").`
        );
      }
      previous = read.archive;
    }
    const check = { named: opts.named, previous, live, kept: opts.kept, maxDays: opts.maxDays };
    const { content, carried, let_go } = nextGeneration(live, previous, { now: opts.takenAt, maxDays: opts.maxDays, named: opts.named, kept: opts.kept });
    const header: KeyArchiveHeader = {
      nya_keys: KEY_ARCHIVE_FORMAT,
      env_prefix: envPrefix().replace(/:$/, ''),
      taken_at: opts.takenAt.toISOString(),
      written_at: new Date().toISOString(),
      master: await fingerprintOrNull(),
    };
    const body = serializeKeyArchive(header, content);
    const pathname = keyArchiveName(header.taken_at, header.written_at, content.tombstones.keys());
    await store.put(pathname, body, opts.signal, { cacheMaxAgeSeconds: KEY_ARCHIVE_CACHE_SECONDS });
    const back = await store.get(pathname, opts.signal);
    if (back !== body) {
      await store.del([pathname], opts.signal).catch(() => {});
      throw new Error(`The key archive ${pathname} did not read back as written.`);
    }
    try {
      await checkGeneration(verifyKeyArchive(back), { ...check, letGo: let_go });
    } catch (err) {
      // Not what the store and the generation before make it: deleted, as a
      // file that doesn't read back is, so no night builds on it. One that
      // is, of a store with a problem of its own, is kept: it is the store as
      // it stands.
      if (err instanceof KeyArchiveIncomplete) await store.del([pathname], opts.signal).catch(() => {});
      throw err;
    }
    if (carried.length > 0) console.error(`Key archive: ${carried.length} key(s) missing from the key store carried forward: ${carried.join(', ')}`);

    // A deletion may have destroyed a key while this ran: the tombstones read
    // again, and every generation (this one too) rewritten without it.
    const { written: rewritten, dropped } = await rewriteGenerations(store, await storedTombstones(client), new Date(), opts.signal);

    const { generations: kept } = await listGenerations(store, opts.signal);
    const pruned = kept.slice(KEY_GENERATIONS).map((g) => g.pathname);
    if (pruned.length > 0) await store.del(pruned, opts.signal);
    // Cleared only if no deletion added to it meanwhile: one that did is
    // rewritten by this run all the same, but its marker stays for the next.
    if (pendingBefore) await lock.clearPendingIf(pendingBefore);
    return {
      pathname: rewritten.find((p) => parseKeyArchiveName(p)?.taken === parseKeyArchiveName(pathname)?.taken) ?? pathname,
      keys: content.keys.size,
      carried,
      let_go,
      rewritten,
      dropped,
      pruned,
    };
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
