import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PlanTab, { EventsCard, FiCard, GridCard, InputsCard, RepairCard, SimulationCard, assetCaveatLines, unreadText, windowText, type Outcome } from '@/components/PlanTab';
import { figureNotes, type FigureArgs } from '@/components/plan-figure-notes';
import PlanFanChart from '@/components/PlanFanChart';
import { DrawnWidth } from '@/components/drawn-width';
import { FigureForm } from '@/components/PlanForms';
import PlanGrid from '@/components/PlanGrid';
import { PlanUnavailable, loadPlanTab } from '@/components/PlanTabLoader';
import { dayName, monthName, pct, progressText, successText, wholeMoney } from '@/components/plan-text';
import { DEFAULT_PLAN, enginePlan, fiView, type FirePlan, type Measured } from '@/lib/fire/plan';
import { simulate, successGrid } from '@/lib/fire/simulate';
import { usMarket } from '@/lib/fire/us-market';
import type { InvestedAssets, TrailingFlows, WorkplaceSavings } from '@/lib/fire/inputs';
import { NO_CONNECTIONS_WITHOUT } from '@/lib/no-transactions';

const noop = () => {};
const money = (n: number) => wholeMoney(n, 'USD');
const plan = (over: Partial<FirePlan> = {}): FirePlan => ({ ...DEFAULT_PLAN, ...over });
const flows: TrailingFlows = {
  spending: 40_000,
  income: 70_000,
  savings: 30_000,
  loanPayments: 0,
  cash: 0,
  refunds: 0,
  cashWithdrawn: 0,
  cashEntered: 0,
  cashEnteredOn: [],
  cashIous: 0,
  unclearLoans: 0,
  largestRefund: null,
  from: '2025-10-07',
  to: '2026-10-06',
  days: 365,
  scaled: false,
  count: 400,
  excludedCount: 0,
  currency: 'USD',
  leftOut: [],
};
const measured: Measured = { spending: 40_000, savings: 30_000, assets: 250_000 };
const assets = (over: Partial<InvestedAssets> = {}): InvestedAssets => ({
  total: 250_000,
  accounts: [
    { account_id: 'a', name: 'Brokerage', type: 'investment', balance: 150_000, currency: 'USD', institution: 'Vanguard', item_id: 'i1' },
    { account_id: 'b', name: '401(k)', type: 'investment', subtype: '401k', balance: 100_000, currency: 'USD', institution: 'Fidelity', item_id: 'i2' },
  ],
  unknown: 0,
  caveats: [],
  currency: 'USD',
  leftOut: [],
  ...over,
});
const noPlans: WorkplaceSavings = { total: 0, plans: [], fromBank: [], partial: [], shortHistory: [], problems: [], unmeasured: [] };

/** Markup as text, tags dropped and entities decoded, for reading sentences. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');

/** One of Your figures' rows, with the notes under it, by its title. */
const figureRow = (html: string, title: string) => html.match(new RegExp(`<li><button[^>]*><span class="list-row-text"><span class="list-row-title">${title}</span>.*?</li>`))?.[0] ?? '';

/** The level of each notice that says `words`, in the order drawn: a note in
 *  full, or one inside the line that gathers two or more. */
const levels = (html: string, words: string) =>
  [...html.matchAll(/<div class="notice (critical|caution|info)"><svg[^>]*>.*?<\/svg><div><span class="visually-hidden">[^<]*<\/span>(.*?)<\/div><\/div>/g)]
    .filter((m) => text(m[2]).includes(words))
    .map((m) => m[1]);

/** Your path's FI card and the figures it rests on under it, what they say
 *  worked out in the render as PlanTab does, so a render with amounts hidden
 *  (test/hidden-renders.ts) hides the amounts in it. */
function YourPath({ a, currencyNote }: { a: FigureArgs; currencyNote: string | null }) {
  return (
    <>
      <FiCard {...a} currencyNote={currencyNote} />
      <InputsCard figures={figureNotes(a)} view={a.view} money={a.money} onOpen={noop} />
    </>
  );
}

describe('figures', () => {
  test('a success rate never rounds up to 100% or down to 0%', () => {
    expect(successText(1)).toBe('100%');
    expect(successText(0)).toBe('0%');
    expect(successText(0.996)).toBe('>99%');
    expect(successText(0.996, 1)).toBe('99.6%');
    expect(successText(0.9996, 1)).toBe('>99.9%');
    expect(successText(0.004)).toBe('<1%');
    expect(successText(0.973, 1)).toBe('97.3%');
  });

  test('progress never reads 100% short of the target, and says how far past it', () => {
    expect(progressText(0.996)).toBe('>99%');
    expect(progressText(0.61)).toBe('61%');
    expect(progressText(1)).toBe('100%');
    expect(progressText(1.5)).toBe('150%');
  });

  test('percents, whole money, days and months', () => {
    expect(pct(0.04)).toBe('4%');
    expect(pct(0.035)).toBe('3.5%');
    expect(pct(0.0425)).toBe('4.25%');
    expect(wholeMoney(1234.56, 'USD')).toBe('$1,235');
    expect(wholeMoney(-0.4, null)).toBe('$0');
    expect(wholeMoney(1500, 'not a code')).toBe('$1,500'); // a code Intl refuses falls back
    expect(monthName('1965-11')).toBe('Nov 1965');
    expect(dayName('2025-10-07')).toBe('Oct 7, 2025');
  });

  test('the measured window, and a shorter one scaled up', () => {
    expect(windowText(flows)).toBe('your last 12 months of transactions (Oct 7, 2025 to Oct 6, 2026)');
    expect(windowText({ ...flows, scaled: true, days: 152, from: '2026-05-08' })).toBe(
      '5 months of transactions (May 8, 2026 to Oct 6, 2026), scaled up to a year'
    );
    expect(windowText({ ...flows, scaled: true, days: 360, from: '2025-10-12' })).toContain('360 days of transactions');
  });
});

