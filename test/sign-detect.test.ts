import { describe, expect, test, mock, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';
import { ecbHash } from './fx-fixture';

// How the operator's dry run and repair (lib/sign-repair.ts) tell which days
// of a manual account were counted the other way: a day is decided only when
// exactly one set of the day's accounts, counted the other way, explains its
// total; two sets that both do leave every account in them refused; a day
// with an account whose type isn't known decides nothing; a day nothing
// decides is never taken for one counted as now.
//
// Manual accounts in dollars beside a checking account at Plaid (1,000);
// Friday the 11th recorded under the release before, with a total.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const CHK = {
  account_id: 'chk',
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask: '1111',
  balances: { available: 1000, current: 1000, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null },
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async () => ({ data: { item: { institution_id: 'ins_1' }, accounts: [CHK] } }),
    investmentsHoldingsGet: async () => ({ data: { accounts: [], holdings: [], securities: [] } }),
    liabilitiesGet: async () => ({ data: { liabilities: {} } }),
    itemRemove: async () => ({ data: {} }),
  },
}));

const { encrypt, decrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
const { saveManualAccount } = await import('@/lib/manual');
const netWorthRoute = await import('@/app/api/net-worth/route');
const opsRoute = await import('@/app/api/ops/sign-repair/route');
const { explanations, signJobStore } = await import('@/lib/sign-repair');

const ctx = TEST_CTX;
/** Jobs under way, a finished job's settle record aside. */
const pendingIds = async () => {
  const out: string[] = [];
  for (const id of await signJobStore.ids(ctx)) if ((await signJobStore.get(ctx, id))?.kind !== 'settle') out.push(id);
  return out;
};
const NOW = Date.parse('2026-09-14T17:00:00Z');
const FRI = '2026-09-11';
const DAY = '2026-09-14';

const put = async (key: string, entries: Record<string, unknown>) => {
  for (const [field, value] of Object.entries(entries)) await fake.hset(ctxKey(key), { [field]: await encrypt(ctx, typeof value === 'string' ? value : JSON.stringify(value)) });
};
const stored = async (key: string, field: string) => JSON.parse(await decrypt(ctx, (await fake.hget<string>(ctxKey(key), field))!));
const ops = async (body: unknown) => {
  const res: Response = await opsRoute.POST(new Request('http://x/api/ops/sign-repair', { method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};
const dry = async () => (await ops({ container: ctx.container })).body.accounts as any[];
const repair = (account_id: string) => ops({ container: ctx.container, account_id, repair: true });
const home = async () => (await (await netWorthRoute.GET(new Request('http://x/api/net-worth?refresh=1'))).json()) as any;
const history = () => new Map([...fake.hashes].filter(([k]) => k.includes('history:')).map(([k, h]) => [k, new Map(h)]));
const manual = async (account_id: string, type: string, balance: number) =>
  saveManualAccount(ctx, { account_id, name: account_id, institution_name: 'Bank', type: type as any, subtype: null, balance, currency: 'USD', updated_at: new Date(NOW - 30 * 86_400_000).toISOString() });

const saved = { ...process.env };
beforeEach(async () => {
  setSystemTime(new Date(NOW));
  fake.reset();
  forgetEpochs();
  process.env.OPS_ENABLED = '1';
  process.env.OPS_SECRET = 's3cret';
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_bank', institution_name: 'Bank', encrypted_access_token: await encrypt(ctx, 'tok') });
  await fake.hset(testKey('fx:ecb'), ecbHash());
  await currencySettingsStore.set(ctx, { ...NO_SETTINGS, home: 'USD' });
});
afterEach(() => {
  process.env = { ...saved };
  setSystemTime();
});

describe('explanations of a day’s gap', () => {
  test('every set of accounts whose values, counted the other way, close it', () => {
    // Counted as now: A 1,000, B 4,000, C 5,000 (cents).
    const v = [
      ['a', 100000],
      ['b', 400000],
      ['c', 500000],
    ] as const;
    // Twice 5,000: A and B together, or C alone; none is in both.
    expect(explanations(v, 1000000)).toEqual({ count: 2, surely: new Set(), involved: new Set(['a', 'b', 'c']) });
    expect(explanations(v, 200000)).toEqual({ count: 1, surely: new Set(['a']), involved: new Set(['a']) });
    expect(explanations(v, 0)).toEqual({ count: 1, surely: new Set(), involved: new Set() });
    expect(explanations(v, 3)).toEqual({ count: 0, surely: new Set(), involved: new Set() });
    expect(explanations(v, 2)).toEqual({ count: 0, surely: new Set(), involved: new Set() });
    // Equal values: either explains it.
    expect(explanations([['x', 30000], ['y', 30000]], 60000)).toEqual({ count: 2, surely: new Set(), involved: new Set(['x', 'y']) });
    // A held 500 beside an owed 500: the card alone, or with both; the card is in each.
    expect(explanations([['card', 30000], ['h', 50000], ['o', -50000]], 60000)).toEqual({ count: 2, surely: new Set(['card']), involved: new Set(['card', 'h', 'o']) });
  });
});

describe('a day counted the other way for more than one account', () => {
  test('two flipped together, whose values add up to a third’s: all three refused, none touched', async () => {
    // A and B were cards and both became savings under the release before;
    // C was savings all along. Friday: 1,000 - 1,000 - 4,000 + 5,000.
    await manual('manual_a', 'depository', 1000);
    await manual('manual_b', 'depository', 4000);
    await manual('manual_c', 'depository', 5000);
    await put('history:accounts', { [FRI]: { chk: 1000, manual_a: 1000, manual_b: 4000, manual_c: 5000 } });
    await put('history:net-worth', { [FRI]: '1000' });
    await home();
    const raw = history();
    const reason = (id: string) => `The days ${id} was counted the other way can't be told exactly: nothing says how it was counted on ${FRI}.`;
    expect(await dry()).toEqual(
      ['manual_a', 'manual_b', 'manual_c'].map((id) => ({ account_id: id, source: 'manual', type: 'depository', days: {}, first: null, last: null, refused: { days: [FRI], reason: reason(id) } }))
    );
    for (const id of ['manual_a', 'manual_b', 'manual_c']) {
      const r = await repair(id);
      expect([id, r.status, r.body.error, r.body.days]).toEqual([id, 409, reason(id), [FRI]]);
    }
    expect(history()).toEqual(raw);
    expect(await pendingIds()).toEqual([]);
  });

  test('two flipped together, nothing else adding up the same: both found, and both repaired', async () => {
    await manual('manual_a', 'depository', 1500);
    await manual('manual_b', 'depository', 4000);
    await put('history:accounts', { [FRI]: { chk: 1000, manual_a: 1500, manual_b: 4000 } });
    await put('history:net-worth', { [FRI]: '-4500' });
    await home();
    expect((await dry()).map((f) => [f.account_id, f.days, f.refused])).toEqual([
      ['manual_a', { r: 1 }, undefined],
      ['manual_b', { r: 1 }, undefined],
    ]);
    expect((await repair('manual_a')).body.negated).toBe(1);
    expect((await repair('manual_b')).body.negated).toBe(1);
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_a: -1500, manual_b: -4000 });
    expect(await dry()).toEqual([]);
  });

  test('in every explanation of the day: counted the other way, while the two that cancel out are refused', async () => {
    // Savings flipped to a card; a held 500 and an owed 500 beside it, as they always were.
    await manual('manual_card', 'credit', 300);
    await manual('manual_h', 'other', 500);
    await manual('manual_o', 'loan', 500);
    await put('history:accounts', { [FRI]: { chk: 1000, manual_card: 300, manual_h: 500, manual_o: 500 } });
    await put('history:net-worth', { [FRI]: '1300' });
    await home();
    expect((await dry()).map((f) => [f.account_id, f.days, f.refused?.days])).toEqual([
      ['manual_card', { r: 1 }, undefined],
      ['manual_h', {}, [FRI, DAY]],
      ['manual_o', {}, [FRI, DAY]],
    ]);
    expect((await repair('manual_card')).body.negated).toBe(1);
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_card: -300, manual_h: 500, manual_o: 500 });
    expect((await repair('manual_h')).status).toBe(409);
  });

  test('a Plaid account with the same value explains the day as well: refused, never proof', async () => {
    // A manual account that was a card; the bank could have changed the checking account's kind as well.
    await manual('manual_s', 'depository', 1000);
    await put('history:accounts', { [FRI]: { chk: 1000, manual_s: 1000 } });
    await put('history:net-worth', { [FRI]: '0' });
    await home();
    expect((await dry()).map((f) => [f.account_id, f.refused?.days])).toEqual([['manual_s', [FRI]]]);
  });

  test('two with equal values, either of which explains the day: both refused', async () => {
    // One savings flipped to a card; another a card all along, owing the same.
    await manual('manual_x', 'credit', 300);
    await manual('manual_y', 'credit', 300);
    await put('history:accounts', { [FRI]: { chk: 1000, manual_x: 300, manual_y: 300 } });
    await put('history:net-worth', { [FRI]: '1000' });
    await home();
    expect((await dry()).map((f) => [f.account_id, f.refused?.days])).toEqual([
      ['manual_x', [FRI]],
      ['manual_y', [FRI]],
    ]);
    const raw = history();
    expect((await repair('manual_x')).status).toBe(409);
    expect(history()).toEqual(raw);
  });
});

