'use client';

// Planned items on the Budgets tab (lib/planned.ts): expenses and income the
// person types for the forecast and the calendar, one-off or repeating, each
// with when it next falls. Added and edited in the drawer
// (components/Sheet.tsx). The whole list is saved at once through
// lib/whole-list-store.ts, so nothing is editable until it has loaded, and
// the form only closes once the server took the change.

import { useRef, useState } from 'react';
import type { ListStatus } from '@/lib/whole-list-store';
import { Sheet } from './Sheet';
import { formatMoney } from '@/lib/format';
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

/** The value, or the last one that wasn't null: what a drawer shows while
 *  it slides out (as in components/Dashboard.tsx). */
function useLast<T>(value: T | null): T | null {
  const last = useRef<T | null>(value);
  if (value !== null) last.current = value;
  return last.current;
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The form's working copy: the amount as typed. */
type Draft = { id: string; name: string; kind: PlannedKind; amount: string; currency: string; date: string; cadence: PlannedCadence };

export default function PlannedCard({
  planned,
  status = 'ready',
  error = null,
  saveError = null,
  onSave,
  today,
  currency,
}: {
  planned: Planned;
  /** Until 'ready' the list is unknown: shown as loading, never as "none". */
  status?: ListStatus;
  error?: string | null;
  saveError?: string | null;
  /** Resolves true once saved; the form only closes then. */
  onSave?: (next: Planned) => Promise<boolean>;
  /** The viewer's day (lib/local-date.ts). */
  today: string;
  /** A new item's currency to start with: the forecast's. */
  currency: string | null;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Whether a save was tried since the sheet opened: an error left from an
  // earlier save (marking a bill not recurring, say) shows on the card, not
  // in a sheet that has not saved anything yet.
  const [attempted, setAttempted] = useState(false);
  const shown = useLast(draft);

  const items = [...planned.items]
    .map((item) => ({ item, next: nextPlannedDate(item, today) }))
    // Soonest first; those with no date left last.
    .sort((a, b) => (a.next ?? '9999').localeCompare(b.next ?? '9999') || a.item.name.localeCompare(b.item.name));

  function startAdd() {
    setEditing(false);
    setConfirmDelete(false);
    setAttempted(false);
    setDraft({ id: crypto.randomUUID(), name: '', kind: 'expense', amount: '', currency: currency ?? DEFAULT_CURRENCY, date: today, cadence: 'once' });
  }

  function startEdit(item: PlannedItem) {
    setEditing(true);
    setConfirmDelete(false);
    setAttempted(false);
    setDraft({ ...item, amount: String(item.amount) });
  }

  const d = shown;
  const code = d ? d.currency.trim().toUpperCase() : '';
  const amount = d ? parseAmountInput(d.amount, isCurrencyCode(code) ? code : DEFAULT_CURRENCY) : null;
  // What the server checks (lib/planned.ts parsePlanned), checked here first,
  // so a save is never refused with only "could not save" to say why.
  const currencyOk = knownCurrency(code);
  const amountOk = amount !== null && amount <= MAX_AMOUNT;
  const dateOk = !!d && isCalendarDay(d.date) && d.date >= EARLIEST_PLANNED && d.date <= LATEST_PLANNED;
  const ready = !!d && !!d.name.trim() && amountOk && currencyOk && dateOk;

  async function commit(next: PlannedItem[]) {
    if (!onSave) return;
    setSaving(true);
    setAttempted(true);
    try {
      if (await onSave({ ...planned, items: next })) setDraft(null);
    } finally {
      setSaving(false);
    }
  }

  function save() {
    if (!d || !ready) return;
    const item: PlannedItem = { id: d.id, name: d.name.trim(), kind: d.kind, amount: amount!, currency: code, date: d.date, cadence: d.cadence };
    void commit(editing ? planned.items.map((i) => (i.id === item.id ? item : i)) : [...planned.items, item]);
  }

  const editable = status === 'ready' && !!onSave;

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Planned</div>
      </div>

      {status === 'loading' ? (
        <p className="empty-note">Loading planned items…</p>
      ) : status === 'error' ? (
        <p className="stale-note">{error}</p>
      ) : (
        <>
          {saveError && <p className="stale-note">{saveError}</p>}
          {items.length === 0 ? (
            <p className="empty-note">
              Nothing planned yet. Add an expense or income you know is coming, once or on a schedule, and the forecast and the
              calendar count it.
            </p>
          ) : (
            <table>
              <tbody>
                {items.map(({ item, next }) => (
                  <tr
                    key={item.id}
                    className="acct-row"
                    onClick={() => editable && startEdit(item)}
                    // Reachable by keyboard too: Enter or Space edits it.
                    tabIndex={editable ? 0 : undefined}
                    onKeyDown={(e) => {
                      if (!editable || (e.key !== 'Enter' && e.key !== ' ')) return;
                      e.preventDefault();
                      startEdit(item);
                    }}
                  >
                    <td>
                      <div className="txn-text">
                        {item.name}
                        <div className="type-tag">
                          {plannedCadenceLabel(item.cadence)} · {next ? `next ${fmtDay(next)}` : `was ${fmtDay(item.date)}`}
                        </div>
                      </div>
                    </td>
                    <td className={`num${item.kind === 'income' ? ' inflow' : ''}`}>
                      {item.kind === 'income' ? '+' : '-'}
                      {formatMoney(item.amount, item.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {editable && planned.items.length < MAX_ITEMS && (
            <div className="card-actions" style={{ marginTop: 16 }}>
              <button className="secondary" onClick={startAdd}>
                Add a planned item
              </button>
            </div>
          )}
        </>
      )}

      <Sheet open={!!draft} title={editing ? 'Edit planned item' : 'Add a planned item'} onClose={() => !saving && setDraft(null)}>
        {d && (
          <>
            <div className="button-pair quick-add-choice" role="group" aria-label="Money out or in" style={{ marginTop: 0 }}>
              <button className="secondary" aria-pressed={d.kind === 'expense'} disabled={saving} onClick={() => setDraft({ ...d, kind: 'expense' })}>
                Money out
              </button>
              <button className="secondary" aria-pressed={d.kind === 'income'} disabled={saving} onClick={() => setDraft({ ...d, kind: 'income' })}>
                Money in
              </button>
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
            {d.amount.trim() !== '' && !amountOk && <div className="error">Enter an amount, like 212.50.</div>}
            {code.length === 3 && !currencyOk && <div className="error">Enter a currency as its three-letter code, like USD or EUR.</div>}
            {d.date !== '' && !dateOk && <div className="error">Pick a date between 2000 and 2100.</div>}
            <p className="panel-note">
              {d.cadence === 'once'
                ? 'Counted once, on its date.'
                : "Counted on each date from the first. A day past a month's end falls on its last day. For twice a month, add two monthly items."}{' '}
              Only the forecast and the calendar use it; your budgets and history don&apos;t change.
            </p>
            {attempted && saveError && <div className="error">{saveError}</div>}
            {confirmDelete ? (
              <>
                <p className="panel-note">Delete {d.name.trim() || 'this item'}?</p>
                <div className="button-pair" style={{ marginTop: 12 }}>
                  <button className="secondary" onClick={() => setConfirmDelete(false)} disabled={saving}>
                    Keep it
                  </button>
                  <button className="danger" onClick={() => commit(planned.items.filter((i) => i.id !== d.id))} disabled={saving}>
                    {saving ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="button-pair" style={{ marginTop: 16 }}>
                  <button className="secondary" onClick={() => setDraft(null)} disabled={saving}>
                    Cancel
                  </button>
                  <button onClick={save} disabled={!ready || saving}>
                    {saving ? 'Saving…' : editing ? 'Save' : amount !== null && isCurrencyCode(code) ? `Add ${formatMoney(amount, code)}` : 'Add'}
                  </button>
                </div>
                {editing && (
                  <button className="danger-outline" style={{ marginTop: 12 }} onClick={() => setConfirmDelete(true)} disabled={saving}>
                    Delete planned item
                  </button>
                )}
              </>
            )}
          </>
        )}
      </Sheet>
    </div>
  );
}
