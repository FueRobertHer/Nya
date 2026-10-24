'use client';

// Notes on the net-worth timeline (#50, lib/timeline-notes.ts): what the
// chart marks on its days (components/NetWorthChart.tsx), and the sheet the
// Net worth card's "Chart notes" opens (rollout phase 4a), where the person
// adds, edits and deletes their own (a house bought, a 401(k) rolled over).
// The notes Nya writes when an account ends are listed too, and follow the
// account: changing or reopening it changes them.
//
// Read on its own request (app/api/timeline-notes), never part of the cached
// net-worth payload, so a note saved shows at once and a failure to read the
// notes costs the chart nothing but its markers, said on the card and here.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { Why } from './Why';
import { ALERT } from './ConnectionStatus';
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

/** Where the sheet is: the list, a note's form, or the question before
 *  deleting one. The form and the question are a second level with a back
 *  button, not a sheet on a sheet. */
type Level = { at: 'list' } | { at: 'form'; draft: Draft } | { at: 'delete'; draft: Draft };

/** The notes sheet: every note, newest first; the person's own can be
 *  edited and deleted, Nya's say where they come from. */
export function TimelineNotesSheet({
  open,
  onClose,
  notes,
  problem,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  notes: TimelineNote[];
  problem: string | null;
  onChanged: () => void;
}) {
  const [level, setLevel] = useState<Level>({ at: 'list' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = localDate();
  const confirm = useRef<HTMLButtonElement>(null);
  /** A level, with no error left from before. */
  const go = (next: Level) => {
    setError('');
    setLevel(next);
  };
  // Opened again: the list, not the form left behind.
  useEffect(() => {
    if (open) go({ at: 'list' });
  }, [open]);
  // The question replaces the form's buttons: focus goes to its answer.
  useEffect(() => {
    if (level.at === 'delete') confirm.current?.focus({ preventScroll: true });
  }, [level.at]);

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

  const save = async (d: Draft) => {
    const ok = d.id ? await send('PATCH', { id: d.id, date: d.date, text: d.text }) : await send('POST', { date: d.date, text: d.text });
    if (ok) go({ at: 'list' });
  };
  const remove = async (id: string) => {
    if (await send('DELETE', { id })) go({ at: 'list' });
  };

  const newest = [...notes].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const close = () => !busy && onClose();
  const back = () => !busy && go(level.at === 'delete' ? { at: 'form', draft: level.draft } : { at: 'list' });

  if (level.at === 'list') {
    return (
      <Sheet
        open={open}
        title="Chart notes"
        onClose={close}
        footer={
          <button className="btn btn-block" onClick={() => go({ at: 'form', draft: { id: null, date: today, text: '' } })} disabled={busy}>
            Add a note
          </button>
        }
      >
        <div className="stack">
          {problem && (
            <div className="notice caution">
              {ALERT}
              <p>{problem}</p>
            </div>
          )}
          <Why label="What are these?">
            A note marks its day on the chart, so a step in the line says what it was: a house bought, a 401(k) rolled over. Nya
            adds one when an account closes or stops counting.
          </Why>
          {newest.length === 0 ? (
            <p className="empty-note">No notes yet.</p>
          ) : (
            <ul className="card list-rows">
              {newest.map((n) => (
                <li key={n.id} className="list-row">
                  <span className="list-row-text">
                    <span className="list-row-title">{n.text}</span>
                    <span className="list-row-sub">
                      {dayText(n.date)}
                      {n.kind === 'auto' && <> <span className="badge">Added when the account changed</span></>}
                    </span>
                  </span>
                  {n.kind === 'user' && (
                    <button className="btn ghost" disabled={busy} onClick={() => go({ at: 'form', draft: { id: n.id, date: n.date, text: n.text } })}>
                      Edit
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Sheet>
    );
  }

  const d = level.draft;
  if (level.at === 'delete') {
    return (
      <Sheet
        open={open}
        title="Delete note"
        onClose={close}
        onBack={back}
        footer={
          <div className="btn-row">
            <button className="btn secondary" onClick={back} disabled={busy}>
              Keep it
            </button>
            <button ref={confirm} className="btn danger" onClick={() => remove(d.id!)} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        }
      >
        <div className="stack">
          <p>{`Delete "${d.text}" from ${dayText(d.date)}? This can’t be undone.`}</p>
          {error && <div className="error">{error}</div>}
        </div>
      </Sheet>
    );
  }

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.date >= '1970-01-01' && d.date <= today && d.text.trim().length > 0 && d.text.trim().length <= 200;
  const edit = (next: Partial<Draft>) => setLevel({ at: 'form', draft: { ...d, ...next } });
  return (
    <Sheet
      open={open}
      title={d.id ? 'Edit note' : 'Add a note'}
      onClose={close}
      onBack={back}
      footer={
        <div className="btn-row">
          {d.id && (
            <button className="btn secondary" onClick={() => go({ at: 'delete', draft: d })} disabled={busy}>
              Delete…
            </button>
          )}
          <button className="btn" onClick={() => save(d)} disabled={busy || !valid}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <div className="stack">
        <div className="sheet-form">
          <label className="field">
            Day
            <input type="date" value={d.date} min="1970-01-01" max={today} onChange={(e) => edit({ date: e.target.value })} disabled={busy} />
          </label>
          <label className="field">
            Note
            <input value={d.text} onChange={(e) => edit({ text: e.target.value })} maxLength={200} placeholder="e.g. Bought the house" disabled={busy} />
          </label>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </Sheet>
  );
}
