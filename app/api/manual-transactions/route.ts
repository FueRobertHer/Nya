import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { getManualAccount, isManualId, saveManualAccount, MAX_BALANCE, type ManualAccount } from '@/lib/manual';
import { isOwedType } from '@/lib/balance';
import { clearCaches, clearTransactionsCache } from '@/lib/cache';
import { clearBackfillDone } from '@/lib/history';
import { balanceAfter, readTxnFields, DEFAULT_CURRENCY } from '@/lib/manual-txn-input';
import { addManualTxn, deleteManualTxn, editManualTxn, isManualTxnId, newManualTxn, type ManualTxnChanges } from '@/lib/manual-txns';
import { forgetAnnotations } from '@/lib/txn-annotations';
import { storeFailure } from '@/lib/store-failure';
import { formatMoney } from '@/lib/format';
import { loggable } from '@/lib/log-safe';

// Transactions on manual accounts (lib/manual-txns.ts), ONE ROW PER REQUEST:
// POST adds one, PATCH changes one, DELETE removes one, each named by its id,
// so a stale page can only touch the row it acted on (the reasoning of
// app/api/manual-accounts). Every write drops the cached transactions, which
// hold the old rows.
//
// A manual account's balance stays what was typed. A new row moves it only
// when the request asks (`update_balance`), and then as the account's Update
// form does: the new balance stamped now, the estimated history set to be
// rebuilt and every cache dropped; the client then reloads net worth, which
// records it in the real history layer like any typed balance. Editing or
// deleting a row never changes the balance.

/** Far more than any one transaction's fields need. */
const MAX_BODY_CHARS = 8 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const today = () => new Date().toISOString().slice(0, 10);

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

/** One of the container's manual accounts, or the response saying it isn't. */
async function manualAccount(ctx: Ctx, account_id: unknown): Promise<ManualAccount | NextResponse> {
  if (typeof account_id !== 'string' || account_id.length > 80 || !isManualId(account_id)) {
    return NextResponse.json({ error: 'Choose one of your manual accounts' }, { status: 400 });
  }
  // Strict: an account that can't be read throws, rather than reading as gone.
  const account = await getManualAccount(ctx, account_id);
  return account ?? NextResponse.json({ error: 'That account no longer exists' }, { status: 404 });
}

/** The balance a request asks to update from: the balance its form showed. */
function readUpdateBalance(v: unknown): { from: number } | null | 'invalid' {
  if (v === undefined || v === null || v === false) return null;
  if (!isRecord(v) || typeof v.from !== 'number' || !Number.isFinite(v.from)) return 'invalid';
  return { from: v.from };
}

/** Adds one transaction, and updates the account's balance too when asked. */
export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readBody(req);
    if (body instanceof NextResponse) return body;
    const read = readTxnFields(body, { partial: false, today: today() });
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: 400 });
    const fields = { date: read.fields.date!, amount: read.fields.amount!, currency: read.fields.currency!, name: read.fields.name!, category: read.fields.category ?? null, note: read.fields.note ?? null };
    const update = readUpdateBalance(body.update_balance);
    if (update === 'invalid') return NextResponse.json({ error: 'Invalid balance update' }, { status: 400 });
    const account = await manualAccount(ctx, body.account_id);
    if (account instanceof NextResponse) return account;

    // Everything about the balance is checked before anything is written.
    let balance: number | null = null;
    if (update) {
      // Manual balances are kept in US dollars (lib/manual.ts toInstitutions):
      // an amount in another currency can't be taken off one.
      if (fields.currency !== DEFAULT_CURRENCY) {
        return NextResponse.json(
          { error: `${account.name}'s balance is kept in ${DEFAULT_CURRENCY}, so a transaction in ${fields.currency} can't update it.` },
          { status: 400 }
        );
      }
      // The form showed a balance and what it would become. If the balance has
      // changed since (another device, a scripted push), saving would record a
      // figure the person never saw: refuse, and say what it is now.
      if (Math.round(update.from * 100) !== Math.round(account.balance * 100)) {
        return NextResponse.json(
          {
            error: `${account.name}'s balance changed to ${formatMoney(account.balance, DEFAULT_CURRENCY)} since this form opened, so nothing was saved. Check it and save again.`,
            balance: account.balance,
          },
          { status: 409 }
        );
      }
      const owed = isOwedType(account.type);
      balance = balanceAfter(account.balance, fields.amount, owed);
      if (Math.abs(balance) > MAX_BALANCE) return NextResponse.json({ error: 'That would make the balance too large' }, { status: 400 });
      // As the Update form refuses one (app/api/manual-accounts): an amount
      // owed below zero would count as money held.
      if (owed && balance < 0) {
        return NextResponse.json(
          { error: `That would make the amount owed on ${account.name} negative. Save the transaction without updating the balance, then update the balance itself.` },
          { status: 400 }
        );
      }
    }

    const row = newManualTxn(account.account_id, fields);
    await addManualTxn(ctx, row);
    if (balance === null) {
      await clearTransactionsCache(ctx);
      return NextResponse.json({ transaction: row, balance_updated: false });
    }
    try {
      // The Update form's write (app/api/manual-accounts PATCH): flag first,
      // caches second, for the reason given there.
      await saveManualAccount(ctx, { ...account, balance, updated_at: new Date().toISOString() });
      await clearBackfillDone(ctx);
    } catch (err) {
      console.error(loggable(err));
      await clearTransactionsCache(ctx);
      return NextResponse.json(
        { error: `The transaction was saved, but ${account.name}'s balance couldn't be updated. Update it from the account.`, transaction: row, balance_updated: false },
        { status: 500 }
      );
    }
    await clearCaches(ctx);
    return NextResponse.json({ transaction: row, balance_updated: true, balance });
  } catch (err) {
    return storeFailure(err, 'Failed to add the transaction');
  }
}

/** Changes one transaction: any of its fields, or the account it is on. */
export async function PATCH(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readBody(req);
    if (body instanceof NextResponse) return body;
    if (!isManualTxnId(body.id)) return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    const read = readTxnFields(body, { partial: true, today: today() });
    if ('error' in read) return NextResponse.json({ error: read.error }, { status: 400 });
    const changes: ManualTxnChanges = { ...read.fields };
    if (body.account_id !== undefined) {
      const account = await manualAccount(ctx, body.account_id);
      if (account instanceof NextResponse) return account;
      changes.account_id = account.account_id;
    }
    if (Object.keys(changes).length === 0) return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });

    const saved = await editManualTxn(ctx, body.id, changes);
    if (!saved) return NextResponse.json({ error: 'That transaction no longer exists' }, { status: 404 });
    await clearTransactionsCache(ctx);
    return NextResponse.json({ transaction: saved });
  } catch (err) {
    return storeFailure(err, 'Failed to save the transaction');
  }
}

/** Removes one transaction, and what was said about it. Removing one that is
 *  already gone succeeds: what was asked for is true. */
export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await readBody(req);
    if (body instanceof NextResponse) return body;
    if (!isManualTxnId(body.id)) return NextResponse.json({ error: 'Invalid transaction id' }, { status: 400 });
    const deleted = await deleteManualTxn(ctx, body.id);
    // Best effort: an exclusion left behind names a row that no longer exists,
    // which is never shown.
    await forgetAnnotations(ctx, [body.id]).catch((err) => console.warn('manual-transactions: an exclusion was left behind', loggable(err)));
    await clearTransactionsCache(ctx);
    return NextResponse.json({ success: true, deleted });
  } catch (err) {
    return storeFailure(err, 'Failed to delete the transaction');
  }
}
