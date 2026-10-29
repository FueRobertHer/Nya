import { afterEach, describe, expect, test } from 'bun:test';
import { centsRuns, formatMoney, MASK, moneyRuns, setAmountsHidden } from '@/lib/format';

// An amount in runs, its cents marked (lib/format.ts moneyRuns, look and feel
// step 3): what Home's net worth draws at half size. The runs always join to
// formatMoney's text, whichever of its ways wrote it.

afterEach(() => setAmountsHidden(false));

const parts = (locale: string, currency: string, n: number) => new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(n);
const cents = (runs: { text: string; cents: boolean }[]) => runs.filter((r) => r.cents).map((r) => r.text);

describe('the cents of an amount', () => {
  test('wherever the locale puts them, and none where the currency has none', () => {
    expect(centsRuns(parts('en-US', 'USD', -1234.5))).toEqual([
      { text: '-$1,234', cents: false },
      { text: '.50', cents: true },
    ]);
    // The symbol after the figure, and a comma for the decimal separator.
    const de = centsRuns(parts('de-DE', 'EUR', 1234.56));
    expect(cents(de)).toEqual([',56']);
    expect(de.map((r) => r.text).join('')).toBe(new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(1234.56));
    expect(de[de.length - 1].cents).toBe(false);
    expect(cents(centsRuns(parts('ja-JP', 'JPY', 1234)))).toEqual([]);
  });

  test('join to formatMoney’s text, by each of its ways', () => {
    // Written apart from lib/format.ts, as formatMoney wrote each way before
    // it was made of runs: Intl for a currency it takes, the figures and the
    // code after them for one it refuses, a "$" by hand for none.
    const figures = (n: number) => Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const expected = (n: number, currency: string | null | undefined) => {
      if (!currency) return `${n < 0 ? '−$' : '$'}${figures(n)}`;
      if (currency === 'DOGE' || currency === 'USDC') return `${n < 0 ? '-' : ''}${figures(n)} ${currency}`;
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
    };
    for (const currency of ['USD', 'EUR', 'JPY', 'BHD', null, undefined, 'DOGE', 'USDC']) {
      for (const n of [0, -0, 0.004, -0.004, 0.5, -1234.5, 125000.5, -154328.3]) {
        const runs = moneyRuns(n, currency);
        expect([currency, n, runs.map((r) => r.text).join('')]).toEqual([currency, n, expected(n, currency)]);
        expect([currency, n, formatMoney(n, currency)]).toEqual([currency, n, expected(n, currency)]);
      }
    }
    // No currency, as net worth has: "$" by hand, its cents apart.
    expect(cents(moneyRuns(125000.5, null))).toEqual([`${(0.5).toLocaleString(undefined, { minimumFractionDigits: 2 }).slice(1)}`]);
    // A code Intl refuses: its cents apart, the code after them.
    const doge = moneyRuns(-12.5, 'DOGE');
    expect(doge[doge.length - 1]).toEqual({ text: ' DOGE', cents: false });
    expect(cents(doge)).toHaveLength(1);
  });

  test('while amounts are hidden, one run, the mask, with no cents', () => {
    const g = globalThis as Record<string, unknown>;
    const none = g.window === undefined;
    if (none) g.window = {};
    try {
      setAmountsHidden(true);
      const runs = moneyRuns(125000.5, 'USD');
      expect(runs).toHaveLength(1);
      expect(runs[0].cents).toBe(false);
      expect(runs[0].text).toContain(MASK);
      expect(runs[0].text).toBe(formatMoney(125000.5, 'USD'));
    } finally {
      setAmountsHidden(false);
      if (none) delete g.window;
    }
  });
});
