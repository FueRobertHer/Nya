import { describe, expect, test } from 'bun:test';
import { addDays, dayIso, dayNumber, detectRecurring, expectedDates, olderRowsForDetection, type RecurringRow } from '@/lib/recurring';

// Phantom bills (lib/recurring.ts THE RULES): simulated accounts with the
// shapes a review found producing bills that weren't there (shops and
// restaurants split into "subscriptions" by amount, two visits a year apart
// called a yearly bill), and the real subscriptions those accounts hold,
// which must all still be found. Each account is two years and a little of
// rows, split as /api/transactions splits them: the loaded year, and the
// older rows it sends for detection (olderRowsForDetection).

const TODAY = '2026-10-09';
const T = dayNumber(TODAY);
const CUTOFF = dayIso(T - 365);

/** The review's seeded generator, so each account is the same every run. */
function generator(seed: number) {
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const between = (a: number, b: number) => a + rand() * (b - a);
  const normal = () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { rand, between, normal };
}
const r2 = (n: number) => Math.round(n * 100) / 100;

function charge(d: number, name: string, amount: number, institution = 'Chase', category = 'general merchandise'): RecurringRow {
  return { date: dayIso(d), name, amount, institution_name: institution, category, transaction_code: null, iso_currency_code: 'USD' };
}

/** Detection as the dashboard runs it: the loaded year and what is sent from before it. */
function detect(rows: RecurringRow[]) {
  const recent = rows.filter((r) => r.date >= CUTOFF);
  const older = olderRowsForDetection(recent, rows.filter((r) => r.date < CUTOFF));
  return { series: detectRecurring([...recent, ...older]), older };
}

describe('no phantom bills', () => {
  test('four hundred restaurants or shops visited one to six times, eight accounts each way', () => {
    // Before: 10 to 24 series an account, 3 to 8 of them in the next 90 days.
    // Now none for restaurants, and one in eight accounts of shops: two visits
    // half a year apart at exactly the same amount, to the cent, and no others,
    // which is as close to a bill as chance gets (about 0.03 an account over
    // forty such accounts).
    for (const category of ['food and drink', 'general merchandise']) {
      let phantoms = 0;
      for (let seed = 1; seed <= 8; seed++) {
        const { rand, between } = generator(seed);
        const rows: RecurringRow[] = [];
        for (let m = 0; m < 400; m++) {
          const visits = 1 + Math.floor(rand() * 6);
          const base = between(8, 120);
          const spread = between(0.05, 0.5);
          for (let i = 0; i < visits; i++) rows.push(charge(Math.round(between(T - 800, T - 1)), `Merchant ${m}`, r2(base * between(1 - spread, 1 + spread)), 'Bank', category));
        }
        phantoms += detect(rows).series.length;
      }
      expect(phantoms).toBeLessThanOrEqual(1);
    }
  });

  test('a grocery store, a gas station with round fills, Amazon, Target and a coffee shop, every day for two years', () => {
    // Before: up to 4 series an account, "Safeway monthly 100.73",
    // "Amazon every 2 weeks 13.93", "Chevron every 3 months 30" among them.
    for (let s = 1; s <= 8; s++) {
      const { rand, between, normal } = generator(s * 7919);
      const rows: RecurringRow[] = [];
      for (let d = T - 800; d < T; d++) {
        if (rand() < 0.3) rows.push(charge(d, 'Safeway', r2(Math.exp(Math.log(70) + 0.6 * normal())), 'Chase', 'food and drink'));
        if (rand() < 0.12) rows.push(charge(d, 'Chevron', rand() < 0.35 ? [30, 40, 50][Math.floor(rand() * 3)] : r2(between(25, 75)), 'Chase', 'transportation'));
        if (rand() < 0.35) rows.push(charge(d, 'Amazon', r2(Math.exp(Math.log(30) + 0.9 * normal()))));
        if (rand() < 0.08) rows.push(charge(d, 'Target', r2(Math.exp(Math.log(55) + 0.7 * normal()))));
        if (rand() < 0.5) rows.push(charge(d, 'Starbucks', [4.95, 5.45, 6.25, 7.1][Math.floor(rand() * 4)], 'Chase', 'food and drink'));
      }
      expect(detect(rows).series.map((x) => `${x.name} ${x.cadence} ${x.amount}`)).toEqual([]);
    }
  });

  test('a busy household finds its 25 subscriptions and its pay, and nothing else', () => {
    // Before: 12 phantoms beside them, "Whole Foods twice a month 210.49"
    // expected 6 times in the next 90 days among them.
    const { rand, between } = generator(99);
    const rows: RecurringRow[] = [];
    for (let d = T - 800; d < T; d++) {
      if (rand() < 0.8) rows.push(charge(d, 'Starbucks', r2(between(4, 9)), 'Chase', 'food and drink'));
      if (rand() < 0.5) rows.push(charge(d, 'Amazon', r2(between(5, 250)), 'Amex'));
      if (rand() < 0.3) rows.push(charge(d, 'Uber', r2(between(8, 45)), 'Amex', 'transportation'));
      if (rand() < 0.25) rows.push(charge(d, 'Whole Foods', r2(between(20, 220)), 'Chase', 'food and drink'));
      if (rand() < 0.15) rows.push(charge(d, 'Shell', rand() < 0.3 ? 40 : r2(between(30, 70)), 'Chase', 'transportation'));
      if (rand() < 0.1) rows.push(charge(d, 'Target', r2(between(10, 200)), 'Citi'));
      if (rand() < 0.1) rows.push(charge(d, 'Venmo', r2(between(5, 100)), 'Citi'));
      for (let k = 0; k < 4; k++) if (rand() < 0.6) rows.push(charge(d, `Restaurant ${Math.floor(rand() * 600)}`, r2(between(12, 140)), ['Chase', 'Amex', 'Citi'][k % 3], 'food and drink'));
    }
    for (let s = 0; s < 25; s++) {
      const day = 1 + Math.floor(rand() * 28);
      const amount = r2(between(5, 300));
      for (let m = 0; m < 26; m++) {
        const d = T - 800 + day + Math.round(m * 30.44);
        if (d < T) rows.push(charge(d, `Sub ${s}`, amount));
      }
    }
    for (let d = T - 800; d < T; d += 14) rows.push(charge(d, 'PAYROLL', -3100, 'Chase', 'income'));
    const { series, older } = detect(rows);
    expect(series.filter((x) => x.name.startsWith('Sub ')).map((x) => x.cadence)).toEqual(Array(25).fill('monthly'));
    expect(series.filter((x) => x.name === 'PAYROLL').map((x) => [x.cadence, x.amount])).toEqual([['biweekly', 3100]]);
    expect(series.filter((x) => !x.name.startsWith('Sub ') && x.name !== 'PAYROLL')).toEqual([]);
    // Before: 426 older rows sent for 4,411.
    expect(older.length).toBeLessThan(40);
  });

  test('a very busy account, fifteen charges a day, finds its 40 subscriptions and nothing else, and sends little history', () => {
    // Before: 28 phantoms, and 1,960 older rows (about 670 KB) sent.
    const { rand, between } = generator(4242);
    const rows: RecurringRow[] = [];
    for (let d = T - 800; d < T; d++) {
      for (let k = 0; k < 6; k++) rows.push(charge(d, ['Starbucks', 'Amazon', 'Uber', 'DoorDash', 'Lyft', 'Walgreens'][k], r2(between(4, 90)), ['Chase', 'Amex'][k % 2]));
      for (let k = 0; k < 9; k++) rows.push(charge(d, `Shop ${Math.floor(rand() * 1500)}`, r2(between(5, 300)), ['Chase', 'Amex', 'Citi'][k % 3]));
    }
    for (let s = 0; s < 40; s++) {
      const day = 1 + Math.floor(rand() * 28);
      const amount = r2(between(5, 300));
      for (let m = 0; m < 26; m++) {
        const d = T - 800 + day + Math.round(m * 30.44);
        if (d < T) rows.push(charge(d, `Sub ${s}`, amount));
      }
    }
    const { series, older } = detect(rows);
    expect(series.filter((x) => x.name.startsWith('Sub '))).toHaveLength(40);
    expect(series.filter((x) => !x.name.startsWith('Sub '))).toEqual([]);
    expect(older.length).toBeLessThan(200);
  });
});

