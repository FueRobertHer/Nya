import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import type { Txn } from '@/components/MonthBreakdown';
import type { FirePlan } from '@/lib/fire/plan';

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { StoredDataUnreadableError } = await import('@/lib/stored-json');
const { getFirePlan, setFirePlan } = await import('@/lib/fire-plan');
const route = await import('@/app/api/fire-plan/route');
const { classify } = await import('@/lib/reencrypt');
const { DEFAULT_PLAN, enginePlan, fiView, parsePlan, planYears, startAge } = await import('@/lib/fire/plan');
const { trailingFlows, investedAssets, TRAILING_DAYS } = await import('@/lib/fire/inputs');
const { fiNumber, yearsToTarget, coastFiNumber } = await import('@/lib/fire/fi');

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
});

const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });

describe('the stored plan’s validation', () => {
  test('the defaults are a valid plan, and a valid plan comes back as it went in', () => {
    expect(parsePlan(DEFAULT_PLAN)).toEqual({ plan: DEFAULT_PLAN });
    const full = plan({
      age: 35,
      targetAge: 50,
      spending: 48_000,
      savings: -1_000,
      assets: 250_000,
      includeCash: true,
      start: 'custom',
      startBalance: 900_000,
      horizon: 45,
      income: [{ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true }],
      expenses: [{ id: 'roof', label: 'Roof', amount: 30_000, atAge: 60 }],
    });
    expect(parsePlan(JSON.parse(JSON.stringify(full)))).toEqual({ plan: full });
  });

  test('labels are trimmed', () => {
    const r = parsePlan(plan({ expenses: [{ id: 'a', label: '  Car  ', amount: 1, atAge: 40 }] }));
    expect('plan' in r && r.plan.expenses[0].label).toBe('Car');
  });

  const bad: [string, unknown][] = [
    ['not an object', 'plan'],
    ['a list', []],
    ['null', null],
    ['another version', { ...DEFAULT_PLAN, version: 2 }],
    ['an unknown field', { ...DEFAULT_PLAN, extra: 1 }],
    ['a missing field', (() => { const { fee: _, ...rest } = DEFAULT_PLAN; return rest; })()],
    ['a fractional age', { ...DEFAULT_PLAN, age: 35.5 }],
    ['an age out of range', { ...DEFAULT_PLAN, age: 12 }],
    ['an age as text', { ...DEFAULT_PLAN, age: '35' }],
    ['negative spending', { ...DEFAULT_PLAN, spending: -1 }],
    ['absurd spending', { ...DEFAULT_PLAN, spending: 1e12 }],
    ['NaN savings', { ...DEFAULT_PLAN, savings: NaN }],
    ['infinite assets', { ...DEFAULT_PLAN, assets: Infinity }],
    ['a withdrawal rate of zero', { ...DEFAULT_PLAN, withdrawalRate: 0 }],
    ['a withdrawal rate as a percent', { ...DEFAULT_PLAN, withdrawalRate: 4 }],
    ['a tax rate over 60%', { ...DEFAULT_PLAN, taxRate: 0.7 }],
    ['an unknown method', { ...DEFAULT_PLAN, method: 'guess' }],
    ['an unknown rule', { ...DEFAULT_PLAN, rule: 'yolo' }],
    ['an unknown start', { ...DEFAULT_PLAN, start: 'later' }],
    ['a custom start with no balance', { ...DEFAULT_PLAN, start: 'custom', startBalance: null }],
    ['a horizon over 60 years', { ...DEFAULT_PLAN, horizon: 61 }],
    ['an allocation over 100%', { ...DEFAULT_PLAN, stocksPct: 80, bondsPct: 30 }],
    ['a fractional percent', { ...DEFAULT_PLAN, stocksPct: 75.5 }],
    ['an unknown rebalancing', { ...DEFAULT_PLAN, rebalance: 'daily' }],
    ['a fee over 3%', { ...DEFAULT_PLAN, fee: 0.05 }],
    ['a floor over 1', { ...DEFAULT_PLAN, floor: 1.1 }],
    ['a ceiling under 1', { ...DEFAULT_PLAN, ceiling: 0.9 }],
    ['a boolean as text', { ...DEFAULT_PLAN, includeCash: 'yes' }],
    ['too many incomes', { ...DEFAULT_PLAN, income: Array.from({ length: 6 }, (_, i) => ({ id: `i${i}`, label: 'x', amount: 1, fromAge: 60, inflationAdjusted: true })) }],
    ['an income with an extra field', { ...DEFAULT_PLAN, income: [{ id: 'a', label: 'x', amount: 1, fromAge: 60, inflationAdjusted: true, note: 'x' }] }],
    ['an income with an empty label', { ...DEFAULT_PLAN, income: [{ id: 'a', label: '  ', amount: 1, fromAge: 60, inflationAdjusted: true }] }],
    ['an income with a long label', { ...DEFAULT_PLAN, income: [{ id: 'a', label: 'x'.repeat(61), amount: 1, fromAge: 60, inflationAdjusted: true }] }],
    ['an income with a bad id', { ...DEFAULT_PLAN, income: [{ id: 'a b', label: 'x', amount: 1, fromAge: 60, inflationAdjusted: true }] }],
    ['a negative expense', { ...DEFAULT_PLAN, expenses: [{ id: 'a', label: 'x', amount: -5, atAge: 60 }] }],
    ['an expense at a fractional age', { ...DEFAULT_PLAN, expenses: [{ id: 'a', label: 'x', amount: 5, atAge: 60.5 }] }],
    ['too many expenses', { ...DEFAULT_PLAN, expenses: Array.from({ length: 11 }, (_, i) => ({ id: `e${i}`, label: 'x', amount: 1, atAge: 60 })) }],
    ['repeated ids', { ...DEFAULT_PLAN, income: [{ id: 'a', label: 'x', amount: 1, fromAge: 60, inflationAdjusted: true }], expenses: [{ id: 'a', label: 'y', amount: 1, atAge: 60 }] }],
  ];
  for (const [name, value] of bad) {
    test(`refuses ${name}`, () => {
      expect('error' in parsePlan(value)).toBe(true);
    });
  }
});

