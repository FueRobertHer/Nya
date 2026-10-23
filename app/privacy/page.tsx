import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { InfoPage, InfoSection } from '@/components/InfoPage';
import { backupRetention, databaseBackupDays } from '@/lib/backup';
import { masterKeyConfigured } from '@/lib/crypto';
import { backupDaysAtMost, keyDeletionText, PLAID_PORTAL, type BackupRetention } from '@/lib/deletion-receipt';
import { DOWNLOADS_PER_WINDOW } from '@/lib/download-limit';
import { ACCESS_LOG_DAYS, SHARED_READS_WINDOW_SECONDS } from '@/lib/share-rules';
import { sendsEmail } from '@/lib/notice-recipients';
import { RATE_WINDOW_SECONDS, API_AUTH_WINDOW_SECONDS, CHANGES_KEEP_DAYS, IDEMPOTENCY_HOURS } from '@/lib/api-limits';
import { apiWritesEnabled } from '@/lib/api-writes-enabled';
import { LINK_DAYS } from '@/lib/weekly-summary/unsubscribe';
import { restoreEnabled } from '@/lib/user-restore/enabled';
import { UNDO_DAYS } from '@/lib/user-restore/ids';

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
// receipt dates by, so the two never disagree, and DATABASE_BACKUP_DAYS; what
// it says of a data key per account, from whether a master key is set
// (lib/crypto.ts masterKeyConfigured) and keyDeletionText
// (lib/deletion-receipt.ts), as the security page says it; whether it names an email
// provider, or says a download is emailed, from sendsEmail()
// (lib/notice-recipients.ts): mail set up, and someone it may write to, which
// is whether this copy sends email at all; whether it offers bringing a
// download back, from RESTORE_ENABLED (lib/user-restore/enabled.ts).
// test/public-pages.test.tsx holds the figures to the code.

type Commitment = {
  promise: string;
  today: ReactNode;
  /** What is still to come, if anything. */
  next?: { label: 'Being built' | 'Not built yet' | 'Not written yet' | 'Planned' | 'Not turned on here'; text: ReactNode };
};

/** What happens to a deleted account's data in the nightly backups here. */
function deletedInBackups(backups: BackupRetention): string {
  if (backups === null) {
    return 'Nightly backups taken before a deletion keep a copy until their retention setting, which is not valid on this copy of Nya, is fixed and they are deleted in turn.';
  }
  if (!backups.kept) return 'This copy of Nya takes no backups, so no copy is left in one.';
  return `Nightly backups taken before a deletion keep a copy until they are deleted, within ${backupDaysAtMost(backups)} days while the nightly backup keeps running; if it stops, nothing is deleted until it runs again.`;
}

/** What the owner hears of a download (lib/download-notice.ts), as this copy
 *  is set up. */
const downloadEmail = (mail: boolean) =>
  mail
    ? 'Each download is emailed to you: when it happened and which format, never what is in it.'
    : 'This copy of Nya sends no email, so a download isn’t emailed to you.';

/** What the pages say of a data key per account, as this copy is set up. */
type Keys = ReturnType<typeof keyDeletionText>;

