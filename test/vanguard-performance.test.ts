// The reader of Vanguard's Performance page (lib/import/vanguard-performance.ts)
// and the PDF text it reads (lib/import/pdf-text.ts), on synthetic prints
// laid out as Firefox and Chrome print the page (test/vanguard-performance-pdf.ts).

import { describe, expect, test } from 'bun:test';
import { pdfTextPages, type PdfJs } from '@/lib/import/pdf-text';
import { amountCents, readPerformance, splitRuns, type PdfPage, type PdfTextItem, type PerformanceRead } from '@/lib/import/vanguard-performance';
import { makeMonths, money, pdfBytes, performancePdf, type MonthFigures, type PrintOptions } from './vanguard-performance-pdf';

const pdfjs: PdfJs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const RANGE = { from: '2017-11-01', to: '2026-11-10' };
const MONTHS = makeMonths(RANGE.from, RANGE.to);

async function pagesOf(bytes: Uint8Array): Promise<PdfPage[]> {
  const pages = await pdfTextPages(bytes, pdfjs);
  if ('error' in pages) throw new Error(pages.error);
  return pages;
}

async function print(o: Partial<PrintOptions> = {}, months: MonthFigures[] = MONTHS) {
  const pdf = performancePdf(months, { range: RANGE, ...o });
  const pages = await pagesOf(pdf.bytes);
  return { pdf, pages, read: readPerformance(pages) };
}

/** `pages` with each pair of pieces that sit close on a line (as the
 *  headings' first lines do) joined into one, as pdf.js joins close text:
 *  the left one's text, a space, the right one's, spanning both. */
function joined(pages: PdfPage[], pairs: [string, string][]): PdfPage[] {
  return pages.map((p) => {
    let items = [...p.items];
    for (const [a, b] of pairs) {
      for (const left of items.filter((i) => i.text === a)) {
        const gap = (i: PdfTextItem) => i.x - (left.x + left.width);
        const right = items.find((i) => i.text === b && Math.abs(i.y - left.y) < 1 && gap(i) > 0 && gap(i) < 25);
        if (!right) continue;
        items = [...items.filter((i) => i !== left && i !== right), { ...left, text: `${a} ${b}`, width: right.x + right.width - left.x }];
      }
    }
    return { ...p, items };
  });
}

function asRead(r: PerformanceRead) {
  if (r.kind !== 'read') throw new Error(`not read: ${JSON.stringify(r)}`);
  return r;
}

const figures = (m: MonthFigures) => ({ begin: m.begin, net: m.net, market: m.market, income: m.income, returns: m.returns, cumulative: m.cumulative, end: m.end });
const asPrinted = (months: MonthFigures[]) => months.map((m) => ({ month: m.month, figures: figures(m) }));
const asReadBack = (r: ReturnType<typeof asRead>) => r.months.map((m) => ({ month: m.month, figures: m.figures }));

