// lib/report/runway-scenarios.ts
//
// The runway's what-ifs the person chose to keep (lib/report/runway.ts
// RunwayWhatIf): a name and the settings, never a figure worked out from
// them, which the runway works out again from the data of the day it is
// opened. A what-if is never stored on its own: only a scenario the person
// saves, from the report page, is (app/api/runway-scenarios).
//
// Shapes and checks, pure and client-safe; the store is
// lib/report/runway-scenario-store.ts. isRunwayScenario checks the shape and
// types a scenario was saved with, closed, not today's limits, which
// parseRunwayScenario checks when one is saved. Version 1 is the first shape:
// a later one bumps `v` and gives the store an `upgrade`.
//
// The amount spending is lower by is kept with the currency it was set in,
// so a runway that comes to be in another never reads it as its own.

import { isCalendarDay, knownCurrency, amountUnitsError, MAX_AMOUNT } from '../manual-txn-input';
import { RUNWAY_WINDOWS, type RunwayWhatIf, type RunwayWindow } from './runway';

export type RunwayScenario = {
  v: 1;
  name: string;
  months: RunwayWindow;
  lower_by: number;
  /** The currency lower_by was set in; null with nothing lower. */
  currency: string | null;
  income_until: string | null;
  planned: boolean;
  leave_out_one_offs: boolean;
  /** When it was saved (an instant). */
  saved_at: string;
};

export const MAX_SCENARIOS = 20;
export const SCENARIO_NAME_MAX = 40;
const KEYS = ['v', 'name', 'months', 'lower_by', 'currency', 'income_until', 'planned', 'leave_out_one_offs', 'saved_at'];
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Whether a value is a saved scenario's shape and types (the store's read check). */
export function isRunwayScenario(v: unknown): v is RunwayScenario {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return (
    Object.keys(s).every((k) => KEYS.includes(k)) &&
    s.v === 1 &&
    typeof s.name === 'string' &&
    (RUNWAY_WINDOWS as readonly unknown[]).includes(s.months) &&
    typeof s.lower_by === 'number' &&
    Number.isFinite(s.lower_by) &&
    (s.currency === null || typeof s.currency === 'string') &&
    (s.income_until === null || typeof s.income_until === 'string') &&
    typeof s.planned === 'boolean' &&
    typeof s.leave_out_one_offs === 'boolean' &&
    typeof s.saved_at === 'string'
  );
}

/**
 * A scenario as a save sends it, checked field by field, or why it can't be
 * saved: a one-line name of 1 to SCENARIO_NAME_MAX characters (trimmed), a
 * window of 3, 6 or 12 months, spending lower by zero or more in a known
 * currency's minor units (that currency, or null with nothing lower), the
 * day income stops (a real date, or null while it keeps coming), and
 * whether the planned items and the one-offs are in. Nothing else is taken.
 */
export function parseRunwayScenario(raw: unknown, now: number): { ok: RunwayScenario } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'Send the scenario, as JSON' };
  const r = raw as Record<string, unknown>;
  const allowed = ['name', 'months', 'lower_by', 'currency', 'income_until', 'planned', 'leave_out_one_offs'];
  const extra = Object.keys(r).find((k) => !allowed.includes(k));
  if (extra) return { error: `${extra.slice(0, 40)} isn’t part of a scenario` };
  if (typeof r.name !== 'string') return { error: 'A scenario needs a name' };
  const name = r.name.trim();
  if (!name || name.length > SCENARIO_NAME_MAX || CONTROL.test(name)) return { error: `A name is 1 to ${SCENARIO_NAME_MAX} characters, on one line` };
  if (!(RUNWAY_WINDOWS as readonly unknown[]).includes(r.months)) return { error: 'months is 3, 6 or 12' };
  if (typeof r.lower_by !== 'number' || !Number.isFinite(r.lower_by) || r.lower_by < 0 || r.lower_by > MAX_AMOUNT) return { error: 'Spending lower by is an amount of zero or more' };
  if (r.currency !== null && (typeof r.currency !== 'string' || !knownCurrency(r.currency))) return { error: 'Enter a currency as its three-letter code, like USD' };
  if (r.lower_by > 0 && r.currency === null) return { error: 'Spending lower by needs the currency it is in' };
  if (typeof r.currency === 'string' && amountUnitsError(r.lower_by, r.currency)) return { error: amountUnitsError(r.lower_by, r.currency)! };
  if (r.income_until !== null && (!isCalendarDay(r.income_until) || r.income_until < '2000-01-01' || r.income_until > '2100-12-31')) return { error: 'Income stops on a date, YYYY-MM-DD, or is null' };
  if (typeof r.planned !== 'boolean' || typeof r.leave_out_one_offs !== 'boolean') return { error: 'planned and leave_out_one_offs are true or false' };
  return {
    ok: {
      v: 1,
      name,
      months: r.months as RunwayWindow,
      lower_by: r.lower_by,
      currency: r.currency as string | null,
      income_until: r.income_until as string | null,
      planned: r.planned,
      leave_out_one_offs: r.leave_out_one_offs,
      saved_at: new Date(now).toISOString(),
    },
  };
}

/** A scenario as a what-if on a runway in `currency`, and whether its lower
 *  spending was set in another currency (then it is left out, and said). */
export function scenarioWhatIf(s: RunwayScenario, currency: string | null): { whatIf: RunwayWhatIf; otherCurrency: string | null } {
  const other = s.lower_by > 0 && s.currency !== null && currency !== null && s.currency !== currency ? s.currency : null;
  return {
    whatIf: { months: s.months, lower_by: other ? 0 : s.lower_by, income_until: s.income_until, planned: s.planned, leave_out_one_offs: s.leave_out_one_offs },
    otherCurrency: other,
  };
}
