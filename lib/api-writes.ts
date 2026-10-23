// lib/api-writes.ts
//
// What each operation on one resource does (lib/api-spec.ts RESOURCE_SPECS):
// a read by id, and every write a token can make, after the gate every
// operation passes (lib/api-run.ts) and the strict reading of its input
// (lib/api-http.ts for REST, lib/mcp.ts for MCP). Each write calls the
// function the app's own route calls (lib/manual-account-writes.ts,
// lib/manual-txn-writes.ts, lib/annotate.ts, lib/category-actions.ts,
// lib/tag-actions.ts), so rules, splits, groups, rollover, approvals, category
// usage, caches and history behave as when the person makes the change in the
// app. This module adds only what a program needs and a person doesn't:
//
//   - THE VERSION a change to something that exists was made from (If-Match,
//     lib/api-versions.ts), checked inside the compare-and-set that writes it,
//     so a program working from an old read never writes over what the person
//     just did: 412 when it no longer matches;
//   - THE KEY a create may be sent with (Idempotency-Key), claimed in the
//     record of changes (lib/api-changes.ts), so a create sent again makes one
//     thing. Ids are minted as the app mints them, and a create taken over
//     from one that stopped part way never reuses the first's id: the first's
//     target is looked for everywhere it could be, replayed when it is there,
//     refused when it was made and removed since, and made again under a new
//     id when there is no trace of it;
//   - THE RECORD of each change, written before it is made and settled after
//     (lib/api-changes.ts), and the day's limits (lib/api-run.ts takeDay);
//   - WHAT A WRITE NEVER DOES: change a bank's transaction (Plaid's, a
//     connector's, one imported from a file), write to an account a connector
//     feeds, cross a manual account between money held and owed (it changes
//     how its past balances count: the app does that), fill the room the
//     app's own limits keep for what it makes itself (API_ROOM), or reach
//     another container: everything here takes the token's own `ctx`.

import type { Authenticated } from './api-tokens';
import { hintOf } from './api-tokens';
import type { Ctx } from './containers';
import { ApiFailure, BadRequest, NotFound, type Args, type ResourceSpec } from './api-spec';
import { takeDay } from './api-run';
import { API_ROOM, IDEMPOTENCY_HOURS } from './api-limits';
import {
  beginChange,
  claimKey,
  dropChange,
  getChange,
  listChanges,
  newChangeId,
  reclaim,
  settleChange,
  sha256,
  tokenRef,
  type Change,
  type ChangeOp,
  type TargetKind,
} from './api-changes';
import { accountVersion, categoryVersion, groupVersion, rowVersion, saidVersion, tagVersion, txnParts, txnVersion } from './api-versions';
import { withAccountVersions, withTxnVersions } from './api-versioned';
import { firstDay, readAccounts, queryTransactions } from './api-read';
import { getManualAccount, getManualAccounts, isManualId, MAX_MANUAL_ACCOUNTS, newManualId, type ManualAccount } from './manual';
import { isOwedType } from './balance';
import { connectorAccountsStore } from './connectors/store';
import { AccountEditRefused, createManualAccount, saveAccountEdit, setAccountBalance, type AccountFields } from './manual-account-writes';
import { addDays, readTxnFields, type TxnFields } from './manual-txn-input';
import { findManualTxn, InvalidTxnError, MANUAL_TXN_PREFIX, newManualTxnId, type ManualTxn, type ManualTxnChanges } from './manual-txns';
import { addRow, changeManualTransaction, removeManualTransaction } from './manual-txn-writes';
import { annotateTransaction } from './annotate';
import { AnnotationError, TooManyAnnotationsError, txnAnnotationStore, type TxnAnnotation } from './txn-annotations';
import { splitStore } from './splits';
import { groupStore, memberIndex } from './groups';
import { CategoryError, MAX_CATEGORIES, MAX_GROUPS, type Category, type CategoryGroup, type Taxonomy } from './categories';
import { choiceForId, newCategoryId, readTaxonomy } from './category-store';
import { addCategoryAs, addGroupAs, editCategory, editGroup } from './category-actions';
import { MAX_TAGS, newTagId, readTagSet, TagError, type Tag, type TagSet } from './tags';
import { finishDeleting } from './tag-delete';
import { addTagAs, editTag } from './tag-actions';
import { readDirectoryStrict } from './links';
import { StoredDataUnreadableError, StoreRefusedError } from './repo';

/** What an operation is given, read and checked by its caller. */
export type ResourceInput = {
  /** The resource's id, from the path (REST) or an argument (MCP). */
  id?: string;
  args: Args;
  /** If-Match as read (lib/api-versions.ts readIfMatch); absent: null. */
  version?: string | null;
  /** The Idempotency-Key, as sent. */
  key?: string | null;
  via: 'api' | 'mcp';
  now?: number;
};

export type ResourceAnswer = { status: number; body: Record<string, unknown>; headers: Record<string, string> };

const fail = (status: number, code: string, message: string, headers: Record<string, string> = {}): never => {
  throw new ApiFailure(status, code, message, headers);
};
const stale = (): never =>
  fail(412, 'version_mismatch', 'It changed since the version you sent: read it again, then decide whether to change it.');
