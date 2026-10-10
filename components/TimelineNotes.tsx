'use client';

// Notes on the net-worth timeline (#50, lib/timeline-notes.ts): what the
// chart marks on its days (components/NetWorthChart.tsx), and the card under
// it where the person adds, edits and removes their own (a house bought, a
// 401(k) rolled over). The notes Nya writes when an account ends are listed
// too, and follow the account: changing or reopening it changes them.
//
// Read on its own request (app/api/timeline-notes), never part of the cached
// net-worth payload, so a note saved shows at once and a failure to read the
// notes costs the chart nothing but its markers, said in the card.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { localDate } from '@/lib/local-date';

export type TimelineNote = { id: string; date: string; text: string; kind: 'auto' | 'user'; account_id?: string };

/** "Mar 12, 2025": a calendar day, read at local midnight. */
const dayText = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** The notes, read again whenever `refreshKey` changes (a reload). */
export function useTimelineNotes(refreshKey: unknown) {
  const [notes, setNotes] = useState<TimelineNote[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let live = true;
    fetch('/api/timeline-notes')
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!live) return;
        if (!res.ok || !Array.isArray(data?.notes)) {
          // What the chart showed before is no longer known to be right.
          setNotes([]);
          setProblem('Your notes couldn’t be read just now, so the chart shows none.');
          return;
        }
        setNotes(data.notes);
        const flawed = (data.unreadable_ids?.length ?? 0) + (data.unrecognised_ids?.length ?? 0);
        setProblem(flawed > 0 ? `${flawed === 1 ? 'One note' : `${flawed} notes`} couldn’t be read, so ${flawed === 1 ? 'it isn’t' : 'they aren’t'} shown.` : null);
      })
      .catch(() => {
        if (!live) return;
        setNotes([]);
        setProblem('Your notes couldn’t be read just now, so the chart shows none.');
      });
    return () => {
      live = false;
    };
  }, [refreshKey, tick]);
  return { notes, problem, reload };
}

type Draft = { id: string | null; date: string; text: string };

/** The notes card: every note, newest first; the person's own can be edited
 *  and removed, Nya's say where they come from. Collapsed until opened. */
export function TimelineNotesCard({ notes, problem, onChanged }: { notes: TimelineNote[]; problem: string | null; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const shown = useRef<Draft | null>(null);
  if (draft) shown.current = draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = localDate();
  /** Opens the sheet on a note, or a new one, with no error left from before. */
  const openDraft = (next: Draft) => {
    setError('');
    setDraft(next);
  };

  const send = async (method: 'POST' | 'PATCH' | 'DELETE', body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/timeline-notes', { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'That note couldn’t be saved.');
        return false;
      }
      onChanged();
      return true;
    } catch {
      setError('That note couldn’t be saved: the server couldn’t be reached.');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const d = shown.current;
    if (!d) return;
    const ok = d.id ? await send('PATCH', { id: d.id, date: d.date, text: d.text }) : await send('POST', { date: d.date, text: d.text });
    if (ok) setDraft(null);
  };
  const remove = async (id: string) => {
    if (await send('DELETE', { id })) setDraft(null);
  };

  const newest = [...notes].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const d = shown.current;
  const valid = !!d && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.date >= '1970-01-01' && d.date <= today && d.text.trim().length > 0 && d.text.trim().length <= 200;
  return (
    <div className="card timeline-notes-card">
      <button className="holdings-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="holdings-title">
          Notes on the timeline
          {notes.length > 0 && <span className="holdings-count">{notes.length}</span>}
        </span>
        <span className="holdings-summary">
          <svg className={`chevron${open ? ' open' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {problem && <p className="stale-note">{problem}</p>}
      {open && (
        <>
          <p className="empty-note">
            A note marks its day on the chart, so a step in the line says what it was: a house bought, a 401(k) rolled
            over. Nya adds one when an account closes or stops counting.
          </p>
          {newest.length > 0 && (
            <ul className="timeline-note-list">
              {newest.map((n) => (
                <li key={n.id} className="timeline-note-row">
                  <div>
                    <span className="timeline-note-day">{dayText(n.date)}</span> {n.text}
                    {n.kind === 'auto' && <div className="type-tag">Added when the account changed</div>}
                  </div>
                  {n.kind === 'user' && (
                    <div className="manual-row-actions">
                      <button className="link-btn" disabled={busy} onClick={() => openDraft({ id: n.id, date: n.date, text: n.text })}>
                        Edit
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="card-actions">
            <button className="secondary" onClick={() => openDraft({ id: null, date: today, text: '' })} disabled={busy}>
              Add a note
            </button>
          </div>
        </>
      )}
      <Sheet open={!!draft} title={d?.id ? 'Edit note' : 'Add a note'} onClose={() => !busy && setDraft(null)}>
        {d && (
          <>
            <div className="sheet-form">
              <label className="field">
                Day
                <input type="date" value={d.date} min="1970-01-01" max={today} onChange={(e) => setDraft({ ...d, date: e.target.value })} disabled={busy} />
              </label>
              <label className="field">
                Note
                <input value={d.text} onChange={(e) => setDraft({ ...d, text: e.target.value })} maxLength={200} placeholder="e.g. Bought the house" disabled={busy} />
              </label>
            </div>
            {error && <div className="error">{error}</div>}
            <div className="button-pair" style={{ marginTop: 16 }}>
              <button className="secondary" onClick={() => setDraft(null)} disabled={busy}>
                Cancel
              </button>
              <button onClick={save} disabled={busy || !valid}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
            {d.id && (
              <div className="lifecycle-reopen">
                <button className="danger" onClick={() => remove(d.id!)} disabled={busy}>
                  Remove this note
                </button>
              </div>
            )}
          </>
        )}
      </Sheet>
    </div>
  );
}
