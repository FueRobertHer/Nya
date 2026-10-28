import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MonthFigures, { shownFigures } from '@/components/MonthFigures';
import { MASK, setAmountsHidden } from '@/lib/format';

// Activity's In, Out and Net strip (components/MonthFigures.tsx, the screen
// review after step 5): money in with its plus, money out with its minus,
// net with its sign, each rounded to the currency's unit before it is
// written; its heading read alone unless it names a span longer than the
// bar's month; placeholders, hidden from a screen reader, while the sums are
// on their way.

const figures = (html: string) => [...html.matchAll(/<div class="(summary-value[^"]*)">(.*?)<\/div>/g)].map((m) => [m[1], m[2]]);
const strip = (moneyIn: number, moneyOut: number, currency: string | null = 'USD', caption: string | null = null) =>
  renderToStaticMarkup(<MonthFigures totals={{ moneyIn, moneyOut, currency }} title="In and out, October 2026" caption={caption} />);

describe('the figures', () => {
  test('in with its plus, out with its minus, net with its sign and color', () => {
    expect(figures(strip(1000, 4391.92))).toEqual([
      ['summary-value inflow', '+$1,000.00'],
      ['summary-value', '-$4,391.92'],
      ['summary-value negative', '-$3,391.92'],
    ]);
    expect(figures(strip(3100, 412.3))[2]).toEqual(['summary-value inflow', '+$2,687.70']);
  });

  test('nothing in or out is written without a sign, and a net that rounds to nothing is "$0.00" in no color', () => {
    expect(figures(strip(0, 0))).toEqual([
      ['summary-value inflow', '$0.00'],
      ['summary-value', '$0.00'],
      ['summary-value', '$0.00'],
    ]);
    // A sum that drifts a hair off the cent (0.1 + 0.2) is the cent.
    expect(figures(strip(0.1 + 0.2, 0.3))[2]).toEqual(['summary-value', '$0.00']);
    expect(shownFigures({ moneyIn: 0.1 + 0.2, moneyOut: 0.3, currency: 'USD' })).toEqual({ in: 0.3, out: 0.3, net: 0 });
  });

  test('a currency with no minor unit rounds to its whole units first, and net is the difference of what is written', () => {
    expect(figures(strip(1000.4, 1000.6, 'JPY')).map(([, v]) => v)).toEqual(['+¥1,000', '-¥1,001', '-¥1']);
    // Under half a yen either way: nothing, in no color.
    expect(figures(strip(0.4, 0.3, 'JPY'))).toEqual([
      ['summary-value inflow', '¥0'],
      ['summary-value', '¥0'],
      ['summary-value', '¥0'],
    ]);
  });

  test('amounts hidden: each figure masked, its sign kept', () => {
    // As in a browser's page, where alone amounts can be hidden.
    const g = globalThis as Record<string, unknown>;
    const none = g.window === undefined;
    if (none) g.window = {};
    setAmountsHidden(true);
    try {
      const [[, a], [, b]] = figures(strip(1000, 4391.92));
      expect(a).toContain(MASK);
      expect(a).toContain('+');
      expect(b).toContain(MASK);
      expect(b).toContain('-');
      expect(strip(1000, 4391.92)).not.toContain('1,000');
    } finally {
      setAmountsHidden(false);
      if (none) delete g.window;
    }
  });
});

describe('its heading', () => {
  test('read alone when the bar names the month; shown when it is a longer span', () => {
    expect(strip(1, 1)).toContain('<h2 id="month-figures-title" class="visually-hidden">In and out, October 2026</h2>');
    const longer = strip(1, 1, 'USD', 'Aug to Oct 2026');
    expect(longer).toContain('<h2 id="month-figures-title" class="month-figures-caption"><span class="visually-hidden">In and out, </span>Aug to Oct 2026</h2>');
    expect(longer).not.toContain('In and out, October 2026');
  });
});

describe('while the sums are on their way', () => {
  test('the same strip, placeholders where the figures go, hidden from a screen reader', () => {
    const html = renderToStaticMarkup(<MonthFigures totals={null} title="In and out" />);
    expect(html).toStartWith('<section class="month-figures" aria-labelledby="month-figures-title" aria-hidden="true">');
    expect(html.match(/<span class="skeleton activity-skeleton-figure"><\/span>/g)).toHaveLength(3);
    for (const label of ['In', 'Out', 'Net']) expect(html).toContain(`<div class="total-label">${label}</div>`);
    // Loaded, it is read.
    expect(strip(1, 1)).not.toContain('aria-hidden');
  });
});
