import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, ctxKey, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The goals route (#42): goals keep their four fields in the `goals` blob, as
// every release has, and their plans in the `goal-plans` store. Allocations
// never above the balance the server knows, whatever path a save takes; a
// save that stops part way never reads wrong; what the release before saves
// after a rollback leaves the plans consistent; a plan that can't be read is a
// 409, never "no plan".

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { saveManualAccount } = await import('@/lib/manual');
const { setAccountHidden } = await import('@/lib/hidden');
const { getGoals, setGoals } = await import('@/lib/goals');
const { goalPlansStore, readGoalRecords, writeGoalRecords } = await import('@/lib/goal-plans');
const { planGoalSave } = await import('@/lib/goal-save');
const { parseGoals } = await import('@/lib/goal-model');
const { knownGoalAccounts } = await import('@/lib/goal-flows');
const links = await import('@/lib/links');
const { markEnded, reopenAccount } = await import('@/lib/lifecycle');
const { dayLabel } = await import('@/lib/goal-text');
const route = await import('@/app/api/goals/route');

const ctx = TEST_CTX;
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

const remembered = (accounts: Record<string, unknown>[]) =>
  encrypt(TEST_CTX, JSON.stringify(accounts.map((a) => ({ official_name: null, subtype: null, mask: null, limit: null, currency: 'USD', ...a }))));
/** The balances Nya recorded on a day, as a snapshot records them. */
const recordBalances = async (balances: Record<string, number>, day = daysAgo(1)) =>
  fake.hset(ctxKey('history:accounts'), { [day]: await encrypt(TEST_CTX, JSON.stringify(balances)) });

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_bank', institution_name: 'Chase', encrypted_access_token: await encrypt(TEST_CTX, 'access-sandbox-bank') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_bank: await remembered([
      { account_id: 'acc_sav', name: 'Savings', type: 'depository', subtype: 'savings' },
      { account_id: 'acc_chk', name: 'Checking', type: 'depository', subtype: 'checking' },
      { account_id: 'acc_card', name: 'Card', type: 'credit', subtype: 'credit card' },
      { account_id: 'acc_loan', name: 'Car loan', type: 'loan', subtype: 'auto' },
      { account_id: 'acc_eur', name: 'Sparkonto', type: 'depository', subtype: 'savings', currency: 'EUR' },
      { account_id: 'acc_hid', name: 'Old savings', type: 'depository', subtype: 'savings' },
    ]),
  });
  await recordBalances({ acc_sav: 10_000, acc_chk: 2500, acc_card: 300, acc_loan: 9000, acc_eur: 4000, acc_hid: 800 });
  const at = new Date().toISOString();
  // A manual account, its balance kept in US dollars, and one SimpleFIN fed in
  // yen, kept as a manual one.
  await saveManualAccount(ctx, { account_id: 'manual_jar', name: 'Jar', institution_name: 'Home', type: 'depository', subtype: null, balance: 340.25, updated_at: at });
  await saveManualAccount(ctx, { account_id: 'manual_yen', name: 'Yen', institution_name: 'Tokyo', type: 'depository', subtype: null, balance: 100_000, updated_at: at, currency: 'JPY' });
});

/** A save as the page sends it: the list, and what it sends beside it. */
const put = async (goals: unknown, beside: Record<string, unknown> = {}) => {
  const res: Response = await route.PUT(new Request('http://x/api/goals', { method: 'PUT', body: JSON.stringify({ ...beside, goals }) }));
  return { status: res.status, body: (await res.json()) as any };
};
const get = async () => {
  const res: Response = await route.GET();
  return { status: res.status, body: (await res.json()) as any };
};
const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
  const saved = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = saved;
  }
};
const entries = async () => Object.fromEntries(await goalPlansStore.getAll(ctx));

const ID = (n: number) => `0000000${n}-1d2e-4f5a-8b6c-7d8e9f0a1b2c`;
const G = (n: number, over: Record<string, unknown> = {}) => ({ id: ID(n), name: `Goal ${n}`, target: 5000, account_id: 'acc_sav', ...over });

describe('goals without a plan behave exactly as before', () => {
  test('saved and read back as the four fields, and nothing written to the plans store', async () => {
    const plain = [G(1), G(2, { account_id: null, target: 120.5 })];
    expect(await put(plain)).toEqual({ status: 200, body: { goals: plain } });
    expect(await get()).toEqual({ status: 200, body: { goals: plain } });
    expect(await getGoals(ctx)).toEqual(plain);
    expect(await fake.hgetall(ctxKey('goal-plans'))).toBeNull();
  });

  test('an existing blob reads unchanged, with no plan', async () => {
    await setGoals(ctx, [G(1)]);
    expect((await get()).body).toEqual({ goals: [G(1)] });
  });
});

