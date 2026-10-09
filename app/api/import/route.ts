import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { getManualAccount, isManualId, moveManualBalance, type ManualAccount } from '@/lib/manual';
import { clearNetWorthCache } from '@/lib/cache';
import { clearBackfillDone } from '@/lib/history';
import { DEFAULT_CURRENCY, knownCurrency } from '@/lib/manual-txn-input';
import { manualTxnStore, removeAccountTxns } from '@/lib/manual-txns';
import { StoredValueTooLargeError } from '@/lib/repo';
import { storeFailure } from '@/lib/store-failure';
import { formatMoney } from '@/lib/format';
import { loggable } from '@/lib/log-safe';
import { MAX_FILE_BYTES, MAX_IMPORT_ROWS, type FileFormat } from '@/lib/import/record';
import { decodeFile, detectFormat, formatFromName, FORMAT_NAMES } from '@/lib/import/text';
import { readImport, type ImportOptions, type ReadResult } from '@/lib/import/read';
import { normalizeRecords } from '@/lib/import/normalize';
import { DATE_ORDERS, type DateOrder } from '@/lib/import/dates';
import { COLUMN_ROLES, DELIMITERS, namesOf, type CsvColumns, type Delimiter } from '@/lib/import/csv';
import {
  accountMismatch,
  commitImport,
  CONFLICT_CHOICES,
  ConflictsUnresolvedError,
  ImportNotFoundError,
  listImports,
  noteBalanceSet,
  planImport,
  rememberSettings,
  statementAccountOf,
  statementBalance,
  undoImport,
  undoPlan,
  type ConflictChoice,
  type ConflictChoices,
  type ImportPlan,
  type StatementBalance,
} from '@/lib/import/commit';
import {
  IMPORT_READS_PER_HOUR,
  IMPORT_REQUESTS_PER_HOUR,
  importSettingsStore,
  importStore,
  importSummaryStore,
  isImportId,
  takeImportRead,
  takeImportRequest,
  type ImportAllowance,
  type ImportSettings,
} from '@/lib/import/store';

// File import into a manual account (#43; lib/import/, which says how a file
// is read, matched and committed).
//
//   GET    ?account_id=   the account's past imports, newest first, with
//                         what is left of each (for Undo), and how its last
//                         file was read (for the next one). Read from each
//                         import's summary, never its records.
//          &undo=<id>     what undoing that import would do, for the
//                         confirmation: how many rows go, how many are kept
//                         for a later import that relied on them, how many it
//                         replaced go back as they were.
//   POST   a form upload: `file`, and `meta` (JSON) with the account, the
//          person's answers and `action`:
//            "preview"   reads the file and matches it against the account,
//                        writing nothing: how many rows are new, already
//                        there or repeated, the rows that can't be read
//                        (with their lines and why), the first rows as they
//                        will be read, the dates covered, the currency, and
//                        the statement's balance, offered or only shown;
//            "import"    the same, then the rows in one compare-and-set on
//                        the account's book, and the file's raw records kept
//                        beside them. Refused whole, never cut short, when
//                        the account would grow past the size ceiling, and
//                        refused (409, needs "conflicts") while a row whose
//                        FITID is on another stored transaction has no
//                        answer (lib/import/match.ts): the preview lists
//                        them, and `options.conflicts` carries the choices.
//          A file that needs an answer first (which statement, which
//          columns, which order its dates are in) is answered with
//          `needs` and what the question needs; the import sheet asks it.
//   DELETE { account_id, import_id, confirm: true }: Undo. Every row the
//          import added, edited since or not, and what was said about them,
//          except rows a later import found already there, which are kept
//          for that import; rows it replaced go back as they were.
//
// LIMITS. A file is at most MAX_FILE_BYTES (3 MB) and MAX_IMPORT_ROWS
// (10,000) transactions; the request carrying it, form and all, must fit
// Vercel's 4.5 MB limit on a function's request body, and a declared or
// actual body over MAX_REQUEST_BYTES is refused before it is read as a form.
// Each field is checked as a typed transaction's is (lib/import/normalize.ts).
// Previews, imports and undos together are limited per person an hour, and
// reads of the list and of an undo's plan with a higher limit of their own
// (lib/import/store.ts), both failing closed and counted before a body is
// read. Every answer is bounded whatever the file (lib/import/read.ts): a
// question holds at most MAX_STATEMENTS statements or MAX_CSV_COLUMNS
// columns, and a preview at most LISTED_PROBLEMS problems and
// LISTED_CONFLICTS conflicts.
//
// FILES ARE NEVER LOGGED, nor any of what they hold: errors go to the log
// through loggable(), which keeps their kind and stack, never the request.
//
// BALANCES. An import never moves the account's balance unless the person
// ticks the offer, which is made only for an OFX statement's ledger balance
// dated today or yesterday (lib/import/commit.ts statementBalance), and only
// from the balance the preview showed: one changed since refuses the import,
// as the quick-add form refuses its add (app/api/manual-transactions). The
// move is the same compare-and-set, the estimated history is set to be
// rebuilt and the net-worth cache dropped, and the page reloads net worth,
// which records today's balance like any typed one. No past-dated figure is
// ever written to the history layer.

