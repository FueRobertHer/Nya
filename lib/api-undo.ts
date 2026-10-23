// lib/api-undo.ts
//
// Undoing a change made with an API token (lib/api-changes.ts): from the app,
// where the person may undo any of them (app/api/api-changes), and through
// the API and the MCP server, where a token that can write may undo its own
// alone (POST /api/v1/changes/{id}/undo, undo_change). Each undo is the
// change made backwards, through the same functions the change went through,
// and only while what it changed is exactly as the change left it: anything
// changed since, in the app or by another program, refuses the undo (409,
// naming it), and the person changes it back themselves. An undo is a change
// of its own in the record (`undoes`); the change undone gets `undone_by`,
// and asked again, the undo answers the same. An undo isn't undone: make the
// change again.
//
//   transaction created   deleted, unless split or put in a group since
//   transaction changed   its own fields set back, or what is said beside it
//                         (excluded, tags) put back exactly as it was
//   transaction deleted   added back as it was, same id, with what was said
//                         about it, while its account is there and the id is
//                         nowhere
//   account created       while it and every row on it are exactly as this
//                         token's changes left them (their versions), every
//                         row on it was made by this token, nothing was said
//                         about a row but what the token said, no row is split
//                         or grouped, and the account isn't hidden, marked
//                         closed, tracked by a goal, linked, named by a rule,
//                         a note on the timeline, an allocation setting or a
//                         recurring series marked not recurring, or shared on
//                         a connection: every check under the links lock,
//                         just before the first write. Then its
//                         rows and the account go (the app's own delete), and
//                         its balance on every day recorded since, folded out
//                         of each total as the app's forget of a hidden
//                         account does (lib/links.ts forgetEarlierAccount
//                         refuses a manual id, so its steps are taken here), so
//                         past totals read as though it never was. Each step's
//                         name is written on the undo before the step, so an
//                         undo cut off part way is taken up again where it
//                         stopped by the next undo asked
//   account changed       its details set back
//   balance set           set back, if it still holds what was set; a day
//                         recorded since keeps its point (today's is written
//                         again by the next recording the same UTC day)
//   category, group made  deleted through the app's own delete, while unused
//   category, group changed  set back
//   tag made              deleted, while no transaction or rule carries it
//   tag changed           set back

import type { Ctx } from './containers';
import type { Authenticated } from './api-tokens';
import { hintOf } from './api-tokens';
import { ApiFailure } from './api-spec';
import { checkDay, countDay } from './api-run';
import { beginChange, changeIds, changeStore, getChange, newChangeId, settleChange, tokenRef, type Change, type ChangeOp } from './api-changes';
import { accountVersion, categoryVersion, groupVersion, rowVersion, saidVersion, tagVersion } from './api-versions';
import type { ResourceAnswer, ResourceInput } from './api-writes';
import { getManualAccount, type ManualAccount } from './manual';
import { AccountEditRefused, invalidate, saveAccountEdit, setAccountBalance } from './manual-account-writes';
import { deleteManualAccount } from './manual-account-delete';
import { addManualTxn, findManualTxn, manualTxnStore, type ManualTxn } from './manual-txns';
import { changeManualTransaction, removeManualTransaction } from './manual-txn-writes';
import { restoreAnnotation, txnAnnotationStore, type TxnAnnotation } from './txn-annotations';
import { splitStore } from './splits';
import { groupStore, memberIndex } from './groups';
import { readTaxonomy } from './category-store';
import { CategoryError, type Category, type CategoryGroup } from './categories';
import { deleteCategoryNow, deleteGroupNow, editCategory, editGroup } from './category-actions';
import { readTagSet, TagError, type Tag } from './tags';
import { deleteTag, finishDeleting } from './tag-delete';
import { editTag } from './tag-actions';
import { rulesStore } from './rules';
import { getHiddenAccounts, markForgetting, setAccountHidden } from './hidden';
import { dropFoldProgress, foldHiddenAccount, forgetAccountBalances } from './history';
import { ForgetRefused, withLinksLock } from './links';
import { readLinks } from './link-core';
import { lifecycleStore } from './lifecycle';
import { getGoals } from './goals';
import { timelineNotesStore } from './timeline-notes';
import { allocationSettingsStore } from './allocation-settings';
import { plannedStore } from './planned-store';
import { ownerSharesAccount } from './sharing';
import { normalizeInstitutionName } from './manual';