describe('a plan', () => {
  test('saved beside the blob, which keeps only the four fields', async () => {
    const goal = { ...G(1), plan: { allocation: 4000, monthly_target: 250.5, target_date: '2030-06-30' } };
    const { status, body } = await put([goal]);
    expect(status).toBe(200);
    expect(body.goals[0]).toEqual({ ...goal, plan_start: { date: today(), amount: 4000 } });
    expect(await getGoals(ctx)).toEqual([G(1)]);
    expect((await entries())[ID(1)]).toEqual({
      v: 1,
      save: expect.any(String),
      core: { name: 'Goal 1', target: 5000, account_id: 'acc_sav' },
      plan: {
        allocation: { amount: 4000, account_id: 'acc_sav' },
        monthly_target: 250.5,
        target_date: '2030-06-30',
        plan_start: { date: today(), amount: 4000, account_id: 'acc_sav' },
      },
      // The save finished: nothing of how it read before is kept.
      before: null,
    });
    expect((await get()).body.goals).toEqual(body.goals);
  });

  test('where the line to a target date starts: what the goal held when the date was set, kept when the date moves', async () => {
    await put([{ ...G(1), plan: { target_date: '2030-06-30' } }]);
    // Without an allocation, it held the whole balance.
    expect((await get()).body.goals[0].plan_start).toEqual({ date: today(), amount: 10_000 });
    await recordBalances({ acc_sav: 11_000 }, today());
    await put([{ ...G(1), plan: { target_date: '2031-01-31' } }]);
    expect((await get()).body.goals[0].plan_start).toEqual({ date: today(), amount: 10_000 });
    // Cleared with the date.
    await put([{ ...G(1), plan: {} }]);
    expect((await get()).body.goals[0]).toEqual(G(1));
    expect(await entries()).toEqual({});
  });

  test('a goal sent without a plan, as a page from before plans sends it, keeps the stored plan', async () => {
    await put([{ ...G(1), plan: { allocation: 4000, monthly_target: 100 } }]);
    expect((await put([{ ...G(1), name: 'Renamed by an old page' }])).status).toBe(200);
    expect((await get()).body.goals[0]).toEqual({ ...G(1), name: 'Renamed by an old page', plan: { allocation: 4000, monthly_target: 100 } });
  });

  test('every field checked, with why', async () => {
    expect(await put([{ ...G(1), plan: { allocation: -1 } }])).toEqual({ status: 400, body: { error: 'An allocation is an amount from 0 up.' } });
    expect(await put([{ ...G(1), plan: { colour: 'red' } }])).toEqual({ status: 400, body: { error: 'A goal’s plan has no field colour.' } });
    expect(await put([{ ...G(1), account_id: null, plan: { allocation: 5 } }])).toEqual({ status: 400, body: { error: 'An allocation needs an account to take it from.' } });
    expect((await put([{ ...G(1), plan: { allocation: 10.005 } }])).body).toEqual({ error: 'An amount in USD has at most 2 decimal places.' });
    expect((await put('nope')).status).toBe(400);
    const bad: Response = await route.PUT(new Request('http://x/api/goals', { method: 'PUT', body: '{' }));
    expect(bad.status).toBe(400);
    expect(await fake.get(ctxKey('goals'))).toBeNull();
  });

  test('a target date set in the past is refused; one that passed since it was set is kept', async () => {
    expect(await put([{ ...G(1), plan: { target_date: '2020-01-01' } }])).toEqual({ status: 400, body: { error: 'A target date can’t be in the past: pick today or a day after it.' } });
    // Yesterday is taken: a person behind UTC is still on it.
    expect((await put([{ ...G(1), plan: { target_date: daysAgo(1) } }])).status).toBe(200);
    // One saved before, now past: the list still saves.
    await goalPlansStore.set(ctx, ID(1), { v: 1, core: { name: 'Goal 1', target: 5000, account_id: 'acc_sav' }, plan: { target_date: '2020-01-01', plan_start: { date: '2019-01-01', amount: 0 } }, before: null });
    expect((await put([{ ...G(1), plan: { target_date: '2020-01-01' } }, G(2)])).status).toBe(200);
  });
});

