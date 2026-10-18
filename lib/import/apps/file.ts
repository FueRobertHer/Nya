// lib/import/apps/file.ts
//
// The file a person brings from another app, as the text of the transactions
// CSV in it: the CSV itself, or the one an app's zip holds (YNAB's register,
// ZeroSum's transactions.csv). Actual Budget's full export, a zip of its
// SQLite database, is answered with how to export its CSV instead
// (lib/import/apps/actual.ts says what reading the database would take).
// Server only (lib/import/apps/zip.ts inflates with Node's zlib).

import { decodeFile } from '../text';
import { baseName, isZip, listZip, readEntry, type ZipEntry } from './zip';

export type AppFile = { text: string; encoding: string; entry: string | null } | { error: string };

/** What to export from Actual Budget instead of its database. */
export const ACTUAL_CSV_STEPS =
  'This is Actual Budget’s full export: its budget as an SQLite database, which Nya can’t read. Export its transactions as CSV instead: in Actual, open All accounts, choose the menu at the top right, then Export, and import that file.';

/** The entry of an app's zip that holds its transactions, or why there is
 *  none to read. */
function transactionsEntry(entries: readonly ZipEntry[]): ZipEntry | { error: string } {
  const names = entries.map((e) => baseName(e.name).toLowerCase());
  if (names.includes('db.sqlite') || names.some((n) => n.endsWith('.sqlite'))) return { error: ACTUAL_CSV_STEPS };
  const csv = entries.filter((e) => /\.(csv|tsv)$/i.test(e.name) && !baseName(e.name).startsWith('.') && !e.name.startsWith('__MACOSX/'));
  // YNAB's "<budget> - Register.csv", ZeroSum's transactions.csv: by name.
  const named = csv.find((e) => /register\.csv$/i.test(baseName(e.name))) ?? csv.find((e) => /^transactions\.csv$/i.test(baseName(e.name)));
  if (named) return named;
  if (csv.length === 1) return csv[0];
  if (csv.length === 0) return { error: 'This zip file holds no CSV file of transactions. Unzip it and choose the transactions file inside.' };
  return { error: `This zip file holds ${csv.length} CSV files, and none is named as an app’s transactions. Unzip it and choose the transactions file.` };
}

/** The transactions text of the file (see the header). */
export function appFileText(bytes: Uint8Array): AppFile {
  if (!isZip(bytes)) {
    const { text, encoding } = decodeFile(bytes);
    if (/^SQLite format 3\u0000/.test(text.slice(0, 16))) return { error: ACTUAL_CSV_STEPS };
    return { text, encoding, entry: null };
  }
  const entries = listZip(bytes);
  if ('error' in entries) return entries;
  const entry = transactionsEntry(entries);
  if ('error' in entry) return entry;
  const data = readEntry(bytes, entry);
  if ('error' in data) return data;
  const { text, encoding } = decodeFile(data);
  return { text, encoding, entry: baseName(entry.name).slice(0, 200) };
}
