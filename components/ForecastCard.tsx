'use client';

// The cash forecast on the Budgets tab (lib/forecast.ts): today's balance of
// the cash accounts, less what is still pending on them, carried forward over
// the next 30, 60 or 90 days by the bills and income expected on them and the
// items planned, with its lowest point, a warning below zero or below the
// person's own figure, what it starts from and when that is from, and what it
// may be missing. "What if I buy…" opens the drawer with one purchase's amount
// and date, and shows the forecast with it.
//
// Worked out here, from what the dashboard already loaded, and never stored or
// sent anywhere: it is an estimate, labelled as one, and every date in it is
// an expectation ("around Oct 15"). The only thing saved is the warning's
// figure, with its currency, beside the planned items (lib/planned.ts).

import { useMemo, useState } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { Sheet } from './Sheet';
import ForecastChart, { fmtDay } from './ForecastChart';
import { addDays, type RecurringSeries } from '@/lib/recurring';
import {
  buildForecast,
  cashPosition,
  forecastEvents,
  forecastNotes,
  withPurchase,
  FORECAST_RANGES,
  type ForecastInstitution,
  type ForecastRange,
  type NoteDays,
  type PendingRow,
} from '@/lib/forecast';
import { EMPTY_PLANNED, thresholdOf, type Planned } from '@/lib/planned';
import { formatMoney } from '@/lib/format';
import { isCurrencyCode, parseAmountInput, DEFAULT_CURRENCY, MAX_AMOUNT } from '@/lib/manual-txn-input';
import { refusedNames, unallowedNames, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import { joinNames, type Incomplete, type Stopped } from '@/lib/month-coverage';
import { instantDay, localDate } from '@/lib/local-date';

const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];
const NO_DISMISSED: ReadonlySet<string> = new Set();
const NO_ROWS: PendingRow[] = [];

/** How the notes name a day, on the viewer's calendar. */
const DAYS: NoteDays = {
  snapshot: (date, at) => (at ? (instantDay(at) ?? fmtDay(date)) : fmtDay(date)),
  instant: (iso) => instantDay(iso) ?? iso.slice(0, 10),
  day: (date) => fmtDay(date),
};