describe('a Firefox print', () => {
  test('reads every month to the cent, oldest first, with its wrapped minus signs joined', async () => {
    const { pdf, read } = await print();
    expect(pdf.wrapped).toBeGreaterThan(10);
    expect(pdf.pages).toBeGreaterThan(3);
    const r = asRead(read);
    expect(r.ok).toBe(true);
    expect(asReadBack(r)).toEqual(asPrinted(MONTHS));
    expect(r.months.every((m) => !m.failed.length)).toBe(true);
    expect(r.range).toEqual(RANGE);
    expect(r.begins_at_zero).toBe(true);
    expect(r.total_differs).toEqual([]);
    expect(r.summary_differs).toEqual([]);
    expect(r.last).toEqual({ day: '2026-11-10', balance: MONTHS[MONTHS.length - 1].end });
  });

  test('the newest month runs only to the range’s end, so it isn’t whole; every other month is', async () => {
    const r = asRead((await print()).read);
    expect(r.months.filter((m) => !m.whole).map((m) => m.month)).toEqual(['2026-11']);
  });

  test('cells centered, or a wrapped row’s other cells at its top, read the same', async () => {
    for (const o of [{ align: 'center' }, { valign: 'top' }, { align: 'center', valign: 'top' }] as const) {
      const r = asRead((await print(o)).read);
      expect(r.ok).toBe(true);
      expect(asReadBack(r)).toEqual(asPrinted(MONTHS));
    }
  });

  test('a print that doesn’t repeat the header on later pages reads with the first page’s columns', async () => {
    const r = asRead((await print({ repeatHeader: false })).read);
    expect(r.ok).toBe(true);
    expect(asReadBack(r)).toEqual(asPrinted(MONTHS));
  });

  test('a row’s cells run together into one piece of text are split back', async () => {
    const { pages, read } = await print({ oneFont: true });
    expect(pages.some((p) => p.items.some((i) => /^\d\d\/\d{4}\$/.test(i.text)))).toBe(true);
    const r = asRead(read);
    expect(r.ok).toBe(true);
    expect(asReadBack(r)).toEqual(asPrinted(MONTHS));
  });

  test('headings run together into one piece of text are found inside it', async () => {
    for (const style of ['firefox', 'chrome'] as const) {
      const pages = joined((await print({ style })).pages, [
        ['Beginning', 'Deposits &'],
        ['Market', 'Income'],
        ['Cumulative', 'Ending'],
      ]);
      expect(pages[0].items.some((i) => i.text === 'Market Income')).toBe(true);
      const r = asRead(readPerformance(pages));
      expect(r.ok).toBe(true);
      expect(asReadBack(r)).toEqual(asPrinted(MONTHS));
    }
  });

  test('balances over a million, wider than their cells and run into the next, read the same', async () => {
    const big = makeMonths(RANGE.from, RANGE.to, { scale: 10 });
    expect(Math.max(...big.map((m) => m.end))).toBeGreaterThan(100_000_000);
    for (const oneFont of [false, true]) {
      const r = asRead((await print({ oneFont }, big)).read);
      expect(r.ok).toBe(true);
      expect(asReadBack(r)).toEqual(asPrinted(big));
    }
  });
});

describe('a Chrome print', () => {
  test('reads the same months as Firefox’s: no wrapped signs, one-line labels, about:blank in the margins', async () => {
    for (const oneFont of [false, true]) {
      const { pdf, pages, read } = await print({ style: 'chrome', oneFont });
      expect(pdf.wrapped).toBe(0);
      expect(pages[0].items.some((i) => i.text === 'about:blank')).toBe(true);
      const r = asRead(read);
      expect(r.ok).toBe(true);
      expect(asReadBack(r)).toEqual(asPrinted(MONTHS));
    }
  });
});

describe('the months a range holds', () => {
  test('a range from after the account opened begins at its balance then, and its cut first month isn’t whole', async () => {
    const range = { from: '2022-01-15', to: RANGE.to };
    const months = makeMonths(range.from, range.to, { startBalance: 5_000_000 });
    const r = asRead((await print({ range }, months)).read);
    expect(r.ok).toBe(true);
    expect(r.begins_at_zero).toBe(false);
    expect(r.months[0].figures.begin).toBe(5_000_000);
    expect(r.months.filter((m) => !m.whole).map((m) => m.month)).toEqual(['2022-01', '2026-11']);
  });

  test('from the 1st of a month, the first month is whole', async () => {
    const range = { from: '2022-01-01', to: RANGE.to };
    const r = asRead((await print({ range }, makeMonths(range.from, range.to, { startBalance: 5_000_000 }))).read);
    expect(r.months[0].whole).toBe(true);
  });

  test('from mid-month, the first month isn’t whole even at $0.00: the balance alone can’t say the account opened then', async () => {
    const range = { from: '2017-11-14', to: RANGE.to };
    const r = asRead((await print({ range }, makeMonths(range.from, range.to))).read);
    expect(r.ok).toBe(true);
    expect(r.begins_at_zero).toBe(true);
    expect(r.months[0].whole).toBe(false);
  });

  test('a range to a month’s last day leaves its newest month whole', async () => {
    const range = { from: RANGE.from, to: '2026-10-31' };
    const r = asRead((await print({ range }, makeMonths(range.from, range.to))).read);
    expect(r.months.every((m) => m.whole)).toBe(true);
  });
});

