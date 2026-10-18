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

/** An ISO code, or Plaid's unofficial one (a cryptocurrency's), as the API's
 *  currency argument takes it (lib/api-spec.ts). */
export const PRICED_CODE = /^[A-Z0-9]{2,10}$/;
/** A rate as typed: digits with a full stop, no more than 12 significant
 *  digits, between 1e-12 and 1e12. */
const RATE_TEXT = /^(\d{1,13})(?:\.(\d{1,24}))?$/;
const MIN_RATE = 1e-12;
const MAX_RATE = 1e12;

const onlyKeys = (o: object, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isTime = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** A home currency: an ISO code this runtime knows. */
export const isHomeCurrency = (v: unknown): v is string => isCurrencyCode(v) && knownCurrency(v);

/** Why rate text can't be a rate, or null when it can. */
export function rateTextError(text: string): string | null {
  if (/^\s*\d+,\d+\s*$/.test(text)) return `Use a full stop for decimals: ${text.trim().replace(',', '.')}.`;
  const m = RATE_TEXT.exec(text);
  if (!m) return 'A rate is a number, like 0.92 or 61000.';
  const digits = (m[1] + (m[2] ?? '')).replace(/^0+/, '').replace(/0+$/, '');
  if (digits.length > 12) return 'A rate has at most 12 significant digits.';
  const value = Number(text);
  if (!(value >= MIN_RATE)) return 'A rate is more than zero.';
  if (value > MAX_RATE) return 'That rate is too large.';
  return null;
}

export function isOwnRate(v: unknown): v is OwnRate {
  if (!isRecord(v) || !onlyKeys(v, ['currency', 'rate', 'quote', 'from', 'set_at'])) return false;
  return (
    typeof v.currency === 'string' &&
    PRICED_CODE.test(v.currency) &&
    typeof v.rate === 'string' &&
    rateTextError(v.rate) === null &&
    typeof v.quote === 'string' &&
    (v.quote === 'EUR' || isHomeCurrency(v.quote)) &&
    v.quote !== v.currency &&
    (v.from === null || isCalendarDay(v.from)) &&
    isTime(v.set_at)
  );
}

function isChange(v: unknown): v is HomeChange {
  if (!isRecord(v) || !onlyKeys(v, ['on', 'from', 'to'])) return false;
  return isCalendarDay(v.on) && (v.from === null || isHomeCurrency(v.from)) && (v.to === null || isHomeCurrency(v.to));
}

/** The current shape, closed: a field this release doesn't know makes the
 *  whole value unrecognised, never one read without it. */
export function isCurrencySettings(v: unknown): v is CurrencySettings {
  if (!isRecord(v) || !onlyKeys(v, ['v', 'home', 'changes', 'own'])) return false;
  if (v.v !== 1 || !(v.home === null || isHomeCurrency(v.home))) return false;
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

/** The settings with `home` chosen (or cleared with null) on `day`: a change
 *  recorded only when it differs. What it was given, the same value, when
 *  nothing differs, so the store's update() writes nothing. */
export function withHome(s: CurrencySettings | null, home: string | null, day: string): CurrencySettings | null {
  const current = s ?? NO_SETTINGS;
  if (current.home === home) return s;
  if (current.changes.length >= MAX_CHANGES) throw new SettingsRefused(`The home currency has been changed ${MAX_CHANGES} times, the most Nya keeps.`);
  return { ...current, home, changes: [...current.changes, { on: day, from: current.home, to: home }] };
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
