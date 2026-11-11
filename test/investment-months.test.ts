import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// An investment account's months imported from Vanguard's Performance page
// (lib/investment-months.ts): the route that imports and undoes them, every
// field checked, only on a live Vanguard investment account; the store read
// across the account's links, the newest import counting; an import refused
// when another device imported since, or when the account keeps as many as
// it may; every undo taking out only its own record, so what was there before
// comes back exactly; and the activity route answering them fresh.

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
const { MAX_IMPORTS, isInvestmentMonths, parseMonthsChange } = await import('@/lib/investment-months');
const { investmentMonthsStore, readInvestmentMonths } = await import('@/lib/investment-months-store');
const route = await import('@/app/api/investment-months/route');
const activity = await import('@/app/api/investment-activity/route');

const VANGUARD = 'ins_115616';

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await route.POST(new Request('http://x/api/investment-months', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }));
  return { status: res.status, body: await res.json() };
}

async function get(account_id: string) {
  const res = await route.GET(new Request(`http://x/api/investment-months?account_id=${account_id}`));
  return { status: res.status, body: await res.json() };
}

/** A Plaid connection as a load leaves it: stored, remembered, in the directory. */
async function connect(item_id: string, accounts: { account_id: string; type: string }[], institution_id: string | null = VANGUARD) {
  await saveItem(ctx, { item_id, institution_name: 'Vanguard', institution_id, encrypted_access_token: await encrypt(TEST_CTX, 'tok') } as never);
  const inst = { item_id, institution_name: 'Vanguard', institution_id, error: null, accounts: accounts.map((a) => ({ ...a, name: a.account_id, mask: '4421', official_name: null, subtype: null, balance: 10, currency: 'USD' })) };
  await rememberAccounts(ctx, [inst as never]);
  await recordDirectory(ctx, [inst as never]);
}

/** `n` months from `from`, each $100 in and $5 of returns, from `balance`. */
function months(from: string, n: number, balance = 0) {
  const out: { month: string; net: number; returns: number; end: number }[] = [];
  let [y, m] = from.split('-').map(Number);
  let end = balance;
  for (let i = 0; i < n; i++) {
    end = Math.round((end + 105) * 100) / 100;
    out.push({ month: `${y}-${String(m).padStart(2, '0')}`, net: 100, returns: 5, end });
    m = m === 12 ? 1 : m + 1;
    if (m === 1) y++;
  }
  return out;
}

const importBody = (over: Record<string, unknown> = {}) => ({ action: 'import', account_id: 'inv', file_name: 'Performance.pdf', start: { month: '2019-01', balance: 0 }, months: months('2019-01', 24), currency: 'USD', counting: null, ...over });

/** What the store holds, decoded, by id. */
const snapshot = async () => Object.fromEntries(await investmentMonthsStore.getAll(ctx));

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
});

describe('what the route refuses', () => {
  const two = months('2019-01', 2);
  const cases: [string, unknown, RegExp][] = [
    ['an array', [], /JSON/],
    ['no account', { action: 'import', start: { month: '2019-01', balance: 0 }, months: two }, /account id/],
    ['__proto__', importBody({ account_id: '__proto__' }), /account id/],
    ['no action', { account_id: 'inv' }, /import or undo/],
    ['an extra field', importBody({ basis: 3 }), /basis isn’t part of an import/],
    ['a first month before 1970', importBody({ start: { month: '1969-12', balance: 0 } }), /from 1970/],
    ['a beginning balance below zero', importBody({ start: { month: '2019-01', balance: -1 } }), /beginning balance/],
    ['no months', importBody({ months: [] }), /at least one month/],
    ['a month missing', importBody({ months: [two[0], { ...two[1], month: '2019-03' }] }), /follow on from 2019-01/],
    ['a month that doesn’t add up', importBody({ months: [two[0], { ...two[1], end: two[1].end + 0.01 }] }), /2019-02 doesn’t add up/],
    ['a month with more', importBody({ months: [{ ...two[0], basis: 1 }] }), /month, net, returns and end/],
    ['a net as text', importBody({ months: [{ ...two[0], net: '100' }] }), /deposits and withdrawals must be an amount/],
    ['a typed month not in it', importBody({ typed: ['2030-01'] }), /typed months/],
    ['a counting id that is not one', importBody({ counting: 'x' }), /import id/],
    ['an undo with more', { action: 'undo', account_id: 'inv', import_id: 'abcdefgh-1', months: [] }, /account and the import alone/],
    ['an undo with no import', { action: 'undo', account_id: 'inv' }, /import id/],
  ];
  for (const [name, body, message] of cases) {
    test(name, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    });
  }

  test('amounts are kept to the cent', () => {
    const change = parseMonthsChange(importBody({ start: { month: '2019-01', balance: 0.004 }, months: [{ month: '2019-01', net: 100.001, returns: 5, end: 105.004 }] }));
    expect(change).toMatchObject({ action: 'import', start: { balance: 0 }, months: [{ net: 100, returns: 5, end: 105 }] });
  });

  test('a request from another site changes nothing', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    expect((await post(importBody(), { origin: 'https://elsewhere.example' })).status).toBe(403);
    expect(await investmentMonthsStore.count(ctx)).toBe(0);
  });

  test('only a live Vanguard investment account takes an import', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }, { account_id: 'chk', type: 'depository' }]);
    await connect('i2', [{ account_id: 'wf', type: 'investment' }], 'ins_115617');
    expect((await post(importBody({ account_id: 'nope' }))).status).toBe(404);
    expect(await post(importBody({ account_id: 'chk' }))).toEqual({ status: 400, body: { error: 'Past months are for investment accounts' } });
    expect(await post(importBody({ account_id: 'wf' }))).toEqual({ status: 400, body: { error: 'Nya reads Vanguard’s Performance page only for an account linked at Vanguard' } });
    expect(await investmentMonthsStore.count(ctx)).toBe(0);
  });

  test('a connection the directory has no institution for is read by its stored one', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }], null);
    await saveItem(ctx, { item_id: 'i1', institution_name: 'Vanguard', institution_id: VANGUARD, encrypted_access_token: await encrypt(TEST_CTX, 'tok') } as never);
    expect((await post(importBody())).status).toBe(200);
  });
});

