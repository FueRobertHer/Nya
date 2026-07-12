// lib/recurring.ts
//
// Detects recurring charges (subscriptions, bills) from transaction history
// -- Mint's "Bills" view. Pure functions, safe to import from client code.
//
// Heuristic: a merchant is recurring if it charged in >= 3 distinct months,
// roughly once per month, at a consistent amount (spread <= 25% of the
// average, with a $5 floor for small subscriptions). Loan payments count
// (mortgage/car payments are classic bills); transfers between own accounts
// don't. Grouped per institution so the same subscription showing on two
// linked accounts isn't miscounted as twice-monthly.

import { type Txn } from '@/components/MonthBreakdown';

export type RecurringBill = {
  name: string;
  institution: string;
  amount: number; // typical (average) charge
  lastDate: string;
  nextDate: string; // estimated
  monthsSeen: number;
};

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function detectRecurring(txns: Txn[]): RecurringBill[] {
  const groups = new Map<string, Txn[]>();
  for (const t of txns) {
    if (t.amount <= 0 || t.pending) continue;
    if (t.category?.startsWith('transfer')) continue;
    const key = `${t.institution_name}::${t.name.toLowerCase().trim()}`;
    const list = groups.get(key);
    if (list) list.push(t);
    else groups.set(key, [t]);
  }

  const bills: RecurringBill[] = [];
  for (const list of groups.values()) {
    const months = new Set(list.map((t) => t.date.slice(0, 7)));
    if (months.size < 3) continue;
    if (list.length > months.size + 1) continue; // more than ~monthly: groceries, not a bill

    const amounts = list.map((t) => t.amount);
    const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
    const spread = Math.max(...amounts) - Math.min(...amounts);
    if (spread > Math.max(avg * 0.25, 5)) continue;

    const dates = list.map((t) => t.date).sort();
    const last = dates[dates.length - 1];

    // Median gap between charges estimates the cycle (default ~monthly).
    let cycle = 30;
    if (dates.length >= 2) {
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) {
        gaps.push(
          Math.round(
            (new Date(`${dates[i]}T00:00:00Z`).getTime() -
              new Date(`${dates[i - 1]}T00:00:00Z`).getTime()) /
              (24 * 60 * 60 * 1000)
          )
        );
      }
      gaps.sort((a, b) => a - b);
      cycle = gaps[Math.floor(gaps.length / 2)] || 30;
    }

    bills.push({
      name: list[0].name,
      institution: list[0].institution_name,
      amount: avg,
      lastDate: last,
      nextDate: addDays(last, cycle),
      monthsSeen: months.size,
    });
  }

  return bills.sort((a, b) => b.amount - a.amount);
}

/** Bills whose estimated next charge falls within the next `days` days. */
export function upcomingBills(bills: RecurringBill[], days = 7): RecurringBill[] {
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = addDays(today, days);
  return bills
    .filter((b) => b.nextDate >= today && b.nextDate <= cutoff)
    .sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1));
}
