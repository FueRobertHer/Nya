import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { FakeSimplefin, fakeAccount, type FakeTxn } from './simplefin-fake';

// Carrying on an account a restore brought back from a SimpleFIN connection
// with an account tracked through a connection made since, whose ids are
// other ones (lib/connectors/continue.ts), against a local fake server and a
// real download and restore (test/restore-run.ts): asked, never assumed;
// one account, its rows matched as they arrive by the import's rule, a
// window sent twice matching nothing twice; what the first answers found;
// undone exactly; behind its switch; and what the release before does with
// it.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_ENABLED = '1';
process.env.RESTORE_CARRY_ON_ENABLED = '1';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy({}, { get: () => async () => { throw new Error('Plaid must not be called'); } }),
}));

const { setTransportForTests } = await import('@/lib/connectors/http');
const { connect, trackAccounts } = await import('@/lib/connectors/manage');
const { syncConnection } = await import('@/lib/connectors/sync');
const { connectionsStore, connectorAccountsStore, isConnectorAccount } = await import('@/lib/connectors/store');
const { waitingRestored, evidenceOf, carryEvidence, undoCarryOn, carryOnView } = await import('@/lib/connectors/continue');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { forgetEpochs } = await import('@/lib/sessions');
const { downloadText, restoreAll, activity, rowsOf } = await import('./restore-run');

const ctx = TEST_CTX;
/** The copy the download comes from. */
const OTHER = { container: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' } as typeof TEST_CTX;
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

/** The old copy: Checking at My Bank tracked through SimpleFIN, with three
 *  transactions, then downloaded. */
async function oldCopy(): Promise<{ text: string; restored: string }> {
  server.accounts = [
    fakeAccount({ id: 'CHK', name: 'Checking', balance: '1500.25', 'balance-date': ago(1), transactions: [txn('c1', 3, '-12.50', 'COFFEE'), txn('c2', 10, '2500.00', 'PAYROLL'), txn('c3', 40, '-80.00', 'GROCER')] }),
  ];
  const { connection_id } = await connect(OTHER, 'simplefin', server.setupToken(`old-${Math.random()}`), NOW - 2 * DAY);
  await trackAccounts(OTHER, connection_id, [{ remote_id: 'CHK', type: 'depository' }], NOW - 2 * DAY);
  const restored = [...(await connectorAccountsStore.getAll(OTHER)).values()][0].account_id;
  return { text: await downloadText(new Date(NOW - DAY), OTHER), restored };
}

let OLD: { text: string; restored: string };
beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  server.reset();
  setTransportForTests(server.transport());
  await registerTestContainer(fake);
  OLD = await oldCopy();
  await restoreAll(OLD.text);
  // The other copy's connection reached another server: what moving a copy
  // to a new SimpleFIN Bridge account looks like.
  const old = [...(await connectionsStore.getAll(ctx))][0];
  await connectionsStore.set(ctx, old[0], { ...old[1], host: 'old-bridge.example' });
  // The new access: the same account under another id, its two older rows
  // as before, a late one posted after the download, and a new one.
  server.accounts = [
    fakeAccount({
      id: 'CHK2',
      name: 'Checking',
      balance: '1492.48',
      'balance-date': ago(1),
      transactions: [txn('n1', 3, '-12.50', 'COFFEE'), txn('n2', 10, '2500.00', 'PAYROLL'), txn('n3', 1, '-5.00', 'NEW ROW'), txn('n4', 4, '-7.77', 'LATE ROW')],
    }),
  ];
});

/** Connects again through SimpleFIN, as a new connection. */
async function connectNew(): Promise<string> {
  const { connection_id } = await connect(ctx, 'simplefin', server.setupToken(`new-${Math.random()}`), NOW);
  return connection_id;
}