/** The largest request taken: the file, and the form around it. */
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;
/** The person's answers, as JSON: far more than any mapping needs, with a
 *  choice for each of MAX_CHOICES conflicts. */
const MAX_META_CHARS = 32 * 1024;
/** Rows shown in a preview, and problems, conflicts and shared ids listed,
 *  at most. */
const PREVIEW_ROWS = 8;
const LISTED_PROBLEMS = 200;
const LISTED_CONFLICTS = 200;
const LISTED_SHARED = 50;
/** The most per-row conflict choices a request may carry: the listed ones
 *  and more (the rest follow `all`). */
const MAX_CHOICES = 1_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAccountId = (v: unknown): v is string => typeof v === 'string' && v.length <= 80 && isManualId(v);
const utcToday = () => new Date().toISOString().slice(0, 10);
const cents = (n: number) => Math.round(n * 100);
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

/** Counts this request against an hourly limit: the response refusing it,
 *  or null. Fails closed: a limit that can't be read never opens. */
async function limited(take: () => Promise<ImportAllowance>, what: string): Promise<NextResponse | null> {
  try {
    const allowed = await take();
    return allowed.ok ? null : tooMany(allowed.retryAfterSeconds, what);
  } catch (err) {
    console.error('import: the request limit could not be checked', loggable(err));
    return NextResponse.json({ error: 'The import limit could not be checked just now, so nothing was done. Try again in a minute.' }, { status: 503 });
  }
}

/** A preview, an import or an undo, against their limit. */
const overLimit = (ctx: Ctx) => limited(() => takeImportRequest(ctx), `Files can be read or imported ${IMPORT_REQUESTS_PER_HOUR} times an hour`);
/** A read of the list of imports or of an undo's plan, against theirs. */
const overReadLimit = (ctx: Ctx) => limited(() => takeImportRead(ctx), `Past imports can be listed ${IMPORT_READS_PER_HOUR} times an hour`);

/** One of the container's manual accounts, or the response saying it isn't. */
async function manualAccount(ctx: Ctx, account_id: unknown): Promise<ManualAccount | NextResponse> {
  if (!isAccountId(account_id)) return bad('Choose one of your manual accounts');
  // Strict: an account that can't be read throws, rather than reading as gone.
  const account = await getManualAccount(ctx, account_id);
  return account ?? NextResponse.json({ error: 'That account no longer exists' }, { status: 404 });
}

/** How the account's last file was read. LENIENT: a convenience that only
 *  fills in the sheet and names a statement's account; nothing is written on
 *  this answer (remembering the next one reads strictly, through update). */
