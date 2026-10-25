'use client';

// Income carryover on Budgets > Month (#37, lib/rollover.ts INCOME CARRYOVER):
// for someone whose income doesn't arrive on a calendar cycle, a running pool
// of what is left to allocate, carried from month to month, in a card of its
// own above the month's spending; and the setting that turns it on ("My
// income is irregular"), off by default, a row under the budgets that opens
// its sheet (rollout phase 6a2). Budgets work the same either way: the pool
// answers "can I afford this at all", the meters what each budget has left.
//
// The pool is worked out on the server from the stored history
// (app/api/budgets/month): last month's leftover, plus this month's income so
// far, less this month's spending, with how it built up month by month, and
// which of those months may be incomplete.

import { useState } from 'react';
import { formatMoney } from '@/lib/format';
import { addMonths, monthName, monthsText, startChoices, type IncomeCarryover, type IncomePool } from '@/lib/rollover';
import { Masked } from './HideAmounts';
import { Sheet } from './Sheet';
import { Notice } from './TotalCaveats';
import { chevron, RIGHT } from './ActivityBar';

const POOL_TITLE = 'budgets-pool-title';

/** "Available to allocate", with the pool's history. */
export function IncomePoolHeader({ pool, currency, month, today }: { pool: IncomePool; currency: string | null; month: string; today: string }) {
  const [open, setOpen] = useState(false);
  const money = (n: number) => formatMoney(n, currency);
  const name = (m: string) => monthName(m, today);
  if (month < pool.from) {
    return (
      <section className="card stack" aria-labelledby={POOL_TITLE}>
        <div className="card-header">
          <h3 id={POOL_TITLE}>Available to allocate</h3>
        </div>
        <p className="helper">
          {pool.months.length === 0 && pool.clamped && pool.start <= month
            ? 'There are no transactions to count yet.'
            : `Income carryover counts from ${name(pool.from)}, so nothing is in it in ${name(month)}.`}
        </p>
      </section>
    );
  }
  const running = month === today;
  const last = name(addMonths(month, -1));
  return (
    <section className="card stack" aria-labelledby={POOL_TITLE}>
      <div className="card-header">
        <h3 id={POOL_TITLE}>{running ? 'Available to allocate' : `Left to allocate at the end of ${name(month)}`}</h3>
        <span className={`money pool-amount${pool.available < 0 ? ' negative' : ''}`}>
          <Masked>{money(pool.available)}</Masked>
        </span>
      </div>
      <p className="helper">
        <Masked>{month === pool.from ? 'Nothing carried in' : `${money(pool.carried_in)} left from ${last}`}</Masked>, plus <Masked>{money(pool.income)}</Masked> income
        {running ? ' so far' : ''}, less <Masked>{money(pool.spending)}</Masked> spent
      </p>
      {pool.uncertain.length > 0 && (
        <Notice level="caution">
          May be off: {monthsText(pool.uncertain, today)} {pool.uncertain.length === 1 ? 'is' : 'are'} incomplete.
        </Notice>
      )}
      {pool.clamped && (
        <p className="helper">
          Counting from {name(pool.from)}, the first month with transactions (it was set to start in {name(pool.start)}).
        </p>
      )}
      <div className="btn-row">
        <button type="button" className="btn ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? 'Hide how it built up' : 'Show how it built up'}
        </button>
      </div>
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
    </section>
  );
}

type IncomeChange = { enabled: true; start: string } | { enabled: false };

/** The setting, as a row that opens its sheet: off by default, turned on
 *  from a month chosen (this month by default), and off again (the month it
 *  counted from is kept). The sheet closes once a change is saved, and stays
 *  open saying why when it isn't. */
export function IncomeSetting({
  setting,
  today,
  earliest,
  disabled,
  onChange,
  open: openAtFirst = false,
}: {
  setting: IncomeCarryover | null;
  today: string;
  earliest: string | null;
  disabled: boolean;
  /** Resolves null once saved, else why not. */
  onChange: (change: IncomeChange) => Promise<string | null>;
  /** Its sheet open at first. */
  open?: boolean;
}) {
  // Turned off, it kept the month it counted from: offered again first,
  // whether or not the first month with transactions is known yet (the
  // month may be shown before its history is read, and this is chosen once).
  const choices = startChoices(today, earliest, setting?.start ?? null);
  const first = setting?.start && choices.includes(setting.start) ? setting.start : today;
  const [open, setOpen] = useState(openAtFirst);
  const [start, setStart] = useState(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each opening starts afresh: the month offered first, no refusal left.
  const show = () => {
    setStart(first);
    setError(null);
    setOpen(true);
  };
  const close = () => !busy && setOpen(false);
  const save = async (change: IncomeChange) => {
    setBusy(true);
    setError(null);
    try {
      const refused = await onChange(change);
      if (refused === null) setOpen(false);
      else setError(refused);
    } finally {
      setBusy(false);
    }
  };
  const on = !!setting?.enabled;
  return (
    <>
      <ul className="card list-rows">
        <li>
          <button type="button" className="list-row" aria-haspopup="dialog" onClick={show}>
            <span className="list-row-text">
              <span className="list-row-title">My income is irregular</span>
            </span>
            <span className="list-row-value">{on ? 'On' : 'Off'}</span>
            {chevron(RIGHT)}
          </button>
        </li>
      </ul>
      <Sheet
        open={open}
        title="My income is irregular"
        onClose={close}
        footer={
          on ? (
            <button type="button" className="btn secondary" onClick={() => save({ enabled: false })} disabled={disabled || busy}>
              Turn off
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => save({ enabled: true, start })} disabled={disabled || busy}>
              Turn on
            </button>
          )
        }
      >
        <div className="stack">
          {error && <Notice level="caution">{error}</Notice>}
          {on ? (
            <p className="helper">
              What is left of each month’s income carries into the next, counted from {monthName(setting!.start, today)}, and the total available to
              allocate shows above your budgets. Budgets work as they always do.
            </p>
          ) : (
            <>
              <p className="helper">
                For income that doesn’t arrive every month: carry what is left of each month’s income into the next, and see what is available to allocate
                above your budgets. Budgets work as they always do.
              </p>
              <div className="sheet-form">
                <label className="field">
                  Count from
                  <select value={start} onChange={(e) => setStart(e.target.value)} disabled={disabled || busy}>
                    {choices.map((m) => (
                      <option key={m} value={m}>
                        {m === today ? `${monthName(m, today)} (this month)` : monthName(m, today)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}
