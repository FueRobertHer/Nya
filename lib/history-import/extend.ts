// lib/history-import/extend.ts
//
// Drawing the estimated history back through what was imported into linked
// accounts (#52): reads what lib/history-import/walk.ts needs, runs it, and
// writes its points into the ESTIMATED layer, older than every point the
// chart had (lib/history.ts replaceEstimatedBefore). The real snapshot layer
// is never written, and nothing at or after the anchor changes, so an import,
// an undo or a drawing leaves every recorded balance byte for byte as it was.
//
// WHEN. After an import or an undo (the import route draws it at once, when
// the estimated layer it joins exists), after a link or an unlink, a forget,
// and after every run of the backfill (app/api/backfill), whose points it
// joins: each marks it to draw again (markDrawStale, a new generation), and
// the dashboard's next load asks the backfill route, which draws whatever is
// marked. Never before the backfill has run once: the anchor must be the
// backfill's own earliest point, not today's, or the backfill's later run
// would cut it in two.
//
// THE BACKFILL FIRST, FOR ROWS AFTER THE ANCHOR. The backfill walks the
// imported rows that count dated in its own window (importedFlowsForBackfill),
// so the anchor's balances hold them: only through the run of covered days
// that reaches today (the bank's window, and the imports' periods the drawing
// uses: lib/history-import/walk.ts), never across a day nothing covers, so a
// row before such a day is walked nowhere, and the chart says so. A change to which of them count (an
// import or an undo with a row dated after the earliest point, a link or an
// unlink, a forget) asks for it to run again first (importedRowsChanged):
// until it has, the drawing waits, so it is never joined to a balance made
// without them. A backfill that ran while such a change landed doesn't call
// itself done (`rows`).
//
// NEVER WITHOUT SAYING SO. A drawing that can't read everything it needs (an
// account's imported rows, its bank's, the imports' periods, a connection's
// accounts) draws nothing, keeps what was drawn, records why (`problem`, for
// the chart's note), and stays marked, so a later load draws it once it can.
//
// WHAT IT KEEPS (lib/history-import/store.ts imported-history-walk): the
// anchor, the oldest day drawn, the exact days it drew (so the next drawing
// clears exactly them and nothing an earlier reconstruction made), how far
// back each account reached and the stretches it could not draw, with why,
// for the chart's note and the API. A drawing overtaken by a change (an
// import landing while it ran) leaves the record marked to draw again.

import type { Ctx } from '../containers';
import { getItems, type StoredItem } from '../storage';
import { getLinks, effectiveLinks } from '../link-core';
import { liveAccountIds } from '../links';
import { readEarliestPoint, replaceEstimatedBefore, isBackfillDone, clearBackfillDone } from '../history';
import { clearNetWorthCache } from '../cache';
import { loggable } from '../log-safe';
import { countedRows, readImported, type ImportedAccountRead, type ImportedRead } from './read';
import { extendHistory, runThrough, type CoveredRange, type WalkAccount } from './walk';
import { historyWalkStore, WALK_ID, type ExcludedImport, type ImportedTxn, type WalkAccountState, type WalkState } from './store';
import { StoredDataUnreadableError } from '../repo';

const EMPTY: WalkState = { version: 1, generation: 0, built: null, built_at: null, anchor: null, from: null, drawn: null, accounts: [], rows: 0, problem: null };

/** A drawing that can't read what it needs (see the header). */
export class DrawUnreadableError extends Error {
  constructor(readonly accounts: string[]) {
    super('The estimated history from imported transactions was not drawn: what it needs can’t be read');
    this.name = 'DrawUnreadableError';
  }
}

/** Whether the estimated history from imports needs drawing again. Strict: a
 *  record that can't be read throws (the caller answers as for any store). */
export async function drawIsStale(ctx: Ctx): Promise<boolean> {
  const state = await historyWalkStore.get(ctx, WALK_ID);
  return !!state && state.built !== state.generation;
}

/** What the chart and the API say about it, or null when nothing was ever
 *  drawn or marked. A display read: a record that can't be read is null, and
 *  the chart says nothing about imports rather than failing. */
export async function readDrawState(ctx: Ctx): Promise<WalkState | null> {
  try {
    return await historyWalkStore.get(ctx, WALK_ID);
  } catch (err) {
    console.warn('history import: what the estimated history from imports covers could not be read', loggable(err));
    return null;
  }
}

/** Marks the estimated history from imports to be drawn again: a new
 *  generation, which a drawing under way can't record as drawn. */
export async function markDrawStale(ctx: Ctx): Promise<void> {
  await historyWalkStore.update(ctx, WALK_ID, (current) => ({ ...(current ?? EMPTY), generation: (current?.generation ?? 0) + 1 }));
}


