// lib/user-restore/commit.ts
//
// Writing one checked batch of a restore (lib/user-restore/check.ts), and
// finishing it (docs/data-export.md, "Bringing it back"). Every write is
// keyed by the file's own ids (the bank's rows by restoredId), so a batch
// written twice writes the same thing: an entry set by its id; a book or an
// import's records, which grow across batches, appended from where the batch
// says it starts, its rows already there taken as written; a day of history
// set by its day; a value written whole. Each store's bound is checked
// against what is stored before anything is written (Should fix 7: two
// batches can't push a store past what its whole-store reads rely on).
//
// What the download leaves out because the entries hold it is worked out at
// the finish, from what was written: the imports' summaries (with how many
// of their rows each was handed by an import undone in the old copy), and the
// holdings index; and so is what readers find restored rows by, each
// restored account's span of rows, never the page's word for it.

import type { Ctx } from '../containers';
import { StoreRefusedError, type MapStore, type ValueStore } from '../repo';
import { saveManualAccount, manualAccountIds, type ManualAccount } from '../manual';
import { restoreDirectoryEntries, restoreLinks, restoreDeclined, type DirectoryEntry } from '../links';
import type { Link } from '../link-core';
import { restoreHiddenAccounts, type HiddenAccount } from '../hidden';
import { restoreCarried, restoreOverrides, type CarriedRows } from '../overrides';
import { restoreRenames } from '../renames';
import { restoreBudgets } from '../budget-store';
import type { BudgetSet } from '../budget-set';
import { setGoals, type Goal } from '../goals';
import { restoreFlatBefore, restoreHistoryDays } from '../history';
import { restoreHoldingsIndex } from '../holdings-history';
import { importStore, importSummaryStore, summaryOf, type ImportEntry } from '../import/store';
import { historyImportStore, historyImportSummaryStore, importedTxnStore, summaryOfEntry, type HistoryImportEntry } from '../history-import/store';
import { manualTxnStore } from '../manual-txns';
import { firePlanStore, planCurrencyStore } from '../fire-plan';
import { clearCaches } from '../cache';
import { SEAM, MAX_RESTORED_MANUAL_ACCOUNTS } from './parts';
import { storeOfPart } from './check';
import { restoredAccountsStore, restoredTxnStore, type RestoredAccount, type RestoredBook, type RestoredTxn, type UserRestoreRecord } from './store';

/** A batch that can't be written as it is: refused, nothing written. */
export class BatchNotWritten extends StoreRefusedError {
  constructor(message: string, status = 409) {
    super(message, status);
    this.name = 'BatchNotWritten';
  }
}

type Rec = Record<string, unknown>;
const pairs = <V>(records: readonly Rec[]): [string, V][] => records.map((r) => [r.id as string, r.value as V]);

/** A store's bound (parts.ts SEAM `max`), against what is stored now and
 *  what this batch adds that isn't there. */
async function checkBound(ctx: Ctx, name: string, store: MapStore<unknown>, ids: readonly string[]): Promise<void> {
  const max = SEAM[name]?.max;
  if (max === undefined) return;
  const [count, present] = await Promise.all([store.count(ctx), store.getMany(ctx, ids)]);
  const adds = ids.filter((id) => !present.has(id)).length;
  if (count + adds > max) throw new BatchNotWritten(`This restore would keep more ${store.what} than Nya keeps (${max}), so this part wasn’t written.`, 413);
}

/** An entry that grows across batches: this batch's piece of its list
 *  (parts.ts SEAM `split`), from `from`, onto what is stored. Items already
 *  there (a batch sent again) are taken as written; a piece that would leave
 *  a gap is refused. */
function appended<T extends Rec>(current: T | null, value: T, field: string, from: number): T {
  const items = value[field] as unknown[];
  if (!current) {
    if (from !== 0) throw new BatchNotWritten('A batch of this restore came before the one it follows: undo the restore and start it again.');
    return value;
  }
  const have = (current[field] as unknown[] | undefined) ?? [];
  const { [field]: _a, ...headNow } = current;
  const { [field]: _b, ...headNew } = value;
  if (JSON.stringify(headNow) !== JSON.stringify(headNew)) throw new BatchNotWritten('Part of this restore was written differently before: undo the restore and start it again.');
  if (have.length < from) throw new BatchNotWritten('A batch of this restore came before the one it follows: undo the restore and start it again.');
  const fresh = items.slice(Math.min(items.length, have.length - from));
  return fresh.length === 0 ? current : ({ ...current, [field]: [...have, ...fresh] } as T);
}

/** An entry whose map grows across batches (holdings months' days): the
 *  piece's keys onto what is stored. */
