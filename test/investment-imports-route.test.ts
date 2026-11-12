import { describe, expect, test, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { vanguardCsv, type Txn } from './vanguard-transactions-csv';

// The transactions imported for an investment account from Vanguard's
// download (lib/investment-imports-store.ts, app/api/investment-imports):
// the route that imports and undoes them, every account of one file in one
// step, only on live Vanguard investment accounts each matched by its four
// digits alone; an import refused when the imports changed since its review,
// or when an account keeps as many as it may; an undo that leaves every
// stored value and every answer as it was before the import; and both
// readers of the activity, the Accounts tab's and the Plan's, joining the
// file's rows the same way, their cached copies checked against the imports
// there are now.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';

const ctx = TEST_CTX;
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const TODAY = daysAgo(0);
const VANGUARD = 'ins_115616';

// Plaid: the individual account's deposit each month, the Roth's and the
// traditional IRA's nothing.
const deposit = (id: string, account_id: string, date: string, amount: number) => ({
  investment_transaction_id: id,
  account_id,
  security_id: null,
  date,
  name: 'Funds Received',
  quantity: 0,
  amount: -amount,
  price: 0,
  fees: 0,
  type: 'cash',
  subtype: 'deposit',
  iso_currency_code: 'USD',
  unofficial_currency_code: null,
});
const PLAID_ROWS = [deposit('p1', 'ind', daysAgo(200), 1000), deposit('p2', 'ind', daysAgo(90), 1000), deposit('p3', 'ind', daysAgo(45), 1000), deposit('p4', 'ind', daysAgo(15), 1000)];
const ACCOUNTS = [
  { account_id: 'ind', mask: '4421' },
  { account_id: 'roth', mask: '3307' },
  { account_id: 'trad', mask: '5519' },
];
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    investmentsTransactionsGet: async (req: any) => {
      const inRange = PLAID_ROWS.filter((r) => r.date >= req.start_date && r.date <= req.end_date);
      const offset = req.options?.offset ?? 0;
      return {
        data: {
          accounts: ACCOUNTS.map((a) => ({ ...a, name: a.account_id, type: 'investment', subtype: 'brokerage' })),
          securities: [],
          investment_transactions: inRange.slice(offset, offset + (req.options?.count ?? 500)),
          total_investment_transactions: inRange.length,
        },
      };
    },
  },
}));

const { encrypt } = await import('@/lib/crypto');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { rememberAccounts } = await import('@/lib/last-known');
const { linkAccounts, recordDirectory, forgetEarlierAccount } = await import('@/lib/links');
const { investmentImportsStore, importsFingerprint } = await import('@/lib/investment-imports-store');
const { MAX_IMPORTS_PER_ACCOUNT } = await import('@/lib/investment-imports');
const { IMPORTS_UNREADABLE } = await import('@/lib/investment-activity');
const { clearCaches } = await import('@/lib/cache');
const route = await import('@/app/api/investment-imports/route');
const activity = await import('@/app/api/investment-activity/route');
const planInputs = await import('@/app/api/plan-inputs/route');

/** A Plaid connection as a load leaves it: stored, remembered, in the directory. */
async function connect(item_id = 'i1', accounts: { account_id: string; mask: string; type?: string }[] = ACCOUNTS, institution_id: string | null = VANGUARD) {
  await saveItem(ctx, { item_id, institution_name: 'Vanguard', institution_id, encrypted_access_token: await encrypt(TEST_CTX, 'tok') } as never);
  const inst = {
    item_id,
    institution_name: 'Vanguard',
    institution_id,
    error: null,
    accounts: accounts.map((a) => ({ account_id: a.account_id, name: a.account_id, mask: a.mask, type: a.type ?? 'investment', official_name: null, subtype: 'brokerage', balance: 10, currency: 'USD' })),
  };
  await rememberAccounts(ctx, [inst as never]);
  await recordDirectory(ctx, [inst as never]);
}

/** Vanguard's file: the individual account's deposits from 60 days ago
 *  (one Plaid has, at 45 days, now $1,200), one today, and the Roth's
 *  contribution. */
