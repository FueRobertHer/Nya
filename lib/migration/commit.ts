// lib/migration/commit.ts
//
// Importing another app's export once the person has reviewed it
// (lib/migration/plan.ts), undoing it in one action, and listing what was
// imported: the only part of lib/migration/ that writes. Server only.
//
// ALL OF IT, OR NONE. The commit writes the entry first (lib/migration/
// store.ts), naming everything it will make, by ids minted now: the manual
// accounts, the categories and groups, the tags, each account's import and
// every row. Then, in order: the new manual accounts; the categories and
// groups, in one compare-and-set that works the mapping out again on the set
// as it is and refuses unless it is the one reviewed (lib/migration/
// categories.ts applyCategoryPlan); the tags, in one; each Nya account's
// import, through that account's own commit, which matches its rows again
// against what the account holds at that moment (lib/import/commit.ts for a
// manual account; lib/history-import/commit.ts for a linked one, which also
// refuses a review that changed); and last what the rows carry beside them:
// tags (and, on a linked account's row the bank already has, the app's note)
// in what is said about each transaction, split transactions' parts, and on
// such a row the app's category, so the bank's row shows the person's own
// categorizing. If any step fails the import is undone, as Undo would undo
// it, and the failure answered: a file is never half imported. An entry left
// part way (the server stopped) is listed, and Undo finishes taking it out.
//
// NOTHING ELSE. No balance is moved (a new manual account's is the one the
// person typed, as the Add form saves it), and nothing is written to the
// history layer (lib/history.ts): the rows are transactions. A linked
// account's estimated history is drawn back through them afterwards
// (lib/history-import/extend.ts), into the estimated layer only, as any import
// into it is.
//
// UNDO, in one action: every account's import undone (its rows, with what was
// said about them, their splits and places in groups, and their categories
// on a linked account's: lib/import/commit.ts undoImport, lib/history-import/
// commit.ts undoHistoryImport; rows a later import relied on are handed to
// it, as those undo); then what it made, where nothing else now uses it: a
// manual account it made that holds no rows, a tag no transaction or rule
// holds, a category no transaction, budget or rule uses (lib/category-
// usage.ts), a group left with no category. What something else uses now is
// kept, and the answer says so.

import type { Ctx } from '../containers';
import { loggable } from '../log-safe';
import { StoredDataUnreadableError } from '../repo';
import { manualAccountExists, newManualId, saveManualAccount, type ManualAccount } from '../manual';
import { manualTxnStore } from '../manual-txns';
import { newManualTxnId } from '../manual-txn-input';
import { deleteManualAccount } from '../manual-account-delete';
import { changeTaxonomy, newCategoryId, readTaxonomy, ensureTaxonomy } from '../category-store';
import { categoryForKey, deleteCategory, deleteGroup, indexTaxonomy, TEXT, CategoryError } from '../categories';
import { categoryUsage } from '../category-usage';
import { loadBudgets } from '../budget-store';
import { addTag, changeTagSet, newTagId, readTagSet, tagByName, TagError } from '../tags';
import { deleteTag } from '../tag-delete';
import { readRuleSet } from '../rules';
import { carriedAnnotationStore, txnAnnotationStore, type TxnAnnotation } from '../txn-annotations';
import { checkParts, splitStore, SPLITS_VERSION, type SplitRecord } from '../splits';
import { setOverrides } from '../overrides';
import { commitImport, ImportNotFoundError, undoImport } from '../import/commit';
import { newImportId } from '../import/store';
import { commitHistoryImport, HistoryImportNotFoundError, reviewDigest, undoHistoryImport } from '../history-import/commit';
import { newHistoryImportId, newImportedTxnId } from '../history-import/store';
import type { Period } from '../history-import/plan';
import { applyCategoryPlan } from './categories';
import { migrationStore, type MigrationCounts, type MigrationEntry } from './store';
import type { MigrationAnswers, MigrationPlan, MigrationState } from './plan';

/** Writes per request when what is said beside the rows is written: far
 *  under the request-size ceiling. */
const CHUNK = 500;

export type MigrationFile = { name: string | null; entry: string | null; bytes: number; encoding: string };

export type MigrationCommitResult = {
  entry: MigrationEntry;
  /** The same import was made already (sent twice): nothing more was done. */
  already: boolean;
  /** The days of the rows each linked account took: the estimated history is
   *  drawn again through those its backfill walks. */
  linked: { account_id: string; type: string; dates: string[] }[];
  /** Whether it made a manual account (net worth changed). */
  made_accounts: boolean;
};