describe('the FI view', () => {
  const measured = { spending: 40_000, savings: 30_000, assets: 200_000 };

  test('uses what Nya measured, and says so', () => {
    const v = fiView(plan({ age: 35, targetAge: 55 }), measured);
    expect(v.spending).toEqual({ value: 40_000, source: 'measured' });
    expect(v.fiNumber).toBeCloseTo(1_000_000, 6);
    expect(v.progress).toBeCloseTo(0.2, 9);
    expect(v.yearsToFi).toBeCloseTo(yearsToTarget(200_000, 30_000, 0.05, 1_000_000), 9);
    expect(v.fiAge).toBeCloseTo(35 + v.yearsToFi!, 9);
    expect(v.coast!.number).toBeCloseTo(coastFiNumber(1_000_000, 0.05, 20), 6);
    expect(v.coast!.reached).toBe(false);
    expect(v.barista).toBeNull();
  });

  test('a typed figure wins over the measured one, and says so', () => {
    const v = fiView(plan({ spending: 60_000, taxRate: 0.2 }), measured);
    expect(v.spending).toEqual({ value: 60_000, source: 'typed' });
    expect(v.fiNumber).toBeCloseTo(fiNumber(60_000, 0.04, 0.2), 6);
  });

  test('nothing to measure and nothing typed leaves the figures empty, not zero', () => {
    const v = fiView(plan(), { spending: null, savings: null, assets: null });
    expect(v.spending.source).toBe('none');
    expect(v.fiNumber).toBeNull();
    expect(v.yearsToFi).toBeNull();
    expect(v.progress).toBeNull();
    expect(v.coast).toBeNull();
  });

  test('Barista FI appears with part-time income', () => {
    const v = fiView(plan({ partTimeIncome: 20_000 }), measured);
    expect(v.barista!.number).toBeCloseTo(500_000, 6);
    expect(v.barista!.yearsTo).toBeCloseTo(yearsToTarget(200_000, 30_000, 0.05, 500_000), 9);
  });

  test('already there is zero years, and never is Infinity, with no age to reach', () => {
    expect(fiView(plan({ age: 40 }), { spending: 40_000, savings: 0, assets: 2_000_000 }).yearsToFi).toBe(0);
    const never = fiView(plan({ age: 40, realReturn: 0 }), { spending: 40_000, savings: -1_000, assets: 100_000 });
    expect(never.yearsToFi).toBe(Infinity);
    expect(never.fiAge).toBeNull();
  });
});

