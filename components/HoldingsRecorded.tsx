'use client';

// One line under an investment account's balance chart (Accounts tab, when
// its row is expanded), saying since when its holdings have been recorded
// (lib/holdings-history.ts). Plaid keeps no past holdings, so their history
// starts on the day Nya starts saving them and can't be rebuilt later: this
// tells the person it is being kept. It reads the index alone (summary=1): no
// month of positions, no Plaid call.
//
// It says nothing while loading or if the read fails. The line is a note, not
// a figure, and a wrong "since" would be worse than none.

import { useEffect, useState } from 'react';

/** What /api/holdings-history?summary=1 answers: UTC days, or null when
 *  nothing was recorded for the account. */
export type RecordedSpan = { first_recorded: string | null; last_recorded: string | null };

const DAY_MS = 24 * 60 * 60 * 1000;

/** A stored UTC day, shown as the date it names: parsed at local midnight, so
 *  it never renders as the day before west of Greenwich. */
function fmtDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * The line itself, pure. `today` is a UTC day, as the recorded ones are. A
 * record from yesterday is current: the nightly snapshot runs in the
 * afternoon, UTC. Older than that, recording has stopped (the institution's
 * holdings call has failed since, or it was disconnected), and the line says
 * when it stopped rather than claim it is still kept.
 */
export function HoldingsRecordedLine({ span, today }: { span: RecordedSpan; today: string }) {
  const { first_recorded: first, last_recorded: last } = span;
  if (!first || !last) return <p className="as-of">No holdings recorded for this account yet.</p>;
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  if (last < yesterday) {
    return (
      <p className="as-of">
        Holdings recorded daily from {fmtDay(first)} to {fmtDay(last)}.
      </p>
    );
  }
  return <p className="as-of">Holdings recorded daily since {fmtDay(first)}.</p>;
}

const isDayOrNull = (v: unknown) => v === null || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));

export default function HoldingsRecorded({ accountId }: { accountId: string }) {
  const [span, setSpan] = useState<RecordedSpan | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/holdings-history?summary=1&account_id=${encodeURIComponent(accountId)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`holdings-history ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled || !isDayOrNull(data?.first_recorded) || !isDayOrNull(data?.last_recorded)) return;
        setSpan({ first_recorded: data.first_recorded, last_recorded: data.last_recorded });
      })
      .catch(() => {
        // Nothing to say: see the header.
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  if (!span) return null;
  return <HoldingsRecordedLine span={span} today={new Date().toISOString().slice(0, 10)} />;
}
