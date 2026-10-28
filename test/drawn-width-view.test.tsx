import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { installDom, FakeElement, FakeEvent } from './mini-dom';
import { categoriesFor } from './category-fixture';

// The charts drawn at their own width (components/drawn-width.ts): Activity's
// since rollout phase 5d, and Budgets' forecast and payoff plan since 6a4, as
// a browser lays them out (react-dom/client over test/mini-dom.ts, with a
// width and a ResizeObserver of the test's own): one viewBox unit to a CSS
// pixel, so their 12px text is 12px. The width is read as a chart mounts and
// followed after; a width of 0 keeps the last one; where nothing can be
// measured they draw at 340, as before. A finger on the chart is read against
// the width it is drawn at, and its lines are drawn again for a new width,
// even one that leaves its height as it was.

const dom = installDom();

// The width an svg is laid out at, as the test sets it; 0 where it isn't.
let laidOut = 0;
const rect = FakeElement.prototype.getBoundingClientRect;
FakeElement.prototype.getBoundingClientRect = function (this: FakeElement) {
  const r = rect.call(this);
  return this.tagName.toLowerCase() === 'svg' ? { ...r, width: laidOut, right: laidOut } : r;
};

// A ResizeObserver whose changes the test sends.
type Watch = { cb: (entries: { contentRect: { width: number } }[]) => void; el: unknown; on: boolean };
const watches: Watch[] = [];
class FakeResizeObserver {
  w: Watch;
  constructor(cb: Watch['cb']) {
    this.w = { cb, el: null, on: false };
    watches.push(this.w);
  }
  observe(el: unknown) {
    this.w.el = el;
    this.w.on = true;
  }
  disconnect() {
    this.w.on = false;
  }
}
const g = globalThis as Record<string, unknown>;
const hadObserver = Object.getOwnPropertyDescriptor(g, 'ResizeObserver');
const setObserver = (on: boolean) => {
  if (on) Object.defineProperty(g, 'ResizeObserver', { value: FakeResizeObserver, configurable: true, writable: true });
  else delete g.ResizeObserver;
};

