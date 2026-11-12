import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld } from './restore-fixture';

// The months imported for an investment account (lib/investment-months-
// store.ts) brought back from a download (lib/user-restore/): each import as
// it was, under the id it was imported on, and read across a link to the
// account's new id once the bank is connected again.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_UNDO_PAUSE_MS = '0';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { forgetEpochs } = await import('@/lib/sessions');
const { linkAccounts } = await import('@/lib/links');
const { investmentMonthsStore, readInvestmentMonths } = await import('@/lib/investment-months-store');
const { EXPORTED, holdClockAfterExport, downloadText, restoreAll, connectAgain } = await import('./restore-run');
holdClockAfterExport();

const ctx = TEST_CTX;

const IMPORTS = {
  imports: [
    { id: 'import-old-0001', source: 'vanguard-performance' as const, file_name: 'Performance.pdf', imported_at: '2026-09-01T10:00:00.000Z', start: { month: '2024-01', balance: 0 }, months: [{ month: '2024-01', net: 500, returns: -2.5, end: 497.5 }], currency: 'USD', typed: ['2024-01'] },
    { id: 'import-old-0002', source: 'vanguard-performance' as const, file_name: null, imported_at: '2026-09-02T10:00:00.000Z', start: { month: '2024-01', balance: 0 }, months: [{ month: '2024-01', net: 500, returns: -2.5, end: 497.5 }, { month: '2024-02', net: 0, returns: 10, end: 507.5 }], currency: 'USD' },
  ],
};

fake.reset();
await registerTestContainer(fake);
await seedOld(fake, ctx);
await investmentMonthsStore.set(ctx, 'acc_chk', IMPORTS);
const OLD = await downloadText(EXPORTED);

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  process.env.RESTORE_ENABLED = '1';
});

describe('a round trip', () => {
  test('every import comes back as it was, under its id, and reads across a link to the new id', async () => {
    expect(JSON.parse(OLD)['investment-months']).toEqual([{ id: 'acc_chk', value: IMPORTS }]);
    const record = await restoreAll(OLD);
    expect(record).toMatchObject({ status: 'finished', without: {} });
    expect(JSON.parse(await downloadText(new Date()))['investment-months']).toEqual(JSON.parse(OLD)['investment-months']);
    expect(await investmentMonthsStore.get(ctx, 'acc_chk')).toEqual(IMPORTS);

    await connectAgain(fake);
    await linkAccounts(ctx, 'acc_chk', 'new_chk', {});
    expect(await readInvestmentMonths(ctx, 'new_chk')).toEqual(IMPORTS);
  });
});
