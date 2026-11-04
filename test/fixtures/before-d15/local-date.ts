// lib/local-date.ts
//
// "Today" and "this month" as the person looking at the screen has them.
//
// toISOString() is UTC, so `new Date().toISOString().slice(0, 10)` is already
// tomorrow for anyone west of Greenwich from the evening on, and next month on
// the last evening of a month. Wherever the browser decides which day or month
// it is (the current month's spending, a bill due "within a week"), it must
// read the local calendar instead. Server code does not use this: stored
// history is keyed by UTC day on purpose (lib/history.ts).
//
// Plaid's own dates (a transaction's date, a due date) are calendar days at the
// bank and are shown as they are, never converted.

const pad = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD on the local calendar. */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "Sep 28": the local day of an instant (an ISO time), or null if it isn't one.
 *  Not its UTC day, which is the next one from a US evening on. */
export function instantDay(iso: string, timeZone?: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  // `timeZone` is for tests; the app leaves it out and gets the viewer's own.
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) });
}

/** YYYY-MM on the local calendar. */
export function localMonth(d: Date = new Date()): string {
  return localDate(d).slice(0, 7);
}
