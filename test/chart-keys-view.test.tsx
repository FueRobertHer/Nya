import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { installDom, FakeEvent, type FakeElement } from './mini-dom';

// The charts read by the keys as the net worth chart is
// (components/chart-keys.ts): Income vs spend, the cash forecast, the payoff
// plan, the plan's fan, the runway and the allocation's history. Each plot is
// a slider in the tab order, named by its summary and described by a line of
// help; the arrows move the readout a point at a time, exactly as a finger
// does, Home and End go to the ends, and Escape or leaving the plot puts it
// back where it rests. Escape with nothing moved is the page's, so a sheet
// around the chart still closes on it. The slider's value follows the point
// only once the keys rest, so it is said once.

const dom = installDom();

afterAll(() => {
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: MonthFlowChart } = await import('@/components/MonthFlowChart');
const { default: ForecastChart, fmtDay } = await import('@/components/ForecastChart');
const { NO_INPUTS, PayoffPanel, monthLabel } = await import('@/components/DebtPayoff');
const { default: PlanFanChart } = await import('@/components/PlanFanChart');
const { default: RunwayChart } = await import('@/components/RunwayChart');
const { AllocationHistoryChart } = await import('@/components/AllocationCard');
const { reportDay } = await import('@/components/ReportView');
const { dayName } = await import('@/components/plan-text');
const { buildForecast } = await import('@/lib/forecast');
const { addMonths } = await import('@/lib/payoff');
const { formatMoney, MASK, setAmountsHidden } = await import('@/lib/format');
type Txn = import('@/components/MonthBreakdown').Txn;
type ForecastEvent = import('@/lib/forecast').ForecastEvent;
type DebtInstitutionInput = import('@/lib/payoff').DebtInstitutionInput;
type RunwayProjection = import('@/lib/report/runway').RunwayProjection;
type SeriesDay = import('@/lib/allocation/series').SeriesDay;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Income vs spend over five past days: pay on the first, and each day's
// spending a different amount, so each day's running total is its own.
const row = (date: string, amount: number, k: number): Txn =>
  ({
    transaction_id: `k${k}`,
    date,
    name: amount < 0 ? 'ACME CORP' : 'Whole Foods',
    amount,
    pending: false,
    account_name: 'Checking',
    institution_name: 'Chase',
    category: amount < 0 ? 'income' : 'groceries',
    iso_currency_code: 'USD',
  }) as Txn;
const SPENT = [100, 20, 30, 40, 50];
const ROWS: Txn[] = [row('2026-09-01', -1000, 0), ...SPENT.map((a, k) => row(`2026-09-0${k + 1}`, a, k + 1))];
const OUT = SPENT.map((_, k) => SPENT.slice(0, k + 1).reduce((s, a) => s + a, 0));

// The forecast: now and ten days.
const ev = (date: string, amount: number, name: string): ForecastEvent => ({ date, amount, name, source: amount < 0 ? 'bill' : 'income', ref: name });
const FORECAST = buildForecast(2400, [ev('2026-10-15', -1500, 'Rent')], '2026-10-09', 10, 0, 'USD');

// The payoff plan for one card, paying its minimum: it rests on the month it is done.
const START = '2026-10';
const CHASE: DebtInstitutionInput = {
  institution_name: 'Chase',
  liabilities: 'on',
  accounts: [
    {
      account_id: 'sapphire',
      name: 'Sapphire',
      mask: '4321',
      type: 'credit',
      subtype: 'credit card',
      balance: 4210.55,
      currency: 'USD',
      liability: { kind: 'credit', apr: 21.24, apr_label: 'Purchase APR', minimum_payment: 120 },
    },
  ],
};

// The plan's fan: ten years from 40.
const years = Array.from({ length: 11 }, (_, i) => i);
const BANDS = {
  p10: years.map((i) => 50_000 + i * 5_000),
  p25: years.map((i) => 80_000 + i * 8_000),
  p50: years.map((i) => 100_000 + i * 10_000),
  p75: years.map((i) => 120_000 + i * 12_000),
  p90: years.map((i) => 150_000 + i * 15_000),
};
const when = (i: number) => (i === 10 ? 'at the end (age 50)' : i === 0 ? 'at the start (age 40)' : `at age ${40 + i}`);

// The runway: five points from today.
const RUNWAY_DAYS = ['2026-10-29', '2026-11-28', '2026-12-28', '2027-01-27', '2027-02-26'];
const PROJECTION = {
  chart: RUNWAY_DAYS.map((date, i) => ({ date, with: 9000 - i * 500, without: 9000 - i * 2000 })),
  without_income: { runs_out: null },
  with_income: { runs_out: null },
} as unknown as RunwayProjection;

// The allocation's history: three recorded days.
const MIX_DAYS: SeriesDay[] = ['2026-10-01', '2026-10-08', '2026-10-15'].map((date, i) => ({
  date,
  classes: { us_stocks: 6000 + i * 100, bonds: 4000 },
  total: 10000 + i * 100,
  unlisted: 0,
  missing: [],
  left_out: [],
})) as unknown as SeriesDay[];

// Rent on the 15th is its lowest: the end of that day, point 7.
const LOW = FORECAST.days.findIndex((d) => d.date === '2026-10-15') + 1;

/** Each chart, the point it rests on, and what its readout says at a point. */
const CHARTS: { name: string; node: () => React.ReactNode; rest: 'first' | 'last' | number; at: (i: number) => string }[] = [
  {
    name: 'Income vs spend',
    node: () => <MonthFlowChart txns={ROWS} from="2026-09-01" to="2026-09-05" currency="USD" />,
    rest: 'last',
    at: (i) => formatMoney(OUT[i], 'USD'),
  },
  {
    name: 'the cash forecast',
    node: () => <ForecastChart forecast={FORECAST} currency="USD" threshold={0} />,
    rest: LOW,
    at: (i) => (i === 0 ? 'now' : i === 1 ? 'end of today, estimated' : `end of ${fmtDay(FORECAST.days[i - 1].date)}, estimated`),
  },
  {
    name: 'the payoff plan',
    node: () => <PayoffPanel institutions={[CHASE]} inputs={NO_INPUTS} onChange={() => {}} startMonth={START} />,
    rest: 'last',
    at: (i) => (i === 0 ? 'owed now' : `owed in ${monthLabel(addMonths(START, i))}`),
  },
  {
    name: 'the plan’s fan',
    node: () => <PlanFanChart bands={BANDS} startAge={40} currency="USD" />,
    rest: 'last',
    at: when,
  },
  {
    name: 'the runway',
    node: () => <RunwayChart projection={PROJECTION} currency="USD" />,
    rest: 'first',
    at: (i) => (i === 0 ? 'now' : `${reportDay(RUNWAY_DAYS[i])}, estimated`),
  },
  {
    name: 'the allocation’s history',
    node: () => <AllocationHistoryChart days={MIX_DAYS} currency="USD" answer={{ accounts: [] }} nameOf={(id) => id} />,
    rest: 'last',
    at: (i) => dayName(MIX_DAYS[i].date),
  },
];

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
  const plot = () => host.findAll((e) => e.tagName.toLowerCase() === 'svg' && e.getAttribute('role') === 'slider')[0];
  return {
    host,
    plot,
    /** The readout over the plot, as one line. */
    readout: () =>
      host
        .findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes('chart-readout'))[0]
        .textContent.replace(/\s+/g, ' ')
        .trim(),
    /** A key pressed on the focused plot; the event, to see what it did. */
    key: (k: string) => {
      const e = Object.assign(new FakeEvent('keydown'), { key: k });
      act(() => {
        plot().dispatchEvent(e);
      });
      return e;
    },
    /** Focus leaving the plot. */
    blur: () =>
      act(() => {
        plot().dispatchEvent(new FakeEvent('focusout'));
      }),
    said: () => [plot().getAttribute('aria-valuenow'), plot().getAttribute('aria-valuetext')],
  };
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 600))));
const last = (plot: FakeElement) => Number(plot.getAttribute('aria-valuemax')) - 1;

