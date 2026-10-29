'use client';

// Planned items on Budgets > Upcoming (lib/planned.ts): expenses and income
// the person types for the forecast and the calendar, one-off or repeating,
// each with when it next falls. The whole list is saved at once through
// lib/whole-list-store.ts, so nothing is editable until it has loaded; while
// it is read again after a refused save (`drawn`), the list stays drawn.
//
// SHEETS (rollout phase 6a3). An item's row opens its sheet, and Add a
// planned item opens an empty one (components/Sheet.tsx); each opening
// starts afresh. The sheet only closes once the server took the change, and
// stays open on what was typed when it didn't, saying why: only a refusal
// that arose while it was open (the store clears its error when a save
// starts, so the same words again are new); the card says the rest. Delete
// planned item is a level of the sheet that asks first (Keep it is focused),
// with a back arrow. Focus goes back to the item's row as it is drawn then;
// after Delete, to Add a planned item; after Add, to the new item's row.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { Sheet } from './Sheet';
import { Notice } from './TotalCaveats';
import { Masked } from './HideAmounts';
import { segmentKey } from './ActivityBar';
import { formatMoney, MINUS } from '@/lib/format';
import { isCalendarDay, isCurrencyCode, knownCurrency, parseAmountInput, DEFAULT_CURRENCY, MAX_AMOUNT } from '@/lib/manual-txn-input';
import {
  EARLIEST_PLANNED,
  LATEST_PLANNED,
  MAX_ITEMS,
  MAX_NAME_CHARS,
  PLANNED_CADENCES,
  nextPlannedDate,
  plannedCadenceLabel,
  type Planned,
  type PlannedCadence,
  type PlannedItem,
  type PlannedKind,
} from '@/lib/planned';

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The form's working copy: the amount as typed. */
type Draft = { id: string; name: string; kind: PlannedKind; amount: string; currency: string; date: string; cadence: PlannedCadence };

/** Where the sheet is: the item's form, or Delete's question. */
type Level = 'edit' | 'delete';

/** The sheet open, kept while it slides out: what is typed, whether it edits
 *  an item or adds one, its level, the save refusal already said when it
 *  opened (`seen`), whether it closed on a save (`saved`, for where focus
 *  goes), and which opening it is (`n`), so each starts afresh. */
type SheetState = { draft: Draft; editing: boolean; level: Level; open: boolean; seen: string | null; saved: boolean; n: number };

const KINDS: readonly { kind: PlannedKind; label: string }[] = [
  { kind: 'expense', label: 'Money out' },
  { kind: 'income', label: 'Money in' },
];

