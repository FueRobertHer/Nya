import { describe, expect, test } from 'bun:test';
import { extendHistory, mergeRanges, reachOf, MAX_EXTENSION_DAYS, type WalkAccount } from '@/lib/history-import/walk';
import { importedHistoryLines, importedHistoryView } from '@/lib/history-import/view';
import type { WalkState } from '@/lib/history-import/store';

// The walk back from the chart's earliest point through imported history
// (lib/history-import/walk.ts): only across covered days, never spanning a
// gap between imported ranges, only bank accounts and cards, the anchor's own
// balances where it starts, and what each point holds for hiding.

const account = (over: Partial<WalkAccount> = {}): WalkAccount => ({
  account_id: 'chk',
  ids: ['chk'],
  type: 'depository',
  flows: new Map(),
  covered: [],
  ...over,
});

describe('covered ranges', () => {
  test('overlapping and touching ranges join; a day between two keeps them apart', () => {
    const merged = mergeRanges([
      { from: '2023-01-01', to: '2023-12-31', kind: 'import' },
      { from: '2024-01-01', to: '2024-06-30', kind: 'bank' },
      { from: '2024-03-01', to: '2024-04-01', kind: 'import' },
      { from: '2024-07-02', to: '2024-09-01', kind: 'import' },
    ]);
    expect(merged.length).toBe(2);
    expect(merged[0].imported).toBe(true);
  });

  test('imports of 2019 and 2023 without 2020 to 2022: the walk reaches through 2023 and no further, and says what isn’t drawn', () => {
    const r = reachOf(
      account({
        covered: [
          { from: '2019-01-01', to: '2019-12-31', kind: 'import' },
          { from: '2023-01-01', to: '2023-12-31', kind: 'import' },
          { from: '2024-01-01', to: '2025-10-09', kind: 'bank' },
        ],
      }),
      '2024-10-10',
      true,
      { today: '2025-10-09' }
    );
    expect(r).toEqual({
      account_id: 'chk',
      reach: '2022-12-31',
      why: null,
      gaps: [{ imported: { from: '2019-01-01', to: '2019-12-31' }, uncovered: { from: '2020-01-01', to: '2022-12-31' } }],
      capped: false,
    });
  });

  test('an anchor no range covers is walked nowhere, and every import before it is a gap up to the next covered day', () => {
    const r = reachOf(account({ covered: [{ from: '2019-01-01', to: '2019-12-31', kind: 'import' }] }), '2024-10-10', true, { today: '2025-10-09' });
    expect(r.reach).toBeNull();
    expect(r.why).toBe('anchor-not-covered');
    expect(r.gaps).toEqual([{ imported: { from: '2019-01-01', to: '2019-12-31' }, uncovered: { from: '2020-01-01', to: '2025-10-09' } }]);
  });

  test('an import holding the anchor that ends before the bank’s days begin isn’t drawn: the anchor’s balance rests on days nothing covers', () => {
    const r = reachOf(
      account({
        covered: [
          { from: '2024-01-01', to: '2024-11-30', kind: 'import' },
          { from: '2025-01-01', to: '2025-10-09', kind: 'bank' },
        ],
      }),
      '2024-10-10',
      true,
      { today: '2025-10-09' }
    );
    expect(r).toMatchObject({ reach: null, why: null, gaps: [{ imported: { from: '2024-01-01', to: '2024-11-30' }, uncovered: { from: '2024-12-01', to: '2024-12-31' } }] });
  });

  test('an account the anchor held at one balance is walked only if nothing happened to it since', () => {
    const covered = [{ from: '2024-01-01', to: '2025-10-09', kind: 'import' as const }];
    expect(reachOf(account({ covered, movedAfter: true }), '2024-10-10', true, { today: '2025-10-09', heldFlat: true })).toMatchObject({ reach: null, why: 'held-flat' });
    expect(reachOf(account({ covered, movedAfter: false }), '2024-10-10', true, { today: '2025-10-09', heldFlat: true }).reach).toBe('2023-12-31');
    expect(reachOf(account({ covered, movedAfter: true }), '2024-10-10', true, { today: '2025-10-09', heldFlat: false }).reach).toBe('2023-12-31');
  });

  test('no further back than thirty years, and said so', () => {
    const r = reachOf(account({ covered: [{ from: '1950-01-01', to: '2025-10-09', kind: 'import' }] }), '2025-10-09', true, { today: '2025-10-09' });
    expect(r.capped).toBe(true);
    expect(Date.parse(`${'2025-10-09'}T00:00:00Z`) - Date.parse(`${r.reach}T00:00:00Z`)).toBe(MAX_EXTENSION_DAYS * 86_400_000);
  });
});