const refuse = (message: string): never => {
  throw new ApiFailure(409, 'conflict', message);
};
const NOT_RECORDED = 'What this change made wasn’t recorded (it was finished when it was sent again), so it can’t be undone here: change it in the app.';
const CHANGED = (what: string) => `${what} changed since this change was made, so it wasn’t undone. Change it back yourself if you want it as it was.`;
const NOT_REMOVED = (why: string) => `${why}, so the account wasn’t removed: remove it in the app if you want it gone.`;

/** Whether two stored states are the same, field for field. */
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type TxnState = { row: ManualTxn; said: TxnAnnotation | null };

/** What an undo did: the target as it was before the undo and after. */
type Undone = { before: unknown; after: unknown };

/** The steps of an undo that may be cut off part way, each named on the
 *  undo before it is taken (Change.progress). */
type Step = NonNullable<Change['progress']>;

/**
 * One undo as it runs: whether it takes up one cut off part way (`resume`,
 * with the step it had reached), and whether it has written anything yet,
 * in this run or the one cut off (`began`): a refusal before that leaves
 * nothing to record, one after it is recorded as the failure it is.
 */
type Run = { resume: boolean; began: boolean; progress: Step | undefined; step: (s: Step) => Promise<void> };

/** The app's own refusal, in the API's shape. */
function refusalOf(err: unknown): unknown {
  if (err instanceof CategoryError || err instanceof TagError || err instanceof ForgetRefused) return new ApiFailure(409, 'conflict', err.message);
  if (err instanceof AccountEditRefused) return new ApiFailure(409, 'conflict', `${err.message}, so it wasn’t undone.`);
  return err;
}

async function undoTransaction(ctx: Ctx, c: Change, now: number, run: Run): Promise<Undone> {
  const id = c.target.id;
  const after = c.after as TxnState | null;
  const before = c.before as TxnState | null;
  const found = await findManualTxn(ctx, id);
  const said = await txnAnnotationStore.get(ctx, id);
  if (c.op === 'transaction.create') {
    if (!found || !same(found.row, after!.row) || !same(said, after!.said)) refuse(CHANGED('The transaction'));
    if ((await splitStore.has(ctx, id)) || memberIndex(await groupStore.getAll(ctx)).has(id)) refuse(CHANGED('The transaction'));
    const gone = await removeManualTransaction(ctx, id, found!.account_id, { expect: (row) => (same(row, after!.row) ? undefined : refuse(CHANGED('The transaction'))) });
    if (!gone) refuse(CHANGED('The transaction'));
    return { before: { row: found!.row, said }, after: null };
  }
  if (c.op === 'transaction.delete') {
    // Every check before the first write: the row added back first, then
    // what was said about it, which must still be absent (or as the delete
    // left it), or the undo would stop between the two.
    if (found) refuse('A transaction with its id is there again, so it wasn’t added back.');
    if (said !== null && !same(said, before!.said)) refuse(CHANGED('What was said about it'));
    if (!(await getManualAccount(ctx, before!.row.account_id))) refuse('Its account no longer exists, so it wasn’t added back.');
    const { added } = await addManualTxn(ctx, before!.row);
    if (!added) refuse('A transaction with its id is there again, so it wasn’t added back.');
    run.began = true;
    if (before!.said && said === null) await restoreAnnotation(ctx, id, before!.said, (cur) => (cur === null ? undefined : refuse(CHANGED('What was said about it'))));
    return { before: null, after: before };
  }
  // Changed: its row, or what is said beside it, whichever the change moved.
  if (!found || !same(found.row, after!.row) || !same(said, after!.said)) refuse(CHANGED('The transaction'));
  if (!same(before!.row, after!.row)) {
    const b = before!.row;
    const done = await changeManualTransaction(
      ctx,
      id,
      { date: b.date, amount: b.amount, currency: b.currency, name: b.name, category: b.category, note: b.note, account_id: b.account_id },
      {
        from: found!.account_id,
        ...(b.account_id !== found!.account_id ? { target: (await getManualAccount(ctx, b.account_id)) ?? refuse('The account it was on no longer exists, so it wasn’t moved back.') } : {}),
        now: new Date(now),
        expect: (row) => (same(row, after!.row) ? undefined : refuse(CHANGED('The transaction'))),
      }
    );
    if (done === 'gone' || done === 'account-gone') refuse(CHANGED('The transaction'));
    return { before: after, after: { row: (done as { saved: ManualTxn }).saved, said } };
  }
  await restoreAnnotation(ctx, id, before!.said, (cur) => (same(cur, after!.said) ? undefined : refuse(CHANGED('What was said about it'))));
  return { before: after, after: { row: found!.row, said: before!.said } };
}

