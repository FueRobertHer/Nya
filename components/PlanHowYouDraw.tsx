'use client';

// How you draw and Compare conversions (the tax plan's T4), on Drawdown under Year by
// year: the order money is drawn in, a Roth conversion rule, and the rules side by side.
// Conversions default to none, and nothing here is said to be best (D4). Words in
// components/plan-conversions.ts; the rows in lib/fire/compare-conversions.ts.

import { CopyTag } from './CopyTag';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { CompareRow } from '@/lib/fire/compare-conversions';
import type { Drawdown } from '@/lib/fire/drawdown';
import { MAX_YEARLY_CONVERSION, type TaxChoices } from '@/lib/fire/tax-choices';
import type { Strategy } from '@/lib/fire/tax/rules';
import { Masked, NO_EXAMPLE } from './HideAmounts';
import RadioRows from './RadioRows';
import { Buttons, FieldProblem, readNumber, useDetailSave, type DetailForm, type SaveProps } from './PlanForms';
import { BesideTable } from './PlanBeside';
import { healthPace, lawLabel, STAGE_TAX_NOTE, stageSources, stageTitle } from './plan-drawdown';
import {
  COMPARE_HOLDS,
  COMPARE_SPENDS,
  convertedIn,
  endAgeOf,
  endWords,
  onceUsed,
  ORDER_WORDS,
  PREVIEW_SPENDS,
  previewRows,
  RULE_USED_FAILED,
  ruleName,
  RULES_DIFFER_LABEL,
  rulesDifferText,
  ruleSentence,
  SAVED_FAILED,
  savedLine,
  spendDifferently,
  type NowFigures,
  type UsedFigures,
} from './plan-conversions';
import { pct } from './plan-text';
import { movedLine, TUNE_HOLDS, TUNE_NEEDS_CONSTANT, TUNE_ROW_SUB, TUNE_TITLE } from './plan-tune';
import { Notice } from './TotalCaveats';
import { Why } from './Why';

type Money = (n: number) => string;
type Rule = Strategy['conversions'];