const today = (now: number) => new Date(now).toISOString().slice(0, 10);
const str = (a: Args, k: string) => a[k] as string | undefined;
const given = (a: Args, k: string) => a[k] !== undefined;

/** The app's own refusals, in the API's shape: each says what to do. */
function appRefusal(err: unknown): ApiFailure | null {
  if (err instanceof ApiFailure) return err;
  if (err instanceof CategoryError || err instanceof TagError) {
    return new ApiFailure(err.status, err.status === 404 ? 'not_found' : err.status === 409 ? 'conflict' : 'invalid_request', err.message);
  }
  if (err instanceof AccountEditRefused) return new ApiFailure(err.status, err.status === 400 ? 'invalid_request' : 'conflict', err.message);
  if (err instanceof AnnotationError || err instanceof InvalidTxnError) return new ApiFailure(400, 'invalid_request', err.message);
  if (err instanceof TooManyAnnotationsError) return new ApiFailure(409, 'conflict', err.message);
  return null;
}

/** Whether a failure means nothing was changed: a refusal before or inside
 *  the compare-and-set, or what the seam refused to read or write. */
const changedNothing = (err: unknown) =>
  appRefusal(err) !== null || err instanceof BadRequest || err instanceof NotFound || err instanceof StoredDataUnreadableError || err instanceof StoreRefusedError;

// ---- The record of each change ----

type Made = { before: unknown; after: unknown; target?: Change['target'] };

/**
 * Makes one change with its record: written pending, made, settled done with
 * what it changed (best effort), or taken back out when it changed nothing,
 * or settled failed when that can't be told. Answers the change's id.
 */
async function recorded(
  auth: Authenticated,
  input: ResourceInput,
  op: ChangeOp,
  target: Change['target'],
  make: () => Promise<Made>,
  opts: { changeId?: string; keyed?: boolean } = {}
): Promise<string> {
  const now = input.now ?? Date.now();
  const id = opts.changeId ?? newChangeId(now, tokenRef(auth.id));
  await beginChange(auth.ctx, id, {
    v: 1,
    at: new Date(now).toISOString(),
    via: input.via,
    token: { ref: tokenRef(auth.id), label: auth.token.label },
    op,
    target,
    state: 'pending',
  });
  let made: Made;
  try {
    made = await make();
  } catch (err) {
    if (changedNothing(err)) await dropChange(auth.ctx, id, opts.keyed ? auth.id : null);
    else await settleChange(auth.ctx, id, { state: 'failed', error: 'internal' });
    throw err;
  }
  await settleChange(auth.ctx, id, { state: 'done', before: made.before ?? null, after: made.after ?? null, ...(made.target ? { target: made.target } : {}) });
  return id;
}

/** The canonical text of a request's input, for its key's digest: the
 *  operation and its fields as given, before any default is filled in. */
function requestDigest(spec: ResourceSpec, args: Args): string {
  const fields = Object.keys(args)
    .filter((k) => args[k] !== undefined)
    .sort()
    .map((k) => [k, args[k]]);
  return sha256(JSON.stringify([spec.name, fields]));
}

/** Where a create's target is: there, gone but known to have been made
 *  (merged, being deleted, in the account history's directory), or nowhere. */
type Found = 'live' | 'trace' | 'none';

/** One kind of create, as keyedCreate runs it. */
type Create = {
  op: ChangeOp;
  kind: TargetKind;
  mint: () => string;
  /** Makes it under the id given; `made` false when one was there already. */
  make: (id: string) => Promise<{ after: unknown; made: boolean; account_id?: string }>;
  locate: (id: string) => Promise<Found>;
  answer: (id: string) => Promise<Record<string, unknown>>;
};

const PENDING_MS = 60_000;

/**
 * A create, safe to send again with its Idempotency-Key (see the header):
 * claimed, then made under a fresh id; or, for a key already claimed with the
 * same request, replayed, said to be in progress, or taken over.
 */
