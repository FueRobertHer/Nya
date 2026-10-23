import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { seedOld } from './restore-fixture';

// A file imported into an account before the account a restore brought back
// is linked to it (lib/user-restore/restored.ts, PAIRED ON READ): its review
// had no restored rows to match against, so the first stage pairs it with
// them once they are linked, by the link's own time; and an import whose
// review did match against them (`matched_restored`, kept on the import) is
// never paired again, however often the two are unlinked and linked. Every
// reader, to the cent, after a real restore through the routes
// (test/restore-run.ts).

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
const { linkAccounts, unlinkAccount } = await import('@/lib/links');
const { taxonomyStore } = await import('@/lib/category-store');
const { rulesStore } = await import('@/lib/rules');
const { historyImportStore, historyImportSummaryStore } = await import('@/lib/history-import/store');
const { importedForShare } = await import('@/lib/history-import/read');
const { queryTransactions, readSpending, readBudgets } = await import('@/lib/api-read');
const { readCashFlow } = await import('@/lib/api-cash-flow');
const { readReport } = await import('@/lib/report/read');
const { resolvePeriod } = await import('@/lib/report/period');
const { joinedAt, pairable } = await import('@/lib/user-restore/restored');
const routes = await import('@/app/api/history-import/route');
const { EXPORTED, downloadText, restoreAll, activity, rowsOf, connectAgain } = await import('./restore-run');

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
  await connectAgain(fake);
  // The statement's rows are filed as the grocery is (food), by a rule, so
  // the budget on food counts them as every other reader does.
  const food = (await foodId())!;
  const rules = (await rulesStore.get(ctx))!;
  const at = new Date().toISOString();
  await rulesStore.set(ctx, {
    ...rules,
    rules: [...rules.rules, { id: 'rule2', enabled: true, priority: 2, conditions: [{ field: 'name', op: 'contains', value: 'grocer' }], actions: { set_category: food }, created_at: at, updated_at: at }],
  });
});

async function foodId(): Promise<string | undefined> {
  const taxonomy = (await taxonomyStore.get(ctx))!;
  return taxonomy.categories.find((c) => c.provider_keys.some((k) => k.key === 'FOOD_AND_DRINK'))?.id;
}

