'use client';

// The What if… card on Your path (rollout phase 8c), under Your figures,
// with your plan shown: life choices as templates. A template opens the life
// event's own form (components/PlanEvents.tsx EventForm) with nothing filled
// in but its name, says how it moves the FI age as it is typed, and "Try
// it" makes a copy of your plan with that life event in it, named after it
// ("Buy a home at 38"), and opens it (the tax plan's C2). The copies are
// listed in the Plans sheet (components/PlansSheet.tsx). With a copy open
// the card isn't drawn: the copy's Life events card takes its place with the
// same choices, each added to the copy, and the same preview (DraftPreview)
// measured against the copy as it is. The words are in
// components/plan-what-if.ts.

import { useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import { CAUTION } from './ConnectionStatus';
import { INFO, LevelWord } from './TotalCaveats';
import { EventForm, type Checked } from './PlanEvents';
import { EVENT_PART_TEXT } from './plan-scenario-text';
import { askAgesText } from './plan-text';
import { plansCount, type PlansState } from './plan-list';
import { WHAT_IF_TEMPLATES, fiWhen, previewText, whatIfName, withDraft, type FiWhen, type WhatIfTemplate } from './plan-what-if';
import { MAX_FIRE_PLANS } from '@/lib/fire/copies';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import type { EventNote, LifeEvent } from '@/lib/fire/events';
import type { Measured } from '@/lib/fire/plan';
import type { Count } from '@/lib/fire/compile';
import { eventsOf, withEvents } from '@/lib/fire/items';
import type { FirePlanV2 } from '@/lib/fire/plan-v2';

/** Said when your plan has no currency to give a copy's amounts. */
const NO_CURRENCY = 'Your plan has no currency yet (no accounts to take it from), so a life choice’s amounts have none: add an account first.';

/** The plan with this event in it (in place of the one it edits, else
 *  added): when it reaches FI, and what of this event is left out and why
 *  (lib/fire/plan-figures.ts). */
function draftOutcome(plan: FirePlanV2, measured: Measured, count: Count, event: LifeEvent): { when: FiWhen; notes: EventNote[] } {
  const f = planFigures(withEvents(plan, withDraft(eventsOf(plan), event)), measured, { count });
  if ('refused' in f) return { when: { kind: 'not-run' }, notes: [] };
  return { when: fiWhen(f), notes: f.itemNotes.filter((n) => n.id === event.id).map(({ id, part }) => ({ id, part })) };
}

/** How a draft moves the FI age, said in its form as it is typed, with what
 *  of it is left out and why: against your plan on the What if… card, and
 *  against the open copy as it is in its Life events card. */
export function DraftPreview({
  checked,
  kind,
  plan,
  measured,
  count,
  against,
  where,
  money,
  children,
}: {
  checked: Checked;
  kind: LifeEvent['kind'];
  /** The plan it goes into: your plan, or the copy open. */
  plan: FirePlanV2;
  measured: Measured;
  count: Count;
  /** What it moves from: that plan's figures now (null when they aren't
   *  worked out). */
  against: PlanFigures | null;
  where: 'what-if' | 'copy';
  money: (n: number) => string;
  /** A last line, under the notes. */
  children?: ReactNode;
}) {
  const draft = 'ok' in checked ? checked.ok : null;
  const d = draft ? draftOutcome(plan, measured, count, draft) : null;
  return (
    <div className="notice info">
      {INFO}
      <div className="stack tight">
        <LevelWord level="info" />
        {/* Only the move is said as it changes, not the lines under it. */}
        <p role="status">
          <Masked>{previewText(d ? d.when : null, fiWhen(against), money, kind, 'missing' in checked && !!checked.missing, where)}</Masked>
        </p>
        {d?.notes.map((n) => (
          <p key={n.part}>{EVENT_PART_TEXT[n.part]}</p>
        ))}
        {draft && children}
      </div>
    </div>
  );
}

export function WhatIfCard({
  shown,
  base,
  baseFigures,
  measured,
  count,
  plans,
  planCurrency,
  planCurrencyKnown,
  editable,
  canOpen,
  money,
  onTry,
  onRetry,
  onAskAge,
  reloading = false,
  askRef,
  firstRef,
}: {
  /** The card is drawn: your plan is shown. Its sheet stays mounted either
   *  way, so one closing as its copy opens slides out. */
  shown: boolean;
  /** Your plan as the tab shows it, loaded. */
  base: FirePlanV2;
  baseFigures: PlanFigures;
  measured: Measured;
  count: Count;
  plans: PlansState;
  planCurrency: string | null;
  /** Whether the Plan's currency is known (lib/fire/plan-currency.ts). */
  planCurrencyKnown: boolean;
  /** Your plan can be changed now: saving nothing, waiting on no repair,
   *  its currency known. */
  editable: boolean;
  /** Copies can be opened now. */
  canOpen: boolean;
  money: (n: number) => string;
  /** Makes a copy of your plan with this event, named `name`, and opens it. */
  onTry: (event: LifeEvent, name: string) => Promise<true | string>;
  /** Loads the plans again, after they failed. */
  onRetry: () => void;
  /** Opens the Ages sheet (the same as the ask under the answer), from the
   *  prompt that leads the card while your age isn't typed. */
  onAskAge?: () => void;
  /** The plan is being read again: the prompt does nothing meanwhile. */
  reloading?: boolean;
  /** The prompt, for focus to come back to as the sheet closes. */
  askRef?: (el: HTMLElement | null) => void;
  /** Where focus goes once the age is saved and the prompt is gone: the
   *  first life choice when it can be tried, otherwise the card's title. */
  firstRef?: (el: HTMLElement | null) => void;
}) {
  const [template, setTemplate] = useState<WhatIfTemplate | null>(null);
  // What the sheet shows while it slides out, and a new form each time.
  const [held, setHeld] = useState<WhatIfTemplate | null>(null);
  const [opened, setOpened] = useState(0);
  const pick = (t: WhatIfTemplate) => {
    setOpened((n) => n + 1);
    setTemplate(t);
    setHeld(t);
  };
  const close = () => setTemplate(null);

  const ready = plans.status === 'ready';
  // Every stored plan counts toward the most kept, readable or not.
  const full = plansCount(plans) >= MAX_FIRE_PLANS;
  // Life events are placed by age: without yours, none can be.
  const noAge = base.age === null;
  // A copy's amounts are in your plan's currency: without one, none.
  const noCurrency = planCurrency === null;
  const canTry = editable && canOpen && ready && !plans.saving && !full && !noAge && !noCurrency;

  const tryIt = async (event: LifeEvent): Promise<boolean | string> => {
    if (!held) return false;
    if (planCurrency === null) return NO_CURRENCY;
    const r = await onTry(event, whatIfName(held, event, plans.list));
    // Made and opened, in one commit with this close, so the copy's heading
    // takes focus as it opens.
    if (r === true) close();
    return r;
  };

  const sheet = (
    <Sheet open={!!template} title={held?.label ?? ''} onClose={close}>
      {held && (
        <EventForm
          key={opened}
          kind={held.kind}
          event={null}
          name={held.name}
          editable={canTry}
          onCancel={close}
          onRemove={null}
          onSave={tryIt}
          saveText="Try it"
          savingText="Trying…"
          whereText="Your plan stays as it is."
          preview={(checked: Checked) => (
            <DraftPreview checked={checked} kind={held.kind} plan={base} measured={measured} count={count} against={baseFigures} where="what-if" money={money}>
              {'ok' in checked && <p>{`Try it makes the copy “${whatIfName(held, checked.ok, plans.list)}” of your plan with it, and opens it.`}</p>}
            </DraftPreview>
          )}
        />
      )}
    </Sheet>
  );
  // The sheet keeps one place in the tree, outside the card, so one closing
  // as its copy opens (and the card goes) slides out.
  return (
    <>
      {shown && (
        <section className="card plan-what-if" aria-labelledby="plan-what-if-title">
          <div className="card-header">
            <h3 id="plan-what-if-title" tabIndex={-1} ref={canTry ? undefined : firstRef}>
              What if…
            </h3>
          </div>
          <div className="stack">
            <p className="helper">Try a life choice with your own figures. It becomes a copy of your plan, and your plan stays as it is.</p>
            {/* Why the choices are off, read before them (since the screen
                review): your age first, with the same ask as the answer's,
                opening the same Ages sheet. */}
            {noAge && (
              <div>
                <p className="helper">A life choice is placed by age.</p>
                {onAskAge && (
                  <button
                    type="button"
                    className="btn ghost hero-ask"
                    ref={askRef}
                    aria-disabled={reloading ? 'true' : undefined}
                    onClick={() => {
                      if (!reloading) onAskAge();
                    }}
                  >
                    {askAgesText('age')}
                  </button>
                )}
              </div>
            )}
            {!planCurrencyKnown ? (
              <p className="helper">Say which currency your plan’s figures are in first (above): a copy’s amounts are in it.</p>
            ) : (
              noCurrency && <p className="helper">{NO_CURRENCY}</p>
            )}
            {plans.status === 'loading' && <p className="helper">Your plans are still loading.</p>}
            {plans.status === 'error' && (
              <div className="notice caution">
                {CAUTION}
                <div className="stack tight">
                  <p>
                    <LevelWord level="caution" />
                    {plans.error}
                  </p>
                  <button type="button" className="btn secondary" onClick={onRetry}>
                    Try again
                  </button>
                </div>
              </div>
            )}
            {ready && full && <p className="helper">You have {MAX_FIRE_PLANS} plans, the most Nya keeps: delete one in Plans to try another.</p>}
            <div className="chip-row" role="group" aria-label="Try a life choice">
              {WHAT_IF_TEMPLATES.map((t, i) => (
                <button key={t.id} type="button" className="chip" aria-haspopup="dialog" onClick={() => pick(t)} disabled={!canTry} ref={i === 0 && canTry ? firstRef : undefined}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}
      {sheet}
    </>
  );
}
