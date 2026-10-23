import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { closeItems, ExpenseError, reopenClosed } from '@/lib/shared-expenses/edits';
import { bodyOf, failure, onlyKeys } from '@/lib/shared-expenses/http';
import { isExpenseId } from '@/lib/shared-expenses/model';

// What closes an item outside any payment Nya sees (lib/shared-expenses/
// edits.ts closeItems): settled outside your accounts (cash, another app), or
// let go. Kept on each item, under one event id.
//
// POST   { kind: 'outside' | 'forgiven', items: [{ item, amount }], date, note? }
// DELETE { item, event }: takes one back.

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, ['kind', 'items', 'date', 'note']);
    return NextResponse.json(await closeItems(ctx, body));
  } catch (err) {
    return failure(err, 'Failed to save it');
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, ['item', 'event']);
    if (!isExpenseId(body.item) || !isExpenseId(body.event)) throw new ExpenseError('Invalid item');
    return NextResponse.json({ reopened: await reopenClosed(ctx, body.item as string, body.event as string) });
  } catch (err) {
    return failure(err, 'Failed to take it back');
  }
}
