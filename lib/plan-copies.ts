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
import { MAIN_ID, entryHoldsAmounts, factsOf, isPlanEntry, isPlanFacts, mainOf, upgradePlanEntry, withFacts, type PlanEntry, type PlanFacts } from './fire/copies';
import type { TaxFacts } from './fire/tax-facts';

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
 *  round trip), the facts' by the caller when it wants them too; the whole map
 *  is read only in the rare case the plan the facts name isn't there (Make
 *  this your plan and Delete on two devices). */
export async function readMain(ctx: Ctx, factsRead: Promise<PlanFacts | null> = eager(planFactsStore.get(ctx))): Promise<MainPlan | null> {
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

/** The tax facts in what `plan-facts` holds; null before any were written,
 *  which is the flat model and nothing given. */
const taxFactsIn = (facts: PlanFacts | null): TaxFacts | null => (facts?.version === 2 ? facts.tax : null);

/** What GET answers from your plan's entry: the plan with the facts in its
 *  fields, its currency where it holds an amount (else null, so the Plan
 *  follows the accounts, as a plan with nothing typed always has), its id
 *  and its stamp, so a page can name the version a save was made on, its tax
 *  choices, and the tax facts every plan shares. */
export function mainAnswer(m: MainPlan) {
  return {
    id: m.id,
    plan: withFacts(m.entry.plan, m.facts ?? factsOf(m.entry.plan)),
    currency: entryHoldsAmounts(m.entry.plan, m.entry.tax) ? m.entry.currency : null,
    updated_at: m.entry.updatedAt,
    tax: m.entry.tax,
    tax_facts: taxFactsIn(m.facts),
  };
}

/** What GET answers while your plan has no entry: the defaults, never saved,
 *  with no stamp (a save then sends `based_on: null`), and any tax facts:
 *  those can be given before a plan is, and the plan stays new for all that. */
export const noPlanAnswer = (facts: PlanFacts | null) => ({ id: MAIN_ID, plan: null, currency: null, updated_at: null, tax: null, tax_facts: taxFactsIn(facts) });

/** The plan and its currency, as GET /api/fire-plan and /api/plan-inputs
 *  answer them: your plan's entry, or the defaults while there is none. With
 *  none, what `plan-facts` holds is read alone, and a failure there answers no
 *  tax facts: a leftover that can't be read never stops Home, and the next
 *  write replaces it. */
export async function readPlanAnswer(ctx: Ctx) {
  const factsRead = eager(planFactsStore.get(ctx));
  const main = await readMain(ctx, factsRead);
  return main ? mainAnswer(main) : noPlanAnswer(await factsRead.catch(() => null));
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
  /** Its own tax choices; null is the flat model's, or your plan's under the
   *  detailed one. */
  tax: PlanEntry['tax'];
};

export function rowOf(id: string, entry: PlanEntry, facts: PlanFacts | null, main: PlanEntry): PlanRow {
  return {
    id,
    name: entry.name,
    plan: withFacts(entry.plan, facts ?? factsOf(main.plan)),
    currency: entryHoldsAmounts(entry.plan, entry.tax) ? entry.currency : null,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    tax: entry.tax,
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
    return { main: MAIN_ID, missing: false, plans: [{ id: MAIN_ID, name: FIRST_PLAN, plan: null, currency: null, created_at: null, updated_at: null, tax: null }], unreadable_ids: [], unrecognised_ids: [] };
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
