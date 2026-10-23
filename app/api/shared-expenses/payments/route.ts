import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { checkTransactionId, confirmPayment, dismissRow, ExpenseError, keepPayment, movePayment, reopenPayment, undismissRow } from '@/lib/shared-expenses/edits';
import { bodyOf, failure, onlyKeys } from '@/lib/shared-expenses/http';
import { isTransactionId } from '@/lib/shared-expenses/model';

// Payments the person confirmed (lib/shared-expenses/edits.ts
// confirmPayment): one of their transactions paid back what someone owed
// them (money in), or paid what they owed (money out). The only way a
// payment is ever written: Nya proposes (lib/shared-expenses/match.ts) and
// never settles on its own.
//
// POST   { transaction_id, allocations: [{ item, amount }], note? }
//        checked against the row as stored and what is open now; a row pays
//        once (409 the second time).
// DELETE { transaction_id }: reopens it.
// PATCH  { action: 'keep' | 'dismiss' | 'undismiss', transaction_id }
//        { action: 'move', transaction_id, to, account? }

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, ['transaction_id', 'allocations', 'note']);
    const id = checkTransactionId(body.transaction_id);
    return NextResponse.json({ transaction_id: id, payment: await confirmPayment(ctx, id, body) });
  } catch (err) {
    return failure(err, 'Failed to confirm the payment');
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, ['transaction_id']);
    return NextResponse.json({ reopened: await reopenPayment(ctx, checkTransactionId(body.transaction_id)) });
  } catch (err) {
    return failure(err, 'Failed to reopen the payment');
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    switch (body.action) {
      case 'keep':
        onlyKeys(body, ['action', 'transaction_id']);
        return NextResponse.json({ payment: await keepPayment(ctx, checkTransactionId(body.transaction_id)) });
      case 'dismiss':
        onlyKeys(body, ['action', 'transaction_id']);
        await dismissRow(ctx, checkTransactionId(body.transaction_id));
        return NextResponse.json({ ok: true });
      case 'undismiss':
        onlyKeys(body, ['action', 'transaction_id']);
        await undismissRow(ctx, checkTransactionId(body.transaction_id));
        return NextResponse.json({ ok: true });
      case 'move': {
        onlyKeys(body, ['action', 'transaction_id', 'to', 'account']);
        if (body.account !== undefined && body.account !== null && !isTransactionId(body.account)) throw new ExpenseError('Invalid account');
        const to = checkTransactionId(body.to);
        return NextResponse.json({ transaction_id: to, payment: await movePayment(ctx, checkTransactionId(body.transaction_id), to, (body.account as string | null | undefined) ?? null) });
      }
      default:
        throw new ExpenseError('Unknown action');
    }
  } catch (err) {
    return failure(err, 'Failed to save the change');
  }
}
