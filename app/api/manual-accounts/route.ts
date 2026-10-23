import { NextResponse } from 'next/server';
import { dataCtx, containerUnavailable } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { getManualAccounts, getManualAccount, setManualCurrency, isManualId, newManualId, MANUAL_CURRENCY, MAX_MANUAL_ACCOUNTS } from '@/lib/manual';
import { AccountEditRefused, createManualAccount, CURRENCY_ERROR, currencyOf, invalidate, saveAccountEdit, validateAccountFields as validate } from '@/lib/manual-account-writes';
import { deleteManualAccount } from '@/lib/manual-account-delete';
import { followAccountCurrency } from '@/lib/import/commit';
import { relabelCount, relabelTypedRows, type RelabelResult } from '@/lib/manual-relabel';
import { StoredDataUnreadableError } from '@/lib/stored-json';
import { loggable } from '@/lib/log-safe';

// CRUD for manually-tracked accounts, deliberately ONE ACCOUNT PER REQUEST.
//
// The /api/goals shape (the client PUTs the whole list) is unsafe here. The
// client's list comes from the last /api/net-worth payload, which can be stale (a
// tab left open, a second device, the localStorage snapshot painted before the
// network load resolves) or *empty* (a manual-accounts read failure renders as an
// institution with an error and no accounts). A whole-list write from those
// states would delete every account the client didn't know about, and each
// deletion orphans that account's balance history permanently, since re-adding
// mints a new random id.
//
// Per-account operations remove the class: a request can only affect the account
// it names. It also means a scheduled push to /api/ingest/balance can't be
// reverted by an unrelated edit made in a stale tab.
//
// ITS CURRENCY is chosen when it is made or updated (`currency`, an ISO code;
// US dollars when a request names none, as every account made before it could
// be chosen is), and stored with it (lib/manual.ts currencyField). Choosing it
// never changes the balance's number. An update that names none keeps the
// account's own, so a page from before keeps it too. PATCH with only
// `account_id` and `currency` sets the currency alone (the choice of a home
// currency corrects one there), leaving the balance as stored. A correction
// changes nothing else: the transactions already on the account keep their
// own currency, and what its last imported files taught follows it
// (lib/import/commit.ts followAccountCurrency), so the next file is read in
// the new one. Only when the person confirms it (`relabel_from`, the currency
// the account was in), the rows they typed on it move into the new one too
// (lib/manual-relabel.ts: never one imported, split or in a group), in one
// write of its book, and the answer says how many (`relabelled`). What the
// offer to move them shows is counted here too, before anything is written:
// GET with `account_id`, `relabel_from` and `currency` answers `relabel`
// ({ moved, kept }), every row the move would take, older ones too. A move
// has no undo (lib/manual-relabel.ts).
//
// What is stored, refused and cleared is lib/manual-account-writes.ts, which
// the API's writes call too, so the two never differ: each write is one
// compare-and-set on the account's field, and a change of type, like a moved
// balance, clears the backfill flag.

/** The currency the rows typed on the account were entered in, to move into
 *  its corrected one (see the header): undefined when the request asks for
 *  no move. */
function relabelFrom(body: unknown): { error: string } | { from: string | undefined } {
  const given = body && typeof body === 'object' ? (body as { relabel_from?: unknown }).relabel_from : undefined;
  const c = currencyOf(given);
  return 'error' in c ? c : { from: c.currency };
}

/** The rows typed in `from` moved into `to`, when asked. Their book, a split
 *  or a group that can't be read moves none: said (409), the currency kept. */
async function relabel(ctx: Ctx, account_id: string, from: string | undefined, to: string): Promise<RelabelResult | null> {
  if (from === undefined || from === to) return null;
  return relabelTypedRows(ctx, account_id, from, to);
}

const RELABEL_UNREAD = "Its currency is saved, but the transactions on it couldn't be read, so none of them was moved. Try again once they can be read.";

/** relabel, or 'unread' when what it reads couldn't be. */
async function relabelOrSay(ctx: Ctx, account_id: string, from: string | undefined, to: string): Promise<RelabelResult | null | 'unread'> {
  try {
    return await relabel(ctx, account_id, from, to);
  } catch (err) {
    if (err instanceof StoredDataUnreadableError) return 'unread';
    throw err;
  }
}


/** The count the offer to move an account's typed rows shows (see the
 *  header): what the move would take now, nothing written. */
async function relabelCountAnswer(ctx: Ctx, q: URLSearchParams): Promise<NextResponse> {
  const account_id = String(q.get('account_id') ?? '').slice(0, 80);
  if (!account_id || !isManualId(account_id)) return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
  const from = currencyOf(q.get('relabel_from') ?? undefined);
  const to = currencyOf(q.get('currency') ?? undefined);
  if ('error' in from || 'error' in to || from.currency === undefined || to.currency === undefined) return NextResponse.json({ error: CURRENCY_ERROR }, { status: 400 });
  try {
    return NextResponse.json({ relabel: await relabelCount(ctx, account_id, from.currency, to.currency) });
  } catch (err) {
    if (err instanceof StoredDataUnreadableError) return NextResponse.json({ error: RELABEL_COUNT_UNREAD }, { status: 409 });
    throw err;
  }
}