describe('the engine plan', () => {
  const measured = { spending: 40_000, savings: 30_000, assets: 600_000 };

  test('starts with the FI number at the target age by default', () => {
    const p = plan({ age: 35, targetAge: 50 });
    const e = enginePlan(p, fiView(p, measured));
    if ('missing' in e) throw new Error('expected a plan');
    expect(e.sim.startBalance).toBeCloseTo(1_000_000, 6);
    expect(e.startAge).toBe(50);
    expect(e.sim.years).toBe(45); // to age 95
    expect(e.sim.rule).toEqual({ kind: 'constant', rate: 0.04 });
    expect(e.sim.allocation).toEqual({ stocks: 0.75, bonds: 0.25, cash: 0 });
  });

  test('or with today’s assets at today’s age, or a typed balance', () => {
    const today = plan({ age: 35, targetAge: 50, start: 'assets' });
    const e = enginePlan(today, fiView(today, measured));
    if ('missing' in e) throw new Error('expected a plan');
    expect(e.sim.startBalance).toBe(600_000);
    expect(e.startAge).toBe(35);
    expect(e.sim.years).toBe(60);
    const typed = plan({ start: 'custom', startBalance: 750_000, horizon: 40 });
    const t = enginePlan(typed, fiView(typed, measured));
    if ('missing' in t) throw new Error('expected a plan');
    expect(t.sim.startBalance).toBe(750_000);
    expect(t.sim.years).toBe(40);
  });

  test('says what is missing instead of guessing a balance', () => {
    const none = { spending: null, savings: null, assets: null };
    expect(enginePlan(plan(), fiView(plan(), none))).toEqual({ missing: 'spending' });
    const p = plan({ start: 'assets' });
    expect(enginePlan(p, fiView(p, none))).toEqual({ missing: 'assets' });
  });

  test('a plan runs to 95, within 10 to 60 years, or 30 years without an age', () => {
    expect(planYears(plan())).toBe(30);
    expect(planYears(plan({ targetAge: 90 }))).toBe(10);
    expect(planYears(plan({ targetAge: 30 }))).toBe(60);
    expect(planYears(plan({ targetAge: 30, horizon: 25 }))).toBe(25);
    expect(startAge(plan({ age: 40 }))).toBe(40); // no target age: today's
    expect(startAge(plan({ targetAge: 55, start: 'assets' }))).toBe(55); // no age: the target
  });

  test('places income and one-offs by age, and leaves out what it cannot place', () => {
    const p = plan({
      targetAge: 50,
      income: [
        { id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true },
        { id: 'pension', label: 'Pension', amount: 10_000, fromAge: 45, inflationAdjusted: false },
      ],
      expenses: [
        { id: 'roof', label: 'Roof', amount: 30_000, atAge: 60 },
        { id: 'old', label: 'Before the plan', amount: 1, atAge: 49 },
        { id: 'late', label: 'After the plan', amount: 1, atAge: 95 },
      ],
    });
    const e = enginePlan(p, fiView(p, measured));
    if ('missing' in e) throw new Error('expected a plan');
    expect(e.sim.income).toEqual([
      { amount: 24_000, fromYear: 17, inflationAdjusted: true },
      { amount: 10_000, fromYear: 0, inflationAdjusted: false }, // already being paid
    ]);
    expect(e.sim.oneOffs).toEqual([{ amount: 30_000, year: 10 }]);
    expect(e.left.expenses.map((x) => x.id)).toEqual(['old', 'late']);
    const ageless = plan({ income: p.income });
    const a = enginePlan(ageless, fiView(ageless, measured));
    if ('missing' in a) throw new Error('expected a plan');
    expect(a.sim.income).toEqual([]);
    expect(a.left.income).toHaveLength(2);
  });

  test('VPW expects the allocation’s return; floor and ceiling carry their bounds', () => {
    const vpw = plan({ rule: 'vpw', stocksPct: 60, bondsPct: 40 });
    const e = enginePlan(vpw, fiView(vpw, measured));
    if ('missing' in e) throw new Error('expected a plan');
    expect(e.sim.rule).toEqual({ kind: 'vpw', expectedReturn: 0.6 * 0.05 + 0.4 * 0.02 });
    const fc = plan({ rule: 'floor-ceiling', floor: 0.8, ceiling: 1.5 });
    const f = enginePlan(fc, fiView(fc, measured));
    if ('missing' in f) throw new Error('expected a plan');
    expect(f.sim.rule).toEqual({ kind: 'floor-ceiling', rate: 0.04, floor: 0.8, ceiling: 1.5 });
  });
});

