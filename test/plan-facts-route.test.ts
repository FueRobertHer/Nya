import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { factsAbout } from './facts-about';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';
import type { PlanFacts } from '@/lib/fire/copies';
import type { TaxChoices } from '@/lib/fire/tax-choices';
import type { TaxFacts } from '@/lib/fire/tax-facts';

// The tax facts written (POST /api/plan-facts, lib/plan-writes.ts saveTaxFacts),
// through the routes on FakeRedis: one small change at a time, version 2 made
// from what is there, your plan's stamp untouched, the plan left new with none
// saved, the facts in every answer, and what the page may not send.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { firePlansStore, planFactsStore } = await import('@/lib/plan-copies');
const { DEFAULT_PLAN_V2 } = await import('@/lib/fire/plan-v2');
const { MAIN_ID, factsOf } = await import('@/lib/fire/copies');
const { DEFAULT_TAX_FACTS, MAX_FACT_ACCOUNTS, MAX_FACT_AMOUNT, parseTaxFactOp, applyTaxFactOp } = await import('@/lib/fire/tax-facts');
const planRoute = await import('@/app/api/fire-plan/route');
const plansRoute = await import('@/app/api/plans/route');
const inputsRoute = await import('@/app/api/plan-inputs/route');
const factsRoute = await import('@/app/api/plan-facts/route');
const { forgetAccountFacts } = await import('@/lib/plan-writes');
const { encrypt } = await import('@/lib/crypto');
const { UnreadableValueError } = await import('@/lib/repo');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

