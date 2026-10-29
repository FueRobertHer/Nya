'use client';

// The review queue's settings, in Settings, Transactions (lib/review-store.ts): turning it
// on, from today or a little before (never years of history), or off, which
// keeps every approval; when its records can't be read, removing only the
// damaged ones, once the person confirms (settings a later release wrote are
// kept as they are, and said so); and, as approvals near the most Nya keeps
// (MAX_APPROVALS), forgetting the oldest to make room, once confirmed. While
// the queue is on, the switch for the Activity tab's keys too
// (components/activity-keys.ts): here it is always within reach, a keyboard
// or none, as the keys' own help isn't once they are off.

import { useEffect, useRef, useState } from 'react';
import type { ReviewControls } from './review-state';
import { setActivityKeys, useActivityKeys } from './activity-keys';
import { localDate } from '@/lib/local-date';
import { plainNumber } from '@/lib/format';

/** The first days the queue can start from, as offered: today, a week back,
 *  a month back (lib/review-layer.ts MAX_SINCE_DAYS). */
export function startChoices(today: string): { value: string; label: string }[] {
  const back = (n: number) => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() - n);
    return localDate(d);
  };
  return [
    { value: today, label: 'New transactions from today' },
    { value: back(7), label: 'And those of the last 7 days' },
    { value: back(30), label: 'And those of the last 30 days' },
  ];
}

/** How many approvals are kept, of how many at most, and how many making
 *  room forgets (GET /api/review). */
export type ApprovalRoom = { kept: number; max: number; room: number };

/** Whether to offer making room: once what is kept comes within one room of
 *  the most kept, so it is there before approving is refused. */
export function nearFull(a: ApprovalRoom | null): boolean {
  return !!a && a.kept >= a.max - a.room;
}