describe('walking back from the anchor', () => {
  const anchor = { date: '2025-01-10', total: 1500, balances: { chk: 1000, card: 300, ira: 800 } };

  test('a bank account’s balance rises by what left it and a card’s owed falls by what was charged, and the total follows', () => {
    const chk = account({
      flows: new Map([
        ['2025-01-10', 100], // paid out on the anchor's day: the day before held 100 more
        ['2025-01-09', -50], // paid in the day before
      ]),
      covered: [{ from: '2025-01-01', to: '2025-01-31', kind: 'import' }],
    });
    const card = account({
      account_id: 'card',
      ids: ['card'],
      type: 'credit',
      flows: new Map([['2025-01-10', 40]]), // a purchase raised what is owed on the anchor's day
      covered: [{ from: '2025-01-01', to: '2025-01-31', kind: 'import' }],
    });
    const out = extendHistory({ anchor, today: '2025-01-31', accounts: [chk, card] });
    const day = (d: string) => out.points.find((p) => p.date === d)!;
    expect(day('2025-01-09')).toEqual({ date: '2025-01-09', total: 1500 + 100 + 40, walked: { chk: 1100, card: 260 }, held: { ira: 800 } });
    expect(day('2025-01-08')).toMatchObject({ total: 1500 + 100 - 50 + 40, walked: { chk: 1050, card: 260 } });
    // The day before the covered run begins is the last point: what each held before it.
    expect(out.from).toBe('2024-12-31');
    expect(out.points[0].date).toBe('2025-01-09');
    expect(out.points[out.points.length - 1].date).toBe('2024-12-31');
  });

  test('an account is held, at the balance it reached, on days before its own covered run, never drawn there as its own point', () => {
    const long = account({ flows: new Map([['2024-12-20', 10]]), covered: [{ from: '2024-12-01', to: '2025-01-31', kind: 'import' }] });
    const short = account({
      account_id: 'card',
      ids: ['card'],
      type: 'credit',
      flows: new Map([['2025-01-05', 25]]),
      covered: [
        { from: '2025-01-03', to: '2025-01-09', kind: 'import' },
        { from: '2025-01-10', to: '2025-01-31', kind: 'bank' },
      ],
    });
    const out = extendHistory({ anchor, today: '2025-01-31', accounts: [long, short] });
    const early = out.points.find((p) => p.date === '2024-12-25')!;
    expect(early.walked).toEqual({ chk: 1000 });
    expect(early.held).toEqual({ ira: 800, card: 275 });
    // Held at what it reached: the card owed 25 less before that charge.
    expect(early.total).toBe(1000 + (-275) + 800);
    expect(out.from).toBe('2024-11-30');
  });

  test('investment accounts and loans are never walked: held at the anchor’s balance whatever was imported into them', () => {
    const out = extendHistory({ anchor, today: '2025-01-31', accounts: [account({ covered: [{ from: '2024-12-01', to: '2025-01-31', kind: 'import' }] })] });
    expect(out.points.every((p) => p.held.ira === 800 && p.held.card === 300)).toBe(true);
  });

  test('an estimate’s flat term holds an account without its flows: walked from it only when nothing happened since', () => {
    const flat = { ...anchor, walked: ['card'] };
    const moved = extendHistory({ anchor: flat, today: '2025-01-31', accounts: [account({ covered: [{ from: '2024-12-01', to: '2025-01-31', kind: 'import' }], movedAfter: true })] });
    expect(moved.points).toEqual([]);
    expect(moved.accounts[0]).toMatchObject({ why: 'held-flat' });
    // A recorded anchor measured every balance: walked.
    const recorded = extendHistory({ anchor: { ...anchor, walked: null }, today: '2025-01-31', accounts: [account({ covered: [{ from: '2024-12-01', to: '2025-01-31', kind: 'import' }], movedAfter: true })] });
    expect(recorded.points.length).toBeGreaterThan(0);
  });

  test('an account the anchor doesn’t count isn’t walked: it would add money to a past whose total never had it', () => {
    const out = extendHistory({ anchor, today: '2025-01-31', accounts: [account({ account_id: 'new', ids: ['new'], covered: [{ from: '2024-01-01', to: '2025-01-31', kind: 'import' }] })] });
    expect(out.points).toEqual([]);
    expect(out.accounts[0]).toMatchObject({ reach: null, why: 'not-counted' });
  });

  test('a re-linked account is found at the anchor under its earlier id, and drawn under its current one', () => {
    const relinked = account({ account_id: 'chk-new', ids: ['chk-new', 'chk'], covered: [{ from: '2025-01-01', to: '2025-01-31', kind: 'import' }] });
    const out = extendHistory({ anchor, today: '2025-01-31', accounts: [relinked] });
    expect(out.points[0].walked).toEqual({ 'chk-new': 1000 });
    expect('chk' in out.points[0].held).toBe(false);
  });

  test('nothing imported before the anchor draws nothing: the bank’s own days alone are the backfill’s', () => {
    const bankOnly = extendHistory({ anchor, today: '2025-01-31', accounts: [account({ covered: [{ from: '2024-06-01', to: '2025-01-31', kind: 'bank' }] })] });
    expect(bankOnly.points).toEqual([]);
    expect(bankOnly.accounts[0]).toMatchObject({ reach: null, why: null, gaps: [] });
    const fromTheAnchor = extendHistory({ anchor, today: '2025-01-31', accounts: [account({ covered: [{ from: '2025-01-10', to: '2025-01-31', kind: 'import' }] })] });
    expect(fromTheAnchor.points).toEqual([]);
    expect(extendHistory({ anchor, today: '2025-01-31', accounts: [] }).points).toEqual([]);
  });

  test('an import reaching the bank’s days walks through them too, back to its own start', () => {
    const out = extendHistory({
      anchor,
      today: '2025-01-31',
      accounts: [
        account({
          flows: new Map([['2024-12-15', 100]]),
          covered: [
            { from: '2024-12-01', to: '2025-01-31', kind: 'bank' },
            { from: '2024-10-01', to: '2024-11-30', kind: 'import' },
          ],
        }),
      ],
    });
    expect(out.from).toBe('2024-09-30');
    expect(out.points.find((p) => p.date === '2024-12-14')?.walked).toEqual({ chk: 1100 });
  });
});

