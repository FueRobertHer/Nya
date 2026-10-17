import { describe, expect, test, afterEach } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MASK, setAmountsHidden } from '@/lib/format';
import { SharingPanelView, SharedWithMeView, PreviewView, type Choice } from '@/components/Sharing';
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
        groups: [{ name: 'Housing', pct: 88, amount: 1200, categories: [{ name: 'Rent', pct: 88, amount: 1200 }] }, { name: 'Food', pct: 12, amount: 157.5, categories: [{ name: 'Coffee', pct: 12, amount: 157.5 }] }],
        left_out: "1 transaction in EUR isn't in these totals, which are in USD.",
      },
      { month: '2026-09', so_far: false, total: 15.99, groups: [{ name: 'Fun', pct: 100, amount: 15.99, categories: [{ name: 'Streaming', pct: 100, amount: 15.99 }] }], left_out: null },
    ],
  },
  holdings: {
    detail: 'amounts',
    currency: 'USD',
    as_of: '2026-10-20',
    total: 20_500,
    classes: [
      { slot: 'us-stocks', name: 'US stocks', pct: 98, amount: 20_000 },
      { slot: 'unclassified', name: 'Unclassified', pct: 2, amount: 500 },
    ],
    buckets: [{ slot: 'tax-deferred', name: 'Tax-deferred', pct: 100, amount: 20_500 }],
    positions: [{ ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', class: 'US stocks', pct: 98, amount: 20_000 }],
    notes: ['Unclassified is money Nya can’t place in a class: a fund it doesn’t know, or money no position explains.'],
  },
  budgets: {
    detail: 'amounts',
    by: 'category',
    currency: 'USD',
    months: [
      {
        month: '2026-10',
        total: { name: 'All budgets', pct: 69, over: false, spent: 1242.5, limit: 1800 },
        groups: [{ name: 'Food', pct: 43, over: false, spent: 42.5, limit: 100, categories: [{ name: 'Food and drink', pct: 43, over: false, spent: 42.5, limit: 100 }] }],
        left_out: null,
        may_be_incomplete: true,
      },
      { month: '2026-09', total: { name: 'All budgets', pct: 0, over: false, spent: 0, limit: 1800 }, groups: [], left_out: null, may_be_incomplete: false },
    ],
  },
  goals: {
    detail: 'amounts',
    goals: [
      {
        name: 'Rainy day',
        state: 'tracked',
        pct: 33,
        currency: 'USD',
        saved: 1000,
        target: 3000,
        target_date: '2030-01-31',
        outlook: { status: 'on_track', completion: '2028-06', beyond: false, date_passed: false },
        as_of: '2026-10-19',
      },
      { name: 'Someday', state: 'untracked', pct: null, currency: null, target: 800, target_date: null, outlook: null, as_of: null },
    ],
  },
};

const card = (views: SharedViews = VIEWS) =>
  renderToStaticMarkup(<SharedWithMeView data={{ shared: [{ connection: 'c1', label: 'Sam', accounts: [], expires_at: null, views }] }} />);

describe('on the card of the one it is shared with', () => {
  test('each kind, with its as-of day, its figures and its words', () => {
    const page = text(card());
    for (const words of ['Shared by Sam', 'Net worth', 'Spending', 'Holdings', 'Budgets', 'Goals', 'As of Oct 20', '$321,480.00', '1 account in EUR isn’t in this total', '$1,357.50', 'October 2026, so far', 'Housing', 'Rent', 'US stocks', 'Tax-deferred', 'VTI', '$42.50 of $100.00', 'This month, October 2026', 'Last month, September 2026', 'may not all be in', 'Rainy day', '$1,000.00 of $3,000.00', 'On track for June 2028, ahead of January 2030', 'Not tracked against an account', 'Chase Card ••2222', '$310.00 owed']) {
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
        spending: { detail: 'shares', by: 'group', currency: 'USD', months: [{ month: '2026-10', so_far: true, groups: [{ name: 'Housing', pct: 88 }, { name: 'Food', pct: 0 }], left_out: null }] },
        budgets: { detail: 'progress', by: 'group', currency: 'USD', months: [{ month: '2026-10', total: { name: 'All budgets', pct: 69, over: false }, groups: [{ name: 'Food', pct: 112, over: true }], left_out: null, may_be_incomplete: false }] },
        goals: { detail: 'progress', goals: [{ ...(VIEWS.goals as GoalsView).goals[0], saved: undefined, target: undefined }] },
      })
    );
    expect(page).not.toMatch(AMOUNT);
    // Money that is there never reads 0%.
    expect(page).toContain('<1%');
    expect(page).toContain('112% spent, over');
    expect(page).toContain('33%');
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

describe('a goal’s outlook, in words, never with the rate behind it', () => {
  const goal = (outlook: any, extra: Record<string, unknown> = {}) => outlookWords({ name: 'G', state: 'tracked', pct: 10, currency: 'USD', target_date: null, outlook, as_of: null, ...extra } as any);
  test('each status', () => {
    expect(goal({ status: 'complete', completion: null, beyond: false, date_passed: false })).toBe('Reached');
    expect(goal({ status: 'on_track', completion: '2027-03', beyond: false, date_passed: false })).toBe('On track for March 2027');
    expect(goal({ status: 'on_track', completion: '2027-05', beyond: false, date_passed: false }, { target_date: '2027-05-31' })).toBe('On track for May 2027');
    expect(goal({ status: 'behind', completion: '2028-01', beyond: false, date_passed: false }, { target_date: '2027-06-01' })).toBe('Behind its date, June 2027: at this pace, reached in January 2028');
    expect(goal({ status: 'behind', completion: '2028-01', beyond: false, date_passed: true }, { target_date: '2026-06-01' })).toBe('Its date, Jun 1, 2026, has passed; at this pace, reached in January 2028');
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
  const panel = (viewsDraft: any, opts: { draft?: Record<string, string>; current?: any; data?: any } = {}) =>
    renderToStaticMarkup(
      <SharingPanelView
        data={opts.data ?? data}
        current={'current' in opts ? opts.current : pat}
        draft={(opts.draft ?? { a: 'balance', b: 'none', i: 'none' }) as Record<string, Choice>}
        viewsDraft={viewsDraft}
        labelDraft="Pat"
        endChoice="none"
        endDay=""
        invite={null}
        busy={false}
        error=""
        notice=""
        onOpen={noop}
        onChoose={noop}
        onViews={noop}
        onLabel={noop}
        onEndChoice={noop}
        onEndDay={noop}
        onInvite={noop}
        onSave={noop}
        onRenew={noop}
        onPreview={noop}
        records={null}
        recordsFailed={false}
        onShowAll={noop}
        damaged={null}
        onClearRecord={noop}
        onClearDamaged={noop}
        onRemove={noop}
      />
    );

  test('each kind is a choice, not shared until chosen, with what it shows once it is', () => {
    const page = text(panel({}));
    expect(page).toContain('More than accounts');
    for (const kind of ['Net worth', 'Spending', 'Holdings', 'Budgets', 'Goals']) expect(page).toContain(kind);
    expect(page).not.toContain('What they could work out');
    const chosen = text(panel({ net_worth: { detail: 'total', accounts: false } }));
    expect(chosen).toContain('With the accounts behind it, each with its balance');
    expect(chosen).toContain('Each account’s newest balance added up');
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

  test('goals: each one chosen by name; none chosen shares none, and says so', () => {
    const page = text(panel({ goals: { detail: 'amounts', goals: [] } }));
    expect(page).toContain('Holiday');
    expect(page).toContain('Choose the goals they see: until you do, none is shared.');
    const unreadable = text(panel({ goals: { detail: 'amounts', goals: ['g1'] } }, { data: { ...data, goals: [], goals_unreadable: true } }));
    expect(unreadable).toContain('Your goals couldn’t be read just now');
    // The projected goal's warning, from the choice.
    expect(text(panel({ goals: { detail: 'amounts', goals: ['g1'] } }))).toContain('From the progress of Holiday and when it is projected to be reached');
  });

  test('what each person can see, in words, accounts and kinds together', () => {
    const both = { ...pat, views: { net_worth: { detail: 'total', accounts: false }, spending: { detail: 'shares', by: 'group' } } };
    const list = text(panel({}, { current: null, data: { ...data, connections: [both] } }));
    expect(list).toContain('Sees 1 of your accounts and your net worth and your spending');
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

test('a record’s day names the kinds shown on it', () => {
  const day = { day: '2026-10-04', times: 2, levels: { exists: 0, balance: 1, transactions: 0 }, views: { net_worth: 'history', spending: 'shares' } };
  expect(shownText(day, new Date('2026-10-20T12:00:00'))).toBe('Shown twice on Oct 4, the balance of 1 account, net worth and spending.');
  expect(shownText({ ...day, levels: { exists: 0, balance: 0, transactions: 0 } }, new Date('2026-10-20T12:00:00'))).toBe('Shown twice on Oct 4, net worth and spending.');
  expect(shownText({ day: '2026-10-04', times: 1, levels: { exists: 0, balance: 1, transactions: 0 } }, new Date('2026-10-20T12:00:00'))).toBe('Shown once on Oct 4, the balance of 1 account.');
});

test('the card for a kind lists itself under its own name, whoever’s it is', () => {
  const html = renderToStaticMarkup(<SharedViewsList views={{ net_worth: { unreadable: true } }} whose="Your" />);
  expect(text(html)).toContain('Your net worth couldn’t be read just now');
});
