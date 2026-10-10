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
// WHAT IT KEEPS (lib/history-import/store.ts imported-history-walk): the
// anchor, the oldest day drawn, the exact days it drew (so the next drawing
// clears exactly them and nothing an earlier reconstruction made), how far
// back each account reached and the stretches it could not draw, with why,
// for the chart's note and the API. A drawing overtaken by a change (an
// import landing while it ran) leaves the record marked to draw again.

import type { Ctx } from '../containers';
import { getItems } from '../storage';
import { getLinks, effectiveLinks } from '../link-core';
import { liveAccountIds } from '../links';
import { readEarliestPoint, replaceEstimatedBefore, isBackfillDone } from '../history';
import { clearNetWorthCache } from '../cache';
import { loggable } from '../log-safe';
import { countedRows, readImported } from './read';
import { extendHistory, type CoveredRange, type WalkAccount } from './walk';
import { historyWalkStore, WALK_ID, type WalkState } from './store';
import { StoredDataUnreadableError } from '../repo';

const EMPTY: WalkState = { version: 1, generation: 0, built: null, built_at: null, anchor: null, from: null, drawn: null, accounts: [] };

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

/** The same where nothing may have been imported (a link, a forget): only a
 *  record already there is marked, so nobody who never imported gets one.
 *  Best effort, for paths whose own work is done either way: a record not
 *  marked costs a drawing until the next change marks it. */
export async function markDrawStaleQuietly(ctx: Ctx): Promise<void> {
  await historyWalkStore
    .update(ctx, WALK_ID, (current) => (current ? { ...current, generation: current.generation + 1 } : null))
    .catch((err) => console.warn('history import: the estimated history could not be marked to draw again', loggable(err)));
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

/**
 * Draws it (see the header) and answers how many points were written. Waits
 * for the backfill: before it has run once, nothing is drawn and the record
 * stays marked. `today` is the server's UTC day.
 */
export async function drawImportedHistory(ctx: Ctx, opts: { today?: string } = {}): Promise<{ points: number; state: WalkState }> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const before = (await historyWalkStore.get(ctx, WALK_ID)) ?? EMPTY;
  const generation = before.generation;
  if (!(await isBackfillDone(ctx))) return { points: 0, state: before };

  // The links that apply now, strictly: a link that can't be read would put
  // an account's earlier rows on the wrong account, or none.
  const [items, links, live] = await Promise.all([getItems(ctx), getLinks(ctx), liveAccountIds(ctx, { strict: true })]);
  const effective = effectiveLinks(links, live);
  const read = await readImported(ctx, { items, links: effective });
  const walkable = read.accounts.filter((a) => DEPOSITORY_OR_CREDIT.has(a.account.type));

  // The earliest point the chart has, leaving out what an earlier drawing
  // drew (yieldToBackfill keeps that to what is still its own).
  const drawn = before.drawn;
  const anchor = walkable.length > 0 || drawn ? await readEarliestPoint(ctx, drawn) : null;

  const accounts: WalkAccount[] = [];
  if (anchor) {
    for (const a of walkable) {
      const flows = new Map<string, number>();
      const add = (date: string, amount: number) => {
        if (date > anchor.date) return;
        flows.set(date, (flows.get(date) ?? 0) + amount);
      };
      for (const b of a.banks) if (!b.pending) add(b.date, b.amount);
      for (const r of countedRows(a.held, a.banks, read.order).counted) add(r.date, r.amount);
      const covered: CoveredRange[] = a.bank_from ? [{ from: a.bank_from, to: today, kind: 'bank' }] : [];
      for (const s of read.summaries.values()) if (a.ids.includes(s.account_id)) covered.push({ from: s.covers.from, to: s.covers.to, kind: 'import' });
      accounts.push({ account_id: a.account.account_id, ids: a.ids, type: a.account.type as 'depository' | 'credit', flows, covered });
    }
  }
  const extension = anchor ? extendHistory({ anchor, accounts }) : { points: [], accounts: [], from: null };

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
      accounts: extension.accounts,
    };
  });
  await clearNetWorthCache(ctx);
  return { points: extension.points.length, state: state! };
}