for (const c of CHARTS) {
  describe(`${c.name}, by the keys`, () => {
    test('the plot is a slider in the tab order, named by its summary and told how to use it', () => {
      const v = mount(c.node());
      const plot = v.plot();
      expect(plot.getAttribute('tabindex')).toBe('0');
      expect(plot.getAttribute('aria-label')!.length).toBeGreaterThan(20);
      const help = v.host.findAll((e) => e.getAttribute('id') === plot.getAttribute('aria-describedby'))[0];
      expect(help.getAttribute('class')).toBe('visually-hidden');
      expect(help.textContent).toStartWith('Left and right arrows move from');
      expect(help.textContent).toContain('Home and End go to');
      expect(help.textContent).toContain('Escape goes back to');
      expect(plot.getAttribute('aria-valuemin')).toBe('1');
      expect(plot.getAttribute('aria-valuenow')).toBe(c.rest === 'first' ? '1' : c.rest === 'last' ? plot.getAttribute('aria-valuemax') : String(c.rest + 1));
      expect(plot.getAttribute('aria-valuetext')!.length).toBeGreaterThan(0);
    });

    test('the arrows move the readout a point at a time, Home and End go to the ends, and other keys are the page’s', () => {
      const v = mount(c.node());
      const end = last(v.plot());
      expect(v.key('Home').defaultPrevented).toBe(true);
      expect(v.readout()).toContain(c.at(0));
      // Past the first point it stays there.
      v.key('ArrowLeft');
      expect(v.readout()).toContain(c.at(0));
      v.key('ArrowRight');
      expect(v.readout()).toContain(c.at(1));
      v.key('ArrowUp');
      expect(v.readout()).toContain(c.at(2));
      v.key('ArrowDown');
      expect(v.readout()).toContain(c.at(1));
      v.key('End');
      expect(v.readout()).toContain(c.at(end));
      v.key('ArrowLeft');
      expect(v.readout()).toContain(c.at(end - 1));
      expect(v.key('Tab').defaultPrevented).toBe(false);
    });

    test('Escape puts it back where it rests, and is the page’s when nothing moved; leaving the plot puts it back too', () => {
      const v = mount(c.node());
      const resting = v.readout();
      const untouched = v.key('Escape');
      expect(untouched.defaultPrevented).toBe(false);
      expect(untouched.propagationStopped).toBe(false);
      v.key('Home');
      v.key('ArrowRight');
      expect(v.readout()).toContain(c.at(1));
      const esc = v.key('Escape');
      expect(esc.defaultPrevented).toBe(true);
      expect(esc.propagationStopped).toBe(true);
      expect(v.readout()).toBe(resting);
      // Nothing moved now: a sheet around it closes on the next.
      expect(v.key('Escape').propagationStopped).toBe(false);
      v.key('Home');
      v.blur();
      expect(v.readout()).toBe(resting);
    });
  });
}

