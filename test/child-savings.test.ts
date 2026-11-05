import { describe, expect, test } from 'bun:test';
import { childSavings, MATCH_DAYS, toRetirementFunds, transfersOut, workplaceSavings, type PlanContributions, type TrailingFlows, type TransferOut, type InvestedAssets } from '@/lib/fire/inputs';
import { childTaken, fiFigures, measuredInputs, savingsRate } from '@/lib/fire/progress';
import { DEFAULT_PLAN } from '@/lib/fire/plan';
import type { Txn } from '@/components/MonthBreakdown';

// D7's other half: what a bank paid into an account left out for a child's
// education comes off savings (lib/fire/inputs.ts childSavings), since a transfer
// is in neither income nor spending and would otherwise be planned on as yours.
// Only what left a bank comes off, each transfer pays once across every plan, and
// with no such account today's arithmetic runs.

const plan = (over: Partial<PlanContributions> = {}): PlanContributions => ({
  account_id: 'c',
  name: 'College',
  institution: 'Ascensus',
  amount: 3_000,
  from: '2025-11-01',
  partial: false,
  rows: [],
  activityFrom: null,
  note: null,
  ...over,
});
const RETIREMENT = 'investment and retirement funds';
const out = (date: string, amount: number, detail = RETIREMENT, currency: string | null = 'USD'): TransferOut => ({ date, amount, detail, currency });
const WHOLE_YEAR = { scaled: false, days: 365, from: '2025-10-07', currency: 'USD' };

const flows = (over: Partial<TrailingFlows> = {}): TrailingFlows =>
  ({ spending: 40_000, income: 70_000, savings: 30_000, from: '2025-10-07', to: '2026-10-06', days: 365, scaled: false, count: 400, excludedCount: 0, currency: 'USD', leftOut: [], ...over }) as TrailingFlows;
const assets = { total: 250_000, accounts: [], unknown: 0, caveats: [], currency: 'USD', leftOut: [] } as unknown as InvestedAssets;

