import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MASK, setAmountsHidden } from '@/lib/format';
import { ConnectionView, SharingListView, SharedWithMeView, SharedAccountItem, PreviewView, sharedProblem, readSharedWithMe, rememberShares, rememberedShares, sharedSeenKey, type Choice } from '@/components/Sharing';
import { LOCAL_CACHE_KEY } from '@/components/device-cache';
import { SharedViewsList, outlookWords } from '@/components/SharedViews';
import { seenText, kindsText, viewsToSave, sameViews } from '@/components/ShareKinds';
import { shownText } from '@/components/SharingDates';
import type { GoalsView, SharedViews } from '@/lib/share-kinds';

// What the other kinds of share look like (#45 step 3): on the card of the
// one they're shared with, in the sharer's preview, and in the drawer where
// they are chosen, with what they could work out from all of it. Every
// amount hidden when amounts are, a percentage kept, and each hidden amount
// said as "hidden".

/** As in a browser's page: only there can amounts be hidden. */
function hidden<T>(fn: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const none = g.window === undefined;
  if (none) g.window = {};
  try {
    setAmountsHidden(true);
    return fn();
  } finally {
    setAmountsHidden(false);
    if (none) delete g.window;
  }
}
afterEach(() => setAmountsHidden(false));

// The file's own clock, the day its views are as of: a month or a day of
// this year is named without its year, so against the real clock their
// dates, all in 2026, would read differently from 2027 on.
beforeAll(() => setSystemTime(new Date('2026-10-20T15:00:00Z')));
afterAll(() => setSystemTime());

const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
/** The page as text, tags dropped. */
const text = (html: string) => decode(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
/** What a screen reader is given: the text, without what is hidden from it,
 *  and a chart said by its own label (components/NetWorthChart.tsx, an image
 *  whose axis is drawn, never read). */
const spoken = (html: string) => text(html.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<span aria-hidden="true">[^<]*<\/span>/g, ' '));
/** A figure, as any formatter could write one: a currency symbol by a digit,
 *  or cents. Never a percentage. */
const AMOUNT = /\$\s?\d|\d[\d,]*\.\d{2}(?!\d|%)/;

