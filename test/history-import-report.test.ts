import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeRedis, storageMock, TEST_CTX, ctxKey, registerTestContainer, unscopedDataKeys } from './fake-redis';

// Reports (lib/report/) with rows imported into linked accounts from their
// bank's files (#52): counted exactly as the Activity tab counts them, read
// from the period's first day on however far back that is, and where the
// files reach, the bank's own transactions needn't: a period the files cover
// for every bank account and card has no gap, one they cover for some names
// them and how far back each goes, and where the data comes from says so.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

mock.module('@/lib/plaid', () => ({
  plaidClient: {
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
const { readReport } = await import('@/lib/report/read');
const { buildReport } = await import('@/lib/report/build');
const { resolvePeriod } = await import('@/lib/report/period');
const { gapSentences } = await import('@/lib/report/words');
const { reportCsv } = await import('@/lib/report/csv');
const { ReportView } = await import('@/components/ReportView');
const { formatMoney } = await import('@/lib/format');
const { default: MonthBreakdown } = await import('@/components/MonthBreakdown');
const routes = await import('@/app/api/history-import/route');
const transactionsRoute = await import('@/app/api/transactions/route');

const ctx = TEST_CTX;
const DAY = 86_400_000;
const NOW = Date.now();
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString().slice(0, 10);
const day = (d: string) => d;

function bankTxn(id: string, account_id: string, days: number, amount: number, name: string) {
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
    name,
    merchant_name: null,
    merchant_entity_id: null,
    website: null,
    logo_url: null,
    personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE', confidence_level: 'HIGH' },
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
    account_name: account_id === 'acc_chk' ? 'Checking' : 'Visa',
    institution_name: 'Chase',
  };
}

/** The bank's own rows begin 120 days ago, for both accounts. */
const BANK = [bankTxn('b_first', 'acc_chk', 120, 10, 'FIRST ROW'), bankTxn('c_first', 'acc_card', 118, 15, 'CARD SHOP'), bankTxn('b_grocer', 'acc_chk', 3, 20, 'GROCER')];

beforeEach(async () => {
  fake.reset();
  forgetEpochs();
  await registerTestContainer(fake);
  await saveItem(ctx, { item_id: 'item_chase', institution_name: 'Chase', encrypted_access_token: await encrypt(TEST_CTX, 'access-sandbox-chase') });
  await fake.hset(ctxKey('accounts:meta'), {
    item_chase: await encrypt(TEST_CTX, 
      JSON.stringify([
        { account_id: 'acc_chk', name: 'Checking', official_name: null, mask: '1111', type: 'depository', subtype: 'checking', limit: null, currency: 'USD' },
        { account_id: 'acc_card', name: 'Visa', official_name: null, mask: '2222', type: 'credit', subtype: 'credit card', limit: 5000, currency: 'USD' },
      ])
    ),
  });
  await fake.set(
    ctxKey('txns:item_chase'),
    await encodeJsonBlob(TEST_CTX, {
      schema_version: 2,
      cursor: 'c1',
      accounts: {
        acc_chk: { name: 'Checking', official_name: null, type: 'depository', subtype: 'checking', mask: '1111', balances: null },
        acc_card: { name: 'Visa', official_name: null, type: 'credit', subtype: 'credit card', mask: '2222', balances: null },
      },
      txns: Object.fromEntries(BANK.map((t) => [t.transaction_id, t])),
      synced_at: new Date(NOW).toISOString(),
    })
  );
});

const OPTIONS = { csv: { columns: { date: 0, description: 1, amount: 2 }, sign: 'negative-out' } };
function csv(rows: { date: string; name: string; amount: number }[], extra = ''): string {
  return ['Date,Description,Amount', ...rows.map((r) => `${r.date},${r.name},${r.amount.toFixed(2)}`), ...(extra ? [extra] : [])].join('\n');
}
function upload(meta: Record<string, unknown>, file: string): Request {
  const form = new FormData();
  form.set('file', new Blob([new TextEncoder().encode(file) as Uint8Array<ArrayBuffer>]), 'export.csv');
  form.set('meta', JSON.stringify({ file_name: 'export.csv', ...meta }));
  return new Request('http://localhost/api/history-import', { method: 'POST', body: form });
}
/** Imports a bank's CSV into the account, the period it covers said. */
async function importInto(account_id: string, rows: { date: string; name: string; amount: number }[], covers: { from: string; to: string }, extra: Record<string, unknown> = {}, line = '') {
  const meta = { account_id, options: OPTIONS, covers, ...extra };
  const file = csv(rows, line);
  const p = await routes.POST(upload({ action: 'preview', ...meta }, file));
  const preview = (await p.json()).preview;
  const res = await routes.POST(upload({ action: 'import', ...meta, review: preview.review }, file));
  expect(res.status).toBe(200);
  return preview;
}

/** A report on the days from `start` to `end`, in UTC, made now. */
async function report(start: string, end: string) {
  const period = resolvePeriod({ kind: 'range', start, end }, 'UTC', NOW);
  if ('error' in period) throw new Error(period.error);
  return readReport(ctx, period, { now: NOW });
}

/** A whole calendar month `back` months before this one. */
function monthBack(back: number): { start: string; end: string; on: (d: number) => string } {
  const now = new Date(NOW);
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { start: iso(first), end: iso(last), on: (d: number) => iso(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), d))) };
}

