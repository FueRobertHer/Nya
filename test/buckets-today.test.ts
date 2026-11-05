import { describe, expect, test } from 'bun:test';
import { bucketsToday } from '@/lib/fire/buckets-today';
import { byBucket, savingsSplit } from '@/lib/fire/savings-split';
import { mixShares, mixToday, projectMix } from '@/lib/fire/tax/mix';
import { walkBalanceAt, type WalkChanges } from '@/lib/fire/events';
import { investedAssets, type AssetAccount, type AssetInstitution } from '@/lib/fire/inputs';
import { leftOutOf } from '@/lib/fire/child-accounts';
import { DEFAULT_TAX_FACTS, type TaxFacts } from '@/lib/fire/tax-facts';
import type { PageFx } from '@/lib/fx/view';
import { ecbTable } from './fx-fixture';

// Invested assets by how each kind of money is taxed
// (lib/fire/buckets-today.ts), where a year's savings go
// (lib/fire/savings-split.ts), and the mix at the start age
// (lib/fire/tax/mix.ts). The totals are invested assets' and the walk's, within
// a cent, in any currency and whatever the walk does. Worked by hand where a
// figure is named.

const acct = (over: Partial<AssetAccount>): AssetAccount => ({ account_id: 'a', name: 'Account', type: 'investment', subtype: 'brokerage', balance: 100, currency: 'USD', ...over });
const inst = (accounts: AssetAccount[]): AssetInstitution => ({ name: 'Broker', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts });
const hold = (account_id: string, value: number | null, cost_basis: number | null, over: object = {}) => ({ account_id, name: 'Fund', value, cost_basis, ...over });
const facts = (over: Partial<TaxFacts> = {}): TaxFacts => ({ ...DEFAULT_TAX_FACTS, ...over });
const NONE = new Map();

const FX = ecbTable({ home: 'USD' });
const PAGE: PageFx = { home: 'USD', latest: FX.latest, own: [] };
const NOW = Date.parse('2026-09-14T12:00:00.000Z');

const BROKER = acct({ account_id: 'brk', name: 'Brokerage', balance: 140_000 });
const K401 = acct({ account_id: 'k', name: '401(k)', subtype: '401k', balance: 300_000 });
const ROTH = acct({ account_id: 'r', name: 'Roth IRA', subtype: 'roth', balance: 100_000 });
const HSA = acct({ account_id: 'h', name: 'HSA', subtype: 'hsa', balance: 15_000 });
const OTHER = acct({ account_id: 'o', name: 'Mystery', subtype: 'other', balance: 40_000 });
const CHECKING = acct({ account_id: 'c', name: 'Checking', type: 'depository', subtype: 'checking', balance: 5_000 });

const groupsOf = (accounts: AssetAccount[], extra: Partial<Parameters<typeof bucketsToday>[0]> = {}, includeCash = false) =>
  bucketsToday({ assets: investedAssets([inst(accounts)], includeCash), holdings: [], tax: facts(), overrides: NONE, ...extra });

