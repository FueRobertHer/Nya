import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Moving the transactions typed on a manual account into the currency it is
// corrected to (lib/manual-relabel.ts), only on the person's confirmation:
// never one imported from a file, split or in a group, nor one more precise
// than the new currency allows; each number as typed; one write of the
// account's book. Without the confirmation a correction moves none. The
// offer's count is the server's, of every row the move would take, and the
// offer says plainly that a move has no undo.

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
const { relabelText, relabelledText, relabelUndoText } = await import('@/components/currency-text');
const { CurrencyChoiceBody, MovedBody, RelabelOffer } = await import('@/components/CurrencyChoiceSheet');
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

const count = async (q: string) => {
  const res = await route.GET(new Request(`http://localhost/api/manual-accounts?${q}`));
  return { status: res.status, body: (await res.json()) as any };
};

describe('what the form counts and offers', () => {
  test('the server counts the same rows the move takes, older ones the page hasn’t loaded too, and writes nothing', async () => {
    // Typed years ago: a page's window of transactions wouldn't have it.
    const old = { ...row('7', 3, 'USD'), date: '2019-01-05' };
    await manualTxnStore.set(ctx, ACCOUNT, { version: 1, rows: [...ROWS, old] as any });
    const before = await currencies();
    expect(await count(`account_id=${ACCOUNT}&relabel_from=USD&currency=EUR`)).toEqual({ status: 200, body: { relabel: { moved: 3, kept: 2 } } });
    expect(await count(`account_id=${ACCOUNT}&relabel_from=USD&currency=JPY`)).toEqual({ status: 200, body: { relabel: { moved: 2, kept: 3 } } });
    expect(await currencies()).toEqual(before);
    // What it counted is what a move then takes.
    expect((await patch({ account_id: ACCOUNT, currency: 'EUR', relabel_from: 'USD' })).body.relabelled).toEqual({ moved: 3, kept: 2 });
    expect(relabelPlan(ROWS, 'USD', 'EUR', new Set([ids[3], ids[4]])).move.map((r) => r.id)).toEqual([ids[0], ids[1]]);
    expect(relabelText(2, 'EUR')).toBe('Also move the 2 transactions you entered on it to EUR');
    // The plain list still answers a GET that asks for no count.
    expect((await count('')).body.accounts.map((a: any) => a.account_id)).toEqual([ACCOUNT]);
  });

  test('a count it can’t make is said, never zero; a request that isn’t one is refused', async () => {
    expect((await count(`account_id=${ACCOUNT}&relabel_from=USD&currency=NOPE`)).status).toBe(400);
    expect((await count(`account_id=acct_chk&relabel_from=USD&currency=EUR`)).status).toBe(400);
    await fake.hset(ctxKey('manual-transactions'), { [ACCOUNT]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const r = await count(`account_id=${ACCOUNT}&relabel_from=USD&currency=EUR`);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('couldn\'t be read');
  });

  test('the offer shows the server’s count, what stays, and plainly that there is no undo', () => {
    const offer = (count: any) =>
      renderToStaticMarkup(<RelabelOffer account_id={ACCOUNT} from="USD" to="EUR" checked={false} onChange={() => {}} disabled={false} count={count} />);
    const ready = offer({ kind: 'ready', moved: 14, kept: 2 });
    expect(ready).toContain('Also move the 14 transactions you entered on it to EUR');
    expect(ready).toContain('2 more you entered on it stay in USD: split, in a group, or more precise than EUR allows.');
    expect(ready).toContain(relabelUndoText('USD', 'EUR'));
    expect(relabelUndoText('USD', 'EUR')).toBe('There is no undo. Changing it back to USD later would offer to move every transaction you entered on it in EUR, not only these.');
    expect(offer({ kind: 'counting' })).toContain('Counting the transactions you entered on it in USD');
    expect(offer({ kind: 'counting' })).not.toContain('checkbox');
    const unread = offer({ kind: 'error', message: 'The transactions on it couldn’t be counted.' });
    expect(unread).toContain('couldn’t be counted');
    expect(unread).not.toContain('checkbox');
    // None would move: no offer, only what stays.
    const none = offer({ kind: 'ready', moved: 0, kept: 1 });
    expect(none).not.toContain('checkbox');
    expect(none).toContain('1 you entered on it stays in USD');
    expect(offer({ kind: 'ready', moved: 0, kept: 0 })).toBe('');
  });

  test('once saved, what moved is said', () => {
    expect(relabelledText({ moved: 14, kept: 2 }, 'USD', 'EUR')).toBe('14 transactions you entered on it moved to EUR. 2 stay in USD: split, in a group, or more precise than EUR allows.');
    expect(relabelledText({ moved: 1, kept: 0 }, 'USD', 'EUR')).toBe('1 transaction you entered on it moved to EUR.');
    expect(relabelledText({ moved: 0, kept: 0 }, 'USD', 'EUR')).toBe('None of the transactions you entered on it moved to EUR.');
    const two = renderToStaticMarkup(<MovedBody moved={[{ name: 'Abroad', text: 'a' }, { name: 'Wallet', text: 'b' }]} onClose={() => {}} />);
    expect(two).toContain('Abroad: a');
    expect(two).toContain('Wallet: b');
    expect(renderToStaticMarkup(<MovedBody moved={[{ name: 'Abroad', text: 'a' }]} onClose={() => {}} />)).not.toContain('Abroad:');
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
        counts={{ [ACCOUNT]: { kind: 'ready', moved: 2, kept: 0 } }}
        saving={false}
        error={null}
        onSave={() => {}}
        onClose={() => {}}
      />
    );
    expect(html).toContain('Also move the 2 transactions you entered on it to EUR');
    expect(html).toContain('There is no undo.');
    expect(html).not.toMatch(/type="checkbox" checked=""/);
  });
});
