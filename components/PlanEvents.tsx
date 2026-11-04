'use client';

// A plan's life events (lib/fire/events.ts), held as its items
// (lib/fire/items.ts asEvent): on the Plan tab while a copy is open, under
// Your figures where the What if… card is on your plan, and on your plan
// when it holds any (made yours from a copy that did; adding one there stays
// What if…'s Try it, until E2 of the tax plan retires this card). Each with
// its own figures, where it counts, and what of it is left out and why; in
// a copy, the same life choices as the What if… card, each added to it, so
// several stack in one; and the form to add or change one, with how it moves
// the FI age as it is typed. Every amount and length is the person's own:
// nothing is filled in but the choice's name, no field holds an example,
// and nothing suggests what something "usually" costs.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Sheet } from './Sheet';
import { Masked, NO_EXAMPLE } from './HideAmounts';
import { EVENT_LIMITS, parseLifeEvent, type EventNote, type LifeEvent, type LifeEventKind } from '@/lib/fire/events';
import { EVENT_NAMES, EVENT_PART_TEXT, eventCountsText, eventText } from './plan-scenario-text';
import { WHAT_IF_TEMPLATES, type WhatIfTemplate } from './plan-what-if';
import { CopyTag } from './CopyTag';
import AlsoChange, { type AlsoChoice } from './AlsoChange';
import { Notice } from './TotalCaveats';

/** Saves the plan's whole list of events, and the event changed to the
 *  plans checked in Also change it in: true once the server has it, else
 *  false, or why it was refused. */
type SaveEvents = (events: LifeEvent[], also?: { id: string; event: LifeEvent; to: readonly string[] }) => Promise<boolean | string>;

const KIND_NOTES: Record<LifeEventKind, string> = {
  house:
    'What you pay from your investments when you buy (0 if the down payment comes from cash the plan doesn’t count), and how your yearly spending changes from then: the mortgage, taxes and upkeep, less the rent you stop paying. A change for good that is already in effect when you stop working is part of your spending in retirement, and so of your FI number.',
  child: 'How much more you would spend a year, and for how many years.',
  sabbatical:
    'How much less you would save each year of it: what you would have saved, plus anything you would spend from savings. It moves your FI date; once you have stopped working it changes nothing.',
  'part-time':
    'Income a year after tax, from an age to the age it stops. It counts from this plan’s stop age only: for part-time work in place of full-time work, set the plan’s stop age to when full-time work stops. The FI card’s Barista FI uses your plan’s own part-time income, not this.',
  spending:
    'How much more (or less) you would spend a year, for some years or for good. It changes what you save in its years too. A change for good that is already in effect when you stop working is part of your spending in retirement, and so of your FI number. Typing the plan’s own annual spending instead changes the FI number the same way, but leaves what you save as it is.',
  car: 'What you pay from your investments for each car when you buy it, once or every few years. Payments on a car loan are already in your measured spending, so count only what comes from your investments, never a loan’s payments.',
  raise:
    'How much more you would save each year from then, after tax, until FI. It moves your FI date and what you’d have at your stop age: it never changes your spending in retirement, or your FI number.',
  windfall:
    'Money that comes in once (an inheritance, a sale), after tax, added to your investments at that age. From the stop age on, the simulation takes it as money in that year.',
  'loan-end':
    'How much less you would spend a year, for good, once a loan is paid off: its payments, which are in your measured spending until then. You save that much more from then until FI. Paid off by the time you stop, it is part of your spending in retirement, and so of your FI number.',
};

/** A drawer's event: a new one from a life choice, or one to change. */
type Opened = { kind: LifeEventKind; event: LifeEvent | null; template: WhatIfTemplate | null };

