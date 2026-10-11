import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// The payoff of importing into a linked account: the estimated history
// reaching back to the oldest imported transaction (lib/history-import/
// extend.ts, drawn by the import route and by app/api/backfill). Only the
// estimated layer is ever written: the real snapshot layer is byte for byte
// the same after any import, any undo and any walk. A gap between imported
// ranges is never spanned, and the chart is told what isn't drawn.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const plaid = {
  accounts: [] as unknown[],
};
mock.module('@/lib/plaid', () => ({
  plaidClient: {
    accountsGet: async () => ({ data: { item: { institution_id: 'ins_1' }, accounts: plaid.accounts } }),
    transactionsSync: async () => ({
      data: { added: [], modified: [], removed: [], accounts: [], next_cursor: 'c-next', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE' },
    }),
  },
}));

const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { encrypt } = await import('@/lib/crypto');
const { encodeJsonBlob } = await import('@/lib/blob');
const { saveItem, removeItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { linkAccounts } = await import('@/lib/links');
const { setAccountHidden } = await import('@/lib/hidden');
const { getHistory, getAccountHistory, isBackfillDone, markBackfillDone } = await import('@/lib/history');
const { writeCache, CacheKey } = await import('@/lib/cache');
const { readDrawState, drawImportedHistory, markDrawStale, linksChanged, DrawUnreadableError } = await import('@/lib/history-import/extend');
const { importedHistoryView, importedHistoryLines } = await import('@/lib/history-import/view');
const backfill = await import('@/app/api/backfill/route');
const routes = await import('@/app/api/history-import/route');
const netWorth = await import('@/app/api/net-worth/route');
const { readBalanceHistory } = await import('@/lib/api-read');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const compact = (d: string) => d.replace(/-/g, '');

function bankTxn(id: string, account_id: string, days: number, amount: number) {
  return {
    transaction_id: id,
    pending_transaction_id: null,
    account_id,
    amount,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
    date: daysAgo(days),
    authorized_date: null,
    authorized_datetime: null,
    datetime: null,
    name: id.toUpperCase(),
    merchant_name: null,
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
  };
}

const account = (account_id: string, type: string, current: number) => ({
  account_id,
  name: account_id,
  official_name: null,
  type,
  subtype: null,
  mask: null,
  balances: { available: current, current, limit: null, iso_currency_code: 'USD' },
});

/** An OFX statement covering `start` to `end` days ago, for a bank account
 *  or (`card`) a credit card. */
function ofx(trns: { fitid: string; days: number; amount: number; name: string }[], period: { start: number; end: number }, card = false, acctid = card ? '4111000000002222' : '0001111') {
  const list = trns
    .map((t) => `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${compact(daysAgo(t.days))}</DTPOSTED><TRNAMT>${t.amount.toFixed(2)}</TRNAMT><FITID>${t.fitid}</FITID><NAME>${t.name}</NAME></STMTTRN>`)
    .join('');
  const from = card ? `<CCACCTFROM><ACCTID>${acctid}</ACCTID></CCACCTFROM>` : `<BANKACCTFROM><BANKID>1</BANKID><ACCTID>${acctid}</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>`;
  const [rs, trnrs, msgs] = card ? ['CCSTMTRS', 'CCSTMTTRNRS', 'CREDITCARDMSGSRSV1'] : ['STMTRS', 'STMTTRNRS', 'BANKMSGSRSV1'];
  return `<?xml version="1.0"?><?OFX OFXHEADER="200" VERSION="220"?><OFX><${msgs}><${trnrs}><STATUS><CODE>0</CODE></STATUS><${rs}><CURDEF>USD</CURDEF>${from}<BANKTRANLIST><DTSTART>${compact(daysAgo(period.start))}</DTSTART><DTEND>${compact(daysAgo(period.end))}</DTEND>${list}</BANKTRANLIST></${rs}></${trnrs}></${msgs}></OFX>`;
}

function upload(meta: Record<string, unknown>, file: string): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(file) as Uint8Array<ArrayBuffer>]), 'statement.ofx');
  form.set('meta', JSON.stringify({ file_name: 'statement.ofx', ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
}
async function importReviewed(account_id: string, file: string) {
  const p = await routes.POST(upload({ action: 'preview', account_id }, file));
  const review = (await p.json()).preview.review;
  const res = await routes.POST(upload({ action: 'import', account_id, review }, file));
  return { status: res.status, body: await res.json() };
}
const undo = async (account_id: string, import_id: string) =>
  (await routes.DELETE(new Request('http://localhost/api/history-import', { method: 'DELETE', body: JSON.stringify({ account_id, import_id, confirm: true }) }))).json();
const runBackfill = async () => (await backfill.POST()).json();
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const saved = [console.error, console.warn];
  console.error = console.warn = () => {};
  try {
    return await fn();
  } finally {
    [console.error, console.warn] = saved;
  }
}
/** The checking account's bank rows, stored as these. */
async function storeBank(txns: ReturnType<typeof bankTxn>[], item = 'item_chase', accounts: Record<string, unknown> = CHASE_ACCOUNTS) {
  await fake.set(
    ctxKey(`txns:${item}`),
    await encodeJsonBlob({ schema_version: 2, cursor: 'c1', accounts, txns: Object.fromEntries(txns.map((t) => [t.transaction_id, t])), synced_at: new Date().toISOString() })
  );
}
const CHASE_ACCOUNTS = {
  acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
  acc_card: { name: 'Visa', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: null },
  acc_loan: { name: 'Car loan', official_name: null, type: 'loan', subtype: 'auto', mask: '3333', balances: null },
};

/** The real snapshot layer, as stored: totals, account maps, partial maps and
 *  when each was taken. */
function realLayer(): string {
  const keys = ['history:net-worth', 'history:accounts', 'history:accounts:partial', 'snapshot:taken'].map((k) => ctxKey(k));
  return JSON.stringify(keys.map((k) => [k, [...((fake as any).hashes.get(k) ?? new Map()).entries()].sort()]));
}
/** The estimated layer, as stored. */
function estimatedLayer(): string {
  const keys = ['history:net-worth:est', 'history:accounts:est', 'history:accounts:est:flatd', 'history:accounts:est:ext'].map((k) => ctxKey(k));
  return JSON.stringify(keys.map((k) => [k, [...((fake as any).hashes.get(k) ?? new Map()).entries()].sort()]));
}

async function seed() {
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-chase') });
  plaid.accounts = [account('acc_chk', 'depository', 1000), account('acc_card', 'credit', 300), account('acc_loan', 'loan', 9000)];
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await encrypt(
      JSON.stringify([
        { account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' },
        { account_id: 'acc_card', name: 'Visa', official_name: null, mask: '2222', type: 'credit', subtype: 'credit card', limit: 5000, currency: 'USD' },
        { account_id: 'acc_loan', name: 'Car loan', official_name: null, mask: '3333', type: 'loan', subtype: 'auto', limit: null, currency: 'USD' },
      ])
    ),
  });
  await storeBank([bankTxn('b_first', 'acc_chk', 60, 10), bankTxn('b_mid', 'acc_chk', 30, -200), bankTxn('c_buy', 'acc_card', 40, 50)]);
  // Two recorded days: what the import, the undo and every walk must leave
  // byte for byte as they are.
  const map = (m: Record<string, number>) => encrypt(JSON.stringify(m));
  await fake.hset(ctxKey('history:net-worth'), { [daysAgo(2)]: await encrypt(String(1000 - 300 - 9000)), [daysAgo(1)]: await encrypt(String(1000 - 300 - 9000)) });
  await fake.hset(ctxKey('history:accounts'), {
    [daysAgo(2)]: await map({ acc_chk: 1000, acc_card: 300, acc_loan: 9000 }),
    [daysAgo(1)]: await map({ acc_chk: 1000, acc_card: 300, acc_loan: 9000 }),
  });
  await fake.hset(ctxKey('snapshot:taken'), { [daysAgo(1)]: `${daysAgo(1)}T13:00:00.000Z` });
}

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await seed();
});

