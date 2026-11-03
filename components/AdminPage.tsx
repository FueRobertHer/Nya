'use client';

// The admin page (/admin, app/admin-view/page.tsx), for the deployment's
// admin only: what needs doing, the feature switches, the nightly jobs and
// storage, unused connections, the demo accounts, the deployment's settings
// and operations, read only, and the record of changes to the switches. One
// page, so Settings keeps a single Admin row (components/AdminEntry.tsx) and
// Home only the admin's Needs attention rows, which link here.
//
// The server reads everything (lib/admin-page.ts) and hands this plain data,
// never a secret. A part it couldn't read is null, and its card says so.
// Every day it writes goes through useBrowserDay: the ISO day as the server
// draws it, then the reader's own once it runs in the browser.

import { useState } from 'react';
import type { JobView } from '@/lib/backup';
import type { AdminPageData } from '@/lib/admin-page';
import type { ChangeLine } from '@/lib/flag-view';
import AdminUnusedItems from './AdminUnusedItems';
import FeatureSwitchesCard from './FeatureSwitchesCard';
import { chevron, RIGHT } from './MonthStepper';
import { AdminAttentionList, adminAttentionRows } from './NeedsAttention';
import { PageHeader } from './PageHeader';
import { Notice } from './TotalCaveats';
import { useBrowserDay, useBrowserWhen } from './browser-day';

const DOCS = 'https://github.com/FueRobertHer/Nya/blob/main/docs';

/** The operations done by hand, each by its section of the guide, with the
 *  ops route (under /api/ops/) or script it runs. None runs from here. */
export const OPERATIONS: { name: string; how: string; href: string }[] = [
  { name: 'Taking a backup by hand', how: 'Ops route: export', href: `${DOCS}/operations.md#taking-a-backup-by-hand` },
  { name: 'Rotating the master key', how: 'Ops route: rotate-master', href: `${DOCS}/operations.md#rotating-the-master-key` },
  { name: 'Moving existing data to keys of its own', how: 'Ops route: reencrypt', href: `${DOCS}/operations.md#moving-existing-data-to-keys-of-its-own-the-migration-pass` },
  { name: 'Per-container data keys', how: 'Ops route: container-keys', href: `${DOCS}/operations.md#per-container-data-keys` },
  { name: 'Containers', how: 'Ops route: containers', href: `${DOCS}/operations.md#containers` },
  { name: 'Repairing balance signs', how: 'Ops route: sign-repair', href: `${DOCS}/operations.md#repairing-balance-signs` },
  { name: 'Restoring a backup', how: 'Script: bun run restore', href: `${DOCS}/operations.md#restoring-a-backup` },
  { name: 'Moving the data into containers', how: 'Script: bun run move-data', href: `${DOCS}/operations.md#moving-the-data-into-containers` },
  { name: 'Resetting the demo accounts', how: 'Script: scripts/seed-demo.ts', href: `${DOCS}/authentication.md#resetting-the-demo-accounts` },
];

/** How many changes the record shows before Show all. */
export const CHANGES_SHOWN = 25;

const JOB_NAMES: Record<JobView['job'], string> = { backup: 'Backup', files: 'Clean-up' };

/** A job's last outcome, in a few words. */
function jobLine(v: JobView, day: (iso: string) => string): string {
  if (v.problem) return `${JOB_NAMES[v.job]} needs attention`;
  if (v.last_ok) return `${JOB_NAMES[v.job]} worked ${day(v.last_ok)}`;
  return `${JOB_NAMES[v.job]} hasn’t run`;
}

/** A card's title row. */
function Header({ id, children }: { id: string; children: string }) {
  return (
    <div className="card-header">
      <h2 id={id}>{children}</h2>
    </div>
  );
}

function Unread({ what }: { what: string }) {
  return <Notice level="caution">{what} couldn’t be read. Reload the page to try again.</Notice>;
}

/** The record, latest first: each switch by name, then what changed, when,
 *  and who, when it wasn't the admin. */
