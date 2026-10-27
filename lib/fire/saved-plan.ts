// lib/fire/saved-plan.ts
//
// The plan the person said is their plan (rollout 8e), as stored
// (lib/saved-plan.ts, one encrypted value per container) and as the Plan
// tab's Progress card sets their invested assets against it
// (components/PlanProgress.tsx).
//
// WHAT IS KEPT, and only that: the Plan's assumptions as they were when it
// was saved (a FirePlan, its typed figures and overrides as they were), the
// annual savings the Plan used that day (typed, or as Nya measured it), the
// currency its amounts are in, an inflation rate, and the UTC day it was
// saved (the days snapshots are kept by). Never a result: no FI number, no
// FI age, no balance on any day. Invested assets aren't kept either: where
// the plan starts is that day's measured balances, summed again on every
// read by today's rules (app/api/invested-history), so an account hidden
// since, or include cash, counts the same at both ends.
//
// THE COMPARISON. The plan grows its start at its growth after inflation,
// adding its savings steadily through the year (lib/fire/fi.ts
// projectBalance, which is exact at whole years and smooth between them).
// That is in the start day's dollars; snapshots are in each day's own, so
// the plan's balance is raised by the inflation rate saved with it
// (compounded yearly, smooth between) before the two are set side by side.
// Both are hypothetical: a steady return and a steady inflation rate, not a
// prediction.
//
// Two checks, as the Plan's (lib/fire/plan.ts): parseSavedDraft is what a
// save must meet (the route runs every PUT through it); isSavedPlan is what a
// stored one must be to read back: the shape and types, none of today's
// ranges, so one saved under one release never becomes unreadable under the
// next. Imports no data and no storage.

import { projectBalance } from './fi';
import { isFirePlan, parsePlan, upgradePlan, type FirePlan } from './plan';

export type SavedPlan = {
  version: 1;
  /** The Plan's assumptions when it was saved. */
  plan: FirePlan;
  /** The annual savings the Plan used that day, in today's dollars then:
   *  the typed figure if there was one, else Nya's measurement. */
  savings: number;
  /** The currency the plan's amounts are in, and the one its invested
   *  assets are summed in; null when no account named one. */
  currency: string | null;
  /** Inflation a year, a fraction (0.03 is 3%). */
  inflation: number;
  /** The UTC day it was saved (YYYY-MM-DD). */
  day: string;
  /** When, to the instant, set by the server. */
  savedAt: string;
  /** A new random value on every save: a change is made only to the version
   *  the page loaded (app/api/saved-plan). */
  rev: string;
};

/** What a save sends: everything but what the server sets. */
export type SavedPlanDraft = Pick<SavedPlan, 'plan' | 'savings' | 'currency' | 'inflation'>;

/** The inflation rate a save starts with, which the save sheet shows and the
 *  person can change. */
export const DEFAULT_INFLATION = 0.03;
/** The range a save takes: a fraction, 0% to 20% a year. */
export const MAX_INFLATION = 0.2;
/** Savings a year a save takes, either way: far past anyone's. */
const MAX_SAVINGS = 1e12;

const KEYS = ['version', 'plan', 'savings', 'currency', 'inflation', 'day', 'savedAt', 'rev'] as const;
const DRAFT_KEYS = ['plan', 'savings', 'currency', 'inflation'] as const;
/** A currency code as accounts carry them: ISO 4217, or one of Plaid's
 *  unofficial codes. */
const CURRENCY = /^[A-Z0-9]{2,12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REV = /^[A-Za-z0-9_.:-]{1,200}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactly = (o: Record<string, unknown>, keys: readonly string[]) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.hasOwn(o, x));
};

/** A real calendar day, as YYYY-MM-DD. */
export const isDay = (s: unknown): s is string =>
  typeof s === 'string' && DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** A stored saved plan in the current shape: its plan upgraded as the Plan's
 *  store upgrades it (lib/fire/plan.ts upgradePlan). Anything else is
 *  returned as it is, for isSavedPlan to refuse. Never throws. */
export function upgradeSavedPlan(stored: unknown): unknown {
  if (!isObject(stored) || stored.version !== 1 || !Object.hasOwn(stored, 'plan')) return stored;
  return { ...stored, plan: upgradePlan(stored.plan) };
}

