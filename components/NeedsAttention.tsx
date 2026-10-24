// components/NeedsAttention.tsx
//
// Home's Needs attention card (rollout phase 4b): shown only when something
// asks the person to act, one row each (components/attention.ts), worst
// first, each a button that goes where it is fixed. What a budget row's month
// may be missing is said right after the budget rows, in the words Activity
// and Budgets use. Below it, for the deployment's admin only, what to do
// about the nightly jobs (design-system.md "Who an instruction is for"):
// everyone sees the fact on the Net worth card.

import { useState, type ReactNode } from 'react';
import type { AttachmentSweepProblem, BackupProblem } from '@/lib/backup';
import type { AttentionItem, AttentionSeverity, Go } from './attention';
import { ALERT } from './ConnectionStatus';
import { Masked } from './HideAmounts';
import { backupWords, filesWords } from './NetWorthCard';

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
          <span className="visually-hidden">{level === 'critical' ? 'Critical: ' : level === 'caution' ? 'Caution: ' : 'Information: '}</span>
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

/** What this month's spending may be missing, after its last row. */
function Notes({ notes }: { notes: { leftOut: string | null; missing: readonly string[] } }) {
  return (
    <div className="stack tight needs-attention-notes">
      {notes.missing.map((n) => (
        <div className="notice caution" key={n}>
          {ALERT}
          <div>{n}</div>
        </div>
      ))}
      {notes.leftOut && (
        <div className="notice info">
          {ICONS.info}
          <div>{notes.leftOut}</div>
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
            {said && i === last && <Notes notes={notes} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What the admin's card is told after a run: what the dashboard now says
 *  of both jobs (app/api/admin/jobs). */
export type JobProblems = { backup: BackupProblem | null; files: AttachmentSweepProblem | null };

type Job = 'backup' | 'files';

const RAN: Record<Job, string> = { backup: 'The backup ran and was saved.', files: 'The clean-up ran.' };

/** The admin's card: what to do about a nightly job that failed, and a
 *  button to run it again now (app/api/admin/jobs), as its cron would. Not
 *  for a clean-up the breaker held: run again, it holds again. Nothing while
 *  the clean-up only waits for a backup. */
export function AdminAttention({ backup, files, onChanged }: { backup: BackupProblem | null; files: AttachmentSweepProblem | null; onChanged?: (now: JobProblems) => void }) {
  const [running, setRunning] = useState<Job | null>(null);
  // What the last run said, under its row; or, once a run cleared its row, a
  // line of its own.
  const [said, setSaid] = useState<{ job: Job; words: string } | null>(null);
  const [ran, setRan] = useState<Job | null>(null);

  const run = async (job: Job) => {
    setRunning(job);
    setSaid(null);
    setRan(null);
    try {
      const res = await fetch('/api/admin/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job }) });
      const body = await res.json().catch(() => ({}));
      if ('backup_problem' in body || 'attachments_problem' in body) onChanged?.({ backup: body.backup_problem ?? null, files: body.attachments_problem ?? null });
      if (res.ok) setRan(job);
      else if (res.status === 409 && typeof body.error === 'string') setSaid({ job, words: body.error });
      else if (res.status === 500 && typeof body.error === 'string') setSaid({ job, words: 'It failed again.' });
      else setSaid({ job, words: 'Could not run it right now.' });
    } catch {
      setSaid({ job, words: 'Could not run it right now.' });
    } finally {
      setRunning(null);
    }
  };

  const rows: { key: Job; title: string; sub: string; rerun: boolean }[] = [];
  if (backup) rows.push({ key: 'backup', title: backupWords(backup), sub: 'Check the backup cron in Vercel.', rerun: true });
  if (files && !files.paused) rows.push({ key: 'files', title: filesWords(files), sub: files.held ? 'Its log in Vercel names the account.' : 'Check the clean-up cron in Vercel.', rerun: !files.held });
  if (rows.length === 0 && !ran) return null;
  return (
    <section className="card needs-attention" aria-labelledby="admin-attention-title">
      <div className="card-header">
        <h2 id="admin-attention-title">Admin</h2>
      </div>
      {rows.length > 0 && (
        <ul className="list-rows">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="list-row">
                <span className="list-row-icon caution">{ICONS.caution}</span>
                <span className="list-row-text">
                  <span className="list-row-title">
                    <span className="visually-hidden">Caution: </span>
                    {r.title}
                  </span>
                  <span className="list-row-sub">{r.sub}</span>
                  {r.rerun && (
                    <span className="btn-row">
                      <button type="button" className="btn secondary" disabled={running !== null} onClick={() => run(r.key)}>
                        {running === r.key ? 'Running…' : 'Run again'}
                      </button>
                    </span>
                  )}
                  {r.rerun && (
                    <span className="list-row-sub" role="status">
                      {running === r.key ? 'This can take up to five minutes.' : said?.job === r.key ? said.words : ''}
                    </span>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {ran && !rows.some((r) => r.key === ran) && (
        <div className="needs-attention-notes">
          <div className="notice done" role="status">
            {ICONS.info}
            <div>{RAN[ran]}</div>
          </div>
        </div>
      )}
    </section>
  );
}
