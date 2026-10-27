'use client';

// The Progress card at the end of Your path (rollout 8e): "This is my plan"
// saves the Plan's assumptions as they are (lib/fire/saved-plan.ts, through
// app/api/saved-plan), and from then on the card sets the invested assets
// recorded each day (app/api/invested-history) against where that plan has
// them (plannedAt). Nothing worked out is ever stored: the comparison is
// made again on every visit.
//
// The comparison is made only on a WHOLE day (every account the plan counts
// recorded, nothing left out for its currency) at least a month after the
// plan's start, and says on what day; a newer day that wasn't whole is said
// in a caution under it. Accounts first recorded after the start are named:
// what they held then counts as progress here. Every amount goes through
// wholeMoney, which hide amounts masks.

import { useEffect, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import { Menu } from './Menu';
import { Why } from './Why';
import { Masked } from './HideAmounts';
import { Notice } from './TotalCaveats';
import { dayName, pct, wholeMoney } from './plan-text';
import type { FirePlan, Input } from '@/lib/fire/plan';
import type { AssetInstitution } from '@/lib/fire/inputs';
import { changedSince, DEFAULT_INFLATION, MAX_INFLATION, plannedAt, yearsBetween, YEAR_DAYS, type SavedPlan } from '@/lib/fire/saved-plan';
import { isComplete, progressAccountsOf, type InvestedDay } from '@/lib/fire/invested-series';
import type { PathPoint } from '@/lib/fire/path';

/** The days after the start before where you are is set against the plan:
 *  less than this is mostly a day's noise. */
export const MIN_DAYS = 30;

/** What GET /api/invested-history answers. */
export type ProgressAnswer = {
  currency: string | null;
  saved_day: string;
  anchor: InvestedDay | null;
  latest: InvestedDay | null;
  months: { date: string; total: number }[];
  accounts: { account_id: string; first: string | null; last: string | null; ended: string | null; label: string | null }[];
  unreadable_days: string[];
};

export type SavedState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string | null }
  | { kind: 'ready'; saved: SavedPlan | null; problem: 'unreadable' | 'newer' | null };

export type SeriesState = { kind: 'loading' } | { kind: 'failed'; message: string | null } | { kind: 'ready'; answer: ProgressAnswer };

export type ProgressSheet = null | 'save' | 'resave' | 'forget' | 'forget-unreadable';

