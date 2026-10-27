'use client';

// The runway on the report page (app/reports, lib/report/runway.ts): how long
// the person's cash would last at their recent spending, with their income and
// without it, the day it would run out, the cash going forward as a chart,
// what it is worked out from, and what it can't see; printable like the other
// reports (the controls and the saved scenarios are for the screen only).
//
// The inputs come from the server (app/api/reports/runway), read from what Nya
// has stored, in this browser's time zone. The WHAT-IF (the window, spending
// lower by an amount a month, the day income stops, planned items and
// one-offs in or out, money moved out counted) is worked out here, from those inputs, and is never
// sent or stored: only a scenario the person saves by name is
// (app/api/runway-scenarios), and that keeps the settings, never a figure.

import { useCallback, useEffect, useState } from 'react';
import { Sheet } from './Sheet';
import RunwayChart from './RunwayChart';
import { Masked } from './HideAmounts';
import { Segmented } from './Segmented';
import { reportDay, reportTime } from './ReportView';
import { fieldAmount, formatMoney } from '@/lib/format';
import { addDays, isTimeZone } from '@/lib/report/period';
import { DEFAULT_WHAT_IF, MONTH_DAYS, monthsText, projectRunway, RUNWAY_WINDOWS, windowOf, type RunwayLine, type RunwayProjection, type RunwayWhatIf } from '@/lib/report/runway';
import type { RunwayReport as Runway } from '@/lib/report/runway-read';
import { MAX_SCENARIOS, SCENARIO_NAME_MAX, scenarioWhatIf, type RunwayScenario } from '@/lib/report/runway-scenarios';
import { hasMovedOut, hasOneOffs, runwayCaveats, runwayConvertedText, whatIfWords, type RunwayFormats } from '@/lib/report/runway-words';
import { cadenceLabel } from '@/lib/recurring';
import { plannedCadenceLabel } from '@/lib/planned';
import { isCurrencyCode, minorDigits, parseAmountInput, DEFAULT_CURRENCY, MAX_AMOUNT } from '@/lib/manual-txn-input';
import { joinNames } from '@/lib/month-coverage';

/** "Aug 2026": a month of a window. */
const monthWords = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', year: 'numeric' });

/** How long a line lasts, in a figure and in words. */
export function lastsWords(line: RunwayLine, today: string): { figure: string; words: string } {
  if (line.outcome === 'no_cash') return { figure: 'No cash', words: 'not known: no checking, savings or cash on hand is in Nya to start from' };
  if (line.outcome === 'no_spending') return { figure: 'Not known', words: 'not known: there is no spending in these months to go by' };
  if (line.outcome === 'runs_out') {
    if (line.runs_out === today) return { figure: 'None', words: 'below zero now' };
    if (line.days === 0) return { figure: 'Under a day', words: `runs out around ${reportDay(line.runs_out!)}` };
    return { figure: `${monthsText(line.months!)} months`, words: `${line.days} days, to around ${reportDay(addDays(line.runs_out!, -1))}; runs out around ${reportDay(line.runs_out!)}` };
  }
  if (line.outcome === 'beyond') return { figure: 'Over 10 years', words: 'more than ten years at this rate' };
  return { figure: 'Doesn’t run out', words: 'at this rate, what comes in covers what goes out' };
}

/** What income is in a line, in words: a day gone is said as gone. */
export function incomeWords(line: RunwayLine, today: string): string {
  if (line.income.kind !== 'until') return 'With your income';
  return line.income.date < today ? `Income stopped after ${reportDay(line.income.date)}` : `With income until ${reportDay(line.income.date)}`;
}

/** The page's formats: days and months on the reader's calendar. */
const FORMATS = (r: Runway): RunwayFormats => ({ day: reportDay, time: (iso) => reportTime(iso, r.time_zone), month: monthWords });

/** An amount listed, in words, as part of the spending or the income. */
const part = (words: string, amount: number, money: (n: number) => string) => `${words}: ${money(amount)}`;