const commitments = (backups: BackupRetention, mail: boolean, keys: Keys, restore: boolean, writes: boolean): Commitment[] => [
  {
    promise: 'We never sell or share your financial data.',
    today:
      'Nya shows no ads, uses no analytics or tracking tools, and sends your data only to the services listed under Who processes your data, each for the one job named there. Sharing with people you choose is up to you.',
    next: { label: 'Not written yet', text: 'A formal privacy policy that puts this in writing.' },
  },
  {
    promise: 'You can download everything stored about you, in open formats, whenever you like.',
    today: `Download my data, under Manage on the Accounts tab, gives you everything stored about you, decrypted: one JSON file, CSV files of your transactions and of your balance history, or a bank account’s or card’s transactions as an OFX file for other money apps. You can protect any of them with a passphrase of your own, which Nya never keeps. If something stored can’t be read, the file names it, apart from a few sharing and bank-account records the app itself passes over. A fresh sign-in comes first, and each account can download ${DOWNLOADS_PER_WINDOW} times an hour. ${downloadEmail(mail)}${
      restore
        ? ' Bring back a download, beside it, brings a JSON download into an empty account, in this copy of Nya or another: the file is read in your browser and never stored.'
        : ''
    }`,
    ...(restore
      ? {}
      : {
          next: {
            label: 'Not turned on here' as const,
            text: 'Bringing a download into another copy of Nya, or into a new account: built, and off on this copy of Nya until whoever runs it turns it on.',
          },
        }),
  },
  {
    promise: 'You can delete everything, and it reaches backups and connected services.',
    today: `Delete my account disconnects your banks at Plaid, deletes everything stored for you, ends all sharing and deletes your sign-in, then gives you a receipt of what was deleted, what expires when, and what stays and why. ${deletedInBackups(backups)}${
      keys.key.length > 0
        ? ` ${keys.key.join(' ')}`
        : ' A data key per account, which makes your copies in backups unreadable once your account is deleted, needs a master key, which this copy of Nya doesn’t have set.'
    } Plaid keeps what it collected under its own policy; the receipt links to the Plaid Portal, where you can delete it.`,
    next: {
      label: 'Not built yet',
      text: 'Encrypting the details stored as plain text (dates, ids, bank names and the like), which stay readable in backups until they are deleted.',
    },
  },
  {
    promise: 'You decide what anyone else sees, and you can see what they see about you.',
    today:
      'Nothing is shared until you choose, person by person and account by account, and hidden accounts are never shared. Beyond accounts, you can choose to share your net worth, as an amount, and your spending by category, your holdings, your budgets or goals you pick, each as percentages or amounts, never the transactions behind them; a net worth lists no account whose balance you don’t share. Once you choose a home currency, what you share is shown in it, converted at the European Central Bank’s daily rates alone, never at your own rates, and they see that it is converted at those rates, never a rate itself; what only a rate of your own would convert is left out of what is converted, and named by its currency. If the European Central Bank doesn’t publish your home currency, what you share isn’t converted at all. Before you save, Sharing says what Nya knows they could work out from it all together (what your other accounts add up to beside your net worth, your income from your net worth and spending, what goes into a goal each month, and amounts from percentages beside an amount of the same money), and that this isn’t every way. For each person, Sharing shows a preview of exactly what they see of yours, and a record of each time it was shown to them. They see that same record, and you see theirs of each time what they share was shown to you; both records are in both of your downloads. A share can end on a date you set, which they see too. Remove or Block ends everything shared both ways at once and deletes both records, as does either of you deleting your account.',
  },
  {
    promise: 'You can see who can read what, including us.',
    today: (
      <>
        The <a href="/security">Security page</a> lists everyone who can read your data, what each can read, and what
        is stored without encryption. Your data, under Manage on the Accounts tab, lists each kind of thing Nya keeps
        about you: how much of it there is, whether it is encrypted and with which key, whether it is in your download,
        how long it is kept and who else can see it. It shows numbers only, never what is stored.
      </>
    ),
    next: {
      label: 'Not built yet',
      text: 'A managed key service that records every use of the master key, so access by whoever runs Nya leaves a trace.',
    },
  },
  {
    promise: 'AI features are opt-in and act only on what you point them at.',
    today: `Nya has no AI features of its own, and sends nothing to an AI provider unless you connect one. If you connect an AI assistant to Nya’s MCP server, with a token you make for it, it can read what that token reads (the Developers page lists it) until you revoke the token, and its provider keeps what it reads under its own terms.${
      writes
        ? ` With a token you make to make changes, it can also add, change and delete the transactions entered on your manual accounts, and add and change your manual accounts, categories and tags; it can be tricked into a change by something it reads, so each change is listed for you under API tokens for ${CHANGES_KEEP_DAYS} days, where most can be undone.`
        : ''
    }`,
    next: { label: 'Planned', text: 'Reading receipts: off unless you turn it on, and only for the receipt you choose.' },
  },
  {
    promise: 'You can leave.',
    today: (
      <>
        You can download everything stored about you, and delete your account and everything stored for you, at any time.
        {writes
          ? ' An API lets programs you choose, each with a token you can revoke, read your data whenever you like and, with a token made for it, add, change and delete the transactions entered on your manual accounts, and add and change your manual accounts, categories and tags (see the '
          : ' A read-only API lets programs you choose read your data whenever you like, with a token you can revoke (see the '}
        <a href="/developers">Developers page</a>).
      </>
    ),
    next: {
      label: 'Not built yet',
      text: `${writes ? 'Writing your bank’s transactions through the API' : 'Writing through the API'}, and a license that lets anyone run their own copy of Nya. The code is public but has no license yet.`,
    },
  },
];

