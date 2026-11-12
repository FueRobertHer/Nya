// lib/import/vanguard-performance.ts
//
// Reading Vanguard's Performance page, printed from a browser to a PDF, into
// an account's months. Pure: it takes each page's text items with their
// positions (lib/import/pdf-text.ts gets them with pdf.js), so it runs the
// same in the browser and in tests. Safe to import from client code.
//
// THE PAGE. Printed with one account chosen and a date range, it shows the
// range ("Date Range: 01/01/2020 - 11/10/2026"), a summary (Ending balance,
// Rate of return, Beginning balance, Investment returns, Deposits &
// Withdrawals), then a table, newest month first, one row a month (MM/YYYY):
// Beginning balance, Deposits & Withdrawals (one signed net), Market
// Gain/Loss, Income returns, Personal Investment Returns, Cumulative returns
// and Ending balance, with a Total row under the last month. The newest
// month runs only to the range's end. The print never names the account, so
// which account a file is for is the import's question, not this one's.
//
// FINDING THE FIGURES. A plain text extraction jumbles the table (a narrow
// cell wraps, so a minus sign can sit on a line of its own above its
// amount), so each figure is placed by where it is on the page. The header
// row is found by its words, and each figure goes to the column whose header
// is nearest its own center. Each MM/YYYY in the Month column anchors a row,
// whose band runs halfway to the rows above and below (at most two lines),
// so a cell centered between a wrapped sign and its amount lands in its own
// row. A sign on its own joins the nearest amount below it in its column. A
// page without the header row (a browser that doesn't repeat it) is read
// with the columns of the page before. Firefox's and Chrome's prints differ
// (Chrome wraps no signs, prints the summary's labels on one line, and puts
// about:blank in its margins); the reader goes by the page's own words, never
// the print's margins.
//
// CHECKED, NEVER GUESSED. Every month is checked to the cent: its returns
// are its market gain or loss plus its income, its ending balance is its
// beginning balance plus its deposits and withdrawals plus its returns, it
// begins where the month before it ended, and its cumulative returns are the
// month before's plus its own (the oldest month's are its own: they count
// from the range's start). The Total row must be the sum of the months,
// and the summary must match the table. A month that fails is returned as
// read, with what failed, for the person to correct against Vanguard's page.
//
// FAILING CLOSED. A file that isn't Vanguard's Performance page is refused
// ('not-performance'), and one that is, but whose table isn't laid out as
// this reader knows it, is refused too ('unknown-layout'): a header word
// missing or out of order, a heading it doesn't know (a column Vanguard
// adds), a figure that fits no row, months missing or
// twice, months outside the date range, no Total row or no summary. Nothing
// is read from either, so a page Vanguard changes can't import wrong figures.

/** One piece of text on a page: its top-left corner, from the page's top
 *  left, in points, and its size. y is the text's baseline. */
export type PdfTextItem = { text: string; x: number; y: number; width: number; height: number };
export type PdfPage = { width: number; height: number; items: PdfTextItem[] };

/** An amount in cents. */
export type Cents = number;

/** The table's figures, by its columns. */
export const FIGURES = ['begin', 'net', 'market', 'income', 'returns', 'cumulative', 'end'] as const;
export type Figure = (typeof FIGURES)[number];

/** What a month failed: a figure not found (or found twice), returns that
 *  aren't market plus income, an ending balance that isn't the beginning
 *  plus deposits and withdrawals plus returns, a beginning that isn't the
 *  month before's end, cumulative returns that aren't the month before's
 *  plus this month's (the oldest month's: its own). */
export type MonthCheck = 'cells' | 'returns' | 'adds-up' | 'begins-at-last-end' | 'cumulative';

export type PerformanceMonth = {
  /** 'YYYY-MM'. */
  month: string;
  /** Each figure in cents, null when it wasn't found or was found twice. */
  figures: Record<Figure, Cents | null>;
  /** Whether the month is whole in the file: the newest month is cut at the
   *  range's end unless that is its last day, and the oldest is cut at the
   *  range's start unless that is its first day. */
  whole: boolean;
  failed: MonthCheck[];
};

/** The Total row's columns and the summary's figures. */
export type TotalColumn = 'net' | 'market' | 'income' | 'returns';
export type SummaryFigure = 'begin' | 'end' | 'net' | 'returns';

export type UnknownLayout =
  | 'no-date-range'
  | 'no-table-header'
  | 'header-out-of-order'
  | 'unknown-heading'
  | 'no-months'
  | 'month-twice'
  | 'months-not-consecutive'
  | 'months-outside-range'
  | 'unplaced-figures'
  | 'no-total'
  | 'no-summary';