const bookOf = async (id: string) => ((await manualTxnStore.get(ctx, id))?.rows ?? []).map((r) => [r.source_id, r.date, r.amount, r.name, r.continues?.source_id ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
/** What Activity counts of the account's rows, to the cent. */
const shownSum = async (id: string) => {
  const ids = new Set(((await manualTxnStore.get(ctx, id))?.rows ?? []).map((r) => r.id));
  return Math.round(rowsOf(await activity()).filter((r) => ids.has(r[0])).reduce((s, r) => s + Number(r[2]), 0) * 100) / 100;
};

describe('asked, never assumed', () => {
  test('while a restored account waits, tracking asks which it is, or that it is new, offering it by its evidence', async () => {
    const waiting = await waitingRestored(ctx);
    expect(waiting.map((w) => w.account.account_id)).toEqual([OLD.restored]);
    const conn = await connectNew();
    const stored = (await connectionsStore.get(ctx, conn))!;
    // The same bank and name, and currency: likely; another server.
    expect(evidenceOf({ remote_id: 'CHK2', name: 'Checking', institution: 'My Bank', currency: 'USD' }, stored, waiting[0])).toBe('likely');
    expect(evidenceOf({ remote_id: 'CHK2', name: 'Checking', institution: 'My Bank', currency: 'EUR' }, stored, waiting[0])).toBeNull();
    const { carry } = await carryOnView(ctx, await connectionsStore.getAll(ctx), [...(await connectorAccountsStore.getAll(ctx)).values()], true);
    expect(carry.offers[conn]).toEqual({ CHK2: [{ account_id: OLD.restored, evidence: 'likely' }] });
    await expect(trackAccounts(ctx, conn, [{ remote_id: 'CHK2', type: 'depository' }], NOW)).rejects.toThrow('Say whether Checking is one of the accounts from your download, or a new one.');
  });

  test('said to be new, it is a new account: both count, by the person’s word', async () => {
    const conn = await connectNew();
    await trackAccounts(ctx, conn, [{ remote_id: 'CHK2', type: 'depository', continues: null }], NOW);
    expect(await connectorAccountsStore.count(ctx)).toBe(2);
    expect((await connectorAccountsStore.get(ctx, OLD.restored))!.version).toBe(1);
  });

  test('with the switch off, nothing is asked, and carrying on is refused', async () => {
    delete process.env.RESTORE_CARRY_ON_ENABLED;
    try {
      const conn = await connectNew();
      await expect(trackAccounts(ctx, conn, [{ remote_id: 'CHK2', type: 'depository', continues: OLD.restored }], NOW)).rejects.toThrow('isn’t turned on');
      await trackAccounts(ctx, conn, [{ remote_id: 'CHK2', type: 'depository' }], NOW);
      expect(await connectorAccountsStore.count(ctx)).toBe(2);
    } finally {
      process.env.RESTORE_CARRY_ON_ENABLED = '1';
    }
  });
});

describe('carried on', () => {
  test('one account: its rows from the download taken over by the new ones they match, the rest added, nothing counted twice', async () => {
    const conn = await connectNew();
    await trackAccounts(ctx, conn, [{ remote_id: 'CHK2', type: 'depository', continues: OLD.restored }], NOW);
    const entry = (await connectorAccountsStore.get(ctx, OLD.restored))!;
    expect(entry).toMatchObject({ version: 2, connection_id: conn, remote_id: 'CHK2', continued: { from: { remote_id: 'CHK', host: 'old-bridge.example' }, until: dayOf(NOW - 3 * DAY), by_id: false } });
    expect(await connectorAccountsStore.count(ctx)).toBe(1);
    // The new connection tracks it under its id; the old one no longer does,
    // and nothing is offered twice.
    const now = (await connectionsStore.get(ctx, conn))!;
    expect(now.tracked).toEqual([{ remote_id: 'CHK2', account_id: OLD.restored }]);
    expect(now.available).toEqual([]);
    const [oldId] = [...(await connectionsStore.getAll(ctx)).keys()].filter((id) => id !== conn);
    expect((await connectionsStore.get(ctx, oldId))!.tracked).toEqual([]);
    // The coffee and the payroll are the same rows, under the new ids, with
    // what they were kept; the grocer stays; the late row and the new one
    // are added.
    expect(await bookOf(OLD.restored)).toEqual([
      ['c3', dayOf(NOW - 40 * DAY), expect.any(Number), 'GROCER', null],
      ['n1', dayOf(NOW - 3 * DAY), expect.any(Number), 'COFFEE', 'c1'],
      ['n2', dayOf(NOW - 10 * DAY), expect.any(Number), 'PAYROLL', 'c2'],
      ['n3', dayOf(NOW - 1 * DAY), expect.any(Number), 'NEW ROW', null],
      ['n4', dayOf(NOW - 4 * DAY), expect.any(Number), 'LATE ROW', null],
    ]);
    // Activity counts each once: every row of the book, and nothing else of it.
    const counted = await shownSum(OLD.restored);
    const book = (await manualTxnStore.get(ctx, OLD.restored))!.rows;
    expect(counted).toBe(Math.round(book.reduce((t, r) => t + r.amount, 0) * 100) / 100);
    expect(counted).not.toBe(0);
    // The same window sent again matches nothing twice.
    await syncConnection(ctx, conn, { purpose: 'refresh', now: NOW + 13 * 3_600_000 });
    expect((await manualTxnStore.get(ctx, OLD.restored))!.rows).toHaveLength(5);
    expect(await shownSum(OLD.restored)).toBe(counted);
    // What the first answers found: of the rows SimpleFIN sent up to the
    // last day from the download, two were in it and one was added.
    expect(carryEvidence(entry, (await manualTxnStore.get(ctx, OLD.restored))!.rows)).toEqual({ until: dayOf(NOW - 3 * DAY), matched: 2, added: 1 });
  });

  test('undone, exactly: the rows it took over given back, those it added removed, the account waiting on its old connection again', async () => {
    const before = await bookOf(OLD.restored);
    const conn = await connectNew();
    await trackAccounts(ctx, conn, [{ remote_id: 'CHK2', type: 'depository', continues: OLD.restored }], NOW);
    expect(await undoCarryOn(ctx, OLD.restored)).toEqual({ removed: 2 });
    expect(await bookOf(OLD.restored)).toEqual(before);
    const entry = (await connectorAccountsStore.get(ctx, OLD.restored))!;
    expect(entry).toMatchObject({ version: 1, remote_id: 'CHK' });
    expect(entry.continued).toBeUndefined();
    expect((await connectionsStore.get(ctx, entry.connection_id))!.tracked).toEqual([{ remote_id: 'CHK', account_id: OLD.restored }]);
    // Offered again where it was carried on, and waiting again.
    expect((await connectionsStore.get(ctx, conn))!).toMatchObject({ tracked: [], available: [expect.objectContaining({ remote_id: 'CHK2' })] });
    expect((await waitingRestored(ctx)).map((w) => w.account.account_id)).toEqual([OLD.restored]);
    await expect(undoCarryOn(ctx, OLD.restored)).rejects.toThrow('wasn’t carried on');
  });

  test('a carrying on that stopped part way is finished by the same choice made again', async () => {
    const conn = await connectNew();
    // Stopped after the new connection's list gained it: the entry is as it was.
    await connectionsStore.update(ctx, conn, (c) => (c ? { ...c, tracked: [{ remote_id: 'CHK2', account_id: OLD.restored }] } : c));
    await trackAccounts(ctx, conn, [{ remote_id: 'CHK2', type: 'depository', continues: OLD.restored }], NOW);
    expect((await connectorAccountsStore.get(ctx, OLD.restored))!).toMatchObject({ version: 2, connection_id: conn });
    expect((await connectionsStore.get(ctx, conn))!.available).toEqual([]);
  });

  test('comes back with a download of this copy, and the release before reads it as unrecognised, fetching nothing for it', async () => {
    const conn = await connectNew();
    await trackAccounts(ctx, conn, [{ remote_id: 'CHK2', type: 'depository', continues: OLD.restored }], NOW);
    const entry = (await connectorAccountsStore.get(ctx, OLD.restored))!;
    const rows = (await manualTxnStore.get(ctx, OLD.restored))!.rows;
    const text = await downloadText(new Date());
    fake.reset();
    forgetEpochs();
    await registerTestContainer(fake);
    await restoreAll(text);
    expect(await connectorAccountsStore.get(ctx, OLD.restored)).toEqual(entry);
    expect((await manualTxnStore.get(ctx, OLD.restored))!.rows.map((r) => r.continues ?? null)).toEqual(rows.map((r) => r.continues ?? null));
    // The release before checks `version === 1` (lib/connectors/store.ts at
    // a5ac49b); this one's check is closed: version 2 only with what it
    // continues, version 1 never with it.
    const releaseBefore = (v: Record<string, unknown>) => v.version === 1;
    expect(releaseBefore(entry as never)).toBe(false);
    expect(isConnectorAccount({ ...entry, continued: undefined })).toBe(false);
    expect(isConnectorAccount({ ...entry, version: 1 })).toBe(false);
  });

  test('refused for another currency, and for one account twice', async () => {
    server.accounts = [
      fakeAccount({ id: 'CHK2', name: 'Checking', currency: 'EUR', balance: '1.00', 'balance-date': ago(1), transactions: [] }),
      fakeAccount({ id: 'CHK3', name: 'Checking too', balance: '1.00', 'balance-date': ago(1), transactions: [] }),
      fakeAccount({ id: 'CHK4', name: 'Checking three', balance: '1.00', 'balance-date': ago(1), transactions: [] }),
    ];
    const conn = await connectNew();
    await expect(trackAccounts(ctx, conn, [{ remote_id: 'CHK2', type: 'depository', continues: OLD.restored }], NOW)).rejects.toThrow('an account doesn’t change currency');
    await expect(
      trackAccounts(
        ctx,
        conn,
        [
          { remote_id: 'CHK3', type: 'depository', continues: OLD.restored },
          { remote_id: 'CHK4', type: 'depository', continues: OLD.restored },
        ],
        NOW
      )
    ).rejects.toThrow('can be carried on by one account only');
    // Nothing was tracked.
    expect((await connectionsStore.get(ctx, conn))!.tracked).toEqual([]);
  });
});
