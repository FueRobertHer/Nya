import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The review queue meets the rows imported into a linked account from the
// bank's files (#52) and the bank rows that come to stand for them, through
// the sync and the matching as they run (lib/history-import/twins.ts): the
// bank's row takes the imported row's approval; once the bank changes its
// amount the pair is kept, so the approval no longer holds and the
// transaction waits for review again, saying why; the change is said once,
// whether the row's own note (`imported_amount`) says it or not; approved
// again it holds; and the bank removing its row puts the imported one back,
// approved as it was.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.MAX_TXN_BLOB_CHARS;

/** What the next sync brings: rows added, modified and removed. */
const plaid = { added: [] as unknown[], modified: [] as unknown[], removed: [] as string[] };
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    transactionsSync: async () => ({
      data: {
        added: plaid.added.splice(0),
        modified: plaid.modified.splice(0),
        removed: plaid.removed.splice(0).map((transaction_id) => ({ transaction_id })),
        accounts: [],
        next_cursor: 'c-next',
        has_more: false,
        transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
      },
    }),
  },
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { assembleBankRows, finishActivity } = await import('@/lib/activity');
const { queryTransactions } = await import('@/lib/api-read');
const { importedTwinsStore, importedTxnStore } = await import('@/lib/history-import/store');
const { importedChangedNote } = await import('@/lib/history-import/view');
const { approvalStore } = await import('@/lib/review-store');
const { approvalInputOf } = await import('@/lib/review-layer');
const { bankRows } = await import('@/lib/split-rows');
const { formatMoney } = await import('@/lib/format');
const { approvedAsImported, changedSinceWords } = await import('@/components/review-text');
const historyImport = await import('@/app/api/history-import/route');
const reviewRoute = await import('@/app/api/review/route');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const compact = (d: string) => d.replace(/-/g, '');

function bankTxn(id: string, days: number, amount: number, over: Record<string, unknown> = {}) {
  return {
    transaction_id: id,
    pending_transaction_id: null,
    account_id: 'acc_chk',
    amount,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date: daysAgo(days),
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,
    name: 'COSTCO WHSE #123',
    merchant_name: 'Costco',
    merchant_entity_id: null,
    website: null,
    logo_url: null,
    personal_finance_category: null,
    personal_finance_category_icon_url: null,
    pending: false,
    payment_channel: 'in store',
    transaction_code: null,
    transaction_type: null,
    check_number: null,
    account_owner: null,
    location: null,
    payment_meta: null,
    counterparties: [],
    category: 'general merchandise',
    account_name: 'Checking',
    institution_name: 'Chase',
    ...over,
  };
}

/** Chase's rows begin on day 30, before the queue's first day (day 20). */
const FIRST = bankTxn('b_first', 30, 10, { name: 'FIRST ROW', merchant_name: null });
/** The Costco run the bank sends, a day after the file has it. */
const COSTCO = (amount: number) => bankTxn('b_costco', 9, amount);

/** A checking statement from the bank's site: its Costco run of 150 on day
 *  10, covering days 30 to 5. */
