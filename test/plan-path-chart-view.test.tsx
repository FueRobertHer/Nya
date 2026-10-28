import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PlanPathChart, { type PathChartProps } from '@/components/PlanPathChart';
import { DrawnWidth } from '@/components/drawn-width';
import { projectBalance } from '@/lib/fire/fi';
import { compactMoney } from '@/lib/format';
import { FiCard } from '@/components/PlanTab';
import { wholeMoney } from '@/components/plan-text';
import { DEFAULT_PLAN } from '@/lib/fire/plan';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import { planPath } from '@/lib/fire/path';
import type { LifeEvent } from '@/lib/fire/events';

const c = (n: number) => compactMoney(n, 'USD');

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
    expect(html).toContain('At a steady 5% a year after inflation. Real markets don’t move steadily; Stress test shows how much that matters.');
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

  test('with a scenario’s life events, it says so beside the steady growth', () => {
    const html = draw(props({ withEvents: true }));
    expect(label(html)).toContain('growing a steady 5% a year after inflation with this scenario’s life events.');
    expect(html).toContain('At a steady 5% a year after inflation, with this scenario’s life events.');
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
    const f = planFigures({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, assets: 500_000, savings: 50_000 }, { spending: null, savings: null, assets: null }, [gift]) as PlanFigures;
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

  test('a scenario that reaches FI and then runs out before the stop age says both (review of 8b)', () => {
    // A $250,000 one-year drop in spending at 41 lifts it to FI around 42;
    // then $50,000 a year out runs it down before 80.
    const drop: LifeEvent = { id: 'd', kind: 'spending', label: 'Drop', fromAge: 41, yearly: -250_000, years: 1 };
    const f = planFigures({ ...DEFAULT_PLAN, age: 40, targetAge: 80, spending: 30_000, assets: 600_000, savings: -50_000 }, { spending: null, savings: null, assets: null }, [drop]) as PlanFigures;
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
    const f = planFigures({ ...DEFAULT_PLAN, age: 40, targetAge: 80, spending: 30_000, assets: 300_000, savings: -60_000 }, { spending: null, savings: null, assets: null }, [gift]) as PlanFigures;
    const p = planPath(f)!;
    expect([f.short, f.view.yearsToFi]).toEqual([null, 2]);
    expect(p.short?.kind).toBe('savings');
    const text = card(f);
    expect(text).toContain('Financial independence Around age 42');
    expect(text).toContain(`At these savings it runs out at ${40 + p.short!.year} (below).`);
  });

  test('one that never runs out says nothing of it', () => {
    const f = planFigures({ ...DEFAULT_PLAN, age: 40, targetAge: 55, spending: 40_000, assets: 250_000, savings: 30_000 }, { spending: null, savings: null, assets: null }, []) as PlanFigures;
    expect(card(f)).not.toContain('runs out');
  });
});
