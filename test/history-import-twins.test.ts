import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';
import { parseCsv } from './csv-parse';

// A row imported into a linked account from its bank's file (#52) and the
// bank row that came to stand for it, once the bank changes that row (Plaid
// keeps a transaction's id when it modifies it): the pair holds while the
// bank's row is there, whatever its amount becomes, so the one transaction
// counts once, never as the bank's row and the imported row beside it
// (lib/history-import/match.ts KEPT ONCE MADE). The sync that changes the
// bank's row keeps the pair before it saves the change
// (lib/history-import/twins.ts), reading only its connection's accounts'
// books, and only then; a read never writes it, the bank removing its row
// puts the imported row back as today, and no pair is made on anything
// looser than the rule. A disconnect carries the pair by its bank row's
// content, and the re-added connection's sync makes it again once the
// accounts are linked. Splits carried from the imported row show what the
// bank changed as a split always shows it, and the download counts as the
// app does.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
delete process.env.MAX_TXN_BLOB_CHARS;

/** What the next sync brings: rows added, modified and removed. */
type Queue = { added: unknown[]; modified: unknown[]; removed: string[] };
const plaid: Queue = { added: [], modified: [], removed: [] };
/** What the next sync of another connection brings, by its access token:
 *  one not here brings what `plaid` holds. */
const others = new Map<string, Queue>();
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    itemRemove: async () => ({ data: {} }),
    transactionsSync: async (req: { access_token: string }) => {
      const q = others.get(req.access_token) ?? plaid;
      return {
        data: {
          added: q.added.splice(0),
          modified: q.modified.splice(0),
          removed: q.removed.splice(0).map((transaction_id) => ({ transaction_id })),
          accounts: [],
          next_cursor: 'c-next',
          has_more: false,
          transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
        },
      };
    },
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
const { carriedTwinsStore, importedTwinsStore, importedTxnStore } = await import('@/lib/history-import/store');
const { settle } = await import('@/lib/history-import/match');
const { carriedPairs, changedRows, nextTwins, withCarried } = await import('@/lib/history-import/twins');
const { forgetImportedHistory } = await import('@/lib/history-import/commit');
const { disconnectItem } = await import('@/lib/disconnect-item');
const { linkAccounts } = await import('@/lib/links');
const { getItems } = await import('@/lib/storage');
const { readItemTransactions } = await import('@/lib/transactions');
const { READ_ENTRIES } = await import('@/lib/repo');
const { bankRows } = await import('@/lib/split-rows');
const { entryNotice } = await import('@/components/SplitRows');
const { collectUserData, buildUserExport, exportFile, importedTransactionsIn, TRANSACTION_COLUMNS } = await import('@/lib/user-export');
const { importedChangedNote } = await import('@/lib/history-import/view');
const routes = await import('@/app/api/history-import/route');
const splitsRoute = await import('@/app/api/transaction-splits/route');
const transactionsRoute = await import('@/app/api/transactions/route');
const groupsRoute = await import('@/app/api/transaction-groups/route');
const { ofxFile } = await import('@/lib/ofx-export');

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

async function storeBank(rows: ReturnType<typeof bankTxn>[], item = 'item_chase', accounts = ['acc_chk']) {
  await fake.set(
    ctxKey(`txns:${item}`),
    await encodeJsonBlob(ctx, {
      schema_version: 2,
      cursor: 'c1',
      accounts: Object.fromEntries(accounts.map((a) => [a, { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null }])),
      txns: Object.fromEntries(rows.map((t) => [t.transaction_id, t])),
      synced_at: new Date().toISOString(),
    })
  );
}

