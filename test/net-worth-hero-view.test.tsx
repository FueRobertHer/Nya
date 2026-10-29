import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { installDom, FakeElement, FakeEvent } from './mini-dom';

// Home's hero (look and feel, step 5): dragging across its chart moves the
// figure to the day under the finger, the change line's place says which
// day, and letting go brings back today. Only a pointer's scrub does: a
// measurement, a note chosen from the list, a reload or the chart going
// leave the figure on today.

const dom = installDom();

// The chart is laid out 352px wide (a 320px phone and the gutter's bleed),
// from the left of the screen, so a pointer's clientX is its viewBox x.
const LAID_OUT = 352;
const rect = FakeElement.prototype.getBoundingClientRect;
FakeElement.prototype.getBoundingClientRect = function (this: FakeElement) {
  const r = rect.call(this);
  return this.tagName.toLowerCase() === 'svg' ? { ...r, width: LAID_OUT, right: LAID_OUT } : r;
};

afterAll(() => {
  FakeElement.prototype.getBoundingClientRect = rect;
  dom.uninstall();
});

const React = await import('react');
const { act } = React;
for (const k of Object.keys(require.cache)) if (/react-dom[\\/](?:client\.js|cjs[\\/]react-dom-client\.)/.test(k)) delete require.cache[k];
const { createRoot } = require('react-dom/client') as typeof import('react-dom/client');
const { default: NetWorthCard } = await import('@/components/NetWorthCard');
const { default: NetWorthChart } = await import('@/components/NetWorthChart');
const { formatMoney, MASK, setAmountsHidden } = await import('@/lib/format');
type HistoryPoint = import('@/components/NetWorthChart').HistoryPoint;
type ChartNote = import('@/components/NetWorthChart').ChartNote;

// Ten days, the third an estimate, the last today's (the total).
const POINTS: HistoryPoint[] = Array.from({ length: 10 }, (_, i) => ({
  date: `2026-10-${String(i + 1).padStart(2, '0')}`,
  value: 1000 + i * 111.25,
  ...(i === 2 ? { estimated: true } : {}),
}));
const WORTH = POINTS[9].value;
// The hero's line runs from 2 to the width less 8, a point every 38.
const xOf = (i: number) => 2 + (i * (LAID_OUT - 10)) / 9;

const noop = () => {};
const card = (chart: React.ReactNode) => (
  <NetWorthCard
    worth={WORTH}
    currency="USD"
    delta={<div className="hero-delta up">▲ $10.00 (1.0%) · past 30 days</div>}
    caveats={[]}
    chart={chart}
    pausedSince={null}
    notesProblem={null}
    backupProblem={null}
    filesProblem={null}
    asOf={null}
    refreshing={false}
    notesCount={0}
    onNotes={noop}
  />
);

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
  const one = (cls: string) => host.findAll((e) => (e.getAttribute('class') ?? '').split(' ').includes(cls))[0] ?? null;
  const svg = () => host.findAll((e) => e.tagName.toLowerCase() === 'svg' && e.getAttribute('role') === 'slider')[0];
  const fire = (type: string, props: Record<string, unknown>) =>
    act(() => {
      svg().dispatchEvent(Object.assign(new FakeEvent(type), { pointerId: 1, button: 0, buttons: 1, ...props }));
    });
  return {
    host,
    figure: () => one('total-value')!.textContent,
    figureClass: () => one('total-value')!.getAttribute('class'),
    line: () => one('hero-line')!,
    day: () => one('hero-day')?.textContent ?? null,
    readout: () => one('chart-readout-value')!.textContent,
    touch: (type: string, i: number, clientY = 0) => fire(type, { pointerType: 'touch', clientX: xOf(i), clientY }),
    /** A finger down a day before `i` and moved sideways to it: a scrub. */
    scrub: (i: number) => {
      fire('pointerdown', { pointerType: 'touch', clientX: xOf(i - 1), clientY: 0 });
      fire('pointermove', { pointerType: 'touch', clientX: xOf(i), clientY: 0 });
    },
    mouse: (type: string, i: number, buttons = 0) => fire(type, { pointerType: 'mouse', clientX: xOf(i), buttons }),
    plot: svg,
    /** A key pressed on the focused plot; the event, to see what it did. */
    key: (k: string) => {
      const e = Object.assign(new FakeEvent('keydown'), { key: k });
      act(() => {
        svg().dispatchEvent(e);
      });
      return e;
    },
    /** Focus leaving the plot. */
    blur: () =>
      act(() => {
        svg().dispatchEvent(new FakeEvent('focusout'));
      }),
    rerender: (next: React.ReactNode) => act(() => root.render(next)),
  };
}

