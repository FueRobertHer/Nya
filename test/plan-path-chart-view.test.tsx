import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PlanPathChart, { wholeShown, type PathChartProps } from '@/components/PlanPathChart';
import { DrawnWidth } from '@/components/drawn-width';
import { projectBalance } from '@/lib/fire/fi';
import { FiCard } from '@/components/PlanTab';
import { leftOutText, wholeMoney } from '@/components/plan-text';
import { DEFAULT_PLAN } from '@/lib/fire/plan';
import type { PlanFigures } from '@/lib/fire/plan-figures';
import { planPath } from '@/lib/fire/path';
import type { LifeEvent } from '@/lib/fire/events';
import { figuresOf } from './plan-gen';

// The summary says each amount in full, in whole dollars, never "$1.2M".
const c = (n: number) => wholeMoney(n, 'USD');

// Your path's chart (rollout phase 8b): one line of invested assets from
// today to the stop age, the FI number as a dashed line, a marker where the
// line reaches it, the stop age, a summary for a screen reader and a table
// of every year. Drawn at a phone's width.

const steady = (assets: number, savings: number, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, k) => ({ age: from + k, balance: projectBalance(assets, savings, 0.05, k) }));
const props = (over: Partial<PathChartProps> = {}): PathChartProps => ({
  points: steady(250_000, 30_000, 40, 65),
  today: 40,
  stopAge: 65,
  fiNumber: 1_000_000,
  fiAge: 52.9,
  realReturn: 0.05,
  currency: 'USD',
  ...over,
});
const draw = (p: PathChartProps, width = 320) =>
  renderToStaticMarkup(
    <DrawnWidth.Provider value={width}>
      <PlanPathChart {...p} />
    </DrawnWidth.Provider>
  );