const FILE_TXNS: Txn[] = [
  { account: '11114421', trade: TODAY, type: 'Funds Received', net: 5 },
  { account: '11114421', trade: daysAgo(16), type: 'Funds Received', net: 1000 },
  { account: '11114421', trade: daysAgo(45), type: 'Funds Received', net: 1200 },
  { account: '11114421', trade: daysAgo(60), type: 'Funds Received', net: 300 },
  { account: '22223307', trade: daysAgo(50), type: 'Contribution', net: 7000 },
  { account: '44448802', trade: daysAgo(55), type: 'Funds Received', net: 50 },
];
const FILE = vanguardCsv([], FILE_TXNS, { noHoldings: true });

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await route.POST(new Request('http://x/api/investment-imports', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }));
  return { status: res.status, body: await res.json() };
}
async function list(account_id = 'ind') {
  const res = await route.GET(new Request(`http://x/api/investment-imports?account_id=${account_id}`));
  return { status: res.status, body: await res.json() };
}
const importBody = (over: Record<string, unknown> = {}) => ({
  action: 'import',
  account_id: 'ind',
  file_name: 'OfxDownload.csv',
  text: FILE,
  today: TODAY,
  take: [
    { account_id: 'ind', mask: '4421' },
    { account_id: 'roth', mask: '3307' },
  ],
  counting: 'none',
  ...over,
});
const readActivity = async (id = 'ind') => (await activity.GET(new Request(`http://x/api/investment-activity?id=${id}&item_id=i1`))).json();
const planRow = async (sync: boolean, id = 'i1:ind') =>
  (await (await planInputs.GET(new Request(`http://x/api/plan-inputs?${sync ? 'sync=1&' : ''}plan=${encodeURIComponent(id)}`))).json()).plans[0];
/** Everything stored, raw. */
const everything = () => ({
  strings: Object.fromEntries([...fake.strings].sort()),
  hashes: Object.fromEntries([...fake.hashes].map(([k, h]) => [k, Object.fromEntries([...h].sort())]).sort()),
});
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => {
  const orig = console.error;
  console.error = () => {};
  try {
    return await f();
  } finally {
    console.error = orig;
  }
};

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await connect();
});