export default function PlannedCard({
  planned,
  status = 'ready',
  drawn = status === 'ready',
  error = null,
  saveError = null,
  onSave,
  today,
  currency,
  edit,
  adding = false,
}: {
  planned: Planned;
  /** Until 'ready' the list is unknown: shown as loading, never as "none";
   *  and nothing is edited until then. */
  status?: ListStatus;
  /** The list is drawn: ready, or read again after a refused save (the list
   *  saved, put back meanwhile). */
  drawn?: boolean;
  error?: string | null;
  /** Why the last save of the planned items didn't go through: said on the
   *  card, or in the sheet open when it arose. */
  saveError?: string | null;
  /** Resolves true once saved; the sheet only closes then. */
  onSave?: (next: Planned) => Promise<boolean>;
  /** The viewer's day (lib/local-date.ts). */
  today: string;
  /** A new item's currency to start with: the forecast's. */
  currency: string | null;
  /** An item whose sheet is open at first, by id. */
  edit?: string;
  /** Add a planned item's sheet open at first. */
  adding?: boolean;
}) {
  const fresh = (): Draft => ({ id: crypto.randomUUID(), name: '', kind: 'expense', amount: '', currency: currency ?? DEFAULT_CURRENCY, date: today, cadence: 'once' });
  const of = (item: PlannedItem): Draft => ({ ...item, amount: String(item.amount) });
  const [sheet, setSheet] = useState<SheetState | null>(() => {
    const item = edit ? planned.items.find((i) => i.id === edit) : undefined;
    if (!item && !adding) return null;
    return { draft: item ? of(item) : fresh(), editing: !!item, level: 'edit', open: true, seen: saveError, saved: false, n: 1 };
  });
  const [saving, setSaving] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  /** Each item's row as it is drawn now, by id: one taken out and drawn
   *  again (a refused delete puts back what the optimistic list took out)
   *  is a new element. */
  const rowEls = useRef(new Map<string, HTMLElement>());
  const rowRef = (id: string) => (el: HTMLElement | null) => {
    if (el) rowEls.current.set(id, el);
    else rowEls.current.delete(id);
  };
  // Delete's question focuses its safe answer, so a stray Enter keeps the item.
  const keep = useRef<HTMLButtonElement>(null);
  const kinds = useRef<(HTMLButtonElement | null)[]>([]);

  const items = [...planned.items]
    .map((item) => ({ item, next: nextPlannedDate(item, today) }))
    // Soonest first; those with no date left last.
    .sort((a, b) => (a.next ?? '9999').localeCompare(b.next ?? '9999') || a.item.name.localeCompare(b.item.name));

  const editable = status === 'ready' && !!onSave;

  const show = (draft: Draft, editing: boolean) =>
    setSheet((s) => ({ draft, editing, level: 'edit', open: true, seen: saveError, saved: false, n: (s?.n ?? 0) + 1 }));
  const setDraft = (draft: Draft) => setSheet((s) => (s ? { ...s, draft } : s));
  const goTo = (level: Level) => setSheet((s) => (s ? { ...s, level } : s));
  const close = () => !saving && setSheet((s) => (s ? { ...s, open: false } : s));
  const back = () => !saving && goTo('edit');

  // A refusal said before the sheet opened, once cleared, is forgotten: the
  // same words coming back are a new refusal, and the sheet says it.
  useEffect(() => {
    if (saveError === null) setSheet((s) => (s && s.seen !== null ? { ...s, seen: null } : s));
  }, [saveError]);

  const d = sheet?.draft ?? null;
  const editing = !!sheet?.editing;
  const level = sheet?.level ?? 'edit';
  const code = d ? d.currency.trim().toUpperCase() : '';
  const amount = d ? parseAmountInput(d.amount, isCurrencyCode(code) ? code : DEFAULT_CURRENCY) : null;
  // What the server checks (lib/planned.ts parsePlanned), checked here first,
  // so a save is never refused with only "could not save" to say why.
  const currencyOk = knownCurrency(code);
  const amountOk = amount !== null && amount <= MAX_AMOUNT;
  const dateOk = !!d && isCalendarDay(d.date) && d.date >= EARLIEST_PLANNED && d.date <= LATEST_PLANNED;
  const ready = !!d && !!d.name.trim() && amountOk && currencyOk && dateOk;

  async function commit(next: PlannedItem[]) {
    if (!onSave || saving) return;
    setSaving(true);
    // The store clears its refusal as the save starts: whatever it says
    // after is this save's.
    setSheet((s) => (s ? { ...s, seen: null } : s));
    try {
      if (await onSave({ ...planned, items: next })) setSheet((s) => (s ? { ...s, open: false, saved: true } : s));
    } finally {
      setSaving(false);
    }
  }

  function save() {
    if (!d || !ready) return;
    const item: PlannedItem = { id: d.id, name: d.name.trim(), kind: d.kind, amount: amount!, currency: code, date: d.date, cadence: d.cadence };
    void commit(editing ? planned.items.map((i) => (i.id === item.id ? item : i)) : [...planned.items, item]);
  }

  const sheetOpen = !!sheet?.open;
  useEffect(() => {
    if (sheetOpen && level === 'delete') keep.current?.focus({ preventScroll: true });
  }, [sheetOpen, level]);
  // Closed: the sheet gives focus back to what opened it as its own effect
  // ends, which runs before this one. An item just added takes it from Add;
  // when the row that opened the sheet has gone (deleted, or taken out and
  // drawn again), focus goes to the item's row as it is drawn now, or to Add
  // a planned item, or, when the list couldn't be read again and neither is
  // drawn, to the card's heading rather than to nothing.
  const wasOpen = useRef(sheetOpen);
  useEffect(() => {
    const closed = wasOpen.current && !sheetOpen;
    wasOpen.current = sheetOpen;
    if (!closed || !sheet) return;
    const row = rowEls.current.get(sheet.draft.id);
    if (sheet.saved && !sheet.editing && row?.isConnected) {
      row.focus({ preventScroll: true });
      return;
    }
    let lost = !document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected;
    for (let n: Element | null = document.activeElement; n && !lost; n = n.parentElement) lost = n.getAttribute('role') === 'dialog';
    if (!lost) return;
    [row, addRef.current, titleRef.current].find((el) => el?.isConnected)?.focus({ preventScroll: true });
    // Only the sheet's closing moves focus; what it was open on is read as it is then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetOpen]);

  // Money out or in: a radio group, one tab stop, the arrow keys, Home and
  // End choosing as they go.
  const onKindKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!d || saving) return;
    const at = KINDS.findIndex((k) => k.kind === d.kind);
    const to = segmentKey(e.key === 'ArrowDown' ? 'ArrowRight' : e.key === 'ArrowUp' ? 'ArrowLeft' : e.key, at, KINDS.length);
    if (to === null) return;
    e.preventDefault();
    setDraft({ ...d, kind: KINDS[to].kind });
    kinds.current[to]?.focus();
  };

  // What arose while the sheet was open, at its top, as it was said there.
  const sheetError = sheet?.open && saveError && saveError !== sheet.seen ? saveError : null;
  const said = sheetError && <Notice level="critical">{sheetError}</Notice>;
  // Why its button is off, where the button is, in Recurring's words: the
  // list couldn't be read again after a refused save (a caution), or is being
  // read and nothing of this sheet's is being saved.
  const why =
    status === 'error' ? (
      <Notice level="caution">Your planned items couldn&apos;t be loaded, so this can&apos;t be saved now.</Notice>
    ) : status === 'loading' && !saving ? (
      <p className="helper">Your planned items are still loading.</p>
    ) : null;

  return (
    <section className="card stack" aria-labelledby="planned-title">
      <div className="card-header">
        <h3 id="planned-title" ref={titleRef} tabIndex={-1}>
          Planned
        </h3>
      </div>

      {status === 'error' ? (
        <Notice level="caution">{error}</Notice>
      ) : !drawn ? (
        <p className="empty-note">Loading planned items…</p>
      ) : (
        <>
          {saveError && !sheetError && <Notice level="caution">{saveError}</Notice>}
          {items.length === 0 ? (
            <p className="empty-note">
              Nothing planned yet. Add an expense or income you know is coming, once or on a schedule, and the forecast and the
              calendar count it.
            </p>
          ) : (
            <ul className="list-rows planned-rows">
              {items.map(({ item, next }) => {
                const body = (
                  <>
                    <span className="list-row-text">
                      <span className="list-row-title">{item.name}</span>
                      <span className="list-row-sub">
                        {plannedCadenceLabel(item.cadence)} · {next ? `next ${fmtDay(next)}` : `was ${fmtDay(item.date)}`}
                      </span>
                    </span>
                    <span className={`list-row-value money planned-amount${item.kind === 'income' ? ' inflow' : ''}`}>
                      <Masked>{`${item.kind === 'income' ? '+' : MINUS}${formatMoney(item.amount, item.currency)}`}</Masked>
                    </span>
                  </>
                );
                return (
                  <li key={item.id}>
                    {onSave ? (
                      // Read again after a refused save, it stays in the tab
                      // order, and a press opens nothing until it has loaded.
                      <button
                        type="button"
                        ref={rowRef(item.id)}
                        className="list-row"
                        aria-haspopup="dialog"
                        aria-disabled={editable ? undefined : 'true'}
                        onClick={() => editable && show(of(item), true)}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="list-row">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {onSave && planned.items.length < MAX_ITEMS && (
            <div className="btn-row">
              <button
                type="button"
                ref={addRef}
                className="btn secondary planned-add"
                aria-haspopup="dialog"
                aria-disabled={editable ? undefined : 'true'}
                onClick={() => editable && show(fresh(), false)}
              >
                Add a planned item
              </button>
            </div>
          )}
        </>
      )}

      {sheet && d && (
        <Sheet
          key={sheet.n}
          open={sheetOpen}
          title={level === 'delete' ? 'Delete planned item' : editing ? 'Edit planned item' : 'Add a planned item'}
          onClose={close}
          onBack={level === 'delete' ? back : undefined}
          level={level}
          footer={
            level === 'delete' ? (
              <div className="btn-row">
                <button type="button" ref={keep} className="btn secondary" onClick={back} disabled={saving}>
                  Keep it
                </button>
                <button type="button" className="btn danger" onClick={() => void commit(planned.items.filter((i) => i.id !== d.id))} disabled={!editable || saving}>
                  {saving ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            ) : (
              <div className="btn-row">
                <button type="button" className="btn secondary" onClick={close} disabled={saving}>
                  Cancel
                </button>
                <button type="button" className="btn" onClick={save} disabled={!editable || !ready || saving}>
                  <Masked>{saving ? 'Saving…' : editing ? 'Save' : amount !== null && isCurrencyCode(code) ? `Add ${formatMoney(amount, code)}` : 'Add'}</Masked>
                </button>
              </div>
            )
          }
        >
          {level === 'delete' ? (
            <div className="stack">
              {said}
              <p>Delete {d.name.trim() || 'this item'}?</p>
              {why}
            </div>
          ) : (
            <div className="stack">
              {said}
              <div className="segmented" role="radiogroup" aria-label="Money out or in" onKeyDown={onKindKey}>
                {KINDS.map(({ kind, label }, i) => (
                  <button
                    key={kind}
                    ref={(el) => {
                      kinds.current[i] = el;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={d.kind === kind}
                    tabIndex={d.kind === kind ? 0 : -1}
                    disabled={saving}
                    onClick={() => setDraft({ ...d, kind })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="sheet-form">
                <label className="field">
                  Name
                  <input
                    value={d.name}
                    onChange={(e) => setDraft({ ...d, name: e.target.value })}
                    maxLength={MAX_NAME_CHARS}
                    placeholder={d.kind === 'expense' ? 'e.g. Car registration' : 'e.g. Tax refund'}
                    autoCapitalize="sentences"
                    disabled={saving}
                  />
                </label>
                <div className="quick-add-pair">
                  <label className="field quick-add-amount">
                    Amount
                    <input
                      inputMode="decimal"
                      autoComplete="off"
                      value={d.amount}
                      onChange={(e) => setDraft({ ...d, amount: e.target.value })}
                      placeholder="0.00"
                      disabled={saving}
                    />
                  </label>
                  <label className="field quick-add-currency">
                    Currency
                    <input
                      value={d.currency}
                      onChange={(e) => setDraft({ ...d, currency: e.target.value.toUpperCase() })}
                      maxLength={3}
                      autoCapitalize="characters"
                      autoCorrect="off"
                      spellCheck={false}
                      disabled={saving}
                    />
                  </label>
                </div>
                <label className="field">
                  {d.cadence === 'once' ? 'Date' : 'First date'}
                  <input type="date" value={d.date} onChange={(e) => setDraft({ ...d, date: e.target.value })} disabled={saving} />
                </label>
                <label className="field">
                  Repeats
                  <select value={d.cadence} onChange={(e) => setDraft({ ...d, cadence: e.target.value as PlannedCadence })} disabled={saving}>
                    {PLANNED_CADENCES.map((c) => (
                      <option key={c} value={c}>
                        {c === 'once' ? "Doesn't repeat" : plannedCadenceLabel(c)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {d.amount.trim() !== '' && !amountOk && <Notice level="critical">Enter an amount, like 212.50.</Notice>}
              {code.length === 3 && !currencyOk && <Notice level="critical">Enter a currency as its three-letter code, like USD or EUR.</Notice>}
              {d.date !== '' && !dateOk && <Notice level="critical">Pick a date between 2000 and 2100.</Notice>}
              <p className="helper">
                {d.cadence === 'once'
                  ? 'Counted once, on its date.'
                  : "Counted on each date from the first. A day past a month's end falls on its last day. For twice a month, add two monthly items."}{' '}
                Only the forecast and the calendar use it; your budgets and history don&apos;t change.
              </p>
              {why}
              {/* Not offered while nothing can be saved: its question's Delete would be off too. */}
              {editing && status === 'ready' && (
                <div className="btn-row">
                  <button type="button" className="btn secondary" onClick={() => goTo('delete')} disabled={saving}>
                    Delete planned item
                  </button>
                </div>
              )}
            </div>
          )}
        </Sheet>
      )}
    </section>
  );
}
