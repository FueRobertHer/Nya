import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// A row imported into a linked account from its bank's file (#52) and the
// bank row that came to stand for it, once the bank changes that row (Plaid
// keeps a transaction's id when it modifies it): the pair holds while the
// bank's row is there, whatever its amount becomes, so the one transaction
// counts once, never as the bank's row and the imported row beside it
// (lib/history-import/match.ts KEPT ONCE MADE). The sync keeps the pair
// before it saves the changed rows (lib/history-import/twins.ts), a read
// never writes it, the bank removing its row puts the imported row back as
// today, and no pair is made on anything looser than the rule. Splits carried
// from the imported row show what the bank changed as a split always shows
// it, and the download counts as the app does.

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
const { readSpending } = await import('@/lib/api-read');
const { importedTwinsStore, importedTxnStore } = await import('@/lib/history-import/store');
const { settle } = await import('@/lib/history-import/match');
const { nextTwins } = await import('@/lib/history-import/twins');
const { collectUserData, buildUserExport, exportFile, importedTransactionsIn, TRANSACTION_COLUMNS } = await import('@/lib/user-export');
const { importedChangedNote } = await import('@/lib/history-import/view');
const routes = await import('@/app/api/history-import/route');
const splitsRoute = await import('@/app/api/transaction-splits/route');
const transactionsRoute = await import('@/app/api/transactions/route');

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

/** Chase's rows begin on day 60, so the file's day 40 is inside them. */
const FIRST = bankTxn('b_first', 60, 10, { name: 'FIRST ROW', merchant_name: null });
/** The Costco run the bank sends, at the amount the file has, a day later. */
const COSTCO = (amount: number) => bankTxn('b_costco', 39, amount);

async function storeBank(rows: ReturnType<typeof bankTxn>[]) {
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob({
      schema_version: 2,
      cursor: 'c1',
      accounts: { acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null } },
      txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])),
      synced_at: new Date().toISOString(),
    })
  );
}

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  plaid.added = [];
  plaid.modified = [];
  plaid.removed = [];
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-chase') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await encrypt(
      JSON.stringify([{ account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }])
    ),
  });
  await storeBank([FIRST]);
});

/** A checking statement from the bank's site: its Costco run of 150 on day
 *  40, covering days 60 to 35. */
