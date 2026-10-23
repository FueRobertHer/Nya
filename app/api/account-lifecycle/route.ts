import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { getItems } from '@/lib/storage';
import { getManualAccount, isManualId, MANUAL_CURRENCY } from '@/lib/manual';
import { findRememberedAccount, rememberedIdsForItem } from '@/lib/last-known';
import { directoryEntries, effectiveLinks, getLinks, liveAccountIds, sameAccountIds, withLinksLock, ForgetRefused, type Link } from '@/lib/links';
import { clearCaches, readCache, CacheKey } from '@/lib/cache';
import {
  lifecycleStore,
  markEnded,
  markStillOpen,
  reopenAccount,
  reopenMissing,
  removeUnreadable,
  effectiveLifecycle,
  lifecycleOf,
  endedNow,
  lastEndDay,
  isEndDay,
  isLifecycleNote,
  isRecordedBalance,
  LIFECYCLE_NOTE_MAX,
  type AccountAbout,
  type EndedLifecycle,
  type QuestionKind,
} from '@/lib/lifecycle';
import { storeFailure } from '@/lib/store-failure';
import { connectorAccountsStore } from '@/lib/connectors/store';

// Must match LINKS_LOCK_REQUEST_SECONDS (lib/links.ts): a request never
// outlives the lock it holds. A literal, as route segment config requires.
export const maxDuration = 120;

// One account's lifecycle (lib/lifecycle.ts), one account per request, for the
// reason app/api/hidden-accounts gives: a client's list can be stale, and a
// whole-list write would put back what it didn't know about. Every field is
// checked, and anything else refused:
//
//   { account_id, state: "closed" | "left", on, note?, balance? }   it ended on a day
//   { account_id, state: "untracked", from, balance? }              no longer followed from a day
//   { account_id, state: "active" }                       reopen: every end it has goes
//   { account_id, state: "active", answer, since }        "Still open", answering a question
//   { action: "repair", confirm: true }                   remove the entries whose bytes are damaged
//
// `balance` is the balance the person was shown when they said so (null when
// the app had none): a bank that goes on returning a closed or left account
// with another one is asked about again (lib/lifecycle-questions.ts). Saying
// the same end again with the balance shown now is "Still closed".
//
// Reopening an account its bank no longer returns (no live answer lists it,
// and its connection is still there) can't make it count again by itself:
// deleting its end would leave it nowhere while totals went on being saved
// without it. It is answered "Still open" instead, held at its last known
// balance and asked about as any missing account is (`held` in the answer).
//
// A day is a real calendar day, from 1970 on, and never after the person's
// today (lastEndDay: the UTC day after, for anyone east of Greenwich). An end
// is a fact about the past; nothing is recorded ahead of it.
//
// Writes go under the links lock, as hiding does: reopening clears every id the
// account has had, and must not land inside a forget. Nothing here touches
// the history layer: the end is applied when history is read. Both cached
// payloads embed it (net worth leaves the account out, transactions its rows
// from its end), so both are cleared.
//
// Ending the last open account of a Plaid connection answers with
// `remove_connection`: the dashboard then asks whether to remove the
// connection, through the same confirmation a removal always takes, since
// Plaid bills a connection until it is removed.
//
// Errors as on the storage seam (lib/store-failure.ts): 503 with no container,
// 409 for closures that can't be read (with the ids) or that kept changing,
// 413 for one too large, else 500. 400 for a request that isn't one of the
// above, 404 for an account Nya doesn't know.

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const KEYS: Record<string, readonly string[]> = {
  closed: ['account_id', 'state', 'on', 'note', 'balance'],
  left: ['account_id', 'state', 'on', 'note', 'balance'],
  untracked: ['account_id', 'state', 'from', 'balance'],
  active: ['account_id', 'state', 'answer', 'since'],
};

type Change =
  | { kind: 'end'; account_id: string; lifecycle: EndedLifecycle; seen?: { balance: number | null } }
  | { kind: 'reopen'; account_id: string }
  | { kind: 'still-open'; account_id: string; answered: { kind: QuestionKind; since: string } }
  | { kind: 'repair' };

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