/**
 * After a change to which imported rows count (see THE BACKFILL FIRST): marks
 * the drawing to be done again, and, when `dates` holds a day after the
 * chart's earliest estimated point, or with `any` (a link, an unlink, a
 * forget, whose rows aren't listed), the backfill to run again before it.
 * Answers whether the backfill must. A record is made only when something
 * was imported (`any` marks only one already there).
 */
export async function importedRowsChanged(ctx: Ctx, changed: { dates: readonly string[] } | 'any'): Promise<boolean> {
  const state = await historyWalkStore.get(ctx, WALK_ID);
  if (changed === 'any' && !state) return false;
  let rerun = false;
  if (await isBackfillDone(ctx)) {
    if (changed === 'any') rerun = true;
    else if (changed.dates.length > 0) {
      const anchor = await readEarliestPoint(ctx, state?.drawn ?? null);
      rerun = !!anchor && anchor.estimated && changed.dates.some((d) => d > anchor.date);
    }
  }
  await historyWalkStore.update(ctx, WALK_ID, (current) => {
    const now = current ?? EMPTY;
    return { ...now, generation: now.generation + 1, rows: now.rows + (rerun ? 1 : 0) };
  });
  if (rerun) await clearBackfillDone(ctx);
  return rerun;
}

/** importedRowsChanged for a link, an unlink or a forget, which change which
 *  account's bank rows an import is matched against (and so which imported
 *  rows count) whether or not anything was imported: only a record already
 *  there is marked, so nobody who never imported gets one. Best effort, for
 *  paths whose own work is done either way: a change not recorded costs a
 *  drawing until the next change records one. */
export async function linksChanged(ctx: Ctx): Promise<void> {
  await importedRowsChanged(ctx, 'any').catch((err) => console.warn('history import: the estimated history could not be marked to draw again', loggable(err)));
}

/** The change count a backfill starts from (see the header): read before it
 *  reads the imported rows, compared once it is done (rowsUnchangedSince).
 *  Lenient: a record that can't be read is 0, as for none. */
export async function rowsVersion(ctx: Ctx): Promise<number> {
  return (await readDrawState(ctx))?.rows ?? 0;
}

/** Whether no change to the imported rows landed since a backfill began. */
export async function rowsUnchangedSince(ctx: Ctx, version: number): Promise<boolean> {
  return (await rowsVersion(ctx)) === version;
}

/**
 * The imported rows the backfill walks (see THE BACKFILL FIRST): those that
 * count (a bank row standing for none of them) of the accounts it walks
 * (`walked`, each with its currency), dated `since` to `today`, in each
 * account's currency, by day; and the accounts whose imported rows can't be
 * read, which the backfill walks without them (the drawing then waits, and
 * says so).
 */
export async function importedFlowsForBackfill(
  ctx: Ctx,
  opts: { items: StoredItem[]; walked: ReadonlyMap<string, string | null>; since: string; today: string }
): Promise<{ flows: { date: string; account_id: string; amount: number }[]; unreadable: string[] }> {
  const [links, live] = await Promise.all([getLinks(ctx), liveAccountIds(ctx, { strict: true, readOnly: true })]);
  // A bank row a restore brought back is never walked: the balance history
  // it belongs to was restored with it (lib/user-restore/restored.ts).
  const read = await readImported(ctx, { items: opts.items, links: effectiveLinks(links, live), only: new Set(opts.walked.keys()), restored: false });
  const flows: { date: string; account_id: string; amount: number }[] = [];
  for (const a of read.accounts) {
    const currency = opts.walked.get(a.account.account_id) ?? a.account.currency;
    const { counted } = countedRows(a.held, a.banks, read.order, { bankFrom: a.bank_from, covers: read.covers, twins: a.twins });
    // Only through the covered days that reach today (see the header).
    const run = runThrough(coverageOf(a, read, counted, currency, opts.today).covered, opts.today);
    if (!run) continue;
    for (const r of counted) {
      if (r.date < opts.since || r.date > opts.today || r.date < run.from) continue;
      if (currency && r.currency !== currency) continue;
      flows.push({ date: r.date, account_id: a.account.account_id, amount: r.amount });
    }
  }
  return { flows, unreadable: [...read.flawed] };
}

/**
 * For the backfill (app/api/backfill), before it writes its points from
 * `baseFrom` on: those days are its own from now, even where a drawing had
 * drawn them (it replaces every estimate from its oldest point on), so the
 * record stops claiming them, and is marked to draw again, joined to the
 * backfill's new earliest point. Before the writes, so a drawing that then
 * fails can never take the backfill's points for its own.
 */
