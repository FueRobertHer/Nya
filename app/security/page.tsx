import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { InfoPage, InfoSection } from '@/components/InfoPage';
import { cspMode, type CspMode } from '@/lib/security-headers';
import { masterKeyConfigured } from '@/lib/crypto';
import { backupRetention, databaseBackupDays } from '@/lib/backup';
import { KEY_GENERATIONS } from '@/lib/key-archive';
import { backupDaysAtMost, keyDeletionText, PLAID_PORTAL, type BackupRetention } from '@/lib/deletion-receipt';
import { sendsEmail } from '@/lib/notice-recipients';
import { REQUESTS_PER_MINUTE, RATE_WINDOW_SECONDS, API_AUTH_WINDOW_SECONDS } from '@/lib/api-limits';
import { DOWNLOADS_PER_WINDOW } from '@/lib/download-limit';
import { LINK_DAYS } from '@/lib/weekly-summary/unsubscribe';
import { SHARED_READS_WINDOW_SECONDS } from '@/lib/share-rules';
import { restoreEnabled } from '@/lib/user-restore/enabled';
import { UNDO_DAYS } from '@/lib/user-restore/ids';
import { apiWritesEnabled } from '@/lib/api-writes-enabled';
import { CHANGES_KEEP_DAYS, CHANGES_PER_DAY, PERSON_CHANGES_PER_DAY, WRITES_PER_MINUTE } from '@/lib/api-limits';

export const metadata: Metadata = {
  title: 'Security · Nya',
  description: 'How Nya protects your data, and who can read it.',
};

// How Nya protects data and who can read it, for anyone deciding whether to
// trust it (public: proxy.ts). Every statement must stay true of the code:
// docs/architecture.md and docs/operations.md are the sources, and
// test/public-pages.test.tsx holds the page to them and to the plan's list of
// things never to promise. Reads no stored data. From the environment it reads
// only how the Content-Security-Policy is sent, whether a master key is set
// (lib/crypto.ts), how backups are kept (lib/backup.ts backupRetention, the
// rule the deletion receipt uses too, and DATABASE_BACKUP_DAYS) and whether
// this copy sends email
// (sendsEmail in lib/notice-recipients.ts: mail set up, and someone it may
// write to, which also decides whether a download is emailed) and whether it
// offers bringing a download back (RESTORE_ENABLED, lib/user-restore/
// enabled.ts), and whether it lets API tokens make changes
// (API_WRITES_ENABLED, lib/api-writes-enabled.ts: off, the page says
// nothing of writing), since each changes what is true of this copy.

const LIMITS =
  'it may only run scripts that carry a one-time code issued with it, and the scripts those load, and may only load from and connect to Nya itself, Plaid and, with Clerk accounts, Clerk and the bot check it uses';

const POLICY: Record<CspMode, string> = {
  enforce: `Every page also carries a Content-Security-Policy, which this copy of Nya enforces: ${LIMITS}, and no other site may show it in a frame.`,
  'report-only': `Every page also carries a Content-Security-Policy, which this copy of Nya is still checking against live Plaid and Clerk sign-ins: browsers report anything it would block, and block nothing yet. Once it is enforced, ${LIMITS}.`,
  off: `Pages can also carry a Content-Security-Policy, under which ${LIMITS}. This copy of Nya has it switched off.`,
};

/** What programs with an API token can reach, as this copy lets them. */
const PROGRAMS_READ =
  'What the read-only API and the MCP server serve (the Developers page lists it): your accounts and balances, net worth and its history, the last year of transactions, budgets, recurring bills and holdings, until you revoke the token. Never your sign-in or your bank logins, and they can never change anything. An AI assistant you connect to the MCP server reads the same, and its provider keeps what it reads under its own terms.';
const PROGRAMS_WRITE =
  'What the API and the MCP server serve (the Developers page lists it): your accounts and balances, net worth and its history, the last year of transactions, budgets, recurring bills and holdings, until you revoke the token. Never your sign-in or your bank logins. A token made to read changes nothing; one made to update balances sees only your accounts and their balances and changes only a manual account’s balance; one made to make changes can add, change and delete the transactions entered on your manual accounts, add and change your manual accounts, categories and tags, and undo its own changes (an undo deletes what the change made, and an account it made goes with its transactions and its past balances), but never delete any other account, category or tag, and never change a bank’s transaction itself (though moving or renaming a category changes how every transaction in it is filed and counted). An AI assistant you connect to the MCP server reads the same, and its provider keeps what it reads under its own terms.';

