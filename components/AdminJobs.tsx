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
import { CAUTION, LevelWord } from './ConnectionStatus';
import { backupWords, filesWords } from './NetWorthCard';
import { PageHeader } from './PageHeader';

type Job = JobView['job'];

const NAMES: Record<Job, string> = { backup: 'Nightly backup', files: 'Receipts and documents clean-up' };
const WHAT: Record<Job, string> = {
  backup: 'Copies every account’s data, as stored, to the private file store, and prunes old copies.',
  files: 'Throws away unfinished uploads and finishes deletes, and once a week removes files no record names.',
};
const RAN: Record<Job, string> = { backup: 'The backup ran and was saved.', files: 'The clean-up ran.' };
/** How often the page reads the jobs again while a run is going. */
const POLL_MS = 5000;

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

/** Why Run now waits, while it does: a run going (of either job, since one
 *  runs at a time), or this job worked a moment ago. Never a failure: a job
 *  that failed can be run again at once. */
function waitWords(v: JobView): string | null {
  const r = v.running_now;
  if (r) {
    if (r.job !== v.job) return `The ${NAMES[r.job].toLowerCase()} is running now. Run this once it finishes.`;
    return `${r.by === 'cron' ? 'Its nightly cron is running it now' : 'It is running now, started from this page'}. Run now comes back when it finishes.`;
  }
  if (v.again_at) return `It worked a few minutes ago. Run it again from here after ${time(v.again_at)}.`;
  return null;
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
            {CAUTION}
            <div>
              <LevelWord level="caution" />
              {problem}
            </div>
          </div>
        ) : view.last_ok ? (
          <div className="notice done">
            {CHECK}
            <div>
              <LevelWord level="done" />
              Its last run worked, on {when(view.last_ok)}.
            </div>
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
              <button type="button" className="btn secondary" disabled={running !== null || view.running_now !== null || view.again_at !== null} onClick={() => onRun(view.job)}>
                {running === view.job ? 'Running…' : 'Run now'}
              </button>
            </div>
            {running === null && waitWords(view) && <p className="helper">{waitWords(view)}</p>}
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
  /** Counts each read, worked or failed, so the timer below is set again after
   *  every one: a read that fails while a run is going is tried again. */
  const [reads, setReads] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/jobs', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setJobs((await res.json()).jobs);
      setError('');
    } catch {
      setError('Could not read the nightly jobs right now.');
    } finally {
      setReads((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // While a run is going (a cron's, or one started elsewhere), the buttons
  // wait: read again every few seconds, so they come back once it ends without
  // a reload. A job that just worked waits until its again_at.
  const going = !!jobs?.some((j) => j.running_now);
  const againAt = jobs?.map((j) => j.again_at).filter((t): t is string => t !== null).sort()[0] ?? null;
  useEffect(() => {
    if (running !== null) return;
    const wait = going ? POLL_MS : againAt ? Math.max(0, Date.parse(againAt) - Date.now()) + 1000 : null;
    if (wait === null) return;
    const timer = setTimeout(load, wait);
    return () => clearTimeout(timer);
  }, [going, againAt, running, reads, load]);

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
      <PageHeader back="/admin" />
      <h1>Nightly jobs</h1>
      <p className="sub">The jobs that keep a copy of everything and tidy the file store. When one fails, see its reason here, then run it again now rather than waiting a night.</p>
      <div className="stack">
        {error && (
          <div className="notice caution">
            {CAUTION}
            <div>
              <LevelWord level="caution" />
              {error}
            </div>
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
