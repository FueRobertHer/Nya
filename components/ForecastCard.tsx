'use client';

// The cash forecast on Budgets > Upcoming (lib/forecast.ts): today's balance
// of the cash accounts, less what is still pending on them, carried forward
// over the next 30, 60 or 90 days by the bills and income expected on them and
// the items planned, with its lowest point, a warning below zero or below the
// person's own figure, what it starts from and when that is from. "What if I
// buy…" opens a sheet with one purchase's amount and date, and shows the
// forecast with it.
//
// Worked out here, from what the dashboard already loaded, and never stored or
// sent anywhere: it is an estimate, labelled as one, and every date in it is
// an expectation ("around Oct 15"). The only thing saved is the warning's
// figure, with its currency, beside the planned items (lib/planned.ts). Its
// foot links to the runway (components/RunwayReport.tsx), which carries the
// cash forward with the everyday spending in it.
//
// IN THE SEGMENT (rollout phase 6a3, components/UpcomingPanel.tsx). The
// panel works the forecast out once (useForecast) and hands it to this card
// (ForecastView) and to the segment's one notice (components/upcoming-notes.tsx),
// which says at the top what the bills, income and planned items may be
// missing, the load states among them. The card keeps what qualifies its own
// figures: the warning it gives, the notes about where it starts (under the
// "Starts from" line), the warning set in another currency, what was
// converted, and a badge when the notice bears on it. The range is the
// panel's, as the list under it covers the same days. The default export
// draws the card on its own, without the segment's notice.
//
// THE WARNING'S SHEET. "Warns below" is a row that opens it: the figure,
// blank for below zero only, saved with the planned items. It opens afresh
// from the saved figure each time, waits for the planned items to be ready
// to save (the row and the sheet say why, in Recurring's words), closes once
// saved, and stays open on what was typed when a save is refused, saying why
// (only a refusal that arose while it was open: the store clears its refusal
// as a save starts). The row stays on the page through the store's reload
// after a refusal (components/BudgetsTab.tsx), so focus goes back to it.
// With nothing to save it with, the row is plain text, as it was.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { Sheet } from './Sheet';
import ForecastChart, { fmtDay } from './ForecastChart';
import { addDays, type RecurringSeries } from '@/lib/recurring';
import {
  buildForecast,
  cashPosition,
  forecastConvertedText,
  forecastEvents,
  withPurchase,
  FORECAST_RANGES,
  type CashPosition,
  type Forecast,
  type ForecastEvent,
  type ForecastInstitution,
  type ForecastRange,
  type PendingRow,
} from '@/lib/forecast';
import { EMPTY_PLANNED, thresholdOf, type Planned } from '@/lib/planned';
import { formatMoney } from '@/lib/format';
import { Masked } from './HideAmounts';
import TotalCaveats, { Notice, type Caveat } from './TotalCaveats';
import { Why } from './Why';
import { chevron, RIGHT, segmentKey } from './ActivityBar';
import { NoticeBadge, useUpcomingNotes, type UpcomingBadge } from './upcoming-notes';
import { isCurrencyCode, parseAmountInput, DEFAULT_CURRENCY, MAX_AMOUNT } from '@/lib/manual-txn-input';
import { NO_CONNECTIONS_WITHOUT, type NoTransactionsView } from '@/lib/no-transactions';
import { joinNames, type Incomplete, type Stopped } from '@/lib/month-coverage';
import { localDate } from '@/lib/local-date';
import type { FxTable } from '@/lib/fx/rates';

const NO_GAPS: Incomplete[] = [];
const NO_STOPPED: Stopped[] = [];
const NO_DISMISSED: ReadonlySet<string> = new Set();
const NO_ROWS: PendingRow[] = [];
const NO_CAVEATS: readonly Caveat[] = [];

