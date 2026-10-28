import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AccountsSkeleton,
  ActivitySkeleton,
  AppLoading,
  BudgetsSkeleton,
  HomeSkeleton,
  LinesSkeleton,
  PlanSkeleton,
  SettingsSkeleton,
  SharedWithMeSkeleton,
  SignInSkeleton,
  TabSkeleton,
} from '@/components/LoadingSkeletons';
import NetWorthCard from '@/components/NetWorthCard';
import NetWorthChart from '@/components/NetWorthChart';
import { GEAR, HeaderIcon, REFRESH } from '@/components/HeaderIcon';

// What screens show while they load (components/LoadingSkeletons.tsx): Home's
// Net worth card drawn on its own classes with placeholders for its figures,
// the app loading as a page (what Home streams while it reads the session,
// and what the sign-in and login pages hand over to), and Clerk's form's
// placeholder.

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const classesOf = (html: string) => new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(' ')));

describe('Home while it loads', () => {
  const html = renderToStaticMarkup(<HomeSkeleton />);

  test('the Net worth card, busy, its title in words and its figures as placeholders', () => {
    expect(html).toContain('<section class="stack net-worth-hero" aria-busy="true" aria-labelledby="net-worth-loading">');
    expect(html).toContain('<h2 id="net-worth-loading" class="total-label">Net worth</h2>');
    expect(html).toContain('<p class="visually-hidden" role="status">Loading</p>');
    // No figure, and nothing a screen reader reads but the title and the status.
    expect(text(html)).toBe('Net worth Loading');
  });

  // Look and feel, step 5: the hero's shape, so the first load moves nothing:
  // on the page, the change line's place, and Show as a table's line under
  // the range switch.
  test('the hero’s shape: no card, the change line’s place, and the table’s line', () => {
    expect(html).not.toMatch(/class="[^"]*\bcard\b/);
    expect(html).toContain('<div class="hero-line" aria-hidden="true"><div class="hero-delta">');
    expect(html).toMatch(/chart-range-switch[\s\S]*<div class="plan-table-view"><div class="home-skeleton-table-line">/);
  });

  test('drawn on the classes of the card and chart it stands for, so it is as tall as they are', () => {
    const points = Array.from({ length: 60 }, (_, i) => ({ date: new Date(Date.UTC(2026, 7, 1) + i * 864e5).toISOString().slice(0, 10), value: 1000 + i }));
    const real = classesOf(
      renderToStaticMarkup(
        <NetWorthCard
          worth={1000}
          currency="USD"
          delta={<div className="hero-delta up">up</div>}
          caveats={[]}
          chart={<NetWorthChart hero points={points} />}
          pausedSince={null}
          notesProblem={null}
          backupProblem={null}
          filesProblem={null}
          asOf="2026-10-23T09:14:00Z"
          refreshing={false}
          notesCount={0}
          onNotes={() => {}}
        />
      )
    );
    // Its own classes are the placeholders and their sizes; every other is the card's or the chart's.
    const layout = [...classesOf(html)].filter((c) => c !== 'skeleton' && c !== 'block' && !c.startsWith('home-skeleton-') && c !== 'visually-hidden');
    expect(layout.filter((c) => !real.has(c))).toEqual([]);
    for (const c of ['total-value', 'hero-delta', 'chart-readout', 'chart-readout-date', 'chart-info-btn', 'segmented', 'compact', 'chart-range-switch', 'net-worth-foot']) expect(layout).toContain(c);
  });
});

describe('the app loading, as a page', () => {
  const clerk = renderToStaticMarkup(<AppLoading account="clerk" />);
  const password = renderToStaticMarkup(<AppLoading account="password" />);
  const actions = (html: string) => html.slice(html.indexOf('<div class="top-actions">'), html.indexOf('<section'));

  test('the dashboard header, with no line under the name, and Home loading', () => {
    expect(clerk).toContain('<main class="wrap"><div class="top-row"><div class="brand">');
    expect(clerk).toContain('<h1>Nya</h1>');
    expect(clerk).not.toContain('class="sub"');
    expect(clerk).toContain(renderToStaticMarkup(<HomeSkeleton />));
  });

  test('the header’s own buttons, as the dashboard draws them while it loads', () => {
    const header = actions(clerk);
    // Hide amounts works; Refresh turns, unavailable, drawn with the dashboard's own icon.
    expect(header).toContain('aria-label="Hide amounts"');
    expect(header).toContain(
      `<button class="icon-btn" disabled="" aria-label="Refresh" title="Refresh">${renderToStaticMarkup(<HeaderIcon d={REFRESH} spin />)}</button>`
    );
    // The account menu's place holds the circle ClerkAccount keeps until Clerk draws the avatar.
    expect(header).toContain('<div class="user-button-slot"><span class="skeleton user-button-skeleton" aria-hidden="true"></span></div>');
    expect(header).not.toContain('Settings');
  });

  test('password mode: the Settings gear, which does nothing until the dashboard is in', () => {
    const header = actions(password);
    expect(header).not.toContain('user-button-slot');
    expect(header).toContain(
      `<button class="icon-btn" aria-disabled="true" aria-label="Settings" title="Settings">${renderToStaticMarkup(<HeaderIcon d={GEAR} />)}</button>`
    );
  });

  test('said once to a screen reader: one status, the card’s', () => {
    expect(clerk.match(/role="status"/g)?.length).toBe(1);
  });
});

