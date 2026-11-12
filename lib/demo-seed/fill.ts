// lib/demo-seed/fill.ts
//
// Writes what a profile sets up beyond its banks (lib/demo-seed/extras.ts),
// each through the function its route calls, in the order the seed
// (lib/demo-seed/seed.ts) runs them:
//
// - checkProfile, before anything is emptied: every plan and copy, planned
//   item, runway scenario, allocation target, deposits and withdrawals, goal
//   plan and category a profile names, through the checks their routes run,
//   so a scenario the app would refuse stops the reset while the account is
//   still whole.
// - fillSettings, once the banks are linked: categories and budgets,
//   rollover, goals and their plans, tags and rules, people and IOUs,
//   planned items, report marks, runway scenarios, the allocation target, the
//   review queue and manual rows.
// - fillPlan: your plan, its tax, its copies and the tax facts.
// - fillAccounts, after one healthy load has remembered every account (the
//   writes look an account up among those): deposits and withdrawals, hidden
//   and ended accounts, timeline notes.
// - fillTransactions, once the history is in: each row a profile names,
//   found among the stored transactions, then tagged, noted, excluded,
//   recategorized, split, grouped or shared.
// - fillTrouble, last: what a scenario puts wrong with a connection.
//
// Where a route stamps today (a goal's start, a saved plan's day), the
// store's own writer is given the profile's day instead, so a goal can have
// been set six months back.

import type { StoredItem } from '../storage';
import type { Ctx } from '../containers';
import { plaidClient } from '../plaid';
import { decrypt } from '../crypto';
import { ensureTaxonomy } from '../category-store';
import { categoryById, categoryForKey, choiceText, groupOf, indexTaxonomy, PLAID, PLAID_PRIMARIES, seedTaxonomy, type Category, type CategoryIndex } from '../categories';
import { loadBudgets, saveBudgets } from '../budget-store';
import { readBudgets } from '../budget-set';
import { changeIncome, changeMonths } from '../budget-months-store';
import { setRollover } from '../rollover';
import { writeGoalRecords, type NextGoal, type StoredPlan as GoalStoredPlan } from '../goal-plans';
import { parsePlan as parseGoalPlan } from '../goal-model';
import { ensureTag, readTagSet } from '../tags-store';
import { checkTagName, TAG_COLORS, TAGS_VERSION, type TagSet } from '../tags';
import { changeRules } from '../rules-store';
import { addRule, checkRuleInput, newRuleId } from '../rules';
import { createPerson, saveIou, saveShare } from '../shared-expenses/edits';
import { parsePlanned } from '../planned';
import { plannedStore } from '../planned-store';
import { parseReportSettings } from '../report/settings';
import { reportSettingsStore } from '../report/store';
import { parseRunwayScenario } from '../report/runway-scenarios';
import { runwayScenariosStore } from '../report/runway-scenario-store';
import { parseSettings as parseAllocationSettings } from '../allocation/settings';
import { allocationSettingsStore } from '../allocation-settings';
import { daysBefore, startDay, startReview } from '../review-store';
import { newManualTxnId, readTxnFields, type TxnFields } from '../manual-txn-input';
import { addRow } from '../manual-txn-writes';
import type { ManualAccount } from '../manual';
import { parseMoneyInOutChange } from '../money-in-out';
import { saveMoneyInOut } from '../money-in-out-store';
import { setAccountHidden } from '../hidden';
import { markEnded } from '../lifecycle';
import { addUserNote, cleanNoteText, isNoteDay, NOTE_TEXT_MAX } from '../timeline-notes';
import { annotateTransaction } from '../annotate';
import { checkNote } from '../txn-annotations';
import { setOverride } from '../overrides';
import { recordCategorization } from '../vendor-default-store';
import { readStoredTxns, vendorKey, type StoredTxn } from '../transactions';
import { findTransactions } from '../txn-lookup';
import { checkParts, saveSplit } from '../splits';
import { checkGroupName, checkMembers, createGroup } from '../groups';
import { recordWarning } from '../connection-health';
import { markNewAccounts } from '../new-accounts';
import { DEFAULT_PLAN, parsePlan } from '../fire/plan';
import { parsePlanV2, planOf, type FirePlanV2 } from '../fire/plan-v2';
import { factsOf, holdsAmounts } from '../fire/copies';
import { DEFAULT_TAX_CHOICES, parseTaxChoices, type TaxChoices } from '../fire/tax-choices';
import { DEFAULT_TAX_FACTS, householdOf, parseHousehold, parseTaxFactOp, type TaxFactOp, type TaxHousehold } from '../fire/tax-facts';
import { parseSavedDraft } from '../fire/saved-plan';
import { createCopy, optIn, saveMain, saveTaxFacts } from '../plan-writes';
import type { RowRef, SeedExtras, SeedRule } from './extras';
import { checkPastMonths } from './past-months';
import { historyMonths, type DemoProfile, type SeedAccount, type SeedInstitution, type SeedManual } from './profiles';