export async function yieldToBackfill(ctx: Ctx, baseFrom: string | null): Promise<void> {
  try {
    await historyWalkStore.update(ctx, WALK_ID, (now) => {
      // Nothing was ever imported or drawn: nothing to give up, nor to mark.
      if (!now) return null;
      const drawn = now.drawn && baseFrom && baseFrom < now.drawn.until ? (baseFrom > now.drawn.from ? { from: now.drawn.from, until: baseFrom } : null) : now.drawn;
      return { ...now, generation: now.generation + 1, drawn };
    });
  } catch (err) {
    // A record nobody can read draws nothing either (drawImportedHistory
    // reads it strictly), so it doesn't hold the backfill back.
    if (!(err instanceof StoredDataUnreadableError)) throw err;
    console.error('history import: what the estimated history from imports covers could not be read', loggable(err));
  }
}

const DEPOSITORY_OR_CREDIT = new Set(['depository', 'credit']);

/** The calendar day before `day` (YYYY-MM-DD). */
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Records why a drawing couldn't be made, leaving the drawing as it was. */
async function recordProblem(ctx: Ctx, accounts: string[]): Promise<void> {
  await historyWalkStore
    .update(ctx, WALK_ID, (current) => ({ ...(current ?? EMPTY), problem: { kind: 'unreadable', accounts } }))
    .catch((err) => console.warn('history import: why the estimated history was not drawn could not be kept', loggable(err)));
}

/** An account's covered days (lib/history-import/walk.ts): its bank's
 *  window, from its connection's earliest posted row to today, and each
 *  import's period, but for one whose file had lines that couldn't be read
 *  (unless the person said they aren't transactions) or rows in another
 *  currency than `currency`, which aren't used: those are `excluded`, with
 *  why. The one rule for the backfill's imported rows and the drawing. */
function coverageOf(
  a: ImportedAccountRead,
  read: ImportedRead,
  counted: readonly ImportedTxn[],
  currency: string | null,
  today: string
): { covered: CoveredRange[]; excluded: ExcludedImport[] } {
  const covered: CoveredRange[] = a.bank_from ? [{ from: a.bank_from, to: today, kind: 'bank' }] : [];
  const excluded: ExcludedImport[] = [];
  const foreign = new Map<string, string>();
  for (const r of counted) if (currency !== null && r.currency !== currency) foreign.set(r.import_id, r.currency);
  for (const [id, s] of read.summaries) {
    if (!a.ids.includes(s.account_id)) continue;
    const other = foreign.get(id) ?? (currency && s.currency && s.currency !== currency ? s.currency : null);
    if (s.counts.unreadable > 0 && !s.covers.whole) excluded.push({ from: s.covers.from, to: s.covers.to, why: 'unreadable', lines: s.counts.unreadable });
    else if (other) excluded.push({ from: s.covers.from, to: s.covers.to, why: 'currency', currency: other });
    else covered.push({ from: s.covers.from, to: s.covers.to, kind: 'import' });
  }
  excluded.sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : 0));
  return { covered, excluded };
}

/** One bank account's or card's walk (lib/history-import/walk.ts), and what
 *  is said of it: where its bank's rows begin, the imports not used, and
 *  whether the backfill walked imported rows of it dated after the anchor
 *  (those in the run of covered days that reaches today, which begins on
 *  `runFrom`). */
function walkOf(
  a: ImportedAccountRead,
  read: ImportedRead,
  anchorDate: string,
  today: string
): { walk: WalkAccount; excluded: ExcludedImport[]; importedAfter: boolean; runFrom: string | null } {
  const currency = a.account.currency;
  const inCurrency = (c: string) => currency === null || c === currency;
  const { counted } = countedRows(a.held, a.banks, read.order, { bankFrom: a.bank_from, covers: read.covers, twins: a.twins });
  const { covered, excluded } = coverageOf(a, read, counted, currency, today);
  const run = runThrough(covered, today);
  const flows = new Map<string, number>();
  let movedAfter = false;
  let importedAfter = false;
  const add = (date: string, amount: number, walkedByBackfill: boolean) => {
    if (date > anchorDate) {
      movedAfter = true;
      importedAfter ||= walkedByBackfill;
      return;
    }
    flows.set(date, (flows.get(date) ?? 0) + amount);
  };
  for (const b of a.banks) if (!b.pending) add(b.date, b.amount, false);
  for (const r of counted) if (inCurrency(r.currency)) add(r.date, r.amount, run !== null && r.date >= run.from);
  return {
    walk: { account_id: a.account.account_id, ids: a.ids, type: a.account.type as 'depository' | 'credit', flows, covered, movedAfter },
    excluded,
    importedAfter,
    runFrom: run?.from ?? null,
  };
}

