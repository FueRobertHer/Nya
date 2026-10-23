import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDecimal, roundTo, tidyTo, div, mul } from '@/lib/fx/decimal';
import { convert, displayRate, ecbRate, isStale, precisionOf, rateOn, NO_FX, type FxTable, type OwnRate } from '@/lib/fx/rates';
import { fieldsFor, tableFromFields, yearsFor, isEcbValue } from '@/lib/fx/fields';
import { parseEcbCsv, planWrites, type EcbFile } from '@/lib/fx/ecb-parse';

// The ECB's own rows (eurofxref-hist.zip as of 14 Sep 2026), cut to the days
// these tests need: the rouble's last days, the shekel's first, New Year
// 2025/2026, Easter 2026, and the first half of September 2026.
const CSV = readFileSync(join(import.meta.dir, 'fixtures/ecb/eurofxref-hist-cut.csv'), 'utf8');
const FILE = parseEcbCsv(CSV) as EcbFile;

/** Every field the file would write into an empty store. */
function allFields(file: EcbFile): Map<string, unknown> {
  const plan = planWrites(file, { days: new Map(), latest: null }, { current: '2026' });
  const out = new Map<string, unknown>();
  for (const step of plan.years) for (const [k, v] of step.fields) out.set(k, v);
  return out;
}
const FIELDS = allFields(FILE);
const YEARS = ['1999', '2010', '2011', '2021', '2022', '2025', '2026'];

/** A table as a reader would hold it, without the newest publication unless
 *  asked, so a day's own rate is looked up through the calendar. */
function table(opts: { home?: string | null; own?: OwnRate[]; latest?: boolean; fields?: Map<string, unknown>; years?: string[] } = {}): FxTable {
  const fields = new Map(opts.fields ?? FIELDS);
  if (!opts.latest) fields.delete('latest');
  return tableFromFields(fields, opts.years ?? YEARS, opts.home ?? 'EUR', opts.own ?? []);
}

const own = (o: Partial<OwnRate> & Pick<OwnRate, 'currency' | 'rate' | 'quote'>): OwnRate => ({ from: null, set_at: '2026-09-01T00:00:00.000Z', ...o });

describe('exact decimals', () => {
  test('read as written, exponent forms included, and nothing else', () => {
    expect(parseDecimal('19.99')).toEqual({ n: 1999n, d: 100n });
    expect(parseDecimal(19.99)).toEqual({ n: 1999n, d: 100n });
    expect(parseDecimal(1e-8)).toEqual({ n: 1n, d: 100000000n });
    expect(parseDecimal('1e-8')).toEqual({ n: 1n, d: 100000000n });
    expect(parseDecimal(1e21)).toEqual({ n: 10n ** 21n, d: 1n });
    expect(parseDecimal('-0.5')).toEqual({ n: -5n, d: 10n });
    for (const bad of ['1,5', '', '0x10', '1.2.3', ' 1', '1e', '.5', 'NaN']) expect(parseDecimal(bad)).toBeNull();
    for (const bad of [NaN, Infinity, -Infinity]) expect(parseDecimal(bad)).toBeNull();
  });

  test('rounded once, half away from zero, never -0', () => {
    expect(roundTo({ n: 10005n, d: 1000n }, 2)).toBe(10.01);
    expect(roundTo({ n: -10005n, d: 1000n }, 2)).toBe(-10.01);
    expect(roundTo({ n: 10004n, d: 1000n }, 2)).toBe(10);
    expect(roundTo({ n: -1n, d: 1000n }, 2)).toBe(0);
    expect(Object.is(roundTo({ n: -1n, d: 1000n }, 2), -0)).toBe(false);
    expect(roundTo({ n: 178525n, d: 10n }, 0)).toBe(17853);
    expect(roundTo({ n: 1n, d: 3n }, 8)).toBe(0.33333333);
  });

  test('a float sum is tidied to the decimal it adds up to before it converts', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(tidyTo(0.1 + 0.2, 2)).toEqual({ n: 30n, d: 100n });
    expect(tidyTo(-(0.1 + 0.2), 2)).toEqual({ n: -30n, d: 100n });
  });

  test('doubles get the exact half wrong; this does not', () => {
    // €10.00 at 1.0005 dollars per euro is exactly $10.005.
    const doubles = (Math.sign(10 * 1.0005) * Math.round(Math.abs(10 * 1.0005) * 100)) / 100;
    expect(doubles).toBe(10);
    expect(roundTo(mul(parseDecimal(10)!, parseDecimal('1.0005')!), 2)).toBe(10.01);
    expect(roundTo(div(parseDecimal(1)!, parseDecimal(3)!), 2)).toBe(0.33);
  });
});

