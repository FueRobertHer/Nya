import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Making and changing a manual account, moved out of app/api/manual-accounts
// into lib/manual-account-writes.ts so the API's writes run the same code:
// each write one compare-and-set on the account's field, whatever lands
// between its read and its write; a change of type, like a moved balance,
// asks for the estimated history to be rebuilt; and the balance write alone
// (the ingest route's, and the API's) refuses an amount owed below zero
// against the type as it is when it writes.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy({}, { get: () => async () => { throw new Error('Plaid must not be called'); } }),
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { decrypt } = await import('@/lib/crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { getManualAccount, setManualBalance, changeManualAccount } = await import('@/lib/manual');
const { markBackfillDone, isBackfillDone } = await import('@/lib/history');
const { saveAccountEdit, setAccountBalance, createManualAccount, AccountEditRefused, OWED_FLIP } = await import('@/lib/manual-account-writes');
const route = await import('@/app/api/manual-accounts/route');

const ctx = TEST_CTX;
const FORM = { name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: null, balance: 100 };

async function call(method: 'POST' | 'PATCH', body: unknown): Promise<{ status: number; body: any }> {
  const res = await (method === 'POST' ? route.POST : route.PATCH)(
    new Request('http://localhost/api/manual-accounts', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  );
  return { status: res.status, body: await res.json() };
}
const stored = async (id: string) => JSON.parse(await decrypt(ctx, (await fake.hget<string>(ctxKey('manual:accounts'), id))!));

/** Runs `meanwhile` just before the next run of the seam's script `name`
 *  reaches storage, as another device would. */
function atNextScript(name: string, meanwhile: () => Promise<unknown>) {
  const original = fake.eval.bind(fake);
  (fake as any).eval = async (script: string, keys: string[], args: string[]) => {
    if (script.split('\n', 1)[0] !== `-- nya:${name}`) return original(script, keys, args);
    delete (fake as any).eval;
    await meanwhile();
    return original(script, keys, args);
  };
}

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  delete (fake as any).eval;
});

describe('the Update form, through the shared function', () => {
  test('a change of type asks for the estimated history to be rebuilt, as a moved balance does; a rename does not; across to owed is refused', async () => {
    const { account } = (await call('POST', FORM)).body;
    const id = account.account_id;
    await markBackfillDone(ctx);
    expect((await call('PATCH', { ...FORM, account_id: id, name: 'Purse' })).status).toBe(200);
    expect(await isBackfillDone(ctx)).toBe(true);
    // Within one side (held): rebuilt.
    expect((await call('PATCH', { ...FORM, account_id: id, name: 'Purse', type: 'other' })).status).toBe(200);
    expect(await isBackfillDone(ctx)).toBe(false);
    await markBackfillDone(ctx);
    // Across to owed: refused, nothing written, nothing rebuilt
    // (test/owed-flip.test.ts has every reader).
    const across = await call('PATCH', { ...FORM, account_id: id, name: 'Coins', type: 'credit' });
    expect([across.status, across.body.error]).toEqual([409, OWED_FLIP]);
    expect(await isBackfillDone(ctx)).toBe(true);
    expect(await stored(id)).toMatchObject({ name: 'Purse', type: 'other', balance: 100, updated_at: account.updated_at });
  });

  test('a balance pushed between its read and its write is read again: what it compares is from the attempt that wrote', async () => {
    const { account } = (await call('POST', FORM)).body;
    const id = account.account_id;
    await markBackfillDone(ctx);
    // The form says 250; a script pushes 250 just before the form's write.
    atNextScript('repo-update-entry', () => setManualBalance(ctx, id, 250, new Date('2026-10-20T08:00:00Z')));
    const saved = await saveAccountEdit(ctx, id, { fields: { ...FORM, type: 'depository', balance: 250 } });
    expect(saved).toMatchObject({ balanceChanged: false, typeChanged: false });
    // The push's time stands: the edit moved no balance.
    expect(await stored(id)).toMatchObject({ balance: 250, updated_at: '2026-10-20T08:00:00.000Z' });
    expect(await isBackfillDone(ctx)).toBe(true);
  });

  test('a rename landing between its read and its write is kept by a balance push', async () => {
    const { account } = (await call('POST', FORM)).body;
    const id = account.account_id;
    atNextScript('repo-update-entry', () => changeManualAccount(ctx, id, (a) => (a ? { ...a, name: 'Renamed' } : null)));
    expect(await setManualBalance(ctx, id, 42)).toBe('set');
    expect(await stored(id)).toMatchObject({ name: 'Renamed', balance: 42 });
  });
});

