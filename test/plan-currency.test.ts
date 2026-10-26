import { describe, expect, test } from 'bun:test';
import { ecbTable } from './fx-fixture';
import type { Txn } from '@/components/MonthBreakdown';
import { investedAssets, trailingFlows, type AssetAccount, type AssetInstitution } from '@/lib/fire/inputs';
import { assetsGap, assetsLeftOut, convertedNote, fiFigures, gapText, notWorkedOutText, spendingGap, spendingLeftOut, spendingOff } from '@/lib/fire/progress';
import { DEFAULT_PLAN, type FirePlan } from '@/lib/fire/plan';
import {
  askText,
  candidates,
  currencyRecord,
  hasTypedAmounts,
  isPlanCurrencyRecord,
  keptText,
  planCurrencyState,
  firstText,
  readCurrencyAnswer,
  recordedCurrency,
  relabelOffer,
  shownFrom,
  unconfirmedText,
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
const LOADED: LoadState = { balancesAsOf: '2026-09-14T12:00:00.000Z', balancesSaved: false, institutions: 1, txnsLoading: false, txnsFailed: false, unread: 0 };

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
    expect(readCurrencyAnswer({ plan: null, currency: 'USD' })).toEqual({ currency: 'USD', problem: null, was: null });
    expect(readCurrencyAnswer({ plan: null, currency: null, currency_problem: 'newer' })).toEqual({ currency: null, problem: 'newer', was: null });
    // A record of other amounts: which currency it said, to offer first.
    expect(readCurrencyAnswer({ plan: null, currency: null, currency_problem: 'stale', currency_was: 'USD' })).toEqual({ currency: null, problem: 'stale', was: 'USD' });
    expect(readCurrencyAnswer({ currency: 'usd', currency_problem: 'odd', currency_was: 'USD' })).toEqual({ currency: null, problem: null, was: null });
    expect(readCurrencyAnswer(null)).toEqual({ currency: null, problem: null, was: null });
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
    const state = planCurrencyState(TYPED, { currency: null, problem: null, was: null }, 'EUR');
    expect(state).toEqual({ kind: 'unknown', shown: 'EUR', problem: null, was: null });
    const ask = askText(state as Extract<typeof state, { kind: 'unknown' }>, 'tie', 'accounts');
    expect(ask).toContain('Your plan’s figures were saved before Nya kept the currency they were typed in.');
    expect(ask).toContain('They’re shown in EUR for now, the currency most of your invested accounts are in, but as many of your invested accounts are in another currency');
    expect(ask).toContain('Nothing on the Plan can be saved until you say');
    expect(ask).not.toMatch(/\d/);
    expect(candidates('EUR', tie)).toEqual(['EUR', 'USD']);
    // A record that no longer fits: said as that, its currency offered first.
    const stale = askText({ kind: 'unknown', shown: 'EUR', problem: 'stale', was: 'USD' }, null, 'accounts');
    expect(stale).toStartWith('Nya recorded your plan’s figures as USD, but they were changed since in a way that didn’t record a currency');
    expect(stale).not.toContain('saved before Nya kept');
    expect(candidates('EUR', tie, { was: 'USD' })).toEqual(['USD', 'EUR']);
    // A record that can't be read, or a newer version's.
    expect(askText({ kind: 'unknown', shown: 'USD', problem: 'unreadable', was: null }, null, 'accounts')).toStartWith('The record of the currency your plan’s figures are in couldn’t be read.');
    expect(askText({ kind: 'unknown', shown: 'USD', problem: 'newer', was: null }, null, 'accounts')).toContain('recorded by a newer version of Nya');
    // Where the shown currency came from, as it is: never "your accounts" for the dashboard's, and nothing shown when there is none.
    expect(askText({ kind: 'unknown', shown: 'USD', problem: null, was: null }, 'none', 'dashboard')).toContain('They’re shown in USD for now, your accounts’ main currency, but there are no accounts or transactions to tell it from.');
    expect(askText({ kind: 'unknown', shown: null, problem: null, was: null }, 'none', null)).not.toContain('shown in');
    // Before a first amount.
    expect(firstText('EUR', 'tie', 'accounts')).toStartWith('Which currency will you type your plan’s figures in?');
  });

  test('recorded, nothing typed, or not known', () => {
    expect(planCurrencyState(TYPED, { currency: 'USD', problem: null, was: null }, 'USD')).toEqual({ kind: 'recorded', currency: 'USD' });
    expect(planCurrencyState(DEFAULT_PLAN, { currency: null, problem: null, was: null }, 'EUR')).toEqual({ kind: 'follows', currency: 'EUR' });
    expect(planCurrencyState(null, { currency: null, problem: null, was: null }, 'EUR')).toEqual({ kind: 'follows', currency: 'EUR' });
    expect(planCurrencyState(TYPED, { currency: null, problem: 'newer', was: null }, 'USD')).toEqual({ kind: 'unknown', shown: 'USD', problem: 'newer', was: null });
    expect(planCurrencyState(TYPED, { currency: null, problem: 'stale', was: 'USD' }, 'EUR')).toEqual({ kind: 'unknown', shown: 'EUR', problem: 'stale', was: 'USD' });
  });

  test('kept in its currency, the tab says so when what is measured is in another: converted, or, without a home currency, not counted', () => {
    const eurAccounts = { assets: investedAssets([inst([acct({ currency: 'EUR' })])], false, null, Date.now(), 'USD'), flows: null };
    expect(keptText('USD', eurAccounts, true)).toBe('Your plan’s figures are in USD, the currency they were typed in, and stay in it. Your accounts are in EUR: what is in EUR is converted into USD (on Your path).');
    expect(keptText('USD', eurAccounts, false)).toContain('Your accounts are in EUR: without a home currency nothing is converted, so what is in EUR isn’t counted (on Your path).');
    expect(relabelOffer('USD', eurAccounts)).toBe('EUR');
    // Mostly in its own currency, as before: nothing more to say, and nothing to offer.
    const usdAccounts = { assets: investedAssets([inst([acct(), acct(), acct({ currency: 'EUR' })])], false, null, Date.now(), 'USD'), flows: null };
    expect(keptText('USD', usdAccounts, false)).toBeNull();
    expect(relabelOffer('USD', usdAccounts)).toBeNull();
    // A tie with one other: some are in it, and both are in sight.
    const tied = { assets: investedAssets([inst([acct({ currency: 'EUR' }), acct()])], false, null, Date.now(), 'USD'), flows: null };
    expect(keptText('USD', tied, true)).toBe('Your plan’s figures are in USD, the currency they were typed in, and stay in it. Some of your accounts are in EUR: what is in EUR is converted into USD (on Your path).');
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
    const view = (unconfirmed: string | null) =>
      renderToStaticMarkup(React.createElement(FiProgressView, { figures: fiFigures(TYPED, inputs, null), unconfirmed, plan: TYPED, saved: true, repaired: false, inputs, onOpenPlan: () => {} }));
    const said = unconfirmedText('EUR', shownFrom('EUR', inputs));
    expect(said).toBe('Shown in EUR, the currency most of your invested accounts are in: which currency your plan’s figures were typed in isn’t known yet. The Plan tab settles it, or asks you.');
    expect(view(said)).toContain(said);
    expect(view(null)).not.toContain('isn’t known yet');
  });
});

