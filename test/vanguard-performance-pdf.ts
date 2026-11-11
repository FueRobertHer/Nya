// Synthetic prints of Vanguard's Performance page, for the reader's tests
// (test/vanguard-performance.test.ts). Every figure is made up: no real
// person's file is kept anywhere in this repository.
//
// They are laid out as Firefox and Chrome print the page (learnt from where
// each piece of text sits in real prints, never their figures): Firefox
// prints each summary label on two lines, wraps a minus sign onto its own
// line when a negative amount is wider than its cell, and puts the page's
// title and address at the top and "1 of 4" and the print time at the
// bottom; Chrome prints the labels on one line, wraps nothing, and puts the
// print time, about:blank and "1/4" in its margins. Both repeat the table's
// header on every page and print a Total row under the oldest month, then a
// disclaimer. Options bend the layout (cells centered, wrapped cells top
// aligned, no repeated header) or break it (a misread figure, a lost sign, a
// missing month, a renamed heading), to show what the reader does with each.
//
// Run directly to write a few to a folder to look at:
//   bun test/vanguard-performance-pdf.ts <folder>

export type MonthFigures = {
  month: string; // 'YYYY-MM'
  begin: number;
  net: number;
  market: number;
  income: number;
  returns: number;
  cumulative: number;
  end: number;
};
type Figure = Exclude<keyof MonthFigures, 'month'>;
type Column = 'month' | Figure;

/** Made-up months from `from` to `to` (both 'YYYY-MM-DD'), oldest first: an
 *  opening deposit (or `startBalance` brought in), a deposit most months, a
 *  withdrawal now and then, markets up and down, dividends each quarter. The
 *  last month runs to `to`'s day only. */
export function makeMonths(from: string, to: string, opts: { startBalance?: number; seed?: number; scale?: number } = {}): MonthFigures[] {
  let seed = opts.seed ?? 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const scale = opts.scale ?? 1;
  const out: MonthFigures[] = [];
  let month = from.slice(0, 7);
  let balance = opts.startBalance ?? 0;
  let cumulative = 0;
  for (let k = 0; ; k++) {
    const net = k === 0 && !opts.startBalance ? 1_000_000 * scale : k % 40 === 25 ? -1_200_000 * scale : k % 7 === 4 ? 0 : 200_000 * scale;
    const base = balance + net / 2;
    const market = Math.round(base * (rand() * 0.11 - 0.05));
    const income = Number(month.slice(5)) % 3 === 0 ? Math.round(base * 0.004) : 0;
    const begin = balance;
    balance = begin + net + market + income;
    cumulative += market + income;
    out.push({ month, begin, net, market, income, returns: market + income, cumulative, end: balance });
    if (month === to.slice(0, 7)) break;
    month = month.slice(5) === '12' ? `${Number(month.slice(0, 4)) + 1}-01` : `${month.slice(0, 4)}-${String(Number(month.slice(5)) + 1).padStart(2, '0')}`;
  }
  return out;
}

