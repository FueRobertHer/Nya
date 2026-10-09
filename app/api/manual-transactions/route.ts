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
// sends its own. Sent again with another amount (corrected in the form after
// the first answer was lost) while a balance moved with it, or is asked to,
// it is refused with what was saved: the balance moved by the saved amount,
// and changing the row quietly would leave the two apart.
//
// A manual account's balance stays what was typed. A new row moves it only
// when the request asks (`update_balance: { from, to }`, the balance the form
// showed and the one it said it would become), and only from exactly that
// figure: a balance changed since (another device, a scripted push) or an
// account whose type changed (which flips the direction) is refused before
// anything is saved, never overwritten. The move is one compare-and-set
// (lib/manual.ts moveManualBalance) that stamps the account with the row that
// moved it, and is then noted on the row, so the same add sent again moves it
// once, and two adds of one amount at the same moment can't both take the
// one move for theirs. Then, as the account's Update form does, the
// estimated history is set to be rebuilt and the net-worth cache dropped, and
// the client reloads net worth, which records it in the real history layer
// like any typed balance. Once the balance moved, the answer says so whatever
// fails after. Editing or deleting a row never changes the balance.

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

/** Why a balance update can't be made as asked, before anything is moved. */
type BalanceRefusal = 'currency' | 'account-changed' | 'too-large' | 'owed-negative';

/** What the request alone says against moving the balance from `from` to
 *  `to` for this transaction on this account, or null. */
function balanceRefusal(account: ManualAccount, fields: { amount: number; currency: string }, update: { from: number; to: number }): BalanceRefusal | null {
  // Manual balances are kept in US dollars (lib/manual.ts toInstitutions): an
  // amount in another currency can't be taken off one.
  if (fields.currency !== DEFAULT_CURRENCY) return 'currency';
  // The figure the form said must be what this transaction makes of the one
  // it showed, for the account as it is: one whose type changed since (held
  // to owed) would move the other way.
  if (cents(balanceAfter(update.from, fields.amount, isOwedType(account.type))) !== cents(update.to)) return 'account-changed';
  if (Math.abs(update.to) > MAX_BALANCE) return 'too-large';
  // As the Update form refuses one (app/api/manual-accounts): an amount owed
  // below zero would count as money held.
  if (isOwedType(account.type) && update.to < 0) return 'owed-negative';
  return null;
}

/** A refusal said before anything was saved: nothing was. */
function refusedBeforeSaving(why: BalanceRefusal, account: ManualAccount, currency: string): NextResponse {
  switch (why) {
    case 'currency':
      return NextResponse.json({ error: `${account.name}'s balance is kept in ${DEFAULT_CURRENCY}, so a transaction in ${currency} can't update it.` }, { status: 400 });
    case 'account-changed':
      return NextResponse.json(
        { error: `${account.name} changed since this form opened, so nothing was saved. Check it and save again.`, balance: account.balance },
        { status: 409 }
      );
    case 'too-large':
      return NextResponse.json({ error: 'That would make the balance too large' }, { status: 400 });
    case 'owed-negative':
      return NextResponse.json(
        { error: `That would make the amount owed on ${account.name} negative. Save the transaction without updating the balance, then update the balance itself.` },
        { status: 400 }
      );
  }
}

/** The same refusal for a row an earlier send saved already: it stays saved,
 *  and its balance isn't moved. */
