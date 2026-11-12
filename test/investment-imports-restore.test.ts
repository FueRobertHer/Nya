import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld } from './restore-fixture';

// The transactions imported for an investment account (lib/investment-
// imports-store.ts) brought back from a download (lib/user-restore/): each
// account's entry of each import as it was, under the key it was imported
// on, read across a link to the account's new id once the bank is connected
// again; and a piece of a large entry (parts.ts SEAM split on rows) checked
// as the store stores it, under a key that is an account's and an import's.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_UNDO_PAUSE_MS = '0';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { linkAccounts } = await import('@/lib/links');
const { investmentImportsStore, importKeys, readAccountImports } = await import('@/lib/investment-imports-store');
const { checkBatch, BatchRefused } = await import('@/lib/user-restore/check');
const { EXPORTED, holdClockAfterExport, downloadText, restoreAll, connectAgain } = await import('./restore-run');
holdClockAfterExport();

const ctx = TEST_CTX;

const row = (date: string, amount: number) => ({ date, name: 'Funds Received', type: 'cash', subtype: 'deposit', quantity: 0, price: 0, amount, fees: 0, currency: 'USD', security: null });
const ENTRY = {
  source: 'vanguard-csv' as const,
  file_name: 'OfxDownload.csv',
  imported_at: '2026-09-01T10:00:00.000Z',
  covers: { from: '2026-06-01', to: '2026-08-31' },
  currency: 'USD',
  rows: [row('2026-06-02', -500), row('2026-07-02', -500), row('2026-08-02', -250.5)],
};
const KEY = 'acc_chk:import-old-0001';
const ROTH = 'acc_sav:import-old-0001';

fake.reset();
await registerTestContainer(fake);
await seedOld(fake, ctx);
await investmentImportsStore.setMany(ctx, [
  [KEY, ENTRY],
  [ROTH, { ...ENTRY, rows: [row('2026-06-03', -7000)] }],
]);
const OLD = await downloadText(EXPORTED);

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  process.env.RESTORE_ENABLED = '1';
});

describe('a round trip', () => {
  test('every entry comes back as it was, under its key, and reads across a link to the new id', async () => {
    expect(JSON.parse(OLD)['investment-imports']).toEqual([
      { id: KEY, value: ENTRY },
      { id: ROTH, value: { ...ENTRY, rows: [row('2026-06-03', -7000)] } },
    ]);
    const record = await restoreAll(OLD);
    expect(record).toMatchObject({ status: 'finished', without: {} });
    expect(JSON.parse(await downloadText(new Date()))['investment-imports']).toEqual(JSON.parse(OLD)['investment-imports']);
    expect(await investmentImportsStore.get(ctx, KEY)).toEqual(ENTRY);

    await connectAgain(fake);
    await linkAccounts(ctx, 'acc_chk', 'new_chk', {});
    const read = await readAccountImports(ctx, ['new_chk'], await importKeys(ctx));
    expect(read.get('new_chk')).toEqual([{ ...ENTRY, account_id: 'acc_chk', import_id: 'import-old-0001' }]);
  });
});

describe('a batch', () => {
  const refused = (batch: unknown) => {
    try {
      checkBatch(batch, { exported: '2026-10-10T12:00:00.000Z', today: '2026-10-12' });
      return 'passed';
    } catch (err) {
      if (err instanceof BatchRefused) return err.problem;
      throw err;
    }
  };

  test('a piece of an entry is checked as stored, under a key that is an account’s and an import’s', () => {
    expect(refused({ part: 'store:investment-imports', records: [{ id: KEY, from: 2, value: { ...ENTRY, rows: ENTRY.rows.slice(2) } }] })).toBe('passed');
    expect(refused({ part: 'store:investment-imports', records: [{ id: 'acc_chk', value: ENTRY }] })).toContain('an account’s and an import’s');
    expect(refused({ part: 'store:investment-imports', records: [{ id: KEY, value: { ...ENTRY, rows: [{ ...row('2026-06-02', -1), line: 4 }] } }] })).toContain('isn’t transactions imported from your brokerage');
    expect(refused({ part: 'store:investment-imports', records: [{ id: KEY, value: { ...ENTRY, newer: 1 } }] })).toContain('isn’t transactions imported from your brokerage');
  });
});