describe('checked to the cent, never guessed', () => {
  test('a misread ending balance fails its month and the next, and is returned as read', async () => {
    const aug = MONTHS.find((m) => m.month === '2021-08')!;
    const r = asRead((await print({ cell: (month, f, t) => (month === '2021-08' && f === 'end' ? money(aug.end + 1800) : t) })).read);
    expect(r.ok).toBe(false);
    expect(r.months.filter((m) => m.failed.length).map((m) => [m.month, m.failed])).toEqual([
      ['2021-08', ['adds-up']],
      ['2021-09', ['begins-at-last-end']],
    ]);
    expect(r.months.find((m) => m.month === '2021-08')!.figures.end).toBe(aug.end + 1800);
    expect(r.total_differs).toEqual([]);
    expect(r.summary_differs).toEqual([]);
  });

  test('the oldest month’s cumulative returns are its own, so a misread one fails, even alone in the file', async () => {
    const range = { from: '2026-11-01', to: RANGE.to };
    const [only] = makeMonths(range.from, range.to);
    expect(only.cumulative).toBe(only.returns);
    expect(asRead((await print({ range }, [only])).read).ok).toBe(true);
    const r = asRead((await print({ range, cell: (_, f, t) => (f === 'cumulative' ? money(only.cumulative + 9_999_900) : t) }, [only])).read);
    expect(r.ok).toBe(false);
    expect(r.months.map((m) => [m.month, m.failed])).toEqual([['2026-11', ['cumulative']]]);
  });

  test('a misread return fails its month, the Total row and the summary', async () => {
    const mar = MONTHS.find((m) => m.month === '2023-03')!;
    const r = asRead((await print({ cell: (month, f, t) => (month === '2023-03' && f === 'returns' ? money(mar.returns + 100) : t) })).read);
    expect(r.months.filter((m) => m.failed.length).map((m) => [m.month, m.failed])).toEqual([['2023-03', ['returns', 'adds-up', 'cumulative']]]);
    expect(r.total_differs).toEqual(['returns']);
    expect(r.summary_differs).toEqual(['returns']);
  });

  test('a lost minus sign is caught: the month’s returns no longer add up', async () => {
    const r = asRead((await print({ dropWrappedSigns: true })).read);
    expect(r.ok).toBe(false);
    const failing = r.months.filter((m) => m.failed.length);
    expect(failing.length).toBeGreaterThan(5);
    // Every figure was read; only the signs were lost, and the sums show it.
    expect(failing.some((m) => m.failed.includes('cells'))).toBe(false);
    expect(failing.every((m) => m.failed.includes('returns') || m.failed.includes('cumulative'))).toBe(true);
  });

  test('a figure missing from its cell, or two in one cell, fail the month as its cells', async () => {
    const missing = asRead((await print({ cell: (month, f, t) => (month === '2020-06' && f === 'income' ? null : t) })).read);
    expect(missing.months.find((m) => m.month === '2020-06')).toMatchObject({ failed: ['cells'], figures: { income: null } });
    expect(missing.total_differs).toEqual(['income']);
    const twice = asRead((await print({ cell: (month, f, t) => (month === '2020-06' && f === 'net' ? `$1.00 ${t}` : t) })).read);
    expect(twice.months.find((m) => m.month === '2020-06')).toMatchObject({ failed: ['cells'], figures: { net: null } });
  });

  test('a minus sign wrapped onto its own line in the Total row joins its amount there too', async () => {
    const range = { from: '2026-08-01', to: '2026-10-31' };
    const sum = (ms: MonthFigures[], f: 'market' | 'returns') => ms.reduce((s, m) => s + m[f], 0);
    const months = Array.from({ length: 50 }, (_, seed) => makeMonths(range.from, range.to, { startBalance: 5_000_000, seed: seed + 1 })).find(
      (ms) => sum(ms, 'market') < 0 && sum(ms, 'returns') < 0
    )!;
    const { pages } = await print({ range }, months);
    expect(asRead(readPerformance(pages)).ok).toBe(true);
    // Wrap the Total row's two negative cells as Firefox wraps a month's, the
    // sign a line above its amount; then with the sign higher still, up among
    // the months' rows.
    for (const lift of [7, 10]) {
      const wrapped = pages.map((p) => {
        const total = p.items.find((i) => i.text === 'Total');
        if (!total) return p;
        const negative = p.items.filter((i) => Math.abs(i.y - total.y) < 1 && i.text.startsWith('-$'));
        expect(negative).toHaveLength(2);
        return {
          ...p,
          items: p.items.flatMap((i) =>
            negative.includes(i) ? [{ ...i, text: '-', width: 4, y: i.y - lift }, { ...i, text: i.text.slice(1), y: i.y + 7 }] : [i]
          ),
        };
      });
      const r = asRead(readPerformance(wrapped));
      expect(r.total_differs).toEqual([]);
      expect(r.ok).toBe(true);
    }
  });

  test('a Total column with two amounts in it can’t match the months', async () => {
    const { pages } = await print();
    const twice = pages.map((p) => {
      const total = p.items.find((i) => i.text === 'Total');
      const net = total && p.items.find((i) => Math.abs(i.y - total.y) < 1 && i.x > 156 && i.x + i.width < 232);
      // The stray comes first, so keeping the last amount would still match.
      return net ? { ...p, items: [{ ...net, text: '$5.00', y: net.y + 3 }, ...p.items] } : p;
    });
    expect(asRead(readPerformance(twice)).total_differs).toEqual(['net']);
  });
});