export type PerformanceRead =
  | {
      kind: 'read';
      /** The date range, as 'YYYY-MM-DD'. */
      range: { from: string; to: string };
      /** Every month in the table, oldest first. */
      months: PerformanceMonth[];
      /** The Total row's columns that aren't the sum of the months. */
      total_differs: TotalColumn[];
      /** The Total row and the summary as read, in cents (a column of the
       *  Total row not found is null), so the checks can be run again on a
       *  month the person corrects. */
      total: Record<TotalColumn, Cents | null>;
      summary: Record<SummaryFigure, Cents>;
      /** The summary's figures that don't match the table. */
      summary_differs: SummaryFigure[];
      /** The oldest month began at $0.00. Most often the account opened in
       *  it, but the balance alone can't prove that (an account emptied and
       *  funded again begins at $0.00 too), so no month counts as whole for
       *  it. */
      begins_at_zero: boolean;
      /** The balance on the range's last day: the newest month's end. */
      last: { day: string; balance: Cents | null };
      /** Every month passed every check, and so did the total and summary. */
      ok: boolean;
    }
  | { kind: 'not-performance' }
  | { kind: 'unknown-layout'; why: UnknownLayout }
  | { kind: 'no-text' };

// The header's words, left to right, and the figure each column holds.
const HEADER = [
  ['Month', null],
  ['Beginning', 'begin'],
  ['Deposits', 'net'],
  ['Market', 'market'],
  ['Income', 'income'],
  ['Personal', 'returns'],
  ['Cumulative', 'cumulative'],
  ['Ending', 'end'],
] as const satisfies readonly (readonly [string, Figure | null])[];
type Column = Figure | 'month';
// Every word of the headings, in any case: any other word in the header row
// is a column this reader doesn't know.
const HEADING_WORDS = new Set(
  ['Month', 'Beginning', 'balance', 'Deposits', '&', 'Withdrawals', 'Market', 'Gain/Loss', 'Income', 'returns', 'Personal', 'Investment', 'Cumulative', 'Ending'].map((w) =>
    w.toLowerCase()
  )
);

const MONTH = /^(0[1-9]|1[0-2])\/(\d{4})$/;
const SIGN = /^[+\-−]$/;
const AMOUNT = /^([+\-−]?)\$(\d{1,3}(?:,\d{3})*)\.(\d\d)$/;
const RANGE = /^(\d\d)\/(\d\d)\/(\d{4})\s*[-\u2013]\s*(\d\d)\/(\d\d)\/(\d{4})$/;

/** An amount as the page writes it ("$1,234.56", "-$12.00", "+$3.10"), in
 *  cents; null for anything else. */
export function amountCents(text: string): Cents | null {
  const m = AMOUNT.exec(text);
  if (!m) return null;
  const cents = Number(m[2].replaceAll(',', '')) * 100 + Number(m[3]);
  return m[1] && m[1] !== '+' ? -cents : cents;
}

// A month, an amount, the summary's rate ("6.5% (as of 11/10/2026)"), a sign
// or the Total row's label at the start of what's left of a piece of text,
// after any spaces.
const TOKEN =
  /^\s*(Total|(?:0[1-9]|1[0-2])\/\d{4}|[+\-−]?\$\d{1,3}(?:,\d{3})*\.\d\d|[+\-−]?\d+(?:\.\d+)?%(?:\s*\(as of \d\d\/\d\d\/\d{4}\))?|[+\-−])(?=\s|$|[+\-−$]|\d\d\/)/;
// How wide a character is, roughly, beside a digit: the same for most, half
// for the narrow ones. Enough to place a piece split out of a run.
const charWidth = (ch: string) => (/[,.:/\s]/.test(ch) ? 0.5 : 1);

/** pdf.js joins text that sits close on a line into one piece, so a large
 *  balance printed close to the next cell comes as "$1,234,567.89
 *  $1,000.00", or with no space at all. A piece made only of months, amounts,
 *  rates and signs is split back into them, each placed by its share of the
 *  piece's width. Anything else is left whole. */
export function splitRuns(item: PdfTextItem): PdfTextItem[] {
  const tokens: { text: string; start: number }[] = [];
  let rest = item.text;
  let at = 0;
  while (rest.trim()) {
    const m = TOKEN.exec(rest);
    if (!m) return [item];
    tokens.push({ text: m[1], start: at + m[0].length - m[1].length });
    at += m[0].length;
    rest = rest.slice(m[0].length);
  }
  if (tokens.length < 2) return [item];
  const weights = [...item.text].map(charWidth);
  const total = weights.reduce((a, b) => a + b, 0);
  const before = (n: number) => weights.slice(0, n).reduce((a, b) => a + b, 0);
  return tokens.map((t) => ({
    ...item,
    text: t.text,
    x: item.x + (item.width * before(t.start)) / total,
    width: (item.width * (before(t.start + t.text.length) - before(t.start))) / total,
  }));
}

