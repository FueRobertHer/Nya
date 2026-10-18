import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { isManualId } from '@/lib/manual';
import { clearTransactionsCache } from '@/lib/cache';
import { isBackfillDone } from '@/lib/history';
import { readLinks, effectiveLinks, sameAccountIds, type Link } from '@/lib/link-core';
import { liveAccountIds } from '@/lib/links';
import { StateUnreadableError } from '@/lib/transactions';
import { StoredValueTooLargeError, UnreadableEntriesError } from '@/lib/repo';
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
import { drawImportedHistory, importedRowsChanged, readDrawState } from '@/lib/history-import/extend';
import { importedTxnStore, isHistoryImportId, type Covers } from '@/lib/history-import/store';
import { connectorAccountsStore } from '@/lib/connectors/store';
import { connectorLabel } from '@/lib/connectors/types';
import { effectiveLifecycle, endOf, lifecycleOf, lifecycleStore, type EndedLifecycle } from '@/lib/lifecycle';
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
//                        read, the period the file covers, whether the
//                        connection's older transactions may still be on the
//                        way, and the review's fingerprint (`review`).
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
  if (typeof account_id !== 'string' || account_id.length > 100 || !/^[A-Za-z0-9_.:-]+$/.test(account_id)) {
    return bad('Choose one of your linked accounts');
  }
  if (isManualId(account_id)) return bad(await notLinked(ctx, account_id));
  const { accounts, endsUnread } = await liveLinkedAccounts(ctx);
  const account = accounts.get(account_id);
  if (!account) {
    // An account that ended, which its bank no longer returns, is linked
    // through its end (lib/history-import/read.ts liveLinkedAccounts): one
    // that can't be read is said, as the Activity tab says it, never taken
    // for an account that isn't linked.
    if (endsUnread.unreadable.includes(account_id) || endsUnread.unrecognised.includes(account_id)) {
      return storeFailure(new UnreadableEntriesError(lifecycleStore.what, endsUnread.unreadable, endsUnread.unrecognised), 'Failed to read the account');
    }
    return NextResponse.json({ error: 'That account isn’t linked now. Reload to see your accounts.' }, { status: 404 });
  }
  const [{ links, unreadable }, live] = await Promise.all([readLinks(ctx), liveAccountIds(ctx, { strict: true })]);
  if (unreadable.size > 0) {
    return NextResponse.json({ error: 'A saved account link can’t be read, so this account’s earlier imports can’t be found. Remove it on the Accounts tab first.' }, { status: 409 });
  }
  return { account, links: effectiveLinks(links, live) };
}

/** Why a manual account's id isn't one to import history into, in words:
 *  one SimpleFIN or Lunch Flow keeps up to date brings its own history,
 *  matched by the connector's own ids, which a file's rows can't be matched
 *  against here; a manual account imports a file through its own Import.
 *  Whether it is a connector's is read leniently: unknown, the words cover
 *  both. */
async function notLinked(ctx: Ctx, account_id: string): Promise<string> {
  const fed = await connectorAccountsStore.get(ctx, account_id).then(
    (a) => a?.connector ?? false,
    () => null
  );
  if (fed) {
    return `This account is kept up to date through ${connectorLabel(fed)}, which brings its older transactions itself, up to two years: importing history from a file isn’t offered for it.`;
  }
  if (fed === false) return 'This is a manual account: import a file into it with Import on its row.';
  return 'Importing history from a file is for accounts linked through Plaid: a manual account imports a file with Import on its row.';
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

/** A day (YYYY-MM-DD) in words: "Mar 12, 2026". */
const shownDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** The account's end (#50, lib/lifecycle.ts), through the links that apply,
 *  or null while it counts. LENIENT, for the review's words only: an end
 *  that can't be read says nothing here (whatever counts the rows reads the
 *  ends strictly, and leaves out those from its day on). */
async function endOfAccount(ctx: Ctx, account_id: string, links: Map<string, Link>): Promise<EndedLifecycle | null> {
  const { entries } = await lifecycleStore.getAllReport(ctx);
  const l = lifecycleOf(effectiveLifecycle(entries, links), account_id)?.lifecycle;
  return l && l.state !== 'active' ? l : null;
}

/** What importing rows dated from an account's end on does, in words: kept,
 *  counted in nothing while it has ended, as its bank's own from then. */