const whoCanRead = (envelope: boolean, backups: BackupRetention, mail: boolean, writes: boolean): [string, string][] => [
  [
    'The operator, who runs this copy of Nya',
    `Everything, in practice. The ${envelope ? 'master key' : 'key'} and the database password are kept in the same hosting environment, so the encryption does not protect against whoever controls it. A managed key service that records every use of the key is planned.`,
  ],
  ['Upstash, the database', 'The encrypted values, and the plain text listed above.'],
  [
    'Vercel, the host',
    `Every request and response while the app handles it, and the app’s logs${backups?.kept === false ? '' : ', and the nightly backups, which it stores'}.`,
  ],
  [
    'Plaid',
    'Your bank login, typed into Plaid’s window or your bank’s own page (Nya never sees it). Then your accounts, balances and transactions, and holdings and loan details where you have them, under Plaid’s own privacy policy.',
  ],
  [
    'SimpleFIN, if you connect it',
    'Your bank connections, which you make and pay for in your own SimpleFIN account (or another paid service that speaks its protocol, such as Redbark), under its own terms, and when Nya reads your accounts there. Nya contacts only the host in the Setup Token you paste, to claim it, and the host of the access that claim returns, to read your accounts; never a private or internal address.',
  ],
  [
    'Lunch Flow, if you connect it',
    'Your bank connections, which you make and pay for in your own Lunch Flow account, under its own terms, and when Nya reads your accounts there and which ones. Nya sends the API key you paste only to Lunch Flow’s own address (lunchflow.app, and its www name), never to another host a redirect points to, and never to a private or internal address.',
  ],
  [
    'Clerk, the sign-in service',
    'Your email address and your sign-in activity, and your name and picture if you sign in with Google or another account. Its bot check runs on Cloudflare (Turnstile), which sees your IP address and browser when it runs. Only when this copy of Nya uses Clerk accounts rather than a shared password.',
  ],
  ...(mail
    ? ([
        [
          'Resend, the email service',
          `Your email address and the emails Nya sends you about your bank connections, each time your data is downloaded, brought back from a download (or that is undone) or emptied, or an API token is made${writes ? ' (saying what it can do)' : ''}, and, if you turn it on, the weekly summary: which bank needs you and what to do, when and in which format your data was downloaded, or, in the summary, whether you spent more or less than in a usual week, and the names of your budgets and categories over or close to their limit, your goals behind or at their target, the bills and planned expenses due in the next seven days with their days, and the banks that need you or whose transactions may be missing. Never a balance, an amount or an account number.`,
        ],
      ] as [string, string][])
    : []),
  ['Programs you give an API token to', writes ? PROGRAMS_WRITE : PROGRAMS_READ],
  [
    'People you share with',
    'Only what you choose, account by account: that it exists, its balance, or its balance and last 30 days of transactions; and, if you choose them, your net worth, as an amount, with only the accounts in it whose balances you share, and your spending by category, holdings, budgets or goals you pick, each as percentages or amounts, worked out from your data each time it is shown to them, never the transactions behind them; until the end date you set, if you set one. And your record of each time it was shown to them, the same one you see. They can never change anything.',
  ],
  [
    'Your device',
    'Your accounts, their balances and your net-worth history, as the app last showed them, kept in the browser so it opens at once and works offline. Anyone using the unlocked device can read them. They are cleared when you sign out.',
  ],
];

