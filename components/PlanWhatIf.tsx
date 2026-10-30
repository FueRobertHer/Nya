'use client';

// The What if… card on Your path (rollout phase 8c), under Your figures,
// with your plan shown: life choices as templates, and your scenarios as the
// choices tried, each with its FI age against your plan's. A template opens
// the life event's own form (components/PlanEvents.tsx EventForm) with
// nothing filled in but its name, says how it moves the FI age as it is
// typed, and "Try it" makes an ordinary scenario of it, your plan's own with
// that one life event, named after it ("Buy a home at 38"), and opens it.
// Nothing stored changes shape, and nothing records which template made it.
// With a scenario open the card isn't drawn: the scenario's Life events card
// takes its place with the same choices, each added to the scenario, and
// the same preview (DraftPreview) measured against the scenario as it is.
// The words are in components/plan-what-if.ts.

import { useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import { CAUTION } from './ConnectionStatus';
import { INFO, LevelWord } from './TotalCaveats';
import { EventForm, type Checked } from './PlanEvents';
import { scenarioOutcome } from './PlanScenarios';
import { chevron, RIGHT } from './ActivityBar';
import { EVENT_PART_TEXT } from './plan-scenario-text';
import { askAgesText } from './plan-text';
import type { ScenarioClient, ScenariosState } from './plan-scenarios';
import { WHAT_IF_TEMPLATES, fiWhen, previewText, scenarioRowText, whatIfName, withDraft, type FiWhen, type WhatIfTemplate } from './plan-what-if';
import { MAX_PLAN_SCENARIOS, NO_CHANGES, resolveScenario, type ScenarioChanges } from '@/lib/fire/scenarios';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import type { EventNote, LifeEvent } from '@/lib/fire/events';
import type { FirePlan, Measured } from '@/lib/fire/plan';

/** Said when the Plan has no currency to give a scenario's amounts, as a
 *  save into an open scenario says it (components/PlanTab.tsx persistIn). */
const NO_CURRENCY = 'Your plan has no currency yet (no accounts to take it from), so a scenario can’t hold amounts: add an account first.';

/** A scenario with this event in it, as it would open: when it reaches FI,
 *  and what of this event (not the others) is left out and why
 *  (lib/fire/plan-figures.ts). On your plan, `changes` is none. */
function draftOutcome(base: FirePlan, measured: Measured, changes: ScenarioChanges, event: LifeEvent): { when: FiWhen; notes: EventNote[] } {
  const events = withDraft(changes.events, event);
  const r = resolveScenario(base, { ...changes, events });
  if (!r.ok) return { when: { kind: 'not-run' }, notes: [] };
  const f = planFigures(r.plan, measured, events);
  if ('refused' in f) return { when: { kind: 'not-run' }, notes: [] };
  return { when: fiWhen(f), notes: (f.events?.notes ?? []).filter((n) => n.id === event.id) };
}

/** How a draft moves the FI age, said in its form as it is typed, with what
 *  of it is left out and why: against your plan on the What if… card, and
 *  against the open scenario as it is in its Life events card. */
export function DraftPreview({
  checked,
  kind,
  base,
  measured,
  changes,
  against,
  where,
  money,
  children,
}: {
  checked: Checked;
  kind: LifeEvent['kind'];
  base: FirePlan;
  measured: Measured;
  changes: ScenarioChanges;
  /** What it moves from: your plan's figures, or the scenario's now (null
   *  when they aren't worked out). */
  against: PlanFigures | null;
  where: 'what-if' | 'scenario';
  money: (n: number) => string;
  /** A last line, under the notes. */
  children?: ReactNode;
}) {
  const draft = 'ok' in checked ? checked.ok : null;
  const d = draft ? draftOutcome(base, measured, changes, draft) : null;
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
  state,
  client,
  planCurrency,
  planCurrencyKnown,
  editable,
  canOpen,
  money,
  onOpen,
  onAskAge,
  reloading = false,
  askRef,
  firstRef,
}: {
  /** The card is drawn: your plan is shown. Its sheet stays mounted either
   *  way, so one closing as its scenario opens slides out. */
  shown: boolean;
  /** Your plan as the tab shows it, loaded. */
  base: FirePlan;
  baseFigures: PlanFigures;
  measured: Measured;
  state: ScenariosState;
  client: ScenarioClient;
  planCurrency: string | null;
  /** Whether the Plan's currency is known (lib/fire/plan-currency.ts). */
  planCurrencyKnown: boolean;
  /** Your plan can be changed now: saving nothing, waiting on no repair,
   *  its currency known. */
  editable: boolean;
  /** Scenarios can be opened now. */
  canOpen: boolean;
  money: (n: number) => string;
  /** Opens a scenario under the scenario bar. */
  onOpen: (id: string) => void;
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

  const ready = state.status === 'ready';
  const list = state.list;
  // Every stored scenario counts toward the most kept, readable or not.
  const full = list.length + state.unreadable.length + state.unrecognised.length >= MAX_PLAN_SCENARIOS;
  // Life events are placed by age: without yours, none can be.
  const noAge = base.age === null;
  // A scenario's amounts are in your plan's currency: without one, none.
  const noCurrency = planCurrency === null;
  const canTry = editable && canOpen && ready && !state.saving && !full && !noAge && !noCurrency;
  const plan = fiWhen(baseFigures);

  const tryIt = async (event: LifeEvent): Promise<boolean | string> => {
    if (!held) return false;
    if (planCurrency === null) return NO_CURRENCY;
    const r = await client.create({ name: whatIfName(held, event, list), currency: planCurrency, ...NO_CHANGES, events: [event] });
    if ('error' in r) return r.error;
    // In one commit, so the scenario's heading takes focus as it opens.
    close();
    onOpen(r.ok.id);
    return true;
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
            <DraftPreview checked={checked} kind={held.kind} base={base} measured={measured} changes={NO_CHANGES} against={baseFigures} where="what-if" money={money}>
              {'ok' in checked && <p>{`Try it makes this the scenario “${whatIfName(held, checked.ok, list)}”, and opens it.`}</p>}
            </DraftPreview>
          )}
        />
      )}
    </Sheet>
  );
  // The sheet keeps one place in the tree, outside the card, so one closing
  // as its scenario opens (and the card goes) slides out.
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
            <p className="helper">Try a life choice with your own figures. It becomes a scenario, and your plan stays as it is.</p>
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
              <p className="helper">Say which currency your plan’s figures are in first (above): a scenario’s amounts are in it.</p>
            ) : (
              noCurrency && <p className="helper">{NO_CURRENCY}</p>
            )}
            {state.status === 'loading' && <p className="helper">Your scenarios are still loading.</p>}
            {state.status === 'error' && (
              <div className="notice caution">
                {CAUTION}
                <div className="stack tight">
                  <p>
                    <LevelWord level="caution" />
                    {state.error}
                  </p>
                  <button type="button" className="btn secondary" onClick={() => void client.load()}>
                    Try again
                  </button>
                </div>
              </div>
            )}
            {ready && full && <p className="helper">You have {MAX_PLAN_SCENARIOS} scenarios, the most Nya keeps: delete one in Scenarios to try another.</p>}
            <div className="chip-row" role="group" aria-label="Try a life choice">
              {WHAT_IF_TEMPLATES.map((t, i) => (
                <button key={t.id} type="button" className="chip" aria-haspopup="dialog" onClick={() => pick(t)} disabled={!canTry} ref={i === 0 && canTry ? firstRef : undefined}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
          {ready && list.length > 0 && (
            <ul className="list-rows" aria-label="Your scenarios">
              {list.map((s) => {
                const outcome = scenarioOutcome(base, s, measured, planCurrency, planCurrencyKnown);
                const when = fiWhen(outcome.kind === 'figures' ? outcome.figures : null);
                return (
                  <li key={s.id}>
                    <button type="button" className="list-row" onClick={() => onOpen(s.id)} disabled={!canOpen || state.saving}>
                      <span className="list-row-text">
                        <span className="list-row-title">{s.name}</span>
                        <span className="list-row-sub">{scenarioRowText(s.events.length, when, plan)}</span>
                      </span>
                      {chevron(RIGHT)}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {sheet}
    </>
  );
}
