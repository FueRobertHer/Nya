import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { InfoPage, InfoSection } from '@/components/InfoPage';

export const metadata: Metadata = {
  title: 'Privacy · Nya',
  description: 'How Nya handles your data, in plain language.',
};

// How Nya handles personal data: its commitments, who processes the data, how
// long things are kept, and how to download and delete it. Public (proxy.ts)
// and a plain-language summary, not a legal policy: Nya has no legal entity
// and no counsel has reviewed it. Each commitment says what makes it true
// today and what is not built yet, and "being built" only where work is under
// way. test/public-pages.test.tsx holds the retention figures to the code.

type Commitment = {
  promise: string;
  today: ReactNode;
  next: { label: 'Being built' | 'Not built yet' | 'Not written yet' | 'Planned'; text: ReactNode };
};

const COMMITMENTS: Commitment[] = [
  {
    promise: 'We never sell or share your financial data.',
    today:
      'Nya shows no ads, uses no analytics or tracking tools, and sends your data only to the services listed under Who processes your data, each for the one job named there. Sharing with people you choose is up to you.',
    next: { label: 'Not written yet', text: 'A formal privacy policy that puts this in writing.' },
  },
  {
    promise: 'You can download everything stored about you, in open formats, whenever you like.',
    today:
      'Not yet. The only export today is the operator’s backup, which covers everyone on this copy of Nya and stays encrypted.',
    next: {
      label: 'Being built',
      text: 'Download my data, under Manage accounts: everything stored about you, as JSON. Files in CSV and OFX, and a way to bring the download into another copy of Nya, come later.',
    },
  },
  {
    promise: 'You can delete everything, and it reaches backups and connected services.',
    today:
      'Delete my account disconnects your banks at Plaid, deletes everything stored for you, ends all sharing and deletes your sign-in. Backups keep a copy for up to 30 days, and Plaid keeps its own until you delete it at Plaid.',
    next: {
      label: 'Not built yet',
      text: 'A key per person, so deleting your account makes your copies in backups unreadable at once, and a receipt that lists what was deleted, what expires when, and what stays and why.',
    },
  },
  {
    promise: 'You decide what anyone else sees, and you can see what they see about you.',
    today:
      'Nothing is shared until you choose, person by person and account by account, and hidden accounts are never shared. Sharing shows what each person can see of yours, and Remove or Block ends it at once.',
    next: {
      label: 'Not built yet',
      text: 'A preview of exactly what they see, shares that end on a date you set, and a record of when they looked.',
    },
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
    today: 'Nya has no AI features, and sends nothing to an AI provider.',
    next: { label: 'Planned', text: 'Reading receipts: off unless you turn it on, and only for the receipt you choose.' },
  },
  {
    promise: 'You can leave.',
    today: 'You can delete your account, and everything stored for you, at any time.',
    next: {
      label: 'Not built yet',
      text: 'The download (being built, above), a public API, and a license that lets anyone run their own copy of Nya. The code is public but has no license yet.',
    },
  },
];

const PROCESSORS: [string, string][] = [
  ['Vercel', 'Hosts the app and stores the nightly backups. Handles every request and response, and keeps the app’s logs.'],
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
];

const RETENTION: [string, string][] = [
  ['Your data', 'Until you delete it, or delete your account.'],
  [
    'A bank you disconnect',
    'Its transactions are deleted at once, except that for each one you recategorized, its date, amount and bank description are kept, encrypted, so the category carries across a reconnection. Its accounts’ balance history, names and the categories you set stay too, until you Forget them (Manage accounts, Earlier accounts) or delete your account.',
  ],
  ['Nightly backups', '30 days. The newest 7 are always kept, so if backups stop, the last ones remain.'],
  [
    'A deleted account',
    'Out of reach at once, and deleted from the database, apart from invite links you made that nobody used (your sign-in id and the name you gave), which expire within 72 hours. From backups as they age out, within 30 days. Plaid keeps what it collected under its own policy.',
  ],
  ['Invite links', '72 hours, or until used.'],
  [
    'Copies of what the dashboard shows',
    'Short-lived: used for 15 minutes, or up to 6 hours where Plaid is set up to say when new data arrives, and cleared whenever your data changes. Encrypted.',
  ],
  ['Sessions with the shared password', '30 days, or until you sign out everywhere.'],
  ['Sessions with Clerk accounts', 'As long as Clerk’s session settings for this copy of Nya allow.'],
  ['Failed password attempts, counted by IP address', '15 minutes.'],
  [
    'What your device keeps',
    'Your accounts, their balances and your net-worth history, as the app last showed them, until you sign out on that device, or it next finds you were signed out elsewhere.',
  ],
];

export default function PrivacyPage() {
  return (
    <InfoPage page="privacy" title="Privacy" intro="How Nya handles your data, in plain language.">
      <section className="card info-section info-notice">
        <p>This page is a plain-language summary, not a legal privacy policy.</p>
      </section>

      <h2>Our commitments</h2>
      {COMMITMENTS.map((c) => (
        <section className="card info-section" key={c.promise}>
          <h3>{c.promise}</h3>
          <dl className="info-status">
            <dt>True today</dt>
            <dd>{c.today}</dd>
            <dt>{c.next.label}</dt>
            <dd>{c.next.text}</dd>
          </dl>
        </section>
      ))}

      <InfoSection title="Who processes your data">
        <table className="info-table">
          <tbody>
            {PROCESSORS.map(([name, what]) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Not used yet: no billing provider, since Nya charges nothing yet, and no email provider, since Nya itself sends
          no email.
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
            {RETENTION.map(([what, howLong]) => (
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
          A per-person download is being built. It will appear under Manage accounts as Download my data, and give you
          everything stored about you as JSON. Until then there is no way to download your own data from the app.
        </p>
      </InfoSection>

      <InfoSection title="Delete your account">
        <p>
          If you sign in with your own account, open your account menu (your picture or initial, at the top right),
          choose Manage account, then Data &amp; privacy, and use Delete my account. It disconnects your banks at Plaid, deletes everything stored for you, ends
          all sharing both ways, and deletes your sign-in. It cannot be undone.
        </p>
        <ul>
          <li>Nightly backups keep a copy until it ages out, within 30 days.</li>
          <li>
            Invite links you made that nobody has used hold your sign-in id and the name you gave, and expire on their
            own within 72 hours.
          </li>
          <li>
            Plaid keeps its own record of the connections you made through it. To see what Plaid holds about you, or
            delete it, use the{' '}
            <a href="https://my.plaid.com" target="_blank" rel="noopener noreferrer">
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
