import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { getManualAccount, isManualId, moveManualBalance, MAX_BALANCE, type ManualAccount } from '@/lib/manual';
import { isOwedType } from '@/lib/balance';
import { clearNetWorthCache } from '@/lib/cache';
import { clearBackfillDone } from '@/lib/history';
import { balanceAfter, readTxnFields, DEFAULT_CURRENCY } from '@/lib/manual-txn-input';
import {
  addManualTxn,
  deleteManualTxn,
  editManualTxn,
  InvalidTxnError,
  isManualTxnId,
  locateManualTxn,
  manualRowForDisplay,
  newManualTxn,
  newManualTxnId,
  noteBalanceUpdate,
  removeAccountTxns,
  type ManualTxn,
  type ManualTxnChanges,
} from '@/lib/manual-txns';
import { forgetAnnotations } from '@/lib/txn-annotations';
import { storeFailure } from '@/lib/store-failure';
import { formatMoney } from '@/lib/format';
import { loggable } from '@/lib/log-safe';

// Transactions on manual accounts (lib/manual-txns.ts), ONE ROW PER REQUEST:
// POST adds one, PATCH changes one, DELETE removes one, each named by its id,
// so a stale page can only touch the row it acted on (the reasoning of
// app/api/manual-accounts). Each answers with the row as the Activity tab
// shows it, for the page to put in its list. The transactions route reads
// these rows on every request, after its cache of Plaid's, so nothing here
// drops a cache but net worth's, when a balance moves.
//
// AN ADD IS SENT ONCE OR MORE. The form makes the row's id when it opens, so
// an add sent again (its answer lost on a phone's connection) finds its row
// already there, writes nothing and answers with it (`added` false). A
// request without an id gets a new one: a script that wants the same safety
// sends its own.
//
// A manual account's balance stays what was typed. A new row moves it only
// when the request asks (`update_balance: { from, to }`, the balance the form
// showed and the one it said it would become), and only from exactly that
// figure: a balance changed since (another device, a scripted push) or an
// account whose type changed (which flips the direction) is refused before
// anything is saved, never overwritten. The move is one compare-and-set
// (lib/manual.ts moveManualBalance), noted on the row once made, so the same
// add sent again moves it once; then, as the account's Update form does, the
// estimated history is set to be rebuilt and the net-worth cache dropped, and
// the client reloads net worth, which records it in the real history layer
// like any typed balance. Editing or deleting a row never changes the
// balance.

/** Far more than any one transaction's fields need. */
const MAX_BODY_CHARS = 8 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const today = () => new Date().toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100);

/** The body as an object, or the response refusing it. */
async function readBody(req: Request): Promise<Record<string, unknown> | NextResponse> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
  try {
    const body = JSON.parse(text);
    if (isRecord(body)) return body;
  } catch {
    // Not JSON: refused below.
  }
  return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
}

const isAccountId = (v: unknown): v is string => typeof v === 'string' && v.length <= 80 && isManualId(v);

/** One of the container's manual accounts, or the response saying it isn't. */
async function manualAccount(ctx: Ctx, account_id: unknown): Promise<ManualAccount | NextResponse> {
  if (!isAccountId(account_id)) return NextResponse.json({ error: 'Choose one of your manual accounts' }, { status: 400 });
  // Strict: an account that can't be read throws, rather than reading as gone.
  const account = await getManualAccount(ctx, account_id);
  return account ?? NextResponse.json({ error: 'That account no longer exists' }, { status: 404 });
}

/** The balance move a request asks for: from the balance its form showed to
 *  the one it said. */
function readUpdateBalance(v: unknown): { from: number; to: number } | null | 'invalid' {
  if (v === undefined || v === null || v === false) return null;
  if (!isRecord(v)) return 'invalid';
  const { from, to } = v;
  if (typeof from !== 'number' || !Number.isFinite(from) || typeof to !== 'number' || !Number.isFinite(to)) return 'invalid';
  return { from, to };
}

