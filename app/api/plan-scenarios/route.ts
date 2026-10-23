import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { planScenariosStore } from '@/lib/plan-scenarios';
import { MAX_PLAN_SCENARIOS, nameTaken, parseScenarioDraft, type PlanScenario } from '@/lib/fire/scenarios';
import { UnreadableEntriesError } from '@/lib/repo';

// The Plan scenarios the person saved (lib/fire/scenarios.ts), on the
// storage seam (lib/plan-scenarios.ts). Only what each changes from the Plan
// is stored, never a figure: the Plan tab works everything out again in the
// browser (lib/fire/plan-figures.ts), from the day's data.
//
//   GET                              every scenario, by id, in the order they
//                                    were made, and the ids of any that can't
//                                    be read (unreadable ones may be deleted,
//                                    once the person confirms) or that a
//                                    newer version saved (never offered)
//   POST   { scenario }              saves a new one, at most
//                                    MAX_PLAN_SCENARIOS: the count is taken
//                                    again after the write, and the new one
//                                    taken back when saves that met at the
//                                    limit went over it (as the runway's
//                                    scenarios are), saying to try again
//   PUT    { id, scenario, based_on } replaces one, by a compare-and-set:
//                                    only while it is still the version
//                                    (`rev`) the page loaded, else 409 with it
//                                    as it is now; 404 once it is gone (never
//                                    made again past the limit); 409 for one a
//                                    newer version saved, which is never
//                                    changed from here
//   DELETE { id, unreadable? }       deletes one; one whose bytes are damaged
//                                    only with `unreadable: true` (the person
//                                    confirmed), and one a newer version saved
//                                    never (409): it is intact data
//
// Every field is checked (parseScenarioDraft) and anything else refused, and a
// name another scenario has (in any case) is refused with 409. The server
// sets createdAt, savedAt and a new random rev on every save.
// Scenarios ride on no cached payload, so nothing is cleared. Errors as on
// the storage seam (lib/store-failure.ts): 503 with no container, 409 for one
// that can't be read, 413 for one too large, else 500.

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const bad = (error: string) => NextResponse.json({ error }, { status: 400 });

