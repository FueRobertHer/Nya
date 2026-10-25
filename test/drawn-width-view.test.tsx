import { afterAll, describe, expect, test } from 'bun:test';
import { installDom, FakeElement } from './mini-dom';
import { categoriesFor } from './category-fixture';

// Activity's charts drawn at their own width (rollout phase 5d,
// components/drawn-width.ts), as a browser lays them out (react-dom/client
// over test/mini-dom.ts, with a width and a ResizeObserver of the test's
// own): one viewBox unit to a CSS pixel, so their 12px text is 12px. The
// width is read as a chart mounts and followed after; a width of 0 keeps the
// last one; and where nothing can be measured they draw at 340, as before.

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
const { default: MonthFlowChart } = await import('@/components/MonthFlowChart');
const { default: CashFlowSankey } = await import('@/components/CashFlowSankey');
const { localMonth } = await import('@/lib/local-date');
type Txn = import('@/components/MonthBreakdown').Txn;

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

function mount(node: React.ReactNode) {
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(node));
  const svg = () => host.findAll((e) => e.tagName.toLowerCase() === 'svg' && e.getAttribute('viewBox') !== '0 0 24 24')[0] ?? null;
  return {
    host,
    viewBox: () => svg()?.getAttribute('viewBox') ?? null,
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
    // The ResizeObserver watching the chart now, sent a new width.
    resize: (width: number) => {
      const live = watches.filter((w) => w.on && w.el === svg());
      expect(live).toHaveLength(1);
      act(() => live[0].cb([{ contentRect: { width } }]));
    },
    unmount: () => act(() => root.unmount()),
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

  test('where nothing can be measured, both draw at 340, as before', () => {
    setObserver(false);
    laidOut = 0;
    const line = mount(<MonthFlowChart txns={ROWS} month={month} currency="USD" />);
    expect(line.viewBox()).toBe('0 0 340 150');
    line.unmount();
    const flow = mount(<CashFlowSankey txns={ROWS} taxonomy={taxonomy} currency="USD" onPick={() => {}} />);
    expect(flow.viewBox()).toMatch(/^0 0 340 /);
    flow.unmount();
  });
});