function merged<T extends Rec>(current: T | null, value: T, field: string): T {
  if (!current) return value;
  return { ...current, [field]: { ...(current[field] as Rec), ...(value[field] as Rec) } } as T;
}

/**
 * Writes one batch, checked (checkBatch), into the container (see the
 * header). `record` is the restore's, re-read just before: what restored
 * accounts and rows are stamped with. Throws BatchNotWritten for a batch
 * that can't be written as it is, and what the seam throws.
 */
export async function writeBatch(ctx: Ctx, part: string, records: readonly Rec[], record: UserRestoreRecord): Promise<void> {
  const target = storeOfPart(part);
  if (target) {
    const { name, store } = target;
    if (store.kind === 'value') {
      await (store as ValueStore<unknown>).set(ctx, records[0].value);
      return;
    }
    const map = store as MapStore<Rec>;
    const split = SEAM[name]?.split;
    await checkBound(ctx, name, map as MapStore<unknown>, records.map((r) => r.id as string));
    if (!split) {
      await map.setMany(ctx, pairs<Rec>(records));
      return;
    }
    for (const r of records) {
      const id = r.id as string;
      const value = r.value as Rec;
      await map.update(ctx, id, (current) => (split.as === 'list' ? appended(current, value, split.field, (r.from as number | undefined) ?? 0) : merged(current, value, split.field)));
    }
    return;
  }
  switch (part) {
    case 'manual-accounts': {
      const have = new Set(await manualAccountIds(ctx));
      const adds = records.filter((r) => !have.has(r.id as string)).length;
      if (have.size + adds > MAX_RESTORED_MANUAL_ACCOUNTS) throw new BatchNotWritten(`This restore would keep more manual accounts than Nya keeps (${MAX_RESTORED_MANUAL_ACCOUNTS}).`, 413);
      for (const r of records) await saveManualAccount(ctx, r.value as ManualAccount);
      return;
    }
    case 'directory':
      return restoreDirectoryEntries(ctx, pairs<DirectoryEntry>(records));
    case 'restored-accounts':
      // Its restore's own id and time, from the record.
      await restoredAccountsStore.setMany(
        ctx,
        records.map((r) => [r.id as string, { ...(r.value as Rec), restore_id: record.id, restored_at: record.started_at } as never])
      );
      return;
    case 'restored-rows':
      for (const r of records) {
        const id = r.id as string;
        const dot = id.lastIndexOf('.');
        const rows = (r.rows as Rec[]).map((x): RestoredTxn => ({ id: x.id as string, account_id: x.account_id as string, import_id: record.id, bank: x.bank as never, created_at: record.started_at }));
        const book: RestoredBook = { version: 1, account_id: id.slice(0, dot), part: Number(id.slice(dot + 1)), rows };
        await restoredTxnStore.update(ctx, id, (current) => appended(current as unknown as Rec | null, book as unknown as Rec, 'rows', r.from as number) as unknown as RestoredBook);
      }
      return;
    case 'hidden':
      return restoreHiddenAccounts(ctx, pairs<HiddenAccount>(records));
    case 'overrides':
      return restoreOverrides(ctx, pairs<string>(records));
    case 'renames':
      return restoreRenames(ctx, pairs<string>(records));
    case 'carried-categories':
      return restoreCarried(ctx, pairs<CarriedRows>(records));
    case 'links':
      return restoreLinks(ctx, pairs<Link>(records));
    case 'declined':
      return restoreDeclined(ctx, pairs<string>(records));
    case 'budgets': {
      const r = records[0];
      return restoreBudgets(ctx, r.set as BudgetSet | null, r.copy as Record<string, number>);
    }
    case 'goals':
      return setGoals(ctx, records[0].value as Goal[]);
  }
  if (part === 'history:accounts:est:flat') return restoreFlatBefore(ctx, records[0].value as Record<string, number>);
  if (part.startsWith('history:')) return restoreHistoryDays(ctx, part.slice('history:'.length), records as unknown as { date: string; value: number | Record<string, number> }[]);
  throw new BatchNotWritten('This batch names a part this version of Nya doesn’t write.', 400);
}

/** How many rows of each import were handed to it by an import undone
 *  since (`taken_over`, lib/import/store.ts summaryOf): its rows that no
 *  record of its own made. */
function takenOver(rows: Iterable<{ id: string; import_id?: string | null }>, entries: ReadonlyMap<string, { records: { row_id?: string }[] }>): Map<string, number> {
  const own = new Map<string, Set<string>>();
  for (const [id, e] of entries) own.set(id, new Set(e.records.flatMap((r) => (r.row_id ? [r.row_id] : []))));
  const out = new Map<string, number>();
  for (const r of rows) {
    if (!r.import_id || !own.has(r.import_id) || own.get(r.import_id)!.has(r.id)) continue;
    out.set(r.import_id, (out.get(r.import_id) ?? 0) + 1);
  }
  return out;
}

