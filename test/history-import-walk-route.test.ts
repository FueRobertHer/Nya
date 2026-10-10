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
const { saveItem } = await import('@/lib/storage');
const { forgetEpochs } = await import('@/lib/sessions');
const { getHistory, getAccountHistory, isBackfillDone } = await import('@/lib/history');
const { writeCache, CacheKey } = await import('@/lib/cache');
const { readDrawState } = await import('@/lib/history-import/extend');
const backfill = await import('@/app/api/backfill/route');
const routes = await import('@/app/api/history-import/route');
const netWorth = await import('@/app/api/net-worth/route');

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
function ofx(trns: { fitid: string; days: number; amount: number; name: string }[], period: { start: number; end: number }, card = false) {
  const list = trns
    .map((t) => `<STMTTRN><TRNTYPE>${t.amount < 0 ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${compact(daysAgo(t.days))}</DTPOSTED><TRNAMT>${t.amount.toFixed(2)}</TRNAMT><FITID>${t.fitid}</FITID><NAME>${t.name}</NAME></STMTTRN>`)
    .join('');
  const from = card ? '<CCACCTFROM><ACCTID>4111</ACCTID></CCACCTFROM>' : '<BANKACCTFROM><BANKID>1</BANKID><ACCTID>9</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>';
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
  const txns = [bankTxn('b_first', 'acc_chk', 60, 10), bankTxn('b_mid', 'acc_chk', 30, -200), bankTxn('c_buy', 'acc_card', 40, 50)];
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob({
      schema_version: 2,
      cursor: 'c1',
      accounts: {
        acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
        acc_card: { name: 'Visa', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: null },
        acc_loan: { name: 'Car loan', official_name: null, type: 'loan', subtype: 'auto', mask: '3333', balances: null },
      },
      txns: Object.fromEntries(txns.map((t) => [t.transaction_id, t])),
      synced_at: new Date().toISOString(),
    })
  );
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
    expect(imported.body.history).toEqual({ drawn: true, from: daysAgo(401) });
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
    expect(early.body.history).toEqual({ drawn: true, from: null });
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
    expect(nw.imported_history).toMatchObject({ until: daysAgo(60), from: daysAgo(401), accounts: ['acc_chk'], gaps: [{ account_id: 'acc_chk' }] });
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
    const { body } = await importReviewed('acc_loan', ofx([{ fitid: 'P', days: 100, amount: -400, name: 'LOAN PAYMENT' }], { start: 300, end: 55 }));
    expect(body.imported).toBe(1);
    expect(estimatedLayer()).toBe(before);
  });

  test('imported before the backfill has run, it waits for it, and the backfill draws it', async () => {
    const real = realLayer();
    const { body } = await importReviewed('acc_chk', ofx([{ fitid: 'A', days: 100, amount: -30, name: 'OLD SHOP' }], { start: 400, end: 55 }));
    expect(body.history).toEqual({ drawn: false, from: null });
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
