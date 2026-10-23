import { describe, expect, test, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import SecurityPage from '@/app/security/page';
import PrivacyPage from '@/app/privacy/page';
import { CoverageNote, TrustLinks } from '@/components/TrustLinks';
import { writingIn } from './writing-words';
import nextConfig from '@/next.config.js';
import { backupRetention, keepDays, MIN_KEPT } from '@/lib/backup';
import { backupDaysAtMost, buildDeletionReceipt, PLAID_PORTAL, type DeletionCounts } from '@/lib/deletion-receipt';
import { SESSION_MAX_AGE_SECONDS } from '@/lib/auth';
import { SHORT_TTL_SECONDS, WEBHOOK_TTL_SECONDS } from '@/lib/cache';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS } from '@/lib/rate-limit';
import { DEMO_WINDOW_SECONDS } from '@/lib/demo';
import { DOWNLOADS_PER_WINDOW } from '@/lib/download-limit';
import { ACCESS_LOG_DAYS, SHARED_READS_WINDOW_SECONDS } from '@/lib/share-rules';
import { RATE_WINDOW_SECONDS, REQUESTS_PER_MINUTE, API_AUTH_WINDOW_SECONDS } from '@/lib/api-limits';
import { LINK_DAYS } from '@/lib/weekly-summary/unsubscribe';
import { SENDS_NOW_WINDOW_SECONDS, UNSUBSCRIBE_WINDOW_SECONDS } from '@/lib/weekly-summary/store';

// The public pages make promises about the code. These tests hold them to it:
// every figure they state comes from the code, and none of them makes a claim
// the plan's "What not to promise" list rules out.

// lib/sharing.ts brings the Plaid client, which warns at import when no
// credentials are set. Nothing here calls Plaid, so placeholders, for the
// import alone, keep the output clean.
const { INVITE_HOURS, SHARED_TXN_DAYS } = await (async () => {
  const before = { ...process.env };
  process.env.PLAID_CLIENT_ID ||= 'placeholder';
  process.env.PLAID_SECRET ||= 'placeholder';
  try {
    return await import('@/lib/sharing');
  } finally {
    process.env = before;
  }
})();

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The page as text: tags dropped, the entities React writes decoded, spaces collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

const securityHtml = () => renderToStaticMarkup(<SecurityPage />);
const privacyHtml = () => renderToStaticMarkup(<PrivacyPage />);
const security = () => text(securityHtml());
const privacy = () => text(privacyHtml());

const DAYS = SESSION_MAX_AGE_SECONDS / 86400;
const LOGIN_WINDOW_MINUTES = LOGIN_WINDOW_SECONDS / 60;
const DEMO_WINDOW_MINUTES = DEMO_WINDOW_SECONDS / 60;
/** A usable master key: 32 bytes, base64. */
const MASTER = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
/** The privacy page's row for the records of when shared accounts were shown,
 *  up to what it says of backups. */
const SHOWINGS = `Records of when shared accounts were shown Each entry is deleted after ${ACCESS_LOG_DAYS} days, by a pass that runs every night, and both people’s records go at once when either of you removes or blocks the other, or deletes their account.`;

/** The three ways backups can be kept: none (no blob store), by BACKUP_KEEP_DAYS, or not at all while it is invalid. */
function backupsAre(state: 'none' | 'kept' | 'invalid', keep?: string) {
  if (state === 'none') delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_placeholder';
  if (state === 'invalid') process.env.BACKUP_KEEP_DAYS = 'a month';
  else if (keep) process.env.BACKUP_KEEP_DAYS = keep;
  else delete process.env.BACKUP_KEEP_DAYS;
}

/** Whether this copy sends email: with the shared password, both of Resend's
 *  settings and NOTIFY_EMAIL to write to, or none of them. */
function mailIs(on: boolean) {
  delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  delete process.env.CLERK_SECRET_KEY;
  if (on) {
    process.env.RESEND_API_KEY = 're_placeholder';
    process.env.MAIL_FROM = 'Nya <alerts@example.com>';
    process.env.NOTIFY_EMAIL = 'me@example.com';
  } else {
    delete process.env.RESEND_API_KEY;
    delete process.env.MAIL_FROM;
    delete process.env.NOTIFY_EMAIL;
  }
}