describe('what must still be found among the noise', () => {
  const show = (rows: RecurringRow[]) => detectRecurring(rows).map((s) => `${s.name} ${s.cadence} ${s.amount}`);

  test("Amazon's Prime among sixty orders, and a weekly shop at a steady spend", () => {
    const { between } = generator(12345);
    const amazon: RecurringRow[] = [];
    for (let i = 0; i < 60; i++) amazon.push(charge(Math.round(between(dayNumber('2025-10-10'), T)), 'Amazon', r2(between(5, 200))));
    for (let m = 0; m < 12; m++) amazon.push(charge(dayNumber(addDays('2025-10-14', Math.round(m * 30.44))), 'Amazon', 14.99));
    expect(show(amazon)).toEqual(['Amazon monthly 14.99']);
    // Every Saturday at 85 to 110: a recurring spend the forecast can use.
    const joes: RecurringRow[] = [];
    for (let d = dayNumber('2025-10-11'); d < T; d += 7) joes.push(charge(d, "Trader Joe's", r2(between(85, 110)), 'Chase', 'food and drink'));
    expect(detectRecurring(joes).map((s) => [s.cadence, s.agreement])).toEqual([['weekly', 'similar']]);
  });

  test('not a weekly grocery store at any spend, coffee on weekdays, or a gas station', () => {
    const { rand, between } = generator(777);
    const grocery: RecurringRow[] = [];
    for (let d = dayNumber('2025-10-10'); d < T; d += Math.round(between(5, 9))) grocery.push(charge(d, 'Safeway', r2(between(60, 180)), 'Chase', 'food and drink'));
    const coffee: RecurringRow[] = [];
    for (let d = dayNumber('2025-10-10'); d < T; d++) {
      const weekday = new Date(d * 86_400_000).getUTCDay();
      if (weekday >= 1 && weekday <= 5 && rand() < 0.7) coffee.push(charge(d, 'Starbucks', r2(between(4.5, 6.75)), 'Chase', 'food and drink'));
    }
    const gas: RecurringRow[] = [];
    for (let d = dayNumber('2024-08-01'); d < T; d += Math.round(between(5, 12))) gas.push(charge(d, 'Shell', rand() < 0.3 ? 40 : r2(between(30, 65)), 'Chase', 'transportation'));
    expect(show([...grocery, ...coffee, ...gas])).toEqual([]);
  });

  test('a yearly charge seen twice through the history, at its own merchant', () => {
    const s = detectRecurring([charge(dayNumber('2025-03-10'), 'Prime Annual', 139), charge(dayNumber('2026-03-12'), 'Prime Annual', 139)]);
    expect(s.map((x) => [x.cadence, x.nextDate])).toEqual([['yearly', '2027-03-10']]);
    expect(expectedDates(s[0], TODAY, addDays(TODAY, 90)).status).toBe('due');
  });
});
