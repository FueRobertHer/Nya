// lib/import/apps/zip.ts
//
// Reading the zip some apps export (YNAB's Export Budget Data: its register
// and plan as CSV files; ZeroSum's budget export: transactions.csv and
// budget.csv; Actual Budget's full export: its SQLite database). The reading
// itself is lib/zip.ts, shared with the ECB's history file; this module sets
// an export's bounds, cleans an entry's name for showing, and says what is
// wrong in words for the person importing. Server only.
//
// ONLY WHAT AN EXPORT NEEDS, AND BOUNDED (lib/zip.ts): the central directory,
// each entry inflated only when asked for, never past MAX_ENTRY_BYTES, and
// only when what comes out is the size and the CRC-32 the index says. An
// encrypted entry, a split archive, ZIP64 and more than MAX_ENTRIES entries
// are refused: no app's export is any of those.

import { cleanText } from '../normalize';
import { baseName, isZip, listZip as listAny, readEntry as readAny, type ZipEntry, type ZipProblem } from '../../zip';

export { baseName, isZip, type ZipEntry };

/** The most entries an export may hold, and the largest one read. */
export const MAX_ENTRIES = 64;
export const MAX_ENTRY_BYTES = 6 * 1024 * 1024;
/** The longest entry name kept: a file's name, as an app writes one, is far
 *  shorter. Its name is shown, and kept with the import. */
const MAX_NAME = 200;

const LIMITS = { maxEntries: MAX_ENTRIES, maxEntryBytes: MAX_ENTRY_BYTES };

const isProblem = (v: unknown): v is ZipProblem => !!v && typeof v === 'object' && 'problem' in v;

/** The entries a zip holds, from its central directory, or why it can't be
 *  read. */
export function listZip(bytes: Uint8Array): ZipEntry[] | { error: string } {
  const listed = listAny(bytes, LIMITS);
  if (isProblem(listed)) {
    if (listed.problem === 'unsupported') return { error: 'This zip file is in a form Nya doesn’t read (split over several files, or ZIP64). Unzip it and choose the CSV file inside.' };
    if (listed.problem === 'too-many') return { error: `This zip file holds ${listed.count} files, more than an app’s export does. Unzip it and choose the CSV file inside.` };
    return { error: 'This zip file can’t be read: it may be damaged. Export it again, or unzip it and choose the CSV file inside.' };
  }
  return listed.map((e) => {
    // Shown and kept as text is: no control characters or marks that turn
    // what follows round, and only so long.
    const full = cleanText(e.name);
    const name = full.length <= MAX_NAME ? full : full.slice(0, /[\uD800-\uDBFF]/.test(full[MAX_NAME - 1]) ? MAX_NAME - 1 : MAX_NAME);
    return { ...e, name };
  });
}

/** An entry's bytes, inflated, or why not (see the header). */
export function readEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array | { error: string } {
  const read = readAny(bytes, entry, LIMITS);
  if (!isProblem(read)) return read;
  switch (read.problem) {
    case 'encrypted':
      return { error: 'This zip file is encrypted. Export it again without a password, or unzip it and choose the CSV file inside.' };
    case 'too-large':
      return { error: `${entry.name} is larger than ${MAX_ENTRY_BYTES / (1024 * 1024)} MB unzipped, more than one import takes. Export a shorter period and import it in parts.` };
    case 'method':
      return { error: `${entry.name} in this zip is compressed in a way Nya doesn’t read. Unzip it and choose the CSV file inside.` };
    default:
      return { error: `The file ${entry.name} in this zip can’t be read: it may be damaged. Unzip it and choose the CSV file inside.` };
  }
}