const label = (html: string) => /role="img" aria-label="([^"]*)"/.exec(html)?.[1].replace(/&#x27;/g, "'") ?? null;
const ages = (html: string) => [...html.matchAll(/<text class="chart-xlabel"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
const markers = (html: string) => (html.match(/<circle /g) ?? []).length;
// How far the FI number's name is from the marker's center: its box, 55 wide
// and 12 tall over its baseline, from x at its left, or to x at its right
// when it is anchored at its line's end. 7 clears the 4px dot, its 2px ring
// and a gap. Infinity with no marker or no name. To a millionth of a pixel,
// as a place set 7 from the dot can come out a rounding short of it.
const offTheDot = (html: string) => {
  const dot = /<circle cx="([\d.]+)" cy="([\d.]+)"/.exec(html);
  const name = /<text class="chart-rule-label" x="([\d.]+)" y="([\d.]+)">FI number</.exec(html) ?? /<text class="chart-xlabel" x="([\d.]+)" y="([\d.]+)" text-anchor="end">FI number</.exec(html);
  if (!dot || !name) return Infinity;
  const [mx, my] = [Number(dot[1]), Number(dot[2])];
  const [nx, ny] = [Number(name[1]), Number(name[2])];
  const x0 = name[0].includes('chart-rule-label') ? nx : nx - 55;
  return Math.round(Math.hypot(mx - Math.min(Math.max(mx, x0), x0 + 55), my - Math.min(Math.max(my, ny - 12), ny)) * 1e6) / 1e6;
};
const dotOf = (html: string) => /<circle cx="([\d.]+)" cy="([\d.]+)"/.exec(html)!.slice(1).map(Number);

describe('the path chart', () => {
  test('one line to the stop age, the FI number, a marker where it is reached, and the ages: today, FI and the stop', () => {
    const html = draw(props());
    expect(html).toContain('viewBox="0 0 320 122"');
    expect(markers(html)).toBe(1);
    expect(html).toContain('stroke-dasharray="4 4"');
    expect(ages(html)).toEqual(['FI number', '40', '53', 'stop 65']);
    expect(label(html)).toBe(
      `Invested assets grow from ${c(250_000)} at 40, reach the ${c(1_000_000)} FI number around 53, and are about ${c(projectBalance(250_000, 30_000, 0.05, 25))} at 65, growing a steady 5% a year after inflation.`
    );
    expect(html).toContain('At a steady 5% a year after inflation. Real markets don’t move steadily; Drawdown shows how much that matters.');
  });

  // The light accent review: the wash is the solid --data-tint, so it is
  // drawn first and the axis, the FI line and its label go over it (the
  // label sits inside the wash once the path has crossed the FI number).
  test('the solid wash is drawn under the axis, the FI line and its label', () => {
    const html = draw(props());
    const wash = html.indexOf('fill="var(--data-tint)"');
    expect(wash).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('stroke="var(--border-subtle)"')).toBeGreaterThan(wash);
    expect(html.indexOf('stroke-dasharray="4 4"')).toBeGreaterThan(wash);
    expect(html.indexOf('>FI number</text>')).toBeGreaterThan(wash);
    expect(html.indexOf('stroke="var(--data)"')).toBeGreaterThan(html.indexOf('>FI number</text>'));
  });

  test('an FI age too close to the stop age to label is left unlabelled, never drawn over it', () => {
    const html = draw(props({ points: steady(250_000, 30_000, 40, 55), stopAge: 55 }));
    expect(ages(html)).toEqual(['FI number', '40', 'stop 55']);
    expect(markers(html)).toBe(1);
  });

  test('FI after the stop age: no marker, and the line ends at the stop age under the FI number', () => {
    const html = draw(props({ points: steady(250_000, 30_000, 40, 45), stopAge: 45 }));
    expect(markers(html)).toBe(0);
    expect(ages(html)).toEqual(['FI number', '40', 'stop 45']);
    expect(label(html)).toContain(`stay under the ${c(1_000_000)} FI number, and are about ${c(projectBalance(250_000, 30_000, 0.05, 5))} at 45`);
  });

  test('already there: the marker is on the line where it starts, and the summary says so', () => {
    const html = draw(props({ points: steady(2_000_000, 30_000, 40, 55), stopAge: 55, fiAge: 40 }));
    expect(markers(html)).toBe(1);
    // The line starts at x 2 (its left padding), and so does the marker.
    expect(html).toMatch(/<path d="M2\.0,[\d.]+L/);
    expect(html).toContain('<circle cx="2"');
    expect(label(html)).toContain(`already above the ${c(1_000_000)} FI number`);
  });

  test('no FI number (no spending): the line alone, no FI line, label or marker', () => {
    const html = draw(props({ fiNumber: null, fiAge: null }));
    expect(html).not.toContain('stroke-dasharray');
    expect(markers(html)).toBe(0);
    expect(ages(html)).toEqual(['40', 'stop 65']);
    expect(label(html)).toBe(`Invested assets grow from ${c(250_000)} at 40, and are about ${c(projectBalance(250_000, 30_000, 0.05, 25))} at 65, growing a steady 5% a year after inflation.`);
  });

  test('a path that stops before the stop age: the line ends there, the stop age still marked, and the summary says where', () => {
    const points = steady(100_000, -10_000, 40, 54);
    const html = draw(props({ points, stopAge: 55, fiAge: null }));
    expect(ages(html)).toEqual(['FI number', '40', 'stop 55']);
    expect(label(html)).toContain('and the projection stops at 54, before 55');
  });

  test('with a plan’s items, it says so beside the steady growth', () => {
    const html = draw(props({ withEvents: true }));
    expect(label(html)).toContain('growing a steady 5% a year after inflation with this plan’s items.');
    expect(html).toContain('At a steady 5% a year after inflation, with this plan’s items.');
  });

  test('the FI number’s name over its line when there is no room under it above the axis (review of 8b)', () => {
    const y = (html: string) => Number(/y="([\d.]+)" text-anchor="end">FI number</.exec(html)![1]);
    const base = (html: string) => Number(/<line x1="2" x2="318" y1="([\d.]+)"/.exec(html)![1]);
    // Low on a long path's scale, and already there with far more.
    for (const p of [props({ points: steady(250_000, 30_000, 40, 95), stopAge: 95 }), props({ points: steady(8_000_000, 30_000, 40, 60), stopAge: 60, fiAge: 40 })]) {
      const html = draw(p);
      expect(y(html)).toBeLessThan(base(html));
    }
    // With room, under it, where the line has crossed it.
    const html = draw(props());
    const dashed = Number(/y1="([\d.]+)" y2="[\d.]+" stroke="var\(--text-3\)" stroke-width="1" stroke-dasharray/.exec(html)![1]);
    expect(y(html)).toBeGreaterThan(dashed);
  });

  test('a line that rises over the FI number and falls back is never said to stay under it', () => {
    const html = draw(props({ points: [{ age: 40, balance: 900_000 }, { age: 41, balance: 1_100_000 }, { age: 42, balance: 800_000 }], stopAge: 42, fiAge: null }));
    expect(label(html)).not.toContain('stay under');
  });

  test('a windfall that reaches the FI number the day it comes: the line steps up at that age, and the marker is on the step (8d)', () => {
    // FI number $1,000,000; $653,750 at 42, and $400,000 in then.
    const gift: LifeEvent = { id: 'w', kind: 'windfall', label: 'Gift', atAge: 42, amount: 400_000 };
    const f = figuresOf({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, assets: 500_000, savings: 50_000 }, { spending: null, savings: null, assets: null }, [gift]) as PlanFigures;
    expect(f.view.fiAge).toBe(42);
    const p = planPath(f)!;
    const html = draw(props({ points: p.points, stopAge: 55, fiNumber: f.view.fiNumber, fiAge: f.view.fiAge, withEvents: true }));
    const [cx, cy] = /<circle cx="([\d.]+)" cy="([\d.]+)"/.exec(html)!.slice(1).map(Number);
    const fiY = Number(/<line [^>]*y1="([\d.]+)"[^>]*stroke-dasharray="4 4"/.exec(html)![1]);
    // On the FI number's line.
    expect(cy).toBeCloseTo(fiY, 6);
    // The line's points at that age: one at the balance before the windfall,
    // straight up to what is in hand, past the FI number (y grows down).
    const d = /<path d="(M[^"]+)" fill="none"/.exec(html)![1];
    const at = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]).filter(([x]) => Math.abs(x - cx) < 0.06);
    expect(at).toHaveLength(2);
    expect(at[0][1]).toBeGreaterThan(fiY);
    expect(at[1][1]).toBeLessThan(fiY);
    // The table says both.
    expect(html).toContain(`${wholeMoney(653_750, 'USD')}, then ${wholeMoney(1_053_750, 'USD')} once that year’s windfall is in and its costs are paid`);
  });

  test('every year in the table, the stop age marked', () => {
    const html = draw(props());
    const rows = [...html.matchAll(/<tr><td>([^<]*)<\/td>/g)].map((m) => m[1]);
    expect(rows).toHaveLength(26);
    expect(rows[0]).toBe('40');
    expect(rows[25]).toBe('65 (stop)');
    expect(html).toContain('<summary>Show as a table</summary>');
  });

  test('its shape is its width’s, so its text is 12px on a phone and on a wide card', () => {
    expect(draw(props(), 600)).toContain('viewBox="0 0 600 229"');
  });
});

