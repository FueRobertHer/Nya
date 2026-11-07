'use client';

// Tune to a goal (the tax plan's D4), a sheet from Compare conversions: the person picks
// a goal and any limits, Nya works out each rule's settings, and each rule's row says what
// its setting comes to. Nothing is chosen for them: no goal is checked, the table opens in
// Compare's order, and it sorts by the goal only when they ask. Nothing is stored here but
// the rule they then use. Words in components/plan-tune.ts; the search in lib/fire/tune.ts.
//
// The table holds the plan's stop and start where they are, so its rows compare like with
// like. A row's own sheet runs the plan as it would be with that rule, and says what moved.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { Drawdown } from '@/lib/fire/drawdown';
import type { Strategy } from '@/lib/fire/tax/rules';
import type { TuneJob } from '@/lib/fire/tune-job';
import { crossesOf, crossingOf, tunedRows, tuneUntil, type TuneAsk, type TunedRow, type TuneGoal, type TuneLimit } from '@/lib/fire/tune';
import CheckRows from './CheckRows';
import { Masked } from './HideAmounts';
import { endAgeOf, endWords } from './plan-conversions';
import { RuleFigures, SortHeading, sortedRows, type ColumnSort } from './PlanHowYouDraw';
import { useDetailSave, type DetailForm, type SaveProps } from './PlanForms';
import { planTune } from './plan-search';
import {
  comesToTheSame,
  goalName,
  hasThisRule,
  LIMIT_NAMES,
  movedLine,
  orderLine,
  ownLine,
  tapLine,
  TUNE_BUSY,
  TUNE_FAILED,
  TUNE_GOAL_LEGEND,
  TUNE_GONE,
  TUNE_HELPER,
  TUNE_HOLDS,
  TUNE_IRMAA_UNKNOWN,
  TUNE_LIMITS_LEGEND,
  TUNE_ONLY_ORDER,
  TUNE_SORT,
  TUNE_SORTED,
  tunedFor,
  tunedHeading,
  tunedName,
  tunedNote,
  useLabel,
  usedFailed,
} from './plan-tune';
import RadioRows from './RadioRows';
import { Notice } from './TotalCaveats';

type Money = (n: number) => string;

/** What the plan comes to with a setting in it: its own figures, not the table's. */
export type TuneUsed = { drawn: Drawdown | null; stop: number | null; start: number | null; working: boolean; failed: boolean };

/** The figures the plan shown has now. */
export type TuneNow = { drawn: Drawdown; stop: number | null; start: number | null };

type Shared = SaveProps & {
  detail: DetailForm;
  money: Money;
  lawYear: number;
  healthGrowth: number;
  copyOpen: boolean;
  /** Why no copy can be made yet; null when one can. */
  whyNot: string | null;
  now: TuneNow | null;
  used: (strategy: Strategy) => TuneUsed;
  onTry: (strategy: Strategy) => Promise<true | string>;
};

const sameAsk = (a: TuneAsk | null, b: TuneAsk | null) => JSON.stringify(a) === JSON.stringify(b);

/** The sheet's body, which alone scrolls: never scrollIntoView, which moves the page behind. */
function sheetBody(el: Element | null): Element | null {
  let body = el?.parentElement ?? null;
  while (body && !(body.getAttribute('class') ?? '').split(' ').includes('sheet-body')) body = body.parentElement;
  return body;
}

