import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { sameSite } from '@/lib/same-site';
import { directoryEntries, liveAccountIds } from '@/lib/links';
import { isInvestmentType } from '@/lib/balance';
import { parseMoneyInOutChange } from '@/lib/money-in-out';
import { saveMoneyInOut } from '@/lib/money-in-out-store';

// One investment account's money in and out (lib/money-in-out.ts), set or
// cleared, one account per request:
//
//   { account_id, in, out, as_of, currency }   set the totals for a day
//   { account_id, clear: true }                 clear them
//
// Answers { money_in_out } with what applies now (null once cleared). Only
// an account a connection lists now can be given totals, and only an
// investment one where Nya knows its kind; clearing takes any id, since it
// only removes. The totals are read fresh with the account's activity
// (app/api/investment-activity), never cached, so nothing is cleared here.
//
// 403 for a request from another site, 400 for one that isn't one of the
// above, 404 for an account no connection lists; storage errors as on the
// seam (lib/store-failure.ts).

/** Far more than one change takes. */
const MAX_BODY_CHARS = 1024;

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function POST(req: Request) {
  if (!sameSite(req)) return NextResponse.json({ error: 'That came from somewhere else, so nothing changed.' }, { status: 403 });
  const text = await req.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_CHARS) return bad('Send the totals, as JSON');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad('Send the totals, as JSON');
  }
  const change = parseMoneyInOutChange(body);
  if (typeof change === 'string') return bad(change);
  try {
    const ctx = await dataCtx();
    if (change.kind === 'set') {
      if (!(await liveAccountIds(ctx, { strict: true })).has(change.account_id)) {
        return NextResponse.json({ error: 'That account isn’t one Nya knows' }, { status: 404 });
      }
      const known = (await directoryEntries(ctx, [change.account_id]))[change.account_id];
      if (known && typeof known.type === 'string' && !isInvestmentType(known.type)) return bad('Deposits and withdrawals are for investment accounts');
    }
    return NextResponse.json({ money_in_out: await saveMoneyInOut(ctx, change) });
  } catch (err) {
    return storeFailure(err, 'Failed to save deposits and withdrawals');
  }
}
