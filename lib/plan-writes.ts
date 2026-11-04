// lib/plan-writes.ts
//
// Every write of the plans as copies (lib/plan-copies.ts): a save of your
// plan or a copy (several at once for Also change it in), a new copy, a
// rename, a copy's currency, Delete, and Make this your plan. Server only.
//
// Each reads the plans first (every entry's report, so one damaged plan, or
// one a newer version saved, never stops a save of another), then writes by
// a compare-and-set over every entry it can read, written or not, every
// check run again on them at the write. An entry's stamp (`updatedAt`,
// lib/edit-stamp.ts) is what a page names as the version it saved from
// (`based_on`); every entry written gets a new one, after every stamp the
// plans hold at the write, so never one another entry holds or held before,
// since `PUT /api/fire-plan` names no id and a shared stamp could let a stale
// save of your plan land in a copy made your plan since. Names are checked
// there too; only two copies made in the same instant (neither in the
// other's compare) can share one, which a rename mends.
//
// While `fire-plans` holds no entry, your plan is the defaults, never saved
// (`based_on: null`): the first write of anything makes its entry, then
// `plan-facts`, then removes the plan before copies (`fire-plan`, its
// currency record and the scenarios), which nothing reads any more. Nobody's
// plan needed carrying over (the tax plan's C2), so nothing is migrated.
//
// Facts are written first, then the entries: a failure between says the age
// was saved and the rest wasn't. `plan-facts` missing beside entries (a write
// stopped before it) reads from your plan's own fields, which every write
// keeps in step.

import type { Ctx } from './containers';
import { eager } from './eager';
import { stampAfter } from './edit-stamp';
import { firePlanStore, planCurrencyStore } from './fire-plan';
import { planScenariosStore } from './plan-scenarios';
import { FIRST_PLAN, entryOf, firePlansStore, mainAnswer, planFactsStore, rowOf, type MainPlan, type PlanRow } from './plan-copies';
import { MAIN_ID, MAX_FIRE_PLANS, factsOf, holdsAmounts, isPlanFacts, mainOf, sameFacts, withFacts, type Facts, type PlanEntry, type PlanFacts } from './fire/copies';
import { DEFAULT_PLAN_V2, type StoredPlan } from './fire/plan-v2';
import { sameAmounts, typedAmounts, type TypedAmounts } from './fire/plan-currency';
import { nameTaken } from './fire/scenarios';
import { MANY_AT_ONCE, UnreadableValueError } from './repo';

/** A write refused for what is stored now, with the words the page shows. */
export class Refused extends Error {
  constructor(
    readonly words: string,
    readonly status = 409,
    readonly stale = true
  ) {
    super(words);
  }
}

export const CHANGED = 'Your plan changed: load the page again';
export const OTHER_DEVICE = 'Changed on another device: load it again';
export const STALE_CURRENCY = 'The currency your plan’s figures are in was changed since this page loaded it, so nothing was saved: load it again.';
export const FIRST_CURRENCY = 'Say which currency your plan’s figures are in, then save again: nothing was saved.';
export const NOTHING_TYPED = 'Your plan holds no amount you typed, so there is no currency to record.';
export const CHANGED_SINCE = 'Your plan was changed since this page loaded it, so nothing was recorded: load it again.';
export const ALREADY = 'A currency is recorded for your plan already, so it was left as it is: say which currency your figures are in.';
export const NAME_TAKEN = 'Another plan has that name: choose another, so they can be told apart.';
export const KEEP_MAIN = 'Your plan can’t be deleted: make another your plan first.';
export const AT_MOST = `You have ${MAX_FIRE_PLANS} plans, the most Nya keeps: delete one to make another.`;

/** The facts a page loaded, as it sends them (`facts_were`): the shape the
 *  facts store takes, without its version and main id. */
export function factsWere(v: unknown): Facts | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  if (!isPlanFacts({ version: 1, main: MAIN_ID, ...v })) return null;
  return pick(v as Facts);
}

/** A stamp as a page sends it (`based_on`): one a GET answered, or null
 *  before your plan is saved. */
