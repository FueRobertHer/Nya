// lib/chart-range.ts
//
// Time ranges for the balance charts (components/NetWorthChart.tsx): which
// ranges to offer, where each starts, what to call it, and where to put the
// time axis labels. Pure, so it is tested without rendering.
//
// Two sets. Balances (net worth, cash and credit accounts) are read over
// months; investments are read over years, the way brokerages show them.
// A range is offered only when the history reaches past its start: until then
// it would draw exactly what All draws.

export type RangeKey = '1M' | '3M' | '6M' | 'YTD' | '1Y' | '3Y' | '5Y' | 'ALL';
export type RangeSet = 'balance' | 'investment';

export const RANGE_SETS: Record<RangeSet, { keys: RangeKey[]; initial: RangeKey }> = {
  balance: { keys: ['1M', '3M', '6M', 'YTD', '1Y', 'ALL'], initial: '6M' },
  investment: { keys: ['1M', '3M', 'YTD', '1Y', '3Y', '5Y', 'ALL'], initial: 'YTD' },
};

const MONTHS: Partial<Record<RangeKey, number>> = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '3Y': 36, '5Y': 60 };

const DAY_MS = 86_400_000;
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** A YYYY-MM-DD date moved back whole calendar months, clamped to the month's
 *  last day (Mar 31 less a month is Feb 28 or 29). */
export function monthsBefore(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) - months;
  const year = Math.floor(total / 12);
  const month = total - year * 12; // 0-based
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return iso(Date.UTC(year, month, Math.min(d, last)));
}

/** First day a range covers, ending on `last`; null for All. */
export function rangeStart(key: RangeKey, last: string): string | null {
  if (key === 'ALL') return null;
  if (key === 'YTD') return `${last.slice(0, 4)}-01-01`;
  return monthsBefore(last, MONTHS[key]!);
}

/** The points a range shows (points sorted by date ascending). */
export function sliceRange<P extends { date: string }>(points: P[], key: RangeKey): P[] {
  if (points.length === 0) return points;
  const start = rangeStart(key, points[points.length - 1].date);
  return start === null ? points : points.filter((p) => p.date >= start);
}

/** The ranges worth offering: All, and each range the history reaches past
 *  that still has two points to draw. */
export function availableRanges(points: { date: string }[], set: RangeSet): RangeKey[] {
  if (points.length < 2) return ['ALL'];
  const first = points[0].date;
  const last = points[points.length - 1].date;
  return RANGE_SETS[set].keys.filter((key) => {
    const start = rangeStart(key, last);
    if (start === null) return true;
    return first < start && sliceRange(points, key).length >= 2;
  });
}

/** The range a chart opens on: the set's initial range, else the next longer
 *  one offered (in January, YTD falls through to 1Y), else All. */
export function initialRange(available: RangeKey[], set: RangeSet): RangeKey {
  const { keys, initial } = RANGE_SETS[set];
  for (const key of keys.slice(keys.indexOf(initial))) if (available.includes(key)) return key;
  return 'ALL';
}

/** What the range covers, in words, for the readout. */
export function rangeLabel(key: RangeKey, first: string): string {
  switch (key) {
    case '1M':
      return 'Past month';
    case '3M':
      return 'Past 3 months';
    case '6M':
      return 'Past 6 months';
    case 'YTD':
      return 'Year to date';
    case '1Y':
      return 'Past year';
    case '3Y':
      return 'Past 3 years';
    case '5Y':
      return 'Past 5 years';
    case 'ALL': {
      const d = new Date(`${first}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      return `Since ${d}`;
    }
  }
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Where to label the time axis between `first` and `last`, at most about five
 * labels, at dates a reader recognises:
 *   - up to two months: every week (or two), counted back from the last day;
 *   - up to three years: month starts, every 1, 2, 3 or 6 months, with January
 *     shown as its year so the year change is visible;
 *   - longer: the start of each year (or every other).
 */
export function axisTicks(first: string, last: string): { date: string; label: string }[] {
  const t0 = parse(first);
  const t1 = parse(last);
  const days = Math.round((t1 - t0) / DAY_MS);
  if (days <= 0) return [];

  if (days <= 62) {
    const step = days <= 35 ? 7 : 14;
    const out: { date: string; label: string }[] = [];
    for (let t = t1; t >= t0; t -= step * DAY_MS) {
      const d = new Date(t);
      out.unshift({ date: iso(t), label: `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}` });
    }
    return out;
  }

  const [y0, m0] = first.split('-').map(Number);
  if (days <= 3 * 366) {
    const starts: { year: number; month: number }[] = [];
    // Month starts strictly after the first day (the first day is the edge).
    for (let total = y0 * 12 + m0; ; total++) {
      const year = Math.floor(total / 12);
      const month = total - year * 12;
      if (Date.UTC(year, month, 1) > t1) break;
      starts.push({ year, month });
    }
    const step = [1, 2, 3, 6, 12].find((s) => Math.ceil(starts.length / s) <= 5) ?? 12;
    return starts
      .filter(({ month }) => month % step === 0)
      .map(({ year, month }) => ({
        date: iso(Date.UTC(year, month, 1)),
        label: month === 0 ? String(year) : MONTH_NAMES[month],
      }));
  }

  const years: number[] = [];
  for (let year = y0 + 1; Date.UTC(year, 0, 1) <= t1; year++) years.push(year);
  const step = Math.ceil(years.length / 5);
  return years.filter((y) => y % step === 0).map((year) => ({ date: `${year}-01-01`, label: String(year) }));
}