async function keyedCreate(auth: Authenticated, spec: ResourceSpec, input: ResourceInput, c: Create): Promise<ResourceAnswer> {
  const now = input.now ?? Date.now();
  const fresh = async (changeId?: string): Promise<ResourceAnswer> => {
    const day = await takeDay(auth, { create: true }, now);
    const id = c.mint();
    const change = await recorded(
      auth,
      input,
      c.op,
      { kind: c.kind, id },
      async () => {
        const made = await c.make(id);
        return { before: null, after: made.after, ...(made.account_id ? { target: { kind: c.kind, id, account_id: made.account_id } } : {}) };
      },
      { changeId, keyed: input.key != null }
    );
    return { status: 201, body: { ...(await c.answer(id)), change_id: change }, headers: day };
  };
  if (input.key == null) return fresh();

  const request = requestDigest(spec, input.args);
  const claim = await claimKey(auth.ctx, auth.id, input.key, request, now);
  if (claim.kind === 'new') {
    try {
      return await fresh(claim.change);
    } catch (err) {
      // Refused before anything was made (a limit, say): the key is free.
      if (err instanceof ApiFailure && err.status === 429) await dropChange(auth.ctx, claim.change, auth.id);
      throw err;
    }
  }
  const found = claim.claim;
  if (found.request !== request) {
    fail(422, 'idempotency_key_reused', `This Idempotency-Key was sent with another request in the last ${IDEMPOTENCY_HOURS} hours: send this one with a key of its own.`);
  }
  const replayed = { 'Idempotent-Replayed': 'true' };
  const change = await getChange(auth.ctx, found.change, now);
  if (change?.state === 'done') {
    if ((await c.locate(change.target.id)) === 'live') return { status: 200, body: { ...(await c.answer(change.target.id)), change_id: found.change }, headers: replayed };
    return { status: 200, body: { deleted: true, change_id: found.change }, headers: replayed };
  }
  const since = change ? Date.parse(change.at) : Date.parse(found.at);
  if ((!change || change.state === 'pending') && now - since < PENDING_MS) {
    fail(409, 'in_progress', 'A request with this Idempotency-Key is still being made. Send it again in a moment.', { 'Retry-After': '2' });
  }
  // Taken over: the first stopped part way, or failed. Its target, if it
  // made one, is looked for first; its id is never made again.
  if (change) {
    const where = await c.locate(change.target.id);
    if (where === 'live') {
      await settleChange(auth.ctx, found.change, { state: 'done', before: null, after: null });
      return { status: 200, body: { ...(await c.answer(change.target.id)), change_id: found.change }, headers: replayed };
    }
    if (where === 'trace') {
      await settleChange(auth.ctx, found.change, { state: 'failed', error: 'removed' });
      fail(409, 'conflict', 'What this Idempotency-Key made has been removed since. Send a new request, with a new key, to make it again.');
    }
  }
  const next = newChangeId(now, tokenRef(auth.id));
  await reclaim(auth.ctx, auth.id, found.key, next, now);
  return fresh(next);
}

// ---- Reading one resource ----

/** A manual account, as /accounts lists it, with its version. */
async function accountAnswer(ctx: Ctx, id: string): Promise<Record<string, unknown>> {
  const { accounts } = await readAccounts(ctx, { includeHidden: true, base: true });
  const [account] = await withAccountVersions(
    ctx,
    accounts.filter((a) => a.id === id)
  );
  if (!account) throw new NotFound('No manual account has that id.');
  return { account };
}

/** A transaction, as /transactions lists it, with its version. */
async function transactionAnswer(ctx: Ctx, id: string, now: number): Promise<Record<string, unknown>> {
  const page = await queryTransactions(ctx, { from: firstDay(now), to: addDays(today(now), 1), includeHidden: true, ids: new Set([id]), limit: 1 });
  const [transaction] = await withTxnVersions(ctx, page.transactions);
  if (!transaction) throw new NotFound('No transaction the API reads has that id: it reads the last 365 days.');
  return { transaction };
}

/** The stored set of categories, or a 404 for an account that has none yet. */
async function taxonomyOf(ctx: Ctx): Promise<Taxonomy> {
  const t = await readTaxonomy(ctx);
  if (!t) throw new NotFound('No category has that id: list them with categories.');
  return t;
}

function categoryShape(t: Taxonomy, c: Category) {
  const g = t.groups.find((x) => x.id === c.group)!;
  return { id: c.id, name: c.name, icon: c.icon ?? null, archived: c.archived === true, group_id: g.id, group: g.name, kind: g.kind, version: categoryVersion(c) };
}

function groupShape(t: Taxonomy, g: CategoryGroup) {
  return {
    id: g.id,
    name: g.name,
    kind: g.kind,
    categories: t.categories.filter((c) => c.group === g.id).map((c) => ({ id: c.id, name: c.name, archived: c.archived === true })),
    version: groupVersion(g),
  };
}

const tagShape = (t: Tag) => ({ id: t.id, name: t.name, color: t.color, version: tagVersion(t) });

async function categoryAnswer(ctx: Ctx, id: string) {
  const t = await taxonomyOf(ctx);
  const c = t.categories.find((x) => x.id === id);
  if (!c) throw new NotFound('No category has that id: list them with categories.');
  return { category: categoryShape(t, c) };
}

async function groupAnswer(ctx: Ctx, id: string) {
  const t = await readTaxonomy(ctx);
  const g = t?.groups.find((x) => x.id === id);
  if (!t || !g) throw new NotFound('No category group has that id: list them with categories.');
  return { group: groupShape(t, g) };
}

async function tagAnswer(ctx: Ctx, id: string) {
  const t = (await readTagSet(ctx))?.tags.find((x) => x.id === id);
  if (!t) throw new NotFound('No tag has that id: list them with tags.');
  return { tag: tagShape(t) };
}

// ---- Manual accounts ----

/** A manual account the token may change, or the refusal. */
async function manualAccountFor(ctx: Ctx, id: string | undefined): Promise<ManualAccount> {
  if (!id || !isManualId(id)) fail(403, 'forbidden', 'Only a manual account can be changed through the API: a linked account’s come from its bank.');
  const account = await getManualAccount(ctx, id!);
  if (account) return account;
  if (await connectorAccountsStore.has(ctx, id!)) fail(403, 'forbidden', 'This account is kept up to date by SimpleFIN or Lunch Flow: its bank’s, never changed through the API.');
  return fail(404, 'not_found', 'No manual account has that id.');
}