const VIEWS: SharedViews = {
  net_worth: {
    detail: 'history',
    currency: 'USD',
    total: 321_480,
    as_of: '2026-10-20',
    from: '2026-10-18',
    other_currencies: [{ currency: 'EUR', accounts: 1 }],
    without_balance: 0,
    history: [
      { date: '2026-10-04', value: 318_250.5, estimated: true },
      { date: '2026-10-11', value: 320_000 },
      { date: '2026-10-18', value: 321_400 },
    ],
    accounts: [
      { label: 'Chase Checking ••1111', balance: 1250, currency: 'USD', debt: false, as_of: '2026-10-19' },
      { label: 'Chase Card ••2222', balance: 310, currency: 'USD', debt: true, as_of: '2026-10-19' },
    ],
  },
  spending: {
    detail: 'amounts',
    by: 'category',
    currency: 'USD',
    months: [
      {
        month: '2026-10',
        so_far: true,
        total: 1357.5,
        groups: [
          { name: 'Housing', pct: 88, label: '88%', amount: 1200, categories: [{ name: 'Rent', pct: 88, label: '88%', amount: 1200 }] },
          { name: 'Food', pct: 12, label: '12%', amount: 157.5, categories: [{ name: 'Coffee', pct: 12, label: '12%', amount: 157.5 }] },
        ],
        left_out: 'What went out in EUR isn’t in these totals, which are in USD.',
      },
      {
        month: '2026-09',
        so_far: false,
        total: 15.99,
        groups: [{ name: 'Fun', pct: 100, label: '100%', amount: 15.99, categories: [{ name: 'Streaming', pct: 100, label: '100%', amount: 15.99 }] }],
        left_out: null,
      },
    ],
  },
  holdings: {
    detail: 'amounts',
    currency: 'USD',
    as_of: '2026-10-20',
    from: '2026-10-18',
    total: 20_500,
    classes: [
      { slot: 'us-stocks', name: 'US stocks', pct: 98, label: '98%', amount: 20_000 },
      { slot: 'unclassified', name: 'Unclassified', pct: 2, label: '2%', amount: 500 },
    ],
    buckets: [{ slot: 'tax-deferred', name: 'Tax-deferred', pct: 100, label: '100%', amount: 20_500 }],
    positions: [{ ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', class: 'US stocks', pct: 98, label: '98%', amount: 20_000 }],
    notes: ['Unclassified is money Nya can’t place in a class: a fund it doesn’t know, or money no position explains.'],
  },
  budgets: {
    detail: 'amounts',
    by: 'category',
    currency: 'USD',
    months: [
      {
        month: '2026-10',
        total: { name: 'All budgets', pct: 69, label: '69%', over: false, spent: 1242.5, limit: 1800 },
        groups: [
          { name: 'Food', pct: 43, label: '43%', over: false, spent: 42.5, limit: 100, categories: [{ name: 'Food and drink', pct: 43, label: '43%', over: false, spent: 42.5, limit: 100 }] },
        ],
        left_out: null,
        may_be_incomplete: true,
      },
      { month: '2026-09', total: { name: 'All budgets', pct: 0, label: '0%', over: false, spent: 0, limit: 1800 }, groups: [], left_out: null, may_be_incomplete: false },
    ],
  },
  goals: {
    detail: 'amounts',
    goals: [
      {
        name: 'Rainy day',
        state: 'tracked',
        pct: 33,
        label: '33%',
        currency: 'USD',
        saved: 1000,
        target: 3000,
        target_date: '2030-01-31',
        outlook: { status: 'on_track', completion: '2028-06', beyond: false, date_passed: false },
        as_of: '2026-10-19',
      },
      { name: 'Someday', state: 'untracked', pct: null, label: null, currency: null, target: 800, target_date: null, outlook: null, as_of: null },
    ],
  },
};

const card = (views: SharedViews = VIEWS) =>
  renderToStaticMarkup(<SharedWithMeView data={{ shared: [{ connection: 'c1', label: 'Sam', accounts: [], expires_at: null, views }] }} />);

/** Each notice drawn (components/TotalCaveats.tsx Notice), with its level
 *  and its words, a gathered one's too: a closed <details> keeps them in
 *  the page. */
const notices = (html: string) =>
  [...html.matchAll(/<div class="notice (critical|caution|info|done)"[^>]*>([\s\S]*?)<\/div><\/div>/g)].map((m) => ({ level: m[1], words: text(m[2]).trim() }));
/** The level of the one notice that says `words`: it must be said once,
 *  on the whole card too, so no grey copy is left behind. */
const levelOf = (html: string, words: string) => {
  const found = notices(html).filter((n) => n.words.includes(words));
  expect(found.map((n) => n.words)).toHaveLength(1);
  expect(text(html).split(words)).toHaveLength(2);
  return found[0].level;
};
/** Whether `first` is drawn before `then`: a caveat under its figure comes
 *  before the rows under it. */
const before = (html: string, first: string, then: string) => {
  const page = text(html);
  expect(page).toContain(first);
  expect(page).toContain(then);
  return page.indexOf(first) < page.indexOf(then);
};

describe('on the card of the one it is shared with', () => {
  test('each kind, with its as-of day, its figures and its words', () => {
    const page = text(card());
    for (const words of [
      'Shared by Sam',
      'Net worth',
      'Spending',
      'Holdings',
      'Budgets',
      'Goals',
      'As of today',
      '$321,480.00',
      '1 account in EUR isn’t in this total',
      'Only the accounts whose balances are shared are listed.',
      '$1,357.50',
      'October 2026, so far',
      'What went out in EUR isn’t in these totals, which are in USD.',
      'Housing',
      'Rent',
      'US stocks',
      'Tax-deferred',
      'positions and balances from Oct 18 on',
      'VTI',
      '$42.50 of $100.00',
      'This month, October 2026',
      'Last month, September 2026',
      'What is spent in October 2026 may be off: some of its transactions may not all be in, or couldn’t all be read.',
      'Rainy day',
      '$1,000.00 of $3,000.00',
      'On track for June 2028, ahead of January 2030',
      'Not tracked against an account',
      'Chase Card ••2222',
      '$310.00 owed',
    ]) {
      expect(page).toContain(words);
    }
  });

  test('with amounts hidden, no figure is shown, every percentage stays, and each hidden amount is said as "hidden"', () => {
    const html = hidden(() => card());
    expect(html).toContain(MASK);
    const lines = text(html).split(/\s{2,}|(?<=\.) /);
    expect(lines.filter((l) => AMOUNT.test(l))).toEqual([]);
    // The proportions stay: they say no amount.
    for (const pct of ['88%', '98%', '100%', '33% of the way']) expect(text(html)).toContain(pct);
    // A screen reader hears "hidden", never the bullets.
    expect(spoken(html)).not.toContain(MASK);
    expect(spoken(html)).toContain('hidden');
    for (const m of html.matchAll(/aria-label="([^"]*)"/g)) expect(m[1]).not.toContain(MASK);
    // The bars are drawn the same either way.
    const widths = (h: string) => [...h.matchAll(/width:\s*([\d.]+)%/g)].map((m) => m[1]);
    expect(widths(html)).toEqual(widths(card()));
  });

  test('a kind that couldn’t be read says so, and nothing of it', () => {
    const page = text(card({ budgets: { unreadable: true }, goals: VIEWS.goals }));
    expect(page).toContain('Sam’s budgets couldn’t be read just now, so none of it is shown.');
    expect(page).toContain('Rainy day');
  });

  test('at the percentage levels, only percentages', () => {
    const page = text(
      card({
        spending: {
          detail: 'shares',
          by: 'group',
          currency: 'USD',
          months: [{ month: '2026-10', so_far: true, groups: [{ name: 'Housing', pct: 88, label: '88%' }, { name: 'Food', pct: 0, label: '<1%' }], left_out: null }],
        },
        budgets: {
          detail: 'progress',
          by: 'group',
          currency: 'USD',
          months: [{ month: '2026-10', total: { name: 'All budgets', pct: 69, label: '69%', over: false }, groups: [{ name: 'Food', pct: 112, label: '112%', over: true }], left_out: null, may_be_incomplete: false }],
        },
        goals: { detail: 'progress', goals: [{ ...(VIEWS.goals as GoalsView).goals[0], saved: undefined, target: undefined }] },
      })
    );
    expect(page).not.toMatch(AMOUNT);
    // Money that is there never reads 0%.
    expect(page).toContain('<1%');
    // Over said in its word, beside the name.
    expect(page).toContain('Food Over 112% spent');
    expect(page).toContain('33%');
  });

  test('each percentage in the words the server sent, which knew the amount: never 0% for money that is there, nor 100% short of the whole, nor <1% for nothing', () => {
    const goal = (VIEWS.goals as GoalsView).goals[0];
    const page = text(
      card({
        // $1 spent of $500, and nothing yet.
        budgets: {
          detail: 'progress',
          by: 'group',
          currency: 'USD',
          months: [{ month: '2026-10', total: { name: 'All budgets', pct: 0, label: '<1%', over: false }, groups: [{ name: 'Fun', pct: 0, label: '0%', over: false }], left_out: null, may_be_incomplete: false }],
        },
        // A goal with nothing saved yet.
        goals: { detail: 'progress', goals: [{ ...goal, name: 'New fund', pct: 0, label: '0%', saved: undefined, target: undefined }] },
        // A little cash beside stocks, and a margin loan's.
        holdings: {
          detail: 'shares',
          currency: 'USD',
          as_of: '2026-10-20',
          from: '2026-10-20',
          classes: [
            { slot: 'us-stocks', name: 'US stocks', pct: 100, label: '>99%' },
            { slot: 'cash', name: 'Cash', pct: 0, label: '<1%' },
            { slot: 'bonds', name: 'Bonds', pct: 0, label: '>-1%' },
          ],
          buckets: [],
          notes: [],
        },
      })
    );
    expect(page).toContain('All budgets <1% spent');
    expect(page).toContain('Fun 0% spent');
    // A goal's share at the end of its row, after its meta line.
    expect(page).toMatch(/New fund [^%]*· as of yesterday 0%/);
    expect(page).toContain('US stocks >99%');
    expect(page).toContain('Cash <1%');
    expect(page).toContain('Bonds >-1%');
    expect(page).not.toMatch(/US stocks 100%/);
  });

  test('spending says what it counts that it can’t be sure of, and that a month may be short, with or without a month to show', () => {
    const sp = VIEWS.spending as any;
    const unsure = text(card({ spending: { ...sp, months: [{ ...sp.months[0], exclusions_unknown: true }], filing_unread: true } }));
    expect(unsure).toContain('Whether they left some transactions out of their totals couldn’t be read, so those are counted here.');
    expect(unsure).toContain('Some of how they file their transactions couldn’t be read just now, so some of this may be under another category than the one they chose.');
    // Budgets say it the same way.
    const budgets = text(card({ budgets: { ...(VIEWS.budgets as any), filing_unread: true } }));
    expect(budgets).toContain('Some of how they file their transactions couldn’t be read just now');
    expect(text(card())).not.toContain('Some of how they file');
    const none = text(card({ spending: { ...sp, months: [], may_be_incomplete: true } }));
    expect(none).toContain('No spending recorded yet.');
    expect(none).toContain('Some transactions aren’t all in yet, so a month may be short.');
  });

  test('last month’s budgets say which month may be off', () => {
    const b = VIEWS.budgets as any;
    const page = text(card({ budgets: { ...b, months: [{ ...b.months[0], may_be_incomplete: false }, { ...b.months[1], may_be_incomplete: true }] } }));
    expect(page).toContain('What is spent in September 2026 may be off');
    expect(page).not.toContain('What is spent in October 2026 may be off');
  });

  // The screen review: no money on any net worth chart's plot. One point a
  // week, so every segment skips days: an estimated week leaves it dashed,
  // and the range is never called estimated for it.
  test('a shared net worth’s chart has no money on its plot, a table, and stays dashed week to week', () => {
    const html = card();
    expect(html).toContain('class="chart-svg at-width"');
    expect(html).not.toContain('chart-tick');
    expect(html).toContain('<summary>Show as a table</summary>');
    expect([...html.matchAll(/<path [^>]*stroke-width="2"[^>]*>/g)].every((m) => m[0].includes('stroke-dasharray'))).toBe(true);
    expect(html).not.toContain('Estimated, not recorded');
  });

  test('a net worth with one point of history says when it begins, not a chart of one', () => {
    const one = text(card({ net_worth: { ...(VIEWS.net_worth as any), history: [{ date: '2026-10-18', value: 1 }], accounts: undefined } }));
    expect(one).toContain('Its history begins Oct 18');
  });

  test('a net worth with no balance yet says so once; two goals of one name are both shown', () => {
    const none = text(card({ net_worth: { detail: 'total', currency: null, total: null, as_of: null, from: null, other_currencies: [], without_balance: 1 } }));
    expect(none.match(/No balance yet/g)).toHaveLength(1);
    expect(none).toContain('1 account has no balance yet');
    const goals = (VIEWS.goals as GoalsView).goals;
    const twice = text(card({ goals: { detail: 'amounts', goals: [goals[0], goals[0]] } }));
    expect(twice.match(/Rainy day/g)).toHaveLength(2);
  });
});

// The review of 2026-11-18: every caveat on a short total was grey helper
// text, lower than the owner's own screens say the same fact. Each is now a
// notice at the owner's level (design-system.md "Status and honesty"),
// under the figure it qualifies, in its words.
describe('each caveat at the level the owner’s own screens give it, under its figure', () => {
  const nw = VIEWS.net_worth as any;
  const sp = VIEWS.spending as any;
  const ho = VIEWS.holdings as any;
  const bu = VIEWS.budgets as any;

  test('net worth: a currency with no public rate left out is critical, as on Home; converted is information', () => {
    const html = card({ net_worth: { ...nw, converted: { rates: 'ecb' } } });
    expect(levelOf(html, '1 account in EUR isn’t in this total: there is no public rate for it.')).toBe('critical');
    expect(levelOf(html, 'Converted into USD at the European Central Bank’s daily rates.')).toBe('info');
    // Said in full, never folded into a count.
    expect(html).not.toContain('notice-summary');
    // Under the total, above the chart.
    expect(before(html, '$321,480.00', 'there is no public rate for it')).toBe(true);
    expect(before(html, 'there is no public rate for it', 'One point a week')).toBe(true);
  });

  test('net worth: totals not converted, and accounts with no balance yet, are cautions; two of them are gathered in amber', () => {
    const html = card({ net_worth: { ...nw, without_balance: 2 } });
    expect(levelOf(html, '1 account in EUR isn’t in this total: their totals don’t convert currencies.')).toBe('caution');
    expect(levelOf(html, '2 accounts have no balance yet, so they aren’t in this total.')).toBe('caution');
    // Gathered as Home gathers them: one line in the worst one's color,
    // naming each kind, never an amount.
    expect(html).toContain('<summary class="notice caution">');
    expect(text(html)).toContain('2 notes: currencies not converted and accounts with no balance');
    const one = card({ net_worth: { detail: 'total', currency: null, total: null, as_of: null, from: null, other_currencies: [], without_balance: 1 } });
    expect(levelOf(one, '1 account has no balance yet, so it isn’t in this total.')).toBe('caution');
  });

  test('spending: that a month may be short and how they file it are cautions; what they left out is information; all under the month’s total', () => {
    const html = card({
      spending: { ...sp, converted: { rates: 'ecb' }, may_be_incomplete: true, filing_unread: true, months: [{ ...sp.months[0], exclusions_unknown: true }] },
    });
    expect(levelOf(html, 'Some transactions aren’t all in yet, so a month may be short.')).toBe('caution');
    expect(levelOf(html, 'Some of how they file their transactions couldn’t be read just now')).toBe('caution');
    expect(levelOf(html, 'What went out in EUR isn’t in these totals, which are in USD.')).toBe('info');
    expect(levelOf(html, 'Whether they left some transactions out of their totals couldn’t be read, so those are counted here.')).toBe('info');
    expect(text(html)).toContain('5 notes: a month may be short, categories that couldn’t be read, other currencies left out');
    // On the number: under the month's total, before the first category,
    // not after every row.
    expect(before(html, '$1,357.50', 'a month may be short')).toBe(true);
    expect(before(html, 'a month may be short', 'Housing')).toBe(true);
    expect(before(html, 'What went out in EUR', 'Housing')).toBe(true);
    // With no month to show, said all the same, at the same level.
    const none = card({ spending: { ...sp, months: [], may_be_incomplete: true, converted: { rates: 'ecb' } } });
    expect(levelOf(none, 'Some transactions aren’t all in yet, so a month may be short.')).toBe('caution');
    // With no figure, nothing is said to be converted.
    expect(text(none)).not.toContain('Converted into');
    // What is counted stays helper text, not a notice.
    expect(notices(html).some((n) => n.words.includes('by their own categories'))).toBe(false);
  });

  test('the unread-filing sentence is one level under spending and budgets alike', () => {
    const html = card({ spending: { ...sp, filing_unread: true }, budgets: { ...bu, filing_unread: true } });
    const said = notices(html).filter((n) => n.words.includes('Some of how they file their transactions couldn’t be read just now'));
    expect(said.map((n) => n.level)).toEqual(['caution', 'caution']);
    expect(html).not.toContain('stale-note');
  });

  test('holdings: what isn’t counted is a caution under the total; what Unclassified is stays helper text', () => {
    const notes = [
      'Unclassified is money Nya can’t place in a class: a fund it doesn’t know, or money no position explains.',
      'What is held in EUR isn’t counted here: there is no public rate for it.',
      '2 positions with no value aren’t counted.',
      '1 investment account has no balance yet and no position, so it isn’t counted.',
      // A note this card doesn't know yet: never drawn lower than it may be.
      'Something new isn’t counted.',
    ];
    const html = card({ holdings: { ...ho, converted: { rates: 'ecb' }, notes } });
    for (const n of notes.slice(1)) expect(levelOf(html, n)).toBe('caution');
    expect(levelOf(html, 'Converted into USD at the European Central Bank’s daily rates.')).toBe('info');
    expect(notices(html).some((n) => n.words.includes('Unclassified is money'))).toBe(false);
    expect(text(html)).toContain('Unclassified is money Nya can’t place');
    expect(before(html, '$20,500.00', 'What is held in EUR')).toBe(true);
    expect(before(html, 'What is held in EUR', 'By asset class')).toBe(true);
    // A gathered line names one in the singular.
    const one = card({ holdings: { ...ho, notes: ['A position with no value isn’t counted.', '1 investment account has no balance yet and no position, so it isn’t counted.'] } });
    expect(text(one)).toContain('2 notes: a position with no value and an account with no balance');
    const empty = card({ holdings: { ...ho, classes: [], buckets: [], positions: [], notes: ['No investment accounts to show.'] } });
    expect(notices(empty)).toEqual([]);
    expect(text(empty)).toContain('No investment accounts to show.');
  });

  test('budgets: a month that may be off is a caution under its total; what they left out is information', () => {
    const html = card({ budgets: { ...bu, converted: { rates: 'ecb' }, months: [{ ...bu.months[0], left_out: 'What went out in EUR isn’t in these budgets.' }, bu.months[1]] } });
    expect(levelOf(html, 'What is spent in October 2026 may be off')).toBe('caution');
    expect(levelOf(html, 'What went out in EUR isn’t in these budgets.')).toBe('info');
    expect(levelOf(html, 'Spending in other currencies counts converted into USD')).toBe('info');
    // Under the month's total, above its budgets; what bears on both months
    // once, above them.
    expect(before(html, '$1,242.50 of $1,800.00', 'What is spent in October 2026 may be off')).toBe(true);
    expect(before(html, 'What is spent in October 2026 may be off', 'Food and drink')).toBe(true);
    expect(before(html, 'Spending in other currencies counts converted into USD', 'This month, October 2026')).toBe(true);
  });

  test('a kind that couldn’t be read is a caution', () => {
    expect(levelOf(card({ budgets: { unreadable: true } }), 'Sam’s budgets couldn’t be read just now, so none of it is shown.')).toBe('caution');
  });

  test('a budget past its limit is amber, never red, and says Over in a word, with amounts hidden too', () => {
    const over = { name: 'Fun', pct: 117, label: '117%', over: true, spent: 350, limit: 300 };
    const near = { name: 'Food', pct: 90, label: '90%', over: false, spent: 90, limit: 100 };
    const views: SharedViews = { budgets: { ...bu, months: [{ ...bu.months[0], may_be_incomplete: false, groups: [over, near] }, bu.months[1]] } };
    for (const html of [card(views), hidden(() => card(views))]) {
      expect(html).not.toMatch(/meter-(track|fill)[^"]* over/);
      const meter = (name: string) => html.match(new RegExp(`<span class="(meter-track[^"]*)" role="meter" aria-label="${name}"[^>]*><span class="(meter-fill[^"]*)"`))?.slice(1);
      expect(meter('Fun')).toEqual(['meter-track incoming-meter warn', 'meter-fill warn']);
      expect(meter('Food')).toEqual(['meter-track incoming-meter warn', 'meter-fill warn']);
      expect(meter('All budgets')).toEqual(['meter-track incoming-meter', 'meter-fill']);
      // Over in its word beside the name, unmasked; the one near its limit has none.
      expect(text(html)).toContain('Fun Over');
      expect(text(html)).not.toContain('Food Over');
      expect(html).toContain('<span class="badge warn">Over</span>');
    }
    expect(text(card(views))).toContain('Fun Over $350.00 of $300.00');
  });
});

// The review of 2026-11-18: the card was on legacy classes. It is now on
// the primitives (docs/design/guidelines.md "Which class to use").
describe('the card on the primitives', () => {
  const account = {
    id: 'a',
    label: 'Joint ••1111',
    level: 'transactions' as const,
    balance: 500,
    currency: 'USD',
    as_of: '2026-10-19',
    debt: false,
    transactions: [{ date: '2026-10-18', name: 'Blue Bottle', amount: 12, pending: true, currency: 'USD' }],
  };
  const full = (accounts: any[] = [account]) =>
    renderToStaticMarkup(<SharedWithMeView data={{ shared: [{ connection: 'c1', label: 'Sam', accounts, expires_at: null, views: VIEWS }] }} />);

  test('its title row is a card header with an h2, Read-only a badge, and nothing is left on the classes it replaces', () => {
    const html = full();
    expect(html).toContain('<div class="card-header"><span class="avatar small">S</span><h2>Shared by Sam</h2><span class="badge">Read-only</span></div>');
    for (const legacy of ['incoming-head', 'peer-row', 'link-btn', 'panel-note', 'stale-note', 'class="pill"', 'incoming-account-value', '<section aria-label', '<h3>Shared by']) {
      expect(html).not.toContain(legacy);
    }
    // The cards and the note above them stacked, the note after the cards a helper.
    expect(html).toContain('<div id="shared-with-me" class="stack">');
    expect(html).toContain('<p class="helper incoming-note">Sam sees each time this is shown to you, and so do you, in Sharing.</p>');
  });

  test('accounts and each kind’s lines are rows in lists, their figures lined up as money', () => {
    const html = full();
    expect(html).toContain(
      '<ul class="list-rows"><li><div class="list-row"><span class="list-row-text"><span class="list-row-title">Joint ••1111</span><span class="list-row-sub">Yesterday</span></span><span class="list-row-value money">$500.00</span></div>'
    );
    // A spending group's categories set in under it, in a list of their own.
    const housing = html.indexOf('<span class="list-row-title">Housing</span>');
    const sub = html.indexOf('<ul class="list-rows incoming-sub-rows"><li><div class="list-row"><span class="list-row-text"><span class="list-row-title">Rent</span>');
    expect(housing).toBeGreaterThan(0);
    expect(sub).toBeGreaterThan(housing);
    expect(html.slice(housing, sub)).not.toContain('</li>');
    // Every figure on a row is money, so the digits line up.
    expect([...html.matchAll(/<span class="list-row-value( money)?">/g)].every((m) => m[1] === ' money')).toBe(true);
    // A kind's own figure too.
    expect(html).toContain('<span class="incoming-figure-value money">$321,480.00</span>');
  });

  test('each kind is under a heading, below the card’s, and the parts inside it under lesser ones; no kind is a region of its own', () => {
    const html = full();
    for (const k of ['Net worth', 'Spending', 'Holdings', 'Budgets', 'Goals']) expect(html).toContain(`<h3 class="incoming-kind-name">${k}</h3>`);
    for (const p of ['By asset class', 'By tax bucket', 'Positions', 'This month, October 2026', 'Last month, September 2026']) {
      expect(html).toContain(`<h4 class="incoming-kind-sub">${p}</h4>`);
    }
    // The card holds no region: only the part's own section, around it.
    const cardOnly = html.slice(html.indexOf('<div class="card">'));
    expect(cardOnly).not.toContain('<section');
  });

  test('spending’s month is a field with a label one can see', () => {
    const m = full().match(new RegExp('<div class="field"><label for="([^"]+)">Month</label><select id="([^"]+)"'));
    expect(m?.[1]).toBeTruthy();
    expect(m![1]).toBe(m![2]);
  });

  test('Recent transactions is a ghost button (.btn, 44px tall) that says whether it is open and names the list it opens', () => {
    const closed = renderToStaticMarkup(<SharedAccountItem a={account} open={false} onToggle={() => {}} />);
    const b = closed.match(new RegExp('<button type="button" class="btn ghost" aria-expanded="false" aria-controls="([^"]+)">Recent transactions [(]1[)]</button>'));
    expect(b?.[1]).toBeTruthy();
    const open = renderToStaticMarkup(<SharedAccountItem a={account} open onToggle={() => {}} />);
    const o = open.match(new RegExp('<button type="button" class="btn ghost" aria-expanded="true" aria-controls="([^"]+)">Hide transactions</button>'));
    expect(open).toContain(`<ul id="${o![1]}" class="incoming-txns">`);
    // Pending a badge on its line, the amount money.
    expect(open).toContain('Blue Bottle <span class="badge">Pending</span>');
    expect(text(open)).not.toContain('(pending)');
    expect(open).toContain('<span class="money">−$12.00</span>');
  });

  test('transactions that can’t be read say so as a caution; none in the window, as helper text', () => {
    const unreadable = renderToStaticMarkup(<SharedAccountItem a={{ ...account, transactions: undefined, transactions_unreadable: true }} open={false} onToggle={() => {}} />);
    expect(levelOf(unreadable, "Its transactions can't be read, so they aren't shown.")).toBe('caution');
    const none = renderToStaticMarkup(<SharedAccountItem a={{ ...account, transactions: [] }} open={false} onToggle={() => {}} />);
    expect(none).toContain('<p class="helper">No transactions in the last');
    expect(notices(none)).toEqual([]);
    // A balance-only account has nothing under its row.
    expect(renderToStaticMarkup(<SharedAccountItem a={{ ...account, level: 'balance', transactions: undefined }} open={false} onToggle={() => {}} />)).not.toContain('incoming-account-more');
  });
});

describe('a goal’s outlook, in words, never with the rate behind it', () => {
  const goal = (outlook: any, extra: Record<string, unknown> = {}) => outlookWords({ name: 'G', state: 'tracked', pct: 10, currency: 'USD', target_date: null, outlook, as_of: null, ...extra } as any);
  test('each status', () => {
    expect(goal({ status: 'complete', completion: null, beyond: false, date_passed: false })).toBe('Reached');
    expect(goal({ status: 'on_track', completion: '2027-03', beyond: false, date_passed: false })).toBe('On track for March 2027');
    expect(goal({ status: 'on_track', completion: '2027-05', beyond: false, date_passed: false }, { target_date: '2027-05-31' })).toBe('On track for May 2027');
    expect(goal({ status: 'behind', completion: '2028-01', beyond: false, date_passed: false }, { target_date: '2027-06-01' })).toBe('Behind its date, June 2027: at this pace, reached in January 2028');
    expect(goal({ status: 'behind', completion: '2028-01', beyond: false, date_passed: true }, { target_date: '2026-06-01' })).toBe('Its date, Jun 1, has passed; at this pace, reached in January 2028');
    expect(goal({ status: 'on_track', completion: null, beyond: true, date_passed: false })).toBe('Not within 50 years at this pace');
    expect(goal({ status: 'no_recent_contributions', completion: null, beyond: false, date_passed: false })).toBe('Nothing has gone into it lately');
    expect(goal({ status: 'no_rate', completion: null, beyond: false, date_passed: false })).toBe('When it will be reached isn’t known yet');
    expect(goal(null)).toBeNull();
  });
});

describe('in the drawer', () => {
  const pat = { id: 'c1', label: 'Pat', introduced_as: null, since: '2026-09-28', sharing: { a: 'balance' }, views: {}, expires_at: null };
  const data = {
    enabled: true,
    connections: [pat],
    accounts: [
      { id: 'a', label: 'Chase Checking ••1111', institution: 'Chase', name: 'Checking ••1111' },
      { id: 'b', label: 'Ally Savings', institution: 'Ally', name: 'Savings' },
      { id: 'i', label: 'Broker IRA ••4444', institution: 'Broker', name: 'IRA ••4444', investment: true as const },
    ],
    goals: [
      { id: 'g1', name: 'Holiday', account_id: 'b' },
      { id: 'g2', name: 'Someday', account_id: null },
    ],
  };
  const noop = () => {};
  // A person's sheet (ConnectionView), or with `current: null` the list it
  // is opened from (SharingListView, in place on Settings > Sharing).
  const panel = (viewsDraft: any, opts: { draft?: Record<string, string>; current?: any; data?: any } = {}) => {
    const current = 'current' in opts ? opts.current : pat;
    if (!current) return renderToStaticMarkup(<SharingListView data={opts.data ?? data} invite={null} busy={false} error="" notice="" damaged={null} onOpen={noop} onInvite={noop} onClearDamaged={noop} onUnblock={noop} />);
    return renderToStaticMarkup(
      <ConnectionView
        data={opts.data ?? data}
        current={current}
        draft={(opts.draft ?? { a: 'balance', b: 'none', i: 'none' }) as Record<string, Choice>}
        viewsDraft={viewsDraft}
        labelDraft="Pat"
        endChoice="none"
        endDay=""
        busy={false}
        error=""
        notice=""
        onChoose={noop}
        onViews={noop}
        onLabel={noop}
        onEndChoice={noop}
        onEndDay={noop}
        onSave={noop}
        onRenew={noop}
        onPreview={noop}
        records={null}
        recordsFailed={false}
        onShowAll={noop}
        onClearRecord={noop}
        onRemove={noop}
      />
    );
  };

  test('each kind is a choice, not shared until chosen, with what it shows once it is', () => {
    const page = text(panel({}));
    expect(page).toContain('More than accounts');
    for (const kind of ['Net worth', 'Spending', 'Holdings', 'Budgets', 'Goals']) expect(page).toContain(kind);
    expect(page).not.toContain('What they could work out');
    const chosen = text(panel({ net_worth: { detail: 'total', accounts: false } }));
    expect(chosen).toContain('With the accounts in it whose balances you share above, each with its balance');
    expect(chosen).toContain('Each account’s newest balance added up');
  });

  test('each select says only a level, so a narrow one never hides which; what else a kind shows is a box of its own', () => {
    const html = panel({ spending: { detail: 'shares', by: 'category' }, budgets: { detail: 'progress', by: 'group' } });
    // No two levels of one select begin alike for long: the whole label shows at any width.
    for (const [, options] of html.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)) {
      const labels = [...options.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
      for (const l of labels) expect(l.length).toBeLessThanOrEqual(25);
    }
    expect(html).toContain('class="kind-choice"');
    const page = text(html);
    expect(page.match(/By category too, within each group/g)).toHaveLength(2);
    // The box says whether categories are shared, and a screen reader tells the two kinds' boxes apart.
    expect(html).toContain('<input type="checkbox" aria-label="Spending by category too, within each group" checked=""/>By category too');
    expect(html).toContain('aria-label="Budgets by category too, within each group"');
    const names = [...html.matchAll(/<input type="checkbox"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  test('says, before anything is saved, what they could work out from all of it together, and never stops a save', () => {
    const html = panel({ net_worth: { detail: 'history', accounts: false }, holdings: { detail: 'shares', positions: false } }, { draft: { a: 'balance', b: 'none', i: 'balance' } });
    const page = text(html);
    expect(page).toContain('What they could work out');
    expect(page).toContain('They see your net worth and the balances of Chase Checking ••1111 and Broker IRA ••4444, so they can work out the balance of Ally Savings, the one account whose balance you don’t share.');
    expect(page).toContain('With your holdings as percentages and the balance of Broker IRA ••4444');
    expect(page).toContain('not every way someone could piece things together');
    // Save is there, and not held back.
    expect(html).toMatch(/<button[^>]*>Save<\/button>/);
  });

  test('says a net worth beside holdings in amounts gives what the other accounts hold', () => {
    const page = text(panel({ net_worth: { detail: 'total', accounts: false }, holdings: { detail: 'amounts', positions: false } }, { draft: { a: 'none', b: 'none', i: 'none' } }));
    expect(page).toContain('They see your net worth and your holdings in amounts, so they can work out about what your accounts besides your investments add up to.');
  });

  test('goals: each one chosen by name; none chosen shares none, and says so', () => {
    const page = text(panel({ goals: { detail: 'amounts', goals: [] } }));
    expect(page).toContain('Holiday');
    expect(page).toContain('Choose the goals they see: until you do, none is shared.');
    const unreadable = text(panel({ goals: { detail: 'amounts', goals: ['g1'] } }, { data: { ...data, goals: [], goals_unreadable: true } }));
    expect(unreadable).toContain('Your goals couldn’t be read just now');
    // The projected goal's warning, from the choice.
    expect(text(panel({ goals: { detail: 'amounts', goals: ['g1'] } }))).toContain('From the progress of Holiday and when it is projected to be reached');
    // One chosen that is archived (no longer offered) is said, may come back, and can be stopped.
    const gone = text(panel({ goals: { detail: 'amounts', goals: ['g1', 'g-archived'] } }));
    expect(gone).toContain('A goal you chose is archived or deleted, so not shown; an archived one is shown again if you unarchive it.');
    expect(gone).toContain('Stop sharing it');
  });

  test('what each person can see, in words, accounts and kinds together', () => {
    const both = { ...pat, views: { net_worth: { detail: 'total', accounts: false }, spending: { detail: 'shares', by: 'group' } } };
    const list = text(panel({}, { current: null, data: { ...data, connections: [both] } }));
    expect(list).toContain('Sees 1 of your accounts, your net worth and your spending');
    const kindsOnly = { ...pat, sharing: {}, views: { goals: { detail: 'progress', goals: ['g1'] } } };
    expect(text(panel({}, { current: kindsOnly, data: { ...data, connections: [kindsOnly] } }))).toContain('Pat can see your goals, read-only.');
    expect(seenText(0, {})).toBeNull();
    expect(seenText(2, { budgets: { detail: 'progress', by: 'group' } })).toBe('2 of your accounts and your budgets');
    // A goals share naming none shares nothing.
    expect(kindsText({ goals: { detail: 'progress', goals: [] } })).toBe('');
  });

  test('a save sends every kind, null for those not shared, and a goals share naming none as none', () => {
    expect(viewsToSave({ spending: { detail: 'amounts', by: 'group' }, goals: { detail: 'progress', goals: [] } })).toEqual({
      net_worth: null,
      spending: { detail: 'amounts', by: 'group' },
      holdings: null,
      budgets: null,
      goals: null,
    });
    expect(sameViews({ goals: { detail: 'progress', goals: ['b', 'a'] } }, { goals: { detail: 'progress', goals: ['a', 'b'] } })).toBe(true);
    expect(sameViews({ goals: { detail: 'progress', goals: [] } }, {})).toBe(true);
    expect(sameViews({ net_worth: { detail: 'total', accounts: false } }, {})).toBe(false);
  });
});

describe('the preview', () => {
  test('shows the kinds as they see them, and what they could work out', () => {
    const page = text(
      renderToStaticMarkup(
        <PreviewView
          who="Pat"
          expiresAt={null}
          preview={{ connection: 'c1', view: { accounts: [], expires_at: null, views: VIEWS }, inferences: [{ id: 'income', text: 'With your net worth over time and your spending each month, they can estimate your income.' }] }}
          error=""
          unsaved={false}
        />
      )
    );
    expect(page).toContain('Shared by you');
    expect(page).toContain('$321,480.00');
    expect(page).toContain('What they could work out');
    expect(page).toContain('they can estimate your income');
  });

  test('when what they could work out couldn’t be worked out, says so beside what they see', () => {
    const page = text(
      renderToStaticMarkup(
        <PreviewView who="Pat" expiresAt={null} preview={{ connection: 'c1', view: { accounts: [], expires_at: null, views: VIEWS }, inferences_unavailable: true }} error="" unsaved={false} />
      )
    );
    expect(page).toContain('What they could work out from all of this couldn’t be worked out just now.');
    expect(page).toContain('Rainy day');
    expect(page).not.toContain('Any total says something');
  });

  test('with amounts hidden, no figure', () => {
    const html = hidden(() =>
      renderToStaticMarkup(<PreviewView who="Pat" expiresAt={null} preview={{ connection: 'c1', view: { accounts: [], expires_at: null, views: VIEWS } }} error="" unsaved={false} />)
    );
    expect(text(html).split(/\s{2,}|(?<=\.) /).filter((l) => AMOUNT.test(l))).toEqual([]);
    expect(html).toContain(MASK);
  });
});

test('a record’s day names the kinds shown on it, each as widely as it was shown', () => {
  const day = {
    day: '2026-10-04',
    times: 2,
    levels: { exists: 0, balance: 1, transactions: 0 },
    views: { net_worth: { detail: 'history', accounts: true }, spending: { detail: 'shares', by: 'group' } },
  } as const;
  expect(shownText(day, new Date('2026-10-20T12:00:00'))).toBe('Shown twice on Oct 4, the balance of 1 account, net worth and its history with its accounts and spending as percentages.');
  expect(shownText({ ...day, levels: { exists: 0, balance: 0, transactions: 0 } }, new Date('2026-10-20T12:00:00'))).toBe(
    'Shown twice on Oct 4, net worth and its history with its accounts and spending as percentages.'
  );
  const others = {
    ...day,
    views: { holdings: { detail: 'amounts', positions: true }, budgets: { detail: 'progress', by: 'category' }, goals: { detail: 'progress', count: 2 } },
  } as const;
  expect(shownText(others, new Date('2026-10-20T12:00:00'))).toBe('Shown twice on Oct 4, the balance of 1 account, holdings with positions in amounts, budgets by category and 2 goals.');
  expect(shownText({ day: '2026-10-04', times: 1, levels: { exists: 0, balance: 1, transactions: 0 } }, new Date('2026-10-20T12:00:00'))).toBe('Shown once on Oct 4, the balance of 1 account.');
});

describe('a read of what is shared turned away or failing', () => {
  const shown = { shared: [{ connection: 'c1', label: 'Sam', accounts: [], expires_at: null, views: VIEWS }] };

  test('keeps what was shown and says why it couldn’t be refreshed', () => {
    const problem = sharedProblem(429, { error: 'What is shared can be read 60 times in 10 minutes. Try again in 7 minutes.' }, '420');
    const page = text(renderToStaticMarkup(<SharedWithMeView data={shown} problem={problem} />));
    expect(page).toContain('This is what was last shown: it couldn’t be refreshed. What is shared can be read 60 times in 10 minutes. Try again in 7 minutes.');
    // A caution, as what is shown is real but may be dated, and announced, as
    // it comes after a read, a refresh among them.
    const html = renderToStaticMarkup(<SharedWithMeView data={shown} problem={problem} />);
    expect(levelOf(html, 'This is what was last shown: it couldn’t be refreshed.')).toBe('caution');
    expect(html).toContain('<div class="notice caution" role="status">');
    expect(page).toContain('Shared by Sam');
    expect(page).toContain('Rainy day');
    // And with nothing wrong, nothing is said.
    expect(renderToStaticMarkup(<SharedWithMeView data={null} />)).toBe('');
  });

  /** This device's storage, as a test holds it. */
  const device = () => {
    const kept = new Map<string, string>();
    return { kept, getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  };
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => async () => new Response(JSON.stringify(body), { status, headers });
  const offline = async (): Promise<Response> => {
    throw new TypeError('Failed to fetch');
  };
  const cards = (read: Awaited<ReturnType<typeof readSharedWithMe>>, shown: any = null) =>
    renderToStaticMarkup(<SharedWithMeView data={read.data ?? shown} problem={read.problem} hadShares={read.data ? false : read.hadShares} />);

  test('offline, with nothing ever shared: nothing is said', async () => {
    const read = await readSharedWithMe('user_a', offline, device());
    expect(read).toEqual({ data: null, problem: 'Nya couldn’t be reached. Try again later.', hadShares: false });
    expect(cards(read)).toBe('');
  });

  test('a refresh that fails after a read that said nothing is shared: nothing is said', async () => {
    const storage = device();
    const first = await readSharedWithMe('user_a', answer(200, { shared: [] }), storage);
    expect(first.data).toEqual({ shared: [] });
    const refresh = await readSharedWithMe('user_a', answer(503, { error: 'Could not read what is shared with you' }), storage);
    expect(refresh).toMatchObject({ data: null, hadShares: false });
    // What was shown stays: the empty read, with nothing to say about it.
    expect(cards(refresh, first.data)).toBe('');
    // Nor after a 429.
    expect(cards(await readSharedWithMe('user_a', answer(429, null, { 'Retry-After': '120' }), storage), first.data)).toBe('');
  });

  test('a first read that fails, for someone whose last good read here had shares: the note, with when to try again', async () => {
    const storage = device();
    const good = await readSharedWithMe('user_a', answer(200, { shared: [{ connection: 'c1', label: 'Sam', accounts: [], expires_at: null }] }), storage);
    expect(good.data!.shared).toHaveLength(1);
    expect(storage.kept.get(sharedSeenKey('user_a'))).toBe('1');
    // A later page on this device, turned away before anything loaded.
    const turned = await readSharedWithMe('user_a', answer(429, null, { 'Retry-After': '120' }), storage);
    expect(turned).toEqual({ data: null, problem: 'Try again in 2 minutes.', hadShares: true });
    // Critical, as none of it could be shown, and said at once: never the
    // caution of what was last shown.
    expect(notices(cards(turned))).toEqual([{ level: 'critical', words: 'Critical: What is shared with you couldn’t be shown just now. Try again in 2 minutes.' }]);
    expect(cards(turned)).toContain('role="alert"');
    // Someone else on the same device never hears of the first one's shares.
    expect(cards(await readSharedWithMe('user_b', offline, storage))).toBe('');
    // Once a good read has nothing, it is forgotten.
    await readSharedWithMe('user_a', answer(200, { shared: [] }), storage);
    expect(storage.kept.has(sharedSeenKey('user_a'))).toBe(false);
  });

  test('what this device remembers is a convenience: per account, forgotten on sign-out with the snapshot, and never a reason to throw', () => {
    expect(sharedSeenKey('user_a').startsWith(`${LOCAL_CACHE_KEY}:`)).toBe(true);
    expect(sharedSeenKey('user_a')).not.toBe(sharedSeenKey('user_b'));
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => rememberShares('user_a', true, broken)).not.toThrow();
    expect(rememberedShares('user_a', broken)).toBe(false);
    // Nothing is kept for nobody, and no storage says nothing.
    const storage = device();
    rememberShares(undefined, true, storage);
    expect(storage.kept.size).toBe(0);
    expect(rememberedShares('user_a', null)).toBe(false);
  });

  test('why, in words: past the limit, when to come back, by the answer or its Retry-After; else what the answer said', () => {
    expect(sharedProblem(429, null, '61')).toBe('Try again in 2 minutes.');
    expect(sharedProblem(429, null, '30')).toBe('Try again in a minute.');
    expect(sharedProblem(429, null, null)).toBe('Try again in a few minutes.');
    expect(sharedProblem(503, { error: 'The limit on reading what is shared couldn’t be checked just now, so nothing was read. Try again in a minute.' }, null)).toBe(
      'The limit on reading what is shared couldn’t be checked just now, so nothing was read. Try again in a minute.'
    );
    expect(sharedProblem(500, { error: 'Could not read what is shared with you' }, null)).toBe('Could not read what is shared with you. Try again later.');
    expect(sharedProblem(0, null, null)).toBe('Nya couldn’t be reached. Try again later.');
  });
});

test('the card for a kind lists itself under its own name, whoever’s it is', () => {
  const html = renderToStaticMarkup(<SharedViewsList views={{ net_worth: { unreadable: true } }} whose="Your" />);
  expect(text(html)).toContain('Your net worth couldn’t be read just now');
});

describe('a share in the owner’s home currency', () => {
  test('says it is converted at the ECB’s rates, never a rate nor anyone’s own; what has none is named as having no public rate', () => {
    const views: SharedViews = {
      net_worth: { detail: 'total', currency: 'EUR', total: 1000, as_of: '2026-09-14', from: '2026-09-14', other_currencies: [{ currency: 'AED', accounts: 1 }], without_balance: 0, converted: { rates: 'ecb' } },
      spending: {
        detail: 'shares',
        by: 'group',
        currency: 'EUR',
        converted: { rates: 'ecb' },
        months: [{ month: '2026-09', so_far: true, groups: [{ name: 'Food', pct: 100, label: '100%' }], left_out: null }],
      },
      budgets: {
        detail: 'progress',
        by: 'group',
        currency: 'USD',
        converted: { rates: 'ecb' },
        months: [{ month: '2026-09', total: { name: 'All budgets', pct: 50, label: '50%', over: false }, groups: [], left_out: null, may_be_incomplete: false }],
      },
    };
    const t = text(renderToStaticMarkup(<SharedViewsList views={views} whose="Sam’s" />));
    expect(t).toContain('Converted into EUR at the European Central Bank’s daily rates.');
    expect(t).toContain('1 account in AED isn’t in this total: there is no public rate for it.');
    expect(t).toContain('Spending in other currencies counts converted into USD at the European Central Bank’s daily rates.');
    expect(t).not.toMatch(/own rate|their own rates/);
    expect(t).not.toContain('a share doesn’t convert');
  });
});
