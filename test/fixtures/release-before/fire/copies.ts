// lib/fire/copies.ts
//
// Plans as copies (the tax plan's D14): every plan a whole FirePlan, one
// entry each in `fire-plans`, and what every plan shares (the facts, and
// which plan is yours) in `plan-facts` (lib/plan-copies.ts). The scenarios
// (lib/fire/scenarios.ts) become copies on the first write of the release
// after this one (C2); this one reads the stores, so a rollback from it
// neither loses a copy nor saves your plan where it isn't read first.
//
// READS TAKE WHAT ANY RELEASE WROTE. isPlanEntry and isPlanFacts check the
// shape and types, never a range, as isPlanScenario does: an entry a later
// rule refuses still reads. A `tax` that isn't null (the per plan tax choices,
// from T2's reader) and facts of version 2 (E2's, with the tax facts) are a
// newer release's: not recognised, so never written over from here.
//
// Pure, with no data and no storage: the routes and the browser both use it,
// and the next release holds it byte for byte as its release before's
// (test/release-before.test.ts), so it imports only the plan modules.

import { DEFAULT_PLAN, isFirePlan, type FirePlan, type PlanFunding } from './plan';
import { basePlanOf, isStoredPlan, planOf, toStored, upgradeStoredPlan, type FirePlanV2, type StoredPlan } from './plan-v2';
import { eventItems } from './items';
import { MAX_PLAN_SCENARIOS, applyScenario, hasAmounts, resolveScenario, type Applied, type PlanScenario } from './scenarios';
import { hasTypedAmounts, recordedCurrency, type PlanCurrencyRecord } from './plan-currency';

/** One plan, as `fire-plans` stores it. */
export type PlanEntry = {
  name: string;
  /** Either version; the facts in its fields are read from `plan-facts`
   *  when that is there (withFacts). */
  plan: StoredPlan;
  /** The plan's tax choices, from T2's reader; null until then. */
  tax: null;
  /** The currency its typed amounts are in, written with them; null for a
   *  plan that holds none. */
  currency: string | null;
  createdAt: string;
  /** The stale-edit stamp (lib/edit-stamp.ts): a save names the one it was
   *  made on (`based_on`). */
  updatedAt: string;
};

/** What every plan shares, as each FirePlan holds them in its own fields. */
export type Facts = {
  age: number | null;
  partnerAge: number | null;
  includeCash: boolean;
  planFunding: PlanFunding[];
  method: FirePlan['method'];
};

/** The facts, and which entry is yours, as `plan-facts` stores them. */
export type PlanFacts = Facts & { version: 1; main: string };

/** The main plan's id before any plan is made yours: the plan there was
 *  before copies. */
export const MAIN_ID = 'main';
/** Your plan and today's scenarios' limit. */
export const MAX_FIRE_PLANS = 1 + MAX_PLAN_SCENARIOS;

const ENTRY_KEYS = ['name', 'plan', 'tax', 'currency', 'createdAt', 'updatedAt'];
const FACT_KEYS = ['version', 'main', 'age', 'partnerAge', 'includeCash', 'planFunding', 'method'];
/** The seam's ids (lib/repo.ts). */
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const closed = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/** Whether a value is an entry as stored: the shape and types. */
export function isPlanEntry(v: unknown): v is PlanEntry {
  if (!isObject(v) || !closed(v, ENTRY_KEYS)) return false;
  return (
    typeof v.name === 'string' &&
    isStoredPlan(v.plan) &&
    v.tax === null &&
    (v.currency === null || typeof v.currency === 'string') &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string'
  );
}

/** The store's upgrade: the entry's plan as the plan store upgrades one
 *  (never changing its version), the rest as it is. */
export function upgradePlanEntry(stored: unknown): unknown {
  if (!isObject(stored) || !Object.hasOwn(stored, 'plan')) return stored;
  return { ...stored, plan: upgradeStoredPlan(stored.plan) };
}

/** Whether a value is the facts as stored: the shape, and the types as the
 *  plan's own reader takes them. */
export function isPlanFacts(v: unknown): v is PlanFacts {
  if (!isObject(v) || !closed(v, FACT_KEYS)) return false;
  if (v.version !== 1 || typeof v.main !== 'string' || !ID.test(v.main) || v.main === '__proto__') return false;
  if (v.partnerAge !== null && (typeof v.partnerAge !== 'number' || !Number.isFinite(v.partnerAge))) return false;
  return isFirePlan({ ...DEFAULT_PLAN, age: v.age, includeCash: v.includeCash, planFunding: v.planFunding, method: v.method });
}

/** The facts a plan holds in its own fields. */
export function factsOf(plan: StoredPlan): Facts {
  return {
    age: plan.age,
    partnerAge: plan.version === 2 ? plan.partnerAge : null,
    includeCash: plan.includeCash,
    planFunding: plan.planFunding,
    method: plan.method,
  };
}

const byAccount = (f: readonly PlanFunding[]) => [...f].sort((a, b) => (a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0));

/** Whether two sets of facts are the same: by value, how each workplace plan
 *  is paid into as a set by account (the savings form writes it in the order
 *  it lists the plans, as recordSave allows for). */
export function sameFacts(a: Facts, b: Facts): boolean {
  if (a.age !== b.age || a.partnerAge !== b.partnerAge || a.includeCash !== b.includeCash || a.method !== b.method) return false;
  const x = byAccount(a.planFunding);
  const y = byAccount(b.planFunding);
  return x.length === y.length && x.every((f, i) => f.account_id === y[i].account_id && f.paidFrom === y[i].paidFrom);
}