export function TuneForm({
  job,
  offers,
  irmaaUnknown,
  held,
  level,
  onLevel,
  ...shared
}: Shared & {
  /** Null while this plan can't be run. */
  job: TuneJob | null;
  /** The limits that can mean anything on this plan. */
  offers: Record<'aca' | 'irmaa', boolean>;
  irmaaUnknown: boolean;
  /** A job is working out this plan's date: a row opens nothing yet. */
  held: boolean;
  /** The row whose own sheet is open, in the drawer's second level. */
  level: TunedRow | null;
  onLevel: (row: TunedRow | null) => void;
}) {
  const { money, lawYear, healthGrowth, copyOpen, now } = shared;
  const [goal, setGoal] = useState<TuneGoal | ''>('');
  const [limits, setLimits] = useState<TuneLimit[]>([]);
  const [asked, setAsked] = useState<TuneAsk | null>(null);
  const [sort, setSort] = useState<ColumnSort | null>(null);
  const tune = planTune();
  useSyncExternalStore(tune.subscribe, tune.version, tune.version);
  useEffect(() => () => tune.drop('tune'), [tune]);

  const choices: TuneAsk | null = goal === '' ? null : { goal, limits };
  // What is on show was asked of these choices: a table is never read under a goal it
  // wasn't tuned for. A level shows none, so its Use, which moves the plan and so this job,
  // asks for no other on the way out, and Back finds this one kept.
  const showing = asked !== null && sameAsk(asked, choices) ? asked : null;
  const result = showing && job && !level ? tune.answer('tune', job) : null;
  const own = job?.detailed.strategy ?? null;
  const until = job ? tuneUntil({ plan: job.plan }, job.detailed) : null;
  const rows = useMemo(() => (showing && result?.ok && own && until !== null ? tunedRows(result.runs, showing, own, until) : []), [showing, result, own, until]);
  const busy = showing !== null && job !== null && result === null;
  const failed = result !== null && !result.ok;
  const endAge = now ? endAgeOf(now.drawn) : null;

  // After a tap on Tune, and only then, the answer takes focus: a table that comes back
  // when the plan moves leaves focus where it is.
  const answer = useRef<HTMLElement | null>(null);
  const tapped = useRef(false);
  useEffect(() => {
    if (!tapped.current || rows.length === 0) return;
    tapped.current = false;
    const el = answer.current;
    const body = sheetBody(el);
    el?.focus({ preventScroll: true });
    if (el && body) body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top;
  }, [rows]);

  // A level starts at its top, and Back returns to where the table was.
  const wrap = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(0);
  const opened = level !== null;
  useEffect(() => {
    const body = sheetBody(wrap.current);
    if (body) body.scrollTop = opened ? 0 : scrolled.current;
  }, [opened]);

  if (level && asked) {
    return (
      <div ref={wrap}>
        <TuneLevel key={level.key} {...shared} money={money} row={level} ask={asked} />
      </div>
    );
  }

  const offered: TuneLimit[] = [...(offers.aca ? (['aca'] as const) : []), ...(offers.irmaa ? (['irmaa'] as const) : []), 'bracket-22'];
  return (
    <div className="stack loose" ref={wrap}>
      <p className="helper">{TUNE_HELPER}</p>
      <RadioRows legend={TUNE_GOAL_LEGEND} name="plan-tune-goal" value={goal} onChange={(v) => setGoal(v as TuneGoal)} options={(['left', 'cost'] as const).map((g) => ({ value: g, name: goalName(g, endAge) }))} />
      <CheckRows legend={TUNE_LIMITS_LEGEND} rows={offered.map((key) => ({ key, title: LIMIT_NAMES[key] }))} checked={limits} onChange={(keys) => setLimits(keys as TuneLimit[])} />
      {irmaaUnknown && limits.includes('irmaa') && <p className="helper">{TUNE_IRMAA_UNKNOWN}</p>}
      {job === null && <p className="helper">{TUNE_GONE}</p>}
      <button
        type="button"
        className="btn btn-block"
        disabled={choices === null || job === null || busy}
        onClick={() => {
          tapped.current = true;
          setSort(null);
          setAsked(choices);
        }}
      >
        {busy ? TUNE_BUSY : 'Tune'}
      </button>
      {failed && (
        <div className="stack tight">
          <Notice level="critical" role="alert">
            {TUNE_FAILED}
          </Notice>
          <div>
            <button type="button" className="btn secondary" onClick={() => tune.retry()}>
              Try again
            </button>
          </div>
        </div>
      )}
      {showing && rows.length > 0 && own && until !== null && (
        <TunedAnswer
          sectionRef={answer}
          ask={showing}
          rows={rows}
          own={own}
          until={until}
          now={now}
          sort={sort}
          onSort={setSort}
          held={held}
          onRow={(r) => {
            scrolled.current = sheetBody(wrap.current)?.scrollTop ?? 0;
            onLevel(r);
          }}
          money={money}
          lawYear={lawYear}
          healthGrowth={healthGrowth}
          copyOpen={copyOpen}
        />
      )}
    </div>
  );
}

/** The answer: each rule's row, in Compare's order until the person sorts it, and what
 *  is true of them all. */
