import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { sameSite } from '@/lib/same-site';
import { directoryEntries, liveAccountIds, PROVIDER } from '@/lib/links';
import { getItems } from '@/lib/storage';
import { isInvestmentType } from '@/lib/balance';
import { isVanguard, parseMonthsChange, type MonthsImport } from '@/lib/investment-months';
import { addMonthsImport, MonthsRefused, readInvestmentMonths, undoMonthsImport } from '@/lib/investment-months-store';

// An investment account's months imported from its brokerage
// (lib/investment-months.ts): listed, added or undone, one account per
// request.
//
//   GET  ?account_id=                                     its imports
//   POST { action: 'import', account_id, file_name, start, months, currency,
//          typed?, counting }                             add one
//   POST { action: 'undo', account_id, import_id }        undo one
//
// Answers { investment_months } with what is there now (null with none).
// The file never reaches the server: the browser reads it and sends its
// months, which are checked here as they are stored (contiguous, each
// adding up to the cent). Only an account a connection lists now, at
// Vanguard by Plaid's institution id, and an investment one, takes an
// import; an undo takes any id, since it only removes. The months are read
// fresh with the account's activity (app/api/investment-activity), never
// cached, so nothing is cleared here.
//
// 403 for a request from another site, 400 for one that isn't one of the
// above, 404 for an account no connection lists or an import that isn't
// there, 409 when the import that counted when the file was reviewed has
// changed since (another device) or the account keeps as many as it may;
// storage errors as on the seam (lib/store-failure.ts).

/** A hundred years of months, with room. */
const MAX_BODY_CHARS = 128 * 1024;

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function GET(req: Request) {
  const account_id = new URL(req.url).searchParams.get('account_id');
  if (!account_id || account_id.length > 200) return bad('Missing account_id');
  try {
    const ctx = await dataCtx();
    return NextResponse.json({ investment_months: await readInvestmentMonths(ctx, account_id) });
  } catch (err) {
    return storeFailure(err, 'Failed to read the imported months');
  }
}

export async function POST(req: Request) {
  if (!sameSite(req)) return NextResponse.json({ error: 'That came from somewhere else, so nothing changed.' }, { status: 403 });
  const text = await req.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_CHARS) return bad('Send the months, as JSON');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad('Send the months, as JSON');
  }
  const change = parseMonthsChange(body);
  if (typeof change === 'string') return bad(change);
  try {
    const ctx = await dataCtx();
    if (change.action === 'undo') {
      return NextResponse.json({ investment_months: await undoMonthsImport(ctx, change.account_id, change.import_id) });
    }
    if (!(await liveAccountIds(ctx, { strict: true })).has(change.account_id)) {
      return NextResponse.json({ error: 'That account isn’t one Nya knows' }, { status: 404 });
    }
    const known = (await directoryEntries(ctx, [change.account_id]))[change.account_id];
    if (!known || (known.provider ?? PROVIDER) !== PROVIDER) return bad('Nya reads Vanguard’s Performance page only for an account linked at Vanguard');
    if (typeof known.type === 'string' && !isInvestmentType(known.type)) return bad('Past months are for investment accounts');
    const item = (await getItems(ctx)).find((i) => i.item_id === known.item_id);
    if (!isVanguard(known.institution_id) && !isVanguard(item?.institution_id)) return bad('Nya reads Vanguard’s Performance page only for an account linked at Vanguard');
    const record: MonthsImport = {
      id: crypto.randomUUID(),
      source: 'vanguard-performance',
      file_name: change.file_name,
      imported_at: new Date().toISOString(),
      start: change.start,
      months: change.months,
      currency: change.currency,
      ...(change.typed.length > 0 ? { typed: change.typed } : {}),
    };
    return NextResponse.json({ investment_months: await addMonthsImport(ctx, change.account_id, record, change.counting) });
  } catch (err) {
    if (err instanceof MonthsRefused) {
      if (err.why === 'missing') return NextResponse.json({ error: 'That import isn’t there any more: the list shows what is.' }, { status: 404 });
      if (err.why === 'full') return NextResponse.json({ error: 'This account has as many imports as Nya keeps. Undo an old one to import this file.', needs: 'undo' }, { status: 409 });
      return NextResponse.json({ error: 'The imports changed on another device while you checked this file. Check it again against what’s here now before importing it.', needs: 'review' }, { status: 409 });
    }
    return storeFailure(err, change.action === 'undo' ? 'Failed to undo the import' : 'Failed to import the months');
  }
}