describe('imported rows in a report’s totals', () => {
  test('count exactly as on the Activity tab, for a month it shows', async () => {
    const m = monthBack(1);
    await importInto(
      'acc_chk',
      [
        { date: m.on(4), name: 'HARDWARE STORE', amount: -61.25 },
        { date: m.on(9), name: 'CLIENT INVOICE', amount: 1200 },
        { date: m.on(20), name: 'BOOKSHOP', amount: -18.4 },
      ],
      { from: m.start, to: m.end }
    );
    // The Activity tab's rows, from the app's own route, for that month.
    const rows = (await (await transactionsRoute.GET(new Request('http://localhost/api/transactions'))).json()).transactions.filter(
      (t: any) => t.date >= m.start && t.date <= m.end
    );
    expect(rows.filter((t: any) => t.source === 'import:csv')).toHaveLength(3);
    const html = renderToStaticMarkup(createElement(MonthBreakdown, { txns: rows, notes: [], loading: false, onRecategorize: () => {}, onRename: () => {} }));
    const figure = (label: string) => new RegExp(`total-label">${label}</div><div class="summary-value[^"]*">([^<]*)<`).exec(html)?.[1];
    const r = await report(m.start, m.end);
    const money = (n: number) => formatMoney(n, r.currency);
    expect([figure('In'), figure('Out'), figure('Net')]).toEqual([money(r.totals.money_in), money(r.totals.money_out), money(r.totals.net)]);
    expect([r.totals.money_in, r.totals.money_out]).toEqual([1200, 79.65]);
  });

  test('are read from the period’s first day on, however far back: a year the Activity tab no longer shows', async () => {
    const m = monthBack(20);
    await importInto(
      'acc_chk',
      [
        { date: m.on(2), name: 'OLD HARDWARE', amount: -40 },
        { date: m.on(15), name: 'OLD DEPOSIT', amount: 300 },
      ],
      { from: m.start, to: m.end }
    );
    const r = await report(m.start, m.end);
    expect([r.totals.money_in, r.totals.money_out, r.totals.counted]).toEqual([300, 40, 2]);
    expect(r.empty).toBe(false);
  });
});