/**
 * Draws it (see the header) and answers how many points were written. Waits
 * for the backfill: before it has run, nothing is drawn and the record stays
 * marked. Throws DrawUnreadableError, having drawn nothing, when what it needs
 * can't be read. `today` is the server's UTC day.
 */
export async function drawImportedHistory(ctx: Ctx, opts: { today?: string } = {}): Promise<{ points: number; state: WalkState }> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const before = (await historyWalkStore.get(ctx, WALK_ID)) ?? EMPTY;
  const generation = before.generation;
  if (!(await isBackfillDone(ctx))) return { points: 0, state: before };

  // The links that apply now, strictly: a link that can't be read would put
  // an account's earlier rows on the wrong account, or none.
  const [items, links, live] = await Promise.all([getItems(ctx), getLinks(ctx), liveAccountIds(ctx, { strict: true })]);
  // Restored bank rows are left out: they are live for rows, never for a
  // balance, whose history was restored with them (lib/user-restore/restored.ts).
  const read = await readImported(ctx, { items, links: effectiveLinks(links, live), restored: false });
  // Everything it needs, read: an account's rows, its bank's, every import's
  // period and order, and whose each book is.
  if (read.flawed.size > 0 || read.unresolved || read.summariesUnreadable.length > 0) {
    const accounts = [...read.flawed];
    await recordProblem(ctx, accounts);
    throw new DrawUnreadableError(accounts);
  }
  const walkable = read.accounts.filter((a) => DEPOSITORY_OR_CREDIT.has(a.account.type));

  // The earliest point the chart has, leaving out what an earlier drawing
  // drew (yieldToBackfill keeps that to what is still its own).
  const drawn = before.drawn;
  const anchor = walkable.length > 0 || drawn ? await readEarliestPoint(ctx, drawn) : null;

  const accounts: WalkAccount[] = [];
  const said = new Map<string, { bank_from: string | null; excluded: ExcludedImport[]; importedAfter: boolean; runFrom: string | null }>();
  if (anchor) {
    for (const a of walkable) {
      const w = walkOf(a, read, anchor.date, today);
      accounts.push(w.walk);
      said.set(a.account.account_id, { bank_from: a.bank_from, excluded: w.excluded, importedAfter: w.importedAfter, runFrom: w.runFrom });
    }
  }
  const extension = anchor
    ? extendHistory({ anchor: { date: anchor.date, total: anchor.total, balances: anchor.balances, walked: anchor.estimated ? anchor.walked : null }, accounts, today })
    : { points: [], accounts: [], from: null };
  // What each account's estimate follows: imported rows back to its reach
  // when drawn here; when the backfill walked those dated after the anchor,
  // though nothing before it was drawn, back to the day before the covered
  // run it walked them through begins (it holds the account flat before
  // that), or to the anchor, when that run holds it.
  const backfilled = new Set(anchor?.estimated ? (anchor.walked ?? []) : []);
  const reached: WalkAccountState[] = extension.accounts.map((r) => {
    const w = said.get(r.account_id)!;
    const ids = accounts.find((x) => x.account_id === r.account_id)?.ids ?? [r.account_id];
    const viaBackfill = r.reach === null && r.why === null && w.importedAfter && ids.some((i) => backfilled.has(i));
    const before = w.runFrom ? dayBefore(w.runFrom) : anchor!.date;
    return { ...r, reach: viaBackfill ? (before > anchor!.date ? before : anchor!.date) : r.reach, bank_from: w.bank_from, excluded: w.excluded };
  });

  // The days the earlier drawing drew that are still its own (older than the
  // anchor): cleared, but for those this one draws again.
  const clear = drawn && anchor ? { from: drawn.from, until: drawn.until < anchor.date ? drawn.until : anchor.date } : drawn;
  await replaceEstimatedBefore(ctx, { clear, points: extension.points });
  const mine = extension.points.length > 0 && anchor ? { from: extension.from!, until: anchor.date } : null;

  const state = await historyWalkStore.update(ctx, WALK_ID, (current) => {
    const now = current ?? EMPTY;
    const overtaken = now.generation !== generation;
    // Overtaken: the days either drawing may have drawn, so the next one
    // clears them all.
    const range =
      overtaken && now.drawn && mine
        ? { from: now.drawn.from < mine.from ? now.drawn.from : mine.from, until: now.drawn.until > mine.until ? now.drawn.until : mine.until }
        : overtaken
          ? (now.drawn ?? mine)
          : mine;
    return {
      ...now,
      built: overtaken ? null : generation,
      built_at: new Date().toISOString(),
      anchor: anchor?.date ?? null,
      from: extension.from,
      drawn: range,
      accounts: reached,
      problem: null,
    };
  });
  await clearNetWorthCache(ctx);
  return { points: extension.points.length, state: state! };
}