async function readSettings(ctx: Ctx, account_id: string): Promise<ImportSettings | null> {
  try {
    return await importSettingsStore.get(ctx, account_id);
  } catch (err) {
    console.warn('import: how this account’s last file was read could not be read', loggable(err));
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    const params = new URL(req.url).searchParams;
    const undo = params.get('undo');
    if (undo !== null && !isImportId(undo)) return bad('Invalid import');
    const over = await overReadLimit(ctx);
    if (over) return over;
    const account = await manualAccount(ctx, params.get('account_id'));
    if (account instanceof NextResponse) return account;
    if (undo !== null) return NextResponse.json({ undo: await undoPlan(ctx, account.account_id, undo) });
    const [imports, settings] = await Promise.all([listImports(ctx, account.account_id), readSettings(ctx, account.account_id)]);
    return NextResponse.json({ imports, settings, limits: { max_bytes: MAX_FILE_BYTES, max_rows: MAX_IMPORT_ROWS } });
  } catch (err) {
    if (err instanceof ImportNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    return storeFailure(err, 'Failed to load the imports');
  }
}

// ---- What a request says ----

type Meta = {
  action: 'preview' | 'import';
  account_id: string;
  file_name: string | null;
  options: ImportOptions;
  conflicts: ConflictChoices;
  acknowledge_account: boolean;
  balance: { from: number; to: number } | null;
};

const OPTION_KEYS = new Set(['statement', 'flip', 'currency', 'date_order', 'decimal', 'csv', 'conflicts']);

const isChoice = (v: unknown): v is ConflictChoice => (CONFLICT_CHOICES as readonly unknown[]).includes(v);

/** The person's choices for conflicts, checked strictly, or why not. */
function readChoices(v: unknown): ConflictChoices | string {
  if (v === undefined || v === null) return {};
  if (!isRecord(v) || Object.keys(v).some((k) => k !== 'all' && k !== 'each')) return 'Invalid choices';
  const out: ConflictChoices = {};
  if (v.all !== undefined) {
    if (!isChoice(v.all)) return 'Invalid choices';
    out.all = v.all;
  }
  if (v.each !== undefined) {
    if (!isRecord(v.each)) return 'Invalid choices';
    const entries = Object.entries(v.each);
    if (entries.length > MAX_CHOICES) return 'Too many choices';
    const each: Record<string, ConflictChoice> = {};
    for (const [index, choice] of entries) {
      if (!/^\d{1,5}$/.test(index) || Number(index) >= MAX_IMPORT_ROWS || !isChoice(choice)) return 'Invalid choices';
      each[String(Number(index))] = choice;
    }
    out.each = each;
  }
  return out;
}

/** The person's answers, checked strictly, or why not. */
function readOptions(v: unknown): ImportOptions | string {
  if (v === undefined || v === null) return {};
  if (!isRecord(v) || Object.keys(v).some((k) => !OPTION_KEYS.has(k))) return 'Invalid options';
  const out: ImportOptions = {};
  if (v.statement !== undefined) {
    if (typeof v.statement !== 'number' || !Number.isInteger(v.statement) || v.statement < 0 || v.statement > 999) return 'Invalid statement';
    out.statement = v.statement;
  }
  if (v.flip !== undefined) {
    if (typeof v.flip !== 'boolean') return 'Invalid options';
    out.flip = v.flip;
  }
  if (v.currency !== undefined) {
    const code = typeof v.currency === 'string' ? v.currency.trim().toUpperCase() : '';
    if (!knownCurrency(code)) return 'Enter a currency as its three-letter code, like USD or EUR';
    out.currency = code;
  }
  if (v.date_order !== undefined) {
    if (!(DATE_ORDERS as readonly unknown[]).includes(v.date_order)) return 'Invalid date order';
    out.date_order = v.date_order as DateOrder;
  }
  if (v.decimal !== undefined) {
    if (v.decimal !== '.' && v.decimal !== ',') return 'Invalid decimal mark';
    out.decimal = v.decimal;
  }
  if (v.csv !== undefined) {
    const csv = v.csv;
    if (!isRecord(csv) || Object.keys(csv).some((k) => !['delimiter', 'header_line', 'columns', 'sign'].includes(k))) return 'Invalid columns';
    if (csv.delimiter !== undefined && !(DELIMITERS as readonly unknown[]).includes(csv.delimiter)) return 'Invalid separator';
    if (csv.header_line !== undefined && (typeof csv.header_line !== 'number' || !Number.isInteger(csv.header_line) || csv.header_line < 1 || csv.header_line > 10_000_000)) {
      return 'Invalid line for the column names';
    }
    if (csv.sign !== 'negative-out' && csv.sign !== 'positive-out') return 'Say how money out is written';
    if (!isRecord(csv.columns)) return 'Invalid columns';
    const columns: Partial<CsvColumns> = {};
    for (const [role, at] of Object.entries(csv.columns)) {
      if (!(COLUMN_ROLES as readonly string[]).includes(role) || typeof at !== 'number' || !Number.isInteger(at) || at < 0 || at > 1000) return 'Invalid columns';
      columns[role as keyof CsvColumns] = at;
    }
    if (columns.date === undefined || columns.description === undefined) return 'Choose the date and description columns';
    out.csv = {
      ...(csv.delimiter !== undefined ? { delimiter: csv.delimiter as Delimiter } : {}),
      ...(csv.header_line !== undefined ? { header_line: csv.header_line as number } : {}),
      columns: columns as CsvColumns,
      sign: csv.sign,
    };
  }
  return out;
}

/** A file's name as the device gave it: no path, no control characters, and
 *  short. Shown in the list of imports; never anything else. */
function cleanFileName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const name = v.split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 200);
  return name || null;
}