/** The request as a change, or what is wrong with it, in the person's words. */
function parseChange(body: unknown, now: number = Date.now()): Change | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'Send what changed, as JSON';
  const b = body as Record<string, unknown>;
  if (b.action !== undefined) {
    if (b.action !== 'repair' || Object.keys(b).some((k) => k !== 'action' && k !== 'confirm')) return 'Unknown action';
    if (b.confirm !== true) return 'Removing damaged entries needs your confirmation';
    return { kind: 'repair' };
  }
  const { account_id, state } = b;
  if (typeof account_id !== 'string' || !ID.test(account_id) || account_id === '__proto__') return 'Invalid account id';
  if (typeof state !== 'string' || !Object.hasOwn(KEYS, state)) return 'The state is closed, left, untracked or active';
  const extra = Object.keys(b).find((k) => !KEYS[state].includes(k));
  if (extra) return `${extra.slice(0, 40)} isn't part of ${state === 'active' ? 'reopening' : `marking it ${state}`}`;
  const latest = lastEndDay(now);
  const day = (v: unknown, what: string): string | { error: string } => {
    if (!isEndDay(v)) return { error: `${what} is a date, YYYY-MM-DD, from 1970 on` };
    if (v > latest) return { error: `${what} can't be in the future` };
    return v;
  };
  let seen: { balance: number | null } | undefined;
  if (b.balance !== undefined) {
    if (!isRecordedBalance(b.balance)) return 'The balance is a number, or null';
    seen = { balance: b.balance };
  }
  if (state === 'closed' || state === 'left') {
    const on = day(b.on, 'The day it ended');
    if (typeof on !== 'string') return on.error;
    let note: string | undefined;
    if (b.note !== undefined && b.note !== null) {
      if (typeof b.note !== 'string') return 'The note is text';
      // One line, as a timeline note is: control characters become spaces.
      const clean = b.note.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (clean.length > LIFECYCLE_NOTE_MAX) return `The note is at most ${LIFECYCLE_NOTE_MAX} characters`;
      if (clean && !isLifecycleNote(clean)) return 'The note is one line of text';
      if (clean) note = clean;
    }
    return { kind: 'end', account_id, lifecycle: { state, on, ...(note ? { note } : {}) }, ...(seen ? { seen } : {}) };
  }
  if (state === 'untracked') {
    const from = day(b.from, 'The day to stop following it from');
    if (typeof from !== 'string') return from.error;
    return { kind: 'end', account_id, lifecycle: { state, from }, ...(seen ? { seen } : {}) };
  }
  if (b.answer === undefined && b.since === undefined) return { kind: 'reopen', account_id };
  if (b.answer !== 'missing' && b.answer !== 'zero') return 'The answer is to the question about a missing account or a zero balance';
  const since = day(b.since, 'The question’s day');
  if (typeof since !== 'string') return since.error;
  return { kind: 'still-open', account_id, answered: { kind: b.answer, since } };
}

/** What an entry needs to know about the account (its kind, its name, its
 *  connection, and its currency where known), from wherever Nya has it: a
 *  manual account's own record; the entry it has already; the entry of an
 *  account SimpleFIN keeps up to date; the dashboard's cached payload; its
 *  institution's remembered accounts; the account directory, which outlives
 *  a disconnect, and a restore (its currency where it was kept). Null for an
 *  account none of them knows. */
async function aboutAccount(ctx: Ctx, account_id: string): Promise<AccountAbout | null> {
  if (isManualId(account_id)) {
    const m = await getManualAccount(ctx, account_id);
    // A manual account's balance is in its own currency (lib/manual.ts: the
    // one chosen for it, or kept from a connector; US dollars when none).
    if (m) return { type: m.type, label: { name: m.name, institution: m.institution_name, mask: null }, item_id: null, currency: m.currency ?? MANUAL_CURRENCY };
  }
  const existing = await lifecycleStore.get(ctx, account_id);
  if (existing) return { type: existing.type, label: existing.label, item_id: existing.item_id, currency: existing.currency };
  if (isManualId(account_id)) {
    // An account SimpleFIN keeps up to date has a manual account's kind of id
    // and its own entry (lib/connectors/store.ts). It is no Plaid
    // connection's, so `item_id` stays null: nothing Plaid's (the guard on a
    // missing account, the offer to remove a connection) reaches for it.
    const fed = await connectorAccountsStore.get(ctx, account_id);
    return fed ? { type: fed.type, label: { name: fed.name, institution: fed.institution_name, mask: null }, item_id: null, currency: fed.currency } : null;
  }

  const cached = await readCache<{ institutions?: any[] }>(ctx, CacheKey.NetWorth);
  for (const inst of cached?.institutions ?? []) {
    const a = inst?.accounts?.find((x: any) => x?.account_id === account_id);
    if (a && typeof a.type === 'string' && !inst.manual) {
      return {
        type: a.type,
        label: { name: String(a.name ?? ''), institution: String(inst.institution_name ?? ''), mask: a.mask ?? null },
        item_id: inst.item_id,
        currency: typeof a.currency === 'string' ? a.currency : null,
      };
    }
  }
  const items = await getItems(ctx);
  const remembered = await findRememberedAccount(ctx, account_id);
  if (remembered) {
    const item = items.find((i) => i.item_id === remembered.item_id);
    return {
      type: remembered.account.type,
      label: { name: remembered.account.name, institution: item?.institution_name ?? '', mask: remembered.account.mask },
      item_id: remembered.item_id,
      currency: remembered.account.currency,
    };
  }
  const known = (await directoryEntries(ctx, [account_id]))[account_id];
  if (known) {
    return {
      type: known.type,
      label: { name: known.name ?? known.official_name ?? 'Account', institution: known.institution_name, mask: known.mask },
      item_id: known.item_id,
      currency: known.currency ?? null,
    };
  }
  return null;
}

