import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { sameSite } from '@/lib/same-site';
import { directoryEntries, liveAccountIds, PROVIDER, type DirectoryEntry } from '@/lib/links';
import { getItems } from '@/lib/storage';
import { isInvestmentType } from '@/lib/balance';
import { isVanguard } from '@/lib/investment-months';
import { readVanguardTransactions } from '@/lib/import/vanguard-transactions';
import { MAX_IMPORT_ROWS } from '@/lib/import/record';
import { dayBefore, daysApart, MAX_FILE_CHARS, parseImportsChange, type ImportedRow, type InvestmentImport } from '@/lib/investment-imports';
import { addImport, ImportsRefused, listImports, undoImport } from '@/lib/investment-imports-store';

// An investment account's transactions imported from its brokerage's
// download (lib/investment-imports.ts): listed, added or undone.
//
//   GET  ?account_id=                                    its imports
//   POST { action: 'import', account_id, file_name, text, today, take,
//          counting }                                    add one
//   POST { action: 'undo', account_id, import_id }       undo one
//
// Answers { imports, fingerprint }: the account's imports now, newest first,
// each with every account it took, and the fingerprint an import names to
// say what it was reviewed against.
//
// AN IMPORT is today Vanguard's transaction history CSV. Its text is read on
// the device for the review and again here, by the same reader
// (lib/import/vanguard-transactions.ts), and never kept: only each account's
// rows and the days the file covers are. Each account in `take` gets the
// file's rows for the account ending in its four digits (at least one: an
// account with nothing in the file's days isn't taken, so they stay Plaid's),
// and only an account a connection lists now, at Vanguard by Plaid's institution id, and an
// investment one whose mask is those four digits and no other such
// account's, takes them. The file's days are its first to last trade date,
// across its accounts, ending at the latest the day before the person's
// today, since the download's own day can be partial; rows after that are
// left out. Every account's entry is written in one step. An undo removes
// every account's entry of the import in one, and takes any id, since it
// only removes.
//
// Nothing cached is cleared: both readers of the activity check their
// cached copies against the imports there are now
// (lib/investment-activity.ts hasCurrentImports).
//
// 403 for a request from another site, 400 for one that isn't one of the
// above or a file that can't be imported, 404 for an account no connection
// lists or an import that isn't there, 409 when the imports changed since
// the file was reviewed (another device) or an account keeps as many as it
// may; storage errors as on the seam (lib/store-failure.ts).

const MAX_BODY_CHARS = MAX_FILE_CHARS + 64 * 1024;

const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

export async function GET(req: Request) {
  const account_id = new URL(req.url).searchParams.get('account_id');
  if (!account_id || account_id.length > 200) return bad('Missing account_id');
  try {
    const ctx = await dataCtx();
    return NextResponse.json(await listImports(ctx, account_id));
  } catch (err) {
    return storeFailure(err, 'Failed to read the imported transactions');
  }
}

/** Why the file can't be imported, in the person's words, or null. */
function fileProblem(read: ReturnType<typeof readVanguardTransactions>): string | null {
  if (read.ok) return read.span ? null : 'This file has no transactions to import';
  if (read.reason === 'not-this-file') return 'This isn’t Vanguard’s transaction download';
  if (read.reason === 'too-many-rows') return `This file has more than ${MAX_IMPORT_ROWS.toLocaleString('en-US')} lines, more than Nya reads in one import`;
  return 'This file isn’t laid out the way Nya reads Vanguard’s transaction download';
}

