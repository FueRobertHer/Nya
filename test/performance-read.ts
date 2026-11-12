// The reader's result for made-up months (test/vanguard-performance-pdf.ts),
// put together by hand so a test can break one check at a time: for the
// review's tests (test/performance-review.test.ts) and the sheet's
// (test/performance-import-view.test.tsx).

import type { Read } from '@/lib/import/performance-review';
import type { MonthCheck } from '@/lib/import/vanguard-performance';
import { lastDayOf } from '@/lib/investment-months';
import type { MonthFigures } from './vanguard-performance-pdf';

export const RANGE = { from: '2024-01-01', to: '2026-11-05' };

/** The reader's result for `ms`, every check passed unless `failed` says
 *  otherwise; `figures` overrides what was read for a month. */
export function readOf(
  ms: MonthFigures[],
  o: { range?: { from: string; to: string }; failed?: Record<string, MonthCheck[]>; figures?: Record<string, Partial<Record<Exclude<keyof MonthFigures, 'month'>, number | null>>> } = {}
): Read {
  const range = o.range ?? RANGE;
  const months = ms.map((m, k) => {
    const over = o.figures?.[m.month] ?? {};
    const pick = (f: Exclude<keyof MonthFigures, 'month'>) => (f in over ? (over[f] ?? null) : m[f]);
    const whole = (k > 0 || range.from.endsWith('-01')) && (k < ms.length - 1 || range.to === lastDayOf(m.month));
    return {
      month: m.month,
      figures: {
        begin: pick('begin'),
        net: pick('net'),
        market: pick('market'),
        income: pick('income'),
        returns: pick('returns'),
        cumulative: pick('cumulative'),
        end: pick('end'),
      },
      whole,
      failed: o.failed?.[m.month] ?? [],
    };
  });
  const sum = (f: 'net' | 'market' | 'income' | 'returns') => ms.reduce((s, m) => s + m[f], 0);
  return {
    kind: 'read',
    range,
    months,
    total_differs: [],
    total: { net: sum('net'), market: sum('market'), income: sum('income'), returns: sum('returns') },
    summary: { begin: ms[0].begin, end: ms[ms.length - 1].end, net: sum('net'), returns: sum('returns') },
    summary_differs: [],
    begins_at_zero: ms[0].begin === 0,
    last: { day: range.to, balance: ms[ms.length - 1].end },
    ok: !o.failed,
  };
}
