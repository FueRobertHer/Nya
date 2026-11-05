import { describe, expect, test } from 'bun:test';
import { DEFAULT_TAX_CHOICES, isTaxChoices, parseTaxChoices, taxHoldsAmounts, type TaxChoices } from '@/lib/fire/tax-choices';
import { isPlanEntry } from '@/lib/fire/copies';
import { DEFAULT_PLAN_V2 } from '@/lib/fire/plan-v2';
import { STATE_CODES } from '@/lib/fire/tax/law/types';

// A plan's tax choices as its entry holds them (lib/fire/tax-choices.ts): every
// field and enum value read, a release before anything writes them, and
// anything else refused, so a restore takes no field this release doesn't know.

const FULL: TaxChoices = {
  version: 1,
  state: 'CA',
  stateRate: 0.05,
  inflation: 0.03,
  health: {
    beforeMedicare: { kind: 'aca', adult: 7_200, quotedAge: 40, child: 3_000 },
    medicareExtra: 2_400,
    meetsMedicaidRule: ['you', 'partner'],
    countMedicaid: true,
    acaLaw: 'enhanced',
    growth: 2.1,
  },
  strategy: { order: 'roth-before-deferred', conversions: { kind: 'bracket', top: 0.12 }, convertUntil: 65 },
  savingsSplit: [
    { bucket: 'taxable', share: 0.5 },
    { bucket: 'roth', share: 0.5 },
  ],
  taxableYield: 0.018,
};

const withHealth = (over: object) => ({ ...FULL, health: { ...FULL.health, ...over } });
const withStrategy = (over: object) => ({ ...FULL, strategy: { ...FULL.strategy, ...over } });

describe('what reads', () => {
  test('every field filled, and every one that may be empty', () => {
    expect(isTaxChoices(FULL)).toBe(true);
    expect(isTaxChoices(JSON.parse(JSON.stringify(FULL)))).toBe(true);
    expect(isTaxChoices({ ...FULL, state: null, savingsSplit: null, taxableYield: null, health: { ...FULL.health, beforeMedicare: null, growth: null, meetsMedicaidRule: [] }, strategy: { ...FULL.strategy, convertUntil: null } })).toBe(true);
  });

  test('every enum value', () => {
    for (const state of STATE_CODES) expect(isTaxChoices({ ...FULL, state })).toBe(true);
    for (const acaLaw of ['2026', 'enhanced']) expect(isTaxChoices(withHealth({ acaLaw }))).toBe(true);
    for (const owner of ['you', 'partner']) expect(isTaxChoices(withHealth({ meetsMedicaidRule: [owner] }))).toBe(true);
    for (const order of ['standard', 'roth-before-deferred']) expect(isTaxChoices(withStrategy({ order }))).toBe(true);
    for (const bucket of ['taxable', 'tax-deferred', 'roth', 'hsa']) expect(isTaxChoices({ ...FULL, savingsSplit: [{ bucket, share: 1 }] })).toBe(true);
    for (const beforeMedicare of [{ kind: 'aca', adult: 1, quotedAge: 40, child: null }, { kind: 'other', yearly: 1 }]) expect(isTaxChoices(withHealth({ beforeMedicare }))).toBe(true);
    for (const conversions of [{ kind: 'none' }, { kind: 'fixed', yearly: 1 }]) expect(isTaxChoices(withStrategy({ conversions }))).toBe(true);
    for (const top of [0.1, 0.12, 0.22, 0.24]) expect(isTaxChoices(withStrategy({ conversions: { kind: 'bracket', top } }))).toBe(true);
    for (const top of [0.12, 0.22]) expect(isTaxChoices(withStrategy({ conversions: { kind: 'aca-then-bracket', top } }))).toBe(true);
  });

  test('types, never a range: what a later rule refuses still reads', () => {
    expect(isTaxChoices({ ...FULL, stateRate: 9 })).toBe(true);
    expect(isTaxChoices({ ...FULL, inflation: -1 })).toBe(true);
    expect(isTaxChoices(withStrategy({ convertUntil: 400 }))).toBe(true);
    expect(isTaxChoices({ ...FULL, savingsSplit: [{ bucket: 'roth', share: 7 }] })).toBe(true);
  });
});