afterAll(() => {
  FakeElement.prototype.getBoundingClientRect = rect;
  if (hadObserver) Object.defineProperty(g, 'ResizeObserver', hadObserver);
  else delete g.ResizeObserver;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { renderToStaticMarkup } = require('react-dom/server') as typeof import('react-dom/server');
const { default: MonthFlowChart } = await import('@/components/MonthFlowChart');
const { default: CashFlowSankey } = await import('@/components/CashFlowSankey');
const { default: ForecastChart, fmtDay } = await import('@/components/ForecastChart');
const { NO_INPUTS, PayoffPanel, monthLabel } = await import('@/components/DebtPayoff');
const { buildForecast, withPurchase } = await import('@/lib/forecast');
const { addMonths } = await import('@/lib/payoff');
const { localMonth } = await import('@/lib/local-date');
type Txn = import('@/components/MonthBreakdown').Txn;
type ForecastEvent = import('@/lib/forecast').ForecastEvent;
type DebtInstitutionInput = import('@/lib/payoff').DebtInstitutionInput;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const month = localMonth();
const { taxonomy } = categoriesFor({ groceries: 700, restaurants: 100 }, { words: ['groceries', 'restaurants', 'income'], groups: { groceries: 'Food', restaurants: 'Food' } });

let n = 0;
const row = (date: string, name: string, amount: number, category: string | null): Txn =>
  ({
    transaction_id: `w${++n}`,
    date,
    name,
    amount,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Chase',
    category,
    iso_currency_code: 'USD',
    vendor_key: name.toLowerCase(),
    logo_url: null,
    category_icon_url: null,
    subcategory: null,
    category_confidence: null,
    transaction_code: null,
    payment_channel: 'in store',
    datetime: null,
    website: null,
    check_number: null,
    account_owner: null,
    city: null,
    region: null,
    counterparty: null,
    payment_processor: null,
    payment_reference: null,
  }) as Txn;

const ROWS: Txn[] = [
  row(`${month}-01`, 'ACME CORP', -3100, 'income'),
  row(`${month}-01`, 'Whole Foods', 400, 'groceries'),
  row(`${month}-01`, 'Nopalito', 96, 'restaurants'),
];

// Budgets' 30-day forecast, as it builds one: today and the 30 days after.
const TODAY = '2026-10-09';
const ev = (date: string, amount: number, name: string): ForecastEvent => ({ date, amount, name, source: amount < 0 ? 'bill' : 'income', ref: name });
const EVENTS = [ev('2026-10-15', -1500, 'Rent'), ev('2026-10-23', 2100, 'ACME CORP')];
const FORECAST = buildForecast(2400, EVENTS, TODAY, 30, 0, 'USD');
// And with a $600 purchase on the 12th, as What if I buy… draws it.
const WHAT_IF = buildForecast(2400, withPurchase(EVENTS, { amount: 600, date: '2026-10-12' }), TODAY, 30, 0, 'USD');

// The payoff plan for one card, paying its minimum: 56 months.
const START = '2026-10';
const SAPPHIRE: DebtInstitutionInput['accounts'][number] = {
  account_id: 'sapphire',
  name: 'Sapphire',
  mask: '4321',
  type: 'credit',
  subtype: 'credit card',
  balance: 4210.55,
  currency: 'USD',
  liability: { kind: 'credit', apr: 21.24, apr_label: 'Purchase APR', minimum_payment: 120 },
};
const CHASE: DebtInstitutionInput = { institution_name: 'Chase', liabilities: 'on', accounts: [SAPPHIRE] };
const payoff = (institution: DebtInstitutionInput) => <PayoffPanel institutions={[institution]} inputs={NO_INPUTS} onChange={() => {}} startMonth={START} />;

/** Budgets' two charts, each with its shape (its height to 340 wide), what
 *  its readout says with a finger mid-chart on a 248-wide one, and the lines
 *  across its plot besides the gridlines. */
const CHARTS = [
  {
    name: 'the forecast',
    node: () => <ForecastChart forecast={FORECAST} currency="USD" threshold={1000} />,
    shape: 150,
    // 124 of 248 is 116 of its 230 units of plot: the end of the day 15 days
    // on. Read as 170 of 340, the same finger would be 21 days on.
    mid: `end of ${fmtDay('2026-10-24')}, estimated`,
    // The low-balance warning, which the line comes near.
    rules: ['var(--warn)'],
  },
  {
    name: 'the payoff plan',
    node: () => payoff(CHASE),
    shape: 140,
    // The same 116 of 230: month 28 of 56. Read as 170 of 340, month 39.
    mid: `owed in ${monthLabel(addMonths(START, 28))}`,
    rules: [],
  },
];

// What a failed test left mounted is unmounted before the next, so its
// watchers aren't counted against that one.
const mounted = new Set<() => void>();
afterEach(() => {
  for (const unmount of mounted) unmount();
});

function mount(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(node));
  const unmount = () => {
    if (mounted.delete(unmount)) act(() => root.unmount());
  };
  mounted.add(unmount);
  // The chart: the svg drawn as an image (an icon's is hidden from a screen reader).
  const svg = () => host.findAll((e) => e.tagName.toLowerCase() === 'svg' && e.getAttribute('role') === 'img')[0] ?? null;
  const lines = (test: (e: FakeElement) => boolean) => svg()!.findAll((e) => e.tagName.toLowerCase() === 'line' && test(e));
  return {
    host,
    svg,
    viewBox: () => svg()?.getAttribute('viewBox') ?? null,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
    // The ResizeObserver watching the chart now, sent a new width.
    resize: (width: number) => {
      const live = watches.filter((w) => w.on && w.el === svg());
      expect(live).toHaveLength(1);
      act(() => live[0].cb([{ contentRect: { width } }]));
    },
    // A finger at clientX on the chart, sliding along it.
    point: (clientX: number) => {
      const e = Object.assign(new FakeEvent('pointermove'), { clientX });
      act(() => {
        svg()!.dispatchEvent(e);
      });
    },
    // What the readout says of the point it reads.
    readout: () => host.findAll((e) => e.getAttribute('class') === 'chart-readout-date').map((e) => e.textContent),
    // Where the chart's line in `stroke` ends: its main one (the forecast, the
    // chosen plan) by default.
    lineEnd: (stroke = 'var(--accent)') => {
      const d = svg()!.findAll((e) => e.tagName.toLowerCase() === 'path' && e.getAttribute('stroke') === stroke)[0].getAttribute('d')!;
      return d.match(/L(-?[\d.]+,-?[\d.]+)$/)?.[1] ?? null;
    },
    // Each line drawn across the plot from its left edge (the gridlines, a
    // warning), as its stroke and where it ends.
    across: () => lines((e) => e.getAttribute('x1') === '8').map((e) => [e.getAttribute('stroke'), e.getAttribute('x2')]),
    // Each gridline's height, top first.
    gridlines: () => lines((e) => e.getAttribute('stroke') === 'var(--border-subtle)').map((e) => Number(e.getAttribute('y1'))).sort((a, b) => a - b),
    ticks: () => svg()!.findAll((e) => e.getAttribute('class') === 'chart-tick').map((e) => e.textContent),
    // The crosshair's top and bottom.
    crosshair: () => lines((e) => e.getAttribute('stroke') === 'var(--border-strong)').map((e) => [e.getAttribute('y1'), e.getAttribute('y2')]),
    // Where the last date is written.
    endLabel: () => svg()!.findAll((e) => e.getAttribute('class') === 'chart-xlabel' && e.getAttribute('text-anchor') === 'end').map((e) => [e.getAttribute('x'), e.getAttribute('y')]),
    unmount,
  };
}

describe('a chart drawn at its width', () => {
  test('Income vs spend: its viewBox is the width it is laid out at, in today’s shape, followed as it changes', () => {
    setObserver(true);
    laidOut = 248.7;
    const v = mount(<MonthFlowChart txns={ROWS} month={month} currency="USD" />);
    // Read as it mounts, rounded down so text never draws a hair small.
    expect(v.viewBox()).toBe(`0 0 248 ${Math.round((248 * 150) / 340)}`);
    v.resize(600);
    expect(v.viewBox()).toBe(`0 0 600 ${Math.round((600 * 150) / 340)}`);
    // Not laid out (a hidden card): it keeps the last width.
    v.resize(0);
    expect(v.viewBox()).toBe(`0 0 600 ${Math.round((600 * 150) / 340)}`);
    // Its axis text takes the 12px rule that only a chart at its width has.
    const svg = v.host.findAll((e) => e.tagName.toLowerCase() === 'svg')[0];
    expect(svg.getAttribute('class')).toBe('chart-svg at-width');
    v.unmount();
    // Unmounted, nothing is watched.
    expect(watches.filter((w) => w.on)).toHaveLength(0);
  });

  test('the cash flow: three columns at a phone’s width, four on a wide card, and measured when it first appears', () => {
    setObserver(true);
    laidOut = 248;
    // Nothing in the period yet: no chart to measure.
    const v = mount(<CashFlowSankey txns={[]} taxonomy={taxonomy} currency="USD" onPick={() => {}} />);
    expect(v.viewBox()).toBeNull();
    v.rerender(<CashFlowSankey txns={ROWS} taxonomy={taxonomy} currency="USD" onPick={() => {}} />);
    expect(v.viewBox()).toMatch(/^0 0 248 /);
    const categories = () => v.host.findAll((e) => e.tagName.toLowerCase() === 'title' && /^(Groceries|Restaurants|Other):/.test(e.textContent)).length;
    expect(categories()).toBe(0);
    expect(v.host.textContent).toContain('or a category in the table');
    // The table still has every category, each a button.
    expect(v.host.findAll((e) => e.tagName === 'BUTTON' && e.textContent.startsWith('Groceries'))).toHaveLength(1);
    v.resize(560);
    expect(v.viewBox()).toMatch(/^0 0 560 /);
    expect(categories()).toBeGreaterThan(0);
    expect(v.host.textContent).toContain('Tap a payer, a group or a category');
    v.unmount();
  });

  for (const c of CHARTS) {
    test(`${c.name}: its viewBox is the width it is laid out at, in its shape, followed as it changes`, () => {
      setObserver(true);
      laidOut = 248;
      const v = mount(c.node());
      expect(v.viewBox()).toBe(`0 0 248 ${Math.round((248 * c.shape) / 340)}`);
      v.resize(600);
      expect(v.viewBox()).toBe(`0 0 600 ${Math.round((600 * c.shape) / 340)}`);
      expect(v.svg()!.getAttribute('class')).toBe('chart-svg at-width');
      v.unmount();
      expect(watches.filter((w) => w.on)).toHaveLength(0);
    });

    test(`${c.name}: a finger mid-chart reads the point under it, on the width it is drawn at`, () => {
      setObserver(true);
      laidOut = 248;
      const v = mount(c.node());
      const atRest = v.readout();
      // Not at an edge, where a scrub is clamped to the last point whatever
      // width it reads against.
      v.point(124);
      expect(v.readout()).toEqual([c.mid]);
      expect(v.readout()).not.toEqual(atRest);
      // The crosshair runs the plot's height: 14 under the chart's top, for
      // the top tick's figure, to 24 over its bottom, for the dates.
      expect(v.crosshair()).toEqual([['14', String(Math.round((248 * c.shape) / 340) - 24)]]);
      v.unmount();
    });

    test(`${c.name}: its lines are drawn again for a new width, even one that leaves its height as it was`, () => {
      setObserver(true);
      laidOut = 600;
      const v = mount(c.node());
      const tall = Math.round((600 * c.shape) / 340);
      expect(Math.round((601 * c.shape) / 340)).toBe(tall);
      // The line ends at the plot's right edge, 10 in from the chart's; so
      // does every line across the plot, and the last date is written there,
      // 6 over the bottom.
      const edges = (width: number) => {
        const across = v.across();
        expect(across.length).toBeGreaterThan(0);
        expect(across.filter(([, x2]) => x2 !== String(width - 10))).toEqual([]);
        for (const rule of c.rules) expect(across.map(([stroke]) => stroke)).toContain(rule);
        expect(v.endLabel()).toEqual([[String(width - 10), String(tall - 6)]]);
      };
      expect(v.lineEnd()).toMatch(/^590\.0,/);
      edges(600);
      v.resize(601);
      expect(v.viewBox()).toBe(`0 0 601 ${tall}`);
      expect(v.lineEnd()).toMatch(/^591\.0,/);
      edges(601);
      v.unmount();
    });
  }

  test('the what-if: its line, over the forecast’s, ends at the plot’s right edge too, on a phone and on a wide card', () => {
    setObserver(true);
    laidOut = 248;
    const v = mount(<ForecastChart forecast={FORECAST} whatIf={WHAT_IF} currency="USD" threshold={1000} />);
    expect(v.viewBox()).toBe(`0 0 248 ${Math.round((248 * 150) / 340)}`);
    expect(v.lineEnd()).toMatch(/^238\.0,/);
    expect(v.lineEnd('var(--text-2)')).toMatch(/^238\.0,/);
    v.resize(600);
    expect(v.lineEnd()).toMatch(/^590\.0,/);
    expect(v.lineEnd('var(--text-2)')).toMatch(/^590\.0,/);
    v.unmount();
  });

  // Look and feel, step 4: brass beside orange is about 1.1:1, so the what-if
  // is a gray dotted line, not --warn, and the legend shows each line's dash.
  test('the what-if differs from the forecast by dash as well as color, and the legend shows each dash', () => {
    const html = renderToStaticMarkup(<ForecastChart forecast={FORECAST} whatIf={WHAT_IF} currency="USD" threshold={1000} />);
    expect(html).toMatch(/<path[^>]*stroke="var\(--accent\)"[^>]*stroke-dasharray="5 4"/);
    expect(html).toMatch(/<path[^>]*stroke="var\(--text-2\)"[^>]*stroke-dasharray="0 4"/);
    expect(html).not.toMatch(/<path[^>]*stroke="var\(--warn\)"/);
    const samples = [...html.matchAll(/<svg class="chart-legend-line"[^>]*><line[^>]*stroke="([^"]+)"[^>]*stroke-dasharray="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(samples).toEqual([
      ['var(--accent)', '5 4'],
      ['var(--text-2)', '0 4'],
    ]);
    // Its low point sits on the what-if line, so it takes that line's color
    // while it is above the warning (a threshold of 0 keeps it there).
    const calm = renderToStaticMarkup(<ForecastChart forecast={FORECAST} whatIf={WHAT_IF} currency="USD" threshold={0} />);
    expect(calm).toMatch(/<circle[^>]*r="4"[^>]*fill="var\(--text-2\)"/);
    expect(calm).not.toMatch(/<circle[^>]*r="4"[^>]*fill="var\(--accent\)"/);
  });

  test('on a phone their gridlines are 20 or more apart, and a wide card keeps each one the 1, 2, 5 rule gives', () => {
    const big: DebtInstitutionInput = {
      ...CHASE,
      accounts: [{ ...SAPPHIRE, balance: 11_550, liability: { kind: 'credit', apr: 21.24, apr_label: 'Purchase APR', minimum_payment: 300 } }],
    };
    const cases = [
      // A span the rule steps in 500s: five lines, 15 apart at 248.
      { name: 'the forecast', node: CHARTS[0].node, wide: ['$1K', '$1.5K', '$2K', '$2.5K', '$3K'] },
      // A peak of $11,550, which it steps in 2Ks: seven lines, 10 apart at 248.
      { name: 'the payoff plan', node: () => payoff(big), wide: ['$0', '$2K', '$4K', '$6K', '$8K', '$10K', '$12K'] },
    ];
    for (const c of cases) {
      setObserver(true);
      laidOut = 248;
      const v = mount(c.node());
      const apart = () => v.gridlines().flatMap((y, k, all) => (k === 0 ? [] : [y - all[k - 1]]));
      const narrow = v.ticks();
      expect([c.name, narrow.length >= 2]).toEqual([c.name, true]);
      expect([c.name, apart().filter((gap) => gap < 20)]).toEqual([c.name, []]);
      v.resize(600);
      expect([c.name, v.ticks()]).toEqual([c.name, c.wide]);
      expect(c.wide.length).toBeGreaterThanOrEqual(narrow.length);
      expect([c.name, apart().filter((gap) => gap < 20)]).toEqual([c.name, []]);
      v.unmount();
    }
  });

  test('the forecast in a panel hidden as it mounts draws at 340, then at its width once shown', () => {
    setObserver(true);
    laidOut = 0;
    const v = mount(CHARTS[0].node());
    expect(v.viewBox()).toBe('0 0 340 150');
    v.resize(248);
    expect(v.viewBox()).toBe(`0 0 248 ${Math.round((248 * 150) / 340)}`);
    v.unmount();
  });

  test('where nothing can be measured, every one draws at 340, as before', () => {
    setObserver(false);
    laidOut = 0;
    const line = mount(<MonthFlowChart txns={ROWS} month={month} currency="USD" />);
    expect(line.viewBox()).toBe('0 0 340 150');
    line.unmount();
    const flow = mount(<CashFlowSankey txns={ROWS} taxonomy={taxonomy} currency="USD" onPick={() => {}} />);
    expect(flow.viewBox()).toMatch(/^0 0 340 /);
    flow.unmount();
    for (const c of CHARTS) {
      const v = mount(c.node());
      expect([c.name, v.viewBox()]).toEqual([c.name, `0 0 340 ${c.shape}`]);
      v.unmount();
    }
  });
});
