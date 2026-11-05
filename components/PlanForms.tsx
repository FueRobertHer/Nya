'use client';

// The Plan tab's forms, each shown in the drawer (components/Sheet.tsx). A
// form holds what is typed as strings (so "4." or "-" survive typing), checks
// each field with a message a person can act on, and saves the WHOLE plan
// through onSave, closing only once the server has it. A form opens while
// saving is paused (the Plan's figure rows always open their sheets), and
// then says why above its buttons.
//
// With a copy open (the tax plan's C2), the plan a form holds is the copy's,
// and onSave saves it whole (components/plan-savers.ts). What every plan
// shares (your age, how figures are measured, the method) is shown, but
// can't be edited there, and the form says where its save goes. A figure's
// sheet, or one editing an income or a one-off, offers Also change it in
// (components/AlsoChange.tsx): the other plans the same change can go to.

import { useEffect, useId, useRef, useState } from 'react';
import { plainNumber } from '@/lib/format';
import { allocationOf, asText, LIMITS, pctText, stopOf, type FiView, type FirePlan, type PlanCore, type PlanFunding } from '@/lib/fire/plan';
import type { PathAfter } from '@/lib/fire/path';
import { parsePlanV2, type FirePlanV2 } from '@/lib/fire/plan-v2';
import { vpwExpectedReturn, type RuleKind } from '@/lib/fire/rules';
import { fiNumber as fiNumberOf } from '@/lib/fire/fi';
import { MAX_STATE_RATE, type TaxChoices } from '@/lib/fire/tax-choices';
import { householdOf, MAX_DEPENDENTS, sameHousehold, type Owner, type TaxFacts, type TaxHousehold } from '@/lib/fire/tax-facts';
import { rmdAge } from '@/lib/fire/tax/rmd';
import { STATE_CODES, type Filing, type StateCode, type Statute } from '@/lib/fire/tax/law/types';
import { FILING_NAMES, householdNotes, STATE_NAMES } from './plan-drawdown';
import { METHOD_NAMES, RULE_NAMES, ruleText, pct, wholeMoney } from './plan-text';
import { BLOCK_MONTHS, DEFAULT_RUNS, DEFAULT_SEED } from '@/lib/fire/simulate';
import { mixBasisText, mixLeftOutText, mixText } from './allocation-text';
import { Masked, NO_EXAMPLE, spokenLabel } from './HideAmounts';
import { Why } from './Why';
import { Segmented } from './Segmented';
import FieldError from './FieldError';
import { taxOnHoldText } from './plan-figure-notes';
import { Notice } from './TotalCaveats';
import AlsoChange, { type AlsoChoice } from './AlsoChange';
import { itemRuleText } from './plan-items';
import { BucketGroups, BucketLevel, SavingsSplitLines, type BucketSheet } from './PlanBuckets';
import { BUCKET_NAMES, type TaxBucket } from '@/lib/allocation/buckets';
import { byBucket, type SavingsSplit } from '@/lib/fire/savings-split';
import type { SavingsBucket } from '@/lib/fire/tax-choices';
import { headLine, splitNote } from './plan-buckets';
import type { PlanMix } from '@/lib/allocation/allocation';

export type SaveProps = {
  plan: FirePlanV2;
  /** Resolves true once the server has the plan (and the plans checked in
   *  Also change it in, `also`, the same change), false when it didn't take
   *  it, or with why it was refused before it was sent. */
  onSave: (next: FirePlanV2, also?: readonly string[]) => Promise<boolean | string>;
  onDone: () => void;
  /** False while the saved plan is loading or unreadable: nothing is saved. */
  editable: boolean;
  /** The open copy's name, which the save goes to; null for your plan. */
  copy?: string | null;
  /** The other plans this change can go to too, with their value now. */
  also?: readonly AlsoChoice[];
  /** Why saving is paused for more than a moment (the saved plan couldn't
   *  be read, a repair waits, its currency isn't known), said above the
   *  buttons; null while it isn't, or only for a moment (a save under way). */
  paused?: string | null;
  /** D15's switch (the flag 'plan-items-in-fi'): one-offs and income count
   *  in the FI date, which the income and one-off forms say. */
  planInWalk?: boolean;
  /** D7's switch (the flag 'plan-child-accounts'): a child's accounts are out
   *  of invested assets, which that figure's form says. */
  childOut?: boolean;
};

/** Said beside an input a copy can't change. */
export const SAME_IN_EVERY_PLAN = 'the same in every plan: change it on your plan.';

/** What a save carries beside the plan: its tax choices and, on your plan, the
 *  household. Each only when it changed, so a release before still takes every other save. */
export type MoreSave = { tax?: TaxChoices; household?: TaxHousehold };

/** What a detailed plan's fields start from and save through. */
export type DetailForm = {
  /** The plan's, or your plan's where it has none. */
  choices: TaxChoices;
  facts: TaxFacts;
  /** In a copy: the household is the same in every plan. */
  factsLocked: boolean;
  stateTaxes: Record<StateCode, boolean>;
  statute: Statute;
  calendarYear: number;
  save: (next: FirePlanV2, more: MoreSave, also?: readonly string[]) => Promise<boolean | string>;
};

/** What was typed that can't be saved, and the fields it is about (each by
 *  the name `readNumber` is given): said under the last of them, and named
 *  by each (`useSave`'s `field` and `under`). */
export class FieldProblem extends Error {
  constructor(
    message: string,
    readonly fields: readonly string[]
  ) {
    super(message);
  }
}

/** A number typed in a field: null when empty, an error when not a number in range. */
export function readNumber(text: string, what: string, min: number, max: number, opts: { integer?: boolean; optional?: boolean; scale?: number } = {}): number | null {
  const t = text.trim();
  if (t === '') {
    if (opts.optional) return null;
    throw new FieldProblem(`${what} is needed.`, [what]);
  }
  const n = Number(t);
  const scale = opts.scale ?? 1;
  if (!Number.isFinite(n) || n * scale < min - 1e-12 || n * scale > max + 1e-12) {
    const show = (v: number) => (scale === 1 ? plainNumber(v) : `${Number((v / scale).toFixed(2))}%`);
    throw new FieldProblem(`${what} must be from ${show(min)} to ${show(max)}.`, [what]);
  }
  if (opts.integer && !Number.isInteger(n)) throw new FieldProblem(`${what} must be a whole number.`, [what]);
  return scale === 1 ? n : Number((n * scale).toFixed(6));
}


/** Saves `build()` when it checks out, keeping the message otherwise: what
 *  was typed wrong under its field, a save that failed as a notice. */
function useSave({ onSave, onDone, editable }: SaveProps) {
  const [error, setError] = useState('');
  const [wrong, setWrong] = useState<FieldProblem | null>(null);
  const [saving, setSaving] = useState(false);
  // The plans checked in Also change it in.
  const [alsoIn, setAlsoIn] = useState<string[]>([]);
  const errorId = useId();
  /** `also`: the change goes to the plans checked too; never a removal's. */
  async function save(build: () => FirePlanV2, also = true) {
    let next: FirePlanV2;
    try {
      next = build();
    } catch (err) {
      if (err instanceof FieldProblem) {
        setError('');
        setWrong(err);
        return;
      }
      throw err;
    }
    setWrong(null);
    // The server checks again; this catches anything the fields above missed.
    const parsed = parsePlanV2(next);
    if ('error' in parsed) {
      setError(`That plan can't be saved: ${itemRuleText(parsed.error, next)}`);
      return;
    }
    setError('');
    setSaving(true);
    const ok = await onSave(parsed.plan, also ? alsoIn : []);
    setSaving(false);
    if (ok === true) onDone();
    else setError(typeof ok === 'string' ? ok : 'It was not saved. Try again in a moment.');
  }
  /** A field's input: invalid, and described by what is wrong, while it is
   *  one the problem is about. */
  const field = (name: string) => (wrong?.fields.includes(name) ? { 'aria-invalid': true, 'aria-describedby': errorId } : {});
  /** What is wrong, said here when the last field it is about is one of `names`. */
  const under = (...names: string[]) =>
    wrong && names.includes(wrong.fields[wrong.fields.length - 1]) ? <FieldError id={errorId}>{wrong.message}</FieldError> : null;
  return { error, saving, save, field, under, alsoIn, setAlsoIn, disabled: saving || !editable };
}

