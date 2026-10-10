import { describe, expect, test, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import SecurityPage from '@/app/security/page';
import PrivacyPage from '@/app/privacy/page';
import { CoverageNote, TrustLinks } from '@/components/TrustLinks';
import nextConfig from '@/next.config.js';
import { backupRetention, keepDays, MIN_KEPT } from '@/lib/backup';
import { backupDaysAtMost, buildDeletionReceipt, PLAID_PORTAL, type DeletionCounts } from '@/lib/deletion-receipt';
import { SESSION_MAX_AGE_SECONDS } from '@/lib/auth';
import { SHORT_TTL_SECONDS, WEBHOOK_TTL_SECONDS } from '@/lib/cache';
import { LOGIN_MAX_FAILURES, LOGIN_WINDOW_SECONDS } from '@/lib/rate-limit';
import { DEMO_WINDOW_SECONDS } from '@/lib/demo';
import { DOWNLOADS_PER_WINDOW } from '@/lib/download-limit';
import { ACCESS_LOG_DAYS } from '@/lib/share-rules';
import { RATE_WINDOW_SECONDS, REQUESTS_PER_MINUTE, API_AUTH_WINDOW_SECONDS } from '@/lib/api-limits';

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
  ];

  test('the guard catches the phrasings it is there for', () => {
    for (const claim of [
      'Everything financial is encrypted with AES-256-GCM.',
      'Everything is encrypted.',
      'All your data is encrypted at rest.',
      'Holds your data encrypted.',
      'Encrypted like everything else.',
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

  test('names everyone who can read anything, and what', () => {
    const page = security();
    for (const who of ['The operator', 'Upstash', 'Vercel', 'Plaid', 'Clerk', 'People you share with', 'Your device']) {
      expect(page).toContain(who);
    }
    expect(page).toContain(`last ${SHARED_TXN_DAYS} days of transactions, until the end date you set, if you set one.`);
    expect(page).toContain('your name and picture if you sign in with Google or another account');
    expect(page).toContain('Cloudflare (Turnstile), which sees your IP address and browser');
    // The device keeps more than balances (components/Dashboard.tsx saves the whole snapshot).
    expect(page).toContain('Your accounts, their balances and your net-worth history, as the app last showed them');
  });

  test('sharing: what is encrypted, what is plain text, and who reads the records of when it was shown', () => {
    const page = security();
    expect(page).toContain('manual accounts, how each bank connection is doing, the records of when shared accounts were shown, and the short-lived copies');
    expect(page).toContain(
      'which accounts each of you shares at which level and until when, and for each connection a random id, which its records of when shared accounts were shown are kept under, and when those records began (what they record is encrypted), never the balances or transactions themselves.'
    );
    expect(page).toContain('until the end date you set, if you set one. And your record of each time it was shown to them, the same one you see. They can never change anything.');
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

  test('says where bank connections work, and that manual accounts are in US dollars', () => {
    const page = security();
    expect(page).toContain('work for US institutions only');
    expect(page).toContain('you enter the balance in US dollars');
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

  test('makes the seven commitments, each with what is true today and, where some of it is to come, what is not', () => {
    const html = privacyHtml();
    const promises = [
      'We never sell or share your financial data.',
      'You can download everything stored about you, in open formats, whenever you like.',
      'You can delete everything, and it reaches backups and connected services.',
      'You decide what anyone else sees, and you can see what they see about you.',
      'You can see who can read what, including us.',
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
      `True today Download my data, under Manage on the Accounts tab, gives you everything stored about you, decrypted: one JSON file, CSV files of your transactions and of your balance history, or a bank account’s or card’s transactions as an OFX file for other money apps. You can protect any of them with a passphrase of your own, which Nya never keeps. If something stored can’t be read, the file names it, apart from a few sharing and bank-account records the app itself passes over. A fresh sign-in comes first, and each account can download ${DOWNLOADS_PER_WINDOW} times an hour.`
    );
    expect(page).toContain('On the Accounts tab, tap Manage, then Download my data at the bottom.');
    expect(page).toContain(`Each account can download ${DOWNLOADS_PER_WINDOW} times an hour.`);
    expect(page).toContain('Unless you protect it with a passphrase, the file itself is not encrypted, so keep it somewhere safe.');
    expect(page).toContain('Nya never keeps the passphrase, so a lost one can’t be recovered.');
    expect(privacyHtml()).toContain('href="/open-download"');
    expect(page).toContain('then gives you a receipt of what was deleted, what expires when, and what stays and why.');
    expect(page).toContain('It ends with a receipt, to copy or save');
    expect(page).not.toContain('Until then there is no way to download');
  });

  // Built now: OFX, the passphrase and the email. Bringing a download into
  // another copy of Nya is still to come, and says so.
  test('lists as not built yet only what isn’t: bringing a download into another copy of Nya', () => {
    const html = privacyHtml();
    const card = text(html.slice(html.indexOf('You can download everything stored about you'), html.indexOf('You can delete everything')));
    expect(card).toContain('Not built yet A way to bring a download into another copy of Nya.');
    expect(card).not.toMatch(/OFX files for other money apps, a passphrase|an email each time a download happens\./);
  });

  test('says a download is emailed only where this copy sends email', () => {
    mailIs(true);
    expect(privacy()).toContain('Each download is emailed to you: when it happened and which format, never what is in it.');
    expect(privacy()).toContain('And one each time your data is downloaded or an API token is made.');
    expect(security()).toContain('Each download is emailed to you, so one you didn’t make shows.');
    expect(security()).toContain('and each time your data is downloaded or an API token is made: which bank needs you and what to do, or when and in which format your data was downloaded, never a balance, an amount or an account number.');
    mailIs(false);
    for (const page of [privacy(), security()]) {
      expect(page).toContain('This copy of Nya sends no email, so a download isn’t emailed to you.');
      expect(page).not.toContain('Each download is emailed to you');
    }
  });

  test('describes sharing as it is: the preview, ends, and both records of when it was shown, for as long as the connection lasts', () => {
    const html = privacyHtml();
    const page = text(html);
    expect(page).toContain(
      'True today Nothing is shared until you choose, person by person and account by account, and hidden accounts are never shared. For each person, Sharing shows a preview of exactly what they see of yours, and a record of each time it was shown to them. They see that same record, and you see theirs of each time what they share was shown to you; both records are in both of your downloads. A share can end on a date you set, which they see too. Remove or Block ends everything shared both ways at once and deletes both records, as does either of you deleting your account.'
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
      'Bank connections work for US institutions only, through Plaid. Anything else can be tracked as a manual account, with a balance you enter in US dollars.'
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
    expect(priv).toContain('never a balance, an amount or an account number');
    expect(priv).toContain('Not used yet: no billing provider, since Nya charges nothing yet.');
    expect(priv).not.toContain('no email provider');
    expect(priv).toContain('Emails Nya sent you In your inbox, and with the email service under its own policy.');
    const sec = security();
    expect(sec).toContain('Resend, the email service Your email address and the emails Nya sends you about your bank connections');
    expect(sec).toContain('never a balance, an amount or an account number');
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
    expect(page).toContain('and of your API tokens (random, and not enough to use one);');
    expect(page).toContain(
      `And for each API token, how many requests it made in the current minute, deleted when the token is revoked, or ${(2 * RATE_WINDOW_SECONDS) / 60} minutes after the last request made with any of your tokens.`
    );
    expect(page).toContain(`of a device that sent API tokens that didn’t work, for up to ${API_AUTH_WINDOW_SECONDS / 60} minutes;`);
  });

  test('the privacy page: what an assistant connected to the MCP server reads, how long tokens and their counts are kept, and what the download holds of them', () => {
    const page = privacy();
    expect(page).toContain(
      'Nya has no AI features of its own, and sends nothing to an AI provider unless you connect one. If you connect an AI assistant to Nya’s MCP server, with a token you make for it, it can read what that token reads (the Developers page lists it) until you revoke the token, and its provider keeps what it reads under its own terms.'
    );
    expect(page).toContain('A read-only API lets programs you choose read your data whenever you like, with a token you can revoke (see the Developers page');
    // The API exists now: only writing through it is to come.
    expect(page).toContain('Not built yet Writing through the API, a way to bring your download into another copy of Nya');
    expect(page).not.toContain('A public API');
    expect(page).toContain(
      'API tokens Until you revoke them, or delete your account. Each is kept as its name, the sign-in account that made it (with sign-in accounts), when it was made and last used, and a hash of its secret, all encrypted; the token itself is shown once and never stored. Signing out everywhere, or a change of the shared password, doesn’t end them. They are never in backups, so restoring one ends them all.'
    );
    expect(page).toContain(`Requests with API tokens that didn’t work, counted by IP address ${API_AUTH_WINDOW_SECONDS / 60} minutes.`);
    expect(page).toContain(
      `Requests counted for each API token Its count for the current ${RATE_WINDOW_SECONDS}-second window, deleted when the token is revoked, or ${(2 * RATE_WINDOW_SECONDS) / 60} minutes after the last request made with any of your tokens.`
    );
    expect(page).toContain('your API tokens themselves (each one’s name and dates are in)');
    expect(privacyHtml()).toContain('href="/developers"');
  });
});
