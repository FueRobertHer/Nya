import { describe, expect, test } from 'bun:test';
import { balancesIn, convertHistory, deltaOver, rateEffect, type SplitPoint } from '@/lib/fx/net-worth';
import { convert } from '@/lib/fx/rates';
import { currenciesById, foreignAccounts } from '@/lib/fx/known-accounts';
import { ecbTable } from './fx-fixture';

const FX = ecbTable({ home: 'EUR' });
const DAY = '2026-09-14';

describe('a total of balances, converted by currency', () => {
  test('each currency’s subtotal once, at the day’s rate; the parts add up to the total exactly', () => {
    const b = balancesIn(
      [
        { amount: 1200.5, currency: 'EUR' },
        { amount: 10000, currency: 'USD' },
        { amount: 2345.67, currency: 'USD' },
        { amount: -500, currency: 'USD' }, // a card owed
        { amount: 300, currency: 'GBP' },
      ],
      FX,
      'EUR',
      DAY,
      'USD'
    );
    expect(b.parts.map((p) => [p.currency, p.amount, p.converted, p.accounts])).toEqual([
      ['EUR', 1200.5, 1200.5, 1],
      ['USD', 11845.67, 10255.1, 3], // 11,845.67 / 1.1551
      ['GBP', 300, 350.48, 1], // 300 / 0.85598
    ]);
    expect(b.total).toBe(1200.5 + 10255.1 + 350.48);
    expect(b.parts.reduce((s, p) => s + (p.converted ?? 0), 0)).toBeCloseTo(b.total, 10);
    expect(b.left_out).toEqual([]);
    expect(b.parts[1].rate).toMatchObject({ day: DAY, source: 'ecb' });
  });

  test('a currency with no rate is left out and named, never guessed', () => {
    const b = balancesIn(
      [
        { amount: 100, currency: 'EUR' },
        { amount: 0.5, currency: 'BTC' },
      ],
      FX,
      'EUR',
      DAY,
      'EUR'
    );
    expect(b.total).toBe(100);
    expect(b.left_out).toEqual([{ currency: 'BTC', accounts: 1, why: 'not-published' }]);
  });

  test('an account with no currency counts in the main one, and is counted', () => {
    const b = balancesIn(
      [
        { amount: 100, currency: null },
        { amount: 100, currency: 'USD' },
      ],
      FX,
      'EUR',
      DAY,
      'USD'
    );
    expect(b.unknown).toBe(1);
    expect(b.parts).toMatchObject([{ currency: 'USD', amount: 200, accounts: 2 }]);
  });

  test('a float sum converts as the decimal it adds up to, whatever the order', () => {
    const one = balancesIn([0.1, 0.2, 100].map((amount) => ({ amount, currency: 'USD' })), FX, 'EUR', DAY, 'USD');
    const other = balancesIn([100, 0.2, 0.1].map((amount) => ({ amount, currency: 'USD' })), FX, 'EUR', DAY, 'USD');
    expect(one.total).toBe(other.total);
    const exact = convert(FX, 100.3, 'USD', 'EUR', DAY);
    expect(one.total).toBe(exact.ok ? exact.amount : NaN);
  });

  test('the person’s own rate wins', () => {
    const fx = ecbTable({ home: 'EUR', own: [{ currency: 'USD', rate: '0.90', quote: 'EUR', from: null, set_at: '2026-09-01T00:00:00.000Z' }] });
    const b = balancesIn([{ amount: 1000, currency: 'USD' }], fx, 'EUR', DAY, 'USD');
    expect(b.total).toBe(900);
    expect(b.parts[0].rate).toMatchObject({ value: 0.9, source: 'own' });
  });
});

describe('the history, day by day', () => {
  test('each point at its own day’s rate, from its split', () => {
    const points: SplitPoint[] = [
      { date: '2026-09-11', value: 2000, parts: { EUR: 1000 } }, // USD 1,000 and EUR 1,000
      { date: '2026-09-12', value: 2000, estimated: true, parts: { EUR: 1000 } }, // Saturday: Friday's rate
      { date: '2026-09-14', value: 2000, parts: { EUR: 1000 } },
    ];
    const { points: out, gaps } = convertHistory(points, 'USD', FX, 'EUR');
    expect(out).toEqual([
      { date: '2026-09-11', value: 1862.66 }, // 1,000 + 1,000 / 1.1592
      { date: '2026-09-12', value: 1862.66, estimated: true },
      { date: '2026-09-14', value: 1865.73 }, // 1,000 + 1,000 / 1.1551
    ]);
    expect(gaps).toEqual({ unsplit: 0, main_unrated: 0, left_out: [] });
  });

  test('a point whose split can’t be told isn’t drawn, and is counted', () => {
    const { points, gaps } = convertHistory([{ date: DAY, value: 10, parts: null }], 'USD', FX, 'EUR');
    expect(points).toEqual([]);
    expect(gaps.unsplit).toBe(1);
  });

  test('a point whose main currency has no rate isn’t drawn as a fall', () => {
    const { points, gaps } = convertHistory([{ date: DAY, value: 10 }], 'ARS', FX, 'EUR');
    expect(points).toEqual([]);
    expect(gaps.main_unrated).toBe(1);
  });

  test('another currency with no rate is left out of the points, named with its days', () => {
    const { points, gaps } = convertHistory(
      [
        { date: '2026-09-11', value: 1000.5, parts: { BTC: 0.5 } },
        { date: '2026-09-14', value: 1000.5, parts: { BTC: 0.5 } },
      ],
      'EUR',
      FX,
      'EUR'
    );
    expect(points.map((p) => p.value)).toEqual([1000, 1000]);
    expect(gaps.left_out).toEqual([{ currency: 'BTC', from: '2026-09-11', to: '2026-09-14', days: 2 }]);
  });

  test('one currency only, not the home one: every point converts from it', () => {
    const { points } = convertHistory([{ date: DAY, value: 1155.1 }], 'USD', FX, 'EUR');
    expect(points).toEqual([{ date: DAY, value: 1000 }]);
  });
});