/** A version the request names, or a 412 for one that never matches. */
function wanted(input: ResourceInput): string {
  const v = input.version;
  if (!v || v === 'none') return fail(428, 'version_required', 'Send the version you read in If-Match.');
  if (v === 'weak') return stale();
  return v;
}

const crossesOwed = (from: string, to: string) => isOwedType(from) !== isOwedType(to);

const ACCOUNT_ROOM = Math.floor(MAX_MANUAL_ACCOUNTS * API_ROOM);

async function createAccount(auth: Authenticated, spec: ResourceSpec, input: ResourceInput): Promise<ResourceAnswer> {
  const a = input.args;
  const fields: AccountFields = {
    name: str(a, 'name')!,
    institution_name: str(a, 'institution_name')!.replace(/\s+/g, ' '),
    type: str(a, 'type') as AccountFields['type'],
    subtype: (a.subtype as string | null | undefined) ?? null,
    balance: a.balance as number,
  };
  if (isOwedType(fields.type) && fields.balance < 0) fail(400, 'invalid_request', 'Credit and loan balances are the amount owed, so they cannot be negative');
  return keyedCreate(auth, spec, input, {
    op: 'manual-account.create',
    kind: 'manual-account',
    mint: newManualId,
    make: async (id) => {
      const made = await createManualAccount(auth.ctx, fields, str(a, 'currency'), { id, now: new Date(input.now ?? Date.now()), limit: ACCOUNT_ROOM });
      if ('limit' in made) fail(409, 'conflict', `At most ${ACCOUNT_ROOM} manual accounts can be made through the API: the rest of the ${MAX_MANUAL_ACCOUNTS} are kept for the app.`);
      const { account, created } = made as { account: ManualAccount; created: boolean };
      return { after: account, made: created };
    },
    locate: async (id) => ((await getManualAccount(auth.ctx, id)) ? 'live' : (await readDirectoryStrict(auth.ctx)).has(id) ? 'trace' : 'none'),
    answer: (id) => accountAnswer(auth.ctx, id),
  });
}

async function updateAccount(auth: Authenticated, input: ResourceInput): Promise<ResourceAnswer> {
  await manualAccountFor(auth.ctx, input.id);
  const want = wanted(input);
  const a = input.args;
  const fields: Partial<AccountFields> = {};
  if (given(a, 'name')) fields.name = str(a, 'name');
  if (given(a, 'institution_name')) fields.institution_name = str(a, 'institution_name')!.replace(/\s+/g, ' ');
  if (given(a, 'type')) fields.type = str(a, 'type') as AccountFields['type'];
  if (given(a, 'subtype')) fields.subtype = (a.subtype as string | null) ?? null;
  const day = await takeDay(auth, { create: false }, input.now);
  let before: ManualAccount | null = null;
  let after: ManualAccount | null = null;
  const change = await recorded(auth, input, 'manual-account.update', { kind: 'manual-account', id: input.id! }, async () => {
    const saved = await saveAccountEdit(
      auth.ctx,
      input.id!,
      { fields },
      {
        now: new Date(input.now ?? Date.now()),
        check: (current) => {
          if (accountVersion(current) !== want) stale();
          if (fields.type && crossesOwed(current.type, fields.type)) {
            fail(409, 'conflict', 'A change between money held and money owed changes how its past balances count. Make it in the app.');
          }
        },
      }
    );
    if (!saved) fail(404, 'not_found', 'No manual account has that id.');
    before = saved!.before;
    after = saved!.account;
    return { before, after };
  });
  return { status: 200, body: { ...(await accountAnswer(auth.ctx, input.id!)), change_id: change }, headers: day };
}

async function setBalance(auth: Authenticated, input: ResourceInput): Promise<ResourceAnswer> {
  const account = await manualAccountFor(auth.ctx, input.id);
  const balance = input.args.balance as number;
  if (isOwedType(account.type) && balance < 0) fail(400, 'invalid_request', 'Credit and loan balances are the amount owed, so they cannot be negative');
  // The same to the cent: nothing is written, recorded or counted.
  if (Math.round(account.balance * 100) === Math.round(balance * 100)) return { status: 200, body: { ...(await accountAnswer(auth.ctx, account.account_id)), changed: false }, headers: {} };
  const day = await takeDay(auth, { create: false }, input.now);
  let changed = true;
  const change = await recorded(auth, input, 'manual-account.balance', { kind: 'manual-account', id: account.account_id }, async () => {
    const set = await setAccountBalance(auth.ctx, account.account_id, balance, { now: new Date(input.now ?? Date.now()) });
    if (set.kind === 'missing') fail(404, 'not_found', 'No manual account has that id.');
    if (set.kind === 'same') {
      changed = false;
      throw new ApiFailure(200, 'same', 'unchanged'); // nothing changed: taken back out below
    }
    const s = set as { before: ManualAccount; account: ManualAccount };
    return { before: { balance: s.before.balance, updated_at: s.before.updated_at }, after: { balance: s.account.balance, updated_at: s.account.updated_at } };
  }).catch((err) => {
    if (err instanceof ApiFailure && err.code === 'same') return null;
    throw err;
  });
  return { status: 200, body: { ...(await accountAnswer(auth.ctx, account.account_id)), changed, ...(change ? { change_id: change } : {}) }, headers: day };
}