describe('the assets sheet', () => {
  test('lists each account counted in its own currency, never in the Plan’s label', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    const { FigureForm } = await import('@/components/PlanForms');
    const FX = ecbTable({ home: 'USD' });
    const PAGE: PageFx = { home: 'USD', latest: FX.latest, own: [] };
    const institutions = [inst([acct({ name: 'Brokerage', balance: 100_000 }), acct({ name: 'Depot', balance: 800, currency: 'EUR' })])];
    const assetsFor = (includeCash: boolean) => investedAssets(institutions, includeCash, PAGE, Date.parse('2026-09-14T18:00:00Z'), 'USD');
    const html = renderToStaticMarkup(
      React.createElement(FigureForm, { plan: plan(), onSave: async () => true, onDone: () => {}, editable: true, kind: 'assets', measured: assetsFor(false).total, measuredText: '', currency: 'USD', assetsFor })
    );
    expect(html).toContain('$100,000');
    expect(html).toContain('€800');
    expect(html).not.toContain('$800');
  });
});

describe('never from the dashboard’s saved copy, nor where most of the spending is elsewhere', () => {
  const usdBroker = [inst([acct()])];
  const t = (over: Partial<Txn>): Txn => ({ transaction_id: `t${++seq}`, date: '2026-09-01', name: 'Shop', amount: 100, pending: false, account_name: 'Checking', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'EUR', ...over }) as Txn;

  test('the saved copy of the balances is still loading, whatever its date', () => {
    const i = { assets: investedAssets(usdBroker, false), flows: null };
    expect(shownReliably('USD', i, LOADED)).toEqual({ ok: true });
    expect(shownReliably('USD', i, { ...LOADED, balancesSaved: true })).toEqual({ ok: false, why: 'loading' });
  });

  test('a USD brokerage with the spending in EUR: not taken, so the tab asks', () => {
    const rows = [t({ date: '2025-09-20' }), t({}), t({ iso_currency_code: 'USD' })];
    const i = { assets: investedAssets(usdBroker, false), flows: trailingFlows(rows, '2026-09-14') };
    expect(i.flows!.mostIn).toBe('EUR');
    expect(shownReliably('USD', i, LOADED)).toEqual({ ok: false, why: 'spending' });
  });
});