describe('Home’s change over recent days', () => {
  test('from the last point at least 30 days old, else the oldest', () => {
    const now = Date.parse('2026-09-14T12:00:00Z');
    const d = deltaOver(
      [
        { date: '2026-08-01', value: 100 },
        { date: '2026-08-14', value: 200 },
        { date: '2026-08-20', value: 300 },
        { date: '2026-09-14', value: 250 },
      ],
      now
    );
    expect(d).toMatchObject({ value: 50, from: '2026-08-14', to: '2026-09-14', days: 31 });
    expect(deltaOver([{ date: '2026-09-14', value: 1 }], now)).toBeNull();
  });

  test('says how much came from exchange rates, when more than rounding', () => {
    // USD 10,000 held still from Friday to Monday: the change is all rates.
    const friday: SplitPoint = { date: '2026-09-11', value: 10000 };
    const effect = rateEffect(friday, '2026-09-14', 'USD', FX, 'EUR');
    // 10,000 / 1.1551 less 10,000 / 1.1592: 8,657.26 less 8,626.64.
    expect(effect).toBe(30.62);
    // Only euros: nothing from rates.
    expect(rateEffect({ date: '2026-09-11', value: 10000 }, '2026-09-14', 'EUR', FX, 'EUR')).toBeNull();
    // Can't be told: none.
    expect(rateEffect({ date: '2026-09-11', value: 1, parts: null }, '2026-09-14', 'USD', FX, 'EUR')).toBeNull();
    // A cent's move on a few dollars is rounding.
    expect(rateEffect({ date: '2026-09-11', value: 1 }, '2026-09-14', 'USD', FX, 'EUR')).toBeNull();
  });
});

describe('which accounts are in another currency, by every id each has had', () => {
  const listed = [
    { account_id: 'chk', currency: 'USD', type: 'depository' },
    { account_id: 'eur', currency: 'EUR', type: 'depository' },
    { account_id: 'card', currency: null, type: 'credit' },
  ];

  test('listed now wins, then ended, then the directory; a later source fills a currency an earlier one lacked', () => {
    const ended = [{ account_id: 'eur', currency: 'GBP', type: 'depository' }, { account_id: 'card', currency: 'USD', type: null }];
    const directory = [{ account_id: 'gone', currency: 'JPY', type: 'investment' }, { account_id: 'old_dir', currency: null, type: null }];
    const byId = currenciesById([listed, ended, directory], null);
    expect(byId.get('eur')).toEqual({ currency: 'EUR', type: 'depository' });
    expect(byId.get('card')).toEqual({ currency: 'USD', type: 'credit' });
    expect(byId.get('gone')).toEqual({ currency: 'JPY', type: 'investment' });
    expect(byId.get('old_dir')).toEqual({ currency: null, type: null });
  });

  test('an id from before a re-link takes its account’s currency now, unless its own is known', () => {
    const links = new Map([
      ['eur_old', { to: 'eur_mid' }],
      ['eur_mid', { to: 'eur' }],
      ['jp_old', { to: 'chk' }],
    ]);
    const byId = currenciesById([listed, [{ account_id: 'jp_old', currency: 'JPY', type: 'depository' }]], links);
    expect(byId.get('eur_old')).toEqual({ currency: 'EUR', type: 'depository' });
    expect(byId.get('eur_mid')).toEqual({ currency: 'EUR', type: 'depository' });
    expect(byId.get('jp_old')).toEqual({ currency: 'JPY', type: 'depository' });
  });

  test('the split reads every id whose currency is known and isn’t the main one', () => {
    const foreign = foreignAccounts(currenciesById([listed], null), 'USD');
    expect([...foreign]).toEqual([['eur', { currency: 'EUR', type: 'depository' }]]);
    expect(foreignAccounts(currenciesById([listed], null), null).size).toBe(2);
  });
});
