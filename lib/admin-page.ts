// lib/admin-page.ts
//
// What the admin page shows (/admin: app/admin-view/page.tsx, drawn by
// components/AdminPage.tsx), read in one pass on the server. Each part is read
// on its own and is null when it can't be, so one outage leaves the rest of
// the page standing, and that part's card says it couldn't be read.
//
// Plain data only, worded here, so the page's client component imports this
// module's types alone (test/client-imports.test.ts). Of a secret, only
// whether it is set: its value never leaves the server.

import { attachmentSweepProblem, backupNotice, backupRetention, nightlyJobs, type AttachmentSweepProblem, type BackupProblem, type JobView } from './backup';
import { listContainers, type Ctx } from './containers';
import { flagsStore } from './flag-store';
import { adminAccounts, describeChange, opsOpen, switchRows, type AdminAccount, type ChangeLine, type OpsOpen, type SwitchRow } from './flag-view';
import { flagChangeNeedsFreshSignIn } from './flag-change';
import { flagEnvironment, type FlagValue } from './flags';
import { DEMO_NAMES, demoUsers } from './demo';
import { clerkEnabled } from './auth-mode';
import { maxBlobChars } from './blob';
import { unusedDays } from './item-usage';
import { quotaBytes } from './attachments-mode';
import { webhooksEnabled } from './webhook-url';
import { lawCard, type LawCard } from './law-card';

/** One setting of the deployment, read only: what it is, the variable that
 *  sets it, its value in words, and what it does. */
export type AdminFact = { name: string; variable: string; value: string; about: string };

export type AdminPageData = {
  /** Where the page's values hold, in words: "Production", "Preview" or
   *  "Development". */
  environment: string;
  /** Whether a change to a switch asks for a fresh sign-in
   *  (lib/flag-change.ts flagChangeNeedsFreshSignIn). */
  freshSignIn: boolean;
  clerk: boolean;
  /** The demo accounts by name and whether DEMO_USER_IDS sets each up; null
   *  in Production, which offers none. */
  demos: { label: string; set: boolean }[] | null;
  rows: SwitchRow[] | null;
  /** The record, worded, latest first, and how many of its changes this
   *  release can't read. */
  changes: { lines: ChangeLine[]; unreadable: number } | null;
  accounts: AdminAccount[] | null;
  jobs: JobView[] | null;
  /** What Home's Needs attention says of the nightly jobs. Never fail. */
  backup: BackupProblem | null;
  files: AttachmentSweepProblem | null;
  /** The ops routes, while open: by their variable or the stored switch.
   *  Null while closed, or while the switches can't be read and no variable
   *  decides. */
  ops: OpsOpen | null;
  facts: AdminFact[];
  /** The tax law tables by date (lib/law-card.ts), read from code, so never
   *  unreadable. */
  law: LawCard;
};

const ENVIRONMENT_WORDS = { production: 'Production', preview: 'Preview', development: 'Development' } as const;

/** One part of the page, or null when it can't be read (logged by name only:
 *  an error's message can carry what it was reading). */
async function part<T>(what: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    console.error(`Admin page: ${what} could not be read:`, err instanceof Error ? err.name : typeof err);
    return null;
  }
}

const count = (n: number) => n.toLocaleString('en-US');

/** The deployment's settings the page shows, through the readers the app
 *  itself uses, so the page says what the app does with them. */
export function adminFacts(): AdminFact[] {
  const quota = quotaBytes();
  const backups = backupRetention();
  return [
    { name: 'Plaid', variable: 'PLAID_ENV', value: process.env.PLAID_ENV || 'sandbox', about: 'The Plaid environment bank connections use.' },
    {
      name: 'Plaid webhooks',
      variable: 'PLAID_WEBHOOK_URL',
      value: webhooksEnabled() ? 'On' : 'Off',
      about: 'Plaid tells Nya when new data arrives. Off, Nya reads it again more often instead.',
    },
    {
      name: 'Sign-in',
      variable: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, CLERK_SECRET_KEY',
      value: clerkEnabled() ? 'Clerk' : 'App password',
      about: 'Clerk while both its keys are set; otherwise the app password, APP_PASSWORD.',
    },
    { name: 'Ops secret', variable: 'OPS_SECRET', value: process.env.OPS_SECRET ? 'Set' : 'Not set', about: 'What the ops routes ask for while they are on.' },
    {
      name: 'Stored transactions',
      variable: 'MAX_TXN_BLOB_CHARS',
      value: `${count(maxBlobChars())} characters`,
      about: 'The most one account’s stored transactions may take.',
    },
    {
      name: 'Unused connections',
      variable: 'PLAID_UNUSED_DAYS',
      value: `${count(unusedDays())} days`,
      about: 'How long a connection is unreadable, or every account in it hidden, before it is listed for review.',
    },
    {
      name: 'Receipts and documents',
      variable: 'ATTACHMENTS_QUOTA_MB',
      value: quota === null ? 'Off' : `${count(quota / (1024 * 1024))} MB`,
      about: quota === null ? 'The most each account may keep. Unset or not valid, so none can be added.' : 'The most each account may keep.',
    },
    {
      name: 'Backups kept',
      variable: 'BACKUP_KEEP_DAYS',
      value: backups === null ? 'Invalid' : backups.kept ? `${count(backups.keep_days)} days` : 'None',
      about:
        backups === null
          ? 'How long a nightly backup is kept. Not a whole number of days, so no backup runs.'
          : backups.kept
            ? 'How long a nightly backup is kept before it is pruned.'
            : 'How long a nightly backup is kept. No file store is connected, so none is taken.',
    },
  ];
}

/** Everything the admin page shows, for the admin (`admin`, from
 *  lib/admin-items.ts adminCtx). */
export async function readAdminPage(admin: Ctx, now: Date = new Date()): Promise<AdminPageData> {
  const environment = flagEnvironment();
  const [report, record, containers, jobs, backup, files] = await Promise.all([
    part('the feature switches', () => flagsStore.getAllReport()),
    part('the record of changes', () => flagsStore.changes()),
    part('the accounts', () => listContainers()),
    part('the nightly jobs', () => nightlyJobs(now)),
    backupNotice(now),
    attachmentSweepProblem(now),
  ]);
  const opsStored: FlagValue | null | 'unreadable' = report ? (report.unrecognised.includes('ops') ? 'unreadable' : (report.entries.get('ops') ?? null)) : 'unreadable';
  const ready = demoUsers();
  return {
    environment: ENVIRONMENT_WORDS[environment],
    freshSignIn: flagChangeNeedsFreshSignIn(),
    clerk: clerkEnabled(),
    demos: environment === 'production' ? null : DEMO_NAMES.map((label) => ({ label, set: ready.some((u) => u.label === label) })),
    rows: report ? switchRows(report, 'admin') : null,
    changes: record ? { lines: record.entries.map((c) => describeChange(c, admin.container)), unreadable: record.unrecognised.length } : null,
    accounts: containers ? adminAccounts(containers, admin.container) : null,
    jobs,
    backup,
    files,
    ops: opsOpen(opsStored),
    facts: adminFacts(),
    law: lawCard(now.toISOString().slice(0, 10)),
  };
}
