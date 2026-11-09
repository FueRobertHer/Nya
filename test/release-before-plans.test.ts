import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import type { PlanEntry, PlanFacts } from './fixtures/release-before/fire/copies';
import type { PlanItem } from '@/lib/fire/items';

// The release before (the last merge before this one, 221c0d7c, D9's reader, whose readers
// of the plans as copies are in test/fixtures/release-before/fire/copies.ts byte
// for byte, pinned by test/release-before.test.ts) reading what this release
// writes, so a rollback to it loses no plan. Every write this release makes
// (your plan's first save, a New copy, a Try it, an Also save over two plans, a
// rename, a copy's currency, a delete, Make this your plan, your plan's currency
// alone) is read back from the stored bytes with its own checks: each entry is
// an entry to it (isPlanEntry, after its upgrade), the facts are facts to it
// (isPlanFacts), your plan is the one it picks (mainOf, never said to be
// missing), every entry that holds an amount holds its currency, and what its
// GET answers from them is the plan this release answers. A saved plan of
// version 2 is a saved plan to it (isSavedPlan). This release writes items of
// every kind on every anchor, the stop at FI, your partner's age and your own
// FI number, all of which it reads, and the tax facts (`plan-facts` version 2),
// with or without a plan, which TF read a release before this one writes them
// and which its saves keep. It writes what T2 read a release
// ahead: `model: 'detailed'`, each plan's choices, the household and `at-stop`.
// And it writes `lastsIn`, your FI date as the earliest stop that lasts (D9),
// which the release before reads and its saves keep.
// And its restore (test/fixtures/release-before/user-restore/parts.ts) takes a
// download this release makes, plans and all: it refuses a file with a part it
// doesn't know, or without one of its header parts, and reads each store part
// as the kind its own list says.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const oCopies = await import('./fixtures/release-before/fire/copies');
const oChoices = await import('./fixtures/release-before/fire/tax-choices');
const oSaved = await import('./fixtures/release-before/fire/saved-plan');
const oPlanV2 = await import('./fixtures/release-before/fire/plan-v2');
const { openStored } = await import('@/lib/repo');
const { firePlansStore, planFactsStore } = await import('@/lib/plan-copies');
const { savedPlanStore } = await import('@/lib/saved-plan');
const { emptyAccount } = await import('@/lib/user-restore/undo');
const { DEFAULT_PLAN_V2, LASTS_IN_CHOICES, planOf } = await import('@/lib/fire/plan-v2');
const { itemFromIncome } = await import('@/lib/fire/items');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const { typedAmounts } = await import('@/lib/fire/plan-currency');
const { genEvents, genPlan, itemFromEvent, rand } = await import('./plan-gen');
const oParts = await import('./fixtures/release-before/user-restore/parts');
const { SEAM } = await import('@/lib/user-restore/parts');
const { buildUserExport, collectUserData } = await import('@/lib/user-export');
const planRoute = await import('@/app/api/fire-plan/route');
const factsRoute = await import('@/app/api/plan-facts/route');
const plansRoute = await import('@/app/api/plans/route');
const savedRoute = await import('@/app/api/saved-plan/route');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

const ctx = TEST_CTX;
const income = itemFromIncome({ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true });
const child = itemFromEvent({ id: 'kid', kind: 'child', label: 'A child', fromAge: 42, yearly: 10_000, years: 18 });
const TYPED: FirePlanV2 & { start: 'fi-number' } = { ...DEFAULT_PLAN_V2, start: 'fi-number', age: 40, targetAge: 55, spending: 40_000, items: [income] };
const DEFAULTS = factsOf(DEFAULT_PLAN_V2);