describe('the FI card', () => {
  type Opts = {
    m?: Measured;
    f?: TrailingFlows | null;
    unread?: { institution: string | null; reason: string }[];
    txnsFailed?: boolean;
    a?: InvestedAssets;
    workplace?: WorkplaceSavings | null;
    workplaceCount?: number | null;
    currencyNote?: string | null;
    cashOn?: string[];
    cashUnmarked?: boolean;
  };
  /** What Your path gives the FI card and the Your figures card under it,
   *  from the same inputs (components/PlanTab.tsx). */
  const args = (p: FirePlan, opts: Opts = {}): FigureArgs => ({
    plan: p,
    view: fiView(p, opts.m ?? measured),
    flows: opts.f === undefined ? flows : opts.f,
    unread: opts.unread ?? [],
    withoutTransactions: NO_CONNECTIONS_WITHOUT,
    transactionCount: 0,
    txnsLoading: false,
    txnsFailed: opts.txnsFailed ?? false,
    assets: opts.a ?? assets(),
    balancesAsOf: '2026-10-06T15:12:00Z',
    workplace: opts.workplace === undefined ? noPlans : opts.workplace,
    workplaceCount: opts.workplaceCount === undefined ? 0 : opts.workplaceCount,
    cashOn: opts.cashOn ?? [],
    cashUnmarked: opts.cashUnmarked ?? false,
    money,
    savingsRate: null,
    shareRates: null,
  });
  /** The FI card with the figures it rests on under it, as Your path draws them. */
  const cardHtml = (p: FirePlan, opts: Opts = {}) => renderToStaticMarkup(<YourPath a={args(p, opts)} currencyNote={opts.currencyNote ?? null} />);
  const card = (p: FirePlan, opts: Opts = {}) => text(cardHtml(p, opts));
  /** How a measured figure was worked out: its sheet's Why?. */
  const why = (p: FirePlan, opts: Opts, figure: 'spending' | 'savings') => figureNotes(args(p, opts))[figure].why;

  test('shows the FI number with the inputs it came from, and where each came from', () => {
    const html = cardHtml(plan());
    const t = text(html);
    expect(t).toContain('$1,000,000');
    expect(t).toContain('$40,000 a year ÷ 4% withdrawal rate');
    // Where each comes from is its row's sub (rollout phase 6c); how savings
    // were estimated is behind Why? in its sheet.
    expect(text(figureRow(html, 'Annual spending'))).toContain('Annual spending A year, from transactions $40,000');
    expect(text(figureRow(html, 'Invested assets'))).toMatch(/Invested assets 2 accounts, as of [^$]+ \$250,000/);
    expect(text(figureRow(html, 'Annual savings'))).toContain('Annual savings Estimated from a year $30,000');
    expect(why(plan(), {}, 'savings')).toBe('An estimate: income minus spending over the same 12 months.');
    expect(levels(figureRow(html, 'Annual savings'), "Contributions taken from pay before it reaches a bank (a 401(k) Nya can't see, an employer's match) aren't in bank data.")).toEqual([
      'caution',
    ]);
    expect(t).toContain('25% of the way');
  });

  test('says what the spending includes beyond the Activity tab: loan payments, cash, refunds taken off with the largest', () => {
    const opts: Opts = {
      f: { ...flows, loanPayments: 18_000, cash: 1_200, refunds: 1_800, largestRefund: { amount: 1_500, date: '2026-02-01', name: 'Acme Rentals' }, unclearLoans: 400 },
    };
    expect(why(plan(), opts, 'spending')).toBe(
      'Includes $18,000 of loan payments (principal counts as spending until the loan ends) and $1,200 of cash withdrawals, less $1,800 of refunds (the largest, $1,500 from Acme Rentals on Feb 1, 2026).'
    );
    expect(levels(figureRow(cardHtml(plan(), opts), 'Annual spending'), "$400 of loan payments isn't counted: Plaid doesn't say it is a mortgage, car, student or personal loan")).toEqual(['caution']);
  });

  test('says IOUs you owe from before your transactions begin aren’t counted here, naming the day', () => {
    const scaled = { ...flows, scaled: true, days: 40, from: '2026-08-28' };
    expect(levels(figureRow(cardHtml(plan(), { f: { ...scaled, iousBefore: { count: 1, amount: 25 } } }), 'Annual spending'), "An IOU you owe from before Aug 28, 2026 ($25) isn't counted here: your spending is measured from your transactions, which begin then.")).toEqual([
      'caution',
    ]);
    expect(levels(figureRow(cardHtml(plan(), { f: { ...scaled, iousBefore: { count: 10, amount: 1_000 } } }), 'Annual spending'), "10 IOUs you owe from before Aug 28, 2026 ($1,000) aren't counted here")).toEqual(['caution']);
    expect(card(plan(), { f: scaled })).not.toContain('IOU');
  });

  test('says loan payments not counted by where they came from: Plaid’s, or entered, imported or categorized', () => {
    const spending = figureRow(cardHtml(plan(), { f: { ...flows, unclearLoans: 600, unclearLoansElsewhere: 200 } }), 'Annual spending');
    expect(levels(spending, "$400 of loan payments isn't counted: Plaid doesn't say it is a mortgage, car, student or personal loan")).toEqual(['caution']);
    expect(levels(spending, "$200 of loan payments you entered, imported or categorized isn't counted: nothing says it pays a mortgage, car, student or personal loan rather than a card")).toEqual(['caution']);
    // Only from elsewhere: Plaid isn't blamed.
    const only = cardHtml(plan(), { f: { ...flows, unclearLoans: 200, unclearLoansElsewhere: 200 } });
    expect(text(only)).not.toContain("Plaid doesn't say");
    expect(levels(figureRow(only, 'Annual spending'), '$200 of loan payments you entered, imported or categorized')).toEqual(['caution']);
  });

  test('says which cash counted, withdrawals or the cash spending entered on an account marked cash on hand, never both, and names the account', () => {
    // Withdrawals only.
    expect(why(plan(), { f: { ...flows, cash: 1_200, cashWithdrawn: 1_200 } }, 'spending')).toBe('Includes $1,200 of cash withdrawals.');
    // Some entered by hand on the wallet: the rest of what was withdrawn.
    expect(why(plan(), { f: { ...flows, cash: 700, cashWithdrawn: 1_200, cashEntered: 500 }, cashOn: ['Wallet'] }, 'spending')).toBe(
      'Includes $700 of cash withdrawals beyond the $500 of cash spending you entered on Wallet, taken to be the same money.'
    );
    // All of it entered: the withdrawals aren't counted, and it says so.
    const all = why(plan(), { f: { ...flows, cash: 0, cashWithdrawn: 1_200, cashEntered: 1_500 }, cashOn: ['Wallet', 'Jar'] }, 'spending');
    expect(all).toBe("Cash withdrawals ($1,200) aren't counted: the $1,500 of cash spending you entered on Wallet and Jar is taken to be the same money.");
    expect(all).not.toContain('Includes');
  });

  test('with withdrawals counted beside spending entered on an account not marked as cash, says how to keep them from both counting', () => {
    const hint = 'mark its account as cash on hand (Update the account), so it isn';
    expect(levels(figureRow(cardHtml(plan(), { f: { ...flows, cash: 1_200, cashWithdrawn: 1_200 }, cashUnmarked: true }), 'Annual spending'), hint)).toEqual(['caution']);
    // Not without spending entered by hand, nor once an account is marked.
    expect(card(plan(), { f: { ...flows, cash: 1_200, cashWithdrawn: 1_200 } })).not.toContain(hint);
    expect(card(plan(), { f: { ...flows, cash: 700, cashWithdrawn: 1_200, cashEntered: 500 }, cashOn: ['Wallet'], cashUnmarked: true })).not.toContain(hint);
  });

  test('names what another currency left out of spending and of assets', () => {
    // Ten accounts counted, one left out: under a tenth, so measured from the rest, and said.
    const ten = Array.from({ length: 10 }, (_, i) => ({ ...assets().accounts[0], account_id: `a${i}`, balance: 25_000 }));
    const html = cardHtml(plan(), {
      f: { ...flows, leftOut: [{ currency: 'JPY', count: 2 }] },
      a: assets({ accounts: ten, leftOut: [{ currency: 'EUR', count: 1 }] }),
    });
    expect(levels(figureRow(html, 'Annual spending'), "2 transactions in JPY aren't in your spending or savings, which are in USD.")).toEqual(['caution']);
    expect(levels(figureRow(html, 'Invested assets'), "1 account in EUR isn't in this figure, which is in USD.")).toEqual(['caution']);
    expect(card(plan())).not.toContain("aren't in your spending");
    // More than a tenth (one of three): not measured from the rest, and why (lib/fire/progress.ts assetsGap).
    const gap = cardHtml(plan(), { m: { spending: 40_000, savings: 30_000, assets: null }, a: assets({ leftOut: [{ currency: 'EUR', count: 1 }] }) });
    expect(levels(figureRow(gap, 'Invested assets'), 'Not measured: more than a tenth of what would count, by count, as Nya doesn’t have the ECB’s rates at hand, is in another currency than the Plan’s, USD (1 account in EUR).')).toEqual([
      'caution',
    ]);
  });

  test('says how many transactions the person excluded were left out of spending', () => {
    expect(card(plan())).not.toContain('Leaves out');
    // Under the spending's row, as information: nothing is missing.
    expect(levels(figureRow(cardHtml(plan(), { f: { ...flows, excludedCount: 1 } }), 'Annual spending'), 'Leaves out 1 transaction you excluded from budgets and reports.')).toEqual(['info']);
    expect(card(plan(), { f: { ...flows, excludedCount: 3 } })).toContain('Leaves out 3 transactions you excluded from budgets and reports.');
  });

  test('a figure that may be short says so, beside it and on the FI number, naming the institution', () => {
    const html = cardHtml(plan(), { unread: [{ institution: 'Chase', reason: 'needs to be reconnected' }] });
    expect(levels(figureRow(html, 'Annual spending'), "Transactions from Chase couldn't all be read (the Activity tab says why), so this figure may be low.")).toEqual(['caution']);
    expect(text(html)).toContain("May be low: spending is missing transactions that couldn't be read");
    // Savings could be off either way: the missing rows could be income too.
    expect(levels(figureRow(html, 'Annual savings'), "Transactions from Chase couldn't all be read (the Activity tab says why), so this figure may be off.")).toEqual(['caution']);
    // A typed figure is not affected.
    expect(card(plan({ spending: 50_000, savings: 10_000 }), { unread: [{ institution: 'Chase', reason: 'x' }] })).not.toContain('May be low');
  });

  test('transactions that failed to load are said so, not "not enough"', () => {
    const html = cardHtml(plan(), { m: { spending: null, savings: null, assets: 250_000 }, f: null, txnsFailed: true });
    expect(text(figureRow(html, 'Annual spending'))).toContain("Annual spending Couldn't be loaded --");
    expect(levels(figureRow(html, 'Annual spending'), "Your transactions couldn't be loaded; type your spending, or try again later.")).toEqual(['info']);
    expect(text(html)).not.toContain('Not enough transactions');
  });

  test('balances that are old, missing or unreachable are named with their date', () => {
    const html = cardHtml(plan(), {
      a: assets({
        caveats: [
          { kind: 'unreachable', institution: 'Schwab' },
          { kind: 'stale', institution: 'Vanguard', asOf: '2026-10-03', at: null },
          { kind: 'missing', institution: 'Fidelity', count: 1 },
        ],
      }),
    });
    const invested = figureRow(html, 'Invested assets');
    expect(levels(invested, "Schwab couldn't be reached and isn't counted, so this figure may be low.")).toEqual(['caution']);
    expect(levels(invested, "Vanguard's balances are from Oct 3, 2026")).toEqual(['caution']);
    expect(levels(invested, "1 account at Fidelity couldn't be shown, so this figure may be low.")).toEqual(['caution']);
    expect(text(html)).toContain('Invested assets may be low');
    // Typed instead: what was typed counts, so nothing says it may be low,
    // on the number or under the row.
    const typed = cardHtml(plan({ assets: 300_000 }), { a: assets({ caveats: [{ kind: 'unreachable', institution: 'Schwab' }] }) });
    expect(text(typed)).toContain('$300,000 of $1,000,000 invested · 30% of the way');
    expect(text(typed)).not.toContain('Invested assets may be low');
    expect(text(figureRow(typed, 'Invested assets'))).toContain('Invested assets Typed by you $300,000');
    expect(text(typed)).not.toContain("Schwab couldn't be reached");
  });

  test('savings say what was added for each workplace plan and what counted, what was not and why, and what could not be measured', () => {
    const opts: Opts = {
      workplaceCount: 5,
      workplace: {
        ...noPlans,
        total: 14_000,
        plans: [
          { name: 'Fidelity 401(k)', paidFrom: 'payroll', added: 12_000, count: 24, largest: { date: '2026-03-13', amount: 1_000 }, matched: 0 },
          { name: 'Vanguard Solo 401(k)', paidFrom: null, added: 2_000, count: 1, largest: { date: '2026-06-02', amount: 2_000 }, matched: 10_000 },
        ],
        fromBank: ['Schwab SEP'],
        partial: [{ name: 'Fidelity 401(k)', from: '2026-04-01' }],
        shortHistory: [{ name: 'Empower 457(b)', from: '2026-03-03' }],
        unmeasured: ['TSP TSP'],
      },
    };
    const html = cardHtml(plan(), opts);
    expect(why(plan(), opts, 'savings')).toContain('over the same 12 months, plus $14,000 paid into Fidelity 401(k) and Vanguard Solo 401(k).');
    const savings = figureRow(html, 'Annual savings');
    for (const s of [
      'Fidelity 401(k): 24 contributions added, $12,000, the largest $1,000 on Mar 13, 2026, all of them, as it is set as paid through payroll.',
      'Vanguard Solo 401(k): 1 contribution added, $2,000, the largest $2,000 on Jun 2, 2026.',
      "$10,000 more paid into Vanguard Solo 401(k) matched transfers from your bank to investment and retirement funds, which already count as saved, so it isn't added again.",
      // The sheet it is said in is the row's (rollout phase 6c), not an Edit button's.
      "How Vanguard Solo 401(k) is paid into isn't set: if you pay into it from your bank account, say so in Annual savings, or it may count twice.",
      'Schwab SEP is set as paid from your bank, so nothing paid into it is added again.',
      'Fidelity 401(k) is counted from Apr 1, 2026',
      'Nya has activity for Empower 457(b) from Mar 3, 2026.',
      "Contributions to TSP TSP couldn't be measured, so this figure may be low.",
    ]) {
      expect(levels(savings, s)).toEqual(['caution']);
    }
    expect(text(html)).not.toContain("How Fidelity 401(k) is paid into isn't set");
    expect(text(html)).not.toContain('under Edit');
    expect(levels(figureRow(cardHtml(plan(), { workplace: null, workplaceCount: null }), 'Annual savings'), 'Checking contributions to workplace plans')).toEqual(['caution']);
  });

  test('a currency mismatch is said beside the figures', () => {
    expect(card(plan(), { currencyNote: 'Your investments are in EUR and your spending in USD.' })).toContain('Your investments are in EUR and your spending in USD.');
  });

  test('progress just short of the target does not read 100%', () => {
    expect(card(plan(), { m: { ...measured, assets: 996_000 } })).toContain('>99% of the way');
  });

  test('a typed figure says so', () => {
    expect(text(figureRow(cardHtml(plan({ spending: 60_000 })), 'Annual spending'))).toContain('Annual spending Typed by you $60,000');
  });

  test('says what is missing instead of showing a zero', () => {
    const html = cardHtml(plan(), { m: { spending: null, savings: null, assets: null }, f: null, a: assets({ total: null, accounts: [] }) });
    const t = text(html);
    expect(t).toContain('Needs your annual spending');
    expect(text(figureRow(html, 'Annual spending'))).toContain('Annual spending Not enough transactions yet --');
    expect(t).toContain('Needs your age and stop age.');
    expect(t).not.toContain('$0');
  });

  test('Coast FI and the years to FI, with ages', () => {
    const t = card(plan({ age: 35, targetAge: 50 }));
    expect(t).toContain('With this much invested today you could stop saving now: growing 5% a year after inflation, it reaches your FI number by age 50.');
    expect(t).toMatch(/about \d+(\.\d)? years/);
    expect(t).toContain('Around age');
    // The simulation is on another segment (rollout phase 6b).
    expect(t).toContain("Real markets don't move steadily; the simulation on Stress test shows how much that matters.");
  });
});

