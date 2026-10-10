import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import './clerk-mock';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount, type FakeTxn } from './simplefin-fake';

// One account SimpleFIN keeps up to date as an OFX statement (lib/ofx-export.ts):
// its rows come from its book, as a manual account's do (FITIDs the rows' own
// ids, OFX's sign, the exclusion marks), each side of a payment or a move Nya
// works out between two SimpleFIN accounts typed as a bank's file types it
// (PAYMENT, XFER), and the balance SimpleFIN last gave, as of the bank's own
// day for it, or none while Nya holds it (a card waiting for its sign, a bank
// whose latest answer isn't whole), said. Read back through Nya's own import,
// and imported twice, adding nothing the second time. An account kept as a
// manual one in another currency keeps it, its balance with it.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get() {
        return async () => {
          throw new Error('Plaid must not be called');
        };
      },
    }
  ),
}));

const fake = new FakeRedis({ deserialize: true });
mock.module('@/lib/storage', () => storageMock(fake));
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));

const { setTransportForTests } = await import('@/lib/connectors/http');
const { connect, trackAccounts, disconnect } = await import('@/lib/connectors/manage');
const { syncConnection } = await import('@/lib/connectors/sync');
const { connectionsStore, connectorAccountsStore } = await import('@/lib/connectors/store');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { saveManualAccount } = await import('@/lib/manual');
const { setExcluded } = await import('@/lib/txn-annotations');
const { forgetEpochs } = await import('@/lib/sessions');
const { computeNetWorth, recordFetch } = await import('@/lib/networth');
const { collectUserData, buildUserExport } = await import('@/lib/user-export');
const { ofxFile } = await import('@/lib/ofx-export');
const { decodeFile } = await import('@/lib/import/text');
const { parseOfx, ofxRecords } = await import('@/lib/import/ofx');
const imports = await import('@/app/api/import/route');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const NOW = Date.now();
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ago = (n: number) => Math.floor(Date.parse(`${dayOf(NOW - n * DAY)}T12:00:00Z`) / 1000);
const txn = (id: string, daysAgo: number, amount: string, description: string): FakeTxn => ({ id, posted: ago(daysAgo), amount, description });

let server: FakeSimplefin;
beforeAll(async () => {
  server = await FakeSimplefin.start();
});
afterAll(() => {
  setTransportForTests(null);
  server.stop();
});
const saved = { ...process.env };
beforeEach(async () => {
  fake.reset();
  server.reset();
  forgetEpochs();
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CONTAINER_ID;
  await registerTestContainer(fake);
  setTransportForTests(server.transport());
});
afterEach(() => {
  process.env = { ...saved };
});

/** Checking, a card, savings and a mortgage at one bank through SimpleFIN:
 *  a card paid from checking, a mortgage payment, a move to savings, pay,
 *  and a coffee and a dinner that are only spending. Each balance is the
 *  bank's of two days ago. */
async function trackAll(): Promise<string> {
  server.accounts = [
    fakeAccount({
      id: 'CHK',
      name: 'Checking',
      balance: '5000.00',
      'balance-date': ago(2),
      transactions: [
        txn('coffee', 2, '-12.50', 'COFFEE'),
        txn('pay', 3, '-300.00', 'PAYMENT TO VISA'),
        txn('mtg', 5, '-2000.00', 'MORTGAGE PMT'),
        txn('sav', 6, '-500.00', 'TO SAVINGS'),
        txn('payroll', 10, '2500.00', 'PAYROLL'),
      ],
    }),
    fakeAccount({ id: 'CARD', name: 'Visa', balance: '-300.00', 'balance-date': ago(2), transactions: [txn('thanks', 2, '300.00', 'PAYMENT THANK YOU'), txn('dinner', 2, '-45.67', 'DINER')] }),
    fakeAccount({ id: 'SAV', name: 'Savings', balance: '1500.00', 'balance-date': ago(2), transactions: [txn('savin', 6, '500.00', 'FROM CHECKING')] }),
    fakeAccount({ id: 'MTG', name: 'Home Loan', balance: '-250000.00', 'balance-date': ago(2), transactions: [txn('mtgin', 4, '2000.00', 'PAYMENT RECEIVED')] }),
  ];
  const { connection_id } = await connect(ctx, 'simplefin', server.setupToken(`t${Math.random()}`), NOW);
  await trackAccounts(
    ctx,
    connection_id,
    [
      { remote_id: 'CHK', type: 'depository' },
      { remote_id: 'CARD', type: 'credit' },
      { remote_id: 'SAV', type: 'depository' },
      { remote_id: 'MTG', type: 'loan' },
    ],
    NOW
  );
  return connection_id;
}