describe('what comes off', () => {
  test('what a transfer out paid for, and not what never left a bank', () => {
    const c = childSavings(
      [
        plan({
          rows: [
            { date: '2026-03-16', amount: 250 },
            { date: '2026-04-16', amount: 250 },
            { date: '2026-05-01', amount: 10_000 }, // a grandparent's gift
          ],
        }),
      ],
      [out('2026-03-16', 250), out('2026-04-17', 250)],
      WHOLE_YEAR
    );
    expect(c.total).toBe(500);
    expect(c.plans).toEqual([{ name: 'Ascensus College', taken: 500, rest: 10_000 }]);
  });

  test('a transfer matches by amount within a dollar or 1%, and by day within a few days', () => {
    const one = (t: TransferOut) => childSavings([plan({ rows: [{ date: '2026-06-10', amount: 2_000 }] })], [t], WHOLE_YEAR).total;
    expect(one(out('2026-06-10', 2_019))).toBe(2_000);
    expect(one(out('2026-06-10', 2_030))).toBe(0);
    expect(one(out(`2026-06-${10 + MATCH_DAYS}`, 2_000))).toBe(2_000);
    expect(one(out(`2026-06-${11 + MATCH_DAYS}`, 2_000))).toBe(0);
  });

  test('a transfer recorded as several contributions on one day is matched by their sum', () => {
    const c = childSavings(
      [
        plan({
          rows: [
            { date: '2026-06-10', amount: 300 },
            { date: '2026-06-10', amount: 200 },
          ],
        }),
      ],
      [out('2026-06-10', 500)],
      WHOLE_YEAR
    );
    expect(c.plans).toEqual([{ name: 'Ascensus College', taken: 500, rest: 0 }]);
  });

  test('any transfer out of any detail can have paid, and a row that counts as spending never did', () => {
    const txn = (over: Partial<Txn>) => ({ transaction_id: `t${over.date}`, name: 'SCHOLARSHARE', pending: false, ...over }) as Txn;
    const moved = transfersOut(
      [
        txn({ date: '2026-03-01', amount: 250, category: 'transfer out', subcategory: 'account transfer' }),
        txn({ date: '2026-04-01', amount: 250, category: 'transfer out', subcategory: 'investment and retirement funds' }),
        txn({ date: '2026-05-01', amount: 250, category: 'general services', subcategory: 'other general services' }),
      ],
      '2026-10-06'
    );
    expect(moved).toEqual([out('2026-03-01', 250, 'account transfer', null), out('2026-04-01', 250, RETIREMENT, null)]);
    const c = childSavings(
      [
        plan({
          rows: [
            { date: '2026-03-01', amount: 250 },
            { date: '2026-04-01', amount: 250 },
            { date: '2026-05-01', amount: 250 },
          ],
        }),
      ],
      moved,
      WHOLE_YEAR
    );
    expect(c.plans).toEqual([{ name: 'Ascensus College', taken: 500, rest: 250 }]);
  });

  test('scaled up as income and spending are, since it was paid out of the same days', () => {
    const c = childSavings([plan({ rows: [{ date: '2026-08-01', amount: 500 }] })], [out('2026-08-01', 500)], { scaled: true, days: 73, from: '2026-07-25', currency: 'USD' });
    expect(c.total).toBe(2_500);
    expect(c.plans[0].taken).toBe(2_500);
  });

  test('rows from before the transactions begin say nothing: neither taken off, nor said to have no transfer', () => {
    const c = childSavings(
      [
        plan({
          rows: [
            { date: '2026-01-16', amount: 250 },
            { date: '2026-08-16', amount: 250 },
            { date: '2026-09-16', amount: 250 },
          ],
        }),
      ],
      [out('2026-08-16', 250)],
      { scaled: true, days: 73, from: '2026-07-25', currency: 'USD' }
    );
    expect(c.total).toBe(1_250);
    expect(c.plans[0].rest).toBe(250);
  });

  test('a move to savings stays yours and never pays, and passes on with the rest', () => {
    const c = childSavings([plan({ rows: [{ date: '2026-03-16', amount: 250 }] })], [out('2026-03-16', 250, 'savings')], WHOLE_YEAR);
    expect(c.total).toBe(0);
    expect(c.plans[0].rest).toBe(250);
    expect(c.left).toEqual([out('2026-03-16', 250, 'savings')]);
  });

  test('a transfer in another currency was never in the figure, nothing converts it, and it passes on', () => {
    const cad = out('2026-03-16', 500, 'account transfer', 'CAD');
    const row = [plan({ rows: [{ date: '2026-03-16', amount: 500 }] })];
    const c = childSavings(row, [cad], WHOLE_YEAR);
    expect(c.total).toBe(0);
    expect(c.left).toEqual([cad]);
    // Rows that say no currency, or a figure with none, are the figure's (lib/spending.ts inCurrency).
    expect(childSavings(row, [out('2026-03-16', 500, 'account transfer', null)], WHOLE_YEAR).total).toBe(500);
    expect(childSavings(row, [cad], { ...WHOLE_YEAR, currency: null as unknown as string }).total).toBe(500);
  });

  test('what couldn’t be measured or read is named, and takes nothing off', () => {
    const c = childSavings(
      [
        plan({ account_id: 'a', name: 'Failed', amount: null, rows: [{ date: '2026-03-16', amount: 250 }] }),
        plan({ account_id: 'b', name: 'Short', from: '2026-06-01', partial: true, note: 'Ascensus: showing saved activity' }),
        plan({ account_id: 'd', name: 'Young', activityFrom: '2026-02-01' }),
      ],
      [out('2026-03-16', 250)],
      WHOLE_YEAR
    );
    expect(c.total).toBe(0);
    expect(c.unmeasured).toEqual(['Ascensus Failed']);
    expect(c.problems).toEqual([{ name: 'Ascensus Short', note: 'Ascensus: showing saved activity' }]);
    expect(c.partial).toEqual([{ name: 'Ascensus Short', from: '2026-06-01' }]);
    expect(c.shortHistory).toEqual([{ name: 'Ascensus Young', from: '2026-02-01' }]);
  });
});

