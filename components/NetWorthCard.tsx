// components/NetWorthCard.tsx
//
// Home's one Net worth card (rollout phase 4a): the total and its change,
// what qualifies the total right under it (components/TotalCaveats.tsx), the
// chart with what qualifies the chart under it, what the nightly jobs say
// (what to do about them is the admin's, in components/NeedsAttention.tsx),
// and a foot row with when it was updated, History paused, and the chart
// notes (components/TimelineNotes.tsx), which open in a sheet. It was a hero
// card, an "Over time" card and a notes card. Every note keeps its words.

import type { ReactNode } from 'react';
import type { AttachmentSweepProblem, BackupProblem } from '@/lib/backup';
import { fmt, fmtAsOf, fmtDay, fmtInstantDay } from './accounts-format';
import { ALERT } from './ConnectionStatus';
import { Masked } from './HideAmounts';
import TotalCaveats, { type Caveat } from './TotalCaveats';

/** What a nightly job failing says, to everyone. What to do is only for the
 *  deployment's admin, who alone can (design-system.md "Who an instruction
 *  is for"): it is in their card under Needs attention. */
export function backupWords(p: BackupProblem): string {
  if (p.none) return 'No nightly backup has been recorded yet.';
  return `${p.reason ? 'The nightly backup failed' : 'The nightly backup hasn’t run'}${
    p.last_ok ? `; the last one saved was on ${fmtInstantDay(p.last_ok)}.` : '; none has been saved yet.'
  }${p.reason ? ` (${p.reason})` : ''}`;
}

export function filesWords(p: AttachmentSweepProblem): string {
  if (p.paused) return 'The nightly clean-up of receipts and documents is paused until a nightly backup is recorded: it waits while a restore may be running.';
  const what = p.held
    ? 'The nightly clean-up of receipts and documents held back: in an account, it found more stored files with no record than it removes at once, so it removed none of them there.'
    : p.reason
      ? 'The nightly clean-up of receipts and documents failed'
      : 'The nightly clean-up of receipts and documents hasn’t run';
  return `${what}${p.held ? '' : p.last_ok ? `; the last one finished on ${fmtInstantDay(p.last_ok)}.` : '; none has finished yet.'}${p.reason ? ` (${p.reason})` : ''}`;
}

function Caution({ children }: { children: ReactNode }) {
  return (
    <div className="notice caution">
      {ALERT}
      <div>{children}</div>
    </div>
  );
}

export default function NetWorthCard({
  worth,
  currency,
  delta,
  caveats,
  chart,
  pausedSince,
  notesProblem,
  backupProblem,
  filesProblem,
  asOf,
  refreshing,
  notesCount,
  onNotes,
}: {
  worth: number;
  currency: string | null;
  /** The change line under the total, as the dashboard draws it. */
  delta: ReactNode;
  /** What qualifies the total, built while rendering. */
  caveats: readonly Caveat[];
  /** The chart, or why there is none yet, with its own notes. */
  chart: ReactNode;
  /** The last day a total was saved, while history is paused. */
  pausedSince: string | null;
  /** Why the chart notes couldn't all be read. */
  notesProblem: string | null;
  backupProblem: BackupProblem | null;
  filesProblem: AttachmentSweepProblem | null;
  asOf: string | null;
  refreshing: boolean;
  notesCount: number;
  onNotes: () => void;
}) {
  return (
    <section className="card stack net-worth-card" aria-labelledby="net-worth-title">
      <div>
        {/* Focus lands here when the last Needs attention row goes. */}
        <h2 id="net-worth-title" className="total-label" tabIndex={-1}>
          Net worth
        </h2>
        <div className={`total-value${worth < 0 ? ' negative' : ''}`}>
          <Masked>{fmt(worth, currency)}</Masked>
        </div>
        {delta}
      </div>
      <TotalCaveats items={caveats} />

      <div>{chart}</div>
      {pausedSince && (
        <Caution>
          No net-worth total has been saved since {fmtDay(pausedSince)}. A day is only saved when every institution refreshes
          with all of its accounts, so it picks up again once they do.
        </Caution>
      )}
      {notesProblem && <Caution>{notesProblem}</Caution>}

      {backupProblem && <Caution>{backupWords(backupProblem)}</Caution>}
      {filesProblem && <Caution>{filesWords(filesProblem)}</Caution>}

      <div className="net-worth-foot">
        {asOf && (
          <span className="helper">
            Updated {fmtAsOf(asOf)}
            {refreshing ? ' · refreshing…' : ''}
          </span>
        )}
        {pausedSince && <span className="badge warn">History paused</span>}
        <button type="button" className="btn ghost" onClick={onNotes}>
          {notesCount > 0 ? `Chart notes (${notesCount})` : 'Chart notes'}
        </button>
      </div>
    </section>
  );
}