export function LifeEventsCard({
  copyName,
  version,
  events,
  notes,
  money,
  editable,
  onSave,
  preview,
  alsoFor,
}: {
  /** The open copy's name; null on your plan, where only its own events are
   *  edited or removed (adding one is What if…'s Try it). */
  copyName: string | null;
  /** The plan's version: a drawer opened on one closes when it changes
   *  (saved, or changed on another device), and never saves over another. */
  version: string;
  events: LifeEvent[];
  notes: EventNote[];
  money: (n: number) => string;
  editable: boolean;
  onSave: SaveEvents;
  /** How the form's event moves the plan's FI age, as it is typed
   *  (components/PlanWhatIf.tsx DraftPreview). */
  preview?: (draft: Checked, kind: LifeEventKind) => ReactNode;
  /** The other plans an edit of this event can go to too (Also change it in). */
  alsoFor?: (id: string) => AlsoChoice[];
}) {
  const [sheet, setSheet] = useState<Opened | null>(null);
  const [opened, setOpened] = useState(0);
  const [shown, setShown] = useState<Opened | null>(null);
  const versionRef = useRef(version);
  versionRef.current = version;
  const openedOn = useRef(version);
  const titleRef = useRef<HTMLDivElement | null>(null);
  const open = (s: Opened) => {
    setOpened((n) => n + 1);
    openedOn.current = version;
    setSheet(s);
    setShown(s);
  };
  const close = () => setSheet(null);
  useEffect(() => {
    setSheet(null);
  }, [version]);
  // Closed: the sheet gives focus back to the choice or Edit that opened it,
  // as its own effect ends, before this one. When that one is off now (the
  // tenth event just added) or gone (the event removed), focus stays in the
  // sheet as it slides out, or is lost: then to the card's title.
  const sheetOpen = !!sheet;
  const wasOpen = useRef(sheetOpen);
  useEffect(() => {
    const closed = wasOpen.current && !sheetOpen;
    wasOpen.current = sheetOpen;
    if (!closed) return;
    const at = document.activeElement;
    let lost = !at || at === document.body || !at.isConnected || (at as HTMLButtonElement).disabled === true;
    for (let n: Element | null = at; n && !lost; n = n.parentElement) lost = n.getAttribute('role') === 'dialog';
    if (lost) titleRef.current?.focus({ preventScroll: true });
  }, [sheetOpen]);
  /** Saves only on the version the drawer was opened on. */
  const guarded: SaveEvents = async (next, also) =>
    openedOn.current === versionRef.current ? onSave(next, also) : 'This plan changed since this was opened, so nothing was saved: open it again.';
  const full = events.length >= EVENT_LIMITS.events;
  const whose = copyName ? 'this copy' : 'your plan';
  return (
    <div className="card">
      <CopyTag name={copyName} />
      <div className="inst-header">
        <div className="inst-name" tabIndex={-1} ref={titleRef}>
          Life events
        </div>
      </div>
      {events.length === 0 ? (
        <p className="empty-note">Add a life choice with your own figures to see how it changes this copy. Add more than one and they count together.</p>
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
                <button className="plan-edit" onClick={() => open({ kind: e.kind, event: e, template: null })} disabled={!editable} aria-label={`Edit ${e.label}`}>
                  Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {copyName ? (
        <>
          <div className="chip-row" role="group" aria-label="Add a life choice">
            {WHAT_IF_TEMPLATES.map((t) => (
              <button key={t.id} type="button" className="chip" aria-haspopup="dialog" onClick={() => open({ kind: t.kind, event: null, template: t })} disabled={!editable || full}>
                {t.label}
              </button>
            ))}
          </div>
          {full && <p className="panel-note">A plan holds at most {EVENT_LIMITS.events} life events.</p>}
        </>
      ) : (
        <p className="helper">To try another life choice, use What if…: it makes a copy of your plan with it.</p>
      )}
      <Sheet open={!!sheet} title={shown ? (shown.template?.label ?? EVENT_NAMES[shown.kind]) : ''} onClose={close}>
        {shown && (
          <EventForm
            key={opened}
            kind={shown.kind}
            event={shown.event}
            name={shown.template?.name}
            editable={editable}
            onCancel={close}
            copyName={copyName}
            saveText={shown.event ? 'Save' : 'Add to this copy'}
            savingText={shown.event ? 'Saving…' : 'Adding…'}
            whereText={`Saved to ${whose}${copyName ? ', not your plan' : ''}.`}
            removeText={`Remove from ${whose}`}
            preview={preview ? (draft) => preview(draft, shown.kind) : undefined}
            also={shown.event && alsoFor ? alsoFor(shown.event.id) : []}
            onSave={async (e, to) => {
              const next = shown.event ? events.map((x) => (x.id === shown.event!.id ? e : x)) : [...events, e];
              const ok = await guarded(next, to.length > 0 ? { id: e.id, event: e, to } : undefined);
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

/** A form's event as it would be saved, or why it can't be: `missing` when
 *  a field is empty, else one is out of range. */
export type Checked = { ok: LifeEvent } | { error: string; missing?: true };

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
  name,
  copyName = null,
  saveText = 'Save',
  savingText = 'Saving…',
  whereText = 'Saved to this copy, not your plan.',
  removeText = 'Remove from this copy',
  preview,
  also = [],
}: {
  kind: LifeEventKind;
  event: LifeEvent | null;
  editable: boolean;
  /** The event, and the plans checked in Also change it in. */
  onSave: (e: LifeEvent, also: readonly string[]) => Promise<boolean | string>;
  onRemove: (() => Promise<boolean | string>) | null;
  onCancel: () => void;
  /** The name a new event starts with: its kind's, unless given. */
  name?: string;
  /** The open copy's name, tagged at the top; null for your plan. */
  copyName?: string | null;
  saveText?: string;
  savingText?: string;
  /** Where Save puts it, said after the kind's note. */
  whereText?: string;
  removeText?: string;
  /** Shown above the buttons, from the event as it would be saved now, or
   *  why it can't be yet (the What if… card's, components/PlanWhatIf.tsx). */
  preview?: (draft: Checked) => ReactNode;
  /** Other plans holding this event, which a save can change too. */
  also?: readonly AlsoChoice[];
}) {
  const e = event as Record<string, unknown> | null;
  const [label, setLabel] = useState(event?.label ?? name ?? EVENT_NAMES[kind]);
  // The event's id for the form's life, so every draft is the same event.
  const [id] = useState(() => event?.id ?? crypto.randomUUID());
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
  const [amount, setAmount] = useState(asText(e?.amount as number | undefined));
  const everyNow = e?.every as number | null | undefined;
  const [repeats, setRepeats] = useState(typeof everyNow === 'number');
  const [every, setEvery] = useState(asText(everyNow ?? undefined));
  const [times, setTimes] = useState(typeof everyNow === 'number' ? asText(e?.times as number) : '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [alsoIn, setAlsoIn] = useState<string[]>([]);

  /** A field that must be filled in, as a number (NaN when it isn't one,
   *  which the check below names). */
  const need = (t: string, what: string) => {
    const n = read(t);
    if (n === null) throw new Missing(`Fill in ${what}.`);
    return n;
  };
  const signed = (t: string, what: string) => (less ? -need(t, what) : need(t, what));

  function build(): LifeEvent {
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
      case 'car':
        return {
          id,
          kind,
          label,
          atAge: need(age, 'the age'),
          cost: need(cost, 'what each car takes from your investments'),
          every: repeats ? need(every, 'every how many years') : null,
          times: repeats ? need(times, 'how many in all') : 1,
        };
      case 'raise':
        return { id, kind, label, fromAge: need(age, 'the age'), yearly: need(yearly, 'how much more you would save a year') };
      case 'windfall':
        return { id, kind, label, atAge: need(age, 'the age'), amount: need(amount, 'the amount') };
      case 'loan-end':
        return { id, kind, label, atAge: need(age, 'the age'), yearly: need(yearly, 'how much less you would spend a year') };
    }
  }

  /** The event as it would be saved, or why it can't be. */
  function check(): Checked {
    let built: LifeEvent;
    try {
      built = build();
    } catch (err) {
      if (!(err instanceof Missing)) throw err;
      return { error: err.message, missing: true };
    }
    const parsed = parseLifeEvent(built, 'This event');
    return 'error' in parsed ? { error: parsed.error.replace(/^This event: /, '').replace(/^./, (c) => c.toUpperCase()) + '.' } : parsed;
  }

  async function save(run: () => Promise<boolean | string>) {
    setSaving(true);
    const ok = await run();
    setSaving(false);
    if (ok !== true) setError(typeof ok === 'string' ? ok : 'It was not saved. Try again in a moment.');
  }

  const disabled = saving || !editable;
  const draft = preview ? check() : null;
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
      <CopyTag name={copyName} />
      <p className="panel-note" style={{ marginTop: 0 }}>
        {KIND_NOTES[kind]} Every amount is a year (or once), after tax, in today’s money. {whereText}
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
        {kind === 'car' && (
          <>
            {field('At age', age, setAge)}
            {field('Paid from your investments, each', cost, setCost, true)}
            <div className="plan-choice-row" role="group" aria-label="How often">
              <label className="plan-check">
                <input type="radio" name="repeats" checked={!repeats} onChange={() => setRepeats(false)} disabled={saving} />
                Once
              </label>
              <label className="plan-check">
                <input type="radio" name="repeats" checked={repeats} onChange={() => setRepeats(true)} disabled={saving} />
                Every few years
              </label>
            </div>
            {repeats && (
              <>
                {field('Every how many years', every, setEvery)}
                {field('How many in all', times, setTimes)}
              </>
            )}
          </>
        )}
        {kind === 'raise' && (
          <>
            {field('From age', age, setAge)}
            {field('Saved more a year', yearly, setYearly, true)}
          </>
        )}
        {kind === 'windfall' && (
          <>
            {field('At age', age, setAge)}
            {field('Amount, after tax', amount, setAmount, true)}
          </>
        )}
        {kind === 'loan-end' && (
          <>
            {field('Paid off at age', age, setAge)}
            {field('Spending less a year', yearly, setYearly, true)}
          </>
        )}
      </div>
      {preview && draft && preview(draft)}
      <AlsoChange choices={also} checked={alsoIn} onChange={setAlsoIn} disabled={saving} />
      {error && (
        <Notice level="critical" role="alert">
          {error}
        </Notice>
      )}
      {onRemove && (
        <button className="danger-outline" style={{ marginTop: 12 }} disabled={disabled} onClick={() => void save(onRemove)}>
          {removeText}
        </button>
      )}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button
          disabled={disabled}
          onClick={() => {
            const parsed = check();
            if ('error' in parsed) {
              setError(parsed.error);
              return;
            }
            setError('');
            void save(() => onSave(parsed.ok, alsoIn));
          }}
        >
          {saving ? savingText : saveText}
        </button>
      </div>
    </>
  );
}