let seq = 0;
function txn(over: Partial<Txn>): Txn {
  return {
    transaction_id: `t${++seq}`,
    date: '2026-09-01',
    name: 'Shop',
    amount: 10,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Bank',
    category: 'food and drink',
    iso_currency_code: 'USD',
    vendor_key: 'shop',
    logo_url: null,
    category_icon_url: null,
    subcategory: null,
    category_confidence: null,
    transaction_code: null,
    payment_channel: null,
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: null,
    region: null,
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
    ...over,
  };
}

describe('spending and savings from the trailing year', () => {
  const today = '2026-10-06';
  const yearAgo = '2025-10-07'; // the first day of the 365 ending today

  test('counts money out as spending and money in as income, by the Activity tab’s rule', () => {
    const r = trailingFlows(
      [
        txn({ date: yearAgo, amount: 100 }),
        txn({ date: '2026-03-01', amount: -5_000, category: 'income' }),
        txn({ date: '2026-10-06', amount: 50, pending: true }), // pending rows count, as there
        // None of these is spending or income:
        txn({ date: '2026-05-01', amount: 2_000, category: 'transfer out' }),
        txn({ date: '2026-05-02', amount: -2_000, category: 'transfer in' }),
        txn({ date: '2026-05-03', amount: 900, category: 'loan payments' }),
        txn({ date: '2026-05-04', amount: 300, category: 'general merchandise', transaction_code: 'transfer' }),
        txn({ date: '2026-05-05', amount: 200, category: 'other', transaction_code: 'atm' }),
      ],
      today
    )!;
    expect(r.spending).toBe(150);
    expect(r.income).toBe(5_000);
    expect(r.savings).toBe(4_850);
    expect(r.count).toBe(3);
    expect(r.scaled).toBe(false);
    expect(r.days).toBe(TRAILING_DAYS);
    expect(r.from).toBe(yearAgo);
  });

  test('leaves out what is older than a year, or dated after today', () => {
    const r = trailingFlows(
      [
        txn({ date: yearAgo, amount: 100 }),
        txn({ date: '2025-10-06', amount: 1_000 }), // 366 days ago, counting today
        txn({ date: '2026-10-07', amount: 1_000 }),
      ],
      today
    )!;
    expect(r.spending).toBe(100);
  });

  test('scales a shorter history up to a year, and says so', () => {
    // 100 days of history, today included.
    const r = trailingFlows([txn({ date: '2026-06-29', amount: 1_000 }), txn({ date: today, amount: 0 })], today)!;
    expect(r.days).toBe(100);
    expect(r.scaled).toBe(true);
    expect(r.spending).toBeCloseTo(1_000 * 3.65, 9);
  });

  test('gives no figure from under four weeks of history, or from transfers alone', () => {
    expect(trailingFlows([txn({ date: '2026-09-20', amount: 100 })], today)).toBeNull();
    expect(trailingFlows([txn({ date: yearAgo, amount: 100, category: 'transfer out' })], today)).toBeNull();
    expect(trailingFlows([], today)).toBeNull();
  });

  test('flags spending summed across currencies', () => {
    const r = trailingFlows([txn({ date: yearAgo, amount: 10 }), txn({ date: today, amount: 10, iso_currency_code: 'EUR' }), txn({ date: today, amount: 10 })], today)!;
    expect(r.currency).toBe('USD');
    expect(r.mixedCurrency).toBe(true);
  });
});

