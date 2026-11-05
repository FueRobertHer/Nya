'use client';

// The health sheet (the tax plan's D10, D12): how you'd be covered before 65, the ACA's
// parts only for someone on it, Medicare's extras, what already pays for coverage, how
// fast it grows, and each part by stage as the years have it. One Save carries the
// plan's choices and, on your plan, the household's one fact it says (what already
// pays), so both land together. Premiums only, as it says.

import { useId, useMemo, useState } from 'react';
import { stopOf } from '@/lib/fire/plan';
import type { TaxChoices } from '@/lib/fire/tax-choices';
import { MAX_HEALTH_AMOUNT } from '@/lib/fire/tax-choices';
import { householdOf, sameHousehold, type Owner, type TaxFacts, type TaxHousehold } from '@/lib/fire/tax-facts';
import { plainNumber } from '@/lib/format';
import { normalizedAmountText } from '@/lib/manual-txn-input';
import CheckRows from './CheckRows';
import { Masked, NO_EXAMPLE } from './HideAmounts';
import RadioRows from './RadioRows';
import { Buttons, FieldProblem, readNumber, SAME_IN_EVERY_PLAN, useDetailSave, type DetailForm, type SaveProps } from './PlanForms';
import { Notice } from './TotalCaveats';
import { Why } from './Why';

type Paid = NonNullable<TaxFacts['paidToday']>;
export type PaidChoice = Paid & { label: string };
export type StageHealth = { title: string; lines: { label: string; value: string; sum?: boolean }[] };

const paidKey = (p: Paid | null) => (p ? `${p.kind}:${p.name}` : '');

/** A money figure typed in a text field, as the other sheets read it. */
function readMoney(text: string, what: string, optional = false): number | null {
  const t = text.trim();
  if (t === '') {
    if (optional) return null;
    throw new FieldProblem(`${what} is needed.`, [what]);
  }
  const n = Number(normalizedAmountText(t) ?? NaN);
  if (!Number.isFinite(n) || n < 0 || n > MAX_HEALTH_AMOUNT) throw new FieldProblem(`${what} must be a number from 0 to ${plainNumber(MAX_HEALTH_AMOUNT)}.`, [what]);
  return n;
}

const asMoneyText = (n: number | null | undefined) => (n ? String(n) : '');