export const isBasedOn = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 64);

/** The plans as read before a write. `empty` while `fire-plans` holds no
 *  entry: `main` is then the defaults, not stored. */
type State = {
  empty: boolean;
  main: string;
  mainEntry: PlanEntry;
  facts: PlanFacts | null;
  entries: ReadonlyMap<string, PlanEntry>;
  unreadable: readonly string[];
  unrecognised: readonly string[];
  /** While `empty`, the `plan-facts` there (a leftover nothing reads), as
   *  read: the first entry's facts replace only that. */
  leftover: PlanFacts | null | 'unreadable';
};

/** Your plan before its entry is made: the defaults, never saved. Its stamp
 *  is '' (a save names it as `based_on: null`). */
const unsaved = (at: string): PlanEntry => ({ name: FIRST_PLAN, plan: DEFAULT_PLAN_V2, tax: null, currency: null, createdAt: at, updatedAt: '' });

async function readState(ctx: Ctx, at: string): Promise<State> {
  const factsRead = eager(planFactsStore.get(ctx));
  const reportRead = eager(firePlansStore.getAllReport(ctx));
  if ((await firePlansStore.count(ctx)) === 0) {
    const leftover = await factsRead.catch((err: unknown) => {
      if (err instanceof UnreadableValueError && !err.unrecognised) return 'unreadable' as const;
      throw err;
    });
    return { empty: true, main: MAIN_ID, mainEntry: unsaved(at), facts: null, entries: new Map(), unreadable: [], unrecognised: [], leftover };
  }
  const facts = await factsRead;
  const report = await reportRead;
  const pick = mainOf(facts, report);
  if (!pick) return readState(ctx, at);
  return { empty: false, main: pick.id, mainEntry: entryOf(report, pick.id), facts, ...report, leftover: null };
}

/** The facts every plan shares, as stored now. */
const storedFacts = (s: State): Facts => (s.facts ? pick(s.facts) : factsOf(s.mainEntry.plan));
const pick = ({ age, partnerAge, includeCash, planFunding, method }: Facts): Facts => ({ age, partnerAge, includeCash, planFunding, method });

/** A stamp after `was` and after every stamp in `taken` (those the plans
 *  hold at the write, and those this write gave out already). Not only one
 *  no other entry holds now: each entry's stamps only move on, so this one
 *  is none an entry there has ever held, and a page still holding one your
 *  plan has moved past never finds it on a copy made your plan since, even
 *  within one millisecond or behind a clock that stepped back. */
function stampFor(was: string, now: Date, taken: Set<string>): string {
  const latest = Math.max(...[was, ...taken].map(Date.parse).filter(Number.isFinite));
  const at = stampAfter(Number.isFinite(latest) ? new Date(latest).toISOString() : undefined, now);
  taken.add(at);
  return at;
}

/** Every stamp the plans hold at the write. */
const stampsIn = (current: ReadonlyMap<string, PlanEntry | null>) => new Set([...current.values()].flatMap((e) => (e ? [e.updatedAt] : [])));
/** Every plan's name at the write, for nameTaken. */
const namesIn = (current: ReadonlyMap<string, PlanEntry | null>) => [...current].flatMap(([id, e]) => (e ? [{ id, name: e.name }] : []));

/**
 * Writes the entries `ids` by one compare-and-set over every entry read
 * (so stamps and names are checked against the plans as they are then):
 * `fn` gets each as stored now (your plan, before its entry is made, as the
 * defaults with stamp ''), and answers what to write. When it makes your
 * plan's first entry, the facts follow it (`facts`), then the plan before
 * copies is removed.
 */