/**
 * The import (see the header). `plan` is worked out from `state` just now and
 * has the digest the person reviewed (the route checks it). Throws what a
 * step throws (CategoriesChangedError, ReviewChangedError, UnansweredError,
 * what the seam refuses), having undone what it made.
 */
export async function commitMigration(
  ctx: Ctx,
  input: { id: string; plan: MigrationPlan; answers: MigrationAnswers; state: MigrationState; file: MigrationFile; now?: Date }
): Promise<MigrationCommitResult> {
  const { plan, answers, state } = input;
  const now = input.now ?? new Date();
  const at = now.toISOString();

  // Every id, minted once.
  const accountIds = new Map(plan.targets.filter((t) => t.create).map((t) => [t.key, newManualId()]));
  const groupIds = plan.categories.groups.map(() => newCategoryId());
  const categoryIds = plan.categories.mappings.filter((m) => m.target.to === 'new').map(() => newCategoryId());
  const tagIds = new Map(plan.tags.names.filter((t) => !t.existing).map((t) => [t.name.toLowerCase(), newTagId()]));
  const minted = new Map(
    plan.targets.map((t) => [
      t.key,
      t.kind === 'linked' ? { import_id: newHistoryImportId(), rows: t.rows.map(() => newImportedTxnId()) } : { import_id: newImportId(), rows: t.rows.map(() => newManualTxnId()) },
    ])
  );
  const accountOf = (t: MigrationPlan['targets'][number]) => t.account_id ?? accountIds.get(t.key)!;
  const entry: MigrationEntry = {
    version: 1,
    app: plan.read.app,
    variant: plan.read.parsed.variant,
    file_name: input.file.name,
    entry: input.file.entry,
    file_bytes: input.file.bytes,
    started_at: at,
    status: 'importing',
    finished_at: null,
    imports: plan.targets.map((t) => ({
      account_id: accountOf(t),
      kind: t.kind,
      type: t.create?.type ?? (t.kind === 'linked' ? state.linked.get(accountOf(t))?.type : state.manual.get(accountOf(t))?.type) ?? 'other',
      import_id: minted.get(t.key)!.import_id,
      name: t.name,
      sources: t.sources,
    })),
    made: {
      accounts: plan.targets.filter((t) => t.create).map((t) => ({ id: accountIds.get(t.key)!, name: t.name })),
      categories: categoryIds,
      groups: groupIds,
      tags: [...tagIds.values()],
    },
    counts: null,
  };
  // Once: the same import sent again finds the first and does nothing.
  let fresh = false;
  const stored = await migrationStore.update(ctx, input.id, (current) => {
    fresh = current === null;
    return current ?? entry;
  });
  if (!fresh) return { entry: stored!, already: true, linked: [], made_accounts: false };

  const linked: MigrationCommitResult['linked'] = [];
  try {
    // The manual accounts it makes, as the Add form saves them.
    for (const t of plan.targets) {
      if (!t.create) continue;
      const account: ManualAccount = { ...t.create, account_id: accountIds.get(t.key)!, updated_at: at };
      await saveManualAccount(ctx, account);
    }

    // The categories and groups, as reviewed or not at all.
    if (plan.categories.groups.length > 0 || plan.categories.added > 0) {
      await changeTaxonomy(ctx, (t) => applyCategoryPlan(t, plan.sources, answers.categories, plan.categories, { groups: groupIds, categories: categoryIds }).taxonomy);
    }
    const ix = indexTaxonomy((await readTaxonomy(ctx)) ?? (await ensureTaxonomy(ctx)));

    // The tags, the person's own where they have one by that name.
    const tagOf = new Map<string, string>();
    if (plan.tags.on && plan.tags.names.length > 0) {
      const set = await changeTagSet(ctx, (cur) => {
        let next = cur;
        for (const n of plan.tags.names) {
          if (tagByName(next, n.name)) continue;
          next = addTag(next, { name: n.name }, () => tagIds.get(n.name.toLowerCase()) ?? newTagId(), now).set;
        }
        return next;
      });
      for (const n of plan.tags.names) tagOf.set(n.name.toLowerCase(), tagByName(set, n.name)!.id);
    }

    // Each account's import, then what its rows carry.
    const annotations: [string, TxnAnnotation][] = [];
    const splits: [string, SplitRecord][] = [];
    const overrides = new Map<string, string>();
    let imported = 0;
    let duplicates = 0;
    let present = 0;
    let unreadable = 0;
    for (const t of plan.targets) {
      const ids = minted.get(t.key)!;
      const account_id = accountOf(t);
      const read = { app: plan.read.app, variant: plan.read.parsed.variant, migration: input.id, accounts: t.sources, ...plan.read.read };
      let kept: { i: number; duplicate: boolean }[] = [];
      if (t.kind === 'manual') {
        const account: ManualAccount = t.create ? { ...t.create, account_id, updated_at: at } : state.manual.get(account_id)!;
        const result = await commitImport(ctx, {
          account,
          format: 'csv',
          file_name: input.file.name,
          file_bytes: input.file.bytes,
          encoding: input.file.encoding,
          rows: t.rows,
          problems: t.problems,
          read,
          statement: null,
          columns: plan.read.header,
          ids,
          now,
        });
        const c = result.plan.counts;
        imported += c.new;
        present += c.present;
        unreadable += c.unreadable;
        if (result.import_id) kept = result.plan.actions.flatMap((a, i): { i: number; duplicate: boolean }[] => (a === 'add' ? [{ i, duplicate: false }] : []));
      } else {
        const context = state.contexts.get(account_id)!;
        const imports = new Map<string, { covers: Period | null }>([...context.summaries].map(([id, s]) => [id, { covers: { from: s.covers.from, to: s.covers.to } }]));
        const result = await commitHistoryImport(ctx, {
          account_id,
          ids: context.ids,
          format: 'csv',
          file_name: input.file.name,
          file_bytes: input.file.bytes,
          encoding: input.file.encoding,
          rows: t.rows,
          problems: t.problems,
          read,
          statement: null,
          columns: plan.read.header,
          covers: t.covers!,
          banks: context.banks,
          order: context.order,
          imports,
          bank_from: context.bank_from,
          choices: t.choices,
          reviewed: reviewDigest(t.linked!.review),
          ids_minted: ids,
          now,
        });
        const c = result.plan.counts;
        imported += c.new;
        duplicates += c.duplicates + c.already;
        present += c.present;
        unreadable += c.unreadable;
        if (result.import_id) {
          kept = result.plan.actions.flatMap((a, i): { i: number; duplicate: boolean }[] => (a === 'add' ? [{ i, duplicate: false }] : a === 'duplicate' ? [{ i, duplicate: true }] : []));
          const type = state.linked.get(account_id)?.type ?? 'other';
          linked.push({ account_id, type, dates: kept.filter((k) => !k.duplicate).map((k) => t.rows[k.i].row.date) });
        }
      }
      for (const { i, duplicate } of kept) {
        const id = ids.rows[i];
        const row = t.rows[i].row;
        const tags = (t.tags.get(i) ?? []).map((n) => tagOf.get(n.toLowerCase())).filter((x): x is string => !!x);
        // On a row the bank has, the note is said beside it, so the bank's
        // row shows it (lib/txn-layers.ts); else it is the row's own.
        const note = duplicate && row.note ? row.note : undefined;
        if (tags.length > 0 || note) annotations.push([id, { ...(tags.length > 0 ? { tags: [...new Set(tags)] } : {}), ...(note ? { note } : {}), updated_at: at }]);
        if (duplicate && row.category) overrides.set(id, row.category);
        const parts = t.parts.get(i);
        if (parts) {
          const checked = checkParts(
            parts.map((p) => {
              const c = categoryForKey(ix, TEXT, p.text);
              if (!c) throw new Error('A split part’s category was not made');
              return { amount: p.amount, category_id: c.id, ...(p.note ? { note: p.note } : {}) };
            }),
            { amount: row.amount, currency: row.currency, pending: false }
          );
          splits.push([id, { version: SPLITS_VERSION, amount: row.amount, currency: row.currency, parts: checked, updated_at: at }]);
        }
      }
    }
    for (let i = 0; i < annotations.length; i += CHUNK) await txnAnnotationStore.setMany(ctx, annotations.slice(i, i + CHUNK));
    for (let i = 0; i < splits.length; i += CHUNK) await splitStore.setMany(ctx, splits.slice(i, i + CHUNK));
    if (overrides.size > 0) await setOverrides(ctx, overrides);

    const counts: MigrationCounts = {
      rows: plan.read.parsed.txns.length,
      imported,
      duplicates,
      present,
      unreadable: unreadable,
      splits: splits.length,
      tagged: annotations.filter(([, a]) => (a.tags?.length ?? 0) > 0).length,
    };
    const done: MigrationEntry = { ...entry, status: 'done', finished_at: new Date().toISOString(), counts };
    await migrationStore.set(ctx, input.id, done);
    return { entry: done, already: false, linked, made_accounts: accountIds.size > 0 };
  } catch (err) {
    // Whatever was made goes again, as Undo would take it out.
    await undoMigration(ctx, input.id, { failed: true }).catch((cleanup) => console.warn('migration: an import that failed could not be taken out, and is listed with Undo', loggable(cleanup)));
    throw err;
  }
}