/** The links that apply now, read strictly: a write that follows them must
 *  not take a paused one for active (as Unhide reads them). */
async function activeLinks(ctx: Ctx) {
  return effectiveLinks(await getLinks(ctx), await liveAccountIds(ctx, { strict: true }));
}

/** The end that applies to an account its bank no longer returns, when it has
 *  one: linked (not manual), its connection still stored, and no id it has
 *  had among the accounts a live answer lists. Null otherwise: reopening it
 *  then counts it again at once. Strict, as the write it decides is. */
async function missingFromItsBank(ctx: Ctx, account_id: string, links: Map<string, Link>) {
  if (isManualId(account_id)) return null;
  const [entries, live, items] = await Promise.all([lifecycleStore.getAll(ctx), liveAccountIds(ctx, { strict: true }), getItems(ctx)]);
  const entry = lifecycleOf(effectiveLifecycle(entries, links), account_id);
  if (!entry || entry.lifecycle.state === 'active' || !entry.item_id || !items.some((i) => i.item_id === entry.item_id)) return null;
  return sameAccountIds(account_id, links).some((id) => live.has(id)) ? null : entry;
}

/** Whether every account of a Plaid connection has ended now: the prompt to
 *  remove it. Its accounts as its last answer listed them (with any held
 *  for an answer); none listed, or a read that fails, asks nothing. */
async function lastOpenEnded(ctx: Ctx, item_id: string | null, now: number): Promise<{ item_id: string; institution_name: string } | null> {
  if (!item_id) return null;
  try {
    const [ids, items, entries, links] = await Promise.all([rememberedIdsForItem(ctx, item_id), getItems(ctx), lifecycleStore.getAll(ctx), activeLinks(ctx)]);
    const item = items.find((i) => i.item_id === item_id);
    if (!item || ids.length === 0) return null;
    const view = effectiveLifecycle(entries, links);
    const ended = (id: string) => {
      const root = view.rootOf.get(id);
      const entry = root ? view.accounts.get(root)?.entry : undefined;
      return !!entry && endedNow(entry.lifecycle, now);
    };
    return ids.every(ended) ? { item_id, institution_name: item.institution_name } : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return bad('Send what changed, as JSON');
    }
    const now = Date.now();
    const change = parseChange(body, now);
    if (typeof change === 'string') return bad(change);

    if (change.kind === 'repair') {
      const { removed, unrecognised } = await withLinksLock(ctx, () => removeUnreadable(ctx));
      if (removed.length > 0) await clearCaches(ctx);
      return NextResponse.json({ removed: removed.length, unrecognised_ids: unrecognised });
    }

    // Looked up before the lock: it can take a few reads.
    const about = change.kind === 'reopen' ? null : await aboutAccount(ctx, change.account_id);
    if (change.kind !== 'reopen' && !about) {
      return NextResponse.json({ error: 'That account isn’t one Nya knows' }, { status: 404 });
    }

    return await withLinksLock(ctx, async () => {
      if (change.kind === 'reopen') {
        const links = await activeLinks(ctx);
        const missing = await missingFromItsBank(ctx, change.account_id, links);
        if (missing) {
          await reopenMissing(ctx, change.account_id, missing, links, now);
          await clearCaches(ctx);
          return NextResponse.json({ account_id: change.account_id, lifecycle: { state: 'active' }, reopened: true, held: true });
        }
        const gone = await reopenAccount(ctx, change.account_id, links, now);
        await clearCaches(ctx);
        return NextResponse.json({ account_id: change.account_id, lifecycle: { state: 'active' }, reopened: gone.length > 0 });
      }
      // The links, for the one note an account keeps: read leniently, since a
      // note is best effort and the change itself doesn't need them.
      const links = await activeLinks(ctx).catch(() => new Map<string, never>());
      if (change.kind === 'still-open') {
        const entry = await markStillOpen(ctx, change.account_id, change.answered, about!, now, links);
        await clearCaches(ctx);
        return NextResponse.json({ account_id: change.account_id, lifecycle: entry.lifecycle });
      }
      const entry = await markEnded(ctx, change.account_id, change.lifecycle, about!, now, links, change.seen);
      await clearCaches(ctx);
      const remove = await lastOpenEnded(ctx, entry.item_id, now);
      return NextResponse.json({ account_id: change.account_id, lifecycle: entry.lifecycle, ...(remove ? { remove_connection: remove } : {}) });
    });
  } catch (err) {
    if (err instanceof ForgetRefused) return NextResponse.json({ error: err.message }, { status: 409 });
    return storeFailure(err, 'Failed to save that account’s change');
  }
}
