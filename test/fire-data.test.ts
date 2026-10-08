import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bondReturn,
  deriveMonth,
  deriveSeries,
  isComplete,
  nextMonth,
  realReturn,
  stockReturn,
  type ShillerMonth,
} from '@/lib/fire/derive';
import { BONDS_REAL, HISTORY_FIRST_MONTH, HISTORY_MONTHS, HISTORY_SCALE, INFLATION, STOCKS_REAL } from '@/lib/fire/history-data';
import { compound, makeMarket, monthIndex, monthLabel, yearFactors } from '@/lib/fire/market';
import { usMarket } from '@/lib/fire/us-market';
import { buildModule, parseShillerCsv } from '@/scripts/fire-data';

const row = (month: string, price: number, dividend: number, cpi: number, longRate: number): ShillerMonth => ({
  month,
  price,
  dividend,
  cpi,
  longRate,
});

describe('the derivations', () => {
  test('stock total return is the price change plus a twelfth of the annualized dividend', () => {
    // 100 -> 101 with a $6 yearly dividend: 1% from price, 0.5% from the month's dividend.
    expect(stockReturn(row('2000-01', 100, 6, 1, 5), row('2000-02', 101, 6, 1, 5))).toBeCloseTo(0.015, 12);
  });

  test('a bond whose yield does not move earns a month of its coupon', () => {
    expect(bondReturn(5, 5)).toBeCloseTo(0.05 / 12, 12);
  });

  test('a rising yield is a capital loss about the size of a 10-year bond’s duration', () => {
    // From 5% to 6%: about -7% in price, plus the month's coupon.
    const r = bondReturn(5, 6);
    expect(r).toBeLessThan(-0.065);
    expect(r).toBeGreaterThan(-0.075);
    // Worked by hand: (0.05/0.06)(1 - 1.06^-9.9167) + 1.06^-9.9167 - 1 + 0.05/12.
    const n = 10 - 1 / 12;
    const price = (0.05 / 0.06) * (1 - 1.06 ** -n) + 1.06 ** -n;
    expect(r).toBeCloseTo(price - 1 + 0.05 / 12, 12);
    // And a fall is a gain larger than the loss of the same move up (convexity).
    expect(bondReturn(6, 5)).toBeGreaterThan(-bondReturn(5, 6));
  });

  test('a zero yield prices every remaining coupon undiscounted, without dividing by zero', () => {
    expect(bondReturn(1, 0)).toBeCloseTo(0.01 * (10 - 1 / 12) + 0.01 / 12, 12);
    expect(Number.isFinite(bondReturn(0, 0))).toBe(true);
    expect(bondReturn(0, 0)).toBe(0);
  });

  test('a return that only keeps up with inflation is worth nothing in real terms', () => {
    expect(realReturn(0.01, 0.01)).toBe(0);
    expect(realReturn(0.05, 0.02)).toBeCloseTo(1.05 / 1.02 - 1, 15);
    // Deflation raises a flat return's real value.
    expect(realReturn(0, -0.02)).toBeGreaterThan(0);
  });

  test('one month: stocks and bonds deflated by the month’s inflation', () => {
    const d = deriveMonth(row('1950-01', 100, 6, 100, 4), row('1950-02', 102, 6, 101, 4));
    expect(d.month).toBe('1950-01');
    expect(d.inflation).toBeCloseTo(0.01, 15);
    expect(d.stocksReal).toBeCloseTo((102 + 0.5) / 100 / 1.01 - 1, 15);
    expect(d.bondsReal).toBeCloseTo((1 + 0.04 / 12) / 1.01 - 1, 15);
  });

  test('a series refuses a gap, a repeated month or an incomplete row, which would shift every later date', () => {
    const a = row('1900-01', 10, 1, 10, 4);
    const b = row('1900-02', 10, 1, 10, 4);
    const c = row('1900-03', 10, 1, 10, 4);
    expect(deriveSeries([a, b, c])).toHaveLength(2);
    expect(() => deriveSeries([a, c])).toThrow(/not consecutive/);
    expect(() => deriveSeries([a, a])).toThrow(/not consecutive/);
    expect(() => deriveSeries([a, { ...b, dividend: 0 }])).toThrow(/incomplete/);
    expect(() => deriveSeries([a])).toThrow(/two months/);
    expect(nextMonth('1999-12')).toBe('2000-01');
    expect(isComplete(row('2023-07', 4500, 0, 305, 3.9))).toBe(false);
  });
});

