import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Rules, tags and notes (#36, #40) on an account that ended (#50). A rule on
// it still applies to its transactions from before its end, which the
// Activity tab lists, and the rule names it with its end; its transactions
// from its end on are listed nowhere and counted in nothing, a rule's preview
// included, so the preview counts what the app shows. What the person put on
// those later rows (tags, a note) is kept, unshown, and back as it was when
// the account is reopened. The download and its OFX statement, which list
// every row, apply the rules to the later ones too, and a report counts a
// later row once, as after its end, whatever a rule does to it.

const ctx = TEST_CTX;
process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.MAX_TXN_BLOB_CHARS;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

const plaidTxns: any[] = [];
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({
      data: {
        added: plaidTxns,
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

const fake = new FakeRedis();
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { rememberAccounts } = await import('@/lib/last-known');
const { saveManualAccount } = await import('@/lib/manual');
const { addManualTxn, newManualTxn } = await import('@/lib/manual-txns');
const { txnAnnotationStore } = await import('@/lib/txn-annotations');
const { collectUserData, buildUserExport } = await import('@/lib/user-export');
const { ofxFile } = await import('@/lib/ofx-export');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const { withEndedAccounts } = await import('@/components/AccountLifecycle');
const { ruleSentence } = await import('@/lib/rules');

const account = {
  account_id: 'acct_a',
  name: 'Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  mask: '4821',
  balances: { available: 100, current: 100, limit: null, iso_currency_code: 'USD' },
};
const row = (id: string, daysBack: number, name: string, amount: number) => ({
  transaction_id: id,
  account_id: 'acct_a',
  amount,
  iso_currency_code: 'USD',
  date: daysAgo(daysBack),
  name,
  merchant_name: null,
  pending: false,
  counterparties: [],
  personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES' },
});

const route = async (path: string, method: string, body?: unknown) => {
  const mod: any = await import(`@/app/api/${path}/route`);
  const res = await mod[method](new Request(`http://x/api/${path}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'content-type': 'application/json' } }));
  return { status: res.status, body: await res.json() };
};
const listedIds = async () => (await route('transactions', 'GET')).body.transactions.map((t: any) => t.transaction_id);
const rowOf = async (id: string) => (await route('transactions', 'GET')).body.transactions.find((t: any) => t.transaction_id === id);
const addRule = async (rule: unknown) => {
  const r = await route('rules', 'POST', { action: 'add', rule });
  expect(r.status).toBe(200);
  return r.body.created as string;
};
const preview = async (rule: unknown) => (await route('rules/preview', 'POST', { rule })).body;
const end = async (account_id: string, on: string) => expect((await route('account-lifecycle', 'POST', { account_id, state: 'closed', on })).status).toBe(200);
const reopen = async (account_id: string) => expect((await route('account-lifecycle', 'POST', { account_id, state: 'active' })).status).toBe(200);

const MANUAL = 'manual_6b1f3e2a-1c4d-4e5f-8a9b-0c1d2e3f4a5b';
let mBefore = '';
let mAfter = '';

beforeEach(async () => {
  fake.reset();
  (await import('@/lib/sessions')).forgetEpochs();
  await registerTestContainer(fake);
  plaidTxns.length = 0;
  plaidTxns.push(row('t_before', 10, 'AMZN MKTP US*2K4', 12), row('t_after', 3, 'AMZN MKTP US*9Q1', 20), row('t_coffee', 8, 'BLUE BOTTLE', 5));
  await fake.hset(ctxKey('plaid:items'), { item_a: JSON.stringify({ item_id: 'item_a', institution_name: 'Chase', encrypted_access_token: await encrypt(TEST_CTX, 'token-a') }) });
  await rememberAccounts(ctx, [{ item_id: 'item_a', institution_name: 'Chase', institution_id: null, error: null, accounts: [{ ...account, balance: 100 }] } as any]);
  await saveManualAccount(ctx, { account_id: MANUAL, name: 'Cash', institution_name: 'Wallet', type: 'depository', subtype: 'cash', balance: 50 } as any);
  const before = newManualTxn(MANUAL, { date: daysAgo(9), name: 'AMZN locker pickup', amount: 9, currency: 'USD', category: null, note: null });
  const after = newManualTxn(MANUAL, { date: daysAgo(2), name: 'AMZN locker return', amount: 4, currency: 'USD', category: null, note: null });
  await addManualTxn(ctx, before);
  await addManualTxn(ctx, after);
  [mBefore, mAfter] = [before.id, after.id];
  // Stored, as the Activity tab's first load stores them.
  expect(await listedIds()).toEqual(expect.arrayContaining(['t_before', 't_after', 't_coffee', mBefore, mAfter]));
});

describe('a rule and an account that ended', () => {
  test('a rule on it still applies to its rows from before its end; its later rows are listed nowhere, nor counted by the preview, until it is reopened', async () => {
    const onCard = { conditions: [{ field: 'account', op: 'equals', value: 'acct_a' }], actions: { set_name: 'Old checking' } };
    const onCash = { conditions: [{ field: 'account', op: 'equals', value: MANUAL }], actions: { hide: true } };
    await addRule(onCard);
    await addRule(onCash);
    await end('acct_a', daysAgo(5));
    await end(MANUAL, daysAgo(5));

    const ids = await listedIds();
    expect(ids).toEqual(expect.arrayContaining(['t_before', 't_coffee', mBefore]));
    expect(ids).not.toContain('t_after');
    expect(ids).not.toContain(mAfter);
    expect(await rowOf('t_before')).toMatchObject({ name: 'Old checking', rule_ids: [expect.any(String)] });
    expect(await rowOf(mBefore)).toMatchObject({ excluded: true, excluded_by_rule: true });
    // The preview counts what the app shows.
    expect(await preview(onCard)).toMatchObject({ matches: 2, samples: [{ transaction_id: 't_coffee' }, { transaction_id: 't_before' }] });
    expect(await preview(onCash)).toMatchObject({ matches: 1, samples: [{ transaction_id: mBefore }] });

    await reopen('acct_a');
    await reopen(MANUAL);
    expect(await rowOf('t_after')).toMatchObject({ name: 'Old checking' });
    expect((await preview(onCard)).matches).toBe(3);
    expect((await preview(onCash)).matches).toBe(2);
  });

  test('the Rules screen names it with its end, never as an account no longer here', async () => {
    const ended = [
      {
        account_id: 'acct_a',
        lifecycle: { state: 'closed' as const, on: '2024-03-13' },
        label: { name: 'Checking', institution: 'Chase', mask: '4821' },
        type: 'depository',
        item_id: 'item_a',
        set_at: '2024-03-14T00:00:00.000Z',
      },
    ];
    const accounts = withEndedAccounts([{ id: MANUAL, label: 'Wallet Cash' }], ended);
    expect(accounts).toEqual([
      { id: MANUAL, label: 'Wallet Cash' },
      { id: 'acct_a', label: 'Chase Checking ••4821 · Closed Mar 13, 2024' },
    ]);
    // One the live list still holds keeps its own label.
    expect(withEndedAccounts([{ id: 'acct_a', label: 'Chase Checking ••4821' }], ended)).toEqual([{ id: 'acct_a', label: 'Chase Checking ••4821' }]);
    const rule = { id: 'r', enabled: true, priority: 1, conditions: [{ field: 'account' as const, op: 'equals' as const, value: 'acct_a' }], actions: { hide: true as const }, created_at: '', updated_at: '' };
    const said = ruleSentence(rule, { ix: null, tags: null, account: (id) => accounts.find((a) => a.id === id)?.label ?? null, money: String });
    expect(said).toContain('account is Chase Checking ••4821 · Closed Mar 13, 2024');
  });
});

describe('tags and notes on its rows from its end on', () => {
  test('are kept, unshown, and back as they were when it is reopened', async () => {
    const work = (await route('tags', 'POST', { action: 'add', name: 'Work' })).body.created as string;
    expect((await route('transaction-annotations', 'PATCH', { transaction_id: 't_after', add_tags: [work], note: 'Refund due' })).status).toBe(200);
    await end('acct_a', daysAgo(5));
    expect(await listedIds()).not.toContain('t_after');
    expect(await txnAnnotationStore.get(ctx, 't_after')).toMatchObject({ tags: [work], note: 'Refund due' });
    // Still on it, so still counted as put on by hand, and taken off it too
    // if the tag is deleted.
    expect((await route('tags', 'GET')).body.counts).toEqual({ [work]: 1 });
    await reopen('acct_a');
    expect(await rowOf('t_after')).toMatchObject({ tags: [work], note: 'Refund due' });
  });
});

describe('the download, its OFX statement and a report, with rules', () => {
  const hideAmazon = { conditions: [{ field: 'name', op: 'contains', value: 'amzn' }], actions: { set_name: 'Amazon', hide: true } };

  test('the download and the statement apply the rules to every row, its later ones too', async () => {
    await addRule(hideAmazon);
    await end('acct_a', daysAgo(5));
    const data = await collectUserData({ ctx, userId: null });
    const doc = buildUserExport(data, new Date());
    const mine = doc.transactions.filter((t) => t.account_id === 'acct_a' && t.name.startsWith('AMZN'));
    expect(mine.map((t) => [t.transaction_id, t.nya_name, t.excluded_by_rule]).sort()).toEqual([
      ['t_after', 'Amazon', true],
      ['t_before', 'Amazon', true],
    ]);
    const made = ofxFile(data, doc, 'acct_a', new Date());
    if (!('file' in made)) throw new Error(made.refused);
    const text = [...made.file.pieces()].join('');
    expect(text.match(/<NAME>Amazon\r\n/g)).toHaveLength(2);
    expect(text.match(/<MEMO>Hidden from budgets and reports by a rule in Nya/g)).toHaveLength(2);
    expect(made.file.notes[0]).toStartWith(`This account was closed in Nya on `);
    expect(made.file.notes[0]).toContain('1 of them dated from then, which Nya leaves out of every total');
  });

  test('a report counts a later row once, as after its end, though a rule hides it', async () => {
    await addRule(hideAmazon);
    await end('acct_a', daysAgo(5));
    const period = resolvePeriod({ kind: 'range', start: daysAgo(30), end: daysAgo(0) }, 'UTC', Date.now());
    if ('error' in period) throw new Error(period.error);
    const r = await readReport(ctx, period);
    // Hidden by the rule: the card's row from before its end, and the cash
    // account's two (it never ended).
    expect(r.totals.hidden_by_rule).toBe(3);
    expect(r.ended).toEqual([expect.objectContaining({ account: 'Checking ••4821', not_counted: 1 })]);
    expect(r.totals.transactions).toBe(4);
  });
});