describe('invested assets', () => {
  const acct = (over: Partial<Parameters<typeof investedAssets>[0][number]>) => ({
    account_id: `a${++seq}`,
    name: 'Account',
    institution: 'Broker',
    type: 'investment',
    balance: 1_000,
    currency: 'USD',
    ...over,
  });

  test('sums investment accounts that are not hidden, never debts', () => {
    const r = investedAssets(
      [
        acct({ balance: 100_000 }),
        acct({ type: 'brokerage', balance: 50_000 }),
        acct({ balance: 999_999, hidden: true }),
        acct({ type: 'depository', balance: 20_000 }),
        acct({ type: 'credit', balance: 5_000 }),
        acct({ type: 'loan', balance: 300_000 }),
      ],
      false
    );
    expect(r.total).toBe(150_000);
    expect(r.accounts).toHaveLength(2);
  });

  test('counts checking and savings when asked', () => {
    expect(investedAssets([acct({ balance: 100_000 }), acct({ type: 'depository', balance: 20_000 })], true).total).toBe(120_000);
  });

  test('an account without a balance is counted as unknown, not as zero', () => {
    const r = investedAssets([acct({ balance: null }), acct({ balance: 5 })], false);
    expect(r.total).toBe(5);
    expect(r.unknown).toBe(1);
    expect(investedAssets([acct({ balance: null })], false).total).toBeNull();
    expect(investedAssets([], false).total).toBeNull();
  });
});

describe('the store', () => {
  const saved = plan({ age: 40, spending: 50_000 });

  test('never saved reads as null, and a plan round-trips', async () => {
    expect(await getFirePlan(TEST_CTX)).toBeNull();
    await setFirePlan(TEST_CTX, saved);
    expect(await getFirePlan(TEST_CTX)).toEqual(saved);
    // Encrypted: nothing of the plan is readable in the database.
    expect(String(await fake.get(ctxKey('fire-plan')))).not.toContain('50000');
  });

  test('a value that cannot be read, or is not a plan, is reported, never read as none', async () => {
    await fake.set(ctxKey('fire-plan'), 'not-ciphertext-at-all-but-long-enough');
    await expect(getFirePlan(TEST_CTX)).rejects.toBeInstanceOf(StoredDataUnreadableError);
    await fake.set(ctxKey('fire-plan'), await encrypt(JSON.stringify({ ...saved, version: 9 })));
    await expect(getFirePlan(TEST_CTX)).rejects.toBeInstanceOf(StoredDataUnreadableError);
  });

  test('saving over an unreadable value is refused, and it is left as it was', async () => {
    await fake.set(ctxKey('fire-plan'), 'unreadable-but-recoverable');
    await expect(setFirePlan(TEST_CTX, saved)).rejects.toBeInstanceOf(StoredDataUnreadableError);
    expect(await fake.get<string>(ctxKey('fire-plan'))).toBe('unreadable-but-recoverable');
  });

  test('is on the key inventory as a string of ciphertext', () => {
    expect(classify('fire-plan')).toBe('string');
    expect(classify(ctxKey('fire-plan').replace(/^[^:]+:(?=c:)/, ''))).toBe('string');
  });
});

describe('the route', () => {
  const put = (body: unknown) => route.PUT(new Request('http://x', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
  const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
    const orig = console.error;
    console.error = () => {};
    try {
      return await f();
    } finally {
      console.error = orig;
    }
  };

  test('loads null before anything is saved, then what was saved', async () => {
    expect(await (await route.GET()).json()).toEqual({ plan: null });
    const res = await put({ plan: plan({ age: 30 }) });
    expect(res.status).toBe(200);
    expect(await (await route.GET()).json()).toEqual({ plan: plan({ age: 30 }) });
  });

  test('refuses an invalid plan with the reason, and stores nothing', async () => {
    const res = await put({ plan: { ...DEFAULT_PLAN, withdrawalRate: 4 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('withdrawalRate');
    expect(await fake.get(ctxKey('fire-plan'))).toBeNull();
    expect((await put('{not json')).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put(null)).status).toBe(400);
  });

  test('an unreadable store is a flagged 409 on load and on save, and is left alone', async () => {
    await fake.set(ctxKey('fire-plan'), 'unreadable');
    const get = await quiet(() => route.GET());
    expect(get.status).toBe(409);
    expect(await get.json()).toMatchObject({ unreadable: true });
    const res = await quiet(() => put({ plan: DEFAULT_PLAN }));
    expect(res.status).toBe(409);
    expect(await fake.get<string>(ctxKey('fire-plan'))).toBe('unreadable');
  });

  test('a database failure is a 500 without the flag', async () => {
    fake.failNext('get');
    const res = await quiet(() => route.GET());
    expect(res.status).toBe(500);
    expect((await res.json()).unreadable).toBeUndefined();
  });
});
