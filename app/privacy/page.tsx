import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { InfoPage, InfoSection } from '@/components/InfoPage';
import { backupRetention } from '@/lib/backup';
import { backupDaysAtMost, PLAID_PORTAL, type BackupRetention } from '@/lib/deletion-receipt';
import { DOWNLOADS_PER_WINDOW } from '@/lib/download-limit';
import { ACCESS_LOG_DAYS } from '@/lib/share-rules';
import { sendsEmail } from '@/lib/notice-recipients';
import { RATE_WINDOW_SECONDS, API_AUTH_WINDOW_SECONDS } from '@/lib/api-limits';

export const metadata: Metadata = {
  title: 'Privacy · Nya',
  description: 'How Nya handles your data, in plain language.',
};

// How Nya handles personal data: its commitments, who processes the data, how
// long things are kept, and how to download and delete it. Public (proxy.ts)
// and a plain-language summary, not a legal policy. Each commitment says what
// makes it true today and, where some of it is still to come, what is not
// built yet. Reads no stored data: what it says of backups comes from
// backupRetention() (lib/backup.ts, environment only), the rule the deletion
// receipt dates by, so the two never disagree, and whether it names an email
// provider from sendsEmail() (lib/notice-recipients.ts): mail set up, and
// someone it may write to, which is whether this copy sends email at all.
// test/public-pages.test.tsx holds the figures to the code.

type Commitment = {
  promise: string;
  today: ReactNode;
  /** What is still to come, if anything. */
  next?: { label: 'Being built' | 'Not built yet' | 'Not written yet' | 'Planned'; text: ReactNode };
};

/** What happens to a deleted account's data in the nightly backups here. */
function deletedInBackups(backups: BackupRetention): string {
  if (backups === null) {
    return 'Nightly backups taken before a deletion keep a copy until their retention setting, which is not valid on this copy of Nya, is fixed and they are deleted in turn.';
  }
  if (!backups.kept) return 'This copy of Nya takes no backups, so no copy is left in one.';
  return `Nightly backups taken before a deletion keep a copy until they are deleted, within ${backupDaysAtMost(backups)} days while the nightly backup keeps running; if it stops, nothing is deleted until it runs again.`;
}

const commitments = (backups: BackupRetention): Commitment[] => [
  {
    promise: 'We never sell or share your financial data.',
    today:
      'Nya shows no ads, uses no analytics or tracking tools, and sends your data only to the services listed under Who processes your data, each for the one job named there. Sharing with people you choose is up to you.',
    next: { label: 'Not written yet', text: 'A formal privacy policy that puts this in writing.' },
  },
  {
    promise: 'You can download everything stored about you, in open formats, whenever you like.',
    today: `Download my data, under Manage on the Accounts tab, gives you everything stored about you, decrypted, and names anything it couldn’t read: one JSON file, or CSV files of your transactions and of your balance history. A fresh sign-in comes first, and each account can download ${DOWNLOADS_PER_WINDOW} times an hour.`,
    next: {
      label: 'Not built yet',
      text: 'OFX files for other money apps, a passphrase to protect the file, a way to bring a download into another copy of Nya, and an email each time a download happens.',
    },
  },
  {
    promise: 'You can delete everything, and it reaches backups and connected services.',
    today: `Delete my account disconnects your banks at Plaid, deletes everything stored for you, ends all sharing and deletes your sign-in, then gives you a receipt of what was deleted, what expires when, and what stays and why. ${deletedInBackups(backups)} Plaid keeps what it collected under its own policy; the receipt links to the Plaid Portal, where you can delete it.`,
    next: {
      label: 'Not built yet',
      text: 'A key per person, so that deleting your account makes your copies in backups unreadable at once.',
    },
  },
  {
    promise: 'You decide what anyone else sees, and you can see what they see about you.',
    today:
      'Nothing is shared until you choose, person by person and account by account, and hidden accounts are never shared. For each person, Sharing shows a preview of exactly what they see of yours, and a record of each time it was shown to them. They see that same record, and you see theirs of each time what they share was shown to you; both records are in both of your downloads. A share can end on a date you set, which they see too. Remove or Block ends everything shared both ways at once and deletes both records, as does either of you deleting your account.',
  },
  {
    promise: 'You can see who can read what, including us.',
    today: (
      <>
        The <a href="/security">Security page</a> lists everyone who can read your data, what each can read, and what
        is stored without encryption.
      </>
    ),
    next: {
      label: 'Not built yet',
      text: 'A managed key service that records every use of the master key, so access by whoever runs Nya leaves a trace.',
    },
  },
  {
    promise: 'AI features are opt-in and act only on what you point them at.',
    today:
      'Nya has no AI features of its own, and sends nothing to an AI provider unless you connect one. If you connect an AI assistant to Nya’s MCP server, with a token you make for it, it can read what that token reads (the Developers page lists it) until you revoke the token, and its provider keeps what it reads under its own terms.',
    next: { label: 'Planned', text: 'Reading receipts: off unless you turn it on, and only for the receipt you choose.' },
  },
  {
    promise: 'You can leave.',
    today: (
      <>
        You can download everything stored about you, and delete your account and everything stored for you, at any time.
        A read-only API lets programs you choose read your data whenever you like, with a token you can revoke (see the{' '}
        <a href="/developers">Developers page</a>).
      </>
    ),
    next: {
      label: 'Not built yet',
      text: 'Writing through the API, a way to bring your download into another copy of Nya, and a license that lets anyone run their own copy of Nya. The code is public but has no license yet.',
    },
  },
];