/** An institution as linked: the profile's, and the Item made of it. */
export type Linked = { inst: SeedInstitution; item: StoredItem };

/** What the fill works from, once the banks are linked. */
export type SeedRun = {
  ctx: Ctx;
  profile: DemoProfile;
  today: string;
  /** Account ids, by mask. */
  accountIds: Map<string, string>;
  linked: Linked[];
  /** Manual accounts as saved, by name. */
  manual: Map<string, ManualAccount>;
  /** The people costs are shared with, by name, once fillSettings has made them. */
  people: Map<string, string>;
  /** Items whose history hadn't all come when the wait ended. */
  waiting: Set<string>;
  /** What was passed over, for the report. */
  skipped: string[];
};

/** Your plan as first saved, as it stands once tax is worked out, and its copies. */
export type SeededPlans = { first: FirePlanV2; main: FirePlanV2; copies: { name: string; plan: FirePlanV2 }[] };

const DAY_MS = 86_400_000;
const USD = 'USD';

// ---------------------------------------------------------------- checking

/** Every Plaid category a profile names. */
export function categoryKeys(p: DemoProfile): string[] {
  const x = p.extras ?? {};
  const keys = new Set(Object.keys(p.budgets));
  for (const r of x.rules ?? []) if (r.category) keys.add(r.category);
  for (const r of x.recategorized ?? []) keys.add(r.category);
  for (const s of x.splits ?? []) for (const part of s.parts) keys.add(part.category);
  for (const g of x.groups ?? []) keys.add(g.category);
  for (const i of x.ious ?? []) if (i.category) keys.add(i.category);
  for (const k of x.rollover ?? []) keys.add(k);
  for (const g of x.groupBudgets ?? []) keys.add(g.key);
  for (const k of x.reportMarked ?? []) keys.add(k);
  for (const m of p.manual) for (const r of m.rows ?? []) if (r.category) keys.add(r.category);
  return [...keys];
}

/** Every row a profile names. */
function rowRefs(x: SeedExtras): (RowRef | null)[] {
  return [
    ...(x.marks ?? []).map((m) => m.row),
    ...(x.recategorized ?? []).map((r) => r.row),
    ...(x.splits ?? []).map((s) => s.row),
    ...(x.groups ?? []).flatMap((g) => g.rows),
    ...(x.shares ?? []).map((s) => s.row),
  ];
}

/** The profile's plan, its copies and what working tax out changes, as the
 *  Plan's own save checks them (parsePlanV2): `idOf` names a workplace plan's
 *  account by its mask. */
export function plansOf(profile: DemoProfile, idOf: (mask: string) => string): SeededPlans {
  const v1 = parsePlan({ ...DEFAULT_PLAN, ...profile.plan });
  if ('error' in v1) throw new Error(`The profile's plan is refused: ${v1.error}`);
  const base = planOf(v1.plan);
  const p = profile.extras?.plan ?? {};
  const first = checkedPlan(
    {
      ...base,
      partnerAge: profile.tax?.partnerAge ?? null,
      items: [...base.items, ...(p.items ?? [])],
      planFunding: (p.payroll ?? []).map((mask) => ({ account_id: idOf(mask), paidFrom: 'payroll' as const })),
      ...p.set,
    },
    'plan'
  );
  const detail = profile.tax?.detail;
  const main = detail
    ? checkedPlan({ ...first, items: first.items.map((x) => (x.id === detail.socialSecurity ? { ...x, kind: 'social-security' as const, beforeTax: true } : x)) }, 'plan')
    : first;
  const copies = (p.copies ?? []).map((c) => {
    for (const id of c.drop ?? []) if (!main.items.some((x) => x.id === id)) throw new Error(`The copy ${c.name} drops ${id}, which your plan doesn't have`);
    const items = [...main.items.filter((x) => !c.drop?.includes(x.id)), ...(c.add ?? [])];
    return { name: c.name, plan: checkedPlan({ ...main, ...c.set, items }, `copy ${c.name}`) };
  });
  return { first, main, copies };
}

