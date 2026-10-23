import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ecbTable } from './fx-fixture';
import { FiProgressView } from '@/components/FiProgressCard';
import { AllocationNotes } from '@/components/AllocationCard';
import { allocate, inputsIn, planMix } from '@/lib/allocation/allocation';
import { mixLeftOutText } from '@/components/allocation-text';
import { transactionCoverage } from '@/lib/fire/progress';
import { NO_CONNECTIONS_WITHOUT } from '@/lib/no-transactions';
import type { Txn } from '@/components/MonthBreakdown';
import { investedAssets, trailingFlows, type AssetAccount, type AssetInstitution } from '@/lib/fire/inputs';
import { assetsLeftOut, convertedNote, currencyNote, fiFigures, planCurrency, spendingLeftOut } from '@/lib/fire/progress';
import { DEFAULT_PLAN } from '@/lib/fire/plan';
import type { PageFx } from '@/lib/fx/view';

// The Plan with a home currency (lib/fire/inputs.ts, lib/fire/progress.ts):
// it keeps its currency, its accounts' main one, which what the person types
// is in, and converts what is in other currencies into it: a year of flows
// at each day's rate, invested assets at the newest rates, each currency's
// subtotal once. Every figure is its rows converted, to the cent; what has
// no rate is left out and named, with why. The ECB's rates of 10 to 14 Sep
// 2026 (test/fx-fixture.ts): 1 EUR = 1.1616, 1.1592 and 1.1551 USD.

