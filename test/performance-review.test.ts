// What importing a Vanguard Performance page would bring in
// (lib/import/performance-review.ts): the months as read, with any the person
// corrected, checked again; and whether the file is the account's, by its
// balances. On made-up months (test/vanguard-performance-pdf.ts) put into
// the reader's result by hand, so each check can be broken on its own.

import { describe, expect, test } from 'bun:test';
import { accountCheck, reviewMonths, type TypedMonth } from '@/lib/import/performance-review';
import { readSigned } from '@/components/PerformanceImport';
import { nextMonth } from '@/lib/investment-months';
import { makeMonths, type MonthFigures } from './vanguard-performance-pdf';
import { readOf, RANGE } from './performance-read';

const MONTHS = makeMonths(RANGE.from, RANGE.to);

const typedOf = (m: MonthFigures, over: Partial<TypedMonth> = {}): TypedMonth => ({ net: m.net, returns: m.returns, end: m.end, ...over });

describe('reviewMonths', () => {
  test('a file that adds up: its whole months, from the first one’s beginning balance', () => {
    const r = reviewMonths(readOf(MONTHS), {});
    expect(r.failing).toEqual([]);
    expect(r.totals_ok).toBe(true);
    // Nov 2026 runs to the 5th only.
    expect(r.left_out).toEqual(['2026-11']);
    expect(r.importable!.start).toEqual({ month: '2024-01', balance: 0 });
    expect(r.importable!.months.length).toBe(34);
    expect(r.importable!.months[0]).toEqual({ month: '2024-01', net: MONTHS[0].net / 100, returns: MONTHS[0].returns / 100, end: MONTHS[0].end / 100 });
    expect(r.importable!.typed).toEqual([]);
  });

  test('a range that starts after a month’s 1st leaves that month out, and starts at the next', () => {
    const r = reviewMonths(readOf(MONTHS, { range: { from: '2024-01-15', to: RANGE.to } }), {});
    expect(r.left_out).toEqual(['2024-01', '2026-11']);
    expect(r.importable!.start).toEqual({ month: '2024-02', balance: MONTHS[1].begin / 100 });
  });

  test('a month whose ending balance was read wrong fails, and the one after it, until it is typed', () => {
    const k = 10;
    const bad = MONTHS[k];
    const read = readOf(MONTHS, { figures: { [bad.month]: { end: bad.end + 9_000 } }, failed: { [bad.month]: ['adds-up'], [MONTHS[k + 1].month]: ['begins-at-last-end'] } });
    const before = reviewMonths(read, {});
    expect(before.failing.map((m) => m.month)).toEqual([bad.month, MONTHS[k + 1].month]);
    expect(before.importable).toBeNull();
    // Its fields begin at what was read.
    expect(before.failing[0].read.end).toBe(bad.end + 9_000);

    const after = reviewMonths(read, { [bad.month]: typedOf(bad) });
    expect(after.failing).toEqual([]);
    expect(after.totals_ok).toBe(true);
    expect(after.importable!.typed).toEqual([bad.month]);
    expect(after.importable!.months[k].end).toBe(bad.end / 100);
  });

  test('a typed month has only to add up, but the page’s total must still match', () => {
    const k = 3;
    const m = MONTHS[k];
    const read = readOf(MONTHS, { failed: { [m.month]: ['returns'] } });
    // Moved between deposits and returns: it adds up, and the total doesn't.
    const r = reviewMonths(read, { [m.month]: typedOf(m, { net: m.net + 500, returns: m.returns - 500 }) });
    expect(r.failing).toEqual([]);
    expect(r.totals_ok).toBe(false);
    expect(r.importable).toBeNull();
  });

  test('a typed month that doesn’t add up, or a field that isn’t an amount, still fails', () => {
    const m = MONTHS[5];
    expect(reviewMonths(readOf(MONTHS), { [m.month]: typedOf(m, { end: m.end + 1 }) }).failing.map((x) => x.month)).toEqual([m.month, MONTHS[6].month]);
    expect(reviewMonths(readOf(MONTHS), { [m.month]: typedOf(m, { net: null }) }).failing[0].month).toBe(m.month);
  });

  test('a market figure not found: the month waits for the person’s figures, then the total’s market column is let go', () => {
    const m = MONTHS[7];
    const read = { ...readOf(MONTHS, { figures: { [m.month]: { market: null } }, failed: { [m.month]: ['cells'] } }), total_differs: ['market' as const] };
    expect(reviewMonths(read, {}).failing.map((x) => x.month)).toEqual([m.month]);
    const r = reviewMonths(read, { [m.month]: typedOf(m) });
    expect(r.failing).toEqual([]);
    expect(r.totals_ok).toBe(true);
    expect(r.importable).not.toBeNull();
  });

  test('a market column off with no month in doubt is never let go', () => {
    const read = { ...readOf(MONTHS), total_differs: ['market' as const] };
    expect(reviewMonths(read, {}).totals_ok).toBe(false);
  });

  test('cumulative returns read wrong fail that month alone', () => {
    const m = MONTHS[12];
    const r = reviewMonths(readOf(MONTHS, { figures: { [m.month]: { cumulative: m.cumulative + 100 } } }), {});
    expect(r.failing.map((x) => x.month)).toEqual([m.month]);
  });

  test('returns read wrong (their month not adding up) fail that month alone, and typing them fixes it', () => {
    const m = MONTHS[12];
    const read = readOf(MONTHS, { figures: { [m.month]: { returns: m.returns + 100 } } });
    expect(reviewMonths(read, {}).failing.map((x) => x.month)).toEqual([m.month]);
    const r = reviewMonths(read, { [m.month]: typedOf(m) });
    expect(r.failing).toEqual([]);
    expect(r.importable).not.toBeNull();
  });

  test('no whole month: nothing to import', () => {
    const one = makeMonths('2026-11-01', '2026-11-05');
    const r = reviewMonths(readOf(one, { range: { from: '2026-11-01', to: '2026-11-05' } }), {});
    expect(r.failing).toEqual([]);
    expect(r.importable).toBeNull();
    expect(r.left_out).toEqual(['2026-11']);
  });
});