function checkedPlan(plan: FirePlanV2, what: string): FirePlanV2 {
  const parsed = parsePlanV2(plan);
  if ('error' in parsed) throw new Error(`The profile's ${what} is refused: ${parsed.error} (${parsed.field})`);
  return parsed.plan;
}

/** The planned items as their route stores them; `id` names each. */
function plannedOf(planned: NonNullable<SeedExtras['planned']>, id: (i: number) => string) {
  const parsed = parsePlanned({
    version: 1,
    items: planned.items.map((p, i) => ({ id: id(i), ...p, currency: USD })),
    dismissed: [],
    threshold: planned.threshold === null ? null : { amount: planned.threshold, currency: USD },
  });
  if ('error' in parsed) throw new Error(`The profile's planned items are refused: ${parsed.error}`);
  return parsed.ok;
}

function runwayOf(r: NonNullable<SeedExtras['runway']>[number]) {
  const parsed = parseRunwayScenario({ ...r, currency: USD }, Date.now());
  if ('error' in parsed) throw new Error(`The runway scenario ${r.name} is refused: ${parsed.error}`);
  return parsed.ok;
}

function allocationOf(target: NonNullable<SeedExtras['allocation']>['target']) {
  const parsed = parseAllocationSettings({ v: 1, buckets: [], funds: [], accounts: [], target });
  if ('error' in parsed) throw new Error(`The allocation target is refused: ${parsed.error}`);
  return parsed.settings;
}

function moneyInOutOf(account_id: string, m: NonNullable<SeedExtras['moneyInOut']>[number]) {
  const change = parseMoneyInOutChange({ account_id, in: m.in, out: m.out, as_of: m.as_of, currency: USD });
  if (typeof change === 'string') throw new Error(`Deposits and withdrawals for ${m.mask} are refused: ${change}`);
  return change;
}

/** A rule as its route takes it, its category and tags by id. */
function ruleInput(r: SeedRule, categoryId: (key: string) => string, tagId: (name: string) => string) {
  const actions = {
    ...(r.category ? { set_category: categoryId(r.category) } : {}),
    ...(r.rename ? { set_name: r.rename } : {}),
    ...(r.tags ? { add_tags: r.tags.map(tagId) } : {}),
    ...(r.hide ? { hide: true } : {}),
  };
  return { conditions: [{ field: 'name', op: r.op ?? 'contains', value: r.name }], actions, ...(r.off ? { enabled: false } : {}) };
}

/** A manual account's row as the page sends it, or why it is refused. */
function manualRow(r: NonNullable<SeedManual['rows']>[number], ix: CategoryIndex, today: string, account: string): TxnFields {
  const read = readTxnFields({ date: r.date, amount: r.amount, name: r.name, category: r.category ? choiceText(categoryOf(ix, r.category)) : null }, { partial: false, today });
  if ('error' in read) throw new Error(`A row on ${account} is refused: ${read.error}`);
  const f = read.fields;
  return { date: f.date!, amount: f.amount!, currency: f.currency!, name: f.name!, category: f.category ?? null, note: f.note ?? null };
}

/** The tax and household your plan's second save gives it, from the
 *  household stored before it (`were`), or null when the profile has none. */
function detailOf(profile: DemoProfile, were: TaxHousehold): { tax: TaxChoices; household: { to: TaxHousehold; were: TaxHousehold } } | null {
  const detail = profile.tax?.detail;
  if (!detail) return null;
  const detailed = profile.extras?.plan?.detailed;
  return {
    tax: {
      ...DEFAULT_TAX_CHOICES,
      state: detail.state,
      health: { ...DEFAULT_TAX_CHOICES.health, beforeMedicare: detail.beforeMedicare },
      ...(detailed ? { strategy: { ...DEFAULT_TAX_CHOICES.strategy, conversions: detailed.conversions, convertUntil: detailed.convertUntil } } : {}),
    },
    household: { to: { ...were, filing: detail.filing, dependents: profile.extras?.plan?.dependents ?? [] }, were },
  };
}