const RELABEL_COUNT_UNREAD = "The transactions on it couldn't be read, so none of them can be moved with it now.";

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    const q = new URL(req.url).searchParams;
    if (q.has('relabel_from')) return await relabelCountAnswer(ctx, q);
    return NextResponse.json({ accounts: await getManualAccounts(ctx) });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to load manual accounts' }, { status: 500 });
  }
}

/** Creates one account. The id is minted server-side so a client can't choose
 *  one that collides with an existing account's history. */
export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await req.json();
    const result = validate(body);
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 });

    // Throws (and 500s) rather than treating an unreadable hash as empty.
    const made = await createManualAccount(ctx, result.value, result.currency, { id: newManualId() });
    if ('limit' in made) {
      return NextResponse.json(
        { error: `At most ${MAX_MANUAL_ACCOUNTS} manual accounts` },
        { status: 400 }
      );
    }
    return NextResponse.json({ account: made.account });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to add manual account' }, { status: 500 });
  }
}

/** Updates one existing account in place. Only the named account is written. */
export async function PATCH(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await req.json();
    const account_id = String(body?.account_id ?? '').slice(0, 80);
    if (!account_id || !isManualId(account_id)) {
      return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
    }
    const moving = relabelFrom(body);
    if ('error' in moving) return NextResponse.json({ error: moving.error }, { status: 400 });
    // The currency alone, as one compare-and-set: nothing else is written.
    if (body && typeof body === 'object' && 'currency' in body && Object.keys(body).every((k) => k === 'account_id' || k === 'currency' || k === 'relabel_from')) {
      const given = currencyOf(body.currency);
      if ('error' in given || given.currency === undefined) return NextResponse.json({ error: CURRENCY_ERROR }, { status: 400 });
      const set = await setManualCurrency(ctx, account_id, given.currency);
      if (set === 'missing') return NextResponse.json({ error: 'That account no longer exists' }, { status: 404 });
      if (set !== 'same') {
        await followAccountCurrency(ctx, account_id, set.from, given.currency);
        // A currency moves no balance: the estimated history stays as it is.
        await invalidate(ctx, false);
      }
      // Asked again after a move that couldn't be made: made now.
      const relabelled = await relabelOrSay(ctx, account_id, moving.from, given.currency);
      if (relabelled === 'unread') return NextResponse.json({ error: RELABEL_UNREAD, account: await getManualAccount(ctx, account_id) }, { status: 409 });
      if (relabelled && relabelled.moved > 0 && set === 'same') await invalidate(ctx, false);
      return NextResponse.json({ account: await getManualAccount(ctx, account_id), ...(relabelled ? { relabelled } : {}) });
    }
    const result = validate(body);
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 });

    // Every field the form sends, the currency the one chosen or, from a page
    // that names none, its own; one compare-and-set (lib/manual-account-writes.ts).
    let saved;
    try {
      saved = await saveAccountEdit(ctx, account_id, { fields: result.value, currency: result.currency });
    } catch (err) {
      if (err instanceof AccountEditRefused) return NextResponse.json({ error: err.message }, { status: err.status });
      throw err;
    }
    if (!saved) {
      return NextResponse.json({ error: 'That account no longer exists' }, { status: 404 });
    }
    const { account } = saved;
    const currency = account.currency ?? MANUAL_CURRENCY;
    // The rows typed on it, moved into its new currency when the person said so.
    const relabelled = await relabelOrSay(ctx, account_id, moving.from, currency);
    if (relabelled === 'unread') return NextResponse.json({ error: RELABEL_UNREAD, account }, { status: 409 });
    return NextResponse.json({ account, ...(relabelled ? { relabelled } : {}) });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to update manual account' }, { status: 500 });
  }
}

/** Removes one account, and the transactions entered on it. Its balance history
 *  is intentionally left in place: history is keyed by date, not account, and
 *  rewriting past dates is something this app never does. The orphaned series
 *  is unreachable once the account is gone. */
export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await req.json();
    const account_id = String(body?.account_id ?? '').slice(0, 80);
    if (!account_id || !isManualId(account_id)) {
      return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
    }
    // Its imports, its transactions with what was said about them, then the
    // account, in the order lib/manual-account-delete.ts says why.
    await deleteManualAccount(ctx, account_id);
    await invalidate(ctx, true);
    return NextResponse.json({ success: true });
  } catch (err) {
    const unavailable = containerUnavailable(err);
    if (unavailable) return unavailable;
    console.error(loggable(err));
    return NextResponse.json({ error: 'Failed to remove manual account' }, { status: 500 });
  }
}
