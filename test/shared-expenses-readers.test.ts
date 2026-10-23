import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { trailingFlows } from '@/lib/fire/inputs';
import { historyNote } from '@/lib/cash-flow';
import { buildRunwayInputs, countedPart, runwayWindow, windowSpending } from '@/lib/report/runway';
import { detectRecurring } from '@/lib/recurring';
import { applyShares, type ShareInputs } from '@/lib/shared-expenses/rows';
import type { Iou, Share } from '@/lib/shared-expenses/model';
import { calendarMonth } from '@/lib/calendar';
import { countToReview } from '@/lib/review-layer';
import { summarize } from '@/lib/totals';
import type { Txn } from '@/lib/transactions';
import { row as runwayRow } from './runway-fixture';

// The readers with rules of their own, held to the shared-expense rule
// (lib/shared-expenses/rows.ts): the rows it adds are never evidence of where
// history begins or whether transactions come in (the Plan's history length,
// the cash flow's late-history note, and every count noSpending reads, held
// by a scan of the source); the runway matches a shared bill by the bill and
// adds your part on its dates; the Plan counts an IOU settled in cash once
// beside the withdrawal; the calendar's day says your part; a shared
// transaction is reviewed once.

const AT = '2026-10-01T12:00:00.000Z';
const day = (today: string, back: number) => new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
const base = (id: string, over: Partial<Txn> = {}): Txn => runwayRow(id, over.date ?? '2026-10-01', over.amount ?? 10, { account_id: 'chk', category: 'food and drink', category_kind: 'expense', ...over });
const inputs = (over: Partial<ShareInputs> = {}): ShareInputs => ({ counting: 'part', shares: new Map(), sharesUnknown: new Set(), payments: new Map(), paymentsUnknown: new Set(), ious: new Map(), iousUnread: 0, ix: null, ...over });
const iou = (over: Partial<Iou> = {}): Iou => ({ version: 1, person: 'alex', direction: 'by_you', amount: 25, currency: 'USD', date: '2026-10-05', what: 'Groceries', category_id: 'c1', created_at: AT, updated_at: AT, ...over });
const half = (id: string, whole: number, date: string): [string, Share] => [
  id,
  { version: 1, account_id: 'chk', amount_was: whole, currency: 'USD', date, what: 'Bill', entries: [{ id: `e-${id}`, person: 'sam', amount: whole / 2 }], created_at: AT, updated_at: AT },
];

