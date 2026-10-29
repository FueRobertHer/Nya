'use client';

// The handoff (#49): asking someone for what they owe you, or paying what you
// owe them, in the app the two of you use. Nya never sends, receives or holds
// money: this opens Venmo with the request filled in (its documented link,
// lib/shared-expenses/links.ts), or gives a message to copy or share for
// Cash App, Zelle, cash or anything else. Opening the link, copying or
// sharing records that a request was sent (when, how much, how), sent with
// keepalive since opening the app can end the page; nothing about what
// happened in the app is ever known.

import { useEffect, useMemo, useState } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import { amountsHidden, formatMoney, hideAmountsIn } from '@/lib/format';
import { toUnits, unitScale } from '@/lib/split-rows';
import { isHandle, REMOVED_NAME, type Direction, type RequestVia } from '@/lib/shared-expenses/model';
import { handoffLinks, LINK_CURRENCY, messageText, NOTE_CHARS, noteOf, type MessageLine } from '@/lib/shared-expenses/links';
import { SHARED_ROUTES, type SharedExpenses } from './shared-expenses-state';
import { useAmountsHidden } from './hide-amounts';
import { Notice } from './TotalCaveats';

export default function HandoffSheet({ person, currency, shared, onClose }: { person: string | null; currency: string; shared: SharedExpenses; onClose: () => void }) {
  const card = shared.card;
  const p = card?.people.find((x) => x.id === person) ?? null;
  const balance = (card?.balances && person ? card.balances[person] : undefined)?.find((b) => b.currency === currency) ?? null;
  const direction: Direction = (balance?.amount ?? 0) >= 0 ? 'to_you' : 'by_you';
  const amount = Math.abs(balance?.amount ?? 0);
  // What it comes to, item by item, from the payer's side.
  const open = useMemo(() => (card && person ? card.items.filter((i) => i.person === person && i.currency === currency && i.open > 0) : []), [card, person, currency]);
  const lines: MessageLine[] = open.map((i) => ({ what: i.what, date: i.date, amount: i.open, direction: i.direction }));
  const [note, setNote] = useState(() => noteOf(lines));
  const [venmo, setVenmo] = useState('');
  const [said, setSaid] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // While amounts are hidden the message on screen shows none; what is
  // copied or shared has them, and the buttons say so.
  useAmountsHidden(); // drawn again when amounts are hidden or shown
  const hidden = amountsHidden();

  useEffect(() => {
    if (!person) return;
    setNote(noteOf(lines));
    setVenmo('');
    setSaid('');
    setError('');
    // Afresh each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person, currency]);

  if (!card || !p || !person || amount === 0) return <Sheet open={false} title="Ask for it" onClose={onClose}>{null}</Sheet>;

  const name = p.name ?? REMOVED_NAME;
  const links = handoffLinks({ direction, amount, currency, note, venmo: p.venmo ?? undefined, cashtag: p.cashtag ?? undefined });
  const message = messageText({
    name,
    direction,
    amount,
    currency,
    lines,
    venmo: p.venmo ?? undefined,
    cashtag: p.cashtag ?? undefined,
    ownVenmo: card.own.venmo ?? undefined,
    ownCashtag: card.own.cashtag ?? undefined,
  });
  const scale = unitScale(currency);

  // That it was sent, and how: best effort, never in the way of the app.
  const record = (via: RequestVia) => {
    void shared.send(
      SHARED_ROUTES.people,
      'PATCH',
      { id: person, action: 'request', direction, amount: toUnits(amount, scale) / scale, currency, via, items: open.filter((i) => i.direction === direction).map((i) => i.id) },
      { keepalive: true, moves: false }
    );
  };

  async function copy() {
    try {
      await navigator.clipboard.writeText(message);
      setSaid('Copied. Paste it wherever you two talk.');
      record('message');
    } catch {
      setSaid('Couldn’t copy it here: select the message and copy it.');
    }
  }
  async function share() {
    try {
      await navigator.share({ text: message });
      record('message');
    } catch {
      // Closed without sharing: nothing was sent.
    }
  }
  async function saveVenmo() {
    const handle = venmo.trim().replace(/^@/, '');
    if (!isHandle(handle)) return setError('A Venmo username is letters, digits, - and _.');
    setSaving(true);
    setError('');
    const sent = await shared.send(SHARED_ROUTES.people, 'PATCH', { id: person, action: 'edit', venmo: handle }, { moves: false });
    setSaving(false);
    if (sent.error) setError(sent.error);
  }

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const verb = direction === 'to_you' ? 'Request' : 'Pay';

  return (
    <Sheet open title={direction === 'to_you' ? `Ask ${name} for it` : `Pay ${name}`} onClose={onClose}>
      <p className="panel-note" style={{ marginTop: 0 }}>
        <Masked>{direction === 'to_you' ? `${name} owes you ${formatMoney(amount, currency)}.` : `You owe ${name} ${formatMoney(amount, currency)}.`}</Masked>
      </p>
      <p className="panel-note">
        Nya never sends, receives or holds money.{' '}
        {links.length > 0
          ? `This opens Venmo with the ${direction === 'to_you' ? 'request' : 'payment'} filled in; you send it there, and the money moves in Venmo between you and ${name}. When it reaches one of your accounts, Nya offers to mark it paid back.`
          : `Send ${name} the message below however you two pay each other; the money moves there. When it reaches one of your accounts, Nya offers to mark it paid back.`}
      </p>
      {currency === LINK_CURRENCY && links.length > 0 && (
        <label className="field">
          Note on Venmo
          <input className="text-input" value={note} maxLength={NOTE_CHARS} onChange={(e) => setNote(e.target.value)} />
          <span className="lifecycle-choice-note">Venmo may show this note to your Venmo friends.</span>
        </label>
      )}
      {links.map((l) => (
        <a key={l.href} className="report-link-button" href={l.href} target="_blank" rel="noopener noreferrer" onClick={() => record(l.via)}>
          {verb} on {l.app}
          {l.unconfirmed ? ' (not yet checked on a phone)' : ''}
        </a>
      ))}
      {currency === LINK_CURRENCY && !p.venmo && (
        <div className="rename-row">
          <input
            className="text-input"
            value={venmo}
            maxLength={31}
            onChange={(e) => setVenmo(e.target.value)}
            placeholder={`${name}’s Venmo username`}
            aria-label={`${name}’s Venmo username`}
            disabled={saving}
          />
          <button className="secondary" onClick={() => void saveVenmo()} disabled={saving || !venmo.trim()}>
            Add
          </button>
        </div>
      )}
      <div className="section-label" style={{ marginTop: 16 }}>
        Or send a message
      </div>
      <p className="shared-message">
        <Masked>{hideAmountsIn(message)}</Masked>
      </p>
      <div className="stack tight">
        <div className="button-pair">
          <button className="secondary" onClick={() => void copy()}>
            {hidden ? 'Copy the message, amounts included' : 'Copy the message'}
          </button>
          {canShare && (
            <button className="secondary" onClick={() => void share()}>
              {hidden ? 'Share it, amounts included…' : 'Share…'}
            </button>
          )}
        </div>
        {said && (
          <p className="panel-note" role="status">
            {said}
          </p>
        )}
        {error && (
          <Notice level="critical" role="alert">
            {error}
          </Notice>
        )}
      </div>
    </Sheet>
  );
}