describe('accountCheck', () => {
  const importable = reviewMonths(readOf(MONTHS), {}).importable!;
  const lastEnd = MONTHS[MONTHS.length - 1].end / 100;
  /** Nya's recorded balances: each month's end on the next 1st, from Jul 2026,
   *  scaled by `f`. */
  const points = (f = 1) =>
    MONTHS.filter((m) => m.month >= '2026-06' && m.month <= '2026-10').map((m) => ({ date: `${nextMonth(m.month)}-01`, value: Math.round((m.end / 100) * f * 100) / 100 }));
  const base = { last: { day: RANGE.to, balance: lastEnd }, months: importable.months, today: '2026-11-06' };

  test('balances within 2% of Nya’s: the account’s, said on the file’s last day', () => {
    expect(accountCheck({ ...base, points: points(1.01), balance: lastEnd, vanguard: [lastEnd] })).toEqual({ kind: 'matches', day: RANGE.to, balance: lastEnd });
  });

  test('balances more than 2% off: maybe another account’s', () => {
    const c = accountCheck({ ...base, points: points(0.5), balance: lastEnd * 0.5, vanguard: [lastEnd * 0.5, lastEnd * 0.2] });
    expect(c!.kind).toBe('another');
    expect(c).toMatchObject({ day: RANGE.to, balance: lastEnd, account: lastEnd * 0.5 });
  });

  test('a last balance that is every Vanguard account’s together: all of them', () => {
    const c = accountCheck({ ...base, points: null, balance: lastEnd * 0.3, vanguard: [lastEnd * 0.3, lastEnd * 0.7] });
    expect(c).toEqual({ kind: 'all-accounts', day: RANGE.to, balance: lastEnd, together: lastEnd, account: lastEnd * 0.3 });
  });

  test('one Vanguard account alone is never all of them', () => {
    expect(accountCheck({ ...base, points: null, balance: lastEnd, vanguard: [lastEnd] })!.kind).toBe('matches');
  });

  test('a file that ended weeks ago isn’t compared with the balance now', () => {
    const c = accountCheck({ ...base, today: '2026-12-20', points: null, balance: lastEnd * 2, vanguard: [lastEnd, lastEnd] });
    expect(c).toBeNull();
  });

  test('nothing to compare: no answer', () => {
    expect(accountCheck({ ...base, points: null, balance: null, vanguard: [] })).toBeNull();
  });
});

describe('readSigned', () => {
  test('reads a typed amount with its sign, in cents', () => {
    expect(readSigned('+1,000.00')).toBe(100_000);
    expect(readSigned('−250')).toBe(-25_000);
    expect(readSigned('-$3.10')).toBe(-310);
    expect(readSigned('$12.50')).toBe(1250);
    expect(readSigned(' 7 ')).toBe(700);
    expect(readSigned('')).toBeNull();
    expect(readSigned('ten')).toBeNull();
  });
});