describe('allocations never above the balance the server knows', () => {
  test('two goals on one account that fit are taken; one more cent is refused, with the total and the balance', async () => {
    expect((await put([{ ...G(1), plan: { allocation: 4000 } }, { ...G(2), plan: { allocation: 6000 } }])).status).toBe(200);
    const { status, body } = await put([{ ...G(1), plan: { allocation: 4000 } }, { ...G(2), plan: { allocation: 6000.01 } }]);
    expect(status).toBe(400);
    expect(body.error).toBe(`Allocations on Savings would come to $10,000.01, more than its balance of $10,000.00 as of ${new Date(`${daysAgo(1)}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}. Lower them, or refresh your balances and try again.`);
    // Nothing was written.
    expect((await get()).body.goals.map((g: any) => g.plan.allocation)).toEqual([4000, 6000]);
  });

  test('after the balance fell: an unrelated save goes through, lowering goes through, raising is refused', async () => {
    await put([{ ...G(1), plan: { allocation: 4000 } }, { ...G(2), plan: { allocation: 3500.5 } }, G(3, { account_id: 'acc_chk' })]);
    await recordBalances({ acc_sav: 6000, acc_chk: 2500 }, today());
    expect((await put([{ ...G(1), plan: { allocation: 4000 } }, { ...G(2), plan: { allocation: 3500.5 } }, G(3, { account_id: 'acc_chk', name: 'Renamed' })])).status).toBe(200);
    expect((await put([{ ...G(1), plan: { allocation: 4000 } }, { ...G(2), plan: { allocation: 3000 } }, G(3, { account_id: 'acc_chk' })])).status).toBe(200);
    expect((await put([{ ...G(1), plan: { allocation: 4000 } }, { ...G(2), plan: { allocation: 3500 } }, G(3, { account_id: 'acc_chk' })])).status).toBe(400);
    // Stored as set: the card shows them scaled to fit (lib/goal-allocation.ts).
    expect((await get()).body.goals.map((g: any) => g.plan?.allocation)).toEqual([4000, 3000, undefined]);
  });

  test('a goal moved to another account brings no claim to it unchecked', async () => {
    await put([{ ...G(1), plan: { allocation: 2000 } }]);
    expect((await put([{ ...G(1), account_id: 'acc_chk', plan: { allocation: 2600 } }])).status).toBe(400);
    expect((await put([{ ...G(1), account_id: 'acc_chk', plan: { allocation: 2500 } }])).status).toBe(200);
  });

  test('archived goals claim nothing, so archiving makes room', async () => {
    await put([{ ...G(1), plan: { allocation: 9000 } }]);
    expect((await put([{ ...G(1), plan: { allocation: 9000 } }, { ...G(2), plan: { allocation: 2000 } }])).status).toBe(400);
    expect((await put([{ ...G(1), plan: { archived: true } }, { ...G(2), plan: { allocation: 2000 } }])).status).toBe(200);
  });

  test('an account whose balance Nya doesn’t know, or no longer has, takes no new allocation', async () => {
    expect(await put([{ ...G(1), account_id: 'acc_unknown', plan: { allocation: 1 } }])).toEqual({
      status: 400,
      body: { error: 'Nya has no balance for that account yet, so nothing more can be allocated from it.' },
    });
    // One kept from before stays, so the list still saves.
    await setGoals(ctx, [G(1, { account_id: 'acc_unknown' })]);
    await goalPlansStore.set(ctx, ID(1), { v: 1, core: { name: 'Goal 1', target: 5000, account_id: 'acc_unknown' }, plan: { allocation: { amount: 50, account_id: 'acc_unknown' } }, before: null });
    expect((await put([{ ...G(1, { account_id: 'acc_unknown' }), plan: { allocation: 50 } }, G(2)])).status).toBe(200);
  });

  test('balances that can’t be read refuse a new allocation, and leave a save that needs none alone', async () => {
    await put([G(1)]);
    // The recorded balances can't be reached for the check.
    fake.failNext('hkeys', 2);
    const refused = await quietly(() => put([{ ...G(1), plan: { allocation: 100 } }]));
    expect(refused).toEqual({ status: 400, body: { error: 'Your balances couldn’t be read just now, so a new allocation can’t be checked. Try again in a moment.' } });
    expect((await put([G(1, { name: 'Renamed' })])).status).toBe(200);
  });

  test('a hidden account’s balance is known to the check', async () => {
    await setAccountHidden(ctx, 'acc_hid', 'depository', true);
    expect((await put([{ ...G(1), account_id: 'acc_hid', plan: { allocation: 801 } }])).status).toBe(400);
    expect((await put([{ ...G(1), account_id: 'acc_hid', plan: { allocation: 800 } }])).status).toBe(200);
  });
});

describe('currencies and kinds of account', () => {
  test('an account in another currency: allocated in it, checked against its balance in it, nothing converted', async () => {
    expect((await put([{ ...G(1), account_id: 'acc_eur', plan: { allocation: 4000.01 } }])).body.error).toContain('more than its balance of €4,000.00');
    expect((await put([{ ...G(1), account_id: 'acc_eur', plan: { allocation: 3999.99, monthly_target: 150 } }])).status).toBe(200);
    expect((await put([{ ...G(1), account_id: 'manual_yen', plan: { allocation: 100.5 } }])).body).toEqual({ error: 'An amount in JPY is a whole number.' });
    expect((await put([{ ...G(1), account_id: 'manual_yen', plan: { allocation: 100_001 } }])).body.error).toContain('more than its balance of ¥100,000');
    expect((await put([{ ...G(1), account_id: 'manual_yen', plan: { allocation: 100_000 } }])).status).toBe(200);
  });

  test('a manual account: its typed balance, in US dollars', async () => {
    expect((await put([{ ...G(1), account_id: 'manual_jar', plan: { allocation: 340.26 } }])).status).toBe(400);
    expect((await put([{ ...G(1), account_id: 'manual_jar', plan: { allocation: 340.25 } }])).status).toBe(200);
  });

  test('a credit card or a loan can’t be tracked, nor allocated from; a goal that tracked one before is kept', async () => {
    const card = await put([G(1, { account_id: 'acc_card' })]);
    expect(card.status).toBe(400);
    expect(card.body.error).toBe('A goal can’t track Card: a credit card’s or a loan’s balance is money owed, not saved. Choose a savings account, or plan a payoff with the debt payoff planner.');
    expect((await put([G(1, { account_id: 'acc_loan' })])).status).toBe(400);
    // Saved by the release before: still saves, as it is.
    await setGoals(ctx, [G(1, { account_id: 'acc_card' })]);
    expect((await put([G(1, { account_id: 'acc_card', name: 'Pay it off' }), G(2)])).status).toBe(200);
    expect((await put([{ ...G(1, { account_id: 'acc_card' }), plan: { allocation: 10 } }])).body).toEqual({ error: 'Nothing can be allocated from Card: its balance is money owed, not saved.' });
  });
});

describe('archive and restore', () => {
  test('archiving keeps the goal with the day and what it held, and releases its allocation; restoring brings it back without one', async () => {
    await put([{ ...G(1), plan: { allocation: 5000, monthly_target: 100 } }, G(2)]);
    const archived = await put([{ ...G(1), plan: { allocation: 5000, monthly_target: 100, archived: true } }, G(2)]);
    expect(archived.status).toBe(200);
    expect(archived.body.goals[0]).toEqual({ ...G(1), plan: { monthly_target: 100, archived: true }, archived_on: today(), archived_amount: 5000 });
    // The other goal now counts the whole balance: nothing is allocated.
    expect((await entries())[ID(1)].plan.allocation).toBeUndefined();
    // Saved again, it keeps its day and amount.
    await recordBalances({ acc_sav: 50 }, today());
    await put([{ ...G(1), name: 'Car', plan: { monthly_target: 100, archived: true } }, G(2)]);
    expect((await get()).body.goals[0]).toMatchObject({ archived_on: today(), archived_amount: 5000 });
    const restored = await put([{ ...G(1), name: 'Car', plan: { monthly_target: 100 } }, G(2)]);
    expect(restored.body.goals[0]).toEqual({ ...G(1), name: 'Car', plan: { monthly_target: 100 } });
    // Deleted for good: gone from both stores.
    await put([G(2)]);
    expect(await getGoals(ctx)).toEqual([G(2)]);
    expect(await entries()).toEqual({});
  });
});

describe('a save that stops part way never reads wrong', () => {
  test('stopped after the plans were written, before the blob: every goal reads as before the save', async () => {
    await put([{ ...G(1), plan: { allocation: 1000 } }, G(2)]);
    const before = (await get()).body;
    // Renamed with a new allocation, and moved; a goal added; one removed.
    fake.failNext('set');
    const res = await quietly(() => put([{ ...G(1), name: 'Moved', account_id: 'acc_chk', plan: { allocation: 2000 } }, { ...G(3), plan: { monthly_target: 5 } }]));
    expect(res.status).toBe(500);
    expect((await entries())[ID(1)].plan.allocation).toEqual({ amount: 2000, account_id: 'acc_chk' });
    expect((await get()).body).toEqual(before);
    // Tried again, it lands whole, and the orphan of the goal that wasn't added is gone.
    expect((await put([{ ...G(1), name: 'Moved', account_id: 'acc_chk', plan: { allocation: 2000 } }])).status).toBe(200);
    expect((await get()).body.goals).toEqual([{ ...G(1), name: 'Moved', account_id: 'acc_chk', plan: { allocation: 2000 } }]);
    expect(Object.keys(await entries())).toEqual([ID(1)]);
  });

  test('stopped after the blob, before settling: reads as the save left it, and the next save settles', async () => {
    await put([{ ...G(1), plan: { allocation: 1000 } }, { ...G(2), plan: { monthly_target: 9 } }]);
    // The save, step by step as the route takes it, failing as it settles
    // (the first compare-and-set after the writes).
    const read = await readGoalRecords(ctx, { strictLinks: true });
    const parsed = parseGoals([{ ...G(1), plan: {} }]);
    if ('error' in parsed) throw new Error(parsed.error);
    const planned = await planGoalSave(parsed.goals, read.records, { today: today(), links: read.links, accounts: () => knownGoalAccounts(ctx) });
    if ('refused' in planned) throw new Error(planned.refused);
    fake.failNext('eval');
    await expect(writeGoalRecords(ctx, planned.next, read)).rejects.toThrow(/armed failure/);
    expect((await get()).body.goals).toEqual([G(1)]);
    expect(Object.keys(await entries()).sort()).toEqual([ID(1), ID(2)].sort());
    expect((await put([{ ...G(1), plan: {} }])).status).toBe(200);
    expect(await entries()).toEqual({});
  });
});

describe('two saves at once', () => {
  /** A save as the route takes it, from what it read earlier: for running
   *  two saves interleaved, one from a page that read before the other saved. */
  const saveFrom = async (read: Awaited<ReturnType<typeof readGoalRecords>>, goals: unknown) => {
    const parsed = parseGoals(goals);
    if ('error' in parsed) throw new Error(parsed.error);
    const planned = await planGoalSave(parsed.goals, read.records, { today: today(), links: read.links, accounts: () => knownGoalAccounts(ctx) });
    if ('refused' in planned) throw new Error(planned.refused);
    await writeGoalRecords(ctx, planned.next, read);
  };
  /** Runs `between` once, just after the next write of the goals blob lands:
   *  after a save's blob, before it settles its entries. */
  const afterNextBlob = (between: () => Promise<unknown>) => {
    const set = fake.set;
    fake.set = (async (...args: Parameters<typeof set>) => {
      const out = await set.apply(fake, args);
      if (args[0] === ctxKey('goals')) {
        fake.set = set;
        await between();
      }
      return out;
    }) as typeof set;
  };
  const withPlans = (goals: any[]) => goals.map((g) => ({ ...g, plan: g.plan ?? {} }));

  test('a goal one deletes and the other, saving last, still lists comes back with its plan', async () => {
    await put([{ ...G(1), plan: { monthly_target: 50, target_date: '2030-01-01', archived: true } }, { ...G(2), plan: { allocation: 1000 } }]);
    const shown = (await get()).body.goals;
    // The second page read the list; the first then deletes goal 1 for good.
    const second = await readGoalRecords(ctx, { strictLinks: true });
    expect((await put([shown[1]])).status).toBe(200);
    expect(Object.keys(await entries())).toEqual([ID(2)]);
    // The second saves last, from what it read: the list is its list, as with
    // the blob alone, and goal 1 is in it as it was, plan and all.
    await saveFrom(second, withPlans(shown));
    expect((await get()).body.goals).toEqual(shown);
  });

  test('a save’s settling never deletes, nor rewrites, an entry another save wrote after it read', async () => {
    await put([{ ...G(1), plan: { monthly_target: 100 } }]);
    // The first empties the plan; the second, landing between its writes,
    // sets one: the first leaves the second's entry as it is.
    const first = await readGoalRecords(ctx, { strictLinks: true });
    afterNextBlob(() => put([{ ...G(1), plan: { monthly_target: 300 } }]));
    await saveFrom(first, [{ ...G(1), plan: {} }]);
    expect((await get()).body.goals).toEqual([{ ...G(1), plan: { monthly_target: 300 } }]);
    // The first changes it; the second again lands between: the first's
    // settling doesn't put its own plan back over the second's.
    const again = await readGoalRecords(ctx, { strictLinks: true });
    afterNextBlob(() => put([{ ...G(1), plan: { monthly_target: 500 } }]));
    await saveFrom(again, [{ ...G(1), plan: { monthly_target: 200 } }]);
    expect((await get()).body.goals).toEqual([{ ...G(1), plan: { monthly_target: 500 } }]);
    expect((await entries())[ID(1)].before).toBeNull();
  });
});

describe('a rollback round trip', () => {
  /** What the release before's PUT writes: the four fields of each goal its
   *  page sent, nothing else (its route, as shipped). */
  const oldReleaseSaves = (goals: Record<string, unknown>[]) =>
    setGoals(ctx, goals.map((g) => ({ id: String(g.id), name: String(g.name), target: Number(g.target), account_id: (g.account_id as string | null) ?? null })));

  test('the release before renames, moves, deletes and adds; this one reads every plan where it belongs, and the next save leaves the store consistent', async () => {
    await put([
      { ...G(1), plan: { allocation: 3000, target_date: '2030-01-01' } },
      { ...G(2), plan: { monthly_target: 75 } },
      { ...G(3), plan: { allocation: 500, archived: true } },
      { ...G(4), plan: { allocation: 1000 } },
    ]);
    // Its page shows them all (it knows nothing of archiving), and saves:
    // goal 1 renamed, goal 2 deleted, goal 4 moved to checking, goal 5 added.
    const shown = (await get()).body.goals;
    await oldReleaseSaves([{ ...shown[0], name: 'Renamed there' }, shown[2], { ...shown[3], account_id: 'acc_chk' }, G(5)]);

    const read = (await get()).body.goals;
    expect(read.map((g: any) => g.id)).toEqual([ID(1), ID(3), ID(4), ID(5)]);
    // Renamed: its plan still applies.
    expect(read[0]).toEqual({ ...G(1), name: 'Renamed there', plan: { allocation: 3000, target_date: '2030-01-01' }, plan_start: { date: today(), amount: 3000 } });
    // Still archived.
    expect(read[1].plan).toEqual({ archived: true });
    // Moved: its allocation was on savings, so it claims nothing of checking, and says so.
    expect(read[2]).toEqual({ ...G(4), account_id: 'acc_chk', earlier_allocation: 1000 });
    // Added there: no plan.
    expect(read[3]).toEqual(G(5));

    // This release's page saves what it was shown, each goal with its plan
    // (lib/goal-model.ts: a page from before plans sends none): the deleted
    // goal's plan goes, the moved goal's old allocation goes, and every entry
    // left is a goal's, in sync.
    expect((await put(read.map((g: any) => ({ ...g, plan: g.plan ?? {} })))).status).toBe(200);
    const left = await entries();
    expect(Object.keys(left).sort()).toEqual([ID(1), ID(3)].sort());
    expect(left[ID(1)].core).toEqual({ name: 'Renamed there', target: 5000, account_id: 'acc_sav' });
    expect((await get()).body.goals).toEqual(read.map((g: any) => {
      const { earlier_allocation, ...rest } = g;
      return rest;
    }));
  });

  test('the release before setting a goal back to how it was before this release’s last save keeps that save’s plan', async () => {
    await put([{ ...G(1), plan: { monthly_target: 200, target_date: '2030-01-01' } }]);
    // One save, as the editor makes it: the target, monthly target and date at once.
    expect((await put([{ ...G(1), target: 8000, plan: { monthly_target: 300, target_date: '2031-06-30' } }])).status).toBe(200);
    // It finished, so its entry keeps nothing of how the goal read before it.
    expect((await entries())[ID(1)].before).toBeNull();
    // After a rollback, the release before sets the target back to 5000.
    await oldReleaseSaves([G(1)]);
    const read = (await get()).body.goals[0];
    expect(read).toMatchObject({ ...G(1), plan: { monthly_target: 300, target_date: '2031-06-30' } });
    // And the next save keeps it.
    expect((await put([read])).status).toBe(200);
    expect((await get()).body.goals[0].plan).toEqual({ monthly_target: 300, target_date: '2031-06-30' });
  });

  test('a goal moved by the release before, or by a page from before plans, starts its line to a target date again on its new account', async () => {
    await put([{ ...G(1), plan: { target_date: '2030-06-30' } }]);
    expect((await get()).body.goals[0].plan_start).toEqual({ date: today(), amount: 10_000 });
    // Moved there: what it held on savings is no start for checking, so it
    // shows no line, and the next save starts one from what checking holds.
    await oldReleaseSaves([{ ...G(1), account_id: 'acc_chk' }]);
    const moved = (await get()).body.goals[0];
    expect(moved).toEqual({ ...G(1), account_id: 'acc_chk', plan: { target_date: '2030-06-30' } });
    await put([moved]);
    expect((await get()).body.goals[0].plan_start).toEqual({ date: today(), amount: 2500 });
    // A page from before plans sends no plan, which keeps the stored one: the same.
    await recordBalances({ acc_sav: 12_000 }, today());
    expect((await put([G(1)])).status).toBe(200);
    expect((await get()).body.goals[0]).toEqual({ ...G(1), plan: { target_date: '2030-06-30' } });
    await put([{ ...G(1), plan: { target_date: '2030-06-30' } }]);
    expect((await get()).body.goals[0].plan_start).toEqual({ date: today(), amount: 12_000 });
  });

  test('a goal the release before deleted leaves no claim behind, even before the next save', async () => {
    await put([{ ...G(1), plan: { allocation: 9000 } }]);
    await oldReleaseSaves([G(2)]);
    expect((await get()).body.goals).toEqual([G(2)]);
    // Its allocation is no one's: the whole balance is free to allocate.
    expect((await put([{ ...G(2), plan: { allocation: 10_000 } }])).status).toBe(200);
  });
});

describe('the day a save dates', () => {
  test('is the person’s own, as the page sends it, when it is within a day of the server’s; else the server’s UTC day', async () => {
    const archive = (n: number) => [{ ...G(n), plan: { target_date: '2030-01-01', archived: true } }];
    for (const day of [daysAgo(1), daysAgo(-1)]) {
      expect((await put(archive(1), { today: day })).body.goals[0]).toMatchObject({ archived_on: day, plan_start: { date: day } });
      await put([]);
    }
    // Further off than any time zone, or not a day: not taken.
    for (const sent of [daysAgo(3), '2001-01-01', '2026-02-30', 'yesterday', 20_261_011, null]) {
      expect((await put(archive(2), { today: sent })).body.goals[0]).toMatchObject({ archived_on: today(), plan_start: { date: today() } });
      await put([]);
    }
  });
});

describe('a store that can’t be read', () => {
  test('an unreadable plan is a flagged 409 on load and on save, naming it, and nothing is saved over it', async () => {
    await put([{ ...G(1), plan: { allocation: 1000 } }, G(2)]);
    await fake.hset(ctxKey('goal-plans'), { [ID(1)]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const blob = await fake.get<string>(ctxKey('goals'));
    const loaded = await quietly(get);
    expect(loaded).toEqual({ status: 409, body: { error: expect.stringContaining('goal plans'), unreadable: true, unreadable_ids: [ID(1)], unrecognised_ids: [] } });
    const saved = await quietly(() => put([G(1), G(2)]));
    expect(saved.status).toBe(409);
    expect(await fake.hget<string>(ctxKey('goal-plans'), ID(1))).toBe('not-ciphertext-but-long-enough-to-be-tried');
    expect(await fake.get<string>(ctxKey('goals'))).toBe(blob);
  });

  test('a plan a later release wrote is unrecognised: 409, kept as it is', async () => {
    await setGoals(ctx, [G(1)]);
    await fake.hset(ctxKey('goal-plans'), { [ID(1)]: await encrypt(TEST_CTX, JSON.stringify({ v: 2, core: { name: 'Goal 1', target: 5000, account_id: 'acc_sav' }, plan: {}, before: null })) });
    expect((await quietly(get)).body).toMatchObject({ unreadable: true, unreadable_ids: [], unrecognised_ids: [ID(1)] });
    expect((await quietly(() => put([G(1)]))).status).toBe(409);
  });

  test('a blob that can’t be read is the same 409, before any plan is touched', async () => {
    await put([{ ...G(1), plan: { allocation: 1000 } }]);
    await fake.set(ctxKey('goals'), 'unreadable');
    expect((await quietly(get)).body).toMatchObject({ unreadable: true });
    expect((await quietly(() => put([G(1)]))).status).toBe(409);
    expect((await entries())[ID(1)].plan.allocation).toEqual({ amount: 1000, account_id: 'acc_sav' });
  });

  test('storage out of reach is a 500, never a flagged 409 or an empty list', async () => {
    fake.failNext('hgetall');
    const res = await quietly(get);
    expect(res).toEqual({ status: 500, body: { error: 'Failed to load goals' } });
  });

  test('a container being restored is a 503', async () => {
    await registerTestContainer(fake, 'restoring');
    (await import('@/lib/sessions')).forgetEpochs();
    expect((await quietly(get)).status).toBe(503);
    expect((await quietly(() => put([G(1)]))).status).toBe(503);
  });
});

describe('accounts linked across a reconnect', () => {
  test('a goal follows its account to the new id, says so, and its allocation still applies there', async () => {
    await setGoals(ctx, [G(1, { account_id: 'acc_gone' })]);
    await goalPlansStore.set(ctx, ID(1), {
      v: 1,
      core: { name: 'Goal 1', target: 5000, account_id: 'acc_gone' },
      plan: { allocation: { amount: 1500, account_id: 'acc_gone' }, target_date: '2030-01-01', plan_start: { date: '2026-01-01', amount: 900 } },
      before: null,
    });
    await links.linkAccounts(ctx, 'acc_gone', 'acc_sav', {});
    const { body } = await get();
    expect(body.goals).toEqual([{ ...G(1), plan: { allocation: 1500, target_date: '2030-01-01' }, plan_start: { date: '2026-01-01', amount: 900 }, relinked: true }]);
    // Saved from what it was shown: the current id is written, nothing is
    // treated as newly tracked, and the line keeps its start.
    expect((await put(body.goals)).status).toBe(200);
    expect(await getGoals(ctx)).toEqual([G(1)]);
    expect((await get()).body.goals[0]).toEqual({ ...G(1), plan: { allocation: 1500, target_date: '2030-01-01' }, plan_start: { date: '2026-01-01', amount: 900 } });
  });
});

describe('links that can’t be read', () => {
  const DAMAGED = 'not-ciphertext-but-long-enough-to-be-tried';
  /** A goal tracking an account by its id before a reconnect, linked since. */
  const relinked = async () => {
    await setGoals(ctx, [G(1, { account_id: 'acc_gone' })]);
    await goalPlansStore.set(ctx, ID(1), {
      v: 1,
      core: { name: 'Goal 1', target: 5000, account_id: 'acc_gone' },
      plan: { allocation: { amount: 1500, account_id: 'acc_gone' }, target_date: '2030-01-01', plan_start: { date: '2026-01-01', amount: 900 } },
      before: null,
    });
    await links.linkAccounts(ctx, 'acc_gone', 'acc_sav', {});
    return (await get()).body.goals;
  };
  /** A save, and that nothing was written. */
  const refused = async (goals: unknown) => {
    const blob = await fake.get<string>(ctxKey('goals'));
    const stored = await fake.hget<string>(ctxKey('goal-plans'), ID(1));
    const res = await quietly(() => put(goals));
    expect(await fake.get<string>(ctxKey('goals'))).toBe(blob);
    expect(await fake.hget<string>(ctxKey('goal-plans'), ID(1))).toBe(stored);
    return res;
  };

  test('a damaged link stops a save, which decides on the links, rather than take a goal for moved; it says which, and what still works', async () => {
    const shown = await relinked();
    await fake.hset(ctxKey('account-links'), { acc_other: DAMAGED });
    // The page still shows the goals.
    expect((await quietly(get)).status).toBe(200);
    expect(await refused(shown)).toEqual({
      status: 409,
      body: {
        error:
          'A saved account link can’t be read, and a save needs the links to tell whether a goal moved to another account. Your goals are still shown as saved. To save changes, remove that link under Reconnected accounts on the Accounts tab, and link again if needed.',
      },
    });
    // Removed, the save goes through, on the links as they are.
    await fake.hdel(ctxKey('account-links'), 'acc_other');
    expect((await put(shown)).status).toBe(200);
    expect((await get()).body.goals[0]).toMatchObject({ account_id: 'acc_sav', plan: { allocation: 1500 }, plan_start: { date: '2026-01-01', amount: 900 } });
  });

  test('so does a connection’s record of its accounts that can’t be read, saying so; one of a connection no longer stored stops nothing', async () => {
    const shown = await relinked();
    await fake.hset(ctxKey('accounts:meta'), { item_removed: DAMAGED });
    expect((await quietly(() => put(shown))).status).toBe(200);
    await fake.hset(ctxKey('accounts:meta'), { item_bank: DAMAGED });
    const res = await refused(shown);
    expect(res.status).toBe(409);
    expect(res.body.error).toStartWith('What Nya keeps of a connection’s accounts can’t be read just now');
    expect(res.body.error).toContain('Your goals are still shown as saved.');
    expect(res.body).not.toHaveProperty('unreadable');
  });

  test('storage out of reach as they are read is still a 500, never taken for damage', async () => {
    const shown = await relinked();
    const hgetall = fake.hgetall;
    for (const key of [ctxKey('account-links'), ctxKey('accounts:meta')]) {
      // Only that one read fails.
      fake.hgetall = (async (k: string, ...rest: unknown[]) => {
        if (k === key) throw new Error('FakeRedis: out of reach');
        return (hgetall as (...a: unknown[]) => Promise<unknown>).apply(fake, [k, ...rest]);
      }) as typeof hgetall;
      try {
        expect(await quietly(() => put(shown))).toEqual({ status: 500, body: { error: 'Failed to save goals' } });
      } finally {
        fake.hgetall = hgetall;
      }
    }
  });
});

describe('an account that ended (#50)', () => {
  const ABOUT = { type: 'depository', label: { name: 'Checking', institution: 'Chase', mask: null }, item_id: 'item_bank' };
  const on = (plan: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ ...G(1), account_id: 'acc_chk', ...over, plan });

  test('a goal can’t start tracking one, nor set more aside from one; a goal on one keeps its plan, and saves', async () => {
    await put([on({ allocation: 1000, monthly_target: 50 })]);
    await markEnded(ctx, 'acc_chk', { state: 'closed', on: daysAgo(3) }, ABOUT);
    const why = `it closed on ${dayLabel(daysAgo(3))}`;
    expect(await put([on({ allocation: 1000, monthly_target: 50 }), { ...G(2), account_id: 'acc_chk', plan: {} }])).toEqual({
      status: 400,
      body: { error: `A goal can’t track Checking: ${why}.` },
    });
    // Renamed, retargeted, its allocation kept or lowered: saved.
    expect((await put([on({ allocation: 1000, monthly_target: 75 }, { name: 'Renamed' })])).status).toBe(200);
    expect((await put([on({ allocation: 400, monthly_target: 75 }, { name: 'Renamed' })])).status).toBe(200);
    // Raised: refused, saying why.
    expect(await put([on({ allocation: 500, monthly_target: 75 }, { name: 'Renamed' })])).toEqual({
      status: 400,
      body: { error: `Nothing more can be set aside from Checking: ${why}.` },
    });
    expect((await get()).body.goals[0]).toEqual({ ...G(1), name: 'Renamed', account_id: 'acc_chk', plan: { allocation: 400, monthly_target: 75 } });
    // Reopened, it counts again: raised within its balance.
    await reopenAccount(ctx, 'acc_chk', new Map());
    expect((await put([on({ allocation: 2500, monthly_target: 75 }, { name: 'Renamed' })])).status).toBe(200);
  });
});

describe('containers', () => {
  test('another person’s goals and plans are never read or written', async () => {
    await setGoals(OTHER, [G(9, { name: 'OTHER-SECRET-GOAL' })]);
    await goalPlansStore.set(OTHER, ID(9), { v: 1, core: { name: 'OTHER-SECRET-GOAL', target: 5000, account_id: 'acc_sav' }, plan: { monthly_target: 1 }, before: null });
    await put([{ ...G(1), plan: { monthly_target: 5 } }]);
    expect(JSON.stringify((await get()).body)).not.toContain('OTHER-SECRET');
    expect(await getGoals(OTHER)).toEqual([G(9, { name: 'OTHER-SECRET-GOAL' })]);
    expect(Object.keys(Object.fromEntries(await goalPlansStore.getAll(OTHER)))).toEqual([ID(9)]);
  });
});