/** Whether a value is a saved plan as stored: the shape and types, whatever
 *  ranges applied when it was saved. One this fails is one this code doesn't
 *  understand: a later release's, say. */
export function isSavedPlan(v: unknown): v is SavedPlan {
  if (!isObject(v) || !exactly(v, KEYS) || v.version !== 1) return false;
  if (!isFirePlan(v.plan)) return false;
  if (typeof v.savings !== 'number' || !Number.isFinite(v.savings)) return false;
  if (v.currency !== null && !(typeof v.currency === 'string' && CURRENCY.test(v.currency))) return false;
  if (typeof v.inflation !== 'number' || !Number.isFinite(v.inflation) || v.inflation <= -1) return false;
  if (!isDay(v.day)) return false;
  if (typeof v.savedAt !== 'string' || Number.isNaN(Date.parse(v.savedAt))) return false;
  return typeof v.rev === 'string' && REV.test(v.rev);
}

/** What a save must meet: exactly the draft's fields, the plan as the Plan's
 *  own save takes it (parsePlan), and the figures in range. */
export function parseSavedDraft(raw: unknown): { ok: SavedPlanDraft } | { error: string } {
  if (!isObject(raw)) return { error: 'Send the plan to save, as an object' };
  const extra = Object.keys(raw).find((k) => !(DRAFT_KEYS as readonly string[]).includes(k));
  if (extra) return { error: `${extra.slice(0, 40)} isn’t taken here` };
  if (!exactly(raw, DRAFT_KEYS)) return { error: 'A saved plan has plan, savings, currency and inflation' };
  const parsed = parsePlan(raw.plan);
  if ('error' in parsed) return { error: `plan: ${parsed.error}` };
  if (typeof raw.savings !== 'number' || !Number.isFinite(raw.savings) || Math.abs(raw.savings) > MAX_SAVINGS) return { error: 'savings is an amount a year' };
  if (raw.currency !== null && !(typeof raw.currency === 'string' && CURRENCY.test(raw.currency))) return { error: 'currency is a currency code, such as USD, or null' };
  if (typeof raw.inflation !== 'number' || !Number.isFinite(raw.inflation) || raw.inflation < 0 || raw.inflation > MAX_INFLATION) {
    return { error: `inflation is a rate from 0% to ${MAX_INFLATION * 100}% a year` };
  }
  return { ok: { plan: parsed.plan, savings: raw.savings, currency: raw.currency, inflation: raw.inflation } };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A year in days, for the time between two days. */
export const YEAR_DAYS = 365.25;

/** Years from one UTC day to another (negative before it). */
export function yearsBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS / YEAR_DAYS;
}

/** Where the saved plan has invested assets on `day`, in that day's own
 *  money, growing from `start`, the measured balance on the `from` day (see
 *  the top of this file). The one function for the card's words and any
 *  line drawn from it. Null for a day before `from`, or a growth rate the
 *  formula doesn't take. */
export function plannedAt(saved: Pick<SavedPlan, 'plan' | 'savings' | 'inflation'>, start: { day: string; total: number }, day: string): number | null {
  const years = yearsBetween(start.day, day);
  if (!(years >= 0)) return null;
  const g = saved.plan.realReturn;
  if (!(g > -0.99 && g <= 1)) return null;
  return projectBalance(start.total, saved.savings, g, years) * (1 + saved.inflation) ** years;
}

/** What the comparison rests on that the Plan has changed since it was
 *  saved, in a few words each: its growth after inflation, include cash,
 *  and typed savings. Nothing else moves the comparison, so nothing else is
 *  said (a birthday's age, a new withdrawal rate). */
export function changedSince(saved: Pick<SavedPlan, 'plan'>, now: FirePlan): string[] {
  const out: string[] = [];
  if (saved.plan.realReturn !== now.realReturn) out.push('growth after inflation');
  if (saved.plan.includeCash !== now.includeCash) out.push('include cash');
  if (saved.plan.savings !== now.savings) out.push(now.savings === null ? 'savings, which follow Nya’s figure now' : 'the savings you typed');
  return out;
}