// ---- Transactions ----

const BANKS_ROW = 'This transaction came from your bank, or from a file you imported: the API changes only transactions entered by hand or through the API.';

/** A row the token may change, read strictly, or the refusal. */
async function ownRow(ctx: Ctx, id: string | undefined): Promise<{ account_id: string; row: ManualTxn }> {
  if (!id || !id.startsWith(MANUAL_TXN_PREFIX)) fail(403, 'forbidden', BANKS_ROW);
  const found = await findManualTxn(ctx, id!);
  if (!found) fail(404, 'not_found', 'No transaction has that id: it may have been deleted.');
  if (found!.row.source !== 'manual') fail(403, 'forbidden', BANKS_ROW);
  return found!;
}

/** A day a write may give a row: one the API reads back. */
function checkDay(day: string | undefined, now: number): void {
  if (day !== undefined && day < firstDay(now)) fail(400, 'invalid_request', `date is from ${firstDay(now)} on: the API reads the last 365 days. Bring older ones in with a file import in the app.`);
}

/** A category chosen by id, as the words a row keeps; null for none. */
async function categoryWords(ctx: Ctx, a: Args): Promise<string | null | undefined> {
  if (!given(a, 'category_id')) return undefined;
  return a.category_id === null ? null : choiceForId(ctx, a.category_id);
}

const txnState = (row: ManualTxn, said: TxnAnnotation | null) => ({ row, said });

async function createTransaction(auth: Authenticated, spec: ResourceSpec, input: ResourceInput): Promise<ResourceAnswer> {
  const a = input.args;
  const now = input.now ?? Date.now();
  const account = await manualAccountFor(auth.ctx, str(a, 'account_id'));
  checkDay(str(a, 'date'), now);
  let category: string | null | undefined;
  try {
    category = await categoryWords(auth.ctx, a);
  } catch (err) {
    throw appRefusal(err) ?? err;
  }
  const read = readTxnFields(
    { date: a.date, amount: a.amount, currency: a.currency ?? account.currency ?? 'USD', name: a.name, category: category ?? null, note: a.note ?? null },
    { partial: false, today: today(now) }
  );
  if ('error' in read) fail(400, 'invalid_request', read.error);
  const fields = (read as { fields: TxnFields }).fields;
  return keyedCreate(auth, spec, input, {
    op: 'transaction.create',
    kind: 'transaction',
    mint: newManualTxnId,
    make: async (id) => {
      const put = await addRow(auth.ctx, account, fields, id, new Date(now));
      if (put === 'account-gone') fail(404, 'not_found', 'That account no longer exists.');
      const { row, added } = put as { row: ManualTxn; added: boolean };
      return { after: txnState(row, null), made: added, account_id: account.account_id };
    },
    locate: async (id) => ((await findManualTxn(auth.ctx, id)) ? 'live' : 'none'),
    answer: (id) => transactionAnswer(auth.ctx, id, now),
  });
}

const ROW_FIELDS = ['date', 'amount', 'currency', 'name', 'category_id', 'note', 'account_id'] as const;

async function updateTransaction(auth: Authenticated, input: ResourceInput): Promise<ResourceAnswer> {
  const found = await ownRow(auth.ctx, input.id);
  const want = txnParts(wanted(input)) ?? stale();
  const a = input.args;
  const now = input.now ?? Date.now();
  const id = input.id!;
  const rowChange = ROW_FIELDS.some((k) => given(a, k));
  if (rowChange) {
    checkDay(str(a, 'date'), now);
    const changes: ManualTxnChanges = {};
    try {
      const category = await categoryWords(auth.ctx, a);
      const body: Record<string, unknown> = { ...a, ...(category !== undefined ? { category } : {}) };
      const read = readTxnFields(body, { partial: true, today: today(now) });
      if ('error' in read) fail(400, 'invalid_request', read.error);
      Object.assign(changes, (read as { fields: Partial<TxnFields> }).fields);
    } catch (err) {
      throw appRefusal(err) ?? err;
    }
    const target = given(a, 'account_id') ? await manualAccountFor(auth.ctx, str(a, 'account_id')) : undefined;
    if (target) changes.account_id = target.account_id;
    const day = await takeDay(auth, { create: false }, now);
    const said = await txnAnnotationStore.get(auth.ctx, id);
    let before: ManualTxn | null = null;
    const change = await recorded(auth, input, 'transaction.update', { kind: 'transaction', id, account_id: found.account_id }, async () => {
      const done = await changeManualTransaction(auth.ctx, id, changes, {
        from: found.account_id,
        target,
        now: new Date(now),
        expect: (row) => {
          if (row.source !== 'manual') fail(403, 'forbidden', BANKS_ROW);
          if (rowVersion(row) !== want.row) stale();
          before = row;
        },
      });
      if (done === 'gone' || done === 'account-gone') fail(404, 'not_found', 'That transaction, or the account it was moved to, no longer exists.');
      const saved = (done as { saved: ManualTxn }).saved;
      return { before: txnState(before!, said), after: txnState(saved, said), target: { kind: 'transaction', id, account_id: saved.account_id } };
    });
    return { status: 200, body: { ...(await transactionAnswer(auth.ctx, id, now)), change_id: change }, headers: day };
  }
  const day = await takeDay(auth, { create: false }, now);
  let before: TxnAnnotation | null = null;
  const change = await recorded(auth, input, 'transaction.update', { kind: 'transaction', id, account_id: found.account_id }, async () => {
    const done = await annotateTransaction(
      auth.ctx,
      id,
      { excluded: a.excluded as boolean | undefined, add: (a.add_tag_ids as string[] | undefined) ?? [], remove: (a.remove_tag_ids as string[] | undefined) ?? [], account_id: found.account_id },
      {
        now: new Date(now),
        expect: (current) => {
          if (saidVersion(current) !== want.said) stale();
          before = current;
        },
      }
    );
    if (!done.ok) fail(404, 'not_found', done.message);
    const record = (done as { record: TxnAnnotation | null }).record;
    return { before: txnState(found.row, before), after: txnState(found.row, record) };
  });
  return { status: 200, body: { ...(await transactionAnswer(auth.ctx, id, now)), change_id: change }, headers: day };
}

