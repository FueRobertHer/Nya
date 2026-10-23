import { describe, expect, test } from 'bun:test';
import { ecbTable } from './fx-fixture';
import type { Txn } from '@/components/MonthBreakdown';
import { investedAssets, trailingFlows, type AssetAccount, type AssetInstitution } from '@/lib/fire/inputs';
import { assetsLeftOut, convertedNote, fiFigures, spendingLeftOut } from '@/lib/fire/progress';
import { DEFAULT_PLAN, type FirePlan } from '@/lib/fire/plan';
import {
  askText,
  candidates,
  currencyRecord,
  hasTypedAmounts,
  isPlanCurrencyRecord,
  keptText,
  planCurrencyState,
  readCurrencyAnswer,
  recordedCurrency,
  relabelOffer,
  shownReliably,
  typedAmounts,
  type LoadState,
} from '@/lib/fire/plan-currency';
import type { PageFx } from '@/lib/fx/view';

// The currency the Plan's typed figures are in (lib/fire/plan-currency.ts):
// what counts as typed, when a record holds for a plan, when the currency
// the Plan is shown in can be taken for its figures', and the Plan kept in
// its own currency while the accounts' count moves (a tie, a hidden account,
// a balance that reads empty), with what is measured converted into it to
// the cent, the rate named, and what has no rate left out and said. The ECB's
// rates of 14 Sep 2026 (test/fx-fixture.ts): 1 EUR = 1.1551 USD.

const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const TYPED = plan({ age: 40, targetAge: 55, spending: 40_000, savings: 30_000, income: [{ id: 'ss', label: 'Social Security', amount: 20_000, fromAge: 67, inflationAdjusted: true }] });