const valueOn = (points: { date: string; value: number }[], days: number) => points.find((p) => p.date === daysAgo(days))?.value;

describe('the estimated history after an import', () => {
  test('reaches back to the oldest imported transaction, in the estimated layer only, joined to the backfill’s earliest point', async () => {
    const real = realLayer();
    expect((await runBackfill()).backfilled).toBeGreaterThan(0);
    expect(await isBackfillDone(ctx)).toBe(true);
    const base = await getHistory(ctx);
    // The backfill stops at the bank's earliest row: 800 in checking (the
    // 200 paid in on day 30 un-applied), 250 owed on the card.
    expect(base[0]).toEqual({ date: daysAgo(60), value: 800 - 250 - 9000, estimated: true });

    const imported = await importReviewed(
      'acc_chk',
      ofx(
        [
          { fitid: 'A', days: 100, amount: -30, name: 'OLD SHOP' },
          { fitid: 'B', days: 200, amount: 400, name: 'OLD PAY' },
        ],
        { start: 400, end: 55 }
      )
    );
    expect(imported.status).toBe(200);
    expect(imported.body.history).toEqual({ drawn: true, from: daysAgo(401), reach: daysAgo(401), backfill: false });
    const history = await getHistory(ctx);
    expect(history[0].date).toBe(daysAgo(401));
    expect(history.every((p) => p.date >= daysAgo(2) || p.estimated)).toBe(true);
    // Un-applying the bank's day-60 row first (10 out), then the imported ones.
    expect(valueOn(history, 61)).toBe(810 - 250 - 9000);
    expect(valueOn(history, 100)).toBe(810 - 250 - 9000);
    expect(valueOn(history, 101)).toBe(840 - 250 - 9000);
    expect(valueOn(history, 201)).toBe(440 - 250 - 9000);
    expect(valueOn(history, 401)).toBe(440 - 250 - 9000);
    // The account's own chart reaches back too; the card's stops at the
    // backfill's earliest point, held there in the totals before it.
    expect((await getAccountHistory(ctx, 'acc_chk'))[0]).toEqual({ date: daysAgo(401), value: 440, estimated: true });
    expect((await getAccountHistory(ctx, 'acc_card'))[0].date).toBe(daysAgo(60));
    expect(realLayer()).toBe(real);
  });

  test('undone, the chart is exactly as it was before the import, the estimated layer byte for byte too', async () => {
    const real = realLayer();
    await runBackfill();
    const estimated = estimatedLayer();
    const { body } = await importReviewed('acc_chk', ofx([{ fitid: 'A', days: 100, amount: -30, name: 'OLD SHOP' }], { start: 400, end: 55 }));
    expect(estimatedLayer()).not.toBe(estimated);
    await undo('acc_chk', body.import_id);
    expect(estimatedLayer()).toBe(estimated);
    expect(realLayer()).toBe(real);
    // And a backfill run afterwards draws nothing more.
    await runBackfill();
    expect(realLayer()).toBe(real);
  });

  test('a gap between imported ranges is never spanned: 2019 and 2023 without what is between, and the chart says so', async () => {
    await runBackfill();
    const early = await importReviewed('acc_chk', ofx([{ fitid: 'E', days: 950, amount: -20, name: 'EARLY' }], { start: 1000, end: 900 }));
    expect(early.body.history).toEqual({ drawn: true, from: null, reach: null, backfill: false });
    await importReviewed('acc_chk', ofx([{ fitid: 'L', days: 300, amount: -5, name: 'LATER' }], { start: 400, end: 55 }));
    const history = await getHistory(ctx);
    expect(history[0].date).toBe(daysAgo(401));
    const state = (await readDrawState(ctx))!;
    expect(state.accounts.find((a) => a.account_id === 'acc_chk')).toMatchObject({
      reach: daysAgo(401),
      gaps: [{ imported: { from: daysAgo(1000), to: daysAgo(900) }, uncovered: { from: daysAgo(899), to: daysAgo(401) } }],
    });
    // The net-worth answer carries it for the chart's note.
    await writeCache(ctx, CacheKey.NetWorth, { institutions: [], netWorth: 0, history: [], hidden: [], as_of: new Date().toISOString() });
    const nw = await (await netWorth.GET(new Request('http://localhost/api/net-worth'))).json();
    expect(nw.backfill_stale).toBe(false);
    expect(nw.imported_history).toMatchObject({
      until: daysAgo(60),
      from: daysAgo(401),
      accounts: [{ account_id: 'acc_chk', reach: daysAgo(401), bank_from: daysAgo(60) }],
      gaps: [{ account_id: 'acc_chk' }],
      problem: null,
    });
  });

  test('the API says which estimated points are walked back through imported rows, for net worth and for the account', async () => {
    await runBackfill();
    const { body } = await importReviewed('acc_chk', ofx([{ fitid: 'A', days: 100, amount: -30, name: 'OLD SHOP' }], { start: 400, end: 55 }));
    const drawn = { from: daysAgo(401), until: daysAgo(60) };
    const all = (await readBalanceHistory(ctx, { includeEstimated: true, interval: 'day' }))!;
    expect(all.from_imports).toEqual(drawn);
    expect(all.points[0]).toMatchObject({ date: daysAgo(401), estimated: true });
    expect((await readBalanceHistory(ctx, { accountId: 'acc_chk', includeEstimated: true }))!.from_imports).toEqual(drawn);
    // The card isn't walked through any: its history stops where the bank's does.
    expect((await readBalanceHistory(ctx, { accountId: 'acc_card', includeEstimated: true }))!.from_imports).toBeNull();
    // Recorded points only, none of them is.
    expect((await readBalanceHistory(ctx, {}))!.from_imports).toBeNull();
    // Hidden, the only account that follows them leaves net worth's stretch
    // with it, unless hidden accounts are asked for.
    await setAccountHidden(ctx, 'acc_chk', 'depository', true);
    expect((await readBalanceHistory(ctx, { includeEstimated: true }))!.from_imports).toBeNull();
    expect((await readBalanceHistory(ctx, { includeEstimated: true, includeHidden: true }))!.from_imports).toEqual(drawn);
    await setAccountHidden(ctx, 'acc_chk', 'depository', false);
    await undo('acc_chk', body.import_id);
    expect((await readBalanceHistory(ctx, { includeEstimated: true }))!.from_imports).toBeNull();
  });

  test('a card walks with its own sign: what was charged before is owed less further back', async () => {
    await runBackfill();
    await importReviewed('acc_card', ofx([{ fitid: 'C', days: 120, amount: -70, name: 'OLD PURCHASE' }], { start: 200, end: 50 }, true));
    const card = await getAccountHistory(ctx, 'acc_card');
    expect(card.find((p) => p.date === daysAgo(120))?.value).toBe(250);
    expect(card.find((p) => p.date === daysAgo(121))?.value).toBe(180);
  });

  test('a loan’s imported rows are activity only: never walked', async () => {
    await runBackfill();
    const before = estimatedLayer();
    const { body } = await importReviewed('acc_loan', ofx([{ fitid: 'P', days: 100, amount: -400, name: 'LOAN PAYMENT' }], { start: 300, end: 55 }, false, '0003333'));
    expect(body.imported).toBe(1);
    // Nothing is said of the chart reaching back through it.
    expect(body.history).toMatchObject({ reach: null });
    expect(estimatedLayer()).toBe(before);
  });

  test('imported before the backfill has run, it waits for it, and the backfill draws it', async () => {
    const real = realLayer();
    const { body } = await importReviewed('acc_chk', ofx([{ fitid: 'A', days: 100, amount: -30, name: 'OLD SHOP' }], { start: 400, end: 55 }));
    expect(body.history).toEqual({ drawn: false, from: null, reach: null, backfill: false });
    const ran = await runBackfill();
    expect(ran.from_imports).toBe(341);
    expect((await getHistory(ctx))[0].date).toBe(daysAgo(401));
    expect(realLayer()).toBe(real);
  });

  test('a backfill run again joins the drawn history to its own new earliest point, and never takes its own points for the drawing’s', async () => {
    await runBackfill();
    await importReviewed('acc_chk', ofx([{ fitid: 'A', days: 100, amount: -30, name: 'OLD SHOP' }], { start: 400, end: 55 }));
    const drawn = await getHistory(ctx);
    // Linking a new institution clears the done flag; the backfill runs again.
    await fake.del(ctxKey('history:backfill-done'));
    const ran = await runBackfill();
    expect(ran.from_imports).toBe(341);
    expect(await getHistory(ctx)).toEqual(drawn);
  });
});

