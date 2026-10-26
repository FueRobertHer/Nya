'use client';

// A scenario's life events (lib/fire/events.ts), on the Plan tab while the
// scenario is open: each with its own figures, where it counts, and what of
// it is left out and why; and the form to add or change one. Every amount
// and length is the person's own: nothing is filled in but the kind's name,
// no field holds an example, and nothing suggests what something "usually"
// costs.

import { useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { Masked, NO_EXAMPLE } from './HideAmounts';
import { EVENT_KINDS, EVENT_LIMITS, parseLifeEvent, type EventNote, type LifeEvent, type LifeEventKind } from '@/lib/fire/events';
import { EVENT_NAMES, EVENT_PART_TEXT, eventCountsText, eventText } from './plan-scenario-text';
import { ScenarioTag } from './ScenarioTag';

/** Saves the scenario's whole list of events: true once the server has it,
 *  else false, or why it was refused. */
type SaveEvents = (events: LifeEvent[]) => Promise<boolean | string>;

const KIND_NOTES: Record<LifeEventKind, string> = {
  house:
    'What you pay from your investments when you buy (0 if the down payment comes from cash the plan doesn’t count), and how your yearly spending changes from then: the mortgage, taxes and upkeep, less the rent you stop paying. A change for good that is already in effect when you stop working is part of your spending in retirement, and so of your FI number.',
  child: 'How much more you would spend a year, and for how many years.',
  sabbatical:
    'How much less you would save each year of it: what you would have saved, plus anything you would spend from savings. It moves your FI date; once you have stopped working it changes nothing.',
  'part-time':
    'Income a year after tax, from an age to the age it stops. It counts from this scenario’s stop age only: for part-time work in place of full-time work, set the scenario’s stop age to when full-time work stops. The FI card’s Barista FI uses your plan’s own part-time income, not this.',
  spending:
    'How much more (or less) you would spend a year, for some years or for good. It changes what you save in its years too. A change for good that is already in effect when you stop working is part of your spending in retirement, and so of your FI number. Typing the scenario’s own annual spending instead changes the FI number the same way, but leaves what you save as it is.',
};

export function LifeEventsCard({
  scenarioName,
  version,
  events,
  notes,
  money,
  editable,
  onSave,
}: {
  scenarioName: string;
  /** The scenario's version: a drawer opened on one closes when it changes
   *  (saved, or changed on another device), and never saves over another. */
  version: string;
  events: LifeEvent[];
  notes: EventNote[];
  money: (n: number) => string;
  editable: boolean;
  onSave: SaveEvents;
}) {
  const [sheet, setSheet] = useState<{ kind: LifeEventKind; event: LifeEvent | null } | null>(null);
  const [opened, setOpened] = useState(0);
  const [shown, setShown] = useState<{ kind: LifeEventKind; event: LifeEvent | null } | null>(null);
  const versionRef = useRef(version);
  versionRef.current = version;
  const openedOn = useRef(version);
  const open = (s: { kind: LifeEventKind; event: LifeEvent | null }) => {
    setOpened((n) => n + 1);
    openedOn.current = version;
    setSheet(s);
    setShown(s);
  };
  const close = () => setSheet(null);
  useEffect(() => {
    setSheet(null);
  }, [version]);
  /** Saves only on the version the drawer was opened on. */
  const guarded: SaveEvents = async (next) =>
    openedOn.current === versionRef.current ? onSave(next) : 'This scenario changed since this was opened, so nothing was saved: open it again.';
  const full = events.length >= EVENT_LIMITS.events;
  return (
    <div className="card">
      <ScenarioTag name={scenarioName} />
      <div className="inst-header">
        <div className="inst-name">Life events</div>
      </div>
      {events.length === 0 ? (
        <p className="empty-note">Add a home, a child, a sabbatical, part-time work or a change in spending, with your own figures, to see how it changes this scenario.</p>
      ) : (
        <div className="plan-rows">
          {events.map((e) => (
            <div key={e.id} className="plan-row">
              <div className="plan-row-main">
                <span className="plan-row-label">{e.label}</span>
                <span className="plan-row-value plan-muted">{EVENT_NAMES[e.kind]}</span>
              </div>
              <div className="plan-row-note">
                <span>
                  <Masked>{eventText(e, money)}</Masked> {eventCountsText(e)}
                  {notes
                    .filter((n) => n.id === e.id)
                    .map((n) => (
                      <span key={n.part} className="plan-warning">
                        {EVENT_PART_TEXT[n.part]}
                      </span>
                    ))}
                </span>
                <button className="plan-edit" onClick={() => open({ kind: e.kind, event: e })} disabled={!editable} aria-label={`Edit ${e.label}`}>
                  Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="plan-event-kinds" role="group" aria-label="Add a life event">
        {EVENT_KINDS.map((k) => (
          <button key={k} className="secondary" onClick={() => open({ kind: k, event: null })} disabled={!editable || full}>
            {EVENT_NAMES[k]}
          </button>
        ))}
      </div>
      {full && <p className="panel-note">A scenario holds at most {EVENT_LIMITS.events} life events.</p>}
      <Sheet open={!!sheet} title={shown ? `${EVENT_NAMES[shown.kind]} (${scenarioName})` : ''} onClose={close}>
        {shown && (
          <EventForm
            key={opened}
            kind={shown.kind}
            event={shown.event}
            editable={editable}
            onCancel={close}
            onSave={async (e) => {
              const next = shown.event ? events.map((x) => (x.id === shown.event!.id ? e : x)) : [...events, e];
              const ok = await guarded(next);
              if (ok === true) close();
              return ok;
            }}
            onRemove={
              shown.event
                ? async () => {
                    const ok = await guarded(events.filter((x) => x.id !== shown.event!.id));
                    if (ok === true) close();
                    return ok;
                  }
                : null
            }
          />
        )}
      </Sheet>
    </div>
  );
}

class Missing extends Error {}

const asText = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

/** A number typed in a field: null when empty, NaN when not a number. */
const read = (t: string): number | null => (t.trim() === '' ? null : Number(t));

export function EventForm({
  kind,
  event,
  editable,
  onSave,
  onRemove,
  onCancel,
}: {
  kind: LifeEventKind;
  event: LifeEvent | null;
  editable: boolean;
  onSave: (e: LifeEvent) => Promise<boolean | string>;
  onRemove: (() => Promise<boolean | string>) | null;
  onCancel: () => void;
}) {
  const e = event as Record<string, unknown> | null;
  const [label, setLabel] = useState(event?.label ?? EVENT_NAMES[kind]);
  const [age, setAge] = useState(asText((e?.atAge ?? e?.fromAge) as number | undefined));
  const [toAge, setToAge] = useState(asText(e?.toAge as number | undefined));
  const [cost, setCost] = useState(asText(e?.cost as number | undefined));
  const yearlyNow = e?.yearly as number | undefined;
  const [yearly, setYearly] = useState(asText(yearlyNow === undefined ? undefined : Math.abs(yearlyNow)));
  const [less, setLess] = useState(yearlyNow !== undefined && yearlyNow < 0);
  const [lost, setLost] = useState(asText(e?.savingsLost as number | undefined));
  const yearsNow = e?.years as number | null | undefined;
  const [years, setYears] = useState(asText(yearsNow ?? undefined));
  const [forGood, setForGood] = useState(yearsNow === null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  /** A field that must be filled in, as a number (NaN when it isn't one,
   *  which the check below names). */
  const need = (t: string, what: string) => {
    const n = read(t);
    if (n === null) throw new Missing(`Fill in ${what}.`);
    return n;
  };
  const signed = (t: string, what: string) => (less ? -need(t, what) : need(t, what));

  function build(): LifeEvent {
    const id = event?.id ?? crypto.randomUUID();
    const span = () => (forGood ? null : need(years, 'for how many years'));
    switch (kind) {
      case 'house':
        return { id, kind, label, atAge: need(age, 'the age'), cost: need(cost, 'what is paid from your investments (0 for nothing)'), yearly: read(yearly) === null ? 0 : signed(yearly, 'the change'), years: read(yearly) === null ? null : span() };
      case 'child':
        return { id, kind, label, fromAge: need(age, 'the age'), yearly: need(yearly, 'the spending a year'), years: need(years, 'for how many years') };
      case 'sabbatical':
        return { id, kind, label, fromAge: need(age, 'the age'), years: need(years, 'for how many years'), savingsLost: need(lost, 'how much less you would save a year') };
      case 'part-time':
        return { id, kind, label, fromAge: need(age, 'the age it starts'), toAge: need(toAge, 'the age it stops'), yearly: need(yearly, 'the income a year') };
      case 'spending':
        return { id, kind, label, fromAge: need(age, 'the age'), yearly: signed(yearly, 'the change a year'), years: span() };
    }
  }

  async function save(run: () => Promise<boolean | string>) {
    setSaving(true);
    const ok = await run();
    setSaving(false);
    if (ok !== true) setError(typeof ok === 'string' ? ok : 'It was not saved. Try again in a moment.');
  }

  const disabled = saving || !editable;
  const field = (text: string, value: string, set: (v: string) => void, amount = false) => (
    <label className="field">
      {text}
      <input
        type="number"
        inputMode={amount ? 'decimal' : 'numeric'}
        value={value}
        onChange={(ev) => set(ev.target.value)}
        placeholder={amount ? NO_EXAMPLE : undefined}
        disabled={saving}
      />
    </label>
  );
  const direction = (
    <div className="plan-choice-row" role="group" aria-label="More or less">
      <label className="plan-check">
        <input type="radio" name="direction" checked={!less} onChange={() => setLess(false)} disabled={saving} />
        More
      </label>
      <label className="plan-check">
        <input type="radio" name="direction" checked={less} onChange={() => setLess(true)} disabled={saving} />
        Less
      </label>
    </div>
  );
  const lasting = (
    <>
      <label className="plan-check">
        <input type="checkbox" checked={forGood} onChange={(ev) => setForGood(ev.target.checked)} disabled={saving} />
        For good
      </label>
      {!forGood && field('For how many years', years, setYears)}
    </>
  );

  return (
    <>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {KIND_NOTES[kind]} Every amount is a year (or once), after tax, in today’s money. Saved to this scenario, not your plan.
      </p>
      <div className="sheet-form">
        <label className="field">
          Name
          <input value={label} onChange={(ev) => setLabel(ev.target.value)} maxLength={60} disabled={saving} />
        </label>
        {kind === 'house' && (
          <>
            {field('At age', age, setAge)}
            {field('Paid from your investments', cost, setCost, true)}
            {field('Change in yearly spending from then', yearly, setYearly, true)}
            {direction}
            {lasting}
          </>
        )}
        {kind === 'child' && (
          <>
            {field('From age', age, setAge)}
            {field('More spending a year', yearly, setYearly, true)}
            {field('For how many years', years, setYears)}
          </>
        )}
        {kind === 'sabbatical' && (
          <>
            {field('From age', age, setAge)}
            {field('For how many years', years, setYears)}
            {field('Saved less a year', lost, setLost, true)}
          </>
        )}
        {kind === 'part-time' && (
          <>
            {field('From age', age, setAge)}
            {field('To age (when it stops)', toAge, setToAge)}
            {field('Income a year, after tax', yearly, setYearly, true)}
          </>
        )}
        {kind === 'spending' && (
          <>
            {field('From age', age, setAge)}
            {field('Change a year', yearly, setYearly, true)}
            {direction}
            {lasting}
          </>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {onRemove && (
        <button className="danger-outline" style={{ marginTop: 12 }} disabled={disabled} onClick={() => void save(onRemove)}>
          Remove from this scenario
        </button>
      )}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          disabled={disabled}
          onClick={() => {
            let built: LifeEvent;
            try {
              built = build();
            } catch (err) {
              if (!(err instanceof Missing)) throw err;
              setError(err.message);
              return;
            }
            const parsed = parseLifeEvent(built, 'This event');
            if ('error' in parsed) {
              setError(parsed.error.replace(/^This event: /, '').replace(/^./, (c) => c.toUpperCase()) + '.');
              return;
            }
            setError('');
            void save(() => onSave(parsed.ok));
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}