const ctx = TEST_CTX;
const TYPED: FirePlanV2 = { ...DEFAULT_PLAN_V2, age: 40, targetAge: 55, spending: 40_000 };
const DEFAULTS = factsOf(DEFAULT_PLAN_V2);
const DAMAGED = 'damaged-bytes-not-ciphertext-at-all';

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const req = (path: string, method: string, body?: unknown) => new Request(`http://localhost/api/${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }) });
const give = async (body: unknown) => json(await factsRoute.POST(req('plan-facts', 'POST', body)));
const get = async () => json(await planRoute.GET());
const save = async (plan: FirePlanV2, based_on: string | null, facts_were: unknown = DEFAULTS) => json(await planRoute.PUT(req('fire-plan', 'PUT', { plan, currency: 'USD', facts_were, based_on })));
const account = (account_id: string, over: Partial<{ owner: 'you' | 'partner'; basis: number | null; count: boolean }> = {}) => ({ kind: 'account', account_id, owner: 'you', basis: null, count: false, ...over });
const roth = (owner: 'you' | 'partner', amount: number | null) => ({ kind: 'roth', owner, amount });
const taxIn = (facts: PlanFacts | null): TaxFacts => {
  if (facts?.version !== 2) throw new Error('not version 2');
  return facts.tax;
};
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const error = console.error;
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.error = error;
  }
};

describe('with your plan saved', () => {
  test('makes version 2 from what is there, and answers your plan with them', async () => {
    const saved = await save({ ...TYPED, partnerAge: 38 }, null);
    const r = await give(account('acc_1', { owner: 'partner', basis: 105_000, count: true }));
    expect(r.status).toBe(200);
    const tax: TaxFacts = { ...DEFAULT_TAX_FACTS, owners: [{ account_id: 'acc_1', owner: 'partner' }], basis: [{ account_id: 'acc_1', amount: 105_000 }], countAnyway: ['acc_1'] };
    expect(r.body).toEqual({ ...saved.body, tax_facts: tax });
    const stored = (await planFactsStore.get(ctx))!;
    expect(stored).toMatchObject({ version: 2, main: MAIN_ID, age: 40, partnerAge: 38 });
    expect(taxIn(stored)).toEqual(tax);
    expect((await get()).body).toEqual({ ...saved.body, tax_facts: tax });
  });

  test('never touches your plan’s entry or its stamp, so a save from before still lands, and keeps them', async () => {
    const saved = await save(TYPED, null);
    const before = await fake.hgetall<Record<string, string>>(ctxKey('fire-plans'));
    expect((await give(roth('you', 45_000))).status).toBe(200);
    expect(await fake.hgetall<Record<string, string>>(ctxKey('fire-plans'))).toEqual(before);
    const next = await save({ ...TYPED, age: 41, spending: 41_000 }, saved.body.updated_at, factsOf(TYPED));
    expect(next.status).toBe(200);
    expect(next.body.tax_facts.rothContributions).toEqual([{ owner: 'you', amount: 45_000 }]);
    expect(await planFactsStore.get(ctx)).toMatchObject({ version: 2, age: 41 });
  });

  test('takes your plan’s own fields when `plan-facts` is missing', async () => {
    await save(TYPED, null);
    await planFactsStore.remove(ctx);
    expect((await give(roth('you', 1))).status).toBe(200);
    expect(await planFactsStore.get(ctx)).toMatchObject({ version: 2, age: 40, main: MAIN_ID });
  });

  test('names the plan that is yours, when another is', async () => {
    const saved = await save(TYPED, null);
    const copy = await json(await plansRoute.POST(req('plans', 'POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' })));
    const made = await json(await plansRoute.PATCH(req('plans', 'PATCH', { main: copy.body.plan.id, based_on: copy.body.plan.updated_at })));
    expect(made.status).toBe(200);
    const r = await give(roth('partner', 7));
    expect(r.body.id).toBe(copy.body.plan.id);
    expect(r.body.plan.targetAge).toBe(52);
    expect(await planFactsStore.get(ctx)).toMatchObject({ version: 2, main: copy.body.plan.id });
    expect(saved.status).toBe(200);
  });

  test('facts that can’t be read refuse it, as the plan read does', async () => {
    await save(TYPED, null);
    await fake.set(ctxKey('plan-facts'), DAMAGED);
    const r = await quiet(() => give(roth('you', 1)));
    expect(r.status).toBe(409);
    expect(r.body.unreadable).toBe(true);
    expect(await fake.get<string>(ctxKey('plan-facts'))).toBe(DAMAGED);
  });
});

describe('with no plan saved', () => {
  test('writes the facts alone: no entry, and the plan stays new', async () => {
    const r = await give(account('acc_529', { count: true }));
    expect(r.status).toBe(200);
    const tax = { ...DEFAULT_TAX_FACTS, countAnyway: ['acc_529'] };
    expect(r.body).toEqual({ id: MAIN_ID, plan: null, currency: null, updated_at: null, tax_facts: tax });
    expect(await firePlansStore.count(ctx)).toBe(0);
    expect((await get()).body).toEqual(r.body);
    const inputs = await json(await inputsRoute.GET(new Request('http://localhost/api/plan-inputs')));
    expect(inputs.body).toEqual({ ...r.body, plans: [] });
    expect(await planFactsStore.get(ctx)).toMatchObject({ version: 2, main: MAIN_ID, ...DEFAULTS });
  });

  test('damaged bytes there go, since nothing reads them', async () => {
    await fake.set(ctxKey('plan-facts'), DAMAGED);
    expect((await get()).body.tax_facts).toBeNull();
    const r = await give(roth('you', 3));
    expect(r.status).toBe(200);
    expect(r.body.tax_facts.rothContributions).toEqual([{ owner: 'you', amount: 3 }]);
  });

  test('your plan’s first save keeps them, in what is stored and in its answer', async () => {
    await give(account('acc_529', { count: true }));
    const r = await save(TYPED, null);
    expect(r.status).toBe(200);
    expect(r.body.tax_facts.countAnyway).toEqual(['acc_529']);
    expect((await planFactsStore.get(ctx))!).toMatchObject({ version: 2, age: 40 });
    expect((await get()).body.tax_facts.countAnyway).toEqual(['acc_529']);
  });

  test('a New copy as the first write keeps them too', async () => {
    await give(roth('you', 9));
    const r = await json(await plansRoute.POST(req('plans', 'POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...DEFAULT_PLAN_V2, targetAge: 52 }, currency: null })));
    expect(r.status).toBe(200);
    expect((await get()).body.tax_facts.rothContributions).toEqual([{ owner: 'you', amount: 9 }]);
  });
});

describe('each change', () => {
  test('replaces that account’s row, leaving the others', async () => {
    await give(account('a', { owner: 'partner', basis: 1, count: true }));
    await give(account('b', { owner: 'partner', basis: 2, count: true }));
    const r = await give(account('a', { owner: 'partner', basis: 3, count: true }));
    expect(r.body.tax_facts.owners).toEqual([
      { account_id: 'b', owner: 'partner' },
      { account_id: 'a', owner: 'partner' },
    ]);
    expect(r.body.tax_facts.basis).toEqual([
      { account_id: 'b', amount: 2 },
      { account_id: 'a', amount: 3 },
    ]);
    expect(r.body.tax_facts.countAnyway).toEqual(['b', 'a']);
  });

  test('what is the same as saying nothing leaves its list', async () => {
    await give(account('a', { owner: 'partner', basis: 1, count: true }));
    await give(roth('you', 5));
    const r = await give(account('a'));
    expect(r.body.tax_facts).toEqual({ ...DEFAULT_TAX_FACTS, rothContributions: [{ owner: 'you', amount: 5 }] });
    expect((await give(roth('you', null))).body.tax_facts).toEqual(DEFAULT_TAX_FACTS);
  });

  test('never writes the model, and keeps detailed where it is held', async () => {
    await save(TYPED, null);
    await planFactsStore.update(ctx, (cur) => ({ ...cur!, version: 2, tax: { ...DEFAULT_TAX_FACTS, model: 'detailed', filing: 'joint' } }));
    const r = await give(roth('you', 5));
    expect(r.body.tax_facts).toMatchObject({ model: 'detailed', filing: 'joint' });
    expect((await give({ ...roth('you', 5), model: 'flat' })).status).toBe(400);
  });

  test('over the limit is refused, and nothing is written', async () => {
    await planFactsStore.set(ctx, { version: 2, main: MAIN_ID, ...DEFAULTS, tax: { ...DEFAULT_TAX_FACTS, countAnyway: Array.from({ length: MAX_FACT_ACCOUNTS }, (_, i) => `a${i}`) } });
    const r = await give(account('one-more', { count: true }));
    expect(r.status).toBe(409);
    expect(r.body.error).toContain(String(MAX_FACT_ACCOUNTS));
    expect(taxIn(await planFactsStore.get(ctx)).countAnyway).not.toContain('one-more');
    expect((await give(account('a1', { count: true }))).status).toBe(200);
  });
});

describe('what the route refuses', () => {
  const refused: [string, unknown][] = [
    ['not JSON', '{'],
    ['a list', []],
    ['nothing', {}],
    ['another kind', { kind: 'model', model: 'detailed' }],
    ['an extra key', { ...account('a'), extra: 1 }],
    ['a missing key', { kind: 'account', account_id: 'a', owner: 'you', basis: null }],
    ['an id with a space', account('a b')],
    ['an empty id', account('')],
    ['a long id', account('a'.repeat(129))],
    ['__proto__', account('__proto__')],
    ['another owner', { ...account('a'), owner: 'them' }],
    ['a negative basis', account('a', { basis: -1 })],
    ['a huge basis', account('a', { basis: MAX_FACT_AMOUNT + 1 })],
    ['a text basis', { ...account('a'), basis: '1' }],
    ['a count that isn’t one', { ...account('a'), count: 'yes' }],
    ['a negative Roth', roth('you', -1)],
    ['a huge Roth', roth('you', MAX_FACT_AMOUNT + 1)],
    ['a Roth’s other owner', { kind: 'roth', owner: 'them', amount: 1 }],
    ['a Roth with an extra key', { ...roth('you', 1), account_id: 'a' }],
    ['a long body', `{"kind":"roth","owner":"you","amount":1${' '.repeat(3000)}}`],
  ];
  for (const [what, body] of refused) {
    test(what, async () => {
      const r = await give(body);
      expect([what, r.status]).toEqual([what, 400]);
      expect(await planFactsStore.get(ctx)).toBeNull();
    });
  }

  test('a poison, as restore’s probe sends one, at each key', () => {
    for (const key of ['kind', 'account_id', 'owner', 'basis', 'count']) {
      expect([key, 'op' in parseTaxFactOp({ ...account('a'), [key]: { '\u0000nya-restore-probe': true } })]).toEqual([key, false]);
    }
  });

  test('zero is an amount: a Roth nothing has gone into, a basis of nothing', () => {
    expect(applyTaxFactOp(DEFAULT_TAX_FACTS, { kind: 'roth', owner: 'you', amount: 0 }).rothContributions).toEqual([{ owner: 'you', amount: 0 }]);
    expect(applyTaxFactOp(DEFAULT_TAX_FACTS, { kind: 'account', account_id: 'a', owner: 'you', basis: 0, count: false }).basis).toEqual([{ account_id: 'a', amount: 0 }]);
  });
});

describe('accounts gone for good (forgetAccountFacts)', () => {
  test('everything said about them goes, and only that: other accounts, the Roth amounts and the rest of the facts stay', async () => {
    await planFactsStore.set(ctx, { ...factsAbout('gone', 'also-gone', 'stays'), main: 'x', age: 41 });
    await forgetAccountFacts(ctx, ['gone', 'also-gone']);
    expect(await planFactsStore.get(ctx)).toEqual({ ...factsAbout('stays'), main: 'x', age: 41 });
  });

  test('one said of in only one list goes from it', async () => {
    await planFactsStore.set(ctx, { version: 2, main: MAIN_ID, ...DEFAULTS, tax: { ...DEFAULT_TAX_FACTS, countAnyway: ['gone', 'stays'] } });
    await forgetAccountFacts(ctx, ['gone']);
    expect(taxIn(await planFactsStore.get(ctx)).countAnyway).toEqual(['stays']);
  });

  test('your plan’s stamp stays, so a page holding it can still save', async () => {
    const saved = await save(TYPED, null);
    await give(account('gone', { basis: 5 }));
    const before = await fake.hgetall<Record<string, string>>(ctxKey('fire-plans'));
    await forgetAccountFacts(ctx, ['gone']);
    expect(taxIn(await planFactsStore.get(ctx)).basis).toEqual([]);
    expect(await fake.hgetall<Record<string, string>>(ctxKey('fire-plans'))).toEqual(before);
    expect((await save({ ...TYPED, spending: 41_000 }, saved.body.updated_at, factsOf(TYPED))).status).toBe(200);
  });

  test('none of them named: nothing is written, so facts aren’t made, or made version 2', async () => {
    await forgetAccountFacts(ctx, ['gone']);
    expect(await fake.type(ctxKey('plan-facts'))).toBe('none');
    const version1: PlanFacts = { version: 1, main: MAIN_ID, ...DEFAULTS };
    await planFactsStore.set(ctx, version1);
    const bytes = await fake.get<string>(ctxKey('plan-facts'));
    await forgetAccountFacts(ctx, ['gone']);
    expect(await fake.get<string>(ctxKey('plan-facts'))).toBe(bytes);
    await planFactsStore.set(ctx, factsAbout('stays'));
    const named = await fake.get<string>(ctxKey('plan-facts'));
    await forgetAccountFacts(ctx, ['gone']);
    await forgetAccountFacts(ctx, []);
    expect(await fake.get<string>(ctxKey('plan-facts'))).toBe(named);
  });

  test('damaged bytes hold nothing to take out: they don’t stop a forget, and stay as they are', async () => {
    await fake.set(ctxKey('plan-facts'), DAMAGED);
    await forgetAccountFacts(ctx, ['gone']);
    expect(await fake.get<string>(ctxKey('plan-facts'))).toBe(DAMAGED);
  });

  test('facts this version doesn’t recognise may name it: they stop a forget, and stay as they are', async () => {
    const newer = await encrypt(ctx, '{"version":3}');
    await fake.set(ctxKey('plan-facts'), newer);
    await expect(forgetAccountFacts(ctx, ['gone'])).rejects.toBeInstanceOf(UnreadableValueError);
    expect(await fake.get<string>(ctxKey('plan-facts'))).toBe(newer);
  });
});

describe('a plan’s tax choices', () => {
  const CHOICES: TaxChoices = {
    version: 1,
    state: 'CO',
    stateRate: 0.04,
    inflation: 0.03,
    health: { beforeMedicare: null, medicareExtra: 0, meetsMedicaidRule: [], countMedicaid: false, acaLaw: '2026', growth: null },
    strategy: { order: 'standard', conversions: { kind: 'none' }, convertUntil: null },
    savingsSplit: null,
    taxableYield: null,
  };

  test('are read, kept by a save and a rename, and a new copy carries its source’s', async () => {
    const saved = await save(TYPED, null);
    const entry = (await firePlansStore.get(ctx, MAIN_ID))!;
    await firePlansStore.set(ctx, MAIN_ID, { ...entry, tax: CHOICES });
    const next = await save({ ...TYPED, spending: 41_000 }, saved.body.updated_at, factsOf(TYPED));
    expect(next.status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.tax).toEqual(CHOICES);
    const renamed = await json(await plansRoute.PATCH(req('plans', 'PATCH', { id: MAIN_ID, name: 'Mine', based_on: next.body.updated_at })));
    expect(renamed.status).toBe(200);
    expect((await firePlansStore.get(ctx, MAIN_ID))!.tax).toEqual(CHOICES);
    const copy = await json(await plansRoute.POST(req('plans', 'POST', { from: MAIN_ID, name: 'Stop at 52', plan: { ...TYPED, targetAge: 52 }, currency: 'USD' })));
    expect((await firePlansStore.get(ctx, copy.body.plan.id))!.tax).toEqual(CHOICES);
  });

  test('never reach the page: a plan’s answer holds none', async () => {
    await save(TYPED, null);
    const entry = (await firePlansStore.get(ctx, MAIN_ID))!;
    await firePlansStore.set(ctx, MAIN_ID, { ...entry, tax: CHOICES });
    expect(JSON.stringify((await get()).body)).not.toContain('stateRate');
    expect(JSON.stringify((await json(await plansRoute.GET())).body)).not.toContain('stateRate');
  });
});