const money = (n: number) => formatMoney(n, 'USD');

describe('the hero line draws in once', () => {
  test('drawn on the server and on the first showing; after that, a new chart and a re-render never again', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    // The server can't know the page has shown it: the first render has it.
    expect(renderToStaticMarkup(<NetWorthChart hero points={POINTS} />)).toContain('class="chart-svg at-width hero-chart draw-in"');
    const first = mount(<NetWorthChart hero points={POINTS} />);
    // A new range is a re-render: the class stays, so nothing replays.
    first.rerender(<NetWorthChart hero points={POINTS.slice(1)} />);
    expect(first.plot().getAttribute('class')).toBe('chart-svg at-width hero-chart draw-in');
    // Back on Home after another tab: the line is simply there.
    const again = mount(<NetWorthChart hero points={POINTS} />);
    expect(again.plot().getAttribute('class')).toBe('chart-svg at-width hero-chart');
    // An account's chart never draws in.
    expect(renderToStaticMarkup(<NetWorthChart points={POINTS} />)).not.toContain('draw-in');
  });
});

describe('the hero, scrubbed', () => {
  test('a finger moves the figure to its day, says the day in the change line’s place, and keeps the readout on the range', () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    expect(v.figure()).toContain(money(WORTH));
    const range = v.readout();
    v.scrub(4);
    expect(v.figure()).toContain(money(POINTS[4].value));
    expect(v.figure()).not.toContain(money(WORTH));
    expect(v.day()).toBe('Oct 5');
    // The change line stays, hidden, holding its height.
    expect(v.line().getAttribute('class')).toBe('hero-line scrubbed');
    expect(v.line().textContent).toContain('past 30 days');
    expect(v.readout()).toBe(range);
    v.touch('pointermove', 2);
    expect(v.figure()).toContain(money(POINTS[2].value));
    expect(v.day()).toBe('Oct 3 · estimated');
  });

  test('a finger that goes up or down before sideways is a scroll starting: the figure stays on today', () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    v.touch('pointerdown', 4, 300);
    expect(v.day()).toBeNull();
    v.touch('pointermove', 4, 290);
    expect(v.figure()).toContain(money(WORTH));
    expect(v.day()).toBeNull();
    // The browser takes it as a scroll and cancels the touch.
    v.touch('pointercancel', 4, 280);
    expect(v.figure()).toContain(money(WORTH));
    // A tap with no move moves nothing either.
    v.touch('pointerdown', 6);
    v.touch('pointerup', 6);
    expect(v.day()).toBeNull();
  });

  test('losing the capture brings back today, and lifting one of two fingers scrubs to the other', () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    v.scrub(4);
    v.touch('lostpointercapture', 4);
    expect(v.figure()).toContain(money(WORTH));
    v.scrub(3);
    act(() => {
      v.host.findAll((e) => e.tagName.toLowerCase() === 'svg' && e.getAttribute('role') === 'slider')[0].dispatchEvent(
        Object.assign(new FakeEvent('pointerdown'), { pointerType: 'touch', pointerId: 2, clientX: xOf(7), clientY: 0, button: 0, buttons: 1 }),
      );
    });
    // Two fingers measure: the figure on today.
    expect(v.figure()).toContain(money(WORTH));
    v.touch('pointerup', 3);
    expect(v.figure()).toContain(money(POINTS[7].value));
  });

  test('lifting the finger, or the touch being cancelled, brings back today', () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    v.scrub(4);
    v.touch('pointerup', 4);
    expect(v.figure()).toContain(money(WORTH));
    expect(v.day()).toBeNull();
    expect(v.line().getAttribute('class')).toBe('hero-line');
    v.scrub(6);
    expect(v.figure()).toContain(money(POINTS[6].value));
    v.touch('pointercancel', 6);
    expect(v.figure()).toContain(money(WORTH));
  });

  test('a mouse over the plot moves it too, and leaving the plot brings back today', () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    v.mouse('pointermove', 7);
    expect(v.figure()).toContain(money(POINTS[7].value));
    act(() => {
      v.host.findAll((e) => e.tagName.toLowerCase() === 'svg' && e.getAttribute('role') === 'slider')[0].dispatchEvent(
        Object.assign(new FakeEvent('pointerout'), { pointerType: 'mouse', pointerId: 1, relatedTarget: null }),
      );
    });
    expect(v.figure()).toContain(money(WORTH));
  });

  test('a measurement between two days stays in the readout, and the figure on today', () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    v.mouse('pointerdown', 1, 1);
    v.mouse('pointermove', 6, 1);
    expect(v.figure()).toContain(money(WORTH));
    expect(v.day()).toBeNull();
    expect(v.host.textContent).toContain('Oct 2 to Oct 7');
    // The light accent review: the measured stretch deepens the gold under
    // the line, drawn over the solid wash (not under it, where it would be
    // hidden, nor over the page above the line).
    const plot = v.host.findAll((e) => e.tagName.toLowerCase() === 'svg' && e.getAttribute('role') === 'slider')[0];
    const paths = plot.findAll((e) => e.tagName.toLowerCase() === 'path');
    const wash = paths.findIndex((e) => e.getAttribute('fill') === 'var(--data-tint)');
    const slice = paths.findIndex((e) => e.getAttribute('fill') === 'var(--data)' && e.getAttribute('opacity') === '0.16');
    expect(wash).toBeGreaterThanOrEqual(0);
    expect(slice).toBeGreaterThan(wash);
    // Its shape: from the axis under Oct 2, through the six days to Oct 7,
    // and back down to the axis, both ends on the same baseline.
    const d = paths[slice].getAttribute('d')!;
    const m = /^M([\d.]+),([\d.]+)((?:L[\d.]+,[\d.]+){6})L([\d.]+),([\d.]+)Z$/.exec(d);
    expect(m).not.toBeNull();
    expect(m![2]).toBe(m![5]);
    expect(m![3].startsWith(`L${m![1]},`)).toBe(true);
    expect(m![3].includes(`L${m![4]},`)).toBe(true);
    expect(plot.findAll((e) => e.tagName.toLowerCase() === 'rect')).toHaveLength(0);
  });

  test('a negative day is drawn as one, and today’s figure comes back as it was', () => {
    const dip = POINTS.map((p, i) => (i === 3 ? { ...p, value: -250.5 } : p));
    const v = mount(card(<NetWorthChart hero points={dip} currency="USD" />));
    v.scrub(3);
    expect(v.figureClass()).toBe('total-value negative');
    expect(v.figure()).toContain(money(-250.5));
    v.touch('pointerup', 3);
    expect(v.figureClass()).toBe('total-value');
  });

  test('a note chosen from the list reads in the readout and leaves the figure on today', () => {
    const notes: ChartNote[] = [{ date: '2026-10-06', text: 'Sold the car' }];
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" notes={notes} />));
    const note = v.host.findAll((e) => (e.getAttribute('class') ?? '') === 'chart-note-btn')[0];
    act(() => {
      note.dispatchEvent(new FakeEvent('click'));
    });
    expect(v.figure()).toContain(money(WORTH));
    expect(v.day()).toBeNull();
    expect(v.readout()).toBe(money(POINTS[5].value));
    // Scrubbed to the noted day, its note is in the day line.
    v.scrub(5);
    expect(v.day()).toBe('Oct 6 · Sold the car');
  });

  test('hidden amounts mask the scrubbed figure, as today’s', () => {
    const shown = money(POINTS[4].value);
    setAmountsHidden(true);
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    v.scrub(4);
    expect(v.figure()).toContain(MASK);
    expect(v.figure()).not.toContain(shown);
    expect(v.figure()).not.toContain('1,4');
    expect(v.day()).toBe('Oct 5');
  });

  test('new points, or the chart going, leave no day behind', () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    v.scrub(4);
    v.rerender(card(<NetWorthChart hero points={POINTS.slice(1)} currency="USD" />));
    expect(v.figure()).toContain(money(WORTH));
    expect(v.day()).toBeNull();
    v.scrub(4);
    expect(v.day()).not.toBeNull();
    v.rerender(card(<p className="empty-note">History builds as you use the app.</p>));
    expect(v.figure()).toContain(money(WORTH));
    expect(v.day()).toBeNull();
  });

  test('Show as a table lists every day once opened, newest first, estimates said, amounts masked when hidden', () => {
    const open = (v: ReturnType<typeof mount>) => {
      const details = v.host.findAll((e) => e.tagName.toLowerCase() === 'details')[0];
      expect(details.findAll((e) => e.tagName.toLowerCase() === 'tr')).toHaveLength(0);
      act(() => {
        (details as unknown as { open: boolean }).open = true;
        details.dispatchEvent(new FakeEvent('toggle', false));
      });
      return details.findAll((e) => e.tagName.toLowerCase() === 'tr').slice(1).map((r) => r.textContent);
    };
    const rows = open(mount(card(<NetWorthChart hero points={POINTS} currency="USD" />)));
    expect(rows).toHaveLength(10);
    expect(rows[0]).toBe(`Oct 10${money(POINTS[9].value)}`);
    expect(rows[7]).toBe(`Oct 3 · estimated${money(POINTS[2].value)}`);
    const plain = money(POINTS[9].value);
    setAmountsHidden(true);
    const hidden = open(mount(card(<NetWorthChart hero points={POINTS} currency="USD" />)));
    expect(hidden[0]).not.toContain(plain);
    expect(hidden[0]).toContain(MASK);
  });

  // The screen review: every net worth chart has the table, an account's too.
  test('an account’s chart has Show as a table too, opened on demand, amounts masked when hidden', () => {
    const open = (v: ReturnType<typeof mount>) => {
      const details = v.host.findAll((e) => e.tagName.toLowerCase() === 'details')[0];
      expect(details.findAll((e) => e.tagName.toLowerCase() === 'tr')).toHaveLength(0);
      act(() => {
        (details as unknown as { open: boolean }).open = true;
        details.dispatchEvent(new FakeEvent('toggle', false));
      });
      return details.findAll((e) => e.tagName.toLowerCase() === 'tr').slice(1).map((r) => r.textContent);
    };
    const rows = open(mount(<NetWorthChart points={POINTS} label="Balance" currency="USD" />));
    expect(rows).toHaveLength(10);
    expect(rows[0]).toBe(`Oct 10${money(POINTS[9].value)}`);
    expect(rows[7]).toBe(`Oct 3 · estimated${money(POINTS[2].value)}`);
    const plain = money(POINTS[9].value);
    setAmountsHidden(true);
    const hidden = open(mount(<NetWorthChart points={POINTS} label="Balance" currency="USD" />));
    expect(hidden[0]).not.toContain(plain);
    expect(hidden[0]).toContain(MASK);
  });

  // Every day estimated but today, as a demo's history is: the line is solid,
  // the readout says "estimated" once for the range, and a scrubbed day keeps
  // its own word in the change line's place.
  test('a history estimated throughout: the readout says so once, and a scrubbed day still says it', () => {
    const estimated = POINTS.map((p, i) => (i < 9 ? { ...p, estimated: true } : { date: p.date, value: p.value }));
    const v = mount(card(<NetWorthChart hero points={estimated} currency="USD" />));
    const date = () => v.host.findAll((e) => e.getAttribute('class') === 'chart-readout-date')[0].textContent;
    expect(date().match(/estimated/g)).toHaveLength(1);
    expect(date()).toMatch(/ · estimated$/);
    v.scrub(4);
    expect(v.day()).toBe('Oct 5 · estimated');
    expect(date().match(/estimated/g)).toHaveLength(1);
  });

  test('a chart that isn’t the hero never moves the figure', () => {
    const v = mount(card(<NetWorthChart points={POINTS} currency="USD" />));
    v.scrub(4);
    expect(v.figure()).toContain(money(WORTH));
    expect(v.day()).toBeNull();
  });
});