/** As useSave, for a form that says more than the plan, which its `build` sets in
 *  `more`. Nothing to say and nothing changed in the plan: nothing to send. */
export function useDetailSave(props: SaveProps, detail: DetailForm | null) {
  const more = useRef<MoreSave>({});
  const onSave: SaveProps['onSave'] = async (next, also) => {
    if (!detail) return props.onSave(next, also);
    if (!more.current.tax && !more.current.household && JSON.stringify(next) === JSON.stringify(props.plan)) return true;
    return detail.save(next, more.current, also);
  };
  return { s: useSave({ ...props, onSave }), more };
}

export function Buttons({
  onDone,
  disabled,
  saving,
  onSave,
  extra,
  copy = null,
  paused = null,
  also = [],
  alsoIn = [],
  onAlso,
}: {
  onDone: () => void;
  disabled: boolean;
  saving: boolean;
  onSave: () => void;
  extra?: React.ReactNode;
  copy?: string | null;
  paused?: string | null;
  /** Also change it in: the plans offered, and those checked. */
  also?: readonly AlsoChoice[];
  alsoIn?: readonly string[];
  onAlso?: (ids: string[]) => void;
}) {
  return (
    <>
      {extra}
      {onAlso && <AlsoChange choices={also} checked={alsoIn} onChange={onAlso} disabled={saving} />}
      {copy && <p className="panel-note plan-copy-saves">Saved to this copy, not your plan.</p>}
      {paused && <p className="helper plan-paused">{paused}</p>}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onDone} disabled={saving}>
          Cancel
        </button>
        <button onClick={onSave} disabled={disabled}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}

/** Choices in a row, the chosen one marked: a radio group setting a value,
 *  or, with `tabs`, a switch between views (components/Segmented.tsx). */
export function Choice<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled = false,
  tabs,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
  tabs?: { id: (v: T) => string; panel: string };
}) {
  return <Segmented className="plan-choice" label={label} value={value} onChange={onChange} options={options} disabled={disabled} tabs={tabs} />;
}

/** Both ages, refusing a target already passed: it would have Coast FI grow
 *  money backwards and the simulation retire before today. */
function ages(age: number | null, targetAge: number | null): { age: number | null; targetAge: number | null } {
  if (age !== null && targetAge !== null && targetAge < age) {
    throw new FieldProblem("Your stop age can't be before your age. If you've already stopped working, use your age.", ['Your age', 'Stop age']);
  }
  return { age, targetAge };
}

/** A stop age kept under Stop when I reach FI, shown again only while it is
 *  still ahead of `age`. */
const stopAhead = (target: string, age: string) => (target.trim() !== '' && age.trim() !== '' && Number(target) < Number(age) ? '' : target);

/** Whether a birthday decides this age's RMD age: this year's age is one of two birth
 *  years, and the statute's line falls between them. */
const birthdayDecides = (age: number | null, calendarYear: number, statute: Statute) => age !== null && rmdAge(calendarYear - age - 1, statute) !== rmdAge(calendarYear - age, statute);

/** What Household says beyond the ages, in a detailed plan: filing and dependents, the
 *  same in every plan; the state and its rate, a plan's own; a year of birth only where
 *  a birthday decides the RMD age. */
function useHouseholdFields(d: DetailForm | null, age: string, partner: string, s: Pick<ReturnType<typeof useSave>, 'saving' | 'field' | 'under'>) {
  const [filing, setFiling] = useState<Filing | ''>(d?.facts.filing ?? '');
  const [state, setState] = useState<StateCode | ''>(d?.choices.state ?? '');
  const [rate, setRate] = useState(d ? pctText(d.choices.stateRate) : '');
  const [dependents, setDependents] = useState(() => (d?.facts.dependents ?? []).map((x) => ({ id: x.id, untilAge: String(x.untilAge) })));
  const bornIn = (owner: Owner) => d?.facts.birthYears.find((b) => b.owner === owner)?.year ?? null;
  const [youBorn, setYouBorn] = useState(asText(bornIn('you')));
  const [partnerBorn, setPartnerBorn] = useState(asText(bornIn('partner')));
  if (!d) return { fields: null, read: (): MoreSave => ({}) };

  const locked = d.factsLocked || s.saving;
  const taxes = state !== '' && d.stateTaxes[state];
  const askYou = birthdayDecides(age.trim() === '' ? null : Number(age), d.calendarYear, d.statute);
  const askPartner = birthdayDecides(partner.trim() === '' ? null : Number(partner), d.calendarYear, d.statute);
  const notes = householdNotes({ facts: { dependents: dependents.map((x) => ({ id: x.id, untilAge: Number(x.untilAge) })) }, choices: { state: state || null } });

  const read = (): MoreSave => {
    const code = state === '' ? null : state;
    const stateRate = code !== null && d.stateTaxes[code] ? (readNumber(rate, 'The state’s rate', 0, MAX_STATE_RATE, { scale: 0.01, optional: true }) ?? 0) : 0;
    const tax: TaxChoices | null = code === d.choices.state && stateRate === d.choices.stateRate ? null : { ...d.choices, state: code, stateRate };
    if (d.factsLocked) return tax ? { tax } : {};
    if (filing === 'joint' && partner.trim() === '') throw new FieldProblem('Filing jointly needs your partner’s age, above.', ['Your partner’s age']);
    const year = (owner: Owner, text: string, asked: boolean, what: string) => {
      const held = bornIn(owner);
      const y = asked ? readNumber(text, what, 1900, d.calendarYear, { integer: true, optional: true }) : held;
      return y === null ? [] : [{ owner, year: y }];
    };
    const household: TaxHousehold = {
      ...householdOf(d.facts),
      filing: filing === '' ? null : filing,
      birthYears: [...year('you', youBorn, askYou, 'Your year of birth'), ...year('partner', partnerBorn, askPartner, 'Your partner’s year of birth')],
      dependents: dependents.map((x, i) => ({ id: x.id, untilAge: readNumber(x.untilAge, `Dependent ${i + 1}`, 0, 120, { integer: true }) as number })),
    };
    return { ...(tax ? { tax } : {}), ...(sameHousehold(household, householdOf(d.facts)) ? {} : { household }) };
  };

  const fields = (
    <>
      <label className="field">
        Filing status
        <select value={filing} onChange={(e) => setFiling(e.target.value as Filing | '')} disabled={locked}>
          <option value="">Not said (counted as single)</option>
          <option value="single">{FILING_NAMES.single}</option>
          <option value="joint">{FILING_NAMES.joint}</option>
        </select>
      </label>
      <label className="field">
        State
        <select value={state} onChange={(e) => setState(e.target.value as StateCode | '')} disabled={s.saving}>
          <option value="">Not said (no state tax, no Medicaid expansion)</option>
          {[...STATE_CODES].sort((a, b) => STATE_NAMES[a].replace(/^the /, '').localeCompare(STATE_NAMES[b].replace(/^the /, ''))).map((c) => (
            <option key={c} value={c}>
              {STATE_NAMES[c].replace(/^the /, '')}
            </option>
          ))}
        </select>
      </label>
      {taxes ? (
        <>
          <label className="field">
            {STATE_NAMES[state]} income tax (% of income)
            <input type="number" inputMode="decimal" data-percent step="0.1" value={rate} onChange={(e) => setRate(e.target.value)} disabled={s.saving} {...s.field('The state’s rate')} />
          </label>
          {s.under('The state’s rate')}
          {Number(rate || 0) === 0 ? <Notice level="caution">With no rate here, no state tax is counted.</Notice> : <p className="helper">One rate on income and gains, for the years you draw.</p>}
        </>
      ) : (
        state !== '' && <p className="helper">{STATE_NAMES[state]} has no income tax on what you’d draw.</p>
      )}
      <div className="stack tight">
        <h4 className="section-label">Dependents</h4>
        {dependents.map((x, i) => (
          <div key={x.id}>
            <label className="field">
              {`Dependent ${i + 1} leaves your household when you’re`}
              <input
                type="number"
                inputMode="numeric"
                value={x.untilAge}
                onChange={(e) => setDependents((list) => list.map((y) => (y.id === x.id ? { ...y, untilAge: e.target.value } : y)))}
                disabled={locked}
                {...s.field(`Dependent ${i + 1}`)}
              />
            </label>
            {s.under(`Dependent ${i + 1}`)}
            <button type="button" className="btn ghost" onClick={() => setDependents((list) => list.filter((y) => y.id !== x.id))} disabled={locked} aria-label={`Remove dependent ${i + 1}`}>
              Remove
            </button>
          </div>
        ))}
        {dependents.length < MAX_DEPENDENTS && (
          <div>
            <button type="button" className="btn ghost" onClick={() => setDependents((list) => [...list, { id: crypto.randomUUID(), untilAge: '' }])} disabled={locked}>
              Add a dependent
            </button>
          </div>
        )}
      </div>
      {askYou && (
        <>
          <label className="field">
            Your year of birth
            <input type="number" inputMode="numeric" value={youBorn} onChange={(e) => setYouBorn(e.target.value)} placeholder="Not set" disabled={locked} {...s.field('Your year of birth')} />
          </label>
          {s.under('Your year of birth')}
        </>
      )}
      {askPartner && (
        <>
          <label className="field">
            Your partner’s year of birth
            <input type="number" inputMode="numeric" value={partnerBorn} onChange={(e) => setPartnerBorn(e.target.value)} placeholder="Not set" disabled={locked} {...s.field('Your partner’s year of birth')} />
          </label>
          {s.under('Your partner’s year of birth')}
        </>
      )}
      {(askYou || askPartner) && <p className="helper">At this age, a birthday decides when required withdrawals start.</p>}
      {d.factsLocked && <p className="panel-note">Filing, dependents and years of birth are {SAME_IN_EVERY_PLAN}</p>}
      {notes.map((n) => (
        <Notice key={n.key} level={n.level}>
          {n.text}
        </Notice>
      ))}
    </>
  );
  return { fields, read };
}