/** This token's changes in the window, done and not undone since, oldest
 *  first: the state they left is what an account it made must still be in. */
async function standingChanges(ctx: Ctx, maker: string): Promise<Change[]> {
  const ids = await changeIds(ctx, { maker });
  const out: Change[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    for (const c of (await changeStore.getMany(ctx, ids.slice(i, i + 500))).values()) {
      if (c.state === 'done' && !c.undone_by && c.op !== 'undo' && !c.forgotten_at) out.push(c);
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The last of these changes: those made at the last moment any was (two
 *  in the same millisecond can't be told apart, so either is last). */
function lastOf(changes: Change[]): Change[] {
  const at = changes.at(-1)?.at;
  return at === undefined ? [] : changes.filter((x) => x.at === at);
}

/**
 * Refuses, saying what blocks it, unless the account `c` made, and every row
 * on it, are exactly as this token's changes left them, and nothing else
 * names it (see the header). Every read is strict: what can't be read can't
 * be told apart from something the person did.
 */
async function checkUntouched(ctx: Ctx, c: Change, cur: ManualAccount): Promise<void> {
  const id = c.target.id;
  const mine = await standingChanges(ctx, c.token!.ref);
  // The account: its details as the token's last create or change of them
  // left them, and its balance as the last of those or of its balances.
  const onAccount = mine.filter((x) => x.target.kind === 'manual-account' && x.target.id === id);
  const details = lastOf(onAccount.filter((x) => x.op === 'manual-account.create' || x.op === 'manual-account.update'));
  const balances = lastOf(onAccount.filter((x) => x.after !== null && typeof (x.after as { balance?: unknown }).balance === 'number'));
  if (!details.some((x) => accountVersion(cur) === accountVersion(x.after as ManualAccount))) refuse(CHANGED('The account'));
  if (!balances.some((x) => Math.round(cur.balance * 100) === Math.round((x.after as { balance: number }).balance * 100))) refuse(CHANGED('The account’s balance'));

  if ((await getHiddenAccounts(ctx)).has(id)) refuse(NOT_REMOVED('The account was hidden since'));
  if (await lifecycleStore.has(ctx, id)) refuse(NOT_REMOVED('The account was marked closed since'));
  if ((await getGoals(ctx)).some((g) => g.account_id === id)) refuse(NOT_REMOVED('A goal tracks the account'));
  const { links, unreadable } = await readLinks(ctx);
  if (unreadable.size > 0) refuse(NOT_REMOVED('A saved link between accounts can’t be read'));
  if (links.has(id) || [...links.values()].some((l) => l.to === id)) refuse(NOT_REMOVED('The account is linked to another'));
  if ((await rulesStore.get(ctx))?.rules.some((r) => r.conditions.some((k) => k.field === 'account' && k.value === id))) refuse(NOT_REMOVED('A rule names the account'));
  if ([...(await timelineNotesStore.getAll(ctx)).values()].some((n) => n.account_id === id)) refuse(NOT_REMOVED('A note on the timeline is about the account'));
  const allocation = await allocationSettingsStore.get(ctx);
  if (allocation && [...allocation.buckets, ...allocation.accounts].some((s) => s.account_id === id)) refuse(NOT_REMOVED('A tax bucket or split on the Plan tab is set for the account'));
  if (await ownerSharesAccount(ctx, id)) refuse(NOT_REMOVED('The account is shared with someone you’re connected with'));
  // A detected series is named by its kind, then the institution and account
  // its rows are shown under (lib/recurring.ts groupOf), compared as the
  // Accounts tab groups institutions: without case.
  const under = `|${normalizeInstitutionName(cur.institution_name) || 'Manual'}|${cur.name}|`.toLowerCase();
  const names = (d: string) => d.indexOf('|') > 0 && d.slice(d.indexOf('|')).toLowerCase().startsWith(under);
  if ((await plannedStore.get(ctx))?.dismissed.some(names)) {
    refuse(NOT_REMOVED('A recurring series on the account was marked not recurring'));
  }

  // Every row: made by this token, as its last change of it left it, row and
  // what is said beside it, and neither split nor in a group.
  const rows = (await manualTxnStore.get(ctx, id))?.rows ?? [];
  if (rows.length === 0) return;
  const said = await txnAnnotationStore.getMany(
    ctx,
    rows.map((r) => r.id)
  );
  const grouped = memberIndex(await groupStore.getAll(ctx));
  for (const row of rows) {
    const onRow = mine.filter((x) => x.target.kind === 'transaction' && x.target.id === row.id);
    if (!onRow.some((x) => x.op === 'transaction.create')) refuse(NOT_REMOVED(`A transaction on it (${row.id}) was added since in another way`));
    const left = lastOf(onRow.filter((x) => x.op === 'transaction.create' || x.op === 'transaction.update')).map((x) => x.after as TxnState | null);
    const as = (s: TxnState | null) => !!s && rowVersion(row) === rowVersion(s.row) && saidVersion(said.get(row.id) ?? null) === saidVersion(s.said);
    if (!left.some(as)) {
      refuse(NOT_REMOVED(`A transaction on it (${row.id}) was changed since in another way, or something was said about it`));
    }
    if ((await splitStore.has(ctx, row.id)) || grouped.has(row.id)) refuse(NOT_REMOVED(`A transaction on it (${row.id}) was split or put in a group since`));
  }
}

async function undoAccount(ctx: Ctx, c: Change, now: number, run: Run): Promise<Undone> {
  if (c.op === 'manual-account.create') return undoAccountMade(ctx, c, now, run);
  const id = c.target.id;
  const current = await getManualAccount(ctx, id);
  if (!current) refuse('The account no longer exists.');
  const cur = current!;
  if (c.op === 'manual-account.balance') {
    const after = c.after as { balance: number };
    const before = c.before as { balance: number };
    const cents = (n: number) => Math.round(n * 100);
    // Still what was set, checked in the step that sets it back.
    const set = await setAccountBalance(ctx, id, before.balance, {
      now: new Date(now),
      expect: (acct) => (cents(acct.balance) === cents(after.balance) ? undefined : refuse(CHANGED('Its balance'))),
    });
    if (set.kind === 'missing') refuse('The account no longer exists.');
    return { before: { balance: cur.balance, updated_at: cur.updated_at }, after: set.kind === 'set' ? { balance: set.account.balance, updated_at: set.account.updated_at } : null };
  }
  const after = c.after as ManualAccount;
  const before = c.before as ManualAccount;
  if (accountVersion(cur) !== accountVersion(after)) refuse(CHANGED('The account'));
  const saved = await saveAccountEdit(
    ctx,
    id,
    { fields: { name: before.name, institution_name: before.institution_name, type: before.type, subtype: before.subtype } },
    { now: new Date(now), check: (now) => (accountVersion(now) === accountVersion(after) ? undefined : refuse(CHANGED('The account'))) }
  );
  if (!saved) refuse('The account no longer exists.');
  return { before: saved!.before, after: saved!.account };
}

/**
 * An account this token made, taken out whole (see the header), under the
 * links lock from its first check to its last write. Its steps, each named on
 * the undo before it is taken, so the next undo asked takes one cut off part
 * way up where it stopped:
 *
 *   deleting    its rows and the account, through the app's own delete;
 *   folding     hidden, and its balance folded out of each recorded total,
 *               point by point (foldHiddenAccount), the fold's progress kept
 *               under the hidden entry's tag;
 *   forgetting  shown again, as it no longer exists, and its balances removed
 *               from every per-account layer.
 *
 * Deleted before it is folded, so no recording can write it again into a day
 * the fold has passed.
 */
async function undoAccountMade(ctx: Ctx, c: Change, now: number, run: Run): Promise<Undone> {
  const id = c.target.id;
  const life = { first: c.at.slice(0, 10), last: new Date(now).toISOString().slice(0, 10) };
  return withLinksLock(ctx, async () => {
    const cur = await getManualAccount(ctx, id);
    const reached = run.resume ? run.progress : undefined;
    if (cur) {
      // There: nothing of it was taken out yet (a resume that hadn't got past
      // its delete is checked again too, as nothing was written).
      await checkUntouched(ctx, c, cur);
      await run.step('deleting');
      await deleteManualAccount(ctx, id);
      run.began = true;
      await invalidate(ctx, true);
    } else if (!reached) {
      refuse('The account no longer exists.');
    } else {
      run.began = true; // deleted by the undo cut off
    }
    const type = cur?.type ?? (c.after as ManualAccount).type;
    if (reached !== 'forgetting') {
      await run.step('folding');
      await setAccountHidden(ctx, id, type, true);
      const entry = (await getHiddenAccounts(ctx)).get(id);
      if (!entry) throw new Error('The account could not be hidden to take it out of past totals.');
      const tag = entry.forget_tag ?? crypto.randomUUID();
      if (!entry.forget_tag) await markForgetting(ctx, id, entry, tag);
      await foldHiddenAccount(ctx, id, type, tag, life);
      await dropFoldProgress(ctx, tag);
    }
    await run.step('forgetting');
    await setAccountHidden(ctx, id, '', false);
    await forgetAccountBalances(ctx, id);
    await forgetAccountBalances(ctx, id, { today: true });
    await invalidate(ctx, true);
    return { before: cur ?? c.after, after: null };
  });
}

async function undoCategory(ctx: Ctx, c: Change): Promise<Undone> {
  const id = c.target.id;
  const t = await readTaxonomy(ctx);
  if (c.target.kind === 'group') {
    const g = t?.groups.find((x) => x.id === id);
    const after = (c.after as { group: CategoryGroup }).group;
    if (!g || groupVersion(g) !== groupVersion(after)) refuse(CHANGED('The group'));
    const check = (now: CategoryGroup | null) => (now && groupVersion(now) === groupVersion(after) ? undefined : refuse(CHANGED('The group')));
    if (c.op === 'group.create') {
      await deleteGroupNow(ctx, id, check);
      return { before: { group: g }, after: null };
    }
    const before = (c.before as { group: CategoryGroup }).group;
    const next = await editGroup(ctx, id, before.name, check);
    return { before: { group: g }, after: { group: next.groups.find((x) => x.id === id) ?? null } };
  }
  const cat = t?.categories.find((x) => x.id === id);
  const after = (c.after as { category: Category }).category;
  if (!cat || categoryVersion(cat) !== categoryVersion(after)) refuse(CHANGED('The category'));
  const check = (now: Category | null) => (now && categoryVersion(now) === categoryVersion(after) ? undefined : refuse(CHANGED('The category')));
  if (c.op === 'category.create') {
    await deleteCategoryNow(ctx, id, check);
    return { before: { category: cat }, after: null };
  }
  const before = (c.before as { category: Category }).category;
  const next = await editCategory(ctx, id, { name: before.name, group: before.group, icon: before.icon ?? '', archived: before.archived === true }, check);
  return { before: { category: cat }, after: { category: next.categories.find((x) => x.id === id) ?? null } };
}

async function undoTag(ctx: Ctx, c: Change): Promise<Undone> {
  const id = c.target.id;
  await finishDeleting(ctx);
  const tag = (await readTagSet(ctx))?.tags.find((x) => x.id === id);
  const after = (c.after as { tag: Tag }).tag;
  if (!tag || tagVersion(tag) !== tagVersion(after)) refuse(CHANGED('The tag'));
  if (c.op === 'tag.create') {
    // Read strictly: a tag on a record that can't be read can't be told
    // apart from one on nothing.
    const carried = [...(await txnAnnotationStore.getAll(ctx)).values()].some((r) => r.tags?.includes(id) || r.untagged?.includes(id));
    const rules = (await rulesStore.get(ctx))?.rules.some((r) => r.actions.add_tags?.includes(id)) ?? false;
    if (carried || rules) refuse('The tag is on a transaction or in a rule now, so it wasn’t deleted: delete it in the app, which takes it off them.');
    await deleteTag(ctx, id);
    return { before: { tag }, after: null };
  }
  const before = (c.before as { tag: Tag }).tag;
  const set = await editTag(ctx, id, { name: before.name, color: before.color }, (now) => (now && tagVersion(now) === tagVersion(after) ? undefined : refuse(CHANGED('The tag'))));
  return { before: { tag }, after: { tag: set.tags.find((x) => x.id === id) ?? null } };
}

/** The change, made backwards (see the header). */
async function reverse(ctx: Ctx, c: Change, now: number, run: Run): Promise<Undone> {
  try {
    switch (c.target.kind) {
      case 'transaction':
        return await undoTransaction(ctx, c, now, run);
      case 'manual-account':
        return await undoAccount(ctx, c, now, run);
      case 'category':
      case 'group':
        return await undoCategory(ctx, c);
      case 'tag':
        return await undoTag(ctx, c);
      default:
        return refuse('An undo isn’t undone: make the change again.');
    }
  } catch (err) {
    throw refusalOf(err);
  }
}

/** Why a change can't be undone at all, or null. */
function cannotUndo(c: Change): string | null {
  if (c.op === 'undo') return 'An undo isn’t undone: make the change again.';
  if (c.forgotten_at) return 'This change was forgotten, so what it changed isn’t kept to undo it with.';
  if (c.state !== 'done') return 'This change may not have been made, so there is nothing to undo.';
  if (c.before === undefined || c.after === undefined) return NOT_RECORDED;
  return null;
}

/** Notes on a change that an undo of it is under way, or that none is. */
async function markUndoing(ctx: Ctx, changeId: string, undo: string | null): Promise<void> {
  await changeStore.update(ctx, changeId, (cur) => {
    if (!cur) return null;
    const next: Change = { ...cur };
    if (undo) next.undoing = undo;
    else delete next.undoing;
    return next;
  });
}

/**
 * Undoes one change and records the undo: `who` is the token undoing its own
 * change, or null for the person in the app. Answers the undo's id (the one
 * already made, when asked again). Throws ApiFailure for a refusal.
 *
 * Recorded truthfully: an undo refused before it wrote anything is taken
 * back out; one that stopped after a write (refused or not) is settled
 * failed, never dropped. An undo of an account made, cut off part way, is
 * named on the change (`undoing`) and taken up again by the next undo asked.
 */
export async function undoChange(
  ctx: Ctx,
  changeId: string,
  who: { auth: Authenticated; via: 'api' | 'mcp' } | null,
  now: number = Date.now()
): Promise<{ change: Change; undo: string; headers: Record<string, string> }> {
  const c = await getChange(ctx, changeId, now);
  if (!c || (who && c.token?.ref !== tokenRef(who.auth.id))) throw new ApiFailure(404, 'not_found', 'No change of this token’s has that id in the last 30 days.');
  if (c.undone_by) return { change: c, undo: c.undone_by, headers: {} };
  const why = cannotUndo(c);
  if (why) refuse(why);
  if (who) await checkDay(who.auth, { create: false }, now);
  const earlier = c.undoing ? await getChange(ctx, c.undoing, now).catch(() => null) : null;
  const resume = !!earlier && earlier.state !== 'done';
  const id = resume ? c.undoing! : newChangeId(now, who ? tokenRef(who.auth.id) : null);
  if (!resume) {
    const op: ChangeOp = 'undo';
    await beginChange(ctx, id, {
      v: 1,
      at: new Date(now).toISOString(),
      via: who ? who.via : 'app',
      token: who ? { ref: tokenRef(who.auth.id), label: who.auth.token.label } : null,
      op,
      target: { kind: 'change', id: changeId },
      state: 'pending',
      undoes: changeId,
    });
    if (c.op === 'manual-account.create') await markUndoing(ctx, changeId, id);
  }
  const run: Run = {
    resume,
    // Past its delete, an undo cut off had written; before it, nothing.
    began: resume && (earlier?.progress === 'folding' || earlier?.progress === 'forgetting'),
    progress: earlier?.progress,
    step: async (s) => {
      await changeStore.update(ctx, id, (cur) => (cur ? { ...cur, state: 'pending', progress: s } : null));
      run.progress = s;
    },
  };
  let undone: Undone;
  try {
    undone = await reverse(ctx, c, now, run);
  } catch (err) {
    if (!run.began && err instanceof ApiFailure) {
      await changeStore.remove(ctx, id).catch(() => {});
      if (c.op === 'manual-account.create') await markUndoing(ctx, changeId, null).catch(() => {});
    } else {
      await settleChange(ctx, id, { state: 'failed', error: err instanceof ApiFailure ? err.code : 'internal' });
    }
    throw err;
  }
  const headers = who ? await countDay(who.auth, { create: false }, now) : {};
  await changeStore
    .update(ctx, id, (cur) => {
      if (!cur) return null;
      const next: Change = { ...cur, state: 'done', before: (undone.before as object | null) ?? null, after: (undone.after as object | null) ?? null };
      delete next.progress;
      delete next.error;
      return next;
    })
    .catch((err) => console.error('API undo: an undo could not be settled', err instanceof Error ? err.name : typeof err));
  await changeStore
    .update(ctx, changeId, (cur) => {
      if (!cur) return null;
      const next: Change = { ...cur, undone_by: id };
      delete next.undoing;
      return next;
    })
    .catch((err) => console.error('API undo: a change could not be marked undone', err instanceof Error ? err.name : typeof err));
  const changed = { ...c, undone_by: id };
  delete changed.undoing;
  return { change: changed, undo: id, headers };
}

/** The API's and MCP's undo: a token's own change alone. */
export async function undoForToken(auth: Authenticated, input: ResourceInput): Promise<ResourceAnswer> {
  const { change, undo, headers } = await undoChange(auth.ctx, input.id ?? '', { auth, via: input.via }, input.now ?? Date.now());
  const { servedChange } = await import('./api-writes');
  return { status: 200, body: { change: servedChange(input.id!, change, hintOf(auth.id)), undo }, headers };
}
