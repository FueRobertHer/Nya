import type { Metadata } from 'next';
import { InfoPage, InfoSection } from '@/components/InfoPage';
import { cspMode, type CspMode } from '@/lib/security-headers';

export const metadata: Metadata = {
  title: 'Security · Nya',
  description: 'How Nya protects your data, and who can read it.',
};

// How Nya protects data and who can read it, for anyone deciding whether to
// trust it (public: proxy.ts). Every statement must stay true of the code:
// docs/architecture.md and docs/operations.md are the sources, and
// test/public-pages.test.tsx holds the page to them and to the plan's list of
// things never to promise. Reads no stored data; the one thing it reads from
// the environment is how the Content-Security-Policy is sent.

const POLICY_STATE: Record<CspMode, string> = {
  enforce: 'This copy of Nya enforces it.',
  'report-only':
    'This copy of Nya is still checking it against live Plaid and Clerk sign-ins: for now browsers report anything it would block, without blocking it.',
  off: 'This copy of Nya has it switched off.',
};

const WHO_CAN_READ: [string, string][] = [
  [
    'The operator, who runs this copy of Nya',
    'Everything, in practice. The master key and the database password are kept in the same hosting environment, so the encryption does not protect against whoever controls it. A managed key service that records every use of the key is planned.',
  ],
  ['Upstash, the database', 'The encrypted values, and the plain text listed above.'],
  [
    'Vercel, the host',
    'Every request and response while the app handles it, the app’s logs, and the nightly backups, which it stores.',
  ],
  [
    'Plaid',
    'Your bank login, typed into Plaid’s window or your bank’s own page (Nya never sees it). Then your accounts, balances and transactions, and holdings and loan details where you have them, under Plaid’s own privacy policy.',
  ],
  [
    'Clerk, the sign-in service',
    'Your email address and your sign-in activity. Only when this copy of Nya uses Clerk accounts rather than a shared password.',
  ],
  [
    'People you share with',
    'Only what you choose, account by account: that it exists, its balance, or its balance and last 30 days of transactions. They can never change anything.',
  ],
  [
    'Your device',
    'The balances the app last showed, kept in the browser so it opens at once and works offline. Anyone using the unlocked device can read them. They are cleared when you sign out.',
  ],
];

