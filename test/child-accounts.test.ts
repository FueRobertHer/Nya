import { describe, expect, test } from 'bun:test';
import { isChildAccount, leftOutOf } from '@/lib/fire/child-accounts';
import { investedAssets, type AssetAccount, type AssetInstitution } from '@/lib/fire/inputs';
import type { PageFx } from '@/lib/fx/view';
import { ecbTable } from './fx-fixture';

// D7: a child's accounts out of invested assets (lib/fire/child-accounts.ts,
// lib/fire/inputs.ts): the same rule for every screen, the total without them,
// each named with its value in the total's currency, and with the flag off,
// today's arithmetic whatever is held. The ECB's rates of 10 to 14 Sep 2026
// (test/fx-fixture.ts).

const acct = (over: Partial<AssetAccount>): AssetAccount => ({ account_id: 'a', name: 'Account', type: 'investment', balance: 100, currency: 'USD', ...over });
const inst = (accounts: AssetAccount[], over: Partial<AssetInstitution> = {}): AssetInstitution => ({ name: 'Broker', item_id: 'i1', error: false, staleAsOf: null, staleAsOfAt: null, missing: 0, accounts, ...over });

const FX = ecbTable({ home: 'USD' });
const PAGE: PageFx = { home: 'USD', latest: FX.latest, own: [] };
const NOW = Date.parse('2026-09-14T12:00:00.000Z');

describe('which accounts', () => {
  test('a 529, UTMA, UGMA, Coverdell or RESP, in any case', () => {
    for (const s of ['529', 'ugma', 'utma', 'UGMA', 'Education Savings Account', 'education savings account', 'resp', 'RESP']) expect([s, isChildAccount(s)]).toEqual([s, true]);
  });

  test('nothing else, and no subtype is not one', () => {
    for (const s of ['401k', 'brokerage', 'roth', 'hsa', 'savings', '', null, undefined]) expect([s, isChildAccount(s)]).toEqual([s, false]);
  });

  test('the switch off leaves nothing out; on, one counted anyway stays', () => {
    expect(leftOutOf(false, [])).toBeNull();
    const rule = leftOutOf(true, ['kept'])!;
    expect(rule({ account_id: 'kept', subtype: '529' })).toBe(false);
    expect(rule({ account_id: 'other', subtype: '529' })).toBe(true);
    expect(rule({ account_id: 'other', subtype: '401k' })).toBe(false);
    expect(rule({ account_id: 'other' })).toBe(false);
  });
});

describe('invested assets', () => {
  const COLLEGE = acct({ account_id: 'c', name: 'College', subtype: '529', balance: 48_000 });
  const BROKER = acct({ account_id: 'b', name: 'Brokerage', subtype: 'brokerage', balance: 100_000 });
  const OUT = leftOutOf(true, []);

  test('off: exactly today, with a 529 in the total and nothing named', () => {
    const today = investedAssets([inst([COLLEGE, BROKER])], false);
    expect(today.total).toBe(148_000);
    expect(today.childAccounts).toBeUndefined();
    expect(investedAssets([inst([COLLEGE, BROKER])], false, null, Date.now(), null, null)).toEqual(today);
  });

  test('on: out of the total, named with its value and institution', () => {
    const r = investedAssets([inst([COLLEGE, BROKER])], false, null, Date.now(), null, OUT);
    expect(r.total).toBe(100_000);
    expect(r.accounts.map((a) => a.account_id)).toEqual(['b']);
    expect(r.childAccounts).toEqual([{ ...COLLEGE, institution: 'Broker', item_id: 'i1', value: 48_000 }]);
  });

  test('on, with none held: no account named, and the total as ever', () => {
    const r = investedAssets([inst([BROKER])], false, null, Date.now(), null, OUT);
    expect(r.total).toBe(100_000);
    expect(r.childAccounts).toEqual([]);
  });

  test('counted anyway: in the total, and not named', () => {
    const r = investedAssets([inst([COLLEGE, BROKER])], false, null, Date.now(), null, leftOutOf(true, ['c']));
    expect(r.total).toBe(148_000);
    expect(r.childAccounts).toEqual([]);
  });

  test('hidden stays hidden, and a child’s account alone at a failing institution raises nothing', () => {
    expect(investedAssets([inst([{ ...COLLEGE, hidden: true }, BROKER])], false, null, Date.now(), null, OUT).childAccounts).toEqual([]);
    const failing = inst([COLLEGE], { name: 'Fidelity', error: true });
    expect(investedAssets([failing, inst([BROKER])], false, null, Date.now(), null, OUT).caveats).toEqual([]);
    // Counted, as today, it would say so.
    expect(investedAssets([failing, inst([BROKER])], false).caveats).not.toEqual([]);
  });

  test('with no balance: not counted as unknown, and its value null', () => {
    const r = investedAssets([inst([{ ...COLLEGE, balance: null }, BROKER])], false, null, Date.now(), null, OUT);
    expect(r.unknown).toBe(0);
    expect(r.childAccounts?.[0].value).toBeNull();
  });

  describe('in another currency', () => {
    const EUR = acct({ account_id: 'e', name: 'Euro brokerage', subtype: 'brokerage', currency: 'EUR', balance: 1_000.1 });
    const EUR2 = acct({ account_id: 'e2', name: 'Euro IRA', subtype: 'ira', currency: 'EUR', balance: 2_000.37 });
    const USD = acct({ account_id: 'u', name: 'Dollars', subtype: 'brokerage', currency: 'USD', balance: 5_000 });

    test('a child’s account converts at the newest rate, and with none its value is null', () => {
      const out = acct({ account_id: 'c', subtype: '529', currency: 'EUR', balance: 1_000 });
      const r = investedAssets([inst([USD, out])], false, PAGE, NOW, 'USD', OUT);
      // 1 EUR = 1.1551 USD on the newest day.
      expect(r.childAccounts?.[0].value).toBeCloseTo(1_155.1, 2);
      expect(r.total).toBe(5_000);
      expect(investedAssets([inst([USD, out])], false, null, NOW, 'USD', OUT).childAccounts?.[0].value).toBeNull();
      const none = acct({ account_id: 'c', subtype: '529', currency: 'XXX', balance: 1_000 });
      expect(investedAssets([inst([USD, none])], false, PAGE, NOW, 'USD', OUT).childAccounts?.[0].value).toBeNull();
    });

    test('in its own currency, a child’s value is its balance', () => {
      const r = investedAssets([inst([USD, COLLEGE])], false, PAGE, NOW, 'USD', OUT);
      expect(r.childAccounts?.[0].value).toBe(48_000);
    });

    test('each counted account’s value adds up to the total within a cent', () => {
      const r = investedAssets([inst([EUR, EUR2, USD])], false, PAGE, NOW, 'USD', null);
      const sum = r.accounts.reduce((s, a) => s + a.value, 0);
      expect(r.total).not.toBeNull();
      expect(Math.abs(sum - r.total!)).toBeLessThan(0.01);
      expect(r.accounts.find((a) => a.account_id === 'u')!.value).toBe(5_000);
      // The balance stays in the account's own currency.
      expect(r.accounts.find((a) => a.account_id === 'e')!.balance).toBe(1_000.1);
    });

    test('in one currency, value is the balance', () => {
      const r = investedAssets([inst([USD, BROKER])], false);
      for (const a of r.accounts) expect(a.value).toBe(a.balance);
    });
  });
});
