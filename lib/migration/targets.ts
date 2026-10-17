// lib/migration/targets.ts
//
// What a review of another app's export reads before it is planned
// (lib/migration/plan.ts MigrationState): the person's categories and tags,
// their manual and linked accounts (what the file's accounts can go into),
// and for each account chosen, what it already holds: a manual account's
// book, a linked account's bank rows, earlier imports and the bank rows kept
// as standing for their rows (lib/history-import/read.ts readAccountContext,
// its `twins`). Server only.
//
// STRICT where a wrong read would duplicate or lose a row: a book, a bank's
// store, the links an account's earlier imports are found through. One of
// those that can't be read makes its account unavailable, with why, which the
// review says (lib/migration/plan.ts blocks), never an empty account to
// import into. The categories are read as the app's own first load reads
// them (lib/category-store.ts ensureTaxonomy): a set never made is made then,
// as the Activity tab would make it, so the ids the review names are the
// stored ones the commit files under. That is the one thing a review may
// write, and only once; nothing else is written here.

import type { Ctx } from '../containers';
import { getManualAccounts, type ManualAccount } from '../manual';
import { manualTxnStore, type ManualTxnBook } from '../manual-txns';
import { ensureTaxonomy } from '../category-store';
import { readTagSet, type TagSet } from '../tags';
import { txnAnnotationStore } from '../txn-annotations';
import { splitStore } from '../splits';
import { readLinks, effectiveLinks, type Link } from '../link-core';
import { liveAccountIds } from '../links';
import { liveLinkedAccounts, readAccountContext, type AccountContext, type LinkedAccount } from '../history-import/read';
import { StateUnreadableError } from '../transactions';
import { StoredDataUnreadableError } from '../repo';
import type { MigrationState, TargetAccount } from './plan';

/** What the route hands the plan, and the accounts it offers. */
export type ReadTargets = MigrationState & {
  offered: TargetAccount[];
  /** Linked accounts that can't be offered now, and accounts chosen that
   *  can't be read, with why. */
  notes: string[];
};

/**
 * Reads the state for a plan. `manualIds` and `linkedIds` are the accounts
 * the person chose (only their books and contexts are read); `withTags` reads
 * the tags strictly (a migration bringing tags must know which exist).
 */
export async function readTargets(ctx: Ctx, opts: { manualIds: readonly string[]; linkedIds: readonly string[]; withTags: boolean; today: string }): Promise<ReadTargets> {
  const [taxonomy, manualList, live, annotations, splits] = await Promise.all([
    ensureTaxonomy(ctx),
    getManualAccounts(ctx),
    liveLinkedAccounts(ctx),
    txnAnnotationStore.count(ctx),
    splitStore.count(ctx),
  ]);
  // Strict, when the import brings tags: which exist decides which are made.
  // A list that can't be read is said (lib/migration/plan.ts blocks), so the
  // person can import without tags rather than not at all.
  let tags: TagSet | null = null;
  let tagsUnreadable = false;
  if (opts.withTags) {
    try {
      tags = await readTagSet(ctx);
    } catch (err) {
      if (!(err instanceof StoredDataUnreadableError)) throw err;
      tagsUnreadable = true;
    }
  }
  const manual = new Map<string, ManualAccount>(manualList.map((a) => [a.account_id, a]));
  const notes: string[] = [];
  if (live.unreadable.length > 0) notes.push('Some of your linked accounts can’t be read just now, so they aren’t offered here. Try again later.');

  // The links an account's earlier imports are found through: strict, as
  // history import's are (app/api/history-import), or no linked account is
  // offered.
  let links: Map<string, Link> | null = null;
  const [read, liveIds] = await Promise.all([readLinks(ctx), liveAccountIds(ctx, { strict: true, readOnly: true })]);
  if (read.unreadable.size > 0) notes.push('A saved account link can’t be read, so linked accounts aren’t offered: their earlier imports couldn’t be found. Remove it on the Accounts tab first.');
  else links = effectiveLinks(read.links, liveIds);
  const linked = new Map<string, LinkedAccount>(links ? [...live.accounts] : []);

  const books = new Map<string, ManualTxnBook | null>();
  const wanted = opts.manualIds.filter((id) => manual.has(id));
  if (wanted.length > 0) for (const [id, book] of await manualTxnStore.getMany(ctx, wanted)) books.set(id, book);
  for (const id of wanted) if (!books.has(id)) books.set(id, null);

  const contexts = new Map<string, AccountContext>();
  const unavailable = new Map<string, string>();
  for (const id of opts.linkedIds) {
    const account = linked.get(id);
    if (!account || !links) continue;
    try {
      contexts.set(id, await readAccountContext(ctx, account, links));
    } catch (err) {
      if (err instanceof StateUnreadableError) unavailable.set(id, `${account.institution_name}’s transactions for ${account.name} can’t be read just now, so this file can’t be matched against them. Try again later.`);
      // Its earlier imports' rows, or which of the bank's rows were kept as
      // standing for them (lib/history-import/twins.ts): either decides what
      // the file's rows are, so neither is guessed.
      else if (err instanceof StoredDataUnreadableError)
        unavailable.set(id, `What was imported into ${account.name} before, or which of ${account.institution_name}’s transactions stand for it, can’t be read just now, so this file can’t be matched against it.`);
      else throw err;
    }
  }

  const offered: TargetAccount[] = [
    ...manualList.map((a): TargetAccount => ({ kind: 'manual', id: a.account_id, name: a.name, institution: a.institution_name, type: a.type, currency: a.currency ?? 'USD' })),
    ...[...linked.values()].map((a): TargetAccount => ({ kind: 'linked', id: a.account_id, name: a.name, institution: a.institution_name, type: a.type, currency: a.currency, mask: a.mask })),
  ];
  return {
    today: opts.today,
    taxonomy,
    tags,
    tagsUnreadable,
    manual,
    linked,
    books,
    contexts,
    unavailable,
    counts: { annotations, splits, manual: manualList.length },
    offered,
    notes,
  };
}