describe('a transfer pays once, across every plan', () => {
  const k401 = plan({ account_id: 'k', name: '401(k)', institution: 'Fidelity', amount: 250, rows: [{ date: '2026-03-15', amount: 250 }] });
  const college = plan({ rows: [{ date: '2026-03-16', amount: 250 }] });

  test('the 529’s row takes it, and the workplace plan’s is added as paid through payroll', () => {
    const moved = [out('2026-03-16', 250)];
    const child = childSavings([college], moved, WHOLE_YEAR);
    expect(child.total).toBe(250);
    expect(child.left).toEqual([]);
    expect(workplaceSavings([k401], { transfersOut: toRetirementFunds(child.left), funding: [] }).total).toBe(250);
  });

  test('two payments in are paid by two transfers, the one left going on to the workplace plan', () => {
    const moved = [out('2026-03-16', 250), out('2026-03-15', 250)];
    const child = childSavings([college], moved, WHOLE_YEAR);
    expect(child.left).toEqual([out('2026-03-15', 250)]);
    expect(workplaceSavings([k401], { transfersOut: toRetirementFunds(child.left), funding: [] }).total).toBe(0);
  });

  test('a workplace plan still only matches transfers to investment and retirement funds', () => {
    const child = childSavings([], [out('2026-03-15', 250, 'account transfer')], WHOLE_YEAR);
    expect(child.left).toEqual([out('2026-03-15', 250, 'account transfer')]);
    expect(workplaceSavings([k401], { transfersOut: toRetirementFunds(child.left), funding: [] }).total).toBe(250);
  });
});

describe('the figures', () => {
  const child = childSavings([plan({ rows: [{ date: '2026-03-16', amount: 3_000 }] })], [out('2026-03-16', 3_000)], WHOLE_YEAR);
  const workplace = { total: 5_000, plans: [], fromBank: [], partial: [], shortHistory: [], problems: [], unmeasured: [] };

  test('annual savings without it, beside what workplace plans add', () => {
    expect(measuredInputs({ flows: flows(), workplace: null, child, assets }).savings).toBe(27_000);
    expect(measuredInputs({ flows: flows(), workplace, child, assets }).savings).toBe(32_000);
  });

  test('the savings rate without it, of the same income', () => {
    expect(savingsRate({ flows: flows(), workplace: null, child })).toBeCloseTo(27_000 / 70_000, 10);
    expect(savingsRate({ flows: flows(), workplace, child })).toBeCloseTo(32_000 / 75_000, 10);
  });

  test('never more than income minus spending holds: a lump paid from what was saved before isn’t a yearly shortfall', () => {
    const lump = childSavings([plan({ rows: [{ date: '2026-03-16', amount: 50_000 }] })], [out('2026-03-16', 50_000)], WHOLE_YEAR);
    expect(lump.total).toBe(50_000);
    expect(childTaken({ flows: flows({ savings: 20_000 }), child: lump })).toBe(20_000);
    expect(measuredInputs({ flows: flows({ savings: 20_000 }), workplace: null, child: lump, assets }).savings).toBe(0);
    expect(savingsRate({ flows: flows({ savings: 20_000 }), workplace: null, child: lump })).toBe(0);
    // What went into workplace plans was never paid from it, and stays.
    expect(measuredInputs({ flows: flows({ savings: 20_000 }), workplace, child: lump, assets }).savings).toBe(5_000);
    // Spending more than comes in: nothing of it is the 529's, and the figure stays as it was.
    expect(measuredInputs({ flows: flows({ savings: -4_000 }), workplace: null, child, assets }).savings).toBe(-4_000);
    expect(childTaken({ flows: null, child })).toBe(0);
  });

  test('nothing left out runs today’s arithmetic', () => {
    const none = childSavings([], [out('2026-03-16', 3_000)], WHOLE_YEAR);
    for (const c of [undefined, null, none]) {
      expect(measuredInputs({ flows: flows(), workplace, child: c, assets }).savings).toBe(35_000);
      expect(savingsRate({ flows: flows(), workplace, child: c })).toBeCloseTo(35_000 / 75_000, 10);
    }
  });

  test('savings you typed stay as typed, and the measured rate beside them still comes down', () => {
    const f = fiFigures({ ...DEFAULT_PLAN, age: 40, targetAge: 55, savings: 20_000 }, { flows: flows(), workplace: null, child, assets }, 'USD');
    expect(f.view.savings).toMatchObject({ value: 20_000, source: 'typed' });
    expect(f.savingsRate).toBeCloseTo(27_000 / 70_000, 10);
  });

  test('no year of transactions is no figure, whatever went in', () => {
    expect(measuredInputs({ flows: null, workplace: null, child, assets }).savings).toBeNull();
  });
});