describe('without a home currency, no figure from a part of what it measures', () => {
  // The review's probe: a USD brokerage, and a year of spending all but
  // three rows in EUR (test/zz-probe-spend.test.ts in its clone).
  let n = 0;
  const t = (over: Partial<Txn>): Txn => ({ transaction_id: `s${++n}`, date: '2026-09-01', name: 'Shop', amount: 100, pending: false, account_name: 'Checking', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'EUR', ...over }) as Txn;
  const rows: Txn[] = [t({ date: '2025-09-20', iso_currency_code: 'USD' })];
  for (let m = 0; m < 12; m++) for (let k = 0; k < 30; k++) rows.push(t({ date: `2026-${String(((m + 9) % 12) + 1).padStart(2, '0')}-0${(k % 9) + 1}`.replace(/^2026-(10|11|12)/, '2025-$1') }));
  rows.push(t({ iso_currency_code: 'USD' }), t({ iso_currency_code: 'USD', date: '2026-05-05' }));
  const broker = [inst([acct({ balance: 500_000 })])];
  const typed = plan({ partTimeIncome: 10_000 });

  test('recorded in USD: spending isn’t measured from the three dollar rows, so no FI number, progress, years or savings rate rests on them, and it says why', () => {
    const assets = investedAssets(broker, false, null, Date.now(), 'USD');
    const flows = trailingFlows(rows, '2026-09-14', { currency: 'USD' })!;
    expect(flows.count).toBe(3);
    expect(spendingGap(flows)).toEqual({ what: 'spending', counted: 3, leftOut: [{ currency: 'EUR', count: 360 }], into: 'USD', judged: 'count', unrated: [], ratesAtHand: false, sides: ['spending'] });
    const f = fiFigures(typed, { flows, assets, workplace: null }, 'USD');
    expect(f.view.spending.value).toBeNull();
    expect(f.view.fiNumber).toBeNull();
    expect(f.view.progress).toBeNull();
    expect(f.view.yearsToFi).toBeNull();
    expect(f.savingsRate).toBeNull();
    expect(gapText(spendingGap(flows)!)).toBe(
      'Not measured: more than a tenth of the year’s spending, by count, as Nya doesn’t have the ECB’s rates at hand, is in another currency than the Plan’s, USD (360 transactions in EUR this year). Without a home currency nothing is converted, so a figure from the rest would leave that much of your spending out. Choose a home currency on the Currency card in Settings, Preferences to convert them, or type your spending.'
    );
    // Typed, the figure is the person's own, and the FI number is back.
    expect(fiFigures({ ...typed, spending: 36_500 }, { flows, assets, workplace: null }, 'USD').view.fiNumber).toBe(912_500);
  });

  test('not recorded: the euros are most of it, so they are counted and the dollars named, as before, with the can’t-be-compared note', () => {
    const assets = investedAssets(broker, false);
    const flows = trailingFlows(rows, '2026-09-14', { into: assets.currency })!;
    expect(flows.currency).toBe('EUR');
    expect(spendingGap(flows)).toBeNull();
    const f = fiFigures(typed, { flows, assets, workplace: null }, 'USD');
    expect(f.view.spending.value).toBe(36_500);
    expect(f.currencyNote).toContain('Your investments are in USD and your spending in EUR');
  });

  test('a tenth is the line: exactly a tenth left out is measured from the rest, more is not', () => {
    const tenth = [...Array.from({ length: 9 }, () => t({ iso_currency_code: 'USD' })), t({})];
    expect(spendingGap(trailingFlows([t({ date: '2025-09-20', iso_currency_code: 'USD' }), ...tenth.slice(1)], '2026-09-14', { currency: 'USD' }))).toBeNull();
    expect(spendingGap(trailingFlows([t({ date: '2025-09-20', iso_currency_code: 'USD' }), ...tenth.slice(2), t({})], '2026-09-14', { currency: 'USD' }))).not.toBeNull();
  });

  test('invested assets the same, by account: said as “they’re in USD” with three accounts in EUR and one small one in dollars', () => {
    const accounts = [inst([acct({ currency: 'EUR' }), acct({ currency: 'EUR' }), acct({ currency: 'EUR' }), acct({ balance: 1_000 })])];
    const assets = investedAssets(accounts, false, null, Date.now(), 'USD');
    expect(assetsGap(assets)).toEqual({ what: 'assets', counted: 1, leftOut: [{ currency: 'EUR', count: 3 }], into: 'USD', judged: 'count', unrated: [], ratesAtHand: false });
    const f = fiFigures(plan({ spending: 40_000 }), { flows: null, assets, workplace: null }, 'USD');
    expect(f.view.fiNumber).toBe(1_000_000);
    expect(f.view.assets.value).toBeNull();
    expect(f.view.progress).toBeNull();
    expect(gapText(assetsGap(assets)!)).toContain('(3 accounts in EUR)');
    // With a home currency they are converted, so nothing is a gap.
    const FX = ecbTable({ home: 'USD' });
    expect(assetsGap(investedAssets(accounts, false, { home: 'USD', latest: FX.latest, own: [] }, Date.parse('2026-09-14T18:00:00Z'), 'USD'))).toBeNull();
  });

  test('Home says it too: no FI number, and why', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    const { FiProgressView } = await import('@/components/FiProgressCard');
    const { transactionCoverage } = await import('@/lib/fire/progress');
    const { NO_CONNECTIONS_WITHOUT } = await import('@/lib/no-transactions');
    const assets = investedAssets(broker, false, null, Date.now(), 'USD');
    const flows = trailingFlows(rows, '2026-09-14', { currency: 'USD' })!;
    const inputs = { flows, assets, workplace: null, unread: [], coverage: transactionCoverage(NO_CONNECTIONS_WITHOUT, rows.length) };
    const html = renderToStaticMarkup(React.createElement(FiProgressView, { figures: fiFigures(typed, inputs, 'USD'), plan: typed, saved: true, repaired: false, inputs, onOpenPlan: () => {} }));
    // The FI line (rollout phase 4c): no figure to lead with, so it says so.
    expect(html).toContain('<span class="list-row-title">FI isn’t worked out</span>');
    expect(html).toContain('Not measured: more than a tenth of the year’s spending, by count, as Nya doesn’t have the ECB’s rates at hand, is in another currency');
    expect(html).not.toContain('FI number');
  });
});