async function deleteTransaction(auth: Authenticated, input: ResourceInput): Promise<ResourceAnswer> {
  const found = await ownRow(auth.ctx, input.id);
  const want = txnParts(wanted(input)) ?? stale();
  const now = input.now ?? Date.now();
  const id = input.id!;
  // Undo couldn't bring a split or a place in a group back: refused (checked
  // first, best effort: one made in between goes with the row, as in the app).
  if (await splitStore.has(auth.ctx, id)) fail(409, 'conflict', 'This transaction is split: undo the split in the app first.');
  if (memberIndex(await groupStore.getAll(auth.ctx)).has(id)) fail(409, 'conflict', 'This transaction is in a group: take it out of the group in the app first.');
  const shown = await transactionAnswer(auth.ctx, id, now).catch(() => ({ transaction: null }));
  const said = await txnAnnotationStore.get(auth.ctx, id);
  if (saidVersion(said) !== want.said) stale();
  const day = await takeDay(auth, { create: false }, now);
  let before: ManualTxn | null = null;
  const change = await recorded(auth, input, 'transaction.delete', { kind: 'transaction', id, account_id: found.account_id }, async () => {
    const deleted = await removeManualTransaction(auth.ctx, id, found.account_id, {
      expect: (row) => {
        if (row.source !== 'manual') fail(403, 'forbidden', BANKS_ROW);
        if (rowVersion(row) !== want.row) stale();
        before = row;
      },
    });
    if (!deleted) fail(404, 'not_found', 'No transaction has that id: it may have been deleted.');
    return { before: txnState(before!, said), after: null };
  });
  return { status: 200, body: { deleted: true, ...shown, change_id: change }, headers: day };
}

// ---- Categories and groups ----

const CATEGORY_ROOM = Math.floor(MAX_CATEGORIES * API_ROOM);
const GROUP_ROOM = Math.floor(MAX_GROUPS * API_ROOM);

async function createCategory(auth: Authenticated, spec: ResourceSpec, input: ResourceInput): Promise<ResourceAnswer> {
  const a = input.args;
  return keyedCreate(auth, spec, input, {
    op: 'category.create',
    kind: 'category',
    mint: newCategoryId,
    make: async (id) => {
      try {
        const { taxonomy, category, created } = await addCategoryAs(auth.ctx, { name: a.name, group: a.group_id, icon: a.icon ?? undefined }, id, (t) => {
          if (t.categories.length >= CATEGORY_ROOM) {
            fail(409, 'conflict', `At most ${CATEGORY_ROOM} categories can be made through the API: the rest of the ${MAX_CATEGORIES} are kept for the categories your bank starts using.`);
          }
        });
        return { after: { category, group: taxonomy.groups.find((g) => g.id === category.group) }, made: created };
      } catch (err) {
        throw appRefusal(err) ?? err;
      }
    },
    locate: async (id) => {
      const t = await readTaxonomy(auth.ctx);
      return t?.categories.some((c) => c.id === id) ? 'live' : t?.merged && id in t.merged ? 'trace' : 'none';
    },
    answer: (id) => categoryAnswer(auth.ctx, id),
  });
}

async function updateCategory(auth: Authenticated, input: ResourceInput): Promise<ResourceAnswer> {
  const a = input.args;
  const id = input.id!;
  await categoryAnswer(auth.ctx, id); // a 404 before anything is counted
  const want = wanted(input);
  const day = await takeDay(auth, { create: false }, input.now);
  let before: Category | null = null;
  const change = await recorded(auth, input, 'category.update', { kind: 'category', id }, async () => {
    try {
      const t = await editCategory(
        auth.ctx,
        id,
        { name: a.name, group: a.group_id, icon: a.icon === null ? '' : a.icon, archived: a.archived as boolean | undefined },
        (c) => {
          if (!c) fail(404, 'not_found', 'No category has that id: list them with categories.');
          if (categoryVersion(c!) !== want) stale();
          before = c;
        }
      );
      return { before: { category: before }, after: { category: t.categories.find((c) => c.id === id) ?? null } };
    } catch (err) {
      throw appRefusal(err) ?? err;
    }
  });
  return { status: 200, body: { ...(await categoryAnswer(auth.ctx, id)), change_id: change }, headers: day };
}

