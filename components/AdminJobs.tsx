'use client';

// Nightly jobs (/admin/jobs, app/admin-view/jobs), for the admin only: the
// backup and the clean-up of receipts and documents, each with when it runs,
// how it last went, and Run now, which runs it as its cron does
// (/api/admin/jobs). A page of its own, so Home keeps only the fact and a
// link to here (components/NeedsAttention.tsx AdminAttention). The server
// decides who the admin is: proxy.ts answers anyone else as a path that does
// not exist, and the route with a 404.

import { useCallback, useEffect, useState } from 'react';
import type { AttachmentSweepProblem, BackupProblem, JobView } from '@/lib/backup';
import { ALERT } from './ConnectionStatus';
import { backupWords, filesWords } from './NetWorthCard';

type Job = JobView['job'];

const NAMES: Record<Job, string> = { backup: 'Nightly backup', files: 'Receipts and documents clean-up' };
const WHAT: Record<Job, string> = {
  backup: 'Copies every account’s data, as stored, to the private file store, and prunes old copies.',
  files: 'Throws away unfinished uploads and finishes deletes, and once a week removes files no record names.',
};
const RAN: Record<Job, string> = { backup: 'The backup ran and was saved.', files: 'The clean-up ran.' };

const CHECK = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const pad = (n: number) => String(n).padStart(2, '0');

function words(v: JobView): string | null {
  if (!v.problem) return null;
  return v.job === 'backup' ? backupWords(v.problem as BackupProblem) : filesWords(v.problem as AttachmentSweepProblem);
}

/** Why a job can't be run from here, when it can't. */
function whyNot(v: JobView): string | null {
  if (v.runnable) return null;
  if (v.job === 'files' && (v.problem as AttachmentSweepProblem | null)?.held) return 'Running it again would hold back again. Its log in Vercel names the account.';
  return 'No file store is connected, so there is nothing to run.';
}

/** One job: what it does, how it last went, and Run now. `said` is what the
 *  last run from here answered. */
export function JobCard({ view, running, said, onRun }: { view: JobView; running: Job | null; said: string | null; onRun: (job: Job) => void }) {
  const problem = words(view);
  const not = whyNot(view);
  const id = `job-${view.job}`;
  return (
    <section className="card" aria-labelledby={id}>
      <div className="card-header">
        <h2 id={id}>{NAMES[view.job]}</h2>
      </div>
      <div className="stack">
        <p className="helper">
          {WHAT[view.job]} Every day at {pad(view.hour)}:{pad(view.minute)} UTC.
        </p>
        {problem ? (
          <div className="notice caution">
            {ALERT}
            <div>{problem}</div>
          </div>
        ) : view.last_ok ? (
          <div className="notice done">
            {CHECK}
            <div>Its last run worked, on {when(view.last_ok)}.</div>
          </div>
        ) : null}
        {(view.last_ok || view.last_failed) && (
          <dl className="txn-detail">
            {view.last_ok && (
              <div className="txn-detail-row">
                <dt>Last worked</dt>
                <dd>{when(view.last_ok)}</dd>
              </div>
            )}
            {view.last_failed && (
              <div className="txn-detail-row">
                <dt>Last failed</dt>
                <dd>
                  {when(view.last_failed)}
                  {view.reason ? `: ${view.reason}` : ''}
                </dd>
              </div>
            )}
          </dl>
        )}
        {not ? (
          <p className="helper">{not}</p>
        ) : (
          <>
            <div className="btn-row">
              <button type="button" className="btn secondary" disabled={running !== null || view.hold_until !== null} onClick={() => onRun(view.job)}>
                {running === view.job ? 'Running…' : 'Run now'}
              </button>
            </div>
            {view.hold_until && running === null && <p className="helper">A nightly job may be running now. Run it from here after {time(view.hold_until)}.</p>}
          </>
        )}
        <p className="helper" role="status">
          {running === view.job ? 'Running. This can take up to five minutes.' : (said ?? '')}
        </p>
      </div>
    </section>
  );
}

export default function AdminJobs() {
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState<Job | null>(null);
  const [said, setSaid] = useState<{ job: Job; words: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/jobs', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setJobs((await res.json()).jobs);
      setError('');
    } catch {
      setError('Could not read the nightly jobs right now.');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // While the nightly crons may be running, the buttons wait; read again when
  // that ends, so they come back without a reload.
  const holdUntil = jobs?.find((j) => j.hold_until)?.hold_until ?? null;
  useEffect(() => {
    if (!holdUntil) return;
    const timer = setTimeout(load, Math.max(0, Date.parse(holdUntil) - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [holdUntil, load]);

  const run = async (job: Job) => {
    setRunning(job);
    setSaid(null);
    try {
      const res = await fetch('/api/admin/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job }) });
      const body = await res.json().catch(() => ({}));
      if (Array.isArray(body.jobs)) setJobs(body.jobs);
      if (res.ok) setSaid({ job, words: RAN[job] });
      else if (res.status === 409 && typeof body.error === 'string') setSaid({ job, words: body.error });
      else if (res.status === 500 && typeof body.error === 'string' && Array.isArray(body.jobs)) setSaid({ job, words: 'It failed again.' });
      else setSaid({ job, words: 'Could not run it right now.' });
    } catch {
      setSaid({ job, words: 'Could not run it right now.' });
    } finally {
      setRunning(null);
    }
  };

  return (
    <main className="wrap report-wrap">
      <div className="report-top">
        <nav className="report-nav" aria-label="Back to Nya">
          <a href="/">← Nya</a>
        </nav>
      </div>
      <h1>Nightly jobs</h1>
      <p className="sub">The jobs that keep a copy of everything and tidy the file store. When one fails, see its reason here, then run it again now rather than waiting a night.</p>
      <div className="stack">
        {error && (
          <div className="notice caution">
            {ALERT}
            <div>{error}</div>
          </div>
        )}
        {!jobs && !error && <p className="empty-note">Reading…</p>}
        {jobs?.map((v) => (
          <JobCard key={v.job} view={v} running={running} said={said?.job === v.job ? said.words : null} onRun={run} />
        ))}
      </div>
    </main>
  );
}