async function writeEntries(
  ctx: Ctx,
  s: State,
  ids: string[],
  at: string,
  fn: (current: Map<string, PlanEntry | null>) => Map<string, PlanEntry | null>,
  facts: (written: Map<string, PlanEntry | null>) => Facts
): Promise<Map<string, PlanEntry | null>> {
  const making = s.empty && ids.includes(MAIN_ID);
  const all = [...new Set([...s.entries.keys(), ...ids])];
  const written = await firePlansStore.updateMany(ctx, all.length <= MANY_AT_ONCE ? all : ids, (stored) => {
    const current = new Map(stored);
    // Made meanwhile by another write: then it is checked as stored.
    if (making && current.get(MAIN_ID) === null) current.set(MAIN_ID, unsaved(at));
    return fn(current);
  });
  if (making) await afterFirst(ctx, { version: 1, main: MAIN_ID, ...facts(written) }, s.leftover);
  return written;
}

/** After your plan's first entry: the facts, then the plan before copies
 *  removed. A `plan-facts` there is a leftover (nothing reads it while no
 *  entry is there), replaced while it is still the one read: one changed
 *  since is a save made from the new entry meanwhile, and stands. Damaged
 *  bytes are removed first. A failure here is logged, never the write's:
 *  the entries hold the facts in their own fields, and the old stores are
 *  read by nothing. */
async function afterFirst(ctx: Ctx, facts: PlanFacts, leftover: State['leftover']): Promise<void> {
  const replace = (cur: PlanFacts | null) => (leftover !== 'unreadable' && JSON.stringify(cur) === JSON.stringify(leftover) ? facts : cur);
  try {
    try {
      await planFactsStore.update(ctx, replace);
    } catch (err) {
      if (!(err instanceof UnreadableValueError) || err.unrecognised || leftover !== 'unreadable') throw err;
      await planFactsStore.remove(ctx);
      await planFactsStore.update(ctx, (cur) => cur ?? facts);
    }
  } catch (err) {
    console.error('Plan facts not written after the first plan:', err);
  }
  try {
    const scenarios = await planScenariosStore.ids(ctx);
    await Promise.all([firePlanStore.remove(ctx), planCurrencyStore.remove(ctx), scenarios.length > 0 ? planScenariosStore.remove(ctx, ...scenarios) : null]);
  } catch (err) {
    console.error('The plan before copies not removed:', err);
  }
}

/** The checks a save makes on an entry, as read and again at the write:
 *  the stamp the page sent, a version 1 plan over a version 2 one (an old
 *  page would drop items it couldn't show), a currency other than the one the
 *  entry's amounts are in, and first amounts with none (the currency an entry
 *  kept once its amounts went is no one's: never a label for new ones). */
export function checkEntry(entry: PlanEntry, plan: StoredPlan, currency: string | null, basedOn: string | null): void {
  if ((basedOn ?? '') !== entry.updatedAt) throw new Refused(CHANGED);
  if (plan.version === 1 && entry.plan.version === 2) throw new Refused(CHANGED);
  if (currency !== null && holdsAmounts(entry.plan) && entry.currency !== null && entry.currency !== currency) throw new Refused(STALE_CURRENCY);
  if (currency === null && holdsAmounts(plan) && !holdsAmounts(entry.plan)) throw new Refused(FIRST_CURRENCY, 409, false);
}

export type Save = { id: string; plan: StoredPlan; currency: string | null; basedOn: string | null };

/**
 * Saves whole plans: one (your plan's save, a copy's) or several (Also change
 * it in), all or none. Each is sent with the facts in its fields; the facts
 * are the first plan's (the one being edited), and another with other facts
 * is refused. `factsWere` is what the page loaded: facts that differ from it
 * are this save's change, written first, but only over the facts it loaded,
 * so another device's new age stands through an unrelated save.
 */
