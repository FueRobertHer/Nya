'use client';

// One line under an investment account's balance chart (Accounts tab, when
// its row is expanded), saying since when its holdings have been recorded
// (lib/holdings-history.ts). Plaid keeps no past holdings, so their history
// starts on the day Nya starts saving them and can't be rebuilt later: this
// tells the person it is being kept. It reads the index alone (summary=1): no
// month of positions, no Plaid call.
//
// It claims no more than is known. Its dates are the viewer's own days (the
// moments of the first and last recordings, in the viewer's time zone), or a
// UTC day labelled as one where no moment is known. "Since" only while
// recording is current, never "daily" (a day can be missed), and never "yet"
// (an institution that doesn't offer holdings will never have any).
//
// While loading, or if the read fails for a passing reason, it says nothing:
// the line is a note, not a figure. If what is stored can't be read (409),
// recording has stopped too, and it says so, since a day not recorded is lost
// for good. When only the index is damaged it offers to rebuild it from the
// months, and does so only once the person confirms. An index gone missing
// beside the months (deleted by hand, or a rollback) stops no recording, which
// derives it again, but until then the months can't be read: it says so, never
// that nothing was recorded, and offers the same rebuild.

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Sheet } from './Sheet';

/** What /api/holdings-history?summary=1 answers: UTC days, or null when
 *  nothing was recorded for the account, and the moments behind them, when
 *  known. */
export type RecordedSpan = {
  first_recorded: string | null;
  last_recorded: string | null;
  first_recorded_at?: string | null;
  last_recorded_at?: string | null;
};

/** What the line has to say. */
export type SummaryState =
  | { kind: 'loading' }
  /** A passing failure: nothing to say. */
  | { kind: 'quiet' }
  | { kind: 'recorded'; span: RecordedSpan }
  /** What is stored can't be read. Recording has stopped too, unless
   *  `indexMissing`: the index is missing beside the months, which recording
   *  derives again. `repairable`: only the index, damaged or missing, which
   *  the months can rebuild. */
  | { kind: 'unreadable'; repairable: boolean; indexMissing?: boolean };

/** Where a repair is: not asked for, asked and waiting for the person's
 *  word, under way, or refused with the server's reason. */
export type RepairPhase = { kind: 'closed' } | { kind: 'confirming' } | { kind: 'repairing' } | { kind: 'failed'; error: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LONG: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };

/**
 * A recorded day as the viewer has it: the local day of the moment it was
 * recorded at, when that moment is known and is of the stored UTC day (a
 * restored copy keeps another environment's moments); otherwise the UTC day
 * itself, labelled as one, since from a US evening on it is already the next
 * day's date. `timeZone` is for tests; the app leaves it out and gets the
 * viewer's own.
 */
export function recordedDay(day: string, at?: string | null, timeZone?: string): string {
  if (at && at.slice(0, 10) === day) {
    const d = new Date(at);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString(undefined, { ...LONG, ...(timeZone ? { timeZone } : {}) });
  }
  return `${new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { ...LONG, timeZone: 'UTC' })} (UTC)`;
}

/**
 * The line itself, pure. `today` is a UTC day, as the recorded ones are. A
 * record from yesterday is current: the nightly snapshot runs in the
 * afternoon, UTC. Older than that, recording has stopped (the institution's
 * holdings call has failed since, or it was disconnected), and the line says
 * when it stopped rather than claim it is still kept.
 */
export function HoldingsRecordedLine({ span, today, timeZone }: { span: RecordedSpan; today: string; timeZone?: string }) {
  const { first_recorded: first, last_recorded: last } = span;
  if (!first || !last) return <div className="as-of">No holdings have been recorded for this account.</div>;
  const from = recordedDay(first, span.first_recorded_at, timeZone);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  if (last < yesterday) {
    return (
      <div className="as-of">
        Holdings recorded from {from} to {recordedDay(last, span.last_recorded_at, timeZone)}.
      </div>
    );
  }
  return <div className="as-of">Holdings recorded since {from}.</div>;
}

const isDayOrNull = (v: unknown) => v === null || (typeof v === 'string' && DAY.test(v));
const isInstantOrNull = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)));

/** What a summary answer means for the line. Pure. */
export function summaryState(status: number, body: unknown): SummaryState {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (status === 409 && b.unreadable === true) {
    return { kind: 'unreadable', repairable: b.repairable === true, ...(b.index_missing === true ? { indexMissing: true } : {}) };
  }
  if (status !== 200 || !isDayOrNull(b.first_recorded) || !isDayOrNull(b.last_recorded)) return { kind: 'quiet' };
  if (!isInstantOrNull(b.first_recorded_at) || !isInstantOrNull(b.last_recorded_at)) return { kind: 'quiet' };
  return {
    kind: 'recorded',
    span: {
      first_recorded: b.first_recorded as string | null,
      last_recorded: b.last_recorded as string | null,
      first_recorded_at: (b.first_recorded_at as string | null | undefined) ?? null,
      last_recorded_at: (b.last_recorded_at as string | null | undefined) ?? null,
    },
  };
}