/** The row as the Activity tab shows it, on the account it is on now. */
async function shown(ctx: Ctx, row: ManualTxn, account: ManualAccount) {
  const on = row.account_id === account.account_id ? account : await getManualAccount(ctx, row.account_id).catch(() => null);
  return on ? manualRowForDisplay(on, row) : manualRowForDisplay(account, { ...row, account_id: account.account_id });
}

/** Adds one transaction, once, and moves the account's balance too when asked. */
export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readBody(req);
    if (body instanceof NextResponse) return body;
    if (body.id !== undefined && !isManualTxnId(body.id)) return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    const id = (body.id as string | undefined) ?? newManualTxnId();
    const read = readTxnFields(body, { partial: false, today: today() });
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: 400 });
    const fields = { date: read.fields.date!, amount: read.fields.amount!, currency: read.fields.currency!, name: read.fields.name!, category: read.fields.category ?? null, note: read.fields.note ?? null };
    const update = readUpdateBalance(body.update_balance);
    if (update === 'invalid') return NextResponse.json({ error: 'Invalid balance update' }, { status: 400 });
    const account = await manualAccount(ctx, body.account_id);
    if (account instanceof NextResponse) return account;

    // Everything about the balance that the request alone decides is checked
    // before anything is written.
    if (update) {
      // Manual balances are kept in US dollars (lib/manual.ts toInstitutions):
      // an amount in another currency can't be taken off one.
      if (fields.currency !== DEFAULT_CURRENCY) {
        return NextResponse.json(
          { error: `${account.name}'s balance is kept in ${DEFAULT_CURRENCY}, so a transaction in ${fields.currency} can't update it.` },
          { status: 400 }
        );
      }
      // The figure the form said must be what this transaction makes of the
      // figure it showed, for the account as it is: one whose type changed
      // since (held to owed) would move the other way.
      if (cents(balanceAfter(update.from, fields.amount, isOwedType(account.type))) !== cents(update.to)) {
        return NextResponse.json(
          { error: `${account.name} changed since this form opened, so nothing was saved. Check it and save again.`, balance: account.balance },
          { status: 409 }
        );
      }
      if (Math.abs(update.to) > MAX_BALANCE) return NextResponse.json({ error: 'That would make the balance too large' }, { status: 400 });
      // As the Update form refuses one (app/api/manual-accounts): an amount
      // owed below zero would count as money held.
      if (isOwedType(account.type) && update.to < 0) {
        return NextResponse.json(
          { error: `That would make the amount owed on ${account.name} negative. Save the transaction without updating the balance, then update the balance itself.` },
          { status: 400 }
        );
      }
    }

    // The same add sent again: its row is stored already, maybe moved or
    // edited since. Nothing is added; the balance below moves only if this add
    // hasn't moved it yet.
    const there = await locateManualTxn(ctx, id);
    let row: ManualTxn;
    let added = false;
    if (there) {
      row = there.row;
    } else {
      // The balance the form showed must still be the account's: else saving
      // would record a figure the person never saw. Refused, and said.
      if (update && cents(update.from) !== cents(account.balance)) {
        return NextResponse.json(
          {
            error: `${account.name}'s balance changed to ${formatMoney(account.balance, DEFAULT_CURRENCY)} since this form opened, so nothing was saved. Check it and save again.`,
            balance: account.balance,
          },
          { status: 409 }
        );
      }
      ({ row, added } = await addManualTxn(ctx, newManualTxn(account.account_id, fields, new Date(), id)));
      // An account deleted while this was saved (app/api/manual-accounts
      // DELETE) mustn't be left a book nothing shows: its row goes with it.
      if (added && !(await getManualAccount(ctx, account.account_id))) {
        await removeAccountTxns(ctx, account.account_id);
        return NextResponse.json({ error: 'That account no longer exists' }, { status: 404 });
      }
    }

    const transaction = await shown(ctx, row, account);
    if (row.balance_update) {
      // Moved by this add already: never again.
      return NextResponse.json({ transaction, added, balance_updated: true, balance: row.balance_update.to });
    }
    if (!update) return NextResponse.json({ transaction, added, balance_updated: false });

    let moved: Awaited<ReturnType<typeof moveManualBalance>>;
    try {
      moved = await moveManualBalance(ctx, account.account_id, update.from, update.to);
      if (moved === 'moved' || moved === 'already') {
        // Noted first, so a retry finds it whatever fails after. Then, as the
        // Update form (app/api/manual-accounts PATCH) does: flag first, cache
        // second, for the reason given there.
        await noteBalanceUpdate(ctx, row.id, account.account_id, update);
        await clearBackfillDone(ctx);
        await clearNetWorthCache(ctx);
        return NextResponse.json({ transaction, added, balance_updated: true, balance: update.to });
      }
    } catch (err) {
      console.error(loggable(err));
      return NextResponse.json(
        { error: `The transaction was saved, but ${account.name}'s balance couldn't be updated. Update it from the account.`, transaction, added, balance_updated: false, saved: true },
        { status: 500 }
      );
    }
    // Changed between the check above and the move, or the account went.
    return NextResponse.json(
      {
        error:
          moved === 'missing'
            ? 'The transaction was saved, but its account no longer exists.'
            : `The transaction was saved, but ${account.name}'s balance changed meanwhile, so it wasn't updated. Check it on the account.`,
        transaction,
        added,
        balance_updated: false,
        saved: true,
      },
      { status: 409 }
    );
  } catch (err) {
    return storeFailure(err, 'Failed to add the transaction');
  }
}

