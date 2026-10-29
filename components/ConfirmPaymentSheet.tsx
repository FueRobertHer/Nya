'use client';

// Closing what is owed (#49): a row of the person's that paid something back
// (money in: what someone owed them) or paid what they owed (money out),
// confirmed by them, never silently; and what was settled outside their
// accounts (cash, another app) or let go. A proposal from the card opens the
// first with what it would close preselected (only a strong one), and says
// when the row could be more than one person's; "This paid back..." on any
// posted row's sheet opens it with nothing chosen. Only Confirm writes
// (app/api/shared-expenses/payments, app/api/shared-expenses/close), and the
// routes check it all again against what is open now.

import { useEffect, useId, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import FieldError, { amountExample } from './FieldError';
import { shownName } from '@/lib/merchant-name';
import type { Txn } from './MonthBreakdown';
import { fieldAmount, formatMoney, hideAmountsIn, zeroExample } from '@/lib/format';
import { currencyOf } from '@/lib/spending';
import { toUnits, unitScale } from '@/lib/split-rows';
import { localDate } from '@/lib/local-date';
import { NOTE_MAX, REMOVED_NAME, type Direction } from '@/lib/shared-expenses/model';
import type { ItemState } from '@/lib/shared-expenses/balances';
import type { CardAnswer } from '@/lib/shared-expenses/read';
import { partUnits } from './SplitSheet';
import { whoseText } from './shared-expenses-text';
import { SHARED_ROUTES, type SharedExpenses } from './shared-expenses-state';

/** "Oct 5": a day as the list shows it. */
function shownDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The amount a picked item's field holds, as typed. */
type Picked = Map<string, string>;

/** The items, each a checkbox and how much of it, by person, each person's a
 *  fieldset with their name as its legend. */
function ItemPicker({
  items,
  card,
  picked,
  onPick,
  currency,
  disabled,
}: {
  items: readonly ItemState[];
  card: CardAnswer;
  picked: Picked;
  onPick: (next: Picked) => void;
  currency: string;
  disabled: boolean;
}) {
  const scale = unitScale(currency);
  const errorId = useId();
  const places = Math.round(Math.log10(scale));
  const people = [...new Set(items.map((i) => i.person))];
  const nameOf = (id: string) => card.people.find((p) => p.id === id)?.name ?? REMOVED_NAME;
  if (items.length === 0) return <p className="panel-note">Nothing is open in this currency that it could close.</p>;
  return (
    <>
      {people.map((person) => (
        <fieldset key={person} className="lifecycle-choices" disabled={disabled}>
          <legend className="section-label">{nameOf(person)}</legend>
          {items
            .filter((i) => i.person === person)
            .map((i) => {
              const text = picked.get(i.id);
              const on = text !== undefined;
              const units = on && text.trim() ? partUnits(text, currency) : null;
              const over = units !== null && units > toUnits(i.open, scale);
              return (
                <div key={i.id} className="shared-pick">
                  <label className="group-member">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const next = new Map(picked);
                        if (on) next.delete(i.id);
                        else next.set(i.id, fieldAmount(i.open, places));
                        onPick(next);
                      }}
                    />
                    <span className="group-member-text">
                      <span>{i.what}</span>
                      <span className="type-tag">
                        {shownDay(i.date)} · {i.direction === 'to_you' ? 'owes you' : 'you owe'} <Masked>{formatMoney(i.open, i.currency)}</Masked>
                        {i.open !== i.amount && (
                          <>
                            {' '}
                            of <Masked>{formatMoney(i.amount, i.currency)}</Masked>
                          </>
                        )}
                      </span>
                    </span>
                  </label>
                  {on && (
                    <label className="field split-amount">
                      How much of it
                      <input
                        inputMode="decimal"
                        autoComplete="off"
                        aria-label={`How much of ${i.what}`}
                        value={text}
                        onChange={(e) => onPick(new Map(picked).set(i.id, e.target.value))}
                        placeholder={zeroExample(places)}
                        aria-invalid={units === null || over}
                        aria-describedby={units === null || over ? `${errorId}-${i.id}` : undefined}
                      />
                    </label>
                  )}
                  {on && (units === null || over) && (
                    <FieldError id={`${errorId}-${i.id}`}>
                      {units === null ? (
                        `Enter an amount, like ${amountExample(places)}`
                      ) : (
                        <>
                          Enter at most <Masked>{formatMoney(i.open, i.currency)}</Masked>, what is open of it
                        </>
                      )}
                    </FieldError>
                  )}
                </div>
              );
            })}
        </fieldset>
      ))}
    </>
  );
}

