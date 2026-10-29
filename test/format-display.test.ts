import { describe, expect, test } from 'bun:test';
import { asciiMinus, compactMoney, formatDay, formatMoney, hiddenMoney, MASK, MINUS, signedMoney, spoken, trueMinus } from '@/lib/format';
import { wholeMoney } from '@/components/plan-text';

// Numbers, money and dates as the design system writes them on the screen
// (lib/format.ts): the true minus sign before the currency's symbol, one
// mask of four dots whatever the size, and days as "Today", "Yesterday",
// "Aug 7" or "Aug 7, 2025".

describe('the minus sign', () => {
  test('is the true minus (U+2212), before the currency symbol, in every formatter', () => {
    expect(MINUS).toBe('−');
    expect(formatMoney(-1240.5, 'USD')).toBe('−$1,240.50');
    expect(formatMoney(-1240.5)).toBe('−$1,240.50');
    expect(formatMoney(-12.5, 'DOGE')).toBe('−12.50 DOGE');
    expect(signedMoney(-3200, 'JPY')).toBe('−¥3,200');
    expect(signedMoney(-5, null)).toBe('−$5.00');
    expect(signedMoney(5, 'USD', { always: true })).toBe('+$5.00');
    expect(compactMoney(-1234, 'USD')).toBe('−$1.2K');
    expect(wholeMoney(-1240.6, 'USD')).toBe('−$1,241');
    for (const s of [formatMoney(-1, 'EUR'), signedMoney(-1, 'GBP'), compactMoney(-5_000_000), wholeMoney(-3, null)]) expect(s).not.toContain('-');
  });

  test('hidden, the sign stays and is the true minus too', () => {
    expect(hiddenMoney(-5, 'USD')).toBe(`−$${MASK}`);
    expect(hiddenMoney(-5, null)).toBe(`−$${MASK}`);
    expect(hiddenMoney(-5, 'DOGE')).toBe(`−${MASK} DOGE`);
  });

  test('what leaves Nya as data has the hyphen back; text written elsewhere takes the true one', () => {
    expect(asciiMinus(`Changed by ${formatMoney(-80, 'USD')} a month, and ${formatMoney(-12.5, 'DOGE')}.`)).toBe('Changed by -$80.00 a month, and -12.50 DOGE.');
    expect(asciiMinus('No amount here.')).toBe('No amount here.');
    expect(trueMinus('-$12.00')).toBe('−$12.00');
  });
});

describe('the mask', () => {
  test('is four dots, whatever the size', () => {
    expect(MASK).toBe('••••');
    for (const n of [1, 1_000, 1_000_000_000]) expect(hiddenMoney(n, 'USD')).toBe('$••••');
  });

  test('a screen reader hears "hidden" for each, whichever minus it carries', () => {
    expect(spoken(`Spent −$${MASK}, -$${MASK} and ${MASK} DOGE`)).toBe('Spent hidden, hidden and hidden');
  });
});

describe('a day', () => {
  // Noon on Thursday, October 29, 2026, in the person's own time zone.
  const now = new Date(2026, 9, 29, 12);

  test('"Today" and "Yesterday" in the person\'s time zone, then the day, with its year outside this one', () => {
    expect(formatDay('2026-10-29', { now })).toBe('Today');
    expect(formatDay('2026-10-28', { now })).toBe('Yesterday');
    expect(formatDay('2026-10-27', { now })).toBe(new Date(2026, 9, 27).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    expect(formatDay('2026-08-07', { now })).toBe(new Date(2026, 7, 7).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
    expect(formatDay('2025-08-07', { now })).toBe(new Date(2025, 7, 7).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
    expect(formatDay('2026-11-03', { now })).toBe(new Date(2026, 10, 3).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  });

  test('mid sentence in lower case; yesterday across a year is still yesterday', () => {
    expect(formatDay('2026-10-29', { now, sentence: true })).toBe('today');
    expect(formatDay('2026-10-28', { now, sentence: true })).toBe('yesterday');
    expect(formatDay('2025-12-31', { now: new Date(2026, 0, 1, 0, 30) })).toBe('Yesterday');
  });
});