export function TunedAnswer({
  sectionRef,
  ask,
  rows,
  own,
  until,
  now,
  sort,
  onSort,
  held,
  onRow,
  money,
  lawYear,
  healthGrowth,
  copyOpen,
}: {
  sectionRef?: RefObject<HTMLElement | null>;
  ask: TuneAsk;
  rows: readonly TunedRow[];
  own: Strategy;
  until: number;
  now: TuneNow | null;
  sort: ColumnSort | null;
  onSort: (sort: ColumnSort | null) => void;
  /** A job is working out this plan's date: a row opens nothing yet. */
  held: boolean;
  onRow: (row: TunedRow) => void;
  money: Money;
  lawYear: number;
  healthGrowth: number;
  copyOpen: boolean;
}) {
  const endAge = now ? endAgeOf(now.drawn) : null;
  const first = now?.drawn.years[0]?.age ?? null;
  const goalDir = ask.goal === 'left' ? 'descending' : 'ascending';
  const sortedByGoal = sort !== null && sort.column === ask.goal && sort.dir === goalDir;
  return (
    <section className="stack" ref={sectionRef} tabIndex={-1} aria-labelledby="plan-tune-answer">
      <h3 className="section-label" id="plan-tune-answer">
        {tunedHeading(ask.goal, endAge)}
      </h3>
      {sortedByGoal ? (
        <p className="helper">{TUNE_SORTED}</p>
      ) : (
        <div>
          {/* This button goes once it is used, so focus moves first, not to nothing. */}
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              sectionRef?.current?.focus({ preventScroll: true });
              onSort({ column: ask.goal, dir: goalDir });
            }}
          >
            {TUNE_SORT}
          </button>
        </div>
      )}
      <div className="plan-table-scroll">
        <table className="plan-compare-table plan-rules-table">
          <caption className="visually-hidden">{tunedHeading(ask.goal, endAge)}</caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <SortHeading column="left" label={endAge === null ? 'Left, after tax' : `Left at ${endAge}, after tax`} sort={sort} onSort={onSort} />
              <SortHeading column="cost" label="Tax and health" sort={sort} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {sortedRows(rows, sort, (r) => ({ left: r.run.left, cost: r.run.cost, short: r.run.short })).map((r) => {
              const note = tunedNote(r, own, ask.goal);
              return (
                <tr key={r.key}>
                  <th scope="row">
                    <button type="button" className="th-sort" aria-disabled={held ? 'true' : undefined} onClick={() => !held && onRow(r)}>
                      <Masked>{tunedName(r.run.strategy, first, money)}</Masked>
                    </button>
                    {note && <div className="list-row-sub">{note}</div>}
                    {r.mine && <span className="badge accent">{copyOpen ? 'This copy' : 'Your plan'}</span>}
                  </th>
                  <td className="money">
                    <Masked>{endWords({ runsOutAt: r.run.short, leftAtEnd: r.run.left }, money)}</Masked>
                  </td>
                  <td className="money">
                    <Masked>{money(r.run.cost)}</Masked>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(rows.length === 1 || (first !== null && first > until)) && <p className="helper">{TUNE_ONLY_ORDER}</p>}
      {now && (
        <p className="helper">
          <Masked>{ownLine({ goal: ask.goal, own, until, left: now.drawn.leftAtEnd, cost: now.drawn.taxAndHealth, short: now.drawn.runsOutAt, copyOpen }, money)}</Masked>
        </p>
      )}
      <p className="helper">{tapLine(copyOpen)}</p>
      <p className="helper">{TUNE_HOLDS}</p>
      <p className="plan-definition">{tunedFor(lawYear, healthGrowth)}</p>
    </section>
  );
}

/** A row's own sheet: the plan as it would be with this setting, what that moves, and the
 *  two ways to take it. */
export function TuneLevel({ row, ask, money, lawYear, healthGrowth, copyOpen, whyNot, now, used, onTry, ...save }: Shared & { row: TunedRow; ask: TuneAsk }) {
  const { detail, plan } = save;
  const strategy = row.run.strategy;
  const { s, more } = useDetailSave(save, detail);
  const [trying, setTrying] = useState(false);
  const [tryError, setTryError] = useState<string | null>(null);
  const answer = used(strategy);
  const drawn = answer.drawn;
  const ready = !answer.working && !answer.failed && drawn !== null;
  const own = detail.choices.strategy;
  const same = ready && !row.mine && now !== null && Math.abs(drawn.leftAtEnd - now.drawn.leftAtEnd) < 1 && Math.abs(drawn.taxAndHealth - now.drawn.taxAndHealth) < 1 && drawn.runsOutAt === now.drawn.runsOutAt;
  const moved = (a: number | null, b: number | null): [number, number] | null => (a !== null && b !== null && Math.abs(a - b) >= 1 ? [a, b] : null);
  const stopMoved = now ? moved(now.stop, answer.stop) : null;
  const startMoved = now ? moved(now.start, answer.start) : null;
  const differs = ready && (Math.abs(drawn.leftAtEnd - row.run.left) >= 1 || Math.abs(drawn.taxAndHealth - row.run.cost) >= 1 || drawn.runsOutAt !== row.run.short || stopMoved !== null || startMoved !== null);
  // What it crosses is of the figures on show, which a move leaves out of the row's. How
  // it stands to None is the table's, so it is said only where these are the row's. Its
  // order has a line of its own here.
  const rowShown = drawn === null || answer.failed;
  const note = tunedNote({ run: row.run, crossing: rowShown ? row.crossing : crossingOf(crossesOf(drawn), ask.limits), beatsNone: rowShown || (ready && !differs) ? row.beatsNone : null }, strategy, ask.goal);
  const busy = s.saving || trying;
  const build = () => {
    more.current = { tax: { ...detail.choices, strategy } };
    return plan;
  };
  return (
    <div className="stack loose">
      <div className={answer.working ? 'stack loose plan-answer-pending' : 'stack loose'} aria-busy={answer.working || undefined}>
        {answer.working && (
          <p className="plan-working-line" role="status">
            Working it out
          </p>
        )}
        {drawn && !answer.failed ? (
          <RuleFigures drawn={drawn} money={money} />
        ) : (
          <dl className="txn-detail txn-detail-wide">
            <div className="txn-detail-row">
              <dt>Left, after tax</dt>
              <dd className="money">
                <Masked>{endWords({ runsOutAt: row.run.short, leftAtEnd: row.run.left }, money)}</Masked>
              </dd>
            </div>
            <div className="txn-detail-row">
              <dt>Tax and health costs, in all</dt>
              <dd className="money">
                <Masked>{money(row.run.cost)}</Masked>
              </dd>
            </div>
          </dl>
        )}
      </div>
      {strategy.order !== own.order && <p className="helper">{orderLine(strategy.order, own.order, copyOpen)}</p>}
      {note && <p className="helper">{note}</p>}
      {answer.failed && <p className="helper">{usedFailed(copyOpen)}</p>}
      {differs && !same && (
        <p className="helper">
          <Masked>{movedLine({ stop: stopMoved, start: startMoved, copyOpen }, money)}</Masked>
        </p>
      )}
      <p className="plan-definition">{tunedFor(lawYear, healthGrowth)}</p>
      {row.mine ? (
        <p className="helper">{hasThisRule(copyOpen)}</p>
      ) : same ? (
        <p className="helper">{comesToTheSame(copyOpen)}</p>
      ) : (
        !answer.failed && (
          <div className="stack tight">
            {save.paused && <p className="helper plan-paused">{save.paused}</p>}
            {!save.paused && !busy && whyNot && <p className="helper plan-paused">{whyNot}</p>}
            {s.error && (
              <Notice level="critical" role="alert">
                {s.error}
              </Notice>
            )}
            {tryError && (
              <Notice level="critical" role="alert">
                {tryError}
              </Notice>
            )}
            <div className="btn-row">
              <button
                type="button"
                className="btn secondary"
                disabled={busy || !ready || whyNot !== null}
                onClick={async () => {
                  setTrying(true);
                  setTryError(null);
                  const r = await onTry(strategy);
                  setTrying(false);
                  if (r !== true) setTryError(r);
                }}
              >
                {trying ? 'Saving…' : 'Try it in a copy'}
              </button>
              <button type="button" className="btn" disabled={busy || !ready || s.disabled} onClick={() => s.save(build)}>
                {s.saving ? 'Saving…' : useLabel(copyOpen)}
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}
