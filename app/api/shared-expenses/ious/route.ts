import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { ExpenseError, removeIou, saveIou } from '@/lib/shared-expenses/edits';
import { bodyOf, failure, onlyKeys } from '@/lib/shared-expenses/http';
import { isExpenseId } from '@/lib/shared-expenses/model';

// IOUs (lib/shared-expenses/model.ts Iou): what someone owes you, or you owe
// them, with no transaction of yours behind it. One you owe can name the
// category (a spending one) of what your part was for: it then counts as
// your spending on its day, once, however it is settled.
//
// POST   { person, direction, amount, currency, date, what, category_id? }
// PATCH  { id, ...the same, each optional }: never below what has closed it;
//        its person, direction and currency stay once anything closed it.
// DELETE { id }: refused while a payment names it or something closed it.

const KEYS = ['person', 'direction', 'amount', 'currency', 'date', 'what', 'category_id'];

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, KEYS);
    for (const k of ['person', 'direction', 'amount', 'currency', 'date', 'what']) if (body[k] === undefined) throw new ExpenseError(`Missing ${k}`);
    return NextResponse.json(await saveIou(ctx, null, body));
  } catch (err) {
    return failure(err, 'Failed to save the IOU');
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, ['id', ...KEYS]);
    if (!isExpenseId(body.id)) throw new ExpenseError('Invalid IOU');
    const { id, ...input } = body;
    return NextResponse.json(await saveIou(ctx, id as string, input));
  } catch (err) {
    return failure(err, 'Failed to save the IOU');
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, ['id']);
    if (!isExpenseId(body.id)) throw new ExpenseError('Invalid IOU');
    return NextResponse.json({ removed: await removeIou(ctx, body.id as string) });
  } catch (err) {
    return failure(err, 'Failed to remove the IOU');
  }
}
