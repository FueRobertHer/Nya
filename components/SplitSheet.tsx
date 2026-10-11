'use client';

// Splitting a transaction into parts (#39), from its detail on the Activity
// tab: rows of an amount and a category (the picker every transaction uses),
// a note if wanted, and what is left to split, saved only once the parts add
// up to the transaction exactly (app/api/transaction-splits checks it again).
// Opened on a transaction already split, it edits the split, and offers to
// unsplit it, after asking. Amounts are typed without a sign: each part is
// money out when the transaction is, and money in when it is.
//
// When the bank changed the amount since the split, what changed is shown as
// left to split (the read layer keeps it as a part of its own until then,
// lib/split-rows.ts), so saving places it.

import { useEffect, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import CategoryPicker from './CategoryPicker';
import type { Txn } from './MonthBreakdown';
import { formatMoney } from '@/lib/format';
import { normalizedAmountText, MAX_NOTE_CHARS } from '@/lib/manual-txn-input';
import { currencyOf } from '@/lib/spending';
import { categoryById, displayName, indexTaxonomy, type Taxonomy } from '@/lib/categories';
import { MAX_PARTS, MIN_PARTS, PART_PREFIX, toUnits, unitScale } from '@/lib/split-rows';
import { bankKept } from './SplitRows';

/** "Oct 5": a transaction's day as the list shows it. */
function shownDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** One part as the form holds it: the amount as typed. */
type Draft = { key: string; id?: string; amount: string; category_id: string; note: string; excluded: boolean };

let keys = 0;
const newKey = () => `part-${++keys}`;

/** An amount as the form shows it, unsigned, in the currency's places. */
function typed(amount: number, scale: number): string {
  return (Math.abs(toUnits(amount, scale)) / scale).toFixed(Math.round(Math.log10(scale)));
}

/** The parts the form starts from: the split's own (what the bank changed
 *  since is left to split), or two empty ones under the transaction's
 *  category. */
export function startingParts(t: Txn, uncategorized: string): Draft[] {
  const scale = unitScale(currencyOf(t));
  const stored = (t.split_parts ?? []).filter((p) => !p.split_remainder);
  if (stored.length > 0) {
    return stored.map((p) => ({
      key: newKey(),
      id: p.transaction_id.startsWith(PART_PREFIX) ? p.transaction_id.slice(PART_PREFIX.length) : undefined,
      amount: typed(p.amount, scale),
      category_id: p.category_id ?? uncategorized,
      note: p.note ?? '',
      excluded: p.split_excluded === true,
    }));
  }
  const category_id = t.category_id ?? uncategorized;
  return [
    { key: newKey(), amount: '', category_id, note: '', excluded: false },
    { key: newKey(), amount: '', category_id, note: '', excluded: false },
  ];
}

/**
 * A part's amount as typed, in whole units of the transaction's currency (as
 * the read layer counts it, lib/split-rows.ts unitScale: cents, yen, eight
 * places for a currency without an ISO code), read from the text itself, so
 * no place is lost to rounding; null when it isn't an amount, is nothing, or
 * is finer than the currency's unit. Typed as any amount is ("49,99").
 */
export function partUnits(text: string, currency: string | null): number | null {
  const normal = normalizedAmountText(text);
  if (normal === null) return null;
  const [whole, fraction = ''] = normal.split('.');
  const places = Math.round(Math.log10(unitScale(currency)));
  if (/[1-9]/.test(fraction.slice(places))) return null;
  const units = Number(whole || '0') * 10 ** places + Number(fraction.slice(0, places).padEnd(places, '0') || '0');
  return Number.isSafeInteger(units) && units > 0 ? units : null;
}

/** What is left to split, in the currency's smallest units: the whole less
 *  the parts typed (null for a part that isn't an amount yet). */
export function leftToSplit(whole: number, drafts: readonly Pick<Draft, 'amount'>[], currency: string | null): { left: number; parsed: (number | null)[] } {
  const scale = unitScale(currency);
  const units = drafts.map((d) => (d.amount.trim() ? partUnits(d.amount, currency) : null));
  const sum = units.reduce<number>((n, u) => n + (u ?? 0), 0);
  return { left: toUnits(Math.abs(whole), scale) - sum, parsed: units.map((u) => (u === null ? null : u / scale)) };
}

export default function SplitSheet({
  t,
  taxonomy,
  onClose,
  onSaved,
}: {
  /** The transaction to split, or one split already, put back whole with its
   *  parts (lib/split-rows.ts bankRows); null when closed. */
  t: Txn | null;
  taxonomy: Taxonomy;
  onClose: () => void;
  /** After a save or an unsplit: the list is read again. */
  onSaved: () => void;
}) {
  // From the transaction it opens on (and afresh each time it opens on one).
  const [drafts, setDrafts] = useState<Draft[]>(() => (t ? startingParts(t, taxonomy.uncategorized) : []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const ix = useMemo(() => indexTaxonomy(taxonomy), [taxonomy]);

  // A fresh form each time it opens on a transaction.
  useEffect(() => {
    if (!t) return;
    setDrafts(startingParts(t, taxonomy.uncategorized));
    setError('');
    setConfirming(false);
  }, [t, taxonomy.uncategorized]);

  if (!t) return <Sheet open={false} title="Split" onClose={onClose}>{null}</Sheet>;

  const currency = currencyOf(t);
  const scale = unitScale(currency);
  const money = (units: number) => formatMoney(Math.abs(units) / scale, currency);
  const split = (t.split_parts?.length ?? 0) > 0;
  const changed = t.split_parts?.find((p) => p.split_remainder);
  const { left, parsed } = leftToSplit(t.amount, drafts, currency);
  const ready = drafts.length >= MIN_PARTS && parsed.every((a) => a !== null && a > 0) && drafts.every((d) => d.category_id) && left === 0;
  const own = t.category_id ? categoryById(ix, t.category_id) : null;
  const direction = t.amount < 0 ? 'in' : 'out';

  const set = (key: string, change: Partial<Draft>) => setDrafts((all) => all.map((d) => (d.key === key ? { ...d, ...change } : d)));
  // The part takes what is left, on top of what it has.
  const fill = (key: string) =>
    setDrafts((all) =>
      all.map((d, i) => {
        if (d.key !== key) return d;
        const mine = parsed[i] === null ? 0 : toUnits(parsed[i]!, scale);
        return { ...d, amount: typed((mine + left) / scale, scale) };
      })
    );

  async function send(method: 'PUT' | 'DELETE', body: unknown): Promise<boolean> {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/transaction-splits', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) {
        onSaved();
        onClose();
        return true;
      }
      const data = await res.json().catch(() => null);
      setError(data?.error ?? 'Could not save that. Please try again.');
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
    return false;
  }

  // The split as it was when the sheet opened (none for a new one), so one
  // changed meanwhile on another device is refused, never written over; not
  // said for one that no longer fits its transaction, which isn't shown.
  const seen = t.split_parts ? (t.split_parts[0]?.split_updated_at ?? undefined) : t.split_unapplied ? undefined : null;
  const save = () =>
    send('PUT', {
      transaction_id: t.transaction_id,
      ...(seen !== undefined ? { updated_at: seen } : {}),
      parts: drafts.map((d, i) => ({
        ...(d.id ? { id: d.id } : {}),
        amount: Math.sign(t.amount) * parsed[i]!,
        category_id: d.category_id,
        ...(d.note.trim() ? { note: d.note.trim() } : {}),
        ...(d.excluded ? { excluded: true } : {}),
      })),
    });

  return (
    <Sheet open title={split ? 'Edit split' : 'Split transaction'} onClose={() => !saving && onClose()}>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {t.name}: {formatMoney(Math.abs(t.amount), currency)} {direction === 'out' ? 'out' : 'in'}, on {shownDay(t.date)}. Give each part its own category: the parts
        count in budgets and reports, and the transaction stays one, as the bank has it.
      </p>
      {changed && changed.split_remainder && (
        <div className="stale-note">
          {bankKept(t) ? 'The bank changed this amount' : 'This amount changed'} from {formatMoney(Math.abs(changed.split_remainder.was), currency)} to{' '}
          {formatMoney(Math.abs(t.amount), currency)} since you split it. Place the difference below.
        </div>
      )}
      <div className="sheet-form">
        {drafts.map((d, i) => (
          <div className="split-part" key={d.key}>
            <div className="split-part-top">
              <label className="field split-amount">
                Part {i + 1}
                <input
                  inputMode="decimal"
                  autoComplete="off"
                  value={d.amount}
                  onChange={(e) => set(d.key, { amount: e.target.value })}
                  placeholder={typed(0, scale)}
                  aria-invalid={d.amount.trim() !== '' && parsed[i] === null}
                  disabled={saving}
                />
              </label>
              <label className="field split-category">
                Category
                <CategoryPicker taxonomy={taxonomy} value={d.category_id} onChange={(id) => set(d.key, { category_id: id })} disabled={saving} />
              </label>
            </div>
            <input
              className="text-input split-note"
              value={d.note}
              maxLength={MAX_NOTE_CHARS}
              onChange={(e) => set(d.key, { note: e.target.value })}
              placeholder="Note (optional)"
              aria-label={`Note for part ${i + 1}`}
              disabled={saving}
            />
            <div className="split-part-actions">
              {left !== 0 && (
                <button className="secondary split-small" onClick={() => fill(d.key)} disabled={saving || (left < 0 && (parsed[i] === null || toUnits(parsed[i]!, scale) + left <= 0))}>
                  {left > 0 ? 'Put the rest here' : 'Take the excess off'}
                </button>
              )}
              {drafts.length > MIN_PARTS && (
                <button className="secondary split-small" onClick={() => setDrafts((all) => all.filter((x) => x.key !== d.key))} disabled={saving} aria-label={`Remove part ${i + 1}`}>
                  Remove
                </button>
              )}
            </div>
          </div>
        ))}
        {drafts.length < MAX_PARTS && (
          <button
            className="secondary"
            onClick={() => setDrafts((all) => [...all, { key: newKey(), amount: '', category_id: t.category_id ?? taxonomy.uncategorized, note: '', excluded: false }])}
            disabled={saving}
          >
            Add a part
          </button>
        )}
      </div>
      <p className={`split-left${left === 0 ? ' done' : ''}`} role="status">
        {left === 0 ? 'The parts add up to the transaction.' : left > 0 ? `${money(left)} left to split` : `${money(left)} more than the transaction`}
      </p>
      {error && <div className="error">{error}</div>}
      <div className="button-pair">
        <button onClick={save} disabled={!ready || saving}>
          {saving ? 'Saving…' : 'Save split'}
        </button>
        <button className="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
      {split && !confirming && (
        <button className="secondary" style={{ marginTop: 12 }} onClick={() => setConfirming(true)} disabled={saving}>
          Unsplit
        </button>
      )}
      {split && confirming && (
        <>
          <p className="panel-note">
            Unsplit {t.name}? Its parts go, and it counts whole again, under {own ? displayName(own.name) : 'its own category'}.
          </p>
          <div className="button-pair">
            <button className="danger" onClick={() => send('DELETE', { transaction_id: t.transaction_id, ...(seen !== undefined ? { updated_at: seen } : {}) })} disabled={saving}>
              Unsplit
            </button>
            <button className="secondary" onClick={() => setConfirming(false)} disabled={saving}>
              Keep the split
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