type Placed = PdfTextItem & { cx: number; cents: Cents | null };
const placed = (i: PdfTextItem): Placed => ({ ...i, cx: i.x + i.width / 2, cents: amountCents(i.text) });

/** Where `word` stands on its own in a piece of text, as the center of each
 *  place, by its share of the piece's width: a heading or a label is found
 *  even when pdf.js has joined it to its neighbour. */
function wordCenters(item: PdfTextItem, word: string): number[] {
  const weights = [...item.text].map(charWidth);
  const total = weights.reduce((a, b) => a + b, 0);
  const before = (n: number) => weights.slice(0, n).reduce((a, b) => a + b, 0);
  const out: number[] = [];
  for (let at = item.text.indexOf(word); at >= 0; at = item.text.indexOf(word, at + 1)) {
    const end = at + word.length;
    if ((at > 0 && !/\s/.test(item.text[at - 1])) || (end < item.text.length && !/\s/.test(item.text[end]))) continue;
    out.push(item.x + (item.width * (before(at) + before(end)) / 2) / total);
  }
  return out;
}

/** Every place `word` stands on its own among `items`. */
const findWord = (items: Placed[], word: string) => items.flatMap((i) => wordCenters(i, word).map((cx) => ({ item: i, cx })));

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function isoDay(mm: string, dd: string, yyyy: string): string | null {
  const m = Number(mm);
  const d = Number(dd);
  if (m < 1 || m > 12 || d < 1 || d > daysIn(Number(yyyy), m)) return null;
  return `${yyyy}-${mm}-${dd}`;
}
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The next month after 'YYYY-MM'. */
function nextMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

type Header = { centers: [Column, number][]; top: number; bottom: number };

/** The page's header row: every header word, once each, within a line or so
 *  of a "Month", in order left to right, and no word that isn't a heading's
 *  (a figure close under it aside). */
function findHeader(items: Placed[], lineH: number): Header | 'missing' | 'out-of-order' | 'unknown-heading' {
  let outOfOrder = false;
  for (const month of findWord(items, 'Month')) {
    const band = items.filter((i) => Math.abs(i.y - month.item.y) <= 1.4 * lineH);
    const centers: [Column, number][] = [];
    for (const [word, figure] of HEADER) {
      const found = findWord(band, word);
      if (found.length !== 1) break;
      centers.push([figure ?? 'month', found[0].cx]);
    }
    if (centers.length !== HEADER.length) continue;
    if (centers.some((c, k) => k > 0 && c[1] <= centers[k - 1][1])) {
      outOfOrder = true;
      continue;
    }
    const figure = (i: Placed) => i.cents != null || SIGN.test(i.text) || MONTH.test(i.text) || i.text === 'Total';
    if (!band.every((i) => figure(i) || i.text.split(/\s+/).every((w) => HEADING_WORDS.has(w.toLowerCase())))) return 'unknown-heading';
    return { centers, top: Math.min(...band.map((i) => i.y - i.height)), bottom: Math.max(...band.map((i) => i.y)) };
  }
  return outOfOrder ? 'out-of-order' : 'missing';
}

function columnOf(centers: [Column, number][], cx: number): Column {
  let best = centers[0];
  for (const c of centers) if (Math.abs(c[1] - cx) < Math.abs(best[1] - cx)) best = c;
  return best[0];
}

type Row = { month: string; figures: Record<Figure, Cents | null>; twice: boolean };