describe('a figure not measured is never counted as zero (review round 2, B10)', () => {
  let n = 0;
  const t = (over: Partial<Txn>): Txn => ({ transaction_id: `z${++n}`, date: '2026-09-01', name: 'Shop', amount: 100, pending: false, account_name: 'Konto', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'EUR', ...over }) as Txn;
  // A year of EUR spending (4,000 a month) and income (6,000 a month).
  const year: Txn[] = [];
  for (let m = 0; m < 12; m++) {
    const day = `${m < 3 ? 2025 : 2026}-${String(m < 3 ? m + 10 : m - 2).padStart(2, '0')}-05`;
    year.push(t({ date: day, amount: 4_000 }), t({ date: day, amount: -6_000, category: 'income' }));
  }
  // €600k and €300k, and a small dollar account beside them.
  const accounts = [inst([acct({ account_id: 'e1', balance: 600_000, currency: 'EUR' }), acct({ account_id: 'e2', balance: 300_000, currency: 'EUR' }), acct({ account_id: 'u', balance: 5_000 })])];
  const rates = ecbTable({ home: null }).latest!.rates;
  const aged = plan({ age: 40, targetAge: 55, partTimeIncome: 10_000 });

  test('by count, the dollar account is a third of the accounts: assets aren’t measured, and nothing that rests on them is worked out', () => {
    const assets = investedAssets(accounts, false);
    const flows = trailingFlows(year, '2026-09-14', { into: assets.currency })!;
    expect(assetsGap(assets)).toMatchObject({ judged: 'count' });
    const { view } = fiFigures(aged, { flows, assets, workplace: null }, 'EUR');
    expect(view.assets).toEqual({ value: null, source: 'unmeasured' });
    expect(view.fiNumber).not.toBeNull();
    expect(view.progress).toBeNull();
    expect(view.yearsToFi).toBeNull();
    expect(view.fiAge).toBeNull();
    expect(view.coast).toMatchObject({ reached: null });
    expect(view.barista).toMatchObject({ yearsTo: null });
    expect(view.atTargetAge).toBeNull();
    expect(notWorkedOutText(view, 'below')).toBe('Not worked out: your invested assets aren’t measured (below), and a figure that isn’t measured is never counted as zero.');
  });

  test('nothing to measure from is still none, worked out from what there is, as before', () => {
    const none = investedAssets([], false);
    const flows = trailingFlows(year, '2026-09-14', { into: none.currency })!;
    const { view } = fiFigures(aged, { flows, assets: none, workplace: null }, 'EUR');
    expect(view.assets.source).toBe('none');
    expect(view.yearsToFi).not.toBeNull();
    expect(notWorkedOutText(view, 'below')).toBeNull();
  });

  test('by amount at the ECB’s rates, the dollar account is half a percent: measured, the euros counted, the dollars named, and the years worked out', () => {
    const assets = investedAssets(accounts, false);
    const flows = trailingFlows(year, '2026-09-14', { into: assets.currency })!;
    expect(assetsGap(assets, rates)).toBeNull();
    const { view } = fiFigures(aged, { flows, assets, workplace: null, rates }, 'EUR');
    expect(view.assets).toEqual({ value: 900_000, source: 'measured' });
    expect(view.yearsToFi).not.toBeNull();
    expect(assetsLeftOut(assets)).toBe("1 account in USD isn't in this figure, which is in EUR.");
  });

  test('a large foreign account does trigger it by amount, and the reason says it was weighed by amount', () => {
    const big = [inst([acct({ account_id: 'e1', balance: 600_000, currency: 'EUR' }), acct({ account_id: 'u', balance: 400_000 })])];
    const g = assetsGap(investedAssets(big, false), rates);
    expect(g).toMatchObject({ judged: 'amount', unrated: [] });
    expect(gapText(g!)).toContain('more than a tenth of what would count, by amount at the ECB’s newest rates (used only to weigh it), is in another currency than the Plan’s, EUR (1 account in USD)');
  });

  test('where the ECB has no rate for one, by count, and said so', () => {
    const coins = [inst([acct({ account_id: 'e1', balance: 600_000, currency: 'EUR' }), acct({ account_id: 'b', balance: 2, currency: 'BTC' })])];
    const g = assetsGap(investedAssets(coins, false), rates);
    expect(g).toMatchObject({ judged: 'count', unrated: ['BTC'] });
    expect(gapText(g!)).toContain('by count, as the ECB publishes no rate for BTC');
  });

  test('spending typed, the year not measured: savings aren’t, so years to FI aren’t worked out from zero savings', () => {
    // $400k invested; 24 dollar rows and 12 small CAD ones in the year.
    const usd = [inst([acct({ balance: 400_000 })])];
    const rows: Txn[] = [];
    for (let m = 0; m < 12; m++) {
      const day = `${m < 3 ? 2025 : 2026}-${String(m < 3 ? m + 10 : m - 2).padStart(2, '0')}-05`;
      rows.push(t({ date: day, amount: 3_000, iso_currency_code: 'USD' }), t({ date: day, amount: -5_000, category: 'income', iso_currency_code: 'USD' }), t({ date: day, amount: 20, iso_currency_code: 'CAD' }));
    }
    const typed = plan({ age: 40, targetAge: 55, spending: 40_000 });
    const assets = investedAssets(usd, false, null, Date.now(), 'USD');
    const flows = trailingFlows(rows, '2026-09-14', { currency: 'USD' })!;
    const counted = fiFigures(typed, { flows, assets, workplace: null }, 'USD');
    expect(counted.view.savings.source).toBe('unmeasured');
    expect(counted.view.yearsToFi).toBeNull();
    expect(counted.savingsRate).toBeNull();
    expect(gapText(spendingGap(flows)!, 'year')).toStartWith('The year’s income and savings aren’t measured: more than a tenth of the year’s spending, by count, as Nya doesn’t have the ECB’s rates at hand, is in another currency');
    expect(gapText(spendingGap(flows)!, 'rate')).toStartWith('The savings rate isn’t measured:');
    // By amount, twenty dollars a month in Canada is nothing: measured.
    const weighed = fiFigures(typed, { flows, assets, workplace: null, rates }, 'USD');
    expect(weighed.view.savings.source).toBe('measured');
    expect(weighed.view.yearsToFi).not.toBeNull();
  });

  test('scenarios and compare mode: no walk or start projected from a figure not measured, and the FI date says why', async () => {
    const { planFigures } = await import('@/lib/fire/plan-figures');
    const { fiDateText } = await import('@/components/plan-compare');
    const assets = investedAssets(accounts, false);
    const flows = trailingFlows(year, '2026-09-14', { into: assets.currency })!;
    const measured = (await import('@/lib/fire/progress')).measuredInputs({ flows, assets, workplace: null });
    expect(measured.unmeasured).toEqual(['assets']);
    const f = planFigures(aged, measured, [{ id: 'k', kind: 'child', label: 'A child', fromAge: 42, yearly: 10_000, years: 18 }]) as import('@/lib/fire/plan-figures').PlanFigures;
    expect(f.walked).toBe(false);
    expect(f.view.yearsToFi).toBeNull();
    expect(f.startsWith).toMatchObject({ projected: null, more: false });
    expect(fiDateText(f, '2026-10-23')).toBe('not worked out: your invested assets aren’t measured (Your path says why)');
  });
});

