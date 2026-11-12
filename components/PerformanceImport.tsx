'use client';

// An investment account's past months from Vanguard's Performance page,
// printed to a PDF (lib/investment-months.ts), inside the account's Import
// history from a file sheet (components/HistoryImportSheet.tsx), which offers
// a PDF only on an account whose connection is Vanguard's by Plaid's
// institution id.
//
//   - The file is read on this device (pdf.js, loaded only then, with its
//     worker from Nya's own origin) and never sent: only its months are.
//   - The REVIEW (PerformanceReview, its figures from usePerformanceReview):
//     the months and the page's four figures; a month that doesn't add up
//     takes the person's figures and nothing is imported until every check
//     holds again (lib/import/performance-review.ts); whether the file is
//     the account's, by its balances (one that is every Vanguard account's
//     together is never imported, one that may be another account's waits
//     for a yes); months the counting import has that this one doesn't
//     (another yes); how far back the chart reaches and where Nya's own
//     figures win; and the months Nya's activity covers whose deposits and
//     withdrawals aren't Vanguard's, compared and never used.
//   - Once imported (PerformanceNow): what counts and where it is used, or
//     why it isn't now. Every import is listed (PerformanceImports), the
//     newest marked Counts, each with Undo, confirmed in place with what
//     will change.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { fieldAmount, formatDay, formatInstantDay, formatMoney, MINUS, onDay, signedMoney, zeroExample } from '@/lib/format';
import { normalizedAmountText } from '@/lib/manual-txn-input';
import { pdfTextPages, MAX_PDF_BYTES, MAX_PDF_PAGES, type PdfJs, type PdfTextError } from '@/lib/import/pdf-text';
import { readPerformance, type Cents, type PerformanceRead } from '@/lib/import/vanguard-performance';
import { accountCheck, addsUpAsRead, reviewMonths, type AccountCheck, type MonthState, type Read, type TypedMonth } from '@/lib/import/performance-review';
import {
  monthText,
  countingImport,
  importSpan,
  monthsDropped,
  withPastMonths,
  allTimeFromMonths,
  firstMonth,
  type InvestmentMonths,
  type Month,
  type MonthsActivity,
  type MonthsImport,
  type MonthsUnused,
  type PastMonth,
  type PastMonthsResult,
} from '@/lib/investment-months';
import type { BalancePoint } from '@/lib/growth';
import FieldError from './FieldError';
import { Strip } from './FiguresStrip';
import { Masked } from './HideAmounts';
import { Notice } from './TotalCaveats';
import { Why } from './Why';

export const SOURCE = 'Vanguard’s Performance page';

// ---- Reading the file -------------------------------------------------------

export type PdfOutcome = PerformanceRead | { kind: 'error'; error: PdfTextError };
/** Reads a PDF's bytes into the page's months: pdf.js in the browser, a
 *  stand-in in tests. */
export type PdfReader = (data: Uint8Array) => Promise<PdfOutcome>;

async function loadPdfjs(): Promise<PdfJs> {
  const pdfjs = await import('pdfjs-dist');
  // Its worker, bundled and served from Nya's own origin (the CSP's
  // worker-src 'self').
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  return pdfjs as unknown as PdfJs;
}

export const readPdfHere: PdfReader = async (data) => {
  const pages = await pdfTextPages(data, await loadPdfjs());
  return 'error' in pages ? { kind: 'error', error: pages.error } : readPerformance(pages);
};

/** Whether a picked file is a PDF: by its name, or its first bytes. */
export function isPdf(name: string, head: Uint8Array): boolean {
  return /\.pdf$/i.test(name) || new TextDecoder().decode(head.slice(0, 5)) === '%PDF-';
}

/** Why a PDF gave no months, in the person's words. */
export function pdfProblem(outcome: Exclude<PdfOutcome, { kind: 'read' }>): string {
  if (outcome.kind === 'not-performance')
    return 'This PDF isn’t Vanguard’s Performance page, the only PDF Nya reads. Print that page with this account chosen alone: a statement or another firm’s PDF can’t be read.';
  if (outcome.kind === 'unknown-layout')
    return 'This looks like Vanguard’s Performance page, but its table isn’t laid out as Nya knows it, so nothing was read from it. Vanguard may have changed the page, and Nya needs an update to read it.';
  if (outcome.kind === 'no-text') return 'This PDF has no text Nya can read: it may be a scan or a picture. Print the Performance page from your browser instead.';
  if (outcome.error === 'password') return 'This PDF is protected by a password, so Nya can’t read it. Print the Performance page from your browser again, without one.';
  if (outcome.error === 'too-large' || outcome.error === 'too-many-pages')
    return `This PDF is larger than Nya reads (up to ${MAX_PDF_BYTES / (1024 * 1024)} MB and ${MAX_PDF_PAGES} pages). Print the Performance page with this account chosen alone.`;
  return 'This file couldn’t be read as a PDF. Print the Performance page to a PDF again and choose that file.';
}