/** What the database host's own backups keep, as DATABASE_BACKUP_DAYS says. */
function databaseBackups(days: number | null): string {
  if (days === null) return ' Its own backups of the database, if they are on, keep a copy for as long as its setting says, which couldn’t be worked out on this copy of Nya.';
  if (days > 0) return ` Its own backups of the database keep a copy for ${days === 1 ? '1 day' : `${days} days`}.`;
  return '';
}

const processors = (backups: BackupRetention, mail: boolean, dbDays: number | null, writes: boolean): [string, string][] => [
  [
    'Vercel',
    `${backups?.kept === false ? 'Hosts the app.' : 'Hosts the app and stores the nightly backups.'} Handles every request and response, and keeps the app’s logs.`,
  ],
  [
    'Upstash',
    `The database. Holds your data: the values that hold money encrypted, and the details listed on the Security page in plain text.${databaseBackups(dbDays)} Its own internal copies follow its own policy.`,
  ],
  [
    'Plaid',
    'Connects your banks. Sees your bank login (in Plaid’s window, never shown to Nya), then your accounts, balances and transactions, under Plaid’s own privacy policy.',
  ],
  [
    'SimpleFIN, if you connect it',
    'Only if you connect your own SimpleFIN account, which you pay SimpleFIN for (or another paid service that speaks its protocol, such as Redbark). It holds your bank connections, made through the provider it uses to reach banks, under its own terms, and sees when Nya asks. Nya keeps the read-only access it gives Nya, encrypted. About once a day Nya reads your accounts there, and keeps the balances and transactions of the ones you choose to track, and only the names of the others.',
  ],
  [
    'Lunch Flow, if you connect it',
    'Only if you connect your own Lunch Flow account, which you pay Lunch Flow for. It holds your bank connections, made through the providers it uses to reach banks (such as GoCardless, Akahu and MX), under its own terms, and sees when Nya asks and which of your accounts it asks about. Nya keeps the API key you give it, encrypted, and never shows it again. About once a day Nya reads your accounts there, and keeps the balances and transactions of the ones you choose to track, and only the names of the others.',
  ],
  [
    'Clerk',
    'Signs you in, when this copy of Nya uses accounts rather than a shared password. Holds your email address and sign-in activity, and your name and picture if you sign in with Google or another account, and may email you sign-in codes and invitations. Its bot check runs on Cloudflare (Turnstile), which sees your IP address and browser when it runs.',
  ],
  ...(mail
    ? ([
        [
          'Resend',
          `Sends the emails about your bank connections: one when a connection needs you, another only if what it needs from you changes, and one reminder a week later. And one each time your data is downloaded, brought back from a download (or that is undone) or emptied, or an API token is made${writes ? ' (saying what it can do)' : ''}, and the weekly summary, if you turn it on. Sees your email address and each email, which names the bank and what to do, or when and in which format your data was downloaded. The weekly summary tells it whether you spent more or less than in a usual week; the names of your budgets and categories that are over or close to their limit, and of your goals that are behind their target date or have reached their target; the bills and planned expenses due in the next seven days, by name, with their days and whether one is late; the banks that need you and what they need, and those whose transactions aren’t all in, with the day each last came in; the months that may be missing transactions, and why; how many of the week’s transactions from SimpleFIN or Lunch Flow have no category; and the currencies of transactions it didn’t count. Never a balance, an amount or an account number: a name of yours with a digit, a currency or percent sign, a number or a currency written as an English word (such as fifty, thousand or dollars), a number written as a Spanish, Portuguese, French, Italian or German word (such as diez mil or zehntausend; not their words for one, nor due, once, sept, seize, elf or null, which are English words too), or a letter outside the Latin alphabet in it is counted instead of named, as is one that looks like a link or an address (with ://, www., an @, or a word, a dot and two or more letters, as in example.com), and so is a bank’s name, as Plaid, SimpleFIN or Lunch Flow gives it, with a digit or a currency or percent sign. Resend keeps them under its own privacy policy.`,
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

/** How long the counts that limit how often something can be done last
 *  (lib/inventory.ts lists which), backups included: all but SimpleFIN's and
 *  Lunch Flow's are in them (test/inventory.test.ts holds that to the code). */
function countsRow(backups: BackupRetention): string {
  const kept =
    'Downloads of your data, looks at Your data, file imports and reads of the list of them, restores and the steps of one, and connecting to SimpleFIN or Lunch Flow and the requests made to them: each counted for its own window, an hour or a day from its first count, and then gone.';
  if (backups === null) {
    return `${kept} Nightly backups already taken keep a copy of all but those of SimpleFIN and Lunch Flow until their retention setting, which is not valid on this copy of Nya, is fixed and they are deleted in turn.`;
  }
  if (!backups.kept) return kept;
  return `${kept} Nightly backups keep a copy of all but those of SimpleFIN and Lunch Flow up to ${backupDaysAtMost(backups)} days more, while the nightly backup keeps running.`;
}

function backupsRow(backups: BackupRetention): string {
  if (backups === null) return 'None taken and none deleted while the retention setting is not valid.';
  if (!backups.kept) return 'None: no backup store is set up for this copy of Nya.';
  return `${backups.keep_days} days. The newest ${backups.min_kept} are always kept, so if backups stop, the last ones remain.`;
}

const retention = (backups: BackupRetention, mail: boolean, keys: Keys, writes: boolean): [string, string][] => [
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
  [
    'A download you brought back',
    'What it held is your data, kept as the rest is. A bank in it that was connected through Plaid keeps its transactions, encrypted, until you Forget it: they count once you connect it again and link its accounts (then as its own), or once you say the bank is gone (then as an ended account’s, up to the day you give). What you answer about it (that it is gone, which connections made since it isn’t at, which account carries it on) is kept with it, encrypted and in your download, until you Forget it, undo the restore, empty the account or delete it. An account from SimpleFIN or Lunch Flow you carry on with the one you track in its place keeps what it was, so undoing that puts it back. The record of the restore (when the file was made, its size, and how much came back) stays until you undo the restore, empty the account or delete it; the file itself is never stored.',
  ],
  [
    'A SimpleFIN connection',
    'The access SimpleFIN gave Nya, encrypted, never in your download and never in backups: until you disconnect it, or delete your account. Restoring a backup ends it: you connect again with a new Setup Token, and the accounts carry on. Its accounts and their transactions are kept like any account’s. Disconnecting deletes the access; you choose to keep the accounts as manual accounts, or to remove them and their transactions (their past balances stay in your net-worth history). A note of each account you stop tracking (its name, its bank and when) stays, so a report on a period it was tracked in can say what may be missing, until you forget it on the Reports page, or delete your account. SimpleFIN keeps what it holds under its own terms: remove Nya in your SimpleFIN account too.',
  ],
  [
    'A Lunch Flow connection',
    'The API key you gave Nya, encrypted, never in your download and never in backups: until you disconnect it, or delete your account. Restoring a backup ends it: you connect again with an API key, and the accounts carry on. Its accounts and their transactions are kept like any account’s. Disconnecting deletes the key; you choose to keep the accounts as manual accounts, or to remove them and their transactions (their past balances stay in your net-worth history). A note of each account you stop tracking stays as for SimpleFIN, until you forget it on the Reports page, or delete your account. Lunch Flow keeps what it holds under its own terms, and the key works there until you delete its API destination in Lunch Flow.',
  ],
  ['Nightly backups', backupsRow(backups)],
  [
    'A deleted account',
    `Out of reach at once, and deleted from the database, apart from invite links you made that nobody used (your sign-in id and the name you gave), which expire within 72 hours. ${deletedInBackups(backups)}${keys.key.length > 0 ? ` ${keys.key.slice(1).join(' ')}` : ''} Plaid keeps what it collected under its own policy.`,
  ],
  ...(keys.key.length > 0
    ? ([['A record that a deleted account existed', 'Its random id and the day its key was destroyed: kept for good, so that a restored backup never brings the account back.']] as [string, string][])
    : []),
  ['Invite links', '72 hours, or until used.'],
  ['Records of when shared accounts were shown', showingsRow(backups)],
  [
    'Copies of what the dashboard shows',
    'Short-lived: used for 15 minutes, or up to 6 hours where Plaid is set up to say when new data arrives, and cleared whenever your data changes. Encrypted.',
  ],
  [
    'The app’s own records about your data',
    'Locks, notes that a bank’s transactions grew too large to save or failed to save, the daily snapshot’s record of how each recent day went, when each day’s balances were taken and its checks on your connections, summaries and indexes kept beside your data, and how far longer jobs have got: until what they are about goes, or you delete your account. Your data, under Manage, says which of them are plain text.',
  ],
  ['Counts that limit how often you can do something', countsRow(backups)],
  [
    'API tokens',
    `Until you revoke them, or delete your account. Each is kept as its name, ${writes ? 'what it can do, ' : ''}the sign-in account that made it (with sign-in accounts), when it was made and last used, and a hash of its secret, all encrypted; the token itself is shown once and never stored. Signing out everywhere, or a change of the shared password, doesn’t end them. They are never in backups, so restoring one ends them all.`,
  ],
  [
    'Requests counted for each API token',
    `Its count for the current ${RATE_WINDOW_SECONDS}-second window, deleted when the token is revoked, or ${(2 * RATE_WINDOW_SECONDS) / 60} minutes after the last request made with any of your tokens.${
      writes
        ? ` For a token that can update balances or make changes, also its writes in the current minute and its changes in the current 24 hours (each counted from the first), and all your tokens’ changes in the current 24 hours, whether a token set each manual account’s balance in the current 24 hours, and a fingerprint of each key a program sent so that making something twice makes it once, kept ${IDEMPOTENCY_HOURS} hours: deleted when the token is revoked, or once their window is over. Never in backups.`
        : ''
    }`,
  ],
  ...(writes
    ? ([
        [
          'Changes made with API tokens',
          `${CHANGES_KEEP_DAYS} days, or until you delete your account: each change a token made, and each undo, when, which token, through the API or an AI assistant, and what it changed, before and after, encrypted, so a transaction a change deleted is kept with it for those ${CHANGES_KEEP_DAYS} days. Forgetting a change under API tokens removes what it changed, before and after, at once (and what its undo kept); its line, saying when, which token, what kind of change and the id of what it changed, stays for the ${CHANGES_KEEP_DAYS} days. A token that can make changes can read its own; tokens that only read can’t. In your download and in backups; never brought back with a download.`,
        ],
      ] as [string, string][])
    : []),
  [
    'The weekly summary',
    `Whether it is on, its day and your time zone: until you change them, or delete your account. Encrypted, and in your download. Beside them, encrypted too and kept until you delete your account, but not in your download: the key its links to turn it off are signed with, made anew each time you turn it on; the last week a summary went for, and one that got no answer from the email service; and which of your goals, by their ids, it last said had reached their target. Each link works for ${LINK_DAYS} days.`,
  ],
  [
    'Your home currency and your own exchange rates',
    'Until you change them, or delete your account. Encrypted, and in your download. Nothing converted is kept by Nya’s server: each figure is worked out again when it is shown (your device keeps the last ones it showed, with the rest of what the app last showed). The European Central Bank’s rates are public, kept once for everyone in plain text, and left out of Nya’s nightly backups.',
  ],
  ['Weekly summaries you asked for now, and uses of a link to turn one off', 'Counted for a day, and for an hour.'],
  ['Reads of what is shared with you, and of what someone sees of yours', `Counted for ${SHARED_READS_WINDOW_SECONDS / 60} minutes.`],
  ['Sessions with the shared password', '30 days, or until you sign out everywhere.'],
  ['Sessions with Clerk accounts', 'As long as Clerk’s session settings for this copy of Nya allow.'],
  ['Failed password attempts, counted by IP address', '15 minutes.'],
  ['Requests with API tokens, or links to turn off a weekly summary, that didn’t work, counted by IP address', `${API_AUTH_WINDOW_SECONDS / 60} minutes.`],
  [
    'What your device keeps',
    'Your accounts, their balances and your net-worth history, as the app last showed them, until you sign out on that device, or it next finds you were signed out elsewhere.',
  ],
];

export default function PrivacyPage() {
  const backups = backupRetention();
  const mail = sendsEmail();
  const dbDays = databaseBackupDays();
  const keys = keyDeletionText({ envelope: masterKeyConfigured(), backups, databaseDays: dbDays });
  const restore = restoreEnabled();
  // What tokens can do here: the wording about changes shows only where
  // they can make them (lib/api-writes-enabled.ts).
  const writes = apiWritesEnabled();
  return (
    <InfoPage page="privacy" title="Privacy" intro="How Nya handles your data, in plain language.">
      <section className="card info-section info-notice">
        <p>This page is a plain-language summary, not a legal privacy policy.</p>
      </section>

      <h2>Our commitments</h2>
      {commitments(backups, mail, keys, restore, writes).map((c) => (
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
            {processors(backups, mail, dbDays, writes).map(([name, what]) => (
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
        <p>
          Public data Nya uses: the exchange rates a home currency converts with are the European Central Bank’s euro reference rates, which
          Nya’s server downloads once a day, the same for everyone. The ECB is sent nothing about you, and can’t tell who uses them.
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
            {retention(backups, mail, keys, writes).map(([what, howLong]) => (
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
          your transactions or your balance history, each as a CSV file for a spreadsheet, or one bank account’s or
          card’s transactions as an OFX file, which other money apps import. The values come decrypted.
        </p>
        <p>
          A fresh sign-in comes first: with Clerk accounts, one from the last ten minutes, or Clerk asks you to confirm
          it is you; with the shared password, the password again. Each account can download {DOWNLOADS_PER_WINDOW} times
          an hour. {downloadEmail(mail)}
        </p>
        <p>
          Unless you protect it with a passphrase, the file itself is not encrypted, so keep it somewhere safe. Protected,
          it is saved encrypted in the age format: open it on the <a href="/open-download">Open a protected download</a>{' '}
          page, in your browser, without signing in and without the file leaving your device, or with the age app. Nya
          never keeps the passphrase, so a lost one can’t be recovered.
        </p>
        <p>
          The file leaves out the tokens that reach your banks, the access a SimpleFIN account gives Nya and the Lunch
          Flow API key you give it, which are credentials rather than your data, your API tokens themselves (each one’s
          name and dates are in), your sign-in, and other people’s data; the JSON file lists what it leaves out.
        </p>
        {restore && (
          <p>
            Bring back a download, beside it, brings a JSON download into an account with nothing in it yet, in this copy of
            Nya or another. The file is read in your browser and never stored: only what it holds is written, into your
            account, encrypted as the rest of your data is. A fresh sign-in comes first, and{' '}
            {mail ? 'starting one, undoing it and emptying an account are each emailed to you.' : 'this copy of Nya sends no email, so starting one isn’t emailed to you.'}{' '}
            Your banks’ access, your API tokens and sharing never come back: you connect, make and share them again. Undo,
            offered while a restore is unfinished and for {UNDO_DAYS} days after it finishes, empties the account again.
          </p>
        )}
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
          {keys.key.length > 0 && <li>{keys.key.join(' ')}</li>}
          {keys.notReached.length > 0 && (
            <li>
              What deleting your key doesn’t reach:{' '}
              {keys.notReached.map((line) => line.charAt(0).toLowerCase() + line.slice(1).replace(/\.$/, '')).join('; ')}.
            </li>
          )}
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
          <li>
            SimpleFIN keeps your bank connections under its own terms. Deleting your account deletes the access it gave
            Nya; to end it on SimpleFIN’s side too, remove Nya in your SimpleFIN account.
          </li>
          <li>
            Lunch Flow keeps your bank connections under its own terms. Deleting your account deletes the API key you gave
            Nya; to end it on Lunch Flow’s side too, delete its API destination in Lunch Flow.
          </li>
          <li>The first account on a copy of Nya, the operator’s own, cannot be deleted from the app.</li>
          <li>With the shared password there is no delete button: ask the operator.</li>
        </ul>
      </InfoSection>
    </InfoPage>
  );
}
