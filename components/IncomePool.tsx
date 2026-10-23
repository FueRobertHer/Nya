'use client';

// Income carryover on the Budgets tab (#37, lib/rollover.ts INCOME CARRYOVER):
// for someone whose income doesn't arrive on a calendar cycle, a running pool
// of what is left to allocate, carried from month to month, above the budget
// meters; and the setting that turns it on ("My income is irregular"), off by
// default. Budgets work the same either way: the pool answers "can I afford
// this at all", the meters what each budget has left.
//
// The pool is worked out on the server from the stored history
// (app/api/budgets/month): last month's leftover, plus this month's income so
// far, less this month's spending, with how it built up month by month, and
// which of those months may be incomplete.

import { useState } from 'react';
import { formatMoney } from '@/lib/format';
import { addMonths, monthName, monthsText, startChoices, type IncomeCarryover, type IncomePool } from '@/lib/rollover';
import { Masked } from './HideAmounts';

/** The "available to allocate" header, with the pool's history. */
export function IncomePoolHeader({ pool, currency, month, today }: { pool: IncomePool; currency: string | null; month: string; today: string }) {
  const [open, setOpen] = useState(false);
  const money = (n: number) => formatMoney(n, currency);
  const name = (m: string) => monthName(m, today);
  if (month < pool.from) {
    return (
      <div className="pool-header">
        <div className="pool-line">
          <span className="pool-label">Available to allocate</span>
        </div>
        <p className="panel-note">
          {pool.months.length === 0 && pool.clamped && pool.start <= month
            ? 'There are no transactions to count yet.'
            : `Income carryover counts from ${name(pool.from)}, so nothing is in it in ${name(month)}.`}
        </p>
      </div>
    );
  }
  const running = month === today;
  const last = name(addMonths(month, -1));
  return (
    <div className="pool-header">
      <div className="pool-line">
        <span className="pool-label">{running ? 'Available to allocate' : `Left to allocate at the end of ${name(month)}`}</span>
        <span className={`pool-amount${pool.available < 0 ? ' negative' : ''}`}>
          <Masked>{money(pool.available)}</Masked>
        </span>
      </div>
      <div className="pool-breakdown">
        <Masked>{month === pool.from ? 'Nothing carried in' : `${money(pool.carried_in)} left from ${last}`}</Masked>, plus <Masked>{money(pool.income)}</Masked> income
        {running ? ' so far' : ''}, less <Masked>{money(pool.spending)}</Masked> spent
      </div>
      {pool.uncertain.length > 0 && (
        <div className="stale-note">
          May be off: {monthsText(pool.uncertain, today)} {pool.uncertain.length === 1 ? 'is' : 'are'} incomplete.
        </div>
      )}
      {pool.clamped && (
        <div className="panel-note">
          Counting from {name(pool.from)}, the first month with transactions (it was set to start in {name(pool.start)}).
        </div>
      )}
      <button className="secondary pool-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide how it built up' : 'Show how it built up'}
      </button>
      {/* What each month carried in is the row below's Left (nothing, for
          the first), so it isn't a column: four fit a phone. */}
      {open && (
        <div className="pool-scroll">
          <table className="pool-table">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Income</th>
                <th scope="col">Spent</th>
                <th scope="col">Left</th>
              </tr>
            </thead>
            <tbody>
              {[...pool.months].reverse().map((m) => (
                <tr key={m.month}>
                  <th scope="row">
                    {monthName(m.month, today, 'short')}
                    {m.uncertain && <span className="pool-uncertain" title="Its transactions may be incomplete"> *</span>}
                  </th>
                  <td><Masked>{money(m.income)}</Masked></td>
                  <td><Masked>{money(m.spending)}</Masked></td>
                  <td><Masked>{money(m.carried_out)}</Masked></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && pool.months.some((m) => m.uncertain) && <div className="chart-note">* Its transactions may be incomplete.</div>}
    </div>
  );
}

/** The setting: off by default, turned on from a month chosen (this month by
 *  default), and off again (the month it counted from is kept). */
export function IncomeSetting({
  setting,
  today,
  earliest,
  disabled,
  onChange,
}: {
  setting: IncomeCarryover | null;
  today: string;
  earliest: string | null;
  disabled: boolean;
  /** Resolves true once saved. */
  onChange: (change: { enabled: true; start: string } | { enabled: false }) => Promise<boolean>;
}) {
  // Turned off, it kept the month it counted from: offered again first,
  // whether or not the first month with transactions is known yet (the
  // month may be shown before its history is read, and this is chosen once).
  const choices = startChoices(today, earliest, setting?.start ?? null);
  const [start, setStart] = useState(setting?.start && choices.includes(setting.start) ? setting.start : today);
  const [busy, setBusy] = useState(false);
  const save = async (change: { enabled: true; start: string } | { enabled: false }) => {
    setBusy(true);
    try {
      await onChange(change);
    } finally {
      setBusy(false);
    }
  };
  const on = !!setting?.enabled;
  return (
    <div className="income-setting">
      <div className="budget-line">
        <span className="budget-label">My income is irregular</span>
        <span className="budget-amounts">{on ? 'On' : 'Off'}</span>
      </div>
      {on ? (
        <>
          <p className="panel-note">
            What is left of each month’s income carries into the next, counted from {monthName(setting!.start, today)}, and the total available to
            allocate shows above your budgets. Budgets work as they always do.
          </p>
          <div className="card-actions">
            <button className="secondary" onClick={() => save({ enabled: false })} disabled={disabled || busy}>
              Turn off
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="panel-note">
            For income that doesn’t arrive every month: carry what is left of each month’s income into the next, and see what is available to allocate
            above your budgets. Budgets work as they always do.
          </p>
          <label className="budget-label" htmlFor="income-start">
            Count from
          </label>
          <select id="income-start" className="text-input budget-select" value={start} onChange={(e) => setStart(e.target.value)} disabled={disabled || busy}>
            {choices.map((m) => (
              <option key={m} value={m}>
                {m === today ? `${monthName(m, today)} (this month)` : monthName(m, today)}
              </option>
            ))}
          </select>
          <div className="card-actions">
            <button onClick={() => save({ enabled: true, start })} disabled={disabled || busy}>
              Turn on
            </button>
          </div>
        </>
      )}
    </div>
  );
}