const idOf = async (name: string) => [...(await connectorAccountsStore.getAll(ctx)).values()].find((a) => a.name === name)!.account_id;

/** The account's statement as the download writes it, read back by Nya's
 *  own parser: each record, and each TRNTYPE by FITID. */
async function statement(account_id: string, opts: { timeZone: string | null } = { timeZone: null }, at = NOW) {
  const data = await collectUserData({ ctx, userId: null });
  const doc = buildUserExport(data, new Date(at));
  const made = ofxFile(data, doc, account_id, new Date(at), { timeZone: opts.timeZone, balanceTakenAt: null });
  if ('refused' in made) return { refused: made.refused, status: made.status } as const;
  const bytes = new Uint8Array(Buffer.concat([...made.file.pieces()].map((p) => Buffer.from(made.file.encode!(p)))));
  const text = decodeFile(bytes).text;
  const parsed = parseOfx(text);
  expect(parsed.error).toBeNull();
  const types = new Map([...text.matchAll(/<TRNTYPE>(\w+)\r\n[\s\S]*?<FITID>([^\r\n]+)/g)].map((m) => [m[2], m[1]]));
  return { file: made.file, bytes, text, statements: parsed.statements, records: parsed.statements.flatMap((s) => ofxRecords(s).records), types };
}
type Written = Exclude<Awaited<ReturnType<typeof statement>>, { refused: string }>;
const written = (s: Awaited<ReturnType<typeof statement>>): Written => {
  if ('refused' in s) throw new Error(`refused: ${s.refused}`);
  return s;
};

const bookOf = async (account_id: string) => (await manualTxnStore.get(ctx, account_id))!.rows;