const STATEMENT = `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>1</BANKID><ACCTID>0001111</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>${compact(daysAgo(60))}</DTSTART><DTEND>${compact(daysAgo(35))}</DTEND><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${compact(daysAgo(40))}</DTPOSTED><TRNAMT>-150.00</TRNAMT><FITID>F_costco</FITID><NAME>COSTCO WHSE #123</NAME></STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

function upload(meta: Record<string, unknown>, file: string): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(file) as Uint8Array<ArrayBuffer>]), 'statement.ofx');
  form.set('meta', JSON.stringify({ file_name: 'statement.ofx', ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
}
/** Reviews the statement and imports it as reviewed: the imported row's id. */
async function importStatement(): Promise<string> {
  const preview = (await (await routes.POST(upload({ action: 'preview', account_id: 'acc_chk' }, STATEMENT))).json()).preview;
  const res = await routes.POST(upload({ action: 'import', account_id: 'acc_chk', review: preview.review }, STATEMENT));
  expect(res.status).toBe(200);
  return (await importedTxnStore.get(ctx, 'acc_chk'))!.rows[0].id;
}
/** A sync: what `plaid` holds next, saved. */
const sync = () => assembleBankRows(ctx, { sync: true });
/** The Activity tab's rows, as every reader assembles them. */
async function rows() {
  const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, withAccountIds: true });
  return (await finishActivity(ctx, bank.payload, bank.hidden)).transactions;
}
/** What went out over the days the rows are on: one total, the read-only API's. */
const moneyOut = async () => (await readSpending(ctx, { from: daysAgo(70), to: daysAgo(0) })).money_out;

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = saved;
  }
}

describe('the matching rule alone', () => {
  // The probe the double count was found by: worked out again from the
  // amounts, a changed bank row lets the imported row count beside it.
  const held = [{ id: 'imported-txn:1', import_id: 'imp1', date: '2026-09-10', amount: 150, currency: 'USD', name: 'COSTCO WHSE #123' }];
  const bank = (amount: number) => [{ transaction_id: 'B', account_id: 'acct', date: '2026-09-11', amount, currency: 'USD', name: 'COSTCO WHSE #123', merchant_name: 'Costco', pending: false }];
  const opts = { bankFrom: '2026-01-01', covers: new Map([['imp1', { from: '2026-09-01', to: '2026-09-30' }]]), pending: true };

  test('pairs only equal amounts; a pair kept once made holds whatever the bank row says now, and only while it is there', () => {
    expect(settle(held, bank(150), ['imp1'], opts).superseded.has('imported-txn:1')).toBe(true);
    // Without the pair kept: counted beside the bank's, the double count.
    expect(settle(held, bank(160.5), ['imp1'], opts).counted.map((r) => r.id)).toEqual(['imported-txn:1']);
    // Kept: the bank's row still stands for it.
    const kept = new Map([['imported-txn:1', 'B']]);
    const s = settle(held, bank(160.5), ['imp1'], { ...opts, twins: kept });
    expect([s.counted.length, s.superseded.get('imported-txn:1')?.amount]).toEqual([0, 160.5]);
    // The bank's row gone: the imported row counts again.
    expect(settle(held, [], ['imp1'], { ...opts, twins: kept }).counted.map((r) => r.id)).toEqual(['imported-txn:1']);
    // A kept pair never takes a pending row, nor a row on another id.
    expect(settle(held, [{ ...bank(160.5)[0], pending: true }], ['imp1'], { ...opts, twins: kept }).counted.length).toBe(1);
    expect(settle(held, [{ ...bank(160.5)[0], transaction_id: 'C' }], ['imp1'], { ...opts, twins: kept }).counted.length).toBe(1);
  });

  test('a duplicate marked at import stands for the bank row it was kept with, as a duplicate, whatever its amount becomes', () => {
    const dup = [{ ...held[0], same_as: '2026-09-11|150000|costco whse 123' }];
    expect(settle(dup, bank(150), ['imp1'], opts).standing.has('imported-txn:1')).toBe(true);
    expect(settle(dup, bank(160.5), ['imp1'], opts).counted.length).toBe(1);
    const s = settle(dup, bank(160.5), ['imp1'], { ...opts, twins: new Map([['imported-txn:1', 'B']]) });
    expect([s.counted.length, s.standing.get('imported-txn:1')]).toEqual([0, { bank: bank(160.5)[0] }]);
  });

  test('what is kept: pairs the rule made, less those whose bank row is gone or whose imported row no book holds; one bank row, one imported row', () => {
    const after = { B: {}, C: {} };
    expect(nextTwins(null, new Map([['imported-txn:1', 'B']]), after, new Set(['imported-txn:1']))).toEqual({ version: 1, twins: { 'imported-txn:1': 'B' } });
    // The bank removed B: nothing kept.
    expect(nextTwins({ version: 1, twins: { 'imported-txn:1': 'B' } }, new Map(), { C: {} }, null)).toBeNull();
    // Its import undone, every book read: dropped; a book unread: kept.
    expect(nextTwins({ version: 1, twins: { 'imported-txn:1': 'B' } }, new Map(), after, new Set())).toBeNull();
    expect(nextTwins({ version: 1, twins: { 'imported-txn:1': 'B' } }, new Map(), after, null)).toEqual({ version: 1, twins: { 'imported-txn:1': 'B' } });
    // A pair the rule makes now of a bank row kept with another row: the rule's.
    expect(nextTwins({ version: 1, twins: { 'imported-txn:1': 'B' } }, new Map([['imported-txn:2', 'B']]), after, null)).toEqual({ version: 1, twins: { 'imported-txn:2': 'B' } });
  });
});

describe('through the read layer, and a total', () => {
  test('a bank row that came to stand for an imported row keeps standing for it once the bank changes its amount: the transaction counts once', async () => {
    const id = await importStatement();
    expect(await moneyOut()).toBe(10 + 150);
    // The bank sends the same Costco run: its row stands for the imported one.
    plaid.added.push(COSTCO(150));
    await sync();
    expect((await rows()).map((t) => t.transaction_id).sort()).toEqual(['b_costco', 'b_first']);
    expect(await moneyOut()).toBe(10 + 150);
    // A read wrote nothing: the pair is kept by the next sync, before it
    // changes the rows.
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toBeNull();

    // The bank modifies its row (the same id): a tip, a currency settled.
    plaid.modified.push(COSTCO(160.5));
    await sync();
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toEqual({ version: 1, twins: { [id]: 'b_costco' } });
    const shown = await rows();
    expect(shown.map((t) => t.transaction_id).sort()).toEqual(['b_costco', 'b_first']);
    expect(await moneyOut()).toBe(10 + 160.5);
    // The Activity tab says what happened, beside the bank's row.
    const costco = shown.find((t) => t.transaction_id === 'b_costco')!;
    expect(costco.imported_amount).toBe(150);
    expect(importedChangedNote(costco, (n) => `$${n.toFixed(2)}`)).toBe(
      'This is the transaction you imported from your bank’s file at $150.00. The bank has changed its amount since, so it counts once, at the bank’s amount.'
    );
    // And the route the Activity tab loads sends it.
    const sent = (await (await transactionsRoute.GET(new Request('http://localhost/api/transactions'))).json()).transactions;
    expect(sent.find((t: { transaction_id: string }) => t.transaction_id === 'b_costco').imported_amount).toBe(150);

    // Changed again, and again: still the one transaction.
    plaid.modified.push(COSTCO(158.25));
    await sync();
    expect(await moneyOut()).toBe(10 + 158.25);

    // The bank removes its row: the imported row counts again, as today, and
    // the pair goes with the bank's row.
    plaid.removed.push('b_costco');
    await sync();
    expect((await rows()).map((t) => t.transaction_id).sort()).toEqual(['b_first', id].sort());
    expect(await moneyOut()).toBe(10 + 150);
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toBeNull();
  });

  test('a duplicate answered as the bank’s own in the review stays one once the bank changes its amount', async () => {
    await storeBank([FIRST, COSTCO(150)]);
    const id = await importStatement();
    expect((await importedTxnStore.get(ctx, 'acc_chk'))!.rows[0].same_as).toBeDefined();
    expect(await moneyOut()).toBe(10 + 150);
    plaid.modified.push(COSTCO(160.5));
    await sync();
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toEqual({ version: 1, twins: { [id]: 'b_costco' } });
    expect((await rows()).map((t) => t.transaction_id).sort()).toEqual(['b_costco', 'b_first']);
    expect(await moneyOut()).toBe(10 + 160.5);
  });

  test('another file of the same period, after the bank changed its row, finds the transaction already there, as before the change', async () => {
    const id = await importStatement();
    plaid.added.push(COSTCO(150));
    await sync();
    plaid.modified.push(COSTCO(160.5));
    await sync();
    // The bank's CSV export of the same days: no FITID, its own words.
    const csv = ['Date,Description,Amount', `${daysAgo(40)},COSTCO WHSE 123 SEATTLE WA,-150.00`].join('\n');
    const form = (meta: Record<string, unknown>) => {
      const f = new FormData();
      f.set('file', new Blob([new TextEncoder().encode(csv) as Uint8Array<ArrayBuffer>]), 'export.csv');
      f.set('meta', JSON.stringify({ file_name: 'export.csv', options: { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } }, account_id: 'acc_chk', ...meta }));
      return new Request('http://localhost/api/history-import', { method: 'POST', body: form === undefined ? undefined : f });
    };
    const preview = (await (await routes.POST(form({ action: 'preview' }))).json()).preview;
    expect(preview.proposals.map((p: { twin: { id: string; amount: number }; choice: string }) => [p.twin.id, p.twin.amount, p.choice])).toEqual([[id, 150, 'same']]);
    expect((await routes.POST(form({ action: 'import', review: preview.review }))).status).toBe(200);
    expect((await rows()).map((t) => t.transaction_id).sort()).toEqual(['b_costco', 'b_first']);
    expect(await moneyOut()).toBe(10 + 160.5);
  });

  test('never a pair looser than the rule: a bank row at another amount pairs with nothing, and one kept pairs with nothing else', async () => {
    const id = await importStatement();
    // A Costco run at another amount the same day: another transaction.
    plaid.added.push(COSTCO(160.5));
    await sync();
    await sync();
    expect((await rows()).map((t) => t.transaction_id).sort()).toEqual(['b_costco', 'b_first', id].sort());
    expect(await moneyOut()).toBe(10 + 160.5 + 150);
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toBeNull();
  });

  test('pairs that can’t be read keep the account’s imported rows out, said, rather than count them beside the bank’s; a sync goes on', async () => {
    await importStatement();
    plaid.added.push(COSTCO(150));
    await sync();
    plaid.modified.push(COSTCO(160.5));
    await sync();
    await fake.hset(ctxKey('imported-twins'), { item_chase: 'not ciphertext' });
    const bank = await assembleBankRows(ctx, { sync: false, readOnly: true, withAccountIds: true });
    const shown = await finishActivity(ctx, bank.payload, bank.hidden);
    expect(shown.transactions.map((t) => t.transaction_id).sort()).toEqual(['b_costco', 'b_first']);
    expect(shown.notes).toContain("Chase: transactions imported for Checking aren't shown while which of the bank's own stand for them can't be read");
    // The next sync neither fails nor writes over what it can't read.
    plaid.modified.push(COSTCO(161));
    await quietly(() => sync());
    expect(await fake.hget<string>(ctxKey('imported-twins'), 'item_chase')).toBe('not ciphertext');
  });
});

describe('a split carried from the imported row', () => {
  const put = async (transaction_id: string, parts: { amount: number; category_id: string }[], updated_at: string | null = null) => {
    const res = await splitsRoute.PUT(new Request('http://x/api/transaction-splits', { method: 'PUT', body: JSON.stringify({ transaction_id, parts, updated_at }) }));
    return { status: res.status, body: await res.json() };
  };

  test('shows what the bank changed as the remainder, flagged, never skewing a total; an edit adds up to the bank’s amount now', async () => {
    const id = await importStatement();
    const t = (await (await transactionsRoute.GET(new Request('http://localhost/api/transactions?refresh=1'))).json()).categories;
    const food = t.categories.find((c: { name: string }) => c.name.toLowerCase() === 'food and drink').id;
    const home = t.categories.find((c: { id: string; kind?: string }) => c.id !== food).id;
    // Split as imported: 100 of groceries, 50 for the house.
    expect((await put(id, [{ amount: 100, category_id: food }, { amount: 50, category_id: home }])).status).toBe(200);
    plaid.added.push(COSTCO(150));
    await sync();
    plaid.modified.push(COSTCO(160.5));
    await sync();
    const parts = (await rows()).filter((r) => r.split_of === 'b_costco');
    expect(parts.map((p) => [p.amount, p.split_remainder ?? null, p.split_carried_from])).toEqual([
      [100, null, id],
      [50, null, id],
      [10.5, { was: 150 }, id],
    ]);
    expect(await moneyOut()).toBe(10 + 160.5);
    // An edit, made on the imported row where the split is kept, places what
    // the bank changed: its parts add up to the bank's amount now.
    const split = (await import('@/lib/splits')).splitStore;
    const seen = (await split.get(ctx, id))!.updated_at;
    expect((await put(id, [{ amount: 100, category_id: food }, { amount: 50, category_id: home }], seen)).status).toBe(400);
    expect((await put(id, [{ amount: 110.5, category_id: food }, { amount: 50, category_id: home }], seen)).status).toBe(200);
    const again = (await rows()).filter((r) => r.split_of === 'b_costco');
    expect(again.map((p) => [p.amount, p.split_remainder ?? null])).toEqual([
      [110.5, null],
      [50, null],
    ]);
    expect(await moneyOut()).toBe(10 + 160.5);
  });
});

describe('the download', () => {
  test('counts by the pair kept, as the app does: the bank’s row once, the imported one in the JSON file only', async () => {
    const id = await importStatement();
    plaid.added.push(COSTCO(150));
    await sync();
    plaid.modified.push(COSTCO(160.5));
    await sync();
    const doc = buildUserExport(await collectUserData({ ctx, userId: null }), new Date());
    expect(doc['imported-twins']).toEqual([{ id: 'item_chase', value: { version: 1, twins: { [id]: 'b_costco' } } }]);
    const imported = importedTransactionsIn(doc);
    expect(imported.rows).toEqual([]);
    expect(imported.stands.get(id)).toBe('b_costco');
    const [, ...csvRows] = parseCsv([...exportFile(doc, 'transactions-csv').pieces()].join(''));
    expect(csvRows.map((r) => [r[TRANSACTION_COLUMNS.indexOf('transaction_id')], r[TRANSACTION_COLUMNS.indexOf('amount')]]).sort()).toEqual([
      ['b_costco', '160.5'],
      ['b_first', '10'],
    ]);
  });
});