const req = (path: string, method: string, body: unknown) => new Request(`http://localhost/api/${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const call = async (handler: (r: Request) => Promise<Response>, path: string, method: string, body: unknown) => {
  const res = await handler(req(path, method, body));
  return { status: res.status, body: await res.json() };
};
const ok = <T extends { status: number; body: unknown }>(r: T): T['body'] => {
  expect([r.status, r.body]).toEqual([200, r.body]);
  return r.body;
};
const save = (plan: FirePlanV2, based_on: string | null, facts_were: unknown, currency: string | null = 'USD', more: object = {}) => call(planRoute.PUT, 'fire-plan', 'PUT', { plan, currency, facts_were, based_on, ...more });
const plans = (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown) => call(plansRoute[method], 'plans', method, body);

/** Every entry and the facts as its stores read their bytes: opened, then
 *  its upgrade and its checks. */
async function readAsBefore() {
  const fields = (await fake.hgetall<Record<string, string>>(ctxKey('fire-plans'))) ?? {};
  const entries = new Map<string, PlanEntry>();
  const refused: string[] = [];
  for (const [id, stored] of Object.entries(fields)) {
    const opened = await openStored(ctx, stored);
    if (!opened.ok) throw new Error(`${id} can't be opened`);
    const value = oCopies.upgradePlanEntry(JSON.parse(opened.text));
    if (oCopies.isPlanEntry(value)) entries.set(id, value);
    else refused.push(id);
  }
  const rawFacts = await fake.get<string>(ctxKey('plan-facts'));
  let facts: unknown = null;
  if (rawFacts !== null) {
    const opened = await openStored(ctx, rawFacts);
    if (!opened.ok) throw new Error('the facts can’t be opened');
    facts = JSON.parse(opened.text);
  }
  return { entries, refused, facts };
}

/** It reads every plan there, with `main` as your plan; and what its GET
 *  /api/fire-plan answers from them is this release's answer. */
async function readsAll(main: string, what: string) {
  const { entries, refused, facts } = await readAsBefore();
  expect([what, refused]).toEqual([what, []]);
  expect([what, oCopies.isPlanFacts(facts)]).toEqual([what, true]);
  const f = facts as PlanFacts;
  expect([what, oCopies.mainOf(f, { entries, unreadable: [], unrecognised: [] })]).toEqual([what, { id: main, missing: false }]);
  for (const [id, e] of entries) {
    expect([what, id, oPlanV2.isStoredPlan(e.plan)]).toEqual([what, id, true]);
    if (oCopies.holdsAmounts(e.plan)) expect([what, id, typeof e.currency]).toEqual([what, id, 'string']);
  }
  const mine = entries.get(main)!;
  const before = { id: main, plan: oCopies.withFacts(mine.plan, f), currency: oCopies.holdsAmounts(mine.plan) ? mine.currency : null, updated_at: mine.updatedAt };
  // Its GET answers no tax facts or choices, which it holds without showing.
  const { tax_facts: _facts, tax: _tax, ...answered } = await (await planRoute.GET()).json();
  expect([what, answered]).toEqual([what, before]);
  return entries;
}

