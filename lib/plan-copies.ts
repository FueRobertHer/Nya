// lib/plan-copies.ts
//
// Plans as copies (lib/fire/copies.ts): `fire-plans`, a map store on the
// storage seam (lib/repo.ts) with one encrypted entry per plan, so one
// damaged plan never makes every plan (and Home) unreadable, and
// `plan-facts`, one value: which entry is yours and the facts every plan
// shares.
//
// These are the plan. While `fire-plans` holds no entry, the plan is the
// defaults, never saved: the first write of any plan makes your plan's entry
// (lib/plan-writes.ts). Nobody's plan needed carrying over from before
// copies (the tax plan's C2), and those stores are gone.
//
// Your plan's entry and the facts are read strictly, as the plan always was;
// a copy that can't be read never stops Home.

import { defineMapStore, defineValueStore, UnreadableEntriesError } from './repo';
import { eager } from './eager';
import type { Ctx } from './containers';
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

/** Your plan's name when its entry is first made. */
export const FIRST_PLAN = 'First plan';

/** Your plan's entry, and the facts read beside it (null without
 *  `plan-facts`, where the entry's own fields hold them). `missing` when it
 *  isn't the plan the facts name (lib/fire/copies.ts mainOf). */
export type MainPlan = { id: string; entry: PlanEntry; facts: PlanFacts | null; missing: boolean };

type Report = { entries: ReadonlyMap<string, PlanEntry>; unreadable: readonly string[]; unrecognised: readonly string[] };

/** One entry of a report, or the error a strict read of it throws. */
export function entryOf(report: Report, id: string): PlanEntry {
  const entry = report.entries.get(id);
  if (entry) return entry;
  throw new UnreadableEntriesError(firePlansStore.what, report.unreadable.includes(id) ? [id] : [], report.unrecognised.includes(id) ? [id] : []);
}

/** Your plan's entry, or null while `fire-plans` holds none (the plan is
 *  then the defaults). Strict: an entry or facts that can't be read throw
 *  (StoredDataUnreadableError). The three reads are begun together (one
 *  round trip); the whole map is read only in the rare case the plan the
 *  facts name isn't there (Make this your plan and Delete on two devices). */
export async function readMain(ctx: Ctx): Promise<MainPlan | null> {
  const factsRead = eager(planFactsStore.get(ctx));
  const mainRead = eager(firePlansStore.get(ctx, MAIN_ID));
  if ((await firePlansStore.count(ctx)) === 0) return null;
  const facts = await factsRead;
  const named = facts?.main ?? MAIN_ID;
  const entry = named === MAIN_ID ? await mainRead : await firePlansStore.get(ctx, named);
  if (entry) return { id: named, entry, facts, missing: false };
  const report = await firePlansStore.getAllReport(ctx);
  const pick = mainOf(facts, report);
  // Every entry gone since it was counted: the defaults again.
  if (!pick) return null;
  return { id: pick.id, entry: entryOf(report, pick.id), facts, missing: pick.missing };
}

/** What GET answers from your plan's entry: the plan with the facts in its
 *  fields, its currency where it holds an amount (else null, so the Plan
 *  follows the accounts, as a plan with nothing typed always has), its id
 *  and its stamp, so a page can name the version a save was made on. */
export function mainAnswer(m: MainPlan) {
  return {
    id: m.id,
    plan: withFacts(m.entry.plan, m.facts ?? factsOf(m.entry.plan)),
    currency: holdsAmounts(m.entry.plan) ? m.entry.currency : null,
    updated_at: m.entry.updatedAt,
  };
}

/** What GET answers while your plan has no entry: the defaults, never saved,
 *  with no stamp (a save then sends `based_on: null`). */
export const NO_PLAN_ANSWER = { id: MAIN_ID, plan: null, currency: null, updated_at: null } as const;

/** The plan and its currency, as GET /api/fire-plan and /api/plan-inputs
 *  answer them: your plan's entry, or the defaults while there is none. */
export async function readPlanAnswer(ctx: Ctx) {
  const main = await readMain(ctx);
  return main ? mainAnswer(main) : NO_PLAN_ANSWER;
}

/** One plan as the Plans sheet reads it: the facts every plan shares in its
 *  fields, its currency where it holds an amount, its stamps. Your plan
 *  before its entry is made has no plan (the defaults) and no stamps. */
export type PlanRow = {
  id: string;
  name: string;
  plan: PlanEntry['plan'] | null;
  currency: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export function rowOf(id: string, entry: PlanEntry, facts: PlanFacts | null, main: PlanEntry): PlanRow {
  return {
    id,
    name: entry.name,
    plan: withFacts(entry.plan, facts ?? factsOf(main.plan)),
    currency: holdsAmounts(entry.plan) ? entry.currency : null,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
  };
}

/** Every plan, for the Plans sheet (GET /api/plans): yours first, then the
 *  copies in the order they were made, with the ids of any that can't be
 *  read (damaged ones may be deleted, once the person confirms) or that a
 *  newer version saved (kept, never offered). Your plan is picked as
 *  readMain picks it, and read as strictly. */
export async function readPlans(ctx: Ctx): Promise<{ main: string; missing: boolean; plans: PlanRow[]; unreadable_ids: string[]; unrecognised_ids: string[] }> {
  const factsRead = eager(planFactsStore.get(ctx));
  const reportRead = eager(firePlansStore.getAllReport(ctx));
  if ((await firePlansStore.count(ctx)) === 0) {
    return { main: MAIN_ID, missing: false, plans: [{ id: MAIN_ID, name: FIRST_PLAN, plan: null, currency: null, created_at: null, updated_at: null }], unreadable_ids: [], unrecognised_ids: [] };
  }
  const facts = await factsRead;
  const report = await reportRead;
  const pick = mainOf(facts, report);
  if (!pick) return readPlans(ctx);
  const main = entryOf(report, pick.id);
  const copies = [...report.entries].filter(([id]) => id !== pick.id).sort(([a, x], [b, y]) => x.createdAt.localeCompare(y.createdAt) || a.localeCompare(b));
  return {
    main: pick.id,
    missing: pick.missing,
    plans: [rowOf(pick.id, main, facts, main), ...copies.map(([id, e]) => rowOf(id, e, facts, main))],
    unreadable_ids: report.unreadable.filter((id) => id !== pick.id),
    unrecognised_ids: report.unrecognised.filter((id) => id !== pick.id),
  };
}
