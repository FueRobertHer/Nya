import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { savedPlanStore } from '@/lib/saved-plan';
import { parseSavedDraft, type SavedPlan } from '@/lib/fire/saved-plan';
import { UnreadableValueError } from '@/lib/repo';

// The plan the person said is their plan (lib/fire/saved-plan.ts), on the
// storage seam (lib/saved-plan.ts). Only its assumptions, the savings it
// used, its currency and an inflation rate are stored, never a figure: the
// Plan tab's Progress card works everything out again on every read.
//
//   GET                         { saved } (null when none was ever saved),
//                               or { saved: null, problem } when one is
//                               there and can't be used: "unreadable" (it
//                               may be deleted, once the person confirms)
//                               or "newer" (a newer version saved it: never
//                               changed or deleted from here)
//   PUT    { saved, based_on }  saves it, replacing the one the page loaded
//                               (`based_on`, its rev, or null when the page
//                               loaded none), by a compare-and-set: 409 with
//                               the one there now when it changed since, and
//                               for one a newer version saved
//   DELETE { based_on | unreadable } forgets it: the one the page loaded
//                               (409 with the one there now if it changed),
//                               or, with `unreadable: true`, one that can't
//                               be read (the person confirmed); one a newer
//                               version saved never (409)
//
// Every field is checked (parseSavedDraft) and anything else refused. The
// server sets the day (the UTC day snapshots are kept by), savedAt and a new
// random rev on every save. Errors as on the storage seam
// (lib/store-failure.ts).

const REV = /^[A-Za-z0-9_.:-]{1,200}$/;
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });
const NEWER = 'Your saved plan was saved by a newer version of Nya, so it can’t be changed or deleted here.';
const NO_STORE = { 'Cache-Control': 'no-store' };

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The one there changed since the page loaded it: here it is now. */
class Stale extends Error {
  constructor(readonly current: SavedPlan | null) {
    super('stale');
  }
}

const stale = (current: SavedPlan | null) =>
  NextResponse.json({ error: 'Your saved plan was changed on another device: here it is as it is now.', stale: true, saved: current }, { status: 409 });

export async function GET() {
  try {
    const ctx = await dataCtx();
    const r = await savedPlanStore.getReport(ctx);
    const problem = r.unrecognised ? 'newer' : r.unreadable ? 'unreadable' : null;
    return NextResponse.json(problem ? { saved: null, problem } : { saved: r.value }, { headers: NO_STORE });
  } catch (err) {
    return storeFailure(err, 'Failed to load your saved plan');
  }
}

export async function PUT(req: Request) {
  const b = await bodyOf(req);
  if (!b) return bad('Send the plan to save and the version it replaces, as JSON');
  const extra = Object.keys(b).find((k) => k !== 'saved' && k !== 'based_on');
  if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
  if (!Object.hasOwn(b, 'based_on') || (b.based_on !== null && !(typeof b.based_on === 'string' && REV.test(b.based_on)))) {
    return bad('based_on is the version (rev) of the saved plan this replaces, or null for none');
  }
  const parsed = parseSavedDraft(b.saved);
  if ('error' in parsed) return bad(parsed.error);
  const basedOn = b.based_on as string | null;
  const now = Date.now();
  const at = new Date(now).toISOString();
  // The same for every try of the compare-and-set, which may run more than once.
  const saved: SavedPlan = { version: 1, ...parsed.ok, day: at.slice(0, 10), savedAt: at, rev: crypto.randomUUID() };
  try {
    const ctx = await dataCtx(now);
    try {
      await savedPlanStore.update(ctx, (current) => {
        if ((current?.rev ?? null) !== basedOn) throw new Stale(current);
        return saved;
      });
    } catch (err) {
      if (err instanceof Stale) return stale(err.current);
      if (err instanceof UnreadableValueError && err.unrecognised) return NextResponse.json({ error: NEWER }, { status: 409 });
      throw err;
    }
    return NextResponse.json({ saved });
  } catch (err) {
    return storeFailure(err, 'Failed to save your plan');
  }
}

export async function DELETE(req: Request) {
  const b = await bodyOf(req);
  if (!b) return bad('Send the version of the saved plan to forget, as JSON');
  const extra = Object.keys(b).find((k) => k !== 'based_on' && k !== 'unreadable');
  if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
  const unreadable = b.unreadable === true;
  if (b.unreadable !== undefined && typeof b.unreadable !== 'boolean') return bad('unreadable is true or false');
  if (!unreadable && !(typeof b.based_on === 'string' && REV.test(b.based_on))) return bad('based_on is the version (rev) of the saved plan to forget');
  if (unreadable && b.based_on !== undefined) return bad('Send based_on or unreadable, not both');
  try {
    const ctx = await dataCtx();
    if (unreadable) {
      // Only one that is damaged: an intact one is forgotten by its version,
      // and one a newer version saved never from here.
      const r = await savedPlanStore.getReport(ctx);
      if (r.unrecognised) return NextResponse.json({ error: NEWER }, { status: 409 });
      if (!r.unreadable) return r.value === null ? NextResponse.json({ ok: true }) : stale(r.value);
      await savedPlanStore.remove(ctx);
      return NextResponse.json({ ok: true });
    }
    try {
      await savedPlanStore.update(ctx, (current) => {
        // Already gone: nothing to forget.
        if (current === null) return null;
        if (current.rev !== b.based_on) throw new Stale(current);
        return null;
      });
    } catch (err) {
      if (err instanceof Stale) return stale(err.current);
      if (err instanceof UnreadableValueError && err.unrecognised) return NextResponse.json({ error: NEWER }, { status: 409 });
      throw err;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return storeFailure(err, 'Failed to forget your saved plan');
  }
}