describe('the ECB calendar', () => {
  test('a day takes its own publication', () => {
    const r = ecbRate(table(), 'USD', '2026-09-14');
    expect(r).toMatchObject({ ok: true, day: '2026-09-14', source: 'ecb' });
    if (r.ok) expect(r.per_eur).toEqual({ n: 11551n, d: 10000n });
  });

  test('a weekend takes the Friday before it', () => {
    expect(ecbRate(table(), 'USD', '2026-09-12')).toMatchObject({ ok: true, day: '2026-09-11' });
    expect(ecbRate(table(), 'USD', '2026-09-13')).toMatchObject({ ok: true, day: '2026-09-11' });
  });

  test("Good Friday to Easter Monday take Thursday's: the longest gap the ECB leaves", () => {
    for (const d of ['2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06']) expect(ecbRate(table(), 'USD', d)).toMatchObject({ ok: true, day: '2026-04-02' });
    expect(ecbRate(table(), 'USD', '2026-04-07')).toMatchObject({ ok: true, day: '2026-04-07' });
  });

  test("New Year's Day takes the year before's last publication, which a reader reads too", () => {
    expect(yearsFor('2026-01-01', '2026-01-31')).toEqual(['2025', '2026']);
    expect(yearsFor('2026-01-08', '2026-03-01')).toEqual(['2026']);
    expect(ecbRate(table(), 'USD', '2026-01-01')).toMatchObject({ ok: true, day: '2025-12-31' });
    // Without the year before's calendar it is a rate Nya doesn't have, never a guess.
    expect(ecbRate(table({ years: ['2026'] }), 'USD', '2026-01-01')).toEqual({ ok: false, why: 'not-fetched' });
  });

  test('a currency the ECB stopped publishing is never carried forward', () => {
    expect(ecbRate(table(), 'RUB', '2022-03-01')).toMatchObject({ ok: true, day: '2022-03-01' });
    expect(ecbRate(table(), 'RUB', '2022-03-02')).toEqual({ ok: false, why: 'not-published' });
    expect(ecbRate(table(), 'RUB', '2022-03-05')).toEqual({ ok: false, why: 'not-published' });
    // The lev left with the 2 January 2026 publication.
    expect(ecbRate(table(), 'BGN', '2025-12-31')).toMatchObject({ ok: true });
    expect(ecbRate(table(), 'BGN', '2026-01-02')).toEqual({ ok: false, why: 'not-published' });
  });

  test("before a currency's first publication, and before the ECB's first, there is none", () => {
    expect(ecbRate(table(), 'ILS', '2010-12-31')).toEqual({ ok: false, why: 'not-published' });
    expect(ecbRate(table(), 'ILS', '2011-01-03')).toMatchObject({ ok: true });
    expect(ecbRate(table(), 'USD', '1999-01-03')).toEqual({ ok: false, why: 'before' });
    expect(ecbRate(table(), 'USD', '1999-01-04')).toMatchObject({ ok: true });
  });

  test('a stretch past the ECB’s own calendar is rates Nya hasn’t fetched', () => {
    // The fixture holds 2022 only from late February to 8 March.
    expect(ecbRate(table(), 'USD', '2022-06-01')).toEqual({ ok: false, why: 'not-fetched' });
    // A year with no calendar at all.
    expect(ecbRate(table(), 'USD', '2015-06-01')).toEqual({ ok: false, why: 'not-fetched' });
    expect(ecbRate(NO_FX, 'USD', '2026-09-14')).toEqual({ ok: false, why: 'not-fetched' });
  });

  test('a day after the newest publication takes it, and the euro is always 1', () => {
    const t = table({ latest: true });
    expect(t.latest?.date).toBe('2026-09-14');
    expect(ecbRate(t, 'GBP', '2026-10-17')).toMatchObject({ ok: true, day: '2026-09-14' });
    expect(ecbRate(t, 'BGN', '2026-10-17')).toEqual({ ok: false, why: 'not-published' });
    expect(ecbRate(t, 'EUR', '1980-01-01')).toMatchObject({ ok: true, source: 'euro' });
  });
});