/** The Household sheet (the tax plan's E2; T3 adds filing and state): your
 *  age and your partner's, the same in every plan, and when you stop: at an
 *  age, or when you reach FI, which keeps the age hidden for going back. */
export function AboutForm(props: SaveProps & { detail?: DetailForm | null }) {
  const { plan } = props;
  const [age, setAge] = useState(asText(plan.age));
  const [partner, setPartner] = useState(asText(plan.partnerAge));
  const [atFi, setAtFi] = useState(plan.stopAtFi);
  const [target, setTarget] = useState(plan.stopAtFi ? stopAhead(asText(plan.targetAge), asText(plan.age)) : asText(plan.targetAge));
  const { s, more } = useDetailSave(props, props.detail ?? null);
  const household = useHouseholdFields(props.detail ?? null, age, partner, s);
  const [min, max] = LIMITS.age;
  const passed = !atFi && plan.stopAtFi && plan.targetAge !== null && target === '';
  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Your age places what&apos;s on your Timeline. When you stop is when you would like to stop working: Drawdown starts there (unless it starts with what you have today), and Coast FI counts the years to it.
      </p>
      <div className="sheet-form">
        <label className="field">
          Your age
          <input
            type="number"
            inputMode="numeric"
            value={age}
            onChange={(e) => setAge(e.target.value)}
            placeholder="Not set"
            {...s.field('Your age')}
            disabled={s.saving || !!props.copy}
          />
        </label>
        {s.under('Your age')}
        <div className="field">
          <span aria-hidden="true">You stop</span>
          <Choice
            label="You stop"
            value={atFi ? 'fi' : 'age'}
            options={[
              ['age', 'At an age'],
              ['fi', 'When I reach FI'],
            ]}
            onChange={(v) => {
              setAtFi(v === 'fi');
              if (v === 'age') setTarget((t) => stopAhead(t, age));
            }}
            disabled={s.saving}
          />
        </div>
        {atFi ? (
          <p className="helper">When I reach FI: the first age your invested assets cover the life you&apos;d live from then on, counting that year&apos;s own costs; the age field goes. Items that start when you stop move with it.</p>
        ) : (
          <>
            <label className="field">
              Stop age
              <input
                type="number"
                inputMode="numeric"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="Not set"
                {...s.field('Stop age')}
                disabled={s.saving}
              />
            </label>
            {s.under('Stop age')}
            {passed && <p className="helper">The age you had here has passed: type when you&apos;d like to stop.</p>}
          </>
        )}
        <label className="field">
          Your partner&apos;s age
          <input
            type="number"
            inputMode="numeric"
            value={partner}
            onChange={(e) => setPartner(e.target.value)}
            placeholder="Not set"
            {...s.field('Your partner’s age')}
            disabled={s.saving || !!props.copy}
          />
        </label>
        {s.under('Your partner’s age')}
        <p className="helper">For the items that are your partner&apos;s, timed by their age.</p>
        {props.copy && <p className="panel-note">Both ages are {SAME_IN_EVERY_PLAN}</p>}
        {household.fields}
      </div>
      {s.error && (
        <Notice level="critical" role="alert">
          {s.error}
        </Notice>
      )}
      <Buttons
        copy={props.copy}
        paused={props.paused}
        onDone={props.onDone}
        disabled={s.disabled}
        saving={s.saving}
        onSave={() =>
          s.save(() => {
            const a = readNumber(age, 'Your age', min, max, { integer: true, optional: true });
            const p = readNumber(partner, 'Your partner’s age', min, max, { integer: true, optional: true });
            more.current = household.read();
            // Under FI the stop age is hidden, and may be behind you: kept.
            if (atFi) return { ...plan, age: a, partnerAge: p, stopAtFi: true };
            return { ...plan, ...ages(a, readNumber(target, 'Stop age', min, max, { integer: true, optional: true })), partnerAge: p, stopAtFi: false };
          })
        }
      />
    </>
  );
}

/** Your own FI number, as typed: above 0, up to a plan's largest balance. */
function ownFiNumber(text: string): number {
  const n = readNumber(text, 'Your own number', 0, LIMITS.balance) as number;
  if (n <= 0) throw new FieldProblem('Your own number must be above 0.', ['Your own number']);
  return n;
}

/** The FI number's sheet (the tax plan's E2): the number, how it is worked
 *  out, what it leaves out, and your own number in place of it. Its lines
 *  are read-only: each figure is one row away on Your figures, and opening a
 *  sheet from a sheet would drop what was typed. */