describe('Clerk’s form while it loads', () => {
  test('a card of placeholders, its status in words', () => {
    const html = renderToStaticMarkup(<SignInSkeleton status="Loading the sign-in form" />);
    expect(html).toStartWith('<div class="signin-skeleton" role="status"><span class="visually-hidden">Loading the sign-in form</span>');
    expect(text(html)).toBe('Loading the sign-in form');
    expect(html).toContain('<div class="signin-skeleton-card" aria-hidden="true">');
    expect(html).toContain('<div class="signin-skeleton-foot" aria-hidden="true">');
  });
});

// Each tab while it loads (lib/dashboard-tab.ts keeps the tab across a
// reload, so the first paint is the tab's own): drawn on the tab's classes,
// busy, said once, placeholders hidden, the bar the tab's own but unavailable.
describe('every tab while it loads', () => {
  const css = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8');
  // Classes the tabs' own lists carry with no rule of their own (txn-list,
  // budget-rows): the skeleton is drawn on them too.
  const realClasses = new Set(
    ['MonthBreakdown.tsx', 'BudgetsCard.tsx'].flatMap((f) =>
      [...readFileSync(join(import.meta.dir, '..', 'components', f), 'utf8').matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(' '))
    )
  );
  // What a screen reader is given: nothing inside inert or aria-hidden.
  const spoken = (html: string) => {
    let out = '';
    let hiddenAt = -1;
    let depth = 0;
    for (const m of html.matchAll(/<(\/?)(\w+)([^>]*?)(\/?)>|[^<]+/g)) {
      const [whole, closing, , attrs = '', selfClosing] = m;
      if (!whole.startsWith('<')) {
        if (hiddenAt < 0) out += ` ${whole} `;
        continue;
      }
      if (closing) {
        depth--;
        if (depth === hiddenAt) hiddenAt = -1;
      } else if (!selfClosing) {
        if (hiddenAt < 0 && /\sinert=""|\saria-hidden="true"/.test(attrs)) hiddenAt = depth;
        depth++;
      }
    }
    return text(out);
  };
  const views: [string, string, string][] = [
    ['Accounts', renderToStaticMarkup(<AccountsSkeleton />), 'Loading'],
    ['Activity, Transactions', renderToStaticMarkup(<ActivitySkeleton segment="transactions" />), 'Loading transactions'],
    ['Activity, Spending', renderToStaticMarkup(<ActivitySkeleton segment="spending" />), 'Loading transactions'],
    ['Activity, Shared', renderToStaticMarkup(<ActivitySkeleton segment="shared" />), 'Loading'],
    ['Budgets, Month', renderToStaticMarkup(<BudgetsSkeleton segment="month" />), 'Loading budgets'],
    ['Budgets, Upcoming', renderToStaticMarkup(<BudgetsSkeleton segment="upcoming" />), 'Loading what is coming'],
    ['Budgets, Goals', renderToStaticMarkup(<BudgetsSkeleton segment="goals" />), 'Loading goals'],
    ['Plan', renderToStaticMarkup(<PlanSkeleton segment="stress" />), 'Loading your plan'],
    ['Shared with me', renderToStaticMarkup(<SharedWithMeSkeleton />), 'Loading what is shared with you'],
    ['Progress', renderToStaticMarkup(<LinesSkeleton status="Loading your saved plan" lines={2} />), 'Loading your saved plan'],
  ];

  for (const [name, html, status] of views) {
    test(`${name}: busy, one status in words, every other word hidden, no spinner`, () => {
      expect(html.match(/aria-busy="true"/g)?.length).toBe(1);
      expect(html.match(/role="status"/g)?.length).toBe(1);
      expect(html).toContain(`<p class="visually-hidden" role="status">${status}</p>`);
      expect(spoken(html)).toBe(status);
      expect(html).not.toContain('spinner');
    });

    test(`${name}: every class it is drawn with is in the stylesheet, or one the real component carries`, () => {
      const missing = [...classesOf(html)].filter((c) => !new RegExp(`\\.${c}(?![\\w-])`).test(css) && !realClasses.has(c));
      expect(missing).toEqual([]);
    });
  }

  test('the bars are the tabs’ own, on the segment they will open on, and unavailable until the tab is in', () => {
    const activity = renderToStaticMarkup(<ActivitySkeleton segment="spending" />);
    expect(activity).toStartWith('<div inert=""><div class="activity-bar">');
    expect(activity).toContain('aria-selected="true" aria-controls="activity-panel" tabindex="0">Spending</button>');
    // The month's row held, its name still to come.
    expect(activity).toContain('<h2 class="month-stepper-title" tabindex="-1" aria-live="polite"><span class="skeleton activity-skeleton-month" aria-hidden="true"></span></h2>');
    expect(activity).not.toContain('<select');
    // Shared isn't by month: the month's row is held all the same, empty, as the tab draws it.
    const shared = renderToStaticMarkup(<ActivitySkeleton segment="shared" />);
    expect(shared).not.toContain('month-stepper');
    expect(shared).toContain('<div class="activity-month"></div>');
    // Budgets' Goals and Upcoming: the row held, its heading read alone, never the tab's name on screen.
    for (const segment of ['goals', 'upcoming'] as const) expect(renderToStaticMarkup(<BudgetsSkeleton segment={segment} />)).toContain('<div class="budgets-heading"><h2 class="visually-hidden">');
    const budgets = renderToStaticMarkup(<BudgetsSkeleton segment="month" />);
    expect(budgets).toStartWith('<div inert=""><div class="budgets-bar">');
    expect(budgets).toContain('<span class="skeleton budgets-skeleton-month" aria-hidden="true"></span>');
    const plan = renderToStaticMarkup(<PlanSkeleton segment="portfolio" />);
    expect(plan).toStartWith('<div inert=""><div class="plan-bar">');
    expect(plan).toContain('>Your plan</h2>');
    expect(plan).toContain('aria-selected="true" aria-controls="plan-panel-portfolio" tabindex="0">Portfolio</button>');
    expect(renderToStaticMarkup(<AccountsSkeleton />)).toContain('<div class="accounts-bar" inert="">');
  });

  test('Accounts: Add account tonal at the right, then the totals as a strip of two, the common case', () => {
    const html = renderToStaticMarkup(<AccountsSkeleton />);
    expect(html).toContain('<div class="accounts-bar" inert=""><span class="btn secondary">');
    expect(html).toContain('<div class="card stack" aria-hidden="true"><ul class="stat-strip">');
    expect(html.match(/<li class="stat">/g)).toHaveLength(2);
    expect(html).not.toContain('accounts-summary');
  });

  test('Settings, when the address has it open: its bar and title, then its rows or a section’s card', () => {
    const list = renderToStaticMarkup(<SettingsSkeleton view="list" />);
    expect(list).toStartWith('<section class="settings" aria-busy="true" aria-labelledby="settings-loading-title"><div class="settings-bar" inert="">');
    expect(list).toContain('aria-label="Close Settings"');
    expect(list).toContain('<h2 id="settings-loading-title">Settings</h2>');
    expect(list).toContain('<ul class="card list-rows" aria-hidden="true">');
    expect(list.match(/<li>/g)).toHaveLength(6);
    // Without Clerk there is no Sharing: one row fewer, as the list will draw.
    expect(renderToStaticMarkup(<SettingsSkeleton view="list" sharing={false} />).match(/<li>/g)).toHaveLength(5);
    expect(renderToStaticMarkup(<AppLoading account="password" settings="list" />).match(/<li>/g)).toHaveLength(5);
    const data = renderToStaticMarkup(<SettingsSkeleton view="data" />);
    expect(data).toContain('aria-label="Back to Settings"');
    expect(data).toContain('<h2 id="settings-loading-title">Your data and privacy</h2>');
    for (const html of [list, data]) expect(html.match(/role="status"/g)?.length).toBe(1);
  });

  test('the known words show as words: card titles and the figures’ labels', () => {
    const activity = renderToStaticMarkup(<ActivitySkeleton segment="transactions" />);
    for (const w of ['>In<', '>Out<', '>Net<', '>Transactions<', 'placeholder="Search transactions"']) expect(activity).toContain(w);
    // The In, Out and Net strip (components/MonthFigures.tsx) itself, its
    // figures to come, hidden from a screen reader (the one status says it
    // is loading), first on Transactions, before the list.
    const heading = /<section class="month-figures" aria-labelledby="([^"]+)" aria-hidden="true"><h2 id="([^"]+)" class="visually-hidden">In and out<\/h2>/.exec(activity);
    expect(heading).not.toBeNull();
    expect(heading![1]).toBe(heading![2]);
    expect(activity.indexOf('month-figures')).toBeLessThan(activity.indexOf('<h2>Transactions</h2>'));
    const spending = renderToStaticMarkup(<ActivitySkeleton segment="spending" />);
    const at = (w: string) => spending.indexOf(w);
    // The switch's own markup and classes, on 1M, under inert, nothing dimmed.
    expect(spending).toContain('<div class="segmented spending-period" inert="">');
    expect(at('>1M</button>')).toBeGreaterThan(-1);
    // Then the strip, as MonthBreakdown draws it (no span at 1M), then the
    // Cash flow card; no In and out card.
    expect(at('>1M</button>')).toBeLessThan(at('class="month-figures"'));
    expect(at('class="month-figures"')).toBeLessThan(at('>Cash flow<'));
    expect(spending).not.toContain('month-figures-caption');
    expect(spending).not.toContain('<div class="inst-name">In and out</div>');
    expect(spending).toContain('<button type="button" role="radio" aria-checked="true" tabindex="-1">1M</button>');
    expect(spending.slice(at('spending-period'), spending.indexOf('</div>', at('spending-period')))).not.toContain('disabled');
    expect(renderToStaticMarkup(<BudgetsSkeleton segment="month" />)).toContain('<h3>Spent</h3>');
    expect(renderToStaticMarkup(<BudgetsSkeleton segment="upcoming" />)).toContain('<h3>Cash forecast</h3><span class="badge">Estimate</span>');
    // The forecast's Show as a table keeps its 44px line while it loads.
    expect(renderToStaticMarkup(<BudgetsSkeleton segment="upcoming" />)).toContain('<details class="plan-table-view" inert=""><summary>Show as a table</summary></details>');
    expect(renderToStaticMarkup(<SharedWithMeSkeleton />)).toContain('Shared with me');
  });

  test('the open tab picks its own, on its segment; Home keeps the Net worth card', () => {
    expect(renderToStaticMarkup(<TabSkeleton tab="home" />)).toBe(renderToStaticMarkup(<HomeSkeleton />));
    expect(renderToStaticMarkup(<TabSkeleton tab="accounts" />)).toBe(renderToStaticMarkup(<AccountsSkeleton />));
    expect(renderToStaticMarkup(<TabSkeleton tab="activity" segments={{ activity: 'spending' }} />)).toBe(renderToStaticMarkup(<ActivitySkeleton segment="spending" />));
    expect(renderToStaticMarkup(<TabSkeleton tab="budgets" segments={{ budgets: 'goals' }} />)).toBe(renderToStaticMarkup(<BudgetsSkeleton segment="goals" />));
    expect(renderToStaticMarkup(<TabSkeleton tab="plan" />)).toBe(renderToStaticMarkup(<PlanSkeleton segment="path" />));
  });

  test('the app loading, as a page, draws the tab the address asks for', () => {
    const plan = renderToStaticMarkup(<AppLoading account="clerk" tab="plan" />);
    expect(plan).toContain(renderToStaticMarkup(<PlanSkeleton />));
    expect(plan).not.toContain('Net worth');
    expect(plan.match(/role="status"/g)?.length).toBe(1);
    expect(renderToStaticMarkup(<AppLoading account="clerk" />)).toContain(renderToStaticMarkup(<HomeSkeleton />));
    // Settings open over a tab: Settings' loading view, not the tab's.
    const settings = renderToStaticMarkup(<AppLoading account="clerk" tab="plan" settings="sharing" />);
    expect(settings).toContain(renderToStaticMarkup(<SettingsSkeleton view="sharing" />));
    expect(settings).not.toContain('plan-bar');
  });

  test('the tabs draw them in place of the spinners they had', () => {
    const read = (p: string) => readFileSync(join(import.meta.dir, '..', 'components', p), 'utf8');
    expect(read('MonthBreakdown.tsx')).toContain('<ActivityListSkeleton segment={segment} />');
    expect(read('BudgetsTab.tsx')).toContain("panel('month', <BudgetsMonthSkeleton />)");
    expect(read('PlanTabLoader.tsx')).toContain('<PlanSkeleton segment={props.segment} />');
    expect(read('PlanTab.tsx')).toContain('<PlanPanelSkeleton />');
    for (const f of ['MonthBreakdown.tsx', 'BudgetsTab.tsx', 'PlanTabLoader.tsx', 'PlanTab.tsx']) expect(read(f)).not.toContain('className="spinner"');
    // A placeholder is a box or a line's width, never a sentence in a pulsing bar.
    expect(read('PlanProgress.tsx')).not.toContain('<p className="skeleton"');
  });
});