describe('never promised', () => {
  // The plan's "What not to promise", overclaims about what is encrypted, and
  // marketing words besides.
  const RULED_OUT: RegExp[] = [
    /can(?:not|'t|’t) read your data/i,
    /never see(?:s)? your data/i,
    /end-to-end encrypted/i,
    /exposes none/i,
    /deleted everywhere/i,
    /\binstant(?:ly)?\b/i,
    /everything\b[^.]{0,30}\bencrypted/i,
    /\ball (?:of )?your (?:financial )?data\b[^.]{0,30}\bencrypted/i,
    /your (?:financial )?data (?:is|are) encrypted/i,
    /(?:holds|stores|keeps) your (?:financial )?data encrypted/i,
    /encrypted like everything/i,
    /fully encrypted/i,
    /military|bank-(?:level|grade)|unhackable|100% secure|bulletproof/i,
    // Shared expenses (#49): Nya keeps the list, and the money moves elsewhere.
    /\bNya (?:sends|moves|holds|transfers) (?:your |the )?money\b/i,
    /\b(?:send|pay|request) money (?:through|with|in) Nya\b/i,
  ];

  test('the guard catches the phrasings it is there for', () => {
    for (const claim of [
      'Everything financial is encrypted with AES-256-GCM.',
      'Everything is encrypted.',
      'All your data is encrypted at rest.',
      'Holds your data encrypted.',
      'Encrypted like everything else.',
      'Nya sends money to your friends.',
      'Nya holds money until it is claimed.',
      'Request money with Nya.',
    ]) {
      expect(RULED_OUT.some((r) => r.test(claim))).toBe(true);
    }
  });

  test('neither page makes a claim the plan rules out, however this copy is set up', () => {
    for (const master of [undefined, MASTER]) {
      for (const backups of ['none', 'kept', 'invalid'] as const) {
        for (const mail of [false, true]) {
          process.env = { ...saved };
          if (master) process.env.MASTER_KEY = master;
          else delete process.env.MASTER_KEY;
          backupsAre(backups);
          mailIs(mail);
          for (const page of [security(), privacy()]) {
            for (const claim of RULED_OUT) expect(page).not.toMatch(claim);
          }
        }
      }
    }
  });

  test('says plainly that whoever runs Nya can read the data', () => {
    expect(security()).toContain('Nya is not encrypted end to end. Whoever runs Nya holds the keys, so they can read your data.');
    expect(security()).toMatch(/The operator, who runs this copy of Nya Everything, in practice\./);
  });

  test('no dashes of the kinds the house style rules out', () => {
    for (const page of [security(), privacy()]) expect(page).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('the security page', () => {
  test('lists what is encrypted, not "everything"', () => {
    expect(security()).toContain('These values are encrypted with AES-256-GCM before they are written to the database: the tokens');
    expect(security()).toContain('Some details around them are not; they are listed below.');
  });

  test('describes envelope encryption only where a master key is set', () => {
    backupsAre('kept');
    delete process.env.MASTER_KEY;
    let page = security();
    expect(page).toContain('This copy of Nya encrypts them with one key');
    expect(page).toContain('is built in but not turned on here');
    expect(page).not.toContain('uses envelope encryption');
    expect(page).not.toContain('data keys in their locked form');
    expect(page).toContain('which holds both the key and the database password');

    process.env.MASTER_KEY = MASTER;
    page = security();
    expect(page).toContain('This copy of Nya uses envelope encryption.');
    for (const fact of ['data keys', 'master key', 'leaves the data itself untouched', 'the server’s log says so', 'data keys in their locked form']) {
      expect(page).toContain(fact);
    }
    expect(page).not.toContain('not turned on here');
    expect(page).toContain('which holds both the master key and the database password');

    // A value that can't be a key is no master key: writes use the original key.
    process.env.MASTER_KEY = 'not-a-key';
    expect(security()).toContain('is built in but not turned on here');
  });

  test('lists what is stored as plain text, as docs/operations.md does', () => {
    const page = security();
    for (const item of ['dates and times', 'ids: of your accounts, transactions and bank connections', 'the names of the banks you linked, and whether Plaid included transactions when each connection was linked', 'the merchant names you renamed', 'for sharing: the names']) {
      expect(page).toContain(item);
    }
    // IP addresses, in the rate limiters' keys, which exports leave out.
    expect(page).toContain(`the IP address of a device that typed a wrong password, for up to ${LOGIN_WINDOW_MINUTES} minutes`);
    expect(page).toContain(`for up to ${DEMO_WINDOW_MINUTES} minutes. These never go into backups.`);
  });

  test('says Nya never moves money, and who sees the people you split costs with', () => {
    const page = security();
    expect(page).toContain('Nya never sends, receives or holds money, and keeps no payment app’s login, card or account number.');
    expect(page).toContain('and of the people you split costs with and your IOUs (random, made by Nya: their names, usernames and amounts are encrypted)');
    expect(page).toContain('Never the people you split costs with, what anyone owes, or a payment. They can never change anything.');
    expect(page).toContain('and your shared expenses, the one answer that names the people you split costs with');
    const priv = privacy();
    expect(priv).toContain('The people you split costs with under Shared expenses are never shown to anyone you share with, nor named in an email');
    expect(priv).toContain('Forget someone and their name and usernames are deleted, and the amounts stay.');
    expect(priv).toContain('The people you split costs with, and what is owed Until you remove it, or delete your account');
  });

  test('names everyone who can read anything, and what', () => {
    const page = security();
    for (const who of ['The operator', 'Upstash', 'Vercel', 'Plaid', 'Clerk', 'People you share with', 'Your device']) {
      expect(page).toContain(who);
    }
    expect(page).toContain(
      `last ${SHARED_TXN_DAYS} days of transactions; and, if you choose them, your net worth, as an amount, with only the accounts in it whose balances you share, and your spending by category, holdings, budgets or goals you pick, each as percentages or amounts, worked out from your data each time it is shown to them, never the transactions behind them; until the end date you set, if you set one.`
    );
    expect(page).toContain('your name and picture if you sign in with Google or another account');
    expect(page).toContain('Cloudflare (Turnstile), which sees your IP address and browser');
    // The device keeps more than balances (components/Dashboard.tsx saves the whole snapshot).
    expect(page).toContain('Your accounts, their balances and your net-worth history, as the app last showed them');
  });

  test('sharing: what is encrypted, what is plain text, and who reads the records of when it was shown', () => {
    const page = security();
    expect(page).toContain('manual accounts, how each bank connection is doing, the records of when shared accounts were shown, and the short-lived copies');
    expect(page).toContain(
      'which accounts each of you shares at which level and until when, which of your net worth, spending, holdings, budgets and goals each of you shares, at which level (with the random ids of the goals chosen), and for each connection a random id, which its records of when shared accounts were shown are kept under, and when those records began (what they record is encrypted), never the balances, amounts or transactions themselves.'
    );
    expect(page).toContain('until the end date you set, if you set one. And your record of each time it was shown to them, the same one you see. Never the people you split costs with, what anyone owes, or a payment. They can never change anything.');
    // Deleting an account deletes both sides' records, so nothing of them stays with anyone.
    expect(page).not.toContain('doesn’t name you');
    expect(page).not.toMatch(/when you looked/);
  });

  test('how a download is protected: the fresh sign-in, the limit, and a passphrase in the age format', () => {
    const page = security();
    expect(page).toContain(`A download of your data needs a fresh sign-in, as making an API token does, and each account can download ${DOWNLOADS_PER_WINDOW} times an hour.`);
    expect(page).toContain('It is then encrypted as it is sent, in the age format (age-encryption.org)');
    expect(page).toContain('so a file that was changed, cut short or put back together in another order doesn’t open.');
    expect(page).toContain('The passphrase is sent to Nya with the request, used for that, and never stored or logged. Nobody can recover a lost one.');
  });

  test('deletion, sessions and the login limit, with the figures the code uses', () => {
    const page = security();
    expect(page).toContain('Delete my account');
    expect(page).toContain('It ends with a receipt, to copy or save');
    expect(page).toContain(`Invite links you made that nobody has used: each holds your sign-in id and the name you gave, and expires on its own within ${INVITE_HOURS} hours.`);
    expect(page).toContain(`good for ${DAYS} days`);
    expect(page).toContain('Sign out everywhere');
    expect(page).toContain(`${LOGIN_MAX_FAILURES} wrong passwords per ${LOGIN_WINDOW_MINUTES} minutes`);
    expect(securityHtml()).toContain(`href="${PLAID_PORTAL}"`);
  });

  test('describes every header the app sends (next.config.js)', async () => {
    const page = security();
    const [rule] = await nextConfig.headers!();
    for (const { key } of rule.headers) expect(page).toContain(key);
    expect(page).toContain('X-Frame-Options: DENY : no other site can show Nya inside a frame.');
  });

  test('says how this copy sends its Content-Security-Policy, in words that fit the mode', () => {
    delete process.env.CSP_MODE;
    const reportOnly = security();
    expect(reportOnly).toContain('which this copy of Nya is still checking against live Plaid and Clerk sign-ins');
    expect(reportOnly).toContain('block nothing yet. Once it is enforced, it may only run scripts');

    process.env.CSP_MODE = 'enforce';
    expect(security()).toContain('which this copy of Nya enforces: it may only run scripts');

    process.env.CSP_MODE = 'off';
    const off = security();
    expect(off).toContain('This copy of Nya has it switched off.');
    expect(off).not.toContain('Every page also carries');
  });

  test('says where bank connections work, and that a manual account is in a currency of its own', () => {
    const page = security();
    expect(page).toContain('work for US institutions only');
    expect(page).toContain('you enter the balance in the account’s own currency, which you choose');
    expect(page).toContain('Your own SimpleFIN account may reach banks Plaid can’t');
    expect(page).toContain('Redbark, a separate paid service');
    expect(page).toContain('It brings no pending transactions, no holdings and no categories');
  });

  test('names SimpleFIN as a processor only you choose, what it sees, and what Nya keeps of it', () => {
    const priv = privacy();
    expect(priv).toContain('SimpleFIN, if you connect it');
    expect(priv).toContain('the read-only access it gives Nya, encrypted');
    expect(priv).toContain('A SimpleFIN connection');
    expect(priv).toContain('remove Nya in your SimpleFIN account');
    const sec = security();
    expect(sec).toContain('SimpleFIN, if you connect it');
    expect(sec).toContain('the access your own SimpleFIN account gives Nya');
    // Both hosts Nya contacts, and never a backup of the access.
    expect(sec).toContain('the host in the Setup Token you paste, to claim it, and the host of the access that claim returns');
    expect(priv).toContain('never in your download and never in backups: until you disconnect it, or delete your account');
    try {
      backupsAre('kept');
      expect(security()).toContain('It never holds the access a SimpleFIN account gives Nya, which works on its own: restoring a backup ends that access');
    } finally {
      backupsAre('none');
    }
  });
});

describe('backups, on both pages, by the rule the deletion receipt dates by', () => {
  const COUNTS: DeletionCounts = {
    banks_disconnected: 0,
    banks_not_disconnected: 0,
    accounts: 0,
    earlier_accounts: 0,
    transactions: 0,
    investment_transactions: 0,
    history_days: 0,
    connections_ended: 0,
    sign_in_deleted: true,
  };
  /** Days from a deletion to the date its receipt gives for the last backup copy. */
  const receiptDays = () => {
    const receipt = buildDeletionReceipt({ counts: COUNTS, found_data: true, resumed: false, deleted_at: new Date(0), retention: backupRetention(), stopped: false });
    return receipt.backups?.kept ? Date.parse(receipt.backups.until) / 86_400_000 : null;
  };

  test('with a blob store: the days kept and the newest kept, from the code', () => {
    for (const keep of [undefined, '90', '3']) {
      backupsAre('kept', keep);
      const r = backupRetention();
      if (!r?.kept) throw new Error('expected backups to be kept');
      expect(r.keep_days).toBe(keepDays());
      expect(r.min_kept).toBe(MIN_KEPT);
      const within = backupDaysAtMost(r);
      // The same number of days a receipt gives, for every setting.
      expect(within).toBe(receiptDays()!);

      const sec = security();
      expect(sec).toContain(`A copy is deleted once it is more than ${keepDays()} days old, but the newest ${MIN_KEPT} are always kept, so if backups ever stop, the last ones are not deleted.`);
      expect(sec).toContain(`Backups: copies taken before the deletion keep your data until they are deleted, within ${within} days while the nightly backup keeps running. If it stops, nothing is deleted until it runs again.`);
      expect(sec).toContain('and the nightly backups, which it stores');

      const priv = privacy();
      expect(priv).toContain(`Nightly backups ${keepDays()} days. The newest ${MIN_KEPT} are always kept, so if backups stop, the last ones remain.`);
      expect(priv).toContain(`keep a copy until they are deleted, within ${within} days while the nightly backup keeps running; if it stops, nothing is deleted until it runs again.`);
      expect(priv).toContain('The receipt gives the date.');
      expect(priv).toContain('Hosts the app and stores the nightly backups.');
      expect(priv).toContain(`${SHOWINGS} Nightly backups keep a copy up to ${within} days more, while the nightly backup keeps running.`);
    }
  });

  test('without a blob store: no backups, said plainly, and no figure', () => {
    backupsAre('none');
    expect(backupRetention()).toEqual({ kept: false });
    const sec = security();
    expect(sec).toContain('This copy of Nya takes no backups: no backup store is set up for it');
    expect(sec).not.toContain('Every night the server copies');
    expect(sec).not.toContain('Backups: copies taken before the deletion');
    expect(sec).not.toContain('nightly backups, which it stores');
    const priv = privacy();
    expect(priv).toContain('Nightly backups None: no backup store is set up for this copy of Nya.');
    expect(priv).toContain('This copy of Nya takes no backups, so no copy is left in one.');
    expect(priv).toContain(`${SHOWINGS} This copy of Nya takes no backups, so no copy is left in one.`);
    expect(priv).toContain('Vercel Hosts the app. Handles every request');
    expect(priv).not.toMatch(/within \d+ days/);
  });

  test('with BACKUP_KEEP_DAYS invalid: no backup taken or deleted, and no figure', () => {
    backupsAre('invalid');
    expect(backupRetention()).toBeNull();
    const sec = security();
    expect(sec).toContain('their retention setting is not valid, so no backup is being taken, and no older one deleted');
    expect(sec).toContain('Backups: copies taken before the deletion keep your data until the backup setting is fixed');
    const priv = privacy();
    expect(priv).toContain('Nightly backups None taken and none deleted while the retention setting is not valid.');
    expect(priv).toContain('until their retention setting, which is not valid on this copy of Nya, is fixed');
    expect(priv).toContain(`${SHOWINGS} Nightly backups already taken keep a copy until their retention setting, which is not valid on this copy of Nya, is fixed and they are deleted in turn.`);
    for (const page of [sec, priv]) expect(page).not.toMatch(/within \d+ days|up to \d+ days more/);
  });
});

describe('the privacy page', () => {
  test('says first that it is a plain-language summary, not a legal policy, and nothing of internal plans', () => {
    const page = privacy();
    expect(page.indexOf('This page is a plain-language summary, not a legal privacy policy.')).toBeGreaterThan(-1);
    expect(page.indexOf('not a legal privacy policy')).toBeLessThan(page.indexOf('Our commitments'));
    expect(page).not.toContain('legal entity');
    expect(page).not.toContain('lawyer');
  });

  test('makes the eight commitments, each with what is true today and, where some of it is to come, what is not', () => {
    const html = privacyHtml();
    const promises = [
      'We never sell or share your financial data.',
      'You can download everything stored about you, in open formats, whenever you like.',
      'You can delete everything, and it reaches backups and connected services.',
      'You decide what anyone else sees, and you can see what they see about you.',
      'You can see who can read what, including us.',
      'Receipts and documents are never shared.',
      'AI features are opt-in and act only on what you point them at.',
      'You can leave.',
    ];
    for (const promise of promises) expect(text(html)).toContain(promise);
    expect(html.match(/<dt>True today<\/dt>/g)).toHaveLength(promises.length);
    // The download and the receipt exist now: nothing is "being built".
    expect(html).not.toContain('<dt>Being built</dt>');
    expect(text(html)).not.toMatch(/being built/i);
  });

  test('describes the download and the deletion receipt as they are', () => {
    const page = privacy();
    expect(page).toContain(
      `True today Download my data, in Settings under Your data and privacy, gives you everything stored about you, decrypted: one JSON file, CSV files of your transactions and of your balance history, or a bank account’s or card’s transactions as an OFX file for other money apps. You can protect any of them with a passphrase of your own, which Nya never keeps. If something stored can’t be read, the file names it, apart from a few sharing and bank-account records the app itself passes over. A fresh sign-in comes first, and each account can download ${DOWNLOADS_PER_WINDOW} times an hour.`
    );
    expect(page).toContain('Open Settings (the account menu, or the gear), then Your data and privacy, then Download my data.');
    expect(page).toContain(`Each account can download ${DOWNLOADS_PER_WINDOW} times an hour.`);
    expect(page).toContain('Unless you protect it with a passphrase, the file itself is not encrypted, so keep it somewhere safe.');
    expect(page).toContain('Nya never keeps the passphrase, so a lost one can’t be recovered.');
    expect(privacyHtml()).toContain('href="/open-download"');
    expect(page).toContain('then gives you a receipt of what was deleted, what expires when, and what stays and why.');
    expect(page).toContain('It ends with a receipt, to copy or save');
    expect(page).not.toContain('Until then there is no way to download');
  });

  // Built now: OFX, the passphrase, the email, and bringing a download back,
  // which says whether this copy of Nya has turned it on (RESTORE_ENABLED).
  test('says bringing a download back is built, and whether this copy has turned it on', () => {
    const card = () => {
      const html = privacyHtml();
      return text(html.slice(html.indexOf('You can download everything stored about you'), html.indexOf('You can delete everything')));
    };
    const saved = process.env.RESTORE_ENABLED;
    try {
      delete process.env.RESTORE_ENABLED;
      expect(card()).toContain('Not turned on here Bringing a download into another copy of Nya, or into a new account: built, and off on this copy of Nya until whoever runs it turns it on.');
      expect(card()).not.toContain('Not built yet');
      expect(card()).not.toMatch(/OFX files for other money apps, a passphrase|an email each time a download happens\./);
      expect(security()).not.toContain('Bringing a download back');
      process.env.RESTORE_ENABLED = '1';
      expect(card()).toContain('Bring back a download, beside it, brings a JSON download into an empty account, in this copy of Nya or another: the file is read in your browser and never stored.');
      expect(card()).not.toContain('Not turned on here');
      expect(privacy()).toContain('The file is read in your browser and never stored: only what it holds is written, into your account, encrypted as the rest of your data is.');
      expect(security()).toContain('Bring back a download reads the file in your browser, a few megabytes at a time, and checks every part of it there');
      expect(security()).toContain('Undo, while a restore is unfinished and for 7 days after it finishes, empties the account again, as emptying it does');
      expect(security()).toContain('no SimpleFIN or Lunch Flow access');
      expect(security()).toContain('never left running at Plaid, SimpleFIN or Lunch Flow.');
      expect(privacy()).toContain('Undo, offered while a restore is unfinished and for 7 days after it finishes, empties the account again.');
      expect(privacy()).toContain('they count once you connect it again and link its accounts (then as its own), or once you say the bank is gone (then as an ended account’s, up to the day you give)');
      expect(privacy()).toContain('What you answer about it (that it is gone, which connections made since it isn’t at, which account carries it on) is kept with it, encrypted and in your download');
      expect(security()).toContain('A bank brought back from Plaid counts before you link it only on your answer, never inferred');
      expect(security()).toContain('so a bank connected again doesn’t count them twice before you answer');
      expect(security()).not.toContain('never counted twice');
      expect(security()).toContain('is asked of you while one waits, never assumed, says what it matched, and can be undone.');
    } finally {
      if (saved === undefined) delete process.env.RESTORE_ENABLED;
      else process.env.RESTORE_ENABLED = saved;
    }
    // Kept as the rest of the data is, the file itself never.
    expect(privacy()).toContain('A download you brought back What it held is your data, kept as the rest is.');
  });

  test('says a download is emailed only where this copy sends email', () => {
    mailIs(true);
    expect(privacy()).toContain('Each download is emailed to you: when it happened and which format, never what is in it.');
    expect(privacy()).toContain('And one each time your data is downloaded, brought back from a download (or that is undone) or emptied, or an API token is made, and the weekly summary, if you turn it on.');
    expect(security()).toContain('Each download is emailed to you, so one you didn’t make shows.');
    expect(security()).toContain(
      'each time your data is downloaded, brought back from a download (or that is undone) or emptied, or an API token is made, and, if you turn it on, the weekly summary: which bank needs you and what to do, when and in which format your data was downloaded, or, in the summary, whether you spent more or less than in a usual week, and the names of your budgets and categories over or close to their limit, your goals behind or at their target, the bills and planned expenses due in the next seven days with their days, and the banks that need you or whose transactions may be missing. Never a balance, an amount or an account number.'
    );
    mailIs(false);
    for (const page of [privacy(), security()]) {
      expect(page).toContain('This copy of Nya sends no email, so a download isn’t emailed to you.');
      expect(page).not.toContain('Each download is emailed to you');
    }
  });

  test('the count of reads of what is shared: plain text, kept for the length of its window', () => {
    expect(security()).toContain(`And how many times you read what is shared with you, or what someone sees of yours, kept for ${SHARED_READS_WINDOW_SECONDS / 60} minutes.`);
    expect(privacy()).toContain(`Reads of what is shared with you, and of what someone sees of yours Counted for ${SHARED_READS_WINDOW_SECONDS / 60} minutes.`);
  });

  test('describes sharing as it is: the preview, ends, and both records of when it was shown, for as long as the connection lasts', () => {
    const html = privacyHtml();
    const page = text(html);
    expect(page).toContain(
      'True today Nothing is shared until you choose, person by person and account by account, and hidden accounts are never shared. Beyond accounts, you can choose to share your net worth, as an amount, and your spending by category, your holdings, your budgets or goals you pick, each as percentages or amounts, never the transactions behind them; a net worth lists no account whose balance you don’t share. Once you choose a home currency, what you share is shown in it, converted at the European Central Bank’s daily rates alone, never at your own rates, and they see that it is converted at those rates, never a rate itself; what only a rate of your own would convert is left out of what is converted, and named by its currency. If the European Central Bank doesn’t publish your home currency, what you share isn’t converted at all. Before you save, Sharing says what Nya knows they could work out from it all together (what your other accounts add up to beside your net worth, your income from your net worth and spending, what goes into a goal each month, and amounts from percentages beside an amount of the same money), and that this isn’t every way. For each person, Sharing shows a preview of exactly what they see of yours, and a record of each time it was shown to them. They see that same record, and you see theirs of each time what they share was shown to you; both records are in both of your downloads. A share can end on a date you set, which they see too. Remove or Block ends everything shared both ways at once and deletes both records, as does either of you deleting your account.'
    );
    // Built now, so no longer listed as to come, and nothing new promised in its place.
    const card = html.slice(html.indexOf('You decide what anyone else sees'), html.indexOf('You can see who can read what'));
    expect(card.match(/<dt>/g)).toHaveLength(1);
    expect(page).not.toContain('A preview of exactly what they see, shares that end on a date you set');
    expect(page).not.toMatch(/net worth or your spending|More kinds of share/);
    // Never that someone didn't look: only what was shown, and counted.
    expect(page).not.toMatch(/when they look|when you look|hasn’t looked/);
    expect(page).toContain(SHOWINGS);
  });

  test('names the processors, and the kinds not used yet', () => {
    const page = privacy();
    for (const name of ['Vercel', 'Upstash', 'Plaid', 'Clerk']) expect(page).toContain(name);
    expect(page).toContain('the values that hold money encrypted, and the details listed on the Security page in plain text');
    expect(page).toContain('your name and picture if you sign in with Google or another account');
    expect(page).toContain('Cloudflare (Turnstile)');
    expect(page).toContain('no billing provider');
    expect(page).toContain('no email provider');
  });

  // Decision 6: the ECB on the public pages (for the owner's sign-off).
  test('says where the exchange rates come from, that the ECB is sent nothing about you, and how long a home currency is kept', () => {
    const page = privacy();
    expect(page).toContain('the European Central Bank’s euro reference rates, which Nya’s server downloads once a day, the same for everyone. The ECB is sent nothing about you');
    expect(page).toContain('Your home currency and your own exchange rates Until you change them, or delete your account. Encrypted, and in your download.');
    expect(page).toContain('Nothing converted is kept by Nya’s server');
    expect(page).toContain('left out of Nya’s nightly backups');
    expect(page).not.toMatch(/never in a backup/);
    const sec = security();
    expect(sec).toContain('The database also keeps the European Central Bank’s exchange rates in plain text: public, the same for everyone, kept once for every account, and left out of Nya’s nightly backups.');
    expect(sec).toContain('Your home currency and your own exchange rates are encrypted.');
  });

  test('states the other retention figures the code uses', () => {
    const page = privacy();
    expect(page).toContain(`Invite links ${INVITE_HOURS} hours, or until used.`);
    expect(page).toContain(`used for ${SHORT_TTL_SECONDS / 60} minutes, or up to ${WEBHOOK_TTL_SECONDS / 3600} hours`);
    expect(page).toContain(`Sessions with the shared password ${DAYS} days`);
    expect(page).toContain(`counted by IP address ${LOGIN_WINDOW_MINUTES} minutes.`);
    expect(page).toContain('What your device keeps Your accounts, their balances and your net-worth history, as the app last showed them');
  });

  test('says what outlives a deletion or a disconnection', () => {
    const page = privacy();
    expect(page).toContain(`apart from invite links you made that nobody used (your sign-in id and the name you gave), which expire within ${INVITE_HOURS} hours`);
    expect(page).toContain(`Invite links you made that nobody has used hold your sign-in id and the name you gave, and expire on their own within ${INVITE_HOURS} hours.`);
    expect(page).toContain('for each one you recategorized, its date, amount and bank description are kept, encrypted');
    // Records of when what others share was shown to you go with your account, on their side too.
    expect(page).not.toContain('keep their own record');
    expect(page).not.toContain('doesn’t name you');
    expect(page).toContain('Plaid keeps what it collected under its own policy');
    expect(privacyHtml()).toContain(`href="${PLAID_PORTAL}"`);
  });
});

describe('getting to them', () => {
  test('each page links to the other, and back into the app', () => {
    for (const html of [securityHtml(), privacyHtml()]) {
      expect(html).toContain('href="/security"');
      expect(html).toContain('href="/privacy"');
      expect(html).toContain('href="/"');
    }
    expect(securityHtml()).toMatch(/href="\/security" aria-current="page"/);
    expect(privacyHtml()).toMatch(/href="\/privacy" aria-current="page"/);
  });

  test('the links and the coverage statement shown on the sign-in pages and beside Connect an account', () => {
    const links = renderToStaticMarkup(<TrustLinks />);
    expect(links).toContain('href="/security"');
    expect(links).toContain('href="/privacy"');
    expect(links).not.toContain('aria-current');
    expect(text(renderToStaticMarkup(<CoverageNote />))).toContain(
      'Bank connections through Plaid work for US institutions only. Your own SimpleFIN account, or another service that speaks its protocol (such as Redbark, in Australia and New Zealand), or, where this copy of Nya offers it, your own Lunch Flow account may reach others. Anything else can be tracked as a manual account, with a balance you enter in its own currency.'
    );
  });

  test('which matches what the link-token routes ask Plaid for', () => {
    for (const route of ['create-link-token', 'create-update-link-token']) {
      expect(source(`app/api/${route}/route.ts`)).toContain('country_codes: [CountryCode.Us]');
    }
  });

  // Read from the source: rendering these needs Clerk and the router, which
  // other test files mock process-wide in their own ways.
  test('the login and sign-in pages show both, and every place to connect an account the coverage statement', () => {
    for (const page of ['app/login/page.tsx', 'app/sign-in/[[...sign-in]]/page.tsx']) {
      expect(source(page)).toContain('<CoverageNote />');
      expect(source(page)).toContain('<TrustLinks />');
    }
    // Both ways to connect (components/ConnectButtons.tsx), on the empty
    // state and on the Accounts tab, with the statement right after them.
    const dashboard = source('components/Dashboard.tsx');
    const entries = dashboard.split('<ConnectButtons ').slice(1);
    expect(entries.length).toBe(2);
    for (const after of entries) expect(after.slice(0, 200)).toMatch(/^[^>]*\/>\s*<CoverageNote \/>/);
    expect(dashboard).not.toContain("'Connect an account'");
    expect(dashboard).toContain('<TrustLinks />');
  });
});

describe('email, on both pages, as this copy is set up (#51)', () => {
  test('with mail off: no email provider is named, and the pages say so', () => {
    mailIs(false);
    const priv = privacy();
    expect(priv).toContain('and no email provider, since this copy of Nya sends no email of its own.');
    expect(priv).not.toContain('Resend');
    expect(priv).not.toContain('Emails Nya sent you');
    expect(security()).not.toContain('Resend');
  });

  test('with mail on: Resend is named, with what it sees, and never an amount', () => {
    mailIs(true);
    const priv = privacy();
    expect(priv).toContain('Resend Sends the emails about your bank connections: one when a connection needs you, another only if what it needs from you changes, and one reminder a week later.');
    expect(priv).toContain('Never a balance, an amount or an account number');
    expect(priv).toContain('Not used yet: no billing provider, since Nya charges nothing yet.');
    expect(priv).not.toContain('no email provider');
    expect(priv).toContain('Emails Nya sent you In your inbox, and with the email service under its own policy.');
    const sec = security();
    expect(sec).toContain('Resend, the email service Your email address and the emails Nya sends you about your bank connections');
    expect(sec).toContain('Never a balance, an amount or an account number');
  });

  // The weekly summary (lib/weekly-summary/): what the email service sees of
  // it, named for the owner to sign off on, how long its setting and its
  // links last, and the section on its link, only where this copy sends email.
  test('says what the weekly summary carries, how long its links work, and never an amount', () => {
    mailIs(true);
    const priv = privacy();
    // Everything it tells the email service, and exactly what it counts
    // instead of naming (lib/weekly-summary/compose.ts NAMES).
    expect(priv).toContain(
      'The weekly summary tells it whether you spent more or less than in a usual week; the names of your budgets and categories that are over or close to their limit, and of your goals that are behind their target date or have reached their target; the bills and planned expenses due in the next seven days, by name, with their days and whether one is late; the banks that need you and what they need, and those whose transactions aren’t all in, with the day each last came in; the months that may be missing transactions, and why; how many of the week’s transactions from SimpleFIN or Lunch Flow have no category; and the currencies of transactions it didn’t count.'
    );
    expect(priv).toContain(
      'Never a balance, an amount or an account number: a name of yours with a digit, a currency or percent sign, a number or a currency written as an English word (such as fifty, thousand or dollars), a number written as a Spanish, Portuguese, French, Italian or German word (such as diez mil or zehntausend; not their words for one, nor due, once, sept, seize, elf or null, which are English words too), or a letter outside the Latin alphabet in it is counted instead of named, as is one that looks like a link or an address (with ://, www., an @, or a word, a dot and two or more letters, as in example.com), and so is a bank’s name, as Plaid, SimpleFIN or Lunch Flow gives it, with a digit or a currency or percent sign.'
    );
    expect(priv).not.toContain('a name with a number in it is left out');
    expect(priv).toContain(
      `The weekly summary Whether it is on, its day and your time zone: until you change them, or delete your account. Encrypted, and in your download. Beside them, encrypted too and kept until you delete your account, but not in your download: the key its links to turn it off are signed with, made anew each time you turn it on; the last week a summary went for, and one that got no answer from the email service; and which of your goals, by their ids, it last said had reached their target. Each link works for ${LINK_DAYS} days.`
    );
    expect(priv).toContain('Weekly summaries you asked for now, and uses of a link to turn one off Counted for a day, and for an hour.');
    // "a day" and "an hour" are the counters' windows (lib/weekly-summary/store.ts).
    expect(SENDS_NOW_WINDOW_SECONDS).toBe(24 * 60 * 60);
    expect(UNSUBSCRIBE_WINDOW_SECONDS).toBe(60 * 60);
    const sec = security();
    expect(sec).toContain('If you turn it on, Nya emails you once a week what changed and what needs your attention. It never includes a balance, an amount, a percentage or an account number.');
    expect(sec).toContain(
      'A name of yours with a digit, a currency or percent sign, a number or a currency written as an English word (such as fifty, thousand or dollars), a number written as a Spanish, Portuguese, French, Italian or German word (such as diez mil or zehntausend; not their words for one, nor due, once, sept, seize, elf or null, which are English words too), or a letter outside the Latin alphabet in it is counted instead of named, as is one that looks like a link or an address (with ://, www., an @, or a word, a dot and two or more letters, as in example.com); a bank’s name, which comes from Plaid, SimpleFIN or Lunch Flow, only when it has a digit or a currency or percent sign.'
    );
    expect(sec).toContain(
      'Before it goes, the whole email is checked again, and it isn’t sent if, outside its links, its own wording, the banks’ names and the currency codes it names, it holds a number other than one of its days or counts, a currency or percent sign, a number or a currency written as a word, or a letter outside the Latin alphabet.'
    );
    expect(sec).toContain(`Each one has a link that turns it off without signing in. It works for ${LINK_DAYS} days, can do nothing but turn off that summary`);
    mailIs(false);
    expect(security()).not.toContain('The weekly summary');
    expect(privacy()).not.toContain('The weekly summary tells it');
  });

  test('half a setting is no setting: the pages follow lib/mail.ts', () => {
    mailIs(false);
    process.env.RESEND_API_KEY = 're_placeholder';
    expect(privacy()).toContain('no email provider');
  });

  // Review nit: mail set up with nobody to write to sends nothing, so names
  // nothing (lib/notice-recipients.ts sendsEmail).
  test('with mail set up but nobody it may write to, no email provider is named either', () => {
    mailIs(true);
    delete process.env.NOTIFY_EMAIL;
    expect(privacy()).toContain('and no email provider, since this copy of Nya sends no email of its own.');
    expect(privacy()).not.toContain('Resend');
    expect(security()).not.toContain('Resend');
    // With Clerk, each account's own verified address is written to.
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_x';
    process.env.CLERK_SECRET_KEY = 'sk_test_x';
    expect(privacy()).toContain('Resend Sends the emails about your bank connections');
    expect(security()).toContain('Resend, the email service');
  });

  test('the record of how each connection is doing is in the retention table, and among what is encrypted', () => {
    expect(privacy()).toContain('How each bank connection is doing When it last answered, Plaid’s warnings that it is going to end');
    expect(privacy()).toContain('until the connection is removed.');
    expect(privacy()).toContain('Encrypted, and in your download.');
    expect(security()).toContain('how each bank connection is doing');
  });
});

describe('API tokens, on both pages', () => {
  test('the security page: who can read what through one, how it is kept and checked, and what ends it', () => {
    const page = security();
    expect(page).toContain('Programs you give an API token to What the read-only API and the MCP server serve (the Developers page lists it)');
    expect(page).toContain('until you revoke the token. Never your sign-in or your bank logins, and they can never change anything.');
    expect(page).toContain('Nya shows it once and never stores it: it keeps a SHA-256 hash of the token’s secret, inside your own data and encrypted with it');
    expect(page).toContain('A token that doesn’t work gets the same answer whatever the reason (unknown, revoked, a wrong secret, or another person’s data)');
    expect(page).toContain('one whose secret doesn’t match costs the same work whoever’s data it names');
    expect(page).toContain('Only a token whose secret checks out is told more: that its data is being restored, say, and to try again later.');
    expect(page).toContain('Requests with tokens that don’t work are counted by the address they come from');
    expect(page).toContain('Making one needs a fresh sign-in, as downloading your data does.');
    expect(page).toContain(`makes at most ${REQUESTS_PER_MINUTE} requests a minute. It works until you revoke it, even after Sign out everywhere or a change of the shared password`);
    expect(page).toContain('it stops when the account that made it is taken off the list of people allowed in.');
    expect(page).toContain('Deleting your account deletes every token with the rest of your data, and restoring a backup ends every token, since backups leave them out.');
    // Backups: the same kinds of data, but no tokens.
    backupsAre('kept');
    expect(security()).toContain('A backup holds the same kinds of data as the database, apart from API tokens');
    expect(security()).toContain('API tokens are never backed up, so restoring a backup ends every token, and none revoked before it can work again.');
    expect(securityHtml()).toContain('href="/developers"');
  });

  test('the security page lists what of them is plain text: ids that can’t be used, and the counts of requests', () => {
    const page = security();
    expect(page).toContain('of your API tokens (random, and not enough to use one), and of the people you split costs with');
    expect(page).toContain(
      `And for each API token, how many requests it made in the current minute, deleted when the token is revoked, or ${(2 * RATE_WINDOW_SECONDS) / 60} minutes after the last request made with any of your tokens; and for the weekly summary, how many you asked to be sent now, kept for a day, and how many times a link to turn it off was used, kept for an hour.`
    );
    expect(page).toContain(`of a device that sent API tokens, or links to turn off a weekly summary, that didn’t work, for up to ${API_AUTH_WINDOW_SECONDS / 60} minutes;`);
  });

  test('the privacy page: what an assistant connected to the MCP server reads, how long tokens and their counts are kept, and what the download holds of them', () => {
    const page = privacy();
    expect(page).toContain(
      'Nya has no AI features of its own, and sends nothing to an AI provider unless you connect one. If you connect an AI assistant to Nya’s MCP server, with a token you make for it, it can read what that token reads (the Developers page lists it) until you revoke the token, and its provider keeps what it reads under its own terms.'
    );
    expect(page).toContain('A read-only API lets programs you choose read your data whenever you like, with a token you can revoke (see the Developers page');
    // The API exists now: only writing through it is to come.
    expect(page).toContain('Not built yet Writing through the API, and a license that lets anyone run their own copy of Nya.');
    expect(page).not.toContain('A public API');
    expect(page).toContain(
      'API tokens Until you revoke them, or delete your account. Each is kept as its name, the sign-in account that made it (with sign-in accounts), when it was made and last used, and a hash of its secret, all encrypted; the token itself is shown once and never stored. Signing out everywhere, or a change of the shared password, doesn’t end them. They are never in backups, so restoring one ends them all.'
    );
    expect(page).toContain(`Requests with API tokens, or links to turn off a weekly summary, that didn’t work, counted by IP address ${API_AUTH_WINDOW_SECONDS / 60} minutes.`);
    expect(page).toContain(
      `Requests counted for each API token Its count for the current ${RATE_WINDOW_SECONDS}-second window, deleted when the token is revoked, or ${(2 * RATE_WINDOW_SECONDS) / 60} minutes after the last request made with any of your tokens.`
    );
    expect(page).toContain('your API tokens themselves (each one’s name and dates are in)');
    expect(privacyHtml()).toContain('href="/developers"');
  });
});

// Writing through a token (API_WRITES_ENABLED, lib/api-writes-enabled.ts):
// the pages describe it only while this copy lets tokens write, and read
// exactly as before while it doesn't.
describe('writing through a token, on both pages, only while this copy lets tokens write', () => {
  const mailOn = () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.MAIL_FROM = 'Nya <nya@example.com>';
    process.env.NOTIFY_EMAIL = 'me@example.com';
    process.env.RESTORE_ENABLED = '1';
  };

  test('off: nothing of writing on either page', () => {
    delete process.env.API_WRITES_ENABLED;
    mailOn();
    for (const [name, page] of [['security', security()], ['privacy', privacy()]] as const) expect([name, writingIn(page)]).toEqual([name, []]);
    expect(security()).toContain('A token can read but never change anything');
    expect(security()).toContain('the read-only API, the MCP server and what you share answer nothing from it.');
    expect(privacy()).toContain('Not built yet Writing through the API');
  });

  test('on, the security page: what each kind of token reaches, its limits, versions and the record, and what a restore holds back', () => {
    process.env.API_WRITES_ENABLED = '1';
    mailOn();
    const page = security();
    expect(page).toContain('Programs you give an API token to What the API and the MCP server serve (the Developers page lists it)');
    expect(page).toContain(
      'A token made to read changes nothing; one made to update balances sees only your accounts and their balances and changes only a manual account’s balance; one made to make changes can add, change and delete the transactions entered on your manual accounts, add and change your manual accounts, categories and tags, and undo its own changes (an undo deletes what the change made, and an account it made goes with its transactions and its past balances), but never delete any other account, category or tag, and never change a bank’s transaction itself (though moving or renaming a category changes how every transaction in it is filed and counted).'
    );
    expect(page).not.toContain('and they can never change anything.');
    expect(page).toContain('lets a program read your data, and, if you choose when you make it, change some of it, through Nya’s API and its MCP server');
    expect(page).toContain('That choice is kept with it and can never be widened, and a token never gains kinds of changes added to Nya after it was made.');
    expect(page).toContain('one that can update balances or make changes at most 30 writes a minute and 500 changes a day, with 2,000 changes a day for all your tokens.');
    expect(page).toContain('Every change to something that already exists, but a balance, names the version it was made from');
    expect(page).toContain('Every change is recorded for 30 days under API tokens, with what it changed, where most can be undone or forgotten.');
    expect(page).toContain('the record of changes made with API tokens, and the short-lived copies');
    expect(page).toContain('for the record of changes made with API tokens: the day each change was made and which token made it (what it changed is encrypted).');
    expect(page).toContain('for a token that can update balances or make changes, its writes in the current minute and its changes in the current 24 hours, all your tokens’ changes in the current 24 hours, and the manual accounts whose balance a token set in the current 24 hours, by their ids');
    expect(page).toContain('or an API token is made (saying what it can do)');
    expect(page).toContain('the API and the MCP server answer nothing from it and change nothing in it');
    // The words the off page is held to not saying are said here.
    expect(writingIn(page).length).toBeGreaterThan(3);
    expect(page).not.toMatch(/[\u2013\u2014]/);
  });

  test('on, the privacy page: the AI caveat, leaving, the record’s row, and the counts', () => {
    process.env.API_WRITES_ENABLED = '1';
    mailOn();
    const page = privacy();
    expect(page).toContain('With a token you make to make changes, it can also add, change and delete the transactions entered on your manual accounts, and add and change your manual accounts, categories and tags; it can be tricked into a change by something it reads');
    expect(page).toContain('An API lets programs you choose, each with a token you can revoke, read your data whenever you like and, with a token made for it, add, change and delete the transactions entered on your manual accounts, and add and change your manual accounts');
    expect(page).toContain('Not built yet Writing your bank’s transactions through the API');
    expect(page).toContain('Changes made with API tokens 30 days, or until you delete your account: each change a token made');
    // A forgotten change keeps its line: Forget removes what it changed.
    expect(page).toContain('Forgetting a change under API tokens removes what it changed, before and after, at once (and what its undo kept); its line, saying when, which token, what kind of change and the id of what it changed, stays for the 30 days.');
    expect(page).toContain('whether a token set each manual account’s balance in the current 24 hours');
    expect(page).toContain('A token that can make changes can read its own; tokens that only read can’t. In your download and in backups; never brought back with a download.');
    expect(page).toContain('For a token that can update balances or make changes, also its writes in the current minute and its changes in the current 24 hours');
    expect(page).toContain('Each is kept as its name, what it can do, the sign-in account that made it');
    expect(writingIn(page).length).toBeGreaterThan(3);
    expect(page).toContain('or an API token is made (saying what it can do)');
    expect(page).not.toMatch(/[\u2013\u2014]/);
  });
});

// A data key per account (docs/operations.md, "Per-container data keys"). The
// pages read no stored data, so they say it conditionally, and never claim a
// key of its own for an account made before it, until it is moved.
describe('a data key per account, on both pages', () => {
  const OWN =
    'Each account made on this version of Nya normally has a data key of its own from the start, and an account made before it (or one made while a key couldn’t be) has one once whoever runs this copy has moved it; until then, its data is under a key shared by everyone on this copy.';
  const DESTROYED =
    'Deleting an account destroys its own key, so nothing encrypted under it can be decrypted from any copy Nya keeps, normally within minutes of the deletion and at the latest after the next nightly backup that succeeds. The encrypted copies stay in backups, unreadable, until they are deleted, and the plain text in them stays readable until then. Copies under a shared key stay readable with it until they are deleted.';

  test('with a master key and backups: what deleting the key does, when, and what it doesn’t reach', () => {
    process.env.MASTER_KEY = MASTER;
    backupsAre('kept');
    for (const page of [security(), privacy()]) {
      expect(page).toContain(OWN);
      expect(page).toContain(DESTROYED);
    }
    const sec = security();
    expect(sec).toContain('A backup of the keys that whoever runs this copy of Nya downloaded by hand, for as long as they keep it.');
    expect(sec).toContain('A backup taken while an older version of Nya ran, which holds every key.');
    expect(sec).toContain('A record that the account existed: its random id and the day its key was destroyed, kept for good, so that a restored backup never brings the account back.');
    expect(sec).toContain('in a file of their own kept beside it, the data keys in their locked form');
    expect(sec).toContain('the last 7 nights’ are kept, each checked before an older one is deleted');
    // Never more than is so: a key can be born late, and one gone from the database without a deletion is let go in time.
    expect(sec).toContain('Each account made on this version of Nya normally has a data key of its own from the start');
    expect(sec).toContain('A key leaves them when the account it belongs to is deleted, or, for one that has gone from the database without that, once no backup still kept can need it.');
    expect(sec).toContain('A value under one account’s key can’t be read as another’s, even copied into its place; values still under a shared key can, until they are moved.');
    const priv = privacy();
    expect(priv).toContain('A record that a deleted account existed Its random id and the day its key was destroyed: kept for good');
    expect(priv).toContain('What deleting your key doesn’t reach: a backup of the keys that whoever runs this copy of Nya downloaded by hand');
    expect(priv).toContain('Not built yet Encrypting the details stored as plain text');
  });

  test('without a master key there is no key per account to speak of, and the pages say nothing of one', () => {
    delete process.env.MASTER_KEY;
    backupsAre('kept');
    for (const page of [security(), privacy()]) {
      expect(page).not.toContain('a data key of its own');
      expect(page).not.toContain('its key was destroyed');
    }
    expect(privacy()).toContain('A data key per account, which makes your copies in backups unreadable once your account is deleted, needs a master key, which this copy of Nya doesn’t have set.');
    expect(privacy()).toContain('Not built yet Encrypting the details stored as plain text');
  });

  test('without backups, the key goes with the rest of the data, and nothing is said of backups of it', () => {
    process.env.MASTER_KEY = MASTER;
    backupsAre('none');
    expect(security()).toContain(`${OWN} Deleting an account destroys its own key with the rest of its data.`);
    expect(security()).not.toContain('A backup of the keys');
  });

  test('the database host’s own backups, by DATABASE_BACKUP_DAYS', () => {
    process.env.MASTER_KEY = MASTER;
    backupsAre('kept');
    process.env.DATABASE_BACKUP_DAYS = '3';
    expect(security()).toContain('The database host’s own backups, which hold the whole database, keys included, for 3 days.');
    expect(privacy()).toContain('Its own backups of the database keep a copy for 3 days. Its own internal copies follow its own policy.');
    process.env.DATABASE_BACKUP_DAYS = 'three';
    expect(security()).toContain('how long couldn’t be worked out on this copy of Nya');
    expect(privacy()).toContain('which couldn’t be worked out on this copy of Nya');
    delete process.env.DATABASE_BACKUP_DAYS;
    expect(security()).not.toContain('database host');
    expect(privacy()).toContain('Its own internal copies follow its own policy.');
  });
});

// Receipts and documents (#47): said wherever a file store and a master key
// let this copy keep them (files may be there even where adding is off),
// and said to be off where they can't be kept.
describe('receipts and documents', () => {
  const on = (quota: string | null) => {
    process.env.MASTER_KEY = MASTER;
    backupsAre('kept');
    if (quota) process.env.ATTACHMENTS_QUOTA_MB = quota;
    else delete process.env.ATTACHMENTS_QUOTA_MB;
  };
  const PRIVATE =
    'A receipt can show what you bought, at a pharmacy say, so Nya treats what you attach as more private than the transaction it is on: it is never shared, even where the transaction is, never sent to a program with an API token, never in an email, and never kept on your device by Nya. You can delete one at any time: once it is gone from the file store (at once, or by a later nightly run if the store can’t be reached), no backup can bring it back. This copy of Nya keeps one copy of each file, so download them to keep your own.';
  const ENCRYPTED =
    'Receipts and documents you attach to transactions are encrypted on Nya’s server before they are stored, each with a key of its own, and kept in a private Vercel Blob store. The store never holds those keys: each is kept only in the database and its backups, locked with your account’s own data key. So the file store, or a copy of it, holds nothing readable on its own.';

  test('kept here: the commitment, how they are encrypted, who reads them, the download and the deletion', () => {
    on('1024');
    const priv = privacy();
    const sec = security();
    expect(priv).toContain(`Receipts and documents are never shared. True today ${PRIVATE}`);
    expect(priv).not.toContain('Adding new receipts and documents is off');
    expect(priv).toContain('Stores the receipts and documents you attach, encrypted; each file’s key is locked in the database, apart from the files.');
    expect(priv).toContain('Receipts and documents you attach Until you delete them, or delete your account.');
    expect(priv).toContain('Your receipts and documents come as a download of their own: in Settings, Your data and privacy, Receipts and documents, as ZIP files of about 50 MB each');
    expect(priv).toContain('Your receipts and documents are deleted from the file store (part of them by a later nightly run if the store can’t be reached), and the key that would open them is destroyed.');
    // Reading receipts is still to come.
    expect(priv).toContain('Planned Reading receipts: off unless you turn it on, and only for the receipt you choose.');
    expect(sec).toContain(ENCRYPTED);
    expect(sec).toContain('Whoever runs this copy of Nya can read them, as they can read the rest of your data.');
    expect(sec).toContain('for receipts and documents: a random id for each, and which of your transactions have one, by their ids; in the file store, each encrypted file’s size and when it was uploaded.');
    expect(sec).toContain('It also stores your receipts and documents, encrypted; each file’s key is locked in the database, apart from the files.');
    expect(sec.match(/Never your receipts or documents\./g)).toHaveLength(3);
    expect(sec).toContain('Your receipts and documents are deleted from the file store, part of them by a later nightly run if the store can’t be reached, and the key that would open any copy left of them is destroyed with your account’s key.');
    expect(sec).toContain('Receipts and documents download the same way, as ZIP files of about 50 MB each');
  });

  test('kept, with adding off (no quota set): what is there is still described, and adding is said to be off', () => {
    on(null);
    expect(privacy()).toContain(`${PRIVATE} Not turned on here Adding new receipts and documents is off on this copy of Nya; any already attached stay as described.`);
    expect(privacy()).toContain('Adding new ones is off on this copy of Nya.');
    expect(security()).toContain(`${ENCRYPTED}`);
    expect(security()).toContain('as they can read the rest of your data. Adding new ones is off on this copy of Nya.');
  });

  test('not kept here (no file store, or no master key): built, and off', () => {
    for (const setup of [() => backupsAre('none'), () => (backupsAre('kept'), delete process.env.MASTER_KEY)]) {
      process.env = { ...saved };
      process.env.MASTER_KEY = MASTER;
      process.env.ATTACHMENTS_QUOTA_MB = '1024';
      setup();
      const priv = privacy();
      expect(priv).toContain(
        'Receipts and documents are never shared. True today This copy of Nya keeps no receipts or documents: nothing can be attached to a transaction here. Not turned on here Attaching receipts and documents to transactions: built, and off on this copy of Nya until whoever runs it turns it on.'
      );
      expect(priv).toContain('Receipts and documents you attach None: nothing can be attached to a transaction on this copy of Nya.');
      expect(priv).not.toContain('Stores the receipts and documents you attach');
      expect(priv).not.toContain('Your receipts and documents come as a download of their own');
      const sec = security();
      expect(sec).not.toContain('Receipts and documents you attach to transactions are encrypted');
      expect(sec).not.toContain('Never your receipts or documents.');
    }
  });
});
