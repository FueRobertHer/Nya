import { describe, expect, test } from 'bun:test';
import { DEFAULT_TAX_FACTS, MAX_DEPENDENTS, applyTaxFactOp, householdOf, isTaxFacts, parseHousehold, parseTaxFactOp, sameHousehold, type TaxFacts } from '@/lib/fire/tax-facts';

// The tax facts as `plan-facts` version 2 holds them (lib/fire/tax-facts.ts):
// every field and enum value read, a release before anything writes them, and
// anything else refused, so a restore takes no field this release doesn't know.

const FULL: TaxFacts = {
  version: 1,
  model: 'detailed',
  filing: 'joint',
  birthYears: [
    { owner: 'you', year: 1959 },
    { owner: 'partner', year: 1961 },
  ],
  dependents: [{ id: 'kid-1', untilAge: 18 }],
  rothContributions: [
    { owner: 'you', amount: 45_000 },
    { owner: 'partner', amount: 0 },
  ],
  owners: [{ account_id: 'acc_1.a:b=c-d', owner: 'partner' }],
  basis: [{ account_id: 'acc_2', amount: 105_000.5 }],
  countAnyway: ['acc_529', 'manual_3'],
  paidToday: { kind: 'tag', name: 'Health insurance (family)' },
};

describe('what reads', () => {
  test('the facts before anyone has given one, and every field filled', () => {
    expect(isTaxFacts(DEFAULT_TAX_FACTS)).toBe(true);
    expect(isTaxFacts(FULL)).toBe(true);
    expect(isTaxFacts(JSON.parse(JSON.stringify(FULL)))).toBe(true);
  });

  test('every enum value', () => {
    for (const model of ['flat', 'detailed'] as const) expect(isTaxFacts({ ...FULL, model })).toBe(true);
    for (const filing of ['single', 'joint', null] as const) expect(isTaxFacts({ ...FULL, filing })).toBe(true);
    for (const kind of ['category', 'tag'] as const) expect(isTaxFacts({ ...FULL, paidToday: { kind, name: 'x' } })).toBe(true);
    expect(isTaxFacts({ ...FULL, paidToday: null })).toBe(true);
    for (const owner of ['you', 'partner'] as const) {
      expect(isTaxFacts({ ...FULL, owners: [{ account_id: 'a', owner }] })).toBe(true);
      expect(isTaxFacts({ ...FULL, birthYears: [{ owner, year: 1960 }] })).toBe(true);
      expect(isTaxFacts({ ...FULL, rothContributions: [{ owner, amount: 1 }] })).toBe(true);
    }
  });

  test('types, never a range: what a later rule refuses still reads', () => {
    expect(isTaxFacts({ ...FULL, birthYears: [{ owner: 'you', year: 1 }] })).toBe(true);
    expect(isTaxFacts({ ...FULL, dependents: [{ id: 'k', untilAge: 200 }] })).toBe(true);
    expect(isTaxFacts({ ...FULL, basis: [{ account_id: 'a', amount: -1 }] })).toBe(true);
    // A category or tag's own name, whatever it holds.
    expect(isTaxFacts({ ...FULL, paidToday: { kind: 'category', name: 'a\u0001b' } })).toBe(true);
    expect(isTaxFacts({ ...FULL, paidToday: { kind: 'tag', name: '' } })).toBe(true);
    expect(isTaxFacts({ ...FULL, countAnyway: [''] })).toBe(true);
  });
});

describe('what doesn’t', () => {
  test('anything but this shape', () => {
    for (const v of [null, 'facts', 1, [], [FULL]]) expect(isTaxFacts(v)).toBe(false);
    expect(isTaxFacts({ ...FULL, version: 2 })).toBe(false);
    expect(isTaxFacts({ ...FULL, extra: 1 })).toBe(false);
    for (const key of Object.keys(FULL)) {
      const { [key as keyof TaxFacts]: _gone, ...missing } = FULL;
      expect([key, isTaxFacts(missing)]).toEqual([key, false]);
    }
  });

  test('an enum value it doesn’t know', () => {
    expect(isTaxFacts({ ...FULL, model: 'guess' })).toBe(false);
    expect(isTaxFacts({ ...FULL, filing: 'married' })).toBe(false);
    expect(isTaxFacts({ ...FULL, owners: [{ account_id: 'a', owner: 'them' }] })).toBe(false);
    expect(isTaxFacts({ ...FULL, birthYears: [{ owner: 'them', year: 1960 }] })).toBe(false);
    expect(isTaxFacts({ ...FULL, rothContributions: [{ owner: 'them', amount: 1 }] })).toBe(false);
    expect(isTaxFacts({ ...FULL, paidToday: { kind: 'merchant', name: 'x' } })).toBe(false);
  });

  test('a list item with another shape or type', () => {
    const lists: [keyof TaxFacts, unknown][] = [
      ['birthYears', { owner: 'you' }],
      ['birthYears', { owner: 'you', year: '1960' }],
      ['birthYears', { owner: 'you', year: 1960, extra: 1 }],
      ['dependents', { id: 'k', untilAge: null }],
      ['dependents', { id: 7, untilAge: 18 }],
      ['rothContributions', { owner: 'you', amount: Number.NaN }],
      ['rothContributions', { owner: 'you', amount: Number.POSITIVE_INFINITY }],
      ['owners', { account_id: 7, owner: 'you' }],
      ['basis', { account_id: 'a', amount: '1' }],
      ['countAnyway', 7],
    ];
    for (const [key, item] of lists) expect([key, item, isTaxFacts({ ...FULL, [key]: [item] })]).toEqual([key, item, false]);
    for (const key of ['birthYears', 'dependents', 'rothContributions', 'owners', 'basis', 'countAnyway'] as const) {
      expect([key, isTaxFacts({ ...FULL, [key]: null })]).toEqual([key, false]);
      expect([key, isTaxFacts({ ...FULL, [key]: {} })]).toEqual([key, false]);
    }
  });

  test('coverage already paid of another shape', () => {
    expect(isTaxFacts({ ...FULL, paidToday: 'Health insurance' })).toBe(false);
    expect(isTaxFacts({ ...FULL, paidToday: { kind: 'tag' } })).toBe(false);
    expect(isTaxFacts({ ...FULL, paidToday: { kind: 'tag', name: 7 } })).toBe(false);
    expect(isTaxFacts({ ...FULL, paidToday: { kind: 'tag', name: 'x', extra: 1 } })).toBe(false);
  });
});

