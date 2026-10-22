// lib/fx/ecb-fetch.ts
//
// The nightly fetch of the ECB's euro reference rates (app/api/fx/fetch, a
// cron of its own at 16:30 UTC, after the ECB publishes at about 16:00 CET),
// into their store (lib/fx/ecb-store.ts). Never run on a person's request:
// readers only read what this wrote. Server only.
//
// ALWAYS THE WHOLE HISTORY. eurofxref-hist.zip (about 640 KB) holds every
// publication since 1999-01-04, so one path serves the nightly run and the
// first fill, and any gap, whatever its length, heals the next night. It is
// read by the shared, bounded zip reader (lib/zip.ts) and the strict CSV
// parser (lib/fx/ecb-parse.ts): a file that isn't what the ECB publishes is
// refused whole and writes nothing.
//
// WHAT IT WRITES (lib/fx/ecb-parse.ts planWrites): one HSET per year, newest
// first, each atomic, the newest publication with its own year's; a past year
// once, the current year and the year before every run; never a year with
// fewer days than stored, never a newest publication older than the stored
// one. `full` compares and rewrites every year.
//
// WHAT IT MENDS. A field that can't be used reads as no rate on its days,
// said by every reader that meets it (lib/fx/read.ts); the next run writes it
// again. A calendar or the newest publication that can't be used is written
// with its year. A past year's series are checked after tonight's writes
// (lib/fx/ecb-parse.ts unlikeStored): one read a year (about 170 KB), from a
// different year each night, until the writes' deadline, and a year with a
// series missing, unusable or unlike the file's is written again whole. What
// was mended is named in the record (`mended`) and the log.
//
// TIME LIMITS. Upstash doesn't time a request out on its own, and Vercel ends
// the function at its maxDuration without running anything after (the reason
// lib/backup.ts gives every step a limit). So every call here is raced against
// what is left of the run (RUN_BUDGET_MS, inside the route's 60 seconds): the
// reads of what is stored, the download (also aborted at its own limit) and
// each year's write, and the writes stop between years at their deadline. A
// call over its time is an ordinary failure that names the step, recorded in
// the store's `fetch` field and answered 500. The record itself has time kept
// for it (RECORD_MS), and is raced too: a record that never lands is logged,
// and the route still answers 500 in time.

import { listZip, readEntry, type ZipEntry, type ZipProblem } from '../zip';
import { ecbStore, readEcbFields } from './ecb-store';
import { FETCH_FIELD, LATEST_FIELD, MAX_MENDED, daysField, isDays, isFetch, isLatest } from './fields';
import { parseEcbCsv, planWrites, unlikeStored, yearStep } from './ecb-parse';
import type { EcbFetch } from './rates';

export const ECB_HISTORY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip';
/** Everything but the record of the outcome: within the route's 60 seconds,
 *  with RECORD_MS kept after it and a margin. */
export const RUN_BUDGET_MS = 48_000;
/** The record of the outcome, raced on its own after the run. */
export const RECORD_MS = 6_000;
/** The reads of what is stored (the field names, the calendars). */
export const READ_TIMEOUT_MS = 10_000;
/** The download's limit: the file is about 640 KB. */
export const DOWNLOAD_TIMEOUT_MS = 20_000;
/** The writes stop between years after this long from the start. */
export const WRITE_DEADLINE_MS = 40_000;
/** Far more than the file's 640 KB zipped and 1.9 MB of CSV. */
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const ZIP_LIMITS = { maxEntries: 4, maxEntryBytes: 32 * 1024 * 1024 };
const ENTRY = 'eurofxref-hist.csv';

export type FetchOutcome =
  | { ok: true; newest: string; written: string[]; refused: string[]; mended: string[] }
  | { ok: false; reason: string; written: string[]; mended: string[] };

/** What a download is: the bytes, or why there are none. */
export type Downloader = (url: string, signal: AbortSignal) => Promise<{ status: number; bytes: Uint8Array }>;

/** Downloads with fetch, refusing a body over the bound as it arrives. */
export const downloadWithFetch: Downloader = async (url, signal) => {
  const res = await fetch(url, { signal, headers: { accept: 'application/zip' } });
  if (!res.ok || !res.body) return { status: res.status, bytes: new Uint8Array() };
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) throw new Error('the file is larger than the ECB’s is');
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DOWNLOAD_BYTES) {
      await reader.cancel();
      throw new Error('the file is larger than the ECB’s is');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { status: res.status, bytes };
};

const zipReason = (p: ZipProblem): string =>
  p.problem === 'too-many' ? `the zip holds ${p.count} files, not the ECB’s one` : `the zip is ${p.problem === 'damaged' ? 'damaged' : `not readable here (${p.problem})`}`;