const processors = (backups: BackupRetention, mail: boolean): [string, string][] => [
  [
    'Vercel',
    `${backups?.kept === false ? 'Hosts the app.' : 'Hosts the app and stores the nightly backups.'} Handles every request and response, and keeps the app’s logs.`,
  ],
  [
    'Upstash',
    'The database. Holds your data: the values that hold money encrypted, and the details listed on the Security page in plain text.',
  ],
  [
    'Plaid',
    'Connects your banks. Sees your bank login (in Plaid’s window, never shown to Nya), then your accounts, balances and transactions, under Plaid’s own privacy policy.',
  ],
  [
    'Clerk',
    'Signs you in, when this copy of Nya uses accounts rather than a shared password. Holds your email address and sign-in activity, and your name and picture if you sign in with Google or another account, and may email you sign-in codes and invitations. Its bot check runs on Cloudflare (Turnstile), which sees your IP address and browser when it runs.',
  ],
  ...(mail
    ? ([
        [
          'Resend',
          'Sends the emails about your bank connections: one when a connection needs you, another only if what it needs from you changes, and one reminder a week later. Sees your email address and each email, which names the bank and what to do, never a balance, an amount or an account number, and keeps them under its own privacy policy.',
        ],
      ] as [string, string][])
    : []),
];

/** How long the records of showings on a connection last (lib/access-log.ts),
 *  backups included. */
function showingsRow(backups: BackupRetention): string {
  const kept = `Each entry is deleted after ${ACCESS_LOG_DAYS} days, by a pass that runs every night, and both people’s records go at once when either of you removes or blocks the other, or deletes their account.`;
  if (backups === null) {
    return `${kept} Nightly backups already taken keep a copy until their retention setting, which is not valid on this copy of Nya, is fixed and they are deleted in turn.`;
  }
  if (!backups.kept) return `${kept} This copy of Nya takes no backups, so no copy is left in one.`;
  return `${kept} Nightly backups keep a copy up to ${backupDaysAtMost(backups)} days more, while the nightly backup keeps running.`;
}

function backupsRow(backups: BackupRetention): string {
  if (backups === null) return 'None taken and none deleted while the retention setting is not valid.';
  if (!backups.kept) return 'None: no backup store is set up for this copy of Nya.';
  return `${backups.keep_days} days. The newest ${backups.min_kept} are always kept, so if backups stop, the last ones remain.`;
}

const retention = (backups: BackupRetention, mail: boolean): [string, string][] => [
  ['Your data', 'Until you delete it, or delete your account.'],
  [
    'How each bank connection is doing',
    'When it last answered, Plaid’s warnings that it is going to end, and the record of a problem with it (when it began, what it was, and when you were emailed about it): until the connection is removed. The warnings and the problem records go sooner, once the connection works again. Encrypted, and in your download.',
  ],
  ...(mail
    ? ([['Emails Nya sent you', 'In your inbox, and with the email service under its own policy. Deleting your account does not reach them.']] as [string, string][])
    : []),
  [
    'A bank you disconnect',
    'Its transactions are deleted at once, except that for each one you recategorized, its date, amount and bank description are kept, encrypted, so the category carries across a reconnection. Its accounts’ balance history, names and the categories you set stay too, until you Forget them (Manage accounts, Earlier accounts) or delete your account.',
  ],
  ['Nightly backups', backupsRow(backups)],
  [
    'A deleted account',
    `Out of reach at once, and deleted from the database, apart from invite links you made that nobody used (your sign-in id and the name you gave), which expire within 72 hours. ${deletedInBackups(backups)} Plaid keeps what it collected under its own policy.`,
  ],
  ['Invite links', '72 hours, or until used.'],
  ['Records of when shared accounts were shown', showingsRow(backups)],
  [
    'Copies of what the dashboard shows',
    'Short-lived: used for 15 minutes, or up to 6 hours where Plaid is set up to say when new data arrives, and cleared whenever your data changes. Encrypted.',
  ],
  [
    'API tokens',
    'Until you revoke them, or delete your account. Each is kept as its name, the sign-in account that made it (with sign-in accounts), when it was made and last used, and a hash of its secret, all encrypted; the token itself is shown once and never stored. Signing out everywhere, or a change of the shared password, doesn’t end them. They are never in backups, so restoring one ends them all.',
  ],
  [
    'Requests counted for each API token',
    `Its count for the current ${RATE_WINDOW_SECONDS}-second window, deleted when the token is revoked, or ${(2 * RATE_WINDOW_SECONDS) / 60} minutes after the last request made with any of your tokens.`,
  ],
  ['Sessions with the shared password', '30 days, or until you sign out everywhere.'],
  ['Sessions with Clerk accounts', 'As long as Clerk’s session settings for this copy of Nya allow.'],
  ['Failed password attempts, counted by IP address', '15 minutes.'],
  ['Requests with API tokens that didn’t work, counted by IP address', `${API_AUTH_WINDOW_SECONDS / 60} minutes.`],
  [
    'What your device keeps',
    'Your accounts, their balances and your net-worth history, as the app last showed them, until you sign out on that device, or it next finds you were signed out elsewhere.',
  ],
];