async function createGroup(auth: Authenticated, spec: ResourceSpec, input: ResourceInput): Promise<ResourceAnswer> {
  const a = input.args;
  return keyedCreate(auth, spec, input, {
    op: 'group.create',
    kind: 'group',
    mint: newCategoryId,
    make: async (id) => {
      try {
        const { group, created } = await addGroupAs(auth.ctx, { name: a.name, kind: a.kind }, id, (t) => {
          if (t.groups.length >= GROUP_ROOM) fail(409, 'conflict', `At most ${GROUP_ROOM} category groups can be made through the API: the rest of the ${MAX_GROUPS} are kept for the app.`);
        });
        return { after: { group }, made: created };
      } catch (err) {
        throw appRefusal(err) ?? err;
      }
    },
    locate: async (id) => ((await readTaxonomy(auth.ctx))?.groups.some((g) => g.id === id) ? 'live' : 'none'),
    answer: (id) => groupAnswer(auth.ctx, id),
  });
}

async function updateGroup(auth: Authenticated, input: ResourceInput): Promise<ResourceAnswer> {
  const id = input.id!;
  await groupAnswer(auth.ctx, id);
  const want = wanted(input);
  const day = await takeDay(auth, { create: false }, input.now);
  let before: CategoryGroup | null = null;
  const change = await recorded(auth, input, 'group.update', { kind: 'group', id }, async () => {
    try {
      const t = await editGroup(auth.ctx, id, input.args.name, (g) => {
        if (!g) fail(404, 'not_found', 'No category group has that id: list them with categories.');
        if (groupVersion(g!) !== want) stale();
        before = g;
      });
      return { before: { group: before }, after: { group: t.groups.find((g) => g.id === id) ?? null } };
    } catch (err) {
      throw appRefusal(err) ?? err;
    }
  });
  return { status: 200, body: { ...(await groupAnswer(auth.ctx, id)), change_id: change }, headers: day };
}

// ---- Tags ----

const TAG_ROOM = Math.floor(MAX_TAGS * API_ROOM);

async function createTag(auth: Authenticated, spec: ResourceSpec, input: ResourceInput): Promise<ResourceAnswer> {
  const a = input.args;
  return keyedCreate(auth, spec, input, {
    op: 'tag.create',
    kind: 'tag',
    mint: newTagId,
    make: async (id) => {
      // A deletion left part way is finished first, as the app's own route
      // does; only here, so a create taken over still sees a tag being
      // deleted as made and removed since.
      await finishDeleting(auth.ctx);
      try {
        const { tag, created } = await addTagAs(
          auth.ctx,
          { name: a.name, color: a.color },
          id,
          (s) => {
            if (s.tags.length >= TAG_ROOM) fail(409, 'conflict', `At most ${TAG_ROOM} tags can be made through the API: the rest of the ${MAX_TAGS} are kept for the app.`);
          },
          new Date(input.now ?? Date.now())
        );
        return { after: { tag }, made: created };
      } catch (err) {
        throw appRefusal(err) ?? err;
      }
    },
    locate: async (id) => {
      const s = await readTagSet(auth.ctx);
      return s?.tags.some((t) => t.id === id) ? 'live' : s?.deleting?.includes(id) ? 'trace' : 'none';
    },
    answer: (id) => tagAnswer(auth.ctx, id),
  });
}

async function updateTag(auth: Authenticated, input: ResourceInput): Promise<ResourceAnswer> {
  const id = input.id!;
  await finishDeleting(auth.ctx);
  await tagAnswer(auth.ctx, id);
  const want = wanted(input);
  const day = await takeDay(auth, { create: false }, input.now);
  let before: Tag | null = null;
  const change = await recorded(auth, input, 'tag.update', { kind: 'tag', id }, async () => {
    try {
      const set: TagSet = await editTag(auth.ctx, id, { name: input.args.name, color: input.args.color }, (t) => {
        if (!t) fail(404, 'not_found', 'No tag has that id: list them with tags.');
        if (tagVersion(t!) !== want) stale();
        before = t;
      });
      return { before: { tag: before }, after: { tag: set.tags.find((t) => t.id === id) ?? null } };
    } catch (err) {
      throw appRefusal(err) ?? err;
    }
  });
  return { status: 200, body: { ...(await tagAnswer(auth.ctx, id)), change_id: change }, headers: day };
}

// ---- The record, for a token ----

/** A change as a token reads it, one of its own: the token by its hint (the
 *  caller's own, `hint`) and its name as it was. */
export function servedChange(id: string, c: Change, hint: string) {
  return {
    id,
    at: c.at,
    via: c.via,
    token: c.token ? { hint, label: c.token.label } : null,
    op: c.op,
    target: c.target,
    state: c.state,
    before: c.before ?? null,
    after: c.after ?? null,
    undoes: c.undoes ?? null,
    undone_by: c.undone_by ?? null,
    forgotten: !!c.forgotten_at,
  };
}