function readMeta(v: unknown): Meta | string {
  if (!isRecord(v)) return 'Invalid request';
  if (v.action !== 'preview' && v.action !== 'import') return 'Invalid request';
  if (!isAccountId(v.account_id)) return 'Choose one of your manual accounts';
  if (v.file_name !== undefined && v.file_name !== null && typeof v.file_name !== 'string') return 'Invalid request';
  if (v.acknowledge_account !== undefined && typeof v.acknowledge_account !== 'boolean') return 'Invalid request';
  const options = readOptions(v.options);
  if (typeof options === 'string') return options;
  const conflicts = readChoices(isRecord(v.options) ? v.options.conflicts : undefined);
  if (typeof conflicts === 'string') return conflicts;
  let balance: Meta['balance'] = null;
  if (v.balance !== undefined && v.balance !== null) {
    const b = v.balance;
    if (!isRecord(b) || typeof b.from !== 'number' || !Number.isFinite(b.from) || typeof b.to !== 'number' || !Number.isFinite(b.to)) return 'Invalid balance update';
    balance = { from: b.from, to: b.to };
  }
  return { action: v.action, account_id: v.account_id, file_name: cleanFileName(v.file_name), options, conflicts, acknowledge_account: v.acknowledge_account === true, balance };
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

// ---- What an answer says ----

type Ready = Extract<ReadResult, { status: 'ready' }>;

/** How the file was read, as the import keeps it with its records. */
function readOf(options: ImportOptions, read: Ready): Record<string, unknown> {
  return {
    options,
    date_order: read.read.date_order,
    date_style: read.read.date_style,
    decimal: read.read.decimal,
    ...(read.read.table ? { delimiter: read.read.table.delimiter, header_line: read.read.table.header_line, skipped: read.read.skipped ?? 0 } : {}),
  };
}

/** What the account should remember of how this file was read: for an OFX
 *  file, the currency only when its statement didn't say one, as that is
 *  what the next such file is read in. */
function settingsFor(
  format: FileFormat,
  options: ImportOptions,
  read: Ready,
  currency: string,
  remembered: ImportSettings | null
): Partial<Omit<ImportSettings, 'version' | 'updated_at'>> {
  if (format === 'ofx') {
    const chosen = read.statement?.currency ? remembered?.ofx?.currency : currency;
    return { ofx: { statement: statementAccountOf(read.statement), flip: options.flip === true, ...(chosen ? { currency: chosen } : {}) } };
  }
  if (format === 'qif') return { qif: { date_order: read.read.date_order, decimal: read.read.decimal, flip: options.flip === true, currency } };
  const table = read.read.table!;
  return {
    csv: {
      columns: namesOf(options.csv!.columns, table.header),
      sign: options.csv!.sign,
      decimal: read.read.decimal,
      date_order: read.read.date_order,
      delimiter: table.delimiter,
      currency,
    },
  };
}

/** What the preview says became of a row, in one word. */
function rowOutcome(plan: ImportPlan, i: number): 'new' | 'present' | 'repeated' | 'replace' | 'skip' | 'conflict' {
  const o = plan.outcomes[i];
  const action = plan.actions[i];
  if (o.outcome !== 'conflict') return o.outcome;
  return action === 'add' ? 'new' : action === 'replace' ? 'replace' : action === 'ask' ? 'conflict' : 'skip';
}

function previewOf(
  read: Ready,
  plan: ImportPlan,
  extra: {
    encoding: string;
    warnings: string[];
    mismatch: { expected: string; found: string } | null;
    balance: StatementBalance | null;
    currency_from: 'file' | 'chosen' | 'default';
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
      note: r.row.note,
      outcome: rowOutcome(plan, i),
    })),
    problems: plan.problems.slice(0, LISTED_PROBLEMS).map((p) => ({ line: p.line, reason: p.reason })),
    more_problems: Math.max(0, plan.problems.length - LISTED_PROBLEMS),
    conflicts: plan.conflicts.slice(0, LISTED_CONFLICTS),
    more_conflicts: Math.max(0, plan.conflicts.length - LISTED_CONFLICTS),
    shared_ids: plan.shared_ids.slice(0, LISTED_SHARED),
    more_shared_ids: Math.max(0, plan.shared_ids.length - LISTED_SHARED),
    kinds: plan.kinds,
    first_date: plan.first_date,
    last_date: plan.last_date,
    currency: plan.currency,
    currency_from: extra.currency_from,
    other_currencies: plan.others,
    totals: plan.totals,
    shortened: plan.shortened,
    warnings: extra.warnings,
    account_mismatch: extra.mismatch,
    balance: extra.balance,
  };
}