export default function PrivacyPage() {
  const backups = backupRetention();
  const mail = sendsEmail();
  return (
    <InfoPage page="privacy" title="Privacy" intro="How Nya handles your data, in plain language.">
      <section className="card info-section info-notice">
        <p>This page is a plain-language summary, not a legal privacy policy.</p>
      </section>

      <h2>Our commitments</h2>
      {commitments(backups).map((c) => (
        <section className="card info-section" key={c.promise}>
          <h3>{c.promise}</h3>
          <dl className="info-status">
            <dt>True today</dt>
            <dd>{c.today}</dd>
            {c.next && (
              <>
                <dt>{c.next.label}</dt>
                <dd>{c.next.text}</dd>
              </>
            )}
          </dl>
        </section>
      ))}

      <InfoSection title="Who processes your data">
        <table className="info-table">
          <tbody>
            {processors(backups, mail).map(([name, what]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          {mail
            ? 'Not used yet: no billing provider, since Nya charges nothing yet.'
            : 'Not used yet: no billing provider, since Nya charges nothing yet, and no email provider, since this copy of Nya sends no email of its own.'}
        </p>
      </InfoSection>

      <InfoSection title="How long things are kept">
        <table className="info-table">
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">How long</th>
            </tr>
          </thead>
          <tbody>
            {retention(backups, mail).map(([what, howLong]) => (
              <tr key={what}>
                <th scope="row">{what}</th>
                <td>{howLong}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </InfoSection>

      <InfoSection title="Download your data">
        <p>
          On the Accounts tab, tap Manage, then Download my data at the bottom. Choose everything, as one JSON file, or
          your transactions or your balance history, each as a CSV file for a spreadsheet. The values come decrypted.
        </p>
        <p>
          A fresh sign-in comes first: with Clerk accounts, one from the last ten minutes, or Clerk asks you to confirm
          it is you; with the shared password, the password again. Each account can download {DOWNLOADS_PER_WINDOW} times
          an hour.
        </p>
        <p>
          The file itself is not encrypted, so keep it somewhere safe. It leaves out the tokens that reach your banks,
          which are credentials rather than your data, your API tokens themselves (each one’s name and dates are in), your
          sign-in, and other people’s data; the JSON file lists what it leaves out.
        </p>
      </InfoSection>

      <InfoSection title="Delete your account">
        <p>
          If you sign in with your own account, open your account menu (your picture or initial, at the top right),
          choose Manage account, then Data &amp; privacy, and use Delete my account. It disconnects your banks at Plaid,
          deletes everything stored for you, ends all sharing both ways, and deletes your sign-in. It cannot be undone. It
          ends with a receipt, to copy or save: what was deleted, when the last backup holding your data is gone, and what
          stays and why.
        </p>
        <ul>
          <li>
            {deletedInBackups(backups)}
            {backups?.kept ? ' The receipt gives the date.' : ''}
          </li>
          <li>
            Invite links you made that nobody has used hold your sign-in id and the name you gave, and expire on their
            own within 72 hours.
          </li>
          <li>
            Plaid keeps its own record of the connections you made through it. To see what Plaid holds about you, or
            delete it, use the{' '}
            <a href={PLAID_PORTAL} target="_blank" rel="noopener noreferrer">
              Plaid Portal (my.plaid.com)
            </a>
            .
          </li>
          <li>The first account on a copy of Nya, the operator’s own, cannot be deleted from the app.</li>
          <li>With the shared password there is no delete button: ask the operator.</li>
        </ul>
      </InfoSection>
    </InfoPage>
  );
}
