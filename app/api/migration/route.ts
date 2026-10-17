import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import type { Ctx } from '@/lib/containers';
import { clearCaches, clearTransactionsCache } from '@/lib/cache';
import { clearBackfillDone, isBackfillDone } from '@/lib/history';
import { StoredValueTooLargeError } from '@/lib/repo';
import { storeFailure } from '@/lib/store-failure';
import { loggable } from '@/lib/log-safe';
import { CategoryError } from '@/lib/categories';
import { TagError } from '@/lib/tags';
import { SplitError } from '@/lib/splits';
import { MAX_FILE_BYTES } from '@/lib/import/record';
import { appFileText } from '@/lib/import/apps/file';
import { MAX_APP_ROWS, readAppFile } from '@/lib/import/apps/read';
import { APP_NAMES, ROLE_NAMES } from '@/lib/import/apps/types';
import { ConflictsUnresolvedError } from '@/lib/import/commit';
import { IMPORT_READS_PER_HOUR, IMPORT_REQUESTS_PER_HOUR, takeImportRead, takeImportRequest, type ImportAllowance } from '@/lib/import/store';
import { ReviewChangedError, UnansweredError } from '@/lib/history-import/commit';
import { drawImportedHistory, importedRowsChanged } from '@/lib/history-import/extend';
import { planMigration, type MigrationPlan } from '@/lib/migration/plan';
import { readTargets, type ReadTargets } from '@/lib/migration/targets';
import { readMigrationMeta } from '@/lib/migration/request';
import { CategoriesChangedError } from '@/lib/migration/categories';
import { commitMigration, listMigrations, MigrationBusyError, MigrationLinksUnreadableError, MigrationNotFoundError, MigrationRoomError, migrationUndoPlan, undoMigration } from '@/lib/migration/commit';
import { MAX_SOURCE_CATEGORIES } from '@/lib/migration/plan';
import { isMigrationId, migrationStore } from '@/lib/migration/store';

// Importing another app's export (M2, "Migration importers"; lib/import/apps/
// reads the file, lib/migration/ plans, commits and undoes it).
//
//   GET    every import from another app, newest first, with what it made
//          (for Undo). &undo=<id> what undoing it would take out.
//   POST   a form upload: `file` (the app's CSV, or the zip it exports) and
//          `meta` (JSON) with `action`:
//            "preview"   reads the file and plans the import against the
//                        person's accounts and categories, writing nothing
//                        but the person's categories when they were never
//                        made (lib/migration/targets.ts): the REVIEW. Which
//                        app, its accounts and where each goes (a question
//                        until the person answers), its categories mapped to
//                        theirs, its tags, its splits rebuilt or not and why,
//                        each Nya account's own import (a linked account's
//                        review against its bank's rows), the lines that
//                        can't be read, what blocks it, and its fingerprint
//                        (`review`).
//            "import"    the same, with the fingerprint of the review the
//                        person saw and the import's id (minted by the
//                        sheet, so one sent twice is made once): refused
//                        (409, needs "review") when anything changed since,
//                        (409, needs "answers") while an account or a
//                        proposal has no answer, and (409) while something
//                        blocks it. Then one commit, all of it or none
//                        (lib/migration/commit.ts), and the estimated history
//                        of each linked account drawn back through its rows.
//          A file that needs an answer first (which app and which column is
//          which, for a header Nya doesn't know; the order of its dates) is
//          answered with `needs`, as app/api/import answers.
//   DELETE { migration_id, confirm: true }: Undo, all of it in one action.
//
// LIMITS: the file, a request and every answer as the import routes bound
// theirs (MAX_FILE_BYTES; MAX_APP_ROWS transactions, at most MAX_IMPORT_ROWS
// into any one account; LISTED_*), counted against the same hourly budgets.
// Files are never logged.

export const maxDuration = 120;

const MAX_META_CHARS = 256 * 1024;
/** The file, the answers (a character of them up to three bytes) and the
 *  form around them: under Vercel's 4.5 MB limit on a request's body. */
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + MAX_META_CHARS * 3 + 64 * 1024;
const LISTED_PROBLEMS = 200;
const LISTED_PROPOSALS = 500;
const LISTED_TAGS = 300;
const LISTED_LINES = 20;
/** Every one of the app's categories the person can answer for. */
const LISTED_CATEGORIES = MAX_SOURCE_CATEGORIES;
const PREVIEW_ROWS = 6;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const utcToday = () => new Date().toISOString().slice(0, 10);
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
const tooLarge = () =>
  NextResponse.json(
    { error: `This file is larger than ${MAX_FILE_BYTES / (1024 * 1024)} MB, more than one import takes. Export a shorter period, or some of its accounts at a time.` },
    { status: 413 }
  );

