// lib/migration/commit.ts
//
// Importing another app's export once the person has reviewed it
// (lib/migration/plan.ts), undoing it in one action, and listing what was
// imported: the only part of lib/migration/ that writes. Server only.
//
// ALL OF IT, OR NONE. The commit writes the entry first (lib/migration/
// store.ts), naming everything it will make, by ids minted now: the manual
// accounts, the categories and groups, the tags, and each account's import
// (whose own entry names its rows, minted now too, which is how Undo finds
// them however far it got). Then, in order: the new manual accounts (the
// person's room for them counted again first); the categories and
// groups, in one compare-and-set that works the mapping out again on the set
// as it is and refuses unless it is the one reviewed (lib/migration/
// categories.ts applyCategoryPlan); the tags, in one; each Nya account's
// import, through that account's own commit, which matches its rows again
// against what the account holds at that moment (lib/import/commit.ts for a
// manual account; lib/history-import/commit.ts for a linked one, which also
// refuses a review that changed); and last what the rows carry beside them:
// tags (and, on a linked account's row the bank already has, or one a pending
// row of the bank will take the place of, the app's note) in what is said
// about each transaction, split transactions' parts, and on such a row the
// app's category, so the bank's row shows the person's own categorizing
// (unless the person said not to: MigrationAnswers.carry), only where it
// shows and never moving a row they approved in the review queue
// (lib/migration/plan.ts carry_to). If any step fails the import is undone,
// as Undo would undo it, and the failure answered: a file is never half
// imported. An entry left part way (the server stopped) is listed, and Undo
// finishes taking it out.
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
// commit.ts undoHistoryImport, given every id a linked account has had, as
// its own Undo is, so rows a later import made after a re-link relied on are
// handed to it); then what it made, where nothing else now uses it: a manual
// account it made that holds no rows, that the person hasn't changed since
// and no goal tracks, a tag no transaction or rule holds, a category no
// transaction, budget or rule uses (lib/category-usage.ts), a group left with
// no category and no budget, this month's or a past one's. What something
// else uses now is kept, and the answer says so.