const names = (parts: readonly string[]) => (parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
const accounts = (n: number) => `${n} ${n === 1 ? 'account' : 'accounts'}`;

/** Why a day isn't whole, in a sentence, or null when it is. */
export function shortWhy(day: InvestedDay, nameOf: (id: string) => string): string | null {
  const parts: string[] = [];
  if (day.missing.length > 0) parts.push(`${names(day.missing.map(nameOf))} ${day.missing.length === 1 ? 'wasn’t' : 'weren’t'} recorded that day`);
  const other = Object.entries(day.otherCurrencies);
  if (other.length > 0) {
    parts.push(
      `${names(other.map(([c, n]) => `${accounts(n)} in ${c}`))} ${other.reduce((s, [, n]) => s + n, 0) === 1 ? 'is' : 'are'} left out: without a home currency Nya doesn’t convert them (choose one on the Currency card in Settings, Preferences)`
    );
  }
  if (day.unrated.length > 0) parts.push(`${names(day.unrated.map((u) => `${accounts(u.accounts)} in ${u.currency}`))} had no exchange rate that day`);
  return parts.length > 0 ? `${parts.join('; ')}.` : null;
}

/** What the card says about progress, worked out from the saved plan and the
 *  recorded days; amounts through `money`. */
export function progressLines(saved: SavedPlan, answer: ProgressAnswer, nameOf: (id: string) => string, money: (n: number) => string) {
  const { anchor, latest } = answer;
  // The newest whole day: what is set against the plan.
  const whole = answer.months.length > 0 ? answer.months[answer.months.length - 1] : null;
  const latestShort = latest && !isComplete(latest) ? shortWhy(latest, nameOf) : null;
  if (!anchor || !whole) {
    return {
      start: null,
      compared: null,
      waiting: latest
        ? `Progress shows from the first day every account your plan counts is recorded whole. On ${dayName(latest.date)}, ${latestShort ?? 'not every account was recorded.'}`
        : 'Progress shows once Nya records your invested assets, at the next snapshot of your balances.',
      caution: null,
      added: null,
      ended: null,
    };
  }
  const start = `Started from ${money(anchor.total as number)}, recorded on ${dayName(anchor.date)}.`;
  const caution = latestShort && latest && latest.date > whole.date ? `${dayName(latest.date)} isn’t counted: ${latestShort}` : null;
  const added = answer.accounts.filter((a) => a.first !== null && a.first > anchor.date && a.last !== null && a.last >= whole.date);
  const addedLine =
    added.length > 0
      ? `${names(added.map((a) => nameOf(a.account_id)))} ${added.length === 1 ? 'was' : 'were'} first recorded after ${dayName(anchor.date)}, so what ${added.length === 1 ? 'it' : 'they'} held then counts as progress here.`
      : null;
  // Counted in the start and ended since: in one end and not the other.
  const ended = answer.accounts.filter((a) => a.ended !== null && a.ended > anchor.date && a.ended <= whole.date && a.first !== null && a.first <= anchor.date);
  const endedLine =
    ended.length > 0
      ? `${names(ended.map((a) => `${nameOf(a.account_id)} (on ${dayName(a.ended as string)})`))} ended since ${dayName(anchor.date)}: what ${ended.length === 1 ? 'it' : 'they'} held is in the start and not since, so it counts again only where it went to an account your plan counts.`
      : null;
  const rest = { caution, added: addedLine, ended: endedLine };
  if (yearsBetween(anchor.date, whole.date) * 365.25 < MIN_DAYS) {
    return { start, compared: null, waiting: `A month after that, Nya sets where you are against where your plan has you.`, ...rest };
  }
  const planned = plannedAt(saved, { day: anchor.date, total: anchor.total as number }, whole.date);
  if (planned === null) return { start, compared: null, waiting: 'Your plan’s growth can’t be worked out, so nothing is set against it.', ...rest };
  const diff = whole.total - planned;
  const verdict = Math.round(diff) === 0 ? 'Level with it.' : `${money(Math.abs(diff))} ${diff > 0 ? 'ahead of' : 'behind'} it.`;
  return {
    start,
    compared: { day: dayName(whole.date), actual: money(whole.total), planned: money(planned), verdict },
    waiting: null,
    ...rest,
  };
}

export type ProgressViewProps = {
  savedState: SavedState;
  series: SeriesState | null;
  /** The Plan as the tab shows it, for what changed since. */
  plan: FirePlan;
  /** Why a save can't happen now, or null. */
  blocked: string | null;
  /** A scenario is open: the save is not offered. */
  scenarioOpen: boolean;
  /** The savings a save would keep, as the Plan has them. */
  savings: Input;
  money: (n: number) => string;
  nameOf: (id: string) => string;
  busy: boolean;
  error: { text: string; kind: 'critical' | 'info' } | null;
  onSheet: (s: ProgressSheet) => void;
  onRetry: () => void;
};

/** Why savings can't be kept, or null. */
export function savingsBlock(savings: Input): string | null {
  if (savings.source === 'unmeasured') return 'Your annual savings aren’t measured, so there is no plan to keep yet: type them in Your figures.';
  if (savings.value === null) return 'Your plan needs your annual savings first: type them in Your figures.';
  return null;
}

export function ProgressView({ savedState, series, plan, blocked, scenarioOpen, savings, money, nameOf, busy, error, onSheet, onRetry }: ProgressViewProps) {
  const saved = savedState.kind === 'ready' ? savedState.saved : null;
  const why = blocked ?? savingsBlock(savings);
  const menu = saved ? [{ label: 'Stop comparing', danger: true, onSelect: () => onSheet('forget'), disabled: busy }] : [];
  return (
    <section className="card" aria-labelledby="plan-progress-title">
      <div className="card-header">
        <h3 id="plan-progress-title">Progress</h3>
        {menu.length > 0 && <Menu label="Progress options" items={menu} />}
      </div>
      <div className="stack">
        {error && <Notice level={error.kind}>{error.text}</Notice>}
        {savedState.kind === 'loading' && <p className="skeleton">Loading your saved plan</p>}
        {savedState.kind === 'failed' && (
          <>
            <Notice level="caution">{savedState.message ?? 'Your saved plan couldn’t be loaded.'}</Notice>
            <div className="btn-row">
              <button type="button" className="btn ghost" onClick={onRetry}>
                Try again
              </button>
            </div>
          </>
        )}
        {savedState.kind === 'ready' && savedState.problem === 'unreadable' && (
          <>
            <Notice level="critical">The plan you saved as your plan couldn’t be read, so nothing is set against it.</Notice>
            <div className="btn-row">
              <button type="button" className="btn secondary" disabled={busy} onClick={() => onSheet('forget-unreadable')}>
                Delete it
              </button>
            </div>
          </>
        )}
        {savedState.kind === 'ready' && savedState.problem === 'newer' && (
          <p className="notice info">The plan you saved as your plan was saved by a newer version of Nya, so it can’t be shown or changed here.</p>
        )}
        {savedState.kind === 'ready' && savedState.problem === null && saved === null && (
          <>
            <p className="helper">Say this is your plan, and Nya keeps its assumptions and sets your invested assets against them as they are recorded.</p>
            {scenarioOpen ? (
              <p className="helper">A scenario is open: go back to your plan to save it as your plan.</p>
            ) : (
              <>
                <div className="btn-row">
                  <button type="button" className="btn secondary" disabled={busy || why !== null} onClick={() => onSheet('save')}>
                    This is my plan
                  </button>
                </div>
                {why && <p className="helper">{why}</p>}
              </>
            )}
          </>
        )}
        {saved && <SavedBody saved={saved} series={series} money={money} nameOf={nameOf} onRetry={onRetry} />}
        {saved && changedSince(saved, plan).length > 0 && (
          <>
            <p className="notice info">
              Your Plan’s {names(changedSince(saved, plan))} changed since you saved it. This compares with the plan as you saved it.
            </p>
            {!scenarioOpen && (
              <>
                <div className="btn-row">
                  <button type="button" className="btn secondary" disabled={busy || why !== null} onClick={() => onSheet('resave')}>
                    Save the Plan as it is now
                  </button>
                </div>
                {why && <p className="helper">{why}</p>}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function SavedBody({
  saved,
  series,
  money,
  nameOf,
  onRetry,
}: {
  saved: SavedPlan;
  series: SeriesState | null;
  money: (n: number) => string;
  nameOf: (id: string) => string;
  onRetry: () => void;
}) {
  const flow = saved.savings < 0 ? `spending ${money(-saved.savings)} a year more than comes in` : `saving ${money(saved.savings)} a year`;
  const assumed = `Growing a steady ${pct(saved.plan.realReturn)} a year after inflation, ${flow}, with prices rising ${pct(saved.inflation)} a year.`;
  return (
    <>
      <p>Your plan from {dayName(saved.day)}.</p>
      {(series === null || series.kind === 'loading') && <p className="skeleton">Loading your invested assets since then</p>}
      {series?.kind === 'failed' && (
        <>
          <Notice level="caution">{series.message ?? 'Your invested assets since then couldn’t be loaded.'}</Notice>
          <div className="btn-row">
            <button type="button" className="btn ghost" onClick={onRetry}>
              Try again
            </button>
          </div>
        </>
      )}
      {series?.kind === 'ready' && <Compared saved={saved} answer={series.answer} money={money} nameOf={nameOf} />}
      <p className="helper">
        <Masked>{assumed}</Masked>
      </p>
      <p className="plan-definition">Hypothetical: a steady return and steady prices, not a prediction, and not advice.</p>
      <Why>
        <p>
          Your invested assets are added up from the balances recorded each day, by your plan’s rules as you saved it (investment accounts{saved.plan.includeCash ? ', and checking and savings' : ''}, hidden ones
          left out){saved.currency ? `, in ${saved.currency}` : ''}. Your plan starts from the first day every account it counts was recorded, grows that at its rate, adding its savings steadily through the year,
          and is raised by the inflation rate, since balances are in each day’s money and the plan in the dollars of the day it starts.
        </p>
      </Why>
    </>
  );
}

function Compared({ saved, answer, money, nameOf }: { saved: SavedPlan; answer: ProgressAnswer; money: (n: number) => string; nameOf: (id: string) => string }) {
  const l = progressLines(saved, answer, nameOf, money);
  return (
    <>
      {l.start && (
        <p>
          <Masked>{l.start}</Masked>
        </p>
      )}
      {l.compared && (
        <div className="txn-detail">
          <div className="txn-detail-row">
            <span>
              <Masked>{`Invested on ${l.compared.day}`}</Masked>
            </span>
            <span className="money">
              <Masked>{l.compared.actual}</Masked>
            </span>
          </div>
          <div className="txn-detail-row">
            <span>Where your plan has you</span>
            <span className="money">
              <Masked>{l.compared.planned}</Masked>
            </span>
          </div>
        </div>
      )}
      {l.compared && (
        <p>
          <Masked>{l.compared.verdict}</Masked>
        </p>
      )}
      {l.waiting && <p className="helper">{l.waiting}</p>}
      {l.caution && <Notice level="caution">{l.caution}</Notice>}
      {l.added && <Notice level="caution">{l.added}</Notice>}
      {l.ended && <Notice level="caution">{l.ended}</Notice>}
      {answer.unreadable_days.length > 0 && (
        <Notice level="caution">
          The balances of {answer.unreadable_days.length === 1 ? `${dayName(answer.unreadable_days[0])} couldn’t be read, so that day is` : `${answer.unreadable_days.length} days couldn’t be read, so they are`} left out.
        </Notice>
      )}
    </>
  );
}

/** The inflation field as typed, as a fraction, or why not. */
export function readInflation(typed: string): number | string {
  const t = typed.trim().replace(/%$/, '').trim();
  const n = Number(t);
  if (t === '' || !Number.isFinite(n) || n < 0 || n > MAX_INFLATION * 100) return `Inflation is from 0% to ${MAX_INFLATION * 100}% a year.`;
  return Math.round(n * 100) / 10_000;
}

/** The lines before today on Your path's chart (components/PlanPathChart.tsx):
 *  invested assets as recorded since the start, and where the saved plan had
 *  them on the same days, by age. */
export type ProgressOverlay = {
  /** The start's day. */
  from: string;
  /** The saved plan's own day. */
  savedDay: string;
  recorded: PathPoint[];
  planned: PathPoint[];
  /** The same points' days, for the table. */
  days: string[];
};

/** The chart's lines before today, from the same answer the card reads: the
 *  start and the last whole day of each month after it, each set at the age
 *  it was (today's `age` less the years since), with where the plan had you
 *  then (plannedAt). Null with no start, fewer than two such days, or less
 *  than MIN_DAYS between them, as the card sets nothing against the plan
 *  before then. Both in each day's own money, as balances are, which today's
 *  dollars are on today. */
export function progressOverlay(saved: SavedPlan, answer: ProgressAnswer, age: number, today: string): ProgressOverlay | null {
  const { anchor } = answer;
  if (!anchor || anchor.total === null) return null;
  const start = { day: anchor.date, total: anchor.total };
  const days = [start, ...answer.months.filter((m) => m.date > anchor.date).map((m) => ({ day: m.date, total: m.total }))].filter((d) => d.day <= today);
  if (days.length < 2 || yearsBetween(start.day, days[days.length - 1].day) * YEAR_DAYS < MIN_DAYS) return null;
  const ageOn = (day: string) => age - yearsBetween(day, today);
  const recorded: PathPoint[] = [];
  const planned: PathPoint[] = [];
  for (const d of days) {
    const p = plannedAt(saved, start, d.day);
    if (p === null) return null;
    recorded.push({ age: ageOn(d.day), balance: d.total });
    planned.push({ age: ageOn(d.day), balance: p });
  }
  return { from: anchor.date, savedDay: saved.day, recorded, planned, days: days.map((d) => d.day) };
}

async function json(res: Response): Promise<any> {
  return res.json().catch(() => null);
}

/** The saved plan and the days recorded since, read once for the card and
 *  the chart. */
export type Progress = {
  savedState: SavedState;
  series: SeriesState | null;
  setSaved: (s: SavedState) => void;
  setSeries: (s: SeriesState | null) => void;
  retry: () => void;
};

export function useProgress(institutions: AssetInstitution[]): Progress {
  const [savedState, setSaved] = useState<SavedState>({ kind: 'loading' });
  const [series, setSeries] = useState<SeriesState | null>(null);
  const [attempt, setAttempt] = useState(0);
  const saved = savedState.kind === 'ready' ? savedState.saved : null;

  useEffect(() => {
    let live = true;
    fetch('/api/saved-plan')
      .then(async (res) => {
        const body = await json(res);
        if (!live) return;
        if (res.ok && body && 'saved' in body) setSaved({ kind: 'ready', saved: body.saved, problem: body.problem ?? null });
        else setSaved({ kind: 'failed', message: typeof body?.error === 'string' ? body.error : null });
      })
      .catch(() => live && setSaved({ kind: 'failed', message: null }));
    return () => {
      live = false;
    };
  }, [attempt]);

  // The question as text, so the same accounts ask nothing new.
  const question = useMemo(() => JSON.stringify({ accounts: progressAccountsOf(institutions) }), [institutions]);
  const rev = saved?.rev ?? null;
  useEffect(() => {
    if (rev === null) return;
    let live = true;
    setSeries({ kind: 'loading' });
    fetch('/api/invested-history', { method: 'POST', headers: { 'content-type': 'application/json' }, body: question })
      .then(async (res) => {
        const body = await json(res);
        if (!live) return;
        if (res.ok && body && Array.isArray(body.months)) setSeries({ kind: 'ready', answer: body as ProgressAnswer });
        else setSeries({ kind: 'failed', message: typeof body?.error === 'string' ? body.error : null });
      })
      .catch(() => live && setSeries({ kind: 'failed', message: null }));
    return () => {
      live = false;
    };
  }, [rev, question, attempt]);
  return { savedState, series, setSaved, setSeries, retry: () => setAttempt((n) => n + 1) };
}

export type PlanProgressProps = {
  progress: Progress;
  plan: FirePlan;
  savings: Input;
  /** The Plan's currency, which a save keeps. */
  currency: string | null;
  institutions: AssetInstitution[];
  blocked: string | null;
  scenarioOpen: boolean;
};

export default function PlanProgress({ progress, plan, savings, currency, institutions, blocked, scenarioOpen }: PlanProgressProps) {
  const { savedState, series, setSaved, setSeries, retry } = progress;
  const [sheet, setSheet] = useState<ProgressSheet>(null);
  const [inflation, setInflation] = useState(String(DEFAULT_INFLATION * 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; kind: 'critical' | 'info' } | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const saved = savedState.kind === 'ready' ? savedState.saved : null;

  const nameOf = useMemo(() => {
    const known = new Map<string, string>();
    for (const i of institutions) {
      for (const a of i.accounts) known.set(a.account_id, `${a.name} at ${i.name}`);
      for (const a of i.unshown ?? []) known.set(a.account_id, `${a.name} at ${i.name}`);
    }
    const labels = new Map(series?.kind === 'ready' ? series.answer.accounts.map((a) => [a.account_id, a.label]) : []);
    return (id: string) => known.get(id) ?? labels.get(id) ?? 'an account no longer linked';
  }, [institutions, series]);
  const moneyIn = saved?.currency ?? currency;
  const money = (n: number) => wholeMoney(n, moneyIn);

  const open = (s: ProgressSheet) => {
    setSheetError(null);
    if (s === 'save' || s === 'resave') setInflation(String(Math.round((saved?.inflation ?? DEFAULT_INFLATION) * 10_000) / 100));
    setSheet(s);
  };
  const close = () => {
    if (!busy) setSheet(null);
  };
  /** A 409: the one there now, handed back (shown, with why), or one that
   *  can't be read (offered for deletion), or one a newer version saved. */
  const stale = (body: any) => {
    const text = typeof body?.error === 'string' ? body.error : 'That didn’t go through: try again.';
    if (body?.stale) {
      setSaved({ kind: 'ready', saved: body.saved ?? null, problem: null });
      setError({ text, kind: 'info' });
    } else if (body?.unreadable) {
      setSaved({ kind: 'ready', saved: null, problem: 'unreadable' });
      setError(null);
    } else setError({ text, kind: 'critical' });
    setSeries(null);
    setSheet(null);
  };

  const save = async () => {
    const rate = readInflation(inflation);
    if (typeof rate === 'string') return setSheetError(rate);
    const why = blocked ?? savingsBlock(savings);
    if (why) return setSheetError(why);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/saved-plan', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ saved: { plan, savings: savings.value, currency, inflation: rate }, based_on: saved?.rev ?? null }),
      });
      const body = await json(res);
      if (res.ok && body?.saved) {
        // The days recorded since the one replaced are not this one's.
        setSeries(null);
        setSaved({ kind: 'ready', saved: body.saved, problem: null });
        setSheet(null);
      } else if (res.status === 409) stale(body);
      else setSheetError(typeof body?.error === 'string' ? body.error : 'Your plan wasn’t saved: try again.');
    } catch {
      setSheetError('Your plan wasn’t saved: check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const forget = async (unreadable: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/saved-plan', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(unreadable ? { unreadable: true } : { based_on: saved?.rev }),
      });
      const body = await json(res);
      if (res.ok) {
        setSaved({ kind: 'ready', saved: null, problem: null });
        setSeries(null);
        setSheet(null);
      } else if (res.status === 409) stale(body);
      else setSheetError(typeof body?.error === 'string' ? body.error : 'Nothing was deleted: try again.');
    } catch {
      setSheetError('Nothing was deleted: check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const saving = sheet === 'save' || sheet === 'resave';
  return (
    <>
      <ProgressView
        savedState={savedState}
        series={series}
        plan={plan}
        blocked={blocked}
        scenarioOpen={scenarioOpen}
        savings={savings}
        money={money}
        nameOf={nameOf}
        busy={busy}
        error={error}
        onSheet={open}
        onRetry={retry}
      />
      <Sheet
        open={sheet !== null}
        title={sheet === 'resave' ? 'Save the Plan as it is now' : sheet === 'save' ? 'This is my plan' : sheet === 'forget' ? 'Stop comparing' : 'Delete the saved plan'}
        onClose={close}
        footer={
          <div className="btn-row">
            {saving ? (
              <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
                Save
              </button>
            ) : (
              <button type="button" className="btn danger" disabled={busy} onClick={() => void forget(sheet === 'forget-unreadable')}>
                {sheet === 'forget' ? 'Stop comparing' : 'Delete it'}
              </button>
            )}
            <button type="button" className="btn secondary" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        }
      >
        <SheetBody sheet={sheet} saved={saved} savings={savings.value} money={money} inflation={inflation} onInflation={setInflation} error={sheetError} />
      </Sheet>
    </>
  );
}

export function SheetBody({
  sheet,
  saved,
  savings,
  money,
  inflation,
  onInflation,
  error,
}: {
  sheet: ProgressSheet;
  saved: SavedPlan | null;
  /** The savings a save would keep. */
  savings: number | null;
  money: (n: number) => string;
  inflation: string;
  onInflation: (s: string) => void;
  error: string | null;
}) {
  if (sheet === 'save' || sheet === 'resave') {
    const savingsText = savings !== null ? money(savings) : null;
    return (
      <div className="sheet-form">
        <p>
          <Masked>{`Nya keeps your Plan’s assumptions as they are now${savingsText ? `, and the ${savingsText} a year of savings it uses,` : ''} and sets your invested assets against them from today. Nothing worked out from them is kept.`}</Masked>
        </p>
        {sheet === 'resave' && saved && <p>This replaces the plan you saved on {dayName(saved.day)}, and the comparison starts again from today.</p>}
        <label className="field">
          <span>Inflation a year, %</span>
          <input type="text" inputMode="decimal" placeholder="3" value={inflation} onChange={(e) => onInflation(e.target.value)} />
        </label>
        <p className="helper">Balances are in each day’s money and your plan in today’s, so your plan is raised by this much a year to compare them.</p>
        {error && <Notice level="critical">{error}</Notice>}
      </div>
    );
  }
  if (sheet === 'forget') {
    return (
      <div className="stack">
        <p>Nya forgets the plan you saved{saved ? ` on ${dayName(saved.day)}` : ''}. Your Plan and its figures stay as they are. This can’t be undone.</p>
        {error && <Notice level="critical">{error}</Notice>}
      </div>
    );
  }
  if (sheet === 'forget-unreadable') {
    return (
      <div className="stack">
        <p>The saved plan that couldn’t be read is deleted. Your Plan and its figures stay as they are. This can’t be undone.</p>
        {error && <Notice level="critical">{error}</Notice>}
      </div>
    );
  }
  return null;
}
