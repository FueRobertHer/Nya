import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { readAccounts } from '@/lib/api-read';
import { goalLinks } from '@/lib/goal-plans';
import { readGoalFlows } from '@/lib/goal-flows';
import { monthDiff } from '@/lib/goal-projection';

// GET /api/goals/progress?month=YYYY-MM: what went into each account over its
// last complete months before `month` (the viewer's own; at most a month from
// the server's UTC one), for the Goals card to project each goal with
// (lib/goal-flows.ts says where each figure comes from, lib/goal-projection.ts
// what counts). Every account that isn't hidden or owed, so the editor can
// show a goal's pace on any account it might track. From stored data alone:
// Plaid is never asked, and nothing is written. The projection itself is
// worked out in the browser, on the balances it shows, and never stored.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    const asked = new URL(req.url).searchParams.get('month');
    const utc = new Date().toISOString().slice(0, 7);
    if (asked !== null && !(MONTH.test(asked) && Math.abs(monthDiff(utc, asked)) <= 1)) {
      return NextResponse.json({ error: 'month is this month, YYYY-MM' }, { status: 400 });
    }
    const links = await goalLinks(ctx, { readOnly: true });
    const { accounts, notes: accountNotes } = await readAccounts(ctx, { includeHidden: false });
    const read = await readGoalFlows(ctx, { month: asked ?? utc, accounts, links });
    return NextResponse.json({ months: read.months, flows: Object.fromEntries(read.flows), notes: [...read.notes, ...accountNotes] });
  } catch (err) {
    return storeFailure(err, 'Failed to load how your goals are going');
  }
}
