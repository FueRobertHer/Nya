// lib/plan-copies.ts
//
// Plans as copies (lib/fire/copies.ts): `fire-plans`, a map store on the
// storage seam (lib/repo.ts) with one encrypted entry per plan, so one
// damaged plan never makes every plan (and Home) unreadable, and
// `plan-facts`, one value: which entry is yours and the facts every plan
// shares.
//
// THIS RELEASE NEVER MAKES EITHER. The release after it (C2) is the first to
// write them; this one reads them, saves your plan into its entry once they
// are there (app/api/fire-plan), and brings them back from a file that holds
// them (lib/user-restore). Until then every account reads the plan from
// `fire-plan` and its currency record (lib/fire-plan.ts), exactly as before,
// so the release before, this one's rollback target, never meets a store it
// doesn't know.
//
// Once `fire-plans` holds an entry, it is the plan: GET answers your plan's
// entry with the facts applied, and the scenarios (lib/plan-scenarios.ts)
// are read no more, since they became the copies. Your plan's entry and the
// facts are read strictly, as the plan always was; a copy that can't be read
// never stops Home.

import { defineMapStore, defineValueStore, UnreadableEntriesError } from './repo';
import { eager } from './eager';
import type { Ctx } from './containers';
import { firePlanStore, planAnswer, readCurrencyRecord } from './fire-plan';
import { MAIN_ID, factsOf, holdsAmounts, isPlanEntry, isPlanFacts, mainOf, upgradePlanEntry, withFacts, type PlanEntry, type PlanFacts } from './fire/copies';

export const firePlansStore = defineMapStore<PlanEntry>('fire-plans', {
  what: 'plans',
  isValid: isPlanEntry,
  upgrade: upgradePlanEntry,
  exportable: true, // what the person chose and typed
});

export const planFactsStore = defineValueStore<PlanFacts>('plan-facts', {
  what: 'the facts your plans share',
  isValid: isPlanFacts,
  exportable: true, // what the person typed
});

/** Your plan's entry, and the facts read beside it (null without
 *  `plan-facts`, where the entry's own fields hold them). `missing` when it
 *  isn't the plan the facts name (lib/fire/copies.ts mainOf). */
export type MainPlan = { id: string; entry: PlanEntry; facts: PlanFacts | null; missing: boolean };

type Begun = { facts: Promise<PlanFacts | null>; main: Promise<PlanEntry | null>; count: Promise<number> };

/** The three reads that say whether the plan is in `fire-plans`, and which
 *  is yours there, begun together (one round trip). */
const beginMain = (ctx: Ctx): Begun => ({
  facts: eager(planFactsStore.get(ctx)),
  main: eager(firePlansStore.get(ctx, MAIN_ID)),
  count: eager(firePlansStore.count(ctx)),
});

/** One entry of a report, or the error a strict read of it throws. */
function entryOf(report: { entries: ReadonlyMap<string, PlanEntry>; unreadable: readonly string[]; unrecognised: readonly string[] }, id: string): PlanEntry {
  const entry = report.entries.get(id);
  if (entry) return entry;
  throw new UnreadableEntriesError(firePlansStore.what, report.unreadable.includes(id) ? [id] : [], report.unrecognised.includes(id) ? [id] : []);
}

async function mainFrom(ctx: Ctx, begun: Begun): Promise<MainPlan | null> {
  if ((await begun.count) === 0) return null;
  const facts = await begun.facts;
  const named = facts?.main ?? MAIN_ID;
  const entry = named === MAIN_ID ? await begun.main : await firePlansStore.get(ctx, named);
  if (entry) return { id: named, entry, facts, missing: false };
  // The plan named isn't there (Make this your plan and Delete on two
  // devices): the rare fallback, over the whole map.
  const report = await firePlansStore.getAllReport(ctx);
  const pick = mainOf(facts, report);
  // Every entry gone since it was counted: the plan is the legacy one again.
  if (!pick) return null;
  return { id: pick.id, entry: entryOf(report, pick.id), facts, missing: pick.missing };
}

/** Your plan's entry, or null while `fire-plans` holds none (the plan is
 *  then `fire-plan`, as before). Strict: an entry or facts that can't be read
 *  throw (StoredDataUnreadableError). */
export async function readMain(ctx: Ctx): Promise<MainPlan | null> {
  return mainFrom(ctx, beginMain(ctx));
}

/** What GET answers from your plan's entry: the plan with the facts in its
 *  fields, its currency where it holds an amount (else null, so the Plan
 *  follows the accounts, as a plan with nothing typed always has), and its
 *  stamp, so a page can name the version a save was made on. */
export function mainAnswer(m: MainPlan) {
  return {
    plan: withFacts(m.entry.plan, m.facts ?? factsOf(m.entry.plan)),
    currency: holdsAmounts(m.entry.plan) ? m.entry.currency : null,
    updated_at: m.entry.updatedAt,
  };
}

/** The plan and its currency, as GET /api/fire-plan and /api/plan-inputs
 *  answer them: your plan's entry once `fire-plans` holds one, else the
 *  legacy plan and its record (lib/fire-plan.ts planAnswer). The five reads
 *  are begun together, so they share a round trip, and only those the
 *  answer needs are awaited: a damaged `plan-facts` beside no `fire-plans`,
 *  or a damaged legacy plan beside it, is never read into the answer. */
export async function readPlanAnswer(ctx: Ctx) {
  const begun = beginMain(ctx);
  const legacy = eager(firePlanStore.get(ctx));
  const record = eager(readCurrencyRecord(ctx));
  const main = await mainFrom(ctx, begun);
  if (main) return mainAnswer(main);
  const stored = await legacy;
  const { record: there, problem } = await record;
  return planAnswer(stored, there, problem);
}

/** The plans but yours, for the Plan's scenario list once `fire-plans` holds
 *  an entry (null before): the readable ones' names in the order they were
 *  made, every id (readable or not), and your plan's name and whether it is
 *  the one the facts name. Your plan is picked as readMain picks it, so the
 *  two never disagree: one that can't be read throws here too. */
export async function readCopies(ctx: Ctx): Promise<{ ids: string[]; names: string[]; main: { name: string; missing: boolean } } | null> {
  const count = eager(firePlansStore.count(ctx));
  const read = eager(planFactsStore.get(ctx));
  if ((await count) === 0) return null;
  const facts = await read;
  const report = await firePlansStore.getAllReport(ctx);
  const pick = mainOf(facts, report);
  if (!pick) return null;
  const main = entryOf(report, pick.id);
  const readable = [...report.entries].filter(([id]) => id !== pick.id).sort(([a, x], [b, y]) => x.createdAt.localeCompare(y.createdAt) || a.localeCompare(b));
  const others = [...report.unreadable, ...report.unrecognised].filter((id) => id !== pick.id);
  return { ids: [...readable.map(([id]) => id), ...others], names: readable.map(([, e]) => e.name), main: { name: main.name, missing: pick.missing } };
}