describe('converting', () => {
  // Section 2.6 of the design, with the ECB's rates of 14 and 11 Sep 2026.
  test.each([
    [19.99, 'USD', 'EUR', '2026-09-14', 17.31],
    [19.99, 'USD', 'GBP', '2026-09-14', 14.81],
    [3200, 'JPY', 'USD', '2026-09-14', 20.71],
    [100, 'EUR', 'JPY', '2026-09-14', 17852],
    [19.99, 'USD', 'EUR', '2026-09-12', 17.24],
    [-19.99, 'USD', 'EUR', '2026-09-14', -17.31],
  ])('%p %s in %s on %s is %p', (amount, from, to, day, expected) => {
    const c = convert(table(), amount, from, to, day);
    expect(c.ok && c.amount).toBe(expected);
  });

  test('through the euro both ways, rounded once each way', () => {
    const there = convert(table(), 100, 'GBP', 'USD', '2026-09-14');
    const back = convert(table(), 100, 'USD', 'GBP', '2026-09-14');
    // 100 × 1.1551 / 0.85598 = 134.944... and 100 × 0.85598 / 1.1551 = 74.104...
    expect(there.ok && there.amount).toBe(134.94);
    expect(back.ok && back.amount).toBe(74.1);
  });

  test('an amount in its own currency is itself, and needs no rate', () => {
    expect(convert(NO_FX, 12.345, 'ARS', 'ARS', '2026-09-14')).toMatchObject({ ok: true, amount: 12.345 });
  });

  test('no rate is said, never guessed', () => {
    expect(convert(table(), 10, 'ARS', 'EUR', '2026-09-14')).toEqual({ ok: false, why: 'not-published', currency: 'ARS' });
    expect(convert(table(), 10, 'EUR', 'ARS', '2026-09-14')).toEqual({ ok: false, why: 'not-published', currency: 'ARS' });
  });

  test('a subtotal of floats converts as the decimal it adds up to', () => {
    const t = table();
    const sum = 0.1 + 0.2;
    const tidied = convert(t, sum, 'USD', 'EUR', '2026-09-14', { tidy: true });
    const exact = convert(t, 0.3, 'USD', 'EUR', '2026-09-14');
    expect(tidied.ok && tidied.amount).toBe(exact.ok ? exact.amount : NaN);
  });

  test('each currency to its own precision', () => {
    expect(precisionOf('USD')).toBe(2);
    expect(precisionOf('JPY')).toBe(0);
    expect(precisionOf('KWD')).toBe(3);
    expect(precisionOf('BTC')).toBe(8);
    expect(precisionOf('DOGE')).toBe(8);
  });

  test('a rate to show, never used to convert', () => {
    const r = displayRate(table(), 'USD', 'EUR', '2026-09-14');
    expect(r).toMatchObject({ day: '2026-09-14', source: 'ecb' });
    expect(r!.value).toBeCloseTo(1 / 1.1551, 10);
    expect(displayRate(table(), 'USD', 'USD', '2026-09-14')).toBeNull();
  });
});

describe('the person’s own rate', () => {
  test('wins from its first day, not before', () => {
    const t = table({ own: [own({ currency: 'USD', rate: '0.90', quote: 'EUR', from: '2026-09-11' })] });
    const before = convert(t, 100, 'USD', 'EUR', '2026-09-10');
    const after = convert(t, 100, 'USD', 'EUR', '2026-09-11');
    expect(before.ok && before.amount).toBe(86.09); // the ECB's of 10 Sep: 100 / 1.1616
    expect(after).toMatchObject({ ok: true, amount: 90 });
    expect(after.ok && after.from.source).toBe('own');
  });

  test('works both ways', () => {
    const t = table({ own: [own({ currency: 'USD', rate: '0.90', quote: 'EUR' })] });
    expect(convert(t, 90, 'EUR', 'USD', '2026-09-14')).toMatchObject({ ok: true, amount: 100 });
  });

  test('a currency the ECB doesn’t publish, through the ECB’s rate for its quote', () => {
    // 1 BTC = 61,000 USD, and on 14 Sep 1 EUR = 1.1551 USD: 1 BTC = 52,809.3... EUR.
    const t = table({ own: [own({ currency: 'BTC', rate: '61000', quote: 'USD' })] });
    expect(convert(t, 1, 'BTC', 'EUR', '2026-09-14')).toMatchObject({ ok: true, amount: 52809.28 });
    // Dust, which String() writes in exponent form.
    expect(convert(t, 1e-8, 'BTC', 'USD', '2026-09-14')).toMatchObject({ ok: true, amount: 0 });
    expect(convert(t, 0.00012345, 'BTC', 'USD', '2026-09-14')).toMatchObject({ ok: true, amount: 7.53 });
    expect(convert(t, 100, 'USD', 'BTC', '2026-09-14')).toMatchObject({ ok: true, amount: 0.00163934 });
  });

  test('one hop: the quote is always the ECB’s, never another own rate', () => {
    const t = table({ own: [own({ currency: 'USD', rate: '0.90', quote: 'EUR' }), own({ currency: 'BTC', rate: '61000', quote: 'USD' })] });
    const viaEcb = table({ own: [own({ currency: 'BTC', rate: '61000', quote: 'USD' })] });
    expect(convert(t, 1, 'BTC', 'EUR', '2026-09-14')).toEqual(convert(viaEcb, 1, 'BTC', 'EUR', '2026-09-14'));
  });

  test('a home currency the ECB doesn’t publish converts with a rate for it', () => {
    const t = table({ home: 'ARS', own: [own({ currency: 'ARS', rate: '0.00071', quote: 'USD' })] });
    // 100 EUR = 115.51 USD = 115.51 / 0.00071 ARS.
    expect(convert(t, 100, 'EUR', 'ARS', '2026-09-14')).toMatchObject({ ok: true, amount: 162690.14 });
  });

  test('no rate for its quote, no rate', () => {
    const t = table({ latest: true, own: [own({ currency: 'XAF', rate: '100', quote: 'BGN' })] });
    expect(rateOn(t, 'XAF', '2026-09-14')).toEqual({ ok: false, why: 'quote' });
  });
});