// A 2025 statement for the checking account. The grocer's row is the one the
// restore brought back (2025-11-20, 61.20, which the old copy split 40 and
// 21.20), dated before the new connection's window.
const statement = (row: string) =>
  `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>325081403</BANKID><ACCTID>0009991111</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20251101</DTSTART><DTEND>20251215</DTEND>
${row}
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
const GROCER = '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20251120120000[-5:EST]</DTPOSTED><TRNAMT>-61.20</TRNAMT><FITID>F_grocer</FITID><NAME>GROCER 9</NAME></STMTTRN>';
// The same amount two days later, under another name: a likely duplicate the
// person is asked about, not one found already there.
const LOOKALIKE = '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20251122120000[-5:EST]</DTPOSTED><TRNAMT>-61.20</TRNAMT><FITID>F_lookalike</FITID><NAME>RAINBOW GROCERY</NAME></STMTTRN>';

async function importInto(account_id: string, row: string, choices?: Record<string, unknown>) {
  const post = async (meta: Record<string, unknown>) => {
    const form = new FormData();
    form.set('file', new Blob([new TextEncoder().encode(statement(row)) as Uint8Array<ArrayBuffer>]), 'statement.ofx');
    form.set('meta', JSON.stringify({ file_name: 'statement.ofx', account_id, ...meta }));
    const res = await routes.POST(new Request('http://localhost/api/history-import', { method: 'POST', body: form }));
    return { status: res.status, body: await res.json() };
  };
  const preview = await post({ action: 'preview', ...(choices ? { choices } : {}) });
  expect(preview.status).toBe(200);
  const done = await post({ action: 'import', review: preview.body.preview.review, ...(choices ? { choices } : {}) });
  expect(done.status).toBe(200);
  return { counts: preview.body.preview.counts, proposals: preview.body.preview.proposals, import_id: done.body.import_id as string | null };
}

const NOV = { from: '2025-11-01', to: '2025-11-30' };
const cents = (n: number) => Math.round(n * 100) / 100;

/** November 2025's money out of the checking account's bank, as every reader
 *  counts it: Activity, the API's transactions, spending, cash flow and
 *  budgets, a report, and what a share of the account shows. */
async function november() {
  const shown = rowsOf(await activity()).filter((r) => r[1] >= NOV.from && r[1] <= NOV.to);
  const page = await queryTransactions(ctx, { ...NOV, limit: 100 });
  const spending = await readSpending(ctx, NOV);
  const flow = await readCashFlow(ctx, NOV);
  const food = (await foodId())!;
  const budgets = await readBudgets(ctx, { month: '2025-11' });
  const period = resolvePeriod({ kind: 'range', start: NOV.from, end: NOV.to }, 'UTC', Date.now());
  if ('error' in period) throw new Error(period.error);
  const report = await readReport(ctx, period);
  const shared = await importedForShare(ctx, new Set(['new_chk']), NOV.from);
  return {
    activity: cents(shown.reduce((s, r) => s + Number(r[2]), 0)),
    api: cents(page.transactions.reduce((s, t) => s + t.amount, 0)),
    spending: cents(spending.money_out),
    cash_flow: cents(flow.money_out),
    budget: cents(budgets.budgets.find((b) => b.category_id === food)!.spent),
    report: cents(report.totals.money_out),
    share: cents([...(shared.rows.get('new_chk') ?? [])].filter((r) => r.date >= NOV.from && r.date <= NOV.to).reduce((s, r) => s + r.amount, 0)),
  };
}
const every = (n: number) => ({ activity: n, api: n, spending: n, cash_flow: n, budget: n, report: n, share: n });
/** Minutes from now, so a link is never made in the same millisecond as the
 *  import it follows. */
const later = (minutes: number) => Date.now() + minutes * 60_000;

describe('a file imported before the restored account is linked', () => {
  test('is paired with the restored rows once they are linked: every reader counts the grocery once, to the cent', async () => {
    const before = await importInto('new_chk', GROCER);
    // Its review had no restored rows: the grocery was new to it.
    expect(before.counts).toMatchObject({ new: 1, present: 0 });
    // Nothing restored is counted yet: the file's row alone.
    expect(await november()).toEqual(every(61.2));

    await linkAccounts(ctx, 'acc_chk', 'new_chk', {}, later(1));
    // The restored grocery, as its split (40 and 21.20), and not the file's
    // row beside it: 61.20, never 122.40.
    expect(rowsOf(await activity()).filter((r) => r[1] === '2025-11-20').map((r) => [r[0], r[2]])).toEqual([
      ['split:p1', 40],
      ['split:p2', 21.2],
    ]);
    expect(await november()).toEqual(every(61.2));
  });

  test('the same statement imported after the link is found there already, and reads the same', async () => {
    await linkAccounts(ctx, 'acc_chk', 'new_chk', {}, later(-1));
    const after = await importInto('new_chk', GROCER);
    expect(after.counts).toMatchObject({ new: 0, present: 1 });
    expect(await november()).toEqual(every(61.2));
  });
});

describe('an import whose review read the restored rows', () => {
  test('keeps which restored accounts it was matched against, on its entry and its summary', async () => {
    await linkAccounts(ctx, 'acc_chk', 'new_chk', {}, later(-1));
    const { import_id } = await importInto('new_chk', LOOKALIKE, { proposals: { all: 'new' } });
    expect((await historyImportStore.get(ctx, import_id!))!.matched_restored).toEqual(['acc_chk']);
    expect((await historyImportSummaryStore.get(ctx, import_id!))!.matched_restored).toEqual(['acc_chk']);
  });

  test('one that read none keeps nothing of it', async () => {
    const { import_id } = await importInto('new_chk', GROCER);
    expect((await historyImportStore.get(ctx, import_id!))!.matched_restored).toBeUndefined();
    expect((await historyImportSummaryStore.get(ctx, import_id!))!.matched_restored).toBeUndefined();
  });

  test('is never paired again after an unlink and a relink: a row the person said was new stays counted', async () => {
    await linkAccounts(ctx, 'acc_chk', 'new_chk', {}, later(-1));
    const said = await importInto('new_chk', LOOKALIKE, { proposals: { all: 'new' } });
    // Asked about beside the restored grocery, and said to be another one.
    expect(said.proposals).toHaveLength(1);
    expect(said.counts).toMatchObject({ new: 1 });
    // Both count, by the person's word.
    expect(await november()).toEqual(every(122.4));

    await unlinkAccount(ctx, 'acc_chk');
    // Held again: the file's row alone.
    expect(await november()).toEqual(every(61.2));

    await linkAccounts(ctx, 'acc_chk', 'new_chk', {}, later(5));
    // Linked again later than the import was made: still both, as the person
    // said, never re-paired by the amount rule.
    expect(await november()).toEqual(every(122.4));
  });
});

describe('the rule (pure)', () => {
  const link = (to: string, linked_at: string) => ({ to, linked_at, evidence: {} });
  const RESTORED = '2026-10-07T09:00:00.000Z';

  test('an id has the restored account’s rows from the later of the restore and every link on the way to it', () => {
    const links = new Map([
      ['acc_old', link('acc_chk', '2025-06-02T00:00:00.000Z')],
      ['acc_chk', link('new_chk', '2026-10-10T00:00:00.000Z')],
      ['new_chk', link('new_chk2', '2026-11-01T00:00:00.000Z')],
    ]);
    expect(joinedAt('acc_chk', RESTORED, links)).toEqual(
      new Map([
        ['acc_chk', RESTORED],
        ['new_chk', '2026-10-10T00:00:00.000Z'],
        ['new_chk2', '2026-11-01T00:00:00.000Z'],
      ])
    );
    // A link the old copy made is older than the restore: the restore's time.
    expect(joinedAt('acc_old', RESTORED, links).get('acc_chk')).toBe(RESTORED);
  });

  test('a row is paired only where its import neither read them nor came after they joined its account', () => {
    const joined = new Map([['acc_chk', new Map([['acc_chk', RESTORED], ['new_chk', '2026-10-10T00:00:00.000Z'], ['new_chk2', '2026-11-01T00:00:00.000Z']])]]);
    const importedAt = new Map([
      ['old', '2025-12-01T00:00:00.000Z'],
      ['before', '2026-10-08T00:00:00.000Z'],
      ['during', '2026-10-20T00:00:00.000Z'],
      ['said', '2026-10-09T00:00:00.000Z'],
    ]);
    const matched = new Map([['said', new Set(['acc_chk'])]]);
    const at = { importedAt, matched };
    const row = (import_id: string, account_id: string) => ({ import_id, account_id });
    // The old copy's imports, wherever they are filed.
    expect(pairable(row('old', 'acc_chk'), 'acc_chk', joined, at)).toBe(true);
    expect(pairable(row('old', 'acc_old'), 'acc_chk', joined, at)).toBe(true);
    // Into the new account before the link: paired.
    expect(pairable(row('before', 'new_chk'), 'acc_chk', joined, at)).toBe(true);
    // Into it while linked: its review read them.
    expect(pairable(row('during', 'new_chk'), 'acc_chk', joined, at)).toBe(false);
    // Into the account it was linked on to, before that link: paired.
    expect(pairable(row('during', 'new_chk2'), 'acc_chk', joined, at)).toBe(true);
    // Into an id never on the way: its review never had them.
    expect(pairable(row('during', 'manual_elsewhere'), 'acc_chk', joined, at)).toBe(true);
    // An import that says it read them, whenever it was made: never.
    expect(pairable(row('said', 'new_chk'), 'acc_chk', joined, at)).toBe(false);
    expect(pairable(row('said', 'new_chk2'), 'acc_chk', joined, at)).toBe(false);
    // An import whose time can't be read: never, as before.
    expect(pairable(row('unknown', 'new_chk'), 'acc_chk', joined, at)).toBe(false);
  });
});