/** "$1,234.56", "-$12.00", or with `plus`, "+$3.10". */
export function money(cents: number, plus = false): string {
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${cents < 0 ? '-' : plus && cents > 0 ? '+' : ''}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

export type PrintOptions = {
  style?: 'firefox' | 'chrome';
  range: { from: string; to: string };
  /** Cells left aligned (as both browsers print them) or centered. */
  align?: 'left' | 'center';
  /** Where a wrapped cell's other cells sit: in the middle of the row (as
   *  printed) or at its top. */
  valign?: 'middle' | 'top';
  repeatHeader?: boolean;
  /** Whether Vanguard's name is on the page (and in the print's margins). */
  vanguard?: boolean;
  /** Replace a column's heading lines. */
  heading?: Partial<Record<Column, string[]>>;
  /** Swap two columns' places. */
  swap?: [Column, Column];
  total?: boolean;
  summary?: boolean;
  /** Override what a cell shows; null leaves it empty. */
  cell?: (month: string, figure: Figure, text: string) => string | null;
  /** Leave out the sign of every minus sign that wraps onto its own line. */
  dropWrappedSigns?: boolean;
  /** Months left out of the table. */
  skip?: string[];
  /** Draw every cell of a row in one font, so pdf.js may join cells that
   *  sit close together into one piece of text. */
  oneFont?: boolean;
};

// Helvetica's widths, per 1000 of the font size, for characters 32 to 126.
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const textWidth = (text: string, size: number) => [...text].reduce((w, ch) => w + (WIDTHS[ch.charCodeAt(0) - 32] ?? 556), 0) * (size / 1000);

type Op = { x: number; y: number; size: number; text: string; font: string };

type Layout = {
  body: { title: [number, number]; heading: [number, number]; range: [number, number] };
  margins: (page: number, pages: number, vanguard: boolean) => Op[];
  summary: { labels: { x: number; lines: string[] }[]; labelY: number; lineGap: number; valueY: number; valueX: number[] };
  boxes: Record<Column, [number, number]>;
  headerMonthY: (first: boolean) => number;
  headerGap: number;
  rowH: number;
  wrapH: number;
  wraps: boolean;
  bottom: number;
};

const FIREFOX: Layout = {
  body: { title: [42, 53], heading: [42, 79], range: [42, 105] },
  margins: (page, pages, vanguard) => [
    { x: 0, y: 9, size: 10, text: vanguard ? 'Vanguard' : 'Brokerage', font: 'F1' },
    { x: 362.8, y: 9, size: 10, text: vanguard ? 'https://investor.vanguard.com/portfolio/performance/' : 'https://example.com/performance/', font: 'F1' },
    { x: 0, y: 790, size: 10, text: `${page} of ${pages}`, font: 'F1' },
    { x: 525.8, y: 790, size: 10, text: '11/10/2026, 9:41 AM', font: 'F1' },
  ],
  summary: {
    labels: [
      { x: 84, lines: ['Ending', 'balance'] },
      { x: 185, lines: ['Rate of return'] },
      { x: 294, lines: ['Beginning', 'balance'] },
      { x: 392, lines: ['Investment', 'returns'] },
      { x: 506, lines: ['Deposits &', 'Withdrawals'] },
    ],
    labelY: 121.3,
    lineGap: 14,
    valueY: 159.3,
    valueX: [44.3, 126.4, 247.3, 351, 451],
  },
  boxes: { month: [40, 84], begin: [84, 156], net: [156, 232], market: [232, 290], income: [290, 354], returns: [354, 430], cumulative: [430, 498], end: [498, 570] },
  headerMonthY: (first) => (first ? 209.3 : 61.8),
  headerGap: 14,
  rowH: 24,
  wrapH: 38,
  wraps: true,
  bottom: 765,
};

const CHROME: Layout = {
  body: { title: [46.5, 45], heading: [34.5, 70.5], range: [34.5, 96] },
  margins: (page, pages) => [
    { x: 24, y: 22.5, size: 8, text: '11/10/26, 9:41 AM', font: 'F1' },
    { x: 334.1, y: 22.5, size: 8, text: 'about:blank', font: 'F1' },
    { x: 24, y: 775.5, size: 8, text: 'about:blank', font: 'F1' },
    { x: 576.9, y: 775.5, size: 8, text: `${page}/${pages}`, font: 'F1' },
  ],
  summary: {
    labels: [
      { x: 78.1, lines: ['Ending balance'] },
      { x: 179.4, lines: ['Rate of return'] },
      { x: 292.1, lines: ['Beginning balance'] },
      { x: 395.7, lines: ['Investment returns'] },
      { x: 515.4, lines: ['Deposits & Withdrawals'] },
    ],
    labelY: 111.7,
    lineGap: 13.5,
    valueY: 128.2,
    valueX: [36.7, 119.4, 242, 346.9, 448],
  },
  boxes: { month: [34, 79], begin: [79, 147], net: [147, 232], market: [232, 295], income: [295, 356], returns: [356, 433], cumulative: [433, 505], end: [505, 577] },
  headerMonthY: (first) => (first ? 170.2 : 50),
  headerGap: 13.5,
  rowH: 16.5,
  wrapH: 16.5,
  wraps: false,
  bottom: 760,
};

const HEADINGS: Record<Column, string[]> = {
  month: ['Month'],
  begin: ['Beginning', 'balance'],
  net: ['Deposits &', 'Withdrawals'],
  market: ['Market', 'Gain/Loss'],
  income: ['Income', 'returns'],
  returns: ['Personal', 'Investment', 'Returns'],
  cumulative: ['Cumulative', 'returns'],
  end: ['Ending', 'balance'],
};
const COLUMNS: Column[] = ['month', 'begin', 'net', 'market', 'income', 'returns', 'cumulative', 'end'];
const FIGURES: Figure[] = ['begin', 'net', 'market', 'income', 'returns', 'cumulative', 'end'];

const usDay = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;

/** A print of the Performance page for `months` (oldest first), as a PDF.
 *  Also says how many minus signs it wrapped and how many pages it has. */
export function performancePdf(months: MonthFigures[], o: PrintOptions): { bytes: Uint8Array; wrapped: number; pages: number } {
  const L = o.style === 'chrome' ? CHROME : FIREFOX;
  const vanguard = o.vanguard ?? true;
  const boxes = { ...L.boxes };
  if (o.swap) [boxes[o.swap[0]], boxes[o.swap[1]]] = [boxes[o.swap[1]], boxes[o.swap[0]]];
  const center = (c: Column) => (boxes[c][0] + boxes[c][1]) / 2;
  // Real prints keep each cell, heading and label its own piece of text;
  // alternating fonts does that here, unless oneFont asks otherwise.
  const fontOf = (c: Column) => (o.oneFont ? 'F1' : COLUMNS.indexOf(c) % 2 ? 'F3' : 'F1');
  const boldOf = (n: number) => (o.oneFont || n % 2 === 0 ? 'F2' : 'F4');
  const pages: Op[][] = [[]];
  let ops = pages[0];
  const put = (x: number, y: number, text: string, size = 12, font = 'F1') => ops.push({ x, y, size, text, font });
  const centered = (cx: number, y: number, text: string, font: string) => put(cx - textWidth(text, 12) / 2, y, text, 12, font);

  // The page's top: Vanguard's name, the title, the date range, the summary.
  const shown = months.filter((m) => !o.skip?.includes(m.month));
  put(L.body.title[0], L.body.title[1], vanguard ? 'The Vanguard Group' : 'Brokerage Services', 12, 'F2');
  put(L.body.heading[0], L.body.heading[1], 'Performance', 12, 'F2');
  put(L.body.range[0], L.body.range[1], 'Date Range:', 12, 'F2');
  put(L.body.range[0] + textWidth('Date Range:', 12) + 3, L.body.range[1], `${usDay(o.range.from)} - ${usDay(o.range.to)}`);
  if (o.summary ?? true) {
    const S = L.summary;
    for (const [n, label] of S.labels.entries()) {
      const top = label.lines.length === 1 && S.labels.some((l) => l.lines.length === 2) ? S.labelY + S.lineGap / 2 : S.labelY;
      label.lines.forEach((line, k) => centered(label.x, top + k * S.lineGap, line, boldOf(n)));
    }
    const sum = (f: Figure) => months.reduce((s, m) => s + m[f], 0);
    const values = [money(months[months.length - 1].end), '6.5%', money(months[0].begin), money(sum('returns'), true), money(sum('net'), true)];
    const valueFont = (k: number) => (o.oneFont || k % 2 === 0 ? 'F1' : 'F3');
    values.forEach((v, k) => put(S.valueX[k], S.valueY, v, 12, valueFont(k)));
    put(S.valueX[1] + textWidth('6.5%', 12) + 3, S.valueY, `(as of ${usDay(o.range.to)})`, 12, valueFont(1));
  }

  // The table, newest month first.
  const header = (first: boolean) => {
    const monthY = L.headerMonthY(first);
    for (const c of COLUMNS) {
      const lines = o.heading?.[c] ?? HEADINGS[c];
      const top = monthY - ((lines.length - 1) * L.headerGap) / 2;
      lines.forEach((line, k) => centered(center(c), top + k * L.headerGap, line, boldOf(COLUMNS.indexOf(c))));
    }
    return monthY + L.headerGap * 1.5 + 4;
  };
  let top = header(true);
  let wrapped = 0;
  const pad = 2.5;
  const cellX = (c: Column, text: string) => ((o.align ?? 'left') === 'center' ? center(c) - textWidth(text, 12) / 2 : boxes[c][0] + pad);
  for (const m of [...shown].reverse()) {
    const cells = FIGURES.map((f) => [f, o.cell ? o.cell(m.month, f, money(m[f])) : money(m[f])] as const);
    const wraps = cells.filter(([f, t]) => L.wraps && t != null && t.startsWith('-') && textWidth(t, 12) > boxes[f][1] - boxes[f][0] - 2 * pad);
    const h = wraps.length ? L.wrapH : L.rowH;
    if (top + h > L.bottom) {
      ops = [];
      pages.push(ops);
      top = o.repeatHeader ?? true ? header(false) : 50;
    }
    const middle = top + h / 2 + 4;
    const first = (o.valign ?? 'middle') === 'top' ? top + 16 : middle;
    put(cellX('month', ''), first, `${m.month.slice(5)}/${m.month.slice(0, 4)}`, 12, fontOf('month'));
    for (const [f, t] of cells) {
      if (t == null) continue;
      if (wraps.some(([w]) => w === f)) {
        wrapped++;
        const amount = t.slice(1);
        const y0 = (o.valign ?? 'middle') === 'top' ? top + 16 : middle - 7;
        if (!o.dropWrappedSigns) put(cellX(f, '-'), y0, '-', 12, fontOf(f));
        put(cellX(f, amount), y0 + 14, amount, 12, fontOf(f));
      } else put(cellX(f, t), first, t, 12, fontOf(f));
    }
    top += h;
  }

  // The Total row, centered under its headings, and the disclaimer.
  if (o.total ?? true) {
    if (top + L.rowH > L.bottom) {
      ops = [];
      pages.push(ops);
      top = o.repeatHeader ?? true ? header(false) : 50;
    }
    const y = top + L.rowH / 2 + 4;
    centered(center('month'), y, 'Total', 'F2');
    for (const f of ['net', 'market', 'income', 'returns'] as const) centered(center(f), y, money(months.reduce((s, m) => s + m[f], 0)), fontOf(f));
    top += L.rowH;
  }
  const lines = [
    'Past performance is no guarantee of future returns. These figures are made up',
    'for testing and describe no real account or person.',
    vanguard ? 'Printed from Vanguard for a test.' : 'Printed for a test.',
  ];
  if (top + 32 + 14 * lines.length > L.bottom) {
    ops = [];
    pages.push(ops);
    top = 40;
  }
  put(42, top + 32, 'Disclaimer:', 14, 'F2');
  lines.forEach((line, k) => put(42, top + 60 + 14 * k, line));

  for (const [k, page] of pages.entries()) page.push(...L.margins(k + 1, pages.length, vanguard));
  return { bytes: pdfBytes(pages), wrapped, pages: pages.length };
}

/** A minimal PDF of text: letter pages, Helvetica with its widths given, so
 *  pdf.js measures the text as it was laid out. */
export function pdfBytes(pages: Op[][]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => '\\' + c);
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const font = (name: string) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 /Widths [${WIDTHS.join(' ')}] >>`);
  const catalog = add('');
  const tree = add('');
  const fonts = { F1: font('Helvetica'), F2: font('Helvetica-Bold'), F3: font('Arial'), F4: font('Arial-Bold') };
  const kids: number[] = [];
  for (const page of pages) {
    const stream = page.map((op) => `BT /${op.font} ${op.size} Tf 1 0 0 1 ${op.x.toFixed(2)} ${(792 - op.y).toFixed(2)} Tm (${esc(op.text)}) Tj ET`).join('\n');
    const contents = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${Object.entries(fonts)
          .map(([k, v]) => `/${k} ${v} 0 R`)
          .join(' ')} >> >> /Contents ${contents} 0 R >>`
      )
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, k) => {
    offsets.push(out.length);
    out += `${k + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) throw new Error('usage: bun test/vanguard-performance-pdf.ts <folder>');
  const months = makeMonths('2017-11-01', '2026-11-10');
  for (const style of ['firefox', 'chrome'] as const) {
    const { bytes } = performancePdf(months, { style, range: { from: '2017-11-01', to: '2026-11-10' } });
    await Bun.write(`${dir}/performance-${style}.pdf`, bytes);
  }
}