function day(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const count = (n: number) => plainNumber(n);

export default function ReviewSettingsCard({ review, toReview }: { review: ReviewControls; toReview: number }) {
  const today = localDate();
  const choices = startChoices(today);
  const [since, setSince] = useState(today);
  const [confirming, setConfirming] = useState<'repair' | 'room' | null>(null);
  const [repaired, setRepaired] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  // What only this card asks the server: how many approvals are kept, and
  // whether settings that can't be read are damaged (removable) or a later
  // release's (kept); and a load that failed, said rather than left disabled.
  const [room, setRoom] = useState<ApprovalRoom | null>(null);
  const [settingsRepairable, setSettingsRepairable] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reads, setReads] = useState(0);
  const view = review.view;
  const keysOn = useActivityKeys();
  const viewRef = useRef(view);
  viewRef.current = view;

  // The queue's state comes with the transactions; taken from here when this
  // card opens before they have loaded.
  const { accept } = review;
  useEffect(() => {
    let gone = false;
    fetch('/api/review')
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (gone) return;
        if (res.ok && data?.review) {
          setLoadError(null);
          setRoom(data.approvals ?? null);
          if (!viewRef.current) accept({ ...data.review, unread: false, unknown: 0 });
        } else if (res.status === 409) {
          setLoadError(null);
          setSettingsRepairable(data?.repairable === true);
          if (!viewRef.current) accept({ on: false, since: null, unread: true, unknown: 0 });
        } else if (!viewRef.current) setLoadError(data?.error ?? 'Could not load the review queue. Please try again.');
      })
      .catch(() => {
        if (!gone && !viewRef.current) setLoadError('Could not reach the server.');
      });
    return () => {
      gone = true;
    };
  }, [accept, reads]);

  const post = async (body: unknown) => {
    const res = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { res, data: await res.json().catch(() => null) };
  };

  const repair = async () => {
    setRepairing(true);
    try {
      const { res, data } = await post({ action: 'repair', confirm: true });
      if (!res.ok) {
        setRepaired(data?.error ?? 'Could not delete them. Please try again.');
        return;
      }
      setRepaired(
        data.unrecognised > 0
          ? `Deleted what was damaged. ${data.unrecognised === 1 ? 'One record was' : `${data.unrecognised} records were`} saved by a newer version of Nya and kept as they are.`
          : 'Deleted what was damaged.'
      );
      setConfirming(null);
      // Read again: what the settings were, if they weren't the damaged part.
      accept(null);
      setReads((n) => n + 1);
    } catch {
      setRepaired('Could not reach the server.');
    } finally {
      setRepairing(false);
    }
  };

  const makeRoom = async () => {
    setRepairing(true);
    try {
      const { res, data } = await post({ action: 'make-room', confirm: true });
      if (!res.ok) {
        setRepaired(data?.error ?? 'Could not forget them. Please try again.');
        return;
      }
      setRepaired(
        data.removed === 0
          ? 'There were none to forget.'
          : `Forgot ${count(data.removed)} approvals${data.through ? `, made up to ${day(String(data.through).slice(0, 10))}` : ''}. Their transactions stay, filed as ones you never approved are.`
      );
      setConfirming(null);
      setReads((n) => n + 1);
      review.refresh();
    } catch {
      setRepaired('Could not reach the server.');
    } finally {
      setRepairing(false);
    }
  };

  const confirmPair = (onYes: () => void, yes: string, no: string) => (
    <div className="button-pair">
      <button disabled={repairing} onClick={onYes}>
        {yes}
      </button>
      <button className="secondary" onClick={() => setConfirming(null)}>
        {no}
      </button>
    </div>
  );

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Review queue</div>
        {view?.on && <div className="inst-total">on</div>}
      </div>
      {view?.unread ? (
        settingsRepairable ? (
          <>
            <p className="stale-note">Your review queue’s settings couldn’t be read, so nothing is marked to review until they can be.</p>
            {confirming === 'repair' ? (
              confirmPair(() => void repair(), 'Delete what’s damaged', 'Keep it')
            ) : (
              <button className="secondary" onClick={() => setConfirming('repair')}>
                Delete the damaged settings…
              </button>
            )}
          </>
        ) : (
          <p className="stale-note">
            Your review queue’s settings couldn’t be read (a newer version of Nya may have saved them), so nothing is marked to review until they can be. They are kept as they are.
          </p>
        )
      ) : view?.on ? (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            Transactions from {view.since ? day(view.since) : 'the day you turned it on'} on wait for you to approve them on the Activity tab: {toReview === 0 ? 'nothing is waiting now' : `${toReview} waiting now`}. An
            approved transaction keeps the category you approved it under until you change it: what a rule, a default or the bank would file it under is offered instead. A new amount from the bank
            puts it back here, still under that category.
          </p>
          <button className="secondary" disabled={review.saving} onClick={() => void review.turn(false)}>
            Turn off
          </button>
          <p className="rename-hint">Turning it off keeps your approvals.</p>
          <label className="review-keys-switch">
            <input type="checkbox" checked={keysOn} onChange={(e) => setActivityKeys(e.target.checked)} />
            Keyboard shortcuts on the Activity tab (R, N, Shift+A, U), on this device
          </label>
        </>
      ) : (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            Approve new transactions as they arrive, one at a time or all at once. An approved transaction keeps the category you approved it under until you change it; one approved without a
            category takes the one a rule or a default gives it later.
          </p>
          <fieldset className="review-start">
            <legend className="visually-hidden">Start from</legend>
            {choices.map((c) => (
              <label key={c.value} className="review-start-choice">
                <input type="radio" name="review-since" value={c.value} checked={since === c.value} onChange={() => setSince(c.value)} />
                {c.label}
              </label>
            ))}
          </fieldset>
          {loadError && (
            <>
              <p className="stale-note">{loadError}</p>
              <button className="secondary" onClick={() => setReads((n) => n + 1)}>
                Try again
              </button>
            </>
          )}
          <button disabled={review.saving || !view} onClick={() => void review.turn(true, since)}>
            Turn on
          </button>
        </>
      )}
      {!view?.unread && (view?.unknown ?? 0) > 0 && (
        <>
          <p className="stale-note">
            Your approval of {view!.unknown === 1 ? '1 transaction' : `${view!.unknown} transactions`} couldn’t be read, so whether {view!.unknown === 1 ? 'it needs' : 'they need'} review isn’t known.
            Damaged ones can be deleted, which puts those transactions back in the queue; any saved by a newer version of Nya are kept.
          </p>
          {confirming === 'repair' ? (
            confirmPair(() => void repair(), 'Delete what’s damaged', 'Keep them')
          ) : (
            <button className="secondary" onClick={() => setConfirming('repair')}>
              Delete the damaged approvals…
            </button>
          )}
        </>
      )}
      {nearFull(room) && (
        <>
          <p className="stale-note">
            You have {count(room!.kept)} approvals. Nya keeps up to {count(room!.max)}, and past that approving is refused until you make room by forgetting the oldest.
          </p>
          {confirming === 'room' ? (
            <>
              <p className="panel-note">
                Forget your {count(room!.room)} oldest approvals? Their transactions stay, filed as ones you never approved are, by your rules, your defaults and the bank, so some may show another
                category, and those from the queue’s first day on wait for review again.
              </p>
              {confirmPair(() => void makeRoom(), 'Forget them', 'Keep them')}
            </>
          ) : (
            <button className="secondary" onClick={() => setConfirming('room')}>
              Forget the {count(room!.room)} oldest…
            </button>
          )}
        </>
      )}
      {repaired && <p className="panel-note">{repaired}</p>}
      {review.error && <div className="error">{review.error}</div>}
    </div>
  );
}
