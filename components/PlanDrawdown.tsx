'use client';

// Year by year (the tax plan's T3): a detailed plan's years at a steady growth, on
// Drawdown under Will it last?. A card with the balances by bucket and the stages; a
// stage's sheet holds its years, and a year's sheet, a level over it, how it was
// worked out. Words in components/plan-drawdown.ts.

import { useState } from 'react';
import type { DrawdownStage, DrawdownYear } from '@/lib/fire/drawdown';
import type { PlanDetail } from '@/lib/fire/plan-detail';
import { spoken } from '@/lib/format';
import { Masked } from './HideAmounts';
import { Notice } from './TotalCaveats';
import { Why } from './Why';
import DrawdownChart, { type DrawdownMark } from './DrawdownChart';
import { detailLines, lawLabel, runSub, runTax, runTitle, stageFoot, stageHelper, stageSentence, stageSources, stageTitle, survivorLine, yearBadges, yearHelper, yearRuns, yearSections, yearSub, yearValueLabel, type YearContext, type YearSection } from './plan-drawdown';
import { pct } from './plan-text';

type Money = (n: number) => string;

const CHEVRON = (
  <svg className="section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

/** The chart's marks, for your own ages: the rest are in the stages and the table. */
export function drawdownMarks(years: readonly DrawdownYear[], rmdAge: number): DrawdownMark[] {
  const marks: DrawdownMark[] = [
    { age: 59.5, label: '59½', short: '59½' },
    { age: 65, label: '65', short: '65' },
  ];
  const paid = years.find((y) => y.income.socialSecurity >= 0.5);
  if (paid) marks.push({ age: paid.age, label: `Social Security ${paid.age}`, short: `${paid.age}` });
  marks.push({ age: rmdAge, label: `RMD age ${rmdAge}`, short: `${rmdAge}` });
  return marks.sort((a, b) => a.age - b.age);
}

export function DrawdownCard({
  detail,
  realReturn,
  money,
  rmdAge,
  joint,
  held = false,
  working = false,
  onStage,
  stageRef,
  titleRef,
}: {
  detail: PlanDetail;
  realReturn: number;
  money: Money;
  rmdAge: number;
  /** Two people on one return, for the survivor's line. */
  joint: boolean;
  /** The plan is being read again: the rows open nothing meanwhile. */
  held?: boolean;
  /** A job is working out this plan's date: these are the last years found. */
  working?: boolean;
  onStage: (at: number) => void;
  stageRef?: (at: number, el: HTMLButtonElement | null) => void;
  titleRef?: (el: HTMLHeadingElement | null) => void;
}) {
  const { start } = detail;
  const last = start.years[start.years.length - 1];
  const endAge = last ? last.age + 1 : null;
  return (
    <section className={working ? 'card plan-answer-pending' : 'card'} aria-labelledby="plan-years-title" aria-busy={working || undefined}>
      <div className="card-header">
        <h3 id="plan-years-title" ref={titleRef} tabIndex={-1}>
          Year by year, at a steady {pct(realReturn)}
        </h3>
      </div>
      {working && (
        <p className="plan-working-line" role="status">
          Working it out
        </p>
      )}
      <DrawdownChart years={start.years} marks={drawdownMarks(start.years, rmdAge)} money={money} />
      <ul className="list-rows">
        {start.stages.map((s, i) => (
          <li key={s.key}>
            <button
              ref={stageRef ? (el) => stageRef(i, el) : undefined}
              type="button"
              className="list-row"
              aria-haspopup="dialog"
              aria-disabled={held ? 'true' : undefined}
              onClick={() => {
                if (!held) onStage(i);
              }}
            >
              <span className="list-row-text">
                <span className="list-row-title">{stageTitle(s)}</span>
                <span className="list-row-sub">
                  <Masked>{stageSources(s, start.years, money)}</Masked>
                </span>
              </span>
              <span className="list-row-value money plan-input-value">
                <span>
                  <Masked>{money(s.yearlyTax)}</Masked>
                </span>
                <span className="plan-input-line">tax a year</span>
              </span>
              {CHEVRON}
            </button>
          </li>
        ))}
      </ul>
      {endAge !== null && (
        <p className="helper">
          {start.runsOutAt !== null ? `On this steady path your invested assets run out at ${start.runsOutAt}` : (
            <>
              Left at {endAge}: <Masked>{money(start.leftAtEnd)}</Masked> after tax
            </>
          )}{' '}
          · tax and health costs <Masked>{money(start.taxAndHealth)}</Masked> in all
        </p>
      )}
      {detailLines(detail).map((l) => (
        <p key={l} className="helper">
          {l}
        </p>
      ))}
      {joint && endAge !== null && <p className="helper">{survivorLine(endAge)}</p>}
      <p className="plan-definition">{lawLabel(detail.law.year)}</p>
    </section>
  );
}

/** Where what the years rest on is set, under How you draw and Compare conversions. */
export function DrawdownMore({ onGoPath }: { onGoPath: () => void }) {
  return (
    <div className="stack tight">
      <p className="helper">Health coverage is set on Your path, and income, costs and life choices on its Timeline. The stages above show where each lands.</p>
      <div>
        <button type="button" className="btn ghost" onClick={onGoPath}>
          Go to Your path
        </button>
      </div>
    </div>
  );
}

/** One year's row in a stage's sheet. */
function YearRow({ y, money, onOpen }: { y: DrawdownYear; money: Money; onOpen: () => void }) {
  const badges = yearBadges(y, money);
  return (
    <li>
      <button type="button" className="list-row" onClick={onOpen}>
        <span className="list-row-text">
          <span className="list-row-title">{`${y.age} · ${y.calendarYear}`}</span>
          <span className="list-row-sub">{yearSub(y)}</span>
          {badges.length > 0 && (
            <span className="row-badges">
              {badges.map((b) => (
                <span key={b} className="badge">
                  <Masked>{b}</Masked>
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="list-row-value money plan-input-value">
          <span>
            <Masked>{money(y.tax)}</Masked>
          </span>
          <span className="plan-input-line">{yearValueLabel(y)}</span>
        </span>
        {CHEVRON}
      </button>
    </li>
  );
}

/** A stage's sheet: what it is, its years as rows, each opening its own sheet. Years
 *  that read the same are one row, which opens to them in place. */
export function StageLevel({ stage, years, money, rmdAge, cautions = [], onYear }: { stage: DrawdownStage; years: readonly DrawdownYear[]; money: Money; rmdAge: number; cautions?: readonly string[]; onYear: (index: number) => void }) {
  const sentence = stageSentence(stage, years, money);
  const foot = stageFoot(stage, years);
  const rows = years.slice(stage.first, stage.last);
  const [openRuns, setOpenRuns] = useState<readonly number[]>([]);
  return (
    <div className="stack loose">
      <p className="helper">{stageHelper(stage, rmdAge)}</p>
      {sentence && (
        <p className="panel-note">
          <Masked>{sentence}</Masked>
        </p>
      )}
      {cautions.map((c) => (
        <Notice key={c} level="caution">
          <Masked>{c}</Masked>
        </Notice>
      ))}
      <ul className="list-rows">
        {yearRuns(rows).flatMap((r) => {
          const span = rows.slice(r.first, r.last);
          const one = (y: DrawdownYear, i: number) => <YearRow key={y.age} y={y} money={money} onOpen={() => onYear(stage.first + i)} />;
          if (span.length === 1) return [one(span[0], r.first)];
          const opened = openRuns.includes(r.first);
          const badges = yearBadges(span[0], money);
          return [
            <li key={`run-${r.first}`}>
              <button type="button" className="list-row" aria-expanded={opened} onClick={() => setOpenRuns(opened ? openRuns.filter((x) => x !== r.first) : [...openRuns, r.first])}>
                <span className="list-row-text">
                  <span className="list-row-title">{runTitle(span)}</span>
                  <span className="list-row-sub">{runSub(span)}</span>
                  {badges.length > 0 && (
                    <span className="row-badges">
                      {badges.map((b) => (
                        <span key={b} className="badge">
                          <Masked>{b}</Masked>
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="list-row-value money plan-input-value">
                  <span>
                    <Masked>{runTax(span, money)}</Masked>
                  </span>
                  <span className="plan-input-line">{yearValueLabel(span[0])} a year</span>
                </span>
                <svg className={`section-chevron${opened ? ' open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </li>,
            ...(opened ? span.map((y, i) => one(y, r.first + i)) : []),
          ];
        })}
      </ul>
      {foot && <p className="helper">{foot}</p>}
      {stage.key === 'before-60' && (
        <Why label="Why does 59 count as before 59½?">
          <p>Nya knows your age in whole years, not your birthday, so the year you turn 59 is counted as before 59½. The year you turn 60 is after it.</p>
        </Why>
      )}
    </div>
  );
}

function Section({ section }: { section: YearSection }) {
  const id = `year-${section.title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <section className="stack tight" aria-labelledby={id}>
      <h3 className="section-label" id={id}>
        <Masked>{section.title}</Masked>
      </h3>
      <dl className="txn-detail txn-detail-wide">
        {section.lines.map((l) => (
          <div key={l.label} className={l.sum ? 'txn-detail-row txn-detail-sum' : 'txn-detail-row'}>
            <dt>
              <Masked>{l.label}</Masked>
            </dt>
            <dd className="money">
              <Masked>{l.value}</Masked>
            </dd>
          </div>
        ))}
      </dl>
      {section.meter && (
        <div>
          <div className="meter-track fpl" role="img" aria-label={spoken(section.meter.limitLabel ? `${section.meter.label}, ${section.meter.limitLabel}` : section.meter.label)}>
            <div className="meter-fill" style={{ width: `${section.meter.percent}%` }} />
            {section.meter.limit !== null && <b className="fpl-limit" style={{ left: `${section.meter.limit}%` }} />}
          </div>
          <div className="fpl-scale">
            <span>
              <Masked>{section.meter.label}</Masked>
            </span>
            {section.meter.limitLabel && (
              <span>
                <Masked>{section.meter.limitLabel}</Masked>
              </span>
            )}
          </div>
        </div>
      )}
      {section.note && (
        <p className="helper">
          <Masked>{section.note}</Masked>
        </p>
      )}
      {section.why && (
        <Why label={section.why.label}>
          <p>
            <Masked>{section.why.text}</Masked>
          </p>
        </Why>
      )}
    </section>
  );
}

/** One year: where its money comes from, what it pays for, the income the law counts,
 *  how its tax is worked out, and its health coverage. */
export function YearLevel({ year, context }: { year: DrawdownYear; context: YearContext }) {
  return (
    <div className="stack loose">
      <p className="helper">
        <Masked>{yearHelper(year, context)}</Masked>
      </p>
      {yearSections(year, context).map((s) => (
        <Section key={s.title} section={s} />
      ))}
    </div>
  );
}

