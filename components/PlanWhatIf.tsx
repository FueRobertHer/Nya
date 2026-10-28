'use client';

// The What if… card on Your path (rollout phase 8c), under Your figures,
// with your plan shown: life choices as templates, and your scenarios as the
// choices tried, each with its FI age against your plan's. A template opens
// the life event's own form (components/PlanEvents.tsx EventForm) with
// nothing filled in but its name, says how it moves the FI age as it is
// typed, and "Try it" makes an ordinary scenario of it, your plan's own with
// that one life event, named after it ("Buy a home at 38"), and opens it.
// Nothing stored changes shape, and nothing records which template made it.
// The words are in components/plan-what-if.ts.

import { useState } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import { CAUTION } from './ConnectionStatus';
import { LevelWord } from './TotalCaveats';
import { EventForm, type Checked } from './PlanEvents';
import { scenarioOutcome } from './PlanScenarios';
import { chevron, RIGHT } from './ActivityBar';
import { EVENT_PART_TEXT } from './plan-scenario-text';
import { askAgesText } from './plan-text';
import type { ScenarioClient, ScenariosState } from './plan-scenarios';
import { WHAT_IF_TEMPLATES, fiWhen, lifeChoiceText, previewText, whatIfName, type FiWhen, type WhatIfTemplate } from './plan-what-if';
import { MAX_PLAN_SCENARIOS, NO_CHANGES, resolveScenario } from '@/lib/fire/scenarios';
import { planFigures, type PlanFigures } from '@/lib/fire/plan-figures';
import type { EventNote, LifeEvent } from '@/lib/fire/events';
import type { FirePlan, Measured } from '@/lib/fire/plan';

/** Said when the Plan has no currency to give a scenario's amounts, as a
 *  save into an open scenario says it (components/PlanTab.tsx persistIn). */
const NO_CURRENCY = 'Your plan has no currency yet (no accounts to take it from), so a scenario can’t hold amounts: add an account first.';

/** A scenario of your plan with this one event, as it would open: when it
 *  reaches FI, and what of the event is left out and why
 *  (lib/fire/plan-figures.ts). */
function draftOutcome(base: FirePlan, measured: Measured, event: LifeEvent): { when: FiWhen; notes: EventNote[] } {
  const r = resolveScenario(base, { ...NO_CHANGES, events: [event] });
  if (!r.ok) return { when: { kind: 'not-run' }, notes: [] };
  const f = planFigures(r.plan, measured, [event]);
  if ('refused' in f) return { when: { kind: 'not-run' }, notes: [] };
  return { when: fiWhen(f), notes: f.events?.notes ?? [] };
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
          preview={(checked: Checked) => {
            const draft = 'ok' in checked ? checked.ok : null;
            const d = draft ? draftOutcome(base, measured, draft) : null;
            return (
              <div className="notice info">
                <div className="stack tight">
                  {/* Only the move is said as it changes, not the lines under it. */}
                  <p role="status">
                    <Masked>{previewText(d ? d.when : null, plan, money, held.kind, 'missing' in checked && !!checked.missing)}</Masked>
                  </p>
                  {d?.notes.map((n) => (
                    <p key={n.part}>{EVENT_PART_TEXT[n.part]}</p>
                  ))}
                  {draft && <p>{`Try it makes this the scenario “${whatIfName(held, draft, list)}”, and opens it.`}</p>}
                </div>
              </div>
            );
          }}
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
                        <span className="list-row-sub">{lifeChoiceText(when, plan)}</span>
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
