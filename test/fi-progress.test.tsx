import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { FiCard, InputsCard } from '@/components/PlanTab';
import { figureNotes, type FigureArgs } from '@/components/plan-figure-notes';
import { FiProgressView, ready } from '@/components/FiProgressCard';
import { loadFiProgress } from '@/components/FiProgressLoader';
import { PAYROLL_NOTE, fiHeadline, wholeMoney, yearsToFiText } from '@/components/plan-text';
import { DEFAULT_PLAN, fiView, type FirePlan } from '@/lib/fire/plan';
import { currencyNote, fiFigures, measuredInputs, planCurrency, savingsRate, transactionCoverage, type FiInputs } from '@/lib/fire/progress';
import { trailingFlows, type InvestedAssets, type TrailingFlows, type UnreadTransactions, type WorkplaceSavings } from '@/lib/fire/inputs';
import { NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import type { Txn } from '@/components/MonthBreakdown';

// The FI card on Home: the Plan's own figures, from the same inputs and the
// same arithmetic (lib/fire/progress.ts), so the two always agree; the
// defaults said as defaults; estimates labelled; and no engine on Home.

const noop = () => {};
const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');

const flows: TrailingFlows = {
  spending: 40_000,
  income: 70_000,
  savings: 30_000,
  loanPayments: 0,
  cash: 0,
  refunds: 0,
  unclearLoans: 0,
  largestRefund: null,
  from: '2025-10-07',
  to: '2026-10-06',
  days: 365,
  scaled: false,
  count: 400,
  currency: 'USD',
  cashWithdrawn: 0,
  cashEntered: 0,
  cashEnteredOn: [],
  cashIous: 0,
  excludedCount: 0,
  leftOut: [],
};
const assets = (over: Partial<InvestedAssets> = {}): InvestedAssets => ({
  total: 250_000,
  accounts: [{ account_id: 'a', name: 'Brokerage', type: 'investment', balance: 250_000, currency: 'USD', institution: 'Vanguard', item_id: 'i1' }],
  unknown: 0,
  caveats: [],
  currency: 'USD',
  leftOut: [],
  ...over,
});
const noPlans: WorkplaceSavings = { total: 0, plans: [], fromBank: [], partial: [], shortHistory: [], problems: [], unmeasured: [] };
const withPlan = (total: number): WorkplaceSavings => ({
  ...noPlans,
  total,
  plans: [{ name: 'Fidelity 401(k)', paidFrom: 'payroll', added: total, count: 24, largest: { date: '2026-09-30', amount: 1000 }, matched: 0 }],
});
/** The inputs as the hook gathers them (components/plan-inputs.ts), with
 *  what the connections say about transactions (lib/no-transactions.ts) and
 *  how many there are; the coverage is worked out as the hook does. */
type Inputs = FiInputs & { unread: UnreadTransactions[]; without: NoTransactionsView; transactionCount: number };
const inputs = (over: Partial<Inputs> = {}): Inputs => ({
  flows,
  workplace: noPlans,
  assets: assets(),
  unread: [],
  without: NO_CONNECTIONS_WITHOUT,
  transactionCount: (over.flows === undefined ? flows : over.flows)?.count ?? 0,
  ...over,
});
const hookInputs = (i: Inputs) => ({ ...i, coverage: transactionCoverage(i.without, i.transactionCount) });

const homeHtml = (p: FirePlan, i = inputs(), saved = true, repaired = false) =>
  renderToStaticMarkup(<FiProgressView figures={fiFigures(p, i, 'USD')} plan={p} saved={saved} repaired={repaired} inputs={hookInputs(i)} onOpenPlan={noop} />);
const home = (p: FirePlan, i = inputs(), saved = true, repaired = false) => text(homeHtml(p, i, saved, repaired));
/** Your path's FI card and the figures it rests on under it (Your figures),
 *  what they say worked out in the render as components/PlanTab.tsx does, so
 *  a render with amounts hidden (test/hidden-renders.ts) hides the amounts
 *  in it. */
function YourPath({ a, currencyNote }: { a: FigureArgs; currencyNote: string | null }) {
  return (
    <>
      <FiCard {...a} currencyNote={currencyNote} />
      <InputsCard figures={figureNotes(a)} view={a.view} money={a.money} onOpen={noop} />
    </>
  );
}
/** The Plan tab's Your path, from the same inputs as Home, as PlanTab gives
 *  them to both cards. */
const planTabHtml = (p: FirePlan, i = inputs()) => {
  const f = fiFigures(p, i, 'USD');
  const a: FigureArgs = {
    plan: p,
    view: f.view,
    flows: i.flows,
    unread: i.unread,
    withoutTransactions: i.without,
    transactionCount: i.transactionCount,
    txnsLoading: false,
    txnsFailed: false,
    assets: i.assets,
    balancesAsOf: '2026-10-06T15:12:00Z',
    workplace: i.workplace,
    workplaceCount: i.workplace?.plans.length ?? 0,
    cashOn: [],
    cashUnmarked: false,
    money: (n) => wholeMoney(n, f.currency),
    savingsRate: f.savingsRate,
    shareRates: i.rates ?? null,
  };
  return renderToStaticMarkup(<YourPath a={a} currencyNote={f.currencyNote} />);
};
const planTab = (p: FirePlan, i = inputs()) => text(planTabHtml(p, i));
/** One of Your figures' rows, with the notes under it, by its title. */
const figureRow = (html: string, title: string) => html.match(new RegExp(`<li><button[^>]*><span class="list-row-text"><span class="list-row-title">${title}</span>.*?</li>`))?.[0] ?? '';
/** What shows with nothing opened: every gathered line's notes taken out. */
const closed = (html: string) => html.replace(/<details[\s\S]*?<\/details>/g, '');
/** The level of each notice that says `words`, in the order drawn. */
const levels = (html: string, words: string) =>
  [...html.matchAll(/<div class="notice (critical|caution|info)"><svg[^>]*>.*?<\/svg><div><span class="visually-hidden">[^<]*<\/span>(.*?)<\/div><\/div>/g)]
    .filter((m) => text(m[2]).includes(words))
    .map((m) => m[1]);

describe('the figures, from the Plan’s inputs', () => {
  test('measured inputs: a year’s spending, savings with workplace contributions added, invested assets', () => {
    expect(measuredInputs(inputs())).toEqual({ spending: 40_000, savings: 30_000, assets: 250_000 });
    expect(measuredInputs(inputs({ workplace: withPlan(12_000) }))).toEqual({ spending: 40_000, savings: 42_000, assets: 250_000 });
    expect(measuredInputs(inputs({ flows: null, assets: assets({ total: null }) }))).toEqual({ spending: null, savings: null, assets: null });
  });

  test('the savings rate counts workplace contributions on both sides', () => {
    expect(savingsRate({ flows, workplace: noPlans })).toBeCloseTo(30 / 70, 12);
    // (70,000 + 12,000 - 40,000) / (70,000 + 12,000)
    expect(savingsRate({ flows, workplace: withPlan(12_000) })).toBeCloseTo(42 / 82, 12);
    // Spending more than income: below zero, as it was.
    expect(savingsRate({ flows: { ...flows, income: 30_000, savings: -10_000 }, workplace: null })).toBeCloseTo(-1 / 3, 12);
    // No income to take a share of, or no year of transactions.
    expect(savingsRate({ flows: { ...flows, income: 0, savings: -40_000 }, workplace: null })).toBeNull();
    expect(savingsRate({ flows: null, workplace: withPlan(5_000) })).toBeNull();
  });

  test('the currency and the note about currencies are the Plan’s', () => {
    expect(planCurrency(inputs(), 'EUR')).toBe('USD');
    expect(planCurrency(inputs({ assets: assets({ currency: null }), flows: { ...flows, currency: null } }), 'EUR')).toBe('EUR');
    expect(currencyNote(inputs({ flows: { ...flows, currency: 'CAD' } }))).toContain("can't be compared");
    // Amounts in another currency within either are left out of it and named
    // beside it, not summed: no note says they were added.
    expect(currencyNote(inputs({ assets: assets({ leftOut: [{ currency: 'CAD', count: 1 }] }) }))).toBeNull();
    expect(currencyNote(inputs())).toBeNull();
  });

  test('are fiView of the measured inputs, as the Plan tab works them out', () => {
    for (const p of [plan(), plan({ withdrawalRate: 0.035, realReturn: 0.04, taxRate: 0.15 }), plan({ spending: 60_000, savings: 10_000 }), plan({ assets: 0 })]) {
      for (const i of [inputs(), inputs({ workplace: withPlan(8_000) }), inputs({ flows: null })]) {
        expect(fiFigures(p, i, 'USD').view).toEqual(fiView(p, measuredInputs(i)));
      }
    }
  });
});

describe('the FI card on Home', () => {
  test('agrees with the Plan tab for the same inputs: FI number, years to FI, progress and savings rate', () => {
    for (const p of [plan(), plan({ withdrawalRate: 0.035, realReturn: 0.03, taxRate: 0.1, age: 35 }), plan({ spending: 52_000 })]) {
      for (const i of [inputs(), inputs({ workplace: withPlan(9_500) })]) {
        const f = fiFigures(p, i, 'USD');
        const h = home(p, i);
        const html = planTabHtml(p, i);
        const t = text(html);
        const fi = wholeMoney(f.view.fiNumber!, 'USD');
        const years = yearsToFiText(f.view.yearsToFi);
        const progress = `${Math.round(f.view.progress! * 100)}%`;
        const rate = `${Math.round(f.savingsRate! * 100)}%`;
        for (const s of [fi, progress, rate]) {
          expect(h).toContain(s);
          expect(t).toContain(s);
        }
        expect(t).toContain(years);
        // Home's one line (rollout phase 8b): the Plan's answer in the Plan's
        // words, then what is invested of the FI number, how far, and the
        // savings rate under it.
        const head = fiHeadline(f.view, p);
        expect(t).toContain(`Financial independence ${head.headline}`);
        const answer = head.kind === 'age' ? `FI around age ${head.age}` : `FI in ${years}`;
        expect(h).toContain(`${answer} ${wholeMoney(f.view.assets.value!, 'USD')} of ${fi} invested (${progress}) · ${rate} savings rate, last 12 months`);
        expect(t).toContain(`${progress} of the way`);
        // On the Plan, the savings row's second line, in Home's words, which
        // no gathered line folds away (rollout phase 6c).
        expect(closed(figureRow(html, 'Annual savings'))).toContain(`<span class="plan-input-line">${rate} savings rate</span>`);
      }
    }
  });

  test('with savings typed into the plan, both show the rate the transactions measure, and Home says it is that', () => {
    const p = plan({ savings: 5_000 });
    const rate = `${Math.round(fiFigures(p, inputs(), 'USD').savingsRate! * 100)}%`;
    // The savings row says they are typed, and under it, in full (a typed
    // figure has no other note), the rate the transactions measure.
    const savings = figureRow(planTabHtml(p), 'Annual savings');
    expect(text(savings)).toContain('Annual savings Typed by you $5,000');
    const measured = `Measured from your last 12 months of transactions (Oct 7, 2025 to Oct 6, 2026) instead, your savings rate is ${rate} of income.`;
    expect(levels(closed(savings), measured)).toEqual(['info']);
    const h = home(p);
    expect(h).toContain(rate);
    expect(h).toContain('The savings rate is income minus spending as a share of income, from your transactions, not the savings you typed.');
    // Measured savings: no such words.
    expect(home(plan())).not.toContain('not the savings you typed');
  });

  test('labels its figures as estimates, with the Plan’s note about pay that never reaches a bank', () => {
    const t = home(plan());
    expect(t).toContain('Estimates, from your plan: a 4% withdrawal rate and 5% growth after inflation.');
    expect(t).toContain('savings rate, last 12 months');
    expect(t).toContain(PAYROLL_NOTE);
    // Under the Plan's savings row, amber as it was.
    expect(levels(figureRow(planTabHtml(plan()), 'Annual savings'), PAYROLL_NOTE)).toEqual(['caution']);
    // With workplace contributions measured, it says they are counted instead.
    const w = home(plan(), inputs({ workplace: withPlan(12_000) }));
    expect(w).toContain('with what went into workplace plans counted on both sides');
    expect(w).not.toContain(PAYROLL_NOTE);
  });

  test('with no plan saved, says the figures come from the defaults and offers the Plan tab', () => {
    const t = home(plan(), inputs(), false);
    expect(t).toContain("from the Plan's default assumptions: a 4% withdrawal rate and 5% growth after inflation. Set your own on the Plan tab.");
    expect(t).toContain('$1,000,000');
    // The whole line opens the Plan tab (its button replaced "Set up your plan"),
    // and its gathered notes say, closed, that these are the defaults.
    const defaults = homeHtml(plan(), inputs(), false);
    expect(defaults).toMatch(/^<li><button type="button" class="list-row">/);
    expect(defaults).toMatch(/<summary class="notice info">.*<span><span class="visually-hidden">Note: <\/span>2 notes: from the Plan’s defaults and pay before it reaches a bank<\/span>/);
    expect(homeHtml(plan())).toContain('<span><span class="visually-hidden">Note: </span>2 notes: how these are estimated and pay before it reaches a bank</span>');
  });

  test('says which of the plan’s inputs were typed, and when a saved plan needed repairs', () => {
    const t = home(plan({ spending: 60_000, savings: 5_000 }));
    expect(t).toContain('Using the spending and savings you typed there.');
    expect(t).toContain('$1,500,000');
    expect(home(plan(), inputs(), true, true)).toContain("Your saved plan has values this version of Nya can't use");
  });

  test('names what the year’s figures leave out, in the Plan’s own words: excluded transactions, other currencies', () => {
    const f = { ...flows, excludedCount: 2, leftOut: [{ currency: 'JPY', count: 3 }] };
    // Ten accounts counted and one left out: under a tenth, so measured from
    // the rest and named (more is not measured: lib/fire/progress.ts assetsGap).
    const ten = Array.from({ length: 10 }, (_, k) => ({ ...assets().accounts[0], account_id: `a${k}`, balance: 25_000 }));
    const a = assets({ accounts: ten, leftOut: [{ currency: 'CAD', count: 1 }] });
    const i = inputs({ flows: f, assets: a });
    const h = home(plan(), i);
    const html = planTabHtml(plan(), i);
    const t = text(html);
    for (const s of ['Leaves out 2 transactions you excluded from budgets and reports.', "3 transactions in JPY aren't in your spending or savings, which are in USD."]) {
      expect(h).toContain(s);
      expect(t).toContain(s);
    }
    // Under the Plan's rows, each at the level it had there.
    expect(levels(figureRow(html, 'Annual spending'), 'Leaves out 2 transactions you excluded from budgets and reports.')).toEqual(['info']);
    expect(levels(figureRow(html, 'Annual spending'), "3 transactions in JPY aren't in your spending or savings, which are in USD.")).toEqual(['caution']);
    expect(h).toContain("1 account in CAD isn't in your invested assets, which are in USD.");
    expect(levels(figureRow(html, 'Invested assets'), "1 account in CAD isn't in this figure, which is in USD.")).toEqual(['caution']);
    // The savings rate leaves them out too: it is from the same year's figures.
    expect(fiFigures(plan(), i, 'USD').savingsRate).toBeCloseTo(30 / 70, 12);
  });

  test('the savings rate is of the year as the Plan counts it: excluded rows and other currencies are in neither side', () => {
    let seq = 0;
    const txn = (over: Partial<Txn>): Txn =>
      ({
        transaction_id: `t${++seq}`,
        date: '2026-09-01',
        name: 'Shop',
        amount: 10,
        pending: false,
        account_name: 'Checking',
        institution_name: 'Bank',
        category: 'food and drink',
        iso_currency_code: 'USD',
        vendor_key: 'shop',
        subcategory: null,
        transaction_code: null,
        ...over,
      }) as Txn;
    // Spending in ten rows, so the one in yen is under a tenth of what counts
    // (more would leave the year unmeasured: lib/fire/progress.ts spendingGap).
    const year = [
      txn({ date: '2025-10-09', amount: -70_000, category: 'income', name: 'Pay' }),
      ...Array.from({ length: 10 }, () => txn({ date: '2025-10-09', amount: 4_000 })),
      // A car bought outright and excluded, and spending in yen: in no figure.
      txn({ date: '2026-03-01', amount: 20_000, excluded: true, name: 'Car' }),
      txn({ date: '2026-04-01', amount: 900_000, iso_currency_code: 'JPY', name: 'Tokyo' }),
    ];
    const f = trailingFlows(year, '2026-10-08')!;
    expect(f).toMatchObject({ spending: 40_000, income: 70_000, excludedCount: 1, leftOut: [{ currency: 'JPY', count: 1 }] });
    const i = inputs({ flows: f });
    expect(savingsRate(i)).toBeCloseTo(30 / 70, 12);
    const h = home(plan(), i);
    expect(h).toContain('43%');
    expect(h).toContain('Leaves out 1 transaction you excluded from budgets and reports.');
    expect(h).toContain("1 transaction in JPY isn't in your spending or savings, which are in USD.");
  });

  test('cash taken out at an ATM, imported from a bank’s OFX file, is spent on Home as on the Plan tab', async () => {
    // As the dashboard loads it: the imported row from its manual account's
    // book (lib/manual-txns.ts), with the ATM code its file's TRNTYPE gave it
    // (lib/import/ofx.ts bankType).
    const { manualRowForDisplay } = await import('@/lib/manual-txns');
    const account = { account_id: 'manual_cu-1', name: 'Credit Union', institution_name: 'Credit Union', type: 'depository', subtype: 'checking', balance: 0, updated_at: '2026-10-01T00:00:00.000Z' };
    const at = '2026-10-01T00:00:00.000Z';
    const row = (id: string, date: string, amount: number, name: string, extra: object = {}) =>
      manualRowForDisplay(account as any, { id: `manual-txn:${id}`, account_id: account.account_id, date, amount, currency: 'USD', name, category: null, note: null, source: 'import:ofx', source_id: id, created_at: at, updated_at: at, ...extra });
    const year = [
      row('pay', '2025-10-09', -70_000, 'PAYROLL'),
      row('spend', '2025-10-10', 38_000, 'GROCER'),
      row('atm', '2026-09-01', 2_000, 'ATM WITHDRAWAL', { category: 'transfer out', transaction_code: 'atm' }),
    ];
    expect(year[2]).toMatchObject({ transaction_code: 'atm', category: 'transfer out', source: 'import:ofx' });
    const f = trailingFlows(year, '2026-10-08')!;
    // Spent, as a linked bank's withdrawal is: not a transfer left out.
    expect(f).toMatchObject({ spending: 40_000, cash: 2_000, cashWithdrawn: 2_000, income: 70_000 });
    const i = inputs({ flows: f });
    const figures = fiFigures(plan(), i, 'USD');
    const fi = wholeMoney(figures.view.fiNumber!, 'USD');
    expect(fi).toBe(wholeMoney(40_000 / 0.04, 'USD'));
    const rate = `${Math.round(figures.savingsRate! * 100)}%`;
    for (const s of [fi, rate]) {
      expect(home(plan(), i)).toContain(s);
      expect(planTab(plan(), i)).toContain(s);
    }
    expect(closed(figureRow(planTabHtml(plan(), i), 'Annual savings'))).toContain(`<span class="plan-input-line">${rate} savings rate</span>`);
  });

  test('a figure that may be short says so, as the Plan’s does', () => {
    const unread = inputs({ unread: [{ institution: 'Chase', reason: 'needs to be reconnected' }] });
    expect(home(plan(), unread)).toContain("May be low: spending is missing transactions that couldn't be read, so the savings rate may be off too. The Plan tab says which.");
    expect(planTab(plan(), unread)).toContain("May be low: spending is missing transactions that couldn't be read (below).");
    // Spending typed: the savings rate is still from the transactions.
    expect(home(plan({ spending: 50_000 }), unread)).toContain("The savings rate may be off: it is missing transactions that couldn't be read. The Plan tab says which.");
    const short = inputs({ assets: assets({ caveats: [{ kind: 'unreachable', institution: 'Schwab' }] }) });
    expect(home(plan(), short)).toContain('Invested assets may be low');
    // Balances that are only old aren't short.
    expect(home(plan(), inputs({ assets: assets({ caveats: [{ kind: 'stale', institution: 'Schwab', asOf: '2026-10-01', at: null }] }) }))).not.toContain('may be low');
  });

  test('connections that bring in no transactions: Home and the Plan say the same, by the same rule', () => {
    const acme = { item_id: 'i2', institution_name: 'Acme CU', reason: 'refused' as const };
    const vanguard = { item_id: 'i1', institution_name: 'Vanguard', reason: 'investment_accounts' as const };
    // A bank account whose transactions Plaid doesn't provide, beside one
    // that brings them in: spending may be low on both screens.
    const refused = inputs({ without: { without: [acme], connections: 2 } });
    expect(home(plan(), refused)).toContain("May be low: spending is missing transactions Plaid doesn't provide, so the savings rate may be off too. The Plan tab says which.");
    expect(planTab(plan(), refused)).toContain("May be low: spending is missing transactions Plaid doesn't provide (below).");
    // Only investment connections, and a year of transactions entered by
    // hand: measured from those, with the connections named on both, never
    // as a warning.
    const byHand = inputs({ without: { without: [vanguard], connections: 1 } });
    const named = 'Vanguard holds no bank account or card, so no transactions come from it.';
    expect(home(plan(), byHand)).toContain(named);
    // Under the Plan's spending and savings rows, as information.
    const byHandHtml = planTabHtml(plan(), byHand);
    expect(levels(figureRow(byHandHtml, 'Annual spending'), named)).toEqual(['info']);
    expect(levels(figureRow(byHandHtml, 'Annual savings'), named)).toEqual(['info']);
    expect(home(plan(), byHand)).not.toContain('May be low');
    // Only investment connections and no transactions at all: no spending,
    // so Home shows nothing, and the Plan says why in place of the figures.
    const none = inputs({ flows: null, without: { without: [vanguard], connections: 1 } });
    expect(renderToStaticMarkup(<FiProgressView figures={fiFigures(plan(), none, 'USD')} plan={plan()} saved repaired={false} inputs={hookInputs(none)} onOpenPlan={noop} />)).toBe('');
    expect(levels(figureRow(planTabHtml(plan(), none), 'Annual spending'), 'Your connected accounts are investment accounts, so there are no bank or card transactions to measure spending from.')).toEqual(['info']);
  });

  test('shows nothing with no spending to work from', () => {
    const html = renderToStaticMarkup(
      <FiProgressView figures={fiFigures(plan(), inputs({ flows: null }), 'USD')} plan={plan()} saved={false} repaired={false} inputs={hookInputs(inputs({ flows: null }))} onOpenPlan={noop} />
    );
    expect(html).toBe('');
  });

  test('waits for the plan, the first transactions and workplace contributions, but keeps its place through a refresh', () => {
    const base = { plan: 'loaded' as const, txns: [], txnsLoading: false, contributionsPending: false };
    expect(ready(base)).toBe(true);
    expect(ready({ ...base, plan: 'loading' })).toBe(false);
    expect(ready({ ...base, plan: 'failed' })).toBe(false);
    expect(ready({ ...base, txns: null, txnsLoading: true })).toBe(false);
    // A refresh: transactions on screen while new ones load.
    expect(ready({ ...base, txnsLoading: true })).toBe(true);
    // Transactions that couldn't be loaded: what can be shown without them is.
    expect(ready({ ...base, txns: null })).toBe(true);
    expect(ready({ ...base, contributionsPending: true })).toBe(false);
  });

  test('a year that wasn’t a whole year says from when', () => {
    const short = inputs({ flows: { ...flows, from: '2026-07-01', days: 98, scaled: true } });
    expect(home(plan(), short)).toContain('savings rate, since Jul 1, 2026');
  });
});

describe('the FI line’s title, for every case (rollout phase 4c)', () => {
  // The figures as worked out, with years to FI and progress set to each case.
  const row = (yearsToFi: number | null, progress: number | null, p = plan()) => {
    const f = fiFigures(p, inputs(), 'USD');
    const fiAge = yearsToFi !== null && Number.isFinite(yearsToFi) && p.age !== null ? p.age + yearsToFi : null;
    const figures = { ...f, view: { ...f.view, yearsToFi, progress, fiAge } };
    return renderToStaticMarkup(<FiProgressView figures={figures} plan={p} saved repaired={false} inputs={hookInputs(inputs())} onOpenPlan={noop} />);
  };
  const part = (html: string, cls: string) => text(html.slice(html.indexOf(`<span class="${cls}">`), html.indexOf('</span>', html.indexOf(`<span class="${cls}">`)))).trim();
  const title = (yearsToFi: number | null, progress: number | null, p = plan()) => part(row(yearsToFi, progress, p), 'list-row-title');

  test('the Plan’s answer, against the stop age, in the Plan’s words (rollout phase 8b)', () => {
    const ages = plan({ age: 40, targetAge: 55 });
    expect(title(11.4, 0.62, ages)).toBe('FI around age 51, 4 years before you stop at 55');
    expect(title(18, 0.4, ages)).toBe('FI around age 58, 3 years after you stop at 55');
    expect(title(15, 0.5, ages)).toBe('FI around age 55, right when you stop at 55');
    expect(title(11.4, 0.62, plan({ age: 40 }))).toBe('FI around age 51');
    expect(title(70, 0.01, ages)).toBe('FI not before age 100 at this savings rate');
  });

  test('without an age, the years, each as the Plan says them', () => {
    expect(title(11.4, 0.62)).toBe('FI in about 11.4 years');
    expect(title(0.5, 0.97)).toBe('FI in under a year');
    expect(title(11.4, null)).toBe('FI in about 11.4 years');
    expect(title(140, 0.01)).toBe('FI not within 100 years at this savings rate');
  });

  test('how far is said under it, apart from the amounts, so it reads while they are hidden', () => {
    expect(part(row(11.4, 0.62), 'list-row-sub')).toBe('$250,000 of $1,000,000 invested (62%) · 43% savings rate, last 12 months');
    expect(part(row(0, 1.2), 'list-row-sub')).toBe('$250,000 invested · 120% of the FI number $1,000,000 · 43% savings rate, last 12 months');
    // Not twice, when the title says it.
    expect(part(row(null, 0.36), 'list-row-sub')).toBe('$250,000 of $1,000,000 invested · 43% savings rate, last 12 months');
  });

  test('there already, never reached at this rate, or years not worked out', () => {
    expect(title(0, 1.2)).toBe('You’re at FI');
    expect(title(Infinity, 0.1)).toBe('FI not reached at this savings rate');
    expect(title(null, 0.36)).toBe('36% of the way to FI');
  });

  test('there already, with savings that run the steady projection out before the stop age: said, as the Plan says it', () => {
    // $1,100,000 at 5%, taking $70,000 a year: $1,400,000 less $300,000 grown,
    // below zero at the end of its 32nd year, the year it turns 71.
    const p = plan({ age: 40, targetAge: 75, assets: 1_100_000, savings: -70_000 });
    const f = fiFigures(p, inputs(), 'USD');
    expect(f.view.yearsToFi).toBe(0);
    const html = renderToStaticMarkup(<FiProgressView figures={f} plan={p} saved repaired={false} inputs={hookInputs(inputs())} onOpenPlan={noop} />);
    expect(part(html, 'list-row-title')).toBe('You’re at FI, but at these savings it runs out at 71');
  });

  test('with no plan saved, the line says it is the Plan’s defaults (4c’s review)', () => {
    const f = fiFigures(plan(), inputs(), 'USD');
    const html = renderToStaticMarkup(<FiProgressView figures={f} plan={plan()} saved={false} repaired={false} inputs={hookInputs(inputs())} onOpenPlan={noop} />);
    expect(part(html, 'list-row-sub')).toStartWith('Plan defaults · ');
  });

  test('neither: the FI number leads, and the line under it has only the savings rate', () => {
    expect(title(null, null)).toBe('FI number $1,000,000');
    const f = fiFigures(plan(), inputs(), 'USD');
    const html = renderToStaticMarkup(<FiProgressView figures={{ ...f, view: { ...f.view, yearsToFi: null, progress: null } }} plan={plan()} saved repaired={false} inputs={hookInputs(inputs())} onOpenPlan={noop} />);
    expect(html).toMatch(/<span class="list-row-sub">\d+% savings rate, last 12 months<\/span>/);
  });
});

describe('each note in its level, the summary naming the worst first', () => {
  test('explanations neutral, what may be off amber; an amber line names its amber note', () => {
    // Estimates, payroll and excluded (neutral), and spending missing a bank's
    // transactions (amber): four kinds, so the summary names three.
    const i = inputs({ unread: [{ institution: 'Chase', reason: 'needs to be reconnected' }] });
    const html = homeHtml(plan(), i);
    expect(html).toMatch(/<summary class="notice caution">.*<span><span class="visually-hidden">Caution: <\/span>\d notes: spending may be low, /);
    for (const s of ['Estimates, from your plan', 'Contributions taken from pay before it reaches a bank']) {
      expect(html).toMatch(new RegExp(`<div class="notice info">.{0,400}<div><span class="visually-hidden">Note: </span>${s}`));
    }
    expect(html).toMatch(/<div class="notice caution">.{0,400}<div><span class="visually-hidden">Caution: <\/span>May be low: spending is missing/);
  });
});

describe('Home stays fast', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf8');
  const imports = (src: string) => [...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

  test('the card runs no simulation, and its code is loaded after Home paints', () => {
    const card = read('components/FiProgressCard.tsx');
    for (const engine of ['@/lib/fire/simulate', '@/lib/fire/jobs', '@/lib/fire/us-market', '@/lib/fire/history-data', './plan-runner']) {
      expect(imports(card)).not.toContain(engine);
    }
    expect(card).not.toMatch(/\b(simulate|successGrid|createPlanRunner|runPlanJob)\(/);
    // Home imports the loader, which imports the card only with import(),
    // so the card and the Plan's modules are a chunk of their own.
    const dashboard = read('components/Dashboard.tsx');
    expect(imports(dashboard)).toContain('./FiProgressLoader');
    expect(imports(dashboard)).not.toContain('./FiProgressCard');
    const loader = read('components/FiProgressLoader.tsx');
    expect(loader).toContain("import('./FiProgressCard')");
    expect(loader).toMatch(/import type \{ FiProgressProps \} from '\.\/FiProgressCard'/);
  });

  test('the card sits below the insights, so appearing once its figures are in moves nothing above it', () => {
    const dashboard = read('components/Dashboard.tsx');
    const insights = dashboard.indexOf('<Insights');
    const card = dashboard.indexOf('<FiProgressLoader');
    expect(insights).toBeGreaterThan(0);
    expect(card).toBeGreaterThan(insights);
  });

  test('a failed load of the card is forgotten, so the next try fetches it again', async () => {
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('chunk failed'));
    };
    await expect(loadFiProgress(failing)).rejects.toThrow('chunk failed');
    await expect(loadFiProgress(failing)).rejects.toThrow('chunk failed');
    expect(calls).toBe(2);
    const mod = await loadFiProgress(() => import('@/components/FiProgressCard'));
    expect(typeof mod.default).toBe('function');
    expect(await loadFiProgress(failing)).toBe(mod);
    expect(calls).toBe(2);
  });
});
