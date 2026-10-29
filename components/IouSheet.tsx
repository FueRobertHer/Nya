'use client';

// An IOU (#49): something owed that no transaction of yours shows. Someone
// paid for you (you owe them your part; with a category, your part counts as
// spending on its day, as if you had bought it), or you lent someone money
// or paid for them in cash (they owe you). A loan you owe, with no category,
// is no spending, nor is paying it back. Saved through
// app/api/shared-expenses/ious.

import { useEffect, useId, useState } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import FieldError, { amountExample } from './FieldError';
import CategoryPicker from './CategoryPicker';
import { fieldAmount, hideAmountsIn, zeroExample } from '@/lib/format';
import { localDate } from '@/lib/local-date';
import { unitScale } from '@/lib/split-rows';
import type { Taxonomy } from '@/lib/categories';
import { REMOVED_NAME, WHAT_MAX, type Direction } from '@/lib/shared-expenses/model';
import { partUnits } from './SplitSheet';
import { SHARED_ROUTES, type SharedExpenses } from './shared-expenses-state';

type Draft = { person: string; direction: Direction; amount: string; currency: string; date: string; what: string; category_id: string };

export default function IouSheet({
  id,
  person,
  open,
  currency,
  taxonomy,
  shared,
  onClose,
}: {
  id: string | null;
  person?: string;
  open: boolean;
  /** The currency a new one is in, until changed. */
  currency: string;
  taxonomy: Taxonomy | null;
  shared: SharedExpenses;
  onClose: () => void;
}) {
  const card = shared.card;
  const item = id ? (card?.items.find((i) => i.id === id && i.kind === 'iou') ?? null) : null;
  const [draft, setDraft] = useState<Draft>({ person: '', direction: 'by_you', amount: '', currency, date: localDate(), what: '', category_id: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!open) return;
    const people = card?.people.filter((p) => !p.archived && !p.removed) ?? [];
    setDraft(
      item
        ? {
            person: item.person,
            direction: item.direction,
            amount: fieldAmount(item.amount, Math.round(Math.log10(unitScale(item.currency)))),
            currency: item.currency,
            date: item.date,
            what: item.what,
            category_id: item.category_id ?? '',
          }
        : { person: person ?? people[0]?.id ?? '', direction: 'by_you', amount: '', currency, date: localDate(), what: '', category_id: '' }
    );
    setError('');
    setAsking(false);
    // Afresh each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id]);

  if (!open || !card) return <Sheet open={false} title="IOU" onClose={onClose}>{null}</Sheet>;

  const set = (change: Partial<Draft>) => setDraft((d) => ({ ...d, ...change }));
  const people = card.people.filter((p) => (!p.archived && !p.removed) || p.id === draft.person);
  const code = draft.currency.trim().toUpperCase();
  const units = draft.amount.trim() ? partUnits(draft.amount, code) : null;
  const ready = !!draft.person && units !== null && /^[A-Z]{3}$/.test(code) && !!draft.date && draft.what.trim().length > 0;
  const places = Math.round(Math.log10(unitScale(code)));
  const amountError = useId();

  async function run(method: 'POST' | 'PATCH' | 'DELETE', body: unknown) {
    setSaving(true);
    setError('');
    const sent = await shared.send(SHARED_ROUTES.ious, method, body);
    setSaving(false);
    if (sent.error) return setError(sent.error);
    onClose();
  }
  const fields = () => ({
    person: draft.person,
    direction: draft.direction,
    amount: units! / unitScale(code),
    currency: code,
    date: draft.date,
    what: draft.what.trim(),
    category_id: draft.direction === 'by_you' && draft.category_id ? draft.category_id : null,
  });

  return (
    <Sheet open title={id ? 'IOU' : 'Add an IOU'} onClose={() => !saving && onClose()}>
      <p className="panel-note" style={{ marginTop: 0 }}>
        Something owed that none of your transactions shows. Did you pay for it from an account in Nya? Share that transaction instead.
      </p>
      <div className="sheet-form">
        <label className="field">
          With
          <select className="text-input" value={draft.person} onChange={(e) => set({ person: e.target.value })} disabled={saving}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? REMOVED_NAME}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="lifecycle-choices" disabled={saving}>
          <legend className="section-label">Who owes whom</legend>
          <label className="lifecycle-choice">
            <input type="radio" name="iou-direction" checked={draft.direction === 'by_you'} onChange={() => set({ direction: 'by_you' })} />
            <span>
              <span className="lifecycle-choice-name">They paid: you owe them</span>
              <span className="lifecycle-choice-note">Your part of something they bought, or money they lent you.</span>
            </span>
          </label>
          <label className="lifecycle-choice">
            <input type="radio" name="iou-direction" checked={draft.direction === 'to_you'} onChange={() => set({ direction: 'to_you' })} />
            <span>
              <span className="lifecycle-choice-name">You paid: they owe you</span>
              <span className="lifecycle-choice-note">Cash you lent them, or paid for them.</span>
            </span>
          </label>
        </fieldset>
        <div className="split-part-top">
          <label className="field split-amount">
            Amount
            <input
              inputMode="decimal"
              autoComplete="off"
              value={draft.amount}
              onChange={(e) => set({ amount: e.target.value })}
              placeholder={zeroExample(places)}
              aria-invalid={draft.amount.trim() !== '' && units === null}
              aria-describedby={draft.amount.trim() !== '' && units === null ? amountError : undefined}
              disabled={saving}
            />
          </label>
          <label className="field">
            Currency
            <input className="text-input" value={draft.currency} maxLength={3} onChange={(e) => set({ currency: e.target.value })} disabled={saving || !!id} autoComplete="off" />
          </label>
        </div>
        {draft.amount.trim() !== '' && units === null && <FieldError id={amountError}>Enter an amount, like {amountExample(places)}</FieldError>}
        <label className="field">
          On
          <input type="date" value={draft.date} min="1970-01-01" max={localDate()} onChange={(e) => set({ date: e.target.value })} disabled={saving} />
        </label>
        <label className="field">
          What it was for
          <input className="text-input" value={draft.what} maxLength={WHAT_MAX} onChange={(e) => set({ what: e.target.value })} disabled={saving} />
        </label>
        {draft.direction === 'by_you' && taxonomy && (
          <label className="field">
            Your part was for
            <CategoryPicker taxonomy={taxonomy} value={draft.category_id} onChange={(v) => set({ category_id: v })} none="A loan: not spending" disabled={saving} />
            <span className="lifecycle-choice-note">With a category, your part counts as spending on this day. A loan has none, and paying it back is no spending.</span>
          </label>
        )}
      </div>
      {error && (
        <div className="error">
          <Masked>{hideAmountsIn(error)}</Masked>
        </div>
      )}
      <div className="button-pair">
        <button onClick={() => void run(id ? 'PATCH' : 'POST', id ? { id, ...fields() } : fields())} disabled={!ready || saving}>
          {saving ? 'Saving…' : id ? 'Save' : 'Add'}
        </button>
        <button className="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
      {id && !asking && (
        <button className="secondary" style={{ marginTop: 12 }} onClick={() => setAsking(true)} disabled={saving}>
          Delete this IOU
        </button>
      )}
      {id && asking && (
        <>
          <p className="panel-note">Delete it? What it counted goes from your totals, and it is no longer in your balance with them.</p>
          <div className="button-pair">
            <button className="danger" onClick={() => void run('DELETE', { id })} disabled={saving}>
              Delete
            </button>
            <button className="secondary" onClick={() => setAsking(false)} disabled={saving}>
              Keep it
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
