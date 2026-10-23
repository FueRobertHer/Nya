// lib/migration/targets.ts
//
// What a review of another app's export reads before it is planned
// (lib/migration/plan.ts MigrationState): the person's categories and tags,
// their manual and linked accounts (what the file's accounts can go into),
// and for each account chosen, what it already holds: a manual account's
// book, a linked account's bank rows, earlier imports and the bank rows kept
// as standing for their rows (lib/history-import/read.ts readAccountContext,
// its `twins`), and which of its bank rows the person approved in the review
// queue (MigrationState reach). Server only.
//
// STRICT where a wrong read would duplicate or lose a row: a book, a bank's
// store, the links an account's earlier imports are found through. One of
// those that can't be read makes its account unavailable, with why, which the
// review says (lib/migration/plan.ts blocks), never an empty account to
// import into. An approval that can't be read counts as one, so a row the
// person may have approved is never moved by the app's category. The
// categories are read as the app's own first load reads them
// (lib/category-store.ts ensureTaxonomy): a set never made is made then, as
// the Activity tab would make it, so the ids the review names are the stored
// ones the commit files under. That is the one thing a review may write, and
// only once; nothing else is written here.

import type { Ctx } from '../containers';
import { getManualAccounts, type ManualAccount } from '../manual';
import { manualTxnStore, type ManualTxnBook } from '../manual-txns';
import { ensureTaxonomy } from '../category-store';
import { readTagSet, type TagSet } from '../tags';
import { txnAnnotationStore } from '../txn-annotations';
import { splitStore } from '../splits';
import { readLinks, effectiveLinks, type Link } from '../link-core';
import { liveAccountIds } from '../links';
import { liveLinkedAccounts, readAccountContext, standsFor, type AccountContext, type LinkedAccount } from '../history-import/read';
import { settle } from '../history-import/match';
import { readApprovalsForDisplay } from '../review-store';
import { StateUnreadableError } from '../transactions';
import { StoredDataUnreadableError } from '../repo';
import { effectiveLifecycle, endOf, lifecycleOf, lifecycleStore } from '../lifecycle';
import { loggable } from '../log-safe';
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
  if (read.unreadable.size > 0) notes.push('A saved account link can’t be read, so linked accounts aren’t offered: their earlier imports couldn’t be found. Remove it in Settings, Connections first.');
  else links = effectiveLinks(read.links, liveIds);
  const linked = new Map<string, LinkedAccount>(links ? [...live.accounts] : []);

  const books = new Map<string, ManualTxnBook | null>();
  const wanted = opts.manualIds.filter((id) => manual.has(id));
  if (wanted.length > 0) for (const [id, book] of await manualTxnStore.getMany(ctx, wanted)) books.set(id, book);
  for (const id of wanted) if (!books.has(id)) books.set(id, null);

  const contexts = new Map<string, AccountContext>();
  const unavailable = new Map<string, string>();
  // The chosen linked accounts that ended, for the review's words only: read
  // leniently, as the history import's route reads them (whatever counts the
  // rows reads the ends strictly, and leaves out those from an end on).
  const ends = new Map<string, { state: string; day: string }>();
  if (links && opts.linkedIds.length > 0) {
    try {
      const view = effectiveLifecycle((await lifecycleStore.getAllReport(ctx)).entries, links);
      for (const id of opts.linkedIds) {
        const l = lifecycleOf(view, id)?.lifecycle;
        const day = l && l.state !== 'active' ? endOf(l) : null;
        if (l && day) ends.set(id, { state: l.state, day });
      }
    } catch (err) {
      console.warn('migration: the accounts’ ends could not be read for the review', loggable(err));
    }
  }
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

  // Where what the app said of a row a linked account already has would
  // show (lib/migration/plan.ts carry_to): the posted bank row each kept row
  // stands for, as the read layer works it out (lib/history-import/read.ts
  // standsFor), and the bank rows that hold an approval in the review queue,
  // found where the read layer finds one (lib/review-layer.ts approvalFor):
  // a posted row's under its own id, the pending one's it replaced, or that
  // of a row imported from a file it stands for; a pending row's under its
  // own, which the posted one that replaces it has from it.
  const reach = new Map<string, { leads: Map<string, string>; approved: Set<string> }>();
  if (contexts.size > 0) {
    const leadsOf = new Map<string, Map<string, string>>();
    const wanted = new Set<string>();
    for (const [id, c] of contexts) {
      const leads = standsFor(settle(c.held, c.banks, c.order, { bankFrom: c.bank_from, covers: c.covers, twins: c.twins }));
      leadsOf.set(id, leads);
      for (const b of c.banks) {
        wanted.add(b.transaction_id);
        const from = b.pending ? undefined : c.pending_from.get(b.transaction_id);
        if (from) wanted.add(from);
      }
      for (const rowId of leads.keys()) wanted.add(rowId);
    }
    const read = await readApprovalsForDisplay(ctx, wanted);
    const holds = (txnId: string | undefined) => txnId !== undefined && (read.approvals.has(txnId) || read.unknown.has(txnId));
    for (const [id, c] of contexts) {
      const leads = leadsOf.get(id)!;
      const approved = new Set<string>();
      for (const b of c.banks) if (holds(b.transaction_id) || (!b.pending && holds(c.pending_from.get(b.transaction_id)))) approved.add(b.transaction_id);
      for (const [rowId, bankId] of leads) if (holds(rowId)) approved.add(bankId);
      reach.set(id, { leads, approved });
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
    reach,
    ends,
    counts: { annotations, splits, manual: manualList.length },
    offered,
    notes,
  };
}