describe('rows the layer adds are never evidence of history (Blocking 1)', () => {
  test('an old IOU leaves the Plan’s history length, and so its spending, as the bank’s rows make it', () => {
    const today = '2026-10-23';
    const bank = Array.from({ length: 40 }, (_, i) => base(`b${i}`, { date: day(today, i), amount: 50 }));
    const old = applyShares([], inputs({ ious: new Map([['i1', iou({ date: day(today, 300) })]]) })).rows;
    expect(old).toHaveLength(1);
    const without = trailingFlows(bank, today)!;
    const withIou = trailingFlows([...bank, ...old], today)!;
    expect(withIou.days).toBe(without.days);
    // The IOU's $25 counts, scaled as the bank's history is: never a year of $50 a day spread over 300 days.
    expect(Math.round(withIou.spending)).toBe(Math.round(without.spending + 25 * (365 / without.days)));
  });

  test('the cash flow’s late-history note names the bank’s first day, never an IOU’s', () => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    const bank = [base('b', { date: '2026-09-01' })];
    const early = applyShares([], inputs({ ious: new Map([['i1', iou({ date: '2025-10-25' })]]) })).rows;
    expect(historyNote({ from: '2025-11-01' }, [...bank, ...early], now)).toBe(historyNote({ from: '2025-11-01' }, bank, now));
    expect(historyNote({ from: '2025-11-01' }, bank, now)).toContain('Sep 1, 2026');
  });

  test('every reader that counts rows for coverage, or takes the earliest, reads isHistoryRow (a scan of the source)', () => {
    const root = join(import.meta.dir, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(root, dir))) {
        const path = join(dir, name);
        if (statSync(join(root, path)).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    walk('lib');
    walk('components');
    // A count of rows handed to what says whether transactions come in:
    // always historyCount(...), never a plain length.
    const counted = /\b(noSpending\w*|withoutTransactionsNotes|withoutNote|transactionCoverage)\([^;]*?\b[\w.?]+\.length\b/;
    const plain = files.filter((f) => counted.test(readFileSync(join(root, f), 'utf8')));
    expect(plain).toEqual([]);
    // The earliest day over rows: in a module that applies the rule, or one
    // that reads stored rows, never the read layer's (each named, with why).
    const earliest = /\b\w+\.date\s*<\s*(earliest|first|oldest|min)\b|\.date\.slice\(0,\s*7\)\s*<\s*m\b|\b(first|earliest|oldest)\s*=\s*\w+\.date\b/;
    const STORED: Record<string, string> = {
      'lib/transactions.ts': 'the banks’ stored rows',
      'lib/history.ts': 'balance history points',
      'lib/goal-flows.ts': 'rows by account, which an IOU’s row has none of',
      'lib/user-export.ts': 'the stored rows of the download',
      'lib/history-import/plan.ts': 'a file’s rows',
      'lib/history-import/read.ts': 'rows imported from files',
      'lib/import/commit.ts': 'a file’s rows',
      'lib/migration/plan.ts': 'another app’s export',
      'lib/budget-month.ts': 'the manual books',
      'lib/backfill.ts': 'the banks’ stored rows',
      'lib/shared-expenses/balances.ts': 'items’ days, never rows',
      'lib/shared-expenses/rows.ts': 'the rows it is given, before it adds any',
    };
    const found = files.filter((f) => earliest.test(readFileSync(join(root, f), 'utf8')));
    const unruled = found.filter((f) => !STORED[f] && !/\bisHistoryRow\(/.test(readFileSync(join(root, f), 'utf8')));
    expect(unruled).toEqual([]);
    // And the readers the review named do apply it.
    for (const f of ['lib/fire/inputs.ts', 'lib/cash-flow.ts', 'lib/share-views.ts']) expect(readFileSync(join(root, f), 'utf8')).toContain('isHistoryRow(');
  });
});

describe('the runway: a shared bill is a bill, at your part (Blocking 2)', () => {
  const TODAY = '2026-10-23';
  const quarterly = ['2025-11-15', '2026-02-15', '2026-05-15', '2026-08-15'];
  const water = quarterly.map((d, i) => base(`w${i}`, { date: d, amount: 300, name: 'City Water', vendor_key: 'city water', category: 'rent and utilities' }));
  const shares = new Map(water.map((t) => half(t.transaction_id, 300, t.date)));
  const position = { currency: 'USD', balances: 5000, pending: { amount: 0, count: 0 }, start: 5000, included: [{ account_id: 'chk', name: 'Checking', institution: 'Chase', balance: 5000, manual: false }], leftOut: [], noBalance: [] };

  test('a quarterly $300 water bill shared half: $600 a year of your part out of the average, $150 on each date to come', () => {
    const part = applyShares([...water].reverse(), inputs({ shares })).rows;
    const series = detectRecurring(part);
    expect(series.find((s) => s.name === 'City Water')?.amount).toBe(300);
    expect(countedPart(series, part).get(series[0].id)).toBe(0.5);
    const b = buildRunwayInputs({ today: TODAY, position, rows: part, planned: [], dismissed: [] });
    const twelve = b.windows.find((w) => w.months === 12)!;
    expect(twelve.infrequent).toBe(600);
    expect(twelve.spending).toBe(0);
    expect(b.events.filter((e) => e.name === 'City Water').map((e) => e.amount)).toEqual(b.events.filter((e) => e.name === 'City Water').map(() => -150));
    expect(b.shared_bills).toBe(1);
    // As the bank shows them: the whole bill, both ways.
    const whole = buildRunwayInputs({ today: TODAY, position, rows: [...water].reverse(), planned: [], dismissed: [] });
    expect(whole.windows.find((w) => w.months === 12)!.infrequent).toBe(1200);
    expect(whole.events.filter((e) => e.name === 'City Water').every((e) => e.amount === -300)).toBe(true);
    expect(whole.shared_bills).toBe(0);
  });

  test('a shared monthly bill stays a bill (never a one-off), its part in the average', () => {
    const months = ['2026-07-01', '2026-08-01', '2026-09-01'];
    const rent = months.map((d, i) => base(`r${i}`, { date: d, amount: 2000, name: 'Landlord', vendor_key: 'landlord', category: 'rent and utilities' }));
    const part = applyShares([...rent].reverse(), inputs({ shares: new Map(rent.map((t) => half(t.transaction_id, 2000, t.date))) })).rows;
    const w = windowSpending(part, runwayWindow(TODAY, 3), 'USD', [], { series: detectRecurring(part) });
    expect(w.spending).toBe(3000);
    expect(w.one_offs).toEqual([]);
  });
});

describe('the Plan: an IOU settled in cash counts once (Blocking 3)', () => {
  test('$100 out of an ATM handed over for an IOU you owe: 101, never 201', () => {
    const today = '2026-10-23';
    const rows = [
      base('old', { date: '2025-10-24', amount: 1 }),
      base('atm', { date: '2026-10-01', amount: 100, transaction_code: 'atm', category: 'transfer out', category_kind: 'transfer', subcategory: 'withdrawal' }),
    ];
    const cash = iou({ amount: 100, date: '2026-10-01', closed: [{ event: 'ev', kind: 'outside', amount: 100, date: '2026-10-01', at: AT }] });
    const iouRows = applyShares([], inputs({ ious: new Map([['i1', cash]]) })).rows;
    const f = trailingFlows([...rows, ...iouRows], today)!;
    expect(f.spending).toBe(101);
    expect(f.cashIous).toBe(100);
    // Paid by a transfer instead: both the IOU and the transfer, the IOU counted.
    const open = applyShares([], inputs({ ious: new Map([['i1', iou({ amount: 100, date: '2026-10-01' })]]) })).rows;
    expect(trailingFlows([...rows, ...open], today)!.spending).toBe(201);
  });
});

describe('the calendar and the review queue', () => {
  test('a shared dinner’s day says your part, and it is one transaction to review', () => {
    const dinner = base('t-dinner', { date: '2026-10-03', amount: 120, needs_review: true } as Partial<Txn>);
    const shares = new Map([half('t-dinner', 120, '2026-10-03')]);
    const rows = applyShares([dinner], inputs({ shares })).rows;
    const month = calendarMonth({ month: '2026-10', today: '2026-10-23', txns: rows, series: [], planned: [], currency: 'USD' } as Parameters<typeof calendarMonth>[0]);
    const entry = [...month.days.values()].flatMap((d) => d.entries).find((e) => e.ref === 't-dinner')!;
    expect(entry.amount).toBe(-120);
    expect(entry.counted).toBe(-60);
    expect(countToReview(rows)).toBe(1);
    expect(summarize(rows, (d) => d.startsWith('2026-10'), 'USD').excluded).toBe(0);
  });
});
