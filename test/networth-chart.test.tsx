import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import NetWorthChart from '@/components/NetWorthChart';
import { DrawnWidth, MIN_LABEL_GAP, labelWidth } from '@/components/drawn-width';

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
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>6M</);
  });

  // Its change includes money added, so a percentage would read as a return.
  test('an investment shows no percentage', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={year} rangeSet="investment" />);
    expect(html).toMatch(/chart-readout-value">\+\$[\d,.]+</);
  });

  test('opens an investment on year to date, and offers no 3Y or 5Y yet', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={year} rangeSet="investment" />);
    expect(html).toContain('Year to date');
    expect(html).toMatch(/role="radio" aria-checked="true"[^>]*>YTD</);
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

  // Every month that fits: Mar 24 to Sep 24 on a 340-wide card has room for
  // each month start (the screen review found six months labelled twice).
  test('the axis is labelled at every month that fits, not only its two ends', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={year} />);
    const labels = [...html.matchAll(/class="chart-xlabel"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(labels).toEqual(['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
  });
});

// The screen review after step 5: a history that is an estimate from end to
// end (a demo's, estimated up to a recorded today) was dashed throughout and
// never looked solid. With no recorded stretch to set apart, it is drawn
// solid and says once, in words, that it is estimated.
describe('NetWorthChart estimated throughout', () => {
  function days(n: number, est: (i: number) => boolean, step = 1): P[] {
    return Array.from({ length: n }, (_, i) => ({
      date: new Date(Date.parse('2026-09-01T00:00:00Z') + i * step * 86_400_000).toISOString().slice(0, 10),
      value: 1000 + i,
      ...(est(i) ? { estimated: true } : {}),
    }));
  }
  const readDate = (html: string) => html.match(/<span class="chart-readout-date">([^<]*)</)?.[1];
  const label = (html: string) => html.match(/<svg [^>]*role="img" aria-label="([^"]*)"/)?.[1] ?? '';

  test('every day estimated: one solid line, and the readout, the label and the info say so', () => {
    const points = days(20, () => true);
    expect(runs(points)).toEqual(['solid']);
    const html = renderToStaticMarkup(<NetWorthChart points={points} />);
    expect(readDate(html)).toBe('Since Sep 1, 2026 · estimated');
    expect(label(html)).toContain('Estimated from transactions, not recorded.');
    expect(html).toContain('Estimated from transactions, not recorded. No stretch of this range is recorded, so the line is solid.');
    expect(html).not.toContain('Dashed: estimated');
  });

  test('estimated up to a recorded last day: solid, and the words keep that day out', () => {
    const points = days(20, (i) => i < 19);
    expect(runs(points)).toEqual(['solid']);
    const html = renderToStaticMarkup(<NetWorthChart points={points} />);
    expect(readDate(html)).toBe('Since Sep 1, 2026 · estimated');
    expect(label(html)).toContain('Estimated from transactions, not recorded, except Sep 20.');
  });

  test('a recorded stretch: dashed and solid as before, and the range is not called estimated', () => {
    const points = days(20, (i) => i < 10);
    expect(runs(points)).toEqual(['dashed', 'solid']);
    const html = renderToStaticMarkup(<NetWorthChart points={points} />);
    expect(readDate(html)).toBe('Since Sep 1, 2026');
    expect(html).not.toContain('Estimated from transactions');
    expect(html).toContain('Dashed: estimated');
  });

  test('every day recorded: solid, and nothing says estimated', () => {
    const html = renderToStaticMarkup(<NetWorthChart points={days(20, () => false)} />);
    expect(readDate(html)).toBe('Since Sep 1, 2026');
    expect(html).not.toContain('stimated');
  });

  // A shared net worth is one point a week (lib/share-views.ts): every
  // segment skips days, so a few estimated weeks must not turn it solid.
  test('recorded points a week apart with some estimated weeks stay dashed, and the range is not called estimated', () => {
    const points = days(12, (i) => i >= 3 && i < 6, 7);
    expect(runs(points)).toEqual(['dashed']);
    const html = renderToStaticMarkup(<NetWorthChart points={points} />);
    expect(readDate(html)).not.toContain('estimated');
    expect(html).not.toContain('Estimated from transactions');
  });
});