/** A PDF on an account that isn't at Vanguard. */
export function notVanguardWords(name: string, institution: string): string {
  return `Nya reads a PDF only from ${SOURCE}, and ${name} is at ${institution}. Download its transactions from ${institution} as OFX or QFX, CSV or QIF instead.`;
}

// ---- Words ------------------------------------------------------------------

const spanText = (from: Month, to: Month) => (from === to ? monthText(from) : `${monthText(from)} to ${monthText(to)}`);
const day = (iso: string) => formatDay(iso, { sentence: true });
const importedDay = (i: MonthsImport) => formatInstantDay(i.imported_at, { sentence: true }) ?? i.imported_at.slice(0, 10);
const months = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'month' : 'months'}`;
const cents = (c: Cents) => c / 100;

/** The first day Nya recorded a balance itself. */
const firstRecordedOf = (points: readonly BalancePoint[] | null) => points?.find((p) => !p.estimated && !p.entered)?.date ?? null;

/** Why months aren't used, after "These months aren’t used now: ". */
export function unusedWords(
  why: MonthsUnused,
  o: { name: string; counting: MonthsImport; currency: string | null; activity_from: string | null; first_recorded: string | null },
  newer: string
): string {
  const last = o.counting.months[o.counting.months.length - 1].month;
  switch (why) {
    case 'currency':
      return `they are in ${o.counting.currency ?? 'USD'}, and ${o.name} is in ${o.currency ?? 'USD'} now.`;
    case 'activity':
      return `Nya has no investment activity for ${o.name} to join them to yet.`;
    case 'no-record':
      return `Nya hasn’t recorded a balance for ${o.name} yet. They are used once it has.`;
    case 'gap':
      return `Nya’s activity for this account starts ${o.activity_from ? day(o.activity_from) : 'later'}, and they end in ${monthText(last)}, so nothing covers the days between. ${newer}`;
    case 'activity-late':
      return `Nya’s activity for this account starts ${o.activity_from ? day(o.activity_from) : 'later'}, after the first day it recorded its balance${o.first_recorded ? `, ${day(o.first_recorded)}` : ''}, so no month can be joined to it. A newer file wouldn’t change that.`;
    case 'covered':
      return 'Nya has its own balances for every one of them.';
  }
}

// ---- What there is ----------------------------------------------------------

/** The account's imports, history and activity, for the sheet. `points` and
 *  `activity` stay null while they load or when they can't be loaded: the
 *  sheet then says less, never more. */
export function usePerformanceData(account: { account_id: string; item_id: string | null } | null, load: (id: string, item: string) => Promise<MonthsActivity>) {
  const [imports, setImports] = useState<InvestmentMonths | null>(null);
  const [importsError, setImportsError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [points, setPoints] = useState<BalancePoint[] | null>(null);
  const [activity, setActivity] = useState<MonthsActivity | null>(null);
  // The account shown now: an answer for one the sheet has left is dropped.
  const current = useRef<string | null>(null);

  const reload = useCallback(async (id: string) => {
    setImportsError('');
    try {
      const res = await fetch(`/api/investment-months?account_id=${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => null);
      if (current.current !== id) return null;
      if (!res.ok) {
        setImportsError(typeof data?.error === 'string' ? data.error : 'The imported months couldn’t be loaded.');
        return null;
      }
      const next = (data?.investment_months ?? null) as InvestmentMonths | null;
      setImports(next);
      setLoaded(true);
      return next;
    } catch {
      if (current.current === id) setImportsError('The imported months couldn’t be loaded: the server couldn’t be reached.');
      return null;
    }
  }, []);

  const id = account?.account_id ?? null;
  const item = account?.item_id ?? null;
  useEffect(() => {
    current.current = id;
    setImports(null);
    setLoaded(false);
    setPoints(null);
    setActivity(null);
    if (!id) return;
    let cancelled = false;
    void reload(id);
    fetch(`/api/account-history?id=${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => !cancelled && setPoints(Array.isArray(d?.points) ? d.points : null))
      .catch(() => {});
    if (item)
      load(id, item)
        .then((a) => !cancelled && setActivity(a))
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, item, reload, load]);

  return { imports, setImports, importsError, loaded, points, activity, reload };
}

/** What counts now and where, or why it isn't used (the sheet's top, once
 *  something is imported). */
export function PerformanceNow({
  name,
  imports,
  points,
  activity,
  currency,
}: {
  name: string;
  imports: InvestmentMonths;
  points: BalancePoint[] | null;
  activity: MonthsActivity | null;
  currency: string | null;
}) {
  const counting = countingImport(imports);
  const past = useMemo(() => (counting && points && activity ? withPastMonths(points, activity, imports, currency) : null), [counting, points, activity, imports, currency]);
  if (!counting) return null;
  const span = importSpan(counting);
  return (
    <div className="stack tight">
      <h3 className="section-label">{`${spanText(span.from, span.to)}, from ${SOURCE}`}</h3>
      {past?.applied && (
        <p className="helper">{`Nya uses them where it has nothing of its own: balances ${past.applied.joined ? `before ${day(past.applied.first_recorded)}` : `until ${day(past.applied.entered_to)}, then its own estimates`}, and deposits and withdrawals before ${day(past.applied.activity_from)}.`}</p>
      )}
      {past?.unused && (
        <Notice level="caution" role="status">
          {`These months aren’t used now: ${unusedWords(
            past.unused,
            { name, counting, currency, activity_from: activity?.flows_from ?? null, first_recorded: firstRecordedOf(points) },
            'Import a newer Performance page to use them again.'
          )}`}
        </Notice>
      )}
      <details className="plan-table-view">
        <summary>{`Show the ${months(counting.months.length)}`}</summary>
        <MonthsTable list={counting.months} currency={currency} />
      </details>
    </div>
  );
}

function MonthsTable({ list, currency }: { list: readonly PastMonth[]; currency: string | null }) {
  return (
    <div className="report-scroll">
      <table className="report-table">
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col" className="num">
              Deposits & withdrawals
            </th>
            <th scope="col" className="num">
              Returns
            </th>
            <th scope="col" className="num">
              Ending balance
            </th>
          </tr>
        </thead>
        <tbody>
          {[...list].reverse().map((m) => (
            <tr key={m.month}>
              <td className="report-nowrap">{monthText(m.month)}</td>
              <td className="num">
                <Masked>{signedMoney(m.net, currency, { always: true })}</Masked>
              </td>
              <td className="num">
                <Masked>{signedMoney(m.returns, currency, { always: true })}</Masked>
              </td>
              <td className="num">
                <Masked>{formatMoney(m.end, currency)}</Masked>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** How many imports the list shows before Show more. */
const SHOWN = 5;

/** Every Performance page imported into the account, newest first, the one
 *  that counts marked, each with Undo confirmed in place. `onUndo` answers
 *  whether it was undone. */
export function PerformanceImports({
  name,
  imports,
  points,
  activity,
  currency,
  busy,
  onUndo,
}: {
  name: string;
  imports: InvestmentMonths;
  points: BalancePoint[] | null;
  activity: MonthsActivity | null;
  currency: string | null;
  busy: boolean;
  onUndo: (i: MonthsImport) => Promise<boolean>;
}) {
  const [asking, setAsking] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const list = [...imports.imports].reverse();
  const counting = list[0];
  const past = useMemo(() => (points && activity ? withPastMonths(points, activity, imports, currency) : null), [points, activity, imports, currency]);
  const applied = past?.applied ?? null;
  if (!counting) return null;
  const shown = all ? list : list.slice(0, SHOWN);
  const hidden = list.length - SHOWN;

  const askText = (i: MonthsImport) => {
    const d = importedDay(i);
    if (i !== counting)
      return `Undo the import from ${d}? Nothing you see changes: the newest import counts. There’s just no going back to this one afterwards. You can import the file again later.`;
    const next = list[1];
    const totals = activity?.money_in_out;
    const unreadable = !!activity?.money_in_out_unreadable;
    if (next) {
      const s = importSpan(next);
      // All time from the newest's months, and from the one before's.
      const now = allTimeFromMonths(past, totals, unreadable);
      const then = now && points && activity ? allTimeFromMonths(withPastMonths(points, activity, { imports: imports.imports.filter((i) => i !== counting) }, currency), totals, unreadable) : now;
      const allTime = now && then !== now ? `, and all time will ${then ? `count from ${monthText(then.slice(0, 7))}` : 'need your deposits and withdrawals'}` : '';
      return `Undo the import from ${d}? The months will come from the one before it again, from ${importedDay(next)}: ${spanText(s.from, s.to)}${allTime}. Nothing else changes, and you can import the file again later.`;
    }
    // All time came from its months when they start at $0.00 and no totals
    // stand instead (lib/growth-summary.ts).
    const allTime = !!allTimeFromMonths(past, totals, unreadable);
    return `Undo the import from ${d}? ${name} goes back to how it was before any import${
      applied ? `: before ${day(applied.first_recorded)} its chart is Nya’s estimate again${allTime ? ', and all time needs your deposits and withdrawals' : ''}` : ''
    }. Nothing else changes, and you can import the file again later.`;
  };

  return (
    <div className="stack tight">
      <ul className="list-rows">
        {shown.map((i) => {
          const s = importSpan(i);
          return (
            <li key={i.id}>
              <div className="list-row">
                <span className="list-row-text">
                  <span className="list-row-title">{i.file_name ?? SOURCE}</span>
                  <span className="list-row-sub">
                    {`Imported ${importedDay(i)} · ${months(i.months.length)} · covers ${spanText(s.from, s.to)}`}{' '}
                    {i === counting && <span className="badge accent">Counts</span>}
                  </span>
                </span>
                {asking !== i.id && (
                  <button type="button" className="btn ghost" aria-label={`Undo the import from ${importedDay(i)}`} disabled={busy} onClick={() => setAsking(i.id)}>
                    Undo
                  </button>
                )}
              </div>
              {asking === i.id && (
                <div className="import-confirm stack tight">
                  <p className="helper" role="status">
                    {askText(i)}
                  </p>
                  <div className="btn-row">
                    <button type="button" className="btn secondary" disabled={busy} onClick={() => setAsking(null)}>
                      Keep it
                    </button>
                    <button
                      type="button"
                      className="btn danger"
                      disabled={busy}
                      onClick={async () => {
                        if (await onUndo(i)) setAsking(null);
                      }}
                    >
                      {busy ? 'Undoing…' : 'Undo import'}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!all && list.length > SHOWN && (
        <div>
          <button type="button" className="btn ghost" onClick={() => setAll(true)}>
            {`Show ${hidden.toLocaleString()} ${hidden === 1 ? 'more import' : 'more imports'}`}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- The review -------------------------------------------------------------

/** What the review checks the file against: the account now. */
export type ReviewContext = {
  account_id: string;
  name: string;
  currency: string | null;
  /** Its balance now, or null. */
  balance: number | null;
  /** Every account's balance now at a Vanguard connection, this one's with them. */
  vanguard: number[];
  imports: InvestmentMonths | null;
  points: BalancePoint[] | null;
  activity: MonthsActivity | null;
  /** The person's today, YYYY-MM-DD. */
  today: string;
};

type FieldText = { net: string; returns: string; end: string };

/** An amount as typed, with its sign ("+1,000.00", "−250", "$12.50"), in
 *  cents; null when it isn't one. */
export function readSigned(text: string): Cents | null {
  let t = text.trim().replace(/^\$/, '');
  let sign = 1;
  if (/^[+\-−]/.test(t)) {
    if (t[0] !== '+') sign = -1;
    t = t.slice(1).trim().replace(/^\$/, '');
  }
  const normal = normalizedAmountText(t);
  if (normal === null) return null;
  const n = Math.round(Number(normal) * 100);
  return Number.isFinite(n) && n <= 1e14 ? sign * n : null;
}

/** A figure as a field shows it to begin with. */
const fieldText = (c: Cents | null, signed: boolean) => (c === null ? '' : `${signed ? (c < 0 ? MINUS : '+') : ''}${fieldAmount(Math.abs(c) / 100)}`);

/** The body the route takes for an import (app/api/investment-months). */
export type ImportBody = {
  action: 'import';
  account_id: string;
  file_name: string | null;
  start: { month: Month; balance: number };
  months: PastMonth[];
  currency: string | null;
  typed: Month[];
  counting: string | null;
};

/** The review's state and what follows from it: held by the sheet, so its
 *  footer's Import knows whether it may go. */
export function usePerformanceReview(read: Read | null, ctx: ReviewContext, fileName: string | null) {
  const [typedText, setTypedText] = useState<Record<Month, FieldText>>({});
  // Each yes is kept with the question it answered (see below).
  const [another, setAnother] = useState<{ read: Read; kind: string | null } | null>(null);
  const [droppedYes, setDroppedYes] = useState<{ read: Read; counting: string | null } | null>(null);
  useEffect(() => setTypedText({}), [read]);

  const typed = useMemo(() => {
    const out: Record<Month, TypedMonth> = {};
    for (const [m, t] of Object.entries(typedText)) out[m] = { net: readSigned(t.net), returns: readSigned(t.returns), end: readSigned(t.end) };
    return out;
  }, [typedText]);
  const review = useMemo(() => (read ? reviewMonths(read, typed) : null), [read, typed]);
  const importable = review?.importable ?? null;
  const last = review?.months[review.months.length - 1] ?? null;
  const check: AccountCheck = useMemo(
    () =>
      importable && read && last
        ? accountCheck({
            last: { day: read.last.day, balance: last.end === null ? null : cents(last.end) },
            months: importable.months,
            points: ctx.points,
            balance: ctx.balance,
            vanguard: ctx.vanguard,
            today: ctx.today,
          })
        : null,
    [importable, read, last, ctx.points, ctx.balance, ctx.vanguard, ctx.today]
  );
  const counting = countingImport(ctx.imports);
  // A yes is to the question asked: asked again once it changes, as when
  // another device's import counts now, or the balances arrive. Kept with
  // what it answered, so a yes to the old question never counts, not even
  // for the one render before an effect could clear it.
  const checkKind = check?.kind ?? null;
  const countingId = counting?.id ?? null;
  const yesAnother = !!read && another !== null && another.read === read && another.kind === checkKind;
  const yesDropped = !!read && droppedYes !== null && droppedYes.read === read && droppedYes.counting === countingId;
  const setYesAnother = (yes: boolean) => setAnother(yes && read ? { read, kind: checkKind } : null);
  const setYesDropped = (yes: boolean) => setDroppedYes(yes && read ? { read, counting: countingId } : null);
  const dropped = importable ? monthsDropped(counting, importable) : { before: null, after: null };
  const future: PastMonthsResult | null = useMemo(() => {
    if (!importable || !ctx.points || !ctx.activity) return null;
    const candidate: MonthsImport = {
      id: 'in-review',
      source: 'vanguard-performance',
      file_name: fileName,
      imported_at: new Date(0).toISOString(),
      start: importable.start,
      months: importable.months,
      currency: ctx.currency,
    };
    return withPastMonths(ctx.points, ctx.activity, { imports: [candidate] }, ctx.currency);
  }, [importable, ctx.points, ctx.activity, ctx.currency, fileName]);
  // Whether all time counts from the months now, when the account opened,
  // and this file's alone would make it count from later.
  const opensNow = useMemo(
    () =>
      ctx.points && ctx.activity
        ? allTimeFromMonths(withPastMonths(ctx.points, ctx.activity, ctx.imports, ctx.currency), ctx.activity.money_in_out, !!ctx.activity.money_in_out_unreadable)
        : null,
    [ctx.points, ctx.activity, ctx.imports, ctx.currency]
  );
  const opensThen = allTimeFromMonths(future, ctx.activity?.money_in_out, !!ctx.activity?.money_in_out_unreadable);
  // Null: unchanged. Else the day all time would count from, or null with
  // none (the file's months from a balance, or unused).
  const allTimeLater = opensNow && opensThen !== opensNow ? { from: opensThen } : null;

  const waits =
    !importable ||
    check?.kind === 'all-accounts' ||
    ((check?.kind === 'another' || check?.kind === 'unchecked') && !yesAnother) ||
    ((dropped.before !== null || dropped.after !== null) && !yesDropped);
  const body: ImportBody | null =
    importable && !waits
      ? {
          action: 'import',
          account_id: ctx.account_id,
          file_name: fileName,
          start: importable.start,
          months: importable.months,
          currency: ctx.currency,
          typed: importable.typed,
          counting: counting?.id ?? null,
        }
      : null;
  const count = importable?.months.length ?? review?.months.filter((m) => m.whole).length ?? 0;
  return { read, review, typedText, setTypedText, check, dropped, future, allTimeLater, yesAnother, setYesAnother, yesDropped, setYesDropped, body, count, counting };
}
export type ReviewState = ReturnType<typeof usePerformanceReview>;

/** The review of a read file (see the header). Its Import is the sheet's
 *  footer, from `state.body`. */
export function PerformanceReview({ state, ctx, fileName, onAgain }: { state: ReviewState; ctx: ReviewContext; fileName: string | null; onAgain: () => void }) {
  const id = useId();
  const [allMonths, setAllMonths] = useState(false);
  const { read, review, check, dropped, future, counting } = state;
  if (!read || !review) return null;
  const money = (n: number) => formatMoney(n, ctx.currency);
  const whole = review.months.filter((m) => m.whole);
  const imp = review.importable;
  const failing = review.failing;
  // The months to correct: those that fail, and those already typed, so a
  // month's fields stay put once its figures add up.
  const fixes = review.months.filter((m) => !m.ok || m.typed);
  // With no beginning balance nothing can be checked, and none of the
  // fields would bring one.
  const unreadable = review.months.length > 0 && review.months[0].begin === null;

  const leftOut = review.left_out
    .map((m) => (m === review.months[review.months.length - 1].month ? `${monthText(m)} is left out until it ends.` : `${monthText(m)} is left out: the file starts after its 1st.`))
    .join(' ');
  const headline = whole.length === 0 ? 'No whole month in this file' : `${months(whole.length)}, ${spanText(whole[0].month, whole[whole.length - 1].month)}`;
  const addsUp =
    failing.length > 0
      ? failing.length < review.months.length
        ? 'Every other month adds up.'
        : ''
      : review.totals_ok
        ? 'Every month adds up, and so does the page’s total.'
        : 'Every month adds up.';

  const firstRecorded = firstRecordedOf(ctx.points);
  const activityFrom = ctx.activity?.flows_from ?? null;
  const later = dropped.before !== null || dropped.after !== null;
  const allAcc = check?.kind === 'all-accounts';

  return (
    <div className="stack">
      <p className="helper">{`${fileName ?? 'This file'} · ${SOURCE}`}</p>
      <div className="stack tight">
        <p className="import-headline">{headline}</p>
        {(addsUp || leftOut) && <p className="helper">{[addsUp, leftOut].filter(Boolean).join(' ')}</p>}
      </div>

      {unreadable && (
        <div className="stack tight">
          <Notice level="critical" role="alert">
            {`${monthText(review.months[0].month)}’s beginning balance couldn’t be read, so this file can’t be checked. Print Vanguard’s page again and choose that file.`}
          </Notice>
          <div>
            <button type="button" className="btn secondary" onClick={onAgain}>
              Choose another file
            </button>
          </div>
        </div>
      )}
      {!unreadable && fixes.length > 0 && (
        <div className="stack">
          {failing.length > 0 && (
            <Notice level="critical" role="alert">
              {failing.length === 1
                ? `${monthText(failing[0].month)} doesn’t add up, so nothing can be imported yet. Check its figures against Vanguard’s page and correct the one that’s wrong.`
                : `${months(failing.length)} don’t add up, so nothing can be imported yet. Check their figures against Vanguard’s page and correct the ones that are wrong.`}
            </Notice>
          )}
          {fixes.map((m) => (
            <FailingMonth key={m.month} id={`${id}-${m.month}`} m={m} state={state} currency={ctx.currency} />
          ))}
        </div>
      )}
      {failing.length === 0 && !review.totals_ok && (
        <Notice level="critical" role="alert">
          {Object.keys(state.typedText).length > 0
            ? 'Every month adds up now, but the page’s total doesn’t match them, so nothing can be imported. Check the months you corrected against Vanguard’s page.'
            : 'The page’s total doesn’t match its months, so nothing can be imported: a figure may have been read wrong. Print the Performance page again and choose that file.'}
        </Notice>
      )}
      {failing.length === 0 && whole.length === 0 && (
        <Notice level="critical" role="alert">
          This file has no whole month yet: Nya imports a month once it has ended. Print Vanguard’s page for a range that reaches past a month’s end.
        </Notice>
      )}

      {imp && (
        <Strip
          f={{
            begin: imp.start.balance,
            dw: imp.months.reduce((s, m) => s + m.net, 0),
            returns: imp.months.reduce((s, m) => s + m.returns, 0),
            end: imp.months[imp.months.length - 1].end,
          }}
          currency={ctx.currency ?? 'USD'}
        />
      )}

      {(check?.kind === 'another' || check?.kind === 'unchecked') && (
        <div className="stack tight">
          {check.kind === 'another' ? (
            <Notice level="caution" role="status">
              {`This file may be for another account: its balance ${onDay(day(check.day))} is `}
              <Masked>{money(check.balance)}</Masked>
              {`, and ${ctx.name}’s is `}
              <Masked>{money(check.account)}</Masked>.
            </Notice>
          ) : (
            <Notice level="caution" role="status">
              {`Nya can’t tell whether this file is ${ctx.name}’s: it has no balance of the account’s on a day the file has.${ctx.balance !== null ? ' A file printed up to today is checked against the balance now.' : ''}`}
            </Notice>
          )}
          <label className="check-row">
            <input type="checkbox" checked={state.yesAnother} onChange={(e) => state.setYesAnother(e.target.checked)} />
            <span className="check-row-text">
              <span className="check-row-title">{`It’s ${ctx.name}’s`}</span>
              <span className="check-row-sub">Import it for this account anyway.</span>
            </span>
          </label>
        </div>
      )}
      {allAcc && check?.kind === 'all-accounts' && (
        <div className="stack tight">
          <Notice level="critical" role="alert">
            {`This file is for all your Vanguard accounts together: its balance ${onDay(day(check.day))}, `}
            <Masked>{money(check.balance)}</Masked>
            {`, is what they hold between them${check.account !== null ? `, not ${ctx.name}’s ` : ''}`}
            {check.account !== null && <Masked>{money(check.account)}</Masked>}
            {`. On ${SOURCE}, choose ${ctx.name} alone, print the page again, and choose that file.`}
          </Notice>
          <div>
            <button type="button" className="btn secondary" onClick={onAgain}>
              Choose another file
            </button>
          </div>
        </div>
      )}
      {check?.kind === 'matches' && (
        <p className="helper">
          {`Its balance ${onDay(day(check.day))}, `}
          <Masked>{money(check.balance)}</Masked>
          {`, is ${ctx.name}’s.`}
        </p>
      )}

      {later && counting && (
        <div className="stack tight">
          <Notice level="caution" role="status">
            {droppedWords(dropped, counting, imp!)}
          </Notice>
          <label className="check-row">
            <input type="checkbox" checked={state.yesDropped} onChange={(e) => state.setYesDropped(e.target.checked)} />
            <span className="check-row-text">
              <span className="check-row-title">Use this file’s months only</span>
              <span className="check-row-sub">
                {laterWords(dropped, imp!, state.allTimeLater)}
              </span>
            </span>
          </label>
        </div>
      )}

      {imp && !later && !allAcc && future?.unused && (
        <Notice level="caution" role="status">
          {`These months wouldn’t be used now: ${unusedWords(
            future.unused,
            { name: ctx.name, counting: future.counting!, currency: ctx.currency, activity_from: activityFrom, first_recorded: firstRecorded },
            'A newer Performance page would be.'
          )} You can still import them.`}
        </Notice>
      )}
      {imp && !later && !allAcc && !future?.unused && (
        <p className="helper">
          {`The chart and your returns will reach back to ${monthText(firstMonth(imp))}.${
            future?.applied ? ` Where Nya has its own balances (from ${day(future.applied.first_recorded)}) and activity (from ${day(future.applied.activity_from)}), those count.` : ''
          }`}
        </p>
      )}

      {future && future.differs.length > 0 && (
        <div className="stack tight">
          <Notice level="info" role="status">
            {`In ${months(future.differs.length)} Nya has activity for, Vanguard’s deposits and withdrawals aren’t Nya’s. Nya keeps its own for those months, so importing doesn’t change them.`}
          </Notice>
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col" className="num">
                  Vanguard
                </th>
                <th scope="col" className="num">
                  Nya
                </th>
              </tr>
            </thead>
            <tbody>
              {[...future.differs].reverse().map((d) => (
                <tr key={d.month}>
                  <td className="report-nowrap">{monthText(d.month)}</td>
                  <td className="num">
                    <Masked>{signedMoney(d.theirs, ctx.currency, { always: true })}</Masked>
                  </td>
                  <td className="num">
                    <Masked>{signedMoney(d.nyas, ctx.currency, { always: true })}</Masked>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="helper">A move inside the account, such as a sweep or a conversion, can read as money in or out.</p>
        </div>
      )}

      {imp && (
        <div className="stack tight">
          <h3 className="section-label">The months, newest first</h3>
          <MonthsTable list={allMonths ? imp.months : imp.months.slice(-4)} currency={ctx.currency} />
          {!allMonths && imp.months.length > 4 && (
            <div>
              <button type="button" className="btn ghost" onClick={() => setAllMonths(true)}>
                {`Show all ${months(imp.months.length)}`}
              </button>
            </div>
          )}
        </div>
      )}

      <Why>
        {`${firstRecorded && activityFrom ? `Nya has this account’s balances from ${day(firstRecorded)} and its activity from ${day(activityFrom)}. ` : ''}${SOURCE} has every month since the account opened: its beginning balance, deposits and withdrawals, returns and ending balance. Each month has to add up (beginning balance, plus deposits and withdrawals, plus returns, is its ending balance, and the next month begins there), and the page’s total has to match its months, so a figure read wrong can’t slip through. Nya uses the months only where it has nothing of its own. Vanguard gives one deposits and withdrawals figure a month, so Nya counts it at the middle of the month. Nya reads this one page only, from Vanguard only: a PDF laid out any other way isn’t read, never guessed at. Each import is kept on its own, listed in this sheet with its Undo, and undoing it puts the account back as it was before.`}
      </Why>
    </div>
  );
}

/** What using only this file's months does, for its yes. `allTime`: all
 *  time counts from the counting import's months now, which start when the
 *  account opened, and with this file's alone it would count from `from`,
 *  or need the person's totals (null). */
function laterWords(d: ReturnType<typeof monthsDropped>, next: { start: { month: Month; balance?: number }; months: PastMonth[] }, allTime: { from: string | null } | null): string {
  const from = monthText(firstMonth(next));
  const to = monthText(next.months[next.months.length - 1].month);
  if (allTime?.from) {
    const before = `All time would count from ${monthText(allTime.from.slice(0, 7))}, not from when the account opened`;
    if (d.before && d.after) return `${before}, and the months after ${to} would come from Nya’s own records again.`;
    if (d.before) return `${before}.`;
  }
  const needs = allTime ? ', and all time would need your deposits and withdrawals' : '';
  if (d.before && d.after) return `Before ${from} and after ${to}, the chart and your returns would come from Nya’s own records again${needs}.`;
  if (d.before) return `Before ${from}, the chart and your returns would come from Nya’s own records again${needs}.`;
  return `The months after ${to} would come from Nya’s own records again${needs}.`;
}

/** The months the counting import has that this file doesn't. */
function droppedWords(d: ReturnType<typeof monthsDropped>, counting: MonthsImport, next: { start: { month: Month; balance?: number }; months: PastMonth[] }): string {
  const from = firstMonth(counting);
  const nextFrom = firstMonth(next);
  const opened = counting.start.balance === 0 ? ', when the account opened' : '';
  const to = next.months[next.months.length - 1].month;
  if (d.before && d.after)
    return `${spanText(d.before.from, d.before.to)} and ${spanText(d.after.from, d.after.to)} would stop counting: this file runs from ${monthText(nextFrom)} to ${monthText(to)}, and only the newest import counts. To keep them, print Vanguard’s page from ${monthText(from)}${opened ? `${opened},` : ''} up to today.`;
  if (d.before)
    return `${spanText(d.before.from, d.before.to)} would stop counting: this file starts in ${monthText(nextFrom)}, and only the newest import counts. To keep them, print Vanguard’s page from ${monthText(from)}${opened}.`;
  const a = d.after!;
  return `${spanText(a.from, a.to)} would stop counting: this file ends in ${monthText(to)}, and only the newest import counts. To keep them, print Vanguard’s page up to today.`;
}

/** A month the review can't vouch for, with its three figures to correct. */
function FailingMonth({ id, m, state, currency }: { id: string; m: MonthState; state: ReviewState; currency: string | null }) {
  const money = (c: Cents) => formatMoney(cents(c), currency);
  const months = state.review!.months;
  const k = months.findIndex((x) => x.month === m.month);
  const prev = months[k - 1] ?? null;
  const next = state.read!.months[k + 1] ?? null;
  const text: FieldText = state.typedText[m.month] ?? { net: fieldText(m.read.net, true), returns: fieldText(m.read.returns, true), end: fieldText(m.read.end, false) };
  const set = (part: keyof FieldText, value: string) => state.setTypedText((t) => ({ ...t, [m.month]: { ...text, [part]: value } }));
  const read = state.read!.months[k];

  // Its amounts each through Masked, so hidden amounts hide them here too.
  let problem: ReactNode = null;
  if (m.net === null || m.returns === null || m.end === null || m.begin === null) problem = 'Type each figure as an amount, such as 1,000.00 or −250.00.';
  else if (m.begin + m.net + m.returns !== m.end) {
    const sum = m.begin + m.net + m.returns;
    const sign = (c: Cents) => (c < 0 ? ` ${MINUS} ` : ' + ');
    problem = (
      <>
        <Masked>{money(m.begin)}</Masked>
        {sign(m.net)}
        <Masked>{money(Math.abs(m.net))}</Masked>
        {sign(m.returns)}
        <Masked>{money(Math.abs(m.returns))}</Masked>
        {' is '}
        <Masked>{money(sum)}</Masked>
        {', not '}
        <Masked>{money(m.end)}</Masked>.
        {next && next.figures.begin !== null && (
          <>
            {` ${monthText(next.month)} began at `}
            <Masked>{money(next.figures.begin)}</Masked>.
          </>
        )}
      </>
    );
  } else if (m.typed && next && !state.typedText[next.month] && addsUpAsRead(next.figures) && m.end !== next.figures.begin)
    problem = (
      <>
        {'It ends at '}
        <Masked>{money(m.end)}</Masked>
        {`, but ${monthText(next.month)} began at `}
        <Masked>{money(next.figures.begin!)}</Masked>
        {'. Check its ending balance against Vanguard’s page.'}
      </>
    );
  else if (!m.typed && read.failed.includes('returns')) problem = 'Its returns aren’t its market gain or loss plus its income, so one of them was read wrong. Check its returns against Vanguard’s page.';
  else if (!m.typed && read.figures.begin !== m.begin && prev)
    problem = (
      <>
        {'It begins at '}
        <Masked>{money(read.figures.begin ?? 0)}</Masked>
        {`, not ${monthText(prev.month)}’s ending balance. Check both months against Vanguard’s page.`}
      </>
    );
  else if (!m.typed) problem = 'Its cumulative returns don’t follow from its returns. Check its returns against Vanguard’s page.';

  const errId = `${id}-error`;
  return (
    <fieldset className="stack tight">
      <legend className="section-label">{monthText(m.month)}</legend>
      {m.begin !== null && (
        <p className="helper">
          {'Began at '}
          <Masked>{money(m.begin)}</Masked>
          {prev ? `, ${monthText(prev.month)}’s ending balance.` : '.'}
        </p>
      )}
      <label className="field">
        Deposits & withdrawals
        <input inputMode="decimal" placeholder={zeroExample(2)} value={text.net} onChange={(e) => set('net', e.target.value)} />
      </label>
      <label className="field">
        Investment returns
        <input inputMode="decimal" placeholder={zeroExample(2)} value={text.returns} onChange={(e) => set('returns', e.target.value)} />
      </label>
      <label className="field">
        Ending balance
        <input inputMode="decimal" placeholder={zeroExample(2)} value={text.end} aria-invalid={problem ? true : undefined} aria-describedby={problem ? errId : undefined} onChange={(e) => set('end', e.target.value)} />
      </label>
      {problem && <FieldError id={errId}>{problem}</FieldError>}
    </fieldset>
  );
}
