import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { setSystemTime } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import NetWorthChart from '@/components/NetWorthChart';
import { availableRanges, sliceRange, type RangeKey } from '@/lib/chart-range';
import { formatDay, formatMoney, MINUS, roundsToNothing } from '@/lib/format';
import { contributionBaseline, rangeSplit, type BalancePoint, type Flow, type RangeSplit, type Totals } from '@/lib/growth';

// Accounts > Summary adds up each investment account's range from rangeSplit,
// so it must say what the account's own chart says for that range: the same
// days, the same money in and out, the same growth. These render the chart
// with the sheet's own grey line (components/AccountSparkline.tsx) and read
// its readout back.

beforeAll(() => setSystemTime(new Date('2026-10-29T12:00:00Z')));
afterAll(() => setSystemTime());

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Weekly points from `first`, growing steadily, with the flows in them a day
 *  after each, the first `estimated` of them estimated. */
function weekly(first: string, weeks: number, flows: Flow[], estimated = 0): BalancePoint[] {
  const out: BalancePoint[] = [];
  const t0 = Date.parse(`${first}T00:00:00Z`);
  for (let i = 0; i < weeks; i++) {
    const date = iso(t0 + i * 7 * DAY);
    const moved = flows.filter((f) => f.date < date).reduce((s, f) => s + f.amount, 0);
    out.push({ date, value: 10_000 + i * 150 + moved, ...(i < estimated ? { estimated: true } : {}) });
  }
  return out;
}

const signed = (n: number) => (n < 0 ? MINUS : '+') + formatMoney(Math.abs(n));

/** The readout the chart prints for a split over `shown`. */
function readoutFor(shown: BalancePoint[], s: RangeSplit): string {
  const value = (d: string) => shown.find((p) => p.date === d)!.value;
  const parts = [
    ...(roundsToNothing(s.in, null) ? [] : [`${formatMoney(s.in)} in`]),
    ...(roundsToNothing(s.out, null) ? [] : [`${formatMoney(s.out)} out`]),
    `${signed(s.growth)} growth`,
  ];
  const from = `${formatDay(s.from)} to ${formatDay(s.to)}: `;
  if (s.from === shown[0].date && s.to === shown[shown.length - 1].date) return from + parts.join(' · ');
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${from}${signed(value(s.to) - value(s.from))}, with ${list}`;
}

/** The chart's split line for a range, as text. */
function chartSays(points: BalancePoint[], key: RangeKey, flows: Flow[], from: string, to: string | null, totals: Totals | null): string {
  const html = renderToStaticMarkup(
    <NetWorthChart
      points={points}
      rangeSet="investment"
      initialRange={key}
      baselineFor={(shown) => contributionBaseline(shown, flows, from, to, totals)}
      baselineFrom={totals?.as_of ?? null}
    />
  );
  const m = html.match(/<div class="chart-readout-split">(.*?)<\/div>/);
  return (m?.[1] ?? '').replace(/<[^>]+>/g, '').replace(/&nbsp;| /g, '').trim();
}

const flows: Flow[] = [];
for (let w = 3; w < 105; w += 5) flows.push({ date: iso(Date.parse('2024-11-01T00:00:00Z') + w * 7 * DAY), amount: 1000 });
for (let w = 7; w < 105; w += 13) flows.push({ date: iso(Date.parse('2024-11-03T00:00:00Z') + w * 7 * DAY), amount: -400 });

const cases: { name: string; points: BalancePoint[]; from: string; to: string | null; totals: Totals | null }[] = [
  // Starts estimated, the activity starts later still, and it is known only
  // to a week before the last point: the line starts and stops inside.
  { name: 'a line that starts and stops inside the range', points: weekly('2024-11-01', 104, flows, 30), from: '2025-01-15', to: '2026-10-14', totals: null },
  { name: 'carried from totals', points: weekly('2024-11-01', 104, flows, 30), from: '2025-01-15', to: '2026-10-14', totals: { in: 20_000, out: 1_000, as_of: '2025-06-30' } },
  { name: 'recorded throughout, activity to the end', points: weekly('2024-11-01', 104, flows), from: '2024-01-01', to: null, totals: null },
];

describe('rangeSplit says what the chart says', () => {
  for (const c of cases) {
    test(c.name, () => {
      const keys = availableRanges(c.points, 'investment');
      expect(keys.length).toBeGreaterThan(3);
      for (const key of keys) {
        const shown = sliceRange(c.points, key);
        const s = rangeSplit(shown, flows, c.from, c.to, c.totals);
        const said = chartSays(c.points, key, flows, c.from, c.to, c.totals);
        if (s === null) expect([key, said]).toEqual([key, '']);
        else expect([key, said]).toEqual([key, readoutFor(shown, s)]);
      }
    });
  }

  test('the cases cover both of the readout\'s forms', () => {
    const forms = new Set<string>();
    for (const c of cases)
      for (const key of availableRanges(c.points, 'investment')) {
        const shown = sliceRange(c.points, key);
        const s = rangeSplit(shown, flows, c.from, c.to, c.totals);
        if (s) forms.add(s.from === shown[0].date && s.to === shown[shown.length - 1].date ? 'whole' : 'part');
      }
    expect([...forms].sort()).toEqual(['part', 'whole']);
  });
});

describe('rangeSplit', () => {
  const points = [
    { date: '2026-09-01', value: 1000 },
    { date: '2026-09-02', value: 1010 },
    { date: '2026-09-03', value: 1615, estimated: true },
    { date: '2026-09-04', value: 1600 },
  ];

  test('counts from the line\'s first day to its last real one', () => {
    expect(rangeSplit(points, [{ date: '2026-09-02', amount: 500 }, { date: '2026-09-03', amount: -50 }], '2026-01-01')).toEqual({
      from: '2026-09-01',
      to: '2026-09-04',
      in: 500,
      out: 50,
      growth: 150,
    });
  });

  test('stops where the activity is known to', () => {
    expect(rangeSplit(points, [{ date: '2026-09-02', amount: 500 }], '2026-01-01', '2026-09-03')).toEqual({
      from: '2026-09-01',
      to: '2026-09-02',
      in: 0,
      out: 0,
      growth: 10,
    });
  });

  test('none without activity, or with no real day inside it', () => {
    expect(rangeSplit(points, null, '2026-01-01')).toBeNull();
    expect(rangeSplit(points, [], null)).toBeNull();
    expect(rangeSplit(points, [], '2026-09-05')).toBeNull();
  });
});