async function bodyOf(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const NEWER = 'That scenario was saved by a newer version of Nya, so it can’t be changed or deleted here.';

/** Whether another readable scenario has the name already, in any case (the
 *  page refuses it too, lib/fire/scenarios.ts nameTaken): compare mode tells
 *  plans apart by name. Entries that can't be read are left out of this
 *  check, never mistaken for none: the save still goes through the strict
 *  count and compare-and-set. Two saves of one name sent together can each
 *  pass; the page then shows both, either can be renamed, and both can still
 *  be changed (an edit is refused only for a new name that is taken). */
async function nameUsed(ctx: Awaited<ReturnType<typeof dataCtx>>, name: string, exceptId: string | null): Promise<boolean> {
  const { entries } = await planScenariosStore.getAllReport(ctx);
  return nameTaken([...entries].map(([id, s]) => ({ id, name: s.name })), name, exceptId);
}

const taken = () => NextResponse.json({ error: 'Another scenario has that name: choose another, so they can be told apart.' }, { status: 409 });

export async function GET() {
  try {
    const ctx = await dataCtx();
    const { entries, unreadable, unrecognised } = await planScenariosStore.getAllReport(ctx);
    const scenarios = [...entries].map(([id, s]) => ({ id, ...s })).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return NextResponse.json({ scenarios, unreadable_ids: unreadable, unrecognised_ids: unrecognised }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return storeFailure(err, 'Failed to load your saved scenarios');
  }
}

export async function POST(req: Request) {
  const b = await bodyOf(req);
  if (!b) return bad('Send the scenario, as JSON');
  const extra = Object.keys(b).find((k) => k !== 'scenario');
  if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
  const parsed = parseScenarioDraft(b.scenario);
  if ('error' in parsed) return bad(parsed.error);
  const now = Date.now();
  try {
    const ctx = await dataCtx(now);
    // Every stored entry counts, readable or not.
    if ((await planScenariosStore.count(ctx)) >= MAX_PLAN_SCENARIOS) {
      return NextResponse.json({ error: `At most ${MAX_PLAN_SCENARIOS} scenarios can be saved: delete one first` }, { status: 409 });
    }
    if (await nameUsed(ctx, parsed.ok.name, null)) return taken();
    const at = new Date(now).toISOString();
    const scenario: PlanScenario = { version: 1, ...parsed.ok, createdAt: at, savedAt: at, rev: crypto.randomUUID() };
    const id = crypto.randomUUID();
    await planScenariosStore.set(ctx, id, scenario);
    // Saves sent together each saw room: counted again, a save past the limit
    // takes itself back, so the store never holds more than the limit at
    // rest. There was room when it was sent, so the person may simply try
    // again.
    if ((await planScenariosStore.count(ctx)) > MAX_PLAN_SCENARIOS) {
      await planScenariosStore.remove(ctx, id);
      return NextResponse.json({ error: 'Other scenarios were being saved at the same moment, so this one wasn’t: try again.' }, { status: 409 });
    }
    return NextResponse.json({ scenario: { id, ...scenario } });
  } catch (err) {
    return storeFailure(err, 'Failed to save the scenario');
  }
}

/** The entry changed since the page loaded it: here it is now. */
class Stale extends Error {
  constructor(readonly current: PlanScenario) {
    super('stale');
  }
}

/** A rename to a name another scenario has. */
class Taken extends Error {
  constructor() {
    super('taken');
  }
}

export async function PUT(req: Request) {
  const b = await bodyOf(req);
  if (!b) return bad('Send the id, the scenario and the version it was based on, as JSON');
  const extra = Object.keys(b).find((k) => !['id', 'scenario', 'based_on'].includes(k));
  if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
  if (typeof b.id !== 'string' || !ID.test(b.id)) return bad('id is a saved scenario’s id');
  if (typeof b.based_on !== 'string' || !ID.test(b.based_on)) return bad('based_on is the version (rev) the change was made to');
  const parsed = parseScenarioDraft(b.scenario);
  if ('error' in parsed) return bad(parsed.error);
  const id = b.id;
  const basedOn = b.based_on;
  const now = Date.now();
  // The same for every try of the compare-and-set, which may run more than once.
  const rev = crypto.randomUUID();
  try {
    const ctx = await dataCtx(now);
    const usedElsewhere = await nameUsed(ctx, parsed.ok.name, id);
    let written: PlanScenario | null;
    try {
      written = await planScenariosStore.update(ctx, id, (current) => {
        // Gone: nothing is written, so a change can never make one again.
        if (current === null) return null;
        if (current.rev !== basedOn) throw new Stale(current);
        // Only a rename is refused for a name another has: a scenario whose
        // name two already share (two saves sent together) can still be
        // changed, and renamed apart.
        if (usedElsewhere && !nameTaken([{ id, name: current.name }], parsed.ok.name)) throw new Taken();
        return { version: 1, ...parsed.ok, createdAt: current.createdAt, savedAt: new Date(now).toISOString(), rev };
      });
    } catch (err) {
      if (err instanceof Stale) {
        return NextResponse.json({ error: 'This scenario was changed on another device: here it is as it is now.', stale: true, scenario: { id, ...err.current } }, { status: 409 });
      }
      if (err instanceof Taken) return taken();
      if (err instanceof UnreadableEntriesError && err.unrecognised.includes(id)) return NextResponse.json({ error: NEWER }, { status: 409 });
      throw err;
    }
    if (written === null) return NextResponse.json({ error: 'That scenario isn’t there any more: it was deleted.' }, { status: 404 });
    return NextResponse.json({ scenario: { id, ...written } });
  } catch (err) {
    return storeFailure(err, 'Failed to save the scenario');
  }
}

export async function DELETE(req: Request) {
  const b = await bodyOf(req);
  if (!b) return bad('Send the id of the scenario to delete, as JSON');
  const extra = Object.keys(b).find((k) => k !== 'id' && k !== 'unreadable');
  if (extra) return bad(`${extra.slice(0, 40)} isn’t taken here`);
  if (typeof b.id !== 'string' || !ID.test(b.id)) return bad('id is a saved scenario’s id');
  if (b.unreadable !== undefined && typeof b.unreadable !== 'boolean') return bad('unreadable is true or false');
  try {
    const ctx = await dataCtx();
    try {
      await planScenariosStore.get(ctx, b.id);
    } catch (err) {
      // Damaged: removed only once the person confirmed it (`unreadable`).
      // Unrecognised: intact, from another version, never removed from here.
      if (!(err instanceof UnreadableEntriesError)) throw err;
      if (err.unrecognised.includes(b.id)) return NextResponse.json({ error: NEWER }, { status: 409 });
      if (b.unreadable !== true) throw err;
    }
    await planScenariosStore.remove(ctx, b.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return storeFailure(err, 'Failed to delete the scenario');
  }
}