describe('the release before reads every plan this release writes', () => {
  test('your plan’s first entry, made by a save, a New copy or a Try it, with the facts', async () => {
    const firsts: [string, () => Promise<unknown>][] = [
      ['a save', () => save({ ...TYPED, partnerAge: 38 }, null, DEFAULTS)],
      ['a save with nothing typed', () => save({ ...DEFAULT_PLAN_V2, age: 34 }, null, DEFAULTS, null)],
      ['a New copy', () => plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...DEFAULT_PLAN_V2, targetAge: 52 }, currency: null })],
      ['a Try it', () => plans('POST', { from: MAIN_ID, name: 'A child', plan: { ...DEFAULT_PLAN_V2, items: [child] }, currency: 'EUR' })],
    ];
    for (const [what, first] of firsts) {
      fake.reset();
      await registerTestContainer(fake);
      expect([what, ((await first()) as { status: number }).status]).toEqual([what, 200]);
      await readsAll(MAIN_ID, what);
    }
  });

  test('a copy’s every change, an Also save over two plans, your plan’s currency, and a copy made your plan', async () => {
    const main = ok(await save(TYPED, null, DEFAULTS)).updated_at as string;
    const x = ok(await plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' })).plan;
    await readsAll(MAIN_ID, 'New copy');
    const kid = ok(await plans('POST', { from: MAIN_ID, name: 'A child', plan: { ...TYPED, items: [income, child] }, currency: 'USD' })).plan;
    await readsAll(MAIN_ID, 'Try it');
    const blank = ok(await plans('POST', { from: MAIN_ID, name: 'Blank', plan: DEFAULT_PLAN_V2, currency: null })).plan;
    await readsAll(MAIN_ID, 'a copy with nothing typed');

    const also = ok(
      await plans('PUT', {
        saves: [
          { id: MAIN_ID, plan: { ...TYPED, age: 41, spending: 41_000 }, currency: 'USD', based_on: main },
          { id: x.id, plan: { ...TYPED, age: 41, targetAge: 52, spending: 41_000 }, currency: 'USD', based_on: x.updated_at },
        ],
        facts_were: factsOf(TYPED),
      })
    );
    const entries = await readsAll(MAIN_ID, 'Also save');
    expect([entries.get(MAIN_ID)!.updatedAt, entries.get(x.id)!.updatedAt]).toEqual(also.plans.map((p: { updated_at: string }) => p.updated_at));

    const typed = ok(await plans('PUT', { saves: [{ id: blank.id, plan: { ...DEFAULT_PLAN_V2, age: 41, fiNumber: 1_200_000 }, currency: 'GBP', based_on: blank.updated_at }], facts_were: factsOf({ ...TYPED, age: 41 }) }));
    expect((await readsAll(MAIN_ID, 'first amounts in a copy')).get(blank.id)!.currency).toBe('GBP');

    const renamed = ok(await plans('PATCH', { id: x.id, name: 'Stop at 53', based_on: also.plans[1].updated_at })).plan;
    await readsAll(MAIN_ID, 'rename');
    const relabelled = ok(await plans('PATCH', { id: x.id, currency: 'EUR', based_on: renamed.updated_at })).plan;
    expect((await readsAll(MAIN_ID, 'relabel')).get(x.id)!.currency).toBe('EUR');
    ok(await plans('DELETE', { id: kid.id, based_on: kid.updated_at }));
    expect([...(await readsAll(MAIN_ID, 'delete')).keys()].sort()).toEqual([MAIN_ID, x.id, blank.id].sort());
    ok(await call(planRoute.POST, 'fire-plan', 'POST', { currency: 'CAD', amounts: typedAmounts({ ...TYPED, age: 41, spending: 41_000 }), answered: true }));
    expect((await readsAll(MAIN_ID, 'your plan’s currency')).get(MAIN_ID)!.currency).toBe('CAD');

    ok(await plans('PATCH', { main: x.id, based_on: relabelled.updated_at }));
    await readsAll(x.id, 'make main');
    ok(await plans('DELETE', { id: MAIN_ID, based_on: (await firePlansStore.get(ctx, MAIN_ID))!.updatedAt }));
    expect([...(await readsAll(x.id, 'the plan that was yours deleted')).keys()].sort()).toEqual([x.id, blank.id].sort());
    expect(typed.main.id).toBe(MAIN_ID);
  });

  test('your plan saved over and over, from generated plans of every shape version 2 holds', async () => {
    let based: string | null = null;
    let facts = DEFAULTS;
    let saved = 0;
    for (let seed = 9600; seed < 9680; seed++) {
      const g = rand(seed);
      const v2 = planOf(genPlan(g, seed % 3 === 0));
      const plan: FirePlanV2 = {
        ...v2,
        items: [...v2.items, ...genEvents(g, `e${seed}-`).slice(0, 3).map(itemFromEvent)],
        partnerAge: g.chance(0.3) ? g.int(22, 70) : null,
        stopAtFi: g.chance(0.3),
        fiNumber: g.chance(0.2) ? g.int(500, 3000) * 1000 : null,
        ...(g.chance(0.3) ? { lastsIn: g.pick([...LASTS_IN_CHOICES]) } : {}),
      };
      const r = await save(plan, based, facts, g.chance(0.5) ? 'USD' : null);
      if (r.status !== 200) {
        // What today's rules refuse, or first amounts with no currency: nothing written.
        expect([seed, r.status === 400 || r.body.error?.startsWith('Say which currency')]).toEqual([seed, true]);
        continue;
      }
      saved++;
      based = r.body.updated_at;
      facts = factsOf(r.body.plan);
      await readsAll(MAIN_ID, `seed ${seed}`);
    }
    expect(saved).toBeGreaterThan(30);
  });

  test('items of every kind on every anchor, the stop at FI and your own FI number', async () => {
    const mk = (id: string, kind: PlanItem['kind'], from: PlanItem['from'], set: Partial<PlanItem>): PlanItem => ({
      id,
      label: id,
      kind,
      from,
      until: null,
      once: null,
      yearly: null,
      replaces: null,
      every: null,
      times: null,
      inflationAdjusted: true,
      owner: null,
      beforeTax: false,
      ...set,
    });
    const at = (age: number) => ({ anchor: { at: 'age' as const, age }, offset: 0 });
    const items: PlanItem[] = [
      mk('ss', 'social-security', at(67), { yearly: 18_000, owner: 'partner', beforeTax: true }),
      mk('pension', 'pension', { anchor: { at: 'stop' }, offset: 5 }, { yearly: 12_000, inflationAdjusted: false, owner: 'you' }),
      mk('pt', 'part-time', { anchor: { at: 'stop' }, offset: 0 }, { until: at(60), yearly: 24_000, replaces: 0, beforeTax: true, owner: 'you' }),
      mk('other', 'other-income', { anchor: { at: 'fi' }, offset: 0 }, { until: { years: 10 }, yearly: 5_000 }),
      mk('home', 'home', at(45), { once: 100_000, yearly: -6_000 }),
      mk('kid', 'child', at(42), { until: { years: 18 }, yearly: 10_000 }),
      mk('car', 'car', { anchor: { at: 'fi' }, offset: -1 }, { once: 40_000, every: 8, times: 3 }),
      mk('travel', 'spending', { anchor: { at: 'balance', amount: 2_000_000 }, offset: 0 }, { yearly: 10_000 }),
      mk('loan', 'loan-end', { anchor: { at: 'item', id: 'home', edge: 'start' }, offset: 10 }, { yearly: 6_000 }),
      mk('job', 'pay', at(45), { until: { anchor: { at: 'item', id: 'pt', edge: 'start' }, offset: 0 }, yearly: -20_000, owner: 'you' }),
      mk('gift', 'windfall', at(60), { once: 50_000 }),
      mk('roof', 'one-off', { anchor: { at: 'stop' }, offset: 2 }, { once: 30_000 }),
    ];
    const plan: FirePlanV2 = { ...TYPED, partnerAge: 38, items };
    const main = ok(await save(plan, null, DEFAULTS)).updated_at as string;
    let entries = await readsAll(MAIN_ID, 'every kind');
    expect((entries.get(MAIN_ID)!.plan as FirePlanV2).items).toEqual(items);
    const facts = factsOf(plan);
    ok(await save({ ...plan, stopAtFi: true, fiNumber: 1_500_000 }, main, facts));
    entries = await readsAll(MAIN_ID, 'the stop at FI and your own FI number');
    const saved = entries.get(MAIN_ID)!.plan as FirePlanV2;
    expect([saved.stopAtFi, saved.fiNumber]).toEqual([true, 1_500_000]);
    ok(await plans('POST', { from: MAIN_ID, name: 'Part-time work when you stop', plan: { ...plan, items: items.slice(0, 3) }, currency: 'USD' }));
    await readsAll(MAIN_ID, 'a Try it with items on anchors');
  });

  test('your FI date as the earliest stop that lasts, on your plan and on a copy, and off again', async () => {
    const main = ok(await save({ ...TYPED, lastsIn: 0.95 }, null, DEFAULTS)).updated_at as string;
    let entries = await readsAll(MAIN_ID, 'your plan at 95%');
    expect((entries.get(MAIN_ID)!.plan as FirePlanV2).lastsIn).toBe(0.95);
    const copy = ok(await plans('POST', { from: MAIN_ID, name: 'At 80%', plan: { ...TYPED, lastsIn: 0.8 }, currency: 'USD' })).plan;
    entries = await readsAll(MAIN_ID, 'a copy at 80%');
    expect((entries.get(copy.id)!.plan as FirePlanV2).lastsIn).toBe(0.8);
    ok(await save(TYPED, main, factsOf(TYPED)));
    entries = await readsAll(MAIN_ID, 'your plan back to when you reach it');
    expect(Object.hasOwn(entries.get(MAIN_ID)!.plan, 'lastsIn')).toBe(false);
  });

  test('a saved plan of version 2, as this release’s saved plan route stores it', async () => {
    for (const plan of [TYPED, { ...TYPED, stopAtFi: true, targetAge: null, items: [income, child] }, { ...DEFAULT_PLAN_V2, partnerAge: 38, fiNumber: 900_000 }, { ...TYPED, lastsIn: 0.9 }]) {
      const body = { saved: { plan, savings: 20_000, currency: 'USD', inflation: 0.03 }, based_on: (await savedPlanStore.get(ctx))?.rev ?? null };
      expect((await call(savedRoute.PUT, 'saved-plan', 'PUT', body)).status).toBe(200);
      expect(oSaved.isSavedPlan(await savedPlanStore.get(ctx))).toBe(true);
    }
  });
});