function Encryption({ envelope, writes }: { envelope: boolean; writes: boolean }): ReactNode {
  return (
    <>
      <p>
        These values are encrypted with AES-256-GCM before they are written to the database: the tokens that connect
        your banks through Plaid, the access your own SimpleFIN account gives Nya, the API key of your own Lunch Flow
        account, balances, net-worth history,
        transactions, budgets, goals, the categories you set and the names you give merchants, manual accounts, how
        each bank connection is doing, the records of when shared accounts were shown, {writes ? 'the record of changes made with API tokens, ' : ''}and the short-lived copies of
        what the dashboard last showed. Some details around them are not; they are listed below.
      </p>
      {envelope ? (
        <>
          <p>
            This copy of Nya uses envelope encryption. Those values are encrypted with data keys that the app generates.
            Each data key is stored only in locked form, encrypted with a master key that is kept in the server’s
            environment settings, never in the database. Changing the master key locks the data keys again under the new
            one and leaves the data itself untouched, so a key change cannot damage it.
          </p>
          <p>
            Each account made on this version of Nya normally has a data key of its own from the start, used for its data
            alone. An account made before it, or one made at a moment its key couldn’t be (while the master key is being
            changed, say), is under a set of data keys shared by everyone on this copy of Nya until whoever runs it moves
            the account to a key of its own. A value under one account’s key can’t be read as another’s, even copied into
            its place; values still under a shared key can, until they are moved.
          </p>
          <p className="info-aside">
            Values written before the master key was set up stay under Nya’s original single key (also AES-256-GCM, also
            kept only in the environment) until they are moved to a data key. If a shared data key ever cannot be used, a
            value is written under that original key and the server’s log says so. An account with a key of its own
            never falls back: if its key can’t be used, its data can’t be read or written on that server until it can.
          </p>
        </>
      ) : (
        <p>
          This copy of Nya encrypts them with one key, kept in the server’s environment settings, never in the database.
          Envelope encryption, where a master key locks separate data keys so that the key can be changed without
          touching the data, is built in but not turned on here.
        </p>
      )}
      <p>
        What this protects against: someone who gets a copy of the database or a backup, but not the keys. What it does
        not protect against: someone with access to the server’s environment, which holds both the{' '}
        {envelope ? 'master key' : 'key'} and the database password. That includes whoever runs Nya.
      </p>
    </>
  );
}

// How backups are kept here: none without a blob store; none taken or pruned
// while BACKUP_KEEP_DAYS is invalid (null); otherwise the receipt's rule.
function Backups({ backups, envelope }: { backups: BackupRetention; envelope: boolean }): ReactNode {
  if (backups === null) {
    return (
      <p>
        Nightly backups are set up for this copy of Nya, but their retention setting is not valid, so no backup is
        being taken, and no older one deleted, until whoever runs it fixes the setting.
      </p>
    );
  }
  if (!backups.kept) {
    return <p>This copy of Nya takes no backups: no backup store is set up for it, so nothing is copied out of the database.</p>;
  }
  return (
    <>
      <p>
        Every night the server copies the database to a private Vercel Blob store, and reads each copy back to check it
        before any older one is deleted. A copy is deleted once it is more than {backups.keep_days} days old, but the
        newest {backups.min_kept} are always kept, so if backups ever stop, the last ones are not deleted.
      </p>
      <p>
        A backup holds the same kinds of data as the database, apart from API tokens: the encrypted values and the plain
        text listed above{envelope ? ', and, in a file of their own kept beside it, the data keys in their locked form' : ''}. Its encrypted parts cannot be read
        without the keys kept in the server’s environment. API tokens are never backed up, so restoring a backup ends every
        token, and none revoked before it can work again. It never holds the access a SimpleFIN account gives Nya, which
        works on its own: restoring a backup ends that access, and you connect again with a new Setup Token. Nor does it
        hold a Lunch Flow API key, for the same reason: after a restore you connect again with one.
      </p>
      {envelope && (
        <p>
          The backups of the data keys are kept apart so that deleting an account can take its key out of every one of
          them without rewriting the data: the last {KEY_GENERATIONS} nights’ are kept, each checked before an older one is
          deleted. A key leaves them when the account it belongs to is deleted, or, for one that has gone from the
          database without that, once no backup still kept can need it.
        </p>
      )}
    </>
  );
}

function DeletedInBackups({ backups }: { backups: BackupRetention }): ReactNode {
  if (backups === null) {
    return (
      <li>
        Backups: copies taken before the deletion keep your data until the backup setting is fixed and they are
        deleted in turn.
      </li>
    );
  }
  if (!backups.kept) return null; // no backups here, so nothing to outlive the deletion
  return (
    <li>
      Backups: copies taken before the deletion keep your data until they are deleted, within{' '}
      {backupDaysAtMost(backups)} days while the nightly backup keeps running. If it stops, nothing is deleted until it
      runs again. The receipt gives the date.
    </li>
  );
}

