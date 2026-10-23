import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { runwayScenariosStore } from '@/lib/report/runway-scenario-store';
import { MAX_SCENARIOS, parseRunwayScenario } from '@/lib/report/runway-scenarios';
import { UnreadableEntriesError } from '@/lib/repo';

// The runway scenarios the person saved (lib/report/runway-scenarios.ts),
// on the storage seam (lib/report/runway-scenario-store.ts). Nothing else of
// the runway is ever stored: a what-if stays on the page until the person
// saves it here as a scenario, by name.
//
//   GET                       every scenario, by id, and the ids of any that
//                             can't be read (unreadable ones may be deleted,
//                             once the person confirms) or that a newer
//                             version saved (never offered)
//   POST   { scenario }       saves a new one, at most MAX_SCENARIOS: the
//                             count is taken again after the write, and the
//                             new one taken back when saves that met at the
//                             limit went over it (as an API token is made,
//                             lib/api-tokens.ts createToken)
//   DELETE { id, unreadable? } deletes one; one whose bytes are damaged only
//                             with `unreadable: true` (the person confirmed),
//                             and one a newer version saved never (409): it
//                             is intact data (lib/repo.ts, READS)
//
// Every field is checked and anything else refused. Scenarios ride on no
// cached payload, so nothing is cleared. Errors as on the storage seam
// (lib/store-failure.ts): 503 with no container, 409 for one that can't be
// read, 413 for one too large, else 500.

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

export async function GET() {
  try {
    const ctx = await dataCtx();
    const { entries, unreadable, unrecognised } = await runwayScenariosStore.getAllReport(ctx);
    const scenarios = [...entries].map(([id, s]) => ({ id, ...s })).sort((a, b) => a.saved_at.localeCompare(b.saved_at) || a.id.localeCompare(b.id));
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
  const now = Date.now();
  const parsed = parseRunwayScenario(b.scenario, now);
  if ('error' in parsed) return bad(parsed.error);
  try {
    const ctx = await dataCtx(now);
    const full = NextResponse.json({ error: `At most ${MAX_SCENARIOS} scenarios can be saved: delete one first` }, { status: 409 });
    // Every stored entry counts, readable or not.
    if ((await runwayScenariosStore.count(ctx)) >= MAX_SCENARIOS) return full;
    const id = crypto.randomUUID();
    await runwayScenariosStore.set(ctx, id, parsed.ok);
    // Saves sent together each saw room: counted again, a save past the limit
    // takes itself back, so the store never holds more than MAX_SCENARIOS
    // (and a download of it is always one a restore takes back).
    if ((await runwayScenariosStore.count(ctx)) > MAX_SCENARIOS) {
      await runwayScenariosStore.remove(ctx, id);
      return full;
    }
    return NextResponse.json({ scenario: { id, ...parsed.ok } });
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
      await runwayScenariosStore.get(ctx, b.id);
    } catch (err) {
      // Damaged: removed only once the person confirmed it (`unreadable`).
      // Unrecognised: intact, from another version, never removed from here.
      if (!(err instanceof UnreadableEntriesError)) throw err;
      if (err.unrecognised.includes(b.id)) {
        return NextResponse.json({ error: 'That scenario was saved by a newer version of Nya, so it can’t be deleted here.' }, { status: 409 });
      }
      if (b.unreadable !== true) throw err;
    }
    await runwayScenariosStore.remove(ctx, b.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return storeFailure(err, 'Failed to delete the scenario');
  }
}
