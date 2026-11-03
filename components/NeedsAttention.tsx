// components/NeedsAttention.tsx
//
// Home's Needs attention card (rollout phase 4b): shown only when something
// asks the person to act, one row each (components/attention.ts), worst
// first, each a button that goes where it is fixed. What a budget row's month
// may be missing is said right after the budget rows, in the words Activity
// and Budgets use. Below it, for the deployment's admin only, what to do
// about the nightly jobs and the ops routes (design-system.md "Who an
// instruction is for"): everyone sees a job's fact on the Net worth card.

import type { ReactNode } from 'react';
import type { AttachmentSweepProblem, BackupProblem } from '@/lib/backup';
import type { OpsOpen } from '@/lib/flag-view';
import type { AttentionItem, AttentionSeverity, Go } from './attention';
import { ALERT, CAUTION } from './ConnectionStatus';
import { Masked } from './HideAmounts';
import { fmtInstantDay } from './accounts-format';
import { LevelWord } from './TotalCaveats';

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** A shape for each level as well as a color: never color alone. */
const ICONS: Record<AttentionSeverity, ReactNode> = {
  critical: ALERT,
  caution: icon('M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'),
  info: icon('M12 16v-4M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'),
};

const CHEVRON = icon('m9 6 6 6-6 6');

export const NEEDS_ATTENTION_TITLE = 'needs-attention-title';

/** One row: its level as an icon and, for a screen reader, a word; what;
 *  and the line under it. */
function Row({ level, what, detail, onClick }: { level: AttentionSeverity; what: string; detail?: string; onClick: () => void }) {
  return (
    <button type="button" className="list-row" onClick={onClick}>
      <span className={`list-row-icon ${level}`}>{level === 'critical' ? ICONS.critical : level === 'caution' ? ICONS.caution : ICONS.info}</span>
      <span className="list-row-text">
        <span className="list-row-title">
          <span className="visually-hidden">{level === 'critical' ? 'Critical: ' : level === 'caution' ? 'Caution: ' : 'Note: '}</span>
          <Masked>{what}</Masked>
        </span>
        {detail && (
          <span className="list-row-sub">
            <Masked>{detail}</Masked>
          </span>
        )}
      </span>
      {CHEVRON}
    </button>
  );
}

/** What this month's spending may be missing, after the last row read from
 *  it (here, and in This month, components/Insights.tsx). */
export function SpendingNotes({ leftOut, missing }: { leftOut: string | null; missing: readonly string[] }) {
  return (
    <div className="stack tight row-notes">
      {missing.map((n) => (
        <div className="notice caution" key={n}>
          {CAUTION}
          <div>
            <LevelWord level="caution" />
            {n}
          </div>
        </div>
      ))}
      {leftOut && (
        <div className="notice info">
          {ICONS.info}
          <div>
            <LevelWord level="info" />
            {leftOut}
          </div>
        </div>
      )}
    </div>
  );
}