describe('refused, with nothing read', () => {
  test('no text at all', async () => {
    expect(readPerformance([])).toEqual({ kind: 'no-text' });
    expect(readPerformance(await pagesOf(pdfBytes([[]])))).toEqual({ kind: 'no-text' });
  });

  test('not Vanguard’s Performance page: the same table without Vanguard on it, or another PDF', async () => {
    expect((await print({ vanguard: false })).read).toEqual({ kind: 'not-performance' });
    const statement = pdfBytes([[{ x: 42, y: 60, size: 12, text: 'Vanguard Brokerage Account statement', font: 'F1' }, { x: 42, y: 90, size: 12, text: 'Performance', font: 'F1' }]]);
    expect(readPerformance(await pagesOf(statement))).toEqual({ kind: 'not-performance' });
  });

  test('a heading Vanguard renamed, or columns in another order', async () => {
    expect((await print({ heading: { cumulative: ['Total', 'returns'] } })).read).toEqual({ kind: 'unknown-layout', why: 'no-table-header' });
    expect((await print({ swap: ['market', 'income'] })).read).toEqual({ kind: 'unknown-layout', why: 'header-out-of-order' });
  });

  test('a column Vanguard adds, its heading one this reader doesn’t know', async () => {
    const { pages } = await print();
    const added = pages.map((p) => {
      const month = p.items.find((i) => i.text === 'Month');
      return month ? { ...p, items: [...p.items, { ...month, text: 'Fees', x: 572 }] } : p;
    });
    expect(readPerformance(added)).toEqual({ kind: 'unknown-layout', why: 'unknown-heading' });
  });

  test('a month missing, a month twice, or months outside the date range', async () => {
    expect((await print({ skip: ['2020-05'] })).read).toEqual({ kind: 'unknown-layout', why: 'months-not-consecutive' });
    const { pages } = await print();
    expect(readPerformance([pages[0], pages[1], ...pages.slice(1)])).toEqual({ kind: 'unknown-layout', why: 'month-twice' });
    expect((await print({ range: { from: '2018-01-01', to: RANGE.to } })).read).toEqual({ kind: 'unknown-layout', why: 'months-outside-range' });
  });

  test('a figure or a sign that fits no row', async () => {
    const { pages } = await print();
    const stray = (text: string) => [{ ...pages[0], items: [...pages[0].items, { text, x: 300, y: 785, width: 30, height: 12 }] }, ...pages.slice(1)];
    expect(readPerformance(stray('$5.00'))).toEqual({ kind: 'unknown-layout', why: 'unplaced-figures' });
    expect(readPerformance(stray('-'))).toEqual({ kind: 'unknown-layout', why: 'unplaced-figures' });
  });

  test('no Total row, no summary, or no date range', async () => {
    expect((await print({ total: false })).read).toEqual({ kind: 'unknown-layout', why: 'no-total' });
    expect((await print({ summary: false })).read).toEqual({ kind: 'unknown-layout', why: 'no-summary' });
    const { pages } = await print();
    const noRange = pages.map((p) => ({ ...p, items: p.items.filter((i) => !/^\d\d\/\d\d\/\d{4} - /.test(i.text)) }));
    expect(readPerformance(noRange)).toEqual({ kind: 'unknown-layout', why: 'no-date-range' });
  });
});