// D9: a plan that answers with the earliest stop that lasts. The fixture's
// line reaches the FI number at 52.9; the stop found is a whole age, after
// that (as in 95% of starts), before it (80%), today, or past the line.
describe('the earliest stop that lasts', () => {
  const at = (fiAge: number, over: Partial<PathChartProps> = {}) => draw(props({ fiAge, lasting: true, ...over }));
  /** The line's point at an age (a year a point from 40, no windfall). */
  const onLine = (html: string, age: number) => {
    const d = /<path d="([^"]*)" fill="none" stroke="var\(--data\)"/.exec(html)![1];
    const m = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)][age - 40];
    return { x: +m[1], y: +m[2] };
  };
  const dot = (html: string) => {
    const m = /<circle cx="([\d.]+)" cy="([\d.]+)"/.exec(html)!;
    return { x: +m[1], y: +m[2] };
  };
  const fiY = (html: string) => +/y1="([\d.]+)" y2="[\d.]+" stroke="var\(--text-3\)" stroke-width="1" stroke-dasharray="4 4"/.exec(html)![1];
  const nameY = (html: string) => +/<text class="chart-xlabel" x="[\d.]+" y="([\d.]+)" text-anchor="end">FI number<\/text>/.exec(html)![1];
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.1);
    expect(Math.abs(a.y - b.y)).toBeLessThan(0.1);
  };

  test('after the line reaches the FI number: the marker on the line at that age, over the number, and both ages said', () => {
    const html = at(54);
    expect(markers(html)).toBe(1);
    near(dot(html), onLine(html, 54));
    expect(dot(html).y).toBeLessThan(fiY(html));
    expect(ages(html)).toEqual(['FI number', '40', '54', 'stop 65']);
    // The path is over the number by then: its name under its line.
    expect(nameY(html)).toBe(fiY(html) + 14);
    expect(label(html)).toContain(`reach the ${c(1_000_000)} FI number around 53, and are about`);
    expect(label(html)).toEndWith('a year after inflation. The earliest stop that lasts is around 54.');
  });

  test('before the line reaches it: on the line, under the number, never on it', () => {
    const html = at(51);
    near(dot(html), onLine(html, 51));
    expect(dot(html).y).toBeGreaterThan(fiY(html));
    expect(ages(html)).toEqual(['FI number', '40', '51', 'stop 65']);
    expect(nameY(html)).toBe(fiY(html) + 14);
    expect(label(html)).toContain(`reach the ${c(1_000_000)} FI number around 53`);
    expect(label(html)).toEndWith(' The earliest stop that lasts is around 51.');
  });

  test('a line that never reaches the number: the name over its line, clear of the path', () => {
    const html = at(48, { points: steady(250_000, 30_000, 40, 50), stopAge: 50 });
    near(dot(html), onLine(html, 48));
    expect(nameY(html)).toBe(fiY(html) - 5);
    expect(label(html)).toContain(`stay under the ${c(1_000_000)} FI number`);
    expect(label(html)).toEndWith(' The earliest stop that lasts is around 48.');
  });

  test('today: the marker where the line starts, and a stop now lasts', () => {
    const html = at(40);
    near(dot(html), onLine(html, 40));
    expect(ages(html)).toEqual(['FI number', '40', 'stop 65']);
    expect(label(html)).toContain(`reach the ${c(1_000_000)} FI number around 53`);
    expect(label(html)).toEndWith(' A stop now lasts.');
  });

  test('a stop the year money comes in: the marker at the end of its step, what that stop draws from', () => {
    const gift: LifeEvent = { id: 'w', kind: 'windfall', label: 'Gift', atAge: 42, amount: 400_000 };
    const f = figuresOf({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, assets: 500_000, savings: 50_000 }, { spending: null, savings: null, assets: null }, [gift]) as PlanFigures;
    const p = planPath(f)!;
    const html = draw(props({ points: p.points, stopAge: 55, fiNumber: f.view.fiNumber, fiAge: 42, lasting: true, withEvents: true }));
    const d = /<path d="(M[^"]+)" fill="none"/.exec(html)![1];
    const step = [...d.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2] })).filter((q) => Math.abs(q.x - dot(html).x) < 0.06);
    expect(step).toHaveLength(2);
    near(dot(html), step[1]);
  });

  // A cost that takes the line back under the number: it reaches it where it
  // stays over it, as the walk's FI date does, or not at all.
  const dips = (balances: number[]) => balances.map((balance, i) => ({ age: 40 + i, balance }));
  test('a line that goes over the number and back under: the name over its line, and no reaching said', () => {
    const points = dips([900_000, 995_000, 1_090_000, 1_200_000, 784_000, 874_000]);
    for (const fiAge of [45, 44]) {
      const html = at(fiAge, { points, stopAge: 45 });
      near(dot(html), onLine(html, fiAge));
      expect(nameY(html)).toBe(fiY(html) - 5);
      expect(label(html)).not.toContain('reach the');
      expect(label(html)).toEndWith(` The earliest stop that lasts is around ${fiAge}.`);
    }
  });

  test('over, back under, then over for good: it reaches the number where it stays', () => {
    const html = at(42, { points: dips([900_000, 1_050_000, 800_000, 950_000, 1_100_000, 1_200_000]), stopAge: 45 });
    expect(label(html)).toContain(`reach the ${c(1_000_000)} FI number around 43,`);
    expect(nameY(html)).toBe(fiY(html) + 14);
  });

  test('a windfall that takes the line over the number: reached on its step', () => {
    const gift: LifeEvent = { id: 'w', kind: 'windfall', label: 'Gift', atAge: 42, amount: 400_000 };
    const f = figuresOf({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, assets: 500_000, savings: 50_000 }, { spending: null, savings: null, assets: null }, [gift]) as PlanFigures;
    const html = draw(props({ points: planPath(f)!.points, stopAge: 55, fiNumber: f.view.fiNumber, fiAge: 44, lasting: true, withEvents: true }));
    expect(label(html)).toContain(`reach the ${wholeMoney(f.view.fiNumber!, 'USD')} FI number around 42,`);
  });

  test('the stop found is the stop typed: nothing said of after it', () => {
    expect(label(at(65))).toEndWith(' The earliest stop that lasts is around 65.');
  });

  test('past the stop the chart ends at: no marker, and the summary says where it is', () => {
    const html = at(70);
    expect(markers(html)).toBe(0);
    expect(label(html)).toEndWith(' The earliest stop that lasts is around 70, after your stop at 65.');
  });
});

