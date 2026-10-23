import { NextResponse } from 'next/server';
import { dataCtx } from '@/lib/data-ctx';
import { storeFailure } from '@/lib/store-failure';
import { parseGoals } from '@/lib/goal-model';
import { goalPlansStore, readGoalRecords, recordOf, removeDamagedPlans, wireGoal, witnessOf, writeGoalRecords } from '@/lib/goal-plans';
import { UnreadableEntriesError } from '@/lib/repo';
import { planGoalSave } from '@/lib/goal-save';
import { knownGoalAccounts } from '@/lib/goal-flows';
import { addDays, isCalendarDay } from '@/lib/manual-txn-input';

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
// unlink. Links that can't be read leave the ids as stored when the goals are
// shown, and stop a save, which decides on them whether a goal moved.
//
// Errors are the storage seam's (lib/store-failure.ts): goals or plans that
// can't be read are a flagged 409, never "none", so the client never shows an
// empty list for the next save to write over what is there. When it is plans
// that can't be read, the 409 says so (`repair: "goal-plans"`, with their
// goal ids, unreadable_ids and unrecognised_ids), and
//
//   POST { action: "repair", confirm: true }
//     removes the plans whose bytes are damaged (lib/goal-plans.ts
//     removeDamagedPlans), only on the person's word: their goals then read
//     with no plan. Never one a later release saved, which stays, named.
//     { removed, unrecognised }, as counts.

/** What a failure answers: the seam's, and for plans that can't be read, the
 *  repair the card can offer. */
const failure = (err: unknown, fallback: string) =>
  storeFailure(err, fallback, err instanceof UnreadableEntriesError && err.what === goalPlansStore.what ? { repair: 'goal-plans' } : undefined);

export async function GET() {
  try {
    const ctx = await dataCtx();
    const { records, links } = await readGoalRecords(ctx);
    return NextResponse.json({ goals: records.map((r) => wireGoal(r, links)) });
  } catch (err) {
    return failure(err, 'Failed to load goals');
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  // Only on the person's word: what is removed can't be put back here.
  if (body?.action !== 'repair' || body?.confirm !== true || Object.keys(body).length !== 2) {
    return NextResponse.json({ error: 'Expected { action: "repair", confirm: true }' }, { status: 400 });
  }
  try {
    const ctx = await dataCtx();
    const { removed, unrecognised } = await removeDamagedPlans(ctx);
    return NextResponse.json({ removed: removed.length, unrecognised: unrecognised.length });
  } catch (err) {
    return failure(err, 'Failed to repair goal plans');
  }
}

/** The day the person is on, for what the save dates (an archive, where a
 *  target date's line starts): the page's own day when it sends one within a
 *  day of the server's UTC day (no time zone is further), else that UTC day. */
function personsDay(sent: unknown): string {
  const utc = new Date().toISOString().slice(0, 10);
  return isCalendarDay(sent) && sent >= addDays(utc, -1) && sent <= addDays(utc, 1) ? sent : utc;
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
    const sent = typeof body === 'object' && body !== null ? (body as { goals?: unknown; today?: unknown }) : {};
    const parsed = parseGoals(sent.goals);
    if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
    // Links read strictly: the save decides on them (whether a goal moved).
    const read = await readGoalRecords(ctx, { strictLinks: true });
    const planned = await planGoalSave(parsed.goals, read.records, {
      today: personsDay(sent.today),
      links: read.links,
      accounts: () => knownGoalAccounts(ctx),
    });
    if ('refused' in planned) return NextResponse.json({ error: planned.refused }, { status: 400 });
    await writeGoalRecords(ctx, planned.next, read);
    const saved = planned.next.map((n) => recordOf(n.core, { v: 1, core: witnessOf(n.core), plan: n.plan, before: null }, read.links));
    return NextResponse.json({ goals: saved.map((r) => wireGoal(r, read.links)) });
  } catch (err) {
    return failure(err, 'Failed to save goals');
  }
}