describe('the generator', () => {
  const csv = [
    'Date,SP500,Dividend,Earnings,Consumer Price Index,Long Interest Rate,Real Price,Real Dividend,Real Earnings,PE10',
    '1871-01-01,4.44,0.26,0.4,12.46,5.32,109.05,6.39,9.82,0.0',
    '1871-02-01,4.5,0.26,0.4,12.84,5.32,107.25,6.2,9.53,0.0',
    '1871-03-01,4.61,0.26,0.4,13.03,5.33,108.27,6.11,9.39,0.0',
    '2023-07-01,4508.0755,0.0,0.0,305.69,3.9,4514.51,0.0,0.0,30.89',
    '2023-08-01,4457.36,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0',
  ].join('\n');

  test('reads the leading run of complete months and stops at the first incomplete one', () => {
    const { rows, usedLines } = parseShillerCsv(csv);
    expect(rows.map((r) => r.month)).toEqual(['1871-01', '1871-02', '1871-03']);
    expect(usedLines).toHaveLength(4); // the header and three rows
  });

  test('refuses a file where complete rows start again after the data ended', () => {
    const resumed = `${csv}\n2023-09-01,4515.77,60.0,180.0,306.13,4.09,4515.77,0.0,0.0,30.81`;
    expect(() => parseShillerCsv(resumed)).toThrow(/start again/);
  });

  test('refuses a file without a column it needs', () => {
    expect(() => parseShillerCsv(csv.replace('Long Interest Rate', 'Rate'))).toThrow(/Long Interest Rate/);
  });

  test('writes each series in millionths, one line per year, and names its input', () => {
    const text = buildModule(csv, { url: 'https://example.test/data.csv', sha256: 'abc' });
    expect(text).toContain("export const HISTORY_FIRST_MONTH = '1871-01';");
    expect(text).toContain('export const HISTORY_MONTHS = 2;');
    expect(text).toContain('Input: https://example.test/data.csv');
    const [jan, feb] = deriveSeries(parseShillerCsv(csv).rows);
    expect(text).toContain(
      `export const STOCKS_REAL: readonly number[] = [\n  /* 1871 */ ${Math.round(jan.stocksReal * 1e6)}, ${Math.round(feb.stocksReal * 1e6)},\n];`
    );
  });
});