describe('PDF text', () => {
  test('each piece of text is placed from the page’s top left, at its baseline', async () => {
    const [page] = await pagesOf(pdfBytes([[{ x: 42, y: 79, size: 12, text: 'Performance', font: 'F1' }]]));
    expect(page).toMatchObject({ width: 612, height: 792 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].text).toBe('Performance');
    expect(page.items[0].x).toBeCloseTo(42, 1);
    expect(page.items[0].y).toBeCloseTo(79, 1);
    expect(page.items[0].height).toBeCloseTo(12, 1);
  });

  test('a file that isn’t a PDF can’t be read', async () => {
    expect(await pdfTextPages(new TextEncoder().encode('Date,Amount\n2026-01-01,5.00\n'), pdfjs)).toEqual({ error: 'unreadable' });
  });

  test('a file too large, or too long, is refused before its pages are read', async () => {
    const { bytes } = performancePdf(MONTHS, { range: RANGE });
    expect(await pdfTextPages(bytes, pdfjs, { bytes: 1000, pages: 60 })).toEqual({ error: 'too-large' });
    expect(await pdfTextPages(bytes, pdfjs, { bytes: 10_000_000, pages: 2 })).toEqual({ error: 'too-many-pages' });
  });
});

describe('pieces of text', () => {
  test('amounts as the page writes them, in cents', () => {
    expect(amountCents('$1,234.56')).toBe(123456);
    expect(amountCents('-$12.00')).toBe(-1200);
    expect(amountCents('+$3.10')).toBe(310);
    expect(amountCents('−$1.00')).toBe(-100);
    expect(amountCents('$0.00')).toBe(0);
    for (const bad of ['$1,23.00', '1.00', '$1.0', '($1.00)', '$1,000', 'USD 1.00']) expect(amountCents(bad)).toBeNull();
  });

  test('a run of months and amounts is split into its pieces, left to right; anything else stays whole', () => {
    const item = { text: '11/2026$1,234,567.89 -$1,000.00', x: 40, y: 250, width: 160, height: 12 };
    const parts = splitRuns(item);
    expect(parts.map((p) => p.text)).toEqual(['11/2026', '$1,234,567.89', '-$1,000.00']);
    for (let k = 1; k < parts.length; k++) expect(parts[k].x).toBeGreaterThan(parts[k - 1].x + parts[k - 1].width - 0.01);
    expect(parts[0].x).toBe(40);
    expect(parts[2].x + parts[2].width).toBeCloseTo(200, 5);
    expect(splitRuns({ ...item, text: 'Total $5.00 $6.00' }).map((p) => p.text)).toEqual(['Total', '$5.00', '$6.00']);
    expect(splitRuns({ ...item, text: '$1,234,567.89 6.5% (as of 11/10/2026)' }).map((p) => p.text)).toEqual(['$1,234,567.89', '6.5% (as of 11/10/2026)']);
    for (const text of ['Date Range: 01/01/2020 - 11/10/2026', 'Total', '$5.00', 'Deposits & Withdrawals', '$1,234.567']) expect(splitRuns({ ...item, text })).toEqual([{ ...item, text }]);
  });
});