export async function saveEntries(ctx: Ctx, saves: Save[], factsWere: Facts): Promise<{ main: MainPlan; rows: PlanRow[] }> {
  const now = new Date();
  const at = now.toISOString();
  const s = await readState(ctx, at);
  const sent = factsOf(saves[0].plan);
  if (saves.some((x) => !sameFacts(factsOf(x.plan), sent))) throw new Refused('Every plan saved together shares the facts: send them all with the same ones', 400, false);
  if (new Set(saves.map((x) => x.id)).size !== saves.length) throw new Refused('Each plan is saved once', 400, false);
  for (const x of saves) {
    if (s.unreadable.includes(x.id) || s.unrecognised.includes(x.id)) entryOf(s, x.id);
    const cur = x.id === s.main ? s.mainEntry : s.entries.get(x.id);
    if (!cur) throw new Refused(CHANGED);
    checkEntry(cur, x.plan, x.currency, x.basedOn);
  }
  const stored = storedFacts(s);
  let change: Facts | null = null;
  if (!sameFacts(sent, factsWere)) {
    if (!sameFacts(factsWere, stored)) throw new Refused(OTHER_DEVICE);
    change = sent;
  }
  let facts = s.facts;
  let factsLanded = false;
  try {
    if (change && !s.empty) {
      const to = change;
      facts = await planFactsStore.update(ctx, (cur) => {
        const base: PlanFacts = cur ?? { version: 1, main: s.main, ...factsOf(s.mainEntry.plan) };
        if (!sameFacts(base, factsWere)) throw new Refused(OTHER_DEVICE);
        return { ...base, ...to };
      });
      factsLanded = true;
    }
    const facts1 = change ?? stored;
    const written = await writeEntries(
      ctx,
      s,
      saves.map((x) => x.id),
      at,
      (current) => {
        const next = new Map<string, PlanEntry | null>();
        const stamps = stampsIn(current);
        for (const x of saves) {
          const cur = current.get(x.id);
          if (!cur) throw new Refused(CHANGED);
          checkEntry(cur, x.plan, x.currency, x.basedOn);
          next.set(x.id, {
            ...cur,
            plan: withFacts(x.plan, facts1),
            currency: holdsAmounts(x.plan) ? (x.currency ?? cur.currency) : cur.currency,
            updatedAt: stampFor(cur.updatedAt, now, stamps),
          });
        }
        return next;
      },
      () => facts1
    );
    const mainEntry = written.get(s.main) ?? (await firePlansStore.get(ctx, s.main)) ?? s.mainEntry;
    const main: MainPlan = { id: s.main, entry: mainEntry, facts, missing: false };
    return { main, rows: saves.map((x) => rowOf(x.id, written.get(x.id)!, facts, mainEntry)) };
  } catch (err) {
    if (factsLanded) {
      console.error('Plan facts saved, the plans not:', err);
      throw new Refused('Your age was saved; the rest wasn’t: try again');
    }
    throw err;
  }
}

/** Your plan's save (PUT /api/fire-plan names no id): into the entry that is
 *  yours now. */
export async function saveMain(ctx: Ctx, plan: StoredPlan, currency: string | null, factsWere: Facts, basedOn: string | null): Promise<MainPlan> {
  const s = await readState(ctx, new Date().toISOString());
  return (await saveEntries(ctx, [{ id: s.main, plan, currency, basedOn }], factsWere)).main;
}

/**
 * A new copy (New copy, Duplicate, Try it): `plan` whole, as the page made it
 * from `from` (its item ids kept, so Also change it in and how a copy differs
 * match by id), with the facts every plan shares. At most MAX_FIRE_PLANS,
 * every entry counted, readable or not: counted again after the write, and
 * the new one taken back when copies made together went past it. Its
 * currency is its source's while the source holds amounts (a page in another
 * currency is refused), else the one sent when it brings the first amounts.
 */