describe('the tax facts this release writes, as the release before reads them', () => {
  const OP = { kind: 'account', account_id: 'acc_529', owner: 'partner', basis: 12_000, count: true };
  const ROTH = { kind: 'roth', owner: 'you', amount: 45_000 };
  const give = (op: unknown) => call(factsRoute.POST, 'plan-facts', 'POST', op);

  /** `plan-facts` as its store reads it, opened. */
  async function storedFacts(): Promise<PlanFacts> {
    const { facts } = await readAsBefore();
    expect(oCopies.isPlanFacts(facts)).toBe(true);
    return facts as PlanFacts;
  }

  test('beside your plan: version 2 reads, and your plan with it', async () => {
    ok(await save({ ...TYPED, partnerAge: 38 }, null, DEFAULTS));
    ok(await give(OP));
    await readsAll(MAIN_ID, 'an account’s change');
    ok(await give(ROTH));
    await readsAll(MAIN_ID, 'a Roth’s change');
    const facts = await storedFacts();
    expect(facts.version).toBe(2);
    expect(facts).toMatchObject({ age: 40, partnerAge: 38, main: MAIN_ID });
  });

  test('alone, with no plan saved: it reads them, and has no plan to show', async () => {
    ok(await give(OP));
    const { entries, refused } = await readAsBefore();
    expect([entries.size, refused]).toEqual([0, []]);
    expect((await storedFacts()).version).toBe(2);
    expect(oCopies.mainOf(await storedFacts(), { entries, unreadable: [], unrecognised: [] })).toBeNull();
  });

  test('a save it makes over them keeps them: the fields it replaces are the five every plan holds', async () => {
    ok(await save(TYPED, null, DEFAULTS));
    ok(await give(OP));
    const facts = await storedFacts();
    const { entries } = await readAsBefore();
    // lib/plan-writes.ts at TF: { ...base, ...to }, `to` the plan's facts.
    const saved = { ...facts, ...oCopies.factsOf(oCopies.withFacts(entries.get(MAIN_ID)!.plan, { ...oCopies.factsOf(TYPED), age: 44 })) };
    expect(oCopies.isPlanFacts(saved)).toBe(true);
    expect(saved).toMatchObject({ version: 2, age: 44, main: MAIN_ID });
    expect(saved.version === 2 && saved.tax).toEqual(facts.version === 2 && facts.tax);
  });
});