/** The tax facts the profile saves, as the Plan's facts route takes them;
 *  `idOf` names an account by its mask. */
function taxFactOps(profile: DemoProfile, idOf: (mask: string) => string): TaxFactOp[] {
  return [
    ...(profile.tax?.accounts ?? []).map((a): TaxFactOp => ({ kind: 'account', account_id: idOf(a.mask), owner: a.owner, basis: a.basis, count: false })),
    ...(profile.tax?.roth ?? []).map((r): TaxFactOp => ({ kind: 'roth', owner: r.owner, amount: r.amount })),
  ];
}

/** The checks a route runs on what it is sent, as one: a refusal names what. */
function routeCheck(what: string, check: () => unknown): void {
  try {
    const out = check();
    if (out && typeof out === 'object' && 'error' in out) throw new Error(String(out.error));
  } catch (err) {
    throw new Error(`${what} is refused: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The day a saved plan was saved: so many months back, on the same day of the month. */
const savedDay = (today: string, monthsBack: number) => {
  const [y, m, d] = today.split('-').map(Number);
  const total = y * 12 + (m - 1) - monthsBack;
  const last = new Date(Date.UTC(Math.floor(total / 12), (total % 12) + 1, 0)).getUTCDate();
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};

/**
 * Refuses a profile the app would refuse part of, before anything is
 * changed: everything below is checked as its route checks it, and every
 * account, person, tag and category a profile names must be one it has.
 */
export function checkProfile(profile: DemoProfile, today: string): void {
  const accounts = new Map<string, SeedAccount>();
  for (const inst of profile.institutions) {
    for (const a of inst.accounts) {
      if (accounts.has(a.mask)) throw new Error(`Two accounts end ${a.mask}`);
      accounts.set(a.mask, a);
    }
  }
  const known = (mask: string, what: string) => {
    if (!accounts.has(mask)) throw new Error(`No account ending ${mask} for ${what}`);
  };
  const x = profile.extras ?? {};
  for (const key of categoryKeys(profile)) if (!Object.hasOwn(PLAID_PRIMARIES, key)) throw new Error(`No Plaid category ${key}`);
  for (const key of x.rollover ?? []) if (!Object.hasOwn(profile.budgets, key)) throw new Error(`Only a budget rolls over: ${key} has none`);

  for (const r of rowRefs(x)) {
    if (r === null) throw new Error('A row the profile names was never made');
    known(r.mask, `the row ${r.description}`);
    if (r.date > today) throw new Error(`The row ${r.description} is after today`);
  }
  for (const s of x.splits ?? []) {
    if (s.parts.length < 2) throw new Error('A split has at least two parts');
    if (Math.abs(s.parts.reduce((n, p) => n + p.share, 0) - 1) > 1e-9) throw new Error('A split’s parts make up the whole');
  }
  const people = new Set(x.people ?? []);
  for (const s of x.shares ?? []) for (const p of s.parts) if (!people.has(p.person)) throw new Error(`No person ${p.person}`);
  for (const i of x.ious ?? []) if (!people.has(i.person)) throw new Error(`No person ${i.person}`);
  const tags = new Set(x.tags ?? []);
  for (const t of [...(x.rules ?? []).flatMap((r) => r.tags ?? []), ...(x.marks ?? []).flatMap((m) => m.tags ?? [])]) if (!tags.has(t)) throw new Error(`No tag ${t}`);

  for (const g of profile.goals) {
    if (g.mask !== null) known(g.mask, `the goal ${g.name}`);
    const plan = parseGoalPlan({ monthly_target: g.plan?.monthly_target, target_date: g.plan?.target_date, archived: g.plan?.archived ? true : undefined });
    if ('error' in plan) throw new Error(`The goal ${g.name}'s plan is refused: ${plan.error}`);
    if (g.plan?.started && !g.plan.target_date) throw new Error(`The goal ${g.name} starts with no target date`);
  }
  for (const m of x.moneyInOut ?? []) {
    known(m.mask, 'deposits and withdrawals');
    if (accounts.get(m.mask)!.type !== 'investment') throw new Error(`Deposits and withdrawals are an investment account's: ${m.mask} isn't one`);
    moneyInOutOf(`seed-${m.mask}`, m);
  }
  for (const mask of x.hidden ?? []) known(mask, 'hiding');
  for (const e of x.ended ?? []) {
    known(e.mask, 'an end');
    if (e.on > today) throw new Error(`An account can't end after today (${e.mask})`);
  }
  for (const n of x.notes ?? []) if (n.mask) known(n.mask, 'a note');
  for (const a of profile.tax?.accounts ?? []) known(a.mask, 'its tax facts');
  for (const mask of x.plan?.payroll ?? []) known(mask, 'a workplace plan');

  if (x.planned) plannedOf(x.planned, (i) => `seed-${i + 1}`);
  for (const r of x.runway ?? []) runwayOf(r);
  if (x.allocation) allocationOf(x.allocation.target);
  checkPastMonths(profile, today);
  const plans = plansOf(profile, (mask) => `seed-${mask}`);
  if (x.plan?.savedMonthsBack !== undefined) {
    const draft = parseSavedDraft({ plan: plans.main, savings: 0, currency: USD, inflation: 0.03 });
    if ('error' in draft) throw new Error(`The saved plan is refused: ${draft.error}`);
  }
  const t = x.trouble;
  for (const id of [t?.loginRequired, t?.reconnectSoon?.institution_id, t?.newAccounts]) {
    if (id !== undefined && !profile.institutions.some((i) => i.institution_id === id)) throw new Error(`No institution ${id} for its trouble`);
  }

  // Names, notes and rules as their routes check them, over categories and
  // tags made as the fill makes them (with stand-in ids); manual rows; your
  // plan's tax and household; its tax facts.
  let n = 0;
  const ix = indexTaxonomy(seedTaxonomy(categoryKeys(profile).map((key) => ({ provider: PLAID, key })), () => `seed-${++n}`));
  const tagSet: TagSet = { version: TAGS_VERSION, tags: (x.tags ?? []).map((name, i) => ({ id: `seed-tag-${i}`, name, color: TAG_COLORS[0], created_at: `${today}T00:00:00.000Z` })) };
  const tagId = (name: string) => tagSet.tags.find((tag) => tag.name === name)!.id;
  for (const name of x.tags ?? []) routeCheck(`The tag ${name}`, () => checkTagName(name));
  for (const r of x.rules ?? []) routeCheck(`The rule on ${r.name}`, () => checkRuleInput(ruleInput(r, (key) => categoryOf(ix, key).id, tagId), { ix, tags: tagSet }));
  for (const m of x.marks ?? []) if (m.note !== undefined) routeCheck(`The note on ${m.row?.description}`, () => checkNote(m.note));
  for (const g of x.groups ?? []) routeCheck(`The group ${g.name}`, () => checkGroupName(g.name));
  for (const note of x.notes ?? []) {
    if (!isNoteDay(note.date) || note.date > today) throw new Error(`The timeline note ${note.text} is refused: its day is YYYY-MM-DD and has come`);
    if (cleanNoteText(note.text) === null) throw new Error(`The timeline note on ${note.date} is refused: a note is 1 to ${NOTE_TEXT_MAX} characters`);
  }
  for (const m of profile.manual) for (const r of m.rows ?? []) manualRow(r, ix, today, m.name);
  const detail = detailOf(profile, householdOf(DEFAULT_TAX_FACTS));
  if (detail) {
    routeCheck('Your plan’s tax', () => parseTaxChoices(detail.tax, null));
    routeCheck('Your plan’s household', () => parseHousehold(detail.household.to));
  }
  for (const op of taxFactOps(profile, (mask) => `seed-${mask}`)) routeCheck(`The tax fact ${op.kind}`, () => parseTaxFactOp(op));
}

// ---------------------------------------------------------------- settings

function categoryOf(ix: CategoryIndex, key: string): Category {
  const c = categoryForKey(ix, PLAID, key);
  if (!c) throw new Error(`No category files Plaid's ${key}`);
  return c;
}

/** The first month of the history, YYYY-MM. */
function firstMonth(today: string): string {
  const m = historyMonths(today)[0];
  return `${m.year}-${String(m.month).padStart(2, '0')}`;
}

/** What a profile sets up that needs no account and no transaction. */
export async function fillSettings(run: SeedRun): Promise<void> {
  const { ctx, profile, today } = run;
  const x = profile.extras ?? {};
  const taxonomy = await ensureTaxonomy(ctx, { required: categoryKeys(profile).map((key) => ({ provider: PLAID, key })) });
  const ix = indexTaxonomy(taxonomy);
  const category = (key: string) => categoryOf(ix, key);

  // Budgets, a group's too, then rollover and income carryover from the
  // first month of the history.
  const categories: Record<string, { amount: number }> = {};
  for (const [key, amount] of Object.entries(profile.budgets)) categories[category(key).id] = { amount };
  const groups: Record<string, { amount: number }> = {};
  for (const g of x.groupBudgets ?? []) groups[groupOf(ix, category(g.key)).id] = { amount: g.amount };
  await loadBudgets(ctx);
  await saveBudgets(ctx, readBudgets({ categories, groups }), taxonomy);
  const month = today.slice(0, 7);
  const from = firstMonth(today);
  if ((x.rollover ?? []).length > 0) {
    const { budgets, taxonomy: now } = await loadBudgets(ctx);
    for (const key of x.rollover!) await changeMonths(ctx, budgets, now, month, (m) => setRollover(m, 'categories', category(key).id, { on: true, from }, month));
  }
  if (x.incomeCarryover) await changeIncome(ctx, { enabled: true, start: from }, month);

  // Goals, with the plans their route would have stamped on the profile's days.
  const next: NextGoal[] = profile.goals.map((g) => {
    const account_id = g.mask === null ? null : (run.accountIds.get(g.mask) ?? null);
    if (g.mask !== null && account_id === null) throw new Error(`No account ending ${g.mask} for the goal ${g.name}`);
    const plan: GoalStoredPlan = {};
    if (g.plan?.monthly_target !== undefined) plan.monthly_target = g.plan.monthly_target;
    if (g.plan?.target_date !== undefined) {
      plan.target_date = g.plan.target_date;
      // What a goal on no account holds is nothing.
      plan.plan_start = g.plan.started ? { date: g.plan.started.date, amount: g.plan.started.amount, account_id } : { date: today, amount: account_id === null ? 0 : null, account_id };
    }
    if (g.plan?.archived) plan.archived = { on: g.plan.archived.on, amount: g.plan.archived.amount };
    return { core: { id: crypto.randomUUID(), name: g.name, target: g.target, account_id }, plan };
  });
  await writeGoalRecords(ctx, next, { records: [], entries: new Map() });

  // Tags, then the rules that put them on, in the order listed (each new rule
  // goes first, so they are added last to first).
  const tagIds = new Map<string, string>();
  for (const name of x.tags ?? []) tagIds.set(name, (await ensureTag(ctx, { name })).tag.id);
  const tagSet = await readTagSet(ctx);
  for (const r of [...(x.rules ?? [])].reverse()) {
    const raw = ruleInput(r, (key) => category(key).id, (t) => tagIds.get(t)!);
    await changeRules(ctx, (set) => addRule(set, raw, { ix, tags: tagSet }, newRuleId).set);
  }

  // People, and what is owed between you that no transaction shows.
  for (const name of x.people ?? []) run.people.set(name, (await createPerson(ctx, { name })).id);
  for (const i of x.ious ?? []) {
    await saveIou(ctx, null, { person: run.people.get(i.person), direction: i.direction, amount: i.amount, currency: USD, date: i.date, what: i.what, ...(i.category ? { category_id: category(i.category).id } : {}) });
  }

  if (x.planned) await plannedStore.set(ctx, plannedOf(x.planned, () => crypto.randomUUID()));
  if (x.reportMarked) {
    const parsed = parseReportSettings({ v: 1, marked: x.reportMarked.map((k) => choiceText(category(k))) });
    if ('error' in parsed) throw new Error(`The report's marks are refused: ${parsed.error}`);
    await reportSettingsStore.set(ctx, parsed.settings);
  }
  for (const r of x.runway ?? []) await runwayScenariosStore.set(ctx, crypto.randomUUID(), runwayOf(r));
  if (x.allocation) await allocationSettingsStore.set(ctx, allocationOf(x.allocation.target));
  if (x.review) await startReview(ctx, startDay(daysBefore(today, x.review.daysBack), today));

  // Rows on manual accounts, as entered in the app (the balance already says
  // where they leave it).
  for (const m of profile.manual) {
    const account = run.manual.get(m.name)!;
    for (const r of m.rows ?? []) await addRow(ctx, account, manualRow(r, ix, today, m.name), newManualTxnId());
  }
}

// ---------------------------------------------------------------- the Plan

/** Your plan, as the profile has it: saved flat, then what working tax out
 *  from the accounts reads (said while the plan stays flat, so Preview offers
 *  it, unless the profile has turned it on), its copies and the tax facts. */
export async function fillPlan(run: SeedRun): Promise<SeededPlans> {
  const { ctx, profile } = run;
  const plans = plansOf(profile, (mask) => run.accountIds.get(mask)!);
  const first = await saveMain(ctx, plans.first, holdsAmounts(plans.first) ? USD : null, factsOf(DEFAULT_PLAN), null);
  // A second save: the household needs the facts the first one writes.
  const detail = detailOf(profile, householdOf(DEFAULT_TAX_FACTS));
  if (detail) await saveMain(ctx, plans.main, USD, factsOf(plans.first), first.entry.updatedAt, detail);
  for (const c of plans.copies) await createCopy(ctx, { from: first.id, name: c.name, plan: c.plan, currency: holdsAmounts(c.plan) ? USD : null });
  for (const op of taxFactOps(profile, (mask) => run.accountIds.get(mask)!)) await saveTaxFacts(ctx, op);
  if (profile.extras?.plan?.detailed) await optIn(ctx);
  return plans;
}

/** The day a profile's saved plan was saved, or null for none. */
export const savedPlanDay = (profile: DemoProfile, today: string): string | null => {
  const back = profile.extras?.plan?.savedMonthsBack;
  return back === undefined ? null : savedDay(today, back);
};

// ---------------------------------------------------------------- accounts

/** Each account's own writes, once a healthy load has remembered them. */
export async function fillAccounts(run: SeedRun): Promise<void> {
  const { ctx, profile } = run;
  const x = profile.extras ?? {};
  const id = (mask: string) => run.accountIds.get(mask)!;
  const where = (mask: string) => {
    for (const l of run.linked) {
      const a = l.inst.accounts.find((acc) => acc.mask === mask);
      if (a) return { account: a, linked: l };
    }
    throw new Error(`No account ending ${mask}`);
  };
  for (const m of x.moneyInOut ?? []) await saveMoneyInOut(ctx, moneyInOutOf(id(m.mask), m));
  for (const mask of x.hidden ?? []) await setAccountHidden(ctx, id(mask), where(mask).account.type, true);
  for (const e of x.ended ?? []) {
    const { account, linked } = where(e.mask);
    await markEnded(
      ctx,
      id(e.mask),
      { state: 'closed', on: e.on, note: e.note },
      { type: account.type, label: { name: account.name, institution: linked.inst.name, mask: account.mask }, item_id: linked.item.item_id, currency: USD },
      Date.now(),
      new Map(),
      { balance: account.balance }
    );
  }
  for (const n of x.notes ?? []) await addUserNote(ctx, { date: n.date, text: n.text, ...(n.mask ? { account_id: id(n.mask) } : {}) });
}

// ---------------------------------------------------------------- transactions

/** Lower case, spaces collapsed: how a bank's words are compared. */
const words = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const cents = (n: number) => Math.round(n * 100);

/** The stored transaction a row became, or null (said in `skipped`): found by
 *  its account, day and amount, and among several by its words. */
async function findRow(run: SeedRun, stored: Map<string, StoredTxn[]>, ref: RowRef): Promise<{ txn: StoredTxn; institution_name: string } | null> {
  const linked = run.linked.find((l) => l.inst.accounts.some((a) => a.mask === ref.mask))!;
  const said = `${ref.description} on ${ref.date}`;
  if (run.waiting.has(linked.item.item_id)) {
    run.skipped.push(`${said}: ${linked.inst.name}'s history hadn't all come`);
    return null;
  }
  if (!stored.has(linked.item.item_id)) stored.set(linked.item.item_id, await readStoredTxns(run.ctx, linked.item.item_id));
  const account_id = run.accountIds.get(ref.mask)!;
  const same = stored.get(linked.item.item_id)!.filter((t) => t.account_id === account_id && !t.pending && t.date === ref.date && cents(t.amount) === cents(ref.amount));
  const named = same.length > 1 ? same.filter((t) => words(t.name) === words(ref.description)) : same;
  if (named.length !== 1) {
    run.skipped.push(`${said}: ${named.length === 0 ? 'not among the stored transactions' : 'more than one stored transaction matches it'}`);
    return null;
  }
  return { txn: named[0], institution_name: linked.item.institution_name };
}

/** What a profile does to its transactions. */
export async function fillTransactions(run: SeedRun): Promise<void> {
  const { ctx, profile, today } = run;
  const x = profile.extras ?? {};
  const stored = new Map<string, StoredTxn[]>();
  const find = (ref: RowRef | null) => findRow(run, stored, ref!);
  const ix = indexTaxonomy(await ensureTaxonomy(ctx));
  const category = (key: string) => categoryOf(ix, key);

  const tagSet = await readTagSet(ctx);
  const tagId = (name: string) => tagSet!.tags.find((t) => t.name === name)!.id;
  for (const m of x.marks ?? []) {
    const row = await find(m.row);
    if (!row) continue;
    await annotateTransaction(ctx, row.txn.transaction_id, { add: (m.tags ?? []).map(tagId), remove: [], ...(m.excluded ? { excluded: true } : {}), ...(m.note ? { note: m.note } : {}) });
  }

  // As choosing a category does: the override, then the merchant's vote.
  const resolve = (cid: string) => categoryById(ix, cid)?.id ?? null;
  for (const r of x.recategorized ?? []) {
    const row = await find(r.row);
    if (!row) continue;
    const c = category(r.category);
    await setOverride(ctx, row.txn.transaction_id, choiceText(c).trim().toLowerCase());
    const vendor_key = vendorKey({ merchant_entity_id: row.txn.merchant_entity_id, merchant_name: row.txn.merchant_name, name: row.txn.name, institution_name: row.institution_name });
    await recordCategorization(ctx, { vendor_key, name: (row.txn.merchant_name || row.txn.name).trim(), category_id: c.id }, { resolve, today });
  }

  for (const s of x.splits ?? []) {
    const row = await find(s.row);
    if (!row) continue;
    const id = row.txn.transaction_id;
    const found = (await findTransactions(ctx, [id])).get(id)!;
    // Each part its share in cents, the last what is left, so they add up.
    let left = cents(found.amount);
    const raw = s.parts.map((p, i) => {
      const units = i === s.parts.length - 1 ? left : Math.round(cents(found.amount) * p.share);
      left -= units;
      return { amount: units / 100, category_id: category(p.category).id, ...(p.note ? { note: p.note } : {}) };
    });
    await saveSplit(ctx, id, found, checkParts(raw, found));
  }

  for (const g of x.groups ?? []) {
    const rows = [];
    for (const ref of g.rows) {
      const row = await find(ref);
      if (row) rows.push(row);
    }
    if (rows.length < g.rows.length) continue;
    const members = rows.map((r) => r.txn.transaction_id);
    const found = await findTransactions(ctx, members);
    const { date, currency } = checkMembers(members.map((m) => found.get(m)!));
    await createGroup(ctx, { name: g.name, category_id: category(g.category).id, members, date, currency });
  }

  for (const s of x.shares ?? []) {
    const row = await find(s.row);
    if (!row) continue;
    await saveShare(ctx, row.txn.transaction_id, { what: s.what, entries: s.parts.map((p) => ({ person: run.people.get(p.person), amount: p.amount })) });
  }
}

// ---------------------------------------------------------------- trouble

/** What a scenario puts wrong with its connections, last, so everything
 *  before it saw them healthy. */
export async function fillTrouble(run: SeedRun): Promise<void> {
  const t = run.profile.extras?.trouble;
  if (!t) return;
  const itemOf = (institution_id: string) => run.linked.find((l) => l.inst.institution_id === institution_id)!.item;
  if (t.reconnectSoon) {
    const item = itemOf(t.reconnectSoon.institution_id);
    await recordWarning(run.ctx, item.item_id, { webhook_code: 'PENDING_EXPIRATION', consent_expiration_time: new Date(Date.now() + t.reconnectSoon.days * DAY_MS).toISOString() });
  }
  if (t.newAccounts) await markNewAccounts(run.ctx, itemOf(t.newAccounts).item_id);
  if (t.loginRequired) {
    const item = itemOf(t.loginRequired);
    await plaidClient.sandboxItemResetLogin({ access_token: await decrypt(run.ctx, item.encrypted_access_token) });
  }
}