export function FiNumberForm(props: SaveProps & { view: FiView; retirementSpending: number | null; leftOut: PathAfter['leftOut'] | null; money: (n: number) => string }) {
  const { plan, view, retirementSpending, leftOut, money } = props;
  const [own, setOwn] = useState(asText(plan.fiNumber));
  const s = useSave(props);
  const spending = retirementSpending ?? view.spending.value;
  const worked = view.workedOut ?? (plan.fiNumber === null ? view.fiNumber : null);
  const names = (leftOut?.items ?? []).map((i) => `${i.label} ${i.kind === 'income' ? 'from' : 'at'} ${i.age}`);
  if (leftOut?.events) names.push('this plan’s items after you stop');
  // No path to read it from (a shortfall): the plan's own money in, by name.
  if (leftOut === null) for (const x of plan.items) if (x.kind === 'social-security' || x.kind === 'pension' || x.kind === 'other-income') names.push(x.label);
  return (
    <>
      <p className="total-value">
        <Masked>{view.fiNumber !== null ? money(view.fiNumber) : '--'}</Masked>
      </p>
      <p className="helper">What you&apos;d need invested on the day you stop, so that what you draw each year covers your life after work.</p>
      {spending !== null && worked !== null && (
        <section className="stack tight" aria-labelledby="fi-number-how">
          <h3 className="section-label" id="fi-number-how">
            How it&apos;s worked out
          </h3>
          <dl className="txn-detail">
            <div className="txn-detail-row">
              <dt>{retirementSpending !== null ? 'Spending in retirement' : 'Spending'}</dt>
              <dd>
                <Masked>{`${money(spending)} a year`}</Masked>
              </dd>
            </div>
            {plan.taxRate > 0 && (
              <div className="txn-detail-row">
                <dt>÷ (1 − tax)</dt>
                <dd>{pct(plan.taxRate)} tax</dd>
              </div>
            )}
            <div className="txn-detail-row">
              <dt>÷ withdrawal rate</dt>
              <dd>{pct(plan.withdrawalRate)}</dd>
            </div>
            <div className="txn-detail-row">
              <dt>{plan.fiNumber !== null ? 'Worked out' : 'FI number'}</dt>
              <dd>
                <Masked>{money(worked)}</Masked>
              </dd>
            </div>
          </dl>
          <p className="helper">Each is a row on Your figures, or under Assumptions.</p>
        </section>
      )}
      {names.length > 0 && (
        <Why label="What it leaves out">
          <p>
            {names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}: your path and Will it last? count {names.length === 1 ? 'it' : 'them'}.
          </p>
        </Why>
      )}
      {plan.start === 'fi-number' && <p className="helper">Will it last? starts from this number.</p>}
      <div className="sheet-form">
        <label className="field">
          Use your own number
          <input type="number" inputMode="decimal" value={own} onChange={(e) => setOwn(e.target.value)} placeholder={NO_EXAMPLE} {...s.field('Your own number')} disabled={s.saving} />
        </label>
        {s.under('Your own number')}
        <p className="helper">Set, your FI date and Home use it, and Will it last? tests your spending from it. Nothing else changes.</p>
      </div>
      {plan.fiNumber !== null && (
        <button type="button" className="btn ghost" disabled={s.disabled} onClick={() => s.save(() => ({ ...plan, fiNumber: null }))}>
          Use the worked-out number
        </button>
      )}
      {s.error && (
        <Notice level="critical" role="alert">
          {s.error}
        </Notice>
      )}
      <Buttons
        copy={props.copy}
        paused={props.paused}
        onDone={props.onDone}
        disabled={s.disabled}
        saving={s.saving}
        onSave={() => s.save(() => ({ ...plan, fiNumber: own.trim() === '' ? null : ownFiNumber(own) }))}
      />
    </>
  );
}

export type FigureKind = 'spending' | 'savings' | 'assets';

const FIGURE_TEXT: Record<FigureKind, { title: string; field: string; note: string }> = {
  spending: {
    title: 'Annual spending',
    field: 'Spending a year',
    note: "Nya adds up a year of money out, leaving out transfers between your own accounts and card payments (they settle purchases already counted). Unlike the Activity tab it counts mortgage, car, student and personal loan payments, whose principal is spending until the loan ends, and cash withdrawals, and takes refunds in spending categories off. Type your own if you expect to spend differently once you stop working, after a mortgage ends, say.",
  },
  savings: {
    title: 'Annual savings',
    field: 'Savings a year',
    note: "An estimate: a year of income minus spending, plus what went into workplace plans Nya can see (a 401(k) and the like, employer's match included). Contributions to a workplace plan Nya can't see never reach a bank account, so add them if you type your own.",
  },
  assets: {
    title: 'Invested assets',
    field: 'Invested assets',
    note: 'Your investment accounts as the Accounts tab shows them, without hidden accounts. Debts are not subtracted.',
  },
};

/** Said after that note with a child's accounts out (D7). */
const CHILD_ACCOUNTS_NOTE = ' Accounts for a child’s education are left out unless you count one.';

type CountedAccount = { account_id: string; name: string; institution: string; balance: number; currency?: string | null };

const SAVINGS_BUCKETS: readonly SavingsBucket[] = ['taxable', 'tax-deferred', 'roth', 'hsa'];

/** The measured split's buckets, for the override to start from. */
const savingsByBucket = (split: SavingsSplit) => byBucket(split).filter((s): s is { bucket: SavingsBucket; share: number } => (SAVINGS_BUCKETS as readonly TaxBucket[]).includes(s.bucket));

/** A split in its fields, as whole percents where it can be. */
function splitFields(rows: readonly { bucket: SavingsBucket; share: number }[]): Record<SavingsBucket, string> {
  const text = (b: SavingsBucket) => {
    const row = rows.find((r) => r.bucket === b);
    return row ? String(Math.round(row.share * 1000) / 10) : '';
  };
  return { taxable: text('taxable'), 'tax-deferred': text('tax-deferred'), roth: text('roth'), hsa: text('hsa') };
}

/** The split as typed, each share over 0, or what is wrong. */
function readSplit(text: Record<SavingsBucket, string>): { bucket: SavingsBucket; share: number }[] {
  const rows = SAVINGS_BUCKETS.map((bucket) => ({ bucket, share: readNumber(text[bucket], BUCKET_NAMES[bucket], 0, 1, { scale: 0.01, optional: true }) ?? 0 }));
  const total = rows.reduce((sum, r) => sum + r.share, 0);
  if (Math.abs(total - 1) > 1e-6) throw new FieldProblem(`These add up to ${Math.round(total * 1000) / 10}%, not 100%.`, SAVINGS_BUCKETS.map((b) => BUCKET_NAMES[b]));
  return rows.filter((r) => r.share > 0);
}

