import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { installDom, FakeEvent } from './mini-dom';

// Every chart has every point behind Show as a table (design-system.md):
// Activity's Income vs spend (components/MonthFlowChart.tsx) and the
// runway's two lines (components/RunwayChart.tsx), as the net worth and
// forecast charts have. The table renders only once it is opened, says what
// its rows are in a caption, heads its columns, and writes its amounts
// through lib/format.ts, so hide amounts masks them.

const dom = installDom();
beforeAll(() => setSystemTime(new Date('2026-10-20T15:00:00Z')));
afterAll(() => {
  setSystemTime();
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: MonthFlowChart } = await import('@/components/MonthFlowChart');
const { default: RunwayChart } = await import('@/components/RunwayChart');
const { formatMoney, MASK, setAmountsHidden } = await import('@/lib/format');
type Txn = import('@/components/MonthBreakdown').Txn;
type RunwayProjection = import('@/lib/report/runway').RunwayProjection;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted = new Set<() => void>();
afterEach(() => {
  for (const unmount of mounted) unmount();
  setAmountsHidden(false);
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
  const tag = (name: string) => host.findAll((e) => e.tagName.toLowerCase() === name);
  return {
    host,
    summary: () => tag('summary')[0]?.textContent ?? null,
    tables: () => tag('table').length,
    /** Opens Show as a table, as a tap on its summary does. */
    open: () =>
      act(() => {
        const details = tag('details')[0];
        (details as unknown as { open: boolean }).open = true;
        details.dispatchEvent(new FakeEvent('toggle', false));
      }),
    caption: () => tag('caption')[0]?.textContent ?? null,
    heads: () => tag('th').map((th) => [th.textContent, th.getAttribute('scope'), th.getAttribute('class')]),
    rows: () => tag('tbody')[0].findAll((e) => e.tagName.toLowerCase() === 'tr').map((r) => r.findAll((e) => e.tagName.toLowerCase() === 'td').map((td) => td.textContent)),
    numCells: () => tag('td').filter((td) => td.getAttribute('class') === 'num').length,
  };
}

const money = (n: number) => formatMoney(n, 'USD');

let n = 0;
const row = (date: string, amount: number): Txn =>
  ({
    transaction_id: `t${++n}`,
    date,
    name: amount < 0 ? 'ACME CORP' : 'Whole Foods',
    amount,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Chase',
    category: amount < 0 ? 'income' : 'groceries',
    iso_currency_code: 'USD',
  }) as Txn;

// Five days of September: pay on the 1st, groceries on the 2nd and 4th.
const ROWS: Txn[] = [row('2026-09-01', -3100), row('2026-09-02', 400.5), row('2026-09-04', 96.25)];

const PROJECTION = {
  without_income: { runs_out: '2026-12-20' },
  with_income: { runs_out: null },
  chart: [
    { date: '2026-10-20', without: 5000, with: 5000 },
    { date: '2026-11-20', without: 2500.5, with: 4800 },
    { date: '2026-12-20', without: -120, with: 4600.25 },
  ],
} as unknown as RunwayProjection;

describe('Income vs spend: Show as a table', () => {
  test('every day’s running totals once opened, oldest first, with a caption and column heads', () => {
    const v = mount(<MonthFlowChart txns={ROWS} from="2026-09-01" to="2026-09-05" currency="USD" />);
    expect(v.summary()).toBe('Show as a table');
    expect(v.tables()).toBe(0);
    v.open();
    expect(v.caption()).toBe('Each day’s totals include the days before it.');
    expect(v.heads()).toEqual([
      ['Day', 'col', null],
      ['In', 'col', 'num'],
      ['Out', 'col', 'num'],
    ]);
    expect(v.rows()).toEqual([
      ['Sep 1', money(3100), money(0)],
      ['Sep 2', money(3100), money(400.5)],
      ['Sep 3', money(3100), money(400.5)],
      ['Sep 4', money(3100), money(496.75)],
      ['Sep 5', money(3100), money(496.75)],
    ]);
    expect(v.numCells()).toBe(10);
  });

  test('hidden amounts mask every figure in it', () => {
    setAmountsHidden(true);
    const v = mount(<MonthFlowChart txns={ROWS} from="2026-09-01" to="2026-09-05" currency="USD" />);
    v.open();
    const cells = v.rows().flatMap((r) => r.slice(1));
    expect(cells).toHaveLength(10);
    for (const c of cells) expect(c).toContain(MASK);
    expect(v.host.findAll((e) => e.tagName.toLowerCase() === 'tbody')[0].textContent).not.toMatch(/\d\.\d\d/);
  });
});

describe('The runway: Show as a table', () => {
  test('both lines at every point once opened, now first, said to be estimates', () => {
    const v = mount(<RunwayChart projection={PROJECTION} currency="USD" />);
    expect(v.summary()).toBe('Show as a table');
    expect(v.tables()).toBe(0);
    v.open();
    expect(v.caption()).toBe('Every day after now is an estimate.');
    expect(v.heads()).toEqual([
      ['Day', 'col', null],
      ['With income', 'col', 'num'],
      ['Without income', 'col', 'num'],
    ]);
    const rows = v.rows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(['Now', money(5000), money(5000)]);
    expect(rows[1].slice(1)).toEqual([money(4800), money(2500.5)]);
    expect(rows[2].slice(1)).toEqual([money(4600.25), money(-120)]);
    expect(rows[2][0]).not.toBe('Now');
    expect(v.numCells()).toBe(6);
  });

  test('hidden amounts mask every figure in it', () => {
    setAmountsHidden(true);
    const v = mount(<RunwayChart projection={PROJECTION} currency="USD" />);
    v.open();
    const cells = v.rows().flatMap((r) => r.slice(1));
    expect(cells).toHaveLength(6);
    for (const c of cells) expect(c).toContain(MASK);
    expect(v.host.findAll((e) => e.tagName.toLowerCase() === 'tbody')[0].textContent).not.toMatch(/\d\.\d\d/);
  });
});
