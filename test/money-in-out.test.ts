import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// An investment account's money in and out (lib/money-in-out.ts): the route
// that sets and clears them, every field checked; the store read through
// account links, its current id's entry first, then the newest; kept on a
// disconnect and forgotten with the account; and the activity route answering
// them fresh beside its cached payload.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { rememberAccounts } = await import('@/lib/last-known');
const { linkAccounts, recordDirectory, forgetEarlierAccount } = await import('@/lib/links');
const { writeAccountCache } = await import('@/lib/cache');
const { parseMoneyInOutChange } = await import('@/lib/money-in-out');
const { moneyInOutStore, readMoneyInOut, saveMoneyInOut } = await import('@/lib/money-in-out-store');
const route = await import('@/app/api/money-in-out/route');
const activity = await import('@/app/api/investment-activity/route');

const NOW = Date.parse('2026-11-10T15:00:00Z');

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await route.POST(new Request('http://x/api/money-in-out', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }));
  return { status: res.status, body: await res.json() };
}

/** A Plaid connection as a load leaves it: stored, remembered, in the directory. */
async function connect(item_id: string, accounts: { account_id: string; type: string }[]) {
  await saveItem(ctx, { item_id, institution_name: 'Vanguard', encrypted_access_token: await encrypt(TEST_CTX, 'tok') });
  const inst = { item_id, institution_name: 'Vanguard', error: null, accounts: accounts.map((a) => ({ ...a, name: a.account_id, mask: '4421', official_name: null, subtype: null, balance: 10, currency: 'USD' })) };
  await rememberAccounts(ctx, [inst as any]);
  await recordDirectory(ctx, [inst as any]);
}

const totals = (over: Record<string, unknown> = {}) => ({ in: 152_000, out: 12_000, as_of: '2026-10-15', currency: 'USD', set_at: '2026-11-01T00:00:00.000Z', ...over });

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
});

describe('what the route refuses', () => {
  const cases: [string, unknown, RegExp][] = [
    ['an array', [], /JSON/],
    ['no account', { in: 1, out: 0, as_of: '2026-10-15' }, /account id/],
    ['__proto__', { account_id: '__proto__', in: 1, out: 0, as_of: '2026-10-15' }, /account id/],
    ['an extra field', { account_id: 'a', in: 1, out: 0, as_of: '2026-10-15', basis: 3 }, /basis isn’t part of/],
    ['money in below zero', { account_id: 'a', in: -1, out: 0, as_of: '2026-10-15' }, /Money in is an amount/],
    ['money in as text', { account_id: 'a', in: '1', out: 0, as_of: '2026-10-15' }, /Money in is an amount/],
    ['money out past any', { account_id: 'a', in: 1, out: 1e13, as_of: '2026-10-15' }, /Money out is an amount/],
    ['a day that is not one', { account_id: 'a', in: 1, out: 0, as_of: '2026-02-30' }, /YYYY-MM-DD/],
    ['a day before 1970', { account_id: 'a', in: 1, out: 0, as_of: '1969-12-31' }, /from 1970/],
    ['a currency that is not one', { account_id: 'a', in: 1, out: 0, as_of: '2026-10-15', currency: 'US$' }, /currency/],
    ['a clear with more', { account_id: 'a', clear: true, in: 1 }, /Clearing takes the account alone/],
    ['a clear that is not true', { account_id: 'a', clear: 'yes' }, /Clearing takes the account alone/],
  ];
  for (const [name, body, message] of cases) {
    test(name, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    });
  }

  test('a day after the person’s today, which can be the server’s tomorrow', () => {
    expect(parseMoneyInOutChange({ account_id: 'a', in: 1, out: 0, as_of: '2026-11-11' }, NOW)).toMatchObject({ kind: 'set', as_of: '2026-11-11' });
    expect(parseMoneyInOutChange({ account_id: 'a', in: 1, out: 0, as_of: '2026-11-12' }, NOW)).toBe('The day can’t be in the future');
  });

  test('a request from another site changes nothing', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    const res = await post({ account_id: 'inv', in: 1, out: 0, as_of: '2026-10-15' }, { origin: 'https://elsewhere.example' });
    expect(res.status).toBe(403);
    expect(await moneyInOutStore.count(ctx)).toBe(0);
  });

  test('an account no connection lists, and one that isn’t an investment account', async () => {
    await connect('i1', [{ account_id: 'chk', type: 'depository' }]);
    expect((await post({ account_id: 'nope', in: 1, out: 0, as_of: '2026-10-15' })).status).toBe(404);
    const res = await post({ account_id: 'chk', in: 1, out: 0, as_of: '2026-10-15' });
    expect(res).toEqual({ status: 400, body: { error: 'Money in and out are for investment accounts' } });
    expect(await moneyInOutStore.count(ctx)).toBe(0);
  });
});

