import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld } from './restore-fixture';

// Shared expenses (#49) brought back from a download (lib/user-restore/):
// the people, the IOUs and the setting as they were; the shares, the
// payments and the rows said to pay nothing back under the ids their
// transactions come back under, as every store kept by transaction does; and
// the Activity tab counts your part of the restored rows as it did before.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.APP_PASSWORD = 'hunter2';
process.env.RESTORE_UNDO_PAUSE_MS = '0';

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { restoredId } = await import('@/lib/user-restore/ids');
const { forgetEpochs } = await import('@/lib/sessions');
const { createPerson, saveShare, saveIou, confirmPayment, dismissRow, saveSettings } = await import('@/lib/shared-expenses/edits');
const { readCard } = await import('@/lib/shared-expenses/read');
const { linkAccounts } = await import('@/lib/links');
const { EXPORTED, downloadText, restoreAll, activity, connectAgain } = await import('./restore-run');

const ctx = TEST_CTX;

/** The old copy, with Sam: half of the grocer's first part shared with
 *  them, an IOU you owe them that the gas paid, the card's books said to pay
 *  nothing back, and counting at your part said outright. */
async function seedShared() {
  const sam = (await createPerson(ctx, { name: 'Sam Rivera', venmo: 'sam-r' })).id;
  const share = await saveShare(ctx, 't_old', { part: 'p1', entries: [{ person: sam, amount: 20, how: { kind: 'half' } }] });
  const iou = await saveIou(ctx, null, { person: sam, direction: 'by_you', amount: 20.5, currency: 'USD', date: '2026-01-03', what: 'Tickets Sam bought' });
  await confirmPayment(ctx, 't_posted', { allocations: [{ item: iou.id, amount: 20.5 }] });
  await dismissRow(ctx, 't_card');
  await saveSettings(ctx, { counting: 'part' });
  return { sam, entry: share.entries[0].id, iou: iou.id };
}

fake.reset();
await registerTestContainer(fake);
await seedOld(fake, ctx);
const SEEDED = await seedShared();
const OLD = { text: await downloadText(EXPORTED), card: await readCard(ctx), activity: (await activity()).transactions };

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  process.env.RESTORE_ENABLED = '1';
});

describe('a round trip', () => {
  test('the people, IOUs and setting come back as they were; what is kept by transaction, under the restored ids', async () => {
    const record = await restoreAll(OLD.text);
    expect(record).toMatchObject({ status: 'finished', without: {} });
    const a = JSON.parse(OLD.text);
    const b = JSON.parse(await downloadText(new Date()));
    for (const section of ['expense-people', 'expense-ious', 'expense-settings']) expect(b[section]).toEqual(a[section]);
    const rekeyed = (list: any[]) => list.map((x) => ({ ...x, id: restoredId(x.id) }));
    expect(a['expense-shares'].map((x: any) => x.id)).toEqual(['t_old']);
    expect(b['expense-shares']).toEqual(rekeyed(a['expense-shares']));
    expect(b['expense-payments']).toEqual(rekeyed(a['expense-payments']));
    expect(b['expense-dismissed']).toEqual(rekeyed(a['expense-dismissed']));
    // The balances are what they were.
    const card = await readCard(ctx);
    expect(card.balances).toEqual(OLD.card.balances);
    expect(card.balances!.get(SEEDED.sam)).toEqual([{ currency: 'USD', amount: 20, open: 1, oldest: '2025-11-20', over: 0 }]);
  });

  test('connected again and linked, the Activity tab counts your part of the restored rows as it did, the bank’s own row taking the payment its restored row had', async () => {
    await restoreAll(OLD.text);
    await connectAgain(fake);
    await linkAccounts(ctx, 'acc_chk', 'new_chk', {});
    await linkAccounts(ctx, 'acc_card', 'new_card', {});
    const after = (await activity()).transactions;
    const shown = (rows: any[]) => rows.map((t: any) => [t.amount, t.shared_was ?? null, t.excluded ?? null, t.shared_part?.kind ?? null]);
    // The grocer's first part at your half, the other half Sam's: older than
    // the bank's window, so the restored row's.
    const parts = (rows: any[], of: string) => rows.filter((t: any) => t.split_of === of);
    expect(shown(parts(OLD.activity, 't_old'))).toEqual([
      [20, 40, null, null],
      [20, null, true, 'theirs'],
      [21.2, null, null, null],
    ]);
    expect(shown(parts(after, restoredId('t_old')))).toEqual(shown(parts(OLD.activity, 't_old')));
    // The gas paid the IOU: the bank's row, sent again, stands for the
    // restored one, and the payment applies to it as it did.
    const gas = (rows: any[], id: string) => rows.filter((t: any) => t.shared_of === id);
    expect(shown(gas(OLD.activity, 't_posted'))).toEqual([
      [0, 20.5, null, null],
      [20.5, null, true, 'repaid'],
    ]);
    expect(shown(gas(after, 'n_gas'))).toEqual(shown(gas(OLD.activity, 't_posted')));
    // And the totals the rows make are the same: nothing counted twice.
    const total = (rows: any[]) => rows.filter((t: any) => !t.excluded && t.transaction_id !== 'n_new').reduce((n: number, t: any) => n + Math.round(t.amount * 100), 0);
    expect(total(after)).toBe(total(OLD.activity));
  });
});