describe('the estimated history, where the bank’s rows and the imported ones meet', () => {
  test('a card whose bank rows start after the backfill’s earliest point: the backfill walks its imported rows between, so the drawing starts from the right balance', async () => {
    const real = realLayer();
    await runBackfill();
    // Owed 300 now and 250 before day 40, where the card's own rows begin:
    // the backfill holds it there back to its earliest point, day 60.
    expect((await getAccountHistory(ctx, 'acc_card')).find((p) => p.date === daysAgo(55))?.value).toBe(250);
    const { body } = await importReviewed(
      'acc_card',
      ofx(
        [
          { fitid: 'P50', days: 50, amount: -200, name: 'BIG PURCHASE' },
          { fitid: 'P120', days: 120, amount: -30, name: 'OLD PURCHASE' },
        ],
        { start: 200, end: 35 },
        true
      )
    );
    expect(body.imported).toBe(2);
    // A row dated after the earliest point: the backfill runs again first, and
    // the drawing waits for it.
    expect(body.history).toEqual({ drawn: false, from: null, reach: null, backfill: true });
    expect(await isBackfillDone(ctx)).toBe(false);
    await runBackfill();
    const card = await getAccountHistory(ctx, 'acc_card');
    const at = (n: number) => card.find((p) => p.date === daysAgo(n))?.value;
    expect([at(45), at(51), at(55), at(60), at(120), at(121), at(130), at(201)]).toEqual([250, 50, 50, 50, 50, 20, 20, 20]);
    expect((await readDrawState(ctx))!.accounts.find((a) => a.account_id === 'acc_card')).toMatchObject({ reach: daysAgo(201), why: null });
    expect(realLayer()).toBe(real);
  });

  test('a re-link whose window starts later: the duplicates of rows the new connection lacks are walked again, never crossed without their flows', async () => {
    // The first connection's rows: two payrolls and a rent.
    await storeBank([
      { ...bankTxn('p1', 'acc_chk', 170, -4000), name: 'PAYROLL' },
      { ...bankTxn('p2', 'acc_chk', 140, -4000), name: 'PAYROLL' },
      { ...bankTxn('r4', 'acc_chk', 20, 1850), name: 'RENT' },
    ]);
    const { body } = await importReviewed(
      'acc_chk',
      ofx(
        [
          { fitid: 'A', days: 300, amount: -1850, name: 'RENT' },
          { fitid: 'C', days: 170, amount: 4000, name: 'PAYROLL' },
          { fitid: 'D', days: 140, amount: 4000, name: 'PAYROLL' },
        ],
        { start: 330, end: 20 }
      )
    );
    expect(body).toMatchObject({ imported: 1, duplicates: 2 });
    // Disconnected and linked again: the new connection's rows start on day 60.
    await removeItem(ctx, 'item_chase');
    await fake.del(ctxKey('txns:item_chase'));
    await fake.hdel(ctxKey('accounts:meta'), 'item_chase');
    await saveItem(ctx, { item_id: 'item_chase2', institution_name: 'Chase', encrypted_access_token: await encrypt('access-sandbox-chase-2') });
    await fake.hset(ctxKey('accounts:meta'), {
      item_chase2: await encrypt(JSON.stringify([{ account_id: 'acc_new', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }])),
    });
    await storeBank([{ ...bankTxn('n0', 'acc_new', 60, 5), name: 'FIRST' }, { ...bankTxn('n4', 'acc_new', 20, 1850), name: 'RENT' }], 'item_chase2', {
      acc_new: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
    });
    await linkAccounts(ctx, 'acc_chk', 'acc_new', { basis: 'by_hand' });
    // The chart's earliest point: 10,000 recorded a day ago.
    for (const k of ['history:net-worth', 'history:accounts', 'snapshot:taken']) await fake.del(ctxKey(k));
    await fake.hset(ctxKey('history:net-worth'), { [daysAgo(1)]: await encrypt('10000') });
    await fake.hset(ctxKey('history:accounts'), { [daysAgo(1)]: await encrypt(JSON.stringify({ acc_new: 10000 })) });
    await markBackfillDone(ctx);
    await markDrawStale(ctx);
    await drawImportedHistory(ctx);
    const history = await getHistory(ctx);
    // 10,000 now; the rent of day 20 and the 5 of day 60 un-applied: 11,855.
    // The payrolls of days 140 and 170 came in: 3,855 before them; the old
    // rent of day 300 went out: 5,705 before it.
    expect([valueOn(history, 100), valueOn(history, 200), valueOn(history, 320)]).toEqual([11855, 3855, 5705]);
    const state = (await readDrawState(ctx))!;
    expect(state.accounts).toEqual([expect.objectContaining({ account_id: 'acc_new', reach: daysAgo(331), gaps: [], why: null })]);
    // Hidden under its earlier id, it is hidden under this one too: the
    // chart's note never names it.
    await writeCache(ctx, CacheKey.NetWorth, { institutions: [], netWorth: 0, history: [], hidden: [], as_of: new Date().toISOString() });
    const note = async () => (await (await netWorth.GET(new Request('http://localhost/api/net-worth'))).json()).imported_history;
    expect((await note())?.accounts).toEqual([expect.objectContaining({ account_id: 'acc_new' })]);
    await setAccountHidden(ctx, 'acc_chk', 'depository', true);
    expect(await note()).toBeUndefined();
  });

  test('the bank’s own rows reaching before the earliest point are walked as the bank’s: the chart and the API say where the imported ones begin to count', async () => {
    await storeBank([bankTxn('b_year', 'acc_chk', 364, 10), bankTxn('b_old', 'acc_chk', 500, 20), bankTxn('c_buy', 'acc_card', 40, 50)]);
    await runBackfill();
    const anchor = (await getHistory(ctx))[0].date;
    expect(anchor).toBe(daysAgo(364));
    await importReviewed('acc_chk', ofx([{ fitid: 'A', days: 700, amount: -30, name: 'OLD SHOP' }], { start: 800, end: 450 }));
    const state = (await readDrawState(ctx))!;
    expect(state.accounts.find((a) => a.account_id === 'acc_chk')).toMatchObject({ reach: daysAgo(801), bank_from: daysAgo(500) });
    const view = importedHistoryView(state)!;
    const lines = importedHistoryLines(view, (id) => (id === 'acc_chk' ? 'Checking' : id), (d) => d);
    expect(lines[0]).toBe(`Checking: the estimate follows its bank’s own transactions back to ${daysAgo(500)}, and those you imported before that, back to ${daysAgo(801)}.`);
    expect((await readBalanceHistory(ctx, { includeEstimated: true, interval: 'day' }))!.from_imports).toEqual({ from: daysAgo(801), until: daysAgo(500) });
    expect((await readBalanceHistory(ctx, { accountId: 'acc_chk', includeEstimated: true }))!.from_imports).toEqual({ from: daysAgo(801), until: daysAgo(500) });
  });

  test('a drawing that can’t read what it needs draws nothing, keeps what was drawn, and says why; once it can, it draws again', async () => {
    await runBackfill();
    await importReviewed('acc_chk', ofx([{ fitid: 'A', days: 100, amount: -30, name: 'OLD SHOP' }], { start: 400, end: 55 }));
    const drawn = await getHistory(ctx);
    const estimated = estimatedLayer();
    const saved = (await fake.hget(ctxKey('imported-transactions'), 'acc_chk')) as string;
    // A newer release's shape, read after a rollback, or damaged bytes.
    await fake.hset(ctxKey('imported-transactions'), { acc_chk: 'not ciphertext' });
    await markDrawStale(ctx);
    await expect(quietly(() => drawImportedHistory(ctx))).rejects.toBeInstanceOf(DrawUnreadableError);
    expect(estimatedLayer()).toBe(estimated);
    let state = (await readDrawState(ctx))!;
    expect(state.problem).toEqual({ kind: 'unreadable', accounts: ['acc_chk'] });
    expect(state.built).not.toBe(state.generation);
    const view = importedHistoryView(state)!;
    expect(view).toMatchObject({ problem: { accounts: ['acc_chk'] }, redrawing: false });
    expect(importedHistoryLines(view, () => 'Checking', (d) => d)).toContain(
      'The estimate from imported transactions couldn’t be drawn again: Checking’s imported transactions can’t be read just now. What it showed before is kept.'
    );
    // The backfill's run doesn't fail for it, and leaves it as it is.
    await fake.del(ctxKey('history:backfill-done'));
    await quietly(() => runBackfill());
    expect(await getHistory(ctx)).toEqual(drawn);
    // Readable again: the next drawing draws it, and says nothing of a problem.
    await fake.hset(ctxKey('imported-transactions'), { acc_chk: saved });
    await drawImportedHistory(ctx);
    expect(await getHistory(ctx)).toEqual(drawn);
    state = (await readDrawState(ctx))!;
    expect(state.problem).toBeNull();
    expect(state.built).toBe(state.generation);
  });

  test('an import with lines that couldn’t be read isn’t walked, and the chart says so, unless the person said those lines aren’t transactions', async () => {
    await runBackfill();
    const file = ofx(
      [
        { fitid: 'A', days: 100, amount: -30, name: 'OLD SHOP' },
        { fitid: 'BAD', days: 150, amount: -1234.56, name: 'RENT' },
      ],
      { start: 400, end: 55 }
    ).replace('<TRNAMT>-1234.56</TRNAMT>', '<TRNAMT>12x4</TRNAMT>');
    const p = await routes.POST(upload({ action: 'preview', account_id: 'acc_chk' }, file));
    const review = (await p.json()).preview;
    expect(review.counts.unreadable).toBe(1);
    const res = await routes.POST(upload({ action: 'import', account_id: 'acc_chk', review: review.review }, file));
    const { import_id } = await res.json();
    expect((await getHistory(ctx))[0].date).toBe(daysAgo(60));
    const state = (await readDrawState(ctx))!;
    expect(state.accounts.find((a) => a.account_id === 'acc_chk')).toMatchObject({
      reach: null,
      excluded: [{ from: daysAgo(400), to: daysAgo(55), why: 'unreadable', lines: 1 }],
    });
    expect(importedHistoryLines(importedHistoryView(state)!, () => 'Checking', (d) => d)).toContain(
      `Checking’s import from ${daysAgo(400)} to ${daysAgo(55)} isn’t used for the chart: one of its lines couldn’t be read, so it may lack their transactions.`
    );
    // Said to hold every transaction of its period: walked.
    await undo('acc_chk', import_id);
    const again = await routes.POST(upload({ action: 'import', account_id: 'acc_chk', review: review.review, whole: true }, file));
    expect((await again.json()).history).toMatchObject({ drawn: true, reach: daysAgo(401) });
    expect((await getHistory(ctx))[0].date).toBe(daysAgo(401));
  });

  test('imported rows in another currency than the account’s are never walked into its balance: the import isn’t used, and the chart says so', async () => {
    await runBackfill();
    const before = estimatedLayer();
    const file = ofx([{ fitid: 'E', days: 100, amount: -30, name: 'PARIS SHOP' }], { start: 400, end: 55 }).replace('<CURDEF>USD</CURDEF>', '<CURDEF>EUR</CURDEF>');
    const p = await (await routes.POST(upload({ action: 'preview', account_id: 'acc_chk' }, file))).json();
    expect(p.preview.warnings.some((w: string) => w.includes('EUR'))).toBe(true);
    const done = await (await routes.POST(upload({ action: 'import', account_id: 'acc_chk', review: p.preview.review }, file))).json();
    expect(done.imported).toBe(1);
    const state = (await readDrawState(ctx))!;
    expect(state.accounts.find((a) => a.account_id === 'acc_chk')).toMatchObject({
      reach: null,
      excluded: [{ from: daysAgo(400), to: daysAgo(55), why: 'currency', currency: 'EUR' }],
    });
    expect(estimatedLayer()).toBe(before);
    expect(importedHistoryLines(importedHistoryView(state)!, () => 'Checking', (d) => d)).toContain(
      `Checking’s import from ${daysAgo(400)} to ${daysAgo(55)} isn’t used for the chart: some of its transactions are in EUR, not the account’s currency.`
    );
  });

  test('a link, an unlink or a forget runs the backfill again before the drawing; nobody who never imported gets a record', async () => {
    await runBackfill();
    await linksChanged(ctx);
    expect(await isBackfillDone(ctx)).toBe(true);
    expect(await readDrawState(ctx)).toBeNull();
    await importReviewed('acc_chk', ofx([{ fitid: 'A', days: 100, amount: -30, name: 'OLD SHOP' }], { start: 400, end: 55 }));
    const rows = (await readDrawState(ctx))!.rows;
    await linksChanged(ctx);
    expect(await isBackfillDone(ctx)).toBe(false);
    expect((await readDrawState(ctx))!.rows).toBe(rows + 1);
    const ran = await runBackfill();
    expect(ran.from_imports).toBe(341);
    expect(await isBackfillDone(ctx)).toBe(true);
  });
});