/** The CSV inside the ECB's zip, or why it can't be had. */
function csvOf(bytes: Uint8Array): string | { reason: string } {
  const entries = listZip(bytes, ZIP_LIMITS);
  if (!Array.isArray(entries)) return { reason: zipReason(entries) };
  const entry = entries.find((e: ZipEntry) => e.name === ENTRY);
  if (!entry || entries.length !== 1) return { reason: `the zip doesn’t hold ${ENTRY} alone` };
  const out = readEntry(bytes, entry, ZIP_LIMITS);
  if (!(out instanceof Uint8Array)) return { reason: zipReason(out) };
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(out);
  } catch {
    return { reason: 'the file isn’t UTF-8 text' };
  }
}

/** A step that ran out of its time: what it was, and how long it had. */
class StepTimeout extends Error {
  constructor(what: string, ms: number) {
    super(ms > 0 ? `${what} took longer than ${ms / 1000}s` : `${what} had no time left in the run`);
    this.name = 'StepTimeout';
  }
}

/** A call raced against `ms`: over it, a StepTimeout naming `what`, whether
 *  or not the call ever settles (one that lands later lands whole: each write
 *  is one atomic HSET). */
async function within<T>(what: string, ms: number, call: () => Promise<T>): Promise<T> {
  if (ms <= 0) throw new StepTimeout(what, 0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(what, ms)), ms);
  });
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Why an error happened, for an operator, without what it carried. */
const reasonOf = (err: unknown, downloadMs: number = DOWNLOAD_TIMEOUT_MS): string => {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return `the download took longer than ${downloadMs / 1000}s`;
  return err instanceof Error ? err.message.slice(0, 200) : 'an unknown error';
};

/**
 * One run of the fetch: download, check, write what changed, and record the
 * outcome in the store's `fetch` field (best effort: a failure to record it
 * is logged, and the outcome still answered). Never throws.
 */