/** Another connection, as the loads remember it, with its accounts. */
async function connect(item: string, institution: string, accounts: string[]) {
  await saveItem(ctx, { item_id: item, institution_name: institution, encrypted_access_token: await encrypt(ctx, `access-sandbox-${item}`) });
  await fake.hset(ctxKey('accounts:meta'), {
    [item]: await encrypt(ctx, 
      JSON.stringify(accounts.map((account_id) => ({ account_id, name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' })))
    ),
  });
}

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  plaid.added = [];
  plaid.modified = [];
  plaid.removed = [];
  others.clear();
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt(ctx, 'access-sandbox-chase') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await encrypt(ctx, 
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

/** A row imported into an account some other way, as its book keeps it. */
const heldRow = (account_id: string, import_id: string, days: number, amount: number) => ({
  id: `imported-txn:${crypto.randomUUID()}`,
  account_id,
  date: daysAgo(days),
  amount,
  currency: 'USD',
  name: 'OLD SHOP',
  category: null,
  note: null,
  source: 'import:csv',
  source_id: `k${days}`,
  import_id,
  created_at: new Date().toISOString(),
});

/** How the imported books were read while `fn` ran: how many times whole,
 *  and the ids asked for each time only some were. */
async function bookReads(fn: () => Promise<unknown>): Promise<{ whole: number; some: string[][] }> {
  const key = ctxKey('imported-transactions');
  const out = { whole: 0, some: [] as string[][] };
  const seam = fake as unknown as { hgetall: (k: string) => Promise<unknown>; eval: (script: string, keys: string[], args: string[]) => Promise<unknown> };
  const [hgetall, evaluate] = [seam.hgetall.bind(fake), seam.eval.bind(fake)];
  seam.hgetall = async (k) => {
    if (k === key) out.whole++;
    return hgetall(k);
  };
  seam.eval = async (script, keys, args) => {
    if (keys[0] === key && script === READ_ENTRIES) out.some.push([...args]);
    return evaluate(script, keys, args);
  };
  try {
    await fn();
  } finally {
    delete (seam as { hgetall?: unknown }).hgetall;
    delete (seam as { eval?: unknown }).eval;
  }
  return out;
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

  test('what a pair may rest on: a posted row removed, or changed in what matching reads; never one added, pending, or changed in anything else', () => {
    const row = bankTxn('B', 39, 150) as unknown as Parameters<typeof changedRows>[0][string];
    const ids = (before: Record<string, typeof row>, after: Record<string, typeof row>) => changedRows(before, after).map((t) => t.transaction_id);
    expect(ids({ B: row }, { B: row, C: { ...row, transaction_id: 'C' } })).toEqual([]);
    expect(ids({ B: row }, { B: { ...row, category: 'groceries', logo_url: 'https://x/logo.png' } })).toEqual([]);
    for (const change of [{ amount: 160.5 }, { date: daysAgo(38) }, { name: 'COSTCO 123' }, { merchant_name: 'Costco Wholesale' }, { iso_currency_code: 'CAD' }, { account_id: 'acc_sav' }]) {
      expect(ids({ B: row }, { B: { ...row, ...change } })).toEqual(['B']);
    }
    expect(ids({ B: row }, {})).toEqual(['B']);
    expect(ids({ B: { ...row, pending: true } }, {})).toEqual([]);
  });

  test('what carries across a re-link: the row with exactly the content, under the account it is linked to, one to one, never before a link', () => {
    const stood = bankTxn('n1', 39, 160.5, { account_id: 'acc_new' }) as unknown as Parameters<typeof changedRows>[0][string];
    const twin = { ...stood, transaction_id: 'n2' };
    const key = `acc_old|${daysAgo(39)}|16050|costco whse #123`;
    const carried = new Map([['acc_old', { version: 1 as const, twins: { 'imported-txn:1': key, 'imported-txn:2': key, 'imported-txn:3': `acc_old|${daysAgo(39)}|16200|costco whse #123` } }]]);
    const links = new Map([['acc_old', { to: 'acc_new', linked_at: new Date().toISOString(), evidence: {} }]]);
    // Two identical rows, two rows carried with their content: one each, in id order.
    expect(carriedPairs(carried, links, {}, { n1: stood, n2: twin })).toEqual({
      pins: new Map([
        ['imported-txn:1', 'n1'],
        ['imported-txn:2', 'n2'],
      ]),
      from: new Map([['acc_old', ['imported-txn:1', 'imported-txn:2', 'imported-txn:3']]]),
    });
    // The row as it was before this sync, which this sync changes.
    expect(carriedPairs(carried, links, { n1: stood }, { n1: { ...stood, amount: 170 } }).pins).toEqual(new Map([['imported-txn:1', 'n1']]));
    // Not linked, or a pending row: nothing.
    expect(carriedPairs(carried, new Map(), {}, { n1: stood }).from.size).toBe(0);
    expect(carriedPairs(carried, links, {}, { n1: { ...stood, pending: true } }).pins.size).toBe(0);
    // Added where neither is paired already.
    expect(withCarried({ version: 1, twins: { 'imported-txn:9': 'n2' } }, new Map([['imported-txn:1', 'n1'], ['imported-txn:2', 'n2']]))).toEqual({
      version: 1,
      twins: { 'imported-txn:9': 'n2', 'imported-txn:1': 'n1' },
    });
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
      return new Request('http://localhost/api/history-import', { method: 'POST', body: f });
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

  test('undone, its pair pairs nothing, and goes with the next sync that changes one of the connection’s rows', async () => {
    const id = await importStatement();
    plaid.added.push(COSTCO(150));
    await sync();
    plaid.modified.push(COSTCO(160.5));
    await sync();
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toEqual({ version: 1, twins: { [id]: 'b_costco' } });
    const import_id = (await importedTxnStore.get(ctx, 'acc_chk'))!.rows[0].import_id;
    const undone = await routes.DELETE(
      new Request('http://localhost/api/history-import', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id: 'acc_chk', import_id, confirm: true }) })
    );
    expect(undone.status).toBe(200);
    expect((await rows()).map((t) => t.transaction_id).sort()).toEqual(['b_costco', 'b_first']);
    // A sync that changes nothing reads nothing, and leaves it, pairing nothing.
    await sync();
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toEqual({ version: 1, twins: { [id]: 'b_costco' } });
    expect((await rows()).map((t) => t.transaction_id).sort()).toEqual(['b_costco', 'b_first']);
    // One that changes a row reads the books of the connection's accounts: gone.
    plaid.modified.push(bankTxn('b_first', 60, 12, { name: 'FIRST ROW', merchant_name: null }));
    await sync();
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

describe('kept by the sync that changes a row, reading only its connection', () => {
  test('a sync that changes nothing, or only adds rows, reads no book; one that changes a row reads only its connection’s accounts’ books, under every id', async () => {
    // Another connection, with a book of its own; and an earlier id of Chase's account.
    await connect('item_card', 'Amex', ['acc_card']);
    others.set('access-sandbox-item_card', { added: [], modified: [], removed: [] });
    await storeBank([bankTxn('c_first', 50, 20, { account_id: 'acc_card', name: 'CARD ROW', merchant_name: null })], 'item_card', ['acc_card']);
    await importedTxnStore.set(ctx, 'acc_card', { version: 1, rows: [heldRow('acc_card', 'history-import:card', 300, 5)] });
    await linkAccounts(ctx, 'acc_before', 'acc_chk', { basis: 'by_hand' });
    const id = await importStatement();
    // The load's own read of the books is the only one.
    expect(await bookReads(() => sync())).toEqual({ whole: 1, some: [] });
    plaid.added.push(COSTCO(150));
    expect(await bookReads(() => sync())).toEqual({ whole: 1, some: [] });
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toBeNull();
    plaid.modified.push(COSTCO(160.5));
    expect(await bookReads(() => sync())).toEqual({ whole: 1, some: [['acc_before', 'acc_chk']] });
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toEqual({ version: 1, twins: { [id]: 'b_costco' } });
    expect(await moneyOut()).toBe(10 + 160.5 + 20);
  });

  test('a removal elsewhere at the connection that moves where its rows begin keeps the pair it would cut', async () => {
    await connect('item_chase', 'Chase', ['acc_chk', 'acc_sav']);
    await storeBank([bankTxn('b_old', 60, 25, { account_id: 'acc_sav', name: 'SAVINGS ROW', merchant_name: null })], 'item_chase', ['acc_chk', 'acc_sav']);
    const id = await importStatement();
    // The bank sends the Costco run dated two days after the file does.
    plaid.added.push(bankTxn('b_costco', 38, 150));
    await sync();
    expect((await rows()).map((t) => t.transaction_id).sort()).toEqual(['b_costco', 'b_old']);
    // It takes back its oldest row, on the other account: its rows now begin
    // after the imported row's day, which only a lag would pair across.
    plaid.removed.push('b_old');
    await sync();
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toEqual({ version: 1, twins: { [id]: 'b_costco' } });
    expect((await rows()).map((t) => t.transaction_id)).toEqual(['b_costco']);
    expect(await moneyOut()).toBe(150);
  });

  test('an import’s summary that can’t be read at another connection never stops it here', async () => {
    const id = await importStatement();
    plaid.added.push(COSTCO(150));
    await sync();
    await connect('item_card', 'Amex', ['acc_card']);
    others.set('access-sandbox-item_card', { added: [], modified: [], removed: [] });
    await storeBank([bankTxn('c_first', 50, 20, { account_id: 'acc_card', name: 'CARD ROW', merchant_name: null })], 'item_card', ['acc_card']);
    await importedTxnStore.set(ctx, 'acc_card', { version: 1, rows: [heldRow('acc_card', 'history-import:card', 300, 5)] });
    await fake.hset(ctxKey('history-import-summaries'), { 'history-import:card': 'not ciphertext' });
    plaid.modified.push(COSTCO(160.5));
    await quietly(() => sync());
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toEqual({ version: 1, twins: { [id]: 'b_costco' } });
    const shown = (await rows()).map((t) => t.transaction_id);
    expect(shown).toContain('b_costco');
    expect(shown).not.toContain(id);
  });

  test('nor does the closure of an account no connection has, whose book holds imported rows', async () => {
    const id = await importStatement();
    plaid.added.push(COSTCO(150));
    await sync();
    await importedTxnStore.set(ctx, 'acc_gone', { version: 1, rows: [heldRow('acc_gone', 'history-import:gone', 300, 5)] });
    await fake.hset(ctxKey('account-lifecycle'), { acc_gone: 'not ciphertext' });
    // A load stops at a closure it can't read, before any sync: the
    // backfill's sync of the connection goes on.
    plaid.modified.push(COSTCO(160.5));
    const chase = (await getItems(ctx)).find((i) => i.item_id === 'item_chase')!;
    await quietly(() => readItemTransactions(ctx, chase));
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toEqual({ version: 1, twins: { [id]: 'b_costco' } });
  });
});

describe('across a re-link', () => {
  const NEW_FIRST = bankTxn('b2_first', 60, 10, { name: 'FIRST ROW', merchant_name: null, account_id: 'acc_chk2' });
  const NEW_COSTCO = (amount: number) => bankTxn('b2_costco', 39, amount, { account_id: 'acc_chk2' });
  /** The bank's row stood for the imported one, then the bank changed it. */
  async function pairedThenChanged(): Promise<string> {
    const id = await importStatement();
    plaid.added.push(COSTCO(150));
    await sync();
    plaid.modified.push(COSTCO(160.5));
    await sync();
    expect(await moneyOut()).toBe(10 + 160.5);
    return id;
  }
  /** Chase disconnected and added back: a new connection, new ids, its rows
   *  as the bank has them now; and, unless not, its account linked to the
   *  earlier one. */
  async function relink(rows: ReturnType<typeof bankTxn>[], { link = true } = {}) {
    await quietly(() => disconnectItem(ctx, 'item_chase', undefined));
    await connect('item_chase2', 'Chase', ['acc_chk2']);
    await storeBank(rows, 'item_chase2', ['acc_chk2']);
    if (link) await linkAccounts(ctx, 'acc_chk', 'acc_chk2', { basis: 'by_hand' });
  }

  test('a pair the bank changed carries by its bank row’s content, and the re-added connection’s sync makes it again: the transaction counts once', async () => {
    const id = await pairedThenChanged();
    await relink([NEW_FIRST, NEW_COSTCO(160.5)]);
    // Disconnecting left nothing kept for the connection gone, and carried
    // the pair by what its bank row says, which the download has.
    expect(await importedTwinsStore.get(ctx, 'item_chase')).toBeNull();
    const carried = { version: 1 as const, twins: { [id]: `acc_chk|${daysAgo(39)}|16050|costco whse #123` } };
    expect(await carriedTwinsStore.get(ctx, 'acc_chk')).toEqual(carried);
    expect(buildUserExport(await collectUserData({ ctx, userId: null }), new Date())['carried-imported-twins']).toEqual([{ id: 'acc_chk', value: carried }]);
    // The re-added connection's next sync pairs the imported row with its
    // row that says exactly that, in the very load it reads them.
    const load = await sync();
    expect(load.payload.transactions.map((t) => t.transaction_id).sort()).toEqual(['b2_costco', 'b2_first']);
    expect(await moneyOut()).toBe(10 + 160.5);
    expect(await importedTwinsStore.get(ctx, 'item_chase2')).toEqual({ version: 1, twins: { [id]: 'b2_costco' } });
    expect(await carriedTwinsStore.get(ctx, 'acc_chk')).toBeNull();
    // Kept as any pair is: changed again, still the one transaction.
    plaid.modified.push(NEW_COSTCO(162));
    await sync();
    expect((await rows()).map((t) => t.transaction_id).sort()).toEqual(['b2_costco', 'b2_first']);
    expect(await moneyOut()).toBe(10 + 162);
  });

  test('one whose bank row hasn’t come yet waits for it, and is made again in the load that brings it', async () => {
    const id = await pairedThenChanged();
    await relink([NEW_FIRST]);
    await sync();
    expect(await importedTwinsStore.get(ctx, 'item_chase2')).toBeNull();
    expect(Object.keys((await carriedTwinsStore.get(ctx, 'acc_chk'))!.twins)).toEqual([id]);
    plaid.added.push(NEW_COSTCO(160.5));
    const load = await sync();
    expect(load.payload.transactions.map((t) => t.transaction_id).sort()).toEqual(['b2_costco', 'b2_first']);
    expect(await moneyOut()).toBe(10 + 160.5);
    expect(await carriedTwinsStore.get(ctx, 'acc_chk')).toBeNull();
  });

  test('never by anything looser, and never before the accounts are linked; forgetting the earlier account forgets it', async () => {
    const id = await pairedThenChanged();
    // The bank changed its row again before Chase was added back.
    await relink([NEW_FIRST, NEW_COSTCO(162)], { link: false });
    await sync();
    expect(await importedTwinsStore.get(ctx, 'item_chase2')).toBeNull();
    await linkAccounts(ctx, 'acc_chk', 'acc_chk2', { basis: 'by_hand' });
    await sync();
    expect((await rows()).map((t) => t.transaction_id).sort()).toEqual(['b2_costco', 'b2_first', id].sort());
    expect(await importedTwinsStore.get(ctx, 'item_chase2')).toBeNull();
    expect(await carriedTwinsStore.get(ctx, 'acc_chk')).not.toBeNull();
    await forgetImportedHistory(ctx, 'acc_chk');
    expect(await carriedTwinsStore.get(ctx, 'acc_chk')).toBeNull();
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
    // Its pairs unreadable, the amount an edit adds up to isn't known: 409.
    const kept = await fake.hget<string>(ctxKey('imported-twins'), 'item_chase');
    await fake.hset(ctxKey('imported-twins'), { item_chase: 'not ciphertext' });
    expect((await put(id, [{ amount: 110.5, category_id: food }, { amount: 50, category_id: home }], (await (await import('@/lib/splits')).splitStore.get(ctx, id))!.updated_at)).status).toBe(409);
    await fake.hset(ctxKey('imported-twins'), { item_chase: kept! });
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

  test('edited to the bank’s amount, then the bank removes its row: the imported row counts at the file’s amount, and says why its split has a part of its own', async () => {
    const id = await importStatement();
    const t = (await (await transactionsRoute.GET(new Request('http://localhost/api/transactions?refresh=1'))).json()).categories;
    const food = t.categories.find((c: { name: string }) => c.name.toLowerCase() === 'food and drink').id;
    const home = t.categories.find((c: { id: string; kind?: string }) => c.id !== food).id;
    expect((await put(id, [{ amount: 100, category_id: food }, { amount: 50, category_id: home }])).status).toBe(200);
    plaid.added.push(COSTCO(150));
    await sync();
    plaid.modified.push(COSTCO(160.5));
    await sync();
    const split = (await import('@/lib/splits')).splitStore;
    expect((await put(id, [{ amount: 110.5, category_id: food }, { amount: 50, category_id: home }], (await split.get(ctx, id))!.updated_at)).status).toBe(200);
    plaid.removed.push('b_costco');
    await sync();
    const whole = bankRows(await rows()).find((r) => r.transaction_id === id)!;
    expect(whole.amount).toBe(150);
    expect(whole.split_parts!.map((p) => [p.amount, p.split_remainder ?? null])).toEqual([
      [110.5, null],
      [50, null],
      [-10.5, { was: 160.5 }],
    ]);
    // Never as an amount that changed: the file's never did.
    expect(entryNotice(whole as never)).toBe(
      'You split this at the amount of the bank’s transaction that stood for it. None does now, so it counts at your file’s amount, with the difference as a part of its own until you edit the split.'
    );
    // The month nets the file's amount, until the split is edited to it.
    const spent = await readSpending(ctx, { from: daysAgo(70), to: daysAgo(0) });
    expect([spent.money_out, spent.money_in, spent.net]).toEqual([10 + 160.5, 10.5, -(10 + 150)]);
    expect((await put(id, [{ amount: 100, category_id: food }, { amount: 50, category_id: home }], (await split.get(ctx, id))!.updated_at)).status).toBe(200);
    expect(await moneyOut()).toBe(10 + 150);
  });
});

describe('a place in a group carried from the imported row', () => {
  test('the bank row takes it, and the group nets the bank’s amount now: the transaction counted once, in its group', async () => {
    await storeBank([FIRST, bankTxn('b_payback', 38, -50, { name: 'ZELLE FROM SAM', merchant_name: null })]);
    const id = await importStatement();
    const t = (await (await transactionsRoute.GET(new Request('http://localhost/api/transactions?refresh=1'))).json()).categories;
    const food = t.categories.find((c: { name: string }) => c.name.toLowerCase() === 'food and drink').id;
    const made = await groupsRoute.POST(new Request('http://x/api/transaction-groups', { method: 'POST', body: JSON.stringify({ name: 'Costco with Sam', category_id: food, members: [id, 'b_payback'] }) }));
    expect(made.status).toBe(200);
    expect(await moneyOut()).toBe(10 + 100);
    plaid.added.push(COSTCO(150));
    await sync();
    plaid.modified.push(COSTCO(160.5));
    await sync();
    const group = (await rows()).find((r) => r.group_members);
    expect(group!.group_members!.map((m) => [m.transaction_id, m.amount, m.group_carried_from ?? null]).sort()).toEqual([
      ['b_costco', 160.5, id],
      ['b_payback', -50, null],
    ]);
    expect(group!.amount).toBe(110.5);
    expect(await moneyOut()).toBe(10 + 110.5);
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
    // The account's statement lists the bank's row once, and not the imported one.
    const data = await collectUserData({ ctx, userId: null });
    const statement = ofxFile(data, buildUserExport(data, new Date()), 'acc_chk', new Date());
    if (!('file' in statement)) throw new Error(statement.refused);
    const ofx = [...statement.file.pieces()].join('');
    expect(ofx).toContain('<FITID>b_costco');
    expect(ofx).not.toContain(`<FITID>${id}`);
  });

  test('pairs that can’t be read are said, and the file counts those rows by what each says now', async () => {
    const id = await importStatement();
    plaid.added.push(COSTCO(150));
    await sync();
    plaid.modified.push(COSTCO(160.5));
    await sync();
    await fake.hset(ctxKey('imported-twins'), { item_chase: 'not ciphertext' });
    const doc = buildUserExport(await quietly(() => collectUserData({ ctx, userId: null })), new Date());
    expect(doc.problems).toContainEqual(expect.objectContaining({ section: 'imported-twins', ids: ['item_chase'] }));
    const file = exportFile(doc, 'transactions-csv');
    expect(file.incomplete).toContain('imported-twins');
    expect(file.notes.join(' ')).toContain('Not all of your pairs of imported and bank transactions could be read');
    const [, ...csvRows] = parseCsv([...file.pieces()].join(''));
    expect(csvRows.map((r) => r[TRANSACTION_COLUMNS.indexOf('transaction_id')]).sort()).toEqual(['b_costco', 'b_first', id].sort());
  });
});
