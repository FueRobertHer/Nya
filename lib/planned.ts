// lib/planned.ts
//
// What the person tells the forecast that detection can't know: upcoming
// expenses and income they type (a car registration, a tax refund, a room
// they let), one-off or repeating, and the detected bills and income they say
// aren't recurring. Shapes, the strict check a save goes through, and the
// dates each item falls on. Pure, safe to import from client code; the store
// is lib/planned-store.ts, the route app/api/planned-items.
//
// One value per container, replaced whole on every save (a value store on the
// storage seam): items, dismissals and the low-balance warning are edited by
// one person, on one screen, a change at a time (lib/whole-list-store.ts).
//
// An item's currency is its own, never converted: the forecast counts the
// items in its currency and names the rest (lib/forecast.ts). Its amount is
// positive; whether it is money out or in is its kind.

import { isCalendarDay, knownCurrency, amountUnitsError, MAX_AMOUNT } from './manual-txn-input';
import { monthlyFrom, scheduleDatesBetween, type Schedule } from './recurring';

export type PlannedKind = 'expense' | 'income';

/** How often an item repeats, or 'once'. Twice a month is two monthly items
 *  (the 1st and the 15th), so neither date is a guess. */
export type PlannedCadence = 'once' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'semiannual' | 'yearly';

export const PLANNED_CADENCES: readonly PlannedCadence[] = ['once', 'weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'yearly'];

export type PlannedItem = {
  /** Random (crypto.randomUUID()), minted by the form. */
  id: string;
  name: string;
  kind: PlannedKind;
  /** Positive, in `currency`'s minor units. */
  amount: number;
  currency: string;
  /** The day it falls on, or the first day of a repeating one (YYYY-MM-DD). */
  date: string;
  cadence: PlannedCadence;
};

export type Planned = {
  version: 1;
  items: PlannedItem[];
  /** The ids of detected series the person said aren't recurring
   *  (lib/recurring.ts RecurringSeries.id). */
  dismissed: string[];
  /** Warn when the forecast drops below this, in the forecast's currency;
   *  null for the default (DEFAULT_THRESHOLD). Below zero always warns. */
  threshold: number | null;
};

export const EMPTY_PLANNED: Planned = { version: 1, items: [], dismissed: [], threshold: null };

/** The low-balance warning before the person sets one: the Home tab's own
 *  low-balance line (components/Insights.tsx) speaks at the same figure. */
export const DEFAULT_THRESHOLD = 100;

export const MAX_ITEMS = 100;
export const MAX_NAME_CHARS = 60;
export const MAX_DISMISSED = 500;
/** A series id is its kind, institution, merchant and currency: generous. */
export const MAX_DISMISSED_CHARS = 500;
/** The first and last day an item may fall on. */
export const EARLIEST_PLANNED = '2000-01-01';
export const LATEST_PLANNED = '2100-12-31';

const KINDS: ReadonlySet<string> = new Set(['expense', 'income']);
const CADENCE_SET: ReadonlySet<string> = new Set(PLANNED_CADENCES);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
// Control characters (a pasted tab or newline) would break the one-line rows.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Whether a value is a stored plan's shape and types, whatever ranges a save
 *  checked: the store's read check. A value this fails is one this code
 *  doesn't understand (a later release's), never read as empty. */
export function isPlanned(v: unknown): v is Planned {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const p = v as Record<string, unknown>;
  return (
    p.version === 1 &&
    Array.isArray(p.items) &&
    p.items.every(isPlannedItemShape) &&
    Array.isArray(p.dismissed) &&
    p.dismissed.every((d) => typeof d === 'string') &&
    (p.threshold === null || (typeof p.threshold === 'number' && Number.isFinite(p.threshold)))
  );
}

function isPlannedItemShape(v: unknown): v is PlannedItem {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const i = v as Record<string, unknown>;
  return (
    typeof i.id === 'string' &&
    typeof i.name === 'string' &&
    typeof i.kind === 'string' &&
    KINDS.has(i.kind) &&
    typeof i.amount === 'number' &&
    Number.isFinite(i.amount) &&
    typeof i.currency === 'string' &&
    typeof i.date === 'string' &&
    typeof i.cadence === 'string' &&
    CADENCE_SET.has(i.cadence)
  );
}

type Parsed<T> = { ok: T } | { error: string };