import type { Ctx } from '../containers';
import { loggable } from '../log-safe';
import { StoredDataUnreadableError } from '../repo';
import { getManualAccount, getManualAccounts, MAX_MANUAL_ACCOUNTS, newManualId, saveManualAccount, type ManualAccount } from '../manual';
import { getGoals } from '../goals';
import { manualTxnStore } from '../manual-txns';
import { newManualTxnId } from '../manual-txn-input';
import { deleteManualAccount } from '../manual-account-delete';
import { changeTaxonomy, newCategoryId, readTaxonomy, ensureTaxonomy } from '../category-store';
import { categoryForKey, deleteCategory, deleteGroup, indexTaxonomy, TEXT, CategoryError, type CategoryUsage } from '../categories';
import { categoryUsages } from '../category-usage';
import { loadBudgets } from '../budget-store';
import { budgetMonthsStore } from '../budget-months-store';
import { groupsWithBudgets } from '../category-templates';
import { addTag, changeTagSet, markDeleted, newTagId, readTagSet, tagByName } from '../tags';
import { finishDeleting } from '../tag-delete';
import { readLinks, effectiveLinks, sameAccountIds, type Link } from '../link-core';
import { liveAccountIds } from '../links';
import { readRuleSet } from '../rules';
import { carriedAnnotationStore, txnAnnotationStore, type TxnAnnotation } from '../txn-annotations';
import { checkParts, splitStore, SPLITS_VERSION, type SplitRecord } from '../splits';
import { setOverrides } from '../overrides';
import { commitImport, ImportNotFoundError, undoImport, undoPlan } from '../import/commit';
import { newImportId } from '../import/store';
import { commitHistoryImport, historyUndoPlan, HistoryImportNotFoundError, reviewDigest, undoHistoryImport } from '../history-import/commit';
import { newHistoryImportId, newImportedTxnId } from '../history-import/store';
import type { Period } from '../history-import/plan';
import { applyCategoryPlan, CategoriesChangedError } from './categories';
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
    // The manual accounts it makes, as the Add form saves them, within the
    // room counted again now (another device may have added some since).
    if (accountIds.size > 0 && (await getManualAccounts(ctx)).length + accountIds.size > MAX_MANUAL_ACCOUNTS) throw new MigrationRoomError();
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
          twins: context.twins,
          restored: context.restored,
          choices: t.choices,
          reviewed: reviewDigest(t.linked!.review),
          ids_minted: ids,
          now,
        });
        const c = result.plan.counts;
        imported += c.new;
        duplicates += c.duplicates + c.already;
        present += c.present;
        if (result.import_id) {
          kept = result.plan.actions.flatMap((a, i): { i: number; duplicate: boolean }[] => (a === 'add' ? [{ i, duplicate: false }] : a === 'duplicate' ? [{ i, duplicate: true }] : []));
          const type = state.linked.get(account_id)?.type ?? 'other';
          linked.push({ account_id, type, dates: kept.filter((k) => !k.duplicate).map((k) => t.rows[k.i].row.date) });
        }
      }
      for (const { i, duplicate } of kept) {
        // A row its bank has, or one a pending row of the bank will take the
        // place of once it posts (lib/migration/plan.ts onto_pending): what
        // the app said of it shows on the bank's row, so it is said only when
        // the person keeps that on, and only where it shows (carry_to): never
        // on a row standing for one a file imported before brought, which
        // keeps what it has; and on one whose bank row the person approved in
        // the review queue, its tags and note, never what would move it from
        // where they approved it (its category, its split).
        const stands = duplicate || t.onto_pending.has(i);
        const to = stands ? t.carry_to.get(i) : undefined;
        if (stands && (!answers.carry || to === undefined || to === 'earlier')) continue;
        const refiles = !stands || to === 'bank';
        const id = ids.rows[i];
        const row = t.rows[i].row;
        const tags = (t.tags.get(i) ?? []).map((n) => tagOf.get(n.toLowerCase())).filter((x): x is string => !!x);
        // On a row the bank has, the note is said beside it, so the bank's
        // row shows it (lib/txn-layers.ts); else it is the row's own.
        const note = stands && row.note ? row.note : undefined;
        if (tags.length > 0 || note) annotations.push([id, { ...(tags.length > 0 ? { tags: [...new Set(tags)] } : {}), ...(note ? { note } : {}), updated_at: at }]);
        if (stands && refiles && row.category) overrides.set(id, row.category);
        const parts = refiles ? t.parts.get(i) : undefined;
        if (parts) {
          const checked = checkParts(
            parts.map((p) => {
              // Gone since the review (deleted on another device): reviewed again.
              const c = categoryForKey(ix, TEXT, p.text);
              if (!c) throw new CategoriesChangedError();
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
      // The file's lines that couldn't be read, each once: those of no
      // account are in every account's import.
      unreadable: plan.problems.length + plan.targets.reduce((n, t) => n + t.own_problems.length, 0),
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

/** The manual accounts the import would make are more than the person has
 *  room for now (another device added some since the review). */
export class MigrationRoomError extends Error {
  constructor() {
    super(`You have no room for the manual accounts this import would make (Nya keeps at most ${MAX_MANUAL_ACCOUNTS}), so nothing was imported. Review it again.`);
    this.name = 'MigrationRoomError';
  }
}

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
  accounts: { removed: string[]; kept: { name: string; why: KeptWhy }[] };
  categories: { removed: number; kept: number };
  tags: { removed: number; kept: number };
  /** The days of the rows each linked account lost. */
  linked: { account_id: string; type: string; dates: string[] }[];
};

/** The links that apply now, read strictly, for undoing a linked account's
 *  import with every id it has had (lib/link-core.ts sameAccountIds). */
async function linksNow(ctx: Ctx): Promise<Map<string, Link>> {
  const [read, live] = await Promise.all([readLinks(ctx), liveAccountIds(ctx, { strict: true, readOnly: true })]);
  if (read.unreadable.size > 0) throw new MigrationLinksUnreadableError();
  return effectiveLinks(read.links, live);
}

/** A saved account link can't be read, so a linked account's earlier ids,
 *  and the later imports that relied on its rows, can't be told: refused
 *  rather than undone without them. */
export class MigrationLinksUnreadableError extends Error {
  constructor() {
    super('A saved account link can’t be read, so the imports that rely on this one’s transactions can’t all be found. Remove it in Settings, Connections first, then undo.');
    this.name = 'MigrationLinksUnreadableError';
  }
}

/** Why a manual account the import made stays when it is undone. */
export type KeptWhy = 'transactions' | 'changed' | 'goal';

/**
 * Takes an import from another app out (see the header). Undoing again after
 * an undo that stopped part way finishes it. Throws MigrationNotFoundError
 * when there is no such import, UnreadableEntriesError when its entry can't
 * be read (each account's import is still listed with Undo on that account),
 * MigrationLinksUnreadableError when a linked account's links can't be, and
 * what an account's undo throws.
 */
export async function undoMigration(ctx: Ctx, id: string, opts: { failed?: boolean; now?: number } = {}): Promise<MigrationUndoResult> {
  const entry = await migrationStore.get(ctx, id);
  if (!entry) throw new MigrationNotFoundError();
  // One still being made is left to finish (or to take itself out, when it
  // fails: `failed`), unless it has gone quiet for longer than any import
  // takes, so it stopped part way.
  if (!opts.failed && entry.status === 'importing' && (opts.now ?? Date.now()) - Date.parse(entry.started_at) < STILL_IMPORTING_MS) throw new MigrationBusyError();
  const links = entry.imports.some((i) => i.kind === 'linked') ? await linksNow(ctx) : new Map<string, Link>();
  if (entry.status !== 'undoing') await migrationStore.update(ctx, id, (cur) => (cur ? { ...cur, status: 'undoing' } : cur));
  const result: MigrationUndoResult = { removed: 0, duplicates: 0, kept: 0, accounts: { removed: [], kept: [] }, categories: { removed: 0, kept: 0 }, tags: { removed: 0, kept: 0 }, linked: [] };

  for (const imp of entry.imports) {
    try {
      if (imp.kind === 'manual') {
        const u = await undoImport(ctx, imp.account_id, imp.import_id);
        result.removed += u.removed;
        result.kept += u.kept;
      } else {
        // Every id the account has had, as its own Undo passes them: a later
        // import made under its new id after a re-link may rely on these rows.
        const u = await undoHistoryImport(ctx, sameAccountIds(imp.account_id, links), imp.import_id);
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

  // The manual accounts it made, when they hold nothing now, the person
  // hasn't changed them since (a balance typed, a name) and no goal tracks
  // them. Goals that can't be read could track any: those stay.
  if (entry.made.accounts.length > 0) {
    const goals = await getGoals(ctx).then(
      (g) => g,
      (err) => {
        if (err instanceof StoredDataUnreadableError) return null;
        throw err;
      }
    );
    for (const a of entry.made.accounts) {
      const account = await getManualAccount(ctx, a.id);
      if (!account) continue;
      const book = await manualTxnStore.get(ctx, a.id);
      // The import saved it stamped with its own start: another stamp is a
      // change the person made since.
      const why: KeptWhy | null =
        book && book.rows.length > 0 ? 'transactions' : account.updated_at !== entry.started_at ? 'changed' : !goals || goals.some((g) => g.account_id === a.id) ? 'goal' : null;
      if (why) {
        result.accounts.kept.push({ name: a.name, why });
        continue;
      }
      await deleteManualAccount(ctx, a.id);
      result.accounts.removed.push(a.name);
    }
  }

  // The tags it made, when nothing holds them now: no transaction's record,
  // carried record or rule. One that can't be read could hold any: they stay.
  // The rest are deleted together, as one deletion (lib/tag-delete.ts): one
  // sweep of what is said about transactions, however many there are.
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
      const doomed = there.filter((t) => sure && !held.has(t));
      result.tags.kept += there.length - doomed.length;
      if (doomed.length > 0) {
        // Deleted meanwhile (another undo, the Tags screen): gone either way.
        const marked = await changeTagSet(ctx, (s) => doomed.reduce((acc, t) => (acc.tags.some((x) => x.id === t) ? markDeleted(acc, t) : acc), s));
        await finishDeleting(ctx, marked);
        result.tags.removed += doomed.length;
      }
    }
  }

  // The categories it made, when nothing uses them now (lib/category-usage.ts,
  // read once for them all, strictly: one it can't be sure of stays), then
  // its groups left empty, with no budget now or in a past month.
  const t0 = entry.made.categories.length > 0 ? await readTaxonomy(ctx) : null;
  const present = t0 ? entry.made.categories.filter((c) => t0.categories.some((x) => x.id === c)) : [];
  if (t0 && present.length > 0) {
    let usages: Map<string, CategoryUsage> | null = null;
    try {
      usages = await categoryUsages(ctx, t0, present);
    } catch (err) {
      if (!(err instanceof StoredDataUnreadableError)) throw err;
    }
    for (const c of present) {
      const usage = usages?.get(c);
      if (!usage) {
        result.categories.kept++;
        continue;
      }
      try {
        await changeTaxonomy(ctx, (cur) => deleteCategory(cur, c, usage));
        result.categories.removed++;
      } catch (err) {
        // In use now, changed meanwhile, or the set can't be read: kept.
        // Anything else stops the undo, which can be run again, rather than
        // leave a category nothing says was made here.
        if (!(err instanceof CategoryError) && !(err instanceof StoredDataUnreadableError)) throw err;
        result.categories.kept++;
      }
    }
  }
  if (entry.made.groups.length > 0) {
    const t = await readTaxonomy(ctx);
    const [{ budgets }, months] = await Promise.all([
      loadBudgets(ctx).catch(() => ({ budgets: null })),
      budgetMonthsStore.get(ctx).then(
        (m) => ({ ok: true as const, m }),
        () => ({ ok: false as const, m: null })
      ),
    ]);
    // A past month's budget for a group can't be told from nothing when the
    // record of them can't be read: then every group stays.
    const budgeted = months.ok ? groupsWithBudgets(months.m) : null;
    for (const g of entry.made.groups) {
      if (!t?.groups.some((x) => x.id === g) || t.categories.some((x) => x.group === g)) continue;
      if (!budgets || !budgeted) continue;
      try {
        await changeTaxonomy(ctx, (cur) => deleteGroup(cur, g, budgets.groups[g] !== undefined || budgeted.has(g)));
      } catch (err) {
        if (!(err instanceof CategoryError)) throw err;
      }
    }
  }

  await migrationStore.remove(ctx, id);
  return result;
}

/** What Undo would take out, for its confirmation: each account's import as
 *  that account's own Undo would say it (lib/import/commit.ts undoPlan,
 *  lib/history-import/commit.ts historyUndoPlan), added up. */
export type MigrationUndoPreview = {
  entry: MigrationEntry;
  /** Rows that go, how many of them were changed since or are on another
   *  account now (a manual account's), the duplicates of a linked account's
   *  bank rows that go with them, and rows a later import relied on, kept
   *  for it, by that import's file. */
  remove: number;
  edited: number;
  moved: number;
  duplicates: number;
  restore: number;
  kept: { file_name: string | null; count: number }[];
  /** Some account's transactions can't be read: any of its there stay. */
  incomplete: boolean;
};

/** What undoing it would do, changing nothing: the entry, read strictly,
 *  and what each account's import would lose. */
export async function migrationUndoPlan(ctx: Ctx, id: string): Promise<MigrationUndoPreview> {
  const entry = await migrationStore.get(ctx, id);
  if (!entry) throw new MigrationNotFoundError();
  const links = entry.imports.some((i) => i.kind === 'linked') ? await linksNow(ctx) : new Map<string, Link>();
  const out: MigrationUndoPreview = { entry, remove: 0, edited: 0, moved: 0, duplicates: 0, restore: 0, kept: [], incomplete: false };
  for (const imp of entry.imports) {
    try {
      if (imp.kind === 'manual') {
        const p = await undoPlan(ctx, imp.account_id, imp.import_id);
        out.remove += p.remove;
        out.edited += p.edited;
        out.moved += p.moved;
        out.restore += p.restore;
        out.kept.push(...p.kept.map((k) => ({ file_name: k.file_name, count: k.count })));
        out.incomplete ||= p.incomplete;
      } else {
        const p = await historyUndoPlan(ctx, sameAccountIds(imp.account_id, links), imp.import_id);
        out.remove += p.remove;
        out.duplicates += p.duplicates;
        out.kept.push(...p.kept.map((k) => ({ file_name: k.file_name, count: k.count })));
        out.incomplete ||= p.incomplete;
      }
    } catch (err) {
      if (err instanceof ImportNotFoundError || err instanceof HistoryImportNotFoundError) continue;
      throw err;
    }
  }
  return out;
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