describe('where the data comes from, counting imported files', () => {
  test('a period the files cover for every bank account and card has no gap; covered for one, the gap names it and how far back it goes', async () => {
    const m = monthBack(8);
    // Before the bank's own: the institution's transactions begin later.
    let r = await report(m.start, m.end);
    expect(r.gaps.filter((g) => g.item_id === 'item_chase')).toEqual([{ kind: 'begins_late', item_id: 'item_chase', institution: 'Chase', first: daysAgo(120), from: 'stored' }]);

    // The checking account's files reach back a year and a half.
    await importInto('acc_chk', [{ date: daysAgo(400), name: 'OLD SHOP', amount: -12 }], { from: daysAgo(540), to: daysAgo(118) });
    r = await report(m.start, m.end);
    const gap = r.gaps.find((g) => g.item_id === 'item_chase')!;
    expect(gap).toEqual({ kind: 'begins_late', item_id: 'item_chase', institution: 'Chase', first: daysAgo(120), from: 'stored', imported: [{ account: 'Checking', from: daysAgo(540) }] });
    expect(gapSentences([gap], day)).toEqual([
      `Chase’s transactions in Nya begin on ${daysAgo(120)} (Checking’s on ${daysAgo(540)}, imported from its files): if its other accounts were open before then, this report is missing their earlier transactions.`,
    ]);
    // Where the data comes from says how far back the checking account's files reach.
    expect(r.institutions.find((i) => i.item_id === 'item_chase')!.imported).toEqual([{ account: 'Checking', from: daysAgo(540) }]);
    const html = renderToStaticMarkup(createElement(ReportView, { report: r }));
    expect(html).toContain('Checking from');
    expect(html).toContain('imported from files');
    expect(reportCsv(r)).toContain(`Checking’s imported from files from ${daysAgo(540)}`);

    // And the card's, a little less far: every account is covered from then.
    await importInto('acc_card', [{ date: daysAgo(300), name: 'OLD CARD SHOP', amount: -9 }], { from: daysAgo(450), to: daysAgo(118) });
    r = await report(daysAgo(500), daysAgo(130));
    expect(r.gaps.find((g) => g.item_id === 'item_chase')).toEqual({
      kind: 'begins_late',
      item_id: 'item_chase',
      institution: 'Chase',
      first: daysAgo(450),
      from: 'stored',
      files: true,
      imported: [{ account: 'Checking', from: daysAgo(540) }],
    });
    expect(gapSentences([r.gaps.find((g) => g.item_id === 'item_chase')!], day)[0]).toContain(`Chase’s transactions in Nya begin, with those imported from its files, on ${daysAgo(450)}`);
    // A period both files cover: nothing missing from Chase.
    r = await report(m.start, m.end);
    expect(r.gaps.filter((g) => g.item_id === 'item_chase')).toEqual([]);
  });

  test('a file with lines that couldn’t be read covers nothing, unless the person said those lines aren’t transactions', async () => {
    const m = monthBack(8);
    const rows = [{ date: daysAgo(400), name: 'OLD SHOP', amount: -12 }];
    const bad = `${daysAgo(300)},BROKEN,not an amount`;
    await importInto('acc_chk', rows, { from: daysAgo(540), to: daysAgo(118) }, {}, bad);
    await importInto('acc_card', [{ date: daysAgo(300), name: 'OLD CARD SHOP', amount: -9 }], { from: daysAgo(450), to: daysAgo(118) });
    let r = await report(m.start, m.end);
    expect(r.gaps.find((g) => g.item_id === 'item_chase')).toMatchObject({ kind: 'begins_late', first: daysAgo(120), imported: [{ account: 'Visa', from: daysAgo(450) }] });
    // Said to hold every transaction of its period: it covers it.
    await importInto('acc_chk', [{ date: daysAgo(401), name: 'OLDER SHOP', amount: -13 }], { from: daysAgo(540), to: daysAgo(118) }, { whole: true }, bad);
    r = await report(m.start, m.end);
    expect(r.gaps.filter((g) => g.item_id === 'item_chase')).toEqual([]);
  });
});