/** The picked items as the routes take them, or null while one isn't an
 *  amount, is nothing, or is more than is open of it. */
function allocationsOf(picked: Picked, items: readonly ItemState[], currency: string): { item: string; amount: number }[] | null {
  const scale = unitScale(currency);
  const out: { item: string; amount: number }[] = [];
  for (const [id, text] of picked) {
    const item = items.find((i) => i.id === id);
    const units = partUnits(text, currency);
    if (!item || units === null || units > toUnits(item.open, scale)) return null;
    out.push({ item: id, amount: units / scale });
  }
  return out;
}

/** The items a row could close: those open in its currency (an archived
 *  person's too, should one have any), those in its direction first (money in, what is owed to you;
 *  money out, what you owe). One the other way is taken off: $60 of dinner
 *  less $25 of groceries is paid back by $35. */
export function itemsFor(card: CardAnswer, currency: string, direction: Direction): ItemState[] {
  const open = card.items.filter((i) => i.currency === currency && i.open > 0);
  return [...open.filter((i) => i.direction === direction), ...open.filter((i) => i.direction !== direction)];
}

/** What picked items come to in a row's direction, in minor units: those
 *  its way less those the other way. */
export function netUnits(allocations: readonly { item: string; amount: number }[], items: readonly ItemState[], direction: Direction, currency: string): number {
  const scale = unitScale(currency);
  return allocations.reduce((n, a) => {
    const item = items.find((i) => i.id === a.item);
    return n + (item?.direction === direction ? 1 : -1) * toUnits(a.amount, scale);
  }, 0);
}