describe('what the route refuses', () => {
  test('a request from another site, and a body that isn’t one', async () => {
    expect((await post(importBody(), { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post({ action: 'import' })).body.error).toMatch(/account id/);
    expect(await investmentImportsStore.count(ctx)).toBe(0);
  });

  const cases: [string, Record<string, unknown>, number, RegExp][] = [
    ['a file that isn’t Vanguard’s download', { text: 'Date,Amount\n2026-01-01,5\n' }, 400, /isn’t Vanguard’s transaction download/],
    ['a file laid out another way', { text: FILE.replace('Net Amount', 'Amount') }, 400, /isn’t laid out/],
    ['an account no connection lists', { take: [{ account_id: 'gone', mask: '4421' }] }, 404, /isn’t one Nya knows/],
    ['an account that doesn’t end in those digits', { take: [{ account_id: 'ind', mask: '3307' }] }, 400, /doesn’t end in 3307/],
    ['digits the file has no account for', { take: [{ account_id: 'trad', mask: '5519' }] }, 400, /no account ending in 5519/],
    ['a today far from Nya’s', { today: daysAgo(3) }, 400, /more than a day/],
  ];
  for (const [what, over, status, words] of cases) {
    test(`refused: ${what}, and nothing is written`, async () => {
      const res = await post(importBody(over));
      expect(res.status).toBe(status);
      expect(res.body.error).toMatch(words);
      expect(await investmentImportsStore.count(ctx)).toBe(0);
    });
  }

  test('refused: an account not at Vanguard, or not an investment account', async () => {
    await connect('i2', [{ account_id: 'elsewhere', mask: '8802' }], 'ins_other');
    expect((await post(importBody({ take: [{ account_id: 'elsewhere', mask: '8802' }] }))).body.error).toMatch(/linked at Vanguard/);
    await connect('i3', [{ account_id: 'chk', mask: '8802', type: 'depository' }]);
    expect((await post(importBody({ take: [{ account_id: 'chk', mask: '8802' }] }))).body.error).toMatch(/linked at Vanguard/);
    expect(await investmentImportsStore.count(ctx)).toBe(0);
  });

  test('refused: two of the person’s Vanguard accounts end in the same digits', async () => {
    await connect('i2', [{ account_id: 'twin', mask: '4421' }]);
    expect((await post(importBody())).body.error).toMatch(/More than one of your Vanguard accounts ends in 4421/);
  });

  test('refused: two of the file’s accounts end in the same digits, or one has a line Nya can’t read', async () => {
    const repeated = vanguardCsv([], [...FILE_TXNS, { account: '99994421', trade: daysAgo(20), type: 'Funds Received', net: 1 }], { noHoldings: true });
    expect((await post(importBody({ text: repeated }))).body.error).toMatch(/more than one account ending in 4421/);
    const odd = vanguardCsv([], [...FILE_TXNS, { account: '22223307', trade: daysAgo(20), type: 'Gift', net: 1 }], { noHoldings: true });
    expect((await post(importBody({ text: odd }))).body.error).toMatch(/ending in 3307 has a line Nya can’t read/);
    expect(await investmentImportsStore.count(ctx)).toBe(0);
  });

  test('refused: an account with nothing in the file’s days, so they stay Plaid’s', async () => {
    const text = vanguardCsv([], [{ account: '11114421', trade: TODAY, type: 'Funds Received', net: 5 }, { account: '22223307', trade: daysAgo(3), type: 'Contribution', net: 5 }], { noHoldings: true });
    expect((await post(importBody({ text }))).body.error).toMatch(/nothing before today for the account ending in 4421/);
    expect(await investmentImportsStore.count(ctx)).toBe(0);
  });

  test('refused: a file whose every row is today’s', async () => {
    const todays = vanguardCsv([], [{ account: '11114421', trade: TODAY, type: 'Funds Received', net: 5 }], { noHoldings: true });
    expect((await post(importBody({ text: todays, take: [{ account_id: 'ind', mask: '4421' }] }))).body.error).toMatch(/from today/);
  });
});

describe('the review', () => {
  const reviewBody = (over: Record<string, unknown> = {}) => ({ action: 'review', account_id: 'ind', file_name: 'OfxDownload.csv', text: FILE, today: TODAY, ...over });
  const byMask = (body: { review: { accounts: { mask: string }[] } }, mask: string) => body.review.accounts.find((a) => a.mask === mask) as any;

  test('each of the file’s accounts in its order, what taking it would do, nothing kept, and the fingerprint the import names', async () => {
    const res = await post(reviewBody());
    expect(res.status).toBe(200);
    const { review } = res.body;
    expect(review.covers).toEqual({ from: daysAgo(60), to: daysAgo(1) });
    expect(review.after_today).toBe(1);
    expect(review.sheet_in).toBe(true);
    expect(review.accounts.map((a: { mask: string }) => a.mask)).toEqual(['4421', '3307', '8802']);
    const ind = byMask(res.body, '4421');
    expect(ind).toMatchObject({ lines: 4, rows: 3, account: { account_id: 'ind', item_id: 'i1', name: 'ind' }, problem: null });
    // Plaid's two deposits in those days ($2,000) give way to the file's
    // three ($2,500).
    expect(ind.effect).toMatchObject({ kind: 'takes', days: [{ from: daysAgo(60), to: daysAgo(1) }], rows: 3, now_rows: 2, flows: { file: 2500, now: 2000 }, twins: [] });
    expect(ind.effect.months.reduce((n: number, m: { now: number | null; file: number }) => n + m.file - (m.now ?? 0), 0)).toBe(500);
    // The Roth has no rows from Plaid, which proves nothing about how far its
    // feed reaches, so nothing counts there now (activityFromSync).
    expect(byMask(res.body, '3307').effect).toMatchObject({ rows: 1, now_rows: 0, flows: { file: 7000, now: null } });
    expect(byMask(res.body, '8802')).toEqual({ mask: '8802', lines: 1, rows: 1, account: null, problem: { why: 'not-in-nya' }, effect: null });
    expect(await investmentImportsStore.count(ctx)).toBe(0);
    expect(review.fingerprint).toBe((await list()).body.fingerprint);
    // Opened on an account the file doesn't have (the Traditional IRA ends in
    // 5519): said, and the others can still be taken.
    expect((await post(reviewBody({ account_id: 'trad' }))).body.review.sheet_in).toBe(false);
    // What it said, taken as it said it.
    expect((await post(importBody({ counting: review.fingerprint }))).status).toBe(200);
  });

  test('what stops an account, each said: two of yours end alike, a kind Nya doesn’t know, nothing in the file’s days', async () => {
    await connect('i2', [{ account_id: 'twin', mask: '4421' }]);
    const text = vanguardCsv(
      [],
      [
        { account: '11114421', trade: daysAgo(20), type: 'Funds Received', net: 1 },
        { account: '22223307', trade: daysAgo(20), type: 'Gift', net: 1 },
        { account: '33335519', trade: TODAY, type: 'Funds Received', net: 1 },
      ],
      { noHoldings: true }
    );
    const { body } = await post(reviewBody({ text }));
    expect(byMask(body, '4421')).toMatchObject({ account: null, problem: { why: 'two-in-nya' } });
    // The sheet's account is in the file, though it can't be told apart.
    expect(body.review.sheet_in).toBe(true);
    expect(byMask(body, '3307')).toMatchObject({ account: { account_id: 'roth' }, problem: { why: 'unreadable', detail: { reason: 'unknown-type', type: 'Gift' } }, effect: null });
    expect(byMask(body, '5519')).toMatchObject({ account: { account_id: 'trad' }, problem: { why: 'no-rows', now: 0 } });
  });

  test('nothing in the file’s days while Plaid has rows there: off, with how many stay', async () => {
    const text = vanguardCsv(
      [],
      [
        { account: '11114421', trade: TODAY, type: 'Funds Received', net: 1 },
        { account: '22223307', trade: daysAgo(50), type: 'Contribution', net: 7000 },
      ],
      { noHoldings: true }
    );
    expect(byMask((await post(reviewBody({ text }))).body, '4421').problem).toEqual({ why: 'no-rows', now: 2 });
  });

  test('as many imports as an account keeps, and days that don’t reach Nya’s activity: off, said why', async () => {
    const value = { source: 'vanguard-csv' as const, file_name: null, imported_at: '2026-01-01T00:00:00.000Z', covers: { from: '2025-01-01', to: '2025-01-02' }, currency: 'USD', rows: [{ date: '2025-01-02', name: 'Funds Received', type: 'cash', subtype: 'deposit', quantity: 0, price: 0, amount: -1, fees: 0, currency: 'USD', security: null }] };
    for (let n = 0; n < MAX_IMPORTS_PER_ACCOUNT; n++) await investmentImportsStore.set(ctx, `roth:old-import-${String(n).padStart(2, '0')}`, value);
    expect(byMask((await post(reviewBody())).body, '3307').problem).toEqual({ why: 'full' });
    await investmentImportsStore.remove(ctx, ...(await investmentImportsStore.ids(ctx)));
    const old = vanguardCsv([], [{ account: '11114421', trade: daysAgo(900), type: 'Funds Received', net: 1 }], { noHoldings: true });
    const problem = byMask((await post(reviewBody({ text: old }))).body, '4421').problem;
    expect(problem).toMatchObject({ why: 'unreached', covers: { from: daysAgo(900), to: daysAgo(900) }, activity: { through: expect.any(String) } });
    expect(problem.activity.from > daysAgo(900)).toBe(true);
  });

  test('a row Plaid dated after the file’s last day that is one of the file’s: shown as counted once', async () => {
    PLAID_ROWS.push(deposit('p5', 'ind', TODAY, 777));
    try {
      const text = vanguardCsv([], [{ account: '11114421', trade: daysAgo(2), type: 'Funds Received', net: 777 }], { noHoldings: true });
      const ind = byMask((await post(reviewBody({ text }))).body, '4421');
      expect(ind.effect.twins).toEqual([{ date: TODAY, file_date: daysAgo(2), name: 'Funds Received', type: 'cash', subtype: 'deposit', amount: -777 }]);
    } finally {
      PLAID_ROWS.pop();
    }
  });

  test('refused like an import: a file that isn’t the download, or a today far from Nya’s', async () => {
    expect((await post(reviewBody({ text: 'Date,Amount\n2026-01-01,5\n' }))).body.error).toMatch(/isn’t Vanguard’s transaction download/);
    expect((await post(reviewBody({ today: daysAgo(3) }))).status).toBe(400);
  });

  test('the list names every account an import took, for the Undo’s words', async () => {
    await post(importBody());
    expect((await list()).body.names).toEqual({ ind: { name: 'ind', mask: '4421', item_id: 'i1' }, roth: { name: 'roth', mask: '3307', item_id: 'i1' } });
  });
});

describe('importing', () => {
  test('every account chosen, in one step, its rows to the day before today, listed on each account with all it took', async () => {
    const res = await post(importBody());
    expect(res.status).toBe(200);
    const [listed] = res.body.imports;
    expect(res.body.imports).toHaveLength(1);
    expect(listed).toMatchObject({ source: 'vanguard-csv', file_name: 'OfxDownload.csv', covers: { from: daysAgo(60), to: daysAgo(1) }, currency: 'USD', rows: 3 });
    expect(listed.accounts.sort()).toEqual(['ind', 'roth']);
    expect((await list('roth')).body.imports).toEqual([{ ...listed, rows: 1 }]);
    expect(res.body.fingerprint).toBe(importsFingerprint(await investmentImportsStore.ids(ctx)));
    const stored = await investmentImportsStore.get(ctx, `ind:${listed.import_id}`);
    // Today's row is left out: the download's own day can be partial.
    expect(stored!.rows.map((r) => [r.date, r.amount])).toEqual([
      [daysAgo(16), -1000],
      [daysAgo(45), -1200],
      [daysAgo(60), -300],
    ]);
  });

  test('refused when the imports changed since the file was reviewed, and nothing is written', async () => {
    const reviewed = (await list()).body.fingerprint;
    expect((await post(importBody({ take: [{ account_id: 'roth', mask: '3307' }] }))).status).toBe(200);
    const before = everything();
    const res = await post(importBody({ counting: reviewed }));
    expect(res).toEqual({ status: 409, body: { error: expect.stringMatching(/changed on another device/), needs: 'review' } });
    expect(everything()).toEqual(before);
  });

  test('refused when an account keeps as many imports as it may, across its linked ids', async () => {
    const value = { source: 'vanguard-csv' as const, file_name: null, imported_at: '2026-01-01T00:00:00.000Z', covers: { from: '2025-01-01', to: '2025-01-02' }, currency: 'USD', rows: [{ date: '2025-01-02', name: 'Funds Received', type: 'cash', subtype: 'deposit', quantity: 0, price: 0, amount: -1, fees: 0, currency: 'USD', security: null }] };
    for (let n = 0; n < MAX_IMPORTS_PER_ACCOUNT - 1; n++) await investmentImportsStore.set(ctx, `ind:old-import-${String(n).padStart(2, '0')}`, value);
    await recordDirectory(ctx, [{ item_id: 'item_gone', institution_name: 'Vanguard', institution_id: VANGUARD, error: null, accounts: [{ account_id: 'ind_was', type: 'investment', subtype: 'brokerage', mask: '4421' }] }] as never);
    await investmentImportsStore.set(ctx, 'ind_was:old-import-99', value);
    await linkAccounts(ctx, 'ind_was', 'ind', {});
    const counting = (await list()).body.fingerprint;
    const before = everything();
    const res = await post(importBody({ counting }));
    expect(res).toEqual({ status: 409, body: { error: expect.stringMatching(/as many imports as Nya keeps/), needs: 'undo', account_id: 'ind' } });
    expect(everything()).toEqual(before);
  });
});

describe('undoing, without loss', () => {
  test('every stored value and every answer is as it was before the import, the activity cache aside', async () => {
    const activityBefore = await readActivity();
    const planBefore = await planRow(true);
    const before = everything();
    const cacheKey = ctxKey('cache:inv-activity:v4');

    const { import_id } = (await post(importBody())).body.imports[0];
    const undone = await post({ action: 'undo', account_id: 'ind', import_id });
    expect(undone).toEqual({ status: 200, body: { imports: [], fingerprint: 'none', names: {} } });
    expect(everything()).toEqual(before);
    expect(await fake.hgetall(ctxKey('investment-imports'))).toBeFalsy();

    // Read with the import in place, then undone: the cache holds the
    // import's answer, which is a miss once it's gone.
    const { import_id: again } = (await post(importBody())).body.imports[0];
    expect(await readActivity()).toMatchObject({ from_cache: false });
    await post({ action: 'undo', account_id: 'ind', import_id: again });
    const { from_cache: _a, ...wasActivity } = activityBefore;
    const { from_cache, ...nowActivity } = await readActivity();
    expect(from_cache).toBe(false);
    expect(nowActivity).toEqual(wasActivity);
    expect(await planRow(false)).toEqual(planBefore);
    const { [cacheKey]: _c, ...hashes } = everything().hashes;
    const { [cacheKey]: _d, ...hashesBefore } = before.hashes;
    expect(Object.keys(hashes).sort()).toEqual(Object.keys(hashesBefore).sort());
    expect(hashes[ctxKey('investment-imports')]).toBeUndefined();
  });

  test('an import that isn’t there is a 404, and nothing changes', async () => {
    await post(importBody());
    const before = everything();
    expect(await post({ action: 'undo', account_id: 'ind', import_id: 'not-there-1' })).toEqual({ status: 404, body: { error: 'That import isn’t there any more: the list shows what is.' } });
    expect(everything()).toEqual(before);
  });
});

describe('both readers of the activity', () => {
  test('inside the file’s days its rows count and Plaid’s don’t; the same in the Plan’s inputs; a copy cached before is a miss', async () => {
    const plain = await readActivity();
    expect(plain.flows.map((f: { amount: number }) => f.amount)).toEqual([1000, 1000, 1000, 1000]);
    expect(await readActivity()).toMatchObject({ from_cache: true });
    expect((await planRow(false)).contributions_12m).toBeDefined();

    await post(importBody());
    expect(await planRow(false)).toEqual({ id: 'i1:ind', pending: true });
    const joined = await readActivity();
    expect(joined.from_cache).toBe(false);
    // Plaid's deposits 200 and 90 days ago, then the file's from 60 days ago
    // to yesterday: Plaid's at 45 and 15 days are gone, and the file's today
    // is left out.
    expect(joined.flows).toEqual([
      { date: daysAgo(200), amount: 1000 },
      { date: daysAgo(90), amount: 1000 },
      { date: daysAgo(60), amount: 300 },
      { date: daysAgo(45), amount: 1200 },
      { date: daysAgo(16), amount: 1000 },
    ]);
    expect(joined.imported_days).toEqual([{ import_id: expect.any(String), from: daysAgo(60), to: daysAgo(1), file_name: 'OfxDownload.csv', imported_at: expect.any(String) }]);
    expect(joined.txns.map((t: { investment_transaction_id: string }) => t.investment_transaction_id)).toEqual([
      expect.stringMatching(/:0$/),
      expect.stringMatching(/:1$/),
      expect.stringMatching(/:2$/),
      'p2',
      'p1',
    ]);
    expect(await readActivity()).toMatchObject({ from_cache: true, flows: joined.flows });

    const synced = await planRow(true);
    const fields = Object.keys(synced).filter((k) => k !== 'id');
    expect(fields.length).toBeGreaterThan(5);
    for (const f of fields) expect(synced[f]).toEqual(joined[f]);
    expect(await planRow(false)).toEqual(synced);
  });

  test('imports that can’t be read: Plaid’s activity alone, said, and not cached', async () => {
    const { import_id } = (await post(importBody())).body.imports[0];
    await fake.hset(ctxKey('investment-imports'), { [`ind:${import_id}`]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const answer = await quiet(readActivity);
    expect(answer.note).toBe(IMPORTS_UNREADABLE);
    expect(answer.flows.map((f: { amount: number }) => f.amount)).toEqual([1000, 1000, 1000, 1000]);
    expect(await fake.hget(ctxKey('cache:inv-activity:v4'), 'i1:ind')).toBeNull();
    // Another account's entry doesn't hold the Roth's back.
    const roth = await quiet(() => readActivity('roth'));
    expect(roth.note).toBeNull();
    expect(roth.flows).toEqual([{ date: daysAgo(50), amount: 7000 }]);
    const row = await quiet(() => planRow(true));
    expect(row.note).toBe(IMPORTS_UNREADABLE);
  });

  test('one account’s entry that can’t be read never holds another’s back in the Plan’s inputs', async () => {
    const { import_id } = (await post(importBody())).body.imports[0];
    await fake.hset(ctxKey('investment-imports'), { [`ind:${import_id}`]: 'not-ciphertext-but-long-enough-to-be-tried' });
    const res = await quiet(async () => (await planInputs.GET(new Request('http://x/api/plan-inputs?sync=1&plan=i1%3Aind&plan=i1%3Aroth'))).json());
    const [ind, roth] = res.plans;
    expect(ind.note).toBe(IMPORTS_UNREADABLE);
    expect(roth.note).toBeNull();
    expect(roth.contributions_12m).toBe(7000);
    expect(roth).toEqual({ ...(await quiet(() => planRow(true, 'i1:roth'))), id: 'i1:roth' });
  });

  test('imports that can’t be listed: Plaid’s activity alone, said, never a failed answer', async () => {
    await post(importBody());
    const cached = await readActivity();
    expect(cached.from_cache).toBe(false);
    const down = async () => {
      throw new Error('Redis is down');
    };
    const listing = spyOn(investmentImportsStore, 'ids').mockImplementationOnce(down);
    const answer = await quiet(readActivity);
    expect(answer).toMatchObject({ from_cache: false, note: IMPORTS_UNREADABLE });
    expect(answer.flows.map((f: { amount: number }) => f.amount)).toEqual([1000, 1000, 1000, 1000]);
    // The plan is still answered; the rows wait for a sync.
    listing.mockImplementationOnce(down);
    const res = await quiet(() => planInputs.GET(new Request('http://x/api/plan-inputs?plan=i1%3Aind')));
    expect(res.status).toBe(200);
    expect((await res.json()).plans).toEqual([{ id: 'i1:ind', pending: true }]);
    listing.mockRestore();
  });

  test('read across a link: an import under the account’s earlier id joins its activity now', async () => {
    await recordDirectory(ctx, [{ item_id: 'item_gone', institution_name: 'Vanguard', institution_id: VANGUARD, error: null, accounts: [{ account_id: 'ind_was', type: 'investment', subtype: 'brokerage', mask: '4421' }] }] as never);
    await investmentImportsStore.set(ctx, 'ind_was:import-early-1', {
      source: 'vanguard-csv',
      file_name: null,
      imported_at: '2026-01-01T00:00:00.000Z',
      covers: { from: daysAgo(100), to: daysAgo(80) },
      currency: 'USD',
      rows: [{ date: daysAgo(95), name: 'Funds Received', type: 'cash', subtype: 'deposit', quantity: 0, price: 0, amount: -444, fees: 0, currency: 'USD', security: null }],
    });
    expect((await readActivity()).flows.map((f: { amount: number }) => f.amount)).toEqual([1000, 1000, 1000, 1000]);
    // As the links route does after a change: its caches go with it.
    await linkAccounts(ctx, 'ind_was', 'ind', {});
    await clearCaches(ctx);
    const joined = await readActivity();
    expect(joined.flows.map((f: { amount: number }) => f.amount)).toEqual([1000, 444, 1000, 1000]);
    expect((await list()).body.imports.map((i: { import_id: string }) => i.import_id)).toEqual(['import-early-1']);
  });
});

describe('forgetting', () => {
  test('an earlier account’s imports go with it; another account the import took keeps its own', async () => {
    const { import_id } = (await post(importBody())).body.imports[0];
    fake.reset();
    await registerTestContainer(fake);
    await recordDirectory(ctx, [{ item_id: 'item_gone', institution_name: 'Vanguard', institution_id: VANGUARD, error: null, accounts: [{ account_id: 'ind', type: 'investment', subtype: 'brokerage', mask: '4421' }] }] as never);
    const value = { source: 'vanguard-csv' as const, file_name: null, imported_at: '2026-01-01T00:00:00.000Z', covers: { from: '2025-01-01', to: '2025-01-02' }, currency: 'USD', rows: [{ date: '2025-01-02', name: 'Funds Received', type: 'cash', subtype: 'deposit', quantity: 0, price: 0, amount: -1, fees: 0, currency: 'USD', security: null }] };
    await investmentImportsStore.setMany(ctx, [
      [`ind:${import_id}`, value],
      [`roth:${import_id}`, value],
    ]);
    await forgetEarlierAccount(ctx, 'ind');
    expect(await investmentImportsStore.ids(ctx)).toEqual([`roth:${import_id}`]);
  });
});
