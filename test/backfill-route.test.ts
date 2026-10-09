import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// POST /api/backfill (app/api/backfill/route.ts): estimated history, walked
// back from today's balances. Every estimate starts from every institution's
// balance, so a balance Plaid doesn't give stops the run with nothing saved,
// and the answer says so: a 503 naming what happened, never a 500 that would
// blame Nya, nor an estimate built without that institution.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const fake = new FakeRedis({ deserialize: true });
// Nothing may be written outside a container (#53).
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const account = {
  account_id: 'acct_chk',
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask: '1111',
  balances: { available: 1000, current: 1000, limit: null, iso_currency_code: 'USD' },
};
// What Plaid answers: the balance call fails with `balancesFail` when it is
// set. mock.module is process-wide, so every call the route makes is stubbed.
const plaid = { balancesFail: null as unknown };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async () => {
      if (plaid.balancesFail) throw plaid.balancesFail;
      return { data: { item: { institution_id: 'ins_1' }, accounts: [account] } };
    },
    transactionsSync: async (req: any) => ({
      data: {
        added: req.cursor
          ? []
          : [
              {
                transaction_id: 't1',
                account_id: 'acct_chk',
                amount: 50,
                iso_currency_code: 'USD',
                date: daysAgo(10),
                name: 'GROCER',
                merchant_name: 'Grocer',
                pending: false,
                counterparties: [],
                personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' },
              },
            ],
        modified: [],
        removed: [],
        accounts: [account],
        next_cursor: 'c1',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

const { POST } = await import('@/app/api/backfill/route');
const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { isBackfillDone } = await import('@/lib/history');
const { forgetEpochs } = await import('@/lib/sessions');

const errors: unknown[][] = [];
const origError = console.error;
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  plaid.balancesFail = null;
  errors.length = 0;
  console.error = (...args: unknown[]) => void errors.push(args);
  await registerTestContainer(fake);
  await saveItem(TEST_CTX, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-chase') });
});
afterEach(() => {
  console.error = origError;
});

const backfill = async () => {
  const res = await POST();
  return { status: res.status, body: await res.json() };
};
/** Everything stored, to show that a stopped run wrote nothing. */
const stored = () => JSON.stringify([[...fake.strings].sort(), [...fake.hashes].map(([key, h]) => [key, [...h].sort()]).sort()]);
/** A timeout, as the Plaid client (axios underneath) reports one: no answer at all. */
const timeout = () =>
  Object.assign(new Error('timeout of 45000ms exceeded'), {
    isAxiosError: true,
    code: 'ECONNABORTED',
    config: { url: 'https://sandbox.plaid.com/accounts/get', method: 'post' },
  });
/** An error in Plaid's answer, as the Plaid client reports one. */
const answered = (error_type: string, error_code: string) =>
  Object.assign(new Error('Request failed with status code 400'), {
    isAxiosError: true,
    config: { url: 'https://sandbox.plaid.com/accounts/get', method: 'post' },
    response: { status: 400, data: { error_type, error_code } },
  });

describe('when Plaid gives no balances', () => {
  test('no answer at all is a 503 saying Plaid could not be reached; nothing is saved, and a later run builds it', async () => {
    plaid.balancesFail = timeout();
    const before = stored();
    expect(await backfill()).toEqual({
      status: 503,
      body: { error: "Plaid couldn't be reached for Chase's balances, so no estimated history was saved. It is tried again on a later load." },
    });
    expect(stored()).toBe(before);
    expect(await isBackfillDone(TEST_CTX)).toBe(false);
    // Once Plaid answers, the next run builds it.
    plaid.balancesFail = null;
    const { status, body } = await backfill();
    expect(status).toBe(200);
    expect(body.backfilled).toBeGreaterThan(0);
    expect(await isBackfillDone(TEST_CTX)).toBe(true);
  });

  test('Plaid or the bank failing for now is a 503 naming the code, tried again on a later load, with nothing saved', async () => {
    // As the health view waits them out: an outage at the bank, Plaid's own
    // errors and limits, data still being prepared, and a code it doesn't know.
    for (const [type, code] of [
      ['INSTITUTION_ERROR', 'INSTITUTION_DOWN'],
      ['API_ERROR', 'INTERNAL_SERVER_ERROR'],
      ['RATE_LIMIT_EXCEEDED', 'ACCOUNTS_LIMIT'],
      ['ITEM_ERROR', 'PRODUCT_NOT_READY'],
      ['ITEM_ERROR', 'A_CODE_PLAID_ADDS_LATER'],
    ]) {
      plaid.balancesFail = answered(type, code);
      const before = stored();
      expect([code, await backfill()]).toEqual([
        code,
        { status: 503, body: { error: `Plaid couldn't give Chase's balances (${code}), so no estimated history was saved. It is tried again on a later load.` } },
      ]);
      expect(stored()).toBe(before);
      expect(await isBackfillDone(TEST_CTX)).toBe(false);
    }
  });

  test('a connection that needs reconnecting, or removing, first is skipped as when its transactions can’t be read: never "tried again" on its own', async () => {
    for (const [type, code] of [
      ['ITEM_ERROR', 'ITEM_LOGIN_REQUIRED'],
      ['ITEM_ERROR', 'ACCESS_NOT_GRANTED'],
      ['ITEM_ERROR', 'ITEM_LOCKED'],
      ['ITEM_ERROR', 'USER_PERMISSION_REVOKED'],
      ['ITEM_ERROR', 'ITEM_NOT_FOUND'],
      ['ITEM_ERROR', 'NO_ACCOUNTS'],
    ]) {
      plaid.balancesFail = answered(type, code);
      const before = stored();
      expect([code, await backfill()]).toEqual([code, { status: 200, body: { skipped: true, reason: 'institutions not ready' } }]);
      expect(stored()).toBe(before);
      expect(await isBackfillDone(TEST_CTX)).toBe(false);
    }
  });

  test("Plaid refusing Nya's own keys, settings or stored token is the server's own failure: a 500, logged with the code", async () => {
    for (const [type, code] of [
      ['INVALID_INPUT', 'INVALID_API_KEYS'],
      ['INVALID_INPUT', 'INVALID_ACCESS_TOKEN'],
      ['INVALID_INPUT', 'UNAUTHORIZED_ENVIRONMENT'],
      ['INVALID_REQUEST', 'MISSING_FIELDS'],
    ]) {
      errors.length = 0;
      plaid.balancesFail = answered(type, code);
      const before = stored();
      expect([code, await backfill()]).toEqual([code, { status: 500, body: { error: 'Backfill failed' } }]);
      expect([code, JSON.stringify(errors).includes(code)]).toEqual([code, true]);
      expect(stored()).toBe(before);
      expect(await isBackfillDone(TEST_CTX)).toBe(false);
    }
  });

  test('the log names the call, never the access token nor the institution', async () => {
    // As an error from outside the scrubbing client could carry it.
    plaid.balancesFail = Object.assign(timeout(), {
      config: { url: 'https://sandbox.plaid.com/accounts/get', method: 'post', data: '{"access_token":"access-sandbox-chase"}' },
    });
    expect((await backfill()).status).toBe(503);
    const logged = JSON.stringify(errors);
    expect(logged).toContain('POST /accounts/get');
    expect(logged).toContain('ECONNABORTED');
    expect(logged).not.toContain('access-sandbox-chase');
    expect(logged).not.toContain('Chase');
  });

  test('anything else is still the server’s own failure', async () => {
    // A stored token that can't be decrypted is Nya's to fix, not Plaid's.
    await saveItem(TEST_CTX, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: 'not-a-ciphertext-at-all' });
    expect(await backfill()).toEqual({ status: 500, body: { error: 'Backfill failed' } });
  });
});
