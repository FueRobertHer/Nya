import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PlanPathChart, { type PathChartProps } from '@/components/PlanPathChart';
import { DrawnWidth } from '@/components/drawn-width';
import { projectBalance } from '@/lib/fire/fi';
import { compactMoney } from '@/lib/format';

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
