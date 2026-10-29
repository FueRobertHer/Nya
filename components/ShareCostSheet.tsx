'use client';

// Share the cost (#49): who shares one of your transactions with you, and
// what each owes of it, from the transaction on the Activity tab. Half with
// one person, evenly among the people and you, or by amount; your part is
// the rest. On a split transaction, one of its parts is shared. Saved through
// app/api/shared-expenses/shares, which checks it all again against the
// transaction as stored; opened on a shared one, it changes who owes what or
// stops sharing it (after asking). Nothing is sent to anyone: this keeps the
// list, and the card offers to ask them for it.

import { useEffect, useId, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import FieldError, { amountExample } from './FieldError';
import type { Txn } from './MonthBreakdown';
import { fieldAmount, formatDay, formatMoney, hideAmountsIn, onDay, zeroExample } from '@/lib/format';
import { currencyOf } from '@/lib/spending';
import { PART_PREFIX, toUnits, unitScale } from '@/lib/split-rows';
import { IMPORTED_TXN_PREFIX } from '@/lib/history-import/view';
import { MAX_ENTRIES, REMOVED_NAME, WHAT_MAX, type SplitHow } from '@/lib/shared-expenses/model';
import type { CardAnswer } from '@/lib/shared-expenses/read';
import { partUnits } from './SplitSheet';
import { splitUnits } from './shared-expenses-text';
import { shownName } from '@/lib/merchant-name';
import { SHARED_ROUTES, type SharedExpenses } from './shared-expenses-state';

type Mode = 'half' | 'even' | 'amount';
type Pick = { person: string; amount: string };

/** "on Oct 5", "today": a transaction's day mid sentence. */
function onShownDay(iso: string): string {
  return onDay(formatDay(iso, { sentence: true }));
}

/** What can be shared of a transaction: the transaction itself, or each part
 *  of a split one, at the amount it has before anyone's part is taken off. */
export function shareTargets(t: Txn): { key: string; part: string | null; label: string; amount: number; row: Txn }[] {
  const whole = (r: Txn) => r.shared_was ?? r.amount;
  if (t.split_parts && t.split_parts.length > 0) {
    return t.split_parts
      .filter((p) => !p.shared_part && p.transaction_id.startsWith(PART_PREFIX))
      .map((p) => ({ key: p.transaction_id, part: p.transaction_id.slice(PART_PREFIX.length), label: p.category_name ?? p.category ?? 'Part', amount: whole(p), row: p }));
  }
  return [{ key: t.transaction_id, part: null, label: shownName(t), amount: whole(t), row: t }];
}

/** Where a share of `t` is kept: the transaction's id, that of the row
 *  imported from a file that it stands for, whose share it shows, or the
 *  transaction it was on before a re-link carried it here. */
export const shareKeptUnder = (t: Txn): string => t.shared_carried_from ?? t.split_of ?? t.transaction_id;

/** A share carried here across a re-link (lib/shared-expenses/rows.ts), kept
 *  under the transaction it was on before: saving moves it onto this one.
 *  Never one carried from a row imported from a file, which stays its own. */
export const carriedAcrossLink = (t: Txn): string | null =>
  t.shared_carried_from !== undefined && !t.shared_carried_from.startsWith(IMPORTED_TXN_PREFIX) ? t.shared_carried_from : null;

export default function ShareCostSheet({ t, shared, onClose }: { t: Txn | null; shared: SharedExpenses; onClose: () => void }) {
  const card = shared.card;
  const targets = useMemo(() => (t ? shareTargets(t) : []), [t]);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const errorId = useId();
  const [picks, setPicks] = useState<Pick[]>([]);
  const [mode, setMode] = useState<Mode>('half');
  const [what, setWhat] = useState('');
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);

  const target = targets.find((x) => x.key === targetKey) ?? targets.find((x) => x.row.shared) ?? targets[0] ?? null;
  const kept = t ? shareKeptUnder(t) : '';
  const stored = card && target ? (card.shares.find((s) => s.transaction_id === kept && (s.part ?? null) === target.part) ?? null) : null;

  // A fresh form each time it opens, from the share as stored.
  useEffect(() => {
    if (!t) return;
    const first = shareTargets(t).find((x) => x.row.shared) ?? shareTargets(t)[0];
    setTargetKey(first?.key ?? null);
    setError('');
    setConfirming(false);
    setNewName('');
  }, [t]);
  useEffect(() => {
    if (!t || !target) return;
    const scale = unitScale(currencyOf(t));
    if (stored) {
      setPicks(stored.entries.map((e) => ({ person: e.person, amount: fieldAmount(e.amount, Math.round(Math.log10(scale))) })));
      const how = stored.entries[0]?.how?.kind;
      setMode(how === 'half' || how === 'even' ? how : 'amount');
      setWhat(stored.what);
    } else {
      setPicks([]);
      setMode('half');
      setWhat(target.part ? `${t.name}: ${target.label}` : t.name);
    }
    // Only when the target or the stored share changes, never on each keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, target?.key, stored?.updated_at]);

  if (!t || !card || !target) return <Sheet open={false} title="Share the cost" onClose={onClose}>{null}</Sheet>;

  const currency = currencyOf(t);
  const scale = unitScale(currency);
  const places = Math.round(Math.log10(scale));
  const totalUnits = toUnits(target.amount, scale);
  const money = (units: number) => formatMoney(units / scale, currency);
  // Those who can be given a part, and anyone it already gives one to (an
  // archived or forgotten person's part stays while it is left as it is).
  const people = card.people.filter((p) => (!p.archived && !p.removed) || picks.some((x) => x.person === p.id));
  const nameOf = (id: string) => card.people.find((p) => p.id === id)?.name ?? REMOVED_NAME;

  // The amounts the way of splitting gives, or as typed.
  const auto = mode === 'amount' ? null : splitUnits(totalUnits, mode === 'half' ? { kind: 'half' } : { kind: 'even', ways: picks.length + 1 }, picks.length);
  const units = picks.map((p, i) => (auto ? (auto[i] ?? null) : p.amount.trim() ? partUnits(p.amount, currency) : null));
  const lent = units.reduce<number>((n, u) => n + (u ?? 0), 0);
  const yours = totalUnits - lent;
  const ready = picks.length > 0 && units.every((u) => u !== null && u > 0) && yours >= 0 && (mode !== 'half' || picks.length === 1);
  const how = (): SplitHow => (mode === 'half' ? { kind: 'half' } : mode === 'even' ? { kind: 'even', ways: picks.length + 1 } : { kind: 'amount' });

  const toggle = (person: string) => {
    const next = picks.some((p) => p.person === person) ? picks.filter((p) => p.person !== person) : [...picks, { person, amount: '' }];
    setPicks(next);
    // Half is with one person; evenly, with more.
    if (next.length > 1 && mode === 'half') setMode('even');
    if (next.length === 1 && mode === 'even') setMode('half');
  };
  const type = (person: string, amount: string) => {
    setMode('amount');
    setPicks((all) => all.map((p, i) => (p.person === person ? { ...p, amount } : auto && auto[i] !== undefined ? { ...p, amount: fieldAmount(auto[i] / scale, places) } : p)));
  };

  async function addPerson() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    setError('');
    const sent = await shared.send(SHARED_ROUTES.people, 'POST', { name }, { moves: false });
    setSaving(false);
    if (sent.error) return setError(sent.error);
    const id = typeof sent.body?.id === 'string' ? sent.body.id : null;
    setNewName('');
    if (id) toggle(id);
  }

  async function save() {
    setSaving(true);
    setError('');
    const sent = await shared.send(SHARED_ROUTES.shares, 'PUT', {
      // Carried across a re-link: saved onto this transaction, from the one it
      // was on.
      ...(t && carriedAcrossLink(t) ? { transaction_id: t.transaction_id, carried_from: carriedAcrossLink(t) } : { transaction_id: kept }),
      ...(target!.part ? { part: target!.part } : {}),
      ...(what.trim() ? { what: what.trim() } : {}),
      updated_at: stored?.updated_at ?? null,
      entries: picks.map((p, i) => ({ person: p.person, amount: units[i]! / scale, how: how() })),
    });
    setSaving(false);
    if (sent.error) return setError(sent.error);
    onClose();
  }

  async function stop() {
    setSaving(true);
    setError('');
    const sent = await shared.send(SHARED_ROUTES.shares, 'DELETE', { transaction_id: kept, updated_at: stored?.updated_at ?? null });
    setSaving(false);
    if (sent.error) return setError(sent.error);
    onClose();
  }

  return (
    <Sheet open title={stored ? 'Who owes what' : 'Share the cost'} onClose={() => !saving && onClose()}>
      <p className="panel-note" style={{ marginTop: 0 }}>
        {shownName(t)}: <Masked>{formatMoney(target.amount, currency)}</Masked> {onShownDay(t.date)}. Say who shares it with you and what each owes: your part counts in your
        budgets and reports on this day, and theirs is what they owe you. Nya never asks them for it on its own.
      </p>
      {targets.length > 1 && (
        <fieldset className="lifecycle-choices" disabled={saving}>
          <legend className="section-label">Which part of the split</legend>
          {targets.map((x) => (
            <label key={x.key} className="lifecycle-choice">
              <input type="radio" name="share-part" checked={x.key === target.key} onChange={() => setTargetKey(x.key)} />
              <span>
                <span className="lifecycle-choice-name">{x.label}</span>
                <span className="lifecycle-choice-note">
                  <Masked>{formatMoney(x.amount, currency)}</Masked>
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <fieldset className="lifecycle-choices" disabled={saving}>
        <legend className="section-label">Who shares it with you</legend>
        {people.length === 0 && <p className="panel-note">Add the people you split costs with: a name is all it needs.</p>}
        {people.map((p) => {
          const at = picks.findIndex((x) => x.person === p.id);
          return (
            <div key={p.id} className="shared-pick">
              <label className="group-member">
                <input type="checkbox" checked={at >= 0} onChange={() => toggle(p.id)} disabled={saving || (at < 0 && picks.length >= MAX_ENTRIES)} />
                <span className="group-member-text">
                  <span>{p.name ?? REMOVED_NAME}</span>
                  {(p.archived || p.removed) && <span className="type-tag">Their part stays as it is</span>}
                </span>
              </label>
              {at >= 0 && (
                <label className="field split-amount">
                  {p.name ?? REMOVED_NAME}’s part
                  <input
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label={`${p.name ?? REMOVED_NAME}’s part`}
                    value={auto ? (auto[at] !== undefined ? fieldAmount(auto[at] / scale, places) : '') : picks[at].amount}
                    onChange={(e) => type(p.id, e.target.value)}
                    placeholder={zeroExample(places)}
                    aria-invalid={!auto && picks[at].amount.trim() !== '' && units[at] === null}
                    aria-describedby={!auto && picks[at].amount.trim() !== '' && units[at] === null ? `${errorId}-${p.id}` : undefined}
                    disabled={saving}
                  />
                </label>
              )}
              {at >= 0 && !auto && picks[at].amount.trim() !== '' && units[at] === null && (
                <FieldError id={`${errorId}-${p.id}`}>Enter an amount, like {amountExample(places)}</FieldError>
              )}
            </div>
          );
        })}
        <div className="rename-row">
          <input
            className="text-input"
            value={newName}
            maxLength={60}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Someone new: their name"
            aria-label="Name of someone new"
            disabled={saving}
          />
          <button className="secondary" onClick={() => void addPerson()} disabled={saving || !newName.trim()}>
            Add
          </button>
        </div>
      </fieldset>
      {picks.length > 0 && (
        <fieldset className="lifecycle-choices" disabled={saving}>
          <legend className="section-label">How</legend>
          {picks.length === 1 && (
            <label className="lifecycle-choice">
              <input type="radio" name="share-how" checked={mode === 'half'} onChange={() => setMode('half')} />
              <span className="lifecycle-choice-name">Half each</span>
            </label>
          )}
          {picks.length > 1 && (
            <label className="lifecycle-choice">
              <input type="radio" name="share-how" checked={mode === 'even'} onChange={() => setMode('even')} />
              <span className="lifecycle-choice-name">Evenly, {picks.length + 1} ways with you</span>
            </label>
          )}
          <label className="lifecycle-choice">
            <input type="radio" name="share-how" checked={mode === 'amount'} onChange={() => setMode('amount')} />
            <span className="lifecycle-choice-name">By amount</span>
          </label>
        </fieldset>
      )}
      <label className="field">
        What it was for
        <input className="text-input" value={what} maxLength={WHAT_MAX} onChange={(e) => setWhat(e.target.value)} disabled={saving} />
      </label>
      <p className={`split-left${yours >= 0 && picks.length > 0 ? ' done' : ''}`} role="status">
        <Masked>{yours >= 0 ? `Your part: ${money(yours)}` : `The parts are ${money(-yours)} more than it`}</Masked>
      </p>
      {error && (
        <div className="error">
          <Masked>{hideAmountsIn(error)}</Masked>
        </div>
      )}
      <div className="button-pair">
        <button onClick={() => void save()} disabled={!ready || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </button>
      </div>
      {stored && !confirming && (
        <button className="secondary" style={{ marginTop: 12 }} onClick={() => setConfirming(true)} disabled={saving}>
          Stop sharing it
        </button>
      )}
      {stored && confirming && (
        <>
          <p className="panel-note">
            Stop sharing {shownName(t)}? It counts whole again, and {stored.entries.map((e) => nameOf(e.person)).join(' and ')} no longer owe{stored.entries.length === 1 ? 's' : ''} you for
            it.
          </p>
          <div className="button-pair">
            <button className="danger" onClick={() => void stop()} disabled={saving}>
              Stop sharing
            </button>
            <button className="secondary" onClick={() => setConfirming(false)} disabled={saving}>
              Keep it shared
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