export default function PlanHealthForm(
  props: SaveProps & {
    detail: DetailForm;
    /** The state's name, and whether it covers adults through Medicaid under 138% of the
     *  poverty line; with no state, whether is not known. */
    stateName: string | null;
    medicaid: boolean;
    /** The default growth, in points, for the field's placeholder. */
    defaultGrowth: number;
    partner: boolean;
    paidChoices: readonly PaidChoice[];
    paidAmount: (paid: Paid) => number;
    stages: readonly StageHealth[];
    money: (n: number) => string;
  }
) {
  const { plan, detail, money } = props;
  const stored = detail.choices.health;
  const before = stored.beforeMedicare;
  const [coverage, setCoverage] = useState<'aca' | 'other' | 'none'>(before?.kind ?? 'none');
  const [adult, setAdult] = useState(before?.kind === 'aca' ? asMoneyText(before.adult) : '');
  const [quotedAge, setQuotedAge] = useState(before?.kind === 'aca' ? String(before.quotedAge) : String(Math.min(64, stopOf(plan) ?? plan.age ?? 50)));
  const [child, setChild] = useState(before?.kind === 'aca' ? asMoneyText(before.child) : '');
  const [yearly, setYearly] = useState(before?.kind === 'other' ? asMoneyText(before.yearly) : '');
  const [acaLaw, setAcaLaw] = useState(stored.acaLaw);
  const [rule, setRule] = useState<Owner[]>(stored.meetsMedicaidRule);
  const [fullPrice, setFullPrice] = useState(stored.countMedicaid);
  const [extra, setExtra] = useState(asMoneyText(stored.medicareExtra));
  const [growth, setGrowth] = useState(stored.growth === null ? '' : String(Number((stored.growth * 100).toFixed(2))));
  const [paysNow, setPaysNow] = useState(detail.facts.paidToday !== null);
  const [paid, setPaid] = useState(paidKey(detail.facts.paidToday));
  const { s, more } = useDetailSave(props, detail);
  const paidId = useId();
  const dependents = detail.facts.dependents.length > 0;

  const held = detail.facts.paidToday;
  const shownChoices = useMemo(() => {
    const has = held && !props.paidChoices.some((c) => c.kind === held.kind && c.name === held.name);
    return has && held ? [{ ...held, label: held.name }, ...props.paidChoices] : props.paidChoices;
  }, [held, props.paidChoices]);
  const chosen = shownChoices.find((c) => paidKey(c) === paid) ?? null;
  const found = useMemo(() => (paysNow && chosen ? props.paidAmount(chosen) : null), [paysNow, chosen?.kind, chosen?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  function build() {
    let beforeMedicare: TaxChoices['health']['beforeMedicare'] = null;
    if (coverage === 'other') beforeMedicare = { kind: 'other', yearly: readMoney(yearly, 'What it costs') as number };
    if (coverage === 'aca') {
      beforeMedicare = {
        kind: 'aca',
        adult: readMoney(adult, 'The benchmark plan') as number,
        quotedAge: readNumber(quotedAge, 'The age it was quoted for', 0, 64, { integer: true }) as number,
        child: dependents ? readMoney(child, 'A child’s benchmark', true) : before?.kind === 'aca' ? before.child : null,
      };
    }
    const tax: TaxChoices = {
      ...detail.choices,
      health: {
        beforeMedicare,
        medicareExtra: readMoney(extra, 'Part D or a supplement', true) ?? 0,
        meetsMedicaidRule: rule,
        countMedicaid: fullPrice,
        acaLaw,
        growth: readNumber(growth, 'How fast it rises', -5, 10, { optional: true, scale: 0.01 }),
      },
    };
    if (paysNow && !chosen) throw new FieldProblem('Pick the category or tag that pays for it.', ['What pays for it']);
    const household: TaxHousehold = { ...householdOf(detail.facts), paidToday: paysNow && chosen ? { kind: chosen.kind, name: chosen.name } : null };
    more.current = {
      ...(JSON.stringify(tax) === JSON.stringify(detail.choices) ? {} : { tax }),
      ...(detail.factsLocked || sameHousehold(household, householdOf(detail.facts)) ? {} : { household }),
    };
    return plan;
  }

  return (
    <div className="stack loose">
      <p className="helper">Coverage through work isn’t in your spending, so after you stop it is a cost of its own. Premiums only: deductibles, coinsurance, dental and vision aren’t counted.</p>
      <RadioRows
        legend="Before 65 you’d be covered through"
        name="plan-coverage"
        value={coverage}
        onChange={(v) => setCoverage(v as typeof coverage)}
        disabled={s.saving}
        options={[
          { value: 'aca', name: 'ACA marketplace', note: 'With its credit and its limit' },
          {
            value: 'other',
            name: 'Something else',
            note: 'A spouse’s job, COBRA or a retiree plan',
            detail: (
              <>
                <label className="field">
                  What it costs, a year
                  <input inputMode="decimal" value={yearly} onChange={(e) => setYearly(e.target.value)} placeholder={NO_EXAMPLE} disabled={s.saving} {...s.field('What it costs')} />
                </label>
                {s.under('What it costs')}
              </>
            ),
          },
          { value: 'none', name: 'Not set yet', note: 'No cost before 65, then Medicare Part B only' },
        ]}
      />
      {coverage === 'aca' && (
        <>
          <div className="sheet-form">
            <label className="field">
              Benchmark plan for one adult, a year, full price
              <input inputMode="decimal" value={adult} onChange={(e) => setAdult(e.target.value)} placeholder={NO_EXAMPLE} disabled={s.saving} {...s.field('The benchmark plan')} />
            </label>
            {s.under('The benchmark plan')}
            <p className="helper">The second-lowest silver plan for one adult, from healthcare.gov. Nya rates it up with age each year, as insurers do, for each person your household holds, and works out the credit from it.</p>
            <label className="field">
              Quoted for age
              <input type="number" inputMode="numeric" value={quotedAge} onChange={(e) => setQuotedAge(e.target.value)} disabled={s.saving} {...s.field('The age it was quoted for')} />
            </label>
            {s.under('The age it was quoted for')}
            {dependents && (
              <>
                <label className="field">
                  One child’s benchmark, a year
                  <input inputMode="decimal" value={child} onChange={(e) => setChild(e.target.value)} placeholder="Not set" disabled={s.saving} {...s.field('A child’s benchmark')} />
                </label>
                {s.under('A child’s benchmark')}
              </>
            )}
          </div>
          <RadioRows
            legend="Credits under"
            name="plan-aca-law"
            value={acaLaw}
            onChange={(v) => setAcaLaw(v as typeof acaLaw)}
            disabled={s.saving}
            helper="In 2026 there is no credit above 400% of the poverty line. The enhanced credits that had no limit ended in 2025; Congress may bring them back."
            options={[
              { value: '2026', name: 'The law in 2026' },
              { value: 'enhanced', name: 'If the enhanced credits return' },
            ]}
          />
          {props.medicaid && (
            <div className="stack tight">
              <CheckRows
                legend="Who’d meet Medicaid’s work rule"
                checked={rule}
                onChange={(keys) => setRule(keys as Owner[])}
                disabled={s.saving}
                rows={[{ key: 'you', title: 'You' }, ...(props.partner ? [{ key: 'partner', title: 'Your partner' }] : [])]}
              />
              <p className="helper">Under 138% of the poverty line {props.stateName ?? 'your state'} covers adults through Medicaid. From 2027 that needs 80 hours a month of work, school or volunteering, or an exemption, and an income of about $580 a month counts, which Nya works out. Without it there is no credit either, so coverage is at full price.</p>
              <CheckRows legend="If you’d qualify" checked={fullPrice ? ['full'] : []} onChange={(keys) => setFullPrice(keys.includes('full'))} disabled={s.saving} rows={[{ key: 'full', title: 'Count full price anyway', sub: 'For a plan that doesn’t lean on Medicaid' }]} />
            </div>
          )}
        </>
      )}
      <div className="sheet-form">
        <label className="field">
          Part D or a supplement, from 65, a year
          <input inputMode="decimal" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="None" disabled={s.saving} {...s.field('Part D or a supplement')} />
        </label>
        {s.under('Part D or a supplement')}
      </div>
      <div className="stack tight">
        <CheckRows
          legend="Already in your spending"
          checked={paysNow ? ['paid'] : []}
          onChange={(keys) => setPaysNow(keys.includes('paid'))}
          disabled={s.saving || detail.factsLocked}
          rows={[{ key: 'paid', title: 'You already pay for coverage from your accounts', sub: 'COBRA, a plan of your own, a retired spouse’s. Nya leaves its category out of your spending as it measures it, so it isn’t counted twice.' }]}
        />
        {detail.factsLocked && <p className="helper">What already pays for coverage is {SAME_IN_EVERY_PLAN}</p>}
        {paysNow && (
          <>
            <label className="field" htmlFor={paidId}>
              What pays for it
              <select id={paidId} value={chosen ? paidKey(chosen) : ''} onChange={(e) => setPaid(e.target.value)} disabled={s.saving || detail.factsLocked} {...s.field('What pays for it')}>
                <option value="">Pick one</option>
                {shownChoices.map((c) => (
                  <option key={paidKey(c)} value={paidKey(c)}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            {s.under('What pays for it')}
            {chosen && found !== null && (
              <p className="helper">
                <Masked>{`${chosen.label} in your spending: ${money(found)} a year, replaced by the coverage below.`}</Masked>
              </p>
            )}
          </>
        )}
      </div>
      <div className="sheet-form">
        <label className="field">
          Health costs rise faster than prices by (points a year)
          <input type="number" inputMode="decimal" step="0.1" value={growth} onChange={(e) => setGrowth(e.target.value)} placeholder={String(props.defaultGrowth)} disabled={s.saving} {...s.field('How fast it rises')} />
        </label>
        {s.under('How fast it rises')}
        <p className="helper">Empty is the default, {props.defaultGrowth} points, from CMS’s projections of health spending, kept with the tax law and reviewed each year. It applies to premiums, Medicare and IRMAA; the ACA’s share of income rises with it, as the law indexes it.</p>
      </div>
      {props.stages.length > 0 && (
        <section className="stack tight" aria-label="Each part by stage">
          <h3 className="section-label">Each part by stage, a year</h3>
          {props.stages.map((st) => (
            <div key={st.title}>
              <p className="helper">
                <Masked>{st.title}</Masked>
              </p>
              <dl className="txn-detail txn-detail-wide">
                {st.lines.map((l) => (
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
            </div>
          ))}
        </section>
      )}
      <Why label="What isn’t counted">
        <p>Below 250% of the poverty line silver plans also lower deductibles and copays; Nya counts the premium only. States that add their own help or a Basic Health Program aren’t counted either.</p>
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
