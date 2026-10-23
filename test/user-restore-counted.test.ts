import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld } from './restore-fixture';

// The accounts a restore brought back from a bank connected through Plaid,
// counted before a link by the person's answer (lib/user-restore/answers.ts),
// after a real restore through the routes (test/restore-run.ts): counted as
// an ended account's, up to its end; held again by every connection made
// since until it is answered for (a Plaid Item, an account tracked through a
// connector, one kept as a manual account from one); handed over to a
// connector account, whose coverage takes the rows it holds; and failing
// closed. Every reader, to the cent.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_ENABLED = '1';

// Plaid has nothing new to say: what is stored is what the readers read.
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({ data: { added: [], modified: [], removed: [], accounts: [], next_cursor: 'c-next', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' } }),
  },
}));
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { markEnded } = await import('@/lib/lifecycle');
const { restoredAnswersStore } = await import('@/lib/user-restore/store');
const { coverageStart, handoverCut, unanswered } = await import('@/lib/user-restore/answers');
const { connectionsStore, connectorAccountsStore, endedAccountsStore } = await import('@/lib/connectors/store');
const { institutionRef } = await import('@/lib/connectors/institutions');
const { manualTxnStore } = await import('@/lib/manual-txns');
const { saveManualAccount } = await import('@/lib/manual');
const { queryTransactions } = await import('@/lib/api-read');
const { EXPORTED, downloadText, restoreAll, activity, rowsOf, connectAgain, hold } = await import('./restore-run');
const { NOV, JAN, month, every, shared } = await import('./restore-readers');

const ctx = TEST_CTX;

fake.reset();
await registerTestContainer(fake);
await seedOld(fake, ctx);
const OLD = await downloadText(EXPORTED);

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await restoreAll(OLD);
});

const AT = () => new Date().toISOString();
/** The person's answer for the restored checking account: count it, ended
 *  (closed) on a day, as the answers route writes it. */
async function count(on = '2026-10-07', more: Partial<{ apart: { items: string[]; accounts: string[] }; handed_to: { account_id: string; at: string } }> = {}) {
  await markEnded(ctx, 'acc_chk', { state: 'closed', on }, { type: 'depository', label: { name: 'Checking', institution: 'Chase', mask: '1111' }, item_id: 'item_chase', currency: 'USD' });
  await restoredAnswersStore.set(ctx, 'acc_chk', {
    version: 1,
    counted: { at: AT(), by: 'person', ended: { state: 'closed', on } },
    apart: more.apart ?? { items: [], accounts: [] },
    handed_to: more.handed_to ?? null,
    set_at: AT(),
  });
}
async function answer(change: Partial<{ apart: { items: string[]; accounts: string[] }; handed_to: { account_id: string; at: string } | null }>) {
  const was = (await restoredAnswersStore.get(ctx, 'acc_chk'))!;
  await restoredAnswersStore.set(ctx, 'acc_chk', { ...was, ...change, set_at: AT() });
}

/** A SimpleFIN account at Chase tracked since the restore, with its book. */
const SF = 'manual_sf_chk';
const CONN = 'conn_sf';
async function trackSimpleFin(opts: { from: string | null; rows: { day: string; amount: number; name: string; source?: string }[] }) {
  const at = AT();
  await connectionsStore.set(ctx, CONN, {
    version: 1,
    connector: 'simplefin',
    host: 'bridge.simplefin.org',
    created_at: at,
    last_fetch: null,
    last_answer_at: at,
    tracked: [{ remote_id: 'ACT-1', account_id: SF }],
    available: [],
    history: opts.from ? { from: opts.from, to: '2026-10-20', complete: false } : null,
  });
  await connectorAccountsStore.set(ctx, SF, {
    version: 1,
    account_id: SF,
    connection_id: CONN,
    connector: 'simplefin',
    remote_id: 'ACT-1',
    name: 'Total Checking',
    institution_name: 'Chase',
    institution_key: 'chase.com',
    institution_ref: institutionRef(CONN, 'chase.com'),
    type: 'depository',
    subtype: null,
    currency: 'USD',
    reported_balance: 1700,
    reported_available: null,
    balance_at: at,
    fetched_at: at,
    created_at: at,
  });
  await setBook(opts.rows);
}
async function setBook(rows: { day: string; amount: number; name: string; source?: string }[]) {
  const at = AT();
  await manualTxnStore.set(ctx, SF, {
    version: 1,
    rows: rows.map((r, i) => ({
      id: `manual-txn:0000000${i}-0000-4000-8000-00000000aaaa`,
      account_id: SF,
      date: r.day,
      amount: r.amount,
      currency: 'USD',
      name: r.name,
      category: 'food and drink',
      note: null,
      source: r.source ?? 'simplefin',
      source_id: r.source && r.source !== 'simplefin' ? null : `TRN-${i}`,
      created_at: at,
      updated_at: at,
    })),
  });
}

