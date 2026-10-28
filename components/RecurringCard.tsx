'use client';

// Recurring bills and income on Budgets > Upcoming (lib/recurring.ts): each
// with its account, cadence, how many times it was seen, its typical amount
// and when it is next expected, bills and income apart. One whose scheduled
// dates went by with nothing arriving is listed last as possibly ended, and
// is left out of the monthly figures, as is pay whose amount varies too much
// to forecast. The monthly figures add up what is in the totals' currency,
// as the read-only API does (lib/totals.ts recurringMonthly), and with a home
// currency what is in another converted into it at today's rates; each
// series is listed in its own currency. When the segment's notice says what
// the series may be missing, a badge at the card's top says so, as the
// list's does (components/upcoming-notes.tsx).
//
// SHEETS (rollout phase 6a3). A series' row opens its sheet: what was seen
// of it, what the forecast makes of it, and Not recurring, which dismisses
// it from here, the forecast, the calendar and Home's upcoming bills. It is
// saved with the planned items (lib/planned.ts), so nothing saves until they
// have loaded, and the sheet says why where its button is. The sheet closes
// once saved, and stays open saying why when the save is refused; it says
// only a refusal that arose while it was open (the store clears its error
// when a save starts, so the same words again are new), and the card says
// the rest. Focus goes back to the series' row as it is drawn then (a refused
// dismissal takes the row out and draws it again), or, once it is dismissed,
// to the row of those marked not recurring, which opens in place to each
// with Restore.

import { useEffect, useId, useRef, useState } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { addDays, cadenceLabel, expectedDates, type RecurringSeries } from '@/lib/recurring';
import { formatMoney } from '@/lib/format';
import { shownName } from '@/lib/merchant-name';
import { leftOutText } from '@/lib/spending';
import { countsInMonthly, recurringMonthly, type MonthlyConverted } from '@/lib/totals';
import { leftOutWhy } from '@/lib/fx/totals';
import type { FxTable } from '@/lib/fx/rates';
import type { NoSpending } from '@/lib/no-transactions';
import { Masked } from './HideAmounts';
import { Sheet } from './Sheet';
import { Notice } from './TotalCaveats';
import { NoticeBadge, type UpcomingBadge } from './upcoming-notes';

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** How far ahead "next" looks: past a yearly series' next date. */
const NEXT_WITHIN_DAYS = 400;

const DOWN = 'm6 9 6 6 6-6';

type Row = { series: RecurringSeries; status: 'due' | 'late' | 'ended'; next: string | null; due: string | null };

/** The series whose sheet is open, as it was when it opened, kept while it
 *  slides out: the save refusal already said then (`seen`), so it says only
 *  one that arises while it is open; and which opening it is (`n`). */
type SheetState = { series: RecurringSeries; open: boolean; seen: string | null; n: number };