/** The runway as a page to read and print. No hooks and no state. */
export function RunwayView({ runway, projection }: { runway: Runway; projection: RunwayProjection }) {
  const money = (n: number) => formatMoney(n, runway.currency);
  const w = projection.window;
  const without = lastsWords(projection.without_income, runway.today);
  const withIncome = lastsWords(projection.with_income, runway.today);
  const caveats = runwayCaveats(runway, projection, FORMATS(runway));
  // With a home currency: what was converted into the runway's currency.
  const converted = runwayConvertedText(runway, w);
  // An amount converted, beside the one it was written in.
  const ownToo = (own: { amount: number; currency: string } | undefined) => (own ? ` (${formatMoney(own.amount, own.currency)})` : '');
  const cash = runway.position;
  const where = joinNames(runway.cash_accounts.map((a) => `${a.name} at ${a.institution}`));
  const asOf = runway.cash_accounts.find((a) => a.as_of !== null)?.as_of ?? null;
  const empty = runway.cash_accounts.length === 0 && cash.noBalance.length === 0;
  const known = projection.without_income.outcome !== 'no_cash' && projection.without_income.outcome !== 'no_spending';
  const whatIf = projection.what_if;
  const changed = whatIf.lower_by > 0 || (whatIf.leave_out_one_offs && hasOneOffs(w)) || (whatIf.count_moved_out && hasMovedOut(w));
  const income = incomeWords(projection.with_income, runway.today);
  const spendingParts = [
    part('Money out as the Activity tab counts it', w.money_out, money),
    ...(w.refunds > 0 ? [part('less refunds, which don’t stop when pay does', w.refunds, money)] : []),
    ...(w.infrequent > 0 ? [part('less bills that come less often than monthly, added on their dates instead', w.infrequent, money)] : []),
    ...(w.card_payments_total > 0 ? [part('plus payments to cards Nya doesn’t see', w.card_payments_total, money)] : []),
  ];

  return (
    <article className="report runway-report" aria-label="Runway">
      <section className="report-page report-first">
        <header className="report-head">
          <div className="report-kicker">Nya</div>
          <h1>Runway</h1>
          <p className="report-meta">
            An estimate of how long your cash would last at your recent spending, made {reportTime(runway.generated_at, runway.time_zone)}. Amounts in{' '}
            {runway.currency ?? 'the currency your accounts are in'}.{converted ? ` ${converted}` : ''} Today’s date is read in {runway.time_zone}.
          </p>
        </header>

        <div className={`report-status${caveats.length > 0 ? ' report-status-short' : ''}`} role="note">
          <p className="report-headline">{caveats.length > 0 ? 'What it can’t see:' : 'Nothing is known to be missing from it.'}</p>
          {caveats.length > 0 && (
            <ul>
              {caveats.map((c, i) => (
                <li key={i}>
                  <Masked>{c}</Masked>
                </li>
              ))}
            </ul>
          )}
        </div>

        {empty ? (
          <p className="report-note">A runway starts from your checking, savings and cash on hand. Connect a bank, or add a manual account, to see one.</p>
        ) : (
          <>
            <div className="report-bottom-line">
              <div>
                <div className="total-label">Cash now</div>
                <div className="report-figure">
                  <Masked>{money(runway.start)}</Masked>
                </div>
              </div>
              <div>
                <div className="total-label">Without income</div>
                <div className="report-figure">{without.figure}</div>
              </div>
              <div>
                <div className="total-label">{income}</div>
                <div className="report-figure">{withIncome.figure}</div>
              </div>
              <p className="report-note">
                If your income stopped, your cash would last {without.words}. {income}, {withIncome.words}. An estimate.{' '}
                <Masked>{whatIfWords(whatIf, runway.currency, reportDay, w)}</Masked>
              </p>
            </div>
            {known && <RunwayChart projection={projection} currency={runway.currency} />}
          </>
        )}
      </section>

      {!empty && (
        <section className="report-page" aria-label="What it is worked out from">
          <h2>What it is worked out from</h2>
          <h3>Cash</h3>
          <p className="report-note">
            <Masked>
              {`${money(cash.balances)} in ${where || 'no account'}${cash.pending.count > 0 ? `, less ${money(cash.pending.amount)} still pending` : ''}: ${money(runway.start)}.`}
            </Masked>{' '}
            {asOf ? `The oldest of these balances is from ${asOf.length > 10 ? reportTime(asOf, runway.time_zone) : reportDay(asOf)}. ` : ''}
            Checking, savings and cash on hand only: never an investment account, a health savings account, a card or a loan.
          </p>

          <h3>Spending</h3>
          <p className="report-note">
            <Masked>
              {`${money(w.spending)} over ${reportDay(w.start)} to ${reportDay(w.end)} (${w.days} days), about ${money(projection.without_income.spending_per_month)} a month${changed ? ' in this what-if' : ''}.`}
            </Masked>
          </p>
          <ul className="report-list">
            {spendingParts.map((p, i) => (
              <li key={i}>
                <Masked>{p}</Masked>
              </li>
            ))}
          </ul>
          <p className="report-note">
            Moves between your checking and savings, payments to cards in Nya (their charges are counted where they are made), loan payments (added below
            when they come on a schedule) and what you excluded aren’t in it.
            {whatIf.count_moved_out && hasMovedOut(w) ? ' This what-if counts transfers out and cash taken out too.' : ''}
          </p>
          {w.card_payments.length > 0 && (
            <>
              <p className="report-note">Payments to cards Nya doesn’t see, counted as spending:</p>
              <ul className="report-list">
                {w.card_payments.map((c, i) => (
                  <li key={i}>
                    <Masked>{`${c.name}${c.account ? ` from ${c.account}` : ''}: ${money(c.amount)} over ${c.count === 1 ? 'one payment' : `${c.count} payments`}`}</Masked>
                  </li>
                ))}
              </ul>
            </>
          )}
          {w.one_offs.length > 0 && (
            <>
              <p className="report-note">
                {whatIf.leave_out_one_offs ? 'Left out as one-offs:' : 'In it, and maybe one-offs: each large, and nothing like it in those months.'}
              </p>
              <ul className="report-list">
                {w.one_offs.map((o, i) => (
                  <li key={i}>
                    <Masked>{`${o.name}, ${reportDay(o.date)}: ${money(o.amount)}`}</Masked>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>Income</h3>
          <p className="report-note">
            <Masked>{`${money(w.income)} over the same days, about ${money((w.income / w.days) * MONTH_DAYS)} a month: pay and other money in, refunds aside.`}</Masked>{' '}
            {projection.with_income.income.kind === 'until'
              ? projection.with_income.income.date < runway.today
                ? `It stopped after ${reportDay(projection.with_income.income.date)} in this what-if.`
                : `It stops after ${reportDay(projection.with_income.income.date)} in this what-if.`
              : ''}
          </p>
          {w.one_offs_in.length > 0 && (
            <>
              <p className="report-note">
                {whatIf.leave_out_one_offs ? 'Left out as one-offs:' : 'In it, and maybe one-offs: each large, and nothing like it from the same payer in those months.'}
              </p>
              <ul className="report-list">
                {w.one_offs_in.map((o, i) => (
                  <li key={i}>
                    <Masked>{`${o.name}, ${reportDay(o.date)}: ${money(o.amount)}`}</Masked>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>Bills added on their dates</h3>
          {runway.outside.length + runway.infrequent.length === 0 ? (
            <p className="report-note">None found: no loan’s payment comes from your checking or savings on a schedule, and no bill comes less often than monthly.</p>
          ) : (
            <>
              <p className="report-note">
                Loan payments from your cash, which the spending leaves out as transfers, and bills that come less often than monthly, added on the days they
                are expected:
              </p>
              <ul className="report-list">
                {[...runway.outside, ...runway.infrequent].map((o, i) => (
                  <li key={i}>
                    <Masked>{`${o.name} from ${o.account || o.institution}: ${money(o.amount)}${ownToo(o.own)}, ${cadenceLabel(o.cadence).toLowerCase()}, next around ${o.next ? reportDay(o.next) : 'not known'}`}</Masked>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>What you planned</h3>
          {runway.planned.length === 0 ? (
            <p className="report-note">Nothing planned. Add upcoming expenses and income on the Budgets tab, under the cash forecast.</p>
          ) : (
            <>
              <p className="report-note">
                {whatIf.planned
                  ? 'Added on their days, income only while income comes. One that repeats something already in your spending counts twice.'
                  : 'Left out in this what-if.'}
              </p>
              <ul className="report-list">
                {runway.planned.map((p, i) => (
                  <li key={i}>
                    <Masked>{`${p.name}: ${p.kind === 'income' ? 'income' : 'an expense'} of ${money(p.amount)}${ownToo(p.own)}, ${plannedCadenceLabel(p.cadence).toLowerCase()}, next on ${reportDay(p.next)}`}</Masked>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="report-note runway-how">
            How it is worked out: from tomorrow, each day takes a day’s spending (the spending above over its days) and, while income comes, adds a day’s
            income, with the bills and planned items on their days. The cash runs out on the first day it would be below zero, and lasts the days before
            it; a month is an average month. Bills already in your spending that come monthly or more often, rent among them, aren’t added again. Nothing
            here is saved.
          </p>
        </section>
      )}
    </article>
  );
}

/** What Save sends (app/api/runway-scenarios): the name and the what-if as
 *  worked out, its lower spending with the currency it was typed in. */
export function scenarioToSave(name: string, whatIf: RunwayWhatIf, currency: string) {
  return { name, ...whatIf, currency: whatIf.lower_by > 0 ? currency : null };
}

type ScenarioList = { scenarios: (RunwayScenario & { id: string })[]; unreadable_ids: string[]; unrecognised_ids: string[] };

/** The browser's time zone, or UTC where it doesn't say one the server takes. */
export function browserZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isTimeZone(tz) ? tz : 'UTC';
}

export default function RunwayReport() {
  const [runway, setRunway] = useState<Runway | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [whatIf, setWhatIf] = useState<RunwayWhatIf>(DEFAULT_WHAT_IF);
  const [lowerText, setLowerText] = useState('');
  const [saved, setSaved] = useState<ScenarioList | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [otherCurrency, setOtherCurrency] = useState<string | null>(null);

  const loadSaved = useCallback(async () => {
    try {
      const res = await fetch('/api/runway-scenarios');
      const body = await res.json().catch(() => null);
      if (res.ok && body && Array.isArray(body.scenarios)) {
        setSaved(body as ScenarioList);
        setSavedError(null);
      } else {
        setSaved(null);
        setSavedError(body && typeof body.error === 'string' ? body.error : 'Your saved scenarios couldn’t be loaded.');
      }
    } catch {
      setSaved(null);
      setSavedError('Your saved scenarios couldn’t be loaded. Check your connection and try again.');
    }
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/reports/runway?tz=${encodeURIComponent(browserZone())}`);
        const body = await res.json().catch(() => ({}));
        if (!live) return;
        if (res.ok && body.runway) setRunway(body.runway as Runway);
        else setError(typeof body.error === 'string' ? body.error : 'The runway couldn’t be worked out.');
      } catch {
        if (live) setError('The runway couldn’t be worked out. Check your connection and try again.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    void loadSaved();
    return () => {
      live = false;
    };
  }, [loadSaved]);

  const code = runway?.currency && isCurrencyCode(runway.currency) ? runway.currency : DEFAULT_CURRENCY;
  const change = (patch: Partial<RunwayWhatIf>) => setWhatIf((w) => ({ ...w, ...patch }));
  const typed = lowerText.trim() === '' ? 0 : parseAmountInput(lowerText, code);
  const lowerOk = typed !== null && typed <= MAX_AMOUNT;
  // The what-if as worked out and saved: the amount as typed, once it reads.
  const effective: RunwayWhatIf = { ...whatIf, lower_by: lowerOk ? typed! : 0 };

  const apply = (s: RunwayScenario) => {
    const { whatIf: next, otherCurrency: other } = scenarioWhatIf(s, runway?.currency ?? null);
    setWhatIf(next);
    setLowerText(next.lower_by > 0 ? fieldAmount(next.lower_by, minorDigits(code)) : '');
    setOtherCurrency(other);
  };

  const save = async () => {
    setBusy(true);
    setSavedError(null);
    try {
      const res = await fetch('/api/runway-scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: scenarioToSave(name, effective, code) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setSavedError(typeof body.error === 'string' ? body.error : 'The scenario couldn’t be saved.');
      else {
        setNaming(false);
        setName('');
        await loadSaved();
      }
    } catch {
      setSavedError('The scenario couldn’t be saved. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, label: string, unreadable = false) => {
    if (!window.confirm(`Delete ${label}? Only the scenario goes: your data is as it was.`)) return;
    setBusy(true);
    try {
      const res = await fetch('/api/runway-scenarios', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(unreadable ? { id, unreadable: true } : { id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setSavedError(typeof body.error === 'string' ? body.error : 'It couldn’t be deleted.');
      await loadSaved();
    } catch {
      setSavedError('It couldn’t be deleted. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="spinner no-print" role="status" aria-label="Working out the runway" />;
  if (error || !runway) {
    return (
      <div className="card no-print">
        <p className="error" role="alert">
          {error ?? 'The runway couldn’t be worked out.'}
        </p>
      </div>
    );
  }

  const projection = projectRunway(runway, effective);
  // Each box works on the window chosen: one with none to change has none.
  const shown = windowOf(runway, whatIf.months);
  const oneOffs = hasOneOffs(shown);
  const movedOut = hasMovedOut(shown);

  return (
    <>
      <div className="card no-print report-controls runway-controls">
        <Segmented label="Spending over" value={whatIf.months} onChange={(m) => change({ months: m })} options={RUNWAY_WINDOWS.map((m) => [m, `Last ${m} months`] as const)} />
        <div className="runway-fields">
          <label className="field">
            Spending lower by, a month
            <input inputMode="decimal" autoComplete="off" value={lowerText} onChange={(e) => setLowerText(e.target.value)} placeholder="0" aria-label={`Spending lower by, a month, in ${code}`} />
          </label>
          <label className="field">
            Income stops after
            <input type="date" min={runway.today} value={whatIf.income_until ?? ''} onChange={(e) => change({ income_until: e.target.value || null })} />
          </label>
        </div>
        {!lowerOk && <div className="error">Enter an amount, like 250 or 1,299.99.</div>}
        {otherCurrency && (
          <div className="stale-note">
            That scenario’s lower spending was set in {otherCurrency}, and this runway is in {code}, so it isn’t applied. Type it again in {code}.
          </div>
        )}
        <label className="report-mark">
          <input type="checkbox" checked={whatIf.planned} onChange={(e) => change({ planned: e.target.checked })} />
          <span>Count what you planned</span>
        </label>
        <label className="report-mark">
          <input type="checkbox" checked={whatIf.leave_out_one_offs && oneOffs} disabled={!oneOffs} onChange={(e) => change({ leave_out_one_offs: e.target.checked })} />
          <span>Leave out one-offs{oneOffs ? '' : ' (none in these months)'}</span>
        </label>
        <label className="report-mark">
          <input type="checkbox" checked={whatIf.count_moved_out && movedOut} disabled={!movedOut} onChange={(e) => change({ count_moved_out: e.target.checked })} />
          <span>Count transfers out and cash taken out as spending{movedOut ? '' : ' (none in these months)'}</span>
        </label>
        <p className="panel-note">Nothing you change here is saved, unless you save it as a scenario. Empty, income keeps coming.</p>
        <div className="action-row report-actions">
          <button className="secondary" onClick={() => window.print()}>
            Print or save as PDF
          </button>
          <button className="secondary" onClick={() => setNaming(true)} disabled={!lowerOk || (saved?.scenarios.length ?? 0) + (saved?.unreadable_ids.length ?? 0) + (saved?.unrecognised_ids.length ?? 0) >= MAX_SCENARIOS}>
            Save as a scenario
          </button>
          <button
            className="secondary"
            onClick={() => {
              setWhatIf(DEFAULT_WHAT_IF);
              setLowerText('');
              setOtherCurrency(null);
            }}
          >
            Start over
          </button>
        </div>
      </div>

      <RunwayView runway={runway} projection={projection} />

      <div className="card no-print">
        <div className="inst-header">
          <div className="inst-name">Saved scenarios</div>
        </div>
        <SavedScenarios list={saved} currency={runway.currency} busy={busy} onApply={apply} onDelete={(id, label, unreadable) => void remove(id, label, unreadable)} />
        {savedError && !naming && (
          <p className="error" role="alert">
            {savedError}
          </p>
        )}
      </div>

      <Sheet open={naming} title="Save as a scenario" onClose={() => setNaming(false)}>
        <div className="sheet-form">
          <p className="panel-note">
            Its settings are saved, never its figures: opened again, it is worked out from your data that day.{' '}
            <Masked>{whatIfWords(effective, runway.currency, reportDay, windowOf(runway, effective.months))}</Masked>
          </p>
          <label className="field">
            Name
            <input value={name} maxLength={SCENARIO_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="If I took a year off" />
          </label>
          {savedError && (
            <p className="error" role="alert">
              {savedError}
            </p>
          )}
          <div className="button-pair">
            <button className="secondary" onClick={() => setNaming(false)} disabled={busy}>
              Cancel
            </button>
            <button onClick={() => void save()} disabled={busy || name.trim() === ''}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

/** The saved scenarios, each with Apply and Delete; one that can't be read
 *  can be deleted, one a newer version saved is only counted. */
export function SavedScenarios({
  list,
  currency,
  busy,
  onApply,
  onDelete,
}: {
  list: ScenarioList | null;
  currency: string | null;
  busy: boolean;
  onApply: (s: RunwayScenario) => void;
  /** `unreadable`: a scenario that can't be read, which the server deletes
   *  only when told the person confirmed it. */
  onDelete: (id: string, label: string, unreadable?: boolean) => void;
}) {
  if (!list) return <p className="empty-note">Your saved scenarios aren’t loaded.</p>;
  if (list.scenarios.length + list.unreadable_ids.length + list.unrecognised_ids.length === 0)
    return <p className="empty-note">None yet. Change the what-if above, then save it to come back to it.</p>;
  return (
    <div className="sheet-form">
      {list.scenarios.map((s) => (
        <div key={s.id} className="peer-row">
          <span>
            {s.name}
            <span className="type-tag" style={{ display: 'block' }}>
              <Masked>{whatIfWords(scenarioWhatIf(s, currency).whatIf, s.currency ?? currency, reportDay)}</Masked>
            </span>
          </span>
          <span className="runway-scenario-actions">
            <button className="link-btn" disabled={busy} onClick={() => onApply(s)}>
              Apply
            </button>
            <button className="link-btn danger-link" disabled={busy} onClick={() => onDelete(s.id, `the scenario ${s.name}`)}>
              Delete
            </button>
          </span>
        </div>
      ))}
      {list.unreadable_ids.map((id) => (
        <div key={id} className="peer-row">
          <span>A saved scenario that can’t be read</span>
          <button className="link-btn danger-link" disabled={busy} onClick={() => onDelete(id, 'this saved scenario that can’t be read', true)}>
            Delete
          </button>
        </div>
      ))}
      {list.unrecognised_ids.length > 0 && (
        <p className="panel-note">
          {list.unrecognised_ids.length === 1 ? 'One more was' : `${list.unrecognised_ids.length} more were`} saved by a newer version of Nya, so{' '}
          {list.unrecognised_ids.length === 1 ? 'it' : 'they'} can’t be shown or deleted here.
        </p>
      )}
    </div>
  );
}