describe('importing', () => {
  test('stores the months as sent, answers them, and lists them', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    const res = await post(importBody({ typed: ['2019-03'] }));
    expect(res.status).toBe(200);
    const [record] = res.body.investment_months.imports;
    expect(record).toMatchObject({ source: 'vanguard-performance', file_name: 'Performance.pdf', start: { month: '2019-01', balance: 0 }, months: months('2019-01', 24), currency: 'USD', typed: ['2019-03'] });
    expect(isInvestmentMonths(res.body.investment_months)).toBe(true);
    expect(await investmentMonthsStore.get(ctx, 'inv')).toEqual(res.body.investment_months);
    expect(await get('inv')).toEqual({ status: 200, body: res.body });
    // No typed months, no field.
    const next = await post(importBody({ counting: record.id }));
    expect(Object.hasOwn(next.body.investment_months.imports[1], 'typed')).toBe(false);
  });

  test('refused when another device imported since the file was checked', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    const first = (await post(importBody())).body.investment_months.imports[0];
    const before = await snapshot();
    // Checked against nothing, but one counts now.
    const res = await post(importBody({ counting: null }));
    expect(res).toEqual({ status: 409, body: { error: 'The imports changed on another device while you checked this file. Check it again against what’s here now before importing it.', needs: 'review' } });
    expect(await snapshot()).toEqual(before);
    expect((await post(importBody({ counting: first.id }))).status).toBe(200);
  });

  test('refused past the most an account keeps, until one is undone', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    let counting: string | null = null;
    for (let i = 0; i < MAX_IMPORTS; i++) {
      const res = await post(importBody({ counting }));
      expect(res.status).toBe(200);
      counting = res.body.investment_months.imports.at(-1).id;
    }
    const res = await post(importBody({ counting }));
    expect(res).toEqual({ status: 409, body: { error: 'This account has as many imports as Nya keeps. Undo an old one to import this file.', needs: 'undo' } });
    const oldest = (await readInvestmentMonths(ctx, 'inv'))!.imports[0].id;
    expect((await post({ action: 'undo', account_id: 'inv', import_id: oldest })).status).toBe(200);
    expect((await post(importBody({ counting }))).status).toBe(200);
  });
});

describe('undoing, without loss', () => {
  test('each undo restores exactly what was there before its import, in either order', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    const empty = await snapshot();
    const a = (await post(importBody())).body.investment_months.imports[0];
    const afterA = await snapshot();
    const b = (await post(importBody({ start: { month: '2018-01', balance: 0 }, months: months('2018-01', 36), counting: a.id }))).body.investment_months.imports[1];
    expect((await readInvestmentMonths(ctx, 'inv'))!.imports.map((i) => i.id)).toEqual([a.id, b.id]);

    // The newer first: back to A alone, then to nothing, the entry gone.
    expect((await post({ action: 'undo', account_id: 'inv', import_id: b.id })).body).toEqual({ investment_months: afterA.inv });
    expect(await snapshot()).toEqual(afterA);
    expect((await post({ action: 'undo', account_id: 'inv', import_id: a.id })).body).toEqual({ investment_months: null });
    expect(await snapshot()).toEqual(empty);
    expect(await fake.hgetall(ctxKey('investment-months'))).toBeFalsy();

    // The older first: B is left as it was.
    const a2 = (await post(importBody())).body.investment_months.imports[0];
    const b2 = (await post(importBody({ file_name: 'Later.pdf', counting: a2.id }))).body.investment_months.imports[1];
    expect((await post({ action: 'undo', account_id: 'inv', import_id: a2.id })).body.investment_months.imports).toEqual([b2]);
    expect((await post({ action: 'undo', account_id: 'inv', import_id: b2.id })).body).toEqual({ investment_months: null });
    expect(await investmentMonthsStore.count(ctx)).toBe(0);
  });

  test('an import that isn’t there is a 404, and nothing changes', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    await post(importBody());
    const before = await snapshot();
    const res = await post({ action: 'undo', account_id: 'inv', import_id: 'not-there-1' });
    expect(res).toEqual({ status: 404, body: { error: 'That import isn’t there any more: the list shows what is.' } });
    expect(await snapshot()).toEqual(before);
  });
});