export default function NeedsAttention({
  items,
  notes,
  onGo,
}: {
  items: readonly AttentionItem[];
  /** What this month's spending may be missing, said after its rows. */
  notes: { leftOut: string | null; missing: readonly string[] };
  onGo: (go: Go) => void;
}) {
  if (items.length === 0) return null;
  // Counted row by row rather than with items.length: the hide amounts scan
  // (test/amount-sources.ts) takes what is read off the rows' list as a
  // possible amount, since a row's words can hold one.
  let count = 0;
  for (const item of items) if (item.severity) count += 1;
  let last = -1;
  items.forEach((item, i) => {
    if (item.spending) last = i;
  });
  const said = last >= 0 && (notes.leftOut || notes.missing.length > 0);
  return (
    <section className="card needs-attention" aria-labelledby={NEEDS_ATTENTION_TITLE}>
      <div className="card-header">
        <h2 id={NEEDS_ATTENTION_TITLE} tabIndex={-1}>
          Needs attention <span className="meta">{count}</span>
          <span className="visually-hidden"> {count === 1 ? 'item' : 'items'}</span>
        </h2>
      </div>
      <ul className="list-rows">
        {items.map((item, i) => (
          <li key={item.key}>
            <Row level={item.severity} what={item.title} detail={item.sub} onClick={() => onGo(item.go)} />
            {said && i === last && <SpendingNotes leftOut={notes.leftOut} missing={notes.missing} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One thing the admin should do, as a row: what, the line under it, and
 *  where it is done. */
export type AdminAttentionRow = { key: string; title: string; sub: string; href: string };

/** What the admin should do about the nightly jobs and the ops routes, as the
 *  redesign draws it ("Nightly backup failed" over "Last saved Oct 20 ·
 *  Check the backup cron in Vercel."); the fact in full is on the Net worth
 *  card. A job's row goes to the Nightly jobs page (/admin/jobs,
 *  components/AdminJobs.tsx), where its last runs are and it can be run
 *  again; the ops routes' row to their switch on the admin page. Nothing
 *  while the clean-up only waits for a backup. Shared by Home's Admin card
 *  and the admin page's Needs attention (components/AdminPage.tsx), which
 *  pass how to write a day: Home draws these only after a fetch, in the
 *  browser; the admin page is drawn on the server first
 *  (components/browser-day.ts). */
export function adminAttentionRows(
  backup: BackupProblem | null,
  files: AttachmentSweepProblem | null,
  ops: OpsOpen | null,
  day: (iso: string) => string
): AdminAttentionRow[] {
  const rows: AdminAttentionRow[] = [];
  // A reason as the job gave it, without a closing period before the next part.
  const why = (reason: string | null | undefined) => reason?.replace(/\.$/, '') || null;
  if (backup) {
    const when = backup.none ? null : backup.last_ok ? `Last saved ${day(backup.last_ok)}` : 'None saved yet';
    rows.push({
      key: 'backup',
      title: backup.none ? 'No nightly backup recorded yet' : backup.reason ? 'Nightly backup failed' : 'Nightly backup hasn’t run',
      sub: [when, why(backup.reason), 'Check the backup cron in Vercel.'].filter(Boolean).join(' · '),
      href: '/admin/jobs',
    });
  }
  if (files && !files.paused) {
    const when = files.held ? null : files.last_ok ? `Last finished ${day(files.last_ok)}` : 'None finished yet';
    rows.push({
      key: 'files',
      title: files.held ? 'Receipt clean-up held back' : files.reason ? 'Receipt clean-up failed' : 'Receipt clean-up hasn’t run',
      sub: [when, why(files.reason), files.held ? 'It found more stored files with no record than it removes at once. Its log in Vercel names the account.' : 'Check the clean-up cron in Vercel.']
        .filter(Boolean)
        .join(' · '),
      href: '/admin/jobs',
    });
  }
  if (ops) {
    rows.push({
      key: 'ops',
      title: 'The ops routes are on',
      sub: ops === 'variable' ? 'OPS_ENABLED is set: remove it once the operation is done.' : 'Turn them off once the operation is done.',
      href: '/admin#feature-switches',
    });
  }
  return rows;
}

/** The admin's rows, each a link to where it is done. */
export function AdminAttentionList({ rows }: { rows: AdminAttentionRow[] }) {
  return (
    <ul className="list-rows">
      {rows.map((r) => (
        <li key={r.key}>
          <a className="list-row" href={r.href}>
            <span className="list-row-icon caution">{ICONS.caution}</span>
            <span className="list-row-text">
              <span className="list-row-title">
                <LevelWord level="caution" />
                {r.title}
              </span>
              <span className="list-row-sub">{r.sub}</span>
            </span>
            {CHEVRON}
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Home's card for the admin (adminAttentionRows), so Home holds no controls
 *  for what it says. `ops` is sent for the admin alone (app/page.tsx). */
export function AdminAttention({ backup, files, ops = null }: { backup: BackupProblem | null; files: AttachmentSweepProblem | null; ops?: OpsOpen | null }) {
  const rows = adminAttentionRows(backup, files, ops, fmtInstantDay);
  if (rows.length === 0) return null;
  return (
    <section className="card needs-attention" aria-labelledby="admin-attention-title">
      <div className="card-header">
        <h2 id="admin-attention-title">Admin</h2>
      </div>
      <AdminAttentionList rows={rows} />
    </section>
  );
}