export async function POST(req: Request) {
  if (!sameSite(req)) return NextResponse.json({ error: 'That came from somewhere else, so nothing changed.' }, { status: 403 });
  const text = await req.text().catch(() => null);
  if (text === null || text.length > MAX_BODY_CHARS) return bad('Send the file, as JSON');
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return bad('Send the file, as JSON');
  }
  const change = parseImportsChange(body);
  if (typeof change === 'string') return bad(change);
  try {
    const ctx = await dataCtx();
    if (change.action === 'undo') {
      await undoImport(ctx, change.import_id);
      return NextResponse.json(await listImports(ctx, change.account_id));
    }

    // The person's today can be a day either side of the server's.
    const utcToday = new Date().toISOString().slice(0, 10);
    if (Math.abs(daysApart(utcToday, change.today)) > 1) return bad('Today, as your device gives it, is more than a day from Nya’s. Check its date and try again.');
    const read = readVanguardTransactions(change.text);
    const problem = fileProblem(read);
    if (problem || !read.ok || !read.span) return bad(problem ?? 'This file has no transactions to import');
    const covers = { from: read.span.from, to: read.span.to < change.today ? read.span.to : dayBefore(change.today) };
    if (covers.from > covers.to) return bad('Every transaction in this file is from today, which may not be complete yet. Import it again tomorrow.');

    // The accounts that can take it: live, Plaid's, at Vanguard, investment.
    const live = await liveAccountIds(ctx, { strict: true });
    const missing = change.take.find((t) => !live.has(t.account_id));
    if (missing) return NextResponse.json({ error: 'That account isn’t one Nya knows' }, { status: 404 });
    const [known, items] = await Promise.all([directoryEntries(ctx, [...live]), getItems(ctx)]);
    const atVanguard = (e: DirectoryEntry | undefined): e is DirectoryEntry =>
      !!e &&
      (e.provider ?? PROVIDER) === PROVIDER &&
      !(typeof e.type === 'string' && !isInvestmentType(e.type)) &&
      (isVanguard(e.institution_id) || isVanguard(items.find((i) => i.item_id === e.item_id)?.institution_id));
    const vanguard = [...live].filter((id) => atVanguard(known[id]));

    const imported_at = new Date().toISOString();
    const entries: { account_id: string; value: InvestmentImport }[] = [];
    for (const t of change.take) {
      const entry = known[t.account_id];
      if (!atVanguard(entry)) return bad('Nya reads Vanguard’s transaction download only for an investment account linked at Vanguard');
      if (entry.mask !== t.mask) return bad(`That account doesn’t end in ${t.mask}`);
      if (vanguard.some((id) => id !== t.account_id && known[id]?.mask === t.mask)) return bad(`More than one of your Vanguard accounts ends in ${t.mask}, so Nya can’t tell which the file’s is`);
      const account = read.accounts.find((a) => a.mask === t.mask);
      if (!account) return bad(`The file has no account ending in ${t.mask}`);
      if (account.repeated) return bad(`The file has more than one account ending in ${t.mask}, so Nya can’t tell them apart`);
      if (account.unreadable) return bad(`The account ending in ${t.mask} has a line Nya can’t read (line ${account.unreadable.line}), so none of its rows were imported`);
      const rows: ImportedRow[] = account.rows
        .filter((r) => r.date <= covers.to)
        .map(({ line: _l, kind: _k, ...r }) => r);
      if (rows.length === 0) return bad(`The file has nothing before today for the account ending in ${t.mask}, so there’s nothing to import for it`);
      entries.push({ account_id: t.account_id, value: { source: 'vanguard-csv', file_name: change.file_name, imported_at, covers, currency: 'USD', rows } });
    }
    await addImport(ctx, crypto.randomUUID(), entries, change.counting);
    return NextResponse.json(await listImports(ctx, change.account_id));
  } catch (err) {
    if (err instanceof ImportsRefused) {
      if (err.why === 'missing') return NextResponse.json({ error: 'That import isn’t there any more: the list shows what is.' }, { status: 404 });
      if (err.why === 'full') return NextResponse.json({ error: 'An account in this file has as many imports as Nya keeps. Undo an old one to import this file.', needs: 'undo', account_id: err.account_id }, { status: 409 });
      return NextResponse.json({ error: 'The imports changed on another device while you checked this file. Check it again against what’s here now before importing it.', needs: 'review' }, { status: 409 });
    }
    return storeFailure(err, change.action === 'undo' ? 'Failed to undo the import' : 'Failed to import the transactions');
  }
}
