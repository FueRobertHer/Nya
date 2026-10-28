// components/NetWorthCard.tsx
//
// Home's one Net worth card (rollout phase 4a): the total and its change,
// what qualifies the total right under it (components/TotalCaveats.tsx), the
// chart with what qualifies the chart under it, what the nightly jobs say
// (what to do about them is the admin's, in components/NeedsAttention.tsx),
// and a foot row with when it was updated, History paused, and the chart
// notes (components/TimelineNotes.tsx), which open in a sheet. It was a hero
// card, an "Over time" card and a notes card. Every note keeps its words.
//
// Since the look and feel's step 5 it is Home's hero: on the page, not in a
// card, its chart running edge to edge. Dragging across the chart moves the
// figure to the day under the finger, and the change line's place says which
// day (and whether it is an estimate) until the finger lifts.

import { useState, type ReactNode } from 'react';
import type { AttachmentSweepProblem, BackupProblem } from '@/lib/backup';
import { fmtAsOf, fmtDay, fmtInstantDay } from './accounts-format';
import { CAUTION } from './ConnectionStatus';
import { Hero } from './Hero';
import { HeroScrub, type HeroReading } from './hero-scrub';
import { Masked } from './HideAmounts';
import { formatMoney, moneyRuns, roundsToNothing } from '@/lib/format';
import TotalCaveats, { LevelWord, type Caveat } from './TotalCaveats';

/** The change Home's hero shows (components/Dashboard.tsx works it out). */
export type HeroChange = { value: number; pct: number; days: number };

/** The hero's change line: up in green, down in red, each with its arrow and
 *  how much; a change that rounds to nothing in the currency is said in
 *  words, in the secondary text color and with no arrow, so no change never
 *  reads as a gain. What else the change holds (accounts that ended, rate
 *  moves) follows either way. */
export function HeroDelta({ delta, currency, endedIn, fromRates }: { delta: HeroChange; currency: string | null; endedIn: number; fromRates: string }) {
  const none = roundsToNothing(delta.value, currency);
  const up = delta.value > 0;
  const days = `${delta.days} ${delta.days === 1 ? 'day' : 'days'}`;
  return (
    <div className={`hero-delta ${none ? 'flat' : up ? 'up' : 'down'}`}>
      {none ? (
        `No change in ${days}`
      ) : (
        <>
          {up ? '▲' : '▼'} <Masked>{formatMoney(Math.abs(delta.value), currency)}</Masked> ({delta.pct.toFixed(1)}%) · past {days}
        </>
      )}
      {endedIn > 0 && ` · includes ${endedIn === 1 ? 'an account' : `${endedIn} accounts`} that ended`}
      {fromRates && (
        <>
          {' · '}
          <Masked>{fromRates}</Masked>
        </>
      )}
    </div>
  );
}

/** The total, its cents at half size (look and feel, step 3). Drawn in runs
 *  a screen reader would stop between, so it hears the whole figure apart;
 *  while amounts are hidden there are no cents, and Masked says "hidden". */
function HeroFigure({ worth, currency }: { worth: number; currency: string | null }) {
  // The same text either way: moneyRuns joins to formatMoney's.
  const whole = formatMoney(worth, currency);
  const runs = moneyRuns(worth, currency);
  if (!runs.some((r) => r.cents)) return <Masked>{whole}</Masked>;
  return (
    <>
      <span aria-hidden="true">
        {runs.map((r, i) =>
          r.cents ? (
            <span key={i} className="cents">
              <Masked>{r.text}</Masked>
            </span>
          ) : (
            <Masked key={i}>{r.text}</Masked>
          )
        )}
      </span>
      <span className="visually-hidden">
        <Masked>{whole}</Masked>
      </span>
    </>
  );
}

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
      {CAUTION}
      <div>
        <LevelWord level="caution" />
        {children}
      </div>
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
  // The day a finger is on in the chart (components/hero-scrub.ts), or none.
  const [reading, setReading] = useState<HeroReading | null>(null);
  const shown = reading ? reading.value : worth;
  return (
    // Focus lands on the label when the last Needs attention row goes.
    <Hero
      id="net-worth-title"
      label="Net worth"
      focusable
      className="net-worth-hero"
      figure={<HeroFigure worth={shown} currency={currency} />}
      figureClass={shown < 0 ? 'negative' : undefined}
      line={
        // The change line, about today; while a day is scrubbed, that day in
        // its place, the line keeping its height so the chart under the
        // finger never moves.
        <div className={`hero-line${reading ? ' scrubbed' : ''}`}>
          {delta}
          {reading && (
            <p className="hero-day">
              {reading.day}
              {reading.estimated ? ' · estimated' : ''}
              {reading.note ? ` · ${reading.note}` : ''}
            </p>
          )}
        </div>
      }
    >
      <TotalCaveats items={caveats} />

      <HeroScrub.Provider value={setReading}>
        <div>{chart}</div>
      </HeroScrub.Provider>
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
    </Hero>
  );
}