export async function createCopy(ctx: Ctx, input: { from: string; name: string; plan: StoredPlan; currency: string | null }): Promise<PlanRow> {
  const now = new Date();
  const at = now.toISOString();
  const s = await readState(ctx, at);
  const count = s.empty ? 1 : s.entries.size + s.unreadable.length + s.unrecognised.length;
  if (count >= MAX_FIRE_PLANS) throw new Refused(AT_MOST, 409, false);
  const names = [...s.entries].map(([id, e]) => ({ id, name: e.name }));
  if (s.empty) names.push({ id: MAIN_ID, name: FIRST_PLAN });
  if (nameTaken(names, input.name)) throw new Refused(NAME_TAKEN, 409, false);
  if (s.unreadable.includes(input.from) || s.unrecognised.includes(input.from)) entryOf(s, input.from);
  const source = input.from === s.main ? s.mainEntry : s.entries.get(input.from);
  if (!source) throw new Refused(CHANGED);
  let currency: string | null = null;
  if (holdsAmounts(input.plan)) {
    if (holdsAmounts(source.plan) && source.currency !== null) {
      if (input.currency !== null && input.currency !== source.currency) throw new Refused(STALE_CURRENCY);
      currency = source.currency;
    } else if (input.currency === null) throw new Refused(FIRST_CURRENCY, 409, false);
    else currency = input.currency;
  }
  const facts = storedFacts(s);
  const id = crypto.randomUUID();
  const ids = s.empty ? [MAIN_ID, id] : [id];
  const written = await writeEntries(
    ctx,
    s,
    ids,
    at,
    (current) => {
      if (current.get(id) !== null) throw new Refused(CHANGED);
      if (nameTaken(namesIn(current), input.name)) throw new Refused(NAME_TAKEN, 409, false);
      const stamps = stampsIn(current);
      const next = new Map<string, PlanEntry | null>([[id, { name: input.name, plan: withFacts(input.plan, facts), tax: null, currency, createdAt: at, updatedAt: stampFor('', now, stamps) }]]);
      if (s.empty) {
        const main = current.get(MAIN_ID)!;
        // Another write made your plan's entry meanwhile: its facts may differ.
        if (main.updatedAt !== '') throw new Refused(CHANGED);
        next.set(MAIN_ID, { ...main, updatedAt: stampFor('', now, stamps) });
      }
      return next;
    },
    () => facts
  );
  if ((await firePlansStore.count(ctx)) > MAX_FIRE_PLANS) {
    await firePlansStore.remove(ctx, id);
    throw new Refused('Other plans were being made at the same moment, so this one wasn’t: try again.', 409, false);
  }
  return rowOf(id, written.get(id)!, s.facts, s.mainEntry);
}

/** One entry changed alone, at the stamp the page loaded: a rename, or a
 *  copy's currency ("They’re in USD"). Your plan before its entry is made
 *  takes it too, as the defaults. */
async function changeOne(ctx: Ctx, id: string, basedOn: string | null, change: (cur: PlanEntry, current: ReadonlyMap<string, PlanEntry | null>) => Partial<PlanEntry>): Promise<PlanRow> {
  const now = new Date();
  const at = now.toISOString();
  const s = await readState(ctx, at);
  if (s.unreadable.includes(id) || s.unrecognised.includes(id)) entryOf(s, id);
  if (id !== s.main && !s.entries.has(id)) throw new Refused(CHANGED);
  const facts = storedFacts(s);
  const written = await writeEntries(
    ctx,
    s,
    [id],
    at,
    (current) => {
      const cur = current.get(id);
      if (!cur || (basedOn ?? '') !== cur.updatedAt) throw new Refused(CHANGED);
      return new Map([[id, { ...cur, ...change(cur, current), plan: withFacts(cur.plan, facts), updatedAt: stampFor(cur.updatedAt, now, stampsIn(current)) }]]);
    },
    () => facts
  );
  const entry = written.get(id)!;
  return rowOf(id, entry, s.facts, id === s.main ? entry : s.mainEntry);
}

export function renamePlan(ctx: Ctx, id: string, name: string, basedOn: string | null): Promise<PlanRow> {
  return changeOne(ctx, id, basedOn, (_cur, current) => {
    if (nameTaken(namesIn(current), name, id)) throw new Refused(NAME_TAKEN, 409, false);
    return { name };
  });
}

/** A copy's amounts said to be in `currency` (the person's own answer). */
export function relabelPlan(ctx: Ctx, id: string, currency: string, basedOn: string | null): Promise<PlanRow> {
  return changeOne(ctx, id, basedOn, (cur) => {
    if (!holdsAmounts(cur.plan)) throw new Refused(NOTHING_TYPED, 409, false);
    return { currency };
  });
}