describe('the groups', () => {
  test('in Portfolio’s order, each with its total, those with an account', () => {
    const b = groupsOf([OTHER, HSA, ROTH, K401, BROKER]);
    expect(b.groups.map((g) => [g.bucket, g.total])).toEqual([
      ['taxable', 140_000],
      ['tax-deferred', 300_000],
      ['roth', 100_000],
      ['hsa', 15_000],
      ['unclassified', 40_000],
    ]);
    expect(b.total).toBe(595_000);
  });

  test('the person’s own bucket wins, and is said; counted cash sits under taxable', () => {
    const b = groupsOf([K401, CHECKING], { overrides: new Map([['k', 'roth']]) }, true);
    expect(b.groups.map((g) => g.bucket)).toEqual(['taxable', 'roth']);
    expect(b.groups[1].accounts[0]).toMatchObject({ account_id: 'k', chosen: true });
    expect(b.groups[0].accounts[0]).toMatchObject({ account_id: 'c', basisFrom: 'cash', gain: 0, chosen: false });
  });

  test('an account with no bucket says why', () => {
    expect(groupsOf([OTHER]).groups[0].accounts[0].why).toContain('Plaid');
  });

  test('a 529 counted anyway sits under Education, a UTMA under Taxable; those left out are their own list', () => {
    const c529 = acct({ account_id: 'c529', subtype: '529', balance: 48_000 });
    const utma = acct({ account_id: 'u', subtype: 'utma', balance: 7_000 });
    const counted = bucketsToday({ assets: investedAssets([inst([c529, utma])], false, null, NOW, null, leftOutOf(true, ['c529', 'u'])), holdings: [], tax: facts(), overrides: NONE });
    expect(counted.groups.map((g) => g.bucket)).toEqual(['taxable', 'education']);
    expect(counted.leftOut).toEqual({ accounts: [], total: 0 });
    const out = bucketsToday({ assets: investedAssets([inst([c529, utma, BROKER])], false, null, NOW, null, leftOutOf(true, [])), holdings: [], tax: facts(), overrides: NONE });
    expect(out.total).toBe(140_000);
    expect(out.leftOut.total).toBe(55_000);
    expect(out.leftOut.accounts.map((a) => a.account_id)).toEqual(['c529', 'u']);
  });

  test('the owner is you unless the facts say otherwise', () => {
    const b = groupsOf([BROKER, K401], { tax: facts({ owners: [{ account_id: 'k', owner: 'partner' }] }) });
    expect(b.groups.flatMap((g) => g.accounts.map((a) => [a.account_id, a.owner]))).toEqual([
      ['brk', 'you'],
      ['k', 'partner'],
    ]);
  });

  test('Roth contributions per person: none without a Roth or an amount, the partner’s once set', () => {
    expect(groupsOf([BROKER]).roth).toEqual([]);
    expect(groupsOf([ROTH]).roth).toEqual([{ owner: 'you', amount: null }]);
    expect(groupsOf([ROTH], { partner: true }).roth).toEqual([
      { owner: 'you', amount: null },
      { owner: 'partner', amount: null },
    ]);
    expect(groupsOf([BROKER], { tax: facts({ rothContributions: [{ owner: 'you', amount: 45_000 }] }) }).roth).toEqual([{ owner: 'you', amount: 45_000 }]);
    expect(groupsOf([ROTH], { tax: facts({ rothContributions: [{ owner: 'partner', amount: 9 }] }) }).roth).toEqual([
      { owner: 'you', amount: null },
      { owner: 'partner', amount: 9 },
    ]);
  });

  test('every total within a cent of invested assets, with accounts in another currency', () => {
    const accounts = [acct({ account_id: 'e', currency: 'EUR', balance: 1_000.1 }), acct({ account_id: 'e2', subtype: 'roth', currency: 'EUR', balance: 2_000.37 }), acct({ account_id: 'u', subtype: '401k', currency: 'USD', balance: 5_000.11 })];
    const assets = investedAssets([inst(accounts)], false, PAGE, NOW, 'USD');
    const b = bucketsToday({ assets, holdings: [], tax: facts(), overrides: NONE });
    expect(Math.abs(b.total - assets.total!)).toBeLessThan(0.01);
    expect(b.groups).toHaveLength(3);
  });
});

