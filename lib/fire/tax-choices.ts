// lib/fire/tax-choices.ts
//
// The tax choices: one plan's half of the tax profile, in its entry's `tax`
// (lib/fire/copies.ts), each plan with its own. The household's half is the
// tax facts (lib/fire/tax-facts.ts), one set for every plan.
//
// READS TAKE WHAT ANY RELEASE WROTE: isTaxChoices checks the shape and types,
// never a range. This is the first reader (T2), knowing every field and every
// enum value a release before anything writes them (T3), so a rollback from
// the first writer loses nothing. Nothing here reaches the page yet.
//
// CLOSED, AND EVERY FIELD LOOKED AT, so a restore takes no field this release
// doesn't know (lib/user-restore/check.ts unknownField).
//
// Pure, importing only the law's state codes: the next release holds it byte
// for byte as its release before's (test/release-before.test.ts).

import type { Owner } from './tax-facts';
import { STATE_CODES, type StateCode } from './tax/law/types';

/** What pays for coverage before Medicare: the ACA's benchmark, or a yearly
 *  amount the person typed. */
export type BeforeMedicare = { kind: 'aca'; adult: number; quotedAge: number; child: number | null } | { kind: 'other'; yearly: number } | null;

export type Conversions = { kind: 'none' } | { kind: 'bracket'; top: 0.1 | 0.12 | 0.22 | 0.24 } | { kind: 'aca-then-bracket'; top: 0.12 | 0.22 } | { kind: 'fixed'; yearly: number };

/** A bucket new savings can go to: a child's education isn't one. */
export type SavingsBucket = 'taxable' | 'tax-deferred' | 'roth' | 'hsa';

export type TaxChoices = {
  version: 1;
  state: StateCode | null;
  /** On ordinary income and gains. */
  stateRate: number;
  /** For thresholds the law doesn't index. */
  inflation: number;
  health: {
    beforeMedicare: BeforeMedicare;
    /** Part D and a supplement, a year. */
    medicareExtra: number;
    /** Who meets the work or community engagement rule, from 2027. */
    meetsMedicaidRule: Owner[];
    countMedicaid: boolean;
    acaLaw: '2026' | 'enhanced';
    /** Points a year health costs rise faster than prices; null: the law
     *  tables' default. */
    growth: number | null;
  };
  strategy: {
    order: 'standard' | 'roth-before-deferred';
    conversions: Conversions;
    convertUntil: number | null;
  };
  /** Null: measured. */
  savingsSplit: { bucket: SavingsBucket; share: number }[] | null;
  /** Null: measured. */
  taxableYield: number | null;
};

const KEYS = ['version', 'state', 'stateRate', 'inflation', 'health', 'strategy', 'savingsSplit', 'taxableYield'];
const HEALTH_KEYS = ['beforeMedicare', 'medicareExtra', 'meetsMedicaidRule', 'countMedicaid', 'acaLaw', 'growth'];
const STRATEGY_KEYS = ['order', 'conversions', 'convertUntil'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const closed = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numberOrNull = (v: unknown) => v === null || isNumber(v);

function isBeforeMedicare(v: unknown): boolean {
  if (v === null) return true;
  if (!isObject(v)) return false;
  if (v.kind === 'aca') return closed(v, ['kind', 'adult', 'quotedAge', 'child']) && isNumber(v.adult) && isNumber(v.quotedAge) && numberOrNull(v.child);
  return v.kind === 'other' && closed(v, ['kind', 'yearly']) && isNumber(v.yearly);
}

function isConversions(v: unknown): boolean {
  if (!isObject(v)) return false;
  if (v.kind === 'none') return closed(v, ['kind']);
  if (v.kind === 'bracket') return closed(v, ['kind', 'top']) && (v.top === 0.1 || v.top === 0.12 || v.top === 0.22 || v.top === 0.24);
  if (v.kind === 'aca-then-bracket') return closed(v, ['kind', 'top']) && (v.top === 0.12 || v.top === 0.22);
  return v.kind === 'fixed' && closed(v, ['kind', 'yearly']) && isNumber(v.yearly);
}

function isHealth(v: unknown): boolean {
  if (!isObject(v) || !closed(v, HEALTH_KEYS)) return false;
  return (
    isBeforeMedicare(v.beforeMedicare) &&
    isNumber(v.medicareExtra) &&
    Array.isArray(v.meetsMedicaidRule) &&
    v.meetsMedicaidRule.every((o) => o === 'you' || o === 'partner') &&
    typeof v.countMedicaid === 'boolean' &&
    (v.acaLaw === '2026' || v.acaLaw === 'enhanced') &&
    numberOrNull(v.growth)
  );
}

function isStrategy(v: unknown): boolean {
  if (!isObject(v) || !closed(v, STRATEGY_KEYS)) return false;
  return (v.order === 'standard' || v.order === 'roth-before-deferred') && isConversions(v.conversions) && numberOrNull(v.convertUntil);
}

function isSavingsSplit(v: unknown): boolean {
  if (v === null) return true;
  return (
    Array.isArray(v) &&
    v.every((x) => isObject(x) && closed(x, ['bucket', 'share']) && (x.bucket === 'taxable' || x.bucket === 'tax-deferred' || x.bucket === 'roth' || x.bucket === 'hsa') && isNumber(x.share))
  );
}

/** Whether a value is a plan's tax choices as stored: the shape and types. */
export function isTaxChoices(v: unknown): v is TaxChoices {
  if (!isObject(v) || !closed(v, KEYS) || v.version !== 1) return false;
  if (v.state !== null && !STATE_CODES.includes(v.state as StateCode)) return false;
  return isNumber(v.stateRate) && isNumber(v.inflation) && isHealth(v.health) && isStrategy(v.strategy) && isSavingsSplit(v.savingsSplit) && numberOrNull(v.taxableYield);
}