describe('Home’s FI card, rendered, never from a figure not measured (review round 2)', () => {
  let n = 0;
  const t = (over: Partial<Txn>): Txn => ({ transaction_id: `h${++n}`, date: '2026-09-01', name: 'Shop', amount: 100, pending: false, account_name: 'Konto', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'EUR', ...over }) as Txn;
  const months = Array.from({ length: 12 }, (_, m) => `${m < 3 ? 2025 : 2026}-${String(m < 3 ? m + 10 : m - 2).padStart(2, '0')}-05`);
  const home = async (plan_: FirePlan, institutions: AssetInstitution[], rows: Txn[], own: string | null, rates: Record<string, string> | null = null) => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    const { FiProgressView } = await import('@/components/FiProgressCard');
    const { transactionCoverage } = await import('@/lib/fire/progress');
    const { NO_CONNECTIONS_WITHOUT } = await import('@/lib/no-transactions');
    const assets = investedAssets(institutions, false, null, Date.now(), own);
    const flows = trailingFlows(rows, '2026-09-14', { into: assets.currency, ...(own ? { currency: own } : {}) });
    const inputs = { flows, assets, workplace: null, unread: [], coverage: transactionCoverage(NO_CONNECTIONS_WITHOUT, rows.length), rates };
    return renderToStaticMarkup(React.createElement(FiProgressView, { figures: fiFigures(plan_, inputs, own), plan: plan_, saved: true, repaired: false, inputs, onOpenPlan: () => {} })).replace(/&#x27;|&#39;/g, "'");
  };

  test('assets not measured: no years to FI, said why', async () => {
    const accounts = [inst([acct({ account_id: 'e1', balance: 600_000, currency: 'EUR' }), acct({ account_id: 'e2', balance: 300_000, currency: 'EUR' }), acct({ account_id: 'u', balance: 5_000 })])];
    const rows = months.flatMap((d) => [t({ date: d, amount: 4_000 }), t({ date: d, amount: -6_000, category: 'income' })]);
    const html = await home(plan({ age: 40, targetAge: 55 }), accounts, rows, null);
    expect(html).toContain('Not measured: more than a tenth of what would count, by count, as Nya doesn’t have the ECB’s rates at hand, is in another currency than the Plan’s, EUR (1 account in USD).');
    expect(html).toContain('Years to FI aren’t worked out: your invested assets aren’t measured (above), and a figure that isn’t measured is never counted as zero.');
    expect(html).not.toMatch(/FI in about [\d.]+ years?/);
    // Weighed by amount, measured, and worked out.
    const weighed = await home(plan({ age: 40, targetAge: 55 }), accounts, rows, null, ecbTable({ home: null }).latest!.rates);
    expect(weighed).not.toContain('Not measured');
    expect(weighed).toMatch(/FI in about [\d.]+ years?/);
  });

  test('spending typed and the year not measured: the savings rate’s absence is said, in the year’s own words', async () => {
    const rows = months.flatMap((d) => [t({ date: d, amount: 3_000, iso_currency_code: 'USD' }), t({ date: d, amount: -5_000, category: 'income', iso_currency_code: 'USD' }), t({ date: d, amount: 20, iso_currency_code: 'CAD' })]);
    const html = await home(plan({ spending: 40_000 }), [inst([acct({ balance: 400_000 })])], rows, 'USD');
    expect(html).toContain('The year’s income and savings aren’t measured: more than a tenth of the year’s spending, by count, as Nya doesn’t have the ECB’s rates at hand, is in another currency than the Plan’s, USD');
    expect(html).not.toContain('savings rate, last 12 months');
    expect(html).toContain('Years to FI aren’t worked out: your savings aren’t measured (above)');
    // Savings typed too: only the rate is missing, and said so.
    const both = await home(plan({ spending: 40_000, savings: 20_000 }), [inst([acct({ balance: 400_000 })])], rows, 'USD');
    expect(both).toContain('The savings rate isn’t measured:');
    expect(both).not.toContain('aren’t worked out');
  });
});