describe('the cost basis', () => {
  const one = (holdings: ReturnType<typeof hold>[], over: Partial<TaxFacts> = {}, account = BROKER) =>
    bucketsToday({ assets: investedAssets([inst([account])], false), holdings, tax: facts(over), overrides: NONE }).groups[0].accounts[0];

  test('every position’s: the gain is what is above it', () => {
    expect(one([hold('brk', 100_000, 70_000), hold('brk', 40_000, 35_000)])).toMatchObject({ basis: 105_000, basisFrom: 'positions', gain: 35_000 });
  });

  test('cash at its value, a position without a basis as all gain, and that is said', () => {
    const partial = one([hold('brk', 100_000, 70_000), hold('brk', 30_000, null), hold('brk', 10_000, null, { is_cash_equivalent: true })]);
    expect(partial).toMatchObject({ basis: 80_000, basisFrom: 'partial', gain: 60_000 });
    expect(one([hold('brk', 140_000, null, { is_cash_equivalent: true })])).toMatchObject({ basis: 140_000, basisFrom: 'positions', gain: 0 });
  });

  test('nothing to go by: not known, never zero', () => {
    expect(one([])).toMatchObject({ basis: null, basisFrom: 'none', gain: null });
    expect(one([hold('brk', 140_000, null)])).toMatchObject({ basis: null, basisFrom: 'none', gain: null });
    expect(one([hold('brk', null, 5)])).toMatchObject({ basisFrom: 'none' });
    expect(one([hold('other', 5, 5)])).toMatchObject({ basisFrom: 'none' });
  });

  test('what was typed wins', () => {
    expect(one([hold('brk', 100_000, 1)], { basis: [{ account_id: 'brk', amount: 120_000 }] })).toMatchObject({ basis: 120_000, basisFrom: 'typed', gain: 20_000 });
  });

  test('a position in another currency than its account counts as all gain', () => {
    expect(one([hold('brk', 100_000, 70_000), hold('brk', 40_000, 35_000, { currency: 'EUR' })])).toMatchObject({ basis: 70_000, basisFrom: 'partial' });
  });

  test('converted with the balance', () => {
    const eur = acct({ account_id: 'e', currency: 'EUR', balance: 1_000 });
    const usd = acct({ account_id: 'u', subtype: '401k', currency: 'USD', balance: 5_000 });
    const assets = investedAssets([inst([eur, usd])], false, PAGE, NOW, 'USD');
    const a = bucketsToday({ assets, holdings: [hold('e', 1_000, 500)], tax: facts(), overrides: NONE }).groups[0].accounts[0];
    expect(a.value).toBeCloseTo(1_155.1, 2);
    expect(a.basis).toBeCloseTo(577.55, 2);
    expect(a.gain).toBeCloseTo(577.55, 2);
  });
});

describe('an account’s year', () => {
  test('income and yield, contributions, in the total’s currency', () => {
    const b = groupsOf([BROKER], { yearOf: () => ({ income: 2_800, contributions: 6_000 }) });
    expect(b.groups[0].accounts[0]).toMatchObject({ income: 2_800, contributions: 6_000 });
    expect(b.groups[0].accounts[0].yieldRate).toBeCloseTo(0.02, 10);
  });

  test('not known is null, and no yield', () => {
    expect(groupsOf([BROKER]).groups[0].accounts[0]).toMatchObject({ income: null, yieldRate: null, contributions: null });
  });
});

describe('where savings go', () => {
  const withYears = (years: Record<string, number>, accounts = [BROKER, K401, ROTH], extra = {}) => groupsOf(accounts, { yearOf: (a) => ({ income: null, contributions: years[a.account_id] ?? 0 }), ...extra });
  const sum = (shares: { share: number }[]) => shares.reduce((s, x) => s + x.share, 0);

  test('by the last year’s contributions, the rest of savings to taxable', () => {
    const s = savingsSplit(withYears({ k: 20_000, r: 7_000 }), 30_000);
    expect(s.from).toBe('contributions');
    const by = new Map(byBucket(s).map((x) => [x.bucket, x.share]));
    expect(by.get('tax-deferred')).toBeCloseTo(20 / 30, 10);
    expect(by.get('roth')).toBeCloseTo(7 / 30, 10);
    expect(by.get('taxable')).toBeCloseTo(3 / 30, 10);
    expect(sum(s.shares)).toBeCloseTo(1, 10);
  });

  test('contributions above savings (or savings not known) share by themselves', () => {
    for (const savings of [10_000, 0, -5_000, null]) {
      const s = savingsSplit(withYears({ k: 20_000, r: 5_000 }), savings);
      expect(new Map(byBucket(s).map((x) => [x.bucket, x.share])).get('tax-deferred')).toBeCloseTo(0.8, 10);
      expect(sum(s.shares)).toBeCloseTo(1, 10);
    }
  });

  test('nothing measured follows today’s balances; nothing at all is taxable', () => {
    const s = savingsSplit(withYears({}), 30_000);
    expect(s.from).toBe('balances');
    expect(new Map(byBucket(s).map((x) => [x.bucket, x.share])).get('tax-deferred')).toBeCloseTo(300 / 540, 10);
    expect(sum(s.shares)).toBeCloseTo(1, 10);
    expect(savingsSplit({ groups: [] }, 30_000)).toEqual({ from: 'none', shares: [{ bucket: 'taxable', owner: 'you', share: 1 }] });
  });

  test('an account in no bucket counts as tax-deferred, and each person is kept apart', () => {
    const s = savingsSplit(withYears({ o: 1_000, k: 3_000 }, [OTHER, K401], { tax: facts({ owners: [{ account_id: 'k', owner: 'partner' }] }) }), null);
    expect(s.shares).toEqual([
      { bucket: 'tax-deferred', owner: 'partner', share: 0.75 },
      { bucket: 'tax-deferred', owner: 'you', share: 0.25 },
    ]);
  });

  test('a child’s account left out matches nothing, so its money falls to taxable', () => {
    const c529 = acct({ account_id: 'c529', subtype: '529', balance: 48_000 });
    const today = bucketsToday({ assets: investedAssets([inst([c529, K401])], false, null, NOW, null, leftOutOf(true, [])), holdings: [], tax: facts(), overrides: NONE, yearOf: (a) => ({ income: null, contributions: a.account_id === 'k' ? 6_000 : 4_000 }) });
    expect(new Map(byBucket(savingsSplit(today, 10_000)).map((x) => [x.bucket, x.share])).get('taxable')).toBeCloseTo(0.4, 10);
  });
});