// Home's hero (look and feel, step 5): edge to edge, drawn at its own width,
// no gridlines and no money on its plot, its months spaced by their widths.
// Since the screen review, a chart elsewhere (an account's) takes the same
// rules in its card's shape.
describe('NetWorthChart as the hero', () => {
  function daily(first: string, last: string, start = 100) {
    const out: P[] = [];
    for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += 86_400_000) {
      out.push({ date: new Date(t).toISOString().slice(0, 10), value: start + out.length });
    }
    return out;
  }
  const year = daily('2025-08-03', '2026-09-24');
  const at = (width: number, node: React.ReactNode) => renderToStaticMarkup(<DrawnWidth.Provider value={width}>{node}</DrawnWidth.Provider>);

  test('drawn at its width, with no gridline and no money tick on the plot', () => {
    const html = at(352, <NetWorthChart hero points={year} />);
    // at-width: its months take the 12px rule (.at-width .chart-xlabel).
    expect(html).toContain('class="chart-svg at-width hero-chart"');
    expect(html).toContain('viewBox="0 0 352 140"');
    expect(html).not.toContain('chart-tick');
    expect(html).not.toContain('stroke="var(--border-subtle)"');
    // Its wash, and the today dot ringed in the page it stands on.
    expect(html).toContain('opacity="0.12"');
    expect(html).toMatch(/<circle [^>]*stroke="var\(--canvas\)"/);
  });

  test('its months keep inside the gutter and never overlap, at a phone’s width and a wide one', () => {
    for (const width of [352, 760]) {
      const html = at(width, <NetWorthChart hero points={year} />);
      const labels = [...html.matchAll(/<text class="chart-xlabel" x="([\d.]+)"[^>]*text-anchor="(start|middle|end)"[^>]*>([^<]*)</g)].map((m) => {
        const x = Number(m[1]);
        const w = labelWidth(m[3]);
        const from = m[2] === 'start' ? x : m[2] === 'end' ? x - w : x - w / 2;
        return [from, from + w] as const;
      });
      expect(labels.length).toBeGreaterThanOrEqual(5);
      for (const [from, to] of labels) {
        expect(from).toBeGreaterThanOrEqual(16);
        expect(to).toBeLessThanOrEqual(width - 16);
      }
      for (let i = 1; i < labels.length; i++) expect(labels[i][0] - labels[i - 1][1]).toBeGreaterThanOrEqual(MIN_LABEL_GAP);
    }
  });

  // The fixture ends Sep 24, so its six months start Mar 24, and every month
  // start whose day lies outside the gutter is labelled: a step of one month.
  // Apr 1 is 15.5px in at 320, inside the gutter, and 17.9px in at 375.
  test('six months get a label for every month start outside the gutter, at a phone’s width', () => {
    const months = (width: number) => [...at(width, <NetWorthChart hero points={year} />).matchAll(/class="chart-xlabel"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(months(320)).toEqual(['May', 'Jun', 'Jul', 'Aug', 'Sep']);
    expect(months(375)).toEqual(['Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
  });

  // A year's months are about 30px apart at 375: too close for every one with
  // room to spare, so every second month, evenly; on a wide screen, all twelve.
  test('a year takes every second month on a phone and every month on a wide screen, evenly stepped', () => {
    const months = (width: number) =>
      [...at(width, <NetWorthChart hero points={year} initialRange="1Y" />).matchAll(/class="chart-xlabel"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(months(320)).toEqual(['Nov', '2026', 'Mar', 'May', 'Jul', 'Sep']);
    expect(months(375)).toEqual(['Nov', '2026', 'Mar', 'May', 'Jul', 'Sep']);
    expect(months(760)).toEqual(['Oct', 'Nov', 'Dec', '2026', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
  });

  test('every point is behind Show as a table, rendered only once it is opened', () => {
    const html = at(352, <NetWorthChart hero points={year} />);
    expect(html).toContain('<summary>Show as a table</summary>');
    expect(html).not.toContain('<table>');
  });

  // The screen review: the account's chart printed "-$2K" on its line. Every
  // net worth chart now takes the hero's rules, in its card's shape.
  test('an account’s chart: drawn at its width in the card’s shape, no money on the plot, months spaced, and a table', () => {
    const html = at(352, <NetWorthChart points={year} />);
    expect(html).toContain('class="chart-svg at-width"');
    expect(html).toContain(`viewBox="0 0 352 ${Math.round((352 * 150) / 340)}"`);
    expect(html).not.toContain('chart-tick');
    expect(html).not.toContain('stroke="var(--border-subtle)"');
    expect(html).toMatch(/<circle [^>]*stroke="var\(--surface\)"/);
    const labels = [...html.matchAll(/<text class="chart-xlabel" x="([\d.]+)"[^>]*text-anchor="(start|middle|end)"[^>]*>([^<]*)</g)].map((m) => {
      const x = Number(m[1]);
      const w = labelWidth(m[3]);
      const from = m[2] === 'start' ? x : m[2] === 'end' ? x - w : x - w / 2;
      return [from, from + w] as const;
    });
    expect(labels).toHaveLength(6);
    for (const [from, to] of labels) {
      expect(from).toBeGreaterThanOrEqual(0);
      expect(to).toBeLessThanOrEqual(352);
    }
    for (let i = 1; i < labels.length; i++) expect(labels[i][0] - labels[i - 1][1]).toBeGreaterThanOrEqual(MIN_LABEL_GAP);
    expect(html).toContain('<summary>Show as a table</summary>');
    expect(html).not.toContain('<table>');
  });
});