function tooMany(retryAfterSeconds: number, what: string): NextResponse {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return NextResponse.json(
    { error: `${what}. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, retry_after_seconds: retryAfterSeconds },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } }
  );
}

/** Counts this request against an hourly limit, shared with the other
 *  imports: the response refusing it, or null. Fails closed. */
async function limited(take: () => Promise<ImportAllowance>, what: string): Promise<NextResponse | null> {
  try {
    const allowed = await take();
    return allowed.ok ? null : tooMany(allowed.retryAfterSeconds, what);
  } catch (err) {
    console.error('migration: the request limit could not be checked', loggable(err));
    return NextResponse.json({ error: 'The import limit could not be checked just now, so nothing was done. Try again in a minute.' }, { status: 503 });
  }
}
const overLimit = (ctx: Ctx) => limited(() => takeImportRequest(ctx), `Files can be read or imported ${IMPORT_REQUESTS_PER_HOUR} times an hour`);
const overReadLimit = (ctx: Ctx) => limited(() => takeImportRead(ctx), `Past imports can be listed ${IMPORT_READS_PER_HOUR} times an hour`);

export async function GET(req: Request) {
  try {
    const ctx = await dataCtx();
    const undo = new URL(req.url).searchParams.get('undo');
    if (undo !== null && !isMigrationId(undo)) return bad('Invalid import');
    const over = await overReadLimit(ctx);
    if (over) return over;
    if (undo !== null) return NextResponse.json({ undo: await migrationUndoPlan(ctx, undo) });
    return NextResponse.json({ imports: await listMigrations(ctx), limits: { max_bytes: MAX_FILE_BYTES, max_rows: MAX_APP_ROWS } });
  } catch (err) {
    if (err instanceof MigrationNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof MigrationLinksUnreadableError) return NextResponse.json({ error: err.message }, { status: 409 });
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

/** The review, bounded whatever the file (see LIMITS). */
function reviewOf(plan: MigrationPlan, targets: ReadTargets, file: { entry: string | null; encoding: string }, answers: { currency: string | null; carry: boolean }) {
  const r = plan.read;
  const listed = <T>(list: readonly T[], max: number) => ({ list: list.slice(0, max), more: Math.max(0, list.length - max) });
  const problems = listed(plan.problems, LISTED_PROBLEMS);
  const tags = listed(plan.tags.names, LISTED_TAGS);
  const mappings = listed(plan.categories.mappings, LISTED_CATEGORIES);
  return {
    app: r.app,
    app_name: APP_NAMES[r.app],
    variant: r.parsed.variant,
    detected: r.detected,
    entry: file.entry,
    encoding: file.encoding,
    columns: Object.fromEntries(Object.entries(r.columns).map(([role, at]) => [role, { at, header: r.header[at as number] ?? null, name: ROLE_NAMES[role as keyof typeof ROLE_NAMES] }])),
    read: r.read,
    // The currency the person chose for the amounts that don't say theirs,
    // and whether the file has a column that says (Lunch Money's).
    currency: { chosen: answers.currency, in_file: r.columns.currency !== undefined },
    // Whether a linked account's rows its bank has take the app's category,
    // tags, note and split (MigrationAnswers.carry).
    carry: answers.carry,
    rows: r.parsed.txns.length,
    // The file's first rows as read, money out and money in: what the sign
    // it was read with is checked by before any account is answered.
    sample: r.parsed.txns.slice(0, PREVIEW_ROWS).map((t) => ({ line: t.line, date: t.date, name: t.payee, amount: t.amount, currency: t.currency, account: t.account })),
    notes: [...r.parsed.notes, ...targets.notes],
    accounts: plan.accounts,
    offered: targets.offered,
    categories: { ...plan.categories, mappings: mappings.list, more: mappings.more },
    counts: plan.counts,
    tags: { on: plan.tags.on, names: tags.list, more: tags.more, added: plan.tags.added, room: plan.tags.room },
    splits: {
      rebuilt: r.parsed.splits.rebuilt,
      parts: r.parsed.splits.parts,
      dropped: r.parsed.splits.dropped.length,
      kept: r.parsed.splits.kept.map((k) => ({ reason: k.reason, lines: k.lines.slice(0, LISTED_LINES), count: k.lines.length })),
      unmarked: r.parsed.splits.unmarked,
    },
    problems: problems.list.map((p) => ({ line: p.line, reason: p.reason, account: p.account })),
    more_problems: problems.more,
    targets: plan.targets.map((t) => {
      const p = t.manual ?? t.linked!;
      const proposals = t.linked ? listed(t.linked.proposals, LISTED_PROPOSALS) : { list: [], more: 0 };
      // Its own lines that can't be read: the file's whose account couldn't
      // be told are listed once, above, though each account's import keeps them.
      const tp = listed(t.own_problems, LISTED_PROBLEMS);
      return {
        key: t.key,
        kind: t.kind,
        account_id: t.account_id,
        name: t.name,
        new: !!t.create,
        sources: t.sources,
        currency: t.currency,
        counts: { ...p.counts, unreadable: t.own_problems.length },
        first_date: p.first_date,
        last_date: p.last_date,
        totals: p.totals,
        currency_of_totals: p.currency,
        other_currencies: p.others,
        kinds: p.kinds,
        rows: p.rows.slice(0, PREVIEW_ROWS).map((n, i) => ({ line: n.line, date: n.row.date, name: n.row.name, amount: n.row.amount, currency: n.row.currency, category: n.row.category, action: p.actions[i] })),
        proposals: proposals.list,
        more_proposals: proposals.more,
        problems: tp.list.map((x) => ({ line: x.line, reason: x.reason })),
        more_problems: tp.more,
        before_bank: t.linked?.before_bank ?? null,
        within_bank: t.linked?.within_bank ?? null,
        pending_alike: t.linked?.pending_alike ?? null,
        bank_from: t.linked?.bank_from ?? null,
        history_pending: t.kind === 'linked' && t.account_id ? (targets.contexts.get(t.account_id)?.history_pending ?? false) : false,
        covers: t.covers,
        splits: t.parts.size,
        exploded: t.exploded.map((e) => ({ reason: e.reason, count: e.lines.length })),
        whole: t.whole.map((e) => ({ reason: e.reason, count: e.lines.length })),
        left_out: { opening: t.left_out.opening.length, groups: t.left_out.groups.length, lines: t.left_out.lines.length },
        combined: { transactions: t.combined.transactions, lines: t.combined.lines.length },
        ended: t.ended,
        tags_cut: t.tags_cut,
      };
    }),
    blocks: plan.blocks,
    waiting: plan.waiting,
    needs: plan.needs,
    room: plan.room,
    review: plan.digest,
  };
}

/** Draws the estimated history again after a linked account's rows changed
 *  (only a bank account's or card's are walked): best effort, as the history
 *  import does (app/api/history-import), since the change is made either way
 *  and the record stays marked for the next load to draw. */
async function redraw(ctx: Ctx, changed: { type: string; dates: string[] }[]): Promise<{ drawn: boolean; backfill: boolean }> {
  try {
    const dates = changed.filter((c) => c.type === 'depository' || c.type === 'credit').flatMap((c) => c.dates);
    const backfill = await importedRowsChanged(ctx, { dates });
    if (backfill || !(await isBackfillDone(ctx))) return { drawn: false, backfill };
    await drawImportedHistory(ctx);
    return { drawn: true, backfill: false };
  } catch (err) {
    console.error('migration: the estimated history was not drawn again', loggable(err));
    return { drawn: false, backfill: false };
  }
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
    const meta = readMigrationMeta(parsed);
    if (typeof meta === 'string') return bad(meta);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const content = appFileText(bytes);
    if ('error' in content) return NextResponse.json({ error: content.error }, { status: 422 });
    const read = readAppFile(content.text, { options: meta.options, thisYear: new Date().getUTCFullYear() });
    if (read.status === 'error') return NextResponse.json({ error: read.error }, { status: 422 });
    // A question for the person first: the sheet asks it, and sends again.
    if (read.status !== 'ready') return NextResponse.json({ needs: read.status, ...read, ...(read.status === 'mapping' ? { roles: ROLE_NAMES } : {}) });

    const today = utcToday();
    const answers = meta.answers;
    const chosen = Object.values(answers.accounts);
    const targets = await readTargets(ctx, {
      manualIds: chosen.flatMap((c) => (c.to === 'manual' ? [c.id] : [])),
      linkedIds: chosen.flatMap((c) => (c.to === 'linked' ? [c.id] : [])),
      withTags: answers.tags && read.parsed.txns.some((t) => t.tags.length > 0),
      today,
    });
    const plan = planMigration(read, answers, targets);
    if (meta.action === 'preview') return NextResponse.json({ preview: reviewOf(plan, targets, content, meta.answers) });

    // The same import sent again (its answer lost on the way) is the one
    // already made: said so before anything is compared, since what it made
    // has changed what the review would be.
    const made = await migrationStore.get(ctx, meta.migration_id!);
    if (made) return NextResponse.json({ migration_id: meta.migration_id, already: true, status: made.status, counts: made.counts });
    if (plan.digest !== meta.review) {
      return NextResponse.json({ error: 'What your accounts or categories hold changed since you reviewed this file (a sync, another import, an edit on another device), so nothing was imported. Review it again.', needs: 'review' }, { status: 409 });
    }
    if (plan.waiting.accounts > 0 || plan.waiting.proposals > 0) {
      const n = plan.waiting.accounts + plan.waiting.proposals;
      return NextResponse.json({ error: `${n === 1 ? 'One answer is' : `${n} answers are`} still needed: where each of the file’s accounts goes, and whether each row Nya isn’t sure of is the bank’s.`, needs: 'answers', count: n }, { status: 409 });
    }
    if (plan.blocks.length > 0) return NextResponse.json({ error: plan.blocks[0], blocks: plan.blocks }, { status: 409 });
    if (plan.targets.length === 0) return bad('Choose where at least one of the file’s accounts goes.');

    let result: Awaited<ReturnType<typeof commitMigration>>;
    try {
      result = await commitMigration(ctx, { id: meta.migration_id!, plan, answers, state: targets, file: { name: meta.file_name, entry: content.entry, bytes: bytes.length, encoding: content.encoding } });
    } catch (err) {
      if (err instanceof ReviewChangedError || err instanceof CategoriesChangedError || err instanceof MigrationRoomError) return NextResponse.json({ error: err.message, needs: 'review' }, { status: 409 });
      if (err instanceof UnansweredError) return NextResponse.json({ error: err.message, needs: 'answers', count: err.count }, { status: 409 });
      if (err instanceof ConflictsUnresolvedError) return NextResponse.json({ error: err.message, needs: 'review' }, { status: 409 });
      if (err instanceof CategoryError || err instanceof TagError || err instanceof SplitError) return NextResponse.json({ error: err.message, needs: 'review' }, { status: 409 });
      if (err instanceof StoredValueTooLargeError) {
        console.error('migration: refused as too large to store', err.what);
        return NextResponse.json({ error: 'With this import, one of your accounts’ transactions would be too large to store, so nothing was imported. Import a shorter period.' }, { status: 413 });
      }
      throw err;
    }
    if (result.already) return NextResponse.json({ migration_id: meta.migration_id, already: true, status: result.entry.status, counts: result.entry.counts });
    // Net worth changes with an account it made, and the transactions cached
    // for the Activity tab hold the banks' part, which a linked account's
    // imported rows are part of. Flag first, cache second (as
    // app/api/manual-accounts does).
    if (result.made_accounts) {
      try {
        await clearBackfillDone(ctx);
      } catch (err) {
        console.error('migration: the estimated history could not be marked to rebuild', loggable(err));
      }
      await clearCaches(ctx);
    } else await clearTransactionsCache(ctx);
    const history = result.linked.length > 0 ? await redraw(ctx, result.linked) : { drawn: false, backfill: false };
    return NextResponse.json({ migration_id: meta.migration_id, already: false, counts: result.entry.counts, made: result.entry.made, imports: result.entry.imports, history });
  } catch (err) {
    return storeFailure(err, 'Failed to import the file');
  }
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
    if (!isRecord(body) || !isMigrationId(body.migration_id)) return bad('Invalid import');
    if (body.confirm !== true) return bad('Confirm undoing the import first');
    const undone = await undoMigration(ctx, body.migration_id);
    if (undone.accounts.removed.length > 0) {
      try {
        await clearBackfillDone(ctx);
      } catch (err) {
        console.error('migration: the estimated history could not be marked to rebuild', loggable(err));
      }
      await clearCaches(ctx);
    } else await clearTransactionsCache(ctx);
    const history = undone.linked.length > 0 ? await redraw(ctx, undone.linked) : { drawn: false, backfill: false };
    return NextResponse.json({ ...undone, history });
  } catch (err) {
    if (err instanceof MigrationNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 });
    if (err instanceof MigrationBusyError || err instanceof MigrationLinksUnreadableError) return NextResponse.json({ error: err.message }, { status: 409 });
    return storeFailure(err, 'Failed to undo the import');
  }
}