function Changes({ changes, environment, when }: { changes: AdminPageData['changes']; environment: string; when: (iso: string) => string }) {
  const [all, setAll] = useState(false);
  const lines = changes?.lines ?? [];
  const shown = all ? lines : lines.slice(0, CHANGES_SHOWN);
  return (
    <section className="card" aria-labelledby="admin-changes-title">
      <Header id="admin-changes-title">Changes</Header>
      <p className="helper">Each change to a feature switch in {environment}, latest first. The last 500 are kept.</p>
      {!changes ? (
        <Unread what="The record of changes" />
      ) : lines.length === 0 ? (
        <p className="empty-note">No switch has been changed here yet.</p>
      ) : (
        <ul className="list-rows">
          {shown.map((c: ChangeLine, i) => (
            <li key={`${c.at}-${i}`}>
              <div className="list-row">
                <span className="list-row-text">
                  <span className="list-row-title">{c.name}</span>
                  <span className="list-row-sub">
                    {c.change} · {when(c.at)}
                    {c.by && ` · ${c.by}`}
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {lines.length > CHANGES_SHOWN && (
        <div className="btn-row">
          <button type="button" className="btn ghost" aria-expanded={all} onClick={() => setAll((a) => !a)}>
            {all ? 'Show the latest 25' : `Show all ${lines.length}`}
          </button>
        </div>
      )}
      {changes && changes.unreadable > 0 && (
        <p className="helper">
          {changes.unreadable === 1 ? '1 change this release can’t read is' : `${changes.unreadable} changes this release can’t read are`} left out.
        </p>
      )}
    </section>
  );
}

export default function AdminPage({ data }: { data: AdminPageData }) {
  const day = useBrowserDay();
  const when = useBrowserWhen();
  const attention = adminAttentionRows(data.backup, data.files, data.ops, day);
  // Each switch's latest five changes, for its sheet.
  const latest: Record<string, ChangeLine[]> = {};
  for (const c of data.changes?.lines ?? []) {
    const list = (latest[c.key] ??= []);
    if (list.length < 5) list.push(c);
  }
  const inUse = data.accounts?.filter((a) => a.active).length ?? null;

  return (
    <main className="wrap report-wrap">
      <PageHeader back="/?settings=admin" />
      <h1>Admin</h1>
      <p className="sub">{data.environment}. Only you see this page.</p>
      <div className="stack">
        {attention.length > 0 && (
          <section className="card needs-attention" aria-labelledby="admin-needs-title">
            <Header id="admin-needs-title">Needs attention</Header>
            <AdminAttentionList rows={attention} />
          </section>
        )}

        {data.rows ? (
          <FeatureSwitchesCard
            rows={data.rows}
            place="admin"
            demos={data.demos?.some((d) => d.set) ?? false}
            environment={data.environment}
            freshSignIn={data.freshSignIn}
            clerk={data.clerk}
            accounts={data.accounts ?? []}
            changes={latest}
          />
        ) : (
          <section id="feature-switches" className="card" aria-labelledby="feature-switches-title">
            <Header id="feature-switches-title">Feature switches</Header>
            <Unread what="The feature switches" />
          </section>
        )}

        <section className="card" aria-labelledby="admin-jobs-title">
          <Header id="admin-jobs-title">Jobs and storage</Header>
          <ul className="list-rows">
            <li>
              <a className="list-row" href="/admin/jobs">
                <span className="list-row-text">
                  <span className="list-row-title">Nightly jobs</span>
                  <span className="list-row-sub">{data.jobs ? data.jobs.map((v) => jobLine(v, day)).join(' · ') : 'Couldn’t be read'}</span>
                </span>
                {chevron(RIGHT)}
              </a>
            </li>
            <li>
              <a className="list-row" href="/admin/storage">
                <span className="list-row-text">
                  <span className="list-row-title">Storage across accounts</span>
                  <span className="list-row-sub">
                    {inUse === null ? 'Each account’s connections, transactions and storage' : `${inUse} ${inUse === 1 ? 'account' : 'accounts'} in use`}
                  </span>
                </span>
                {chevron(RIGHT)}
              </a>
            </li>
          </ul>
        </section>

        <AdminUnusedItems />

        {data.demos && (
          <section className="card" aria-labelledby="admin-demos-title">
            <Header id="admin-demos-title">Demo accounts</Header>
            <ul className="list-rows">
              {data.demos.map((d) => (
                <li key={d.label}>
                  <div className="list-row">
                    <span className="list-row-text">
                      <span className="list-row-title">{d.label}</span>
                    </span>
                    <span className="list-row-value">{d.set ? 'Set up' : 'Not set up'}</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="helper">
              Set up by DEMO_USER_IDS, never in Production. Each is reset to a scenario from its own Settings, under Your data and privacy, or with
              scripts/seed-demo.ts.{' '}
              <a href={`${DOCS}/authentication.md#resetting-the-demo-accounts`} target="_blank" rel="noreferrer">
                Resetting the demo accounts
              </a>
            </p>
          </section>
        )}

        <section className="card" aria-labelledby="admin-environment-title">
          <Header id="admin-environment-title">Environment</Header>
          <ul className="list-rows">
            {data.facts.map((f) => (
              <li key={f.variable}>
                <div className="list-row">
                  <span className="list-row-text">
                    <span className="list-row-title">{f.name}</span>
                    <span className="list-row-sub">
                      {f.about} Set by {f.variable}.
                    </span>
                  </span>
                  <span className="list-row-value">{f.value}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="helper">
            Read only: each is set in the project’s environment variables and takes effect at the next deploy.{' '}
            <a href={`${DOCS}/deployment.md#3-environment-variables`} target="_blank" rel="noreferrer">
              How to change them
            </a>
          </p>
        </section>

        <section className="card" aria-labelledby="admin-operations-title">
          <Header id="admin-operations-title">Operations</Header>
          <p className="helper">Run outside the app, with the ops secret or a script. Each opens its steps in the docs; an ops route answers only while the ops routes are on.</p>
          <ul className="list-rows">
            {OPERATIONS.map((o) => (
              <li key={o.name}>
                <a className="list-row" href={o.href} target="_blank" rel="noreferrer">
                  <span className="list-row-text">
                    <span className="list-row-title">{o.name}</span>
                    <span className="list-row-sub">{o.how}</span>
                  </span>
                  {chevron(RIGHT)}
                </a>
              </li>
            ))}
          </ul>
        </section>

        <Changes changes={data.changes} environment={data.environment} when={when} />
        <p className="helper">Not on this page: any account’s financial data, or running an operation.</p>
      </div>
    </main>
  );
}
