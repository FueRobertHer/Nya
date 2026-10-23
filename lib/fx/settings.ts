// lib/fx/settings.ts
//
// The person's currency settings: the home currency they chose, if any, and
// their own exchange rates. One value store on the seam, in their container,
// encrypted under its key, in their download.
//
// ONLY THE PERSON CHOOSES. Nya never writes a home currency on its own, on any
// path: `home` stays null until the person picks one (app/api/currency), and
// while it is null nothing converts and every figure is what it was before
// conversion existed. A default worked out from the accounts would move every
// total whenever a bank failed to answer, an account was hidden or accounts
// were linked in some order (docs/architecture.md, "Exchange rates").
//
// `changes` records every choice and change, with its day, for what reads a
// past month's currency later. `own` holds the person's own rates
// (lib/fx/rates.ts OwnRate), a list in one value rather than a map: a map's
// ids are plain text in the database, and which currencies a person prices is
// theirs.
//
// READS. For showing figures, LENIENT (readSettingsForDisplay): settings that
// can't be read convert nothing, and say so, since nothing writes, deletes or
// records on a conversion. For a change, STRICT, through the store's update
// (a compare-and-set): never written over when they can't be read.

import { defineValueStore } from '../repo';
import type { Ctx } from '../containers';
import { isCalendarDay, isCurrencyCode, knownCurrency } from '../manual-txn-input';
import type { OwnRate } from './rates';
import { PRICED_CODE, rateTextError } from './rate-text';

export { PRICED_CODE, rateTextError };

export type HomeChange = { on: string; from: string | null; to: string | null };

export type CurrencySettings = {
  v: 1;
  /** The ISO code the person chose; null until they choose one. */
  home: string | null;
  /** Every choice and change of `home`, oldest first. */
  changes: HomeChange[];
  own: OwnRate[];
};

export const NO_SETTINGS: CurrencySettings = { v: 1, home: null, changes: [], own: [] };

/** Far more changes than anyone makes; each is about 40 bytes. */
export const MAX_CHANGES = 100;
/** More own rates than anyone needs, one per currency. */
export const MAX_OWN_RATES = 50;


const onlyKeys = (o: object, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** A home currency as it is chosen: an ISO code this runtime knows. For
 *  input only (the routes): the stored shape is checked by form alone
 *  (isCurrencyCode), since runtimes' lists differ (Bun's has 307 codes,
 *  Node 22's 162), and a value saved under one must never become
 *  unrecognised under the next. */
export const isHomeCurrency = (v: unknown): v is string => isCurrencyCode(v) && knownCurrency(v);

export function isOwnRate(v: unknown): v is OwnRate {
  if (!isRecord(v) || !onlyKeys(v, ['currency', 'rate', 'quote', 'from', 'set_at'])) return false;
  return (
    typeof v.currency === 'string' &&
    PRICED_CODE.test(v.currency) &&
    typeof v.rate === 'string' &&
    rateTextError(v.rate) === null &&
    typeof v.quote === 'string' &&
    isCurrencyCode(v.quote) &&
    v.quote !== v.currency &&
    (v.from === null || isCalendarDay(v.from)) &&
    isTime(v.set_at)
  );
}

function isChange(v: unknown): v is HomeChange {
  if (!isRecord(v) || !onlyKeys(v, ['on', 'from', 'to'])) return false;
  return isCalendarDay(v.on) && (v.from === null || isCurrencyCode(v.from)) && (v.to === null || isCurrencyCode(v.to));
}

/** The current shape, closed: a field this release doesn't know makes the
 *  whole value unrecognised, never one read without it. */
export function isCurrencySettings(v: unknown): v is CurrencySettings {
  if (!isRecord(v) || !onlyKeys(v, ['v', 'home', 'changes', 'own'])) return false;
  if (v.v !== 1 || !(v.home === null || isCurrencyCode(v.home))) return false;
  if (!Array.isArray(v.changes) || v.changes.length > MAX_CHANGES || !v.changes.every(isChange)) return false;
  if (!Array.isArray(v.own) || v.own.length > MAX_OWN_RATES || !v.own.every(isOwnRate)) return false;
  return new Set(v.own.map((o) => (o as OwnRate).currency)).size === v.own.length;
}

export const currencySettingsStore = defineValueStore<CurrencySettings>('currency-settings', {
  what: 'currency settings',
  isValid: isCurrencySettings,
  exportable: true, // the person's own choices
});

/** What showing figures reads: the settings, or none with why when they
 *  can't be used. LENIENT (see the header); a deployment problem throws. */
export async function readSettingsForDisplay(ctx: Ctx): Promise<{ settings: CurrencySettings; problem: 'unreadable' | 'unrecognised' | null }> {
  const { value, unreadable, unrecognised } = await currencySettingsStore.getReport(ctx);
  if (unreadable) return { settings: NO_SETTINGS, problem: 'unreadable' };
  if (unrecognised) return { settings: NO_SETTINGS, problem: 'unrecognised' };
  return { settings: value ?? NO_SETTINGS, problem: null };
}

// ---- Changes, as pure functions the route runs inside update() ----

export class SettingsRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsRefused';
  }
}

/**
 * The settings with `home` chosen (or cleared with null) on `day`: a change
 * recorded only when it differs. What it was given, the same value, when
 * nothing differs, so the store's update() writes nothing. One change a day:
 * a day's last choice is what counts for its month, so a second on the same
 * day takes the first's place (and one back to where the day began leaves
 * none). Past MAX_CHANGES the oldest is forgotten, never a choice refused.
 */
export function withHome(s: CurrencySettings | null, home: string | null, day: string): CurrencySettings | null {
  const current = s ?? NO_SETTINGS;
  if (current.home === home) return s;
  const changes = [...current.changes];
  const last = changes[changes.length - 1];
  if (last && last.on === day) {
    changes.pop();
    if (last.from !== home) changes.push({ on: day, from: last.from, to: home });
  } else {
    changes.push({ on: day, from: current.home, to: home });
  }
  return { ...current, home, changes: changes.slice(-MAX_CHANGES) };
}

/** The settings with this own rate, replacing any for its currency. */
export function withOwnRate(s: CurrencySettings | null, rate: OwnRate): CurrencySettings {
  const current = s ?? NO_SETTINGS;
  const others = current.own.filter((o) => o.currency !== rate.currency);
  if (others.length >= MAX_OWN_RATES) throw new SettingsRefused(`You have ${MAX_OWN_RATES} rates of your own, the most Nya keeps. Remove one first.`);
  return { ...current, own: [...others, rate].sort((a, b) => (a.currency < b.currency ? -1 : 1)) };
}

/** The settings without an own rate for `currency`; what it was given when
 *  there was none. */
export function withoutOwnRate(s: CurrencySettings | null, currency: string): CurrencySettings | null {
  if (!s || !s.own.some((o) => o.currency === currency)) return s;
  return { ...s, own: s.own.filter((o) => o.currency !== currency) };
}