export default function SecurityPage() {
  const envelope = masterKeyConfigured();
  const backups = backupRetention();
  const mail = sendsEmail();
  const keys = keyDeletionText({ envelope, backups, databaseDays: databaseBackupDays() });
  const restore = restoreEnabled();
  const writes = apiWritesEnabled();
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
          <li>
            Bank connections through Plaid work for US institutions only; your own SimpleFIN account, or your own Lunch
            Flow account where this copy of Nya offers it, may reach others.
          </li>
          <li>No outside security audit has been done yet.</li>
        </ul>
      </InfoSection>

      <InfoSection title="What is encrypted, and how">
        <Encryption envelope={envelope} writes={writes} />
      </InfoSection>

      <InfoSection title="What is stored as plain text">
        <p>The values are encrypted; some of the structure around them is not. In the database and in backups, these are plain text:</p>
        <ul>
          <li>dates and times: which days have a recorded balance, and when things were saved;</li>
          <li>
            ids: of your accounts, transactions and bank connections (random strings from Plaid, or made by Nya for
            manual accounts and a SimpleFIN or Lunch Flow connection), of your sign-in account, and of your API tokens
            (random, and not enough to use one);
          </li>
          <li>the names of the banks you linked, and whether Plaid included transactions when each connection was linked;</li>
          <li>the merchant names you renamed (the new names you gave them are encrypted);</li>
          <li>
            for sharing: the names you and the people you connect with gave each other, which accounts each of you
            shares at which level and until when, which of your net worth, spending, holdings, budgets and goals each
            of you shares, at which level (with the random ids of the goals chosen), and for each connection a random
            id, which its records of when shared accounts were shown are kept under, and when those records began (what
            they record is encrypted), never the balances, amounts or transactions themselves.
          </li>
          {writes && <li>for the record of changes made with API tokens: the day each change was made and which token made it (what it changed is encrypted).</li>}
        </ul>
        <p>
          The database also holds the IP address of a device that typed a wrong password, for up to 15 minutes; of a
          device that sent API tokens, or links to turn off a weekly summary, that didn’t work, for up to{' '}
          {API_AUTH_WINDOW_SECONDS / 60} minutes; and on the demo, that of a device that used a demo account, for up to 10
          minutes. These never go into backups. And for each API token, how many requests it made in the current minute,
          deleted when the token is revoked, or {(2 * RATE_WINDOW_SECONDS) / 60} minutes after the last request made with
          any of your tokens;{' '}
          {writes
            ? 'for a token that can update balances or make changes, its writes in the current minute and its changes in the current 24 hours, all your tokens’ changes in the current 24 hours, and the manual accounts whose balance a token set in the current 24 hours, by their ids, deleted when the token is revoked or the window ends; '
            : ''}
          and for the weekly summary, how many you asked to be sent now, kept for a day, and how many
          times a link to turn it off was used, kept for an hour. And how many times you read what is shared with you, or
          what someone sees of yours, kept for {SHARED_READS_WINDOW_SECONDS / 60} minutes.
        </p>
        <p>Encrypting these as well is planned.</p>
        <p>
          Your data, under Manage on the Accounts tab, lists what Nya keeps about you kind by kind: which of it is plain
          text, and which key the rest is encrypted with, your account’s own or one this copy of Nya shares.
        </p>
        <p>
          The database also keeps the European Central Bank’s exchange rates in plain text: public, the same for everyone, kept once for
          every account, and left out of Nya’s nightly backups. Every currency the ECB publishes is kept, so which ones are there says nothing about anyone.
          Your home currency and your own exchange rates are encrypted.
        </p>
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
            {whoCanRead(envelope, backups, mail, writes).map(([who, what]) => (
              <tr key={who}>
                <th scope="row">{who}</th>
                <td>{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </InfoSection>

      <InfoSection title="Backups">
        <Backups backups={backups} envelope={envelope} />
      </InfoSection>

      <InfoSection title="Deleting your account">
        <p>
          If you sign in with your own account, Delete my account is in your account window: open your account menu
          (your picture or initial, at the top right), choose Manage account, then Data &amp; privacy. It disconnects
          each of your banks at Plaid, deletes everything stored for you, ends all sharing both ways, and deletes your
          sign-in. If it stops part way, your data is already out of reach, and running it again finishes the job. It
          ends with a receipt, to copy or save: what was deleted, when the last backup holding your data is gone, and
          what stays and why.
        </p>
        {keys.key.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p>What it does not reach:</p>
        <ul>
          <DeletedInBackups backups={backups} />
          {keys.notReached.map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>
            Invite links you made that nobody has used: each holds your sign-in id and the name you gave, and expires on
            its own within 72 hours.
          </li>
          <li>
            Plaid’s own copy: Plaid keeps what it collected under its own policy. You can see and delete your connections
            at Plaid in the{' '}
            <a href={PLAID_PORTAL} target="_blank" rel="noopener noreferrer">
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

      <InfoSection title="API tokens">
        <p>
          {writes
            ? 'A token you make under API tokens lets a program read your data, and, if you choose when you make it, change some of it, through Nya’s API and its MCP server'
            : 'A token you make under API tokens lets a program read your data through Nya’s read-only API and its MCP server'}{' '}
          (see the <a href="/developers">Developers page</a>). Nya shows it once and never stores it: it keeps a SHA-256
          hash of the token’s secret, inside your own data and encrypted with it, and checks a token by comparing hashes
          in constant time. A token that doesn’t work gets the same answer whatever the reason (unknown, revoked, a wrong
          secret, or another person’s data), and one whose secret doesn’t match costs the same work whoever’s data it
          names, so a token can’t be used to find out whose data exists. Only a token whose secret checks out is told
          more: that its data is being restored, say, and to try again later. Requests with
          tokens that don’t work are counted by the address they come from, which is turned away for a while after too
          many.
        </p>
        {writes ? (
          <p>
            Making one needs a fresh sign-in, as downloading your data does. A token only reads, unless you chose when you
            made it that it may update manual accounts’ balances or make changes. That choice is kept with it and can never
            be widened, and a token never gains kinds of changes added to Nya after it was made. A token makes at most{' '}
            {REQUESTS_PER_MINUTE} requests a minute; one that can update balances or make changes at most{' '}
            {WRITES_PER_MINUTE} writes a minute and {CHANGES_PER_DAY} changes a day, with{' '}
            {PERSON_CHANGES_PER_DAY.toLocaleString('en-US')} changes a day for all your tokens. Every change to something
            that already exists, but a balance, names the version it was made from, so a program working from an old read
            can’t write over what you just did. Every change is recorded for {CHANGES_KEEP_DAYS} days under API tokens,
            with what it changed, where most can be undone or forgotten. A token works until you revoke it, even after Sign
            out everywhere or a change of the shared password; with sign-in accounts it stops when the account that made it
            is taken off the list of people allowed in. Deleting your account deletes every token with the rest of your
            data, and restoring a backup ends every token, since backups leave them out.
          </p>
        ) : (
          <p>
            Making one needs a fresh sign-in, as downloading your data does. A token can read but never change anything,
            and makes at most {REQUESTS_PER_MINUTE} requests a minute. It works until you revoke it, even after Sign out
            everywhere or a change of the shared password; with sign-in accounts it stops when the account that made it is
            taken off the list of people allowed in. Deleting your account deletes every token with the rest of your data,
            and restoring a backup ends every token, since backups leave them out.
          </p>
        )}
      </InfoSection>

      <InfoSection title="Downloading your data">
        <p>
          A download of your data needs a fresh sign-in, as making an API token does, and each account can download{' '}
          {DOWNLOADS_PER_WINDOW} times an hour.{' '}
          {mail
            ? 'Each download is emailed to you, so one you didn’t make shows.'
            : 'This copy of Nya sends no email, so a download isn’t emailed to you.'}{' '}
          The file is made as it is sent to your browser and never written anywhere on the way.
        </p>
        <p>
          You can protect it with a passphrase. It is then encrypted as it is sent, in the age format
          (age-encryption.org): a key made from your passphrase with scrypt, at the setting age itself uses, which makes
          each guess at it slow, locks a random key, and the file is encrypted with ChaCha20-Poly1305 in parts that each
          carry a check, so a file that was changed, cut short or put back together in another order doesn’t open. The
          passphrase is sent to Nya with the request, used for that, and never stored or logged. Nobody can recover a lost
          one.
        </p>
      </InfoSection>

      {restore && (
        <InfoSection title="Bringing a download back">
          <p>
            Bring back a download reads the file in your browser, a few megabytes at a time, and checks every part of it
            there; a protected one is opened there with its passphrase, which is never sent. Nya gets its records in
            batches, each with a SHA-256 checksum listed in the restore’s record before the first one is written, takes them
            only in that order and only if each matches, checks every record again before writing it into your account,
            encrypted as the rest of your data is, and keeps nothing of the file but what it holds: not the file, not a
            batch, not in a log.
          </p>
          <p>
            It needs a fresh sign-in, as a download does, and goes only into an account with nothing in it yet. Nothing in
            the file can bring back a credential: no access to a bank, no SimpleFIN or Lunch Flow access, no API token, no
            sharing.
            {mail ? ' Starting a restore, undoing one and emptying an account are each emailed to you.' : ''} While a
            restore hasn’t finished,{' '}
            {writes
              ? 'the API and the MCP server answer nothing from it and change nothing in it, and what you share answers nothing from it.'
              : 'the read-only API, the MCP server and what you share answer nothing from it.'} Undo, while a
            restore is unfinished and for {UNDO_DAYS} days after it finishes, empties the account again, as emptying it does:
            both need a fresh sign-in and are refused while a bank is connected, so a connection is never left running at
            Plaid, SimpleFIN or Lunch Flow.
          </p>
        </InfoSection>
      )}

      {mail && (
        <InfoSection title="The weekly summary">
          <p>
            If you turn it on, Nya emails you once a week what changed and what needs your attention. It never includes a
            balance, an amount, a percentage or an account number. It does name your budgets and categories over or close to
            their limit, your goals behind or at their target, the bills and planned expenses due in the next seven days, and
            the banks that need you or whose transactions may be missing, which the email service and your own email provider
            can read, as they can any email. A name of yours with a digit, a currency or percent sign, a number or a currency
            written as an English word (such as fifty, thousand or dollars), a number written as a Spanish, Portuguese,
            French, Italian or German word (such as diez mil or zehntausend; not their words for one, nor due, once, sept,
            seize, elf or null, which are English words too), or a letter outside the Latin alphabet in it is counted instead
            of named, as is one that looks like a link or an address (with ://, www., an @, or a word, a dot and two or more
            letters, as in example.com); a bank’s name, which comes from Plaid, SimpleFIN or Lunch Flow, only when it has a digit or a currency or percent
            sign. Before it goes, the whole email is checked again, and it isn’t sent if, outside its links, its own wording,
            the banks’ names and the currency codes it names, it holds a number other than one of its days or counts, a
            currency or percent sign, a number or a currency written as a word, or a letter outside the Latin alphabet.
          </p>
          <p>
            Each one has a link that turns it off without signing in. It works for {LINK_DAYS} days, can do nothing but turn
            off that summary, and is signed with a key kept in your own data, encrypted, and made anew each time you turn the
            summary on. Opening it only shows a page with a button. A link that doesn’t work gets the same answer whatever
            the reason, and reads the same things whoever’s data it names, so it can’t be used to find out whose data
            exists. Links that don’t work are counted by the address they come from, with API tokens that don’t work.
          </p>
        </InfoSection>
      )}

      <InfoSection title="Security headers">
        <p>Every response from the app carries these headers:</p>
        <ul>
          <li>
            <code>Strict-Transport-Security</code>: browsers only connect to Nya over HTTPS, for two years after a visit.
          </li>
          <li>
            <code>X-Frame-Options: DENY</code>: no other site can show Nya inside a frame.
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
        <p>{POLICY[cspMode()]}</p>
      </InfoSection>

      <InfoSection title="Where bank connections work">
        <p>
          Bank connections go through Plaid and work for US institutions only: Nya asks Plaid for US institutions when
          you connect. Anything else, such as a bank in another country, an institution Plaid cannot reach, or a house or
          a car, can be tracked as a manual account: you enter the balance in the account’s own currency, which you
          choose, and update it when you like.
        </p>
        <p>
          Your own SimpleFIN account may reach banks Plaid can’t (Redbark, a separate paid service that speaks the same
          protocol, covers Australia and New Zealand): you pay for it, connect your banks there, and paste a Setup Token
          into Nya. Nya exchanges the token, once, for read-only access, keeps that access encrypted, never writes it to a
          log, and asks for your accounts about once a day. It brings no pending transactions, no holdings and no
          categories.
        </p>
        <p>
          Where this copy of Nya offers it, your own Lunch Flow account may reach banks in other countries too: you pay
          Lunch Flow, connect your banks there, and paste the API key of an API destination into Nya. Nya checks the key with Lunch Flow once, keeps it
          encrypted, never writes it to a log or shows it again, and asks for your accounts about once a day. It brings
          no pending transactions, no holdings and no categories, and gives no date with a balance, so Nya shows the day
          it received each one.
        </p>
      </InfoSection>
    </InfoPage>
  );
}
