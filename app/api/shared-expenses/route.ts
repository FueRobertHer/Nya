import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { cardAnswer, readCard } from '@/lib/shared-expenses/read';
import { ExpenseError, removeUnreadable, saveSettings } from '@/lib/shared-expenses/edits';
import { bodyOf, failure, onlyKeys } from '@/lib/shared-expenses/http';
import { isTransactionId } from '@/lib/shared-expenses/model';

// Shared expenses (#49, lib/shared-expenses/): what other people owe you and
// what you owe them. Nya never moves money; this keeps the list.
//
// GET   everything for the Shared expenses card, read strictly
//       (lib/shared-expenses/read.ts readCard): the people, every item with
//       what is open of it, the shares, payments and rows set aside, and
//       each person's balances per currency, which are null while anything
//       couldn't be read (a balance short of an entry is never shown), with
//       what couldn't be read named by store (`unread`).
// PUT   { counting?, own_venmo?, own_cashtag? }: the setting.
// POST  { action: 'remove-unreadable', store, ids }: removes entries the
//       strict read names damaged, once the person confirmed; never one a
//       later release wrote (unrecognised).
//
// Routes beside it: people, shares, ious, payments and close.

export async function GET() {
  try {
    const ctx = await dataCtx();
    return NextResponse.json(cardAnswer(await readCard(ctx)));
  } catch (err) {
    return failure(err, 'Failed to read your shared expenses');
  }
}

export async function PUT(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, ['counting', 'own_venmo', 'own_cashtag']);
    const settings = await saveSettings(ctx, body);
    return NextResponse.json({ settings });
  } catch (err) {
    return failure(err, 'Failed to save the setting');
  }
}

const STORES = ['people', 'shares', 'ious', 'payments', 'dismissed'] as const;

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const body = await bodyOf(req);
    if (body instanceof NextResponse) return body;
    onlyKeys(body, ['action', 'store', 'ids']);
    if (body.action !== 'remove-unreadable') throw new ExpenseError('Unknown action');
    if (!(STORES as readonly unknown[]).includes(body.store)) throw new ExpenseError('Unknown store');
    if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 1000 || !body.ids.every(isTransactionId)) throw new ExpenseError('Invalid ids');
    const removed = await removeUnreadable(ctx, body.store as (typeof STORES)[number], body.ids as string[]);
    return NextResponse.json({ removed });
  } catch (err) {
    return failure(err, 'Failed to remove what couldn’t be read');
  }
}
