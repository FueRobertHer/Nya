// components/TotalCaveats.tsx
//
// What qualifies a figure, under it: the Home total (rollout phase 4a), the
// FI line in This month (4c), and on Budgets > Month the month's one notice
// and the Spent card's notes (6a2), as design-system.md "Status and honesty"
// rules 1 and 3 say: each critical caveat in full, in red, always.
// The lesser ones show in full when there is one; two or more become one line
// that says how many and of what, in the color of the worst, and opens in
// place to each in its own words and color. A <details>, so it works with no
// script, and the words stay on the page while it is closed.

import type { ReactNode } from 'react';
import type { Severity } from '@/lib/accounts-status';
import { joinNames } from '@/lib/month-coverage';
import { CAUTION, levelIcon } from './ConnectionStatus';
import { Masked } from './HideAmounts';

export type CaveatSeverity = Severity | 'info';

/** One caveat: its color, a few words for the summary line (never an
 *  amount), and what it says in full. */
export type Caveat = { key: string; severity: CaveatSeverity; summary: string; body: ReactNode };

const INFO = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);

const CHEVRON = (
  <svg className="notice-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const RANK: Record<CaveatSeverity, number> = { critical: 2, caution: 1, info: 0 };

/** The summary line's words: the count, then at most three kinds, each
 *  once (two loans whose interest couldn't be read are one kind), the worst
 *  first, so a line in amber names what made it amber. */
export function summaryText(lesser: readonly Caveat[]): string {
  const kinds = [...new Set([...lesser].sort((a, b) => RANK[b.severity] - RANK[a.severity]).map((c) => c.summary))];
  const shown = kinds.length > 3 ? [...kinds.slice(0, 3), `${kinds.length - 3} more`] : kinds;
  return `${lesser.length} notes: ${joinNames(shown)}`;
}

/** What a screen reader says first, for what the color shows. */
export function LevelWord({ level }: { level: CaveatSeverity }) {
  return <span className="visually-hidden">{level === 'critical' ? 'Critical: ' : level === 'caution' ? 'Caution: ' : 'Note: '}</span>;
}

/** One notice on its own, in its level's color, with its icon and its
 *  level said first: a caveat in full, or an error said where it arose (a
 *  budget's sheet, the month's card). */
export function Notice({ level, children }: { level: CaveatSeverity; children: ReactNode }) {
  return (
    <div className={`notice ${level}`}>
      {level === 'info' ? INFO : levelIcon(level)}
      <div>
        <LevelWord level={level} />
        {children}
      </div>
    </div>
  );
}

function CaveatNotice({ caveat }: { caveat: Caveat }) {
  return <Notice level={caveat.severity}>{caveat.body}</Notice>;
}

export default function TotalCaveats({ items }: { items: readonly Caveat[] }) {
  const critical = items.filter((c) => c.severity === 'critical');
  const lesser = items.filter((c) => c.severity !== 'critical');
  if (items.length === 0) return null;
  const worst = lesser.reduce<CaveatSeverity>((w, c) => (RANK[c.severity] > RANK[w] ? c.severity : w), 'info');
  return (
    <div className="stack tight">
      {critical.map((c) => (
        <CaveatNotice key={c.key} caveat={c} />
      ))}
      {lesser.length === 1 && <CaveatNotice caveat={lesser[0]} />}
      {lesser.length > 1 && (
        <details className="notice-summary">
          <summary className={`notice ${worst}`}>
            {worst === 'info' ? INFO : CAUTION}
            <span>
              <LevelWord level={worst} />
              {/* Never an amount, but drawn as the notes are, so the switch
                  would cover one. */}
              <Masked>{summaryText(lesser)}</Masked>
            </span>
            {CHEVRON}
          </summary>
          <div className="stack tight">
            {lesser.map((c) => (
              <CaveatNotice key={c.key} caveat={c} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