describe('the backfill walks imported rows only across covered days', () => {
  /** The checking account's rows reach back 300 days; the card, on a
   *  connection of its own, gives Plaid 40 days. */
  async function twoConnections() {
    await fake.hset(ctxKey('accounts:meta'), {
      item_chase: await encrypt(
        JSON.stringify([{ account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' }])
      ),
      item_card: await encrypt(JSON.stringify([{ account_id: 'acc_card', name: 'Visa', official_name: null, mask: '2222', type: 'credit', subtype: 'credit card', limit: 5000, currency: 'USD' }])),
    });
    await saveItem(ctx, { item_id: 'item_card', institution_name: 'Card Co', encrypted_access_token: await encrypt('access-sandbox-card') });
    plaid.accounts = [account('acc_chk', 'depository', 1000), account('acc_card', 'credit', 1300)];
    await storeBank([bankTxn('b_first', 'acc_chk', 300, 10)], 'item_chase', { acc_chk: CHASE_ACCOUNTS.acc_chk });
    await storeBank([bankTxn('c_buy', 'acc_card', 40, 50)], 'item_card', { acc_card: CHASE_ACCOUNTS.acc_card });
  }

  test('a file a hole cuts off from the card’s own days isn’t walked by the backfill, and the chart says so; imported, the hole joins it up', async () => {
    await twoConnections();
    await runBackfill();
    // A purchase on day 200, in a file ending on day 100: what happened
    // between days 99 and 41 (a 1,000 payment on day 70) neither it nor the
    // bank has.
    const first = await importReviewed('acc_card', ofx([{ fitid: 'P200', days: 200, amount: -500, name: 'BIG PURCHASE' }], { start: 280, end: 100 }, true));
    expect(first.body.history).toMatchObject({ backfill: true });
    await runBackfill();
    let card = await getAccountHistory(ctx, 'acc_card');
    const at = (n: number) => card.find((p) => p.date === daysAgo(n))?.value;
    // Held at what it owed before its own rows begin, never walked across the hole.
    expect([at(50), at(150), at(250)]).toEqual([1250, 1250, 1250]);
    let state = (await readDrawState(ctx))!;
    expect(state.accounts.find((a) => a.account_id === 'acc_card')).toMatchObject({
      reach: null,
      gaps: [{ imported: { from: daysAgo(280), to: daysAgo(100) }, uncovered: { from: daysAgo(99), to: daysAgo(41) } }],
    });
    expect(importedHistoryLines(importedHistoryView(state)!, () => 'Visa', (d) => d)).toEqual([
      `Not drawn: Visa’s import from ${daysAgo(280)} to ${daysAgo(100)}, since nothing covers ${daysAgo(99)} to ${daysAgo(41)}. Import that period to join it up.`,
    ]);

    // The hole imported: walked through, the payment and the purchase both.
    await importReviewed('acc_card', ofx([{ fitid: 'PAY70', days: 70, amount: 1000, name: 'PAYMENT THANK YOU' }], { start: 99, end: 41 }, true));
    await runBackfill();
    card = await getAccountHistory(ctx, 'acc_card');
    expect([at(50), at(150), at(250)]).toEqual([1250, 2250, 1750]);
    state = (await readDrawState(ctx))!;
    expect(state.accounts.find((a) => a.account_id === 'acc_card')).toMatchObject({ reach: daysAgo(281), gaps: [], bank_from: daysAgo(40) });
  });

  test('a file with lines that couldn’t be read joins nothing up unless the person said those lines aren’t transactions', async () => {
    await twoConnections();
    await runBackfill();
    await importReviewed('acc_card', ofx([{ fitid: 'P200', days: 200, amount: -500, name: 'BIG PURCHASE' }], { start: 280, end: 100 }, true));
    const hole = ofx(
      [
        { fitid: 'PAY70', days: 70, amount: 1000, name: 'PAYMENT THANK YOU' },
        { fitid: 'BAD', days: 60, amount: 1234.56, name: 'BROKEN' },
      ],
      { start: 99, end: 41 },
      true
    ).replace('<TRNAMT>1234.56</TRNAMT>', '<TRNAMT>12x4</TRNAMT>');
    const p = await routes.POST(upload({ action: 'preview', account_id: 'acc_card' }, hole));
    const review = (await p.json()).preview.review;
    const res = await routes.POST(upload({ action: 'import', account_id: 'acc_card', review }, hole));
    const { import_id } = await res.json();
    await runBackfill();
    const at = async (n: number) => (await getAccountHistory(ctx, 'acc_card')).find((x) => x.date === daysAgo(n))?.value;
    // Not walked: not the payment in it, nor the purchase it would join up.
    expect([await at(150), await at(250)]).toEqual([1250, 1250]);
    // Said to hold every transaction of its period: walked.
    await undo('acc_card', import_id);
    await routes.POST(upload({ action: 'import', account_id: 'acc_card', review, whole: true }, hole));
    await runBackfill();
    expect([await at(150), await at(250)]).toEqual([2250, 1750]);
  });
});
