import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { archivePerson, createPerson, editPerson, ExpenseError, forgetPerson, recordRequest, removeTheirExpenses } from '@/lib/shared-expenses/edits';
import { bodyOf, failure, onlyKeys } from '@/lib/shared-expenses/http';
import { isExpenseId } from '@/lib/shared-expenses/model';

// The people you split costs with (lib/shared-expenses/model.ts Person): a
// name, and optionally the Venmo username or cashtag you would type to find
// them. Never an email, a phone number or bank details.
//
// POST  { name, venmo?, cashtag?, app?, tag? }: adds someone.
// PATCH { id, action, ... }:
//   edit             { name?, venmo?, cashtag?, app?, tag? }
//   archive          once everything with them is settled, in every currency
//   unarchive
//   forget           their name, handles, tag and requests go; every amount
//                    stays, so no total and no balance moves
//   remove-expenses  on someone archived or forgotten: their parts of shares
//                    become yours, and their IOUs go (refused while a
//                    payment names one)
//   request          { direction, amount, currency, via, items }: records a
//                    request sent through the handoff (sent with keepalive,
//                    since opening the app can end the page)

const PERSON_KEYS = ['name', 'venmo', 'cashtag', 'app', 'tag'];

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, PERSON_KEYS);
    return NextResponse.json(await createPerson(ctx, body));
  } catch (err) {
    return failure(err, 'Failed to add them');
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    if (!isExpenseId(body.id)) throw new ExpenseError('Invalid person');
    const id = body.id as string;
    switch (body.action) {
      case 'edit': {
        onlyKeys(body, ['id', 'action', ...PERSON_KEYS]);
        const input = { ...body };
        delete input.id;
        delete input.action;
        return NextResponse.json({ person: await editPerson(ctx, id, input) });
      }
      case 'archive':
      case 'unarchive':
        onlyKeys(body, ['id', 'action']);
        return NextResponse.json({ person: await archivePerson(ctx, id, body.action === 'archive') });
      case 'forget':
        onlyKeys(body, ['id', 'action']);
        return NextResponse.json({ person: await forgetPerson(ctx, id) });
      case 'remove-expenses':
        onlyKeys(body, ['id', 'action']);
        return NextResponse.json(await removeTheirExpenses(ctx, id));
      case 'request': {
        onlyKeys(body, ['id', 'action', 'direction', 'amount', 'currency', 'via', 'items']);
        return NextResponse.json({ request: await recordRequest(ctx, id, body) });
      }
      default:
        throw new ExpenseError('Unknown action');
    }
  } catch (err) {
    return failure(err, 'Failed to save the change');
  }
}