let seq = 0;
const acct = (over: Partial<AssetAccount> = {}): AssetAccount => ({ account_id: `a${++seq}`, name: 'Account', type: 'investment', balance: 100_000, currency: 'USD', ...over });
const inst = (accounts: AssetAccount[], over: Partial<AssetInstitution> = {}): AssetInstitution => ({ name: 'Broker', item_id: 'item-1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts, ...over });
const LOADED: LoadState = { balancesAsOf: '2026-09-14T12:00:00.000Z', institutions: 1, txnsLoading: false, txnsFailed: false, unread: 0 };

describe('what a record is for', () => {
  test('a plan holds typed amounts once any figure, start balance, part-time income, income or one-off is typed; never for ages and rates alone', () => {
    expect(hasTypedAmounts(DEFAULT_PLAN)).toBe(false);
    expect(hasTypedAmounts(plan({ age: 40, targetAge: 50, withdrawalRate: 0.035, horizon: 40 }))).toBe(false);
    for (const p of [
      plan({ spending: 0 }),
      plan({ savings: -1_000 }),
      plan({ assets: 1 }),
      plan({ startBalance: 500_000 }),
      plan({ partTimeIncome: 12_000 }),
      plan({ expenses: [{ id: 'roof', label: 'Roof', amount: 15_000, atAge: 50 }] }),
      TYPED,
    ]) {
      expect(hasTypedAmounts(p)).toBe(true);
    }
  });

  test('a record holds while the plan’s typed amounts are the ones it was made for, whatever else changed', () => {
    const record = currencyRecord(TYPED, 'USD');
    expect(isPlanCurrencyRecord(record)).toBe(true);
    expect(recordedCurrency(TYPED, record)).toBe('USD');
    // An age or a rate changed since (the release before saves those too): still USD.
    expect(recordedCurrency({ ...TYPED, age: 41, withdrawalRate: 0.035, method: 'monte-carlo' }, record)).toBe('USD');
    // Any amount changed, added or taken away: not known, so the Plan asks.
    for (const changed of [
      { ...TYPED, spending: 45_000 },
      { ...TYPED, savings: null },
      { ...TYPED, startBalance: 1 },
      { ...TYPED, partTimeIncome: 5 },
      { ...TYPED, income: [] },
      { ...TYPED, income: [{ ...TYPED.income[0], amount: 21_000 }] },
      { ...TYPED, expenses: [{ id: 'roof', label: 'Roof', amount: 15_000, atAge: 50 }] },
    ]) {
      expect(recordedCurrency(changed, record)).toBeNull();
    }
    // A label or an age of an item is not an amount.
    expect(recordedCurrency({ ...TYPED, income: [{ ...TYPED.income[0], label: 'SS', fromAge: 70 }] }, record)).toBe('USD');
    // Nothing typed: no currency of its own, whatever a record says.
    expect(recordedCurrency(DEFAULT_PLAN, currencyRecord(DEFAULT_PLAN, 'USD'))).toBeNull();
    expect(recordedCurrency(TYPED, null)).toBeNull();
    expect(recordedCurrency(null, record)).toBeNull();
  });

  test('the stored shape is closed: a later version, a field it doesn’t know or a bad code is not a record', () => {
    const r = currencyRecord(TYPED, 'EUR');
    for (const later of [{ ...r, version: 2 }, { ...r, also: 1 }, { ...r, currency: 'eur' }, { ...r, currency: 'EURO' }, { ...r, amounts: { ...r.amounts, extra: 1 } }, { ...r, amounts: { ...r.amounts, spending: '40000' } }, null, 'EUR']) {
      expect(isPlanCurrencyRecord(later)).toBe(false);
    }
  });

  test('the route’s answer, as the page reads it', () => {
    expect(readCurrencyAnswer({ plan: null, currency: 'USD' })).toEqual({ currency: 'USD', problem: null });
    expect(readCurrencyAnswer({ plan: null, currency: null, currency_problem: 'newer' })).toEqual({ currency: null, problem: 'newer' });
    expect(readCurrencyAnswer({ currency: 'usd', currency_problem: 'odd' })).toEqual({ currency: null, problem: null });
    expect(readCurrencyAnswer(null)).toEqual({ currency: null, problem: null });
  });
});

describe('when the currency the Plan is shown in can be taken for its figures’', () => {
  const inputsOf = (institutions: AssetInstitution[]) => ({ assets: investedAssets(institutions, false), flows: null });

  test('all loaded, no problem, no empty balance, and a clear winner: yes', () => {
    const i = inputsOf([inst([acct(), acct(), acct({ currency: 'EUR' })])]);
    expect(i.assets.currency).toBe('USD');
    expect(shownReliably('USD', i, LOADED)).toEqual({ ok: true });
  });

  test('a tie, a balance that reads empty, a load under way or a problem: no, and why', () => {
    const tie = inputsOf([inst([acct({ currency: 'EUR' }), acct()])]);
    expect(shownReliably(tie.assets.currency, tie, LOADED)).toEqual({ ok: false, why: 'tie' });
    const empty = inputsOf([inst([acct(), acct({ balance: null })])]);
    expect(shownReliably('USD', empty, LOADED)).toEqual({ ok: false, why: 'empty-balance' });
    const one = inputsOf([inst([acct()])]);
    expect(shownReliably('USD', one, { ...LOADED, balancesAsOf: null })).toEqual({ ok: false, why: 'loading' });
    expect(shownReliably('USD', one, { ...LOADED, txnsLoading: true })).toEqual({ ok: false, why: 'loading' });
    expect(shownReliably('USD', one, { ...LOADED, txnsFailed: true })).toEqual({ ok: false, why: 'problem' });
    expect(shownReliably('USD', one, { ...LOADED, unread: 1 })).toEqual({ ok: false, why: 'problem' });
    const failing = inputsOf([inst([acct()], { error: true })]);
    expect(shownReliably('USD', failing, LOADED)).toEqual({ ok: false, why: 'problem' });
    // The dashboard's own currency alone is never enough.
    expect(shownReliably('USD', inputsOf([]), { ...LOADED, institutions: 0 })).toEqual({ ok: false, why: 'none' });
  });
});

describe('the Plan kept in its own currency while the accounts’ count moves', () => {
  // Two brokerages, one in each currency: the order decides the count's tie.
  const usd = acct({ account_id: 'usd', balance: 300_000 });
  const eur = acct({ account_id: 'eur', balance: 250_000, currency: 'EUR' });

  test('without a record, a tie, hiding an account or a balance that reads empty moves the currency (what this fixes)', () => {
    expect(investedAssets([inst([eur, usd])], false).currency).toBe('EUR');
    expect(investedAssets([inst([usd, eur])], false).currency).toBe('USD');
    expect(investedAssets([inst([{ ...usd, hidden: true }, eur, acct()])], false).currency).toBe('EUR');
    expect(investedAssets([inst([{ ...usd, balance: null }, eur])], false).currency).toBe('EUR');
  });

  test('recorded in USD, none of them changes the currency or what the typed figures mean', () => {
    for (const institutions of [[inst([usd, eur])], [inst([eur, usd])], [inst([{ ...usd, hidden: true }, eur])], [inst([{ ...usd, balance: null }, eur])]]) {
      const assets = investedAssets(institutions, false, null, Date.now(), 'USD');
      expect(assets.currency).toBe('USD');
      const figures = fiFigures(TYPED, { flows: null, assets, workplace: null }, 'EUR');
      expect(figures.currency).toBe('USD');
      // 40,000 a year at 4%: the same million dollars in every case.
      expect(figures.view.fiNumber).toBe(1_000_000);
      // Never a euro counted as a dollar: what isn't in USD is left out, named.
      expect(assets.total === null || assets.total === 300_000).toBe(true);
      expect(assets.leftOut).toEqual([{ currency: 'EUR', count: 1 }]);
    }
    expect(assetsLeftOut(investedAssets([inst([usd, eur])], false, null, Date.now(), 'USD'))).toContain('1 account in EUR');
  });

  test('without a home currency, the transactions are counted in the Plan’s currency too, the rest left out and named', () => {
    const t = (over: Partial<Txn>): Txn => ({ transaction_id: `t${++seq}`, date: '2026-09-01', name: 'Shop', amount: 100, pending: false, account_name: 'Checking', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'USD', ...over }) as Txn;
    const rows = [t({ date: '2025-09-15' }), t({}), t({ iso_currency_code: 'EUR' }), t({ iso_currency_code: 'EUR' }), t({ iso_currency_code: 'EUR' })];
    // Most are in EUR: before, the figures were in EUR.
    expect(trailingFlows(rows, '2026-09-14')!.currency).toBe('EUR');
    const kept = trailingFlows(rows, '2026-09-14', { currency: 'USD' })!;
    expect(kept.currency).toBe('USD');
    expect(kept.mostIn).toBe('EUR');
    expect(kept.spending).toBe(200);
    expect(kept.leftOut).toEqual([{ currency: 'EUR', count: 3 }]);
    expect(spendingLeftOut(kept).otherCurrencies).toContain('3 transactions in EUR');
  });
});

describe('with a home currency: what is measured converted into the Plan’s currency, to the cent, the rate named', () => {
  const FX = ecbTable({ home: 'USD' });
  const PAGE: PageFx = { home: 'USD', latest: FX.latest, own: [] };
  const NOW = Date.parse('2026-09-14T18:00:00Z');
  const cents = (n: number) => Math.round(n * 100) / 100;
  const institutions = [inst([acct({ balance: 115_510 }), acct({ balance: 1_000.5 }), acct({ balance: 800, currency: 'EUR' }), acct({ balance: 2, currency: 'BTC' })])];

  test('typed in EUR, with accounts mostly in USD: the dollars converted into euros at the ECB’s newest rate', () => {
    const assets = investedAssets(institutions, false, PAGE, NOW, 'EUR');
    expect(assets.currency).toBe('EUR');
    // 116,510.50 USD ÷ 1.1551 = 100,866.18 EUR, plus 800 EUR.
    expect(assets.total).toBe(cents(116_510.5 / 1.1551 + 800));
    expect(assets.conversion).toEqual({
      into: 'EUR',
      day: '2026-09-14',
      from: [{ currency: 'USD', count: 2 }],
      own: [],
      unrated: [{ currency: 'BTC', why: 'not-published', unrated: 'BTC' }],
    });
    // The rate named, never an amount.
    expect(convertedNote({ flows: null, assets })).toBe("The Plan is in EUR, so what is in other currencies is converted into it: invested assets at the ECB's newest rates (2 accounts in USD).");
    // No rate: left out, and why said.
    expect(assets.leftOut).toEqual([{ currency: 'BTC', count: 1 }]);
    expect(assetsLeftOut(assets)).toBe("1 account in BTC isn't in this figure, which is in EUR: there is no rate for BTC.");
    // And the typed figures are the euros typed: never converted.
    const figures = fiFigures(plan({ spending: 40_000 }), { flows: null, assets, workplace: null }, 'USD');
    expect(figures.currency).toBe('EUR');
    expect(figures.view.fiNumber).toBe(1_000_000);
  });

  test('nothing has a rate: the figure is not counted, and says why, rather than counting it as euros', () => {
    const assets = investedAssets([inst([acct({ balance: 2, currency: 'BTC' })])], false, PAGE, NOW, 'EUR');
    expect(assets.total).toBeNull();
    expect(assetsLeftOut(assets)).toBe("1 account in BTC isn't in this figure, which is in EUR: there is no rate for BTC.");
  });
});

describe('what the tab says', () => {
  const tie = { assets: investedAssets([inst([acct({ currency: 'EUR' }), acct()])], false), flows: null };

  test('the question names what is shown, why it can’t be taken, and the currencies to choose from; never an amount', () => {
    const state = planCurrencyState(TYPED, { currency: null, problem: null }, 'EUR');
    expect(state).toEqual({ kind: 'unknown', shown: 'EUR', problem: null });
    const ask = askText(state as Extract<typeof state, { kind: 'unknown' }>, 'tie');
    expect(ask).toContain('Your plan’s figures were saved before Nya kept the currency they were typed in.');
    expect(ask).toContain('They’re shown in EUR for now, the currency most of your accounts are in, but as many of your invested accounts are in another currency');
    expect(ask).toContain('Nothing on the Plan can be saved until you say');
    expect(ask).not.toMatch(/\d/);
    expect(candidates('EUR', tie)).toEqual(['EUR', 'USD']);
    // A record that can't be read, or a newer version's.
    expect(askText({ kind: 'unknown', shown: 'USD', problem: 'unreadable' }, null)).toStartWith('The record of the currency your plan’s figures are in couldn’t be read.');
    expect(askText({ kind: 'unknown', shown: 'USD', problem: 'newer' }, null)).toContain('recorded by a newer version of Nya');
  });

  test('recorded, nothing typed, or not known', () => {
    expect(planCurrencyState(TYPED, { currency: 'USD', problem: null }, 'USD')).toEqual({ kind: 'recorded', currency: 'USD' });
    expect(planCurrencyState(DEFAULT_PLAN, { currency: null, problem: null }, 'EUR')).toEqual({ kind: 'follows', currency: 'EUR' });
    expect(planCurrencyState(null, { currency: null, problem: null }, 'EUR')).toEqual({ kind: 'follows', currency: 'EUR' });
    expect(planCurrencyState(TYPED, { currency: null, problem: 'newer' }, 'USD')).toEqual({ kind: 'unknown', shown: 'USD', problem: 'newer' });
  });

  test('kept in its currency, the tab says so when what is measured is in another: converted, or, without a home currency, not counted', () => {
    const eurAccounts = { assets: investedAssets([inst([acct({ currency: 'EUR' })])], false, null, Date.now(), 'USD'), flows: null };
    expect(keptText('USD', eurAccounts, true)).toBe('Your plan’s figures are in USD, the currency they were typed in, and stay in it. Your accounts are in EUR: what is in EUR is converted into USD (below).');
    expect(keptText('USD', eurAccounts, false)).toContain('Your accounts are in EUR: without a home currency nothing is converted, so what is in EUR isn’t counted (below).');
    expect(relabelOffer('USD', eurAccounts)).toBe('EUR');
    // Mostly in its own currency, as before: nothing more to say, and nothing to offer.
    const usdAccounts = { assets: investedAssets([inst([acct(), acct(), acct({ currency: 'EUR' })])], false, null, Date.now(), 'USD'), flows: null };
    expect(keptText('USD', usdAccounts, false)).toBeNull();
    expect(relabelOffer('USD', usdAccounts)).toBeNull();
    // A tie with one other: some are in it, and both are in sight.
    const tied = { assets: investedAssets([inst([acct({ currency: 'EUR' }), acct()])], false, null, Date.now(), 'USD'), flows: null };
    expect(keptText('USD', tied, true)).toBe('Your plan’s figures are in USD, the currency they were typed in, and stay in it. Some of your accounts are in EUR: what is in EUR is converted into USD (below).');
    expect(relabelOffer('USD', tied)).toBeNull();
  });

  test('a record’s amounts are the plan’s own, as typed', () => {
    expect(typedAmounts(TYPED)).toEqual({ spending: 40_000, savings: 30_000, assets: null, startBalance: null, partTimeIncome: 0, income: [{ id: 'ss', amount: 20_000 }], expenses: [] });
  });
});

describe('Home’s FI card', () => {
  test('says when the currency its figures are shown in is not yet known to be the one they were typed in', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    const { FiProgressView } = await import('@/components/FiProgressCard');
    const { transactionCoverage } = await import('@/lib/fire/progress');
    const { NO_CONNECTIONS_WITHOUT } = await import('@/lib/no-transactions');
    const assets = investedAssets([inst([acct({ currency: 'EUR' }), acct()])], false);
    const inputs = { flows: null, assets, workplace: null, unread: [], coverage: transactionCoverage(NO_CONNECTIONS_WITHOUT, 0) };
    const view = (unconfirmed: boolean) =>
      renderToStaticMarkup(React.createElement(FiProgressView, { figures: fiFigures(TYPED, inputs, null), unconfirmed, plan: TYPED, saved: true, repaired: false, inputs, onOpenPlan: () => {} }));
    expect(view(true)).toContain('Shown in EUR, the currency most of your accounts are in: which one your plan’s figures were typed in isn’t known yet. Opening the Plan tab settles it.');
    expect(view(false)).not.toContain('isn’t known yet');
  });
});