describe('what the chart says', () => {
  const state = (over: Partial<WalkState>): WalkState => ({
    version: 1,
    generation: 3,
    built: 3,
    built_at: '2026-10-09T00:00:00.000Z',
    anchor: '2025-10-10',
    from: '2021-12-31',
    drawn: { from: '2021-12-31', until: '2025-10-10' },
    accounts: [],
    rows: 0,
    problem: null,
    ...over,
  });
  const name = (id: string) => ({ chk: 'Chase Checking', card: 'Chase Visa' })[id] ?? id;
  const day = (d: string) => d;

  const walked = (over: Partial<WalkState['accounts'][number]>): WalkState['accounts'][number] => ({
    account_id: 'chk',
    reach: null,
    why: null,
    gaps: [],
    capped: false,
    bank_from: null,
    excluded: [],
    ...over,
  });

  test('which stretch of which account follows imported rows rather than the bank’s own, and what isn’t drawn and why', () => {
    const view = importedHistoryView(
      state({
        accounts: [
          walked({ reach: '2021-12-31', bank_from: '2024-10-12', gaps: [{ imported: { from: '2019-01-01', to: '2019-12-31' }, uncovered: { from: '2020-01-01', to: '2021-12-31' } }] }),
          walked({ account_id: 'card', why: 'anchor-not-covered' }),
        ],
      })
    )!;
    expect(importedHistoryLines(view, name, day)).toEqual([
      'Chase Checking: the estimate follows its bank’s own transactions back to 2024-10-12, and those you imported before that, back to 2021-12-31.',
      'Before 2025-10-10, every other account is held at its balance on that day.',
      'Not drawn: Chase Checking’s import from 2019-01-01 to 2019-12-31, since nothing covers 2020-01-01 to 2021-12-31. Import that period to join it up.',
      'Chase Visa’s imported history isn’t drawn: nothing covers 2025-10-10, the chart’s earliest day, for it. Import a file that reaches up to then.',
    ]);
  });

  test('an import not used, an account held flat, and a drawing that couldn’t be made: each said', () => {
    const view = importedHistoryView(
      state({
        accounts: [walked({ excluded: [{ from: '2020-01-01', to: '2020-12-31', why: 'unreadable', lines: 3 }] }), walked({ account_id: 'card', why: 'held-flat' })],
        problem: { kind: 'unreadable', accounts: ['chk'] },
        built: 2,
      })
    )!;
    expect(importedHistoryLines(view, name, day)).toEqual([
      'Chase Checking’s import from 2020-01-01 to 2020-12-31 isn’t used for the chart: 3 of its lines couldn’t be read, so it may lack their transactions.',
      'Chase Visa’s imported history isn’t drawn: the estimate holds it at one balance up to 2025-10-10, though it has transactions since, so what it held then isn’t known.',
      'The estimate from imported transactions couldn’t be drawn again: Chase Checking’s imported transactions can’t be read just now. What it showed before is kept.',
    ]);
  });

  test('a hidden account is never named: the chart leaves it out', () => {
    const view = importedHistoryView(state({ accounts: [walked({ reach: '2021-12-31' }), walked({ account_id: 'card', reach: '2022-01-01' })] }), new Set(['card']))!;
    expect(view.accounts.map((a) => a.account_id)).toEqual(['chk']);
    expect(importedHistoryView(state({ accounts: [walked({ account_id: 'card', reach: '2022-01-01' })] }), new Set(['card']))).toBeNull();
  });

  test('nothing to say, nothing said; and a drawing marked again says so', () => {
    expect(importedHistoryView(null)).toBeNull();
    expect(importedHistoryView(state({ anchor: null }))).toBeNull();
    expect(importedHistoryView(state({ accounts: [] }))).toBeNull();
    const redrawing = importedHistoryView(state({ built: 2, accounts: [walked({ reach: '2024-01-01' })] }))!;
    expect(redrawing.redrawing).toBe(true);
  });
});