/** The plan with the facts in its own fields, so every function taking a
 *  FirePlan reads them as it always has. A partner's age needs version 2,
 *  so a version 1 plan meeting one is read as version 2 (planOf), dropping
 *  nothing. */
export function withFacts(plan: StoredPlan, facts: Facts): StoredPlan {
  const { age, partnerAge, includeCash, planFunding, method } = facts;
  if (plan.version === 1 && partnerAge === null) return { ...plan, age, includeCash, planFunding, method };
  return { ...planOf(plan), age, partnerAge, includeCash, planFunding, method };
}

/** Whether a plan holds an amount someone typed, which its currency is the
 *  currency of: version 1's typed amounts (lib/fire/plan-currency.ts), or
 *  on version 2 any item's amount (pay, a home, a pension and the rest, which
 *  typedAmounts doesn't see) or your own FI number. */
export function holdsAmounts(plan: StoredPlan): boolean {
  if (hasTypedAmounts(plan)) return true;
  return plan.version === 2 && (plan.fiNumber !== null || plan.items.some((x) => x.once !== null || x.yearly !== null || x.replaces !== null));
}

/** Which entry is your plan: the one `plan-facts` names; else `main`; else
 *  the oldest by `createdAt` (then id). `missing` when it isn't the one
 *  named, or, with no facts, when it isn't `main`: then the Plan says so.
 *  An id there that can't be read (damaged, or a newer release's) is still
 *  that id, never passed over: the caller reads it strictly and says it
 *  can't be read. Null when no entry is there at all. */
export function mainOf(
  facts: { main: string } | null,
  report: { entries: ReadonlyMap<string, PlanEntry>; unreadable: readonly string[]; unrecognised: readonly string[] }
): { id: string; missing: boolean } | null {
  const there = (id: string) => report.entries.has(id) || report.unreadable.includes(id) || report.unrecognised.includes(id);
  if (facts && there(facts.main)) return { id: facts.main, missing: false };
  const missing = facts !== null;
  if (there(MAIN_ID)) return { id: MAIN_ID, missing };
  const oldest = [...report.entries].sort(([a, x], [b, y]) => x.createdAt.localeCompare(y.createdAt) || a.localeCompare(b))[0];
  if (oldest) return { id: oldest[0], missing: true };
  const other = [...report.unreadable, ...report.unrecognised].sort()[0];
  return other === undefined ? null : { id: other, missing: true };
}

/** One scenario as a copy: its plan, and why it isn't run (the rule it
 *  breaks now, as its card says), with the replacements left out that it
 *  names. */
export type MigratedCopy = { id: string; entry: PlanEntry; notRun: string | null; orphans: Applied['orphans'] };

export type Migration = { main: PlanEntry; facts: PlanFacts; copies: MigratedCopy[] };

/**
 * The plan and its scenarios as copies, in memory, for the first write
 * (copies-and-data.md, Migration). Your plan as stored, id `main`, its
 * currency only from a record that holds; each scenario on the plan the page
 * runs it on (version 1, repaired), its life events as items after its
 * incomes and one-offs, keeping its id, name and createdAt. A scenario's own
 * currency only where it holds amounts of its own (otherCurrency's reading);
 * else your plan's, whose amounts the copy holds. `stamps` are each entry's
 * first `updatedAt`, which the first write works out (the legacy plan's
 * SHA-1, each scenario's rev).
 *
 * Refused, with why, where no copy can be right: a plan with typed amounts
 * whose currency isn't known (no record that holds), a version 2 legacy plan
 * (scenarios run on version 1 only), a scenario with your plan's id.
 */
export function migratePlans(
  legacy: StoredPlan | null,
  record: PlanCurrencyRecord | null,
  scenarios: readonly (readonly [string, PlanScenario])[],
  at: string,
  stamps: { main: string; copies: ReadonlyMap<string, string> }
): { ok: Migration } | { error: string } {
  const stored: StoredPlan = legacy ?? DEFAULT_PLAN;
  if (stored.version === 2) return { error: 'Your plan holds what only a newer version of Nya saves, so its scenarios can’t become plans of their own.' };
  const currency = recordedCurrency(stored, record);
  if (currency === null && hasTypedAmounts(stored)) return { error: 'Say which currency your plan’s figures are in first, so each plan keeps it.' };
  if (scenarios.some(([id]) => id === MAIN_ID)) return { error: `A scenario has the id "${MAIN_ID}", which your plan takes.` };
  const base = toStored(basePlanOf(stored).plan, 1);
  // A version 1 plan, repaired, always reads back as version 1.
  if ('error' in base) return { error: base.error };
  const main: PlanEntry = { name: 'First plan', plan: stored, tax: null, currency, createdAt: at, updatedAt: stamps.main };
  const facts: PlanFacts = { version: 1, main: MAIN_ID, ...factsOf(stored) };
  const copies = scenarios.map(([id, s]): MigratedCopy => {
    const r = resolveScenario(base.plan, s);
    const applied: Applied = r.ok ? r : applyScenario(base.plan, s);
    const v2: FirePlanV2 = planOf(applied.plan);
    const plan: FirePlanV2 = { ...v2, items: [...v2.items, ...eventItems(s.events)] };
    const own = hasAmounts(s) && s.currency !== null ? s.currency : currency;
    const entry: PlanEntry = { name: s.name, plan, tax: null, currency: holdsAmounts(plan) ? own : null, createdAt: s.createdAt, updatedAt: stamps.copies.get(id) ?? at };
    return { id, entry, notRun: r.ok ? null : r.error, orphans: applied.orphans };
  });
  return { ok: { main, facts, copies } };
}