function encodeCursor(after: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify([after.at, after.id])).toString('base64url');
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    const [at, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[];
    if (typeof at === 'string' && typeof id === 'string' && !Number.isNaN(Date.parse(at)) && id.length <= 64) return { at, id };
  } catch {
    // Not one this API gave: refused below.
  }
  return fail(400, 'invalid_request', 'cursor is not one this API gave.');
}

async function listOwnChanges(auth: Authenticated, input: ResourceInput): Promise<ResourceAnswer> {
  const limit = (input.args.limit as number | undefined) ?? 25;
  const after = input.args.cursor ? decodeCursor(input.args.cursor as string) : null;
  const page = await listChanges(auth.ctx, { maker: tokenRef(auth.id), limit, after, now: input.now });
  return {
    status: 200,
    body: { changes: page.changes.map(([id, c]) => servedChange(id, c, hintOf(auth.id))), has_more: page.next !== null, next_cursor: page.next ? encodeCursor(page.next) : null },
    headers: {},
  };
}

// ---- Running one ----

/** What a read of one resource answers, with its version as an ETag. */
async function readOne(auth: Authenticated, spec: ResourceSpec, input: ResourceInput): Promise<ResourceAnswer> {
  const id = input.id!;
  const now = input.now ?? Date.now();
  const body =
    spec.name === 'manual-accounts.get'
      ? await accountAnswer(auth.ctx, id)
      : spec.name === 'transactions.get'
        ? await transactionAnswer(auth.ctx, id, now)
        : spec.name === 'categories.get'
          ? await categoryAnswer(auth.ctx, id)
          : spec.name === 'category-groups.get'
            ? await groupAnswer(auth.ctx, id)
            : await tagAnswer(auth.ctx, id);
  const version = (Object.values(body)[0] as { version?: string | null } | undefined)?.version;
  return { status: 200, body, headers: version ? { ETag: `"${version}"` } : {} };
}

/** The version a write's answer gives, as its ETag. */
function withEtag(answer: ResourceAnswer): ResourceAnswer {
  const first = Object.values(answer.body)[0] as { version?: string | null } | null | undefined;
  return first && typeof first === 'object' && first.version ? { ...answer, headers: { ...answer.headers, ETag: `"${first.version}"` } } : answer;
}

/**
 * Runs one operation on a resource, its input already read strictly against
 * its declared fields, after the gate (lib/api-run.ts). Checks what the
 * declarations say beyond each field (fields a body needs, fields it may not
 * mix, a version, the key's form), then does it. Throws ApiFailure,
 * BadRequest or NotFound for a refusal, and what storage throws.
 */
export async function runResource(auth: Authenticated, spec: ResourceSpec, input: ResourceInput): Promise<ResourceAnswer> {
  const a = input.args;
  for (const name of spec.required ?? []) {
    if (a[name] === undefined || a[name] === null) throw new BadRequest(`${name} is needed.`);
  }
  if (spec.method === 'PATCH' && !Object.values(a).some((v) => v !== undefined)) throw new BadRequest('Say what to change.');
  if (spec.apart) {
    const groups = spec.apart.filter((g) => g.some((k) => given(a, k)));
    if (groups.length > 1) throw new BadRequest(`Send ${spec.apart.map((g) => g.join(', ')).join(' and ')} in separate requests.`);
  }
  if (input.key != null && (!spec.keyed || !/^[\x21-\x7e]{1,255}$/.test(input.key))) {
    throw new BadRequest(spec.keyed ? 'An Idempotency-Key is 1 to 255 visible ASCII characters.' : 'This endpoint takes no Idempotency-Key.');
  }
  if (!spec.write && spec.method === 'GET' && spec.id) return readOne(auth, spec, input);
  switch (spec.name) {
    case 'manual-accounts.create':
      return withEtag(await createAccount(auth, spec, input));
    case 'manual-accounts.update':
      return withEtag(await updateAccount(auth, input));
    case 'manual-accounts.balance':
      return withEtag(await setBalance(auth, input));
    case 'transactions.create':
      return withEtag(await createTransaction(auth, spec, input));
    case 'transactions.update':
      return withEtag(await updateTransaction(auth, input));
    case 'transactions.delete':
      return deleteTransaction(auth, input);
    case 'categories.create':
      return withEtag(await createCategory(auth, spec, input));
    case 'categories.update':
      return withEtag(await updateCategory(auth, input));
    case 'category-groups.create':
      return withEtag(await createGroup(auth, spec, input));
    case 'category-groups.update':
      return withEtag(await updateGroup(auth, input));
    case 'tags.create':
      return withEtag(await createTag(auth, spec, input));
    case 'tags.update':
      return withEtag(await updateTag(auth, input));
    case 'changes.list':
      return listOwnChanges(auth, input);
    case 'changes.undo': {
      const { undoForToken } = await import('./api-undo');
      return undoForToken(auth, input);
    }
  }
  throw new Error(`No API operation is called ${spec.name}`);
}