describe('waiting, with no answer', () => {
  test('counts nowhere, said under its months', async () => {
    expect(await month(NOV)).toEqual(every(0));
    expect(await shared(NOV)).toBe(0);
  });
});

describe('counted by the person', () => {
  test('counts its rows as an ended account’s, on the restored account itself: the grocery once, to the cent', async () => {
    await count();
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await month(JAN)).toEqual(every(25, JAN));
    expect(await shared(NOV)).toBe(61.2);
    // As the bank rows they were, the grocery as the old copy split it.
    const shown = rowsOf(await activity()).filter((r) => r[1] >= NOV.from && r[1] <= NOV.to);
    expect(shown.map((r) => [r[0], r[2]])).toEqual([
      ['split:p1', 40],
      ['split:p2', 21.2],
    ]);
    const page = await queryTransactions(ctx, { ...JAN, limit: 100 });
    expect(page.transactions.map((t) => [t.account_id, t.amount]).sort()).toEqual([
      ['acc_chk', 20.5],
      ['acc_chk', 4.5],
    ]);
    // Every row's account is listed by the API, as any account that ended.
    const { readAccounts } = await import('@/lib/api-read');
    const listed = (await readAccounts(ctx)).accounts.find((a) => a.id === 'acc_chk');
    expect(listed).toMatchObject({ name: 'Checking', institution: 'Chase', lifecycle: { state: 'closed', date: '2026-10-07' } });
    // It has an end, so it holds no total: only the card, unanswered, does
    // (its last day the books, Jan 3; the checking account's was Jan 4).
    expect((await hold()).waiting).toEqual([{ institution_name: 'Chase', last: '2026-01-03' }]);
  });

  test('up to its end: a row dated on or after it doesn’t count', async () => {
    await count('2026-01-03');
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await month(JAN)).toEqual(every(4.5, JAN));
  });

  test('an end alone counts nothing: the answer does', async () => {
    await markEnded(ctx, 'acc_chk', { state: 'untracked', from: '2026-10-07' }, { type: 'depository', label: { name: 'Checking', institution: 'Chase', mask: '1111' }, item_id: 'item_chase' });
    expect(await month(NOV)).toEqual(every(0));
    await restoredAnswersStore.set(ctx, 'acc_chk', { version: 1, counted: null, apart: { items: [], accounts: [] }, handed_to: null, set_at: AT() });
    expect(await month(NOV)).toEqual(every(0));
  });
});