export function ConfirmPaymentSheet({
  t,
  person,
  preset,
  also,
  fromProposal,
  shared,
  onClose,
}: {
  t: Txn | null;
  person?: string;
  preset?: readonly { item: string; amount: number }[];
  /** The other people a proposal fits alike: none is preselected. */
  also?: readonly string[];
  fromProposal?: boolean;
  shared: SharedExpenses;
  onClose: () => void;
}) {
  const card = shared.card;
  const startPlaces = Math.round(Math.log10(unitScale(t ? currencyOf(t) : null)));
  const [picked, setPicked] = useState<Picked>(() => new Map((preset ?? []).map((a) => [a.item, fieldAmount(a.amount, startPlaces)])));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const currency = t ? currencyOf(t) : null;
  const scale = unitScale(currency);
  const places = Math.round(Math.log10(scale));
  // As the bank shows it: a payment's own row, before what it paid back.
  const rowAmount = t ? (t.shared_was ?? t.amount) : 0;
  const direction: Direction = rowAmount < 0 ? 'to_you' : 'by_you';
  // Kept under the row, or the one it was carried from (a row imported from
  // a file it stands for, the transaction before a re-link).
  const keptUnder = t ? (t.settles?.kept_under ?? t.transaction_id) : '';
  const confirmed = card && t ? (card.payments.find((p) => p.transaction_id === keptUnder) ?? null) : null;
  const items = useMemo(() => (card && currency ? itemsFor(card, currency, direction) : []), [card, currency, direction]);

  useEffect(() => {
    if (!t) return;
    setPicked(new Map((preset ?? []).map((a) => [a.item, fieldAmount(a.amount, places)])));
    setNote('');
    setError('');
    // Afresh each time it opens on a row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, preset]);

  if (!t || !card || !currency) return <Sheet open={false} title="Paid back" onClose={onClose}>{null}</Sheet>;

  const nameOf = (id: string) => card.people.find((p) => p.id === id)?.name ?? REMOVED_NAME;
  const allocations = allocationsOf(picked, items, currency);
  const sum = netUnits(allocations ?? [], items, direction, currency);
  const whole = Math.abs(toUnits(rowAmount, scale));
  const ready = !!allocations && allocations.length > 0 && sum > 0 && sum <= whole;
  const money = (units: number) => formatMoney(units / scale, currency);
  // Theirs first, then whoever else it fits.
  const shown = person ? [...items.filter((i) => i.person === person), ...items.filter((i) => i.person !== person)] : items;

  async function confirm() {
    setSaving(true);
    setError('');
    const sent = await shared.send(SHARED_ROUTES.payments, 'POST', { transaction_id: t!.transaction_id, allocations, ...(note.trim() ? { note: note.trim() } : {}) });
    setSaving(false);
    if (sent.error) return setError(sent.error);
    onClose();
  }
  async function act(method: 'DELETE' | 'PATCH', body: unknown) {
    setSaving(true);
    setError('');
    const sent = await shared.send(SHARED_ROUTES.payments, method, body, { moves: method === 'DELETE' });
    setSaving(false);
    if (sent.error) return setError(sent.error);
    onClose();
  }

  if (confirmed) {
    return (
      <Sheet open title="Paid back" onClose={() => !saving && onClose()}>
        <p className="panel-note" style={{ marginTop: 0 }}>
          {shownName(t)}, {shownDay(t.date)}: you confirmed it {direction === 'to_you' ? 'paid back' : 'paid'}{' '}
          {confirmed.allocations.map((a) => card.items.find((i) => i.id === a.item)?.what ?? 'something no longer kept').join(', ')}.
        </p>
        {error && (
          <div className="error">
            <Masked>{hideAmountsIn(error)}</Masked>
          </div>
        )}
        <div className="button-pair">
          <button className="secondary" onClick={() => void act('DELETE', { transaction_id: keptUnder })} disabled={saving}>
            Reopen it
          </button>
          <button className="secondary" onClick={onClose} disabled={saving}>
            Close
          </button>
        </div>
        <p className="panel-note">Reopened, what it paid back is open again, and it counts as the bank shows it.</p>
      </Sheet>
    );
  }

  return (
    <Sheet open title={direction === 'to_you' ? 'This paid back…' : 'This paid…'} onClose={() => !saving && onClose()}>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {shownName(t)}: <Masked>{formatMoney(Math.abs(rowAmount), currency)}</Masked> {direction === 'to_you' ? 'in' : 'out'} on {shownDay(t.date)}.{' '}
        {direction === 'to_you'
          ? 'Choose what it paid back: that much of it is money between you and them, never income.'
          : 'Choose what it paid of what you owe: that much of it is money between you and them, never spending.'}
      </p>
      {also && also.length > 0 && person && <p className="stale-note">{whoseText([nameOf(person), ...also.map(nameOf)])}: choose whose it is.</p>}
      <div className="sheet-form">
        <ItemPicker items={shown} card={card} picked={picked} onPick={setPicked} currency={currency} disabled={saving} />
        <label className="field">
          Note (optional)
          <input className="text-input" value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} disabled={saving} />
        </label>
      </div>
      <p className={`split-left${ready ? ' done' : ''}`} role="status">
        <Masked>
          {sum < 0
            ? `What you chose comes to ${money(-sum)} the other way`
            : sum > whole
            ? `That is ${money(sum - whole)} more than the payment`
            : sum === whole
              ? 'All of it pays back what you chose.'
              : `${money(sum)} of it pays back what you chose; the other ${money(whole - sum)} counts as the bank shows it.`}
        </Masked>
      </p>
      {error && (
        <div className="error">
          <Masked>{hideAmountsIn(error)}</Masked>
        </div>
      )}
      <div className="button-pair">
        <button onClick={() => void confirm()} disabled={!ready || saving}>
          {saving ? 'Saving…' : 'Confirm'}
        </button>
        <button className="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
      {fromProposal && (
        <button className="secondary" style={{ marginTop: 12 }} onClick={() => void act('PATCH', { action: 'dismiss', transaction_id: t.transaction_id })} disabled={saving}>
          Not a repayment
        </button>
      )}
    </Sheet>
  );
}

/** Whether letting these go makes a part yours: only a part of a shared
 *  transaction someone owed you does, and only when shared transactions count
 *  your part. An IOU owed to you let go changes no total, and under `bank`
 *  nothing moves. */
export function letGoBecomesYours(counting: CardAnswer['counting'], allocations: readonly { item: string }[], items: readonly Pick<ItemState, 'id' | 'kind' | 'direction'>[]): boolean {
  return (
    counting === 'part' &&
    allocations.some((a) => {
      const i = items.find((x) => x.id === a.item);
      return i?.kind === 'share' && i.direction === 'to_you';
    })
  );
}

/** Settled outside your accounts (cash, another app, anything Nya can't
 *  see), or let go: the items, a day and a note. */
export function SettleSheet({
  person,
  currency,
  letGo,
  shared,
  onClose,
}: {
  person: string | null;
  currency: string;
  letGo?: boolean;
  shared: SharedExpenses;
  onClose: () => void;
}) {
  const card = shared.card;
  const [kind, setKind] = useState<'outside' | 'forgiven'>('outside');
  const [picked, setPicked] = useState<Picked>(new Map());
  const [day, setDay] = useState(localDate());
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const items = useMemo(() => (card && person ? card.items.filter((i) => i.person === person && i.currency === currency && i.open > 0) : []), [card, person, currency]);
  const places = Math.round(Math.log10(unitScale(currency)));

  useEffect(() => {
    if (!person) return;
    setKind(letGo ? 'forgiven' : 'outside');
    // Let go of what they owe you; settled, all of it.
    setPicked(new Map(items.filter((i) => !letGo || i.direction === 'to_you').map((i) => [i.id, fieldAmount(i.open, places)])));
    setDay(localDate());
    setNote('');
    setError('');
    // Afresh each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person, currency, letGo]);

  if (!person || !card) return <Sheet open={false} title="Mark settled" onClose={onClose}>{null}</Sheet>;
  const name = card.people.find((p) => p.id === person)?.name ?? REMOVED_NAME;
  const allocations = allocationsOf(picked, items, currency);
  const ready = !!allocations && allocations.length > 0 && !!day;
  const lettingGoYours = kind === 'forgiven' && letGoBecomesYours(card.counting, allocations ?? [], items);

  async function save() {
    setSaving(true);
    setError('');
    const sent = await shared.send(SHARED_ROUTES.close, 'POST', { kind, items: allocations, date: day, ...(note.trim() ? { note: note.trim() } : {}) });
    setSaving(false);
    if (sent.error) return setError(sent.error);
    onClose();
  }

  return (
    <Sheet open title={kind === 'forgiven' ? 'Let it go' : 'Mark settled'} onClose={() => !saving && onClose()}>
      <fieldset className="lifecycle-choices" disabled={saving}>
        <legend className="section-label">With {name}</legend>
        <label className="lifecycle-choice">
          <input type="radio" name="settle-kind" checked={kind === 'outside'} onChange={() => setKind('outside')} />
          <span>
            <span className="lifecycle-choice-name">Settled outside your accounts</span>
            <span className="lifecycle-choice-note">Cash, another app, anything Nya can’t see.</span>
          </span>
        </label>
        <label className="lifecycle-choice">
          <input type="radio" name="settle-kind" checked={kind === 'forgiven'} onChange={() => setKind('forgiven')} />
          <span>
            <span className="lifecycle-choice-name">Let it go</span>
            <span className="lifecycle-choice-note">No one pays it.</span>
          </span>
        </label>
      </fieldset>
      <div className="sheet-form">
        <ItemPicker items={items} card={card} picked={picked} onPick={setPicked} currency={currency} disabled={saving} />
        <label className="field">
          On
          <input type="date" value={day} min="1970-01-01" max={localDate()} onChange={(e) => setDay(e.target.value)} disabled={saving} />
        </label>
        <label className="field">
          Note (optional)
          <input className="text-input" value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} disabled={saving} />
        </label>
      </div>
      {lettingGoYours && (
        <p className="panel-note">
          What {name} owed you of a shared transaction becomes your part, on the day you bought it: your spending that month goes up by it.
        </p>
      )}
      {error && (
        <div className="error">
          <Masked>{hideAmountsIn(error)}</Masked>
        </div>
      )}
      <div className="button-pair">
        <button onClick={() => void save()} disabled={!ready || saving}>
          {saving ? 'Saving…' : kind === 'forgiven' ? 'Let it go' : 'Mark settled'}
        </button>
        <button className="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
