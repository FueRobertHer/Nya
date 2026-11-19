'use client';

// Someone the person splits costs with (#49): a name, and if they like their
// Venmo username, their Cash App cashtag and the app they use, so the
// handoff can fill a request in; a tag, whose transactions the card offers
// to share with them; and what is between you, item by item, with what
// closed each (settled outside your accounts or let go can be taken back).
// Archive hides someone everything with is settled; Forget takes their name
// and handles out of Nya and keeps every amount, so no total moves. Never
// their Nya account, an email, a phone number or bank details.

import { useEffect, useId, useState } from 'react';
import { Sheet } from './Sheet';
import { Masked } from './HideAmounts';
import { formatDay, formatMoney, hideAmountsIn } from '@/lib/format';
import type { Tag } from '@/lib/tags';
import { HANDLE_MAX, PERSON_NAME_MAX, REMOVED_NAME } from '@/lib/shared-expenses/model';
import { SHARED_ROUTES, type SharedExpenses } from './shared-expenses-state';
import { Notice } from './TotalCaveats';

type Draft = { name: string; venmo: string; cashtag: string; app: '' | 'venmo' | 'cashapp' | 'other'; tag: string; tagHow: 'half' | 'even'; ways: string };

/** A day as a row's tag says it ("Today", "Oct 5"), or mid sentence (`sentence`). */
function shownDay(iso: string, sentence = false): string {
  return formatDay(iso, { sentence });
}