describe('read through account links', () => {
  test('imports under an earlier id count for the account it was linked to; a new one goes under the current id', async () => {
    // Imported while the account had its old id, which no connection lists now.
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    const old = (await post(importBody())).body.investment_months.imports[0];
    fake.reset();
    await registerTestContainer(fake);
    await investmentMonthsStore.set(ctx, 'inv', { imports: [old] });
    await connect('i2', [{ account_id: 'new', type: 'investment' }]);
    expect(await readInvestmentMonths(ctx, 'new')).toBeNull();
    await linkAccounts(ctx, 'inv', 'new', {});
    expect((await readInvestmentMonths(ctx, 'new'))!.imports).toEqual([old]);

    const res = await post(importBody({ account_id: 'new', counting: old.id }));
    expect(res.status).toBe(200);
    expect(res.body.investment_months.imports.map((i: { id: string }) => i.id)[0]).toBe(old.id);
    expect([...(await investmentMonthsStore.getAll(ctx)).keys()].sort()).toEqual(['inv', 'new']);
    // Undone from whichever id holds it.
    expect((await post({ action: 'undo', account_id: 'new', import_id: old.id })).body.investment_months.imports).toHaveLength(1);
    expect([...(await investmentMonthsStore.getAll(ctx)).keys()]).toEqual(['new']);
  });

  test('a paused link, whose earlier id is live again, carries nothing across', async () => {
    await connect('i1', [{ account_id: 'new', type: 'investment' }, { account_id: 'old', type: 'investment' }]);
    await linkAccounts(ctx, 'old', 'new', {});
    const res = await post(importBody({ account_id: 'old' }));
    expect(res.status).toBe(200);
    expect(await readInvestmentMonths(ctx, 'new')).toBeNull();
  });
});

describe('disconnecting and forgetting', () => {
  test('kept while the account is an earlier one, and forgotten with it', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    const imported = (await post(importBody())).body.investment_months;
    fake.reset();
    await registerTestContainer(fake);
    await recordDirectory(ctx, [{ item_id: 'item_gone', institution_name: 'Vanguard', institution_id: VANGUARD, error: null, accounts: [{ account_id: 'inv', type: 'investment', subtype: 'brokerage' }] }] as never);
    await investmentMonthsStore.set(ctx, 'inv', imported);
    expect(await readInvestmentMonths(ctx, 'inv')).toEqual(imported);
    await forgetEarlierAccount(ctx, 'inv');
    expect(await investmentMonthsStore.count(ctx)).toBe(0);
  });
});

describe('the activity route', () => {
  const PAYLOAD = { txns: [], ytd_contributions: 0, ytd_rollovers: 0, flows: [], flows_from: '2026-06-01', flows_to: '2026-11-09', note: null, contributions_12m_activity_from: null, moves: [] };
  const read = async () => (await activity.GET(new Request('http://x/api/investment-activity?id=inv&item_id=i1'))).json();

  test('answers the imports fresh beside a cached payload, so an import shows at once', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    await writeAccountCache(ctx, 'i1:inv', PAYLOAD);
    expect(await read()).toMatchObject({ from_cache: true, investment_months: null, money_in_out: null });
    const imported = (await post(importBody())).body.investment_months;
    expect(await read()).toMatchObject({ from_cache: true, flows_from: '2026-06-01', investment_months: imported });
  });

  test('imports that can’t be read are said, and the activity and totals still answer', async () => {
    await connect('i1', [{ account_id: 'inv', type: 'investment' }]);
    await writeAccountCache(ctx, 'i1:inv', PAYLOAD);
    await fake.hset(ctxKey('investment-months'), { inv: 'not-ciphertext-but-long-enough-to-be-tried' });
    const orig = console.error;
    console.error = () => {};
    try {
      expect(await read()).toMatchObject({ from_cache: true, money_in_out: null, investment_months: null, investment_months_unreadable: true });
    } finally {
      console.error = orig;
    }
  });
});