describe('the answer over the chart', () => {
  const card = (f: PlanFigures) =>
    renderToStaticMarkup(
      <FiCard
        plan={f.plan}
        view={f.view}
        unread={[]}
        assets={{ total: 0, accounts: [], unknown: 0, caveats: [], currency: 'USD', leftOut: [] } as never}
        currencyNote={null}
        money={(n) => wholeMoney(n, 'USD')}
        path={planPath(f)}
        currency="USD"
      />
    )
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');

  test('a plan that reaches FI and then runs out before the stop age says both (review of 8b)', () => {
    // A $250,000 one-year drop in spending at 41 lifts it to FI around 42;
    // then $50,000 a year out runs it down before 80.
    const drop: LifeEvent = { id: 'd', kind: 'spending', label: 'Drop', fromAge: 41, yearly: -250_000, years: 1 };
    const f = figuresOf({ ...DEFAULT_PLAN, age: 40, targetAge: 80, spending: 30_000, assets: 600_000, savings: -50_000 }, { spending: null, savings: null, assets: null }, [drop]) as PlanFigures;
    const p = planPath(f)!;
    expect(f.short).toBeNull();
    expect(p.short).not.toBeNull();
    const text = card(f);
    expect(text).toContain(`Financial independence Around age ${Math.round(f.view.fiAge!)}`);
    expect(text).toContain(`At these savings it runs out at ${40 + p.short!.year} (below).`);
  });

  test('a windfall that takes it to FI, then savings below zero that run it out, says both (8d)', () => {
    // FI number $750,000; $207,750 at 42, $600,000 in then, $60,000 a year out.
    const gift: LifeEvent = { id: 'w', kind: 'windfall', label: 'Gift', atAge: 42, amount: 600_000 };
    const f = figuresOf({ ...DEFAULT_PLAN, age: 40, targetAge: 80, spending: 30_000, assets: 300_000, savings: -60_000 }, { spending: null, savings: null, assets: null }, [gift]) as PlanFigures;
    const p = planPath(f)!;
    expect([f.short, f.view.yearsToFi]).toEqual([null, 2]);
    expect(p.short?.kind).toBe('savings');
    const text = card(f);
    expect(text).toContain('Financial independence Around age 42');
    expect(text).toContain(`At these savings it runs out at ${40 + p.short!.year} (below).`);
  });

  test('one that never runs out says nothing of it', () => {
    const f = figuresOf({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, assets: 250_000, savings: 30_000 }, { spending: null, savings: null, assets: null }, []) as PlanFigures;
    expect(card(f)).not.toContain('runs out');
  });
});