export default function SecurityPage() {
  return (
    <InfoPage page="security" title="Security" intro="How Nya protects your data, and who can read it, including the limits.">
      <InfoSection title="In short">
        <ul>
          <li>
            Your balances, transactions, history, budgets, goals and the tokens that connect your banks are encrypted
            before they are stored.
          </li>
          <li>
            Some details around them are stored as plain text: dates, ids, the names of your banks, merchant names you
            renamed, and the names you and the people you share with gave each other.
          </li>
          <li>
            Nya is not encrypted end to end. Whoever runs Nya holds the keys, so they can read your data. The encryption
            protects against someone who gets the database or a backup without those keys.
          </li>
          <li>Bank connections work for US institutions only.</li>
          <li>No outside security audit has been done yet.</li>
        </ul>
      </InfoSection>

      <InfoSection title="How your data is encrypted">
        <p>
          Everything financial is encrypted with AES-256-GCM before it is written to the database: the tokens that
          connect your banks through Plaid, balances, net-worth history, transactions, budgets, goals, the categories and
          names you change, manual accounts, and the short-lived copies of what the dashboard last showed.
        </p>
        <p>
          It uses envelope encryption. Your data is encrypted with data keys that the app generates. Each data key is
          stored only in locked form, encrypted with a master key that is kept in the server’s environment settings,
          never in the database. Changing the master key locks the data keys again under the new one and leaves the data
          itself untouched, so a key change cannot damage it.
        </p>
        <p className="info-aside">
          Values written before the master key was set up stay under Nya’s original single key (also AES-256-GCM, also
          kept only in the environment) until they are moved to a data key. Today one set of data keys covers everyone
          on a copy of Nya; a key per person is planned.
        </p>
        <p>
          What this protects against: someone who gets a copy of the database or a backup, but not the keys. What it
          does not protect against: someone with access to the server’s environment, which holds both the master key
          and the database password. That includes whoever runs Nya.
        </p>
      </InfoSection>

      <InfoSection title="What is stored as plain text">
        <p>The values are encrypted; some of the structure around them is not. In the database and in backups, these are plain text:</p>
        <ul>
          <li>dates and times: which days have a recorded balance, and when things were saved;</li>
          <li>
            ids: of your accounts, transactions and bank connections (random strings from Plaid), and of your sign-in
            account;
          </li>
          <li>the names of the banks you linked;</li>
          <li>the merchant names you renamed (the new names you gave them are encrypted);</li>
          <li>
            for sharing: the names you and the people you connect with gave each other, and which accounts each of you
            shares at which level, never the balances or transactions themselves.
          </li>
        </ul>
        <p>Encrypting these as well is planned.</p>
      </InfoSection>

      <InfoSection title="Who can read what">
        <table className="info-table">
          <thead>
            <tr>
              <th scope="col">Who</th>
              <th scope="col">What they can read</th>
            </tr>
          </thead>
          <tbody>
            {WHO_CAN_READ.map(([who, what]) => (
              <tr key={who}>
                <th scope="row">{who}</th>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </InfoSection>

      <InfoSection title="Backups">
        <p>
          Every night the server copies the database to a private Vercel Blob store, and reads each copy back to check it
          before any older one is deleted. Copies are kept for 30 days. The newest 7 are always kept, so if backups ever
          stop, the last ones are not deleted.
        </p>
        <p>
          A backup holds the same kinds of data as the database: the encrypted values, the plain text listed above, and
          the data keys in their locked form. Its encrypted parts cannot be read without the keys kept in the server’s environment.
        </p>
      </InfoSection>

      <InfoSection title="Deleting your account">
        <p>
          If you sign in with your own account, Delete my account is in your account window: open your account menu
          (your picture or initial, at the top right), choose Manage account, then Data &amp; privacy. It disconnects
          each of your banks at Plaid, deletes
          everything stored for you, ends all sharing both ways, and deletes your sign-in. If it stops part way, your
          data is already out of reach, and running it again finishes the job.
        </p>
        <p>What it does not reach:</p>
        <ul>
          <li>Backups: your data stays in the nightly copies until they age out, within 30 days.</li>
          <li>
            Plaid’s own copy: Plaid keeps what it collected under its own policy. You can see and delete your connections
            at Plaid in the{' '}
            <a href="https://my.plaid.com" target="_blank" rel="noopener noreferrer">
              Plaid Portal
            </a>
            .
          </li>
          <li>The first account on a copy of Nya, the operator’s own, cannot be deleted from the app.</li>
          <li>With the shared password there is no delete button: the operator deletes the data.</li>
        </ul>
        <p>
          The <a href="/privacy">Privacy page</a> says how long everything else is kept.
        </p>
      </InfoSection>

      <InfoSection title="Signing in">
        <p>
          With Clerk accounts, Clerk runs the sign-in, and only people the operator has added can get in. Your account
          window lists the devices you are signed in on, and can sign any of them out.
        </p>
        <p>
          With the shared password, a correct password sets a signed cookie that the page’s scripts cannot read, sent
          only over HTTPS and good for 30 days. Sign out everywhere ends every session on every device, this one
          included, within seconds; changing the password does too. Each IP address gets 10 wrong passwords per 15
          minutes, then has to wait. If the database cannot be reached, that limit is skipped rather than locking
          everyone out.
        </p>
      </InfoSection>

      <InfoSection title="Security headers">
        <p>Every response from the app carries these headers:</p>
        <ul>
          <li>
            <code>Strict-Transport-Security</code>: browsers only connect to Nya over HTTPS, for two years after a visit.
          </li>
          <li>
            <code>X-Frame-Options: DENY</code>, and a <code>Content-Security-Policy</code> of{' '}
            <code>frame-ancestors &apos;none&apos;</code>: no other site can show Nya inside a frame.
          </li>
          <li>
            <code>X-Content-Type-Options: nosniff</code>: a file is only ever treated as the type it says it is.
          </li>
          <li>
            <code>Referrer-Policy: strict-origin-when-cross-origin</code>: other sites learn at most that you came from
            Nya, never which page (an invite link, say).
          </li>
          <li>
            <code>Permissions-Policy</code>: the camera, microphone, location, payments, USB and other device features
            Nya never uses are switched off.
          </li>
          <li>
            <code>Cross-Origin-Opener-Policy: same-origin-allow-popups</code>: a site that opens Nya gets no hold on its
            window, while your bank’s sign-in window, opened from Plaid, still works.
          </li>
        </ul>
        <p>
          Every page also carries a full <code>Content-Security-Policy</code>. A page may only run scripts that carry a
          one-time code issued with it, and the scripts those load, and may only load from and connect to Nya itself,
          Plaid, and, with Clerk accounts, Clerk and the bot check it uses. {POLICY_STATE[cspMode()]}
        </p>
      </InfoSection>

      <InfoSection title="Where bank connections work">
        <p>
          Bank connections go through Plaid and work for US institutions only: Nya asks Plaid for US institutions when
          you connect. Anything else, such as a bank in another country, an institution Plaid cannot reach, or a house or
          a car, can be tracked as a manual account: you enter the balance and update it when you like.
        </p>
      </InfoSection>
    </InfoPage>
  );
}