describe('held by a connection made since', () => {
  test('a Plaid Item holds it from the moment it is stored, before any balance fetch, until it is answered for', async () => {
    await count();
    await connectAgain(fake);
    // The new connection's own rows are January's (the coffee, the gas and
    // the card's books: 55); November has only the restored grocery, held.
    expect(await month(NOV)).toEqual(every(0));
    expect(await month(JAN)).toEqual(every(55, JAN));
    const notes = (await activity()).notes ?? [];
    expect(JSON.stringify(notes)).toContain("Chase: transactions from your download aren't counted until you say whether Chase holds them");
    // Said not to be among its accounts: counted again, beside the new
    // connection's (the person's word; January counts both).
    await answer({ apart: { items: ['item_new'], accounts: [] } });
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await month(JAN)).toEqual(every(80, JAN));
  });

  test('an Item at another bank holds it too: a name can say a bank may be the same, never that it isn’t', async () => {
    await count();
    const { saveItem } = await import('@/lib/storage');
    const { encrypt } = await import('@/lib/crypto');
    await saveItem(ctx, { item_id: 'item_truist', institution_name: 'Truist', institution_id: 'ins_9', encrypted_access_token: await encrypt(ctx, 'access-sandbox-t') } as never);
    expect(await month(NOV)).toEqual(every(0));
    await answer({ apart: { items: ['item_truist'], accounts: [] } });
    expect(await month(NOV)).toEqual(every(61.2));
  });

  test('an account tracked through a connector since the restore holds it until it is said not to be this bank', async () => {
    await count();
    await trackSimpleFin({ from: '2026-01-01', rows: [{ day: '2026-01-04', amount: 20.5, name: 'GAS' }] });
    expect(await month(NOV)).toEqual(every(0));
    expect(await month(JAN)).toEqual(every(20.5, JAN));
    await answer({ apart: { items: [], accounts: [SF] } });
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await month(JAN)).toEqual(every(45.5, JAN));
  });

  test('let go and kept as a manual account, it holds still: its transactions are kept, so they still count', async () => {
    await count();
    await trackSimpleFin({ from: '2026-01-01', rows: [{ day: '2025-11-21', amount: 61.2, name: 'GROCER' }] });
    // Let go, kept (lib/connectors/manage.ts letGo): its entry goes, an ended
    // one says it was kept, and it is a manual account with its book.
    const entry = (await connectorAccountsStore.get(ctx, SF))!;
    await connectorAccountsStore.remove(ctx, SF);
    await endedAccountsStore.set(ctx, SF, {
      version: 1,
      connector: 'simplefin',
      connection_id: CONN,
      host: 'bridge.simplefin.org',
      remote_id: 'ACT-1',
      name: entry.name,
      institution_name: 'Chase',
      type: 'depository',
      currency: 'USD',
      tracked_at: entry.created_at,
      history_from: '2025-11-01',
      ended_at: AT(),
      kept: true,
    });
    await saveManualAccount(ctx, { account_id: SF, name: 'Total Checking', institution_name: 'Chase', type: 'depository', subtype: null, balance: 1700, updated_at: AT() });
    // The kept account's grocery counts; the restored one is held.
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await shared(NOV)).toBe(0);
    // Its answer outlives the letting go: named by its account id.
    await answer({ handed_to: { account_id: SF, at: AT() } });
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await shared(NOV)).toBe(0);
    // Removed with its rows, it holds nothing, and carries nothing on.
    await manualTxnStore.remove(ctx, SF);
    const { removeManualAccount } = await import('@/lib/manual');
    await removeManualAccount(ctx, SF);
    await endedAccountsStore.set(ctx, SF, { ...(await endedAccountsStore.get(ctx, SF))!, kept: false });
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await shared(NOV)).toBe(61.2);
  });

  test('which connections hold, as a rule', () => {
    const item = { kind: 'item' as const, id: 'item_new', institution: 'Chase', institution_id: 'ins_3' };
    const sf = { kind: 'connector' as const, id: SF, institution: 'Chase', name: 'Total Checking', card: 'abc', kept: false, via: 'simplefin' as const };
    const none = { version: 1 as const, counted: { at: AT(), by: 'person' as const, ended: null }, apart: { items: [], accounts: [] }, handed_to: null, set_at: AT() };
    expect(unanswered(none, [item, sf])).toEqual([item, sf]);
    expect(unanswered({ ...none, apart: { items: ['item_new'], accounts: [] } }, [item, sf])).toEqual([sf]);
    // Handed over: every connector account is answered (one carries it on);
    // an Item still asks.
    expect(unanswered({ ...none, handed_to: { account_id: 'other', at: AT() } }, [item, sf])).toEqual([item]);
  });
});

