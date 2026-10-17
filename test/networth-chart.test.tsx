import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// The chart must not change height as figures change or arrive: the split line
// keeps its row whenever a split can appear at all, so nothing below it moves.
describe('NetWorthChart layout stability', () => {
  const pts = [
    { date: '2026-09-01', value: 1000 },
    { date: '2026-09-02', value: 1600 },
    { date: '2026-09-03', value: 1650 },
  ];

  test('holds the split row while the transactions load', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={pts} reserveSplit />);
    expect(html).toContain('chart-readout-split');
  });

  test('keeps the row when the baseline is there but has nothing to say for the range', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={pts} baselineFor={() => null} />);
    expect(html).toContain('chart-readout-split');
  });

  test('puts the date on its own line under the figure, so a long one cannot push the chart', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={pts} />);
    expect(html).toContain('chart-readout chart-readout-stable');
    expect(html).toContain('chart-readout-date');
  });

  test('adds no row to a chart that can never show a split', () => {
    expect(renderToStaticMarkup(<NetWorthChart points={pts} />)).not.toContain('chart-readout-split');
  });
});

describe('NetWorthChart segment styles', () => {
  test('consecutive real days draw solid, with no caption', () => {
    const points = [
      { date: '2026-09-01', value: 1 },
      { date: '2026-09-02', value: 2 },
    ];
    expect(runs(points)).toEqual(['solid']);
    expect(renderToStaticMarkup(<NetWorthChart points={points} />)).not.toContain('Dashed: estimated');
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
    expect(renderToStaticMarkup(<NetWorthChart points={points} />)).toContain('Dashed: estimated');
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
    const html = renderToStaticMarkup(<NetWorthChart points={points} baselineFor={() => baseline} />);
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
        baselineFor={() => [
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
        baselineFor={() => [
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
        baselineFor={() => [
          { date: '2026-09-01', value: 1000 },
          { date: '2026-09-02', value: 1000 },
        ]}
      />
    );
    expect(html).toContain('+$0.00 added · +$100.00 growth');
  });
});

// Notes on the timeline (#50): a marker on each noted day, the note in the
// readout on scrub, and a list under the chart for a keyboard and a screen
// reader. The line itself never changes: a cliff stays a cliff.
describe('NetWorthChart notes on the timeline', () => {
  const pts: P[] = [
    { date: '2026-09-01', value: 5000 },
    { date: '2026-09-02', value: 5000 },
    { date: '2026-09-03', value: 1000 },
    { date: '2026-09-04', value: 1000 },
  ];
  const notes = [
    { date: '2026-09-03', text: 'Ally Savings closed: moved to Chase' },
    { date: '2026-09-03', text: 'Bought the house' },
    { date: '2025-01-01', text: 'Before the chart begins' },
  ];
  const lines = (h: string) => [...h.matchAll(/<path [^>]*stroke-width="2"[^>]*>/g)].map((m) => m[0]);

  test('a noted day gets one marker, and a button under the chart that a keyboard reaches', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={pts} notes={notes} />);
    expect(html.match(/class="chart-note-mark"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Notes on this chart"');
    expect(html).toMatch(/<button type="button" class="chart-note-btn" aria-pressed="false"><span class="chart-note-day">Sep 3<\/span> Ally Savings closed: moved to Chase; Bought the house<\/button>/);
    // Only the notes in the range shown.
    expect(html).not.toContain('Before the chart begins');
    // The chart's own label says so, and the info says what the dotted lines are.
    expect(html).toContain('One note is marked, listed below the chart.');
    expect(html).toContain('Dotted lines mark your notes');
    // The announcement waits for a note to be chosen.
    expect(html).toContain('<p class="visually-hidden" aria-live="polite"></p>');
  });

  test('the line is untouched: the cliff stays a cliff', () => {
    expect(lines(renderToStaticMarkup(<NetWorthChart points={pts} notes={notes} />))).toEqual(lines(renderToStaticMarkup(<NetWorthChart points={pts} />)));
  });

  test('a note on a day with no point marks the first point after it, where its step shows', () => {
    const gap: P[] = [
      { date: '2026-09-01', value: 5000 },
      { date: '2026-09-05', value: 1000 },
    ];
    const html = renderToStaticMarkup(<NetWorthChart points={gap} notes={[{ date: '2026-09-03', text: 'Closed' }]} />);
    expect(html.match(/class="chart-note-mark"/g)).toHaveLength(1);
    expect(html).toContain('Sep 3</span> Closed');
  });

  test('on scrub the note keeps to the date’s one line, cut to fit, so the chart never moves under the finger', () => {
    // The suite can't scrub or lay a page out: this holds the rules the
    // readout relies on (a note of 110 characters moved the chart 44px at 320px
    // before them), and the markup that uses them.
    const css = readFileSync(join(import.meta.dir, '..', 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.chart-readout-noted \{[^}]*display: flex;[^}]*white-space: nowrap;/);
    expect(css).toMatch(/\.chart-readout-note \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/);
    const source = readFileSync(join(import.meta.dir, '..', 'components', 'NetWorthChart.tsx'), 'utf8');
    expect(source).toContain('<span className="chart-readout-date chart-readout-noted">');
    expect(source).toContain('<span className="chart-readout-note">');
  });

  test('no notes: no list, no markers, nothing announced', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={pts} notes={[]} />);
    expect(html).not.toContain('chart-notes');
    expect(html).not.toContain('chart-note-mark');
    expect(html).not.toContain('Dotted lines');
  });
});

describe('NetWorthChart time ranges', () => {
  /** One point a day, rising by one a day from `start`. */
  function daily(first: string, last: string, start = 100) {
    const out: P[] = [];
    for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += 86_400_000) {
      out.push({ date: new Date(t).toISOString().slice(0, 10), value: start + out.length });
    }
    return out;
  }
  const year = daily('2025-08-03', '2026-09-24');

  test('opens a balance on the past 6 months, with the change over it', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={year} />);
    expect(html).toContain('Past 6 months');
    // Mar 24 to Sep 24 is 184 days; the first shown value is 100 + 233.
    expect(html).toContain('+$184.00 (+55.3%)');
    expect(html).toContain('aria-pressed="true">6M<');
  });

  // Its change includes money added, so a percentage would read as a return.
  test('an investment shows no percentage', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={year} rangeSet="investment" />);
    expect(html).toMatch(/chart-readout-value">\+\$[\d,.]+</);
  });

  test('opens an investment on year to date, and offers no 3Y or 5Y yet', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={year} rangeSet="investment" />);
    expect(html).toContain('Year to date');
    expect(html).toContain('aria-pressed="true">YTD<');
    expect(html).not.toContain('>3Y<');
    expect(html).not.toContain('>5Y<');
  });

  test('a preview opens on all of it', () => {
    expect(renderToStaticMarkup(<NetWorthChart points={year} initialRange="ALL" />)).toContain('Since Aug 3, 2025');
  });

  test('a debt shows no percentage', () => {
    expect(renderToStaticMarkup(<NetWorthChart points={year} owed />)).toContain('+$184.00<');
  });

  test('a change from an estimated start is marked approximate', () => {
    const points = year.map((p) => ({ ...p, estimated: p.date < '2026-07-12' }));
    const html = renderToStaticMarkup(<NetWorthChart points={points} />);
    expect(html).toContain('≈ +$184.00');
    expect(html).toContain('≈: the change starts or ends on an estimated balance.');
  });

  // So money added and growth count from the start of the range.
  test('the baseline is computed from the range shown', () => {
    const seen: string[] = [];
    renderToStaticMarkup(
      <NetWorthChart
        points={year}
        rangeSet="investment"
        baselineFor={(shown) => {
          seen.push(shown[0].date);
          return null;
        }}
      />
    );
    expect(seen).toEqual(['2026-01-01']);
  });

  test('the explanations are behind the info button, closed', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={year} />);
    expect(html).toContain('aria-label="About this chart"');
    expect(html).toMatch(/class="chart-info" hidden=""/);
  });

  test('the axis is labelled at months, not only its two ends', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={year} />);
    const labels = [...html.matchAll(/class="chart-xlabel"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(labels).toEqual(['May', 'Jul', 'Sep']);
  });
});