// Whole path (the tax plan's P, D13): the same line on past the stop to the
// plan's end, with a switch under the plot between the two ranges. The ages
// are the plan's own: the switch names its stop age, whatever it is.
describe('Whole path', () => {
  const none = { spending: null, savings: null, assets: null };
  const base = { ...DEFAULT_PLAN, age: 41, targetAge: 50, spending: 60_000, savings: 50_000, assets: 595_000 };
  const chartOf = (p: typeof base, over: Partial<PathChartProps> = {}) => {
    const f = figuresOf(p, none) as PlanFigures;
    const path = planPath(f)!;
    const chart: PathChartProps = {
      points: path.points,
      today: p.age,
      stopAge: p.targetAge,
      fiNumber: f.view.fiNumber,
      fiAge: f.view.fiAge,
      realReturn: p.realReturn,
      currency: 'USD',
      after: path.after,
      range: 'whole',
      onRange: () => {},
      ...over,
    };
    return { f, path, chart };
  };
  const whole = (p: typeof base, over: Partial<PathChartProps> = {}, width = 320) => {
    const made = chartOf(p, over);
    return { ...made, html: draw(made.chart, width) };
  };
  // Where an age is across the plot at 320px, from the first age to the last.
  const xAt = (age: number, first: number, last: number) => 2 + ((age - first) / (last - first)) * 316;
  const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.06);
  const dashed = (html: string) => /<line x1="2" x2="([\d.]+)" y1="([\d.]+)" y2="[\d.]+" stroke="var\(--text-3\)" stroke-width="1" stroke-dasharray="4 4"/.exec(html)!.slice(1).map(Number);
  const svg = (html: string) => html.slice(html.indexOf('<svg'), html.indexOf('</svg>') + 6);
  const ruleName = (html: string) => /<text class="chart-rule-label" x="([\d.]+)" y="([\d.]+)">FI number<\/text>/.exec(html);

  test('marks with no room for their ages are all named under the chart; with room, none are', () => {
    const { chart } = whole(base);
    const marks = [
      { age: 59.5, label: '59½', short: '59½' },
      { age: 65, label: '65', short: '65' },
      { age: 67, label: 'Social Security 67', short: '67' },
      { age: 75, label: 'RMD age 75', short: '75' },
    ];
    const narrow = draw({ ...chart, ticks: marks }, 320);
    expect(narrow).toContain('Marked: 59½, 65, Social Security 67, RMD age 75.');
    // No marks, or one with room: nothing to name.
    expect(draw({ ...chart, ticks: null }, 320)).not.toContain('Marked:');
    expect(draw({ ...chart, ticks: [{ age: 75, label: 'RMD age 75', short: '75' }] }, 320)).not.toContain('Marked:');
  });

  test('to the plan’s end: the wash and the FI number’s line over the saving years only, the stop’s rule, and its ages', () => {
    const { html, path } = whole(base);
    expect(path.after!.endAge).toBe(95);
    const stopX = xAt(50, 41, 95);
    const [x2] = dashed(html);
    near(x2, stopX);
    // The wash ends at the stop.
    const area = /<path d="M[^"]+L([\d.]+),\d+L2\.0,\d+Z" fill="var\(--data-tint\)"/.exec(html)!;
    near(Number(area[1]), stopX);
    // The stop's rule, and no marker: FI comes after the stop.
    expect(html).toContain(`<line x1="${stopX}" x2="${stopX}" y1="16" y2="98" stroke="var(--text-3)"`);
    expect(markers(html)).toBe(0);
    expect(ages(html)).toEqual(['41', 'stop 50', '95']);
    // The stop after its rule.
    expect(html).toContain(`x="${stopX + 4}" y="116" text-anchor="start">stop 50</text>`);
    // The line runs on to the end.
    const line = /<path d="(M[^"]+)" fill="none" stroke="var\(--data\)"/.exec(html)![1];
    near(Number(/L([\d.]+),[\d.]+$/.exec(line)![1]), 318);
  });

  // At 320px a stop nine years out leaves the dashed line about 53px, under
  // the name's 55: the name goes at its left end, over the lines, haloed.
  test('a dashed line shorter than its name: the name at its left end over the lines, for a path below it, above it, or crossing it by the stop', () => {
    const below = whole(base).html;
    const above = whole({ ...base, assets: 2_000_000 }).html;
    const crossing = whole({ ...base, assets: 1_250_000, savings: 100_000, targetAge: 49 });
    expect(crossing.f.view.fiAge!).toBeLessThan(49);
    expect(markers(crossing.html)).toBe(1);
    // Over the line at its left end, moved off the marker where it would sit
    // on it: past today's dot just over the line, or up off the dot where the
    // path reaches the number under the name, still by its line.
    const cases = [
      { html: below, x: 2, lift: 4 },
      { html: above, x: 2 + 7, lift: 4 },
      { html: crossing.html, x: 2, lift: 7 },
    ];
    for (const { html, x: nameX, lift } of cases) {
      const [x2, fiY] = dashed(html);
      expect(x2 - 2).toBeLessThan(55);
      const name = ruleName(html)!;
      expect(Number(name[1])).toBe(nameX);
      // Over the line, inside the plot.
      expect(Number(name[2])).toBe(fiY - lift);
      expect(Number(name[2]) - 12).toBeGreaterThanOrEqual(0);
      expect(offTheDot(html)).toBeGreaterThanOrEqual(7);
      // Never the axis label's way of naming it.
      expect(ages(html)).not.toContain('FI number');
      // Drawn after the line, the rules and the marker.
      const at = html.indexOf('class="chart-rule-label"');
      expect(at).toBeGreaterThan(html.indexOf('stroke="var(--data)"'));
      if (html.includes('<circle')) expect(at).toBeGreaterThan(html.indexOf('<circle'));
    }
    // With room, and the path still under the line at the stop, at the
    // line's end as To 50 has it.
    const short = whole({ ...base, savings: 0, assets: 300_000, targetAge: 65 });
    expect(short.path.points.at(-1)!.balance).toBeLessThan(short.f.view.fiNumber!);
    expect(ruleName(short.html)).toBeNull();
    expect(short.html).toMatch(new RegExp(`<text class="chart-xlabel" x="${xAt(65, 41, 95)}" y="[\\d.]+" text-anchor="end">FI number</text>`));
  });

  // The scale runs to the plan's end, so the line often sits too low for the
  // name under it, and above it by the stop the path that crossed it would
  // run through the name (the layout check at 320px): at the left end too.
  test('a long dashed line the path has crossed, with no room under it: the name at its left end, clear of the path', () => {
    const { html, chart } = whole({ ...base, targetAge: 65 });
    expect(markers(html)).toBe(1);
    const [x2, fiY] = dashed(html);
    expect(x2 - 2).toBeGreaterThanOrEqual(55);
    expect(fiY + 14).toBeGreaterThan(98 - 4);
    const name = ruleName(html)!;
    // The path reaches the number at 50.2, on the line under the name's end:
    // the name moves up off the dot, 7 over its line.
    const [dotX, dotY] = dotOf(html);
    expect(dotX).toBeLessThan(2 + 55);
    expect(dotY).toBe(fiY);
    expect([name[1], Number(name[2])]).toEqual(['2', fiY - 7]);
    expect(offTheDot(html)).toBeGreaterThanOrEqual(7);
    expect(ages(html)).not.toContain('FI number');
    // Under the name, the path is on the line or below it.
    const line = /<path d="(M[^"]+)" fill="none" stroke="var\(--data\)"/.exec(html)![1];
    const under = [...line.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]).filter(([px]) => px <= 2 + 55);
    expect(under.length).toBeGreaterThan(5);
    for (const [, py] of under) expect(py).toBeGreaterThanOrEqual(fiY - 1);
    // To 65 keeps it at the line's end, as today.
    expect(ruleName(draw({ ...chart, range: 'stop' }))).toBeNull();
  });

  // The design review's Plan board (Nov 15, High 5): at 60, a stop now that
  // lasts puts the marker at today's balance, at the line's left end, where
  // the name went too, haloed over the dot.
  test('the name keeps off the marker: today’s dot at the left end, a reach by the stop, and a line’s end with no room', () => {
    // A stop now that lasts: up off today's dot, still by its line.
    const now = whole({ ...base, age: 60, targetAge: 65, spending: 40_000, savings: 30_000, assets: 900_000 }, { lasting: true, fiAge: 60 }).html;
    const [nowX, nowY] = dotOf(now);
    expect(nowX).toBe(2);
    const nowName = ruleName(now)!;
    expect([Number(nowName[1]), Number(nowName[2])]).toEqual([2, nowY - 7]);
    expect(nowY - 7).toBeLessThanOrEqual(dashed(now)[1]);
    // To 63, reached at 62.6, on the line just short of its end, where the
    // name goes under the line once the path is over it: over the line,
    // short of the dot, where the path is still under it.
    const stop = whole({ ...base, age: 60, targetAge: 63, assets: 1_250_000, savings: 30_000 }, { range: 'stop' });
    expect(stop.f.view.fiAge!).toBeGreaterThan(62.5);
    const [stopDotX, stopDotY] = dotOf(stop.html);
    const end = /<text class="chart-xlabel" x="([\d.]+)" y="([\d.]+)" text-anchor="end">FI number</.exec(stop.html)!;
    expect(Number(end[1])).toBe(stopDotX - 7);
    expect(Number(end[2])).toBe(stopDotY - 5);
    // Whole path from 55 to 67, reached at 59.9 on the line under where the
    // name would end it, with no room under the line to move it and the path
    // over it on the other side: at the left end instead, as a short line has
    // it, up off the dot.
    const blocked = whole({ ...base, age: 55, targetAge: 67, assets: 1_050_000, savings: 30_000 }).html;
    const [x2, fiY] = dashed(blocked);
    expect(x2 - 2).toBeGreaterThanOrEqual(55);
    expect(ages(blocked)).not.toContain('FI number');
    const left = ruleName(blocked)!;
    expect([Number(left[1]), Number(left[2])]).toEqual([2, fiY - 7]);
    for (const html of [now, stop.html, blocked]) expect(offTheDot(html)).toBeGreaterThanOrEqual(7);
  });

  test('the name never sits on the marker, across plans, widths and both ranges', () => {
    let drawn = 0;
    // Each plan worked out once, then drawn each way.
    for (const age of [41, 60])
      for (const gap of [1, 3, 5, 8, 12])
        for (const assets of [300_000, 900_000, 1_050_000, 1_600_000, 2_000_000])
          for (const savings of [0, 50_000]) {
            const { chart } = chartOf({ ...base, age, targetAge: age + gap, assets, savings });
            for (const width of [320, 600])
              // D9's answer, in whole years from today, as its search gives
              // them (now, a year on, at the stop); null for a plan without it.
              for (const years of [null, 0, 1, gap])
                for (const range of ['whole', 'stop'] as const) {
                  const lasting = years !== null;
                  const html = draw({ ...chart, range, lasting, fiAge: lasting ? age + years : chart.fiAge }, width);
                  if (!html.includes('<circle')) continue;
                  drawn++;
                  expect(offTheDot(html)).toBeGreaterThanOrEqual(7);
                }
          }
    expect(drawn).toBeGreaterThan(500);
  }, 30_000);

  test('with Progress’s lines before today, they stay, and today joins the ages', () => {
    const recorded = {
      from: '2026-01-02',
      savedDay: '2026-01-02',
      recorded: [
        { age: 39, balance: 450_000 },
        { age: 41, balance: 595_000 },
      ],
      planned: [
        { age: 39, balance: 450_000 },
        { age: 41, balance: 570_000 },
      ],
      days: ['2024-11-01', '2026-11-01'],
    };
    const { html } = whole({ ...base, targetAge: 65 }, { recorded });
    expect(html).toContain('stroke="var(--text-1)"');
    expect(html).toContain('stroke-dasharray="2 4"');
    // The start's age stays, as To 50's does; today is too close to it.
    expect(ages(html)).toEqual(['39', '50', 'stop 65', '95']);
    expect(ruleName(html)).not.toBeNull();
    const longer = { ...recorded, recorded: [{ age: 30, balance: 100_000 }, recorded.recorded[1]], planned: [{ age: 30, balance: 100_000 }, recorded.planned[1]] };
    expect(ages(whole({ ...base, targetAge: 65 }, { recorded: longer }).html)).toEqual(['30', 'today 41', '50', 'stop 65', '95']);
  });

  test('a stop near the plan’s end: “stop 80” before its rule, clear of the end', () => {
    const { html } = whole({ ...base, targetAge: 80, horizon: 5 });
    const stopX = xAt(80, 41, 85);
    expect(html).toContain(`x="${stopX - 4}" y="116" text-anchor="end">stop 80</text>`);
    expect(ages(html)).toEqual(['41', '50', 'stop 80', '85']);
    expect(ruleName(html)).not.toBeNull();
  });

  test('the switch names the plan’s own stop age; To 50 and no range are today’s chart', () => {
    for (const stop of [50, 62]) {
      const { html, chart } = whole({ ...base, targetAge: stop });
      expect(html).toContain('<div class="segmented compact chart-range-switch" role="radiogroup" aria-label="Range">');
      expect(html).toContain(`aria-checked="false" tabindex="-1">To ${stop}</button>`);
      expect(html).toContain('aria-checked="true" tabindex="0">Whole path</button>');
      const to = draw({ ...chart, range: 'stop' });
      expect(to).toContain(`aria-checked="true" tabindex="0">To ${stop}</button>`);
      const today = draw({ ...chart, after: undefined, range: undefined, onRange: undefined });
      expect(svg(to)).toBe(svg(today));
      expect(today).not.toContain('radiogroup');
    }
    // Nothing to switch to without the years after the stop.
    const { chart } = whole(base);
    expect(draw({ ...chart, after: null })).not.toContain('radiogroup');
  });

  test('its summary says the saving years, then the years after; its table every year to the end', () => {
    const { html, path } = whole(base);
    const end = path.after!.points.at(-1)!.balance;
    expect(label(html)).toBe(
      `Invested assets grow from ${c(595_000)} at 41, stay under the ${c(1_500_000)} FI number, and are about ${c(path.points.at(-1)!.balance)} at 50, then, drawing your spending, about ${c(end)} at 95, at a steady 5% a year after inflation.`
    );
    expect(label(html)).not.toContain('reach the');
    const rows = [...html.matchAll(/<tr><td>([^<]*)<\/td>/g)].map((m) => m[1]);
    expect(rows).toHaveLength(55);
    expect(rows[9]).toBe('50 (stop)');
    expect(rows[54]).toBe('95');
  });

  test('the line under the chart: what the FI number leaves out, on Whole path only', () => {
    const ss = { id: 's', label: 'Social Security', amount: 24_000, fromAge: 67, inflationAdjusted: true };
    const { html, chart } = whole({ ...base, income: [ss] });
    expect(html).toContain('<div class="as-of">Your FI number leaves out Social Security from 67; this path counts it.</div>');
    expect(draw({ ...chart, range: 'stop' })).not.toContain('leaves out');
  });

  // The review of P: a name at the line's end only where the walk keeps to
  // its other side across the name's width, which on Whole path is a few
  // years.
  test('the name under the line at its end where the walk is above it all along the name; at the left end where the walk crosses under it', () => {
    const clear = whole({ ...base, horizon: 10, targetAge: 55, assets: 1_200_000, savings: 50_000 });
    const [x2, fiY] = dashed(clear.html);
    const name = new RegExp(`<text class="chart-xlabel" x="${x2}" y="([\\d.]+)" text-anchor="end">FI number</text>`).exec(clear.html)!;
    expect(Number(name[1])).toBe(fiY + 14);
    const line = /<path d="(M[^"]+)" fill="none" stroke="var\(--data\)"/.exec(clear.html)![1];
    const under = [...line.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]).filter(([px]) => px >= x2 - 55 && px <= x2);
    expect(under.length).toBeGreaterThan(0);
    for (const [, py] of under) expect(py).toBeLessThanOrEqual(fiY);
    // The review's case: at 340px the walk passes under the line, then
    // through the name's place, as it crosses by the stop.
    const crossing = whole({ ...base, targetAge: 60, assets: 400_000, savings: 20_000 }, {}, 340);
    expect(markers(crossing.html)).toBe(1);
    expect(dashed(crossing.html)[0] - 2).toBeGreaterThanOrEqual(55);
    expect(ruleName(crossing.html)).not.toBeNull();
    expect(ages(crossing.html)).not.toContain('FI number');
  });

  // The review of P: one that can't pay its first year after the stop.
  test('one that runs out the year it stops: Whole path still drawn, to the end, with the switch and the age', () => {
    const { html, path, chart } = whole({ ...base, savings: 0, assets: 30_000 });
    expect(path.after!.points).toHaveLength(1);
    expect(path.after!.runsOutAt).toBe(50);
    expect(html).toContain('role="radiogroup"');
    expect(ages(html).at(-1)).toBe('95');
    expect(html).toContain('<div class="as-of">On this steady path your invested assets run out at 50.</div>');
    expect(label(html)).toContain('then, drawing your spending, run out at 50,');
    // To 50 is today's chart.
    expect(draw({ ...chart, range: 'stop' })).not.toContain('run out at');
    // Once the stop has come, one point is nothing to draw, as before.
    const past = whole({ ...base, age: 60, assets: 30_000 });
    expect(past.path.points).toHaveLength(1);
    expect(past.path.after!.points).toHaveLength(1);
    expect(wholeShown(past.path.points, past.path.after, 'whole')).toBe(false);
  });

  test('one that runs out says the age, neutrally, and its summary ends there', () => {
    const { html, path } = whole({ ...base, spending: 150_000 });
    const at = path.after!.runsOutAt!;
    expect(html).toContain(`<div class="as-of">On this steady path your invested assets run out at ${at}.</div>`);
    expect(html).not.toContain('warn');
    expect(label(html)).toContain(`then, drawing your spending, run out at ${at}, at a steady 5% a year after inflation.`);
  });

  test('once the stop has come: the drawdown from today, with no switch and no FI number', () => {
    const { html, path } = whole({ ...base, age: 60, assets: 2_000_000 });
    expect(path.points).toHaveLength(1);
    expect(html).not.toContain('radiogroup');
    expect(html).not.toContain('stroke-dasharray');
    expect(html).not.toContain('var(--data-tint)');
    expect(ages(html)).toEqual(['60', '95']);
    expect(label(html)).toBe(`Invested assets go from ${c(2_000_000)} at 60, drawing your spending, to about ${c(path.after!.points.at(-1)!.balance)} at 95, at a steady 5% a year after inflation.`);
    // Asked for the stop's range, there is none to show: still the drawdown.
    expect(svg(draw({ ...whole({ ...base, age: 60, assets: 2_000_000 }).chart, range: 'stop' }))).toBe(svg(html));
    // One that runs out says so in its summary.
    const short = whole({ ...base, age: 60 });
    expect(label(short.html)).toBe(`Invested assets go from ${c(595_000)} at 60, drawing your spending, and run out at ${short.path.after!.runsOutAt}, at a steady 5% a year after inflation.`);
  });
});

describe('what Whole path counts that the FI number leaves out', () => {
  const item = (label: string, age: number, kind: 'income' | 'expense' = 'income') => ({ label, age, kind });
  test('up to three by name, then how many more; a plan’s items', () => {
    expect(leftOutText({ items: [], events: false })).toBeNull();
    expect(leftOutText({ items: [item('Social Security', 67)], events: false })).toBe('Your FI number leaves out Social Security from 67; this path counts it.');
    expect(leftOutText({ items: [item('Pension', 50), item('Roof', 60, 'expense'), item('Social Security', 67)], events: false })).toBe(
      'Your FI number leaves out Pension from 50, Roof at 60 and Social Security from 67; this path counts them.'
    );
    expect(leftOutText({ items: [item('A', 50), item('B', 51), item('C', 52), item('D', 53)], events: true })).toBe('Your FI number leaves out A from 50, B from 51, C from 52 and 2 more; this path counts them.');
    expect(leftOutText({ items: [], events: true })).toBe('Your FI number leaves out this plan’s items after you stop; this path counts them.');
  });
});