describe('a day nothing decides', () => {
  test('an account whose type isn’t known makes the day undecided, never a flip', async () => {
    // A card all along; an account nothing knows the type of held 10,000.
    await manual('manual_card', 'credit', 5000);
    await put('history:accounts', { [FRI]: { chk: 1000, manual_card: 5000, ghost: 10000 } });
    await put('history:net-worth', { [FRI]: '6000' });
    await home(); // today, as it is now: the checking account's type known
    const raw = history();
    expect(await dry()).toEqual([{ account_id: 'manual_card', source: 'manual', type: 'credit', days: {}, first: null, last: null, undetermined: { count: 1, days: [FRI], why: { untyped: 1 } } }]);
    const r = await repair('manual_card');
    expect([r.status, r.body.negated, r.body.undetermined]).toEqual([200, 0, { count: 1, days: [FRI], why: { untyped: 1 } }]);
    expect(history()).toEqual(raw);
  });

  test('a value of 0 needs nothing, even of an account whose type isn’t known', async () => {
    // A savings account flipped to a card; an unknown one at 0 beside it.
    await manual('manual_s', 'credit', 5000);
    await put('history:accounts', { [FRI]: { chk: 1000, manual_s: 5000, ghost: 0, zero: 0.004 } });
    await put('history:net-worth', { [FRI]: '6000.004' });
    await home();
    expect((await dry()).map((f) => [f.account_id, f.days, f.first])).toEqual([['manual_s', { r: 1 }, FRI]]);
    expect((await repair('manual_s')).body.negated).toBe(1);
    expect(await stored('history:accounts', FRI)).toEqual({ chk: 1000, manual_s: -5000, ghost: 0, zero: 0.004 });
  });

  test('a value with fractions of a cent is read to the cent', async () => {
    // Shares worth 1,000.004, beside savings flipped to a card.
    await manual('manual_shares', 'investment', 1000.004);
    await manual('manual_s', 'credit', 5000);
    await put('history:accounts', { [FRI]: { chk: 1000, manual_shares: 1000.004, manual_s: 5000 } });
    await put('history:net-worth', { [FRI]: '7000.004' });
    await home();
    expect((await dry()).map((f) => [f.account_id, f.days])).toEqual([['manual_s', { r: 1 }]]);
  });

  test('a day with nothing on either side to tell it by is reported, never taken as counted as now', async () => {
    // Measured without a total: the only day there is.
    await manual('manual_s', 'credit', 5000);
    await put('history:accounts:partial', { [FRI]: { manual_s: 5000 } });
    expect(await dry()).toEqual([{ account_id: 'manual_s', source: 'manual', type: 'credit', days: {}, first: null, last: null, undetermined: { count: 1, days: [FRI], why: { 'no-total': 1 } } }]);
  });

  test('a day before the first one decided as counted now is reported, never taken as so', async () => {
    // Savings all along; measured without a total on the 9th, before the first total.
    await manual('manual_s', 'depository', 5000);
    await put('history:accounts:partial', { '2026-09-09': { manual_s: 5000 } });
    await put('history:accounts', { [FRI]: { chk: 1000, manual_s: 5000 } });
    await put('history:net-worth', { [FRI]: '6000' });
    await home();
    expect(await dry()).toEqual([{ account_id: 'manual_s', source: 'manual', type: 'depository', days: {}, first: null, last: null, undetermined: { count: 1, days: ['2026-09-09'], why: { 'no-total': 1 } } }]);
    // Between two days counted as now, it is taken as they are.
    await put('history:accounts', { '2026-09-08': { chk: 1000, manual_s: 5000 } });
    await put('history:net-worth', { '2026-09-08': '6000' });
    expect(await dry()).toEqual([]);
  });

  test('a run of days counted the other way reaching an end nothing marks refuses the repair', async () => {
    // Flipped to a card: measured without a total on the 9th, before Friday's flip.
    await manual('manual_s', 'credit', 5000);
    await put('history:accounts:partial', { '2026-09-09': { manual_s: 5000 } });
    await put('history:accounts', { [FRI]: { chk: 1000, manual_s: 5000 } });
    await put('history:net-worth', { [FRI]: '6000' });
    await home();
    expect((await dry()).map((f) => [f.account_id, f.refused?.days])).toEqual([['manual_s', ['2026-09-09']]]);
    expect((await repair('manual_s')).status).toBe(409);
  });
});