export default function RecurringCard({
  series,
  today,
  currency,
  dismissed,
  status = 'ready',
  saveError = null,
  onDismiss,
  noSpending = null,
  loading = false,
  failed = false,
  fx = null,
  edit,
  badge = null,
}: {
  series: RecurringSeries[];
  /** The viewer's day (lib/local-date.ts). */
  today: string;
  /** The totals' currency, for the monthly figures and amounts without one. */
  currency: string | null;
  /** The series dismissed as not recurring (lib/recurring.ts
   *  dismissedSeries). */
  dismissed: ReadonlySet<string>;
  /** The planned items' state: dismissing waits until they have loaded. */
  status?: ListStatus;
  /** Why the last save of the planned items didn't go through: said on the
   *  card, or in the sheet open when it arose. */
  saveError?: string | null;
  /** Saves a dismissal (true) or a restore (false); resolves true once saved. */
  onDismiss?: (series: RecurringSeries, dismiss: boolean) => Promise<boolean>;
  /** No connection brings in transactions: what to say instead. */
  noSpending?: NoSpending | null;
  /** Transactions are still loading, or couldn't be loaded. */
  loading?: boolean;
  failed?: boolean;
  /** With a home currency, what the monthly figures convert with
   *  (/api/transactions `fx`). */
  fx?: FxTable | null;
  /** A series whose sheet is open at first, by id. */
  edit?: string;
  /** What the segment's notice says the series may be missing, as the
   *  list's badge (components/upcoming-notes.tsx), given by the panel. */
  badge?: UpcomingBadge;
}) {
  const [sheet, setSheet] = useState<SheetState | null>(() => {
    const s = edit ? series.find((x) => x.id === edit) : undefined;
    return s ? { series: s, open: true, seen: saveError, n: 1 } : null;
  });
  const [showDismissed, setShowDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  // A series restored (or refused), for focus once it is drawn where it now is.
  const [restored, setRestored] = useState<string | null>(null);
  const markedId = useId();
  const markedRef = useRef<HTMLButtonElement>(null);
  /** Each series' row and each Restore as drawn now, by the series' id: one
   *  taken out and drawn again (a refused save puts back what the optimistic
   *  list took out) is a new element. */
  const rowEls = useRef(new Map<string, HTMLElement>());
  const restoreEls = useRef(new Map<string, HTMLElement>());
  const refIn = (map: Map<string, HTMLElement>, id: string) => (el: HTMLElement | null) => {
    if (el) map.set(id, el);
    else map.delete(id);
  };

  const gone = dismissed;
  const until = addDays(today, NEXT_WITHIN_DAYS);
  const rows: Row[] = series
    .filter((s) => !gone.has(s.id))
    .map((s) => {
      const e = expectedDates(s, today, until);
      const first = e.dates[0];
      return { series: s, status: e.status, next: first?.date ?? null, due: first?.late ? first.due : null };
    });
  // Ended ones last, each kind largest first as detected.
  const ordered = (kind: 'bill' | 'income') => rows.filter((r) => r.series.kind === kind).sort((a, b) => Number(a.status === 'ended') - Number(b.status === 'ended'));
  const bills = ordered('bill');
  const income = ordered('income');
  const dismissedRows = series.filter((s) => gone.has(s.id));

  // In a monthly figure: still coming, its amount known, and not a card's
  // payment (its card's bills are counted where they are charged). A month's
  // worth of what is still coming, in one currency; the rest named.
  const inTotal = (r: Row) => countsInMonthly(r.series, today);
  const billsMonthly = recurringMonthly(
    bills.map((r) => r.series),
    today,
    currency,
    fx
  );
  const incomeMonthly = recurringMonthly(
    income.map((r) => r.series),
    today,
    currency,
    fx
  );
  const leftOut = [
    leftOutWhy(leftOutText(billsMonthly.leftOut, currency, { noun: 'bill', where: 'this total', plural: false }), billsMonthly.converted),
    leftOutWhy(leftOutText(incomeMonthly.leftOut, currency, { noun: 'deposit', where: 'the income total', plural: false }), incomeMonthly.converted),
  ]
    .filter(Boolean)
    .join(' ');
  const converted = monthlyConvertedText(billsMonthly.converted, incomeMonthly.converted);

  const canEdit = status === 'ready' && !!onDismiss && !busy;
  // Why the buttons are off, said where they are.
  const why =
    status === 'error'
      ? "Your planned items couldn't be loaded, so this can't be saved now."
      : status === 'loading'
        ? 'Your planned items are still loading.'
        : !onDismiss
          ? "This can't be changed here."
          : null;

  // A refusal said before the sheet opened, once cleared, is forgotten: the
  // same words coming back are a new refusal, and the sheet says it.
  useEffect(() => {
    if (saveError === null) setSheet((s) => (s && s.seen !== null ? { ...s, seen: null } : s));
  }, [saveError]);

  const show = (s: RecurringSeries) => setSheet((x) => ({ series: s, open: true, seen: saveError, n: (x?.n ?? 0) + 1 }));
  const close = () => !busy && setSheet((s) => (s ? { ...s, open: false } : s));
  // What the open sheet says of the store's refusal; the card says it otherwise.
  const sheetError = sheet?.open && saveError && saveError !== sheet.seen ? saveError : null;

  async function dismiss(s: RecurringSeries) {
    if (!onDismiss || busy) return;
    setBusy(true);
    // The store clears its refusal as the save starts: whatever it says
    // after is this save's.
    setSheet((x) => (x ? { ...x, seen: null } : x));
    try {
      if (await onDismiss(s, true)) setSheet((x) => (x ? { ...x, open: false } : x));
    } finally {
      setBusy(false);
    }
  }

  async function restore(s: RecurringSeries) {
    if (!onDismiss || busy) return;
    setBusy(true);
    try {
      await onDismiss(s, false);
    } finally {
      setBusy(false);
      setRestored(s.id);
    }
  }

  // Restored, its button is gone: focus goes to the series' row, back in the
  // list; refused, to its Restore as drawn again; else to the marked row.
  useEffect(() => {
    if (restored === null) return;
    const to = [rowEls.current.get(restored), restoreEls.current.get(restored), markedRef.current].find((el) => el?.isConnected);
    to?.focus({ preventScroll: true });
    setRestored(null);
  }, [restored]);

  const sheetOpen = !!sheet?.open;
  // Closed: the sheet gives focus back to the row that opened it as its own
  // effect ends, which runs before this one. When it couldn't (that row was
  // taken out meanwhile), focus goes to the series' row as it is drawn now,
  // or, once it is dismissed, to the row of those marked not recurring.
  const wasOpen = useRef(sheetOpen);
  useEffect(() => {
    const closed = wasOpen.current && !sheetOpen;
    wasOpen.current = sheetOpen;
    if (!closed) return;
    let lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
    for (let n: Element | null = document.activeElement; n && !lost; n = n.parentElement) lost = n.getAttribute('role') === 'dialog';
    if (!lost) return;
    const row = sheet ? rowEls.current.get(sheet.series.id) : undefined;
    (row?.isConnected ? row : markedRef.current)?.focus({ preventScroll: true });
    // Only the sheet's closing moves focus; what it was open on is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen]);

  const where = (s: RecurringSeries) => (s.account ? `${s.institution} · ${s.account}` : s.institution);
  const line = (r: Row) => {
    const s = r.series;
    const when =
      r.status === 'ended'
        ? `last ${fmtDay(s.lastDate)}, may have ended`
        : r.status === 'late' && r.due
          ? `due ${fmtDay(r.due)}, not in yet`
          : r.next
            ? `next ~${fmtDay(r.next)}`
            : '';
    return [
      where(s),
      cadenceLabel(s.cadence),
      `seen ${s.seen} times`,
      s.pending ? `latest ${fmtDay(s.lastDate)}, pending` : null,
      s.agreement === 'varies' ? 'amount varies' : null,
      s.paysCard ? (s.paysCardOf ? `pays ${s.paysCardOf.account || 'a card'}` : 'pays a card') : null,
      when || null,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  // What the forecast makes of it, for its sheet.
  const counted = (s: RecurringSeries) =>
    s.paysCard
      ? "It pays a card off, so it isn't in the monthly total here, where the card's own bills are; the forecast counts it, as the money leaving your checking."
      : s.agreement === 'varies'
      ? 'Its amount varies too much to forecast, so the forecast leaves it out and says so.'
      : s.accountType === 'credit'
        ? `Charged to ${s.account || 'a card'}: the forecast counts the card's payment from your checking instead, when that repeats at a steady amount.`
        : s.accountType && s.accountType !== 'depository'
          ? `On ${s.account || 'an account'}, which isn't checking or savings, so the forecast doesn't count it.`
          : s.accountType === null
            ? "The account it's on isn't known, so the forecast doesn't count it."
            : null;

  const list = (of: Row[]) => (
    <ul className="list-rows">
      {of.map((r) => {
        const s = r.series;
        return (
          <li key={s.id}>
            <button
              type="button"
              ref={refIn(rowEls.current, s.id)}
              className={`list-row${r.status === 'ended' ? ' recurring-ended' : ''}`}
              aria-haspopup="dialog"
              onClick={() => show(s)}
            >
              {s.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="txn-logo" src={s.logo_url} alt="" loading="lazy" />
              ) : (
                <span className="txn-logo txn-logo-fallback" aria-hidden="true">
                  {s.name.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="list-row-text">
                <span className="list-row-title">{shownName(s)}</span>
                <span className="list-row-sub">{line(r)}</span>
              </span>
              <span className={`list-row-value money recurring-amount${s.kind === 'income' ? ' inflow' : ''}`}>
                <Masked>{`${s.kind === 'income' ? '+' : ''}${formatMoney(s.amount, s.currency ?? currency)}`}</Masked>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  const opened = sheet?.series ?? null;

  return (
    <section className="card stack" aria-labelledby="recurring-title">
      <div className="card-header">
        <h3 id="recurring-title">Recurring</h3>
        {bills.some(inTotal) && (
          <span className="meta money">
            ~<Masked>{formatMoney(billsMonthly.total, currency)}</Masked>/mo out
          </span>
        )}
      </div>
      {badge && <NoticeBadge tone={badge} />}

      {saveError && !sheetError && <Notice level="caution">{saveError}</Notice>}

      {failed && series.length === 0 ? (
        <Notice level="critical">Transactions couldn&apos;t be loaded, so no bills or income can be found.</Notice>
      ) : loading && series.length === 0 ? (
        <p className="empty-note">Transactions are still loading.</p>
      ) : rows.length === 0 && noSpending ? (
        <p className="empty-note">{noSpending.lead}, so there are no bills to detect.</p>
      ) : rows.length === 0 ? (
        <p className="empty-note">
          No recurring bills or income detected yet. They show up once a merchant has charged, or paid you, the same amount on a
          regular schedule three times (four when the amount varies a little), or a yearly charge twice at exactly the same amount.
        </p>
      ) : (
        <>
          {bills.length > 0 && (
            <>
              <h4 className="recurring-kind">Bills</h4>
              {list(bills)}
            </>
          )}
          {income.length > 0 && (
            <>
              <h4 className="recurring-kind">
                Income
                {income.some(inTotal) && (
                  <span className="money">
                    {' '}
                    · ~<Masked>{formatMoney(incomeMonthly.total, currency)}</Masked>/mo in
                  </span>
                )}
              </h4>
              {list(income)}
            </>
          )}
        </>
      )}

      {dismissedRows.length > 0 && (
        <ul className="list-rows">
          <li>
            <button
              type="button"
              ref={markedRef}
              className="list-row"
              onClick={() => setShowDismissed(!showDismissed)}
              aria-expanded={showDismissed}
              aria-controls={showDismissed ? markedId : undefined}
            >
              <span className="list-row-text">
                <span className="list-row-title">{dismissedRows.length} marked not recurring</span>
              </span>
              <svg className={`section-chevron${showDismissed ? ' open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={DOWN} />
              </svg>
            </button>
            {showDismissed && (
              <ul className="list-rows recurring-marked" id={markedId}>
                {dismissedRows.map((s) => (
                  <li key={s.id}>
                    <div className="list-row">
                      <span className="list-row-text">
                        <span className="list-row-title">{shownName(s)}</span>
                        <span className="list-row-sub">
                          {where(s)} · {cadenceLabel(s.cadence)}
                        </span>
                      </span>
                      <button type="button" ref={refIn(restoreEls.current, s.id)} className="btn secondary" disabled={!canEdit} onClick={() => void restore(s)}>
                        Restore
                      </button>
                    </div>
                  </li>
                ))}
                {why && (
                  <li>
                    <p className="helper">{why}</p>
                  </li>
                )}
              </ul>
            )}
          </li>
        </ul>
      )}

      <p className="helper">
        Detected from charges and deposits that repeat on a schedule at a consistent amount; dates and amounts are estimates.
        {bills.some((r) => r.series.accountType === 'credit') && ' Bills charged to a card are in this total, and the forecast counts the card\'s payment instead.'}
        {converted && ` ${converted}`}
        {leftOut && ` ${leftOut}`}
      </p>

      {sheet && opened && (
        <Sheet
          key={sheet.n}
          open={sheetOpen}
          title={shownName(opened)}
          onClose={close}
          footer={
            <button type="button" className="btn secondary" disabled={!canEdit} onClick={() => void dismiss(opened)}>
              Not recurring
            </button>
          }
        >
          <div className="stack">
            {sheetError && <Notice level="caution">{sheetError}</Notice>}
            <p className="helper">
              Seen {opened.seen} times from {fmtDay(opened.firstDate)} to {fmtDay(opened.lastDate)}, about <Masked>{formatMoney(opened.amount, opened.currency ?? currency)}</Masked>{' '}
              {opened.agreement === 'average' ? 'each time, the average of the last half year' : 'each time'}
              <Masked>{opened.previousAmount !== undefined ? `, ${formatMoney(opened.previousAmount, opened.currency ?? currency)} before its price changed` : ''}</Masked>.
              {counted(opened) ? ` ${counted(opened)}` : ''}
            </p>
            {/* Why Not recurring is off, just above it: a caution while the
                planned items couldn't be loaded, as the card said it. */}
            {why && (status === 'error' ? <Notice level="caution">{why}</Notice> : <p className="helper">{why}</p>)}
          </div>
        </Sheet>
      )}
    </section>
  );
}

const join = (parts: readonly string[]) => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

/** What the monthly figures converted, in a sentence, or null when nothing
 *  was: "The monthly figures count 2 bills in EUR and 1 deposit in GBP
 *  converted into USD at today's ECB rates." Never an amount. */
export function monthlyConvertedText(bills: MonthlyConverted | null, income: MonthlyConverted | null): string | null {
  const into = bills?.into ?? income?.into;
  const parts = [
    ...(bills?.from ?? []).map((f) => `${f.count} bill${f.count === 1 ? '' : 's'} in ${f.currency}`),
    ...(income?.from ?? []).map((f) => `${f.count} deposit${f.count === 1 ? '' : 's'} in ${f.currency}`),
  ];
  if (!into || parts.length === 0) return null;
  const own = [...new Set([...(bills?.own ?? []), ...(income?.own ?? [])])].sort();
  return `The monthly figures count ${join(parts)} converted into ${into} at today’s ECB rates${own.length > 0 ? `, and your own rate for ${join(own)}` : ''}.`;
}
