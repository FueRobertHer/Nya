'use client';

// The cash forecast on the Budgets tab (lib/forecast.ts): today's balance of
// the cash accounts carried forward over the next 30, 60 or 90 days by the
// bills and income detected and the items planned, with its lowest point, a
// warning below zero or below the person's own figure, what it starts from,
// and what it may be missing. "What if I buy…" opens the drawer with one
// purchase's amount and date, and shows the forecast with it.
//
// Worked out here, from what the dashboard already loaded, and never stored or
// sent anywhere: it is an estimate, labelled as one. The only thing saved is
// the warning's figure, with the planned items (lib/planned.ts).

import { useMemo, useState } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { Sheet } from './Sheet';
import ForecastChart, { fmtDay } from './ForecastChart';
import { addDays, type RecurringSeries } from '@/lib/recurring';
import { buildForecast, cashPosition, forecastEvents, forecastNotes, withPurchase, FORECAST_RANGES, type ForecastInstitution, type ForecastRange, type NoteDays } from '@/lib/forecast';
import { thresholdOf, type Planned } from '@/lib/planned';
import { formatMoney } from '@/lib/format';
import { isCurrencyCode, parseAmountInput, DEFAULT_CURRENCY, MAX_AMOUNT } from '@/lib/manual-txn-input';
import { refusedNames, unallowedNames, NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import { joinNames, type Incomplete, type Stopped } from '@/lib/month-coverage';
import { instantDay } from '@/lib/local-date';

const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];

/** How the notes name a day, on the viewer's calendar. */
const DAYS: NoteDays = {
  snapshot: (date, at) => (at ? (instantDay(at) ?? fmtDay(date)) : fmtDay(date)),
  instant: (iso) => instantDay(iso) ?? iso.slice(0, 10),
};

export default function ForecastCard({
  institutions,
  series,
  planned,
  plannedStatus = 'ready',
  onSavePlanned,
  today,
  loading = false,
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
  /** Saves the warning's figure with the planned items; absent, it can't be
   *  changed. */
  onSavePlanned?: (next: Planned) => Promise<boolean>;
  /** The viewer's day (lib/local-date.ts). */
  today: string;
  /** Transactions are still loading: no bills or income are known yet. */
  loading?: boolean;
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
  const position = useMemo(() => cashPosition(institutions), [institutions]);
  const threshold = ready ? thresholdOf(planned) : thresholdOf({ threshold: null });
  const until = addDays(today, range);
  const { events, leftOut } = useMemo(
    () =>
      forecastEvents({
        series,
        planned: ready ? planned.items : [],
        dismissed: new Set(ready ? planned.dismissed : []),
        currency: position.currency,
        today,
        until,
      }),
    [series, planned, ready, position.currency, today, until]
  );
  const forecast = useMemo(() => buildForecast(position.start, events, today, range, threshold), [position.start, events, today, range, threshold]);

  const notes = useMemo(
    () =>
      forecastNotes({
        institutions,
        position,
        eventsLeftOut: leftOut,
        stopped,
        incomplete,
        refused: refusedNames(withoutTransactions),
        unallowed: unallowedNames(withoutTransactions),
        today,
        days: DAYS,
      }),
    [institutions, position, leftOut, stopped, incomplete, withoutTransactions, today]
  );

  // The what-if: one purchase, in the forecast's currency, within its range.
  const code = position.currency ?? DEFAULT_CURRENCY;
  const buy = parseAmountInput(buyAmount, isCurrencyCode(code) ? code : DEFAULT_CURRENCY);
  const buyOk = buy !== null && buy <= MAX_AMOUNT && buyDate >= today && buyDate <= until;
  const whatIf = useMemo(
    () => (whatIfOpen && buyOk ? buildForecast(position.start, withPurchase(events, { amount: buy!, date: buyDate }), today, range, threshold) : null),
    [whatIfOpen, buyOk, buy, buyDate, position.start, events, today, range, threshold]
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

  async function saveWarn() {
    if (!onSavePlanned || warnDraft === null) return;
    const value = warnDraft.trim() === '' ? 0 : parseAmountInput(warnDraft, isCurrencyCode(code) ? code : DEFAULT_CURRENCY);
    if (value === null || value > MAX_AMOUNT) return;
    setSavingWarn(true);
    try {
      if (await onSavePlanned({ ...planned, threshold: value })) setWarnDraft(null);
    } finally {
      setSavingWarn(false);
    }
  }

  const low = forecast.lowest;
  const when = (date: string) => (date === today ? 'today' : `on ${fmtDay(date)}`);
  const warning = forecast.belowZero
    ? { tone: 'down', text: forecast.belowZero === today && forecast.start < 0 ? 'Below zero now.' : `Drops below zero ${when(forecast.belowZero)}.` }
    : forecast.belowThreshold
      ? { tone: 'warn', text: `Below ${formatMoney(threshold, position.currency)} ${forecast.belowThreshold === today ? 'today' : `from ${fmtDay(forecast.belowThreshold)}`}.` }
      : null;
  const moved = whatIf ? whatIf.lowest.balance - low.balance : 0;

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
      {loading && <p className="stale-note">Transactions are still loading, so no bills or income are in this yet.</p>}
      {!ready && <p className="stale-note">Your planned items aren&apos;t loaded, so they aren&apos;t in this, and bills you marked not recurring may be.</p>}

      <p className="panel-note">
        Starts from {formatMoney(position.start, position.currency)} today in {joinNames(byInstitution) || 'no account'}. Ends{' '}
        {formatMoney(forecast.end, position.currency)} on {fmtDay(forecast.days[forecast.days.length - 1].date)}.
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
            <span>Warns below {formatMoney(threshold, position.currency)}</span>
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
                aria-label="Warn when the forecast drops below"
                disabled={savingWarn}
              />
            </label>
            <button className="link-btn" onClick={saveWarn} disabled={savingWarn}>
              {savingWarn ? 'Saving…' : 'Save'}
            </button>
            <button className="link-btn" onClick={() => setWarnDraft(null)} disabled={savingWarn}>
              Cancel
            </button>
          </>
        )}
      </div>

      {notes.map((n) => (
        <div className="stale-note" key={n}>
          {n}
        </div>
      ))}
      <div className="chart-note">
        An estimate from the bills and income Nya expects and what you planned. Everyday spending isn&apos;t in it, and a card&apos;s
        payment only when it repeats at a steady amount.
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
              Lowest {formatMoney(whatIf.lowest.balance, position.currency)}{' '}
              {whatIf.lowest.date === today ? 'today' : `on ${fmtDay(whatIf.lowest.date)}`}
              {moved === 0
                ? ', the same as without it.'
                : `, ${formatMoney(Math.abs(moved), position.currency)} lower than ${formatMoney(low.balance, position.currency)} without it.`}
            </p>
            {whatIf.belowZero && !forecast.belowZero && <p className="error">With it, the balance drops below zero {when(whatIf.belowZero)}.</p>}
            {!whatIf.belowZero && whatIf.belowThreshold && !forecast.belowThreshold && (
              <p className="stale-note">
                With it, the balance is below {formatMoney(threshold, position.currency)} {whatIf.belowThreshold === today ? 'today' : `from ${fmtDay(whatIf.belowThreshold)}`}.
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