/**
 * Changes one transaction: any of its fields, or the account it is on
 * (`move_to`). `account_id` is the account the page shows it on, so only that
 * book is read; without it every book is.
 */
export async function PATCH(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readBody(req);
    if (body instanceof NextResponse) return body;
    if (!isManualTxnId(body.id)) return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    if (body.account_id !== undefined && !isAccountId(body.account_id)) return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
    const read = readTxnFields(body, { partial: true, today: today() });
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: 400 });
    const changes: ManualTxnChanges = { ...read.fields };
    let target: ManualAccount | null = null;
    if (body.move_to !== undefined) {
      const account = await manualAccount(ctx, body.move_to);
      if (account instanceof NextResponse) return account;
      target = account;
      changes.account_id = account.account_id;
    }
    if (Object.keys(changes).length === 0) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });

    const saved = await editManualTxn(ctx, body.id, changes, { from: body.account_id as string | undefined });
    if (!saved) return NextResponse.json({ error: 'That transaction was deleted or moved since this page loaded. Reload to see it.' }, { status: 404 });
    // Moved into an account deleted meanwhile: the row goes with it, as the
    // account's rows do (app/api/manual-accounts DELETE). An edit in place
    // can't bring a deleted book back: it writes only where its row is.
    if (target && !(await getManualAccount(ctx, target.account_id))) {
      await removeAccountTxns(ctx, target.account_id);
      return NextResponse.json({ error: 'That account no longer exists' }, { status: 404 });
    }
    const on = target ?? (await getManualAccount(ctx, saved.account_id));
    if (!on) return NextResponse.json({ error: 'That account no longer exists' }, { status: 404 });
    return NextResponse.json({ transaction: manualRowForDisplay(on, saved) });
  } catch (err) {
    if (err instanceof InvalidTxnError) return NextResponse.json({ error: err.message }, { status: 400 });
    return storeFailure(err, 'Failed to save the transaction');
  }
}

/** Removes one transaction, and what was said about it. Removing one that is
 *  already gone succeeds: what was asked for is true. `account_id` is the
 *  account the page shows it on, as for PATCH. */
export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readBody(req);
    if (body instanceof NextResponse) return body;
    if (!isManualTxnId(body.id)) return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    if (body.account_id !== undefined && !isAccountId(body.account_id)) return NextResponse.json({ error: 'Invalid account id' }, { status: 400 });
    const deleted = await deleteManualTxn(ctx, body.id, body.account_id as string | undefined);
    // Best effort: an exclusion left behind names a row that no longer exists,
    // which is never shown.
    await forgetAnnotations(ctx, [body.id]).catch((err) => console.warn('manual-transactions: an exclusion was left behind', loggable(err)));
    return NextResponse.json({ success: true, deleted });
  } catch (err) {
    return storeFailure(err, 'Failed to delete the transaction');
  }
}