/** Each restored account's `rows` (its first and last day, how many, in how
 *  many books), worked out from the books written rather than taken from
 *  the page's plan: readers find an account's books by it, and say the
 *  months it holds by it (lib/user-restore/restored.ts bookIdsOf). */
async function restoredSpans(ctx: Ctx, before: () => Promise<void>): Promise<void> {
  const accounts = await restoredAccountsStore.getAll(ctx);
  if (accounts.size === 0) return;
  const books = await restoredTxnStore.getAll(ctx);
  const spans = new Map<string, NonNullable<RestoredAccount['rows']>>();
  for (const b of books.values()) {
    const s = spans.get(b.account_id) ?? { first: '', last: '', count: 0, books: 0 };
    for (const r of b.rows) {
      if (s.first === '' || r.bank.date < s.first) s.first = r.bank.date;
      if (s.last === '' || r.bank.date > s.last) s.last = r.bank.date;
      s.count++;
    }
    s.books = Math.max(s.books, b.part);
    spans.set(b.account_id, s);
  }
  const changed: [string, RestoredAccount][] = [];
  for (const [id, a] of accounts) {
    const s = spans.get(id);
    const rows = s && s.count > 0 ? s : null;
    if (JSON.stringify(a.rows) !== JSON.stringify(rows)) changed.push([id, { ...a, rows }]);
  }
  if (changed.length > 0) {
    await before();
    await restoredAccountsStore.setMany(ctx, changed);
  }
}

/** The Plan and the record of the currency its figures were typed in
 *  (lib/fire-plan.ts) are one setting: the record holds only while its
 *  amounts are the Plan's, so one kept beside another Plan is right only by
 *  coincidence. A file with either replaced both, so the one it lacked goes:
 *  a Plan from before the record was kept then asks its currency, as the
 *  Plan tab does for any. A file with neither leaves the account's pair. */
async function planPair(ctx: Ctx, parts: ReadonlySet<string>, before: () => Promise<void>): Promise<void> {
  const plan = parts.has(`store:${firePlanStore.name}`);
  const currency = parts.has(`store:${planCurrencyStore.name}`);
  if (plan === currency) return;
  const absent: { getReport: (c: Ctx) => Promise<{ value: unknown; unreadable: boolean }>; remove: (c: Ctx) => Promise<unknown> } = plan ? planCurrencyStore : firePlanStore;
  // One in a form this version doesn't know is left as it is: its own
  // release reads it against the Plan, and asks.
  const now = await absent.getReport(ctx);
  if (now.value === null && !now.unreadable) return;
  await before();
  await absent.remove(ctx);
}

/**
 * What the finish works out from what was written (see the header): each
 * restored account's rows, the imports' summaries, and the holdings index;
 * and, given the restore's record, the Plan's pair (planPair). Then the
 * caches go, since net worth and transactions changed. Run again, it writes
 * the same. `before` runs before each write, and may refuse it by throwing
 * (the finish route: its time, and the record looked at again).
 */
export async function finishWrites(ctx: Ctx, opts: { before?: () => Promise<void>; record?: UserRestoreRecord } = {}): Promise<void> {
  const before = opts.before ?? (async () => {});
  if (opts.record) await planPair(ctx, new Set(opts.record.plan.batches.map((b) => b.part)), before);
  await restoredSpans(ctx, before);
  const [imports, historyImports, manualBooks, importedBooks] = await Promise.all([
    importStore.getAll(ctx),
    historyImportStore.getAll(ctx),
    manualTxnStore.getAll(ctx),
    importedTxnStore.getAll(ctx),
  ]);
  const manualTaken = takenOver(
    [...manualBooks.values()].flatMap((b) => b.rows),
    imports as ReadonlyMap<string, ImportEntry>
  );
  if (imports.size > 0) {
    await before();
    await importSummaryStore.setMany(ctx, [...imports].map(([id, e]) => [id, summaryOf(e, manualTaken.get(id) ?? 0)] as const));
  }
  const historyTaken = takenOver(
    [...importedBooks.values()].flatMap((b) => b.rows),
    historyImports as ReadonlyMap<string, HistoryImportEntry>
  );
  if (historyImports.size > 0) {
    await before();
    await historyImportSummaryStore.setMany(ctx, [...historyImports].map(([id, e]) => [id, summaryOfEntry(e, historyTaken.get(id) ?? 0)] as const));
  }
  await before();
  await restoreHoldingsIndex(ctx);
  await clearCaches(ctx);
}