describe('the model', () => {
  test('the opt-in and back to flat are ops, and nothing else moves the model', () => {
    expect(parseTaxFactOp({ kind: 'opt-in' })).toEqual({ op: { kind: 'opt-in' } });
    expect(parseTaxFactOp({ kind: 'model', model: 'flat' })).toEqual({ op: { kind: 'model', model: 'flat' } });
    expect('error' in parseTaxFactOp({ kind: 'model', model: 'detailed' })).toBe(true);
    expect('error' in parseTaxFactOp({ kind: 'opt-in', extra: 1 })).toBe(true);
    expect(applyTaxFactOp(DEFAULT_TAX_FACTS, { kind: 'opt-in' }).model).toBe('detailed');
    expect(applyTaxFactOp({ ...FULL, model: 'detailed' }, { kind: 'model', model: 'flat' })).toEqual({ ...FULL, model: 'flat' });
  });
});

describe('the household', () => {
  const HOME = { filing: 'joint', birthYears: [{ owner: 'you', year: 1960 }], dependents: [{ id: 'kid-1', untilAge: 55 }], paidToday: { kind: 'category', name: 'Health insurance' } };
  const taken = (v: unknown) => 'household' in parseHousehold(v);

  test('what a page may write', () => {
    expect(parseHousehold(HOME)).toEqual({ household: HOME as never });
    expect(taken({ filing: null, birthYears: [], dependents: [], paidToday: null })).toBe(true);
  });

  test('every rule', () => {
    expect(taken({ ...HOME, filing: 'separate' })).toBe(false);
    expect(taken({ ...HOME, extra: 1 })).toBe(false);
    const { paidToday: _gone, ...missing } = HOME;
    expect(taken(missing)).toBe(false);
    expect(taken({ ...HOME, birthYears: [{ owner: 'you', year: 1960 }, { owner: 'you', year: 1961 }] })).toBe(false);
    expect(taken({ ...HOME, birthYears: [{ owner: 'you', year: 1960.5 }] })).toBe(false);
    expect(taken({ ...HOME, birthYears: [{ owner: 'them', year: 1960 }] })).toBe(false);
    expect(taken({ ...HOME, dependents: [{ id: 'a', untilAge: 50 }, { id: 'a', untilAge: 51 }] })).toBe(false);
    expect(taken({ ...HOME, dependents: [{ id: 'a b', untilAge: 50 }] })).toBe(false);
    expect(taken({ ...HOME, dependents: [{ id: 'a', untilAge: 200 }] })).toBe(false);
    expect(taken({ ...HOME, dependents: Array.from({ length: MAX_DEPENDENTS + 1 }, (_, i) => ({ id: `d${i}`, untilAge: 50 })) })).toBe(false);
    expect(taken({ ...HOME, paidToday: { kind: 'tag', name: '' } })).toBe(false);
    expect(taken({ ...HOME, paidToday: { kind: 'account', name: 'x' } })).toBe(false);
    expect(taken({ ...HOME, paidToday: { kind: 'tag', name: 'x', extra: 1 } })).toBe(false);
  });

  test('two households are the same whatever the lists’ order', () => {
    const a = householdOf(FULL);
    expect(sameHousehold(a, { ...a, birthYears: [...a.birthYears].reverse() })).toBe(true);
    expect(sameHousehold(a, { ...a, filing: 'single' })).toBe(false);
    expect(sameHousehold(a, { ...a, paidToday: null })).toBe(false);
    expect(sameHousehold(a, { ...a, dependents: [] })).toBe(false);
  });
});
