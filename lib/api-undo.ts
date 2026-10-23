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
//   account created       while its details and balance are as made, it isn't
//                         hidden or marked closed, and every row in its book
//                         was added by the same token: its rows, the account,
//                         and its balance on every day recorded since, through
//                         the app's own delete and the steps the app's forget
//                         of a hidden account takes (lib/links.ts
//                         forgetEarlierAccount, which refuses a manual id), so
//                         past totals read as though it never was
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
import { takeDay } from './api-run';
import { beginChange, changeIds, changeStore, getChange, newChangeId, settleChange, tokenRef, type Change, type ChangeOp } from './api-changes';
import { accountVersion, categoryVersion, groupVersion, tagVersion } from './api-versions';
import type { ResourceAnswer, ResourceInput } from './api-writes';
import { getManualAccount, type ManualAccount } from './manual';
import { invalidate, saveAccountEdit, setAccountBalance } from './manual-account-writes';
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
import { lifecycleStore } from './lifecycle';

const refuse = (message: string): never => {
  throw new ApiFailure(409, 'conflict', message);
};
const CHANGED = (what: string) => `${what} changed since this change was made, so it wasn’t undone. Change it back yourself if you want it as it was.`;

/** Whether two stored states are the same, field for field. */
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

type TxnState = { row: ManualTxn; said: TxnAnnotation | null };

/** What an undo did: the target as it was before the undo and after. */
type Undone = { before: unknown; after: unknown };

/** The app's own refusal, in the API's shape. */
function refusalOf(err: unknown): unknown {
  if (err instanceof CategoryError || err instanceof TagError) return new ApiFailure(409, 'conflict', err.message);
  if (err instanceof ForgetRefused) return new ApiFailure(409, 'conflict', err.message);
  return err;
}

