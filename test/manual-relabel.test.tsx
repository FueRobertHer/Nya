import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Moving the transactions typed on a manual account into the currency it is
// corrected to (lib/manual-relabel.ts), only on the person's confirmation:
// never one imported from a file, split or in a group, nor one more precise
// than the new currency allows; each number as typed; one write of the
// account's book. Without the confirmation a correction moves none.

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

const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount } = await import('@/lib/manual');
const { manualTxnStore, newManualTxn } = await import('@/lib/manual-txns');
const { splitStore } = await import('@/lib/splits');
const { groupStore } = await import('@/lib/groups');
const { relabelPlan } = await import('@/lib/manual-relabel');
const { typedToMove, relabelText } = await import('@/components/currency-text');
const { CurrencyChoiceBody } = await import('@/components/CurrencyChoiceSheet');
const route = await import('@/app/api/manual-accounts/route');

const ctx = TEST_CTX;
const ACCOUNT = 'manual_abroad';
const at = '2026-09-01T10:00:00.000Z';
const row = (id: string, amount: number, currency: string, over: Record<string, unknown> = {}) => ({
  ...newManualTxn(ACCOUNT, { amount, currency, date: '2026-09-10', name: `Row ${id}`, category: 'groceries', note: null }, new Date(at), `manual-txn:0000000${id}-1d2e-4f5a-8b6c-7d8e9f0a1b2c`),
  ...over,
});
const ROWS = [
  row('1', 12.5, 'USD'),
  row('2', 40, 'USD'),
  // From a file: its currency is the file's.
  row('3', 9.99, 'USD', { source: 'import:ofx', source_id: 'FITID-1', import_id: 'imp-1' }),
  // Split: its parts keep the whole's currency.
  row('4', 30, 'USD'),
  // In a group of one currency.
  row('5', 20, 'USD'),
  // Already in another currency.
  row('6', 5, 'GBP'),
];
const ids = ROWS.map((r) => r.id);

async function seed() {
  await saveManualAccount(ctx, { account_id: ACCOUNT, name: 'Abroad', institution_name: 'Sparkasse', type: 'depository', subtype: null, balance: 1000, updated_at: at });
  await manualTxnStore.set(ctx, ACCOUNT, { version: 1, rows: ROWS as any });
  await splitStore.set(ctx, ids[3], {
    version: 1,
    amount: 30,
    currency: 'USD',
    parts: [
      { id: 'p1', amount: 10, category_id: 'cat_a' },
      { id: 'p2', amount: 20, category_id: 'cat_b' },
    ],
    updated_at: at,
  } as any);
  await groupStore.set(ctx, 'g1', { version: 1, name: 'Dinner', category_id: 'cat_a', members: [ids[4], 'other-bank-row'], date: '2026-09-10', currency: 'USD', created_at: at, updated_at: at } as any);
}

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await seed();
});

const patch = async (body: unknown) => {
  const res = await route.PATCH(new Request('http://localhost/api/manual-accounts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};
const currencies = async () => Object.fromEntries((await manualTxnStore.get(ctx, ACCOUNT))!.rows.map((r) => [r.id, [r.amount, r.currency]]));

describe('a correction', () => {
  test('without the confirmation, moves none of its transactions', async () => {
    const before = await currencies();
    expect((await patch({ account_id: ACCOUNT, currency: 'EUR' })).status).toBe(200);
    expect(await currencies()).toEqual(before);
  });

  test('confirmed: only the rows typed on it in its old currency, each number as typed, said how many', async () => {
    const r = await patch({ account_id: ACCOUNT, currency: 'EUR', relabel_from: 'USD' });
    expect(r.status).toBe(200);
    expect(r.body.account.currency).toBe('EUR');
    expect(r.body.relabelled).toEqual({ moved: 2, kept: 2 });
    expect(await currencies()).toEqual({
      [ids[0]]: [12.5, 'EUR'],
      [ids[1]]: [40, 'EUR'],
      [ids[2]]: [9.99, 'USD'],
      [ids[3]]: [30, 'USD'],
      [ids[4]]: [20, 'USD'],
      [ids[5]]: [5, 'GBP'],
    });
  });

  test('from the full form too, and never one more precise than the new currency allows', async () => {
    const r = await patch({ account_id: ACCOUNT, name: 'Abroad', institution_name: 'Sparkasse', type: 'depository', subtype: null, balance: 1000, currency: 'JPY', relabel_from: 'USD' });
    expect(r.status).toBe(200);
    // 12.50 can't be in yen without changing its number: it stays.
    expect(r.body.relabelled).toEqual({ moved: 1, kept: 3 });
    expect((await currencies())[ids[1]]).toEqual([40, 'JPY']);
    expect((await currencies())[ids[0]]).toEqual([12.5, 'USD']);
  });

  test('asked again after the account was corrected (a retry), still moves them', async () => {
    await patch({ account_id: ACCOUNT, currency: 'EUR' });
    const r = await patch({ account_id: ACCOUNT, currency: 'EUR', relabel_from: 'USD' });
    expect(r.body.relabelled).toEqual({ moved: 2, kept: 2 });
  });

  test('a currency that isn’t one is refused, and nothing is written', async () => {
    const before = await currencies();
    expect((await patch({ account_id: ACCOUNT, currency: 'EUR', relabel_from: 'NOPE' })).status).toBe(400);
    expect(await currencies()).toEqual(before);
  });
});

describe('what the form counts and offers', () => {
  test('the same rows the move takes', () => {
    const page = ROWS.map((r) => ({ ...r, iso_currency_code: r.currency, ...(r.id === ids[3] ? { split_of: r.id } : {}), ...(r.id === ids[4] ? { group_id: 'g1' } : {}) }));
    expect(typedToMove(page, ACCOUNT, 'USD', 'EUR')).toBe(2);
    expect(typedToMove(page, ACCOUNT, 'USD', 'JPY')).toBe(1);
    expect(relabelPlan(ROWS, 'USD', 'EUR', new Set([ids[3], ids[4]])).move.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    expect(relabelText(2, 'EUR')).toBe('Also move the 2 transactions you entered on it to EUR');
  });

  test('the choice of a home currency offers it beside a corrected account, unticked', () => {
    const html = renderToStaticMarkup(
      <CurrencyChoiceBody
        view={null}
        chosen="EUR"
        onChosen={() => {}}
        first={['USD']}
        manual={[{ account_id: ACCOUNT, name: 'Abroad', currency: 'USD' }]}
        fixes={{ [ACCOUNT]: 'EUR' }}
        typedCount={() => 2}
        saving={false}
        error={null}
        onSave={() => {}}
        onClose={() => {}}
      />
    );
    expect(html).toContain('Also move the 2 transactions you entered on it to EUR');
    expect(html).not.toMatch(/type="checkbox" checked=""/);
  });
});