describe('the caveat sentences', () => {
  test('name every institution once', () => {
    expect(
      unreadText(
        [
          { institution: 'Chase', reason: 'a' },
          { institution: 'Chase', reason: 'b' },
          { institution: 'Amex', reason: 'c' },
        ],
        'low'
      )
    ).toBe("Transactions from Chase and Amex couldn't all be read (the Activity tab says why), so this figure may be low.");
    expect(unreadText([{ institution: null, reason: 'Could not load transactions.' }], 'low')).toContain("Your latest transactions couldn't be loaded");
    expect(unreadText([], 'low')).toBeNull();
    expect(
      assetCaveatLines([
        { kind: 'unreachable', institution: 'A' },
        { kind: 'unreachable', institution: 'B' },
      ])
    ).toEqual(["A and B couldn't be reached and aren't counted, so this figure may be low."]);
  });
});

describe('the simulation card', () => {
  const us = usMarket();
  const render = (p: FirePlan, m = measured, opts: { pending?: boolean; noOutcome?: boolean; outcome?: Outcome; badge?: string } = {}) => {
    const view = fiView(p, m);
    const engine = enginePlan(p, view);
    const outcome = opts.outcome ?? ('sim' in engine && !opts.noOutcome ? { result: simulate(p.method, engine.sim, us) } : null);
    return renderToStaticMarkup(
      <SimulationCard
        plan={p}
        view={view}
        engine={engine}
        outcome={outcome}
        pending={opts.pending ?? false}
        money={money}
        currency="USD"
        badge={opts.badge ?? null}
        onRetry={noop}
      />
    );
  };
  const read = (p: FirePlan, m = measured, opts: { pending?: boolean; noOutcome?: boolean; outcome?: Outcome; badge?: string } = {}) => text(render(p, m, opts));

  // Since rollout 6d its settings are the Assumptions sheet's (below), the
  // full statement and the data are About these numbers', and the card
  // keeps the short label and what it takes from Your path.
  test('the success rate with its definition, the short label, the worst years, and its method named', () => {
    const html = render(plan({ targetAge: 65, horizon: 30 }), measured, {});
    const t = text(html);
    expect(html).toContain('<h3>Will it last?</h3><span class="meta">Historical cycles</span>');
    expect(t).toContain('Stop working at 65 with $1,000,000 (your FI number), withdrawing 4% of it, $40,000 a year after tax, your spending now, for 30 years (to age 95)');
    expect(t).toMatch(/9\d\.\d% of 1,470 historical starts \(Jan 1871 to Jun 1993\) lasted 30 years/);
    expect(t).toContain("Success: the portfolio never ran out. Every year's withdrawal was paid in full for all 30 years.");
    expect(html).toContain('<p class="plan-definition">Hypothetical, from US history: not a prediction, and not advice.</p>');
    // Behind its disclosure.
    expect(html).toMatch(/<details class="why"><summary>Worst starting years<\/summary>/);
    expect(t).toMatch(/(Nov|Oct|Dec|Jan) 196\d ran out in year \d+ \(age \d+\)/);
    // Said once, in the sheet and About these numbers.
    expect(t).not.toContain('Withdrawals once a year');
    expect(t).not.toContain('Mix: 75% stocks');
    expect(t).not.toContain('the S&P Composite');
    expect(t).not.toContain('From Your path');
    expect(html).not.toContain('Change');
  });

  test('what it takes from Your path, in its words; the badge when the notice is about it', () => {
    const p = plan({
      age: 40,
      targetAge: 65,
      horizon: 30,
      income: [{ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true }],
      expenses: [{ id: 'roof', label: 'Roof', amount: 30_000, atAge: 70 }],
    });
    const html = render(p, measured, { badge: 'Inputs may be low' });
    const t = text(html);
    expect(html).toContain('<h4 class="plan-heading">From Your path</h4>');
    expect(t).toContain('Social Security: $24,000 a year after tax from age 67, rising with inflation.');
    expect(t).toContain("Roof: $30,000 at age 70, on top of the year's spending.");
    expect(html).toContain('<div class="plan-card-badge"><span class="badge warn">Inputs may be low</span></div>');
  });

  // Starting from what you have, the headline answers "could I stop now?".
  test('starting from your invested assets withdraws your spending, and says the rate that implies', () => {
    const t = read(plan({ age: 45, start: 'assets', horizon: 30 }), { spending: 60_000, savings: 10_000, assets: 600_000 });
    expect(t).toContain('Stop working today, at 45, with $600,000 (your invested assets), spending what you spend now, $60,000 a year after tax');
    expect(t).toContain('That is a 10% withdrawal rate, above the 4% your FI number assumes.');
    // And the success rate is for that spending: a 10% rate rarely lasts 30 years.
    expect(t).toMatch(/\b\d{1,2}(\.\d)?% of 1,470 historical starts/);
    expect(t).not.toMatch(/\b9\d(\.\d)?% of 1,470/);
  });

  test('Monte Carlo says how it was made', () => {
    const t = read(plan({ method: 'monte-carlo', horizon: 30 }));
    expect(t).toContain('Will it last? Monte Carlo');
    expect(t).toContain('of 5,000 Monte Carlo runs lasted 30 years');
    expect(t).not.toContain('Worst starting years');
  });

  test('a flexible rule shows how far spending fell beside the success rate', () => {
    const t = read(plan({ rule: 'guardrails', horizon: 30 }));
    expect(t).toMatch(/\d+% of the first year's spending in the lowest year, in the worst start that lasted \(\w{3} \d{4}\): \$[\d,]+ against \$40,000/);
    expect(t).toContain('This rule lasts by cutting spending when markets fall; the second figure is how far.');
    expect(read(plan({ rule: 'percent', horizon: 30 }))).toContain('it cannot run out');
    expect(read(plan({ horizon: 30 }))).not.toContain("of the first year's spending in the lowest year");
  });

  test('VPW sets its own spending, and says how it compares with yours', () => {
    const t = read(plan({ rule: 'vpw', horizon: 30 }));
    expect(t).toContain("VPW sets each year's spending from the balance and the years left.");
    expect(t).toMatch(/Its first year spends \$[\d,]+ after tax, against the \$40,000 you spend now/);
  });

  // The last answer answered other assumptions: while the new one is worked
  // out it keeps its place (nothing jumps) but is hidden, and so is what it
  // took from Your path, which describes the answer shown.
  test('a new answer being worked out hides the last one, what it took and all; the first shows a placeholder', () => {
    const p = plan({ age: 40, horizon: 30, income: [{ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true }] });
    const html = render(p, measured, { pending: true });
    expect(html).toContain('plan-result plan-result-pending');
    expect(html).toContain('role="status">Working out the new answer');
    const start = html.indexOf('plan-result plan-result-pending');
    expect(html.indexOf('plan-stat-value')).toBeGreaterThan(start);
    expect(html.indexOf('plan-assumptions')).toBeGreaterThan(start);
    expect(render(plan({ horizon: 30 }))).not.toContain('plan-result-pending');
    expect(read(plan({ horizon: 30 }), measured, { noOutcome: true })).toContain('Working it out');
  });

  test('a simulation that could not be run says so and offers to try again; a refused plan says why', () => {
    const t = read(plan({ horizon: 30 }), measured, { outcome: { error: 'Failed to load chunk', unavailable: true } });
    expect(t).toContain("The simulation couldn't be loaded. It needs a connection the first time it runs after an update.");
    // The figures that don't depend on it are on the other segments.
    expect(t).toContain("The figures on Your path and Portfolio don't depend on it.");
    expect(t).toContain('Try again');
    expect(t).not.toContain("This plan can't be simulated");
    const refused = read(plan({ horizon: 30 }), measured, { outcome: { error: 'a plan runs 1 to 60 years' } });
    expect(refused).toContain("This plan can't be simulated: a plan runs 1 to 60 years.");
    expect(refused).not.toContain('Try again');
  });

  test('a start the walk never gets to says so, and that the FI card saying why is on Your path', () => {
    const p = plan({ age: 40, targetAge: 45, horizon: 30 });
    const view = fiView(p, measured);
    const t = text(
      renderToStaticMarkup(
        <SimulationCard
          startsWith={{ balance: 1_000_000, from: 'fi-number', atAge: 45, projected: null, short: { year: 3, have: 120_000, need: 200_000, kind: 'cost' }, more: true }}
          plan={p}
          view={view}
          engine={enginePlan(p, view)}
          outcome={null}
          pending={false}
          money={money}
          currency="USD"
          onRetry={noop}
        />
      )
    );
    expect(t).toContain('It starts with $1,000,000, your FI number at 45: it would never get that far (on Your path): it starts with money it wouldn’t have then, so it reads safer than it is.');
  });

  test('explains what is missing instead of simulating nothing', () => {
    expect(read(plan(), { spending: null, savings: null, assets: null })).toContain('withdraws your annual spending, so it needs it');
    expect(read(plan({ start: 'assets' }), { spending: 40_000, savings: null, assets: null })).toContain('none to count yet');
  });

  test('what it needs and isn’t measured is said so, in compare mode’s words, never as none to count (review round 3)', () => {
    const assets = read(plan({ start: 'assets' }), { spending: 40_000, savings: 30_000, assets: null, unmeasured: ['assets'] });
    // Said on Stress test, of the figures on Your path (rollout phase 6b),
    // whose rows say why (6c).
    expect(assets).toContain('The simulation starts with your invested assets, which aren’t measured (Your path says why). Type them on Your path, or start from your FI number (Assumptions, below).');
    expect(assets).not.toContain('none to count yet');
    const spending = read(plan(), { spending: null, savings: null, assets: 300_000, unmeasured: ['spending', 'savings'] });
    expect(spending).toContain('The simulation withdraws your annual spending, which isn’t measured (Your path says why). Type it on Your path.');
    expect(spending).not.toContain('connect accounts with transactions');
  });
});

describe('the grid', () => {
  const cell = (rate: number, years: number, successRate: number, low = 1) => ({
    rate,
    years,
    successRate,
    lowestSpendingShare: low,
    paths: 1470,
    firstStart: '1871-01',
    lastStart: '1993-06',
  });

  test('never shows a rate that rounds to 100% as 100%, outlines the plan, and says where its starts end', () => {
    const html = renderToStaticMarkup(
      <PlanGrid
        cells={[cell(0.04, 30, 0.999), cell(0.05, 30, 0.8)]}
        rates={[0.04, 0.05]}
        horizons={[30, 40]}
        current={{ rate: 0.04, years: 30 }}
        flexible={false}
        pathsNoun="starts"
      />
    );
    expect(text(html)).toContain('>99%');
    expect(html).toContain('80%');
    expect(html).toContain('plan-grid-cell own');
    expect(html).toContain('4% for 30 years: 99.9% of 1,470 starts lasted');
    expect(html).toContain('to 1993');
    expect(html).toContain('1,470 starts, 1871-01 to 1993-06');
    // A cell still being worked out says so rather than showing a number.
    expect(html).toContain('4% for 40 years: working it out');
    expect(html).not.toContain('plan-grid-low');
  });

  test('a cell that could not be worked out says so, rather than waiting forever', () => {
    const html = renderToStaticMarkup(
      <PlanGrid
        cells={[cell(0.04, 30, 0.97)]}
        failed={[{ rate: 0.05, years: 30 }]}
        rates={[0.04, 0.05]}
        horizons={[30]}
        current={{ rate: 0.04, years: 30 }}
        flexible={false}
        pathsNoun="starts"
      />
    );
    expect(html).toContain("5% for 30 years: couldn&#x27;t be worked out");
    expect(html).not.toContain('working it out');
    const p = plan({ horizon: 30 });
    const t = text(
      renderToStaticMarkup(
        <GridCard
          plan={p}
          cells={[cell(0.04, 30, 0.97)]}
          failed={[{ rate: 0.05, years: 30 }]}
          unavailable
          onRetry={noop}
          rates={[0.04, 0.05]}
          years={[30]}
          current={{ rate: 0.04, years: 30 }}
          startBalance={1_000_000}
          money={money}
        />
      )
    );
    expect(t).toContain("One cell couldn't be worked out: the simulation couldn't be loaded, which needs a connection the first time after an update.");
    expect(t).toContain('Try again');
  });

  // The screen review: brass washed behind each figure. The shade is neutral
  // now (its colors in .plan-grid-cell.scored), each scored cell carrying its
  // share; brass is only the plan's own outline.
  test('cells are shaded by success on a neutral ramp, never brass behind a figure', () => {
    const html = renderToStaticMarkup(
      <PlanGrid
        cells={[cell(0.04, 30, 1), cell(0.05, 30, 0.75), cell(0.06, 30, 0.4)]}
        rates={[0.04, 0.05, 0.06, 0.07]}
        horizons={[30]}
        current={{ rate: 0.05, years: 30 }}
        flexible={false}
        pathsNoun="starts"
      />
    );
    const cells = [...html.matchAll(/<td class="([^"]*)"( style="([^"]*)")?/g)].map((m): [string, string | null] => [m[1], m[3] ?? null]);
    expect(cells).toEqual([
      ['num plan-grid-cell scored', '--shade:100.0%'],
      ['num plan-grid-cell own scored', '--shade:50.0%'],
      ['num plan-grid-cell scored', '--shade:0.0%'],
      // Still being worked out: no shade at all.
      ['num plan-grid-cell', null],
    ]);
    expect(html).not.toContain('--accent');
  });

  test("a flexible rule's cells carry how far spending fell", () => {
    const html = renderToStaticMarkup(
      <PlanGrid cells={[cell(0.04, 30, 1, 0.42)]} rates={[0.04]} horizons={[30]} current={{ rate: 0.04, years: 30 }} flexible pathsNoun="starts" />
    );
    expect(html).toContain('low 42%');
    expect(html).toContain("the lowest year&#x27;s spending was 42% of the first year&#x27;s");
  });

  test('the card works the grid out for the plan, with each column’s starts named', () => {
    const p = plan({ horizon: 30 });
    const e = enginePlan(p, fiView(p, measured)) as { sim: any };
    const cells = successGrid('historical', e.sim, usMarket(), [0.03, 0.04], [30, 50]);
    const t = text(
      renderToStaticMarkup(
        <GridCard plan={p} cells={cells} rates={[0.03, 0.04]} years={[30, 50]} current={{ rate: 0.04, years: 30 }} startBalance={e.sim.startBalance} money={money} />
      )
    );
    expect(t).toContain('The share of starts that lasted, each starting with $1,000,000');
    expect(t).toContain('30 years, 1,470 starts over 123 years (to Jun 1993); 50 years, 1,230 starts over 103 years (to Jun 1973)');
    expect(t).toContain('which is why it can read safer than a shorter one');
  });

  test('VPW gets one row, by length', () => {
    const p = plan({ rule: 'vpw', horizon: 30 });
    const e = enginePlan(p, fiView(p, measured)) as { sim: any };
    const cells = successGrid('historical', e.sim, usMarket(), [], [30]);
    expect(cells).toHaveLength(1);
    expect(cells[0].rate).toBeNull();
    const t = text(
      renderToStaticMarkup(<GridCard plan={p} cells={cells} rates={[null]} years={[30]} current={{ rate: null, years: 30 }} startBalance={1} money={money} />)
    );
    expect(t).toContain('VPW has no withdrawal rate to vary');
    expect(t).toMatch(/VPW 100% low \d+%/);
  });
});

