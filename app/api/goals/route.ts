import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { parseGoals } from '@/lib/goal-model';
import { readGoalRecords, recordOf, wireGoal, witnessOf, writeGoalRecords } from '@/lib/goal-plans';
import { planGoalSave } from '@/lib/goal-save';
import { knownGoalAccounts } from '@/lib/goal-flows';

// Savings goals (#42). Each goal's name, target and account are kept in the
// `goals` blob, as every release has kept them (lib/goals.ts), and its plan
// (allocation, monthly target, target date, archived) in the `goal-plans`
// store (lib/goal-plans.ts, which says why, and in what order a save writes
// the two). How the goals are going is worked out in the browser, from the
// balances it shows and the months GET /api/goals/progress reads.
//
// A goal tracking an account that has since been linked to a new id
// (lib/links.ts) follows it, so its progress keeps working after a reconnect,
// and says so (`relinked`). The stored goal isn't touched here; the next save
// from the client writes the current id, which is harmless and survives an
// unlink. Links that can't be read leave the ids as stored.
//
// Errors are the storage seam's (lib/store-failure.ts): goals or plans that
// can't be read are a flagged 409, never "none", so the client never shows an
// empty list for the next save to write over what is there.

export async function GET() {
  try {
    const ctx = await dataCtx();
    const { records, links } = await readGoalRecords(ctx);
    return NextResponse.json({ goals: records.map((r) => wireGoal(r, links)) });
  } catch (err) {
    return storeFailure(err, 'Failed to load goals');
  }
}

// Replaces the whole goal list (the client always sends the full set): every
// field checked (lib/goal-model.ts parseGoals), then what needs the stored
// goals and the balances Nya knows (lib/goal-save.ts), a clear 400 when the
// save can't be taken, and only then the writes.
export async function PUT(req: Request) {
  try {
    const ctx = await dataCtx();
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid goals' }, { status: 400 });
    }
    const parsed = parseGoals(typeof body === 'object' && body !== null ? (body as { goals?: unknown }).goals : undefined);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const read = await readGoalRecords(ctx);
    const planned = await planGoalSave(parsed.goals, read.records, {
      today: new Date().toISOString().slice(0, 10),
      links: read.links,
      accounts: () => knownGoalAccounts(ctx),
    });
    if ('refused' in planned) return NextResponse.json({ error: planned.refused }, { status: 400 });
    await writeGoalRecords(ctx, planned.next, read);
    const saved = planned.next.map((n) => recordOf(n.core, { v: 1, core: witnessOf(n.core), plan: n.plan, before: null }, read.links));
    return NextResponse.json({ goals: saved.map((r) => wireGoal(r, read.links)) });
  } catch (err) {
    return storeFailure(err, 'Failed to save goals');
  }
}
