// lib/debt-payoff-store.ts
//
// The person's debt payoff plan inputs (rates, monthly payments, order,
// extra payment, left-out debts, accrued interest and shared-minimum choices).
// One encrypted JSON value per container, replaced whole on every save: a
// value store on the storage seam (lib/repo.ts).
//
// Reads are strict: a saved plan that can't be read throws
// StoredDataUnreadableError, never "no plan", so the next save never silently
// overwrites what is there. Never saved reads as null.

import { defineValueStore } from './repo';
import type { Strategy, TypedTerms } from './payoff';

export type StoredPayoffInputs = {
  v: 1;
  strategy: Strategy;
  currency: string | null;
  extra: Record<string, string>;
  leftOut: Record<string, boolean>;
  withoutAccrued: Record<string, boolean>;
  sharedSplit: Record<string, boolean>;
  typed: Record<string, TypedTerms>;
};

const TOP_KEYS = new Set(['v', 'strategy', 'currency', 'extra', 'leftOut', 'withoutAccrued', 'sharedSplit', 'typed']);
const TYPED_KEYS = new Set(['apr', 'minimum']);

const MAX_ACCOUNTS = 200;
const MAX_CURRENCIES = 20;
const MAX_KEY_LEN = 128;
const MAX_VAL_LEN = 32;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every((x) => typeof x === 'string');
}

function isBoolRecord(v: unknown): v is Record<string, boolean> {
  if (!isPlainObject(v)) return false;
  return Object.values(v).every((x) => typeof x === 'boolean');
}

function isTypedTerms(v: unknown): v is TypedTerms {
  if (!isPlainObject(v)) return false;
  for (const [k, val] of Object.entries(v)) {
    if (!TYPED_KEYS.has(k)) return false;
    if (val !== undefined && typeof val !== 'string') return false;
  }
  return true;
}

/** Closed-shape type guard for stored debt payoff inputs (v1). Rejects unknown
 *  fields so a future version's shape is flagged as unrecognised rather than
 *  silently dropped on save. */
export function isStoredPayoffInputs(v: unknown): v is StoredPayoffInputs {
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) if (!TOP_KEYS.has(k)) return false;
  if (v.v !== 1) return false;
  if (v.strategy !== 'avalanche' && v.strategy !== 'snowball') return false;
  if (v.currency !== null && typeof v.currency !== 'string') return false;
  if (!isStringRecord(v.extra)) return false;
  if (!isBoolRecord(v.leftOut)) return false;
  if (!isBoolRecord(v.withoutAccrued)) return false;
  if (!isBoolRecord(v.sharedSplit)) return false;
  if (!isPlainObject(v.typed)) return false;
  for (const terms of Object.values(v.typed)) if (!isTypedTerms(terms)) return false;
  return true;
}

/** Validates and normalises a client payload before writing to the store. */
export function parseStoredPayoffInputs(raw: unknown): { plan: StoredPayoffInputs } | { error: string } {
  if (!isPlainObject(raw)) return { error: 'plan must be an object' };
  const strategy = raw.strategy;
  if (strategy !== 'avalanche' && strategy !== 'snowball') return { error: 'strategy must be avalanche or snowball' };
  const currency = raw.currency === undefined ? null : raw.currency;
  if (currency !== null && (typeof currency !== 'string' || currency.length > 16)) return { error: 'currency must be a currency code or null' };

  if (!isStringRecord(raw.extra)) return { error: 'extra must be a map of strings' };
  const extraEntries = Object.entries(raw.extra);
  if (extraEntries.length > MAX_CURRENCIES) return { error: 'too many currencies in extra' };
  const extra: Record<string, string> = {};
  for (const [k, val] of extraEntries) {
    if (k.length > 16 || val.length > MAX_VAL_LEN) return { error: 'invalid extra entry' };
    if (val !== '') extra[k] = val;
  }

  const cleanBools = (src: unknown, field: string): { ok: true; value: Record<string, boolean> } | { ok: false; error: string } => {
    if (!isBoolRecord(src)) return { ok: false, error: `${field} must be a map of booleans` };
    const entries = Object.entries(src);
    if (entries.length > MAX_ACCOUNTS) return { ok: false, error: `too many entries in ${field}` };
    const out: Record<string, boolean> = {};
    for (const [k, val] of entries) {
      if (!k || k.length > MAX_KEY_LEN) return { ok: false, error: `invalid key in ${field}` };
      out[k] = val;
    }
    return { ok: true, value: out };
  };
  const leftOut = cleanBools(raw.leftOut, 'leftOut');
  if (!leftOut.ok) return { error: leftOut.error };
  const withoutAccrued = cleanBools(raw.withoutAccrued, 'withoutAccrued');
  if (!withoutAccrued.ok) return { error: withoutAccrued.error };
  const sharedSplit = cleanBools(raw.sharedSplit, 'sharedSplit');
  if (!sharedSplit.ok) return { error: sharedSplit.error };

  if (!isPlainObject(raw.typed)) return { error: 'typed must be a map of terms' };
  const typedEntries = Object.entries(raw.typed);
  if (typedEntries.length > MAX_ACCOUNTS) return { error: 'too many entries in typed' };
  const typed: Record<string, TypedTerms> = {};
  for (const [k, terms] of typedEntries) {
    if (!k || k.length > MAX_KEY_LEN || !isTypedTerms(terms)) return { error: 'invalid typed entry' };
    const clean: TypedTerms = {};
    if (terms.apr !== undefined) {
      if (terms.apr.length > MAX_VAL_LEN) return { error: 'invalid apr value' };
      clean.apr = terms.apr;
    }
    if (terms.minimum !== undefined) {
      if (terms.minimum.length > MAX_VAL_LEN) return { error: 'invalid payment value' };
      clean.minimum = terms.minimum;
    }
    if (clean.apr !== undefined || clean.minimum !== undefined) typed[k] = clean;
  }

  return {
    plan: {
      v: 1,
      strategy,
      currency,
      extra,
      leftOut: leftOut.value,
      withoutAccrued: withoutAccrued.value,
      sharedSplit: sharedSplit.value,
      typed,
    },
  };
}

export const debtPayoffStore = defineValueStore<StoredPayoffInputs>('debt-payoff', {
  what: 'your debt payoff plan',
  isValid: isStoredPayoffInputs,
  exportable: true, // user-entered rates, payments and payoff choices
});