/** When balances were loaded: the time today, the day and time before. */
function fmtLoaded(iso: string, today: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return localDate(d) === today ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${time}`;
}

/** What the forecast is worked out from. */
export type ForecastInput = {
  institutions: ForecastInstitution[];
  /** Detected from the loaded transactions. */
  series: RecurringSeries[];
  planned: Planned;
  /** Whether the planned items, dismissals and warning are known (loaded, or
   *  held through a refused save's reload): until then none counts, nothing
   *  is dismissed, and the warning is the default's. */
  plannedDrawn: boolean;
  /** The series the person said aren't recurring (lib/recurring.ts
   *  dismissedSeries). */
  dismissed?: ReadonlySet<string>;
  /** The viewer's day (lib/local-date.ts). */
  today: string;
  range: ForecastRange;
  /** The loaded transactions, for the charges still pending. */
  txns?: PendingRow[];
  /** With a home currency, what converts what is in another currency into
   *  the forecast's at the newest rates (/api/transactions `fx`). */
  fx?: FxTable | null;
  /** For its notes: connections whose rows aren't all in, that stopped
   *  syncing, or that bring in none (lib/month-coverage.ts,
   *  lib/no-transactions.ts). */
  incomplete?: Incomplete[];
  stopped?: Stopped[];
  withoutTransactions?: NoTransactionsView;
};

/** The forecast worked out (useForecast), for its card and the segment's
 *  notice. Its notes are written apart (components/upcoming-notes.tsx
 *  useUpcomingNotes): they name amounts, and are written again when hiding
 *  amounts is turned on or off. */
export type Forecasting = {
  /** Where it starts: the cash accounts, their currency and balance. */
  position: CashPosition;
  /** Whether there is a forecast at all: a cash account to start from. */
  has: boolean;
  /** The warning in force, and the one set in another currency. */
  warn: ReturnType<typeof thresholdOf>;
  threshold: number;
  today: string;
  range: ForecastRange;
  /** Its last day. */
  until: string;
  /** What moves it, and what was left out and is named in its notes
   *  (lib/forecast.ts forecastEvents). */
  expected: ReturnType<typeof forecastEvents>;
  events: ForecastEvent[];
  forecast: Forecast;
  /** With a home currency: what was converted into the forecast's currency. */
  converted: string | null;
};

/** The forecast over `range` days from today. */
export function useForecast({
  institutions,
  series,
  planned,
  plannedDrawn,
  dismissed = NO_DISMISSED,
  today,
  range,
  txns = NO_ROWS,
  fx = null,
}: ForecastInput): Forecasting {
  const position = useMemo(() => cashPosition(institutions, txns, { fx, today }), [institutions, txns, fx, today]);
  const warn = thresholdOf(plannedDrawn ? planned : EMPTY_PLANNED, position.currency);
  const threshold = warn.amount;
  const until = addDays(today, range);
  const expected = useMemo(
    () =>
      forecastEvents({
        series,
        planned: plannedDrawn ? planned.items : [],
        dismissed: plannedDrawn ? dismissed : NO_DISMISSED,
        currency: position.currency,
        today,
        until,
        fx,
      }),
    [series, planned, plannedDrawn, dismissed, position.currency, today, until, fx]
  );
  const { events } = expected;
  const forecast = useMemo(
    () => buildForecast(position.start, events, today, range, threshold, position.currency),
    [position.start, events, today, range, threshold, position.currency]
  );
  return {
    position,
    has: position.included.length > 0 || position.noBalance.length > 0,
    warn,
    threshold,
    today,
    range,
    until,
    expected,
    events,
    forecast,
    converted: forecastConvertedText(position.conversion, expected.conversion),
  };
}

/** The warning's sheet, kept while it slides out: what is typed, the save
 *  refusal already said when it opened (`seen`), so it says only one that
 *  arises while it is open. */
type WarnSheet = { open: boolean; draft: string; seen: string | null };

/** The card, drawn from a forecast worked out (useForecast). */
export function ForecastView({
  work,
  onRange,
  planned,
  plannedStatus = 'ready',
  onSavePlanned,
  saveError = null,
  balancesAsOf = null,
  balancesSaved = false,
  badge = null,
  start = NO_CAVEATS,
  open: openAtFirst,
}: {
  work: Forecasting;
  /** What may be off about where it starts, under its "Starts from" line
   *  (components/upcoming-notes.tsx useUpcomingNotes). */
  start?: readonly Caveat[];
  /** Chooses how far ahead it goes. */
  onRange: (range: ForecastRange) => void;
  /** The planned items as drawn, which the warning is saved with. */
  planned: Planned;
  /** Until 'ready', the warning can't be changed (its row opens nothing). */
  plannedStatus?: ListStatus;
  /** Saves the warning's figure with the planned items; absent, it can't be
   *  changed. Resolves true once saved. */
  onSavePlanned?: (next: Planned) => Promise<boolean>;
  /** Why the planned items' last save didn't go through: said in the
   *  warning's sheet when it arose while the sheet was open. */
  saveError?: string | null;
  /** When the balances were loaded, and whether they are the ones saved on
   *  this device from an earlier visit, shown until a load replaces them. */
  balancesAsOf?: string | null;
  balancesSaved?: boolean;
  /** When the segment's notice bears on it (components/upcoming-notes.tsx). */
  badge?: UpcomingBadge;
  /** A sheet open at first. */
  open?: 'warning' | 'what-if';
}) {
  const { position, forecast, threshold, warn, today, range, until, events } = work;
  const code = position.currency ?? DEFAULT_CURRENCY;
  const parse = (text: string) => parseAmountInput(text, isCurrencyCode(code) ? code : DEFAULT_CURRENCY);
  const opening = (): WarnSheet => ({ open: true, draft: threshold ? String(threshold) : '', seen: saveError });

  const [whatIfOpen, setWhatIfOpen] = useState(openAtFirst === 'what-if');
  const [buyAmount, setBuyAmount] = useState('');
  const [buyDate, setBuyDate] = useState(today);
  const [warnSheet, setWarnSheet] = useState<WarnSheet | null>(() => (openAtFirst === 'warning' ? opening() : null));
  const [savingWarn, setSavingWarn] = useState(false);
  const warnRow = useRef<HTMLButtonElement>(null);
  const rangeButtons = useRef<(HTMLButtonElement | null)[]>([]);

  // A refusal said before the sheet opened, once cleared, is forgotten: the
  // same words coming back are a new refusal, and the sheet says it.
  useEffect(() => {
    if (saveError === null) setWarnSheet((s) => (s && s.seen !== null ? { ...s, seen: null } : s));
  }, [saveError]);

  // Closed: the sheet gives focus back to the row that opened it as its own
  // effect ends, which runs before this one. When it couldn't (it opened
  // without the row focused, or focus is still in the sheet), to the row.
  const warnOpen = !!warnSheet?.open;
  const wasOpen = useRef(warnOpen);
  useEffect(() => {
    const closed = wasOpen.current && !warnOpen;
    wasOpen.current = warnOpen;
    if (!closed) return;
    let lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
    for (let n: Element | null = document.activeElement; n && !lost; n = n.parentElement) lost = n.getAttribute('role') === 'dialog';
    if (lost) warnRow.current?.focus({ preventScroll: true });
  }, [warnOpen]);

  // The what-if: one purchase, in the forecast's currency, within its range.
  const buy = parse(buyAmount);
  const buyOk = buy !== null && buy <= MAX_AMOUNT && buyDate >= today && buyDate <= until;
  const whatIf = useMemo(
    () =>
      whatIfOpen && buyOk
        ? buildForecast(position.start, withPurchase(events, { amount: buy!, date: buyDate }), today, range, threshold, position.currency)
        : null,
    [whatIfOpen, buyOk, buy, buyDate, position.start, events, today, range, threshold, position.currency]
  );

  if (!work.has) {
    return (
      <section className="card" aria-labelledby="forecast-title">
        <div className="card-header">
          <h3 id="forecast-title">Cash forecast</h3>
        </div>
        <p className="empty-note">A forecast starts from your checking and savings. Connect a bank, or add a manual account, to see one.</p>
      </section>
    );
  }

  const included = position.included;
  const byInstitution = [...new Set(included.map((a) => a.institution))].map(
    (inst) => `${joinNames(included.filter((a) => a.institution === inst).map((a) => a.name))} at ${inst}`
  );
  const where = joinNames(byInstitution) || 'no account';
  // Two accounts are named on the line; from three on it counts them, and
  // names them behind "Which accounts" (the screen review: ten accounts ran
  // to seven lines).
  const listed = included.length > 2;
  const said = listed ? `${included.length} cash accounts` : where;
  const money = (n: number) => formatMoney(n, position.currency);

  // The warning as typed: blank is none (only below zero warns).
  const draft = warnSheet?.draft ?? '';
  const warnValue = draft.trim() === '' ? 0 : parse(draft);
  const warnOk = warnValue !== null && warnValue <= MAX_AMOUNT;
  const canChange = !!onSavePlanned && plannedStatus === 'ready';
  const closeWarn = () => {
    if (!savingWarn) setWarnSheet((s) => (s ? { ...s, open: false } : s));
  };
  async function saveWarn() {
    if (!onSavePlanned || !canChange || savingWarn || warnValue === null || !warnOk) return;
    const value = warnValue;
    setSavingWarn(true);
    // The store clears its refusal as the save starts: whatever it says
    // after is this save's.
    setWarnSheet((s) => (s ? { ...s, seen: null } : s));
    try {
      if (await onSavePlanned({ ...planned, threshold: { amount: value, currency: code } })) setWarnSheet((s) => (s ? { ...s, open: false } : s));
    } finally {
      setSavingWarn(false);
    }
  }
  const refused = warnSheet && saveError && saveError !== warnSheet.seen ? saveError : null;
  const warnsBelow = <Masked>{threshold > 0 ? `Warns below ${money(threshold)}` : 'Warns below zero'}</Masked>;
  // Why the warning can't be changed now, in Recurring's words for the same.
  const whyNot =
    plannedStatus === 'error' ? "Your planned items couldn't be loaded, so this can't be saved now." : plannedStatus === 'loading' ? 'Your planned items are still loading.' : null;

  // Every date after now is an expectation.
  const around = (date: string) => (date === today ? 'today' : `around ${fmtDay(date)}`);
  const from = (date: string) => (date === today ? 'from today' : `from around ${fmtDay(date)}`);
  const low = forecast.lowest;
  const warning = forecast.belowZero
    ? { level: 'critical' as const, text: forecast.start < 0 ? 'Below zero now.' : `Expected to drop below zero ${around(forecast.belowZero)}.` }
    : forecast.belowThreshold
      ? { level: 'caution' as const, text: forecast.start < threshold ? `Below ${money(threshold)} now.` : `Expected below ${money(threshold)} ${from(forecast.belowThreshold)}.` }
      : null;
  const moved = whatIf ? whatIf.lowest.balance - low.balance : 0;
  const lowestWhen = (f: typeof forecast) => (f.lowest.date === today && f.lowest.balance === f.start ? 'now' : around(f.lowest.date));
  const buyBad = buyAmount.trim() !== '' && buy === null;
  const dateBad = !!buyDate && (buyDate < today || buyDate > until);

  // The warning set in another currency, on the card and in its sheet.
  const otherCurrency = warn.other && (
    <Notice level="caution">
      Your warning of <Masked>{formatMoney(warn.other.amount, warn.other.currency)}</Masked> was set in {warn.other.currency}, and this forecast is in {code},
      so it warns below <Masked>{money(threshold)}</Masked> until you change it.
    </Notice>
  );

  const at = FORECAST_RANGES.indexOf(range);
  const onRangeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // A radio group's arrows go either way, up and left back, down and right on.
    const to = segmentKey(e.key === 'ArrowUp' ? 'ArrowLeft' : e.key === 'ArrowDown' ? 'ArrowRight' : e.key, at, FORECAST_RANGES.length);
    if (to === null) return;
    e.preventDefault();
    onRange(FORECAST_RANGES[to]);
    rangeButtons.current[to]?.focus();
  };

  return (
    <section className="card stack" aria-labelledby="forecast-title">
      <div className="card-header">
        <h3 id="forecast-title">Cash forecast</h3>
        <span className="badge">Estimate</span>
      </div>
      {/* What the segment's notice says bears on it, said in full above it;
          or what may be off about where it starts, said below, on the card. */}
      {badge && <NoticeBadge tone={badge} />}

      <ForecastChart forecast={forecast} currency={position.currency} threshold={threshold} />

      <div className="segmented" role="radiogroup" aria-label="How far ahead" onKeyDown={onRangeKey}>
        {FORECAST_RANGES.map((r, i) => (
          <button
            key={r}
            ref={(el) => {
              rangeButtons.current[i] = el;
            }}
            type="button"
            role="radio"
            tabIndex={r === range ? 0 : -1}
            onClick={() => onRange(r)}
            aria-checked={r === range}
          >
            {r} days
          </button>
        ))}
      </div>

      {warning && (
        <Notice level={warning.level}>
          <Masked>{warning.text}</Masked>
        </Notice>
      )}

      <p className="helper">
        Starts from <Masked>{money(forecast.start)}</Masked>
        <Masked>{position.pending.count > 0 ? `: ${money(position.balances)} in ${said}, less ${money(position.pending.amount)} still pending.` : ` in ${said}.`}</Masked>
        {balancesAsOf && balancesSaved
          ? ` Those are the balances saved on ${fmtLoaded(balancesAsOf, today)}, the last time they loaded; anything since isn't in it.`
          : balancesAsOf
            ? ` Balances as of ${fmtLoaded(balancesAsOf, today)}.`
            : ''}{' '}
        Expected to end near <Masked>{money(forecast.end)}</Masked> on {fmtDay(forecast.days[forecast.days.length - 1].date)}.
      </p>
      {listed && (
        <Why label="Which accounts">
          <p>{where}.</p>
        </Why>
      )}
      {/* What may be off about where it starts, on the figure it qualifies. */}
      <TotalCaveats items={start} />

      <ul className="list-rows forecast-rows">
        <li>
          {onSavePlanned ? (
            // A button even while the planned items aren't ready, so focus
            // can come back to it; then it opens nothing and says why.
            <button
              type="button"
              ref={warnRow}
              className="list-row forecast-warn"
              aria-haspopup="dialog"
              aria-disabled={canChange ? undefined : 'true'}
              onClick={() => {
                if (canChange) setWarnSheet(opening());
              }}
            >
              <span className="list-row-text">
                <span className="list-row-title">{warnsBelow}</span>
                {whyNot && <span className="list-row-sub">{whyNot}</span>}
              </span>
              {chevron(RIGHT)}
            </button>
          ) : (
            // Nothing to save it with: it can't be changed here.
            <div className="list-row">
              <span className="list-row-text">
                <span className="list-row-title">{warnsBelow}</span>
              </span>
            </div>
          )}
        </li>
      </ul>
      {otherCurrency}

      <div className="btn-row">
        <button
          type="button"
          className="btn secondary"
          aria-haspopup="dialog"
          onClick={() => {
            setBuyDate(today);
            setWhatIfOpen(true);
          }}
        >
          What if I buy…
        </button>
      </div>

      {work.converted && <Notice level="info">{work.converted}</Notice>}
      <Why label="How this works">
        An estimate of what leaves and reaches your checking and savings: the bills and income Nya expects on them, and what you planned. A card&apos;s
        own charges aren&apos;t in it, since the card&apos;s payment is what leaves your checking, and that payment counts only when it repeats at a
        steady amount. Everyday spending and money moved to your other accounts aren&apos;t in it either. On a day with money both in and out, the
        money out is counted first.
      </Why>
      {/* The runway carries this forward with the everyday spending in it
          (lib/report/runway.ts), on the report page. */}
      <p className="helper">
        How long your cash would last at your recent spending, with your income and without it:{' '}
        <a className="forecast-runway-link" href="/reports?report=runway">
          see your runway
        </a>
        .
      </p>

      <Sheet
        open={warnOpen}
        title="Low-balance warning"
        onClose={closeWarn}
        footer={
          <div className="btn-row">
            <button type="button" className="btn secondary" onClick={closeWarn} disabled={savingWarn}>
              Cancel
            </button>
            <button type="button" className="btn" onClick={() => void saveWarn()} disabled={!canChange || savingWarn || !warnOk}>
              {savingWarn ? 'Saving…' : 'Save'}
            </button>
          </div>
        }
      >
        <div className="stack">
          {refused && <Notice level="caution">{refused}</Notice>}
          <div className="sheet-form">
            <label className="field">
              Warn below
              <input
                inputMode="decimal"
                autoComplete="off"
                value={draft}
                onChange={(e) => {
                  const value = e.target.value;
                  setWarnSheet((s) => (s ? { ...s, draft: value } : s));
                }}
                placeholder="0"
                aria-label={`Warn below, in ${code}`}
                disabled={savingWarn}
              />
            </label>
          </div>
          {draft.trim() !== '' && !warnOk && <Notice level="critical">Enter an amount, like 250 or 1,299.99.</Notice>}
          <p className="helper">Blank warns only below zero.</p>
          {otherCurrency}
          {/* Why Save is off, by the button: the planned items couldn't be
              read again (a refused save whose reload failed too), or are
              being read again (not this sheet's own save). */}
          {plannedStatus === 'error' && <Notice level="caution">{whyNot}</Notice>}
          {plannedStatus === 'loading' && !savingWarn && <p className="helper">{whyNot}</p>}
        </div>
      </Sheet>

      <Sheet
        open={whatIfOpen}
        title="What if I buy…"
        onClose={() => setWhatIfOpen(false)}
        footer={
          <button type="button" className="btn" onClick={() => setWhatIfOpen(false)}>
            Done
          </button>
        }
      >
        <div className="stack">
          <p className="helper">One purchase, on one day, added to the forecast. Nothing is saved.</p>
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
          {buyBad && <Notice level="critical">Enter an amount, like 250 or 1,299.99.</Notice>}
          {dateBad && (
            <Notice level="critical">
              Pick a day from today to {fmtDay(until)}, the end of this {range}-day forecast.
            </Notice>
          )}
          {whatIf && (
            <>
              <p className={`forecast-whatif ${whatIf.lowest.balance < 0 ? 'down' : whatIf.lowest.balance < threshold ? 'warn' : ''}`}>
                Expected lowest <Masked>{money(whatIf.lowest.balance)}</Masked> {lowestWhen(whatIf)}
                <Masked>{moved === 0 ? ', the same as without it.' : `, ${money(Math.abs(moved))} lower than ${money(low.balance)} without it.`}</Masked>
              </p>
              {whatIf.belowZero && !forecast.belowZero && <Notice level="critical">With it, the balance is expected to drop below zero {around(whatIf.belowZero)}.</Notice>}
              {!whatIf.belowZero && whatIf.belowThreshold && !forecast.belowThreshold && (
                <Notice level="caution">
                  With it, the balance is expected below <Masked>{money(threshold)}</Masked> {from(whatIf.belowThreshold)}.
                </Notice>
              )}
              <ForecastChart forecast={forecast} whatIf={whatIf} currency={position.currency} threshold={threshold} />
            </>
          )}
        </div>
      </Sheet>
    </section>
  );
}