describe('the fan chart', () => {
  test('draws the bands and the median, with a table of the same figures', () => {
    const bands = { p10: [100, 80, 0], p25: [100, 90, 50], p50: [100, 105, 110], p75: [100, 120, 150], p90: [100, 140, 200] };
    const html = renderToStaticMarkup(<PlanFanChart bands={bands} startAge={60} currency="USD" />);
    expect(html.match(/<path /g)).toHaveLength(3);
    expect(text(html)).toContain('Median $110');
    expect(text(html)).toContain('at the end (age 62) · middle 80%: $0 to $200');
    expect(text(html)).toContain('Show as a table');
    expect(html).toContain('<td>62</td>');
  });

  // Drawn at its width (rollout 6d): a viewBox unit to a CSS pixel, so its
  // 12px figures and ages are 12px, in the shape it had (160 to 340).
  const forty = (n: number) => Array.from({ length: 41 }, (_, i) => n * (1 + i / 10));
  const wide = { p10: forty(400_000), p25: forty(600_000), p50: forty(800_000), p75: forty(1_000_000), p90: forty(1_400_000) };
  const at = (width: number) =>
    renderToStaticMarkup(
      <DrawnWidth.Provider value={width}>
        <PlanFanChart bands={wide} startAge={55} currency="USD" />
      </DrawnWidth.Provider>
    );
  const ys = (html: string) => [...html.matchAll(/<text class="chart-tick" x="[^"]*" y="([^"]*)"/g)].map((m) => Number(m[1]));
  const ages = (html: string) => [...html.matchAll(/<text class="chart-xlabel"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);

  test('is drawn at its width, its text at 12px, in its shape', () => {
    const phone = at(248);
    expect(phone).toContain('class="chart-svg at-width"');
    expect(phone).toContain('viewBox="0 0 248 117"');
    expect(at(600)).toContain('viewBox="0 0 600 282"');
  });

  test('keeps its gridlines 20px apart and its ages from running into each other', () => {
    for (const width of [248, 340, 600]) {
      const y = ys(at(width));
      expect(y.length).toBeGreaterThanOrEqual(2);
      for (let k = 1; k < y.length; k++) expect(Math.abs(y[k] - y[k - 1])).toBeGreaterThanOrEqual(20);
    }
    // 40 years at a phone's width: every 10 years, the first saying "age".
    expect(ages(at(248))).toEqual(['age 55', '65', '75', '85', '95']);
    // On a wide card, every 5.
    expect(ages(at(600))).toEqual(['age 55', '60', '65', '70', '75', '80', '85', '90', '95']);
  });
});

describe('income and one-offs', () => {
  test('lists them, and says when one is left out of the simulation or comes after it', () => {
    const p = plan({
      income: [{ id: 'ss', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true }],
      expenses: [{ id: 'roof', label: 'Roof', amount: 30_000, atAge: 60 }],
    });
    const t = text(renderToStaticMarkup(<EventsCard plan={p} engine={enginePlan(p, fiView(p, measured))} money={money} editable open={noop} />));
    expect(t).toContain('Social Security $24,000 a year from age 67, after tax, rises with inflation. Not in the simulation: add your age.');
    expect(t).toContain('Roof $30,000 at age 60. Not in the simulation');
    const aged = plan({ ...p, targetAge: 50, horizon: 5 });
    const late = text(renderToStaticMarkup(<EventsCard plan={aged} engine={enginePlan(aged, fiView(aged, measured))} money={money} editable open={noop} />));
    expect(late).toContain("Roof $30,000 at age 60. After the plan ends at 55: only the grid's longer columns reach it.");
  });
});

describe('a saved plan this version cannot use as it is', () => {
  test('says what is used instead, and that only "Save it this way" saves it', () => {
    const t = text(
      renderToStaticMarkup(
        <RepairCard
          fixed={[{ field: 'withdrawalRate' }, { field: 'income', item: { label: 'Pension', amount: 2e7, age: 65 } }]}
          editable
          onSave={noop}
          money={money}
        />
      )
    );
    expect(t).toContain('Your saved plan has values this version of Nya can\'t use: the withdrawal rate and the income "Pension".');
    expect(t).toContain('The figures below use the defaults instead and leave out what is named.');
    expect(t).toContain('Nothing is saved until you choose Save it this way, and editing is paused until then, so nothing is dropped by accident.');
    expect(t).toContain('Save it this way');
    expect(text(renderToStaticMarkup(<RepairCard fixed={[{ field: 'horizon' }]} editable onSave={noop} money={money} />))).toContain(
      'has a value this version of Nya can\'t use: the length.'
    );
  });

  test('names an income or one-off with no label by what it was', () => {
    const t = text(
      renderToStaticMarkup(
        <RepairCard
          fixed={[
            { field: 'income', item: { label: '   ', amount: 24_000, age: 67 } },
            { field: 'expenses', item: { label: '', amount: 30_000, age: 60 } },
          ]}
          editable
          onSave={noop}
          money={money}
        />
      )
    );
    expect(t).toContain('an income of $24,000 a year from age 67 and a one-off of $30,000 at age 60.');
    expect(t).not.toContain('"   "');
  });

  test('a rate the formulas cannot take leaves the figures out, never crashes the card', () => {
    const p = plan({ withdrawalRate: 2, taxRate: 1.5 });
    const t = text(
      renderToStaticMarkup(
        <FiCard
          plan={p}
          view={fiView(p, measured)}
          unread={[]}
          assets={assets()}
          currencyNote={null}
          money={money}
        />
      )
    );
    expect(t).toContain('Financial independence --');
    expect(t).toContain("Can't be worked out from the saved withdrawal rate, tax or growth after inflation: change them under Assumptions.");
  });
});

describe('the savings sheet', () => {
  test('lets each workplace plan be set as paid through payroll, from the bank, or not set, and says what each means', () => {
    const html = renderToStaticMarkup(
      <FigureForm
        plan={plan({ planFunding: [{ account_id: 'solo', paidFrom: 'bank' }] })}
        onSave={async () => true}
        onDone={noop}
        editable
        kind="savings"
        measured={30_000}
        measuredText="from your last 12 months"
        currency="USD"
        workplacePlans={[
          { account_id: 'k', label: 'Fidelity 401(k)' },
          { account_id: 'solo', label: 'Vanguard Solo 401(k)' },
        ]}
      />
    );
    const t = text(html);
    expect(t).toContain('Payroll : every contribution is added');
    expect(t).toContain('My bank : none is, since the transfers that paid for them already count as saved');
    expect(t).toContain('Not set : a contribution is added unless a transfer from your bank to investment and retirement funds paid for it.');
    expect(html).toContain('aria-label="How Fidelity 401(k) is paid into"');
    // Which choice is checked for each: not set for the 401(k), the bank for the Solo 401(k).
    const pressed = [...html.matchAll(/aria-checked="true"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(pressed).toEqual(['Nya’s figure', 'Not set', 'My bank']);
  });
});

describe('the tab', () => {
  test('shows its skeleton in each segment until the saved plan has loaded, never the defaults as if they were saved, under the bar', () => {
    const html = renderToStaticMarkup(<PlanTab txns={[]} txnsLoading={false} txnNotes={[]} institutions={[]} balancesAsOf={null} currency="USD" holdings={[]} />);
    expect(html.match(/<p class="visually-hidden" role="status">Loading your plan<\/p>/g)?.length).toBe(3);
    expect(html).not.toContain('class="spinner"');
    expect(html).not.toContain('FI number');
    // The bar is there already, its heading for Home's FI line to land on.
    expect(html).toContain('<h2 id="plan-title" class="plan-title" tabindex="-1">Your plan</h2>');
  });
});

describe('loading the tab', () => {
  test('a failed import is forgotten, so trying again imports again', async () => {
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new Error('chunk failed'));
    };
    await expect(loadPlanTab(failing)).rejects.toThrow('chunk failed');
    await expect(loadPlanTab(failing)).rejects.toThrow('chunk failed');
    expect(calls).toBe(2);
    const mod = await loadPlanTab(() => import('@/components/PlanTab'));
    expect(typeof mod.default).toBe('function');
    // Once loaded, it is kept.
    expect(await loadPlanTab(failing)).toBe(mod);
    expect(calls).toBe(2);
  });

  test('says what happened, keeps the other tabs, and offers to try again', () => {
    const load = text(renderToStaticMarkup(<PlanUnavailable reason="load" onRetry={noop} />));
    expect(load).toContain(
      "The Plan tab couldn't be loaded. It needs a connection the first time it opens after an update. The other tabs work as before."
    );
    expect(load).toContain('Try again');
    expect(load).toContain('Reload the page');
    expect(text(renderToStaticMarkup(<PlanUnavailable reason="crash" onRetry={noop} />))).toContain('ran into a problem and stopped');
  });
});
