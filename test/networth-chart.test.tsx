import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import NetWorthChart from '@/components/NetWorthChart';

type P = { date: string; value: number; estimated?: boolean };

/** Each drawn line segment run as dashed or solid, in order. */
function runs(points: P[]): ('dashed' | 'solid')[] {
  const html = renderToStaticMarkup(<NetWorthChart points={points} />);
  return [...html.matchAll(/<path [^>]*stroke-width="2"[^>]*>/g)].map((m) =>
    m[0].includes('stroke-dasharray') ? 'dashed' : 'solid'
  );
}

describe('NetWorthChart segment styles', () => {
  test('consecutive real days draw solid, with no caption', () => {
    const points = [
      { date: '2026-09-01', value: 1 },
      { date: '2026-09-02', value: 2 },
    ];
    expect(runs(points)).toEqual(['solid']);
    expect(renderToStaticMarkup(<NetWorthChart points={points} />)).not.toContain('chart-note');
  });

  test('a segment touching an estimated point draws dashed', () => {
    expect(
      runs([
        { date: '2026-09-01', value: 1 },
        { date: '2026-09-02', value: 2, estimated: true },
        { date: '2026-09-03', value: 3 },
        { date: '2026-09-04', value: 4 },
      ])
    ).toEqual(['dashed', 'solid']);
  });

  // Nothing was measured on the days it spans, even though both ends are real.
  test('a segment that skips days draws dashed, and gets the caption', () => {
    const points = [
      { date: '2026-08-30', value: 1 },
      { date: '2026-08-31', value: 2 },
      { date: '2026-09-24', value: 3 },
    ];
    expect(runs(points)).toEqual(['solid', 'dashed']);
    expect(renderToStaticMarkup(<NetWorthChart points={points} />)).toContain('chart-note');
  });
});

describe('NetWorthChart money added vs growth', () => {
  const points = [
    { date: '2026-09-01', value: 1000 },
    { date: '2026-09-02', value: 1600 },
    { date: '2026-09-03', value: 1650 },
  ];
  const baseline = [
    { date: '2026-09-01', value: 1000 },
    { date: '2026-09-02', value: 1500 },
    { date: '2026-09-03', value: 1500 },
  ];

  test('draws the baseline and says how the change splits', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={points} baseline={baseline} />);
    expect(html).toContain('class="chart-baseline"');
    expect(html).toContain('+$500.00 added · +$150.00 growth');
  });

  test('draws nothing extra without a baseline', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={points} />);
    expect(html).not.toContain('chart-baseline');
    expect(html).not.toContain('growth');
  });
});

describe('NetWorthChart split on estimated points', () => {
  // An estimated value has no market movement in it, so no growth figure;
  // the summary falls back to the last real point.
  test('summarises to the last real point, not a trailing estimate', () => {
    const html = renderToStaticMarkup(
      <NetWorthChart
        points={[
          { date: '2026-09-01', value: 1000 },
          { date: '2026-09-02', value: 1100 },
          { date: '2026-09-03', value: 5000, estimated: true },
        ]}
        baseline={[
          { date: '2026-09-01', value: 1000 },
          { date: '2026-09-02', value: 1000 },
          { date: '2026-09-03', value: 1000 },
        ]}
      />
    );
    expect(html).toContain('+$0.00 added · +$100.00 growth');
    expect(html).not.toContain('+$4,000.00 growth');
  });
});

describe('NetWorthChart currency', () => {
  test('prints an account in its own currency', () => {
    const html = renderToStaticMarkup(
      <NetWorthChart
        currency="EUR"
        points={[
          { date: '2026-09-01', value: 1000 },
          { date: '2026-09-02', value: 1100 },
        ]}
        baseline={[
          { date: '2026-09-01', value: 1000 },
          { date: '2026-09-02', value: 1000 },
        ]}
      />
    );
    expect(html).toContain('€');
    expect(html).not.toContain('$');
  });
});

describe('NetWorthChart when the baseline stops early', () => {
  // Flows known only to an earlier day: the summary runs to that day rather
  // than vanishing because the last point has no baseline.
  test('summarises to the last day the baseline reaches', () => {
    const html = renderToStaticMarkup(
      <NetWorthChart
        points={[
          { date: '2026-09-01', value: 1000 },
          { date: '2026-09-02', value: 1100 },
          { date: '2026-09-03', value: 1200 },
        ]}
        baseline={[
          { date: '2026-09-01', value: 1000 },
          { date: '2026-09-02', value: 1000 },
        ]}
      />
    );
    expect(html).toContain('+$0.00 added · +$100.00 growth');
  });
});