describe('handed over to a connector account', () => {
  test('counts only before its coverage begins, and not a row it holds itself; as its history reaches back, less and less', async () => {
    // SimpleFIN's history starts on Jan 4; a late coffee, posted after the
    // download and dated Jan 3, is its earliest row.
    await trackSimpleFin({
      from: '2026-01-04',
      rows: [
        { day: '2026-01-03', amount: 4.5, name: 'COFFEE' },
        { day: '2026-01-04', amount: 20.5, name: 'GAS' },
      ],
    });
    await count('2026-10-07', { handed_to: { account_id: SF, at: AT() } });
    // The cut is Jan 4: the restored gas is the connector's; the restored
    // coffee (Jan 2) pairs with its late one (Jan 3), so only one counts;
    // the grocery counts whole.
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await month(JAN)).toEqual(every(25, JAN));
    expect(await shared(JAN)).toBe(0);
    expect(await shared(NOV)).toBe(61.2);

    // A night later its history reaches back to November, with the grocery.
    await connectionsStore.set(ctx, CONN, { ...(await connectionsStore.get(ctx, CONN))!, history: { from: '2025-11-01', to: '2026-10-20', complete: false } });
    await setBook([
      { day: '2025-11-21', amount: 61.2, name: 'GROCER' },
      { day: '2026-01-03', amount: 4.5, name: 'COFFEE' },
      { day: '2026-01-04', amount: 20.5, name: 'GAS' },
    ]);
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await month(JAN)).toEqual(every(25, JAN));
    expect(await shared(NOV)).toBe(0);
  });

  test('while its account has no rows yet, the restored ones count whole: nothing else does', async () => {
    await trackSimpleFin({ from: null, rows: [] });
    await count('2026-10-07', { handed_to: { account_id: SF, at: AT() } });
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await month(JAN)).toEqual(every(25, JAN));
  });

  test('a row imported into it from a file pairs as its provider’s would; one where it has nothing doesn’t take the restored row', async () => {
    await trackSimpleFin({
      from: '2026-01-04',
      rows: [
        { day: '2025-11-19', amount: 61.2, name: 'GROCER 9', source: 'import:ofx' },
        { day: '2026-01-04', amount: 20.5, name: 'GAS' },
      ],
    });
    await count('2026-10-07', { handed_to: { account_id: SF, at: AT() } });
    expect(await month(NOV)).toEqual(every(61.2));
    expect(await shared(NOV)).toBe(0);
    expect(await month(JAN)).toEqual(every(25, JAN));
  });

  test('the cut, as rules', () => {
    expect(coverageStart(null)).toBeNull();
    expect(coverageStart('2026-01-04')).toBe('2026-01-04');
    // A window the answers left it out of, from its start: moved past it.
    expect(coverageStart('2026-01-04', [{ from: '2026-01-04', to: '2026-01-10' }])).toBe('2026-01-11');
    expect(coverageStart('2026-01-04', [{ from: '2026-01-01', to: '2026-01-05' }, { from: '2026-01-06', to: '2026-01-08' }])).toBe('2026-01-09');
    // One later than the start leaves it.
    expect(coverageStart('2026-01-04', [{ from: '2026-02-01', to: '2026-02-03' }])).toBe('2026-01-04');
    // Still open: no coverage is known.
    expect(coverageStart('2026-01-04', [{ from: '2026-01-04', to: null }])).toBeNull();
    expect(handoverCut('2026-01-04', '2026-01-03')).toBe('2026-01-04');
    expect(handoverCut('2026-01-04', '2026-01-09')).toBe('2026-01-09');
    expect(handoverCut(null, '2026-01-09')).toBeNull();
    expect(handoverCut('2026-01-04', null)).toBeNull();
  });
});

describe('fails closed', () => {
  test('an answer that can’t be read counts nothing, said', async () => {
    await count();
    await fake.hset(ctxKey('restored-answers'), { acc_chk: 'not a value Nya wrote' });
    expect(await month(NOV)).toEqual(every(0));
    expect(JSON.stringify((await activity()).notes ?? [])).toContain("aren't counted while what was answered about them can't be read");
  });

  test('a connector account that can’t be read holds every counted account, said', async () => {
    await count();
    await fake.hset(ctxKey('connector-accounts'), { manual_x: 'not a value Nya wrote' });
    expect(await month(NOV)).toEqual(every(0));
    expect(JSON.stringify((await activity()).notes ?? [])).toContain("aren't counted while what was answered about them can't be read");
  });

  test('a handover whose account can’t be read holds the restored rows, said', async () => {
    await trackSimpleFin({ from: '2026-01-04', rows: [{ day: '2026-01-04', amount: 20.5, name: 'GAS' }] });
    await count('2026-10-07', { handed_to: { account_id: SF, at: AT() } });
    await fake.hset(ctxKey('manual-transactions'), { [SF]: 'not a value Nya wrote' });
    expect(await shared(NOV)).toBe(0);
    expect(JSON.stringify((await activity()).notes ?? [])).toContain('aren’t shown while the account that carries it on can’t be read'.replace(/’/g, "'"));
  });
});
