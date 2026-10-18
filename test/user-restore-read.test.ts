import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld } from './restore-fixture';

// What reads an account a restore brought back (lib/user-restore/
// restored.ts, and the readers that take its rows), after a real restore
// through the routes (test/restore-run.ts): forgetting it, the totals hold
// failing closed, the directory entry that keeps its rows live, a file
// imported into the account it is linked to, a category's uses, and the
// backfill.

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

const { restoredId } = await import('@/lib/user-restore/ids');
const { restoredTxnStore, restoredAccountsStore, userRestoreStore } = await import('@/lib/user-restore/store');
const { holdsTotals, restoreUnfinished } = await import('@/lib/user-restore/restored');
const { forgetEpochs } = await import('@/lib/sessions');
const { linkAccounts, forgetEarlierAccount } = await import('@/lib/links');
const { getOverrides } = await import('@/lib/overrides');
const { txnAnnotationStore } = await import('@/lib/txn-annotations');
const { splitStore } = await import('@/lib/splits');
const { approvalStore } = await import('@/lib/review-store');
const { groupStore } = await import('@/lib/groups');
const { taxonomyStore } = await import('@/lib/category-store');
const { categoryUsages } = await import('@/lib/category-usage');
const { historyImportStore } = await import('@/lib/history-import/store');
const historyImport = await import('@/app/api/history-import/route');
const backfill = await import('@/app/api/backfill/route');
const { EXPORTED, downloadText, restoreAll, activity, rowsOf, hold, connectAgain } = await import('./restore-run');

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

/** Connected again, and both restored accounts linked to their new ones. */
async function linked() {
  await connectAgain(fake);
  await linkAccounts(ctx, 'acc_chk', 'new_chk', {});
  await linkAccounts(ctx, 'acc_card', 'new_card', {});
}

describe('forgetting a restored account', () => {
  test('takes its rows, what was said about them and its entry; the other restored account keeps its own', async () => {
    const coffee = restoredId('t_coffee');
    await forgetEarlierAccount(ctx, 'acc_card');
    expect([...(await restoredTxnStore.getAll(ctx)).keys()]).toEqual(['acc_chk.1']);
    expect([...(await restoredAccountsStore.getAll(ctx)).keys()]).toEqual(['acc_chk']);
    // The checking account's rows keep what was said about them.
    expect(await getOverrides(ctx)).toEqual({ [coffee]: 'Treats' });
    expect([...(await txnAnnotationStore.getAll(ctx)).keys()]).toEqual([coffee]);
    expect([...(await splitStore.getAll(ctx)).keys()]).toEqual([restoredId('t_old')]);
    expect([...(await approvalStore.getAll(ctx)).keys()].sort()).toEqual([coffee, restoredId('t_pending')].sort());
    // A group of the card's books and the coffee keeps the coffee, and says
    // one of its transactions is gone, as when the bank takes one back.
    expect((await groupStore.get(ctx, 'g1'))).toMatchObject({ members: [coffee], removed: 1 });
  });

  test('a restored account another one is linked to is forgotten only once that link is gone', async () => {
    await expect(forgetEarlierAccount(ctx, 'acc_chk')).rejects.toThrow('can\'t be forgotten');
  });
});

describe('the totals hold', () => {
  test('fails closed: a restored account, or a record, that can’t be read withholds the total and says so', async () => {
    expect(holdsTotals(await hold())).toBe(true);
    await linked();
    expect(holdsTotals(await hold())).toBe(false);
    await fake.hset(ctxKey('restored-accounts'), { acc_chk: 'not a value Nya wrote' });
    expect(await hold()).toMatchObject({ unreadable: true });
    expect(holdsTotals(await hold())).toBe(true);
    await fake.hdel(ctxKey('restored-accounts'), 'acc_chk');
    await fake.set(ctxKey('user-restore'), 'not a value Nya wrote');
    expect(await hold()).toMatchObject({ unfinished: true });
    expect(await restoreUnfinished(ctx)).toBe(true);
  });

  test('the backfill waits while a restored bank waits', async () => {
    await connectAgain(fake);
    const res = await backfill.POST();
    expect(await res.json()).toEqual({ skipped: true, reason: 'restore waiting' });
  });
});

describe('linked', () => {
  test('a restored account’s rows are read only while its directory entry exists', async () => {
    await linked();
    expect(rowsOf(await activity()).map((r) => r[0])).toContain('split:p1');
    await fake.hdel(ctxKey('accounts:directory'), 'acc_chk');
    const shown = rowsOf(await activity()).map((r) => r[0]);
    expect(shown).not.toContain('split:p1');
    expect(shown).toContain('n_gas');
  });

  test('a file imported into the account it is linked to is matched against its restored rows, as the bank’s own', async () => {
    await linked();
    const ofx = [
      '<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF>',
      '<BANKACCTFROM><BANKID>325081403</BANKID><ACCTID>0009991111</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20251101</DTSTART><DTEND>20251130</DTEND>',
      '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20251120120000[-5:EST]</DTPOSTED><TRNAMT>-61.20</TRNAMT><FITID>F_grocer</FITID><NAME>GROCER 9</NAME></STMTTRN>',
      '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20251105120000[-5:EST]</DTPOSTED><TRNAMT>-12.00</TRNAMT><FITID>F_older</FITID><NAME>OLDER SHOP</NAME></STMTTRN>',
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n');
    const upload = (meta: Record<string, unknown>) => {
      const form = new FormData();
      form.set('file', new Blob([new TextEncoder().encode(ofx) as Uint8Array<ArrayBuffer>]), 'statement.ofx');
      form.set('meta', JSON.stringify({ file_name: 'statement.ofx', account_id: 'new_chk', ...meta }));
      return historyImport.POST(new Request('http://localhost/api/history-import', { method: 'POST', body: form }));
    };
    // The grocery is there already, as the restored row: an earlier import's
    // row, so found as present, never offered as a likely duplicate.
    const preview = await (await upload({ action: 'preview' })).json();
    expect(preview.preview.counts).toMatchObject({ new: 1, present: 1, duplicates: 0 });
    expect(preview.preview.proposals).toEqual([]);
    const done = await upload({ action: 'import', review: preview.preview.review });
    expect(done.status).toBe(200);
    const entry = (await historyImportStore.get(ctx, (await done.json()).import_id))!;
    expect(entry.records.map((r) => [r.outcome, r.row_id === restoredId('t_old')])).toContainEqual(['present', true]);
    const shown = rowsOf(await activity());
    // The old grocery once (its split), the older shop beside it.
    expect(shown.filter((r) => r[1] === '2025-11-20').map((r) => r[0])).toEqual(['split:p1', 'split:p2']);
    expect(shown.filter((r) => r[1] === '2025-11-05').length).toBe(1);
  });
});

describe('a category’s uses', () => {
  test('count the restored rows by their words, as the bank’s', async () => {
    const taxonomy = (await taxonomyStore.get(ctx))!;
    const food = taxonomy.categories.find((c) => c.provider_keys.some((k) => k.key === 'FOOD_AND_DRINK'))!;
    const withRows = (await categoryUsages(ctx, taxonomy, [food.id])).get(food.id)!.transactions;
    for (const id of (await restoredTxnStore.getAll(ctx)).keys()) await restoredTxnStore.remove(ctx, id);
    const without = (await categoryUsages(ctx, taxonomy, [food.id])).get(food.id)!.transactions;
    // The gas, the card's books and the old grocery: the coffee is counted
    // by its approval either way.
    expect(withRows - without).toBe(3);
    expect(await userRestoreStore.get(ctx)).not.toBeNull();
  });
});