describe('setting and clearing', () => {
  test('sets the totals, rounded to the cent, and answers them; clear removes them', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    const res = await post({ account_id: 'inv', in: 152_000.004, out: 12_000, as_of: '2026-10-15', currency: 'USD' });
    expect(res.status).toBe(200);
    expect(res.body.money_in_out).toMatchObject({ in: 152_000, out: 12_000, as_of: '2026-10-15', currency: 'USD' });
    expect(await moneyInOutStore.get(ctx, 'inv')).toEqual(res.body.money_in_out);
    // An empty field is $0.00: a net alone.
    expect((await post({ account_id: 'inv', in: 0, out: 18_000, as_of: '2026-10-15' })).body.money_in_out).toMatchObject({ in: 0, out: 18_000, currency: null });
    expect(await post({ account_id: 'inv', clear: true })).toEqual({ status: 200, body: { money_in_out: null } });
    expect(await moneyInOutStore.count(ctx)).toBe(0);
  });
});

describe('read through account links', () => {
  test('totals set under an earlier id apply to the account it was linked to', async () => {
    await connect('i1', [{ account_id: 'new', type: 'investment' }]);
    await moneyInOutStore.set(ctx, 'old', totals());
    expect(await readMoneyInOut(ctx, 'new')).toBeNull();
    await linkAccounts(ctx, 'old', 'new', {});
    expect(await readMoneyInOut(ctx, 'new')).toEqual(totals());
  });

  test('the current id’s own entry wins, then the newest', async () => {
    await connect('i1', [{ account_id: 'new', type: 'investment' }]);
    await linkAccounts(ctx, 'old1', 'new', {});
    await linkAccounts(ctx, 'old2', 'new', {});
    await moneyInOutStore.set(ctx, 'old1', totals({ in: 1, set_at: '2026-11-02T00:00:00.000Z' }));
    await moneyInOutStore.set(ctx, 'old2', totals({ in: 2, set_at: '2026-11-01T00:00:00.000Z' }));
    expect((await readMoneyInOut(ctx, 'new'))?.in).toBe(1);
    await moneyInOutStore.set(ctx, 'new', totals({ in: 3, set_at: '2026-10-01T00:00:00.000Z' }));
    expect((await readMoneyInOut(ctx, 'new'))?.in).toBe(3);
  });

  test('a paused link, whose earlier id is live again, carries nothing across', async () => {
    await connect('i1', [{ account_id: 'new', type: 'investment' }, { account_id: 'old', type: 'investment' }]);
    await linkAccounts(ctx, 'old', 'new', {});
    await moneyInOutStore.set(ctx, 'old', totals());
    expect(await readMoneyInOut(ctx, 'new')).toBeNull();
  });

  test('setting drops the earlier ids’ entries; clearing drops every one', async () => {
    await connect('i1', [{ account_id: 'new', type: 'investment' }]);
    await linkAccounts(ctx, 'old', 'new', {});
    await moneyInOutStore.set(ctx, 'old', totals());
    await saveMoneyInOut(ctx, { kind: 'set', account_id: 'new', in: 5, out: 0, as_of: '2026-11-01', currency: 'USD' }, NOW);
    expect([...(await moneyInOutStore.getAll(ctx)).keys()]).toEqual(['new']);
    await moneyInOutStore.set(ctx, 'old', totals());
    await saveMoneyInOut(ctx, { kind: 'clear', account_id: 'new' }, NOW);
    expect(await moneyInOutStore.count(ctx)).toBe(0);
  });
});

describe('disconnecting and forgetting', () => {
  test('kept while the account is an earlier one, and forgotten with it', async () => {
    await recordDirectory(ctx, [{ item_id: 'item_gone', institution_name: 'Vanguard', error: null, accounts: [{ account_id: 'inv', type: 'investment', subtype: 'brokerage' }] }] as any);
    await moneyInOutStore.set(ctx, 'inv', totals());
    expect(await readMoneyInOut(ctx, 'inv')).toEqual(totals());
    await forgetEarlierAccount(ctx, 'inv');
    expect(await moneyInOutStore.get(ctx, 'inv')).toBeNull();
  });
});

describe('the activity route', () => {
  const PAYLOAD = { txns: [], ytd_contributions: 0, ytd_rollovers: 0, flows: [], flows_from: '2026-06-01', flows_to: '2026-11-09', note: null, contributions_12m_activity_from: null };
  const get = async () => (await activity.GET(new Request('http://x/api/investment-activity?id=inv&item_id=i1'))).json();

  test('answers the totals fresh beside a cached payload, so a save shows at once', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    await writeAccountCache(ctx, 'i1:inv', PAYLOAD);
    expect(await get()).toMatchObject({ from_cache: true, money_in_out: null });
    await moneyInOutStore.set(ctx, 'inv', totals());
    expect(await get()).toMatchObject({ from_cache: true, flows_from: '2026-06-01', money_in_out: totals() });
  });

  test('totals that can’t be read are said, and the activity still answers', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    await writeAccountCache(ctx, 'i1:inv', PAYLOAD);
    await fake.hset(ctxKey('money-in-out'), { inv: 'not-ciphertext-but-long-enough-to-be-tried' });
    const orig = console.error;
    console.error = () => {};
    try {
      expect(await get()).toMatchObject({ from_cache: true, money_in_out: null, money_in_out_unreadable: true });
    } finally {
      console.error = orig;
    }
  });
});