describe('what doesn’t', () => {
  test('anything but this shape', () => {
    for (const v of [null, 'tax', 1, [], [FULL]]) expect(isTaxChoices(v)).toBe(false);
    expect(isTaxChoices({ ...FULL, version: 2 })).toBe(false);
    expect(isTaxChoices({ ...FULL, extra: 1 })).toBe(false);
    for (const key of Object.keys(FULL)) {
      const { [key as keyof TaxChoices]: _gone, ...missing } = FULL;
      expect([key, isTaxChoices(missing)]).toEqual([key, false]);
    }
    for (const key of Object.keys(FULL.health)) {
      const { [key as keyof TaxChoices['health']]: _gone, ...missing } = FULL.health;
      expect([key, isTaxChoices({ ...FULL, health: missing })]).toEqual([key, false]);
    }
    for (const key of Object.keys(FULL.strategy)) {
      const { [key as keyof TaxChoices['strategy']]: _gone, ...missing } = FULL.strategy;
      expect([key, isTaxChoices({ ...FULL, strategy: missing })]).toEqual([key, false]);
    }
    expect(isTaxChoices(withHealth({ extra: 1 }))).toBe(false);
    expect(isTaxChoices(withStrategy({ extra: 1 }))).toBe(false);
  });

  test('a value it doesn’t know', () => {
    expect(isTaxChoices({ ...FULL, state: 'PR' })).toBe(false);
    expect(isTaxChoices(withHealth({ acaLaw: '2027' }))).toBe(false);
    expect(isTaxChoices(withHealth({ meetsMedicaidRule: ['them'] }))).toBe(false);
    expect(isTaxChoices(withStrategy({ order: 'guess' }))).toBe(false);
    expect(isTaxChoices(withStrategy({ conversions: { kind: 'bracket', top: 0.32 } }))).toBe(false);
    expect(isTaxChoices(withStrategy({ conversions: { kind: 'aca-then-bracket', top: 0.1 } }))).toBe(false);
    expect(isTaxChoices(withStrategy({ conversions: { kind: 'all' } }))).toBe(false);
    expect(isTaxChoices({ ...FULL, savingsSplit: [{ bucket: 'education', share: 1 }] })).toBe(false);
    expect(isTaxChoices(withHealth({ beforeMedicare: { kind: 'employer', yearly: 1 } }))).toBe(false);
  });

  test('a union member with another member’s keys, or a wrong type', () => {
    expect(isTaxChoices(withHealth({ beforeMedicare: { kind: 'aca', yearly: 1 } }))).toBe(false);
    expect(isTaxChoices(withHealth({ beforeMedicare: { kind: 'other', yearly: 1, adult: 1 } }))).toBe(false);
    expect(isTaxChoices(withHealth({ beforeMedicare: { kind: 'aca', adult: '1', quotedAge: 40, child: null } }))).toBe(false);
    expect(isTaxChoices(withStrategy({ conversions: { kind: 'none', top: 0.1 } }))).toBe(false);
    expect(isTaxChoices(withStrategy({ conversions: { kind: 'fixed', yearly: Number.NaN } }))).toBe(false);
    expect(isTaxChoices({ ...FULL, stateRate: '0.05' })).toBe(false);
    expect(isTaxChoices({ ...FULL, taxableYield: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isTaxChoices(withHealth({ countMedicaid: 'yes' }))).toBe(false);
    expect(isTaxChoices({ ...FULL, savingsSplit: {} })).toBe(false);
  });
});

describe('an entry', () => {
  const entry = { name: 'First plan', plan: DEFAULT_PLAN_V2, currency: null, createdAt: 'a', updatedAt: 'b' };

  test('holds choices, or none', () => {
    expect(isPlanEntry({ ...entry, tax: null })).toBe(true);
    expect(isPlanEntry({ ...entry, tax: FULL })).toBe(true);
  });

  test('refuses anything else, as a newer release’s', () => {
    expect(isPlanEntry({ ...entry, tax: { filing: 'single' } })).toBe(false);
    expect(isPlanEntry({ ...entry, tax: { ...FULL, version: 2 } })).toBe(false);
  });
});

describe('what a page may write', () => {
  const taken = (v: unknown, stored: TaxChoices | null = null) => 'choices' in parseTaxChoices(v, stored);

  test('the defaults, which read as stored choices too', () => {
    expect(isTaxChoices(DEFAULT_TAX_CHOICES)).toBe(true);
    expect(taken(DEFAULT_TAX_CHOICES)).toBe(true);
  });

  test('every range', () => {
    const health = (over: object) => ({ ...DEFAULT_TAX_CHOICES, health: { ...DEFAULT_TAX_CHOICES.health, ...over } });
    expect(taken({ ...DEFAULT_TAX_CHOICES, stateRate: 0.2 })).toBe(true);
    expect(taken({ ...DEFAULT_TAX_CHOICES, stateRate: 0.21 })).toBe(false);
    expect(taken({ ...DEFAULT_TAX_CHOICES, stateRate: -0.01 })).toBe(false);
    expect(taken({ ...DEFAULT_TAX_CHOICES, inflation: 0.3 })).toBe(false);
    expect(taken({ ...DEFAULT_TAX_CHOICES, taxableYield: 0.018 })).toBe(true);
    expect(taken({ ...DEFAULT_TAX_CHOICES, taxableYield: 0.5 })).toBe(false);
    expect(taken(health({ beforeMedicare: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null } }))).toBe(true);
    expect(taken(health({ beforeMedicare: { kind: 'aca', adult: 11_000, quotedAge: 65, child: null } }))).toBe(false);
    expect(taken(health({ beforeMedicare: { kind: 'aca', adult: 11_000, quotedAge: 50.5, child: null } }))).toBe(false);
    expect(taken(health({ beforeMedicare: { kind: 'aca', adult: -1, quotedAge: 50, child: null } }))).toBe(false);
    expect(taken(health({ beforeMedicare: { kind: 'aca', adult: 1, quotedAge: 50, child: -1 } }))).toBe(false);
    expect(taken(health({ beforeMedicare: { kind: 'other', yearly: 2_000_000 } }))).toBe(false);
    expect(taken(health({ medicareExtra: -1 }))).toBe(false);
    expect(taken(health({ meetsMedicaidRule: ['you', 'you'] }))).toBe(false);
    expect(taken(health({ growth: 0.021 }))).toBe(true);
    expect(taken(health({ growth: 2.1 }))).toBe(false);
  });

  test('a split is each bucket once, and adds up', () => {
    const split = (savingsSplit: unknown) => ({ ...DEFAULT_TAX_CHOICES, savingsSplit });
    expect(taken(split([{ bucket: 'roth', share: 0.4 }, { bucket: 'taxable', share: 0.6 }]))).toBe(true);
    expect(taken(split([{ bucket: 'roth', share: 0.4 }, { bucket: 'taxable', share: 0.5 }]))).toBe(false);
    expect(taken(split([{ bucket: 'roth', share: 0.5 }, { bucket: 'roth', share: 0.5 }]))).toBe(false);
    expect(taken(split([]))).toBe(false);
  });

  test('anything but the closed shape', () => {
    for (const v of [null, 'tax', [], { ...DEFAULT_TAX_CHOICES, extra: 1 }, { ...DEFAULT_TAX_CHOICES, version: 2 }, { ...DEFAULT_TAX_CHOICES, state: 'PR' }]) expect(taken(v)).toBe(false);
  });

  test('a change of strategy waits for T4; one already stored is no change, and going back is one', () => {
    const later = { ...DEFAULT_TAX_CHOICES, strategy: { order: 'roth-before-deferred', conversions: { kind: 'bracket', top: 0.12 }, convertUntil: 65 } } as TaxChoices;
    expect(taken(later)).toBe(false);
    expect(taken(later, DEFAULT_TAX_CHOICES)).toBe(false);
    expect(taken(later, later)).toBe(true);
    expect(taken(DEFAULT_TAX_CHOICES, later)).toBe(true);
    const other = { ...later, strategy: { ...later.strategy, convertUntil: 70 } };
    expect(taken(other, later)).toBe(false);
  });
});

describe('holding amounts', () => {
  test('a benchmark, a typed cost, Part D or a fixed conversion; a rate is none', () => {
    expect(taxHoldsAmounts(null)).toBe(false);
    expect(taxHoldsAmounts(DEFAULT_TAX_CHOICES)).toBe(false);
    expect(taxHoldsAmounts({ ...DEFAULT_TAX_CHOICES, state: 'CA', stateRate: 0.05, taxableYield: 0.02 })).toBe(false);
    const health = (over: object) => ({ ...DEFAULT_TAX_CHOICES, health: { ...DEFAULT_TAX_CHOICES.health, ...over } }) as TaxChoices;
    expect(taxHoldsAmounts(health({ beforeMedicare: { kind: 'aca', adult: 11_000, quotedAge: 50, child: null } }))).toBe(true);
    expect(taxHoldsAmounts(health({ beforeMedicare: { kind: 'aca', adult: 0, quotedAge: 50, child: 3_000 } }))).toBe(true);
    expect(taxHoldsAmounts(health({ beforeMedicare: { kind: 'aca', adult: 0, quotedAge: 50, child: null } }))).toBe(false);
    expect(taxHoldsAmounts(health({ beforeMedicare: { kind: 'other', yearly: 9_600 } }))).toBe(true);
    expect(taxHoldsAmounts(health({ medicareExtra: 2_400 }))).toBe(true);
    expect(taxHoldsAmounts({ ...DEFAULT_TAX_CHOICES, strategy: { order: 'standard', conversions: { kind: 'fixed', yearly: 10_000 }, convertUntil: null } })).toBe(true);
  });
});