describe('stale rates', () => {
  const at = (iso: string) => Date.parse(iso);
  const fx = (latest: string, lastOk: string | null) => ({
    latest: { date: latest, rates: { USD: '1.1' } },
    fetch: { at: lastOk ?? '2026-04-07T16:30:00.000Z', ok: lastOk !== null, newest: latest, last_ok: lastOk },
  });

  test('not on the fifth day of an Easter gap while the fetch works', () => {
    expect(isStale(fx('2026-04-02', '2026-04-06T16:30:00.000Z'), at('2026-04-07T09:00:00.000Z'))).toBe(false);
  });

  test('once the last fetch that worked is over 30 hours old', () => {
    expect(isStale(fx('2026-09-14', '2026-09-14T16:30:00.000Z'), at('2026-09-15T22:00:00.000Z'))).toBe(false);
    expect(isStale(fx('2026-09-14', '2026-09-14T16:30:00.000Z'), at('2026-09-15T23:31:00.000Z'))).toBe(true);
  });

  test('once the newest publication is over 5 days old, whatever the fetch says', () => {
    expect(isStale(fx('2026-09-08', '2026-09-14T16:30:00.000Z'), at('2026-09-14T17:00:00.000Z'))).toBe(true);
  });

  test('with no rates, or no record of a fetch that worked', () => {
    expect(isStale({ latest: null, fetch: null }, at('2026-09-14T17:00:00.000Z'))).toBe(true);
    expect(isStale(fx('2026-09-14', null), at('2026-09-14T17:00:00.000Z'))).toBe(true);
  });
});

describe('the fields', () => {
  test('a reader reads the calendar and series of each year it needs, the euro none', () => {
    expect(fieldsFor(['USD', 'EUR', 'GBP', 'USD', 'BTC'], ['2025', '2026'])).toEqual([
      'latest',
      'fetch',
      'days:2025',
      'days:2026',
      'GBP:2025',
      'GBP:2026',
      'USD:2025',
      'USD:2026',
    ]);
  });

  test('every value the file writes is one its field accepts, and nothing else is', () => {
    for (const [id, v] of FIELDS) expect([id, isEcbValue(v, id)]).toEqual([id, true]);
    expect(isEcbValue(['2026-01-02'], 'days:2025')).toBe(false);
    expect(isEcbValue({ '2026-01-02': '-1' }, 'USD:2026')).toBe(false);
    expect(isEcbValue({ '2026-01-02': '1,1' }, 'USD:2026')).toBe(false);
    expect(isEcbValue({ date: '2026-01-02', rates: {} }, 'latest')).toBe(false);
    expect(isEcbValue({ '2026-01-02': '1.1' }, 'usd:2026')).toBe(false);
  });

  test('a year asked for without a usable calendar is missing', () => {
    const fields = new Map(FIELDS);
    fields.set('days:2025', ['not a day']);
    const t = tableFromFields(fields, ['2025', '2026'], 'EUR', []);
    expect(t.missing_years).toEqual(['2025']);
    expect(ecbRate(t, 'USD', '2025-12-31')).toEqual({ ok: false, why: 'not-fetched' });
    expect(ecbRate(t, 'USD', '2026-01-05')).toMatchObject({ ok: true });
  });
});