const STATEMENT = `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>1</BANKID><ACCTID>0001111</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>${compact(daysAgo(30))}</DTSTART><DTEND>${compact(daysAgo(5))}</DTEND><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${compact(daysAgo(10))}</DTPOSTED><TRNAMT>-150.00</TRNAMT><FITID>F_costco</FITID><NAME>COSTCO WHSE #123</NAME></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  plaid.added = [];
  plaid.modified = [];
  plaid.removed = [];
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'access-sandbox-chase') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await encrypt(ctx, 
      JSON.stringify([{ account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }])
    ),
  });
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob(ctx, {
      schema_version: 2,
      cursor: 'c1',
      accounts: { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } },
      txns: { [FIRST.transaction_id]: FIRST },
      synced_at: new Date().toISOString(),
    })
  );
});

function upload(meta: Record<string, unknown>): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(STATEMENT) as Uint8Array<ArrayBuffer>]), 'statement.ofx');
  form.set('meta', JSON.stringify({ file_name: 'statement.ofx', ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
}
/** Reviews the statement and imports it as reviewed: the imported row's id. */
async function importStatement(): Promise<string> {
  const preview = (await (await historyImport.POST(upload({ action: 'preview', account_id: 'acc_chk' }))).json()).preview;
  expect((await historyImport.POST(upload({ action: 'import', account_id: 'acc_chk', review: preview.review }))).status).toBe(200);
  return (await importedTxnStore.get(ctx, 'acc_chk'))!.rows[0].id;
}
/** A sync: what `plaid` holds next, saved. */
const sync = () => assembleBankRows(ctx, { sync: true });
/** Each transaction as the Activity tab has it whole, by id. */
async function rows() {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, withAccountIds: true });
  const { transactions } = await finishActivity(ctx, bank.payload, bank.hidden);
  return new Map(bankRows(transactions).map((t) => [t.transaction_id, t]));
}
const review = async (body: unknown) => {
  const res = await reviewRoute.POST(new Request('http://localhost/api/review', { method: 'POST', body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
/** Approves these transactions as the Activity tab shows them. */
async function approveShown(ids: string[]) {
  const shown = await rows();
  return review({ action: 'approve', items: ids.map((id) => approvalInputOf(shown.get(id)!)) });
}
const money = (t: { iso_currency_code: string | null }) => (n: number) => formatMoney(n, t.iso_currency_code);

describe('the review queue and a bank row standing for an imported one', () => {
  test('the bank row takes the imported row’s approval; changed by the bank, it waits for review again, saying so once; approved again it holds; removed, the imported row is approved as it was', async () => {
    expect((await review({ action: 'start', today: daysAgo(0), since: daysAgo(20) })).status).toBe(200);
    const id = await importStatement();

    // The file's row is new to review; the bank's first row is before the queue.
    let shown = await rows();
    expect(shown.get(id)).toMatchObject({ needs_review: true, amount: 150 });
    expect(shown.get('b_first')!.needs_review).toBeUndefined();
    const approved = await approveShown([id]);
    expect(approved.status).toBe(200);

    // The bank sends the same run: its row stands for the imported one, and
    // takes its approval, the same transaction.
    plaid.added.push(COSTCO(150));
    await sync();
    shown = await rows();
    expect(shown.has(id)).toBe(false);
    // (`stands_for` is read by the layers and never sent: `review_via` says
    // whose approval it holds.)
    const paired = shown.get('b_costco')!;
    expect(paired).toMatchObject({ reviewed_at: approved.body.approved_at, review_via: id });
    expect(paired.needs_review).toBeUndefined();

    // The bank modifies its row: the pair is kept (the sync keeps it before
    // it saves the change), so the row still stands for the imported one,
    // whose approval, of 150, no longer holds.
    plaid.modified.push(COSTCO(160.5));
    await sync();
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toEqual({ version: 1, twins: { [id]: 'b_costco' } });
    shown = await rows();
    const changed = shown.get('b_costco')!;
    expect(changed).toMatchObject({ amount: 160.5, imported_amount: 150, needs_review: true, review_changed: { amount: 150, currency: 'USD' } });
    expect(changed.reviewed_at).toBeUndefined();
    // Said once: the row's note says the bank changed the file's amount; the
    // detail adds only that it was approved at it; Card Mode says both at once.
    expect(approvedAsImported(changed.review_changed!, changed)).toBe(true);
    expect(importedChangedNote(changed, money(changed))).toBe(
      'This is the transaction you imported from your bank’s file at $150.00. The bank has changed its amount since, so it counts once, at the bank’s amount.'
    );
    expect(changedSinceWords(changed.review_changed!, changed, true)).toBe('You approved it at the amount imported from your bank’s file, before the bank changed it.');
    expect(changedSinceWords(changed.review_changed!, changed, false)).toBe(
      'You approved it at $150.00 out, the amount imported from your bank’s file. The bank has changed its amount since, so it counts once, at the bank’s amount.'
    );
    // The read-only API says it waits.
    const api = (await queryTransactions(ctx, { from: daysAgo(40), to: daysAgo(0), limit: 50 } as never)).transactions;
    expect(api.find((t) => t.id === 'b_costco')).toMatchObject({ needs_review: true, reviewed_at: null });

    // Approved again, at the bank's amount: it holds, under the bank row's id.
    const again = await approveShown(['b_costco']);
    expect(again.status).toBe(200);
    shown = await rows();
    expect(shown.get('b_costco')).toMatchObject({ reviewed_at: again.body.approved_at, imported_amount: 150 });
    expect(shown.get('b_costco')!.review_changed).toBeUndefined();
    expect(shown.get('b_costco')!.review_via).toBeUndefined();

    // Changed again: two things now, each with its own figure.
    plaid.modified.push(COSTCO(158.25));
    await sync();
    const twice = (await rows()).get('b_costco')!;
    expect(twice).toMatchObject({ needs_review: true, review_changed: { amount: 160.5, currency: 'USD' }, imported_amount: 150 });
    expect(approvedAsImported(twice.review_changed!, twice)).toBe(false);
    expect(changedSinceWords(twice.review_changed!, twice, true)).toBe('The bank changed the amount since you approved it at $160.50 out.');
    expect(importedChangedNote(twice, money(twice))).toContain('at $150.00.');

    // The bank removes its row: the imported row counts again, approved as it
    // was, and the bank row's own approval goes with it.
    plaid.removed.push('b_costco');
    await sync();
    shown = await rows();
    expect(shown.has('b_costco')).toBe(false);
    expect(shown.get(id)).toMatchObject({ reviewed_at: approved.body.approved_at, amount: 150 });
    expect(shown.get(id)!.needs_review).toBeUndefined();
    expect(await approvalStore.get(ctx, 'b_costco')).toBeNull();
    expect(await approvalStore.get(ctx, id)).not.toBeNull();
  });

  test('a pending bank row shown in an approved imported row’s place takes nothing from it until it posts, as it takes no split or group; posted, it does', async () => {
    expect((await review({ action: 'start', today: daysAgo(0), since: daysAgo(20) })).status).toBe(200);
    const id = await importStatement();
    const approved = await approveShown([id]);
    expect(approved.status).toBe(200);

    plaid.added.push(bankTxn('p_costco', 9, 150, { pending: true }));
    await sync();
    let shown = await rows();
    const pending = shown.get('p_costco')!;
    // Shown in the imported row's place, it waits: its amount may still change.
    expect(shown.has(id)).toBe(false);
    expect(pending.needs_review).toBe(true);
    expect(pending.reviewed_at).toBeUndefined();

    // Posted: the bank's row stands for the imported one, approved as it was.
    plaid.removed.push('p_costco');
    plaid.added.push({ ...COSTCO(150), pending_transaction_id: 'p_costco' });
    await sync();
    shown = await rows();
    expect(shown.has('p_costco')).toBe(false);
    expect(shown.get('b_costco')).toMatchObject({ reviewed_at: approved.body.approved_at, review_via: id });
    expect(shown.get('b_costco')!.needs_review).toBeUndefined();
  });
});