/** The note while a connection's older transactions are still arriving. */
async function arriving(connection_id: string): Promise<string> {
  const from = (await connectionsStore.get(ctx, connection_id))!.history!.from;
  const day = new Date(`${from}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return `SimpleFIN is still bringing in this account’s older transactions, a few months each night, so the statement has none before ${day} yet. Download it again once they are all in.`;
}
/** Its older transactions all in. */
const allIn = (connection_id: string) => connectionsStore.update(ctx, connection_id, (c) => (c ? { ...c, history: { ...c.history!, complete: true } } : c));

describe('an account SimpleFIN keeps up to date, as an OFX statement', () => {
  test('its rows from its book: FITIDs the rows’ ids, OFX’s sign, the exclusion marks, and a pair typed as a bank’s file types it', async () => {
    const connection_id = await trackAll();
    const checking = await idOf('Checking');
    const rows = await bookOf(checking);
    const coffee = rows.find((r) => r.name === 'COFFEE')!;
    await setExcluded(ctx, coffee.id, true);

    // Older transactions still arriving: said, and not once they are all in.
    let s = written(await statement(checking));
    expect(s.file.notes).toEqual([await arriving(connection_id)]);
    await allIn(connection_id);
    s = written(await statement(checking));
    expect(s.file.notes).toEqual([]);
    expect(s.file.incomplete).toEqual([]);
    expect(s.file.filename).toBe(`nya-my-bank-checking-${dayOf(NOW)}.ofx`);
    expect(s.statements.map((x) => [x.kind, x.currency, x.account.account_type])).toEqual([['bank', 'USD', 'CHECKING']]);
    // Every row of its book, by its own id, in Plaid's sign once read back.
    expect(s.records.map((r) => [r.source_id, r.date, r.amount, r.description]).sort()).toEqual(rows.map((r) => [r.id, r.date, r.amount, r.name]).sort());
    // The card's payment and the mortgage's are payments, the move to
    // savings a transfer, as a bank's file says them; the rest by the sign.
    const typeOf = (name: string) => s.types.get(rows.find((r) => r.name === name)!.id);
    expect(['COFFEE', 'PAYMENT TO VISA', 'MORTGAGE PMT', 'TO SAVINGS', 'PAYROLL'].map(typeOf)).toEqual(['DEBIT', 'PAYMENT', 'PAYMENT', 'XFER', 'CREDIT']);
    expect(s.records.find((r) => r.source_id === coffee.id)!.note).toBe('Excluded from budgets and reports in Nya');

    // The card: a card statement, its payment in typed PAYMENT, money in.
    const visa = written(await statement(await idOf('Visa')));
    const visaRows = await bookOf(await idOf('Visa'));
    expect(visa.statements.map((x) => [x.kind, x.ledger])).toEqual([['creditcard', { amount: -300, as_of: dayOf(NOW - 2 * DAY) }]]);
    const thanks = visaRows.find((r) => r.name === 'PAYMENT THANK YOU')!;
    expect([visa.types.get(thanks.id), visa.records.find((r) => r.source_id === thanks.id)!.amount]).toEqual(['PAYMENT', -300]);
    // Savings: the move in, typed XFER.
    const savings = written(await statement(await idOf('Savings')));
    expect([...savings.types.values()]).toEqual(['XFER']);
    // A loan has no statement in OFX, SimpleFIN's or not.
    expect(await statement(await idOf('Home Loan'))).toMatchObject({ status: 400, refused: expect.stringContaining('A loan has no statement') });
  });

  test('its balance: the one SimpleFIN last gave, as of the bank’s own day for it, where the person is', async () => {
    await trackAll();
    const checking = await idOf('Checking');
    // The bank's balance is from noon (UTC) two days ago: that day in UTC
    // and in Los Angeles, the next one at UTC+14.
    expect(written(await statement(checking)).statements[0].ledger).toEqual({ amount: 5000, as_of: dayOf(NOW - 2 * DAY) });
    expect(written(await statement(checking, { timeZone: 'America/Los_Angeles' })).statements[0].ledger).toEqual({ amount: 5000, as_of: dayOf(NOW - 2 * DAY) });
    expect(written(await statement(checking, { timeZone: 'Pacific/Kiritimati' })).statements[0].ledger).toEqual({ amount: 5000, as_of: dayOf(NOW - DAY) });
  });

  test('none while Nya holds it: a card waiting for its sign, and the other accounts at its bank, each saying why', async () => {
    const connection_id = await trackAll();
    await allIn(connection_id);
    // The card's balance comes back positive: until the person says which
    // way it goes, it has none, and its bank's balances are held.
    server.accounts = server.accounts.map((a: any) => (a.id === 'CARD' ? { ...a, balance: '120.00', 'balance-date': ago(0) } : a));
    await syncConnection(ctx, connection_id, { purpose: 'refresh', now: NOW + 60_000 });

    const visa = written(await statement(await idOf('Visa'), { timeZone: null }, NOW + 120_000));
    expect(visa.statements[0].ledger).toBeNull();
    expect(visa.file.notes).toEqual([
      'The statement has no balance: SimpleFIN reports this card’s balance as money held (+$120.00), and until you say on the Accounts tab which way it goes, Nya counts no balance for it.',
    ]);
    // Its transactions are all there.
    expect(visa.records).toHaveLength(2);

    const checking = written(await statement(await idOf('Checking'), { timeZone: null }, NOW + 120_000));
    expect(checking.statements[0].ledger).toBeNull();
    expect(checking.file.notes).toEqual([
      'The statement has no balance: Nya holds My Bank’s balances while SimpleFIN’s latest answer about it isn’t whole and current (SimpleFIN reports a card or loan as money held: say which way it goes), as the Accounts tab does.',
    ]);
    expect(checking.records).toHaveLength(5);
  });

  test('read back through Nya’s own import: every row with its id, date, amount and currency, a transfer as one, and a second import adds nothing', async () => {
    await trackAll();
    const target = { account_id: 'manual_target', name: 'Imported', institution_name: 'Elsewhere', type: 'depository', subtype: null, balance: 0, updated_at: '2026-10-01T09:00:00.000Z' };
    const card = { ...target, account_id: 'manual_target_card', name: 'Imported card', type: 'credit' };
    for (const a of [target, card]) await saveManualAccount(ctx, a as any);
    const send = async (account_id: string, bytes: Uint8Array) => {
      const form = new FormData();
      form.set('file', new Blob([bytes as Uint8Array<ArrayBuffer>]), 'statement.ofx');
      form.set('meta', JSON.stringify({ action: 'import', account_id, options: {}, file_name: 'statement.ofx' }));
      const res = await imports.POST(new Request('http://localhost/api/import', { method: 'POST', body: form }));
      return { status: res.status, body: await res.json() };
    };

    const checking = await idOf('Checking');
    const s = written(await statement(checking));
    const first = await send(target.account_id, s.bytes);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ imported: 5, present: 0, repeated: 0, unreadable: 0 });
    const source = await bookOf(checking);
    const back = await bookOf(target.account_id);
    expect(back.map((r) => [r.source_id, r.date, r.amount, r.currency, r.name]).sort()).toEqual(source.map((r) => [r.id, r.date, r.amount, r.currency, r.name]).sort());
    // The move to savings comes back a transfer out; a payment from a bank
    // account, which may pay any bill, without a category, as a bank's does.
    const categoryOf = (name: string) => back.find((r) => r.name === name)!.category;
    expect(['TO SAVINGS', 'PAYMENT TO VISA', 'COFFEE'].map(categoryOf)).toEqual(['transfer out', null, null]);
    const again = await send(target.account_id, s.bytes);
    expect(again.body).toMatchObject({ imported: 0, present: 5 });
    expect(await bookOf(target.account_id)).toHaveLength(5);

    // The card's payment in comes back a loan payment, as the CSV files it.
    const visa = written(await statement(await idOf('Visa')));
    expect((await send(card.account_id, visa.bytes)).body).toMatchObject({ imported: 2 });
    expect((await bookOf(card.account_id)).map((r) => [r.name, r.category]).sort()).toEqual([
      ['DINER', null],
      ['PAYMENT THANK YOU', 'loan payments'],
    ]);
  });

  test('let go: kept as a manual account, its pairs still typed; removed, refused; one whose record can’t be read, refused', async () => {
    const connection_id = await trackAll();
    const [checking, visa] = [await idOf('Checking'), await idOf('Visa')];
    await disconnect(ctx, connection_id, true, NOW + 60_000);
    // Kept: manual accounts now, their rows and pairs as before, the balance as kept.
    const kept = written(await statement(checking, { timeZone: null }, NOW + 120_000));
    const rows = await bookOf(checking);
    expect(kept.types.get(rows.find((r) => r.name === 'PAYMENT TO VISA')!.id)).toBe('PAYMENT');
    expect(kept.statements[0].ledger).toMatchObject({ amount: 5000 });
    expect(kept.file.notes).toEqual([]);
    expect(written(await statement(visa, { timeZone: null }, NOW + 120_000)).statements[0].kind).toBe('creditcard');

    // Removed: nothing to write. Never recorded, nothing mentions it any more;
    // with a balance recorded, its history still does, and it is said why.
    fake.reset();
    await registerTestContainer(fake);
    let again = await trackAll();
    let removed = await idOf('Checking');
    await disconnect(ctx, again, false, NOW + 60_000);
    expect(await statement(removed)).toMatchObject({ status: 404 });
    fake.reset();
    await registerTestContainer(fake);
    again = await trackAll();
    removed = await idOf('Checking');
    const nw = await computeNetWorth(ctx);
    await recordFetch(ctx, nw.institutions, nw.netWorth);
    await disconnect(ctx, again, false, NOW + 60_000);
    expect(await statement(removed)).toEqual({
      status: 400,
      refused: 'You stopped tracking this account through SimpleFIN and removed it, with its transactions, so it has no statement. Its balance history is in the JSON download.',
    });
  });

  test('an entry that can’t be read is refused, saying why, and nothing is written', async () => {
    await trackAll();
    const visa = await idOf('Visa');
    await fake.hset(ctxKey('connector-accounts'), { [visa]: 'damaged' });
    expect(await statement(visa)).toEqual({
      status: 409,
      refused: 'What Nya keeps about this account from SimpleFIN couldn’t be read, so Nya can’t tell what kind of account it is, and nothing was written. Its transactions are in the JSON download.',
    });
  });
});

describe('an account SimpleFIN fed in Australian dollars', () => {
  test('its statement is in AUD with its balance, tracked and once kept as a manual account', async () => {
    server.accounts = [
      fakeAccount({ id: 'AUD', name: 'Everyday', currency: 'AUD', balance: '2500.00', 'balance-date': ago(1), transactions: [txn('flat', 2, '-12.00', 'FLAT WHITE'), txn('wage', 5, '3000.00', 'WAGES')] }),
    ];
    const { connection_id } = await connect(ctx, 'simplefin', server.setupToken('aud'), NOW);
    await trackAccounts(ctx, connection_id, [{ remote_id: 'AUD', type: 'depository' }], NOW);
    await allIn(connection_id);
    const everyday = await idOf('Everyday');
    const tracked = written(await statement(everyday));
    expect(tracked.statements.map((x) => [x.currency, x.ledger, x.transactions.length])).toEqual([['AUD', { amount: 2500, as_of: dayOf(NOW - DAY) }, 2]]);
    expect(tracked.file.notes).toEqual([]);

    await disconnect(ctx, connection_id, true, NOW + 60_000);
    const kept = written(await statement(everyday, { timeZone: null }, NOW + 120_000));
    expect(kept.statements.map((x) => [x.currency, x.ledger?.amount ?? null, x.transactions.length])).toEqual([['AUD', 2500, 2]]);
    expect(kept.file.notes).toEqual([]);
    expect(kept.records.map((r) => r.currency)).toEqual(['AUD', 'AUD']);
  });
});
