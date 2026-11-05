// lib/fire/tax-choices.ts
//
// The tax choices: one plan's half of the tax profile, in its entry's `tax`
// (lib/fire/copies.ts), each plan with its own. The household's half is the
// tax facts (lib/fire/tax-facts.ts), one set for every plan.
//
// READS TAKE WHAT ANY RELEASE WROTE: isTaxChoices checks the shape and types,
// never a range. This is the first reader (T2), knowing every field and every
// enum value a release before anything writes them (T3), so a rollback from
// the first writer loses nothing. A range is the writer's (parseTaxChoices).
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

// ---- Writes ----

/** A plan's choices before anyone has made one: no state, no coverage, the
 *  standard order, no conversions, measured savings and yield. */
export const DEFAULT_TAX_CHOICES: TaxChoices = {
  version: 1,
  state: null,
  stateRate: 0,
  inflation: 0.03,
  health: { beforeMedicare: null, medicareExtra: 0, meetsMedicaidRule: [], countMedicaid: false, acaLaw: '2026', growth: null },
  strategy: { order: 'standard', conversions: { kind: 'none' }, convertUntil: null },
  savingsSplit: null,
  taxableYield: null,
};

/** More than any one household's coverage could cost in a year. */
export const MAX_HEALTH_AMOUNT = 1_000_000;
/** More than any state's top rate. */
export const MAX_STATE_RATE = 0.2;
export const MAX_RATE = 0.2;
/** A year over prices, as a fraction as the law tables hold it: far past any projection. */
const HEALTH_GROWTH_RANGE = { low: -0.05, high: 0.1 };
/** The age curve's last age, where a benchmark can be quoted. */
const LAST_QUOTED_AGE = 64;

const amount = (v: unknown, max: number) => isNumber(v) && v >= 0 && v <= max;

function beforeMedicareError(v: unknown): string | null {
  if (!isBeforeMedicare(v)) return 'beforeMedicare is the ACA’s benchmark, a yearly cost, or null';
  if (v === null) return null;
  const b = v as Exclude<BeforeMedicare, null>;
  if (b.kind === 'other') return amount(b.yearly, MAX_HEALTH_AMOUNT) ? null : `A yearly cost is at most ${MAX_HEALTH_AMOUNT}`;
  if (!amount(b.adult, MAX_HEALTH_AMOUNT) || (b.child !== null && !amount(b.child, MAX_HEALTH_AMOUNT))) return `A benchmark is at most ${MAX_HEALTH_AMOUNT} a year`;
  return Number.isInteger(b.quotedAge) && b.quotedAge >= 0 && b.quotedAge <= LAST_QUOTED_AGE ? null : `The quoted age is a whole number up to ${LAST_QUOTED_AGE}`;
}

function healthError(v: unknown): string | null {
  if (!isHealth(v)) return 'health is coverage before Medicare, Part D or a supplement, the Medicaid answers, the ACA’s law and health growth';
  const h = v as TaxChoices['health'];
  const before = beforeMedicareError(h.beforeMedicare);
  if (before) return before;
  if (!amount(h.medicareExtra, MAX_HEALTH_AMOUNT)) return `Part D or a supplement is at most ${MAX_HEALTH_AMOUNT} a year`;
  if (new Set(h.meetsMedicaidRule).size !== h.meetsMedicaidRule.length) return 'Each person answers the Medicaid rule once';
  if (h.growth !== null && (h.growth < HEALTH_GROWTH_RANGE.low || h.growth > HEALTH_GROWTH_RANGE.high)) return 'Health growth is from -5 to 10 points a year';
  return null;
}

function splitError(v: unknown): string | null {
  if (!isSavingsSplit(v)) return 'savingsSplit is each bucket’s share, or null';
  if (v === null) return null;
  const rows = v as NonNullable<TaxChoices['savingsSplit']>;
  if (rows.length === 0) return 'savingsSplit needs at least one bucket, or null';
  if (new Set(rows.map((r) => r.bucket)).size !== rows.length) return 'Each bucket comes once in savingsSplit';
  if (rows.some((r) => !(r.share >= 0 && r.share <= 1))) return 'A bucket’s share is from 0 to 1';
  return Math.abs(rows.reduce((sum, r) => sum + r.share, 0) - 1) <= 1e-6 ? null : 'The shares of savingsSplit add up to 100%';
}

/** The most a fixed conversion can be, a year. */
export const MAX_YEARLY_CONVERSION = 1e9;

/** A strategy's ranges: the age a rule runs to, and what a fixed amount can be. */
function strategyError(s: TaxChoices['strategy']): string | null {
  if (s.convertUntil !== null && !(Number.isInteger(s.convertUntil) && s.convertUntil >= 18 && s.convertUntil <= 100)) return 'Conversions run until a whole age from 18 to 100';
  if (s.conversions.kind === 'fixed' && !amount(s.conversions.yearly, MAX_YEARLY_CONVERSION)) return 'A conversion is at most 1,000,000,000 a year';
  return null;
}

/**
 * What a page sent, or why it isn't choices this takes: the writer's rules,
 * which the reader above doesn't hold. The ranges of a strategy hold of a change
 * to it: a save beside what is stored (`stored`, after a rollback from a later
 * release, say) goes through, so nobody is trapped.
 */
export function parseTaxChoices(v: unknown, stored: TaxChoices | null): { choices: TaxChoices } | { error: string } {
  if (!isObject(v) || !closed(v, KEYS)) return { error: 'Send every choice, as JSON' };
  if (v.version !== 1) return { error: 'version is 1' };
  if (v.state !== null && !STATE_CODES.includes(v.state as StateCode)) return { error: 'state is a state’s code, or null' };
  if (!amount(v.stateRate, MAX_STATE_RATE)) return { error: 'A state’s rate is from 0 to 20%' };
  if (!amount(v.inflation, MAX_RATE)) return { error: 'Inflation is from 0 to 20%' };
  const health = healthError(v.health);
  if (health) return { error: health };
  if (!isStrategy(v.strategy)) return { error: 'strategy is the order, conversions and when they stop' };
  const split = splitError(v.savingsSplit);
  if (split) return { error: split };
  if (v.taxableYield !== null && !amount(v.taxableYield, MAX_RATE)) return { error: 'The taxable yield is from 0 to 20%' };
  const choices = v as TaxChoices;
  if (JSON.stringify(choices.strategy) !== JSON.stringify((stored ?? DEFAULT_TAX_CHOICES).strategy)) {
    const strategy = strategyError(choices.strategy);
    if (strategy) return { error: strategy };
  }
  return { choices };
}

/** Whether the choices hold an amount typed in the plan's currency. A plan whose
 *  only amount is a benchmark holds a currency all the same. */
export function taxHoldsAmounts(tax: TaxChoices | null): boolean {
  if (tax === null) return false;
  const before = tax.health.beforeMedicare;
  if (before !== null && (before.kind === 'aca' ? before.adult > 0 || (before.child ?? 0) > 0 : before.yearly > 0)) return true;
  return tax.health.medicareExtra > 0 || (tax.strategy.conversions.kind === 'fixed' && tax.strategy.conversions.yearly > 0);
}
