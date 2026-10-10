import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { isManualId } from '@/lib/manual';
import { clearTransactionsCache } from '@/lib/cache';
import { isBackfillDone } from '@/lib/history';
import { readLinks, effectiveLinks, sameAccountIds, type Link } from '@/lib/link-core';
import { liveAccountIds } from '@/lib/links';
import { StateUnreadableError } from '@/lib/transactions';
import { StoredValueTooLargeError } from '@/lib/repo';
import { storeFailure } from '@/lib/store-failure';
import { loggable } from '@/lib/log-safe';
import { DEFAULT_CURRENCY, addDays } from '@/lib/manual-txn-input';
import { MAX_FILE_BYTES, MAX_IMPORT_ROWS, type FileFormat } from '@/lib/import/record';
import { decodeFile, detectFormat, formatFromName, FORMAT_NAMES } from '@/lib/import/text';
import { readImport, type ImportOptions, type ReadResult } from '@/lib/import/read';
import { normalizeRecords } from '@/lib/import/normalize';
import { namesOf } from '@/lib/import/csv';
import { accountMismatch, rememberSettings, statementAccountOf } from '@/lib/import/commit';
import {
  IMPORT_READS_PER_HOUR,
  IMPORT_REQUESTS_PER_HOUR,
  importSettingsStore,
  takeImportRead,
  takeImportRequest,
  type ImportAllowance,
  type ImportSettings,
} from '@/lib/import/store';
import { planHistoryImport, type HistoryPlan } from '@/lib/history-import/plan';
import {
  commitHistoryImport,
  coveredPeriod,
  historyUndoPlan,
  HistoryImportNotFoundError,
  listHistoryImports,
  ReviewChangedError,
  reviewDigest,
  UnansweredError,
  undoHistoryImport,
} from '@/lib/history-import/commit';
import { countedRows, liveLinkedAccounts, readAccountContext, type AccountContext, type LinkedAccount } from '@/lib/history-import/read';
import { drawImportedHistory, markDrawStale, readDrawState } from '@/lib/history-import/extend';
import { importedTxnStore, isHistoryImportId } from '@/lib/history-import/store';
import { readHistoryMeta, type HistoryMeta } from '@/lib/history-import/request';

// Importing years of history into a LINKED account (#52; lib/history-import/,
// which says how rows are matched, kept, superseded and walked). The file
// formats and questions are a manual account's import's (app/api/import,
// lib/import/); the matching, the review and what is kept are its own.
//
//   GET    ?account_id=   the account's imports, newest first, with what is
//                         left of each (its rows counted now, kept as the
//                         bank's duplicates, and since superseded by the
//                         bank's own), how its last file was read, where the
//                         bank's own rows begin, and how far back the
//                         estimated history reaches for it.
//          &undo=<id>     what undoing that import would do, for the
//                         confirmation.
//   POST   a form upload: `file`, and `meta` (JSON) with the account, the
//          answers to the file's questions and `action`:
//            "preview"   reads the file and matches it against the account,
//                        writing nothing: the REVIEW. Rows already imported
//                        (skipped), rows that look like the bank's own, each
//                        a proposal with a confidence and the bank's row
//                        beside it, rows repeated in the file, FITID
//                        conflicts, the new rows and how many of them are
//                        older than the bank's own, the rows that can't be
//                        read, the period the file covers, and the review's
//                        fingerprint (`review`).
//            "import"    the same, with the person's choices and the
//                        fingerprint of the review they saw: refused (409,
//                        needs "review") when the account changed since
//                        (a sync, a re-link, another import), and (409,
//                        needs "answers") while a conflict or a
//                        low-confidence proposal has no answer. Then one
//                        commit, all or nothing, refused whole past the size
//                        ceiling (413), never trimmed; and the estimated
//                        history drawn back through it (the estimated layer
//                        only, never the real one).
//          A file that needs an answer first is answered with `needs`, as
//          app/api/import answers.
//   DELETE { account_id, import_id, confirm: true }: Undo, restoring the
//          account exactly as it was before the import.
//
// The account is any linked account on a connection still stored, by its
// current id. Its earlier ids (lib/links.ts) are followed, so an import made
// before a re-link is listed, matched against and undone from here.
//
// LIMITS, as app/api/import's, counted against the same hourly budgets: a
// file of MAX_FILE_BYTES and MAX_IMPORT_ROWS transactions, a request of at
// most MAX_REQUEST_BYTES, and every answer bounded (LISTED_*). Files are never
// logged.

export const maxDuration = 120;