describe('the mix at the start age', () => {
  const NO_WALK: WalkChanges = { moneyIn: [], costs: [], spans: [] };
  const today = bucketsToday({
    assets: investedAssets([inst([BROKER, K401, ROTH, HSA, OTHER])], false),
    holdings: [hold('brk', 140_000, 105_000)],
    tax: facts({ rothContributions: [{ owner: 'you', amount: 45_000 }] }),
    overrides: NONE,
  });
  const split = savingsSplit(today, 30_000).shares;
  const run = (over: Partial<Parameters<typeof projectMix>[1]> = {}, assets = 595_000) => projectMix(mixToday(today, assets), { savings: 30_000, split, realReturn: 0.05, inflation: 0.03, walk: NO_WALK, years: 10, ...over });

  test('today: an unclassified account is tax-deferred, basis on taxable, reachable on Roth', () => {
    const slots = mixToday(today, 595_000);
    const of = (b: string) => slots.find((s) => s.bucket === b)!;
    expect(of('tax-deferred').value).toBe(340_000);
    expect(of('taxable')).toMatchObject({ value: 140_000, basis: 105_000, reachable: 0 });
    expect(of('roth')).toMatchObject({ value: 100_000, reachable: 45_000, basis: 0 });
  });

  test('today, with a typed figure: scaled to it, every proportion kept', () => {
    const slots = mixToday(today, 297_500);
    expect(slots.find((s) => s.bucket === 'taxable')).toMatchObject({ value: 70_000, basis: 52_500 });
  });

  test('today, with no accounts: all taxable, with no basis known', () => {
    expect(mixToday({ groups: [], roth: [], total: 0 }, 50_000)).toEqual([{ owner: 'you', bucket: 'taxable', value: 50_000, basis: 0, reachable: 0 }]);
    expect(mixToday({ groups: [], roth: [], total: 0 }, 0)).toEqual([]);
  });

  test('reachable is never more than the Roth holds', () => {
    const big = bucketsToday({ assets: investedAssets([inst([ROTH])], false), holdings: [], tax: facts({ rothContributions: [{ owner: 'you', amount: 900_000 }] }), overrides: NONE });
    expect(mixToday(big, 100_000)[0].reachable).toBe(100_000);
  });

  const walks: [string, WalkChanges, number][] = [
    ['nothing changes', NO_WALK, 30_000],
    ['money in', { moneyIn: [{ year: 3, amount: 50_000 }], costs: [], spans: [] }, 30_000],
    ['a cost', { moneyIn: [], costs: [{ year: 2, amount: 80_000 }], spans: [] }, 30_000],
    ['both in one year', { moneyIn: [{ year: 2, amount: 10_000 }], costs: [{ year: 2, amount: 80_000 }], spans: [] }, 30_000],
    ['savings that change', { moneyIn: [], costs: [], spans: [{ from: 4, to: 7, delta: -10_000 }] }, 30_000],
    ['a saving below zero', { moneyIn: [], costs: [], spans: [{ from: 1, to: null, delta: -50_000 }] }, 30_000],
    ['no savings', NO_WALK, 0],
  ];
  for (const [what, walk, savings] of walks) {
    test(`its total is the walk’s, within a cent: ${what}`, () => {
      for (const [years, realReturn] of [[0, 0.05], [1, 0.05], [10, 0.05], [25, 0.02], [10, -0.01], [7, 0]] as const) {
        const mix = run({ walk, years, realReturn, savings })!;
        const at = walkBalanceAt(595_000, savings, realReturn, walk, years);
        if (!('balance' in at)) throw new Error('the walk stopped short');
        expect(Math.abs(mix.total - at.balance)).toBeLessThan(0.01);
      }
    });
  }

  test('where the walk can’t get there, nor can it', () => {
    expect(run({ walk: { moneyIn: [], costs: [{ year: 0, amount: 900_000 }], spans: [] } })).toBeNull();
    expect('short' in walkBalanceAt(595_000, 30_000, 0.05, { moneyIn: [], costs: [{ year: 0, amount: 900_000 }], spans: [] }, 10)).toBe(true);
    expect(run({ savings: -900_000 })).toBeNull();
  });

  test('basis and reachable are of their day: they shrink with inflation, and new money comes in at full basis', () => {
    const noSavings = run({ savings: 0, years: 1, realReturn: 0 })!;
    const of = (b: string) => noSavings.slots.find((s) => s.bucket === b)!;
    expect(of('taxable').basis).toBeCloseTo(105_000 / 1.03, 6);
    expect(of('roth').reachable).toBeCloseTo(45_000 / 1.03, 6);
    const all = projectMix([{ owner: 'you', bucket: 'taxable', value: 0, basis: 0, reachable: 0 }], { savings: 1_000, split: [{ bucket: 'taxable', owner: 'you', share: 1 }], realReturn: 0, inflation: 0.03, walk: NO_WALK, years: 1 })!;
    expect(all.slots[0]).toMatchObject({ value: 1_000, basis: 1_000 });
    const roth = projectMix([], { savings: 1_000, split: [{ bucket: 'roth', owner: 'partner', share: 1 }], realReturn: 0, inflation: 0.03, walk: NO_WALK, years: 1 })!;
    expect(roth.slots[0]).toMatchObject({ bucket: 'roth', owner: 'partner', value: 1_000, reachable: 1_000 });
  });

  test('money in goes to taxable at full basis, and a cost comes from every bucket by its share', () => {
    const windfall = projectMix([{ owner: 'you', bucket: 'tax-deferred', value: 100, basis: 0, reachable: 0 }], { savings: 0, split: [], realReturn: 0, inflation: 0, walk: { moneyIn: [{ year: 0, amount: 50 }], costs: [], spans: [] }, years: 1 })!;
    expect(windfall.slots.find((s) => s.bucket === 'taxable')).toMatchObject({ value: 50, basis: 50 });
    const cost = projectMix(
      [
        { owner: 'you', bucket: 'taxable', value: 300, basis: 150, reachable: 0 },
        { owner: 'you', bucket: 'roth', value: 100, basis: 0, reachable: 50 },
      ],
      { savings: 0, split: [], realReturn: 0, inflation: 0, walk: { moneyIn: [], costs: [{ year: 0, amount: 200 }], spans: [] }, years: 1 }
    )!;
    expect(cost.slots.find((s) => s.bucket === 'taxable')).toMatchObject({ value: 150, basis: 75 });
    expect(cost.slots.find((s) => s.bucket === 'roth')).toMatchObject({ value: 50, reachable: 25 });
  });

  test('its shares, largest first, without what rounds to nothing', () => {
    expect(mixShares({ total: 1_000, slots: [
      { owner: 'you', bucket: 'taxable', value: 400, basis: 0, reachable: 0 },
      { owner: 'partner', bucket: 'tax-deferred', value: 300, basis: 0, reachable: 0 },
      { owner: 'you', bucket: 'tax-deferred', value: 299, basis: 0, reachable: 0 },
      { owner: 'you', bucket: 'hsa', value: 1, basis: 0, reachable: 0 },
    ] })).toEqual([
      { bucket: 'tax-deferred', pct: 60 },
      { bucket: 'taxable', pct: 40 },
    ]);
    expect(mixShares({ total: 0, slots: [] })).toEqual([]);
  });
});
