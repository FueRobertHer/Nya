import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakeRedis, storageMock, TEST_CTX, registerTestContainer, unscopedDataKeys, testKey } from './fake-redis';
import { ecbHash, ecbTable } from './fx-fixture';
import { parseCsv } from './csv-parse';

// A report with a home currency (lib/report/build.ts): in the home currency
// unless another is asked for, what is in another converted at its own day's
// ECB rate, each total its rows converted, to the cent; the appendix keeps
// each row's own amount and says what it counts as; the report and its file
// say what was converted and the days of the rates; what has no rate is
// named and left out, with why. Without one, exactly as before. The ECB's
// rates of 10 to 14 Sep 2026 (test/fx-fixture.ts): 1 EUR = 1.1616, 1.1592
// and 1.1551 USD, and 0.85598 GBP on the 14th.

process.env.PLAID_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
mock.module('@/lib/plaid', () => ({
  plaidClient: new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error('Plaid must not be called');
      },
    }
  ),
}));
const fake = new FakeRedis({ deserialize: true });
afterEach(() => expect(unscopedDataKeys(fake)).toEqual([]));
mock.module('@/lib/storage', () => storageMock(fake));

const { buildReport } = await import('@/lib/report/build');
const { resolvePeriod } = await import('@/lib/report/period');
const { reportCsv } = await import('@/lib/report/csv');
const { totalsNote } = await import('@/lib/report/words');
const { ReportView } = await import('@/components/ReportView');
const { readReport } = await import('@/lib/report/read');
const { forgetEpochs } = await import('@/lib/sessions');
const { saveManualAccount } = await import('@/lib/manual');
const { addManualTxn, newManualTxn } = await import('@/lib/manual-txns');
const { currencySettingsStore, NO_SETTINGS } = await import('@/lib/fx/settings');
type Txn = import('@/lib/transactions').Txn;
type ReportInput = import('@/lib/report/build').ReportInput;

const NOW = Date.parse('2026-10-10T14:00:00.000Z');
const cents = (n: number) => Math.round(n * 100) / 100;

function row(id: string, date: string, amount: number, over: Partial<Txn> = {}): Txn {
  return {
    transaction_id: id,
    date,
    name: id,
    amount,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Chase',
    category: 'medical',
    iso_currency_code: 'EUR',
    unofficial_currency_code: null,
    vendor_key: id,
    logo_url: null,
    category_icon_url: null,
    subcategory: null,
    category_confidence: null,
    transaction_code: null,
    payment_channel: null,
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: null,
    region: null,
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
    ...over,
  };
}

const p = resolvePeriod({ kind: 'range', start: '2026-09-01', end: '2026-09-30' }, 'UTC', NOW);
if ('error' in p) throw new Error(p.error);
const PERIOD = p;

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  period: PERIOD,
  generatedAt: new Date(NOW).toISOString(),
  rows: ROWS,
  currency: null,
  sources: [],
  notes: [],
  manual: [],
  removed: [],
  removedUnreadable: 0,
  manualUnread: [],
  liveAccounts: [],
  links: new Map(),
  ownRead: { categories: true, names: true, exclusions: true },
  marked: ['medical'],
  markedUnreadable: false,
  hidden: false,
  healthUnread: false,
  ...over,
});

const ROWS: Txn[] = [
  row('pay', '2026-09-10', -3000, { category: 'income' }),
  row('doctor', '2026-09-10', 100),
  // 116.16 USD on the 10th is 100 EUR; 23.18 USD on the 11th, 20 EUR.
  row('pharmacy', '2026-09-10', 116.16, { iso_currency_code: 'USD' }),
  row('dentist', '2026-09-11', 23.18, { iso_currency_code: 'USD' }),
  // 10 GBP on the 14th: 10 / 0.85598 = 11.68 EUR.
  row('optician', '2026-09-14', 10, { iso_currency_code: 'GBP' }),
  // No rate for it, ever.
  row('coin', '2026-09-14', 0.01, { iso_currency_code: null, unofficial_currency_code: 'BTC' }),
];
const FX = ecbTable({ home: 'EUR' });

describe('without a home currency: as before', () => {
  test('in the currency most rows are in, the rest left out and named', () => {
    const r = buildReport(input());
    expect(r.currency).toBe('EUR');
    expect(r.totals.money_out).toBe(100);
    expect(r.totals.left_out.map((l) => l.currency).sort()).toEqual(['BTC', 'GBP', 'USD']);
    expect(r.conversion).toBeUndefined();
    expect(r.home).toBeUndefined();
  });
});