describe('what the detailed model writes, as the release before reads it', () => {
  const give = (op: unknown) => call(factsRoute.POST, 'plan-facts', 'POST', op);
  const HOUSEHOLD = { filing: 'joint', birthYears: [{ owner: 'you', year: 1986 }, { owner: 'partner', year: 1987 }], dependents: [{ id: 'd1', untilAge: 55 }], paidToday: { kind: 'tag', name: 'Health' } };
  const NONE = { filing: null, birthYears: [], dependents: [], paidToday: null };
  const CHOICES = {
    version: 1,
    state: null,
    stateRate: 0,
    inflation: 0.03,
    health: { beforeMedicare: null, medicareExtra: 0, meetsMedicaidRule: [], countMedicaid: false, acaLaw: '2026', growth: null },
    strategy: { order: 'standard', conversions: { kind: 'none' }, convertUntil: null },
    savingsSplit: null,
    taxableYield: null,
  };
  const health = (over: object) => ({ ...CHOICES, health: { ...CHOICES.health, ...over } });
  const EVERY = [
    CHOICES,
    { ...CHOICES, state: 'NV' },
    { ...CHOICES, state: 'CO', stateRate: 0.044, inflation: 0.025, taxableYield: 0.02 },
    { ...CHOICES, savingsSplit: [{ bucket: 'taxable', share: 0.25 }, { bucket: 'tax-deferred', share: 0.25 }, { bucket: 'roth', share: 0.25 }, { bucket: 'hsa', share: 0.25 }] },
    health({ beforeMedicare: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null } }),
    health({ beforeMedicare: { kind: 'aca', adult: 11_000, quotedAge: 50, child: 3_000 }, acaLaw: 'enhanced' }),
    health({ beforeMedicare: { kind: 'other', yearly: 6_000 }, medicareExtra: 2_400 }),
    health({ meetsMedicaidRule: ['you', 'partner'], countMedicaid: true, growth: 0.015 }),
    // Every order and rule, and an age to run until.
    { ...CHOICES, strategy: { order: 'roth-before-deferred', conversions: { kind: 'none' }, convertUntil: null } },
    ...[0.1, 0.12, 0.22, 0.24].map((top) => ({ ...CHOICES, strategy: { order: 'standard', conversions: { kind: 'bracket', top }, convertUntil: null } })),
    ...[0.12, 0.22].map((top) => ({ ...CHOICES, strategy: { order: 'roth-before-deferred', conversions: { kind: 'aca-then-bracket', top }, convertUntil: 64 } })),
    { ...CHOICES, strategy: { order: 'standard', conversions: { kind: 'fixed', yearly: 40_000 }, convertUntil: 70 } },
  ];
  test('the opt-in: every entry, the model, and the plan it reads', async () => {
    ok(await save(TYPED, null, DEFAULTS));
    ok(await plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' }));
    ok(await give({ kind: 'opt-in' }));
    const entries = await readsAll(MAIN_ID, 'opted in');
    expect([...entries.values()].every((e) => e.tax !== null)).toBe(true);
    const { facts } = await readAsBefore();
    expect((facts as Extract<PlanFacts, { version: 2 }>).tax.model).toBe('detailed');
    ok(await give({ kind: 'model', model: 'flat' }));
    await readsAll(MAIN_ID, 'back to flat');
  });

  test('the opt-in with no plan saved: your plan’s entry it made, at your stop age', async () => {
    ok(await give({ kind: 'opt-in' }));
    const entries = await readsAll(MAIN_ID, 'opted in with none');
    expect(entries.get(MAIN_ID)!.plan.start).toBe('at-stop');
  });

  test('choices of every shape this writer takes', async () => {
    let stamp = (ok(await save(TYPED, null, DEFAULTS)) as { updated_at: string }).updated_at;
    for (const tax of EVERY) {
      stamp = (ok(await save(TYPED, stamp, factsOf(TYPED), 'USD', { tax })) as { updated_at: string }).updated_at;
      const entries = await readsAll(MAIN_ID, JSON.stringify(tax));
      expect(entries.get(MAIN_ID)!.tax as unknown).toEqual(tax);
    }
  });

  test('a copy made with a rule of its own: an entry to it, with that rule, and your plan’s stays', async () => {
    const stamp = (ok(await save(TYPED, null, DEFAULTS)) as { updated_at: string }).updated_at;
    ok(await save(TYPED, stamp, factsOf(TYPED), 'USD', { tax: CHOICES }));
    const rule = { ...CHOICES, strategy: { order: 'standard', conversions: { kind: 'fixed', yearly: 40_000 }, convertUntil: null } };
    const made = ok(await plans('POST', { from: MAIN_ID, name: '$40,000 a year', plan: TYPED, currency: 'USD', tax: rule })) as { plan: { id: string } };
    const entries = await readsAll(MAIN_ID, 'a copy with a rule');
    expect(entries.get(made.plan.id)!.tax as unknown).toEqual(rule);
    expect(entries.get(made.plan.id)!.currency).toBe('USD');
    expect(entries.get(MAIN_ID)!.tax as unknown).toEqual(CHOICES);
  });

  test('a save beside a rule goes through its own writer, and so does a change of rule within its ranges', async () => {
    const stamp = (ok(await save(TYPED, null, DEFAULTS)) as { updated_at: string }).updated_at;
    const rule = { ...CHOICES, strategy: { order: 'standard', conversions: { kind: 'bracket', top: 0.12 }, convertUntil: 60 } };
    ok(await save(TYPED, stamp, factsOf(TYPED), 'USD', { tax: rule }));
    const stored = (await readsAll(MAIN_ID, 'with a rule')).get(MAIN_ID)!.tax!;
    expect('choices' in oChoices.parseTaxChoices({ ...rule, stateRate: 0.05 }, stored)).toBe(true);
    // Since T4 it runs the rules: a change of rule is its own save, held to its ranges.
    expect('choices' in oChoices.parseTaxChoices({ ...rule, strategy: { ...rule.strategy, convertUntil: 61 } }, stored)).toBe(true);
    expect('error' in oChoices.parseTaxChoices({ ...rule, strategy: { ...rule.strategy, convertUntil: 101 } }, stored)).toBe(true);
  });

  test('a household on a save and on a first save, its dependents and what pays for coverage', async () => {
    ok(await save(TYPED, null, DEFAULTS, 'USD', { household: HOUSEHOLD, household_were: NONE }));
    await readsAll(MAIN_ID, 'first save');
    const { facts } = await readAsBefore();
    expect((facts as Extract<PlanFacts, { version: 2 }>).tax).toMatchObject(HOUSEHOLD);
    const stamp = (ok(await planRoute.GET().then(async (r) => ({ status: r.status, body: await r.json() }))) as { updated_at: string }).updated_at;
    ok(await save(TYPED, stamp, factsOf(TYPED), 'USD', { household: { ...HOUSEHOLD, filing: 'single', paidToday: { kind: 'category', name: 'Health' } }, household_were: HOUSEHOLD }));
    await readsAll(MAIN_ID, 'a later save');
  });

  test('a plan on at-stop, and a copy of it', async () => {
    const stamp = (ok(await save(TYPED, null, DEFAULTS)) as { updated_at: string }).updated_at;
    const at = { ...TYPED, start: 'at-stop' };
    ok(await save(at as FirePlanV2, stamp, factsOf(TYPED)));
    ok(await plans('POST', { from: MAIN_ID, name: 'Copy', plan: at, currency: 'USD' }));
    const entries = await readsAll(MAIN_ID, 'at-stop');
    expect([...entries.values()].map((e) => e.plan.start)).toEqual(['at-stop', 'at-stop']);
  });

  test('a benchmark alone: it reads the plan, with no amount it knows of', async () => {
    const blank = { ...DEFAULT_PLAN_V2, age: 40 };
    ok(await save(blank, null, DEFAULTS, 'USD', { tax: EVERY[4] }));
    const { entries, refused } = await readAsBefore();
    expect(refused).toEqual([]);
    expect(entries.get(MAIN_ID)!.currency).toBe('USD');
    expect(oCopies.holdsAmounts(entries.get(MAIN_ID)!.plan)).toBe(false);
  });
});