function parseItem(raw: unknown, at: number): Parsed<PlannedItem> {
  const fail = (what: string) => ({ error: `Item ${at + 1}: ${what}` });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('not an item');
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID.test(r.id)) return fail('invalid id');
  if (typeof r.name !== 'string') return fail('a name is needed');
  const name = r.name.trim();
  if (!name) return fail('a name is needed');
  if (name.length > MAX_NAME_CHARS) return fail(`a name is at most ${MAX_NAME_CHARS} characters`);
  if (CONTROL.test(name)) return fail('a name is one line of text');
  if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) return fail('it is an expense or income');
  if (typeof r.currency !== 'string' || !knownCurrency(r.currency)) return fail('enter a currency as its three-letter code, like USD');
  if (typeof r.amount !== 'number' || !Number.isFinite(r.amount) || r.amount <= 0) return fail('the amount is more than zero');
  if (r.amount > MAX_AMOUNT) return fail('the amount is too large');
  const units = amountUnitsError(r.amount, r.currency);
  if (units) return fail(units);
  if (!isCalendarDay(r.date) || r.date < EARLIEST_PLANNED || r.date > LATEST_PLANNED) return fail('a date is needed');
  if (typeof r.cadence !== 'string' || !CADENCE_SET.has(r.cadence)) return fail('it repeats on a cadence listed, or once');
  return {
    ok: { id: r.id, name, kind: r.kind as PlannedKind, amount: r.amount, currency: r.currency, date: r.date, cadence: r.cadence as PlannedCadence },
  };
}

/**
 * A plan as a save sends it, checked field by field, or why it can't be
 * saved: at most MAX_ITEMS items, each with a random id (no two the same), a
 * one-line name, a kind, a positive amount in its currency's minor units, a
 * known currency, a real date and a cadence; at most MAX_DISMISSED dismissed
 * ids, none empty or repeated; a threshold of zero or more, or null. Names
 * are trimmed; nothing else is changed, and anything else sent is dropped.
 */
export function parsePlanned(raw: unknown): Parsed<Planned> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'Invalid planned items' };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { error: 'Invalid planned items: unknown version' };
  if (!Array.isArray(r.items)) return { error: 'Invalid planned items' };
  if (r.items.length > MAX_ITEMS) return { error: `At most ${MAX_ITEMS} planned items` };
  const items: PlannedItem[] = [];
  const ids = new Set<string>();
  for (const [i, raw] of r.items.entries()) {
    const parsed = parseItem(raw, i);
    if ('error' in parsed) return parsed;
    if (ids.has(parsed.ok.id)) return { error: `Item ${i + 1}: the same id twice` };
    ids.add(parsed.ok.id);
    items.push(parsed.ok);
  }
  if (!Array.isArray(r.dismissed)) return { error: 'Invalid dismissed list' };
  if (r.dismissed.length > MAX_DISMISSED) return { error: `At most ${MAX_DISMISSED} dismissed` };
  const dismissed = new Set<string>();
  for (const d of r.dismissed) {
    if (typeof d !== 'string' || !d || d.length > MAX_DISMISSED_CHARS || dismissed.has(d)) return { error: 'Invalid dismissed list' };
    dismissed.add(d);
  }
  const t = r.threshold;
  if (t !== null && (typeof t !== 'number' || !Number.isFinite(t) || t < 0 || t > MAX_AMOUNT)) return { error: 'Invalid low-balance warning' };
  return { ok: { version: 1, items, dismissed: [...dismissed], threshold: t } };
}

/** The low-balance warning in force. */
export function thresholdOf(planned: Pick<Planned, 'threshold'>): number {
  return planned.threshold ?? DEFAULT_THRESHOLD;
}

/** A repeating item's schedule, from its date; null for a one-off. */
export function plannedSchedule(item: Pick<PlannedItem, 'date' | 'cadence'>): Schedule | null {
  switch (item.cadence) {
    case 'once':
      return null;
    case 'weekly':
      return { unit: 'day', every: 7, start: item.date };
    case 'biweekly':
      return { unit: 'day', every: 14, start: item.date };
    case 'monthly':
      return monthlyFrom(item.date, 1);
    case 'quarterly':
      return monthlyFrom(item.date, 3);
    case 'semiannual':
      return monthlyFrom(item.date, 6);
    case 'yearly':
      return monthlyFrom(item.date, 12);
  }
}

/** The days an item falls on from `from` through `until`, both included
 *  (at most `limit`): never before its own date. A monthly item on the 31st
 *  falls on each shorter month's last day. */
export function plannedDates(item: Pick<PlannedItem, 'date' | 'cadence'>, from: string, until: string, limit = 1000): string[] {
  const schedule = plannedSchedule(item);
  if (!schedule) return item.date >= from && item.date <= until ? [item.date] : [];
  return scheduleDatesBetween(schedule, item.date > from ? item.date : from, until, limit);
}

/** A planned item's next day from `today` on, or null when it has none left. */
export function nextPlannedDate(item: Pick<PlannedItem, 'date' | 'cadence'>, today: string): string | null {
  return plannedDates(item, today, LATEST_PLANNED, 1)[0] ?? null;
}

const CADENCE_LABELS: Record<PlannedCadence, string> = {
  once: 'Once',
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  semiannual: 'Every 6 months',
  yearly: 'Yearly',
};

export function plannedCadenceLabel(cadence: PlannedCadence): string {
  return CADENCE_LABELS[cadence];
}