export async function fetchEcbRates(
  opts: {
    now?: () => number;
    download?: Downloader;
    full?: boolean;
    /** Tests shorten these (see TIME LIMITS). */
    budgetMs?: number;
    recordMs?: number;
    readTimeoutMs?: number;
    downloadTimeoutMs?: number;
    writeDeadlineMs?: number;
  } = {}
): Promise<FetchOutcome> {
  const now = opts.now ?? Date.now;
  const started = now();
  const written: string[] = [];
  /** Fields found missing, unusable or unlike the file, and written again. */
  const mended: string[] = [];
  let previous: EcbFetch | null = null;
  let newest: string | null = null;
  const end = started + (opts.budgetMs ?? RUN_BUDGET_MS);
  /** What is left of the run, at most `cap`. */
  const left = (cap: number) => Math.min(cap, end - now());

  const record = async (given: FetchOutcome): Promise<FetchOutcome> => {
    const outcome: FetchOutcome = { ...given, mended: [...new Set(given.mended)].sort() };
    const at = new Date(now()).toISOString();
    const named = outcome.mended.length > 0 ? { mended: outcome.mended.slice(0, MAX_MENDED) } : {};
    const entry: EcbFetch = outcome.ok
      ? { at, ok: true, newest: outcome.newest, last_ok: at, ...named }
      : { at, ok: false, reason: outcome.reason.slice(0, 500), newest, last_ok: previous?.last_ok ?? null, ...named };
    if (outcome.mended.length > 0) console.warn(`ECB rates: wrote again ${outcome.mended.join(', ')}, which were missing, couldn’t be used or didn’t match the file`);
    try {
      await within('recording the outcome', opts.recordMs ?? RECORD_MS, () => ecbStore.setMany([[FETCH_FIELD, entry]]));
    } catch (err) {
      console.error('ECB rates: the outcome could not be recorded', reasonOf(err));
    }
    if (!outcome.ok) console.error(`ECB rates: the fetch failed: ${outcome.reason}`);
    return outcome;
  };

  const readMs = opts.readTimeoutMs ?? READ_TIMEOUT_MS;
  const downloadMs = opts.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  try {
    const known = await within('reading the stored rates’ names', left(readMs), () => ecbStore.ids());
    const current = new Date(started).toISOString().slice(0, 4);
    const stored = new Map<string, readonly string[] | null>();
    // Every year's calendar (about 3 KB each), so one that is missing or
    // can't be used is written again with its year, tonight. A past year's
    // series are checked after the writes (see WHAT IT MENDS).
    const toRead = new Set<string>([FETCH_FIELD, LATEST_FIELD]);
    for (const id of known) if (id.startsWith('days:')) toRead.add(id);
    const { fields, unusable } = await within('reading the stored calendars', left(readMs), () => readEcbFields([...toRead]));
    // Written again tonight: a calendar with its year, the newest publication
    // with the newest year, the record of the fetch by this run's.
    const damaged = new Set(unusable);
    if (damaged.has(FETCH_FIELD)) mended.push(FETCH_FIELD);
    const fetched = fields.get(FETCH_FIELD);
    previous = isFetch(fetched) ? fetched : null;
    for (const id of toRead) {
      if (!id.startsWith('days:')) continue;
      const year = id.slice(5);
      const d = fields.get(id);
      stored.set(year, isDays(d, year) ? d : null);
    }
    const latest = fields.get(LATEST_FIELD);
    const storedLatest = isLatest(latest) ? latest.date : null;

    let download: { status: number; bytes: Uint8Array };
    const allowed = left(downloadMs);
    try {
      // Aborted at its limit, and raced too, for a downloader that doesn't
      // honour the signal.
      download = await within(`the download`, allowed, () => (opts.download ?? downloadWithFetch)(ECB_HISTORY_URL, AbortSignal.timeout(Math.max(1, allowed))));
    } catch (err) {
      return record({ ok: false, reason: err instanceof StepTimeout ? err.message : `the download failed: ${reasonOf(err, allowed)}`, written, mended });
    }
    if (download.status !== 200) return record({ ok: false, reason: `the ECB answered ${download.status}`, written, mended });

    const csv = csvOf(download.bytes);
    if (typeof csv !== 'string') return record({ ok: false, reason: csv.reason, written, mended });
    const file = parseEcbCsv(csv);
    if ('error' in file) return record({ ok: false, reason: `the file isn’t the ECB’s: ${file.error}`, written, mended });
    newest = file.days[file.days.length - 1];
    // A stale copy (a cache still serving yesterday's file): nothing to take
    // from it, and the rates are no fresher for having asked.
    if (storedLatest && newest < storedLatest) {
      return record({ ok: false, reason: `the file's newest day, ${newest}, is older than the stored ${storedLatest}`, written, mended });
    }

    const plan = planWrites(file, { days: stored, latest: storedLatest }, { current, all: opts.full });
    const deadline = started + (opts.writeDeadlineMs ?? WRITE_DEADLINE_MS);
    const write = async (step: { year: string; fields: Map<string, unknown> }) => {
      await within(`writing ${step.year}`, end - now(), () => ecbStore.setMany(step.fields));
      written.push(step.year);
      for (const id of step.fields.keys()) if (damaged.has(id)) mended.push(id);
    };
    for (const step of plan.years) {
      if (now() > deadline) {
        return record({ ok: false, reason: `the writes took longer than ${(opts.writeDeadlineMs ?? WRITE_DEADLINE_MS) / 1000}s, after ${written.length} of ${plan.years.length} years`, written, mended });
      }
      await write(step);
    }

    // The past years tonight's plan left alone, checked against the file
    // (see WHAT IT MENDS), from a different one each night, so a night that
    // runs out of time leaves the rest to be checked first another night.
    const refused = [...plan.refused];
    if (!opts.full) {
      const inFile = new Set(file.days.map((d) => d.slice(0, 4)));
      const past = [...stored.keys()].filter((y) => stored.get(y) && inFile.has(y) && !written.includes(y) && !refused.includes(y)).sort().reverse();
      const turn = past.length > 0 ? Math.floor(started / 86_400_000) % past.length : 0;
      const order = [...past.slice(turn), ...past.slice(0, turn)];
      for (let i = 0; i < order.length; i++) {
        if (now() > deadline) {
          console.warn(`ECB rates: ${order.length - i} of ${order.length} past years weren’t checked tonight, for lack of time`);
          break;
        }
        const year = order[i];
        const step = yearStep(file, year);
        const ids = [...step.fields.keys()].filter((id) => id !== daysField(year));
        const { fields: series } = await within(`checking ${year}`, left(readMs), () => readEcbFields(ids));
        const unlike = unlikeStored(step, stored.get(year)!, series);
        if (unlike === null) refused.push(year);
        else if (unlike.length > 0) {
          await write(step);
          mended.push(...unlike);
        }
      }
    }
    if (refused.length > 0) console.warn(`ECB rates: kept the stored ${refused.join(', ')}, which held days the file didn’t`);
    return record({ ok: true, newest, written, refused, mended });
  } catch (err) {
    return record({ ok: false, reason: err instanceof StepTimeout ? `${err.message}, after ${written.length} years written` : reasonOf(err, downloadMs), written, mended });
  }
}