// ---- Undo ----

/** No import from another app with that id. */
export class MigrationNotFoundError extends Error {
  constructor() {
    super('That import was already undone.');
    this.name = 'MigrationNotFoundError';
  }
}

/** How long an import may still be being made: longer than the route may run
 *  (app/api/migration maxDuration), so one older than this stopped. */
export const STILL_IMPORTING_MS = 5 * 60 * 1000;

/** The import is still being made: undo it once it is done. */
export class MigrationBusyError extends Error {
  constructor() {
    super('This import is still being made. Undo it once it has finished, in a few minutes.');
    this.name = 'MigrationBusyError';
  }
}

export type MigrationUndoResult = {
  /** Rows taken out, duplicates of a linked account's bank rows with them,
   *  and rows kept for a later import that relied on them. */
  removed: number;
  duplicates: number;
  kept: number;
  /** What it made, taken out or kept because something uses it now. */
  accounts: { removed: string[]; kept: string[] };
  categories: { removed: number; kept: number };
  tags: { removed: number; kept: number };
  /** The days of the rows each linked account lost. */
  linked: { account_id: string; type: string; dates: string[] }[];
};

/**
 * Takes an import from another app out (see the header). Undoing again after
 * an undo that stopped part way finishes it. Throws MigrationNotFoundError
 * when there is no such import, UnreadableEntriesError when its entry can't
 * be read (each account's import is still listed with Undo on that account),
 * and what an account's undo throws.
 */