/** Asks the server to rebuild the index: what it answered, in the person's
 *  words. `damagedMonths` counts months too damaged to read, left as they
 *  were. */
export async function requestRepair(
  send: typeof fetch = fetch
): Promise<{ ok: true; damagedMonths: number } | { ok: false; error: string }> {
  try {
    const res = await send('/api/holdings-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'repair', confirm: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, damagedMonths: Number.isSafeInteger(body?.damaged_months) ? body.damaged_months : 0 };
    return { ok: false, error: typeof body?.error === 'string' && body.error ? body.error : 'Could not repair holdings history. Try again.' };
  } catch {
    return { ok: false, error: 'Could not reach Nya. Try again.' };
  }
}

/** The line, or what stopped it, pure. */
export function HoldingsRecordedView({
  state,
  today,
  damagedMonths = 0,
  onRepair,
}: {
  state: SummaryState;
  today: string;
  /** After a repair: months too damaged to read, left as they were. */
  damagedMonths?: number;
  onRepair: () => void;
}) {
  if (state.kind === 'loading' || state.kind === 'quiet') return null;
  if (state.kind === 'unreadable') {
    return (
      <div className="as-of stale">
        {state.indexMissing ? (
          <>Holdings history can&apos;t be read: the list of where its months are kept is missing.</>
        ) : (
          <>Holdings history can&apos;t be read, so it isn&apos;t being recorded.</>
        )}
        {state.repairable && (
          <>
            {' '}
            <button className="link-btn" onClick={onRepair}>
              Repair it
            </button>
          </>
        )}
      </div>
    );
  }
  const one = damagedMonths === 1;
  return (
    <>
      <HoldingsRecordedLine span={state.span} today={today} />
      {damagedMonths > 0 && (
        <div className="as-of stale">
          {one ? '1 month' : `${damagedMonths} months`} of holdings history {one ? 'is' : 'are'} damaged and can&apos;t be
          read, so {one ? 'it was' : 'they were'} left as {one ? 'it was' : 'they were'}.
        </div>
      )}
    </>
  );
}

/** What the repair says before it does anything, pure. `missing`: the list
 *  is missing rather than damaged, which stops no recording. */
export function RepairConfirm({
  phase,
  missing = false,
  onCancel,
  onConfirm,
}: {
  phase: RepairPhase;
  missing?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const busy = phase.kind === 'repairing';
  return (
    <>
      {missing ? (
        <p className="panel-note" style={{ marginTop: 0 }}>
          The list of where each month of your holdings history is kept is missing, so what was recorded can&apos;t be
          read. Nya can rebuild it from the months themselves. Nothing is lost: every month stays as it is.
        </p>
      ) : (
        <p className="panel-note" style={{ marginTop: 0 }}>
          The list of where each month of your holdings history is kept is damaged and can&apos;t be read, so no holdings
          are being recorded. Nya can rebuild it from the months themselves. Nothing that can be read is lost: the
          damaged list can&apos;t be read by anyone. Recording starts again with the next refresh.
        </p>
      )}
      {phase.kind === 'failed' && <div className="error">{phase.error}</div>}
      <div className="button-pair" style={{ marginTop: 16 }}>
        <button className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button onClick={onConfirm} disabled={busy}>
          {busy ? 'Rebuilding…' : 'Rebuild it'}
        </button>
      </div>
    </>
  );
}

export default function HoldingsRecorded({ accountId }: { accountId: string }) {
  const [state, setState] = useState<SummaryState>({ kind: 'loading' });
  const [phase, setPhase] = useState<RepairPhase>({ kind: 'closed' });
  const [damagedMonths, setDamagedMonths] = useState(0);
  // The sheet goes on the page itself, not inside the table row this sits in.
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => setPortal(document.body), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/holdings-history?summary=1&account_id=${encodeURIComponent(accountId)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!cancelled) setState(summaryState(res.status, body));
      })
      .catch(() => {
        // A passing failure: nothing to say (see the header).
        if (!cancelled) setState({ kind: 'quiet' });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, reload]);

  const repair = useCallback(async () => {
    setPhase({ kind: 'repairing' });
    const result = await requestRepair();
    if (!result.ok) {
      setPhase({ kind: 'failed', error: result.error });
      return;
    }
    setPhase({ kind: 'closed' });
    setDamagedMonths(result.damagedMonths);
    setReload((n) => n + 1);
  }, []);

  const close = () => {
    if (phase.kind !== 'repairing') setPhase({ kind: 'closed' });
  };

  return (
    <>
      <HoldingsRecordedView
        state={state}
        today={new Date().toISOString().slice(0, 10)}
        damagedMonths={damagedMonths}
        onRepair={() => setPhase({ kind: 'confirming' })}
      />
      {portal &&
        state.kind === 'unreadable' &&
        state.repairable &&
        createPortal(
          <Sheet open={phase.kind !== 'closed'} title="Repair holdings history" onClose={close}>
            <RepairConfirm phase={phase} missing={state.indexMissing === true} onCancel={close} onConfirm={() => void repair()} />
          </Sheet>,
          portal
        )}
    </>
  );
}