describe('a bank Plaid gives no transactions for, or that never synced', () => {
  const period = (start: string, end: string) => {
    const p = resolvePeriod({ kind: 'range', start, end }, 'UTC', NOW);
    if ('error' in p) throw new Error(p.error);
    return p;
  };
  const source = (over: Record<string, unknown>) => ({
    item_id: 'item_acme',
    institution_name: 'Acme CU',
    institution_id: null,
    coverage: 'complete' as const,
    synced_at: new Date(NOW).toISOString(),
    first_date: null,
    first_seen: null,
    never_synced: false,
    no_transactions: null,
    last_ok_at: null,
    problem: null,
    records_unreadable: false,
    holds: { investment: false, loans: false },
    ...over,
  });
  const built = (s: Record<string, unknown>, p: ReturnType<typeof period>) =>
    buildReport({
      period: p,
      generatedAt: new Date(NOW).toISOString(),
      rows: [],
      currency: null,
      sources: [source(s) as any],
      notes: [],
      manual: [],
      removed: [],
      removedUnreadable: 0,
      manualUnread: [],
      liveAccounts: [],
      links: new Map(),
      ownRead: { categories: true, names: true, exclusions: true },
      marked: null,
      markedUnreadable: false,
      hidden: false,
      healthUnread: false,
    });

  test('is short of nothing in a period files imported into every one of its accounts cover; otherwise it is said as before', () => {
    const p = period(daysAgo(300), daysAgo(200));
    const covered = [{ name: 'Checking', covers: [{ from: daysAgo(400), to: daysAgo(100) }] }];
    expect(built({ no_transactions: 'refused', accounts: covered }, p).gaps).toEqual([]);
    expect(built({ no_transactions: 'no_consent', accounts: covered }, p).gaps).toEqual([]);
    // A second account the files don't cover: still said.
    const partly = [...covered, { name: 'Savings', covers: [] }];
    expect(built({ no_transactions: 'refused', accounts: partly }, p).gaps.map((g) => g.kind)).toEqual(['refused']);
    // Files ending before the period does: still said.
    expect(built({ no_transactions: 'refused', accounts: [{ name: 'Checking', covers: [{ from: daysAgo(400), to: daysAgo(250) }] }] }, p).gaps.map((g) => g.kind)).toEqual([
      'refused',
    ]);
    // Never synced, its history reaching the period: covered, nothing missing.
    expect(built({ coverage: 'missing', never_synced: true, accounts: covered }, p).gaps).toEqual([]);
    expect(built({ coverage: 'missing', never_synced: true, accounts: [] }, p).gaps.map((g) => g.kind)).toEqual(['missing']);
    // Where the data comes from: each account's files, one after another.
    const two = [...covered, { name: 'Savings', covers: [{ from: daysAgo(380), to: daysAgo(100) }] }];
    const html = renderToStaticMarkup(createElement(ReportView, { report: built({ no_transactions: 'refused', accounts: two }, p) }));
    expect(html).toContain(`Checking from`);
    expect(html.replace(/<[^>]+>/g, '')).toMatch(/imported from files; Savings from .*, imported from files/);
    // Synced, with no rows stored, and seen too late for its history to
    // reach the period ("can go back only to"): covered by the files, nothing.
    const seen = daysAgo(100);
    expect(built({ first_seen: seen, accounts: [] }, period(daysAgo(1200), daysAgo(1100))).gaps.map((g) => g.kind)).toEqual(['begins_late']);
    expect(built({ first_seen: seen, accounts: [{ name: 'Checking', covers: [{ from: daysAgo(1300), to: daysAgo(1000) }] }] }, period(daysAgo(1200), daysAgo(1100))).gaps).toEqual([]);
  });

  test('an account that ended (#50) needs the files only up to its end, and one that ended before the period none of it', () => {
    const p = period(daysAgo(300), daysAgo(200));
    const checking = { name: 'Checking', covers: [{ from: daysAgo(400), to: daysAgo(100) }] };
    // Savings closed on day 259: its files reach the day before, so the
    // period is whole; closed on day 240, its days 259 to 241 aren't.
    expect(built({ no_transactions: 'refused', accounts: [checking, { name: 'Savings', covers: [{ from: daysAgo(400), to: daysAgo(260) }], end: daysAgo(259) }] }, p).gaps).toEqual([]);
    expect(
      built({ no_transactions: 'refused', accounts: [checking, { name: 'Savings', covers: [{ from: daysAgo(400), to: daysAgo(260) }], end: daysAgo(240) }] }, p).gaps.map((g) => g.kind)
    ).toEqual(['refused']);
    // Ended before the period: nothing of it is needed, files or none.
    expect(built({ no_transactions: 'refused', accounts: [checking, { name: 'Savings', covers: [], end: daysAgo(350) }] }, p).gaps).toEqual([]);
    // The bank's own begin late (day 250): the files carry Checking back,
    // and Savings needs them only to the day before it closed.
    const late = (end: string | null) =>
      built({ first_date: daysAgo(250), accounts: [checking, { name: 'Savings', covers: [{ from: daysAgo(400), to: daysAgo(270) }], end }] }, p).gaps.map((g) => g.kind);
    expect(late(daysAgo(269))).toEqual([]);
    expect(late(null)).toEqual(['begins_late']);
  });
});