describe('with one', () => {
  const r = buildReport(input({ fx: FX }));

  test('every total is its rows converted at their own day’s rate, to the cent', () => {
    expect(r.currency).toBe('EUR');
    expect(r.home).toBe('EUR');
    // 100 + 100.00 + 20.00 + 11.68
    expect(r.totals.money_out).toBe(cents(100 + 100 + 20 + 11.68));
    expect(r.totals.money_in).toBe(3000);
    expect(r.money_out.find((c) => c.category === 'medical')).toMatchObject({ amount: cents(100 + 100 + 20 + 11.68), transactions: 4 });
    expect(r.months.find((m) => m.month === '2026-09')?.money_out).toBe(cents(100 + 100 + 20 + 11.68));
    expect(r.marked?.money_out).toBe(cents(100 + 100 + 20 + 11.68));
    // Only what has no rate is left out, and why.
    expect(r.totals.left_out).toEqual([{ currency: 'BTC', count: 1 }]);
    expect(totalsNote(r)).toContain('1 transaction in BTC isn’t in these totals, which are in EUR: there is no rate for BTC on those days.'.replace('isn’t', "isn't"));
  });

  test('the appendix keeps each row’s own amount and says what it counts as', () => {
    const pharmacy = r.appendix!.rows.find((x) => x.name === 'pharmacy')!;
    expect(pharmacy).toMatchObject({ amount: 116.16, currency: 'USD', counted_as: 100, not_counted: null });
    expect(r.appendix!.rows.find((x) => x.name === 'doctor')!.counted_as).toBeUndefined();
    expect(r.appendix!.rows.find((x) => x.name === 'coin')).toMatchObject({ not_counted: 'currency' });
  });

  test('the report and its file say what was converted and the days of the rates, never a rate', () => {
    const html = renderToStaticMarkup(<ReportView report={r} />);
    expect(html).toContain('Converted into EUR at each day’s ECB rate, from Sep 10, 2026 to Sep 14, 2026: 2 transactions in USD and 1 in GBP.');
    expect(html).toContain('Counted as −€100.00, at its day’s rate');
    expect(html).not.toContain('named below and left out');
    const csv = parseCsv(reportCsv(r).replace(/^﻿/, ''));
    expect(csv.find((x) => x[0] === 'conversion')).toEqual([
      'conversion',
      'Converted into EUR',
      '',
      '',
      '',
      '',
      '',
      'Converted into EUR at each day’s ECB rate, from 2026-09-10 to 2026-09-14: 2 transactions in USD and 1 in GBP.',
    ]);
  });

  test('another currency asked for: everything else converted into it', () => {
    const usd = buildReport(input({ fx: FX, currency: 'USD' }));
    expect(usd.currency).toBe('USD');
    // 116.16 + 23.18 + 100 × 1.1616 + 10 GBP on the 14th through the euro.
    const gbp = Math.round((10 / 0.85598) * 1.1551 * 100) / 100;
    expect(usd.totals.money_out).toBe(cents(116.16 + 23.18 + 116.16 + gbp));
  });
});

describe('read from storage', () => {
  beforeEach(async () => {
    fake.reset();
    forgetEpochs();
    await registerTestContainer(fake);
    await fake.hset(testKey('fx:ecb'), ecbHash());
    await saveManualAccount(TEST_CTX, { account_id: 'manual_cash', name: 'Wallet', institution_name: 'Cash', type: 'depository', subtype: null, balance: 100, updated_at: '2026-09-01T00:00:00.000Z' });
    const fields = { currency: 'USD', name: 'Pharmacy', category: 'medical', note: null };
    await addManualTxn(TEST_CTX, newManualTxn('manual_cash', { ...fields, amount: 116.16, date: '2026-09-10' }));
    await addManualTxn(TEST_CTX, newManualTxn('manual_cash', { ...fields, amount: 20, currency: 'EUR', date: '2026-09-11' }));
  });

  test('the rates are read with the rows: none without a home currency, converted with one', async () => {
    const before = await readReport(TEST_CTX, PERIOD, { now: NOW });
    expect(before.currency).toBe('EUR');
    expect(before.totals.money_out).toBe(20);
    await currencySettingsStore.set(TEST_CTX, { ...NO_SETTINGS, home: 'EUR' });
    const after = await readReport(TEST_CTX, PERIOD, { now: NOW });
    expect(after.totals.money_out).toBe(cents(20 + 100));
    // Asked for one no row is in: its rates are read too.
    const gbp = await readReport(TEST_CTX, PERIOD, { now: NOW, currency: 'GBP' });
    expect(gbp.currency).toBe('GBP');
    expect(gbp.totals.left_out).toEqual([]);
  });
});