describe('the checked-in history', () => {
  const market = usMarket();
  const at = (month: string) => {
    const i = monthIndex(market, month);
    if (i < 0) throw new Error(`no ${month}`);
    return i;
  };

  test('covers every month from January 1871 to May 2023, the last month whose return Shiller’s June 2023 row completes', () => {
    expect(HISTORY_FIRST_MONTH).toBe('1871-01');
    expect(HISTORY_MONTHS).toBe(152 * 12 + 5);
    expect(monthLabel(market, 0)).toBe('1871-01');
    expect(monthLabel(market, market.months - 1)).toBe('2023-05');
    expect(monthIndex(market, '2023-06')).toBe(-1);
  });

  test('the three series are aligned and complete: one whole number per month each', () => {
    for (const s of [STOCKS_REAL, BONDS_REAL, INFLATION]) {
      expect(s).toHaveLength(HISTORY_MONTHS);
      expect(s.every((v) => Number.isInteger(v) && v > -HISTORY_SCALE)).toBe(true);
    }
    // Twelve values to a line, labelled with the right year: a dropped value
    // anywhere would shift a year's label off its months.
    const src = readFileSync(join(import.meta.dir, '..', 'lib', 'fire', 'history-data.ts'), 'utf8');
    for (const name of ['STOCKS_REAL', 'BONDS_REAL', 'INFLATION']) {
      const body = src.split(`export const ${name}`)[1].split('];')[0];
      const lines = [...body.matchAll(/\/\* (\d{4}) \*\/ ([^\n]*)/g)];
      expect(lines).toHaveLength(153);
      lines.forEach((m, i) => {
        expect(Number(m[1])).toBe(1871 + i);
        expect(m[2].split(',').filter((v) => v.trim() !== '')).toHaveLength(i === 152 ? 5 : 12);
      });
    }
  });

  test('matches the derivations on rows copied from the source by hand', () => {
    // 1932-07-01,5.01,0.6333,...,13.6,3.5 and 1932-08-01,7.53,0.6067,...,13.5,3.46:
    // the summer 1932 rally, the largest monthly gain in the data.
    const jul = row('1932-07', 5.01, 0.6333, 13.6, 3.5);
    const aug = row('1932-08', 7.53, 0.6067, 13.5, 3.46);
    const d = deriveMonth(jul, aug);
    const i = at('1932-07');
    expect(STOCKS_REAL[i]).toBe(Math.round(d.stocksReal * 1e6));
    expect(BONDS_REAL[i]).toBe(Math.round(d.bondsReal * 1e6));
    expect(INFLATION[i]).toBe(Math.round(d.inflation * 1e6));
    // 1981-09-01,118.3,6.52,...,93.2,15.32 and 1981-10-01,119.8,6.55667,...,93.4,15.15:
    // the peak of long-term yields.
    const sep = row('1981-09', 118.3, 6.52, 93.2, 15.32);
    const oct = row('1981-10', 119.8, 6.55667, 93.4, 15.15);
    expect(BONDS_REAL[at('1981-09')]).toBe(Math.round(deriveMonth(sep, oct).bondsReal * 1e6));
    expect(STOCKS_REAL[at('1981-09')]).toBe(Math.round(deriveMonth(sep, oct).stocksReal * 1e6));
  });

  test('the 1929 to 1932 crash: stocks lost about three quarters of their real value', () => {
    // The index's monthly average fell 85%, from 31.30 in September 1929 to 4.77
    // in June 1932. Dividends and 21% deflation over the same months soften the
    // real total return to about -77%.
    const real = compound(market.stocks, at('1929-09'), at('1932-06')) - 1;
    expect(real).toBeGreaterThan(-0.8);
    expect(real).toBeLessThan(-0.72);
    const prices = compound(market.inflation, at('1929-09'), at('1932-06')) - 1;
    expect(prices).toBeLessThan(-0.18);
    expect(prices).toBeGreaterThan(-0.25);
    // October 1929 is the worst single month.
    let worst = 0;
    for (let i = 1; i < market.months; i++) if (market.stocks[i] < market.stocks[worst]) worst = i;
    expect(monthLabel(market, worst)).toBe('1929-10');
  });

  test('1970s inflation: prices doubled, and bonds lost value in real terms', () => {
    // CPI-U was 37.8 in January 1970 and 77.8 in January 1980. Stored in
    // millionths, 120 months compound back to within a few millionths of that.
    const prices = compound(market.inflation, at('1970-01'), at('1980-01'));
    expect(prices).toBeCloseTo(77.8 / 37.8, 4);
    const bonds = compound(market.bonds, at('1970-01'), at('1980-01')) - 1;
    expect(bonds).toBeLessThan(-0.1);
    // Then the yield peak of 1981 began the bond bull market.
    expect(compound(market.bonds, at('1981-10'), at('1991-10')) - 1).toBeGreaterThan(1);
    // Stocks went nowhere in real terms from 1966 to 1982, dividends included.
    expect(compound(market.stocks, at('1966-01'), at('1982-08'))).toBeLessThan(0.8);
  });

  test('long-run averages are in the range this data is known for', () => {
    const cagr = (s: Float64Array) => compound(s, 0, market.months) ** (12 / market.months) - 1;
    // About 6.9% a year real for stocks, 2.5% for bonds, 2.1% inflation.
    expect(cagr(market.stocks)).toBeGreaterThan(0.065);
    expect(cagr(market.stocks)).toBeLessThan(0.072);
    expect(cagr(market.bonds)).toBeGreaterThan(0.02);
    expect(cagr(market.bonds)).toBeLessThan(0.03);
    expect(cagr(market.inflation)).toBeGreaterThan(0.018);
    expect(cagr(market.inflation)).toBeLessThan(0.025);
  });
});

describe('markets', () => {
  test('refuse series of different lengths or impossible values', () => {
    const ok = new Array(12).fill(0);
    expect(() => makeMarket('2000-01', ok, ok.slice(1), ok)).toThrow(/length/);
    expect(() => makeMarket('2000-01', [...ok.slice(1), NaN], ok, ok)).toThrow(/stocks\[11\]/);
    expect(() => makeMarket('2000-01', ok, [...ok.slice(1), -1], ok)).toThrow(/bonds\[11\]/);
    expect(() => makeMarket('2000-13', ok, ok, ok)).toThrow(/first month/);
    expect(() => makeMarket('2000-01', [0], [0], [0])).toThrow(/a year/);
  });

  test('label months across year ends', () => {
    const m = makeMarket('1999-11', new Array(14).fill(0), new Array(14).fill(0), new Array(14).fill(0));
    expect(monthLabel(m, 0)).toBe('1999-11');
    expect(monthLabel(m, 2)).toBe('2000-01');
    expect(monthIndex(m, '2000-12')).toBe(13);
    expect(monthIndex(m, '2001-01')).toBe(-1);
    expect(monthIndex(m, '1999-10')).toBe(-1);
  });

  test('year factors compound twelve months, wrapping round the end', () => {
    const r = Array.from({ length: 24 }, (_, i) => (i === 23 ? 0.1 : 0));
    const f = yearFactors(24, (i) => r[i]);
    expect(f[0]).toBe(1);
    expect(f[12]).toBeCloseTo(1.1, 15); // months 12..23
    expect(f[20]).toBeCloseTo(1.1, 15); // months 20..23, then 0..7
    expect(f[23]).toBeCloseTo(1.1, 15);
  });
});