describe('the year weighed on each side, money out apart from money in (review round 3)', () => {
  let n = 0;
  const t = (over: Partial<Txn>): Txn => ({ transaction_id: `w${++n}`, date: '2026-09-01', name: 'Shop', amount: 500, pending: false, account_name: 'Checking', institution_name: 'Bank', category: 'food and drink', iso_currency_code: 'USD', ...over }) as Txn;
  const months = Array.from({ length: 12 }, (_, m) => `${m < 3 ? 2025 : 2026}-${String(m < 3 ? m + 10 : m - 2).padStart(2, '0')}`);
  const day = (month: string, d: number) => `${month}-${String(d).padStart(2, '0')}`;
  const rates = ecbTable({ home: null }).latest!.rates;
  const usd = [inst([acct({ balance: 400_000 })])];
  const assets = investedAssets(usd, false, null, Date.now(), 'USD');
  // The review's probe: $200k of income in dollars, $42k of spending in
  // dollars and €18k in euros, about a third of the spending.
  const highEarner = months.flatMap((m) => [
    t({ date: day(m, 1), amount: -200_000 / 12, category: 'income', name: 'Pay' }),
    ...Array.from({ length: 7 }, (_, k) => t({ date: day(m, k + 2) })),
    ...Array.from({ length: 3 }, (_, k) => t({ date: day(m, k + 11), iso_currency_code: 'EUR' })),
  ]);

  test('a large income in the Plan’s currency doesn’t hide spending in another: by amount, the year isn’t measured, and the FI number isn’t worked out from the dollars alone', () => {
    const flows = trailingFlows(highEarner, '2026-09-14', { currency: 'USD' })!;
    expect(flows.volume!.spending).toMatchObject({ counted: 42_000, count: 84, leftOut: [{ currency: 'EUR', amount: 18_000, count: 36 }] });
    expect(flows.volume!.income).toMatchObject({ count: 12, leftOut: [] });
    expect(flows.volume!.income.counted).toBeCloseTo(200_000, 2);
    // Over the whole year's money the euros were about 8%, under a tenth;
    // against the spending alone they are about a third.
    const g = spendingGap(flows, rates);
    expect(g).toEqual({ what: 'spending', counted: 84, leftOut: [{ currency: 'EUR', count: 36 }], into: 'USD', judged: 'amount', unrated: [], ratesAtHand: true, sides: ['spending'] });
    const f = fiFigures(DEFAULT_PLAN, { flows, assets, workplace: null, rates }, 'USD');
    expect(f.view.spending).toEqual({ value: null, source: 'unmeasured' });
    expect(f.view.fiNumber).toBeNull();
    expect(f.view.yearsToFi).toBeNull();
    expect(f.savingsRate).toBeNull();
    expect(gapText(g!)).toBe(
      'Not measured: more than a tenth of the year’s spending, by amount at the ECB’s newest rates (used only to weigh it), is in another currency than the Plan’s, USD (36 transactions in EUR this year). Without a home currency nothing is converted, so a figure from the rest would leave that much of your spending out. Choose a home currency on the Currency card in Settings, Preferences to convert them, or type your spending.'
    );
    // By count the same, as before.
    expect(spendingGap(flows)).toMatchObject({ judged: 'count', sides: ['spending'] });
  });

  test('Home says so for the high earner, rather than an FI number from the dollars alone', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    const { FiProgressView } = await import('@/components/FiProgressCard');
    const { transactionCoverage } = await import('@/lib/fire/progress');
    const { NO_CONNECTIONS_WITHOUT } = await import('@/lib/no-transactions');
    const flows = trailingFlows(highEarner, '2026-09-14', { currency: 'USD' })!;
    const inputs = { flows, assets, workplace: null, unread: [], coverage: transactionCoverage(NO_CONNECTIONS_WITHOUT, highEarner.length), rates };
    const html = renderToStaticMarkup(React.createElement(FiProgressView, { figures: fiFigures(DEFAULT_PLAN, inputs, 'USD'), plan: DEFAULT_PLAN, saved: true, repaired: false, inputs, onOpenPlan: () => {} }));
    expect(html).toContain('Not measured: more than a tenth of the year’s spending, by amount at the ECB’s newest rates (used only to weigh it), is in another currency than the Plan’s, USD (36 transactions in EUR this year).');
    expect(html).not.toContain('FI number');
    expect(html).not.toContain('years to FI');
  });

  // The mirror: income in euros, spending in dollars.
  const mirror = months.flatMap((m) => [
    t({ date: day(m, 1), amount: -5_000, category: 'income', name: 'Pay', iso_currency_code: 'EUR' }),
    ...Array.from({ length: 10 }, (_, k) => t({ date: day(m, k + 2), amount: 350 })),
  ]);

  test('the mirror: with the income in euros, the year’s income isn’t measured, by amount or by count, and says it is the income; the spending, all in dollars, still is', () => {
    const rows = mirror;
    const flows = trailingFlows(rows, '2026-09-14', { currency: 'USD' })!;
    const byAmount = spendingGap(flows, rates);
    expect(byAmount).toMatchObject({ judged: 'amount', sides: ['income'], leftOut: [{ currency: 'EUR', count: 12 }] });
    // Twelve of 132 transactions, under a tenth of the whole year by count,
    // yet all of the income.
    expect(spendingGap(flows)).toMatchObject({ judged: 'count', sides: ['income'] });
    // Each figure needs only what it uses: the spending and the FI number
    // stand, and savings, the savings rate and years to FI wait.
    const f = fiFigures(DEFAULT_PLAN, { flows, assets, workplace: null, rates }, 'USD');
    expect(f.view.spending).toEqual({ value: flows.spending, source: 'measured' });
    expect(flows.spending).toBeGreaterThan(42_000); // under a year of history, scaled up
    expect(f.view.fiNumber).toBe(flows.spending / 0.04);
    expect(f.view.progress).not.toBeNull();
    expect(f.view.savings).toEqual({ value: null, source: 'unmeasured' });
    expect(f.view.yearsToFi).toBeNull();
    expect(f.savingsRate).toBeNull();
    expect(notWorkedOutText(f.view, 'below')).toBe('Not worked out: your savings aren’t measured (below), and a figure that isn’t measured is never counted as zero.');
    expect(gapText(byAmount!, 'year')).toBe(
      'The year’s income and savings aren’t measured: more than a tenth of the year’s income, by amount at the ECB’s newest rates (used only to weigh it), is in another currency than the Plan’s, USD (12 transactions in EUR this year). Without a home currency nothing is converted, so figures from the rest would leave that much of the year out. Choose a home currency on the Currency card in Settings, Preferences to convert them, or type your savings.'
    );
    // The spending figure's own words are never asked of it: the Plan tab's
    // spending note waits on the spending side, and Home's on an unmeasured
    // spending figure, which this one isn't.
    expect(spendingOff(byAmount)).toBe(false);
    // Spending typed: the savings say it in the year's own words.
    const typed = fiFigures(plan({ spending: 42_000 }), { flows, assets, workplace: null, rates }, 'USD');
    expect(typed.view.fiNumber).toBe(1_050_000);
    expect(typed.view.savings.source).toBe('unmeasured');
    expect(typed.view.yearsToFi).toBeNull();
  });

  test('Home, for the mirror: the FI number is shown, years to FI aren’t, and both say why', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const React = await import('react');
    const { FiProgressView } = await import('@/components/FiProgressCard');
    const { transactionCoverage } = await import('@/lib/fire/progress');
    const { NO_CONNECTIONS_WITHOUT } = await import('@/lib/no-transactions');
    const flows = trailingFlows(mirror, '2026-09-14', { currency: 'USD' })!;
    const inputs = { flows, assets, workplace: null, unread: [], coverage: transactionCoverage(NO_CONNECTIONS_WITHOUT, mirror.length), rates };
    const html = renderToStaticMarkup(React.createElement(FiProgressView, { figures: fiFigures(DEFAULT_PLAN, inputs, 'USD'), plan: DEFAULT_PLAN, saved: true, repaired: false, inputs, onOpenPlan: () => {} })).replace(/&#x27;|&#39;/g, "'");
    expect(html).toContain(`<span class="list-row-sub">FI number $${Math.round(flows.spending / 0.04).toLocaleString('en-US')} · `);
    expect(html).toContain('The year’s income and savings aren’t measured: more than a tenth of the year’s income, by amount at the ECB’s newest rates (used only to weigh it), is in another currency than the Plan’s, USD (12 transactions in EUR this year).');
    expect(html).toContain('Years to FI aren’t worked out: your savings aren’t measured (above), and a figure that isn’t measured is never counted as zero.');
    expect(html).not.toMatch(/FI in /);
    expect(html).toMatch(/<span class="list-row-title">\d+% of the way to FI<\/span>/);
    expect(html).not.toContain('Not measured: more than a tenth');
  });

  test('a small income in another currency is weighed as small, and both sides over are both said', () => {
    const rows = months.flatMap((m, i) => [
      t({ date: day(m, 1), amount: -200_000 / 12, category: 'income', name: 'Pay' }),
      ...Array.from({ length: 7 }, (_, k) => t({ date: day(m, k + 2) })),
      ...(i < 2 ? [t({ date: day(m, 20), amount: -500, category: 'income', name: 'Talk', iso_currency_code: 'EUR' })] : []),
    ]);
    const flows = trailingFlows(rows, '2026-09-14', { currency: 'USD' })!;
    expect(spendingGap(flows, rates)).toBeNull();
    // By count two of fourteen paid in: over a tenth of the income.
    expect(spendingGap(flows)).toMatchObject({ sides: ['income'] });
    const both = months.flatMap((m) => [
      t({ date: day(m, 1), amount: -4_000, category: 'income', name: 'Pay', iso_currency_code: 'GBP' }),
      t({ date: day(m, 2), amount: -2_000, category: 'income', name: 'Pay' }),
      t({ date: day(m, 3), amount: 1_000 }),
      t({ date: day(m, 4), amount: 1_000, iso_currency_code: 'GBP' }),
    ]);
    const g = spendingGap(trailingFlows(both, '2026-09-14', { currency: 'USD' })!, rates)!;
    expect(g).toMatchObject({ sides: ['spending', 'income'], leftOut: [{ currency: 'GBP', count: 24 }] });
    expect(gapText(g)).toContain('more than a tenth of both the year’s spending and its income, by amount');
    expect(gapText(g)).toContain('so a figure from the rest would leave that much of your spending and income out.');
  });

  test('without the ECB’s rates at hand, never said to be a rate the ECB doesn’t publish (review round 3, C2)', () => {
    const rows = months.flatMap((m) => [t({ date: day(m, 1), amount: 3_000 }), t({ date: day(m, 2), amount: 3_000, iso_currency_code: 'CAD' })]);
    const flows = trailingFlows(rows, '2026-09-14', { currency: 'USD' })!;
    // Never fetched or unusable (GET /api/currency answers no rates), or
    // still loading or failed (none passed).
    for (const none of [{}, null, undefined]) {
      const g = spendingGap(flows, none)!;
      expect(g).toMatchObject({ judged: 'count', unrated: [], ratesAtHand: false });
      expect(gapText(g)).toContain('more than a tenth of the year’s spending, by count, as Nya doesn’t have the ECB’s rates at hand, is in another currency');
      expect(gapText(g)).not.toContain('publishes no rate');
    }
    // A currency the ECB really doesn't publish is still named so.
    const coins = months.flatMap((m) => [t({ date: day(m, 1), amount: 3_000 }), t({ date: day(m, 2), amount: 3_000, iso_currency_code: 'BTC' })]);
    const g = spendingGap(trailingFlows(coins, '2026-09-14', { currency: 'USD' })!, rates)!;
    expect(g).toMatchObject({ judged: 'count', unrated: ['BTC'], ratesAtHand: true });
    expect(gapText(g)).toContain('by count, as the ECB publishes no rate for BTC,');
    // And for accounts the same.
    const accounts = investedAssets([inst([acct({ account_id: 'e', balance: 600_000, currency: 'EUR' }), acct({ account_id: 'u', balance: 400_000 })])], false);
    expect(gapText(assetsGap(accounts, {})!)).toContain('by count, as Nya doesn’t have the ECB’s rates at hand,');
  });
});