describe('the value is said once the keys rest', () => {
  test('Income vs spend: what came in and went out through the day, after the keys stop', async () => {
    const v = mount(CHARTS[0].node());
    const [now, text] = v.said();
    expect(now).toBe('5');
    expect(text).toContain(`out ${formatMoney(240, 'USD')}`);
    v.key('ArrowLeft');
    v.key('ArrowLeft');
    // Moving: the value still says where it was.
    expect(v.said()[0]).toBe('5');
    await settle();
    expect(v.said()[0]).toBe('3');
    expect(v.said()[1]).toStartWith(`In ${formatMoney(1000, 'USD')}, out ${formatMoney(150, 'USD')}, through `);
    v.key('Escape');
    await settle();
    expect(v.said()[0]).toBe('5');
  });

  test('the cash forecast: from the lowest, as the readout says it, a day’s end at a time', async () => {
    const v = mount(CHARTS[1].node());
    expect(v.said()).toEqual([String(LOW + 1), `${formatMoney(FORECAST.lowest.balance, 'USD')} lowest, around ${fmtDay('2026-10-15')}, estimated`]);
    v.key('ArrowRight');
    await settle();
    expect(v.said()).toEqual([String(LOW + 2), `${formatMoney(FORECAST.days[LOW].balance, 'USD')} end of ${fmtDay(FORECAST.days[LOW].date)}, estimated`]);
    v.key('Home');
    await settle();
    expect(v.said()).toEqual(['1', `${formatMoney(2400, 'USD')} now`]);
  });

  test('the plan’s fan: the median and the middle 80% at an age', async () => {
    const v = mount(CHARTS[3].node());
    expect(v.said()[1]).toContain('at the end (age 50)');
    v.key('Home');
    await settle();
    expect(v.said()[0]).toBe('1');
    expect(v.said()[1]).toBe('Median $100,000 at the start (age 40), middle 80% $50,000 to $150,000');
  });

  test('hidden amounts are said as hidden, never as bullets', async () => {
    setAmountsHidden(true);
    const v = mount(CHARTS[0].node());
    v.key('Home');
    await settle();
    const text = v.said()[1]!;
    expect(text).toContain('hidden');
    expect(text).not.toContain(MASK);
  });
});