// The design system's hero: the plot is focusable, the arrows move the figure
// a day at a time, Home and End jump to the ends, Escape or leaving the plot
// brings back today, and the new figure is said once movement stops.
describe('the hero, by the keys', () => {
  const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 600))));

  test('the plot is a slider in the tab order, named by its summary and told how to use', () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    const plot = v.plot();
    expect(plot.getAttribute('tabindex')).toBe('0');
    expect(plot.getAttribute('aria-label')).toContain('Net worth from Oct 1 to Oct 10.');
    const keys = v.host.findAll((e) => e.getAttribute('id') === plot.getAttribute('aria-describedby'))[0];
    expect(keys.getAttribute('class')).toBe('visually-hidden');
    expect(keys.textContent).toContain('Left and right arrows');
    expect(keys.textContent).toContain('Escape');
    expect(plot.getAttribute('aria-valuemin')).toBe('1');
    expect(plot.getAttribute('aria-valuemax')).toBe('10');
    expect(plot.getAttribute('aria-valuenow')).toBe('10');
    expect(plot.getAttribute('aria-valuetext')).toBe(`${money(WORTH)} on Oct 10`);
  });

  test('the arrows move the figure a day at a time, Home and End go to the ends, and the readout keeps the range', () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    const range = v.readout();
    expect(v.key('ArrowLeft').defaultPrevented).toBe(true);
    expect(v.figure()).toContain(money(POINTS[8].value));
    expect(v.day()).toBe('Oct 9');
    v.key('ArrowLeft');
    expect(v.figure()).toContain(money(POINTS[7].value));
    expect(v.day()).toBe('Oct 8');
    v.key('ArrowRight');
    expect(v.day()).toBe('Oct 9');
    v.key('Home');
    expect(v.figure()).toContain(money(POINTS[0].value));
    expect(v.day()).toBe('Oct 1');
    // Past the first day it stays there.
    v.key('ArrowLeft');
    expect(v.day()).toBe('Oct 1');
    v.key('ArrowRight');
    v.key('ArrowRight');
    expect(v.day()).toBe('Oct 3 · estimated');
    v.key('End');
    expect(v.figure()).toContain(money(WORTH));
    expect(v.day()).toBe('Oct 10');
    expect(v.readout()).toBe(range);
    // A key the plot doesn't use is left to the page.
    expect(v.key('Tab').defaultPrevented).toBe(false);
  });

  test('Escape brings back today, and is the page’s when there is nothing to bring back', () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    v.key('Home');
    expect(v.day()).toBe('Oct 1');
    const esc = v.key('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(esc.propagationStopped).toBe(true);
    expect(v.figure()).toContain(money(WORTH));
    expect(v.day()).toBeNull();
    expect(v.line().getAttribute('class')).toBe('hero-line');
    // Nothing moved: a sheet around the chart still closes on it.
    const again = v.key('Escape');
    expect(again.defaultPrevented).toBe(false);
    expect(again.propagationStopped).toBe(false);
  });

  test('leaving the plot brings back today', () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    v.key('ArrowLeft');
    v.key('ArrowLeft');
    expect(v.day()).toBe('Oct 8');
    v.blur();
    expect(v.figure()).toContain(money(WORTH));
    expect(v.day()).toBeNull();
  });

  test('the new figure is said once movement stops, not at every step', async () => {
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" />));
    const said = () => [v.plot().getAttribute('aria-valuenow'), v.plot().getAttribute('aria-valuetext')];
    v.key('ArrowLeft');
    v.key('ArrowLeft');
    v.key('ArrowLeft');
    // Moving: the value still says where it was.
    expect(said()).toEqual(['10', `${money(WORTH)} on Oct 10`]);
    await settle();
    expect(said()).toEqual(['7', `${money(POINTS[6].value)} on Oct 7`]);
    v.key('Home');
    v.key('ArrowRight');
    v.key('ArrowRight');
    await settle();
    expect(said()).toEqual(['3', `${money(POINTS[2].value)} on Oct 3, estimated`]);
    v.key('Escape');
    await settle();
    expect(said()).toEqual(['10', `${money(WORTH)} on Oct 10`]);
  });

  test('a note on the day is said with it, and hidden amounts are said as hidden', async () => {
    const notes: ChartNote[] = [{ date: '2026-10-06', text: 'Sold the car' }];
    setAmountsHidden(true);
    const v = mount(card(<NetWorthChart hero points={POINTS} currency="USD" notes={notes} />));
    for (let k = 0; k < 4; k++) v.key('ArrowLeft');
    expect(v.figure()).toContain(MASK);
    expect(v.day()).toBe('Oct 6 · Sold the car');
    await settle();
    const text = v.plot().getAttribute('aria-valuetext')!;
    expect(text).toContain('on Oct 6. Sold the car');
    expect(text).not.toContain(MASK);
    expect(text).not.toMatch(/\d\.\d\d/);
  });

  test('an account’s chart: the keys read the day in the readout, and Escape brings back the range', () => {
    const v = mount(card(<NetWorthChart points={POINTS} label="Balance" currency="USD" />));
    const range = v.readout();
    v.key('ArrowLeft');
    expect(v.readout()).toBe(money(POINTS[8].value));
    // Never the hero's figure.
    expect(v.figure()).toContain(money(WORTH));
    expect(v.day()).toBeNull();
    v.key('Escape');
    expect(v.readout()).toBe(range);
  });
});
