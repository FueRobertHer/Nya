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
// TIME LIMITS. The download has its own timeout and the writes a deadline, so
// a hang is an ordinary failure, recorded in the store's `fetch` field and
// answered 500, rather than Vercel ending the function with nothing recorded
// (the reason lib/backup.ts gives every step a limit).

import { listZip, readEntry, type ZipEntry, type ZipProblem } from '../zip';
import { ecbStore, readEcbFields } from './ecb-store';
import { FETCH_FIELD, LATEST_FIELD, isDays, isFetch, isLatest } from './fields';
import { parseEcbCsv, planWrites } from './ecb-parse';
import type { EcbFetch } from './rates';

export const ECB_HISTORY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip';
/** The download's limit: the file is about 640 KB. */
export const DOWNLOAD_TIMEOUT_MS = 20_000;
/** The writes' limit, within the route's 60 seconds. */
export const WRITE_DEADLINE_MS = 25_000;
/** Far more than the file's 640 KB zipped and 1.9 MB of CSV. */
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const ZIP_LIMITS = { maxEntries: 4, maxEntryBytes: 32 * 1024 * 1024 };
const ENTRY = 'eurofxref-hist.csv';

export type FetchOutcome =
  | { ok: true; newest: string; written: string[]; refused: string[] }
  | { ok: false; reason: string; written: string[] };

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

/** Why an error happened, for an operator, without what it carried. */
const reasonOf = (err: unknown): string => {
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return `the download took longer than ${DOWNLOAD_TIMEOUT_MS / 1000}s`;
  return err instanceof Error ? err.message.slice(0, 200) : 'an unknown error';
};

/**
 * One run of the fetch: download, check, write what changed, and record the
 * outcome in the store's `fetch` field (best effort: a failure to record it
 * is logged, and the outcome still answered). Never throws.
 */
export async function fetchEcbRates(
  opts: { now?: () => number; download?: Downloader; full?: boolean; downloadTimeoutMs?: number; writeDeadlineMs?: number } = {}
): Promise<FetchOutcome> {
  const now = opts.now ?? Date.now;
  const started = now();
  const written: string[] = [];
  let previous: EcbFetch | null = null;
  let newest: string | null = null;

  const record = async (outcome: FetchOutcome): Promise<FetchOutcome> => {
    const at = new Date(now()).toISOString();
    const entry: EcbFetch = outcome.ok
      ? { at, ok: true, newest: outcome.newest, last_ok: at }
      : { at, ok: false, reason: outcome.reason.slice(0, 500), newest, last_ok: previous?.last_ok ?? null };
    try {
      await ecbStore.setMany([[FETCH_FIELD, entry]]);
    } catch (err) {
      console.error('ECB rates: the outcome could not be recorded', reasonOf(err));
    }
    if (!outcome.ok) console.error(`ECB rates: the fetch failed: ${outcome.reason}`);
    return outcome;
  };

  try {
    const known = await ecbStore.ids();
    const current = new Date(started).toISOString().slice(0, 4);
    const stored = new Map<string, readonly string[] | null>();
    // Every year's calendar (about 3 KB each), so one that is missing or
    // can't be used is written again with its year, tonight. A damaged
    // series under an intact calendar is named by every reader that meets it
    // (no rate on its days) and mended by a full run.
    const toRead = new Set<string>([FETCH_FIELD, LATEST_FIELD]);
    for (const id of known) if (id.startsWith('days:')) toRead.add(id);
    const { fields } = await readEcbFields([...toRead]);
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
    try {
      download = await (opts.download ?? downloadWithFetch)(ECB_HISTORY_URL, AbortSignal.timeout(opts.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS));
    } catch (err) {
      return record({ ok: false, reason: `the download failed: ${reasonOf(err)}`, written });
    }
    if (download.status !== 200) return record({ ok: false, reason: `the ECB answered ${download.status}`, written });

    const csv = csvOf(download.bytes);
    if (typeof csv !== 'string') return record({ ok: false, reason: csv.reason, written });
    const file = parseEcbCsv(csv);
    if ('error' in file) return record({ ok: false, reason: `the file isn’t the ECB’s: ${file.error}`, written });
    newest = file.days[file.days.length - 1];
    // A stale copy (a cache still serving yesterday's file): nothing to take
    // from it, and the rates are no fresher for having asked.
    if (storedLatest && newest < storedLatest) {
      return record({ ok: false, reason: `the file's newest day, ${newest}, is older than the stored ${storedLatest}`, written });
    }

    const plan = planWrites(file, { days: stored, latest: storedLatest }, { current, all: opts.full });
    const deadline = started + (opts.writeDeadlineMs ?? WRITE_DEADLINE_MS);
    for (const step of plan.years) {
      if (now() > deadline) {
        return record({ ok: false, reason: `the writes took longer than ${(opts.writeDeadlineMs ?? WRITE_DEADLINE_MS) / 1000}s, after ${written.length} of ${plan.years.length} years`, written });
      }
      await ecbStore.setMany(step.fields);
      written.push(step.year);
    }
    if (plan.refused.length > 0) console.warn(`ECB rates: kept the stored ${plan.refused.join(', ')}, which held days the file didn’t`);
    return record({ ok: true, newest, written, refused: plan.refused });
  } catch (err) {
    return record({ ok: false, reason: reasonOf(err), written });
  }
}

