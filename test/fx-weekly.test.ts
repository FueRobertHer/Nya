import { describe, expect, test } from 'bun:test';
import { ecbTable } from './fx-fixture';
import { spendingFact, type SpendingInput, type WeeklyFacts } from '@/lib/weekly-summary/content';
import { NO_COVERAGE_GAPS } from '@/lib/rollover';
import { composeWeekly, figuresIn } from '@/lib/weekly-summary/compose';
import { totalsIn } from '@/lib/fx/totals';
import { addDays } from '@/lib/recurring';

// The weekly summary with a home currency (lib/weekly-summary/gather.ts):
// still never an amount. The week against a usual one is worked out over the
// rows converted as the app counts them (lib/fx/totals.ts totalsIn), so a
// week spent in another currency is compared, not left out; what has no rate
// is named, and said to have none. The ECB's rates of 1 to 11 Sep 2026
// (test/fx-fixture.ts), the newest carried to the days after.

const ROW = { transaction_code: null, category: 'groceries' };
const row = (date: string, amount: number, currency: string | null, over: Record<string, unknown> = {}) => ({
  ...ROW,
  date,
  amount,
  iso_currency_code: currency,
  institution_name: 'Bank',
  ...over,
});

const FRESH = { name: 'Bank', brings: true, synced_at: '2026-10-12T13:00:00.000Z', complete: true };
const spend = (rows: SpendingInput['rows'], over: Partial<SpendingInput> = {}) =>
  spendingFact({
    rows,
    currency: 'USD',
    send_day: '2026-10-12',
    first: '2026-10-05',
    last: '2026-10-11',
    time_zone: 'UTC',
    sources: [FRESH],
    facts: NO_COVERAGE_GAPS,
    none_come_in: false,
    ...over,
  });

// Nine usual weeks of 100 USD, and this week 100 USD and 100 EUR (about
// 115.51 USD at the newest rate): twice a usual week, once converted.
const usual = Array.from({ length: 9 }, (_, i) => row(addDays('2026-10-05', -7 * (9 - i)), 100, 'USD'));
const ROWS = [...usual, row('2026-10-07', 100, 'USD'), row('2026-10-08', 100, 'EUR'), row('2026-10-08', 0.01, null, { unofficial_currency_code: 'BTC' })];

describe('the week against a usual one', () => {
  test('without a home currency, as before: the euros left out and named', () => {
    expect(spend(ROWS)).toEqual({ kind: 'compared', level: 'same', left_out: ['BTC', 'EUR'] });
  });

  test('with one, over the rows converted: the euros counted, what has no rate named as having none', () => {
    const counting = totalsIn(ROWS, ecbTable({ home: 'USD' }));
    const fact = spend(counting.rows, { currency: counting.currency, converted: counting.conversion !== null });
    expect(fact).toEqual({ kind: 'compared', level: 'much_higher', left_out: ['BTC'], no_rate: true });
  });

  test('the email says it in words, never a figure', () => {
    const facts = {
      send_day: '2026-10-12',
      first: '2026-10-05',
      last: '2026-10-11',
      today: '2026-10-12',
      time_zone: 'UTC',
      weekday: 1,
      spending: { kind: 'compared', level: 'much_higher', left_out: ['BTC'], no_rate: true },
      budgets: null,
      bills: [],
      goals: { reached: [], behind: [], complete: [] },
      connections: [],
      months: [],
      uncategorized: 0,
    } as unknown as WeeklyFacts;
    const composed = composeWeekly(facts, { link: 'https://nya.example/', unsubscribe: 'https://nya.example/stop', requested: false, schedule: 1, now: Date.parse('2026-10-12T13:00:00Z') });
    expect(composed.text).toContain("Transactions in BTC aren't counted in that: Nya has no exchange rate for them.");
    expect(figuresIn([composed.subject, composed.text], { sendDay: '2026-10-12', banks: composed.banks, codes: composed.codes })).toEqual([]);
  });
});
