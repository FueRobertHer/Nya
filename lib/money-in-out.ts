// lib/money-in-out.ts
//
// What a person says an investment account has had put in and taken out, in
// all, by a day: the two totals their brokerage shows ("contributions and
// withdrawals", "deposits and withdrawals"). From them, and the account's
// activity Nya keeps (lib/investment-activity.ts flows), the chart's grey
// line becomes the account's net money in on each day, and the sheet says
// its growth since it started rather than since the first day Nya recorded
// (lib/growth.ts moneyInOutOn).
//
// Both totals are positive: money out is entered as an amount, not with a
// minus sign, as the quick-add form's Spent and Received are (the iOS decimal
// keypad has no minus). An empty field is $0.00, so someone who knows only a
// net enters it as one of the two: the net and the growth stay right.
//
// The shape and the request's reading, shared by the form and the route
// (app/api/money-in-out), so the two agree. Pure, safe to import from client
// code; the store is lib/money-in-out-store.ts.

import { isCalendarDay, addDays, MAX_AMOUNT, MAX_FUTURE_DAYS } from './manual-txn-input';

/** One account's totals, under the id it had when they were set. */
export type MoneyInOut = {
  /** Everything put in by the end of `as_of`: contributions, transfers and
   *  rollovers in, an employer's match. Zero or more, in `currency`. */
  in: number;
  /** Everything taken out by the end of `as_of`: withdrawals, transfers and
   *  rollovers out, distributions. Zero or more. */
  out: number;
  /** The day the totals are for (YYYY-MM-DD). */
  as_of: string;
  /** The account's currency when they were set (an ISO code, or Plaid's
   *  unofficial one), or null where the account named none. */
  currency: string | null;
  /** When they were saved (an ISO time): of two entries on one account, the
   *  newest wins after its current id's own. */
  set_at: string;
};

/** The earliest day the totals may be for: nothing in Nya is older. */
export const FIRST_AS_OF = '1970-01-01';
const CURRENCY = /^[A-Za-z0-9]{2,12}$/;
const KEYS = ['in', 'out', 'as_of', 'currency', 'set_at'];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A total as stored: a finite amount from zero up to MAX_AMOUNT. */
export function isTotal(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_AMOUNT;
}

/** The stored shape, closed: a later release's entry is unrecognised, never
 *  read as something it isn't. */
export function isMoneyInOut(v: unknown): v is MoneyInOut {
  if (!isRecord(v) || !Object.keys(v).every((k) => KEYS.includes(k))) return false;
  return (
    isTotal(v.in) &&
    isTotal(v.out) &&
    isCalendarDay(v.as_of) &&
    v.as_of >= FIRST_AS_OF &&
    (v.currency === null || (typeof v.currency === 'string' && CURRENCY.test(v.currency))) &&
    typeof v.set_at === 'string' &&
    v.set_at.length <= 64 &&
    Number.isFinite(Date.parse(v.set_at))
  );
}

/** The latest day the totals may be for: today, or tomorrow for anyone east
 *  of the server's UTC day (lib/manual-txn-input.ts MAX_FUTURE_DAYS). */
export function latestAsOf(now: number = Date.now()): string {
  return addDays(new Date(now).toISOString().slice(0, 10), MAX_FUTURE_DAYS);
}

const ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export type MoneyInOutChange =
  | { kind: 'set'; account_id: string; in: number; out: number; as_of: string; currency: string | null }
  | { kind: 'clear'; account_id: string };

/**
 * A request to the route, or what is wrong with it in the person's words:
 *
 *   { account_id, in, out, as_of, currency }   set the totals
 *   { account_id, clear: true }                 clear them
 *
 * Amounts are numbers, rounded to the cent by the form; anything else is
 * refused.
 */
export function parseMoneyInOutChange(body: unknown, now: number = Date.now()): MoneyInOutChange | string {
  if (!isRecord(body)) return 'Send the totals, as JSON';
  const { account_id } = body;
  if (typeof account_id !== 'string' || !ID.test(account_id) || account_id === '__proto__') return 'Invalid account id';
  if (body.clear !== undefined) {
    if (body.clear !== true || Object.keys(body).some((k) => k !== 'account_id' && k !== 'clear')) return 'Clearing takes the account alone';
    return { kind: 'clear', account_id };
  }
  const extra = Object.keys(body).find((k) => !['account_id', 'in', 'out', 'as_of', 'currency'].includes(k));
  if (extra) return `${extra.slice(0, 40)} isn’t part of money in and out`;
  if (!isTotal(body.in)) return 'Money in is an amount, $0.00 or more';
  if (!isTotal(body.out)) return 'Money out is an amount, $0.00 or more';
  if (!isCalendarDay(body.as_of) || body.as_of < FIRST_AS_OF) return 'The day is a date, YYYY-MM-DD, from 1970 on';
  if (body.as_of > latestAsOf(now)) return 'The day can’t be in the future';
  const currency = body.currency ?? null;
  if (currency !== null && (typeof currency !== 'string' || !CURRENCY.test(currency))) return 'Invalid currency';
  return { kind: 'set', account_id, in: round2(body.in), out: round2(body.out), as_of: body.as_of, currency };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