describe('the balance alone', () => {
  test('a negative balance is refused against the type as it is when it writes, not as it was read', async () => {
    const { account } = (await call('POST', FORM)).body;
    const id = account.account_id;
    // Turned into a card between the read and the write.
    atNextScript('repo-update-entry', () => changeManualAccount(ctx, id, (a) => (a ? { ...a, type: 'credit' } : null)));
    expect(await setManualBalance(ctx, id, -5)).toBe('owed-negative');
    expect(await stored(id)).toMatchObject({ type: 'credit', balance: 100 });
    await changeManualAccount(ctx, id, (a) => (a ? { ...a, type: 'depository' } : null));
    atNextScript('repo-update-entry', () => changeManualAccount(ctx, id, (a) => (a ? { ...a, type: 'loan' } : null)));
    await expect(setAccountBalance(ctx, id, -5)).rejects.toBeInstanceOf(AccountEditRefused);
    expect((await getManualAccount(ctx, id))!.balance).toBe(100);
  });

  test('the same to the cent writes nothing; another figure sets it, rebuilds the estimate and records nothing', async () => {
    const { account } = (await call('POST', FORM)).body;
    const id = account.account_id;
    await markBackfillDone(ctx);
    expect((await setAccountBalance(ctx, id, 100.004)).kind).toBe('same');
    expect(await isBackfillDone(ctx)).toBe(true);
    const set = await setAccountBalance(ctx, id, 120.5, { now: new Date('2026-10-21T09:00:00Z') });
    expect(set).toMatchObject({ kind: 'set', account: { balance: 120.5, updated_at: '2026-10-21T09:00:00.000Z' } });
    expect(await isBackfillDone(ctx)).toBe(false);
    // No history point: the daily snapshot records it.
    expect(await fake.hgetall(ctxKey('history:net-worth'))).toBeNull();
    expect((await setAccountBalance(ctx, 'manual_gone', 1)).kind).toBe('missing');
  });
});

describe('making one', () => {
  test('under the id it is given, once: a create sent again finds its own, and never writes over another', async () => {
    const made = await createManualAccount(ctx, { name: 'Jar', institution_name: 'Home', type: 'depository', subtype: null, balance: 5 }, 'EUR', { id: 'manual_jar' });
    expect(made).toMatchObject({ created: true, account: { account_id: 'manual_jar', currency: 'EUR' } });
    const again = await createManualAccount(ctx, { name: 'Other', institution_name: 'Home', type: 'depository', subtype: null, balance: 9 }, undefined, { id: 'manual_jar' });
    expect(again).toMatchObject({ created: false, account: { name: 'Jar', balance: 5 } });
    expect(await createManualAccount(ctx, { name: 'One more', institution_name: 'Home', type: 'depository', subtype: null, balance: 1 }, undefined, { id: 'manual_x', limit: 1 })).toEqual({
      limit: 1,
    });
  });

  test('refused for whatever the Add form refuses, whoever asks: the balance ceiling, an owed balance below zero, a currency', async () => {
    const jar = { name: 'Jar', institution_name: 'Home', type: 'depository' as const, subtype: null, balance: 5 };
    for (const [fields, currency, message] of [
      [{ ...jar, balance: 9.9e12 }, undefined, 'Invalid balance'],
      [{ ...jar, type: 'credit' as const, balance: -1 }, undefined, 'Credit and loan balances are the amount owed, so they cannot be negative'],
      [{ ...jar, name: '  ' }, undefined, 'Name and institution are required'],
      [jar, 'XYZ', 'The currency is a three-letter ISO code, like USD or EUR'],
    ] as const) {
      const err = await createManualAccount(ctx, fields, currency, { id: 'manual_bad' }).catch((e) => e);
      expect([err instanceof AccountEditRefused, err.message, err.status]).toEqual([true, message, 400]);
    }
    expect(await getManualAccount(ctx, 'manual_bad')).toBeNull();
  });

  test('a balance set with `rebuild` asks it whether to rebuild the estimate, and checks `expect` in the step that sets it', async () => {
    const { account } = (await call('POST', FORM)).body;
    await markBackfillDone(ctx);
    await setAccountBalance(ctx, account.account_id, 130, { rebuild: async () => false });
    expect(await isBackfillDone(ctx)).toBe(true);
    await setAccountBalance(ctx, account.account_id, 140, { rebuild: async () => true });
    expect(await isBackfillDone(ctx)).toBe(false);
    const refused = await setAccountBalance(ctx, account.account_id, 150, {
      expect: () => {
        throw new AccountEditRefused('It changed', 409);
      },
    }).catch((e) => e);
    expect(refused.message).toBe('It changed');
    expect((await getManualAccount(ctx, account.account_id))!.balance).toBe(140);
  });
});