describe('a download this release makes, as the release before’s restore reads it', () => {
  test('every part is one it knows, every header part it needs is there, and each store part is of the kind it reads', async () => {
    ok(await save(TYPED, null, DEFAULTS));
    ok(await plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' }));
    const keys = Object.keys(buildUserExport(await collectUserData({ ctx, userId: null }), new Date('2026-11-04T12:00:00.000Z')));
    expect(keys).toContain('fire-plans');
    expect(keys.filter((k) => !oParts.isKnownPart(k))).toEqual([]);
    expect(oParts.HEADER_PARTS.filter((p) => !keys.includes(p))).toEqual([]);
    const shared = Object.keys(SEAM).filter((name) => Object.hasOwn(oParts.SEAM, name));
    expect(shared.length).toBeGreaterThan(30);
    for (const name of shared) expect([name, SEAM[name].kind]).toEqual([name, oParts.SEAM[name].kind]);
  });
});

describe('emptying an account', () => {
  test('takes both stores away, as every store', async () => {
    ok(await save(TYPED, null, DEFAULTS));
    ok(await plans('POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' }));
    await emptyAccount(ctx, { userId: null });
    expect([await fake.type(ctxKey('fire-plans')), await fake.type(ctxKey('plan-facts'))]).toEqual(['none', 'none']);
    expect([await firePlansStore.count(ctx), await planFactsStore.get(ctx)]).toEqual([0, null]);
  });
});