const CHEVRON = (
  <svg className="section-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

/** The card's two rows, each opening its sheet. */
export function HowYouDrawCard({
  copyName = null,
  strategy,
  defaultUntil,
  money,
  held = false,
  onOrder,
  onConversions,
  orderRef,
  conversionsRef,
}: {
  copyName?: string | null;
  strategy: Strategy;
  defaultUntil: number;
  money: Money;
  held?: boolean;
  onOrder: () => void;
  onConversions: () => void;
  orderRef?: (el: HTMLButtonElement | null) => void;
  conversionsRef?: (el: HTMLButtonElement | null) => void;
}) {
  const row = (title: string, sub: React.ReactNode, onOpen: () => void, ref?: (el: HTMLButtonElement | null) => void) => (
    <li>
      <button
        ref={ref}
        type="button"
        className="list-row"
        aria-haspopup="dialog"
        aria-disabled={held ? 'true' : undefined}
        onClick={() => {
          if (!held) onOpen();
        }}
      >
        <span className="list-row-text">
          <span className="list-row-title">{title}</span>
          <span className="list-row-sub">{sub}</span>
        </span>
        {CHEVRON}
      </button>
    </li>
  );
  return (
    <section className="card" aria-labelledby="plan-how-you-draw">
      <CopyTag name={copyName} />
      <div className="card-header">
        <h3 id="plan-how-you-draw">How you draw</h3>
      </div>
      <ul className="list-rows">
        {row('Order', ORDER_WORDS[strategy.order], onOrder, orderRef)}
        {row('Roth conversions', <Masked>{ruleSentence(strategy, defaultUntil, money)}</Masked>, onConversions, conversionsRef)}
      </ul>
    </section>
  );
}

/** Which way money is drawn, after taxable money. */
export function OrderForm(props: SaveProps & { detail: DetailForm }) {
  const { detail, plan } = props;
  const [order, setOrder] = useState<Strategy['order']>(detail.choices.strategy.order);
  const { s, more } = useDetailSave(props, detail);
  const build = () => {
    more.current = order === detail.choices.strategy.order ? {} : { tax: { ...detail.choices, strategy: { ...detail.choices.strategy, order } } };
    return plan;
  };
  return (
    <div className="stack loose">
      <RadioRows
        legend="Which money goes first"
        name="plan-draw-order"
        value={order}
        onChange={(v) => setOrder(v as Strategy['order'])}
        disabled={s.saving}
        options={[
          { value: 'standard', name: ORDER_WORDS.standard, note: 'Roth is left to grow the longest, and income comes earlier.' },
          { value: 'roth-before-deferred', name: ORDER_WORDS['roth-before-deferred'], note: 'Income stays lower in the early years, and more is left to required withdrawals.' },
        ]}
      />
      <p className="helper">Either way, required withdrawals come first once they start. Before 59½, what would pay a penalty comes last.</p>
      {s.error && (
        <Notice level="critical" role="alert">
          {s.error}
        </Notice>
      )}
      <Buttons copy={props.copy} paused={props.paused} onDone={props.onDone} disabled={s.disabled} saving={s.saving} onSave={() => s.save(build)} />
    </div>
  );
}

const BRACKETS = [0.1, 0.12, 0.22, 0.24] as const;
const ACA_BRACKETS = [0.12, 0.22] as const;
type Bracket = (typeof BRACKETS)[number];
type AcaBracket = (typeof ACA_BRACKETS)[number];

/** The rule sheet: which rule, its fields, what it comes to as it changes. */
export function ConversionsForm(
  props: SaveProps & {
    detail: DetailForm;
    /** The year before the earlier RMDs, in your age. */
    defaultUntil: number;
    /** Someone is on the ACA at some year of this plan's run. */
    onAca: boolean;
    partner: boolean;
    /** A rule's run, and the run with none, from this plan's start. */
    preview: ((strategy: Strategy) => { rule: Drawdown | null; none: Drawdown | null }) | null;
    /** A start from the FI number moves with the rule: the balance it starts from now. */
    movingStart: number | null;
    /** The law the preview ran under, for its label. */
    lawYear: number;
    money: Money;
    /** The Constant withdrawal rule: a rule and None live on the same spending. */
    fixedSpending: boolean;
    now: NowFigures | null;
    /** The plan with a rule in it, as Save would have it; null while it can't be run.
     *  The preview holds the plan's stop and start, and saving a rule can move them. */
    used: ((strategy: Strategy) => UsedFigures) | null;
    /** Nothing is asked of `used`: the search it started can go. */
    release?: () => void;
  }
) {
  const { detail, plan, money, defaultUntil, preview } = props;
  const acaLaw = detail.choices.health.acaLaw;
  const either = props.partner ? 'either of you is' : 'you’re';
  const stored = detail.choices.strategy;
  const rule = stored.conversions;
  const [kind, setKind] = useState<Rule['kind']>(rule.kind);
  const [top, setTop] = useState<Bracket>(rule.kind === 'bracket' ? rule.top : 0.12);
  const [acaTop, setAcaTop] = useState<AcaBracket>(rule.kind === 'aca-then-bracket' ? rule.top : 0.12);
  const [yearly, setYearly] = useState(rule.kind === 'fixed' ? String(rule.yearly) : '');
  const [until, setUntil] = useState(stored.convertUntil === null ? '' : String(stored.convertUntil));
  const { s, more } = useDetailSave(props, detail);

  const ruleOf = (amount: number): Rule => {
    switch (kind) {
      case 'none':
        return { kind: 'none' };
      case 'bracket':
        return { kind: 'bracket', top };
      case 'aca-then-bracket':
        return { kind: 'aca-then-bracket', top: acaTop };
      case 'fixed':
        return { kind: 'fixed', yearly: amount };
    }
  };

  function build() {
    const yearlyNow = kind === 'fixed' ? (readNumber(yearly, 'How much a year', 0, MAX_YEARLY_CONVERSION) as number) : 0;
    const age = kind === 'none' ? null : readNumber(until, 'Until age', 18, 100, { integer: true, optional: true });
    if (age !== null && plan.age !== null && age < plan.age) throw new FieldProblem(`Until age must be ${plan.age} or later: you’re ${plan.age} now.`, ['Until age']);
    const strategy: Strategy = { ...stored, conversions: ruleOf(yearlyNow), convertUntil: age };
    const tax: TaxChoices = { ...detail.choices, strategy };
    more.current = JSON.stringify(strategy) === JSON.stringify(stored) ? {} : { tax };
    return plan;
  }

  // As it is typed: what can't be read yet shows nothing, rather than the last rule.
  const typed = useMemo((): Strategy | null => {
    const amount = kind === 'fixed' ? Number(yearly) : 0;
    if (kind === 'fixed' && (yearly.trim() === '' || !Number.isFinite(amount) || amount < 0 || amount > MAX_YEARLY_CONVERSION)) return null;
    const age = until.trim() === '' ? null : Number(until);
    if (age !== null && !(Number.isInteger(age) && age >= 18 && age <= 100)) return null;
    return { ...stored, conversions: ruleOf(amount), convertUntil: kind === 'none' ? null : age };
    // ruleOf reads what is listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, top, acaTop, yearly, until, stored]);
  const runs = useMemo(() => (typed && preview ? preview(typed) : null), [typed, preview]);
  const saying = runs?.rule && runs.none && kind !== 'none' ? previewRows(runs.rule, runs.none, money) : null;
  const changed = typed !== null && JSON.stringify(typed) !== JSON.stringify(stored);
  const spends = saying !== null && !props.fixedSpending && !!runs?.rule && !!runs.none && spendDifferently([runs.rule, runs.none]);
  // What Save gives, beside the preview's run of the same rule from where the plan is. It
  // costs a whole plan's figures, so it renders after typing (useDeferredValue), and a
  // draft that isn't asked about lets its search go.
  const rested = useDeferredValue(typed);
  const asking = saying !== null && changed && props.used !== null && JSON.stringify(rested) === JSON.stringify(typed);
  const answer = asking && typed && props.used ? props.used(typed) : null;
  const { release } = props;
  useEffect(() => {
    if (!asking) release?.();
  }, [asking, release]);
  const once = answer && runs?.rule ? onceUsed({ left: runs.rule.leftAtEnd, cost: runs.rule.taxAndHealth, short: runs.rule.runsOutAt }, props.now, answer) : null;

  const untilField =
    kind === 'none' ? null : (
      <>
        <label className="field">
          Until age
          <input type="number" inputMode="numeric" value={until} onChange={(e) => setUntil(e.target.value)} placeholder={String(defaultUntil)} {...s.field('Until age')} disabled={s.saving} />
        </label>
        {s.under('Until age')}
        <p className="helper">{props.partner ? `Empty stops the year before the first required withdrawals (RMDs), when you’re ${defaultUntil + 1}.` : `Empty stops the year before your required withdrawals (RMDs) start at ${defaultUntil + 1}.`}</p>
      </>
    );
  const bracketSelect = <T extends number>(label: string, list: readonly T[], value: T, set: (v: T) => void) => (
    <label className="field">
      {label}
      <select value={String(value)} onChange={(e) => set(Number(e.target.value) as T)} disabled={s.saving}>
        {list.map((b) => (
          <option key={b} value={String(b)}>{`The ${pct(b)} bracket`}</option>
        ))}
      </select>
    </label>
  );
  const fieldsWith = (first: React.ReactNode) => (
    <div className="sheet-form">
      {first}
      {untilField}
    </div>
  );

  return (
    <div className="stack loose">
      <p className="helper">A Roth conversion moves tax-deferred money to Roth. You pay income tax on it now, and it can grow and come out tax-free later. Nya starts with none and doesn’t recommend a rule.</p>
      <RadioRows
        legend="Rule"
        name="plan-conversions"
        value={kind}
        onChange={(v) => setKind(v as Rule['kind'])}
        disabled={s.saving}
        options={[
          { value: 'none', name: 'None', note: 'Move nothing.' },
          { value: 'bracket', name: 'Fill a bracket', note: 'Each year it converts up to the top of a tax bracket. What you draw from tax-deferred to spend counts toward that top.', detail: fieldsWith(bracketSelect('Up to the top of', BRACKETS, top, setTop)) },
          ...(props.onAca || rule.kind === 'aca-then-bracket'
            ? [{ value: 'aca-then-bracket', name: 'Up to the ACA limit, then a bracket', note: `While ${either} on the ACA, it keeps income under 400% of the poverty line if it can, then fills a bracket. What you draw from tax-deferred and gains you sell count toward the limit.${acaLaw === 'enhanced' ? ' With the enhanced credits there’s no cliff at that limit, but this rule still stops there.' : ' The credit stops above 400%.'}`, detail: fieldsWith(bracketSelect('After 65, up to the top of', ACA_BRACKETS, acaTop, setAcaTop)) }]
            : []),
          {
            value: 'fixed',
            name: 'A fixed amount',
            note: 'The same amount each year, with no ceiling.',
            detail: fieldsWith(
              <>
                <label className="field">
                  How much a year, in today’s dollars
                  <input type="number" inputMode="decimal" value={yearly} onChange={(e) => setYearly(e.target.value)} placeholder={NO_EXAMPLE} {...s.field('How much a year')} disabled={s.saving} />
                </label>
                {s.under('How much a year')}
              </>
            ),
          },
        ]}
      />
      {saying && (
        <section className="stack tight" aria-labelledby="plan-conversion-preview">
          <h3 className="section-label" id="plan-conversion-preview">
            What it comes to
          </h3>
          <BesideTable caption="This rule beside no conversions" heads={['This rule', 'None']} rows={saying} />
          {spends && <p className="helper">{PREVIEW_SPENDS}</p>}
          <p className="plan-definition">{lawLabel(props.lawYear)}</p>
        </section>
      )}
      {props.movingStart !== null && changed && (
        <p className="helper">
          <Masked>{`From your start of ${money(props.movingStart)}. Your FI number moves with the rule, so once saved this plan starts from a different number.`}</Masked>
        </p>
      )}
      {once?.ready && once.differs && (
        <p className="helper">
          <Masked>{savedLine({ stop: once.stop, start: once.start, copyOpen: !!props.copy, drawn: once.ready }, money)}</Masked>
        </p>
      )}
      {answer?.failed && <p className="helper">{SAVED_FAILED}</p>}
      {answer?.failed && answer.retry && (
        <div>
          <button type="button" className="btn secondary" onClick={answer.retry}>
            Try again
          </button>
        </div>
      )}
      {kind === 'aca-then-bracket' && <p className="helper">{`Past the age you set, while ${either} on ACA coverage, it still converts what it takes to keep coverage from counting at full price, if there’s money to convert.`}</p>}
      <Why label={RULES_DIFFER_LABEL}>
        <p>{`${rulesDifferText({ onAca: props.onAca, acaLaw })} Compare conversions on Drawdown sets the rules side by side.`}</p>
      </Why>
      {s.error && (
        <Notice level="critical" role="alert">
          {s.error}
        </Notice>
      )}
      <Buttons copy={props.copy} paused={props.paused} onDone={props.onDone} disabled={s.disabled} saving={s.saving} onSave={() => s.save(build)} />
    </div>
  );
}

export type SortColumn = 'left' | 'cost' | 'credit';
type SortDir = 'descending' | 'ascending';
export type ColumnSort = { column: SortColumn; dir: SortDir };

/** Highest first, then lowest. A run that runs short has nothing left: it sorts last in
 *  Left at, the later of two first, whichever way the rest go. */
export function sortedRows<T>(rows: readonly T[], sort: ColumnSort | null, read: (row: T) => { left: number; cost: number; credit?: number; short: number | null }): readonly T[] {
  if (!sort) return rows;
  const sign = sort.dir === 'descending' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = read(a);
    const y = read(b);
    if (sort.column === 'left' && (x.short !== null || y.short !== null)) {
      if (x.short === null) return -1;
      if (y.short === null) return 1;
      return y.short - x.short;
    }
    return sign * ((x[sort.column] ?? 0) - (y[sort.column] ?? 0));
  });
}

/** A column's heading, which sorts by it: highest first, then lowest. */
export function SortHeading({ column, label, sort, onSort }: { column: SortColumn; label: string; sort: ColumnSort | null; onSort: (sort: ColumnSort) => void }) {
  const on = sort?.column === column;
  return (
    <th scope="col" aria-sort={on ? sort.dir : 'none'}>
      <button type="button" className="th-sort" onClick={() => onSort({ column, dir: on && sort.dir === 'descending' ? 'ascending' : 'descending' })}>
        {label}
        <svg className={`section-chevron${on && sort.dir === 'ascending' ? ' open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={on ? 'm6 9 6 6 6-6' : 'm7 15 5 5 5-5M7 9l5-5 5 5'} />
        </svg>
      </button>
    </th>
  );
}

/** Each rule, side by side. Nothing is marked best, and nothing sorted until asked. */
export function CompareCard({
  rows,
  money,
  realReturn,
  lawYear,
  healthGrowth,
  acaLaw,
  copyName = null,
  held = false,
  working = false,
  onRule,
  ruleRef,
  tunable = false,
  onTune,
  tuneRef,
}: {
  rows: readonly CompareRow[];
  money: Money;
  realReturn: number;
  lawYear: number;
  /** Fractions of a point, as the years have it. */
  healthGrowth: number;
  acaLaw: TaxChoices['health']['acaLaw'];
  /** A copy is shown: its rule is this copy's, not your plan's. */
  copyName?: string | null;
  held?: boolean;
  /** A job is working out this plan's date: these rows are the last found. */
  working?: boolean;
  onRule: (row: CompareRow) => void;
  ruleRef?: (key: string, el: HTMLButtonElement | null) => void;
  /** The Constant withdrawal rule: every rule and setting lives on the same spending, so
   *  what's left compares like with like. On any other, the rows are measured. */
  tunable?: boolean;
  /** Tune to a goal's sheet; left out, the card doesn't offer it. */
  onTune?: () => void;
  tuneRef?: (el: HTMLButtonElement | null) => void;
}) {
  const [sort, setSort] = useState<ColumnSort | null>(null);
  const endAge = rows.length > 0 ? endAgeOf(rows[0].drawn) : null;
  const onAca = rows.some((r) => r.drawn.aca.on > 0);
  return (
    <section className={working ? 'card plan-answer-pending' : 'card'} aria-labelledby="plan-compare-rules" aria-busy={working || undefined}>
      <CopyTag name={copyName} />
      <div className="card-header">
        <h3 id="plan-compare-rules">Compare conversions</h3>
      </div>
      <p className="helper">{`Each rule run on this plan at a steady ${pct(realReturn)} after inflation. Nya doesn’t recommend one. Tap a heading to sort, a rule to see its stages.`}</p>
      <div className="plan-table-scroll">
        <table className="plan-compare-table plan-rules-table">
          <caption className="visually-hidden">{`Each conversion rule at a steady ${pct(realReturn)}, ${lawYear} tax law`}</caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <SortHeading column="left" label={endAge === null ? 'Left, after tax' : `Left at ${endAge}, after tax`} sort={sort} onSort={setSort} />
              <SortHeading column="cost" label="Tax and health" sort={sort} onSort={setSort} />
              {onAca && <SortHeading column="credit" label="Years with an ACA credit" sort={sort} onSort={setSort} />}
            </tr>
          </thead>
          <tbody>
            {sortedRows(rows, sort, (r) => ({ left: r.drawn.leftAtEnd, cost: r.drawn.taxAndHealth, credit: r.drawn.aca.withCredit, short: r.drawn.runsOutAt })).map((r) => (
              <tr key={r.key}>
                <th scope="row">
                  <button
                    ref={ruleRef ? (el) => ruleRef(r.key, el) : undefined}
                    type="button"
                    className="th-sort"
                    aria-haspopup="dialog"
                    aria-disabled={held ? 'true' : undefined}
                    onClick={() => {
                      if (!held) onRule(r);
                    }}
                  >
                    <Masked>{ruleName(r.strategy.conversions, money, r.strategy.convertUntil)}</Masked>
                  </button>
                  {r.mine && <span className="badge accent">{copyName ? 'This copy' : 'Your plan'}</span>}
                </th>
                <td className="money">
                  <Masked>{endWords(r.drawn, money)}</Masked>
                </td>
                <td className="money">
                  <Masked>{money(r.drawn.taxAndHealth)}</Masked>
                </td>
                {onAca && <td>{`${r.drawn.aca.withCredit} of ${r.drawn.aca.on}`}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="helper">{tunable ? TUNE_HOLDS : spendDifferently(rows.map((r) => r.drawn)) ? COMPARE_SPENDS : COMPARE_HOLDS}</p>
      <Why label={RULES_DIFFER_LABEL}>
        <p>{rulesDifferText({ onAca, acaLaw })}</p>
      </Why>
      <p className="plan-definition">{`Hypothetical, ${lawYear} tax law, steady growth, health costs ${healthPace(healthGrowth)}. Not tax advice.`}</p>
      {onTune &&
        (tunable ? (
          <ul className="list-rows">
            <li>
              <button
                ref={tuneRef}
                type="button"
                className="list-row"
                aria-haspopup="dialog"
                aria-disabled={held || working ? 'true' : undefined}
                onClick={() => {
                  if (!held && !working) onTune();
                }}
              >
                <span className="list-row-text">
                  <span className="list-row-title">{TUNE_TITLE}</span>
                  <span className="list-row-sub">{TUNE_ROW_SUB}</span>
                </span>
                {CHEVRON}
              </button>
            </li>
          </ul>
        ) : (
          <p className="helper">{TUNE_NEEDS_CONSTANT}</p>
        ))}
    </section>
  );
}

/** What a run comes to, stage by stage. */
export function RuleFigures({ drawn, money }: { drawn: Drawdown; money: Money }) {
  const moved = convertedIn(drawn);
  const endAge = endAgeOf(drawn);
  const line = (label: string, value: React.ReactNode) => (
    <div className="txn-detail-row">
      <dt>{label}</dt>
      <dd className="money">{value}</dd>
    </div>
  );
  return (
    <>
      <dl className="txn-detail txn-detail-wide">
        {line(endAge === null ? 'Left, after tax' : `Left at ${endAge}, after tax`, <Masked>{endWords(drawn, money)}</Masked>)}
        {line('Tax and health costs, in all', <Masked>{money(drawn.taxAndHealth)}</Masked>)}
        {moved >= 0.5 && line('Converted to Roth, in all', <Masked>{money(moved)}</Masked>)}
        {drawn.aca.on > 0 && line('Years with an ACA credit', `${drawn.aca.withCredit} of ${drawn.aca.on}`)}
      </dl>
      <section className="stack tight" aria-labelledby="plan-rule-stages">
        <h3 className="section-label" id="plan-rule-stages">
          Stage by stage
        </h3>
        <p className="helper">{STAGE_TAX_NOTE}</p>
        <dl className="txn-detail txn-detail-wide">
          {drawn.stages.map((s) => (
            <div key={s.key} className="txn-detail-row">
              <dt>
                {stageTitle(s)}
                <span className="list-row-sub">
                  <Masked>{stageSources(s, drawn.years, money)}</Masked>
                </span>
              </dt>
              <dd className="money">
                <Masked>{`${money(s.yearlyTax)} tax a year`}</Masked>
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}

/** A rule's sheet: what the plan comes to with it once used, stage by stage, what that
 *  moves from its row, and a copy to try it in. The plan's own rule is its row. */
export function RuleLevel({
  row,
  money,
  lawYear,
  copyOpen,
  whyNot,
  onTry,
  now,
  used,
}: {
  row: CompareRow;
  money: Money;
  lawYear: number;
  copyOpen: boolean;
  /** Why no copy can be made yet; null when one can. */
  whyNot: string | null;
  onTry: () => Promise<true | string>;
  now: NowFigures | null;
  /** The plan with a rule in it, as the page works it out: a row holds the plan's stop
   *  and start, and using a rule can move them. */
  used: (strategy: Strategy) => UsedFigures;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer: UsedFigures = row.mine ? { drawn: row.drawn, stop: now?.stop ?? null, start: now?.start ?? null, working: false, failed: false, retry: null } : used(row.strategy);
  const { ready, stop, start, differs } = onceUsed({ left: row.drawn.leftAtEnd, cost: row.drawn.taxAndHealth, short: row.drawn.runsOutAt }, now, answer);
  // Until it is worked out, and where it can't be, the row's run: what is drawn meanwhile
  // is a stand-in at another stop, neither the row nor the rule as used.
  const shown = ready ?? row.drawn;
  return (
    <div className="stack loose">
      <div className={answer.working ? 'stack loose plan-answer-pending' : 'stack loose'} aria-busy={answer.working || undefined}>
        {answer.working && (
          <p className="plan-working-line" role="status">
            Working it out
          </p>
        )}
        <RuleFigures drawn={shown} money={money} />
      </div>
      {answer.failed && <p className="helper">{RULE_USED_FAILED}</p>}
      {answer.failed && answer.retry && (
        <div>
          <button type="button" className="btn secondary" onClick={answer.retry}>
            Try again
          </button>
        </div>
      )}
      {differs && (
        <p className="helper">
          <Masked>{movedLine({ stop, start, copyOpen }, money)}</Masked>
        </p>
      )}
      <p className="plan-definition">{lawLabel(lawYear)}</p>
      {row.mine ? (
        <p className="helper">{copyOpen ? 'This copy has this rule.' : 'Your plan has this rule.'}</p>
      ) : answer.failed ? null : (
        <div className="stack tight">
          <p className="helper">{`Makes a copy of ${copyOpen ? 'this copy' : 'your plan'} with this rule and opens it. ${copyOpen ? 'This copy stays' : 'Your plan stays'} as it is.`}</p>
          {/* Its own Try is why no copy can be made meanwhile, and that needs no words. */}
          {!saving && whyNot && <p className="helper plan-paused">{whyNot}</p>}
          {error && (
            <Notice level="critical" role="alert">
              {error}
            </Notice>
          )}
          <div>
            <button
              type="button"
              className="btn ghost"
              disabled={saving || whyNot !== null || ready === null}
              onClick={async () => {
                setSaving(true);
                setError(null);
                const r = await onTry();
                setSaving(false);
                if (r !== true) setError(r);
              }}
            >
              {saving ? 'Saving…' : 'Try it in a copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