/** The card on its own, without the segment's notice: it works its forecast
 *  out itself, its range its own. */
export default function ForecastCard({
  institutions,
  series,
  planned,
  plannedStatus = 'ready',
  dismissed = NO_DISMISSED,
  onSavePlanned,
  saveError = null,
  today,
  txns = NO_ROWS,
  balancesAsOf = null,
  balancesSaved = false,
  incomplete = NO_GAPS,
  stopped = NO_STOPPED,
  withoutTransactions = NO_CONNECTIONS_WITHOUT,
  fx = null,
  open,
}: {
  institutions: ForecastInstitution[];
  /** Detected from the loaded transactions. */
  series: RecurringSeries[];
  planned: Planned;
  /** Until 'ready', the planned items and dismissals are unknown: the forecast
   *  leaves them out. */
  plannedStatus?: ListStatus;
  /** The series the person said aren't recurring (lib/recurring.ts
   *  dismissedSeries). */
  dismissed?: ReadonlySet<string>;
  /** Saves the warning's figure with the planned items; absent, it can't be
   *  changed. */
  onSavePlanned?: (next: Planned) => Promise<boolean>;
  saveError?: string | null;
  /** The viewer's day (lib/local-date.ts). */
  today: string;
  /** The loaded transactions, for the charges still pending. */
  txns?: PendingRow[];
  /** With a home currency, what converts what is in another currency into
   *  the forecast's at the newest rates (/api/transactions `fx`). */
  fx?: FxTable | null;
  /** When the balances were loaded, and whether they are the ones saved on
   *  this device from an earlier visit, shown until a load replaces them. */
  balancesAsOf?: string | null;
  balancesSaved?: boolean;
  incomplete?: Incomplete[];
  stopped?: Stopped[];
  withoutTransactions?: NoTransactionsView;
  /** A sheet open at first. */
  open?: 'warning' | 'what-if';
}) {
  // The card without the segment's notice: its load states are the panel's to say.
  const [range, setRange] = useState<ForecastRange>(30);
  const input: ForecastInput = {
    institutions,
    series,
    planned,
    plannedDrawn: plannedStatus === 'ready',
    dismissed,
    today,
    range,
    txns,
    fx,
    incomplete,
    stopped,
    withoutTransactions,
  };
  const work = useForecast(input);
  const { start } = useUpcomingNotes(input, work, { failed: false, loading: false });
  return (
    <ForecastView
      work={work}
      start={start}
      onRange={setRange}
      planned={planned}
      plannedStatus={plannedStatus}
      onSavePlanned={onSavePlanned}
      saveError={saveError}
      balancesAsOf={balancesAsOf}
      balancesSaved={balancesSaved}
      open={open}
    />
  );
}
