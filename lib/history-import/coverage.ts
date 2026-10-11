// lib/history-import/coverage.ts
//
// Which days a connection's transactions are all in Nya for, counting the
// files imported into its bank accounts and cards (#52): the bank's own
// days, from its oldest stored transaction on (what is still to come isn't
// missing), joined with the period of each file that holds every
// transaction of it (lib/history-import/read.ts importedCoverage). An
// account that ended (lib/lifecycle.ts) needs its transactions only up to
// the day before its end, and one that ended by the first day none of them.
// The one rule for a report's gaps (lib/report/build.ts IMPORTED), the
// months budget rollover counts (lib/budget-month.ts, lib/rollover.ts) and
// the months a goal's pace averages (lib/goal-flows.ts). Pure: safe
// anywhere.

/** Days from `from` to `to`, both included (YYYY-MM-DD). */
export type DayRange = { from: string; to: string };

/** A bank account or card, for what covers it: the days the files imported
 *  into it cover, and the day it stopped counting, when it ended. */
export type CoveredAccount = { covers: readonly DayRange[]; end?: string | null };

/** The last day there is: the bank's own days reach it, since what is still
 *  to come isn't missing. */
const OPEN = '9999-12-31';

const DAY_MS = 86_400_000;
const shifted = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Days as ranges, joined where they overlap or touch. */
export function joinedRanges(ranges: readonly DayRange[]): DayRange[] {
  const out: DayRange[] = [];
  for (const r of [...ranges].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))) {
    const last = out[out.length - 1];
    if (last && r.from <= shifted(last.to, 1)) {
      if (r.to > last.to) last.to = r.to;
    } else out.push({ ...r });
  }
  return out;
}

/** The days an account's transactions are all in for, joined: the bank's
 *  own from `bankFrom` on, when it has any, and what its files cover. */
export function coveredDays(a: Pick<CoveredAccount, 'covers'>, bankFrom: string | null): DayRange[] {
  return joinedRanges([...(bankFrom ? [{ from: bankFrom, to: OPEN }] : []), ...a.covers]);
}

/** The first day of the unbroken run of covered days (coveredDays) that
 *  holds `day`, or null when none does. */
export function runStart(a: Pick<CoveredAccount, 'covers'>, bankFrom: string | null, day: string): string | null {
  return coveredDays(a, bankFrom).find((r) => r.from <= day && day <= r.to)?.from ?? null;
}

/** The last day an account needs its transactions through, of the days from
 *  `from` to `through`: `through`, or the day before its end for one that
 *  ended in them; null for one that ended by `from`, which needs none. */
export function throughFor(a: Pick<CoveredAccount, 'end'>, from: string, through: string): string | null {
  if (!a.end) return through;
  if (a.end <= from) return null;
  const before = shifted(a.end, -1);
  return before < through ? before : through;
}

/** Whether every one of a connection's bank accounts and cards is covered
 *  from `from` through the day each needs (throughFor), by the bank's own
 *  days from `bankFrom` on, if any, and by its files. False when none is
 *  known, or when no file was imported into any: then nothing here says
 *  more than the bank's own days do. */
export function filesCoverAll(accounts: readonly CoveredAccount[], bankFrom: string | null, from: string, through: string): boolean {
  if (accounts.length === 0 || !accounts.some((a) => a.covers.length > 0)) return false;
  return accounts.every((a) => {
    const last = throughFor(a, from, through);
    return last === null || coveredDays(a, bankFrom).some((r) => r.from <= from && last <= r.to);
  });
}
