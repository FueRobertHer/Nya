// lib/migration/store.ts
//
// What an import from another app keeps (M2, "Migration importers"), on the
// storage seam (lib/repo.ts):
//
//   app-imports   one entry per import of an app's export, under the id the
//                 review minted for it ("app-import:" and a random UUID, so
//                 the same import sent twice, its answer lost on the way, is
//                 found and never made twice): the app, the file, when, and
//                 everything it made, so Undo can take all of it out in one
//                 action. Each account it imported into is an import of that
//                 account's own (lib/import/commit.ts for a manual account,
//                 lib/history-import/commit.ts for a linked one: the rows,
//                 their raw records, what was said about them), named here by
//                 its id; and what it made beside them: the manual accounts,
//                 categories, groups and tags. Every id is minted and written
//                 here before the thing it names is made, so an import that
//                 stops part way (a failure, a deploy) leaves an entry naming
//                 all it may have made, and Undo finishes it.
//
// In the person's download (exportable): it is their record of what they
// brought over, and the rows and records it names are in the download under
// their own stores. Deleting the account deletes it with the container.
//
// READS ARE STRICT, as the seam's are: an entry that can't be read is named,
// never taken for no import, and Undo refuses it (its rows are still listed
// with Undo on each account they went into).

import { defineMapStore } from '../repo';
import { APPS, type AppId } from '../import/apps/types';

export type MigrationImport = {
  /** The Nya account, as its id was when the import was made. */
  account_id: string;
  kind: 'manual' | 'linked';
  /** Its type (depository, credit, ...): whether its estimated history is
   *  walked through imported rows (lib/history-import/walk.ts). */
  type: string;
  /** The account's import (lib/import/store.ts or lib/history-import/store.ts). */
  import_id: string;
  /** The account's name, and the app's accounts that went into it. */
  name: string;
  sources: string[];
};

export type MigrationCounts = {
  /** Transactions read, and what became of them: added, kept as the bank's
   *  (a linked account's duplicates, never counted while the bank's row is
   *  there), already in Nya, and lines that couldn't be read. */
  rows: number;
  imported: number;
  duplicates: number;
  present: number;
  unreadable: number;
  /** Split transactions rebuilt, tags put on, and what it made. */
  splits: number;
  tagged: number;
};

export type MigrationEntry = {
  version: 1;
  app: AppId;
  /** Which of the app's export formats (lib/import/apps/common.ts Parsed). */
  variant: string;
  file_name: string | null;
  /** The file read inside a zip, when it came in one. */
  entry: string | null;
  file_bytes: number;
  started_at: string;
  /** 'importing' until every step is done, 'done' after; 'undoing' while an
   *  undo runs. An entry left 'importing' stopped part way: Undo takes out
   *  what it made. */
  status: 'importing' | 'done' | 'undoing';
  finished_at: string | null;
  imports: MigrationImport[];
  /** What it made beside the rows, by id: minted here before each was made. */
  made: { accounts: { id: string; name: string }[]; categories: string[]; groups: string[]; tags: string[] };
  counts: MigrationCounts | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInstant = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isText = (v: unknown, max = 200) => typeof v === 'string' && v.length <= max;
const isTextOrNull = (v: unknown, max = 200) => v === null || isText(v, max);
const isIds = (v: unknown) => Array.isArray(v) && v.length <= 1000 && v.every((x) => isText(x, 200));
/** Only these keys: an undo record a later release adds to (another kind of
 *  thing made, say) is refused here rather than undone without it. */
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));

function isImport(v: unknown): v is MigrationImport {
  return (
    isRecord(v) &&
    only(v, ['account_id', 'kind', 'type', 'import_id', 'name', 'sources']) &&
    isText(v.account_id) &&
    (v.kind === 'manual' || v.kind === 'linked') &&
    isText(v.type, 40) &&
    isText(v.import_id) &&
    isText(v.name, 500) &&
    Array.isArray(v.sources) &&
    v.sources.length <= 200 &&
    v.sources.every((s) => isText(s, 500))
  );
}

const COUNTS = ['rows', 'imported', 'duplicates', 'present', 'unreadable', 'splits', 'tagged'];
function isCounts(v: unknown): v is MigrationCounts {
  return isRecord(v) && only(v, COUNTS) && COUNTS.every((k) => isCount(v[k]));
}

/** One entry: its shape and types, and nothing else. It is a record of what
 *  to undo, so an entry a later release wrote with more in it (another kind
 *  of thing it made) is unrecognised here, listed as from a later version and
 *  never undone, rather than undone leaving that behind; each account's
 *  import is still listed with Undo on that account. */
export function isMigrationEntry(v: unknown): v is MigrationEntry {
  if (!isRecord(v) || v.version !== 1) return false;
  if (!only(v, ['version', 'app', 'variant', 'file_name', 'entry', 'file_bytes', 'started_at', 'status', 'finished_at', 'imports', 'made', 'counts'])) return false;
  const made = v.made;
  return (
    (APPS as readonly unknown[]).includes(v.app) &&
    isText(v.variant, 60) &&
    isTextOrNull(v.file_name) &&
    isTextOrNull(v.entry) &&
    isCount(v.file_bytes) &&
    isInstant(v.started_at) &&
    (v.status === 'importing' || v.status === 'done' || v.status === 'undoing') &&
    (v.finished_at === null || isInstant(v.finished_at)) &&
    Array.isArray(v.imports) &&
    v.imports.length <= 200 &&
    v.imports.every(isImport) &&
    isRecord(made) &&
    only(made, ['accounts', 'categories', 'groups', 'tags']) &&
    Array.isArray(made.accounts) &&
    made.accounts.length <= 200 &&
    made.accounts.every((a) => isRecord(a) && only(a, ['id', 'name']) && isText(a.id) && isText(a.name, 500)) &&
    isIds(made.categories) &&
    isIds(made.groups) &&
    isIds(made.tags) &&
    (v.counts === null || isCounts(v.counts))
  );
}

export const migrationStore = defineMapStore<MigrationEntry>('app-imports', {
  what: 'imports from other apps',
  isValid: isMigrationEntry,
  exportable: true, // the person's record of what they brought over
});

/** An import's id: minted by the review, so the import it stands for is made
 *  once however many times it is sent. */
export function newMigrationId(): string {
  return `app-import:${crypto.randomUUID()}`;
}

export function isMigrationId(id: unknown): id is string {
  return typeof id === 'string' && /^app-import:[0-9a-f-]{36}$/.test(id);
}
