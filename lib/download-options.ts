// lib/download-options.ts
//
// What a download of my data can be asked for, shared by the card that asks
// (components/DownloadMyData.tsx), the route that checks and answers
// (app/api/my-data) and the email that says a download happened
// (lib/download-notice.ts), so the three never disagree. Pure, safe to import
// from client code.
//
// THE FORMATS. Everything as JSON, the transactions or the balance history as
// CSV (lib/user-export.ts), and one account's transactions as an OFX
// statement (lib/ofx-export.ts). Any of them can be protected with a
// passphrase (lib/protected-download.ts).
//
// OFX IS FOR BANK ACCOUNTS AND CARDS. The OFX version money apps read (1.0.2)
// has a statement for a bank account and one for a credit card, and those are
// what a depository and a credit account become. A loan has no statement in
// that version, and an investment account's lists holdings, trades and the
// securities they are in, which a balance and a list of transactions can't
// stand in for. So neither is offered as OFX, rather than passed off as a
// bank account: their history is in the JSON download.

export const DOWNLOAD_FORMATS = ['json', 'transactions-csv', 'balances-csv', 'ofx'] as const;
export type DownloadFormat = (typeof DOWNLOAD_FORMATS)[number];

export function isDownloadFormat(v: unknown): v is DownloadFormat {
  return typeof v === 'string' && (DOWNLOAD_FORMATS as readonly string[]).includes(v);
}

/** Each format as the card names it. */
export const FORMAT_LABELS: Record<DownloadFormat, string> = {
  json: 'Everything (JSON)',
  'transactions-csv': 'Transactions (CSV)',
  'balances-csv': 'Balance history (CSV)',
  ofx: 'Bank or card statement (OFX)',
};

// ---- A passphrase ----

/** The shortest passphrase taken, in characters. */
export const PASSPHRASE_MIN = 12;
/** The longest, as for a password (lib/fresh-sign-in.ts PASSWORD_MAX). */
export const PASSPHRASE_MAX = 1024;

/** A passphrase's length as a person counts it: characters, not the UTF-16
 *  units JavaScript counts (an emoji is one). */
export const passphraseLength = (p: string) => Array.from(p).length;

/** Why a passphrase can't be used, in words for the person, or null. Never
 *  says what it was. */
export function passphraseProblem(p: unknown): string | null {
  if (typeof p !== 'string') return 'passphrase must be text.';
  if (p.length > PASSPHRASE_MAX * 2 || passphraseLength(p) > PASSPHRASE_MAX) return `A passphrase can be at most ${PASSPHRASE_MAX} characters.`;
  if (p.trim() === '' || passphraseLength(p) < PASSPHRASE_MIN) return `Use a passphrase of at least ${PASSPHRASE_MIN} characters.`;
  return null;
}

// ---- One account's OFX statement ----

/** The two statements OFX 1.0.2 has for an account like this. */
export type OfxKind = 'bank' | 'creditcard';

/** The statement an account's type makes, or null when it has none (see the
 *  header). */
export function ofxKindOf(type: string | null | undefined): OfxKind | null {
  if (type === 'depository') return 'bank';
  if (type === 'credit') return 'creditcard';
  return null;
}

/** Why an account isn't offered as OFX, in words for the person, or null
 *  when it is. */
export function ofxRefusal(type: string | null | undefined): string | null {
  if (ofxKindOf(type)) return null;
  if (type === 'loan') {
    return 'A loan has no statement in the version of OFX money apps read, so it isn’t offered as one. Its balance history is in the JSON download.';
  }
  if (type === 'investment') {
    return 'An investment account’s OFX statement lists holdings, trades and securities, which Nya doesn’t write, so it isn’t offered as one. Its investment transactions and balance history are in the JSON download.';
  }
  return 'Only a bank account or a card has an OFX statement, so this account isn’t offered as one. Its history is in the JSON download.';
}

/** An account id as the route takes one: what the seam takes as an id. */
export const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** The words of a name, for a file name: lower case, letters and digits,
 *  accents dropped, joined by hyphens. */
function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** An OFX statement's file name: the account, as the app names it, and the
 *  day. */
export function ofxFilename(account: { institution_name?: string | null; name?: string | null; mask?: string | null }, day: string): string {
  const words = slug([account.institution_name, account.name, account.mask].filter(Boolean).join(' ')).slice(0, 60).replace(/-+$/, '');
  return `nya-${words || 'account'}-${day}.ofx`;
}

/** Where a protected download is opened in the browser (app/open-download). */
export const OPEN_DOWNLOAD_PATH = '/open-download';