/** Reads the pages of a printed Performance page. */
export function readPerformance(pages: PdfPage[]): PerformanceRead {
  const all = pages.flatMap((p) => p.items).filter((i) => i.text.trim());
  if (!all.length) return { kind: 'no-text' };
  // Vanguard's page, by its own words: its name, the "Performance" title and
  // the "Date Range:" label. Anything else isn't this page.
  const vanguard = all.some((i) => /vanguard/i.test(i.text));
  const title = all.some((i) => i.text.trim() === 'Performance');
  const rangeLabel = all.some((i) => /^Date range:?$/i.test(i.text.trim()));
  if (!vanguard || !title || !rangeLabel) return { kind: 'not-performance' };

  const range = (() => {
    for (const i of all) {
      const m = RANGE.exec(i.text.trim());
      if (!m) continue;
      const from = isoDay(m[1], m[2], m[3]);
      const to = isoDay(m[4], m[5], m[6]);
      if (from && to && from <= to) return { from, to };
    }
    return null;
  })();
  if (!range) return { kind: 'unknown-layout', why: 'no-date-range' };

  // A line of the table's text, from the size of its figures.
  const lineH = 1.2 * (median(all.filter((i) => AMOUNT.test(i.text.trim())).map((i) => i.height)) || 12);

  const rows: Row[] = [];
  let centers: [Column, number][] | null = null;
  let summary: Record<SummaryFigure, Cents> | null = null;
  // A Total column found twice is null, so it can't match the months.
  let total: Partial<Record<TotalColumn, Cents | null>> | null = null;

  for (const page of pages) {
    const items = page.items
      .flatMap(splitRuns)
      .map((i) => ({ ...i, text: i.text.trim() }))
      .filter((i) => i.text)
      .map(placed);
    const header = findHeader(items, lineH);
    if (header === 'out-of-order') return { kind: 'unknown-layout', why: 'header-out-of-order' };
    if (header === 'unknown-heading') return { kind: 'unknown-layout', why: 'unknown-heading' };
    if (header !== 'missing') {
      centers = header.centers;
      // The summary sits above the first page's table.
      if (!summary) {
        const found = readSummary(items, header.top, lineH);
        if (found) summary = found;
      }
    }
    if (!centers) continue;
    const cols = centers;
    const bodyTop = header === 'missing' ? -Infinity : header.bottom + 2;

    const totalLabel = items.find((i) => i.text === 'Total' && i.y > bodyTop && columnOf(cols, i.cx) === 'month');
    // The months' rows end half a line above the Total row's label; the
    // table, with the Total row, a line below it.
    const stop = totalLabel ? totalLabel.y - lineH / 2 : Infinity;
    const table = items.filter((i) => i.y > bodyTop && i.y <= (totalLabel ? totalLabel.y + lineH : Infinity));
    const anchors = table.filter((i) => i.y < stop && MONTH.test(i.text) && columnOf(cols, i.cx) === 'month').sort((a, b) => a.y - b.y);

    // A sign on its own joins the nearest amount below it in its column, and
    // the two sit at the middle of where they were, in a month's row or the
    // Total row alike.
    const amounts = table.filter((i) => i.cents != null).map((i) => ({ ...i }));
    for (const sign of table.filter((i) => SIGN.test(i.text))) {
      const col = columnOf(cols, sign.cx);
      const below = amounts
        .filter((a) => a.y > sign.y && a.y - sign.y <= 1.5 * lineH && columnOf(cols, a.cx) === col && !/^[+\-−]/.test(a.text))
        .sort((a, b) => a.y - b.y)[0];
      if (!below) return { kind: 'unknown-layout', why: 'unplaced-figures' };
      below.text = sign.text + below.text;
      below.cents = amountCents(below.text);
      below.y = (below.y + sign.y) / 2;
    }

    const body = amounts.filter((i) => i.y < stop);
    const used = new Set<Placed>();
    anchors.forEach((a, k) => {
      const lo = Math.max(k > 0 ? (anchors[k - 1].y + a.y) / 2 : -Infinity, a.y - 2 * lineH);
      const hi = Math.min(k < anchors.length - 1 ? (anchors[k + 1].y + a.y) / 2 : Infinity, a.y + 2 * lineH);
      const m = MONTH.exec(a.text)!;
      const row: Row = { month: `${m[2]}-${m[1]}`, figures: { begin: null, net: null, market: null, income: null, returns: null, cumulative: null, end: null }, twice: false };
      const seen = new Set<Figure>();
      for (const it of body) {
        if (it.y < lo || it.y >= hi) continue;
        const col = columnOf(cols, it.cx);
        if (col === 'month') continue;
        used.add(it);
        if (seen.has(col)) {
          row.twice = true;
          row.figures[col] = null;
        } else {
          seen.add(col);
          row.figures[col] = it.cents;
        }
      }
      rows.push(row);
    });
    if (body.some((i) => !used.has(i))) return { kind: 'unknown-layout', why: 'unplaced-figures' };

    if (totalLabel) {
      const row: Partial<Record<TotalColumn, Cents | null>> = {};
      for (const it of amounts.filter((i) => i.y >= stop)) {
        const col = columnOf(cols, it.cx);
        if (col === 'net' || col === 'market' || col === 'income' || col === 'returns') row[col] = col in row ? null : it.cents!;
      }
      total = row;
      break;
    }
  }

  if (!centers) return { kind: 'unknown-layout', why: 'no-table-header' };
  if (!rows.length) return { kind: 'unknown-layout', why: 'no-months' };
  if (!total) return { kind: 'unknown-layout', why: 'no-total' };
  if (!summary) return { kind: 'unknown-layout', why: 'no-summary' };

  rows.sort((a, b) => a.month.localeCompare(b.month));
  for (let k = 1; k < rows.length; k++) {
    if (rows[k].month === rows[k - 1].month) return { kind: 'unknown-layout', why: 'month-twice' };
    if (rows[k].month !== nextMonth(rows[k - 1].month)) return { kind: 'unknown-layout', why: 'months-not-consecutive' };
  }
  const oldest = rows[0];
  const newest = rows[rows.length - 1];
  if (oldest.month !== range.from.slice(0, 7) || newest.month !== range.to.slice(0, 7)) return { kind: 'unknown-layout', why: 'months-outside-range' };

  const months: PerformanceMonth[] = rows.map((r, k) => {
    const f = r.figures;
    const failed: MonthCheck[] = [];
    if (r.twice || FIGURES.some((x) => f[x] == null)) failed.push('cells');
    const before = rows[k - 1]?.figures;
    if (f.market != null && f.income != null && f.returns != null && f.returns !== f.market + f.income) failed.push('returns');
    if (f.begin != null && f.net != null && f.returns != null && f.end != null && f.end !== f.begin + f.net + f.returns) failed.push('adds-up');
    if (before && f.begin != null && before.end != null && f.begin !== before.end) failed.push('begins-at-last-end');
    const lastCumulative = before ? before.cumulative : 0;
    if (f.cumulative != null && f.returns != null && lastCumulative != null && f.cumulative !== lastCumulative + f.returns) failed.push('cumulative');
    const cutAtEnd = r === newest && range.to.slice(8) !== String(daysIn(Number(r.month.slice(0, 4)), Number(r.month.slice(5)))).padStart(2, '0');
    const cutAtStart = r === oldest && range.from.slice(8) !== '01';
    return { month: r.month, figures: { ...f }, whole: !cutAtEnd && !cutAtStart, failed };
  });

  const sum = (x: Figure) => rows.reduce<number | null>((s, r) => (s == null || r.figures[x] == null ? null : s + r.figures[x]!), 0);
  const total_differs = (['net', 'market', 'income', 'returns'] as const).filter((c) => total![c] == null || total![c] !== sum(c));
  const summary_differs = (
    [
      ['begin', oldest.figures.begin],
      ['end', newest.figures.end],
      ['net', sum('net')],
      ['returns', sum('returns')],
    ] as const
  )
    .filter(([k, v]) => summary![k] !== v)
    .map(([k]) => k);

  return {
    kind: 'read',
    range,
    months,
    total_differs,
    total: { net: total!.net ?? null, market: total!.market ?? null, income: total!.income ?? null, returns: total!.returns ?? null },
    summary: { ...summary! },
    summary_differs,
    begins_at_zero: oldest.figures.begin === 0,
    last: { day: range.to, balance: newest.figures.end },
    ok: months.every((m) => !m.failed.length) && !total_differs.length && !summary_differs.length,
  };
}

// The summary's labels, by their first word, and the figure under each.
const SUMMARY: [string, SummaryFigure][] = [
  ['Ending', 'end'],
  ['Beginning', 'begin'],
  ['Investment', 'returns'],
  ['Deposits', 'net'],
];

/** The summary above the table: each label's figure is the amount below it
 *  (within a few lines) nearest its center, each amount used once. A label
 *  printed on two lines ("Ending" over "balance") is found by its first. */
function readSummary(items: Placed[], tableTop: number, lineH: number): Record<SummaryFigure, Cents> | null {
  const out: Partial<Record<SummaryFigure, Cents>> = {};
  const taken = new Set<Placed>();
  const above = items.filter((i) => i.y < tableTop);
  for (const [word, figure] of SUMMARY) {
    const labels = findWord(above, word);
    if (labels.length !== 1) return null;
    const { item: label, cx } = labels[0];
    const value = above
      .filter((i) => i.cents != null && !taken.has(i) && i.y > label.y && i.y - label.y <= 4 * lineH)
      .sort((a, b) => Math.abs(a.cx - cx) - Math.abs(b.cx - cx))[0];
    if (!value) return null;
    taken.add(value);
    out[figure] = value.cents!;
  }
  return out as Record<SummaryFigure, Cents>;
}
