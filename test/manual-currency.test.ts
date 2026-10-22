import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';
import { ecbHash } from './fx-fixture';

// A manual account's currency (lib/manual.ts, app/api/manual-accounts): chosen
// when it is made or updated, stored with it as the field an account kept
// from a connector already has (three capitals, absent for US dollars, which
// the release before reads and keeps the same way), corrected alone from the
// choice of a home currency, never changing the balance's number, and what
// net worth converts the account from.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('Plaid must not be called');
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { decrypt } = await import('@/lib/crypto');
const { forgetEpochs } = await import('@/lib/sessions');
const { getManualAccount, getManualAccounts, setManualBalance, toInstitutions } = await import('@/lib/manual');
const { markBackfillDone } = await import('@/lib/history');
const { readCache, writeCache, CacheKey } = await import('@/lib/cache');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
const { importSettingsStore } = await import('@/lib/import/store');
const route = await import('@/app/api/manual-accounts/route');
const netWorth = await import('@/app/api/net-worth/route');

const ctx = TEST_CTX;
const FORM = { name: 'Savings abroad', institution_name: 'Sparkasse', type: 'depository', subtype: null, balance: 2000 };

type Handler = (req: Request) => Promise<Response>;
async function call(handler: Handler, method: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await handler(new Request('http://localhost/api/manual-accounts', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
const add = (body: unknown) => call(route.POST, 'POST', body);
const update = (body: unknown) => call(route.PATCH, 'PATCH', body);
/** The record as stored, decrypted: what any release reads. */
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

describe('choosing it', () => {
  test('when the account is made, stored as a kept account’s is: none for dollars', async () => {
    const eur = await add({ ...FORM, currency: 'EUR' });
    expect(eur.status).toBe(200);
    expect(eur.body.account).toMatchObject({ balance: 2000, currency: 'EUR' });
    expect(await stored(eur.body.account.account_id)).toEqual({ ...FORM, account_id: eur.body.account.account_id, updated_at: eur.body.account.updated_at, currency: 'EUR' });
    // Dollars, chosen or not (a page from before sends none): no field, as
    // every account typed before it could be chosen.
    for (const given of [{ currency: 'USD' }, {}]) {
      const usd = await add({ ...FORM, ...given });
      expect(usd.status).toBe(200);
      expect(Object.keys(await stored(usd.body.account.account_id))).not.toContain('currency');
    }
    const shown = toInstitutions(await getManualAccounts(ctx))[0].accounts.map((a) => a.currency).sort();
    expect(shown).toEqual(['EUR', 'USD', 'USD']);
  });

  test('a currency that isn’t one is refused, and nothing is stored', async () => {
    for (const currency of ['eur', 'XYZ', 'EURO', '', null, 12]) {
      const r = await add({ ...FORM, currency });
      expect([currency, r.status, r.body.error]).toEqual([currency, 400, 'The currency is a three-letter ISO code, like USD or EUR']);
    }
    expect(await getManualAccounts(ctx)).toEqual([]);
  });

  test('when it is updated: the one chosen, or its own from a page that names none; the balance as typed', async () => {
    const { account } = (await add({ ...FORM, currency: 'EUR' })).body;
    const id = account.account_id;
    expect((await update({ ...FORM, account_id: id, currency: 'GBP' })).status).toBe(200);
    expect(await stored(id)).toMatchObject({ balance: 2000, currency: 'GBP' });
    expect((await update({ ...FORM, account_id: id, name: 'Renamed' })).status).toBe(200);
    expect(await stored(id)).toMatchObject({ name: 'Renamed', balance: 2000, currency: 'GBP' });
    expect((await update({ ...FORM, account_id: id, currency: 'USD' })).status).toBe(200);
    expect(Object.keys(await stored(id))).not.toContain('currency');
    expect((await update({ ...FORM, account_id: id, currency: 'usd' })).status).toBe(400);
  });
});

describe('correcting it alone', () => {
  test('changes the currency and nothing else, keeping a balance pushed meanwhile; the cache goes, the estimated history stays', async () => {
    const { account } = (await add(FORM)).body;
    const id = account.account_id;
    await writeCache(ctx, CacheKey.NetWorth, { institutions: [] });
    await markBackfillDone(ctx);
    // A scripted push lands between the read and the write: read again, kept.
    atNextScript('repo-update-entry', () => setManualBalance(ctx, id, 2500));
    const r = await update({ account_id: id, currency: 'EUR' });
    expect(r.status).toBe(200);
    const pushed = await getManualAccount(ctx, id);
    expect(pushed).toMatchObject({ name: FORM.name, balance: 2500, currency: 'EUR' });
    expect(r.body.account).toEqual(pushed);
    expect(await readCache(ctx, CacheKey.NetWorth)).toBeNull();
    expect(fake.strings.has(ctxKey('history:backfill-done'))).toBe(true);
  });

  test('to the currency it is in writes nothing; a missing account or a currency that isn’t one is refused', async () => {
    const { account } = (await add({ ...FORM, currency: 'EUR' })).body;
    const before = await fake.hget<string>(ctxKey('manual:accounts'), account.account_id);
    expect((await update({ account_id: account.account_id, currency: 'EUR' })).status).toBe(200);
    expect(await fake.hget<string>(ctxKey('manual:accounts'), account.account_id)).toBe(before);
    expect((await update({ account_id: 'manual_gone', currency: 'EUR' })).status).toBe(404);
    expect(await update({ account_id: account.account_id, currency: 'XYZ' })).toEqual({ status: 400, body: { error: 'The currency is a three-letter ISO code, like USD or EUR' } });
  });
});

describe('what its imported files taught', () => {
  /** What files of each kind taught; `ofx` null for an OFX file whose
   *  statement said its currency, so none was kept. */
  const taught = (currency: string, ofx: string | null = currency) => ({
    version: 1 as const,
    csv: { columns: { Date: 'date', Amount: 'amount' }, sign: 'negative-out' as const, decimal: null, date_order: null, delimiter: ',', currency },
    ofx: { statement: null, flip: false, ...(ofx ? { currency: ofx } : {}) },
    qif: { date_order: null, decimal: null, flip: false, currency },
    updated_at: '2026-10-01T12:00:00.000Z',
  });

  test('follows a correction: the old currency goes, so the next file is read in the new one', async () => {
    const { account } = (await add(FORM)).body;
    await importSettingsStore.set(ctx, account.account_id, taught('USD'));
    expect((await update({ account_id: account.account_id, currency: 'EUR' })).status).toBe(200);
    const after = await importSettingsStore.get(ctx, account.account_id);
    // OFX's falls back to the account's own; CSV's and QIF's, which the
    // settings always hold, become it. The rest is as it was.
    expect(after).toEqual(taught('EUR', null));
    // Through the form too.
    expect((await update({ ...FORM, account_id: account.account_id, currency: 'GBP' })).status).toBe(200);
    expect((await importSettingsStore.get(ctx, account.account_id))?.qif?.currency).toBe('GBP');
  });

  test('keeps a currency chosen apart from the account’s, and writes nothing without settings', async () => {
    const { account } = (await add(FORM)).body;
    await importSettingsStore.set(ctx, account.account_id, taught('CHF'));
    const before = await fake.hget<string>(ctxKey('import-settings'), account.account_id);
    expect((await update({ account_id: account.account_id, currency: 'EUR' })).status).toBe(200);
    expect(await fake.hget<string>(ctxKey('import-settings'), account.account_id)).toBe(before);
    const other = (await add({ ...FORM, name: 'Other' })).body.account;
    expect((await update({ account_id: other.account_id, currency: 'EUR' })).status).toBe(200);
    expect(await importSettingsStore.get(ctx, other.account_id)).toBeNull();
  });
});

describe('net worth', () => {
  test('converts each manual account from its own currency, its balance as typed', async () => {
    await fake.hset(testKey('fx:ecb'), ecbHash());
    await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'USD' });
    const { account } = (await add({ ...FORM, currency: 'EUR' })).body;
    await add({ ...FORM, name: 'Checking', institution_name: 'Credit Union', balance: 1000 });
    const load = async () => (await (await netWorth.GET(new Request('http://localhost/api/net-worth?refresh=1'))).json()) as any;
    const partsOf = (b: any) => Object.fromEntries(b.base.parts.map((p: any) => [p.currency, [p.amount, p.converted]]));
    let body = await load();
    // The ECB's of 14 Sep 2026: 1 EUR = 1.1551 USD.
    expect(partsOf(body)).toEqual({ EUR: [2000, 2310.2], USD: [1000, 1000] });
    expect(body.base.net_worth).toBe(3310.2);
    // Corrected to pounds: converted from them, the number as typed.
    expect((await update({ account_id: account.account_id, currency: 'GBP' })).status).toBe(200);
    body = await load();
    // 2,000 × 1.1551 / 0.85598
    expect(partsOf(body)).toEqual({ GBP: [2000, 2698.89], USD: [1000, 1000] });
    const typed = body.institutions.flatMap((i: any) => i.accounts).find((a: any) => a.account_id === account.account_id);
    expect([typed.balance, typed.currency]).toEqual([2000, 'GBP']);
  });
});