function refusedAfterSaving(why: BalanceRefusal, account: ManualAccount, currency: string, transaction: unknown): NextResponse {
  const reason = {
    currency: `${account.name}'s balance is kept in ${DEFAULT_CURRENCY}, so a transaction in ${currency} can't update it`,
    'account-changed': `${account.name} changed since this form opened, so its balance wasn't updated. Check it on the account`,
    'too-large': `that would make ${account.name}'s balance too large, so it wasn't updated`,
    'owed-negative': `that would make the amount owed on ${account.name} negative, so it wasn't updated`,
  }[why];
  return NextResponse.json(
    { error: `The transaction was saved already, but ${reason}.`, transaction, added: false, balance_updated: false, saved: true },
    { status: 409 }
  );
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

    // The same add sent again: its row is stored already, maybe moved or
    // edited since. Nothing is added, and the balance moves only if this add
    // hasn't moved it yet.
    const there = await locateManualTxn(ctx, id);
    let row: ManualTxn;
    let added = false;
    if (there) {
      row = there.row;
      const transaction = await shown(ctx, row, account);
      const moved = row.balance_update ?? null;
      // Sent again with another amount (corrected after the first answer was
      // lost): the balance moved, or is to move, by what was saved, so the
      // row isn't changed to another amount here. Said, never done quietly.
      if ((moved || update) && (row.amount !== fields.amount || row.currency !== fields.currency)) {
        const saved = formatMoney(Math.abs(row.amount), row.currency);
        return NextResponse.json(
          {
            error: moved
              ? `This transaction was saved already, for ${saved}, and ${account.name}'s balance moved to ${formatMoney(moved.to, DEFAULT_CURRENCY)} with it, so nothing more was changed. To change the amount, edit the transaction, then update the balance from the account.`
              : `This transaction was saved already, for ${saved}, so nothing more was changed and the balance wasn't updated. To change the amount, edit the transaction, then update the balance from the account.`,
            transaction,
            added: false,
            balance_updated: !!moved,
            ...(moved ? { balance: moved.to } : {}),
            saved: true,
          },
          { status: 409 }
        );
      }
      // Moved by this add already: never again.
      if (moved) return NextResponse.json({ transaction, added, balance_updated: true, balance: moved.to });
      if (!update) return NextResponse.json({ transaction, added, balance_updated: false });
      // Saved by an earlier send whose balance move didn't happen: made now,
      // if the request still allows it.
      const why = balanceRefusal(account, fields, update);
      if (why) return refusedAfterSaving(why, account, fields.currency, transaction);
    } else {
      // Everything about the balance is checked before anything is written.
      if (update) {
        const why = balanceRefusal(account, fields, update);
        if (why) return refusedBeforeSaving(why, account, fields.currency);
        // The balance the form showed must still be the account's: else
        // saving would record a figure the person never saw. Refused, and said.
        if (cents(update.from) !== cents(account.balance)) {
          return NextResponse.json(
            {
              error: `${account.name}'s balance changed to ${formatMoney(account.balance, DEFAULT_CURRENCY)} since this form opened, so nothing was saved. Check it and save again.`,
              balance: account.balance,
            },
            { status: 409 }
          );
        }
      }
      ({ row, added } = await addManualTxn(ctx, newManualTxn(account.account_id, fields, new Date(), id)));
      // An account deleted while this was saved (app/api/manual-accounts
      // DELETE) mustn't be left a book nothing shows: its row goes with it.
      if (added && !(await getManualAccount(ctx, account.account_id))) {
        await removeAccountTxns(ctx, account.account_id);
        return NextResponse.json({ error: 'That account no longer exists' }, { status: 404 });
      }
      if (!update) return NextResponse.json({ transaction: await shown(ctx, row, account), added, balance_updated: false });
    }

    const transaction = await shown(ctx, row, account);
    let moved: Awaited<ReturnType<typeof moveManualBalance>>;
    try {
      moved = await moveManualBalance(ctx, account.account_id, update.from, update.to, row.id);
    } catch (err) {
      console.error(loggable(err));
      return NextResponse.json(
        {
          error: `The transaction was saved, but ${account.name}'s balance may not have been updated. Check it on the account.`,
          transaction,
          added,
          balance_updated: false,
          saved: true,
        },
        { status: 500 }
      );
    }
    if (moved === 'moved' || moved === 'already') {
      // The balance moved: from here on the answer says so, whatever else
      // fails. As the Update form (app/api/manual-accounts PATCH) does, flag
      // first and cache second, for the reason given there; then the move is
      // noted on the row, so a resend finds it (and if that note fails, the
      // account's own record of the move still answers a resend 'already').
      try {
        await clearBackfillDone(ctx);
      } catch (err) {
        console.error('manual-transactions: the estimated history could not be marked to rebuild', loggable(err));
      }
      await clearNetWorthCache(ctx);
      try {
        await noteBalanceUpdate(ctx, row.id, account.account_id, update);
      } catch (err) {
        console.error('manual-transactions: a balance move could not be noted on its row', loggable(err));
      }
      return NextResponse.json({ transaction, added, balance_updated: true, balance: update.to });
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
 *  account the page shows it on, read first; one moved meanwhile is found
 *  where it is now (lib/manual-txns.ts deleteManualTxn). */
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