async function undoTransaction(ctx: Ctx, c: Change, now: number): Promise<Undone> {
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
    if (found) refuse('A transaction with its id is there again, so it wasn’t added back.');
    if (!(await getManualAccount(ctx, before!.row.account_id))) refuse('Its account no longer exists, so it wasn’t added back.');
    const { added } = await addManualTxn(ctx, before!.row);
    if (!added) refuse('A transaction with its id is there again, so it wasn’t added back.');
    if (before!.said) await restoreAnnotation(ctx, id, before!.said, (cur) => (cur === null ? undefined : refuse(CHANGED('What was said about it'))));
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

/** Every row in the account's book was added by this token through the API,
 *  as the record of its changes says. */
async function rowsAllFrom(ctx: Ctx, accountId: string, maker: string): Promise<boolean> {
  const book = await manualTxnStore.get(ctx, accountId);
  if (!book || book.rows.length === 0) return true;
  const made = new Set<string>();
  const ids = await changeIds(ctx, { maker });
  for (let i = 0; i < ids.length; i += 500) {
    for (const c of (await changeStore.getMany(ctx, ids.slice(i, i + 500))).values()) {
      if (c.op === 'transaction.create' && c.state === 'done') made.add(c.target.id);
    }
  }
  return book.rows.every((r) => made.has(r.id));
}

async function undoAccount(ctx: Ctx, c: Change, now: number): Promise<Undone> {
  const id = c.target.id;
  const current = await getManualAccount(ctx, id);
  if (!current) refuse('The account no longer exists.');
  const cur = current!;
  if (c.op === 'manual-account.balance') {
    const after = c.after as { balance: number };
    const before = c.before as { balance: number };
    if (Math.round(cur.balance * 100) !== Math.round(after.balance * 100)) refuse(CHANGED('Its balance'));
    const set = await setAccountBalance(ctx, id, before.balance, { now: new Date(now) });
    return { before: { balance: cur.balance, updated_at: cur.updated_at }, after: set.kind === 'set' ? { balance: set.account.balance, updated_at: set.account.updated_at } : null };
  }
  const after = c.after as ManualAccount;
  if (c.op === 'manual-account.update') {
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
  // Made: taken out whole, while nothing but the token that made it touched it.
  if (accountVersion(cur) !== accountVersion(after) || Math.round(cur.balance * 100) !== Math.round(after.balance * 100)) refuse(CHANGED('The account'));
  if ((await getHiddenAccounts(ctx)).has(id)) refuse('The account was hidden since, so it wasn’t removed: remove it in the app.');
  if (await lifecycleStore.has(ctx, id)) refuse('The account was marked closed since, so it wasn’t removed: remove it in the app.');
  if (!c.token || !(await rowsAllFrom(ctx, id, c.token.ref))) refuse('Transactions were added to the account since in another way, so it wasn’t removed: remove it in the app.');
  await withLinksLock(ctx, async () => {
    await deleteManualAccount(ctx, id);
    await invalidate(ctx, true);
    await forgetMadeBalances(ctx, id, cur.type, { first: c.at.slice(0, 10), last: new Date(now).toISOString().slice(0, 10) });
  });
  await invalidate(ctx, true);
  return { before: cur, after: null };
}

/**
 * Takes a deleted account's balance out of every day recorded since it was
 * made, totals included: hidden, folded out of each total point by point,
 * then its balances removed from every per-account layer, as the app's
 * forget of a hidden account does (lib/links.ts forgetEarlierAccount, whose
 * listing refuses a manual id, so its steps are taken here). Under the links
 * lock, after the delete, so no recording writes the account again. Stopped
 * part way, the account stays hidden with its progress kept, out of the
 * totals as a hidden account is, and the undo says it may not have been made.
 */
async function forgetMadeBalances(ctx: Ctx, id: string, type: string, life: { first: string; last: string }): Promise<void> {
  await setAccountHidden(ctx, id, type, true);
  const entry = (await getHiddenAccounts(ctx)).get(id);
  if (!entry) throw new Error('The account could not be hidden to take it out of past totals.');
  const tag = entry.forget_tag ?? crypto.randomUUID();
  if (!entry.forget_tag) await markForgetting(ctx, id, entry, tag);
  await foldHiddenAccount(ctx, id, type, tag, life);
  await dropFoldProgress(ctx, tag);
  await setAccountHidden(ctx, id, '', false);
  await forgetAccountBalances(ctx, id);
  await forgetAccountBalances(ctx, id, { today: true });
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
async function reverse(ctx: Ctx, c: Change, now: number): Promise<Undone> {
  try {
    switch (c.target.kind) {
      case 'transaction':
        return await undoTransaction(ctx, c, now);
      case 'manual-account':
        return await undoAccount(ctx, c, now);
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
  return null;
}

/**
 * Undoes one change and records the undo: `who` is the token undoing its own
 * change, or null for the person in the app. Answers the undo's id (the one
 * already made, when asked again). Throws ApiFailure for a refusal.
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
  const headers = who ? await takeDay(who.auth, { create: false }, now) : {};
  const id = newChangeId(now, who ? tokenRef(who.auth.id) : null);
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
  let undone: Undone;
  try {
    undone = await reverse(ctx, c, now);
  } catch (err) {
    // Refused (what it changed moved since, or the app's own rules): nothing
    // was undone, so the undo is taken back out. Anything else may have
    // stopped part way, and says so.
    if (err instanceof ApiFailure) await changeStore.remove(ctx, id).catch(() => {});
    else await settleChange(ctx, id, { state: 'failed', error: 'internal' });
    throw err;
  }
  await settleChange(ctx, id, { state: 'done', before: (undone.before as object | null) ?? null, after: (undone.after as object | null) ?? null });
  await settleChange(ctx, changeId, { undone_by: id });
  return { change: { ...c, undone_by: id }, undo: id, headers };
}

/** The API's and MCP's undo: a token's own change alone. */
export async function undoForToken(auth: Authenticated, input: ResourceInput): Promise<ResourceAnswer> {
  const { change, undo, headers } = await undoChange(auth.ctx, input.id ?? '', { auth, via: input.via }, input.now ?? Date.now());
  const { servedChange } = await import('./api-writes');
  return { status: 200, body: { change: servedChange(input.id!, change, hintOf(auth.id)), undo }, headers };
}