/** Deletes a copy, at the stamp the page loaded; never your plan. One whose
 *  bytes are damaged only once the person confirmed it (`unreadable`), and
 *  one a newer version saved never: it is intact data. */
export async function removePlan(ctx: Ctx, id: string, basedOn: string | null, unreadable: boolean): Promise<void> {
  const s = await readState(ctx, new Date().toISOString());
  if (id === s.main) throw new Refused(KEEP_MAIN, 409, false);
  if (s.unrecognised.includes(id)) throw new Refused('That plan was saved by a newer version of Nya, so it can’t be deleted here.', 409, false);
  if (s.unreadable.includes(id)) {
    if (!unreadable) entryOf(s, id);
    await firePlansStore.remove(ctx, id);
    return;
  }
  await firePlansStore.update(ctx, id, (cur) => {
    if (cur === null) return null;
    if (basedOn !== cur.updatedAt) throw new Refused(CHANGED);
    return null;
  });
}

/** Makes a copy your plan, at the stamp the page loaded. The copy is
 *  restamped first, so a save, rename or delete made against its old stamp
 *  (on another device) is refused rather than landing in your new plan;
 *  then `plan-facts` names it (made from your plan's own fields when it is
 *  missing, never the copy's, which may hold an older age). Stopped between
 *  the two, it is said as stale: the page reads the new stamp to try again. */
export async function makeMain(ctx: Ctx, id: string, basedOn: string): Promise<MainPlan> {
  const now = new Date();
  const at = now.toISOString();
  const s = await readState(ctx, at);
  if (s.empty || id === s.main) throw new Refused(CHANGED);
  if (s.unreadable.includes(id) || s.unrecognised.includes(id)) entryOf(s, id);
  if (!s.entries.has(id)) throw new Refused(CHANGED);
  const written = await writeEntries(
    ctx,
    s,
    [id],
    at,
    (current) => {
      const cur = current.get(id);
      if (!cur || basedOn !== cur.updatedAt) throw new Refused(CHANGED);
      return new Map([[id, { ...cur, updatedAt: stampFor(cur.updatedAt, now, stampsIn(current)) }]]);
    },
    () => storedFacts(s)
  );
  try {
    const facts = await planFactsStore.update(ctx, (cur) => {
      const base: PlanFacts = cur ?? { version: 1, main: s.main, ...factsOf(s.mainEntry.plan) };
      return { ...base, main: id };
    });
    return { id, entry: written.get(id)!, facts, missing: false };
  } catch (err) {
    console.error('A plan not made yours:', err);
    throw new Refused(`“${s.entries.get(id)!.name}” wasn’t made your plan: try again`);
  }
}

/** Records your plan's currency (POST /api/fire-plan): { currency, amounts },
 *  the typed amounts of the plan the page shows, so a plan changed since on
 *  another device is never given it. `answered` when it is the person's own
 *  answer: only that replaces a currency there. */
export async function recordMain(ctx: Ctx, currency: string, amounts: TypedAmounts, answered: boolean) {
  const now = new Date();
  const at = now.toISOString();
  const s = await readState(ctx, at);
  if (s.empty) throw new Refused(NOTHING_TYPED, 409, false);
  let entry = s.mainEntry;
  await writeEntries(
    ctx,
    s,
    [s.main],
    at,
    (current) => {
      const cur = current.get(s.main);
      if (!cur) throw new Refused(CHANGED);
      if (!holdsAmounts(cur.plan)) throw new Refused(NOTHING_TYPED, 409, false);
      if (!sameAmounts(typedAmounts(cur.plan), amounts)) throw new Refused(CHANGED_SINCE);
      entry = cur;
      if (cur.currency === currency) return new Map();
      if (cur.currency !== null && !answered) throw new Refused(ALREADY);
      entry = { ...cur, currency, updatedAt: stampFor(cur.updatedAt, now, stampsIn(current)) };
      return new Map([[s.main, entry]]);
    },
    () => storedFacts(s)
  );
  return mainAnswer({ id: s.main, entry, facts: s.facts, missing: false });
}