// ---- Preview and import ----

export async function POST(req: Request) {
  try {
    const ctx = await dataCtx();
    // Counted before anything is read, so every request that costs a body
    // read counts, whatever it turns out to hold.
    const over = await overLimit(ctx);
    if (over) return over;
    // A body over the limit is refused before it is read as a form, whatever
    // it claims; one that claims too much is refused before it is read.
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
    const meta = readMeta(parsed);
    if (typeof meta === 'string') return bad(meta);

    const account = await manualAccount(ctx, meta.account_id);
    if (account instanceof NextResponse) return account;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const { text, encoding } = decodeFile(bytes);
    const format = detectFormat(text);
    const read = readImport(text, { format, options: meta.options, thisYear: new Date().getUTCFullYear() });
    if (read.status === 'error') return NextResponse.json({ error: read.error, format }, { status: 422 });
    // A question for the person first: the sheet asks it, and sends again.
    if (read.status !== 'ready') return NextResponse.json({ needs: read.status, ...read });

    const today = utcToday();
    // The statement's own currency for OFX, whatever was sent; for the others
    // (and an OFX file that doesn't say), the one chosen in the sheet, else
    // the manual accounts' own. The preview says which.
    const fromFile = format === 'ofx' ? (read.statement?.currency ?? null) : null;
    const currency = fromFile ?? meta.options.currency ?? DEFAULT_CURRENCY;
    const currency_from = fromFile ? 'file' : meta.options.currency ? 'chosen' : 'default';
    const normalized = normalizeRecords(read.records, { today, currency });
    const problems = [...read.problems, ...normalized.problems];
    const settings = await readSettings(ctx, account.account_id);
    const mismatch = format === 'ofx' ? accountMismatch(settings?.ofx?.statement, read.statement) : null;
    const balance = format === 'ofx' ? statementBalance(account, read.statement, today) : null;
    const warnings: string[] = [...read.read.repairs];
    const named = formatFromName(meta.file_name);
    if (named && named !== format) warnings.push(`This file is named as ${FORMAT_NAMES[named]} but holds ${FORMAT_NAMES[format]}, so it was read as ${FORMAT_NAMES[format]}.`);
    if (read.read.reversed_hint) {
      warnings.push('Most of this statement’s debits are written as money coming in, so this bank may write its amounts the other way round. Check the rows below, and flip them if they read backwards.');
    }

    if (meta.action === 'preview') {
      // Strict: a book that can't be read is never matched as an empty one.
      const plan = planImport(normalized.rows, problems, await manualTxnStore.get(ctx, account.account_id), meta.conflicts);
      return NextResponse.json({ preview: previewOf(read, plan, { encoding, warnings, mismatch, balance, currency_from }) });
    }

    // Everything the person must have agreed to is checked before anything is written.
    if (mismatch && !meta.acknowledge_account) {
      return NextResponse.json(
        {
          error: `This file is for ${mismatch.found}, but ${account.name}’s last OFX file was for ${mismatch.expected}. Check it is the right file, then import it anyway.`,
          account_mismatch: mismatch,
        },
        { status: 409 }
      );
    }
    let setBalance = false;
    if (meta.balance) {
      if (!balance || balance.refusal) return bad('This statement’s balance can’t be set as the account’s.');
      if (cents(meta.balance.to) !== cents(balance.amount)) return bad('That isn’t this statement’s balance.');
      // Set already (this import sent again): nothing more to move.
      if (cents(account.balance) !== cents(meta.balance.to)) {
        if (cents(meta.balance.from) !== cents(account.balance)) {
          return NextResponse.json(
            {
              error: `${account.name}’s balance changed to ${formatMoney(account.balance, DEFAULT_CURRENCY)} since the preview, so nothing was imported. Check it and import again.`,
              balance: account.balance,
            },
            { status: 409 }
          );
        }
        setBalance = true;
      }
    }

    let result: Awaited<ReturnType<typeof commitImport>>;
    try {
      result = await commitImport(ctx, {
        account,
        format,
        file_name: meta.file_name,
        file_bytes: bytes.length,
        encoding,
        rows: normalized.rows,
        problems,
        read: readOf(meta.options, read),
        statement: read.statement,
        columns: read.read.table?.header ?? null,
        choices: meta.conflicts,
      });
    } catch (err) {
      if (err instanceof ConflictsUnresolvedError) {
        return NextResponse.json({ error: err.message, needs: 'conflicts', conflicts: err.count }, { status: 409 });
      }
      if (err instanceof StoredValueTooLargeError) {
        console.error('import: refused as too large to store', err.what);
        return NextResponse.json(
          {
            error:
              err.what === manualTxnStore.what
                ? `${account.name} can’t take this import: with it, its transactions would be too large to store, so nothing was imported. Import a shorter period.`
                : 'This file’s records are too large to keep with the import, so nothing was imported. Import a shorter period.',
          },
          { status: 413 }
        );
      }
      throw err;
    }
    // An account deleted while this was saved (app/api/manual-accounts
    // DELETE) mustn't be left a book nothing shows: its rows go with it.
    if (result.import_id && !(await getManualAccount(ctx, account.account_id))) {
      await removeAccountTxns(ctx, account.account_id);
      await importStore.remove(ctx, result.import_id);
      await importSummaryStore.remove(ctx, result.import_id);
      return NextResponse.json({ error: 'That account no longer exists' }, { status: 404 });
    }
    await rememberSettings(ctx, account.account_id, settingsFor(format, meta.options, read, currency, settings));

    const c = result.plan.counts;
    const counts = { imported: c.new, present: c.present, repeated: c.repeated, unreadable: c.unreadable, replaced: c.replaced, skipped: c.skipped };
    let balance_updated = !!meta.balance && !setBalance;
    let balance_error: string | null = null;
    if (setBalance && meta.balance && balance?.as_of) {
      try {
        const moved = await moveManualBalance(ctx, account.account_id, meta.balance.from, meta.balance.to, result.import_id ?? `import-balance:${crypto.randomUUID()}`);
        if (moved === 'moved' || moved === 'already') {
          balance_updated = true;
          // As the account's Update form does: flag first, cache second.
          try {
            await clearBackfillDone(ctx);
          } catch (err) {
            console.error('import: the estimated history could not be marked to rebuild', loggable(err));
          }
          await clearNetWorthCache(ctx);
          if (result.import_id) await noteBalanceSet(ctx, result.import_id, { from: meta.balance.from, to: meta.balance.to, as_of: balance.as_of });
        } else {
          balance_error =
            moved === 'missing'
              ? 'Its account no longer exists.'
              : `${account.name}’s balance changed meanwhile, so it wasn’t set. Check it on the account.`;
        }
      } catch (err) {
        console.error('import: the balance could not be set', loggable(err));
        balance_error = `${account.name}’s balance may not have been set. Check it on the account.`;
      }
    }
    return NextResponse.json({
      ...counts,
      import_id: result.import_id,
      balance_updated,
      ...(balance_updated && meta.balance ? { balance: meta.balance.to } : {}),
      ...(balance_error ? { balance_error } : {}),
    });
  } catch (err) {
    return storeFailure(err, 'Failed to import the file');
  }
}

// ---- Undo ----

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
    if (!isRecord(body) || !isImportId(body.import_id)) return bad('Invalid import');
    if (body.confirm !== true) return bad('Confirm undoing the import first');
    const account = await manualAccount(ctx, body.account_id);
    if (account instanceof NextResponse) return account;
    const undone = await undoImport(ctx, account.account_id, body.import_id);
    return NextResponse.json({ removed: undone.removed, edited: undone.edited, moved: undone.moved, kept: undone.kept, restored: undone.restored });
  } catch (err) {
    if (err instanceof ImportNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    return storeFailure(err, 'Failed to undo the import');
  }
}