function endedWords(name: string, l: EndedLifecycle, rows: number): string {
  const day = shownDay(endOf(l)!);
  const when = l.state === 'closed' ? `${name} closed on ${day}` : l.state === 'left' ? `${name} has not been yours since ${day}` : `You stopped following ${name} from ${day}`;
  const one = rows === 1;
  return `${when}: ${one ? 'one of the transactions' : `${rows.toLocaleString('en-US')} of the transactions`} this file adds ${one ? 'is' : 'are'} dated from then, and ${one ? 'counts' : 'count'} in nothing, as its bank’s own from then don’t. ${one ? 'It is' : 'They are'} kept, and ${one ? 'counts' : 'count'} again if you reopen it.`;
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

/** What a change did to the estimated history: drawn again at once (with the
 *  oldest day drawn, and how far back this account's estimate now follows
 *  imported transactions), or to be drawn on the next load, after the backfill
 *  runs again when rows dated after its earliest point changed
 *  (lib/history-import/extend.ts importedRowsChanged). */
type Redrawn = { drawn: boolean; from: string | null; reach: string | null; backfill: boolean };

/** Draws the estimated history again after a change to the account's rows
 *  dated `dates` (only a bank account's or card's are walked): best effort,
 *  since the change is made either way and the record stays marked for the
 *  next load to draw. */
async function redraw(ctx: Ctx, account: LinkedAccount, dates: readonly string[]): Promise<Redrawn> {
  try {
    const walked = account.type === 'depository' || account.type === 'credit';
    const backfill = await importedRowsChanged(ctx, { dates: walked ? dates : [] });
    if (backfill || !(await isBackfillDone(ctx))) return { drawn: false, from: null, reach: null, backfill };
    const { state } = await drawImportedHistory(ctx);
    return { drawn: true, from: state.from, reach: state.accounts.find((a) => a.account_id === account.account_id)?.reach ?? null, backfill: false };
  } catch (err) {
    console.error('history import: the estimated history was not drawn again', loggable(err));
    return { drawn: false, from: null, reach: null, backfill: false };
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
    const settled = countedRows(context.held, context.banks, context.order, { bankFrom: context.bank_from, covers: context.covers, twins: context.twins });
    const [imports, settings, drawn] = await Promise.all([listHistoryImports(ctx, context.ids, settled), readSettings(ctx, account.account_id), readDrawState(ctx)]);
    const reach = drawn?.accounts.find((a) => a.account_id === account.account_id) ?? null;
    return NextResponse.json({
      imports,
      settings,
      bank_from: context.bank_from,
      history_pending: context.history_pending,
      walked: ['depository', 'credit'].includes(account.type),
      // Its currency at the bank, for a file that doesn't say one: the sheet
      // opened from the Accounts that ended card doesn't know it.
      currency: account.currency,
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

/** Whether an OFX statement is for another account than this one: the one
 *  this account's last OFX file was for, or, before its first, the account's
 *  own number as the bank gives Plaid its last digits (its mask). */
function mismatchOf(
  remembered: ImportSettings | null,
  statement: Ready['statement'],
  account: LinkedAccount
): { expected: string; found: string; basis: 'last-file' | 'mask' } | null {
  const last = accountMismatch(remembered?.ofx?.statement, statement);
  if (last) return { ...last, basis: 'last-file' };
  if (remembered?.ofx?.statement) return null;
  const found = statement?.account?.mask?.trim();
  const own = account.mask?.trim();
  if (!found || !own) return null;
  const n = Math.min(found.length, own.length);
  if (found.slice(-n) === own.slice(-n)) return null;
  return { expected: `an account ending ${own}`, found: `${statement!.kind === 'creditcard' ? 'a credit card' : 'an account'} ending ${found}`, basis: 'mask' };
}

function reviewOf(
  read: Ready,
  plan: HistoryPlan,
  extra: {
    encoding: string;
    warnings: string[];
    mismatch: ReturnType<typeof mismatchOf>;
    currency_from: 'file' | 'chosen' | 'account';
    covers: Covers | null;
    history_pending: boolean;
    files: ReadonlyMap<string, { file_name: string | null; imported_at: string }>;
  }
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
    // A proposal of a row an earlier import kept names that import's file.
    proposals: plan.proposals.slice(0, LISTED_PROPOSALS).map((p) => {
      const from = p.twin.import_id ? extra.files.get(p.twin.import_id) : undefined;
      return from ? { ...p, twin: { ...p.twin, file_name: from.file_name, imported_at: from.imported_at } } : p;
    }),
    more_proposals: Math.max(0, plan.proposals.length - LISTED_PROPOSALS),
    conflicts: plan.conflicts.slice(0, LISTED_CONFLICTS),
    more_conflicts: Math.max(0, plan.conflicts.length - LISTED_CONFLICTS),
    kinds: plan.kinds,
    first_date: plan.first_date,
    last_date: plan.last_date,
    covers: extra.covers,
    bank_from: plan.bank_from,
    history_pending: extra.history_pending,
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
    // The period the file covers, before matching: a pair across its edge is
    // one only through a posting lag (lib/history-import/plan.ts).
    let first: string | null = null;
    let last: string | null = null;
    for (const { row } of normalized.rows) {
      if (first === null || row.date < first) first = row.date;
      if (last === null || row.date > last) last = row.date;
    }
    const covered = coverOf(meta, first, last, read, today, problems.length > 0);
    if (typeof covered === 'string') return bad(covered);
    const imports = new Map([...context.summaries].map(([id, s]) => [id, { covers: { from: s.covers.from, to: s.covers.to }, file_name: s.file_name, imported_at: s.imported_at }]));
    const plan = planHistoryImport({
      rows: normalized.rows,
      problems,
      held: context.held,
      banks: context.banks,
      order: context.order,
      bankFrom: context.bank_from,
      twins: context.twins,
      covers: covered,
      imports,
      choices: meta.choices,
    });

    const settings = await readSettings(ctx, account.account_id);
    const mismatch = format === 'ofx' ? mismatchOf(settings, read.statement, account) : null;
    const warnings: string[] = [...read.read.repairs];
    const named = formatFromName(meta.file_name);
    if (named && named !== format) warnings.push(`This file is named as ${FORMAT_NAMES[named]} but holds ${FORMAT_NAMES[format]}, so it was read as ${FORMAT_NAMES[format]}.`);
    if (read.read.reversed_hint) {
      warnings.push('Most of this statement’s debits are written as money coming in, so this bank may write its amounts the other way round. Check the rows below, and flip them if they read backwards.');
    }
    if (fromFile && account.currency && fromFile !== account.currency) {
      warnings.push(`This statement is in ${fromFile}, but ${account.name} is in ${account.currency} at the bank. Check it is this account’s file.`);
    }
    // An account that ended (#50) takes a file as any does: what it adds from
    // its end on counts in nothing, as its bank's own from then, and is said.
    const ended = await endOfAccount(ctx, account.account_id, links);
    if (ended) {
      const after = plan.rows.filter((r, i) => plan.actions[i] === 'add' && r.row.date >= endOf(ended)!).length;
      if (after > 0) warnings.push(endedWords(account.name, ended, after));
    }

    if (meta.action === 'preview') {
      return NextResponse.json({
        preview: reviewOf(read, plan, { encoding, warnings, mismatch, currency_from, covers: covered, history_pending: context.history_pending, files: imports }),
      });
    }

    if (mismatch && !meta.acknowledge_account) {
      return NextResponse.json(
        {
          error:
            mismatch.basis === 'mask'
              ? `This file is for ${mismatch.found}, but ${account.name} is ${mismatch.expected}. Check it is the right file, then import it anyway.`
              : `This file is for ${mismatch.found}, but ${account.name}’s last OFX file was for ${mismatch.expected}. Check it is the right file, then import it anyway.`,
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
        imports,
        bank_from: context.bank_from,
        twins: context.twins,
        restored: context.restored,
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
    const counts = { imported: c.new, duplicates: c.duplicates, already: c.already, present: c.present, repeated: c.repeated, skipped: c.skipped, unreadable: c.unreadable };
    if (!result.import_id) return NextResponse.json({ ...counts, import_id: null, history: { drawn: false, from: null, reach: null, backfill: false } });
    // The transactions cached for the Activity tab hold the banks' part, which
    // the imported rows are part of.
    await clearTransactionsCache(ctx);
    // The rows it added that count, by day: those after the earliest point the
    // chart has are the backfill's to walk.
    const added = result.plan.rows.flatMap((r, i) => (result.plan.actions[i] === 'add' ? [r.row.date] : []));
    const history = await redraw(ctx, account, added);
    return NextResponse.json({ ...counts, import_id: result.import_id, before_bank: result.plan.before_bank, history });
  } catch (err) {
    return storeFailure(err, 'Failed to import the file');
  }
}

/** The period the file covers (lib/history-import/commit.ts coveredPeriod),
 *  or why the one the person gave can't be: it may only widen the file's own,
 *  never leave a row out, and never reach past tomorrow. A file with lines
 *  that couldn't be read covers it whole only when the person says those
 *  lines aren't transactions (`whole`). */
function coverOf(meta: HistoryMeta, first: string | null, last: string | null, read: Ready, today: string, unread: boolean): Covers | null | string {
  const stated = meta.covers;
  if (stated && first && last) {
    if (stated.from > first || stated.to < last) {
      return `The period the file covers must hold every row in it, from ${first} to ${last}.`;
    }
    if (stated.to > addDays(today, 1)) return 'The period the file covers can’t reach into the future.';
  }
  const covers = coveredPeriod(read.statement, first, last, today, stated);
  return covers && unread && meta.whole ? { ...covers, whole: true } : covers;
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
    const history = await redraw(ctx, found.account, undone.dates);
    return NextResponse.json({ removed: undone.removed, duplicates: undone.duplicates, kept: undone.kept, history });
  } catch (err) {
    if (err instanceof HistoryImportNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    return storeFailure(err, 'Failed to undo the import');
  }
}
