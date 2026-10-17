'use client';

// The review queue's settings, under Manage (lib/review-store.ts): turning it
// on, from today or a little before (never years of history), or off, which
// keeps every approval; and, when its records can't be read, removing only
// the damaged ones, once the person confirms.

import { useEffect, useState } from 'react';
import type { ReviewControls } from './review-state';
import { localDate } from '@/lib/local-date';

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

function day(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function ReviewSettingsCard({ review, toReview }: { review: ReviewControls; toReview: number }) {
  const today = localDate();
  const choices = startChoices(today);
  const [since, setSince] = useState(today);
  const [confirming, setConfirming] = useState(false);
  const [repaired, setRepaired] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);
  const view = review.view;

  // The queue's state comes with the transactions; asked for here when this
  // card opens before they have loaded.
  const { accept } = review;
  useEffect(() => {
    if (view) return;
    let gone = false;
    fetch('/api/review')
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (gone) return;
        if (res.ok && data?.review) accept({ ...data.review, unread: false, unknown: 0 });
        else if (res.status === 409) accept({ on: false, since: null, unread: true, unknown: 0 });
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [view, accept]);

  const repair = async () => {
    setRepairing(true);
    try {
      const res = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'repair', confirm: true }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setRepaired(data?.error ?? 'Could not remove them. Please try again.');
        return;
      }
      setRepaired(
        data.unrecognised > 0
          ? `Removed what was damaged. ${data.unrecognised === 1 ? 'One record was' : `${data.unrecognised} records were`} saved by a newer version of Nya and kept as they are.`
          : 'Removed what was damaged.'
      );
      setConfirming(false);
      // Read again: what the settings were, if they weren't the damaged part.
      accept(null);
    } finally {
      setRepairing(false);
    }
  };

  return (
    <div className="card">
      <div className="inst-header">
        <div className="inst-name">Review queue</div>
        {view?.on && <div className="inst-total">on</div>}
      </div>
      {view?.unread ? (
        <>
          <p className="stale-note">Your review queue’s settings couldn’t be read, so nothing is marked to review until they can be.</p>
          {confirming ? (
            <div className="button-pair">
              <button disabled={repairing} onClick={() => void repair()}>
                Remove what’s damaged
              </button>
              <button className="secondary" onClick={() => setConfirming(false)}>
                Keep it
              </button>
            </div>
          ) : (
            <button className="secondary" onClick={() => setConfirming(true)}>
              Remove the damaged settings…
            </button>
          )}
        </>
      ) : view?.on ? (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            Transactions from {view.since ? day(view.since) : 'the day you turned it on'} on wait for you to approve them on the Activity tab: {toReview === 0 ? 'nothing is waiting now' : `${toReview} waiting now`}. Once
            approved, nothing but you changes one: a rule or a default added later is offered, never applied to it.
          </p>
          <button className="secondary" disabled={review.saving} onClick={() => void review.turn(false)}>
            Turn off
          </button>
          <p className="rename-hint">Turning it off keeps your approvals.</p>
        </>
      ) : (
        <>
          <p className="panel-note" style={{ marginTop: 0 }}>
            Approve new transactions as they arrive, one at a time or all at once. An approved transaction stays as you approved it: its category never changes unless you change it.
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
          <button disabled={review.saving || !view} onClick={() => void review.turn(true, since)}>
            Turn on
          </button>
        </>
      )}
      {!view?.unread && (view?.unknown ?? 0) > 0 && (
        <>
          <p className="stale-note">
            Your approval of {view!.unknown === 1 ? '1 transaction' : `${view!.unknown} transactions`} couldn’t be read, so whether {view!.unknown === 1 ? 'it needs' : 'they need'} review isn’t known.
            Damaged ones can be removed, which puts those transactions back in the queue; any saved by a newer version of Nya are kept.
          </p>
          {confirming ? (
            <div className="button-pair">
              <button disabled={repairing} onClick={() => void repair()}>
                Remove what’s damaged
              </button>
              <button className="secondary" onClick={() => setConfirming(false)}>
                Keep them
              </button>
            </div>
          ) : (
            <button className="secondary" onClick={() => setConfirming(true)}>
              Remove the damaged approvals…
            </button>
          )}
        </>
      )}
      {repaired && <p className="panel-note">{repaired}</p>}
      {review.error && <div className="error">{review.error}</div>}
    </div>
  );
}