export default function PersonSheet({ id, open, tags, shared, onClose }: { id: string | null; open: boolean; tags: readonly Tag[]; shared: SharedExpenses; onClose: () => void }) {
  const card = shared.card;
  const p = id ? (card?.people.find((x) => x.id === id) ?? null) : null;
  const [draft, setDraft] = useState<Draft>({ name: '', venmo: '', cashtag: '', app: '', tag: '', tagHow: 'half', ways: '2' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState<'forget' | 'remove' | null>(null);
  const errorId = useId();
  const askId = useId();

  useEffect(() => {
    if (!open) return;
    setDraft({
      name: p?.name ?? '',
      venmo: p?.venmo ?? '',
      cashtag: p?.cashtag ?? '',
      app: p?.app ?? '',
      tag: p?.tag?.id ?? '',
      tagHow: p?.tag?.how.kind === 'even' ? 'even' : 'half',
      ways: p?.tag?.how.kind === 'even' ? String(p.tag.how.ways) : '2',
    });
    setError('');
    setAsking(null);
    // Afresh each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id]);

  if (!open || !card) return <Sheet open={false} title="Someone" onClose={onClose}>{null}</Sheet>;

  const set = (change: Partial<Draft>) => setDraft((d) => ({ ...d, ...change }));
  const ways = Number(draft.ways);
  const fields = () => ({
    name: draft.name.trim(),
    venmo: draft.venmo.trim().replace(/^@/, ''),
    cashtag: draft.cashtag.trim().replace(/^\$/, ''),
    app: draft.app || null,
    tag: draft.tag ? { id: draft.tag, how: draft.tagHow === 'half' ? { kind: 'half' } : { kind: 'even', ways } } : null,
  });
  const ready = draft.name.trim().length > 0 && (draft.tagHow === 'half' || !draft.tag || (Number.isInteger(ways) && ways >= 2 && ways <= 100));

  async function run(path: string, method: 'POST' | 'PATCH', body: unknown, moves = false) {
    setSaving(true);
    setError('');
    const sent = await shared.send(path, method, body, { moves });
    setSaving(false);
    if (sent.error) {
      setError(sent.error);
      return false;
    }
    return true;
  }
  const save = async () => {
    if (await run(SHARED_ROUTES.people, id ? 'PATCH' : 'POST', id ? { id, action: 'edit', ...fields() } : fields())) onClose();
  };

  const balances = (card.balances && id ? card.balances[id] : undefined) ?? [];
  const settled = card.balances !== null && balances.every((b) => b.amount === 0 && b.open === 0);
  const items = id ? card.items.filter((i) => i.person === id) : [];
  const name = p?.name ?? REMOVED_NAME;

  // The buttons, and why the last one failed beside them; asked to forget them or
  // remove what was shared, Keep them and the action in their place.
  const failed = error ? errorId : undefined;
  const asked = (label: string, go: () => Promise<boolean>) => (
    <>
      <button
        type="button"
        className="btn secondary"
        onClick={() => {
          // What the action said when it failed goes with its question.
          setAsking(null);
          setError('');
        }}
        disabled={saving}
      >
        Keep them
      </button>
      <button type="button" className="btn danger" onClick={() => void go().then((ok) => ok && onClose())} disabled={saving} aria-describedby={failed ? `${askId} ${failed}` : askId}>
        {label}
      </button>
    </>
  );
  // A forgotten person's sheet has nothing to save: no footer, unless to ask or say.
  const footer = !error && !asking && p?.removed ? null : (
    <>
      {error && (
        <div className="sheet-footer-note" id={errorId}>
          <Notice level="critical" role="alert">
            <Masked>{hideAmountsIn(error)}</Masked>
          </Notice>
        </div>
      )}
      {asking === 'forget'
        ? asked('Forget them', () => run(SHARED_ROUTES.people, 'PATCH', { id, action: 'forget' }))
        : asking === 'remove'
          ? asked('Remove them', () => run(SHARED_ROUTES.people, 'PATCH', { id, action: 'remove-expenses' }, true))
          : !p?.removed && (
              <>
                <button type="button" className="btn secondary" onClick={onClose} disabled={saving}>
                  Cancel
                </button>
                <button type="button" className="btn" onClick={() => void save()} disabled={!ready || saving} aria-describedby={failed}>
                  {saving ? 'Saving…' : id ? 'Save' : 'Add'}
                </button>
              </>
            )}
    </>
  );

  return (
    <Sheet open title={id ? name : 'Add someone'} onClose={() => !saving && onClose()} footer={footer}>
      {!p?.removed && (
        <div className="sheet-form">
          <label className="field">
            Name
            <input className="text-input" value={draft.name} maxLength={PERSON_NAME_MAX} onChange={(e) => set({ name: e.target.value })} disabled={saving} autoComplete="off" />
          </label>
          <label className="field">
            Venmo username (optional)
            <input className="text-input" value={draft.venmo} maxLength={HANDLE_MAX + 1} onChange={(e) => set({ venmo: e.target.value })} disabled={saving} autoComplete="off" />
          </label>
          <label className="field">
            Cash App cashtag (optional)
            <input className="text-input" value={draft.cashtag} maxLength={HANDLE_MAX + 1} onChange={(e) => set({ cashtag: e.target.value })} disabled={saving} autoComplete="off" />
          </label>
          <label className="field">
            How you pay each other
            <select className="text-input" value={draft.app} onChange={(e) => set({ app: e.target.value as Draft['app'] })} disabled={saving}>
              <option value="">Not said</option>
              <option value="venmo">Venmo</option>
              <option value="cashapp">Cash App</option>
              <option value="other">Another way</option>
            </select>
          </label>
          {tags.length > 0 && (
            <>
              <label className="field">
                A tag for what you share with them (optional)
                <select className="text-input" value={draft.tag} onChange={(e) => set({ tag: e.target.value })} disabled={saving}>
                  <option value="">None</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              {draft.tag && (
                <fieldset className="lifecycle-choices" disabled={saving}>
                  <legend className="section-label">Shared how, by default</legend>
                  <label className="lifecycle-choice">
                    <input type="radio" name="person-tag-how" checked={draft.tagHow === 'half'} onChange={() => set({ tagHow: 'half' })} />
                    <span className="lifecycle-choice-name">Half each</span>
                  </label>
                  <label className="lifecycle-choice">
                    <input type="radio" name="person-tag-how" checked={draft.tagHow === 'even'} onChange={() => set({ tagHow: 'even' })} />
                    <span className="lifecycle-choice-name">Evenly, this many ways with you</span>
                  </label>
                  {draft.tagHow === 'even' && (
                    <input className="text-input" inputMode="numeric" value={draft.ways} onChange={(e) => set({ ways: e.target.value })} aria-label="How many ways, with you" />
                  )}
                </fieldset>
              )}
            </>
          )}
          <p className="panel-note">Only you see this. Nya keeps no one’s phone number, email or bank details, and never contacts them.</p>
        </div>
      )}

      {id && items.length > 0 && (
        <>
          <div className="section-label" style={{ marginTop: 16 }}>
            Between you
          </div>
          <ul className="shared-items">
            {items.map((i) => (
              <li key={i.id}>
                <span>
                  {i.what} <span className="type-tag">{shownDay(i.date)}</span>
                </span>
                <span className="type-tag">
                  <Masked>
                    {`${i.direction === 'to_you' ? `${name} owes you` : `You owe ${name}`} ${formatMoney(i.amount, i.currency)}${i.open > 0 ? `, ${formatMoney(i.open, i.currency)} open` : i.over ? ', closed past it' : ', closed'}`}
                  </Masked>
                </span>
                {i.closed.map((c) => (
                  <span key={c.event} className="type-tag">
                    <Masked>{`${c.kind === 'outside' ? 'Settled outside your accounts' : 'Let go'} ${shownDay(c.date, true)}: ${formatMoney(c.amount, i.currency)}`}</Masked>
                    {c.note ? ` (${c.note})` : ''}{' '}
                    <ReopenButton disabled={saving} onReopen={() => void reopen(i.id, c.event)} />
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}

      {id && p && (
        <div className="card-actions" style={{ marginTop: 16 }}>
          {!p.archived && settled && (
            <button className="secondary" onClick={() => void run(SHARED_ROUTES.people, 'PATCH', { id, action: 'archive' }).then((ok) => ok && onClose())} disabled={saving}>
              Archive
            </button>
          )}
          {p.archived && (
            <button className="secondary" onClick={() => void run(SHARED_ROUTES.people, 'PATCH', { id, action: 'unarchive' })} disabled={saving}>
              Bring back
            </button>
          )}
          {!p.removed && (
            <button className="secondary" onClick={() => setAsking('forget')} disabled={saving}>
              Forget {name}
            </button>
          )}
          {(p.archived || p.removed) && items.length > 0 && (
            <button className="secondary" onClick={() => setAsking('remove')} disabled={saving}>
              Remove what you shared
            </button>
          )}
        </div>
      )}
      {asking === 'forget' && (
        <>
          <p className="panel-note" id={askId}>
            Forget {name}? Their name, usernames, tag and requests go from Nya; every amount stays, as “{REMOVED_NAME}”, so no total and no balance changes.
          </p>
        </>
      )}
      {asking === 'remove' && (
        <>
          <p className="panel-note" id={askId}>
            Remove everything you shared with {name}? Their parts of shared transactions become yours, on the days you bought them, so past totals go up; their IOUs go.
          </p>
        </>
      )}
    </Sheet>
  );

  async function reopen(item: string, event: string) {
    setSaving(true);
    setError('');
    const sent = await shared.send(SHARED_ROUTES.close, 'DELETE', { item, event });
    setSaving(false);
    if (sent.error) setError(sent.error);
  }
}

/** Takes back what settled or let go an item, after asking. */
function ReopenButton({ disabled, onReopen }: { disabled: boolean; onReopen: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking)
    return (
      <button className="link-btn" onClick={() => setAsking(true)} disabled={disabled}>
        Take back
      </button>
    );
  return (
    <>
      <button className="link-btn" onClick={onReopen} disabled={disabled}>
        Yes, open it again
      </button>{' '}
      <button className="link-btn" onClick={() => setAsking(false)} disabled={disabled}>
        No
      </button>
    </>
  );
}
