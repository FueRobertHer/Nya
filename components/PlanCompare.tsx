'use client';

// Compare mode's view: two to four plans, the Plan and its scenarios, metric
// by metric (components/plan-compare.ts), then what each plan is and what
// they share. Laid out by metric, a small table each with a row per plan, so
// it reads top to bottom on a phone, where four plans side by side would not
// fit; each table has a caption and the plan's name as the row's header, so
// a screen reader says "Retire at 50, 88.1%, 8.2 points lower". Renders from
// plain props: no fetching, no engine.

import type { ReactNode } from 'react';
import { Masked } from './HideAmounts';
import { compareRows, startsLine, type CompareColumn } from './plan-compare';
import { BLOCK_MONTHS, DEFAULT_RUNS, DEFAULT_SEED, type Method } from '@/lib/fire/simulate';
import { historySpan } from '@/lib/fire/history-span';
import { HYPOTHETICAL, METHOD_NAMES, monthName } from './plan-text';
import { plainNumber } from '@/lib/format';

export default function PlanCompare({
  columns,
  method,
  money,
  today,
  details,
}: {
  columns: CompareColumn[];
  method: Method;
  money: (n: number) => string;
  /** The viewer's calendar day, for the year an FI date falls in. */
  today: string;
  /** What each plan is, by column id. */
  details: Record<string, ReactNode>;
}) {
  const { rows, against } = compareRows(columns, money, today);
  const lengths = startsLine(columns);
  const span = historySpan();
  const pending = rows.some((r) => r.cells.some((c) => c.pending));
  return (
    <div className="plan-compare">
      <div className="plan-working-line" role="status">
        {pending ? 'Working out the plans…' : ''}
      </div>
      {against ? (
        <p className="panel-note">
          Differences are against <Masked>{against.name}</Masked>
          {against.id !== columns[0]?.id ? ', the first that could be worked out' : ''}. A plan that starts with a different balance shows no difference in amounts: they
          depend on what it starts with.
        </p>
      ) : (
        !pending && <p className="panel-note">None of these could be worked out, so there is nothing to compare yet.</p>
      )}
      <div className="plan-compare-grid">
        {rows.map((row) => (
          <table key={row.key} className="plan-compare-table">
            <caption>
              <Masked>{row.label}</Masked>
            </caption>
            <tbody>
              {row.cells.map((c) => (
                <tr key={c.id}>
                  <th scope="row">
                    <Masked>{c.name}</Masked>
                  </th>
                  <td>
                    {c.pending ? (
                      <span className="plan-muted">Working it out…</span>
                    ) : (
                      <>
                        <Masked>{c.value ?? '--'}</Masked>
                        {c.caveat && (
                          <span className="plan-warning">
                            <Masked>{c.caveat}</Masked>
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td className="plan-compare-diff">
                    <Masked>{c.diff}</Masked>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      </div>

      <div className="plan-subhead">What each plan is</div>
      {columns.map((c) => (
        <div key={c.id} className="plan-compare-detail">
          <div className="plan-compare-name">{c.name}</div>
          {details[c.id]}
        </div>
      ))}

      <div className="plan-subhead">The same for every plan</div>
      <ul className="plan-assumptions">
        <li>
          {method === 'historical'
            ? `${METHOD_NAMES.historical}: each plan starts in every month that leaves its whole length inside the history, and lives through what followed.`
            : `${METHOD_NAMES['monte-carlo']}: every plan is judged on the same ${plainNumber(DEFAULT_RUNS)} runs (seed ${DEFAULT_SEED}), built from ${BLOCK_MONTHS / 12}-year blocks of months drawn at random from the history, each run to its own length.`}{' '}
          Your plan’s method: a scenario can’t change it, so the differences come from the plans alone.
        </li>
        {lengths && (
          <li>
            These plans run different lengths, so each has its own starts:{' '}
            {lengths.map((l) => `${l.name}, ${l.years} years, ${plainNumber(l.paths)} starts${l.lastStart ? ` to ${monthName(l.lastStart)}` : ''}`).join('; ')}. The
            differences include the starts one plan has that another doesn’t.
          </li>
        )}
        <li>
          US market history, monthly returns from {monthName(span.first)} to {monthName(span.last)}, in today’s dollars.
        </li>
        <li>The same measured spending, savings and invested assets (Your path says where they come from), unless a plan types its own.</li>
        <li>{HYPOTHETICAL}</li>
      </ul>
    </div>
  );
}