/** When balances were loaded: the time today, the day and time before. */
function fmtLoaded(iso: string, today: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return localDate(d) === today ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

export default function ForecastCard({
  institutions,
  series,
  planned,
  plannedStatus = 'ready',
  dismissed = NO_DISMISSED,
  onSavePlanned,
  today,
  txns = NO_ROWS,
  loading = false,
  failed = false,
  balancesAsOf = null,
  balancesSaved = false,
  incomplete = NO_GAPS,
  stopped = NO_STOPPED,
  withoutTransactions = NO_CONNECTIONS_WITHOUT,
}: {
  institutions: ForecastInstitution[];
  /** Detected from the loaded transactions. */
  series: RecurringSeries[];
  planned: Planned;
  /** Until 'ready', the planned items and dismissals are unknown: the forecast
   *  says it leaves them out. */
  plannedStatus?: ListStatus;
  /** The series the person said aren't recurring (lib/recurring.ts
   *  dismissedSeries). */
  dismissed?: ReadonlySet<string>;
  /** Saves the warning's figure with the planned items; absent, it can't be
   *  changed. */
  onSavePlanned?: (next: Planned) => Promise<boolean>;
  /** The viewer's day (lib/local-date.ts). */
  today: string;
  /** The loaded transactions, for the charges still pending. */
  txns?: PendingRow[];
  /** Transactions are still loading: no bills or income are known yet. */
  loading?: boolean;
  /** Transactions couldn't be loaded: no bills or income are known. */
  failed?: boolean;
  /** When the balances were loaded, and whether they are the ones saved on
   *  this device from an earlier visit, shown until a load replaces them. */
  balancesAsOf?: string | null;
  balancesSaved?: boolean;
  incomplete?: Incomplete[];
  stopped?: Stopped[];
  withoutTransactions?: NoTransactionsView;
}) {
  const [range, setRange] = useState<ForecastRange>(30);
  const [whatIfOpen, setWhatIfOpen] = useState(false);
  const [buyAmount, setBuyAmount] = useState('');
  const [buyDate, setBuyDate] = useState(today);
  const [warnDraft, setWarnDraft] = useState<string | null>(null);
  const [savingWarn, setSavingWarn] = useState(false);

  const ready = plannedStatus === 'ready';
  const position = useMemo(() => cashPosition(institutions, txns), [institutions, txns]);
  const warn = thresholdOf(ready ? planned : EMPTY_PLANNED, position.currency);
  const threshold = warn.amount;
  const until = addDays(today, range);
  const { events, leftOut, varied, lapsed, unplaced, cardsPaid } = useMemo(
    () =>
      forecastEvents({
        series,
        planned: ready ? planned.items : [],
        dismissed: ready ? dismissed : NO_DISMISSED,
        currency: position.currency,
        today,
        until,
      }),
    [series, planned, ready, dismissed, position.currency, today, until]
  );
  const forecast = useMemo(
    () => buildForecast(position.start, events, today, range, threshold, position.currency),
    [position.start, events, today, range, threshold, position.currency]
  );

  const notes = useMemo(
    () =>
      forecastNotes({
        institutions,
        position,
        eventsLeftOut: leftOut,
        series: { varied, lapsed, unplaced, cardsPaid },
        until,
        stopped,
        incomplete,
        refused: refusedNames(withoutTransactions),
        unallowed: unallowedNames(withoutTransactions),
        today,
        days: DAYS,
      }),
    [institutions, position, leftOut, varied, lapsed, unplaced, cardsPaid, until, stopped, incomplete, withoutTransactions, today]
  );

  // The what-if: one purchase, in the forecast's currency, within its range.
  const code = position.currency ?? DEFAULT_CURRENCY;
  const buy = parseAmountInput(buyAmount, isCurrencyCode(code) ? code : DEFAULT_CURRENCY);
  const buyOk = buy !== null && buy <= MAX_AMOUNT && buyDate >= today && buyDate <= until;
  const whatIf = useMemo(
    () =>
      whatIfOpen && buyOk
        ? buildForecast(position.start, withPurchase(events, { amount: buy!, date: buyDate }), today, range, threshold, position.currency)
        : null,
    [whatIfOpen, buyOk, buy, buyDate, position.start, events, today, range, threshold, position.currency]
  );

  if (position.included.length === 0 && position.noBalance.length === 0) {
    return (
      <div className="card">
        <div className="inst-header">
          <div className="inst-name">Cash forecast</div>
        </div>
        <p className="empty-note">
          A forecast starts from your checking and savings. Connect a bank, or add a manual account, to see one.
        </p>
      </div>
    );
  }

  const included = position.included;
  const byInstitution = [...new Set(included.map((a) => a.institution))].map(
    (inst) => `${joinNames(included.filter((a) => a.institution === inst).map((a) => a.name))} at ${inst}`
  );
  const where = joinNames(byInstitution) || 'no account';
  const money = (n: number) => formatMoney(n, position.currency);

  // The warning as typed: blank is none (only below zero warns).
  const warnValue = warnDraft === null ? null : warnDraft.trim() === '' ? 0 : parseAmountInput(warnDraft, isCurrencyCode(code) ? code : DEFAULT_CURRENCY);
  const warnOk = warnValue !== null && warnValue <= MAX_AMOUNT;

  async function saveWarn() {
    if (!onSavePlanned || warnValue === null || !warnOk) return;
    const value = warnValue;
    setSavingWarn(true);
    try {
      if (await onSavePlanned({ ...planned, threshold: { amount: value, currency: code } })) setWarnDraft(null);
    } finally {
      setSavingWarn(false);
    }
  }

  // Every date after now is an expectation.
  const around = (date: string) => (date === today ? 'today' : `around ${fmtDay(date)}`);
  const from = (date: string) => (date === today ? 'from today' : `from around ${fmtDay(date)}`);
  const low = forecast.lowest;
  const warning = forecast.belowZero
    ? { tone: 'down', text: forecast.start < 0 ? 'Below zero now.' : `Expected to drop below zero ${around(forecast.belowZero)}.` }
    : forecast.belowThreshold
      ? { tone: 'warn', text: forecast.start < threshold ? `Below ${money(threshold)} now.` : `Expected below ${money(threshold)} ${from(forecast.belowThreshold)}.` }
      : null;
  const moved = whatIf ? whatIf.lowest.balance - low.balance : 0;
  const lowestWhen = (f: typeof forecast) => (f.lowest.date === today && f.lowest.balance === f.start ? 'now' : around(f.lowest.date));

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Cash forecast</div>
        <div className="inst-total">estimate</div>
      </div>

      <ForecastChart forecast={forecast} currency={position.currency} threshold={threshold} />

      <div className="chart-ranges" role="group" aria-label="How far ahead">
        {FORECAST_RANGES.map((r) => (
          <button key={r} className="chart-range" aria-pressed={range === r} onClick={() => setRange(r)}>
            {r} days
          </button>
        ))}
      </div>

      {warning && <p className={warning.tone === 'down' ? 'error forecast-warning' : 'stale-note forecast-warning'}>{warning.text}</p>}
      {failed && <p className="error">Transactions couldn&apos;t be loaded, so no bills or income are in this: it is your balance and what you planned.</p>}
      {loading && !failed && <p className="stale-note">Transactions are still loading, so no bills or income are in this yet.</p>}
      {!ready && <p className="stale-note">Your planned items aren&apos;t loaded, so they aren&apos;t in this, and bills you marked not recurring may be.</p>}

      <p className="panel-note">
        Starts from {money(forecast.start)}
        {position.pending.count > 0
          ? `: ${money(position.balances)} in ${where}, less ${money(position.pending.amount)} still pending.`
          : ` in ${where}.`}
        {balancesAsOf && balancesSaved
          ? ` Those are the balances saved on ${fmtLoaded(balancesAsOf, today)}, the last time they loaded; anything since isn't in it.`
          : balancesAsOf
            ? ` Balances as of ${fmtLoaded(balancesAsOf, today)}.`
            : ''}{' '}
        Expected to end near {money(forecast.end)} on {fmtDay(forecast.days[forecast.days.length - 1].date)}.
      </p>

      <div className="card-actions">
        <button
          className="secondary"
          onClick={() => {
            setBuyDate(today);
            setWhatIfOpen(true);
          }}
        >
          What if I buy…
        </button>
      </div>

      <div className="forecast-warn-row">
        {warnDraft === null ? (
          <>
            <span>{threshold > 0 ? `Warns below ${money(threshold)}` : 'Warns below zero'}</span>
            {onSavePlanned && ready && (
              <button className="link-btn" onClick={() => setWarnDraft(threshold ? String(threshold) : '')}>
                Change
              </button>
            )}
          </>
        ) : (
          <>
            <label className="forecast-warn-field">
              Warn below
              <input
                inputMode="decimal"
                value={warnDraft}
                onChange={(e) => setWarnDraft(e.target.value)}
                placeholder="0"
                aria-label={`Warn when the forecast drops below, in ${code}`}
                disabled={savingWarn}
              />
            </label>
            <button className="link-btn" onClick={saveWarn} disabled={savingWarn || !warnOk}>
              {savingWarn ? 'Saving…' : 'Save'}
            </button>
            <button className="link-btn" onClick={() => setWarnDraft(null)} disabled={savingWarn}>
              Cancel
            </button>
          </>
        )}
      </div>
      {warn.other && (
        <div className="stale-note">
          Your warning of {formatMoney(warn.other.amount, warn.other.currency)} was set in {warn.other.currency}, and this forecast is in{' '}
          {code}, so it warns below {money(threshold)} until you change it.
        </div>
      )}

      {notes.map((n) => (
        <div className="stale-note" key={n}>
          {n}
        </div>
      ))}
      <div className="chart-note">
        An estimate of what leaves and reaches your checking and savings: the bills and income Nya expects on them, and what you
        planned. A card&apos;s own charges aren&apos;t in it, since the card&apos;s payment is what leaves your checking, and that
        payment counts only when it repeats at a steady amount. Everyday spending and money moved to your other accounts aren&apos;t in
        it either. On a day with money both in and out, the money out is counted first.
      </div>

      <Sheet open={whatIfOpen} title="What if I buy…" onClose={() => setWhatIfOpen(false)}>
        <p className="panel-note" style={{ marginTop: 0 }}>
          One purchase, on one day, added to the forecast. Nothing is saved.
        </p>
        <div className="sheet-form">
          <div className="quick-add-pair">
            <label className="field quick-add-amount">
              Amount
              <input inputMode="decimal" autoComplete="off" value={buyAmount} onChange={(e) => setBuyAmount(e.target.value)} placeholder="0.00" />
            </label>
            <label className="field quick-add-currency">
              Currency
              <input value={position.currency ?? ''} readOnly aria-readonly="true" />
            </label>
          </div>
          <label className="field">
            On
            <input type="date" value={buyDate} min={today} max={until} onChange={(e) => setBuyDate(e.target.value)} />
          </label>
        </div>
        {buyAmount.trim() !== '' && buy === null && <div className="error">Enter an amount, like 250 or 1,299.99.</div>}
        {buyDate && (buyDate < today || buyDate > until) && (
          <div className="error">
            Pick a day from today to {fmtDay(until)}, the end of this {range}-day forecast.
          </div>
        )}
        {whatIf && (
          <>
            <p className={`forecast-whatif ${whatIf.lowest.balance < 0 ? 'down' : whatIf.lowest.balance < threshold ? 'warn' : ''}`}>
              Expected lowest {money(whatIf.lowest.balance)} {lowestWhen(whatIf)}
              {moved === 0 ? ', the same as without it.' : `, ${money(Math.abs(moved))} lower than ${money(low.balance)} without it.`}
            </p>
            {whatIf.belowZero && !forecast.belowZero && <p className="error">With it, the balance is expected to drop below zero {around(whatIf.belowZero)}.</p>}
            {!whatIf.belowZero && whatIf.belowThreshold && !forecast.belowThreshold && (
              <p className="stale-note">
                With it, the balance is expected below {money(threshold)} {from(whatIf.belowThreshold)}.
              </p>
            )}
            <ForecastChart forecast={forecast} whatIf={whatIf} currency={position.currency} threshold={threshold} />
          </>
        )}
        <div className="button-pair" style={{ marginTop: 16 }}>
          <button onClick={() => setWhatIfOpen(false)}>Done</button>
        </div>
      </Sheet>
    </div>
  );
}