const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;
/** The person's answers, as JSON: a choice for every listed proposal and
 *  conflict, and more. */
const MAX_META_CHARS = 128 * 1024;
const PREVIEW_ROWS = 8;
const LISTED_PROBLEMS = 200;
const LISTED_PROPOSALS = 500;
const LISTED_CONFLICTS = 200;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const utcToday = () => new Date().toISOString().slice(0, 10);
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

const tooLarge = () =>
  NextResponse.json(
    { error: `This file is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB, more than one import takes. Export a shorter period and import it in parts.` },
    { status: 413 }
  );

function tooMany(retryAfterSeconds: number, what: string): NextResponse {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return NextResponse.json(
    { error: `${what}. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, retry_after_seconds: retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
  );
}

/** Counts this request against an hourly limit: the response refusing it, or
 *  null. Fails closed. */
async function limited(take: () => Promise<ImportAllowance>, what: string): Promise<NextResponse | null> {
  try {
    const allowed = await take();
    return allowed.ok ? null : tooMany(allowed.retryAfterSeconds, what);
  } catch (err) {
    console.error('history import: the request limit could not be checked', loggable(err));
    return NextResponse.json({ error: 'The import limit could not be checked just now, so nothing was done. Try again in a minute.' }, { status: 503 });
  }
}
const overLimit = (ctx: Ctx) => limited(() => takeImportRequest(ctx), `Files can be read or imported ${IMPORT_REQUESTS_PER_HOUR} times an hour`);
const overReadLimit = (ctx: Ctx) => limited(() => takeImportRead(ctx), `Past imports can be listed ${IMPORT_READS_PER_HOUR} times an hour`);

/**
 * One of the container's live linked accounts, with the links that apply
 * now, or the response saying why not. Strict about the links: a link that
 * can't be read would leave an earlier id's imports out of the matching.
 */
async function linkedAccount(ctx: Ctx, account_id: unknown): Promise<{ account: LinkedAccount; links: Map<string, Link> } | NextResponse> {
  if (typeof account_id !== 'string' || account_id.length > 100 || !/^[A-Za-z0-9_.:-]+$/.test(account_id) || isManualId(account_id)) {
    return bad('Choose one of your linked accounts');
  }
  const { accounts } = await liveLinkedAccounts(ctx);
  const account = accounts.get(account_id);
  if (!account) return NextResponse.json({ error: 'That account isn’t linked now. Reload to see your accounts.' }, { status: 404 });
  const [{ links, unreadable }, live] = await Promise.all([readLinks(ctx), liveAccountIds(ctx, { strict: true })]);
  if (unreadable.size > 0) {
    return NextResponse.json({ error: 'A saved account link can’t be read, so this account’s earlier imports can’t be found. Remove it on the Accounts tab first.' }, { status: 409 });
  }
  return { account, links: effectiveLinks(links, live) };
}

/** The account's context, or the response when its bank's rows can't be read. */
async function contextOf(ctx: Ctx, account: LinkedAccount, links: Map<string, Link>): Promise<AccountContext | NextResponse> {
  try {
    return await readAccountContext(ctx, account, links);
  } catch (err) {
    if (!(err instanceof StateUnreadableError)) throw err;
    console.error('history import: the bank’s transactions could not be read', err.kind);
    return NextResponse.json(
      { error: `${account.institution_name}’s transactions for ${account.name} can’t be read just now, so a file can’t be matched against them. Try again later.` },
      { status: 409 }
    );
  }
}

/** How the account's last file was read. LENIENT: a convenience that only
 *  fills in the sheet; nothing is written on this answer. */
async function readSettings(ctx: Ctx, account_id: string): Promise<ImportSettings | null> {
  try {
    return await importSettingsStore.get(ctx, account_id);
  } catch (err) {
    console.warn('history import: how this account’s last file was read could not be read', loggable(err));
    return null;
  }
}

/** Draws the estimated history again after a change, if the backfill it joins
 *  has run: best effort, since the change is made either way and the record
 *  stays marked for the next load to draw. Answers the oldest day drawn. */
async function redraw(ctx: Ctx): Promise<{ drawn: boolean; from: string | null }> {
  try {
    await markDrawStale(ctx);
    if (!(await isBackfillDone(ctx))) return { drawn: false, from: null };
    const { state } = await drawImportedHistory(ctx);
    return { drawn: true, from: state.from };
  } catch (err) {
    console.error('history import: the estimated history was not drawn again', loggable(err));
    return { drawn: false, from: null };
  }
}

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    const params = new URL(req.url).searchParams;
    const undo = params.get('undo');
    if (undo !== null && !isHistoryImportId(undo)) return bad('Invalid import');
    const over = await overReadLimit(ctx);
    if (over) return over;
    const found = await linkedAccount(ctx, params.get('account_id'));
    if (found instanceof NextResponse) return found;
    const { account, links } = found;
    if (undo !== null) return NextResponse.json({ undo: await historyUndoPlan(ctx, sameAccountIds(account.account_id, links), undo) });
    const context = await contextOf(ctx, account, links);
    if (context instanceof NextResponse) return context;
    const { superseded } = countedRows(context.held, context.banks, context.order);
    const [imports, settings, drawn] = await Promise.all([
      listHistoryImports(ctx, context.ids, new Set(superseded.keys())),
      readSettings(ctx, account.account_id),
      readDrawState(ctx),
    ]);
    const reach = drawn?.accounts.find((a) => a.account_id === account.account_id) ?? null;
    return NextResponse.json({
      imports,
      settings,
      bank_from: context.bank_from,
      walked: ['depository', 'credit'].includes(account.type),
      reach,
      limits: { max_bytes: MAX_FILE_BYTES, max_rows: MAX_IMPORT_ROWS },
    });
  } catch (err) {
    if (err instanceof HistoryImportNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    return storeFailure(err, 'Failed to load the imports');
  }
}

/** The form a request carries, read from bytes already counted. */
async function formOf(body: ArrayBuffer, contentType: string | null): Promise<FormData | null> {
  if (!contentType?.toLowerCase().startsWith('multipart/form-data')) return null;
  try {
    return await new Response(body, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return null;
  }
}

type Ready = Extract<ReadResult, { status: 'ready' }>;

function readOf(options: ImportOptions, read: Ready): Record<string, unknown> {
  return {
    options,
    date_order: read.read.date_order,
    date_style: read.read.date_style,
    decimal: read.read.decimal,
    ...(read.read.table ? { delimiter: read.read.table.delimiter, header_line: read.read.table.header_line, skipped: read.read.skipped ?? 0 } : {}),
  };
}

/** What the account should remember of how this file was read, as a manual
 *  account's import remembers it. */
function settingsFor(format: FileFormat, options: ImportOptions, read: Ready, currency: string, remembered: ImportSettings | null): Partial<Omit<ImportSettings, 'version' | 'updated_at'>> {
  if (format === 'ofx') {
    const chosen = read.statement?.currency ? remembered?.ofx?.currency : currency;
    return { ofx: { statement: statementAccountOf(read.statement), flip: options.flip === true, ...(chosen ? { currency: chosen } : {}) } };
  }
  if (format === 'qif') return { qif: { date_order: read.read.date_order, decimal: read.read.decimal, flip: options.flip === true, currency } };
  const table = read.read.table!;
  return {
    csv: { columns: namesOf(options.csv!.columns, table.header), sign: options.csv!.sign, decimal: read.read.decimal, date_order: read.read.date_order, delimiter: table.delimiter, currency },
  };
}

/** What became of a row, in one word, for the first rows the review shows. */
function rowOutcome(plan: HistoryPlan, i: number): 'new' | 'present' | 'repeated' | 'duplicate' | 'ask' | 'skip' {
  const action = plan.actions[i];
  const o = plan.outcomes[i];
  if (action === 'add') return 'new';
  if (action === 'duplicate') return 'duplicate';
  if (action === 'ask') return 'ask';
  if (o.outcome === 'present' || o.outcome === 'repeated') return o.outcome;
  return 'skip';
}

function reviewOf(
  read: Ready,
  plan: HistoryPlan,
  extra: { encoding: string; warnings: string[]; mismatch: { expected: string; found: string } | null; currency_from: 'file' | 'chosen' | 'account'; covers: ReturnType<typeof coveredPeriod> }
) {
  return {
    format: read.format,
    encoding: extra.encoding,
    statement: read.statement,
    read: {
      date_order: read.read.date_order,
      dates_ordered: read.read.dates_ordered,
      order_open: read.read.order_open,
      date_style: read.read.date_style,
      decimal: read.read.decimal,
      ...(read.read.table ? { delimiter: read.read.table.delimiter, header_line: read.read.table.header_line, skipped: read.read.skipped ?? 0 } : {}),
    },
    counts: plan.counts,
    rows: plan.rows.slice(0, PREVIEW_ROWS).map((r, i) => ({
      line: r.line,
      date: r.row.date,
      name: r.row.name,
      amount: r.row.amount,
      currency: r.row.currency,
      category: r.row.category,
      outcome: rowOutcome(plan, i),
    })),
    problems: plan.problems.slice(0, LISTED_PROBLEMS).map((p) => ({ line: p.line, reason: p.reason })),
    more_problems: Math.max(0, plan.problems.length - LISTED_PROBLEMS),
    proposals: plan.proposals.slice(0, LISTED_PROPOSALS),
    more_proposals: Math.max(0, plan.proposals.length - LISTED_PROPOSALS),
    conflicts: plan.conflicts.slice(0, LISTED_CONFLICTS),
    more_conflicts: Math.max(0, plan.conflicts.length - LISTED_CONFLICTS),
    kinds: plan.kinds,
    first_date: plan.first_date,
    last_date: plan.last_date,
    covers: extra.covers,
    bank_from: plan.bank_from,
    before_bank: plan.before_bank,
    within_bank: plan.within_bank,
    pending_alike: plan.pending_alike,
    currency: plan.currency,
    currency_from: extra.currency_from,
    other_currencies: plan.others,
    totals: plan.totals,
    shortened: plan.shortened,
    warnings: extra.warnings,
    account_mismatch: extra.mismatch,
    review: reviewDigest(plan.review),
  };
}

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    const over = await overLimit(ctx);
    if (over) return over;
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return tooLarge();
    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_REQUEST_BYTES) return tooLarge();
    const form = await formOf(body, req.headers.get('content-type'));
    if (!form) return bad('Send the file as a form upload');
    const file = form.get('file');
    if (!(file instanceof Blob)) return bad('Choose a file to import');
    if (file.size > MAX_FILE_BYTES) return tooLarge();
    if (file.size === 0) return bad('This file is empty');
    const metaText = form.get('meta');
    if (typeof metaText !== 'string' || metaText.length > MAX_META_CHARS) return bad('Invalid request');
    let parsed: unknown;
    try {
      parsed = JSON.parse(metaText);
    } catch {
      return bad('Invalid request');
    }
    const meta = readHistoryMeta(parsed);
    if (typeof meta === 'string') return bad(meta);

    const found = await linkedAccount(ctx, meta.account_id);
    if (found instanceof NextResponse) return found;
    const { account, links } = found;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { text, encoding } = decodeFile(bytes);
    const format = detectFormat(text);
    const read = readImport(text, { format, options: meta.options, thisYear: new Date().getUTCFullYear() });
    if (read.status === 'error') return NextResponse.json({ error: read.error, format }, { status: 422 });
    if (read.status !== 'ready') return NextResponse.json({ needs: read.status, ...read });

    const today = utcToday();
    // The statement's own currency for OFX; else the one chosen; else the
    // account's own, as its bank gives it.
    const fromFile = format === 'ofx' ? (read.statement?.currency ?? null) : null;
    const currency = fromFile ?? meta.options.currency ?? account.currency ?? DEFAULT_CURRENCY;
    const currency_from = fromFile ? 'file' : meta.options.currency ? 'chosen' : 'account';
    const normalized = normalizeRecords(read.records, { today, currency });
    const problems = [...read.problems, ...normalized.problems];

    const context = await contextOf(ctx, account, links);
    if (context instanceof NextResponse) return context;
    const plan = planHistoryImport({
      rows: normalized.rows,
      problems,
      held: context.held,
      banks: context.banks,
      order: context.order,
      bankFrom: context.bank_from,
      choices: meta.choices,
    });
    const covered = coverOf(meta, plan, read, today);
    if (typeof covered === 'string') return bad(covered);

    const settings = await readSettings(ctx, account.account_id);
    const mismatch = format === 'ofx' ? accountMismatch(settings?.ofx?.statement, read.statement) : null;
    const warnings: string[] = [...read.read.repairs];
    const named = formatFromName(meta.file_name);
    if (named && named !== format) warnings.push(`This file is named as ${FORMAT_NAMES[named]} but holds ${FORMAT_NAMES[format]}, so it was read as ${FORMAT_NAMES[format]}.`);
    if (read.read.reversed_hint) {
      warnings.push('Most of this statement’s debits are written as money coming in, so this bank may write its amounts the other way round. Check the rows below, and flip them if they read backwards.');
    }
    if (fromFile && account.currency && fromFile !== account.currency) {
      warnings.push(`This statement is in ${fromFile}, but ${account.name} is in ${account.currency} at the bank. Check it is this account’s file.`);
    }

    if (meta.action === 'preview') {
      return NextResponse.json({ preview: reviewOf(read, plan, { encoding, warnings, mismatch, currency_from, covers: covered }) });
    }

    if (mismatch && !meta.acknowledge_account) {
      return NextResponse.json(
        {
          error: `This file is for ${mismatch.found}, but ${account.name}’s last OFX file was for ${mismatch.expected}. Check it is the right file, then import it anyway.`,
          account_mismatch: mismatch,
        },
        { status: 409 }
      );
    }
    if (!covered) return bad('This file has no transactions that can be read.');

    let result: Awaited<ReturnType<typeof commitHistoryImport>>;
    try {
      result = await commitHistoryImport(ctx, {
        account_id: account.account_id,
        ids: context.ids,
        format,
        file_name: meta.file_name,
        file_bytes: bytes.length,
        encoding,
        rows: normalized.rows,
        problems,
        read: readOf(meta.options, read),
        statement: read.statement,
        columns: read.read.table?.header ?? null,
        covers: covered,
        banks: context.banks,
        order: context.order,
        bank_from: context.bank_from,
        choices: meta.choices,
        reviewed: meta.review!,
      });
    } catch (err) {
      if (err instanceof ReviewChangedError) return NextResponse.json({ error: err.message, needs: 'review' }, { status: 409 });
      if (err instanceof UnansweredError) return NextResponse.json({ error: err.message, needs: 'answers', count: err.count }, { status: 409 });
      if (err instanceof StoredValueTooLargeError) {
        console.error('history import: refused as too large to store', err.what);
        return NextResponse.json(
          {
            error:
              err.what === importedTxnStore.what
                ? `${account.name} can’t take this import: with it, its imported transactions would be too large to store, so nothing was imported. Import a shorter period.`
                : 'This file’s records are too large to keep with the import, so nothing was imported. Import a shorter period.',
          },
          { status: 413 }
        );
      }
      throw err;
    }
    await rememberSettings(ctx, account.account_id, settingsFor(format, meta.options, read, currency, settings));
    const c = result.plan.counts;
    const counts = { imported: c.new, duplicates: c.duplicates, present: c.present, repeated: c.repeated, skipped: c.skipped, unreadable: c.unreadable };
    if (!result.import_id) return NextResponse.json({ ...counts, import_id: null, history: { drawn: false, from: null } });
    // The transactions cached for the Activity tab hold the banks' part, which
    // the imported rows are part of.
    await clearTransactionsCache(ctx);
    const history = await redraw(ctx);
    return NextResponse.json({ ...counts, import_id: result.import_id, before_bank: result.plan.before_bank, history });
  } catch (err) {
    return storeFailure(err, 'Failed to import the file');
  }
}

/** The period the file covers (lib/history-import/commit.ts coveredPeriod),
 *  or why the one the person gave can't be: it may only widen the file's own,
 *  never leave a row out, and never reach past tomorrow. */
function coverOf(meta: HistoryMeta, plan: HistoryPlan, read: Ready, today: string): ReturnType<typeof coveredPeriod> | string {
  const stated = meta.covers;
  if (stated && plan.first_date && plan.last_date) {
    if (stated.from > plan.first_date || stated.to < plan.last_date) {
      return `The period the file covers must hold every row in it, from ${plan.first_date} to ${plan.last_date}.`;
    }
    if (stated.to > addDays(today, 1)) return 'The period the file covers can’t reach into the future.';
  }
  return coveredPeriod(read.statement, plan.first_date, plan.last_date, today, stated);
}

export async function DELETE(req: Request) {
  try {
    const ctx = await dataCtx();
    const over = await overLimit(ctx);
    if (over) return over;
    const text = await req.text();
    if (text.length > 4096) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return bad('Invalid request');
    }
    if (!isRecord(body) || !isHistoryImportId(body.import_id)) return bad('Invalid import');
    if (body.confirm !== true) return bad('Confirm undoing the import first');
    const found = await linkedAccount(ctx, body.account_id);
    if (found instanceof NextResponse) return found;
    // Only the account's ids: an undo needs nothing of the bank's.
    const undone = await undoHistoryImport(ctx, sameAccountIds(found.account.account_id, found.links), body.import_id);
    await clearTransactionsCache(ctx);
    const history = await redraw(ctx);
    return NextResponse.json({ removed: undone.removed, duplicates: undone.duplicates, kept: undone.kept, history });
  } catch (err) {
    if (err instanceof HistoryImportNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    return storeFailure(err, 'Failed to undo the import');
  }
}