let seq = 0;
function txn(over: Partial<Txn>): Txn {
  return {
    transaction_id: `t${++seq}`,
    date: '2026-09-14',
    name: 'Shop',
    amount: 10,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Bank',
    category: 'food and drink',
    iso_currency_code: 'USD',
    vendor_key: 'shop',
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

const TODAY = '2026-09-14';
const YEAR_AGO = '2025-09-15'; // the first of the 365 days ending today: no scaling
const ROWS = [
  txn({ date: YEAR_AGO, amount: 1_000 }),
  txn({ date: '2026-09-01', amount: 20 }),
  txn({ date: '2026-09-02', amount: 30 }),
  txn({ date: '2026-09-10', amount: -6_000, category: 'income' }),
  // In euros: 100 × 1.1592 and 50 × 1.1551 USD; pay 2,000 × 1.1616.
  txn({ date: '2026-09-11', amount: 100, iso_currency_code: 'EUR' }),
  txn({ date: '2026-09-14', amount: 50, iso_currency_code: 'EUR' }),
  txn({ date: '2026-09-10', amount: -2_000, category: 'income', iso_currency_code: 'EUR' }),
  // No rate for it, ever: left out, named, with why.
  txn({ date: '2026-09-14', amount: 0.01, iso_currency_code: null, unofficial_currency_code: 'BTC' } as Partial<Txn>),
];

const acct = (over: Partial<AssetAccount> = {}): AssetAccount => ({
  account_id: `a${++seq}`,
  name: 'Account',
  type: 'investment',
  balance: 1_000,
  currency: 'USD',
  ...over,
});
const inst = (accounts: AssetAccount[]): AssetInstitution => ({ name: 'Broker', item_id: 'item-1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts });
const INSTITUTIONS = [
  inst([acct({ balance: 100_000 }), acct({ balance: 20_000 }), acct({ balance: 500, currency: 'EUR' }), acct({ balance: 300, currency: 'EUR' }), acct({ balance: 2, currency: 'BTC' })]),
];

const FX = { ...ecbTable({ home: 'EUR' }), fetch: { at: '2026-09-14T16:30:00.000Z', ok: true, newest: '2026-09-14', last_ok: '2026-09-14T16:30:00.000Z' } };
const PAGE: PageFx = { home: 'EUR', latest: FX.latest, own: [] };
const NOW = Date.parse('2026-09-14T18:00:00Z');
const cents = (n: number) => Math.round(n * 100) / 100;

describe('without a home currency: as before', () => {
  test('each figure in the currency most of it is in, the rest left out and named, nothing converted', () => {
    const flows = trailingFlows(ROWS, TODAY)!;
    expect(flows.currency).toBe('USD');
    expect(flows.spending).toBe(1_050);
    expect(flows.income).toBe(6_000);
    expect(flows.leftOut).toEqual([
      { currency: 'EUR', count: 3 },
      { currency: 'BTC', count: 1 },
    ]);
    expect(flows.conversion).toBeNull();
    const assets = investedAssets(INSTITUTIONS, false);
    expect(assets.total).toBe(120_000);
    expect(assets.conversion).toBeNull();
    expect(convertedNote({ flows, assets })).toBeNull();
  });
});

describe('with one: into the Plan’s currency, never relabelled', () => {
  const assets = investedAssets(INSTITUTIONS, false, PAGE, NOW);
  const flows = trailingFlows(ROWS, TODAY, { fx: FX, into: assets.currency })!;

  test('invested assets: each currency’s subtotal converted once at the newest rates, to the cent', () => {
    expect(assets.currency).toBe('USD');
    // 120,000 + 800 × 1.1551 = 120,924.08
    expect(assets.total).toBe(cents(120_000 + 800 * 1.1551));
    expect(assets.accounts.map((a) => a.balance)).toEqual([100_000, 20_000, 500, 300]);
    // Listed in its own currency.
    expect(assets.accounts.map((a) => a.currency)).toEqual(['USD', 'USD', 'EUR', 'EUR']);
    expect(assets.leftOut).toEqual([{ currency: 'BTC', count: 1 }]);
    expect(assets.conversion).toEqual({
      into: 'USD',
      day: '2026-09-14',
      from: [{ currency: 'EUR', count: 2 }],
      own: [],
      unrated: [{ currency: 'BTC', why: 'not-published', unrated: 'BTC' }],
    });
    expect(assetsLeftOut(assets)).toBe("1 account in BTC isn't in this figure, which is in USD: there is no rate for BTC.");
  });

  test('the year’s flows: each row at its own day’s rate into the Plan’s currency, every figure its rows converted, to the cent', () => {
    expect(flows.currency).toBe('USD');
    expect(flows.scaled).toBe(false);
    // 1,050 + 100 × 1.1592 + 50 × 1.1551
    expect(cents(flows.spending)).toBe(cents(1_050 + 115.92 + 57.76));
    // 6,000 + 2,000 × 1.1616
    expect(cents(flows.income)).toBe(cents(6_000 + 2_323.2));
    expect(cents(flows.savings)).toBe(cents(flows.income - flows.spending));
    expect(flows.leftOut).toEqual([{ currency: 'BTC', count: 1 }]);
    expect(flows.conversion?.from).toEqual([{ currency: 'EUR', count: 3 }]);
    expect(spendingLeftOut(flows).otherCurrencies).toStartWith("1 transaction in BTC isn't in your spending or savings, which are in USD: ");
  });

  test('the two compare: no "can’t be compared", and a note of what was converted, never an amount', () => {
    expect(currencyNote({ flows, assets })).toBeNull();
    expect(convertedNote({ flows, assets })).toBe(
      "The Plan is in USD, so what is in other currencies is converted into it: spending and income at each day's ECB rate (3 transactions in EUR) and invested assets at the ECB's newest rates (2 accounts in EUR)."
    );
    const figures = fiFigures(DEFAULT_PLAN, { flows, assets, workplace: null }, 'USD');
    expect(figures.currency).toBe('USD');
    // The FI number is the converted spending's, to the cent: 1,223.68 / 4%.
    expect(cents(figures.view.fiNumber!)).toBe(cents((1_050 + 115.92 + 57.76) / 0.04));
    expect(figures.view.assets.value).toBe(cents(120_000 + 800 * 1.1551));
  });

  test('a home currency doesn’t move the Plan’s currency: what is typed keeps its label', () => {
    const before = planCurrency({ flows: trailingFlows(ROWS, TODAY), assets: investedAssets(INSTITUTIONS, false) }, null);
    expect(planCurrency({ flows, assets }, null)).toBe(before);
  });

  test('Home’s FI card says what was converted, and the FI number is in the Plan’s currency', () => {
    const inputs = { flows, assets, workplace: null, unread: [], coverage: transactionCoverage(NO_CONNECTIONS_WITHOUT, ROWS.length) };
    const html = renderToStaticMarkup(
      <FiProgressView figures={fiFigures(DEFAULT_PLAN, inputs, 'USD')} plan={DEFAULT_PLAN} saved={false} repaired={false} inputs={inputs} onOpenPlan={() => {}} />
    ).replace(/&#x27;|&#39;/g, "'");
    expect(html).toContain('$30,592'); // 1,223.68 / 4%, whole
    expect(html).toContain("The Plan is in USD, so what is in other currencies is converted into it");
    expect(html).not.toContain("can't be compared");
  });

  test('into the Plan’s currency even when no row is in it', () => {
    const euros = ROWS.filter((r) => r.iso_currency_code === 'EUR').concat(txn({ date: YEAR_AGO, amount: 10, iso_currency_code: 'EUR' }));
    // A year ago has no rate in the fixture's cut: named, why said.
    const f = trailingFlows(euros, TODAY, { fx: FX, into: 'USD' })!;
    expect(f.currency).toBe('USD');
    expect(cents(f.spending)).toBe(cents(115.92 + 57.76));
    expect(f.leftOut).toEqual([{ currency: 'EUR', count: 1 }]);
  });
});

describe('the allocation with one: each balance and position converted at the newest rates', () => {
  const institutions = [
    inst([
      acct({ account_id: 'usd', balance: 1_000 }),
      acct({ account_id: 'eur', balance: 500, currency: 'EUR' }),
      acct({ account_id: 'btc', balance: 2, currency: 'BTC' }),
    ]),
  ];
  const holdings = [
    { account_id: 'usd', ticker: 'VTI', name: 'Total Stock Market', security_type: 'etf', value: 1_000, currency: 'USD' },
    // The account's currency, said by none.
    { account_id: 'eur', ticker: 'VWCE', name: 'All-World', security_type: 'etf', value: 300 },
    { account_id: 'eur', ticker: 'VGEA', name: 'Euro Gov Bonds', security_type: 'etf', value: 200 },
    { account_id: 'btc', ticker: 'BTC', name: 'Bitcoin', security_type: 'cryptocurrency', value: 2 },
  ];

  test('without one, as before: the other currencies left out and named', () => {
    const a = allocate({ ...inputsIn(institutions, holdings, null, 'USD'), settings: null, currency: 'USD' });
    expect(a.total).toBe(1_000);
    expect(a.otherCurrencies).toEqual([
      { currency: 'BTC', amount: 2 },
      { currency: 'EUR', amount: 500 },
    ]);
  });

  test('with one: its total its rows converted, to the cent; what has no rate still left out and named', () => {
    const i = inputsIn(institutions, holdings, PAGE, 'USD', NOW);
    const a = { ...allocate({ institutions: i.institutions, holdings: i.holdings, settings: null, currency: 'USD' }), converted: i.converted, converting: true };
    // 300 × 1.1551 + 200 × 1.1551, each rounded once: 346.53 + 231.02.
    expect(i.holdings.filter((h) => h.account_id === 'eur').map((h) => [h.value, h.currency])).toEqual([
      [346.53, 'USD'],
      [231.02, 'USD'],
    ]);
    expect(cents(a.total)).toBe(cents(1_000 + 346.53 + 231.02));
    expect(a.otherCurrencies).toEqual([{ currency: 'BTC', amount: 2 }]);
    expect(i.converted).toEqual({ into: 'USD', from: ['EUR'], own: [] });
    const html = renderToStaticMarkup(<AllocationNotes alloc={a} money={(n) => `$${n}`} />);
    expect(html).toContain('What is in EUR is converted into USD at the ECB’s newest rates, each balance and position on its own.');
    expect(html).toContain('There is no rate to convert it at.');
    expect(mixLeftOutText(planMix(a), 'USD')).toContain('there is no rate to convert it at');
  });
});