export function FigureForm(
  props: SaveProps & {
    kind: FigureKind;
    measured: number | null;
    measuredText: string;
    /** How the measured figure was worked out (components/plan-figure-notes.ts),
     *  behind Why? under it; null when there is nothing more to say. */
    why?: string | null;
    currency: string | null;
    /** Invested assets with or without cash, so the total follows the box as it is ticked. */
    assetsFor?: (includeCash: boolean) => { total: number | null; accounts: CountedAccount[] };
    /** Savings: the workplace plans whose contributions are measured, each
     *  with how it is paid into. */
    workplacePlans?: { account_id: string; label: string }[];
    /** Invested assets by tax bucket. */
    buckets?: BucketSheet;
    /** Where a year of savings goes. */
    split?: SavingsSplit | null;
    /** The mix at the start age, in a line; null when it can't be worked out. */
    mix?: string | null;
    /** Under a detailed plan: Annual savings' override per bucket. */
    detail?: DetailForm | null;
  }
) {
  const { plan, kind } = props;
  const typedNow = plan[kind];
  const [mode, setMode] = useState<'measured' | 'typed'>(typedNow === null && props.measured !== null ? 'measured' : 'typed');
  const [text, setText] = useState(asText(typedNow ?? (props.measured === null ? null : Math.round(props.measured))));
  const [includeCash, setIncludeCash] = useState(plan.includeCash);
  // How each workplace plan is paid into, by account id; absent is not set.
  const [funding, setFunding] = useState(() => new Map(plan.planFunding.map((f) => [f.account_id, f.paidFrom])));
  const plans = kind === 'savings' ? (props.workplacePlans ?? []) : [];
  // What is set here, plus what was set before for a plan not listed now
  // (hidden, or disconnected for a while), as long as it fits.
  const planFunding = (): PlanFunding[] => {
    const listed = new Set(plans.map((p) => p.account_id));
    const here = plans.flatMap((p) => {
      const paidFrom = funding.get(p.account_id);
      return paidFrom ? [{ account_id: p.account_id, paidFrom }] : [];
    });
    return [...here, ...plan.planFunding.filter((f) => !listed.has(f.account_id))].slice(0, LIMITS.planFunding);
  };
  const detail = kind === 'savings' ? (props.detail ?? null) : null;
  const { s, more } = useDetailSave(props, detail);
  // Where a year of savings goes: as measured, or your own by bucket.
  const chosenSplit = detail?.choices.savingsSplit ?? null;
  const [splitMode, setSplitMode] = useState<'measured' | 'typed'>(chosenSplit ? 'typed' : 'measured');
  const [splitText, setSplitText] = useState<Record<SavingsBucket, string>>(() => splitFields(chosenSplit ?? (props.split ? savingsByBucket(props.split) : [])));
  const t = FIGURE_TEXT[kind];
  const live = kind === 'assets' && props.assetsFor ? props.assetsFor(includeCash) : null;
  const measured = live ? live.total : props.measured;
  const measuredText = live ? `from ${live.accounts.length} account${live.accounts.length === 1 ? '' : 's'}` : props.measuredText;
  // Said of the figure as the plan measures it now: for assets, not once the
  // cash box says otherwise.
  const why = props.why && (kind !== 'assets' || includeCash === plan.includeCash) ? props.why : null;
  const range = kind === 'savings' ? [-LIMITS.money, LIMITS.money] : kind === 'assets' ? [0, LIMITS.balance] : [0, LIMITS.money];
  const sheet = props.buckets ?? null;
  const today = kind === 'assets' && sheet ? sheet.bucketsFor(includeCash) : null;
  const level = (kind === 'assets' && sheet?.level) || null;
  const money = (n: number) => wholeMoney(n, props.currency);
  return (
    <>
      {/* A level of the drawer over the form, which stays, so what was typed in
          it is there on the way back. */}
      {level && sheet && today && <BucketLevel level={level} today={today} sheet={sheet} money={money} />}
      <div hidden={!!level}>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {t.note}
        {kind === 'assets' && props.childOut ? CHILD_ACCOUNTS_NOTE : ''}
      </p>
      <Choice
        label={t.title}
        value={mode}
        onChange={setMode}
        options={[
          ['measured', 'Nya’s figure'],
          ['typed', 'My own'],
        ]}
      />
      {mode === 'measured' ? (
        <>
          <p className="panel-note">
            {measured === null ? (
              'Nya has nothing to measure this from yet, so the plan leaves it out until you type your own.'
            ) : today && sheet ? (
              <>
                <Masked>{headLine(measured, today.groups.reduce((n, g) => n + g.accounts.length, 0), sheet.asOf, money)}</Masked> Each account&rsquo;s bucket comes from its type; change one that is in another.
              </>
            ) : (
              <>
                <strong>
                  <Masked>{wholeMoney(measured, props.currency)}</Masked>
                </strong>{' '}
                {measuredText}
              </>
            )}
          </p>
          {measured !== null && why && (
            <Why>
              <Masked>{why}</Masked>
            </Why>
          )}
        </>
      ) : (
        <div className="sheet-form">
          <label className="field">
            {t.field}
            <input
              type="number"
              inputMode="decimal"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={NO_EXAMPLE}
              {...s.field(t.field)}
              disabled={s.saving}
            />
          </label>
          {s.under(t.field)}
        </div>
      )}
      {kind === 'assets' && (
        <>
          <label className="plan-check">
            <input type="checkbox" checked={includeCash} onChange={(e) => setIncludeCash(e.target.checked)} disabled={s.saving || !!props.copy} />
            Count checking and savings accounts too
          </label>
          {props.copy && <p className="panel-note">Counting cash is how your figures are measured: {SAME_IN_EVERY_PLAN}</p>}
          {today && sheet && (today.groups.length > 0 || today.leftOut.accounts.length > 0 || today.roth.length > 0) && (
            <>
              {mode === 'typed' && (today.groups.length > 0 || today.leftOut.accounts.length > 0) && <p className="panel-note">Your own figure is shared out as these accounts are.</p>}
              <BucketGroups today={today} sheet={sheet} mix={props.mix ?? null} money={money} />
            </>
          )}
          {!today && live && live.accounts.length > 0 && mode === 'measured' && (
            <ul className="plan-accounts">
              {live.accounts.map((a) => (
                <li key={a.account_id}>
                  <span>
                    {a.name} <span className="plan-muted">· {a.institution}</span>
                  </span>
                  <span className="num">
                    <Masked>{wholeMoney(a.balance, a.currency ?? props.currency)}</Masked>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {plans.length > 0 && (
        <>
          <p className="panel-note">
            How each workplace plan is paid into. <strong>Payroll</strong>: every contribution is added, since it comes out
            of your pay before it reaches a bank. <strong>My bank</strong>: none is, since the transfers that paid for them
            already count as saved (a Solo 401(k), say). <strong>Not set</strong>: a contribution is added unless a
            transfer from your bank to investment and retirement funds paid for it.
          </p>
          {plans.map((p) => (
            <div key={p.account_id} className="plan-funding">
              <div className="plan-funding-name">{p.label}</div>
              <Choice
                label={`How ${p.label} is paid into`}
                value={funding.get(p.account_id) ?? 'unset'}
                disabled={s.saving || !!props.copy}
                onChange={(v) =>
                  setFunding((m) => {
                    const next = new Map(m);
                    if (v === 'unset') next.delete(p.account_id);
                    else next.set(p.account_id, v);
                    return next;
                  })
                }
                options={[
                  ['unset', 'Not set'],
                  ['payroll', 'Payroll'],
                  ['bank', 'My bank'],
                ]}
              />
            </div>
          ))}
        </>
      )}
      {kind === 'savings' && sheet && props.split && !detail && <SavingsSplitLines split={props.split} reading={sheet.reading} />}
      {kind === 'savings' && sheet && detail && (
        <section className="stack tight">
          <h3 className="section-label">Where it goes</h3>
          <Choice
            label="Where it goes"
            value={splitMode}
            onChange={setSplitMode}
            disabled={s.saving}
            options={[
              ['measured', 'Nya’s figure'],
              ['typed', 'My own'],
            ]}
          />
          {splitMode === 'measured' ? (
            props.split ? (
              <SavingsSplitLines split={props.split} reading={sheet.reading} heading={false} />
            ) : (
              <p className="helper">{splitNote('none')}</p>
            )
          ) : (
            <>
              <div className="sheet-form">
                {SAVINGS_BUCKETS.map((b) => (
                  <label className="field" key={b}>
                    {BUCKET_NAMES[b]}
                    <input
                      type="number"
                      inputMode="decimal"
                      data-percent
                      step="1"
                      value={splitText[b]}
                      onChange={(e) => setSplitText((m) => ({ ...m, [b]: e.target.value }))}
                      {...s.field(BUCKET_NAMES[b])}
                      disabled={s.saving}
                    />
                    {s.under(BUCKET_NAMES[b])}
                  </label>
                ))}
              </div>
              <p className="helper">Each bucket’s share of what you save, adding up to 100%. A plan’s own: only this plan takes it.</p>
            </>
          )}
        </section>
      )}
      {s.error && (
        <Notice level="critical" role="alert">
          {s.error}
        </Notice>
      )}
      <Buttons
        copy={props.copy}
        also={props.also}
        alsoIn={s.alsoIn}
        onAlso={s.setAlsoIn}
        paused={props.paused}
        onDone={props.onDone}
        disabled={s.disabled}
        saving={s.saving}
        onSave={() =>
          s.save(() => {
            if (detail) {
              const savingsSplit = splitMode === 'measured' ? null : readSplit(splitText);
              more.current = JSON.stringify(savingsSplit) === JSON.stringify(detail.choices.savingsSplit) ? {} : { tax: { ...detail.choices, savingsSplit } };
            }
            return {
              ...plan,
              [kind]: mode === 'measured' ? null : readNumber(text, t.field, range[0], range[1]),
              includeCash: kind === 'assets' ? includeCash : plan.includeCash,
              planFunding: kind === 'savings' ? planFunding() : plan.planFunding,
            };
          })
        }
      />
      </div>
    </>
  );
}

const RULE_ORDER: RuleKind[] = ['constant', 'guardrails', 'floor-ceiling', 'percent', 'vpw'];

/** A rate typed as a percent, or `saved` while the field doesn't hold one in
 *  range: what the sentences beside the fields read as they are typed. */
function typedRate(text: string, [min, max]: readonly [number, number], saved: number): number {
  const t = text.trim();
  const n = t === '' ? NaN : Number(t) / 100;
  return Number.isFinite(n) && n >= min - 1e-12 && n <= max + 1e-12 ? n : saved;
}

/** The rate the simulation withdraws at when it doesn't start with the FI
 *  number: your spending, grossed up for tax, as a share of the balance it
 *  starts with (lib/fire/plan.ts enginePlan); null when either isn't known. */
function startRate(start: FirePlan['start'], props: { assets: number | null; spending: number | null }, typed: number, tax: number): number | null {
  if (start === 'fi-number' || start === 'at-stop') return null;
  const balance = start === 'assets' ? props.assets : Number.isFinite(typed) && typed > 0 ? typed : null;
  return props.spending !== null && balance ? props.spending / (1 - tax) / balance : null;
}

/** What a start choice means for the plan: when it stops working, and what
 *  the first year withdraws. Starting with the FI number withdraws the plan's
 *  rate of it (your spending, by construction); starting from anything else
 *  withdraws your spending, at whatever rate that is of the balance
 *  (lib/fire/plan.ts). `rate` and `tax` are the ones typed. */
function startConsequence(
  start: FirePlan['start'],
  plan: PlanCore,
  props: { assets: number | null; spending: number | null; currency: string | null },
  typed: number,
  rate: number,
  tax: number,
  /** A detailed plan's rate at this start, once worked out: what it withdraws isn't
   *  your spending alone. */
  drawn: number | null = null
): string {
  const money = (n: number) => wholeMoney(n, props.currency);
  const spend = props.spending !== null ? `your spending of ${money(props.spending)} a year` : 'your spending';
  if (drawn !== null) {
    const how = start === 'fi-number' ? 'at your stop age with your FI number' : start === 'assets' ? `today${plan.age !== null ? `, at ${plan.age},` : ''} with what you have now` : start === 'at-stop' ? 'at your stop age with what you’d have then' : 'at your stop age with the balance you type';
    return `Stops working ${how}, withdrawing ${pct(drawn, 1)} of it a year: ${spend} and health coverage, with their tax${drawn > rate * 1.001 ? `. Your FI number assumes ${pct(rate)}` : ''}.`;
  }
  if (start === 'fi-number') {
    const stop = stopOf(plan);
    return `Stops working at your stop age${stop !== null ? ` (${stop})` : ''} with your FI number, withdrawing ${pct(rate)} of it: ${spend}.`;
  }
  const actual = startRate(start, props, typed, tax);
  const when = start === 'assets' ? `today${plan.age !== null ? `, at ${plan.age},` : ''} with what you have now` : start === 'at-stop' ? 'at your stop age with what you’d have then' : `at your stop age with the balance you type`;
  return `Stops working ${when}, spending ${spend}${actual !== null ? `: a ${pct(actual, 1)} withdrawal rate${actual > rate * 1.001 ? `, above the ${pct(rate)} your FI number assumes` : ''}` : ''}. Answers whether what you spend now would have lasted.`;
}

/** Whether the starting balance field still says what is saved. */
const startBalanceSame = (typed: string, plan: Pick<PlanCore, 'startBalance'>) => typed === asText(plan.startBalance);

/** Which part of the Assumptions sheet to open at: the stress test's
 *  settings, or its mix (filled in from your allocation). */
export type AssumptionsAt = 'stress' | 'mix';

/**
 * Assumptions (rollout phase 6d): every rate and setting the plan uses, in
 * one sheet, each with what it changes under it. The FI number's (the
 * withdrawal rate, growth after inflation, tax, part-time income), then the
 * stress test's (method, rule, where it starts, length, mix, rebalancing,
 * fees), under Drawdown. One Save saves the whole plan. Opened at the stress
 * test's part from Drawdown's row, and at its mix, filled in from your allocation,
 * from Portfolio's "Use my allocation in the plan": nothing changes until
 * Save.
 */
export function AssumptionsForm(
  props: SaveProps & {
    /** The spending the FI number rests on (with lasting changes, its spending in
     *  retirement); null when the plan shown isn't worked out. */
    fiSpending: number | null;
    assets: number | null;
    spending: number | null;
    currency: string | null;
    /** The mix the allocation gives (components/AllocationCard.tsx), offered
     *  to fill in, with what it is of and what it leaves out: nothing changes
     *  until Save. Null when there is none. */
    allocationMix?: (PlanMix & { ok: true }) | null;
    /** The part to open at; null or left out, the top. */
    at?: AssumptionsAt | null;
    /** Detailed tax is saved and can't be worked out here, so the rate below
     *  is what counts (components/plan-figure-notes.ts). */
    taxOnHold?: boolean;
    /** A detailed plan's fields. */
    detail?: DetailForm | null;
    /** The rate a detailed plan withdraws at, as stored: null until worked out. */
    drawnRate?: number | null;
    /** Back to one flat rate, for every plan; null in a copy. */
    onFlatRate?: (() => Promise<true | string>) | null;
    /** The flag is on: What I'd have at my stop age can be chosen. */
    planTax?: boolean;
    /** The default growth, in points. */
    defaultGrowth?: number;
    /** What the accounts' year measured as a yield, for the field's placeholder. */
    measuredYield?: number | null;
  }
) {
  const { plan, at = null } = props;
  const offer = props.allocationMix ?? null;
  const fill = at === 'mix' && offer !== null;
  const [rate, setRate] = useState(pctText(plan.withdrawalRate));
  const [ret, setRet] = useState(pctText(plan.realReturn));
  const [tax, setTax] = useState(pctText(plan.taxRate));
  const [partTime, setPartTime] = useState(plan.partTimeIncome ? String(plan.partTimeIncome) : '');
  const [method, setMethod] = useState(plan.method);
  const [rule, setRule] = useState<RuleKind>(plan.rule);
  const [start, setStart] = useState(plan.start);
  const [balance, setBalance] = useState(asText(plan.startBalance));
  const [horizon, setHorizon] = useState(asText(plan.horizon));
  const [stocks, setStocks] = useState(String(fill ? offer.stocksPct : plan.stocksPct));
  const [bonds, setBonds] = useState(String(fill ? offer.bondsPct : plan.bondsPct));
  const [rebalance, setRebalance] = useState(plan.rebalance);
  const [fee, setFee] = useState(pctText(plan.fee));
  const [floor, setFloor] = useState(pctText(plan.floor));
  const [ceiling, setCeiling] = useState(pctText(plan.ceiling));
  const detail = props.detail ?? null;
  const [inflation, setInflation] = useState(detail ? pctText(detail.choices.inflation) : '');
  const [growth, setGrowth] = useState(detail?.choices.health.growth != null ? String(Number((detail.choices.health.growth * 100).toFixed(2))) : '');
  const [taxableYield, setTaxableYield] = useState(detail?.choices.taxableYield != null ? pctText(detail.choices.taxableYield) : '');
  const [flatting, setFlatting] = useState(false);
  const [flatError, setFlatError] = useState<string | null>(null);
  const { s, more } = useDetailSave(props, detail);
  const cash = 100 - (Number(stocks) || 0) - (Number(bonds) || 0);
  const mix = { ...plan, stocksPct: Number(stocks) || 0, bondsPct: Number(bonds) || 0 };
  const expected = cash >= 0 ? vpwExpectedReturn(allocationOf(mix)) : 0;
  // The rate and tax as typed, for the sentences that read them, and the FI
  // number at them (lib/fire/fi.ts). The rule is said at the rate the
  // simulation withdraws at: the withdrawal rate when it starts with the FI
  // number, else what your spending is of the balance it starts with.
  const rateNow = typedRate(rate, LIMITS.withdrawalRate, plan.withdrawalRate);
  const taxNow = typedRate(tax, LIMITS.taxRate, plan.taxRate);
  const fiNumber = props.fiSpending === null ? null : fiNumberOf(props.fiSpending, rateNow, taxNow);
  // A detailed plan's as it stands: another start's isn't worked out until it is saved.
  const drawnNow = detail && start === plan.start && startBalanceSame(balance, plan) ? (props.drawnRate ?? null) : null;
  const ruleRate = drawnNow ?? startRate(start, props, Number(balance), taxNow) ?? rateNow;

  // Opened at a part: the sheet's body is scrolled to it. Set on the body
  // alone (never scrollIntoView, which would scroll the page behind too, as
  // the sheet hasn't locked it yet when this runs); the sheet takes focus
  // without scrolling, so this stays.
  const stressRef = useRef<HTMLHeadingElement | null>(null);
  const mixRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = at === 'mix' ? mixRef.current : at === 'stress' ? stressRef.current : null;
    let body: Element | null = el?.parentElement ?? null;
    while (body && !(body.getAttribute('class') ?? '').split(' ').includes('sheet-body')) body = body.parentElement;
    if (el && body) body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top;
    // Only as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function build(): FirePlanV2 {
    const stocksPct = readNumber(stocks, 'Stocks', 0, 100, { integer: true }) as number;
    const bondsPct = readNumber(bonds, 'Bonds', 0, 100, { integer: true }) as number;
    if (stocksPct + bondsPct > 100) throw new FieldProblem('Stocks and bonds add up to more than 100%.', ['Stocks', 'Bonds']);
    if (detail) {
      const tax: TaxChoices = {
        ...detail.choices,
        inflation: readNumber(inflation, 'Inflation', 0, 0.2, { scale: 0.01 }) as number,
        taxableYield: readNumber(taxableYield, 'The taxable yield', 0, 0.2, { scale: 0.01, optional: true }),
        health: { ...detail.choices.health, growth: readNumber(growth, 'How fast health costs rise', -5, 10, { scale: 0.01, optional: true }) },
      };
      more.current = JSON.stringify(tax) === JSON.stringify(detail.choices) ? {} : { tax };
    }
    return {
      ...plan,
      withdrawalRate: readNumber(rate, 'The withdrawal rate', ...LIMITS.withdrawalRate, { scale: 0.01 }) as number,
      realReturn: readNumber(ret, 'Growth after inflation', ...LIMITS.realReturn, { scale: 0.01 }) as number,
      taxRate: readNumber(tax, 'The tax rate', ...LIMITS.taxRate, { scale: 0.01 }) as number,
      partTimeIncome: readNumber(partTime, 'Part-time income', 0, LIMITS.money, { optional: true }) ?? 0,
      method,
      rule,
      start,
      startBalance: start === 'custom' ? readNumber(balance, 'The starting balance', 0, LIMITS.balance) : plan.startBalance,
      horizon: readNumber(horizon, 'The length', ...LIMITS.horizon, { integer: true, optional: true }),
      stocksPct,
      bondsPct,
      rebalance,
      fee: readNumber(fee, 'The fee', ...LIMITS.fee, { scale: 0.01 }) as number,
      floor: rule === 'floor-ceiling' ? (readNumber(floor, 'The floor', ...LIMITS.floor, { scale: 0.01 }) as number) : plan.floor,
      ceiling: rule === 'floor-ceiling' ? (readNumber(ceiling, 'The ceiling', ...LIMITS.ceiling, { scale: 0.01 }) as number) : plan.ceiling,
    };
  }

  return (
    <div className="plan-assumptions-form">
      <h3 className="plan-heading">FI number</h3>
      <div className="sheet-form">
        <label className="field">
          Withdrawal rate (% a year)
          <input
            type="number"
            inputMode="decimal"
            data-percent
            step="0.1"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            {...s.field('The withdrawal rate')}
            disabled={s.saving}
          />
        </label>
        {s.under('The withdrawal rate')}
        <p className="helper">
          {detail
            ? 'How much you’d draw each year, as a share of what you have: it sets the FI number (spending divided by it). What the simulation withdraws comes from your spending, health coverage and their tax.'
            : "How much you'd draw each year, as a share of what you have: it sets the FI number (spending divided by it) and the rate the simulation tests."}
        </p>
        <label className="field">
          Growth after inflation until FI (% a year)
          <input
            type="number"
            inputMode="decimal"
            data-percent
            step="0.5"
            value={ret}
            onChange={(e) => setRet(e.target.value)}
            {...s.field('Growth after inflation')}
            disabled={s.saving}
          />
        </label>
        {s.under('Growth after inflation')}
        <p className="helper">Only for the years until FI: years to FI, Coast FI and the balance at your stop age. The simulation uses market history instead.</p>
        <label className="field">
          Tax on withdrawals (% of each withdrawal)
          <input
            type="number"
            inputMode="decimal"
            data-percent
            step="1"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            {...s.field('The tax rate')}
            disabled={s.saving}
          />
        </label>
        {s.under('The tax rate')}
        {props.taxOnHold && <Notice level="caution">{taxOnHoldText(plan.taxRate)}</Notice>}
        {detail ? (
          <>
            <p className="helper">Your FI number still uses this rate. Drawdown works tax out from your accounts.</p>
            {props.onFlatRate ? (
              <div>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={flatting || s.saving}
                  onClick={async () => {
                    setFlatting(true);
                    setFlatError(null);
                    const r = await props.onFlatRate!();
                    setFlatting(false);
                    if (r === true) props.onDone();
                    else setFlatError(r);
                  }}
                >
                  {flatting ? 'Saving…' : 'Use a flat rate instead'}
                </button>
              </div>
            ) : (
              <p className="helper">Working tax out from your accounts is {SAME_IN_EVERY_PLAN}</p>
            )}
            {flatError && (
              <Notice level="critical" role="alert">
                {flatError}
              </Notice>
            )}
          </>
        ) : (
          <p className="helper">A flat share of every withdrawal: the FI number, and what the simulation withdraws, are larger to pay it.</p>
        )}
        <label className="field">
          Part-time income for Barista FI (a year, after tax)
          <input
            type="number"
            inputMode="decimal"
            value={partTime}
            onChange={(e) => setPartTime(e.target.value)}
            placeholder="None"
            {...s.field('Part-time income')}
            disabled={s.saving}
          />
        </label>
        {s.under('Part-time income')}
        <p className="helper">{props.copy ? 'This copy’s own. ' : ''}Barista FI assumes full-time saving until FI, so a part-time item before you stop doesn’t move it. Part-time work you expect goes on your Timeline.</p>
      </div>

      <h3 className="plan-heading" ref={stressRef}>
        Drawdown
      </h3>
      <div className="sheet-form">
        {detail && (
          <>
            <label className="field">
              Inflation (% a year)
              <input type="number" inputMode="decimal" data-percent step="0.5" value={inflation} onChange={(e) => setInflation(e.target.value)} {...s.field('Inflation')} disabled={s.saving} />
            </label>
            {s.under('Inflation')}
            <p className="helper">For what the tax law doesn’t index, and income that doesn’t keep up with prices.</p>
            <label className="field">
              Health costs rise faster than prices by (points a year)
              <input type="number" inputMode="decimal" step="0.1" value={growth} onChange={(e) => setGrowth(e.target.value)} placeholder={String(props.defaultGrowth ?? '')} {...s.field('How fast health costs rise')} disabled={s.saving} />
            </label>
            {s.under('How fast health costs rise')}
            <p className="helper">Empty is the default, from CMS’s projections, the same field as on Health coverage.</p>
            <label className="field">
              Dividends and interest on taxable accounts (% a year)
              <input type="number" inputMode="decimal" data-percent step="0.1" value={taxableYield} onChange={(e) => setTaxableYield(e.target.value)} placeholder={props.measuredYield != null ? pct(props.measuredYield, 1) : 'None measured'} {...s.field('The taxable yield')} disabled={s.saving} />
            </label>
            {s.under('The taxable yield')}
            <p className="helper">{props.measuredYield != null ? 'Empty is what your accounts paid over the last year.' : 'Empty counts none: nothing over the last year says what they pay, so taxes on it are left out.'}</p>
          </>
        )}
        <label className="field">
          Method
          <select value={method} onChange={(e) => setMethod(e.target.value as FirePlan['method'])} disabled={s.saving || !!props.copy}>
            <option value="historical">{METHOD_NAMES.historical}</option>
            <option value="monte-carlo">{METHOD_NAMES['monte-carlo']}</option>
          </select>
        </label>
        {props.copy && <p className="helper">The method is {SAME_IN_EVERY_PLAN}</p>}
        <p className="helper">
          {method === 'historical'
            ? 'Starts the plan in every month since 1871 that leaves all of it inside the data, and lives through what followed.'
            : `${plainNumber(DEFAULT_RUNS)} runs, each built from ${BLOCK_MONTHS / 12}-year blocks of months drawn at random from the same history: more sequences than history holds, spread wider. They are drawn the same way each time (seed ${DEFAULT_SEED}), so the same plan gives the same answer.`}
        </p>
        <label className="field">
          Withdrawal rule
          <select value={rule} onChange={(e) => setRule(e.target.value as RuleKind)} disabled={s.saving}>
            {RULE_ORDER.map((k) => (
              <option key={k} value={k}>
                {RULE_NAMES[k]}
              </option>
            ))}
          </select>
        </label>
        <p className="helper">
          {ruleText(rule, { rate: ruleRate, floor: Number(floor) / 100 || plan.floor, ceiling: Number(ceiling) / 100 || plan.ceiling, expectedReturn: expected })} Withdrawals once a
          year, at the start of the year.
        </p>
        {rule === 'floor-ceiling' && (
          <div className="plan-pair">
            <label className="field">
              Floor (% of the first year)
              <input
                type="number"
                inputMode="decimal"
                data-percent
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
                {...s.field('The floor')}
                disabled={s.saving}
              />
            </label>
            <label className="field">
              Ceiling (% of the first year)
              <input
                type="number"
                inputMode="decimal"
                data-percent
                value={ceiling}
                onChange={(e) => setCeiling(e.target.value)}
                {...s.field('The ceiling')}
                disabled={s.saving}
              />
            </label>
          </div>
        )}
        {s.under('The floor', 'The ceiling')}
        <label className="field">
          Start with
          <select value={start} onChange={(e) => setStart(e.target.value as FirePlan['start'])} disabled={s.saving}>
            {[
              // Your own FI number, where one is set, is the one it starts with.
              plan.fiNumber != null
                ? ['fi-number', `Your own FI number (${wholeMoney(plan.fiNumber, props.currency)})`]
                : ['fi-number', `FI number${fiNumber !== null ? ` (${wholeMoney(fiNumber, props.currency)})` : ''}`],
              ['assets', `Invested assets${props.assets !== null ? ` (${wholeMoney(props.assets, props.currency)})` : ''}`],
            ].map(([value, text]) => (
              <option key={value} value={value} aria-label={spokenLabel(text)}>
                {text}
              </option>
            ))}
            <option value="custom">A balance I type</option>
            {(props.planTax || plan.start === 'at-stop') && <option value="at-stop">What I’d have at my stop age</option>}
          </select>
        </label>
        <p className="helper">
          <Masked>{startConsequence(start, plan, props, Number(balance), rateNow, taxNow, drawnNow)}</Masked>
        </p>
        {start === 'custom' && (
          <label className="field">
            Starting balance
            <input
              type="number"
              inputMode="decimal"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              placeholder={NO_EXAMPLE}
              {...s.field('The starting balance')}
              disabled={s.saving}
            />
          </label>
        )}
        {s.under('The starting balance')}
        <label className="field">
          Length in years (empty: to age 95, or 30 years without an age)
          <input
            type="number"
            inputMode="numeric"
            value={horizon}
            onChange={(e) => setHorizon(e.target.value)}
            placeholder="To age 95"
            {...s.field('The length')}
            disabled={s.saving}
          />
        </label>
        {s.under('The length')}
        <div className="plan-pair" ref={mixRef}>
          <label className="field">
            Stocks %
            <input type="number" inputMode="numeric" value={stocks} onChange={(e) => setStocks(e.target.value)} {...s.field('Stocks')} disabled={s.saving} />
          </label>
          <label className="field">
            Bonds %
            <input type="number" inputMode="numeric" value={bonds} onChange={(e) => setBonds(e.target.value)} {...s.field('Bonds')} disabled={s.saving} />
          </label>
        </div>
        {s.under('Stocks', 'Bonds')}
        <p className="helper">
          {cash >= 0 ? `Cash: ${cash}%, which keeps up with inflation and earns nothing more.` : 'Stocks and bonds add up to more than 100%.'}{' '}
          <Masked>
            {offer ? `${mixBasisText(offer, props.currency)}: ${mixText(offer)}.` : "Nya doesn't look inside funds it doesn't know, so set the mix you hold, or classify them under Allocation."}
          </Masked>
        </p>
        {/* What the mix leaves out, beside the button that fills it in. */}
        {offer && mixLeftOutText(offer, props.currency) && (
          <p className="helper">
            <Masked>{mixLeftOutText(offer, props.currency)}</Masked>
          </p>
        )}
        {(Number(stocks) !== plan.stocksPct || Number(bonds) !== plan.bondsPct) && (
          <p className="helper">Your plan&apos;s simulation uses {mixText({ stocksPct: plan.stocksPct, bondsPct: plan.bondsPct })} until you save.</p>
        )}
        {offer && <p className="helper">The plan keeps this mix until you change it: it doesn&apos;t follow your accounts. Stocks of every region count as stocks.</p>}
        {offer && (offer.stocksPct !== Number(stocks) || offer.bondsPct !== Number(bonds)) && (
          <div className="btn-row">
            <button
              type="button"
              className="btn secondary"
              disabled={s.saving}
              onClick={() => {
                setStocks(String(offer.stocksPct));
                setBonds(String(offer.bondsPct));
              }}
            >
              Fill in my allocation
            </button>
          </div>
        )}
        <label className="field">
          Rebalancing
          <select value={rebalance} onChange={(e) => setRebalance(e.target.value as FirePlan['rebalance'])} disabled={s.saving}>
            <option value="annual">Every year</option>
            <option value="monthly">Every month</option>
            <option value="none">Never (the mix drifts with the markets)</option>
          </select>
        </label>
        <label className="field">
          Fund fees (% a year)
          <input
            type="number"
            inputMode="decimal"
            data-percent
            step="0.01"
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            {...s.field('The fee')}
            disabled={s.saving}
          />
        </label>
        {s.under('The fee')}
      </div>
      {s.error && (
        <Notice level="critical" role="alert">
          {s.error}
        </Notice>
      )}
      <Buttons copy={props.copy} paused={props.paused} onDone={props.onDone} disabled={s.disabled} saving={s.saving} onSave={() => s.save(build)} />
    </div>
  );
}

