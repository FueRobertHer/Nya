import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { checkTransactionId, ExpenseError, keepShare, moveShare, removeShare, saveShare, shareMany } from '@/lib/shared-expenses/edits';
import { bodyOf, failure, onlyKeys } from '@/lib/shared-expenses/http';
import { isExpenseId, isSplitHow, type SplitHow } from '@/lib/shared-expenses/model';

// Sharing the cost of one of your transactions (lib/shared-expenses/edits.ts
// saveShare): who owes which part of it; your part is the rest. Applied on
// read in the layer every reader shares (lib/shared-expenses/rows.ts), so
// nothing cached is dropped and nothing stored about the transaction changes.
//
// PUT    { transaction_id, part?, what?, entries: [{ person, amount, how? }], updated_at?, carried_from? }
//        shares it (a part of a split one by `part`), or changes who owes
//        what. An entry keeps its id while it names the same person (an id
//        sent is never taken). Refused for a pending transaction, money in,
//        one with no currency, one in a group, one that pays something back,
//        a split one without a part, parts more than the transaction, a part
//        lowered below what has closed it, a person new to it or whose part
//        changes who is archived or forgotten, and, given updated_at, one
//        changed since. With `carried_from`, the share it shows carried
//        across a re-link moves onto it, in the same step.
// DELETE { transaction_id, updated_at? }: stops sharing it (refused while
//        something closed one of its parts).
// PATCH  { action: 'keep', transaction_id }: keeps a share whose transaction
//        is gone (it stays in the balance).
//        { action: 'move', transaction_id, to, account }: moves it to the
//        transaction the gone one came back as, in one step: `to` must be
//        stored, on `account`, posted money out in the share's currency, at
//        least what the others owe, and free (not shared, paying, split or
//        grouped).
//        { action: 'many', person, ids, how }: shares several with one
//        person at once (from a tag), each answered.

export async function PUT(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, ['transaction_id', 'part', 'what', 'entries', 'updated_at', 'carried_from']);
    const id = checkTransactionId(body.transaction_id);
    if (body.part !== undefined && body.part !== null && !isExpenseId(body.part)) throw new ExpenseError('Invalid part');
    return NextResponse.json({ transaction_id: id, share: await saveShare(ctx, id, body) });
  } catch (err) {
    return failure(err, 'Failed to share it');
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, ['transaction_id', 'updated_at']);
    const id = checkTransactionId(body.transaction_id);
    return NextResponse.json({ removed: await removeShare(ctx, id, body.updated_at) });
  } catch (err) {
    return failure(err, 'Failed to stop sharing it');
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
        return NextResponse.json({ share: await keepShare(ctx, checkTransactionId(body.transaction_id)) });
      case 'move': {
        onlyKeys(body, ['action', 'transaction_id', 'to', 'account']);
        const to = checkTransactionId(body.to);
        // The account the transaction moved to is on, as the page shows it:
        // checked against the transaction as stored.
        return NextResponse.json({ transaction_id: to, share: await moveShare(ctx, checkTransactionId(body.transaction_id), to, body.account) });
      }
      case 'many': {
        onlyKeys(body, ['action', 'person', 'ids', 'how']);
        if (!isExpenseId(body.person)) throw new ExpenseError('Invalid person');
        if (!Array.isArray(body.ids) || body.ids.length < 1) throw new ExpenseError('Say which transactions.');
        const ids = (body.ids as unknown[]).map(checkTransactionId);
        if (!isSplitHow(body.how)) throw new ExpenseError('Say how to split them.');
        return NextResponse.json({ results: await shareMany(ctx, body.person as string, ids, body.how as SplitHow) });
      }
      default:
        throw new ExpenseError('Unknown action');
    }
  } catch (err) {
    return failure(err, 'Failed to save the change');
  }
}