export async function undoMigration(ctx: Ctx, id: string, opts: { failed?: boolean; now?: number } = {}): Promise<MigrationUndoResult> {
  const entry = await migrationStore.get(ctx, id);
  if (!entry) throw new MigrationNotFoundError();
  // One still being made is left to finish (or to take itself out, when it
  // fails: `failed`), unless it has gone quiet for longer than any import
  // takes, so it stopped part way.
  if (!opts.failed && entry.status === 'importing' && (opts.now ?? Date.now()) - Date.parse(entry.started_at) < STILL_IMPORTING_MS) throw new MigrationBusyError();
  if (entry.status !== 'undoing') await migrationStore.update(ctx, id, (cur) => (cur ? { ...cur, status: 'undoing' } : cur));
  const result: MigrationUndoResult = { removed: 0, duplicates: 0, kept: 0, accounts: { removed: [], kept: [] }, categories: { removed: 0, kept: 0 }, tags: { removed: 0, kept: 0 }, linked: [] };

  for (const imp of entry.imports) {
    try {
      if (imp.kind === 'manual') {
        const u = await undoImport(ctx, imp.account_id, imp.import_id);
        result.removed += u.removed;
        result.kept += u.kept;
      } else {
        const u = await undoHistoryImport(ctx, [imp.account_id], imp.import_id);
        result.removed += u.removed;
        result.duplicates += u.duplicates;
        result.kept += u.kept;
        result.linked.push({ account_id: imp.account_id, type: imp.type, dates: u.dates });
      }
    } catch (err) {
      // Never made (nothing to add), or undone already on its account.
      if (err instanceof ImportNotFoundError || err instanceof HistoryImportNotFoundError) continue;
      throw err;
    }
  }

  // The manual accounts it made, when they hold nothing now.
  for (const a of entry.made.accounts) {
    if (!(await manualAccountExists(ctx, a.id))) continue;
    const book = await manualTxnStore.get(ctx, a.id);
    if (book && book.rows.length > 0) {
      result.accounts.kept.push(a.name);
      continue;
    }
    await deleteManualAccount(ctx, a.id);
    result.accounts.removed.push(a.name);
  }

  // The tags it made, when nothing holds them now: no transaction's record,
  // carried record or rule. One that can't be read could hold any: they stay.
  if (entry.made.tags.length > 0) {
    const set = await readTagSet(ctx);
    const there = entry.made.tags.filter((t) => set?.tags.some((x) => x.id === t));
    if (there.length > 0) {
      const [records, carried, rules] = await Promise.all([txnAnnotationStore.getAllReport(ctx), carriedAnnotationStore.getAllReport(ctx), readRuleSet(ctx).catch(() => undefined)]);
      const sure = records.unreadable.length + records.unrecognised.length + carried.unreadable.length + carried.unrecognised.length === 0 && rules !== undefined;
      const held = new Set<string>();
      for (const r of records.entries.values()) for (const t of [...(r.tags ?? []), ...(r.untagged ?? [])]) held.add(t);
      for (const c of carried.entries.values()) for (const r of Object.values(c.rows)) for (const t of [...(r?.tags ?? []), ...(r?.untagged ?? [])]) held.add(t);
      for (const r of rules?.rules ?? []) for (const t of r.actions.add_tags ?? []) held.add(t);
      for (const t of there) {
        if (!sure || held.has(t)) result.tags.kept++;
        else {
          try {
            await deleteTag(ctx, t);
          } catch (err) {
            // Deleted meanwhile (another undo, the Tags screen): gone either way.
            if (!(err instanceof TagError)) throw err;
          }
          result.tags.removed++;
        }
      }
    }
  }

  // The categories it made, when nothing uses them now (lib/category-usage.ts,
  // which reads strictly: one it can't be sure of stays), then its groups
  // left empty.
  for (const c of entry.made.categories) {
    const t = await readTaxonomy(ctx);
    if (!t?.categories.some((x) => x.id === c)) continue;
    try {
      const usage = await categoryUsage(ctx, t, c);
      await changeTaxonomy(ctx, (cur) => deleteCategory(cur, c, usage));
      result.categories.removed++;
    } catch (err) {
      // In use now, changed meanwhile, or something it would need to be sure
      // of can't be read: kept. Anything else stops the undo, which can be
      // run again, rather than leave a category nothing says was made here.
      if (!(err instanceof CategoryError) && !(err instanceof StoredDataUnreadableError)) throw err;
      result.categories.kept++;
    }
  }
  if (entry.made.groups.length > 0) {
    const t = await readTaxonomy(ctx);
    const { budgets } = await loadBudgets(ctx).catch(() => ({ budgets: null }));
    for (const g of entry.made.groups) {
      if (!t?.groups.some((x) => x.id === g) || t.categories.some((x) => x.group === g)) continue;
      if (!budgets) continue;
      try {
        await changeTaxonomy(ctx, (cur) => deleteGroup(cur, g, budgets.groups[g] !== undefined));
      } catch (err) {
        if (!(err instanceof CategoryError)) throw err;
      }
    }
  }

  await migrationStore.remove(ctx, id);
  return result;
}

/** What undoing it would do, for the confirmation: the entry, read strictly. */
export async function migrationUndoPlan(ctx: Ctx, id: string): Promise<{ entry: MigrationEntry }> {
  const entry = await migrationStore.get(ctx, id);
  if (!entry) throw new MigrationNotFoundError();
  return { entry };
}

// ---- Listing ----

export type MigrationListed = {
  id: string;
  record: 'ok' | 'unreadable' | 'unrecognised';
  entry: MigrationEntry | null;
};

/** Every import from another app, newest first: a display read, naming what
 *  it can't read rather than failing; nothing is written on it. */
export async function listMigrations(ctx: Ctx): Promise<MigrationListed[]> {
  const report = await migrationStore.getAllReport(ctx);
  const out: MigrationListed[] = [...report.entries].map(([id, entry]) => ({ id, record: 'ok', entry }));
  for (const id of report.unreadable) out.push({ id, record: 'unreadable', entry: null });
  for (const id of report.unrecognised) out.push({ id, record: 'unrecognised', entry: null });
  return out.sort((a, b) => (b.entry?.started_at ?? '').localeCompare(a.entry?.started_at ?? ''));
}
